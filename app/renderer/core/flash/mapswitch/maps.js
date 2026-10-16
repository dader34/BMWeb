// Map switching for the MS45.1, program 0044570LO02S. Ported from
// BMWeb-Flasher's MapSwitch.cs, whose two-map build has run on the car, and
// extended to several maps that store only what differs.
//
// What the patch does:
//   - The program addresses the calibration as 0xFFE40000+ (flash 0x40000, a
//     0x1D000-byte partition), in two ways: table/axis lookups go through 16
//     routines in the MPC that take the table pointer in r3, and single values
//     are read relative to r2 (= calibration + 0x7FF0).
//   - Each extra map is kept in the empty external flash as 1 KB blocks: the
//     blocks that differ from map 1 (with their neighbours, so a table that
//     runs across a block edge still reads whole), plus a "window": every
//     value the program reads through r2 lies in blocks 0-6, 0x12 and
//     0x15-0x17, so those eleven are stored at their own offsets from a base
//     the map's r2 is set to. A 256-byte block table per map says where each
//     of the calibration's 116 blocks lives; 0xFFFF means "map 1's". The
//     tables follow a header at 0xDCC00; the blocks fill 0xDD400-0xF8000 and
//     0xFA800-0xFFC00. The windows nest, one map's r2 blocks in the gaps of
//     another's (bases 7 and 31 KB apart by turns), and the slots left hold
//     the other blocks, so six extra maps cost 11 KB each plus what differs.
//   - Each lookup routine gets a hook: when a map other than map 1 is
//     selected and r3 points into the calibration, the block table is
//     consulted and r3 moved to the stored block. r2 is set from the header
//     (one word per map) at stored-data restore and at the gesture.
//   - The routine that builds CAN frame 0x316 (engine speed for the cluster)
//     is hooked where it stores the rpm: the chosen trigger steps to the next
//     map (the DSC button pressed 2 or 4 times, the gear lever moved D-S-D or
//     S-D-S within 2 s, or brake + full throttle for 5 s with the engine
//     stopped), and after the last map comes map 1 again. Engine stopped, the
//     tach shows 1000 rpm times the map number (also 3 s at ignition-on);
//     engine running, the check-engine lamp blinks map-number times.
//   - The gear lever needs nothing from the gearbox beyond what it already
//     sends: its frame 0x43F (EGS1) carries the gear in byte 0 and the
//     program symbol for the cluster in the top three bits of byte 2, which
//     is 2 with the lever in the S/M gate, 1 once a tap has latched manual,
//     and 5 in D (4 with the GS20 gear-display program).
//   - The selection is kept in bits 5-7 of stored-data block 56, whose stock
//     value is only ever 0, 1 or 2.
//   - The safety monitor's code sum and calibration sum are brought up to date.
//
// Earlier builds (generations 0-3) kept one full copy of map 2 at 0xE0000 and
// toggled a single bit; their code is still generated here so that a car
// carrying one is recognised, and a build replaces it.
//
// Checksums and signatures are NOT computed here: the caller runs the pair
// through ms45Checksums, as for any other program flash.

