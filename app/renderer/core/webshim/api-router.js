/**
 * @file The fetch shim: installs over window.fetch so core.js's api() needs
 * no change at all, answering /api/* locally -- static routes from the
 * cached .chassis archives, job runs through the VM -- and routing every
 * genuine file read through the offline folder when one is picked.
 */
/* exported WEB_API_BASE, WEB_BASE, installWebShim, webChassisPacked, webChassisArchive */

/** The static API directory the exporter writes (tools/web_export.py). */
const WEB_API_BASE = 'api';

/**
 * WHERE THIS PAGE LIVES. A project site served from a subpath (/BMWeb/), not
 * the domain root, would resolve "/api/chassis" to the host's root -- off the
 * site entirely. Derive the base from the document's own URL and hang every
 * static path off it. Empty at a domain root.
 */
const WEB_BASE = (
  typeof location !== 'undefined'
    ? location.pathname.replace(/\/[^/]*$/, '')
    : ''
).replace(/\/$/, '');

/**
 * One chassis's ECUs: an unpacked .chassis archive, or, in a build that
 * carries its ECUs packed (see loadEcuPacks), where each is in the packs.
 * @typedef {object} ChassisData
 * @property {any} config - Its config.json.
 * @property {Map<string, Uint8Array|number>} ecuZips - sgbd (lowercased) ->
 *   .ecu bytes, or the ECU's number in the packs' index.
 * @property {EcuPacks} [packs] - The packs those numbers are in.
 */

/**
 * The ECU packs of a build that has them.
 * @typedef {object} EcuPacks
 * @property {{packs: string[], raw: number[], ecus: number[][],
 *   chassis: Record<string, {config: number[], ecus: Record<string, number>}>}} index
 *   - api/ecu-packs/index.json: each ECU as [pack, offset, length, crc32].
 * @property {{member: (name: string, rawLength: number, at: number[]) =>
 *   Promise<Uint8Array>}} read - The pack reader (core/packs.js).
 */

/**
 * Cache of chassis configs and their ECU zip buffers, keyed by chassis id.
 * @type {Map<string, ChassisData>}
 */
const CHASSIS_CACHE = new Map();

/**
 * Chassis archives on their way in, keyed by chassis id: the SECOND caller
 * of a 20 MB (or, for the catch-all, 112 MB) archive waits on the first
 * fetch rather than starting its own. Nine ECU reads that arrived together
 * on opening a chassis each found the cache empty and each pulled the
 * whole catch-all -- a gigabyte for one click.
 * @type {Map<string, Promise<ChassisData>>}
 */
const CHASSIS_LOADING = new Map();

/** The sgbd -> chassis index, fetched once. @type {Promise<Record<string,string>|null>|null} */
let ECU_INDEX_LOADING = null;

/** The ECU packs, looked for once. @type {Promise<EcuPacks|null>|null} */
let ECU_PACKS_LOADING = null;

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
 * @returns {Record<string, any>|null} The BMWEB_INLINE map, or null.
 */
function inlineData() {
  return typeof BMWEB_INLINE === 'object' && BMWEB_INLINE ? BMWEB_INLINE : null;
}

/**
 * The ECU packs, when this build carries its ECUs that way.
 *
 * AN OFFLINE BUILD HOLDS EVERY CAR, and the per-car .chassis archives hold
 * the same ECU once per car that has it: 4,081 files of which 1,415 are
 * distinct, 486 MB of a 1 GB download. scripts/build/pack_offline.py stores
 * each ECU once, like beside like, in zstd packs (core/packs.js) at about a
 * sixth of that, and leaves api/ecu-packs/index.json saying which car has
 * which. An ECU is then read out of its pack when it is opened.
 *
 * Only an offline build is asked: the hosted site serves one car's archive
 * to a reader who wants one car, and would answer this with a 404 on every
 * visit. Null means "no packs here", and the .chassis archives are used.
 * @param {RealFetch} realFetch - The unshimmed fetch.
 * @returns {Promise<EcuPacks|null>}
 */
