/**
 * @file Encodings the VM shares with its callers: CP1252 text <-> bytes,
 * the engine's number parsers (StringToValue, float constants), the float
 * formatter behind `flt2a`, little-endian byte folding, and the
 * set_communication_pars decoder. Pure functions; no VM state.
 *
 * Best2Vm re-exposes the text and number codecs as static methods
 * (machine.js) because callers outside the VM address them that way.
 */

/**
 * The upper half of Windows-1252, the engine's ambient Encoding -- NOT
 * latin-1. Bytes 0x80..0x9F are printable there (0x96 is an en dash), and
 * decoding them as latin-1 control characters turned "LLR - Solldrehzahl"
 * into a C1 escape. Index = byte - 0x80, value = the Unicode code point.
 * @type {number[]}
 */
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c,
  0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d,
  0x017e, 0x0178,
];

/** The byte a character outside CP1252 becomes when written back: '?'. */
const CP1252_REPLACEMENT = 0x3f;

/**
 * Significant digits `flt2a` keeps: the engine's _floatPrecision default.
 */
const FLOAT_PRECISION = 4;

/**
 * Wire parameters decoded from a set_communication_pars blob (`xsetpar`).
 * The transport reads the concept to frame, checksum and pace an exchange;
 * the VM never touches the port itself.
 * @typedef {Object} CommParams
 * @property {number} concept - The protocol concept (1..6 K-line variants,
 *   0x10B..0x10D KWP2000, 0x10F BMW-FAST, 0x110 D-CAN).
 * @property {number} baud - Line speed in baud.
 * @property {?number} timeout - Answer timeout (time to first byte), ms.
 * @property {?number} regen - Regeneration gap between telegrams, ms.
 * @property {?number} telEnd - Telegram-end / response-pending timeout, ms.
 * @property {?number} timeoutNr78 - The 0x78 busy-wait timeout, ms.
 * @property {number[]} params - The raw CommParameter words.
 * @property {number[]} [answerLen] - set_answer_length pairs (`xawlen`).
 * @property {number} [waitMs] - A `wait`/`waitex` pause owed before the
 *   next exchange.
 */

/**
 * Text and number codecs, namespaced so the pieces share one implementation.
 */
