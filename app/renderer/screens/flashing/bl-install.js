// Flashing/Tuning: putting the BL boot loader on a DME (core/flash/bl.js)
// -- one button in Custom Options, "Install / update fast flash
// bootloader", for every state a DME can be in. On the hosted site too.
//
// One confirmation, then:
//   - a ring of ours answers (Identify read its stamp, any version or
//     variant): ONE session on that ring, the boot sector rewritten with
//     this build's ring (bl.put). No file, no installer body. "Current" is
//     this build's stamp, exactly; anything else is put right the same way;
//   - nothing of ours answers (a stock DME, a ring that takes the line and
//     hangs, the old ring layout): the loaded pair is flashed by the DME's
//     OWN loader with the installer body behind the LATE gate (bl.
//     withLateInstaller: ~2 s of polls at MPC 0x8, after any ring's ~1 ms
//     window), then a line held ~300 ms after the reset lands in that body
//     and the same write runs (bl.put: the ring laid in, the two words
//     patched). The installer stays in the program as a way back in until
//     the next program flash takes it out (every boot pays its ~2 s, and a
//     K-line byte in that time enters the flasher).
// There is no separate install or update: one write, one way in when the
// ring cannot be reached.
//
// "Repair fast flash bootloader" is the second way, always on hand: it
// never asks the ring anything and never looks at what Identify made of
// the bootloader. The loaded pair is flashed with the late installer, the
// line is held into it after the reset, and the ring is written over
// whatever the span holds (bl.put forced). It needs only what a program
// flash needs: Identify and the pair (a ring that hangs leaves a free line
// booting stock, so Identify still answers).
//
// "Restore stock bootloader" is the mirror, one confirmation and up to two
// sessions, both on the ring (a held line never gets past the ring to a
// resident body, and the ring's own body may not write the 8 KB sector):
//   1. on the ring: the ring swapped for its installer variant (bl.
//      toInstaller). Skipped when the DME already carries it;
//   2. on the installer ring: both words stock, the ring blanked
//      (bl.restore). Program, tune and MPC are not touched, and no file
//      needs loading.
/* exported fbBlHtml, fbBlRefresh */

function fbBlHtml() {
  return `
      <hr class="fb-sep">
      <div class="fb-code">FAST FLASH BOOTLOADER</div>
      <div class="fb-dim">Install fast flashing program to the DME</div>
      <div class="fb-row">
        <button class="btn danger" id="fb-opt-bl-install" disabled>Install fast flash bootloader</button>
      </div>
      <div class="fb-faint" id="fb-opt-bl-reason"></div>
      <div class="fb-row">
        <button class="btn danger" id="fb-opt-bl-repair" disabled>Repair fast flash bootloader</button>
      </div>
      <div class="fb-faint" id="fb-opt-bl-repair-reason"></div>
      <div class="fb-row">
        <button class="btn danger" id="fb-opt-bl-restore" disabled>Restore stock bootloader</button>
      </div>
      <div class="fb-faint" id="fb-opt-bl-restore-reason"></div>`;
}

/** Whether Identify found a ring of ours that a session can reach: the
 * current layout (the old one, stamp at 0x17080, has no park window and a
 * body that cannot write the 8 KB sector: it goes the long way). */
function fbBlRingReachable() {
  const have = fbState.dme.bootLoader;
  return !!(have && have.stampAt === bl.STAMP_AT);
}

/** Whether the DME carries the late installer, ready to use. */
function fbBlHasLateInstaller() {
  const det = fbState.dme.fastFlasher;
  return bl.isLateInstaller(det) && det.ready;
}

/**
 * Whether the DME sits in the late installer right now. Any K-line byte in
 * the late gate's ~2 s enters it -- an Identify straight after the flash
 * did, on the car -- and then no KWP answers, so the bootloader's stamp is
 * unknown. The write can still run there: it reconnects.
 */
function fbBlInLateInstaller() {
  const d = fbState.dme;
  return !!(d.ident && d.ident.inFlasher && fbBlHasLateInstaller());
}

/** How long a reset DME is left alone before Identify: past the late
 * gate's ~2 s (more if the car runs its poll loop slower), ms. */
const FB_BL_LATE_SETTLE_MS = 10000;

/** Identify once the late gate has let the boot by. */
async function fbBlIdentifyAfterLateGate() {
  fbSetStatus('Waiting 10 s…');
  await new Promise((r) => setTimeout(r, FB_BL_LATE_SETTLE_MS));
  await fbDmeIdentify(true);
}

/** Why Install / update fast flash bootloader cannot start, or null. */
function fbBlWhyNot() {
  const d = fbState.dme;
  if (!d.identified) return 'Identify the DME first.';
  if (
    bl.isCurrent(d.bootLoader) &&
    !(d.bootLoader.health && d.bootLoader.health.broken)
  )
    return 'The current fast flash bootloader is on this DME.';
  // through the ring, or through the late installer already there: no file
  if (fbBlRingReachable() || fbBlHasLateInstaller() || fbBlInLateInstaller())
    return null;
  // the long way writes the pair through the DME's own loader
  if (!(d.fullBin && d.flash && d.mpc))
    return 'Needs Full Binary with the DME’s pair loaded (the bootloader goes in with a program flash).';
  return null;
}

