/**
 * @file Reading a setting out of a coding read: the on/off vocabulary, the
 * keyword-to-result matcher, and the DATEN bit-level decoder that reads a
 * setting straight out of the raw coding blob. Also the lazy loaders for the
 * coding map and the DATEN map.
 *
 * READ A SETTING OUT OF THE RAW CODING BLOB. codMatchRead can only match a
 * keyword against NAMED results. Several modules do not give names: on a real
 * E46, zke5 answers COD_LESEN with one COD_DATEN byte array (and szm46 with
 * CODE), so BEIKLAPPEN_GM -- and every other curated feature on that module --
 * matched nothing and read as unknown, which the UI then drew as off. Every
 * one of those switches was showing the library default, not the car.
 *
 * BMW's DATEN description says exactly where each setting lives: block, word,
 * mask and shift, with the on/off values named. That is enough to read the bit
 * straight out of the bytes the ECU just returned (codReadDaten).
 *
 * The word differs per coding index -- zke5's BEIKLAPPEN_GM is word 23 on C04
 * and word 26 on C05+C06 -- so the variant must be chosen by the car's own
 * index, never by taking the first one that names the keyword.
 *
 * This decoder is deliberately separate from the write codec
 * (core/coding/encode.js): it follows the vendor tool's READ interpretation of
 * EINHEIT/OPERATION for display, and declines (null) on anything it cannot
 * represent rather than inventing a value.
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
 * Match a DATEN keyword to a value in an SGBD's coding read. The read names
 * results differently (COD_*\/STAT_*), so match on shared tokens and reduce
 * the best hit to a number (numeric -> itself, boolean word -> 1/0). Shared by
 * the Expert tree and curated toggles.
 * @param {string} kw - the DATEN keyword.
 * @param {Iterable<[string, unknown]>} pairs - `[resultName, value]` pairs.
 * @returns {number|null} the value, or null when nothing overlaps enough.
 */
function codMatchRead(kw, pairs) {
  /**
   * Significant name tokens (the COD_/STAT_ prefix and short tokens dropped).
   * @param {string} s - a name.
   * @returns {Set<string>} its tokens.
   */
  const toks = (s) =>
    new Set(
      String(s)
        .replace(/^(COD|STAT|STATUS|CODIER)_/i, '')
        .toUpperCase()
        .split('_')
        .filter((t) => t.length > 2)
    );
  const kt = toks(kw);
  let best = null,
    bestOverlap = 0;
  for (const [name, val] of pairs) {
    const ov = [...kt].filter((t) => toks(name).has(t)).length;
    if (ov > bestOverlap && ov >= Math.min(2, kt.size)) {
      bestOverlap = ov;
      best = val;
    }
  }
  if (best == null) return null;
  const s = String(best).trim().toLowerCase();
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (codKnown(s)) return codIsOn(s) ? 1 : 0;
  return null;
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
  const want = index == null ? null : `C${String(index).padStart(2, '0')}`;
  const pick = (want && names.find((n) => n.split('+').includes(want))) || null;
  const order = pick ? [pick] : names; // no index: fall back to any
  for (const n of order) {
    const f = (variants[n] || []).find((x) => x.name === kw);
    if (f) return { ...f, variant: n, exact: !!pick };
  }
  return null;
}

// EINHEIT: how a field's bytes become a number, as the vendor tool's own
// coding pipeline interprets it:
//
//   h  little-endian integer, LSB first          (the default)
//   a  the first byte, raw                       (ASCII code)
//   A  alphanumeric hex digit: '0'-'9' -> 0-9, 'A'-'Z' -> 10-35
//   b  bit-string: each byte is ASCII '0'/'1', byte i contributing bit i
//   d  ASCII decimal digits, concatenated and parsed
/**
 * Convert a field's masked bytes to a number per its EINHEIT.
 * @param {string|undefined} unit - EINHEIT char; omitted means 'h'.
 * @param {number[]} bytes - the masked bytes.
 * @returns {number|null} the value, or null for a byte the unit cannot
 *   represent (so a malformed read declines rather than inventing a value).
 */
