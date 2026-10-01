// The GS20 (A5S390R) transmission beyond its calibration: the program region
// write, the patched firmware's full read, BMW's .0DA / .0PA exchange files,
// the no-upshift calibration patch and the programming-log (AIF) entry.
//
// Everything here rides on core/gs20.js (the calibration engine, checksum and
// Ds2Wire session) and core/webshim/ds2-wire.js. Ported from the macOS
// flasher (BMWeb-Flasher: Gs20ProgramWriter, Gs20FullReader, Gs20DatenFile,
// Gs20NoUpshift, Gs20Aif, Gs20ProgramChecksum), whose sequences were proven
// on a bench module and on the car.
//
// Public surface:
//   gs20ProgramChecksum      compute / stored / verify / corrected
//   gs20ProgramRelease, gs20ProgramHasReadPatch, gs20IdentTail
//   gs20DatenFile            BMW .0DA / .0PA -> raw image
//   gs20NoUpshift            isApplicable / isApplied / apply
//   gs20Aif                  the 46-byte programming-log record
//   gs20WriteProgram(program, opts)    erase 4 sectors + write + commit
//   gs20ReadFull(opts)                 512 KB over the subcode-8 read
//   gs20ProbeReadPatch()               null when the module answers subcode 8
//   gs20ReadInfo()                     the 0D info block
/* exported GS20_PROGRAM_ADDRESS, GS20_PROGRAM_LENGTH, GS20_FULL_ADDRESS, GS20_FULL_LENGTH, GS20_PROGRAM_SECTORS, gs20ProgramChecksum, gs20ProgramRelease, gs20ProgramHasReadPatch, gs20IdentTail, gs20DatenFile, gs20NoUpshift, gs20Aif, Gs20ProgramWriter, Gs20FullReader, gs20WriteProgram, gs20ReadFull, gs20ProbeReadPatch, gs20ReadInfo */

/** Where the program region starts, and how long it is. */
const GS20_PROGRAM_ADDRESS = 0x0a0000;
const GS20_PROGRAM_LENGTH = 0x40000;
/** The whole 512 KB image, boot block through the erased tail. */
const GS20_FULL_ADDRESS = 0x080000;
const GS20_FULL_LENGTH = 0x80000;
/** The boot block, the region a bad program flash destroys. */
const GS20_BOOT_ADDRESS = 0x080000;
/**
 * The flash sectors the program occupies (AM29F400BB, bottom boot). Each
 * needs its own erase; the part has no multi-sector erase command.
 */
const GS20_PROGRAM_SECTORS = [
  [0x0a0000, 0x10000],
  [0x0b0000, 0x10000],
  [0x0c0000, 0x10000],
  [0x0d0000, 0x10000],
];

// ---- program checksum ----------------------------------------------------------
// CRC-16/ARC (reflected, polynomial 0xA001, initial 0) over two ranges of the
// program region (the first two entries of the module's own descriptor table
// at program 0x3FE00, so the gap at 0x200-0x27F is skipped), stored
// little-endian at program 0x3FECC. Verified against four images.
const GS20_PROGRAM_CRC_AT = 0x3fecc;
const GS20_PROGRAM_CRC_RANGES = [
  [0x00000, 0x001ff],
  [0x00280, 0x3fdff],
];

/**
 * CRC-16/ARC over a span, continuing from a running value.
 * @param {Uint8Array} data - The bytes.
 * @param {number} start - First index.
 * @param {number} end - Last index, inclusive.
 * @param {number} crc - The running value.
 * @returns {number}
 */
