#!/usr/bin/env node
// The Garage: the store the saved cars and their scan history live in, and
// the comparison between two stored reads.
//
// Everything here is the pure half of screens/garage/ -- no DOM. The store is
// driven against a stand-in Settings (the app's own is localStorage-backed),
// and the diff against two hand-built reports whose differences are known, so
// a wrong match rule shows up as a named fault moving to the wrong list.
//
//   node tools/verify/test_garage.js
//   V=1 node tools/verify/test_garage.js     # per-check output

const assert = require('assert');
const { loadClassic } = require('./lib/load_classic.js');

let passed = 0;
const ok = (what) => {
  passed++;
  if (process.env.V) console.log('  ok', what);
};

// ---- the browser globals the garage's pure half leans on -------------------
global.window = global;
// the store persists through Settings; this is the same key/value contract the
// app's localStorage-backed one exposes (get with a default, set any JSON)
const store = {};
global.Settings = {
  get: (k, d) => (k in store ? store[k] : d),
  set: (k, v) => {
    // round-trip through JSON, exactly as localStorage does: a value that
    // cannot survive that (a typed array) must be caught by the store, not
    // by the browser at read time
    store[k] = JSON.parse(JSON.stringify(v));
  },
};
const resetStore = () => {
  for (const k of Object.keys(store)) delete store[k];
};
global.dispChassis = (id) => id;
// hexText as core/translate.js defines it -- the store leans on it to flatten
// F_HEX_CODE before storage
global.hexText = (v) => {
  if (v == null || v === '') return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v) || ArrayBuffer.isView(v))
    return Array.from(v, (b) =>
      (b & 0xff).toString(16).toUpperCase().padStart(2, '0')
    ).join('-');
  return String(v);
};
// the ident captions the diff walks, as protocol.js declares them
global.IPO_IDENT_ROWS = [
  [['VARIANTE'], 'Variant'],
  [['ID_SW_NR'], 'Software number'],
  [['ID_DATUM_KW', 'ID_DATUM_JAHR'], 'Build date (week/year)'],
];

const G = loadClassic('screens/garage/');

// ---- the store -------------------------------------------------------------
{
  resetStore();
  const car = G.garageAddCar({
    vin: 'WBAAV33481FU12345',
    chassis: 'E46',
    label: 'E46 325i',
    model: '325i',
  });
  assert.ok(car.id, 'a saved car gets an id');
  assert.strictEqual(car.vin, 'WBAAV33481FU12345');
  assert.ok(car.added, 'a saved car is stamped');
  ok('a car saves');

  const back = G.garageCars();
  assert.strictEqual(back.length, 1);
  assert.deepStrictEqual(back[0], car, 'the car reads back exactly as stored');
  assert.deepStrictEqual(G.garageCar(car.id), car);
  ok('store round-trip');

  // the store is JSON in one Settings key, not a pile of loose keys
  assert.ok(
    Array.isArray(store[G.GARAGE_CARS_KEY]),
    'cars live under their own key'
  );
  ok('cars are keyed under one settings key');

  // a VIN matches on the 7-character production number, so the short form and
  // the full VIN are the same car
  assert.strictEqual(G.garageFindByVin('WBAAV33481FU12345').id, car.id);
  assert.strictEqual(G.garageFindByVin('FU12345').id, car.id);
  assert.strictEqual(G.garageFindByVin('wbaav33481fu12345').id, car.id);
  assert.strictEqual(G.garageFindByVin('WBAAV33481FU99999'), null);
  ok('a VIN matches on its production number');

  // re-saving the same car folds into it rather than making a second entry
  const again = G.garageAddCar({
    vin: 'FU12345',
    chassis: 'E46',
    motor: 'M54',
  });
  assert.strictEqual(again.id, car.id, 'the same VIN keeps the same car');
  assert.strictEqual(again.motor, 'M54', 'what decoded is folded in');
  assert.strictEqual(G.garageCars().length, 1, 'and no duplicate is made');
  ok('re-saving a VIN folds into the existing car');

  G.garageUpdateCar(car.id, { notes: 'needs a coolant flush' });
  assert.strictEqual(G.garageCar(car.id).notes, 'needs a coolant flush');
  assert.strictEqual(G.garageCar(car.id).vin, 'WBAAV33481FU12345');
  ok('a car updates in place');
}

