/**
 * @file Loading the app's own scripts into Node.
 *
 * The renderer ships as plain browser scripts sharing one global scope, each
 * ending with a `module.exports = {...}` block for node. This mirrors
 * tools/verify/lib/load_classic.js: the files are concatenated in
 * index.html order and evaluated in ONE node:vm context, so a later file
 * reads the earlier ones' top-level names exactly as the page does, and the
 * union of every file's exports is the API. The copies live in runtime/
 * (scripts/sync-runtime.mjs puts them there), so the tarball needs nothing
 * from the repo.
 *
 * What is loaded is the whole stack the module view runs on: the transport
 * shim (framing, the exchange, the Web Serial bus, the fetch shim that
 * answers /api/* from the chassis archives), the BEST2 job VM, the .IPO VM
 * and the program driver over it, the .IPO reader and compiler, and the
 * garage and search modules. A fresh context, not the process's own global,
 * so the CLI's globals stay its own and the scripts' names never leak into
 * it. The cost is that host objects the scripts touch have to be handed
 * in; each one below says which script wants it and why.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import RUNTIME_FILES from './runtime-files.json' with { type: 'json' };
import { siteFetch } from './site.ts';

/** Where the copied renderer files live: beside dist/, one level up. */
export const RUNTIME_DIR = fileURLToPath(
  new URL('../runtime/', import.meta.url)
);

/** One token of a decoded proc, as the walker emits it (see walk.js). */
export interface IpoToken {
  op: string;
  n?: number;
  t?: string;
  v?: unknown;
  name?: string;
  kind?: number;
  nr?: number;
  label?: string;
  keys?: string;
  to?: number;
  at?: number;
  sc?: number;
}

/** A decoded or compiled script: the shape the app's runtime runs. */
export interface IpoExec {
  ecu: string;
  procs: Record<string, IpoToken[]>;
  byid: Record<string, string>;
  coding?: boolean;
  includes?: string[];
  imports?: Record<string, string>;
  unknown?: number;
  bytes?: number;
}

/** A menu key, as script-scan.js's ipoMenuItems reports it. */
export interface IpoMenuItem {
  nr: number;
  label: string;
  shift: boolean;
  hidden: boolean;
  start: number;
  end: number;
  legendLabel?: string;
}

/** What ipofCompileSource returns. */
export interface IpoCompileResult {
  ok: boolean;
  exec: IpoExec | null;
  errors: { line: number; text?: string; message?: string }[];
  includes: string[];
  missing: string[];
}

/** One module of the search index. */
export interface SearchModule {
  sgbd: string;
  label: string;
  code: string;
  chassis: string[];
  vehicle?: number;
}

/** One key or screen of the search index. */
export interface SearchEntry {
  t: 'k' | 's';
  i: number;
  m?: string;
  n?: number;
  l?: string;
  e?: string;
  s?: string;
  ti?: string;
  tie?: string;
  j?: string[];
  k?: string[];
  c?: string;
  ce?: string;
  w?: number;
  a?: string;
}

/** The search index as the exporter writes it. */
export interface SearchIndex {
  v: number;
  modules: SearchModule[];
  entries: SearchEntry[];
}

/** One result row. */
export interface SearchHit {
  entry: SearchEntry;
  module: SearchModule;
  score: number;
  label: string;
  sub: string;
  jobs: string[];
}

/** A finished search, grouped by chassis then module. */
export interface SearchResult {
  groups: {
    chassis: string;
    modules: { module: SearchModule; hits: SearchHit[] }[];
    total: number;
  }[];
  total: number;
  shown: number;
}

/** One stored fault, as FS_LESEN reports it (only the fields the CLI reads). */
export interface FaultCode {
  F_HEX_CODE?: string | number[];
  F_ORT_NR?: string | number;
  F_ORT_TEXT?: string;
  F_HFK?: string | number;
  F_LZ?: string | number;
  F_VORHANDEN_TEXT?: string;
  F_PCODE_STRING?: string;
  F_PCODE7_STRING?: string;
  [key: string]: unknown;
}

/** One module of a report. */
export interface ReportModule {
  sgbd: string;
  via?: string;
  label?: string;
  codes?: FaultCode[];
  ident?: Record<string, unknown>;
}

/** A whole-car read, as the Garage stores it. */
export interface Report {
  kind?: 'faults' | 'ident';
  modules: ReportModule[];
  silent?: { target: string; label?: string; error?: string }[];
}

/** What a shared link carries. */
export interface SharePayload {
  v: number;
  kind: string;
  at: string;
  chassis: string;
  label: string;
  report: Report;
  summary?: ReportSummary;
}

