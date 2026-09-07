/**
 * @file XDF engine, piece 4 of 6: legacy format upconverters.
 *
 * TunerPro has shipped three .xdf spellings. Rather than teach the parser
 * three dialects, the two older ones are rewritten into the v1.50 XML the
 * parser already handles, so every downstream consumer (decode, encode, the
 * Tuning screen) sees one shape.
 *
 *   flat text v1.1 -- pre-XML, line oriented. Dominant for pre-1996
 *                     Motronic (M20/M30/S14/M50).
 *   XDF XML v0.50  -- XML, but predates <EMBEDDEDDATA>: an axis carries
 *                     <address>/<indexsizebits> as child elements.
 *   XDF XML v1.50  -- current; parsed directly.
 *
 * Adds to the shared `window.XDF` namespace; see xml.js for the load order.
 */

(function (root) {
  'use strict';

  const XDF = root.XDF || (root.XDF = {});

  /**
   * @typedef {Object} FlatRecord
   * One "%%SECTION%% .. %%END%%" block of the flat v1.1 format.
   * @property {string} type - The section name (HEADER, CONSTANT, FLAG, TABLE, CHECKSUM).
   * @property {Map<string, string>} fields - Field name -> value, quotes stripped.
   */

  /** Number of Category<N> header slots the flat format can carry. */
  const FLAT_CATEGORY_SLOTS = 32;
  /** Number of Cat<N>ID memberships one flat item can carry. */
  const FLAT_ITEM_CATEGORY_SLOTS = 8;

  /**
   * Escape a value for an XML attribute or text node.
   * @param {*} v
   * @returns {string}
   */
  const xmlEscape = (v) =>
    String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  /**
   * "(null)" is the flat format's empty marker, not a literal value.
   * @param {*} v
   * @returns {*} '' for the marker or a missing value, else `v` unchanged.
   */
  const nullish = (v) => (v === '(null)' || v == null ? '' : v);

  /**
   * Parse a flat-format number (decimal or 0x hex, optionally negative).
   * @param {*} v - Raw field value.
   * @param {number} dflt - Returned for a missing, empty or unparseable value.
   * @returns {number}
   */
  function legacyNum(v, dflt) {
    if (v == null || v === '' || v === '(null)') return dflt;
    const t = String(v).trim();
    const n = /^-?0x/i.test(t)
      ? parseInt(t.replace(/^-?0x/i, ''), 16) * (t.startsWith('-') ? -1 : 1)
      : Number(t);
    return Number.isFinite(n) ? n : dflt;
  }

  /**
   * Split flat text into its records. Records are "%%SECTION%% .. %%END%%"
   * blocks of "<code> <Name> =<value>" lines.
   * @param {string} text
   * @returns {FlatRecord[]}
   */
  function parseFlatRecords(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const records = [];
    let cur = null;
    for (const line of lines) {
      const marker = /^%%([A-Z]+)%%\s*$/.exec(line);
      if (marker) {
        if (marker[1] === 'END') {
          if (cur) {
            records.push(cur);
            cur = null;
          }
        } else cur = { type: marker[1], fields: new Map() };
        continue;
      }
      if (!cur) continue;
      // The value runs to end-of-line: descriptions contain '=' and quotes.
      const m = /^\s*(\d{6})\s+(\w+)\s*=(.*)$/.exec(line);
      if (!m) continue;
      let val = m[3].trim();
      if (val.startsWith('"')) val = val.replace(/^"/, '').replace(/"$/, '');
      cur.fields.set(m[2], val);
    }
    return records;
  }

  /**
   * A flat equation with its ",TH|a|b|c|d|" tail removed -- TunerPro's
   * table-hooks blob, not part of the maths. The head is ordinary infix the
   * MATH parser already compiles.
   * @param {*} raw - The Equation / XEq / YEq / ZEq field.
   * @returns {string} The equation, or "X" when empty.
   */
  function flatEquation(raw) {
    const v = nullish(raw);
    if (!v) return 'X';
    const cut = v.indexOf(',TH|');
    return (cut === -1 ? v : v.slice(0, cut)).trim() || 'X';
  }

  /**
   * An <EMBEDDEDDATA .../> tag for the v1.50 output.
   * @param {number} addr
   * @param {number} sizeBits
   * @param {number|null} rows - Included when not null.
   * @param {number|null} cols - Included when not null.
   * @returns {string}
   */
  function embeddedTag(addr, sizeBits, rows, cols) {
    const a = [
      `mmedaddress="0x${(addr >>> 0).toString(16).toUpperCase()}"`,
      `mmedelementsizebits="${sizeBits}"`,
    ];
    if (rows != null) a.push(`mmedrowcount="${rows}"`);
    if (cols != null) a.push(`mmedcolcount="${cols}"`);
    return `<EMBEDDEDDATA ${a.join(' ')} />`;
  }

  /**
   * The <XDFHEADER> block for a flat file.
   * @param {Map<string, string>} hf - The HEADER record's fields.
   * @returns {string[]} Output lines.
   */
  function flatHeaderXml(hf) {
    const out = ['  <XDFHEADER>'];
    out.push(
      `    <flags>0x${legacyNum(hf.get('GenFlags'), 0).toString(16)}</flags>`
    );
    out.push(
      `    <deftitle>${xmlEscape(nullish(hf.get('DefTitle')))}</deftitle>`
    );
    out.push(
      `    <description>${xmlEscape(nullish(hf.get('Desc')))}</description>`
    );
    out.push(`    <author>${xmlEscape(nullish(hf.get('Author')))}</author>`);
    out.push(
      `    <baseoffset>${legacyNum(hf.get('BaseOffset'), 0)}</baseoffset>`
    );
    out.push(
      '    <DEFAULTS datasizeinbits="8" sigdigits="2" outputtype="1" signed="0" lsbfirst="0" float="0" />'
    );
    const binSize = legacyNum(hf.get('BinSize'), 0);
    if (binSize > 0) {
      out.push(
        `    <REGION type="0xFFFFFFFF" startaddress="0x0" size="0x${binSize.toString(16).toUpperCase()}" regionflags="0x0" name="Binary File" desc="" />`
      );
    }
    for (let i = 0; i < FLAT_CATEGORY_SLOTS; i++) {
      const c = hf.get(`Category${i}`);
      if (c != null)
        out.push(
          `    <CATEGORY index="0x${i.toString(16)}" name="${xmlEscape(c)}" />`
        );
    }
    out.push('  </XDFHEADER>');
    return out;
  }

  /**
   * The <CATEGORYMEM> lines of one flat item. Cat*ID is 1-based here with 0
   * meaning "unset".
   * @param {Map<string, string>} f - The item's fields.
   * @returns {string[]}
   */
  function flatCategoryLines(f) {
    const cats = [];
    for (let i = 0; i < FLAT_ITEM_CATEGORY_SLOTS; i++) {
      const ci = legacyNum(f.get(`Cat${i}ID`), 0);
      if (ci > 0)
        cats.push(`    <CATEGORYMEM index="${i}" category="${ci}" />`);
    }
    return cats;
  }

  /**
   * One flat TABLE record as v1.50 XML.
   * @param {Map<string, string>} f - The record's fields.
   * @param {string} uid - The uniqueid attribute value.
   * @param {string} title - Escaped title.
   * @param {string} desc - Escaped description ('' when none).
   * @param {string[]} cats - CATEGORYMEM lines.
   * @returns {string[]}
   */
  function flatTableXml(f, uid, title, desc, cats) {
    const out = [];
    const rows = legacyNum(f.get('Rows'), 1);
    const cols = legacyNum(f.get('Cols'), 1);
    out.push(`  <XDFTABLE uniqueid="${uid}">`);
    out.push(`    <title>${title}</title>`);
    if (desc) out.push(`    <description>${desc}</description>`);
    out.push(...cats);
    for (const ax of ['x', 'y']) {
      const A = ax.toUpperCase();
      const aAddr = f.get(`${A}Address`);
      const aBits = legacyNum(f.get(`${A}DataSize`), 8);
      const units = xmlEscape(nullish(f.get(`${A}Units`)));
      out.push(`    <XDFAXIS id="${ax}">`);
      if (units) out.push(`      <units>${units}</units>`);
      out.push(`      <indexcount>${ax === 'x' ? cols : rows}</indexcount>`);
      if (nullish(aAddr) !== '') {
        out.push(
          `      ${embeddedTag(legacyNum(aAddr, 0), aBits, null, null)}`
        );
      }
      const labels = nullish(f.get(`${A}Labels`));
      if (labels) {
        labels.split(/\s*,\s*/).forEach((lv, li) => {
          out.push(`      <LABEL index="${li}" value="${xmlEscape(lv)}" />`);
        });
      }
      out.push(
        `      <MATH equation="${xmlEscape(flatEquation(f.get(`${A}Eq`)))}"><VAR id="X" /></MATH>`
      );
      out.push('    </XDFAXIS>');
    }
    out.push('    <XDFAXIS id="z">');
    const zUnits = xmlEscape(nullish(f.get('ZUnits')));
    if (zUnits) out.push(`      <units>${zUnits}</units>`);
    out.push(
      `      ${embeddedTag(legacyNum(f.get('Address'), 0), legacyNum(f.get('SizeInBits'), 8), rows, cols)}`
    );
    out.push(
      `      <MATH equation="${xmlEscape(flatEquation(f.get('ZEq')))}"><VAR id="X" /></MATH>`
    );
    out.push('    </XDFAXIS>');
    out.push('  </XDFTABLE>');
    return out;
  }

  /**
   * Rewrite a flat v1.1 file as v1.50 XML.
   * @param {string} text - The flat file.
   * @returns {string} v1.50 XML.
   */
  function flatToXml(text) {
    const records = parseFlatRecords(text);
    const headerRec = records.find((r) => r.type === 'HEADER');
    const hf = headerRec ? headerRec.fields : new Map();
    const out = ['<XDFFORMAT version="1.50">', ...flatHeaderXml(hf)];

    for (const rec of records) {
      const f = rec.fields;
      const uid = nullish(f.get('UniqueID')) || '0x0';
      const title = xmlEscape(nullish(f.get('Title')));
      const desc = xmlEscape(nullish(f.get('Desc')));
      const cats = flatCategoryLines(f);

      if (rec.type === 'CONSTANT') {
        out.push(`  <XDFCONSTANT uniqueid="${uid}">`);
        out.push(`    <title>${title}</title>`);
        if (desc) out.push(`    <description>${desc}</description>`);
        const units = xmlEscape(nullish(f.get('Units')));
        if (units) out.push(`    <units>${units}</units>`);
        out.push(...cats);
        out.push(
          `    ${embeddedTag(legacyNum(f.get('Address'), 0), legacyNum(f.get('SizeInBits'), 8), null, null)}`
        );
        out.push(
          `    <MATH equation="${xmlEscape(flatEquation(f.get('Equation')))}"><VAR id="X" /></MATH>`
        );
        out.push('  </XDFCONSTANT>');
      } else if (rec.type === 'FLAG') {
        const addr = legacyNum(f.get('Address'), 0);
        const bit = legacyNum(f.get('BitNumber'), 0);
        out.push(`  <XDFFLAG uniqueid="${uid}">`);
        out.push(`    <title>${title}</title>`);
        if (desc) out.push(`    <description>${desc}</description>`);
        out.push(...cats);
        // v1.50 addresses the containing byte and masks the bit within it.
        out.push(
          `    ${embeddedTag(addr + Math.floor(bit / 8), 8, null, null)}`
        );
        out.push(
          `    <mask>0x${((1 << (bit % 8)) >>> 0).toString(16).toUpperCase()}</mask>`
        );
        out.push('  </XDFFLAG>');
      } else if (rec.type === 'TABLE') {
        out.push(...flatTableXml(f, uid, title, desc, cats));
      } else if (rec.type === 'CHECKSUM') {
        // v1.50 spells this <XDFCHECKSUM> with a <CHECKSUMREGION>. The flat
        // fields map across one-for-one.
        out.push(`  <XDFCHECKSUM uniqueid="${uid}">`);
        out.push(`    <title>${title}</title>`);
        out.push(
          '    <CHECKSUMREGION ' +
            `datastart="0x${legacyNum(f.get('DataStart'), 0).toString(16).toUpperCase()}" ` +
            `datasize="0x${Math.max(
              0,
              legacyNum(f.get('DataEnd'), 0) -
                legacyNum(f.get('DataStart'), 0) +
                1
            )
              .toString(16)
              .toUpperCase()}" ` +
            `storeaddress="0x${legacyNum(f.get('StoreAddr'), 0).toString(16).toUpperCase()}" ` +
            `calctype="0x${legacyNum(f.get('CalcMethod'), 0).toString(16)}" ` +
            `regionflags="0x${legacyNum(f.get('Flags'), 0).toString(16)}" />`
        );
        out.push('  </XDFCHECKSUM>');
      }
    }
    out.push('</XDFFORMAT>');
    return out.join('\n');
  }

  /**
   * v0.50 -> v1.50: rewrite <address>/<indexsizebits> children as
   * EMBEDDEDDATA attributes.
   * @param {string} xml - v0.50 XML.
   * @returns {string} v1.50 XML.
   */
  function v050ToV150(xml) {
    return xml
      .replace(/<XDFTABLE\b[\s\S]*?<\/XDFTABLE>/g, (table) => {
        // Row/col counts live on the x/y axes' <indexcount> in this dialect.
        const counts = {};
        for (const m of table.matchAll(
          /<XDFAXIS\s+id="([xy])"[^>]*>([\s\S]*?)<\/XDFAXIS>/g
        )) {
          const ic = /<indexcount>\s*([0-9]+)\s*<\/indexcount>/.exec(m[2]);
          counts[m[1]] = ic ? Number(ic[1]) : 1;
        }
        const cols = counts.x || 1;
        const rows = counts.y || 1;
        return table.replace(
          /<XDFAXIS\s+id="([xyz])"([^>]*)>([\s\S]*?)<\/XDFAXIS>/g,
          (axis, id, attrs, body) => {
            if (/<EMBEDDEDDATA/.test(body)) return axis;
            const addr = /<address>\s*([^<]+?)\s*<\/address>/.exec(body);
            const bits = /<indexsizebits>\s*([0-9]+)\s*<\/indexsizebits>/.exec(
              body
            );
            const a = [`mmedelementsizebits="${bits ? Number(bits[1]) : 8}"`];
            if (addr) a.push(`mmedaddress="${addr[1]}"`);
            if (id === 'z') {
              a.push(`mmedrowcount="${rows}"`);
              a.push(`mmedcolcount="${cols}"`);
            }
            const cleaned = body
              .replace(/\s*<address>[^<]*<\/address>/g, '')
              .replace(/\s*<indexsizebits>[^<]*<\/indexsizebits>/g, '');
            return `<XDFAXIS id="${id}"${attrs}>\n      <EMBEDDEDDATA ${a.join(' ')} />${cleaned}</XDFAXIS>`;
          }
        );
      })
      .replace(
        /<XDF(CONSTANT|FLAG)\b([^>]*)>([\s\S]*?)<\/XDF\1>/g,
        (item, kind, attrs, body) => {
          if (/<EMBEDDEDDATA/.test(body)) return item;
          const addr = /<address>\s*([^<]+?)\s*<\/address>/.exec(body);
          if (!addr) return item;
          const bits = /<sizeinbits>\s*([0-9]+)\s*<\/sizeinbits>/.exec(body);
          const a = [
            `mmedaddress="${addr[1]}"`,
            `mmedelementsizebits="${bits ? Number(bits[1]) : 8}"`,
          ];
          const cleaned = body
            .replace(/\s*<address>[^<]*<\/address>/g, '')
            .replace(/\s*<sizeinbits>[^<]*<\/sizeinbits>/g, '');
          return `<XDF${kind}${attrs}>\n    <EMBEDDEDDATA ${a.join(' ')} />${cleaned}</XDF${kind}>`;
        }
      )
      .replace(/<XDFFORMAT version="0\.50">/, '<XDFFORMAT version="1.50">');
  }

  /**
   * Which of the three spellings is this?
   * @param {string} text - The file as loaded.
   * @returns {'flat'|'v050'|'xml'} 'xml' also for unrecognised input, so the
   *   XML parser produces the real error.
   */
  function detectXdfFormat(text) {
    const head = String(text).slice(0, 4096);
    if (!/<XDFFORMAT/i.test(head)) {
      if (/^\s*XDF\s*[\r\n]/.test(head)) return 'flat';
      return 'xml';
    }
    return /<XDFFORMAT\s+version="0\.\d+"/i.test(head) ? 'v050' : 'xml';
  }

  /**
   * Normalise any supported spelling to v1.50 XML.
   * @param {string} text
   * @returns {string}
   */
  function toV150Xml(text) {
    switch (detectXdfFormat(text)) {
      case 'flat':
        return flatToXml(text);
      case 'v050':
        return v050ToV150(text);
      default:
        return text;
    }
  }

  Object.assign(XDF, {
    detectXdfFormat,
    toV150Xml,
    flatToXml,
    v050ToV150,
    parseFlatRecords,
  });
})(typeof window !== 'undefined' ? window : this);
