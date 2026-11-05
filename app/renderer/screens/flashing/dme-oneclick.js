// The Fast flasher page's one-click route: when "Use the fast flasher" is
// on and the DME has NO ready flasher (a stock DME, no bootloader, no
// resident body), Read DME, Flash Tune and Flash Program -- and the page's
// own ISN and EEPROM tools -- start the v21 fast-flash body through the
// selector-5 grant (core/flash/oneclick.js) plus the no-install trigger
// (core/flash/trigger.js), then run the operation through the body exactly
// as an installed flasher would. The DME ends the session back on its
// stock program with its calibration intact: nothing is installed, and the
// grant is RAM-only. This is the "no first flash, no unlock, no install"
// path; with a ready flasher on the DME the normal routes take over and
// none of this runs.
//
// THE SHAPE OF A ONE-CLICK SESSION (all proven on the emulator, stock
// table; see ms45-emu tools/experiments/noinstall_v5r.py and
// noinstall_oneclick_sim.py):
//   1. the stock KWP session: selector-5 login -> grant -> 10 86 -> the
//      trigger's write-enable erase (the WHOLE calibration sector
//      0x40000-0x60000 goes blank -- a stock sector's tail holds nothing
//      but the two valid-mark dwords, which the closing push rewrites) ->
//      3D staging -> 31 FA fire;
//   2. the body owns the line from SRAM: picked up like a session that was
//      cut short (fastFlashWire webLink resume -- no reset, no break, and
//      unlike the installed-flasher entry, NO break-capable cable needed);
//   3. the operation runs through the resident protocol (the shared
//      fbDmeFastFlash session machinery, entered via its live-flash resume
//      branch), and what the trigger erased is either rewritten by the
//      flash itself or -- for everything that is not a flash -- pushed back
//      byte-identical through the body's own cal push, marks included.
//
// RECOVERY, because the erase in step 1 is real: a failure after it leaves
// the calibration blank. If the body answered, run the SAME operation
// again -- the entry finds the live flasher and resumes, the push compares,
// and only the missing part is sent. If it did not, switch the ignition
// off for ten seconds and back on (the DME drops to its stock loader) and
// complete a stock Flash Tune. Nothing else on the DME is touched at any
// point: the ISN, the EEPROM, the program and the AIF stay as they are.
/* exported fbDmeOneClickDue, fbDmeOneClickGate, fbDmeOneClickInto, fbDmeOneClickTrigger, fbDmeOneClickFlashTune, fbDmeOneClickFlashProgram, fbDmeOneClickRead, fbDmeOneClickIsnRead, fbDmeOneClickIsnWrite, fbDmeOneClickEepromDump, fbOneClickToolsHtml, fbOneClickToolsRefresh */

/** Appended to every failure that may have left the calibration blank. */
const FB_OC_RECOVERY =
  'The calibration is blank until a flash completes: run the SAME operation ' +
  'again -- it resumes the running flasher and finishes -- or switch the ' +
  'ignition off for ten seconds and complete a stock Flash Tune.';

/**
 * Whether an operation on this DME takes the one-click route: the fast
 * flasher is WANTED and identify found no ready one on the DME. With a
 * ready flasher the normal fast routes run instead; with the setting off,
 * the stock loader does. This is the routing test only -- the operation's
 * own gate (fbDmeOneClickGate) says whether it may actually start.
 * @returns {boolean}
 */
function fbDmeOneClickDue() {
  const d = fbState.dme;
  return fbFastFlasherWanted() && !(d && d.fastFlasher && d.fastFlasher.ready);
}

/**
 * Why the one-click route cannot run, or null. Deliberately WITHOUT the
 * break-line requirement of the installed-flasher entry: the trigger needs
 * no held break, only a port that can talk KWP.
 * @param {{ms451?: boolean}} [opts] - ms451: the ISN/EEPROM tools are
 *   MS45.1 only (the same gate the rail page uses).
 * @returns {string|null}
 */
