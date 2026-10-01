// Flashing/Backups: the Custom Options view. It replaces the flashing
// controls on the same page rather than getting a page of its own. For the
// DME: EWS delete and the map switch (file preparation; nothing here talks to
// the car, the built pair is handed to Flash Program). For the transmission:
// remove auto upshift, applied to the loaded calibration on the way out.
/* exported fbOptionsHtml, fbOptionsWire, fbOptionsShowFor, fbOptionsRefreshSummary, fbOptionsEwsBlockedReason, fbOptionsRefreshEwsGate, fbOptionsRefreshUpshiftGate */

/** The map switch inputs and the last build. */
const fbMs = {
  flash: null,
  mpc: null,
  map1: null,
  map2: null,
  built: null,
  trigger: 'dsc',
  presses: 4,
};

/** @returns {string} The Custom Options markup. */
function fbOptionsHtml() {
  return `
    <div class="fb-row">
      <button class="btn" id="fb-opt-back">&#x2039;&nbsp; Back</button>
      <span class="fb-h1">Custom Options</span>
    </div>

    <div class="fb-section" id="fb-opt-ews-section">
      <div class="fb-code">EWS DELETE</div>
      <label class="fb-check"><input type="checkbox" id="fb-opt-ews" disabled> EWS Delete</label>
      <div class="fb-faint" id="fb-opt-ews-reason"></div>
    </div>

    <div class="fb-section" id="fb-opt-ms-section">
      <div class="fb-code">MAP SWITCH</div>
      <div class="fb-dim">Two full tunes in one MS45.1 program (0044570LO02S). The DSC button switches at any time, even while driving (presses in the first 10 s after ignition-on are ignored); the pedals only with the engine stopped. Engine off, the tach shows 1000 rpm for map 1 or 2000 rpm for map 2, also for 3 s at ignition-on; engine running, the check-engine lamp blinks once for map 1, twice for map 2.</div>
      <div class="fb-grid2">
        <span class="fb-dim">Trigger</span>
        <span class="fb-radios">
          <label class="fb-check"><input type="radio" name="fb-ms-trigger" value="dsc" checked> DSC button</label>
          <label class="fb-check"><input type="radio" name="fb-ms-trigger" value="pedals"> Brake + full throttle, 5 s</label>
        </span>
        <span class="fb-dim" id="fb-ms-presses-label">Presses</span>
        <span class="fb-radios" id="fb-ms-presses-row">
          <label class="fb-check"><input type="radio" name="fb-ms-presses" value="4" checked> 4</label>
          <label class="fb-check"><input type="radio" name="fb-ms-presses" value="2"> 2</label>
        </span>
      </div>
      <div class="fb-grid2 fb-files">
        <button class="btn" id="fb-ms-load-flash">External Flash / .0pa...</button><span class="fb-mono fb-dim fb-ellipsis" id="fb-ms-flash">(none)</span>
        <button class="btn" id="fb-ms-load-mpc">MPC Flash / .0pa...</button><span class="fb-mono fb-dim fb-ellipsis" id="fb-ms-mpc">(none)</span>
        <button class="btn" id="fb-ms-load-map1">Map 1 Tune / .0da...</button><span class="fb-mono fb-dim fb-ellipsis" id="fb-ms-map1">(none)</span>
        <button class="btn" id="fb-ms-load-map2">Map 2 Tune / .0da...</button><span class="fb-mono fb-dim fb-ellipsis" id="fb-ms-map2">(none)</span>
      </div>
      <hr class="fb-sep">
      <div class="fb-row">
        <button class="btn primary" id="fb-ms-build" disabled>Build</button>
        <button class="btn" id="fb-ms-save" disabled title="Save the built external flash and MPC flash, checksummed and signed.">Save Files...</button>
        <button class="btn" id="fb-ms-send" disabled title="Load the built pair as the full binary to flash, ready for Flash Program.">Load for Flashing</button>
      </div>
      <div class="fb-mono fb-report" id="fb-ms-report">Choose an external flash and its MPC flash.</div>
      <div class="fb-faint">Map 2 is stored inside the program area, so changing it needs a full program flash; map 1 can still be written with Flash Tune.</div>
    </div>

    <div class="fb-section" id="fb-opt-upshift-section" hidden>
      <div class="fb-code">REMOVE AUTO UPSHIFT</div>
      <div class="fb-dim">Raises every upshift point out of reach, so the gearbox holds whichever gear is selected and never changes up on its own. The engine runs to the limiter instead of shifting, and the car will not move off again until you shift by hand. Applied to the loaded calibration before it is written; the file on disk is not changed.</div>
      <label class="fb-check"><input type="checkbox" id="fb-opt-upshift" disabled> Remove auto upshift</label>
      <div class="fb-faint" id="fb-opt-upshift-reason"></div>
    </div>`;
}

