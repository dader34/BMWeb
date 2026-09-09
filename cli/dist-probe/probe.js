// src/args.ts
var CliError = class extends Error {
};

// src/serial.ts
var RX_KICK_MS = 4;
var NodeSerialPort = class {
  path;
  opener;
  binding = null;
  /** chunks heard and not yet read */
  chunks = [];
  /** reads waiting for bytes, oldest first, when the queue is empty */
  waiters = [];
  /** the receive kick, running while a read waits (see startKick) */
  kick = null;
  /** a kick ioctl in flight, so they never pile up */
  kicking = false;
  /** the lines as last set, so a partial setSignals keeps the others */
  lines = { dtr: false, rts: false, brk: false };
  /** the wire trace sink, when the CLI wants one */
  info;
  /**
   * @param path - the device path
   * @param opener - how a binding is opened
   * @param info - vendor and product ids, when known (portLabel shows them)
   */
  constructor(path, opener, info = {}) {
    this.path = path;
    this.opener = opener;
    this.info = info;
  }
  /** Is a binding open (Web Serial's SerialPort.connected). */
  get connected() {
    return !!this.binding;
  }
  /**
   * Open the device with the given settings.
   * @param cfg - baud, bits, parity
   */
  async open(cfg) {
    if (this.binding) throw new Error(`${this.path} is already open`);
    const b = await this.opener(this.path, cfg);
    this.binding = b;
    this.chunks = [];
    b.onData((chunk) => this.push(chunk));
  }
  /**
   * Close the device: the binding goes, a waiting read is told `done`.
   */
  async close() {
    const b = this.binding;
    this.binding = null;
    this.stopKick();
    this.wakeAll();
    this.chunks = [];
    if (b) await b.close();
  }
  /** Tell every waiting read the port is done, and forget them. */
  wakeAll() {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w({ value: void 0, done: true });
  }
  /**
   * Bytes the binding heard: to the waiting read, else queued.
   * @param chunk - the bytes
   */
  push(chunk) {
    if (!chunk.length) return;
    const w = this.waiters.shift();
    if (w) {
      w({ value: chunk, done: false });
      return;
    }
    this.chunks.push(chunk);
  }
  /** The readable side: getReader() hands back the one reader. */
  get readable() {
    return {
      getReader: () => ({
        read: () => this.read(),
        cancel: async () => this.cancel(),
        releaseLock: () => {
        }
      })
    };
  }
  /** The writable side: getWriter() hands back the one writer. */
  get writable() {
    return {
      getWriter: () => ({
        write: (bytes) => this.write(bytes),
        releaseLock: () => {
        }
      })
    };
  }
  /**
   * One read: the next chunk, or `done` when the port is closed.
   * @returns the read result
   */
  read() {
    const next = this.chunks.shift();
    if (next) return Promise.resolve({ value: next, done: false });
    if (!this.binding) return Promise.resolve({ value: void 0, done: true });
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.startKick();
    });
  }
  /**
   * Make the driver deliver what it has heard.
   *
   * THE BUG THIS FIXES. On macOS the built-in FTDI driver does not wake the
   * reader when bytes arrive: with a read armed and the process simply
   * waiting, an ECU's answer sat in the driver until some OTHER call touched
   * the device (the next write, a modem-line change, close), and only then
   * came out -- measured on a real car as 0 bytes for the first exchange
   * after open and every later exchange delivering the PREVIOUS one's bytes
   * at its start. Polling the modem lines (a TIOCMGET, no wire traffic)
   * every few milliseconds while a read waits makes each answer arrive
   * within the poll interval, first exchange included. The interval never
   * holds the process open and stops itself once no read is waiting.
   */
  startKick() {
    if (this.kick) return;
    const tick = () => {
      const b = this.binding;
      if (!b || !this.waiters.length) {
        this.stopKick();
        return;
      }
      if (this.kicking) return;
      this.kicking = true;
      b.get().catch(() => null).then(() => {
        this.kicking = false;
      });
    };
    this.kick = setInterval(tick, RX_KICK_MS);
    if (typeof this.kick === "object" && "unref" in this.kick) this.kick.unref();
  }
  /** Stop the receive kick. */
  stopKick() {
    if (!this.kick) return;
    clearInterval(this.kick);
    this.kick = null;
  }
  /**
   * Cancel the reader: a waiting read is told `done`, buffered bytes go.
   */
  cancel() {
    this.chunks = [];
    this.wakeAll();
  }
  /**
   * Write bytes. Resolves when the OS has them, not when they have left the
   * wire: the bus then holds DTR for the telegram's own byte time, and
   * waiting for transmission here would double that hold and lose the
   * ECU's answer (the reference interface's DtrTimeCorrCom is 0.3 ms).
   * @param bytes - the framed request
   */
  async write(bytes) {
    if (!this.binding) throw new Error(`${this.path} is not open`);
    await this.binding.write(bytes);
  }
  /**
   * Drive the modem lines. A partial call keeps the lines it does not name,
   * as Web Serial does; the binding always gets all three, because
   * `serialport` would otherwise assert the ones left unsaid.
   * @param s - the lines to set
   */
  async setSignals(s) {
    if (!this.binding) throw new Error(`${this.path} is not open`);
    if (s.dataTerminalReady !== void 0)
      this.lines.dtr = !!s.dataTerminalReady;
    if (s.requestToSend !== void 0) this.lines.rts = !!s.requestToSend;
    if (s.break !== void 0) this.lines.brk = !!s.break;
    await this.binding.set({ ...this.lines });
  }
  /**
   * Read the modem lines (KL15 arrives on DSR or DCD of a K+DCAN cable).
   * @returns the lines, or null when the binding cannot say
   */
  async getSignals() {
    if (!this.binding) return null;
    const st = await this.binding.get();
    if (!st) return null;
    return {
      dataSetReady: !!st.dsr,
      dataCarrierDetect: !!st.dcd,
      clearToSend: !!st.cts
    };
  }
  /**
   * The USB ids, for the bus's port label.
   * @returns what is known
   */
  getInfo() {
    return this.info;
  }
  /** Web Serial's disconnect event; a pulled USB cable is not watched here. */
  addEventListener() {
  }
};
var serialportModule = null;
async function loadSerialport() {
  if (serialportModule) return serialportModule;
  try {
    serialportModule = await import("serialport");
  } catch {
    throw new CliError(
      "the serialport package is not installed; run: npm i -g serialport (or reinstall bmweb-cli with its optional dependencies)"
    );
  }
  return serialportModule;
}
async function openSerialportBinding(path, cfg) {
  const mod = await loadSerialport();
  const port2 = new mod.SerialPort({
    path,
    baudRate: cfg.baudRate,
    dataBits: cfg.dataBits,
    stopBits: cfg.stopBits,
    parity: cfg.parity,
    autoOpen: false,
    // keep the lines where we leave them across close/open
    hupcl: false
  });
  await new Promise(
    (res, rej) => port2.open(
      (e) => e ? rej(new CliError(`cannot open ${path}: ${e.message}`)) : res()
    )
  );
  const call = (fn) => new Promise((res, rej) => fn((e) => e ? rej(e) : res()));
  const binding = {
    write: (bytes) => call((cb) => port2.write(Buffer.from(bytes), cb)),
    onData: (fn) => port2.on("data", (b) => fn(new Uint8Array(b))),
    set: (s) => call(
      (cb) => port2.set(
        {
          dtr: s.dtr,
          rts: s.rts,
          brk: s.brk,
          cts: false,
          dsr: false,
          ...process.platform === "linux" ? { lowLatency: true } : {}
        },
        cb
      )
    ),
    get: () => new Promise((res) => port2.get((e, st) => res(e || !st ? null : st))),
    close: () => new Promise((res) => port2.close(() => res()))
  };
  await binding.set({ dtr: false, rts: false, brk: false });
  return binding;
}

