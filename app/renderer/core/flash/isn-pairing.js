// Flashing/Tuning: the ISN/EWS matcher's pairing logic. BENCH ONLY
// (localhost), like the rest of the flash lane.
//
// The DME keeps its copy of the ISN in the serial EEPROM's stored-data
// blocks, in the 3-copy voting form the boot restores (a 16-bit word kept
// straight, inverted, straight -- protections.md's block-3 description).
// The exact offsets are bench RE still pending, so nothing here trusts a
// fixed address: the voting shape itself identifies the field, and the
// page shows every triple it finds -- which is also how two cars' dumps
// will pin the offsets for good (docs/EWS-ISN.md).
//
// Two alignment flows, both for the legitimate used-DME repair:
//   DME <- EWS: the DME from another car learns this car's ISN -- the
//     triple's three words rewritten, votes preserved, each write read
//     back (eepromDump.write's contract).
//   EWS <- DME: a blank EWS takes the DME's ISN through the factory job
//     (core/flash/ews.js), then the rolling-code sync.
// A locked EWS refuses the factory job itself; the refusal surfaces and
// the attempt ends. No password material lives here.

/** The ISN is two bytes everywhere: the EWS job carries a 16-bit word. */
const ISN_BYTES = 2;

/**
 * @param {number} val - 16-bit
 * @returns {Uint8Array} big-endian, the EEPROM's byte order
 */
function isnBytes(val) {
  return new Uint8Array([(val >> 8) & 0xff, val & 0xff]);
}

/** 16-bit word at an offset (big-endian). @returns {number} */
function word16(img, at) {
  return ((img[at] << 8) | img[at + 1]) & 0xffff;
}

/**
 * Every 3-copy voting field in a dump: a word kept straight, inverted,
 * straight at three addresses with the inverted copy between the two
 * straight ones. The stride is read off the data, not assumed -- the
 * copies sit six apart in every dump seen so far, but a finder that
 * measures cannot be wrong when a block moves. All-blank and all-zero
 * words are not fields: blank is erased silicon and zero with blank
 * around it is the same accident of alignment.
 * @param {Uint8Array} img
 * @param {number} [maxStride=32] - how far apart the copies may sit
 * @returns {{at: number, straight: number[], inverted: number, val: number}[]}
 */
function votingTriples(img, maxStride = 32) {
  const out = [];
  const notAField = (v) => v === 0xffff || v === 0x0000;
  for (let p = 0; p + 1 < img.length; p += 2) {
    const v = word16(img, p);
    if (notAField(v)) continue;
    // the NEAREST second straight copy, and an inverted one between: one
    // triple a base -- a value that appears in a longer run claims its
    // nearest neighbours only
    for (let q = p + 4; q <= p + maxStride && q + 1 < img.length; q += 2) {
      if (word16(img, q) !== v) continue;
      let m = -1;
      for (let t = p + 2; t < q; t += 2)
        if (word16(img, t) === (v ^ 0xffff)) {
          m = t;
          break;
        }
      if (m >= 0) out.push({ at: p, straight: [p, q], inverted: m, val: v });
      break; // the nearest second copy settles this base either way
    }
  }
  return out;
}

/**
 * The match state over a dump and the EWS's ISN: which triple (if any)
 * holds the car's ISN, and what else the dump votes for. (Its own name:
 * ews.js has a matchState too, and the page's scripts share one scope.)
 * @param {Uint8Array|null} img - the dump, or null before one is taken
 * @param {number|null} ewsIsn
 * @returns {{state: 'unknown'|'match'|'mismatch', triple: object|null,
 *     others: object[], text: string}}
 */
function isnMatchState(img, ewsIsn) {
  if (!img || ewsIsn === null || ewsIsn === undefined)
    return {
      state: 'unknown',
      triple: null,
      others: [],
      text: 'one side is not read yet',
    };
  const triples = votingTriples(img);
  const hit = triples.find((t) => t.val === ewsIsn) || null;
  const others = triples.filter((t) => t !== hit);
  const hex = (v) => v.toString(16).toUpperCase().padStart(4, '0');
  if (hit)
    return {
      state: 'match',
      triple: hit,
      others,
      text: `EWS and DME agree: ${hex(ewsIsn)} (voting at 0x${hit.at.toString(16)})`,
    };
  const seen = others.map((t) => hex(t.val)).join(', ');
  return {
    state: 'mismatch',
    triple: null,
    others,
    text:
      `the DME's EEPROM does not hold the EWS ISN ${hex(ewsIsn)}` +
      (seen ? ` -- voting fields found: ${seen}` : ' -- no voting field found'),
  };
}

/**
 * The writes that retarget one voting triple to a new ISN: three words,
 * votes preserved. Only the triple's own addresses -- an incidental
 * occurrence of the value anywhere else in the 64 KB is not the ISN and
 * is not touched.
 * @param {object} triple - a votingTriples entry
 * @param {number} newIsn
 * @returns {{at: number, bytes: Uint8Array, vote: 'straight'|'inverted'}[]}
 */
function tripleOps(triple, newIsn) {
  const inv = newIsn ^ 0xffff;
  return [
    { at: triple.straight[0], bytes: isnBytes(newIsn), vote: 'straight' },
    { at: triple.inverted, bytes: isnBytes(inv), vote: 'inverted' },
    { at: triple.straight[1], bytes: isnBytes(newIsn), vote: 'straight' },
  ];
}

const isnPair = {
  ISN_BYTES,
  isnBytes,
  votingTriples,
  matchState: isnMatchState,
  tripleOps,
};

if (typeof window !== 'undefined') {
  window.isnPair = isnPair;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isnPair };
}
