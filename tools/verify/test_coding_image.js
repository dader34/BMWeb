#!/usr/bin/env node
// How the coding screens know what a module is set to: from the module's
// coding image, by address -- and nothing else.
//
// The screens' own code runs here (screens/coding/*.js, loaded the way the
// page loads them), on BMW's own tables, with the car replaced by the
// simulated cluster of test_coding_dispatch.js behind the late cluster's real
// coding SGBD (KOMBI46R) and BMW's coding scripts for it.
//
// WHAT THIS PROVES
//   1. A function's value is its bytes in address order, each under its own
//      mask (the form BMW's files write an option in), and writing a value in
//      that form is the exact inverse -- for every function of the cluster.
//   2. An unread function is unknown: no value, no marked option, nothing to
//      pick. Nothing is matched by name and nothing is made up.
//   3. Where a module is read from comes from BMW's tables: the coding file
//      by the module's index (its digits are the file: 34 is LSZ.C34), the coding SGBD
//      and script from the selection table's row, the script's file from the
//      script index. The late E46 cluster is KOMBI46R, coded by A_KMB46 or
//      A_AKMB46 depending on how the car is coded.
//   4. The scan reads the image through the script, the tree shows it, a
//      staged option is written back the same way and proved, and a module
//      that cannot be written that way says why instead.
//
//   node tools/verify/test_coding_image.js
//
// Needs the generated data (data/ecu-src, app/renderer/data); says so and
// skips when it is not on disk.

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
  'data/ecu-src/kombi46r.job-code.json.gz',
  'app/renderer/data/coding-dispatch/scripts.json',
  'app/renderer/data/coding-dispatch/a_kmb46.json',
  'app/renderer/data/coding-dispatch/c_kmb46.json',
  'app/renderer/data/datenmap.js',
  'app/renderer/data/sget.js',
  'app/renderer/data/tables.js',
];
const missing = need.filter((f) => !fs.existsSync(path.join(ROOT, f)));
if (missing.length) {
  console.log(`  skip  generated data not on disk (${missing.join(', ')})`);
  process.exit(0);
}

// ---- the page, without a browser ----------------------------------------------
const E = require(R('core/coding/encode.js'));
require(R('core/coding/dispatch.js'));
const W = require(R('core/coding/write.js'));
const { loadBestvm } = require('./load_bestvm.js');
const vmCtx = { module: { exports: {} }, console };
vm.createContext(vmCtx);
const { Best2Vm } = loadBestvm(vmCtx);
const gz = (f) =>
  JSON.parse(
    zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'data/ecu-src', f)))
  );

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
page.BMW_CODING_MAP = {
  kombi46: { read: 'CODIERDATEN_LESEN', fields: [], sgbd: 'kombi46' },
};
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
  'screens/coding/ncs-slots.js',
])
  load(f);
// NCS's coding files under their own names (daten_files.py)
const DATEN46 = JSON.parse(
  fs.readFileSync(R('data/daten/E46.json'), 'utf8')
).modules;
// the cluster's coding file, registered the way the scan registers a module
// it found (sections 1-2 work on it directly)
page.codingRegisterFile('kombi46', DATEN46.KMB_E46);

// ---- the car: a simulated late cluster ------------------------------------------
function cluster(mem, o = {}) {
  const log = [];
  const ds2 = (body) => {
    const f = [0x80, body.length + 3, ...body];
    let x = 0;
    for (const b of f) x ^= b;
    return [...f, x];
  };
  const word = (out) => ((out[5] << 8) | out[6]) * 2;
  return {
    log,
    exchange: async (out) => {
      log.push(Array.from(out));
      const cmd = out[2];
      if (cmd === 0x00)
        return ds2([
          0xa0,
          0x06,
          0x90,
          0x12,
          0x34,
          0x22,
          o.index ?? 8,
          0x10,
          0x20,
          0x30,
          0x03,
          0x04,
          0x41,
          0x31,
          0x32,
          0x05,
          0,
          0,
          0,
          0,
          0,
        ]);
      if (cmd === 0x02)
        return ds2([0xa0, 0x4e, 0x4a, 0x87, 0x37, 0x90, 0x0c, 0, 0]);
      if (cmd === 0x06)
        return ds2([0xa0, ...mem.slice(word(out), word(out) + out[7] * 2)]);
      if (cmd === 0x07) {
        for (let i = 0; i < out[7] * 2; i++) mem[word(out) + i] = out[8 + i];
        return ds2([0xa0]);
      }
      return ds2([0xa0]);
    },
  };
}
const realPath =
  process.env.KMB_EEPROM ||
  path.join(
    process.env.HOME || '',
    'Desktop/e46bins/KOMBI-cluster/kombi46-EEPROM_LESEN-tuned.bin'
  );
