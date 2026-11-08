/**
 * @file Parts catalogue data access: locating and streaming the per-chassis
 * .etk bundles, the vehicle attribute tree, the car photos, and turning an
 * archived image into something an <img> can show.
 *
 * tools/etk_import.py packs one .etk archive per car: tree.json (assembly
 * groups -> diagrams -> parts) plus the exploded-view images (jpg/png). Same
 * archive shape and loading path as the .wiring bundles -- fflate inflates,
 * and the offline export inlines base64.
 *
 * The .etk bundles are 6.4 GB across 246 cars -- too big to ship in the Pages
 * repo. They live in a Hugging Face dataset and stream in at runtime (HF's
 * resolve URLs reflect the request Origin, so cross-origin fetch from
 * bmweb.danner.ink is CORS-clean -- verified). Local data/etk/ wins when
 * present (dev + the offline single-file export), else fall back to HF.
 */

/* global fflate */
import { etkMergeLines } from './lines.mjs';
import { etkRulesMerge } from './rules.mjs';
import {
  dispChassis,
  hfFetchFirst,
  hfMirrors,
  inlineEtk,
  realFetch,
  webBase,
} from './shell.mjs';

/**
 * One part row on a diagram.
 * @typedef {object} EtkPart
 * @property {string} pos - position number on the exploded view
 * @property {string} sachnr - the 7-digit part number
 * @property {string} [pre] - 4-digit main-group + subgroup prefix that makes the full 11-digit number
 * @property {string} name - part description
 * @property {number[]} [fit] - indices into EtkTree.variants this part fits; absent means it fits every variant
 */

/**
 * One exploded-view diagram (a Bildtafel) with its parts list.
 * @typedef {object} EtkDiagram
 * @property {string} btnr - diagram number, the deep-link id (#apps/parts/E46/11/11_0100)
 * @property {string} name - diagram title
 * @property {string} [img] - image file name under img/ in the archive
 * @property {EtkPart[]} parts - parts drawn on the diagram
 */

/**
 * A function group inside a main group: a named list of diagrams.
 * @typedef {object} EtkGroup
 * @property {string} name - group title
 * @property {EtkDiagram[]} diagrams - diagrams under this group
 */

/**
 * A main group (Hauptgruppe) as drawn on the chassis landing grid.
 * @typedef {object} EtkMainGroup
 * @property {string} hg - two-digit main-group number ("11" = engine)
 * @property {string} name - main-group title
 * @property {string} [icon] - icon image ref under img/ in the archive
 * @property {EtkGroup[]} groups - function groups under this main group
 */

/**
 * One exact vehicle the catalogue can be filtered to.
 * @typedef {object} EtkVariant
 * @property {string} [model] - model name ("325i")
 * @property {string} [body] - body code (Lim, Tou, Cou, Cab...)
 * @property {string} [motor] - engine code ("M54")
 * @property {string} [steer] - 'L' or 'R'
 * @property {string} [gear] - 'A' automatic, 'M' manual, 'N' not split by transmission
 * @property {string|number} [date] - introduction date as YYYYMMDD
 */

/**
 * The parsed tree.json of one chassis archive.
 * @typedef {object} EtkTree
 * @property {string} chassis - chassis code the archive was packed for
 * @property {EtkMainGroup[]} [maingroups] - main groups in catalogue order
 * @property {EtkVariant[]} [variants] - the vehicles parts can be filtered to
 */

/**
 * A loaded chassis archive: its tree plus the raw files (images) inside it.
 * @typedef {object} EtkBundle
 * @property {EtkTree} tree - the parsed catalogue tree
 * @property {Map<string, Uint8Array>} files - archive entries by path ("img/319345.jpg")
 */

/**
 * One clickable callout rectangle on an exploded view: the callout number,
 * then its box in the diagram image's OWN pixel space (top-left origin).
 * @typedef {[string, number, number, number, number]} EtkHotspot
 */

/**
 * The parsed <CHASSIS>.hs.json.gz: which rectangles each diagram carries.
 * @typedef {object} EtkHotspotFile
 * @property {number} v - format version (1)
 * @property {Record<string, EtkHotspot[]>} bt - btnr -> its rectangles
 */

