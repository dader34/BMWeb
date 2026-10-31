// The MS45 (MS45.0 / MS45.1) DME as a flashing target, in the browser.
//
// Ported from BMWeb-Flasher (the macOS app), itself descended from
// terraphantm/MS45-Flasher: the checksums and RSA signatures a tune and a
// program must carry, the EWS (immobilizer) delete, BMW's .0PA / .0DA exchange
// files, and the KWP2000 flash sequence driven through the SGBD's own jobs
// (webRunJob on ms450ds0): security access, erase, write, signature check,
// reset. The screen (screens/flashing/) composes these into the Flash Tune
// and Flash Program flows and asks every question; nothing here prompts.
//
// MD5 and the modular exponentiation come from core/flash/flasher.js (_md5,
// _modPow, _bytesLEToBigInt, _bigIntToBytesLE), which loads first.
/* exported MS45_SGBD, MS45_FULL_FLASH_LENGTH, MS45_MPC_LENGTH, MS45_CAL_START, MS45_CAL_LENGTH, MS45_PROGRAM_START, ms45Crc32, ms45Checksums, ewsDelete, ms45ExchangeFile, ms45Job, ms45SetJobTrace, ms45Identify, ms45ReadMemory, ms45ReadCarBytes, ms45SecurityAccess, ms45LeaveProgrammingMode, ms45RaiseBaud, ms45DefaultBaud, ms45FinishFlash, ms45Erase, ms45FlashBlock, ms45WriteAif, ms45AifFields, ms45ReadAscii, ms45VerifyParameterMatch, ms45VerifyProgramMatch, ms45VerifyFlashMpcMatch, ms45LiveTuneSender, ms45ReadResetRecord, ms45ResetRecordText */

/** The SGBD whose jobs drive the MS45 family. */
const MS45_SGBD = 'ms450ds0';
const MS45_FULL_FLASH_LENGTH = 0x100000;
const MS45_MPC_LENGTH = 0x70000;
const MS45_CAL_START = 0x40000;
const MS45_CAL_LENGTH = 0x1d000;
const MS45_PROGRAM_START = 0x60000;
/** The external flash as the DME addresses it over the diagnostic link. */
const MS45_EXTERNAL_BASE = 0x2000000;

// ---- CRC-32 (MPEG-2 form: polynomial 0x04C11DB7, not reflected) ----------------------
const MS45_CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = (i << 24) >>> 0;
    for (let b = 0; b < 8; b++)
      c = c & 0x80000000 ? ((c << 1) ^ 0x04c11db7) >>> 0 : (c << 1) >>> 0;
    t[i] = c;
  }
  return t;
})();

/**
 * The checksum the DME's loader computes, continued from `initial`.
 * @param {Uint8Array} bytes - The data.
 * @param {number} initial - The running value.
 * @returns {number}
 */
function ms45Crc32(bytes, initial) {
  let crc = initial >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    crc =
      (((crc << 8) & 0xffffff00) ^
        MS45_CRC32_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>>
      0;
  }
  return crc >>> 0;
}

function _ms45Be32(data, at) {
  return (
    ((data[at] << 24) |
      (data[at + 1] << 16) |
      (data[at + 2] << 8) |
      data[at + 3]) >>>
    0
  );
}

function _ms45PutBe32(data, at, v) {
  data[at] = (v >>> 24) & 0xff;
  data[at + 1] = (v >>> 16) & 0xff;
  data[at + 2] = (v >>> 8) & 0xff;
  data[at + 3] = v & 0xff;
}

// The MS45 signing key pair, reverse-engineered from the firmware (MS45-Flasher).
const MS45_SIGN_N =
  8470472580328006956677424405159809178175955696534718361218518906571634405286747173565502454089691240931470915432212928785673566143706092135925769557255439n;
const MS45_SIGN_D =
  7260405068852577391437792347279836438436533454172615738187301919918543775959908116508429649500721130520546364846625732843778800986047617824899475327781303n;
// The level-3 login key pair for security access.
const MS45_LOGIN_N =
  8972339025878534711764289273376673716657892103603163846525142300863027035823902824753024958104010374518577719658056297243325957293507856591918471309133927n;
const MS45_LOGIN_D =
  3845288153947943447898981117161431592853382330115641648510775271798440158210161294390718397115404567798616968157688687573437683643982238798574542074351303n;

/**
 * RSA-sign an MD5 hash the way the DME checks it: the hash as a little-endian
 * number, raised to d mod n, as 64 little-endian bytes with each 4-byte word
 * byte-swapped.
 * @param {Uint8Array} hash - The 16-byte MD5.
 * @param {bigint} d - The private exponent.
 * @param {bigint} n - The modulus.
 * @returns {Uint8Array} 64 bytes.
 */
function _ms45Sign(hash, d, n) {
  const m = _bytesLEToBigInt(hash);
  const enc = _bigIntToBytesLE(_modPow(m, d, n), 64);
  const out = new Uint8Array(64);
  for (let i = 0; i < 16; i++) {
    out[0 + 4 * i] = enc[3 + 4 * i];
    out[1 + 4 * i] = enc[2 + 4 * i];
    out[2 + 4 * i] = enc[1 + 4 * i];
    out[3 + 4 * i] = enc[0 + 4 * i];
  }
  return out;
}

function _ms45Concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * A segment-table-driven CRC: the table at `tablePointer` names how many
 * segments follow and each one's start/end (absolute addresses, less `memSubtract`).
 */
function _ms45TableChecksum(binary, tablePointer, initial, memSubtract) {
  const count = _ms45Be32(binary, tablePointer);
  let crc = initial >>> 0;
  for (let i = 0; i < count; i++) {
    const start =
      (_ms45Be32(binary, tablePointer + 4 + 8 * i) - memSubtract) >>> 0;
    const end =
      (_ms45Be32(binary, tablePointer + 8 + 8 * i) - memSubtract) >>> 0;
    crc = ms45Crc32(binary.subarray(start, end + 1), crc);
  }
  return crc;
}

/** The checksums and signatures the DME verifies. Every call returns a copy. */
const ms45Checksums = {
  /**
   * The calibration's CRC at 0x100, over the segments its header names.
   * @param {Uint8Array} cal - The 0x1D000-byte calibration.
   * @returns {Uint8Array}
   */
  correctParameterChecksums(cal) {
    const out = Uint8Array.from(cal);
    const initial = _ms45Be32(out, 0x110);
    const crc = _ms45TableChecksum(out, 0x104, initial, 0xffe40000);
    _ms45PutBe32(out, 0x100, crc);
    return out;
  },
  /**
   * The program's two CRCs at 0x60000 and 0x60340, each over two segments
   * that may lie in the external flash (addresses above 0xFFF00000) or the
   * MPC.
   * @param {Uint8Array} external - The 1 MB external image.
   * @param {Uint8Array} mpc - The 448 KB MPC image.
   * @returns {Uint8Array} The corrected external image.
   */
  correctProgramChecksums(external, mpc) {
    const out = Uint8Array.from(external);
    const twoSegments = (initialAt, s1, e1, s2, e2, storeAt) => {
      let crc = _ms45Be32(out, initialAt);
      for (const [sAt, eAt] of [
        [s1, e1],
        [s2, e2],
      ]) {
        const start = _ms45Be32(out, sAt);
        const end = _ms45Be32(out, eAt);
        const image = start > 0xfff00000 ? out : mpc;
        const from = start > 0xfff00000 ? start - 0xfff00000 : start;
        const to = (start > 0xfff00000 ? end - 0xfff00000 : end) + 1;
        crc = ms45Crc32(image.subarray(from, to), crc);
      }
      _ms45PutBe32(out, storeAt, crc);
    };
    twoSegments(0x60004, 0x60008, 0x60010, 0x6000c, 0x60014, 0x60000);
    // the second one does not appear to be used, but older programs may; the
    // stock ranges give the same value as the first
    twoSegments(0x60358, 0x60348, 0x6034c, 0x60350, 0x60354, 0x60340);
    return out;
  },
  /**
   * The calibration's RSA signature at 0x174, over the segments at 0x130.
   * @param {Uint8Array} cal - The 0x1D000-byte calibration.
   * @returns {Uint8Array}
   */
  signParameters(cal) {
    const out = Uint8Array.from(cal);
    const count = _ms45Be32(out, 0x130);
    const parts = [];
    for (let i = 0; i < count; i++) {
      const start = (_ms45Be32(out, 0x134 + i * 8) - 0xfff40000) >>> 0;
      const length = _ms45Be32(out, 0x144 + i * 4);
      parts.push(out.subarray(start, start + length));
    }
    out.set(
      _ms45Sign(_md5(_ms45Concat(parts)), MS45_SIGN_D, MS45_SIGN_N),
      0x174
    );
    return out;
  },
  /**
   * The program's RSA signature at 0x60074, over segments in the external
   * flash and the MPC named at 0x60030.
   * @param {Uint8Array} flash - The 1 MB external image.
   * @param {Uint8Array} mpc - The 448 KB MPC image.
   * @returns {Uint8Array} The signed external image.
   */
  signProgram(flash, mpc) {
    const out = Uint8Array.from(flash);
    const count = _ms45Be32(out, 0x60030);
    const parts = [];
    for (let i = 0; i < count; i++) {
      const start = _ms45Be32(out, 0x60034 + i * 8);
      const length = _ms45Be32(out, 0x6004c + i * 4);
      if (start < 0xfff00000) parts.push(mpc.subarray(start, start + length));
      else
        parts.push(
          out.subarray(start - 0xfff00000, start - 0xfff00000 + length)
        );
    }
    out.set(
      _ms45Sign(_md5(_ms45Concat(parts)), MS45_SIGN_D, MS45_SIGN_N),
      0x60074
    );
    return out;
  },
  /**
   * The 90-byte security-access message: MD5(userId ‖ serial ‖ seed) signed
   * with the login key, level 3, behind the fixed EDIABAS header.
   * @param {Uint8Array} userId - 4 random bytes.
   * @param {Uint8Array} serial - The DME's 4-byte serial.
   * @param {Uint8Array} seed - The seed the DME returned.
   * @returns {Uint8Array}
   */
  securityAccessMessage(userId, serial, seed) {
    const signed = _ms45Sign(
      _md5(_ms45Concat([userId, serial, seed])),
      MS45_LOGIN_D,
      MS45_LOGIN_N
    );
    const payload = new Uint8Array(65);
    payload.set(signed, 0);
    payload[64] = 3;
    const header = [
      1, 0, 0, 0, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0, 0x44, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0x10,
    ];
    return _ms45Concat([Uint8Array.from(header), payload]);
  },
};