// src/runtime.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { join as join3 } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

// src/runtime-files.json
var runtime_files_default = [
  "vendor/fflate.min.js",
  "core/webshim/timers.js",
  "core/webshim/trace.js",
  "core/webshim/framing.js",
  "core/webshim/exchange.js",
  "core/webshim/transport-base.js",
  "core/webshim/native-bus.js",
  "core/webshim/web-serial-bus.js",
  "core/webshim/bus.js",
  "core/webshim/data-fetch.js",
  "core/webshim/job-runner.js",
  "core/webshim/variant-resolver.js",
  "core/webshim/coding.js",
  "core/webshim/api-router.js",
  "core/webshim/install.js",
  "core/bestvm/write-guard.js",
  "core/bestvm/codec.js",
  "core/bestvm/machine.js",
  "core/bestvm/registers.js",
  "core/bestvm/operands.js",
  "core/bestvm/environment.js",
  "core/bestvm/executor.js",
  "core/bestvm/index.js",
  "core/ipovm/values.js",
  "core/ipovm/operators.js",
  "core/ipovm/hosts.js",
  "core/ipovm/emissions.js",
  "core/ipovm/tape.js",
  "core/ipovm/builtin-helpers.js",
  "core/ipovm/builtins-screen.js",
  "core/ipovm/builtins-api.js",
  "core/ipovm/builtins-text.js",
  "core/ipovm/builtins-table.js",
  "core/ipovm/structures.js",
  "core/ipovm/suspensions.js",
  "core/ipovm/vm.js",
  "core/ipofile/pool.js",
  "core/ipofile/decls.js",
  "core/ipofile/walk.js",
  "core/ipofile/exec.js",
  "core/ipofile/lex.js",
  "core/ipofile/parse.js",
  "core/ipofile/emit.js",
  "core/ipofile/compile.js",
  "core/translate.js",
  "screens/ir.js",
  "screens/ipo-runtime/script-scan.js",
  "screens/ipo-runtime/translate-sets.js",
  "screens/ipo-runtime/wire-policy.js",
  "screens/ipo-runtime/program.js",
  "screens/ipo-runtime/cells.js",
  "screens/ipo-runtime/paint-modern.js",
  "screens/ipo-runtime/paint-grid.js",
  "screens/ipo-runtime/dialogs.js",
  "screens/ipo-runtime/print.js",
  "screens/ipo-runtime/protocol.js",
  "screens/ipo-runtime/ui.js",
  "screens/ipo-runtime/open.js",
  "screens/ipo-runtime/home.js",
  "home/bmweb-home.ips",
  "home/bmweb.h",
  "screens/activations.js",
  "screens/garage/store.js",
  "screens/garage/diff.js",
  "screens/garage/share.js",
  "screens/search/data.js",
  "screens/search/match.js",
  "screens/search/open.js"
];

