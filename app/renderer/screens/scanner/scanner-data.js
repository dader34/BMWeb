/**
 * @file BMWeb Scanner, data and pure logic: the module table, how each
 * identification answer becomes a row, and the scan log in the reference
 * scanner's own layout.
 *
 * The reference is BMW Scanner 1.4.0.7 (P.A.Soft), read out of a memory dump
 * of the running program (notes: ~/Desktop/BMW Stuff/PASoft-ghidra/
 * live-dump-2026-11-09/NOTES.md). Everything here is plain functions over
 * bytes, so tools/verify/test_scanner.js can hold it to the reference's
 * output without a cable.
 */

/* exported scannerClearWaitMs, SCANNER_MODULES, SCANNER_EXTRA_MODULES, scannerUnits, SCANNER_FLAG, scannerTriesKwp, scannerKwpOnly, scannerParseDs2Ident, scannerParseKwpIdent, scannerLogLine, scannerLogHeader, scannerErrorsLine, scannerLog, SCANNER_RULE */

/**
 * One module the reference scanner knows. Order matters: the scan walks this
 * list top to bottom and the log keeps that order, which is the reference's
 * own table order (DME, EGS, EWS, ABS, ... as its logs show).
 * @typedef {object} ScannerModule
 * @property {string} name - The short name the log prints ("DME", "A/C").
 * @property {string} desc - The full name.
 * @property {number} address - The DS2 / KWP target address.
 * @property {number} flags - The reference's protocol flags (SCANNER_FLAG).
 */

/**
 * The reference's per-module flags that decide how a module is asked.
 * kwpOnly: identified in KWP2000 only (transfer box, Valvetronic);
 * kwpFallback: asked in KWP2000 when DS2 gets no answer (DME, EGS, ABS, SRS
 * on later cars); modeOne: the reference's own request form (EDC), not yet
 * reproduced here.
 */
const SCANNER_FLAG = { kwpFallback: 0x128, kwpOnly: 0x40, modeOne: 0x400 };

/**
 * The reference's 61 modules, in its table order, with its addresses and
 * flags (read from the running program's module records).
 * @type {ScannerModule[]}
 */
