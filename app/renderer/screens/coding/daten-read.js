/**
 * @file Reading a setting out of a module's coding image: which variant of
 * the coding description applies, and the value a function holds, taken from
 * its address. Also the on/off vocabulary for option names, and the lazy
 * loaders for the coding map and the DATEN map.
 *
 * ONE RULE: A VALUE COMES FROM ITS ADDRESS, OR IT IS NOT SHOWN.
 *
 * BMW's coding description says where each function lives -- address, length
 * and a mask per byte -- and writes each option as the bytes it stands for.
 * Given the module's coding image, a function's value is those bytes
 * (CodingEncode.fieldHex), and it either equals an option's or it does not.
 * Nothing here guesses: an earlier version matched a function's keyword
 * against the names of a diagnostic job's results by the word fragments they
 * shared, which could tie 46 of the E46's 858 functions to anything at all,
 * and drew the rest from a hash of the function's name. A setting that was
 * not read is unknown, and says so.
 *
 * The address differs per coding index -- the body module's mirror folding
 * is word 23 on C04 and word 26 on C05/C06 -- so the variant is chosen by the
 * module's own index, never by taking the first one that names the keyword.
 *
 * The same codec the write uses does the reading (core/coding/encode.js), so
 * what is shown is what a write would compare against.
 */

/**
 * A module's entry in the coding map (data/codingmap.js).
 * @typedef {Object} CodingMapEntry
 * @property {string} [read] - the coding read job.
 * @property {string} [write] - the coding write job.
 * @property {Array<{name: string}>} [fields] - the named results the read
 *   decodes into.
 */

/**
 * A module's entry in the DATEN map (data/datenmap.js).
 * @typedef {Object} DatenMapEntry
 * @property {string} daten - the DATEN file name.
 * @property {Record<string, Record<string, DatenField[]>>} chassis - chassis
 *   id -> coding variant key ("C05+C06") -> fields.
 * @property {Record<string, string>} [blocks] - block number -> BMW's name.
 */

/**
 * A DATEN field with which variant it came from and whether the car's coding
 * index selected that variant.
 * @typedef {DatenField & {variant: string, exact: boolean}} DatenFieldPick
 */

/**
 * Values that mean "on". The ECU answers 1/0, but some SGBDs answer in words.
 * @type {Set<string>}
 */
const COD_TRUE = new Set([
  '1',
  'ja',
  'ein',
  'aktiv',
  'vorhanden',
  'yes',
  'on',
  'true',
]);
/**
 * Values that mean "off". Both spellings of the negatives travel ("nicht
 * aktiv" and "nicht_aktiv").
 * @type {Set<string>}
 */
const COD_FALSE = new Set([
  '0',
  'nein',
  'aus',
  'inaktiv',
  'nicht aktiv',
  'nicht_aktiv',
  'nicht vorhanden',
  'nicht_vorhanden',
  'no',
  'off',
  'false',
]);

/**
 * Is this raw value "on"?
 * @param {unknown} raw - a result value.
 * @returns {boolean} true for an on-word.
 */
function codIsOn(raw) {
  return COD_TRUE.has(
    String(raw ?? '')
      .trim()
      .toLowerCase()
  );
}

/**
 * Is this raw value a known on/off word? Neither on nor off: a switch reading
 * "34" means the read didn't answer this field; calling it "off" would be a
 * lie.
 * @param {unknown} raw - a result value.
 * @returns {boolean} true for an on- or off-word.
 */
function codKnown(raw) {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  return COD_TRUE.has(s) || COD_FALSE.has(s);
}

/**
 * The bytes of a raw coding-blob result. "System.Byte[]" and friends carry
 * nothing; dashed/spaced hex does.
 * @param {unknown} v - a result value: byte array, typed array, or hex text.
 * @returns {number[]|null} the bytes, or null when the value is not bytes.
 */
function codBytesOf(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return v.map((b) => b & 0xff);
  if (ArrayBuffer.isView(v)) return Array.from(v, (b) => b & 0xff);
  const s = String(v).trim();
  if (/^[0-9A-Fa-f]{2}([\s-][0-9A-Fa-f]{2})+$/.test(s)) {
    return s.split(/[\s-]+/).map((h) => parseInt(h, 16));
  }
  return null;
}

/**
 * The DATEN field for `kw` on the variant this car's coding index selects.
 * "C05+C06" serves both indices; the index is matched inside the variant name
 * rather than by equality. With no index, any variant naming the keyword
 * serves (and `exact` says so).
 * @param {DatenMapEntry|null} daten - the module's DATEN entry.
 * @param {string} chassis - chassis id.
 * @param {number|null} index - the car's coding index, when the scan named it.
 * @param {string} kw - the DATEN keyword.
 * @returns {DatenFieldPick|null} the field, or null when absent.
 */