// src/site.ts
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join as join2 } from "node:path";

// src/cache.ts
import { homedir } from "node:os";
import { join } from "node:path";
var CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
function cacheDir(env = process.env) {
  const base = env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.trim() ? env.XDG_CACHE_HOME : join(homedir(), ".cache");
  return join(base, "bmweb-cli");
}

// src/site.ts
var DEFAULT_API = "https://bmweb.danner.ink/";
var config = {
  base: DEFAULT_API,
  refresh: false,
  env: process.env,
  fetchImpl: (...a) => fetch(...a)
};
function configureSite(opts) {
  if (opts.base !== void 0) config.base = normalizeBase(opts.base);
  if (opts.refresh !== void 0) config.refresh = opts.refresh;
  if (opts.env !== void 0) config.env = opts.env;
  if (opts.fetchImpl !== void 0) config.fetchImpl = opts.fetchImpl;
}
function normalizeBase(base) {
  const s = String(base || "").trim();
  return s.endsWith("/") ? s : `${s}/`;
}
function sitePath(input) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return null;
  return url.replace(/^\/+/, "");
}
function siteCachePath(rel, env = config.env) {
  const clean = rel.split("?")[0];
  return join2(cacheDir(env), "site", ...clean.split("/"));
}
async function siteGet(rel) {
  const file = siteCachePath(rel);
  const have = existsSync(file);
  const fresh = have && Date.now() - statSync(file).mtimeMs < CACHE_MAX_AGE_MS;
  if (have && fresh && !config.refresh)
    return { status: 200, bytes: readFileSync(file), fromCache: true };
  let status = 0;
  let bytes = null;
  try {
    const r = await config.fetchImpl(`${config.base}${rel}`);
    status = r.status;
    if (r.ok) bytes = new Uint8Array(await r.arrayBuffer());
  } catch {
    status = 0;
  }
  if (bytes) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    return { status: 200, bytes, fromCache: false };
  }
  if (have && status !== 404)
    return { status: 200, bytes: readFileSync(file), fromCache: true };
  return { status: status || 503, bytes: null, fromCache: false };
}
async function siteFetch(input, init) {
  const rel = sitePath(input);
  if (rel === null) return config.fetchImpl(input, init);
  const r = await siteGet(rel);
  if (!r.bytes)
    return new Response(JSON.stringify({ error: `${rel}: HTTP ${r.status}` }), {
      status: r.status,
      statusText: r.status === 404 ? "Not Found" : "Unavailable"
    });
  return new Response(r.bytes, { status: 200 });
}

