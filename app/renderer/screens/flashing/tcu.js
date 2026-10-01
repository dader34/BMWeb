// Flashing/Backups: the transmission (GS20) side. Identify through BMW's own
// gs20.prg (IDENT + AIF_LESEN) with a raw probe for the read patch, then the
// raw-DS2 engine for everything else: Read Calibration, Load / Write
// Calibration (a 64 KB .bin or a BMW .0DA), Load / Write Program (256 KB,
// a 512 KB image or a .0PA), Install Read Patch, Read Full, and the
// programming-log entry after a write.
/* exported fbTcuFreshState, fbTcuPanelHtml, fbTcuWire, fbTcuReset, fbTcuRefresh, fbTcuIdentify, fbTcuNoUpshiftBlockedReason */

/** The E46 automatic-transmission SGBDs BMW's D_EGS group dispatches to; GS20 first. */
const FB_TCU_VARIANTS = ['gs20', 'gs8600', 'gs8602', 'gs8603', 'gs8604'];

/** @returns {Object} A fresh TCU state. */
function fbTcuFreshState() {
  return {
    sgbd: null,
    identSw: '',
    identBmw: '',
    hasReadPatch: false,
    aif: {},
    fullBin: false,
    fast: true,
    cal: null,
    calName: '',
    program: null,
    programName: '',
    noUpshift: false,
  };
}

/** @returns {string} The TCU panel's markup. */
function fbTcuPanelHtml() {
  return `
    <div class="fb-panel" id="fb-tcu-panel" hidden>
      <button class="btn fb-wide" id="fb-tcu-read" disabled title="Dump the transmission calibration (0x090000, 64 KB) to a file.">Read Calibration</button>
      <button class="btn fb-wide" id="fb-tcu-load-cal" disabled title="Pick a 64 KB GS20 calibration to write. Its checksum is corrected automatically.">Load Calibration File</button>
      <div class="fb-mono fb-faint fb-name" id="fb-tcu-cal-name" hidden></div>
      <button class="btn danger fb-wide" id="fb-tcu-write-cal" disabled title="Erase and reprogram the transmission calibration over raw DS2.">Write Calibration</button>
      <button class="btn fb-wide" id="fb-tcu-load-program" disabled hidden title="A 256 KB program region, a 512 KB full image, or a BMW .0PA. Its checksum is corrected on the way in.">Load Program File</button>
      <div class="fb-mono fb-faint fb-name" id="fb-tcu-program-name" hidden></div>
      <div class="fb-pill" id="fb-tcu-program-tune" hidden><span id="fb-tcu-program-tune-text"></span><button class="fb-x" id="fb-tcu-program-tune-remove" title="Remove the calibration. If the program is of another release than the transmission, a calibration is required and Write Program will ask for one.">&#x2715;</button></div>
      <button class="btn danger fb-wide" id="fb-tcu-write-program" disabled hidden title="Erase the four program sectors (0x0A0000-0x0DFFFF) and reprogram them, then write the calibration shown above if there is one. Not recoverable over the diagnostic port if it fails.">Write Program</button>
      <button class="btn fb-wide" id="fb-tcu-read-patch" disabled hidden title="Write the built-in 7552700 program with the full-read patch. Only for a transmission already on G2210_0090C0; the calibration is not touched.">Install Read Patch</button>
      <label class="fb-check"><input type="checkbox" id="fb-tcu-fullbin"> Full Binary</label>
      <label class="fb-check"><input type="checkbox" id="fb-tcu-fast" checked> Fast mode</label>
      <div class="fb-faint">Take a backup read first and keep the engine off with a charger on.</div>
      <hr class="fb-sep">
      <button class="btn fb-wide" id="fb-tcu-read-full" disabled title="Read the whole 512 KB module image (boot block, calibration, program). Needs the patched program; identify checks for it.">Read Full</button>
    </div>`;
}

function fbTcuWire() {
  fbEls['tcu-read'].onclick = () =>
    fbTcuGuard('Read Calibration', fbTcuReadCal);
  fbEls['tcu-load-cal'].onclick = () => fbTcuLoadCalClick();
  fbEls['tcu-write-cal'].onclick = () =>
    fbTcuGuard('Write Calibration', fbTcuWriteCal);
  fbEls['tcu-load-program'].onclick = () => fbTcuLoadProgramClick();
  fbEls['tcu-program-tune-remove'].onclick = () => {
    fbState.tcu.cal = null;
    fbState.tcu.calName = '';
    fbTcuRefresh();
    fbOptionsRefreshSummary();
    fbSetStatus('Calibration removed; only the program will be written');
  };
  fbEls['tcu-write-program'].onclick = () =>
    fbTcuGuard('Write Program', fbTcuWriteProgram);
  fbEls['tcu-read-patch'].onclick = () =>
    fbTcuGuard('Install Read Patch', fbTcuInstallReadPatch);
  fbEls['tcu-read-full'].onclick = () => fbTcuGuard('Read Full', fbTcuReadFull);
  fbEls['tcu-fullbin'].onchange = () => {
    fbState.tcu.fullBin = fbEls['tcu-fullbin'].checked;
    fbTcuRefresh();
  };
  fbEls['tcu-fast'].onchange = () => {
    fbState.tcu.fast = fbEls['tcu-fast'].checked;
  };
}