function _gs20Crc16(data, start, end, crc) {
  for (let i = start; i <= end; i++) {
    crc ^= data[i];
    for (let b = 0; b < 8; b++)
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc & 0xffff;
}

function _gs20RequireProgram(program) {
  if (!program || program.length !== GS20_PROGRAM_LENGTH) {
    throw new Error(
      `a GS20 program region is 0x${GS20_PROGRAM_LENGTH.toString(16).toUpperCase()} bytes; ` +
        `this one is 0x${(program ? program.length : 0).toString(16).toUpperCase()}`
    );
  }
}

/** The GS20 program-region checksum. */
const gs20ProgramChecksum = {
  /**
   * @param {Uint8Array} program - The 256 KB program region.
   * @returns {number}
   */
  compute(program) {
    _gs20RequireProgram(program);
    let crc = 0;
    for (const [s, e] of GS20_PROGRAM_CRC_RANGES)
      crc = _gs20Crc16(program, s, e, crc);
    return crc;
  },
  /**
   * @param {Uint8Array} program - The 256 KB program region.
   * @returns {number}
   */
  stored(program) {
    _gs20RequireProgram(program);
    return (
      program[GS20_PROGRAM_CRC_AT] | (program[GS20_PROGRAM_CRC_AT + 1] << 8)
    );
  },
  /**
   * @param {Uint8Array} program - The 256 KB program region.
   * @returns {boolean}
   */
  verify(program) {
    return (
      gs20ProgramChecksum.stored(program) ===
      gs20ProgramChecksum.compute(program)
    );
  },
  /**
   * A copy with the checksum written in; the caller's array is untouched.
   * @param {Uint8Array} program - The 256 KB program region.
   * @returns {{image: Uint8Array, checksum: number}}
   */
  corrected(program) {
    _gs20RequireProgram(program);
    const image = Uint8Array.from(program);
    const checksum = gs20ProgramChecksum.compute(image);
    image[GS20_PROGRAM_CRC_AT] = checksum & 0xff;
    image[GS20_PROGRAM_CRC_AT + 1] = (checksum >> 8) & 0xff;
    return { image, checksum };
  },
};

/**
 * The two-digit software release a program image declares, from the
 * "G2210_0090C0" string in its tail. Null when there is none.
 * @param {Uint8Array} program - A program region.
 * @returns {string|null}
 */
function gs20ProgramRelease(program) {
  const m = /G2210_00(\d\d)C0/.exec(_gs20TailText(program));
  return m ? m[1] : null;
}

/**
 * "90C0" from a G2210_0090C0 ident in an image's last 256 bytes.
 * @param {Uint8Array} image - A program or calibration image.
 * @returns {string|null}
 */
function gs20IdentTail(image) {
  const m = /G2210_00(\d\d[A-Z0-9]\d)/.exec(_gs20TailText(image));
  return m ? m[1] : null;
}

function _gs20TailText(image) {
  if (!image || image.length < 0x100) return '';
  let s = '';
  for (let i = image.length - 0x100; i < image.length; i++) {
    const b = image[i];
    s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
  }
  return s;
}

/**
 * Whether a program image carries the subcode-8 read routine: its first
 * instruction, cmpb RL3,#8, at program 0x0D34C.
 * @param {Uint8Array} program - A 256 KB program region.
 * @returns {boolean}
 */
function gs20ProgramHasReadPatch(program) {
  const at = 0x0ad34c - GS20_PROGRAM_ADDRESS;
  return (
    !!program &&
    program.length > at + 2 &&
    program[at] === 0x47 &&
    program[at + 1] === 0xf6 &&
    program[at + 2] === 0x08
  );
}

// ---- BMW .0DA / .0PA exchange files -----------------------------------------------
// Intel HEX under a commented header, with two wrinkles: the calibration is
// addressed at its real location (0x090000) through a type-4 linear base plus
// a type-2 segment base, and the final 32-byte block of each 64 KB page uses
// record type 0x10, which is not in the standard. Skipping it silently loses
// the version-string tail and the trailer the module validates against.
const gs20DatenFile = {
  /** The last four bytes of every GS20 calibration. */
  TRAILER: [0xc7, 0xa3, 0x8c, 0x44],
  /**
   * @param {string} name - A file name.
   * @returns {boolean}
   */
  isDatenFile(name) {
    return /\.0da$/i.test(name || '');
  },
  /**
   * @param {string} name - A file name.
   * @returns {boolean}
   */
  isProgramFile(name) {
    return /\.0pa$/i.test(name || '');
  },
  /**
   * The ZL_Referenz the header declares, e.g. "G2210_0090C0ES10".
   * @param {string} text - The file's text.
   * @returns {string|null}
   */
  readReference(text) {
    for (const line of String(text || '').split(/\r?\n/)) {
      if (line.startsWith(':')) break;
      const m = /ZL_Referenz:\s*(\S+)/.exec(line);
      if (m) return m[1];
    }
    return null;
  },
  /**
   * The vehicle the file is for, from the K_F1 header line.
   * @param {string} text - The file's text.
   * @returns {string|null}
   */
  readVehicle(text) {
    for (const line of String(text || '').split(/\r?\n/)) {
      if (line.startsWith(':')) break;
      const m = /;;K_F1:\s*(.+?)\s*$/.exec(line);
      if (m)
        return m[1]
          .replace('Daten fuer ', '')
          .replace('Daten  fuer ', '')
          .trim();
    }
    return null;
  },
  /**
   * Decode a .0DA to the 64 KB calibration image.
   * @param {string} text - The file's text.
   * @returns {Uint8Array}
   */
  decode(text) {
    return gs20DatenFile._decode(text, GS20_CAL_ADDRESS, GS20_CAL_LENGTH);
  },
  /**
   * Decode a .0PA to the 256 KB program region.
   * @param {string} text - The file's text.
   * @returns {Uint8Array}
   */
  decodeProgram(text) {
    return gs20DatenFile._decode(
      text,
      GS20_PROGRAM_ADDRESS,
      GS20_PROGRAM_LENGTH
    );
  },
  /**
   * Whether an image ends with the trailer every GS20 calibration carries. A
   * calibration without it is written and then refused at the commit.
   * @param {Uint8Array} cal - A calibration image.
   * @returns {boolean}
   */
  hasTrailer(cal) {
    const t = gs20DatenFile.TRAILER;
    if (!cal || cal.length < t.length) return false;
    for (let i = 0; i < t.length; i++)
      if (cal[cal.length - t.length + i] !== t[i]) return false;
    return true;
  },
  _decode(text, region, size) {
    const image = new Uint8Array(size);
    const covered = new Uint8Array(size);
    let linearBase = 0;
    let segmentBase = 0;
    let lineNumber = 0;
    for (const raw of String(text || '').split(/\r?\n/)) {
      lineNumber++;
      const line = raw.trim();
      if (!line.startsWith(':')) continue;
      const record = gs20DatenFile._parseRecord(line, lineNumber);
      const length = record[0];
      const address = (record[1] << 8) | record[2];
      const type = record[3];
      switch (type) {
        case 0x04:
          linearBase = ((record[4] << 8) | record[5]) << 16;
          segmentBase = 0;
          break;
        case 0x02:
          segmentBase = ((record[4] << 8) | record[5]) << 4;
          break;
        case 0x00:
        case 0x10: {
          const start = linearBase + segmentBase + address;
          for (let i = 0; i < length; i++) {
            const offset = start + i - region;
            if (offset < 0 || offset >= image.length) continue;
            image[offset] = record[4 + i];
            covered[offset] = 1;
          }
          break;
        }
        case 0x01:
          break;
        default:
          throw new Error(
            `line ${lineNumber} uses record type 0x${type.toString(16).toUpperCase().padStart(2, '0')}, ` +
              'which this reader does not understand; decoding it as if it were absent would ' +
              'produce an image the transmission refuses'
          );
      }
    }
    let missing = 0;
    let first = -1;
    for (let i = 0; i < covered.length; i++) {
      if (covered[i]) continue;
      if (first < 0) first = i;
      missing++;
    }
    if (missing > 0) {
      throw new Error(
        `the file does not cover the whole region: ${missing} of ${image.length} bytes are ` +
          `missing, starting at 0x${first.toString(16).toUpperCase().padStart(4, '0')}`
      );
    }
    return image;
  },
  _parseRecord(line, lineNumber) {
    const hex = line.slice(1);
    if (hex.length < 10 || hex.length % 2 !== 0) {
      throw new Error(`line ${lineNumber} is not a well-formed record`);
    }
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      const v = parseInt(hex.substr(i * 2, 2), 16);
      if (
        !Number.isFinite(v) ||
        !/^[0-9a-fA-F]{2}$/.test(hex.substr(i * 2, 2))
      ) {
        throw new Error(`line ${lineNumber} contains a non-hexadecimal byte`);
      }
      bytes[i] = v;
    }
    if (bytes[0] + 5 !== bytes.length) {
      throw new Error(
        `line ${lineNumber} declares ${bytes[0]} data bytes but carries ${Math.max(bytes.length - 5, 0)}`
      );
    }
    let sum = 0;
    for (let i = 0; i < bytes.length - 1; i++) sum += bytes[i];
    const expected = -sum & 0xff;
    if (bytes[bytes.length - 1] !== expected) {
      throw new Error(`line ${lineNumber} has a bad record checksum`);
    }
    return bytes;
  },
};

