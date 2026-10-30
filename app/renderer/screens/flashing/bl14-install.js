// Flashing/Tuning: installing the BL15 boot loader (core/flash/bl14.js) --
// "Install fast flash bootloader" -- one guided button in Custom Options.
// On the hosted site too, like the fast flasher it rides on.
//
// One confirmation, then up to two sessions without another question:
//   1. the installer body: the loaded pair written with the installer
//      variant of the resident body spliced in (its window opens at 0x4000,
//      where the loader's handoff and park words live) -- through the DME's
//      fast flasher when it has one, else a full flash through its own
//      loader (a stock DME). Skipped when the DME already carries the
//      installer (a run stopped after this stage picks up from here);
//   2. BL15: on that body, the DME's own boot region read, the ring spliced
//      in, both sectors rewritten (bl14.install).
// The next program flash leaves the installer body out again; BL15 stays.
// A DME already on an older BL15 takes the same button as an update: one
// session on its ring, the boot sector rewritten with this build's ring
// (bl14.upgrade); no file, no installer body.
//
// "Restore stock bootloader" is its mirror, also one confirmation and up to
// two sessions, both on the ring (a held line never gets past BL15 to a
// resident body, and BL15's own body may not write the 8 KB sector):
//   1. on BL15: the ring swapped for its installer variant (bl14.
//      toInstaller). Skipped when the DME already carries it;
//   2. on the installer ring: both words stock, the ring blanked
//      (bl14.restore). Program, tune and MPC are not touched, and no file
//      needs loading.
//
// "Repair fast flash bootloader" is the way past a ring that takes a held
// line and never answers (v16 on the car, 2026-10-28), when the update's
// one session on that ring cannot start. Nothing goes through the ring:
//   1. the loaded pair flashed by the DME's own loader with the installer
//      body behind the LATE gate (bl14.withLateInstaller: ~2 s of polls at
//      MPC 0x8). Skipped when the DME already carries it;
//   2. the DME reset and the line held only ~300 ms after the reply, past
//      the ring's ~1 ms window, into the late gate: on that body, the boot
//      sector rewritten with this build's ring (bl14.upgrade).
// The late installer stays in the program as a way back in should the new
// ring fail too; the next program flash takes it out (every boot pays its
// ~2 s, and a K-line byte in that time enters the flasher).
/* exported fbBl14Html, fbBl14Refresh */

function fbBl14Html() {
  return `
      <hr class="fb-sep">
      <div class="fb-code">FAST FLASH BOOTLOADER</div>
      <div class="fb-dim">Install fast flashing program to the DME</div>
      <div class="fb-row">
        <button class="btn danger" id="fb-opt-bl14-install" disabled>Install fast flash bootloader</button>
      </div>
      <div class="fb-faint" id="fb-opt-bl14-reason"></div>
      <div class="fb-row">
        <button class="btn danger" id="fb-opt-bl14-repair" disabled>Repair fast flash bootloader</button>
      </div>
      <div class="fb-faint" id="fb-opt-bl14-repair-reason"></div>
      <div class="fb-row">
        <button class="btn danger" id="fb-opt-bl14-restore" disabled>Restore stock bootloader</button>
      </div>
      <div class="fb-faint" id="fb-opt-bl14-restore-reason"></div>`;
}

/** Whether the DME already carries the installer body, ready to use. */
function fbBl14HasInstaller() {
  const det = fbState.dme.fastFlasher;
  return bl14.isInstaller(det) && det.ready;
}

/** Why Install fast flash bootloader cannot start, or null. */
function fbBl14WhyNot() {
  const d = fbState.dme;
  if (!d.identified) return 'Identify the DME first.';
  if (bl14.isCurrent(d.bootLoader))
    return `This build's fast flash bootloader (v${d.bootLoader.version}) is on this DME.`;
  // an older bootloader is not a refusal: one session on its own ring
  // swaps it for this build's (bl14.upgrade), the boot CRC word recomputed
  // with it (a ring without the stamp's CRC bit may carry the stock word:
  // the DME resets itself every ~5 s); no file is needed, since a held
  // line lands in the ring and never in a body in the program
  if (d.bootLoader) return null;
  if (fbBl14HasInstaller()) return null;
  // stage 1 writes the pair: through a ready fast flasher the DME already
  // has, or through the DME's own loader (a stock DME, or an old body the
  // installer replaces)
  if (!(d.fullBin && d.flash && d.mpc))
    return 'Needs Full Binary with the DME’s pair loaded.';
  return null;
}

