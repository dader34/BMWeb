/**
 * @file The car end: the cable, the module record, and the `ports` and
 * `job` commands.
 *
 * Everything on the wire is the app's: the bus (WebSerialBus over the Node
 * port), the exchange and framing, the sessions, the group resolver and
 * the job VM, reached through the shim's own fetch exactly as the browser
 * reaches them. What the CLI adds is choosing the port, saying no cable in
 * plain words, and the write gate in front of `job`: the app's classifier
 * decides what a write is, and a write needs --yes or a y/N answer. A
 * write is never sent silently.
 */
import { createInterface } from 'node:readline';
import { CliError } from './args.ts';
import { GatewayPort, gatewayUrl } from './gateway-client.ts';
import { formatTable } from './table.ts';
import {
  loadRuntime,
  runtimeGlobals,
  type ApiFn,
  type EcuRecord,
  type IpoExec,
  type JobAnswer,
  type ResultSet,
  type Runtime,
} from './runtime.ts';
import {
  choosePort,
  listPorts,
  NodeSerialPort,
  openSerialportBinding,
  type BindingOpener,
  type PortInfo,
} from './serial.ts';
import { configureSite } from './site.ts';

/** How a live command reaches the car. */
export interface LiveOptions {
  /** the device path; the single candidate when absent */
  port?: string;
  /** a gateway's host:port or ws:// URL: the cable is on another machine */
  gateway?: string;
  /** the site the data comes from */
  api?: string;
  /** refetch cached data */
  refresh?: boolean;
  /** how a binding is opened (a test hands in a fake car) */
  opener?: BindingOpener;
  /** the candidates, when a test supplies them */
  ports?: PortInfo[];
}

/**
 * The hint an echo failure carries: on a Mac the FTDI driver's default
 * latency timer batches bytes so the echo arrives late and mismatched.
 */
export const FTDI_HINT =
  'If this is an FTDI cable, set its latency timer to 1 ms (Linux: done for you; ' +
  'macOS: FTDI D2XX/driver setting; Windows: Device Manager, Port Settings, Advanced).';

/**
 * The gateway port this process dialled, if any, so disconnectBus can drop
 * the socket after the bus has closed the remote cable.
 */
let dialled: GatewayPort | null = null;

/**
 * Connect the app's bus to the chosen port, local or remote.
 *
 * The site is configured first (the shim fetches its archives on the
 * first job), then navigator.serial is given the port so the bus's own
 * connect() opens it, sets the idle lines and resets its wire state
 * exactly as it does in the browser. WHICH port is the only difference a
 * gateway makes: --gateway dials a machine that owns the cable and hands
 * the bus a port with the same Web Serial shape, so not one line of the
 * transport, the framing or the write gate changes.
 * @param opts - the port, gateway and site options
 * @returns the runtime and the port label
 */
export async function connectBus(
  opts: LiveOptions = {}
): Promise<{ R: Runtime; label: string; path: string }> {
  configureSite({
    ...(opts.api ? { base: opts.api } : {}),
    refresh: !!opts.refresh,
  });
  const R = loadRuntime();
  const g = runtimeGlobals();
  let port: NodeSerialPort | GatewayPort;
  let path: string;
  if (opts.gateway) {
    const url = gatewayUrl(opts.gateway);
    const remote = new GatewayPort(url);
    await remote.dial();
    dialled = remote;
    port = remote;
    path = url;
  } else {
    const candidates = opts.ports || (await listPorts());
    path = choosePort(opts.port, candidates);
    port = new NodeSerialPort(path, opts.opener || openSerialportBinding);
  }
  (g.navigator as { serial: unknown }).serial = {
    requestPort: async () => port,
    getPorts: async () => [],
  };
  let label: string;
  try {
    label = await R.webBus.connect();
  } catch (e) {
    if (dialled === port) {
      dialled.hangUp();
      dialled = null;
    }
    throw new CliError(`cannot open ${path}: ${(e as Error).message}`);
  }
  // the chip and the status line say where the car is, not just that it is
  if (port instanceof GatewayPort)
    label = `gateway ${path}${port.remoteDevice ? ` (${port.remoteDevice})` : ''}`;
  return { R, label, path };
}

/**
 * Let every queued exchange finish, then close the port. A menu's release
 * job is fired without being awaited (activations.js), so the lock is
 * taken once more before the wire goes. A gateway socket is hung up after
 * the bus has closed the remote cable, never before: the close travels
 * over that very socket.
 * @param R - the runtime
 */