/** The headline counts of a report. */
export interface ReportSummary {
  modules: number;
  withFaults: number;
  faults: number;
  silent: number;
}

/** A stored scan, the diff's unit of comparison. */
export interface GarageScan {
  kind?: string;
  at?: string;
  chassis?: string;
  report: Report;
  summary?: ReportSummary;
}

/** One module's changes between two scans. */
export interface DiffModule {
  sgbd: string;
  label: string;
  added: FaultCode[];
  cleared: FaultCode[];
  same: FaultCode[];
  fields: { key: string; label: string; from: string; to: string }[];
  unread?: boolean;
  changed: boolean;
}

/** What changed between two scans. */
export interface GarageDiff {
  kind: 'faults' | 'ident' | 'mixed';
  modules: DiffModule[];
  silence: {
    target: string;
    label: string;
    state: 'silent' | 'answering';
    error?: string;
  }[];
}

/** One EDIABAS result set. */
export type ResultSet = Record<string, unknown>;

/** What the shim's run route answers. */
export interface JobAnswer {
  job: string;
  sets: ResultSet[];
  system: ResultSet;
}

/** A painted cell of the program's grid (IpoProgram.cellOf). */
export interface IpoCell {
  row: number;
  lrow: number;
  col: number;
  text: string;
  key: string | null;
  kind: 'text' | 'value' | 'lamp' | 'gauge';
  meta: {
    min?: number;
    max?: number;
    lo?: number;
    hi?: number;
    fmt?: string;
    on?: string;
    off?: string;
  } | null;
}

/** A pending action the driven VM hands back (suspensions.js). */
export interface IpoStep {
  kind: string;
  name?: string;
  prompts?: string[];
  refs?: number;
  lo?: number | null;
  hi?: number | null;
  multiple?: boolean;
  argnum?: boolean;
  title?: string;
  body?: string | null;
  filter?: string;
}

/** One job the body put on the wire (protocol.js IpoWireRead). */
export interface IpoWireRead {
  target: string;
  variant?: string;
  job: string;
  arg?: string | null;
  sets?: ResultSet[];
  error?: string;
}

/** What ipoProtocolReport folds a body's reads into. */
export interface ProtocolReport extends Report {
  kind: 'faults' | 'ident';
  showText: boolean;
}

/** The module record the program drives (ecu.js EcuRecord). */
export interface EcuRecord {
  sgbd: string;
  label: string;
  code?: string;
  group?: string | null;
  chassis?: string;
  kind?: string;
  _variant?: string;
  _variantSource?: string | null;
  _sgbdBase?: string;
  _irFrom?: string;
  _ir?: unknown;
  _ipoKnownSgbds?: Set<string>;
  [key: string]: unknown;
}

/** The context a run is driven in (program.js IpoRunContext). */
export interface IpoRunContext {
  label: string;
  scope: string;
  preConfirmed?: boolean;
}

/** The running program (program.js IpoProgram), as the UI sees it. */
export interface IpoProgramLike {
  ecu: EcuRecord;
  exec: IpoExec;
  menu: string | null;
  rootMenu: string | null;
  items: IpoMenuItem[];
  screen: string | null;
  frequent: boolean;
  title: string | null;
  cells: Map<string, IpoCell>;
  view: { lines?: string[]; report?: ProtocolReport | null } | null;
  wireReads: IpoWireRead[];
  messages: { title: string; body: string | null }[];
  log: { target: string; job: string; arg: string | null; status: string }[];
  busy: boolean;
  running: boolean;
  closed: boolean;
  noCable: boolean;
  silent: boolean;
  start(): Promise<{ ok: boolean; reason?: string }>;
  openMenu(
    name: string,
    opts?: { screen?: string | null; frequent?: boolean }
  ): Promise<boolean>;
  showScreen(name: string, frequent: boolean): Promise<void>;
  press(nr: number): Promise<boolean>;
  back(): Promise<boolean | void>;
  cancel(): void;
  leaveModule(): Promise<void>;
  close(): void;
}

