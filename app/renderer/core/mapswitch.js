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
/* exported mapSwitch */

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
const MS_CHUNK_TABLES = MS_HEADER + MS_CHUNK_TABLE_STRIDE; // index 1's; index 0 is the header's own KB
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

// ---- versions ---------------------------------------------------------------------------------
/**
 * A version of the code: what triggers the switch, how the map is shown and
 * how many maps it cycles through.
 * @typedef {Object} MsVersion
 * @property {'dsc'|'shifter'|'pedals'} trigger
 * @property {'none'|'immediate'|'delayed'|'immediateLong'} startup
 * @property {'car'|'first'} watch
 * @property {'mapsOnly'|'fullTune'} scope
 * @property {number} presses
 * @property {boolean} whileRunning
 * @property {number} gen
 * @property {number} maps - Maps in all, map 1 included (2 before generation 4).
 */
function msVersion(
  trigger,
  startup,
  watch = 'car',
  scope = 'mapsOnly',
  presses = MS_DEFAULT_DSC_PRESSES,
  whileRunning = false,
  gen = 0,
  maps = 2
) {
  return {
    trigger,
    startup,
    watch: trigger === 'dsc' ? watch : 'car',
    scope,
    presses: trigger === 'dsc' ? presses : 0,
    whileRunning: trigger !== 'pedals' && whileRunning,
    gen,
    maps: gen >= MS_MULTI_GEN ? maps : 2,
  };
}
function msVersionEq(a, b) {
  return (
    a.trigger === b.trigger &&
    a.startup === b.startup &&
    a.watch === b.watch &&
    a.scope === b.scope &&
    a.presses === b.presses &&
    a.whileRunning === b.whileRunning &&
    a.gen === b.gen &&
    a.maps === b.maps
  );
}
const msLampHook = (v) => v.whileRunning && v.gen >= 3;
const msLockout = (v) => v.trigger === 'dsc' && v.gen >= 3;
const msCounterByte = (v) => v.trigger !== 'pedals';
const msMulti = (v) => v.gen >= MS_MULTI_GEN;
function msCurrentVersion(
  trigger,
  presses = MS_DEFAULT_DSC_PRESSES,
  maps = MS_MIN_MAPS
) {
  return msVersion(
    trigger,
    'immediateLong',
    'car',
    'fullTune',
    presses,
    true,
    MS_CURRENT_GEN,
    maps
  );
}
function msIsCurrent(v) {
  return (
    msVersionEq(v, msCurrentVersion(v.trigger, v.presses, v.maps)) &&
    (v.trigger !== 'dsc' || MS_DSC_PRESS_CHOICES.includes(v.presses)) &&
    v.maps >= MS_MIN_MAPS &&
    v.maps <= MS_MAX_MAPS
  );
}
const MS_KNOWN_VERSIONS = [];
for (let maps = MS_MIN_MAPS; maps <= MS_MAX_MAPS; maps++) {
  MS_KNOWN_VERSIONS.push(
    msCurrentVersion('dsc', 4, maps),
    msCurrentVersion('dsc', 2, maps),
    msCurrentVersion('shifter', 0, maps),
    msCurrentVersion('pedals', 0, maps)
  );
}
for (let maps = MS_MIN_MAPS; maps <= MS_MAX_MAPS; maps++) {
  MS_KNOWN_VERSIONS.push(
    msVersion('dsc', 'immediateLong', 'car', 'fullTune', 4, true, 5, maps),
    msVersion('dsc', 'immediateLong', 'car', 'fullTune', 2, true, 5, maps),
    msVersion('shifter', 'immediateLong', 'car', 'fullTune', 0, true, 5, maps),
    msVersion('pedals', 'immediateLong', 'car', 'fullTune', 0, true, 5, maps),
    msVersion('dsc', 'immediateLong', 'car', 'fullTune', 4, true, 4, maps),
    msVersion('dsc', 'immediateLong', 'car', 'fullTune', 2, true, 4, maps),
    msVersion('shifter', 'immediateLong', 'car', 'fullTune', 0, true, 4, maps),
    msVersion('pedals', 'immediateLong', 'car', 'fullTune', 0, true, 4, maps)
  );
}
MS_KNOWN_VERSIONS.push(
  msVersion('dsc', 'immediateLong', 'car', 'fullTune', 4, true, 3),
  msVersion('dsc', 'immediateLong', 'car', 'fullTune', 2, true, 3),
  msVersion('shifter', 'immediateLong', 'car', 'fullTune', 0, true, 3),
  msVersion('pedals', 'immediateLong', 'car', 'fullTune', 0, true, 3),
  msVersion('pedals', 'immediateLong', 'car', 'fullTune'),
  msVersion('dsc', 'immediateLong', 'car', 'fullTune', 4),
  msVersion('dsc', 'immediateLong', 'car', 'fullTune', 2),
  msVersion('dsc', 'immediateLong', 'car', 'mapsOnly'),
  msVersion('pedals', 'immediateLong', 'car', 'mapsOnly'),
  msVersion('dsc', 'immediateLong', 'first'),
  msVersion('pedals', 'immediate'),
  msVersion('pedals', 'none'),
  msVersion('pedals', 'delayed')
);

// ---- the code -----------------------------------------------------------------------------------
/**
 * The hook at a lookup routine's entry. r3 is the table pointer; r0 and the
 * register the stock first instruction loads are free. Generation 4 looks the
 * block up: table entry = flash offset >> 10 of the stored block, 0xFFFF for
 * "map 1's". Generation 5 also takes a pointer the program formed from r2,
 * which with a map other than map 1 selected is an offset into that map's
 * window: the block is looked up the same way, and one the map does not
 * store is read from map 1 (the window holds only the r2 blocks).
 */
function msLookupStub(at, entry, stockInsn, version) {
  const a = new MsAsm(at);
  if (!msMulti(version)) {
    a.emit(Lbz(0, msOff(MS_RAM_FLAG), 13));
    a.emit(AndiDot(0, 0, 1));
    a.bc(MS_BEQ, 'run');
    a.emit(Srwi(0, 3, 17));
    a.emit(Cmplwi(0, MS_CALIBRATION_RANGE_TAG));
    a.bc(MS_BNE, 'run');
    a.emit(Addis(3, 3, MS_MAP2_DELTA_HIGH));
  } else if (version.gen >= MS_SITE_GEN) {
    // pointers are always into map 1's calibration (r2 never moves); the
    // chunk table of the selected map says where the 256-byte chunk lives
    const t = (stockInsn >>> 21) & 31;
    const tables = MAPSWITCH_EXT + MS_HEADER;
    a.emit(Lbz(t, msOff(MS_RAM_FLAG), 13));
    a.emit(AndiDot(t, t, MS_FLAG_INDEX_MASK));
    a.bc(MS_BEQ, 'run');
    a.emit(Srwi(0, 3, 17));
    a.emit(Cmplwi(0, MS_CALIBRATION_RANGE_TAG));
    a.bc(MS_BNE, 'run');
    a.emit(Rlwinm(t, t, 10 - MS_FLAG_INDEX_SHIFT, 19, 21)); // index << 10: the map's chunk table
    a.emit(Rlwinm(0, 3, 32 - 7, 22, 30)); // (chunk number) << 1, the entry in it
    a.emit(Or(t, t, 0));
    a.emit(Addis(t, t, msHa(tables)));
    a.emit(Lhz(t, msLo(tables), t));
    a.emit(Cmplwi(t, MS_NO_BLOCK));
    a.bc(MS_BEQ, 'run');
    a.emit(Rlwinm(t, t, 8, 8, 23)); // the chunk's flash offset
    a.emit(Rlwinm(0, 3, 0, 24, 31)); // the offset within the chunk
    a.emit(Or(t, t, 0));
    a.emit(Oris(3, t, MAPSWITCH_EXT >>> 16));
  } else if (version.gen < MS_WINDOW_POINTER_GEN) {
    const t = (stockInsn >>> 21) & 31;
    const tables = MAPSWITCH_EXT + MS_HEADER;
    a.emit(Lbz(t, msOff(MS_RAM_FLAG), 13));
    a.emit(AndiDot(t, t, MS_FLAG_INDEX_MASK));
    a.bc(MS_BEQ, 'run');
    a.emit(Srwi(0, 3, 17));
    a.emit(Cmplwi(0, MS_CALIBRATION_RANGE_TAG));
    a.bc(MS_BNE, 'run');
    a.emit(Rlwinm(t, t, 8 - MS_FLAG_INDEX_SHIFT, 16, 23)); // index << 8: the map's table
    a.emit(Rlwinm(0, 3, 32 - 9, 24, 30)); // (block number) << 1, the entry in it
    a.emit(Or(t, t, 0));
    a.emit(Addis(t, t, msHa(tables)));
    a.emit(Lhz(t, msLo(tables), t));
    a.emit(Cmplwi(t, MS_NO_BLOCK));
    a.bc(MS_BEQ, 'run');
    a.emit(Rlwinm(t, t, 10, 6, 21)); // the block's flash offset
    a.emit(Rlwinm(0, 3, 0, 22, 31)); // the offset within the block
    a.emit(Or(t, t, 0));
    a.emit(Oris(3, t, MAPSWITCH_EXT >>> 16));
  } else {
    const t = (stockInsn >>> 21) & 31;
    const tables = MAPSWITCH_EXT + MS_HEADER;
    const lookup = () => {
      // r0 = the block number. t <- the table entry for it in the selected
      // map's table (r0 is not addi's base, as that reads as zero)
      a.emit(Lbz(t, msOff(MS_RAM_FLAG), 13));
      a.emit(Rlwinm(t, t, 8 - MS_FLAG_INDEX_SHIFT, 17, 23)); // index << 8: the map's table
      a.emit(Rlwinm(0, 0, 1, 24, 30)); // block << 1, the entry in it
      a.emit(Or(t, t, 0));
      a.emit(Addis(t, t, msHa(tables)));
      a.emit(Lhz(t, msLo(tables), t));
      a.emit(Cmplwi(t, MS_NO_BLOCK));
    };
    a.emit(Lbz(t, msOff(MS_RAM_FLAG), 13));
    a.emit(AndiDot(t, t, MS_FLAG_INDEX_MASK));
    a.bc(MS_BEQ, 'run');
    // a pointer into the selected map's window: r3 - (r2 - 0x7FF0) is its
    // offset in the calibration, and below 116 once shifted to a block
    // number only if it is one
    a.emit(Subf(t, 2, 3));
    a.emit(Addi(t, t, MS_R2_LOW));
    a.emit(Srwi(0, t, 10));
    a.emit(Cmplwi(0, MS_BLOCK_COUNT));
    a.bc(MS_BLT, 'window');
    // else a pointer into map 1's calibration at 0xFFE40000, or none
    a.emit(Addis(0, 3, (0x10000 - (MS_CALIBRATION_BASE >>> 16)) & 0xffff));
    a.emit(Srwi(0, 0, 10));
    a.emit(Cmplwi(0, MS_BLOCK_COUNT));
    a.bc(MS_BGE, 'run');
    lookup();
    a.bc(MS_BEQ, 'run'); // not stored: map 1's, where r3 points
    a.b('redirect');
    a.label('window');
    lookup();
    a.bc(MS_BNE, 'redirect');
    // not stored: the same offset in map 1, r3 - r2 + 0xFFE47FF0
    a.emit(Subf(3, 2, 3));
    a.emit(Addis(3, 3, MS_R2_HIGH));
    a.emit(Addi(3, 3, MS_R2_LOW));
    a.b('run');
    a.label('redirect');
    a.emit(Rlwinm(t, t, 10, 6, 21)); // the block's flash offset
    a.emit(Rlwinm(0, 3, 0, 22, 31)); // the offset within the block
    a.emit(Or(t, t, 0));
    a.emit(Oris(3, t, MAPSWITCH_EXT >>> 16));
  }
  a.label('run');
  a.emit(stockInsn);
  a.branchTo(entry + 4);
  return a;
}

/**
 * Set r2 for the selected map, read from the flag in `flagReg`. Generation 4
 * takes it from the header, clobbering `tmpReg`.
 */
function msEmitBaseRegister(a, flagReg, scope, label, version, tmpReg = 12) {
  if (scope !== 'fullTune') return;
  if (version && msMulti(version)) {
    const r2s = MAPSWITCH_EXT + MS_HEADER + MS_HEADER_R2;
    a.emit(Rlwinm(tmpReg, flagReg, 32 - (MS_FLAG_INDEX_SHIFT - 2), 27, 29)); // index * 4
    a.emit(Addis(tmpReg, tmpReg, msHa(r2s)));
    a.emit(Lwz(2, msLo(r2s), tmpReg));
    return;
  }
  a.emit(Lis(2, MS_R2_HIGH));
  a.emit(Ori(2, 2, MS_R2_LOW));
  a.emit(AndiDot(0, flagReg, 1));
  a.bc(MS_BEQ, label);
  a.emit(Addis(2, 2, MS_MAP2_DELTA_HIGH));
  a.label(label);
}
function msEmitBaseRegisterMap1(a, scope) {
  if (scope !== 'fullTune') return;
  a.emit(Lis(2, MS_R2_HIGH));
  a.emit(Ori(2, 2, MS_R2_LOW));
}

/** r11 = the flag with the next map selected (r12 clobbered); earlier generations toggle bit 0. */
function msEmitNextMap(a, version, label) {
  if (!msMulti(version)) {
    a.emit(Xori(11, 11, 1));
    return;
  }
  a.emit(AndiDot(12, 11, MS_FLAG_INDEX_MASK));
  a.emit(Addi(12, 12, 1 << MS_FLAG_INDEX_SHIFT));
  a.emit(Cmplwi(12, version.maps << MS_FLAG_INDEX_SHIFT));
  a.bc(MS_BLT, label);
  a.emit(Li(12, 0));
  a.label(label);
  a.emit(AndiDot(11, 11, 0xff & ~MS_FLAG_INDEX_MASK));
  a.emit(Or(11, 11, 12));
}

