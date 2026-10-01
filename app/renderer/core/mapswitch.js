// Two-map switching for the MS45.1, program 0044570LO02S. Ported from
// BMWeb-Flasher's MapSwitch.cs, whose build has run on the car.
//
// What the patch does:
//   - A second calibration ("map 2") is stored in the empty external flash at
//     0xE0000-0xF7FFF. The program addresses the calibration as 0xFFE40000+,
//     so map 2 is the same address plus 0xA0000.
//   - Every table/axis lookup goes through 16 routines in the MPC that take the
//     table pointer in r3. Each gets a hook: when the map flag is set and r3
//     points into the calibration, 0xA0000 is added.
//   - Single values are read relative to r2, so the full-tune build moves r2
//     by 0xA0000 while map 2 is selected: at stored-data restore and at the
//     gesture.
//   - The routine that builds CAN frame 0x316 (engine speed for the cluster)
//     is hooked where it stores the rpm: the chosen trigger toggles the map
//     (the DSC button pressed 2 or 4 times, or brake + full throttle for 5 s
//     with the engine stopped). Engine stopped, the tach shows 1000 rpm for
//     map 1 or 2000 for map 2 (also 3 s at ignition-on); engine running, the
//     check-engine lamp blinks once for map 1, twice for map 2.
//   - The selection is kept in bit 7 of stored-data block 56.
//   - The safety monitor's code sum and calibration sum are brought up to date.
//
// Checksums and signatures are NOT computed here: the caller runs the pair
// through ms45Checksums, as for any other program flash.
/* exported mapSwitch */

const MAPSWITCH_PROGRAM_VERSION = '0044570LO02S';
const MAPSWITCH_FULL_FLASH_LENGTH = 0x100000;
const MAPSWITCH_MPC_LENGTH = 0x70000;
const MAPSWITCH_CAL_START = 0x40000;
const MAPSWITCH_CAL_LENGTH = 0x1d000;
const MAPSWITCH_MAP2_START = 0xe0000;
const MAPSWITCH_MAP2_LENGTH = 0x18000;
const MAPSWITCH_PROGRAM_VERSION_OFFSET = 0x6031c;
const MAPSWITCH_DATA_VERSION_OFFSET = 0x10;
const MAPSWITCH_DATA_VERSION_LENGTH = 12;
const MAPSWITCH_FREE_START = 0x6e550;
const MAPSWITCH_FREE_END = 0x70000;
const MAPSWITCH_R13 = 0x004017f0;

