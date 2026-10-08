// Flashing/Backups: the Custom Options view. It replaces the flashing
// controls on the same page rather than getting a page of its own. For the
// DME: EWS delete, the spark cut rev limiter and engine protection (all three
// applied to the loaded program on the way out) and the map switch (file
// preparation; nothing here talks to the car, the built pair is handed to
// Flash Program). For the transmission: remove auto upshift, applied to the
// loaded calibration on the way out.
/* exported fbOptionsHtml, fbOptionsWire, fbOptionsShowFor, fbOptionsRefreshSummary, fbOptionsEwsBlockedReason, fbOptionsRefreshEwsGate, fbOptionsRefreshUpshiftGate, fbOptionsProtectBlockedReason, fbOptionsCarRevLimitRead */

/** The map switch inputs and the last build. */
const fbMs = {
  flash: null,
  mpc: null,
  map1: null,
  /** Maps 2 and up: {cal, name}; a slot without a file stores a copy of map 1. */
  maps: [{ cal: null, name: '(none)' }],
  built: null,
  trigger: 'dsc',
  presses: 4,
};

/**
 * The spark cut and engine protection form: each switch, its config key, and
 * the number inputs that go with it. The spark cut is on or off; a limit
 * that is switched off leaves its key null.
 */
const FB_PROTECT_ROWS = [
  { on: 'prot-rev-on', key: 'sparkCut', inputs: {} },
  {
    on: 'prot-cold-on',
    key: 'coldWarmC',
    inputs: { 'prot-cold-rpm': 'coldRpm', 'prot-cold-c': 'coldWarmC' },
  },
  {
    on: 'prot-oil-on',
    key: 'oilC',
    inputs: { 'prot-oil-c': 'oilC', 'prot-oil-rpm': 'oilRpm' },
  },
  {
    on: 'prot-cool-on',
    key: 'coolantC',
    inputs: { 'prot-cool-c': 'coolantC', 'prot-cool-rpm': 'coolantRpm' },
  },
];