const Best2Codec = {
  CP1252_HIGH,

  /**
   * Bytes -> text, CP1252.
   * @param {Uint8Array|number[]} b - Raw bytes.
   * @returns {string} The decoded text, one character per byte.
   */
  bytesStr(b) {
    let s = '';
    for (const x of b) {
      s += String.fromCharCode(
        x >= 0x80 && x <= 0x9f ? CP1252_HIGH[x - 0x80] : x
      );
    }
    return s;
  },

  /**
   * Text -> bytes, CP1252: the inverse of bytesStr, for text written back
   * into a byte buffer. A character with no CP1252 byte becomes '?'.
   * @param {string} str - The text.
   * @returns {Uint8Array} One byte per character.
   */
  strBytesCp1252(str) {
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c <= 0xff) {
        out[i] = c;
        continue;
      }
      const k = CP1252_HIGH.indexOf(c);
      out[i] = k >= 0 ? 0x80 + k : CP1252_REPLACEMENT;
    }
    return out;
  },

  /**
   * Any value -> CP1252 bytes of its string form (null/undefined -> empty).
   * @param {*} s - The value to encode.
   * @returns {Uint8Array} The encoded bytes.
   */
  strBytes(s) {
    return Best2Codec.strBytesCp1252(String(s ?? ''));
  },

  /**
   * NUL-terminated text, the way result strings are published: decode up to
   * the first NUL byte.
   * @param {Uint8Array|number[]} b - Raw bytes.
   * @returns {string} The text before the first NUL.
   */
  cstr(b) {
    const z = b.indexOf(0);
    return Best2Codec.bytesStr(z < 0 ? b : b.slice(0, z));
  },

  /**
   * EDIABAS's StringToValue: 0x hex, 0y binary, else decimal truncated at
   * the first '.' or ','. Unparseable yields 0. This is what table cells
   * are run through by tabseeku, so "0x10" seeks as 16.
   *
   * StringToValue uses Convert.ToInt64, which is ALL-OR-NOTHING: it
   * throws on trailing junk and the caller catches it as 0. parseInt
   * happily takes a valid prefix, and that difference is visible --
   * y2bcd renders a non-BCD nibble as '*', so LSZ's ID_HW_NR is the text
   * "2*", which the engine reports as 0 and parseInt would call 2.
   * @param {*} s - The text to parse.
   * @returns {number} The integer value, or 0.
   */
  strToValue(s) {
    const t = String(s ?? '').replace(/\s+$/, '');
    if (!t) return 0;
    const low = t.toLowerCase();
    if (low.startsWith('0x')) {
      const body = t.slice(2);
      if (!/^[0-9a-fA-F]+$/.test(body)) return 0;
      const v = parseInt(body, 16);
      return Number.isFinite(v) ? v : 0;
    }
    if (low.startsWith('0y')) {
      const body = t.slice(2);
      if (!/^[01]+$/.test(body)) return 0;
      const v = parseInt(body, 2);
      return Number.isFinite(v) ? v : 0;
    }
    if (low === '-' || low === '--') return 0;
    if (/^[a-z]/i.test(low)) return 0; // a leading letter rejects it
    // decimal, truncated at the first '.' or ',' -- then it must be a
    // COMPLETE integer or the conversion fails
    const cut = t.trimStart().split(/[.,]/)[0];
    if (!/^[+-]?[0-9]+$/.test(cut)) return 0;
    const v = parseInt(cut, 10);
    return Number.isFinite(v) ? v : 0;
  },

  /**
   * A float constant. EDIABAS writes them with either decimal separator.
   * @param {*} s - The text to parse.
   * @returns {number} The value, or 0 when it does not parse.
   */
  parseNum(s) {
    if (s === undefined || s === null) return 0;
    const v = parseFloat(String(s).replace(',', '.'));
    return Number.isFinite(v) ? v : 0;
  },

  /**
   * OpFlt2A, ported faithfully: round to floatPrecision (default 4)
   * SIGNIFICANT digits (RoundToSignificantDigits, Math.Round = half-even),
   * format invariant, then CUT THE STRING after the Nth digit character --
   * including the engine's own quirk of truncating an exponent's digits.
   * JS shortest-roundtrip formatting ("0.30000000000000004") never appears:
   * the rounding and the cut both bound it.
   * @param {number} value - The float to format.
   * @param {number} [digits] - Significant digits to keep: the job's
   *   setflt value, the engine default when it never set one.
   * @returns {string} The engine's text for it.
   */
  fltText(value, digits = FLOAT_PRECISION) {
    let v = Number(value);
    if (Number.isFinite(v) && v !== 0) {
      const scale = 10 ** (Math.floor(Math.log10(Math.abs(v))) + 1);
      const x = (v / scale) * 10 ** digits;
      let r = Math.round(x); // JS rounds half toward +inf...
      if (Math.abs(x % 1) === 0.5 && r % 2 !== 0) r -= 1;
      v = scale * (r / 10 ** digits); // ...Math.Round is half to even
    }
    // string.Format("{0}", double) on the engine's runtime is the "G"
    // format, 15 significant digits, which hides the binary artifact the
    // rounding leaves (100 * 0.123457 is 12.345699999999999 in a double);
    // JS's shortest-roundtrip String() shows it, and the cut below would
    // then keep "12.3456" where the engine prints "12.3457"
    let s = Number.isFinite(v) ? String(Number(v.toPrecision(15))) : String(v);
    const em = /^(-?[\d.]+)e([+-])(\d+)$/.exec(s);
    if (em) s = `${em[1]}E${em[2]}${em[3].padStart(2, '0')}`;
    let count = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] >= '0' && s[i] <= '9') {
        count++;
        if (count >= digits) {
          s = s.slice(0, i + 1);
          break;
        }
      }
    }
    return s;
  },

  /**
   * Fold `n` bytes at `offset` into an unsigned number, LITTLE-endian (byte
   * 0 is the low byte), zero-padding when the slice is short -- the way
   * Register.GetValueData and Operand.GetValueData assemble a value.
   * @param {Uint8Array|number[]} buf - The bytes.
   * @param {number} offset - Index of the low byte.
   * @param {number} n - How many bytes to fold.
   * @returns {number} The unsigned value.
   */
  leValue(buf, offset, n) {
    let v = 0;
    for (let k = n - 1; k >= 0; k--) v = v * 256 + (buf[offset + k] || 0);
    return v;
  },

  /**
   * Serialize an unsigned number as `n` bytes, LITTLE-endian (low byte
   * first); higher bytes are dropped.
   * @param {number} value - The value (already non-negative).
   * @param {number} n - How many bytes to write.
   * @returns {Uint8Array} The bytes.
   */
  leBytes(value, n) {
    const out = new Uint8Array(n);
    let v = value;
    for (let k = 0; k < n; k++) {
      out[k] = v & 0xff;
      v = Math.floor(v / 256);
    }
    return out;
  },

  /**
   * set_communication_pars, decoded the way EdInterfaceObd.cs reads it: the
   * answer timeout, the regeneration gap and the response-pending timeout
   * sit at a concept-specific index in the CommParameter words. The old
   * "largest plausible timing word" guess picked ParTimeoutNr78 (5000 ms,
   * the 0x78 busy-wait) as the answer timeout on every 0x1xx concept, so a
   * silent KWP2000* probe cost 5 s where EDIABAS waits 500 ms -- the whole
   * "MS45 takes ages to identify the first time".
   *   concepts 1,2,3,5,6  (ISO 9141, KWP1281, DS1/DS2): [5] [6] [7]
   *   0x10B/0x10C/0x10D   (KWP2000 std/BMW/*):          [2] [3] [4], Nr78 [7]
   *   0x10F               (BMW-FAST):                    [2] [3] [4], Nr78 [6]
   *   0x110               (D-CAN):                       [7] [8],     Nr78 [9]
   * @param {number[]} words - The CommParameter words, concept first.
   * @returns {CommParams} The decoded wire parameters.
   */
  decodeCommParams(words) {
    const c = words[0];
    const at = (i) => (i < words.length && words[i] > 0 ? words[i] : null);
    let timeout = null,
      regen = null,
      telEnd = null,
      timeoutNr78 = null;
    if (c >= 0x1 && c <= 0x6) {
      timeout = at(5);
      regen = at(6);
      telEnd = at(7);
    } else if (c === 0x10b || c === 0x10c || c === 0x10d) {
      timeout = at(2);
      regen = at(3);
      telEnd = at(4);
      timeoutNr78 = at(7);
    } else if (c === 0x10f) {
      timeout = at(2);
      regen = at(3);
      telEnd = at(4);
      timeoutNr78 = at(6);
    } else if (c === 0x110) {
      timeout = at(7);
      regen = at(8);
      timeoutNr78 = at(9);
    }
    return {
      concept: c,
      baud: words[1],
      timeout,
      regen,
      telEnd,
      timeoutNr78,
      params: words,
    };
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Best2Codec, CP1252_HIGH, FLOAT_PRECISION };
}