function fbDmeOneClickGateWhy(opts = {}) {
  const d = fbState.dme;
  if (!d || !d.identified) return 'Identify the DME first.';
  if (opts.ms451 && !fbDmeIsMs451()) return 'This tool is MS45.1 only.';
  if (typeof webBus === 'undefined' || !webBus.port)
    return 'Needs a cable (a Web Serial port or a gateway).';
  if (
    typeof fastFlasherBlob === 'undefined' ||
    typeof triggerWire === 'undefined' ||
    typeof oneClick === 'undefined'
  )
    return 'The one-click client is not loaded in this build.';
  return null;
}

/**
 * The one-click entry's gate, dialog and all.
 * @param {string} title
 * @param {{ms451?: boolean}} [opts]
 * @returns {Promise<boolean>} true when the route may start.
 */
async function fbDmeOneClickGate(title, opts = {}) {
  const why = fbDmeOneClickGateWhy(opts);
  if (why) {
    await fbMessage(why, title);
    return false;
  }
  return true;
}

/** The trigger's body out of the bootstrap blob (fails loudly if it grew). */
function fbDmeOneClickBody() {
  return triggerWire.triggerBodyFromBlob(fastFlasherBlob);
}

// Map the sel-5 + trigger + resume stage strings (from oneclick.js and
// trigger.js) to a single advancing percentage so the status bar updates
// in place with "Entering fast flasher: x%" instead of dumping a line for
// each step. Unmatched strings (future additions, variants like "try 2")
// do not move the bar, which is safe: only forward motion is shown.
const FB_ENTRY_STAGE_PCT = [
  [/^Answering the selector-5 login \(seed (\d+)\)/, (m) => 4 + +m[1] * 5], // 9, 14, 19, 24
  [/^Opening the programming session/, 28],
  [/^Erasing one calibration block/, 32],
  [/^Staging the fast flasher/, 36], // bumps to 36 at start; progress callback carries 36..80
  [/^Arming the fast flasher/, 82],
  [/^Firing/, 88],
  [/^Asking the flasher for its HELLO/, 92],
  [/^The flasher answered at/, 98],
];

/** The in-place progress status: no per-stage log lines, just the bar. */
function fbOneClickStage(s) {
  for (const [re, pct] of FB_ENTRY_STAGE_PCT) {
    const m = re.exec(s);
    if (!m) continue;
    const p = typeof pct === 'function' ? pct(m) : pct;
    fbEntryProgressSet(p);
    return;
  }
  // unrecognised stage -- status bar unchanged, nothing written to the log
}

// The entry-phase progress bar. A single status line "Entering fast
// flasher: x%" that only moves forward; the first call writes a "Entering
// fast flasher…" note to the log, and the last call writes an
// "Entered" note. Shared across the whole fbDmeOneClickTrigger chain.
let fbEntryPct = 0;
let fbEntryNoted = false;
function fbEntryProgressReset() {
  fbEntryPct = 0;
  fbEntryNoted = false;
}
function fbEntryProgressSet(p) {
  const was = fbEntryPct;
  fbEntryPct = Math.max(fbEntryPct, Math.min(100, Math.round(p)));
  if (!fbEntryNoted) {
    flashLog.note('Entering the fast flasher…');
    fbEntryNoted = true;
  }
  if (fbEntryPct !== was) {
    fbSetStatusInPlace(`Entering fast flasher: ${fbEntryPct}%`);
    if (typeof fbProgress === 'function') fbProgress(fbEntryPct);
  }
}
function fbEntryProgressDone() {
  fbEntryPct = 100;
  fbSetStatusInPlace('Entering fast flasher: 100%');
  if (typeof fbProgress === 'function') fbProgress(100);
  flashLog.note('Entered the fast flasher');
}

