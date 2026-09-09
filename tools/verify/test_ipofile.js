// The browser .IPO reader against the Python decoder that produced the
// shipped dumps.
//
// core/ipofile/ decodes a script's bytes into the same {procs, byid} the
// tools/decompile pipeline exports, so a file the user drops runs through the
// identical runtime as a shipped one. The bar is a byte-identical token
// stream: same ops, same fields, same jump targets, same order. Anything less
// and the same script would behave differently depending on where it came
// from, which is the one thing this reader exists to prevent.
//
// Ground truth is data/inpa-ir/<stem>.ipoexec.json[.gz], written by
// tools/export/ipo_exec.py. A dump older than the decoder that made it can
// carry a stale builtin NAME (the tables gained names over time); such a file
// is compared on structure and reported, not failed, because the bytes agree
// and only the naming table moved.
//
//   node tools/verify/test_ipofile.js
//   V=1 node tools/verify/test_ipofile.js     # per-check output
//
// Skips cleanly when vendor/ is absent: CI has no BMW tree.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');
const SGDAT = path.join(ROOT, 'vendor', 'EC-APPS', 'INPA', 'SGDAT');
const IR = path.join(ROOT, 'data', 'inpa-ir');

let passed = 0;
const ok = (what) => {
  passed++;
  if (process.env.V) console.log('  ok', what);
};

if (!fs.existsSync(SGDAT)) {
  console.log('test_ipofile: no vendor/EC-APPS tree, skipped');
  process.exit(0);
}

const { loadClassic } = require('./lib/load_classic.js');
const F = loadClassic('core/ipofile/');