function fbTcuReset() {
  fbState.tcu = fbTcuFreshState();
  if (fbEls['tcu-fullbin']) {
    fbEls['tcu-fullbin'].checked = false;
    fbEls['tcu-fast'].checked = true;
  }
}

/** Every TCU control's visibility and enabled state, from the state. */
function fbTcuRefresh() {
  const t = fbState.tcu;
  if (!t || !fbEls['tcu-panel']) return;
  const gs20 = t.sgbd === 'gs20';
  const dev = fbDevUi();
  const full = t.fullBin;
  fbEls['tcu-read'].disabled = !t.sgbd;
  fbEls['tcu-load-cal'].disabled = !(gs20 || dev);
  fbEls['tcu-write-cal'].hidden = full;
  fbEls['tcu-write-cal'].disabled = !(gs20 && t.cal);
  fbEls['tcu-load-program'].hidden = !full;
  fbEls['tcu-load-program'].disabled = !(gs20 || dev);
  fbEls['tcu-write-program'].hidden = !full;
  fbEls['tcu-write-program'].disabled = !(gs20 && t.program);
  fbEls['tcu-read-patch'].hidden = !full;
  fbEls['tcu-read-patch'].disabled = !(gs20 && !t.hasReadPatch);
  fbEls['tcu-read-full'].disabled = !t.hasReadPatch;
  const calVersion = t.cal ? gs20Checksum.version(t.cal) : null;
  const calText = t.cal
    ? `${t.calName || 'calibration'}${calVersion ? `  ${calVersion}` : ''}`
    : '';
  fbEls['tcu-cal-name'].textContent = calText;
  fbEls['tcu-cal-name'].hidden = !calText || full;
  fbEls['tcu-program-name'].textContent = t.programName || '';
  fbEls['tcu-program-name'].hidden = !(full && t.program);
  fbEls['tcu-program-tune-text'].textContent = calText ? `+ ${calText}` : '';
  fbEls['tcu-program-tune'].hidden = !(full && t.program && calText);
}

/**
 * Run a TCU action with the cable checked, the screen busy and errors shown.
 * @param {string} title - The dialog title.
 * @param {() => Promise<void>} fn - The action.
 */
async function fbTcuGuard(title, fn) {
  if (fbState.running) return;
  if (!(await fbEnsureCable())) return;
  fbBusy(true);
  try {
    await fn();
  } catch (e) {
    fbSetStatus(`${title} failed: ${(e && e.message) || e}`);
    await fbMessage(fbDescribeError(e), title);
  } finally {
    fbBusy(false);
    fbFlashingBar(false);
    fbProgress(0);
    fbRefreshAll();
  }
}

/** The transmission as identify named it, for dialogs. */
function fbTcuDescribeSoftware() {
  const t = fbState.tcu;
  const sw = (t.identSw || '').trim() || null;
  const part = (t.identBmw || '').trim() || null;
  if (!sw && !part) return 'not identified';
  if (sw && part) return `${part} (software ${sw})`;
  return sw || part;
}

// ---- identify --------------------------------------------------------------------------------------------
/**
 * Ask each of BMW's E46 auto-TCU variants for its IDENT; the first that
 * answers wins. A GS20 then has its programming log read and is probed for
 * the read patch.
 * @returns {Promise<void>}
 */
async function fbTcuIdentify() {
  const t = fbState.tcu;
  let found = null;
  let res = null;
  let lastProblem = '';
  for (const variant of FB_TCU_VARIANTS) {
    try {
      const r = await webRunJob(variant, 'IDENT', '');
      const status = fbTcuField(r, 'JOB_STATUS');
      if (status === 'OKAY') {
        found = variant;
        res = r;
        break;
      }
      lastProblem = `${variant}: ${status || 'no answer'}`;
    } catch (e) {
      // a job that could not even run (no job code, cable gone) is worth
      // telling apart from a transmission that simply does not answer
      lastProblem = `${variant}: ${fbDescribeError(e)}`;
    }
  }
  if (!found) {
    fbLog(lastProblem);
    fbSetStatus('No response from the TCU');
    await fbMessage(
      `The transmission did not respond to any known E46 auto-TCU variant. Check ignition and the cable.\n\nLast attempt: ${lastProblem}`,
      'Identify TCU'
    );
    return;
  }
  t.sgbd = found;
  t.identBmw = fbTcuField(res, 'ID_BMW_NR');
  t.identSw = fbTcuField(res, 'ID_SW_NR');
  const hw = fbTcuField(res, 'ID_HW_NR');
  fbSetEcuBox(`TCU  ${hw}  ·  ${t.identSw}`);
  // the programming log, through the diagnostic SGBD's own AIF_LESEN
  t.aif = {};
  try {
    const a = await webRunJob(found, 'AIF_LESEN', '0');
    if (fbTcuField(a, 'JOB_STATUS') === 'OKAY') {
      for (const f of [
        'AIF_FG_NR',
        'AIF_DATUM',
        'AIF_AENDERUNGS_INDEX',
        'AIF_SW_NR',
        'AIF_BEHOERDEN_NR',
        'AIF_ZB_NR',
        'AIF_PROGG_NR',
        'AIF_WERKSCODE',
        'AIF_KM_STAND',
        'AIF_ANZAHL_PROG',
        'AIF_ANZ_FREI',
        'AIF_ADRESSE',
      ]) {
        const v = fbTcuField(a, f);
        if (v) t.aif[f] = v;
      }
    }
  } catch (e) {
    /* the counter stays unknown */
  }
  fbTcuLogAif(t.aif);
  if (found !== 'gs20') {
    t.cal = null;
    fbSetStatus(`TCU identified (${found}.prg)`);
    return;
  }
  // a module that already answers the patched read has nothing to install
  const problem = await gs20ProbeReadPatch();
  t.hasReadPatch = problem == null;
  fbSetStatus(
    t.hasReadPatch
      ? 'TCU identified (gs20.prg), patched program: full read available'
      : 'TCU identified (gs20.prg), stock program: full read unavailable'
  );
}