/**
 * Grant, fire, and pick the body up: the selector-5 login and the trigger
 * over the stock KWP session (the plain ms45LiveTuneSender -- its session
 * switch is a no-op once the MS45 SGBD is loaded, so it carries the chain
 * across the 10 86), then the body's HELLO at 115200 exactly like a flash
 * left running by a cut-short session. On return the DME's fastFlasher
 * detection is a SYNTHETIC one built from the body's own stamp (the body
 * demonstrably owns the line, which is a stronger `ready` than any hook
 * read), the live-flash flag is set so the shared session machinery RESUMES
 * instead of resetting the DME, and the bus is free. The caller runs the
 * operation next; its entry answers the body's HELLO a second time, which
 * is one harmless exchange.
 *
 * On a failure BEFORE the trigger's erase the DME is untouched (the grant
 * is RAM-only). After it, the error carries FB_OC_RECOVERY.
 * @param {string} title - For the bus claim.
 * @param {{stage?: (s: string) => void, entry?: (pct: number) => void}} [ui]
 *   A progress sink; stage is used for every step.
 * @returns {Promise<object>} The synthetic detection (with `triggered`).
 * @throws {Error} With the recovery words when the pickup misses.
 */
// Named fbDmeOneClickTrigger (not fbDmeEnterFastFlasher) because that
// name already belongs to dme-fast.js's installed-flasher entry (reset +
// break + HELLO) -- a different function with a different return shape.
async function fbDmeOneClickTrigger(title, ui = {}) {
  fbEntryProgressReset();
  const stage = ui.stage || fbOneClickStage;
  const sender = ms45LiveTuneSender({});
  const body = fbDmeOneClickBody();
  try {
    await oneClick.grantAndFire(sender, body, {
      stage,
      // flashLog note: drop these -- fbOneClickStage already drives the
      // single-line progress; per-stage notes (seed fields, slot values,
      // "granted") would re-introduce the old spammy log
      note: () => {},
      // 28 chunks of 3D staging happen in a tight loop, each triggering
      // this callback. Map 0..total onto the 36..80 slice of the entry
      // bar so the UI visibly advances through the one slow step.
      progress: (n, total) => {
        const pct = 36 + Math.floor(((80 - 36) * n) / Math.max(1, total));
        fbEntryProgressSet(pct);
        if (ui.entry) ui.entry(Math.max(1, Math.floor((n * 4) / total)));
      },
    });
  } catch (e) {
    // triggerFire's own words name the step: a staging or fire refusal is
    // PAST the write-enable erase (the calibration is blank); everything
    // earlier -- the login, the 10 86, a refused erase -- wrote nothing
    const pastErase = /staging|fire/.test(e.message);
    throw new Error(
      `${e.message}.${pastErase ? ' ' + FB_OC_RECOVERY : ' Nothing was written.'}`,
      pastErase ? { cause: e } : undefined
    );
  }
  // the body owns the line; nothing KWP can be sent again. Pick it up like
  // a cut-short session: claim, resume at the body's rates, read the stamp
  webDropSession(MS45_SGBD);
  let det;
  const claim = await webClaimBus(title);
  try {
    const link = fastFlashWire.webLink(webBus, {
      onStep: (s) => stage(s),
    });
    try {
      const stamp = await link.resume();
      // A body that answered HELLO at this 115200 rate IS the body we
      // just triggered: we staged it ourselves one function call ago,
      // the staging chunks landed byte-identical, and the KWP line
      // belongs to no one else now. Its stamp -- read from ext flash
      // 0xFD26C by _hello_payload (tools/build/flasher_body.py:1309) --
      // is blank on a triggered body because ext flash was never
      // written, so the stamp-magic and parseDetection checks that
      // apply to a FLASHED body do not apply here. Build the detection
      // from what we know (the version we just triggered) instead.
      let magic = '';
      if (stamp && stamp.length >= 6)
        magic = String.fromCharCode(...stamp.subarray(0, 6));
      det = fastFlasher.parseDetection(null, stamp);
      if (!det || !det.supported) {
        // blank/garbage stamp: synthesise from the known triggered body.
        // No log line -- fbEntryProgressDone() writes the single
        // "Entered the fast flasher" note that stands for the whole chain.
        //
        // Flags advertised here MATCH what the shipped v21 body actually
        // implements, so the AIF editor and ISN tools (which gate on
        // stamp flags) treat the triggered body as capable:
        //   0x02  boot-sector window (PERM_LOW=0x8000, with AIF marker)
        //   0x10  EEPROM read window (aif.js uses this for ISN read too)
        //         -- see tools/build/flasher_body.py:PERM_LOW / ALLOW_BOOT_SECTOR
        // The body is architecturally capable of boot-sector writes to
        // 0x8000..0x20000 under an armed AIF marker; option-3 treats
        // every such write as a one-shot brick risk (no ring, no
        // resume-from-marker safety net), warned on the action side.
        det = {
          version: fastFlasher.VERSION,
          flags: 0x12,
          gateCpu: 0,
          entryCpu: 0,
          hooked: false,
          ours: true,
          supported: true,
          mpc: true,
          reads: true,
          aifWipe: true,
          ready: true,
        };
      }
    } finally {
      try {
        await link.leave();
      } catch (e) {
        /* the port is reset below anyway */
      }
    }
  } catch (e) {
    throw new Error(
      `The one-click fired, but the flasher did not answer its HELLO (${e.message}). ${FB_OC_RECOVERY}`,
      { cause: e }
    );
  } finally {
    claim.release();
  }
  // a body that answered HELLO needs no hook read: it IS running. Mark it
  // so the shared session enters through the resume branch, and so the
  // tools can say which kind of flasher they are talking to.
  det = {
    ...det,
    hooked: true,
    ready: true,
    triggered: true,
    bootLoader: false,
  };
  fbState.dme.fastFlasher = det;
  // Also present the triggered body AS a bootloader to the gates in
  // aif-editor.js and isn-ews.js, which key off d.bootLoader.version /
  // d.bootLoader.flags. The triggered body implements the same services
  // the installed FFBL ring does (boot-sector window, AIF marker ladder,
  // EEPROM read) -- see tools/build/flasher_body.py -- so the gates
  // asking "is a ring on the DME?" get a true answer for everything
  // except the brick-safety the ring would provide via resume-from-
  // marker. The `triggered: true` tag lets any gate that wants to
  // distinguish (e.g. for a "risky write" warning) tell the two apart.
  fbState.dme.bootLoader = {
    version: fastFlasher.VERSION,
    flags: det.flags,
    stampAt: 0, // no installed stamp -- the body is in SRAM
    triggered: true,
  };
  fbDmeSetFastLive(true);
  fbEntryProgressDone();
  return det;
}

