/**
 * @file Map switch builder: reading a built image back (which version and maps it carries), and the safety monitor's sums.
 */

/* exported msCarriesVersion, msVersionOf, msOurCodeSamples, msLooksLikeOurCode, msCarriesSomeBuild, msFreeAreaMatches, msCheckFreeArea, msVersionOnCar, msVersionSummary, msRomTestSum, msReadRomTestSum, msCalTestSum, msReadCalTestSum, msWriteCalTestSum, msHex16 */

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
/** One build of each generation: what "our code" is recognised by. */
function msOurCodeSamples() {
  return [
    msCurrentVersion('dsc'),
    msVersion('dsc', 'immediateLong', 'car', 'fullTune', 4, true, 5),
    msVersion('dsc', 'immediateLong', 'car', 'fullTune', 4, true, 4),
    msVersion('dsc', 'immediateLong', 'car', 'fullTune', 4, true, 3),
  ];
}

function msLooksLikeOurCode(freeArea) {
  for (const sample of msOurCodeSamples()) {
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
