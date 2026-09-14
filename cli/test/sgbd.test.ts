// What an SGBD declares, read with no cable: `job --info`, `sgbd jobs`,
// `sgbd tables` and `sgbd table`, plus the `--results` filter `job` gained.
// The site behind them is a fake one written here, in the shapes the real
// export writes (jobs.json a name array, results/<JOB>.json "NAME : comment"
// strings, arguments/<JOB>.json {job, arguments:[{ARG, ARGTYPE, ...}]},
// data/sgbd-tables/<sgbd>.json a table map, a group file with jobs and
// tables). No BMW data: every name below was made up for this test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CliError } from '../src/args.ts';
import { filterResults, jobCommand } from '../src/live.ts';
import { loadRuntime, type ApiFn } from '../src/runtime.ts';
import {
  isGroupName,
  jobInfo,
  jobInfoCommand,
  sgbdJobNames,
  sgbdJobsCommand,
  sgbdTableCommand,
  sgbdTablesCommand,
  tableColumns,
} from '../src/sgbd.ts';
import { fakeCar, sysSet } from './helpers.ts';

/** The routes a fake site answers, in the shapes the real export writes. */
const SITE_ROUTES: Record<string, unknown> = {
  // jobs.json: the sorted names, as the web build writes them
  '/api/ecu/probe/jobs': ['PROBE_LESEN', 'PROBE_SCHREIBEN', 'STATUS_LESEN'],
  '/api/ecu/probe/results/PROBE_LESEN': [
    'JOB_STATUS : OKAY when the read succeeded',
    'PROBE_WERT : the measured value',
    'PROBE_EINH : its unit',
  ],
  '/api/ecu/probe/results/PROBE_SCHREIBEN': ['JOB_STATUS : OKAY when written'],
  '/api/ecu/probe/results/STATUS_LESEN': [
    // a spec-build shape, to prove both are read
    { name: 'STAT_A', comment: 'first value' },
    { name: 'STAT_B', unit: '1/min' },
  ],
  '/api/ecu/probe/arguments/PROBE_SCHREIBEN': {
    job: 'PROBE_SCHREIBEN',
    arguments: [
      {
        ARG: 'WERT',
        ARGTYPE: 'int',
        ARGCOMMENT0: 'the value to write,',
        ARGCOMMENT1: '0 to 255',
      },
      { ARG: 'MODE', ARGTYPE: 'string' },
    ],
  },
  '/data/sgbd-tables/probe.json': {
    PROBE_BITS: [
      { NAME: 'STAT_A_ON', BYTE: '0', MASK: '0x01' },
      { NAME: 'STAT_B_ON', BYTE: '0', MASK: '0x02' },
    ],
    UNITS: [{ NR: '1', TEXT: 'volt' }],
  },
  // the shipped group list, which is what says a name is a group
  '/data/groups/index.json': { format: 1, groups: ['d_9999', 'g_probe'] },
  // a group file: job names and the tables its probe reads, no declarations
  '/data/groups/d_9999.json.gz': {
    format: 1,
    sgbd: 'D_9999',
    jobs: { IDENTIFIKATION: 0, INITIALISIERUNG: 0 },
    tables: {
      HW_TABELLE: [
        { HARDWARENR: '000000000001', VARIANTE: 'PROBE' },
        { HARDWARENR: '000000000002', VARIANTE: 'PROBE2' },
      ],
    },
  },
};

/** The fake site as an engine client, with no car behind it. */
function site(): ApiFn {
  return fakeCar(() => new Error('nothing is sent for a declaration'), {
    ...SITE_ROUTES,
  }).api;
}

test('the job names come off jobs.json in either shape', async () => {
  const api = site();
  assert.deepEqual(await sgbdJobNames('PROBE', api), [
    'PROBE_LESEN',
    'PROBE_SCHREIBEN',
    'STATUS_LESEN',
  ]);
  // the spec object {jobs:[...]}, whose entries may be objects
  const spec = fakeCar(() => new Error('no car'), {
    '/api/ecu/other/jobs': {
      jobs: [{ name: 'B_LESEN' }, 'A_LESEN', { name: 'A_LESEN' }],
    },
  }).api;
  assert.deepEqual(await sgbdJobNames('other', spec), ['A_LESEN', 'B_LESEN']);
  await assert.rejects(
    sgbdJobNames('nothere', site()),
    (e: unknown) => e instanceof CliError && /no module nothere/.test(e.message)
  );
});