// ---- EWS (immobilizer) delete, MS45.1 program 0044570LO02S -------------------------------
// Four functional bytes across two partitions: two error-class flags in the
// calibration (0x48F2C / 0x48F3E, 0x10 -> 0x00) and two engine-enable bytes
// in the program (0xDB1C7 0x01 -> 0x00, 0xDB1D3 0x3F -> 0x00). Both halves
// must reach the car: a program-only edit cranks-no-start with EWS fault
// P1665. Gated on the exact program version.
const EWS_EDITS = [
  [0x48f2c, 0x10, 0x00],
  [0x48f3e, 0x10, 0x00],
  [0xdb1c7, 0x01, 0x00],
  [0xdb1d3, 0x3f, 0x00],
];

const ewsDelete = {
  SUPPORTED_PROGRAM_VERSION: '0044570LO02S',
  PROGRAM_STATE_OFFSET: 0xdb1c7,
  PROGRAM_MASK_OFFSET: 0xdb1d3,
  CAL_FLAG2_OFFSET: 0x48f2c,
  CAL_FLAG3_OFFSET: 0x48f3e,
  /**
   * @param {Uint8Array} flash - A full external image.
   * @returns {string|null}
   */
  readProgramVersion(flash) {
    return ms45ReadAscii(flash, 0x6031c, 12);
  },
  _half(flash, program) {
    let stock = true;
    let deleted = true;
    for (const [offset, s, d] of EWS_EDITS) {
      if (offset >= MS45_PROGRAM_START !== program) continue;
      stock = stock && flash[offset] === s;
      deleted = deleted && flash[offset] === d;
    }
    return stock ? 'stock' : deleted ? 'deleted' : 'unknown';
  },
  /**
   * @param {Uint8Array} flash - A full external image.
   * @returns {boolean}
   */
  isApplicable(flash) {
    if (!flash || flash.length !== MS45_FULL_FLASH_LENGTH) return false;
    if (
      ewsDelete.readProgramVersion(flash) !==
      ewsDelete.SUPPORTED_PROGRAM_VERSION
    )
      return false;
    const p = ewsDelete._half(flash, true);
    const c = ewsDelete._half(flash, false);
    if (p === 'unknown' || c === 'unknown') return false;
    return p === 'stock' || c === 'stock';
  },
  /**
   * @param {Uint8Array} flash - A full external image.
   * @returns {boolean}
   */
  isAlreadyPatched(flash) {
    if (!flash || flash.length !== MS45_FULL_FLASH_LENGTH) return false;
    if (
      ewsDelete.readProgramVersion(flash) !==
      ewsDelete.SUPPORTED_PROGRAM_VERSION
    )
      return false;
    return EWS_EDITS.every(([o, , d]) => flash[o] === d);
  },
  /**
   * A copy with the delete applied across both partitions.
   * @param {Uint8Array} flash - A full external image.
   * @returns {Uint8Array}
   */
  apply(flash) {
    if (!flash || flash.length !== MS45_FULL_FLASH_LENGTH) {
      throw new Error(
        `EWS delete needs a full 1 MB external flash image (got 0x${(flash ? flash.length : 0).toString(16).toUpperCase()} bytes)`
      );
    }
    if (ewsDelete.isAlreadyPatched(flash)) return Uint8Array.from(flash);
    if (!ewsDelete.isApplicable(flash)) {
      const version = ewsDelete.readProgramVersion(flash);
      if (version !== ewsDelete.SUPPORTED_PROGRAM_VERSION) {
        throw new Error(
          `EWS delete is only verified for program version ${ewsDelete.SUPPORTED_PROGRAM_VERSION}, ` +
            `but this image reports ${version || 'an unreadable version'}`
        );
      }
      throw new Error(
        'this image is the right program version but its EWS bytes are not at their expected stock ' +
          'values, so it may already be modified; refusing to patch'
      );
    }
    const out = Uint8Array.from(flash);
    for (const [o, , d] of EWS_EDITS) out[o] = d;
    return out;
  },
  /**
   * @param {number} stateByte - The byte at 0xDB1C7.
   * @param {number} maskByte - The byte at 0xDB1D3.
   * @returns {boolean}
   */
  programBytesAreDeleted(stateByte, maskByte) {
    return stateByte === 0x00 && maskByte === 0x00;
  },
  /**
   * Whether a calibration slice still carries the stock immobilizer flags.
   * @param {Uint8Array} cal - A bare calibration or a full image.
   * @param {number} calFileOffset - Where the 0x40000 partition sits in `cal`.
   * @returns {boolean}
   */
  calibrationHasStockImmobilizer(cal, calFileOffset) {
    const f2 = ewsDelete.CAL_FLAG2_OFFSET - MS45_CAL_START + calFileOffset;
    const f3 = ewsDelete.CAL_FLAG3_OFFSET - MS45_CAL_START + calFileOffset;
    if (!cal || f3 >= cal.length) return false;
    return cal[f2] === 0x10 && cal[f3] === 0x10;
  },
  /**
   * @param {Uint8Array} cal - A bare calibration or a full image.
   * @param {number} calFileOffset - Where the 0x40000 partition sits in `cal`.
   * @returns {boolean}
   */
  calibrationHasDeletedImmobilizer(cal, calFileOffset) {
    const f2 = ewsDelete.CAL_FLAG2_OFFSET - MS45_CAL_START + calFileOffset;
    const f3 = ewsDelete.CAL_FLAG3_OFFSET - MS45_CAL_START + calFileOffset;
    if (!cal || f3 >= cal.length) return false;
    return cal[f2] === 0x00 && cal[f3] === 0x00;
  },
  /**
   * A copy with the two immobilizer flags cleared.
   * @param {Uint8Array} cal - A bare calibration or a full image.
   * @param {number} calFileOffset - Where the 0x40000 partition sits in `cal`.
   * @returns {Uint8Array}
   */
  applyCalibrationDelete(cal, calFileOffset) {
    const f2 = ewsDelete.CAL_FLAG2_OFFSET - MS45_CAL_START + calFileOffset;
    const f3 = ewsDelete.CAL_FLAG3_OFFSET - MS45_CAL_START + calFileOffset;
    if (!cal || f3 >= cal.length)
      throw new Error('calibration buffer too small for the EWS flag offsets');
    const out = Uint8Array.from(cal);
    out[f2] = 0x00;
    out[f3] = 0x00;
    return out;
  },
  /** @returns {string[]} The edits, for a log. */
  describe() {
    return EWS_EDITS.map(
      ([o, s, d]) =>
        `${o >= MS45_PROGRAM_START ? 'prog' : 'cal'} 0x${o.toString(16).toUpperCase().padStart(5, '0')}: ` +
        `${s.toString(16).toUpperCase().padStart(2, '0')} -> ${d.toString(16).toUpperCase().padStart(2, '0')}`
    );
  },
};

