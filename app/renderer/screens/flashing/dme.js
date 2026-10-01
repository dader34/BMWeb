// Flashing/Backups: the DME (MS45) side. Identify, Read DME, the files to
// flash (raw binaries or BMW's .0PA / .0DA), Flash Tune, Flash Program,
// Finish Programming, the immobilizer checks around every load, and the
// programming-log entry after a flash. Every write asks before it starts and
// logs everything it does to a session (History).
/* exported fbDmeFreshState, fbDmePanelHtml, fbDmeWire, fbDmeReset, fbDmeRefresh, fbDmeIdentify, fbDmeVerifyProgramming, fbDmeLoadBuiltPair, fbDmeMatchImmobilizer */

/** @returns {Object} A fresh DME state. */
function fbDmeFreshState() {
  return {
    identified: false,
    ident: { vin: '', hwRef: '', swRef: '', progRef: '', programmingStatus: '', diagProtocol: '', type: '' },
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
    carProgramEwsDeleted: null,
    carTuneEwsDeleted: null,
    carMapSwitch: null,
    carMap2Version: null,
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
  fbEls['dme-read'].onclick = () => fbDmeGuard('Read DME', fbDmeRead);
  fbEls['dme-read-maps'].onclick = () => fbDmeGuard('Read Installed Maps', fbDmeReadInstalledMaps);
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
  fbEls['dme-flash-tune'].onclick = () => fbDmeGuard('Flash Tune', fbDmeFlashTune);
  fbEls['dme-flash-program'].onclick = () => fbDmeGuard('Flash Program', fbDmeFlashProgram);
  fbEls['dme-fullbin'].onchange = () => fbDmeFullBinChanged();
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
  fbEls['dme-read-maps'].hidden = !(d.carMapSwitch === 'current' || d.carMapSwitch === 'earlier');
  fbEls['dme-fullbin'].disabled = !canLoad;
  fbEls['dme-load1'].disabled = !canLoad || d.exchangeKind != null;
  fbEls['dme-load1'].textContent = full ? 'Load External / .0pa' : 'Load File / .0da';
  fbEls['dme-load2'].hidden = !full;
  fbEls['dme-load2'].disabled = !canLoad || (d.exchangeKind === '0PA' ? d.exchangeTuneLoaded : d.exchangeKind != null);
  fbEls['dme-load2'].textContent = d.exchangeKind === '0PA' ? 'Load .0da (optional)' : full ? 'Load MPC' : 'Load File 2 (MPC Flash)';
  fbEls['dme-flash-program'].hidden = !full;
  fbEls['dme-flash-tune'].hidden = full;
  const noTune = d.exchangeKind === '0PA' && !d.exchangeTuneLoaded;
  fbEls['dme-flash-tune'].disabled = !(d.identified && d.flash && !noTune && (full ? d.mpc : true));
  fbEls['dme-flash-program'].disabled = !(d.identified && full && d.flash && d.mpc);
  const raw = d.exchangeKind == null;
  fbEls['dme-name1'].hidden = !(raw && d.flash && d.flashName);
  fbEls['dme-name1'].textContent = d.flashName || '';
  fbEls['dme-name2'].hidden = !(raw && full && d.mpc && d.mpcName);
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
  const d = fbState.dme;
  const ident = await ms45Identify();
  d.ident = ident;
  d.aif = ident.aif || {};
  fbDmeLogAif(d.aif);
  if (ident.programmingStatus) fbSetStatus(`Programming status: ${ident.programmingStatus}`);
  if (!ident.answered) {
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
  if (ident.diagProtocol) fbLog(`Diagnostic protocol: ${ident.diagProtocol}`);
  else fbLog(`Diagnostic protocol not read (${ident.diagProblem || 'no answer'}); a read will unlock the DME as for KWP2000`);
  await fbDmeReadCarImmobilizer();
  await fbDmeReadCarMapSwitch();
  fbRefreshAll();
  fbOptionsRefreshEwsGate();
  const summary = fbDmeImmobilizerSummary() + fbDmeMapSwitchSummary();
  if (!afterFlash) fbSetStatus(summary);
  if (!d.identified) await fbMessage(`This DME (${ident.hwRef || 'no hardware reference'}) is not an MS45.0 / MS45.1, so the flashing tools stay shut.`, 'Identify DME');
}

function fbDmeLogAif(aif) {
  if (!aif || !Object.keys(aif).length) {
    fbLog('Coding data: the programming record (AIF) was not answered');
    return;
  }
  const f = (k) => aif[k] || '';
  const vin = f('AIF_FG_NR_LANG') || f('AIF_FG_NR');
  fbLog(`Coding data: VIN ${vin || '-'} · date ${f('AIF_DATUM') || '-'}${f('AIF_AENDERUNGS_INDEX') ? ` · index ${f('AIF_AENDERUNGS_INDEX')}` : ''}`);
  fbLog(`    software ${f('AIF_SW_NR') || '-'} · assembly ${f('AIF_ZB_NR') || '-'} · official ${f('AIF_BEHOERDEN_NR') || '-'}`);
  const extra = [];
  if (f('AIF_PROG_NR')) extra.push(`program ${f('AIF_PROG_NR')}`);
  if (f('AIF_HAENDLER_NR') && f('AIF_HAENDLER_NR') !== '0') extra.push(`dealer ${f('AIF_HAENDLER_NR')}`);
  if (f('AIF_KM')) extra.push(`${f('AIF_KM')} km`);
  const free = parseInt(f('AIF_ANZ_FREI'), 10);
  if (Number.isFinite(free)) extra.push(`${free} of ${FB_AIF_SLOTS} entries free`);
  if (extra.length) fbLog(`    ${extra.join(' · ')}`);
}

/** The program's and the tune's immobilizer halves on the car, read on identify's session. */
async function fbDmeReadCarImmobilizer() {
  const d = fbState.dme;
  d.carProgramEwsDeleted = null;
  d.carTuneEwsDeleted = null;
  if (d.ident.hwRef !== '0044570' || !(d.ident.progRef || '').includes(ewsDelete.SUPPORTED_PROGRAM_VERSION)) return;
  try {
    const program = await ms45ReadCarBytes(ewsDelete.PROGRAM_STATE_OFFSET, ewsDelete.PROGRAM_MASK_OFFSET, 'ROMX', d.ident.diagProtocol);
    const tune = await ms45ReadCarBytes(ewsDelete.CAL_FLAG2_OFFSET, ewsDelete.CAL_FLAG3_OFFSET, 'ROMX', d.ident.diagProtocol);
    if (program) d.carProgramEwsDeleted = ewsDelete.programBytesAreDeleted(program[0], program[program.length - 1]);
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

/** The MPC's free area, and map 2's data version when the map switch is there. */
async function fbDmeReadCarMapSwitch() {
  const d = fbState.dme;
  d.carMapSwitch = null;
  d.carMap2Version = null;
  d.carTrigger = null;
  d.carPresses = null;
  if (d.ident.hwRef !== '0044570' || !(d.ident.progRef || '').includes(mapSwitch.SUPPORTED_PROGRAM_VERSION)) return;
  try {
    const free = await ms45ReadCarBytes(mapSwitch.CAR_CHECK_OFFSET, mapSwitch.CAR_CHECK_OFFSET + mapSwitch.CAR_CHECK_LENGTH - 1, 'LAR', d.ident.diagProtocol);
    if (!free) return;
    const s = mapSwitch.stateOnCar(free);
    d.carMapSwitch = s.state;
    d.carTrigger = s.trigger;
    d.carPresses = s.presses;
    if (s.state === 'current' || s.state === 'earlier') {
      const field = await ms45ReadCarBytes(mapSwitch.MAP2_DATA_VERSION_OFFSET, mapSwitch.MAP2_DATA_VERSION_OFFSET + mapSwitch.DATA_VERSION_LENGTH - 1, 'ROMX', d.ident.diagProtocol);
      d.carMap2Version = mapSwitch.dataVersionFrom(field);
    }
  } catch (e) {
    d.carMapSwitch = null;
  }
}

function fbDmeImmobilizerSummary() {
  const d = fbState.dme;
  if (d.carProgramEwsDeleted === true) {
    return d.carTuneEwsDeleted === false ? 'Identified, DME already EWS deleted, but its tune still has the immobilizer on' : 'Identified, DME already EWS deleted';
  }
  if (d.carProgramEwsDeleted === false) {
    return d.carTuneEwsDeleted === true ? 'Identified, DME not EWS deleted, but its tune has the immobilizer off' : 'Identified, DME not EWS deleted';
  }
  return 'Identified, EWS state not read';
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
        `${d.carMapSwitch === 'earlier' ? ', earlier version)' : ')'}${d.carMap2Version == null ? ', no map 2 stored' : ''}`
      );
    case 'unrecognised':
      return ', MPC carries an unrecognised modification';
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
    flashLog.note(`DME ${d.ident.hwRef} / prog ${d.ident.progRef} / diag ${d.ident.diagProtocol} / ${d.fullBin ? 'full' : 'tune'}`);
    if (d.ident.diagProtocol !== 'BMW-FAST' && !(await ms45SecurityAccess(d.ident.diagProtocol, fbSetStatus))) {
      fbSetStatus('Security Access Denied');
    }
    const progress = (p) => {
      fbProgress(p);
      fbSetStatusInPlace(`${p}%`);
    };
    let dump;
    let mpc = null;
    if (!d.fullBin) {
      fbSetStatus('Reading parameters');
      dump = await ms45ReadMemory(0x40000, 0x5cfff, 'ROMX', { onProgress: progress });
    } else {
      fbSetStatus('Reading External Flash');
      dump = await ms45ReadMemory(0x00000, 0xfffff, 'ROMX', { onProgress: progress });
      fbSetStatus('Reading Internal Flash');
      mpc = await ms45ReadMemory(0x00000, 0x6ffff, 'LAR', { onProgress: progress });
    }
    const wanted = d.fullBin ? 0x100000 : 0x1d000;
    if (dump.length !== wanted || (mpc && mpc.length !== 0x70000)) {
      fbSetStatus(`Read failed: the DME returned ${dump.length} of ${wanted} bytes`);
    } else {
      const base = `${d.ident.vin}_${d.ident.hwRef}`;
      fbSaveBytes(`${base}${d.fullBin ? '_Flash' : ''}.bin`, dump);
      if (mpc) fbSaveBytes(`${base}_MPC.bin`, mpc);
      fbSetStatus(`Saved ${d.fullBin ? 'the full flash and MPC' : 'the tune'} (${dump.length} bytes)`);
    }
    await ms45LeaveProgrammingMode(d.ident.diagProtocol);
  } finally {
    await fbSessionStop();
  }
}

async function fbDmeReadInstalledMaps() {
  const d = fbState.dme;
  if (!(d.carMapSwitch === 'current' || d.carMapSwitch === 'earlier')) return;
  await fbSessionStart('read-maps', { vin: d.ident.vin, module: d.ident.hwRef });
  try {
    if (d.ident.diagProtocol !== 'BMW-FAST' && !(await ms45SecurityAccess(d.ident.diagProtocol, fbSetStatus))) fbSetStatus('Security Access Denied');
    const progress = (p) => fbProgress(p);
    fbSetStatus('Reading map 1');
    const map1 = await ms45ReadMemory(mapSwitch.CALIBRATION_START, mapSwitch.CALIBRATION_START + mapSwitch.CALIBRATION_LENGTH - 1, 'ROMX', { onProgress: progress });
    fbSetStatus('Reading map 2');
    const map2Area = await ms45ReadMemory(mapSwitch.MAP2_START, mapSwitch.MAP2_START + mapSwitch.MAP2_LENGTH - 1, 'ROMX', { onProgress: progress });
    await ms45LeaveProgrammingMode(d.ident.diagProtocol);
    if (map1.length !== mapSwitch.CALIBRATION_LENGTH || map2Area.length !== mapSwitch.MAP2_LENGTH) {
      fbSetStatus('Read failed. The DME did not return both maps.');
      return;
    }
    const map2 = mapSwitch.map2AsCalibration(map2Area);
    const name = `${d.ident.vin}_${d.ident.hwRef}`;
    fbSaveBytes(`${name}_map1.bin`, map1);
    if (map2) fbSaveBytes(`${name}_map2.bin`, map2);
    const v1 = mapSwitch.readDataVersion(map1) || 'unknown data version';
    fbSetStatus(map2 ? `Read map 1 (${v1}) and map 2 (${mapSwitch.readDataVersion(map2)})` : `Read map 1 (${v1}). No map 2 is stored on the car.`);
  } finally {
    await fbSessionStop();
  }
}

// ---- loading files ------------------------------------------------------------------------------------
function fbDmeFullBinChanged() {
  const d = fbState.dme;
  d.fullBin = fbEls['dme-fullbin'].checked;
  d.flash = null;
  d.mpc = null;
  d.flashName = '';
  d.mpcName = '';
  fbDmeClearExchangeFile(false);
  fbProgress(0);
  fbRefreshAll();
  fbOptionsRefreshEwsGate();
}

/** A loaded .0PA has no tune in it unless its .0DA was paired. */
function fbDmeProgramHasNoTune() {
  const d = fbState.dme;
  return d.exchangeKind === '0PA' && !d.exchangeTuneLoaded;
}

function fbDmeTuneMismatchPrompt() {
  return fbState.dme.ident.swRef
    ? "Loaded tune does not match DME's program.\n\nDo you wish to load it anyway?"
    : 'No DME has been identified, so this tune cannot be checked against one.\n\nDo you wish to load it anyway?';
}

function fbDmeProgramMismatchPrompt() {
  return fbState.dme.ident.hwRef
    ? 'Loaded program does not match DME hardware.\n\nDo you wish to load it anyway?'
    : 'No DME has been identified, so this program cannot be checked against one.\n\nDo you wish to load it anyway?';
}

async function fbDmeLoadFile1() {
  const d = fbState.dme;
  fbProgress(0);
  try {
    const file = await fbPickFile(d.fullBin ? '.bin,.ori,.0PA,.0pa' : '.bin,.ori,.0DA,.0da');
    if (!file) return;
    if (ms45ExchangeFile.isProgramFile(file.name) || ms45ExchangeFile.isDataFile(file.name)) {
      await fbDmeLoadExchangeFile(file);
      await fbDmeGateLoadedFiles();
      return;
    }
    const bytes = await fbReadBytes(file);
    if (!d.fullBin) {
      if (bytes.length >= 0x1d000 && bytes.length <= 0x20000) {
        if (!ms45VerifyParameterMatch(bytes, d.ident.swRef) && !(await fbConfirm(fbDmeTuneMismatchPrompt(), 'Warning'))) {
          d.flash = null;
          d.mpc = null;
          return;
        }
        d.flash = bytes;
        d.flashName = file.name;
      } else {
        fbSetStatus('Invalid tune file length');
        d.flash = null;
        return;
      }
    } else {
      if (bytes.length !== MS45_FULL_FLASH_LENGTH) {
        fbSetStatus('Invalid flash file length');
        d.flash = null;
        return;
      }
      if (!ms45VerifyProgramMatch(bytes, d.ident.hwRef) && !(await fbConfirm(fbDmeProgramMismatchPrompt(), 'Warning'))) {
        d.flash = null;
        d.mpc = null;
        return;
      }
      if (d.mpc && !ms45VerifyFlashMpcMatch(bytes, d.mpc)) {
        if (!(await fbConfirm('External flash and MPC flash do not match. Flashing them may permanently brick your DME.\n\nDo you wish to load them anyway?', 'Warning'))) {
          d.flash = null;
          d.mpc = null;
          return;
        }
      }
      d.flash = bytes;
      d.flashName = file.name;
    }
    fbSetStatus(`Loaded ${file.name}`);
    await fbDmeGateLoadedFiles();
  } finally {
    fbRefreshAll();
    fbOptionsRefreshEwsGate();
  }
}

async function fbDmeLoadFile2() {
  const d = fbState.dme;
  fbProgress(0);
  try {
    if (d.exchangeKind === '0PA') {
      await fbDmeLoadPairedDataFile();
      await fbDmeGateLoadedFiles();
      return;
    }
    const file = await fbPickFile('.bin,.ori');
    if (!file) return;
    const bytes = await fbReadBytes(file);
    if (bytes.length !== MS45_MPC_LENGTH) {
      fbSetStatus('Invalid mpc file length');
      d.mpc = null;
      return;
    }
    if (d.flash && !ms45VerifyFlashMpcMatch(d.flash, bytes)) {
      if (!(await fbConfirm('External flash and MPC flash do not match. Flashing them may permanently brick your DME.\n\nDo you wish to load them anyway?', 'Warning'))) {
        d.flash = null;
        d.mpc = null;
        return;
      }
    }
    d.mpc = bytes;
    d.mpcName = file.name;
    fbSetStatus(`Loaded ${file.name}`);
    await fbDmeGateLoadedFiles();
  } finally {
    fbRefreshAll();
    fbOptionsRefreshEwsGate();
  }
}

/** A .0PA (Full Binary ticked) or a .0DA (unticked) as the file to flash. */
async function fbDmeLoadExchangeFile(file) {
  const d = fbState.dme;
  const isProgram = ms45ExchangeFile.isProgramFile(file.name);
  if (isProgram && !d.fullBin) {
    await fbMessage(`${file.name} is a program file. Tick Full Binary to load it.`, 'Load File');
    return;
  }
  if (!isProgram && d.fullBin) {
    await fbMessage(`${file.name} is a data (tune) file. Untick Full Binary to load it.`, 'Load External');
    return;
  }
  try {
    const text = await fbReadText(file);
    if (isProgram) {
      const program = ms45ExchangeFile.decodeProgramText(text);
      if (!ms45VerifyFlashMpcMatch(program.flash, program.mpc)) {
        await fbMessage(`The external program and the MPC inside ${file.name} do not belong together, so the file is not being loaded.`, 'Load External');
        return;
      }
      if (!ms45VerifyProgramMatch(program.flash, d.ident.hwRef) && !(await fbConfirm(fbDmeProgramMismatchPrompt(), 'Warning'))) return;
      d.flash = program.flash;
      d.mpc = program.mpc;
      d.flashName = file.name;
      d.mpcName = file.name;
      fbDmeShowExchangeFile('0PA', file.name, program.reference);
      fbSetStatus(`Loaded ${file.name} (external program and MPC)`);
    } else {
      const cal = ms45ExchangeFile.decodeCalibrationText(text);
      if (!ms45VerifyParameterMatch(cal.data, d.ident.swRef) && !(await fbConfirm(fbDmeTuneMismatchPrompt(), 'Warning'))) return;
      d.flash = cal.data;
      d.mpc = null;
      d.flashName = file.name;
      fbDmeShowExchangeFile('0DA', file.name, cal.reference);
      fbSetStatus(`Loaded ${file.name}`);
    }
  } catch (e) {
    await fbMessage(`Could not load ${file.name}.\n\n${fbDescribeError(e)}`, isProgram ? 'Load External' : 'Load File');
  }
}

function fbDmeShowExchangeFile(kind, name, reference) {
  const d = fbState.dme;
  d.exchangeKind = kind;
  fbEls['dme-exchange-text'].textContent = `${kind}: ${name}`;
  fbEls['dme-exchange'].title = reference ? `${kind}: ${name}  (${reference})` : '';
}

/** Pair a .0DA with the loaded .0PA; only a data file built for that program is accepted. */
async function fbDmeLoadPairedDataFile() {
  const d = fbState.dme;
  const file = await fbPickFile('.0DA,.0da');
  if (!file) return;
  if (!ms45ExchangeFile.isDataFile(file.name)) {
    await fbMessage(`${file.name} is not a .0DA data file.`, 'Load .0da');
    return;
  }
  try {
    const cal = ms45ExchangeFile.decodeCalibrationText(await fbReadText(file));
    if (!ms45ExchangeFile.isMatchingPair(d.flash, cal.data)) {
      await fbMessage(
        `${file.name} does not belong to the loaded program.\n\nThe program is ${mapSwitch.readProgramVersion(d.flash) || 'unknown'} ` +
          `(project ${ms45ExchangeFile.programProjectToken(d.flash) || '?'}), and this data file is ${cal.reference || 'unknown'} ` +
          `(project ${ms45ExchangeFile.calibrationProjectToken(cal.data) || '?'}).\n\nIt has not been loaded.`,
        'Load .0da'
      );
      return;
    }
    const image = Uint8Array.from(d.flash);
    image.set(cal.data, MS45_CAL_START);
    d.flash = image;
    d.exchangeTuneLoaded = true;
    fbEls['dme-tune-text'].textContent = `0DA: ${file.name}`;
    fbEls['dme-tune'].title = cal.reference ? `0DA: ${file.name}  (${cal.reference})` : '';
    fbSetStatus(`Loaded ${file.name} as the tune for the program`);
  } catch (e) {
    await fbMessage(`Could not load ${file.name}.\n\n${fbDescribeError(e)}`, 'Load .0da');
  }
}

function fbDmeRemovePairedTune() {
  const d = fbState.dme;
  if (!d.exchangeTuneLoaded) return;
  if (d.flash && d.flash.length === MS45_FULL_FLASH_LENGTH) {
    const image = Uint8Array.from(d.flash);
    image.fill(0xff, MS45_CAL_START, MS45_CAL_START + MS45_CAL_LENGTH);
    d.flash = image;
  }
  d.exchangeTuneLoaded = false;
  fbRefreshAll();
}

/**
 * Take the exchange file away and hand the load buttons back.
 * @param {boolean} clearFiles - Also drop the loaded images.
 */
function fbDmeClearExchangeFile(clearFiles) {
  const d = fbState.dme;
  if (d.exchangeKind == null) return;
  d.exchangeKind = null;
  d.exchangeTuneLoaded = false;
  if (clearFiles) {
    d.flash = null;
    d.mpc = null;
    d.flashName = '';
    d.mpcName = '';
    fbProgress(0);
    fbSetStatus('Removed the loaded file');
  }
  fbRefreshAll();
}

// ---- the immobilizer around every load ----------------------------------------------------------------
/**
 * Whatever was just loaded, checked against the immobilizer state it will
 * meet, with a mismatch offered to put right. A refused load is cleared.
 */
async function fbDmeGateLoadedFiles() {
  const d = fbState.dme;
  if (!d.flash) return;
  if (!d.fullBin) {
    if (d.flash.length < MS45_CAL_LENGTH) return;
    await fbDmeGateTuneAgainstCar();
    return;
  }
  if (d.flash.length !== MS45_FULL_FLASH_LENGTH) return;
  const fileProgramDeleted = ewsDelete.programBytesAreDeleted(d.flash[ewsDelete.PROGRAM_STATE_OFFSET], d.flash[ewsDelete.PROGRAM_MASK_OFFSET]);
  if (fbDmeProgramHasNoTune()) {
    if (
      !fileProgramDeleted &&
      d.carTuneEwsDeleted === true &&
      !(await fbConfirm(
        'The tune on the car has the immobilizer switched off, and this program has it on.\n\nA .0PA has no tune in it, so on its own the tune on the car stays as it is, ' +
          'and the car may not start with this program.\n\nTo keep the car EWS deleted, load the program\'s .0DA next with "Load .0da (optional)". The EWS delete can then be applied to both.\n\nDo you wish to load it anyway?',
        'Immobilizer Mismatch'
      ))
    ) {
      fbDmeClearExchangeFile(true);
    }
    return;
  }
  if (!d.mpc) return;
  d.flash = await fbDmeMatchImmobilizer(d.flash, d.mpc, fileProgramDeleted, true, 'Immobilizer Mismatch');
  await fbDmeGateProgramAgainstCar(fileProgramDeleted);
}

async function fbDmeGateProgramAgainstCar(fileProgramDeleted) {
  const d = fbState.dme;
  if (d.carProgramEwsDeleted !== true || fileProgramDeleted || d.ews) return;
  const blocked = fbOptionsEwsBlockedReason();
  if (blocked) {
    await fbMessage(
      `The program on the car is EWS-deleted, but the program in this file is not.\n\nFlashing it puts the immobilizer back, and a car that needed the delete will crank but not start.\n\nThe EWS delete cannot be applied to this file: ${blocked}`,
      'Immobilizer Mismatch'
    );
    return;
  }
  if (
    await fbConfirm(
      'The program on the car is EWS-deleted, but the program in this file is not.\n\nFlashing it as it is puts the immobilizer back, and a car that needed the delete will crank but not start.\n\nApply the EWS delete when flashing?',
      'Immobilizer Mismatch'
    )
  ) {
    d.ews = true;
    fbOptionsRefreshSummary();
    fbSetStatus('EWS delete will be applied to the program before flashing.');
  } else {
    fbSetStatus('Loaded without EWS delete. The car may not start with this program.');
  }
}

async function fbDmeGateTuneAgainstCar() {
  const d = fbState.dme;
  const tune = d.flash;
  if (d.carProgramEwsDeleted === true && ewsDelete.calibrationHasStockImmobilizer(tune, 0)) {
    if (
      await fbConfirm(
        'The program on the car is EWS-deleted, but this tune still has the immobilizer switched on.\n\nFlashed like this the car will crank but not start (EWS fault P1665).\n\nClear the immobilizer flags in the tune to match the program?',
        'Immobilizer Mismatch'
      )
    ) {
      d.flash = ewsDelete.applyCalibrationDelete(tune, 0);
      fbSetStatus('Matched tune to EWS-deleted program');
    }
    return;
  }
  if (
    d.carProgramEwsDeleted === false &&
    ewsDelete.calibrationHasDeletedImmobilizer(tune, 0) &&
    !(await fbConfirm('The program on the car has the immobilizer on, but this tune has it switched off.\n\nThe two do not match, and the car may not start like this.\n\nDo you wish to load it anyway?', 'Immobilizer Mismatch'))
  ) {
    fbDmeClearExchangeFile(false);
    d.flash = null;
    fbSetStatus('Tune not loaded');
  }
}

/**
 * Offer to switch the immobilizer off in the tunes of an image whose program
 * is (or is about to be) EWS-deleted. Map 1 is asked about; map 2, when the
 * image has one, is matched without asking. Returns the image to use.
 * @param {Uint8Array} flash - A full image.
 * @param {Uint8Array} mpc - The MPC.
 * @param {boolean} programDeleted - Whether the program will be EWS-deleted.
 * @param {boolean} checkMap1 - Whether to ask about map 1.
 * @param {string} title - The dialog title.
 * @param {string[]} [log] - Where to add what was done.
 * @returns {Promise<Uint8Array>}
 */
async function fbDmeMatchImmobilizer(flash, mpc, programDeleted, checkMap1, title, log) {
  if (!programDeleted || !flash || flash.length !== MS45_FULL_FLASH_LENGTH) return flash;
  const note = (line) => {
    if (log) log.push(line);
    flashLog.note(line);
  };
  if (checkMap1 && ewsDelete.calibrationHasStockImmobilizer(flash, MS45_CAL_START)) {
    if (
      await fbConfirm(
        'The program is EWS-deleted, but the tune (map 1) still has the immobilizer switched on.\n\nFlashed like this the car will crank but not start (EWS fault P1665).\n\nClear the immobilizer flags in the tune to match the program?',
        title
      )
    ) {
      flash = ewsDelete.applyCalibrationDelete(flash, MS45_CAL_START);
      note('Map 1: immobilizer flags cleared to match the EWS-deleted program');
    } else {
      note('WARNING: EWS-deleted program with the immobilizer on in map 1. The car will not start like this.');
    }
  }
  if (mapSwitch.hasMap2(flash, mpc) && ewsDelete.calibrationHasStockImmobilizer(flash, mapSwitch.MAP2_START)) {
    flash = ewsDelete.applyCalibrationDelete(flash, mapSwitch.MAP2_START);
    note('Map 2: immobilizer flags cleared to match the EWS-deleted program');
  }
  return flash;
}

/**
 * Take the map switch build as the full binary to flash (from Custom Options).
 * @param {{flash: Uint8Array, mpc: Uint8Array}} built - The built pair.
 */
async function fbDmeLoadBuiltPair(built) {
  const d = fbState.dme;
  fbDmeClearExchangeFile(false);
  d.fullBin = true;
  fbEls['dme-fullbin'].checked = true;
  d.flash = Uint8Array.from(built.flash);
  d.mpc = Uint8Array.from(built.mpc);
  d.flashName = 'Map switch build (external)';
  d.mpcName = 'Map switch build (MPC)';
  fbRefreshAll();
  fbOptionsRefreshEwsGate();
  fbShowOptions(false);
  fbSetStatus('Loaded the map switch build. Use Flash Program to write it.');
  await fbDmeGateLoadedFiles();
  fbRefreshAll();
  fbOptionsRefreshEwsGate();
}

// ---- Flash Tune ----------------------------------------------------------------------------------------
async function fbDmeFlashTune() {
  const d = fbState.dme;
  if (!d.identified || !d.flash) return;
  let success = true;
  fbFlashingBar(true);
  await fbSessionStart('flash-tune', { vin: d.ident.vin, module: d.ident.hwRef });
  try {
    flashLog.note(`DME ${d.ident.hwRef} / prog ${d.ident.progRef} / diag ${d.ident.diagProtocol}${d.flashName ? ` / file ${d.flashName}` : ''}`);
    if (!(await fbProgrammingCounter(false))) return;
    if (!(await ms45SecurityAccess(d.ident.diagProtocol, fbSetStatus))) {
      fbSetStatus('Security Access Denied');
      return;
    }
    const calFromFull = d.fullBin || d.flash.length > 0x40000;
    let cal = calFromFull ? Uint8Array.from(d.flash.subarray(0x40000, 0x40000 + MS45_CAL_LENGTH)) : Uint8Array.from(d.flash.subarray(0, MS45_CAL_LENGTH));
    // the program on the DME EWS-deleted but the tune still stock would
    // re-enable EWS in the calibration while the program stays deleted
    let programDeleted = false;
    if (d.ident.hwRef === '0044570' && (d.ident.progRef || '').includes(ewsDelete.SUPPORTED_PROGRAM_VERSION)) {
      const progBytes = await ms45ReadMemory(ewsDelete.PROGRAM_STATE_OFFSET, ewsDelete.PROGRAM_MASK_OFFSET, 'ROMX');
      if (progBytes.length === ewsDelete.PROGRAM_MASK_OFFSET - ewsDelete.PROGRAM_STATE_OFFSET + 1) {
        programDeleted = ewsDelete.programBytesAreDeleted(progBytes[0], progBytes[progBytes.length - 1]);
        flashLog.note(`Program EWS bytes on DME: ${progBytes[0].toString(16)} / ${progBytes[progBytes.length - 1].toString(16)} -> ${programDeleted ? 'EWS-DELETED' : 'stock/immobilizer-active'}`);
      } else {
        flashLog.note('Could not read the program EWS bytes to check for a tune mismatch; continuing.');
      }
    }
    if (programDeleted && ewsDelete.calibrationHasStockImmobilizer(cal, 0)) {
      if (await fbConfirm('The current program that is on your DME is EWS deleted, and requires a matching edit in the tune. Apply the EWS delete to the uploaded tune?', 'EWS Delete Mismatch')) {
        cal = ewsDelete.applyCalibrationDelete(cal, 0);
        flashLog.note('Applied cal EWS delete to the tune to match the EWS-deleted program.');
        fbSetStatus('Matched tune to EWS-deleted program');
      } else {
        flashLog.note('User declined matching the tune to the EWS-deleted program; the car may not start.');
      }
    }
    if (d.ident.diagProtocol === 'BMW-FAST') {
      if (!(await ms45Job('normaler_datenverkehr', 'nein;nein;ja')).ok) return;
      if (!(await ms45Job('normaler_datenverkehr', 'ja;nein;nein')).ok) return;
    }
    fbSetStatus('Erasing Flash');
    if (!(await ms45Erase(0x2040000, 0x20000))) {
      fbSetStatus('Erase failed');
      success = false;
      return;
    }
    let toFlash = ms45Checksums.correctParameterChecksums(cal);
    toFlash = ms45Checksums.signParameters(toFlash);
    flashLog.attach('tune_0x40000.bin', toFlash);
    fbSetStatus('Flashing ECU');
    success = await ms45FlashBlock(toFlash, 0x2040000, 0x205cfff, {
      onStage: fbSetStatus,
      onProgress: (p) => {
        fbProgress(p);
        fbSetStatusInPlace(`Flashing ${p}%`);
      },
    });
    if (success) {
      success = await ms45FinishFlash('Daten', true, d.ident.diagProtocol, fbSetStatus);
      fbSetStatus(success ? 'Flash successful' : 'Flash failed');
    } else {
      fbSetStatus('Flash failed');
    }
  } finally {
    fbFlashingBar(false);
    fbProgress(0);
    if (success) {
      await fbDmeIdentify(true);
      await fbWriteAif();
    }
    await fbSessionStop();
  }
}

// ---- Flash Program --------------------------------------------------------------------------------------
async function fbDmeFlashProgram() {
  const d = fbState.dme;
  if (!d.identified || !d.flash || !d.mpc) return;
  // the immobilizer match, asked before the diagnostic session opens so a
  // prompt left waiting cannot time it out
  let clearMap1 = false;
  let clearMap2 = false;
  if (d.flash.length === MS45_FULL_FLASH_LENGTH) {
    const programDeleted = d.ews || ewsDelete.programBytesAreDeleted(d.flash[ewsDelete.PROGRAM_STATE_OFFSET], d.flash[ewsDelete.PROGRAM_MASK_OFFSET]);
    const matched = await fbDmeMatchImmobilizer(d.flash, d.mpc, programDeleted, !d.ews && !fbDmeProgramHasNoTune(), 'Flash Program');
    clearMap1 = ewsDelete.calibrationHasStockImmobilizer(d.flash, MS45_CAL_START) && !ewsDelete.calibrationHasStockImmobilizer(matched, MS45_CAL_START);
    clearMap2 = ewsDelete.calibrationHasStockImmobilizer(d.flash, mapSwitch.MAP2_START) && !ewsDelete.calibrationHasStockImmobilizer(matched, mapSwitch.MAP2_START);
  }
  let success = true;
  fbFlashingBar(true);
  await fbSessionStart('flash-program', { vin: d.ident.vin, module: d.ident.hwRef });
  try {
    flashLog.note(`DME ${d.ident.hwRef} / prog ${d.ident.progRef} / diag ${d.ident.diagProtocol} / EWS delete ${d.ews}${d.flashName ? ` / ${d.flashName}` : ''}${d.mpcName ? ` + ${d.mpcName}` : ''}`);
    if (!(await fbProgrammingCounter(false))) return;
    if (!(await ms45SecurityAccess(d.ident.diagProtocol, fbSetStatus))) {
      fbSetStatus('Security Access Denied');
      return;
    }
    if (d.ident.diagProtocol === 'BMW-FAST') {
      if (!(await ms45Job('normaler_datenverkehr', 'nein;nein;ja')).ok) return;
      if (!(await ms45Job('normaler_datenverkehr', 'ja;nein;nein')).ok) return;
    }
    let source = d.flash;
    if (d.ews) {
      try {
        source = ewsDelete.apply(source);
        fbSetStatus('Applied EWS delete');
        for (const line of ewsDelete.describe()) flashLog.note(`EWS delete edit: ${line}`);
      } catch (e) {
        fbSetStatus(`EWS delete failed: ${e.message}`);
        await fbMessage(e.message, 'EWS Delete');
        return;
      }
    }
    if (clearMap1) {
      source = ewsDelete.applyCalibrationDelete(source, MS45_CAL_START);
      flashLog.note('Immobilizer flags cleared in the tune (map 1) to match the program');
    }
    if (clearMap2) {
      source = ewsDelete.applyCalibrationDelete(source, mapSwitch.MAP2_START);
      flashLog.note('Immobilizer flags cleared in map 2 to match the program');
    }
    let toFlash = ms45Checksums.correctProgramChecksums(source, d.mpc);
    const signedFlash = ms45Checksums.signProgram(toFlash, d.mpc);
    flashLog.attach('external_flash.bin', signedFlash);
    flashLog.attach('mpc_flash.bin', d.mpc);
    toFlash = signedFlash.subarray(MS45_PROGRAM_START, MS45_PROGRAM_START + 0x9ff40);
    const progress = (what) => (p) => {
      fbProgress(p);
      fbSetStatusInPlace(`${what} ${p}%`);
    };
    flashLog.note('PHASE: erase program region 0x2060000 block 0xA0000');
    fbSetStatus('Erasing Flash');
    if (!(await ms45Erase(0x2060000, 0xa0000))) {
      fbSetStatus('Flash failed');
      success = false;
      return;
    }
    flashLog.note('PHASE: write external program 0x2060000..0x20FFF3F');
    fbSetStatus('Flashing External Program');
    success = await ms45FlashBlock(toFlash, 0x2060000, 0x20fff3f, { onStage: fbSetStatus, onProgress: progress('Flashing external') });
    if (!success) {
      fbSetStatus('Flash failed');
      return;
    }
    // the program signature spans external + MPC together: an external-only
    // write leaves the program invalid
    flashLog.note('PHASE: write internal MPC 0x0..0x6FFFF (brick-capable step)');
    fbSetStatus('Flashing Internal Program');
    success = await ms45FlashBlock(d.mpc, 0, 0x6ffff, { onStage: fbSetStatus, onProgress: progress('Flashing MPC') });
    const hasCal = d.flash.length >= 0x5d000 && !fbDmeProgramHasNoTune();
    if (success && hasCal) {
      let calFlash = Uint8Array.from(source.subarray(MS45_CAL_START, MS45_CAL_START + MS45_CAL_LENGTH));
      calFlash = ms45Checksums.signParameters(ms45Checksums.correctParameterChecksums(calFlash));
      flashLog.note('PHASE: erase calibration 0x2040000 block 0x20000');
      fbSetStatus('Erasing Calibration');
      success = await ms45Erase(0x2040000, 0x20000);
      if (success) {
        flashLog.note('PHASE: write calibration 0x2040000..0x205CFFF');
        fbSetStatus('Flashing Calibration');
        success = await ms45FlashBlock(calFlash, 0x2040000, 0x205cfff, { onStage: fbSetStatus, onProgress: progress('Flashing calibration') });
      }
    }
    if (success) {
      success = await ms45FinishFlash('Programm', !hasCal, d.ident.diagProtocol, fbSetStatus);
      if (!success) fbSetStatus('Flash failed');
    }
    if (success && hasCal) {
      success = await ms45FinishFlash('Daten', true, d.ident.diagProtocol, fbSetStatus);
      fbSetStatus(success ? 'Flash successful' : 'Flash failed');
    } else if (success) {
      fbSetStatus('Flash successful');
    }
  } finally {
    fbFlashingBar(false);
    fbProgress(0);
    if (success) {
      await fbDmeIdentify(true);
      await fbWriteAif();
    }
    await fbSessionStop();
  }
}

// ---- Finish Programming (Settings) ---------------------------------------------------------------------------
async function fbDmeVerifyProgramming() {
  const d = fbState.dme;
  if (!d.identified || fbState.running) return;
  if (
    !(await fbConfirm(
      "This runs the DME's program and calibration signature checks and resets it. Nothing is written.\n\nUse it when a flash stopped after the program was written but before it was verified: the program and the tune are on the DME, but it stays in the bootloader (programming status 5) until both checks have passed.\n\nIgnition on, engine off. Continue?",
      'Finish Programming'
    ))
  ) {
    return;
  }
  if (!(await fbEnsureCable())) return;
  fbBusy(true);
  fbShowPage('flashing');
  let success = true;
  fbFlashingBar(true);
  await fbSessionStart('verify-program', { vin: d.ident.vin, module: d.ident.hwRef });
  try {
    flashLog.note(`DME ${d.ident.hwRef} / prog ${d.ident.progRef} / diag ${d.ident.diagProtocol}`);
    if (!(await fbProgrammingCounter(false))) {
      success = false;
      return;
    }
    if (!(await ms45SecurityAccess(d.ident.diagProtocol, fbSetStatus))) {
      fbSetStatus('Security Access Denied');
      success = false;
      return;
    }
    fbSetStatus('Checking the program signature');
    success = await ms45FinishFlash('Programm', false, d.ident.diagProtocol, fbSetStatus);
    if (!success) {
      fbSetStatus('Program signature check failed');
      return;
    }
    fbProgress(50);
    fbSetStatus('Checking the calibration signature');
    success = await ms45FinishFlash('Daten', true, d.ident.diagProtocol, fbSetStatus);
    if (!success) {
      fbSetStatus('Calibration signature check failed');
      return;
    }
    fbProgress(100);
    fbSetStatus('Both signatures verified, DME reset');
  } catch (e) {
    success = false;
    fbSetStatus(`Verification failed: ${e.message}`);
    await fbMessage(fbDescribeError(e), 'Finish Programming');
  } finally {
    fbFlashingBar(false);
    fbProgress(0);
    if (success) {
      try {
        await fbDmeIdentify(true);
        await fbWriteAif();
      } catch (e) {
        fbSetStatus(`Identify failed: ${e.message}`);
      }
    }
    await fbSessionStop();
    fbBusy(false);
    fbRefreshAll();
  }
}
