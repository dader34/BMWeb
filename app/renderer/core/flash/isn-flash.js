// Flashing/Tuning: the DME's flash ISN at ext 0x1FB00, read and (bench
// only, localhost) written through the fast flash bootloader's boot-sector
// ladder. The capability is the same one the AIF editor and the bootloader
// install use (ARM -> ERASE the 96 KB boot sector -> CHUNK -> VERIFY ->
// DONE); no new body service is needed.
//
// WHERE THE ISN LIVES (verified 2026-10-28 on the ms45-emu emulator and
// against PA Soft): six bytes at ext 0x1FB00 are three transformed copies
// of the 16-bit ISN V. The DME's boot routine (fn_FFFDB600) reads them,
// votes, and copies the winner into the RAM the EWS handshake reads -- so
// this, not the EEPROM record, is what the car presents to the EWS.
//
//   byte[0..1] = ~V            (fully inverted)
//   byte[2..3] = (~hi)<<8 | lo (high byte inverted, low byte straight)
//   byte[4..5] = hi<<8 | (~lo) (high byte straight, low byte inverted)
//
// so V = (byte[4] << 8) | byte[3]. The three copies must agree after their
// transforms, which is how a tool reads the value back out.
//
// The boot CRC word at 0x1F800 covers only 0x0-0x1EFFF, so 0x1FB00 is
// ABOVE it: changing the ISN does not touch any checksum (confirmed on the
// emulator). The write still erases and rewrites the whole 96 KB boot
// sector, because flash only clears bits; a bit-set in the ISN cannot be
// done in place.

/** The ISN's six bytes start here (ext offset, inside the 96 KB boot sector). */
const ISN_FLASH_AT = 0x1fb00;
const ISN_FLASH_LEN = 6;
const ISN_BOOT = 0x8000;
const ISN_BOOT_LEN = 0x18000; // [0x8000, 0x20000)

// bl14.js loads AFTER this file (it depends on isnFlash), so the reference
// is resolved lazily, not captured at load time.
function isnFlashBl14() {
  if (typeof bl14 !== 'undefined') return bl14;
  return require('./bl14.js').bl14;
}

/**
 * The 16-bit ISN a six-byte triple holds, or null when the three copies
 * do not agree (not an ISN field, or a torn read).
 * @param {ArrayLike<number>} six - The bytes at 0x1FB00.
 * @returns {number|null}
 */
function isnFromTriple(six) {
  if (!six || six.length < 6) return null;
  const V = (six[4] << 8) | six[3];
  const hi = (V >> 8) & 0xff;
  const lo = V & 0xff;
  const a = (~V & 0xffff) >>> 0 === ((six[0] << 8) | six[1]);
  const b = (((~hi & 0xff) << 8) | lo) === ((six[2] << 8) | six[3]);
  const c = ((hi << 8) | (~lo & 0xff)) === ((six[4] << 8) | six[5]);
  return a && b && c ? V : null;
}

// NOT HERE: the 12-byte record in the serial EEPROM (0x04 / 0x14). It is a
// per-DME identity word in the same three-copy shape, but it is not the
// EWS's ISN and no sync rewrites it (two DMEs with different records both
// started the same car, 2026-10-28). An earlier reader decoded a "16-bit
// ISN" from it; that gave garbage (42F6 for a DME whose ISN is 2086) and
// was removed. The flash triple above is the only store that pairs.

/**
 * The six bytes that encode a 16-bit ISN, the DME's own layout.
 * @param {number} isn - 0x0000..0xFFFF
 * @returns {Uint8Array} six bytes for 0x1FB00
 */
function isnToTriple(isn) {
  if (!Number.isInteger(isn) || isn < 0 || isn > 0xffff)
    throw new Error(`the ISN is two bytes (got ${isn})`);
  const hi = (isn >> 8) & 0xff;
  const lo = isn & 0xff;
  return new Uint8Array([
    (~isn >> 8) & 0xff,
    ~isn & 0xff, // ~V
    ~hi & 0xff,
    lo, // (~hi)<<8 | lo
    hi,
    ~lo & 0xff, // hi<<8 | (~lo)
  ]);
}

/** The ISN as four hex digits, the way the tools show it. @returns {string} */
function isnFlashText(isn) {
  return isn.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * The boot sector with a new ISN spliced in at 0x1FB00 and the boot CRC
 * word kept right (it is unaffected, but recomputed for hygiene, exactly
 * as every other boot-sector write does).
 * @param {Uint8Array} low - [0x0, 0x4000) off the DME (for the CRC).
 * @param {Uint8Array} sect8k - [0x4000, 0x6000) off the DME.
 * @param {Uint8Array} mid - [0x6000, 0x8000) off the DME.
 * @param {Uint8Array} boot - [0x8000, 0x20000) off the DME.
 * @param {number} isn - the ISN to write.
 * @returns {{boot: Uint8Array, was: number|null, changed: boolean}}
 */
function isnSpliceBoot(low, sect8k, mid, boot, isn) {
  if (boot.length !== ISN_BOOT_LEN)
    throw new Error('isn: the boot sector read is the wrong size');
  const at = ISN_FLASH_AT - ISN_BOOT;
  const was = isnFromTriple(boot.subarray(at, at + ISN_FLASH_LEN));
  const triple = isnToTriple(isn);
  const nb = Uint8Array.from(boot);
  nb.set(triple, at);
  // the CRC word is outside 0x1FB00's reach, but keep every boot-sector
  // write consistent: recompute it over the final content
  const withCrc = isnFlashBl14().withBootCrc(low, sect8k, mid, nb);
  const same = withCrc.every((x, i) => x === boot[i]);
  return { boot: withCrc, was, changed: !same };
}

/**
 * The boot sector with the ISN blanked to 0xFF (virginize): the DME then
 * reads a blank ISN and presents 0xFFFF to the EWS, the state an un-coded
 * DME ships in. Verified on the emulator: the reader stores 0xFFFF into the
 * handshake RAM when 0x1FB00 is all 0xFF. The EWS does NOT fill it back in
 * during a sync (car, 2026-10-28): pairing is spliceBoot with the car's ISN.
 * @param {Uint8Array} low @param {Uint8Array} sect8k @param {Uint8Array} mid
 * @param {Uint8Array} boot - As read off the DME.
 * @returns {{boot: Uint8Array, was: number|null, changed: boolean}}
 */
function isnBlankBoot(low, sect8k, mid, boot) {
  if (boot.length !== ISN_BOOT_LEN)
    throw new Error('isn: the boot sector read is the wrong size');
  const at = ISN_FLASH_AT - ISN_BOOT;
  const was = isnFromTriple(boot.subarray(at, at + ISN_FLASH_LEN));
  const nb = Uint8Array.from(boot);
  nb.fill(0xff, at, at + ISN_FLASH_LEN);
  const withCrc = isnFlashBl14().withBootCrc(low, sect8k, mid, nb);
  const same = withCrc.every((x, i) => x === boot[i]);
  return { boot: withCrc, was, changed: !same };
}

const isnFlash = {
  AT: ISN_FLASH_AT,
  LEN: ISN_FLASH_LEN,
  fromTriple: isnFromTriple,
  toTriple: isnToTriple,
  text: isnFlashText,
  spliceBoot: isnSpliceBoot,
  blankBoot: isnBlankBoot,
};

if (typeof window !== 'undefined') window.isnFlash = isnFlash;
if (typeof module !== 'undefined' && module.exports)
  module.exports = { isnFlash };