const SCANNER_MODULES = [
  {
    name: 'DME',
    desc: 'Digital Motor Electronics',
    address: 0x12,
    flags: 0x120,
  },
  {
    name: 'DME2',
    desc: 'Digital Motor Electronics (Slave)',
    address: 0x13,
    flags: 0x008,
  },
  {
    name: 'EGS',
    desc: 'Electronic Gearbox Control',
    address: 0x32,
    flags: 0x030,
  },
  {
    name: 'EWS',
    desc: 'Electronic Car Immobilisation System',
    address: 0x44,
    flags: 0x000,
  },
  {
    name: 'ABS',
    desc: 'Anti-lock Braking System with ASC/DSC',
    address: 0x56,
    flags: 0x020,
  },
  { name: 'LEW', desc: 'Steering-Angle Sensor', address: 0x57, flags: 0x000 },
  {
    name: 'A/C',
    desc: 'Heater and Automatic Conditioner Control',
    address: 0x5b,
    flags: 0x000,
  },
  {
    name: 'SRS',
    desc: 'Supplemental Restraint System',
    address: 0xa4,
    flags: 0x020,
  },
  {
    name: 'IKE',
    desc: 'Instrument Cluster Electronics',
    address: 0x80,
    flags: 0x000,
  },
  { name: 'LCM', desc: 'Light Check Module', address: 0xd0, flags: 0x000 },
  { name: 'ZKE', desc: 'Central Body Electronic', address: 0x00, flags: 0x000 },
  {
    name: 'MFL',
    desc: 'Multi-Function Steering Wheel',
    address: 0x50,
    flags: 0x000,
  },
  { name: 'PDC', desc: 'Park Distance Control', address: 0x60, flags: 0x000 },
  {
    name: 'AIC',
    desc: 'Automatic Interval Control',
    address: 0xe8,
    flags: 0x000,
  },
  { name: 'RAD', desc: 'Radio', address: 0x68, flags: 0x000 },
  { name: 'TEL', desc: 'Car Telephone', address: 0xc8, flags: 0x000 },
  {
    name: 'SZM',
    desc: 'Switching Center, Centre Console',
    address: 0xf5,
    flags: 0x000,
  },
  { name: 'VID', desc: 'Video Module', address: 0xed, flags: 0x000 },
  { name: 'NAV', desc: 'Navigation System', address: 0x7f, flags: 0x000 },
  {
    name: 'VMGP',
    desc: 'Video Module, Graphic Part',
    address: 0x3b,
    flags: 0x000,
  },
  {
    name: 'BMBT',
    desc: 'On-board Monitor, Control Panel',
    address: 0xf0,
    flags: 0x000,
  },
  {
    name: 'MID',
    desc: 'Multi-Information Display',
    address: 0xc0,
    flags: 0x000,
  },
  {
    name: 'FID',
    desc: 'Multi-Information Display, Rear',
    address: 0xa0,
    flags: 0x000,
  },
  { name: 'GR2', desc: 'Cruise Control', address: 0xa6, flags: 0x000 },
  {
    name: 'STH',
    desc: 'Independent/Auxiliary Heating',
    address: 0x6b,
    flags: 0x000,
  },
  { name: 'VTG', desc: 'Transfer Box', address: 0x34, flags: 0x060 },
  { name: 'VTC1', desc: 'Valvetronic 1', address: 0x1b, flags: 0x060 },
  { name: 'VTC2', desc: 'Valvetronic 2', address: 0x1e, flags: 0x060 },
  { name: 'RDC', desc: 'Tyre Pressure Check', address: 0x70, flags: 0x000 },
  { name: 'DSP', desc: 'Digital Sound Processor', address: 0x6a, flags: 0x000 },
  { name: 'SES', desc: 'Language-Input System', address: 0xb0, flags: 0x000 },
  {
    name: 'EHC',
    desc: 'Electronic Height Control',
    address: 0xac,
    flags: 0x000,
  },
  { name: 'SHD', desc: 'Sliding/Tilting Sunroof', address: 0x08, flags: 0x000 },
  {
    name: 'LRA',
    desc: 'Automatic Headlight Vertical Aim Control',
    address: 0x9a,
    flags: 0x000,
  },
  {
    name: 'AHL',
    desc: 'Adaptive Directional Headlights',
    address: 0x66,
    flags: 0x000,
  },
  { name: 'XENL', desc: 'Xenon Headlight, Left', address: 0x98, flags: 0x000 },
  { name: 'XENR', desc: 'Xenon Headlight, Right', address: 0x86, flags: 0x000 },
  { name: 'SPMFT', desc: 'Mirror Memory, Driver', address: 0x9b, flags: 0x000 },
  {
    name: 'SPMBT',
    desc: 'Mirror Memory, Passenger',
    address: 0x51,
    flags: 0x000,
  },
  { name: 'SMF', desc: 'Seats Memory, Driver', address: 0x72, flags: 0x000 },
  { name: 'SMB', desc: 'Seats Memory, Passenger', address: 0xda, flags: 0x000 },
  {
    name: 'FMBT',
    desc: 'Rear Compartment Monitor',
    address: 0x47,
    flags: 0x000,
  },
  { name: 'FGB', desc: 'Rear Compartment Blower', address: 0xa7, flags: 0x000 },
  {
    name: 'EML',
    desc: 'Electronic Engine Power Control',
    address: 0x22,
    flags: 0x000,
  },
  { name: 'HKM', desc: 'Boot-Lid Module', address: 0x24, flags: 0x000 },
  { name: 'SEC', desc: 'Security Module', address: 0x4a, flags: 0x000 },
  { name: 'CCM', desc: 'Check Control Module', address: 0x30, flags: 0x000 },
  { name: 'CVM', desc: 'Convertible-Top Module', address: 0x9c, flags: 0x000 },
  { name: 'SVT', desc: 'Servotronic', address: 0xc2, flags: 0x000 },
  { name: 'URS', desc: 'Rollover Sensor', address: 0x9e, flags: 0x000 },
  { name: 'EKP', desc: 'Electric Fuel Pump', address: 0x65, flags: 0x000 },
  { name: 'RIP', desc: 'Remote Instrument Pack', address: 0x81, flags: 0x000 },
  {
    name: 'TOENS',
    desc: 'Thermal Oil-Level Sensor',
    address: 0x16,
    flags: 0x000,
  },
  { name: 'ELV', desc: 'Electric Steering Lock', address: 0x5a, flags: 0x000 },
  {
    name: 'FBZV',
    desc: 'Radio Remote Control for Central Locking',
    address: 0x40,
    flags: 0x000,
  },
  { name: 'SBE', desc: 'Seat Occupancy Detector', address: 0xce, flags: 0x000 },
  {
    name: 'SBBF',
    desc: 'Seat Occupancy Recognition (X3)',
    address: 0x74,
    flags: 0x000,
  },
  { name: 'RCC', desc: 'Radio-Clock Module', address: 0x28, flags: 0x000 },
  {
    name: 'EDC',
    desc: 'Electronic Damper Control',
    address: 0x2e,
    flags: 0x400,
  },
  {
    name: 'NAJ',
    desc: 'Japanese Navigation System',
    address: 0xbb,
    flags: 0x000,
  },
  {
    name: 'JBIT',
    desc: 'Japanese Basis Interface Telephone',
    address: 0x48,
    flags: 0x000,
  },
];

