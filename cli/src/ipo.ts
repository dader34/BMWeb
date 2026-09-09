/**
 * @file The `ipo` commands: what a script is, what its keys do, and
 * compiling a source.
 *
 * Reading and compiling are the app's own (core/ipofile/, through the
 * runtime loader). What is added here is a STATIC scan of the token stream
 * for the parts a person asks about without running anything: the menu a
 * key opens, the screen it shows, the jobs it sends. The runtime answers
 * those questions by executing the key in the VM; the CLI has no car and
 * no VM host, so it reads the constants the script pushes before each
 * call, the same way the runtime's own Back-key scan (program.js
 * _backItemJob) and the search index builder do.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { CliError } from './args.ts';
import { formatCount, formatTable } from './table.ts';
import {
  loadRuntime,
  type IpoExec,
  type IpoMenuItem,
  type IpoToken,
  type Runtime,
} from './runtime.ts';

/** F-key numbers above this are the shifted bank (Shift+F1 = 11). */
const SHIFT_BASE = 10;

/** A job name as the scripts write them: the same test the index uses. */
const JOB_NAME_RE = /^[A-Z][A-Z0-9_]{2,}$/;

/** The calls that put a job on the wire. */
const JOB_CALL_RE = /^(INP.?apiJob|INPAapiFsLesen|ApiJobFsLesenFAB)$/;

/** Calls that are INPA's own chrome, worth naming as an action. */
const ACTION_CALLS = new Set([
  'exit',
  'printscreen',
  'printfile',
  'select',
  'deselect',
  'start',
  'stop',
  'control',
  'messagebox',
]);

/** How far a helper chain is followed for jobs (a key -> a function -> ...). */
const MAX_CALL_DEPTH = 4;

/** What a scan of one body found. */
export interface BodyScan {
  jobs: string[];
  screen: string | null;
  frequent: boolean;
  submenu: string | null;
  scriptchange: string | null;
  actions: string[];
  title: string | null;
}

/** One key of a menu, described. */
export interface KeyInfo {
  menu: string;
  nr: number;
  key: string;
  label: string;
  hidden: boolean;
  screen: string | null;
  screenTitle: string | null;
  frequent: boolean;
  submenu: string | null;
  scriptchange: string | null;
  /** jobs the key's own body sends */
  ownJobs: string[];
  /** jobs the screen it opens sends on its own */
  screenJobs: string[];
  /** both, in order, without repeats */
  jobs: string[];
  /** the jobs among them the app would confirm before sending */
  writes: string[];
  actions: string[];
}

/** One menu, described. */
export interface MenuInfo {
  name: string;
  title: string | null;
  screen: string | null;
  keys: KeyInfo[];
}

/** The whole picture of a script. */
export interface ScriptInfo {
  name: string;
  source: string;
  form: string;
  bytes: number | null;
  unknown: number;
  entry: string | null;
  rootMenu: string | null;
  rootScreen: string | null;
  includes: string[];
  imports: string[];
  procedures: number;
  functions: number;
  machines: number;
  screens: number;
  menus: MenuInfo[];
}

/**
 * The F-key name INPA shows for an ITEM number.
 * @param nr - the ITEM number
 * @returns 'F3' or 'Shift+F3'
 */
export function keyName(nr: number): string {
  return nr > SHIFT_BASE ? `Shift+F${nr - SHIFT_BASE}` : `F${nr}`;
}

/**
 * Scan a token range for what it does, without executing it.
 *
 * Arguments are the pushes since the last `frame`; a call consumes them.
 * INPAapiJob(sgbd, job, arg, results) names its job in the second slot,
 * which is a string constant in every script that names the job at all
 * (the SGBD slot is usually a variable). The other job calls take the
 * first job-shaped constant that is not the SGBD.
 * @param exec - the script
 * @param toks - the proc's tokens
 * @param start - first token index
 * @param end - token index the range ends at, exclusive
 * @param R - the runtime, for the reference kinds
 * @param depth - how many helper calls deep this scan is
 * @param seen - procs already scanned on this path, against recursion
 * @returns what was found
 */
