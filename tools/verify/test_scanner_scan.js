#!/usr/bin/env node
// BMWeb Scanner's scan with no screen in it (app/renderer/screens/scanner/
// scanner-scan.js) and the report the Garage keeps of it (scanner-report.js),
// against a fake car.
//
// WHAT THIS PROVES
//   1. The walk asks every unit in order, reads the counts of those that
//      answered, and reads a fault list only where the counts do not already
//      say every memory is empty -- except the light module, always.
//   2. A clearing scan clears the units with stored or shadow faults only.
//   3. Stop ends it between units; a lost cable ends it and is handed back,
//      with what was read.
//   4. The report is the Garage's whole-car shape: a unit is filed under the
//      group the control unit tree gives the address it answered on, a silent
//      unit is listed as silent, a fault keeps the reference's code and words.
//   5. A memory that could not be read is never filed as empty.
//   6. Only the K-line series are scanned this way.
//
// Run: node tools/verify/test_scanner_scan.js
const assert = require('assert');
const data = require('../../app/renderer/screens/scanner/scanner-data.js');
const proc = require('../../app/renderer/screens/scanner/scanner-proc.js');
Object.assign(global, data, proc, {
  // one unit's texts, in the pack's shape: every parameter "present"
  SCANNER_FAULT_TEXTS: {
    IKE: { codes: { 32: 'Fuel level sensor' }, state: '2'.repeat(256) },
  },
  SCANNER_FAULT_ALPHABET: '012',
});
const faults = require('../../app/renderer/screens/scanner/scanner-faults.js');
Object.assign(global, faults);
const scan = require('../../app/renderer/screens/scanner/scanner-scan.js');
Object.assign(global, scan);
const rep = require('../../app/renderer/screens/scanner/scanner-report.js');

let chain = Promise.resolve();
const ok = (name, fn) => {
  chain = chain.then(async () => {
    await fn();
    console.log('  ok   ' + name);
  });
};

const unit = (n) => data.scannerUnits().find((m) => m.name === n);
const ident = (kwp = false) => ({
  id: {
    part: '6.940.877',
    hw: '32',
    sw: '36',
    ci: '08',
    di: '54',
    bi: '13',
    kwp,
  },
  raw: [0x80, 0x12, 0xa0],
});

/**
 * A car: the units that answer, with their counts and lists.
 * @param {Object<string, {kwp?: boolean, errors?: number|null, shadow?: number|null, list?: object}>} car
 */
function fakeIo(car) {
  const calls = [];
  return {
    calls,
    identify: async (m) => {
      calls.push(`ident ${m.name}`);
      if (car[m.name] && car[m.name].dies) throw new Error('cable gone');
      return car[m.name] ? ident(car[m.name].kwp) : null;
    },
    counts: async (m) => {
      calls.push(`counts ${m.name}`);
      const u = car[m.name];
      return {
        errors: u.errors === undefined ? 0 : u.errors,
        shadow: u.shadow === undefined ? null : u.shadow,
      };
    },
    faultList: async (m) => {
      calls.push(`list ${m.name}`);
      return car[m.name].list || { errors: null, shadow: null };
    },
    clearFaults: async (m) => {
      calls.push(`clear ${m.name}`);
      return { ok: true, left: 0 };
    },
  };
}

ok(
  'the walk: identify, count, list only where a memory is not empty',
  async () => {
    const io = fakeIo({
      DME: {
        kwp: true,
        errors: 1,
        list: { errors: [{ code: 0x27c3, param: 1 }], shadow: null },
      },
      IKE: { errors: 0 },
      LCM: { errors: 0, list: { errors: [], shadow: [] } },
      ZKE: { errors: 0, shadow: 2, list: { errors: [], shadow: [] } },
      SRS: { errors: 0, shadow: 0 },
      EWS: { errors: null },
    });
    const units = ['DME', 'EGS', 'EWS', 'SRS', 'IKE', 'LCM', 'ZKE'].map(unit);
    const phases = [];
    const out = await scan.scannerScanUnits({
      units,
      alive: () => true,
      faults: true,
      io,
      on: (phase, m) => phases.push(`${phase} ${m.name}`),
    });
    assert.strictEqual(out.error, null);
    assert.deepStrictEqual(
      out.answered.map((r) => r.module.name),
      ['DME', 'EWS', 'SRS', 'IKE', 'LCM', 'ZKE']
    );
    assert.deepStrictEqual(
      io.calls.filter((c) => c.startsWith('list')),
      // a fault counted; no count given; the light module; a shadow fault
      ['list DME', 'list EWS', 'list LCM', 'list ZKE']
    );
    assert.ok(!io.calls.some((c) => c.startsWith('clear')));
    assert.deepStrictEqual(phases.slice(0, 6), [
      'ask DME',
      'found DME',
      'counted DME',
      'done DME',
      'ask EGS',
      'silent EGS',
    ]);
  }
);

