/**
 * @file What the parts catalogue takes from the classic renderer: the shell's
 * DOM nodes, its UI helpers, the garage, the router and the data fetcher.
 *
 * THE ONE FILE WITH AMBIENT GLOBALS. The catalogue is the first screen
 * written as ES modules (scripts/build/modules.json builds this directory
 * into core/generated/etk.js, a classic script that defines the global
 * `etk`). Everything else in the renderer is still a classic script sharing
 * one global scope, so the catalogue reaches it through here: each export
 * below is a thin wrapper that reads the global when it is CALLED, never
 * when this module loads -- so the module can be imported by a node test
 * before any of the shell exists, and so the page's load order stays what
 * index.html says.
 *
 * When a shell file moves to modules, its wrapper here becomes an import
 * from it, and this file shrinks. The list is the coupling, in one place.
 */

/* global view, sbLeft, sbRight, APP_NAME, CHASSIS_TAG, WEB_BASE, BMWEB_ETK, lastScreen:writable */

/** The classic scripts' function declarations, as the global object holds them. */
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

/** @returns {string} the app's name for footers (core). */
export const appName = () =>
  typeof APP_NAME === 'string' ? APP_NAME : 'BMWeb';

/**
 * @param {string} id - chassis code
 * @returns {string} the brand tag the shell knows for it, or ''
 */
export const chassisTag = (id) =>
  typeof CHASSIS_TAG === 'object' && CHASSIS_TAG ? CHASSIS_TAG[id] || '' : '';

/** @returns {string} the web root the data is served under ('' in the app). */
export const webBase = () => (typeof WEB_BASE === 'string' ? WEB_BASE : '');

/** @returns {Object<string, string>|null} the offline export's inline ETK archives, when there are any. */
export const inlineEtk = () =>
  typeof BMWEB_ETK === 'object' && BMWEB_ETK ? BMWEB_ETK : null;

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
 * @returns {void}
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
export const inpaMode = () => g.inpaMode();
export const openModal = (...a) => g.openModal(...a);
export const errorBlock = (...a) => g.errorBlock(...a);
export const printDoc = (opts) => g.printDoc(opts);
export const printImage = (...a) => g.printImage(...a);
export const printTable = (...a) => g.printTable(...a);
export const makeDropdown = (opts) => g.makeDropdown(opts);
export const makeListBox = (opts) => g.makeListBox(opts);

// ---- the other screens the catalogue navigates to -------------------------
export const showChassis = (...a) => g.showChassis(...a);
export const showApps = (...a) => g.showApps(...a);
export const showGarage = (...a) => g.showGarage(...a);

// ---- the garage (screens/garage/store.js), optional on an older build ------
export const garageCars = () =>
  typeof g.garageCars === 'function' ? g.garageCars() : [];
export const garageCarLabel = (car) =>
  typeof g.garageCarLabel === 'function' ? g.garageCarLabel(car) : null;
export const garageFindByVin = (vin) =>
  typeof g.garageFindByVin === 'function' ? g.garageFindByVin(vin) : null;

// ---- the router (core/router.js): a deep link for the open screen ----------
export const routeSetEtkDiagram = (...a) => {
  if (typeof g.routeSetEtkDiagram === 'function') g.routeSetEtkDiagram(...a);
};
export const routeSetFiltered = (...a) => {
  if (typeof g.routeSetFiltered === 'function') g.routeSetFiltered(...a);
};

// ---- the dataset fetcher (core/webshim/data-fetch.js) ---------------------
/**
 * One dataset file, local copy first then every mirror.
 * @param {string} rel - path under the dataset root
 * @param {object} [opts] - data-fetch's options (`local`, `as`)
 * @returns {Promise<any|null>}
 */
export const hfFetchFirst = (rel, opts) => g.hfFetchFirst(rel, opts);
/** @returns {string[]} the bmweb-etk dataset mirrors, in order */
export const hfMirrors = () => g.HF_MIRRORS || [];
