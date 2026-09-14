// The terminal UI end to end, against the app's own runtime and a fake
// car: keys on the number row, the screen painted, a write asked first and
// abandoned on n, sent on y, an actuator released on quit through the
// app's own release-on-leave (the leaving menu's Back job, then inpaexit),
// and the home script picking a chassis and a module by number and filter.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  loadRuntime,
  setApiImpl,
  type IpoCell,
  type IpoProgramLike,
} from '../src/runtime.ts';
import { cellText, keyToPress, tuiCommand, TuiUi } from '../src/tui.ts';
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
    // F1: the chassis picker, Down + Enter = E46; the module picker typed
    // down to "probe", Enter
    const term = fakeTerminal([]);
    const key = (name: string): void => term.press('', { name });
    const type = (text: string): void => {
      for (const ch of text) term.press(ch, { name: ch });
    };
    /** the frame on screen: what the last clear-and-home drew */
    const screen = (t: { out: string }): string =>
      t.out.split('\x1b[2J\x1b[H').pop() as string;
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
    await waitFor(() => /Vehicles/.test(screen(term)), 'the chassis picker');
    assert.match(
      screen(term),
      /\x1b\[7m > E39 +\x1b\[0m\x1b\[K\r\n\r   E46/,
      'the bar on the first row'
    );
    key('down');
    await waitFor(
      () => /\x1b\[7m > E46/.test(screen(term)),
      'the bar moved to E46'
    );
    assert.match(
      screen(term),
      /   E39\x1b\[K\r\n\r\x1b\[7m > E46/,
      'only the moved rows redrawn'
    );
    key('return');
    await waitFor(
      () => /Modules of E46/.test(screen(term)),
      'the module picker'
    );
    assert.match(screen(term), /\(2\)/, 'both modules listed');
    type('probe');
    await waitFor(
      () => /\(1 of 2\)/.test(screen(term)),
      'typing narrowed the list'
    );
    assert.match(
      screen(term),
      /Filter:\x1b\[0m probe/,
      'the filter shows what was typed'
    );
    assert.match(
      screen(term),
      /\x1b\[7m > Probe module/,
      'the bar on the one match'
    );
    assert.equal(term.prompts.length, 0, 'no typed prompt for a list');
    key('return');
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
    const term2 = fakeTerminal([]);
    const run2 = tuiCommand(undefined, undefined, { noBus: true, term: term2 });
    await waitFor(() => /F1 Vehicle/.test(term2.out), 'home again');
    term2.press('1');
    await waitFor(() => /Vehicles/.test(screen(term2)), 'the chassis picker');
    term2.press('', { name: 'escape' });
    await waitFor(() => /F1 Vehicle/.test(screen(term2)), 'still on the home');
    term2.press('q');
    await run2;
    assert.equal(R.IPO_HOME_SGBD, 'bmweb_home');
  } finally {
    setApiImpl(null);
  }
});

/** A program with one screen, enough for the painter. */
function stubProgram(): IpoProgramLike {
  return {
    ecu: { sgbd: 'probe', label: 'Probe module' },
    title: 'Main',
    items: [
      { nr: 1, label: 'Ident', start: 0, end: 0 },
      { nr: 2, label: 'Fault memory', start: 0, end: 0 },
    ],
    cells: new Map([
      ['0:0', { row: 0, col: 0, text: 'Battery', kind: 'text' }],
      ['0:20', { row: 0, col: 20, text: '12.4 V', kind: 'text' }],
    ]),
    view: null,
    menu: 'm_main',
    exec: { procs: {} },
  } as unknown as IpoProgramLike;
}

test('paint redraws the frame in place: clear once, nothing on a repaint, only the changed line on a status, fresh after a prompt and a resize', async () => {
  const R = loadRuntime();
  const term = fakeTerminal(['']);
  const ui = new TuiUi(term, R, null);
  const p = stubProgram();
  ui.attach(p);
  ui.paint(p);
  const first = term.out;
  assert.match(
    first,
    /^\x1b\[2J\x1b\[H/,
    'the first frame clears the (alternate) screen once'
  );
  assert.match(first, /Probe module  probe\.prg  Main/, 'the title');
  assert.match(first, /Battery\s+12\.4 V/, 'the grid row');
  assert.match(first, /F1 Ident   F2 Fault memory/, 'the key bar');
  const lines = first.split('\r\n').filter((l) => l !== '');
  ui.paint(p);
  assert.equal(term.out, first, 'an unchanged frame writes nothing');
  ui.status(p, 'ready');
  const delta = term.out.slice(first.length);
  assert.match(delta, /^\x1b\[H/, 'goes to the top of the frame, no clear');
  assert.doesNotMatch(delta, /\x1b\[2J/, 'a repaint never clears');
  assert.equal(
    (delta.match(/\x1b\[K/g) || []).length,
    1,
    'rewrites exactly one line (the status)'
  );
  assert.match(delta, /\rready\x1b\[K\r\n/, 'the status line');
  assert.equal(
    (delta.match(/\x1b\[B/g) || []).length,
    lines.length - 1,
    'steps over every unchanged line'
  );
  const beforePrompt = term.out.length;
  await ui.message('Note', 'body');
  ui.paint(p);
  const afterPrompt = term.out.slice(beforePrompt);
  assert.match(
    afterPrompt,
    /^\x1b\[2J\x1b\[H/,
    'after a prompt the frame is drawn fresh'
  );
  assert.match(
    afterPrompt,
    /Probe module  probe\.prg  Main/,
    'the full frame again'
  );
  const beforeResize = term.out.length;
  (term as { rows: number }).rows = 12;
  ui.resized();
  const afterResize = term.out.slice(beforeResize);
  assert.match(afterResize, /^\x1b\[2J\x1b\[H/, 'a resize clears and redraws');
  assert.match(afterResize, /F1 Ident   F2 Fault memory/, 'for the new size');
});

test('pickList: arrows, typing, Space marks and Enter, Esc cancels', async () => {
  const R = loadRuntime();
  const term = fakeTerminal([]);
  const ui = new TuiUi(term, R, null);
  const key = (name: string): void => term.press('', { name });
  const options = [
    { value: 'a', label: 'Alpha', meta: 'first' },
    { value: 'b', label: 'Beta' },
    { value: 'c', label: 'Gamma' },
  ];
  let done = ui.pickList('Pick one', options);
  assert.equal(ui.modal, true, 'the picker owns the keys');
  key('down');
  key('down');
  key('up');
  key('return');
  assert.deepEqual(await done, ['b'], 'Enter picks the row under the bar');
  assert.equal(ui.modal, false);
  done = ui.pickList('Pick one', options);
  for (const ch of 'gam') term.press(ch, { name: ch });
  key('return');
  assert.deepEqual(await done, ['c'], 'typing filters, Enter picks the match');
  done = ui.pickList('Pick', options, true);
  key('space');
  key('down');
  key('down');
  key('space');
  key('return');
  assert.deepEqual(
    await done,
    ['a', 'c'],
    'Space marks, Enter takes the marked rows'
  );
  done = ui.pickList('Pick', options);
  key('escape');
  assert.equal(await done, null, 'Esc cancels');
});

test('a long viewer scrolls: arrows, pages, Home/End, and a new view starts at the top', () => {
  const R = loadRuntime();
  const term = fakeTerminal([]); // 80x24: 16 body rows, 15 under a scroll line
  const ui = new TuiUi(term, R, null);
  const p = stubProgram();
  const lines = Array.from({ length: 60 }, (_, i) => `fault line ${i + 1}`);
  (p as { view: unknown }).view = { lines, report: null };
  ui.attach(p);
  let mark = 0;
  /** what the last paint wrote (an in-place repaint writes changed lines only) */
  const wrote = (): string => {
    const d = term.out.slice(mark);
    mark = term.out.length;
    return d;
  };
  ui.paint(p);
  let d = wrote();
  assert.match(d, /fault line 1\x1b/, 'starts at the top');
  assert.doesNotMatch(d, /fault line 60/, 'the tail is off screen');
  assert.match(d, /rows 1-15 of 60/, 'says where the window is');
  assert.equal(ui.scrollView('down'), true);
  assert.match(wrote(), /rows 2-16 of 60/, 'Down moves one line');
  ui.scrollView('pagedown');
  assert.match(wrote(), /rows 16-30 of 60/, 'PgDn moves a page');
  ui.scrollView('end');
  d = wrote();
  assert.match(d, /fault line 60\x1b/, 'End shows the last line');
  assert.match(d, /rows 46-60 of 60/, 'and says so');
  ui.scrollView('home');
  assert.match(wrote(), /rows 1-15 of 60/, 'Home returns to the top');
  ui.scrollView('end');
  wrote();
  (p as { view: unknown }).view = { lines: lines.slice(0, 30), report: null };
  ui.paint(p);
  assert.match(wrote(), /rows 1-15 of 30/, 'a new view starts at the top');
  (p as { view: unknown }).view = { lines: lines.slice(0, 5), report: null };
  ui.paint(p);
  assert.doesNotMatch(
    wrote(),
    /rows \d+-\d+ of/,
    'a view that fits has no scroll line'
  );
  assert.equal(ui.scrollView('down'), true, "the key is still the viewer's");
  (p as { view: unknown }).view = null;
  ui.paint(p);
  assert.equal(ui.scrollView('down'), false, 'no viewer: the key is not taken');
});
