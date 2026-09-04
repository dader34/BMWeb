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

const ROOT = path.join(__dirname, '..', '..');
function load(rel) {
  const ctx = { module: { exports: {} }, console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), ctx);
  return ctx.module.exports;
}
const { Best2Vm, VmError } = load('app/renderer/core/bestvm.js');

const fixPath = path.join(ROOT, 'data/sim-captures/vmfix.json');
if (!fs.existsSync(fixPath)) {
  console.error('missing ' + path.relative(ROOT, fixPath));
  console.error(
    'run: python3 tools/vm_fixtures.py > ' + path.relative(ROOT, fixPath)
  );
  process.exit(2);
}
const fix = JSON.parse(fs.readFileSync(fixPath, 'utf8'));
const verbose = process.argv.includes('--verbose');
const only = process.argv.includes('--sgbd')
  ? process.argv[process.argv.indexOf('--sgbd') + 1]
  : null;

// Results the ENGINE derives from state a fresh VM cannot have.
//
// ID_SG_ADR is the honest example: MS450's IDENT publishes it from
// `move B0, S1[1002]` on a register whose logical length is 0 -- i.e. it
// reads UNINITIALIZED BUFFER MEMORY. EDIABAS zeroes string registers at job
// start (ClearData), so a clean session yields 0; the engine's 18 is a
// leftover byte from the init exchange of the same Diag session. Neither
// value is "the decode" -- the SGBD has a bug -- so this is excluded rather
// than chased, and the reason is recorded here instead of in a diff list.
const UNINITIALIZED_READS = new Set(['ID_SG_ADR']);

// KNOWN OPEN DIFFERENCES, listed so the count stays honest rather than
// silently excluded. These are NOT passing:
//
//   (ews:FGNR_LESEN FG_PZ is FIXED -- it was `scut`, whose length argument
//   counts the terminating NUL, so `scut S1,#1` on a 2-byte "FP" removes
//   only the absent terminator instead of the 'P'. Found by diffing the
//   engine's own ifh instruction trace against the VM's, address by
//   address: control flow matched for 2660 steps and then split at a `jc`,
//   which traced back to a string one byte short 200 instructions earlier.)
//
//   ms450ds0:IDENT JOB_STATUS -- both engine and VM REJECT the synthetic
//     fixture; they just name different guards (INCORRECT_RESPONSE_ID vs
//     INCORRECT_LEN). This measures fixture quality, not decode fidelity:
//     the response was synthesised to exercise the lifter and is not a
//     shape this ECU accepts. Pinned in KNOWN_DISAGREEMENTS below with its
//     EXACT values, so the gate stays green on this one case and red on
//     any drift or any new disagreement.

// sgbd:job:result -> [vm value, engine value], compared exactly. An entry
// only excuses the disagreement it names; anything else still fails.
const KNOWN_DISAGREEMENTS = new Map([
  [
    'ms450ds0:IDENT:JOB_STATUS',
    ['ERROR_ECU_INCORRECT_RESPONSE_ID', 'ERROR_ECU_INCORRECT_LEN'],
  ],
]);

// Injected by EdiabasNet around job execution, not by job bytecode.
const SYSTEM_RESULTS = new Set([
  'OBJECT',
  'JOBNAME',
  'VARIANTE',
  'GRUPPE',
  'FAMILIE',
  'SAETZE',
  'JOBSTATUS',
  'UBATTCURRENT',
  'UBATTHISTORY',
  'IGNITIONCURRENT',
  'IGNITIONHISTORY',
  'SPRACHE',
  'DONE',
  'QUALIFIER',
  'RESULTSOURCE',
]);

// Both come from data/chassis/<CHASSIS>/<ECU>/ now: the generated data is
// laid out per car, not per kind.
const T = require('./ecu_tree.js');
const codeCache = new Map();
function codeFor(sgbd) {
  if (!codeCache.has(sgbd)) {
    codeCache.set(sgbd, T.readEcuJson(sgbd, 'job-code.json'));
  }
  return codeCache.get(sgbd);
}
const tableCache = new Map();
function tablesFor(sgbd) {
  if (!tableCache.has(sgbd)) {
    tableCache.set(sgbd, T.readEcuJson(sgbd, 'tables.json') || {});
  }
  return tableCache.get(sgbd);
}

// Compare the way the harness does: numbers within tolerance, everything
// else as text. The engine reports every result as a string.
function same(want, got) {
  if (got === undefined || got === null) return false;
  // A byte array is formatted FIRST, before any numeric comparison: the
  // engine renders it as dash-separated uppercase hex (Diag.Format), and
  // parseFloat("1F-27-2D") is 31 -- which accidentally equals the first
  // byte and would score a wrong value as correct.
  if (Array.isArray(got)) {
    const hex = got
      .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
      .join('-');
    return String(want) === hex;
  }
  const wn = parseFloat(want),
    gn = typeof got === 'number' ? got : parseFloat(String(got));
  if (
    Number.isFinite(wn) &&
    Number.isFinite(gn) &&
    String(want).trim() !== '' &&
    /^[-+0-9.eE]+$/.test(String(want).trim())
  ) {
    return Math.abs(wn - gn) <= Math.max(1e-6, Math.abs(wn) * 1e-9);
  }
  return String(want) === String(got);
}