/**
 * Units the reference's table does not have, asked after it.
 *
 * These are the diagnostic addresses the E46 control unit tree carries that
 * no row above reaches (the whole-car scan the Garage used to run walked
 * that tree; this list is what it read and the reference never asked). The
 * reference has no record for them, so nothing is known about how each one
 * talks: every unit is asked in DS2 and then in KWP2000, and read with the
 * default procedures.
 *
 * A name the reference already uses for another address carries its own
 * address ("DME10"), so nothing keyed by a reference name -- its clear
 * procedure, its fault-list layout -- is applied to a unit it was never
 * captured on. The description stays the plain one: these are the same
 * kind of unit at the address another generation uses (KOMBI at 0D is the
 * instrument cluster of the cars before the IKE's 80).
 * @type {ScannerModule[]}
 */
const SCANNER_EXTRA_MODULES = [
  ['KOMBI', 'Instrument Cluster', 0x0d],
  ['DME10', 'Digital Motor Electronics', 0x10],
  ['ZKE11', 'Central Body Electronic', 0x11],
  ['DME14', 'Digital Motor Electronics, Slave', 0x14],
  ['DDSHD', 'Twin-Panel Sliding/Tilting Sunroof', 0x15],
  ['EHPS', 'Electro-Hydraulic Power Steering', 0x31],
  ['LSM', 'Steering Column Memory / Electric Power Steering', 0x35],
  ['ABS36', 'Anti-lock Braking System', 0x36],
  ['CID', 'Central Information Display', 0x46],
  ['HKA', 'Rear Automatic Air Conditioning', 0x59],
  ['CDC', 'CD Changer', 0x76],
  ['SBSL', 'B-Pillar Satellite, Left', 0xa1],
  ['SBSR', 'B-Pillar Satellite, Right', 0xa2],
  ['STVL', 'Front Door Satellite, Left', 0xad],
  ['STVR', 'Front Door Satellite, Right', 0xae],
  ['BC', 'On-board Computer', 0xcd],
].map(([name, desc, address]) => ({ name, desc, address, flags: 0x020 }));

/**
 * Every unit a scan asks, in order: the reference's table, then the units
 * it does not have.
 * @returns {ScannerModule[]}
 */
const scannerUnits = () => [...SCANNER_MODULES, ...SCANNER_EXTRA_MODULES];

/**
 * Does the module get a KWP2000 identification when DS2 stays silent?
 * @param {ScannerModule} m
 * @returns {boolean}
 */
const scannerTriesKwp = (m) =>
  (m.flags & (SCANNER_FLAG.kwpFallback | SCANNER_FLAG.kwpOnly)) !== 0;

/**
 * Is the module identified in KWP2000 only?
 * @param {ScannerModule} m
 * @returns {boolean}
 */
const scannerKwpOnly = (m) => (m.flags & SCANNER_FLAG.kwpOnly) !== 0;

/** Two upper-case hex digits. */
const hex2 = (b) => (b & 0xff).toString(16).toUpperCase().padStart(2, '0');

/**
 * A BMW part number from its four BCD bytes, the way the reference prints
 * it: the eight digits less the first, grouped 1.3.3 ("F6 94 08 77" ->
 * "6.940.877").
 * @param {ArrayLike<number>} b - Four bytes.
 * @returns {string}
 */
function scannerPartNumber(b) {
  const digits = Array.from(b, hex2).join('').slice(1);
  return `${digits[0]}.${digits.slice(1, 4)}.${digits.slice(4, 7)}`;
}

/**
 * One identified module's row.
 * @typedef {object} ScannerIdent
 * @property {string} part - BMW part number ("6.940.877").
 * @property {string} hw - Hardware number.
 * @property {string} sw - Software number ("x.x.x" when the module gives none).
 * @property {string} ci - Coding index.
 * @property {string} di - Diagnostic index.
 * @property {string} bi - Bus index.
 * @property {string} date - Production date ("28/04" DS2, "01.05" KWP2000).
 * @property {boolean} kwp - Identified over KWP2000 (the log's '*').
 */

/**
 * A DS2 identification answer as the reference reads it (0x6B9E8E): address,
 * length, A0, part number in bytes 3-6, hardware 7, coding index 8,
 * diagnostic index 9, bus index 10, week and year 11-12, supplier 13,
 * software 14.
 * @param {ArrayLike<number>} r - The whole answer frame.
 * @returns {ScannerIdent|null} Null for a refusal or a frame too short.
 */