/**
 * A report of one module holding the given faults.
 * @param {string} sgbd - the module
 * @param {object[]} codes - its faults
 * @param {object[]} [silent] - addresses that did not answer
 * @returns {object} an IpoProtocolReport
 */
function faultReport(sgbd, codes, silent) {
  return {
    kind: 'faults',
    modules: [{ sgbd, via: 'd_motor', label: sgbd.toUpperCase(), codes }],
    silent: silent || [],
    showText: false,
  };
}

// ---- scans: round-trip, compaction and the cap -----------------------------
{
  resetStore();
  const car = G.garageAddCar({ vin: 'FU12345', chassis: 'E46' });
  const scan = G.garageAddScan(
    car.id,
    {
      report: faultReport('ms450ds0', [
        { F_ORT_NR: 31, F_HEX_CODE: '27-C3', F_ORT_TEXT: '27C3 Lambdasonde' },
      ]),
      lines: ['Fg-Nummer   :  WBAAV33481FU12345 aus EWS ausgelesen'],
    },
    { chassis: 'E46' }
  );
  assert.ok(scan && scan.id, 'a scan is kept');
  assert.strictEqual(scan.carId, car.id);
  assert.strictEqual(scan.kind, 'faults');
  assert.deepStrictEqual(scan.summary, {
    modules: 1,
    withFaults: 1,
    faults: 1,
    silent: 0,
  });
  ok('a scan saves with its counts');

  const read = G.garageScan(car.id, scan.id);
  assert.deepStrictEqual(read, scan, 'a scan reads back exactly as stored');
  assert.strictEqual(
    read.report.modules[0].codes[0].F_ORT_TEXT,
    '27C3 Lambdasonde'
  );
  assert.deepStrictEqual(read.lines, [
    'Fg-Nummer   :  WBAAV33481FU12345 aus EWS ausgelesen',
  ]);
  ok('scan round-trip keeps the report and INPA text');

  // a report with no modules is not a scan
  assert.strictEqual(
    G.garageAddScan(car.id, {
      report: { kind: 'faults', modules: [], silent: [] },
    }),
    null
  );
  ok('an empty report is not kept');

  // the whole history goes with the car
  G.garageRemoveCar(car.id);
  assert.strictEqual(G.garageCars().length, 0);
  assert.strictEqual(G.garageScans(car.id).length, 0);
  ok('dropping a car drops its scans');
}

// F_HEX_CODE arrives from the web VM as bytes. JSON turns a typed array into
// an object, which hexText cannot read -- so the store must flatten it first
// or the reloaded fault draws as "[object Object]".
{
  resetStore();
  const car = G.garageAddCar({ chassis: 'E46', label: 'E46' });
  const scan = G.garageAddScan(car.id, {
    report: faultReport('ms450ds0', [
      { F_ORT_NR: 31, F_HEX_CODE: new Uint8Array([0x27, 0xc3]) },
    ]),
  });
  const stored = G.garageScan(car.id, scan.id).report.modules[0].codes[0];
  assert.strictEqual(
    stored.F_HEX_CODE,
    '27-C3',
    'a byte-array hex code is flattened before storage'
  );
  assert.strictEqual(global.hexText(stored.F_HEX_CODE), '27-C3');
  ok('F_HEX_CODE survives JSON as the dashed string');
}