const haveReal = fs.existsSync(realPath);
const freshMem = () => {
  const mem = new Uint8Array(1024);
  for (let i = 0; i < mem.length; i++) mem[i] = (i * 37 + 11) & 0xff;
  if (haveReal) mem.set(fs.readFileSync(realPath).subarray(0, 1024));
  return mem;
};

(async () => {
  // ---- 1. the byte-domain view of a function --------------------------------------
  console.log("\na function's value, as its options are written");
  {
    const fns = await page.moduleFunctions('E46', 'kombi46', 8);
    ok(
      fns.codingIsResolved && String(fns.codingVariants) === 'C08',
      "coding index 8 selects the cluster's C08 description"
    );
    const mem = freshMem();
    let round = 0;
    let bad = 0;
    for (const f of fns) {
      const hex = E.fieldHex(f, mem);
      if (hex == null) continue;
      const copy = Uint8Array.from(mem);
      E.encodeFieldHex(f, hex, copy);
      round++;
      if (copy.some((b, i) => b !== mem[i])) bad++;
    }
    ok(
      round > 150 && bad === 0,
      `writing back the value just read changes nothing, for all ${round} functions`
    );
    const weg = fns.find((f) => f.name === 'K_ZAHL_WEG');
    const img = new Uint8Array(1024);
    E.encodeFieldHex(weg, '1330', img);
    ok(
      weg.word === 0x80 && img[0x80] === 0x13 && img[0x81] === 0x30,
      'a two-byte option goes in as written: 13 at 0x80, 30 at 0x81'
    );
    ok(E.fieldHex(weg, img) === '1330', 'and reads back as the same text');
    const bit = fns.find((f) => f.name === 'TEMPERATUR_EINHEIT');
    const one = new Uint8Array(1024).fill(0xff);
    E.encodeFieldHex(bit, '00', one);
    ok(
      one[bit.word] === (0xff & ~bit.mask) && E.fieldHex(bit, one) === '00',
      'a one-bit function touches its bit and nothing beside it'
    );
    let threw = 0;
    for (const badHex of ['02', '0000', 'zz'])
      try {
        E.encodeFieldHex(bit, badHex, new Uint8Array(1024));
      } catch {
        threw++;
      }
    ok(
      threw === 3,
      'a value that does not fit the mask or the width is refused'
    );
    if (haveReal) {
      const named = (name) => {
        const f = fns.find((x) => x.name === name);
        const hex = E.fieldHex(f, mem);
        const hit = (f.values || []).find(([, v]) => v.toLowerCase() === hex);
        return hit ? hit[0] : `0x${hex}`;
      };
      ok(
        named('K_ZAHL_WEG') === '4912_imp/km' &&
          named('K_ZAHL_TACHO') === '4961_imp/km' &&
          named('SPRACHE') === 'us' &&
          named('MOTOR_ART') === 'benziner' &&
          named('LL/RL') === 'linkslenker',
        `the real cluster read decodes by address: ${named('SPRACHE')}, ${named('MOTOR_ART')}, ${named('LL/RL')}, ${named('K_ZAHL_WEG')}`
      );
    } else console.log('  skip  the real cluster read is not on disk');
  }

  // ---- 2. unread is unknown -----------------------------------------------------------
  console.log('\nwhat was not read');
  {
    const fns = await page.moduleFunctions('E46', 'kombi46', 8);
    const f = fns.find((x) => x.name === 'TEMPERATUR_EINHEIT');
    const bytes = freshMem();
    ok(page.codingImageValue(f, null) === null, 'no image: no value');
    ok(
      page.codingImageValue(f, {
        bytes,
        known: new Set([0x70]),
        block: null,
      }) === null,
      'an address that was not read: no value'
    );
    ok(
      page.codingImageValue(f, { bytes, known: null, block: 1 }) === null,
      "another block's bytes: no value"
    );
    ok(
      page.codingImageValue(f, {
        bytes: bytes.subarray(0, 0x40),
        known: null,
        block: null,
      }) === null,
      'an image that ends before the function: no value'
    );
    ok(
      page.codingImageValue(f, {
        bytes,
        known: new Set([0x71]),
        block: null,
      }) === E.fieldHex(f, bytes),
      'the address read: the value at it'
    );
    const state = new Map();
    page.seedState(state, 'kombi46', fns, null);
    const all = [...state.values()];
    ok(
      all.length > 100 &&
        all.every((s) => s.current === null && s.staged === null),
      `with nothing read, every one of ${all.length} functions is unknown -- none is given a value`
    );
    const html = page.treeValues(
      f.values,
      (n) => n,
      'kombi46:TEMPERATUR_EINHEIT',
      state,
      f
    );
    ok(
      /not read from the car/.test(html) &&
        !/tree-opt-cur/.test(html) &&
        !/<button/.test(html),
      'an unknown function shows its options for reference: none marked, none pickable'
    );
    const src = fs
      .readdirSync(R('screens/coding'))
      .map((n) => fs.readFileSync(R('screens/coding', n), 'utf8'))
      .join('\n');
    ok(
      !/codMatchRead|treeMatchRead|codReadDaten/.test(src),
      'no name matcher and no second decoder is left in the coding screens'
    );
  }

  // ---- 3. where a module is read from ---------------------------------------------------
  // NCS's procedure (scanCoding over ncs-slots.js): only the cluster answers
  // here, through its coding SGBD C_KMB46, with the index the case sets.
  console.log('\nwhere a module is read from');
  const S = page.CodingSelect;
  const stamps = [3, 4, 5, 6, 7, 8].map((n) => `KMBI_CI_0${n}`);
  const realReadImage = page.codingReadImage;
  const realReadJob = page.webCodingReadJob;
  page.api = async (url) => {
    throw new Error(`no answer (${url})`);
  };
  const scanAt = async (index, equipment) => {
    page.webCodingReadJob = async (sgbd, o) =>
      sgbd === 'c_kmb46' && o.jobname === 'CODIERINDEX_LESEN'
        ? { ok: true, pars: { CODIERINDEX: index }, info: '' }
        : { ok: false, pars: {}, info: 'no answer' };
    page.codingReadImage = async () => null;
    const codes = [];
    if (equipment) {
      // what the car's equipment is read from: an order (here only its time
      // criterion) and/or keywords given by hand
      Object.defineProperty(codes, 'car', {
        value: {
          fa: equipment.time ? { date: equipment.time } : null,
          keywords: equipment.keywords,
        },
      });
      codes.push('0');
    }
    const scan = await page.scanCoding('E46', { innerHTML: '' }, codes);
    page.codingReadImage = realReadImage;
    page.webCodingReadJob = realReadJob;
    const m = scan.mods[0];
    return { scan, m, src: m && scan.sources.get(m.sgbd) };
  };
  {
    let r = await scanAt('08');
    ok(
      r.scan.mods.length === 1 &&
        r.m.file === 'KMB_E46.C08' &&
        r.src.sgbd === 'kombi46r',
      `one module answers: the cluster on KMB_E46.C08, coded on KOMBI46R as the selection table says (${r.m && r.m.label})`
    );
    ok(
      r.src.decided === false &&
        r.src.choices
          .map((c) => c.script)
          .sort()
          .join() === 'A_AKMB46,A_KMB46',
      "with the car's equipment unknown, both of its scripts are offered and none is assumed"
    );
    r = await scanAt('08', { keywords: stamps });
    ok(
      r.src.script === 'A_KMB46' &&
        r.src.dispatchKey === 'a_kmb46' &&
        r.src.decided,
      'a car coded by its central key: A_KMB46, from its own file'
    );
    r = await scanAt('08', { keywords: ['PU01', ...stamps] });
    ok(
      r.src.script === 'A_AKMB46' &&
        r.src.dispatchKey === 'c_kmb46' &&
        r.src.decided,
      'a car coded by its vehicle order: A_AKMB46'
    );
    for (const key of ['a_kmb46', 'c_kmb46']) {
      const d = await page.webFetchJson(`data/coding-dispatch/${key}.json`);
      ok(
        d && d.coding && d.ecu === (key === 'a_kmb46' ? 'A_KMB46' : 'A_AKMB46'),
        `${key}.json holds the script the index says it does (${d && d.ecu})`
      );
    }
    // a car coded by its vehicle order carries no stamps of its own: they
    // come from the order table's row for the order's time criterion
    const at = page.BMW_TABLES.E46.at;
    ok(
      at.time['0904'].includes('PU01') &&
        at.time['0904'].includes('KMBI_CI_08') &&
        at.time['0904'].includes('LSZ_CI_35'),
      "the order table's row for 09/04 carries the order-coding marker and the revision stamps (its continuation lines too)"
    );
    r = await scanAt('08', { keywords: [], time: '#0904' });
    ok(
      r.src.script === 'A_AKMB46' && r.src.decided,
      'so an order of 09/04 settles the script by itself: A_AKMB46'
    );
    ok(
      S.resolveSlot('E46', 'AKMB', S.aswIds('E46', [], [], '0904')).file ===
        'KMB_E46.C08' &&
        S.resolveSlot('E46', 'AKMB', S.aswIds('E46', [], [], '#0303')).file ===
          'KMB_E46.C06',
      "and names the cluster's coding file: C08 for 09/04, C06 for 03/03"
    );
    r = await scanAt('06');
    ok(r.src.sgbd === 'c_kmb46', 'an early cluster (index 06) is C_KMB46');
    r = await scanAt('');
    ok(
      !r.scan.mods.length,
      'a module that gives no coding index is not listed'
    );
  }
  {
    // an index of ten or more is the file's extension in HEX
    const lsz = DATEN46.LSZ;
    ok(
      String(page.variantsForCI(lsz, 'E46', 52)) === 'C34' &&
        page.variantHasCI('C34', 52) &&
        !page.variantHasCI('C34', 34),
      'coding index 52 is LSZ.C34'
    );
    // BMW's coding scripts use the result's digits as the file extension
    // (CILesen: ID_COD_INDEX padded to two characters -> CODIERINDEX), so a
    // module answering 34 is on LSZ.C34 -- index 0x34
    const scan = new Map([['lsz', new Map([['ID_COD_INDEX', '34']])]]);
    ok(
      page.codingIndexFromScan(scan, 'lsz') === 52,
      'and a result of 34 is LSZ.C34 (the digits are the file name)'
    );
    scan.get('lsz').set('ID_COD_INDEX', '7');
    ok(
      page.codingIndexFromScan(scan, 'lsz') === 7,
      'a one-digit result is padded, as the scripts do: 7 is C07'
    );
    scan.get('lsz').set('ID_COD_INDEX', '0x34');
    ok(
      page.codingIndexFromScan(scan, 'lsz') === 52,
      'text that says it is hex is hex'
    );
    // (which file, SGBD and script each slot and index resolves to, the
    // light module's numbered blocks included: tools/verify/test_ncs_slots.js)
  }

  // ---- 4. scan, show, stage, write ----------------------------------------------------------
  console.log('\nscan, show, stage, write');
  {
    const mem = freshMem();
    const before = Uint8Array.from(mem);
    const sim = cluster(mem);
    const code = gz('kombi46r.job-code.json.gz');
    let tables = {};
    try {
      tables = gz('kombi46r.tables.json.gz');
    } catch {
      /* an SGBD without tables */
    }
    const calls = [];
    page.webReadCoding = async (sgbd, o) => {
      calls.push(['read', sgbd, o.dispatchKey]);
      return W.readCoding(sgbd, {
        exchange: sim.exchange,
        code,
        tables,
        Best2Vm,
        dispatch: await page.webFetchJson(
          `data/coding-dispatch/${o.dispatchKey}.json`
        ),
        cabd: o.cabd,
        now: new Date(0),
      });
    };
    page.webWriteCoding = async (sgbd, hex, o) => {
      calls.push(['write', sgbd, o.dispatchKey]);
      const dispatch = await page.webFetchJson(
        `data/coding-dispatch/${o.dispatchKey}.json`
      );
      return W.writeCoding(sgbd, hex, {
        confirmed: o.confirmed,
        exchange: sim.exchange,
        code,
        tables,
        jobs: code.jobs,
        Best2Vm,
        dispatch,
        dataOrg: dispatch.dataOrg,
        cabd: o.cabd,
        base: o.base,
        now: new Date(0),
      });
    };
    const backups = [];
    page.saveCodingBackup = (sgbd, hex, meta) =>
      backups.push({ sgbd, hex, meta });
    page.api = async (url) => {
      if (url === '/api/chassis/E46')
        return {
          sections: [
            { name: 'Body', ecus: [{ sgbd: 'kombi46', label: 'Cluster' }] },
          ],
        };
      if (url === '/api/ecu/kombi46/run/CODIERDATEN_LESEN')
        return { sets: [[['JOB_STATUS', 'OKAY']]] };
      if (url === '/api/ecu/kombi46/jobs') return ['IDENT'];
      if (url === '/api/ecu/kombi46/run/IDENT')
        return { sets: [[['ID_COD_INDEX', 8]]] };
      throw new Error(`unexpected ${url}`);
    };
    // the car's equipment, as the identity read hands it over
    const saCodes = [];
    Object.defineProperty(saCodes, 'car', { value: { keywords: stamps } });
    saCodes.push('0');
    page.webCodingReadJob = async (sgbd, o) =>
      sgbd === 'c_kmb46' && o.jobname === 'CODIERINDEX_LESEN'
        ? { ok: true, pars: { CODIERINDEX: '08' }, info: '' }
        : { ok: false, pars: {}, info: 'no answer' };
    const scan = await page.scanCoding('E46', { innerHTML: '' }, saCodes);
    // the scan's own key for the module it found (the slot, "kmb")
    const K = scan.mods[0].sgbd;
    const image = scan.images.get(K);
    const source = scan.sources.get(K);
    ok(
      source.sgbd === 'kombi46r' &&
        source.script === 'A_KMB46' &&
        source.decided,
      "the scan settles the source from the car's equipment: KOMBI46R, A_KMB46"
    );
    ok(
      image &&
        image.route === 'script' &&
        image.bytes.every((b, i) => !image.known.has(i) || b === mem[i]),
      `the scan read the image through the script (${image && image.known.size} bytes)`
    );
    ok(
      scan.status.get(K).state === 'ok' && !sim.log.some((t) => t[2] === 0x07),
      'the module counts as read, and reading wrote nothing'
    );

    const fns = await page.moduleFunctions('E46', K, 8);
    const state = new Map();
    page.seedState(state, K, fns, image);
    const key = `${K}:TEMPERATUR_EINHEIT`;
    const f = fns.find((x) => x.name === 'TEMPERATUR_EINHEIT');
    const cur = state.get(key).current;
    ok(
      cur === E.fieldHex(f, mem) && /^0[01]$/.test(cur),
      `the tree's current value is the one at the function's address (0x${cur})`
    );
    const html = page.treeValues(f.values, (n) => n, key, state, f);
    const marked = /data-v="(\w+)"[^>]*>(?:(?!<\/button>).)*tree-opt-cur/s.exec(
      html
    );
    ok(
      marked &&
        marked[1] === cur &&
        (html.match(/<button/g) || []).length === 2,
      'that option is the one marked current, and both can be picked'
    );
    const unread = [...state.values()].filter((s) => s.current == null).length;
    ok(
      page.treeReadNote(state, { sgbd: K, fns, source }) === '' && unread === 0,
      'every choosable function of the module was read'
    );

    // stage the other option and write it
    const other = cur === '01' ? '00' : '01';
    state.get(key).staged = other;
    const mod = {
      sgbd: K,
      label: 'Cluster',
      fns,
      chassisId: 'E46',
      source,
    };
    const edits = page.treeStagedEdits([mod], state).get(K);
    ok(
      edits.length === 1 &&
        edits[0].hex === other &&
        edits[0].value === undefined,
      "the staged edit carries the option's bytes, not a number"
    );
    calls.length = 0;
    const res = await page.treeWriteModule(mod, edits, state);
    ok(
      res.ok && res.backup,
      `the write is done and backed up (${res.err || 'ok'})`
    );
    ok(
      String(calls.map((c) => c.join(' '))) ===
        'read kombi46r a_kmb46,write kombi46r a_kmb46',
      'read again first, then written, both on KOMBI46R through A_KMB46'
    );
    const diff = [];
    for (let i = 0; i < mem.length; i++) if (mem[i] !== before[i]) diff.push(i);
    ok(
      String(diff) === String([f.word, 0x16e]) && E.fieldHex(f, mem) === other,
      'the cluster changed at that function and the checksum, nowhere else'
    );
    ok(
      state.get(key).current === other && state.get(key).staged === null,
      'and the tree now shows the new value as current'
    );
    ok(
      backups.length === 1 &&
        backups[0].hex.length === 2048 &&
        /KOMBI46R via A_KMB46/i.test(backups[0].meta.note),
      'the backup holds the image as it was, and says which way it was read'
    );

    // the whole extent was read, block ranges included
    const extent = new Set();
    for (const g of source.cabd.groups)
      for (let a = g.start; a < g.start + g.length; a++) extent.add(a);
    for (const x of source.cabd.fields)
      for (let a = x.word; a < x.word + x.byte; a++) extent.add(a);
    ok(
      image.known.size === extent.size &&
        [...extent].every((a) => image.known.has(a)) &&
        source.cabd.groups.some((g) => g.kind === 'reserved'),
      `the image covers every function and every named block, the manufacturer and reserved ones too (${image.known.size} bytes)`
    );
    // not coding data: shown, not offered, and refused if it is edited anyway
    const lockedFn = fns.find(
      (x) => fns.codingLocked.has(x.name) && state.has(`${K}:${x.name}`)
    );
    const lkey = `${K}:${lockedFn.name}`;
    const lhtml = page.treeValues(
      lockedFn.values,
      (n) => n,
      lkey,
      state,
      lockedFn
    );
    ok(
      state.get(lkey).locked &&
        /not coding\s+data/.test(lhtml) &&
        !/<button/.test(lhtml),
      `a function in a manufacturer or reserved block (${lockedFn.name}) shows what the car holds and offers nothing to pick`
    );
    ok(!state.get(key).locked, 'a function in a coding block is not locked');
    {
      const cur2 = state.get(lkey).current;
      const flipped = (parseInt(cur2.slice(0, 2), 16) ^ 1)
        .toString(16)
        .padStart(2, '0');
      const writesBefore = sim.log.filter((t) => t[2] === 0x07).length;
      const r = await page.treeWriteModule(
        mod,
        [
          {
            rule: { ...lockedFn, mask: 0xff, shift: 0, masks: undefined },
            hex: flipped + cur2.slice(2),
          },
        ],
        new Map()
      );
      ok(
        !r.ok &&
          /is not coding data/.test(r.err) &&
          sim.log.filter((t) => t[2] === 0x07).length === writesBefore,
        `and an edit there is refused before anything is written (${(r.err || '').slice(0, 80)})`
      );
    }

    // WHICH MODULE IS FITTED. The bus names the late cluster kombi46r while
    // its map is filed under kombi46 ("unbuilt"). That used to refuse every
    // write. When the selection table's coding SGBD is that same variant,
    // the two agree and the write goes ahead; otherwise it is still refused.
    {
      const back = [{ rule: f, hex: cur }];
      const viaBus = {
        ...mod,
        group: 'D_0080',
        _codingVariant: 'unbuilt',
        _variantVia: 'kombi46r',
      };
      let r = await page.treeWriteModule(viaBus, back, new Map());
      ok(
        r.ok && E.fieldHex(f, mem) === cur,
        `the bus says kombi46r, the selection table says KOMBI46R: written (${r.err || 'ok'})`
      );
      const w0 = sim.log.filter((t) => t[2] === 0x07).length;
      r = await page.treeWriteModule(
        { ...viaBus, _variantVia: 'kombi46' },
        [{ rule: f, hex: other }],
        new Map()
      );
      ok(
        !r.ok &&
          /car named kombi46, but its coding is selected for kombi46r/.test(
            r.err
          ) &&
          sim.log.filter((t) => t[2] === 0x07).length === w0,
        'the bus naming a different variant than the table is refused, unsent'
      );
      r = await page.treeWriteModule(
        { ...mod, group: 'D_0080', _codingVariant: 'unverified' },
        [{ rule: f, hex: other }],
        new Map()
      );
      ok(
        !r.ok &&
          /Reconnect and re-read/.test(r.err) &&
          sim.log.filter((t) => t[2] === 0x07).length === w0,
        'and so is a module whose address group did not identify itself'
      );
    }

    // a module that cannot be written this way says why
    const blob = await page.treeWriteModule(
      { ...mod, source: { route: 'blob' } },
      edits,
      state
    );
    ok(
      !blob.ok && /numbers its coding blocks/.test(blob.err),
      'a block-numbered module is not written'
    );
    const open = await page.treeWriteModule(
      { ...mod, source: { ...source, decided: false } },
      edits,
      state
    );
    ok(
      !open.ok && /which of the two coding scripts/.test(open.err),
      'nor one whose script is not settled'
    );
    const noSrc = await page.treeWriteModule(
      {
        ...mod,
        source: { route: null, why: 'its coding script A_X is not shipped' },
      },
      edits,
      state
    );
    ok(
      !noSrc.ok && /A_X is not shipped/.test(noSrc.err),
      'nor one with no source, and the reason is passed on'
    );
  }

  console.log(`\ncoding image: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
