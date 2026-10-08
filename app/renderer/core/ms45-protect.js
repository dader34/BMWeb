// Engine protection and the spark cut rev limiter for the MS45.1, program
// 0044570LO02S, in one patch. Ported from ms45-emu's ms45emu/protect.py,
// where it was run in the emulator; the test holds this builder to that one
// byte for byte.
//
// Everything here cuts the ignition; nothing touches the program's own rev
// limiter. That matters: the safety monitor keeps a redundant copy of the
// limiter's state and resets the DME when the two disagree, which is what an
// earlier version that lowered the limiter's working value ran into.
//
// Each of the three places the program arms a coil (MPC 0x379CC, 0x193C4,
// 0x1976C) calls a gate instead. The gate works out the lowest rpm at which
// the spark should be cut from the current conditions, and returns without
// arming the coil once engine speed (r13-0x4BEC, 1 rpm per count) is at or
// above it:
//
//   - the spark cut: the program's own stored rev limit (r13-0x4BD6, read
//     only), whatever the tune, gear or map makes it; it stands down in limp
//     home (r13-0x406B) so the stock limiter alone holds the limp limit;
//   - the cold limit while the coolant (r13-0x4038) is below the warm-up
//     temperature;
//   - the oil limit while the oil (r13-0x4026) is at or above its
//     temperature, which also sets the program's own oil-temperature warning
//     byte (r13-0x2F4C);
//   - the coolant limit while the coolant is at or above its temperature.
//
// Both temperatures are 8 bit, degrees C plus 40. Injection is another
// routine and is never gated, so the fuel is kept. The gates live in the
// empty end of the external program area, from 0xDC860. The calibration is
// not touched, so the limits are the same in both maps of a map switch build.
//
// Checksums and signatures are NOT computed here: the caller runs the pair
// through ms45Checksums, as for any other program flash.
/* exported ms45Protect */

const MSP_PROGRAM_VERSION = '0044570LO02S';
const MSP_PROGRAM_VERSION_OFFSET = 0x6031c;
const MSP_FULL_FLASH_LENGTH = 0x100000;
const MSP_MPC_LENGTH = 0x70000;
const MSP_EXT = 0xfff00000;
const MSP_R13 = 0x4017f0;
const MSP_CODE_START = 0xdc860;
const MSP_CODE_END = 0xdcc00; // the map switch's blocks begin here
const MSP_VAR_OIL = -0x4026;
const MSP_VAR_COOLANT = -0x4038;
const MSP_VAR_ENGINE_SPEED = -0x4bec;
const MSP_VAR_OIL_WARNING = -0x2f4c;
const MSP_VAR_LIMIT = -0x4bd6;
const MSP_VAR_LIMP = -0x406b;
const MSP_TEMP_OFFSET = 40;
const MSP_NO_CUT = 0x7fff;
/** [the call in the MPC, the routine it calls in a stock program] */
const MSP_SITES = [
  [0x379cc, 0x377a8],
  [0x193c4, 0x1f938],
  [0x1976c, 0x1f938],
];
// An earlier version of this patch hooked the limiter's own store (external
// flash 0x96950, `sth r30,-0x4BD6(r13)`) to lower the limit; the safety
// monitor reset the DME over it. Nothing is hooked there any more, but a pair
// that still carries that hook must get its store back when it is rebuilt,
// or the limiter would call into erased flash.
const MSP_LIMIT_SITE = 0x96950;
const MSP_LIMIT_STORE = 0xb3cdb42a;
// The stock limit tables, one 16-bit rpm per gear (0 = none engaged), and the
// variable that says which of them the car uses.
const MSP_CAL_START = 0x40000;
const MSP_LIMIT_TABLES = { 1: 0x612e, 2: 0x60d4, 3: 0x60e6 }; // manual, automated manual, automatic
const MSP_LIMIT_TABLE_GEARS = 9;
const MSP_RAM_TRANSMISSION = 0x3feaab;
const MSP_RPM_MIN = 2000;
const MSP_RPM_MAX = 8000;
const MSP_TEMP_MIN = 0;
const MSP_TEMP_MAX = 200;
const MSP_DEFAULTS = Object.freeze({
  sparkCut: true,
  oilC: 130,
  oilRpm: 4500,
  coolantC: 115,
  coolantRpm: 4500,
  coldWarmC: 50,
  coldRpm: 3500,
});
const MSP_BLT = 12;
const MSP_BGE = 4;
const MSP_BNE = 4; // with bi 2 (EQ bit)

