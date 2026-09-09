// The `job` command against a fake car, and the pieces around it: the
// write gate (the app's classifier decides; a write goes only with --yes
// or a y answer, and never without a terminal), the answer table, the port
// listing, and the module record prepared the way the app prepares it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CliError } from '../src/args.ts';
import {
  formatAnswer,
  jobCommand,
  openModule,
  portsCommand,
  valueText,
} from '../src/live.ts';
import { loadRuntime, setApiImpl } from '../src/runtime.ts';
import {
  compile,
  E46_CONFIG,
  fakeCar,
  MODULE_SOURCE,
  sysSet,
} from './helpers.ts';

const car = fakeCar((job, arg, target) => {
  if (job === 'STATUS_LESEN')
    return {
      job,
      system: sysSet(target, job),
      sets: [
        {
          STAT_DREHZAHL_WERT: 812.5,
          STAT_DREHZAHL_EINH: '1/min',
          JOB_STATUS: 'OKAY',
        },
        { STAT_KL15: 1 },
      ],
    };
  if (job === 'FS_LOESCHEN')
    return { job, system: sysSet(target, job), sets: [{ JOB_STATUS: 'OKAY' }] };
  if (job === 'NOPE')
    return new Error(
      'IFH-0003: echo did not match the request (bus collision?)'
    );
  return {
    job,
    system: sysSet(target, job),
    sets: [{ JOB_STATUS: 'OKAY', ARG: arg || '' }],
  };
});

test('a read runs without a question and prints its sets', async () => {
  car.sent.length = 0;
  const lines = await jobCommand('MS450DS0', 'status_lesen', {
    apiFn: car.api,
  });
  assert.deepEqual(car.sent, [
    { target: 'ms450ds0', job: 'STATUS_LESEN', arg: null },
  ]);
  const text = lines.join('\n');
  assert.match(text, /^ms450ds0 MS450DS0 STATUS_LESEN: 2 sets/);
  assert.match(text, /set 1\n\s+STAT_DREHZAHL_WERT\s+812\.5/);
  assert.match(text, /STAT_DREHZAHL_EINH\s+1\/min/);
  assert.match(text, /set 2\n\s+STAT_KL15\s+1/);
  const json = JSON.parse(
    (
      await jobCommand('ms450ds0', 'STATUS_LESEN', {
        apiFn: car.api,
        json: true,
      })
    ).join('')
  );
  assert.equal(json.sets.length, 2);
});

test('the argument travels with the job', async () => {
  car.sent.length = 0;
  await jobCommand('ms450ds0', 'STATUS_LESEN', { apiFn: car.api, arg: 'A;B' });
  assert.equal(car.sent[0]?.arg, 'A;B');
});

test('a write is not sent without consent: refused, declined, then sent with y and with --yes', async () => {
  const R = loadRuntime();
  assert.equal(
    R.isWriteJob('FS_LOESCHEN'),
    true,
    'the app calls a clear a write'
  );
  car.sent.length = 0;
  // no terminal, no --yes: the default asker says no
  const refused = await jobCommand('ms450ds0', 'FS_LOESCHEN', {
    apiFn: car.api,
    confirm: async () => false,
  });
  assert.match(refused[0] as string, /not sent/);
  assert.equal(car.sent.length, 0, 'nothing reached the car');
  // a y answer sends it
  const asked: string[] = [];
  await jobCommand('ms450ds0', 'FS_LOESCHEN', {
    apiFn: car.api,
    confirm: async (q) => {
      asked.push(q);
      return true;
    },
  });
  assert.equal(asked.length, 1);
  assert.match(asked[0] as string, /FS_LOESCHEN on ms450ds0 is a write/);
  assert.deepEqual(
    car.sent.map((s) => s.job),
    ['FS_LOESCHEN']
  );
  // --yes sends it without a question
  const none = await jobCommand('ms450ds0', 'FS_LOESCHEN', {
    apiFn: car.api,
    yes: true,
    confirm: async () => {
      throw new Error('must not ask');
    },
  });
  assert.match(none[0] as string, /FS_LOESCHEN: 1 set/);
});