/* exported MAPSWITCH_PROGRAM_VERSION, MAPSWITCH_FULL_FLASH_LENGTH, MAPSWITCH_MPC_LENGTH, MAPSWITCH_CAL_START, MAPSWITCH_CAL_LENGTH, MAPSWITCH_MAP2_START, MAPSWITCH_MAP2_LENGTH, MAPSWITCH_PROGRAM_VERSION_OFFSET, MAPSWITCH_DATA_VERSION_OFFSET, MAPSWITCH_DATA_VERSION_LENGTH, MAPSWITCH_FREE_START, MAPSWITCH_FREE_END, MAPSWITCH_R13, MAPSWITCH_EXT, MS_LOOKUP_ENTRIES, MS_LOOKUP_STOCK, MS_TACH_STORE_ADDR, MS_TACH_STORE_INSN, MS_TACH_VAR, MS_TACH_1000, MS_TACH_2000, MS_MIL_STORE_ADDR, MS_MIL_STORE_INSN, MS_MIL_BYTE, MS_MIL_BIT, MS_BLINK_ON_CALLS, MS_BLINK_PERIOD_CALLS, MS_ECON_STORE_ADDR, MS_ECON_STORE_INSN, MS_NV_DESCRIPTOR, MS_NV_STOCK, MS_NV_VAR, MS_NV_SAVE_REQUEST, MS_NV_STOCK_MASK, MS_NV_INDEX_SHIFT, MS_VAR_ENGINE_SPEED, MS_VAR_VEHICLE_SPEED, MS_VAR_PEDAL, MS_VAR_BRAKE_A, MS_VAR_BRAKE_B, MS_VAR_DSC_STATE, MS_DSC_STATE_MASK, MS_FIRST_VAR_DSC_STATE, MS_FIRST_DSC_STATE_MASK, MS_RAM_EGS1, MS_VAR_EGS1_GEAR, MS_VAR_EGS1_PROGRAM, MS_EGS1_GEAR_MASK, MS_EGS1_GEAR_REVERSE, MS_EGS1_PROGRAM_SHIFT, MS_EGS1_PROGRAM_MANUAL, MS_EGS1_PROGRAM_SPORT, MS_EGS1_PROGRAM_DRIVE_GEAR_DISPLAY, MS_EGS1_PROGRAM_DRIVE, MS_LEVER_IN_DRIVE, MS_LEVER_IN_GATE, MS_RAM_FLAG, MS_FLAG_INDEX_SHIFT, MS_FLAG_INDEX_MASK, MS_FLAG_LATCH, MS_RAM_HOLD_COUNTER, MS_RAM_DISPLAY_COUNTER, MS_RAM_PRESS_COUNTER, MS_RAM_LEVER, MS_RAM_STARTUP_DELAY, MS_RAM_WIDE_DISPLAY_COUNTER, MS_RAM_BLINKS, MS_RAM_BLINK_PHASE, MS_RAM_STARTUP_LOCKOUT, MS_STARTUP_LOCKOUT_CALLS, MS_HOLD_CALLS, MS_DISPLAY_CALLS, MS_DSC_PRESS_CHOICES, MS_DEFAULT_DSC_PRESSES, MS_DSC_PRESS_WINDOW_CALLS, MS_SHIFTER_WINDOW_CALLS, MS_TRIGGERS, MS_STARTUP_DISPLAY_CALLS, MS_STARTUP_DELAY_CALLS, MS_PEDAL_FULL, MS_PEDAL_RELEASED, MS_MAP2_DELTA_HIGH, MS_R2_HIGH, MS_R2_LOW, MS_R2_MAP1, MS_ROM_TEST_SUM_OFFSET, MS_ROM_TEST_RANGES_OFFSET, MS_ROM_TEST_RANGES, MS_ROM_TEST_SEED, MS_U64, MS_CALIBRATION_RANGE_TAG, MS_CAL_TEST_RANGE_OFFSET, MS_CALIBRATION_BASE, MS_CAL_TEST_RANGE_START, MS_CAL_TEST_RANGE_END, MS_CAL_TEST_SUM_OFFSET, MS_CAR_CHECK_LENGTH, MS_CURRENT_GEN, MS_MULTI_GEN, MS_SITE_GEN, MS_WINDOW_POINTER_GEN, MS_BLOCK, MS_BLOCK_COUNT, MS_MAX_MAPS, MS_MIN_MAPS, MS_HEADER, MS_HEADER_MAGIC, MS_HEADER_COUNT, MS_HEADER_R2, MS_TABLE_STRIDE, MS_TABLE_ENTRIES, MS_TABLES_END, MS_TABLES_LENGTH, MS_NO_BLOCK, MS_CHUNK, MS_CHUNK_COUNT, MS_CHUNK_TABLE_STRIDE, MS_CHUNK_TABLE_ENTRIES, MS_CHUNK_TABLES_END, MS_TABLE_REACH, MS_HEADER_LAYOUT, MS_HEADER_SITES_END, MS_SITES, MS_SITES_MAGIC, MS_LOOKUP_ENTRY_17, MS_LOOKUP_STOCK_17, MS_CODE, MS_POOLS, MS_R2_BLOCKS, MS_UPPER_ADDIS, MS_UPPER_LIS, MS_UPPER_INSN_MASK, MS_UPPER_SITES, MS_SENSOR_TABLE_SITES, MS_SENSOR_TABLE_LIS, MS_MAP1_ONLY, MS_UPPER_CODE, msD, Lbz, Lhz, Lwz, Stb, Sth, Li, Addi, Addis, Lis, Mulli, Cmpwi, Cmplwi, Cmpw, AndiDot, Ori, Oris, Xori, Rlwinm, Srwi, Or, Subf, MS_BLR, Ba, MS_BEQ, MS_BNE, MS_BLT, MS_BGE, msHa, msLo, msBranch, MsAsm, msRead16, msWrite16, msRead32, msWrite32, msOff, msReadAscii, msKb */

