#!/usr/bin/env node
// The tree-driven whole-car scan: the target list it builds from ISTA's tree
// (deduped by group, hidden buses skipped, script-only groups unioned in),
// the fault-read job it picks, and the walk itself against a fake bus --
// that a silent group is recorded rather than guessed, that the report folds
// through ipoProtocolReport exactly as the .IPO path's does, and that an
// all-silent car is called out as a missing cable rather than a clean scan.
//
//   node tools/verify/test_tree_scan.js

const assert = require('assert');
const path = require('path');
const { loadClassic } = require('./lib/load_classic.js');

let passed = 0;
const ok = (what) => {
  passed++;
  if (process.env.V) console.log('  ok', what);
};

global.window = global.window || {};
const T = loadClassic('screens/tree/');
const P = loadClassic('screens/ipo-runtime/');

// ---- a tree in ISTA's real shape -------------------------------------------
// ZKE carries the alias pair the chassis configs disagree about; SM/SPM is the
// single box whose pair only the INPA script reaches; DDE sits on a bus ISTA
// never draws, so the walk must skip it.
const tree = {
  series: 'T46',
  mainSgbd: 'zcs_all',
  ecus: [
    { name: 'ZKE', addr: 0, groups: ['d_0000', 'd_zke_gm'], bus: 'KBUS', col: 1, row: 1 },
    { name: 'DME', addr: 18, groups: ['d_0012'], bus: 'FACAN', col: 2, row: 1 },
    { name: 'KOMBI', addr: 128, groups: ['d_0080'], bus: 'KBUS', col: 1, row: 2 },
    { name: 'SM/SPM', addr: 113, groups: ['d_0071'], bus: 'UNKNOWN', col: 0, row: 0 },
    { name: 'EGS', addr: 24, groups: ['d_egs'], bus: 'FACAN', col: 2, row: 2 },
  ],
  buses: [],
};
const extras = [
  { group: 'd_xen_l', label: 'Licht Xenon links' },
  { group: 'd_xen_r', label: 'Licht Xenon rechts' },
];
const deps = {
  tree: async () => tree,
  extras: async () => extras,
};