let jobs = 0,
  agree = 0,
  disagree = 0,
  missing = 0,
  crashed = 0;
let knownDiff = 0;
const errs = new Map();
const diffs = [];
for (const c of fix.cases) {
  if (only && c.sgbd !== only) continue;
  const code = codeFor(c.sgbd);
  if (!code) continue;
  if (code.jobs[c.job] === undefined) continue;
  jobs++;
  // Answer the way the engine's simulator does: MATCH THE REQUEST, not the
  // call order. A sequential queue returns nothing once exhausted, and a
  // job that retries until it gets a valid answer (AIF_LESEN) then spins
  // forever -- that was every one of the step-limit "hangs".
  const pairs = (c.telegrams || []).map((t) => [String(t.request), t.response]);
  const byReq = new Map(pairs);
  let lastResp = pairs.length ? pairs[pairs.length - 1][1] : [];
  const machine = new Best2Vm(code, {
    tables: tablesFor(c.sgbd),
    args: c.args || '',
    // This harness replays CAPTURED telegrams into a callback; nothing
    // reaches a bus, so the write guard is opted past deliberately. That is
    // the only place in the repo that should do so without a human saying
    // yes -- see the guard's comment in bestvm.js.
    allowWrites: true,
    send: (req) => {
      const hit = byReq.get(String(Array.from(req)));
      return hit !== undefined ? hit : lastResp;
    },
  });
  let sets;
  try {
    sets = machine.run(c.job);
  } catch (e) {
    crashed++;
    const key =
      e instanceof VmError
        ? e.message.replace(/\d+/g, 'N')
        : `${e.constructor.name}: ${e.message}`.replace(/\d+/g, 'N');
    errs.set(key, (errs.get(key) || 0) + 1);
    continue;
  }
  // Compare SET BY SET, not flattened. A multi-record job (FS_LESEN emits
  // one set per fault) legitimately repeats a result name with different
  // values per set, and flattening kept only the first -- which read as a
  // VM error when the VM had produced both records correctly.
  // The engine's set 0 is the injected system set, so its data sets start
  // at index 1; the VM emits data sets only.
  const engineSets = (c.sets || []).filter(
    (s) => !Object.keys(s).some((k) => SYSTEM_RESULTS.has(k))
  );
  for (let si = 0; si < engineSets.length; si++) {
    const s = engineSets[si];
    const vmSet = sets[si] || {};
    const got = new Map(Object.entries(vmSet));
    for (const [k, want] of Object.entries(s)) {
      if (k.startsWith('_')) continue;
      // System results the ENGINE injects around every job (identity,
      // interface state, set count) -- not produced by the job's own
      // bytecode, so the VM is not expected to synthesise them and
      // counting them as failures would hide real decode gaps.
      if (SYSTEM_RESULTS.has(k)) continue;
      if (UNINITIALIZED_READS.has(k)) continue;
      if (!got.has(k)) {
        missing++;
        if (diffs.length < 400)
          diffs.push([c.sgbd, c.job, k, '(absent)', want]);
        continue;
      }
      if (same(want, got.get(k))) agree++;
      else {
        const known = KNOWN_DISAGREEMENTS.get(`${c.sgbd}:${c.job}:${k}`);
        if (known && known[0] === got.get(k) && known[1] === want) {
          knownDiff++;
        } else {
          disagree++;
          if (diffs.length < 400) {
            diffs.push([c.sgbd, c.job, k, got.get(k), want]);
          }
        }
      }
    }
  }
}

const checked = agree + knownDiff + disagree + missing;
// A silent-skip floor. Every case is skipped when data/chassis is absent or
// renamed (codeFor() returns null for each), and this file used to exit 0
// with "jobs replayed : 0" -- a green run that verified nothing. The floor is
// set well below the current healthy count (460 jobs on 2026-08-17) but far
// above noise: dropping under it means the fixture bundle or the ECU tree is
// gone/mislaid, not that the VM got worse.
const MIN_JOBS = 100;
if (!only && jobs < MIN_JOBS) {
  console.error(`FAIL: only ${jobs} jobs replayed (< ${MIN_JOBS}).`);
  console.error(
    'data/chassis or vmfix.json is missing/mislaid -- the VM was' +
      ' not actually exercised. Regenerate with tools/sgbd/ecu_tree.py and' +
      ' tools/vm_fixtures.py.'
  );
  process.exit(1);
}
console.log(`jobs replayed : ${jobs}   (VM crashes: ${crashed})`);
console.log(`results checked: ${checked}`);
console.log(
  `  AGREE       : ${agree} (${((100 * agree) / Math.max(checked, 1)).toFixed(1)}%)`
);
console.log(`  KNOWN DIFF  : ${knownDiff} (pinned in KNOWN_DISAGREEMENTS)`);
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
    console.log(
      `  ${String(v).padStart(4)}  ${k}  e.g. ${ex[0]}:${ex[1]} vm=${JSON.stringify(ex[3])} engine=${JSON.stringify(ex[4])}`
    );
  }
  if (verbose) {
    console.log('\nall differences:');
    for (const d of diffs) {
      console.log(
        `  ${d[0]}:${d[1]} ${d[2]} vm=${JSON.stringify(d[3])} engine=${JSON.stringify(d[4])}`
      );
    }
  }
}
process.exit(disagree + missing + crashed ? 1 : 0);