const MAPSWITCH_PROGRAM_VERSION = '0044570LO02S';
const MAPSWITCH_FULL_FLASH_LENGTH = 0x100000;
const MAPSWITCH_MPC_LENGTH = 0x70000;
const MAPSWITCH_CAL_START = 0x40000;
const MAPSWITCH_CAL_LENGTH = 0x1d000;
const MAPSWITCH_MAP2_START = 0xe0000; // generations 0-3: the full copy of map 2
const MAPSWITCH_MAP2_LENGTH = 0x18000;
const MAPSWITCH_PROGRAM_VERSION_OFFSET = 0x6031c;
const MAPSWITCH_DATA_VERSION_OFFSET = 0x10;
const MAPSWITCH_DATA_VERSION_LENGTH = 12;
const MAPSWITCH_FREE_START = 0x6e550;
const MAPSWITCH_FREE_END = 0x70000;
const MAPSWITCH_R13 = 0x004017f0;
const MAPSWITCH_EXT = 0xfff00000; // the external flash as the CPU sees it

const MS_LOOKUP_ENTRIES = [
  0xcfc8, 0xd054, 0xd0e4, 0xd178, 0xd210, 0xd264, 0xd2c0, 0xd31c, 0xd380,
  0xd38c, 0xd39c, 0xd3b8, 0xd3dc, 0xd44c, 0xd4c0, 0xd660,
];
const MS_LOOKUP_STOCK = [
  0x89830000, 0x88e30000, 0xa1830000, 0xa0e30000, 0x88a30000, 0x88a30000,
  0xa0a30000, 0xa0a30000, 0x898dd7c6, 0x898dd7c6, 0x898dd7c6, 0x898dd7c6,
  0x38e30000, 0x38e30000, 0x88add7c4, 0x88add7c4,
];
const MS_TACH_STORE_ADDR = 0x4b6c4; // sth r3,-0x3B28(r13)
const MS_TACH_STORE_INSN = 0xb06dc4d8;
const MS_TACH_VAR = -0x3b28;
const MS_TACH_1000 = 6400;
const MS_TACH_2000 = 12800;
const MS_MIL_STORE_ADDR = 0x4bb78; // stb r0,-0x3B05(r13)
const MS_MIL_STORE_INSN = 0x980dc4fb;
const MS_MIL_BYTE = -0x3b05;
const MS_MIL_BIT = 0x02;
const MS_BLINK_ON_CALLS = 50;
const MS_BLINK_PERIOD_CALLS = 100;
const MS_ECON_STORE_ADDR = 0x4bba4; // stw r0,-0x3B08(r13), kept only to restore
const MS_ECON_STORE_INSN = 0x900dc4f8;
const MS_NV_DESCRIPTOR = 0x28ac + 56 * 0x1c;
const MS_NV_STOCK = [0xfffca0f8, 0xfffca104, 0xfffca110];
const MS_NV_VAR = -0x3fd1;
const MS_NV_SAVE_REQUEST = -0x2cc8 + 56;
const MS_NV_STOCK_MASK = 0x1f; // the stock value in block 56 is 0, 1 or 2
const MS_NV_INDEX_SHIFT = 5;
const MS_VAR_ENGINE_SPEED = -0x4bec;
const MS_VAR_VEHICLE_SPEED = -0x3f95;
const MS_VAR_PEDAL = -0x4061;
const MS_VAR_BRAKE_A = -0x4001;
const MS_VAR_BRAKE_B = -0x4002;
const MS_VAR_DSC_STATE = -0x3b44;
const MS_DSC_STATE_MASK = 0x02;
const MS_FIRST_VAR_DSC_STATE = -0x3b3d;
const MS_FIRST_DSC_STATE_MASK = 0x0c;
const MS_RAM_EGS1 = 0x3fdcfc; // the last 0x43F, byte-reversed: byte n at +7-n
const MS_VAR_EGS1_GEAR = MS_RAM_EGS1 + 7 - MAPSWITCH_R13;
const MS_VAR_EGS1_PROGRAM = MS_RAM_EGS1 + 5 - MAPSWITCH_R13;
const MS_EGS1_GEAR_MASK = 0x07; // 0 = P/N, 1-5 = the gear, 7 = R
const MS_EGS1_GEAR_REVERSE = 7;
const MS_EGS1_PROGRAM_SHIFT = 5;
const MS_EGS1_PROGRAM_MANUAL = 1;
const MS_EGS1_PROGRAM_SPORT = 2;
const MS_EGS1_PROGRAM_DRIVE_GEAR_DISPLAY = 4;
const MS_EGS1_PROGRAM_DRIVE = 5;
const MS_LEVER_IN_DRIVE = 1;
const MS_LEVER_IN_GATE = 2;
// The flag byte: generations 0-3 keep the map in bit 0; generation 4 keeps the
// map index (0 = map 1) in bits 4-6. Bit 1 is the pedal latch or the DSC
// button's last state, by trigger.
const MS_RAM_FLAG = 0x3fa195;
const MS_FLAG_INDEX_SHIFT = 4;
const MS_FLAG_INDEX_MASK = 0x70;
const MS_FLAG_LATCH = 0x02;
const MS_RAM_HOLD_COUNTER = 0x3fa196;
const MS_RAM_DISPLAY_COUNTER = 0x3fa1ed;
const MS_RAM_PRESS_COUNTER = MS_RAM_DISPLAY_COUNTER;
const MS_RAM_LEVER = MS_RAM_PRESS_COUNTER; // the shifter trigger: where the lever was last
const MS_RAM_STARTUP_DELAY = 0x3fa1ee;
const MS_RAM_WIDE_DISPLAY_COUNTER = MS_RAM_STARTUP_DELAY;
const MS_RAM_BLINKS = 0x3fa1c9;
const MS_RAM_BLINK_PHASE = 0x3fa1ca;
const MS_RAM_STARTUP_LOCKOUT = 0x3fa282;
const MS_STARTUP_LOCKOUT_CALLS = 10 * 100;
const MS_CALLS_PER_SECOND = 100;
const MS_HOLD_CALLS = 5 * MS_CALLS_PER_SECOND;
const MS_DISPLAY_CALLS = 150;
const MS_DSC_PRESS_CHOICES = [2, 4];
const MS_DEFAULT_DSC_PRESSES = 4;
const MS_DSC_PRESS_WINDOW_CALLS = 2 * MS_CALLS_PER_SECOND;
const MS_SHIFTER_WINDOW_CALLS = 2 * MS_CALLS_PER_SECOND;
const MS_TRIGGERS = ['dsc', 'shifter', 'pedals'];
const MS_STARTUP_DISPLAY_CALLS = 3 * MS_CALLS_PER_SECOND;
const MS_STARTUP_DELAY_CALLS = 6 * MS_CALLS_PER_SECOND;
const MS_PEDAL_FULL = 0xf0;
const MS_PEDAL_RELEASED = 0x20;
const MS_MAP2_DELTA_HIGH = 0x000a;
const MS_R2_HIGH = -0x1c;
const MS_R2_LOW = 0x7ff0;
const MS_R2_MAP1 = 0xffe47ff0;
const MS_ROM_TEST_SUM_OFFSET = 0x60600;
const MS_ROM_TEST_RANGES_OFFSET = 0x60608;
const MS_ROM_TEST_RANGES = [
  0x0000bae8, 0x0000f5f8, 0xfff60630, 0xfff68c2c, 0x00000140, 0x000002d4,
];
const MS_ROM_TEST_SEED = 0x0123456789abcdefn;
const MS_U64 = (1n << 64n) - 1n;
const MS_CALIBRATION_RANGE_TAG = 0x7ff2;
const MS_CAL_TEST_RANGE_OFFSET = MS_ROM_TEST_RANGES_OFFSET + 4 * 6;
const MS_CALIBRATION_BASE = 0xffe40000;
const MS_CAL_TEST_RANGE_START = 0xffe40240;
const MS_CAL_TEST_RANGE_END = 0xffe407c8;
const MS_CAL_TEST_SUM_OFFSET = 0x57dc;
const MS_CAR_CHECK_LENGTH = 0xc00; // read from the car to recognise a build: every version's code fits
const MS_CURRENT_GEN = 6;
const MS_MULTI_GEN = 4; // from this generation on: block tables, several maps
// From generation 6 on r2 stays map 1's for every map: the single values a
// map changes are switched at the instructions that load them (a stub per
// load site picks the value by map index), and the tables through the
// lookup hook as 256-byte chunks. No window, no moving r2, nothing read
// from erased flash: whatever is not switched is map 1's.
const MS_SITE_GEN = 6;
// From generation 5 on the lookup hook also takes a table pointer the program
// formed from r2 (addi r3, r2, d: nearly a thousand sites, most of them to
// blocks the window does not hold), and the windows nest.
const MS_WINDOW_POINTER_GEN = 5;

