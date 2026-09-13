#!/usr/bin/env node
// What a beta report is ALLOWED to file, and what a whole-car script is
// allowed to put on the wire. Both guard the same thing from opposite ends:
// a scan asks about every module a series can carry, most of which are not
// fitted, and the routine silence that produces must not be filed as a fault
// or logged as a failure -- it buried the real ones.
//
//   node tools/verify/test_report_noise.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
let passed = 0;
const ok = (what) => {
  passed++;
  if (process.env.V) console.log('  ok', what);
};

// ---- the auto-reporter ------------------------------------------------------
// journal.js installs against a live window on load, so rather than stub a
// browser this reads the classifier out of the source and exercises it
// directly: the classifier IS the fix, and the surrounding bookkeeping
// (dedupe, per-session cap) was already covered and unchanged.
function expectedWireRe() {
  const src = fs.readFileSync(
    path.join(ROOT, 'app/renderer/core/journal.js'),
    'utf8'
  );
  const m = /const BETA_EXPECTED_WIRE = (\/.*?\/);/.exec(src);
  assert.ok(m, 'BETA_EXPECTED_WIRE is defined in journal.js');
  // eslint-disable-next-line no-eval
  return { re: eval(m[1]), src };
}

(async () => {
  {
    const { re, src } = expectedWireRe();

    // the routine silences a whole-car scan produces on every single run
    assert.ok(re.test('IFH-0009'), 'an unanswered address is expected');
    assert.ok(re.test('IFH-0018'), 'an unreachable bus concept is expected');
    ok('an absent module and an unreachable bus concept are not reported');

    // the ones that mean something really did go wrong
    for (const code of ['IFH-0019', 'IFH-0006', 'IFH-0003', 'IFH-1000']) {
      assert.ok(!re.test(code), `${code} must still be reported`);
    }
    ok('a genuine wire error still files a report');

    // the guard has to run BEFORE the dedupe, or an expected code would
    // still burn one of the five per-session slots
    const guard = src.indexOf('BETA_EXPECTED_WIRE.test');
    const dedupe = src.indexOf('this._auto.seen.has');
    assert.ok(
      guard > 0 && dedupe > guard,
      'the expected-silence guard runs before the per-session cap'
    );
    ok('expected silence never consumes a report slot');
  }

  // The vehicle-script plumbing skip that used to live here was REVERTED.
  // It suppressed a job whose target fell back to the vehicle's own name,
  // on the theory that "no job code shipped for e46" was noise. It is not:
  // those are the whole-car script's own Ident sweep, and blocking them
  // emptied the identification report entirely (test_ipo_runtime's F2 Ident).
  // The journal lines are honest records of groups that did not answer.

  console.log(`report noise: ${passed} checks passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
