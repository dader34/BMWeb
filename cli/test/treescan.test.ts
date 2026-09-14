// The tree-driven whole-vehicle scan against a fake car: the targets come
// from ISTA's control unit tree (plus the groups only INPA's script names),
// each one is addressed by its group, and the reads fold into the app's own
// report -- the same shape `bmweb scan` prints for the script path, so the
// two scanners are interchangeable to everything downstream.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadRuntime } from '../src/runtime.ts';
import { scanCommand } from '../src/scan.ts';
import { fakeCar, sysSet } from './helpers.ts';

/** A tree in ISTA's real shape: an alias pair, a drawn module, a hidden one. */
const TREE = {
  series: 'T46',
  mainSgbd: 'zcs_all',
  ecus: [
    { name: 'ZKE', addr: 0, groups: ['d_0000', 'd_zke_gm'], bus: 'KBUS' },
    { name: 'DME', addr: 18, groups: ['d_0012'], bus: 'FACAN' },
    { name: 'EGS', addr: 24, groups: ['d_egs'], bus: 'FACAN' },
    { name: 'SM/SPM', addr: 113, groups: ['d_0071'], bus: 'UNKNOWN' },
  ],
  buses: [],
};
/** What ISTA's tree does not carry but INPA's E46 script reads. */
const EXTRAS = [{ group: 'd_xen_l', label: 'Licht Xenon links' }];

/** The car: the engine holds a fault, the gearbox is not fitted. */
function car() {
  return fakeCar((job, _arg, target) => {
    if (job === 'FS_LESEN' && target === 'ms450ds0')
      return {
        job,
        system: sysSet('ms450ds0', job),
        sets: [
          {
            F_ORT_NR: 39,
            F_HEX_CODE: '27-C3-22',
            F_ORT_TEXT: '27C3 DMTL pump',
            F_HFK: 3,
          },
        ],
      };
    return { job, system: sysSet(target, job), sets: [{ JOB_STATUS: 'OKAY' }] };
  });
}

/** The walk's dependencies: the tree, the extras, the bus, the job lists. */
function deps() {
  return {
    tree: async () => TREE,
    extras: async () => EXTRAS,
    // d_egs is an option this car does not have: nothing answers there
    resolve: async (g: string) =>
      (
        ({
          d_0000: 'zke5',
          d_zke_gm: 'zke5',
          d_0012: 'ms450ds0',
          d_xen_l: 'xenon_l',
        }) as Record<string, string>
      )[g] || null,
    jobNames: async () => ['IDENT', 'FS_LESEN', 'FS_LESEN_DETAIL'],
  };
}

test('the tree scan reads every module the tree carries', async () => {
  const R = loadRuntime();
  const targets = await R.ecuTreeWalkTargets('E46', deps());
  // joined, not deep-equal: the runtime builds its arrays inside a node:vm
  // context, so they are a different realm's Array and fail deepStrictEqual
  // against this file's even when every element matches
  assert.equal(
    targets.map((t) => t.group).join(' '),
    'd_0000 d_zke_gm d_0012 d_egs d_xen_l',
    'drawn groups in tree order, the hidden bus skipped, the extra last'
  );
});

test('the report folds exactly as the script path does', async () => {
  const R = loadRuntime();
  const { api, sent } = car();
  const { report } = await R.ecuTreeWalkStart(
    'E46',
    {},
    {
      ...deps(),
      run: (sgbd: string, job: string) =>
        api(`/api/ecu/${sgbd}/run/${job}`, { method: 'POST' }),
    }
  ).done;

  assert.equal(report.kind, 'faults');
  const dme = report.modules.find((m) => m.sgbd === 'ms450ds0');
  assert.ok(dme, 'the engine answered');
  assert.equal(dme.via, 'd_0012', 'reached through its group');
  assert.equal(dme.codes?.length, 1, 'its one fault');

  // an option the car does not have is SILENT, never a clean module
  assert.ok(
    (report.silent || []).some((s) => s.target === 'd_egs'),
    'the unfitted gearbox is recorded silent'
  );
  assert.ok(
    !report.modules.some((m) => m.via === 'd_egs'),
    'and is not reported as a module'
  );

  // the union is the point: the group only INPA's script names was read
  assert.ok(
    report.modules.some((m) => m.via === 'd_xen_l'),
    'the script-only group was addressed'
  );

  // the ZKE alias pair is one module: reading it twice would lose the second
  assert.equal(
    sent.filter((s) => s.target === 'zke5' && s.job === 'FS_LESEN').length,
    1,
    'the alias pair is read once'
  );
});

test('a chassis ISTA draws no tree for says so', async () => {
  const R = loadRuntime();
  await assert.rejects(
    R.ecuTreeWalkStart(
      'E31',
      {},
      {
        tree: async () => null,
        extras: async () => [],
      }
    ).done,
    /no control unit tree/i
  );
});

test('scan --tree refuses a chassis with no tree', async () => {
  const { api } = car();
  await assert.rejects(
    scanCommand('ZZ9', { tree: true, apiFn: api, progress: () => {} }),
    /no control unit tree/i
  );
});