/** A number box of the protection form. */
function fbProtectInput(id, key) {
  const rpm = /Rpm$/.test(key);
  const [min, max] = rpm ? ms45Protect.RPM_RANGE : ms45Protect.TEMP_RANGE;
  return `<input class="modal-input fb-num" id="fb-${id}" type="number" min="${min}" max="${max}" step="${rpm ? 50 : 1}" value="${ms45Protect.DEFAULTS[key]}" disabled>`;
}

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

    <div class="fb-section" id="fb-opt-revcut-section">
      <div class="fb-code">SPARK CUT REV LIMITER</div>
      <div class="fb-dim">A hard rev limiter that cuts the ignition and keeps injecting, for pops and bangs at the limit. It acts at the tune's own rev limit, in whichever map is selected.</div>
      <label class="fb-check"><input type="checkbox" id="fb-prot-rev-on" disabled> Spark cut at the rev limit</label>
      <div class="fb-faint" id="fb-opt-revcut-reason"></div>
    </div>

    <div class="fb-section" id="fb-opt-protect-section">
      <div class="fb-code">ENGINE PROTECTION</div>
      <div class="fb-row">
        <label class="fb-check"><input type="checkbox" id="fb-prot-cold-on" disabled> Cold engine: limit to</label>
        ${fbProtectInput('prot-cold-rpm', 'coldRpm')}<span class="fb-dim">rpm until the coolant reaches</span>
        ${fbProtectInput('prot-cold-c', 'coldWarmC')}<span class="fb-dim">&deg;C</span>
      </div>
      <div class="fb-row">
        <label class="fb-check"><input type="checkbox" id="fb-prot-oil-on" disabled> Oil too hot: at</label>
        ${fbProtectInput('prot-oil-c', 'oilC')}<span class="fb-dim">&deg;C or more limit to</span>
        ${fbProtectInput('prot-oil-rpm', 'oilRpm')}<span class="fb-dim">rpm and set the oil temperature warning</span>
      </div>
      <div class="fb-row">
        <label class="fb-check"><input type="checkbox" id="fb-prot-cool-on" disabled> Coolant too hot: at</label>
        ${fbProtectInput('prot-cool-c', 'coolantC')}<span class="fb-dim">&deg;C or more limit to</span>
        ${fbProtectInput('prot-cool-rpm', 'coolantRpm')}<span class="fb-dim">rpm</span>
      </div>
      <div class="fb-faint" id="fb-opt-protect-reason"></div>
    </div>

    <div class="fb-section" id="fb-opt-ms-section">
      <div class="fb-code">MAP SWITCH</div>
      <div class="fb-grid2">
        <span class="fb-dim">Trigger</span>
        <span class="fb-radios">
          <label class="fb-check"><input type="radio" name="fb-ms-trigger" value="dsc" checked> DSC button</label>
          <label class="fb-check"><input type="radio" name="fb-ms-trigger" value="shifter"> Gear lever D-S-D / S-D-S, 2 s</label>
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
      </div>
      <div class="fb-grid2 fb-files" id="fb-ms-maps"></div>
      <div class="fb-row">
        <button class="btn" id="fb-ms-add-map">Add another map</button>
        <span class="fb-faint" id="fb-ms-space"></span>
      </div>
      <hr class="fb-sep">
      <div class="fb-row">
        <button class="btn primary" id="fb-ms-build" disabled>Build</button>
        <button class="btn" id="fb-ms-save" disabled title="Save the built external flash and MPC flash, checksummed and signed.">Save Files...</button>
        <button class="btn" id="fb-ms-send" disabled title="Load the built pair as the full binary to flash, ready for Flash Program.">Load for Flashing</button>
      </div>
      <div class="fb-mono fb-report" id="fb-ms-report">Choose an external flash and its MPC flash.</div>
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
  for (const row of FB_PROTECT_ROWS) {
    fbEls[row.on].onchange = () => fbOptionsProtectChanged();
    for (const id of Object.keys(row.inputs))
      fbEls[id].oninput = () => fbOptionsProtectChanged();
  }
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
  fbEls['ms-add-map'].onclick = () => {
    if (fbMs.maps.length + 2 > mapSwitch.MAX_MAPS) return;
    fbMs.maps.push({ cal: null, name: '(none)' });
    fbMsRenderMaps();
    fbMsInputsChanged();
  };
  fbMsRenderMaps();
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
  fbEls['opt-revcut-section'].hidden = tcu;
  fbEls['opt-protect-section'].hidden = tcu;
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
  // the files are checked once they are loaded (the gate runs again then);
  // until that, Full Binary ticked is enough to offer the option
  if (!d.flash) return null;
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
  // whatever moves the EWS gate (a file loaded, the mode changed, an
  // identification) moves this one too
  fbOptionsRefreshProtectGate();
  fbOptionsRefreshSummary();
  fbRefreshCustomOptionsGate();
}

// ---- spark cut rev limiter and engine protection ----------------------------------------------------------
// Two sections on the screen, one patch in the program: the same three gates
// carry the rev cut and the temperature limits. fbState.dme.protect is what
// the flashed program is to carry: undefined leaves the loaded program as it
// is, null takes the gates out, a config builds them.

/** Why the spark cut and the protection are not available, or null when they are. */
function fbOptionsProtectBlockedReason() {
  const d = fbState.dme;
  if (!d) return 'Identify the DME first.';
  if (!d.fullBin)
    return 'This is built into the program, so it needs Full Binary mode.';
  // the files are checked once both are loaded (the gate runs again then)
  if (!d.flash || !d.mpc) return null;
  return ms45Protect.blockedReason(d.flash, d.mpc);
}

/**
 * What a program flash will carry: the choice made here, else what the
 * loaded program already has. Null when neither.
 * @returns {object|null}
 */
function fbDmeProtectPlanned() {
  const d = fbState.dme;
  if (d.protect !== undefined) return d.protect;
  return d.flash && d.mpc ? ms45Protect.installed(d.flash, d.mpc) : null;
}

/** Whether a config has this row of the form switched on. */
function fbProtectRowOn(config, row) {
  if (!config) return false;
  return row.key === 'sparkCut' ? !!config.sparkCut : config[row.key] != null;
}

/** The form as a config: the spark cut true or false, a limit that is switched off null. */
function fbProtectReadForm() {
  const config = {};
  for (const row of FB_PROTECT_ROWS) {
    for (const [id, key] of Object.entries(row.inputs))
      config[key] =
        fbEls[id].value.trim() === '' ? NaN : Number(fbEls[id].value);
    if (row.key === 'sparkCut') config.sparkCut = fbEls[row.on].checked;
    else if (!fbEls[row.on].checked) config[row.key] = null;
  }
  return config;
}

