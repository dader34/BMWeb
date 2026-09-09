// The whole-vehicle scan against a fake car: the script's fault-memory key
// is found by caption and pressed, its reads fold into the app's report
// (one module per group that answered, the silent one listed), the table
// prints, and the share link decodes back to the same report through the
// app's own codec.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CliError } from '../src/args.ts';
import { decodeReport } from '../src/report.ts';
import { loadRuntime } from '../src/runtime.ts';
import { headlessUi, scanCommand } from '../src/scan.ts';
import { compile, fakeCar, sysSet, VEHICLE_SOURCE } from './helpers.ts';

/** The car: the engine answers two faults, the gearbox address is silent. */
function e46() {
  return fakeCar(
    (job, _arg, target) => {
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
              F_VORHANDEN_TEXT: 'Fehler momentan vorhanden',
            },
            { F_ORT_NR: 120, F_ORT_TEXT: 'Lambda heater', F_HFK: 1 },
          ],
        };
      if (target === 'd_0044')
        return new Error('d_0044: no module answered on the wire');
      return {
        job,
        system: sysSet(target, job),
        sets: [{ JOB_STATUS: 'OKAY' }],
      };
    },
    {},
    { d_motor: 'ms450ds0' }
  );
}

test('scan: the read key is pressed, the report folds the reads, the table and link print', async () => {
  const car = e46();
  const exec = compile(VEHICLE_SOURCE, 'e46');
  const progress: string[] = [];
  const r = await scanCommand('e46', {
    exec,
    apiFn: car.api,
    share: true,
    label: 'E46 325i',
    progress: (l) => progress.push(l),
  });
  assert.deepEqual(
    car.sent.map((s) => `${s.target}:${s.job}`),
    ['ms450ds0:FS_LESEN', 'd_0044:FS_LESEN'],
    'both groups asked, in script order'
  );
  assert.equal(r.report.kind, 'faults');
  assert.equal(r.report.modules.length, 1);
  assert.equal(r.report.modules[0]?.sgbd, 'ms450ds0');
  assert.equal(r.report.modules[0]?.via, 'd_motor');
  assert.equal(r.report.modules[0]?.codes?.length, 2);
  assert.deepEqual(
    Array.from(r.report.silent || [], (s) => s.target),
    ['d_0044'],
    'the address that did not answer'
  );
  const text = r.lines.join('\n');
  assert.match(text, /Scan\s+E46 fault memories/);
  assert.match(text, /Modules\s+1 answered, 1 with faults, 2 faults, 1 silent/);
  // the module is labelled as the report names it: the SGBD that answered
  // (a real script's overview line would name it); the state column reads
  // the wording the runtime translated
  assert.match(text, /^ms450ds0\s+27C3\s+DMTL pump\s+3\s+present$/m);
  assert.match(text, /^ms450ds0\s+120\s+Lambda heater\s+1$/m);
  assert.match(text, /Silent \(1\):\n\s+D_0044/);
  assert.ok(r.link && r.link.startsWith('https://bmweb.danner.ink/#report/'));
  assert.match(text, /^Share: https:\/\/bmweb\.danner\.ink\/#report\//m);
  // the progress window's lines reached the caller
  assert.ok(
    progress.some((l) => /FS lesen \(F1\)/.test(l)),
    `the key: ${progress}`
  );
  assert.ok(
    progress.includes('Engine') && progress.includes('Gearbox'),
    `userbox lines: ${progress}`
  );
  // the link carries the same report, VIN-free, through the app's decoder
  const p = await decodeReport(r.link as string);
  assert.equal(p.chassis, 'E46');
  assert.equal(p.label, 'E46 325i');
  assert.equal(p.report.modules[0]?.codes?.[0]?.F_HEX_CODE, '27-C3-22');
  assert.equal(p.summary?.faults, 2);
});

test('scan --json carries the report and the summary', async () => {
  const car = e46();
  const r = await scanCommand('E46', {
    exec: compile(VEHICLE_SOURCE, 'e46'),
    apiFn: car.api,
    json: true,
    progress: () => {},
  });
  const doc = JSON.parse(r.lines.join(''));
  assert.equal(doc.chassis, 'E46');
  assert.equal(doc.summary.silent, 1);
  assert.equal(doc.report.modules[0].sgbd, 'ms450ds0');
});

test('scan refuses a chassis without a whole-vehicle script, and a script without the key', async () => {
  await assert.rejects(
    scanCommand('E39', {
      apiFn: fakeCar(() => new Error('x')).api,
      progress: () => {},
    }),
    (e: unknown) =>
      e instanceof CliError && /no whole-vehicle script for E39/.test(e.message)
  );
  // a script whose menu has no fault-read key: the keys it has are named
  const R = loadRuntime();
  const src = VEHICLE_SOURCE.replace('"FS lesen"', '"Something else"');
  const r = R.ipofCompileSource(src, {
    name: 'e46',
    files: { 'probe.h': 'extern setmenutitle(in: string t);\n' },
  });
  assert.ok(r.ok && r.exec);
  await assert.rejects(
    scanCommand('E46', {
      exec: r.exec as never,
      apiFn: fakeCar(() => new Error('x')).api,
      progress: () => {},
    }),
    (e: unknown) =>
      e instanceof CliError &&
      /no fault-memory read key on m_fs \(keys: F1 Something else/.test(
        e.message
      )
  );
});

test('the headless adapter answers every dialog the read-only way', async () => {
  const lines: string[] = [];
  const ui = headlessUi((l) => lines.push(l));
  assert.equal(
    await ui.confirmKey(null as never, null as never, [], []),
    false
  );
  assert.equal(
    await ui.confirmWrite(null as never, 'X', null, { label: 'k', scope: 's' }),
    false
  );
  assert.equal(await ui.askInput({ kind: 'input' }, undefined), null);
  assert.equal(await ui.pickComponent(null as never, { kind: 'toggle' }), null);
  assert.equal(
    await ui.machineTick(null as never, { kind: 'yield' }, new Set()),
    'tick'
  );
  await ui.message('Title', 'Body');
  assert.deepEqual(lines, ['Title: Body']);
});