// Back-compat alias: fbDmeOneClickInto was the previous name for this
// chain back when the only caller was the "one-click Flash Program" path.
// AIF, ISN/EWS and the no-op callers all import by the new name; this
// alias keeps anything older working without a cross-file rename.
const fbDmeOneClickInto = fbDmeOneClickTrigger;

/**
 * Read the calibration off the stock DME and sign it for the restore push.
 * Every one-click operation that is not itself a cal flash calls this in
 * its prepare, BEFORE any exploit traffic: after the fire the sector is
 * blank, so this read is the only copy. A healthy calibration re-signs to
 * itself -- what goes back is what came off.
 * @returns {Promise<Uint8Array>} The signed calibration.
 * @throws {Error} When the stock read comes back short (nothing was sent).
 */
async function fbOneClickReadCal() {
  fbOneClickStage('Reading the calibration at the stock rate');
  const cal = await ms45ReadMemory(
    MS45_CAL_START,
    MS45_CAL_START + MS45_CAL_LENGTH - 1,
    'ROMX',
    {
      onProgress: (p) => {
        fbProgress(p);
        fbSetStatusInPlace(`calibration ${p}%`);
      },
    }
  );
  if (cal.length !== MS45_CAL_LENGTH)
    throw new Error(
      `the stock read returned ${cal.length} B of the calibration, not ${MS45_CAL_LENGTH}: nothing was sent`
    );
  const signed = ms45Checksums.signParameters(
    ms45Checksums.correctParameterChecksums(cal)
  );
  return { cal, signedCal: signed };
}

