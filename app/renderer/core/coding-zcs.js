// coding-zcs: read/write/validate ZCS (Zentral-Codier-Schlüssel) keys
//
// ZCS is BMW's central coding system: three keys stored in a fixed 20-byte
// region on the ECU (usually KMB/IKE).
//
// Layout (20 bytes):
//   [0..3]   GM body (4 bytes, 8 hex nibbles packed)
//   [4]      GM check char (ASCII, Mod-36)
//   [5..12]  SA body (8 bytes, 16 hex nibbles packed)
//   [13]     SA check char (ASCII, Mod-36)
//   [14..18] VN body (5 bytes, 10 hex nibbles packed)
//   [19]     VN check char (ASCII, Mod-36)
//
// Keys:
//   GM (Grundmodell) - 8 hex chars: hardware/model identifier
//   SA (Sonderausstattung) - 16 hex chars: feature bit-set
//   VN (Versionsnummer) - 10 hex chars: SW-revision marker

(function (root) {
  'use strict';

  // Import from coding-encode.js (Mod-36 helpers)
  const CodingEncode = (typeof window !== 'undefined' && window.CodingEncode)
    ? window.CodingEncode
    : require('./coding-encode.js');

  const { mod36, mod36Decode, mod36Encode } = CodingEncode;

  // ---- ZCS key validation ------------------------------------------------

  function isValidHex(s, len) {
    return typeof s === 'string' && s.length === len && /^[0-9A-F]+$/i.test(s);
  }

  function validateGm(body) {
    if (!isValidHex(body, 8)) return 'GM must be 8 hex chars';
    return null;
  }

  function validateSa(body) {
    if (!isValidHex(body, 16)) return 'SA must be 16 hex chars';
    return null;
  }

  function validateVn(body) {
    if (!isValidHex(body, 10)) return 'VN must be 10 hex chars';
    return null;
  }

  // ---- Format with check digit -------------------------------------------

  function formatGm(body) {
    const err = validateGm(body);
    if (err) throw new Error(err);
    return body.toUpperCase() + mod36('C1', body.toUpperCase());
  }

  function formatSa(body) {
    const err = validateSa(body);
    if (err) throw new Error(err);
    return body.toUpperCase() + mod36('C2', body.toUpperCase());
  }

  function formatVn(body) {
    const err = validateVn(body);
    if (err) throw new Error(err);
    return body.toUpperCase() + mod36('C3', body.toUpperCase());
  }

  // ---- Strip check digit -------------------------------------------------

  function stripGmCheck(value) {
    return String(value).slice(0, 8).toUpperCase();
  }

  function stripSaCheck(value) {
    return String(value).slice(0, 16).toUpperCase();
  }

  function stripVnCheck(value) {
    // VN can come back as 10 or 11 chars (some reads omit check)
    const s = String(value).toUpperCase();
    return s.length >= 10 ? s.slice(0, 10) : s.padEnd(10, '0');
  }

  // ---- Verify check digit ------------------------------------------------

  function verifyGm(value) {
    if (value.length !== 9) return false;
    const body = value.slice(0, 8);
    const check = value[8];
    return check === mod36('C1', body);
  }

  function verifySa(value) {
    if (value.length !== 17) return false;
    const body = value.slice(0, 16);
    const check = value[16];
    return check === mod36('C2', body);
  }

  function verifyVn(value) {
    if (value.length !== 11) return false;
    const body = value.slice(0, 10);
    const check = value[10];
    return check === mod36('C3', body);
  }

  // ---- Parse 20-byte ZCS region ------------------------------------------

  function parseZcsRegion(bytes) {
    if (bytes.length < 20) {
      throw new Error('ZCS region must be at least 20 bytes');
    }

    // GM: 4 body bytes + 1 check
    const gmHex = Array.from(bytes.slice(0, 4), b =>
      ('0' + (b & 0xff).toString(16)).slice(-2)
    ).join('').toUpperCase();
    const gmCheck = String.fromCharCode(bytes[4] & 0xff);
    const gm = gmHex + gmCheck;

    // SA: 8 body bytes + 1 check
    const saHex = Array.from(bytes.slice(5, 13), b =>
      ('0' + (b & 0xff).toString(16)).slice(-2)
    ).join('').toUpperCase();
    const saCheck = String.fromCharCode(bytes[13] & 0xff);
    const sa = saHex + saCheck;

    // VN: 5 body bytes + 1 check
    const vnHex = Array.from(bytes.slice(14, 19), b =>
      ('0' + (b & 0xff).toString(16)).slice(-2)
    ).join('').toUpperCase();
    const vnCheck = String.fromCharCode(bytes[19] & 0xff);
    const vn = vnHex + vnCheck;

    return {
      gm: { value: gm, body: gmHex, check: gmCheck, valid: verifyGm(gm) },
      sa: { value: sa, body: saHex, check: saCheck, valid: verifySa(sa) },
      vn: { value: vn, body: vnHex, check: vnCheck, valid: verifyVn(vn) },
    };
  }

  // ---- Build 20-byte ZCS region (same as coding-encode buildZcsRegion) ---

  function buildZcsRegion(gmBody, saBody, vnBody) {
    const err = validateGm(gmBody) || validateSa(saBody) || validateVn(vnBody);
    if (err) throw new Error(err);

    const region = new Uint8Array(20);
    let p = 0;

    // GM: 4 body bytes + 1 check
    const gm = packNibbles(gmBody, 4);
    for (let i = 0; i < 4; i++) region[p++] = gm[i];
    region[p++] = mod36('C1', gmBody.toUpperCase()).charCodeAt(0);

    // SA: 8 body bytes + 1 check
    const sa = packNibbles(saBody, 8);
    for (let i = 0; i < 8; i++) region[p++] = sa[i];
    region[p++] = mod36('C2', saBody.toUpperCase()).charCodeAt(0);

    // VN: 5 body bytes + 1 check
    const vn = packNibbles(vnBody, 5);
    for (let i = 0; i < 5; i++) region[p++] = vn[i];
    region[p++] = mod36('C3', vnBody.toUpperCase()).charCodeAt(0);

    return region;
  }

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
    if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
    if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
    return 0;
  }

  // ---- FA/ZCS filtering helpers ------------------------------------------

  // Extract SA codes from SA key body (16 hex chars = 64 bits)
  // Each SA code is a 3-digit decimal number; bit N set = SA code N
  function extractSaCodes(saBody) {
    const codes = [];
    const hex = String(saBody).replace(/[^0-9A-F]/gi, '');
    if (hex.length !== 16) return codes;

    // Parse as 64-bit big-endian bitfield
    for (let i = 0; i < 16; i += 2) {
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

  // Check if a field should be shown given the car's SA codes
  // field.asw is a space-separated list of SA codes this field requires
  function matchesAsw(field, saCodes) {
    if (!field || !field.asw) return true; // no filter = always show
    const required = String(field.asw).split(/\s+/).filter(Boolean);
    if (!required.length) return true;
    if (!saCodes || !saCodes.length) return false; // field needs SA, car has none
    // Field shown if ANY required SA is present
    return required.some(sa => saCodes.includes(sa));
  }

  // ---- exports -----------------------------------------------------------

  const api = {
    // Validation
    validateGm, validateSa, validateVn,
    verifyGm, verifySa, verifyVn,

    // Format/strip
    formatGm, formatSa, formatVn,
    stripGmCheck, stripSaCheck, stripVnCheck,

    // Region I/O
    parseZcsRegion, buildZcsRegion,

    // FA/ZCS filtering
    extractSaCodes, matchesAsw,
  };

  root.CodingZcs = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