/**
 * Download progress callback. `total` is 0 when the server sent no
 * Content-Length, in which case the caller shows an indeterminate bar.
 * @typedef {(loaded: number, total: number) => void} EtkProgressFn
 */

/**
 * One row of vehicles.json: [steer, gear, introduction date YYYYMMDD, mospid].
 * @typedef {[string, string, string, string]} EtkVehicleRow
 */

/**
 * vehicles.json: chassis -> body -> model -> variant rows.
 * @typedef {Record<string, Record<string, Record<string, EtkVehicleRow[]>>>} EtkVehicleTree
 */

/** @type {Map<string, EtkBundle>} loaded archives by upper-cased chassis id */
const ETK_CACHE = new Map();

/** @type {string[]|null} memoised list of chassis ids that have an archive */
let etkChassisIds = null;

/**
 * Where the ETK data lives when there is no local copy: the first bmweb-etk
 * mirror (core/webshim/data-fetch.js holds the list; a fetch tries them all,
 * a URL handed to an <img> uses the first).
 * @returns {string}
 */
function etkHfBase() {
  return (
    hfMirrors()[0] ||
    'https://huggingface.co/datasets/CraigFf/bmweb-etk/resolve/main/'
  );
}

/** Path under the local web root where a build may ship the ETK data. */
const ETK_LOCAL_DIR = '/data/etk/';

/**
 * The fetch to use for ETK data: the un-shimmed one when the web shim has
 * wrapped window.fetch, else the browser's own.
 * @returns {typeof fetch}
 */
function etkFetch() {
  return realFetch();
}

/**
 * URL of one ETK data file, from the local build tree or the hosted dataset.
 * @param {string} rel - path relative to the ETK data root ("E46.etk", "thumbs/thumbs.json")
 * @param {boolean} local - true for the local copy, false for the hosted one
 * @returns {string}
 */
function etkDataUrl(rel, local) {
  if (local) {
    const base = webBase();
    return `${base}${ETK_LOCAL_DIR}${rel}`;
  }
  return `${etkHfBase()}${rel}`;
}

/**
 * Fetch one ETK data file, local copy first, then the hosted dataset. Network
 * errors on either count as a miss.
 * @param {string} rel - path relative to the ETK data root
 * @returns {Promise<{ resp: Response, url: string }|null>} the first OK response, or null when neither answered
 */
export async function etkFetchFirst(rel) {
  const resp = await hfFetchFirst(rel, {
    as: 'response',
    local: `data/etk/${rel}`,
  });
  return resp ? { resp, url: resp.url } : null;
}

/**
 * Load (and cache) the parts archive of one chassis. An inline base64 copy
 * (the offline single-file export's BMWEB_ETK) wins over any fetch.
 * @param {string} chassisId - chassis code, any case
 * @param {EtkProgressFn} [onProgress] - called as the bundle downloads
 * @returns {Promise<EtkBundle>}
 * @throws {Error} when no copy of the archive can be found
 */
export async function loadEtk(chassisId, onProgress) {
  const id = chassisId.toUpperCase();
  if (ETK_CACHE.has(id)) return ETK_CACHE.get(id);
  let bytes;
  const inline = inlineEtk() ? inlineEtk()[id] : null;
  if (inline) {
    const bin = atob(inline);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    const hit = await etkFetchFirst(`${id}.etk`);
    if (!hit) throw new Error(`no parts data for ${dispChassis(id)}`);
    bytes = await readWithProgress(hit.resp, onProgress);
  }
  const unzipped = fflate.unzipSync(bytes);
  const tree = JSON.parse(new TextDecoder().decode(unzipped['tree.json']));
  const files = new Map(Object.entries(unzipped));
  // THE LINES' VALIDITY RIDES BESIDE THE PUBLISHED BUNDLE (dates, steering,
  // condition, note -- see lines.js); a bundle built with them inline needs
  // nothing from the sidecar, and a chassis without one browses as before
  if (typeof etkMergeLines === 'function') {
    const side = await loadEtkLines(id);
    if (side) etkMergeLines(tree, side);
  }
  // the catalogue's own line filter (equipment rules, line keys,
  // changepoints -- see rules.js); a chassis without the file keeps the
  // plain window/side/gearbox filter
  if (typeof etkRulesMerge === 'function') {
    const side = await loadEtkRules(id);
    if (side) etkRulesMerge(tree, side);
  }
  const data = { tree, files };
  ETK_CACHE.set(id, data);
  return data;
}

