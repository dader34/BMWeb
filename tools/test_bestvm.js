#!/usr/bin/env node
// Does the JS BEST2 VM produce the same results as the real EDIABAS engine?
//
// This is the test that decides whether the web app can claim to interpret
// jobs the way INPA does. The lifted specs got to ~71% because summarising
// has a structural ceiling; the VM executes the same instruction stream the
// engine executes, so the honest target here is 100% -- and any gap is a
// concrete VM bug, not an unliftable idiom.
//
// Input is a fixture bundle written by tools/vm_fixtures.py: for each job,
// the request/response telegrams and the result sets the ENGINE produced
// from them. The VM replays the identical bytes and the results are diffed
// key by key.
//
//   python3 tools/vm_fixtures.py > data/sim-captures/vmfix.json
//   node tools/test_bestvm.js [--verbose] [--sgbd <name>]
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
function load(rel) {
  const ctx = { module: { exports: {} }, console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), ctx);
  return ctx.module.exports;
}
const { Best2Vm, VmError } = load('app/renderer/bestvm.js');

const fixPath = path.join(ROOT, 'data/sim-captures/vmfix.json');
if (!fs.existsSync(fixPath)) {
  console.error('missing ' + path.relative(ROOT, fixPath));
  console.error('run: python3 tools/vm_fixtures.py > '
    + path.relative(ROOT, fixPath));
  process.exit(2);
}
const fix = JSON.parse(fs.readFileSync(fixPath, 'utf8'));
const verbose = process.argv.includes('--verbose');
const only = process.argv.includes('--sgbd')
  ? process.argv[process.argv.indexOf('--sgbd') + 1] : null;

// Injected by EdiabasNet around job execution, not by job bytecode.
const SYSTEM_RESULTS = new Set([
  'OBJECT', 'JOBNAME', 'VARIANTE', 'GRUPPE', 'FAMILIE', 'SAETZE',
  'JOBSTATUS', 'UBATTCURRENT', 'UBATTHISTORY', 'IGNITIONCURRENT',
  'IGNITIONHISTORY', 'SPRACHE', 'DONE', 'QUALIFIER', 'RESULTSOURCE',
]);

const codeCache = new Map();
function codeFor(sgbd) {
  if (!codeCache.has(sgbd)) {
    const p = path.join(ROOT, 'data/job-code', `${sgbd}.json`);
    codeCache.set(sgbd, fs.existsSync(p)
      ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);
  }
  return codeCache.get(sgbd);
}
const tableCache = new Map();
function tablesFor(sgbd) {
  if (!tableCache.has(sgbd)) {
    const p = path.join(ROOT, 'data/sgbd-tables', `${sgbd}.json`);
    tableCache.set(sgbd, fs.existsSync(p)
      ? JSON.parse(fs.readFileSync(p, 'utf8')) : {});
  }
  return tableCache.get(sgbd);
}

// Compare the way the harness does: numbers within tolerance, everything
// else as text. The engine reports every result as a string.
function same(want, got) {
  if (got === undefined || got === null) return false;
  const wn = parseFloat(want), gn = typeof got === 'number' ? got
    : parseFloat(String(got));
  if (Number.isFinite(wn) && Number.isFinite(gn)
      && String(want).trim() !== '' ) {
    return Math.abs(wn - gn) <= Math.max(1e-6, Math.abs(wn) * 1e-9);
  }
  const gs = Array.isArray(got) ? got.join(';') : String(got);
  return String(want) === gs;
}

let jobs = 0, agree = 0, disagree = 0, missing = 0, crashed = 0;
const errs = new Map();
const diffs = [];
for (const c of fix.cases) {
  if (only && c.sgbd !== only) continue;
  const code = codeFor(c.sgbd);
  if (!code) continue;
  if (code.jobs[c.job] === undefined) continue;
  jobs++;
  let queue = (c.telegrams || []).map((t) => t.response);
  let qi = 0;
  const machine = new Best2Vm(code, {
    tables: tablesFor(c.sgbd),
    args: c.args || '',
    send: () => queue[qi++] || [],
  });
  let sets;
  try {
    sets = machine.run(c.job);
  } catch (e) {
    crashed++;
    const key = e instanceof VmError ? e.message.replace(/\d+/g, 'N')
      : `${e.constructor.name}: ${e.message}`.replace(/\d+/g, 'N');
    errs.set(key, (errs.get(key) || 0) + 1);
    continue;
  }
  // the engine's sets, flattened by name -- INPA reads results by name
  const got = new Map();
  for (const s of sets) for (const [k, v] of Object.entries(s)) {
    if (!got.has(k)) got.set(k, v);
  }
  for (const s of (c.sets || [])) {
    for (const [k, want] of Object.entries(s)) {
      if (k.startsWith('_')) continue;
      // System results the ENGINE injects around every job (identity,
      // interface state, set count) -- not produced by the job's own
      // bytecode, so the VM is not expected to synthesise them and
      // counting them as failures would hide real decode gaps.
      if (SYSTEM_RESULTS.has(k)) continue;
      if (!got.has(k)) {
        missing++;
        if (diffs.length < 400) diffs.push([c.sgbd, c.job, k, '(absent)', want]);
        continue;
      }
      if (same(want, got.get(k))) agree++;
      else {
        disagree++;
        if (diffs.length < 400) {
          diffs.push([c.sgbd, c.job, k, got.get(k), want]);
        }
      }
    }
  }
}

const checked = agree + disagree + missing;
console.log(`jobs replayed : ${jobs}   (VM crashes: ${crashed})`);
console.log(`results checked: ${checked}`);
console.log(`  AGREE       : ${agree} (${(100 * agree / Math.max(checked, 1)).toFixed(1)}%)`);
console.log(`  DISAGREE    : ${disagree}`);
console.log(`  MISSING     : ${missing}`);
if (errs.size) {
  console.log('\ncrash reasons:');
  for (const [k, v] of [...errs].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${String(v).padStart(4)}  ${k}`);
  }
}
if (diffs.length) {
  const byKey = new Map();
  for (const d of diffs) byKey.set(d[2], (byKey.get(d[2]) || 0) + 1);
  console.log('\ntop differing results:');
  for (const [k, v] of [...byKey].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    const ex = diffs.find((d) => d[2] === k);
    console.log(`  ${String(v).padStart(4)}  ${k}  e.g. ${ex[0]}:${ex[1]} vm=${JSON.stringify(ex[3])} engine=${JSON.stringify(ex[4])}`);
  }
  if (verbose) {
    console.log('\nall differences:');
    for (const d of diffs) {
      console.log(`  ${d[0]}:${d[1]} ${d[2]} vm=${JSON.stringify(d[3])} engine=${JSON.stringify(d[4])}`);
    }
  }
}
process.exit(disagree + missing + crashed ? 1 : 0);
