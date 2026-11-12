// Flashing/Tuning: the Custom Options view. It replaces the flashing
// controls on the same page rather than getting a page of its own. This
// file is the view itself and its two smallest options; the others have a
// file each:
//   EWS delete                  here (applied to the loaded program)
//   remove auto upshift (TCU)   here (applied to the loaded calibration)
//   live tune                   livetune-install.js
//   spark cut, engine protection  options-protect.js
//   map switch                  options-mapswitch.js
/* exported fbOptionsHtml, fbOptionsWire, fbOptionsShowFor, fbOptionsRefreshSummary, fbOptionsEwsBlockedReason, fbOptionsRefreshEwsGate, fbOptionsRefreshUpshiftGate */

/** @returns {string} The Custom Options markup. */
function fbOptionsHtml() {
  return `
    <div class="fb-row">
      <button class="btn" id="fb-opt-back">&#x2039;&nbsp; Back</button>
      <span class="fb-h1">Custom Options</span>
    </div>

    <div class="fb-section" id="fb-opt-ews-section">
      <div class="fb-code">PROGRAM FLASH</div>
      <div class="fb-row">
        <label class="fb-check"><input type="checkbox" id="fb-opt-ews" disabled> EWS Delete</label>
      </div>
      <div class="fb-faint" id="fb-opt-ews-reason"></div>
    </div>

    <div class="fb-section" id="fb-opt-livetune-section" hidden>
      ${fbLtInstallHtml()}
    </div>

    ${fbProtectHtml()}

    ${fbMsHtml()}

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
  fbProtectWire();
  fbMsWire();
}

/**
 * One view serves both modules; only the selected module's sections are shown.
 * @param {string} module - 'dme' or 'tcu'.
 */
function fbOptionsShowFor(module) {
  const tcu = module === 'tcu';
  fbEls['opt-ews-section'].hidden = tcu;
  fbEls['opt-revcut-section'].hidden = tcu || !fbProtectTesting();
  fbEls['opt-protect-section'].hidden = tcu || !fbProtectTesting();
  fbEls['opt-ms-section'].hidden = tcu;
  fbEls['opt-upshift-section'].hidden = !tcu;
  fbEls['opt-livetune-section'].hidden = tcu;
  if (tcu) fbOptionsRefreshUpshiftGate();
  else {
    fbOptionsRefreshEwsGate();
    fbLtInstallRefresh();
  }
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
  const protect = d && fbDmeProtectPlanned();
  if (protect && protect.sparkCut) active.push('spark cut');
  if (
    protect &&
    (protect.oilC != null ||
      protect.coolantC != null ||
      protect.coldWarmC != null)
  )
    active.push('engine protection');
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
    if (!fbDmeIsMs451())
      return `EWS delete is MS45.1 only; this DME reports ${id.hwRef}.`;
    if (!id.progRef)
      return 'The DME did not report a program version. EWS delete stays off.';
    if (!id.progRef.includes(ewsDelete.SUPPORTED_PROGRAM_VERSION)) {
      return `EWS delete is only verified for program ${ewsDelete.SUPPORTED_PROGRAM_VERSION}; this DME reports ${id.progRef}.`;
    }
  }
  if (!d.fullBin)
    return 'EWS delete patches the program area, so it needs Full Binary mode.';
  if (d.exchangeKind === '0PA' && !d.exchangeTuneLoaded)
    return 'EWS delete also edits the tune: load the .0DA as well.';
  // the files are checked once they are loaded (the gate runs again then);
  // until that, Full Binary ticked is enough to offer the option
  if (!d.flash) return null;
  if (ewsDelete.isAlreadyPatched(d.flash)) return null;
  const version = ewsDelete.readProgramVersion(d.flash);
  if (version !== ewsDelete.SUPPORTED_PROGRAM_VERSION) {
    return `EWS delete is only verified for program ${ewsDelete.SUPPORTED_PROGRAM_VERSION}; the loaded program reports ${version || 'an unreadable version'}.`;
  }
  if (!ewsDelete.isApplicable(d.flash)) {
    return 'The loaded program’s immobilizer bytes are neither stock nor deleted: it may be modified some other way.';
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
  // whatever moves the EWS gate (a file loaded, the mode changed, an
  // identification) moves this one too
  fbOptionsRefreshProtectGate();
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
      'EWS delete disables the immobilizer check.\n\nThe car will start without the EWS handshake. Only do this on a car you own.\n\nContinue?',
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
      'The gearbox will hold the selected gear and never upshift on its own. The engine runs to the limiter instead of shifting.\n\nApply it to the loaded calibration?',
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