export function scanBody(
  exec: IpoExec,
  toks: IpoToken[],
  start: number,
  end: number,
  R: Runtime,
  depth = 0,
  seen: Set<string> = new Set()
): BodyScan {
  const out: BodyScan = {
    jobs: [],
    screen: null,
    frequent: false,
    submenu: null,
    scriptchange: null,
    actions: [],
    title: null,
  };
  const byid = exec.byid || {};
  let args: IpoToken[] = [];
  const addJob = (j: string): void => {
    if (!out.jobs.includes(j)) out.jobs.push(j);
  };
  const strings = (): string[] =>
    args.filter((t) => t.op === 'const' && t.t === 's').map((t) => String(t.v));
  const merge = (inner: BodyScan): void => {
    inner.jobs.forEach(addJob);
    if (!out.screen && inner.screen) {
      out.screen = inner.screen;
      out.frequent = inner.frequent;
    }
    if (!out.submenu && inner.submenu) out.submenu = inner.submenu;
    if (!out.scriptchange && inner.scriptchange)
      out.scriptchange = inner.scriptchange;
    if (!out.title && inner.title) out.title = inner.title;
    for (const a of inner.actions)
      if (!out.actions.includes(a)) out.actions.push(a);
  };
  for (let i = start; i < end && i < toks.length; i++) {
    const t = toks[i] as IpoToken;
    if (t.op === 'frame') {
      args = [];
      continue;
    }
    if (t.op === 'const' || t.op === 'var' || t.op === 'procref') {
      args.push(t);
      continue;
    }
    if (t.op === 'calluser') {
      // a helper function: its body sends whatever it sends on the key's behalf
      const name = byid[`func:${t.n}`];
      if (name && depth < MAX_CALL_DEPTH && !seen.has(name)) {
        const body = exec.procs[name];
        if (body) {
          const next = new Set(seen);
          next.add(name);
          merge(scanBody(exec, body, 0, body.length, R, depth + 1, next));
        }
      }
      args = [];
      continue;
    }
    if (t.op !== 'call') continue;
    const name = t.name || '';
    if (JOB_CALL_RE.test(name)) {
      const s = strings();
      let job: string | undefined;
      if (/^INP.?apiJob$/.test(name)) {
        const second = args[1];
        if (second && second.op === 'const' && second.t === 's')
          job = String(second.v);
      }
      if (job === undefined) {
        const first = args[0];
        const sgbd =
          first && first.op === 'const' && first.t === 's'
            ? String(first.v)
            : '';
        job = s.find((v) => v !== sgbd && JOB_NAME_RE.test(v));
      }
      if (job && JOB_NAME_RE.test(job)) addJob(job);
    } else if (name === 'setscreen') {
      const ref = args.find(
        (a) => a.op === 'procref' && a.kind === R.IPO_REF_SCREEN
      );
      const flag = args.find(
        (a) => a.op === 'const' && (a.t === 'b' || a.t === 'i')
      );
      const scr = ref ? byid[`screen:${ref.n}`] : undefined;
      if (scr && !out.screen) {
        out.screen = scr;
        out.frequent = !!(flag && flag.v);
      }
    } else if (name === 'setmenu') {
      const ref = args.find(
        (a) => a.op === 'procref' && a.kind === R.IPO_REF_MENU
      );
      const menu = ref ? byid[`menu:${ref.n}`] : undefined;
      if (menu && !out.submenu) out.submenu = menu;
    } else if (name === 'scriptchange') {
      const s = strings();
      if (s[0] && !out.scriptchange) out.scriptchange = s[0];
    } else if (name === 'setmenutitle' || name === 'settitle') {
      const s = strings();
      if (s[0] && !out.title) out.title = s[0];
    } else if (ACTION_CALLS.has(name)) {
      if (!out.actions.includes(name)) out.actions.push(name);
    }
    args = [];
  }
  return out;
}

/**
 * The jobs a screen sends on its own: every LINE block's calls.
 * @param exec - the script
 * @param screen - the screen proc
 * @param R - the runtime
 * @returns the scan, or null for a screen the script does not define
 */
function scanScreen(
  exec: IpoExec,
  screen: string | null,
  R: Runtime
): BodyScan | null {
  const toks = screen ? exec.procs[screen] : undefined;
  if (!toks) return null;
  return scanBody(exec, toks, 0, toks.length, R);
}

/**
 * Describe one menu key.
 * @param exec - the script
 * @param menu - the menu proc
 * @param item - the ITEM, from ipoMenuItems
 * @param R - the runtime
 * @returns the key
 */