// the cap: a car scanned forever keeps the newest GARAGE_SCAN_CAP reads
{
  resetStore();
  const car = G.garageAddCar({ chassis: 'E46', label: 'E46' });
  const cap = G.GARAGE_SCAN_CAP;
  for (let i = 0; i < cap + 12; i++) {
    G.garageAddScan(
      car.id,
      {
        report: faultReport('ms450ds0', [{ F_ORT_NR: i, F_HEX_CODE: 'AA-BB' }]),
      },
      { at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() }
    );
  }
  const list = G.garageScans(car.id);
  assert.strictEqual(list.length, cap, `the history stops at ${cap}`);
  // newest first, and the oldest is what fell off
  assert.strictEqual(
    list[0].report.modules[0].codes[0].F_ORT_NR,
    cap + 11,
    'the newest scan is first'
  );
  assert.strictEqual(
    list[list.length - 1].report.modules[0].codes[0].F_ORT_NR,
    12,
    'the oldest scans were dropped'
  );
  ok(`the scan history is capped at ${cap}, oldest dropped`);

  // one scan can be dropped without touching the rest
  const before = G.garageScans(car.id).length;
  G.garageRemoveScan(car.id, list[3].id);
  assert.strictEqual(G.garageScans(car.id).length, before - 1);
  assert.strictEqual(G.garageScan(car.id, list[3].id), null);
  ok('one scan deletes');
}

// a second car's history is its own: the cap must not evict across cars
{
  resetStore();
  const a = G.garageAddCar({ vin: 'FU00001', chassis: 'E46' });
  const b = G.garageAddCar({ vin: 'FU00002', chassis: 'E39' });
  G.garageAddScan(a.id, { report: faultReport('ms450ds0', []) });
  for (let i = 0; i < G.GARAGE_SCAN_CAP + 5; i++)
    G.garageAddScan(b.id, { report: faultReport('ms430ds0', []) });
  assert.strictEqual(G.garageScans(a.id).length, 1, "one car's flood");
  assert.strictEqual(G.garageScans(b.id).length, G.GARAGE_SCAN_CAP);
  ok('the cap is per car');
}

// ---- the diff --------------------------------------------------------------
{
  // one fault stays, one is cleared, one is new -- and the DME goes quiet
  // while the airbag module starts answering
  const from = {
    id: 'a',
    at: '2026-01-01T00:00:00.000Z',
    kind: 'faults',
    report: {
      kind: 'faults',
      modules: [
        {
          sgbd: 'ms450ds0',
          via: 'd_motor',
          label: 'DME',
          codes: [
            { F_ORT_NR: 31, F_HEX_CODE: '27-C3', F_ORT_TEXT: 'stays' },
            { F_ORT_NR: 32, F_HEX_CODE: '28-D4', F_ORT_TEXT: 'goes' },
          ],
        },
      ],
      silent: [{ target: 'mrs4', label: 'Airbag', error: 'ERROR_NO_ANSWER' }],
    },
  };
  const to = {
    id: 'b',
    at: '2026-02-01T00:00:00.000Z',
    kind: 'faults',
    report: {
      kind: 'faults',
      modules: [
        {
          sgbd: 'ms450ds0',
          via: 'd_motor',
          label: 'DME',
          codes: [
            // the same fault, now reported as currently present: still the
            // same fault, not one cleared and one new
            {
              F_ORT_NR: 31,
              F_HEX_CODE: '27-C3',
              F_ORT_TEXT: 'stays',
              F_VORHANDEN_TEXT: 'momentan vorhanden',
            },
            { F_ORT_NR: 40, F_HEX_CODE: '30-01', F_ORT_TEXT: 'arrives' },
          ],
        },
      ],
      silent: [{ target: 'kombi46', label: 'Kombi', error: 'ERROR_NO_ANSWER' }],
    },
  };

  const d = G.garageDiffScans(from, to);
  assert.strictEqual(d.kind, 'faults');
  const dme = d.modules.find((m) => m.sgbd === 'ms450ds0');
  assert.strictEqual(dme.added.length, 1, 'one new fault');
  assert.strictEqual(dme.added[0].F_HEX_CODE, '30-01');
  assert.strictEqual(dme.cleared.length, 1, 'one cleared fault');
  assert.strictEqual(dme.cleared[0].F_HEX_CODE, '28-D4');
  assert.strictEqual(dme.same.length, 1, 'one unchanged fault');
  assert.strictEqual(dme.same[0].F_HEX_CODE, '27-C3');
  assert.ok(dme.changed);
  ok('faults split into new / cleared / unchanged');

  // presence is not identity: the fault that became present is unchanged
  assert.strictEqual(
    dme.same[0].F_VORHANDEN_TEXT,
    'momentan vorhanden',
    'the newer copy is the one reported'
  );
  ok('a stored fault turning present is still the same fault');

  // answering: the Kombi went quiet, the airbag module came back
  const quiet = d.silence.find((s) => s.target === 'kombi46');
  const backAgain = d.silence.find((s) => s.target === 'mrs4');
  assert.strictEqual(quiet.state, 'silent', 'newly silent');
  assert.strictEqual(backAgain.state, 'answering', 'newly answering');
  assert.strictEqual(d.silence.length, 2);
  ok('modules newly silent and newly answering are both reported');

  const counts = G.garageDiffCounts(d);
  assert.deepStrictEqual(counts, {
    added: 1,
    cleared: 1,
    same: 1,
    recurred: 0,
    fields: 0,
    silence: 2,
    modules: 1,
  });
  ok('the diff counts add up');
}