function mspD(op, rt, ra, imm) {
  return ((op << 26) | (rt << 21) | (ra << 16) | (imm & 0xffff)) >>> 0;
}
function mspRead32(data, at) {
  return (
    ((data[at] << 24) |
      (data[at + 1] << 16) |
      (data[at + 2] << 8) |
      data[at + 3]) >>>
    0
  );
}
function mspWrite32(data, at, v) {
  data[at] = (v >>> 24) & 0xff;
  data[at + 1] = (v >>> 16) & 0xff;
  data[at + 2] = (v >>> 8) & 0xff;
  data[at + 3] = v & 0xff;
}
/** Where a branch-and-link at CPU address `pc` goes, or null when the word is not one. */
function mspCallTarget(word, pc) {
  if (word >>> 26 !== 18 || (word & 3) !== 1) return null;
  let offset = word & 0x03fffffc;
  if (offset & 0x02000000) offset -= 0x04000000;
  return (pc + offset) >>> 0;
}
function mspBranch(from, to, link) {
  const d = (to - from) | 0;
  if (d < -0x2000000 || d >= 0x2000000 || d & 3)
    throw new Error('branch out of range');
  return ((18 << 26) | (d & 0x03fffffc) | (link ? 1 : 0)) >>> 0;
}
function mspInArea(address) {
  return (
    address != null &&
    address >= MSP_EXT + MSP_CODE_START &&
    address < MSP_EXT + MSP_CODE_END
  );
}
/** The gate an ignition site calls, or null when the site does not call one. */
function mspGateOf(mpc, site) {
  const target = mspCallTarget(mspRead32(mpc, site), site);
  return mspInArea(target) ? target : null;
}
/** Whether an earlier version's call sits where the limiter stores its limit. */
function mspLimitHooked(flash) {
  const target = mspCallTarget(
    mspRead32(flash, MSP_LIMIT_SITE),
    MSP_EXT + MSP_LIMIT_SITE
  );
  return mspInArea(target);
}
const mspHex = (v) => `0x${v.toString(16).toUpperCase()}`;

/** A config with every field present, the defaults filling what was left out. */
function mspConfig(config) {
  return { ...MSP_DEFAULTS, ...(config || {}) };
}
function mspHasLimits(cfg) {
  return cfg.coldWarmC != null || cfg.oilC != null || cfg.coolantC != null;
}
function mspEnabled(cfg) {
  return cfg.sparkCut || mspHasLimits(cfg);
}

/**
 * An ignition site's gate. r12 is the cut rpm: the stored rev limit when the
 * spark cut is on and the program is not in limp home, else "no cut";
 * lowered to each temperature limit in force. The coil is not armed once
 * engine speed is at the cut rpm. The stored limit is only ever read.
 */