export function describeKey(
  exec: IpoExec,
  menu: string,
  item: IpoMenuItem,
  R: Runtime
): KeyInfo {
  const toks = exec.procs[menu] || [];
  const own = scanBody(exec, toks, item.start, item.end, R);
  const scr = scanScreen(exec, own.screen, R);
  const jobs = [...own.jobs];
  for (const j of scr ? scr.jobs : []) if (!jobs.includes(j)) jobs.push(j);
  return {
    menu,
    nr: item.nr,
    key: keyName(item.nr),
    label: item.label,
    hidden: item.hidden,
    screen: own.screen,
    screenTitle: scr ? scr.title : null,
    frequent: own.frequent,
    submenu: own.submenu,
    scriptchange: own.scriptchange,
    ownJobs: own.jobs,
    screenJobs: scr ? scr.jobs : [],
    jobs,
    // the app's own verdict: the write classifier, minus the session
    // plumbing every script sends without asking (wire-policy.js)
    writes: jobs.filter((j) => R.ipoNeedsConfirm(j)),
    actions: own.actions,
  };
}

/**
 * Describe one menu: its title, its backdrop screen and its keys.
 * @param exec - the script
 * @param name - the menu proc
 * @param R - the runtime
 * @returns the menu
 */
export function describeMenu(
  exec: IpoExec,
  name: string,
  R: Runtime
): MenuInfo {
  const toks = exec.procs[name] || [];
  const items = R.ipoMenuItems(exec, name);
  const firstItem = items.length
    ? (items[0] as IpoMenuItem).start - 1
    : toks.length;
  const prologue = scanBody(exec, toks, 0, firstItem, R);
  const shown = R.ipoScreenForMenu(exec, name);
  return {
    name,
    title: prologue.title,
    screen: shown ? shown.screen : prologue.screen,
    keys: items.map((it) => describeKey(exec, name, it, R)),
  };
}

/**
 * The menus of a script in declaration order (the byid numbering).
 * @param exec - the script
 * @returns menu proc names
 */
export function menuNames(exec: IpoExec): string[] {
  return Object.entries(exec.byid || {})
    .filter(([k]) => k.startsWith('menu:'))
    .sort((a, b) => Number(a[0].split(':')[1]) - Number(b[0].split(':')[1]))
    .map(([, v]) => v);
}

/**
 * Describe a whole script.
 *
 * The includes come from the caller: a decoded .IPO names them in its
 * constant pool, but a compiled source's exec does not carry them (the
 * compiler resolves them before parsing), so readScript reports the ones
 * it used and hands them in.
 * @param exec - the script
 * @param source - how it was obtained ('compiled .IPO' or 'compiled from source')
 * @param R - the runtime
 * @param includes - the include names, as readScript reports them
 * @returns the description
 */
export function describeScript(
  exec: IpoExec,
  source: string,
  R: Runtime,
  includes: string[] = Array.from(exec.includes || [])
): ScriptInfo {
  const inv = R.ipofInventory(exec);
  const entry = exec.procs.inpainit
    ? 'inpainit'
    : exec.procs.SgbdInpaCheck
      ? 'SgbdInpaCheck'
      : null;
  const entryScan = entry
    ? scanBody(exec, exec.procs[entry] as IpoToken[], 0, Infinity, R)
    : null;
  return {
    name: exec.ecu,
    source,
    form: exec.coding
      ? 'NCS coding dispatcher (drives the coding host, not a diagnostic session)'
      : 'INPA diagnostic script',
    bytes: exec.bytes ?? null,
    unknown: exec.unknown ?? 0,
    entry,
    rootMenu: entryScan ? entryScan.submenu : null,
    rootScreen: entryScan ? entryScan.screen : null,
    includes,
    imports: Object.values(exec.imports || {}),
    procedures: Object.keys(exec.procs).length,
    functions: inv.funcs.length,
    machines: inv.machines.length,
    screens: inv.screens.length,
    menus: menuNames(exec).map((m) => describeMenu(exec, m, R)),
  };
}

// ---- reading a script from disk --------------------------------------------

/** What readScript produced. */
export interface LoadedScript {
  exec: IpoExec;
  source: string;
  stem: string;
  includes: string[];
}

/**
 * The include texts available to a compile: every .h / .src beside the
 * script and in each -I directory, keyed by file name.
 *
 * INPA's own tooling matches include names case-insensitively and by base
 * name, and the compiler does the same, so the map is by base name. The
 * sources are CP1252 and carry accented German in string literals; latin1
 * keeps those bytes as the compiler expects.
 * @param dirs - directories to gather from, first wins on a name clash
 * @param skip - the script's own path, never offered as its own include
 * @returns file name -> text
 */
