/**
 * @file Loading the corpus-wide job search index, once.
 *
 * The index is built at export time (tools/export/search_index.py) and ships
 * as one gzipped file: every INPA key and screen in every script the build
 * carries, with the jobs each sends. Scanning the corpus in the browser would
 * mean downloading every .chassis archive, so this fetches the finished
 * answer -- ~2 MB, cached by the service worker like the rest of api/.
 *
 * The fetch goes through webRealFetch (the FILE, not the shim's /api/ router)
 * because the index is a static artifact, not a route the shim computes.
 */

/* exported SEARCH_INDEX_VERSION, searchIndexLoad, searchIndexPeek, searchIndexPresent */

/** The index format this code understands; the builder stamps it as `v`. */
const SEARCH_INDEX_VERSION = 1;

/**
 * The whole index as the builder writes it.
 * @typedef {object} SearchIndex
 * @property {number} v - format version
 * @property {SearchModule[]} modules - one per SGBD, entries point into this
 * @property {SearchEntry[]} entries - the keys and screens
 */

/**
 * One module: a script, and the cars that carry it.
 * @typedef {object} SearchModule
 * @property {string} sgbd - the .prg name, lower-case; the deep link's module part
 * @property {string} label - the module's human name ("MS45.1 for M54")
 * @property {string} code - INPA's own designation for it (MS450), may be ''
 * @property {string[]} chassis - chassis ids that carry it, upper-case
 * @property {number} [vehicle] - 1 when this is a whole-vehicle script
 */

/**
 * One searchable thing: a key a user can press, or a screen the script shows.
 * Field names are one or two letters because the file holds ~90k of these.
 * @typedef {object} SearchEntry
 * @property {'k'|'s'} t - key or screen
 * @property {number} i - index into `modules`
 * @property {string} [m] - the menu proc the key sits on (keys only)
 * @property {number} [n] - the F-key number, 11..20 = shifted (keys only)
 * @property {string} [l] - the key's label as the script prints it
 * @property {string} [e] - that label in English, when a dictionary has it
 * @property {string} [s] - the screen proc this opens (keys) or is (screens)
 * @property {string} [ti] - the screen's title
 * @property {string} [tie] - that title in English
 * @property {string[]} [j] - job names it sends
 * @property {string[]} [k] - result keys the screen paints (screens only)
 * @property {string} [c] - the screen's static captions, joined (screens only)
 * @property {string} [ce] - those captions in English
 * @property {number} [w] - 1 when the key writes to the module
 * @property {string} [a] - the key's non-job action, when it has one
 */

/** @type {SearchIndex|null} the loaded index */
let searchIndex = null;

/** @type {Promise<SearchIndex|null>|null} the in-flight load, shared */
let searchIndexPromise = null;

/**
 * Load the index, once. Concurrent callers share one fetch, and a failure is
 * remembered as "no index" rather than retried on every keystroke.
 * @returns {Promise<SearchIndex|null>} the index, or null when it cannot load
 */
function searchIndexLoad() {
  if (searchIndex) return Promise.resolve(searchIndex);
  if (searchIndexPromise) return searchIndexPromise;
  const base = typeof WEB_BASE === 'string' ? WEB_BASE : '';
  const real =
    typeof webRealFetch === 'function'
      ? webRealFetch
      : window.fetch.bind(window);
  searchIndexPromise = (async () => {
    try {
      const r = await real(`${base}/api/search-index.json.gz`);
      if (!r || !r.ok) return null;
      const buf = new Uint8Array(await r.arrayBuffer());
      // a host that content-decodes hands back plain JSON; both are taken
      const gz = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
      if (gz && typeof fflate === 'undefined') return null;
      const text = new TextDecoder('utf-8').decode(
        gz ? fflate.gunzipSync(buf) : buf
      );
      const doc = JSON.parse(text);
      // a format the app does not understand would be read field-by-field
      // into nonsense results; refusing it shows the empty state instead
      if (!doc || doc.v !== SEARCH_INDEX_VERSION || !Array.isArray(doc.entries))
        return null;
      searchIndex = doc;
      return doc;
    } catch {
      return null;
    }
  })();
  return searchIndexPromise;
}

/**
 * The index if it is already loaded, without starting a load.
 * @returns {SearchIndex|null}
 */
function searchIndexPeek() {
  return searchIndex;
}

/** @type {Promise<boolean>|null} the in-flight presence probe, shared */
let searchIndexPresentPromise = null;

/**
 * Whether this build ships an index at all, WITHOUT downloading it.
 *
 * The Apps hub greys a card whose data did not ship, and asks every app that
 * question when it draws. Answering it with a full load would make opening
 * the hub cost the 2 MB the app itself costs, so this asks for the headers
 * only. A HEAD a static host does not answer falls back to the loaded index
 * when one is already in hand, and otherwise reports present -- an app card
 * wrongly shown opens a screen that explains itself, while one wrongly hidden
 * cannot be found at all.
 * @returns {Promise<boolean>}
 */
function searchIndexPresent() {
  if (searchIndex) return Promise.resolve(true);
  if (searchIndexPresentPromise) return searchIndexPresentPromise;
  const base = typeof WEB_BASE === 'string' ? WEB_BASE : '';
  const real =
    typeof webRealFetch === 'function'
      ? webRealFetch
      : window.fetch.bind(window);
  searchIndexPresentPromise = (async () => {
    try {
      const r = await real(`${base}/api/search-index.json.gz`, {
        method: 'HEAD',
      });
      return !!(r && r.ok);
    } catch {
      return true;
    }
  })();
  return searchIndexPresentPromise;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SEARCH_INDEX_VERSION,
    searchIndexLoad,
    searchIndexPeek,
    searchIndexPresent,
  };
}
