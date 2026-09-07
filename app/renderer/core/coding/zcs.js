/**
 * @file ZCS (Zentral-Codier-Schluessel) keys: read, write and validate the
 * three keys BMW's central coding system stores in a fixed 20-byte region on
 * the ECU (usually KMB/IKE). Published as the `CodingZcs` global.
 *
 * Layout (20 bytes):
 *   [0..3]   GM body (4 bytes, 8 hex nibbles packed)
 *   [4]      GM check char (ASCII, Mod-36)
 *   [5..12]  SA body (8 bytes, 16 hex nibbles packed)
 *   [13]     SA check char (ASCII, Mod-36)
 *   [14..18] VN body (5 bytes, 10 hex nibbles packed)
 *   [19]     VN check char (ASCII, Mod-36)
 *
 * Keys:
 *   GM (Grundmodell) - 8 hex chars: hardware/model identifier
 *   SA (Sonderausstattung) - 16 hex chars: feature bit-set
 *   VN (Versionsnummer) - 10 hex chars: SW-revision marker
 */

/**
 * One parsed ZCS key.
 * @typedef {Object} ZcsKey
 * @property {string} value - body + check char as read.
 * @property {string} body - the hex body (uppercase).
 * @property {string} check - the Mod-36 check char as read.
 * @property {boolean} valid - does the check char match the body?
 */

/**
 * The three keys parsed out of a 20-byte ZCS region.
 * @typedef {Object} ZcsRegion
 * @property {ZcsKey} gm - Grundmodell.
 * @property {ZcsKey} sa - Sonderausstattung.
 * @property {ZcsKey} vn - Versionsnummer.
 * @property {number} [offset] - byte offset of the region in the netto, when
 *   the caller located it.
 */