// ---- no auto upshift -----------------------------------------------------------------
// The upshift points live in sixteen tables of seventeen entries, four groups
// of four at 0x0D44, 0x0E64, 0x11C4 and 0x12E4, each table preceded by a
// two-byte count of 17. Raising every entry to 0x1FE0 puts the shift point
// beyond any speed the car reaches. Two flag bytes at 0x3098 / 0x309A read 1
// stock and 0 on every no-upshift calibration.
const GS20_UPSHIFT_GROUPS = [0x0d44, 0x0e64, 0x11c4, 0x12e4];
const GS20_UPSHIFT_TABLES_PER_GROUP = 4;
const GS20_UPSHIFT_ENTRIES = 17;
const GS20_UPSHIFT_TABLE_BYTES = 2 + GS20_UPSHIFT_ENTRIES * 2;
const GS20_UPSHIFT_UNREACHABLE = 0x1fe0;
const GS20_UPSHIFT_FLAGS = [0x3098, 0x309a];

const gs20NoUpshift = {
  /**
   * @param {Uint8Array} cal - A calibration image.
   * @returns {boolean}
   */
  isApplicable(cal) {
    if (!cal || cal.length !== GS20_CAL_LENGTH) return false;
    for (const group of GS20_UPSHIFT_GROUPS) {
      for (let t = 0; t < GS20_UPSHIFT_TABLES_PER_GROUP; t++) {
        const at = group + t * GS20_UPSHIFT_TABLE_BYTES;
        if (at + GS20_UPSHIFT_TABLE_BYTES > cal.length) return false;
        if (cal[at] !== GS20_UPSHIFT_ENTRIES || cal[at + 1] !== 0) return false;
      }
    }
    return GS20_UPSHIFT_FLAGS.every((o) => o < cal.length);
  },
  /**
   * @param {Uint8Array} cal - A calibration image.
   * @returns {boolean}
   */
  isApplied(cal) {
    if (!gs20NoUpshift.isApplicable(cal)) return false;
    for (const group of GS20_UPSHIFT_GROUPS) {
      for (let t = 0; t < GS20_UPSHIFT_TABLES_PER_GROUP; t++) {
        const at = group + t * GS20_UPSHIFT_TABLE_BYTES + 2;
        for (let e = 0; e < GS20_UPSHIFT_ENTRIES; e++) {
          const i = at + e * 2;
          if ((cal[i] | (cal[i + 1] << 8)) !== GS20_UPSHIFT_UNREACHABLE)
            return false;
        }
      }
    }
    return GS20_UPSHIFT_FLAGS.every((o) => cal[o] === 0);
  },
  /**
   * A copy with automatic upshifts removed; the checksum is left to the writer.
   * @param {Uint8Array} cal - A calibration image.
   * @returns {Uint8Array}
   */
  apply(cal) {
    if (!gs20NoUpshift.isApplicable(cal)) {
      throw new Error(
        'this calibration does not have the upshift tables the patch expects'
      );
    }
    const out = Uint8Array.from(cal);
    for (const group of GS20_UPSHIFT_GROUPS) {
      for (let t = 0; t < GS20_UPSHIFT_TABLES_PER_GROUP; t++) {
        const at = group + t * GS20_UPSHIFT_TABLE_BYTES + 2;
        for (let e = 0; e < GS20_UPSHIFT_ENTRIES; e++) {
          const i = at + e * 2;
          out[i] = GS20_UPSHIFT_UNREACHABLE & 0xff;
          out[i + 1] = GS20_UPSHIFT_UNREACHABLE >> 8;
        }
      }
    }
    for (const o of GS20_UPSHIFT_FLAGS) out[o] = 0;
    return out;
  },
};