/** One ECU's .IPO, tolerating either extension case. */
function ipoPath(stem) {
  for (const ext of ['.IPO', '.ipo']) {
    const p = path.join(SGDAT, stem + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** The shipped Python dump for a stem, or null. */
function reference(stem) {
  const plain = path.join(IR, `${stem}.ipoexec.json`);
  if (fs.existsSync(plain)) return JSON.parse(fs.readFileSync(plain, 'utf8'));
  const gz = `${plain}.gz`;
  if (fs.existsSync(gz)) return JSON.parse(zlib.gunzipSync(fs.readFileSync(gz)).toString());
  return null;
}

/** A copy of the tokens with every builtin call name dropped. */
function withoutCallNames(procs) {
  const out = {};
  for (const name of Object.keys(procs)) {
    out[name] = procs[name].map((t) => {
      if (t.op !== 'call') return t;
      const c = Object.assign({}, t);
      delete c.name;
      return c;
    });
  }
  return out;
}

// ---- 1. the named files, token for token ----------------------------------
//
// These five are the ones the format was cracked against, plus one of each
// dialect the reader has to survive: a template (MUST_EXX), a chassis entry
// script (e46), a big DME (MS450), a climate module (IHKA46) and an emissions
// script (ABGAS).
const NAMED = ['MUST_EXX', 'e46', 'MS450', 'IHKA46', 'ABGAS'];
let stale = 0;
for (const stem of NAMED) {
  const p = ipoPath(stem);
  assert.ok(p, `${stem}: no .IPO in SGDAT`);
  const ref = reference(stem);
  assert.ok(ref, `${stem}: no shipped dump to compare against`);
  const got = F.ipofDecodeExec(new Uint8Array(fs.readFileSync(p)), stem);

  assert.deepStrictEqual(
    Object.keys(got.procs),
    Object.keys(ref.procs),
    `${stem}: the proc inventory differs`
  );
  assert.deepStrictEqual(got.byid, ref.byid, `${stem}: byid differs`);

  if (JSON.stringify(got.procs) === JSON.stringify(ref.procs)) {
    ok(`${stem}: ${Object.keys(got.procs).length} procs byte-identical`);
    continue;
  }
  // the bytes may still agree with only a builtin's NAME having moved
  assert.deepStrictEqual(
    withoutCallNames(got.procs),
    withoutCallNames(ref.procs),
    `${stem}: token streams differ beyond call naming`
  );
  stale += 1;
  ok(`${stem}: tokens identical, shipped dump predates a builtin name`);
}
if (stale && process.env.V) {
  console.log(`  note: ${stale} shipped dump(s) older than the builtin table`);
}

// ---- 2. the format's own anchors ------------------------------------------
//
// From tools/verify/test_disasm.py, which pins these against BMW's own
// MUST_EXX.SRC shipped beside MUST_EXX.IPO. If the JS reader drifts, it drifts
// away from the source BMW wrote, not merely from the Python.
{
  const data = new Uint8Array(fs.readFileSync(ipoPath('MUST_EXX')));
  const pool = F.ipofFindPool(data);
  assert.ok(pool.start !== null, 'MUST_EXX: no constant pool found');
  assert.deepStrictEqual(
    pool.entries[0x0c3d],
    ['s', 'Read analog status'],
    'MUST_EXX pool anchor moved: every string index would be shifted'
  );
  ok('MUST_EXX: the pool anchor lands on its known string');

  const exec = F.ipofDecodeExec(data, 'MUST_EXX');
  const instr = exec.procs.instr;
  assert.ok(instr, 'MUST_EXX declares instr');
  assert.deepStrictEqual(
    instr.filter((t) => t.op === 'decl').map((t) => t.type),
    ['string', 'int', 'int', 'int', 'bool'],
    'instr locals drifted from what BMW_STD.H declares'
  );
  assert.deepStrictEqual(
    instr.filter((t) => t.op === 'binop').map((t) => t.name),
    ['neg', 'gt', 'gt', 'sub', 'ge', 'sub', 'eq', 'sub', 'lt', 'and', 'add', 'eq'],
    'instr binop chain drifted'
  );
  assert.deepStrictEqual(
    instr.filter((t) => t.op === 'call').map((t) => t.name),
    ['strlen', 'strlen', 'midstr'],
    'instr calls drifted'
  );
  ok("instr matches BMW's own source, statement for statement");

  // the includes and the import table the report panel shows
  assert.ok(
    exec.includes.some((i) => /bmw_std\.h/i.test(i)),
    `MUST_EXX includes BMW_STD.H (got ${JSON.stringify(exec.includes)})`
  );
  assert.ok(
    Object.values(exec.imports).includes('GetPrivateProfileStringA'),
    'the DLL import table names its kernel32 entries'
  );
  ok('includes and DLL imports read out of Constant Data');
}

// ---- 3. jump targets are absolute byte offsets -----------------------------
//
// A jump's target is reported as a byte offset in the same coordinates as
// `at`, so it must land ON a token. A target that hits no token is how a
// mis-based block header shows up.
{
  const exec = F.ipofDecodeExec(new Uint8Array(fs.readFileSync(ipoPath('IHKA46'))), 'IHKA46');
  let checked = 0;
  for (const name of Object.keys(exec.procs)) {
    const toks = exec.procs[name];
    const at = new Set(toks.map((t) => t.at));
    const last = toks.length ? toks[toks.length - 1] : null;
    if (last) at.add(last.at + 4);
    for (const t of toks) {
      if (t.op !== 'jump' && t.op !== 'jfalse') continue;
      checked += 1;
      assert.ok(
        at.has(t.to) || t.to > last.at,
        `${name}: jump to ${t.to} lands between tokens`
      );
    }
  }
  assert.ok(checked > 50, `too few jumps checked (${checked})`);
  ok(`IHKA46: ${checked} jump targets land on tokens`);
}

// ---- 4. the corpus ---------------------------------------------------------
//
// Every .IPO that has a shipped dump, so a dialect the named five do not cover
// cannot regress silently. Structure must match everywhere; a stale name is
// counted, not failed.
{
  const stems = fs
    .readdirSync(SGDAT)
    .filter((f) => /\.ipo$/i.test(f))
    .map((f) => f.replace(/\.[^.]*$/, ''));
  const seen = new Set();
  let compared = 0;
  let identical = 0;
  let staleName = 0;
  const bad = [];
  for (const stem of stems) {
    if (seen.has(stem.toLowerCase())) continue;
    seen.add(stem.toLowerCase());
    const ref = reference(stem);
    if (!ref || !ref.procs) continue;
    let got;
    try {
      got = F.ipofDecodeExec(new Uint8Array(fs.readFileSync(ipoPath(stem))), stem);
    } catch (e) {
      // the Python writes an empty dump for a file with no declarations; the
      // reader says so instead, which is the better answer for a drop zone
      if (!Object.keys(ref.procs).length) continue;
      bad.push(`${stem}: ${e.message}`);
      continue;
    }
    compared += 1;
    if (JSON.stringify(got.procs) === JSON.stringify(ref.procs)
        && JSON.stringify(got.byid) === JSON.stringify(ref.byid)) {
      identical += 1;
    } else if (
      JSON.stringify(withoutCallNames(got.procs)) === JSON.stringify(withoutCallNames(ref.procs))
      && JSON.stringify(got.byid) === JSON.stringify(ref.byid)
    ) {
      staleName += 1;
    } else {
      bad.push(stem);
    }
  }
  assert.deepStrictEqual(bad, [], `files whose tokens differ: ${bad.slice(0, 8).join(', ')}`);
  assert.ok(compared > 500, `too few files compared (${compared})`);
  ok(`corpus: ${identical}/${compared} byte-identical, ${staleName} stale-named, 0 differing`);
}

console.log(`test_ipofile: ${passed} checks passed`);
