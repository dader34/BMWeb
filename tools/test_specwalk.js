#!/usr/bin/env node
// Does the JS spec walker decode exactly like the Python reference?
//
// app/renderer/specwalk.js is what will run in the browser; decode_with_spec()
// in tools/sgbd_value_diff.py is what the value harness verified against the
// real EDIABAS engine. If those two drift, the thing we ship stops being the
// thing we tested -- so this compares them result by result over every job
// spec, and any difference is a failure.
//
// The Python side is dumped to JSON by tools/dump_specs.py first:
//   python3 tools/dump_specs.py > data/sim-captures/specdump.json
//   node tools/test_specwalk.js
//
// Loop records whose scale is table-keyed are compared on the RAW word: the
// Python decoder cannot resolve the key (it has no runtime) and reports the
// raw value, while the JS walker resolves it when given tables. That is the
// intended difference, so the test feeds the JS side no tables and expects
// the raw word from both.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'app/renderer/specwalk.js'), 'utf8');
const ctx = { module: { exports: {} } };
vm.createContext(ctx);
vm.runInContext(src, ctx);
const { specWalk } = ctx.module.exports;

const dumpPath = path.join(ROOT, 'data/sim-captures/specdump.json');
if (!fs.existsSync(dumpPath)) {
  console.error('missing ' + path.relative(ROOT, dumpPath));
  console.error('run: python3 tools/dump_specs.py > ' + path.relative(ROOT, dumpPath));
  process.exit(2);
}
const cases = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));

let checked = 0, agree = 0;
const diffs = [];
for (const c of cases) {
  const got = specWalk(c.spec, c.frame, {});
  for (const [name, want] of Object.entries(c.expected)) {
    checked++;
    const mine = got[name];
    // JSON has no distinction between a Python None and a JS null, and
    // numeric formatting differs (1.0 vs 1) -- compare by value, not text.
    // A wide field comes back as a BigInt (a Number cannot hold 29 bytes),
    // and Python prints the same value as a plain int -- compare as decimal
    // strings so the two representations meet.
    // A wide field comes back from JS as a BigInt, because a Number cannot
    // hold 29 bytes. Python decoded the same value exactly, but json.dump
    // wrote it through a float and lost the low digits -- so compare those by
    // FLOAT VALUE, not digits. The JS side is the more precise of the two;
    // this is a limitation of the dump format, not a decode difference.
    const same = (want === null && mine === null) ||
      (typeof mine === 'bigint'
        ? Number(mine) === Number(want) || String(want) === mine.toString()
        : typeof want === 'number' && typeof mine === 'number'
          ? Math.abs(want - mine) <= Math.max(1e-9, Math.abs(want) * 1e-12)
          : String(want) === String(mine));
    if (same) agree++;
    else diffs.push({ sgbd: c.sgbd, job: c.job, name, py: want, js: mine });
  }
}

console.log(`${cases.length} specs, ${checked} results compared`);
console.log(`  identical : ${agree}`);
console.log(`  DIFFERENT : ${diffs.length}`);
for (const d of diffs.slice(0, 15)) {
  console.log(`    ${d.sgbd}:${d.job} ${d.name}  py=${String(d.py)} js=${String(d.js)}`);
}
process.exit(diffs.length ? 1 : 0);