/**
 * Identify's check of the boot region, on its KWP session, once a ring was
 * found: the two loader words, the park call, the boot CRC word, the CMF
 * driver's entries (as the body resolves them -- MPC writes depend on it)
 * and the DME's own reset record. A dozen small reads. The verdict lands in
 * d.bootLoader.health and one line in the log; a broken region makes the
 * Install / update button offer the fix even when the stamp is current.
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
 * (STATUS_UBATT). Below 12.0 V the write is refused -- a brown-out between
 * an erase and its verify is the one failure nothing recovers from. A
 * reading that cannot be had is logged and lets the write go on.
 * @param {string} title
 * @returns {Promise<boolean>}
 */
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
  flashLog.note(`battery ${volts.toFixed(1)} V`);
  if (volts >= 12.0) return true;
  await fbMessage(
    `The DME reads ${volts.toFixed(1)} V. Put a charger on the battery before writing the boot region: a drop mid-write leaves a DME only a BDM rig can recover.`,
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
    return 'This DME carries an old bootloader: update it first, then it can be restored.';
  return null;
}

/** Why Repair fast flash bootloader cannot start, or null: only what the
 * program flash itself needs. The bootloader's state is not consulted. */
function fbBlRepairWhyNot() {
  const d = fbState.dme;
  if (!d.identified) return 'Identify the DME first.';
  if (fbBlInLateInstaller()) return null;
  if (!(d.fullBin && d.flash && d.mpc))
    return 'Needs Full Binary with the DME’s pair loaded (the program is flashed with the installer in it).';
  return null;
}