function scannerParseDs2Ident(r) {
  if (!r || r.length < 15 || r[2] !== 0xa0) return null;
  // the long form (the GS20's 2E-byte answer): the same fields as ASCII
  // text, as the reference reads it past length 18h -- "7552700 29 00 10
  // 60 36 05 ..." prints 7.552.700, hw 29, ci 00, di 10, bi 60, 36/05 and
  // the software number at character 29 ("90")
  if (r[1] > 0x18) {
    const a = String.fromCharCode(...Array.from(r).slice(3, -1));
    if (/^\d{7}[0-9A-F]{12}/.test(a)) {
      return {
        part: `${a[0]}.${a.slice(1, 4)}.${a.slice(4, 7)}`,
        hw: a.slice(7, 9),
        sw: a.length >= 31 ? a.slice(29, 31) : 'x.x.x',
        ci: a.slice(9, 11),
        di: a.slice(11, 13),
        bi: a.slice(13, 15),
        date: `${a.slice(15, 17)}/${a.slice(17, 19)}`,
        kwp: false,
      };
    }
  }
  return {
    part: scannerPartNumber([r[3], r[4], r[5], r[6]]),
    hw: hex2(r[7]),
    sw: hex2(r[14]),
    ci: hex2(r[8]),
    di: hex2(r[9]),
    bi: hex2(r[10]),
    date: `${hex2(r[11])}/${hex2(r[12])}`,
    kwp: false,
  };
}

/**
 * A KWP2000 identification answer (B8 F1 xx len 5A 80 ...), the way the
 * reference prints it. Checked against its own log for the same answers
 * from the E46 capture:
 *   DME  b8 f1 12 1f 5a 80 00 00 07 56 13 82 00 00 00 11 31 43 20 05 01 ..
 *        -> 7.561.382  00  x.x.x  00  0011  3143  01.05
 *   DSC  b8 f1 29 1f 5a 80 00 00 06 76 54 52 01 12 00 06 00 06 20 04 07 ..
 *        -> 6.765.452  01  ...    12  0006  0006  07.04
 * Part number as BCD in bytes 8-11 (the DS2 rule), hardware 12, coding
 * index 13, diagnostic and bus index as byte pairs 14-15 and 16-17, the
 * date as week (20) and year (19). The software column comes from a later
 * read the reference makes; "x.x.x" until it is reproduced.
 * @param {ArrayLike<number>} r - The whole answer frame.
 * @returns {ScannerIdent|null}
 */
function scannerParseKwpIdent(r) {
  if (!r || r.length < 22 || r[4] !== 0x5a || r[5] !== 0x80) return null;
  return {
    part: scannerPartNumber([r[8], r[9], r[10], r[11]]),
    hw: hex2(r[12]),
    sw: 'x.x.x',
    ci: hex2(r[13]),
    di: hex2(r[14]) + hex2(r[15]),
    bi: hex2(r[16]) + hex2(r[17]),
    date: `${hex2(r[20])}.${hex2(r[19])}`,
    kwp: true,
  };
}

/** The reference log's rule line: 123 dashes. */
const SCANNER_RULE = '-'.repeat(123);

/** Left-pad a cell to its column. */
const col = (s, w) => String(s == null ? '-' : s).padEnd(w);

/**
 * The scan table's header, character for character the reference's.
 * @returns {string}
 */
const scannerLogHeader = () =>
  'Unit      BMWTNR     HW  SW-FSW       CI  DI    BI/VI  Date    Odometer    VIN                ADFG     Algorithm';

/**
 * The unit cell: the name, a '*' for a KWP2000 answer, padded to six, then
 * the arrow -- "DME*  ->  ", "EGS   ->  ".
 * @param {string} name
 * @param {boolean} kwp
 * @returns {string}
 */
const unitCell = (name, kwp) => col(name + (kwp ? '*' : ''), 6) + '->  ';

/**
 * One module's line of the scan table, in the reference's column widths.
 * Odometer, VIN, ADFG and Algorithm print "-" until they are read.
 * @param {string} name - The module's short name.
 * @param {ScannerIdent} id - Its identification.
 * @param {{odometer?: string, vin?: string, adfg?: string, algorithm?: string}} [extra]
 * @returns {string}
 */
