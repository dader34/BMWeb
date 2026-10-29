// Flashing/Tuning: "Install live tune" -- one button in Custom Options that
// writes the loaded pair as a program flash with live tune in it
// (core/flash/livetune-patch.js). BENCH ONLY (localhost), like the rest of
// that area.
//
// The loaded pair is the starting point: its program must be the stock
// 0044570 program or a live tune build of it (an older one is upgraded in
// place), and its tune is what goes on the DME and what live tune's saves
// are kept against (the golden copy). The flash goes the way the Flash
// Program button would send it: through the fast flasher when that is in
// use, else through the DME's own loader. One confirmation; Identify after.
/* exported fbLtInstallHtml, fbLtInstallRefresh */

function fbLtInstallHtml() {
  return `
      <div class="fb-code">LIVE TUNE</div>
      <div class="fb-dim">Change tables and values while the engine runs, saved at key-off when asked.</div>
      <div class="fb-row">
        <button class="btn danger" id="fb-opt-lt-install" disabled>Install live tune</button>
      </div>
      <div class="fb-faint" id="fb-opt-lt-reason"></div>`;
}

/** What the loaded pair holds where live tune goes, or null. */
function fbLtInstallSurvey() {
  const d = fbState.dme;
  if (!d.flash || !d.mpc) return null;
  return liveTunePatch.survey(d.flash, d.mpc);
}

/** Why Install live tune cannot start, or null. */
function fbLtInstallWhyNot() {
  const d = fbState.dme;
  if (!d.identified) return 'Identify the DME first.';
  if (!(d.fullBin && d.flash && d.mpc))
    return 'Needs Full Binary with a pair loaded: the program flash writes it with live tune in it.';
  if (d.flash.length < 0x5d000 || fbDmeProgramHasNoTune())
    return 'The loaded pair needs its tune: live tune keeps a copy of it to save against.';
  if (!fbLtInstallSurvey())
    return 'The loaded program is not the stock 0044570 program or a live tune build of it.';
  return null;
}

/** The button's state and the line under it. */
function fbLtInstallRefresh() {
  const btn = fbEls['opt-lt-install'];
  if (!btn) return;
  if (!btn.dataset.wired) {
    btn.dataset.wired = '1';
    // back to the flashing view first: the run's progress and log are there
    btn.onclick = () => {
      fbShowOptions(false);
      fbDmeGuard('Install live tune', fbLtInstall);
    };
  }
  const why = fbLtInstallWhyNot();
  btn.disabled = !!why;
  // only why it cannot run; the confirmation says what a run will do
  fbEls['opt-lt-reason'].textContent = why || '';
}

/** Install live tune: the loaded pair, live tune spliced in, as a program flash. */
async function fbLtInstall() {
  if (!fbProtectTesting()) return;
  const why = fbLtInstallWhyNot();
  if (why) {
    await fbMessage(why, 'Install live tune');
    return;
  }
  const from = fbLtInstallSurvey();
  const v = liveTunePatch.VERSION;
  const fast = fbDmeUseFastFlasher();
  const ok = await fbConfirm(
    `Writes the loaded pair as a ${fast ? 'Fast Flash Program' : 'Flash Program'} with live tune ${v} in it. Keep the ignition on, a charger on the battery and the cable plugged in until it has finished.\n\nInstall live tune?`,
    'Install live tune'
  );
  if (!ok) {
    flashLog.note(
      'Install live tune not confirmed: nothing was sent to the car'
    );
    return;
  }
  const opts = {
    title: 'Install live tune',
    confirmed: true,
    patch: (flash, mpc) => {
      const r = liveTunePatch.splice(flash, mpc);
      flashLog.note(
        `Live tune ${v} spliced in (the loaded pair held ${liveTunePatch.describe(r.from)}); golden copy from the tune at ext 0xE0000`
      );
      return r;
    },
    patchName: `live tune ${v}`,
    after: async () => {
      await fbDmeIdentify(true);
      fbSetStatus(
        fbState.dme.carProgramKind === 'livetune'
          ? `Install live tune: done, the DME runs live tune ${v}`
          : `Install live tune: written. Open Tuning and switch LIVE on to check it answers.`
      );
    },
  };
  if (fast) await fbDmeFastFlashProgram(opts);
  else await fbDmeFlashProgram(opts);
}