/** Wire one button once: back to the flashing view, where the run shows. */
function _fbBlWire(btn, title, run) {
  if (btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.onclick = () => {
    fbShowOptions(false);
    fbDmeGuard(title, run);
  };
}

/** The buttons' state and the lines under them, from identify's findings. */
function fbBlRefresh() {
  const btn = fbEls['opt-bl-install'];
  if (!btn) return;
  _fbBlWire(btn, 'Install / update fast flash bootloader', fbBlPut);
  const why = fbBlWhyNot();
  btn.disabled = !!why;
  const have = fbState.dme.bootLoader;
  btn.textContent = have
    ? 'Update fast flash bootloader'
    : 'Install fast flash bootloader';
  fbEls['opt-bl-reason'].textContent =
    why ||
    (have && have.health && have.health.broken
      ? `Fix: ${have.health.problems[0]}.`
      : fbBlRingReachable()
        ? 'Update: your DME is on an old bootloader (one session on it).'
        : fbBlInLateInstaller()
          ? 'Ready: the DME is waiting in the installer, so only the write runs (it reconnects).'
          : fbBlHasLateInstaller()
            ? 'Ready: the installer is already on the DME, so only the write runs.'
            : have
              ? "Your DME's old bootloader cannot be reached in one session: a program flash puts the installer in, then the write runs through it."
              : 'Ready: a program flash puts the installer in, then the bootloader is written through it.');
  const pbtn = fbEls['opt-bl-repair'];
  _fbBlWire(pbtn, 'Repair fast flash bootloader', fbBlRepair);
  const pwhy = fbBlRepairWhyNot();
  pbtn.disabled = !!pwhy;
  fbEls['opt-bl-repair-reason'].textContent =
    pwhy ||
    (fbBlInLateInstaller()
      ? 'Ready: the DME is waiting in the installer, so only the write runs (it reconnects).'
      : 'Ready: the loaded program is flashed with the installer in it, then the bootloader is written through it, whatever is on the DME now.');
  const rbtn = fbEls['opt-bl-restore'];
  _fbBlWire(rbtn, 'Restore stock bootloader', fbBlRestore);
  const rwhy = fbBlRestoreWhyNot();
  rbtn.disabled = !!rwhy;
  fbEls['opt-bl-restore-reason'].textContent =
    rwhy ||
    (fbBlHasInstallerRing()
      ? 'Ready: the installer ring is already on the DME, so only the second stage runs.'
      : 'Ready.');
}

/** The bootloader write on one session (bl.put), as a fast-flash run.
 * @param {string} title
 * @param {boolean} force - Overwrite whatever the ring span holds (Repair).
 * @param {object} opts - fbDmeFastFlash spec overrides (title, lateHold, after).
 */
function fbBlWrite(title, force, opts) {
  const d = fbState.dme;
  return fbDmeFastFlash({
    title,
    operation: force ? 'bl-repair' : 'bl-put',
    what: 'boot loader',
    noFasterLine: true,
    confirmed: true,
    confirm: '',
    note: `DME ${d.ident.hwRef} / ${d.bootLoader ? (bl.isCurrent(d.bootLoader) ? 'current bootloader' : 'old bootloader') : 'no bootloader'} / bootloader ${force ? 'repair' : 'put'}`,
    push: async (client, cb) => {
      const r = await bl.put(client, cb, force);
      cb.stage('Restarting the DME');
      await client.reset();
      return r;
    },
    ...opts,
  });
}

/** The status line once a write and its Identify are through. */
async function fbBlDone(title, after) {
  await after();
  const have = fbState.dme.bootLoader;
  fbSetStatus(
    bl.isCurrent(have)
      ? `${title}: done, the current bootloader is on the DME`
      : `${title}: written. Switch the ignition off and on, then Identify.`
  );
}

/**
 * The long way in: the loaded pair flashed by the DME's own loader with the
 * installer behind the LATE gate, then the write through that installer (a
 * line held after the reset lands in its ~2 s window), then 10 s before
 * Identify so the gate has let the boot by. A DME already sitting in the
 * installer skips the flash: the session reconnects to it.
 * @param {string} title
 * @param {boolean} force - Overwrite whatever the ring span holds (Repair).
 */
async function fbBlPutLongWay(title, force) {
  const waiting = fbBlInLateInstaller();
  if (!waiting) {
    fbSetStatus(
      `${title}, stage 1 of 2: the installer, through the DME’s own loader`
    );
    await fbDmeFlashProgram({
      carry: bl.withLateInstaller,
      title: `${title} (1/2: installer)`,
      confirmed: true,
      // an Identify inside the late gate's window enters the installer
      after: fbBlIdentifyAfterLateGate,
    });
    if (!fbBlHasLateInstaller()) {
      await fbMessage(
        'Stage 1 failed (see the log). Nothing else was written.',
        title
      );
      return;
    }
  }
  // sitting in the installer already: the session reconnects to it (a
  // reset request would go unheard)
  if (waiting) fbDmeSetFastLive(true);
  fbSetStatus(
    `${title}${waiting ? '' : ', stage 2 of 2'}: ${waiting ? 'reconnecting to' : 'resetting the DME into'} the installer…`
  );
  await fbBlWrite(title, force, {
    title: waiting ? title : `${title} (2/2: bootloader)`,
    // past any ring's window: a line held after the reset lands in the gate
    lateHold: true,
    after: () => fbBlDone(title, fbBlIdentifyAfterLateGate),
  });
}

/** Install / update fast flash bootloader: one write, through the ring when it answers, else through the late installer put in by a program flash. One confirmation. */
async function fbBlPut() {
  const why = fbBlWhyNot();
  if (why) {
    await fbMessage(why, 'Install / update fast flash bootloader');
    return;
  }
  const viaRing = fbBlRingReachable();
  const longWay = !viaRing && !fbBlHasLateInstaller() && !fbBlInLateInstaller();
  const ok = await fbConfirm(
    `${longWay ? 'The loaded program is flashed first, with the installer in it; the bootloader is then written through it. ' : ''}Keep the ignition on, a charger on the battery and the cable plugged in until it has finished. A power or cable loss mid-write can leave the DME unbootable.\n\n${viaRing ? 'Update' : 'Install'} the fast flash bootloader?`,
    'Install / update fast flash bootloader'
  );
  if (!ok) {
    flashLog.note(
      'Install / update fast flash bootloader not confirmed: nothing was sent to the car'
    );
    return;
  }
  if (!(await fbBlBatteryOk('Install / update fast flash bootloader'))) return;
  const title = viaRing
    ? 'Update fast flash bootloader'
    : 'Install fast flash bootloader';
  if (viaRing) {
    fbSetStatus(`${title}: resetting the DME into its bootloader…`);
    await fbBlWrite(title, false, {
      after: () => fbBlDone(title, () => fbDmeIdentify(true)),
    });
    return;
  }
  await fbBlPutLongWay(title, false);
}

/** Repair fast flash bootloader: always the long way, whatever the DME carries, and the ring span overwritten whatever it holds. One confirmation. */
async function fbBlRepair() {
  const title = 'Repair fast flash bootloader';
  const why = fbBlRepairWhyNot();
  if (why) {
    await fbMessage(why, title);
    return;
  }
  const waiting = fbBlInLateInstaller();
  const ok = await fbConfirm(
    `${waiting ? 'The DME is waiting in the installer: the bootloader is written through it. ' : 'The loaded program is flashed first, with the installer in it; the bootloader is then written through it. '}Whatever bootloader is on the DME now is written over. Keep the ignition on, a charger on the battery and the cable plugged in until it has finished. A power or cable loss mid-write can leave the DME unbootable.\n\nRepair the fast flash bootloader?`,
    title
  );
  if (!ok) {
    flashLog.note(`${title} not confirmed: nothing was sent to the car`);
    return;
  }
  if (!(await fbBlBatteryOk(title))) return;
  await fbBlPutLongWay(title, true);
}

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
    'Takes the fast flash bootloader off the DME. Fast Flash, Fast Read and the AIF editor go with it; the program and tune stay. Keep the ignition on, a charger on the battery and the cable plugged in until it has finished. A power or cable loss mid-write can leave the DME unbootable.\n\nRestore the stock bootloader?',
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