// ---- the stored maps (generation 4) --------------------------------------------------------------
const MS_BLOCK = 0x400;
const MS_BLOCK_COUNT = MAPSWITCH_CAL_LENGTH / MS_BLOCK; // 116
const MS_MAX_MAPS = 7; // three bits of selection
const MS_MIN_MAPS = 2;
const MS_HEADER = 0xdcc00; // flash offset; the block tables follow, one per map index
const MS_HEADER_MAGIC = 'MS45MAPS';
const MS_HEADER_COUNT = 0x08;
const MS_HEADER_R2 = 0x10; // + 4 * index: the r2 the program uses with that map
const MS_TABLE_STRIDE = 0x100;
const MS_TABLE_ENTRIES = MS_TABLE_STRIDE / 2;
const MS_TABLES_END = MS_HEADER + MS_TABLE_STRIDE * (MS_MAX_MAPS + 1); // 0xDD400
const MS_TABLES_LENGTH = MS_TABLES_END - MS_HEADER;
const MS_NO_BLOCK = 0xffff;
// ---- generation 6: chunks and sites ---------------------------------------------------------------
const MS_CHUNK = 0x100;
const MS_CHUNK_COUNT = MAPSWITCH_CAL_LENGTH / MS_CHUNK; // 464
const MS_CHUNK_TABLE_STRIDE = 0x400; // one chunk table per map index, after the header
const MS_CHUNK_TABLE_ENTRIES = MS_CHUNK_TABLE_STRIDE / 2;
// index 1's; index 0 is the header's own KB
const MS_CHUNK_TABLES_END =
  MS_HEADER + MS_CHUNK_TABLE_STRIDE * (MS_MAX_MAPS + 1); // 0xDEC00