test('job --info reads the declaration and sends nothing', async () => {
  const api = site();
  const info = await jobInfo('probe', 'probe_schreiben', api);
  assert.equal(info.sgbd, 'probe');
  assert.equal(info.job, 'PROBE_SCHREIBEN');
  assert.equal(info.write, true, "the app's classifier calls a write a write");
  assert.deepEqual(info.args, [
    { name: 'WERT', type: 'int', comment: 'the value to write, 0 to 255' },
    { name: 'MODE', type: 'string', comment: '' },
  ]);
  assert.deepEqual(info.results, [
    { name: 'JOB_STATUS', comment: 'OKAY when written' },
  ]);
  // a read job, both result shapes normalised, and no arguments declared
  const read = await jobInfo('probe', 'STATUS_LESEN', api);
  assert.equal(read.write, false);
  assert.deepEqual(read.args, []);
  assert.deepEqual(read.results, [
    { name: 'STAT_A', comment: 'first value' },
    { name: 'STAT_B', comment: '1/min' },
  ]);
  // a job the SGBD does not declare is named, with the near misses
  await assert.rejects(
    jobInfo('probe', 'PROBE_XYZ', site()),
    (e: unknown) =>
      e instanceof CliError && /declares no job PROBE_XYZ/.test(e.message)
  );
  await assert.rejects(
    jobInfo('probe', 'LESEN', site()),
    (e: unknown) => e instanceof CliError && /did you mean/.test(e.message)
  );
});

test('job --info prints its arguments and results, and the same as JSON', async () => {
  const lines = await jobInfoCommand('probe', 'PROBE_SCHREIBEN', {
    apiFn: site(),
  });
  const text = lines.join('\n');
  assert.match(text, /^probe PROBE_SCHREIBEN {2}\[WRITE\]/);
  assert.match(
    text,
    /arguments \(2\)\n\s+WERT\s+int\s+the value to write, 0 to 255/
  );
  assert.match(text, /MODE\s+string/);
  assert.match(text, /results \(1\)\n\s+JOB_STATUS\s+OKAY when written/);
  // a job with neither says so rather than printing an empty table
  const bare = (
    await jobInfoCommand('probe', 'PROBE_LESEN', { apiFn: site() })
  ).join('\n');
  assert.match(bare, /arguments \(0\)\n {2}none declared/);
  assert.doesNotMatch(bare, /\[WRITE\]/);
  const json = JSON.parse(
    (
      await jobInfoCommand('probe', 'PROBE_SCHREIBEN', {
        apiFn: site(),
        json: true,
      })
    ).join('')
  );
  assert.equal(json.job, 'PROBE_SCHREIBEN');
  assert.equal(json.write, true);
  assert.equal(json.args.length, 2);
  assert.equal(json.results[0].name, 'JOB_STATUS');
});

test('sgbd jobs: a row per job, the write column from the app classifier', async () => {
  const R = loadRuntime();
  assert.equal(R.isWriteJob('PROBE_SCHREIBEN'), true);
  assert.equal(R.isWriteJob('PROBE_LESEN'), false);
  const lines = await sgbdJobsCommand('PROBE', { apiFn: site() });
  const text = lines.join('\n');
  assert.match(text, /^NAME\s+ARGS\s+RESULTS\s+COMMENT\s+WRITE$/m);
  assert.match(
    text,
    /PROBE_LESEN\s+JOB_STATUS, PROBE_WERT, PROBE_EINH\s+OKAY when the read succeeded$/m
  );
  assert.match(text, /PROBE_SCHREIBEN\s+WERT, MODE\s+JOB_STATUS\s+.*\syes$/m);
  assert.match(text, /3 jobs, 1 the app would ask about before sending/);
  const json = JSON.parse(
    (await sgbdJobsCommand('probe', { apiFn: site(), json: true })).join('')
  );
  assert.equal(json.sgbd, 'probe');
  assert.equal(json.group, false);
  assert.equal(json.jobs.length, 3);
  // the JSON keeps every result name, however many the table cell showed
  assert.deepEqual(
    json.jobs.find((j: { job: string }) => j.job === 'PROBE_LESEN').results
      .length,
    3
  );
});

