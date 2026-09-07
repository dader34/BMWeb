/**
 * @file Wiring archive access. Wiring diagrams come from BMW's own WDS:
 * tools/wds_import.py packs one .wiring archive per car, with schematics as
 * .svgz (gzipped SVG, vector) and functional descriptions as HTML, straight
 * out of WDS. Inflating is fflate. This piece fetches and caches an archive,
 * inflates one document out of it, probes which cars ship one, flattens the
 * tree for search, and resolves the photographs the archive does not carry.
 */

/* exported
   WIRING_KIND_LABEL, loadWiring, wiringDoc, wiringImageUrl,
   wiringFetchImage, wiringIndex, wiringHasChassis */

/**
 * One node of a WDS tree: a folder (children) or a document leaf (doc).
 * @typedef {Object} WiringTreeNode
 * @property {string} name - the title WDS gives the folder or document
 * @property {string} [doc] - SP doc id of a leaf; absent on a folder
 * @property {string} [kind] - leaf kind, a WIRING_KIND_LABEL key
 * @property {WiringTreeNode[]} [children] - folder contents
 */

/**
 * A loaded .wiring archive.
 * @typedef {Object} WiringArchive
 * @property {WiringTreeNode} tree - the root of the WDS tree (tree.json)
 * @property {Map<string, Uint8Array>} files - every archive member by path
 * @property {Map<string, string>} [imgUrls] - blob URLs minted for photos, by path
 */

/**
 * A leaf lifted out of the tree for search and prev/next stepping.
 * @typedef {Object} WiringIndexEntry
 * @property {string} name - document title
 * @property {string} kind - leaf kind
 * @property {string} doc - SP doc id
 * @property {string[]} trail - the folder names above the leaf, top down
 */

/**
 * One document inflated and ready for the view pane.
 * @typedef {Object} WiringDocContent
 * @property {'svg' | 'html'} type - a schematic or a description
 * @property {string} text - the SVG or HTML markup
 */

/** @type {Map<string, WiringArchive>} chassis -> loaded archive */
const WIRING_CACHE = new Map();

/**
 * Kinds the tree uses, in the order a person looks for them.
 * @type {Object<string, string>}
 */
const WIRING_KIND_LABEL = {
  schematic: 'Wiring diagram',
  location: 'Component location',
  connector: 'Connector view',
  pins: 'Pin assignment',
  specs: 'Specifications',
  test: 'Test procedure',
  description: 'Description',
  measurement: 'Measurement',
  help: 'Help',
  document: 'Document',
};

/**
 * The fetch that reaches the real network. The web shim wraps window.fetch to
 * answer /api/ routes locally; data archives must bypass it.
 * @returns {typeof fetch}
 */
function wiringRealFetch() {
  return typeof webRealFetch === 'function'
    ? webRealFetch
    : window.fetch.bind(window);
}

/**
 * Absolute URL of a shipped data file, honouring the hosted site's base path.
 * @param {string} path - path under data/, e.g. 'wiring/E46.wiring'
 * @returns {string}
 */
function wiringDataUrl(path) {
  const base = typeof WEB_BASE === 'string' ? WEB_BASE : '';
  return `${base}/data/${path}`;
}

/**
 * Decode a base64 string into bytes. The offline export inlines archives this
 * way (window.BMACW_WIRING / BMACW_DOCS).
 * @param {string} b64 - base64 text
 * @returns {Uint8Array}
 */
function wiringBase64Bytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Fetch a zipped data archive, preferring an inlined copy (offline export)
 * over the network, and unpack it into its tree plus a member map.
 * @param {string} path - path under data/, e.g. 'wiring/E46.wiring'
 * @param {string | null} inline - base64 archive from the offline export, or null
 * @param {string} missing - error message when the file is not shipped
 * @returns {Promise<{tree: any, files: Map<string, Uint8Array>}>}
 */
async function wiringFetchArchive(path, inline, missing) {
  let bytes;
  if (inline) {
    bytes = wiringBase64Bytes(inline);
  } else {
    const r = await wiringRealFetch()(wiringDataUrl(path));
    if (!r.ok) throw new Error(missing);
    bytes = new Uint8Array(await r.arrayBuffer());
  }
  const unzipped = fflate.unzipSync(bytes);
  const tree = JSON.parse(new TextDecoder().decode(unzipped['tree.json']));
  return { tree, files: new Map(Object.entries(unzipped)) };
}

/**
 * Does a shipped data file exist? A HEAD request; any failure reads as no.
 * @param {string} path - path under data/
 * @returns {Promise<boolean>}
 */