export async function disconnectBus(R: Runtime): Promise<void> {
  try {
    await R.withBusLock(async () => {});
  } catch {
    /* the queue drained with an error; leaving anyway */
  }
  if (R.webBus.connected) await R.webBus.disconnect();
  if (dialled) {
    dialled.hangUp();
    dialled = null;
  }
}

/**
 * `ports`: the candidate devices.
 * @param json - machine-readable output
 * @param ports - the candidates (listPorts() unless a test supplies them)
 * @returns the lines
 */
export async function portsCommand(
  json: boolean,
  ports?: PortInfo[]
): Promise<string[]> {
  const list = ports || (await listPorts());
  if (json) return [JSON.stringify(list, null, 2)];
  if (!list.length)
    return [
      'no candidate ports (cu.usbserial*, cu.SLAB*, cu.wchusbserial*, ttyUSB*, ttyACM*)',
    ];
  return formatTable(list.map((p) => [p.path, p.detail]));
}

/**
 * Ask y/N on the terminal. Without a terminal the answer is no: a script
 * piping into bmweb cannot consent to a write by accident.
 * @param question - what to ask
 * @param io - the streams (tests inject theirs)
 * @returns true for y or yes
 */
export async function askYesNo(
  question: string,
  io: {
    input?: NodeJS.ReadableStream & { isTTY?: boolean };
    output?: NodeJS.WritableStream;
  } = {}
): Promise<boolean> {
  const input = io.input || process.stdin;
  const output = io.output || process.stderr;
  if (!io.input && !process.stdin.isTTY) return false;
  const rl = createInterface({ input, output });
  const answer = await new Promise<string>((res) =>
    rl.question(`${question} [y/N] `, res)
  );
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

/** How `job` is steered. */
export interface JobOptions {
  /** the job argument */
  arg?: string;
  /** consent to a write given on the command line */
  yes?: boolean;
  /** machine-readable output */
  json?: boolean;
  /** how consent is asked; askYesNo unless a test answers */
  confirm?: (question: string) => Promise<boolean>;
  /** the engine client; the runtime's own unless a test fakes the car */
  apiFn?: ApiFn;
  /** only these result names, case-insensitively (empty: all of them) */
  results?: string[];
  /** where a name that matched nothing is reported */
  warn?: (line: string) => void;
}

/**
 * Keep only the wanted result keys of every set.
 *
 * A name is matched without regard to case, and the set's own key order is
 * kept, so a filtered set reads like the unfiltered one with rows removed
 * rather than reordered by whatever order the flag was typed in. A set left
 * with nothing still comes back, because "set 3 answered, none of the keys
 * you asked for" is a different fact from "there were two sets".
 * @param sets - the job's result sets
 * @param want - the names asked for
 * @returns the filtered sets, and every name that matched nothing
 */
export function filterResults(
  sets: ResultSet[],
  want: string[]
): { sets: ResultSet[]; missing: string[] } {
  const wanted = new Set(want.map((n) => n.toUpperCase()));
  const seen = new Set<string>();
  const out = sets.map((set) => {
    const kept: ResultSet = {};
    for (const [k, v] of Object.entries(set)) {
      const up = k.toUpperCase();
      if (!wanted.has(up)) continue;
      seen.add(up);
      kept[k] = v;
    }
    return kept;
  });
  const missing = want.filter((n) => !seen.has(n.toUpperCase()));
  return { sets: out, missing };
}

/**
 * `job`: one raw job on one module, like the app's Tool32.
 *
 * The write gate is the app's classifier (isWriteJob: read tokens win,
 * write tokens next, unknown names are writes). A write goes out only with
 * --yes or a y answer; a refusal is the command's result, not an error.
 * @param sgbd - the SGBD (a group name such as D_MOTOR resolves on the wire)
 * @param job - the job name
 * @param opts - argument, consent, output
 * @returns the lines to print
 */
export async function jobCommand(
  sgbd: string,
  job: string,
  opts: JobOptions = {}
): Promise<string[]> {
  const R = loadRuntime();
  const name = job.toUpperCase();
  const target = sgbd.toLowerCase();
  if (R.isWriteJob(name) && !opts.yes) {
    const ask = opts.confirm || askYesNo;
    const ok = await ask(
      `${name} on ${target} is a write (it changes the module or drives something). Send it?`
    );
    if (!ok)
      return [
        `${name} on ${target}: not sent (a write needs --yes or a y answer)`,
      ];
  }
  const api = opts.apiFn || (runtimeGlobals().api as ApiFn);
  const q =
    opts.arg != null && opts.arg !== ''
      ? `?arg=${encodeURIComponent(opts.arg)}`
      : '';
  let d: JobAnswer;
  try {
    d = (await api(`/api/ecu/${target}/run/${encodeURIComponent(name)}${q}`, {
      method: 'POST',
    })) as JobAnswer;
  } catch (e) {
    const m = String((e as Error).message || e);
    throw new CliError(
      `${name} on ${target}: ${m}${/IFH-0003/.test(m) ? `\n${FTDI_HINT}` : ''}`
    );
  }
  // --results narrows what is shown, never what was asked of the car: the
  // job ran whole, and the same rows are dropped from the table and from
  // the JSON so the two never disagree about what was read
  const want = (opts.results || []).filter((n) => n);
  if (want.length) {
    const f = filterResults(d.sets || [], want);
    d = { ...d, sets: f.sets };
    if (f.missing.length) {
      const warn = opts.warn || ((l: string) => process.stderr.write(l + '\n'));
      warn(
        `bmweb: ${name} on ${target} returned no result named ${f.missing.join(', ')}`
      );
    }
  }
  if (opts.json) return [JSON.stringify(d, null, 2)];
  return formatAnswer(d);
}

/**
 * A job's answer as text: the system record on one line, then each result
 * set as a KEY VALUE table.
 * @param d - what the run route answered
 * @returns the lines
 */
export function formatAnswer(d: JobAnswer): string[] {
  const sys = d.system || {};
  const out: string[] = [
    `${String(sys.OBJECT || '')} ${String(sys.VARIANTE || '')} ${String(sys.JOBNAME || d.job || '')}: ${
      (d.sets || []).length
    } set${(d.sets || []).length === 1 ? '' : 's'}`,
  ];
  (d.sets || []).forEach((set: ResultSet, i: number) => {
    out.push('', `set ${i + 1}`);
    const rows = Object.entries(set)
      .filter(([k]) => !k.startsWith('_'))
      .map(([k, v]) => [k, valueText(v)]);
    out.push(...formatTable(rows, undefined, '  '));
  });
  return out;
}

/**
 * A result value as text: byte arrays as dashed hex, the rest as is.
 * @param v - the value
 * @returns the text
 */
export function valueText(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v))
    return v
      .map((b) =>
        (Number(b) & 0xff).toString(16).toUpperCase().padStart(2, '0')
      )
      .join('-');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** One row of a chassis config: a module the car may carry. */
