// The Fast flasher page's GS20 relay section: the whole emu-proven relay
// chain (gs20-emu tools/dme_relay_p1.py, ALL PASS 2026-11-06) as one
// button, with no CAN hardware on this side. The flow reads the DME's own
// program, adds the relay payload (core/flash/relay.js: a stub in the free
// window at 0xDCC00 plus one hook word in the MPC, refused unless the MPC
// carries the program the payload was built against) and flashes it back
// through the one-click. On the reboot the DME ALONE services the
// transmission over the car's PT-CAN -- staging its RAM monitor word by
// word, redirecting its stack pointer, then echo, write, read, a DPP window
// and a flash read -- while its own diagnostics stay alive. BMWeb sends no
// CAN frame at any point; the only wire is the K-line the flash used.
//
// After a few seconds (240 reply-paced steps) the verdict block at
// 0x3F9E74 (the livetune RAM tier: car-proven quiet, far below the heap)
// is read back with the stock read-by-address (no login) and judged:
// every answering step answered and acked, the last answer the
// transmission's own bytes through its monitor.
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
            title="Reads the DME's own program, adds the relay payload and flashes it back. The DME then services the transmission alone over the car's PT-CAN -- no CAN hardware on this side.">Run the relay test</button>
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
    "Ready: reads the DME's own program, adds the payload, flashes back. The DME services the transmission alone (~2.4 s); the verdict is read over the K-line.";
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
  const go = await fbConfirm(
    'GS20 relay test\n\n' +
      "Reads the DME's own program, adds the relay payload (a stub in the free window at 0xDCC00 plus one hook word in the MPC) and flashes it back.\n\n" +
      "On the reboot the DME alone services the transmission over the car's PT-CAN -- no CAN frames leave this side; the only wire is the K-line. After a few seconds the verdict block is read back: 240 steps, 239 answered and acked, the last answer the transmission's own bytes through its RAM monitor.\n\n" +
      'The transmission\'s monitor is RAM-only: ignition off clears it by itself. The DME keeps the relay program until "Restore stock program" runs (the stock pair is saved to files too).\n\n' +
      'Parked, in P, ignition on, engine OFF. Keep the cable plugged in until it has finished.\n\n' +
      'Run the relay test?',
    'GS20 relay'
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
    counter: true,
    confirmed: true,
    note: `DME ${d.ident.hwRef} / prog ${d.ident.progRef} / GS20 relay service (no CAN from this side)`,
    prepare: async () => {
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
        { mpc: patched.mpc, pagesets: true, block0InSets: false }
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
 * the 2.4 s service: poll until the block says done (or a blank block
 * settles the question), then decode and judge.
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
  await fbMessage(
    text +
      (v
        ? "\n\nThe transmission's monitor is RAM-only: ignition off clears it. Restore the DME with the button below when done."
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
    `last answer: ${last}\n` +
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
    counter: true,
    confirmed: true,
    note: `DME ${fbState.dme.ident.hwRef} / restore the stock program after the relay test`,
    prepare: async () => {
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
        { mpc: saved.mpc, pagesets: true, block0InSets: false }
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