/** The UI adapter the program drives (program.js IpoUi). */
export interface IpoUi {
  sleep(ms: number): Promise<void>;
  loadExec(sgbd: string): Promise<IpoExec | null>;
  route(p: IpoProgramLike): void;
  status(p: IpoProgramLike, text: string): void;
  error(p: IpoProgramLike, text: string): void;
  message(title: string, body: string | null): Promise<void>;
  askInput(
    step: IpoStep,
    label: string | undefined
  ): Promise<number | string | (number | string)[] | null>;
  confirmKey(
    p: IpoProgramLike,
    it: IpoMenuItem,
    jobs: string[],
    writes: string[]
  ): Promise<boolean>;
  confirmWrite(
    p: IpoProgramLike,
    job: string,
    arg: string | null,
    ctx: IpoRunContext
  ): Promise<boolean>;
  pickComponent(
    p: IpoProgramLike,
    step: IpoStep
  ): Promise<{ ort: string; ein: number } | null>;
  pickLines(
    p: IpoProgramLike,
    names: string[],
    multiple: boolean,
    current: Set<string> | null,
    hints?: { key: string; label: string; lines: number }[]
  ): Promise<string[] | null>;
  saveFile(p: IpoProgramLike, step: IpoStep): Promise<{ name: string } | null>;
  writeFile(
    p: IpoProgramLike,
    picked: { name: string },
    lines: string[]
  ): Promise<void>;
  printScreen(p: IpoProgramLike): void;
  resolveScriptEcu?(
    from: EcuRecord,
    script: string,
    exec: IpoExec
  ): Promise<EcuRecord | null>;
  machineTick(
    p: IpoProgramLike,
    step: IpoStep,
    guards: Set<number>
  ): Promise<'tick' | 'press' | 'stop'>;
  /** BMWeb's own picker (the home script): the host's list, one chosen */
  pickHome?(p: IpoProgramLike, step: HomePickStep): Promise<string | null>;
  userbox(
    p: IpoProgramLike,
    box: { title?: string; lines?: string[] } | null
  ): void;
  renderKeys(p: IpoProgramLike): void;
  paint(p: IpoProgramLike): void;
  left(p: IpoProgramLike): void;
}

/** A bmweb_pick suspension (suspensions.js): what to list, scoped to what. */
export interface HomePickStep extends IpoStep {
  kind: 'pick';
  what: 'chassis' | 'module' | 'vehicle' | string;
  arg: string;
}

/** One row a home pick offers. */
export interface HomeOption {
  value: string;
  label: string;
  meta?: string;
}

/** What the host offers the home script's picks (home.js IpoHomeHost). */
export interface HomeHost {
  chassis(): Promise<HomeOption[]>;
  modules(chassis: string): Promise<HomeOption[]>;
  vehicle(chassis: string): Promise<string>;
  status(): string;
}

/** The bus (transport-base.js Transport), as the CLI drives it. */
export interface Bus {
  connected: boolean;
  connect(): Promise<string>;
  disconnect(): Promise<void>;
  portLabel(): string;
  readState?(): Promise<{
    battery: number | null;
    ignition: boolean | null;
    derived?: boolean;
    sensed?: boolean;
  }>;
  sessionConcept: number | null;
  inited: boolean | null;
}

/** The app functions the CLI calls, typed at the seam. */
export interface Runtime {
  ipofDecodeExec(data: Uint8Array, stem: string): IpoExec;
  ipofInventory(exec: IpoExec): {
    menus: string[];
    screens: string[];
    funcs: string[];
    machines: string[];
  };
  ipofIsCompiled(name: string): boolean;
  ipofIsSource(name: string): boolean;
  ipofIsInclude(name: string): boolean;
  ipofStem(name: string): string;
  ipofScanIncludes(src: string): string[];
  ipofCompileSource(
    src: string,
    opts: { name?: string; files?: Record<string, string> }
  ): IpoCompileResult;
  IPO_REF_SCREEN: number;
  IPO_REF_MENU: number;
  IPO_TICK_MS: number;
  ipoMenuItems(exec: IpoExec, menu: string): IpoMenuItem[];
  ipoScreenForMenu(
    exec: IpoExec,
    menu: string
  ): { screen: string; frequent: boolean } | null;
  ipoScreenComponents(
    exec: IpoExec,
    screen: string | null
  ): { label: string; keys: string }[];
  ipoNeedsConfirm(job: string): boolean;
  ipoWireTarget(ecu: EcuRecord, sgbd: string | null): string;
  isWriteJob(name: string): boolean;
  IpoProgram: new (ecu: EcuRecord, exec: IpoExec, ui: IpoUi) => IpoProgramLike;
  ipoProtocolReport(reads: IpoWireRead[], lines?: string[]): ProtocolReport;
  irLiveExec(sgbd: string): Promise<IpoExec | null>;
  irSeedExec(sgbd: string, exec: IpoExec | null): void;
  ipoResolveScriptEcu(
    from: EcuRecord,
    script: string,
    exec: IpoExec
  ): Promise<EcuRecord | null>;
  webResolveVariant(group: string): Promise<string | null>;
  webResolveVariantLast(): {
    group: string;
    path: string;
    error?: string;
  } | null;
  withBusLock<T>(fn: () => Promise<T> | T): Promise<T>;
  webBus: Bus;
  /** the home script's SGBD name ('bmweb_home'); no BMW file has it */
  IPO_HOME_SGBD: string;
  /** the host the home script's status line and the browser's picker read */
  IPO_HOME_HOST: HomeHost;
  ipoHomeSource(): { ips: string; h: string };
  ipoHomeExec(): IpoExec;
  ipoHomeEcuFor(from: EcuRecord, script: string): Promise<EcuRecord | null>;
  IPO_IDENT_ROWS: [string[], string][];
  SEARCH_INDEX_VERSION: number;
  searchTerms(q: string): string[];
  searchRun(
    index: SearchIndex | null,
    q: string,
    opts?: { chassis?: string; max?: number }
  ): SearchResult;
  searchHitRoute(hit: SearchHit, chassis: string): string | null;
  garageShareEncode(
    scan: GarageScan,
    car?: { label?: string; chassis?: string }
  ): Promise<string>;
  garageShareDecode(payload: string): Promise<SharePayload | null>;
  garageScanSummary(report: Report): ReportSummary;
  garageDiffScans(from: GarageScan, to: GarageScan): GarageDiff;
  garageDiffCounts(diff: GarageDiff): {
    added: number;
    cleared: number;
    same: number;
    fields: number;
    silence: number;
    modules: number;
  };
  garageFaultKeys(code: FaultCode): string[];
}