function fbOptionsWire() {
  fbEls['opt-back'].onclick = () => fbShowOptions(false);
  fbEls['opt-ews'].onchange = () => fbOptionsEwsChanged();
  fbEls['opt-upshift'].onchange = () => fbOptionsUpshiftChanged();
  document
    .querySelectorAll(
      'input[name="fb-ms-trigger"], input[name="fb-ms-presses"]'
    )
    .forEach((r) => {
      r.onchange = () => {
        fbMs.trigger = document.querySelector(
          'input[name="fb-ms-trigger"]:checked'
        ).value;
        fbMs.presses = Number(
          document.querySelector('input[name="fb-ms-presses"]:checked').value
        );
        const dsc = fbMs.trigger === 'dsc';
        fbEls['ms-presses-label'].hidden = !dsc;
        fbEls['ms-presses-row'].hidden = !dsc;
        fbMsInputsChanged();
      };
    });
  fbEls['ms-load-flash'].onclick = () => fbMsLoadFlash();
  fbEls['ms-load-mpc'].onclick = () => fbMsLoadMpc();
  fbEls['ms-load-map1'].onclick = () => fbMsLoadMap(1);
  fbEls['ms-load-map2'].onclick = () => fbMsLoadMap(2);
  fbEls['ms-build'].onclick = () => fbMsBuild();
  fbEls['ms-save'].onclick = () => fbMsSave();
  fbEls['ms-send'].onclick = () => fbMsSend();
}

/**
 * One view serves both modules; only the selected module's sections are shown.
 * @param {string} module - 'dme' or 'tcu'.
 */
function fbOptionsShowFor(module) {
  const tcu = module === 'tcu';
  fbEls['opt-ews-section'].hidden = tcu;
  fbEls['opt-ms-section'].hidden = tcu;
  fbEls['opt-upshift-section'].hidden = !tcu;
  if (tcu) fbOptionsRefreshUpshiftGate();
  else fbOptionsRefreshEwsGate();
  fbMsInputsChanged();
}

/** One line under the Custom Options button saying what is switched on. */
function fbOptionsRefreshSummary() {
  if (!fbEls['custom-summary']) return;
  if (fbState.module === 'tcu') {
    fbEls['custom-summary'].textContent = fbState.tcu.noUpshift
      ? 'On: no auto upshift'
      : '';
    return;
  }
  const active = [];
  const d = fbState.dme;
  if (d && d.ews) active.push('EWS delete');
  if (d && d.mpc && mapSwitch.isAlreadyPatched(d.mpc))
    active.push('map switch');
  fbEls['custom-summary'].textContent = active.length
    ? `On: ${active.join(', ')}`
    : '';
}

