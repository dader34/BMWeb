/**
 * @file Tuning screen: the shared state, the constants every piece reads, and
 * the shapes the pieces pass between them.
 *
 * The Tuning screen is a client-side ECU firmware editor in the TunerPro
 * mould. Load a firmware BIN, view it as raw hex (virtualized so multi-MB
 * images stay smooth), load a TunerPro .xdf definition to edit named
 * constants / flags / tables through their scaling, then save the modified
 * BIN back. Nothing is uploaded -- the bytes never leave the machine.
 *
 * The parser + raw<->engineering codec live in core/xdf/ (window.XDF), which
 * is unit-tested (tools/verify/test_xdf.js). screens/tuning/ is the UI, one
 * piece per concern; this piece loads first and declares nothing that reads
 * another piece at load time.
 */

/* exported tuningState, XDF_MIRRORS, TUNE_HEX, TN_COVER_SLOTS, TN_HISTORY_MAX, TN_KIND_LABEL, tnAdoptImage, tnAdoptDefinition, tnResetState */

/**
 * @typedef {Object} ByteRange
 * A half-open byte span [start, end) in the image.
 * @property {number} start
 * @property {number} end
 */

/**
 * @typedef {Object} OwnerRecord
 * The definition item that describes a run of bytes.
 * @property {XdfItem} item
 * @property {number} start
 * @property {number} end - Exclusive.
 */

/**
 * @typedef {Object} CoverInfo
 * @property {number} described - Bytes the definition describes.
 * @property {number} total - Bytes in the image.
 * @property {number} items - Items that landed inside the image.
 */

/**
 * @typedef {Object} ByteWrite
 * One write an edit performed, held so it can be replayed either way.
 * @property {number} address
 * @property {Uint8Array} before
 * @property {Uint8Array|null} after
 */

/**
 * @typedef {Object} HistoryEntry
 * @property {string} label - What the edit was ("cell edit", "smooth", ...).
 * @property {ByteWrite[]} writes
 */

/**
 * @typedef {Object} TuningState
 * @property {Uint8Array|null} bin - The working image (edited in place via splice).
 * @property {Uint8Array|null} orig - Snapshot at load, for changed-byte highlighting.
 * @property {string} fileName - BIN file name (for the Save default).
 * @property {XdfFile|null} def - The parsed .xdf, or null.
 * @property {string} defName - .xdf file name.
 * @property {string|null} defText - The .xdf SOURCE, kept so a reload can
 *   re-parse it (the parsed graph is too big to store, and re-parsing 4.7 MB
 *   costs ~290 ms -- see core/tuning-store.js).
 * @property {string|null} selectedId - Stable key of the open item (XdfItem.key).
 * @property {string|null} openTable - Key of the table whose editor dialog is open, kept across reloads.
 * @property {HistoryEntry[]} history - Edit history for the loaded image,
 *   shared by every table dialog and kept across reloads.
 * @property {HistoryEntry[]} redo
 * @property {number} changed - Count of bytes differing from orig.
 * @property {ByteRange|null} highlight - Byte range to spotlight in the hex view.
 * @property {string} filter - Definition-tree search text.
 * @property {Set<string>|null} openCats - Category names the user has
 *   expanded. Closed is the default: a real definition is ~300 categories
 *   deep (MS45.1 has 298), and rendering every row of every one buries the
 *   thing you came for. A filter overrides this -- see tnRenderDefList.
 * @property {Set<string>|null} shutCats - Sections collapsed while a filter is on.
 * @property {Uint8Array|null} cover - MAP OVERLAY: byte -> colour slot, so
 *   the hex pane can show at a glance which areas the definition describes
 *   and where one parameter ends and the next begins. 0 = not described;
 *   1..TN_COVER_SLOTS = a slot. Built once per (def, bin).
 * @property {Int32Array|null} owner - Byte -> 1-based index into `owners`.
 * @property {OwnerRecord[]|null} owners - The region each byte belongs to.
 * @property {boolean} coverOn - User toggle for the overlay.
 * @property {CoverInfo|null} coverInfo - Figures for the legend.
 * @property {Set<string>|null} kinds - Which item kinds the list shows, or
 *   null for "everything" -- null rather than a full Set so a definition
 *   carrying a kind we have not met still shows by default.
 */

/**
 * @typedef {Object} TuningEls
 * The screen's live DOM handles, looked up once in showTuning.
 * @property {HTMLButtonElement} loadBin
 * @property {HTMLButtonElement} readEcu
 * @property {HTMLButtonElement} loadXdf
 * @property {HTMLButtonElement} browseXdf
 * @property {HTMLButtonElement} clear
 * @property {HTMLButtonElement} save
 * @property {HTMLElement} file
 * @property {HTMLElement} status
 * @property {HTMLInputElement} binInput
 * @property {HTMLInputElement} xdfInput
 * @property {HTMLElement} defs
 * @property {HTMLElement} hexPane
 * @property {HTMLElement} hexScroll
 * @property {HTMLElement} hexSpacer
 * @property {HTMLElement} hexWindow
 * @property {HTMLElement} hexEmpty
 * @property {HTMLElement} hexMeta
 * @property {HTMLButtonElement} mapToggle
 * @property {HTMLInputElement} goto
 * @property {HTMLSelectElement} cols
 * @property {HTMLElement} insp
 * @property {HTMLElement} inspRows
 * @property {HTMLInputElement} findQ
 * @property {HTMLElement} findModes
 * @property {HTMLButtonElement} findPrev
 * @property {HTMLButtonElement} findNext
 * @property {HTMLElement} findCount
 * @property {HTMLElement} hsCur
 * @property {HTMLElement} hsSel
 */