// ---- the target list --------------------------------------------------------
(async () => {
  const got = await T.ecuTreeWalkTargets('E46', deps);
  const groups = got.map((t) => t.group);

  assert.ok(!groups.includes('d_0071'), 'a hidden-bus entry is not addressed');
  ok('modules on a bus ISTA never draws are skipped');

  assert.deepStrictEqual(
    groups,
    ['d_0000', 'd_zke_gm', 'd_0012', 'd_0080', 'd_egs', 'd_xen_l', 'd_xen_r'],
    'tree order, then the script-only extras'
  );
  ok('every drawn group is a target, extras last');

  // THE UNION IS THE POINT: without it the xenon pair is never read, because
  // ISTA draws them as one LWR box and INPA addresses them as two groups.
  assert.ok(
    groups.includes('d_xen_l') && groups.includes('d_xen_r'),
    'the groups only the INPA script names are unioned in'
  );
  ok('script-only groups survive into the scan list');

  const zke = got.find((t) => t.group === 'd_0000');
  assert.strictEqual(zke.label, 'ZKE');
  assert.strictEqual(zke.addr, 0);
  ok('a target keeps its tree label and address');

  const xen = got.find((t) => t.group === 'd_xen_l');
  assert.strictEqual(xen.label, 'Licht Xenon links');
  assert.strictEqual(xen.addr, -1, 'an extra has no tree address to claim');
  ok('an extra carries the script label and no invented address');

  // one group must never be addressed twice, however many boxes share it
  const dupTree = {
    ecus: [
      { name: 'A', addr: 1, groups: ['d_0012'], bus: 'KBUS' },
      { name: 'B', addr: 2, groups: ['d_0012'], bus: 'KBUS' },
    ],
  };
  const once = await T.ecuTreeWalkTargets('X', {
    tree: async () => dupTree,
    extras: async () => [],
  });
  assert.strictEqual(once.length, 1, 'a shared group is addressed once');
  assert.strictEqual(once[0].label, 'A', 'the first entry names it');
  ok('a group two boxes share is read once');

  // ---- the fault-read job, and the argument it wants --------------------
  const names = (map) => async (s) => map[s] || [];
  /** the arguments route: {sgbd: {JOB: [{ARG}]}}, absent meaning none */
  const argsOf = (map) => async (s, j) => (map[s] || {})[j] || [];

  assert.deepStrictEqual(
    await T.ecuTreeFaultJobFor(
      'a',
      names({ a: ['IDENT', 'FS_LESEN', 'FS_LESEN_DETAIL'] }),
      argsOf({})
    ),
    { job: 'FS_LESEN', arg: '' }
  );
  ok('exact FS_LESEN wins, sent bare when it declares no argument');

  assert.deepStrictEqual(
    await T.ecuTreeFaultJobFor(
      'b',
      names({ b: ['FS_LESEN_FUNKTIONAL', 'FS_LESEN_DETAIL'] }),
      argsOf({})
    ),
    { job: 'FS_LESEN_FUNKTIONAL', arg: '' }
  );
  ok('the narrowest prefixed read is taken when FS_LESEN is absent');

  // THE REGRESSION THIS GUARDS. E46's light switch centre stores faults in
  // eight blocks and declares FS_LESEN(ALL_BLOCKS); called bare it answers
  // F_ZAHL 0, which counts only blocks 1-3, so a real fault in block 5 reads
  // as a clean module. A current "Fernlicht rechts defekt" on the car was
  // invisible exactly this way. The ARG field is the route's own spelling.
  assert.deepStrictEqual(
    await T.ecuTreeFaultJobFor(
      'lsz_2',
      names({ lsz_2: ['FS_LESEN', 'FS_LESEN_GESAMT', 'FS_LESEN_DETAIL'] }),
      argsOf({ lsz_2: { FS_LESEN: [{ ARG: 'ALL_BLOCKS', ARGTYPE: 'string' }] } })
    ),
    { job: 'FS_LESEN', arg: 'ALL_BLOCKS' }
  );
  ok('a declared single argument is sent by name (ALL_BLOCKS)');

  // a read wanting values nothing here can supply is passed over for one
  // that needs none, rather than being called bare and half-answering
  assert.deepStrictEqual(
    await T.ecuTreeFaultJobFor(
      'c',
      names({ c: ['FS_LESEN', 'FS_LESEN_GESAMT'] }),
      argsOf({ c: { FS_LESEN: [{ ARG: 'BLOCK' }, { ARG: 'INDEX' }] } })
    ),
    { job: 'FS_LESEN_GESAMT', arg: '' }
  );
  ok('a multi-argument read is skipped for one that needs none');

  // no lookup at all (an older build): every job is called bare, as before
  assert.deepStrictEqual(
    await T.ecuTreeFaultJobFor('d', names({ d: ['FS_LESEN'] })),
    { job: 'FS_LESEN', arg: '' }
  );
  ok('without an arguments lookup a read is still found, called bare');

  assert.strictEqual(
    await T.ecuTreeFaultJobFor('e', names({ e: ['FS_LESEN_DETAIL'] }), argsOf({})),
    null
  );
  ok('the detail read is never chosen on its own');

  assert.strictEqual(
    await T.ecuTreeFaultJobFor('f', names({ f: ['IDENT'] }), argsOf({})),
    null
  );
  ok('a module declaring no fault read reports none');

  // ---- the walk -------------------------------------------------------------
  const faultSets = [{}, { F_HEX_CODE: '27C3', F_ORT_TEXT: 'misfire' }];
  const walkDeps = {
    ...deps,
    // d_0012 answers with a variant and one fault; d_0080 is silent; the rest
    // answer clean. A silent group is an option the car does not have.
    resolve: async (g) =>
      ({
        d_0000: 'zke5',
        d_zke_gm: 'zke5',
        d_0012: 'ms450ds0',
        d_egs: 'egs_a5s',
        d_xen_l: 'xenon_l',
        d_xen_r: 'xenon_r',
      })[g] || null,
    jobNames: async () => ['FS_LESEN', 'IDENT'],
    jobArgs: async () => [],
    run: async (sgbd) => ({
      sets: sgbd === 'ms450ds0' ? faultSets : [{}],
    }),
    report: P.ipoProtocolReport,
    cableReady: null,
  };
  const { report } = await T.ecuTreeWalkStart('E46', {}, walkDeps).done;

  assert.strictEqual(report.kind, 'faults');
  ok('the walk folds into a fault report');

  const dme = report.modules.find((m) => m.sgbd === 'ms450ds0');
  assert.ok(dme, 'the module that answered is in the report');
  assert.strictEqual(dme.via, 'd_0012', 'the group it was reached through');
  assert.strictEqual(dme.codes.length, 1, 'its one fault');
  ok('a module is keyed by the variant that answered, via its group');

  // THE SILENT GROUP IS RECORDED, NOT INVENTED: a car without a cluster option
  // and a dead cluster both answer nothing, and only a read can tell them apart.
  assert.ok(
    report.silent.some((s) => s.target === 'd_0080'),
    'a group nothing answered on is recorded silent'
  );
  assert.ok(
    !report.modules.some((m) => m.via === 'd_0080'),
    'and never reported as a module'
  );
  ok('a silent group is recorded, never guessed at');

  // the xenon pair -- the whole reason for the union -- really got read
  assert.ok(
    report.modules.some((m) => m.via === 'd_xen_l') &&
      report.modules.some((m) => m.via === 'd_xen_r'),
    'both xenon groups were addressed'
  );
  ok('the unioned groups are read on the wire');

  // ---- an alias pair is one module, read once ------------------------------
  // ZKE is both d_0000 and d_zke_gm in ISTA's own tree, and both reach the
  // same module. The second must not be sent: ipoProtocolReport keys by the
  // variant that answered, so a duplicate read folds into the first record
  // and the scan would just be slower for nothing.
  const sent = [];
  const aliasReport = (
    await T.ecuTreeWalkStart('E46', {}, {
      ...walkDeps,
      run: async (sgbd) => {
        sent.push(sgbd);
        return { sets: [{}] };
      },
    }).done
  ).report;
  assert.strictEqual(
    sent.filter((s) => s === 'zke5').length,
    1,
    'the ZKE alias pair is read once, not twice'
  );
  ok('a group aliasing a module already read is skipped');

  assert.ok(
    !aliasReport.silent.some((s) => s.target === 'd_zke_gm'),
    'and the skipped alias is not reported silent'
  );
  ok('a skipped alias is not mistaken for a module that did not answer');

  // ---- an all-silent car is a missing cable, not a clean scan ---------------
  let threw = '';
  try {
    await T.ecuTreeWalkStart('E46', {}, {
      ...walkDeps,
      resolve: async () => null,
    }).done;
  } catch (e) {
    threw = String(e.message);
  }
  assert.match(threw, /No adapter connected/);
  ok('every address failing reads as no cable, not a clean car');

  // ---- a chassis ISTA has no tree for ---------------------------------------
  threw = '';
  try {
    await T.ecuTreeWalkStart('E31', {}, {
      ...walkDeps,
      tree: async () => null,
      extras: async () => [],
    }).done;
  } catch (e) {
    threw = String(e.message);
  }
  assert.match(threw, /no control unit tree/i);
  ok('a chassis with no tree says so');

  console.log(`test_tree_scan: ${passed} checks passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