/**
 * Printable ASCII at an offset, or null when any byte is not.
 * @param {Uint8Array} data - The image.
 * @param {number} offset - Where.
 * @param {number} length - How many characters.
 * @returns {string|null}
 */
function ms45ReadAscii(data, offset, length) {
  if (!data || data.length < offset + length) return null;
  let s = '';
  for (let i = 0; i < length; i++) {
    const b = data[offset + i];
    if (b < 0x20 || b > 0x7e) return null;
    s += String.fromCharCode(b);
  }
  return s;
}

// ---- BMW .0PA (program) and .0DA (data) exchange files for the MS45 ---------------------
// Intel HEX under a commented header: every 64 KB block opens with a segment
// record then a linear record, and they add up; the last data record of each
// block is type 0x10. A .0PA holds the whole MPC (0x000000-0x06FFFF) and the
// external program (0x2060000-0x20FFF3F, less a gap in its header); a .0DA
// holds the calibration (0x2040000-0x205CFFF).
const ms45ExchangeFile = {
  /** @param {string} name - A file name. @returns {boolean} */
  isProgramFile(name) {
    return /\.0pa$/i.test(name || '');
  },
  /** @param {string} name - A file name. @returns {boolean} */
  isDataFile(name) {
    return /\.0da$/i.test(name || '');
  },
  /**
   * The project token a program and its calibrations share (457O0L for
   * 0044570LO02S): program at 0x60302 of the external image, calibration at 8.
   * @param {Uint8Array} flash - A full external image.
   * @returns {string|null}
   */
  programProjectToken(flash) {
    return ms45ReadAscii(flash, 0x60302, 6);
  },
  /** @param {Uint8Array} cal - A calibration. @returns {string|null} */
  calibrationProjectToken(cal) {
    return ms45ReadAscii(cal, 8, 6);
  },
  /**
   * @param {Uint8Array} flash - A full external image.
   * @param {Uint8Array} cal - A calibration.
   * @returns {boolean}
   */
  isMatchingPair(flash, cal) {
    const p = ms45ExchangeFile.programProjectToken(flash);
    return p != null && p === ms45ExchangeFile.calibrationProjectToken(cal);
  },
  /**
   * @param {string} text - A .0PA's text (Latin-1 decoded).
   * @returns {{flash: Uint8Array, mpc: Uint8Array, reference: string|null}}
   */
  decodeProgramText(text) {
    const parsed = ms45ExchangeFile._parse(text);
    const flash = new Uint8Array(MS45_FULL_FLASH_LENGTH).fill(0xff);
    const mpc = new Uint8Array(MS45_MPC_LENGTH).fill(0xff);
    const mpcSeen = new Uint8Array(MS45_MPC_LENGTH);
    const flashSeen = new Uint8Array(MS45_FULL_FLASH_LENGTH);
    const programEnd = 0xfff40;
    for (const [address, data] of parsed.records) {
      for (let i = 0; i < data.length; i++) {
        const a = address + i;
        if (a < MS45_MPC_LENGTH) {
          mpc[a] = data[i];
          mpcSeen[a] = 1;
        } else if (
          a >= MS45_EXTERNAL_BASE + MS45_PROGRAM_START &&
          a < MS45_EXTERNAL_BASE + programEnd
        ) {
          flash[a - MS45_EXTERNAL_BASE] = data[i];
          flashSeen[a - MS45_EXTERNAL_BASE] = 1;
        } else {
          throw new Error(
            `this is not an MS45 program file: it has data at 0x${a.toString(16).toUpperCase()}, ` +
              'outside the MPC and the external program area'
          );
        }
      }
    }
    for (let i = 0; i < MS45_MPC_LENGTH; i++) {
      if (!mpcSeen[i])
        throw new Error(
          `the program file is incomplete: the MPC has no data at 0x${i.toString(16).toUpperCase()}`
        );
    }
    for (let i = MS45_PROGRAM_START + 0x100; i < programEnd; i++) {
      if (!flashSeen[i]) {
        throw new Error(
          `the program file is incomplete: the external program has no data at 0x${i.toString(16).toUpperCase()}`
        );
      }
    }
    if (!flashSeen[MS45_PROGRAM_START])
      throw new Error('the program file has no program header');
    return { flash, mpc, reference: parsed.reference };
  },
  /**
   * @param {string} text - A .0DA's text.
   * @returns {{data: Uint8Array, reference: string|null}}
   */
  decodeCalibrationText(text) {
    const parsed = ms45ExchangeFile._parse(text);
    const data = new Uint8Array(MS45_CAL_LENGTH).fill(0xff);
    const seen = new Uint8Array(MS45_CAL_LENGTH);
    const start = MS45_EXTERNAL_BASE + MS45_CAL_START;
    for (const [address, bytes] of parsed.records) {
      for (let i = 0; i < bytes.length; i++) {
        const a = address + i;
        if (a < start || a >= start + MS45_CAL_LENGTH) {
          throw new Error(
            `this is not an MS45 data file: it has data at 0x${a.toString(16).toUpperCase()}, outside the calibration`
          );
        }
        data[a - start] = bytes[i];
        seen[a - start] = 1;
      }
    }
    for (let i = 0x200; i < MS45_CAL_LENGTH; i++) {
      if (!seen[i])
        throw new Error(
          `the data file is incomplete: no data at calibration offset 0x${i.toString(16).toUpperCase()}`
        );
    }
    if (!seen[0]) throw new Error('the data file has no calibration header');
    return { data, reference: parsed.reference };
  },
  _parse(text) {
    if (text == null) throw new Error('no file text');
    const out = { reference: null, records: [] };
    let linear = 0;
    let segment = 0;
    let ended = false;
    let lineNumber = 0;
    for (const raw of String(text).split(/\r?\n/)) {
      lineNumber++;
      const line = raw.trim();
      if (!line) continue;
      if (line[0] === '$') {
        const parts = line.split(/\s+/);
        if (parts.length >= 2 && parts[0] === '$REFERENZ')
          out.reference = parts[1];
        continue;
      }
      if (line[0] !== ':') continue;
      if (ended)
        throw new Error(`line ${lineNumber}: data after the end record`);
      const hex = line.slice(1);
      if (hex.length < 2 || hex.length % 2)
        throw new Error(`line ${lineNumber}: odd number of hex digits`);
      const record = new Uint8Array(hex.length / 2);
      for (let i = 0; i < record.length; i++) {
        const pair = hex.substr(2 * i, 2);
        if (!/^[0-9a-fA-F]{2}$/.test(pair))
          throw new Error(`line ${lineNumber}: not hexadecimal`);
        record[i] = parseInt(pair, 16);
      }
      if (record.length < 5 || record.length !== record[0] + 5)
        throw new Error(`line ${lineNumber}: record length does not match`);
      let sum = 0;
      for (const b of record) sum += b;
      if (sum & 0xff)
        throw new Error(`line ${lineNumber}: record checksum is wrong`);
      const count = record[0];
      const offset = (record[1] << 8) | record[2];
      const type = record[3];
      switch (type) {
        case 0x00:
        case 0x10:
          out.records.push([
            linear + segment + offset,
            record.subarray(4, 4 + count),
          ]);
          break;
        case 0x01:
          ended = true;
          break;
        case 0x02:
          if (count !== 2)
            throw new Error(`line ${lineNumber}: bad segment record`);
          segment = ((record[4] << 8) | record[5]) << 4;
          break;
        case 0x04:
          if (count !== 2)
            throw new Error(`line ${lineNumber}: bad linear address record`);
          linear = ((record[4] << 8) | record[5]) * 0x10000;
          break;
        default:
          throw new Error(
            `line ${lineNumber}: unknown record type 0x${type.toString(16).toUpperCase().padStart(2, '0')}`
          );
      }
    }
    if (!out.records.length) throw new Error('the file has no data records');
    if (!ended) throw new Error('the file is cut short: it has no end record');
    return out;
  },
};

// ---- file / DME agreement, as the reference flasher checks it ---------------------------
/** @param {Uint8Array} tune - A calibration. @param {string} swRef - DATEN_REFERENZ. @returns {boolean} */
function ms45VerifyParameterMatch(tune, swRef) {
  const binref = ms45ReadAscii(tune, 0x10, 0xc);
  return !!swRef && binref != null && swRef.includes(binref);
}
/** @param {Uint8Array} flash - A full image. @param {string} hwRef - HARDWARE_REFERENZ. @returns {boolean} */
function ms45VerifyProgramMatch(flash, hwRef) {
  const binref = ms45ReadAscii(flash, 0x6031c, 0xc);
  return !!hwRef && binref != null && binref.includes(hwRef);
}
/** @param {Uint8Array} flash - A full image. @param {Uint8Array} mpc - The MPC. @returns {boolean} */
function ms45VerifyFlashMpcMatch(flash, mpc) {
  const a = ms45ReadAscii(flash, 0x60310, 0xa);
  const b = ms45ReadAscii(mpc, 0x100, 0xa);
  if (a == null || b == null || !/^\d+$/.test(a) || !/^\d+$/.test(b))
    return false;
  return Number(a) - Number(b) === 500;
}

