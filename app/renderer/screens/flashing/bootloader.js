// Flashing/Tuning: the fast flash bootloader (core/flash/bl.js) as the app
// meets it on a DME -- whether a ring of ours answers, the check of the boot
// region Identify runs once one was found, and taking it off again.
//
// The app no longer installs, repairs or rewrites a bootloader: the
// one-click fast flasher (dme-oneclick.js) works on a stock DME without a
// ring staying behind. What is left here serves a DME that still carries
// one from an earlier build.
//
// "Restore stock bootloader" (the Fast flasher page's button, wired in
// dme-oneclick.js): one confirmation and up to two sessions, both on the
// ring (a held line never gets past the ring to a resident body, and the
// ring's own body may not write the 8 KB sector):
//   1. on the ring: the ring swapped for its installer variant (bl.
//      toInstaller). Skipped when the DME already carries it;
//   2. on the installer ring: both words stock, the ring blanked
//      (bl.restore). Program, tune and MPC are not touched, and no file
//      needs loading.
/* exported fbBlRingReachable, fbBlHealthRead, fbBlHasInstallerRing, fbBlRestoreWhyNot, fbBlRestore */

/** Whether Identify found a ring of ours that a session can reach: the
 * current layout (the old one, stamp at 0x17080, has no park window and a
 * body that cannot write the 8 KB sector: it goes the long way). */
function fbBlRingReachable() {
  const have = fbState.dme.bootLoader;
  return !!(have && have.stampAt === bl.STAMP_AT);
}

/**
 * Identify's check of the boot region, on its KWP session, once a ring was
 * found: the two loader words, the park call, the boot CRC word, the CMF
 * driver's entries (as the body resolves them -- MPC writes depend on it)
 * and the DME's own reset record. A dozen small reads. The verdict lands in
 * d.bootLoader.health and one line in the log.
 */
async function fbBlHealthRead() {
  const d = fbState.dme;
  if (!d.bootLoader || !fbDmeIsMs451()) return;
  const proto = fbDmeReadProtocol();
  const rd = async (at, n) => {
    try {
      return await ms45ReadCarBytes(at, at + n - 1, 'ROMX', proto);
    } catch (e) {
      return null;
    }
  };
  const h = {
    stamp: d.bootLoader,
    words: null,
    parkCallAt: null,
    crcWord: null,
    driver: null,
    resetRecord: d.carResetRecord || null,
    status: d.ident.programmingStatus,
  };
  const [ho, pk] = blData.patches;
  const hw = await rd(ho.at, 4);
  const pw = await rd(pk.at, 4);
  if (hw && pw)
    h.words = { handoff: bytes.be32(hw, 0), park: bytes.be32(pw, 0) };
  for (const at of [0x3828, 0x377c]) {
    const g = await rd(at, 8);
    if (
      g &&
      bytes.be32(g, 0) === blData.guard.words[0] &&
      bytes.be32(g, 4) === blData.guard.words[1]
    ) {
      h.parkCallAt = at;
      break;
    }
  }
  const cw = await rd(0x1f800, 4);
  if (cw) h.crcWord = bytes.be32(cw, 0) >>> 0;
  for (const site of bl.DRV_SITES) {
    const sig = await rd(site + 4, 12);
    if (!sig || bl.DRV_SIG.some((w, i) => bytes.be32(sig, 4 * i) !== w))
      continue;
    const code = site + bl.DRV_CODE;
    // the wrappers (0x148..0x4A0), then each named entry's first halfword
    const wr = await rd(code + 0x148, 0x4a0 - 0x148);
    if (!wr) break;
    const buf = new Uint8Array(0x1c00);
    buf.set(wr, 0x148);
    const pre = bl.driverEntries(buf); // bounds and shape first
    if (pre.why && !/prologue/.test(pre.why)) {
      h.driver = { found: true, ok: false, why: pre.why };
      break;
    }
    for (const off of Object.values(pre.entries)) {
      const two = await rd(code + off, 2);
      if (two) buf.set(two, off);
    }
    const r = bl.driverEntries(buf);
    h.driver = { found: true, ok: r.ok, why: r.why };
    break;
  }
  if (!h.driver) h.driver = { found: false, ok: false, why: null };
  d.bootLoader.health = bl.health(h);
  fbLog(bl.healthText(d.bootLoader.health));
}

/**
 * The battery before a boot-region write: the DME's own reading
 * (STATUS_UBATT). Below FB_BL_MIN_VOLTS the write is refused -- a brown-out
 * between an erase and its verify is the one failure nothing recovers from.
 * The DME reads a few tenths under the battery terminals (its wiring and
 * input protection: 12.3 V at the battery read just under 12.0 on the car),
 * so the floor sits well below a healthy resting battery. A reading that
 * cannot be had is logged and lets the write go on.
 * @param {string} title
 * @returns {Promise<boolean>}
 */
