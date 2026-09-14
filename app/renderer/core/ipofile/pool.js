/**
 * @file Constant pool of an .IPO, decoded in the browser.
 *
 * Port of tools/decompile/ipo_disasm.py's find_pool / _tok_pool /
 * _find_pool_suffix. The pool is the body of a declaration literally named
 * "Constant Data": a typed literal stream, one entry per source literal, in
 * emission order. The code stream refers to entries by index, so getting the
 * pool's START byte right is what makes every `const` token correct -- a start
 * one entry early shifts every index in the file.
 *
 * Kept byte-for-byte faithful to the Python because the shipped
 * data/inpa-ir/<stem>.ipoexec.json dumps are produced by that code: a dropped
 * script has to decode to the same tokens the shipped ones did, or the same
 * runtime would run two different programs depending on where the file came
 * from.
 */

/** Bytes a pool string may contain: everything printable-ish except newline. */
const IPOF_PRINTABLE_LO = 0x09;

/**
 * Whether a byte may appear inside a pool string.
 *
 * @param {number} c Byte value.
 * @returns {boolean} True when the byte is allowed in a string entry.
 */
function ipofPrintable(c) {
  return c >= IPOF_PRINTABLE_LO && c !== 0x0a;
}

/**
 * Read a little-endian unsigned integer from a byte array.
 *
 * @param {Uint8Array} data The file bytes.
 * @param {number} at Offset of the first byte.
 * @param {number} n Byte count (1..4).
 * @returns {number} The value.
 */
function ipofUint(data, at, n) {
  let v = 0;
  for (let k = n - 1; k >= 0; k -= 1) v = v * 256 + data[at + k];
  return v;
}

/**
 * Decode `n` bytes as latin-1 text, the encoding INPA's own tooling uses.
 *
 * @param {Uint8Array} data The file bytes.
 * @param {number} lo First byte offset.
 * @param {number} hi End offset, exclusive.
 * @returns {string} The decoded text.
 */
function ipofLatin1(data, lo, hi) {
  let s = '';
  for (let i = lo; i < hi; i += 1) s += String.fromCharCode(data[i]);
  return s;
}

/**
 * Index of the next newline in `data` within a window, or -1.
 *
 * @param {Uint8Array} data The file bytes.
 * @param {number} from First offset to look at.
 * @param {number} to End offset, exclusive.
 * @returns {number} The offset of the newline, or -1.
 */
function ipofFindNl(data, from, to) {
  const end = Math.min(to, data.length);
  for (let i = Math.max(0, from); i < end; i += 1)
    if (data[i] === 0x0a) return i;
  return -1;
}

/**
 * Read a 64-bit float, the pool's `real` entry.
 *
 * @param {Uint8Array} data The file bytes.
 * @param {number} at Offset of the first byte.
 * @returns {number} The value.
 */
function ipofFloat64(data, at) {
  const dv = new DataView(data.buffer, data.byteOffset + at, 8);
  return dv.getFloat64(0, true);
}

/**
 * Tokenize `data[start:end]` as a pure literal stream.
 *
 * Entry types match the Python: 06 string, 03 int, 05 real, 01 bool, 02 byte,
 * 04 long. Each entry becomes `[typeLetter, value]` exactly as the Python
 * tuples do, because the walker inlines both fields into every const token.
 *
 * @param {Uint8Array} data The file bytes.
 * @param {number} start First offset.
 * @param {number} end End offset, exclusive.
 * @returns {Array<Array>|null} The entries, or null when the region is not a
 *   clean literal stream.
 */
function ipofTokPool(data, start, end) {
  const entries = [];
  let i = start;
  while (i < end) {
    const t = data[i];
    if (t === 0x06) {
      // No length cap: one corpus pool holds a 377-byte string, and the
      // declaration's entry count validates the walk end to end anyway.
      const j = ipofFindNl(data, i + 1, data.length);
      if (j < 0) return null;
      for (let k = i + 1; k < j; k += 1)
        if (!ipofPrintable(data[k])) return null;
      entries.push(['s', ipofLatin1(data, i + 1, j)]);
      i = j + 1;
    } else if (t === 0x03) {
      if (i + 3 > end) return null;
      entries.push(['i', ipofUint(data, i + 1, 2)]);
      i += 3;
    } else if (t === 0x05) {
      if (i + 9 > end) return null;
      entries.push(['d', ipofFloat64(data, i + 1)]);
      i += 9;
    } else if (t === 0x01) {
      if (i + 2 > end) return null;
      entries.push(['b', data[i + 1]]);
      i += 2;
    } else if (t === 0x02) {
      if (i + 2 > end) return null;
      entries.push(['y', data[i + 1]]);
      i += 2;
    } else if (t === 0x04) {
      if (i + 5 > end) return null;
      entries.push(['l', ipofUint(data, i + 1, 4)]);
      i += 5;
    } else {
      return null;
    }
  }
  return entries;
}