/** The calibration back through the body's own push, marks included. */
async function fbOneClickRestoreCal(client, signedCal, cb, share) {
  cb.stage('Rewriting the calibration unchanged');
  await fastFlashWire.pushCal(client, signedCal, {
    ...cb,
    progress: (pct) =>
      cb.progress(share + Math.floor((pct * (100 - share)) / 100)),
  });
}

/** One confirm that covers BOTH halves (the exploit's erase and the flash). */
function fbDmeOneClickConfirm(tune) {
  return fbConfirm(
    'The moment the flasher starts, the old calibration is erased (the write enable); from there the flash must complete. An interrupted write is resumed by running the same operation again.\n\n' +
      'Keep the ignition on, a charger on the battery and the cable plugged in until it has finished.\n\n' +
      `Write the ${tune ? 'tune' : 'program'}?`,
    tune ? 'Flash Tune (one-click)' : 'Flash Program (one-click)'
  );
}

/**
 * Flash Tune through the one-click: the shared fast-flash session with the
 * one-click entry in place of the reset, and a confirm that discloses the
 * trigger's erase up front (the stock Fast Flash Tune confirm cannot -- it
 * does not know this entry exists). The push itself is byte-for-byte
 * fbDmeFastFlashTune's: the calibration signed as Flash Tune signs it,
 * pushed through the body the grant started.
 */
async function fbDmeOneClickFlashTune() {
  const d = fbState.dme;
  if (!d.identified || !d.flash) return;
  if (!(await fbDmeOneClickGate('Flash Tune'))) return;
  if (!(await fbDmeOneClickConfirm(true))) {
    flashLog.note('Flash Tune (one-click) not confirmed: nothing was sent');
    return;
  }
  await fbDmeFastFlash({
    title: 'Flash Tune (one-click)',
    operation: 'oneclick-flash-tune',
    what: 'calibration',
    confirmed: true,
    note: `DME ${d.ident.hwRef} / prog ${d.ident.progRef} / one-click (selector-5 grant)${d.flashName ? ` / file ${d.flashName}` : ''}`,
    async prepare() {
      await fbDmeOneClickInto('Flash Tune (one-click)');
      // the same bytes Flash Tune would write, signed the same way
      const cal = await fbDmePrepareTuneCal();
      const signedCal = ms45Checksums.signParameters(
        ms45Checksums.correctParameterChecksums(cal)
      );
      return { attach: ['fast_tune_cal_0x40000.bin', signedCal], signedCal };
    },
    push: (client, cb, p) => fastFlashWire.pushCal(client, p.signedCal, cb),
  });
}

/**
 * Flash Program through the one-click: the entry first, then the stock
 * Fast Flash Program unchanged (it re-asks its own confirm -- the push it
 * describes is exactly what runs; the one-click half was already confirmed
 * here). Note the stock program flow needs a break-capable cable for its
 * availability check even though this entry does not.
 */
async function fbDmeOneClickFlashProgram() {
  const d = fbState.dme;
  if (!d.identified || !d.flash || !d.mpc) return;
  if (!(await fbDmeOneClickGate('Flash Program'))) return;
  if (!(await fbDmeOneClickConfirm(false))) {
    flashLog.note('Flash Program (one-click) not confirmed: nothing was sent');
    return;
  }
  try {
    await fbDmeOneClickInto('Flash Program (one-click)');
  } catch (e) {
    fbSetStatus(`Flash Program (one-click) failed: ${fbDescribeError(e)}`);
    flashLog.note(`Flash Program (one-click) failed: ${e.message}`);
    return;
  }
  // confirmed:true skips the Fast Flash Program dialog: the one-click
  // already asked ("Flash Program" above via fbDmeOneClickConfirm), and
  // the DME has by now been fired into the resident body -- there is no
  // choice to make here, only the push to run. The Flash Tune (one-click)
  // path has always used the same opt-in; this match drops a redundant
  // "Write the program?" prompt after the one-click has already started.
  await fbDmeFastFlashProgram({ confirmed: true });
}

