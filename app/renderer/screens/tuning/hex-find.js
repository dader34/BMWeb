/**
 * @file Tuning screen: the pure side of the hex view's find box -- pattern
 * parsing and the byte search. No DOM, so it can be checked in isolation.
 */

/* exported tnLowerBound, tnSearchAll, tnParseHexPattern, tnParseTextPattern */

/**
 * Index of the first hit >= off, or hits.length. Used both to jump between
 * matches and to find where a row's matches begin.
 * @param {Int32Array|number[]} hits - Sorted match offsets.
 * @param {number} off
 * @returns {number}
 */
function tnLowerBound(hits, off) {
  let lo = 0;
  let hi = hits.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (hits[mid] < off) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Every offset at which `pat` occurs in `bytes`. A naive scan: a firmware
 * image is at most a couple of MB and patterns are short, so the worst case
 * is a few million byte compares -- well under a frame, and it saves
 * carrying a KMP table around.
 * @param {Uint8Array} bytes
 * @param {Uint8Array|null} pat
 * @returns {number[]} Sorted start offsets.
 */
function tnSearchAll(bytes, pat) {
  const out = [];
  if (!pat || !pat.length || pat.length > bytes.length) return out;
  const last = bytes.length - pat.length;
  const p0 = pat[0];
  for (let i = 0; i <= last; i++) {
    if (bytes[i] !== p0) continue;
    let j = 1;
    while (j < pat.length && bytes[i + j] === pat[j]) j++;
    if (j === pat.length) out.push(i);
  }
  return out;
}

/**
 * "DE AD BE EF", "deadbeef" and "DE-AD" all mean the same four bytes. An odd
 * number of hex digits is a half-typed byte, not an error worth shouting
 * about -- we just decline to search until it is complete.
 * @param {string} text
 * @returns {Uint8Array|null}
 */
function tnParseHexPattern(text) {
  const clean = text.replace(/(0x)|[^0-9a-fA-F]/g, '');
  if (!clean.length || clean.length % 2) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

/**
 * Text as Latin-1 bytes, not UTF-8: firmware strings are single-byte, and a
 * UTF-8 encode would silently turn a typed 'é' into two bytes that are not
 * in the image.
 * @param {string} text
 * @returns {Uint8Array|null} null for an empty query.
 */
function tnParseTextPattern(text) {
  if (!text.length) return null;
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}
