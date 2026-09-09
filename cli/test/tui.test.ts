// The terminal UI end to end, against the app's own runtime and a fake
// car: keys on the number row, the screen painted, a write asked first and
// abandoned on n, sent on y, an actuator released on quit through the
// app's own release-on-leave (the leaving menu's Back job, then inpaexit),
// and the home script picking a chassis and a module by number and filter.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadRuntime, setApiImpl, type IpoCell } from '../src/runtime.ts';
import { cellText, keyToPress, tuiCommand } from '../src/tui.ts';
import {
  compile,
  E46_CONFIG,
  fakeCar,
  fakeTerminal,
  MODULE_SOURCE,
  probeEcu,
  sysSet,
  waitFor,
} from './helpers.ts';

/** The car the probe module runs against. */
function car() {
  return fakeCar((job, arg, target) => {
    if (job === 'IDENT')
      return {
        job,
        system: sysSet(target, job),
        sets: [{ ID_SW_NR: '7 545 116' }],
      };
    if (job === 'STATUS_LESEN')
      return {
        job,
        system: sysSet(target, job),
        sets: [{ STAT_DREHZAHL_WERT: 3000, STAT_KL15: 1 }],
      };
    return {
      job,
      system: sysSet(target, job),
      sets: [{ JOB_STATUS: 'OKAY', ARG: arg || '' }],
    };
  });
}

test('keyToPress: the number row, the shifted bank, function keys, Esc and q', () => {
  const k = (ch: string, extra = {}) =>
    keyToPress({ name: '', ch, shift: false, ctrl: false, ...extra });
  assert.equal(k('1'), 1);
  assert.equal(k('0'), 10);
  assert.equal(k('!'), 11);
  assert.equal(k(')'), 20);
  assert.equal(
    keyToPress({ name: 'f3', ch: '', shift: false, ctrl: false }),
    3
  );
  assert.equal(
    keyToPress({ name: 'f3', ch: '', shift: true, ctrl: false }),
    13
  );
  assert.equal(
    keyToPress({ name: 'f11', ch: '', shift: false, ctrl: false }),
    null
  );
  assert.equal(
    keyToPress({ name: 'escape', ch: '', shift: false, ctrl: false }),
    'back'
  );
  assert.equal(k('q'), 'quit');
  assert.equal(
    keyToPress({ name: 'c', ch: '', shift: false, ctrl: true }),
    'quit'
  );
  assert.equal(k('x'), null);
});

test('cellText: a lamp is a dot and its word, a gauge a bar and its number', () => {
  const cell = (c: Partial<IpoCell>): IpoCell =>
    ({
      row: 0,
      lrow: 0,
      col: 0,
      text: '',
      key: null,
      kind: 'text',
      meta: null,
      ...c,
    }) as IpoCell;
  assert.equal(
    cellText(
      cell({ kind: 'lamp', text: 'on', meta: { on: 'on', off: 'off' } })
    ),
    '(*) on'
  );
  assert.equal(
    cellText(
      cell({ kind: 'lamp', text: 'off', meta: { on: 'on', off: 'off' } })
    ),
    '( ) off'
  );
  assert.equal(
    cellText(
      cell({ kind: 'gauge', text: '3000', meta: { min: 0, max: 6000 } })
    ),
    '[######......] 3000'
  );
  assert.equal(
    cellText(cell({ kind: 'gauge', text: 'n/a', meta: { min: 0, max: 6000 } })),
    'n/a'
  );
  assert.equal(cellText(cell({ kind: 'value', text: '812' })), '812');
});