export function gatherIncludes(
  dirs: string[],
  skip: string
): Record<string, string> {
  const R = loadRuntime();
  const files: Record<string, string> = {};
  const own = resolve(skip);
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      throw new CliError(`include directory not found: ${dir}`);
    }
    for (const name of names.sort()) {
      if (!R.ipofIsInclude(name)) continue;
      const p = join(dir, name);
      if (resolve(p) === own) continue;
      try {
        if (!statSync(p).isFile()) continue;
      } catch {
        continue;
      }
      const key = name.toLowerCase();
      if (!(key in files)) files[key] = readFileSync(p, 'latin1');
    }
  }
  return files;
}

/**
 * Read a script file: decode a .IPO, or compile a .IPS / .SRC.
 * @param file - the path
 * @param includeDirs - the -I directories, for a source
 * @returns the exec and how it was obtained
 */
export function readScript(file: string, includeDirs: string[]): LoadedScript {
  const R = loadRuntime();
  const name = basename(file);
  const stem = R.ipofStem(name);
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
    throw new CliError(`cannot read ${file}`);
  }
  if (R.ipofIsCompiled(name)) {
    let exec: IpoExec;
    try {
      exec = R.ipofDecodeExec(new Uint8Array(bytes), stem);
    } catch (e) {
      throw new CliError(String((e as Error).message || e));
    }
    // Array.from: the reader's arrays belong to the vm context's realm, and
    // a host caller comparing them (or a strict deepEqual) wants its own
    return {
      exec,
      source: 'compiled .IPO',
      stem,
      includes: Array.from(exec.includes || []),
    };
  }
  if (!R.ipofIsSource(name))
    throw new CliError(`${name}: not a script (.IPO) or a source (.IPS, .SRC)`);
  const dirs = [dirname(resolve(file)), ...includeDirs];
  const files = gatherIncludes(dirs, file);
  const r = R.ipofCompileSource(bytes.toString('latin1'), {
    name: stem,
    files,
  });
  if (!r.ok || !r.exec) {
    if (r.missing.length) {
      throw new CliError(
        `${name}: missing include${r.missing.length === 1 ? '' : 's'} ` +
          `${r.missing.join(', ')} (searched ${dirs.join(', ')}; ` +
          `pass -I <dir> with the INPA headers)`
      );
    }
    const first = r.errors[0];
    const where = first && first.line ? `line ${first.line}: ` : '';
    throw new CliError(
      `${name}: ${where}${first ? first.text || first.message : 'compile failed'}`
    );
  }
  return {
    exec: r.exec,
    source: 'compiled from source',
    stem,
    includes: Array.from(r.includes),
  };
}

// ---- the commands ----------------------------------------------------------

/**
 * `ipo info`: the script described, as text or JSON.
 * @param file - the script path
 * @param includeDirs - -I directories
 * @param json - machine-readable output
 * @returns the lines to print
 */
export function ipoInfo(
  file: string,
  includeDirs: string[],
  json: boolean
): string[] {
  const R = loadRuntime();
  const s = readScript(file, includeDirs);
  const info = describeScript(s.exec, s.source, R, s.includes);
  if (json) return [JSON.stringify(info, null, 2)];
  const kv: [string, string][] = [
    ['Script', `${info.name} (${info.source})`],
    ['Form', info.form],
    [
      'Entry',
      info.entry
        ? `${info.entry}${
            info.rootMenu || info.rootScreen
              ? ` -> ${[info.rootMenu, info.rootScreen].filter(Boolean).join(' / ')}`
              : ''
          }`
        : 'none (INPA starts at inpainit or SgbdInpaCheck; this script has neither)',
    ],
    ['Includes', info.includes.length ? info.includes.join(', ') : 'none'],
    [
      'Procedures',
      `${info.procedures} (${info.menus.length} menus, ${info.screens} screens, ` +
        `${info.functions} functions, ${info.machines} state machines)`,
    ],
    ['DLL imports', info.imports.length ? info.imports.join(', ') : 'none'],
  ];
  if (info.bytes != null) {
    kv.push([
      'Bytecode',
      `${formatCount(info.bytes)} bytes` +
        (info.unknown ? `, ${formatCount(info.unknown)} undecoded` : ''),
    ]);
  }
  const out = formatTable(kv);
  for (const m of info.menus) {
    out.push('');
    out.push(...menuLines(m));
  }
  return out;
}

/**
 * One menu as text: a heading, then its keys as a table.
 * @param m - the menu
 * @returns the lines
 */