function codDatenField(daten, chassis, index, kw) {
  const byChassis = (daten && daten.chassis) || {};
  const variants =
    byChassis[String(chassis || '').toUpperCase()] ||
    byChassis[Object.keys(byChassis)[0]] ||
    {};
  const names = Object.keys(variants);
  if (!names.length) return null;
  // the variant that SERVES the index (its own list of indexes says so)
  const chKey = byChassis[String(chassis || '').toUpperCase()]
    ? String(chassis || '').toUpperCase()
    : Object.keys(byChassis)[0];
  const serving =
    index == null || !daten ? [] : variantsForCI(daten, chKey, index);
  const pick = serving.length === 1 ? serving[0] : null;
  const order = pick ? [pick] : names; // no index: fall back to any
  for (const n of order) {
    const f = (variants[n] || []).find((x) => x.name === kw);
    if (f) return { ...f, variant: n, exact: !!pick };
  }
  return null;
}

/**
 * A module's coding, as read from the car.
 * @typedef {Object} CodingImage
 * @property {ArrayLike<number>} bytes - the image, one byte per address.
 * @property {Set<number>|null} known - the addresses that were read; null
 *   when every byte of `bytes` was.
 * @property {number|null} block - the numbered block these bytes are, for a
 *   module that numbers its coding blocks; null for one address space.
 * @property {'script'|'blob'} route - through the module's own coding script,
 *   or the raw block a diagnostic job handed back.
 */

/**
 * The value a function holds in a coding image, in the form its options are
 * written in: lowercase hex of its bytes in address order, each under its
 * own mask.
 * @param {DatenField|null|undefined} f - the function.
 * @param {CodingImage|null|undefined} image - the module's coding image.
 * @returns {string|null} the value, or null when the image does not hold
 *   the function -- another block, an address that was not read, or no image.
 *   Null is "unknown", never a default.
 */
function codingImageValue(f, image) {
  if (!f || !image || !image.bytes) return null;
  // a block-addressed module read through its script comes back as one flat
  // image, block N at N * 256 (core/coding/write.js flattenBlocked)
  if (image.flat && typeof codingFlatRule === 'function') f = codingFlatRule(f);
  else if ((f.block || 0) !== (image.block || 0)) return null;
  const at = typeof f.word === 'number' ? f.word : -1;
  const width = typeof f.byte === 'number' && f.byte > 0 ? f.byte : 1;
  if (at < 0 || at + width > image.bytes.length) return null;
  if (image.known)
    for (let i = 0; i < width; i++) if (!image.known.has(at + i)) return null;
  return CodingEncode.fieldHex(f, image.bytes);
}

/**
 * Each scanned module's coding file, as NCS's procedure picked it (key: the
 * module's key in the scan, e.g. "gm5"). Filled by scanCoding.
 * @type {Map<string, object>}
 */
const _codingFiles = new Map();

/**
 * Record the coding file NCS's procedure picked for a module.
 * @param {string} key - the module's key in the scan.
 * @param {object} entry - the coding file (data/daten/<CH>.json shape).
 * @returns {void}
 */
function codingRegisterFile(key, entry) {
  _codingFiles.set(String(key).toLowerCase(), entry);
}

/**
 * The coding map entry for an SGBD, loading the map once.
 * @param {string} sgbd - module name.
 * @returns {Promise<CodingMapEntry|null>} the entry, or null.
 */
async function codingFor(sgbd) {
  if (typeof loadCodingMap !== 'function') return null;
  await loadCodingMap();
  const map = (typeof window !== 'undefined' && window.BMW_CODING_MAP) || null;
  if (!map || !sgbd) return null;
  return map[String(sgbd).toLowerCase()] || null;
}

/**
 * BMW's DATEN description of a module (bit/address -> function, settings
 * named aktiv / nicht_aktiv), for ECUs whose SGBD names nothing. A module
 * ships several coding variants; only the car's own coding index says which
 * it wants, so the reference lists every variant rather than picking one.
 * @param {string} sgbd - module name.
 * @returns {Promise<DatenMapEntry|null>} the entry, or null.
 */
async function datenFor(sgbd) {
  // the coding file NCS's own procedure picked for this module (the hub's
  // scan registers it: module list, coding index, selection table) -- no
  // name involved
  // Only that: a coding file is never looked up by a diagnostic SGBD's name.
  return _codingFiles.get(String(sgbd || '').toLowerCase()) || null;
}

// The pieces the other coding screens call; published explicitly so the shared surface is visible.
if (typeof window !== 'undefined') {
  window.codIsOn = codIsOn;
  window.codKnown = codKnown;
  window.codBytesOf = codBytesOf;
  window.codDatenField = codDatenField;
  window.codingImageValue = codingImageValue;
  window.codingFor = codingFor;
  window.datenFor = datenFor;
  window.codingRegisterFile = codingRegisterFile;
}