/** Put a config in the form; a limit that is off keeps the number it showed. */
function fbProtectFillForm(config) {
  for (const row of FB_PROTECT_ROWS) {
    const on = fbProtectRowOn(config, row);
    fbEls[row.on].checked = on;
    if (!on) continue;
    for (const [id, key] of Object.entries(row.inputs))
      if (Number(fbEls[id].value) !== config[key])
        fbEls[id].value = config[key];
  }
}

function fbProtectSetNotes(text) {
  const d = fbState.dme;
  fbEls['opt-revcut-reason'].textContent =
    text ||
    (d && d.carRevLimit ? `The limit on the car is ${d.carRevLimit} rpm.` : '');
  fbEls['opt-protect-reason'].textContent = text;
}

/** Identify read the car's rev limit, which the spark cut's note shows. */
function fbOptionsCarRevLimitRead() {
  fbOptionsRefreshProtectGate();
}

function fbOptionsRefreshProtectGate() {
  if (!fbEls['prot-rev-on']) return;
  const d = fbState.dme;
  const blocked = fbOptionsProtectBlockedReason();
  for (const row of FB_PROTECT_ROWS) {
    fbEls[row.on].disabled = !!blocked;
    for (const id of Object.keys(row.inputs)) fbEls[id].disabled = !!blocked;
  }
  if (blocked) {
    if (d) d.protect = undefined;
    fbProtectFillForm(null);
    fbProtectSetNotes(blocked);
    return;
  }
  // a loaded program that carries the gates shows what it carries, until
  // something else is chosen
  if (d.protect === undefined)
    fbProtectFillForm(ms45Protect.installed(d.flash, d.mpc));
  fbProtectRefreshNotes();
}

/** Under each section: what is wrong with the numbers, else what the loaded program has. */
function fbProtectRefreshNotes() {
  const d = fbState.dme;
  const bad = d.protect ? ms45Protect.configError(d.protect) : null;
  if (bad) {
    fbProtectSetNotes(bad);
    return;
  }
  if (!ms45Protect.isApplied(d.flash, d.mpc)) {
    fbProtectSetNotes('');
    return;
  }
  const installed = ms45Protect.installed(d.flash, d.mpc);
  fbProtectSetNotes(
    installed
      ? `The loaded program already carries: ${ms45Protect.describe(installed).join('; ')}. What is ticked here is what gets flashed.`
      : 'The loaded program carries a spark cut or protection this version does not recognise. Ticking anything here replaces it.'
  );
}