// ---- EWS delete -------------------------------------------------------------------------------------------
/** Why the EWS checkbox is not available, or null when it is. */
function fbOptionsEwsBlockedReason() {
  const d = fbState.dme;
  if (!d) return 'Identify the DME first.';
  const id = d.ident;
  if (!fbDevUi() || d.identified) {
    if (!id.hwRef) return 'Identify the DME first.';
    if (id.hwRef !== '0044570')
      return `EWS delete is only verified for the MS45.1 (hardware reference 0044570). This DME reports ${id.hwRef}.`;
    if (!id.progRef)
      return 'The DME did not report a program reference (ZIF_LESEN), so its program version cannot be confirmed. EWS delete stays disabled.';
    if (!id.progRef.includes(ewsDelete.SUPPORTED_PROGRAM_VERSION)) {
      return `EWS delete is only verified for program ${ewsDelete.SUPPORTED_PROGRAM_VERSION}, but this DME reports ${id.progRef}. The other MS45.1 program lays its globals out differently, so the patch offsets would land on unrelated code.`;
    }
  }
  if (!d.fullBin)
    return 'EWS delete patches the program area, so it needs Full Binary mode.';
  if (d.exchangeKind === '0PA' && !d.exchangeTuneLoaded)
    return 'EWS delete also edits the tune, and a .0PA has no tune in it. Load its .0DA as well.';
  if (!d.flash)
    return 'Load the full binary first, so its program version can be checked.';
  if (!d.mpc)
    return 'EWS delete is a full-program flash: load the MPC (internal) bin as well.';
  if (ewsDelete.isAlreadyPatched(d.flash)) return null;
  const version = ewsDelete.readProgramVersion(d.flash);
  if (version !== ewsDelete.SUPPORTED_PROGRAM_VERSION) {
    return `EWS delete is only verified for program version ${ewsDelete.SUPPORTED_PROGRAM_VERSION}, but the loaded program reports ${version || 'an unreadable version'}. Other MS45.1 programs lay their globals out differently, so the patch offsets would land on unrelated code.`;
  }
  if (!ewsDelete.isApplicable(d.flash)) {
    return 'The loaded program is the right version, but its immobilizer bytes hold values that are neither stock nor deleted, so it may be modified in some other way.';
  }
  return null;
}

function fbOptionsRefreshEwsGate() {
  if (!fbEls['opt-ews']) return;
  const blocked = fbOptionsEwsBlockedReason();
  fbEls['opt-ews'].disabled = !!blocked;
  if (blocked) {
    fbState.dme.ews = false;
    fbEls['opt-ews'].checked = false;
  } else {
    fbEls['opt-ews'].checked = !!fbState.dme.ews;
  }
  fbEls['opt-ews-reason'].textContent = blocked || '';
  fbOptionsRefreshSummary();
  fbRefreshCustomOptionsGate();
}

async function fbOptionsEwsChanged() {
  const d = fbState.dme;
  if (!fbEls['opt-ews'].checked) {
    d.ews = false;
    fbOptionsRefreshSummary();
    return;
  }
  const blocked = fbOptionsEwsBlockedReason();
  if (blocked) {
    fbEls['opt-ews'].checked = false;
    fbEls['opt-ews'].disabled = true;
    d.ews = false;
    await fbMessage(blocked, 'EWS Delete');
    return;
  }
  if (
    !(await fbConfirm(
      'EWS delete disables the immobilizer check in the DME program.\n\nThe car will start without a valid EWS handshake, which removes a theft deterrent. Only do this on a vehicle you own.\n\nContinue?',
      'EWS Delete'
    ))
  ) {
    fbEls['opt-ews'].checked = false;
    d.ews = false;
    fbOptionsRefreshSummary();
    return;
  }
  d.ews = true;
  fbOptionsRefreshSummary();
  fbSetStatus('EWS delete will be applied to the program before flashing.');
}

// ---- remove auto upshift ----------------------------------------------------------------------------------
function fbOptionsRefreshUpshiftGate() {
  if (!fbEls['opt-upshift']) return;
  const blocked = fbTcuNoUpshiftBlockedReason();
  fbEls['opt-upshift'].disabled = !!blocked;
  if (blocked) fbState.tcu.noUpshift = false;
  fbEls['opt-upshift'].checked = !!fbState.tcu.noUpshift;
  fbEls['opt-upshift-reason'].textContent = blocked || '';
  fbOptionsRefreshSummary();
}

async function fbOptionsUpshiftChanged() {
  const t = fbState.tcu;
  if (!fbEls['opt-upshift'].checked) {
    t.noUpshift = false;
    fbOptionsRefreshSummary();
    return;
  }
  const blocked = fbTcuNoUpshiftBlockedReason();
  if (blocked) {
    fbEls['opt-upshift'].checked = false;
    fbEls['opt-upshift'].disabled = true;
    await fbMessage(blocked, 'Remove auto upshift');
    return;
  }
  if (
    !(await fbConfirm(
      'This raises every upshift point out of reach, so the gearbox holds whichever gear is selected and will not change up on its own.\n\nThe engine will run to the limiter rather than shifting, and the car will not move off again until you shift manually.\n\nApply it to the loaded calibration?',
      'Remove auto upshift'
    ))
  ) {
    fbEls['opt-upshift'].checked = false;
    t.noUpshift = false;
  } else {
    t.noUpshift = true;
  }
  fbOptionsRefreshSummary();
}

