// The identity screen, end to end, against a stubbed E46 that answers the
// way the real 2004 325i did.
//
// Everything below the screen is real: the shipped job tables decide which
// job is read for what, the shipped fa SGBD decodes the packed order in
// bestvm, the chassis tables name the options. Only the wire is replaced --
// api() answers each job with what the car answered, and the rendered HTML
// is what gets checked. That is the layer the unit tests cannot see: the
// bug report was three columns of garbage FROM correct parts, because the
// parts were glued together wrong.
//
//   node tools/verify/test_identity_screen.js
//   V=1 node tools/verify/test_identity_screen.js   (prints the tables)

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');
const R = (p) => path.join(ROOT, 'app', 'renderer', p);

let passed = 0;
const ok = (what) => {
  passed++;
  if (process.env.V) console.log('  ok', what);
};

// ---- the browser globals the screen leans on -------------------------------

global.window = global;

// A DOM just wide enough for the screen: elements with innerHTML, children,
// textContent. Setting innerHTML replaces the children, as it does for real.
class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.className = '';
    this._html = '';
    this.children = [];
    this.textContent = '';
  }
  get innerHTML() {
    return this._html + this.children.map((c) => c.outerHTML).join('');
  }
  set innerHTML(v) {
    this._html = String(v);
    this.children = [];
  }
  get outerHTML() {
    const cls = this.className ? ` class="${this.className}"` : '';
    return `<${this.tagName.toLowerCase()}${cls}>${this.innerHTML}</${this.tagName.toLowerCase()}>`;
  }
  appendChild(c) {
    this.children.push(c);
    return c;
  }
}
global.document = { createElement: (t) => new El(t) };
global.view = new El('main');
global.sbLeft = new El('span');
global.lastScreen = null;
global.setCrumbs = () => {};
global.setActions = () => {};
global.showChassis = () => {};
global.showSections = () => {};

// The same helpers the renderer defines in core.js. Kept literal rather than
// lifted so a rewording there cannot break this test; they are three lines.
global.esc = (s) =>
  String(s == null ? '' : s).replace(
    /[&<>"]/g,
    (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]
  );
global.dispChassis = (id) => id;
global.head = (eyebrow, title) => `<h1>${esc(eyebrow)} ${esc(title)}</h1>`;
global.errorBlock = (t) => `<div class="err">${esc(t)}</div>`;
const isSystemSet = (s) =>
  s &&
  typeof s === 'object' &&
  ('SAETZE' in s || 'JOBNAME' in s || 'OBJECT' in s);
global.flatResults = (sets) => {
  const list = sets || [];
  const data = list.length && isSystemSet(list[0]) ? list.slice(1) : list;
  const out = [];
  for (const s of data) {
    for (const [k, v] of Object.entries(s)) {
      if (!k.startsWith('_') && k !== 'JOB_STATUS') out.push([k, v]);
    }
  }
  return out;
};

// tables.js / sanames.js are lazily loaded scripts in the app; here they are
// simply present.
eval(fs.readFileSync(R('data/tables.js'), 'utf8'));
eval(fs.readFileSync(R('data/sanames.js'), 'utf8'));
assert.ok(window.BMW_TABLES && window.BMW_SA_NAMES);
global.loadTables = async () => window.BMW_TABLES;
global.loadSaNames = async () => window.BMW_SA_NAMES;

const bestvm = require(R('core/bestvm.js'));
const { Best2Vm } = bestvm;
global.isWriteJob = bestvm.isWriteJob;
global.CodingEncode = require(R('core/coding-encode.js'));
global.CodingZcs = require(R('core/coding-zcs.js'));
global.VehicleIdentity = require(R('core/vehicle-identity/index.js'));

// ---- the car ---------------------------------------------------------------

const rd = (f) =>
  JSON.parse(
    zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'data', 'ecu-src', f)))
  );
const metaCache = new Map();
function meta(sgbd) {
  const k = String(sgbd).toLowerCase();
  if (!metaCache.has(k)) {
    let m;
    try {
      m = rd(`${k}.meta.json.gz`);
    } catch (e) {
      m = null;
    }
    metaCache.set(k, m);
  }
  return metaCache.get(k);
}