/** Show the map just chosen (r11): on the tach, or by the lamp when the engine runs. */
function msEmitAnnounce(a, indicate, whileRunning, version) {
  if (whileRunning) {
    a.emit(Lhz(12, MS_VAR_ENGINE_SPEED, 13));
    a.emit(Cmpwi(12, 0));
    a.bc(MS_BNE, 'blink');
    indicate(11);
    a.b('show');
    a.label('blink');
    if (msMulti(version))
      a.emit(Rlwinm(12, 11, 32 - MS_FLAG_INDEX_SHIFT, 29, 31));
    else a.emit(AndiDot(12, 11, 1));
    a.emit(Addi(12, 12, 1));
    a.emit(Stb(12, msOff(MS_RAM_BLINKS), 13));
    a.emit(Li(12, 0));
    a.emit(Stb(12, msOff(MS_RAM_BLINK_PHASE), 13));
    a.b('show');
  } else {
    indicate(11);
    a.b('show');
  }
}

function msEmitDscGesture(a, flag, count, indicate, version) {
  const { watch, scope, whileRunning } = version;
  const pressesToToggle = version.presses;
  const lockout = msLockout(version);
  const presses = msOff(MS_RAM_PRESS_COUNTER);
  const state = watch === 'car' ? MS_VAR_DSC_STATE : MS_FIRST_VAR_DSC_STATE;
  const mask = watch === 'car' ? MS_DSC_STATE_MASK : MS_FIRST_DSC_STATE_MASK;
  a.emit(Lbz(12, state, 13));
  a.emit(AndiDot(12, 12, mask));
  a.emit(Lbz(11, flag, 13));
  if (lockout) {
    const locked = msOff(MS_RAM_STARTUP_LOCKOUT);
    a.emit(Lhz(10, locked, 13));
    a.emit(Cmpwi(10, 0));
    a.bc(MS_BEQ, 'armed');
    a.emit(Addi(10, 10, -1));
    a.emit(Sth(10, locked, 13));
    a.emit(AndiDot(11, 11, 0xffff & ~mask));
    a.emit(Or(11, 11, 12));
    a.emit(Stb(11, flag, 13));
    a.b('show');
    a.label('armed');
  }
  a.emit(AndiDot(10, 11, mask));
  a.emit(Cmpw(12, 10));
  a.bc(MS_BEQ, 'steady');
  a.emit(AndiDot(11, 11, 0xffff & ~mask));
  a.emit(Or(11, 11, 12));
  a.emit(Stb(11, flag, 13));
  a.emit(Lbz(12, presses, 13));
  a.emit(Addi(12, 12, 1));
  a.emit(Stb(12, presses, 13));
  a.emit(Li(10, MS_DSC_PRESS_WINDOW_CALLS));
  a.emit(Sth(10, count, 13));
  a.emit(Cmplwi(12, pressesToToggle));
  a.bc(MS_BLT, 'show');
  msEmitNextMap(a, version, 'next');
  a.emit(Stb(11, flag, 13));
  msEmitBaseRegister(a, 11, scope, 'base', version);
  a.emit(Li(12, 0));
  a.emit(Sth(12, count, 13));
  a.emit(Stb(12, presses, 13));
  a.emit(Li(12, 1));
  a.emit(Stb(12, MS_NV_SAVE_REQUEST, 13));
  msEmitAnnounce(a, indicate, whileRunning, version);
  a.label('steady');
  a.emit(Lhz(12, count, 13));
  a.emit(Cmpwi(12, 0));
  a.bc(MS_BEQ, 'show');
  a.emit(Addi(12, 12, -1));
  a.emit(Sth(12, count, 13));
  a.emit(Cmpwi(12, 0));
  a.bc(MS_BNE, 'show');
  a.emit(Stb(12, presses, 13));
}

/**
 * The lever moved out of D into the S/M gate and back, or out of the gate
 * and back in, within the window: two changes of side. Anything that is not
 * a forward gear with a known program symbol (P, R, N, the frame timed out)
 * forgets where the lever was, so going through the positions counts nothing.
 */
function msEmitShifterGesture(a, flag, count, indicate, version) {
  const { scope, whileRunning } = version;
  const lever = msOff(MS_RAM_LEVER);
  a.emit(Lbz(12, MS_VAR_EGS1_GEAR, 13));
  a.emit(AndiDot(12, 12, MS_EGS1_GEAR_MASK));
  a.bc(MS_BEQ, 'away');
  a.emit(Cmplwi(12, MS_EGS1_GEAR_REVERSE));
  a.bc(MS_BEQ, 'away');
  a.emit(Lbz(12, MS_VAR_EGS1_PROGRAM, 13));
  a.emit(Srwi(12, 12, MS_EGS1_PROGRAM_SHIFT));
  a.emit(Li(10, MS_LEVER_IN_GATE));
  a.emit(Cmplwi(12, MS_EGS1_PROGRAM_SPORT));
  a.bc(MS_BEQ, 'known');
  a.emit(Cmplwi(12, MS_EGS1_PROGRAM_MANUAL));
  a.bc(MS_BEQ, 'known');
  a.emit(Li(10, MS_LEVER_IN_DRIVE));
  a.emit(Cmplwi(12, MS_EGS1_PROGRAM_DRIVE));
  a.bc(MS_BEQ, 'known');
  a.emit(Cmplwi(12, MS_EGS1_PROGRAM_DRIVE_GEAR_DISPLAY));
  a.bc(MS_BNE, 'away');
  a.label('known');
  a.emit(Lbz(12, lever, 13));
  a.emit(Stb(10, lever, 13));
  a.emit(Cmpwi(12, 0));
  a.bc(MS_BEQ, 'steady');
  a.emit(Cmpw(12, 10));
  a.bc(MS_BEQ, 'steady');
  a.emit(Lhz(12, count, 13));
  a.emit(Cmpwi(12, 0));
  a.bc(MS_BNE, 'back');
  a.emit(Li(12, MS_SHIFTER_WINDOW_CALLS));
  a.emit(Sth(12, count, 13));
  a.b('show');
  a.label('back');
  a.emit(Lbz(11, flag, 13));
  msEmitNextMap(a, version, 'next');
  a.emit(Stb(11, flag, 13));
  msEmitBaseRegister(a, 11, scope, 'base', version);
  a.emit(Li(12, 0));
  a.emit(Sth(12, count, 13));
  a.emit(Li(12, 1));
  a.emit(Stb(12, MS_NV_SAVE_REQUEST, 13));
  msEmitAnnounce(a, indicate, whileRunning, version);
  a.label('away');
  a.emit(Li(12, 0));
  a.emit(Stb(12, lever, 13));
  a.emit(Sth(12, count, 13));
  a.b('show');
  a.label('steady');
  a.emit(Lhz(12, count, 13));
  a.emit(Cmpwi(12, 0));
  a.bc(MS_BEQ, 'show');
  a.emit(Addi(12, 12, -1));
  a.emit(Sth(12, count, 13));
}

function msEmitPedalGesture(a, flag, count, indicate, version) {
  const { scope } = version;
  const mapBits = msMulti(version) ? MS_FLAG_INDEX_MASK : 1;
  a.emit(Lbz(12, MS_VAR_BRAKE_A, 13));
  a.emit(Cmpwi(12, 0));
  a.bc(MS_BEQ, 'idle');
  a.emit(Lbz(12, MS_VAR_BRAKE_B, 13));
  a.emit(Cmpwi(12, 0));
  a.bc(MS_BEQ, 'idle');
  a.emit(Lbz(12, MS_VAR_PEDAL, 13));
  a.emit(Cmplwi(12, MS_PEDAL_FULL));
  a.bc(MS_BLT, 'idle');
  a.emit(Lbz(11, flag, 13));
  a.emit(AndiDot(0, 11, MS_FLAG_LATCH));
  a.bc(MS_BNE, 'show');
  a.emit(Lhz(12, count, 13));
  a.emit(Addi(12, 12, 1));
  a.emit(Sth(12, count, 13));
  a.emit(Cmplwi(12, MS_HOLD_CALLS));
  a.bc(MS_BLT, 'show');
  msEmitNextMap(a, version, 'next');
  a.emit(Ori(11, 11, MS_FLAG_LATCH));
  a.emit(Stb(11, flag, 13));
  msEmitBaseRegister(a, 11, scope, 'base', version);
  a.emit(Li(12, 0));
  a.emit(Sth(12, count, 13));
  a.emit(Li(12, 1));
  a.emit(Stb(12, MS_NV_SAVE_REQUEST, 13));
  indicate(11);
  a.b('show');
  a.label('idle');
  a.emit(Li(12, 0));
  a.emit(Sth(12, count, 13));
  a.emit(Lbz(12, MS_VAR_PEDAL, 13));
  a.emit(Cmplwi(12, MS_PEDAL_RELEASED));
  a.bc(MS_BGE, 'show');
  a.emit(Lbz(11, flag, 13));
  a.emit(AndiDot(11, 11, mapBits));
  a.emit(Stb(11, flag, 13));
}

function msTachStub(at, version) {
  const flag = msOff(MS_RAM_FLAG);
  const count = msOff(MS_RAM_HOLD_COUNTER);
  const delay = msOff(MS_RAM_STARTUP_DELAY);
  const delayed = version.startup === 'delayed';
  const wide = version.startup === 'immediateLong';
  const disp = msOff(
    wide ? MS_RAM_WIDE_DISPLAY_COUNTER : MS_RAM_DISPLAY_COUNTER
  );
  const loadDisp = wide ? Lhz : Lbz;
  const storeDisp = wide ? Sth : Stb;
  const a = new MsAsm(at);
  const indicate = () => {
    a.emit(Li(12, MS_DISPLAY_CALLS));
    a.emit(storeDisp(12, disp, 13));
  };
  if (!version.whileRunning) {
    a.emit(Lhz(12, MS_VAR_ENGINE_SPEED, 13));
    a.emit(Cmpwi(12, 0));
    a.bc(MS_BNE, 'running');
    a.emit(Lbz(12, MS_VAR_VEHICLE_SPEED, 13));
    a.emit(Cmpwi(12, 0));
    a.bc(MS_BNE, 'running');
  }
  if (delayed) {
    a.emit(Lhz(12, delay, 13));
    a.emit(Cmpwi(12, 0));
    a.bc(MS_BEQ, 'gesture');
    a.emit(Addi(12, 12, -1));
    a.emit(Sth(12, delay, 13));
    a.emit(Cmpwi(12, 0));
    a.bc(MS_BNE, 'gesture');
    a.emit(Li(12, MS_DISPLAY_CALLS));
    a.emit(storeDisp(12, disp, 13));
    a.label('gesture');
  }
  if (version.trigger === 'dsc')
    msEmitDscGesture(a, flag, count, indicate, version);
  else if (version.trigger === 'shifter')
    msEmitShifterGesture(a, flag, count, indicate, version);
  else msEmitPedalGesture(a, flag, count, indicate, version);
  a.label('show');
  a.emit(loadDisp(12, disp, 13));
  a.emit(Cmpwi(12, 0));
  a.bc(MS_BEQ, 'store');
  a.emit(Addi(12, 12, -1));
  a.emit(storeDisp(12, disp, 13));
  if (version.whileRunning) {
    a.emit(Lhz(12, MS_VAR_ENGINE_SPEED, 13));
    a.emit(Cmpwi(12, 0));
    a.bc(MS_BNE, 'store');
  }
  a.emit(Lbz(11, flag, 13));
  if (msMulti(version)) {
    // 1000 rpm times the map number
    a.emit(Rlwinm(11, 11, 32 - MS_FLAG_INDEX_SHIFT, 29, 31));
    a.emit(Addi(11, 11, 1));
    a.emit(Mulli(3, 11, MS_TACH_1000));
    a.b('store');
  } else {
    a.emit(AndiDot(11, 11, 1));
    a.emit(Li(3, MS_TACH_1000));
    a.bc(MS_BEQ, 'store');
    a.emit(Li(3, MS_TACH_2000));
    a.b('store');
  }
  if (!version.whileRunning) {
    a.label('running');
    a.emit(Li(12, 0));
    a.emit(Sth(12, count, 13));
    a.emit(storeDisp(12, disp, 13));
    if (msCounterByte(version))
      a.emit(Stb(12, msOff(MS_RAM_PRESS_COUNTER), 13));
    if (delayed) a.emit(Sth(12, delay, 13));
  }
  a.label('store');
  a.emit(Sth(3, MS_TACH_VAR, 13));
  a.emit(MS_BLR);
  return a;
}

function msMilStub(at) {
  const blinks = msOff(MS_RAM_BLINKS);
  const phase = msOff(MS_RAM_BLINK_PHASE);
  const a = new MsAsm(at);
  a.emit(MS_MIL_STORE_INSN);
  a.emit(Lbz(10, blinks, 13));
  a.emit(Cmpwi(10, 0));
  a.bc(MS_BEQ, 'done');
  a.emit(Lbz(12, phase, 13));
  a.emit(Addi(12, 12, 1));
  a.emit(Stb(12, phase, 13));
  a.emit(Cmplwi(12, MS_BLINK_ON_CALLS));
  a.bc(MS_BGE, 'off');
  a.emit(Lbz(0, MS_MIL_BYTE, 13));
  a.emit(Ori(0, 0, MS_MIL_BIT));
  a.emit(Stb(0, MS_MIL_BYTE, 13));
  a.b('done');
  a.label('off');
  a.emit(Lbz(0, MS_MIL_BYTE, 13));
  a.emit(Rlwinm(0, 0, 0, 31, 29));
  a.emit(Stb(0, MS_MIL_BYTE, 13));
  a.emit(Cmplwi(12, MS_BLINK_PERIOD_CALLS));
  a.bc(MS_BLT, 'done');
  a.emit(Li(12, 0));
  a.emit(Stb(12, phase, 13));
  a.emit(Addi(10, 10, -1));
  a.emit(Stb(10, blinks, 13));
  a.label('done');
  a.emit(MS_BLR);
  return a;
}

function msEmitStartup(a, zeroRegister, startup) {
  switch (startup) {
    case 'immediateLong':
      a.emit(Li(zeroRegister, MS_STARTUP_DISPLAY_CALLS));
      a.emit(Sth(zeroRegister, msOff(MS_RAM_WIDE_DISPLAY_COUNTER), 13));
      break;
    case 'immediate':
      a.emit(Li(zeroRegister, MS_DISPLAY_CALLS));
      a.emit(Stb(zeroRegister, msOff(MS_RAM_DISPLAY_COUNTER), 13));
      break;
    case 'none':
      a.emit(Stb(zeroRegister, msOff(MS_RAM_DISPLAY_COUNTER), 13));
      break;
    case 'delayed':
      a.emit(Stb(zeroRegister, msOff(MS_RAM_DISPLAY_COUNTER), 13));
      a.emit(Li(zeroRegister, MS_STARTUP_DELAY_CALLS));
      a.emit(Sth(zeroRegister, msOff(MS_RAM_STARTUP_DELAY), 13));
      break;
    default:
      break;
  }
}

