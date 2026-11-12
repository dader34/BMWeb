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

/**
 * The page buttons' picture, measured off the pack's three: a stack of
 * windows, the page's own one lit, over the caption "Page n".
 */
const SCANNER_PAGE_GLYPH = {
  width: 75,
  height: 51,
  /** The front window, whole, in every one of the pack's pictures. */
  window: { x: 13, y: 13, w: 27, h: 22 },
  /** Each window behind the front one: this far right and up. */
  step: { x: 8, y: 4 },
  /** The caption: its first row, and where its number starts and is drawn. */
  caption: { y: 36, numberX: 50, digitX: 53, digitY: 38 },
  ink: '#191919',
};

/**
 * Numbers the pack has no caption for, in its lettering (it stops at
 * "Page 3").
 * @type {Object<number, string[]>}
 */
const SCANNER_PAGE_DIGITS = {
  4: [
    '    ###',
    '   ####',
    '  ## ##',
    ' ##  ##',
    '##   ##',
    '#######',
    '     ##',
    '     ##',
    '     ##',
  ],
};

/**
 * One of the pack's pictures, decoded.
 * @param {string} uri - Its data URI.
 * @returns {Promise<HTMLImageElement>}
 */
function scannerGlyphImage(uri) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('glyph did not decode'));
    img.src = uri;
  });
}

/** The selector the pack keys a page button's picture by. */
const scannerPageGlyphSelector = (n) =>
  `.scn-tool.scn-ico-page-${n} .scn-glyph`;

/**
 * The page buttons' pictures for a grid with more pages than the
 * reference's three: every picture redrawn with one window per page, the
 * page's own one lit, and a picture for each page the pack has none for.
 *
 * Drawn here, from the pack's own pixels, rather than shipped: its "Page 1"
 * picture has the lit window whole and its "Page 2" an unlit one whole, so
 * any stack can be laid from the two; the caption's word comes from the
 * pack too, and only a number it never drew comes from this file.
 * @param {Object<string, string>} glyphs - The pack's pictures, by selector.
 * @param {number} pages - How many pages the grid has.
 * @returns {Promise<Object<string, string>>} Pictures by selector; empty
 *   when the pack's own three already fit, or cannot be redrawn.
 */
async function scannerPageGlyphs(glyphs, pages) {
  const G = SCANNER_PAGE_GLYPH;
  const packed = [1, 2, 3].map((n) => glyphs[scannerPageGlyphSelector(n)]);
  if (pages <= packed.length || packed.some((uri) => !uri)) return {};
  for (let n = packed.length + 1; n <= pages; n++)
    if (!SCANNER_PAGE_DIGITS[n]) return {};
  const pictures = await Promise.all(packed.map(scannerGlyphImage));
  const [lit, unlit] = pictures;
  const out = {};
  for (let page = 1; page <= pages; page++) {
    const canvas = document.createElement('canvas');
    canvas.width = G.width;
    canvas.height = G.height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    // the stack, back to front: window k sits k steps behind the front one
    for (let k = pages - 1; k >= 0; k--) {
      const w = G.window;
      ctx.drawImage(
        k === page - 1 ? lit : unlit,
        w.x,
        w.y,
        w.w,
        w.h,
        w.x + k * G.step.x,
        w.y - k * G.step.y,
        w.w,
        w.h
      );
    }
    // the caption: the pack's "Page", then the number
    const c = G.caption;
    const rows = G.height - c.y;
    ctx.drawImage(lit, 0, c.y, c.numberX, rows, 0, c.y, c.numberX, rows);
    const own = pictures[page - 1];
    if (own) {
      const cols = G.width - c.numberX;
      ctx.drawImage(
        own,
        c.numberX,
        c.y,
        cols,
        rows,
        c.numberX,
        c.y,
        cols,
        rows
      );
    } else {
      ctx.fillStyle = G.ink;
      SCANNER_PAGE_DIGITS[page].forEach((row, y) => {
        for (let x = 0; x < row.length; x++)
          if (row[x] === '#') ctx.fillRect(c.digitX + x, c.digitY + y, 1, 1);
      });
    }
    out[scannerPageGlyphSelector(page)] = canvas.toDataURL('image/png');
  }
  return out;
}

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
  const rules = (glyphs) =>
    Object.entries(glyphs)
      .filter(
        ([sel, uri]) =>
          /^[.\w:\- ]+$/.test(sel) &&
          /^data:image\/png;base64,[\w+/=]+$/.test(uri)
      )
      .map(([sel, uri]) => `${sel}{background-image:url('${uri}')}`)
      .join('\n');
  style.textContent = rules(pack.glyphs);
  // the grid has more pages than the pack has page pictures: redraw them
  // (after the pack's own rules, so these win)
  const pages = typeof scannerPageCount === 'function' ? scannerPageCount() : 0;
  scannerPageGlyphs(pack.glyphs, pages)
    .then((drawn) => {
      style.textContent += '\n' + rules(drawn);
    })
    .catch(() => {
      // not redrawn: the pack's three stay as they came
    });
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
