// Flashing/Tuning: the DME (MS45) side -- its panel, its state, Identify and
// what Identify reads off the car, Read DME. The rest of the DME's screen is
// beside this file, one concern each: dme-files.js (loading files and the
// immobilizer checks around every load), dme-flash.js (Flash Tune, Flash
// Program, Finish Programming) and dme-fast.js (the resident fast flasher).
// They share one scope; every write asks before it starts and logs
// everything it does to a session (History).
/* exported fbDmeFreshState, fbDmePanelHtml, fbDmeWire, fbDmeReset, fbDmeRefresh, fbDmeIdentify, fbDmeIsMs451, fbDmeReadProtocol, fbDmeGuard, fbDmeReadCarCalibration */

/** @returns {Object} A fresh DME state. */
function fbDmeFreshState() {
  return {
    identified: false,
    ident: {
      vin: '',
      hwRef: '',
      swRef: '',
      progRef: '',
      programmingStatus: '',
      diagProtocol: '',
      type: '',
    },
    aif: {},
    fullBin: false,
    flash: null,
    mpc: null,
    flashName: '',
    mpcName: '',
    /** '0PA' | '0DA' | null when the loaded files are raw binaries. */
    exchangeKind: null,
    exchangeTuneLoaded: false,
    ews: false,
    /** The spark cut and engine protection to flash: undefined = as loaded, null = none, else the config. */
    protect: undefined,
    carProgramEwsDeleted: null,
    carTuneEwsDeleted: null,
    carMapSwitch: null,
    /** 'blocks' (several maps as blocks) or 'copy' (an earlier build's full copy of map 2). */
    carMapLayout: null,
    /** Maps stored on the car, map 1 included; null when none besides map 1. */
    carMapCount: null,
    /** The rev limit the car's own limiter works to, rpm, or null when not read. */
    carRevLimit: null,
    /** What else the MPC's free area was recognised as when it is not the map switch: 'livetune', or null. */
    carProgramKind: null,
    /** The resident fast flasher's detection (core/flash/fast-flasher.js), or null when its stamp is absent. */
    fastFlasher: null,
  };
}

/** @returns {string} The DME panel's markup. */
function fbDmePanelHtml() {
  return `
    <div class="fb-panel" id="fb-dme-panel" hidden>
      <button class="btn fb-wide" id="fb-dme-read" disabled>Read DME</button>
      <button class="btn fb-wide" id="fb-dme-read-maps" hidden title="Reads map 1 and map 2 from the car and saves each as a tune file.">Read Installed Maps</button>
      <button class="btn fb-wide" id="fb-dme-load1" disabled>Load File / .0da</button>
      <div class="fb-mono fb-faint fb-name" id="fb-dme-name1" hidden></div>
      <div class="fb-pill" id="fb-dme-exchange" hidden><span id="fb-dme-exchange-text"></span><button class="fb-x" id="fb-dme-exchange-remove" title="Remove the loaded file.">&#x2715;</button></div>
      <button class="btn fb-wide" id="fb-dme-load2" disabled hidden>Load File 2 (MPC Flash)</button>
      <div class="fb-mono fb-faint fb-name" id="fb-dme-name2" hidden></div>
      <div class="fb-pill" id="fb-dme-tune" hidden><span id="fb-dme-tune-text"></span><button class="fb-x" id="fb-dme-tune-remove" title="Remove the tune. The tune on the car is then left as it is.">&#x2715;</button></div>
      <button class="btn danger fb-wide" id="fb-dme-flash-program" disabled hidden>Flash Program</button>
      <button class="btn danger fb-wide" id="fb-dme-flash-tune" disabled>Flash Tune</button>
      <label class="fb-check"><input type="checkbox" id="fb-dme-fullbin" disabled> Full Binary</label>
    </div>`;
}

function fbDmeWire() {
  // with the fast flasher wanted and one on the DME that reads, Read DME
  // reads through it (the same files, at the line's rate)
  fbEls['dme-read'].onclick = () =>
    fbDmeGuard('Read DME', () =>
      fbDmeUseFastFlasher(false) && fbState.dme.fastFlasher.reads
        ? fbDmeFastRead()
        : fbDmeRead()
    );
  fbEls['dme-read-maps'].onclick = () =>
    fbDmeGuard('Read Installed Maps', fbDmeReadInstalledMaps);
  fbEls['dme-load1'].onclick = () => fbDmeLoadFile1();
  fbEls['dme-load2'].onclick = () => fbDmeLoadFile2();
  fbEls['dme-exchange-remove'].onclick = () => {
    fbDmeClearExchangeFile(true);
    fbOptionsRefreshEwsGate();
  };
  fbEls['dme-tune-remove'].onclick = () => {
    fbDmeRemovePairedTune();
    fbOptionsRefreshEwsGate();
    fbSetStatus('Removed the tune. The tune on the car will be left as it is.');
  };
  // with "Use the fast flasher" on and a ready flasher on the DME, the two
  // write buttons go through it; otherwise through the stock loader
  fbEls['dme-flash-tune'].onclick = () =>
    fbDmeGuard('Flash Tune', () =>
      fbDmeUseFastFlasher(false) ? fbDmeFastFlashTune() : fbDmeFlashTune()
    );
  fbEls['dme-flash-program'].onclick = () =>
    fbDmeGuard('Flash Program', () =>
      fbDmeUseFastFlasher(true) ? fbDmeFastFlashProgram() : fbDmeFlashProgram()
    );
  fbEls['dme-fullbin'].onchange = () => fbDmeFullBinChanged();
}