function mspGate(at, original, cfg) {
  const items = [];
  const labels = new Map();
  let serial = 0;
  const emit = (w) => items.push(w >>> 0);
  const branchIf = (bo, bi, label) => items.push({ bo, bi, label });
  const place = (label) => labels.set(label, at + 4 * items.length);
  const li = (rt, v) => emit(mspD(14, rt, 0, v));
  const lower = (rpm) => {
    const keep = `keep${serial++}`;
    emit(mspD(10, 0, 12, rpm)); // cmplwi r12,rpm
    branchIf(MSP_BLT, 0, keep); // already lower: keep it
    li(12, rpm);
    place(keep);
  };
  const when = (variable, temp, skipIf, limit, extra) => {
    const skip = `skip${serial++}`;
    emit(mspD(34, 11, 13, variable)); // lbz r11,temp(r13)
    emit(mspD(10, 0, 11, temp + MSP_TEMP_OFFSET)); // cmplwi r11,temp
    branchIf(skipIf, 0, skip);
    lower(limit);
    if (extra) extra();
    place(skip);
  };

  li(12, MSP_NO_CUT);
  if (cfg.sparkCut) {
    emit(mspD(34, 11, 13, MSP_VAR_LIMP)); // lbz r11,limp(r13)
    emit(mspD(11, 0, 11, 0)); // cmpwi r11,0
    branchIf(MSP_BNE, 2, 'limp');
    emit(mspD(40, 12, 13, MSP_VAR_LIMIT)); // lhz r12,limit(r13)
    place('limp');
  }
  if (cfg.coldWarmC != null)
    when(MSP_VAR_COOLANT, cfg.coldWarmC, MSP_BGE, cfg.coldRpm);
  if (cfg.oilC != null)
    when(MSP_VAR_OIL, cfg.oilC, MSP_BLT, cfg.oilRpm, () => {
      li(11, 1);
      emit(mspD(38, 11, 13, MSP_VAR_OIL_WARNING)); // stb r11,warning(r13)
    });
  if (cfg.coolantC != null)
    when(MSP_VAR_COOLANT, cfg.coolantC, MSP_BLT, cfg.coolantRpm);
  emit(mspD(40, 0, 13, MSP_VAR_ENGINE_SPEED)); // lhz r0,N(r13)
  emit(((31 << 26) | (0 << 16) | (12 << 11) | (32 << 1)) >>> 0); // cmplw r0,r12
  emit(((19 << 26) | (MSP_BGE << 21) | (16 << 1)) >>> 0); // bgelr: the coil is not armed
  items.push({ address: original }); // else fire

  return items.map((it, i) => {
    const pc = at + 4 * i;
    if (typeof it === 'number') return it;
    if (it.address != null) return mspBranch(pc, it.address, false);
    const d = labels.get(it.label) - pc;
    return ((16 << 26) | (it.bo << 21) | (it.bi << 16) | (d & 0xfffc)) >>> 0;
  });
}

/** The three gates, and where each one starts. */
function mspBuildCode(cfg) {
  const words = [];
  const gates = [];
  if (mspEnabled(cfg)) {
    for (const [site, original] of MSP_SITES) {
      const at = MSP_EXT + MSP_CODE_START + 4 * words.length;
      gates.push({ site, at });
      words.push(...mspGate(at, original, cfg));
    }
  }
  const code = new Uint8Array(4 * words.length);
  words.forEach((w, i) => mspWrite32(code, 4 * i, w));
  if (MSP_CODE_START + code.length > MSP_CODE_END)
    throw new Error('the code does not fit in the free flash area');
  return { code, gates };
}

/** Read a config back out of the first gate's code, without checking it. */
function mspDecode(flash, mpc) {
  const cfg = {
    ...MSP_DEFAULTS,
    sparkCut: false,
    oilC: null,
    coolantC: null,
    coldWarmC: null,
  };
  const gate = mspGateOf(mpc, MSP_SITES[0][0]);
  if (gate == null) return cfg;
  const imm = (w) => w & 0xffff;
  let at = gate - MSP_EXT + 4; // past li r12,NO_CUT
  if (mspRead32(flash, at) === mspD(34, 11, 13, MSP_VAR_LIMP)) {
    cfg.sparkCut = true;
    at += 16;
  }
  for (let guard = 0; guard < 3; guard++) {
    const load = mspRead32(flash, at);
    const temp = imm(mspRead32(flash, at + 4)) - MSP_TEMP_OFFSET;
    const kind = (mspRead32(flash, at + 8) >>> 21) & 31;
    const rpm = imm(mspRead32(flash, at + 12));
    if (load === mspD(34, 11, 13, MSP_VAR_OIL)) {
      cfg.oilC = temp;
      cfg.oilRpm = rpm;
      at += 32;
    } else if (load !== mspD(34, 11, 13, MSP_VAR_COOLANT)) break;
    else if (kind === MSP_BGE) {
      cfg.coldWarmC = temp;
      cfg.coldRpm = rpm;
      at += 24;
    } else {
      cfg.coolantC = temp;
      cfg.coolantRpm = rpm;
      at += 24;
    }
  }
  return cfg;
}