// a fault is matched by its DTC, so a module renumbering its locations (or a
// translated text) does not read as a different fault
{
  const mk = (codes) => ({
    report: { kind: 'faults', modules: [{ sgbd: 'x', codes }], silent: [] },
  });
  const d = G.garageDiffScans(
    mk([{ F_ORT_NR: 31, F_HEX_CODE: '27-C3', F_ORT_TEXT: 'Lambdasonde' }]),
    mk([{ F_ORT_NR: 77, F_HEX_CODE: '27-C3', F_ORT_TEXT: 'Oxygen sensor' }])
  );
  assert.strictEqual(d.modules[0].same.length, 1, 'the DTC matched');
  assert.strictEqual(d.modules[0].added.length, 0);
  assert.strictEqual(d.modules[0].cleared.length, 0);
  ok('the hex DTC identifies a fault, not its number or text');

  // and where a module reports no hex at all, the location number is the
  // fallback identity
  const n = G.garageDiffScans(
    mk([{ F_ORT_NR: 5, F_ORT_TEXT: 'alt' }]),
    mk([{ F_ORT_NR: 5, F_ORT_TEXT: 'alt' }])
  );
  assert.strictEqual(n.modules[0].same.length, 1);
  ok('a fault with no hex falls back to its location number');

  assert.strictEqual(G.garageFaultKey({ F_HEX_CODE: '27-C3' }), 'H:27-C3');
  assert.strictEqual(G.garageFaultKey({ F_ORT_NR: 31 }), 'N:31');
  assert.strictEqual(
    G.garageFaultKey({}),
    '',
    'an unidentifiable fault has no key'
  );
  ok('the fault key prefers the DTC over the location number');
}

// a module that appears or disappears entirely between two reads
{
  const d = G.garageDiffScans(
    {
      report: {
        kind: 'faults',
        modules: [{ sgbd: 'gone', codes: [{ F_HEX_CODE: 'AA-01' }] }],
        silent: [],
      },
    },
    {
      report: {
        kind: 'faults',
        modules: [{ sgbd: 'fresh', codes: [{ F_HEX_CODE: 'BB-02' }] }],
        silent: [],
      },
    }
  );
  const gone = d.modules.find((m) => m.sgbd === 'gone');
  const fresh = d.modules.find((m) => m.sgbd === 'fresh');
  assert.strictEqual(gone.cleared.length, 1, 'a module that is no longer read');
  assert.strictEqual(fresh.added.length, 1, 'a module read for the first time');
  ok('modules only one side saw are still compared');
}