/**
 * Whether a write button goes through the resident fast flasher: the
 * setting is on, identify found a flasher it can use (for the program push
 * an outdated body that can carry its own upgrade counts) and the cable can
 * hold the break the entry needs. Anything else uses the stock loader.
 * @param {boolean} program - Flash Program (true) or Flash Tune.
 * @returns {boolean}
 */
function fbDmeUseFastFlasher(program) {
  const f = fbState.dme.fastFlasher;
  if (!fbFastFlasherWanted() || !f) return false;
  if (!(f.ready || (program && f.upgradable))) return false;
  const breakLine =
    typeof webBus !== 'undefined' && webBus.port && !!webBus.port.setSignals;
  if (!breakLine)
    flashLog.note(
      'Fast flasher on the DME, but this cable cannot hold the break line: using the stock loader'
    );
  return breakLine;
}

function fbDmeReset() {
  const keepSettings = fbState.dme;
  fbState.dme = fbDmeFreshState();
  if (keepSettings) fbState.dme.fullBin = false;
  if (fbEls['dme-fullbin']) fbEls['dme-fullbin'].checked = false;
}

/** Every DME control's visibility and enabled state, from the state. */
function fbDmeRefresh() {
  const d = fbState.dme;
  if (!d || !fbEls['dme-panel']) return;
  const dev = fbDevUi();
  const full = d.fullBin;
  const canLoad = d.identified || dev;
  fbEls['dme-read'].disabled = !d.identified;
  fbEls['dme-read-maps'].hidden = !(
    d.carMapSwitch === 'current' || d.carMapSwitch === 'earlier'
  );
  fbEls['dme-fullbin'].disabled = !canLoad;
  fbEls['dme-load1'].disabled = !canLoad || d.exchangeKind != null;
  // with full reads kept as one file (Settings), the one file is the whole
  // program: no separate MPC to load (a .0pa still takes its .0da there)
  const oneFile = full && fbDmeFullOneFile() && d.exchangeKind !== '0PA';
  fbEls['dme-load1'].textContent = !full
    ? 'Load File / .0da'
    : oneFile
      ? 'Load full program'
      : 'Load External / .0pa';
  fbEls['dme-load2'].hidden = !full || oneFile;
  fbEls['dme-load2'].disabled =
    !canLoad ||
    (d.exchangeKind === '0PA' ? d.exchangeTuneLoaded : d.exchangeKind != null);
  fbEls['dme-load2'].textContent =
    d.exchangeKind === '0PA'
      ? 'Load .0da (optional)'
      : full
        ? 'Load MPC'
        : 'Load File 2 (MPC Flash)';
  fbEls['dme-flash-program'].hidden = !full;
  fbEls['dme-flash-tune'].hidden = full;
  const noTune = d.exchangeKind === '0PA' && !d.exchangeTuneLoaded;
  fbEls['dme-flash-tune'].disabled = !(
    d.identified &&
    d.flash &&
    !noTune &&
    (full ? d.mpc : true)
  );
  fbEls['dme-flash-program'].disabled = !(
    d.identified &&
    full &&
    d.flash &&
    d.mpc
  );
  const raw = d.exchangeKind == null;
  fbEls['dme-name1'].hidden = !(raw && d.flash && d.flashName);
  fbEls['dme-name1'].textContent = d.flashName || '';
  fbEls['dme-name2'].hidden = !(
    raw &&
    full &&
    d.mpc &&
    d.mpcName &&
    d.mpcName !== d.flashName
  );
  fbEls['dme-name2'].textContent = d.mpcName || '';
  fbEls['dme-exchange'].hidden = d.exchangeKind == null;
  fbEls['dme-tune'].hidden = !d.exchangeTuneLoaded;
}

/**
 * Run a DME action with the cable checked, the screen busy and errors shown.
 * @param {string} title - The dialog title.
 * @param {() => Promise<void>} fn - The action.
 */
