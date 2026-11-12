#!/usr/bin/env node
// BMWeb Scanner (app/renderer/screens/scanner/): the parts with no car in it.
//
// WHAT THIS PROVES
//   1. A DS2 identification answer becomes the reference scanner's row: the
//      E46 IKE answer captured in data/sim-captures/kombi46-ds2 prints the
//      line BMW Scanner 1.4.0.7 printed for that IKE, character for character.
//   2. The scan table header and rule lines are the reference's.
//   3. The error line uses the reference's counts ("no errors", "1 error",
//      "5 errors") and its shadow-memory column.
//   4. The module table is the reference's: 61 modules in its order, with
//      its addresses (DME 0x12 first, the E46 modules where its logs put them).
//   5. A refused or short answer is no identification; KWP-only modules
//      skip DS2.
//
// Run: node tools/verify/test_scanner.js
const assert = require('assert');
const s = require('../../app/renderer/screens/scanner/scanner-data.js');

const ok = (name, fn) => {
  fn();
  console.log('  ok   ' + name);
};

// the IKE's answer as the E46 capture logged it (ifh.trc line 143)
const IKE = [
  0x80, 0x12, 0xa0, 0xf6, 0x94, 0x08, 0x77, 0x32, 0x08, 0x54, 0x13, 0x28, 0x04,
  0x08, 0x36, 0x07, 0x37, 0x70,
];

ok('DS2 identification -> the reference line', () => {
  const id = s.scannerParseDs2Ident(IKE);
  assert.deepStrictEqual(
    {
      part: id.part,
      hw: id.hw,
      sw: id.sw,
      ci: id.ci,
      di: id.di,
      bi: id.bi,
      date: id.date,
    },
    {
      part: '6.940.877',
      hw: '32',
      sw: '36',
      ci: '08',
      di: '54',
      bi: '13',
      date: '28/04',
    }
  );
  assert.strictEqual(
    s.scannerLogLine('IKE', id, {
      odometer: '123456 km',
      vin: 'AB12345',
      adfg: '01FF5A',
      algorithm: 'M35080 - 2 (E46R)',
    }),
    'IKE   ->  6.940.877  32  36           08  54    13     28/04   123456 km   AB12345            01FF5A   M35080 - 2 (E46R)'
  );
  // nothing read yet: the reference's "-" in every later column
  assert.strictEqual(
    s.scannerLogLine('IKE', id),
    'IKE   ->  6.940.877  32  36           08  54    13     28/04   -           -                  -        -'
  );
});

ok(
  'KWP2000 identification -> the reference line (DME and DSC from the capture)',
  () => {
    const h = (x) => x.split(' ').map((b) => parseInt(b, 16));
    const dme = s.scannerParseKwpIdent(
      h(
        'b8 f1 12 1f 5a 80 00 00 07 56 13 82 00 00 00 11 31 43 20 05 01 27 00 00 00 00 00 00 00 00 00 00 00 00 00 a6'
      )
    );
    assert.strictEqual(
      s.scannerLogLine('DME', dme, {
        odometer: '0 km',
        vin: 'AB12345',
        adfg: '000000',
        algorithm: 'MS45 M54/M56 (EWS3)',
      }),
      'DME*  ->  7.561.382  00  x.x.x        00  0011  3143   01.05   0 km        AB12345            000000   MS45 M54/M56 (EWS3)'
    );
    const dsc = s.scannerParseKwpIdent(
      h(
        'b8 f1 29 1f 5a 80 00 00 06 76 54 52 01 12 00 06 00 06 20 04 07 21 24 00 00 00 00 00 00 00 00 00 00 00 00 00'
      )
    );
    assert.deepStrictEqual(
      [dsc.part, dsc.hw, dsc.ci, dsc.di, dsc.bi, dsc.date],
      ['6.765.452', '01', '12', '0006', '0006', '07.04']
    );
  }
);

ok('the GS20 long ASCII identification -> the reference line', () => {
  const h = (x) => x.split(' ').map((b) => parseInt(b, 16));
  const egs = s.scannerParseDs2Ident(
    h(
      '32 2e a0 37 35 35 32 37 30 30 32 39 30 30 31 30 36 30 33 36 30 35 30 30 30 30 30 30 30 30 30 30 39 30 31 30 30 30 31 33 39 31 37 35 37 b5'
    )
  );
  assert.strictEqual(
    s.scannerLogLine('EGS', egs, {
      odometer: '372340 km',
      vin: 'WBABW53426PL53856',
      adfg: '000000',
      algorithm: 'GS20',
    }),
    'EGS   ->  7.552.700  29  90           00  10    60     36/05   372340 km   WBABW53426PL53856  000000   GS20'
  );
});