const MS_TABLE_REACH = 2; // chunks a table may run on past the one its pointer is in: the largest object is 512 bytes
const MS_HEADER_LAYOUT = 0x09; // 0xFF (erased): blocks; MS_SITE_GEN: chunks and sites
const MS_HEADER_SITES_END = 0x0c; // u32: flash offset where the site area ends (chunks start there)
const MS_SITES = MS_CHUNK_TABLES_END; // the site directory and the stubs
const MS_SITES_MAGIC = 'SITE';
const MS_LOOKUP_ENTRY_17 = 0xf4fc; // a lookup the earlier generations did not hook: lhax by the saved index
const MS_LOOKUP_STOCK_17 = 0x898dd7c6;
/** Where the program's code is, for the site scan: the MPC below the free area, the external flash below the header. */
const MS_CODE = [
  ['mpc', 0, MAPSWITCH_FREE_START],
  ['flash', 0x60608, MS_HEADER],
];
/** Empty flash that may hold map blocks, [start, end) in flash offsets, 1 KB aligned. */
const MS_POOLS = [
  [MS_HEADER, 0xf8000],
  [0xfa800, 0xffc00],
];
/** The calibration blocks the program reads through r2, which every map must hold in place. */
const MS_R2_BLOCKS = [0, 1, 2, 3, 4, 5, 6, 0x12, 0x15, 0x16, 0x17];
// The upper half of the calibration (offsets 0x8000 up) is reached through
// a register set to r2 + 0x10000: addis rX, r2, 1, 781 times in this program,
// 526 loading a value straight away (the power-management module's
// constants and tables, blocks 74-82) and 255 forming a table pointer. With
// r2 moved to a map's window those would read 32 KB and more above it, where
// nothing of the map is. From generation 5 each is rewritten in place to
// lis rX, 0xFFE5, map 1's calibration + 0x10000: the values are map 1's on
// every map, and the pointers are the absolute kind the lookup hook sends
// through the block table, so the tables up there still switch.
const MS_UPPER_ADDIS = 0x3c020001; // addis rX, r2, 1
const MS_UPPER_LIS = 0x3c00ffe5; // lis rX, 0xFFE5
const MS_UPPER_INSN_MASK = 0xfc1fffff; // all but rX
const MS_UPPER_SITES = 781;
// Two readers take their table through a copy of r2 instead of the lookup
// library: the MAF and secondary-air flow linearisation tables (id_maf_tab
// and id_saf_tab, 0xB7E8-0xBBE8, which describe the sensors, not the tune).
// They are pointed at map 1 the same way: addis rX, r2, 0 -> lis rX, 0xFFE4.
const MS_SENSOR_TABLE_SITES = [
  [0x10f6c, 0x3d420000], // addis r10, r2, 0 ; addi r10, r10, 0x37F8 -> id_maf_tab
  [0x11030, 0x3d620000], // addis r11, r2, 0 ; addi r11, r11, 0x39F8 -> id_saf_tab
];
const MS_SENSOR_TABLE_LIS = 0x3c00ffe4; // lis rX, 0xFFE4
/** What every map reads from map 1, so a map that differs there is told so. */
const MS_MAP1_ONLY = [
  [
    0xb7e8,
    0xbbe8,
    'the MAF / secondary air flow linearisation tables (id_maf_tab, id_saf_tab)',
  ],
  [0x12c00, 0x14c00, "the power-management module's values (0x12C00-0x14BFF)"],
];
/** Where the program's code is: the MPC below the free area, the external flash between the header and the map area. */
const MS_UPPER_CODE = [
  ['mpc', 0, MAPSWITCH_FREE_START],
  ['flash', 0x60608, MS_HEADER],
];