function msNvInit(at, version) {
  const a = new MsAsm(at);
  a.emit(Li(12, 0));
  a.emit(Stb(12, MS_NV_VAR, 13));
  a.emit(Stb(12, msOff(MS_RAM_FLAG), 13));
  a.emit(Sth(12, msOff(MS_RAM_HOLD_COUNTER), 13));
  if (msCounterByte(version)) a.emit(Stb(12, msOff(MS_RAM_PRESS_COUNTER), 13));
  if (version.whileRunning) {
    a.emit(Stb(12, msOff(MS_RAM_BLINKS), 13));
    a.emit(Stb(12, msOff(MS_RAM_BLINK_PHASE), 13));
  }
  if (msLockout(version)) {
    a.emit(Li(12, MS_STARTUP_LOCKOUT_CALLS));
    a.emit(Sth(12, msOff(MS_RAM_STARTUP_LOCKOUT), 13));
    a.emit(Li(12, 0));
  }
  if (msMulti(version)) msEmitBaseRegisterMap1(a, version.scope);
  else msEmitBaseRegister(a, 12, version.scope, 'base', version);
  if (version.gen === 0) msEmitStartup(a, 12, version.startup);
  a.emit(MS_BLR);
  return a;
}

function msNvRestore(at, version) {
  const a = new MsAsm(at);
  a.emit(Lbz(12, 0, 3));
  if (msMulti(version)) {
    // the index from bits 5-7, into bits 4-6 of the flag; a stored index
    // beyond this build's maps (an earlier build, or more maps before) is map 1
    a.emit(
      Rlwinm(11, 12, 32 - (MS_NV_INDEX_SHIFT - MS_FLAG_INDEX_SHIFT), 25, 27)
    );
    a.emit(Cmplwi(11, version.maps << MS_FLAG_INDEX_SHIFT));
    a.bc(MS_BLT, 'known');
    a.emit(Li(11, 0));
    a.label('known');
    a.emit(Stb(11, msOff(MS_RAM_FLAG), 13));
    a.emit(AndiDot(12, 12, MS_NV_STOCK_MASK));
    a.emit(Stb(12, MS_NV_VAR, 13));
  } else {
    a.emit(Srwi(11, 12, 7));
    a.emit(Stb(11, msOff(MS_RAM_FLAG), 13));
    a.emit(AndiDot(12, 12, 0x7f));
    a.emit(Stb(12, MS_NV_VAR, 13));
  }
  msEmitBaseRegister(a, 11, version.scope, 'base', version);
  a.emit(Li(11, 0));
  a.emit(Sth(11, msOff(MS_RAM_HOLD_COUNTER), 13));
  if (msCounterByte(version)) a.emit(Stb(11, msOff(MS_RAM_PRESS_COUNTER), 13));
  if (version.whileRunning) {
    a.emit(Stb(11, msOff(MS_RAM_BLINKS), 13));
    a.emit(Stb(11, msOff(MS_RAM_BLINK_PHASE), 13));
  }
  if (msLockout(version)) {
    a.emit(Li(11, MS_STARTUP_LOCKOUT_CALLS));
    a.emit(Sth(11, msOff(MS_RAM_STARTUP_LOCKOUT), 13));
    a.emit(Li(11, 0));
  }
  msEmitStartup(a, 11, version.startup);
  a.emit(MS_BLR);
  return a;
}

function msNvSave(at, version) {
  const a = new MsAsm(at);
  a.emit(Lbz(12, MS_NV_VAR, 13));
  a.emit(Lbz(11, msOff(MS_RAM_FLAG), 13));
  if (msMulti(version)) {
    a.emit(AndiDot(12, 12, MS_NV_STOCK_MASK));
    a.emit(Rlwinm(11, 11, MS_NV_INDEX_SHIFT - MS_FLAG_INDEX_SHIFT, 24, 26));
  } else a.emit(Rlwinm(11, 11, 7, 24, 24));
  a.emit(Or(12, 12, 11));
  a.emit(Stb(12, 0, 3));
  a.emit(MS_BLR);
  return a;
}

/**
 * Assemble everything that goes into the MPC free area, and where each piece landed.
 * @param {MsVersion} version - The version.
 * @returns {{code: Uint8Array, lookupStubs: number[], tachStub: number, runStub: number, nvStubs: number[]}}
 */
/** The lookup routines a version hooks, with their stock first instructions. */
function msEntriesFor(version) {
  const entries = MS_LOOKUP_ENTRIES.slice();
  const stock = MS_LOOKUP_STOCK.slice();
  if (version.gen >= MS_SITE_GEN) {
    entries.push(MS_LOOKUP_ENTRY_17);
    stock.push(MS_LOOKUP_STOCK_17);
  }
  return { entries, stock };
}

function msBuildCode(version) {
  const all = [];
  const here = () => MAPSWITCH_FREE_START + 4 * all.length;
  const lookupStubs = [];
  const { entries, stock } = msEntriesFor(version);
  for (let i = 0; i < entries.length; i++) {
    lookupStubs.push(here());
    all.push(...msLookupStub(here(), entries[i], stock[i], version).words());
  }
  const tachStub = here();
  all.push(...msTachStub(here(), version).words());
  let runStub = 0;
  if (msLampHook(version)) {
    runStub = here();
    all.push(...msMilStub(here()).words());
  }
  const nvStubs = [];
  nvStubs.push(here());
  all.push(...msNvInit(here(), version).words());
  nvStubs.push(here());
  all.push(...msNvRestore(here(), version).words());
  nvStubs.push(here());
  all.push(...msNvSave(here(), version).words());
  const code = new Uint8Array(4 * all.length);
  for (let i = 0; i < all.length; i++) msWrite32(code, 4 * i, all[i]);
  if (MAPSWITCH_FREE_START + code.length > MAPSWITCH_FREE_END)
    throw new Error('map switch code does not fit in the MPC free area');
  return { code, lookupStubs, tachStub, runStub, nvStubs, entries };
}

// ---- inspection ---------------------------------------------------------------------------------
function msCarriesVersion(mpc, version) {
  if (!mpc || mpc.length !== MAPSWITCH_MPC_LENGTH) return false;
  const built = msBuildCode(version);
  for (let i = 0; i < built.code.length; i++)
    if (mpc[MAPSWITCH_FREE_START + i] !== built.code[i]) return false;
  for (
    let i = MAPSWITCH_FREE_START + built.code.length;
    i < MAPSWITCH_FREE_END;
    i++
  )
    if (mpc[i] !== 0xff) return false;
  for (let i = 0; i < built.entries.length; i++) {
    if (
      msRead32(mpc, built.entries[i]) !==
      msBranch(built.entries[i], built.lookupStubs[i], false)
    )
      return false;
  }
  if (
    msRead32(mpc, MS_TACH_STORE_ADDR) !==
    msBranch(MS_TACH_STORE_ADDR, built.tachStub, true)
  )
    return false;
  const milExpected = msLampHook(version)
    ? msBranch(MS_MIL_STORE_ADDR, built.runStub, true)
    : MS_MIL_STORE_INSN;
  if (msRead32(mpc, MS_MIL_STORE_ADDR) !== milExpected) return false;
  if (msRead32(mpc, MS_ECON_STORE_ADDR) !== MS_ECON_STORE_INSN) return false;
  for (let i = 0; i < 3; i++)
    if (msRead32(mpc, MS_NV_DESCRIPTOR + 4 * i) !== built.nvStubs[i])
      return false;
  return true;
}

function msVersionOf(mpc) {
  for (const v of MS_KNOWN_VERSIONS) if (msCarriesVersion(mpc, v)) return v;
  return null;
}

function msBranchesIntoFreeArea(mpc, at, link) {
  const insn = msRead32(mpc, at);
  if ((insn & 0xfc000003) >>> 0 !== (link ? 0x48000001 : 0x48000000))
    return false;
  let offset = insn & 0x03fffffc;
  if (offset & 0x02000000) offset -= 0x04000000;
  const target = at + offset;
  return target >= MAPSWITCH_FREE_START && target < MAPSWITCH_FREE_END;
}

/**
 * Whether the free area begins with this module's lookup stubs, which every
 * build of a generation shares.
 */
function msLooksLikeOurCode(freeArea) {
  for (const sample of [
    msCurrentVersion('dsc'),
    msVersion('dsc', 'immediateLong', 'car', 'fullTune', 4, true, 5),
    msVersion('dsc', 'immediateLong', 'car', 'fullTune', 4, true, 4),
    msVersion('dsc', 'immediateLong', 'car', 'fullTune', 4, true, 3),
  ]) {
    const built = msBuildCode(sample);
    const lookupBytes = built.tachStub - MAPSWITCH_FREE_START;
    if (freeArea.length < lookupBytes) continue;
    let same = true;
    for (let i = 0; i < lookupBytes && same; i++)
      if (freeArea[i] !== built.code[i]) same = false;
    if (same) return true;
  }
  return false;
}

function msCarriesSomeBuild(mpc) {
  if (!mpc || mpc.length !== MAPSWITCH_MPC_LENGTH) return false;
  if (
    !msLooksLikeOurCode(
      mpc.subarray(
        MAPSWITCH_FREE_START,
        MAPSWITCH_FREE_START + MS_CAR_CHECK_LENGTH
      )
    )
  )
    return false;
  for (const e of MS_LOOKUP_ENTRIES)
    if (!msBranchesIntoFreeArea(mpc, e, false)) return false;
  if (!msBranchesIntoFreeArea(mpc, MS_TACH_STORE_ADDR, true)) return false;
  if (
    msRead32(mpc, MS_MIL_STORE_ADDR) !== MS_MIL_STORE_INSN &&
    !msBranchesIntoFreeArea(mpc, MS_MIL_STORE_ADDR, true)
  )
    return false;
  if (
    msRead32(mpc, MS_ECON_STORE_ADDR) !== MS_ECON_STORE_INSN &&
    !msBranchesIntoFreeArea(mpc, MS_ECON_STORE_ADDR, true)
  )
    return false;
  for (let i = 0; i < 3; i++) {
    const fn = msRead32(mpc, MS_NV_DESCRIPTOR + 4 * i);
    if (fn < MAPSWITCH_FREE_START || fn >= MAPSWITCH_FREE_END) return false;
  }
  return true;
}

function msFreeAreaMatches(freeArea, code) {
  for (let i = 0; i < freeArea.length; i++)
    if (freeArea[i] !== (i < code.length ? code[i] : 0xff)) return false;
  return true;
}
function msCheckFreeArea(freeArea) {
  if (!freeArea || freeArea.length !== MS_CAR_CHECK_LENGTH) {
    throw new Error(
      `expected the first 0x${MS_CAR_CHECK_LENGTH.toString(16).toUpperCase()} bytes of the MPC's free area`
    );
  }
}
function msVersionOnCar(freeArea) {
  msCheckFreeArea(freeArea);
  for (const v of MS_KNOWN_VERSIONS) {
    const { code } = msBuildCode(v);
    if (code.length <= MS_CAR_CHECK_LENGTH && msFreeAreaMatches(freeArea, code))
      return v;
  }
  return null;
}
const msLayoutOf = (v) =>
  v.gen >= MS_SITE_GEN ? 'chunks' : msMulti(v) ? 'blocks' : 'copy';
const msVersionSummary = (v) =>
  v
    ? {
        trigger: v.trigger,
        presses: v.presses,
        scope: v.scope,
        maps: v.maps,
        layout: msLayoutOf(v),
      }
    : { trigger: null, presses: null, scope: null, maps: null, layout: null };

// ---- the safety monitor's sums -------------------------------------------------------------------
function msRomTestSum(flash, mpc) {
  let sum = MS_ROM_TEST_SEED;
  for (let i = 0; i < MS_ROM_TEST_RANGES.length; i += 2) {
    const start = MS_ROM_TEST_RANGES[i];
    const end = MS_ROM_TEST_RANGES[i + 1];
    if (
      msRead32(flash, MS_ROM_TEST_RANGES_OFFSET + 4 * i) !== start ||
      msRead32(flash, MS_ROM_TEST_RANGES_OFFSET + 4 * i + 4) !== end
    ) {
      throw new Error(
        "the program header does not list the expected ranges for the safety monitor's code sum"
      );
    }
    const inMpc = end <= MAPSWITCH_MPC_LENGTH;
    const image = inMpc ? mpc : flash;
    let offset = inMpc ? start : start & 0xfffff;
    for (let n = (end - start) / 4; n > 0; n--, offset += 4)
      sum = (sum + BigInt(msRead32(image, offset))) & MS_U64;
  }
  return sum;
}
function msReadRomTestSum(flash) {
  return (
    (BigInt(msRead32(flash, MS_ROM_TEST_SUM_OFFSET)) << 32n) |
    BigInt(msRead32(flash, MS_ROM_TEST_SUM_OFFSET + 4))
  );
}
function msCalTestSum(cal) {
  let sum = MS_ROM_TEST_SEED;
  for (
    let o = MS_CAL_TEST_RANGE_START - MS_CALIBRATION_BASE;
    o < MS_CAL_TEST_RANGE_END - MS_CALIBRATION_BASE;
    o += 4
  ) {
    sum = (sum + BigInt(msRead32(cal, o))) & MS_U64;
  }
  return sum;
}
function msReadCalTestSum(image, calOffset) {
  return (
    (BigInt(msRead32(image, calOffset + MS_CAL_TEST_SUM_OFFSET)) << 32n) |
    BigInt(msRead32(image, calOffset + MS_CAL_TEST_SUM_OFFSET + 4))
  );
}
function msWriteCalTestSum(image, calOffset, sum) {
  msWrite32(
    image,
    calOffset + MS_CAL_TEST_SUM_OFFSET,
    Number((sum >> 32n) & 0xffffffffn)
  );
  msWrite32(
    image,
    calOffset + MS_CAL_TEST_SUM_OFFSET + 4,
    Number(sum & 0xffffffffn)
  );
}
const msHex16 = (v) => v.toString(16).toUpperCase().padStart(16, '0');

// ---- laying the maps out in blocks (generation 4) --------------------------------------------------
/** The 1 KB blocks in which two calibrations differ. */
function msDifferingBlocks(map1, mapN) {
  const out = [];
  for (let b = 0; b < MS_BLOCK_COUNT; b++) {
    const start = b * MS_BLOCK;
    for (let i = start; i < start + MS_BLOCK; i++) {
      if (map1[i] !== mapN[i]) {
        out.push(b);
        break;
      }
    }
  }
  return out;
}

