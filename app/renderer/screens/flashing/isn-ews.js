// Flashing/Tuning: the ISN / EWS page of the rail beside the AIF editor,
// and the matching section in Custom Options. BENCH ONLY (localhost): the
// used-DME repair lane.
//
// WHAT PAIRS A USED DME (car-verified twice, 2026-10-28, two donors
// started): the DME's flash ISN at ext 0x1FB00 must equal the ISN the
// car's EWS holds, then the EWS start-value sync realigns the rolling code.
// That is all. Write ISN (flash, through the fast flash bootloader's
// boot-sector ladder, core/flash/isn-flash.js + bl.burnIsn) followed by
// Sync EWS (the DME SGBD's start-value jobs) started both donors.
//
// WHAT DOES NOT: the 12-byte record in the serial EEPROM (0x04 / 0x14) is a
// per-DME identity word, not the EWS's ISN -- two DMEs with different
// EEPROM records both start the same car, and no sync ever rewrote it. So
// no flow here reads an ISN out of the EEPROM. And the EWS's own ISN cannot
// be pulled over the wire: ISN_LESEN is refused, and the DME's immobilizer
// work buffers hold the DME's OWN record (fn_FFFDC1B0 copies it in), never
// the EWS's value (the EWS's side of the exchange is one-way). The operator
// supplies the car's ISN: the original DME's, from Read ISN on it or from
// its flash dump.
/* exported fbIsnPageHtml, fbIsnShow, fbIsnAvailable, fbIsnEepromHtml, fbIsnEepromRefresh */

/** Stamp flag bit the v15+ bodies set (stamp byte 7): bit 4 = the EEPROM
 * read window (in the body itself). Only the EEPROM dump needs it. */
const FB_ISN_EE_READ = 0x10;

/**
 * Whether the rail offers the page: a DME identified with the fast flash
 * bootloader (the ISN tools ride on its boot-sector ladder, which every
 * v14+ ring carries). The dev UI toggle (Settings) forces it on regardless.
 */
function fbIsnAvailable() {
  if (fbDevUi()) return true;
  const d = fbState.dme;
  const have = d && d.bootLoader;
  return !!(
    fbState.module === 'dme' &&
    d.identified &&
    have &&
    have.version >= 14
  );
}

/**
 * Why the DME cannot be worked on from here, or null.
 * @param {boolean} eeprom - true for the EEPROM dump, which also needs the
 *   body's read window; the flash-ISN tools and the sync do not.
 */
function fbIsnWhyNot(eeprom) {
  const d = fbState.dme;
  const have = d && d.bootLoader;
  if (fbState.module !== 'dme' || !d.identified)
    return 'Identify the DME on the Flashing tab first.';
  if (!fbDmeIsMs451()) return 'The ISN tools are MS45.1 only.';
  if (!have || have.version < 14)
    return 'Needs the fast flash bootloader on the DME.';
  if (typeof webBus === 'undefined' || !webBus.port || !webBus.port.setSignals)
    return 'Needs a cable that can hold the break line (Web Serial or a gateway).';
  if (!eeprom) return null;
  if (!(have.flags & FB_ISN_EE_READ))
    return 'This bootloader has no EEPROM read window: update it first.';
  if (typeof eepromDump === 'undefined')
    return 'The EEPROM client (core/flash/eeprom.js) is not loaded in this build.';
  return null;
}

// ---- the rail page -----------------------------------------------------------------------------------------
function fbIsnPageHtml() {
  return `
    <div class="fb-page fb-isn" id="fb-page-isn" hidden>
      <div class="fb-section">
        <div class="fb-row">
          <button class="btn" id="fb-isnp-read" disabled title="Reads the ISN off the DME's flash. Nothing is written.">Read ISN</button>
          <button class="btn danger" id="fb-isnp-write" disabled title="Burns a new ISN into the DME's flash boot sector.">Write ISN</button>
          <button class="btn danger" id="fb-isnp-virgin" disabled title="Wipes the ISN to blank (0xFFFF). The car will not start until an ISN is written back.">Virginize</button>
          <button class="btn" id="fb-isnp-sync" disabled title="Runs the EWS start-value sync on the DME.">Sync EWS</button>
          <button class="btn" id="fb-isnp-dump" disabled title="Reads the whole 4 KB EEPROM and saves it to a file. Nothing is written.">Read EEPROM to file</button>
        </div>
        <div class="fb-faint" id="fb-isnp-reason"></div>
      </div>
    </div>`;
}

