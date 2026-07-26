// actuator activations (INPA F6). showEcuSection — the ECU-level section router
// that dispatches here for the Activations section — lives in ecu.js.

// activations (INPA F6): actuator tests, paired start/stop (toggle) or one-shot
// (momentary). writes to the ECU, so every run is confirmed.
const activeTests = new Set(); // jobs currently on
let activationEcu = null;       // ecu whose tests are active, for cleanup

// actuator name. INPA mode shows the caption mined from the .IPO exactly as
// INPA prints it (never translated); EDIABAS mode shows the raw job, like
// itemLabel; otherwise the English token-built label.
function actLabel(a) {
  if (lang() === 'orig') return a.start;
  if (inpaMode() && a.inpaLabel) return a.inpaLabel;
  return (a.label || a.start).replace(/^Activate /, '');
}

// activate/stop button caption + styling, shared by both layouts
function setActBtn(btn, on, momentary) {
  if (momentary) { btn.textContent = 'Run'; btn.className = 'btn act-btn'; return; }
  btn.textContent = on ? 'Stop' : 'Activate';
  btn.className = 'btn act-btn ' + (on ? 'danger on' : 'primary');
}

async function showActivations(ecu, sec, container, exitAction) {
  activationEcu = ecu;
  container.className = 'results-panel';
  container.innerHTML = `<div class="empty"><span class="loader"></span><span>Loading actuator tests…</span></div>`;
  let acts;
  try { acts = await api(`/api/ecu/${ecu.sgbd}/activations`); }
  catch (e) { container.innerHTML = errorBlock(e.message); sbLeft.textContent = 'failed'; return; }

  // INPA's own decoded actuator menus (each key carries the exact value INPA
  // sends). Shown first — they are the faithful control set; the job list below
  // is the derived fallback for everything the .IPO didn't describe.
  const actionMenus = (ecu._layout && ecu._layout.actionMenus) || [];
  if (actionMenus.length) {
    // capture the section's Back NOW: re-reading currentActions after a submenu
    // has installed its own Back makes Esc point at this list again, which traps
    // you in a loop between the list and itself
    const exit = exitAction || currentActions.find(x => x.kind === 'back');
    const reopen = () => showActivations(ecu, sec, container, exit);
    return renderActionMenuList(ecu, actionMenus, acts, container, reopen, exit);
  }

  if (!acts.length) {
    container.innerHTML = `<div class="empty"><div>No actuator tests for this module.</div></div>`;
    return;
  }

  if (inpaMode()) return renderActivationsInpa(ecu, acts, container);

  container.className = 'act-panel';
  const warn = document.createElement('div');
  warn.className = 'act-warning';
  warn.innerHTML = `⚠ Actuator tests drive real components (fans, pumps, injectors, valves). Run only with the engine off / ignition on unless you know the test. Active tests stop when you leave.`;
  const grid = document.createElement('div');
  grid.className = 'act-grid stagger';
  container.innerHTML = '';
  container.appendChild(warn);
  container.appendChild(grid);

  acts.forEach(a => {
    const card = document.createElement('div');
    card.className = 'act-card';
    const running = activeTests.has(a.start);
    card.innerHTML = `
      <div class="act-info">
        <div class="act-label">${esc(actLabel(a))}</div>
        <div class="act-jobs">${esc(`${a.start}${a.stop ? ` · ${a.stop}` : ''}`)}</div>
      </div>
      <button class="btn act-btn"></button>`;
    const btn = card.querySelector('.act-btn');
    setActBtn(btn, running, a.momentary);
    btn.onclick = () => toggleActivation(ecu, a, card, btn);
    grid.appendChild(card);
  });
  stagger(grid, 20);
}