/** Maximal runs of consecutive block numbers, each {first, last}. */
function msRuns(blocks) {
  const sorted = [...blocks].sort((x, y) => x - y);
  const runs = [];
  for (const b of sorted) {
    const last = runs[runs.length - 1];
    if (last && last.last === b - 1) last.last = b;
    else runs.push({ first: b, last: b });
  }
  return runs;
}

/** Free 1 KB slots one by one: block number (flash offset / 1 KB) -> the pool it is in, in block order. */
class MsFreeBlocks {
  constructor() {
    this.free = new Map();
  }
  add(start, end, pool) {
    for (let b = start; b < end; b++) this.free.set(b, pool);
  }
  /** What is still free, as ranges for the runs that need consecutive slots. */
  pieces() {
    const out = new MsSlots();
    let start = -1;
    let last = -1;
    for (const b of [...this.free.keys()].sort((x, y) => x - y)) {
      if (b !== last + 1) {
        if (start >= 0) out.add(start, last + 1);
        start = b;
      }
      last = b;
    }
    if (start >= 0) out.add(start, last + 1);
    return out;
  }
}

/** Free 1 KB slots as a sorted list of {start, end} block numbers (flash offset / 1 KB). */
class MsSlots {
  constructor() {
    this.ranges = [];
  }
  add(start, end) {
    if (end <= start) return;
    this.ranges.push({ start, end });
    this.ranges.sort((x, y) => x.start - y.start);
  }
  get free() {
    return this.ranges.reduce((n, r) => n + r.end - r.start, 0);
  }
  /** The first range with room for `n` consecutive slots, taken from its start; -1 when none. */
  takeFirst(n) {
    for (const r of this.ranges) {
      if (r.end - r.start >= n) {
        const at = r.start;
        r.start += n;
        this.ranges = this.ranges.filter((x) => x.end > x.start);
        return at;
      }
    }
    return -1;
  }
  /** The smallest range with room for `n` consecutive slots, taken from its start; -1 when none. */
  takeBest(n) {
    let best = null;
    for (const r of this.ranges)
      if (
        r.end - r.start >= n &&
        (!best || r.end - r.start < best.end - best.start)
      )
        best = r;
    if (!best) return -1;
    const at = best.start;
    best.start += n;
    this.ranges = this.ranges.filter((x) => x.end > x.start);
    return at;
  }
}

/** The addis rX, r2, 1 still in the code, as [image, offset]. */
function msUpperSites(flash, mpc) {
  const out = [];
  for (const [which, start, end] of MS_UPPER_CODE) {
    const image = which === 'mpc' ? mpc : flash;
    for (let at = start; at < end; at += 4)
      if ((msRead32(image, at) & MS_UPPER_INSN_MASK) >>> 0 === MS_UPPER_ADDIS)
        out.push([which, at]);
  }
  return out;
}

/** Rewrite every addis rX, r2, 1 left to lis rX, 0xFFE5, and the two sensor-table readers; returns how many. */
function msRewriteUpper(result) {
  const sites = msUpperSites(result.flash, result.mpc);
  for (const [which, at] of sites) {
    const image = which === 'mpc' ? result.mpc : result.flash;
    msWrite32(
      image,
      at,
      (MS_UPPER_LIS | (msRead32(image, at) & ~MS_UPPER_INSN_MASK)) >>> 0
    );
  }
  let n = sites.length;
  for (const [at, stock] of MS_SENSOR_TABLE_SITES)
    if (msRead32(result.mpc, at) === stock) {
      msWrite32(
        result.mpc,
        at,
        (MS_SENSOR_TABLE_LIS | (stock & ~MS_UPPER_INSN_MASK)) >>> 0
      );
      n++;
    }
  return n;
}

/** Whether the sensor-table readers are as stock, as rewritten, or neither (null). */
function msSensorSitesState(mpc) {
  let stock = 0;
  let done = 0;
  for (const [at, want] of MS_SENSOR_TABLE_SITES) {
    const w = msRead32(mpc, at);
    if (w === want) stock++;
    else if (w === (MS_SENSOR_TABLE_LIS | (want & ~MS_UPPER_INSN_MASK)) >>> 0)
      done++;
  }
  return stock === 2 ? 'stock' : done === 2 ? 'rewritten' : null;
}

/**
 * Where every block of every extra map goes. `maps` are the calibrations of
 * maps 2..N. Blocks are flash offsets / 1 KB.
 * @returns {{ok: boolean, reason: string|null, maps: object[], blocksTotal: number, blocksUsed: number, blocksFree: number}}
 */
function msLayout(map1, maps) {
  const slots = new MsFreeBlocks();
  MS_POOLS.forEach(([start, end], pool) =>
    slots.add(Math.max(start, MS_TABLES_END) / MS_BLOCK, end / MS_BLOCK, pool)
  );
  const blocksTotal = slots.free.size;
  const out = {
    ok: true,
    reason: null,
    maps: [],
    blocksTotal,
    blocksUsed: 0,
    blocksFree: blocksTotal,
  };
  const fail = (reason) => {
    out.ok = false;
    out.reason = reason;
    return out;
  };
  const plans = [];
  for (let i = 0; i < maps.length; i++) {
    // the blocks this map must carry: what differs, with its neighbours. A
    // table whose pointer is in the block before may run into a changed
    // block, so that block is carried and redirected too; and a table in a
    // changed block may run into the next, so that one is carried after it
    // (but not redirected: tables starting in it are whole in map 1)
    const differing = new Set(msDifferingBlocks(map1, maps[i]));
    const redirected = new Set(differing);
    for (const b of differing) if (b > 0) redirected.add(b - 1);
    const carried = new Set(redirected);
    for (const b of differing) if (b + 1 < MS_BLOCK_COUNT) carried.add(b + 1);
    const runs = msRuns(carried);
    // the window: the r2 blocks, at their own offsets from a base the
    // program gets r2 from, and with them any run of carried blocks that
    // meets one, so that a table there still reads whole. An r2 block that
    // does not differ is only in the window for the reads through r2; its
    // table entry stays map 1's, and it carries no neighbours
    const meetsWindow = (r) =>
      MS_R2_BLOCKS.some((b) => b >= r.first && b <= r.last);
    const window = new Set(MS_R2_BLOCKS);
    for (const r of runs)
      if (meetsWindow(r)) for (let b = r.first; b <= r.last; b++) window.add(b);
    plans.push({
      index: i + 1,
      differing,
      redirected,
      window: [...window].sort((x, y) => x - y),
      others: runs
        .filter((r) => !meetsWindow(r))
        .sort((x, y) => y.last - y.first - (x.last - x.first)),
    });
  }
  // The windows go first, each at the lowest base whose slots are all free
  // in one pool. The r2 blocks are 0-6, 0x12 and 0x15-0x17, so a window has
  // gaps the next one's blocks fall into: at offsets 0, 7, 31, 38, 62 and
  // 69 six of them take 93 KB, not 150, and need no 25 KB in one piece.
  for (const p of plans) {
    let base = -1;
    for (const [b0, pool] of slots.free) {
      if (p.window.every((b) => slots.free.get(b0 + b) === pool)) {
        base = b0;
        break;
      }
    }
    if (base < 0) {
      return fail(
        `Map ${p.index + 1} does not fit: the ${msKb(p.window.length)} the program reads through r2 (spread over ${msKb(p.window[p.window.length - 1] + 1)}) find no place in the ${msKb(slots.free.size)} still free.`
      );
    }
    p.windowBase = base;
    p.slot = new Map();
    for (const b of p.window) {
      p.slot.set(b, base + b);
      slots.free.delete(base + b);
    }
  }
  // then the other runs, each in the smallest free piece it fits
  const pieces = slots.pieces();
  for (const p of plans) {
    for (const r of p.others) {
      const n = r.last - r.first + 1;
      const at = pieces.takeBest(n);
      if (at < 0) {
        return fail(
          `Map ${p.index + 1} does not fit: ${msKb(n)} more of flash in one piece is needed and ${msKb(pieces.free)} are free, in smaller pieces.`
        );
      }
      for (let b = r.first; b <= r.last; b++) p.slot.set(b, at + b - r.first);
    }
  }
  for (const p of plans) {
    const table = new Uint16Array(MS_TABLE_ENTRIES).fill(MS_NO_BLOCK);
    for (const b of p.redirected) table[b] = p.slot.get(b);
    out.maps.push({
      index: p.index,
      windowBase: p.windowBase,
      windowBlocks: p.window.length,
      r2: (MAPSWITCH_EXT + p.windowBase * MS_BLOCK + MS_R2_LOW) >>> 0,
      slot: p.slot,
      table,
      redirected: p.redirected.size,
      carried: p.slot.size,
      differing: p.differing.size,
    });
  }
  out.blocksFree = pieces.free;
  out.blocksUsed = blocksTotal - pieces.free;
  return out;
}

/** Erase everything a generation 4 build writes into the external flash (the pools cover the earlier full copy too). */
function msEraseMapAreas(flash) {
  for (const [start, end] of MS_POOLS) flash.fill(0xff, start, end);
  flash.fill(
    0xff,
    MAPSWITCH_MAP2_START,
    MAPSWITCH_MAP2_START + MAPSWITCH_MAP2_LENGTH
  );
}

/** Write the header, the block tables and the blocks of a layout into `flash`. */
function msWriteLayout(flash, maps, layout) {
  const h = MS_HEADER;
  flash.fill(0xff, h, h + MS_TABLE_STRIDE);
  for (let i = 0; i < MS_HEADER_MAGIC.length; i++)
    flash[h + i] = MS_HEADER_MAGIC.charCodeAt(i);
  flash[h + MS_HEADER_COUNT] = maps.length + 1;
  msWrite32(flash, h + MS_HEADER_R2, MS_R2_MAP1);
  for (const m of layout.maps) {
    msWrite32(flash, h + MS_HEADER_R2 + 4 * m.index, m.r2);
    const t = h + m.index * MS_TABLE_STRIDE;
    for (let e = 0; e < MS_TABLE_ENTRIES; e++)
      msWrite16(flash, t + 2 * e, m.table[e]);
    const cal = maps[m.index - 1];
    for (const [b, at] of m.slot)
      flash.set(cal.subarray(b * MS_BLOCK, (b + 1) * MS_BLOCK), at * MS_BLOCK);
  }
}

function msHeaderMapCount(area) {
  if (!area || area.length < MS_HEADER_COUNT + 1) return null;
  if (msReadAscii(area, 0, MS_HEADER_MAGIC.length) !== MS_HEADER_MAGIC)
    return null;
  const n = area[MS_HEADER_COUNT];
  return n >= MS_MIN_MAPS && n <= MS_MAX_MAPS ? n : null;
}

/** The block table of map `index` from the header-and-tables area. */
function msTableFrom(area, index) {
  const table = new Uint16Array(MS_TABLE_ENTRIES);
  for (let e = 0; e < MS_TABLE_ENTRIES; e++)
    table[e] = msRead16(area, index * MS_TABLE_STRIDE + 2 * e);
  return table;
}

/** Map `index` rebuilt from map 1 and the blocks its table names, read from `blockAt(flashOffset)`. */
function msMapFromTable(map1, table, blockAt) {
  const cal = Uint8Array.from(map1);
  for (let b = 0; b < MS_BLOCK_COUNT; b++) {
    if (table[b] === MS_NO_BLOCK) continue;
    const data = blockAt(table[b] * MS_BLOCK);
    if (!data || data.length !== MS_BLOCK) return null;
    cal.set(data, b * MS_BLOCK);
  }
  return cal;
}

/** The flash ranges holding the blocks a table names, consecutive ones merged: [{start, end}] (end exclusive). */
function msTableRanges(table) {
  const blocks = [];
  for (let b = 0; b < MS_BLOCK_COUNT; b++)
    if (table[b] !== MS_NO_BLOCK) blocks.push(table[b]);
  return msRuns(blocks).map((r) => ({
    start: r.first * MS_BLOCK,
    end: (r.last + 1) * MS_BLOCK,
  }));
}

/** The maps 2..N stored in a pair, as calibrations; null when the pair is not read as a build. */
function msStoredMaps(flash, mpc) {
  if (!flash || flash.length !== MAPSWITCH_FULL_FLASH_LENGTH) return null;
  const v = msVersionOf(mpc);
  if (!v) return null;
  if (!msMulti(v)) {
    const map2 = mapSwitch.map2AsCalibration(
      flash.subarray(
        MAPSWITCH_MAP2_START,
        MAPSWITCH_MAP2_START + MAPSWITCH_MAP2_LENGTH
      )
    );
    return map2 ? [map2] : [];
  }
  const area = flash.subarray(MS_HEADER, MS_CHUNK_TABLES_END);
  const n = msHeaderMapCount(area);
  if (n == null) return [];
  const map1 = flash.subarray(
    MAPSWITCH_CAL_START,
    MAPSWITCH_CAL_START + MAPSWITCH_CAL_LENGTH
  );
  const maps = [];
  if (msHeaderIsChunks(area)) {
    const dir = msReadSites(flash.subarray(MS_SITES, MS_POOLS[0][1]));
    for (let index = 1; index < n; index++) {
      const cal = msMapFromChunkTable(
        map1,
        msChunkTableFrom(area, index),
        dir,
        index,
        (at) => flash.subarray(at, at + MS_CHUNK)
      );
      if (cal) maps.push(cal);
    }
    return maps;
  }
  for (let index = 1; index < n; index++) {
    const cal = msMapFromTable(map1, msTableFrom(area, index), (at) =>
      flash.subarray(at, at + MS_BLOCK)
    );
    if (cal) maps.push(cal);
  }
  return maps;
}

// ---- generation 6: the single values switch at their load sites, the tables as chunks ---------
/**
 * Whether a word is a plausible PowerPC instruction: the primary opcode is
 * one the program uses, and for the extended-opcode forms the extension too.
 * Data words seldom are, so a run of them around a site tells code from data.
 */
