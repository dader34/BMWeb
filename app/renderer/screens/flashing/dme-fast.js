// Flashing/Tuning, the resident fast flasher's screen side: Fast Flash Tune
// and Fast Flash Program, one shared session (the DME reset into the flasher
// with the K-line held low, the push, the resume if it stops, the identify
// after), the live progress line, and the v1 flasher's MPC check. The wire
// protocol is core/flash/fast-flasher-wire.js, detection and the bootstrap
// splice core/flash/fast-flasher.js. Part of the DME screen with dme.js;
// one scope.
/* exported fbDmeFastFlashTune, fbDmeFastFlashProgram, fbDmeFastFlasherAvailable */

// ---- Fast Flash ------------------------------------------------------------------------------------------
/**
 * Fast Flash Tune: the loaded calibration, checksummed and signed as Flash
 * Tune signs it, pushed through the resident fast flasher. Only the
 * calibration sector moves. Testing-only, like the rest of the flasher work.
 */
async function fbDmeFastFlashTune() {
  const d = fbState.dme;
  if (!fbProtectTesting()) return;
  if (!d.identified || !d.flash) return;
  if (!(await fbDmeFastFlasherAvailable('Fast Flash Tune'))) return;
  await fbDmeFastFlash({
    title: 'Fast Flash Tune',
    operation: 'fast-flash-tune',
    what: 'calibration',
    confirm:
      'Fast Flash Tune resets the DME into its fast flasher and rewrites the calibration sector (compressed).\n\n' +
      'Keep the ignition on, a charger on the battery and the cable plugged in until it has finished. ' +
      'An interrupted write leaves the calibration without its valid marks, and the DME stays in the flasher until a flash completes.\n\n' +
      'Write the tune?',
    note: `DME ${d.ident.hwRef} / prog ${d.ident.progRef} / fast flasher v${d.fastFlasher.version}${d.flashName ? ` / file ${d.flashName}` : ''}`,
    async prepare() {
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
 * Baud Test: into the fast flasher, then each faster line speed in turn
 * (fast-flasher-wire.js FF_LINE_TEST_RATES) with HELLOs, 4 KB frames and a
 * 64 KB CRC at each, back to 115200 between them, and the DME restarted on
 * its program. Nothing is written. The verdict per rate goes to the status
 * line and the session log. Testing-only.
 */
async function fbDmeFastBaudTest() {
  const d = fbState.dme;
  if (!fbProtectTesting()) return;
  if (!d.identified) return;
  if (!(await fbDmeFastFlasherAvailable('Baud Test', { upgrade: true })))
    return;
  if (!d.fastFlasher.fastLine) {
    await fbMessage(
      `The fast flasher on the DME is v${d.fastFlasher.version}; a line-speed change that cannot strand the DME came with v${fastFlasher.LINE_FROM}. Run Fast Flash Program once to upgrade it, then test.`,
      'Baud Test'
    );
    return;
  }
  const rates = fastFlashWire.LINE_TEST_RATES.map(([r]) => r).join(', ');
  await fbDmeFastFlash({
    title: 'Baud Test',
    operation: 'fast-baud-test',
    what: 'line',
    noFasterLine: true,
    confirm:
      `Baud Test resets the DME into its fast flasher and tries faster line speeds one by one (${rates} baud): at each, five HELLOs, three 4 KB frames and a 64 KB CRC. Nothing is written, and the DME is restarted on its program afterwards. A speed the line cannot carry costs a few seconds.\n\n` +
      'Run the test?',
    note: `DME ${d.ident.hwRef} / prog ${d.ident.progRef} / fast flasher v${d.fastFlasher.version} / baud test`,
    push: async (client, cb, p) => {
      const r = await fastFlashWire.lineTest(client, p.link, (s) =>
        cb.stage(s)
      );
      if (r.lost) {
        fbDmeSetFastLive(false);
        return {
          ok: true,
          skipped: false,
          summary: `${r.summary} -- the DME stayed on a rate the line does not carry: switch the ignition off for ten seconds and back on, then Identify`,
          best: r.best,
        };
      }
      cb.stage('Restarting the DME');
      await client.reset();
      // the fastest rate that passed is what the next fast flash asks for first
      Settings.set('fastLineBest', r.best);
      flashLog.note(`Fast flashes will ask for ${r.best} baud first`);
      return { ok: true, skipped: false, summary: r.summary, best: r.best };
    },
  });
}

/**
 * One fast-flasher session, shared by Fast Flash Tune and Fast Flash Program:
 * the confirmation, the session log, `prepare` (what to send, built before
 * the car is touched -- its own prompts and reads happen here), the cable
 * claimed and the DME reset into the flasher, `push` run and resumed once if
 * it stops, the outcome on the status line, and the DME identified again.
 * Everything the flasher is told goes to the session log, command by
 * command (the client's trace), for a diagnosis from the downloaded file.
 * @param {{title: string, operation: string, what: string, confirm: string,
 *   note: string, counter?: boolean,
 *   prepare?: () => Promise<{attach?: [string, Uint8Array]}>,
 *   push: (client: object, cb: object, prepared: object) => Promise<{skipped: boolean}>}} spec
 */
async function fbDmeFastFlash(spec) {
  const d = fbState.dme;
  if (!(await fbConfirm(spec.confirm, spec.title))) {
    flashLog.note(`${spec.title} not confirmed: nothing was sent to the car`);
    return;
  }
  let ok = false;
  fbFlashingBar(true);
  await fbSessionStart(spec.operation, {
    vin: d.ident.vin,
    module: d.ident.hwRef,
  });
  let claim = null;
  let link = null;
  const ui = fbDmeFastUi(spec.title);
  try {
    flashLog.note(spec.note);
    const prepared = spec.prepare ? await spec.prepare() : {};
    if (spec.counter && !(await fbProgrammingCounter(false))) return;
    if (prepared.attach) flashLog.attach(...prepared.attach);
    ({ claim, link } = await fbDmeEnterFastFlasher(spec.title, ui));
    ui.entry(FB_FAST_ENTRY_PCT);
    const client = new fastFlashWire.Client(link, {
      trace: (t) => flashLog.trace(t),
    });
    await fbDmeFastProbe(client, ui);
    prepared.link = link;
    // v8: the fastest line the cable and the K-line carry (the body falls
    // back to 115200 by itself when a rate carries nothing)
    if (d.fastFlasher && d.fastFlasher.fastLine && !spec.noFasterLine) {
      ui.stage('Trying a faster line');
      const rate = await fastFlashWire.fasterLine(
        client,
        link,
        (s) => flashLog.note(s),
        Number(Settings.get('fastLineBest', 0)) || 0
      );
      ui.stage(`Line at ${rate} baud`);
    }
    const cb = {
      stage: (s) => ui.stage(s),
      progress: (pct) => ui.push(pct),
      note: (s) => flashLog.note(s),
    };
    const r = await fbDmeFastPushWithResume(client, ui, () =>
      spec.push(client, cb, prepared)
    );
    ok = true;
    ui.stop();
    fbSetStatus(
      r.summary
        ? `${spec.title}: ${r.summary} (${ui.elapsed()}s)`
        : r.skipped
          ? `${spec.title}: the DME already held this ${spec.what}; nothing written (${ui.elapsed()}s)`
          : `${spec.title} successful in ${ui.elapsed()}s`
    );
  } catch (e) {
    ui.stop();
    fbSetStatus(
      `${spec.title} failed after ${ui.elapsed()}s: ${fbDescribeError(e)}`
    );
    flashLog.note(`${spec.title} failed: ${e.message}`);
  } finally {
    if (link) {
      try {
        await link.leave();
      } catch (e) {
        /* the port is reset below anyway */
      }
    }
    if (claim) claim.release();
    ui.stop();
    fbFlashingBar(false);
    fbProgress(0);
    if (ok) await fbDmeIdentify(true);
    await fbSessionStop();
  }
}

/**
 * Read-only probes before anything else: SECTOR_QUERY over growing ranges of
 * the cal sector, each timed into the session log. On the car HELLO was
 * answered but a whole-sector QUERY never was; a small range that also goes
 * unanswered means the QUERY frame itself does not get through, while small
 * ones answered and big ones not means the CRC is slower than its budget --
 * and the timings give the real chip's speed.
 * @param {object} client - fastFlashWire.Client.
 * @param {object} ui
 * @returns {Promise<void>}
 * @throws {Error} Naming the first range that went unanswered.
 */
async function fbDmeFastProbe(client, ui) {
  // a HELLO padded to a QUERY's 13 bytes: the body ignores HELLO's payload,
  // so an answer means long frames get through and the fault is in QUERY's
  // handling; silence means the body loses longer frames
  ui.stage('Checking the flasher: a 13-byte HELLO');
  const h0 = Date.now();
  try {
    await client.call(fastFlashWire.SVC.HELLO, [0, 0, 0, 0, 0, 0, 0, 0], 2000);
    flashLog.note(`Probe: 13-byte HELLO answered in ${Date.now() - h0} ms`);
  } catch (e) {
    flashLog.note(`Probe: 13-byte HELLO failed: ${e.message}`);
    throw new Error(
      `The flasher answered a short HELLO but not one padded to 13 bytes (${e.message}): it loses longer frames. Nothing was written.`,
      { cause: e }
    );
  }
  for (const len of [0x10, 0x1000, 0x10000]) {
    ui.stage(`Checking the flasher: CRC over ${len} bytes`);
    const t0 = Date.now();
    try {
      const crc = await client.sectorQuery(fastFlashWire.CAL_SECTOR, len);
      flashLog.note(
        `Probe: QUERY over ${len} bytes answered in ${Date.now() - t0} ms (crc ${(crc >>> 0).toString(16)})`
      );
    } catch (e) {
      flashLog.note(
        `Probe: QUERY over ${len} bytes failed after ${Date.now() - t0} ms: ${e.message}`
      );
      throw new Error(
        `The flasher answered a 13-byte HELLO but not a CRC over ${len} bytes (${e.message}): long frames get through, the QUERY handling is the fault. Nothing was written.`,
        { cause: e }
      );
    }
  }
}

/** The share of the progress bar that getting into the flasher takes. */
const FB_FAST_ENTRY_PCT = 5;

/**
 * What a fast-flasher session shows: ONE live line in the log, updated in
 * place -- "Fast Flash Tune: writing… 45% · 12s", the phase, the whole job's
 * percent -- like a normal flash's "Flashing calibration 45%". The individual steps (the break, the speed change, each
 * compare and erase) go to the session log only, where they are timestamped
 * for a diagnosis; `notice` is for what the user must see (a reconnect).
 * A one-second tick keeps the time moving through a long erase.
 * @param {string} title - "Fast Flash Tune" / "Fast Flash Program".
 * @returns {{stage: (s: string) => void, notice: (s: string) => void,
 *   entry: (pct: number) => void, push: (pct: number) => void,
 *   elapsed: () => number, stop: () => void}}
 */
function fbDmeFastUi(title) {
  const started = Date.now();
  let phase = 'entering the fast flasher';
  let pct = 0;
  const elapsed = () => Math.round((Date.now() - started) / 1000);
  const paint = () => fbSetStatusInPlace(`${title}: ${phase}… ${pct}%`);
  const phaseOf = (s) =>
    /^Compar/.test(s)
      ? 'comparing'
      : /^Test/.test(s)
        ? 'testing the line'
        : /^(Eras|Writ)/.test(s)
          ? 'writing'
          : /^Verif/.test(s)
            ? 'verifying'
            : /^(Mark|Restart)/.test(s)
              ? 'finishing'
              : null;
  const timer = setInterval(paint, 1000);
  return {
    stage(s) {
      flashLog.note(s);
      phase = phaseOf(s) || phase;
      paint();
    },
    notice(s) {
      fbSetStatus(s);
    },
    entry(p) {
      pct = Math.round(Math.min(FB_FAST_ENTRY_PCT, p));
      fbProgress(pct);
      paint();
    },
    push(p) {
      pct = Math.round(
        FB_FAST_ENTRY_PCT + (p * (100 - FB_FAST_ENTRY_PCT)) / 100
      );
      fbProgress(pct);
      paint();
    },
    elapsed,
    stop() {
      clearInterval(timer);
    },
  };
}

/**
 * Whether a fast-flasher session may still be running on the DME: set once
 * the DME has entered the flasher, cleared when a push ends with its RESET
 * or when the DME answers ordinary diagnostics again. The flasher runs from
 * RAM and waits for its host indefinitely, so a session cut short (a cable
 * pulled, a tab closed) is picked up again with a HELLO -- no reset, so it
 * finishes in seconds instead of falling back to the loader and a full flash.
 */
const FB_FAST_LIVE_KEY = 'bmweb-fast-flasher-live';

/** @param {boolean} live */
function fbDmeSetFastLive(live) {
  try {
    if (live) localStorage.setItem(FB_FAST_LIVE_KEY, '1');
    else localStorage.removeItem(FB_FAST_LIVE_KEY);
  } catch (e) {
    // storage blocked: the in-push resume still covers the common case
  }
}

/** @returns {boolean} */
function fbDmeFastLive() {
  try {
    return localStorage.getItem(FB_FAST_LIVE_KEY) === '1';
  } catch (e) {
    return false;
  }
}

/**
 * Run a push; if it fails part-way, the flasher is still running (it only
 * restarts the DME on RESET), so say HELLO to it and run the push once more
 * -- its compare picks up exactly what is still missing. The push's own
 * success clears the live mark.
 * @template T
 * @param {object} client - The fast-flasher client on the open link.
 * @param {ReturnType<typeof fbDmeFastUi>} ui
 * @param {() => Promise<T>} push
 * @returns {Promise<T>}
 */
async function fbDmeFastPushWithResume(client, ui, push) {
  try {
    const r = await push();
    fbDmeSetFastLive(false);
    return r;
  } catch (e) {
    flashLog.note(
      `The push stopped: ${e.message}; asking the flasher whether it is still running`
    );
    ui.notice(
      'The connection dropped: reconnecting to the flasher, which is still running…'
    );
    try {
      await client.hello();
    } catch (e2) {
      throw new Error(
        `${e.message}. The flasher did not answer a HELLO either (${e2.message}). If the ignition stayed on, run the same fast flash again: it reconnects to the flasher and finishes. If the power was lost, the DME is in its loader -- Identify shows "program missing" -- and a standard Flash Program restores it.`,
        { cause: e2 }
      );
    }
    flashLog.note('The flasher answered: resuming');
    let r;
    try {
      r = await push();
    } catch (e3) {
      // both failures, first one first: the screen used to show only the
      // second, and the first is the one that says what went wrong
      throw new Error(
        `${e3.message} (first attempt: ${e.message}; the flasher answered a HELLO in between)`,
        { cause: e3 }
      );
    }
    fbDmeSetFastLive(false);
    return r;
  }
}

/** How many times the reset trigger is tried: a late break is a safe miss. */
const FB_FAST_ENTRY_TRIES = 2;
/** After a missed trigger, how long the DME takes to come back up on its program, ms. */
const FB_FAST_REBOOT_MS = 2500;

/**
 * The wire parameters (rate, framing, timing) the raw reset request goes out
 * with. The session's own when it still has them; otherwise the ones identify
 * left behind (the session is dropped after every reset, and on a real cable
 * it was found empty again by the time the fast flash started); otherwise a
 * cheap job seeds a fresh session, asked the way identify asks it -- once
 * more after a pause when the first went unanswered, which the first job
 * after a session change does on a car.
 * @returns {Promise<object>}
 * @throws {Error} When no job answers either.
 */
async function fbDmeFastWireParams() {
  const live = sessionFor(MS45_SGBD).comm;
  if (live) return live;
  const kept = fbState.dme.wire;
  if (kept) {
    flashLog.note(
      'The DME session has been dropped since identify; the reset request uses the wire parameters identify ended on'
    );
    return kept;
  }
  let seed = await ms45Job('aif_lesen', '');
  if (!seed.ok) {
    flashLog.note(
      `The session seed went unanswered (${seed.error || seed.status || 'no answer'}); asking again`
    );
    await new Promise((r) => setTimeout(r, 1500));
    seed = await ms45Job('aif_lesen', '');
  }
  const comm = sessionFor(MS45_SGBD).comm;
  if (!comm)
    throw new Error(
      `The DME did not open a session for the reset request (${seed.error || seed.status || 'no answer'}). Run Identify and try again.`
    );
  return comm;
}

/**
 * Reset the DME into the resident fast flasher: STEUERGERAETE_RESET in the
 * normal session, then (as soon as its reply is read) the cable claimed and
 * the K-line held low across the reboot, released, the port reopened at
 * 115200 and the flasher's HELLO taken. The break can only follow the reset
 * request -- nothing transmits through a held line -- so if the DME reboots
 * before the break lands, the gate sees nothing and the DME simply boots its
 * program (proven harmless); that is retried once.
 * @param {string} owner - Named on the cable claim.
 * @returns {Promise<{claim: object, link: object}>} The held cable and a link
 *   whose HELLO has been answered with the MS45QF stamp. The caller releases
 *   both (link.leave, claim.release) in its finally.
 * @throws {Error} When no attempt reached the flasher.
 */
async function fbDmeEnterFastFlasher(owner, ui) {
  let lastError = null;
  // a session cut short earlier: the flasher may still be running -- picking
  // it up finishes the push; a reset would drop to the loader instead
  if (fbDmeFastLive()) {
    ui.notice(
      'A fast flash was interrupted earlier: reconnecting to the flasher…'
    );
    const claim = await webClaimBus(owner);
    const link = fastFlashWire.webLink(webBus);
    try {
      const stamp = await link.resume();
      if (String.fromCharCode(...stamp.subarray(0, 6)) === 'MS45QF') {
        flashLog.note(
          'Reconnected to the fast flasher left running by an interrupted session'
        );
        return { claim, link };
      }
    } catch (e) {
      flashLog.note(
        `No flasher left running (${e.message}); entering it normally`
      );
    }
    try {
      await link.leave();
    } catch (e) {
      /* the next job reopens the port anyway */
    }
    claim.release();
    fbDmeSetFastLive(false);
  }
  for (let attempt = 1; attempt <= FB_FAST_ENTRY_TRIES; attempt++) {
    ui.stage(
      `Resetting the DME into the fast flasher…${attempt > 1 ? ` (attempt ${attempt})` : ''}`
    );
    ui.entry(attempt > 1 ? 3 : 1);
    // the wire parameters the raw reset goes out with; jobs cannot run once
    // the cable is claimed, so they are settled first
    const comm = await fbDmeFastWireParams();
    // the reset goes out raw INSIDE the claim, so the break follows its reply
    // with nothing in between: the gate listens for well under a millisecond
    // after the reboot starts. Never retransmitted -- a second reset would
    // land on a DME that is already rebooting.
    const claim = await webClaimBus(owner);
    let reply;
    try {
      reply = await claim.exchange([0xb8, 0x12, 0xf1, 0x02, 0x11, 0x01], {
        ...comm,
        noRetransmit: true,
      });
    } catch (e) {
      claim.release();
      throw new Error(
        `The DME did not answer the reset request (${e.message}). If a fast flash was just tried, the DME may be waiting in the flasher: switch the ignition off for ten seconds and back on, then Identify. Nothing was written.`,
        {
          cause: e,
        }
      );
    }
    if (!reply || !Array.from(reply).includes(0x51)) {
      claim.release();
      throw new Error('The DME refused the reset request.');
    }
    // the line goes low NOW, before any bookkeeping or screen update: the
    // gate's window opens whenever the DME gets round to rebooting
    await webBus.port.setSignals({ break: true });
    // the DME is rebooting out of the diagnostic session it was in -- and
    // from here it may come up in the flasher, so the next press asks the
    // flasher first instead of sending a reset it cannot hear
    webDropSession(MS45_SGBD);
    fbDmeSetFastLive(true);
    const link = fastFlashWire.webLink(webBus, {
      onStep: (what) => {
        ui.stage(what);
        ui.entry(attempt > 1 ? 4 : 2);
      },
    });
    try {
      const stamp = await link.enter({ onLine: fbDmeNoteLine });
      const magic = String.fromCharCode(...stamp.subarray(0, 6));
      if (magic !== 'MS45QF')
        throw new Error(
          `The DME answered, but its HELLO stamp read "${magic}", not a fast flasher.`
        );
      fbDmeSetFastLive(true);
      return { claim, link };
    } catch (e) {
      lastError = e;
      try {
        await link.leave();
      } catch (e2) {
        /* the next job reopens the port anyway */
      }
      claim.release();
      flashLog.note(
        `Fast flasher entry attempt ${attempt} missed: ${e.message}`
      );
      // Which miss was it? Only a DME back on its program may be sent
      // another reset. One sitting in the flasher hears 9600 telegrams as
      // noise, so it is asked once, in the program's own terms, and left
      // alone if it does not answer.
      await new Promise((r) => setTimeout(r, FB_FAST_REBOOT_MS));
      const probe = await ms45Job('aif_lesen', '');
      if (!probe.ok) {
        flashLog.note(
          `The DME does not answer on its program after the reset (${probe.error || probe.status || 'no answer'}): it is most likely waiting in the fast flasher`
        );
        throw new Error(
          `The fast flasher did not answer (${e.message}), and the DME no longer answers on its program either: it is most likely waiting in the flasher. Nothing was written. Switch the ignition off for ten seconds and back on: the DME starts its program again (the dash warnings go with it).`
        );
      }
      fbDmeSetFastLive(false);
      flashLog.note(
        'The DME is back on its program: the reset was a safe miss'
      );
    }
  }
  const keyed = await fbDmeEnterAtKeyOn(owner, ui);
  if (keyed) return keyed;
  throw new Error(
    `The DME did not enter the fast flasher (${lastError ? lastError.message : 'no answer'}). It is running its normal program; nothing was written.`
  );
}

/** @param {{low: boolean, text: string}} line - What the cable heard while the line was held low. */
function fbDmeNoteLine(line) {
  flashLog.note(
    `Line check while held low: ${line.text}${line.low ? ' (the line went low)' : ' (the line did NOT go low)'}`
  );
}

/**
 * The other way in, when the reset trigger misses: the K-line is held low
 * while the user switches the ignition off and on, so the gate sees it at
 * power-up with no reset timing involved. A miss here is as safe as the
 * reset's: the DME boots its program, or waits in the flasher until the
 * next key cycle.
 * @param {string} owner
 * @param {object} ui
 * @returns {Promise<{claim: object, link: object}|null>} null when the user
 *   declined.
 * @throws {Error} When the flasher did not answer after the key cycle.
 */
async function fbDmeEnterAtKeyOn(owner, ui) {
  if (
    !(await fbConfirm(
      'The reset did not reach the fast flasher. It can also be entered at key-on: BMWeb holds the K-line low, you switch the ignition OFF, wait 10 seconds, and switch it back ON (engine off), then press OK.\n\nTry that now?',
      owner
    ))
  )
    return null;
  ui.stage('Holding the K-line low: switch the ignition off and on');
  const claim = await webClaimBus(owner);
  const link = fastFlashWire.webLink(webBus, {
    onStep: (what) => ui.stage(what),
  });
  const holdUntil = fbMessage(
    'The K-line is held low now.\n\n1. Switch the ignition OFF.\n2. Wait 10 seconds.\n3. Switch the ignition ON (do not start the engine).\n4. Press OK.',
    owner
  ).then(() => new Promise((r) => setTimeout(r, 1500)));
  fbDmeSetFastLive(true);
  try {
    const stamp = await link.enter({ holdUntil, onLine: fbDmeNoteLine });
    const magic = String.fromCharCode(...stamp.subarray(0, 6));
    if (magic !== 'MS45QF')
      throw new Error(
        `The DME answered, but its HELLO stamp read "${magic}", not a fast flasher.`
      );
    flashLog.note('Entered the fast flasher at key-on');
    return { claim, link };
  } catch (e) {
    try {
      await link.leave();
    } catch (e2) {
      /* the next job reopens the port anyway */
    }
    claim.release();
    flashLog.note(`Key-on entry missed: ${e.message}`);
    throw new Error(
      `The fast flasher did not answer at key-on either (${e.message}). Nothing was written. Switch the ignition off for ten seconds and back on, then Identify: the DME starts its program again.`,
      { cause: e }
    );
  }
}

/**
 * The guard both fast-flasher writes share: a ready flasher on the DME and a
 * cable that can hold a break for the reset trigger. Shows the reason and
 * returns false when either fails. `upgrade` also lets an outdated but
 * working body through (Fast Flash Program, which replaces it).
 * @param {string} title
 * @param {{upgrade?: boolean}} [opts]
 * @returns {Promise<boolean>}
 */
async function fbDmeFastFlasherAvailable(title, opts = {}) {
  const d = fbState.dme;
  const usable =
    d.fastFlasher &&
    (d.fastFlasher.ready || (opts.upgrade && d.fastFlasher.upgradable));
  if (!usable) {
    await fbMessage(
      fastFlasher.describe(d.fastFlasher) +
        '\n\nRun Identify; if the flasher still does not show, bootstrap it with one full Flash Program first.',
      title
    );
    return false;
  }
  if (
    typeof webBus === 'undefined' ||
    !webBus.port ||
    !webBus.port.setSignals
  ) {
    await fbMessage(
      `${title} needs a cable with a break line (a Web Serial port or a gateway). The macOS bridge cannot hold the line for the reset trigger.`,
      title
    );
    return false;
  }
  return true;
}

/**
 * Read enough of the DME's internal flash over a NORMAL KWP session to know
 * its MPC is the one the loaded image was signed against: the reset word at
 * 0x8 (which must still be the flasher's hook) and the version string at
 * 0x100. The flasher writes only the external chip, so if those match, the
 * signature computed against the loaded MPC is valid on the car. Done before
 * the flasher session opens (4c's guidance: the flasher has no MPC read).
 * @param {Uint8Array} mpc - The loaded MPC image.
 * @returns {Promise<{ok: boolean, why?: string}>}
 */
async function fbDmeMpcMatchesCar(mpc) {
  try {
    const hook = await ms45ReadCarBytes(0x8, 0xb, 'LAR', fbDmeReadProtocol());
    if (!hook || hook.length < 4)
      return { ok: false, why: 'the reset word at MPC 0x8 did not read back' };
    for (let i = 0; i < 4; i++)
      if (hook[i] !== mpc[8 + i])
        return {
          ok: false,
          why: 'the reset word on the DME differs from the loaded MPC (a different or un-bootstrapped program)',
        };
    const ver = await ms45ReadCarBytes(
      0x100,
      0x109,
      'LAR',
      fbDmeReadProtocol()
    );
    if (!ver || ver.length < 10)
      return { ok: false, why: 'the MPC version string did not read back' };
    for (let i = 0; i < 10; i++)
      if (ver[i] !== mpc[0x100 + i])
        return {
          ok: false,
          why: 'the MPC version on the DME differs from the loaded MPC',
        };
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      why: `could not read the MPC to verify it: ${e.message}`,
    };
  }
}

/**
 * Fast Flash Program: the loaded pair pushed through the resident fast
 * flasher -- the external program's sectors and, with a v2 flasher, the MPC's
 * blocks, only those that differ. With a v1 flasher the MPC is not written,
 * so the loaded MPC must already be on the DME (checked over a normal KWP
 * session before the flasher session opens: the program signature covers
 * MPC segments). Full-binary mode only; testing-only.
 */
async function fbDmeFastFlashProgram() {
  const d = fbState.dme;
  if (!fbProtectTesting()) return;
  if (!d.identified || !d.flash || !d.mpc) return;
  if (
    !(await fbDmeFastFlasherAvailable('Fast Flash Program', { upgrade: true }))
  )
    return;

  const prompts = await fbDmeProgramMatchPrompts('Fast Flash Program');
  if (!prompts) return;
  let images;
  try {
    images = fbDmeApplyProgramEdits(prompts);
    // the DME carries the flasher, so the pair must too: its code in the last
    // program sector (which this push rewrites) and its hook in the MPC
    // (which the program signature covers)
    const carried = fastFlasher.withFlasher(images.source, images.mpc);
    images = { source: carried.flash, mpc: carried.mpc };
  } catch (e) {
    await fbMessage(e.message, e.title || 'Fast Flash Program');
    return;
  }
  const { source, mpc } = images;
  const hasCal = d.flash.length >= 0x5d000 && !fbDmeProgramHasNoTune();
  const progRef = ms45ReadAscii(source, 0x6031c, 12);
  // the signed external image, exactly as a full flash signs it -- against
  // this MPC, which is written too (v2) or must be the DME's own (v1)
  const chipImage = fbDmeChipImage(source, mpc, hasCal);
  // the MPC (internal flash) is written only by a body whose CMF writes go
  // through the boot loader's own driver (v7+, fastFlasher.MPC_WRITES_FROM):
  // v6's own sequence reset the car on 2026-10-21. The body on the DME does
  // the writing, so with an older one -- including the push that upgrades
  // it -- the loaded MPC must already match the car.
  const writesMpc = !!d.fastFlasher.mpcSafe;
  if (!writesMpc) {
    fbSetStatus('Checking the MPC on the DME matches the loaded program…');
    const match = await fbDmeMpcMatchesCar(mpc);
    if (!match.ok) {
      await fbMessage(
        `Fast Flash Program writes only the external program, not the MPC (internal flash) -- so the loaded MPC must already be on the DME.\n\n${match.why}.\n\nRun a full Flash Program instead: it writes the MPC too.`,
        'Fast Flash Program'
      );
      fbSetStatus('Fast Flash Program: MPC mismatch; nothing written');
      return;
    }
  }
  await fbDmeFastFlash({
    title: 'Fast Flash Program',
    operation: 'fast-flash-program',
    what: 'program',
    counter: true,
    confirm:
      (writesMpc
        ? 'Fast Flash Program resets the DME into its fast flasher and rewrites the program -- the external sectors and the MPC (internal flash) blocks that differ, compressed.\n\n'
        : 'Fast Flash Program resets the DME into its fast flasher and rewrites the external program -- only the sectors that differ, compressed.\n\n' +
          'The MPC (internal flash) is left as it is; it has been checked to match the loaded program.\n\n') +
      'Keep the ignition on, a charger on the battery and the cable plugged in until it has finished. An interrupted write leaves the program without its valid marks, and the DME stays in the flasher until a flash completes.\n\n' +
      'Write the program?',
    note: `DME ${d.ident.hwRef} / prog ${progRef || '(unreadable)'} / fast flasher v${d.fastFlasher.version}${d.fastFlasher.ready ? '' : ` (upgrading to v${fastFlasher.VERSION})`}${d.flashName ? ` / ${d.flashName}` : ''}${d.mpcName ? ` + ${d.mpcName}` : ''}`,
    prepare: async () => ({ attach: ['fast_program_ext.bin', chipImage] }),
    push: (client, cb) =>
      fastFlashWire.pushProgram(client, chipImage, cb, {
        mpc: writesMpc ? mpc : null,
        pagesets: !!d.fastFlasher.pagesets,
      }),
  });
}
