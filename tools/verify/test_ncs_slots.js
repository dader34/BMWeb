#!/usr/bin/env node
// NCS Expert's way to a module's coding (screens/coding/ncs-slots.js), with
// no names matched: the chassis's module list (SGFAM), the coding index read
// through the slot's coding SGBD, the selection table (SGET) for the coding
// file, SGBD and script, then the coding file under the name SGET gives it.
//
// WHAT THIS PROVES
//   1. Every E46 slot NCS can code resolves, for every coding index the
//      selection table lists for it, to a shipped coding file with a layout,
//      the coding SGBD and the coding script SGET names -- no SGBD-name
//      matching anywhere.
//   2. The cases met on a real 2005 325i: GM5 index 05 is GM5.C05 on
//      ZKE5_S12; the climate module's 17 is IHK_E46.C17 on C_IHK; the
//      light module's 34 is LSZ.C34 on C_LSZA (ALSZ slot).
//   3. A coding index the selection table does not list is refused the way
//      NCS refuses it ("CBD nicht in SGET vorhanden").
//   4. The block-addressing proof (core/coding/write.js) asked of the jobs
//      themselves: the LSZ's and the GM5's two-block SGBDs pass, C_GM5 (its
//      write divides the address by 20) does not.
//
//   node tools/verify/test_ncs_slots.js

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
  'app/renderer/data/daten/E46.json',
  'app/renderer/data/sget.js',
  'app/renderer/data/tables.js',
];
if (need.some((f) => !fs.existsSync(path.join(ROOT, f)))) {
  console.log('  skip  generated data not on disk');
  process.exit(0);
}

const page = { console, setTimeout, Promise, Map, Set, Uint8Array, Array };
page.window = page;
vm.createContext(page);
const load = (rel) =>
  vm.runInContext(fs.readFileSync(R(rel), 'utf8'), page, { filename: rel });
for (const data of ['data/sget.js', 'data/tables.js']) load(data);
page.CodingEncode = require(R('core/coding/encode.js'));
vm.runInContext('var root = window; var module = undefined;', page);
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
  'screens/coding/scan.js',
  'screens/coding/ncs-slots.js',
])
  load(f);

// the car: the coding index each slot's script reads (set per case), and a
// read that is not under test here
let index = '';
page.webCodingReadJob = async (sgbd, o) => ({
  ok: true,
  pars: o.jobname === 'CODIERINDEX_LESEN' ? { CODIERINDEX: index } : {},
  info: '',
});
page.codingReadImage = async () => null;

