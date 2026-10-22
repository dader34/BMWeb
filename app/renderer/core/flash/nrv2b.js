// NRV2B (UCL 1.03) packing for the resident flasher: the encoder runs here
// in the app, the decoder runs on the DME (a few hundred bytes of PPC code;
// `decode` below is the same bit-level format, kept for tests and for
// reading a flasher stream back). Ported from the reference sources --
// src/n2b_99.c and src/n2b_d.c of ucl-1.03 (Oberhumer, GPL) -- not
// reimplemented from memory: the wire format is byte-for-byte what
// ucl_nrv2b_decompress_8 reads.
//
// The format, 8-bit bit buffer, bits consumed MSB-first per byte (the
// decoder refills one byte at a time, so no endianness question ever
// reaches the PPC side). Two kinds of byte interleave on the wire: bit-group
// bytes and whole data bytes. A group byte sits at the position where its
// first bit was emitted; data bytes (literals, the offset byte, the EOF
// byte) emitted while that group is open go AFTER it, and the decoder grabs
// them whole off the same linear read pointer it refills bits from:
//
//   literal           1 (a bit) <byte>      (the byte from the stream, not
//                                           shifted through the bit buffer)
//   match             0
//     offset          off == last:  0 1                (the decoder's code 2)
//                     otherwise:    ss11(1 + ((off-1) >> 8)) <off-1 & 0xFF>
//     length          L' = len - 1 - (off > 0xd00)
//                     L' <= 3:      two bits (L' > 1), (L' & 1)
//                     else:         0 0 ss11(L' - 4)
//   EOF               0 ss11(0x1000000) 0xFF
//
// ss11 is start-step-stop prefix coding: (bit, 0) pairs down from the high
// bits of i + 2, then the low bit, then a 1. The decoder inverts it as
// v = 1; do { v = v*2 + bit } while (!bit);  -- so v = i + 2. The offset
// code v maps to off = (v-3)*256 + byte + 1, and v == 2 (i.e. ss11(0)) is
// reserved for "same offset as the previous match".
//
// A length of 2 is only encodable when off <= 0xd00 (beyond that the >0xd00
// adjustment drives L' to 0, which would decode as a long match and eat
// following bits): the cost model refuses it, and so does the encoder.