const MS_LOOKUP_ENTRIES = [
  0xcfc8, 0xd054, 0xd0e4, 0xd178, 0xd210, 0xd264, 0xd2c0, 0xd31c, 0xd380, 0xd38c, 0xd39c, 0xd3b8, 0xd3dc, 0xd44c, 0xd4c0, 0xd660,
];
const MS_LOOKUP_STOCK = [
  0x89830000, 0x88e30000, 0xa1830000, 0xa0e30000, 0x88a30000, 0x88a30000, 0xa0a30000, 0xa0a30000, 0x898dd7c6, 0x898dd7c6,
  0x898dd7c6, 0x898dd7c6, 0x38e30000, 0x38e30000, 0x88add7c4, 0x88add7c4,
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
const MS_VAR_ENGINE_SPEED = -0x4bec;
const MS_VAR_VEHICLE_SPEED = -0x3f95;
const MS_VAR_PEDAL = -0x4061;
const MS_VAR_BRAKE_A = -0x4001;
const MS_VAR_BRAKE_B = -0x4002;
const MS_VAR_DSC_STATE = -0x3b44;
const MS_DSC_STATE_MASK = 0x02;
const MS_FIRST_VAR_DSC_STATE = -0x3b3d;
const MS_FIRST_DSC_STATE_MASK = 0x0c;
const MS_RAM_FLAG = 0x3fa195;
const MS_RAM_HOLD_COUNTER = 0x3fa196;
const MS_RAM_DISPLAY_COUNTER = 0x3fa1ed;
const MS_RAM_PRESS_COUNTER = MS_RAM_DISPLAY_COUNTER;
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
const MS_STARTUP_DISPLAY_CALLS = 3 * MS_CALLS_PER_SECOND;
const MS_STARTUP_DELAY_CALLS = 6 * MS_CALLS_PER_SECOND;
const MS_PEDAL_FULL = 0xf0;
const MS_PEDAL_RELEASED = 0x20;
const MS_MAP2_DELTA_HIGH = 0x000a;
const MS_R2_HIGH = -0x1c;
const MS_R2_LOW = 0x7ff0;
const MS_ROM_TEST_SUM_OFFSET = 0x60600;
const MS_ROM_TEST_RANGES_OFFSET = 0x60608;
const MS_ROM_TEST_RANGES = [0x0000bae8, 0x0000f5f8, 0xfff60630, 0xfff68c2c, 0x00000140, 0x000002d4];
const MS_ROM_TEST_SEED = 0x0123456789abcdefn;
const MS_U64 = (1n << 64n) - 1n;
const MS_CALIBRATION_RANGE_TAG = 0x7ff2;
const MS_CAL_TEST_RANGE_OFFSET = MS_ROM_TEST_RANGES_OFFSET + 4 * 6;
const MS_CALIBRATION_BASE = 0xffe40000;
const MS_CAL_TEST_RANGE_START = 0xffe40240;
const MS_CAL_TEST_RANGE_END = 0xffe407c8;
const MS_CAL_TEST_SUM_OFFSET = 0x57dc;
const MS_CAR_CHECK_LENGTH = 0x600;
const MS_CURRENT_GEN = 3;

// ---- a minimal PowerPC assembler: just the instructions used --------------------------
function msS16(v) {
  if (v < -0x8000 || v > 0x7fff) throw new Error(`signed 16-bit operand out of range: ${v}`);
  return v & 0xffff;
}
function msU16(v) {
  if (v < 0 || v > 0xffff) throw new Error(`unsigned 16-bit operand out of range: ${v}`);
  return v;
}
function msD(op, rt, ra, imm) {
  return ((op << 26) | (rt << 21) | (ra << 16) | imm) >>> 0;
}
const Lbz = (rt, d, ra) => msD(34, rt, ra, msS16(d));
const Lhz = (rt, d, ra) => msD(40, rt, ra, msS16(d));
const Stb = (rs, d, ra) => msD(38, rs, ra, msS16(d));
const Sth = (rs, d, ra) => msD(44, rs, ra, msS16(d));
const Li = (rt, v) => msD(14, rt, 0, msS16(v));
const Addi = (rt, ra, v) => msD(14, rt, ra, msS16(v));
const Addis = (rt, ra, v) => msD(15, rt, ra, msS16(v));
const Lis = (rt, v) => Addis(rt, 0, v);
const Cmpwi = (ra, v) => msD(11, 0, ra, msS16(v));
const Cmplwi = (ra, v) => msD(10, 0, ra, msU16(v));
const Cmpw = (ra, rb) => ((31 << 26) | (ra << 16) | (rb << 11)) >>> 0;
const AndiDot = (ra, rs, v) => msD(28, rs, ra, msU16(v));
const Ori = (ra, rs, v) => msD(24, rs, ra, msU16(v));
const Xori = (ra, rs, v) => msD(26, rs, ra, msU16(v));
const Rlwinm = (ra, rs, sh, mb, me) => ((21 << 26) | (rs << 21) | (ra << 16) | (sh << 11) | (mb << 6) | (me << 1)) >>> 0;
const Srwi = (ra, rs, n) => Rlwinm(ra, rs, 32 - n, n, 31);
const Or = (ra, rs, rb) => ((31 << 26) | (rs << 21) | (ra << 16) | (rb << 11) | (444 << 1)) >>> 0;
const MS_BLR = 0x4e800020;
const MS_BEQ = [12, 2];
const MS_BNE = [4, 2];
const MS_BLT = [12, 0];
const MS_BGE = [4, 0];

function msBranch(from, to, link) {
  const d = to - from;
  if (d < -0x2000000 || d >= 0x2000000 || d & 3) throw new Error('branch out of range');
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
        if (d < -0x8000 || d >= 0x8000) throw new Error('conditional branch out of range');
        out.push(((16 << 26) | (it.bo << 21) | (it.bi << 16) | (d & 0xfffc)) >>> 0);
      } else if (it.address != null) out.push(msBranch(pc, it.address, false));
      else out.push(msBranch(pc, this._labels.get(it.label), false));
    }
    return out;
  }
}