/** @type {Map<string, Promise<object|null>>} chassis id -> its lines file */
const ETK_LINES_CACHE = new Map();

/**
 * Load (and cache) one chassis's parts-line validity file. Never throws: a
 * chassis whose file is missing or unreadable resolves to null and its
 * parts carry no conditions.
 * @param {string} chassisId - chassis code, any case
 * @returns {Promise<object|null>} the parsed <CHASSIS>.lines.json.gz, or null
 */
function loadEtkLines(chassisId) {
  const id = String(chassisId || '').toUpperCase();
  if (ETK_LINES_CACHE.has(id)) return ETK_LINES_CACHE.get(id);
  const p = hfFetchFirst(`${id}.lines.json.gz`, {
    as: 'gzjson',
    local: `data/etk/${id}.lines.json.gz`,
  })
    .then((data) => (data && data.ln ? data : null))
    .catch(() => null);
  ETK_LINES_CACHE.set(id, p);
  return p;
}

/** @type {Map<string, Promise<object|null>>} chassis id -> its rules file */
const ETK_RULES_CACHE_FILES = new Map();

/**
 * Load (and cache) one chassis's line-filter rules file. Never throws: a
 * chassis whose file is missing or unreadable resolves to null and keeps
 * the plain filter.
 * @param {string} chassisId - chassis code, any case
 * @returns {Promise<object|null>} the parsed <CHASSIS>.rules.json.gz, or null
 */
function loadEtkRules(chassisId) {
  const id = String(chassisId || '').toUpperCase();
  if (ETK_RULES_CACHE_FILES.has(id)) return ETK_RULES_CACHE_FILES.get(id);
  const p = hfFetchFirst(`${id}.rules.json.gz`, {
    as: 'gzjson',
    local: `data/etk/${id}.rules.json.gz`,
  })
    .then((data) => (data && data.dg ? data : null))
    .catch(() => null);
  ETK_RULES_CACHE_FILES.set(id, p);
  return p;
}

/** @type {Map<string, Promise<EtkHotspotFile|null>>} chassis id -> its hotspot file, in flight or settled */
const ETK_HS_CACHE = new Map();

/**
 * Load (and cache) one chassis's callout rectangles. This rides BESIDE the
 * bundle rather than inside it: the .etk archives are already published and
 * re-uploading all of them to add a few KB of rectangles is not worth it.
 *
 * Never throws and never blocks the diagram: a chassis whose file has not
 * been generated (or that cannot be reached) resolves to null, and the viewer
 * simply draws the plain, non-interactive exploded dom.view.
 * @param {string} chassisId - chassis code, any case
 * @returns {Promise<EtkHotspotFile|null>} the parsed file, or null when there is none
 */
export function loadEtkHotspots(chassisId) {
  const id = String(chassisId || '').toUpperCase();
  if (ETK_HS_CACHE.has(id)) return ETK_HS_CACHE.get(id);
  const p = hfFetchFirst(`${id}.hs.json.gz`, {
    as: 'gzjson',
    local: `data/etk/${id}.hs.json.gz`,
  })
    .then((data) => (data && data.bt ? data : null))
    .catch(() => null);
  ETK_HS_CACHE.set(id, p);
  return p;
}

/**
 * Stream a fetch Response into a Uint8Array, reporting progress as chunks
 * arrive. Falls back to arrayBuffer() when the body isn't a readable stream
 * or nobody is listening for progress.
 * @param {Response} resp - the response to drain
 * @param {EtkProgressFn} [onProgress] - progress callback
 * @returns {Promise<Uint8Array>}
 */
