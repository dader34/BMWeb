// ECU section view + actuator activations
function showEcuSection(chassisId, sectionName, ecu, menu, sectionKey) {
  const sec = menu.sections.find(s => s.section === sectionKey);
  lastScreen = () => showEcuSection(chassisId, sectionName, ecu, menu, sectionKey);
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: dispChassis(chassisId), fn: () => backToModules(chassisId) },
    { label: ecu.label, fn: () => showEcu(chassisId, sectionName, ecu) },
    { label: sec.section },
  ]);
  sbLeft.textContent = `${ecu.sgbd}.prg`;
  view.innerHTML = head(`${ecu.label} · ${ecu.code}`, sec.section,
    `${sec.items.length} function${sec.items.length === 1 ? '' : 's'}`);

  const results = document.createElement('div');
  results.className = 'results-panel';
  view.appendChild(results);

  // layout-mined sections (have _screen) render as gauge panels, not the
  // checkbox multi-watch list
  const isLayoutScreens = sec.items.some(i => i._screen);
  const isStatus = sec.section === 'Status' && !isLayoutScreens;
  const isActivations = sec.section === 'Activations';
  const selected = new Set();

  // activations get a dedicated actuator-test panel
  if (isActivations) {
    showActivations(ecu, sec, results);
    setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: () => showEcu(chassisId, sectionName, ecu) }]);
    return;
  }

  // fault memory, INPA-style: actions only in the footer F-key bar (Read, Detail,
  // Clear, etc.), no in-body job rows
  const jobs0 = sec.items.map(i => i.job);
  const isFaults = jobs0.includes('FS_LESEN') && !isStatus;
  if (isFaults) {
    loadFaultDb(); // warm the name db before any read renders
    const backToEcu = () => showEcu(chassisId, sectionName, ecu);
    const hasJob = (j) => jobs0.includes(j);
    // only the jobs MS45 has
    const acts = [
      { key: '1', label: 'Read codes', kind: 'primary', fn: () => runJob(ecu, 'FS_LESEN', results, false) },
    ];
    if (hasJob('FS_LESEN_DETAIL'))        acts.push({ key: '2', label: 'Detail', fn: () => readFaultsDetailed(ecu, results) });
    if (hasJob('FS_LESEN_FREEZE_FRAME'))  acts.push({ key: '3', label: 'Freeze', fn: () => runJob(ecu, 'FS_LESEN_FREEZE_FRAME', results, false) });
    if (hasJob('FS_LESEN_HEX'))           acts.push({ key: '4', label: 'Hex', fn: () => runJob(ecu, 'FS_LESEN_HEX', results, false) });
    if (hasJob('FS_LOESCHEN'))            acts.push({ key: '5', label: 'Clear', kind: 'danger', fn: () => runJob(ecu, 'FS_LOESCHEN', results, true) });
    acts.push({ key: '7', label: 'Comment', fn: () => addFaultComment(ecu, results) });
    acts.push({ key: '9', label: 'Export', fn: () => exportFaults(ecu, view) });
    acts.push({ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: backToEcu });
    setActions(acts);
    // prompt only, actions live in the footer F-key bar
    results.className = 'results-panel';
    results.innerHTML = `<div class="empty"><div>Press a function key below to read the fault memory: <b>1 Read</b>, <b>2 Detail</b>, <b>3 Freeze frame</b>, <b>4 Hex</b>.</div></div>`;
    return;
  }

  // status sections get a multi-watch toolbar
  let watchBtn, watchAllBtn;
  if (isStatus) {
    const bar = document.createElement('div');
    bar.className = 'watch-toolbar';
    bar.innerHTML = `
      <span class="watch-hint">Select values, then watch them together · stream to CSV with timestamps</span>
      <button class="btn watch-selected" disabled>Watch selected</button>
      <button class="btn primary watch-all">Watch all</button>`;
    view.appendChild(bar);
    watchBtn = bar.querySelector('.watch-selected');
    watchAllBtn = bar.querySelector('.watch-all');
    watchBtn.onclick = () => { if (selected.size) watchMulti(ecu, [...selected], results, view); };
    watchAllBtn.onclick = () => watchMulti(ecu, sec.items.map(i => i.job), results, view);
  }

  const list = document.createElement('div');
  list.className = 'job-list stagger';
  view.appendChild(list);

  const rowByJob = new Map(); // job -> row element, for watched highlighting
  sec.items.forEach(it => {
    const isLive = isStatus || /^STATUS|^MW_|MESSWERT/.test(it.job);
    const row = document.createElement('div');
    row.className = 'job-row' + (it.danger ? ' danger' : '') + (isStatus ? ' selectable' : '');
    row.innerHTML = `
      ${isStatus ? '<span class="job-check" role="checkbox" aria-checked="false"></span>' : '<span class="job-bullet"></span>'}
      <span class="job-label">${esc(itemLabel(it))}</span>
      ${it.danger ? '<span class="job-warn">write</span>' : ''}`;
    if (isStatus) {
      rowByJob.set(it.job, row);
      // row click toggles selection
      row.onclick = () => {
        const check = row.querySelector('.job-check');
        if (selected.has(it.job)) { selected.delete(it.job); row.classList.remove('checked'); check.setAttribute('aria-checked', 'false'); }
        else { selected.add(it.job); row.classList.add('checked'); check.setAttribute('aria-checked', 'true'); }
        watchBtn.disabled = selected.size === 0;
        watchBtn.textContent = selected.size ? `Watch ${selected.size} selected` : 'Watch selected';
      };
    } else if (it._screen) {
      // mined gauge screen
      row.onclick = () => showInpaScreen(ecu, it._screen, results);
    } else if (it._input) {
      // mined input function
      row.onclick = () => runInputFunction(ecu, it._input, results);
    } else {
      row.onclick = () => isLive ? runJobLive(ecu, it.job, results) : runJob(ecu, it.job, results, it.danger);
    }
    list.appendChild(row);
  });
  // exposed so watchMulti can highlight watched rows
  view._rowByJob = rowByJob;
  stagger(list, 14);

  // quick keys for common jobs + back to ECU menu
  const jobsHere = sec.items.map(i => i.job);
  const has = (j) => jobsHere.includes(j);
  const acts = [];
  if (has('FS_LESEN')) acts.push({ key: '1', label: 'Read codes', kind: 'primary', fn: () => runJob(ecu, 'FS_LESEN', results, false) });
  if (has('FS_LOESCHEN')) acts.push({ key: '2', label: 'Clear codes', kind: 'danger', fn: () => runJob(ecu, 'FS_LOESCHEN', results, true) });
  if (isStatus) acts.push({ key: '1', label: 'Watch all', kind: 'primary', fn: () => watchMulti(ecu, sec.items.map(i => i.job), results, view) });
  acts.push({ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: () => showEcu(chassisId, sectionName, ecu) });
  setActions(acts);
}