/**
 * Read DME through the one-click. Reads change nothing -- so the
 * calibration the trigger must erase is read FIRST, at the stock rate
 * (nothing faster can have it: after the fire it is blank), everything
 * else comes off the fast line, and the calibration is pushed back
 * byte-identical through the body's own cal push (checksums, signature and
 * valid marks with it) before the DME restarts on its program. A tune read
 * is the calibration alone and never touches the fast line -- it is the
 * stock read plus the rewrite; a full read rides the fast line for the
 * other 1.3 MB.
 */
async function fbDmeOneClickRead() {
  const d = fbState.dme;
  if (!d.identified) return;
  if (!(await fbDmeOneClickGate('Read DME'))) return;
  const full = !!d.fullBin;
  if (
    !(await fbConfirm(
      `Read DME (one-click) starts the flasher on this STOCK DME with the selector-5 login -- nothing is installed -- reads ${full ? 'the full flash and the MPC' : 'the tune'}, and writes the calibration back unchanged before the DME restarts.\n\n` +
        "The old calibration is read at the stock rate first (that is the slow part), erased as the flasher's write enable, then rewritten byte-identical through the flasher. Nothing else is written.\n\n" +
        'Read the DME?',
      'Read DME (one-click)'
    ))
  ) {
    flashLog.note('Read DME (one-click) not confirmed: nothing was sent');
    return;
  }
  let cal = null; // the bytes as read, for the saved file
  await fbDmeFastFlash({
    title: 'Read DME (one-click)',
    operation: 'oneclick-read',
    what: 'read',
    noFasterLine: !full,
    confirmed: true,
    note: `DME ${d.ident.hwRef} / prog ${d.ident.progRef} / one-click read, ${full ? 'full' : 'tune'}`,
    async prepare() {
      const r = await fbOneClickReadCal();
      cal = r.cal; // what the saved file holds: the calibration as it was
      flashLog.attach('oneclick_read_cal_0x40000.bin', r.signedCal);
      await fbDmeOneClickInto('Read DME (one-click)');
      return { signedCal: r.signedCal };
    },
    push: async (client, cb, p) => {
      const t0 = Date.now();
      let flash = cal;
      let mpc = null;
      if (full) {
        // the external chip around the (erased) calibration + the MPC
        const ext = new Uint8Array(0x100000);
        const readInto = async (at, len, off) => {
          const b = await fastFlashWire.readArea(client, at, len, (n) =>
            cb.progress(Math.floor((n * 70) / 0x100000))
          );
          ext.set(b, off);
        };
        cb.stage('Reading the external flash');
        await readInto(0, MS45_CAL_START, 0);
        ext.set(cal, MS45_CAL_START);
        await readInto(
          MS45_CAL_START + MS45_CAL_LENGTH,
          0x100000 - MS45_CAL_START - MS45_CAL_LENGTH,
          MS45_CAL_START + MS45_CAL_LENGTH
        );
        cb.stage('Reading the MPC');
        mpc = await fastFlashWire.readArea(
          client,
          fastFlashWire.MPC_WINDOW,
          MS45_MPC_LENGTH,
          (n) => cb.progress(70 + Math.floor((n * 10) / MS45_MPC_LENGTH))
        );
        flash = ext;
      }
      await fbOneClickRestoreCal(client, p.signedCal, cb, 80);
      cb.stage('Restarting the DME');
      await client.reset();
      fbDmeSaveRead(flash, mpc);
      const s = Math.round((Date.now() - t0) / 1000);
      flashLog.note(
        `One-click read: ${flash.length + (mpc ? mpc.length : 0)} bytes, calibration restored, in ${s} s`
      );
      return {
        ok: true,
        skipped: false,
        summary: `${full ? 'saved the full flash and MPC' : 'saved the tune'}, calibration rewritten unchanged`,
      };
    },
    after: async () => {},
  });
}

/**
 * Read ISN through the one-click: the six bytes at ext 0x1FB00 voted the
 * DME's own way, through the triggered body -- the same read the rail page
 * makes through an installed flasher, with the calibration put back after.
 */
