/**
 * @file Map switch builder: the build versions, and the PowerPC code it adds (lookup hooks, the gesture and tach routine, the stored-data routines).
 */

/* exported msVersion, msLampHook, msMulti, msCurrentVersion, msIsCurrent, MS_KNOWN_VERSIONS, msEntriesFor, msBuildCode */

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