ok('header and rules', () => {
  assert.strictEqual(
    s.scannerLogHeader(),
    'Unit      BMWTNR     HW  SW-FSW       CI  DI    BI/VI  Date    Odometer    VIN                ADFG     Algorithm'
  );
  assert.strictEqual(s.SCANNER_RULE.length, 123);
});

ok('error lines', () => {
  const id = s.scannerParseDs2Ident(IKE);
  assert.strictEqual(
    s.scannerErrorsLine('IKE', id, 5),
    'IKE   ->  6.940.877  32  36           5 errors'
  );
  assert.strictEqual(
    s.scannerErrorsLine('IKE', id, 0),
    'IKE   ->  6.940.877  32  36           no errors'
  );
  assert.strictEqual(
    s.scannerErrorsLine('IKE', id, 1, 0),
    'IKE   ->  6.940.877  32  36           1 error   / no errors'
  );
  assert.strictEqual(
    s.scannerErrorsLine('IKE', id, null),
    'IKE   ->  6.940.877  32  36           unknown'
  );
});

ok('Clear DTC log: the ERRORS AFTER CLEAR column and the waits', () => {
  const id = s.scannerParseDs2Ident(IKE);
  assert.strictEqual(
    s.scannerErrorsLine('IKE', id, 5, null, 0),
    'IKE   ->  6.940.877  32  36           5 errors                 no errors'
  );
  const log = s.scannerLog({
    title: 'T',
    clear: true,
    rows: [{ module: { name: 'IKE' }, id, errors: 5, after: 1 }],
  });
  assert.ok(
    log.includes(
      'Unit      BMWTNR     HW  SW-FSW       ERRORS / SHADOW-MEMORY   ERRORS AFTER CLEAR'
    )
  );
  assert.ok(log.includes('5 errors                 1 error'));
  const at = (n) => s.SCANNER_MODULES.find((m) => m.name === n);
  assert.strictEqual(s.scannerClearWaitMs(at('DME'), false), 5000);
  assert.strictEqual(s.scannerClearWaitMs(at('ABS'), false), 2500);
  assert.strictEqual(s.scannerClearWaitMs(at('LCM'), false), 2300);
  assert.strictEqual(s.scannerClearWaitMs(at('IKE'), false), 2000);
  assert.strictEqual(s.scannerClearWaitMs(at('ABS'), true), 3000);
});

ok('module table', () => {
  assert.strictEqual(s.SCANNER_MODULES.length, 61);
  const at = (n) => s.SCANNER_MODULES.find((m) => m.name === n);
  assert.strictEqual(s.SCANNER_MODULES[0].name, 'DME');
  assert.strictEqual(at('DME').address, 0x12);
  assert.strictEqual(at('IKE').address, 0x80);
  assert.strictEqual(at('LCM').address, 0xd0);
  assert.strictEqual(at('EWS').address, 0x44);
  // the reference's E46 log order is the table order
  const order = [
    'DME',
    'EGS',
    'EWS',
    'ABS',
    'LEW',
    'A/C',
    'SRS',
    'IKE',
    'LCM',
    'ZKE',
    'AIC',
    'TEL',
    'SZM',
    'SHD',
    'SMF',
  ];
  const idx = order.map((n) => s.SCANNER_MODULES.indexOf(at(n)));
  assert.deepStrictEqual(
    idx,
    [...idx].sort((a, b) => a - b)
  );
});

ok('the units the reference does not have', () => {
  const all = s.scannerUnits();
  assert.strictEqual(
    all.length,
    s.SCANNER_MODULES.length + s.SCANNER_EXTRA_MODULES.length
  );
  // the reference's table comes first, untouched
  assert.deepStrictEqual(all.slice(0, 61), s.SCANNER_MODULES);
  // no name and no address is asked twice
  assert.strictEqual(new Set(all.map((m) => m.name)).size, all.length);
  assert.strictEqual(new Set(all.map((m) => m.address)).size, all.length);
  for (const m of s.SCANNER_EXTRA_MODULES) {
    // nothing is known of how they talk: DS2 first, then KWP2000
    assert.ok(!s.scannerKwpOnly(m) && s.scannerTriesKwp(m), m.name);
    // the log's unit column is six wide, '*' included
    assert.ok(m.name.length <= 5, m.name);
  }
});