// ---- jobs over the SGBD -----------------------------------------------------------------
/** Where every job's name, argument, status and telegrams go while a session logs. */
let _ms45JobTrace = null;

/**
 * Route every job the engine runs to a logger (the flash log), or null.
 * @param {((job: string, argSummary: string, status: string, tx: Uint8Array|null, rx: Uint8Array|null) => void)|null} fn - The logger.
 */
function ms45SetJobTrace(fn) {
  _ms45JobTrace = fn;
}

/**
 * A result field as text, whatever its type; '' when absent.
 * @param {{sets?: object[]}} res - A job result.
 * @param {string} field - The register name.
 * @returns {string}
 */
function _ms45Field(res, field) {
  const sets = (res && res.sets) || [];
  for (const s of sets) {
    if (s && Object.prototype.hasOwnProperty.call(s, field)) {
      const v = s[field];
      if (v == null) return '';
      if (v instanceof Uint8Array || Array.isArray(v))
        return Array.from(v, (b) =>
          Number(b).toString(16).padStart(2, '0')
        ).join('');
      return String(v).trim();
    }
  }
  return '';
}

/**
 * A result field as bytes, decoding the dashed-hex or number-array forms.
 * @param {{sets?: object[]}} res - A job result.
 * @param {string} field - The register name.
 * @returns {Uint8Array}
 */
function _ms45Bytes(res, field) {
  const sets = (res && res.sets) || [];
  for (const s of sets) {
    if (!s || !Object.prototype.hasOwnProperty.call(s, field)) continue;
    const v = s[field];
    if (v instanceof Uint8Array) return v;
    if (Array.isArray(v)) return Uint8Array.from(v.map(Number));
    if (typeof v === 'string' && v) {
      const out = [];
      for (const p of v.split('-')) {
        const n = parseInt(p, 16);
        if (!Number.isFinite(n)) return new Uint8Array(0);
        out.push(n);
      }
      return Uint8Array.from(out);
    }
  }
  return new Uint8Array(0);
}

/**
 * A binary job argument. The VM derives the arg bytes from the arg STRING
 * via CP1252, so a byte blob is passed as a Latin-1 string, one char per byte.
 * @param {Iterable<number>} bytes - The bytes.
 * @returns {string}
 */
function _ms45BinArg(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b & 0xff);
  return s;
}

function _ms45ArgSummary(arg) {
  if (arg instanceof Uint8Array) {
    const n = Math.min(arg.length, 8);
    return `${arg.length}B: ${Array.from(arg.subarray(0, n), (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')}${arg.length > n ? ' ...' : ''}`;
  }
  return arg == null ? '' : String(arg);
}

/**
 * Run one job on the DME's SGBD, the way the reference flasher's ExecuteJob
 * does: a thrown error or a JOB_STATUS other than OKAY is a failure, and
 * every job (with its telegrams) goes to the trace while a session logs.
 * @param {string} job - The job name.
 * @param {string|Uint8Array} [arg] - The argument (a Uint8Array is a binary argument).
 * @returns {Promise<{ok: boolean, status: string, res: {sets?: object[]}|null, error: string|null}>}
 */
/**
 * The job runner: on a shared car the owner's (core/webshim/job-runner.js's
 * webRunJobAnywhere), else this machine's webRunJob -- which a headless
 * test stands in for, so the choice is made per call.
 * @returns {(sgbd: string, job: string, arg: string) => Promise<{sets?: object[]}>}
 */
function _ms45Runner() {
  // on this machine's own cable the job's telegrams go by _ms45Wire
  if (
    typeof webBus !== 'undefined' &&
    typeof webRunJob === 'function' &&
    typeof ifhError === 'function' &&
    !(typeof webOnSharedCar === 'function' && webOnSharedCar())
  )
    return (sgbd, job, arg) =>
      webRunJob(sgbd, job, arg, { exchange: _ms45Wire });
  return typeof webRunJobAnywhere === 'function'
    ? webRunJobAnywhere
    : webRunJob;
}

// THE FIRST TELEGRAM NOBODY ANSWERS. The SGBD's INITIALISIERUNG does not know
// which protocol the DME speaks, so it asks in BMW-FAST first (concept 271:
// 82 12 F1 1A 80 at 115200 baud) and, when that is met with silence, again
// in KWP2000* at 9600, which a K-line MS45 answers. The silence is waited
// out in full, twice (the retransmit), with the cable's rate changed for it
// and changed back: over a second and a half at the start of every session,
// and several on the emulator. Once a DME has been seen to stay silent in
// BMW-FAST and answer in KWP2000*, that first question is answered here, as
// the silence it would have been, without going to the wire.
const MS45_CONCEPT_BMW_FAST = 271;
const MS45_NOT_FAST_KEY = 'bmweb.ms45.notFast';
/** This DME was seen to ignore BMW-FAST and answer KWP2000*. */
let _ms45NotFast = (() => {
  try {
    return localStorage.getItem(MS45_NOT_FAST_KEY) === '1';
  } catch (e) {
    return false;
  }
})();
/** A BMW-FAST telegram went unanswered and nothing has answered since. */
let _ms45FastWentSilent = false;

/**
 * Remember (or forget) that the DME does not speak BMW-FAST.
 * @param {boolean} on
 * @returns {void}
 */
function _ms45SetNotFast(on) {
  _ms45NotFast = on;
  try {
    if (on) localStorage.setItem(MS45_NOT_FAST_KEY, '1');
    else localStorage.removeItem(MS45_NOT_FAST_KEY);
  } catch (e) {
    // a private window: remembered for as long as the page lives
  }
}

/**
 * One telegram of a job, to the wire -- except the BMW-FAST question to a
 * DME known not to answer it.
 * @param {number[]|Uint8Array} out - The telegram.
 * @param {{concept?: number}} comm - The wire parameters it goes by.
 * @returns {Promise<Uint8Array|number[]>}
 */
async function _ms45Wire(out, comm) {
  const fast = !!comm && comm.concept === MS45_CONCEPT_BMW_FAST;
  if (fast && _ms45NotFast)
    throw ifhError('IFH-0009', 'not asked: this DME answers KWP2000*');
  try {
    const answer = await webBus.exchange(out, comm);
    if (fast) {
      _ms45FastWentSilent = false;
    } else if (_ms45FastWentSilent) {
      _ms45FastWentSilent = false;
      _ms45SetNotFast(true);
    }
    return answer;
  } catch (e) {
    // silence, or an echo that did not come back clean at that rate
    if (fast && e && (e.ifh === 'IFH-0009' || e.ifh === 'IFH-0003'))
      _ms45FastWentSilent = true;
    throw e;
  }
}

async function ms45Job(job, arg) {
  const text =
    arg instanceof Uint8Array
      ? _ms45BinArg(arg)
      : arg == null
        ? ''
        : String(arg);
  let res;
  try {
    res = await _ms45Runner()(MS45_SGBD, job, text);
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (_ms45JobTrace)
      _ms45JobTrace(job, _ms45ArgSummary(arg), `EXCEPTION: ${msg}`, null, null);
    return { ok: false, status: '', res: null, error: msg };
  }
  const status = _ms45Field(res, 'JOB_STATUS');
  if (_ms45JobTrace) {
    const tx = _ms45Bytes(res, '_TEL_AUFTRAG');
    const rx = _ms45Bytes(res, '_TEL_ANTWORT');
    _ms45JobTrace(
      job,
      _ms45ArgSummary(arg),
      status,
      tx.length ? tx : null,
      rx.length ? rx : null
    );
  }
  return { ok: status === 'OKAY', status, res, error: null };
}

/** The AIF results identify keeps, in the DME's own names. */
const ms45AifFields = [
  'AIF_FG_NR',
  'AIF_FG_NR_LANG',
  'AIF_DATUM',
  'AIF_ZB_NR',
  'AIF_SW_NR',
  'AIF_BEHOERDEN_NR',
  'AIF_HAENDLER_NR',
  'AIF_SERIEN_NR',
  'AIF_KM',
  'AIF_PROG_NR',
  'AIF_ANZ_FREI',
  'AIF_ANZAHL_PROG',
  'AIF_ADRESSE_HIGH',
  'AIF_ADRESSE_LOW',
  'AIF_AENDERUNGS_INDEX',
];

