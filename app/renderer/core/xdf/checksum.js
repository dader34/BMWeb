/**
 * @file XDF engine, piece 5 of 6: <XDFCHECKSUM> verify / apply.
 *
 * calctype 0 -- the only method present in the definitions we carry -- is a
 * plain 16-bit sum of every byte in [datastart, datastart+datasize), stored
 * big-endian at storeaddress. Verified against paired stock BINs across four
 * independent definitions (DME 402/403/405, DME 413/M3), so this is measured
 * behaviour rather than an assumption.
 *
 * Any other calctype is reported as unsupported rather than guessed at: a
 * wrong checksum written into an image is a brick, not a cosmetic error.
 *
 * Adds to the shared `window.XDF` namespace; see xml.js for the load order.
 */

(function (root) {
  'use strict';

  const XDF = root.XDF || (root.XDF = {});

  /**
   * @typedef {Object} ChecksumReport
   * @property {boolean} supported - False for an unknown calctype; NOT a pass.
   * @property {number} storeaddress
   * @property {number|null} stored - The value the image holds.
   * @property {number|null} computed - The value the region sums to.
   * @property {boolean} ok - stored === computed.
   * @property {boolean} [written] - Set by applyChecksumRegion after a write.
   */

  /** The only calctype implemented: a 16-bit big-endian sum. */
  const CHECKSUM_SUM16 = 0;

  /**
   * Sum a region.
   * @param {XdfChecksumRegion} region
   * @param {Uint8Array} buffer
   * @returns {{ value: number, start: number, end: number }|null} null when
   *   the region is empty or runs past the image.
   */
  function computeChecksumRegion(region, buffer) {
    const start = region.datastart;
    const size = region.datasize;
    if (!(size > 0)) return null;
    const end = start + size; // exclusive
    if (start < 0 || end > buffer.length) return null;
    let sum = 0;
    for (let i = start; i < end; i++) sum = (sum + buffer[i]) & 0xffff;
    return { value: sum, start, end };
  }

  /**
   * Compare a region's stored checksum with the computed one. `supported:
   * false` means an unknown calctype -- the caller must NOT treat that as a
   * pass.
   * @param {XdfChecksumRegion} region
   * @param {Uint8Array} buffer
   * @returns {ChecksumReport}
   */
  function verifyChecksumRegion(region, buffer) {
    const base = {
      supported: region.calctype === CHECKSUM_SUM16,
      storeaddress: region.storeaddress,
      stored: null,
      computed: null,
      ok: false,
    };
    if (!base.supported) return base;
    const c = computeChecksumRegion(region, buffer);
    if (!c) return base;
    const at = region.storeaddress;
    if (at < 0 || at + 2 > buffer.length) return base;
    base.computed = c.value;
    base.stored = (buffer[at] << 8) | buffer[at + 1]; // big-endian
    base.ok = base.stored === base.computed;
    return base;
  }

  /**
   * Verify every region of a checksum item, in document order.
   * @param {XdfChecksum} item
   * @param {Uint8Array} buffer
   * @returns {ChecksumReport[]}
   */
  function verifyChecksum(item, buffer) {
    return (item.regions || []).map((r) => verifyChecksumRegion(r, buffer));
  }

  /**
   * Write the computed checksum back. Mutates `buffer` in place; a region
   * with an unsupported calctype is left untouched and reported as such.
   * @param {XdfChecksumRegion} region
   * @param {Uint8Array} buffer
   * @returns {ChecksumReport}
   */
  function applyChecksumRegion(region, buffer) {
    const before = verifyChecksumRegion(region, buffer);
    if (!before.supported || before.computed === null) return before;
    const at = region.storeaddress;
    buffer[at] = (before.computed >> 8) & 0xff;
    buffer[at + 1] = before.computed & 0xff;
    return Object.assign({}, before, {
      stored: before.computed,
      ok: true,
      written: true,
    });
  }

  /**
   * Apply every region of a checksum item.
   * @param {XdfChecksum} item
   * @param {Uint8Array} buffer
   * @returns {ChecksumReport[]}
   */
  function applyChecksum(item, buffer) {
    return (item.regions || []).map((r) => applyChecksumRegion(r, buffer));
  }

  Object.assign(XDF, {
    computeChecksumRegion,
    verifyChecksumRegion,
    verifyChecksum,
    applyChecksumRegion,
    applyChecksum,
    CHECKSUM_SUM16,
  });
})(typeof window !== 'undefined' ? window : this);