function fbOptionsProtectChanged() {
  const d = fbState.dme;
  if (fbOptionsProtectBlockedReason()) {
    fbOptionsRefreshProtectGate();
    return;
  }
  const config = fbProtectReadForm();
  const any = FB_PROTECT_ROWS.some((row) => fbProtectRowOn(config, row));
  d.protect = any ? config : null;
  fbProtectRefreshNotes();
  fbOptionsRefreshSummary();
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
/** The rows for maps 2 and up: a file button, the file's name, and a remove button when there is more than one. */
function fbMsRenderMaps() {
  const host = fbEls['ms-maps'];
  if (!host) return;
  host.innerHTML = fbMs.maps
    .map(
      (slot, i) =>
        `<button class="btn" data-ms-map="${i}">Map ${i + 2} Tune / .0da...</button>` +
        `<span class="fb-mono fb-dim fb-ellipsis"><span data-ms-name="${i}"></span>` +
        (fbMs.maps.length > 1
          ? ` <button class="btn fb-ms-remove" data-ms-remove="${i}" title="Take this map out of the build">&times;</button>`
          : '') +
        `</span>`
    )
    .join('');
  fbMs.maps.forEach((slot, i) => {
    host.querySelector(`[data-ms-name="${i}"]`).textContent = slot.name;
    host.querySelector(`[data-ms-map="${i}"]`).onclick = () =>
      fbMsLoadMap(i + 2);
    const remove = host.querySelector(`[data-ms-remove="${i}"]`);
    if (remove)
      remove.onclick = () => {
        fbMs.maps.splice(i, 1);
        fbMsRenderMaps();
        fbMsInputsChanged();
      };
  });
}

/** Map 1 as the build will see it: the file chosen, else the tune in the loaded flash. */
function fbMsEffectiveMap1() {
  if (fbMs.map1) return fbMs.map1;
  if (fbMs.flash && fbMs.flash.length === mapSwitch.FULL_FLASH_LENGTH)
    return mapSwitch.extractCalibration(fbMs.flash);
  return null;
}

/** How the maps fit, shown under the rows; the add button follows it. */
function fbMsRefreshSpace() {
  if (!fbEls['ms-space']) return null;
  const plan = mapSwitch.plan(
    fbMsEffectiveMap1(),
    fbMs.maps.map((s) => s.cal),
    fbMs.flash,
    fbMs.mpc
  );
  const full = fbMs.maps.length + 2 > mapSwitch.MAX_MAPS;
  // one map at a time: the next slot opens once the last one has its file
  const pending = fbMs.maps.findIndex((slot) => !slot.cal);
  fbEls['ms-add-map'].disabled = full || pending >= 0 || !plan.canAddAnother;
  fbEls['ms-add-map'].title = full
    ? `The map switch cycles through at most ${mapSwitch.MAX_MAPS} maps.`
    : pending >= 0
      ? `Load a tune for map ${pending + 2} first.`
      : plan.canAddAnother
        ? ''
        : 'Another map would not fit in the free program flash.';
  const sizes = plan.perMapKb.length
    ? ` (${plan.perMapKb.map((kb, i) => `map ${i + 2}: ${kb} KB`).join(', ')})`
    : '';
  fbEls['ms-space'].textContent = plan.ok
    ? `${fbMs.maps.length + 1} maps, ${plan.kbUsed} of ${plan.kbTotal} KB of map flash used${sizes}${plan.canAddAnother ? '' : full ? '; that is the most maps the code can cycle through' : '; no room for another'}`
    : plan.reason;
  return plan;
}

function fbMsInputsChanged() {
  if (!fbEls['ms-build']) return;
  fbMs.built = null;
  fbEls['ms-save'].disabled = true;
  fbEls['ms-send'].disabled = true;
  const plan = fbMsRefreshSpace();
  if (!fbMs.flash || !fbMs.mpc) {
    fbEls['ms-build'].disabled = true;
    fbEls['ms-report'].textContent =
      'Choose an external flash and its MPC flash.';
    return;
  }
  let blocked = mapSwitch.blockedReason(fbMs.flash, fbMs.mpc);
  if (!blocked && !ms45VerifyFlashMpcMatch(fbMs.flash, fbMs.mpc))
    blocked = 'The external flash and the MPC flash are not a matching pair.';
  if (!blocked && plan && !plan.ok) blocked = plan.reason;
  fbEls['ms-build'].disabled = !!blocked;
  fbEls['ms-report'].textContent = blocked || fbMsDescribeInputs();
}

function fbMsDescribeInputs() {
  const inst = mapSwitch.installed(fbMs.mpc);
  if (!inst) return 'Ready to build.';
  const installed = `${mapSwitch.describeTrigger(inst.trigger, inst.presses)}, ${mapSwitch.describeScope(inst.scope)}, ${inst.maps} maps`;
  if (!mapSwitch.isCurrentVersion(fbMs.mpc))
    return `This pair carries an earlier version of the map switch (${installed}). Build updates it and stores the maps the new way.`;
  if (
    inst.trigger === fbMs.trigger &&
    (inst.trigger !== 'dsc' || inst.presses === fbMs.presses) &&
    inst.maps === fbMs.maps.length + 1
  )
    return 'This pair already carries the map switch with this trigger and this many maps. Build replaces its maps.';
  return `This pair carries the map switch as ${installed}. Build changes it.`;
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
    const name = `${file.name}  (${mapSwitch.readDataVersion(cal) || 'unknown data version'})`;
    if (n === 1) {
      fbMs.map1 = cal;
      fbEls['ms-map1'].textContent = name;
    } else {
      fbMs.maps[n - 2] = { cal, name };
      fbMsRenderMaps();
    }
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
      fbMs.maps.map((s) => s.cal || fbMsEffectiveMap1()),
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
        built.maps > 2
          ? 'Every map is identical to map 1, so switching will change nothing yet.'
          : 'Map 1 and map 2 are identical, so switching will change nothing yet.'
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