// ident reads: the changed fields, with the captions the protocol prints
{
  const mk = (ident) => ({
    report: {
      kind: 'ident',
      modules: [{ sgbd: 'ms450ds0', label: 'DME', codes: [], ident }],
      silent: [],
    },
  });
  const d = G.garageDiffScans(
    mk({ VARIANTE: 'MS450DS0', ID_SW_NR: '7519308', ID_DATUM_KW: '12' }),
    mk({ VARIANTE: 'MS450DS0', ID_SW_NR: '7548166', ID_DATUM_KW: '12' })
  );
  assert.strictEqual(d.kind, 'ident');
  const m = d.modules[0];
  assert.strictEqual(m.fields.length, 1, 'only the software number moved');
  assert.strictEqual(m.fields[0].key, 'ID_SW_NR');
  assert.strictEqual(m.fields[0].label, 'Software number');
  assert.strictEqual(m.fields[0].from, '7519308');
  assert.strictEqual(m.fields[0].to, '7548166');
  assert.ok(m.changed);
  ok('a changed ident field is reported with its caption');

  // an identical ident read has nothing to show
  const same = G.garageDiffScans(
    mk({ VARIANTE: 'MS450DS0', ID_SW_NR: '7519308' }),
    mk({ VARIANTE: 'MS450DS0', ID_SW_NR: '7519308' })
  );
  assert.strictEqual(same.modules[0].fields.length, 0);
  assert.strictEqual(same.modules[0].changed, false);
  ok('an unchanged ident read reports nothing');

  // a field the printed table does not caption still counts as a change
  const extra = G.garageDiffScans(
    mk({ ID_COD_INDEX: '01' }),
    mk({ ID_COD_INDEX: '02' })
  );
  assert.strictEqual(extra.modules[0].fields.length, 1);
  assert.strictEqual(extra.modules[0].fields[0].key, 'ID_COD_INDEX');
  ok('an uncaptioned ident field still counts as a change');

  // a field appearing or vanishing reads as a change to/from empty
  const appears = G.garageDiffScans(mk({}), mk({ ID_SW_NR: '7548166' }));
  assert.strictEqual(appears.modules[0].fields[0].from, '');
  assert.strictEqual(appears.modules[0].fields[0].to, '7548166');
  ok('a field that appears is a change from empty');
}

// ---- the VIN a finished read identified the car by -------------------------
{
  // the protocol header the script wrote, with the commentary it appends
  assert.strictEqual(
    G.garageVinFromView({
      lines: [
        'Inpa-Script :  E46',
        'Fg-Nummer   :  WBAAV33481FU12345 aus EWS ausgelesen',
      ],
    }),
    'WBAAV33481FU12345'
  );
  ok('the VIN is read out of the protocol header');

  // the script prints its own failure on that same line
  assert.strictEqual(
    G.garageVinFromView({ lines: ['Fg-Nummer   :  EWS-Error: no answer'] }),
    ''
  );
  ok('a failed VIN read is not taken as a VIN');

  // an ident read carries it in the modules' own answers, under either spelling
  assert.strictEqual(
    G.garageVinFromView({
      report: {
        kind: 'ident',
        modules: [{ sgbd: 'ews', ident: { FG_NR: 'WBAAV33481FU12345' } }],
      },
    }),
    'WBAAV33481FU12345'
  );
  assert.strictEqual(
    G.garageVinFromView({
      report: {
        kind: 'ident',
        modules: [
          { sgbd: 'kombi46', ident: { AIF_FG_NR: 'WBAAV33481FU12345' } },
        ],
      },
    }),
    'WBAAV33481FU12345'
  );
  ok('the VIN is read out of an ident answer, either spelling');

  assert.strictEqual(G.garageVinFromView({ lines: ['nothing here'] }), '');
  assert.strictEqual(G.garageVinFromView({}), '');
  ok('a read that names no VIN reports none');
}

