/**
 * @file The coding codec: the INVERSE of the coding read decode -- turn a
 * logical FSW value back into the exact netto bytes the ECU expects, and the
 * forward decode that reads them, so a round-trip is provably lossless.
 *
 * Pure, offline, no hardware, no VM. Published as the `CodingEncode` global.
 *
 * A `rule` is a datenmap.js field object (see {@link DatenField}):
 *
 *   word  = WORTADR   -- byte offset into the netto buffer
 *   byte  = BYTEADR   -- field width in bytes (mask array length in BMW's frame)
 *   mask  = the bit mask on the FIRST byte (single int; sub-byte fields);
 *           wider fields carry mask 0xFF / shift 0 (raw LE bytes)
 *   shift = trailing-zero count of the mask (right-shift on read, left on write)
 */

/**
 * One coding field as datenmap.js describes it (BMW's PARZUWEISUNG_FSW row).
 * User-defined rows carry the same shape plus `custom: true`.
 * @typedef {Object} DatenField
 * @property {string} name - FSW keyword (e.g. `BEIKLAPPEN_GM`).
 * @property {number} [id] - FSW id; custom rows use ids from 0xF000 up.
 * @property {number} block - coding block the field lives in.
 * @property {number} word - byte offset into the netto buffer (WORTADR).
 * @property {number} byte - field width in bytes (BYTEADR).
 * @property {number} mask - bit mask on the first byte (0xFF = whole byte).
 * @property {number[]} [masks] - one mask per byte, when they are not all
 *   0xFF; `mask` is then the first of them.
 * @property {number} shift - trailing-zero count of `mask`.
 * @property {Array<[string, string]>} values - `[pswName, hex]` pairs.
 * @property {string} [unit] - EINHEIT gloss: 'h' (default), 'd', 'a', 'A', 'b'.
 * @property {Array<[string, number]>} [ops] - OPERATION list `[opChar, operand]`.
 * @property {boolean} [dir] - a DIR "property" field (VIN, date, keys).
 * @property {string} [label] - BMW's comment for the field, when shipped.
 * @property {boolean} [custom] - true for a user-defined overlay row.
 * @property {string} [note] - free text on a custom row.
 */

/**
 * A staged change: one field and the logical value to encode into it.
 * @typedef {Object} StagedEdit
 * @property {DatenField} rule - the field to write.
 * @property {number|string|ArrayLike<number>} [value] - the value to encode: a
 *   number for fields up to 4 bytes, a hex string or byte array for buffers.
 * @property {string} [hex] - instead of `value`: the field's bytes as the
 *   coding description writes a value (see fieldHex).
 */

