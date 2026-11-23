#!/usr/bin/env node
// The beta journal: scrubbing, bounding, report shape. Pure parts only.
const assert = require('assert');
global.window = undefined; // journal must load headless without a DOM
const { Journal, scrubVin } = require('../../app/renderer/core/journal.js');

let passed = 0;
const ok = (m) => {
  passed++;
  console.log(`  ok    ${m}`);
};

assert.strictEqual(
  scrubVin('vin WBAET37495NJ87379 done'),
  'vin WBAET37495XXXXXXX done',
  'the 7-char serial must be masked'
);
assert.strictEqual(scrubVin('short EB16266 stays'), 'short EB16266 stays');
assert.strictEqual(scrubVin(null), '');
ok('scrubVin: masks the serial half of a 17-char VIN, leaves the rest');

Journal.rows.length = 0;
for (let i = 0; i < 700; i++) Journal.log('nav', `#${i}`);
assert.strictEqual(Journal.rows.length, 500, 'ring must stay bounded');
assert.strictEqual(Journal.rows[499].s, '#699');
ok('journal: bounded ring keeps the newest 500 events');

Journal.log('job', 'ms450ds0 IDENT WBAET37495NJ87379 · OKAY');
assert.ok(
  Journal.rows[499].s.includes('WBAET37495XXXXXXX'),
  'journal text must be scrubbed at write time'
);
ok('journal: VINs scrubbed at write time');

// ---- IFH auto-reports: one per code, capped, silent -------------------------
(async () => {
  let posts = 0;
  global.fetch = async () => {
    posts++;
    return { ok: true };
  };
  global.AbortController = class {
    constructor() {
      this.signal = null;
    }
    abort() {}
  };
  assert.strictEqual(
    await Journal.maybeAutoReport('plain error', 'x'),
    false,
    'non-IFH text must never auto-file'
  );
  // A module that is not fitted answers IFH-0009 (silence) or IFH-0018 (its
  // concept is out of this cable's reach): the expected result of asking,
  // never filed (journal.js BETA_EXPECTED_WIRE; one week's reports were 45
  // of 48 exactly that).
  assert.strictEqual(
    await Journal.maybeAutoReport('IFH-0009 silence', 'job A'),
    false,
    'a module that did not answer must not auto-file'
  );
  assert.strictEqual(
    await Journal.maybeAutoReport('IFH-0018 init', 'job A'),
    false,
    "a module out of the cable's reach must not auto-file"
  );
  assert.strictEqual(posts, 0, 'an expected wire code reached the collector');
  ok('auto-reports: IFH-0009 and IFH-0018 are the expected answer, not filed');

  assert.strictEqual(
    await Journal.maybeAutoReport('IFH-0003 echo', 'job B'),
    true
  );
  assert.strictEqual(
    await Journal.maybeAutoReport('IFH-0003 again', 'job C'),
    false,
    'same code twice must not file twice'
  );
  assert.strictEqual(
    await Journal.maybeAutoReport('IFH-0019 checksum', 'job D'),
    true
  );
  Journal._auto.sent = Journal._auto.max;
  assert.strictEqual(
    await Journal.maybeAutoReport('IFH-0056 no concept', 'job E'),
    false,
    'the session cap must hold'
  );
  assert.strictEqual(posts, 2, `expected 2 uploads, saw ${posts}`);
  ok('auto-reports: one per IFH code, session-capped, non-IFH ignored');
  console.log(`\njournal: ${passed} checks passed`);
})();