async function fbDmeOneClickIsnRead() {
  if (!(await fbDmeOneClickGate('Read ISN', { ms451: true }))) return;
  await fbDmeFastFlash({
    title: 'Read ISN (one-click)',
    operation: 'oneclick-isn-read',
    what: 'read',
    noFasterLine: true,
    confirmed: true,
    confirm: '',
    note: `DME ${fbState.dme.ident.hwRef} / one-click flash ISN read`,
    async prepare() {
      const { signedCal } = await fbOneClickReadCal();
      await fbDmeOneClickInto('Read ISN (one-click)');
      return { signedCal };
    },
    push: async (client, cb, p) => {
      cb.stage('Reading the ISN');
      const six = await client.read(isnFlash.AT, isnFlash.LEN);
      const isn = isnFlash.fromTriple(six);
      const hex = Array.from(six)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ');
      fbSetStatus(
        isn === null
          ? `Read ISN: the triple did not vote (0x1FB00 = ${hex})`
          : `Read ISN: ${isnFlash.text(isn)} (0x1FB00 = ${hex})`
      );
      await fbOneClickRestoreCal(client, p.signedCal, cb, 90);
      cb.stage('Restarting the DME');
      await client.reset();
      return {
        skipped: false,
        summary: isn === null ? 'no vote' : isnFlash.text(isn),
      };
    },
    after: async () => {},
  });
}

/**
 * Write ISN through the one-click: the same boot-sector ladder the rail
 * page's Write ISN drives (bl.burnIsn), served by the triggered body. The
 * burn rewrites the BOOT sector only, so the calibration the trigger
 * erased is put back after it, exactly as the read does.
 */
async function fbDmeOneClickIsnWrite() {
  if (!(await fbDmeOneClickGate('Write ISN', { ms451: true }))) return;
  const isn = await fbIsnPrompt({
    title: 'Write ISN (one-click)',
    action: 'Write',
    body: `<p>Burns a new ISN into the DME's flash boot sector through the one-click-started flasher -- no bootloader needed on the DME.</p>
          <p>The calibration is erased as the flasher's write enable and rewritten unchanged after the burn. The program, EEPROM and log are kept.</p>
          <p>Keep the ignition on, a charger on the battery and the cable plugged in until it has finished. The car starts only when this matches the EWS's ISN and the rolling code has been synced.</p>`,
  });
  if (isn === null) {
    flashLog.note('Write ISN (one-click) not confirmed: nothing was sent');
    return;
  }
  await fbDmeFastFlash({
    title: 'Write ISN (one-click)',
    operation: 'oneclick-isn-write',
    what: 'boot loader',
    noFasterLine: true,
    confirmed: true,
    confirm: '',
    note: `DME ${fbState.dme.ident.hwRef} / one-click burn ISN ${isnFlash.text(isn)} at flash 0x1FB00`,
    async prepare() {
      const { signedCal } = await fbOneClickReadCal();
      await fbDmeOneClickInto('Write ISN (one-click)');
      return { signedCal };
    },
    push: async (client, cb, p) => {
      const r = await bl.burnIsn(client, isn, {
        ...cb,
        progress: (pct) => cb.progress(Math.floor((pct * 80) / 100)),
      });
      await fbOneClickRestoreCal(client, p.signedCal, cb, 80);
      cb.stage('Restarting the DME');
      await client.reset();
      fbSetStatus(`Write ISN: done, ${isnFlash.text(isn)} is on the DME`);
      return r;
    },
    after: async () => {},
  });
}

/**
 * Read EEPROM through the one-click: the 4 KB serial EEPROM off the
 * triggered body's own read window (a body feature, no ee_write module
 * needed), with the calibration put back after. EEPROM WRITES stay on the
 * installed-flasher lane: the write service is served by a module the
 * bootstrap parks in ext flash at 0xFF000, which a stock DME does not
 * carry.
 */
