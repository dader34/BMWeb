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
// MD5 and the modular exponentiation come from core/flasher.js (_md5,
// _modPow, _bytesLEToBigInt, _bigIntToBytesLE), which loads first.
/* exported MS45_SGBD, MS45_FULL_FLASH_LENGTH, MS45_MPC_LENGTH, MS45_CAL_START, MS45_CAL_LENGTH, MS45_PROGRAM_START, ms45Crc32, ms45Checksums, ewsDelete, ms45ExchangeFile, ms45Job, ms45SetJobTrace, ms45Identify, ms45ReadMemory, ms45ReadCarBytes, ms45SecurityAccess, ms45LeaveProgrammingMode, ms45FinishFlash, ms45Erase, ms45FlashBlock, ms45WriteAif, ms45AifFields, ms45ReadAscii, ms45VerifyParameterMatch, ms45VerifyProgramMatch, ms45VerifyFlashMpcMatch */

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
async function ms45Job(job, arg) {
  const text =
    arg instanceof Uint8Array
      ? _ms45BinArg(arg)
      : arg == null
        ? ''
        : String(arg);
  let res = null;
  try {
    res = await webRunJob(MS45_SGBD, job, text);
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
async function ms45Identify() {
  // the first job after a flash's reset can land while the DME is still
  // restarting (seen: the AIF unanswered two seconds after the reset, read
  // fine on the next identify), so an unanswered first read is asked again
  let aifRes = await ms45Job('aif_lesen', '');
  if (!aifRes.ok) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    aifRes = await ms45Job('aif_lesen', '');
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
  if (!serialRes.ok) return false;
  const serialReply = _ms45Bytes(serialRes.res, '_TEL_ANTWORT');
  if (serialReply.length < 5) return false;
  const serial = serialReply.subarray(
    serialReply.length - 5,
    serialReply.length - 1
  );
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
  if (!seedRes.ok) return false;
  const seed = _ms45Bytes(seedRes.res, 'ZUFALLSZAHL');
  if (!seed.length) return false;
  if (
    !(
      await ms45Job(
        'authentisierung_start',
        ms45Checksums.securityAccessMessage(userId, serial, seed)
      )
    ).ok
  )
    return false;
  if (diagProtocol !== 'BMW-FAST') {
    for (const [job, arg] of [
      ['diagnose_mode', 'ECUPM;PC115200'],
      ['SET_PARAMETER', ';115200'],
      ['ACCESS_TIMING_PARAMETER', '00;120;24;240;00'],
      ['SET_PARAMETER', ';115200;;15'],
    ]) {
      if (!(await ms45Job(job, arg)).ok) return false;
    }
  } else if (!(await ms45Job('diagnose_mode', 'ECUPM')).ok) {
    return false;
  }
  return true;
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
 * The post-flash sequence: drop back to normal comms, verify the signature,
 * reset the ECU. When several partitions are written in one session, each is
 * checked but only the last resets.
 * @param {'Programm'|'Daten'} area - Which signature.
 * @param {boolean} resetEcu - Whether to reset at the end.
 * @param {string} diagProtocol - DIAG_PROT_IST.
 * @param {(text: string) => void} [onStage] - Progress callback.
 * @returns {Promise<boolean>}
 */
async function ms45FinishFlash(area, resetEcu, diagProtocol, onStage) {
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
  stage('Checking signature');
  if (!(await ms45Job('FLASH_SIGNATUR_PRUEFEN', `${area};64`)).ok) {
    stage('Signature check failed');
    await ms45Reset();
    return false;
  }
  if (!(await ms45Job('FLASH_PROGRAMMIER_STATUS_LESEN', '')).ok) return false;
  if (!resetEcu) return true;
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
 * that, and refuses a download to a sector that has not been erased.
 * @param {number} blockStart - The address as the DME sees it (0x2040000 ...).
 * @param {number} blockLength - The length.
 * @returns {Promise<boolean>}
 */
async function ms45Erase(blockStart, blockLength) {
  const cmd = new Uint8Array(22);
  cmd[0] = 1;
  cmd[4] = 0xfe;
  cmd.set(_ms45Le32(blockLength), 13);
  cmd.set(_ms45Le32(blockStart), 17);
  return (await ms45Job('flash_loeschen', cmd)).ok;
}

/**
 * flash_schreiben_adresse, then flash_schreiben in 0xFD-byte segments, then
 * flash_schreiben_ende. A failed segment resets the DME.
 * @param {Uint8Array} toFlash - The bytes for [blockStart, blockEnd].
 * @param {number} blockStart - The DME address of the first byte.
 * @param {number} blockEnd - The DME address of the last byte.
 * @param {{onProgress?: (pct: number) => void, onStage?: (text: string) => void, abort?: AbortSignal}} [opts]
 * @returns {Promise<boolean>}
 */
async function ms45FlashBlock(toFlash, blockStart, blockEnd, opts = {}) {
  const stage = opts.onStage || (() => {});
  const blockStartOrig = blockStart;
  let blockLength = blockEnd - blockStart + 1;
  const addressSet = new Uint8Array(22);
  addressSet[0] = 1;
  addressSet[21] = 3;
  addressSet.set(_ms45Le32(blockLength), 13);
  addressSet.set(_ms45Le32(blockStart), 17);
  if (!(await ms45Job('flash_schreiben_adresse', addressSet)).ok) {
    stage('Failed to set flash address');
    return false;
  }
  let seg = 0xfd;
  while (blockLength > 0) {
    if (opts.abort && opts.abort.aborted) throw new Error('cancelled');
    if (blockLength < seg) seg = blockLength;
    const header = new Uint8Array(21);
    header[0] = 1;
    header[13] = seg;
    header.set(_ms45Le32(blockStart), 17);
    const from = blockStart - blockStartOrig;
    const telegram = _ms45Concat([
      header,
      toFlash.subarray(from, from + seg),
      Uint8Array.from([3]),
    ]);
    if (!(await ms45Job('flash_schreiben', telegram)).ok) {
      stage(
        `Flash failed at 0x${blockStart.toString(16).toUpperCase()}. Resetting DME.`
      );
      if (!(await ms45Reset())) stage('Error Resetting ECU');
      return false;
    }
    blockStart += seg;
    blockLength -= seg;
    opts.onProgress &&
      opts.onProgress(
        Math.floor(
          ((blockStart - blockStartOrig) * 100) / (blockEnd - blockStartOrig)
        )
      );
  }
  if (!(await ms45Job('flash_schreiben_ende', addressSet)).ok) {
    stage('Failed to end flash job');
    return false;
  }
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
    ms45WriteAif,
    ms45AifFields,
    ms45ReadAscii,
    ms45VerifyParameterMatch,
    ms45VerifyProgramMatch,
    ms45VerifyFlashMpcMatch,
  });
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
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
    ms45WriteAif,
    ms45AifFields,
    ms45ReadAscii,
    ms45VerifyParameterMatch,
    ms45VerifyProgramMatch,
    ms45VerifyFlashMpcMatch,
  };
}
