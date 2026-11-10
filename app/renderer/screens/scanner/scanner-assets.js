/**
 * @file BMWeb Scanner: the reference data pack -- the window layouts, the
 * fault texts, the option tables and the tool-button glyphs read out of BMW
 * Scanner 1.4.0.7. None of it is in this repository: it is one gzipped JSON
 * file on the dataset mirrors (core/webshim/data-fetch.js: a local copy
 * under data/ first, then each mirror), fetched the first time the scanner
 * is opened.
 *
 * Without the pack the scanner still scans, reads counts and clears; the
 * Errors window falls back to "Error number XX", Car ident shows no option
 * texts, and the Unit info windows say the layouts could not be loaded.
 */

/* exported SCANNER_FORMS, SCANNER_FORM_IMAGES, SCANNER_FAULT_TEXTS, SCANNER_FAULT_ALPHABET, SCANNER_FA_TABLES, SCANNER_ASSETS_REL, scannerAssetsLoad, scannerAssetsApply */

/** The pack's path under the dataset root. */
const SCANNER_ASSETS_REL = 'scanner/reference-1.4.0.7.json.gz';

/** The 103 forms by class: {c, n, p, k} trees (scanner-vcl.js draws them). */
let SCANNER_FORMS = null;
/** Glyphs and pictures of the forms: {pool: [src, w, h][], map}. */
let SCANNER_FORM_IMAGES = null;
/** Fault texts and present markers per unit (scanner-faults.js). */
let SCANNER_FAULT_TEXTS = null;
/** The alphabet the fault texts' state strings index. */
let SCANNER_FAULT_ALPHABET = '';
/** Type keys and option texts (scanner-carinfo.js). */
let SCANNER_FA_TABLES = null;

/** The one load in flight or done; null again after a failed one. */
let _scannerAssets = null;

/**
 * Take a pack into use.
 * @param {{forms: object, formImages: object, faultTexts: object,
 *   faultAlphabet: string, faTables: object,
 *   glyphs?: Object<string, string>}} pack
 */
function scannerAssetsApply(pack) {
  SCANNER_FORMS = pack.forms || null;
  SCANNER_FORM_IMAGES = pack.formImages || null;
  SCANNER_FAULT_TEXTS = pack.faultTexts || null;
  SCANNER_FAULT_ALPHABET = pack.faultAlphabet || '';
  SCANNER_FA_TABLES = pack.faTables || null;
  if (typeof document === 'undefined' || !pack.glyphs) return;
  // the tool buttons' glyphs: one rule per button and state
  let style = document.getElementById('scn-assets');
  if (!style) {
    style = document.createElement('style');
    style.id = 'scn-assets';
    document.head.appendChild(style);
  }
  style.textContent = Object.entries(pack.glyphs)
    .filter(
      ([sel, uri]) =>
        /^[.\w:\- ]+$/.test(sel) &&
        /^data:image\/png;base64,[\w+/=]+$/.test(uri)
    )
    .map(([sel, uri]) => `${sel}{background-image:url('${uri}')}`)
    .join('\n');
}

/**
 * Fetch the pack once and take it into use.
 * @returns {Promise<boolean>} False when no source had it (asked again on
 *   the next call).
 */
function scannerAssetsLoad() {
  if (!_scannerAssets)
    _scannerAssets = hfFetchFirst(SCANNER_ASSETS_REL, { as: 'gzjson' })
      .then((pack) => {
        if (!pack || !pack.forms) {
          _scannerAssets = null;
          return false;
        }
        scannerAssetsApply(pack);
        return true;
      })
      .catch(() => {
        _scannerAssets = null;
        return false;
      });
  return _scannerAssets;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SCANNER_ASSETS_REL };
}
