/**
 * @file The fetch shim: installs over window.fetch so core.js's api() needs
 * no change at all, answering /api/* locally -- static routes from the
 * cached .chassis archives, job runs through the VM -- and routing every
 * genuine file read through the offline folder when one is picked.
 */
/* exported WEB_API_BASE, WEB_BASE, installWebShim */

/** The static API directory the exporter writes (tools/web_export.py). */
const WEB_API_BASE = 'api';

/**
 * WHERE THIS PAGE LIVES. A project site served from a subpath (/BMacW/), not
 * the domain root, would resolve "/api/chassis" to the host's root -- off the
 * site entirely. Derive the base from the document's own URL and hang every
 * static path off it. Empty at a domain root and inside the macOS app, so
 * both behave exactly as before.
 */
const WEB_BASE = (
  typeof location !== 'undefined'
    ? location.pathname.replace(/\/[^/]*$/, '')
    : ''
).replace(/\/$/, '');

/**
 * One unpacked .chassis archive.
 * @typedef {object} ChassisData
 * @property {any} config - Its config.json.
 * @property {Map<string, Uint8Array>} ecuZips - sgbd (lowercased) -> .ecu bytes.
 */

/**
 * Cache of chassis configs and their ECU zip buffers, keyed by chassis id.
 * @type {Map<string, ChassisData>}
 */
const CHASSIS_CACHE = new Map();

/**
 * Cache of parsed ECU files: sgbd (lowercased) -> Map(filename -> content).
 * @type {Map<string, Map<string, any>>}
 */
const ECU_CACHE = new Map();

/**
 * A fetch that reaches the FILE rather than the shim's answer.
 * @callback RealFetch
 * @param {RequestInfo|string} input - The URL.
 * @param {RequestInit} [init] - Fetch options.
 * @returns {Promise<Response>}
 */

/**
 * The offline export's inlined data (data/inline.js), when this page is one.
 * A file:// page gets an opaque origin where fetch() is blocked, so the
 * exporter inlines each archive as base64 in a <script> instead -- which
 * file:// loads happily.
 * @returns {Record<string, any>|null} The BMACW_INLINE map, or null.
 */
function inlineData() {
  return typeof BMACW_INLINE === 'object' && BMACW_INLINE ? BMACW_INLINE : null;
}

/**
 * Load and unpack a chassis archive, from the inlined data when it is there
 * and only reaching for the network otherwise.
 * @param {string} chassisId - The chassis id (any case).
 * @param {RealFetch} realFetch - The unshimmed fetch.
 * @returns {Promise<ChassisData>}
 * @throws {Error} When the archive cannot be fetched.
 */