// ---- the Custom Options section: EEPROM read + flash ISN -----------------------------------------------------
/** The section's markup, under the bootloader's in Custom Options. */
function fbIsnEepromHtml() {
  return `
      <div class="fb-code">EEPROM</div>
      <div class="fb-dim">The DME's 4 KB serial EEPROM.</div>
      <div class="fb-row">
        <button class="btn" id="fb-opt-eeprom-read" disabled title="Resets the DME into its fast flash bootloader, reads the whole EEPROM, restarts the DME and saves the dump as a file. Nothing is written.">Read EEPROM to file</button>
      </div>
      <div class="fb-faint" id="fb-opt-eeprom-reason"></div>`;
}

/** The section's gate: a DME identified with a bootloader that carries the read window. */
function fbIsnEepromRefresh() {
  const btn = fbEls['opt-eeprom-read'];
  if (!btn) return;
  // the section follows the identification (an Identify while Custom
  // Options is open), not only the view's opening
  fbEls['opt-eeprom-section'].hidden = !(
    fbState.module === 'dme' && fbState.dme.bootLoader
  );
  if (!btn.dataset.wired) {
    btn.dataset.wired = '1';
    btn.onclick = () => fbDmeGuard('Read EEPROM', fbIsnDump);
  }
  const why = fbIsnWhyNot(true);
  btn.disabled = !!why;
  fbEls['opt-eeprom-reason'].textContent =
    why || 'Ready: nothing is written; the dump is saved as a file.';
}

/** The DME's SGBD for diagnostic jobs (the EWS start-value jobs run here). */
const FB_ISN_DME_SGBD = 'ms450ds0';
/** The EWS3 module's SGBD (WECHSELCODE_SYNC_DME runs here). */
const FB_ISN_EWS_SGBD = 'ews3';

/** Run one job, note the result, return its first result set (never throws). */
async function fbIsnRunJob(sgbd, job, arg, note) {
  let set;
  try {
    const r = await webRunJob(sgbd, job, arg || '');
    set = (r && r.sets && r.sets[0]) || {};
  } catch (e) {
    set = { JOB_STATUS: 'ERROR', _err: String((e && e.message) || e) };
  }
  if (note) {
    const extra =
      set.STEUERN_SYNC_MODE_TEXT ||
      set.STATUS_SYNC_MODE_TEXT ||
      set.EWS_STATUS ||
      set.EWS_EMPFANGSSTATUS ||
      set._err ||
      '';
    const label = arg ? `${job}(${arg})` : job;
    note(
      `${label}: ${set.JOB_STATUS || '?'}${extra ? ' (' + extra + ')' : ''}`
    );
  }
  return set;
}

/**
 * Run the "program start value" sequence, byte for byte what the INPA m_ews
 * screen's F2 "Startwert programmieren" does (proc s_ews_stell in the MS450
 * IR) -- the one that actually started the paired DME on the car. In order:
 *   1. WECHSELCODE_SYNC_DME on the EWS3 SGBD (the EWS's own realign job),
 *   2. EWS_STARTWERT with arg 1, then EWS_STARTWERT with arg 0, on the DME,
 *   3. wait 1.5 s,
 *   4. EWS_EMPFANG on the DME (the receive status).
 * The earlier chain (DME_STARTWERT_ABGLEICH / bare EWS_STARTWERT) was F1
 * "reset start value" and did not start the car on its own. Returns the
 * EWS_EMPFANG result set (the one whose OKAY says the exchange took).
 */
async function fbIsnRunSync(note) {
  await fbIsnRunJob(
    FB_ISN_EWS_SGBD,
    'WECHSELCODE_SYNC_DME',
    '',
    note && ((s) => note('EWS · ' + s))
  );
  await fbIsnRunJob(FB_ISN_DME_SGBD, 'EWS_STARTWERT', '1', note);
  await fbIsnRunJob(FB_ISN_DME_SGBD, 'EWS_STARTWERT', '0', note);
  if (note) note('waiting 2 s for the DME/EWS exchange');
  await new Promise((r) => setTimeout(r, 1500));
  return fbIsnRunJob(FB_ISN_DME_SGBD, 'EWS_EMPFANG', '', note);
}

/** Read the EWS-lock bit (LV_LOCK_IMOB): 1 blocks ignition + injection.
 * It stays 1 after a good sync until a real start completes the handshake,
 * so a 1 here is not a failure. */