function loadEcuPacks(realFetch) {
  if (ECU_PACKS_LOADING) return ECU_PACKS_LOADING;
  if (
    typeof bmwebPacks === 'undefined' ||
    typeof fzstd === 'undefined' ||
    !bmwebPacks.wanted()
  ) {
    ECU_PACKS_LOADING = Promise.resolve(null);
    return ECU_PACKS_LOADING;
  }
  const dir = `${WEB_BASE}/${WEB_API_BASE}/ecu-packs`;
  ECU_PACKS_LOADING = realFetch(`${dir}/index.json`)
    .then((r) => (r.ok ? r.json() : null))
    .then((index) => {
      if (!index || !Array.isArray(index.packs) || !index.chassis) return null;
      const read = bmwebPacks.reader({
        fetchPack: async (name) => {
          const r = await realFetch(`${dir}/${name}`);
          if (!r.ok)
            throw new Error(`ECU pack ${name}: ${r.statusText || r.status}`);
          return new Uint8Array(await r.arrayBuffer());
        },
        decompress: fzstd.decompress,
      });
      return { index, read };
    })
    .catch(() => null);
  return ECU_PACKS_LOADING;
}

/**
 * One member of the ECU packs.
 * @param {EcuPacks} packs - The packs.
 * @param {number[]} at - [pack, offset, length, crc32].
 * @returns {Promise<Uint8Array>}
 * @throws {Error} When the pack cannot be read or the member does not check.
 */
function ecuPackMember(packs, at) {
  const { index } = packs;
  return packs.read.member(index.packs[at[0]], index.raw[at[0]], at.slice(1));
}

/**
 * Whether this build has a car's ECUs in its packs (and so no .chassis
 * archive for it).
 * @param {string} chassisId - The chassis id (any case).
 * @returns {Promise<boolean>}
 */
async function webChassisPacked(chassisId) {
  const packs = await loadEcuPacks(window.webRealFetch);
  return !!(packs && packs.index.chassis[String(chassisId).toUpperCase()]);
}

/**
 * A car's .chassis archive, made from the packs, for the one reader that
 * wants the FILE: the offline exporter, which hands a single car's archive
 * to a copy that has no packs. Built as web_export.py builds one (each ECU
 * deflated in its own archive, those stored in the outer one), so the copy
 * reads it like any other. Slow by design's standards (it re-deflates a
 * car's every ECU) and only ever run by an export.
 * @param {string} chassisId - The chassis id (any case).
 * @returns {Promise<Uint8Array|null>} null when this build has no packs or
 *   they do not hold the car.
 * @throws {Error} When a pack cannot be read or a member does not check.
 */