// INPA-faithful Steuern screen: the flat `< Fn >` list INPA shows, same shape as
// the Hauptmenue (ecu.js renderInpaHauptmenue) rather than the card grid. The
// footer F-keys fire the first 9; every row is clickable regardless.
function renderActivationsInpa(ecu, acts, container) {
  container.className = 'inpa-haupt act-inpa';
  container.innerHTML = `
    <div class="inpa-haupt-sub">SGBD = ${esc(ecu.sgbd.toUpperCase())} · Steuern</div>
    <div class="act-inpa-warn">Actuator tests drive real components. Engine off / ignition on unless you know the test. Active tests stop when you leave.</div>
    <div class="inpa-haupt-list" id="act-list"></div>`;
  const list = container.querySelector('#act-list');

  const fire = [];
  acts.forEach((a, i) => {
    const row = document.createElement('button');
    row.className = 'inpa-fn act-row';
    row.innerHTML = `
      <span class="inpa-fn-key">&lt; F${i + 1} &gt;</span>
      <span class="inpa-fn-label">${esc(actLabel(a))}</span>
      <span class="act-row-job">${esc(a.start)}</span>
      <span class="act-row-btn"><span class="btn act-btn"></span></span>`;
    const btn = row.querySelector('.act-btn');
    setActBtn(btn, activeTests.has(a.start), a.momentary);
    if (activeTests.has(a.start)) row.classList.add('running');
    const run = () => toggleActivation(ecu, a, row, btn);
    row.onclick = run;
    fire.push(run);
    list.appendChild(row);
  });

  // footer F-keys drive the first 9, like INPA's softkey bar
  const back = currentActions.find(x => x.kind === 'back');
  const keys = acts.slice(0, 9).map((a, i) => ({
    key: String(i + 1), keyLabel: `F${i + 1}`,
    label: actLabel(a), fn: fire[i],
  }));
  if (back) keys.push(back);
  setActions(keys);
}

// the Activations landing screen when the .IPO gave us real action menus:
// one entry per actuator, opening its softkey page. F-keys mirror the list.
function renderActionMenuList(ecu, actionMenus, jobActs, container, reopen, exit) {
  // `exit` leaves the Activations section; without it Esc would re-enter this
  // same list, since by now currentActions holds this screen's own Back
  const back = exit || currentActions.find(x => x.kind === 'back');
  const open = (spec) => showActionMenu(ecu, spec, container, reopen);

  // INPA presents this as "Stellgliedansteuerungen": a plain softkey list in its
  // own F-key order (which runs past Back to F19), not a grid of tiles. Modern
  // mode keeps the tiles.
  const inpa = inpaMode();
  const ordered = inpa
    ? [...actionMenus].sort((a, b) =>
        (a.indexFkey || 99) - (b.indexFkey || 99) || a.title.localeCompare(b.title))
    : actionMenus;

  container.className = 'results-panel';
  container.innerHTML = inpa
    ? `<div class="act-menu">
         <div class="act-menu-title">Stellgliedansteuerungen</div>
         <div class="act-menu-sub">Actuator drives · engine off / ignition on unless you know the test</div>
         <div class="act-key-list" id="act-list"></div>
       </div>`
    : `<div class="act-menu">
         <div class="act-warning">⚠ Actuator tests drive real components (fans, pumps, injectors, valves). Run with the engine off / ignition on unless you know the test. Outputs are released when you leave.</div>
         <div class="group-grid stagger" id="act-list"></div>
       </div>`;
  const list = container.querySelector('#act-list');

  ordered.forEach((spec, i) => {
    if (inpa) {
      const row = document.createElement('button');
      row.className = 'inpa-fn act-key-row' + (spec.write ? ' danger' : '');
      row.innerHTML = `
        <span class="inpa-fn-key">${spec.indexFkey ? `&lt; F${spec.indexFkey} &gt;` : ''}</span>
        <span class="inpa-fn-label">${esc(indexLabelText(spec))}</span>
        <span class="act-key-val">${spec.write ? 'writes ECU' : `${spec.keys.length} keys`}</span>`;
      row.onclick = () => open(spec);
      list.appendChild(row);
      return;
    }
    const tile = document.createElement('div');
    tile.className = 'group-tile' + (spec.write ? ' danger' : '');
    tile.innerHTML = `
      <div class="group-name">${esc(spec.title)}</div>
      <div class="group-count">${spec.keys.length} keys${spec.write ? ' · writes ECU' : ''}</div>
      <div class="group-arrow">→</div>`;
    tile.onclick = () => open(spec);
    list.appendChild(tile);
  });
  if (!inpa) stagger(list, 25);

  const acts = ordered.slice(0, 9).map((spec, i) => ({
    key: String(i + 1),
    keyLabel: `F${inpa ? (spec.indexFkey || i + 1) : i + 1}`,
    label: inpa ? indexLabelText(spec) : spec.title,
    kind: spec.write ? 'danger' : undefined, fn: () => open(spec),
  }));
  if (back) acts.push(back);
  setActions(acts);
}