(function (root) {
  'use strict';

  // The Mod-36 helpers live in the codec (core/coding/encode.js).
  const CodingEncode =
    typeof window !== 'undefined' && window.CodingEncode
      ? window.CodingEncode
      : require('./encode.js');

  const { mod36 } = CodingEncode;

  /** Hex chars in a GM body. */
  const GM_LEN = 8;
  /** Hex chars in an SA body. */
  const SA_LEN = 16;
  /** Hex chars in a VN body. */
  const VN_LEN = 10;
  /** Bytes in the packed ZCS region. */
  const REGION_LEN = 20;

  // ---- ZCS key validation ------------------------------------------------

  /**
   * Is `s` a hex string of exactly `len` chars?
   * @param {unknown} s - candidate.
   * @param {number} len - required length.
   * @returns {boolean} true when it is.
   */
  function isValidHex(s, len) {
    return typeof s === 'string' && s.length === len && /^[0-9A-F]+$/i.test(s);
  }

  /**
   * Validate a GM body.
   * @param {string} body - candidate GM body.
   * @returns {string|null} an error message, or null when valid.
   */
  function validateGm(body) {
    if (!isValidHex(body, GM_LEN)) return 'GM must be 8 hex chars';
    return null;
  }

  /**
   * Validate an SA body.
   * @param {string} body - candidate SA body.
   * @returns {string|null} an error message, or null when valid.
   */
  function validateSa(body) {
    if (!isValidHex(body, SA_LEN)) return 'SA must be 16 hex chars';
    return null;
  }

  /**
   * Validate a VN body.
   * @param {string} body - candidate VN body.
   * @returns {string|null} an error message, or null when valid.
   */
  function validateVn(body) {
    if (!isValidHex(body, VN_LEN)) return 'VN must be 10 hex chars';
    return null;
  }

  // ---- Format with check digit -------------------------------------------

  /**
   * GM body plus its Mod-36 check char.
   * @param {string} body - 8 hex chars.
   * @returns {string} the 9-char key.
   * @throws {Error} when the body is not valid.
   */
  function formatGm(body) {
    const err = validateGm(body);
    if (err) throw new Error(err);
    return body.toUpperCase() + mod36('C1', body.toUpperCase());
  }

  /**
   * SA body plus its Mod-36 check char.
   * @param {string} body - 16 hex chars.
   * @returns {string} the 17-char key.
   * @throws {Error} when the body is not valid.
   */
  function formatSa(body) {
    const err = validateSa(body);
    if (err) throw new Error(err);
    return body.toUpperCase() + mod36('C2', body.toUpperCase());
  }

  /**
   * VN body plus its Mod-36 check char.
   * @param {string} body - 10 hex chars.
   * @returns {string} the 11-char key.
   * @throws {Error} when the body is not valid.
   */
  function formatVn(body) {
    const err = validateVn(body);
    if (err) throw new Error(err);
    return body.toUpperCase() + mod36('C3', body.toUpperCase());
  }

  // ---- Strip check digit -------------------------------------------------

  /**
   * The GM body of a key value, check char dropped.
   * @param {string} value - 8 or 9 chars.
   * @returns {string} 8 uppercase chars.
   */
  function stripGmCheck(value) {
    return String(value).slice(0, GM_LEN).toUpperCase();
  }

  /**
   * The SA body of a key value, check char dropped.
   * @param {string} value - 16 or 17 chars.
   * @returns {string} 16 uppercase chars.
   */
  function stripSaCheck(value) {
    return String(value).slice(0, SA_LEN).toUpperCase();
  }

  /**
   * The VN body of a key value, check char dropped. VN can come back as 10 or
   * 11 chars (some reads omit the check); a short value is zero-padded.
   * @param {string} value - the key as read.
   * @returns {string} 10 uppercase chars.
   */
  function stripVnCheck(value) {
    const s = String(value).toUpperCase();
    return s.length >= VN_LEN ? s.slice(0, VN_LEN) : s.padEnd(VN_LEN, '0');
  }

  // ---- Verify check digit ------------------------------------------------

  /**
   * Does a 9-char GM key carry the right check char?
   * @param {string} value - body + check.
   * @returns {boolean} true when the check matches.
   */
  function verifyGm(value) {
    if (value.length !== GM_LEN + 1) return false;
    const body = value.slice(0, GM_LEN);
    const check = value[GM_LEN];
    return check === mod36('C1', body);
  }

  /**
   * Does a 17-char SA key carry the right check char?
   * @param {string} value - body + check.
   * @returns {boolean} true when the check matches.
   */
  function verifySa(value) {
    if (value.length !== SA_LEN + 1) return false;
    const body = value.slice(0, SA_LEN);
    const check = value[SA_LEN];
    return check === mod36('C2', body);
  }

  /**
   * Does an 11-char VN key carry the right check char?
   * @param {string} value - body + check.
   * @returns {boolean} true when the check matches.
   */
  function verifyVn(value) {
    if (value.length !== VN_LEN + 1) return false;
    const body = value.slice(0, VN_LEN);
    const check = value[VN_LEN];
    return check === mod36('C3', body);
  }

  // ---- Blank / unprogrammed key detection --------------------------------
  //
  // A ZCS key body of all-FF (or all-00) is not equipment data -- it is an
  // erased or never-programmed EEPROM region, and BMW's own blank SA key
  // (FFFFFFFFFFFFFFFF) carries a valid Mod-36 check char, so it reads as
  // "structurally fine" while meaning "no special equipment". Decoding it as
  // a bitfield or matching it against the assignment table invents options a
  // car does not have.
  /**
   * Is this key body erased / never programmed (all-F or all-0, or empty)?
   * @param {string} body - the hex body string (no check char).
   * @returns {boolean} true for a blank body.
   */
  function isBlankKeyBody(body) {
    const h = String(body || '')
      .replace(/[^0-9A-Fa-f]/g, '')
      .toUpperCase();
    if (!h.length) return true;
    return /^F+$/.test(h) || /^0+$/.test(h);
  }

  // Convenience for callers holding an SA value in any of the shapes the read
  // paths produce: a bare 16-hex body, a 17-char body+check, or the display
  // form that keeps the channel tag and Mod-36 check ("C2FFFFFFFFFFFFFFFF-S").
  // Strip the leading channel prefix (C1/C2/C3) and any trailing non-hex check
  // char, then test the 16-hex body -- otherwise the prefix (C2) makes an
  // all-F body read as non-blank and the guard never fires.
  /**
   * Is this SA key blank, whatever shape the read path handed it over in?
   * @param {string} value - body, body+check, or the tagged display form.
   * @returns {boolean} true for a blank SA key.
   */
  function isBlankSaKey(value) {
    let v = String(value || '')
      .trim()
      .toUpperCase();
    // drop a leading ZCS channel tag if present (C1 = GM, C2 = SA, C3 = VN)
    v = v.replace(/^C[123]/, '');
    // keep only hex; a Mod-36 check char (e.g. S, E, P) is non-hex and falls
    // away here, as does any separator
    const hex = v.replace(/[^0-9A-F]/g, '');
    // an SA body is 16 hex chars; if we have exactly 16 (or 17 with a hex
    // check digit folded in) test the leading 16, else test whatever remains
    const body = hex.length >= SA_LEN ? hex.slice(0, SA_LEN) : hex;

    return isBlankKeyBody(body);
  }

  // ---- Parse 20-byte ZCS region ------------------------------------------

  /**
   * Uppercase hex of a byte range.
   * @param {number[]|Uint8Array} bytes - the region.
   * @param {number} from - first index.
   * @param {number} to - one past the last index.
   * @returns {string} uppercase hex.
   */
  function hexOf(bytes, from, to) {
    return Array.from(bytes.slice(from, to), (b) =>
      ('0' + (b & 0xff).toString(16)).slice(-2)
    )
      .join('')
      .toUpperCase();
  }

  /**
   * Parse the three keys out of a 20-byte ZCS region.
   * @param {number[]|Uint8Array} bytes - at least 20 bytes.
   * @returns {ZcsRegion} the parsed keys with their check results.
   * @throws {Error} when fewer than 20 bytes are given.
   */
  function parseZcsRegion(bytes) {
    if (bytes.length < REGION_LEN) {
      throw new Error('ZCS region must be at least 20 bytes');
    }

    // GM: 4 body bytes + 1 check
    const gmHex = hexOf(bytes, 0, 4);
    const gmCheck = String.fromCharCode(bytes[4] & 0xff);
    const gm = gmHex + gmCheck;

    // SA: 8 body bytes + 1 check
    const saHex = hexOf(bytes, 5, 13);
    const saCheck = String.fromCharCode(bytes[13] & 0xff);
    const sa = saHex + saCheck;

    // VN: 5 body bytes + 1 check
    const vnHex = hexOf(bytes, 14, 19);
    const vnCheck = String.fromCharCode(bytes[19] & 0xff);
    const vn = vnHex + vnCheck;

    return {
      gm: { value: gm, body: gmHex, check: gmCheck, valid: verifyGm(gm) },
      sa: { value: sa, body: saHex, check: saCheck, valid: verifySa(sa) },
      vn: { value: vn, body: vnHex, check: vnCheck, valid: verifyVn(vn) },
    };
  }

  // ---- Build 20-byte ZCS region ------------------------------------------

  /**
   * Build a standalone 20-byte ZCS region from three key bodies (the codec's
   * buildZcsRegion, after validation, into a fresh buffer).
   * @param {string} gmBody - 8 hex chars.
   * @param {string} saBody - 16 hex chars.
   * @param {string} vnBody - 10 hex chars.
   * @returns {Uint8Array} the 20-byte region.
   * @throws {Error} when any body is not valid.
   */
  function buildZcsRegion(gmBody, saBody, vnBody) {
    const err = validateGm(gmBody) || validateSa(saBody) || validateVn(vnBody);
    if (err) throw new Error(err);
    return CodingEncode.buildZcsRegion(
      gmBody.toUpperCase(),
      saBody.toUpperCase(),
      vnBody.toUpperCase(),
      0,
      new Uint8Array(REGION_LEN)
    );
  }

  // ---- FA/ZCS filtering helpers ------------------------------------------

  /**
   * The bit indices set in an SA key body, as zero-padded 3-digit strings.
   * Bit N set = "SA code" N -- these are BIT INDICES (0..63), not BMW's
   * catalogue numbers; see the numbering-bridge note in the coding scan.
   * @param {string} saBody - 16 hex chars (64 bits, big-endian).
   * @returns {string[]} e.g. `['003', '017']`; empty when the body is malformed.
   */
  function extractSaCodes(saBody) {
    const codes = [];
    const hex = String(saBody).replace(/[^0-9A-F]/gi, '');
    if (hex.length !== SA_LEN) return codes;

    // Parse as 64-bit big-endian bitfield
    for (let i = 0; i < SA_LEN; i += 2) {
      const byte = parseInt(hex.substr(i, 2), 16);
      for (let bit = 0; bit < 8; bit++) {
        if (byte & (1 << bit)) {
          // Bit index in big-endian: byte (i/2) * 8 + bit
          const bitIdx = (i / 2) * 8 + bit;
          codes.push(String(bitIdx).padStart(3, '0'));
        }
      }
    }
    return codes;
  }

  /**
   * Should a field be shown given the car's SA codes? `field.asw` is a
   * space-separated list of SA codes the field requires; any one present is
   * enough. No filter means always show.
   * @param {{asw?: string}|null|undefined} field - the field.
   * @param {string[]|null|undefined} saCodes - the car's SA codes.
   * @returns {boolean} true when the field applies.
   */
  function matchesAsw(field, saCodes) {
    if (!field || !field.asw) return true; // no filter = always show
    const required = String(field.asw).split(/\s+/).filter(Boolean);
    if (!required.length) return true;
    if (!saCodes || !saCodes.length) return false; // field needs SA, car has none
    // Field shown if ANY required SA is present
    return required.some((sa) => saCodes.includes(sa));
  }

  // ---- exports -----------------------------------------------------------

  const api = {
    // Validation
    validateGm,
    validateSa,
    validateVn,
    verifyGm,
    verifySa,
    verifyVn,

    // Format/strip
    formatGm,
    formatSa,
    formatVn,
    stripGmCheck,
    stripSaCheck,
    stripVnCheck,

    // Region I/O
    parseZcsRegion,
    buildZcsRegion,

    // FA/ZCS filtering
    extractSaCodes,
    matchesAsw,

    // Blank/unprogrammed key detection
    isBlankKeyBody,
    isBlankSaKey,
  };

  root.CodingZcs = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