// The packed order both coding modules returned, byte for byte (see
// test_fa_stream.js, which pins its decode).
const STREAM_HEX =
  '02 41 94 14 95 45 bf 97 44 d7 41 35 54 ad 4c f7 41 04 10 41 04 10 41 04 ' +
  '10 41 04 10 41 04 10 42 11 8e 14 90 55 24 50 49 44 12 51 94 97 65 35 54 ' +
  '51 04 d4 45 15 13 45 44 d8 51 44 54 55 95 17 4d 46 18 51 95 14 65 55 52 ' +
  '41 54 91 55 35 15 55 05 93 65 65 15 59 54 16 59 15 97 59 66 52 61 16 18 ' +
  '49 36 13 49 85 15 61 54 d8 5d 66 52 55 94 96 65 94 8c 59 34 ec';
const STREAM = STREAM_HEX.split(/\s+/).map((h) => parseInt(h, 16));
assert.strictEqual(STREAM.length, 117);
// The string form a BEST/2 `ergs` publishes: CP1252 text of the bytes.
const STREAM_TXT = Best2Vm.bytesStr(STREAM);

const FA_SAS = [
  '1CA',
  '205',
  '210',
  '240',
  '249',
  '279',
  '354',
  '403',
  '411',
  '431',
  '438',
  '441',
  '459',
  '473',
  '488',
  '494',
  '495',
  '520',
  '521',
  '534',
  '550',
  '639',
  '645',
  '650',
  '661',
  '676',
  '692',
  '818',
  '823',
  '832',
  '845',
  '853',
  '876',
  '925',
  '926',
  '992',
];

// EWS KD block 0: bytes 2..4 little-endian km = 372346 (0x05AE7A).
const KD0 = [0x00, 0x00, 0x7a, 0xae, 0x05, 0x00, 0x00, 0x00];
assert.strictEqual(KD0[2] | (KD0[3] << 8) | (KD0[4] << 16), 372346);

// The fa decoder runs for real: shipped bytecode, shipped tables, no wire.
const faCode = rd('fa.job-code.json.gz');
let faTables = {};
try {
  faTables = rd('fa.tables.json.gz');
} catch (e) {
  /* the decoder needs no tables beyond its own */
}
function runFa(job, arg) {
  const vm = new Best2Vm(faCode, {
    tables: faTables,
    args: arg,
    allowWrites: true,
    send: () => {
      throw new Error('FA.PRG must not touch the wire');
    },
  });
  return vm.run(job);
}

// What each module answered. A job not listed here is one the screen had no
// business running against this car, and the call log shows it.
const ANSWERS = {
  c_kmb46: {
    C_FA_LESEN: {
      FAHRZEUGAUFTRAG: STREAM_TXT,
      SPEICHER_STATUS: 'OK',
      JOB_STATUS: 'OKAY',
    },
    C_ZCS_LESEN: {
      JOB_STATUS: 'OKAY',
      GM: 'FFFFFFFF',
      SA: 'FFFFFFA8EF020F05',
      VN: '84493B004E',
    },
    C_FG_LESEN: { JOB_STATUS: 'OKAY', FG_NR: 'NJ87379' },
    AIF_GWSZ_LESEN: {
      JOB_STATUS: 'OKAY',
      STAT_GWSZ_WERT: 372358,
      STAT_GWSZ_EINH: 'km',
    },
  },
  c_lsza: {
    C_FA_LESEN: {
      FAHRZEUGAUFTRAG: STREAM_TXT,
      SPEICHER_STATUS: 'OK',
      JOB_STATUS: 'OKAY',
    },
    C_FG_LESEN: { JOB_STATUS: 'OKAY', FG_NR: 'NJ87379' },
    // The service-interval read also carries FG_NR (and a 100 km-step
    // distance counter that is NOT the odometer). It must not be what the
    // column is built from.
    SIA_LESEN: {
      JOB_STATUS: 'OKAY',
      FG_NR: 'NJ87379',
      GESAMTWEGSTRECKE_WERT: 3000,
      GESAMTWEGSTRECKE_EINH: 'km',
    },
  },
  c_ews3: {
    // the coding read answers each key WITH its check character
    C_ZCS_LESEN: {
      JOB_STATUS: 'OKAY',
      GM: CodingZcs.formatGm('FFFFFFFF'),
      SA: CodingZcs.formatSa('FFFFFFFFFFFFFFFF'),
      VN: CodingZcs.formatVn('FFFFFFFFFF'),
    },
    C_FG_LESEN: { JOB_STATUS: 'OKAY', FG_NR: 'WBAET37495NJ87379Q' },
  },
  ews: {
    KD_DATEN_LESEN: (arg) =>
      String(arg) === '0'
        ? { JOB_STATUS: 'OKAY', KD_BLOCK: 0, KD_DATEN: KD0 }
        : { JOB_STATUS: 'ERROR_ARGUMENT' },
  },
};