// ---- map switch -------------------------------------------------------------------------------------------
/** Anything that changes an input throws the last build away. */
function fbMsInputsChanged() {
  if (!fbEls['ms-build']) return;
  fbMs.built = null;
  fbEls['ms-save'].disabled = true;
  fbEls['ms-send'].disabled = true;
  if (!fbMs.flash || !fbMs.mpc) {
    fbEls['ms-build'].disabled = true;
    fbEls['ms-report'].textContent =
      'Choose an external flash and its MPC flash.';
    return;
  }
  let blocked = mapSwitch.blockedReason(fbMs.flash, fbMs.mpc);
  if (!blocked && !ms45VerifyFlashMpcMatch(fbMs.flash, fbMs.mpc))
    blocked = 'The external flash and the MPC flash are not a matching pair.';
  fbEls['ms-build'].disabled = !!blocked;
  fbEls['ms-report'].textContent = blocked || fbMsDescribeInputs();
}

function fbMsDescribeInputs() {
  const inst = mapSwitch.installed(fbMs.mpc);
  if (!inst) return 'Ready to build.';
  const installed = `${mapSwitch.describeTrigger(inst.trigger, inst.presses)}, ${mapSwitch.describeScope(inst.scope)}`;
  if (!mapSwitch.isCurrentVersion(fbMs.mpc))
    return `This pair carries an earlier version of the map switch (${installed}). Build updates it.`;
  if (
    inst.trigger === fbMs.trigger &&
    (inst.trigger === 'pedals' || inst.presses === fbMs.presses)
  )
    return 'This pair already carries the map switch with this trigger. Build replaces its maps.';
  return `This pair carries the map switch with another trigger (${installed}). Build changes it.`;
}

async function fbMsLoadFlash() {
  const file = await fbPickFile('.bin,.ori,.0PA,.0pa');
  if (!file) return;
  try {
    if (ms45ExchangeFile.isProgramFile(file.name)) {
      const program = ms45ExchangeFile.decodeProgramText(
        await fbReadText(file)
      );
      fbMs.flash = program.flash;
      fbMs.mpc = program.mpc;
      fbEls['ms-flash'].textContent =
        `${file.name}  (${program.reference || 'unknown program'})`;
      fbEls['ms-mpc'].textContent = file.name;
      fbMsInputsChanged();
      return;
    }
    const data = await fbReadBytes(file);
    if (data.length !== MS45_FULL_FLASH_LENGTH) {
      await fbMessage(
        `An external flash image is 1 MB (0x100000 bytes). This file is 0x${data.length.toString(16).toUpperCase()} bytes.`,
        'Map Switch'
      );
      return;
    }
    fbMs.flash = data;
    fbEls['ms-flash'].textContent =
      `${file.name}  (${mapSwitch.readProgramVersion(data) || 'unknown program'})`;
    fbMsInputsChanged();
  } catch (e) {
    await fbMessage(
      `Could not load ${file.name}.\n\n${fbDescribeError(e)}`,
      'Map Switch'
    );
  }
}

async function fbMsLoadMpc() {
  const file = await fbPickFile('.bin,.ori,.0PA,.0pa');
  if (!file) return;
  try {
    const data = ms45ExchangeFile.isProgramFile(file.name)
      ? ms45ExchangeFile.decodeProgramText(await fbReadText(file)).mpc
      : await fbReadBytes(file);
    if (data.length !== MS45_MPC_LENGTH) {
      await fbMessage(
        `An MPC flash image is 448 KB (0x70000 bytes). This file is 0x${data.length.toString(16).toUpperCase()} bytes.`,
        'Map Switch'
      );
      return;
    }
    fbMs.mpc = data;
    fbEls['ms-mpc'].textContent = file.name;
    fbMsInputsChanged();
  } catch (e) {
    await fbMessage(
      `Could not load ${file.name}.\n\n${fbDescribeError(e)}`,
      'Map Switch'
    );
  }
}