function msRead32(data, at) {
  return ((data[at] << 24) | (data[at + 1] << 16) | (data[at + 2] << 8) | data[at + 3]) >>> 0;
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

// ---- versions ---------------------------------------------------------------------------------
/**
 * A version of the code: what triggers the switch and how the map is shown.
 * @typedef {Object} MsVersion
 * @property {'dsc'|'pedals'} trigger
 * @property {'none'|'immediate'|'delayed'|'immediateLong'} startup
 * @property {'car'|'first'} watch
 * @property {'mapsOnly'|'fullTune'} scope
 * @property {number} presses
 * @property {boolean} whileRunning
 * @property {number} gen
 */
function msVersion(trigger, startup, watch = 'car', scope = 'mapsOnly', presses = MS_DEFAULT_DSC_PRESSES, whileRunning = false, gen = 0) {
  return {
    trigger,
    startup,
    watch: trigger === 'dsc' ? watch : 'car',
    scope,
    presses: trigger === 'dsc' ? presses : 0,
    whileRunning: trigger === 'dsc' && whileRunning,
    gen,
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
    a.gen === b.gen
  );
}
const msLampHook = (v) => v.whileRunning && v.gen >= 3;
const msLockout = (v) => v.trigger === 'dsc' && v.gen >= 3;
function msCurrentVersion(trigger, presses = MS_DEFAULT_DSC_PRESSES) {
  return msVersion(trigger, 'immediateLong', 'car', 'fullTune', presses, true, MS_CURRENT_GEN);
}
function msIsCurrent(v) {
  return msVersionEq(v, msCurrentVersion(v.trigger, v.presses)) && (v.trigger !== 'dsc' || MS_DSC_PRESS_CHOICES.includes(v.presses));
}
const MS_KNOWN_VERSIONS = [
  msCurrentVersion('dsc', 4),
  msCurrentVersion('dsc', 2),
  msCurrentVersion('pedals'),
  msVersion('pedals', 'immediateLong', 'car', 'fullTune'),
  msVersion('dsc', 'immediateLong', 'car', 'fullTune', 4),
  msVersion('dsc', 'immediateLong', 'car', 'fullTune', 2),
  msVersion('dsc', 'immediateLong', 'car', 'mapsOnly'),
  msVersion('pedals', 'immediateLong', 'car', 'mapsOnly'),
  msVersion('dsc', 'immediateLong', 'first'),
  msVersion('pedals', 'immediate'),
  msVersion('pedals', 'none'),
  msVersion('pedals', 'delayed'),
];

// ---- the code -----------------------------------------------------------------------------------
function msLookupStub(at, entry, stockInsn) {
  const a = new MsAsm(at);
  a.emit(Lbz(0, msOff(MS_RAM_FLAG), 13));
  a.emit(AndiDot(0, 0, 1));
  a.bc(MS_BEQ, 'run');
  a.emit(Srwi(0, 3, 17));
  a.emit(Cmplwi(0, MS_CALIBRATION_RANGE_TAG));
  a.bc(MS_BNE, 'run');
  a.emit(Addis(3, 3, MS_MAP2_DELTA_HIGH));
  a.label('run');
  a.emit(stockInsn);
  a.branchTo(entry + 4);
  return a;
}

function msEmitBaseRegister(a, flagReg, scope, label) {
  if (scope !== 'fullTune') return;
  a.emit(Lis(2, MS_R2_HIGH));
  a.emit(Ori(2, 2, MS_R2_LOW));
  a.emit(AndiDot(0, flagReg, 1));
  a.bc(MS_BEQ, label);
  a.emit(Addis(2, 2, MS_MAP2_DELTA_HIGH));
  a.label(label);
}

function msEmitDscGesture(a, flag, count, indicate, watch, scope, pressesToToggle, whileRunning, lockout) {
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
  a.emit(Xori(11, 11, 1));
  a.emit(Stb(11, flag, 13));
  msEmitBaseRegister(a, 11, scope, 'base');
  a.emit(Li(12, 0));
  a.emit(Sth(12, count, 13));
  a.emit(Stb(12, presses, 13));
  a.emit(Li(12, 1));
  a.emit(Stb(12, MS_NV_SAVE_REQUEST, 13));
  if (whileRunning) {
    a.emit(Lhz(12, MS_VAR_ENGINE_SPEED, 13));
    a.emit(Cmpwi(12, 0));
    a.bc(MS_BNE, 'blink');
    indicate(11);
    a.b('show');
    a.label('blink');
    a.emit(AndiDot(12, 11, 1));
    a.emit(Addi(12, 12, 1));
    a.emit(Stb(12, msOff(MS_RAM_BLINKS), 13));
    a.emit(Li(12, 0));
    a.emit(Stb(12, msOff(MS_RAM_BLINK_PHASE), 13));
    a.b('show');
  } else {
    indicate(11);
    a.b('show');
  }
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

function msEmitPedalGesture(a, flag, count, indicate, scope) {
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
  a.emit(AndiDot(0, 11, 2));
  a.bc(MS_BNE, 'show');
  a.emit(Lhz(12, count, 13));
  a.emit(Addi(12, 12, 1));
  a.emit(Sth(12, count, 13));
  a.emit(Cmplwi(12, MS_HOLD_CALLS));
  a.bc(MS_BLT, 'show');
  a.emit(Xori(11, 11, 1));
  a.emit(Ori(11, 11, 2));
  a.emit(Stb(11, flag, 13));
  msEmitBaseRegister(a, 11, scope, 'base');
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
  a.emit(AndiDot(11, 11, 1));
  a.emit(Stb(11, flag, 13));
}

function msTachStub(at, version) {
  const flag = msOff(MS_RAM_FLAG);
  const count = msOff(MS_RAM_HOLD_COUNTER);
  const delay = msOff(MS_RAM_STARTUP_DELAY);
  const delayed = version.startup === 'delayed';
  const dsc = version.trigger === 'dsc';
  const wide = version.startup === 'immediateLong';
  const disp = msOff(wide ? MS_RAM_WIDE_DISPLAY_COUNTER : MS_RAM_DISPLAY_COUNTER);
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
  if (dsc) {
    msEmitDscGesture(a, flag, count, indicate, version.watch, version.scope, version.presses, version.whileRunning, msLockout(version));
  } else {
    msEmitPedalGesture(a, flag, count, indicate, version.scope);
  }
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
  a.emit(AndiDot(11, 11, 1));
  a.emit(Li(3, MS_TACH_1000));
  a.bc(MS_BEQ, 'store');
  a.emit(Li(3, MS_TACH_2000));
  a.b('store');
  if (!version.whileRunning) {
    a.label('running');
    a.emit(Li(12, 0));
    a.emit(Sth(12, count, 13));
    a.emit(storeDisp(12, disp, 13));
    if (dsc) a.emit(Stb(12, msOff(MS_RAM_PRESS_COUNTER), 13));
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
  if (version.trigger === 'dsc') a.emit(Stb(12, msOff(MS_RAM_PRESS_COUNTER), 13));
  if (version.whileRunning) {
    a.emit(Stb(12, msOff(MS_RAM_BLINKS), 13));
    a.emit(Stb(12, msOff(MS_RAM_BLINK_PHASE), 13));
  }
  if (msLockout(version)) {
    a.emit(Li(12, MS_STARTUP_LOCKOUT_CALLS));
    a.emit(Sth(12, msOff(MS_RAM_STARTUP_LOCKOUT), 13));
    a.emit(Li(12, 0));
  }
  msEmitBaseRegister(a, 12, version.scope, 'base');
  if (version.gen === 0) msEmitStartup(a, 12, version.startup);
  a.emit(MS_BLR);
  return a;
}

function msNvRestore(at, version) {
  const a = new MsAsm(at);
  a.emit(Lbz(12, 0, 3));
  a.emit(Srwi(11, 12, 7));
  a.emit(Stb(11, msOff(MS_RAM_FLAG), 13));
  a.emit(AndiDot(12, 12, 0x7f));
  a.emit(Stb(12, MS_NV_VAR, 13));
  msEmitBaseRegister(a, 11, version.scope, 'base');
  a.emit(Li(11, 0));
  a.emit(Sth(11, msOff(MS_RAM_HOLD_COUNTER), 13));
  if (version.trigger === 'dsc') a.emit(Stb(11, msOff(MS_RAM_PRESS_COUNTER), 13));
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

function msNvSave(at) {
  const a = new MsAsm(at);
  a.emit(Lbz(12, MS_NV_VAR, 13));
  a.emit(Lbz(11, msOff(MS_RAM_FLAG), 13));
  a.emit(Rlwinm(11, 11, 7, 24, 24));
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
function msBuildCode(version) {
  const all = [];
  const here = () => MAPSWITCH_FREE_START + 4 * all.length;
  const lookupStubs = [];
  for (let i = 0; i < MS_LOOKUP_ENTRIES.length; i++) {
    lookupStubs.push(here());
    all.push(...msLookupStub(here(), MS_LOOKUP_ENTRIES[i], MS_LOOKUP_STOCK[i]).words());
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
  all.push(...msNvSave(here()).words());
  const code = new Uint8Array(4 * all.length);
  for (let i = 0; i < all.length; i++) msWrite32(code, 4 * i, all[i]);
  if (MAPSWITCH_FREE_START + code.length > MAPSWITCH_FREE_END) throw new Error('map switch code does not fit in the MPC free area');
  return { code, lookupStubs, tachStub, runStub, nvStubs };
}

// ---- inspection ---------------------------------------------------------------------------------
function msCarriesVersion(mpc, version) {
  if (!mpc || mpc.length !== MAPSWITCH_MPC_LENGTH) return false;
  const built = msBuildCode(version);
  for (let i = 0; i < built.code.length; i++) if (mpc[MAPSWITCH_FREE_START + i] !== built.code[i]) return false;
  for (let i = MAPSWITCH_FREE_START + built.code.length; i < MAPSWITCH_FREE_END; i++) if (mpc[i] !== 0xff) return false;
  for (let i = 0; i < MS_LOOKUP_ENTRIES.length; i++) {
    if (msRead32(mpc, MS_LOOKUP_ENTRIES[i]) !== msBranch(MS_LOOKUP_ENTRIES[i], built.lookupStubs[i], false)) return false;
  }
  if (msRead32(mpc, MS_TACH_STORE_ADDR) !== msBranch(MS_TACH_STORE_ADDR, built.tachStub, true)) return false;
  const milExpected = msLampHook(version) ? msBranch(MS_MIL_STORE_ADDR, built.runStub, true) : MS_MIL_STORE_INSN;
  if (msRead32(mpc, MS_MIL_STORE_ADDR) !== milExpected) return false;
  if (msRead32(mpc, MS_ECON_STORE_ADDR) !== MS_ECON_STORE_INSN) return false;
  for (let i = 0; i < 3; i++) if (msRead32(mpc, MS_NV_DESCRIPTOR + 4 * i) !== built.nvStubs[i]) return false;
  return true;
}

function msVersionOf(mpc) {
  for (const v of MS_KNOWN_VERSIONS) if (msCarriesVersion(mpc, v)) return v;
  return null;
}

function msBranchesIntoFreeArea(mpc, at, link) {
  const insn = msRead32(mpc, at);
  if ((insn & 0xfc000003) >>> 0 !== (link ? 0x48000001 : 0x48000000)) return false;
  let offset = insn & 0x03fffffc;
  if (offset & 0x02000000) offset -= 0x04000000;
  const target = at + offset;
  return target >= MAPSWITCH_FREE_START && target < MAPSWITCH_FREE_END;
}

/** Whether the free area begins with this module's lookup stubs, which every build shares. */
function msLooksLikeOurCode(freeArea) {
  const built = msBuildCode(msCurrentVersion('dsc'));
  const lookupBytes = built.tachStub - MAPSWITCH_FREE_START;
  if (freeArea.length < lookupBytes) return false;
  for (let i = 0; i < lookupBytes; i++) if (freeArea[i] !== built.code[i]) return false;
  return true;
}

function msCarriesSomeBuild(mpc) {
  if (!mpc || mpc.length !== MAPSWITCH_MPC_LENGTH) return false;
  if (!msLooksLikeOurCode(mpc.subarray(MAPSWITCH_FREE_START, MAPSWITCH_FREE_START + MS_CAR_CHECK_LENGTH))) return false;
  for (const e of MS_LOOKUP_ENTRIES) if (!msBranchesIntoFreeArea(mpc, e, false)) return false;
  if (!msBranchesIntoFreeArea(mpc, MS_TACH_STORE_ADDR, true)) return false;
  if (msRead32(mpc, MS_MIL_STORE_ADDR) !== MS_MIL_STORE_INSN && !msBranchesIntoFreeArea(mpc, MS_MIL_STORE_ADDR, true)) return false;
  if (msRead32(mpc, MS_ECON_STORE_ADDR) !== MS_ECON_STORE_INSN && !msBranchesIntoFreeArea(mpc, MS_ECON_STORE_ADDR, true)) return false;
  for (let i = 0; i < 3; i++) {
    const fn = msRead32(mpc, MS_NV_DESCRIPTOR + 4 * i);
    if (fn < MAPSWITCH_FREE_START || fn >= MAPSWITCH_FREE_END) return false;
  }
  return true;
}

function msFreeAreaMatches(freeArea, code) {
  for (let i = 0; i < freeArea.length; i++) if (freeArea[i] !== (i < code.length ? code[i] : 0xff)) return false;
  return true;
}
function msCheckFreeArea(freeArea) {
  if (!freeArea || freeArea.length !== MS_CAR_CHECK_LENGTH) {
    throw new Error(`expected the first 0x${MS_CAR_CHECK_LENGTH.toString(16).toUpperCase()} bytes of the MPC's free area`);
  }
}
function msVersionOnCar(freeArea) {
  msCheckFreeArea(freeArea);
  for (const v of MS_KNOWN_VERSIONS) {
    const { code } = msBuildCode(v);
    if (code.length <= MS_CAR_CHECK_LENGTH && msFreeAreaMatches(freeArea, code)) return v;
  }
  return null;
}

// ---- the safety monitor's sums -------------------------------------------------------------------
function msRomTestSum(flash, mpc) {
  let sum = MS_ROM_TEST_SEED;
  for (let i = 0; i < MS_ROM_TEST_RANGES.length; i += 2) {
    const start = MS_ROM_TEST_RANGES[i];
    const end = MS_ROM_TEST_RANGES[i + 1];
    if (msRead32(flash, MS_ROM_TEST_RANGES_OFFSET + 4 * i) !== start || msRead32(flash, MS_ROM_TEST_RANGES_OFFSET + 4 * i + 4) !== end) {
      throw new Error("the program header does not list the expected ranges for the safety monitor's code sum");
    }
    const inMpc = end <= MAPSWITCH_MPC_LENGTH;
    const image = inMpc ? mpc : flash;
    let offset = inMpc ? start : start & 0xfffff;
    for (let n = (end - start) / 4; n > 0; n--, offset += 4) sum = (sum + BigInt(msRead32(image, offset))) & MS_U64;
  }
  return sum;
}
function msReadRomTestSum(flash) {
  return (BigInt(msRead32(flash, MS_ROM_TEST_SUM_OFFSET)) << 32n) | BigInt(msRead32(flash, MS_ROM_TEST_SUM_OFFSET + 4));
}
function msCalTestSum(cal) {
  let sum = MS_ROM_TEST_SEED;
  for (let o = MS_CAL_TEST_RANGE_START - MS_CALIBRATION_BASE; o < MS_CAL_TEST_RANGE_END - MS_CALIBRATION_BASE; o += 4) {
    sum = (sum + BigInt(msRead32(cal, o))) & MS_U64;
  }
  return sum;
}
function msReadCalTestSum(image, calOffset) {
  return (BigInt(msRead32(image, calOffset + MS_CAL_TEST_SUM_OFFSET)) << 32n) | BigInt(msRead32(image, calOffset + MS_CAL_TEST_SUM_OFFSET + 4));
}
function msWriteCalTestSum(image, calOffset, sum) {
  msWrite32(image, calOffset + MS_CAL_TEST_SUM_OFFSET, Number((sum >> 32n) & 0xffffffffn));
  msWrite32(image, calOffset + MS_CAL_TEST_SUM_OFFSET + 4, Number(sum & 0xffffffffn));
}
const msHex16 = (v) => v.toString(16).toUpperCase().padStart(16, '0');

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
  MAP2_DATA_VERSION_OFFSET: MAPSWITCH_MAP2_START + MAPSWITCH_DATA_VERSION_OFFSET,
  DATA_VERSION_LENGTH: MAPSWITCH_DATA_VERSION_LENGTH,
  DSC_PRESS_CHOICES: MS_DSC_PRESS_CHOICES,
  DEFAULT_DSC_PRESSES: MS_DEFAULT_DSC_PRESSES,
  DEFAULT_TRIGGER: 'dsc',
  /** RAM worth reading on a car to see the trigger work. */
  RAM: {
    canAsc1: 0x3fdcac,
    dscState: MAPSWITCH_R13 + MS_VAR_DSC_STATE,
    engineSpeed: MAPSWITCH_R13 + MS_VAR_ENGINE_SPEED,
    vehicleSpeed: MAPSWITCH_R13 + MS_VAR_VEHICLE_SPEED,
    tach: MAPSWITCH_R13 + MS_TACH_VAR,
    flag: MS_RAM_FLAG,
  },

  /**
   * @param {'dsc'|'pedals'} trigger - The trigger.
   * @param {number} [presses] - DSC presses.
   * @returns {string}
   */
  describeTrigger(trigger, presses = MS_DEFAULT_DSC_PRESSES) {
    return trigger === 'dsc' ? `DSC button pressed ${presses} times` : 'brake + full throttle held 5 s';
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
    return msReadAscii(cal, MAPSWITCH_DATA_VERSION_OFFSET, MAPSWITCH_DATA_VERSION_LENGTH);
  },
  /** The data version in a field read from the car, or null. @param {Uint8Array} field @returns {string|null} */
  dataVersionFrom(field) {
    return field && field.length === MAPSWITCH_DATA_VERSION_LENGTH ? msReadAscii(field, 0, MAPSWITCH_DATA_VERSION_LENGTH) : null;
  },
  /** @param {Uint8Array} flash @param {Uint8Array} mpc @returns {boolean} */
  hasMap2(flash, mpc) {
    if (!flash || flash.length !== MAPSWITCH_FULL_FLASH_LENGTH || !mapSwitch.isAlreadyPatched(mpc)) return false;
    return msReadAscii(flash, MAPSWITCH_MAP2_START + MAPSWITCH_DATA_VERSION_OFFSET, MAPSWITCH_DATA_VERSION_LENGTH) != null;
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
   * The trigger, presses and scope a patched MPC carries; null when it is not patched.
   * @param {Uint8Array} mpc
   * @returns {{trigger: string, presses: number, scope: string}|null}
   */
  installed(mpc) {
    const v = msVersionOf(mpc);
    return v ? { trigger: v.trigger, presses: v.presses, scope: v.scope } : null;
  },
  /**
   * What the first CAR_CHECK_LENGTH bytes of the MPC's free area, as read from
   * a car, say: 'notInstalled', 'current', 'earlier' or 'unrecognised', with the
   * trigger / presses / scope when known.
   * @param {Uint8Array} freeArea
   * @returns {{state: string, trigger: string|null, presses: number|null, scope: string|null}}
   */
  stateOnCar(freeArea) {
    msCheckFreeArea(freeArea);
    if (msFreeAreaMatches(freeArea, new Uint8Array(0))) return { state: 'notInstalled', trigger: null, presses: null, scope: null };
    const v = msVersionOnCar(freeArea);
    if (!v) return { state: msLooksLikeOurCode(freeArea) ? 'earlier' : 'unrecognised', trigger: null, presses: null, scope: null };
    return { state: msIsCurrent(v) ? 'current' : 'earlier', trigger: v.trigger, presses: v.presses, scope: v.scope };
  },
  /**
   * Turn the map 2 area, as read from a car, back into the tune it was stored from.
   * @param {Uint8Array} map2Area - The 0x18000 bytes at 0xE0000.
   * @returns {Uint8Array|null}
   */
  map2AsCalibration(map2Area) {
    if (!map2Area || map2Area.length !== MAPSWITCH_MAP2_LENGTH) {
      throw new Error(`expected the 0x${MAPSWITCH_MAP2_LENGTH.toString(16).toUpperCase()} bytes of the map 2 area`);
    }
    if (msReadAscii(map2Area, MAPSWITCH_DATA_VERSION_OFFSET, MAPSWITCH_DATA_VERSION_LENGTH) == null) return null;
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
    if (file.length === MAPSWITCH_FULL_FLASH_LENGTH) return Uint8Array.from(file.subarray(MAPSWITCH_CAL_START, MAPSWITCH_CAL_START + MAPSWITCH_CAL_LENGTH));
    if (file.length >= MAPSWITCH_CAL_LENGTH && file.length <= 0x20000) return Uint8Array.from(file.subarray(0, MAPSWITCH_CAL_LENGTH));
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
    if (!flash || flash.length !== MAPSWITCH_FULL_FLASH_LENGTH) return 'Map switch needs a full 1 MB external flash image.';
    if (!mpc || mpc.length !== MAPSWITCH_MPC_LENGTH) return 'Map switch needs the 448 KB MPC (internal flash) image.';
    const version = mapSwitch.readProgramVersion(flash);
    if (version !== MAPSWITCH_PROGRAM_VERSION) {
      return `Map switch is only built for program ${MAPSWITCH_PROGRAM_VERSION}, but this image reports ${version || 'an unreadable version'}.`;
    }
    if (mapSwitch.isAlreadyPatched(mpc)) return null;
    for (let i = MAPSWITCH_FREE_START; i < MAPSWITCH_FREE_END; i++) {
      if (mpc[i] !== 0xff) return "The MPC's free area (0x6E550 up) is not empty, so it carries some other modification.";
    }
    for (let i = MAPSWITCH_MAP2_START; i < MAPSWITCH_MAP2_START + MAPSWITCH_MAP2_LENGTH; i++) {
      if (flash[i] !== 0xff) return 'The external flash area for map 2 (0xE0000-0xF7FFF) is not empty.';
    }
    for (let i = 0; i < MS_LOOKUP_ENTRIES.length; i++) {
      if (msRead32(mpc, MS_LOOKUP_ENTRIES[i]) !== MS_LOOKUP_STOCK[i]) {
        return `The MPC does not carry the expected code at lookup routine 0x${MS_LOOKUP_ENTRIES[i].toString(16).toUpperCase()}.`;
      }
    }
    if (msRead32(mpc, MS_TACH_STORE_ADDR) !== MS_TACH_STORE_INSN) return 'The MPC does not carry the expected code at the engine speed frame builder.';
    if (msRead32(mpc, MS_MIL_STORE_ADDR) !== MS_MIL_STORE_INSN || msRead32(mpc, MS_ECON_STORE_ADDR) !== MS_ECON_STORE_INSN) {
      return 'The MPC does not carry the expected code at the lamp / fuel frame builder.';
    }
    for (let i = 0; i < 3; i++) {
      if (msRead32(mpc, MS_NV_DESCRIPTOR + 4 * i) !== MS_NV_STOCK[i]) return "The MPC's stored-data table does not match the expected layout.";
    }
    return null;
  },
  /**
   * Why a calibration cannot be stored as map 2, or null when it can.
   * @param {Uint8Array} calibration
   * @param {Uint8Array} map1
   * @returns {string|null}
   */
  map2BlockedReason(calibration, map1) {
    if (!calibration || calibration.length !== MAPSWITCH_CAL_LENGTH) return 'Map 2 is not a 0x1D000-byte calibration.';
    for (let i = MAPSWITCH_MAP2_LENGTH; i < MAPSWITCH_CAL_LENGTH; i++) {
      if (calibration[i] !== 0xff) {
        return `Map 2 has data past offset 0x${MAPSWITCH_MAP2_LENGTH.toString(16).toUpperCase()}, which does not fit in the free flash area.`;
      }
    }
    const v1 = mapSwitch.readDataVersion(map1);
    const v2 = mapSwitch.readDataVersion(calibration);
    if (v1 == null || v2 == null || v1 !== v2) {
      return `Map 2 is for data version ${v2 || '(unreadable)'} but map 1 is ${v1 || '(unreadable)'}. Both maps must share one layout.`;
    }
    return null;
  },
  /**
   * Patched copies of the pair. `map1` null keeps the calibration already in
   * the image; `map2` null stores a copy of map 1. The caller's arrays are
   * left alone. Checksums and signatures are the caller's job afterwards.
   * @param {Uint8Array} flash
   * @param {Uint8Array} mpc
   * @param {Uint8Array|null} map1
   * @param {Uint8Array|null} map2
   * @param {'dsc'|'pedals'} [trigger]
   * @param {number} [dscPresses]
   * @returns {{flash: Uint8Array, mpc: Uint8Array, wasAlreadyPatched: boolean, wasUpdated: boolean, mapsIdentical: boolean, codeBytes: number, log: string[]}}
   */
  build(flash, mpc, map1, map2, trigger = 'dsc', dscPresses = MS_DEFAULT_DSC_PRESSES) {
    if (trigger === 'dsc' && !MS_DSC_PRESS_CHOICES.includes(dscPresses)) throw new Error('the DSC button trigger takes 2 or 4 presses');
    return msBuild(flash, mpc, map1, map2, msCurrentVersion(trigger, dscPresses));
  },
  /** For tests: build an earlier version. */
  _buildVersion: (flash, mpc, map1, map2, version) => msBuild(flash, mpc, map1, map2, version),
  _version: msVersion,
  _buildCode: msBuildCode,
  _romTestSum: msRomTestSum,
  _calTestSum: msCalTestSum,
};

function msBuild(flash, mpc, map1, map2, version) {
  const blocked = mapSwitch.blockedReason(flash, mpc);
  if (blocked) throw new Error(blocked);
  const result = {
    flash: Uint8Array.from(flash),
    mpc: Uint8Array.from(mpc),
    wasAlreadyPatched: mapSwitch.isAlreadyPatched(mpc),
    wasUpdated: false,
    mapsIdentical: true,
    codeBytes: 0,
    log: [],
  };
  // an unpatched pair must carry the sum its own code gives; a patched one
  // may not: earlier builds left the stock value
  if (!result.wasAlreadyPatched && msReadRomTestSum(flash) !== msRomTestSum(flash, mpc)) {
    throw new Error(
      "the safety monitor's code sum in the program header does not match the code, so this pair is not what the map switch was built for"
    );
  }
  if (map1) {
    if (map1.length !== MAPSWITCH_CAL_LENGTH) throw new Error('map 1 is not a 0x1D000-byte calibration');
    result.flash.set(map1, MAPSWITCH_CAL_START);
    result.log.push('Map 1: replaced the calibration at 0x40000');
  } else {
    result.log.push('Map 1: kept the calibration already in the image');
  }
  const current1 = Uint8Array.from(result.flash.subarray(MAPSWITCH_CAL_START, MAPSWITCH_CAL_START + MAPSWITCH_CAL_LENGTH));
  if (mapSwitch.readDataVersion(current1) == null) throw new Error('the external flash has no tune in it; choose a map 1 tune');
  const second = map2 || current1;
  const map2Blocked = mapSwitch.map2BlockedReason(second, current1);
  if (map2Blocked) throw new Error(map2Blocked);
  result.flash.set(second.subarray(0, MAPSWITCH_MAP2_LENGTH), MAPSWITCH_MAP2_START);
  result.log.push(map2 ? 'Map 2: stored at 0xE0000' : 'Map 2: stored a copy of map 1 at 0xE0000');
  // the monitor sums map 1's range through absolute addresses but reads the
  // value to compare with through r2, i.e. from whichever map is selected
  if (msRead32(result.flash, MS_CAL_TEST_RANGE_OFFSET) !== MS_CAL_TEST_RANGE_START || msRead32(result.flash, MS_CAL_TEST_RANGE_OFFSET + 4) !== MS_CAL_TEST_RANGE_END) {
    throw new Error("the program header does not list the expected range for the safety monitor's calibration sum");
  }
  const calSum = msCalTestSum(current1);
  if (msReadCalTestSum(current1, 0) !== calSum) {
    msWriteCalTestSum(result.flash, MAPSWITCH_CAL_START, calSum);
    result.log.push(`Map 1: safety monitor's calibration sum at 0x${MS_CAL_TEST_SUM_OFFSET.toString(16).toUpperCase()} set to ${msHex16(calSum)}`);
  }
  if (msReadCalTestSum(result.flash, MAPSWITCH_MAP2_START) !== calSum) {
    msWriteCalTestSum(result.flash, MAPSWITCH_MAP2_START, calSum);
    result.log.push(`Map 2: given map 1's calibration sum, ${msHex16(calSum)}, which the safety monitor reads from the selected map`);
  }
  for (let i = 0; i < MAPSWITCH_MAP2_LENGTH && result.mapsIdentical; i++) if (current1[i] !== second[i]) result.mapsIdentical = false;

  const built = msBuildCode(version);
  result.codeBytes = built.code.length;
  const correctRomSum = () => {
    const sum = msRomTestSum(result.flash, result.mpc);
    if (msReadRomTestSum(result.flash) === sum) return;
    msWrite32(result.flash, MS_ROM_TEST_SUM_OFFSET, Number((sum >> 32n) & 0xffffffffn));
    msWrite32(result.flash, MS_ROM_TEST_SUM_OFFSET + 4, Number(sum & 0xffffffffn));
    result.log.push(`Safety monitor: code sum at 0x${MS_ROM_TEST_SUM_OFFSET.toString(16).toUpperCase()} set to ${msHex16(sum)}`);
  };
  if (msCarriesVersion(mpc, version)) {
    result.log.push(
      `Code: image already carries this version of the map switch (${mapSwitch.describeTrigger(version.trigger, version.presses)}, ` +
        `${mapSwitch.describeScope(version.scope)}), left unchanged`
    );
    correctRomSum();
    return result;
  }
  if (result.wasAlreadyPatched) {
    const was = msVersionOf(mpc);
    for (let i = MAPSWITCH_FREE_START; i < MAPSWITCH_FREE_END; i++) result.mpc[i] = 0xff;
    msWrite32(result.mpc, MS_MIL_STORE_ADDR, MS_MIL_STORE_INSN);
    msWrite32(result.mpc, MS_ECON_STORE_ADDR, MS_ECON_STORE_INSN);
    result.wasUpdated = true;
    if (!was) result.log.push('Code: replaced an earlier build of the map switch');
    else if (was.trigger === version.trigger && was.scope === version.scope && was.presses === version.presses) {
      result.log.push('Code: replaced the earlier version of the map switch');
    } else {
      result.log.push(`Code: replaced the map switch, was ${mapSwitch.describeTrigger(was.trigger, was.presses)}, ${mapSwitch.describeScope(was.scope)}`);
    }
  }
  result.mpc.set(built.code, MAPSWITCH_FREE_START);
  for (let i = 0; i < MS_LOOKUP_ENTRIES.length; i++) msWrite32(result.mpc, MS_LOOKUP_ENTRIES[i], msBranch(MS_LOOKUP_ENTRIES[i], built.lookupStubs[i], false));
  msWrite32(result.mpc, MS_TACH_STORE_ADDR, msBranch(MS_TACH_STORE_ADDR, built.tachStub, true));
  if (msLampHook(version)) msWrite32(result.mpc, MS_MIL_STORE_ADDR, msBranch(MS_MIL_STORE_ADDR, built.runStub, true));
  for (let i = 0; i < 3; i++) msWrite32(result.mpc, MS_NV_DESCRIPTOR + 4 * i, built.nvStubs[i]);
  result.log.push(
    `Code: ${MS_LOOKUP_ENTRIES.length} lookup hooks, gesture/tach routine and stored-data routines, ${built.code.length} bytes at ` +
      `MPC 0x${MAPSWITCH_FREE_START.toString(16).toUpperCase()}, trigger: ${mapSwitch.describeTrigger(version.trigger, version.presses)}, ` +
      `switches ${mapSwitch.describeScope(version.scope)}`
  );
  correctRomSum();
  return result;
}

if (typeof window !== 'undefined') window.mapSwitch = mapSwitch;
if (typeof module !== 'undefined' && module.exports) module.exports = { mapSwitch };