async function wiringDataExists(path) {
  try {
    const r = await wiringRealFetch()(wiringDataUrl(path), { method: 'HEAD' });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Load one car's .wiring archive, once. The offline export inlines archives
 * as base64; that copy wins when present.
 * @param {string} chassisId - chassis code, any case
 * @returns {Promise<WiringArchive>}
 */
async function loadWiring(chassisId) {
  const id = chassisId.toUpperCase();
  if (WIRING_CACHE.has(id)) return WIRING_CACHE.get(id);
  const inline =
    typeof BMACW_WIRING === 'object' && BMACW_WIRING ? BMACW_WIRING[id] : null;
  const data = await wiringFetchArchive(
    `wiring/${id}.wiring`,
    inline,
    `no wiring data shipped for ${dispChassis(id)}`
  );
  WIRING_CACHE.set(id, data);
  return data;
}

/**
 * Does this car have wiring data? Asked before drawing a button that'd fail.
 * @param {string} chassisId - chassis code, any case
 * @returns {Promise<boolean>}
 */
async function hasWiring(chassisId) {
  const id = chassisId.toUpperCase();
  if (WIRING_CACHE.has(id)) return true;
  if (typeof BMACW_WIRING === 'object' && BMACW_WIRING)
    return !!BMACW_WIRING[id];
  return wiringDataExists(`wiring/${id}.wiring`);
}

/**
 * A document ready for screen: schematics inflate to SVG, descriptions are
 * HTML. Null when the WDS release the data was built from lacks it.
 * @param {WiringArchive} data - the loaded archive
 * @param {string} docId - SP doc id
 * @returns {WiringDocContent | null}
 */
function wiringDoc(data, docId) {
  const svgz = data.files.get(`svg/${docId}.svgz`);
  if (svgz) {
    return { type: 'svg', text: fflate.strFromU8(fflate.gunzipSync(svgz)) };
  }
  const html = data.files.get(`doc/${docId}.html`);
  if (html) return { type: 'html', text: fflate.strFromU8(html) };
  return null;
}

// Photographs the .wiring archive doesn't carry (878 MB, over the GitHub Pages
// cap), fetched from a CDN on the hosted site. jsDelivr, not a release asset:
// release downloads send no access-control-allow-origin, jsDelivr is CORS-open.
// PINNED TO A COMMIT, not @main: a moving branch means a later repo reorg
// retroactively breaks the photos in every export ever shipped. Bump the SHA
// deliberately.
const WIRING_IMG_CDN =
  'https://cdn.jsdelivr.net/gh/dader34/BMacW-wiring-images@55cad337b4787326cfcacbea220fa4787aaa74e4/img/';
const WIRING_IMG_CACHE = 'bmacw-wiring-images-v3'; // bump with the CDN URL

/**
 * A blob URL per image, made once and kept: the same photo appears on many
 * documents, and minting a URL per view would leak one each time.
 * @param {WiringArchive} data - the archive the photo belongs to
 * @param {string} path - the image path as the document references it
 * @param {Uint8Array | Blob} bytesOrBlob - archive bytes, or a CDN Blob
 * @returns {string}
 */
function wiringImageUrl(data, path, bytesOrBlob) {
  if (!data.imgUrls) data.imgUrls = new Map();
  let url = data.imgUrls.get(path);
  if (!url) {
    // from the archive it is bytes; from the CDN it is already a Blob
    const blob =
      bytesOrBlob instanceof Blob
        ? bytesOrBlob
        : new Blob([bytesOrBlob], { type: 'image/png' });
    url = URL.createObjectURL(blob);
    data.imgUrls.set(path, url);
  }
  return url;
}

/**
 * Fetch a photograph the archive doesn't hold, and cache it (Cache API
 * survives reloads, so a car browsed once keeps its pictures offline). A miss
 * re-fetches.
 * @param {string} name - file name under the CDN's img/ folder
 * @returns {Promise<Blob | null>}
 */
async function wiringFetchImage(name) {
  const url = WIRING_IMG_CDN + name;
  try {
    const cache = await caches.open(WIRING_IMG_CACHE);
    const hit = await cache.match(url);
    if (hit) return hit.blob();
    const res = await fetch(url);
    if (!res.ok) return null;
    await cache.put(url, res.clone());
    return res.blob();
  } catch {
    // no Cache API (file://, private mode): still show the picture
    try {
      const res = await fetch(url);
      return res.ok ? res.blob() : null;
    } catch {
      return null;
    }
  }
}

/**
 * Flatten the tree once for search: every leaf with the folder path above it,
 * in tree order (which is also the prev/next stepping order).
 * @param {WiringTreeNode} tree - the archive's root node
 * @returns {WiringIndexEntry[]}
 */
function wiringIndex(tree) {
  const out = [];
  (function walk(node, trail) {
    for (const c of node.children || []) {
      if (c.doc) out.push({ name: c.name, kind: c.kind, doc: c.doc, trail });
      else walk(c, [...trail, c.name]);
    }
  })(tree, []);
  return out;
}

/**
 * Which cars WDS covers, asked once and remembered so the picker draws only
 * what can actually open.
 * @type {string[] | null}
 */
let WIRING_CHASSIS = null;

/**
 * The chassis codes that ship a .wiring archive, probed once in parallel.
 * @returns {Promise<string[]>}
 */
async function wiringChassisList() {
  if (WIRING_CHASSIS) return WIRING_CHASSIS;
  const ids = await api('/api/chassis').catch(() => []);
  // all 21 probes in parallel: serially it was seconds of blank screen
  const have = await Promise.all(ids.map((id) => hasWiring(id)));
  WIRING_CHASSIS = ids.filter((_, i) => have[i]);
  return WIRING_CHASSIS;
}

/**
 * Is wiring shipped for this chassis? (the section's "resolvable" gate)
 * @param {string} chassis - chassis code, any case
 * @returns {Promise<boolean>}
 */
async function wiringHasChassis(chassis) {
  const shipped = await wiringChassisList();
  return shipped.some(
    (id) => String(id).toUpperCase() === String(chassis).toUpperCase()
  );
}