function fbTcuField(res, field) {
  const sets = (res && res.sets) || [];
  for (const s of sets) {
    if (s && Object.prototype.hasOwnProperty.call(s, field) && s[field] != null)
      return String(s[field]).trim();
  }
  return '';
}

function fbTcuLogAif(aif) {
  if (!aif || !Object.keys(aif).length) {
    fbLog('Coding data: the programming record (AIF) was not answered');
    return;
  }
  const f = (k) => aif[k] || '';
  fbLog(
    `Coding data: VIN ${f('AIF_FG_NR') || '-'} · date ${f('AIF_DATUM') || '-'}${f('AIF_AENDERUNGS_INDEX') ? ` · index ${f('AIF_AENDERUNGS_INDEX')}` : ''}`
  );
  fbLog(
    `    software ${f('AIF_SW_NR') || '-'} · assembly ${f('AIF_ZB_NR') || '-'} · official ${f('AIF_BEHOERDEN_NR') || '-'}`
  );
  const extra = [];
  if (f('AIF_PROGG_NR')) extra.push(`program ${f('AIF_PROGG_NR')}`);
  if (f('AIF_WERKSCODE') && f('AIF_WERKSCODE') !== '0')
    extra.push(`dealer ${f('AIF_WERKSCODE')}`);
  if (f('AIF_KM_STAND')) extra.push(`${f('AIF_KM_STAND')} km`);
  const addr = parseInt(f('AIF_ADRESSE'), 10);
  if (Number.isFinite(addr))
    extra.push(`base 0x${addr.toString(16).toUpperCase().padStart(6, '0')}`);
  const free = parseInt(f('AIF_ANZ_FREI'), 10);
  if (Number.isFinite(free))
    extra.push(`${free} of ${FB_AIF_SLOTS} entries free`);
  if (extra.length) fbLog(`    ${extra.join(' · ')}`);
}

// ---- read ------------------------------------------------------------------------------------------------
async function fbTcuReadCal() {
  const t = fbState.tcu;
  if (!t.sgbd) {
    fbSetStatus('Identify the TCU first');
    return;
  }
  if (t.sgbd !== 'gs20') {
    await fbMessage(
      'Only the GS20 is read here; its calibration layout is the only one known.',
      'Read Calibration'
    );
    return;
  }
  await fbSessionStart('tcu-cal-read', { module: 'GS20' });
  try {
    const cal = await gs20ReadCalibration({
      fast: t.fast,
      onStage: (s) => flashLog.note(s),
      onTrace: (s) => flashLog.trace(s),
      onProgress: (p) => {
        fbProgress(p);
        fbSetStatusInPlace(`${p}%`);
      },
    });
    const stamp = fbTcuStamp();
    fbSaveBytes(`TCU_cal_${stamp}.bin`, cal);
    fbSetStatus(
      `Read TCU calibration (0x${cal.length.toString(16).toUpperCase()} bytes)${fbTcuDescribeChecksum(cal)}`
    );
  } finally {
    await fbSessionStop();
  }
}

function fbTcuStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function fbTcuDescribeChecksum(cal) {
  if (!cal || cal.length < GS20_CAL_LENGTH) return '';
  const h4 = (v) => `0x${v.toString(16).toUpperCase().padStart(4, '0')}`;
  return gs20Checksum.verify(cal)
    ? ', checksum valid'
    : `, checksum does NOT match (stored ${h4(gs20Checksum.stored(cal))}, expected ${h4(gs20Checksum.compute(cal))})`;
}

