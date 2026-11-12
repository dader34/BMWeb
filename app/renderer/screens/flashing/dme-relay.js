// The Fast flasher page's GS20 relay section: the whole emu-proven relay
// chain (gs20-emu tools/dme_relay_p1.py, ALL PASS 2026-11-07) as one
// button, with no CAN hardware on this side. The flow reads the DME's own
// program, adds the relay payload (core/flash/relay.js: a stub in the free
// window at 0xDCC00 plus one hook word in the MPC, refused unless the MPC
// carries the program the payload was built against) and flashes it back
// through the one-click. On the reboot the DME ALONE services the
// transmission over the car's PT-CAN -- staging its RAM monitor word by
// word, redirecting its stack pointer, then write, read, a DPP window, a
// flash read, the echo, and LAST a stock readback of the payload's own
// first word -- while its own diagnostics stay alive. BMWeb sends no CAN
// frame at any point; the only wire is the K-line the flash used.
//
// PROBE MODE (relayBlob.mode === 'probe', stamped by relay_blob_js.py
// --probe): the same staging, then ONLY stock-answered reads -- no pair,
// no STKOV, no SP write, no monitor commands. The redirect is the one
// step that can derail the transmission, so the probe build physically
// cannot: three car builds staged hundreds of writes with the box alive,
// and the clicking always began at the redirect. It answers ONE question
// the v10 runs died before answering: does the payload survive staging
// at 0xCAD4 on the REAL box (the clean-span bitmap was measured on the
// emulator's GS20 model). Word 0 read back cc 00 = the span held and the
// killer is the redirect; anything else = the span is shadow on this
// transmission. Every frame is stock-answered, so expectReplies equals
// expectGood equals steps in this mode.
//
// The verdict block at 0x3F9E74 (the livetune RAM tier: car-proven quiet,
// far below the heap) is read back with the stock read-by-address (no
// login) and judged: every answering step answered, all but two acked
// (the redirect answers nothing; the readback's 0x9F tag is not an ack),
// and the last answer is a four-way verdict -- the monitor's own [20 9F]
// reply (alive: stock never sends that tag), the pad word pristine
// (died before or at the first instruction -- v8 spends word 0 on a NOP
// the car's one-byte clobber can eat harmlessly, entering at word 1), a
// marker value (the monitor RAN and died in that named block -- the
// ladder rewrites word 0 at every boundary), or zeros/junk (payload
// never survived / span dirty).  Car run 3 read word 0 back one byte
// corrupted: the payload survived, the code didn't. The service itself is seconds, but a real
// transmission can sit minutes on one answer (car 2026-11-07: a stall at
// 127/240 that self-healed), so the poll waits up to five minutes.
//
// WHAT STAYS BEHIND: the transmission's monitor is RAM-only -- ignition
// off clears it by itself. The DME keeps the relay program until "Restore
// stock program" runs; the stock pair as read is kept in memory for that
// and saved to files (fbDmeSaveRead) in case the page is closed first.
/* exported fbRelayHtml, fbRelayRefresh */

// {flash, mpc} the stock pair read during a run -- the restore source
let fbRelaySaved = null;

/** The section. Buttons are wired in fbRelayRefresh (the page's pattern). */
function fbRelayHtml() {
  return `
      <div class="fb-section" id="fb-relay-section">
        <div class="fb-code">GS20 RELAY</div>
        <div class="fb-row">
          <button class="btn danger" id="fb-relay-run" disabled
            title="Reads the DME's own program, adds the relay payload and flashes it back. The DME then services the transmission alone over the car's PT-CAN -- no CAN hardware on this side.">Run the ${relayBlob.mode === 'probe' ? 'safe probe' : 'relay test'}</button>
          <button class="btn" id="fb-relay-again" disabled
            title="Reads the verdict block again over the K-line.">Read the verdict</button>
          <button class="btn" id="fb-relay-restore" disabled
            title="Flashes the stock pair (as read during the run) back -- takes the relay payload out of the DME.">Restore stock program</button>
        </div>
        <div class="fb-faint" id="fb-relay-reason"></div>
        <div class="fb-faint" id="fb-relay-result" hidden></div>
      </div>`;
}