(async () => {
  console.log('\nevery E46 slot, every coding index its selection rows list');
  const slots = await page.ncsSlots('E46');
  ok(slots.length === 37, `${slots.length} slots in NCS's E46 module list`);
  const rows = page.BMW_SGET.E46.rows || page.BMW_SGET.E46;
  let tried = 0;
  const unresolved = [];
  for (const slot of slots) {
    const cbds = [
      ...new Set(
        rows
          .filter((r) => String(r.UMRSG).toUpperCase() === slot.umrsg)
          .map((r) => String(r.CBD).toUpperCase())
      ),
    ];
    for (const cbd of cbds) {
      index = cbd.slice(1);
      tried++;
      const got = await page.ncsReadSlot('E46', slot);
      const row = rows.find(
        (r) =>
          String(r.UMRSG).toUpperCase() === slot.umrsg &&
          String(r.CBD).toUpperCase() === cbd
      );
      const good =
        got.fns.length > 0 &&
        got.fns.codingIsResolved &&
        got.source.route === 'script' &&
        got.source.sgbd === String(row.SGBD).toLowerCase() &&
        got.source.script === String(row.CABD).toUpperCase() &&
        got.file === String(row.SGNAME).toUpperCase();
      if (!good) unresolved.push(`${slot.umrsg} ${cbd}: ${got.why}`);
    }
  }
  // The one script not shipped: the airbag's A_ZAE2 has no Cod procedure
  // in the shape every other coding script has (coding_dispatch_export.py
  // skips it) -- left out on purpose, and said so.
  const unshipped = unresolved.filter((u) => /A_ZAE2 is not shipped/.test(u));
  const other = unresolved.filter((u) => !unshipped.includes(u));
  ok(
    !other.length,
    `${tried - unresolved.length} of ${tried} slot/index pairs resolve to their coding file, SGBD and script` +
      (other.length ? ` -- not: ${other.join('; ')}` : '')
  );
  ok(
    unshipped.every((u) => u.startsWith('ABG ')),
    `the rest are the airbag (ABG), whose script A_ZAE2 is not shipped (${unshipped.length})`
  );

  console.log('\nthe modules met on a real car');
  const slot = (u) => slots.find((s) => s.umrsg === u);
  const at = async (u, ci) => {
    index = ci;
    return page.ncsReadSlot('E46', slot(u));
  };
  let g = await at('GM5', '05');
  ok(
    g.file === 'GM5' &&
      g.cbd === 'C05' &&
      g.source.sgbd === 'zke5_s12' &&
      g.source.script === 'A_GM5' &&
      g.source.blocked &&
      g.fns.length === 198,
    `GM5 05 -> GM5.C05 on ZKE5_S12 / A_GM5, numbered blocks, ${g.fns.length} functions`
  );
  g = await at('IHK', '17');
  ok(
    g.file === 'IHK_E46' &&
      g.source.sgbd === 'c_ihk' &&
      g.source.script === 'A_IHK46' &&
      g.fns.length === 85,
    `IHK 17 -> IHK_E46.C17 on C_IHK / A_IHK46, ${g.fns.length} functions`
  );
  g = await at('ALSZ', '34');
  ok(
    g.file === 'LSZ' &&
      g.source.sgbd === 'c_lsza' &&
      g.source.script === 'A_ALSZ' &&
      g.fns.length === 310,
    `ALSZ 34 -> LSZ.C34 on C_LSZA / A_ALSZ, ${g.fns.length} functions`
  );
  g = await at('PDC', '01');
  ok(
    g.file === 'PDC' && g.source.script === 'A_PDC' && g.fns.length > 0,
    `PDC 01 -> PDC.C01 / A_PDC, ${g.fns.length} functions (no SGBD of that name needed)`
  );
  g = await at('GM5', '99');
  ok(
    !g.fns.length && /not in the selection table/.test(g.why),
    'an index the selection table does not list is refused, as NCS does'
  );

  console.log('\nblock addressing, asked of the jobs themselves');
  const { loadBestvm } = require('./load_bestvm.js');
  const ctx = { module: { exports: {} }, console };
  vm.createContext(ctx);
  const { Best2Vm } = loadBestvm(ctx);
  const W = require(R('core/coding/write.js'));
  const gz = (f) =>
    JSON.parse(
      zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'data/ecu-src', f)))
    );
  const onWire = (sg, blocks = [0, 1, 2]) => {
    let tables = {};
    try {
      tables = gz(`${sg}.tables.json.gz`);
    } catch {
      /* none */
    }
    return W.blockOnTheWire(
      gz(`${sg}.job-code.json.gz`),
      tables,
      Best2Vm,
      blocks
    );
  };
  ok(
    ['c_lsza', 'c_lsz', 'zke5', 'zke5_s12', 'c_pdc', 'c_mrs3'].every((s) =>
      onWire(s)
    ),
    'C_LSZA, C_LSZ, ZKE5, ZKE5_S12, C_PDC and C_MRS3 put the block on the wire (address byte 0x12)'
  );
  ok(
    onWire('alc_ds2', [0x3000, 0x3001, 0x3010]) &&
      onWire('c_me9_4n', [0x3000, 0x3100]),
    'ALC_DS2 (08 <hi> <lo>) and C_ME9_4N (22 <DID>) tell 16-bit blocks apart'
  );
  ok(
    !onWire('c_me9_4n', [0x3000, 0x3010]),
    'C_ME9_4N drops the low byte of the block (22 30 00 for both 0x3000 and 0x3010), so such a description is refused'
  );
  ok(
    !onWire('c_bit') && !onWire('c_sm') && onWire('c_bit', [0]),
    'C_BIT and C_SM never put a block on the wire -- their descriptions have block 0 only, which passes unasked'
  );
  ok(
    !onWire('c_gm5'),
    'C_GM5 reads the low byte and writes address / 20: GM5.C01 and .C02 are FREI, one 20-byte region at 0, so it is never asked'
  );

  console.log(`\n${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