/** Whether the DME carries the late installer, ready to use (repair stage 1 done). */
function fbBl14HasLateInstaller() {
  const det = fbState.dme.fastFlasher;
  return bl14.isLateInstaller(det) && det.ready;
}

/**
 * Whether the DME sits in the late installer right now. Any K-line byte in
 * the late gate's ~2 s enters it -- an Identify straight after the stage-1
 * flash did, on the car -- and then no KWP answers, so the bootloader's
 * stamp is unknown. Stage 2 can still run there: it reconnects, and
 * bl14.upgrade reads the boot region and refuses anything but an older ring.
 */
function fbBl14InLateInstaller() {
  const d = fbState.dme;
  return !!(d.ident && d.ident.inFlasher && fbBl14HasLateInstaller());
}

/** How long a reset DME is left alone before Identify: past the late
 * gate's ~2 s (more if the car runs its poll loop slower), ms. */
const FB_BL14_LATE_SETTLE_MS = 10000;

/** Identify once the late gate has let the boot by. */
async function fbBl14IdentifyAfterLateGate() {
  fbSetStatus(
    'Waiting 10 s for the DME to start its program (the repair installer listens at every boot)…'
  );
  await new Promise((r) => setTimeout(r, FB_BL14_LATE_SETTLE_MS));
  await fbDmeIdentify(true);
}

/** Why Repair fast flash bootloader cannot start, or null. */
function fbBl14RepairWhyNot() {
  const d = fbState.dme;
  if (!d.identified) return 'Identify the DME first.';
  if (fbBl14InLateInstaller()) return null;
  if (!d.bootLoader) return 'The fast flash bootloader is not on this DME.';
  if (d.bootLoader.stampAt !== bl14.STAMP_AT)
    return 'This DME carries BL14: only BL15 can be repaired.';
  if (bl14.isCurrent(d.bootLoader))
    return `This build's bootloader (v${d.bootLoader.version}) is on the DME already.`;
  if (fbBl14HasLateInstaller()) return null;
  if (!(d.fullBin && d.flash && d.mpc))
    return 'Needs Full Binary with the DME’s pair loaded.';
  return null;
}

/** Whether the DME carries the installer ring (restore stage 1 done). */
function fbBl14HasInstallerRing() {
  const bl = fbState.dme.bootLoader;
  return !!(bl && bl.flags & bl14.INSTALLER_FLAG);
}

/** Why Restore stock bootloader cannot start, or null. */
function fbBl14RestoreWhyNot() {
  const d = fbState.dme;
  if (!d.identified) return 'Identify the DME first.';
  if (!d.bootLoader) return 'The fast flash bootloader is not on this DME.';
  if (d.bootLoader.stampAt !== bl14.STAMP_AT)
    return 'This DME carries BL14, which BMWeb cannot take off: only BL15 can be restored.';
  // the restore recognises this build's ring byte for byte: an older one
  // is updated first (one session), then it comes off like any other
  if (!bl14.isCurrent(d.bootLoader))
    return `This DME carries an older bootloader (v${d.bootLoader.version}): update it first, then it can be restored.`;
  return null;
}