const FB_BL_MIN_VOLTS = 11.5;

async function fbBlBatteryOk(title) {
  let volts = null;
  try {
    const r = await ms45Job('STATUS_UBATT');
    for (const set of (r && r.res && r.res.sets) || [])
      for (const [k, v] of Object.entries(set))
        if (/UBATT/.test(k) && Number.isFinite(parseFloat(v)))
          volts = parseFloat(v);
  } catch (e) {
    volts = null;
  }
  if (volts == null) {
    flashLog.note('battery voltage not read: going on without the check');
    return true;
  }
  flashLog.note(`battery ${volts.toFixed(2)} V (DME reading)`);
  if (volts >= FB_BL_MIN_VOLTS) return true;
  await fbMessage(
    `The DME reads ${volts.toFixed(2)} V, under ${FB_BL_MIN_VOLTS.toFixed(1)} V. Put a charger on the battery before writing the boot region: a drop mid-write leaves a DME only a BDM rig can recover.`,
    title
  );
  return false;
}

/** Whether the DME carries the installer ring (restore stage 1 done). */
function fbBlHasInstallerRing() {
  const have = fbState.dme.bootLoader;
  return !!(have && have.flags & bl.INSTALLER_FLAG);
}

/** Why Restore stock bootloader cannot start, or null. */
function fbBlRestoreWhyNot() {
  const d = fbState.dme;
  if (!d.identified) return 'Identify the DME first.';
  if (!d.bootLoader) return 'The fast flash bootloader is not on this DME.';
  // the restore recognises this build's ring byte for byte: another one
  // is put right first (one session), then it comes off like any other
  if (!fbBlRingReachable() || !bl.isOurs(d.bootLoader))
    return 'This DME carries an older bootloader, which Restore cannot take off.';
  return null;
}

/** What every bootloader write says before it starts. */
const FB_BL_POWER_WARNING =
  'Keep the ignition on, a charger connected and the cable plugged in. Losing power mid-write can leave the DME unbootable.';

/** Restore stock bootloader: BL swapped for the installer ring if needed, then the boot region put back to stock, one confirmation. */
async function fbBlRestore() {
  const d = fbState.dme;
  const why = fbBlRestoreWhyNot();
  if (why) {
    await fbMessage(why, 'Restore stock bootloader');
    return;
  }
  const both = !fbBlHasInstallerRing();
  const ok = await fbConfirm(
    `Fast Flash, Fast Read and the AIF editor are removed; the program and tune stay. ${FB_BL_POWER_WARNING}\n\nRestore the stock bootloader?`,
    'Restore stock bootloader'
  );
  if (!ok) {
    flashLog.note(
      'Restore stock bootloader not confirmed: nothing was sent to the car'
    );
    return;
  }
  if (!(await fbBlBatteryOk('Restore stock bootloader'))) return;
  // each session ends with the flasher's RESET; Identify then reads the
  // stamp again (flags 7 after stage 1, none after stage 2)
  const session = (title, operation, push, after) =>
    fbDmeFastFlash({
      title,
      operation,
      what: 'boot loader',
      noFasterLine: true,
      confirmed: true,
      confirm: '',
      note: `DME ${d.ident.hwRef} / ${bl.isCurrent(d.bootLoader) ? 'current' : 'old'} bootloader / ${operation}`,
      push: async (client, cb) => {
        const r = await push(client, cb);
        cb.stage('Restarting the DME');
        await client.reset();
        return r;
      },
      after,
    });

  if (both) {
    fbSetStatus('Restore stock bootloader, stage 1 of 2: the installer ring');
    await session(
      'Restore stock bootloader (1/2: installer ring)',
      'bl-to-installer',
      bl.toInstaller,
      () => fbDmeIdentify(true)
    );
    if (!fbBlHasInstallerRing()) {
      await fbMessage(
        'Stage 1 failed (see the log). The DME still boots as before.',
        'Restore stock bootloader'
      );
      return;
    }
  }

  fbSetStatus(
    both
      ? 'Restore stock bootloader, stage 2 of 2: resetting the DME into the installer ring…'
      : 'Restore stock bootloader: resetting the DME into the installer ring…'
  );
  await session(
    both
      ? 'Restore stock bootloader (2/2: stock loader)'
      : 'Restore stock bootloader',
    'bl-restore',
    bl.restore,
    async () => {
      await fbDmeIdentify(true);
      fbSetStatus(
        fbState.dme.bootLoader
          ? 'Restore stock bootloader: written. Switch the ignition off and on, then Identify.'
          : 'Restore stock bootloader: done, the DME runs the stock loader'
      );
    }
  );
}