// ---- freeze frames: the values a fault captured ----------------------------
{
  // one fault, as a detail read leaves it: two readings and one enumerated
  // state, in the F_UW<n> triples protocol.js merges in
  const code = {
    F_ORT_NR: 31,
    F_HEX_CODE: '27-C3',
    F_UW1_TEXT: 'STAT_SPANNUNG_KL30_WERT',
    F_UW1_WERT: '12.4',
    F_UW1_EINH: 'V',
    F_UW2_TEXT: 'Motor Status',
    F_UW2_WERT: '0 ES - Motor steht',
    F_UW2_EINH: '0-n',
    F_UW3_TEXT: 'STAT_MOTORTEMPERATUR_WERT',
    F_UW3_WERT: '91',
    F_UW3_EINH: '°C',
  };
  const fields = G.garageEnvKeys(code);
  assert.strictEqual(fields.length, 3, 'every captured field is read');
  assert.deepStrictEqual(fields[0], {
    i: 1,
    label: 'STAT_SPANNUNG_KL30_WERT',
    value: '12.4',
    unit: 'V',
  });
  ok('a fault’s freeze frame is read out of its F_UW fields');

  // a field with a label but no value is not a reading
  assert.strictEqual(
    G.garageEnvKeys({ F_UW1_TEXT: 'x' }).length,
    0,
    'a label with no value is skipped'
  );
  ok('an incomplete freeze-frame field is skipped');

  // an enumerated state is not a measurement and is never range-checked
  assert.strictEqual(G.garageEnvValue('0 ES - Motor steht'), null);
  assert.strictEqual(G.garageEnvValue('12.4'), 12.4);
  assert.strictEqual(G.garageEnvValue('-40'), -40);
  assert.strictEqual(G.garageEnvValue(''), null);
  ok('a state word is not read as a number');

  // nothing here is out of range, so nothing is flagged
  const clean = G.garageEnvChecks(code);
  assert.strictEqual(
    clean.filter((f) => f.warn).length,
    0,
    'healthy values carry no flag'
  );
  ok('values inside every rule are left unmarked');
}

// the script's own band, read from a module's decoded screens
{
  // the shape the IR ships: a gauge naming the result key it draws, carrying
  // the min/max/okMin/okMax the author declared (E46 cvm_iv, terminal 30)
  const screens = {
    screens: {
      s_klemmen: {
        lines: [
          {
            elements: [
              { t: 'text', s: 'Terminal 30 voltage [volts]', row: 6, col: 40 },
              {
                t: 'gauge',
                row: 7,
                col: 40,
                key: 'STAT_SPANNUNG_KL30_WERT',
                min: 0,
                max: 25,
                okMin: 6,
                okMax: 16,
                fmt: '2.1',
              },
            ],
          },
        ],
      },
    },
  };
  assert.deepStrictEqual(
    G.garageBandFor(screens, 'STAT_SPANNUNG_KL30_WERT'),
    { min: 6, max: 16 },
    "the author's declared band is found"
  );
  assert.strictEqual(
    G.garageBandFor(screens, 'STAT_NOT_DRAWN'),
    null,
    'a key no gauge draws has no band'
  );
  ok('the script’s gauge band is read out of the module IR');

  // a gauge that declares no band leaves okMin === okMax; treating that as a
  // 0-to-0 range would flag every reading, so it is not a band
  const none = {
    elements: [
      {
        t: 'gauge',
        key: 'STAT_DSC_ABS_VL',
        min: 0,
        max: 4095,
        okMin: 0,
        okMax: 0,
      },
    ],
  };
  assert.strictEqual(
    G.garageBandFor(none, 'STAT_DSC_ABS_VL'),
    null,
    'okMin === okMax is no band at all'
  );
  ok('a gauge with no declared band yields no band');

  // 17.2 V is inside the physical table but outside what THIS script calls
  // normal, so the script rule fires and cites its numbers
  const w = G.garageWarnFor(
    { label: 'STAT_SPANNUNG_KL30_WERT', value: '17.2', unit: 'V' },
    { screens }
  );
  assert.ok(w, 'a value outside the declared band is flagged');
  assert.strictEqual(w.source, 'script');
  assert.ok(
    w.text.includes('6 to 16'),
    'the flag quotes the band it was judged against'
  );
  ok('a reading outside the script’s band is flagged, citing the band');

  // and a value inside it is not
  assert.strictEqual(
    G.garageWarnFor(
      { label: 'STAT_SPANNUNG_KL30_WERT', value: '12.4', unit: 'V' },
      { screens }
    ),
    null
  );
  ok('a reading inside the script’s band is not flagged');
}