ok('a clearing scan clears only the units that hold faults', async () => {
  const io = fakeIo({
    DME: { errors: 2 },
    IKE: { errors: 0 },
    ZKE: { errors: 0, shadow: 1 },
  });
  const out = await scan.scannerScanUnits({
    units: ['DME', 'IKE', 'ZKE'].map(unit),
    alive: () => true,
    clear: true,
    io,
  });
  assert.strictEqual(out.cleared, 2);
  assert.deepStrictEqual(
    io.calls.filter((c) => c.startsWith('clear')),
    ['clear DME', 'clear ZKE']
  );
  assert.strictEqual(out.answered[0].after, 0);
  assert.strictEqual(out.answered[1].after, undefined);
  // fault lists are a reading scan's business
  assert.ok(!io.calls.some((c) => c.startsWith('list')));
});

ok('stop ends it between units; a lost cable is handed back', async () => {
  let n = 0;
  const io = fakeIo({ DME: { errors: 0 }, EWS: { errors: 0 } });
  const stopped = await scan.scannerScanUnits({
    units: ['DME', 'EGS', 'EWS'].map(unit),
    alive: () => n++ < 2,
    io,
  });
  assert.deepStrictEqual(
    stopped.answered.map((r) => r.module.name),
    ['DME']
  );
  assert.ok(!io.calls.includes('ident EWS'));

  const lost = await scan.scannerScanUnits({
    units: ['DME', 'EGS', 'EWS'].map(unit),
    alive: () => true,
    io: fakeIo({ DME: { errors: 0 }, EGS: { dies: true } }),
  });
  assert.strictEqual(lost.error.message, 'cable gone');
  assert.strictEqual(lost.answered.length, 1);
});

// a tree in ISTA's shape: the DSC's KWP2000 address is its own entry, and
// the cluster sits on the bus the tree draws as its root
const tree = {
  ecus: [
    { name: 'DME', addr: 0x12, groups: ['d_motor', 'd_0012'], bus: 'FACAN' },
    { name: 'DSC', addr: 0x56, groups: ['d_0056'], bus: 'FACAN' },
    { name: 'DSC/DXC', addr: 0x29, groups: ['d_abskwp'], bus: 'FACAN' },
    { name: 'KOMBI', addr: 0x80, groups: ['d_0080', 'd_kombi'], bus: 'ROOT' },
    { name: 'DME', addr: 0x12, groups: ['d_late'], bus: 'UNKNOWN' },
  ],
};

ok('a unit is filed under the tree group of the address it answered on', () => {
  const groups = rep.scannerGroupsByAddress(tree);
  assert.strictEqual(groups.get(0x12), 'd_motor');
  assert.strictEqual(
    rep.scannerUnitGroup(unit('IKE'), false, groups),
    'd_0080'
  );
  // the DSC: DS2 on 56, KWP2000 on 29
  assert.strictEqual(
    rep.scannerUnitGroup(unit('ABS'), false, groups),
    'd_0056'
  );
  assert.strictEqual(
    rep.scannerUnitGroup(unit('ABS'), true, groups),
    'd_abskwp'
  );
  // an address the tree does not carry: EDIABAS's own name for it
  assert.strictEqual(
    rep.scannerUnitGroup(unit('LCM'), false, groups),
    'd_00d0'
  );
  assert.strictEqual(
    rep.scannerUnitGroup(unit('KOMBI'), false, new Map()),
    'd_000d'
  );
});

ok('fault entries: code, text, presence, the shadow memory', () => {
  const one = rep.scannerFaultEntry('IKE', { code: 0x32, param: 0 }, false);
  assert.deepStrictEqual(one, {
    F_ORT_NR: 0x32,
    F_CODE_STRING: '32',
    F_ORT_TEXT: 'Fuel level sensor',
    F_VORHANDEN_TEXT: 'Fehler momentan vorhanden',
  });
  // no text for the unit: the reference's own fallback, stored not present
  const two = rep.scannerFaultEntry('DME', { code: 0x27c3, param: 1 }, false);
  assert.strictEqual(two.F_CODE_STRING, '27C3');
  assert.strictEqual(two.F_ORT_TEXT, 'Error number 27C3');
  assert.strictEqual(two.F_VORHANDEN_TEXT, 'Fehler momentan nicht vorhanden');
  const sh = rep.scannerFaultEntry('IKE', { code: 0x32, param: 0 }, true);
  assert.strictEqual(sh.F_ORT_TEXT, 'Fuel level sensor (shadow memory)');
});