// INPA's softkey captions are a component prefix plus a German state:
// "P EIN" = Pumpe ein, "H DME" = Heizung back to the DME. Translate the parts,
// since the whole label never appears in the token table.
const KEY_PREFIX = {
  P: 'Pump', V: 'Valve', H: 'Heater',      // DMTL / secondary air
  E: 'Intake', A: 'Exhaust',               // VANOS Einlass / Auslass
};
const KEY_STATE = {
  EIN: 'on', AUS: 'off', ON: 'on', OFF: 'off',
  FREI: 'release', DME: 'to DME',          // hand the output back to the ECU
  change: 'toggle', Progr: 'Program',
};
// whole labels that are not prefix+state
const KEY_WHOLE = {
  LL: 'Idle', DK: 'Throttle', Lambda: 'Lambda', Vanos: 'VANOS',
  Knocking: 'Knock control', Octan: 'Octane', variant: 'Variant',
  all: 'All', current: 'Current', Segment: 'Segment',
};

// INPA's short index captions, expanded. These are the abbreviations on its
// "Stellgliedansteuerungen" list — kept verbatim in EDIABAS mode, spelled out
// everywhere else so the list is readable without knowing BMW's shorthand.
const INDEX_LABELS = {
  'EV': 'Injectors (EV)',
  'E-Lüfter': 'Radiator fan',
  'SLS': 'Secondary-air system (SLS)',
  'VANOS': 'VANOS',
  'TEV': 'Purge valve (TEV)',
  'KFK': 'Fuel-tank vent (KFK)',
  'EKP': 'Fuel pump (EKP)',
  'Lambda': 'O2 sensor heaters',
  'GLF': 'Controlled air routing (GLF)',
  'STA': 'Starter relay',
  'KOREL': 'A/C compressor relay',
  'EBL': 'E-box fan (EBL)',
  'AGK': 'Exhaust flap (AGK)',
  'DMTL': 'DMTL leak diagnosis',
  'VIMDISA': 'Variable intake manifold',
  'LL_Steller': 'Idle actuator',
  'MIL': 'Check-engine lamp (MIL)',
  'FGR': 'Cruise-control lamp',
};
function indexLabelText(spec) {
  const raw = spec.indexLabel || spec.title;
  if (lang() === 'orig') return raw;
  return INDEX_LABELS[raw] || spec.title || raw;
}
function keyLabelText(label) {
  if (lang() === 'orig') return label;
  const s = String(label || '').trim();
  if (KEY_WHOLE[s]) return KEY_WHOLE[s];
  if (KEY_STATE[s]) return KEY_STATE[s];
  // "<prefix> <state>", e.g. "P EIN" / "E 15%" / "V FREI"
  const m = s.match(/^([PVHEA])\s+(.+)$/);
  if (m && KEY_PREFIX[m[1]]) {
    const rest = KEY_STATE[m[2]] || m[2];   // a percent stays as-is
    return `${KEY_PREFIX[m[1]]} ${rest}`;
  }
  return deGerman(s) || s;
}

// Name the output a readout drives. These are the SOLENOID duty values (INPA's
// "Status Vanoseinlassventil"), distinct from the cam position on the
// measurement screen above, so the label has to say which is which.
const OUTPUT_LABELS = {
  STATUS_VANOS_IN: 'Intake VANOS solenoid',
  STATUS_VANOS_EX: 'Exhaust VANOS solenoid',
  STATUS_DMTL_P: 'DMTL pump',
  STATUS_DMTL_V: 'DMTL valve',
  STATUS_DMTL_H: 'DMTL heater',
  STATUS_E_LUEFTER: 'Radiator fan output',
  STATUS_SLP: 'Secondary-air pump',
  STATUS_TEV: 'Purge valve output',
  STATUS_KFK: 'Fuel-tank vent output',
  STATUS_LSVK1H: 'O2 heater, pre-cat bank 1',
  STATUS_GLF: 'Idle-speed valve output',
  STATUS_VIMDISA: 'Intake manifold output',
  STATUS_AGK: 'Exhaust flap output',
  STATUS_LL_STELLER: 'Idle actuator output',
};
function outputLabel(job) {
  if (OUTPUT_LABELS[job]) return OUTPUT_LABELS[job];
  const stub = job.replace(/^STATUS_/, '');
  return deGerman(jobLabel(stub)) || stub;
}

