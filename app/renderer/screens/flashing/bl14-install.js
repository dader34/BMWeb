// Flashing/Tuning: installing the BL15 boot loader (core/flash/bl14.js) --
// "Install fast flash bootloader" -- one guided button in Custom Options.
// BENCH ONLY (localhost), like the fast flasher it rides on.
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
//
// "Restore stock bootloader" is its mirror, also one confirmation and up to
// two sessions, both on the ring (a held line never gets past BL15 to a
// resident body, and BL15's own body may not write the 8 KB sector):
//   1. on BL15: the ring swapped for its installer variant (bl14.
//      toInstaller). Skipped when the DME already carries it;
//   2. on the installer ring: both words stock, the ring blanked
//      (bl14.restore). Program, tune and MPC are not touched, and no file
//      needs loading.
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
  if (d.bootLoader) return 'The fast flasher is on this DME.';
  if (fbBl14HasInstaller()) return null;
  // stage 1 writes the pair: through a ready fast flasher the DME already
  // has, or through the DME's own loader (a stock DME, or an old body the
  // installer replaces)
  if (!(d.fullBin && d.flash && d.mpc))
    return 'Needs Full Binary with the DME’s pair loaded (the program it already runs): the first stage writes it with the installer body.';
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
  fbEls['opt-bl14-reason'].textContent =
    why ||
    (fbBl14HasInstaller()
      ? 'Ready: the installer body is already on the DME, so only the second stage runs.'
      : 'Ready.');
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
  if (!fbProtectTesting()) return;
  const why = fbBl14WhyNot();
  if (why) {
    await fbMessage(why, 'Install fast flash bootloader');
    return;
  }
  const both = !fbBl14HasInstaller();
  const ok = await fbConfirm(
    'The loader build and the programming log on the DME are kept. A power or cable loss between an erase and its rewrite leaves a DME that neither the loader nor a full flash can reach: only a BDM / boot-mode rig recovers it. Keep the ignition on, a charger on the battery and the cable plugged in until it has finished.\n\nInstall the fast flash bootloader?',
    'Install fast flash bootloader'
  );
  if (!ok) {
    flashLog.note(
      'Install fast flash bootloader not confirmed: nothing was sent to the car'
    );
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
        'Stage 1 did not leave the installer body on the DME (see the status line and the log). The boot region was not touched.',
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
          : 'Install fast flash bootloader: written and verified, but Identify did not find it yet. Switch the ignition off and on, then press Identify.'
      );
    },
  });
}

/** Restore stock bootloader: BL15 swapped for the installer ring if needed, then the boot region put back to stock, one confirmation. */
async function fbBl14Restore() {
  const d = fbState.dme;
  if (!fbProtectTesting()) return;
  const why = fbBl14RestoreWhyNot();
  if (why) {
    await fbMessage(why, 'Restore stock bootloader');
    return;
  }
  const both = !fbBl14HasInstallerRing();
  const ok = await fbConfirm(
    'The fast flash bootloader comes off the DME: the loader\u2019s two patched words go back to stock and the bootloader is blanked out of the boot sector. Fast Flash, Fast Read and the AIF editor go with it. The loader build, the programming log, the program, the tune and the MPC are kept. A power or cable loss between an erase and its rewrite leaves a DME that neither the loader nor a full flash can reach: only a BDM / boot-mode rig recovers it. Keep the ignition on, a charger on the battery and the cable plugged in until it has finished.\n\nRestore the stock bootloader?',
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
        'Stage 1 did not leave the installer ring on the DME (see the status line and the log). The 8 KB sector was not touched, so the DME still boots through BL15.',
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
          ? 'Restore stock bootloader: written and verified, but Identify still reads the bootloader\u2019s stamp. Switch the ignition off and on, then press Identify.'
          : 'Restore stock bootloader: done, the DME runs the stock loader'
      );
    }
  );
}