ok('a memory that could not be read is never filed as empty', () => {
  const r = (over) => ({ module: unit('IKE'), ...ident(), ...over });
  // clean by count: nothing to file
  assert.deepStrictEqual(
    rep.scannerUnitCodes(r({ errors: 0, shadow: null })),
    []
  );
  // counted, list did not come
  const counted = rep.scannerUnitCodes(
    r({ errors: 3, shadow: null, faults: { errors: null, shadow: null } })
  );
  assert.strictEqual(counted.length, 1);
  assert.ok(/^3 faults counted/.test(counted[0].F_ORT_TEXT));
  // not even a count
  const dark = rep.scannerUnitCodes(r({ errors: null, shadow: null }));
  assert.strictEqual(dark.length, 1);
  assert.ok(/could not be read/.test(dark[0].F_ORT_TEXT));
  // a shadow memory counted but not listed, beside a list that did come
  const mixed = rep.scannerUnitCodes(
    r({
      errors: 1,
      shadow: 1,
      faults: { errors: [{ code: 0x32, param: 0 }], shadow: null },
    })
  );
  assert.strictEqual(mixed.length, 2);
  assert.ok(/shadow memory/.test(mixed[1].F_ORT_TEXT));
});

ok('the report the Garage keeps of a scan', async () => {
  const io = fakeIo({
    DME: {
      kwp: true,
      errors: 1,
      list: { errors: [{ code: 0x27c3, param: 1 }], shadow: null },
    },
    IKE: {
      errors: 1,
      list: { errors: [{ code: 0x32, param: 0 }], shadow: null },
    },
    ABS: { kwp: true, errors: 0 },
  });
  // the way the Scanner's window collects them for a Garage car
  const read = [];
  const silent = [];
  await scan.scannerScanUnits({
    units: ['DME', 'EGS', 'ABS', 'IKE'].map(unit),
    alive: () => true,
    faults: true,
    io,
    on: (phase, m, r) => {
      if (phase === 'silent') silent.push(m);
      else if (phase === 'done') read.push(r);
    },
  });
  const report = await rep.scannerGarageReport('E46', read, silent, {
    tree: async () => tree,
    assets: async () => true,
  });
  assert.strictEqual(report.kind, 'faults');
  assert.deepStrictEqual(
    report.modules.map((m) => [m.sgbd, m.via, m.codes.length]),
    [
      ['d_motor', 'd_motor', 1],
      ['d_abskwp', 'd_abskwp', 0],
      ['d_0080', 'd_0080', 1],
    ]
  );
  assert.strictEqual(report.modules[0].label, 'Digital Motor Electronics');
  assert.strictEqual(report.modules[0].ident.ID_BMW_NR, '6.940.877');
  assert.deepStrictEqual(report.silent, [
    {
      target: 'd_0032',
      label: 'Electronic Gearbox Control',
      error: 'no response',
    },
  ]);
  // never cleared
  assert.ok(!io.calls.some((c) => c.startsWith('clear')));

  // no tree and no text pack: still a report, each unit under the D_00xx
  // of its own address
  const bare = await rep.scannerGarageReport('E46', read, silent, {
    tree: async () => {
      throw new Error('offline');
    },
    assets: async () => false,
  });
  assert.deepStrictEqual(
    bare.modules.map((m) => m.via),
    ['d_0012', 'd_0056', 'd_0080']
  );
});

ok('only the K-line series are scanned this way', async () => {
  const buses = async (ch) =>
    ({ E46: ['FACAN', 'KBUS', 'ROOT'], E90: ['FACAN', 'KCAN', 'MOST'] })[ch] ||
    [];
  assert.strictEqual(await rep.scannerScansChassis('E46', buses), true);
  assert.strictEqual(await rep.scannerScansChassis('E90', buses), false);
  assert.strictEqual(await rep.scannerScansChassis('F10', buses), false);
  assert.strictEqual(await rep.scannerScansChassis('', buses), false);
});

chain.then(
  () => console.log('ALL PASS'),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
