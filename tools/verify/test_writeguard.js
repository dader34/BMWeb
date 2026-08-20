#!/usr/bin/env node
// The write guard must hold: a job that CHANGES the ECU does not transmit
// unless the caller opted in.
//
// This exists because the guard is one `if` protecting real hardware, and
// an `if` is easy to delete during a refactor without anyone noticing --
// nothing else in the suite would fail. The interesting assertion is not
// "it throws" but "it throws having sent NOTHING", including the implicit
// INITIALISIERUNG that runs before every job.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const ctx = { module: { exports: {} }, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'app/renderer/core/bestvm.js'),
                                'utf8'), ctx);
const { Best2Vm, isWriteJob } = ctx.module.exports;

let failures = 0;
function check(what, ok) {
  if (!ok) { failures++; console.log(`  FAIL  ${what}`); }
  else console.log(`  ok    ${what}`);
}

// ---- classification, including the pairs that must NOT be confused
for (const [name, want] of [
  ['STATUS_UBATT', false], ['IDENT', false], ['FS_LESEN', false],
  ['CODIERUNG_LESEN', false], ['MESSWERTBLOCK_LESEN', false],
  ['FS_LOESCHEN', true], ['STEUERN_E_LUEFTER', true],
  ['ADAP_SELEKTIV_LOESCHEN', true], ['CODIERUNG_SCHREIBEN', true],
  ['ECU_CONFIG_RESET', true], ['STEUERGERAETE_RESET', true],
]) {
  check(`${want ? 'write' : 'read '} ${name}`, isWriteJob(name) === want);
}

// ---- behaviour, against a real job with real captured telegrams
//
// This half is the reason the file exists ("throws having sent NOTHING") and
// it needs generated fixtures that are gitignored. It used to skip SILENTLY
// when they were absent -- a machine without data/ reported "write guard
// holds" having tested only name classification. A safety test that can pass
// without running is worse than none, so a missing fixture is now a FAILURE
// naming what to regenerate, not a quiet green.
const T = require('./ecu_tree.js');
const code0 = T.readEcuJson('ms450ds0', 'job-code.json');
const fixP = path.join(ROOT, 'data/sim-captures/vmfix.json');
if (!code0) {
  check('behavioural half ran (missing data/chassis/.../ms450ds0/job-code.json'
    + ' -- regenerate with tools/sgbd/ecu_tree.py)', false);
} else if (!fs.existsSync(fixP)) {
  check('behavioural half ran (missing data/sim-captures/vmfix.json'
    + ' -- regenerate with tools/vm_fixtures.py)', false);
} else {
  const code = code0;

  const tables = T.readEcuJson('ms450ds0', 'tables.json') || {};
  const fix = JSON.parse(fs.readFileSync(fixP, 'utf8'));
  const c = fix.cases.find((x) => x.sgbd === 'ms450ds0'
    && x.job === 'FS_LOESCHEN');
  if (!c) {
    check('behavioural half ran (vmfix.json has no ms450ds0 FS_LOESCHEN case'
      + ' -- regenerate with tools/vm_fixtures.py)', false);
  } else {
    const byReq = new Map((c.telegrams || []).map(
      (t) => [String(t.request), t.response]));
    const lastResp = (c.telegrams || []).slice(-1)[0]?.response || [];
    let sent = 0;
    const mk = (opts) => new Best2Vm(code, Object.assign({
      tables,
      send: (r) => { sent++; return byReq.get(String(Array.from(r))) ?? lastResp; },
    }, opts));

    // WRITES ARE ENABLED BY DEFAULT (owner's decision, 2026-08-19) so actuator
    // tests reach the wire. The gate still EXISTS and still refuses when a
    // caller asks it to -- that is what group probing relies on, and it is the
    // one-line change back to refuse-everything.
    sent = 0;
    let threw = false;
    try { mk({ allowWrites: false }).run('FS_LOESCHEN'); } catch (e) { threw = true; }
    check('write job refused when allowWrites:false is passed', threw);
    check('NOTHING transmitted before that refusal', sent === 0);

    sent = 0;
    const sets = mk({}).run('FS_LOESCHEN');
    check('write job runs by default now', sent > 0
      && Object.assign({}, ...sets).JOB_STATUS === 'OKAY');

    sent = 0;
    mk({}).run('STATUS_MESSWERTBLOCK_0');
    check('read job unaffected without the flag', sent > 0);
  }
}

console.log(failures ? `\n${failures} FAILURES` : '\nwrite guard holds');
process.exit(failures ? 1 : 0);
