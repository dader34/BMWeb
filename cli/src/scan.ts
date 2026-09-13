/**
 * @file `scan`: INPA's own whole-vehicle script, run headless, its fault
 * report printed.
 *
 * The app's Garage does exactly this on screen: open the chassis script
 * (E46.IPO and friends), go to its fault-memory menu, press the read key,
 * and fold what the body put on the wire into a report (protocol.js).
 * Here the same program runs against a UI adapter that answers every
 * dialog the read-only way: a write is declined, a prompt is cancelled, a
 * message is printed, the progress window becomes a line on stderr.
 */
import { CliError } from './args.ts';
import { openModule } from './live.ts';
import { reportBodyLines } from './report.ts';
import { formatTable } from './table.ts';
import {
  loadRuntime,
  runtimeGlobals,
  setApiImpl,
  type ApiFn,
  type EcuRecord,
  type IpoExec,
  type IpoProgramLike,
  type IpoUi,
  type ProtocolReport,
  type Runtime,
} from './runtime.ts';

/**
 * The whole-vehicle script each chassis ships, by the name the site files
 * it under (the search index's vehicle modules).
 */
export const VEHICLE_SCRIPTS: Record<string, string> = {
  E46: 'e46',
  E53: 'e53',
  E65: 'e65',
  E83: 'e83',
  E85: 'e85',
  E87: 'e87',
  E89: 'e89_d_all',
  E90: 'e90',
  R50: 'r50',
  R56: 'r56_all',
};

/**
 * The fault-memory read key of INPA's whole-vehicle scripts, by caption:
 * E46.IPO says "FS lesen", E53 and E85 "Read error memory", others spell it
 * out (the Garage's GARAGE_FAULT_KEY, widened for the English scripts).
 */
export const FAULT_KEY_RE =
  /^(FS lesen|Fehlerspeicher lesen|Read (fault|error) memory)$/i;

/** The menu those scripts keep the read key on (nav.js IPO_VEHICLE_FAULT_MENU). */
export const FAULT_MENU = 'm_fs';

/** How `scan` is steered. */
export interface ScanOptions {
  /** print a Garage share link as well */
  share?: boolean;
  /** machine-readable output */
  json?: boolean;
  /** where progress and messages go (stderr unless a test captures them) */
  progress?: (line: string) => void;
  /** the engine client; the runtime's own unless a test fakes the car */
  apiFn?: ApiFn;
  /** the script, when a test supplies one instead of the site's */
  exec?: IpoExec;
  /** the module record, when a test supplies one */
  ecu?: EcuRecord;
  /** the car's label on the share link */
  label?: string;
  /**
   * walk ISTA's control unit tree instead of running INPA's script.
   * Reaches every chassis ISTA draws a tree for -- 22 against the 10 that
   * ship a script -- and more modules on the ones that ship both.
   */
  tree?: boolean;
}

/**
 * The read-only UI adapter a headless scan runs against.
 * @param progress - where progress and messages go
 * @returns the adapter
 */
export function headlessUi(progress: (line: string) => void): IpoUi {
  let lastBox = '';
  return {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    loadExec: async (sgbd) => loadRuntime().irLiveExec(sgbd),
    route: () => {},
    status: () => {},
    error: (_p, text) => progress(`error: ${text}`),
    message: async (title, body) => {
      progress(`${title}${body ? `: ${body}` : ''}`);
    },
    // a prompt cannot be answered headless: the key is abandoned
    askInput: async () => null,
    // a scan reads; a key that would write is declined, never sent
    confirmKey: async () => false,
    confirmWrite: async () => false,
    pickComponent: async () => null,
    pickLines: async () => null,
    saveFile: async () => null,
    writeFile: async () => {},
    printScreen: () => {},
    resolveScriptEcu: (from, script, exec) =>
      loadRuntime().ipoResolveScriptEcu(from, script, exec),
    machineTick: async () => 'tick',
    userbox: (_p, box) => {
      if (!box) return;
      const lines = box.lines || [];
      const text = lines.length ? String(lines[lines.length - 1]) : '';
      if (text && text !== lastBox) {
        lastBox = text;
        progress(text.trim());
      }
    },
    renderKeys: () => {},
    paint: () => {},
    left: () => {},
  };
}

