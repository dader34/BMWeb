#!/usr/bin/env node
// The beta journal: scrubbing, bounding, report shape. Pure parts only.
const assert = require('assert');
global.window = undefined;   // journal must load headless without a DOM
const { Journal, scrubVin } = require('../../app/renderer/core/journal.js');

let passed = 0;
const ok = (m) => { passed++; console.log(`  ok    ${m}`); };

assert.strictEqual(scrubVin('vin WBAET37495NJ87379 done'),
  'vin WBAET37495XXXXXXX done', 'the 7-char serial must be masked');
assert.strictEqual(scrubVin('short EB16266 stays'), 'short EB16266 stays');
assert.strictEqual(scrubVin(null), '');
ok('scrubVin: masks the serial half of a 17-char VIN, leaves the rest');

Journal.rows.length = 0;
for (let i = 0; i < 700; i++) Journal.log('nav', `#${i}`);
assert.strictEqual(Journal.rows.length, 500, 'ring must stay bounded');
assert.strictEqual(Journal.rows[499].s, '#699');
ok('journal: bounded ring keeps the newest 500 events');

Journal.log('job', 'ms450ds0 IDENT WBAET37495NJ87379 · OKAY');
assert.ok(Journal.rows[499].s.includes('WBAET37495XXXXXXX'),
  'journal text must be scrubbed at write time');
ok('journal: VINs scrubbed at write time');

// ---- IFH auto-reports: one per code, capped, silent -------------------------
(async () => {
  let posts = 0;
  global.fetch = async () => { posts++; return { ok: true }; };
  global.AbortController = class { constructor(){ this.signal=null; } abort(){} };
  assert.strictEqual(await Journal.maybeAutoReport('plain error', 'x'), false,
    'non-IFH text must never auto-file');
  assert.strictEqual(await Journal.maybeAutoReport('IFH-0009 silence', 'job A'), true);
  assert.strictEqual(await Journal.maybeAutoReport('IFH-0009 again', 'job B'), false,
    'same code twice must not file twice');
  assert.strictEqual(await Journal.maybeAutoReport('IFH-0003 echo', 'job C'), true);
  Journal._auto.sent = Journal._auto.max;
  assert.strictEqual(await Journal.maybeAutoReport('IFH-0018 init', 'job D'), false,
    'the session cap must hold');
  assert.strictEqual(posts, 2, `expected 2 uploads, saw ${posts}`);
  ok('auto-reports: one per IFH code, session-capped, non-IFH ignored');
  console.log(`\njournal: ${passed} checks passed`);
})();