ok('refusals and protocol choice', () => {
  const refused = IKE.slice();
  refused[2] = 0xa2;
  assert.strictEqual(s.scannerParseDs2Ident(refused), null);
  assert.strictEqual(s.scannerParseDs2Ident(IKE.slice(0, 8)), null);
  const at = (n) => s.SCANNER_MODULES.find((m) => m.name === n);
  assert.ok(s.scannerKwpOnly(at('VTC1')));
  assert.ok(!s.scannerKwpOnly(at('DME')) && s.scannerTriesKwp(at('DME')));
  assert.ok(!s.scannerTriesKwp(at('IKE')));
});

ok('whole log', () => {
  const id = s.scannerParseDs2Ident(IKE);
  const log = s.scannerLog({
    title: 'T',
    rows: [{ module: { name: 'IKE' }, id, errors: 5 }],
  });
  const lines = log.split('\r\n');
  assert.strictEqual(lines[5], ' # SCAN START');
  assert.ok(lines.includes(' # ERRORS IN UNITS'));
  assert.ok(lines.includes(' # SCAN END'));
});

ok('pages: the reference grid, twenty units a page, no DME2', () => {
  Object.assign(global, s, { inpaMode: () => false });
  const w = require('../../app/renderer/screens/scanner/scanner.js');
  // three pages of the reference's units, then the units it does not have
  assert.strictEqual(w.scannerPageCount(), 4);
  assert.deepStrictEqual(
    w.scannerPage(4).map((m) => m.name),
    s.SCANNER_EXTRA_MODULES.map((m) => m.name)
  );
  assert.deepStrictEqual(
    w.scannerPage(1).map((m) => m.name),
    [
      'DME',
      'EGS',
      'EWS',
      'ABS',
      'LEW',
      'A/C',
      'SRS',
      'IKE',
      'LCM',
      'ZKE',
      'MFL',
      'PDC',
      'AIC',
      'RAD',
      'TEL',
      'SZM',
      'VID',
      'NAV',
      'VMGP',
      'BMBT',
    ]
  );
  assert.strictEqual(w.scannerPage(2).length + w.scannerPage(3).length, 40);
});

(async () => {
  // Clear DTC over BMWeb's own cable: the reference's telegrams through the
  // raw exchange, then the count read again (scanner-proc.js holds the
  // per-module procedures; test_scanner_proc.js checks each one)
  Object.assign(
    global,
    require('../../app/renderer/screens/scanner/scanner-proc.js')
  );
  const sent = [];
  let count = 5;
  global.withBusLock = (fn) => fn();
  global.webBusRawExchange = async (out) => {
    const key = out.map((b) => b.toString(16).padStart(2, '0')).join(' ');
    sent.push(key);
    if (key === '80 05 04 00') return [0x80, 0x05, 0xa0, count, 0];
    if (key === '80 04 05') {
      count = 0;
      return [0x80, 0x04, 0xa0, 0x24];
    }
    throw new Error('silent');
  };
  const w = require('../../app/renderer/screens/scanner/scanner.js');
  const ike = s.SCANNER_MODULES.find((m) => m.name === 'IKE');
  const found = { kwp: false, raw: null };
  assert.deepStrictEqual(await w.scannerCounts(ike, found), {
    errors: 5,
    shadow: null,
  });
  const r = await w.scannerClearFaults(ike, found);
  assert.deepStrictEqual([r.ok, r.left, r.sent], [true, 0, ['05']]);
  assert.deepStrictEqual(sent, ['80 05 04 00', '80 04 05', '80 05 04 00']);
  // over the PA Soft cable nothing that clears is sent
  global.pasoftCable = { connected: true };
  global.webBus = { connected: false };
  const before = sent.length;
  const refused = await w.scannerClearFaults(ike, found);
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(sent.length, before);
  console.log(
    '  ok   Clear DTC: the reference telegrams, then the count re-read'
  );
  console.log('ALL PASS');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