async function fbIsnReadLock() {
  try {
    const r = await webRunJob(FB_ISN_DME_SGBD, 'STATUS_EWS_LOCK', '');
    const set = (r && r.sets && r.sets[0]) || {};
    return typeof set.STAT_EWS_LOCK_WERT === 'number'
      ? set.STAT_EWS_LOCK_WERT
      : null;
  } catch {
    return null;
  }
}

/** The line every write ends on: what the operator does next. */
const FB_ISN_AFTER_SYNC =
  'Switch the ignition off, wait 20 s, then start the engine (a second crank may be needed).';

// ---- the ISN prompt -----------------------------------------------------------------------------------------
/**
 * Decode an ISN out of a flash dump: a full ext image (the triple at
 * 0x1FB00) or the 96 KB boot sector on its own (at 0x17B00).
 * @param {Uint8Array} bytes
 * @returns {number|null} null when the file has no voting triple there.
 */
function fbIsnFromDump(bytes) {
  let at = -1;
  if (bytes.length >= isnFlash.AT + isnFlash.LEN) at = isnFlash.AT;
  else if (bytes.length === 0x18000) at = isnFlash.AT - 0x8000;
  if (at < 0) return null;
  return isnFlash.fromTriple(bytes.subarray(at, at + isnFlash.LEN));
}

/**
 * Ask for an ISN (four hex digits), with a way to take it off a flash dump
 * of the original DME. Resolves the 16-bit value, or null if cancelled.
 * @param {{title: string, body: string, action: string}} o
 */
function fbIsnPrompt(o) {
  return new Promise((resolve) => {
    const { overlay, close } = openModal(
      `<div class="modal danger" role="dialog" aria-modal="true">
        <div class="modal-title">${o.title}</div>
        <div class="modal-body">
          ${o.body}
          <div class="fb-row" style="align-items:stretch;margin-bottom:12px">
            <input class="modal-input fb-mono" id="fb-isn-value" type="text" maxlength="4" placeholder="A356" style="width:6em;margin-bottom:0">
            <button class="btn" id="fb-isn-from-dump" title="Reads the ISN out of a flash dump of the original DME (a full read, or its boot sector).">From a dump file…</button>
          </div>
          <div class="fb-dim fb-isn-hint">four hex digits</div>
        </div>
        <div class="modal-actions">
          <button class="btn modal-cancel">Cancel<span class="modal-key">Esc</span></button>
          <button class="btn danger modal-confirm" disabled>${o.action}</button>
        </div>
      </div>`,
      {
        onClose: (v) => resolve(typeof v === 'number' ? v : null),
        backdropValue: null,
      }
    );
    const input = overlay.querySelector('#fb-isn-value');
    const hint = overlay.querySelector('.fb-isn-hint');
    const confirm = overlay.querySelector('.modal-confirm');
    const parse = () =>
      /^[0-9A-F]{4}$/.test(input.value) ? parseInt(input.value, 16) : null;
    const paint = (note) => {
      const v = parse();
      confirm.disabled = v === null;
      hint.textContent =
        note || (v === null ? 'four hex digits' : `ISN ${isnFlash.text(v)}`);
    };
    input.oninput = () => {
      input.value = input.value.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
      paint();
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && parse() !== null) close(parse());
    };
    overlay.querySelector('#fb-isn-from-dump').onclick = async () => {
      const file = await fbPickFile('.bin,application/octet-stream');
      if (!file) return;
      const bytes = await fbReadBytes(file);
      const isn = fbIsnFromDump(bytes);
      if (isn === null) {
        paint(
          `${file.name}: no ISN triple at 0x1FB00 (not a full flash read or a boot sector?)`
        );
        return;
      }
      input.value = isnFlash.text(isn);
      paint(`ISN ${isnFlash.text(isn)} from ${file.name}`);
      input.focus();
    };
    overlay.querySelector('.modal-cancel').onclick = () => close(null);
    confirm.onclick = () => {
      const v = parse();
      if (v !== null) close(v);
    };
    setTimeout(() => input.focus(), 0);
  });
}

