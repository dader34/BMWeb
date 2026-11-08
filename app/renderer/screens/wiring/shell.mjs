/**
 * @file What the Wiring & Documents screen takes from the classic renderer:
 * the shell's DOM nodes, its UI helpers, the settings, the router, the
 * tech-data rule evaluator and the data fetcher.
 *
 * THE ONE FILE WITH AMBIENT GLOBALS, as screens/etk/shell.mjs is for the
 * parts catalogue. scripts/build/modules.json builds this directory into
 * core/generated/wiring.js, a classic script defining the global `wiring`;
 * the rest of the renderer is still classic scripts sharing one global
 * scope, so the screen reaches it through here. Each export reads the
 * global when it is CALLED, never when this module loads, so a node test
 * can import the modules before any of the shell exists and the page's
 * load order stays what index.html says.
 *
 * When a shell file moves to modules, its wrapper here becomes an import
 * from it, and this file shrinks. The list is the coupling, in one place.
 */

/* global view, sbLeft, sbRight, WEB_BASE, CHASSIS_TAG, BMWEB_WIRING, BMWEB_DOCS, lastScreen:writable */

/** The classic scripts' top-level names, as the global object holds them. */
const g = /** @type {any} */ (globalThis);

/**
 * The shell's DOM nodes (core/ui.js), read on access: `dom.view`.
 * @type {{view: HTMLElement, sbLeft: HTMLElement, sbRight: HTMLElement}}
 */
export const dom = {
  get view() {
    return view;
  },
  get sbLeft() {
    return sbLeft;
  },
  get sbRight() {
    return sbRight;
  },
};

/** @returns {string} the web root the data is served under ('' in the app). */
export const webBase = () => (typeof WEB_BASE === 'string' ? WEB_BASE : '');

/**
 * @param {string} id - chassis code
 * @returns {string} the brand tag the shell knows for it, or ''
 */
export const chassisTag = (id) =>
  typeof CHASSIS_TAG === 'object' && CHASSIS_TAG ? CHASSIS_TAG[id] || '' : '';

/** @returns {Object<string, string>|null} the offline export's inline wiring archives, when there are any. */
export const inlineWiring = () =>
  typeof BMWEB_WIRING === 'object' && BMWEB_WIRING ? BMWEB_WIRING : null;

/** @returns {Object<string, string>|null} the offline export's inline document archives, when there are any. */
export const inlineDocs = () =>
  typeof BMWEB_DOCS === 'object' && BMWEB_DOCS ? BMWEB_DOCS : null;

/**
 * The fetch to use for dataset files: the un-shimmed one when the web shim
 * has wrapped window.fetch (core/webshim/api-router.js), else the browser's.
 * @returns {typeof fetch}
 */
export const realFetch = () =>
  typeof g.webRealFetch === 'function'
    ? g.webRealFetch
    : window.fetch.bind(window);

/**
 * Remember the screen a reload comes back to (app.js).
 * @param {() => void} fn - redraws the current screen
 * @returns {() => void}
 */
export function setLastScreen(fn) {
  lastScreen = fn;
  return lastScreen;
}

// ---- core/ui.js, core/dialogs.js, core/print.js, core/errors.js ----------
export const esc = (s) => g.esc(s);
export const head = (...a) => g.head(...a);
export const dispChassis = (id) => g.dispChassis(id);
export const setCrumbs = (items) => g.setCrumbs(items);
export const setActions = (...a) => g.setActions(...a);
export const screenOwner = () => g.screenOwner();
export const stagger = (...a) => g.stagger(...a);
export const inpaMode = () =>
  typeof g.inpaMode === 'function' ? !!g.inpaMode() : false;
export const inpaTheme = () =>
  typeof g.inpaTheme === 'function' ? !!g.inpaTheme() : false;
export const errorBlock = (...a) => g.errorBlock(...a);
export const printDoc = (opts) => g.printDoc(opts);
export const printHtml = (...a) => g.printHtml(...a);
export const printSvg = (...a) => g.printSvg(...a);
/** Tooltips on a subtree, when the shell has them (core/tips.js). */
export const tipify = (el) => {
  if (typeof g.tipify === 'function') g.tipify(el);
};
/** A body code's label (screens/vehicle-identity), or ''. */
export const bodyLabel = (code) =>
  typeof g.bodyLabel === 'function' ? g.bodyLabel(code) : '';
/** ISTA's tech-data chapter renderer (screens/techdata/render.js). */
export const renderTpChapter = (...a) => g.renderTpChapter(...a);

// ---- the settings store (core/settings.js) --------------------------------
export const Settings = {
  get: (...a) => g.Settings.get(...a),
  set: (...a) => g.Settings.set(...a),
};

// ---- the other screens the wiring viewer navigates to ---------------------
export const showChassis = (...a) => g.showChassis(...a);
export const showApps = (...a) => g.showApps(...a);
/** @returns {boolean} whether the parts catalogue's VIN decoder is on this build. */
export const hasVinDecoder = () =>
  !!(g.etk && typeof g.etk.showVinDecoder === 'function');
export const showVinDecoder = (...a) => g.etk.showVinDecoder(...a);

// ---- the router (core/router.js): a deep link for the open screen ----------
export const routeSetWiringDoc = (...a) => {
  if (typeof g.routeSetWiringDoc === 'function') g.routeSetWiringDoc(...a);
};
export const routeSetDocsDoc = (...a) => {
  if (typeof g.routeSetDocsDoc === 'function') g.routeSetDocsDoc(...a);
};
export const routeSetFiltered = (...a) => {
  if (typeof g.routeSetFiltered === 'function') g.routeSetFiltered(...a);
};

// ---- the tech-data rule evaluator (screens/techdata/data.js) --------------
export const techDataRuleEval = (...a) => g.techDataRuleEval(...a);
export const techDataComposeRule = (...a) => g.techDataComposeRule(...a);
export const techDataCarFacts = (...a) => g.techDataCarFacts(...a);
export const techDataCountry = (...a) => g.techDataCountry(...a);
export const techDataRuleFactsLoad = (...a) => g.techDataRuleFactsLoad(...a);

// ---- the data fetcher (core/webshim/data-fetch.js), the API, fflate -------
/** @returns {boolean} whether the mirror-aware fetcher is loaded. */
export const hasHfFetch = () => typeof g.hfFetchFirst === 'function';
export const hfFetchFirst = (rel, opts) => g.hfFetchFirst(rel, opts);
export const hfFolderMirrors = (...a) => g.hfFolderMirrors(...a);
/** @returns {string[]} the bmw-files dataset mirrors, in order */
export const hfFilesMirrors = () => g.HF_FILES_MIRRORS || [];
/** The sidecar / shim API call (core/api.js). */
export const api = (...a) => g.api(...a);
/** @returns {boolean} whether the inflater library is loaded. */
export const hasFflate = () => typeof g.fflate !== 'undefined';
export const fflate = {
  strFromU8: (...a) => g.fflate.strFromU8(...a),
  gunzipSync: (...a) => g.fflate.gunzipSync(...a),
  unzipSync: (...a) => g.fflate.unzipSync(...a),
};