interface ConfigEcu {
  code?: string;
  label?: string;
  sgbd: string;
  group?: string | null;
  variants?: string[];
}

/**
 * The module record for a chassis and SGBD, prepared the way the app's
 * showEcu prepares it: found in the chassis config (by SGBD or INPA code),
 * the shipped SGBDs noted for the wire-target rule, the diagnostic group
 * asked which variant the car carries, the SGBD retargeted to that variant
 * when a script ships for it, and the caption dictionary taken from the
 * variant's archive, else the configured base's. The chassis stem itself
 * names INPA's whole-vehicle script.
 * @param chassis - the chassis id
 * @param sgbd - the SGBD or INPA code, any case
 * @param api - the engine client
 * @returns the record and the script it runs
 */
export async function openModule(
  chassis: string,
  sgbd: string,
  api: ApiFn = runtimeGlobals().api as ApiFn
): Promise<{ ecu: EcuRecord; exec: IpoExec }> {
  const cid = chassis.toUpperCase();
  const want = sgbd.toLowerCase();
  let ecu: EcuRecord;
  if (want === cid.toLowerCase()) {
    ecu = {
      code: cid,
      sgbd: want,
      label: `INPA ${cid} script`,
      group: null,
      kind: 'vehicle',
      chassis: cid,
    };
  } else {
    let config: { sections?: { name?: string; ecus?: ConfigEcu[] }[] };
    try {
      config = (await api(`/api/chassis/${cid}`)) as typeof config;
    } catch (e) {
      throw new CliError(
        `no chassis ${cid} on the site (${(e as Error).message})`
      );
    }
    const rows: ConfigEcu[] = [];
    for (const s of config.sections || []) rows.push(...(s.ecus || []));
    const row =
      rows.find((r) => String(r.sgbd).toLowerCase() === want) ||
      rows.find((r) => String(r.code || '').toLowerCase() === want) ||
      rows.find((r) =>
        (r.variants || []).some((v) => String(v).toLowerCase() === want)
      );
    if (!row)
      throw new CliError(
        `${cid} carries no module ${sgbd} (try: ${rows
          .slice(0, 12)
          .map((r) => r.sgbd)
          .join(', ')}${rows.length > 12 ? ', ...' : ''})`
      );
    ecu = {
      code: row.code || '',
      label: row.label || row.sgbd,
      sgbd: String(row.sgbd).toLowerCase(),
      group: row.group || null,
      chassis: cid,
    };
  }
  return prepareModule(ecu, api);
}