/**
 * Run the whole-vehicle read and fold it into a report.
 * @param chassis - the chassis id
 * @param opts - see ScanOptions
 * @returns the report, the program's messages, and the lines to print
 */
export async function scanCommand(
  chassis: string,
  opts: ScanOptions = {}
): Promise<{ report: ProtocolReport; lines: string[]; link?: string }> {
  const R = loadRuntime();
  const cid = chassis.toUpperCase();
  // the program reaches the car through the runtime's own api(): a client
  // handed in (a test's fake car) stands in for the shim while this runs
  if (opts.apiFn) setApiImpl(opts.apiFn);
  try {
    return opts.tree
      ? await treeScanRun(R, cid, opts)
      : await scanRun(R, cid, opts);
  } finally {
    if (opts.apiFn) setApiImpl(null);
  }
}

/**
 * The scan itself, once the engine client is in place.
 * @param R - the runtime
 * @param cid - the chassis id, upper-case
 * @param opts - see ScanOptions
 * @returns the report and the lines
 */
async function scanRun(
  R: Runtime,
  cid: string,
  opts: ScanOptions
): Promise<{ report: ProtocolReport; lines: string[]; link?: string }> {
  const progress =
    opts.progress || ((l: string) => process.stderr.write(`${l}\n`));
  const api = opts.apiFn || (runtimeGlobals().api as ApiFn);
  let ecu: EcuRecord;
  let exec: IpoExec;
  if (opts.exec) {
    ecu = opts.ecu || {
      code: cid,
      sgbd: cid.toLowerCase(),
      label: `INPA ${cid} script`,
      group: null,
      kind: 'vehicle',
      chassis: cid,
    };
    exec = opts.exec;
  } else {
    const script = VEHICLE_SCRIPTS[cid];
    if (!script)
      throw new CliError(
        `no whole-vehicle script for ${cid} (one ships for ${Object.keys(VEHICLE_SCRIPTS).join(' ')})`
      );
    ({ ecu, exec } = await openModule(cid, script, api));
    ecu.kind = 'vehicle';
  }
  const ui = headlessUi(progress);
  const p: IpoProgramLike = new R.IpoProgram(ecu, exec, ui);
  const r = await p.start();
  if (p.noCable) throw new CliError('no cable connected');
  if (!r.ok) {
    const last = p.messages[p.messages.length - 1];
    throw new CliError(
      `${cid}: the script did not start (${r.reason || 'stopped'})` +
        (last ? `: ${last.title}${last.body ? ` ${last.body}` : ''}` : '')
    );
  }
  if (exec.procs[FAULT_MENU] && p.menu !== FAULT_MENU)
    await p.openMenu(FAULT_MENU);
  const key = p.items.find((it) =>
    FAULT_KEY_RE.test(String(it.label || it.legendLabel || '').trim())
  );
  if (!key) {
    const have = p.items.map((it) => `F${it.nr} ${it.label}`).join(', ');
    p.close();
    throw new CliError(
      `${cid}: no fault-memory read key on ${p.menu} (keys: ${have})`
    );
  }
  progress(`${cid}: ${key.label} (F${key.nr})`);
  await p.press(key.nr);
  const report =
    (p.view && p.view.report) ||
    R.ipoProtocolReport(p.wireReads, (p.view && p.view.lines) || []);
  await p.leaveModule();
  const summary = R.garageScanSummary(report);
  const at = new Date().toISOString();
  let link: string | undefined;
  if (opts.share) {
    const payload = await R.garageShareEncode(
      { kind: report.kind, at, chassis: cid, report, summary },
      { label: opts.label || '', chassis: cid }
    );
    link = `https://bmweb.danner.ink/#report/${payload}`;
  }
  if (opts.json) {
    return {
      report,
      link,
      lines: [
        JSON.stringify({ chassis: cid, at, summary, report, link }, null, 2),
      ],
    };
  }
  const lines = formatTable([
    ['Scan', `${cid} fault memories (${ecu.sgbd}.ipo)`],
    ['Read', at],
    [
      'Modules',
      `${summary.modules} answered, ${summary.withFaults} with faults, ${summary.faults} fault${
        summary.faults === 1 ? '' : 's'
      }, ${summary.silent} silent`,
    ],
  ]);
  lines.push('', ...reportBodyLines(report, report.kind));
  if (link) lines.push('', `Share: ${link}`);
  return { report, lines, link };
}