/**
 * Every offset at which the byte pattern occurs.
 *
 * @param {Uint8Array} data The file bytes.
 * @param {number[]} pat The bytes to find.
 * @param {number} from First offset to search from.
 * @param {number} to End offset, exclusive.
 * @returns {number[]} The matching offsets.
 */
function ipofFindAll(data, pat, from, to) {
  const out = [];
  const end = Math.min(to, data.length) - pat.length;
  for (let i = from; i <= end; i += 1) {
    let ok = true;
    for (let k = 0; k < pat.length; k += 1) {
      if (data[i + k] !== pat[k]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The literal bytes of the pool declaration's name, ".Constant Data\n". */
const IPOF_POOL_NAME = Array.from('Constant Data').map((c) => c.charCodeAt(0));

/**
 * Match the pool declaration header at a candidate name offset.
 *
 * The declaration has the same grammar as every proc:
 * `<type> <name> \n <u32 id> \n [version] \n \x00 <u16 count>`; the u16 is the
 * ENTRY COUNT, which is what validates the walk.
 *
 * @param {Uint8Array} data The file bytes.
 * @param {number} nameAt Offset of the "C" of "Constant Data".
 * @returns {{start: number, declared: number}|null} Body start and declared
 *   entry count, or null when the bytes are not a declaration.
 */
function ipofPoolHeader(data, nameAt) {
  let i = nameAt + IPOF_POOL_NAME.length;
  if (data[i] !== 0x0a) return null;
  i += 1;
  if (i + 4 > data.length) return null;
  i += 4; // the u32 id
  if (data[i] !== 0x0a) return null;
  i += 1;
  // the optional version string: up to 32 printable bytes, then a newline
  let j = i;
  const cap = Math.min(data.length, i + 33);
  while (j < cap && data[j] !== 0x0a) {
    if (data[j] < 0x20 || data[j] > 0x7e) return null;
    j += 1;
  }
  if (j >= cap || data[j] !== 0x0a) return null;
  i = j + 1;
  if (data[i] !== 0x00 || i + 3 > data.length) return null;
  return { start: i + 3, declared: ipofUint(data, i + 1, 2) };
}

/**
 * The constant pool: its start offset and its entries.
 *
 * The LAST "Constant Data" declaration wins, as in the Python -- earlier
 * matches can be a string inside the code region.
 *
 * @param {Uint8Array} data The file bytes.
 * @returns {{start: number|null, entries: Array<Array>}} Pool start (null when
 *   the file has none) and the decoded entries.
 */
function ipofFindPool(data) {
  const hits = ipofFindAll(data, IPOF_POOL_NAME, 0, data.length);
  for (let k = hits.length - 1; k >= 0; k -= 1) {
    const hdr = ipofPoolHeader(data, hits[k]);
    if (!hdr) continue;
    const entries = ipofTokPool(data, hdr.start, data.length);
    if (entries && (entries.length & 0xffff) === hdr.declared) {
      return { start: hdr.start, entries };
    }
    break; // the last declaration is the pool
  }
  return ipofFindPoolSuffix(data);
}

/**
 * Fallback: the longest EOF-suffix that tokenizes as literals AND whose
 * indexing agrees with the code's own references.
 *
 * A too-early start prepends fake entries and shifts every index, so
 * candidates are scored on a semantic anchor: at a sampled
 * `text(row, col, str)` call site, pool[r..r+2] must type-match (int,int,str).
 *
 * @param {Uint8Array} data The file bytes.
 * @returns {{start: number|null, entries: Array<Array>}} Pool start and entries.
 */
function ipofFindPoolSuffix(data) {
  const n = data.length;
  // ok[i]: data[i:] tokenizes cleanly to EOF. Computed descending, O(n).
  const ok = new Uint8Array(n + 1);
  ok[n] = 1;
  for (let i = n - 1; i >= 0; i -= 1) {
    const t = data[i];
    if (t === 0x06) {
      const j = ipofFindNl(data, i + 1, i + 221);
      if (j >= 0) {
        let clean = true;
        for (let k = i + 1; k < j; k += 1)
          if (!ipofPrintable(data[k])) {
            clean = false;
            break;
          }
        if (clean) ok[i] = ok[j + 1];
      }
    } else if (t === 0x03 && i + 3 <= n) ok[i] = ok[i + 3];
    else if (t === 0x05 && i + 9 <= n) ok[i] = ok[i + 9];
    else if ((t === 0x01 || t === 0x02) && i + 2 <= n) ok[i] = ok[i + 2];
    else if (t === 0x04 && i + 5 <= n) ok[i] = ok[i + 5];
  }
  let good = null;
  let run = 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    if (ok[i]) {
      good = i;
      run = 0;
    } else {
      run += 1;
      if (good !== null && run > 6000) break;
    }
  }
  if (good === null) return { start: null, entries: [] };
  // candidate boundaries: the offset of every entry from `good` forward
  const offs = [];
  let i = good;
  while (i < n) {
    offs.push(i);
    const t = data[i];
    if (t === 0x06) i = ipofFindNl(data, i + 1, n) + 1;
    else if (t === 0x03) i += 3;
    else if (t === 0x05) i += 9;
    else if (t === 0x01 || t === 0x02) i += 2;
    else if (t === 0x04) i += 5;
    else break;
  }
  // sample text-call anchors in the code region [0, good)
  const anchors = [];
  for (let p = 0; p + 15 <= good; p += 1) {
    if (data[p] !== 0x01 || data[p + 1] !== 0x01) continue;
    if (data[p + 4] !== 0x01 || data[p + 5] !== 0x01) continue;
    if (data[p + 8] !== 0x01 || data[p + 9] !== 0x01) continue;
    if (data[p + 12] !== 0x0c || data[p + 13] !== 0x81) continue;
    if (data[p + 14] !== 0x48 || data[p + 15] !== 0x00) continue;
    const r0 = ipofUint(data, p + 2, 2);
    const r1 = ipofUint(data, p + 6, 2);
    const r2 = ipofUint(data, p + 10, 2);
    if (r1 === r0 + 1 && r2 === r0 + 2) anchors.push(r0);
  }
  const entries = ipofTokPool(data, good, n);
  if (!entries) return { start: null, entries: [] };
  const sample = anchors.slice(0, 40);
  let best = null;
  for (let k = 0; k < entries.length; k += 1) {
    let score = 0;
    for (const r of sample) {
      const j = k + r;
      if (
        j + 2 < entries.length &&
        entries[j][0] === 'i' &&
        entries[j + 1][0] === 'i' &&
        entries[j + 2][0] === 's'
      )
        score += 1;
    }
    if (best === null || score > best.score) best = { score, k };
    if (best.score === sample.length && best.score > 0) break;
  }
  const k = best.k;
  return { start: k < offs.length ? offs[k] : good, entries: entries.slice(k) };
}

/**
 * Where PROC CODE ends: at the trailing metadata region, not at the pool.
 *
 * Nearly every file closes its last proc then carries `11 "Global Data"` (the
 * global-slot type table) and `12 "Constant Data"` before the pool proper.
 * Counting that region as the last proc's body buries a file under "unknown
 * code" that was never code.
 *
 * @param {Uint8Array} data The file bytes.
 * @param {number|null} ps The pool start, or null.
 * @returns {number} The end of the code region.
 */
function ipofCodeEnd(data, ps) {
  const end = ps || data.length;
  const pat = [0x11].concat(
    Array.from('Global Data').map((c) => c.charCodeAt(0)),
    [0x0a]
  );
  const hits = ipofFindAll(data, pat, 0, end);
  return hits.length ? hits[0] : end;
}

/**
 * The flat const-slot list of a coding dispatcher (the `A_<cabd>` dialect), or
 * null when the file is not one.
 *
 * These share the bytecode with the screen scripts but have no screen-style
 * pool, and their entries are tagged differently (04 string, 02 int, 01 bool).
 * Every record from the header on is a slot INCLUDING the include names and
 * the import signatures: `const n` indexes the whole stream, so skipping them
 * shifts every high index.
 *
 * @param {Uint8Array} data The file bytes.
 * @returns {Array<Array>|null} The entries, or null.
 */
function ipofAPool(data) {
  const marker = [0x12].concat(
    Array.from('Constant Data').map((c) => c.charCodeAt(0)),
    [0x0a]
  );
  const hits = ipofFindAll(data, marker, 0, data.length);
  if (!hits.length) return null;
  let p = hits[0] + marker.length;
  if (p + 9 > data.length) return null;
  p += 4; // the u32 id
  while (p < data.length && data[p] === 0x0a) p += 1;
  if (p < data.length && data[p] === 0x00) p += 1;
  p += 2; // the declared count, not relied on
  const pool = [];
  while (p < data.length) {
    const t = data[p];
    if (t === 0x0a) {
      p += 1;
      continue;
    } // a separator, not a slot
    if (t === 0x04) {
      const e = ipofFindNl(data, p + 1, data.length);
      if (e < 0) break;
      pool.push(['s', ipofLatin1(data, p + 1, e)]);
      p = e + 1;
    } else if (t === 0x02) {
      pool.push(['i', ipofUint(data, p + 1, 2)]);
      p += 3;
    } else if (t === 0x01) {
      pool.push(['b', data[p + 1]]);
      p += 2;
    } else {
      break; // the trailing DLL signature table
    }
  }
  return pool;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ipofFindPool,
    ipofCodeEnd,
    ipofTokPool,
    ipofUint,
    ipofLatin1,
    ipofFindNl,
    ipofFindAll,
    ipofAPool,
  };
}