// ---- the flows ---------------------------------------------------------------------------------------------
/** Read ISN: one bootloader session, the six bytes at 0x1FB00 voted. */
async function fbIsnFlashRead() {
  const why = fbIsnWhyNot(false);
  if (why) {
    await fbMessage(why, 'Read ISN');
    return;
  }
  await fbDmeFastFlash({
    title: 'Read ISN',
    operation: 'isn-read',
    what: 'read',
    noFasterLine: true,
    confirm: '',
    confirmed: true,
    note: `DME ${fbState.dme.ident.hwRef} / flash ISN read`,
    push: async (client, cb) => {
      cb.stage('Reading the ISN');
      const six = await client.read(isnFlash.AT, isnFlash.LEN);
      const isn = isnFlash.fromTriple(six);
      const hex = Array.from(six)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ');
      if (isn === null) {
        fbSetStatus(`Read ISN: the triple did not vote (0x1FB00 = ${hex})`);
      } else {
        fbSetStatus(`Read ISN: ${isnFlash.text(isn)} (0x1FB00 = ${hex})`);
      }
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
 * Burn an ISN into flash 0x1FB00, one bootloader session (read-modify-write
 * of the boot sector, the six bytes read back and voted).
 * @returns {Promise<boolean>} whether the DME now holds the ISN (written,
 *   or already there). The session's errors land on the status line.
 */
async function fbIsnBurn(title, operation, isn) {
  let holds = false;
  await fbDmeFastFlash({
    title,
    operation,
    what: 'boot loader',
    noFasterLine: true,
    confirmed: true,
    confirm: '',
    note: `DME ${fbState.dme.ident.hwRef} / burn ISN ${isnFlash.text(isn)} at flash 0x1FB00`,
    push: async (client, cb) => {
      const r = await bl.burnIsn(client, isn, cb);
      holds = true;
      cb.stage('Restarting the DME');
      await client.reset();
      return r;
    },
    after: async () => {},
  });
  return holds;
}

/** Write ISN: ask for the value in a modal, then burn it into the boot sector. */
async function fbIsnFlashWrite() {
  const why = fbIsnWhyNot(false);
  if (why) {
    await fbMessage(why, 'Write ISN');
    return;
  }
  const isn = await fbIsnPrompt({
    title: 'Write ISN',
    action: 'Write',
    body: `<p>Burns a new ISN into the DME's flash boot sector (erase + rewrite). The program, tune and log are kept.</p>
          <p>Keep the ignition on, a charger on the battery and the cable plugged in until it has finished. A power or cable loss mid-write can leave the DME unbootable.</p>
          <p>The car starts only when this matches the EWS's ISN and the rolling code has been synced (Sync EWS).</p>`,
  });
  if (isn === null) {
    flashLog.note('Write ISN not confirmed: nothing was sent to the car');
    return;
  }
  if (await fbIsnBurn('Write ISN', 'isn-write', isn))
    fbSetStatus(`Write ISN: done, ${isnFlash.text(isn)} is on the DME`);
}

/** Virginize: blank the DME's ISN. Kept as a bench tool; pairing does not
 * need it (the EWS never writes the flash triple, so a blank DME stays
 * blank until Write ISN). */
async function fbIsnFlashVirginize() {
  const why = fbIsnWhyNot(false);
  if (why) {
    await fbMessage(why, 'Virginize');
    return;
  }
  const ok = await fbConfirm(
    "Wipes the DME's ISN to blank (erase + rewrite of the flash boot sector). The DME then presents 0xFFFF to the EWS. The program, tune and log are kept.\n\nNote: the EWS does not write the flash ISN back during a sync. To pair the DME afterwards, use Write ISN with the car's ISN.\n\nKeep the ignition on, a charger on the battery and the cable plugged in until it has finished. A power or cable loss mid-write can leave the DME unbootable.\n\nAfter this, the car will not start until an ISN is written back.\n\nVirginize the DME?",
    'Virginize'
  );
  if (!ok) {
    flashLog.note('Virginize not confirmed: nothing was sent to the car');
    return;
  }
  await fbDmeFastFlash({
    title: 'Virginize',
    operation: 'isn-virginize',
    what: 'boot loader',
    noFasterLine: true,
    confirmed: true,
    confirm: '',
    note: `DME ${fbState.dme.ident.hwRef} / blank ISN at flash 0x1FB00`,
    push: async (client, cb) => {
      const r = await bl.virginize(client, cb);
      cb.stage('Restarting the DME');
      await client.reset();
      return r;
    },
    after: async () => {
      fbSetStatus(
        'Virginize: done, the DME ISN is blank. Write the car’s ISN back (Write ISN) before the next start.'
      );
    },
  });
}

/** Sync EWS (manual): run the "program start value" sequence (the INPA
 * m_ews F2), which realigns the rolling code between the EWS and the DME's
 * ISN -- the one that started the car. */
async function fbIsnSyncEws() {
  const why = fbIsnWhyNot(false);
  if (why) {
    await fbMessage(why, 'Sync EWS');
    return;
  }
  const ok = await fbConfirm(
    "Programs the EWS start value (the EWS realign job, then the DME/EWS exchange) -- the same as the EWS screen's \"program start value\". Key on, engine off. The DME's flash ISN must already match the EWS's.\n\nSync the EWS to the DME?",
    'Sync EWS'
  );
  if (!ok) {
    flashLog.note('Sync EWS not confirmed: nothing was sent to the car');
    return;
  }
  fbSetStatus('Sync EWS: running the start-value sync…');
  const last = await fbIsnRunSync((s) => flashLog.note('Sync EWS · ' + s));
  const lock = await fbIsnReadLock();
  fbSetStatus(
    `Sync EWS: ${last && last.JOB_STATUS === 'OKAY' ? 'done' : 'see the log'}${lock !== null ? `, EWS lock = ${lock}` : ''}. ${FB_ISN_AFTER_SYNC}`
  );
}

// ---- the EEPROM dump ---------------------------------------------------------------------------------------
/**
 * Read EEPROM to file: the DME's 4 KB serial EEPROM through the fast flash
 * bootloader's read window, one session, handed over as a download named
 * after the car. Nothing is written.
 */
async function fbIsnDump() {
  const why = fbIsnWhyNot(true);
  if (why) {
    await fbMessage(why, 'Read EEPROM');
    return;
  }
  const d = fbState.dme;
  let img = null;
  await fbDmeFastFlash({
    title: 'Read EEPROM',
    operation: 'eeprom-read',
    what: 'read',
    noFasterLine: true,
    confirm:
      'Read EEPROM resets the DME into its fast flash bootloader, reads the EEPROM and restarts the DME. Nothing is written.\n\nRead the EEPROM?',
    note: `DME ${d.ident.hwRef} / BL${d.bootLoader.version} / EEPROM read`,
    push: async (client, cb) => {
      cb.stage('Reading the EEPROM');
      img = await eepromDump.dump(client, {
        progress: (n) => cb.progress(Math.floor((n * 90) / eepromDump.SIZE)),
      });
      cb.stage('Restarting the DME');
      await client.reset();
      return {
        skipped: false,
        summary: `the EEPROM read, ${img.length >> 10} KB`,
      };
    },
    // the DME was only read: no identify after
    after: async () => {},
  });
  if (!img) return;
  const who = [d.ident.vin, d.ident.hwRef].filter(Boolean).join('_') || 'dme';
  fbSaveBytes(`${who}_EEPROM_${img.length >> 10}K.bin`, img);
}

// ---- the rail page's wiring and painting ------------------------------------------------------------------
/** Wire the rail page's buttons once and paint it; the rail calls this on
 * every show. The buttons call the same handlers as Custom Options. */
function fbIsnShow() {
  const page = fbEls['page-isn'];
  if (!page) return;
  if (!fbIsnAvailable()) {
    fbShowPage('flashing');
    return;
  }
  if (!page.dataset.wired) {
    page.dataset.wired = '1';
    fbEls['isnp-read'].onclick = () => fbDmeGuard('Read ISN', fbIsnFlashRead);
    fbEls['isnp-write'].onclick = () =>
      fbDmeGuard('Write ISN', fbIsnFlashWrite);
    fbEls['isnp-virgin'].onclick = () =>
      fbDmeGuard('Virginize', fbIsnFlashVirginize);
    fbEls['isnp-sync'].onclick = () => fbDmeGuard('Sync EWS', fbIsnSyncEws);
    fbEls['isnp-dump'].onclick = () => fbDmeGuard('Read EEPROM', fbIsnDump);
  }
  fbIsnPaint();
}

function fbIsnPaint() {
  if (!fbEls['isnp-read']) return;
  const why = fbIsnWhyNot(false);
  const busy = why || fbState.running;
  for (const id of ['isnp-read', 'isnp-write', 'isnp-virgin', 'isnp-sync'])
    if (fbEls[id]) fbEls[id].disabled = !!busy;
  const whyEe = fbIsnWhyNot(true);
  if (fbEls['isnp-dump'])
    fbEls['isnp-dump'].disabled = !!(whyEe || fbState.running);
  fbEls['isnp-reason'].textContent =
    why ||
    `Read, write, virginize, or sync.${whyEe ? ' EEPROM: ' + whyEe : ''}`;
}