// INPA action menu: the softkey rows whose values were decoded out of the .IPO
// (tools/ipo_actions.py). Each key sends one argument to the menu's STEUERN_
// job — "90%" -> 91, "DME" -> 255 (hand the output back to the ECU). The live
// STATUS_ readback is polled underneath so you see the output actually move.
async function showActionMenu(ecu, spec, container, onBack) {
  activationEcu = ecu;
  const write = !!spec.write;
  container.className = 'results-panel';
  container.innerHTML = `
    <div class="act-menu">
      <div class="act-warning">${write
        ? '⚠ These keys change the ECU permanently. Each one is confirmed before it is sent.'
        : '⚠ Drives a real component. Engine off / ignition on unless you know the test. Output is released when you leave.'}</div>
      <div class="act-menu-title">${esc(spec.title)}</div>
      ${spec.subtitle ? `<div class="act-menu-sub">${esc(spec.subtitle)} · values are live</div>` : ''}
      <div class="act-key-list" id="act-keys"></div>
      <div class="act-menu-readback" id="act-rb"></div>
      <div id="act-gauges"></div>
    </div>`;
  const keysEl = container.querySelector('#act-keys');
  const rbEl = container.querySelector('#act-rb');

  // INPA's actuation pages are not keys-only: under the softkeys it polls each
  // driven output's STATUS_ job and prints STAT_AUSGANG with its text and unit
  // ("Status Vanoseinlassventil  33 %"). One readout per output, so VANOS shows
  // intake and exhaust and DMTL shows all three solenoids — as the .IPO does.
  const outEl = container.querySelector('#act-gauges');
  const readouts = Array.isArray(spec.readouts) ? spec.readouts : [];

  // The measurement screen and the driven outputs render as ONE screen: each
  // readout becomes an extra row on it, so they share the grid, the pager and
  // the polling loop. Appending them as a sibling block instead leaves them
  // outside the pager — stuck on screen while the values above them page, with
  // a stray rule in between.
  const gaugeScreen = spec.gauges && (ecu._layout && ecu._layout.screens || [])
    .find(s => s.job === spec.gauges);
  const outRows = readouts.map(r => ({
    key: 'STAT_AUSGANG', label: outputLabel(r.job), unit: null,
    min: 0, max: 100, _job: r.job,
  }));
  const screens = [];
  if (gaugeScreen) screens.push(gaugeScreen);
  // each output is its own job, so it needs its own screen entry to be polled
  outRows.forEach(row => screens.push({
    job: row._job, args: null, columns: 2, rows: [row],
  }));
  if (screens.length) {
    showInpaScreens(ecu, screens, outEl,
                    (gaugeScreen && gaugeScreen.group) || spec.title);
  }

  const send = async (k) => {
    // a key can name its own job: INPA's VANOS page drives intake from the E
    // keys and exhaust from the A keys, and DMTL has three solenoids on one page
    const job = k.job || spec.job;
    if (!job) { sbLeft.textContent = 'no job for this menu'; return; }
    // a permanent write always asks first; a commit key spells out what it does
    if (write || k.commit) {
      const ok = await confirmDialog({
        title: k.commit ? `Program ${esc(spec.title)}?` : `${esc(spec.title)}: ${esc(keyLabelText(k.label))}`,
        body: k.commit
          ? `This writes the adjusted value into <b>${esc(ecu.label)}</b> permanently. It changes how the engine runs and cannot be undone from here.`
          : `Sends <b>${esc(keyLabelText(k.label))}</b> (value ${k.value}) to <b>${esc(ecu.label)}</b> via <span class="mono">${esc(job)}</span>. This changes stored ECU data.`,
        confirmLabel: k.commit ? 'Program' : 'Send',
        danger: true,
      });
      if (!ok) { sbLeft.textContent = 'cancelled'; return; }
    }
    try {
      const st = await sendActivation(ecu, job, k.value);
      if (st && st !== 'OKAY') { showActivationError({ label: spec.title, start: job }, st); sbLeft.textContent = st; return; }
      if (k.release) activeTests.delete(job); else activeTests.add(job);
      sbLeft.textContent = `${job} ${k.value} · ${k.release ? 'released' : 'sent'}`;
      // read back the output this key actually drove, not the menu's default
      const rb = await activationReadback(ecu, k.job ? job : (spec.status || job));
      // the polled readouts already show the live state; only fall back to a
      // one-shot line for menus that have none (CO adjust, clear adaptations)
      if (!readouts.length) rbEl.textContent = rb || '';
    } catch (e) {
      sbLeft.textContent = 'failed';
      confirmDialog({ title: 'Action failed', body: esc(e.message), confirmLabel: 'OK', cancelLabel: 'Close' });
    }
  };

  // The footer F-key bar already carries every key, so no on-screen buttons in
  // either mode. INPA still PRINTS the key list as text ("< F1 > Ansteuerung
  // Einlass mit +10 °"), so reproduce that in INPA mode; modern mode shows only
  // the gauges and leaves the keys to the footer.
  if (inpaMode()) {
    spec.keys.forEach(k => {
      const row = document.createElement('button');
      row.className = 'inpa-fn act-key-row' + (k.commit ? ' danger' : '');
      row.innerHTML = `<span class="inpa-fn-key">&lt; F${k.fkey} &gt;</span>`
        + `<span class="inpa-fn-label">${esc(keyLabelText(k.label))}</span>`
        + `<span class="act-key-val">${k.release ? 'to DME' : k.value}</span>`;
      row.onclick = () => send(k);
      keysEl.appendChild(row);
    });
  }

  const acts = spec.keys.slice(0, 9).map((k, i) => ({
    key: String(i + 1), keyLabel: `F${k.fkey}`, label: keyLabelText(k.label),
    kind: k.commit ? 'danger' : undefined, fn: () => send(k),
  }));
  acts.push({ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: onBack });
  setActions(acts);
}

