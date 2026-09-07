/**
 * @file XDF engine, piece 1 of 6: the minimal XML parser and the parse error.
 *
 * The browser ships DOMParser and node does not; rather than branch (and to
 * keep the tools/verify tests exercising the SHIPPED code path), .xdf XML is
 * parsed here. .xdf files are plain, namespace-free XML with attributes and
 * text, so a recursive-descent tokenizer covers them. It produces a DOM-ish
 * tree with just the surface the structure parser (parser.js) touches.
 *
 * Every core/xdf/ piece is an IIFE that adds to the shared `window.XDF`
 * namespace, so the whole engine stays dependency-free and runs identically
 * in the browser and in node (tools/verify/test_xdf.js evaluates the pieces
 * in index.html order into one `window` object). Load order: xml, math,
 * codec, legacy, checksum, parser.
 */

(function (root) {
  'use strict';

  const XDF = root.XDF || (root.XDF = {});

  /**
   * Error raised for a malformed, unsupported or encrypted .xdf. Callers show
   * the message in the definition pane rather than crashing.
   */
  class XdfParseError extends Error {
    /**
     * @param {string} message - Plain-English reason the file was refused.
     */
    constructor(message) {
      super(message);
      this.name = 'XdfParseError';
    }
  }

  /**
   * One element of the parsed tree. Mirrors the subset of the DOM Element
   * surface the structure parser uses: attributes, element children, direct
   * text, and a document-order tag search.
   * @constructor
   * @param {string} tagName - Element name as written in the file.
   */
  function XmlNode(tagName) {
    this.tagName = tagName;
    this.attributes = Object.create(null);
    /** @type {XmlNode[]} element children only */
    this.childNodes = [];
    /** @type {XmlNode|null} */
    this.parentElement = null;
    /** direct text content of this element (descendants excluded) */
    this._text = '';
  }

  /**
   * Attribute value by name, or null when absent (DOM semantics).
   * @param {string} name - Attribute name.
   * @returns {string|null}
   */
  XmlNode.prototype.getAttribute = function (name) {
    const v = this.attributes[name];
    return v === undefined ? null : v;
  };

  /**
   * All descendant elements (self excluded) with the given tag, in document
   * order. '*' matches every element. The array carries an `item(i)` method
   * so callers can use the DOM idiom.
   * @param {string} tag - Tag name, or '*'.
   * @returns {XmlNode[] & { item: (i: number) => XmlNode|null }}
   */
  XmlNode.prototype.getElementsByTagName = function (tag) {
    /** @type {any} */
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
      /** @type {any} */
      const a = this.childNodes.slice();
      a.item = (i) => a[i] || null;
      return a;
    },
  });

  /**
   * Replace XML character and numeric entities with the characters they
   * stand for. Unknown named entities are left as written.
   * @param {string} s - Raw attribute or text content.
   * @returns {string}
   */
  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, ent) => {
      if (ent[0] === '#') {
        const code =
          ent[1] === 'x' || ent[1] === 'X'
            ? parseInt(ent.slice(2), 16)
            : parseInt(ent.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      switch (ent) {
        case 'amp':
          return '&';
        case 'lt':
          return '<';
        case 'gt':
          return '>';
        case 'quot':
          return '"';
        case 'apos':
          return "'";
        default:
          return m;
      }
    });
  }

  /**
   * @typedef {Object} XmlDocument
   * @property {XmlNode|null} documentElement - The root element.
   * @property {(tag: string) => XmlNode[]} getElementsByTagName - Document-wide tag search.
   */

  /**
   * Parse an XML string into an XmlNode tree. Comments, CDATA (as text),
   * processing instructions and doctypes are handled; the grammar is the plain
   * subset TunerPro emits.
   * @param {string} xml - The document text.
   * @returns {XmlDocument}
   * @throws {XdfParseError} On an unterminated, unexpected or mismatched tag.
   */
  function parseXml(xml) {
    const doc = { documentElement: null, getElementsByTagName: null };
    const rootNode = new XmlNode('#document');
    let cur = rootNode;
    let i = 0;
    const n = xml.length;

    while (i < n) {
      const lt = xml.indexOf('<', i);
      if (lt === -1) {
        cur._text += decodeEntities(xml.slice(i));
        break;
      }
      if (lt > i) {
        // text between tags -> attach to the current element
        const txt = xml.slice(i, lt);
        if (cur !== rootNode) cur._text += decodeEntities(txt);
      }
      // dispatch on what follows '<'
      if (xml.startsWith('<!--', lt)) {
        const end = xml.indexOf('-->', lt + 4);
        i = end === -1 ? n : end + 3;
        continue;
      }
      if (xml.startsWith('<![CDATA[', lt)) {
        const end = xml.indexOf(']]>', lt + 9);
        const data = xml.slice(lt + 9, end === -1 ? n : end);
        if (cur !== rootNode) cur._text += data;
        i = end === -1 ? n : end + 3;
        continue;
      }
      if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
        // processing instruction / doctype
        const end = xml.indexOf('>', lt + 2);
        i = end === -1 ? n : end + 1;
        continue;
      }
      const gt = xml.indexOf('>', lt);
      if (gt === -1) {
        throw new XdfParseError('malformed XML: unterminated tag');
      }
      let raw = xml.slice(lt + 1, gt);

      if (raw[0] === '/') {
        // closing tag
        const name = raw.slice(1).trim();
        if (cur === rootNode) throw new XdfParseError(`unexpected </${name}>`);
        if (cur.tagName !== name) {
          throw new XdfParseError(
            `mismatched tag: </${name}> closing <${cur.tagName}>`
          );
        }
        cur = cur.parentElement || rootNode;
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
          const val =
            m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
          el.attributes[m[1]] = decodeEntities(val);
        }
      }
      el.parentElement = cur === rootNode ? null : cur;
      cur.childNodes.push(el);
      if (!selfClose) cur = el;
      i = gt + 1;
    }

    doc.documentElement = rootNode.childNodes[0] || null;
    doc.getElementsByTagName = (tag) => rootNode.getElementsByTagName(tag);
    return doc;
  }

  Object.assign(XDF, { parseXml, XdfParseError });
})(typeof window !== 'undefined' ? window : this);
