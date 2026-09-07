/**
 * @file Data loaders the job runner, resolver and coding path share: plain
 * JSON, gzipped JSON, and the shared SGBD tables.
 *
 * These go through the global `fetch`, which install.js has replaced with the
 * shim -- so `data/job-code/<sgbd>.json` and friends are answered from the
 * cached ECU archives, not the network.
 */
/* exported webFetchJson, webFetchGz, loadSharedTables */

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