/** The app's engine client: a route in, its JSON out (core/core/api.js). */
export type ApiFn = (path: string, opts?: RequestInit) => Promise<unknown>;

/** The loaded runtime, once per process: a second load would redeclare. */
let loaded: Runtime | null = null;

/** The context's global object, once loaded (navigator.serial is set on it). */
let sandboxRef: Record<string, unknown> | null = null;

/**
 * What `api()` does inside the runtime. The default goes through the
 * context's own fetch, which the shim has wrapped: /api/ecu/<sgbd>/run/<job>
 * runs the job in the VM over the bus, /api/ecu/<sgbd>/ipoexec comes out
 * of the chassis archive. A test swaps in a fake car.
 */
let apiImpl: ApiFn | null = null;

/**
 * Replace (or restore) the engine client the runtime's `api()` calls.
 * @param fn - the client, or null for the shim's fetch
 */
export function setApiImpl(fn: ApiFn | null): void {
  apiImpl = fn;
}

/**
 * The context's global object: where navigator.serial goes once a port is
 * chosen, and where the shim-wrapped fetch lives.
 * @returns the sandbox
 */
export function runtimeGlobals(): Record<string, unknown> {
  loadRuntime();
  return sandboxRef as Record<string, unknown>;
}

/**
 * The host globals the scripts reach for, and why each is here.
 *
 * Only what a listed file touches at load time or on the paths the CLI
 * uses; a script's DOM half (render functions, buttons) is never called.
 * @returns the sandbox the context is built from
 */
