/**
 * @file `tui`: a module's INPA screens in the terminal.
 *
 * The program is the app's (screens/ipo-runtime/program.js IpoProgram):
 * entry, menus, key presses in one persistent VM, screen cycles, the
 * script's own Back as the release, inpaexit on leave. What is written here
 * is the UI CONTRACT the program drives (ipoMakeUi's IpoUi), for a terminal
 * instead of a page: the F-key bar, the painted grid, the progress line,
 * the dialogs as prompts, and the confirmation before any write, answered
 * on the keyboard. A "no" aborts the key; a held actuator is released on
 * exit the way the app releases it (the leaving menu's Back job through
 * registerMenuLeave, then inpaexit).
 *
 * Keys: 1..9 and 0 are F1..F10, the shifted symbols on those keys
 * (! @ # $ % ^ & * ( )) and Shift+F1..F10 are the shifted bank, Esc is
 * Back, q quits. Plain ANSI; no screen library.
 */
import { writeFileSync } from 'node:fs';
import { createInterface, emitKeypressEvents } from 'node:readline';
import { CliError } from './args.ts';
import {
  connectBus,
  disconnectBus,
  openModule,
  prepareModule,
} from './live.ts';
import {
  loadRuntime,
  runtimeGlobals,
  setApiImpl,
  type ApiFn,
  type EcuRecord,
  type HomeHost,
  type HomeOption,
  type HomePickStep,
  type IpoCell,
  type IpoExec,
  type IpoMenuItem,
  type IpoProgramLike,
  type IpoStep,
  type IpoUi,
  type Runtime,
} from './runtime.ts';
import { VEHICLE_SCRIPTS } from './scan.ts';
import type { LiveOptions } from './live.ts';

/**
 * The home script's host for the terminal: the chassis list and each
 * chassis's modules from the site's config JSON (through the runtime's
 * fetch, so it is cached like every other archive), the whole-vehicle
 * script by the name the site files it under, and a status line naming
 * the CLI and the cable.
 * @param api - the engine client
 * @param status - the status line
 * @returns the host
 */
export function terminalHomeHost(api: ApiFn, status: () => string): HomeHost {
  return {
    chassis: async () => {
      const ids = (await api('/api/chassis')) as string[];
      return (ids || []).map((id) => ({ value: id, label: id }));
    },
    modules: async (chassis) => {
      const ch = (await api(`/api/chassis/${encodeURIComponent(chassis)}`)) as {
        sections?: {
          name?: string;
          ecus?: { sgbd?: string; label?: string; code?: string }[];
        }[];
      };
      const out: HomeOption[] = [];
      for (const sec of (ch && ch.sections) || [])
        for (const ecu of sec.ecus || [])
          if (ecu && ecu.sgbd)
            out.push({
              value: String(ecu.sgbd).toLowerCase(),
              label: ecu.label || ecu.code || ecu.sgbd,
              meta: `${sec.name || ''}  ${ecu.sgbd}`,
            });
      return out;
    },
    vehicle: async (chassis) =>
      VEHICLE_SCRIPTS[String(chassis).toUpperCase()] || '',
    status,
  };
}

/** One key press as the terminal reports it. */
export interface Key {
  name: string;
  ch: string;
  shift: boolean;
  ctrl: boolean;
}

/** What the UI needs from a terminal; a test supplies a scripted one. */
export interface Terminal {
  write(s: string): void;
  readonly columns: number;
  readonly rows: number;
  /** subscribe to key presses; returns the unsubscribe */
  onKey(fn: (k: Key) => void): () => void;
  /** a line of input, null when cancelled (Esc, EOF) */
  readLine(prompt: string): Promise<string | null>;
  close(): void;
}

/** The shifted bank on a US layout: the symbol over each digit key. */
const SHIFTED_DIGITS = '!@#$%^&*()';

/** F1..F10 as the number row; 0 is F10. */
const DIGITS = '1234567890';

/** The width a gauge takes on the grid, in characters. */
const GAUGE_WIDTH = 12;

/**
 * What a key press means to the program.
 * @param k - the key
 * @returns an F-key number (11..20 shifted), 'back', 'quit', or null
 */
