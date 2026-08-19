// xdf: a TunerPro .xdf definition parser + the raw<->engineering codec the
// Tuning screen (screens/tuning.js) uses to read and write firmware constants,
// flags and tables. Dependency-free so it runs identically in the browser
// and in node (tools/verify).
//
// Pure, offline, no hardware. Everything operates on a Uint8Array firmware
// image already held client-side.
//
// A .xdf is TunerPro's XML describing where each tunable lives in the BIN:
//   - XDFCONSTANT : a scalar at mmedaddress, sized mmedelementsizebits,
//                   displayed through a MATH equation ("0.75*X-48").
//   - XDFFLAG     : a single bit (mask) inside one byte.
//   - XDFTABLE    : an X/Y/Z grid; the Z axis holds the editable cells, X/Y
//                   are the (often shared) axis scales.
//   - XDFPATCH    : a set of byte blobs (patchdata) vs stock (basedata).
//
// Type-flag bit layout (mmedtypeflags):
//   bit 0 (0x01) = signed   bit 1 (0x02) = lsbfirst (LE)   bit 2 (0x04) = float
// When typeflags is 0 the file <DEFAULTS> supply the flags instead.

(function (root) {
  'use strict';

  // ==========================================================================
  // Minimal XML parser
  // --------------------------------------------------------------------------
  // The browser ships DOMParser and node does not; rather than branch (and to
  // keep the tools/verify tests exercising the SHIPPED code path), parse XML
  // ourselves. .xdf files are plain, namespace-free XML with attributes and
  // text -- a recursive-descent tokenizer covers them. Produces a DOM-ish tree
  // with just the surface the parser below touches.
  // ==========================================================================

  function XmlNode(tagName) {
    this.tagName = tagName;
    this.attributes = Object.create(null);
    this.childNodes = [];          // element children only
    this.parentElement = null;
    this._text = '';               // direct text content of this element
  }
  XmlNode.prototype.getAttribute = function (name) {
    const v = this.attributes[name];
    return v === undefined ? null : v;
  };
  // all descendant elements (self excluded) with the given tag, document order
  XmlNode.prototype.getElementsByTagName = function (tag) {
    const out = [];
    const walk = (node) => {
      for (const c of node.childNodes) {
        if (tag === '*' || c.tagName === tag) out.push(c);
        walk(c);
      }
    };
    walk(this);
    out.item = (i) => out[i] || null;
    return out;
  };
  // textContent: this node's text plus all descendants', in order
  Object.defineProperty(XmlNode.prototype, 'textContent', {
    get() {
      let s = this._text;
      for (const c of this.childNodes) s += c.textContent;
      return s;
    },
  });
  // children: array-like of element children with .item()/.length
  Object.defineProperty(XmlNode.prototype, 'children', {
    get() {
      const a = this.childNodes.slice();
      a.item = (i) => a[i] || null;
      return a;
    },
  });

  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, ent) => {
      if (ent[0] === '#') {
        const code = ent[1] === 'x' || ent[1] === 'X'
          ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      switch (ent) {
        case 'amp': return '&';
        case 'lt': return '<';
        case 'gt': return '>';
        case 'quot': return '"';
        case 'apos': return "'";
        default: return m;
      }
    });
  }

  function parseXml(xml) {
    const doc = { documentElement: null, getElementsByTagName: null };
    const root = new XmlNode('#document');
    let cur = root;
    let i = 0;
    const n = xml.length;

    while (i < n) {
      const lt = xml.indexOf('<', i);
      if (lt === -1) { cur._text += decodeEntities(xml.slice(i)); break; }
      if (lt > i) {
        // text between tags -> attach to the current element
        const txt = xml.slice(i, lt);
        if (cur !== root) cur._text += decodeEntities(txt);
      }
      // dispatch on what follows '<'
      if (xml.startsWith('<!--', lt)) {                       // comment
        const end = xml.indexOf('-->', lt + 4);
        i = end === -1 ? n : end + 3;
        continue;
      }
      if (xml.startsWith('<![CDATA[', lt)) {                  // CDATA
        const end = xml.indexOf(']]>', lt + 9);
        const data = xml.slice(lt + 9, end === -1 ? n : end);
        if (cur !== root) cur._text += data;
        i = end === -1 ? n : end + 3;
        continue;
      }
      if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) { // PI / doctype
        const end = xml.indexOf('>', lt + 2);
        i = end === -1 ? n : end + 1;
        continue;
      }
      const gt = xml.indexOf('>', lt);
      if (gt === -1) { throw new XdfParseError('malformed XML: unterminated tag'); }
      let raw = xml.slice(lt + 1, gt);

      if (raw[0] === '/') {                                   // closing tag
        const name = raw.slice(1).trim();
        if (cur === root) throw new XdfParseError(`unexpected </${name}>`);
        if (cur.tagName !== name) {
          throw new XdfParseError(`mismatched tag: </${name}> closing <${cur.tagName}>`);
        }
        cur = cur.parentElement || root;
        i = gt + 1;
        continue;
      }

      const selfClose = raw.endsWith('/');
      if (selfClose) raw = raw.slice(0, -1);

      // tag name then attributes
      const sp = raw.search(/\s/);
      const tagName = (sp === -1 ? raw : raw.slice(0, sp)).trim();
      const el = new XmlNode(tagName);
      if (sp !== -1) {
        const attrStr = raw.slice(sp);
        const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
        let m;
        while ((m = re.exec(attrStr))) {
          const val = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : '');
          el.attributes[m[1]] = decodeEntities(val);
        }
      }
      el.parentElement = cur === root ? null : cur;
      cur.childNodes.push(el);
      if (!selfClose) cur = el;
      i = gt + 1;
    }

    doc.documentElement = root.childNodes[0] || null;
    doc.getElementsByTagName = (tag) => root.getElementsByTagName(tag);
    return doc;
  }

  // ==========================================================================
  // MATH expression parser + linear inverse
  // --------------------------------------------------------------------------
  // TunerPro MATH is strictly arithmetic: term (('+'|'-') term)*, term is
  // factor (('*'|'/') factor)*, factor is -factor | (expr) | NUMBER | IDENT.
  // Real samples: "X", "0.75*X-48.0", "X*0.01", "X-100".
  // ==========================================================================

  class MathParseError extends Error {
    constructor(message, source, position) {
      super(`${message} at position ${position} of "${source}"`);
      this.name = 'MathParseError';
      this.source = source;
      this.position = position;
    }
  }

  function parseMath(src) {
    let pos = 0;
    const skipWs = () => { while (pos < src.length && /\s/.test(src[pos])) pos++; };

    function parseNumber() {
      const start = pos;
      while (pos < src.length && /[0-9.]/.test(src[pos])) pos++;
      if (pos < src.length && (src[pos] === 'e' || src[pos] === 'E')) {
        pos++;
        if (src[pos] === '+' || src[pos] === '-') pos++;
        while (pos < src.length && /[0-9]/.test(src[pos])) pos++;
      }
      const text = src.slice(start, pos);
      const value = Number(text);
      if (!Number.isFinite(value)) throw new MathParseError(`Invalid number "${text}"`, src, start);
      return { kind: 'num', value };
    }
    function parseIdent() {
      const start = pos;
      while (pos < src.length && /[A-Za-z0-9_]/.test(src[pos])) pos++;
      return { kind: 'var', name: src.slice(start, pos).toUpperCase() };
    }
    function parseFactor() {
      skipWs();
      const ch = src[pos];
      if (ch === undefined) throw new MathParseError('Unexpected end of expression', src, pos);
      if (ch === '-') { pos++; return { kind: 'neg', arg: parseFactor() }; }
      if (ch === '+') { pos++; return parseFactor(); }
      if (ch === '(') {
        pos++;
        const inner = parseExpr();
        skipWs();
        if (src[pos] !== ')') throw new MathParseError("Expected ')'", src, pos);
        pos++;
        return inner;
      }
      if (/[0-9.]/.test(ch)) return parseNumber();
      if (/[A-Za-z_]/.test(ch)) return parseIdent();
      throw new MathParseError(`Unexpected "${ch}"`, src, pos);
    }
    function parseTerm() {
      let left = parseFactor();
      for (;;) {
        skipWs();
        const ch = src[pos];
        if (ch !== '*' && ch !== '/') return left;
        pos++;
        left = { kind: 'binop', op: ch, left, right: parseFactor() };
      }
    }
    function parseExpr() {
      let left = parseTerm();
      for (;;) {
        skipWs();
        const ch = src[pos];
        if (ch !== '+' && ch !== '-') return left;
        pos++;
        left = { kind: 'binop', op: ch, left, right: parseTerm() };
      }
    }
    const expr = parseExpr();
    skipWs();
    if (pos < src.length) throw new MathParseError(`Unexpected "${src[pos]}"`, src, pos);
    return expr;
  }

  function evalMath(expr, vars) {
    switch (expr.kind) {
      case 'num': return expr.value;
      case 'var': {
        const v = vars[expr.name];
        if (typeof v !== 'number') throw new Error(`Unbound variable "${expr.name}"`);
        return v;
      }
      case 'neg': return -evalMath(expr.arg, vars);
      case 'binop': {
        const l = evalMath(expr.left, vars), r = evalMath(expr.right, vars);
        switch (expr.op) {
          case '+': return l + r;
          case '-': return l - r;
          case '*': return l * r;
          case '/': return l / r;
        }
      }
    }
    throw new Error('bad expr node');
  }

  function compileMath(src, varName) {
    varName = (varName || 'X').toUpperCase();
    const ast = parseMath(src);
    return (x) => evalMath(ast, { [varName]: x });
  }

  // Detect linear form aX + b. Returns { a, b } or null when non-linear.
  function linearize(expr, varName) {
    const v = (varName || 'X').toUpperCase();
    switch (expr.kind) {
      case 'num': return { a: 0, b: expr.value };
      case 'var': return expr.name === v ? { a: 1, b: 0 } : null;
      case 'neg': {
        const inner = linearize(expr.arg, v);
        if (!inner) return null;
        return { a: inner.a === 0 ? 0 : -inner.a, b: inner.b === 0 ? 0 : -inner.b };
      }
      case 'binop': {
        const l = linearize(expr.left, v), r = linearize(expr.right, v);
        if (!l || !r) return null;
        switch (expr.op) {
          case '+': return { a: l.a + r.a, b: l.b + r.b };
          case '-': return { a: l.a - r.a, b: l.b - r.b };
          case '*':
            if (l.a === 0) return { a: l.b * r.a, b: l.b * r.b };
            if (r.a === 0) return { a: r.b * l.a, b: r.b * l.b };
            return null;
          case '/':
            if (r.a !== 0) return null;
            if (r.b === 0) return null;
            return { a: l.a / r.b, b: l.b / r.b };
        }
      }
    }
    return null;
  }

  // Build the inverse (engineering -> raw) for a linear MATH string. null when
  // not invertible (non-linear, or constant with no X dependence).
  function invertLinear(src, varName) {
    const lin = linearize(parseMath(src), varName);
    if (!lin || lin.a === 0) return null;
    const { a, b } = lin;
    return (y) => (y - b) / a;
  }

  // ==========================================================================
  // Number / bytes helpers
  // ==========================================================================

  class XdfParseError extends Error {
    constructor(message) { super(message); this.name = 'XdfParseError'; }
  }

  // TunerPro numeric attributes come as decimal OR "0x.." hex, freely mixed.
  function parseNumber(raw, fallback) {
    if (raw === null || raw === undefined || raw === '') {
      if (fallback !== undefined) return fallback;
      throw new XdfParseError('missing numeric value');
    }
    const trimmed = String(raw).trim();
    const isHex = /^-?0x/i.test(trimmed);
    const num = isHex
      ? parseInt(trimmed.replace(/^-?0x/i, ''), 16) * (trimmed.startsWith('-') ? -1 : 1)
      : Number(trimmed);
    if (!Number.isFinite(num)) {
      if (fallback !== undefined) return fallback;
      throw new XdfParseError(`could not parse number "${raw}"`);
    }
    return num;
  }

  function parseBool(raw, fallback) {
    if (raw === null || raw === undefined) return fallback;
    const num = Number(raw);
    if (Number.isFinite(num)) return num !== 0;
    const lc = String(raw).trim().toLowerCase();
    if (lc === 'true') return true;
    if (lc === 'false') return false;
    return fallback;
  }

  function decodeHexBytes(raw) {
    const cleaned = String(raw).replace(/\s+/g, '');
    if (cleaned.length % 2 !== 0) throw new XdfParseError(`hex byte string has odd length: "${raw}"`);
    const out = new Uint8Array(cleaned.length / 2);
    for (let k = 0; k < out.length; k++) {
      const byte = parseInt(cleaned.slice(k * 2, k * 2 + 2), 16);
      if (Number.isNaN(byte)) throw new XdfParseError(`invalid hex byte at position ${k * 2}: "${raw}"`);
      out[k] = byte;
    }
    return out;
  }

  function getText(parent, tag, fallback) {
    const el = parent.getElementsByTagName(tag).item(0);
    if (!el) return fallback === undefined ? '' : fallback;
    const t = el.textContent;
    return t === undefined || t === null ? (fallback === undefined ? '' : fallback) : t;
  }
  const getAttr = (el, name) => el.getAttribute(name);

  // ==========================================================================
  // Embedded-data descriptor -> effective read/write parameters
  // ==========================================================================

  const FLAG_SIGNED = 0x01;
  const FLAG_LSBFIRST = 0x02;
  const FLAG_FLOAT = 0x04;

  function parseEmbeddedData(el, defaults) {
    return {
      typeflags: parseNumber(getAttr(el, 'mmedtypeflags'), 0),
      address: parseNumber(getAttr(el, 'mmedaddress'), 0),
      elementsizebits: parseNumber(getAttr(el, 'mmedelementsizebits'), defaults.datasizeinbits),
      rowcount: parseNumber(getAttr(el, 'mmedrowcount'), 0),
      colcount: parseNumber(getAttr(el, 'mmedcolcount'), 0),
      majorstridebits: parseNumber(getAttr(el, 'mmedmajorstridebits'), 0),
      minorstridebits: parseNumber(getAttr(el, 'mmedminorstridebits'), 0),
    };
  }

  function resolveAddress(raw, base) {
    return base.subtract ? raw - base.offset : raw + base.offset;
  }

  // Resolve EMBEDDEDDATA + BASEOFFSET + DEFAULTS into concrete params. When
  // typeflags is 0, DEFAULTS win for the three flag bits; otherwise the bits do.
  function resolveEmbedded(embed, base, defaults) {
    const flags = embed.typeflags;
    const useFlags = flags !== 0;
    return {
      signed: useFlags ? (flags & FLAG_SIGNED) !== 0 : defaults.signed,
      lsbfirst: useFlags ? (flags & FLAG_LSBFIRST) !== 0 : defaults.lsbfirst,
      float: useFlags ? (flags & FLAG_FLOAT) !== 0 : defaults.float,
      sizeBits: embed.elementsizebits > 0 ? embed.elementsizebits : defaults.datasizeinbits,
      address: resolveAddress(embed.address, base),
    };
  }

  // Read a raw scalar from buffer per spec. null when out of range or an
  // unsupported width, so the UI shows "-" instead of crashing.
  function readScalar(buffer, spec) {
    const bytes = Math.max(1, Math.ceil(spec.sizeBits / 8));
    if (spec.address < 0 || spec.address + bytes > buffer.length) return null;
    const view = new DataView(buffer.buffer, buffer.byteOffset + spec.address, bytes);
    const le = spec.lsbfirst;
    if (spec.float) {
      if (bytes === 4) return view.getFloat32(0, le);
      if (bytes === 8) return view.getFloat64(0, le);
      return null;
    }
    switch (bytes) {
      case 1: return spec.signed ? view.getInt8(0) : view.getUint8(0);
      case 2: return spec.signed ? view.getInt16(0, le) : view.getUint16(0, le);
      case 4: return spec.signed ? view.getInt32(0, le) : view.getUint32(0, le);
      case 8: {
        const big = spec.signed ? view.getBigInt64(0, le) : view.getBigUint64(0, le);
        return Number(big);
      }
      default: return null;
    }
  }

  // Encode a raw scalar into a fresh Uint8Array. null when it can't fit.
  function encodeScalar(value, spec) {
    const bytes = Math.max(1, Math.ceil(spec.sizeBits / 8));
    const buf = new ArrayBuffer(bytes);
    const view = new DataView(buf);
    const le = spec.lsbfirst;
    if (spec.float) {
      if (!Number.isFinite(value)) return null;
      if (bytes === 4) view.setFloat32(0, value, le);
      else if (bytes === 8) view.setFloat64(0, value, le);
      else return null;
      return new Uint8Array(buf);
    }
    if (!Number.isFinite(value)) return null;
    const intVal = Math.trunc(value);
    const ranges = {
      1: spec.signed ? { lo: -0x80, hi: 0x7f } : { lo: 0, hi: 0xff },
      2: spec.signed ? { lo: -0x8000, hi: 0x7fff } : { lo: 0, hi: 0xffff },
      4: spec.signed ? { lo: -0x80000000, hi: 0x7fffffff } : { lo: 0, hi: 0xffffffff },
    };
    const r = ranges[bytes];
    if (r && (intVal < r.lo || intVal > r.hi)) return null;
    switch (bytes) {
      case 1: spec.signed ? view.setInt8(0, intVal) : view.setUint8(0, intVal); break;
      case 2: spec.signed ? view.setInt16(0, intVal, le) : view.setUint16(0, intVal, le); break;
      case 4: spec.signed ? view.setInt32(0, intVal, le) : view.setUint32(0, intVal, le); break;
      case 8: {
        const big = BigInt(intVal);
        spec.signed ? view.setBigInt64(0, big, le) : view.setBigUint64(0, big, le);
        break;
      }
      default: return null;
    }
    return new Uint8Array(buf);
  }

  function readFlag(buffer, address, mask) {
    if (address < 0 || address >= buffer.length) return null;
    return (buffer[address] & mask) !== 0;
  }
  function applyFlag(byte, mask, on) {
    return on ? (byte | mask) & 0xff : (byte & ~mask) & 0xff;
  }

  // Byte offset of table cell (row, col) within a Z embed, per the .xdf stride
  // convention. null when the cell isn't byte-aligned.
  function tableCellAddress(embed, row, col) {
    const ele = embed.elementsizebits;
    if (ele <= 0) return null;
    const cols = Math.max(1, embed.colcount);
    const withinRow = embed.majorstridebits !== 0 ? embed.majorstridebits : ele;
    const tail = embed.minorstridebits !== 0 ? embed.minorstridebits : ele;
    const rowPitchBits = tail + (cols - 1) * withinRow;
    const cellBits = row * rowPitchBits + col * withinRow;
    if (cellBits % 8 !== 0) return null;
    return embed.address + cellBits / 8;
  }

  function patchEntryState(buffer, address, patchdata, basedata) {
    if (address < 0 || address + patchdata.length > buffer.length) return 'neither';
    let matchesPatch = true;
    for (let k = 0; k < patchdata.length; k++) {
      if (buffer[address + k] !== patchdata[k]) { matchesPatch = false; break; }
    }
    if (matchesPatch) return 'applied';
    if (basedata.length === patchdata.length && basedata.length > 0) {
      let matchesBase = true;
      for (let k = 0; k < basedata.length; k++) {
        if (buffer[address + k] !== basedata[k]) { matchesBase = false; break; }
      }
      if (matchesBase) return 'virgin';
    }
    return 'neither';
  }

  // ==========================================================================
  // .xdf structure parsing
  // ==========================================================================

  function parseCategoryMems(el) {
    const seen = new Set();
    const out = [];
    const list = el.getElementsByTagName('CATEGORYMEM');
    for (let k = 0; k < list.length; k++) {
      const cm = list.item(k);
      if (!cm || cm.parentElement !== el) continue;
      const oneBased = parseNumber(getAttr(cm, 'category'), 0);
      if (oneBased < 1) continue;
      const idx = oneBased - 1;            // TunerPro categories are 1-based
      if (seen.has(idx)) continue;
      seen.add(idx);
      out.push(idx);
    }
    return out;
  }

  function parseMathEquation(parent) {
    const math = parent.getElementsByTagName('MATH').item(0);
    if (!math) return 'X';
    const eq = math.getAttribute('equation');
    return eq && eq.trim() !== '' ? eq : 'X';
  }

  function parseHeader(el) {
    const baseEl = el.getElementsByTagName('BASEOFFSET').item(0);
    const baseOffset = baseEl
      ? { offset: parseNumber(getAttr(baseEl, 'offset'), 0), subtract: parseBool(getAttr(baseEl, 'subtract'), false) }
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
      categories.push({ index: parseNumber(getAttr(c, 'index'), 0), name: getAttr(c, 'name') || '' });
    }

    return {
      flags: parseNumber(getText(el, 'flags', '0'), 0),
      fileversion: getText(el, 'fileversion'),
      deftitle: getText(el, 'deftitle'),
      description: getText(el, 'description'),
      author: getText(el, 'author'),
      baseOffset, defaults, regions, categories,
    };
  }

  function parseCommon(el) {
    return {
      uniqueid: parseNumber(getAttr(el, 'uniqueid'), 0),
      title: getText(el, 'title'),
      description: getText(el, 'description'),
      categoryIndices: parseCategoryMems(el),
    };
  }

  function optNum(el, tag) {
    const t = getText(el, tag, '');
    return t !== '' ? parseNumber(t, 0) : undefined;
  }

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

  function parseAxis(el, defaults) {
    const embedEl = el.getElementsByTagName('EMBEDDEDDATA').item(0);
    if (!embedEl) throw new XdfParseError(`XDFAXIS id="${getAttr(el, 'id')}" missing EMBEDDEDDATA`);
    const id = (getAttr(el, 'id') || 'x').toLowerCase();
    if (id !== 'x' && id !== 'y' && id !== 'z') throw new XdfParseError(`XDFAXIS has unexpected id "${id}"`);
    const labels = [];
    const labelList = el.getElementsByTagName('LABEL');
    for (let k = 0; k < labelList.length; k++) {
      const l = labelList.item(k);
      if (!l || l.parentElement !== el) continue;
      labels.push({ index: parseNumber(getAttr(l, 'index'), 0), value: getAttr(l, 'value') || '' });
    }
    let embedInfo;
    const embedInfoList = el.getElementsByTagName('embedinfo');
    for (let k = 0; k < embedInfoList.length; k++) {
      const ei = embedInfoList.item(k);
      if (!ei || ei.parentElement !== el) continue;
      embedInfo = { type: parseNumber(getAttr(ei, 'type'), 0), linkObjId: parseNumber(getAttr(ei, 'linkobjid'), 0) };
      break;
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
      labels, embedInfo,
      mathEquation: parseMathEquation(el),
    };
  }

  function parseTable(el, defaults) {
    const axes = [];
    const list = el.getElementsByTagName('XDFAXIS');
    for (let k = 0; k < list.length; k++) {
      const a = list.item(k);
      if (!a || a.parentElement !== el) continue;
      axes.push(parseAxis(a, defaults));
    }
    const common = parseCommon(el);
    return Object.assign(common, { kind: 'table', axes });
  }

  // Parse a .xdf XML string into { header, items }.
  function parseXdf(xml) {
    const doc = parseXml(xml);
    const root = doc.documentElement;
    if (!root || root.tagName !== 'XDFFORMAT') {
      throw new XdfParseError(`expected <XDFFORMAT> root, got <${root ? root.tagName : 'nothing'}>`);
    }
    const headerEl = root.getElementsByTagName('XDFHEADER').item(0);
    if (!headerEl) throw new XdfParseError('missing <XDFHEADER>');

    // Refuse encrypted files up front -- items below would be AES garbage.
    const openPw = getText(headerEl, 'openpassword', '');
    const modifyPw = getText(headerEl, 'modifypassword', '');
    if (openPw !== '' || modifyPw !== '') {
      throw new XdfParseError(
        "encrypted .xdf -- this file uses TunerPro's openpassword/modifypassword "
        + 'encryption, which this tool cannot decrypt. Ask the author for an '
        + 'unencrypted copy.');
    }

    const header = parseHeader(headerEl);
    const items = [];
    for (let k = 0; k < root.children.length; k++) {
      const child = root.children.item(k);
      if (!child) continue;
      switch (child.tagName) {
        case 'XDFHEADER': break;
        case 'XDFCONSTANT': items.push(parseConstant(child, header.defaults)); break;
        case 'XDFFLAG': items.push(parseFlag(child, header.defaults)); break;
        case 'XDFPATCH': items.push(parsePatch(child)); break;
        case 'XDFTABLE': items.push(parseTable(child, header.defaults)); break;
        default: break;                    // tolerate unknown children
      }
    }
    return { header, items };
  }

  // ==========================================================================
  // High-level convenience: decode/encode an item's DISPLAY value (raw run
  // through / inverted through its MATH). The Tuning screen leans on these so
  // it never re-implements the raw<->engineering step per widget.
  // ==========================================================================

  // Constant/axis scalar -> engineering value (number) or null.
  function decodeConstant(item, buffer, header) {
    const spec = resolveEmbedded(item.embed, header.baseOffset, header.defaults);
    const raw = readScalar(buffer, spec);
    if (raw === null) return null;
    try { return compileMath(item.mathEquation)(raw); }
    catch (e) { return raw; }              // unparseable MATH -> show raw
  }

  // Engineering value -> the bytes to write, plus the absolute address, or null
  // when the MATH isn't invertible or the value won't fit. Does NOT mutate the
  // buffer -- the caller splices the returned bytes in (so edits stay undoable).
  function encodeConstant(item, engValue, header) {
    const spec = resolveEmbedded(item.embed, header.baseOffset, header.defaults);
    const inv = invertLinear(item.mathEquation);
    if (!inv) return null;
    const raw = Math.round(inv(engValue));
    const bytes = encodeScalar(raw, spec);
    if (!bytes) return null;
    return { address: spec.address, bytes, raw };
  }

  // Table geometry + decoded cells. rows/cols come from the Z axis embed
  // (falling back to the axis indexcounts). Each cell is the engineering value.
  function decodeTable(table, buffer, header) {
    const z = table.axes.find((a) => a.id === 'z');
    const x = table.axes.find((a) => a.id === 'x');
    const y = table.axes.find((a) => a.id === 'y');
    if (!z) return null;
    const embed = z.embed;
    let rows = embed.rowcount || (y ? y.indexcount : 0) || 1;
    let cols = embed.colcount || (x ? x.indexcount : 0) || 1;
    if (rows < 1) rows = 1;
    if (cols < 1) cols = 1;
    const spec = resolveEmbedded(embed, header.baseOffset, header.defaults);
    let convert;
    try { convert = compileMath(z.mathEquation); } catch (e) { convert = (v) => v; }
    const cells = [];
    for (let r = 0; r < rows; r++) {
      const rowArr = [];
      for (let c = 0; c < cols; c++) {
        const addr = tableCellAddress(embed, r, c);
        let val = null;
        if (addr !== null) {
          const cellSpec = { signed: spec.signed, lsbfirst: spec.lsbfirst, float: spec.float, sizeBits: spec.sizeBits, address: addr };
          const raw = readScalar(buffer, cellSpec);
          if (raw !== null) val = convert(raw);
        }
        rowArr.push(val);
      }
      cells.push(rowArr);
    }
    return { rows, cols, cells, z, x, y, spec, embed };
  }

  // Encode one table cell's engineering value -> { address, bytes } or null.
  function encodeTableCell(table, header, row, col, engValue) {
    const z = table.axes.find((a) => a.id === 'z');
    if (!z) return null;
    const embed = z.embed;
    const spec = resolveEmbedded(embed, header.baseOffset, header.defaults);
    const addr = tableCellAddress(embed, row, col);
    if (addr === null) return null;
    const inv = invertLinear(z.mathEquation);
    if (!inv) return null;
    const raw = Math.round(inv(engValue));
    const cellSpec = { signed: spec.signed, lsbfirst: spec.lsbfirst, float: spec.float, sizeBits: spec.sizeBits, address: addr };
    const bytes = encodeScalar(raw, cellSpec);
    if (!bytes) return null;
    return { address: addr, bytes, raw };
  }

  // ==========================================================================
  // exports (browser global, matching app/renderer/core/*.js style)
  // ==========================================================================
  const api = {
    // parsing
    parseXdf, parseXml, resolveAddress,
    // math
    parseMath, evalMath, compileMath, linearize, invertLinear,
    // codec (low level)
    resolveEmbedded, readScalar, encodeScalar, readFlag, applyFlag,
    tableCellAddress, patchEntryState, decodeHexBytes,
    // codec (high level)
    decodeConstant, encodeConstant, decodeTable, encodeTableCell,
    // errors
    XdfParseError, MathParseError,
  };
  root.XDF = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