// per-job activation argument from INPA .ips cross-referenced to MS45's job list.
// kinds: percent = drive 0-99 (PWM), binary = 1 on / 0 off, none = momentary.
// verified on the car for E_LUEFTER (99 -> 98% readback) and EKP.
const ACTIVATION_SPEC = {
  STEUERN_E_LUEFTER: { kind: 'percent', on: 99 },   // electric fan
  STEUERN_TEV:       { kind: 'percent', on: 90 },   // purge valve (INPA ;90;)
  STEUERN_SLP:       { kind: 'percent', on: 99 },   // secondary air pump
  STEUERN_EKP:       { kind: 'binary',  on: 1 },    // fuel pump, MS45 only takes 0/1
                                                     // (arg=3 -> CONDITIONS_NOT_CORRECT, verified)
  STEUERN_KOREL:     { kind: 'binary',  on: 1 },
  STEUERN_EBL:       { kind: 'binary',  on: 1 },
  STEUERN_AGK:       { kind: 'binary',  on: 1 },
  STEUERN_DMTL_P:    { kind: 'binary',  on: 1 },
  STEUERN_DMTL_V:    { kind: 'binary',  on: 1 },
  STEUERN_DMTL_H:    { kind: 'binary',  on: 1 },
  STEUERN_GLF:       { kind: 'binary',  on: 1 },
  STEUERN_MIL:       { kind: 'binary',  on: 1 },    // check-engine lamp on
  STEUERN_EV_1:      { kind: 'binary',  on: 1 },    // injectors (pulse)
  STEUERN_EV_2:      { kind: 'binary',  on: 1 },
  STEUERN_EV_3:      { kind: 'binary',  on: 1 },
  STEUERN_EV_4:      { kind: 'binary',  on: 1 },
  STEUERN_EV_5:      { kind: 'binary',  on: 1 },
  STEUERN_EV_6:      { kind: 'binary',  on: 1 },
  STEUERN_LSVK1H:    { kind: 'binary',  on: 1 },    // O2 heaters
  STEUERN_LSVK2H:    { kind: 'binary',  on: 1 },
  STEUERN_LSHK1H:    { kind: 'binary',  on: 1 },
  STEUERN_LSHK2H:    { kind: 'binary',  on: 1 },
  STEUERN_STA:       { kind: 'binary',  on: 1 },    // starter relay
};
// default binary on=1 (safer than blasting 99 to a relay)
const actSpec = (job) => ACTIVATION_SPEC[job] || { kind: 'binary', on: 1 };
const actValue = (job) => actSpec(job).on;