test('sgbd tables: every table with its shape, and one table printed', async () => {
  const lines = await sgbdTablesCommand('probe', { apiFn: site() });
  const text = lines.join('\n');
  assert.match(text, /^NAME\s+ROWS\s+COLS\s+COLUMNS$/m);
  assert.match(text, /^PROBE_BITS\s+2\s+3\s+NAME, BYTE, MASK$/m);
  assert.match(text, /^UNITS\s+1\s+2\s+NR, TEXT$/m);
  assert.match(text, /2 tables \(bmweb sgbd table probe <NAME> prints one\)/);
  const rows = (
    await sgbdTableCommand('probe', 'probe_bits', { apiFn: site() })
  ).join('\n');
  assert.match(rows, /^NAME\s+BYTE\s+MASK$/m);
  assert.match(rows, /^STAT_A_ON\s+0\s+0x01$/m);
  assert.match(rows, /2 rows in PROBE_BITS/);
  const json = JSON.parse(
    (
      await sgbdTableCommand('probe', 'UNITS', { apiFn: site(), json: true })
    ).join('')
  );
  assert.deepEqual(json, {
    sgbd: 'probe',
    table: 'UNITS',
    rows: [{ NR: '1', TEXT: 'volt' }],
  });
  await assert.rejects(
    sgbdTableCommand('probe', 'NOPE', { apiFn: site() }),
    (e: unknown) =>
      e instanceof CliError && /carries no table NOPE/.test(e.message)
  );
  await assert.rejects(
    sgbdTableCommand('probe', 'BITS', { apiFn: site() }),
    (e: unknown) =>
      e instanceof CliError && /did you mean PROBE_BITS/.test(e.message)
  );
});

test('a group is read from its group file, not resolved on the wire', async () => {
  // the shipped index decides, not the shape of the name: a group not in it
  // is looked for as a module, and a listed one that is not d_XXXX is a group
  const api = site();
  assert.equal(await isGroupName('D_9999', api), true);
  assert.equal(await isGroupName('g_probe', api), true);
  assert.equal(await isGroupName('d_0012', api), false, 'not in this index');
  assert.equal(await isGroupName('probe', api), false);
  assert.equal(await isGroupName('', api), false);
  const jobs = (await sgbdJobsCommand('D_9999', { apiFn: site() })).join('\n');
  assert.match(jobs, /^IDENTIFIKATION\s*$/m);
  assert.match(jobs, /a group file carries job names, not declarations/);
  assert.match(jobs, /2 jobs, 1 the app would ask about before sending/);
  const tables = (await sgbdTablesCommand('d_9999', { apiFn: site() })).join(
    '\n'
  );
  assert.match(tables, /^HW_TABELLE\s+2\s+2\s+HARDWARENR, VARIANTE$/m);
  // a listed group whose file the site does not serve is the site's fault,
  // and is reported as that rather than as a name the user got wrong
  await assert.rejects(
    sgbdJobsCommand('g_probe', { apiFn: site() }),
    (e: unknown) =>
      e instanceof CliError &&
      /lists group g_probe but serves no bytecode/.test(e.message)
  );
});

test('tableColumns takes the first row as the header and folds in later keys', () => {
  assert.deepEqual(tableColumns([{ B: 1, A: 2 }, { C: 3 }]), ['B', 'A', 'C']);
  assert.deepEqual(tableColumns([]), []);
});

test('--results keeps only the named results, in the set order, warning on a miss', async () => {
  const car = fakeCar((job, arg, target) => ({
    job,
    system: sysSet(target, job),
    sets: [
      { STAT_A: 1, STAT_B: 2, JOB_STATUS: 'OKAY' },
      { STAT_A: 3, STAT_C: 4 },
    ],
  }));
  const warned: string[] = [];
  const lines = await jobCommand('probe', 'STATUS_LESEN', {
    apiFn: car.api,
    // typed in the other order and in the other case: the set's own order
    // decides, and the match ignores case
    results: ['job_status', 'STAT_A', 'STAT_ZZ'],
    warn: (l) => warned.push(l),
  });
  const text = lines.join('\n');
  assert.match(text, /set 1\n\s+STAT_A\s+1\n\s+JOB_STATUS\s+OKAY/);
  assert.doesNotMatch(text, /STAT_B/);
  assert.match(text, /set 2\n\s+STAT_A\s+3/);
  assert.doesNotMatch(text, /STAT_C/);
  assert.equal(warned.length, 1);
  assert.match(warned[0] as string, /returned no result named STAT_ZZ/);
  // the JSON is filtered the same way, so the two never disagree
  const json = JSON.parse(
    (
      await jobCommand('probe', 'STATUS_LESEN', {
        apiFn: car.api,
        results: ['STAT_A'],
        json: true,
        warn: () => {},
      })
    ).join('')
  );
  assert.deepEqual(json.sets, [{ STAT_A: 1 }, { STAT_A: 3 }]);
  // no --results at all leaves every set whole
  const all = await jobCommand('probe', 'STATUS_LESEN', { apiFn: car.api });
  assert.match(all.join('\n'), /STAT_B\s+2/);
});

test('filterResults keeps an emptied set rather than dropping it', () => {
  const f = filterResults([{ A: 1 }, { B: 2 }], ['A']);
  assert.deepEqual(f.sets, [{ A: 1 }, {}]);
  assert.deepEqual(f.missing, []);
  assert.deepEqual(filterResults([{ A: 1 }], ['Z']).missing, ['Z']);
});