const nrv2b = (() => {
  // -- the bit writer, exactly ucl_mchw.ch's bbPutBit/bbPutByte/bbFlushBits:
  // bits fill a byte MSB-first; the group byte is RESERVED at the output
  // position where the group opened, and data bytes (bbPutByte) append at
  // the end, past the reserved byte. The decoder reads a literal as a whole
  // source byte from after the group byte -- that layout is the format.
  class BitWriter {
    constructor() {
      this.bytes = [];
      this.pend = -1;                          // index of the open group byte
      this.n = 0;                              // bits already in it
    }
    bit(b) {
      if (this.n === 0) {                      // bbPutBit: bb_p = bb_op++
        this.pend = this.bytes.length;
        this.bytes.push(0);
      }
      if (b) this.bytes[this.pend] |= 0x80 >> this.n;
      if (++this.n === 8) { this.n = 0; this.pend = -1; }
    }
    byte(v) {                                  // bbPutByte: *bb_op++ = b
      this.bytes.push(v & 0xFF);
    }
    // bbFlushBits(0): the open group byte is already placed; its unwritten
    // low bits stay zero, and the decoder never consumes them -- no-op.
  }

  // code_prefix_ss11 from n2_99.ch: i >= 2 emits the (bit, 0) staircase of
  // i + 2's high bits, then every case ends with (i & 1, 1).
  function ss11(w, i) {
    if (i >= 2) {
      let t = 4;
      i += 2;
      do { t <<= 1; } while (i >= t);
      t >>= 1;
      do {
        t >>= 1;
        w.bit((i & t) ? 1 : 0);
        w.bit(0);
      } while (t > 2);
    }
    w.bit(i & 1);
    w.bit(1);
  }

  // The encoder's cost of coding a match, in bits -- len_of_coded_match
  // from n2_99.ch, used for the lazy decision. -1 = not codable.
  function matchCost(len, off, lastOff, maxOffset) {
    if (len < 2 || (len === 2 && off > 0xd00) || off > maxOffset) return -1;
    let mLen = len - 2 - (off > 0xd00 ? 1 : 0);
    let b = off === lastOff ? 1 + 2 : 1 + 10;
    if (off !== lastOff) {
      let o = (off - 1) >> 8;
      while (o > 0) { b += 2; o >>= 1; }
    }
    b += 2;
    if (mLen < 3) return b;
    mLen -= 3;
    do { b += 2; mLen >>= 1; } while (mLen > 0);
    return b;
  }

  const MAX_MATCH = 2048;                      // SWD_F; longer matches split
  const HASH_SIZE = 1 << 16;

  // A hash-chain match finder over the chunk (the chunks are independent,
  // so the window is the whole input -- UCL's swd with n = in_len). Finds
  // the longest match for pos; the chain is ordered newest-first, so equal
  // lengths keep the smallest offset.
  function findMatch(data, head, prev, pos, maxChain, niceLen) {
    if (pos + 3 > data.length) return null;    // a 3-byte hash needs three bytes
    let bestLen = 1, bestOff = 0;
    const limit = pos > 0xFFFF ? pos - 0xFFFF : 0;   // offsets are uint16 here
    const end = data.length;
    let cand = head[(data[pos] << 16 | data[pos + 1] << 8 | data[pos + 2]) & 0xFFFF];
    let chain = maxChain;
    while (cand >= limit && cand < pos && chain-- > 0) {   // cand < pos, always
      let len = 0;
      while (len < MAX_MATCH && pos + len < end && data[cand + len] === data[pos + len]) len++;
      if (len > bestLen) {
        bestLen = len;
        bestOff = pos - cand;
        if (len >= niceLen) break;
      }
      const nx = prev[cand];
      if (nx >= cand) break;                   // chains must decrease; else stop
      cand = nx;
    }
    return bestLen >= 2 ? [bestLen, bestOff] : null;
  }

  function insertPos(data, head, prev, pos) {
    if (pos + 3 > data.length) return;
    const h = (data[pos] << 16 | data[pos + 1] << 8 | data[pos + 2]) & 0xFFFF;
    prev[pos] = head[h];
    head[h] = pos;
  }

  // code_match / code_run from n2_99.ch, NRV2B branch, verbatim structure.
  function codeMatch(w, len, off, state) {
    while (len > MAX_MATCH) {                  // overlong: split into pieces
      codeMatch(w, MAX_MATCH - 3, off, state);
      len -= MAX_MATCH - 3;
    }
    w.bit(0);
    if (off === state.lastOff) {
      w.bit(0);
      w.bit(1);
    } else {
      ss11(w, 1 + ((off - 1) >> 8));
      w.byte(off - 1);
    }
    const l = len - 1 - (off > 0xd00 ? 1 : 0);
    if (l >= 4) {
      w.bit(0);
      w.bit(0);
      ss11(w, l - 4);
    } else {
      w.bit(l > 1 ? 1 : 0);
      w.bit(l & 1);
    }
    state.lastOff = off;
  }

  // The parse: greedy with UCL's own lazy decision (n2_99.ch, level-9
  // shape) -- take the later match when coding the literals in between
  // still wins: l1 + (ahead + len2 - len) * 5 > l2 + ahead * 9. Every
  // position examined enters the chains exactly once, whatever the parse
  // decides, which is what UCL's swd skip logic amounts to.
  function encode(data, opts) {
    const maxChain = (opts && opts.maxChain) || 256;
    const tryLazy = (opts && opts.tryLazy !== undefined) ? opts.tryLazy : 2;
    const goodLen = (opts && opts.goodLen) || 32;
    const maxLazy = (opts && opts.maxLazy) || 128;
    const niceLen = (opts && opts.niceLen) || 128;

    const w = new BitWriter();
    const head = new Int32Array(HASH_SIZE).fill(-1);
    const prev = new Int32Array(data.length);
    const state = { lastOff: 1 };

    let litStart = 0, lit = 0;                 // the pending literal run
    let pos = 0;

    while (pos < data.length) {
      const match = findMatch(data, head, prev, pos, maxChain, niceLen);
      insertPos(data, head, prev, pos);

      if (!match || matchCost(match[0], match[1], state.lastOff, 0xFFFF) < 0) {
        lit++;                                 // a literal
        pos++;
        continue;
      }
      let [len, off] = match;

      // the lazy look: up to tryLazy positions ahead
      if (tryLazy > 0 && len < maxLazy && off !== state.lastOff) {
        const l1 = matchCost(len, off, state.lastOff, 0xFFFF);
        const maxAhead = Math.min(tryLazy, len - 1);
        for (let ahead = 1; ahead <= maxAhead && pos + ahead + 2 < data.length; ahead++) {
          const m2 = findMatch(data, head, prev, pos + ahead,
                               len >= goodLen ? maxChain >> 2 : maxChain, niceLen);
          insertPos(data, head, prev, pos + ahead);   // search FIRST: a chain
          if (!m2) continue;                          // holds its own position too
          if (!m2) continue;
          const l2 = matchCost(m2[0], m2[1], state.lastOff, 0xFFFF);
          if (l2 < 0) continue;
          if (l1 + (ahead + m2[0] - len) * 5 > l2 + ahead * 9) {
            lit += ahead;                      // the gap becomes literals
            pos += ahead;
            [len, off] = m2;
            break;
          }
        }
      }

      // 1 - the literal run, 2 - the match (n2_99.ch order)
      for (let i = 0; i < lit; i++) { w.bit(1); w.byte(data[litStart + i]); }
      codeMatch(w, len, off, state);

      // advance past the match, inserting every covered position once
      pos++;
      litStart = pos + len - 1;
      lit = 0;
      for (let i = 1; i < len && pos < data.length; i++, pos++) {
        insertPos(data, head, prev, pos);
      }
    }
    for (let i = 0; i < lit; i++) { w.bit(1); w.byte(data[litStart + i]); }

    // EOF: 0 ss11(0x1000000) 0xFF -- the decoder reads (v-3)*256 + 0xFF =
    // 0xFFFFFFFF and stops. Our chunks are length-framed too, so a decoder
    // may stop on length; a reference ucl decoder needs the marker. The
    // trailing pad bits of the last group byte are already zero.
    w.bit(0);
    ss11(w, 0x1000000);
    w.byte(0xFF);
    return Uint8Array.from(w.bytes);
  }

  // The decoder: n2b_d.c with the getbit_8 bit buffer, translated directly.
  // Reads until outLen bytes are written or the EOF marker arrives.
  function decode(src, outLen) {
    const out = new Uint8Array(outLen);
    let ilen = 0, olen = 0, bb = 0, lastOff = 1;
    const getbit = () => {
      if (bb & 0x7F) { bb *= 2; } else {
        if (ilen >= src.length) throw new Error("nrv2b: input overrun");
        bb = src[ilen++] * 2 + 1;
      }
      return (bb >> 8) & 1;
    };
    while (olen < outLen) {
      while (getbit()) {
        if (ilen >= src.length || olen >= outLen) throw new Error("nrv2b: input overrun");
        out[olen++] = src[ilen++];
      }
      let code = 1;
      do {
        code = code * 2 + getbit();
      } while (!getbit());
      let off;
      if (code === 2) {
        off = lastOff;
      } else {
        if (ilen >= src.length) throw new Error("nrv2b: input overrun");
        off = (code - 3) * 256 + src[ilen++];
        if (off === 0xFFFFFFFF) break;
        lastOff = ++off;
      }
      let mLen = getbit();
      mLen = mLen * 2 + getbit();
      if (mLen === 0) {
        mLen++;
        do { mLen = mLen * 2 + getbit(); } while (!getbit());
        mLen += 2;
      }
      mLen += off > 0xd00 ? 1 : 0;
      if (off > olen) throw new Error("nrv2b: lookbehind overrun");
      if (olen + mLen + 1 > outLen) throw new Error("nrv2b: output overrun");
      let mPos = olen - off;
      out[olen++] = out[mPos++];
      do { out[olen++] = out[mPos++]; } while (--mLen > 0);
    }
    if (olen !== outLen) throw new Error("nrv2b: stream ended early");
    return out;
  }

  return { encode, decode, matchCost };
})();

if (typeof window !== 'undefined') {
  window.nrv2b = nrv2b;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { nrv2b };
}