// actuator tests have a short ECU watchdog: re-send the start command on a timer
// or the output stops
const keepAliveTimers = new Map(); // start job -> interval id

async function sendActivation(ecu, job, value) {
  const q = value == null || value === '' ? '' : `?arg=${encodeURIComponent(value)}`;
  const data = await api(`/api/ecu/${ecu.sgbd}/run/${job}${q}`, { method: 'POST' });
  // ECU verdict: OKAY vs condition/sequence error
  const last = (data.sets || []).slice(-1)[0] || {};
  return last.JOB_STATUS || '';
}

// the actual arg string for an activation, resolved from the SGBD's _ARGUMENTS
// schema. single ON/percent args get a sensible default and run straight away;
// multi-param tests (injector DAUER/PERIODE, idle offsets) open the arg dialog so
// the user supplies real values. cached per start-job for the keep-alive re-send.
const _actArgCache = new Map();
async function resolveActivationArg(ecu, startJob) {
  if (_actArgCache.has(startJob)) return _actArgCache.get(startJob);
  const specs = await fetchJobArgs(ecu, startJob);
  let arg;
  if (specs.length === 0) {
    arg = null; // no argument
  } else if (specs.length === 1 && /^(ON|PWM|MODE|TASTVERHAELTNIS)$/.test(specs[0].ARG)) {
    // single on/percent/duty-cycle: default on, no prompt (Stop sends 0 separately)
    arg = /^(PWM|TASTVERHAELTNIS)$/.test(specs[0].ARG) ? String(actValue(startJob) || 99) : '1';
  } else {
    // multiple or value params (injectors, idle offsets, CO%) -> ask
    arg = await argsDialog(startJob, specs);
    if (arg == null) { _actArgCache.delete(startJob); return undefined; } // cancelled
  }
  _actArgCache.set(startJob, arg);
  return arg;
}

// after activating, read the matching STATUS_<X> job and return a short readback
// string (INPA shows STAT_AUSGANG_TEXT/value/unit). null if no readback available.
async function activationReadback(ecu, startJob) {
  const statusJob = startJob.replace(/^STEUERN_/, 'STATUS_');
  try {
    const d = await api(`/api/ecu/${ecu.sgbd}/run/${statusJob}`, { method: 'POST' });
    const set = (d.sets || []).find(s => Object.keys(s).some(k => k.startsWith('STAT_')));
    if (!set) return null;
    // prefer the labeled output value/unit INPA displays
    const txt = set.STAT_AUSGANG_TEXT || set.STAT_TEXT;
    const val = set.STAT_AUSGANG || set.STAT_WERT;
    const unit = set.STAT_AUSGANG_EINH || set.STAT_EINH || '';
    if (val != null) return `${txt ? txt + ': ' : ''}${val}${unit ? ' ' + unit : ''}`.trim();
    if (txt) return String(txt);
    return null;
  } catch { return null; }
}