/** Wire once, then gate from the state (called by fbFastPaint). */
function fbRelayRefresh() {
  if (!fbEls['relay-section']) return;
  if (!fbEls['relay-run'].dataset.wired) {
    fbEls['relay-run'].dataset.wired = '1';
    fbEls['relay-run'].onclick = () => fbDmeGuard('GS20 relay', fbRelayRun);
    fbEls['relay-again'].dataset.wired = '1';
    fbEls['relay-again'].onclick = () => fbDmeGuard('GS20 relay', fbRelayAgain);
    fbEls['relay-restore'].dataset.wired = '1';
    fbEls['relay-restore'].onclick = () =>
      fbDmeGuard('GS20 relay', fbRelayRestore);
  }
  const d = fbState.dme;
  const why = fbRelayGateWhy();
  fbEls['relay-run'].disabled = !!why || !!fbState.running;
  fbEls['relay-again'].disabled =
    !d || !d.identified || !webBus.port || !!fbState.running;
  fbEls['relay-restore'].disabled = !fbRelaySaved || !!fbState.running;
  fbEls['relay-reason'].textContent =
    why ||
    (relayBlob.mode === 'probe'
      ? 'Ready (SAFE PROBE): same staging, then readbacks only -- no redirect, nothing that can disturb the transmission. Says whether the RAM span held on the real box.'
      : "Ready: reads the DME's own program, adds the payload, flashes back. The DME services the transmission alone (seconds, minutes if it dawdles); the verdict is read over the K-line.");
}

/** Why the relay test cannot run, or null. */
function fbRelayGateWhy() {
  const d = fbState.dme;
  if (!d || !d.identified) return 'Identify the DME first.';
  if (!fbDmeIsMs451())
    return 'The relay payload is built and proven for the MS45.1 only.';
  if (typeof webBus === 'undefined' || !webBus.port)
    return 'Needs a cable (a Web Serial port or a gateway).';
  if (
    typeof relayBlob === 'undefined' ||
    typeof relayPatchPair !== 'function' ||
    typeof relayReadState !== 'function' ||
    typeof oneClick === 'undefined'
  )
    return 'The relay client is not loaded in this build.';
  return null;
}

