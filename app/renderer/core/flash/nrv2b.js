// NRV2B (UCL 1.03) packing for the resident flasher: the encoder runs here
// in the app, the decoder runs on the DME (a few hundred bytes of PPC code;
// `decode` below is the same bit-level format, kept for tests and for
// reading a flasher stream back). The bit writer, the codes and the decoder
// are ported from the reference sources -- src/n2b_99.c and src/n2b_d.c of
// ucl-1.03 (Oberhumer, GPL) -- not reimplemented from memory: the wire
// format is byte-for-byte what ucl_nrv2b_decompress_8 reads. The parse (which
// matches to code) is this file's own: the wire is what a flash waits on, so
// it looks for the fewest bits rather than UCL's greedy-with-lazy choice --
// 5 % fewer bytes on a calibration and 10 % on the program (stock 0044570).
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
// following bits): the parse never offers it.

const nrv2b = (() => {
  // -- the bit writer, exactly ucl_mchw.ch's bbPutBit/bbPutByte/bbFlushBits:
  // bits fill a byte MSB-first; the group byte is RESERVED at the output
  // position where the group opened, and data bytes (bbPutByte) append at
  // the end, past the reserved byte. The decoder reads a literal as a whole
  // source byte from after the group byte -- that layout is the format.
  class BitWriter {
    constructor() {
      this.bytes = [];
      this.pend = -1; // index of the open group byte
      this.n = 0; // bits already in it
    }
    bit(b) {
      if (this.n === 0) {
        // bbPutBit: bb_p = bb_op++
        this.pend = this.bytes.length;
        this.bytes.push(0);
      }
      if (b) this.bytes[this.pend] |= 0x80 >> this.n;
      if (++this.n === 8) {
        this.n = 0;
        this.pend = -1;
      }
    }
    byte(v) {
      // bbPutByte: *bb_op++ = b
      this.bytes.push(v & 0xff);
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
      do {
        t <<= 1;
      } while (i >= t);
      t >>= 1;
      do {
        t >>= 1;
        w.bit(i & t ? 1 : 0);
        w.bit(0);
      } while (t > 2);
    }
    w.bit(i & 1);
    w.bit(1);
  }

  const MAX_MATCH = 2048; // SWD_F: the longest match one code carries
  const MAX_OFFSET = 0xffff;
  const FAR = 0xd00; // an offset past this costs the length one step
  const LITERAL_BITS = 9;
  const MAX_CHAIN = 128; // earlier places a position may try

  // The bits of the length code, by the reduced length (len - 2, less one
  // past FAR): two, or 0 0 ss11(m - 3) -- len_of_coded_match in n2_99.ch.
  const LEN_BITS = new Uint8Array(MAX_MATCH);
  for (let m = 0; m < MAX_MATCH; m++)
    LEN_BITS[m] = m < 3 ? 2 : 2 + 2 * Math.max(1, 32 - Math.clz32(m - 3));

  /**
   * The bits of a match before its length: the flag, and the offset -- two
   * bits when it is the previous match's, else ss11 of the high bits and
   * the low byte.
   */
  function offsetBits(off, rep) {
    return 1 + (rep ? 2 : 10 + 2 * (32 - Math.clz32((off - 1) >> 8)));
  }

  // code_match / code_run from n2_99.ch, NRV2B branch, verbatim structure.
  function codeMatch(w, len, off, state) {
    w.bit(0);
    if (off === state.lastOff) {
      w.bit(0);
      w.bit(1);
    } else {
      ss11(w, 1 + ((off - 1) >> 8));
      w.byte(off - 1);
    }
    const l = len - 1 - (off > FAR ? 1 : 0);
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

  // The parse: the cheapest in bits, by a forward pass over the chunk.
  // cost[i] is the fewest bits found for data[0..i), with the step that
  // arrives there and the offset of the last match on that path (the
  // "same offset again" code is two bits where a new offset is ten or
  // more, so the path's last offset is part of what a position is worth).
  // From every position: a literal, the last offset again at every length
  // it matches, and for every longer length the nearest earlier place that
  // matches that far -- found on a chain of the positions sharing its first
  // two bytes, each position entered exactly once. A match that runs as far
  // as one can (the code's longest, or to the chunk's end) is taken whole
  // and the positions inside it are not weighed: nothing shorter beats it,
  // and a run of one byte would otherwise weigh every length at every place.
  function encode(data) {
    const n = data.length;
    const cost = new Int32Array(n + 1).fill(0x7fffffff);
    const stepLen = new Int32Array(n + 1);
    const stepOff = new Int32Array(n + 1); // 0: the step is a literal
    const lastOff = new Int32Array(n + 1);
    const head = new Int32Array(0x10000).fill(-1);
    const prev = new Int32Array(n);
    cost[0] = 0;
    lastOff[0] = 1; // the decoder's own start

    const relax = (to, bits, len, off, last) => {
      if (bits > cost[to]) return; // a tie goes to the later offer
      cost[to] = bits;
      stepLen[to] = len;
      stepOff[to] = off;
      lastOff[to] = last;
    };
    let skipTo = 0; // below it: inside a match taken whole
    for (let i = 0; i < n; i++) {
      const room = Math.min(n - i, MAX_MATCH);
      if (i >= skipTo) {
        const rep = lastOff[i];
        relax(i + 1, cost[i] + LITERAL_BITS, 1, 0, rep);
        let best = 1; // lengths up to here are on offer already
        // a match of l bytes at `off`: its lengths above `best`, or only
        // the whole of it when it runs as far as a match can
        const offer = (off, l, same) => {
          const far = off > FAR ? 1 : 0;
          if (l < 2 + far) return; // a 2-byte match past FAR has no code
          const base = cost[i] + offsetBits(off, same);
          const whole = l === room;
          for (
            let len = whole ? l : Math.max(best + 1, 2 + far);
            len <= l;
            len++
          )
            relax(i + len, base + LEN_BITS[len - 2 - far], len, off, off);
          best = l;
          if (whole) skipTo = i + l;
        };
        if (room >= 2 && rep <= i) {
          // the last offset again: no other codes its lengths in fewer bits
          let l = 0;
          while (l < room && data[i - rep + l] === data[i + l]) l++;
          offer(rep, l, true);
        }
        for (
          let cand = room >= 2 ? head[(data[i] << 8) | data[i + 1]] : -1,
            left = MAX_CHAIN;
          cand >= 0 && left > 0 && best < room && i - cand <= MAX_OFFSET;
          cand = prev[cand], left--
        ) {
          if (data[cand + best] !== data[i + best]) continue; // no longer
          let l = 2;
          while (l < room && data[cand + l] === data[i + l]) l++;
          if (l > best) offer(i - cand, l, false);
        }
      }
      if (i + 1 < n) {
        const h = (data[i] << 8) | data[i + 1];
        prev[i] = head[h];
        head[h] = i;
      }
    }

    // back along the steps from the end, then out in order
    const ends = [];
    for (let at = n; at > 0; at -= stepLen[at]) ends.push(at);
    const w = new BitWriter();
    const state = { lastOff: 1 };
    for (let k = ends.length - 1; k >= 0; k--) {
      const at = ends[k];
      if (stepOff[at]) codeMatch(w, stepLen[at], stepOff[at], state);
      else {
        w.bit(1);
        w.byte(data[at - 1]);
      }
    }

    // EOF: 0 ss11(0x1000000) 0xFF -- the decoder reads (v-3)*256 + 0xFF =
    // 0xFFFFFFFF and stops. Our chunks are length-framed too, so a decoder
    // may stop on length; a reference ucl decoder needs the marker. The
    // trailing pad bits of the last group byte are already zero.
    w.bit(0);
    ss11(w, 0x1000000);
    w.byte(0xff);
    return Uint8Array.from(w.bytes);
  }

  // The decoder: n2b_d.c with the getbit_8 bit buffer, translated directly.
  // Reads until outLen bytes are written or the EOF marker arrives.
  function decode(src, outLen) {
    const out = new Uint8Array(outLen);
    let ilen = 0,
      olen = 0,
      bb = 0,
      lastOff = 1;
    const getbit = () => {
      if (bb & 0x7f) {
        bb *= 2;
      } else {
        if (ilen >= src.length) throw new Error('nrv2b: input overrun');
        bb = src[ilen++] * 2 + 1;
      }
      return (bb >> 8) & 1;
    };
    while (olen < outLen) {
      while (getbit()) {
        if (ilen >= src.length || olen >= outLen)
          throw new Error('nrv2b: input overrun');
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
        if (ilen >= src.length) throw new Error('nrv2b: input overrun');
        off = (code - 3) * 256 + src[ilen++];
        if (off === 0xffffffff) break;
        lastOff = ++off;
      }
      let mLen = getbit();
      mLen = mLen * 2 + getbit();
      if (mLen === 0) {
        mLen++;
        do {
          mLen = mLen * 2 + getbit();
        } while (!getbit());
        mLen += 2;
      }
      mLen += off > 0xd00 ? 1 : 0;
      if (off > olen) throw new Error('nrv2b: lookbehind overrun');
      if (olen + mLen + 1 > outLen) throw new Error('nrv2b: output overrun');
      let mPos = olen - off;
      out[olen++] = out[mPos++];
      do {
        out[olen++] = out[mPos++];
      } while (--mLen > 0);
    }
    if (olen !== outLen) throw new Error('nrv2b: stream ended early');
    return out;
  }

  return { encode, decode };
})();

if (typeof window !== 'undefined') {
  window.nrv2b = nrv2b;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { nrv2b };
}