// activations (INPA F6): actuator tests, paired start/stop (toggle) or one-shot
// (momentary). writes to the ECU, so every run is confirmed.
const activeTests = new Set(); // jobs currently on
let activationEcu = null;       // ecu whose tests are active, for cleanup
async function showActivations(ecu, sec, container) {
  activationEcu = ecu;
  container.className = 'results-panel';
  container.innerHTML = `<div class="empty"><span class="loader"></span><span>Loading actuator tests…</span></div>`;
  let acts;
  try { acts = await api(`/api/ecu/${ecu.sgbd}/activations`); }
  catch (e) { container.innerHTML = errorBlock(e.message); sbLeft.textContent = 'failed'; return; }

  if (!acts.length) {
    container.innerHTML = `<div class="empty"><div>No actuator tests for this module.</div></div>`;
    return;
  }

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
        <div class="act-label">${esc(a.label.replace(/^Activate /, ''))}</div>
        <div class="act-jobs">${esc(`${a.start}${a.stop ? ` · ${a.stop}` : ''}`)}</div>
      </div>
      <button class="btn act-btn ${a.momentary ? '' : (running ? 'danger on' : 'primary')}">${
        a.momentary ? 'Run' : (running ? 'Stop' : 'Activate')
      }</button>`;
    const btn = card.querySelector('.act-btn');
    btn.onclick = () => toggleActivation(ecu, a, card, btn);
    grid.appendChild(card);
  });
  stagger(grid, 20);
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
  } else if (specs.length === 1 && /^(ON|PWM|MODE)$/.test(specs[0].ARG)) {
    // single on/percent: default on, no prompt (Stop sends 0 separately)
    arg = specs[0].ARG === 'PWM' ? String(actValue(startJob) || 99) : '1';
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
  if (!running || a.momentary) {
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
      btn.textContent = 'Activate'; btn.className = 'btn act-btn primary'; card.classList.remove('running');
      showActivationResult(card, null);
      sbLeft.textContent = `${a.start} stopped`;
    } else {
      const value = await resolveActivationArg(ecu, a.start);
      if (value === undefined) return; // arg dialog cancelled
      const st = await sendActivation(ecu, a.start, value);
      if (st && st !== 'OKAY') { showActivationError(a, st); sbLeft.textContent = st; return; }
      activeTests.add(a.start);
      btn.textContent = 'Stop'; btn.className = 'btn act-btn danger on'; card.classList.add('running');
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

// show (or clear) the STATUS_X readback line on an activation card
function showActivationResult(card, readback) {
  const info = card.querySelector('.act-info');
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
    body: `${esc(e.detail)}<br><br>${e.fix}<br><br><span class="mono" style="font-size:11px;color:var(--ink-faint)">${esc(status)}</span>`,
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

// jobs that require an argument (from INPA .ips), else they no-op or error.
// 'prompt' asks the user, 'fixed' sends a default.