const MS_VALID_OPS = new Set([
  7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 23, 24, 25, 26, 27, 28,
  29, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48,
  49, 50, 51, 52, 53, 54, 55, 59, 63,
]);
const MS_VALID_XO19 = new Set([
  0, 16, 33, 50, 129, 150, 193, 225, 257, 289, 417, 449, 528,
]);
const MS_VALID_XO31 = new Set([
  0, 4, 8, 10, 11, 19, 20, 23, 24, 26, 28, 32, 40, 54, 55, 60, 75, 83, 86, 87,
  104, 119, 124, 136, 138, 144, 146, 150, 151, 183, 202, 210, 215, 234, 235,
  242, 247, 266, 279, 284, 311, 316, 339, 343, 375, 407, 412, 439, 444, 459,
  467, 476, 491, 498, 502, 512, 533, 534, 536, 566, 567, 598, 599, 631, 663,
  695, 727, 759, 792, 824, 854, 918, 922, 954, 982, 1014,
]);
function msLooksLikeInsn(w) {
  const op = w >>> 26;
  if (!MS_VALID_OPS.has(op)) return false;
  if (op === 19) return MS_VALID_XO19.has((w >>> 1) & 0x3ff);
  if (op === 31)
    return (
      MS_VALID_XO31.has((w >>> 1) & 0x3ff) ||
      MS_VALID_XO31.has((w >>> 1) & 0x1ff)
    );
  return true;
}
function msIsCodeAround(image, at, start, end) {
  for (let k = -4; k <= 4; k++) {
    const a = at + 4 * k;
    if (a < start || a + 4 > end) continue;
    if (!msLooksLikeInsn(msRead32(image, a))) return false;
  }
  return true;
}

/**
 * Every load of a calibration value through r2 or a register derived from
 * it (addis rX, r2, 0/1 and lis rX, 0xFFE4/0xFFE5 set a base, addi rX, rB, d
 * moves one), within a straight run of code: branches end the tracking.
 * Returns {sites: Map<calOffset, [{image, at, word, rt, size}]>, uncovered: Set<calOffset>}
 * where `uncovered` holds offsets read in ways a stub cannot take over
 * (update forms, floats, r0 as the destination).
 */
function msScanSites(flash, mpc) {
  const sites = new Map();
  const uncovered = new Set();
  const LOAD = { 32: 4, 34: 1, 40: 2, 42: 2 };
  const add = (off, site) => {
    if (off < 0 || off + site.size > MAPSWITCH_CAL_LENGTH) return;
    if (!sites.has(off)) sites.set(off, []);
    sites.get(off).push(site);
  };
  for (const [which, start, end] of MS_CODE) {
    const image = which === 'mpc' ? mpc : flash;
    const bases = new Map(); // register -> calibration offset its value points at
    bases.set(2, MS_R2_LOW);
    for (let at = start; at + 4 <= end; at += 4) {
      const w = msRead32(image, at);
      const op = w >>> 26;
      const rt = (w >>> 21) & 31;
      const ra = (w >>> 16) & 31;
      const d = msS16ToNumber(w & 0xffff);
      if (op === 16 || op === 18 || op === 19) {
        // a branch: nothing survives it but r2 (r13 is never a base)
        bases.clear();
        bases.set(2, MS_R2_LOW);
        continue;
      }
      let setBase = null; // [register, offset] this instruction establishes
      if (op === 15 && ra === 2 && (w & 0xffff) === 0)
        setBase = [rt, MS_R2_LOW];
      else if (op === 15 && ra === 2 && (w & 0xffff) === 1)
        setBase = [rt, MS_R2_LOW + 0x10000];
      else if (op === 15 && ra === 0 && (w & 0xffff) === 0xffe4)
        setBase = [rt, 0];
      else if (op === 15 && ra === 0 && (w & 0xffff) === 0xffe5)
        setBase = [rt, 0x10000];
      else if (op === 14 && bases.has(ra) && rt !== 2)
        setBase = [rt, bases.get(ra) + d];
      else if (
        LOAD[op] &&
        bases.has(ra) &&
        msIsCodeAround(image, at, start, end)
      ) {
        const off = bases.get(ra) + d;
        if (
          rt === 0 ||
          rt === 2 ||
          rt === 13 ||
          (which === 'mpc' && MS_PATCHED_ADDRESSES.has(at))
        ) {
          for (let k = 0; k < LOAD[op]; k++) uncovered.add(off + k);
        } else {
          add(off, { image: which, at, word: w, rt, size: LOAD[op], op });
        }
      } else if (
        (op === 33 ||
          op === 35 ||
          op === 41 ||
          op === 43 ||
          op === 48 ||
          op === 50) &&
        bases.has(ra)
      ) {
        const n =
          op === 50
            ? 8
            : op === 48
              ? 4
              : op === 33
                ? 4
                : op === 41 || op === 43
                  ? 2
                  : 1;
        for (let k = 0; k < n; k++) uncovered.add(bases.get(ra) + d + k);
      }
      // the registers this instruction writes stop being bases
      for (const reg of msWrittenGprs(w)) if (reg !== 2) bases.delete(reg);
      if (setBase && setBase[0] !== 2) bases.set(setBase[0], setBase[1]);
    }
  }
  return { sites, uncovered };
}
const MS_PATCHED_ADDRESSES = new Set([
  ...MS_LOOKUP_ENTRIES,
  MS_LOOKUP_ENTRY_17,
  MS_TACH_STORE_ADDR,
  MS_MIL_STORE_ADDR,
  MS_ECON_STORE_ADDR,
  MS_NV_DESCRIPTOR,
  MS_NV_DESCRIPTOR + 4,
  MS_NV_DESCRIPTOR + 8,
]);
function msS16ToNumber(v) {
  return v & 0x8000 ? v - 0x10000 : v;
}
/** The general registers an instruction writes (approximately: enough to stop trusting a base). */
function msWrittenGprs(w) {
  const op = w >>> 26;
  const rt = (w >>> 21) & 31;
  const ra = (w >>> 16) & 31;
  if (op === 7 || op === 8 || (op >= 12 && op <= 15)) return [rt];
  if (op === 20 || op === 21 || op === 23 || (op >= 24 && op <= 29))
    return [ra];
  if (op >= 32 && op <= 35) return op & 1 ? [rt, ra] : [rt]; // lwz lwzu lbz lbzu
  if (op >= 40 && op <= 43) return op & 1 ? [rt, ra] : [rt]; // lhz lhzu lha lhau
  if (
    op === 37 ||
    op === 39 ||
    op === 45 ||
    op === 49 ||
    op === 51 ||
    op === 53 ||
    op === 55
  )
    return [ra]; // stores and float loads with update
  if (op === 31) {
    const xo = (w >>> 1) & 0x3ff;
    if ([0, 32, 4, 144, 150, 214, 467, 598, 854].includes(xo)) return []; // cmp, cmpl, tw, mtcrf, stwcx, mtspr, sync, eieio
    if ([151, 183, 215, 247, 407, 439, 663, 695, 727, 759].includes(xo))
      return xo & 32 ? [ra] : []; // stores, update forms write ra
    if (
      [
        28, 60, 444, 412, 316, 476, 124, 284, 24, 536, 792, 824, 26, 954, 922,
      ].includes(xo)
    )
      return [ra]; // logic and shifts: ra
    if ([55, 119, 311, 375, 55, 87, 279, 343, 23].includes(xo))
      return xo & 32 ? [rt, ra] : [rt]; // indexed loads
    return [rt];
  }
  return [];
}

/**
 * The stub a patched load site branches to: the value for the selected map
 * from the site's values, same load width and sign as the stock instruction.
 * @returns {number[]} five words
 */
function msSiteStub(site, valuesAt) {
  const rt = site.rt;
  const words = [Lbz(rt, msOff(MS_RAM_FLAG), 13)];
  // the index (flag bits 4-6) times the value size, nothing else of the flag byte
  if (site.size === 1) words.push(Rlwinm(rt, rt, 28, 29, 31));
  else if (site.size === 2) words.push(Rlwinm(rt, rt, 29, 28, 30));
  else words.push(Rlwinm(rt, rt, 30, 27, 29));
  words.push(Addis(rt, rt, msHa(MAPSWITCH_EXT + valuesAt)));
  words.push(msD(site.op, rt, rt, msLo(MAPSWITCH_EXT + valuesAt) & 0xffff));
  const back = (site.image === 'mpc' ? 0 : MAPSWITCH_EXT) + site.at + 4;
  words.push(Ba(back));
  return words;
}

/**
 * The site directory at MS_SITES, as the builder writes it and the readers
 * (here and on the emulator / car side) parse it:
 *   'SITE' | u32 scalars | u32 sites | u32 end (flash offset after the stubs)
 *   scalar: u32 (size << 24 | offset) | values[8 * size], padded to 4
 *   site:   u32 address (MPC, or 0xFFFxxxxx) | u32 stock word | u32 stub (flash offset) | u32 scalar index
 *   stubs:  5 words each
 */
function msSitePlan(scan, map1, maps) {
  // which bytes differ in any map, and which of those a site covers
  const differing = new Set();
  for (const cal of maps)
    for (let i = 0; i < MAPSWITCH_CAL_LENGTH; i++)
      if (
        cal[i] !== map1[i] &&
        !(i >= MS_CAL_TEST_SUM_OFFSET && i < MS_CAL_TEST_SUM_OFFSET + 8)
      )
        differing.add(i);
  const scalars = []; // {offset, size, values: Uint8Array[8]}
  const sites = []; // {site, scalar}
  const covered = new Set();
  const byKey = new Map();
  for (const [off, list] of scan.sites) {
    for (const site of list) {
      let hit = false;
      for (let k = 0; k < site.size; k++)
        if (differing.has(off + k)) hit = true;
      if (!hit) continue;
      const key = `${off}:${site.size}`;
      if (!byKey.has(key)) {
        const values = [];
        for (let m = 0; m < MS_MAX_MAPS + 1; m++) {
          const cal = m === 0 || m > maps.length ? map1 : maps[m - 1];
          values.push(cal.subarray(off, off + site.size));
        }
        byKey.set(key, scalars.length);
        scalars.push({ offset: off, size: site.size, values });
      }
      sites.push({ site, scalar: byKey.get(key) });
      for (let k = 0; k < site.size; k++) covered.add(off + k);
    }
  }
  // what no site covers is table data (or read some other way): those chunks are stored
  const chunks = new Set();
  const unswitchable = [];
  for (const b of differing) {
    if (covered.has(b)) continue;
    chunks.add(b >> 8);
    if (scan.uncovered.has(b)) unswitchable.push(b);
  }
  return { scalars, sites, chunks, covered, differing, unswitchable };
}

function msSiteAreaLength(plan) {
  let n = 16;
  for (const s of plan.scalars) n += 4 + msPad4(8 * s.size);
  n += 16 * plan.sites.length;
  n += 20 * plan.sites.length;
  return n;
}
const msPad4 = (n) => (n + 3) & ~3;

/** Write the directory and the stubs; patch the sites. Returns the flash offset after the stubs. */
function msWriteSites(result, plan) {
  const flash = result.flash;
  let at = MS_SITES;
  const put32 = (v) => {
    msWrite32(flash, at, v);
    at += 4;
  };
  for (let i = 0; i < 4; i++) flash[at + i] = MS_SITES_MAGIC.charCodeAt(i);
  at += 4;
  put32(plan.scalars.length);
  put32(plan.sites.length);
  const endAt = at;
  put32(0);
  const valuesAt = [];
  for (const s of plan.scalars) {
    put32(((s.size << 24) | s.offset) >>> 0);
    valuesAt.push(at);
    for (let m = 0; m < MS_MAX_MAPS + 1; m++)
      flash.set(s.values[m], at + m * s.size);
    at += msPad4(8 * s.size);
  }
  const stubsAt = at + 16 * plan.sites.length;
  let stub = stubsAt;
  for (const { site, scalar } of plan.sites) {
    put32(site.image === 'mpc' ? site.at : (MAPSWITCH_EXT + site.at) >>> 0);
    put32(site.word);
    put32(stub);
    put32(scalar);
    const words = msSiteStub(site, valuesAt[scalar]);
    for (let i = 0; i < words.length; i++)
      msWrite32(flash, stub + 4 * i, words[i]);
    const image = site.image === 'mpc' ? result.mpc : flash;
    msWrite32(image, site.at, Ba(MAPSWITCH_EXT + stub));
    stub += 20;
  }
  const end = (stub + MS_CHUNK - 1) & ~(MS_CHUNK - 1);
  msWrite32(flash, endAt, end);
  return end;
}

/** The directory as written: {scalars: [{offset, size, values}], sites: [{address, stock, stub, scalar}], end} or null. */
function msReadSites(area) {
  // `area` starts at MS_SITES
  if (!area || area.length < 16 || msReadAscii(area, 0, 4) !== MS_SITES_MAGIC)
    return null;
  const nScalars = msRead32(area, 4);
  const nSites = msRead32(area, 8);
  const end = msRead32(area, 12);
  let at = 16;
  const scalars = [];
  for (let i = 0; i < nScalars; i++) {
    if (at + 4 > area.length) return null;
    const head = msRead32(area, at);
    const size = head >>> 24;
    const offset = head & 0xffffff;
    at += 4;
    if (at + 8 * size > area.length) return null;
    const values = [];
    for (let m = 0; m < MS_MAX_MAPS + 1; m++)
      values.push(
        Uint8Array.from(area.subarray(at + m * size, at + (m + 1) * size))
      );
    scalars.push({ offset, size, values });
    at += msPad4(8 * size);
  }
  const sites = [];
  for (let i = 0; i < nSites; i++) {
    if (at + 16 > area.length) return null;
    sites.push({
      address: msRead32(area, at),
      stock: msRead32(area, at + 4),
      stub: msRead32(area, at + 8),
      scalar: msRead32(area, at + 12),
    });
    at += 16;
  }
  return { scalars, sites, end, length: at + 20 * nSites };
}

/** Put the stock instructions back at a build's patched sites, from its directory. */
function msRestoreSites(result) {
  const dir = msReadSites(result.flash.subarray(MS_SITES, MS_POOLS[0][1]));
  if (!dir) return 0;
  for (const s of dir.sites) {
    if (s.address < MAPSWITCH_MPC_LENGTH)
      msWrite32(result.mpc, s.address, s.stock);
    else msWrite32(result.flash, s.address - MAPSWITCH_EXT, s.stock);
  }
  return dir.sites.length;
}

