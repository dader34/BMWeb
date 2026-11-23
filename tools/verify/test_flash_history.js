#!/usr/bin/env node
// How a flashing session is recorded in History (core/flash/flash-history.js):
// the outcome is what the flow that ran it SAYS, never what its status
// lines happen to be worded like.
//
// THE BUG THIS PINS. The outcome used to be read out of the status text: a
// line with "fail", "error", "denied", "cancel", "no data" or "not match"
// made the session failed for good; one with "success", "written" or
// "saved" made it ok. A write that went through was recorded as failed when
// the fault clear after it could not run, and a finished Finish Programming
// ("Both signatures verified, DME reset") as merely ended.
//
//   node tools/verify/test_flash_history.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const R = path.join(ROOT, 'app', 'renderer');
let passed = 0;
const ok = (what) => {
  passed++;
  if (process.env.V) console.log('  ok', what);
};

// the log, with History's store replaced by a list
const ctx = { console, Settings: { get: (k, d) => d } };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(
  fs.readFileSync(path.join(R, 'core/flash/flash-history.js'), 'utf8'),
  ctx
);
const { flashLog, flashHistory } = ctx;
const kept = [];
flashHistory._append = async (entry) => void kept.push(entry);

/** One session: what the flow reports, in order. */
const session = async (steps) => {
  await flashLog.start('flash-tune', { vin: 'X', module: 'MS45' });
  for (const [what, arg] of steps) flashLog[what](arg);
  return flashLog.stop();
};

(async () => {
  // a write that went through, then a fault clear that could not run
  let e = await session([
    ['outcome', 'ok'],
    ['status', 'Flash Tune successful in 52s'],
    ['status', 'Clear failed: IFH-0009: no answer from ECU (timeout)'],
  ]);
  assert.strictEqual(e.result, 'ok', 'a later status line unmade a flash');
  assert.strictEqual(
    e.status,
    'Clear failed: IFH-0009: no answer from ECU (timeout)',
    'the closing words are still the last status'
  );
  ok('what the status lines say after it does not change the outcome');

  // a success whose words name none of the old magic ones
  e = await session([
    ['status', 'Both signatures verified, DME reset'],
    ['outcome', 'ok'],
  ]);
  assert.strictEqual(e.result, 'ok');
  // a failure whose words do not say so
  e = await session([
    ['status', 'The DME did not take the last block'],
    ['outcome', 'failed'],
  ]);
  assert.strictEqual(e.result, 'failed');
  // words that used to decide, deciding nothing
  for (const line of [
    'Calibration written. Cycle the ignition before driving.',
    'Saved the tune (118784 bytes)',
    'Read failed: no data at 0x090000',
    '0 line errors',
    'Cancelled: nothing was written',
  ]) {
    e = await session([['status', line]]);
    assert.strictEqual(
      e.result,
      'ended',
      `"${line}" decided the outcome of a session nobody spoke for`
    );
  }
  ok('the wording of a status line decides nothing');

  e = await session([
    ['status', 'Cancelled: nothing was written'],
    ['outcome', 'cancelled'],
  ]);
  assert.strictEqual(e.result, 'cancelled');
  // no session: every call is a no-op, and stop() has nothing to record
  flashLog.outcome('ok');
  flashLog.status('x');
  assert.strictEqual(await flashLog.stop(), null);
  ok('a declined write is cancelled; no session, nothing recorded');

  // ---- every flow that opens a session says how it went ---------------------
  // A session is opened in ten places. Each either runs its operation
  // through fbFlashRun, which reports the operation's own result, or
  // reports for itself; a new flow that does neither would be recorded as
  // 'ended' whatever happened.
  const dir = path.join(R, 'screens', 'flashing');
  const screen = fs.readFileSync(path.join(dir, 'screen.js'), 'utf8');
  const run = screen.slice(
    screen.indexOf('async function fbFlashRun('),
    screen.indexOf('async function fbFlashRunOp(')
  );
  assert.ok(
    /flashLog\.outcome\(\s*r && r\.ok \? 'ok'/.test(run) &&
      /catch \(e\) \{\s*flashLog\.outcome\('failed'\)/.test(run),
    "fbFlashRun no longer reports its operation's result"
  );
  let opened = 0;
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/await fbSessionStart\(/g)) {
      opened++;
      // the function this session is opened in: from its declaration to the
      // next top-level one
      const from = src.lastIndexOf('\nasync function ', m.index);
      const next = src.indexOf('\nasync function ', m.index);
      const body = src.slice(from, next < 0 ? src.length : next);
      assert.ok(
        /fbFlashRun\(|flashLog\.outcome\(/.test(body),
        `${f}: a session is opened by ${/async function (\w+)/.exec(body)[1]}, which never says how it went`
      );
    }
  }
  assert.ok(opened >= 10, `only ${opened} sessions found in screens/flashing`);
  ok(`all ${opened} flows that open a session report its outcome`);

  console.log(`test_flash_history: ${passed} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
