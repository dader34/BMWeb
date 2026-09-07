/**
 * @file Vehicle identity: the FA side -- the vehicle order as text, parsed
 * and rebuilt marker for marker, and the SA codes it carries.
 *
 * Third piece of core/vehicle-identity/; self-contained.
 *
 * Wire form:
 *   E46_#0303*BW32%0A08&N6TT|7531125$205$210+633L-1234
 *     ^BR  ^date ^type ^lack ^polster ^zusbau ^SA...  ^HO word ^E word
 *
 * The marker set is FA.PRG's own: its decoder answers with SA_n, HO_WORT_n,
 * E_WORT_n and ZUSBAU_n, and STANDARD_FA spells them `$`, `+`, `-`, `|`.
 * A HO word (+633L) is a build code, not an option; read as the tail of
 * the SA before it, it turned `$992+633L` into a phantom option 992633.
 *
 * Two traps, both of which produce a rejected write if got wrong:
 *
 *   1. `#` belongs to the token. The order dictionary keys date codes by
 *      their `#`-prefixed form, so stripping it loses the lookup.
 *   2. The marker is set by the SLOT a token sits in, not by what category
 *      the dictionary puts it in. Rebuilding from dictionary category is
 *      what turns every marker into `$` and gets the order rejected.
 *
 * So the parse keeps each token's own marker, and the rebuild replays them.
 */

/**
 * One marker-delimited token of the order, marker kept.
 * @typedef {object} FaToken
 * @property {string} marker - The marker character (`$`, `#`, `+`, ...).
 * @property {string} value - The token's value; for a date the `#` is part
 *   of it.
 * @property {string|undefined} field - The field the marker names (sa, date,
 *   howort, ...).
 */

/**
 * A parsed vehicle order.
 * @typedef {object} FaOrder
 * @property {string|null} br - Baureihe (E46).
 * @property {string|null} date - Order date, `#`-prefixed (#0303).
 * @property {string|null} typ - Type key (BW32).
 * @property {string|null} lack - Paint code.
 * @property {string|null} polster - Upholstery code.
 * @property {string[]} zusbau - Additional build numbers.
 * @property {string[]} sa - SA option codes as written in the order.
 * @property {string[]} howort - HO words (build codes, not options).
 * @property {string[]} ewort - E words.
 * @property {FaToken[]} tokens - Every token in order, for the rebuild.
 * @property {string} raw - The trimmed input.
 */

(function (root) {
  'use strict';

  const VI = root.VehicleIdentity || (root.VehicleIdentity = {});

  /** Marker character -> the order field it introduces. */
  const FA_MARKERS = {
    _: 'br',
    '#': 'date',
    '*': 'typ',
    '%': 'lack',
    '&': 'polster',
    '|': 'zusbau',
    $: 'sa',
    '+': 'howort',
    '-': 'ewort',
  };
  /** Any single marker character. */
  const FA_MARKER_RE = /[_#*%&|$+-]/;
  /** A marker followed by its run of non-marker characters. */
  const FA_TOKEN_RE = /([_#*%&|$+-])([^_#*%&|$+-]*)/g;

  /**
   * Parse an order's wire form into its fields, keeping each token's own
   * marker for the rebuild.
   * @param {unknown} text - The order text ("E46_#0303*BW32...").
   * @returns {FaOrder|null} The order, or null for input that carries no
   *   marker at all.
   */
  function parseFa(text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return null;
    // The chassis is everything before the first marker; `_` terminates it.
    const first = raw.search(FA_MARKER_RE);
    if (first < 0) return null;
    const out = {
      br: raw.slice(0, first) || null,
      date: null,
      typ: null,
      lack: null,
      polster: null,
      zusbau: [],
      sa: [],
      howort: [],
      ewort: [],
      tokens: [],
      raw,
    };
    // Walk marker-delimited runs, keeping the marker with its value.
    const re = new RegExp(FA_TOKEN_RE.source, 'g');
    let m;
    while ((m = re.exec(raw)) !== null) {
      const marker = m[1];
      // `#` is part of the value (the dictionary keys dates as "#0303"),
      // every other marker is a separator only.
      const value = (marker === '#' ? '#' : '') + m[2];
      const field = FA_MARKERS[marker];
      out.tokens.push({ marker, value, field });
      switch (field) {
        case 'br':
          if (m[2]) out.br = m[2];
          break;
        case 'date':
          out.date = value;
          break;
        case 'typ':
          out.typ = m[2];
          break;
        case 'lack':
          out.lack = m[2];
          break;
        case 'polster':
          out.polster = m[2];
          break;
        case 'zusbau':
          if (m[2]) out.zusbau.push(m[2]);
          break;
        case 'sa':
          if (m[2]) out.sa.push(m[2]);
          break;
        case 'howort':
          if (m[2]) out.howort.push(m[2]);
          break;
        case 'ewort':
          if (m[2]) out.ewort.push(m[2]);
          break;
        default:
          break;
      }
    }
    return out;
  }

  /**
   * Back to the wire form, replaying each token's OWN marker. Round-trips
   * parseFa exactly; that is what the test asserts, because a rebuild that
   * re-derives markers from category is the documented way to corrupt an
   * order.
   * @param {FaOrder|null|undefined} fa - A parsed order.
   * @returns {string} The order text, '' for no order.
   */
  function formatFa(fa) {
    if (!fa) return '';
    let out = fa.br || '';
    for (const t of fa.tokens || []) {
      // the `#` a date carries in its value is the marker itself
      const v = t.marker === '#' ? String(t.value).replace(/^#/, '') : t.value;
      out += t.marker + v;
    }
    return out;
  }

  /**
   * An SA code as the catalogue spells it: a number loses its zero padding
   * (S205, never S0205, the way SGET predicates write it); a code that is
   * not a number (1CA, the E46 "Nummernschild" code) is itself. Stripping
   * such a code to its digits would turn it into a DIFFERENT option -- 1CA
   * is not SA 1 -- so anything that is not purely numeric is kept whole.
   * @param {unknown} s - The code as written.
   * @returns {string|null} The normalised code, or null for an empty token.
   */
  function saCode(s) {
    const v = String(s == null ? '' : s)
      .trim()
      .toUpperCase();
    if (!v) return null;
    return /^\d+$/.test(v) ? String(parseInt(v, 10)) : v;
  }

  /**
   * Sort order for SA codes: numbers first, ascending; then the alphanumeric
   * codes as the order lists them.
   * @param {string} a - One code.
   * @param {string} b - Another code.
   * @returns {number} Comparator result.
   */
  function saCompare(a, b) {
    const na = /^\d+$/.test(a);
    const nb = /^\d+$/.test(b);
    if (na && nb) return Number(a) - Number(b);
    return na === nb ? 0 : na ? -1 : 1;
  }

  /**
   * The SA codes an order carries, normalised (see saCode). Only the `$`
   * tokens: the HO and E words beside them are build codes, not options.
   * @param {FaOrder|string|null|undefined} fa - A parsed order or its text.
   * @returns {string[]} Unique codes, numbers first.
   */
  function saCodesFromFa(fa) {
    const f = typeof fa === 'string' ? parseFa(fa) : fa;
    if (!f) return [];
    const out = [];
    for (const s of f.sa) {
      const k = saCode(s);
      if (k && !out.includes(k)) out.push(k);
    }
    return out.sort(saCompare);
  }

  const api = { FA_MARKERS, parseFa, formatFa, saCode, saCodesFromFa };
  Object.assign(VI, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
