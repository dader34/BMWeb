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

// ../../probe/sleep2.ts
loadRuntime();
var g = runtimeGlobals();
console.log("bmwSleep in sandbox:", typeof g.bmwSleep);
console.log("timers.js in RUNTIME_FILES:", JSON.stringify(Object.keys(g).filter((k) => /sleep|Sleep/i.test(k))));
