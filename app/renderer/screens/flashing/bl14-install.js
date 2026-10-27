// Flashing/Tuning: installing the BL15 boot loader (core/flash/bl14.js) --
// "Install fast flash bootloader" -- one guided button in Custom Options' bench programming-log section. BENCH ONLY
// (localhost), like the fast flasher it rides on.
//
// One confirmation, then up to two flasher sessions without another
// question:
//   1. the installer body: a Fast Flash Program of the loaded pair carrying
//      the installer variant of the resident body (its window opens at
//      0x4000, where the loader's handoff and park words live) instead of the shipped
//      one -- skipped when the DME already carries it (a run stopped after
//      this stage picks up from here);
//   2. BL15: on that body, the DME's own boot region read, the ring spliced
//      in, both sectors rewritten (bl14.install).
// A later Fast Flash Program puts the shipped body back; BL15 stays.
/* exported fbBl14Html, fbBl14Refresh */

function fbBl14Html() {
  return `
      <hr class="fb-sep">
      <div class="fb-code">FAST FLASH BOOTLOADER</div>
      <div class="fb-dim">Install fast flashing program to the DME</div>
      <div class="fb-row">
        <button class="btn danger" id="fb-opt-bl14-install" disabled>Install fast flash bootloader</button>
      </div>
      <div class="fb-faint" id="fb-opt-bl14-reason"></div>`;
}

/** Whether the DME already carries the installer body, ready to use. */
function fbBl14HasInstaller() {
  const det = fbState.dme.fastFlasher;
  return bl14.isInstaller(det) && det.ready;
}

/** Why Install fast flash bootloader cannot start, or null. */
function fbBl14WhyNot() {
  const d = fbState.dme;
  const det = d.fastFlasher;
  if (!d.identified) return 'Identify the DME first.';
  if (d.bootLoader) return 'The fast flasher is on this DME.';
  if (fbBl14HasInstaller()) return null;
  if (!det) return 'Needs the fast flasher on the DME.';
  if (!(det.ready || det.upgradable)) return fastFlasher.describe(det);
  if (!(d.fullBin && d.flash && d.mpc))
    return 'Needs Full Binary with the DME’s pair loaded (the program it already runs): the first stage pushes it with the installer body.';
  return null;
}

/** The button's state and the line under it, from identify's findings. */
function fbBl14Refresh() {
  const btn = fbEls['opt-bl14-install'];
  if (!btn) return;
  if (!btn.dataset.wired) {
    btn.dataset.wired = '1';
    // back to the flashing view first: the run's progress and log are there
    btn.onclick = () => {
      fbShowOptions(false);
      fbDmeGuard('Install fast flash bootloader', fbBl14Install);
    };
  }
  const why = fbBl14WhyNot();
  btn.disabled = !!why;
  fbEls['opt-bl14-reason'].textContent =
    why ||
    (fbBl14HasInstaller()
      ? 'Ready: the installer body is already on the DME, so only the second stage runs.'
      : 'Ready.');
}

/**
 * A step with no progress of its own (an Identify): its line on the status
 * and in the log, the bar sweeping until it ends.
 * @param {string} text
 * @param {() => Promise<void>} fn
 */
async function fbBl14Waiting(text, fn) {
  fbSetStatus(text);
  fbEls.fill.classList.add('indeterminate');
  try {
    await fn();
  } finally {
    fbEls.fill.classList.remove('indeterminate');
  }
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
    await fbDmeFastFlashProgram({
      carry: bl14.withInstaller,
      title: 'Install fast flash bootloader (1/2: installer body)',
      confirmed: true,
      // the Identify after the push is quiet by design (the push's result
      // owns the status line); here it is a step of the install, so it says so
      after: () =>
        fbBl14Waiting(
          'Install fast flash bootloader: restarting the DME and checking it runs the installer body…',
          () => fbDmeIdentify(true)
        ),
    });
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
      await fbBl14Waiting(
        'Install fast flash bootloader: restarting the DME and identifying it…',
        () => fbDmeIdentify(true)
      );
      const bl = fbState.dme.bootLoader;
      fbSetStatus(
        bl
          ? 'Install fast flash bootloader: done, the fast flasher is on the DME'
          : 'Install fast flash bootloader: written and verified, but Identify did not find it yet. Switch the ignition off and on, then press Identify.'
      );
    },
  });
}