// ---- the programming-log (AIF) record -------------------------------------------------
// 46 bytes, as BMW's GD20 programming SGBD packs it (decoded by running its
// AIF_SCHREIBEN against a fake interface; pinned against the factory entry a
// real module holds):
//   0x00  VIN, 17 chars at 6 bits each (0-9 = 0..9, A-Z = 10..35), MSB first
//         after two padding bits: 13 bytes, then 00
//   0x0E  date, (day << 11) | (month << 7) | (year % 100), two bytes BE, then 00
//   0x11  software number, three bytes BE
//   0x14  change index, two chars packed (c1 << 6) | c2 (letters 10..35, digits
//         kept as their ASCII code), two bytes BE, then 00
//   0x17  approval number, three bytes BE, then 00
//   0x1B  assembly (ZB) number, three bytes BE, then 00
//   0x1F  tester serial, five ASCII chars, then 00
//   0x25  dealer number, two bytes BE, then 00
//   0x28  odometer in 600 km steps, one byte, then 00
//   0x2A  program reference, three bytes, then 00
const gs20Aif = {
  RECORD_LENGTH: 0x2e,
  SLOTS: 14,
  /**
   * @param {string} vin - 17 letters or digits.
   * @param {Date} date - The programming date.
   * @param {number} softwareNr - The data number.
   * @param {string} changeIndex - Two characters.
   * @param {number} approvalNr - The approval (Behoerden) number.
   * @param {number} assemblyNr - The assembly (ZB / ZUSB) number.
   * @param {string} testerSerial - Five characters.
   * @param {number} dealerNr - The dealer number.
   * @param {number} km - The odometer.
   * @param {number[]} programRef - Three bytes.
   * @returns {Uint8Array}
   */
  build(
    vin,
    date,
    softwareNr,
    changeIndex,
    approvalNr,
    assemblyNr,
    testerSerial,
    dealerNr,
    km,
    programRef
  ) {
    if (!vin || vin.length !== 17 || !/^[0-9A-Za-z]{17}$/.test(vin)) {
      throw new Error('the VIN must be 17 letters or digits');
    }
    if (!changeIndex || changeIndex.length !== 2)
      throw new Error('the change index is two characters');
    if (!testerSerial || testerSerial.length !== 5)
      throw new Error('the tester serial is five characters');
    if (!programRef || programRef.length !== 3)
      throw new Error('the program reference is three bytes');
    const r = new Uint8Array(gs20Aif.RECORD_LENGTH);
    // VIN: a 104-bit stream, two zero bits then 17 six-bit values
    let acc = 0n;
    let bits = 2;
    let o = 0;
    for (const c of vin.toUpperCase()) {
      acc = (acc << 6n) | BigInt(gs20Aif._alnum(c));
      bits += 6;
      while (bits >= 8) {
        bits -= 8;
        r[o++] = Number((acc >> BigInt(bits)) & 0xffn);
      }
    }
    const packedDate =
      (date.getDate() << 11) |
      ((date.getMonth() + 1) << 7) |
      (date.getFullYear() % 100);
    r[0x0e] = (packedDate >> 8) & 0xff;
    r[0x0f] = packedDate & 0xff;
    gs20Aif._put24(r, 0x11, softwareNr);
    const idx =
      (gs20Aif._indexChar(changeIndex[0]) << 6) |
      gs20Aif._indexChar(changeIndex[1]);
    r[0x14] = (idx >> 8) & 0xff;
    r[0x15] = idx & 0xff;
    gs20Aif._put24(r, 0x17, approvalNr);
    gs20Aif._put24(r, 0x1b, assemblyNr);
    for (let i = 0; i < 5; i++) r[0x1f + i] = testerSerial.charCodeAt(i) & 0xff;
    r[0x25] = (dealerNr >> 8) & 0xff;
    r[0x26] = dealerNr & 0xff;
    r[0x28] = Math.min(255, Math.max(0, Math.floor(km / 600)));
    r[0x2a] = programRef[0] & 0xff;
    r[0x2b] = programRef[1] & 0xff;
    r[0x2c] = programRef[2] & 0xff;
    return r;
  },
  /**
   * A slot is free while its first byte is still erased.
   * @param {Uint8Array|number[]} slot - The slot's first byte(s).
   * @returns {boolean}
   */
  isFree(slot) {
    return !!slot && slot.length > 0 && slot[0] === 0xff;
  },
  /**
   * The BMW part numbers behind a calibration's reference suffix (the "ER10"
   * of G2210_0090C0ER10): the data number of the .0DA and the assembly it is
   * delivered under, which is what BMW's tools put in the entry.
   * @param {string|null} calibrationReference - The reference.
   * @returns {{dataNr: number, assemblyNr: number}|null}
   */
  partNumbers(calibrationReference) {
    if (!calibrationReference || calibrationReference.length < 4) return null;
    switch (calibrationReference.slice(-4).toUpperCase()) {
      case 'ER10':
        return { dataNr: 7558009, assemblyNr: 7558008 }; // E46 325i USA auto
      case 'ES10':
        return { dataNr: 7557995, assemblyNr: 7557994 }; // E46 330i ZHP USA
      case 'DP10':
        return { dataNr: 7557985, assemblyNr: 7557984 }; // E46/16 330i USA
      default:
        return null;
    }
  },
  /**
   * A decimal field as a number, 0 when it is not one.
   * @param {string|number} s - The field.
   * @returns {number}
   */
  number(s) {
    const v = parseInt(String(s == null ? '' : s).trim(), 10);
    return Number.isFinite(v) && v >= 0 ? v : 0;
  },
  _alnum(c) {
    if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
    if (c >= 'A' && c <= 'Z') return c.charCodeAt(0) - 65 + 10;
    throw new Error(`not a VIN character: ${c}`);
  },
  _indexChar(c) {
    c = c.toUpperCase();
    if (c >= 'A' && c <= 'Z') return c.charCodeAt(0) - 65 + 10;
    return c.charCodeAt(0);
  },
  _put24(r, at, value) {
    r[at] = (value >> 16) & 0xff;
    r[at + 1] = (value >> 8) & 0xff;
    r[at + 2] = value & 0xff;
  },
};

// ---- the calibration writer's session helpers ----------------------------------------
// Added to the wire-jobs class rather than written into it: the info block,
// a plain read, and the AIF slot write, all of which the program writer and
// the log entry share with the calibration path.

/**
 * The module's info block (0D), as the programming SGBD reads it.
 * @returns {Promise<number[]>}
 */
Gs20CalWriter.prototype.readInfo = function readInfo() {
  return this._exchange([0x0d], GS20_NORMAL_TIMEOUT_MS, 'info');
};

/**
 * Where the module keeps its programming log, from byte 0x3F of the info block.
 * @returns {Promise<number>}
 */
Gs20CalWriter.prototype.readAifAddress = async function readAifAddress() {
  const info = await this.readInfo();
  if (info.length < 0x42) {
    throw new Error(
      `the info block is only ${info.length} bytes; no AIF address in it`
    );
  }
  return (info[0x3f] << 16) | (info[0x40] << 8) | info[0x41];
};

/**
 * A plain read, as the diagnostic SGBD does it (06, 32-bit address, length).
 * @param {number} address - Where to read.
 * @param {number} length - How many bytes.
 * @returns {Promise<Uint8Array>}
 */
Gs20CalWriter.prototype.readBytes = async function readBytes(address, length) {
  const reply = await this._exchange(
    [
      0x06,
      (address >>> 24) & 0xff,
      (address >> 16) & 0xff,
      (address >> 8) & 0xff,
      address & 0xff,
      length & 0xff,
    ],
    GS20_NORMAL_TIMEOUT_MS,
    'read'
  );
  const available = Math.max(0, reply.length - 4);
  return Uint8Array.from(reply.slice(3, 3 + Math.min(length, available)));
};

/**
 * Append one entry to the programming log, the way AIF_SCHREIBEN in BMW's
 * programming SGBD does: the first erased slot after the base the info block
 * names, a flash-status check on it (sub-status 1), then one 07 02 write of
 * the record. Needs the unlocked session a write runs in.
 * @param {Uint8Array} record - The 46-byte record.
 * @returns {Promise<{address: number, slot: number, left: number}>}
 */