test('an unknown job name is a write too (default-deny), a read token wins', async () => {
  const R = loadRuntime();
  assert.equal(R.isWriteJob('SOMETHING_ODD'), true);
  assert.equal(R.isWriteJob('ODD_LESEN'), false);
  car.sent.length = 0;
  await jobCommand('ms450ds0', 'SOMETHING_ODD', {
    apiFn: car.api,
    confirm: async () => false,
  });
  assert.equal(car.sent.length, 0);
});

test('a wire error is one line, and an echo failure carries the FTDI hint', async () => {
  await assert.rejects(
    jobCommand('ms450ds0', 'NOPE', { apiFn: car.api, yes: true }),
    (e: unknown) =>
      e instanceof CliError &&
      /IFH-0003/.test(e.message) &&
      /latency timer to 1 ms/.test(e.message)
  );
});

test('formatAnswer and valueText: bytes as dashed hex, objects as JSON', () => {
  assert.equal(valueText([0x27, 0xc3, 0x22]), '27-C3-22');
  assert.equal(valueText(null), '');
  assert.equal(valueText({ a: 1 }), '{"a":1}');
  const lines = formatAnswer({
    job: 'X',
    system: sysSet('ms450ds0', 'X'),
    sets: [],
  });
  assert.equal(lines[0], 'ms450ds0 MS450DS0 X: 0 sets');
});

test('ports: the candidates as a table, or a plain line when there are none', async () => {
  const lines = await portsCommand(false, [
    { path: '/dev/cu.usbserial-AB12', detail: 'FTDI  0403:6001' },
  ]);
  assert.match(
    lines[0] as string,
    /^\/dev\/cu\.usbserial-AB12\s+FTDI\s+0403:6001$/
  );
  assert.match(
    (await portsCommand(false, []))[0] as string,
    /no candidate ports/
  );
  const json = JSON.parse(
    (await portsCommand(true, [{ path: '/dev/ttyUSB0', detail: '' }])).join('')
  );
  assert.equal(json[0].path, '/dev/ttyUSB0');
});

test("openModule: the car's own config row, prepared, and its script loaded", async () => {
  const exec = compile(MODULE_SOURCE, 'probe');
  const site = fakeCar(() => new Error('no car'), {
    '/api/chassis/E46': E46_CONFIG,
    '/api/ecu-index.json': { probe: 'E46', ms450ds0: 'E46' },
    '/api/ecu/probe/ipoexec': exec,
    '/api/ecu/ms450ds0/ipoexec': exec,
    '/data/groups/index.json': { groups: [] },
  });
  setApiImpl(site.api);
  try {
    const { ecu, exec: loaded } = await openModule('e46', 'PROBE', site.api);
    assert.equal(ecu.sgbd, 'probe');
    assert.equal(ecu.label, 'Probe module');
    assert.equal(ecu.chassis, 'E46');
    assert.equal(ecu._variantSource, 'ungrouped');
    assert.ok(ecu._ipoKnownSgbds && ecu._ipoKnownSgbds.has('ms450ds0'));
    assert.ok(loaded.procs.inpainit);
    // a grouped module whose group the build does not ship stays on its
    // configured SGBD, and says why
    const { ecu: ms } = await openModule('E46', 'ms450ds0', site.api);
    assert.equal(ms.sgbd, 'ms450ds0');
    assert.equal(ms._variantSource, 'nogroup');
    await assert.rejects(
      openModule('E46', 'zzz', site.api),
      (e: unknown) =>
        e instanceof CliError && /carries no module zzz/.test(e.message)
    );
    await assert.rejects(
      openModule('E99', 'probe', site.api),
      (e: unknown) => e instanceof CliError && /no chassis E99/.test(e.message)
    );
  } finally {
    setApiImpl(null);
  }
});