// ---- a minimal PowerPC assembler: just the instructions used --------------------------
function msS16(v) {
  if (v < -0x8000 || v > 0x7fff)
    throw new Error(`signed 16-bit operand out of range: ${v}`);
  return v & 0xffff;
}
function msU16(v) {
  if (v < 0 || v > 0xffff)
    throw new Error(`unsigned 16-bit operand out of range: ${v}`);
  return v;
}
function msD(op, rt, ra, imm) {
  return ((op << 26) | (rt << 21) | (ra << 16) | imm) >>> 0;
}
const Lbz = (rt, d, ra) => msD(34, rt, ra, msS16(d));
const Lhz = (rt, d, ra) => msD(40, rt, ra, msS16(d));
const Lwz = (rt, d, ra) => msD(32, rt, ra, msS16(d));
const Stb = (rs, d, ra) => msD(38, rs, ra, msS16(d));
const Sth = (rs, d, ra) => msD(44, rs, ra, msS16(d));
const Li = (rt, v) => msD(14, rt, 0, msS16(v));
const Addi = (rt, ra, v) => msD(14, rt, ra, msS16(v));
const Addis = (rt, ra, v) => msD(15, rt, ra, msS16(v));
const Lis = (rt, v) => Addis(rt, 0, v);
const Mulli = (rt, ra, v) => msD(7, rt, ra, msS16(v));
const Cmpwi = (ra, v) => msD(11, 0, ra, msS16(v));
const Cmplwi = (ra, v) => msD(10, 0, ra, msU16(v));
const Cmpw = (ra, rb) => ((31 << 26) | (ra << 16) | (rb << 11)) >>> 0;
const AndiDot = (ra, rs, v) => msD(28, rs, ra, msU16(v));
const Ori = (ra, rs, v) => msD(24, rs, ra, msU16(v));
const Oris = (ra, rs, v) => msD(25, rs, ra, msU16(v));
const Xori = (ra, rs, v) => msD(26, rs, ra, msU16(v));
const Rlwinm = (ra, rs, sh, mb, me) =>
  ((21 << 26) |
    (rs << 21) |
    (ra << 16) |
    (sh << 11) |
    (mb << 6) |
    (me << 1)) >>>
  0;