Gs20CalWriter.prototype.writeAifRecord = async function writeAifRecord(record) {
  if (!record || record.length !== gs20Aif.RECORD_LENGTH) {
    throw new Error(`an AIF record is ${gs20Aif.RECORD_LENGTH} bytes`);
  }
  const base = await this.readAifAddress();
  this._note(`AIF area ${_gs20Hex(base)}`);
  let slot = -1;
  for (let i = 0; i < gs20Aif.SLOTS; i++) {
    const address = base + i * gs20Aif.RECORD_LENGTH;
    if (gs20Aif.isFree(await this.readBytes(address, 1))) {
      slot = i;
      break;
    }
  }
  if (slot < 0)
    throw new Error(
      `the programming log is full: all ${gs20Aif.SLOTS} entries are used`
    );
  const slotAddress = base + slot * gs20Aif.RECORD_LENGTH;
  const status = await this._exchange(
    _gs20AddressCommand(0x0f, slotAddress),
    GS20_NORMAL_TIMEOUT_MS,
    'AIF status'
  );
  let sub = ds2SubStatus(status);
  if (sub !== 1) {
    throw new Error(
      `the transmission does not accept a write at ${_gs20Hex(slotAddress)}: ${ds2DescribeSubStatus(sub)} ` +
        `(${busTrace.hex(status.slice(0, 12))})`
    );
  }
  const payload = [
    0x07,
    0x02,
    (slotAddress >> 16) & 0xff,
    (slotAddress >> 8) & 0xff,
    slotAddress & 0xff,
    record.length,
    ...record,
  ];
  const reply = await this._exchange(
    payload,
    GS20_NORMAL_TIMEOUT_MS,
    'AIF write'
  );
  sub = ds2SubStatus(reply);
  if (sub !== 1) {
    throw new Error(
      `the transmission did not program the AIF entry: ${ds2DescribeSubStatus(sub)} ` +
        `(${busTrace.hex(reply.slice(0, 12))})`
    );
  }
  return { address: slotAddress, slot, left: gs20Aif.SLOTS - slot - 1 };
};

// ---- the program writer ---------------------------------------------------------------

/**
 * Writes the GS20 program region (0x0A0000-0x0DFFFF) over raw DS2.
 *
 * This is the brick-capable path. What makes it survivable is the flash
 * layout: the boot block sits in four small sectors below the calibration
 * and is never addressed here, so a failed program write leaves a module
 * that still runs its boot code. The checksum is corrected before anything
 * is erased, so the image that reaches the module is self-consistent.
 */
class Gs20ProgramWriter {
  /**
   * @param {Ds2Wire} wire - The link.
   * @param {{note?: (text: string) => void}} [opts]
   */
  constructor(wire, opts = {}) {
    this._wire = wire;
    this._note = opts.note || (() => {});
    /** Which sectors have been erased. @type {number[]} */
    this.erasedSectors = [];
  }

  /** Whether anything has been erased yet. */
  get eraseStarted() {
    return this.erasedSectors.length > 0;
  }

  /**
   * One exchange, with a re-sync before each retry: a plain ident proves the
   * module still answers and clears whatever half-read state the lost reply
   * left on either side. Failed attempts are noted, since the link only
   * traces completed ones.
   * @param {number[]} payload - The command bytes.
   * @param {number} timeoutMs - How long the module may take to answer.
   * @param {string} what - The step, for the error.
   * @param {{abort?: AbortSignal, allowBusy?: boolean}} [opts]
   * @returns {Promise<number[]>}
   */
  async _exchange(payload, timeoutMs, what, opts = {}) {
    let last = null;
    for (let attempt = 0; attempt < GS20_RETRIES; attempt++) {
      _gs20Check(opts.abort);
      try {
        const reply = await this._wire.transfer(
          DS2_ADDRESS.tcu,
          payload,
          timeoutMs
        );
        const status = ds2Status(reply);
        if (status === DS2_STATUS.ok) return reply;
        if (opts.allowBusy && status === DS2_STATUS.busy) return reply;
        // anything else is a refusal: accepting it would let a rejected erase
        // look like a successful one
        throw new Error(
          `the transmission refused the ${what} request (status ` +
            `${status == null ? 'missing' : '0x' + status.toString(16).toUpperCase()}): ` +
            busTrace.hex(reply.slice(0, 12))
        );
      } catch (e) {
        if (e && e.message === 'cancelled') throw e;
        last = e;
        this._note(
          `no reply to ${what} (attempt ${attempt + 1} of ${GS20_RETRIES}): ` +
            `${busTrace.hex(payload.slice(0, 12))} - ${e && e.message}`
        );
        if (attempt + 1 < GS20_RETRIES) {
          await bmwSleep(GS20_RETRY_DELAY_MS);
          try {
            await this._wire.transfer(DS2_ADDRESS.tcu, [0x00], timeoutMs);
            this._note(`module answers ident, retrying ${what}`);
          } catch (identEx) {
            this._note(
              `module did not answer ident either: ${identEx && identEx.message}`
            );
          }
        }
      }
    }
    throw new Error(
      `the ${what} failed after ${GS20_RETRIES} attempts: ${last && last.message}`
    );
  }

  /**
   * Ask the flash for its status, which only an open module answers.
   * @param {AbortSignal} [abort] - Cancel signal.
   * @returns {Promise<void>}
   */
  async confirmFlashAccepted(abort) {
    let reply;
    try {
      reply = await this._exchange(
        _gs20AddressCommand(0x0f, GS20_PROGRAM_ADDRESS),
        GS20_NORMAL_TIMEOUT_MS,
        'flash status',
        {
          abort,
          allowBusy: true,
        }
      );
    } catch (e) {
      if (e && e.message === 'cancelled') throw e;
      throw new Error(
        'the transmission did not answer a flash status request, so it is not open for programming. ' +
          `Nothing was erased. (${e && e.message})`,
        { cause: e }
      );
    }
    const status = ds2Status(reply);
    if (status !== DS2_STATUS.ok && status !== DS2_STATUS.busy) {
      throw new Error(
        'the transmission refused a flash status request, so it is not open for programming. ' +
          `Nothing was erased. Reply: ${busTrace.hex(reply.slice(0, 12))}`
      );
    }
  }

  /**
   * The flash status sub-code for a region (1 = valid, 0x0B = blank, 0x0E =
   * program/data mismatch).
   * @param {number} address - The region.
   * @param {AbortSignal} [abort] - Cancel signal.
   * @returns {Promise<number|null>}
   */
  async readStatus(address, abort) {
    for (let poll = 0; poll < GS20_MAX_BUSY_POLLS; poll++) {
      _gs20Check(abort);
      const reply = await this._exchange(
        _gs20AddressCommand(0x0f, address),
        GS20_ERASE_TIMEOUT_MS,
        'status',
        {
          abort,
          allowBusy: true,
        }
      );
      if (ds2Status(reply) === DS2_STATUS.busy) {
        await bmwSleep(GS20_BUSY_POLL_MS);
        continue;
      }
      return ds2SubStatus(reply);
    }
    throw new Error('the transmission stayed busy on a status request');
  }