/** The whole chain: one-click in, read, patch, flash, reboot, verdict. */
async function fbRelayRun() {
  const d = fbState.dme;
  const why = fbRelayGateWhy();
  if (why) {
    await fbMessage(why, 'GS20 relay');
    return;
  }
  const probeMode = relayBlob.mode === 'probe';
  const go = await fbConfirm(
    probeMode
      ? 'Start the SAFE PROBE? Same staging as the relay test, then readbacks only -- NO redirect, so nothing can disturb the transmission (its own firmware runs throughout). The last readback says why the full service died on this car: the staged word intact = the RAM span held (the killer is the redirect step); changed = the span did not hold on the real box.'
      : 'Start the relay test? This will read your program and patch it. If the monitor hears nothing for about a minute it now resets the transmission by itself -- even a healthy run reboots the box shortly after the verdict; that is the deadline doing its job, and any clicking stops on its own.',
    probeMode ? 'GS20 relay safe probe' : 'GS20 relay'
  );
  if (!go) {
    flashLog.note('GS20 relay not confirmed: nothing was sent');
    return;
  }
  fbRelayLastText('');
  let flashed = false;
  await fbDmeFastFlash({
    title: 'GS20 relay',
    operation: 'gs20-relay',
    what: 'program',
    confirmed: true,
    note: `DME ${d.ident.hwRef} / prog ${d.ident.progRef} / GS20 relay ${probeMode ? 'safe probe' : 'service'} (no CAN from this side)`,
    prepare: async () => {
      // A DME that identify found in its fast flasher answers no stock
      // KWP, so the selector-5 ladder cannot even ask for a seed. The
      // gate is installed in this DME (the relay push writes the whole
      // flash back, gate included) and it listens first at every key-on
      // -- well over twenty seconds on the car -- before the program
      // boots and the stub runs its service. The car's run 5 pressed
      // inside that window: identify's HELLO probe answered, the ladder
      // got 4-byte garbage, IFH-0019, twice. The runner's own entry
      // reaches the body by HELLO without the one-click -- and taking it
      // during the window is ideal: the program never boots, so the old
      // payload's service never runs at all this key cycle.
      if (fbState.dme.ident && fbState.dme.ident.inFlasher) {
        flashLog.note(
          'GS20 relay: the DME is in its fast flasher; entering it by HELLO, no one-click'
        );
        return {};
      }
      await fbDmeOneClickInto('GS20 relay');
      return {};
    },
    push: async (client, cb) => {
      cb.stage('Reading the external flash');
      const flash = await fastFlashWire.readArea(client, 0, 0x100000, (n) =>
        cb.progress(Math.floor((n * 40) / 0x100000))
      );
      cb.stage('Reading the MPC');
      const mpc = await fastFlashWire.readArea(
        client,
        fastFlashWire.MPC_WINDOW,
        MS45_MPC_LENGTH,
        (n) => cb.progress(40 + Math.floor((n * 15) / MS45_MPC_LENGTH))
      );
      // the stock pair is the restore source: in memory and on disk
      fbRelaySaved = { flash, mpc };
      fbDmeSaveRead(flash, mpc);
      cb.stage('Adding the relay payload');
      const patched = relayPatchPair(flash, mpc);
      const chip = fbDmeChipImage(patched.flash, patched.mpc, true);
      cb.stage('Flashing the relay program');
      const r = await fastFlashWire.pushProgram(
        client,
        chip,
        {
          ...cb,
          progress: (p) => cb.progress(55 + Math.floor((p * 45) / 100)),
        },
        // block 0 follows the app's own rule (dme-fast.js fbDmeBlock0InSets:
        // alone and last where the resident hook sits at MPC 0x8, in the
        // sets on a one-click DME -- ~16 s faster and just as safe there)
        {
          mpc: patched.mpc,
          pagesets: true,
          block0InSets: fbDmeBlock0InSets(),
        }
      );
      flashed = true;
      return {
        ...r,
        summary: 'the relay program is on; the DME reboots into it',
      };
    },
    after: async () => {},
  });
  if (!flashed) return; // the failure is already on the status line and log
  fbRelayRefresh();
  await fbRelayShowVerdict('GS20 relay');
}

/** Re-read the verdict block on demand (also the post-flash read's core). */
async function fbRelayAgain() {
  const d = fbState.dme;
  if (!d || !d.identified || !webBus.port) return;
  await fbRelayShowVerdict('GS20 relay verdict');
}

/**
 * Read the verdict block over the K-line and show it. The DME was just
 * rebooted onto the relay program, so it may still be booting or running
 * the service: poll until the block says done (or a blank block settles
 * the question) -- patiently, a real transmission can sit minutes on one
 * answer -- then decode and judge.
 *
 * NO bus claim around the poll: the livetune sender's telegrams queue
 * through the bus lock, which refuses everyone while a claim stands -- our
 * own claim included. The car's first two runs died exactly there (every
 * read refused as "the cable is busy" before a byte left the machine).
 * @param {string} title
 */
async function fbRelayShowVerdict(title) {
  fbSetStatus('Reading the GS20 relay verdict');
  webDropSession(MS45_SGBD);
  const sender = ms45LiveTuneSender({});
  const { state: s, attempts, lastWhy } = await relayAwaitVerdict(sender);
  if (!s) {
    fbSetStatus('GS20 relay: no verdict read');
    flashLog.note(
      `GS20 relay: no verdict read after ${attempts} attempts -- last: ${lastWhy}`
    );
    fbRelayLastText(
      `No verdict read (${attempts} attempts).\nLast attempt: ${lastWhy}`
    );
    return;
  }
  const text = fbRelayVerdictText(s);
  fbRelayLastText(text);
  flashLog.note(`GS20 relay verdict: ${text.split('\n').join('; ')}`);
  const v = s.magic === relayBlob.magic ? relayVerdict(s).ok : false;
  const probeMode = relayBlob.mode === 'probe';
  await fbMessage(
    text +
      (v
        ? probeMode
          ? '\n\nThe staged payload is RAM-only: ignition off clears it. Restore the DME with the button below when done.'
          : "\n\nThe transmission's monitor is RAM-only: ignition off clears it. Restore the DME with the button below when done."
        : ''),
    title
  );
}

