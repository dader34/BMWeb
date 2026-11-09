#!/usr/bin/env node
// Identify on the transmission page of the Flashing/Tuning app
// (app/renderer/screens/flashing/tcu.js): the part with no car in it.
//
// WHAT THIS PROVES
//   1. Identify asks as a GS20 and nothing else. It used to walk BMW's five
//      E46 automatic SGBDs and take the first whose IDENT came back OKAY; the
//      others answer the same telegram, so one unanswered first question put
//      a GS20 down as gs8600 -- a different .prg on every identify.
//   2. An unanswered IDENT is asked again, on a fresh session, up to
//      FB_TCU_IDENT_TRIES times -- and still only as a GS20.
//   3. A transmission that never answers as a GS20 is reported so; no other
//      SGBD is tried even when one would answer, and what an earlier
//      identify found is left as it was.
//
// Run: node tools/verify/test_tcu_identify.js
const assert = require('assert');
const path = require('path');

const logged = [];
const messages = [];
const dropped = [];
let ecuBox = '';
let status = '';
global.fbState = { module: 'tcu', running: false, tcu: null };
global.fbLog = (s) => logged.push(s);
global.fbSetStatus = (s) => {
  status = s;
};
global.fbSetEcuBox = (s) => {
  ecuBox = s;
};
global.fbMessage = async (text, title) => messages.push([title, text]);
global.fbDescribeError = (e) => (e && e.message) || String(e);
global.flashLog = { note: (s) => logged.push(s), isActive: false };
global.webDropSession = (sgbd) => dropped.push(sgbd);
global.gs20ProbeReadPatch = async () => 'no patched read'; // a stock program

// the car: what each SGBD's jobs answer, call by call
const calls = [];
let answer = () => ({ sets: [{ JOB_STATUS: 'ERROR_ECU_NO_RESPONSE' }] });
global.webRunJob = async (sgbd, job, arg) => {
  calls.push([sgbd, job, arg]);
  return answer(sgbd, job, calls.filter((c) => c[1] === job).length);
};
const okIdent = {
  sets: [
    {
      JOB_STATUS: 'OKAY',
      ID_BMW_NR: '7552700',
      ID_SW_NR: '0x1234',
      ID_HW_NR: '21',
    },
  ],
};
const okAif = {
  sets: [{ JOB_STATUS: 'OKAY', AIF_FG_NR: 'NJ87379', AIF_DATUM: '01.01.2004' }],
};

const T = require(
  path.join(__dirname, '../../app/renderer/screens/flashing/tcu.js')
);

let passed = 0;
const ok = (m) => {
  passed++;
  console.log(`  ok    ${m}`);
};
const fresh = () => {
  global.fbState.tcu = T.fbTcuFreshState();
  calls.length = 0;
  logged.length = 0;
  messages.length = 0;
  dropped.length = 0;
  ecuBox = '';
  status = '';
};
const sgbds = () => [...new Set(calls.map((c) => c[0]))];
const idents = () => calls.filter((c) => c[1] === 'IDENT');

(async () => {
  assert.strictEqual(T.FB_TCU_SGBD, 'gs20');
  assert(
    T.FB_TCU_VARIANTS.length > 1,
    'the faults page keeps its variant list'
  );

  // ---- 1. answered at once: one IDENT, as a GS20 ---------------------------
  fresh();
  answer = (sgbd, job) => (job === 'IDENT' ? okIdent : okAif);
  await T.fbTcuIdentify();
  assert.deepStrictEqual(sgbds(), ['gs20']);
  assert.strictEqual(idents().length, 1);
  assert.strictEqual(fbState.tcu.sgbd, 'gs20');
  assert.strictEqual(fbState.tcu.identBmw, '7552700');
  assert.strictEqual(fbState.tcu.aif.AIF_FG_NR, 'NJ87379');
  assert.strictEqual(fbState.tcu.hasReadPatch, false);
  assert(/^TCU identified \(gs20\.prg\), stock program/.test(status), status);
  assert(/^TCU {2}21/.test(ecuBox), ecuBox);
  assert.strictEqual(dropped.length, 0);
  assert.strictEqual(messages.length, 0);
  ok(
    'answered at once: one IDENT, as a GS20, then its programming log and the read-patch probe'
  );

  // ---- 2. the first two questions unanswered: asked again, still a GS20 -----
  // every OTHER SGBD would answer OKAY here -- the old walk took gs8600
  fresh();
  answer = (sgbd, job, nth) => {
    if (sgbd !== 'gs20') return okIdent;
    if (job === 'IDENT')
      return nth < 3 ? { sets: [{ JOB_STATUS: '' }] } : okIdent;
    return okAif;
  };
  await T.fbTcuIdentify();
  assert.deepStrictEqual(sgbds(), ['gs20'], 'no other SGBD is asked');
  assert.strictEqual(idents().length, 3);
  assert.deepStrictEqual(
    dropped,
    ['gs20', 'gs20'],
    'a fresh session before each retry'
  );
  assert.strictEqual(fbState.tcu.sgbd, 'gs20');
  assert(logged.some((l) => /try 1 of 3: no answer/.test(l)));
  assert.strictEqual(messages.length, 0);
  ok(
    'two unanswered IDENTs: asked a third time on a fresh session, identified as a GS20, no other SGBD tried'
  );

  // ---- 3. a job that cannot run counts as a miss too ------------------------
  fresh();
  let thrown = 0;
  answer = (sgbd, job) => {
    if (job === 'IDENT' && !thrown++) throw new Error('IFH-0009: no answer');
    return job === 'IDENT' ? okIdent : okAif;
  };
  await T.fbTcuIdentify();
  assert.strictEqual(idents().length, 2);
  assert.strictEqual(fbState.tcu.sgbd, 'gs20');
  ok('an IDENT that throws is asked again');

  // ---- 4. never answers as a GS20: said so, nothing else tried --------------
  fresh();
  fbState.tcu.sgbd = 'gs20'; // what an earlier identify found
  answer = (sgbd) =>
    sgbd === 'gs20'
      ? { sets: [{ JOB_STATUS: 'ERROR_ECU_NO_RESPONSE' }] }
      : okIdent;
  await T.fbTcuIdentify();
  assert.deepStrictEqual(sgbds(), ['gs20']);
  assert.strictEqual(idents().length, T.FB_TCU_IDENT_TRIES);
  assert.strictEqual(
    calls.length,
    T.FB_TCU_IDENT_TRIES,
    'no AIF read, no probe'
  );
  assert.strictEqual(status, 'No response from the TCU');
  assert.strictEqual(messages.length, 1);
  assert(/did not answer as a GS20/.test(messages[0][1]));
  assert(/ERROR_ECU_NO_RESPONSE/.test(messages[0][1]));
  assert.strictEqual(
    fbState.tcu.sgbd,
    'gs20',
    'the earlier identity is left alone'
  );
  ok(
    'silent as a GS20: three tries, the message says so, no other SGBD asked even though one would answer'
  );

  console.log(`\n${passed} checks passed`);
})().catch((e) => {
  console.error(`\nFAILED: ${e.stack || e}`);
  process.exit(1);
});