export async function readWithProgress(resp, onProgress) {
  const total = Number(resp.headers.get('content-length')) || 0;
  if (!resp.body || !resp.body.getReader || !onProgress) {
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (onProgress) onProgress(buf.length, buf.length);
    return buf;
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Every chassis that has a parts archive, sorted. One index.json lists them --
 * read it instead of HEAD-probing all ~135 cars (that would be hundreds of
 * requests to the hosted dataset). Memoised for the session.
 * @returns {Promise<string[]>}
 */
export async function etkChassisList() {
  if (etkChassisIds) return etkChassisIds;
  if (inlineEtk()) {
    etkChassisIds = Object.keys(inlineEtk()).sort();
    return etkChassisIds;
  }
  const real = etkFetch();
  const tryIndex = async (local) => {
    try {
      const r = await real(etkDataUrl('index.json', local));
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  };
  const idx = (await tryIndex(true)) || (await tryIndex(false));
  etkChassisIds = Array.isArray(idx) ? idx.slice().sort() : [];
  return etkChassisIds;
}

// ---- vehicle attribute tree (the ETK-style drill-down) --------------------
// vehicles.json: chassis -> body -> model -> [[steer,gear,year,mospid], ...].
// Small (~200 KB), ships in the repo (local), with an HF fallback.

/** @type {EtkVehicleTree|null} */
let etkVehicles = null;

/**
 * Load (and cache) vehicles.json, the attribute tree behind the identify-by-
 * attributes selector.
 * @returns {Promise<EtkVehicleTree>}
 * @throws {Error} when neither copy is reachable
 */
export async function loadVehicles() {
  if (etkVehicles) return etkVehicles;
  const hit = await etkFetchFirst('vehicles.json');
  if (!hit) throw new Error('vehicle data not available');
  etkVehicles = await hit.resp.json();
  return etkVehicles;
}

// thumbs.json: which <chassis>_<body> car photos shipped (ETK's Vehicle
// Identification images, extracted from w_baureihe_kar_thb). Local first,
// then the Hugging Face dataset (where the rest of the ETK data lives).
// Non-fatal: the drill-down just keeps its silhouette if the set isn't there.

/** @type {Record<string, string>|null} "<chassis>_<body>" -> photo file name */
let etkThumbs = null;

/** The directory URL thumbs.json resolved from, so photos load beside it. */
let etkThumbsBase = '';

/**
 * Load (and cache) the car-photo index. Never throws: a missing set resolves
 * to an empty map.
 * @returns {Promise<Record<string, string>>}
 */
export async function loadEtkThumbs() {
  if (etkThumbs) return etkThumbs;
  const hit = await etkFetchFirst('thumbs/thumbs.json');
  if (hit) {
    etkThumbs = await hit.resp.json();
    etkThumbsBase = hit.url.replace(/thumbs\.json$/, '');
    return etkThumbs;
  }
  etkThumbs = {};
  return etkThumbs;
}

/**
 * URL of the car photo for a chassis + body, if one shipped and the index has
 * loaded.
 * @param {string|null} chassis - chassis code
 * @param {string|null} body - body code
 * @returns {string|null}
 */
export function etkThumbUrl(chassis, body) {
  const name =
    etkThumbs && chassis && body ? etkThumbs[`${chassis}_${body}`] : null;
  return name ? `${etkThumbsBase}${name}` : null;
}

/** @type {Map<string, string>} "<chassis>/<ref>" -> object URL, so each image is materialised once */
const ETK_IMG_URLS = new Map();

/**
 * An image ref in the tree ("319345.jpg") as a blob URL an <img> can show.
 * @param {EtkBundle} data - the loaded archive
 * @param {string|undefined} ref - image file name under img/
 * @returns {string|null} the object URL, or null when the ref is empty or missing from the archive
 */
export function etkImageUrl(data, ref) {
  if (!ref) return null;
  const key = data.tree.chassis + '/' + ref;
  if (ETK_IMG_URLS.has(key)) return ETK_IMG_URLS.get(key);
  const bytes = data.files.get(`img/${ref}`);
  if (!bytes) return null;
  const ext = ref.split('.').pop().toLowerCase();
  const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  ETK_IMG_URLS.set(key, url);
  return url;
}