/** The chunk layout of maps 2..N: like the block layout, at 256 bytes, with no window. */
function msChunkLayout(map1, maps, plan, poolStart) {
  const slots = new MsSlots();
  slots.add(poolStart / MS_CHUNK, MS_POOLS[0][1] / MS_CHUNK);
  slots.add(MS_POOLS[1][0] / MS_CHUNK, MS_POOLS[1][1] / MS_CHUNK);
  const chunksTotal = slots.free;
  const out = { ok: true, reason: null, maps: [], chunksTotal, chunksUsed: 0 };
  for (let i = 0; i < maps.length; i++) {
    const cal = maps[i];
    // the chunks this map must carry: what differs (less the bytes its
    // sites switch), the MS_TABLE_REACH before each (a table whose pointer
    // is there may run into it: redirected too) and the MS_TABLE_REACH after
    // (a table in it may run on: carried, not redirected)
    const differing = new Set();
    for (const c of plan.chunks) {
      for (let k = c * MS_CHUNK; k < (c + 1) * MS_CHUNK; k++)
        if (
          cal[k] !== map1[k] &&
          !plan.covered.has(k) &&
          !(k >= MS_CAL_TEST_SUM_OFFSET && k < MS_CAL_TEST_SUM_OFFSET + 8)
        ) {
          differing.add(c);
          break;
        }
    }
    const redirected = new Set(differing);
    for (const c of differing)
      for (let k = 1; k <= MS_TABLE_REACH; k++)
        if (c - k >= 0) redirected.add(c - k);
    const carried = new Set(redirected);
    for (const c of differing)
      for (let k = 1; k <= MS_TABLE_REACH; k++)
        if (c + k < MS_CHUNK_COUNT) carried.add(c + k);
    const runs = msRuns(carried).sort(
      (x, y) => y.last - y.first - (x.last - x.first)
    );
    const slot = new Map();
    for (const r of runs) {
      const n = r.last - r.first + 1;
      const at = slots.takeBest(n);
      if (at < 0) {
        out.ok = false;
        out.reason = `Map ${i + 2} does not fit: ${n * MS_CHUNK} more bytes of flash in one piece are needed and ${slots.free * MS_CHUNK} are free, in smaller pieces.`;
        return out;
      }
      for (let c = r.first; c <= r.last; c++) slot.set(c, at + c - r.first);
    }
    const table = new Uint16Array(MS_CHUNK_TABLE_ENTRIES).fill(MS_NO_BLOCK);
    for (const c of redirected) table[c] = slot.get(c);
    out.maps.push({
      index: i + 1,
      slot,
      table,
      carried: carried.size,
      differing: differing.size,
    });
  }
  out.chunksUsed = chunksTotal - slots.free;
  return out;
}

/** Write the header, the chunk tables and the chunks (the site area is already there). */
function msWriteChunkLayout(flash, maps, layout, sitesEnd) {
  const h = MS_HEADER;
  flash.fill(0xff, h, h + MS_CHUNK_TABLE_STRIDE);
  for (let i = 0; i < MS_HEADER_MAGIC.length; i++)
    flash[h + i] = MS_HEADER_MAGIC.charCodeAt(i);
  flash[h + MS_HEADER_COUNT] = maps.length + 1;
  flash[h + MS_HEADER_LAYOUT] = MS_SITE_GEN;
  msWrite32(flash, h + MS_HEADER_SITES_END, sitesEnd);
  for (let m = 0; m <= MS_MAX_MAPS; m++)
    msWrite32(flash, h + MS_HEADER_R2 + 4 * m, MS_R2_MAP1);
  for (const m of layout.maps) {
    const t = MS_HEADER + m.index * MS_CHUNK_TABLE_STRIDE;
    flash.fill(0xff, t, t + MS_CHUNK_TABLE_STRIDE);
    for (let e = 0; e < MS_CHUNK_TABLE_ENTRIES; e++)
      msWrite16(flash, t + 2 * e, m.table[e]);
    const cal = maps[m.index - 1];
    for (const [c, at] of m.slot)
      flash.set(cal.subarray(c * MS_CHUNK, (c + 1) * MS_CHUNK), at * MS_CHUNK);
  }
}

/** The chunk table of map `index` from the header-and-tables area (MS_HEADER up). */
function msChunkTableFrom(area, index) {
  const table = new Uint16Array(MS_CHUNK_TABLE_ENTRIES);
  for (let e = 0; e < MS_CHUNK_TABLE_ENTRIES; e++)
    table[e] = msRead16(area, index * MS_CHUNK_TABLE_STRIDE + 2 * e);
  return table;
}
const msHeaderIsChunks = (area) =>
  area &&
  area.length > MS_HEADER_LAYOUT &&
  area[MS_HEADER_LAYOUT] === MS_SITE_GEN;

/** Map `index` from map 1, its chunk table and its scalar values: chunks read through `chunkAt(flashOffset)`. */
function msMapFromChunkTable(map1, table, dir, index, chunkAt) {
  const cal = Uint8Array.from(map1);
  for (let c = 0; c < MS_CHUNK_COUNT; c++) {
    if (table[c] === MS_NO_BLOCK) continue;
    const data = chunkAt(table[c] * MS_CHUNK);
    if (!data || data.length !== MS_CHUNK) return null;
    cal.set(data, c * MS_CHUNK);
  }
  if (dir) for (const s of dir.scalars) cal.set(s.values[index], s.offset);
  return cal;
}

