// System check (INPA F9 "System"): the ECU's own diagnostic routines.
//
// These are not actuator toggles. Each is a routine the ECU runs on request, so
// the SGBD exposes it as START_/STOP_/STATUS_ jobs (see tools/ms45_system_checks.py).
// INPA's screen is: the softkey list, then the routine's state, then whatever
// measurements it produced — which is the layout reproduced here.

// the routine's state word, decoded. INPA prints these as its diagnosis line.
const CHECK_STATE = {
  0: 'Init', 1: 'Start inhibited', 2: 'Running', 3: 'Complete',
  4: 'Aborted', 5: 'Not started', 6: 'Finished',
};
function checkStateText(set) {
  if (!set) return '--';
  const txt = set.STAT_DIAGNOSE_TEXT, val = set.STAT_DIAGNOSE_WERT;
  const decoded = deGerman(txt) || txt;
  if (decoded && !/^\d+$/.test(String(decoded).trim())) return decoded;
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? (CHECK_STATE[n] || `state ${n}`) : (decoded || '--');
}

// the index of system checks, INPA's F9 "System" list
function renderSystemChecks(ecu, checks, container, exit) {
  const inpa = inpaMode();
  const open = (c) => showSystemCheck(ecu, c, container,
    () => renderSystemChecks(ecu, checks, container, exit));

  container.className = 'results-panel';
  container.innerHTML = inpa
    ? `<div class="act-menu">
         <div class="act-menu-title">Systemtest</div>
         <div class="act-menu-sub">ECU diagnostic routines · start one and watch its result</div>
         <div class="act-key-list" id="sc-list"></div>
       </div>`
    : `<div class="act-menu">
         <div class="act-warning">⚠ System checks run the ECU's own diagnostic routines. Some drive components (pumps, valves) while they run. Engine off / ignition on unless you know the test.</div>
         <div class="group-grid stagger" id="sc-list"></div>
       </div>`;
  const list = container.querySelector('#sc-list');

  checks.forEach((c, i) => {
    if (inpa) {
      const row = document.createElement('button');
      row.className = 'inpa-fn act-key-row';
      row.innerHTML = `<span class="inpa-fn-key">&lt; F${i + 1} &gt;</span>`
        + `<span class="inpa-fn-label">${esc(c.title)}</span>`
        + `<span class="act-key-val">${esc(c.caption)}</span>`;
      row.onclick = () => open(c);
      list.appendChild(row);
      return;
    }
    const tile = document.createElement('div');
    tile.className = 'group-tile';
    tile.innerHTML = `
      <div class="group-name">${esc(c.title)}</div>
      <div class="group-count">${c.values ? 'test + measurements' : 'test'}</div>
      <div class="group-arrow">→</div>`;
    tile.onclick = () => open(c);
    list.appendChild(tile);
  });
  if (!inpa) stagger(list, 25);

  const acts = checks.slice(0, 9).map((c, i) => ({
    key: String(i + 1), keyLabel: `F${i + 1}`, label: c.caption, fn: () => open(c),
  }));
  if (exit) acts.push(exit);
  setActions(acts);
}

// one check: Start / Stop softkeys, the routine's state, and its measurements
async function showSystemCheck(ecu, check, container, onBack) {
  const running = new Set();
  container.className = 'results-panel';
  container.innerHTML = `
    <div class="act-menu">
      <div class="act-menu-title">${esc(check.title)}</div>
      <div class="act-menu-sub">Systemtest · ${esc(check.caption)}</div>
      <div class="act-key-list" id="sc-keys"></div>
      <div class="sc-state" id="sc-state">--</div>
      <div id="sc-values"></div>
    </div>`;
  const keysEl = container.querySelector('#sc-keys');
  const stateEl = container.querySelector('#sc-state');

  const run = async (action) => {
    const job = action === 'start' ? check.start : check.stop;
    if (!job) { sbLeft.textContent = 'not supported'; return; }
    try {
      const d = await api(`/api/ecu/${ecu.sgbd}/run/${job}`, { method: 'POST' });
      const st = ((d.sets || []).slice(-1)[0] || {}).JOB_STATUS || '';
      if (st && st !== 'OKAY') {
        showActivationError({ label: check.title, start: job }, st);
        sbLeft.textContent = st;
        return;
      }
      if (action === 'start') running.add(job); else running.clear();
      sbLeft.textContent = `${job} · ${action === 'start' ? 'started' : 'stopped'}`;
    } catch (e) {
      sbLeft.textContent = 'failed';
      confirmDialog({ title: 'Test failed', body: esc(e.message),
                      confirmLabel: 'OK', cancelLabel: 'Close' });
    }
  };

  if (inpaMode()) {
    check.keys.forEach(k => {
      const row = document.createElement('button');
      row.className = 'inpa-fn act-key-row';
      row.innerHTML = `<span class="inpa-fn-key">&lt; F${k.fkey} &gt;</span>`
        + `<span class="inpa-fn-label">${esc(k.label)}</span>`
        + `<span class="act-key-val">${esc(k.action === 'start' ? check.start : (check.stop || '-'))}</span>`;
      row.onclick = () => run(k.action);
      keysEl.appendChild(row);
    });
  }

  // the routine's state line, polled like INPA does
  if (check.status) {
    const tick = async () => {
      try {
        const d = await api(`/api/ecu/${ecu.sgbd}/run/${check.status}`, { method: 'POST' });
        const set = (d.sets || []).find(s => Object.keys(s).some(k => k.startsWith('STAT_')));
        const txt = checkStateText(set);
        if (stateEl.textContent !== txt) { stateEl.textContent = txt; flash(stateEl); }
      } catch { stateEl.textContent = 'no response'; }
    };
    tick();
    scheduleLive(tick);
  }

  // and the measurements it produced, as gauges
  const valScreen = check.values && (ecu._layout && ecu._layout.screens || [])
    .find(s => s.job === check.values);
  if (valScreen) {
    showInpaScreens(ecu, [valScreen], container.querySelector('#sc-values'),
                    valScreen.group || check.title);
  }

  const acts = check.keys.map((k, i) => ({
    key: String(i + 1), keyLabel: `F${k.fkey}`, label: k.label,
    fn: () => run(k.action),
  }));
  acts.push({ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: onBack });
  setActions(acts);
}