async function fbDmeOneClickEepromDump() {
  if (!(await fbDmeOneClickGate('Read EEPROM', { ms451: true }))) return;
  const d = fbState.dme;
  let img = null;
  await fbDmeFastFlash({
    title: 'Read EEPROM (one-click)',
    operation: 'oneclick-eeprom-read',
    what: 'read',
    noFasterLine: true,
    confirmed: true,
    confirm: '',
    note: `DME ${d.ident.hwRef} / one-click EEPROM read`,
    async prepare() {
      const { signedCal } = await fbOneClickReadCal();
      const det = await fbDmeOneClickInto('Read EEPROM (one-click)');
      if (!(det.flags & 0x10))
        throw new Error(
          `this body has no EEPROM read window (stamp flags ${det.flags.toString(16)}); ${FB_OC_RECOVERY}`
        );
      return { signedCal };
    },
    push: async (client, cb, p) => {
      cb.stage('Reading the EEPROM');
      img = await eepromDump.dump(client, {
        progress: (n) => cb.progress(Math.floor((n * 80) / eepromDump.SIZE)),
      });
      await fbOneClickRestoreCal(client, p.signedCal, cb, 80);
      cb.stage('Restarting the DME');
      await client.reset();
      return {
        skipped: false,
        summary: `the EEPROM read, ${img.length >> 10} KB`,
      };
    },
    after: async () => {},
  });
  if (!img) return;
  const who = [d.ident.vin, d.ident.hwRef].filter(Boolean).join('_') || 'dme';
  fbSaveBytes(`${who}_EEPROM_${img.length >> 10}K.bin`, img);
}

// ---- the Fast flasher page's one-click tools row --------------------------------
/**
 * The tools the one-click adds to the Fast flasher page on a stock DME:
 * the ISN and EEPROM reads (and the ISN write) that otherwise need the
 * installed flasher. Hidden whenever the normal lanes cover them.
 */
function fbOneClickToolsHtml() {
  return `
      <div class="fb-section" id="fb-oneclick-section" hidden>
        <div class="fb-code">ONE-CLICK TOOLS</div>
        <div class="fb-dim">Through the selector-5 grant, on this stock DME directly -- nothing installed, the calibration rewritten unchanged.</div>
        <div class="fb-row">
          <button class="btn" id="fb-oc-isn-read" disabled title="Reads the ISN off the DME's flash through the one-click-started flasher. Nothing but the unchanged calibration is written.">Read ISN</button>
          <button class="btn danger" id="fb-oc-isn-write" disabled title="Burns an ISN into the DME's flash boot sector through the one-click-started flasher.">Write ISN</button>
          <button class="btn" id="fb-oc-eeprom" disabled title="Reads the whole 4 KB EEPROM through the one-click-started flasher and saves it as a file.">Read EEPROM to file</button>
        </div>
        <div class="fb-faint" id="fb-oc-reason"></div>
      </div>`;
}

/** Wire the row once, then gate it from the state (called by fbFastPaint). */
function fbOneClickToolsRefresh() {
  const sec = fbEls['oneclick-section'];
  if (!sec) return;
  const due = fbDmeOneClickDue();
  sec.hidden = !due;
  if (!due) return;
  if (!fbEls['oc-isn-read'].dataset.wired) {
    fbEls['oc-isn-read'].dataset.wired = '1';
    fbEls['oc-isn-read'].onclick = () =>
      fbDmeGuard('Read ISN', fbDmeOneClickIsnRead);
    fbEls['oc-isn-write'].dataset.wired = '1';
    fbEls['oc-isn-write'].onclick = () =>
      fbDmeGuard('Write ISN', fbDmeOneClickIsnWrite);
    fbEls['oc-eeprom'].dataset.wired = '1';
    fbEls['oc-eeprom'].onclick = () =>
      fbDmeGuard('Read EEPROM', fbDmeOneClickEepromDump);
  }
  const why = fbDmeOneClickGateWhy({ ms451: true });
  for (const id of ['oc-isn-read', 'oc-isn-write', 'oc-eeprom'])
    fbEls[id].disabled = !!why || !!fbState.running;
  fbEls['oc-reason'].textContent =
    why || 'Ready: the calibration is read first and rewritten unchanged.';
}