// the fixed physics table, used where no script band exists
{
  const V = (v) =>
    G.garageWarnFor(
      { label: 'STAT_SPANNUNG_KL30_WERT', value: v, unit: 'V' },
      {}
    );
  assert.strictEqual(V('12.4'), null, 'a healthy battery is not flagged');
  assert.strictEqual(V('13.9'), null, 'a charging system is not flagged');
  const flat = V('9.8');
  assert.ok(flat, 'a flat battery is flagged');
  assert.strictEqual(flat.source, 'physics');
  assert.ok(
    flat.text.includes('11.5') && flat.text.includes('fixed table'),
    'the flag names the bound and its source'
  );
  const over = V('16.2');
  assert.ok(over && over.source === 'physics', 'an overcharge is flagged');
  ok('battery voltage is checked against the fixed table, and cites it');

  const T = (v) =>
    G.garageWarnFor(
      { label: 'STAT_MOTORTEMPERATUR_WERT', value: v, unit: '°C' },
      {}
    );
  assert.strictEqual(T('91'), null, 'a warm engine is not flagged');
  assert.ok(T('124'), 'an overheating engine is flagged');
  assert.ok(T('-45'), 'an impossible cold reading is flagged');
  ok('coolant temperature is checked against the fixed table');

  const R = (v) =>
    G.garageWarnFor(
      { label: 'STAT_MOTORDREHZAHL_WERT', value: v, unit: '/min' },
      {}
    );
  assert.strictEqual(R('750'), null, 'an idle is not flagged');
  assert.ok(R('7400'), 'an over-rev is flagged');
  ok('engine speed is checked against the fixed table');

  // a field no rule names is never flagged -- no guessing from the value
  assert.strictEqual(
    G.garageWarnFor(
      { label: 'Kilometerstand', value: '184000', unit: 'km' },
      {}
    ),
    null
  );
  ok('a field no rule names is left alone');

  // every physics entry documents itself, so a flag can always explain itself
  for (const r of G.GARAGE_PHYSICS) {
    assert.ok(r.id && r.keys.length && r.unit, `${r.id} is complete`);
    assert.ok(r.min < r.max, `${r.id} has a real range`);
    assert.ok(r.why && r.why.length > 20, `${r.id} says why`);
  }
  ok('every physics rule carries its bounds and its reasoning');
}

// the history rule: only once enough past reads agree
{
  const field = { label: 'STAT_SPANNUNG_KL30_WERT', value: '12.1', unit: 'V' };
  // two past readings under the bound is not yet a trend
  assert.strictEqual(
    G.garageWarnFor(field, { history: ['11.2', '10.9'] }),
    null,
    'two agreeing reads are not a trend'
  );
  const t = G.garageWarnFor(field, { history: ['11.2', '10.9', '11.0'] });
  assert.ok(t, 'three agreeing reads are');
  assert.strictEqual(t.source, 'history');
  assert.strictEqual(t.level, 'note');
  assert.ok(t.text.includes('3'), 'the note counts what it saw');
  ok(`a history note needs ${G.GARAGE_TREND_MIN} agreeing reads`);

  // one healthy reading among them breaks the agreement
  assert.strictEqual(
    G.garageWarnFor(field, { history: ['11.2', '12.8', '11.0'] }),
    null,
    'a single healthy read breaks the trend'
  );
  ok('a history note needs every read to agree');
}

