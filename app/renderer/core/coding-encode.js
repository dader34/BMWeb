// coding-encode: the INVERSE of the coding read decode -- turn a logical
// FSW value back into the exact netto bytes the ECU expects, and the forward
// decode that reads them, so a round-trip is provably lossless.
//
// Pure, offline, no hardware, no VM. Reference: emdzej/ncsx
//   docs/coding-flow.md      §3 (ENCODE: invert OPS, invert EINHEIT, splice)
//   docs/daten-format.md     §1.7 (OPERATION set) §1.8 (EINHEIT set)
//   docs/zcs-write.md        §2-3 (Mod-36 per-key prefix, 20-byte ZCS layout)
//   docs/ncsexper-fahrgestell-nr-format.md (VIN 18th char over "FP"+vin)
//
// A `rule` is a datenmap.js field object:
//   { name, block, word, byte, mask, shift,
//     values:[[pswName,hex]], unit?('d'|'a'|'A'|'b', omitted='h'),
//     ops?:[[opChar, operand]], dir?:true }
//
// word  = WORTADR   -- byte offset into the netto buffer
// byte  = BYTEADR   -- field width in bytes (mask array length in BMW's frame)
// mask  = the bit mask on the FIRST byte (single int; sub-byte fields);
//         wider fields carry mask 0xFF / shift 0 (raw LE bytes)
// shift = trailing-zero count of the mask (right-shift on read, left on write)