/**
 * Prepare a module record the way showEcu does before the program opens
 * it, and load the script it runs. Shared by openModule and the home's
 * picks (a picked module is the car's own config row, prepared the same).
 * @param ecu - the record (mutated: known SGBDs, variant, dictionary)
 * @param api - the engine client
 * @returns the record and the script
 */
export async function prepareModule(
  ecu: EcuRecord,
  api: ApiFn = runtimeGlobals().api as ApiFn
): Promise<{ ecu: EcuRecord; exec: IpoExec }> {
  const R = loadRuntime();
  // the shipped SGBDs, for the wire-target rule (a script naming another
  // shipped module explicitly keeps that name)
  try {
    const idx = (await api('/api/ecu-index.json')) as Record<string, string>;
    ecu._ipoKnownSgbds = new Set(
      Object.keys(idx || {}).map((k) => k.toLowerCase())
    );
  } catch {
    ecu._ipoKnownSgbds = new Set();
  }
  await resolveGroupVariant(ecu, api, R);
  const codeHint = ecu.code ? `?code=${encodeURIComponent(ecu.code)}` : '';
  ecu._ir = await api(`/api/ecu/${ecu.sgbd}/ir${codeHint}`).catch(() => null);
  const menusOf = (ir: unknown): number =>
    Object.keys(((ir as { menus?: object }) || {}).menus || {}).length;
  if (!menusOf(ecu._ir) && ecu._sgbdBase && ecu._sgbdBase !== ecu.sgbd) {
    const base = await api(`/api/ecu/${ecu._sgbdBase}/ir${codeHint}`).catch(
      () => null
    );
    if (menusOf(base)) {
      ecu._ir = base;
      ecu._irFrom = ecu._sgbdBase;
    }
  }
  const script = String(ecu._irFrom || ecu.sgbd).toLowerCase();
  const exec = await R.irLiveExec(script);
  if (!exec || !exec.procs || !Object.keys(exec.procs).length)
    throw new CliError(
      `${script}: the site ships no runnable script for this module`
    );
  if (!(exec.procs.inpainit || exec.procs.SgbdInpaCheck))
    throw new CliError(
      `${script}: the script has no INPA entry point (inpainit)`
    );
  return { ecu, exec };
}

/**
 * Let the module's diagnostic-address group name the variant the car
 * carries (ecu.js irResolveGroupVariant): the answer is recorded as the
 * variant inpainit checks, and the SGBD is retargeted only when a script
 * actually ships for the variant.
 * @param ecu - the record, mutated
 * @param api - the engine client
 * @param R - the runtime
 */
async function resolveGroupVariant(
  ecu: EcuRecord,
  api: ApiFn,
  R: Runtime
): Promise<void> {
  const g = String(ecu.group || '').toLowerCase();
  ecu._variantSource = null;
  if (!g) {
    ecu._variantSource = 'ungrouped';
    return;
  }
  // the shipped group index, through the engine client: the shim hands a
  // non-/api/ path to the site fetch, and a test's fake car answers it
  let idx: { groups?: string[] } | null = null;
  try {
    idx = (await api('/data/groups/index.json')) as { groups?: string[] };
  } catch {
    idx = null;
  }
  if (!idx || !(idx.groups || []).includes(g)) {
    ecu._variantSource = 'nogroup';
    return;
  }
  let v: string | null = null;
  try {
    v = await R.webResolveVariant(g);
  } catch {
    v = null;
  }
  if (!v) {
    ecu._variantSource = 'unverified';
    return;
  }
  ecu._variant = v.toUpperCase();
  ecu._variantSource = 'confirmed';
  if (v === String(ecu.sgbd).toLowerCase()) return;
  try {
    const jobs = await api(`/api/ecu/${v}/jobs`);
    if (!Array.isArray(jobs) || !jobs.length) return;
  } catch {
    return;
  }
  ecu._sgbdBase = ecu._sgbdBase || ecu.sgbd;
  ecu.sgbd = v;
  ecu._variantSource = 'identified';
}

/**
 * The whole-vehicle scripts the site ships, by chassis.
 * @returns the chassis ids, upper-case
 */
export const SCAN_CHASSIS = [
  'E46',
  'E53',
  'E65',
  'E83',
  'E85',
  'E87',
  'E89',
  'E90',
  'R50',
  'R56',
];