const ms45Protect = {
  SUPPORTED_PROGRAM_VERSION: MSP_PROGRAM_VERSION,
  DEFAULTS: MSP_DEFAULTS,
  RPM_RANGE: [MSP_RPM_MIN, MSP_RPM_MAX],
  TEMP_RANGE: [MSP_TEMP_MIN, MSP_TEMP_MAX],
  CODE_START: MSP_CODE_START,
  /** RAM worth reading on a car before trusting the limits (CPU addresses). */
  RAM: {
    oilTemp: MSP_R13 + MSP_VAR_OIL,
    coolantTemp: MSP_R13 + MSP_VAR_COOLANT,
    oilWarning: MSP_R13 + MSP_VAR_OIL_WARNING,
    revLimit: MSP_R13 + MSP_VAR_LIMIT,
    transmission: MSP_RAM_TRANSMISSION,
  },
  /** The stock limit tables in the external flash: one read covers all three. */
  LIMIT_TABLES_START: MSP_CAL_START + MSP_LIMIT_TABLES[2],
  LIMIT_TABLES_END:
    MSP_CAL_START + MSP_LIMIT_TABLES[1] + 2 * MSP_LIMIT_TABLE_GEARS - 1,

  /**
   * The rev limit a car's own limiter works to with a gear engaged, from the
   * bytes LIMIT_TABLES_START..LIMIT_TABLES_END of its flash. `transmission`
   * is the byte at RAM.transmission (1 manual, 2 automated manual, 3
   * automatic); without it the lowest of the tables is taken.
   * @param {Uint8Array} tables
   * @param {number|null} [transmission]
   * @returns {number|null}
   */
  stockLimit(tables, transmission) {
    const length =
      ms45Protect.LIMIT_TABLES_END - ms45Protect.LIMIT_TABLES_START;
    if (!tables || tables.length !== length + 1) return null;
    const highest = (kind) => {
      const at =
        MSP_CAL_START + MSP_LIMIT_TABLES[kind] - ms45Protect.LIMIT_TABLES_START;
      let rpm = 0;
      for (let gear = 1; gear < MSP_LIMIT_TABLE_GEARS; gear++)
        rpm = Math.max(
          rpm,
          (tables[at + 2 * gear] << 8) | tables[at + 2 * gear + 1]
        );
      return rpm;
    };
    const rpm = MSP_LIMIT_TABLES[transmission]
      ? highest(transmission)
      : Math.min(highest(1), highest(2), highest(3));
    return rpm >= MSP_RPM_MIN && rpm <= MSP_RPM_MAX ? rpm : null;
  },

  /**
   * What is wrong with a config, or null. The spark cut is switched off by
   * sparkCut false, a limit by a null oilC / coolantC / coldWarmC.
   * @param {object} config
   * @returns {string|null}
   */
  configError(config) {
    const c = mspConfig(config);
    const whole = (v) => Number.isInteger(v);
    const rpms = [
      ['oil limit', c.oilRpm, c.oilC != null],
      ['coolant limit', c.coolantRpm, c.coolantC != null],
      ['cold limit', c.coldRpm, c.coldWarmC != null],
    ];
    for (const [name, rpm, used] of rpms) {
      if (!used) continue;
      if (!whole(rpm) || rpm < MSP_RPM_MIN || rpm > MSP_RPM_MAX)
        return `The ${name} must be ${MSP_RPM_MIN} to ${MSP_RPM_MAX} rpm.`;
    }
    const temps = [
      ['oil temperature', c.oilC],
      ['coolant temperature', c.coolantC],
      ['warm-up temperature', c.coldWarmC],
    ];
    for (const [name, t] of temps) {
      if (t == null) continue;
      if (!whole(t) || t < MSP_TEMP_MIN || t > MSP_TEMP_MAX)
        return `The ${name} must be ${MSP_TEMP_MIN} to ${MSP_TEMP_MAX} °C.`;
    }
    if (!mspEnabled(c)) return 'Everything is switched off.';
    if (c.coolantC != null && c.coldWarmC != null && c.coldWarmC > c.coolantC)
      return 'The warm-up temperature is above the maximum coolant temperature.';
    return null;
  },

  /**
   * One line per part that is on.
   * @param {object} config
   * @returns {string[]}
   */
  describe(config) {
    const c = mspConfig(config);
    const lines = [];
    if (c.sparkCut) lines.push('spark cut at the rev limit');
    if (c.coldWarmC != null)
      lines.push(
        `cold: spark cut at ${c.coldRpm} rpm until the coolant is at ${c.coldWarmC} °C`
      );
    if (c.oilC != null)
      lines.push(
        `oil at ${c.oilC} °C or more: spark cut at ${c.oilRpm} rpm, oil-temperature warning`
      );
    if (c.coolantC != null)
      lines.push(
        `coolant at ${c.coolantC} °C or more: spark cut at ${c.coolantRpm} rpm`
      );
    return lines;
  },

  /**
   * Whether the pair carries the patch: any ignition site calling a gate.
   * @param {Uint8Array} flash
   * @param {Uint8Array} mpc
   * @returns {boolean}
   */
  isApplied(flash, mpc) {
    if (!flash || flash.length !== MSP_FULL_FLASH_LENGTH) return false;
    if (!mpc || mpc.length !== MSP_MPC_LENGTH) return false;
    return (
      mspLimitHooked(flash) ||
      MSP_SITES.some(([site]) => mspGateOf(mpc, site) != null)
    );
  },

  /**
   * The config a patched pair was built with, or null when the pair is not
   * patched or its code is not this builder's.
   * @param {Uint8Array} flash
   * @param {Uint8Array} mpc
   * @returns {object|null}
   */
  installed(flash, mpc) {
    if (!ms45Protect.isApplied(flash, mpc)) return null;
    if (mspLimitHooked(flash)) return null; // an earlier version: not this builder's code
    const cfg = mspDecode(flash, mpc);
    if (ms45Protect.configError(cfg)) return null;
    const built = mspBuildCode(cfg);
    for (let i = 0; i < built.code.length; i++)
      if (flash[MSP_CODE_START + i] !== built.code[i]) return null;
    for (const [site] of MSP_SITES) {
      const gate = built.gates.find((g) => g.site === site);
      if (mspRead32(mpc, site) !== mspBranch(site, gate.at, true)) return null;
    }
    return cfg;
  },

  /**
   * Why this pair cannot take the patch, or null when it can. A pair that
   * already carries it is accepted (the code is replaced).
   * @param {Uint8Array} flash
   * @param {Uint8Array} mpc
   * @returns {string|null}
   */
  blockedReason(flash, mpc) {
    if (!flash || flash.length !== MSP_FULL_FLASH_LENGTH)
      return 'This needs a full 1 MB external flash image.';
    if (!mpc || mpc.length !== MSP_MPC_LENGTH)
      return 'This needs the 448 KB MPC (internal flash) image.';
    let version = '';
    for (let i = 0; i < MSP_PROGRAM_VERSION.length; i++)
      version += String.fromCharCode(flash[MSP_PROGRAM_VERSION_OFFSET + i]);
    if (version !== MSP_PROGRAM_VERSION)
      return `This is only built for program ${MSP_PROGRAM_VERSION}, and this image is another one.`;
    for (const [site, original] of MSP_SITES) {
      const stock = mspRead32(mpc, site) === mspBranch(site, original, true);
      if (!stock && mspGateOf(mpc, site) == null)
        return `The MPC does not carry the expected ignition call at ${mspHex(site)}.`;
    }
    if (
      mspRead32(flash, MSP_LIMIT_SITE) !== MSP_LIMIT_STORE &&
      !mspLimitHooked(flash)
    )
      return `The program does not store its engine speed limit at ${mspHex(MSP_LIMIT_SITE)} the expected way.`;
    if (ms45Protect.isApplied(flash, mpc)) return null;
    // the defaults switch everything on, so this is the most the code takes
    const need = MSP_CODE_START + mspBuildCode(MSP_DEFAULTS).code.length;
    for (let i = MSP_CODE_START; i < need; i++) {
      if (flash[i] !== 0xff)
        return `The external flash is not empty at ${mspHex(MSP_CODE_START)}, so it carries some other modification there.`;
    }
    return null;
  },

  /**
   * Copies of the pair without the patch: the stock calls back, the code
   * area empty.
   * @param {Uint8Array} flash
   * @param {Uint8Array} mpc
   * @returns {{flash: Uint8Array, mpc: Uint8Array}}
   */
  remove(flash, mpc) {
    const out = { flash: Uint8Array.from(flash), mpc: Uint8Array.from(mpc) };
    for (const [site, original] of MSP_SITES) {
      const stock = mspBranch(site, original, true);
      if (mspRead32(out.mpc, site) === stock) continue;
      if (mspGateOf(out.mpc, site) == null)
        throw new Error(
          `the call at ${mspHex(site)} is neither stock nor a protection gate`
        );
      mspWrite32(out.mpc, site, stock);
    }
    if (mspLimitHooked(out.flash))
      mspWrite32(out.flash, MSP_LIMIT_SITE, MSP_LIMIT_STORE); // an earlier version's hook
    else if (mspRead32(out.flash, MSP_LIMIT_SITE) !== MSP_LIMIT_STORE)
      throw new Error(
        `the limiter's store at ${mspHex(MSP_LIMIT_SITE)} is neither stock nor an earlier protection hook`
      );
    out.flash.fill(0xff, MSP_CODE_START, MSP_CODE_END);
    return out;
  },

  /**
   * Patched copies of the pair. The caller's arrays are left alone.
   * Checksums and signatures are the caller's job afterwards.
   * @param {Uint8Array} flash
   * @param {Uint8Array} mpc
   * @param {object} [config] - Fields left out take the defaults.
   * @returns {{flash: Uint8Array, mpc: Uint8Array, config: object, codeBytes: number, replaced: boolean, log: string[]}}
   */
  apply(flash, mpc, config) {
    const cfg = mspConfig(config);
    const bad = ms45Protect.configError(cfg);
    if (bad) throw new Error(bad);
    const blocked = ms45Protect.blockedReason(flash, mpc);
    if (blocked) throw new Error(blocked);
    const replaced = ms45Protect.isApplied(flash, mpc);
    const out = replaced
      ? ms45Protect.remove(flash, mpc)
      : { flash: Uint8Array.from(flash), mpc: Uint8Array.from(mpc) };
    const { code, gates } = mspBuildCode(cfg);
    for (let i = 0; i < code.length; i++) {
      if (out.flash[MSP_CODE_START + i] !== 0xff)
        throw new Error(
          `the external flash is not empty at ${mspHex(MSP_CODE_START + i)}`
        );
    }
    out.flash.set(code, MSP_CODE_START);
    for (const { site, at } of gates)
      mspWrite32(out.mpc, site, mspBranch(site, at, true));
    const log = [
      `Engine protection: ${replaced ? 'replaced; ' : ''}three ignition gates, ${code.length} bytes at external flash ${mspHex(MSP_CODE_START)}`,
      ...ms45Protect.describe(cfg).map((l) => `Engine protection: ${l}`),
    ];
    return { ...out, config: cfg, codeBytes: code.length, replaced, log };
  },
};

if (typeof window !== 'undefined') window.ms45Protect = ms45Protect;
if (typeof module !== 'undefined' && module.exports)
  module.exports = { ms45Protect };