export function keyToPress(k: Key): number | 'back' | 'quit' | null {
  if (k.ctrl && k.name === 'c') return 'quit';
  if (k.name === 'escape') return 'back';
  if (k.ch === 'q' || k.ch === 'Q') return 'quit';
  const f = /^f(\d{1,2})$/.exec(k.name);
  if (f) {
    const n = Number(f[1]);
    if (n >= 1 && n <= 10) return k.shift ? n + 10 : n;
    return null;
  }
  const d = DIGITS.indexOf(k.ch);
  if (k.ch && d >= 0) return d + 1;
  const s = SHIFTED_DIGITS.indexOf(k.ch);
  if (k.ch && s >= 0) return s + 11;
  return null;
}

/**
 * The process's own terminal: raw-mode key presses, readline for prompts.
 * @returns the terminal
 */
export function nodeTerminal(): Terminal {
  const input = process.stdin;
  const output = process.stdout;
  emitKeypressEvents(input);
  const raw = (on: boolean): void => {
    if (input.isTTY) input.setRawMode(on);
  };
  raw(true);
  input.resume();
  const subs = new Set<(k: Key) => void>();
  let paused = false;
  input.on(
    'keypress',
    (str: string | undefined, key: Partial<Key> | undefined) => {
      if (paused) return;
      const k: Key = {
        name: (key && key.name) || '',
        ch: str || '',
        shift: !!(key && key.shift),
        ctrl: !!(key && key.ctrl),
      };
      for (const f of subs) f(k);
    }
  );
  return {
    write: (s) => {
      output.write(s);
    },
    get columns() {
      return output.columns || 80;
    },
    get rows() {
      return output.rows || 24;
    },
    onKey(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
    async readLine(prompt) {
      paused = true;
      raw(false);
      const rl = createInterface({ input, output, terminal: true });
      try {
        return await new Promise<string | null>((res) => {
          rl.question(prompt, (a) => res(a));
          rl.on('close', () => res(null));
        });
      } finally {
        rl.close();
        raw(true);
        paused = false;
      }
    },
    close() {
      raw(false);
      input.pause();
    },
  };
}

/**
 * The terminal UI adapter: the IpoUi contract over a Terminal.
 *
 * Paint redraws the whole screen from the program's cells (INPA's grid,
 * row by row, as the app's INPA mode does), the key bar from its items,
 * then the status and progress lines. Every dialog is a prompt on the same
 * terminal, with raw mode off while the answer is typed.
 */
export class TuiUi implements IpoUi {
  readonly term: Terminal;
  readonly sent: string[] = [];
  private statusText = '';
  private progressText = '';
  private stopRequested = false;
  private writeKeys = new Set<number>();
  private program: IpoProgramLike | null = null;
  private leftResolve: (() => void) | null = null;
  /** resolves once the program reports it left the module */
  readonly leftPromise: Promise<void>;
  private readonly R: Runtime;
  /** the home script's host: what its picks list */
  readonly home: HomeHost | null;

  /**
   * @param term - the terminal
   * @param R - the runtime (for the write verdict on key captions)
   * @param home - the home script's host, when the home may run
   */
  constructor(term: Terminal, R: Runtime, home: HomeHost | null = null) {
    this.term = term;
    this.R = R;
    this.home = home;
    this.leftPromise = new Promise((res) => {
      this.leftResolve = res;
    });
  }

  /**
   * BMWeb's own picker (the home script's bmweb_pick): the host's list as
   * numbered rows; a number picks, anything else narrows the list to the
   * rows containing it, an empty answer cancels. A vehicle pick has one
   * answer and asks nothing.
   * @param _p - the program
   * @param step - the pick suspension
   * @returns the chosen value, or null for cancel
   */
  async pickHome(
    _p: IpoProgramLike,
    step: HomePickStep
  ): Promise<string | null> {
    if (!this.home) return null;
    if (step.what === 'vehicle') return this.home.vehicle(step.arg);
    let options: HomeOption[];
    try {
      options =
        step.what === 'module'
          ? await this.home.modules(step.arg)
          : await this.home.chassis();
    } catch (e) {
      await this.message('No list', String((e as Error).message || e));
      return null;
    }
    const title =
      step.what === 'module' ? `Modules of ${step.arg}` : 'Vehicles';
    let shown = options;
    for (;;) {
      const rows = shown
        .map(
          (o, i) =>
            `  ${String(i + 1).padStart(3)}. ${o.label}${o.meta ? `  (${o.meta})` : ''}`
        )
        .join('\n');
      const a = await this.term.readLine(
        `\n${title}${shown.length !== options.length ? ` (${shown.length} of ${options.length})` : ''}\n${rows}\n` +
          `Number to open, text to filter, Enter to cancel: `
      );
      if (a == null || !a.trim()) return null;
      const n = Number(a.trim());
      if (Number.isInteger(n) && n >= 1 && n <= shown.length)
        return (shown[n - 1] as HomeOption).value;
      const q = a.trim().toLowerCase();
      const next = options.filter((o) =>
        `${o.label} ${o.meta || ''} ${o.value}`.toLowerCase().includes(q)
      );
      shown = next.length ? next : options;
    }
  }

  /** Note the program once it exists, for the key handler. */
  attach(p: IpoProgramLike): void {
    this.program = p;
  }

  /** Esc during a parked state machine: stop it at the next tick. */
  requestStop(): void {
    this.stopRequested = true;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  loadExec(sgbd: string): Promise<IpoExec | null> {
    return this.R.irLiveExec(sgbd);
  }

  route(): void {}

  status(_p: IpoProgramLike, text: string): void {
    this.statusText = text;
    this.drawFooter();
  }

  error(_p: IpoProgramLike, text: string): void {
    this.statusText = `error: ${text}`;
    this.drawFooter();
  }

  async message(title: string, body: string | null): Promise<void> {
    await this.term.readLine(
      `\n${title}${body ? `\n${body}` : ''}\n[Enter to continue] `
    );
  }

  /**
   * INPA's prompts, answered on the keyboard with the meanings irAskInput
   * gives them: inputdigital is the script's two words and stores 1 for the
   * true word; the plain OK/Cancel box stores 0 for OK; inputhex takes a hex
   * string, input2text words, inputnum a real, the rest whole numbers within
   * the declared range. A cancel (empty answer, Esc) abandons the key.
   * @param step - the input suspension
   * @param label - the key's caption, when the script gave no title
   * @returns what resume() stores, or null for cancel
   */
  async askInput(
    step: IpoStep,
    label: string | undefined
  ): Promise<number | string | (number | string)[] | null> {
    const prompts = step.prompts || [];
    const refs = Math.max(1, Number(step.refs || 1));
    const name = String(step.name || '');
    const p0 = prompts[0] || label || '';
    const p1 = prompts[1] || '';
    if (name === 'inputdigital') {
      const f = prompts[prompts.length - 2] || 'OFF';
      const t = prompts[prompts.length - 1] || 'ON';
      const a = await this.term.readLine(
        `\n${p0}\n${p1}\n[${t} = y, ${f} = n, cancel = Enter] `
      );
      if (a == null || !a.trim()) return null;
      return /^y/i.test(a.trim()) ? 1 : 0;
    }
    if (name === 'builtin_3f' && prompts.length <= 2 && refs === 1) {
      const a = await this.term.readLine(
        `\n${p0}\n${p1}\n[OK = y, cancel = n] `
      );
      return a != null && /^y/i.test(a.trim()) ? 0 : null;
    }
    const hex = /hex/i.test(name);
    const text = /text/i.test(name);
    const real = name === 'inputnum';
    const vals: (number | string)[] = [];
    for (let k = 0; k < refs; k++) {
      const cap = refs > 1 ? prompts[2 + k] || `${p0} (${k + 1}/${refs})` : p1;
      const range =
        step.lo != null && step.hi != null && !hex
          ? ` [${step.lo}..${step.hi}]`
          : '';
      const a = await this.term.readLine(`\n${p0}\n${cap}${range}: `);
      if (a == null) return null;
      if (text) {
        vals.push(String(a));
        continue;
      }
      if (!a.trim()) return null;
      if (hex) {
        vals.push(a.trim());
        continue;
      }
      const n = real ? Number(a) : Math.trunc(Number(a));
      if (!Number.isFinite(n)) return null;
      if (
        refs === 1 &&
        step.lo != null &&
        step.hi != null &&
        (n < step.lo || n > step.hi)
      )
        return null;
      vals.push(n);
    }
    return refs > 1 ? vals : (vals[0] as number | string);
  }

  async confirmKey(
    _p: IpoProgramLike,
    it: IpoMenuItem,
    jobs: string[],
    writes: string[]
  ): Promise<boolean> {
    const a = await this.term.readLine(
      `\nRun "${it.label || it.legendLabel || `F${it.nr}`}"? It can send ${jobs.join(', ')}` +
        ` and ${writes.join(', ')} write${writes.length === 1 ? 's' : ''} to the module. [y/N] `
    );
    return !!a && /^y(es)?$/i.test(a.trim());
  }

  async confirmWrite(
    _p: IpoProgramLike,
    job: string,
    arg: string | null,
    ctx: { label: string; scope: string }
  ): Promise<boolean> {
    const every = String(ctx.scope || '').startsWith('screen:')
      ? ' This screen sends it on every refresh; yes allows it while the screen is open.'
      : '';
    const a = await this.term.readLine(
      `\nSend ${job}${arg ? ` ${arg}` : ''} to the module (${ctx.label})?${every} [y/N] `
    );
    return !!a && /^y(es)?$/i.test(a.trim());
  }

  /**
   * INPA's togglelist: the active screen's LINE declarations, numbered;
   * one is picked and switched on or off (a tick list with the multiple
   * flag, every picked key ';'-joined).
   */
  async pickComponent(
    p: IpoProgramLike,
    step: IpoStep
  ): Promise<{ ort: string; ein: number } | null> {
    const rows = this.R.ipoScreenComponents(p.exec, p.screen).map((l, i) => ({
      key: step.argnum ? String(i + 1) : String(l.keys).split(';')[0] || '',
      caption: l.label || String(l.keys).split(';')[0] || '',
    }));
    if (!rows.length) {
      await this.message(
        'No components to pick',
        'This screen lists no components.'
      );
      return null;
    }
    const list = rows
      .map((r, i) => `  ${i + 1}. ${r.caption}  (${r.key})`)
      .join('\n');
    if (step.multiple) {
      const a = await this.term.readLine(
        `\n${list}\nComponents, comma-separated (Enter cancels): `
      );
      const picked = pickNumbers(a, rows.length).map(
        (i) => rows[i] as { key: string }
      );
      if (!picked.length) return null;
      return { ort: picked.map((r) => r.key).join(';'), ein: 0 };
    }
    const a = await this.term.readLine(
      `\n${list}\nComponent number (Enter cancels): `
    );
    const [i] = pickNumbers(a, rows.length);
    if (i == null) return null;
    const onOff = await this.term.readLine(`On or off? [on/off] `);
    if (onOff == null || !onOff.trim()) return null;
    return {
      ort: (rows[i] as { key: string }).key,
      ein: /^on/i.test(onOff.trim()) ? 0 : 1,
    };
  }

  /** INPA's Select: which named logical lines to keep on screen. */
  async pickLines(
    _p: IpoProgramLike,
    names: string[],
    multiple: boolean,
    _current: Set<string> | null,
    hints?: { key: string; label: string; lines: number }[]
  ): Promise<string[] | null> {
    if (!names.length) {
      const where = (hints || [])
        .map((h) => `${h.key} ${h.label} (${h.lines} lines)`)
        .join(', ');
      await this.message(
        'Nothing to select here',
        where
          ? `Select works after one of: ${where}`
          : 'This screen has no named lines.'
      );
      return null;
    }
    const list = names.map((n, i) => `  ${i + 1}. ${n}`).join('\n');
    const a = await this.term.readLine(
      `\n${list}\nLines to show${multiple ? ', comma-separated' : ''} (a = all, Enter cancels): `
    );
    if (a == null) return null;
    if (/^a(ll)?$/i.test(a.trim())) return [];
    const picked = pickNumbers(a, names.length).map((i) => names[i] as string);
    return picked.length ? picked : null;
  }

  /** INPA's save-as dialog: a file name, written when the body ends. */
  async saveFile(): Promise<{ name: string } | null> {
    const a = await this.term.readLine(`\nSave as [fault-memory.txt]: `);
    if (a == null) return null;
    return { name: a.trim() || 'fault-memory.txt' };
  }

  async writeFile(
    _p: IpoProgramLike,
    picked: { name: string },
    lines: string[]
  ): Promise<void> {
    writeFileSync(picked.name, lines.join('\r\n') + '\r\n', 'latin1');
    this.status(_p, `wrote ${picked.name}`);
  }

  printScreen(p: IpoProgramLike): void {
    // INPA's printscreen: the grid as text, on stdout below the screen
    this.term.write(`\n${this.gridLines(p).join('\n')}\n`);
  }

  /**
   * The module a scriptchange names. From the home script it is the car's
   * own config row for the picked chassis (home.js ipoHomeEcuFor), prepared
   * the way opening it from the module list prepares it; from any other
   * script it is the module the car identifies (open.js).
   */
  async resolveScriptEcu(
    from: EcuRecord,
    script: string,
    exec: IpoExec
  ): Promise<EcuRecord | null> {
    if (from && from.sgbd === this.R.IPO_HOME_SGBD) {
      const row = await this.R.ipoHomeEcuFor(from, script);
      if (!row) return null;
      try {
        const api = runtimeGlobals().api as ApiFn;
        return (await prepareModule(row, api)).ecu;
      } catch {
        // no script or no answer: the row itself still names the module
        return row;
      }
    }
    return this.R.ipoResolveScriptEcu(from, script, exec);
  }

  /** A %STATE park: tick after IPO_TICK_MS, or stop when Esc was pressed. */
  async machineTick(
    _p: IpoProgramLike,
    step: IpoStep
  ): Promise<'tick' | 'press' | 'stop'> {
    this.progressText = `state ${String(step.name || '').replace(/^%/, '')} (Esc stops)`;
    this.drawFooter();
    await this.sleep(this.R.IPO_TICK_MS);
    if (this.stopRequested) {
      this.stopRequested = false;
      this.progressText = '';
      return 'stop';
    }
    return 'tick';
  }

  userbox(
    _p: IpoProgramLike,
    box: { title?: string; lines?: string[] } | null
  ): void {
    if (!box) {
      this.progressText = '';
    } else {
      const lines = box.lines || [];
      const text = lines.length ? String(lines[lines.length - 1]) : '';
      this.progressText = `${box.title ? `${box.title}: ` : ''}${text}`.trim();
    }
    this.drawFooter();
  }

  /** The F-key bar: the write verdict per key marks what will ask. */
  renderKeys(p: IpoProgramLike): void {
    this.writeKeys = new Set();
    const jobsOf = runtimeGlobals().irItemBodyJobs as
      | ((exec: IpoExec, toks: unknown, a: number, b: number) => string[])
      | undefined;
    for (const it of p.items) {
      const jobs = jobsOf
        ? jobsOf(p.exec, p.exec.procs[p.menu || ''], it.start, it.end)
        : [];
      if (jobs.some((j) => this.R.ipoNeedsConfirm(j)))
        this.writeKeys.add(it.nr);
    }
    this.paint(p);
  }

  /** Redraw everything: title, grid, keys, footer. */
  paint(p: IpoProgramLike): void {
    const w = this.term.columns;
    const out: string[] = [];
    const title =
      `${p.ecu.label || p.ecu.sgbd}  ${p.ecu.sgbd}.prg  ${p.title || ''}`.trim();
    out.push(title.slice(0, w));
    out.push('-'.repeat(Math.min(w, 78)));
    if (p.view) {
      out.push(...(p.view.lines || []).slice(0, this.term.rows - 8));
    } else {
      out.push(...this.gridLines(p));
    }
    out.push('');
    out.push(...this.keyLines(p));
    this.term.write(`\x1b[H\x1b[2J${out.join('\n')}\n`);
    this.drawFooter();
  }

  /**
   * The grid as text rows: cells placed at their column, a lamp as a dot
   * and its word, a gauge as a bar and its number, the rest as its text.
   */
  gridLines(p: IpoProgramLike): string[] {
    const w = this.term.columns;
    const rows = new Map<number, IpoCell[]>();
    for (const c of p.cells.values()) {
      if (!rows.has(c.row)) rows.set(c.row, []);
      (rows.get(c.row) as IpoCell[]).push(c);
    }
    const maxRow = rows.size ? Math.max(...rows.keys()) : -1;
    const out: string[] = [];
    for (let r = 0; r <= maxRow; r++) {
      const line: string[] = [];
      for (const c of (rows.get(r) || []).sort((a, b) => a.col - b.col)) {
        const text = cellText(c);
        while (line.length < c.col) line.push(' ');
        for (const ch of text) line.push(ch);
      }
      out.push(line.join('').replace(/\s+$/, '').slice(0, w));
    }
    return out;
  }

  /** The key bar: the plain bank on one line, the shifted on the next. */
  keyLines(p: IpoProgramLike): string[] {
    const shown = p.items.filter((it) => !it.hidden || !!it.legendLabel);
    const label = (it: IpoMenuItem): string =>
      `${it.shift ? 'S' : ''}F${it.shift ? it.nr - 10 : it.nr} ${it.label || it.legendLabel || ''}${
        this.writeKeys.has(it.nr) ? '*' : ''
      }`;
    const plain = shown.filter((it) => !it.shift).map(label);
    const shifted = shown.filter((it) => it.shift).map(label);
    const out: string[] = [];
    if (plain.length) out.push(plain.join('   '));
    if (shifted.length) out.push(shifted.join('   '));
    out.push(
      '(1..9,0 = F1..F10, shifted symbols = Shift+F, Esc = back, q = quit, * asks first)'
    );
    return out;
  }

  /** The two bottom lines: status and progress. */
  private drawFooter(): void {
    this.term.write(
      `\x1b[s\x1b[${Math.max(1, this.term.rows - 1)};1H\x1b[K${this.statusText}\n\x1b[K${this.progressText}\x1b[u`
    );
  }

  left(): void {
    if (this.leftResolve) this.leftResolve();
  }
}

/**
 * The numbers a comma-separated answer names, zero-based and in range.
 * @param a - the answer, or null
 * @param n - how many rows there are
 * @returns indices
 */
function pickNumbers(a: string | null, n: number): number[] {
  if (a == null) return [];
  return a
    .split(/[,\s]+/)
    .map((s) => Number(s))
    .filter((i) => Number.isInteger(i) && i >= 1 && i <= n)
    .map((i) => i - 1);
}

/**
 * A cell as grid text: a lamp is a dot and its word, a gauge a bar and
 * its number, the rest its text.
 * @param c - the cell
 * @returns the text
 */
export function cellText(c: IpoCell): string {
  const text = String(c.text || '');
  if (c.kind === 'lamp') {
    const word = text.trim();
    const on =
      (c.meta && c.meta.on != null && word === String(c.meta.on)) ||
      /^(1|ein|on|an|ja|yes|aktiv|true)$/i.test(word);
    return `${on ? '(*)' : '( )'} ${word}`;
  }
  if (
    c.kind === 'gauge' &&
    c.meta &&
    c.meta.min != null &&
    c.meta.max != null
  ) {
    const n = parseFloat(text);
    if (Number.isFinite(n)) {
      const span = c.meta.max - c.meta.min || 1;
      const fill = Math.round(
        Math.max(0, Math.min(1, (n - c.meta.min) / span)) * GAUGE_WIDTH
      );
      return `[${'#'.repeat(fill)}${'.'.repeat(GAUGE_WIDTH - fill)}] ${text.trim()}`;
    }
  }
  return text;
}

/** How `tui` is steered. */
export interface TuiOptions extends LiveOptions {
  /** a menu to open once the script is up */
  menu?: string;
  /** the terminal (the process's own unless a test supplies one) */
  term?: Terminal;
  /** the engine client; the runtime's own unless a test fakes the car */
  apiFn?: ApiFn;
  /** the script, when a test supplies one instead of the site's */
  exec?: IpoExec;
  /** the module record, when a test supplies one */
  ecu?: EcuRecord;
  /** skip the cable (a test's fake car answers the api instead) */
  noBus?: boolean;
  /** the CLI's version, for the home's status line */
  version?: string;
}

/**
 * Run a script in the terminal until the user quits: a module's, given a
 * chassis and an SGBD, or the app's own home (home/bmweb-home.ips) when
 * neither is given. The home starts with or without a cable; a module
 * needs one.
 * @param chassis - the chassis id, or undefined for the home
 * @param sgbd - the module (SGBD or INPA code), the chassis for its whole-vehicle script, or undefined
 * @param opts - see TuiOptions
 * @returns the program's job log
 */
export async function tuiCommand(
  chassis: string | undefined,
  sgbd: string | undefined,
  opts: TuiOptions = {}
): Promise<{
  log: IpoProgramLike['log'];
  messages: IpoProgramLike['messages'];
}> {
  const R = loadRuntime();
  const home = !chassis && !sgbd;
  // the program reaches the car through the runtime's own api(): a client
  // handed in (a test's fake car) stands in for the shim while this runs
  if (opts.apiFn) setApiImpl(opts.apiFn);
  let cable = false;
  if (!opts.noBus) {
    if (home) {
      // the home starts without a car; the cable is taken when there is one
      try {
        await connectBus(opts);
        cable = true;
      } catch (e) {
        if (!(e instanceof CliError)) throw e;
      }
    } else {
      await connectBus(opts);
      cable = true;
    }
  }
  const api = opts.apiFn || (runtimeGlobals().api as ApiFn);
  const host = terminalHomeHost(api, () =>
    `bmweb-cli ${opts.version || ''}  ${
      cable || (opts.noBus && !home) ? 'cable connected' : 'no cable'
    }`.trim()
  );
  // the status builtin reads home.js's host by name: hang the CLI's on it
  Object.assign(R.IPO_HOME_HOST, host);
  const term = opts.term || nodeTerminal();
  const ui = new TuiUi(term, R, host);
  let p: IpoProgramLike | null = null;
  try {
    let ecu: EcuRecord;
    let exec: IpoExec;
    if (opts.exec) {
      ecu = opts.ecu || {
        sgbd: String(sgbd || '').toLowerCase(),
        label: String(sgbd || '').toUpperCase(),
        chassis: String(chassis || '').toUpperCase(),
      };
      exec = opts.exec;
    } else if (home) {
      exec = R.ipoHomeExec();
      ecu = {
        sgbd: R.IPO_HOME_SGBD,
        code: 'BMWEB',
        label: 'BMWeb',
        _variant: R.IPO_HOME_SGBD.toUpperCase(),
      };
    } else {
      ({ ecu, exec } = await openModule(
        chassis as string,
        sgbd as string,
        opts.apiFn
      ));
    }
    p = new R.IpoProgram(ecu, exec, ui);
    ui.attach(p);
    const r = await p.start();
    if (p.noCable) throw new CliError('no cable connected');
    if (!r.ok) {
      const last = p.messages[p.messages.length - 1];
      throw new CliError(
        `${ecu.sgbd}: the script did not start (${r.reason || 'stopped'})` +
          (last ? `: ${last.title}${last.body ? ` ${last.body}` : ''}` : '')
      );
    }
    if (opts.menu) {
      if (!exec.procs[opts.menu])
        throw new CliError(`${ecu.sgbd}: no menu ${opts.menu}`);
      if (opts.menu !== p.menu) await p.openMenu(opts.menu);
    }
    const program = p;
    const unsubscribe = term.onKey((k) => {
      const what = keyToPress(k);
      if (what === null) return;
      if (what === 'quit') {
        unsubscribe();
        program.leaveModule().catch(() => {});
        return;
      }
      if (what === 'back') {
        ui.requestStop();
        program.back().catch(() => {});
        return;
      }
      program.press(what).catch(() => {});
    });
    await ui.leftPromise;
    unsubscribe();
    return { log: program.log, messages: program.messages };
  } finally {
    if (p && !p.closed) p.close();
    term.close();
    if (opts.apiFn) setApiImpl(null);
    if (!opts.noBus) await disconnectBus(R);
  }
}