  async _erase(address, abort) {
    const reply = await this._exchange(
      _gs20AddressCommand(0x06, address),
      GS20_ERASE_TIMEOUT_MS,
      'erase',
      { abort }
    );
    // the module answers status OK to an erase it has refused as well as to
    // one it has done; only the sub-status tells them apart (1 = erased; 8
    // came back in 16 ms from a module that then rejected every write)
    const sub = ds2SubStatus(reply);
    if (sub !== 1) {
      throw new Error(
        `the transmission did not erase ${_gs20Hex(address)}: ${ds2DescribeSubStatus(sub)} ` +
          `(${busTrace.hex(reply.slice(0, 12))})`
      );
    }
  }

  async _waitReady(address, abort) {
    for (let poll = 0; poll < GS20_MAX_BUSY_POLLS; poll++) {
      _gs20Check(abort);
      const reply = await this._exchange(
        _gs20AddressCommand(0x0f, address),
        GS20_ERASE_TIMEOUT_MS,
        'status',
        {
          abort,
          allowBusy: true,
        }
      );
      if (ds2Status(reply) !== DS2_STATUS.busy) return;
      await bmwSleep(GS20_BUSY_POLL_MS);
    }
    throw new Error(
      `the transmission stayed busy after erasing ${_gs20Hex(address)}`
    );
  }

  async _commit(abort) {
    for (let poll = 0; poll < GS20_MAX_BUSY_POLLS; poll++) {
      _gs20Check(abort);
      const reply = await this._exchange(
        _gs20AddressCommand(0x0f, GS20_PROGRAM_ADDRESS),
        GS20_ERASE_TIMEOUT_MS,
        'commit',
        {
          abort,
          allowBusy: true,
        }
      );
      if (ds2Status(reply) === DS2_STATUS.busy) {
        await bmwSleep(GS20_BUSY_POLL_MS);
        continue;
      }
      const sub = ds2SubStatus(reply);
      if (sub === 1) return;
      throw new Error(
        `the transmission did not confirm the program write: ${ds2DescribeSubStatus(sub)} ` +
          `(${busTrace.hex(reply.slice(0, 12))})`
      );
    }
    throw new Error('the transmission never confirmed the program write');
  }

  static _sectorEnd(address) {
    for (const [start, len] of GS20_PROGRAM_SECTORS) {
      if (address >= start && address < start + len) return start + len - 1;
    }
    throw new Error(`${_gs20Hex(address)} is outside the program region`);
  }

  async _writeChunk(address, image, offset, length, abort) {
    const payload = [
      0x07,
      0x02,
      (address >> 16) & 0xff,
      (address >> 8) & 0xff,
      address & 0xff,
      length,
      ...image.subarray(offset, offset + length),
    ];
    const reply = await this._exchange(
      payload,
      GS20_NORMAL_TIMEOUT_MS,
      'write',
      { abort }
    );
    // an accepted chunk is answered with the next address and sub-status 1;
    // one the module did not program (unerased flash) with the same address
    // and sub-status 3, still under status OK
    const sub = ds2SubStatus(reply);
    if (sub !== 1) {
      throw new Error(
        `the transmission did not program the chunk at ${_gs20Hex(address)}: ${ds2DescribeSubStatus(sub)} ` +
          `(${busTrace.hex(reply.slice(0, 12))})`
      );
    }
  }

  /**
   * Program the image: blank pairs stepped over, blank tails trimmed, and no
   * chunk straddling a sector boundary.
   * @param {Uint8Array} image - The corrected program region.
   * @param {{onProgress?: (pct: number) => void, abort?: AbortSignal}} [opts]
   * @returns {Promise<void>}
   */
  async writeRegion(image, opts = {}) {
    let offset = 0;
    while (offset < image.length) {
      _gs20Check(opts.abort);
      while (
        offset + 1 < image.length &&
        image[offset] === 0xff &&
        image[offset + 1] === 0xff
      )
        offset += 2;
      if (offset >= image.length) break;
      let length = Math.min(Gs20CalWriter.CHUNK, image.length - offset);
      while (
        length > 2 &&
        image[offset + length - 2] === 0xff &&
        image[offset + length - 1] === 0xff
      )
        length -= 2;
      const address = GS20_PROGRAM_ADDRESS + offset;
      length = Math.min(
        length,
        Gs20ProgramWriter._sectorEnd(address) - address + 1
      );
      await this._writeChunk(address, image, offset, length, opts.abort);
      offset += length;
      opts.onProgress &&
        opts.onProgress(Math.round((offset * 100) / image.length));
    }
  }

  /**
   * Erase the four program sectors and write the image, correcting its
   * checksum first. The session must already be open and unlocked.
   * @param {Uint8Array} program - The 256 KB program region.
   * @param {{onProgress?: (pct: number) => void, onStage?: (text: string) => void, abort?: AbortSignal}} [opts]
   * @returns {Promise<{checksum: number, checksumCorrected: boolean}>}
   */
  async write(program, opts = {}) {
    _gs20RequireProgram(program);
    const stage = opts.onStage || (() => {});
    const stored = gs20ProgramChecksum.stored(program);
    const { image, checksum } = gs20ProgramChecksum.corrected(program);
    this._note(
      `program checksum 0x${checksum.toString(16).toUpperCase().padStart(4, '0')}` +
        (stored === checksum
          ? ' (already correct)'
          : ` (corrected from 0x${stored.toString(16).toUpperCase().padStart(4, '0')})`)
    );
    // prove the module really will take flash commands before erasing
    // anything: a refusal costs nothing here, where it would cost a sector
    // at the first erase
    await this.confirmFlashAccepted(opts.abort);
    // every sector first, then write: erasing as we go would leave a longer
    // window where an interruption means some sectors are blank and others
    // hold the old program
    let n = 0;
    for (const [address] of GS20_PROGRAM_SECTORS) {
      _gs20Check(opts.abort);
      stage(`erasing, ${++n}`);
      this._note(`erase ${_gs20Hex(address)}`);
      await this._erase(address, opts.abort);
      await this._waitReady(address, opts.abort);
      this.erasedSectors.push(address);
    }
    stage('writing program 0%');
    this._note(
      `write ${image.length} bytes to ${_gs20Hex(GS20_PROGRAM_ADDRESS)}`
    );
    await this.writeRegion(image, {
      abort: opts.abort,
      onProgress: (pct) => {
        stage(`writing program ${pct}%`);
        opts.onProgress && opts.onProgress(pct);
      },
    });
    await this._commit(opts.abort);
    this._note('program written and committed');
    return { checksum, checksumCorrected: stored !== checksum };
  }
}