const calls = [];
global.api = async (url, init) => {
  const rel = String(url);
  const [pathPart, query] = rel.split('?');
  const arg = query ? new URLSearchParams(query).get('arg') : null;
  const m = pathPart
    .replace(/^\/api\//, '')
    .split('/')
    .filter(Boolean);
  if (m[0] === 'chassis' && m[1]) {
    return JSON.parse(
      fs.readFileSync(
        path.join(ROOT, 'data', 'chassis-config', `${m[1]}.json`),
        'utf8'
      )
    );
  }
  if (m[0] === 'ecu' && m.length >= 3) {
    const sgbd = m[1].toLowerCase();
    const kind = m[2];
    const mt = meta(sgbd);
    if (!mt) throw new Error(`archive not found: ${sgbd}`);
    if (kind === 'jobs') return Object.keys(mt.jobs);
    if (kind === 'results') {
      const j = mt.jobs[decodeURIComponent(m[3]).toUpperCase()];
      if (!j) throw new Error(`results/${m[3]} not found for ${sgbd}`);
      return j.results.map((r) => `${r.name} : ${r.comment || ''}`);
    }
    if (kind === 'run') {
      const job = decodeURIComponent(m[3]);
      assert.strictEqual((init || {}).method, 'POST', `run ${job} not POSTed`);
      calls.push({ sgbd, job, arg });
      if (sgbd === 'fa') {
        return { job, sets: runFa(job, arg) };
      }
      const table = ANSWERS[sgbd] || {};
      const a = table[job];
      if (!a) throw new Error(`no answer stubbed for ${sgbd}/${job}`);
      const set = typeof a === 'function' ? a(arg) : a;
      return { job, sets: [set] };
    }
  }
  throw new Error(`no route for ${rel}`);
};

// ---- the screen --------------------------------------------------------------

// The screen is split into pieces (screens/vehicle-identity/*.js) that share
// one scope, loaded in the order index.html lists them -- so that order is
// read from index.html and the pieces evaluated as one script, the way the
// bundle concatenates them.
const indexHtml = fs.readFileSync(R('index.html'), 'utf8');
const screenPieces = [
  ...indexHtml.matchAll(/<script src="(screens\/vehicle-identity\/[^"]+)">/g),
].map((m) => m[1]);
assert.ok(screenPieces.length > 1, 'index.html lists no identity pieces');
const screenSrc = screenPieces
  .map((p) => fs.readFileSync(R(p), 'utf8'))
  .join('\n');
eval(screenSrc);
assert.strictEqual(typeof window.showVehicleIdentity, 'function');

// ---- reading the rendered tables back --------------------------------------

const untag = (s) =>
  String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();

// A vi-ncs table as { header: [...], rows: { Label: [cell, ...] }, mismatch }
function readTable(html) {
  const header = [...html.matchAll(/<th>(.*?)<\/th>/g)].map((m) => untag(m[1]));
  const rows = {};
  const mismatch = new Set();
  for (const tr of html.matchAll(/<tr( class="vi-mismatch")?>(.*?)<\/tr>/g)) {
    const cells = [...tr[2].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) =>
      untag(m[1])
    );
    if (!cells.length) continue;
    rows[cells[0]] = cells.slice(1);
    if (tr[1]) mismatch.add(cells[0]);
  }
  return { header: header.slice(1), rows, mismatch };
}

function blocks(html) {
  const out = {};
  for (const b of html.matchAll(
    /<div class="vi-block"><h3>(.*?)<\/h3>([\s\S]*?)<\/div>(?=<div class="vi-block">|<details|<div class="vi-src">|$)/g
  )) {
    out[untag(b[1])] = b[2];
  }
  return out;
}

function dump(info, zcs, opts) {
  const w = 22;
  const line = (label, cells) =>
    `  ${label.padEnd(12)} ${cells.map((c) => c.padEnd(w)).join('')}`;
  console.log(line('', info.header));
  for (const [k, v] of Object.entries(info.rows)) console.log(line(k, v));
  console.log('  --');
  for (const [k, v] of Object.entries(zcs.rows)) console.log(line(k, v));
  console.log('  --');
  for (const [k, v] of Object.entries(opts)) {
    console.log(`  ${k}: ${v.length ? v.slice(0, 6).join(' | ') : '(none)'}`);
  }
}