function menuLines(m: MenuInfo): string[] {
  const head = [
    m.name,
    m.title ? `"${m.title}"` : '',
    m.screen ? `(screen ${m.screen})` : '',
  ]
    .filter(Boolean)
    .join('  ');
  const rows = m.keys.map((k) => [
    k.key,
    keyLabel(k),
    keyTarget(k),
    keyJobsText(k),
  ]);
  return [head, ...formatTable(rows, undefined, '  ')];
}

/**
 * The label column: the caption, or what a blank slot does.
 * @param k - the key
 * @returns the text
 */
function keyLabel(k: KeyInfo): string {
  return k.hidden ? '(no caption)' : k.label;
}

/**
 * The target column: the screen, submenu or script the key opens.
 * @param k - the key
 * @returns the text
 */
function keyTarget(k: KeyInfo): string {
  const parts: string[] = [];
  if (k.screen) parts.push(`${k.screen}${k.frequent ? ' (cyclic)' : ''}`);
  if (k.submenu) parts.push(`menu ${k.submenu}`);
  if (k.scriptchange) parts.push(`script ${k.scriptchange}`);
  return parts.join(', ');
}

/**
 * The jobs column: jobs with writes marked, then the chrome actions.
 * @param k - the key
 * @returns the text
 */
function keyJobsText(k: KeyInfo): string {
  const jobs = k.jobs.map((j) => (k.writes.includes(j) ? `${j} [WRITE]` : j));
  const acts = k.actions.filter((a) => a !== 'messagebox');
  return [...jobs, ...acts.map((a) => `(${a})`)].join(', ');
}

/**
 * `ipo keys`: every key of every menu (or one), as a table or JSON.
 * @param file - the script path
 * @param includeDirs - -I directories
 * @param menu - one menu proc, or undefined for all
 * @param json - machine-readable output
 * @returns the lines to print
 */
export function ipoKeys(
  file: string,
  includeDirs: string[],
  menu: string | undefined,
  json: boolean
): string[] {
  const R = loadRuntime();
  const s = readScript(file, includeDirs);
  const names = menu ? [menu] : menuNames(s.exec);
  if (menu && !(menu in s.exec.procs))
    throw new CliError(
      `${s.stem}: no menu ${menu} (menus: ${menuNames(s.exec).join(', ') || 'none'})`
    );
  const menus = names.map((m) => describeMenu(s.exec, m, R));
  if (json) return [JSON.stringify(menus, null, 2)];
  const rows: string[][] = [];
  for (const m of menus)
    for (const k of m.keys)
      rows.push([
        m.name,
        k.key,
        keyLabel(k),
        keyTarget(k),
        keyJobsText(k),
        k.writes.length ? 'yes' : '',
      ]);
  if (!rows.length) return [`${s.stem}: no menu keys`];
  return formatTable(rows, ['MENU', 'KEY', 'LABEL', 'OPENS', 'JOBS', 'WRITES']);
}

/**
 * `ipo compile`: compile a source and write the exec the app runs.
 *
 * What is written is the runtime's own form of the script (the {procs,
 * byid} token exec the Script runner and the shipped data use), as JSON.
 * The app's compiler emits tokens, not INPA's binary container; the byte
 * writer is in the repo's Python tooling and is not part of this package.
 * @param file - the source path
 * @param includeDirs - -I directories
 * @param out - the output path, or undefined for <stem>.ipoexec.json beside the source
 * @returns the lines to print
 */
export function ipoCompile(
  file: string,
  includeDirs: string[],
  out: string | undefined
): string[] {
  const R = loadRuntime();
  const name = basename(file);
  if (!R.ipofIsSource(name))
    throw new CliError(`${name}: compile takes a .IPS or .SRC source`);
  const s = readScript(file, includeDirs);
  const target = out || join(dirname(resolve(file)), `${s.stem}.ipoexec.json`);
  try {
    writeFileSync(target, JSON.stringify(s.exec));
  } catch {
    throw new CliError(`cannot write ${target}`);
  }
  const inv = R.ipofInventory(s.exec);
  return [
    `${name}: compiled ${Object.keys(s.exec.procs).length} procedures ` +
      `(${inv.menus.length} menus, ${inv.screens.length} screens, ` +
      `${inv.funcs.length} functions, ${inv.machines.length} state machines)` +
      (s.includes.length ? `, includes ${s.includes.join(', ')}` : ''),
    `wrote ${target} (the app's exec form; not INPA's binary .IPO)`,
  ];
}