async function fbTcuReadFull() {
  const t = fbState.tcu;
  if (!t.sgbd) {
    fbSetStatus('Identify the TCU first');
    return;
  }
  const minutesAt9600 = Math.ceil(((GS20_FULL_LENGTH / 123) * 0.28) / 60);
  if (
    !(await fbConfirm(
      'This uses the subcode-8 read, which only exists on a module flashed with the patched program. A stock module will answer B0 and nothing will happen.\n\n' +
        `Reading 0x${GS20_FULL_LENGTH.toString(16).toUpperCase()} bytes from 0x${GS20_FULL_ADDRESS.toString(16).toUpperCase().padStart(6, '0')}.` +
        (t.fast
          ? ''
          : ` At 9600 baud this takes roughly ${minutesAt9600} minutes; turn on fast mode to shorten it.`) +
        '\n\nNothing is written to the module.',
      'Read Full'
    ))
  ) {
    return;
  }
  await fbSessionStart('tcu-full-read', { module: 'GS20' });
  try {
    flashLog.note(
      `TCU gs20 / subcode-8 read of the full region / fast mode ${t.fast ? 'on' : 'off'}`
    );
    const image = await gs20ReadFull({
      fast: t.fast,
      onStage: fbSetStage,
      onTrace: (s) => flashLog.trace(s),
      onProgress: (p) => {
        fbProgress(p);
        fbSetStatusInPlace(`${p}%`);
      },
    });
    const vectors =
      image[0] === 0xfa &&
      image[4] === 0xfa &&
      image[8] === 0xfa &&
      image[12] === 0xfa;
    let blank = 0;
    for (const b of image.subarray(0, 0x10000))
      if (b === 0x00 || b === 0xff) blank++;
    const verdict = !vectors
      ? ' -- WARNING: the reset vectors are not JMPS (0xFA). This boot block looks damaged.'
      : blank > 0x8000
        ? ` -- warning: the vectors are intact but ${blank} of 65536 boot-block bytes are blank.`
        : ' -- boot vectors intact (FA at 0x00/04/08/0C).';
    flashLog.note(
      `RESULT: 0x${image.length.toString(16).toUpperCase()} bytes${verdict}`
    );
    fbSaveBytes(`TCU_full_080000_${fbTcuStamp()}.bin`, image);
    fbSetStatus(
      `Read 0x${image.length.toString(16).toUpperCase()} bytes from 0x080000${verdict}`
    );
    if (/warning/i.test(verdict))
      await fbMessage(
        `The read completed, but the contents look wrong:${verdict.replace(' -- ', '\n\n')}`,
        'Read Full'
      );
  } finally {
    await fbSessionStop();
  }
}

// ---- loading a calibration -----------------------------------------------------------------------------------
async function fbTcuLoadCalClick() {
  const file = await fbPickFile('.bin,.0DA,.0da');
  if (!file) return;
  await fbTcuLoadCalibration(file, false);
  fbRefreshAll();
}

/**
 * Whether a calibration file belongs on the transmission that answered: the
 * four digits after the underscore of "G2210_0090C0ER10" are the release the
 * module reports as its software number.
 * @param {string|null} version - The calibration's version string.
 * @returns {boolean}
 */
function fbTcuCalMatches(version) {
  const m = /_(\d{4})/.exec(version || '');
  if (!m) return false;
  const release = m[1].replace(/^0+(?=\d)/, '');
  const reported = (fbState.tcu.identSw || '').trim().replace(/^0+(?=\d)/, '');
  return !!reported && release === reported;
}

/**
 * Load a calibration (raw 64 KB or a BMW .0DA) as the one to write. With
 * `forProgram` it is the calibration paired with a loaded program, used as
 * it is without the save-or-use question.
 * @param {File} file - The picked file.
 * @param {boolean} forProgram - Whether it follows a program.
 * @returns {Promise<boolean>} Whether a calibration is now loaded.
 */