// src/runtime.ts
var RUNTIME_DIR = fileURLToPath(
  new URL("../runtime/", import.meta.url)
);
var loaded = null;
var sandboxRef = null;
var apiImpl = null;
function runtimeGlobals() {
  loadRuntime();
  return sandboxRef;
}
function hostGlobals() {
  const noop = () => {
  };
  const sandbox = {
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
    navigator: { serial: void 0 },
    // activations.js registers a pagehide hook at load; the bus announces
    // cable events; neither has a page here
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: noop,
    // ui.js writes the key caption into the document's style at render
    // time and the harness stubs getElementById; neither draws anything
    document: {
      getElementById: () => null,
      documentElement: { style: { setProperty: noop, removeProperty: noop } }
    },
    // the status bar the runtime writes to
    sbLeft: { textContent: "" },
    sbRight: { textContent: "" },
    // HTML escaping, identity here: no DOM receives the text
    esc: (s) => String(s == null ? "" : s),
    // the F-key bar; the CLI's own UI adapter renders keys itself
    setActions: noop,
    // translate.js and translate-sets.js gate on the language setting
    lang: () => "en",
    // the fault dictionaries the fed results are translated through: the
    // large generated ones are not in this package, so results stay as the
    // module sent them (the app behaves the same in a build without them)
    BMW_ENV_TEXT: {},
    BMW_FAULT_PHRASES: {},
    BMW_FAULT_DB: {},
    scopedFaultDb: () => null,
    // a chassis id's display name (core/core/ui.js); the id is fine here
    dispChassis: (id) => String(id || ""),
    // store.js persists through Settings and wire-policy.js reads the
    // confirmActuators preference; the CLI stores nothing and confirms
    // every actuator drive, so a read-only stand-in returning the default
    // is exact
    Settings: {
      get: (_k, d) => d,
      set: noop
    },
    // open.js's searchOpenHit assigns location.hash; api-router.js derives
    // WEB_BASE from the pathname (empty: paths hang off the site root)
    location: { hash: "", href: "", pathname: "/", search: "" },
    // the engine client (core/core/api.js): a route in, its JSON out, the
    // server's `error` field as the thrown message. Routed through apiImpl
    // so a test can put a fake car behind the very same call.
    api: async (path, opts) => {
      if (apiImpl) return apiImpl(path, opts);
      const f = sandbox.fetch;
      const res = await f(path, opts);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || res.statusText);
      }
      return res.json();
    },
    // the result-set projection (core/core/api.js): the engine's synthetic
    // system set dropped when it leads
    dataSets: (sets) => {
      const list = sets || [];
      const s = list[0];
      const system = !!s && typeof s === "object" && ("SAETZE" in s || "JOBNAME" in s || "OBJECT" in s);
      return list.length && system ? list.slice(1) : list;
    }
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  return sandbox;
}
function loadRuntime() {
  if (loaded) return loaded;
  const sandbox = hostGlobals();
  const collected = {};
  sandbox.module = {
    get exports() {
      return collected;
    },
    set exports(v) {
      Object.assign(collected, v);
    }
  };
  const context = createContext(sandbox);
  for (const rel of runtime_files_default) {
    if (!rel.endsWith(".js")) continue;
    const file = join3(RUNTIME_DIR, rel);
    let code;
    try {
      code = readFileSync2(file, "utf8");
    } catch {
      throw new Error(
        `runtime file missing: ${rel} (the package was built without scripts/sync-runtime.mjs)`
      );
    }
    runInContext(code, context, { filename: rel });
  }
  for (const name of LIFTED_GLOBALS) {
    collected[name] = runInContext(
      `typeof ${name} === 'undefined' ? undefined : ${name}`,
      context
    );
  }
  sandboxRef = sandbox;
  loaded = collected;
  return loaded;
}
var LIFTED_GLOBALS = [
  "IPO_IDENT_ROWS",
  "IPO_TICK_MS",
  "webBus",
  "withBusLock",
  "webResolveVariant",
  "webResolveVariantLast",
  "isWriteJob",
  "ipoProtocolReport",
  // home.js's host object: the status builtin reads it by name, so the
  // CLI hangs its own status on it rather than on the VM
  "IPO_HOME_HOST"
];