async function fbDmeGuard(title, fn) {
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

// ---- identify ------------------------------------------------------------------------------------------
/**
 * Read the DME's identity, its AIF entry, its immobilizer state and whether
 * it carries the map switch.
 * @param {boolean} [afterFlash] - True right after a flash: the status line is left to the flash.
 * @returns {Promise<void>}
 */
async function fbDmeIdentify(afterFlash = false) {
  if (!afterFlash) return fbDmeIdentifyRun(false);
  // after a flash the flash's result owns the status line, so the identify
  // that follows is shown there only while it runs (the bar sweeping), then
  // the result comes back -- without this the screen looked hung
  const result = fbEls.status ? fbEls.status.textContent : '';
  if (fbEls.status)
    fbEls.status.textContent = `${result ? `${result} -- ` : ''}identifying the DME…`;
  if (fbEls.fill) fbEls.fill.classList.add('indeterminate');
  try {
    return await fbDmeIdentifyRun(true);
  } finally {
    if (fbEls.fill) fbEls.fill.classList.remove('indeterminate');
    if (
      fbEls.status &&
      fbEls.status.textContent.endsWith('identifying the DME…')
    )
      fbEls.status.textContent = result;
  }
}

/** @param {boolean} afterFlash */
async function fbDmeIdentifyRun(afterFlash) {
  const d = fbState.dme;
  // the line rate goes up once the DME answers and stays up through the
  // car reads below (fbDmeReadCar lowers it); a DME that never answered
  // was never raised
  const ident = await ms45Identify({ raise: true });
  d.ident = ident;
  d.aif = ident.aif || {};
  // after a flash the coding data has just been printed and the flash's own
  // result owns the status line: the re-identify says what changed, once
  if (!afterFlash) {
    fbDmeLogAif(d.aif);
    if (ident.programmingStatus)
      fbSetStatus(
        `Programming status: ${fbDmeProgrammingStatus(ident.programmingStatus)}`
      );
  }
  if (!ident.answered) {
    if (ident.baud > 9600) await ms45DefaultBaud();
    // a fast flash cut short leaves the flasher running in the DME's RAM,
    // where it answers HELLO and nothing of KWP: that is an identified DME
    // whose push can be resumed, not a silent one
    // (not gated on the live flag: an incognito window closed in between
    // loses it, the flasher in the DME does not)
    if (await fbDmeIdentifyThroughFlasher()) return;
    d.identified = false;
    fbSetStatus('No response from the DME');
    await fbMessage(
      'The port opened, but the DME did not respond.\n\nCheck that:\n• ignition is on (position 2 / KL15)\n• the OBD cable is fully seated at both ends\n• this is a K+DCAN cable\n• the battery voltage is healthy',
      'Identify DME'
    );
    return;
  }
  d.identified = ident.type !== 'Unknown / Unsupported';
  fbSetEcuBox(`${ident.type}  ${ident.hwRef}  ·  ${ident.vin}`);
  if (!ident.diagProtocol)
    fbLog(
      `Diagnostic protocol not read (${ident.diagProblem || 'no answer'}); a read will unlock the DME as for KWP2000`
    );
  await fbDmeReadCar();
  // the wire parameters identify ended on (back at 9600), kept for the raw
  // telegrams the fast flasher's entry sends after the session is gone
  if (typeof sessionFor === 'function')
    d.wire = sessionFor(MS45_SGBD).comm || d.wire || null;
  if (afterFlash)
    fbLog(
      `Identified again: ${fbDmeProgrammingStatus(ident.programmingStatus) || 'status not read'}` +
        `${ident.progRef ? `, program ${ident.progRef}` : ''}` +
        `${d.fastFlasher ? `, ${fastFlasher.describe(d.fastFlasher).replace(/^Fast flasher /, 'fast flasher ')}` : ''}`
    );
  else if (d.fastFlasher) fbLog(fastFlasher.describe(d.fastFlasher));
  fbRefreshAll();
  fbOptionsRefreshEwsGate();
  fbOptionsRefreshAifGate();
  const summary = fbDmeImmobilizerSummary() + fbDmeMapSwitchSummary();
  const carRead = d.carProgramEwsDeleted !== null || d.carMapSwitch !== null;
  // after a flash the flash's own result stays up
  if (!afterFlash && carRead) fbSetStatus(summary);
  if (!d.identified)
    await fbMessage(
      `This DME (${ident.hwRef || 'no hardware reference'}) is not an MS45.0 / MS45.1, so the flashing tools stay shut.`,
      'Identify DME'
    );
}

/**
 * Identify a DME whose fast flasher is running (a push cut short): ask it
 * for HELLO at every rate it could be holding and take its stamp as the
 * detection. The KWP identity is not readable there, so the last one this
 * screen saw stands in, marked as such; Fast Flash Program then reconnects
 * and finishes the push.
 * @returns {Promise<boolean>} Whether the flasher answered.
 */
async function fbDmeIdentifyThroughFlasher() {
  const d = fbState.dme;
  let claim = null;
  let link = null;
  try {
    claim = await webClaimBus('Identify');
    // each HELLO ask at each rate goes to the session log, not the screen
    link = fastFlashWire.webLink(webBus, { onStep: (s) => flashLog.note(s) });
    const stamp = await link.resume();
    if (String.fromCharCode(...stamp.subarray(0, 6)) !== 'MS45QF') return false;
    const gate =
      ((stamp[8] << 24) | (stamp[9] << 16) | (stamp[10] << 8) | stamp[11]) >>>
      0;
    const hookWord = (0x48000002 | (gate & 0x03fffffc)) >>> 0; // `ba gate`
    d.fastFlasher = fastFlasher.parseDetection(
      Uint8Array.from([
        hookWord >>> 24,
        (hookWord >>> 16) & 255,
        (hookWord >>> 8) & 255,
        hookWord & 255,
      ]),
      stamp
    );
    d.identified = true;
    d.ident = {
      ...d.ident,
      answered: true,
      type: 'MS45.1',
      hwRef: d.ident.hwRef || '0044570',
      vin: d.ident.vin || '',
      progRef: d.ident.progRef || '',
      inFlasher: true,
    };
    fbSetEcuBox(`MS45.1  ${d.ident.hwRef}  ·  in the fast flasher`);
    fbLog(
      `The DME is in its fast flasher (${fastFlasher.describe(d.fastFlasher)}): a push cut short can be finished -- load the same files and run the same fast flash; it reconnects. Nothing of KWP answers until a flash completes or the ignition is cycled.`
    );
    fbSetStatus(
      'The DME is in its fast flasher: run the same fast flash to finish'
    );
    fbRefreshAll();
    return true;
  } catch (e) {
    fbLog(`No fast flasher answered either (${e.message})`);
    return false;
  } finally {
    if (link) {
      try {
        await link.leave();
      } catch (e) {
        /* the port is reset by the next job */
      }
    }
    if (claim) claim.release();
  }
}

/** Whether the identified DME is the MS45.1 (hardware reference 0044570), the one every patch here is built for. */
function fbDmeIsMs451() {
  const d = fbState.dme;
  return !!(d && d.ident && d.ident.hwRef === '0044570');
}

/** The DME's programming status texts (the SGBD's own are German). */
const FB_DME_PROGRAMMING_STATUS = {
  Anlieferzustand: 'As delivered',
  Normalbetrieb: 'Normal operation',
  'nicht benutzt': 'Not used',
  'Speicher gelöscht': 'Memory erased',
  'Signaturprüfung PAF nicht durchgeführt': 'Program signature not checked',
  'Signaturprüfung DAF nicht durchgeführt': 'Data signature not checked',
  'Programmprogrammiersitzung aktiv': 'Program programming session active',
  'Datenprogrammiersitzung aktiv': 'Data programming session active',
  'Hardwarereferenzeintrag fehlerhaft': 'Hardware reference entry faulty',
  'Programmreferenzeintrag fehlerhaft': 'Program reference entry faulty',
  'Referenzierungsfehler Hardware -> Programm':
    'Hardware and program references do not match',
  'Programm nicht vorhanden oder nicht vollständig':
    'Program missing or incomplete',
  'Datenreferenzeintrag fehlerhaft': 'Data reference entry faulty',
  'Referenzierungsfehler Programm -> Daten':
    'Program and data references do not match',
  'Daten nicht vorhanden oder nicht vollständig': 'Data missing or incomplete',
  'Reserviert fuer BMW': 'Reserved for BMW',
  'Reserviert fuer Zulieferer': 'Reserved for the supplier',
  'unbekannter Programmierstatus': 'Unknown programming status',
};

/**
 * A programming status in English; one the list does not know is shown as
 * the DME's SGBD gave it.
 * @param {string} text - FLASH_PROGRAMMIER_STATUS_TEXT.
 * @returns {string}
 */
function fbDmeProgrammingStatus(text) {
  return FB_DME_PROGRAMMING_STATUS[String(text).trim()] || text;
}

/** True while identify's reads run at the raised line rate. */
let fbDmeFastReads = false;

/**
 * The protocol identify's memory reads go by. At the raised rate a short
 * read must not go on to ask for security access (that has a rate change of
 * its own), so the reads are told the protocol that never asks.
 * @returns {string}
 */
function fbDmeReadProtocol() {
  return fbDmeFastReads ? 'BMW-FAST' : fbState.dme.ident.diagProtocol;
}

/**
 * What identify reads out of the car's memory: the immobilizer state, the
 * map switch, the rev limit. Recognising the map switch alone is 3 KB of
 * the MPC, most of identify's time at 9600 baud, so on the program these
 * reads apply to the line rate goes up for them (ms45RaiseBaud) and back
 * down after. If the fast pass could not read, they run again the slow way.
 * @returns {Promise<void>}
 */
async function fbDmeReadCar() {
  const d = fbState.dme;
  const reads = async () => {
    await fbDmeReadCarImmobilizer();
    await fbDmeReadCarMapSwitch();
    await fbDmeReadCarRevLimit();
    await fbDmeReadCarResetRecord();
    await fbDmeReadCarFastFlasher();
    await fbAifEdReadLoader();
  };
  // identify may have left the session at the cable's rate already
  let baud = d.ident.baud || 9600;
  const worthIt =
    baud === 9600 &&
    fbDmeIsMs451() &&
    (d.ident.progRef || '').includes(mapSwitch.SUPPORTED_PROGRAM_VERSION) &&
    typeof ms45RaiseBaud === 'function';
  if (worthIt) {
    try {
      baud = await ms45RaiseBaud();
    } catch (e) {
      baud = 9600;
    }
  }
  if (baud === 9600) return reads();
  fbDmeFastReads = true;
  try {
    await reads();
  } finally {
    fbDmeFastReads = false;
    await ms45DefaultBaud();
  }
  // nothing came back at speed: as it was always done
  if (d.carMapSwitch === null && d.carProgramEwsDeleted === null) await reads();
}

/**
 * The resident fast flasher's KWP-visible trace, read on identify's session:
 * the reset word at MPC 0x8 and the stamp at ext 0xFD26C. Testing-only like
 * the rest of the flasher work: off localhost nothing is read and nothing
 * downstream can send to it (fastFlasher.assertReady refuses a null).
 * @returns {Promise<void>}
 */
async function fbDmeReadCarFastFlasher() {
  const d = fbState.dme;
  d.fastFlasher = null;
  // identify got answers from the DME's own program: no flasher is running
  if (d.identified) fbDmeSetFastLive(false);
  if (!fbProtectTesting()) return;
  if (!fbDmeIsMs451()) return;
  try {
    const stamp = await ms45ReadCarBytes(
      fastFlasher.STAMP_AT,
      fastFlasher.STAMP_AT + fastFlasher.STAMP_LENGTH - 1,
      'ROMX',
      fbDmeReadProtocol()
    );
    // no stamp, no second read: a stock DME costs identify one telegram
    if (!stamp || stamp[0] === 0xff) return;
    const hook = await ms45ReadCarBytes(
      fastFlasher.HOOK_AT,
      fastFlasher.HOOK_AT + 3,
      'LAR',
      fbDmeReadProtocol()
    );
    d.fastFlasher = fastFlasher.parseDetection(hook, stamp);
    // a DME that carries the flasher keeps it: the program flash re-adds
    // it unless Custom Options' tick was taken off (installFastSet)
    if (d.fastFlasher && d.fastFlasher.hooked && !d.installFastSet)
      d.installFast = true;
    // the gate only runs once the loader accepts the program and jumps
    // through MPC 0x8: a DME left in its loader (an interrupted flash) has
    // the stamp and the hook but no way into the flasher until a full flash
    // completes -- and that full flash must stay possible from here
    const status = d.ident.programmingStatus;
    if (d.fastFlasher && status && status !== 'Normalbetrieb') {
      d.fastFlasher.ready = false;
      d.fastFlasher.upgradable = false;
      d.fastFlasher.notRunning = fbDmeProgrammingStatus(status);
    }
  } catch (e) {
    d.fastFlasher = null;
  }
}

function fbDmeLogAif(aif) {
  if (!aif || !Object.keys(aif).length) {
    fbLog('Coding data: the programming record (AIF) was not answered');
    return;
  }
  const f = (k) => aif[k] || '';
  const vin = f('AIF_FG_NR_LANG') || f('AIF_FG_NR');
  fbLog(
    `Coding data: VIN ${vin || '-'} · date ${f('AIF_DATUM') || '-'}${f('AIF_AENDERUNGS_INDEX') ? ` · index ${f('AIF_AENDERUNGS_INDEX')}` : ''}`
  );
  fbLog(
    `    software ${f('AIF_SW_NR') || '-'} · assembly ${f('AIF_ZB_NR') || '-'} · official ${f('AIF_BEHOERDEN_NR') || '-'}`
  );
  const extra = [];
  if (f('AIF_PROG_NR')) extra.push(`program ${f('AIF_PROG_NR')}`);
  if (f('AIF_HAENDLER_NR') && f('AIF_HAENDLER_NR') !== '0')
    extra.push(`dealer ${f('AIF_HAENDLER_NR')}`);
  if (f('AIF_KM')) extra.push(`${f('AIF_KM')} km`);
  const free = parseInt(f('AIF_ANZ_FREI'), 10);
  if (Number.isFinite(free))
    extra.push(`${free} of ${FB_AIF_SLOTS} entries free`);
  if (extra.length) fbLog(`    ${extra.join(' · ')}`);
}

/**
 * The live-tune program's overlay lives in the same MPC tail the map-switch
 * detector reads (its code from 0x6E904, inside the free area that starts at
 * 0x6E550), and its scan subroutine opens with the magic gate
 * `cmplwi r0, 0x6c69` ("li"). That word in that window is what tells a
 * live-tune build from a modification nobody here knows.
 * @param {Uint8Array} free - The free area as read so far.
 * @param {number} read - How many bytes of it are valid.
 * @returns {boolean}
 */
function fbDmeLooksLikeLiveTune(free, read) {
  const from = 0x6e904 - mapSwitch.CAR_CHECK_OFFSET;
  const to = from + 0x40;
  if (read < to) return false;
  for (let at = from; at + 4 <= to; at += 4)
    if (
      free[at] === 0x28 &&
      free[at + 1] === 0x00 &&
      free[at + 2] === 0x6c &&
      free[at + 3] === 0x69
    )
      return true;
  return false;
}

/** The program's and the tune's immobilizer halves on the car, read on identify's session. */
async function fbDmeReadCarImmobilizer() {
  const d = fbState.dme;
  d.carProgramEwsDeleted = null;
  d.carTuneEwsDeleted = null;
  if (
    !fbDmeIsMs451() ||
    !(d.ident.progRef || '').includes(ewsDelete.SUPPORTED_PROGRAM_VERSION)
  )
    return;
  try {
    const program = await ms45ReadCarBytes(
      ewsDelete.PROGRAM_STATE_OFFSET,
      ewsDelete.PROGRAM_MASK_OFFSET,
      'ROMX',
      fbDmeReadProtocol()
    );
    const tune = await ms45ReadCarBytes(
      ewsDelete.CAL_FLAG2_OFFSET,
      ewsDelete.CAL_FLAG3_OFFSET,
      'ROMX',
      fbDmeReadProtocol()
    );
    if (program)
      d.carProgramEwsDeleted = ewsDelete.programBytesAreDeleted(
        program[0],
        program[program.length - 1]
      );
    if (tune) {
      const a = tune[0];
      const b = tune[tune.length - 1];
      if (a === 0x00 && b === 0x00) d.carTuneEwsDeleted = true;
      else if (a === 0x10 && b === 0x10) d.carTuneEwsDeleted = false;
    }
  } catch (e) {
    d.carProgramEwsDeleted = null;
    d.carTuneEwsDeleted = null;
  }
}

/** The MPC's free area, and how many maps are stored when the map switch is there. */
async function fbDmeReadCarMapSwitch() {
  const d = fbState.dme;
  d.carMapSwitch = null;
  d.carMapLayout = null;
  d.carMapCount = null;
  d.carTrigger = null;
  d.carPresses = null;
  d.carProgramKind = null;
  if (
    !fbDmeIsMs451() ||
    !(d.ident.progRef || '').includes(mapSwitch.SUPPORTED_PROGRAM_VERSION)
  )
    return;
  try {
    // the free area in pieces, stopping as soon as what has been read
    // settles what is installed: all of it is 3 KB, and a build that is not
    // one of the known ones shows itself in the first few hundred bytes
    const piece = 254; // one memory read
    const free = new Uint8Array(mapSwitch.CAR_CHECK_LENGTH);
    let s = null;
    let read = 0;
    for (let at = 0; at < free.length && !s; at += piece) {
      const end = Math.min(free.length, at + piece);
      const part = await ms45ReadCarBytes(
        mapSwitch.CAR_CHECK_OFFSET + at,
        mapSwitch.CAR_CHECK_OFFSET + end - 1,
        'LAR',
        fbDmeReadProtocol()
      );
      if (!part) return;
      free.set(part, at);
      read = end;
      s = mapSwitch.stateFromStart(free.subarray(0, end));
    }
    if (!s) return;
    d.carMapSwitch = s.state;
    if (s.state === 'unrecognised' && fbDmeLooksLikeLiveTune(free, read))
      d.carProgramKind = 'livetune';
    d.carTrigger = s.trigger;
    d.carPresses = s.presses;
    d.carMapLayout = s.layout;
    if (s.state === 'current' || s.state === 'earlier') {
      if (s.layout === 'blocks' || s.layout === 'chunks') {
        const header = await ms45ReadCarBytes(
          mapSwitch.TABLES_OFFSET,
          mapSwitch.TABLES_OFFSET + 0x3f,
          'ROMX',
          fbDmeReadProtocol()
        );
        d.carMapCount = mapSwitch.mapCountFrom(header);
      } else {
        const field = await ms45ReadCarBytes(
          mapSwitch.MAP2_DATA_VERSION_OFFSET,
          mapSwitch.MAP2_DATA_VERSION_OFFSET +
            mapSwitch.DATA_VERSION_LENGTH -
            1,
          'ROMX',
          fbDmeReadProtocol()
        );
        d.carMapCount = mapSwitch.dataVersionFrom(field) ? 2 : null;
      }
    }
  } catch (e) {
    d.carMapSwitch = null;
  }
}

function fbDmeImmobilizerSummary() {
  const d = fbState.dme;
  if (d.carProgramEwsDeleted === true) {
    return d.carTuneEwsDeleted === false
      ? 'Identified, DME already EWS deleted, but its tune still has the immobilizer on'
      : 'Identified, DME already EWS deleted';
  }
  if (d.carProgramEwsDeleted === false) {
    return d.carTuneEwsDeleted === true
      ? 'Identified, DME not EWS deleted, but its tune has the immobilizer off'
      : 'Identified, DME not EWS deleted';
  }
  return 'Identified, EWS state not read';
}

/**
 * The rev limit the car's own limiter works to, from the limit tables of the
 * tune it is running, read on identify's session. These reads do not unlock
 * the DME: when one comes back short the limit is simply not known.
 */
async function fbDmeReadCarRevLimit() {
  const d = fbState.dme;
  d.carRevLimit = null;
  if (
    fbDmeIsMs451() &&
    (d.ident.progRef || '').includes(ms45Protect.SUPPORTED_PROGRAM_VERSION)
  ) {
    try {
      const byteAt = async (address) => {
        const b = await ms45ReadMemory(address, address, 'LAR');
        return b.length === 1 ? b[0] : null;
      };
      // with the map switch the limiter follows whichever map is selected
      let index = 0;
      if (d.carMapSwitch === 'current' || d.carMapSwitch === 'earlier')
        index = mapSwitch.selectedIndex(
          await byteAt(mapSwitch.RAM.flag),
          d.carMapLayout
        );
      const tables = await fbDmeReadCarCalibration(
        index,
        ms45Protect.LIMIT_TABLES_START - mapSwitch.CALIBRATION_START,
        ms45Protect.LIMIT_TABLES_END - mapSwitch.CALIBRATION_START
      );
      if (tables)
        d.carRevLimit = ms45Protect.stockLimit(
          tables,
          await byteAt(ms45Protect.RAM.transmission)
        );
    } catch (e) {
      d.carRevLimit = null;
    }
  }
  fbOptionsCarRevLimitRead();
}

/**
 * A DME that fails one of its own checks resets itself and stores no fault,
 * but keeps a count and the cause in RAM (core/ms45/ms45.js, ms45ReadResetRecord).
 * Read on identify's session; a reset ordered from outside (the monitoring
 * module's hardware line) leaves no record here.
 */
async function fbDmeReadCarResetRecord() {
  const d = fbState.dme;
  d.carResetRecord = null;
  if (
    !fbDmeIsMs451() ||
    !(d.ident.progRef || '').includes(ms45Protect.SUPPORTED_PROGRAM_VERSION)
  )
    return;
  const r = await ms45ReadResetRecord();
  if (!r) return;
  d.carResetRecord = r;
}

/**
 * Calibration bytes [calStart, calEnd] of the map at `index` (0 = map 1) as
 * the car holds them: from map 1, from an earlier build's full copy, or
 * block by block through the map's table. Null when a read comes back short.
 * @returns {Promise<Uint8Array|null>}
 */
async function fbDmeReadCarCalibration(index, calStart, calEnd) {
  const d = fbState.dme;
  const readRange = async (start, end) => {
    const data = await ms45ReadMemory(start, end, 'ROMX');
    return data.length === end - start + 1 ? data : null;
  };
  if (!index || d.carMapLayout === 'copy') {
    const shift = index
      ? mapSwitch.MAP2_START - mapSwitch.CALIBRATION_START
      : 0;
    return readRange(
      mapSwitch.CALIBRATION_START + shift + calStart,
      mapSwitch.CALIBRATION_START + shift + calEnd
    );
  }
  const area = await readRange(
    mapSwitch.TABLES_OFFSET,
    mapSwitch.TABLES_OFFSET + mapSwitch.tablesLength(d.carMapLayout) - 1
  );
  if (!area) return null;
  const out = new Uint8Array(calEnd - calStart + 1);
  const block = mapSwitch.pieceLength(area);
  for (let at = calStart; at <= calEnd;) {
    const pieceEnd = Math.min(calEnd, (Math.floor(at / block) + 1) * block - 1);
    const where = mapSwitch.locateFrom(area, index, at);
    const piece = await readRange(where, where + pieceEnd - at);
    if (!piece) return null;
    out.set(piece, at - calStart);
    at = pieceEnd + 1;
  }
  // the current layout keeps the single values a map changes beside their
  // load sites, not in the chunks
  const sites = mapSwitch.siteRangeFrom(area);
  if (sites) {
    const siteArea = await readRange(sites.start, sites.end - 1);
    if (!siteArea) return null;
    for (const v of mapSwitch.scalarsFrom(siteArea, index))
      for (let k = 0; k < v.data.length; k++) {
        const at = v.offset + k;
        if (at >= calStart && at <= calEnd) out[at - calStart] = v.data[k];
      }
  }
  return out;
}

function fbDmeMapSwitchSummary() {
  const d = fbState.dme;
  switch (d.carMapSwitch) {
    case 'notInstalled':
      return ', no map switch';
    case 'current':
    case 'earlier':
      return (
        `, map switch installed (${d.carTrigger ? mapSwitch.describeTrigger(d.carTrigger, d.carPresses || mapSwitch.DEFAULT_DSC_PRESSES) : 'unknown trigger'}` +
        `${d.carMapSwitch === 'earlier' ? ', earlier version)' : ')'}` +
        `${d.carMapCount == null ? ', no map 2 stored' : d.carMapCount > 2 ? `, ${d.carMapCount} maps` : ''}`
      );
    case 'unrecognised':
      return d.carProgramKind === 'livetune'
        ? ', custom program (live tune)'
        : ', MPC carries an unrecognised modification';
    default:
      return '';
  }
}

// ---- read ---------------------------------------------------------------------------------------------
async function fbDmeRead() {
  const d = fbState.dme;
  if (!d.identified) return;
  await fbSessionStart('read-dme', { vin: d.ident.vin, module: d.ident.hwRef });
  try {
    flashLog.note(
      `DME ${d.ident.hwRef} / prog ${d.ident.progRef} / diag ${d.ident.diagProtocol} / ${d.fullBin ? 'full' : 'tune'}`
    );
    const r = await fbFlashRun(
      'dme-read',
      {
        diagProtocol: d.ident.diagProtocol,
        full: !!d.fullBin,
        describe: d.fullBin
          ? 'DME full read: 1 MB external + 448 KB MPC'
          : 'DME tune read: the calibration',
        vin: d.ident.vin,
        hwRef: d.ident.hwRef,
      },
      {
        progress: (p) => {
          fbProgress(p);
          fbSetStatusInPlace(`${p}%`);
        },
      }
    );
    if (!r.ok) {
      fbSetStatus(r.status);
      return;
    }
    fbDmeSaveRead(r.flash, d.fullBin ? r.mpc : null);
    fbSetStatus(
      `Saved ${d.fullBin ? 'the full flash and MPC' : 'the tune'} (${r.flash.length} bytes)`
    );
  } finally {
    await fbSessionStop();
  }
}

async function fbDmeReadInstalledMaps() {
  const d = fbState.dme;
  if (!(d.carMapSwitch === 'current' || d.carMapSwitch === 'earlier')) return;
  await fbSessionStart('read-maps', {
    vin: d.ident.vin,
    module: d.ident.hwRef,
  });
  try {
    const r = await fbFlashRun(
      'dme-maps-read',
      {
        diagProtocol: d.ident.diagProtocol,
        layout: d.carMapLayout === 'copy' ? 'copy' : 'blocks',
        describe: `DME installed maps read (${d.carMapCount || '?'} maps)`,
        vin: d.ident.vin,
        hwRef: d.ident.hwRef,
      },
      {
        progress: (p) => {
          fbProgress(p);
          fbSetStatusInPlace(`${p}%`);
        },
      }
    );
    if (!r.ok) {
      fbSetStatus(r.status);
      return;
    }
    const name = `${d.ident.vin}_${d.ident.hwRef}`;
    fbSaveBytes(`${name}_map1.bin`, r.map1);
    r.maps.forEach((cal, i) => fbSaveBytes(`${name}_map${i + 2}.bin`, cal));
    const v1 = mapSwitch.readDataVersion(r.map1) || 'unknown data version';
    fbSetStatus(
      r.maps.length
        ? `Read map 1 (${v1}) and ${r.maps.length === 1 ? 'map 2' : `maps 2-${r.maps.length + 1}`} (${mapSwitch.readDataVersion(r.maps[0])})`
        : `Read map 1 (${v1}). No other map is stored on the car.`
    );
  } finally {
    await fbSessionStop();
  }
}