function hostGlobals(): Record<string, unknown> {
  const noop = (): void => {};
  const sandbox: Record<string, unknown> = {
    // the scripts test `typeof window` and read window.<x>; the context's own
    // global stands in, as it does in the page (self: fflate's UMD attaches
    // its global to `self` when there is no CommonJS `exports`)
    console,
    // timers.js's bmwSleep falls back to setTimeout where there is no
    // Worker; program.js schedules screen cycles and drains key presses
    // through setTimeout; activations.js defers a session end a microtask
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    // share.js: TextEncoder/TextDecoder, Blob, Response and the two
    // compression streams encode and decode the link payload; btoa/atob do
    // the base64url. api-router.js builds Responses and reads query strings;
    // data-fetch.js decodes archive members. All are Node 18+ globals,
    // handed into the fresh realm.
    TextEncoder,
    TextDecoder,
    Blob,
    Response,
    Request,
    URL,
    URLSearchParams,
    CompressionStream,
    DecompressionStream,
    btoa,
    atob,
    // WHAT THE APP READS ITS DATA THROUGH. install.js takes window.fetch as
    // the real fetch and wraps it with the shim; every site-relative path
    // the shim then asks for is served from the hosted site through the
    // disk cache (site.ts), never from a local vendor tree.
    fetch: siteFetch,
    // web-serial-bus.js asks navigator.serial for the port; the CLI fills
    // this in with the Node port once one is chosen (live.ts)
    navigator: { serial: undefined },
    // activations.js registers a pagehide hook at load; the bus announces
    // cable events; neither has a page here
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: noop,
    // ui.js writes the key caption into the document's style at render
    // time and the harness stubs getElementById; neither draws anything
    document: {
      getElementById: () => null,
      documentElement: { style: { setProperty: noop, removeProperty: noop } },
    },
    // the status bar the runtime writes to
    sbLeft: { textContent: '' },
    sbRight: { textContent: '' },
    // HTML escaping, identity here: no DOM receives the text
    esc: (s: unknown): string => String(s == null ? '' : s),
    // the F-key bar; the CLI's own UI adapter renders keys itself
    setActions: noop,
    // translate.js and translate-sets.js gate on the language setting
    lang: (): string => 'en',
    // the fault dictionaries the fed results are translated through: the
    // large generated ones are not in this package, so results stay as the
    // module sent them (the app behaves the same in a build without them)
    BMW_ENV_TEXT: {},
    BMW_FAULT_PHRASES: {},
    BMW_FAULT_DB: {},
    scopedFaultDb: (): null => null,
    // a chassis id's display name (core/core/ui.js); the id is fine here
    dispChassis: (id: unknown): string => String(id || ''),
    // store.js persists through Settings and wire-policy.js reads the
    // confirmActuators preference; the CLI stores nothing and confirms
    // every actuator drive, so a read-only stand-in returning the default
    // is exact
    Settings: {
      get: (_k: string, d: unknown) => d,
      set: noop,
    },
    // open.js's searchOpenHit assigns location.hash; api-router.js derives
    // WEB_BASE from the pathname (empty: paths hang off the site root)
    location: { hash: '', href: '', pathname: '/', search: '' },
    // the engine client (core/core/api.js): a route in, its JSON out, the
    // server's `error` field as the thrown message. Routed through apiImpl
    // so a test can put a fake car behind the very same call.
    api: async (path: string, opts?: RequestInit): Promise<unknown> => {
      if (apiImpl) return apiImpl(path, opts);
      const f = sandbox.fetch as typeof fetch;
      const res = await f(path, opts);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || res.statusText);
      }
      return res.json();
    },
    // the result-set projection (core/core/api.js): the engine's synthetic
    // system set dropped when it leads
    dataSets: (sets: ResultSet[] | null | undefined): ResultSet[] => {
      const list = sets || [];
      const s = list[0];
      const system =
        !!s &&
        typeof s === 'object' &&
        ('SAETZE' in s || 'JOBNAME' in s || 'OBJECT' in s);
      return list.length && system ? list.slice(1) : list;
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  return sandbox;
}

/**
 * Load the app's scripts into a fresh context and return their exports.
 *
 * Each file assigns `module.exports = {...}`; a collector merges them so the
 * result is the union, the same way load_classic.js does it.
 * @returns the runtime API
 */
export function loadRuntime(): Runtime {
  if (loaded) return loaded;
  const sandbox = hostGlobals();
  const collected: Record<string, unknown> = {};
  sandbox.module = {
    get exports() {
      return collected;
    },
    set exports(v: Record<string, unknown>) {
      Object.assign(collected, v);
    },
  };
  const context = createContext(sandbox);
  for (const rel of RUNTIME_FILES) {
    // the home script's source and include travel in the same list so the
    // sync copies them; they are read by the app's compiler, not evaluated
    if (!rel.endsWith('.js')) continue;
    const file = join(RUNTIME_DIR, rel);
    let code: string;
    try {
      code = readFileSync(file, 'utf8');
    } catch {
      throw new Error(
        `runtime file missing: ${rel} (the package was built without scripts/sync-runtime.mjs)`
      );
    }
    runInContext(code, context, { filename: rel });
  }
  // top-level names the CLI reads that no file's module.exports carries:
  // protocol.js's ident captions, the bus and its lock (bus.js publishes
  // them on window), the resolver, the tick period
  for (const name of LIFTED_GLOBALS) {
    collected[name] = runInContext(
      `typeof ${name} === 'undefined' ? undefined : ${name}`,
      context
    );
  }
  sandboxRef = sandbox;
  loaded = collected as unknown as Runtime;
  return loaded;
}

/** Top-level names the CLI reads that no file's module.exports carries. */
const LIFTED_GLOBALS = [
  'IPO_IDENT_ROWS',
  'IPO_TICK_MS',
  'webBus',
  'withBusLock',
  'webResolveVariant',
  'webResolveVariantLast',
  'isWriteJob',
  'ipoProtocolReport',
  // home.js's host object: the status builtin reads it by name, so the
  // CLI hangs its own status on it rather than on the VM
  'IPO_HOME_HOST',
];

/** The files the runtime is made of, for the loader test. */
export const RUNTIME_FILE_LIST: readonly string[] = RUNTIME_FILES;