async function toggleActivation(ecu, a, card, btn) {
  const running = activeTests.has(a.start);
  // critical jobs (immobilizer sync, security) aren't actuator tests — they can
  // leave the car unable to start. warn far harder, and don't call it a "test".
  if (a.critical) {
    if (running) return; // no re-send path for a critical one-shot
    const ok = await confirmDialog({
      title: 'Immobilizer / security operation',
      body: `<b>${esc(a.label)}</b> (<span class="mono">${esc(a.start)}</span>) is `
          + `<b>not an actuator test</b>. It drives the DME↔EWS/CAS immobilizer `
          + `handshake and can leave <b>${esc(ecu.label)}</b> unable to start if `
          + `run out of sequence. Only run this as part of a deliberate DME/EWS `
          + `marriage procedure. Continue?`,
      confirmLabel: 'I understand, run it',
      danger: true,
    });
    if (!ok) return;
  } else if (!running || a.momentary) {
    const ok = await confirmDialog({
      title: `Run actuator test?`,
      body: `<b>${esc(a.label.replace(/^Activate /, ''))}</b> will drive a component on <b>${esc(ecu.label)}</b> (<span class="mono">${esc(a.start)}</span>).${a.momentary ? '' : ' It stays active (re-sent continuously) until you press Stop or leave this screen.'} Continue?`,
      confirmLabel: a.momentary ? 'Run' : 'Activate',
      danger: true,
    });
    if (!ok) return;
  }
  try {
    if (a.momentary) {
      const value = await resolveActivationArg(ecu, a.start);
      if (value === undefined) return; // arg dialog cancelled
      const st = await sendActivation(ecu, a.start, value);
      btn.classList.add('flash');
      if (st && st !== 'OKAY') { showActivationError(a, st); sbLeft.textContent = st; return; }
      const rb = await activationReadback(ecu, a.start);
      showActivationResult(card, rb);
      sbLeft.textContent = rb ? `${a.start}: ${rb}` : `${a.start} ran`;
      return;
    }
    if (running) {
      stopKeepAlive(a.start);
      _actArgCache.delete(a.start); // re-prompt next activate
      // Stop = drive the output to 0. The ECU rejects _ENDE in an active session,
      // but arg=0 de-energizes (verified: fuel pump, e-fan). _ENDE only as fallback.
      const off = await sendActivation(ecu, a.start, 0).catch(() => 'ERR');
      if (off !== 'OKAY' && a.stop) {
        await api(`/api/ecu/${ecu.sgbd}/run/${a.stop}`, { method: 'POST' }).catch(() => {});
      }
      activeTests.delete(a.start);
      setActBtn(btn, false); card.classList.remove('running');
      showActivationResult(card, null);
      sbLeft.textContent = `${a.start} stopped`;
    } else {
      const value = await resolveActivationArg(ecu, a.start);
      if (value === undefined) return; // arg dialog cancelled
      const st = await sendActivation(ecu, a.start, value);
      if (st && st !== 'OKAY') { showActivationError(a, st); sbLeft.textContent = st; return; }
      activeTests.add(a.start);
      setActBtn(btn, true); card.classList.add('running');
      const rb = await activationReadback(ecu, a.start);
      showActivationResult(card, rb);
      sbLeft.textContent = rb ? `${a.start}: ${rb}` : `${a.start} active`;
      // keep-alive: re-send before the ECU watchdog times out
      const t = setInterval(() => sendActivation(ecu, a.start, value).catch(() => {}), 500);
      keepAliveTimers.set(a.start, t);
    }
  } catch (e) {
    sbLeft.textContent = 'test failed';
    confirmDialog({ title: 'Test failed', body: esc(e.message), confirmLabel: 'OK', cancelLabel: 'Close' });
  }
}

// show (or clear) the STATUS_X readback line on an activation card or INPA row
function showActivationResult(card, readback) {
  // card grid nests the readback under .act-info; the INPA row has no sub-block
  const info = card.querySelector('.act-info') || card;
  let line = info.querySelector('.act-readback');
  if (!readback) { if (line) line.remove(); return; }
  if (!line) {
    line = document.createElement('div');
    line.className = 'act-readback';
    info.appendChild(line);
  }
  line.textContent = readback;
}

function showActivationError(a, status) {
  const e = explainError(status);
  confirmDialog({
    title: `${esc(a.label.replace(/^Activate /, ''))}: ${e.title}`,
    body: `${esc(e.detail)}<br><br>${e.fix ? `${e.fix}<br><br>` : ''}<span class="mono" style="font-size:11px;color:var(--ink-faint)">${esc(status)}</span>`,
    confirmLabel: 'OK', cancelLabel: 'Close',
  });
}

function stopKeepAlive(job) {
  const t = keepAliveTimers.get(job);
  if (t) { clearInterval(t); keepAliveTimers.delete(job); }
}

// stop all running actuator tests, on leaving the screen
function stopAllActivations(ecu) {
  if (!activeTests.size) return;
  const ecuSgbd = ecu?.sgbd;
  for (const start of [...activeTests]) {
    stopKeepAlive(start);
    if (ecuSgbd) {
      // arg=0 de-energizes, _ENDE only as fallback
      api(`/api/ecu/${ecuSgbd}/run/${start}?arg=0`, { method: 'POST' })
        .catch(() => api(`/api/ecu/${ecuSgbd}/run/${start}_ENDE`, { method: 'POST' }).catch(() => {}));
    }
    activeTests.delete(start);
  }
}
