// Flashing/Tuning: the spark cut rev limiter and engine protection sections
// of Custom Options (screens/flashing/options.js draws them). Both are
// applied to the loaded program on the way out.

/* exported fbProtectHtml, fbProtectWire, fbProtectTesting, fbOptionsProtectBlockedReason, fbDmeProtectPlanned, fbOptionsCarRevLimitRead, fbOptionsRefreshProtectGate */

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

/** @returns {string} The two sections' markup. */
function fbProtectHtml() {
  return `
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
    </div>`;
}

/** Wire the switches and their number inputs. */
function fbProtectWire() {
  for (const row of FB_PROTECT_ROWS) {
    fbEls[row.on].onchange = () => fbOptionsProtectChanged();
    for (const id of Object.keys(row.inputs))
      fbEls[id].oninput = () => fbOptionsProtectChanged();
  }
}

// Two sections on the screen, one patch in the program: the same three gates
// carry the rev cut and the temperature limits. fbState.dme.protect is what
// the flashed program is to carry: undefined leaves the loaded program as it
// is, null takes the gates out, a config builds them.

/**
 * Whether the spark cut and the engine protection are offered at all. They
 * are still being proven on the car, so they are for testing only: a copy of
 * the app served from this machine shows them, the public site and the
 * packaged app do not, and can neither build them into a program nor take
 * them out of one.
 * @returns {boolean}
 */
function fbProtectTesting() {
  const host = typeof location !== 'undefined' ? location.hostname : '';
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host.endsWith('.localhost')
  );
}

/** Why the spark cut and the protection are not available, or null when they are. */
function fbOptionsProtectBlockedReason() {
  if (!fbProtectTesting()) return 'Not available yet.';
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
      : ms45Protect.isOutdated(d.flash, d.mpc)
        ? 'The loaded program carries an older spark cut and protection. Ticking anything here replaces it.'
        : 'The loaded program carries a spark cut or protection this version does not know. Ticking anything here replaces it.'
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