(async () => {
  await window.showVehicleIdentity('E46');
  const html = view.innerHTML;

  const b = blocks(html);
  assert.ok(b['Information about car'], 'no car-info box rendered');
  assert.ok(b['ZCS/FA coding'], 'no ZCS/FA box rendered');
  assert.ok(b['Options'], 'no options box rendered');
  const info = readTable(b['Information about car']);
  const zcs = readTable(b['ZCS/FA coding']);

  // The options box: per column, the list items as "<0205> name kw".
  const opts = {};
  for (const col of b['Options'].matchAll(
    /<div><h4>(.*?)<\/h4>([\s\S]*?)<\/div>/g
  )) {
    opts[untag(col[1])] = [...col[2].matchAll(/<li>([\s\S]*?)<\/li>/g)].map(
      (m) => untag(m[1])
    );
  }

  if (process.env.V) dump(info, zcs, opts);

  // ---- 1. three columns, one per identity master -------------------------
  assert.deepStrictEqual(
    info.header,
    ['EWS', 'KMB', 'LSZ'],
    `columns: ${info.header.join(', ')}`
  );
  assert.deepStrictEqual(zcs.header, info.header);
  ok('three columns: EWS, KMB, LSZ');

  const col = (rows, label) =>
    Object.fromEntries(
      info.header.map((h, i) => [h, (rows[label] || [])[i] || null])
    );

  // ---- 2. the car ---------------------------------------------------------
  assert.deepStrictEqual(col(info.rows, 'Chassis'), {
    EWS: 'E46',
    KMB: 'E46',
    LSZ: 'E46',
  });
  ok('Chassis row reads E46 in every column');

  assert.deepStrictEqual(col(info.rows, 'VIN'), {
    EWS: 'WBAET37495NJ87379',
    KMB: 'NJ87379',
    LSZ: 'NJ87379',
  });
  ok('VIN: 17 chars on EWS (check char stripped), production number elsewhere');

  assert.deepStrictEqual(col(info.rows, 'Odometer'), {
    EWS: '372346 km',
    KMB: '372358 km',
    LSZ: '—',
  });
  ok('odometer: EWS KD block 0 and the cluster AIF; nothing for the LSZ');

  // ---- 3. the record ------------------------------------------------------
  assert.deepStrictEqual(col(zcs.rows, 'Type-Key'), {
    EWS: 'ET37',
    KMB: 'ET37',
    LSZ: 'ET37',
  });
  assert.deepStrictEqual(col(zcs.rows, 'Order date'), {
    EWS: '—',
    KMB: '0904',
    LSZ: '0904',
  });
  assert.deepStrictEqual(col(zcs.rows, 'Paint'), {
    EWS: '—',
    KMB: '0354',
    LSZ: '0354',
  });
  assert.deepStrictEqual(col(zcs.rows, 'Upholstery'), {
    EWS: '—',
    KMB: 'K4SW',
    LSZ: 'K4SW',
  });
  ok('ZCS/FA box: type key, order date, paint, upholstery from the order');

  const gm = col(zcs.rows, 'ZCS GM');
  assert.ok(gm.EWS && /^FFFFFFFF-/.test(gm.EWS), `EWS GM ${gm.EWS}`);
  ok('ZCS/FA box: the EWS blank key is shown as body-dash-check');

  // ---- 4. nothing flagged as a mismatch ------------------------------------
  assert.deepStrictEqual(
    [...info.mismatch, ...zcs.mismatch],
    [],
    'rows flagged as disagreeing'
  );
  ok('no row is flagged: blank-vs-value and short-in-long are compatible');

  // ---- 5. the options -------------------------------------------------------
  for (const c of ['KMB', 'LSZ']) {
    const list = opts[c] || [];
    assert.strictEqual(
      list.length,
      FA_SAS.length,
      `${c}: ${list.length} options`
    );
    const nums = list.map((l) => l.match(/^<([^>]+)>/)[1]);
    // numbers ascending, four wide; the alphanumeric code after them, as itself
    const numeric = FA_SAS.filter((s) => /^\d+$/.test(s));
    const alpha = FA_SAS.filter((s) => !/^\d+$/.test(s));
    assert.deepStrictEqual(
      nums,
      [...numeric.map((s) => s.padStart(4, '0')), ...alpha],
      `${c}: option numbers`
    );
    assert.ok(
      list.some((l) => /^<0205> Automatic transmission/.test(l)),
      `${c}: 205 named`
    );
    assert.ok(
      list.some((l) => /^<0520> Fog lights/.test(l)),
      `${c}: 520 named`
    );
    assert.ok(
      list.some((l) => /^<0534> Automatic air conditioning/.test(l)),
      `${c}: 534 named`
    );
    // An alphanumeric SA is shown as itself. Stripping it to its digit and
    // naming THAT ("<0001> Dummy-SALAPA") would be an invented option.
    const oneCa = list.find((l) => l.startsWith('<1CA>'));
    assert.ok(oneCa, `${c}: 1CA listed as itself`);
    assert.ok(!/Dummy/.test(oneCa), `${c}: 1CA must not borrow SA 1's name`);
    assert.ok(
      !list.some((l) => /<0001>|<0633>|992633/.test(l)),
      `${c}: no invented code`
    );
  }
  assert.deepStrictEqual(opts.EWS, [], 'EWS blank key lists no options');
  assert.ok(/No options resolved/.test(b['Options']), 'EWS says so');
  ok(
    'options: 36 order codes with names on the FA columns, none from the blank key'
  );

  // ---- 6. the HO word is not an SA -----------------------------------------
  const fa = VehicleIdentity.parseFa(
    'E46_#0904*ET37%0354&K4SW$1CA$205$992+633L'
  );
  assert.deepStrictEqual(fa.sa, ['1CA', '205', '992']);
  assert.deepStrictEqual(VehicleIdentity.saCodesFromFa(fa), [
    '205',
    '992',
    '1CA',
  ]);
  assert.strictEqual(
    VehicleIdentity.formatFa(fa),
    'E46_#0904*ET37%0354&K4SW$1CA$205$992+633L'
  );
  ok('parseFa: +HO and -E words are their own tokens and round-trip');

  // ---- 7. the source strip --------------------------------------------------
  const src = untag(
    (html.match(/<div class="vi-src">([\s\S]*?)<\/div>/) || [])[1] || ''
  );
  assert.ok(/KMB ?order via C_FA_LESEN/.test(src), `source strip: ${src}`);
  assert.ok(/LSZ ?order via C_FA_LESEN/.test(src), `source strip: ${src}`);
  assert.ok(/EWS ?keys via C_ZCS_LESEN/.test(src), `source strip: ${src}`);
  assert.ok(
    !/bad/.test(
      html
        .match(/<div class="vi-src">[\s\S]*$/)[0]
        .replace(/class="vi-src-i ok"/g, '')
    ),
    'a source reported as failed'
  );
  ok('source strip names the order read on both FA columns');

  // ---- 8. which jobs ran ------------------------------------------------------
  const ran = (sgbd, job) =>
    calls.some((c) => c.sgbd === sgbd && c.job === job);
  assert.ok(ran('fa', 'FA_STREAM2STRUCT'), 'the fa decoder was not run');
  assert.ok(ran('c_lsza', 'C_FG_LESEN'), 'LSZ VIN via C_FG_LESEN');
  assert.ok(
    !ran('c_lsza', 'SIA_LESEN'),
    'the LSZ service read is not the VIN source'
  );
  assert.ok(ran('ews', 'KD_DATEN_LESEN'), 'EWS odometer via KD block 0');
  assert.ok(
    !ran('c_kmb46', 'C_ZCS_LESEN'),
    'a column with an order does not re-read the key'
  );
  // the odometer is stored copies only: no CAN-signal or service-counter read
  assert.ok(!calls.some((c) => /GESAMTWEG|KILOMETERSTAND/.test(c.job)));
  ok('the wire saw the dedicated jobs, and only those');

  assert.strictEqual(sbLeft.textContent, '3 modules · 36 option codes');
  ok('status bar counts the modules and codes');

  console.log(`identity-screen: ${passed} tests passed`);
})().catch((e) => {
  console.error('identity-screen: FAILED');
  console.error(e && e.stack ? e.stack : e);
  if (process.env.V) console.error('calls:', calls);
  process.exit(1);
});