/**
 * What identifying the DME returned.
 * @typedef {Object} Ms45Ident
 * @property {boolean} answered - Whether the DME answered at all.
 * @property {string} vin
 * @property {string} hwRef - HARDWARE_REFERENZ.
 * @property {string} swRef - DATEN_REFERENZ.
 * @property {string} progRef - ZIF_PROGRAMM_REFERENZ, '' when not reported.
 * @property {string} programmingStatus - FLASH_PROGRAMMIER_STATUS_TEXT.
 * @property {string} diagProtocol - DIAG_PROT_IST.
 * @property {string} type - MS45.0, MS45.1 or 'Unknown / Unsupported'.
 * @property {Object<string,string>} aif - The newest AIF entry's fields.
 */

/**
 * Read the DME's identity: VIN and AIF entry, hardware and data references,
 * the program reference, the programming status and the diagnostic protocol.
 * @returns {Promise<Ms45Ident>}
 */
/**
 * Identify the DME: the coding data, the references, the programming status
 * and the protocol. With `opts.raise`, the line rate goes up as soon as the
 * DME has answered once and stays up (ms45RaiseBaud): the caller reads more
 * on the same session and brings the rate back down (ms45DefaultBaud) --
 * `baud` in the result says what the session is at.
 * @param {{raise?: boolean, onSilent?: () => Promise<boolean>}} [opts] - onSilent: asked once the first read goes unanswered; true ends Identify there (the caller found the DME another way).
 */
async function ms45Identify(opts = {}) {
  // the first job after a flash's reset can land while the DME is still
  // restarting (seen: the AIF unanswered two seconds after the reset, read
  // fine on the next identify), so an unanswered first read is asked again
  let aifRes = await ms45Job('aif_lesen', '');
  if (!aifRes.ok && _ms45NotFast) {
    // the BMW-FAST question was skipped on what was learned from another
    // DME, and this one said nothing: ask it properly, from the start
    _ms45SetNotFast(false);
    if (typeof webDropSession === 'function') webDropSession(MS45_SGBD);
    aifRes = await ms45Job('aif_lesen', '');
  }
  // silent on KWP: the caller may know another way to ask (a DME sitting
  // in a flasher answers nothing else), before the retry below waits out
  // another timeout
  if (!aifRes.ok && opts.onSilent && (await opts.onSilent()))
    return {
      answered: false,
      vin: '',
      hwRef: '',
      swRef: '',
      progRef: '',
      programmingStatus: '',
      diagProtocol: '',
      diagProblem: 'no answer',
      type: 'Unknown / Unsupported',
      aif: {},
      baud: 9600,
    };
  if (!aifRes.ok) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    aifRes = await ms45Job('aif_lesen', '');
  }
  // the DME has spoken: the rest of identify, and the memory reads the
  // caller makes after it, go at the cable's rate rather than 9600
  let baud = 9600;
  if (opts.raise && aifRes.ok) {
    try {
      baud = await ms45RaiseBaud();
    } catch (e) {
      baud = 9600;
    }
  }
  const aif = {};
  for (const f of ms45AifFields) {
    const v = _ms45Field(aifRes.res, f);
    if (v) aif[f] = v;
  }
  const vin = _ms45Field(aifRes.res, 'AIF_FG_NR');
  const hwRef = _ms45Field(
    (await ms45Job('hardware_referenz_lesen', '')).res,
    'HARDWARE_REFERENZ'
  );
  // neither the AIF nor the hardware reference: the DME is not on its
  // program (silent, or sitting in a flasher). The four questions below
  // would each wait out their own timeout -- tens of seconds -- before the
  // caller can ask the flasher, so say so now
  if (!aifRes.ok && !hwRef)
    return {
      answered: false,
      vin: '',
      hwRef: '',
      swRef: '',
      progRef: '',
      programmingStatus: '',
      diagProtocol: '',
      diagProblem: 'no answer',
      type: 'Unknown / Unsupported',
      aif,
      baud,
    };
  const swRef = _ms45Field(
    (await ms45Job('daten_referenz_lesen', '')).res,
    'DATEN_REFERENZ'
  );
  // the PROGRAM reference ($2503), which is what the EWS patch is tied to;
  // DATEN_REFERENZ does not tell the two MS45.1 programs apart
  const zif = await ms45Job('ZIF_LESEN', '');
  const progRef = zif.ok ? _ms45Field(zif.res, 'ZIF_PROGRAMM_REFERENZ') : '';
  const programmingStatus = _ms45Field(
    (await ms45Job('flash_programmier_status_lesen', '')).res,
    'FLASH_PROGRAMMIER_STATUS_TEXT'
  );
  let type = 'Unknown / Unsupported';
  if (hwRef === '0044560') type = 'MS45.0';
  if (hwRef === '0044570') type = 'MS45.1';
  const diag = await ms45Job('DIAGNOSEPROTOKOLL_LESEN', '');
  // the hardware reference is the answer that counts; the protocol query
  // failing on its own (a job error, not silence) is reported, not mistaken
  // for a DME that did not speak
  const answered = !!hwRef;
  const diagProtocol = diag.ok ? _ms45Field(diag.res, 'DIAG_PROT_IST') : '';
  const diagProblem = diag.ok ? '' : diag.error || diag.status || 'no answer';
  return {
    answered,
    vin,
    hwRef,
    swRef,
    progRef,
    programmingStatus,
    diagProtocol,
    diagProblem,
    type,
    aif,
    baud,
  };
}

/**
 * Read memory with speicher_lesen_ascii in 254-byte chunks. Returns what was
 * read up to the first failure (the reference tool's behaviour); a caller
 * checks the length.
 * @param {number} start - First address.
 * @param {number} end - Last address, inclusive.
 * @param {string} segment - ROMX (external flash) or LAR (MPC / RAM).
 * @param {{onProgress?: (pct: number) => void, abort?: AbortSignal}} [opts]
 * @returns {Promise<Uint8Array>}
 */
async function ms45ReadMemory(start, end, segment, opts = {}) {
  const length = end - start + 1;
  const out = new Uint8Array(length);
  let done = 0;
  let addr = start;
  while (done < length) {
    if (opts.abort && opts.abort.aborted) throw new Error('cancelled');
    const want = Math.min(254, length - done);
    const r = await ms45Job(
      'speicher_lesen_ascii',
      `${segment};${addr};${want}`
    );
    if (!r.ok) return out.subarray(0, done);
    const bytes = _ms45Bytes(r.res, 'DATEN');
    if (!bytes.length) return out.subarray(0, done);
    const n = Math.min(bytes.length, want);
    out.set(bytes.subarray(0, n), done);
    done += n;
    addr += n;
    opts.onProgress && opts.onProgress(Math.round((done * 100) / length));
    if (n < want) return out.subarray(0, done);
  }
  return out;
}

/** The DME's own record of its self-resets, in RAM: the count and the last cause. */
const MS45_RESET_RECORD = {
  start: 0x3fa0a2, // the cause code of the last self-reset
  end: 0x3fa0b4, // the cause code plus 0x6d, which says the record is valid
  count: 0x3fa0b2, // how many, plus 0x6d at the next byte
  check: 0x6d,
  causes: {
    1: 'the monitoring module answered wrongly',
    2: 'the monitoring module answered wrongly',
    3: 'the monitoring module answered wrongly',
    4: 'the monitoring module answered wrongly',
    5: 'the monitoring module answered wrongly',
    9: 'the monitoring level found the calibration checksum wrong',
    10: 'a safety monitor check failed (torque or speed)',
    11: 'the program checksum was wrong',
    12: 'the RAM test at start failed',
  },
};

/**
 * Read the DME's self-reset record: a DME that fails one of its own checks
 * resets itself (a deliberate machine check) and stores no fault, but
 * counts the resets in RAM with the cause of the last one, and the count
 * only decays slowly while the engine runs cleanly. A reset ordered from
 * outside (the monitoring module's hardware line) leaves no record.
 * @returns {Promise<{count: number, code?: number}|null>} null when the
 *   bytes could not be read; count 0 when nothing valid is recorded.
 */
async function ms45ReadResetRecord() {
  const r = MS45_RESET_RECORD;
  let bytes;
  try {
    bytes = await ms45ReadMemory(r.start, r.end, 'LAR');
  } catch (e) {
    return null;
  }
  if (bytes.length !== r.end - r.start + 1) return null;
  const at = (a) => bytes[a - r.start];
  const count = at(r.count);
  const code = at(r.start);
  const valid =
    at(r.count + 1) === (count + r.check) % 256 &&
    at(r.end) === (code + r.check) % 256;
  return valid && count ? { count, code } : { count: 0 };
}

/**
 * The record in words.
 * @param {{count: number, code?: number}} r
 * @returns {string}
 */