// ---- the full read (patched firmware's subcode 8) -----------------------------------------

/**
 * Reads any region of a GS20 over raw DS2 using the patched firmware's
 * subcode-8 read: 06 08 SEG AH AL N. Stock firmware answers B0 to it, which
 * is what probe() looks for first.
 */
class Gs20FullReader {
  static get CHUNK() {
    return 123;
  }
  static get PAGE() {
    return 0x4000;
  }
  /**
   * @param {Ds2Wire} wire - The link.
   * @param {{note?: (text: string) => void}} [opts]
   */
  constructor(wire, opts = {}) {
    this._wire = wire;
    this._note = opts.note || (() => {});
  }

  /**
   * Ask for the first eight bytes of the boot block. A C167 reset vector
   * table is JMPS (0xFA) every four bytes.
   * @param {AbortSignal} [abort] - Cancel signal.
   * @returns {Promise<string|null>} null when the module answered correctly, else why not.
   */
  async probe(abort) {
    let data;
    try {
      data = await this._readChunk(GS20_BOOT_ADDRESS, 8, abort);
    } catch (e) {
      if (e && e.message === 'cancelled') throw e;
      return (e && e.message) || String(e);
    }
    if (data.length !== 8)
      return `the module returned ${data.length} bytes where 8 were asked for`;
    if (data[0] !== 0xfa || data[4] !== 0xfa) {
      return (
        `the module answered, but 0x080000 reads ${busTrace.hex(data)} where a boot block ` +
        'starts with FA at 0x00 and 0x04; the read reached the wrong address'
      );
    }
    this._note(`subcode 8 answered: 0x080000 = ${busTrace.hex(data)}`);
    return null;
  }

  /**
   * Read a region; every chunk lands at the offset it was asked for.
   * @param {number} address - Where to start.
   * @param {number} length - How many bytes.
   * @param {{onProgress?: (pct: number) => void, abort?: AbortSignal}} [opts]
   * @returns {Promise<Uint8Array>}
   */
  async read(address, length, opts = {}) {
    const image = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      _gs20Check(opts.abort);
      const absolute = address + offset;
      let want = Math.min(Gs20FullReader.CHUNK, length - offset);
      want = Math.min(
        want,
        Gs20FullReader.PAGE - (absolute % Gs20FullReader.PAGE)
      );
      const chunk = await this._readChunk(absolute, want, opts.abort);
      if (chunk.length !== want) {
        throw new Error(
          `the transmission returned ${chunk.length} bytes at ${_gs20Hex(absolute)} where ${want} were asked for`
        );
      }
      image.set(chunk, offset);
      offset += want;
      opts.onProgress && opts.onProgress(Math.round((offset * 100) / length));
    }
    this._note(`read ${image.length} bytes from ${_gs20Hex(address)}`);
    return image;
  }

  async _readChunk(address, length, abort) {
    const payload = [
      0x06,
      0x08,
      (address >> 16) & 0xff,
      (address >> 8) & 0xff,
      address & 0xff,
      length,
    ];
    let last = null;
    for (let attempt = 0; attempt < GS20_RETRIES; attempt++) {
      _gs20Check(abort);
      try {
        const reply = await this._wire.transfer(
          DS2_ADDRESS.tcu,
          payload,
          GS20_READ_TIMEOUT_MS
        );
        const status = ds2Status(reply);
        if (status !== DS2_STATUS.ok) {
          if (status === DS2_STATUS.error) {
            throw new Error(
              `the transmission refused subcode 8 at ${_gs20Hex(address)} (status B0): this module does ` +
                'not have the patched program; stock firmware answers only calibration reads'
            );
          }
          throw new Error(
            `the transmission refused a read at ${_gs20Hex(address)}: ${busTrace.hex(reply.slice(0, 12))}`
          );
        }
        const available = reply.length - 4;
        if (available < length) {
          throw new Error(
            `a read at ${_gs20Hex(address)} returned only ${Math.max(available, 0)} of ${length} bytes`
          );
        }
        return Uint8Array.from(reply.slice(3, 3 + length));
      } catch (e) {
        if (e && e.message === 'cancelled') throw e;
        last = e;
        if (attempt + 1 < GS20_RETRIES) await bmwSleep(GS20_RETRY_DELAY_MS);
      }
    }
    throw new Error(
      `a read at ${_gs20Hex(address)} failed after ${GS20_RETRIES} attempts: ${last && last.message}`
    );
  }
}

// ---- orchestration on the car ---------------------------------------------------------

/**
 * Read the module's info block (0D), from which BMW's programming SGBD takes
 * the ZIF and AIF addresses. No session needed.
 * @param {{onTrace?: (t: string) => void}} [opts]
 * @returns {Promise<number[]>}
 */
function gs20ReadInfo(opts = {}) {
  return ds2WireSession((wire) => new Gs20CalWriter(wire).readInfo(), {
    trace: opts.onTrace,
  });
}

/**
 * Whether the module answers the subcode-8 read, i.e. runs the patched program.
 * @param {{onTrace?: (t: string) => void}} [opts]
 * @returns {Promise<string|null>} null when it does, otherwise why not.
 */
function gs20ProbeReadPatch(opts = {}) {
  return ds2WireSession((wire) => new Gs20FullReader(wire).probe(), {
    trace: opts.onTrace,
  });
}

/**
 * Read the whole 512 KB module image with the subcode-8 read. A probe runs
 * first so an unpatched module is reported as such rather than failing 4000
 * chunks in a row.
 * @param {{fast?: boolean, onStage?: (t: string) => void, onProgress?: (p: number) => void, abort?: AbortSignal, onTrace?: (t: string) => void}} [opts]
 * @returns {Promise<Uint8Array>}
 */