async function fbTcuLoadCalibration(file, forProgram) {
  const t = fbState.tcu;
  const fail = (status) => {
    t.cal = null;
    t.calName = '';
    fbTcuRefresh();
    fbOptionsRefreshSummary();
    if (status) fbSetStatus(status);
    return false;
  };
  try {
    let cal;
    let datenNote = '';
    if (gs20DatenFile.isDatenFile(file.name)) {
      const text = await fbReadText(file);
      try {
        cal = gs20DatenFile.decode(text);
      } catch (e) {
        await fbMessage(
          `This file could not be decoded, so nothing was loaded.\n\n${e.message}`,
          'Load Calibration'
        );
        return fail(`Could not read that Daten file: ${e.message}`);
      }
      const vehicle = gs20DatenFile.readVehicle(text);
      const reference = gs20DatenFile.readReference(text);
      const choice = forProgram
        ? 1
        : await fbChoose(
            `${file.name} is a BMW Daten file and has been converted to a 64 KB calibration.\n\n${reference ? `Calibration:  ${reference}\n` : ''}${vehicle ? `Vehicle:      ${vehicle}\n` : ''}\nWhat would you like to do with it?`,
            'Load Calibration',
            ['Save as .bin', 'Use for flashing', 'Save and use']
          );
      if (choice < 0) {
        fbSetStatus('Nothing loaded');
        return false;
      }
      if (choice === 0 || choice === 2)
        fbSaveBytes(
          `${file.name.replace(/\.[^.]+$/, '')}_converted.bin`,
          gs20Checksum.correct(cal)
        );
      if (choice === 0) {
        fbSetStatus(
          `Converted ${file.name}${reference ? ` (${reference})` : ''}`
        );
        return false;
      }
      datenNote = ` [.0DA${vehicle ? `, ${vehicle}` : ''}]`;
    } else {
      cal = await fbReadBytes(file);
    }
    if (cal.length !== GS20_CAL_LENGTH)
      return fail(
        `A GS20 calibration is 64 KB; that file is 0x${cal.length.toString(16).toUpperCase()} bytes`
      );
    if (!gs20DatenFile.hasTrailer(cal)) {
      await fbMessage(
        'This file does not end with the four bytes every GS20 calibration carries (C7 A3 8C 44).\n\nA calibration like this is written without complaint and then refused when the transmission validates it, so it has not been loaded.',
        'Load Calibration'
      );
      return fail('That calibration is missing its trailer; not loaded');
    }
    const stored = gs20Checksum.stored(cal);
    t.cal = gs20Checksum.correct(cal);
    const corrected = gs20Checksum.stored(t.cal);
    t.calName = file.name;
    t.noUpshift = false;
    fbTcuRefresh();
    fbOptionsRefreshUpshiftGate();
    const version = gs20Checksum.version(t.cal);
    const h4 = (v) => `0x${v.toString(16).toUpperCase().padStart(4, '0')}`;
    fbSetStatus(
      `Loaded ${file.name}${datenNote}${version ? ` (${version})` : ''}` +
        (stored === corrected
          ? ', checksum already correct'
          : `, checksum corrected ${h4(stored)} to ${h4(corrected)}`) +
        (fbTcuCalMatches(version)
          ? ''
          : ' - does NOT match the identified transmission')
    );
    return true;
  } catch (e) {
    await fbMessage(fbDescribeError(e), 'Load Calibration');
    return fail(`Could not load the calibration: ${e.message}`);
  }
}

/** Why the upshift patch cannot be offered, or null when it can. */
function fbTcuNoUpshiftBlockedReason() {
  const t = fbState.tcu;
  if (!t.cal)
    return 'Load a calibration first. The patch is applied to the file, not to the car.';
  if (!gs20NoUpshift.isApplicable(t.cal))
    return 'This calibration does not have the upshift tables the patch expects, so it cannot be applied to it safely.';
  if (gs20NoUpshift.isApplied(t.cal))
    return 'This calibration already has its upshift points raised.';
  return null;
}

// ---- writing a calibration ------------------------------------------------------------------------------------
async function fbTcuWriteCal() {
  const t = fbState.tcu;
  if (!t.cal) {
    fbSetStatus('Load a calibration first');
    return;
  }
  const fileVersion = gs20Checksum.version(t.cal);
  if (!fbTcuCalMatches(fileVersion)) {
    if (
      !(await fbConfirmAck(
        `This calibration was not built for the transmission that answered.\n\nTransmission: ${fbTcuDescribeSoftware()}\nCalibration file: ${fileVersion || 'no version found'}\n\n` +
          'Writing software meant for another gearbox can make it shift badly or not at all. Only continue if you know this calibration belongs on this transmission. You do this at your own risk.',
        'I understand this calibration may not match, and I accept the risk.',
        'Calibration does not match'
      ))
    ) {
      fbSetStatus(
        'Write cancelled: the calibration does not match the transmission'
      );
      return;
    }
  }
  const patchNote = t.noUpshift
    ? 'Automatic upshifts will be removed from the calibration first.\n\n'
    : '';
  if (
    !(await fbConfirm(
      `This erases and reprograms the transmission calibration at 0x${GS20_CAL_ADDRESS.toString(16).toUpperCase().padStart(6, '0')}.\n\n${patchNote}` +
        'Until it finishes the transmission has no valid calibration. Do not switch the ignition off or unplug the cable. Keep the voltage steady.\n\nWrite now?',
      'Write Calibration'
    ))
  ) {
    return;
  }
  if (!(await fbProgrammingCounter(true))) return;

  let eraseStarted = false;
  fbFlashingBar(true);
  await fbSessionStart('tcu-cal-write', { module: 'GS20' });
  try {
    flashLog.note(
      `TCU gs20 / cal 0x${GS20_CAL_ADDRESS.toString(16).toUpperCase()} / checksum 0x${gs20Checksum.stored(t.cal).toString(16).toUpperCase().padStart(4, '0')}`
    );
    const image = t.noUpshift ? gs20NoUpshift.apply(t.cal) : t.cal;
    if (image !== t.cal) flashLog.note('auto upshift removed');
    flashLog.attach('tcu_calibration_0x090000.bin', image);
    const aifRecord = fbTcuAifRecord(null, image);
    try {
      const res = await gs20WriteCalibration(image, {
        confirmed: true,
        fast: t.fast,
        aifRecord,
        onStage: fbSetStage,
        onTrace: (s) => flashLog.trace(s),
        onProgress: (p) => {
          fbProgress(p);
          fbSetStatusInPlace(`${p}%`);
        },
      });
      eraseStarted = res.eraseStarted;
      if (res.aif) t.aif.AIF_ANZ_FREI = String(res.aif.left);
      fbSetStatus('Calibration written. Cycle the ignition before driving.');
      await fbMessage(
        'The calibration was written and the transmission confirmed it.\n\nCycle the ignition, then check for stored faults before driving.',
        'Write Calibration'
      );
    } catch (e) {
      eraseStarted = !!(e && e.eraseStarted);
      fbSetStatus(`Calibration write failed: ${e.message}`);
      const aftermath = eraseStarted
        ? '\n\nThe transmission may be holding an incomplete calibration. Its boot block and program are untouched, so it still answers and can be written again: fix the cause, then write a known-good calibration before driving.'
        : '\n\nNothing was erased or written, so the calibration on the transmission is unchanged.';
      await fbMessage(fbDescribeError(e) + aftermath, 'Write Calibration');
    }
  } finally {
    fbFlashingBar(false);
    fbProgress(0);
    await fbSessionStop();
  }
}