// ---- the public surface ---------------------------------------------------------------------------
const mapSwitch = {
  SUPPORTED_PROGRAM_VERSION: MAPSWITCH_PROGRAM_VERSION,
  FULL_FLASH_LENGTH: MAPSWITCH_FULL_FLASH_LENGTH,
  MPC_LENGTH: MAPSWITCH_MPC_LENGTH,
  CALIBRATION_START: MAPSWITCH_CAL_START,
  CALIBRATION_LENGTH: MAPSWITCH_CAL_LENGTH,
  MAP2_START: MAPSWITCH_MAP2_START,
  MAP2_LENGTH: MAPSWITCH_MAP2_LENGTH,
  CAR_CHECK_OFFSET: MAPSWITCH_FREE_START,
  CAR_CHECK_LENGTH: MS_CAR_CHECK_LENGTH,
  MAP2_DATA_VERSION_OFFSET:
    MAPSWITCH_MAP2_START + MAPSWITCH_DATA_VERSION_OFFSET,
  DATA_VERSION_LENGTH: MAPSWITCH_DATA_VERSION_LENGTH,
  /** Generation 4: the header and block tables, read whole from a car. */
  TABLES_OFFSET: MS_HEADER,
  TABLES_LENGTH: MS_TABLES_LENGTH,
  BLOCK_LENGTH: MS_BLOCK,
  MAX_MAPS: MS_MAX_MAPS,
  MIN_MAPS: MS_MIN_MAPS,
  DSC_PRESS_CHOICES: MS_DSC_PRESS_CHOICES,
  DEFAULT_DSC_PRESSES: MS_DEFAULT_DSC_PRESSES,
  DEFAULT_TRIGGER: 'dsc',
  /** RAM worth reading on a car to see the trigger work. */
  RAM: {
    canAsc1: 0x3fdcac,
    canEgs1: MS_RAM_EGS1,
    dscState: MAPSWITCH_R13 + MS_VAR_DSC_STATE,
    engineSpeed: MAPSWITCH_R13 + MS_VAR_ENGINE_SPEED,
    vehicleSpeed: MAPSWITCH_R13 + MS_VAR_VEHICLE_SPEED,
    tach: MAPSWITCH_R13 + MS_TACH_VAR,
    flag: MS_RAM_FLAG,
  },

  /**
   * @param {'dsc'|'shifter'|'pedals'} trigger - The trigger.
   * @param {number} [presses] - DSC presses.
   * @returns {string}
   */
  describeTrigger(trigger, presses = MS_DEFAULT_DSC_PRESSES) {
    if (trigger === 'dsc') return `DSC button pressed ${presses} times`;
    if (trigger === 'shifter') return 'gear lever activation style';
    return 'brake + full throttle held 5 s';
  },
  /** @param {'fullTune'|'mapsOnly'} scope - The scope. @returns {string} */
  describeScope(scope) {
    return scope === 'fullTune' ? 'full tune' : 'maps only';
  },
  /** @param {Uint8Array} flash - A full image. @returns {string|null} */
  readProgramVersion(flash) {
    return msReadAscii(flash, MAPSWITCH_PROGRAM_VERSION_OFFSET, 12);
  },
  /** @param {Uint8Array} cal - A calibration. @returns {string|null} */
  readDataVersion(cal) {
    return msReadAscii(
      cal,
      MAPSWITCH_DATA_VERSION_OFFSET,
      MAPSWITCH_DATA_VERSION_LENGTH
    );
  },
  /** The data version in a field read from the car, or null. @param {Uint8Array} field @returns {string|null} */
  dataVersionFrom(field) {
    return field && field.length === MAPSWITCH_DATA_VERSION_LENGTH
      ? msReadAscii(field, 0, MAPSWITCH_DATA_VERSION_LENGTH)
      : null;
  },
  /**
   * The index (0 = map 1) a flag byte read from a car selects, given the
   * layout stateOnCar reported.
   * @param {number} flag
   * @param {'blocks'|'copy'|null} layout
   * @returns {number}
   */
  selectedIndex(flag, layout) {
    if (flag == null) return 0;
    return layout === 'blocks' || layout === 'chunks'
      ? (flag & MS_FLAG_INDEX_MASK) >> MS_FLAG_INDEX_SHIFT
      : flag & 1;
  },
  /** How many maps a header-and-tables area read from a car says are stored, or null. */
  mapCountFrom(area) {
    return msHeaderMapCount(area);
  },
  /** How much to read from TABLES_OFFSET for a layout's header and tables. */
  tablesLength(layout) {
    return layout === 'chunks'
      ? MS_CHUNK_TABLES_END - MS_HEADER
      : MS_TABLES_LENGTH;
  },
  /** Whether a header-and-tables area is the chunks-and-sites layout. */
  isChunksLayout(area) {
    return !!msHeaderIsChunks(area);
  },
  /**
   * The flash ranges to read for map `index` (1 = map 2), from the
   * header-and-tables area. With the chunk layout the first range is the
   * site area, whose values the map needs too.
   */
  blockRangesFrom(area, index) {
    if (msHeaderIsChunks(area)) {
      const end = msRead32(area, MS_HEADER_SITES_END);
      const ranges = [{ start: MS_SITES, end }];
      const chunks = [];
      const table = msChunkTableFrom(area, index);
      for (let c = 0; c < MS_CHUNK_COUNT; c++)
        if (table[c] !== MS_NO_BLOCK) chunks.push(table[c]);
      for (const r of msRuns(chunks))
        ranges.push({
          start: r.first * MS_CHUNK,
          end: (r.last + 1) * MS_CHUNK,
        });
      return ranges;
    }
    return msTableRanges(msTableFrom(area, index));
  },
  /**
   * Map `index` from map 1, the header-and-tables area and the ranges read
   * (`chunks`: [{start, data}] as blockRangesFrom asked for them).
   * @returns {Uint8Array|null}
   */
  mapFromChunks(map1, area, index, chunks) {
    if (msHeaderIsChunks(area)) {
      const siteArea = chunks.find((c) => c.start === MS_SITES);
      const dir = siteArea ? msReadSites(siteArea.data) : null;
      if (!dir) return null;
      return msMapFromChunkTable(
        map1,
        msChunkTableFrom(area, index),
        dir,
        index,
        (at) => {
          for (const c of chunks)
            if (at >= c.start && at + MS_CHUNK <= c.start + c.data.length)
              return c.data.subarray(at - c.start, at - c.start + MS_CHUNK);
          return null;
        }
      );
    }
    return msMapFromTable(map1, msTableFrom(area, index), (at) => {
      for (const c of chunks)
        if (at >= c.start && at + MS_BLOCK <= c.start + c.data.length)
          return c.data.subarray(at - c.start, at - c.start + MS_BLOCK);
      return null;
    });
  },
  /**
   * Where a calibration offset of map `index` lies in the flash, given the
   * header-and-tables area: in the stored block or chunk, or in map 1. With
   * the chunk layout the single values a map switches at their load sites
   * are not here: see scalarsFrom.
   */
  locateFrom(area, index, calOffset) {
    if (msHeaderIsChunks(area)) {
      const entry = index
        ? msChunkTableFrom(area, index)[calOffset >> 8]
        : MS_NO_BLOCK;
      return entry === MS_NO_BLOCK
        ? MAPSWITCH_CAL_START + calOffset
        : entry * MS_CHUNK + (calOffset & (MS_CHUNK - 1));
    }
    const entry = index
      ? msTableFrom(area, index)[calOffset >> 10]
      : MS_NO_BLOCK;
    return entry === MS_NO_BLOCK
      ? MAPSWITCH_CAL_START + calOffset
      : entry * MS_BLOCK + (calOffset & (MS_BLOCK - 1));
  },
  /** The granularity locateFrom works at for a header-and-tables area. */
  pieceLength(area) {
    return msHeaderIsChunks(area) ? MS_CHUNK : MS_BLOCK;
  },
  /** The site area's flash range for a chunk-layout header, [start, end), or null. */
  siteRangeFrom(area) {
    return msHeaderIsChunks(area)
      ? { start: MS_SITES, end: msRead32(area, MS_HEADER_SITES_END) }
      : null;
  },
  /** The single values map `index` switches at their load sites, from the site area read: [{offset, data}]. */
  scalarsFrom(siteArea, index) {
    const dir = msReadSites(siteArea);
    if (!dir) return [];
    return dir.scalars.map((s) => ({
      offset: s.offset,
      data: s.values[index],
    }));
  },
  /** @param {Uint8Array} flash @param {Uint8Array} mpc @returns {boolean} */
  hasMap2(flash, mpc) {
    const maps = msStoredMaps(flash, mpc);
    return !!maps && maps.length > 0;
  },
  /**
   * The maps 2..N a pair carries, as calibrations (map 2's safety-monitor
   * sum is map 1's, as stored); null when the pair carries no build.
   * @returns {Uint8Array[]|null}
   */
  storedMaps(flash, mpc) {
    return msStoredMaps(flash, mpc);
  },
  /**
   * Copies of `flash` and `mpc` with the stored maps replaced by `maps`
   * (calibrations of maps 2..N), laid out against the calibration in the
   * image, for the build the MPC carries; from generation 6 the MPC changes
   * too (the load sites). The count must stay what the code was built for.
   * @returns {{flash: Uint8Array, mpc: Uint8Array}}
   */
  replaceStoredMaps(flash, mpc, maps) {
    const v = msVersionOf(mpc);
    if (!v)
      throw new Error('the MPC carries no recognised build of the map switch');
    const out = Uint8Array.from(flash);
    const map1 = out.subarray(
      MAPSWITCH_CAL_START,
      MAPSWITCH_CAL_START + MAPSWITCH_CAL_LENGTH
    );
    if (!msMulti(v)) {
      if (maps.length !== 1) throw new Error('this build holds one map 2');
      out.set(maps[0].subarray(0, MAPSWITCH_MAP2_LENGTH), MAPSWITCH_MAP2_START);
      msWriteCalTestSum(out, MAPSWITCH_MAP2_START, msCalTestSum(map1));
      return { flash: out, mpc: Uint8Array.from(mpc) };
    }
    if (maps.length + 1 !== v.maps)
      throw new Error(
        `this build cycles through ${v.maps} maps, so it stores ${v.maps - 1} besides map 1`
      );
    const prepared = maps.map((m) => {
      const cal = Uint8Array.from(m);
      msWriteCalTestSum(cal, 0, msCalTestSum(map1));
      return cal;
    });
    if (v.gen >= MS_SITE_GEN) {
      const result = {
        flash: out,
        mpc: Uint8Array.from(mpc),
        wasAlreadyPatched: true,
        log: [],
      };
      msBuildSites(result, Uint8Array.from(map1), prepared, v);
      return result;
    }
    const layout = msLayout(map1, prepared);
    if (!layout.ok) throw new Error(layout.reason);
    msEraseMapAreas(out);
    msWriteLayout(out, prepared, layout);
    return { flash: out, mpc: Uint8Array.from(mpc) };
  },
  /**
   * Whether `maps` (calibrations of maps 2..N) fit beside `map1`, how much
   * flash they take and whether one more would fit. `map1` null assumes
   * maps identical to it.
   * @returns {{ok: boolean, reason: string|null, kbUsed: number, kbTotal: number, perMapKb: number[], canAddAnother: boolean, maxMaps: number}}
   */
  plan(map1, maps, flash = null, mpc = null) {
    const base =
      map1 ||
      (maps.find((m) => m) ?? new Uint8Array(MAPSWITCH_CAL_LENGTH).fill(0xff));
    const list = (maps || []).map((m) => m || base);
    if (MS_CURRENT_GEN >= MS_SITE_GEN) {
      // without the program to scan, every differing byte counts as table data: the most it can cost
      const scan =
        flash &&
        mpc &&
        flash.length === MAPSWITCH_FULL_FLASH_LENGTH &&
        mpc.length === MAPSWITCH_MPC_LENGTH
          ? msScanSites(flash, mpc)
          : { sites: new Map(), uncovered: new Set() };
      const sized = (ms) => {
        const plan = msSitePlan(scan, base, ms);
        const poolStart =
          (MS_SITES + msSiteAreaLength(plan) + MS_CHUNK - 1) & ~(MS_CHUNK - 1);
        const layout = msChunkLayout(base, ms, plan, poolStart);
        return { plan, layout, poolStart };
      };
      const here = sized(list);
      const more = sized([...list, base]);
      const total = Math.round(
        (MS_POOLS[0][1] - MS_HEADER + MS_POOLS[1][1] - MS_POOLS[1][0]) / 1024
      );
      return {
        ok: here.layout.ok,
        reason: here.layout.reason,
        kbUsed:
          Math.round(
            ((here.poolStart - MS_HEADER) / 1024 + here.layout.chunksUsed / 4) *
              10
          ) / 10,
        kbTotal: total,
        perMapKb: here.layout.maps.map(
          (m) => Math.round((m.carried / 4) * 10) / 10
        ),
        canAddAnother:
          here.layout.ok && more.layout.ok && list.length + 2 <= MS_MAX_MAPS,
        maxMaps: MS_MAX_MAPS,
      };
    }
    const layout = msLayout(base, list);
    const more = msLayout(base, [...list, base]);
    return {
      ok: layout.ok,
      reason: layout.reason,
      kbUsed: layout.blocksUsed,
      kbTotal: layout.blocksTotal,
      perMapKb: layout.maps.map((m) => m.carried),
      canAddAnother: layout.ok && more.ok && list.length + 2 <= MS_MAX_MAPS,
      maxMaps: MS_MAX_MAPS,
    };
  },
  /** @param {Uint8Array} mpc @returns {boolean} */
  isAlreadyPatched(mpc) {
    return msVersionOf(mpc) != null || msCarriesSomeBuild(mpc);
  },
  /** @param {Uint8Array} mpc @returns {boolean} */
  isCurrentVersion(mpc) {
    const v = msVersionOf(mpc);
    return v != null && msIsCurrent(v);
  },
  /**
   * The trigger, presses, scope, map count and layout a patched MPC carries; null when it is not patched.
   * @param {Uint8Array} mpc
   * @returns {{trigger: string, presses: number, scope: string, maps: number, layout: string}|null}
   */
  installed(mpc) {
    const v = msVersionOf(mpc);
    return v ? msVersionSummary(v) : null;
  },
  /**
   * What the first CAR_CHECK_LENGTH bytes of the MPC's free area, as read from
   * a car, say: 'notInstalled', 'current', 'earlier' or 'unrecognised', with the
   * trigger / presses / scope / maps / layout when known.
   * @param {Uint8Array} freeArea
   * @returns {{state: string, trigger: string|null, presses: number|null, scope: string|null, maps: number|null, layout: string|null}}
   */
  stateOnCar(freeArea) {
    msCheckFreeArea(freeArea);
    if (msFreeAreaMatches(freeArea, new Uint8Array(0)))
      return { state: 'notInstalled', ...msVersionSummary(null) };
    const v = msVersionOnCar(freeArea);
    if (!v)
      return {
        state: msLooksLikeOurCode(freeArea) ? 'earlier' : 'unrecognised',
        ...msVersionSummary(null),
      };
    return {
      state: msIsCurrent(v) ? 'current' : 'earlier',
      ...msVersionSummary(v),
    };
  },
  /**
   * Turn the map 2 area of an earlier build, as read from a car, back into the tune it was stored from.
   * @param {Uint8Array} map2Area - The 0x18000 bytes at 0xE0000.
   * @returns {Uint8Array|null}
   */
  map2AsCalibration(map2Area) {
    if (!map2Area || map2Area.length !== MAPSWITCH_MAP2_LENGTH) {
      throw new Error(
        `expected the 0x${MAPSWITCH_MAP2_LENGTH.toString(16).toUpperCase()} bytes of the map 2 area`
      );
    }
    if (
      msReadAscii(
        map2Area,
        MAPSWITCH_DATA_VERSION_OFFSET,
        MAPSWITCH_DATA_VERSION_LENGTH
      ) == null
    )
      return null;
    const cal = new Uint8Array(MAPSWITCH_CAL_LENGTH).fill(0xff);
    cal.set(map2Area, 0);
    return cal;
  },
  /**
   * A tune in any accepted form (a 0x1D000-0x20000 partial, or a full 1 MB
   * image) as the 0x1D000-byte calibration.
   * @param {Uint8Array} file
   * @returns {Uint8Array}
   */
  extractCalibration(file) {
    if (!file) throw new Error('no file');
    if (file.length === MAPSWITCH_FULL_FLASH_LENGTH)
      return Uint8Array.from(
        file.subarray(
          MAPSWITCH_CAL_START,
          MAPSWITCH_CAL_START + MAPSWITCH_CAL_LENGTH
        )
      );
    if (file.length >= MAPSWITCH_CAL_LENGTH && file.length <= 0x20000)
      return Uint8Array.from(file.subarray(0, MAPSWITCH_CAL_LENGTH));
    throw new Error(
      `a tune must be a calibration partial (0x1D000 bytes) or a full 1 MB image; this file is 0x${file.length.toString(16).toUpperCase()} bytes`
    );
  },
  /**
   * Why this pair cannot be patched, or null when it can. A pair that is
   * already patched is accepted (its maps can be replaced).
   * @param {Uint8Array} flash
   * @param {Uint8Array} mpc
   * @returns {string|null}
   */
  blockedReason(flash, mpc) {
    if (!flash || flash.length !== MAPSWITCH_FULL_FLASH_LENGTH)
      return 'Map switch needs a full 1 MB external flash image.';
    if (!mpc || mpc.length !== MAPSWITCH_MPC_LENGTH)
      return 'Map switch needs the 448 KB MPC (internal flash) image.';
    const version = mapSwitch.readProgramVersion(flash);
    if (version !== MAPSWITCH_PROGRAM_VERSION) {
      return `Map switch is only built for program ${MAPSWITCH_PROGRAM_VERSION}, but this image reports ${version || 'an unreadable version'}.`;
    }
    const upper = msUpperSites(flash, mpc).length;
    const sensor = msSensorSitesState(mpc);
    const sitesBuild =
      mapSwitch.isAlreadyPatched(mpc) &&
      msHeaderIsChunks(flash.subarray(MS_HEADER, MS_HEADER + 0x40));
    if (
      !sitesBuild &&
      (upper !== MS_UPPER_SITES || sensor !== 'stock') &&
      !(
        upper === 0 &&
        sensor === 'rewritten' &&
        mapSwitch.isAlreadyPatched(mpc)
      )
    ) {
      return `The program does not carry the ${MS_UPPER_SITES} accesses to the calibration's upper half and the two sensor-table readers the map switch rewrites (found ${upper}, readers ${sensor || 'unexpected'}), so it is not what the map switch was built for.`;
    }
    if (mapSwitch.isAlreadyPatched(mpc)) return null;
    for (let i = MAPSWITCH_FREE_START; i < MAPSWITCH_FREE_END; i++) {
      if (mpc[i] !== 0xff)
        return "The MPC's free area (0x6E550 up) is not empty, so it carries some other modification.";
    }
    for (const [start, end] of MS_POOLS) {
      for (let i = start; i < end; i++) {
        if (flash[i] !== 0xff)
          return `The external flash area for the maps (0x${start.toString(16).toUpperCase()}-0x${(end - 1).toString(16).toUpperCase()}) is not empty.`;
      }
    }
    const all = msEntriesFor(msCurrentVersion('dsc'));
    for (let i = 0; i < all.entries.length; i++) {
      if (msRead32(mpc, all.entries[i]) !== all.stock[i]) {
        return `The MPC does not carry the expected code at lookup routine 0x${all.entries[i].toString(16).toUpperCase()}.`;
      }
    }
    if (msRead32(mpc, MS_TACH_STORE_ADDR) !== MS_TACH_STORE_INSN)
      return 'The MPC does not carry the expected code at the engine speed frame builder.';
    if (
      msRead32(mpc, MS_MIL_STORE_ADDR) !== MS_MIL_STORE_INSN ||
      msRead32(mpc, MS_ECON_STORE_ADDR) !== MS_ECON_STORE_INSN
    ) {
      return 'The MPC does not carry the expected code at the lamp / fuel frame builder.';
    }
    for (let i = 0; i < 3; i++) {
      if (msRead32(mpc, MS_NV_DESCRIPTOR + 4 * i) !== MS_NV_STOCK[i])
        return "The MPC's stored-data table does not match the expected layout.";
    }
    return null;
  },
  /**
   * Why a calibration cannot be stored as an extra map, or null when it can.
   * @param {Uint8Array} calibration
   * @param {Uint8Array} map1
   * @param {number} [number] - The map's number, for the message.
   * @returns {string|null}
   */
  mapBlockedReason(calibration, map1, number = 2) {
    if (!calibration || calibration.length !== MAPSWITCH_CAL_LENGTH)
      return `Map ${number} is not a 0x1D000-byte calibration.`;
    const v1 = mapSwitch.readDataVersion(map1);
    const v2 = mapSwitch.readDataVersion(calibration);
    if (v1 == null || v2 == null || v1 !== v2) {
      return `Map ${number} is for data version ${v2 || '(unreadable)'} but map 1 is ${v1 || '(unreadable)'}. All maps must share one layout.`;
    }
    return null;
  },
  /** The earlier builds' rule for map 2, which also had to fit the full copy. */
  map2BlockedReason(calibration, map1) {
    const r = mapSwitch.mapBlockedReason(calibration, map1, 2);
    if (r) return r;
    for (let i = MAPSWITCH_MAP2_LENGTH; i < MAPSWITCH_CAL_LENGTH; i++) {
      if (calibration[i] !== 0xff) {
        return `Map 2 has data past offset 0x${MAPSWITCH_MAP2_LENGTH.toString(16).toUpperCase()}, which does not fit in the free flash area.`;
      }
    }
    return null;
  },
  /**
   * Patched copies of the pair. `map1` null keeps the calibration already in
   * the image; `maps` are the calibrations of maps 2..N (a single one may be
   * passed bare; null or empty stores one copy of map 1, so the build has
   * two maps). The caller's arrays are left alone. Checksums and signatures
   * are the caller's job afterwards.
   * @param {Uint8Array} flash
   * @param {Uint8Array} mpc
   * @param {Uint8Array|null} map1
   * @param {Uint8Array[]|Uint8Array|null} maps
   * @param {'dsc'|'shifter'|'pedals'} [trigger]
   * @param {number} [dscPresses]
   * @returns {{flash: Uint8Array, mpc: Uint8Array, wasAlreadyPatched: boolean, wasUpdated: boolean, mapsIdentical: boolean, maps: number, kbUsed: number, kbTotal: number, codeBytes: number, log: string[]}}
   */
  build(
    flash,
    mpc,
    map1,
    maps,
    trigger = 'dsc',
    dscPresses = MS_DEFAULT_DSC_PRESSES
  ) {
    if (!MS_TRIGGERS.includes(trigger))
      throw new Error(`unknown map switch trigger: ${trigger}`);
    if (trigger === 'dsc' && !MS_DSC_PRESS_CHOICES.includes(dscPresses))
      throw new Error('the DSC button trigger takes 2 or 4 presses');
    const list = msMapList(maps);
    if (list.length + 1 > MS_MAX_MAPS)
      throw new Error(
        `the map switch cycles through at most ${MS_MAX_MAPS} maps`
      );
    return msBuild(
      flash,
      mpc,
      map1,
      list,
      msCurrentVersion(
        trigger,
        dscPresses,
        Math.max(MS_MIN_MAPS, list.length + 1)
      )
    );
  },
  /** For tests: build an earlier version. */
  _buildVersion: (flash, mpc, map1, maps, version) =>
    msBuild(flash, mpc, map1, msMapList(maps), version),
  _version: msVersion,
  _buildCode: msBuildCode,
  _romTestSum: msRomTestSum,
  _calTestSum: msCalTestSum,
  _layout: msLayout,
  _R2_BLOCKS: MS_R2_BLOCKS,
  _upperSites: msUpperSites,
  _scanSites: msScanSites,
  _sitePlan: msSitePlan,
  _readSites: msReadSites,
  _SITES: MS_SITES,
  _CHUNK_TABLES_END: MS_CHUNK_TABLES_END,
  _sensorSitesState: msSensorSitesState,
  MAP1_ONLY: MS_MAP1_ONLY,
  UPPER_SITES: MS_UPPER_SITES,
  _HEADER: MS_HEADER,
  _POOLS: MS_POOLS,
};

