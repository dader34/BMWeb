#!/usr/bin/env node
// BMWeb Coding (the NCS Expert recreation): the FSW_PSW round trip.
//
// The NCS helpers (screens/coding/ncs-files.js) are run on real module
// functions, loaded the way the page loads them (like test_coding_image.js).
//
// WHAT THIS PROVES
//   1. FSW_PSW.TRC lists every readable function with the parameter it holds
//      (the DATEN name, or wert_<hex>), in NCS's layout.
//   2. FSW_PSW.MAN parses back to the same function/parameter pairs.
//   3. Editing a parameter in the MAN and running ncsManEdits produces exactly
//      one edit, whose bytes are that parameter's value, and no edit for a line
//      that matches what the module already holds.
//   4. A MAN naming a function the module has not, or a parameter it cannot
//      take, is reported — never written.
//
//   node tools/verify/test_ncs.js
//
// Needs the generated data (data/ecu-src, app/renderer/data); skips when absent.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');
const R = (...p) => path.join(ROOT, 'app/renderer', ...p);

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ok    ${msg}`);
  } else {
    fail++;
    console.error(`  FAIL  ${msg}`);
  }
}

const need = [
  'app/renderer/data/datenmap.js',
  'app/renderer/data/sget.js',
  'app/renderer/data/tables.js',
  'app/renderer/screens/coding/ncs-files.js',
];
const missing = need.filter((f) => !fs.existsSync(path.join(ROOT, f)));
if (missing.length) {
  console.log(`  skip  generated data not on disk (${missing.join(', ')})`);
  process.exit(0);
}

// ---- the page, without a browser (same setup as test_coding_image.js) ---------
const E = require(R('core/coding/encode.js'));

const page = { console, setTimeout, Promise, Map, Set, Uint8Array, Array };
page.window = page;
vm.createContext(page);
const load = (rel) =>
  vm.runInContext(fs.readFileSync(R(rel), 'utf8'), page, { filename: rel });
for (const data of ['data/datenmap.js', 'data/sget.js', 'data/tables.js'])
  load(data);
page.CodingEncode = E;
page.CodingAuftrag = require(R('core/coding/auftrag.js'));
vm.runInContext('var root = window; var module = undefined;', page);
load('core/coding/select.js');
page.esc = (s) => String(s);
page.flatResults = (sets) => (sets || []).flat();
page.loadDatenMap = async () => {};
page.loadCodingMap = async () => {};
page.loadSget = async () => {};
page.loadTables = async () => {};
page.webFetchJson = async (rel) => {
  const p = R(rel);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
};
for (const f of [
  'screens/coding/daten-read.js',
  'screens/coding/functions.js',
  'screens/coding/values.js',
  'screens/coding/review.js',
  'screens/coding/scan.js',
  'screens/coding/write-review.js',
  'screens/coding/vocab.js',
  'screens/coding/ncs-files.js',
  'screens/coding/ncs-dummy.js',
])
  load(f);
// the cluster's coding file, registered the way the scan registers a module
// it found (datenFor answers only from what NCS's procedure picked)
page.codingRegisterFile(
  'kombi46',
  JSON.parse(fs.readFileSync(R('data/daten/E46.json'), 'utf8')).modules.KMB_E46
);

// A coding image for a module: each function's bytes set to its FIRST option,
// so every function reads a known value (what a real read would hand back).
function imageFor(fns) {
  const bytes = new Uint8Array(512);
  const known = new Set();
  for (const f of fns) {
    if ((f.block || 0) !== 0) continue; // image is block 0, as a read gives
    const opt = (f.values || [])[0];
    if (!opt) continue;
    const at = typeof f.word === 'number' ? f.word : -1;
    const width = typeof f.byte === 'number' && f.byte > 0 ? f.byte : 1;
    if (at < 0 || at + width > bytes.length) continue;
    try {
      E.encodeFieldHex(f, String(opt[1]), bytes);
    } catch {
      continue; // a value that does not fit its mask: not a coding option
    }
    for (let i = 0; i < width; i++) known.add(at + i);
  }
  return { bytes, known, block: 0 };
}

(async () => {
  // The cluster's C08 description is the richest shipped set, and the coding
  // engine's own test uses it, so the round trip is exercised on real data.
  const CHASSIS = 'E46';
  const SGBD = 'kombi46';
  const CI = 8;
  const fns = await page.moduleFunctions(CHASSIS, SGBD, CI);
  ok(fns.length > 50, `${SGBD} C0${CI.toString(16)}: ${fns.length} functions`);

  const image = imageFor(fns);

  // ---- 1. FSW_PSW.TRC ------------------------------------------------------------
  const { text: trc, count } = page.ncsTraceText(fns, image);
  const trcLines = trc.split('\r\n').filter(Boolean);
  ok(count > 50, `TRC lists ${count} functions`);
  ok(
    trcLines.length === count * 2,
    'TRC is two lines per function (FSW, then its PSW)'
  );
  ok(
    trcLines.every((l, i) => (i % 2 === 0 ? !/^\s/.test(l) : /^\s/.test(l))),
    'every FSW is flush left and every PSW is indented'
  );

  // ---- 2. MAN parses back to the same pairs -------------------------------------
  const pairs = page.ncsParseMan(trc);
  ok(pairs.length === count, 'MAN parses to the same number of pairs');
  {
    const edits = page.ncsManEdits(fns, image, trc);
    ok(
      edits.edits.length === 0 && edits.unknown.length === 0,
      'the unchanged TRC, used as a MAN, makes no edits and no warnings'
    );
  }

  // ---- 3. editing one parameter makes exactly one edit --------------------------
  const target = fns.find((f) => (f.values || []).length >= 2);
  ok(!!target, 'found a function with two options to change');
  if (target) {
    const curHex = E.fieldHex(target, image.bytes);
    const other = (target.values || []).find(
      (v) => String(v[1]).toLowerCase() !== String(curHex).toLowerCase()
    );
    const man = `${target.name}\r\n\t${other[0]}\r\n`;
    const { edits, changes, unknown } = page.ncsManEdits(fns, image, man);
    ok(
      edits.length === 1 && unknown.length === 0,
      `changing ${target.name} to ${other[0]} makes exactly one edit`
    );
    ok(
      edits[0] &&
        String(edits[0].hex).toLowerCase() === String(other[1]).toLowerCase(),
      "the edit's bytes are the chosen parameter's value"
    );
    ok(
      changes[0] && changes[0].to === other[0],
      'the change row names the new parameter'
    );
    // and the edit, applied, reads back as the new parameter
    const after = E.spliceEdits(Uint8Array.from(image.bytes), edits);
    const afterImg = { bytes: after, known: image.known, block: 0 };
    const nowName = page.ncsParamName(target, E.fieldHex(target, after));
    ok(
      nowName === other[0],
      'after applying the edit, the function reads as the new parameter'
    );
    // belt and braces: everything else is unchanged
    const otherChanged = fns.some(
      (f) =>
        f.name !== target.name &&
        page.ncsParamName(f, page.codingImageValue(f, image)) !==
          page.ncsParamName(f, page.codingImageValue(f, afterImg))
    );
    ok(!otherChanged, 'no other function changed');
  }

  // ---- 4. a MAN that names what the module has not ------------------------------
  {
    const man =
      'NO_SUCH_FUNCTION\r\n\taktiv\r\n' +
      `${target.name}\r\n\tnot_a_real_parameter\r\n`;
    const { edits, unknown } = page.ncsManEdits(fns, image, man);
    ok(
      edits.length === 0 && unknown.length === 2,
      'an unknown function and an unknown parameter are both reported, nothing written'
    );
  }

  // ---- 5. the trace editor (NCS Dummy's half) -----------------------------------
  {
    const { rows, unknown } = page.ncsDummyRows(fns, trc);
    ok(
      rows.length === count && unknown.length === 0,
      `the trace editor shows every traced function (${rows.length})`
    );
    const english = rows.filter((r) => r.label).length;
    ok(
      english > rows.length / 2,
      `most have an English name (${english} of ${rows.length})`
    );
    const r = rows.find((x) => x.options.length >= 2);
    const other = r.options.find(
      (o) => o.name.toLowerCase() !== r.psw.toLowerCase()
    );
    const none = page.ncsDummyMan(rows, new Map());
    ok(none.count === 0 && none.text === '', 'no picks make an empty MAN');
    const man = page.ncsDummyMan(
      rows,
      new Map([
        [r.fsw, other.name],
        [rows[0].fsw, rows[0].psw],
      ])
    );
    ok(
      man.count === 1 && man.text === `${r.fsw}\r\n\t${other.name}\r\n`,
      'a pick becomes one MAN entry; a pick of what it holds, none'
    );
    const { edits } = page.ncsManEdits(fns, image, man.text);
    ok(
      edits.length === 1 && edits[0].rule.name === r.fsw,
      'and that MAN is exactly one edit on the write path'
    );
  }
  // a trace from disk: the coding file is found from its function names
  {
    const daten = JSON.parse(fs.readFileSync(R('data/daten/E46.json'), 'utf8'))
      .modules.LSZ;
    const lszFns = await page.moduleFunctions('E46', 'lsz', 0x34, null, daten);
    const lszTrc =
      lszFns
        .filter((f) => (f.values || []).length)
        .map((f) => `${f.name}\r\n\t${f.values[0][0]}`)
        .join('\r\n') + '\r\n';
    const v = page.ncsDummyVariant(daten, 'E46', lszTrc);
    ok(
      v && v.key.split('+').includes('C34') && v.ci === 0x34,
      `an LSZ trace is matched to its coding file (${v && v.key}, index ${v && v.ci})`
    );
    const { rows } = page.ncsDummyRows(lszFns, lszTrc);
    const kalt = rows.find((x) => x.fsw === 'KALTUEBERWACHUNG_BL_MI');
    ok(
      kalt &&
        /brake light/i.test(kalt.label) &&
        kalt.options.some((o) => /enabled/i.test(o.label)),
      `functions and options read in English (${kalt && kalt.label})`
    );
  }

  console.log(`\n${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