/** The verdict block as lines, judged against the blob's expectations. */
function fbRelayVerdictText(s) {
  if (s.magic !== relayBlob.magic)
    return (
      `No relay state at 0x${relayBlob.state.toString(16)} ` +
      `(magic 0x${s.magic.toString(16)}): the DME is not running the relay program.`
    );
  const v = relayVerdict(s);
  const phase = s.phase === 2 ? 'done' : s.phase === 1 ? 'waiting' : 'sending';
  const last = s.last.map((x) => x.toString(16).padStart(2, '0')).join(' ');
  return (
    `step ${s.step}/${relayBlob.steps}, ${phase}, ${s.replies} answered, ` +
    `${s.good} acked, digest 0x${s.digest.toString(16)}\n` +
    `last answer: ${last}\n${v.note}\n` +
    (v.ok
      ? 'VERDICT: PASS'
      : `VERDICT: FAIL (${v.checks
          .filter((c) => !c.ok)
          .map((c) => c.what)
          .join(', ')})`)
  );
}

/** Show/hide the result line. */
function fbRelayLastText(text) {
  const el = fbEls['relay-result'];
  if (!el) return;
  el.hidden = !text;
  el.textContent = text;
}

/**
 * Take the relay payload back out: the stock pair as read during the run,
 * through the same one-click entry. The push is the same diff push, so
 * only the payload region and the hook word revert -- a few seconds.
 */
async function fbRelayRestore() {
  const saved = fbRelaySaved;
  if (!saved) return;
  const go = await fbConfirm(
    'Restore stock program\n\n' +
      'Flashes the pair as read during the relay run back into the DME -- ' +
      'the relay payload and its hook word revert, everything else is ' +
      'already what the DME carries. Only the differing blocks are written.\n\n' +
      'Keep the ignition on and the cable plugged in until it has finished.\n\n' +
      'Restore the stock program?',
    'GS20 relay'
  );
  if (!go) {
    flashLog.note('GS20 relay restore not confirmed: nothing was sent');
    return;
  }
  let done = false;
  await fbDmeFastFlash({
    title: 'GS20 relay restore',
    operation: 'gs20-relay-restore',
    what: 'program',
    confirmed: true,
    note: `DME ${fbState.dme.ident.hwRef} / restore the stock program after the relay test`,
    prepare: async () => {
      // same as the run: inside the gate's listen window there is no
      // stock KWP for the ladder -- the runner's HELLO entry takes over
      if (fbState.dme.ident && fbState.dme.ident.inFlasher) {
        flashLog.note(
          'GS20 relay restore: the DME is in its fast flasher; entering it by HELLO, no one-click'
        );
        return {};
      }
      await fbDmeOneClickInto('GS20 relay restore');
      return {};
    },
    push: async (client, cb) => {
      cb.stage('Signing the stock pair');
      const chip = fbDmeChipImage(saved.flash, saved.mpc, true);
      cb.stage('Flashing the stock program');
      const r = await fastFlashWire.pushProgram(
        client,
        chip,
        { ...cb, progress: (p) => cb.progress(p) },
        { mpc: saved.mpc, pagesets: true, block0InSets: fbDmeBlock0InSets() }
      );
      done = true;
      return r;
    },
    after: async () => {},
  });
  if (done) {
    fbRelaySaved = null;
    fbRelayLastText('');
    fbSetStatus('GS20 relay restore: the DME is back on its stock program');
    flashLog.note('GS20 relay restore: the stock program is back');
  }
  fbRelayRefresh();
}