/**
 * @typedef {Object} HexView
 * What createHexView returns: the surface the rest of the screen drives.
 * @property {() => void} refresh - "Bytes may have changed": repaint, re-run any find.
 * @property {(range: ByteRange, opts?: { scroll?: boolean, label?: string }) => void} selectRegion
 * @property {(off: number) => void} scrollTo
 * @property {(raw: string) => boolean} gotoExpr
 */

/**
 * @typedef {Object} TuningEditor
 * The per-visit context every screen piece receives: the DOM, the hex view,
 * and the one flag that crosses a re-render.
 * @property {TuningEls} els
 * @property {HexView} hex
 * @property {boolean} suppressSpotlightScroll - Set while opening an item
 *   from a hex click, so the tree re-render does not scroll the hex view.
 */

/**
 * Screen state. Persists within a visit so re-renders don't drop a loaded
 * image, and across reloads via core/tuning-store.js.
 * @type {TuningState}
 */
const tuningState = {
  bin: null,
  orig: null,
  fileName: '',
  def: null,
  defName: '',
  defText: null,
  selectedId: null,
  openTable: null,
  history: [],
  redo: [],
  changed: 0,
  highlight: null,
  filter: '',
  openCats: null,
  shutCats: null,
  cover: null,
  owner: null,
  owners: null,
  coverOn: true,
  coverInfo: null,
  kinds: null,
};

/**
 * Where the shared definition library lives. Same pattern as screens/etk/
 * and core/translate.js: a dataset served over plain HTTPS, no auth,
 * CORS-readable. The three mirrors carry identical content -- if one is
 * unreachable we try the next rather than giving up.
 * @type {string[]}
 */
const XDF_MIRRORS = [
  'https://huggingface.co/datasets/CraigFf/bmw-files/resolve/main/tuning/xdf/',
  'https://huggingface.co/datasets/HarryG8/bmw-files/resolve/main/tuning/xdf/',
  'https://huggingface.co/datasets/VerilP0/bmw-files/resolve/main/tuning/xdf/',
];

/**
 * Hex grid geometry. BYTES_PER_ROW is written back when the user changes the
 * column count, so re-entering the screen restores the chosen width.
 */
const TUNE_HEX = {
  BYTES_PER_ROW: 16,
  DEFAULT_COLS: 16,
  ROW_H: 20,
  OVERSCAN: 8,
};

/** Colour slots the coverage map rotates through (1..N; 0 = uncovered). */
const TN_COVER_SLOTS = 8;

/** Undo entries kept per loaded image. */
const TN_HISTORY_MAX = 500;

/**
 * Short badge text per item kind, shared by the tree rows and the kind
 * filter chips.
 * @type {Object<string, string>}
 */
const TN_KIND_LABEL = {
  constant: 'VAL',
  flag: 'FLG',
  table: 'TBL',
  patch: 'PATCH',
};

/**
 * Make `bytes` the working image: a fresh baseline, an empty edit trail, no
 * highlight. Used for a loaded file and for an image read off a car alike.
 * @param {Uint8Array} bytes
 * @param {string} fileName
 * @returns {void}
 */
function tnAdoptImage(bytes, fileName) {
  tuningState.bin = bytes;
  tuningState.history = []; // the trail belonged to the old bytes
  tuningState.redo = [];
  tuningState.orig = bytes.slice(); // snapshot for change tracking
  tuningState.fileName = fileName;
  tuningState.changed = 0;
  tuningState.highlight = null;
}

/**
 * Make `def` the open definition, dropping the view state that belonged to
 * the previous one: a kind filter carried over could hide every item in the
 * new file, and every section starts collapsed.
 * @param {XdfFile} def - The parsed definition.
 * @param {string} text - Its source, kept for the session store.
 * @param {string} name - Its file name.
 * @returns {void}
 */
function tnAdoptDefinition(def, text, name) {
  tuningState.def = def;
  tuningState.defText = text;
  tuningState.defName = name;
  tuningState.selectedId = null;
  tuningState.kinds = null;
  tuningState.openCats = null;
  tuningState.shutCats = null;
}

/**
 * Drop everything held in memory: the image, the definition, the edit
 * trail, the view state and the coverage map.
 * @returns {void}
 */
function tnResetState() {
  tuningState.bin = null;
  tuningState.orig = null;
  tuningState.fileName = '';
  tuningState.def = null;
  tuningState.defText = null;
  tuningState.defName = '';
  tuningState.selectedId = null;
  tuningState.openTable = null;
  tuningState.history = [];
  tuningState.redo = [];
  tuningState.highlight = null;
  tuningState.changed = 0;
  tuningState.filter = '';
  tuningState.kinds = null;
  tuningState.openCats = null;
  tuningState.shutCats = null;
  tuningState.cover = null;
  tuningState.owner = null;
  tuningState.owners = null;
  tuningState.coverInfo = null;
}