/** Wire one button once: back to the flashing view, where the run shows. */
function _fbBl14Wire(btn, title, run) {
  if (btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.onclick = () => {
    fbShowOptions(false);
    fbDmeGuard(title, run);
  };
}

/** The buttons' state and the lines under them, from identify's findings. */
function fbBl14Refresh() {
  const btn = fbEls['opt-bl14-install'];
  if (!btn) return;
  _fbBl14Wire(btn, 'Install fast flash bootloader', fbBl14Install);
  const why = fbBl14WhyNot();
  btn.disabled = !!why;
  const bl = fbState.dme.bootLoader;
  // the same button and session: the two-stage install on a stock DME, or
  // one session on an older ring that swaps it for this build's
  btn.textContent = bl
    ? 'Update fast flash bootloader'
    : 'Install fast flash bootloader';
  fbEls['opt-bl14-reason'].textContent =
    why ||
    (bl
      ? `Update: your DME is on v${bl.version} (old).`
      : fbBl14HasInstaller()
        ? 'Ready: the installer body is already on the DME, so only the second stage runs.'
        : 'Ready.');
  const pbtn = fbEls['opt-bl14-repair'];
  _fbBl14Wire(pbtn, 'Repair fast flash bootloader', fbBl14Repair);
  const pwhy = fbBl14RepairWhyNot();
  pbtn.disabled = !!pwhy;
  fbEls['opt-bl14-repair-reason'].textContent =
    pwhy ||
    (fbBl14InLateInstaller()
      ? 'Ready: the DME is waiting in the repair installer, so only the second stage runs (it reconnects).'
      : fbBl14HasLateInstaller()
        ? 'Ready: the repair installer is already on the DME, so only the second stage runs.'
        : 'For a bootloader that will not answer. Slow: a full program flash, then the boot sector.');
  const rbtn = fbEls['opt-bl14-restore'];
  _fbBl14Wire(rbtn, 'Restore stock bootloader', fbBl14Restore);
  const rwhy = fbBl14RestoreWhyNot();
  rbtn.disabled = !!rwhy;
  fbEls['opt-bl14-restore-reason'].textContent =
    rwhy ||
    (fbBl14HasInstallerRing()
      ? 'Ready: the installer ring is already on the DME, so only the second stage runs.'
      : 'Ready.');
}

/** Install fast flash bootloader (BL15): the installer body if needed, then the ring, one confirmation. */
async function fbBl14Install() {
  const d = fbState.dme;
  const why = fbBl14WhyNot();
  if (why) {
    await fbMessage(why, 'Install fast flash bootloader');
    return;
  }
  // an older BL15 on the DME: one session on its ring swaps it for this
  // build's; the two-stage install is for a DME without one
  const update = !!d.bootLoader;
  const both = !update && !fbBl14HasInstaller();
  const ok = await fbConfirm(
    'Keep the ignition on, a charger on the battery and the cable plugged in until it has finished. A power or cable loss mid-write can leave the DME unbootable.\n\nInstall the fast flash bootloader?',
    'Install fast flash bootloader'
  );
  if (!ok) {
    flashLog.note(
      'Install fast flash bootloader not confirmed: nothing was sent to the car'
    );
    return;
  }

  if (update) {
    fbSetStatus(
      'Update fast flash bootloader: resetting the DME into the bootloader…'
    );
    await fbDmeFastFlash({
      title: 'Update fast flash bootloader',
      operation: 'bl14-update',
      what: 'boot loader',
      noFasterLine: true,
      confirmed: true,
      confirm: '',
      note: `DME ${d.ident.hwRef} / bootloader v${d.bootLoader.version} flags 0x${d.bootLoader.flags.toString(16)} / bootloader update to v${bl14.BODY_VERSION} flags 0x${bl14.BODY_FEATURES.toString(16)}`,
      push: async (client, cb) => {
        const r = await bl14.upgrade(client, cb);
        cb.stage('Restarting the DME');
        await client.reset();
        return r;
      },
      after: async () => {
        await fbDmeIdentify(true);
        const bl = fbState.dme.bootLoader;
        fbSetStatus(
          bl14.isCurrent(bl)
            ? `Update fast flash bootloader: done, v${bl.version} is on the DME`
            : 'Update fast flash bootloader: written. Switch the ignition off and on, then Identify.'
        );
      },
    });
    return;
  }

  if (both) {
    fbSetStatus(
      'Install fast flash bootloader, stage 1 of 2: the installer body'
    );
    // through the DME's fast flasher when it has one, else a full flash
    // through its own loader (a stock DME); either ends with an Identify
    const stage1 = {
      carry: bl14.withInstaller,
      title: 'Install fast flash bootloader (1/2: installer body)',
      confirmed: true,
    };
    if (d.fastFlasher && d.fastFlasher.ready)
      await fbDmeFastFlashProgram(stage1);
    else await fbDmeFlashProgram(stage1);
    // the push ends with an Identify: it must now report the installer
    if (!fbBl14HasInstaller()) {
      await fbMessage(
        'Stage 1 failed (see the log). Nothing else was written.',
        'Install fast flash bootloader'
      );
      return;
    }
  }

  fbSetStatus(
    both
      ? 'Install fast flash bootloader, stage 2 of 2: resetting the DME into the installer body…'
      : 'Install fast flash bootloader: resetting the DME into the installer body…'
  );
  await fbDmeFastFlash({
    title: both
      ? 'Install fast flash bootloader (2/2: bootloader)'
      : 'Install fast flash bootloader',
    operation: 'bl14-install',
    what: 'boot loader',
    noFasterLine: true,
    confirmed: true,
    confirm: '',
    note: `DME ${d.ident.hwRef} / installer body v${d.fastFlasher.version} flags 0x${d.fastFlasher.flags.toString(16)} / bootloader install`,
    push: async (client, cb) => {
      const r = await bl14.install(client, cb);
      cb.stage('Restarting the DME');
      await client.reset();
      return r;
    },
    // the push ended with the flasher's RESET: the DME restarts through the
    // new loader on its own, and Identify confirms the bootloader is there
    after: async () => {
      await fbDmeIdentify(true);
      const bl = fbState.dme.bootLoader;
      fbSetStatus(
        bl
          ? 'Install fast flash bootloader: done, the fast flasher is on the DME'
          : 'Install fast flash bootloader: written. Switch the ignition off and on, then Identify.'
      );
    },
  });
}

/** Repair fast flash bootloader: the late installer through the DME's own loader if needed, then the ring rewritten through it, one confirmation. */
async function fbBl14Repair() {
  const d = fbState.dme;
  const why = fbBl14RepairWhyNot();
  if (why) {
    await fbMessage(why, 'Repair fast flash bootloader');
    return;
  }
  const both = !fbBl14HasLateInstaller();
  const ok = await fbConfirm(
    `${both ? 'Stage 1 flashes the loaded program the slow way, with a repair installer in it. Stage 2 rewrites the boot sector through it. ' : ''}Keep the ignition on, a charger on the battery and the cable plugged in until it has finished. A power or cable loss mid-write can leave the DME unbootable.\n\nRepair the fast flash bootloader?`,
    'Repair fast flash bootloader'
  );
  if (!ok) {
    flashLog.note(
      'Repair fast flash bootloader not confirmed: nothing was sent to the car'
    );
    return;
  }

  if (both) {
    fbSetStatus(
      'Repair fast flash bootloader, stage 1 of 2: the repair installer, through the DME’s own loader'
    );
    await fbDmeFlashProgram({
      carry: bl14.withLateInstaller,
      title: 'Repair fast flash bootloader (1/2: repair installer)',
      confirmed: true,
      // an Identify inside the late gate's window enters the installer
      after: fbBl14IdentifyAfterLateGate,
    });
    if (!fbBl14HasLateInstaller()) {
      await fbMessage(
        'Stage 1 failed (see the log). Nothing else was written.',
        'Repair fast flash bootloader'
      );
      return;
    }
  }

  // sitting in the installer already: the session reconnects to it (a
  // reset request would go unheard)
  const waiting = fbBl14InLateInstaller();
  if (waiting) fbDmeSetFastLive(true);
  fbSetStatus(
    `Repair fast flash bootloader${both ? ', stage 2 of 2' : ''}: ${waiting ? 'reconnecting to' : 'resetting the DME into'} the repair installer…`
  );
  await fbDmeFastFlash({
    title: both
      ? 'Repair fast flash bootloader (2/2: bootloader)'
      : 'Repair fast flash bootloader',
    operation: 'bl15-repair',
    what: 'boot loader',
    noFasterLine: true,
    confirmed: true,
    confirm: '',
    // past the ring's window: a line held across the reset lands in it
    lateHold: true,
    note: `DME ${d.ident.hwRef} / bootloader ${d.bootLoader ? `v${d.bootLoader.version} flags 0x${d.bootLoader.flags.toString(16)}` : 'not read (in the installer)'} / repair installer v${fbState.dme.fastFlasher.version} flags 0x${fbState.dme.fastFlasher.flags.toString(16)} / bootloader repair to v${bl14.BODY_VERSION}`,
    push: async (client, cb) => {
      const r = await bl14.upgrade(client, cb);
      cb.stage('Restarting the DME');
      await client.reset();
      return r;
    },
    after: async () => {
      await fbBl14IdentifyAfterLateGate();
      const bl = fbState.dme.bootLoader;
      fbSetStatus(
        bl14.isCurrent(bl)
          ? `Repair fast flash bootloader: done, v${bl.version} is on the DME.`
          : 'Repair fast flash bootloader: written. Switch the ignition off and on, then Identify.'
      );
    },
  });
}

/** Restore stock bootloader: BL15 swapped for the installer ring if needed, then the boot region put back to stock, one confirmation. */
async function fbBl14Restore() {
  const d = fbState.dme;
  const why = fbBl14RestoreWhyNot();
  if (why) {
    await fbMessage(why, 'Restore stock bootloader');
    return;
  }
  const both = !fbBl14HasInstallerRing();
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
      note: `DME ${d.ident.hwRef} / bootloader v${d.bootLoader.version} flags 0x${d.bootLoader.flags.toString(16)} / ${operation}`,
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
      'bl15-to-installer',
      bl14.toInstaller,
      () => fbDmeIdentify(true)
    );
    if (!fbBl14HasInstallerRing()) {
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
    'bl15-restore',
    bl14.restore,
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