function codDecodeUnit(unit, bytes) {
  const u = unit || 'h';
  if (!bytes.length) return null;
  if (u === 'h') {
    let v = 0;
    for (let i = 0; i < bytes.length; i++) v |= (bytes[i] & 0xff) << (8 * i);
    return v >>> 0;
  }
  if (u === 'a') return bytes[0] & 0xff;
  if (u === 'A') {
    const c = bytes[0] & 0xff;
    if (c >= 0x30 && c <= 0x39) return c - 0x30; // '0'-'9'
    if (c >= 0x41 && c <= 0x5a) return c - 0x37; // 'A'-'Z' -> 10-35
    return null;
  }
  if (u === 'b') {
    let v = 0;
    for (let i = 0; i < bytes.length; i++) {
      const bit = (bytes[i] & 0xff) - 0x30;
      if (bit !== 0 && bit !== 1) return null;
      v |= bit << i;
    }
    return v >>> 0;
  }
  if (u === 'd') {
    let s = '';
    for (const b of bytes) {
      const c = b & 0xff;
      if (c < 0x30 || c > 0x39) return null;
      s += String.fromCharCode(c);
    }
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return null; // unit we do not implement: decline
}

/**
 * Apply the OPERATION list the vendor tool applies after the unit
 * conversion, in order. Each is `[operator, operand]`; '!' takes no operand.
 * @param {number} value - the value after the unit conversion.
 * @param {Array<[string, number] | string> | undefined} ops - the OPERATION list.
 * @returns {number|null} the value, or null on an unknown operator / divide
 *   by zero.
 */
function codApplyOps(value, ops) {
  let v = value;
  for (const op of ops || []) {
    const k = Array.isArray(op) ? op[0] : op;
    const n = Array.isArray(op) ? op[1] >>> 0 : 0;
    switch (k) {
      case '!':
        break; // no-op marker
      case '&':
        v = (v & n) >>> 0;
        break;
      case '|':
        v = (v | n) >>> 0;
        break;
      case '^':
        v = (v ^ n) >>> 0;
        break;
      case '+':
        v = v + n;
        break;
      case '-':
        v = v - n;
        break;
      case '*':
        v = v * n;
        break;
      case '/':
        if (!n) return null;
        v = Math.floor(v / n);
        break;
      case '>':
        v = v >>> n;
        break;
      default:
        return null; // unknown operator: decline
    }
  }
  return v;
}

/**
 * Read one DATEN-described setting out of raw coding bytes, the way the
 * vendor tool does: take `byte` bytes from `word`, mask them, convert per
 * EINHEIT, then apply the OPERATION list.
 * @param {number[]|null|undefined} bytes - the coding blob.
 * @param {DatenField|null|undefined} field - the field.
 * @returns {number|null} 1/0 for a named aktiv/nicht_aktiv pair, the numeric
 *   value otherwise, or null when the bytes or definition are missing --
 *   unknown is honest, a wrong toggle is not.
 */
function codReadDaten(bytes, field) {
  if (!bytes || !field) return null;
  const i = typeof field.word === 'number' ? field.word : null;
  if (i == null || i < 0) return null;
  const nBytes =
    typeof field.byte === 'number' && field.byte > 0 ? field.byte : 1;
  if (i + nBytes > bytes.length) return null;
  // MASKE is per byte in the vendor tool; BMW ships a scalar here, which
  // applies to the byte the shift addresses (single-byte fields, 89% of the
  // corpus). For a multi-byte field a scalar mask cannot mean "one mask per
  // byte", so it is applied to the first and the rest pass whole -- matching
  // the little-endian fold the 'h' unit performs.
  const mask = typeof field.mask === 'number' ? field.mask : 0xff;
  const raw = [];
  for (let k = 0; k < nBytes; k++) {
    raw.push(k === 0 ? bytes[i] & mask : bytes[i + k] & 0xff);
  }
  let v = codDecodeUnit(field.unit, raw);
  if (v == null) return null;
  // the shift positions the masked field within its byte
  const shift = typeof field.shift === 'number' ? field.shift : 0;
  if (shift) v = v >>> shift;
  v = codApplyOps(v, field.ops);
  if (v == null) return null;
  const vals = field.values || [];
  // values are [name, hexString]; find the one this value means
  const hit = vals.find(([, hex]) => parseInt(hex, 16) === v);
  if (hit) {
    const n = String(hit[0]).toLowerCase();
    if (codKnown(n)) return codIsOn(n) ? 1 : 0;
  }
  return v;
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
  if (typeof loadDatenMap !== 'function') return null;
  await loadDatenMap();
  const map = (typeof window !== 'undefined' && window.BMW_DATEN_MAP) || null;
  if (!map || !sgbd) return null;
  return map[String(sgbd).toLowerCase()] || null;
}

// The pieces the other coding screens call; published explicitly so the shared surface is visible.
if (typeof window !== 'undefined') {
  window.codIsOn = codIsOn;
  window.codKnown = codKnown;
  window.codMatchRead = codMatchRead;
  window.codBytesOf = codBytesOf;
  window.codDatenField = codDatenField;
  window.codReadDaten = codReadDaten;
  window.codingFor = codingFor;
  window.datenFor = datenFor;
}