(function (root) {
  'use strict';

  // ---- 32-bit helpers -------------------------------------------------------
  const U32 = 0xffffffff;
  const u32 = (n) => (n >>> 0);

  // ---- OPERATION table (read direction) -------------------------------------
  // Applied in order on read; each transforms the assembled value.
  // (docs/daten-format.md §1.7)
  function applyOp(op, operand, value) {
    value = u32(value);
    const n = u32(operand);
    switch (op) {
      case '!': return u32(value ^ U32);
      case '&': return u32(value & n);
      case '*': return u32(Math.imul(value, n));
      case '+': return u32(value + n);
      case '-': return u32(value - n);
      case '/': return u32(n === 0 ? value : Math.floor(value / n));
      case '>': return u32((value >>> n) & (n >= 32 ? 0 : ((1 << (32 - n)) - 1) >>> 0));
      case '^': return u32(value ^ n);
      case '|': return u32(value | n);
      default:  return value;   // unknown op: pass through (matches NCSEXPER "skip + warn")
    }
  }

  // The inverse of a single op, for the ENCODE direction.
  // (docs/coding-flow.md §3 stage 3 table)
  function applyOpInverse(op, operand, value) {
    value = u32(value);
    const n = u32(operand);
    switch (op) {
      case '!': return u32(value ^ U32);              // self-inverse
      case '+': return u32(value - n);                // + -> -
      case '-': return u32(value + n);                // - -> +
      case '>': return u32((n >= 32 ? 0 : (value << n)) & U32);  // >(rshift) -> left-shift, 32b-bounded
      case '*': return u32(n === 0 ? value : Math.floor(value / n));  // * -> /
      case '/': return u32(Math.imul(value, n));      // / -> *
      case '&': return u32(value & n);                // self-inverse over covered bits
      case '|': return u32(value | n);                // self-inverse (idempotent set)
      case '^': return u32(value ^ n);                // self-inverse
      default:  return value;
    }
  }

  // ---- EINHEIT: assemble source bytes -> value (read) -----------------------
  //
  // CANONICAL VALUE MODEL. coding-edit.js codDatEnums (line ~390) records the
  // logical value as "the mask-normalised byte" -- an INTEGER. The EINHEIT char
  // is a DISPLAY gloss (how to print that byte: 'd' decimal, 'a'/'A' the char
  // it stands for, 'b' binary) and does NOT change the field's numeric identity
  // for a coding byte. So for the netto<->value codec, every unit assembles the
  // same width-bounded LE integer from the normalised source bytes.
  //
  // The one place EINHEIT genuinely re-encodes bytes is a multi-byte ASCII
  // STRING buffer ('A' base-36 / 'b' bitstring per daten-format.md §1.8). Those
  // are `dir` "property" fields (VIN, dates, keys) the UI keeps raw and never
  // stages through this codec; ZCS strings go through buildZcsRegion. We still
  // implement 'A'/'b' as true byte<->value inverses below for completeness, but
  // the datenmap corpus carries none, and coding-flow round-trips them as the
  // integer they normalise to either way.
  //
  // `bytes` is the already mask+shift-normalised per-position array
  // (length = rule.byte). Returns the numeric value BEFORE ops.
  function einheitDecode(unit, bytes) {
    const u = unit || 'h';
    if (u === 'A') {
      // each byte is one base-36 digit, MSB-first
      let v = 0;
      for (let i = 0; i < bytes.length; i++) {
        const c = bytes[i] & 0xff;
        let d;
        if (c >= 0x30 && c <= 0x39) d = c - 0x30;       // '0'-'9'
        else if (c >= 0x41 && c <= 0x5a) d = c - 0x37;  // 'A'-'Z' -> 10..35
        else d = 0;
        v = v * 36 + d;
      }
      return u32(v);
    }
    if (u === 'b') {
      // ASCII bitstring: char '0'/'1' at position i contributes bit i
      let v = 0;
      for (let i = 0; i < bytes.length; i++) {
        if ((bytes[i] & 0xff) === 0x31) v |= (1 << i);
      }
      return u32(v);
    }
    // 'h' / 'a' / 'd' / default: the normalised byte(s) ARE the value, LE.
    let v = 0;
    for (let i = 0; i < bytes.length; i++) v |= (bytes[i] & 0xff) << (8 * i);
    return u32(v);
  }

  // ---- EINHEIT: value -> source bytes (write, inverse of einheitDecode) ------
  // Produces exactly `width` bytes to be spliced (before mask/shift).
  function einheitEncode(unit, value, width) {
    const u = unit || 'h';
    const out = new Array(width).fill(0);
    value = u32(value);
    if (u === 'A') {
      // MSB-first base-36 digits, one ASCII char per byte
      let v = value;
      for (let i = width - 1; i >= 0; i--) {
        const d = v % 36; v = Math.floor(v / 36);
        out[i] = d < 10 ? (0x30 + d) : (0x41 + d - 10);  // '0'+v / 'A'+v-10
      }
      return out;
    }
    if (u === 'b') {
      // bit i -> '0'/'1' char at position i
      for (let i = 0; i < width; i++) out[i] = ((value >>> i) & 1) ? 0x31 : 0x30;
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
  function firstMask(rule) {
    return (rule.mask === undefined || rule.mask === null) ? 0xff : (rule.mask & 0xff);
  }
  function firstShift(rule) {
    return rule.shift || 0;
  }

  // A JS number holds a coding value exactly only up to 32 bits. Fields wider
  // than 4 bytes are raw BUFFERS (calibration tables, 16-byte filter blocks,
  // VIN strings) -- coding-edit.js treats their `values` hex as an opaque
  // buffer, never a number. For those the codec's value is a lowercase hex
  // string in ADDRESS order (byte at `word` first), matching datenmap's hex.
  function isBuffer(rule) { return (rule.byte || 1) > 4; }
  const HEX = '0123456789abcdef';
  const toHex = (b) => HEX[(b >> 4) & 0xf] + HEX[b & 0xf];

  // ---- decodeField: forward read (netto -> logical value) -------------------
  // The EXACT inverse of encodeField, used for round-trip proofs and to show
  // the value currently held in a read netto image. Returns a NUMBER for
  // <=4-byte fields, a hex STRING for wider buffers.
  function decodeField(rule, netto) {
    const width = rule.byte || 1;
    const at = rule.word || 0;

    if (isBuffer(rule)) {
      // raw buffer: address-order hex string, no mask/shift/ops (buffers ship
      // mask 0xFF / shift 0 / no ops in the corpus)
      let s = '';
      for (let i = 0; i < width; i++) s += toHex(netto[at + i] & 0xff);
      return s;
    }

    const m0 = firstMask(rule);
    const sh = firstShift(rule);
    // per-position normalised bytes: byte 0 is masked+shifted, the rest raw
    const bytes = new Array(width);
    for (let i = 0; i < width; i++) {
      const raw = netto[at + i] & 0xff;
      bytes[i] = (i === 0) ? ((raw & m0) >>> sh) : raw;
    }

    let value = einheitDecode(rule.unit, bytes);
    const ops = rule.ops || [];
    for (let k = 0; k < ops.length; k++) value = applyOp(ops[k][0], ops[k][1], value);
    return u32(value);
  }

  // ---- encodeField: inverse write (logical value -> mutate netto in place) ---
  function encodeField(rule, value, netto) {
    const width = rule.byte || 1;
    const at = rule.word || 0;

    if (isBuffer(rule)) {
      // hex string (or byte array) straight into the netto, address order
      let bytes;
      if (typeof value === 'string') {
        bytes = [];
        for (let i = 0; i + 1 < value.length; i += 2) bytes.push(parseInt(value.substr(i, 2), 16) & 0xff);
      } else {
        bytes = Array.from(value, (b) => b & 0xff);
      }
      for (let i = 0; i < width; i++) netto[at + i] = (bytes[i] || 0) & 0xff;
      return netto;
    }

    const m0 = firstMask(rule);
    const sh = firstShift(rule);

    // Stage 3: invert OPERATION list -- reverse order, each op inverted.
    let v = u32(value);
    const ops = rule.ops || [];
    for (let k = ops.length - 1; k >= 0; k--) v = applyOpInverse(ops[k][0], ops[k][1], v);

    // Stage 4: invert EINHEIT to source bytes.
    const enc = einheitEncode(rule.unit, v, width);

    // Stage 5: splice with mask+shift. Non-destructive: only the mask's bits of
    // each netto byte are touched, so a neighbour sharing the byte survives.
    for (let i = 0; i < width; i++) {
      if (i === 0) {
        const placed = (enc[0] << sh) & m0;
        netto[at + i] = ((netto[at + i] & (~m0 & 0xff)) | placed) & 0xff;
      } else {
        // wider positions are always full bytes (mask 0xFF, shift 0)
        netto[at + i] = enc[i] & 0xff;
      }
    }
    return netto;
  }

  // ---- spliceEdits: apply staged changes onto a COPY of the read image ------
  // edits = [{rule, value}]. Never builds from zeros -- edits ride on top of
  // the bytes actually read from the ECU.
  function spliceEdits(netto, edits) {
    const out = new Uint8Array(netto.length);
    out.set(netto);
    for (const e of (edits || [])) encodeField(e.rule, e.value, out);
    return out;
  }

  // ===========================================================================
  // Identity / ZCS math (docs/zcs-write.md §2-3, fahrgestell-nr-format.md)
  // ===========================================================================

  // Mod-36 digit decode: '0'-'9' -> 0..9, 'A'-'Z' -> 10..35. -1 on invalid.
  function mod36Decode(code) {
    if (code >= 0x30 && code <= 0x39) return code - 0x30;
    if (code >= 0x41 && code <= 0x5a) return code - 0x41 + 10;
    return -1;
  }
  // Mod-36 digit encode: 0..9 -> '0'-'9', 10..35 -> 'A'-'Z'.
  function mod36Encode(v) {
    if (v < 10) return String.fromCharCode(0x30 + v);
    return String.fromCharCode(0x41 + (v - 10));
  }

  // Core weighted Mod-36 sum over an already-assembled input string.
  // sum starts 0; for each char i, v = decode(char); if i EVEN v*=3;
  // sum = (sum + v) & 0xFFFF. Check = mod36Encode((int16)sum % 36 normalised).
  function mod36Core(input) {
    let sum = 0;
    for (let i = 0; i < input.length; i++) {
      let v = mod36Decode(input.charCodeAt(i));
      if (v < 0) throw new Error('mod36: invalid char ' + JSON.stringify(input[i]));
      if ((i & 1) === 0) v = v * 3;
      sum = (sum + v) & 0xffff;
    }
    // signed int16 -> mod 36, normalised into 0..35
    let s = sum & 0xffff;
    if (s & 0x8000) s -= 0x10000;
    let r = s % 36;
    if (r < 0) r += 36;
    return mod36Encode(r);
  }

  // Per-key ZCS check char. prefix: 'C1'=GM, 'C2'=SA, 'C3'=VN.
  function mod36(prefix, body) {
    return mod36Core(prefix + body);
  }
  const formatGm = (body) => body + mod36('C1', body);   // 8 -> 9 chars
  const formatSa = (body) => body + mod36('C2', body);   // 16 -> 17 chars
  const formatVn = (body) => body + mod36('C3', body);   // 10 -> 11 chars

  // VIN 18th char: Mod-36 over "FP" + vin (same core).
  function vinCheckChar(vin) {
    return mod36Core('FP' + vin);
  }
  const formatFahrgestellNr = (vin) => vin + vinCheckChar(vin);  // 17 -> 18 chars

  // ---- buildZcsRegion: the fixed 20-byte ZCS layout -------------------------
  // [GM 4B body][GM chk 1B][SA 8B body][SA chk 1B][VN 5B body][VN chk 1B]
  // Bodies are nibble-packed (high nibble = first hex char). Check chars are
  // ASCII. Spliced at baseAddr into netto. (docs/zcs-write.md §3)
  function packNibbles(hexBody, byteLen) {
    const out = new Array(byteLen).fill(0);
    for (let i = 0; i < byteLen; i++) {
      const hi = hexBody.charCodeAt(2 * i);
      const lo = hexBody.charCodeAt(2 * i + 1);
      out[i] = ((hexNibble(hi) << 4) | hexNibble(lo)) & 0xff;
    }
    return out;
  }
  function hexNibble(code) {
    if (code >= 0x30 && code <= 0x39) return code - 0x30;
    if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;  // A-F
    if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;  // a-f
    return 0;
  }

  function buildZcsRegion(gmBody, saBody, vnBody, baseAddr, netto) {
    const region = new Array(20);
    let p = 0;
    // GM: 4 body bytes + 1 check ASCII
    const gm = packNibbles(gmBody, 4);
    for (let i = 0; i < 4; i++) region[p++] = gm[i];
    region[p++] = mod36('C1', gmBody).charCodeAt(0);
    // SA: 8 body bytes + 1 check
    const sa = packNibbles(saBody, 8);
    for (let i = 0; i < 8; i++) region[p++] = sa[i];
    region[p++] = mod36('C2', saBody).charCodeAt(0);
    // VN: 5 body bytes + 1 check
    const vn = packNibbles(vnBody, 5);
    for (let i = 0; i < 5; i++) region[p++] = vn[i];
    region[p++] = mod36('C3', vnBody).charCodeAt(0);
    // splice the 20 bytes at baseAddr
    for (let i = 0; i < 20; i++) netto[baseAddr + i] = region[i] & 0xff;
    return netto;
  }

  // ---- exports (browser global, matching app/renderer/core/*.js style) ------
  const api = {
    encodeField, decodeField, spliceEdits,
    applyOp, applyOpInverse, einheitDecode, einheitEncode,
    mod36, mod36Decode, mod36Encode,
    formatGm, formatSa, formatVn,
    vinCheckChar, formatFahrgestellNr,
    buildZcsRegion,
  };
  root.CodingEncode = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
