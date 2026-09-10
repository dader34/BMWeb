// Control unit tree data: ISTA's per-series bus topology, as
// tools/ista/ecu_tree_extract.py writes it (data/ista/ecu-tree/). One index
// names every tree and maps our chassis ids onto them; one file per tree
// holds the modules with their group SGBDs, bus and grid cell, and the bus
// lines. Loaded like the other ISTA extracts: a local copy first, then the
// Hugging Face dataset, and never before the app is opened.

/** Hosted copy of the trees (the bmweb-etk dataset, beside faulttests.json). */
const ECU_TREE_HF_BASE =
  'https://huggingface.co/datasets/CraigFf/bmweb-etk/resolve/main/ista/ecu-tree/';

/** Buses ISTA lists a module on but never draws. */
const ECU_TREE_HIDDEN = new Set(['UNKNOWN', 'VIRTUAL', 'NONE', 'INTERNAL']);

/**
 * @typedef {object} EcuTreeEcu
 * @property {string} name - the box label (KOMBI, DME, LM ...)
 * @property {number} addr - the diagnostic address
 * @property {number[]} [addrs] - every address on the cell, once drawn (ecuTreeDrawn)
 * @property {string[]} groups - the group SGBDs it is reached through, lower-case
 * @property {string} bus - the bus it sits on (KBUS, FACAN, KCAN, MOST ...)
 * @property {number} col - grid column
 * @property {number} row - grid row (the root sits at row 0)
 */

/**
 * @typedef {object} EcuTreeBus
 * @property {string} bus - the bus name
 * @property {number} col - the column the line runs in
 * @property {boolean} paintToRoot - the line reaches the root row
 * @property {boolean} connectOnlyRight - only the column to its right hangs on it
 * @property {boolean} vertical
 * @property {boolean} horizontal
 */

/**
 * @typedef {object} EcuTree
 * @property {string} series - the tree's name (E46, F01 ...)
 * @property {string} mainSgbd
 * @property {EcuTreeEcu[]} ecus
 * @property {EcuTreeBus[]} buses
 */

/**
 * @typedef {object} EcuTreeIndex
 * @property {number} version
 * @property {Object<string, {ecus: number, buses: string[], mainSgbd: string}>} trees
 * @property {Object<string, string>} chassis - our chassis id -> tree name
 */

/** @type {EcuTreeIndex|null} */
let ecuTreeIndexCache = null;
/** @type {Map<string, EcuTree|null>} tree name -> tree */
const ecuTreeCache = new Map();

/**
 * One tree file, local copy first (a build that ships data/ista) then the
 * hosted dataset. Resolves null when neither has it.
 * @param {string} rel - the file name (index.json, E46.json)
 * @returns {Promise<object|null>}
 */
async function ecuTreeFetchJson(rel) {
  const real =
    typeof webRealFetch === 'function'
      ? webRealFetch
      : window.fetch.bind(window);
  const base = typeof WEB_BASE === 'string' ? WEB_BASE : '';
  for (const u of [
    `${base}/data/ista/ecu-tree/${rel}`,
    ECU_TREE_HF_BASE + rel,
  ]) {
    try {
      const r = await real(u);
      if (r && r.ok) return await r.json();
    } catch (e) {
      /* try the next source */
    }
  }
  return null;
}

/**
 * The index: which trees exist and which chassis draws with which.
 * @returns {Promise<EcuTreeIndex|null>}
 */
async function ecuTreeIndex() {
  if (ecuTreeIndexCache) return ecuTreeIndexCache;
  if (window.__ecuTreeIndexLoading) return window.__ecuTreeIndexLoading;
  window.__ecuTreeIndexLoading = (async () => {
    const idx = await ecuTreeFetchJson('index.json');
    ecuTreeIndexCache = idx && idx.trees ? idx : null;
    return ecuTreeIndexCache;
  })();
  return window.__ecuTreeIndexLoading;
}

/**
 * Whether the trees are reachable at all (the hub card asks).
 * @returns {Promise<boolean>}
 */
async function ecuTreeIndexPresent() {
  const idx = await ecuTreeIndex().catch(() => null);
  return !!(idx && idx.trees && Object.keys(idx.trees).length);
}

/**
 * The tree name a chassis draws with, or null when ISTA has none for it.
 * @param {string} chassis - the chassis id
 * @returns {Promise<string|null>}
 */
async function ecuTreeNameFor(chassis) {
  const idx = await ecuTreeIndex();
  if (!idx) return null;
  return idx.chassis[String(chassis).toUpperCase()] || null;
}

/**
 * The tree a chassis draws with.
 * @param {string} chassis - the chassis id
 * @returns {Promise<EcuTree|null>}
 */
async function ecuTreeForChassis(chassis) {
  const name = await ecuTreeNameFor(chassis);
  if (!name) return null;
  if (ecuTreeCache.has(name)) return ecuTreeCache.get(name) || null;
  const tree = await ecuTreeFetchJson(`${name}.json`);
  const ok = tree && Array.isArray(tree.ecus) ? tree : null;
  ecuTreeCache.set(name, ok);
  return ok;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ECU_TREE_HIDDEN, ecuTreeFetchJson, ecuTreeForChassis };
}