/**
 * The tree-driven scan: ISTA's control unit tree walked module by module.
 *
 * Where scanRun drives INPA's whole-car script, this addresses each group the
 * tree names directly. It is the only whole-car read most chassis can have --
 * ISTA ships a tree for 22 of ours, INPA a script for 10 -- and on a chassis
 * with both it reaches more modules (75 targets against 41 on E46). The walk
 * itself lives in the app (screens/tree/treescan.js) so the terminal and the
 * page run the same scanner; only the progress sink differs.
 * @param R - the runtime
 * @param cid - the chassis id, upper-case
 * @param opts - see ScanOptions
 * @returns the report and the lines
 */
async function treeScanRun(
  R: Runtime,
  cid: string,
  opts: ScanOptions
): Promise<{ report: ProtocolReport; lines: string[]; link?: string }> {
  const progress =
    opts.progress || ((l: string) => process.stderr.write(`${l}\n`));
  const targets = await R.ecuTreeWalkTargets(cid);
  if (!targets.length)
    throw new CliError(
      `no control unit tree for ${cid} (ISTA ships none, or the tree data is not reachable)`
    );
  progress(`${cid}: ${targets.length} modules on ISTA's tree`);
  // jobNamesFor is a page-side helper the runtime does not export; the walk
  // takes it as a dependency, so the CLI asks the engine the same way
  const apiOf = () => opts.apiFn || (runtimeGlobals().api as ApiFn);
  const jobNames = async (sgbd: string): Promise<string[]> => {
    try {
      const j = (await apiOf()(`/api/ecu/${sgbd}/jobs`)) as
        | unknown[]
        | { jobs?: unknown[] };
      const list = Array.isArray(j) ? j : j.jobs || [];
      return list
        .map((x) =>
          typeof x === 'string' ? x : (x as { job?: string; name?: string }).job
        )
        .filter((x): x is string => !!x);
    } catch {
      return [];
    }
  };
  // a fault read that declares an argument must be SENT with it: lsz_2
  // declares FS_LESEN(ALL_BLOCKS) and answers F_ZAHL 0 -- blocks 1-3 only --
  // when called bare, hiding a real fault in block 5. The /jobs route carries
  // names only, so the arguments come from their own route.
  const jobArgs = async (sgbd: string, job: string): Promise<unknown[]> => {
    try {
      const j = (await apiOf()(`/api/ecu/${sgbd}/arguments/${job}`)) as {
        arguments?: unknown[];
      };
      return j.arguments || [];
    } catch {
      return [];
    }
  };
  let last = '';
  const { report } = await R.ecuTreeWalkStart(
    cid,
    {
      onProgress: (_r, text) => {
        if (text && text !== last) {
          last = text;
          progress(text);
        }
      },
    },
    { jobNames, jobArgs }
  ).done;
  const summary = R.garageScanSummary(report);
  const at = new Date().toISOString();
  let link: string | undefined;
  if (opts.share) {
    const payload = await R.garageShareEncode(
      { kind: report.kind, at, chassis: cid, report, summary },
      { label: opts.label || '', chassis: cid }
    );
    link = `https://bmweb.danner.ink/#report/${payload}`;
  }
  if (opts.json)
    return {
      report,
      link,
      lines: [
        JSON.stringify(
          { chassis: cid, at, source: 'ista-tree', summary, report, link },
          null,
          2
        ),
      ],
    };
  const lines = formatTable([
    ['Scan', `${cid} fault memories (ISTA control unit tree)`],
    ['Read', at],
    ['Targets', `${targets.length} groups`],
    [
      'Modules',
      `${summary.modules} answered, ${summary.withFaults} with faults, ${summary.faults} fault${
        summary.faults === 1 ? '' : 's'
      }, ${summary.silent} silent`,
    ],
  ]);
  lines.push('', ...reportBodyLines(report, report.kind));
  if (link) lines.push('', `Share: ${link}`);
  return { report, lines, link };
}