function ms45ResetRecordText(r) {
  if (!r.count) return 'none recorded';
  const why = MS45_RESET_RECORD.causes[r.code] || `code ${r.code}`;
  return `${r.count}${r.count >= 8 ? ' (the limit; the DME no longer resets for this)' : ''}, last because ${why}`;
}

/**
 * The bytes from start to end inclusive, or null when the read came back
 * short. Outside BMW-FAST a memory read needs security access first; it is
 * only asked for if the plain read did not work.
 * @param {number} start - First address.
 * @param {number} end - Last address, inclusive.
 * @param {string} segment - ROMX or LAR.
 * @param {string} diagProtocol - DIAG_PROT_IST.
 * @returns {Promise<Uint8Array|null>}
 */
async function ms45ReadCarBytes(start, end, segment, diagProtocol) {
  const wanted = end - start + 1;
  let data = await ms45ReadMemory(start, end, segment);
  if (
    data.length !== wanted &&
    diagProtocol !== 'BMW-FAST' &&
    (await ms45SecurityAccess(diagProtocol))
  ) {
    data = await ms45ReadMemory(start, end, segment);
  }
  return data.length === wanted ? data : null;
}

/**
 * Security access: serial, seed, the signed key, then programming mode (and
 * the 115200 ramp on cars that are not BMW-FAST).
 * @param {string} diagProtocol - DIAG_PROT_IST.
 * @param {(text: string) => void} [onStage] - Progress callback.
 * @returns {Promise<boolean>}
 */