// a fault logged again since the last read: same code, moved freeze frame
{
  const before = {
    F_HEX_CODE: '27-C3',
    F_HFK: '3',
    F_UW1_TEXT: 'STAT_SPANNUNG_KL30_WERT',
    F_UW1_WERT: '12.4',
  };
  const again = {
    F_HEX_CODE: '27-C3',
    F_HFK: '5',
    F_UW1_TEXT: 'STAT_SPANNUNG_KL30_WERT',
    F_UW1_WERT: '10.1',
  };
  const s = G.garageEnvSummary(before, again);
  assert.strictEqual(s.recurred, true, 'a higher count means it logged again');
  assert.deepStrictEqual(s.changed, ['STAT_SPANNUNG_KL30_WERT']);
  ok('a fault whose freeze frame moved is seen as logged again');

  // the same fault, untouched, has not recurred
  assert.strictEqual(G.garageEnvSummary(before, before).recurred, false);
  ok('an untouched fault has not recurred');

  // and the diff marks it, without moving it out of "still present"
  const mk = (c) => ({
    report: {
      kind: 'faults',
      modules: [{ sgbd: 'x', codes: [c] }],
      silent: [],
    },
  });
  const d = G.garageDiffScans(mk(before), mk(again));
  const m = d.modules[0];
  assert.strictEqual(m.same.length, 1, 'it is still stored');
  assert.strictEqual(m.recurred.length, 1, 'and it is marked as logged again');
  assert.strictEqual(m.added.length, 0);
  assert.strictEqual(m.cleared.length, 0);
  assert.ok(m.changed, 'a recurrence is a change worth showing');
  assert.strictEqual(G.garageDiffCounts(d).recurred, 1);
  ok('the diff reports a recurrence without calling it new');
}

// ---- a decoded VIN becomes a garage entry ----------------------------------
{
  const entry = G.garageCarFromHit({
    vin: 'WBAAV33481FU12345',
    chassis: 'E46',
    model: '325i',
    body: 'Lim',
    motor: 'M54',
    prod: '20010312',
  });
  assert.strictEqual(entry.vin, 'WBAAV33481FU12345');
  assert.strictEqual(entry.chassis, 'E46');
  assert.strictEqual(entry.label, 'E46 325i');
  assert.strictEqual(entry.motor, 'M54');
  ok('a decoded VIN becomes a garage entry');
}

// ---- a scan launched from a car's page files itself against that car -------
{
  resetStore();
  const byVin = G.garageAddCar({ vin: 'WBAAV33481FU12345', chassis: 'E46' });
  const bare = G.garageAddCar({ chassis: 'E39' });
  assert.strictEqual(G.garageScanTarget('WBAAV33481FU12345'), null);
  ok('no target set: nothing is filed without asking');

  G.garageScanFor(bare.id);
  assert.strictEqual(G.garageScanTarget().id, bare.id);
  assert.strictEqual(G.garageScanTarget('WBAAV33481FU99999').id, bare.id);
  ok('a car saved without a VIN takes the read whatever VIN it found');

  G.garageScanFor(byVin.id);
  assert.strictEqual(G.garageScanTarget().id, byVin.id);
  assert.strictEqual(G.garageScanTarget('wbaav33481fu12345').id, byVin.id);
  assert.strictEqual(G.garageScanTarget('WBAAV33481FU99999'), null);
  ok('a car with a VIN refuses a read that identified as another car');

  G.garageScanTargetClear();
  assert.strictEqual(G.garageScanTarget(), null);
  G.garageScanFor(bare.id);
  G.garageRemoveCar(bare.id);
  assert.strictEqual(G.garageScanTarget(), null);
  ok('the target clears, and a deleted car is no target');
}

console.log(`garage: ${passed} checks passed`);