/**
 * The programming-log entry for this write: the VIN from the counter
 * question, the DME when it was identified this session, else the module's
 * own last entry; today's date; the data and assembly numbers from the
 * calibration's own reference (ER10 = 7558009 / 7558008 ...), else the file
 * name, else carried forward; the program reference from the image tail.
 * @param {Uint8Array|null} program - The program image written, if any.
 * @param {Uint8Array|null} calibration - The calibration written, if any.
 * @returns {Uint8Array|null} The record, or null when none can be made.
 */
function fbTcuAifRecord(program, calibration) {
  if (Settings.get('flashWriteAif', true) === false) return null;
  const t = fbState.tcu;
  const a = (f) => t.aif[f] || '';
  let vin = fbState.aifVin || '';
  if (!fbIsAlnum(vin, 17))
    vin =
      (fbState.dme && fbState.dme.aif && fbState.dme.aif.AIF_FG_NR_LANG) || '';
  if (!fbIsAlnum(vin, 17)) vin = a('AIF_FG_NR');
  if (!fbIsAlnum(vin, 17)) {
    flashLog.note(
      'AIF not written: no 17-character VIN known (type one at the counter question or identify the DME first)'
    );
    return null;
  }
  const ident = gs20IdentTail(program) || gs20IdentTail(calibration);
  const progRef = ident
    ? [0, parseInt(ident.slice(0, 2), 16), parseInt(ident.slice(2, 4), 16)]
    : [0, 0, 0];
  const known = gs20Aif.partNumbers(
    calibration ? gs20Checksum.version(calibration) : null
  );
  const fileNr = (name) => {
    const m = /(?<!\d)(\d{7})(?!\d)/.exec(name || '');
    return m ? parseInt(m[1], 10) : null;
  };
  const zb = known ? known.assemblyNr : gs20Aif.number(a('AIF_ZB_NR'));
  const sw = known
    ? known.dataNr
    : fileNr(t.calName) || gs20Aif.number(a('AIF_SW_NR'));
  let index = a('AIF_AENDERUNGS_INDEX');
  if (index.length !== 2) index = '00';
  try {
    return gs20Aif.build(
      vin,
      new Date(),
      sw,
      index,
      gs20Aif.number(a('AIF_BEHOERDEN_NR')),
      zb,
      fbTesterSerial,
      gs20Aif.number(a('AIF_WERKSCODE')),
      gs20Aif.number(a('AIF_KM_STAND')),
      progRef
    );
  } catch (e) {
    flashLog.note(`AIF not written: ${e.message}`);
    return null;
  }
}

// ---- loading and writing a program ------------------------------------------------------------------------------
async function fbTcuLoadProgramClick() {
  const t = fbState.tcu;
  const file = await fbPickFile('.bin,.0PA,.0pa');
  if (!file) return;
  try {
    let program;
    let origin;
    if (gs20DatenFile.isProgramFile(file.name)) {
      program = gs20DatenFile.decodeProgram(await fbReadText(file));
      origin = '.0PA';
    } else {
      const raw = await fbReadBytes(file);
      if (raw.length === GS20_FULL_LENGTH) {
        program = Uint8Array.from(
          raw.subarray(
            GS20_PROGRAM_ADDRESS - GS20_FULL_ADDRESS,
            GS20_PROGRAM_ADDRESS - GS20_FULL_ADDRESS + GS20_PROGRAM_LENGTH
          )
        );
        origin = '512 KB image';
      } else if (raw.length === GS20_PROGRAM_LENGTH) {
        program = raw;
        origin = '256 KB program';
      } else {
        t.program = null;
        fbSetStatus(
          `A GS20 program is 256 KB (or a 512 KB full image); that file is 0x${raw.length.toString(16).toUpperCase()} bytes`
        );
        return;
      }
    }
    const release = gs20ProgramRelease(program);
    if (!release) {
      t.program = null;
      await fbMessage(
        'This file carries no G2210 version string where a GS20 program keeps one, so it is not being loaded. A program written from the wrong file cannot be recovered over the diagnostic port.',
        'Load Program'
      );
      return;
    }
    const stored = gs20ProgramChecksum.stored(program);
    const { image, checksum } = gs20ProgramChecksum.corrected(program);
    t.program = image;
    t.programName = `${file.name}  release ${release}`;
    const h4 = (v) => `0x${v.toString(16).toUpperCase().padStart(4, '0')}`;
    fbSetStatus(
      `Loaded ${file.name} [${origin}] release ${release}${gs20ProgramHasReadPatch(image) ? ', read patch present' : ', stock'}` +
        (stored === checksum
          ? ', checksum already correct'
          : `, checksum corrected ${h4(stored)} -> ${h4(checksum)}`)
    );
    await fbTcuPairCalibrationWithProgram(release);
  } catch (e) {
    t.program = null;
    fbSetStatus(`Could not load that program: ${e.message}`);
    await fbMessage(fbDescribeError(e), 'Load Program');
  } finally {
    fbRefreshAll();
  }
}