async function fbMsLoadMap(n) {
  const file = await fbPickFile('.bin,.ori,.0DA,.0da');
  if (!file) return;
  try {
    const cal = ms45ExchangeFile.isDataFile(file.name)
      ? ms45ExchangeFile.decodeCalibrationText(await fbReadText(file)).data
      : mapSwitch.extractCalibration(await fbReadBytes(file));
    fbMs[`map${n}`] = cal;
    fbEls[`ms-map${n}`].textContent =
      `${file.name}  (${mapSwitch.readDataVersion(cal) || 'unknown data version'})`;
    fbMsInputsChanged();
  } catch (e) {
    await fbMessage(
      `Could not load ${file.name}.\n\n${fbDescribeError(e)}`,
      'Map Switch'
    );
  }
}

async function fbMsBuild() {
  try {
    const built = mapSwitch.build(
      fbMs.flash,
      fbMs.mpc,
      fbMs.map1,
      fbMs.map2,
      fbMs.trigger,
      fbMs.presses
    );
    // an EWS-deleted program needs the immobilizer off in the tunes too
    built.flash = await fbDmeMatchImmobilizer(
      built.flash,
      built.mpc,
      ewsDelete.programBytesAreDeleted(
        built.flash[ewsDelete.PROGRAM_STATE_OFFSET],
        built.flash[ewsDelete.PROGRAM_MASK_OFFSET]
      ),
      true,
      'Map Switch',
      built.log
    );
    // checksum and sign here as well, so the saved files are complete on
    // their own; the flash path repeats both
    let cal = Uint8Array.from(
      built.flash.subarray(MS45_CAL_START, MS45_CAL_START + MS45_CAL_LENGTH)
    );
    cal = ms45Checksums.signParameters(
      ms45Checksums.correctParameterChecksums(cal)
    );
    built.flash.set(cal, MS45_CAL_START);
    built.flash = ms45Checksums.correctProgramChecksums(built.flash, built.mpc);
    built.flash = ms45Checksums.signProgram(built.flash, built.mpc);
    fbMs.built = built;
    fbEls['ms-save'].disabled = false;
    fbEls['ms-send'].disabled = false;
    const report = built.log.slice();
    if (built.mapsIdentical)
      report.push(
        'Map 1 and map 2 are identical, so switching will change nothing yet.'
      );
    report.push('Checksums corrected and both partitions signed.');
    fbEls['ms-report'].textContent = report.join('\n');
    fbSetStatus('Map switch built');
  } catch (e) {
    fbMs.built = null;
    fbEls['ms-save'].disabled = true;
    fbEls['ms-send'].disabled = true;
    fbEls['ms-report'].textContent = `Build failed: ${e.message}`;
  }
}

function fbMsSave() {
  if (!fbMs.built) return;
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  fbSaveBytes(`MS45.1_mapswitch_Flash_${stamp}.bin`, fbMs.built.flash);
  fbSaveBytes(`MS45.1_mapswitch_MPC_${stamp}.bin`, fbMs.built.mpc);
}

async function fbMsSend() {
  if (!fbMs.built) return;
  const d = fbState.dme;
  if (fbState.module !== 'dme' || !d.ident.hwRef) {
    await fbMessage(
      'Go back and identify the DME first, then load the build again.\n\nA loaded program is checked against the DME that was identified.',
      'Map Switch'
    );
    return;
  }
  if (!ms45VerifyProgramMatch(fbMs.built.flash, d.ident.hwRef)) {
    await fbMessage(
      `The built program is for hardware 0044570, but the identified DME reports ${d.ident.hwRef}.`,
      'Map Switch'
    );
    return;
  }
  if (
    !(await fbConfirm(
      "This loads the map switch build as the full binary to flash.\n\nFlashing it rewrites the DME's internal (MPC) flash, and a program that does not boot cannot be recovered over the diagnostic port. Keep a full read of the car as it is now, and have a way to write the MPC directly before you flash.\n\nLoad it?",
      'Map Switch'
    ))
  ) {
    return;
  }
  await fbDmeLoadBuiltPair(fbMs.built);
}
