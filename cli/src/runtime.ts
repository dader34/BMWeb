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
 * A fresh context, not the process's own global, so the CLI's globals stay
 * its own and the scripts' names (hundreds of them) never leak into it. The
 * cost is that host objects the scripts touch have to be handed in; each
 * one below says which script wants it and why.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import RUNTIME_FILES from './runtime-files.json' with { type: 'json' };

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
  ipoMenuItems(exec: IpoExec, menu: string): IpoMenuItem[];
  ipoScreenForMenu(
    exec: IpoExec,
    menu: string
  ): { screen: string; frequent: boolean } | null;
  ipoNeedsConfirm(job: string): boolean;
  isWriteJob(name: string): boolean;
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

/** The loaded runtime, once per process: a second load would redeclare. */
let loaded: Runtime | null = null;

/**
 * The host globals the scripts reach for, and why each is here.
 *
 * Only what a listed file touches at load time or on the paths the CLI
 * uses; a script's DOM half (render functions, buttons) is never called.
 * @returns the sandbox the context is built from
 */
function hostGlobals(): Record<string, unknown> {
  const sandbox: Record<string, unknown> = {
    // the scripts test `typeof window` and read window.<x>; the context's own
    // global stands in, as it does in the page
    console,
    // share.js: TextEncoder/TextDecoder, Blob, Response and the two
    // compression streams encode and decode the link payload; btoa/atob do
    // the base64url. All are Node 18+ globals, handed into the fresh realm.
    TextEncoder,
    TextDecoder,
    Blob,
    Response,
    CompressionStream,
    DecompressionStream,
    btoa,
    atob,
    // store.js flattens F_HEX_CODE byte arrays through hexText and captions
    // a chassis through dispChassis; both are core/translate.js's, which
    // pulls the whole dictionary set in, so the two one-liners are restated
    hexText: (v: unknown): string => {
      if (v == null || v === '') return '';
      if (typeof v === 'string') return v;
      if (Array.isArray(v) || ArrayBuffer.isView(v))
        return Array.from(v as ArrayLike<number>, (b) =>
          (b & 0xff).toString(16).toUpperCase().padStart(2, '0')
        ).join('-');
      return String(v);
    },
    dispChassis: (id: unknown): string => String(id || ''),
    // store.js persists through Settings and wire-policy.js reads the
    // confirmActuators preference; the CLI stores nothing and confirms
    // nothing, so a read-only stand-in returning the default is exact
    Settings: {
      get: (_k: string, d: unknown) => d,
      set: () => {},
    },
    // open.js's searchOpenHit assigns location.hash; the CLI prints the
    // route instead, but the name has to resolve
    location: { hash: '', href: '' },
  };
  sandbox.window = sandbox;
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
  // protocol.js declares the ident captions as a top-level const the page
  // reads by name and never exports; lifted out of the context so the
  // report printer captions ident rows the way the app does
  for (const name of LIFTED_GLOBALS) {
    collected[name] = runInContext(
      `typeof ${name} === 'undefined' ? undefined : ${name}`,
      context
    );
  }
  loaded = collected as unknown as Runtime;
  return loaded;
}

/** Top-level names the CLI reads that no file's module.exports carries. */
const LIFTED_GLOBALS = ['IPO_IDENT_ROWS'];

/** The files the runtime is made of, for the loader test. */
export const RUNTIME_FILE_LIST: readonly string[] = RUNTIME_FILES;