function gs20ReadFull(opts = {}) {
  const stage = opts.onStage || (() => {});
  return ds2WireSession(
    async (wire) => {
      if (opts.fast !== false) await _gs20TryFast(wire, stage);
      try {
        const reader = new Gs20FullReader(wire, { note: stage });
        const problem = await reader.probe(opts.abort);
        if (problem) throw new Error(problem);
        stage(
          `reading 0x${GS20_FULL_LENGTH.toString(16).toUpperCase()} bytes from ${_gs20Hex(GS20_FULL_ADDRESS)}`
        );
        return await reader.read(GS20_FULL_ADDRESS, GS20_FULL_LENGTH, {
          onProgress: opts.onProgress,
          abort: opts.abort,
        });
      } finally {
        await _gs20BackToDefault(wire);
      }
    },
    { trace: opts.onTrace }
  );
}

/**
 * Write the program region. The UI MUST have confirmed this; the engine
 * refuses an unconfirmed call. Session, battery, fast rate, unlock, then the
 * erase-write-commit, then the optional programming-log entry, all inside one
 * bus lock. The error carries `erasedSectors` so the UI can say what state
 * the module is in.
 * @param {Uint8Array} program - The 256 KB program region.
 * @param {{confirmed: boolean, fast?: boolean, calibration?: Uint8Array|null, aifRecord?: Uint8Array|null, onStage?: (t: string) => void, onProgress?: (p: number) => void, abort?: AbortSignal, onTrace?: (t: string) => void}} opts -
 *   `calibration` is the 64 KB image written in the same session right after
 *   the program (a transmission only runs a program with a calibration of its
 *   release). The error then also carries `programWritten` and
 *   `calibrationEraseStarted`.
 * @returns {Promise<{checksum: number, checksumCorrected: boolean, calibration: {checksumCorrected: boolean}|null, volts: number|null, info: number[]|null, aif: {address: number, slot: number, left: number}|null, aifError: string|null}>}
 */
function gs20WriteProgram(program, opts = {}) {
  if (!opts.confirmed)
    throw new Error(
      'a program write requires an explicit confirmation from the UI'
    );
  _gs20RequireProgram(program);
  const stage = opts.onStage || (() => {});
  return ds2WireSession(
    async (wire) => {
      const session = new Gs20CalWriter(wire, { note: stage });
      const writer = new Gs20ProgramWriter(wire, { note: stage });
      let volts = null;
      let info = null;
      let programWritten = false;
      try {
        stage('opening session');
        await session.openSession(opts.abort);
        try {
          info = await session.readInfo();
          stage(`info (0D): ${busTrace.hex(info.slice(0, 96))}`);
        } catch (e) {
          stage(`info (0D) unavailable: ${(e && e.message) || e}`);
        }
        // a brown-out mid-write is the one failure that cannot be undone from
        // here; a module whose program is erased answers from its boot block,
        // which refuses the reading while taking every flash command, so a
        // refusal is noted and the write goes on
        try {
          volts = await session.readBatteryVolts();
          stage(`battery ${volts.toFixed(1)} V`);
        } catch (e) {
          stage(
            `battery reading unavailable (boot block answering?): ${(e && e.message) || e}`
          );
        }
        if (volts != null && volts > 0 && volts < 11.5) {
          throw new Error(
            `supply is ${volts.toFixed(1)} V; a program write needs a steady supply above 11.5 V, ` +
              'put a charger or bench supply on it'
          );
        }
        // baud before unlock, never after: the switch settles with an ident,
        // and an ident closes the session
        if (opts.fast !== false) await _gs20TryFast(wire, stage);
        stage('unlocking');
        await session.openSession(opts.abort);
        await session.unlock(opts.abort);
        stage('unlocked, checking the module accepts flash commands');
        const result = await writer.write(program, {
          onStage: stage,
          onProgress: opts.onProgress,
          abort: opts.abort,
        });
        programWritten = true;
        // the calibration that belongs to the program goes in the same
        // session, straight after it: the module keeps serving the session
        // (its open is refused as "already in programming mode" and that is
        // taken), the rate stays fast, and nobody is asked anything while the
        // transmission is sitting on a program it cannot run yet
        let calibration = null;
        if (opts.calibration) {
          stage('program written and committed; writing the calibration');
          calibration = await session.write(opts.calibration, {
            onStage: stage,
            onProgress: opts.onProgress,
            abort: opts.abort,
          });
        }
        let aif = null;
        let aifError = null;
        if (opts.aifRecord) {
          try {
            stage('writing the programming record (AIF)');
            aif = await session.writeAifRecord(opts.aifRecord);
            stage(
              `AIF entry ${aif.slot + 1} written at ${_gs20Hex(aif.address)} (${aif.left} left)`
            );
          } catch (e) {
            aifError = (e && e.message) || String(e);
            stage(`AIF not written: ${aifError}`);
          }
        }
        return { ...result, calibration, volts, info, aif, aifError };
      } catch (e) {
        if (e && typeof e === 'object') {
          e.erasedSectors = writer.erasedSectors.length;
          e.programWritten = programWritten;
          e.calibrationEraseStarted = session.eraseStarted;
        }
        throw e;
      } finally {
        await _gs20BackToDefault(wire);
        await session.closeSession();
      }
    },
    { trace: opts.onTrace }
  );
}

if (typeof window !== 'undefined') {
  window.gs20ProgramChecksum = gs20ProgramChecksum;
  window.gs20ProgramRelease = gs20ProgramRelease;
  window.gs20ProgramHasReadPatch = gs20ProgramHasReadPatch;
  window.gs20IdentTail = gs20IdentTail;
  window.gs20DatenFile = gs20DatenFile;
  window.gs20NoUpshift = gs20NoUpshift;
  window.gs20Aif = gs20Aif;
  window.gs20WriteProgram = gs20WriteProgram;
  window.gs20ReadFull = gs20ReadFull;
  window.gs20ProbeReadPatch = gs20ProbeReadPatch;
  window.gs20ReadInfo = gs20ReadInfo;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    GS20_PROGRAM_ADDRESS,
    GS20_PROGRAM_LENGTH,
    GS20_FULL_ADDRESS,
    GS20_FULL_LENGTH,
    GS20_PROGRAM_SECTORS,
    gs20ProgramChecksum,
    gs20ProgramRelease,
    gs20ProgramHasReadPatch,
    gs20IdentTail,
    gs20DatenFile,
    gs20NoUpshift,
    gs20Aif,
    Gs20ProgramWriter,
    Gs20FullReader,
    gs20WriteProgram,
    gs20ReadFull,
    gs20ProbeReadPatch,
    gs20ReadInfo,
  };
}