// ../../probe/probe.ts
var PATH = process.argv[2] || "/dev/cu.usbserial-AH01BRM5";
var SGBD = process.argv[3] || "ms450ds0";
var JOB = process.argv[4] || "IDENT";
var tracing = async (path, cfg) => {
  console.log(`OPEN  ${path} ${cfg.baudRate} ${cfg.dataBits}${cfg.parity[0].toUpperCase()}${cfg.stopBits} dtr=${cfg.dtr}`);
  const b = await openSerialportBinding(path, cfg);
  return {
    write: async (bytes) => {
      console.log("TX   ", [...bytes].map((x) => x.toString(16).padStart(2, "0")).join(" "));
      return b.write(bytes);
    },
    onData: (fn) => b.onData((chunk) => {
      console.log("RX   ", [...chunk].map((x) => x.toString(16).padStart(2, "0")).join(" "));
      fn(chunk);
    }),
    set: async (s) => {
      console.log(`LINES dtr=${s.dtr ? 1 : 0} rts=${s.rts ? 1 : 0} brk=${s.brk ? 1 : 0}`);
      return b.set(s);
    },
    get: () => b.get(),
    close: async () => {
      console.log("CLOSE");
      return b.close();
    }
  };
};
configureSite({});
var R = loadRuntime();
{
  const bus2 = R.webBus;
  const orig = bus2.readSome;
  bus2.readSome = async function(deadline) {
    const left = deadline - Date.now();
    const t0 = Date.now();
    const r = await orig.call(this, deadline);
    console.log(`    (waited ${Date.now() - t0}ms of ${left}ms)`);
    const v = r && r.value;
    console.log(
      `  readSome(budget=${left}ms) ->`,
      v && v.length ? [...v].map((x) => x.toString(16).padStart(2, "0")).join(" ") : r.done ? "DONE" : "timeout"
    );
    return r;
  };
}
var bus = R.webBus;
if (bus && typeof bus.exchange === "function") {
  const orig = bus.exchange.bind(bus);
  bus.exchange = async (...a) => {
    const comm = a[1];
    console.log(
      "EXCHANGE concept=0x" + (comm && comm.concept ? comm.concept.toString(16) : "?"),
      "answerLen=" + JSON.stringify(comm && comm.answerLen),
      "baud=" + (comm && comm.baud)
    );
    try {
      const r = await orig(...a);
      console.log("ANSWER  ", r.map((x) => x.toString(16).padStart(2, "0")).join(" "));
      return r;
    } catch (e) {
      console.log("EXCHANGE FAILED:", e.message);
      throw e;
    }
  };
}
var g = runtimeGlobals();
var port = new NodeSerialPort(PATH, tracing);
g.navigator.serial = { requestPort: async () => port, getPorts: async () => [] };
console.log("label:", await R.webBus.connect());
var api = runtimeGlobals().api;
try {
  const res = await api(`/api/ecu/${SGBD}/run/${JOB}`, { method: "POST" });
  console.log("RESULT", JSON.stringify(res).slice(0, 800));
} catch (e) {
  console.log("ERROR", e.message);
}
await R.webBus.disconnect();
process.stdout.write("", () => process.exit(0));