test('a module in the terminal: paint, a declined write, an accepted one, release on quit', async () => {
  const exec = compile(MODULE_SOURCE, 'probe');
  const c = car();
  // prompts, in the order the run asks them: F3 declined, F3 accepted,
  // F4's actuator accepted
  const term = fakeTerminal(['n', 'y', 'y']);
  const run = tuiCommand('E46', 'probe', {
    noBus: true,
    apiFn: c.api,
    exec,
    ecu: probeEcu(),
    term,
  });
  await waitFor(
    () => /F2 Fault memory/.test(term.out),
    'the root menu painted'
  );
  assert.match(term.out, /Probe module  probe\.prg/, 'the title line');
  assert.match(term.out, /F3 Clear faults\*/, 'a key that writes is marked');
  assert.match(term.out, /F1 Ident   F2 Fault memory/, 'the key bar');
  assert.equal(
    c.sent.length,
    0,
    'opening the module sent nothing (the script has no INITIALISIERUNG)'
  );

  // F1: a read key, no question, the screen's own job runs and paints
  term.press('1');
  await waitFor(() => c.sent.some((s) => s.job === 'IDENT'), 'IDENT sent');
  await waitFor(() => /Software:/.test(term.out), 'the ident screen painted');
  assert.equal(term.prompts.length, 0, 'a read asks nothing');

  // F3: a clear; the confirm is declined, nothing goes to the car
  term.press('3');
  await waitFor(() => term.prompts.length === 1, 'the confirm prompt');
  assert.match(
    term.prompts[0] as string,
    /Run "Clear faults"\? It can send FS_LOESCHEN and FS_LOESCHEN writes/
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(!c.sent.some((s) => s.job === 'FS_LOESCHEN'), 'declined: not sent');

  // F3 again: accepted, sent once
  term.press('3');
  await waitFor(
    () => c.sent.some((s) => s.job === 'FS_LOESCHEN'),
    'accepted: sent'
  );
  assert.equal(c.sent.filter((s) => s.job === 'FS_LOESCHEN').length, 1);

  // F4: the actuator menu; its prologue energises STEUERN_X 1 after the
  // key's own confirm, and the menu's Back (STEUERN_X 0) is registered
  term.press('4');
  await waitFor(
    () => c.sent.some((s) => s.job === 'STEUERN_X' && s.arg === '1'),
    'STEUERN_X 1'
  );
  await waitFor(
    () => /Actuator energised/.test(term.out),
    'the actuator screen'
  );
  assert.equal(term.prompts.length, 3, 'the actuator key asked once');

  // q: leave with the actuator held. The app's release-on-leave sends the
  // leaving menu's Back job, then inpaexit's DIAGNOSE_ENDE.
  term.press('q');
  const r = await run;
  // the app's release-on-leave: the leaving menu's Back job (the actuator
  // released while the session is open), then inpaexit's DIAGNOSE_ENDE
  const tail = c.sent.slice(-2).map((s) => `${s.job} ${s.arg || ''}`.trim());
  assert.deepEqual(
    tail,
    ['STEUERN_X 0', 'DIAGNOSE_ENDE'],
    `release then exit: ${JSON.stringify(c.sent)}`
  );
  assert.ok(r.log.some((l) => l.job === 'STEUERN_X' && l.arg === '1'));
});

test("Esc is the script's own Back, and a cancelled prompt abandons the key", async () => {
  const exec = compile(MODULE_SOURCE, 'probe');
  const c = car();
  // F4 accepted (y); the Back key writes too (STEUERN_X 0) so the app asks
  // for it as well (y); then F3 with a cancelled prompt (null)
  const term = fakeTerminal(['y', 'y', null]);
  const run = tuiCommand('E46', 'probe', {
    noBus: true,
    apiFn: c.api,
    exec,
    ecu: probeEcu(),
    term,
  });
  await waitFor(() => /F4 Activate/.test(term.out), 'root menu');
  term.press('4');
  await waitFor(() => /SF10 Back|F10 Back/.test(term.out), 'the actuator menu');
  term.press('', { name: 'escape' });
  await waitFor(
    () => c.sent.some((s) => s.job === 'STEUERN_X' && s.arg === '0'),
    'Back released it'
  );
  await waitFor(
    () => /F2 Fault memory/.test(term.out),
    'back on the root menu'
  );
  term.press('3');
  await waitFor(() => term.prompts.length === 3, 'the clear asked');
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(
    !c.sent.some((s) => s.job === 'FS_LOESCHEN'),
    'a cancelled prompt sends nothing'
  );
  term.press('q');
  await run;
  assert.equal(
    c.sent[c.sent.length - 1]?.job,
    'DIAGNOSE_ENDE',
    'inpaexit on quit'
  );
});

test('the home: pick a chassis, filter and pick a module, land in its script; a cancel stays home', async () => {
  const R = loadRuntime();
  const exec = compile(MODULE_SOURCE, 'probe');
  const c = fakeCar(
    (job, _arg, target) => ({
      job,
      system: sysSet(target, job),
      sets: [{ JOB_STATUS: 'OKAY' }],
    }),
    {
      '/api/chassis': ['E39', 'E46'],
      '/api/chassis/E46': E46_CONFIG,
      '/api/ecu-index.json': { probe: 'E46', ms450ds0: 'E46' },
      '/api/ecu/probe/ipoexec': exec,
      '/data/groups/index.json': { groups: [] },
    }
  );
  // the runtime's own api: irLiveExec and ipoHomeEcuFor call it by name
  setApiImpl(c.api);
  try {
    // F1: the chassis list, "2" = E46; the module list filtered to "probe", then "1"
    const term = fakeTerminal(['2', 'probe', '1']);
    const run = tuiCommand(undefined, undefined, {
      noBus: true,
      term,
      version: '0.1.0-test',
    });
    await waitFor(() => /F1 Vehicle/.test(term.out), 'the home painted');
    assert.match(
      term.out,
      /BMWeb  bmweb_home\.prg/,
      "the home is the app's own script"
    );
    assert.match(
      term.out,
      /bmweb-cli 0\.1\.0-test  no cable/,
      'the status builtin reads the CLI host'
    );
    term.press('1');
    await waitFor(() => term.prompts.length >= 3, 'both picks asked');
    assert.match(term.prompts[0] as string, /Vehicles\n\s+1\. E39\n\s+2\. E46/);
    assert.match(term.prompts[1] as string, /Modules of E46/);
    assert.match(
      term.prompts[2] as string,
      /\(1 of 2\)\n\s+1\. Probe module/,
      'the filter narrowed the list'
    );
    await waitFor(
      () => /Probe module  probe\.prg/.test(term.out),
      'scriptchange landed in the module'
    );
    assert.match(term.out, /F2 Fault memory/, "the module's own keys");
    term.press('q');
    const r = await run;
    assert.equal(
      r.log[r.log.length - 1]?.job,
      'DIAGNOSE_ENDE',
      "the module's inpaexit ran on quit"
    );

    // a cancelled pick leaves the home where it was
    const term2 = fakeTerminal([null]);
    const run2 = tuiCommand(undefined, undefined, { noBus: true, term: term2 });
    await waitFor(() => /F1 Vehicle/.test(term2.out), 'home again');
    term2.press('1');
    await waitFor(() => term2.prompts.length === 1, 'the chassis pick asked');
    await new Promise((r) => setTimeout(r, 30));
    assert.match(
      term2.out.split('\x1b[H\x1b[2J').pop() as string,
      /F1 Vehicle/,
      'still on the home'
    );
    term2.press('q');
    await run2;
    assert.equal(R.IPO_HOME_SGBD, 'bmweb_home');
  } finally {
    setApiImpl(null);
  }
});