async function webChassisArchive(chassisId) {
  const packs = await loadEcuPacks(window.webRealFetch);
  const packed = packs && packs.index.chassis[String(chassisId).toUpperCase()];
  if (!packed) return null;
  const files = {
    'config.json': [await ecuPackMember(packs, packed.config), { level: 6 }],
  };
  // by name, which is the order the packs are in: each pack is opened once
  for (const sgbd of Object.keys(packed.ecus).sort()) {
    const stored = await ecuPackMember(
      packs,
      packs.index.ecus[packed.ecus[sgbd]]
    );
    files[`ecu/${sgbd}.ecu`] = [
      fflate.zipSync(fflate.unzipSync(stored), { level: 6 }),
      { level: 0 },
    ];
  }
  return fflate.zipSync(files, { level: 0 });
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
  if (CHASSIS_LOADING.has(upperId)) return CHASSIS_LOADING.get(upperId);

  const inline = inlineData();
  if (inline && inline[upperId]) {
    const bin = atob(inline[upperId]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return cacheChassis(upperId, bytes);
  }

  const fileUrl = `${WEB_BASE}/api/chassis/${upperId}.chassis`;
  const loading = (async () => {
    // a build with its ECUs packed: the car's list, and nothing fetched
    // until an ECU is opened
    const packs = await loadEcuPacks(realFetch);
    const packed = packs && packs.index.chassis[upperId];
    if (packed) {
      const config = JSON.parse(
        new TextDecoder('utf-8').decode(
          await ecuPackMember(packs, packed.config)
        )
      );
      const data = {
        config,
        ecuZips: new Map(Object.entries(packed.ecus)),
        packs,
      };
      CHASSIS_CACHE.set(upperId, data);
      return data;
    }
    const res = await realFetch(fileUrl);
    if (!res.ok)
      throw new Error(`Failed to load chassis ${upperId}: ${res.statusText}`);
    const buffer = await res.arrayBuffer();
    return cacheChassis(upperId, new Uint8Array(buffer));
  })();
  CHASSIS_LOADING.set(upperId, loading);
  try {
    return await loading;
  } finally {
    CHASSIS_LOADING.delete(upperId);
  }
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
 * Every chassis config by id, from the export's one small file, cached
 * for the page. Null when the file is not there (an export older than it,
 * or an offline copy without it), in which case a config still comes from
 * its archive. The promise is cached so concurrent askers (car detection
 * asks for all 26 at once) share one fetch; a failed fetch is forgotten.
 * @type {Promise<Record<string, any>|null>|null}
 */
let chassisConfigsP = null;

/**
 * A chassis config WITHOUT its archive. A config is a few KB and is what
 * nav, the module screen, the tour and car detection want; the archive
 * behind it is 20-37 MB and only an ECU load needs it. Before this every
 * config read fetched and unzipped the archive, and detection -- which
 * reads all 26 to see which cars list the module that answered -- pulled
 * ~400 MB to answer a question a 280 KB file settles.
 * @param {string} chassisId - The chassis id (any case).
 * @param {RealFetch} realFetch - The unshimmed fetch.
 * @returns {Promise<any|null>} The config, or null when only the archive has it.
 */
async function loadChassisConfig(chassisId, realFetch) {
  const upperId = chassisId.toUpperCase();
  const cached = CHASSIS_CACHE.get(upperId);
  if (cached) return cached.config;
  const inline = inlineData();
  if (inline && inline._configs) return inline._configs[upperId] || null;
  if (!chassisConfigsP) {
    chassisConfigsP = realFetch(
      `${WEB_BASE}/${WEB_API_BASE}/chassis-configs.json`
    )
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    chassisConfigsP.then((v) => {
      if (!v) chassisConfigsP = null;
    });
  }
  const all = await chassisConfigsP;
  return (all && all[upperId]) || null;
}

/**
 * The sgbd -> chassis owner index, inlined or fetched.
 * @param {RealFetch} realFetch - The unshimmed fetch.
 * @returns {Promise<Record<string, string>|null>}
 */
async function loadEcuIndex(realFetch) {
  const inline = inlineData();
  if (inline && inline._index) return inline._index;
  // one fetch for everyone: the index is asked for by every ECU read that
  // finds no open chassis holding its SGBD, and nine at once fetched it
  // nine times
  if (!ECU_INDEX_LOADING)
    ECU_INDEX_LOADING = realFetch(`${WEB_BASE}/${WEB_API_BASE}/ecu-index.json`)
      .then((r) => r.json())
      .catch(() => {
        ECU_INDEX_LOADING = null; // a failed fetch may be retried
        return null;
      });
  return ECU_INDEX_LOADING;
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
  let from = null;
  for (const chassisData of CHASSIS_CACHE.values()) {
    if (chassisData.ecuZips.has(lowerSgbd)) {
      ecuZipBytes = chassisData.ecuZips.get(lowerSgbd);
      from = chassisData;
      break;
    }
  }

  // Not in a chassis we have open yet. ECUs ship only inside their chassis
  // archive -- loose copies duplicated all 310 for 47 MB and nothing read
  // them -- so find the car that owns this SGBD and load that. Costs one
  // chassis download, after which every ECU in the same car is already here.
  if (ecuZipBytes === null) {
    const idx = await loadEcuIndex(realFetch);
    const cid = idx && idx[lowerSgbd];
    if (cid) {
      const data = await loadChassis(cid, realFetch);
      ecuZipBytes = data.ecuZips.has(lowerSgbd)
        ? data.ecuZips.get(lowerSgbd)
        : null;
      from = data;
    }
  }
  // packed: the map held the ECU's number, and its bytes are in a pack
  if (typeof ecuZipBytes === 'number')
    ecuZipBytes = await ecuPackMember(
      from.packs,
      from.packs.index.ecus[ecuZipBytes]
    );

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
 * http(s), where this is exactly nativeFetch.
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
 * Answer this site's own data files out of an offline build's packs.
 *
 * AN OFFLINE BUILD CARRIES ITS PLAIN DATA FILES PACKED
 * (scripts/build/pack_offline.py: the WinKFP scripts, the coding data, the
 * group files, ISTA's tables), each once, in zstd packs under data/packs,
 * with one list ("site") keyed by the path each had. This wraps the fetch
 * every genuine file read funnels through, so a reader asks for
 * data/kfp/ms450.json exactly as before and gets its bytes. A file that
 * was gzipped is handed back gzipped (stored, which costs nothing to make
 * or undo), so whoever gunzips it gets what it always got.
 *
 * Anything not in the list -- every file of a build without packs, a remote
 * URL, the packs themselves -- goes on to the real fetch untouched.
 * @param {RealFetch} inner - The fetch that reaches the files.
 * @returns {RealFetch}
 */
function packedFilesFetch(inner) {
  return async (input, init) => {
    const method = String((init && init.method) || 'GET').toUpperCase();
    if (
      (method !== 'GET' && method !== 'HEAD') ||
      typeof bmwebPacks === 'undefined' ||
      typeof fzstd === 'undefined' ||
      typeof fflate === 'undefined' ||
      !bmwebPacks.wanted()
    )
      return inner(input, init);
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    // this site's own files only: another host's URL is somebody else's
    const here = typeof location !== 'undefined' ? `${location.origin}/` : '';
    if (/^https?:\/\//i.test(url) && !(here && url.startsWith(here)))
      return inner(input, init);
    const rel = siteRelativePath(url.replace(/^file:\/\/[^/]*/, ''))
      .split(/[?#]/)[0]
      .slice(1);
    if (!rel.startsWith('data/') || rel.includes('/packs/'))
      return inner(input, init);
    // the parts catalogue's side files are packed with the catalogue (so a
    // build without it carries none of them); everything else together
    const dir = rel.startsWith('data/etk/') ? 'data/etk/packs' : 'data/packs';
    const folder = bmwebPacks.folder(
      `${WEB_BASE}/${dir}`,
      inner,
      fzstd.decompress
    );
    let hit;
    try {
      hit = await folder.file('site', rel);
    } catch (e) {
      // a pack that cannot be read, or gave back other bytes than were
      // packed: the fetch fails, it does not answer with the wrong file
      console.error(`${rel}: ${e.message}`);
      return errorResponse(`${rel}: ${e.message}`);
    }
    if (!hit) return inner(input, init);
    if (method === 'HEAD') return new Response(null, { status: 200 });
    return new Response(
      hit.gz ? fflate.gzipSync(hit.bytes, { level: 0 }) : hit.bytes,
      { status: 200 }
    );
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
  if (!webBus.connected) {
    const pa = typeof pasoftBusRefusal === 'function' && pasoftBusRefusal();
    return errorResponse(pa ? pa.message : 'no cable connected', 503);
  }
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
    // The session switch and the job are ONE critical section. The bus
    // lock is per telegram, so two jobs on different SGBDs issued together
    // used to interleave telegram by telegram, each start ending the
    // other's session and re-running its INITIALISIERUNG (with the probe
    // timeout that carries). Hold the lock across both and run on the raw
    // exchange, as the coding write does, so nothing else reaches the wire
    // until this job has its answer.
    const r = await withBusLock(async () => {
      const exchange = (out, comm) => webBusRawExchange(out, comm);
      await switchSession(variant || sgbd, exchange);
      return webRunJob(variant || sgbd, job, arg, { exchange });
    });
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
const ECU_FILE_KINDS = new Set([
  'jobs',
  'ir',
  'tables',
  'ipoexec',
  // the decoded screens, whose gauges carry the min/max/okMin/okMax band the
  // script's author declared per result key. The garage reads those bands to
  // say whether a freeze-frame value is outside what the script calls normal.
  'screens',
]);
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
        // _SGBD (the catch-all) IS a chassis here; only the side tables are not
        return jsonResponse(
          Object.keys(inline).filter((k) => k !== '_index' && k !== '_configs')
        );
      }
      return real(`${WEB_BASE}/${WEB_API_BASE}/chassis.json`, init);
    }
    const cid = m[1];
    try {
      // the config alone when the export ships it; the archive only
      // when nothing else has it
      const config = await loadChassisConfig(cid, real);
      if (config) return jsonResponse(config);
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
  const real = packedFilesFetch(offlineAwareFetch(nativeFetch));
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

    // --- job execution. Clear/write/flash jobs run, so actuator tests work;
    // they pass through the VM's own write gate (see Best2Vm.allowWrites).
    const run = /^\/api\/ecu\/([^/]+)\/run\/([^/?]+)/.exec(rel);
    if (run) return routeRun(rel, run[1], run[2]);

    // --- everything else is a static file route (served from the zip archives)
    return routeStatic(rel, real, init);
  };
}