function scannerLogLine(name, id, extra = {}) {
  return (
    unitCell(name, id.kwp) +
    col(id.part, 9) +
    '  ' +
    col(id.hw, 2) +
    '  ' +
    col(id.sw, 11) +
    '  ' +
    col(id.ci, 2) +
    '  ' +
    col(id.di, 4) +
    '  ' +
    col(id.bi, 5) +
    '  ' +
    col(id.date, 6) +
    '  ' +
    col(extra.odometer, 10) +
    '  ' +
    col(extra.vin, 17) +
    '  ' +
    col(extra.adfg, 7) +
    '  ' +
    (extra.algorithm || '-')
  ).replace(/\s+$/, '');
}

/**
 * One module's line of the error table: "1 error", "no errors", "3 errors",
 * with " / ..." for the shadow memory when it was read.
 * @param {string} name
 * @param {ScannerIdent} id
 * @param {number|null} errors - Stored faults, null when unread.
 * @param {number|null} [shadow] - Shadow-memory entries, null when unread.
 * @returns {string}
 */
function scannerErrorsLine(name, id, errors, shadow = null, after) {
  const count = (n) =>
    n == null
      ? 'unknown'
      : n === 0
        ? 'no errors'
        : n === 1
          ? '1 error'
          : `${n} errors`;
  const cell =
    shadow == null
      ? count(errors)
      : col(count(errors), 9) + ' / ' + count(shadow);
  return (
    unitCell(name, id.kwp) +
    col(id.part, 9) +
    '  ' +
    col(id.hw, 2) +
    '  ' +
    col(id.sw, 11) +
    '  ' +
    (after === undefined
      ? cell
      : col(cell, 25) + (after == null ? '-' : count(after)))
  ).replace(/\s+$/, '');
}

/**
 * How long the reference waits after clearing a module (0x6C19DC): two
 * seconds for every module, plus the module's own settle time -- three
 * seconds for the engine and gearbox, climate, sound processor and airbag
 * units, half a second for ABS, 0.3 s for the light module, one second for
 * a KWP2000 module.
 * @param {ScannerModule} m
 * @param {boolean} kwp - The module answered in KWP2000.
 * @returns {number} Milliseconds.
 */
function scannerClearWaitMs(m, kwp) {
  const own = kwp
    ? 1000
    : ['DME', 'DME2', 'EGS', 'A/C', 'DSP', 'SRS'].includes(m.name)
      ? 3000
      : m.name === 'ABS'
        ? 500
        : m.name === 'LCM'
          ? 300
          : 0;
  return own + 2000;
}

/**
 * The whole scan log, sections and rules as the reference writes them, with
 * CRLF line ends.
 * @param {{title: string, clear?: boolean, rows: {module: ScannerModule, id: ScannerIdent, errors: number|null, shadow?: number|null, after?: number|null, extra?: object}[]}} scan
 * @returns {string}
 */
function scannerLog(scan) {
  const clear = !!scan.clear;
  const L = [
    SCANNER_RULE,
    scan.title,
    SCANNER_RULE,
    '',
    '',
    ' # SCAN START',
    SCANNER_RULE,
    scannerLogHeader(),
    SCANNER_RULE,
  ];
  for (const r of scan.rows)
    L.push(scannerLogLine(r.module.name, r.id, r.extra));
  L.push(
    '',
    '',
    ' # ERRORS IN UNITS',
    SCANNER_RULE,
    'Unit      BMWTNR     HW  SW-FSW       ERRORS / SHADOW-MEMORY' +
      (clear ? '   ERRORS AFTER CLEAR' : ''),
    SCANNER_RULE
  );
  for (const r of scan.rows)
    L.push(
      scannerErrorsLine(
        r.module.name,
        r.id,
        r.errors,
        r.shadow,
        clear ? (r.after === undefined ? null : r.after) : undefined
      )
    );
  if (clear) {
    // what went over the line for each unit (BMWeb's own section, not the
    // reference's): the counts, the clear and the read after it
    L.push('', '', ' # CLEAR DETAILS', SCANNER_RULE);
    for (const r of scan.rows)
      if (r.trace && r.trace.length)
        L.push(r.module.name, ...r.trace.map((t) => '    ' + t), '');
  }
  L.push('', '', ' # SCAN END', SCANNER_RULE, '');
  return L.join('\r\n');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SCANNER_MODULES,
    SCANNER_EXTRA_MODULES,
    scannerUnits,
    SCANNER_FLAG,
    SCANNER_RULE,
    scannerTriesKwp,
    scannerKwpOnly,
    scannerPartNumber,
    scannerParseDs2Ident,
    scannerParseKwpIdent,
    scannerLogHeader,
    scannerLogLine,
    scannerErrorsLine,
    scannerLog,
    scannerClearWaitMs,
  };
}