async function ms45SecurityAccess(diagProtocol, onStage) {
  const stage = onStage || (() => {});
  stage('Requesting Security Access');
  const serialRes = await ms45Job('seriennummer_lesen', '');
  if (!serialRes.ok) {
    stage('Could not read the DME serial number');
    return false;
  }
  // the last 4 bytes of the answer's payload, whatever shape the transport
  // hands the telegram in (flasherSerialFromReply)
  const serial = flasherSerialFromReply(
    _ms45Bytes(serialRes.res, '_TEL_ANTWORT')
  );
  if (serial.length !== 4) {
    stage('Could not read the DME serial number');
    return false;
  }
  const userId = new Uint8Array(4);
  (globalThis.crypto || require('crypto').webcrypto).getRandomValues(userId);
  const userIdHex =
    '0x' +
    Array.from(userId, (b) => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  const seedRes = await ms45Job(
    'authentisierung_zufallszahl_lesen',
    `3;${userIdHex}`
  );
  const seed = seedRes.ok ? _ms45Bytes(seedRes.res, 'ZUFALLSZAHL') : [];
  if (!seed.length) {
    stage('The DME gave no seed');
    return false;
  }
  if (
    !(
      await ms45Job(
        'authentisierung_start',
        ms45Checksums.securityAccessMessage(userId, serial, seed)
      )
    ).ok
  ) {
    stage('The DME refused the key');
    return false;
  }
  if (diagProtocol !== 'BMW-FAST') {
    // the line the Baud Test proved, when it is faster than 115200: the
    // loader takes a rate by value (DIAGNOSE_MODE's BAUDRATE "SB", KWP
    // 10 85 06 + 24 bits); otherwise the SGBD's list, as always
    const fast = ms45FastLineBaud();
    _ms45LineBaud = fast || flasherProgrammingBaud();
    for (const [job, arg] of ms45ProgrammingSteps(fast)) {
      if (!(await ms45Job(job, arg)).ok) {
        stage(`Could not enter programming mode (${job} ${arg})`);
        return false;
      }
    }
    if (fast) stage(`Programming at ${fast} baud`);
  } else if (!(await ms45Job('diagnose_mode', 'ECUPM')).ok) {
    stage('Could not enter programming mode');
    return false;
  }
  return true;
}

/**
 * The rates a programming session steps down through on a marginal line.
 * Not 416667: the fast flasher carries it, but a loader session there
 * entered programming mode and then never answered its erase on the car
 * (2026-10-26, the cal left erased) -- the loader's programming mode starts
 * at the SGBD's 115200 unless a slower-than-416667 rate is remembered.
 */
const MS45_LINE_STEPS = [312500, 250000, 208333, 156250, 115200];
/** The programming session's current rate (set on entry, lowered by a step-down). */
let _ms45LineBaud = 115200;

/**
 * The rate the stock loader's programming session starts at: always the
 * SGBD's 115200. The Baud Test's faster rate (Settings fastLineBest) is the
 * fast flasher's line; a standard program write at 250000 went unanswered
 * on the car (2026-10-28, the second block after a good first one, the
 * loader alive throughout), so the slow path keeps the rate every proven
 * flash used until it is proven at speed.
 * @returns {number} 0: the standard rate.
 */
function ms45FastLineBaud() {
  return 0;
}

/**
 * The jobs that put the DME (already authenticated) into programming mode
 * at a rate: the SGBD's own PC115200 list entry, or "SB" with the value.
 * @param {number} baud - 0 or 115200 for the standard rate.
 * @returns {Array<[string, string]>}
 */
function ms45ProgrammingSteps(baud) {
  if (!baud || baud === 115200)
    return [
      ['diagnose_mode', 'ECUPM;PC115200'],
      ['SET_PARAMETER', ';115200'],
      ['ACCESS_TIMING_PARAMETER', '00;120;24;240;00'],
      ['SET_PARAMETER', ';115200;;15'],
    ].map(([j, a]) => [j, flasherProgrammingArg(a)]);
  return [
    ['diagnose_mode', `ECUPM;SB;${baud}`],
    ['SET_PARAMETER', `;${baud}`],
    ['ACCESS_TIMING_PARAMETER', '00;120;24;240;00'],
    ['SET_PARAMETER', `;${baud};;15`],
  ];
}

/**
 * Between download ranges: when the line garbled two answers since `since`
 * (the transport retransmitted them), move the programming session one rate
 * down and remember it for the next flash. The loader takes a new rate in
 * programming mode between ranges (proven on the emulated loader).
 * @param {number} since - The transport's garble count at the session's start.
 * @param {(s: string) => void} stage
 * @returns {Promise<number>} The garble count to measure from next.
 */
async function ms45MaybeStepDown(since, stage) {
  const bus = typeof webBus !== 'undefined' ? webBus : null;
  const now = (bus && bus.garbles) || 0;
  if (now - since < 2 || _ms45LineBaud <= 115200) return since;
  const at = MS45_LINE_STEPS.indexOf(_ms45LineBaud);
  const lower = MS45_LINE_STEPS[at + 1] || 115200;
  stage(
    `${now - since} garbled answers at ${_ms45LineBaud} baud: stepping the line down to ${lower}`
  );
  for (const [job, arg] of ms45ProgrammingSteps(lower)) {
    if (!(await ms45Job(job, arg)).ok) {
      stage(`Could not step the line down (${job} ${arg})`);
      return now;
    }
  }
  _ms45LineBaud = lower;
  if (typeof Settings !== 'undefined')
    Settings.set('fastLineBest', lower > 115200 ? lower : 0);
  return now;
}

/**
 * Raise the line rate of the DEFAULT session for a long read. The DME takes
 * a rate with its session request (10 81 <rate>, no authentication) and
 * keeps answering every default-session service at it, memory reads and the
 * live-tune ops included; the calibration then reads in under a minute where
 * 9600 baud takes three. The rate is the one the cable can carry
 * (flasherProgrammingBaud: 115200, or 19200 on an adapter without parity at
 * speed). Always paired with ms45DefaultBaud, in a finally.
 * @returns {Promise<number>} The rate now in use; 9600 when it did not go up.
 */
async function ms45RaiseBaud() {
  const baud =
    typeof flasherProgrammingBaud === 'function'
      ? flasherProgrammingBaud()
      : 115200;
  if (baud === 9600) return 9600;
  if (!(await ms45Job('diagnose_mode', `DEFAULT;PC${baud}`)).ok) return 9600; // refused: nothing changed
  if (!(await ms45Job('SET_PARAMETER', `;${baud}`)).ok) {
    // the DME moved and this side did not: go and fetch it back
    await ms45DefaultBaud();
    return 9600;
  }
  return baud;
}

/**
 * The default session back at 9600 baud, where every other part of the app
 * expects to find the DME.
 * @returns {Promise<boolean>}
 */
async function ms45DefaultBaud() {
  const a = await ms45Job('diagnose_mode', 'DEFAULT;PC9600');
  const b = await ms45Job('SET_PARAMETER', ';9600');
  return a.ok && b.ok;
}

/**
 * Back to the normal diagnostic session at 9600, for cars that were ramped.
 * @param {string} diagProtocol - DIAG_PROT_IST.
 * @returns {Promise<boolean>}
 */
async function ms45LeaveProgrammingMode(diagProtocol) {
  if (diagProtocol === 'BMW-FAST') return true;
  if (!(await ms45Job('diagnose_mode', 'DEFAULT;PC9600')).ok) return false;
  return (await ms45Job('SET_PARAMETER', ';9600')).ok;
}

/**
 * Whether a flash job's result field reads 1, the DME's "done". The SGBD
 * answers OKAY to any positive reply -- an erase answered 71 02 00, a block
 * answered 76 .. 02 -- and puts the DME's own verdict in this field; WinKFP's
 * programming procedure (12MDS451.IPO) stops on anything but 1.
 * @param {{res: object}} r - What ms45Job returned.
 * @param {string} field - FLASH_LOESCHEN_STATUS, FLASH_SCHREIBEN_STATUS, ...
 * @returns {boolean}
 */
function _ms45ResultIsOne(r, field) {
  return _ms45Field(r.res, field) === '1';
}

/**
 * The post-flash sequence: drop back to normal comms, verify the signature,
 * reset the ECU. When several partitions are written in one session, each is
 * checked but only the last resets, and the last must leave the DME reporting
 * normal operation (programming status 1), as WinKFP requires; any other
 * status means the DME will stay in its boot loader.
 * @param {'Programm'|'Daten'} area - Which signature.
 * @param {boolean} resetEcu - Whether to reset at the end.
 * @param {string} diagProtocol - DIAG_PROT_IST.
 * @param {(text: string) => void} [onStage] - Progress callback.
 * @param {boolean} [runSignatureCheck=true] - Pass false only when the flash
 *   plan kept the valid marks pair intact (a quick flash whose plan avoided
 *   the marks sector): the check is then vacuous -- the still-valid pair
 *   answers "nothing to check" (71 09 00), which the SGBD reports as
 *   ERROR_FLASH_SIGNATURE_CHECK.
 * @returns {Promise<boolean>}
 */
async function ms45FinishFlash(
  area,
  resetEcu,
  diagProtocol,
  onStage,
  runSignatureCheck = true
) {
  const stage = onStage || (() => {});
  if (diagProtocol !== 'BMW-FAST') {
    if (!(await ms45Job('diagnose_mode', 'DEFAULT;PC9600')).ok) return false;
    if (!(await ms45Job('SET_PARAMETER', ';9600')).ok) return false;
  } else {
    if (area === 'Daten' && !(await ms45Job('diagnose_mode', 'DEFAULT')).ok)
      return false;
    if (!(await ms45Job('normaler_datenverkehr', 'ja;nein;ja')).ok)
      return false;
  }
  if (!(await ms45Job('FLASH_PROGRAMMIER_STATUS_LESEN', '')).ok) return false;
  if (runSignatureCheck) {
    stage('Checking signature');
    if (!(await ms45Job('FLASH_SIGNATUR_PRUEFEN', `${area};64`)).ok) {
      stage('Signature check failed');
      await ms45Reset();
      return false;
    }
  } else {
    // a plan that kept the marks sector valid makes the check vacuous: the
    // still-valid pair answers "nothing to check" (71 09 00), which the
    // SGBD reports as an error. The DME rebooting on the new program is
    // the verification then. (Emulator-measured; see the quick-flash plan.)
    stage('Skipping signature check (the valid marks were kept)');
  }
  const after = await ms45Job('FLASH_PROGRAMMIER_STATUS_LESEN', '');
  if (!after.ok) return false;
  if (!resetEcu) return true;
  if (!_ms45ResultIsOne(after, 'FLASH_PROGRAMMIER_STATUS')) {
    const status = _ms45Field(after.res, 'FLASH_PROGRAMMIER_STATUS') || '?';
    const text = _ms45Field(after.res, 'FLASH_PROGRAMMIER_STATUS_TEXT');
    stage(
      `The DME is not back to normal operation: programming status ${status}${text ? ` (${text})` : ''}`
    );
    await ms45Reset();
    return false;
  }
  stage('Resetting ECU');
  return ms45Reset();
}

/**
 * Reset the DME and forget its session: the module reboots out of the
 * diagnostic session the SGBD's INITIALISIERUNG opened, so the next job must
 * open it again (the reference tool does this by starting a fresh EDIABAS
 * for every operation). Without it the re-identify after a flash still
 * answers, but AIF_SCHREIBEN is refused as not supported in the active
 * diagnostic mode.
 * @returns {Promise<boolean>} Whether the reset job answered OKAY.
 */
async function ms45Reset() {
  const ok = (await ms45Job('STEUERGERAETE_RESET', '')).ok;
  if (typeof webDropSession === 'function') webDropSession(MS45_SGBD);
  return ok;
}

function _ms45Le32(v) {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

/**
 * flash_loeschen for exactly the start/length given. The DME erases only
 * that, and refuses a download to a sector that has not been erased. Done
 * only when the DME's answer (71 02 <status>) says 1.
 * @param {number} blockStart - The address as the DME sees it (0x2040000 ...).
 * @param {number} blockLength - The length.
 * @param {(text: string) => void} [onStage] - Told why, when it fails.
 * @returns {Promise<boolean>}
 */
async function ms45Erase(blockStart, blockLength, onStage) {
  const cmd = new Uint8Array(22);
  cmd[0] = 1;
  cmd[4] = 0xfe;
  cmd.set(_ms45Le32(blockLength), 13);
  cmd.set(_ms45Le32(blockStart), 17);
  const r = await ms45Job('flash_loeschen', cmd);
  if (!r.ok) return false;
  if (!_ms45ResultIsOne(r, 'FLASH_LOESCHEN_STATUS')) {
    onStage &&
      onStage(
        `The DME did not erase 0x${blockStart.toString(16).toUpperCase()}: erase status ` +
          `${_ms45Field(r.res, 'FLASH_LOESCHEN_STATUS') || 'missing'}`
      );
    return false;
  }
  return true;
}

/** The flash_schreiben segment: the most data one KWP telegram carries. */
const MS45_FLASH_SEGMENT = 0xfd;

/**
 * The runs of a block worth sending: consecutive 0xFD-byte segments that are
 * not all 0xFF. An erased sector reads 0xFF, and programming 0xFF over 0xFF
 * changes nothing, so a blank segment is left out and the DME ends up with
 * the same bytes as from a full write. Each run becomes its own
 * flash_schreiben_adresse .. flash_schreiben_ende; the loader takes a
 * download at any address, odd ones included, and the DME's own checksum
 * and signature check judge the result (verified on the emulated loader).
 * Runs are relative to `toFlash`, so none can reach past the block: the
 * loader does NOT refuse a range that leaves the erased sector.
 * @param {Uint8Array} toFlash - The block's bytes.
 * @param {number} [seg=0xFD] - The segment the grid is laid on.
 * @returns {{from: number, length: number}[]} In address order, never
 *   overlapping; empty for an all-0xFF block.
 */
function ms45FlashRuns(toFlash, seg = MS45_FLASH_SEGMENT) {
  const runs = [];
  let run = null;
  for (let at = 0; at < toFlash.length; at += seg) {
    const end = Math.min(at + seg, toFlash.length);
    let blank = true;
    for (let i = at; i < end; i++) {
      if (toFlash[i] !== 0xff) {
        blank = false;
        break;
      }
    }
    if (blank) {
      run = null;
    } else if (run) {
      run.length = end - run.from;
    } else {
      run = { from: at, length: end - at };
      runs.push(run);
    }
  }
  return runs;
}

/**
 * The 22-byte argument of flash_schreiben_adresse / flash_schreiben_ende for
 * one download range.
 * @param {number} start - The DME address of the range's first byte.
 * @param {number} length - The range's length.
 * @returns {Uint8Array}
 */
function _ms45RangeArg(start, length) {
  const arg = new Uint8Array(22);
  arg[0] = 1;
  arg[21] = 3;
  arg.set(_ms45Le32(length), 13);
  arg.set(_ms45Le32(start), 17);
  return arg;
}

/**
 * Write a block: for each run of non-blank segments (ms45FlashRuns),
 * flash_schreiben_adresse, then flash_schreiben in 0xFD-byte segments, then
 * flash_schreiben_ende. A failed segment resets the DME. Progress counts the
 * skipped bytes as done.
 * @param {Uint8Array} toFlash - The bytes for [blockStart, blockEnd].
 * @param {number} blockStart - The DME address of the first byte.
 * @param {number} blockEnd - The DME address of the last byte.
 * @param {{onProgress?: (pct: number) => void, onStage?: (text: string) => void, onNote?: (text: string) => void, abort?: AbortSignal}} [opts]
 * @returns {Promise<boolean>}
 */
async function ms45FlashBlock(toFlash, blockStart, blockEnd, opts = {}) {
  const stage = opts.onStage || (() => {});
  const note = opts.onNote || (() => {});
  const total = blockEnd - blockStart + 1;
  if (toFlash.length < total) {
    stage(`Flash image is ${toFlash.length} bytes for a ${total}-byte block`);
    return false;
  }
  if (toFlash.length > total) toFlash = toFlash.subarray(0, total);
  const progress = (done) => {
    opts.onProgress &&
      opts.onProgress(Math.floor((done * 100) / Math.max(1, total - 1)));
  };
  const runs = ms45FlashRuns(toFlash);
  const sending = runs.reduce((n, r) => n + r.length, 0);
  const skipped = Math.ceil((total - sending) / MS45_FLASH_SEGMENT);
  if (skipped)
    note(
      `Skipping ${skipped} blank (0xFF) blocks of ${Math.ceil(total / MS45_FLASH_SEGMENT)}: ${runs.length} download range${runs.length === 1 ? '' : 's'}`
    );
  let garblesFrom =
    (typeof webBus !== 'undefined' && webBus && webBus.garbles) || 0;
  for (const run of runs) {
    garblesFrom = await ms45MaybeStepDown(garblesFrom, stage);
    const rangeArg = _ms45RangeArg(blockStart + run.from, run.length);
    if (!(await ms45Job('flash_schreiben_adresse', rangeArg)).ok) {
      stage('Failed to set flash address');
      return false;
    }
    let at = run.from;
    const runEnd = run.from + run.length;
    while (at < runEnd) {
      if (opts.abort && opts.abort.aborted) throw new Error('cancelled');
      const seg = Math.min(MS45_FLASH_SEGMENT, runEnd - at);
      const address = blockStart + at;
      const header = new Uint8Array(21);
      header[0] = 1;
      header[13] = seg;
      header.set(_ms45Le32(address), 17);
      const telegram = _ms45Concat([
        header,
        toFlash.subarray(at, at + seg),
        Uint8Array.from([3]),
      ]);
      const r = await ms45Job('flash_schreiben', telegram);
      // the answer is 76 <block counter> <status>: 01 programmed, 02 not
      if (!r.ok || !_ms45ResultIsOne(r, 'FLASH_SCHREIBEN_STATUS')) {
        const why = r.ok
          ? ` (write status ${_ms45Field(r.res, 'FLASH_SCHREIBEN_STATUS') || 'missing'})`
          : '';
        stage(
          `Flash failed at 0x${address.toString(16).toUpperCase()}${why}. Resetting DME.`
        );
        if (!(await ms45Reset())) stage('Error Resetting ECU');
        return false;
      }
      at += seg;
      progress(at);
    }
    if (!(await ms45Job('flash_schreiben_ende', rangeArg)).ok) {
      stage('Failed to end flash job');
      return false;
    }
  }
  progress(total - 1);
  return true;
}

/**
 * AIF_SCHREIBEN: append a programming entry. The job checks every argument's
 * shape (VIN 7 or 17, date TT.MM.JJJJ, ZB / SW / approval 7 or 9, dealer 6,
 * tester serial 5, program reference 12, km long).
 * @param {string} args - The semicolon-joined arguments.
 * @returns {Promise<{ok: boolean, status: string, number: string}>}
 */
async function ms45WriteAif(args) {
  const r = await ms45Job('AIF_SCHREIBEN', args);
  return {
    ok: r.ok,
    status: r.status || (r.error ? `job failed: ${r.error}` : 'job failed'),
    number: _ms45Field(r.res, 'AIF_NUMMER'),
  };
}

if (typeof window !== 'undefined') {
  Object.assign(window, {
    MS45_SGBD,
    MS45_FULL_FLASH_LENGTH,
    MS45_MPC_LENGTH,
    MS45_CAL_START,
    MS45_CAL_LENGTH,
    MS45_PROGRAM_START,
    ms45Crc32,
    ms45Checksums,
    ewsDelete,
    ms45ExchangeFile,
    ms45Job,
    ms45SetJobTrace,
    ms45Identify,
    ms45ReadMemory,
    ms45ReadCarBytes,
    ms45SecurityAccess,
    ms45LeaveProgrammingMode,
    ms45FinishFlash,
    ms45Erase,
    ms45FlashBlock,
    ms45FlashRuns,
    ms45WriteAif,
    ms45AifFields,
    ms45ReadAscii,
    ms45VerifyParameterMatch,
    ms45VerifyProgramMatch,
    ms45VerifyFlashMpcMatch,
  });
}
/**
 * A send-path for the live-tune client (core/ms45/livetune.js): takes a request's
 * DATA bytes, frames them as a KWP2000* telegram (B8 12 F1 len data xor),
 * runs it on the raw wire under the bus lock with the MS45 session's comm,
 * and returns the answer's DATA bytes (the B8 F1 12 len header and the
 * trailing checksum stripped), or null when the DME said nothing.
 *
 * The client's own ops are idempotent-safe against the exchange layer's one
 * retransmission except the save, whose silence IS the success signal; the
 * client treats a null answer there as "it saved and reset".
 * @param {{waitMs?: number, wireMs?: number}} [timing] - Filled in for each
 *   telegram: how long it waited for the bus, and how long the exchange took.
 * @returns {(data: number[]) => Promise<number[]|Uint8Array|null>}
 */
function ms45LiveTuneSender(timing) {
  if (
    typeof webBusRawExchange !== 'function' ||
    typeof withBusLock !== 'function'
  )
    throw new Error('the K-line bus is not available');
  return (data) => {
    const askedAt = Date.now();
    return withBusLock(async () => {
      // where a slow telegram spent its time: queued behind someone else's
      // use of the bus, or out on the wire
      const gotBusAt = Date.now();
      if (timing) {
        timing.waitMs = gotBusAt - askedAt;
        timing.wireMs = 0;
      }
      try {
        return await _ms45RawTelegram(data);
      } finally {
        if (timing) timing.wireMs = Date.now() - gotBusAt;
      }
    });
  };
}

/**
 * One raw telegram to the DME and its answer's data, on a bus this caller
 * already holds.
 * @param {number[]|Uint8Array} data - The service and its bytes.
 * @returns {Promise<number[]|Uint8Array|null>} null when the DME said nothing.
 */
async function _ms45RawTelegram(data) {
  await switchSession(MS45_SGBD);
  let comm = sessionFor(MS45_SGBD).comm;
  if (!comm) {
    // The wire parameters (framing, baud) live in the SGBD's
    // INITIALISIERUNG, which only runs when a job does. Our raw
    // telegrams bypass the job runner, so run one cheap real job to
    // seed the session the first time, then read its comm back.
    await webRunJob(MS45_SGBD, 'aif_lesen', '', {
      exchange: (out, c) => webBusRawExchange(out, c),
    });
    comm = sessionFor(MS45_SGBD).comm;
  }
  if (!comm) throw new Error('the MS45 session has no wire parameters yet');
  const out = [0xb8, 0x12, 0xf1, data.length, ...data];
  // The save op (2C 6C 05) must NOT be retransmitted: its silence is the
  // success signal (the DME folds and resets), and a resend is a second
  // save at an already-rebooted DME with nothing open -- which resets it
  // again and reverts the value (seen on a bench, 2026-10-11). Send it
  // with retransmission disabled; every other op keeps the normal cover.
  const isSave = data[0] === 0x2c && data[1] === 0x6c && data[2] === 0x05;
  const txComm = isSave ? { ...comm, noRetransmit: true } : comm;
  let frame;
  try {
    frame = await webBusRawExchange(out, txComm);
  } catch (e) {
    if (e && e.ifh === 'IFH-0009') return null; // silence: the DME said nothing
    throw e;
  }
  if (!frame || frame.length < 5) return null;
  // B8 F1 12 <len> <data...> <xor>: len at [3], data from [4], drop the xor
  const len = frame[3];
  return frame.slice(4, 4 + len);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MS45_SGBD,
    ms45LiveTuneSender,
    MS45_FULL_FLASH_LENGTH,
    MS45_MPC_LENGTH,
    MS45_CAL_START,
    MS45_CAL_LENGTH,
    MS45_PROGRAM_START,
    ms45Crc32,
    ms45Checksums,
    ewsDelete,
    ms45ExchangeFile,
    ms45Job,
    ms45SetJobTrace,
    ms45Identify,
    ms45ReadMemory,
    ms45ReadCarBytes,
    ms45SecurityAccess,
    ms45LeaveProgrammingMode,
    ms45FinishFlash,
    ms45Erase,
    ms45FlashBlock,
    ms45FlashRuns,
    ms45WriteAif,
    ms45AifFields,
    ms45ReadAscii,
    ms45VerifyParameterMatch,
    ms45VerifyProgramMatch,
    ms45VerifyFlashMpcMatch,
  };
}
