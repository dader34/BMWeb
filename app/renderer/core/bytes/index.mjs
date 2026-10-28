// Byte helpers shared by the flashing code: big-endian words, hex, and the
// two CRC-32s the DME and the tools use. Until now each file that needed
// one carried its own copy under its own prefix (_bl14Be32, _ltBe32,
// _ffBe32, ...), the cost of 300 scripts sharing one global scope.
//
// This is the first ES module directory. It is not loaded as a module by
// the page: scripts/build/bundle-modules.mjs builds it with esbuild into
// core/generated/bytes.js, a classic script that defines the global `bytes`,
// which index.html loads like any other file. Classic code reaches it as
// `bytes.be32(...)`; node tests `require()` this file directly. Each
// directory migrates the same way; once the last classic script is gone,
// the generated step becomes the bundle itself.

/**
 * The big-endian 32-bit word at `at`.
 * @param {ArrayLike<number>} b
 * @param {number} at
 * @returns {number} Unsigned.
 */
export function be32(b, at) {
  return (
    ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
  );
}

/**
 * Store `v` as a big-endian 32-bit word at `at`.
 * @param {Uint8Array} b
 * @param {number} at
 * @param {number} v
 */
export function putBe32(b, at, v) {
  b[at] = (v >>> 24) & 0xff;
  b[at + 1] = (v >>> 16) & 0xff;
  b[at + 2] = (v >>> 8) & 0xff;
  b[at + 3] = v & 0xff;
}

/**
 * The bytes a hex string spells.
 * @param {string} hex - An even number of hex digits.
 * @returns {Uint8Array}
 */
export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/**
 * The hex string of a byte span, lower case.
 * @param {ArrayLike<number>} b
 * @returns {string}
 */
export function bytesToHex(b) {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

// CRC-32/MPEG-2: polynomial 0x04C11DB7, not reflected, no final xor. The
// DME checks its program and calibration with it, and the flasher its
// transfers.
const MPEG2_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n << 24;
    for (let k = 0; k < 8; k++)
      c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/**
 * CRC-32/MPEG-2 of a byte span, continuing from `initial`.
 * @param {ArrayLike<number>} bytes
 * @param {number} [initial] - The running value (0xFFFFFFFF to start).
 * @returns {number} Unsigned.
 */
export function crc32Mpeg2(bytes, initial = 0xffffffff) {
  let crc = initial >>> 0;
  for (let i = 0; i < bytes.length; i++)
    crc = ((crc << 8) ^ MPEG2_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  return crc >>> 0;
}

/**
 * CRC-32 as zlib and Python's binascii compute it (reflected, final xor),
 * over one span or several in sequence.
 * @param {ArrayLike<number>|ArrayLike<number>[]} spans
 * @returns {number} Unsigned.
 */
export function crc32Zlib(spans) {
  const list = spans.length && typeof spans[0] !== 'number' ? spans : [spans];
  let crc = 0xffffffff;
  for (const b of list)
    for (let i = 0; i < b.length; i++) {
      crc ^= b[i];
      for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  return (crc ^ 0xffffffff) >>> 0;
}