/**
 * After a program is loaded: a program of another release than the
 * transmission runs needs a calibration of its own release written after it;
 * for the same release the calibration is offered as an option.
 * @param {string} release - The program's release.
 */
async function fbTcuPairCalibrationWithProgram(release) {
  const t = fbState.tcu;
  const reported = (t.identSw || '').trim().replace(/^0+(?=\d)/, '');
  const required = release !== reported;
  const loadedRelease = t.cal ? gs20Checksum.release(t.cal) : null;
  if (t.cal && (!required || loadedRelease === release)) return;
  for (;;) {
    const pick = required
      ? await fbConfirm(
          `This program is release ${release}; the transmission reports ${reported ? `software ${reported}` : 'no software (boot block only)'}.\n\n` +
            'A transmission only accepts a program together with a calibration of the same release (with a different one it reports a program/data mismatch and does not run), ' +
            `so a release-${release} calibration is written straight after this program.\n\nChoose it now: a matching .0DA from SP-Daten, or a tune built on one.`,
          'Program needs a matching calibration'
        )
      : await fbConfirm(
          'Also write a calibration after this program?\n\nOptional: without one the calibration on the transmission stays as it is. A .0DA from SP-Daten or a 64 KB tune can be chosen.',
          'Add a calibration'
        );
    if (!pick) {
      if (!required) return;
      t.program = null;
      t.programName = '';
      fbTcuRefresh();
      fbSetStatus(
        `Program not loaded: it needs a release-${release} calibration`
      );
      return;
    }
    const file = await fbPickFile('.bin,.0DA,.0da');
    if (!file) {
      if (!required) return;
      continue;
    }
    if (!(await fbTcuLoadCalibration(file, true))) {
      if (!required) return;
      continue;
    }
    const chosen = gs20Checksum.release(t.cal);
    if (required && chosen !== release) {
      await fbMessage(
        `That calibration is release ${chosen || 'unknown'}; the program is release ${release}. It would leave the transmission with a program/data mismatch. Choose a release-${release} calibration.`,
        'Calibration does not match the program'
      );
      t.cal = null;
      t.calName = '';
      fbTcuRefresh();
      continue;
    }
    return;
  }
}

async function fbTcuInstallReadPatch() {
  const t = fbState.tcu;
  const reported = (t.identSw || '').trim().replace(/^0+(?=\d)/, '');
  const part = (t.identBmw || '').trim();
  if (reported !== '90' || !part.includes('7552700')) {
    await fbMessage(
      `The read patch is built for program 7552700, software release 90 (G2210_0090C0). This transmission reports ${fbTcuDescribeSoftware()}.\n\n` +
        "On any other release the patch's hook lands inside a different instruction and the module will not run, so it is not offered here. Update the transmission to 7552700 first.",
      'Install Read Patch'
    );
    return;
  }
  let program;
  try {
    const res = await fetch('data/gs20_7552700_readpatch_program.bin');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    program = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    await fbMessage(
      `The built-in program could not be loaded: ${e.message}`,
      'Install Read Patch'
    );
    return;
  }
  if (
    program.length !== GS20_PROGRAM_LENGTH ||
    !gs20ProgramHasReadPatch(program) ||
    !gs20ProgramChecksum.verify(program)
  ) {
    await fbMessage(
      'The built-in program failed its own checks, so it is not being written.',
      'Install Read Patch'
    );
    return;
  }
  t.program = program;
  t.programName = 'Built-in 7552700 read-patch program  release 90';
  fbSetStatus('Built-in 7552700 read-patch program loaded');
  fbTcuRefresh();
  await fbTcuWriteProgram();
}

