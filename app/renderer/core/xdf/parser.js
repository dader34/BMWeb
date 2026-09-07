/**
 * @file XDF engine, piece 6 of 6: the .xdf structure parser and the
 * namespace's node export.
 *
 * A .xdf is TunerPro's XML describing where each tunable lives in the BIN:
 *   - XDFCONSTANT : a scalar at mmedaddress, sized mmedelementsizebits,
 *                   displayed through a MATH equation ("0.75*X-48").
 *   - XDFFLAG     : a single bit (mask) inside one byte.
 *   - XDFTABLE    : an X/Y/Z grid; the Z axis holds the editable cells, X/Y
 *                   are the (often shared) axis scales.
 *   - XDFPATCH    : a set of byte blobs (patchdata) vs stock (basedata).
 *   - XDFCHECKSUM : a region whose 16-bit sum is stored back into the image.
 *
 * This is the last piece loaded: it reads parseXml / XdfParseError (xml.js),
 * toV150Xml / detectXdfFormat (legacy.js) and the MATH tally (math.js) from
 * the shared `window.XDF` namespace, and publishes the finished namespace as
 * the node module export for tools/verify.
 */

(function (root) {
  'use strict';

  const XDF = root.XDF || (root.XDF = {});
  const XdfParseError = XDF.XdfParseError;

  /**
   * @typedef {Object} XdfCategory
   * @property {number} index - 0-based category index.
   * @property {string} name
   */

  /**
   * @typedef {Object} XdfRegion
   * @property {number} type
   * @property {number} startaddress
   * @property {number} size
   * @property {string} name
   * @property {string|undefined} description
   */

  /**
   * @typedef {Object} XdfHeader
   * @property {number} flags
   * @property {string} fileversion
   * @property {string} deftitle
   * @property {string} description
   * @property {string} author
   * @property {XdfBaseOffset} baseOffset
   * @property {XdfDefaults} defaults
   * @property {XdfRegion[]} regions
   * @property {XdfCategory[]} categories
   */

  /**
   * @typedef {Object} XdfItemCommon
   * Fields every item carries.
   * @property {number} uniqueid - TunerPro's optional id; often 0 for every item.
   * @property {string} title
   * @property {string} description
   * @property {number[]} categoryIndices - 0-based indices into header.categories.
   * @property {string} key - Stable per-file key, "<index>:<uniqueid>" (set by parseXdf).
   */

  /**
   * @typedef {XdfItemCommon & {
   *   kind: 'constant',
   *   embed: XdfEmbed,
   *   units: string|undefined,
   *   decimalpl: number|undefined,
   *   rangelow: number|undefined,
   *   rangehigh: number|undefined,
   *   datatype: number|undefined,
   *   unittype: number|undefined,
   *   outputtype: number|undefined,
   *   mathEquation: string,
   * }} XdfConstant
   */

  /**
   * @typedef {XdfItemCommon & { kind: 'flag', embed: XdfEmbed, mask: number }} XdfFlag
   */

  /**
   * @typedef {Object} XdfPatchEntry
   * @property {string} name
   * @property {number} address
   * @property {number} datasize
   * @property {Uint8Array} patchdata
   * @property {Uint8Array} basedata
   */

  /**
   * @typedef {XdfItemCommon & { kind: 'patch', entries: XdfPatchEntry[] }} XdfPatch
   */

  /**
   * @typedef {Object} XdfChecksumRegion
   * @property {number} datastart
   * @property {number} datasize
   * @property {number} storeaddress
   * @property {number} calctype - 0 is the only method seen in the wild: a plain 16-bit sum.
   * @property {number} regionflags
   */

  /**
   * @typedef {XdfItemCommon & { kind: 'checksum', regions: XdfChecksumRegion[] }} XdfChecksum
   */

  /**
   * @typedef {Object} XdfAxisLabel
   * @property {number} index
   * @property {string} value
   */

  /**
   * @typedef {Object} XdfAxis
   * @property {'x'|'y'|'z'} id
   * @property {number} uniqueid
   * @property {XdfEmbed} embed
   * @property {number} indexcount
   * @property {number|undefined} outputtype
   * @property {number|undefined} datatype
   * @property {number|undefined} unittype
   * @property {number|undefined} decimalpl
   * @property {string|undefined} units
   * @property {number|undefined} min - Raw-domain limit (XDFAXIS spelling).
   * @property {number|undefined} max - Raw-domain limit (XDFAXIS spelling).
   * @property {XdfAxisLabel[]} labels
   * @property {{ type: number, linkObjId: number }|undefined} embedInfo
   * @property {string} mathEquation
   */

  /**
   * @typedef {XdfItemCommon & { kind: 'table', axes: XdfAxis[] }} XdfTable
   */

  /** @typedef {XdfConstant|XdfFlag|XdfPatch|XdfChecksum|XdfTable} XdfItem */

  /**
   * @typedef {Object} XdfFile
   * @property {XdfHeader} header
   * @property {XdfItem[]} items - In document order.
   * @property {{ equation: string, count: number }[]} mathFailures - MATH that
   *   would not compile during the parse, most frequent first.
   * @property {Map<string, number>} mathMisses - The live tally; decode-time
   *   misses accumulate here too.
   * @property {'flat'|'v050'|'xml'} format - The spelling the file arrived in.
   */

  // ==========================================================================
  // Attribute / text helpers
  // ==========================================================================

  /**
   * Parse a TunerPro numeric attribute, which comes as decimal OR "0x.." hex,
   * freely mixed.
   * @param {*} raw - The attribute or text value.
   * @param {number} [fallback] - Returned for a missing or unparseable value.
   * @returns {number}
   * @throws {XdfParseError} When the value is missing or unparseable and no fallback was given.
   */
  function parseNumber(raw, fallback) {
    if (raw === null || raw === undefined || raw === '') {
      if (fallback !== undefined) return fallback;
      throw new XdfParseError('missing numeric value');
    }
    const trimmed = String(raw).trim();
    const isHex = /^-?0x/i.test(trimmed);
    const num = isHex
      ? parseInt(trimmed.replace(/^-?0x/i, ''), 16) *
        (trimmed.startsWith('-') ? -1 : 1)
      : Number(trimmed);
    if (!Number.isFinite(num)) {
      if (fallback !== undefined) return fallback;
      throw new XdfParseError(`could not parse number "${raw}"`);
    }
    return num;
  }

  /**
   * Parse a boolean attribute ("0"/"1", "true"/"false").
   * @param {*} raw
   * @param {boolean} fallback
   * @returns {boolean}
   */
  function parseBool(raw, fallback) {
    if (raw === null || raw === undefined) return fallback;
    const num = Number(raw);
    if (Number.isFinite(num)) return num !== 0;
    const lc = String(raw).trim().toLowerCase();
    if (lc === 'true') return true;
    if (lc === 'false') return false;
    return fallback;
  }

  /**
   * Decode a hex byte string ("DEADBEEF", whitespace allowed) into bytes.
   * @param {*} raw
   * @returns {Uint8Array}
   * @throws {XdfParseError} On an odd length or a non-hex digit.
   */
  function decodeHexBytes(raw) {
    const cleaned = String(raw).replace(/\s+/g, '');
    if (cleaned.length % 2 !== 0)
      throw new XdfParseError(`hex byte string has odd length: "${raw}"`);
    const out = new Uint8Array(cleaned.length / 2);
    for (let k = 0; k < out.length; k++) {
      const byte = parseInt(cleaned.slice(k * 2, k * 2 + 2), 16);
      if (Number.isNaN(byte))
        throw new XdfParseError(
          `invalid hex byte at position ${k * 2}: "${raw}"`
        );
      out[k] = byte;
    }
    return out;
  }

  /**
   * Text content of the first descendant with the given tag.
   * @param {XmlNode} parent
   * @param {string} tag
   * @param {string} [fallback] - Returned when the tag is absent (default '').
   * @returns {string}
   */
  function getText(parent, tag, fallback) {
    const el = parent.getElementsByTagName(tag).item(0);
    if (!el) return fallback === undefined ? '' : fallback;
    const t = el.textContent;
    return t === undefined || t === null
      ? fallback === undefined
        ? ''
        : fallback
      : t;
  }

  /**
   * Attribute value or null.
   * @param {XmlNode} el
   * @param {string} name
   * @returns {string|null}
   */
  const getAttr = (el, name) => el.getAttribute(name);

  /**
   * Optional numeric child element: undefined when absent or empty.
   * @param {XmlNode} el
   * @param {string} tag
   * @returns {number|undefined}
   */
  function optNum(el, tag) {
    const t = getText(el, tag, '');
    return t !== '' ? parseNumber(t, 0) : undefined;
  }

  /**
   * Elements of `parent` matching `tag` whose parent is `parent` itself --
   * getElementsByTagName is descendant-wide, and an axis' LABELs must not be
   * confused with a sibling axis'.
   * @param {XmlNode} parent
   * @param {string} tag
   * @returns {XmlNode[]}
   */
  function directChildren(parent, tag) {
    const out = [];
    const list = parent.getElementsByTagName(tag);
    for (let k = 0; k < list.length; k++) {
      const el = list.item(k);
      if (el && el.parentElement === parent) out.push(el);
    }
    return out;
  }

  // ==========================================================================
  // Embedded-data descriptor
  // ==========================================================================

  /**
   * Parse an <EMBEDDEDDATA> element. `el` is null for an axis with no
   * EMBEDDEDDATA (label-only): everything reads zeroes, and `addressed:false`
   * marks it as not living in the BIN.
   * @param {XmlNode|null} el
   * @param {XdfDefaults} defaults
   * @returns {XdfEmbed}
   */
  function parseEmbeddedData(el, defaults) {
    if (!el) {
      return {
        typeflags: 0,
        address: 0,
        elementsizebits: defaults.datasizeinbits,
        rowcount: 0,
        colcount: 0,
        majorstridebits: 0,
        minorstridebits: 0,
        addressed: false,
      };
    }
    return {
      addressed: true,
      typeflags: parseNumber(getAttr(el, 'mmedtypeflags'), 0),
      address: parseNumber(getAttr(el, 'mmedaddress'), 0),
      elementsizebits: parseNumber(
        getAttr(el, 'mmedelementsizebits'),
        defaults.datasizeinbits
      ),
      rowcount: parseNumber(getAttr(el, 'mmedrowcount'), 0),
      colcount: parseNumber(getAttr(el, 'mmedcolcount'), 0),
      majorstridebits: parseNumber(getAttr(el, 'mmedmajorstridebits'), 0),
      minorstridebits: parseNumber(getAttr(el, 'mmedminorstridebits'), 0),
    };
  }

  // ==========================================================================
  // .xdf structure parsing
  // ==========================================================================

  /**
   * The 0-based category indices an item belongs to (TunerPro writes them
   * 1-based), de-duplicated, direct children only.
   * @param {XmlNode} el
   * @returns {number[]}
   */
  function parseCategoryMems(el) {
    const seen = new Set();
    const out = [];
    for (const cm of directChildren(el, 'CATEGORYMEM')) {
      const oneBased = parseNumber(getAttr(cm, 'category'), 0);
      if (oneBased < 1) continue;
      const idx = oneBased - 1;
      if (seen.has(idx)) continue;
      seen.add(idx);
      out.push(idx);
    }
    return out;
  }

  /**
   * The MATH equation of an item or axis, "X" when absent or blank.
   * @param {XmlNode} parent
   * @returns {string}
   */
  function parseMathEquation(parent) {
    const math = parent.getElementsByTagName('MATH').item(0);
    if (!math) return 'X';
    const eq = math.getAttribute('equation');
    return eq && eq.trim() !== '' ? eq : 'X';
  }

  /**
   * Parse <XDFHEADER>.
   * @param {XmlNode} el
   * @returns {XdfHeader}
   */
  function parseHeader(el) {
    const baseEl = el.getElementsByTagName('BASEOFFSET').item(0);
    const baseOffset = baseEl
      ? {
          offset: parseNumber(getAttr(baseEl, 'offset'), 0),
          subtract: parseBool(getAttr(baseEl, 'subtract'), false),
        }
      : { offset: 0, subtract: false };

    const defEl = el.getElementsByTagName('DEFAULTS').item(0);
    const defaults = {
      datasizeinbits: parseNumber(defEl && getAttr(defEl, 'datasizeinbits'), 8),
      sigdigits: parseNumber(defEl && getAttr(defEl, 'sigdigits'), 2),
      outputtype: parseNumber(defEl && getAttr(defEl, 'outputtype'), 1),
      signed: parseBool(defEl && getAttr(defEl, 'signed'), false),
      lsbfirst: parseBool(defEl && getAttr(defEl, 'lsbfirst'), true),
      float: parseBool(defEl && getAttr(defEl, 'float'), false),
    };

    const regions = [];
    const regionList = el.getElementsByTagName('REGION');
    for (let k = 0; k < regionList.length; k++) {
      const rg = regionList.item(k);
      if (!rg) continue;
      regions.push({
        type: parseNumber(getAttr(rg, 'type'), 0),
        startaddress: parseNumber(getAttr(rg, 'startaddress'), 0),
        size: parseNumber(getAttr(rg, 'size'), 0),
        name: getAttr(rg, 'name') || '',
        description: getAttr(rg, 'desc') || undefined,
      });
    }

    const categories = [];
    const catList = el.getElementsByTagName('CATEGORY');
    for (let k = 0; k < catList.length; k++) {
      const c = catList.item(k);
      if (!c) continue;
      categories.push({
        index: parseNumber(getAttr(c, 'index'), 0),
        name: getAttr(c, 'name') || '',
      });
    }

    return {
      flags: parseNumber(getText(el, 'flags', '0'), 0),
      fileversion: getText(el, 'fileversion'),
      deftitle: getText(el, 'deftitle'),
      description: getText(el, 'description'),
      author: getText(el, 'author'),
      baseOffset,
      defaults,
      regions,
      categories,
    };
  }

  /**
   * The fields every item shares.
   * @param {XmlNode} el
   * @returns {Omit<XdfItemCommon, 'key'>}
   */
  function parseCommon(el) {
    return {
      uniqueid: parseNumber(getAttr(el, 'uniqueid'), 0),
      title: getText(el, 'title'),
      description: getText(el, 'description'),
      categoryIndices: parseCategoryMems(el),
    };
  }

  /**
   * Parse <XDFCONSTANT>.
   * @param {XmlNode} el
   * @param {XdfDefaults} defaults
   * @returns {XdfConstant}
   * @throws {XdfParseError} When EMBEDDEDDATA is missing.
   */
  function parseConstant(el, defaults) {
    const embedEl = el.getElementsByTagName('EMBEDDEDDATA').item(0);
    if (!embedEl) throw new XdfParseError('XDFCONSTANT missing EMBEDDEDDATA');
    const units = getText(el, 'units', '');
    const common = parseCommon(el);
    return Object.assign(common, {
      kind: 'constant',
      embed: parseEmbeddedData(embedEl, defaults),
      units: units || undefined,
      decimalpl: optNum(el, 'decimalpl'),
      rangelow: optNum(el, 'rangelow'),
      rangehigh: optNum(el, 'rangehigh'),
      datatype: optNum(el, 'datatype'),
      unittype: optNum(el, 'unittype'),
      outputtype: optNum(el, 'outputtype'),
      mathEquation: parseMathEquation(el),
    });
  }

  /**
   * Parse <XDFFLAG>.
   * @param {XmlNode} el
   * @param {XdfDefaults} defaults
   * @returns {XdfFlag}
   * @throws {XdfParseError} When EMBEDDEDDATA is missing.
   */
  function parseFlag(el, defaults) {
    const embedEl = el.getElementsByTagName('EMBEDDEDDATA').item(0);
    if (!embedEl) throw new XdfParseError('XDFFLAG missing EMBEDDEDDATA');
    const common = parseCommon(el);
    return Object.assign(common, {
      kind: 'flag',
      embed: parseEmbeddedData(embedEl, defaults),
      mask: parseNumber(getText(el, 'mask'), 0),
    });
  }

  /**
   * Parse <XDFPATCH>.
   * @param {XmlNode} el
   * @returns {XdfPatch}
   */
  function parsePatch(el) {
    const entries = [];
    const list = el.getElementsByTagName('XDFPATCHENTRY');
    for (let k = 0; k < list.length; k++) {
      const e = list.item(k);
      if (!e) continue;
      entries.push({
        name: getAttr(e, 'name') || '',
        address: parseNumber(getAttr(e, 'address'), 0),
        datasize: parseNumber(getAttr(e, 'datasize'), 0),
        patchdata: decodeHexBytes(getAttr(e, 'patchdata') || ''),
        basedata: decodeHexBytes(getAttr(e, 'basedata') || ''),
      });
    }
    const common = parseCommon(el);
    return Object.assign(common, { kind: 'patch', entries });
  }

  /**
   * Parse <XDFCHECKSUM> -- a region whose 16-bit sum is stored back into the
   * image. Older DMEs refuse to run when it disagrees, so an edited BIN must
   * have it recomputed before flashing (see checksum.js).
   * @param {XmlNode} el
   * @returns {XdfChecksum}
   */
  function parseChecksum(el) {
    const common = parseCommon(el);
    const regions = [];
    const list = el.getElementsByTagName('CHECKSUMREGION');
    for (let k = 0; k < list.length; k++) {
      const r = list.item(k);
      if (!r) continue;
      regions.push({
        datastart: parseNumber(getAttr(r, 'datastart'), 0),
        datasize: parseNumber(getAttr(r, 'datasize'), 0),
        storeaddress: parseNumber(getAttr(r, 'storeaddress'), 0),
        calctype: parseNumber(getAttr(r, 'calctype'), 0),
        regionflags: parseNumber(getAttr(r, 'regionflags'), 0),
      });
    }
    return Object.assign(common, { kind: 'checksum', regions });
  }

  /**
   * Parse one <XDFAXIS>. A label-only axis carries no EMBEDDEDDATA: its
   * scale comes from <LABEL> elements, not from the BIN. TunerPro emits these
   * routinely (in the v1.50 files we ship, only ~half the axes have an
   * EMBEDDEDDATA at all), so a missing one is an unaddressed axis rather than
   * a dead file.
   * @param {XmlNode} el
   * @param {XdfDefaults} defaults
   * @returns {XdfAxis}
   * @throws {XdfParseError} On an axis id other than x, y or z.
   */
  function parseAxis(el, defaults) {
    const embedEl = el.getElementsByTagName('EMBEDDEDDATA').item(0);
    const id = (getAttr(el, 'id') || 'x').toLowerCase();
    if (id !== 'x' && id !== 'y' && id !== 'z')
      throw new XdfParseError(`XDFAXIS has unexpected id "${id}"`);
    const labels = directChildren(el, 'LABEL').map((l) => ({
      index: parseNumber(getAttr(l, 'index'), 0),
      value: getAttr(l, 'value') || '',
    }));
    let embedInfo;
    const ei = directChildren(el, 'embedinfo')[0];
    if (ei) {
      embedInfo = {
        type: parseNumber(getAttr(ei, 'type'), 0),
        linkObjId: parseNumber(getAttr(ei, 'linkobjid'), 0),
      };
    }
    return {
      id,
      uniqueid: parseNumber(getAttr(el, 'uniqueid'), 0),
      embed: parseEmbeddedData(embedEl, defaults),
      indexcount: parseNumber(getText(el, 'indexcount', '0'), 0),
      outputtype: optNum(el, 'outputtype'),
      datatype: optNum(el, 'datatype'),
      unittype: optNum(el, 'unittype'),
      decimalpl: optNum(el, 'decimalpl'),
      units: getText(el, 'units', '') || undefined,
      min: optNum(el, 'min'),
      max: optNum(el, 'max'),
      labels,
      embedInfo,
      mathEquation: parseMathEquation(el),
    };
  }

  /**
   * Parse <XDFTABLE>: its direct XDFAXIS children.
   * @param {XmlNode} el
   * @param {XdfDefaults} defaults
   * @returns {XdfTable}
   */
  function parseTable(el, defaults) {
    const axes = directChildren(el, 'XDFAXIS').map((a) =>
      parseAxis(a, defaults)
    );
    const common = parseCommon(el);
    return Object.assign(common, { kind: 'table', axes });
  }

  /**
   * Parse a .xdf (any supported spelling) into its header and items.
   * @param {string} xml - The file text.
   * @returns {XdfFile}
   * @throws {XdfParseError} On malformed XML, a non-XDFFORMAT root, a missing
   *   header, or an encrypted file.
   */
  function parseXdf(xml) {
    XDF.mathMisses.clear(); // per-parse: the tally belongs to THIS file
    const format = XDF.detectXdfFormat(xml);
    const doc = XDF.parseXml(XDF.toV150Xml(xml));
    const rootEl = doc.documentElement;
    if (!rootEl || rootEl.tagName !== 'XDFFORMAT') {
      throw new XdfParseError(
        `expected <XDFFORMAT> root, got <${rootEl ? rootEl.tagName : 'nothing'}>`
      );
    }
    const headerEl = rootEl.getElementsByTagName('XDFHEADER').item(0);
    if (!headerEl) throw new XdfParseError('missing <XDFHEADER>');

    // Refuse encrypted files up front -- items below would be AES garbage.
    const openPw = getText(headerEl, 'openpassword', '');
    const modifyPw = getText(headerEl, 'modifypassword', '');
    if (openPw !== '' || modifyPw !== '') {
      throw new XdfParseError(
        "encrypted .xdf -- this file uses TunerPro's openpassword/modifypassword " +
          'encryption, which this tool cannot decrypt. Ask the author for an ' +
          'unencrypted copy.'
      );
    }

    const header = parseHeader(headerEl);
    const items = [];
    for (let k = 0; k < rootEl.children.length; k++) {
      const child = rootEl.children.item(k);
      if (!child) continue;
      switch (child.tagName) {
        case 'XDFHEADER':
          break;
        case 'XDFCONSTANT':
          items.push(parseConstant(child, header.defaults));
          break;
        case 'XDFCHECKSUM':
          items.push(parseChecksum(child));
          break;
        case 'XDFFLAG':
          items.push(parseFlag(child, header.defaults));
          break;
        case 'XDFPATCH':
          items.push(parsePatch(child));
          break;
        case 'XDFTABLE':
          items.push(parseTable(child, header.defaults));
          break;
        default:
          break; // tolerate unknown children
      }
    }
    // A STABLE PER-ITEM KEY. TunerPro's `uniqueid` is optional and real files
    // routinely ship every item as uniqueid="0x0" -- the MS45.1 457LO02S
    // definition does exactly that for all 5,705 items. The UI keys row
    // selection off it, so without a fallback, selecting one row selects them
    // all. `key` is the item's index in document order: stable for a given
    // file, and unique by construction. uniqueid is left untouched for anyone
    // who needs the raw value.
    items.forEach((it, i) => {
      it.key = `${i}:${it.uniqueid}`;
    });

    // What we could not compile. This counts equations seen DURING the parse;
    // decode-time failures (a table's MATH is compiled lazily, when it is
    // first decoded) accumulate in `mathMisses` too, so read that after
    // decoding rather than treating the parse-time list as final.
    const mathFailures = XDF.mathMissReport();
    return { header, items, mathFailures, mathMisses: XDF.mathMisses, format };
  }

  Object.assign(XDF, { parseXdf, decodeHexBytes });

  // The namespace is complete once this piece has run.
  if (typeof module !== 'undefined' && module.exports) module.exports = XDF;
})(typeof window !== 'undefined' ? window : this);
