#!/usr/bin/env node
// set_communication_pars decoded the way EDIABAS reads it -- against the
// real blobs of ms450ds0 (MS45) and the D_0012 group probe. A wrong index
// here is a wrong wait on every telegram.
const assert = require('assert');
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { Best2Vm } = require('../../app/renderer/core/bestvm.js');
const ROOT = path.join(__dirname, '..', '..');
const load = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, f))));
const words = (raw) => {
  if (raw.length >= 4 && raw.length % 4 === 0) {
    const w = [];
    for (let i = 0; i + 3 < raw.length; i += 4) w.push(raw[i] | raw[i+1] << 8 | raw[i+2] << 16 | raw[i+3] << 24);
    if (w[0] <= 0x1ff) return w;
  }
  const w = [];
  for (let i = 0; i + 1 < raw.length; i += 2) w.push(raw[i] | raw[i+1] << 8);
  return w;
};
const blobs = (file) => {
  const g = load(file);
  return g.ops.filter((o) => o[0] === 'xsetpar' && o[1][0][0] === 8)
    .map((o) => g.strings[o[1][0][1]]).filter((b) => Array.isArray(b))
    .map((b) => Best2Vm.decodeCommParams(words(b)));
};
let n = 0;
const ok = (m) => { n++; console.log(`  ok    ${m}`); };

const ms = blobs('data/ecu-src/ms450ds0.job-code.json.gz');
const by = {};
for (const c of ms) by[c.concept] = c;
assert.deepStrictEqual([by[0x6].timeout, by[0x6].regen], [500, 25], 'DS2: [5],[6]');
assert.deepStrictEqual([by[0x10d].timeout, by[0x10d].regen, by[0x10d].timeoutNr78],
  [500, 25, 5000], 'KWP2000*: [2],[3], Nr78 [7]');
assert.deepStrictEqual([by[0x10f].timeout, by[0x10f].regen, by[0x10f].timeoutNr78],
  [800, 20, 5000], 'BMW-FAST: [2],[3], Nr78 [6]');
ok('ms450ds0: DS2 500/25, KWP2000* 500/25 (Nr78 5000), BMW-FAST 800/20 (Nr78 5000)');

const d = blobs('data/groups/d_0012.json.gz');
assert.ok(d.every((c) => c.concept === 0x6 && c.timeout === 1000), 'D_0012 probes DS2 at 1000');
assert.deepStrictEqual(d.map((c) => c.regen), [200, 100]);
ok('d_0012: both DS2 steps 1000 ms answer timeout, regen 200 then 100');

// the old guess would have taken 5000 for every 0x1xx concept
assert.notStrictEqual(by[0x10d].timeout, 5000);
ok('the 0x78 busy timeout is no longer mistaken for the answer timeout');
console.log(`\ncommpars: ${n} checks passed`);