(function (root) {
  'use strict';

  // ---- 32-bit helpers -------------------------------------------------------
  /** All 32 bits set; the XOR operand of the '!' invert op. */
  const U32 = 0xffffffff;
  /** Base of the Mod-36 digit alphabet. */
  const MOD36_RADIX = 36;
  /**
   * Bound a JS number to an unsigned 32-bit integer.
   * @param {number} n - any number.
   * @returns {number} `n` as u32.
   */
  const u32 = (n) => n >>> 0;

  // ---- OPERATION table (read direction) -------------------------------------
  // Applied in order on read; each transforms the assembled value.
  // (docs/daten-format.md §1.7)
  /**
   * Apply one OPERATION in the READ direction.
   * @param {string} op - operator char ('!', '&', '*', '+', '-', '/', '>', '^', '|').
   * @param {number} operand - the operator's operand.
   * @param {number} value - the value before the op.
   * @returns {number} the transformed u32 value; unknown ops pass through
   *   (matches the vendor tool's "skip + warn").
   */
  function applyOp(op, operand, value) {
    value = u32(value);
    const n = u32(operand);
    switch (op) {
      case '!':
        return u32(value ^ U32);
      case '&':
        return u32(value & n);
      case '*':
        return u32(Math.imul(value, n));
      case '+':
        return u32(value + n);
      case '-':
        return u32(value - n);
      case '/':
        return u32(n === 0 ? value : Math.floor(value / n));
      case '>':
        return u32((value >>> n) & (n >= 32 ? 0 : ((1 << (32 - n)) - 1) >>> 0));
      case '^':
        return u32(value ^ n);
      case '|':
        return u32(value | n);
      default:
        return value; // unknown op: pass through (matches NCSEXPER "skip + warn")
    }
  }

  // The inverse of a single op, for the ENCODE direction.
  // (docs/coding-flow.md §3 stage 3 table)
  /**
   * Apply the inverse of one OPERATION, for the ENCODE direction.
   * @param {string} op - operator char, as in {@link applyOp}.
   * @param {number} operand - the operator's operand.
   * @param {number} value - the logical value after the op.
   * @returns {number} the u32 value before the op.
   */
  function applyOpInverse(op, operand, value) {
    value = u32(value);
    const n = u32(operand);
    switch (op) {
      case '!':
        return u32(value ^ U32); // self-inverse
      case '+':
        return u32(value - n); // + -> -
      case '-':
        return u32(value + n); // - -> +
      case '>':
        return u32((n >= 32 ? 0 : value << n) & U32); // >(rshift) -> left-shift, 32b-bounded
      case '*':
        return u32(n === 0 ? value : Math.floor(value / n)); // * -> /
      case '/':
        return u32(Math.imul(value, n)); // / -> *
      case '&':
        return u32(value & n); // self-inverse over covered bits
      case '|':
        return u32(value | n); // self-inverse (idempotent set)
      case '^':
        return u32(value ^ n); // self-inverse
      default:
        return value;
    }
  }

  // ---- EINHEIT: assemble source bytes -> value (read) -----------------------
  //
  // CANONICAL VALUE MODEL. The coding screens record the logical value as
  // "the mask-normalised byte" -- an INTEGER. The EINHEIT char is a DISPLAY
  // gloss (how to print that byte: 'd' decimal, 'a'/'A' the char it stands
  // for, 'b' binary) and does NOT change the field's numeric identity for a
  // coding byte. So for the netto<->value codec, every unit assembles the
  // same width-bounded LE integer from the normalised source bytes.
  //
  // The one place EINHEIT genuinely re-encodes bytes is a multi-byte ASCII
  // STRING buffer ('A' base-36 / 'b' bitstring per daten-format.md §1.8). Those
  // are `dir` "property" fields (VIN, dates, keys) the UI keeps raw and never
  // stages through this codec; ZCS strings go through buildZcsRegion. We still
  // implement 'A'/'b' as true byte<->value inverses below for completeness, but
  // the datenmap corpus carries none, and coding-flow round-trips them as the
  // integer they normalise to either way.
  /**
   * Assemble already mask+shift-normalised source bytes into the numeric
   * value BEFORE ops, per the field's EINHEIT.
   * @param {string|undefined} unit - EINHEIT char; omitted means 'h'.
   * @param {number[]} bytes - normalised per-position bytes (length = rule.byte).
   * @returns {number} the u32 value.
   */
  function einheitDecode(unit, bytes) {
    const u = unit || 'h';
    if (u === 'A') {
      // each byte is one base-36 digit, MSB-first
      let v = 0;
      for (let i = 0; i < bytes.length; i++) {
        const c = bytes[i] & 0xff;
        let d;
        if (c >= 0x30 && c <= 0x39)
          d = c - 0x30; // '0'-'9'
        else if (c >= 0x41 && c <= 0x5a)
          d = c - 0x37; // 'A'-'Z' -> 10..35
        else d = 0;
        v = v * MOD36_RADIX + d;
      }
      return u32(v);
    }
    if (u === 'b') {
      // ASCII bitstring: char '0'/'1' at position i contributes bit i
      let v = 0;
      for (let i = 0; i < bytes.length; i++) {
        if ((bytes[i] & 0xff) === 0x31) v |= 1 << i;
      }
      return u32(v);
    }
    // 'h' / 'a' / 'd' / default: the normalised byte(s) ARE the value, LE.
    let v = 0;
    for (let i = 0; i < bytes.length; i++) v |= (bytes[i] & 0xff) << (8 * i);
    return u32(v);
  }

  // ---- EINHEIT: value -> source bytes (write, inverse of einheitDecode) ------
  /**
   * Produce exactly `width` source bytes for a value (before mask/shift); the
   * inverse of {@link einheitDecode}.
   * @param {string|undefined} unit - EINHEIT char; omitted means 'h'.
   * @param {number} value - the value after inverse ops.
   * @param {number} width - field width in bytes.
   * @returns {number[]} `width` bytes to splice.
   */
  function einheitEncode(unit, value, width) {
    const u = unit || 'h';
    const out = new Array(width).fill(0);
    value = u32(value);
    if (u === 'A') {
      // MSB-first base-36 digits, one ASCII char per byte
      let v = value;
      for (let i = width - 1; i >= 0; i--) {
        const d = v % MOD36_RADIX;
        v = Math.floor(v / MOD36_RADIX);
        out[i] = d < 10 ? 0x30 + d : 0x41 + d - 10; // '0'+v / 'A'+v-10
      }
      return out;
    }
    if (u === 'b') {
      // bit i -> '0'/'1' char at position i
      for (let i = 0; i < width; i++) out[i] = (value >>> i) & 1 ? 0x31 : 0x30;
      return out;
    }
    // 'h' / 'a' / 'd' / default: value straight into LE bytes.
    for (let i = 0; i < width; i++) out[i] = (value >>> (8 * i)) & 0xff;
    return out;
  }

  // ---- mask/shift geometry --------------------------------------------------
  // datenmap carries a single-int `mask` (the FIRST byte's mask) and `shift`
  // (its trailing-zero count). For width>1 fields BMW ships mask 0xFF/shift 0,
  // i.e. raw contiguous LE bytes -- so only byte 0 ever carries a sub-byte mask.
  /**
   * The mask applied to a field's first byte (0xFF when unspecified).
   * @param {DatenField} rule - the field.
   * @returns {number} the byte mask.
   */
  function firstMask(rule) {
    return rule.mask === undefined || rule.mask === null
      ? 0xff
      : rule.mask & 0xff;
  }
  /**
   * The right-shift applied to a field's first byte (0 when unspecified).
   * @param {DatenField} rule - the field.
   * @returns {number} the shift count.
   */
  function firstShift(rule) {
    return rule.shift || 0;
  }

  // BMW's MASKE is ONE MASK PER BYTE of a field, and each byte's value is
  // stored shifted down to bit 0 of ITS mask. Most fields have one mask (their
  // first byte's) or all 0xFF, and for those `mask`/`shift` say everything. A
  // field that is not like that carries `masks`: a cluster's two-byte service
  // limit is [0x0F, 0xFF] with another function in the first byte's high
  // nibble, a word that only uses its second byte is [0x00, 0xFF], and two
  // characteristic curves interleave as [0x00, 0xFF, ...] and [0xFF, 0x00,
  // ...] over the same twelve bytes.
  /**
   * The mask of a field's byte.
   * @param {DatenField} rule - the field.
   * @param {number} i - which byte (0 = at `word`).
   * @returns {number} the mask.
   */
  function maskAt(rule, i) {
    if (Array.isArray(rule.masks) && i < rule.masks.length)
      return rule.masks[i] & 0xff;
    return i === 0 ? firstMask(rule) : 0xff;
  }
  /**
   * How far a field's byte sits up inside its mask.
   * @param {DatenField} rule - the field.
   * @param {number} i - which byte.
   * @returns {number} the shift count.
   */
  function shiftAt(rule, i) {
    if (Array.isArray(rule.masks) && i < rule.masks.length) {
      const m = rule.masks[i] & 0xff;
      let sh = 0;
      while (m && !((m >> sh) & 1)) sh++;
      return sh;
    }
    return i === 0 ? firstShift(rule) : 0;
  }

  // A JS number holds a coding value exactly only up to 32 bits. Fields wider
  // than 4 bytes are raw BUFFERS (calibration tables, 16-byte filter blocks,
  // VIN strings) -- the coding screens treat their `values` hex as an opaque
  // buffer, never a number. For those the codec's value is a lowercase hex
  // string in ADDRESS order (byte at `word` first), matching datenmap's hex.
  /** Widest field the codec treats as a number; wider ones are buffers. */
  const MAX_NUMERIC_WIDTH = 4;
  /**
   * Is this field a raw buffer (wider than 4 bytes) rather than a number?
   * @param {DatenField} rule - the field.
   * @returns {boolean} true for buffer fields.
   */
  function isBuffer(rule) {
    return (rule.byte || 1) > MAX_NUMERIC_WIDTH;
  }
  const HEX = '0123456789abcdef';
  /**
   * One byte as two lowercase hex chars.
   * @param {number} b - the byte.
   * @returns {string} two hex chars.
   */
  const toHex = (b) => HEX[(b >> 4) & 0xf] + HEX[b & 0xf];

  // ---- decodeField: forward read (netto -> logical value) -------------------
  // The EXACT inverse of encodeField, used for round-trip proofs and to show
  // the value currently held in a read netto image.
  /**
   * Read a field's logical value out of a netto image.
   * @param {DatenField} rule - the field.
   * @param {ArrayLike<number>} netto - the coding bytes as read.
   * @returns {number|string} a NUMBER for fields up to 4 bytes, an
   *   address-order lowercase hex STRING for wider buffers.
   */
  function decodeField(rule, netto) {
    const width = rule.byte || 1;
    const at = rule.word || 0;

    if (isBuffer(rule)) {
      // raw buffer: address-order hex string, each byte under its own mask,
      // no ops (buffers ship none in the corpus). A buffer has no "first byte
      // mask": without a per-byte list every byte is whole.
      const listed = Array.isArray(rule.masks);
      let s = '';
      for (let i = 0; i < width; i++) {
        const raw = netto[at + i] & 0xff;
        s += toHex(listed ? (raw & maskAt(rule, i)) >>> shiftAt(rule, i) : raw);
      }
      return s;
    }

    // per-position normalised bytes: each masked and shifted by its own mask
    const bytes = new Array(width);
    for (let i = 0; i < width; i++) {
      const raw = netto[at + i] & 0xff;
      bytes[i] = (raw & maskAt(rule, i)) >>> shiftAt(rule, i);
    }

    let value = einheitDecode(rule.unit, bytes);
    const ops = rule.ops || [];
    for (let k = 0; k < ops.length; k++)
      value = applyOp(ops[k][0], ops[k][1], value);
    return u32(value);
  }

  // ---- encodeField: inverse write (logical value -> mutate netto in place) ---
  /**
   * Write a field's logical value into a netto image IN PLACE, touching only
   * the field's own bits.
   * @param {DatenField} rule - the field.
   * @param {number|string|ArrayLike<number>} value - a number, or for buffer
   *   fields a hex string / byte array in address order.
   * @param {Uint8Array|number[]} netto - the coding bytes, mutated.
   * @returns {Uint8Array|number[]} the same `netto`.
   */
  function encodeField(rule, value, netto) {
    const width = rule.byte || 1;
    const at = rule.word || 0;

    if (isBuffer(rule)) {
      // hex string (or byte array) straight into the netto, address order
      let bytes;
      if (typeof value === 'string') {
        bytes = [];
        for (let i = 0; i + 1 < value.length; i += 2)
          bytes.push(parseInt(value.substr(i, 2), 16) & 0xff);
      } else {
        bytes = Array.from(value, (b) => b & 0xff);
      }
      // A value shorter than the field is not padded with zeros: the bytes it
      // does not name stay as they are. (A truncated value once meant the
      // rest of a 31-byte block would have been zeroed.)
      const listed = Array.isArray(rule.masks);
      for (let i = 0; i < width && i < bytes.length; i++) {
        const m = listed ? maskAt(rule, i) : 0xff;
        const sh = listed ? shiftAt(rule, i) : 0;
        netto[at + i] =
          ((netto[at + i] & (~m & 0xff)) | ((bytes[i] << sh) & m)) & 0xff;
      }
      return netto;
    }

    // Stage 3: invert OPERATION list -- reverse order, each op inverted.
    let v = u32(/** @type {number} */ (value));
    const ops = rule.ops || [];
    for (let k = ops.length - 1; k >= 0; k--)
      v = applyOpInverse(ops[k][0], ops[k][1], v);

    // Stage 4: invert EINHEIT to source bytes.
    const enc = einheitEncode(rule.unit, v, width);

    // Stage 5: splice with mask+shift. Non-destructive: only the mask's bits of
    // each netto byte are touched, so a neighbour sharing the byte survives.
    for (let i = 0; i < width; i++) {
      const m = maskAt(rule, i);
      const placed = (enc[i] << shiftAt(rule, i)) & m;
      netto[at + i] = ((netto[at + i] & (~m & 0xff)) | placed) & 0xff;
    }
    return netto;
  }

  // ---- a field as BMW's files write it: bytes, in address order ------------
  //
  // A value in a coding description (a PSW's DATUM) is the field's bytes in
  // ADDRESS order, each shifted down to bit 0 of its own mask: the cluster's
  // "4912 imp/km" is 13 30 for the two bytes at 0x80 and 0x81. Comparing and
  // writing in that form needs no opinion about byte order or number format,
  // so it is what the coding screens use to say which option a module is set
  // to, and to stage another: a field's hex here equals an option's hex or it
  // does not.
  /**
   * The mask of a field's byte in the byte-domain view (a buffer without a
   * per-byte list is whole bytes throughout).
   * @param {DatenField} rule - the field.
   * @param {number} i - which byte.
   * @returns {number} the mask.
   */
  function byteMask(rule, i) {
    if (Array.isArray(rule.masks)) return maskAt(rule, i);
    return i === 0 && !isBuffer(rule) ? firstMask(rule) : 0xff;
  }
  /**
   * How far that byte sits up inside its mask.
   * @param {DatenField} rule - the field.
   * @param {number} i - which byte.
   * @returns {number} the shift count.
   */
  function byteShift(rule, i) {
    if (Array.isArray(rule.masks)) return shiftAt(rule, i);
    return i === 0 && !isBuffer(rule) ? firstShift(rule) : 0;
  }
  /**
   * A field's value as its description writes values: lowercase hex of its
   * bytes in address order, each under its own mask and shifted down.
   * @param {DatenField} rule - the field.
   * @param {ArrayLike<number>} netto - the coding image.
   * @returns {string|null} the hex, or null when the field is not inside
   *   the image.
   */
  function fieldHex(rule, netto) {
    const width = rule.byte || 1;
    const at = rule.word || 0;
    if (at < 0 || at + width > netto.length) return null;
    let s = '';
    for (let i = 0; i < width; i++)
      s += toHex(
        (netto[at + i] & 0xff & byteMask(rule, i)) >>> byteShift(rule, i)
      );
    return s;
  }
  /**
   * Write a value given in that form into an image IN PLACE, touching only
   * the field's own bits. The exact inverse of fieldHex.
   * @param {DatenField} rule - the field.
   * @param {string} hex - the value: two hex digits per byte of the field.
   * @param {Uint8Array|number[]} netto - the coding image, mutated.
   * @returns {Uint8Array|number[]} the same `netto`.
   * @throws {Error} when the value is not the field's width, a byte does not
   *   fit its mask, or the field is not inside the image.
   */
  function encodeFieldHex(rule, hex, netto) {
    const width = rule.byte || 1;
    const at = rule.word || 0;
    const text = String(hex).replace(/^0x/i, '');
    if (!/^[0-9a-fA-F]*$/.test(text) || text.length !== width * 2)
      throw new Error(
        `${rule.name}: a value of ${text.length / 2} bytes for a ${width}-byte function`
      );
    if (at < 0 || at + width > netto.length)
      throw new Error(`${rule.name}: outside the coding image`);
    for (let i = 0; i < width; i++) {
      const b = parseInt(text.substr(i * 2, 2), 16);
      const m = byteMask(rule, i);
      const sh = byteShift(rule, i);
      if (b > m >>> sh)
        throw new Error(
          `${rule.name}: 0x${toHex(b)} does not fit mask 0x${toHex(m)}`
        );
      netto[at + i] = ((netto[at + i] & (~m & 0xff)) | ((b << sh) & m)) & 0xff;
    }
    return netto;
  }

  // ---- spliceEdits: apply staged changes onto a COPY of the read image ------
  /**
   * Apply staged edits onto a COPY of the read image. Never builds from
   * zeros -- edits ride on top of the bytes actually read from the ECU.
   * @param {ArrayLike<number>} netto - the coding bytes as read.
   * @param {StagedEdit[]} edits - the staged changes.
   * @returns {Uint8Array} a new image with the edits applied.
   */
  function spliceEdits(netto, edits) {
    const out = new Uint8Array(netto.length);
    out.set(netto);
    for (const e of edits || []) {
      // `hex` is a value in the description's own form (an option's bytes);
      // `value` a number or buffer through the unit and operation transform
      if (e.hex != null) encodeFieldHex(e.rule, e.hex, out);
      else encodeField(e.rule, e.value, out);
    }
    return out;
  }

  // ===========================================================================
  // Identity / ZCS math (docs/zcs-write.md §2-3, fahrgestell-nr-format.md)
  // ===========================================================================

  /**
   * Mod-36 digit decode: '0'-'9' -> 0..9, 'A'-'Z' -> 10..35.
   * @param {number} code - a char code.
   * @returns {number} the digit value, or -1 when invalid.
   */
  function mod36Decode(code) {
    if (code >= 0x30 && code <= 0x39) return code - 0x30;
    if (code >= 0x41 && code <= 0x5a) return code - 0x41 + 10;
    return -1;
  }
  /**
   * Mod-36 digit encode: 0..9 -> '0'-'9', 10..35 -> 'A'-'Z'.
   * @param {number} v - a digit value 0..35.
   * @returns {string} the digit char.
   */
  function mod36Encode(v) {
    if (v < 10) return String.fromCharCode(0x30 + v);
    return String.fromCharCode(0x41 + (v - 10));
  }

  // Core weighted Mod-36 sum over an already-assembled input string.
  // sum starts 0; for each char i, v = decode(char); if i EVEN v*=3;
  // sum = (sum + v) & 0xFFFF. Check = mod36Encode((int16)sum % 36 normalised).
  /**
   * The weighted Mod-36 check char over an assembled input string.
   * @param {string} input - prefix + body, Mod-36 alphabet only.
   * @returns {string} the single check char.
   * @throws {Error} on a char outside the Mod-36 alphabet.
   */
  function mod36Core(input) {
    let sum = 0;
    for (let i = 0; i < input.length; i++) {
      let v = mod36Decode(input.charCodeAt(i));
      if (v < 0)
        throw new Error('mod36: invalid char ' + JSON.stringify(input[i]));
      if ((i & 1) === 0) v = v * 3;
      sum = (sum + v) & 0xffff;
    }
    // signed int16 -> mod 36, normalised into 0..35
    let s = sum & 0xffff;
    if (s & 0x8000) s -= 0x10000;
    let r = s % MOD36_RADIX;
    if (r < 0) r += MOD36_RADIX;
    return mod36Encode(r);
  }

  /**
   * Per-key ZCS check char.
   * @param {string} prefix - the channel tag: 'C1' = GM, 'C2' = SA, 'C3' = VN.
   * @param {string} body - the key body (hex chars).
   * @returns {string} the check char.
   */
  function mod36(prefix, body) {
    return mod36Core(prefix + body);
  }
  /**
   * GM body (8 chars) plus its check char.
   * @param {string} body - 8 hex chars.
   * @returns {string} 9 chars.
   */
  const formatGm = (body) => body + mod36('C1', body);
  /**
   * SA body (16 chars) plus its check char.
   * @param {string} body - 16 hex chars.
   * @returns {string} 17 chars.
   */
  const formatSa = (body) => body + mod36('C2', body);
  /**
   * VN body (10 chars) plus its check char.
   * @param {string} body - 10 hex chars.
   * @returns {string} 11 chars.
   */
  const formatVn = (body) => body + mod36('C3', body);

  /**
   * VIN 18th char: Mod-36 over "FP" + vin (same core).
   * @param {string} vin - the 17-char VIN.
   * @returns {string} the check char.
   */
  function vinCheckChar(vin) {
    return mod36Core('FP' + vin);
  }
  /**
   * The 17-char VIN plus its check char, as the FAHRGESTELL_NR job wants it.
   * @param {string} vin - the 17-char VIN.
   * @returns {string} 18 chars.
   */
  const formatFahrgestellNr = (vin) => vin + vinCheckChar(vin);

  // ---- buildZcsRegion: the fixed 20-byte ZCS layout -------------------------
  // [GM 4B body][GM chk 1B][SA 8B body][SA chk 1B][VN 5B body][VN chk 1B]
  // Bodies are nibble-packed (high nibble = first hex char). Check chars are
  // ASCII. Spliced at baseAddr into netto. (docs/zcs-write.md §3)
  /** Size of the ZCS region in bytes. */
  const ZCS_REGION_LEN = 20;
  /** GM body length in packed bytes. */
  const ZCS_GM_BYTES = 4;
  /** SA body length in packed bytes. */
  const ZCS_SA_BYTES = 8;
  /** VN body length in packed bytes. */
  const ZCS_VN_BYTES = 5;

  /**
   * Pack a hex body into bytes, high nibble first.
   * @param {string} hexBody - 2 * byteLen hex chars.
   * @param {number} byteLen - bytes to produce.
   * @returns {number[]} the packed bytes.
   */
  function packNibbles(hexBody, byteLen) {
    const out = new Array(byteLen).fill(0);
    for (let i = 0; i < byteLen; i++) {
      const hi = hexBody.charCodeAt(2 * i);
      const lo = hexBody.charCodeAt(2 * i + 1);
      out[i] = ((hexNibble(hi) << 4) | hexNibble(lo)) & 0xff;
    }
    return out;
  }
  /**
   * One hex char code to its nibble value (0 for a non-hex char).
   * @param {number} code - a char code.
   * @returns {number} 0..15.
   */
  function hexNibble(code) {
    if (code >= 0x30 && code <= 0x39) return code - 0x30;
    if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10; // A-F
    if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10; // a-f
    return 0;
  }

  /**
   * Build the 20-byte ZCS region from three key bodies and splice it into a
   * netto image at `baseAddr`.
   * @param {string} gmBody - 8 hex chars.
   * @param {string} saBody - 16 hex chars.
   * @param {string} vnBody - 10 hex chars.
   * @param {number} baseAddr - byte offset of the region in `netto`.
   * @param {Uint8Array|number[]} netto - the image, mutated.
   * @returns {Uint8Array|number[]} the same `netto`.
   */
  function buildZcsRegion(gmBody, saBody, vnBody, baseAddr, netto) {
    const region = new Array(ZCS_REGION_LEN);
    let p = 0;
    // GM: 4 body bytes + 1 check ASCII
    const gm = packNibbles(gmBody, ZCS_GM_BYTES);
    for (let i = 0; i < ZCS_GM_BYTES; i++) region[p++] = gm[i];
    region[p++] = mod36('C1', gmBody).charCodeAt(0);
    // SA: 8 body bytes + 1 check
    const sa = packNibbles(saBody, ZCS_SA_BYTES);
    for (let i = 0; i < ZCS_SA_BYTES; i++) region[p++] = sa[i];
    region[p++] = mod36('C2', saBody).charCodeAt(0);
    // VN: 5 body bytes + 1 check
    const vn = packNibbles(vnBody, ZCS_VN_BYTES);
    for (let i = 0; i < ZCS_VN_BYTES; i++) region[p++] = vn[i];
    region[p] = mod36('C3', vnBody).charCodeAt(0);
    // splice the 20 bytes at baseAddr
    for (let i = 0; i < ZCS_REGION_LEN; i++)
      netto[baseAddr + i] = region[i] & 0xff;
    return netto;
  }

  // ---- exports (browser global, matching app/renderer/core/*.js style) ------
  const api = {
    encodeField,
    decodeField,
    fieldHex,
    encodeFieldHex,
    spliceEdits,
    applyOp,
    applyOpInverse,
    einheitDecode,
    einheitEncode,
    mod36,
    mod36Decode,
    mod36Encode,
    formatGm,
    formatSa,
    formatVn,
    vinCheckChar,
    formatFahrgestellNr,
    buildZcsRegion,
  };
  root.CodingEncode = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