const Srwi = (ra, rs, n) => Rlwinm(ra, rs, 32 - n, n, 31);
const Or = (ra, rs, rb) =>
  ((31 << 26) | (rs << 21) | (ra << 16) | (rb << 11) | (444 << 1)) >>> 0;
const Subf = (rt, ra, rb) =>
  // rt = rb - ra
  ((31 << 26) | (rt << 21) | (ra << 16) | (rb << 11) | (40 << 1)) >>> 0;
const MS_BLR = 0x4e800020;
/** An absolute branch: the target's low 26 bits, sign-extended by the CPU, so the top 32 MB (the external flash) and the bottom (the MPC) are both in reach. */
const Ba = (target) => ((18 << 26) | (target & 0x03fffffc) | 2) >>> 0;
const MS_BEQ = [12, 2];
const MS_BNE = [4, 2];
const MS_BLT = [12, 0];
const MS_BGE = [4, 0];
/** The high half for addis and the signed low half for a load, so that addis + load reach `address`. */
function msHa(address) {
  const lo = address & 0xffff;
  let hi = ((address >>> 16) + (lo >= 0x8000 ? 1 : 0)) & 0xffff;
  if (hi >= 0x8000) hi -= 0x10000;
  return hi;
}
function msLo(address) {
  const lo = address & 0xffff;
  return lo >= 0x8000 ? lo - 0x10000 : lo;
}

function msBranch(from, to, link) {
  const d = to - from;
  if (d < -0x2000000 || d >= 0x2000000 || d & 3)
    throw new Error('branch out of range');
  return ((18 << 26) | (d & 0x03fffffc) | (link ? 1 : 0)) >>> 0;
}

/** Two-pass assembler with local labels. */
class MsAsm {
  constructor(at) {
    this._base = at;
    this._items = [];
    this._labels = new Map();
  }
  get here() {
    return this._base + 4 * this._items.length;
  }
  label(name) {
    this._labels.set(name, this.here);
  }
  emit(word) {
    this._items.push({ word: word >>> 0 });
  }
  bc(cond, label) {
    this._items.push({ bo: cond[0], bi: cond[1], label });
  }
  b(label) {
    this._items.push({ label });
  }
  branchTo(address) {
    this._items.push({ address });
  }
  words() {
    const out = [];
    for (let i = 0; i < this._items.length; i++) {
      const pc = this._base + 4 * i;
      const it = this._items[i];
      if (it.word != null) out.push(it.word);
      else if (it.bo != null) {
        const d = this._labels.get(it.label) - pc;
        if (d < -0x8000 || d >= 0x8000)
          throw new Error('conditional branch out of range');
        out.push(
          ((16 << 26) | (it.bo << 21) | (it.bi << 16) | (d & 0xfffc)) >>> 0
        );
      } else if (it.address != null) out.push(msBranch(pc, it.address, false));
      else out.push(msBranch(pc, this._labels.get(it.label), false));
    }
    return out;
  }
}

function msRead16(data, at) {
  return ((data[at] << 8) | data[at + 1]) >>> 0;
}
function msWrite16(data, at, v) {
  data[at] = (v >>> 8) & 0xff;
  data[at + 1] = v & 0xff;
}
function msRead32(data, at) {
  return (
    ((data[at] << 24) |
      (data[at + 1] << 16) |
      (data[at + 2] << 8) |
      data[at + 3]) >>>
    0
  );
}
function msWrite32(data, at, v) {
  data[at] = (v >>> 24) & 0xff;
  data[at + 1] = (v >>> 16) & 0xff;
  data[at + 2] = (v >>> 8) & 0xff;
  data[at + 3] = v & 0xff;
}
function msOff(ram) {
  return ram - MAPSWITCH_R13;
}
function msReadAscii(data, offset, length) {
  if (!data || data.length < offset + length) return null;
  let s = '';
  for (let i = 0; i < length; i++) {
    const b = data[offset + i];
    if (b < 0x20 || b > 0x7e) return null;
    s += String.fromCharCode(b);
  }
  return s;
}
const msKb = (blocks) => `${blocks} KB`;
