/**
 * @file Data loaders the job runner, resolver and coding path share: plain
 * JSON, gzipped JSON, and the shared SGBD tables.
 *
 * These go through the global `fetch`, which install.js has replaced with the
 * shim -- so `data/job-code/<sgbd>.json` and friends are answered from the
 * cached ECU archives, not the network.
 */
/* exported webFetchJson, webFetchGz, loadSharedTables, HF_MIRRORS, hfUrls, hfFetchFirst */

/**
 * Fetch a JSON file, or null on any failure (404, bad JSON).
 * @param {string} path - The app-relative path.
 * @returns {Promise<any|null>} The parsed body, or null.
 */
async function webFetchJson(path) {
  const r = await fetch(path);
  return r.ok ? r.json().catch(() => null) : null;
}

/**
 * Fetch a gzipped JSON file. data/groups files are gzipped JSON served
 * as-is; a host that transparently content-decodes hands us plain JSON, so
 * both are taken. Null on any failure.
 * @param {string} path - The app-relative path.
 * @returns {Promise<any|null>} The parsed body, or null.
 */
async function webFetchGz(path) {
  try {
    const r = await fetch(path);
    if (!r.ok) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    const isGz = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
    if (isGz && typeof fflate === 'undefined') {
      throw new Error('fflate decompression library not loaded');
    }
    const text = new TextDecoder('utf-8').decode(
      isGz ? fflate.gunzipSync(buf) : buf
    );
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The shared table files, loaded once (the PROMISE is cached so concurrent
 * callers fetch once).
 * @type {Promise<Record<string, any>>|null}
 */
let sharedTablesPromise = null;

/**
 * The shared table files (t_pcod, t_scod, t_ausb, t_grtb): an SGBD reads
 * them with `tabsetex <table>, <file>` -- ms450ds0's FS_LESEN_DETAIL looks
 * its P-code up in t_pcod's PCodeTexte. Loaded once, given to every VM.
 * @returns {Promise<Record<string, any>>} file name -> tables ({} when absent).
 */
function loadSharedTables() {
  if (!sharedTablesPromise) {
    sharedTablesPromise = webFetchGz('data/groups/shared-tables.json.gz')
      .then((t) => (t && typeof t === 'object' ? t : {}))
      .catch(() => ({}));
  }
  return sharedTablesPromise;
}

/**
 * The dataset mirrors, in the order they are tried.
 *
 * The same tree lives under several accounts because ONE ACCOUNT IS A SINGLE
 * POINT OF FAILURE: a repo can be rate-limited, taken down, renamed or simply
 * unreachable from where the user is, and the app should not lose its data
 * because of any of those. They carry identical paths, so the same relative
 * name resolves against any of them.
 *
 * Order matters only for speed, not correctness -- whichever answers first
 * wins, and a mirror that is behind on an upload simply 404s and the next one
 * is tried.
 * @type {string[]}
 */
const HF_MIRRORS = [
  'https://huggingface.co/datasets/CraigFf/bmweb-etk/resolve/main/',
  'https://huggingface.co/datasets/VerilP0/bmweb-etk/resolve/main/',
  'https://huggingface.co/datasets/HarryG8/bmweb-etk/resolve/main/',
];

/**
 * Every place one dataset file might be: the local copy an offline build
 * ships, then each mirror.
 *
 * THE LOCAL COPY IS ALWAYS FIRST. An offline build has the whole dataset
 * under data/, and a build that still reaches the network is not offline.
 * The 404 it costs on a hosted install is the price of that, and it is
 * cheap -- the service worker caches only what answers.
 * @param {string} rel - the path under the dataset root, e.g.
 *   'ista/ecu-tree/E46.json'
 * @param {string} [localPrefix] - where the same file sits locally, when it
 *   is not 'data/' + rel (the ETK tree is flattened, for one)
 * @returns {string[]} the URLs to try, in order
 */
function hfUrls(rel, localPrefix) {
  const base = typeof WEB_BASE === 'string' ? WEB_BASE : '';
  const local = localPrefix == null ? `data/${rel}` : localPrefix;
  return [
    `${base}/${local}`.replace(/([^:])\/\//g, '$1/'),
    ...HF_MIRRORS.map((m) => m + rel),
  ];
}

/**
 * Fetch one dataset file from the first source that answers.
 *
 * Uses the UNSHIMMED fetch where one exists: install.js replaces the global
 * `fetch` to answer /api/* from the cached ECU archives, and these are plain
 * files on a CDN, not engine routes.
 * @param {string} rel - the path under the dataset root
 * @param {object} [opts] - `local` overrides the local path; `as` is
 *   'json' (default), 'text', 'bytes' or 'response'
 * @returns {Promise<any|null>} the body in the asked-for form, or null when
 *   no source answered
 */
async function hfFetchFirst(rel, opts) {
  const o = opts || {};
  const real =
    typeof webRealFetch === 'function'
      ? webRealFetch
      : typeof window !== 'undefined' && window.fetch
        ? window.fetch.bind(window)
        : typeof fetch === 'function'
          ? fetch
          : null;
  if (!real) return null;
  for (const u of hfUrls(rel, o.local)) {
    try {
      const r = await real(u);
      if (!r || !r.ok) continue;
      if (o.as === 'response') return r;
      if (o.as === 'bytes') return new Uint8Array(await r.arrayBuffer());
      if (o.as === 'text') return await r.text();
      return await r.json();
    } catch (e) {
      /* try the next source */
    }
  }
  return null;
}