function msMapList(maps) {
  if (!maps) return [];
  if (maps instanceof Uint8Array) return [maps];
  return maps.filter((m) => m);
}

/**
 * Generation 6's data: the stock instructions back at any earlier sites,
 * the scan, the plan, the site area and the chunks. Fills result.kbUsed /
 * kbTotal and logs per map.
 */
function msBuildSites(result, map1, maps, version) {
  const restored = result.wasAlreadyPatched ? msRestoreSites(result) : 0;
  if (result.wasAlreadyPatched) msEraseMapAreas(result.flash);
  const scan = msScanSites(result.flash, result.mpc);
  const plan = msSitePlan(scan, map1, maps);
  const siteLength = msSiteAreaLength(plan);
  const poolStart = (MS_SITES + siteLength + MS_CHUNK - 1) & ~(MS_CHUNK - 1);
  if (poolStart > MS_POOLS[0][1] - 4 * MS_CHUNK)
    throw new Error(
      `The maps change ${plan.scalars.length} single values read at ${plan.sites.length} places; the stubs for them (${siteLength} bytes) leave no room for the tables.`
    );
  const layout = msChunkLayout(map1, maps, plan, poolStart);
  if (!layout.ok) throw new Error(layout.reason);
  const sitesEnd = msWriteSites(result, plan);
  msWriteChunkLayout(result.flash, maps, layout, sitesEnd);
  const siteKb = (sitesEnd - MS_HEADER) / 1024;
  result.kbUsed = Math.round((siteKb + layout.chunksUsed / 4) * 10) / 10;
  result.kbTotal = Math.round(
    (MS_POOLS[0][1] - MS_HEADER + MS_POOLS[1][1] - MS_POOLS[1][0]) / 1024
  );
  result.perMapKb = layout.maps.map(
    (m) => Math.round((m.carried / 4) * 10) / 10
  );
  if (restored)
    result.log.push(
      `Sites: the stock instructions put back at the ${restored} the earlier build had patched`
    );
  result.log.push(
    `Sites: ${plan.scalars.length} single values differ between the maps, read at ${plan.sites.length} places; a stub for each at 0x${MS_SITES.toString(16).toUpperCase()} picks the selected map's value (${sitesEnd - MS_SITES} bytes with the header and chunk tables' ${(MS_SITES - MS_HEADER) / 1024} KB before it)`
  );
  if (plan.unswitchable.length) {
    const list = plan.unswitchable
      .slice(0, 6)
      .map((b) => `0x${b.toString(16).toUpperCase()}`)
      .join(', ');
    result.log.push(
      `WARNING: ${plan.unswitchable.length} differing bytes (${list}${plan.unswitchable.length > 6 ? ', ...' : ''}) are read in a way no stub can take over (a float or auto-update load); they are map 1's on every map`
    );
  }
  for (const m of layout.maps) {
    result.log.push(
      `Map ${m.index + 1}: ${m.differing} chunks of 256 bytes differ from map 1 beyond the single values; ${m.carried} stored (${result.perMapKb[m.index - 1]} KB), with map 1's calibration sum`
    );
  }
}

function msBuild(flash, mpc, map1, maps, version) {
  const blocked = mapSwitch.blockedReason(flash, mpc);
  if (blocked) throw new Error(blocked);
  const result = {
    flash: Uint8Array.from(flash),
    mpc: Uint8Array.from(mpc),
    wasAlreadyPatched: mapSwitch.isAlreadyPatched(mpc),
    wasUpdated: false,
    mapsIdentical: true,
    maps: version.maps,
    kbUsed: 0,
    kbTotal: 0,
    codeBytes: 0,
    log: [],
  };
  // an unpatched pair must carry the sum its own code gives; a patched one
  // may not: earlier builds left the stock value
  if (
    !result.wasAlreadyPatched &&
    msReadRomTestSum(flash) !== msRomTestSum(flash, mpc)
  ) {
    throw new Error(
      "the safety monitor's code sum in the program header does not match the code, so this pair is not what the map switch was built for"
    );
  }
  if (map1) {
    if (map1.length !== MAPSWITCH_CAL_LENGTH)
      throw new Error('map 1 is not a 0x1D000-byte calibration');
    result.flash.set(map1, MAPSWITCH_CAL_START);
    result.log.push('Map 1: replaced the calibration at 0x40000');
  } else {
    result.log.push('Map 1: kept the calibration already in the image');
  }
  const current1 = Uint8Array.from(
    result.flash.subarray(
      MAPSWITCH_CAL_START,
      MAPSWITCH_CAL_START + MAPSWITCH_CAL_LENGTH
    )
  );
  if (mapSwitch.readDataVersion(current1) == null)
    throw new Error(
      'the external flash has no tune in it; choose a map 1 tune'
    );
  // the monitor sums map 1's range through absolute addresses but reads the
  // value to compare with through r2, i.e. from whichever map is selected
  if (
    msRead32(result.flash, MS_CAL_TEST_RANGE_OFFSET) !==
      MS_CAL_TEST_RANGE_START ||
    msRead32(result.flash, MS_CAL_TEST_RANGE_OFFSET + 4) !==
      MS_CAL_TEST_RANGE_END
  ) {
    throw new Error(
      "the program header does not list the expected range for the safety monitor's calibration sum"
    );
  }
  const calSum = msCalTestSum(current1);
  if (msReadCalTestSum(current1, 0) !== calSum) {
    msWriteCalTestSum(result.flash, MAPSWITCH_CAL_START, calSum);
    msWriteCalTestSum(current1, 0, calSum);
    result.log.push(
      `Map 1: safety monitor's calibration sum at 0x${MS_CAL_TEST_SUM_OFFSET.toString(16).toUpperCase()} set to ${msHex16(calSum)}`
    );
  }
  const extras = maps.length ? maps : [current1];
  if (version.maps !== extras.length + 1)
    throw new Error(
      `this version cycles through ${version.maps} maps, but ${extras.length + 1} were given`
    );
  const differs = (cal) => {
    for (let i = 0; i < MAPSWITCH_CAL_LENGTH; i++)
      if (
        current1[i] !== cal[i] &&
        !(i >= MS_CAL_TEST_SUM_OFFSET && i < MS_CAL_TEST_SUM_OFFSET + 8)
      )
        return true;
    return false;
  };
  if (!msMulti(version)) {
    const second = extras[0];
    const map2Blocked = mapSwitch.map2BlockedReason(second, current1);
    if (map2Blocked) throw new Error(map2Blocked);
    if (result.wasAlreadyPatched) msEraseMapAreas(result.flash);
    result.flash.set(
      second.subarray(0, MAPSWITCH_MAP2_LENGTH),
      MAPSWITCH_MAP2_START
    );
    result.log.push(
      maps.length
        ? 'Map 2: stored at 0xE0000'
        : 'Map 2: stored a copy of map 1 at 0xE0000'
    );
    if (msReadCalTestSum(result.flash, MAPSWITCH_MAP2_START) !== calSum) {
      msWriteCalTestSum(result.flash, MAPSWITCH_MAP2_START, calSum);
      result.log.push(
        `Map 2: given map 1's calibration sum, ${msHex16(calSum)}, which the safety monitor reads from the selected map`
      );
    }
    result.mapsIdentical = !differs(second);
    result.kbUsed = MAPSWITCH_MAP2_LENGTH / 1024;
    result.kbTotal = MAPSWITCH_MAP2_LENGTH / 1024;
  } else {
    const prepared = [];
    for (let i = 0; i < extras.length; i++) {
      const reason = mapSwitch.mapBlockedReason(extras[i], current1, i + 2);
      if (reason) throw new Error(reason);
      const cal = Uint8Array.from(extras[i]);
      msWriteCalTestSum(cal, 0, calSum);
      prepared.push(cal);
      if (differs(cal)) result.mapsIdentical = false;
      for (const [start, end, what] of MS_MAP1_ONLY) {
        let same = true;
        for (let k = start; k < end && same; k++)
          if (cal[k] !== current1[k]) same = false;
        if (!same)
          result.log.push(
            `Map ${i + 2}: differs from map 1 in ${what}, which the program reads from map 1 whichever map is selected`
          );
      }
    }
    if (version.gen >= MS_SITE_GEN) {
      msBuildSites(result, current1, prepared, version);
      result.log.push(
        `Maps: ${version.maps} in all, ${result.kbUsed} of ${result.kbTotal} KB of map flash used, header and chunk tables at 0x${MS_HEADER.toString(16).toUpperCase()}, sites at 0x${MS_SITES.toString(16).toUpperCase()}`
      );
    } else {
      const layout = msLayout(current1, prepared);
      if (!layout.ok) throw new Error(layout.reason);
      if (result.wasAlreadyPatched) msEraseMapAreas(result.flash);
      msWriteLayout(result.flash, prepared, layout);
      result.kbUsed = layout.blocksUsed;
      result.kbTotal = layout.blocksTotal;
      for (const m of layout.maps) {
        result.log.push(
          `Map ${m.index + 1}: ${m.differing} KB differ from map 1; ${msKb(m.carried)} stored` +
            ` (${msKb(m.windowBlocks)} in the r2 window at 0x${(m.windowBase * MS_BLOCK).toString(16).toUpperCase()}` +
            `${m.carried > m.windowBlocks ? `, ${msKb(m.carried - m.windowBlocks)} elsewhere` : ''}), with map 1's calibration sum`
        );
      }
      result.log.push(
        `Maps: ${version.maps} in all, ${msKb(layout.blocksUsed)} of ${msKb(layout.blocksTotal)} map flash used, header and block tables at 0x${MS_HEADER.toString(16).toUpperCase()}`
      );
    }
  }

  const built = msBuildCode(version);
  result.codeBytes = built.code.length;
  const correctRomSum = () => {
    const sum = msRomTestSum(result.flash, result.mpc);
    if (msReadRomTestSum(result.flash) === sum) return;
    msWrite32(
      result.flash,
      MS_ROM_TEST_SUM_OFFSET,
      Number((sum >> 32n) & 0xffffffffn)
    );
    msWrite32(
      result.flash,
      MS_ROM_TEST_SUM_OFFSET + 4,
      Number(sum & 0xffffffffn)
    );
    result.log.push(
      `Safety monitor: code sum at 0x${MS_ROM_TEST_SUM_OFFSET.toString(16).toUpperCase()} set to ${msHex16(sum)}`
    );
  };
  const describe = (v) =>
    `${mapSwitch.describeTrigger(v.trigger, v.presses)}, ${mapSwitch.describeScope(v.scope)}, ${v.maps} maps`;
  const rewriteUpper = () => {
    if (version.gen !== MS_WINDOW_POINTER_GEN) return; // generation 5's way; 6 leaves r2 at map 1
    const n = msRewriteUpper(result);
    result.log.push(
      n
        ? `Code: ${n} accesses to the calibration's upper half (0x8000 up, through r2 + 0x10000) and the MAF table readers now read map 1's: lis rX for addis rX, r2`
        : "Code: the accesses to the calibration's upper half and the MAF table readers already read map 1's"
    );
  };
  if (msCarriesVersion(mpc, version)) {
    result.log.push(
      `Code: image already carries this version of the map switch (${describe(version)}), left unchanged`
    );
    rewriteUpper();
    correctRomSum();
    return result;
  }
  if (result.wasAlreadyPatched) {
    const was = msVersionOf(mpc);
    for (let i = MAPSWITCH_FREE_START; i < MAPSWITCH_FREE_END; i++)
      result.mpc[i] = 0xff;
    msWrite32(result.mpc, MS_MIL_STORE_ADDR, MS_MIL_STORE_INSN);
    msWrite32(result.mpc, MS_ECON_STORE_ADDR, MS_ECON_STORE_INSN);
    msWrite32(result.mpc, MS_LOOKUP_ENTRY_17, MS_LOOKUP_STOCK_17);
    result.wasUpdated = true;
    if (!was)
      result.log.push('Code: replaced an earlier build of the map switch');
    else if (
      was.trigger === version.trigger &&
      was.scope === version.scope &&
      was.presses === version.presses &&
      was.maps === version.maps
    ) {
      result.log.push('Code: replaced the earlier version of the map switch');
    } else {
      result.log.push(`Code: replaced the map switch, was ${describe(was)}`);
    }
  }
  result.mpc.set(built.code, MAPSWITCH_FREE_START);
  for (let i = 0; i < built.entries.length; i++)
    msWrite32(
      result.mpc,
      built.entries[i],
      msBranch(built.entries[i], built.lookupStubs[i], false)
    );
  msWrite32(
    result.mpc,
    MS_TACH_STORE_ADDR,
    msBranch(MS_TACH_STORE_ADDR, built.tachStub, true)
  );
  if (msLampHook(version))
    msWrite32(
      result.mpc,
      MS_MIL_STORE_ADDR,
      msBranch(MS_MIL_STORE_ADDR, built.runStub, true)
    );
  for (let i = 0; i < 3; i++)
    msWrite32(result.mpc, MS_NV_DESCRIPTOR + 4 * i, built.nvStubs[i]);
  result.log.push(
    `Code: ${built.entries.length} lookup hooks, gesture/tach routine and stored-data routines, ${built.code.length} bytes at ` +
      `MPC 0x${MAPSWITCH_FREE_START.toString(16).toUpperCase()}, trigger: ${mapSwitch.describeTrigger(version.trigger, version.presses)}, ` +
      `switches ${mapSwitch.describeScope(version.scope)}, cycles through ${version.maps} maps`
  );
  rewriteUpper();
  correctRomSum();
  return result;
}

if (typeof window !== 'undefined') window.mapSwitch = mapSwitch;
if (typeof module !== 'undefined' && module.exports)
  module.exports = { mapSwitch };