async function fbTcuWriteProgram() {
  const t = fbState.tcu;
  if (!t.program) {
    fbSetStatus('Load a program first');
    return;
  }
  const release = gs20ProgramRelease(t.program);
  const reported = (t.identSw || '').trim().replace(/^0+(?=\d)/, '');
  const releaseChanges = release !== reported;
  const calibrationFollows = !!t.cal;
  if (releaseChanges) {
    const calRelease = t.cal ? gs20Checksum.release(t.cal) : null;
    if (!release || !calRelease || calRelease !== release) {
      fbSetStatus(
        `Write cancelled: a calibration of release ${release || '?'} must be loaded first`
      );
      await fbMessage(
        `This program is release ${release || 'unknown'}; the transmission reports ${reported ? `software ${reported}` : 'no software (boot block only)'}.\n\n` +
          'A transmission only accepts a program together with a calibration of the same release: with a different one in place it reports a program/data mismatch (flash status 0E) and does not run.\n\n' +
          `Load a release-${release || '?'} calibration (a matching .0DA from SP-Daten, or a tune built on one) with Load Calibration File, then Write Program again: the program is written first and that calibration straight after it.` +
          (t.cal
            ? `\n\nThe calibration loaded now is ${gs20Checksum.version(t.cal) || 'of unknown version'}, which is release ${calRelease || 'unknown'}.`
            : ''),
        'Program needs a matching calibration'
      );
      return;
    }
  }
  if (
    !(await fbConfirm(
      'This will overwrite the program' +
        (calibrationFollows
          ? releaseChanges
            ? ` (release ${release}, replacing ${reported ? `software ${reported}` : 'an unknown release'}) and then write the loaded release-${release} calibration, which the transmission requires to accept the new program.`
            : ` and then write the loaded calibration (${gs20Checksum.version(t.cal) || 'unknown version'}).`
          : '.') +
        ' Keep the engine off with a charger on, and do not switch off or unplug until it reports done.\n\nProceed?',
      'Write Program'
    ))
  ) {
    return;
  }
  if (!(await fbProgrammingCounter(true))) return;

  let erased = 0;
  fbFlashingBar(true);
  await fbSessionStart('tcu-program-write', { module: 'GS20' });
  try {
    const image = t.program;
    flashLog.attach('tcu_program_0x0A0000.bin', image);
    flashLog.note(
      `TCU gs20 / ident ${fbTcuDescribeSoftware()} / program release ${release} / checksum 0x${gs20ProgramChecksum.stored(image).toString(16).toUpperCase().padStart(4, '0')}` +
        (gs20ProgramHasReadPatch(image) ? ' / read patch present' : ' / stock')
    );
    // the calibration goes in the same session straight after the program:
    // one programming operation, confirmed and counted once, no question
    // asked while the transmission holds a program it cannot run yet
    let calImage = null;
    if (calibrationFollows) {
      calImage = t.noUpshift ? gs20NoUpshift.apply(t.cal) : t.cal;
      if (calImage !== t.cal) flashLog.note('auto upshift removed');
      flashLog.attach('tcu_calibration_0x090000.bin', calImage);
      flashLog.note(
        `calibration ${gs20Checksum.version(t.cal) || 'unknown version'} / checksum 0x${gs20Checksum.stored(t.cal).toString(16).toUpperCase().padStart(4, '0')} follows the program`
      );
    }
    const aifRecord = fbTcuAifRecord(image, calImage);
    try {
      const res = await gs20WriteProgram(image, {
        confirmed: true,
        fast: t.fast,
        calibration: calImage,
        aifRecord,
        onStage: (s) => {
          if (/^erasing, \d/.test(s) || /^writing program \d+%/.test(s)) {
            flashLog.note(s);
            fbSetStatusInPlace(s[0].toUpperCase() + s.slice(1));
          } else fbSetStage(s);
        },
        onTrace: (s) => flashLog.trace(s),
        onProgress: (p) => {
          fbProgress(p);
          if (calImage) fbSetStatusInPlace(`${p}%`);
        },
      });
      if (res.aif) t.aif.AIF_ANZ_FREI = String(res.aif.left);
      flashLog.note('RESULT: written and committed');
      if (calImage) {
        t.identSw = release;
        fbSetStatus('Calibration written. Cycle the ignition before driving.');
        await fbMessage(
          'The calibration was written and the transmission confirmed it.\n\nCycle the ignition, then check for stored faults before driving.',
          'Write Calibration'
        );
        return;
      }
      fbSetStatus('Program written. Cycle the ignition before driving.');
      await fbMessage(
        'The program was written and the transmission confirmed it.\n\nCycle the ignition, then check for stored faults before driving.',
        'Write Program'
      );
    } catch (e) {
      erased = (e && e.erasedSectors) || 0;
      if (e && e.programWritten) {
        // the program is on; it is the calibration write that failed, so the
        // calibration write's own words apply
        fbSetStatus(`Calibration write failed: ${e.message}`);
        const aftermath = e.calibrationEraseStarted
          ? '\n\nThe transmission may be holding an incomplete calibration. Its boot block and program are untouched, so it still answers and can be written again: fix the cause, then write a known-good calibration before driving.'
          : '\n\nNothing was erased or written, so the calibration on the transmission is unchanged.';
        await fbMessage(fbDescribeError(e) + aftermath, 'Write Calibration');
        return;
      }
      fbSetStatus(`Program write failed: ${e.message}`);
      const aftermath =
        erased === 0
          ? '\n\nNothing was erased or written, so the program on the transmission is unchanged.'
          : `\n\n${erased} of 4 program sectors were erased before this failed.`;
      await fbMessage(fbDescribeError(e) + aftermath, 'Write Program');
    }
  } finally {
    fbFlashingBar(false);
    fbProgress(0);
    if (flashLog.isActive) await fbSessionStop();
  }
}