async function loadChassis(chassisId, realFetch) {
  const upperId = chassisId.toUpperCase();
  if (CHASSIS_CACHE.has(upperId)) return CHASSIS_CACHE.get(upperId);

  const inline = inlineData();
  if (inline && inline[upperId]) {
    const bin = atob(inline[upperId]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return cacheChassis(upperId, bytes);
  }

  const fileUrl = `${WEB_BASE}/api/chassis/${upperId}.chassis`;
  const res = await realFetch(fileUrl);
  if (!res.ok)
    throw new Error(`Failed to load chassis ${upperId}: ${res.statusText}`);

  const buffer = await res.arrayBuffer();
  return cacheChassis(upperId, new Uint8Array(buffer));
}

/**
 * Unpack one .chassis and remember it. Shared by the inline and network
 * paths, which differ only in where the bytes came from.
 * @param {string} upperId - The chassis id, upper-cased.
 * @param {Uint8Array} bytes - The zip archive.
 * @returns {ChassisData}
 * @throws {Error} Without fflate, or when config.json is missing.
 */
function cacheChassis(upperId, bytes) {
  if (typeof fflate === 'undefined') {
    throw new Error('fflate decompression library not loaded');
  }
  const unzipped = fflate.unzipSync(bytes);

  const configBytes = unzipped['config.json'];
  if (!configBytes)
    throw new Error(`Missing config.json in chassis ${upperId}`);
  const config = JSON.parse(new TextDecoder('utf-8').decode(configBytes));

  const ecuZips = new Map();
  for (const [name, b] of Object.entries(unzipped)) {
    if (name.startsWith('ecu/') && name.endsWith('.ecu')) {
      ecuZips.set(name.slice(4, -4).toLowerCase(), b);
    }
  }

  const data = { config, ecuZips };
  CHASSIS_CACHE.set(upperId, data);
  return data;
}

/**
 * The sgbd -> chassis owner index, inlined or fetched.
 * @param {RealFetch} realFetch - The unshimmed fetch.
 * @returns {Promise<Record<string, string>|null>}
 */
async function loadEcuIndex(realFetch) {
  const inline = inlineData();
  if (inline && inline._index) return inline._index;
  return (await realFetch(`${WEB_BASE}/${WEB_API_BASE}/ecu-index.json`))
    .json()
    .catch(() => null);
}

/**
 * Load one ECU's files from its chassis archive (fetching the chassis that
 * owns it when none open has it), parsed as JSON where they are JSON.
 * @param {string} sgbd - The SGBD name (any case).
 * @param {RealFetch} realFetch - The unshimmed fetch.
 * @returns {Promise<Map<string, any>>} filename -> parsed JSON or text.
 * @throws {Error} When no archive holds the SGBD, or fflate is absent.
 */
async function loadEcu(sgbd, realFetch) {
  const lowerSgbd = sgbd.toLowerCase();
  if (ECU_CACHE.has(lowerSgbd)) return ECU_CACHE.get(lowerSgbd);

  // Search cached chassis first
  let ecuZipBytes = null;
  for (const chassisData of CHASSIS_CACHE.values()) {
    if (chassisData.ecuZips.has(lowerSgbd)) {
      ecuZipBytes = chassisData.ecuZips.get(lowerSgbd);
      break;
    }
  }

  // Not in a chassis we have open yet. ECUs ship only inside their chassis
  // archive -- loose copies duplicated all 310 for 47 MB and nothing read
  // them -- so find the car that owns this SGBD and load that. Costs one
  // chassis download, after which every ECU in the same car is already here.
  if (!ecuZipBytes) {
    const idx = await loadEcuIndex(realFetch);
    const cid = idx && idx[lowerSgbd];
    if (cid) {
      const data = await loadChassis(cid, realFetch);
      ecuZipBytes = data.ecuZips.get(lowerSgbd) || null;
    }
  }

  if (!ecuZipBytes) {
    throw new Error(`ECU archive not found for ${lowerSgbd}`);
  }

  if (typeof fflate === 'undefined') {
    throw new Error('fflate decompression library not loaded');
  }
  const unzipped = fflate.unzipSync(ecuZipBytes);
  const ecuFiles = new Map();
  const decoder = new TextDecoder('utf-8');

  for (const [name, bytes] of Object.entries(unzipped)) {
    try {
      const text = decoder.decode(bytes);
      const parsed = JSON.parse(text);
      ecuFiles.set(name, parsed);
    } catch (e) {
      ecuFiles.set(name, decoder.decode(bytes));
    }
  }

  ECU_CACHE.set(lowerSgbd, ecuFiles);
  return ecuFiles;
}

/**
 * A 200 JSON Response.
 * @param {any} body - Serialised as JSON.
 * @returns {Response}
 */
function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * An error Response with a {error} JSON body.
 * @param {string} msg - The error text.
 * @param {number} [status] - HTTP status (503 by default).
 * @returns {Response}
 */
function errorResponse(msg, status = 503) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * The SGBD a data/<kind>/<sgbd>.json path names, lowercased.
 * @param {string} rel - The site-relative path (query allowed).
 * @returns {string}
 */
function sgbdOfDataPath(rel) {
  return rel
    .split('?')[0]
    .split('/')
    .pop()
    .replace(/\.json$/, '')
    .toLowerCase();
}

/**
 * Build the fetch every genuine file read funnels through. OFFLINE FOLDER
 * (file:// double-click): the shim passes non-/api/ paths straight here, and
 * chassis.json, ecu-index.json and the .chassis/.ecu archives load through
 * it too. So routing THIS one function through the picked directory handle
 * covers all data -- chassis, ECU, groups, coding-dispatch, sgbd-tables,
 * job-code, ISTA -- with no other change. offlineFsActive() is false on
 * http(s) and in the native app, where this is exactly nativeFetch.
 * @param {RealFetch} nativeFetch - The browser's own fetch, bound to window.
 * @returns {RealFetch}
 */
function offlineAwareFetch(nativeFetch) {
  return async (input, init) => {
    if (
      typeof offlineFsActive === 'function' &&
      offlineFsActive() &&
      typeof offlineFsReady === 'function' &&
      offlineFsReady()
    ) {
      const url =
        typeof input === 'string' ? input : (input && input.url) || '';
      // ONLY same-origin paths belong to the folder. A genuine remote URL (the
      // ETK/faults HF fallback) must still go to the network -- rerouting it to
      // a folder read would 404 a file that was meant to come from the internet.
      // An http(s):// URL to another host is remote; a file:// URL or a bare
      // relative path is ours.
      const isRemote = /^https?:\/\//i.test(url);
      if (!isRemote) {
        let rel = url.replace(/^file:\/\/[^/]*/, '');
        if (WEB_BASE && rel.startsWith(WEB_BASE))
          rel = rel.slice(WEB_BASE.length);
        rel = rel.replace(/^\/+/, '');
        if (rel) return offlineReadFile(rel);
      }
    }
    return nativeFetch(input, init);
  };
}

/**
 * A fetched URL as a site-relative path: origin and WEB_BASE stripped, with
 * a leading slash.
 * @param {RequestInfo|string} input - What fetch was given.
 * @returns {string}
 */
function siteRelativePath(input) {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  let rel = url.replace(/^https?:\/\/[^/]+/, '');
  if (WEB_BASE && rel.startsWith(WEB_BASE)) {
    rel = rel.slice(WEB_BASE.length);
  }
  if (!rel.startsWith('/')) rel = '/' + rel;
  return rel;
}

/**
 * Serve one file out of an ECU's archive (the VM bytecode / sgbd-tables
 * interception for data/job-code/* and data/sgbd-tables/*).
 * @param {string} rel - The requested path.
 * @param {RealFetch} real - The unshimmed fetch.
 * @param {string} file - The archive member, e.g. 'job-code.json'.
 * @param {string} what - The label for the 404 ('Job code', 'SGBD tables').
 * @returns {Promise<Response>}
 */
async function serveEcuMember(rel, real, file, what) {
  const sgbd = sgbdOfDataPath(rel);
  try {
    const ecu = await loadEcu(sgbd, real);
    const body = ecu.get(file);
    if (!body) return errorResponse(`${what} not found for ${sgbd}`, 404);
    return jsonResponse(body);
  } catch (e) {
    return errorResponse(e.message, 404);
  }
}

/**
 * /api/state: the cable's modem lines carry KL15; ask the bus that owns them.
 * @returns {Promise<Response>}
 */
async function routeState() {
  if (webBus.connected && webBus.readState) {
    try {
      const st = await webBus.readState();
      return jsonResponse({
        battery: st.battery,
        ignition: st.ignition,
        connected: true,
        derived: !!st.derived,
        detail: st.sensed
          ? 'ignition (KL15) read from the cable’s DSR line, as INPA does'
          : st.derived
            ? 'nominal: this cable does not report its KL15 line'
            : null,
      });
    } catch {
      /* adapter went away; report disconnected below */
    }
  }
  return jsonResponse({
    battery: null,
    ignition: null,
    connected: webBus.connected,
    detail: webBus.connected ? null : 'no cable connected',
  });
}

/** a group SGBD's name: D_ + the diagnostic address or a family (D_MOTOR) */
const GROUP_SGBD_RE = /^d_[a-z0-9_]+$/i;

/**
 * /api/ecu/<sgbd>/run/<job>?arg=...: run the job in the VM over the bus.
 *
 * EDIABAS answers every job with a SYNTHETIC result set 0 the runtime
 * itself fills: OBJECT (the loaded SGBD), VARIANTE (its variant name),
 * JOBNAME and SAETZE. It never comes from the wire and no job declares
 * it -- inpainit's variant check reads VARIANTE from set 0 to ask "which
 * ECU file is loaded?", and without it the check compared against '' and
 * stopped every module whose .ipo gates on it. bestvm returns data sets
 * only (its set 0 is the engine's set 1), so carry the system record beside
 * them rather than renumbering every consumer.
 * @param {string} rel - The requested path with its query.
 * @param {string} sgbd - The SGBD from the path.
 * @param {string} jobRaw - The job name from the path, still URL-encoded.
 * @returns {Promise<Response>}
 */
async function routeRun(rel, sgbd, jobRaw) {
  const q = new URLSearchParams(rel.split('?')[1] || '');
  const arg = q.get('arg');
  const job = decodeURIComponent(jobRaw);
  // OBJECT is what the caller loaded, VARIANTE what answered: for a group
  // SGBD (D_0044) the two differ, exactly as EDIABAS reports them
  const systemSet = (sets, variant) => ({
    OBJECT: sgbd.toLowerCase(),
    VARIANTE: String(variant || sgbd).toUpperCase(),
    JOBNAME: job.toUpperCase(),
    SAETZE: (sets || []).length,
  });
  if (!webBus.connected) return errorResponse('no cable connected', 503);
  try {
    // One SGBD is "loaded" at a time, like the engine: moving to a
    // different ECU ends the previous session (ENDE) before the new
    // one initialises.
    // A group SGBD is how INPA's whole-vehicle scripts address a module:
    // EDIABAS runs the group's IDENTIFIKATION on the wire, loads the variant
    // it names and hands the job to that. Same here (the variant is what
    // gets loaded, so a run of jobs on one module keeps its session), and
    // a silent address is a job error the script reports as such.
    let variant = null;
    if (GROUP_SGBD_RE.test(sgbd)) {
      variant = await webResolveVariant(sgbd);
      if (!variant) {
        apiTrace.add({ sgbd, job, arg, error: 'no module answered' });
        return errorResponse(`${sgbd}: no module answered on the wire`);
      }
    }
    await switchSession(variant || sgbd);
    const r = await webRunJob(variant || sgbd, job, arg);
    apiTrace.add({
      sgbd,
      job,
      arg,
      sets: r.sets,
      status: (r.sets[0] && r.sets[0].JOB_STATUS) || '',
    });
    return jsonResponse({
      job: jobRaw,
      sets: r.sets,
      system: systemSet(r.sets, variant),
    });
  } catch (e) {
    apiTrace.add({ sgbd, job, arg, error: e.message });
    // A WIRE error (IFH-*) that reaches the user is where the telegram
    // trace is worth seeing -- auto-dump the recent ring buffer so the
    // failing exchange is on the console with no busTrace.start() needed.
    if (e && e.ifh) busTrace.dumpRecent(`${e.ifh} on ${sgbd}/${jobRaw}`);
    return errorResponse(e.message);
  }
}

/**
 * The per-ECU static kinds served straight from the archive.
 * 'ipoexec' is the runnable execution-derived twin ({procs,byid}) the live
 * .IPO interpreter (ipovm.js) executes, shipped beside ir.json. An ECU
 * without one (an orphan, or a pre-phase-1 archive) 404s and the renderer
 * falls back to the frozen IR -- so it is optional, not fatal.
 */
const ECU_FILE_KINDS = new Set(['jobs', 'ir', 'tables', 'ipoexec']);
/** The per-ECU kinds that take a sub-name: results/<JOB>, arguments/<JOB>, table/<NAME>. */
const ECU_SUB_KINDS = new Set(['results', 'arguments', 'table']);

/**
 * /api/ecu/<sgbd>/<kind>[/<name>]: one file from the ECU's archive.
 * @param {string} sgbd - The SGBD (lowercased).
 * @param {string[]} m - The path segments after /api/.
 * @param {RealFetch} real - The unshimmed fetch.
 * @returns {Promise<Response|null>} null when the kind is unknown.
 */
async function routeEcuFile(sgbd, m, real) {
  const kind = m[2];
  try {
    const ecu = await loadEcu(sgbd, real);
    // the variant's own config record (label, section, group): the sweep
    // names an identified variant by it when the menu lists no such row
    if (kind === 'ecu') {
      const info = ecu.get('ecu.json');
      return info
        ? jsonResponse(info)
        : errorResponse(`No record for ${sgbd}`, 404);
    }
    if (ECU_FILE_KINDS.has(kind)) {
      const res = ecu.get(`${kind}.json`);
      if (!res) {
        if (kind === 'jobs') return jsonResponse([]);
        return errorResponse(`${kind} not found for ${sgbd}`, 404);
      }
      return jsonResponse(res);
    }
    if (ECU_SUB_KINDS.has(kind) && m[3]) {
      const subName = decodeURIComponent(m[3]).toUpperCase();
      const res = ecu.get(`${kind}/${subName}.json`);
      if (!res)
        return errorResponse(`${kind}/${subName} not found for ${sgbd}`, 404);
      return jsonResponse(res);
    }
  } catch (e) {
    // loadEcu THREW -- the archive is missing or failed to load, which
    // is not the same as a healthy archive with no jobs.json. Answering
    // ok([]) here made a broken export indistinguishable from an ECU
    // that genuinely has no jobs.
    return errorResponse(e.message, 404);
  }
  return null;
}

/**
 * Everything under /api/ that is a static file route, served from the zip
 * archives.
 *
 * SPLIT THE PATH, NOT THE QUERY. ecu.js asks for "/api/ecu/msv80/ir?code=
 * MSV80" so the server can match a layout by INPA code, and splitting the
 * whole string leaves the last segment as "ir?code=MSV80", which matches
 * no kind. Every ECU then fell through to "no screen definition" while its
 * archive sat there holding 161 screens.
 * @param {string} rel - The requested path.
 * @param {RealFetch} real - The unshimmed fetch.
 * @param {RequestInit|undefined} init - The caller's fetch options.
 * @returns {Promise<Response>}
 */
async function routeStatic(rel, real, init) {
  const m = rel
    .split('?')[0]
    .replace(/^\/api\//, '')
    .split('/')
    .filter(Boolean);
  if (!m.length) return errorResponse('not found', 404);

  if (m[0] === 'chassis') {
    if (m.length === 1) {
      // The LIST, not the directory. Passing the bare /api/chassis through
      // asks the host for a path that is now a directory of .chassis
      // archives, and a static server answers with an index page -- 200,
      // text/html, and the renderer parses it as the chassis list. Name the
      // file explicitly.
      const inline = inlineData();
      if (inline) {
        return jsonResponse(Object.keys(inline).filter((k) => k !== '_index'));
      }
      return real(`${WEB_BASE}/${WEB_API_BASE}/chassis.json`, init);
    }
    const cid = m[1];
    try {
      const data = await loadChassis(cid, real);
      return jsonResponse(data.config);
    } catch (e) {
      return errorResponse(e.message, 404);
    }
  }

  // THE OWNER INDEX IS A STATIC FILE, NOT A ROUTE. Every /api/* path that
  // matches nothing below falls to the catch-all error at the end, which
  // answers a 404 whose BODY is {"error": ...} -- one key. loadEcu reads
  // that as the index, finds no owner for the SGBD, and every job on a
  // variant the page has not already cached fails with "archive not found".
  //
  // On a real E46 that meant the climate unit identified as ihka46_3 and
  // then reported a CLEAN FAULT MEMORY, on a module holding two present
  // faults. Serve the file.
  if (m[0] === 'ecu-index.json') {
    const inline = inlineData();
    if (inline && inline._index) return jsonResponse(inline._index);
    return real(`${WEB_BASE}/${WEB_API_BASE}/ecu-index.json`, init);
  }

  if (m[0] === 'ecu' && m.length >= 3) {
    const served = await routeEcuFile(m[1].toLowerCase(), m, real);
    if (served) return served;
  }

  return errorResponse(`no static route for ${rel}`, 404);
}

/**
 * Install over window.fetch so core.js's api() needs no change at all.
 * Also publishes window.webRealFetch: anything that needs the FILE rather
 * than the shim's answer (the offline exporter zips the archives
 * themselves) asks for this.
 */
function installWebShim() {
  const nativeFetch = window.fetch.bind(window);
  const real = offlineAwareFetch(nativeFetch);
  window.webRealFetch = real;
  window.fetch = async (input, init) => {
    const rel = siteRelativePath(input);

    // --- VM bytecode / sgbd-tables files interception (from cached ECUs)
    if (
      rel.startsWith('/data/job-code/') &&
      rel !== '/data/job-code/index.json'
    ) {
      return serveEcuMember(rel, real, 'job-code.json', 'Job code');
    }
    if (rel.startsWith('/data/sgbd-tables/')) {
      return serveEcuMember(rel, real, 'sgbd-tables.json', 'SGBD tables');
    }

    // Only route to API if prefix matches /api/
    if (!rel.startsWith('/api/')) return real(input, init);

    // --- endpoints the server computed, answered locally
    if (/^\/api\/health/.test(rel))
      return jsonResponse({ ok: true, web: true });
    if (/^\/api\/port/.test(rel)) {
      return jsonResponse({
        port: webBus.connected ? webBus.portLabel() : null,
      });
    }
    if (/^\/api\/state/.test(rel)) return routeState();

    // --- job execution. The web build used to refuse the clear/write/flash
    // jobs outright; lifted at the owner's request so actuator tests work
    // (see the note on Best2Vm.allowWrites). They run through the VM's own
    // gate, which is now permissive by default rather than absent.
    const run = /^\/api\/ecu\/([^/]+)\/run\/([^/?]+)/.exec(rel);
    if (run) return routeRun(rel, run[1], run[2]);

    // --- everything else is a static file route (served from the zip archives)
    return routeStatic(rel, real, init);
  };
}
