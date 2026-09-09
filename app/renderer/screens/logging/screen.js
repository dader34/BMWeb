/**
 * @file Data logging: the screen -- the chassis and module pickers, the
 * controls, and the run itself.
 *
 * Last piece of screens/logging/ (see store.js for the folder map); it is the
 * only piece that touches the DOM chrome, and the only one the router and the
 * Apps hub name.
 */

/* exported showLogging, showLoggingChassis, stopDataLogging */

/**
 * The live run, while one exists. Module-level rather than per-screen so the
 * leave hook can stop it without the screen handing anything over.
 * @type {{store: LogStore, grid: LogChartGrid, sched: LogScheduler, chassis: string, onCable: Function, timer: any}|null}
 */
let _logRun = null;

/**
 * Stop a logging run and let go of the bus. Called on every screen change
 * (the action bar's leave hook) and on cable loss.
 *
 * Safe to call when nothing is running -- that is the normal case on every
 * other screen, and it must cost nothing there.
 * @returns {void}
 */
function stopDataLogging() {
  if (!_logRun) return;
  const run = _logRun;
  _logRun = null;
  try {
    if (run.timer) clearInterval(run.timer);
    window.removeEventListener('bmweb-cable', run.onCable);
    run.grid.destroy();
    // the scheduler's own stop awaits the job in flight so the next screen's
    // job cannot interleave with ours on the wire
    run.sched.stop();
  } catch (e) {
    /* leaving: nothing left to tell */
  }
}

/**
 * The Data logging app: pick a chassis, then what to log.
 * @returns {Promise<void>}
 */
async function showLogging() {
  lastScreen = showLogging;
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: 'Apps', fn: showApps },
    { label: 'Data logging' },
  ]);
  sbLeft.textContent = 'select chassis';
  sbRight.textContent = '';
  view.innerHTML = head(
    'Data logging',
    'Data logging',
    'Poll read-only jobs and chart their values live.'
  );
  setActions([
    {
      key: 'Escape',
      keyLabel: 'Esc',
      label: 'Back',
      kind: 'back',
      fn: showApps,
    },
  ]);
  const list = document.createElement('div');
  list.className = 'chassis-grid stagger';
  view.appendChild(list);
  const ids = await tryApi(
    '/api/chassis',
    null,
    view,
    'failed to load vehicles'
  );
  if (!ids) return;
  ids.forEach((id) => {
    const card = document.createElement('button');
    card.className = 'chassis-card';
    // the same card the home grid and the wiring picker draw: the chassis
    // name, then the model line it stands for (not the id twice)
    const tag = (typeof CHASSIS_TAG === 'object' && CHASSIS_TAG[id]) || 'BMW';
    card.innerHTML =
      `<div class="chassis-code">${esc(dispChassis(id))}</div>` +
      `<div class="chassis-tag">${esc(tag)}</div>` +
      `<div class="chassis-arrow">→</div>`;
    card.onclick = () => showLoggingChassis(id);
    list.appendChild(card);
  });
  stagger(list);
  sbRight.textContent = `${ids.length} chassis`;
}

/**
 * The logging workspace for one car: the selection panel on the left, the
 * charts on the right.
 * @param {string} chassis - The chassis id.
 * @returns {Promise<void>}
 */
async function showLoggingChassis(chassis) {
  const car = String(chassis).toUpperCase();
  lastScreen = () => showLoggingChassis(car);
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: 'Apps', fn: showApps },
    { label: 'Data logging', fn: showLogging },
    { label: dispChassis(car) },
  ]);
  // setCrumbs syncs the hash off lastScreen's NAME, and this screen's
  // lastScreen is a closure, so the chassis route is set explicitly
  if (typeof history !== 'undefined' && history.replaceState)
    history.replaceState(null, '', `#apps/logging/${car}`);
  sbLeft.textContent = 'idle';
  view.innerHTML = head(
    dispChassis(car),
    'Data logging',
    'Pick modules, then the readings to chart. Only read-only jobs are offered.'
  );

  const store = new LogStore();
  const selection = new LogSelection();
  // the page as it was left: a reload keeps the readings and the window
  const last = logLastGet(car);
  if (last) selection.fromJSON(last.rows);

  const wrap = document.createElement('div');
  wrap.className = 'log-wrap';
  wrap.innerHTML = `
    <div class="log-side">
      <div class="log-side-head">
        <input class="log-search modal-input" type="text" placeholder="Search modules, jobs, keys…" />
      </div>
      <div class="log-tree"></div>
      <div class="log-summary"></div>
    </div>
    <div class="log-main">
      <div class="log-bar"></div>
      <div class="log-grid"></div>
    </div>`;
  view.appendChild(wrap);
  const treeEl = wrap.querySelector('.log-tree');
  const summaryEl = wrap.querySelector('.log-summary');
  const barEl = wrap.querySelector('.log-bar');
  const gridEl = wrap.querySelector('.log-grid');
  const searchEl = wrap.querySelector('.log-search');

  const grid = new LogChartGrid(gridEl, store);
  // the window as it was left, set before the first sync keeps state again
  const keptWin =
    last && LOG_WINDOWS.some((w) => w.ms === last.windowMs)
      ? last.windowMs
      : LOG_WINDOWS[0].ms;
  grid.setWindow(keptWin);
  /** @type {LogScheduler|null} */
  let sched = null;

  treeEl.innerHTML = '<div class="empty"><span class="loader"></span></div>';
  let modules = [];
  try {
    modules = await logModulesFor(car);
  } catch (e) {
    treeEl.innerHTML = errorBlock(e.message);
    return;
  }

  /**
   * Redraw the "what is selected" summary and the achieved rates.
   * @returns {void}
   */
  const paintSummary = () => {
    const targets = selection.targets();
    if (!targets.length) {
      summaryEl.innerHTML =
        '<div class="log-sum-empty">Nothing selected yet.</div>';
      return;
    }
    const rows = targets
      .map((t) => {
        const rate = store.rateFor(t.sgbd);
        const hz = rate ? `${rate.toFixed(rate < 10 ? 1 : 0)}/s` : '—';
        return (
          `<div class="log-sum-row"><span class="log-sum-job">${esc(t.label)} · ` +
          `${esc(t.job)}</span><span class="log-sum-n">${t.keys.length} key${
            t.keys.length === 1 ? '' : 's'
          }</span><span class="log-sum-rate" title="achieved rounds per second">${esc(hz)}</span></div>`
        );
      })
      .join('');
    summaryEl.innerHTML =
      `<div class="log-sum-head">${selection.size} reading${
        selection.size === 1 ? '' : 's'
      } on ${targets.length} job${targets.length === 1 ? '' : 's'}</div>` +
      rows;
  };

  /**
   * Declare every selected key in the store and rebuild the chart grid.
   * @returns {void}
   */
  /**
   * Drop one reading from the card's own remove button: the selection loses
   * it, its checkbox in the tree (if that branch is open) unticks, and the
   * grid rebuilds without it.
   * @param {string} id - The series id.
   * @returns {void}
   */
  grid.onRemove = (id) => {
    selection.remove(id);
    const cb = treeEl.querySelector(
      `input[type="checkbox"][data-series="${CSS.escape(id)}"]`
    );
    if (cb) cb.checked = false;
    syncCharts();
  };

  const syncCharts = () => {
    for (const it of selection.items.values())
      store.declare(it.sgbd, it.job, it.key, humanizeKey(it.key));
    // a key that was deselected should lose its chart
    for (const id of [...store.meta.keys()]) {
      if (!selection.items.has(id)) {
        store.meta.delete(id);
        store.series.delete(id);
      }
    }
    grid.build();
    grid.draw();
    paintSummary();
    logLastSet(car, { rows: selection.toJSON(), windowMs: grid.windowMs });
  };

  // ---- the picker tree ----------------------------------------------------
  /** @type {Map<string, string[]>} SGBD -> its readable job names, once fetched. */
  const jobCache = new Map();
  /** @type {Map<string, Array<{name: string, comment: string, unit: string}>>} */
  const keyCache = new Map();

  /**
   * Build the module list, filtered by the search box.
   * @param {string} q - The search text, lower-cased.
   * @returns {void}
   */
  const paintTree = (q) => {
    const needle = String(q || '')
      .trim()
      .toLowerCase();
    const shown = modules.filter(
      (m) =>
        !needle ||
        m.label.toLowerCase().includes(needle) ||
        m.sgbd.toLowerCase().includes(needle) ||
        m.section.toLowerCase().includes(needle)
    );
    if (!shown.length) {
      treeEl.innerHTML =
        '<div class="log-sum-empty">No module matches that.</div>';
      return;
    }
    treeEl.innerHTML = '';
    for (const m of shown) {
      const det = document.createElement('details');
      det.className = 'log-mod';
      det.innerHTML =
        `<summary class="log-mod-head"><span class="log-mod-name">${esc(m.label)}</span>` +
        `<span class="log-mod-sgbd">${esc(m.sgbd)}</span></summary>` +
        `<div class="log-mod-body"></div>`;
      const body = det.querySelector('.log-mod-body');
      // jobs are fetched only when a module is opened: a chassis carries
      // ~90 modules and a jobs fetch each would be 90 archive reads for a
      // list the user will look at one of
      det.addEventListener('toggle', async () => {
        if (!det.open || body.dataset.loaded) return;
        body.dataset.loaded = '1';
        body.innerHTML =
          '<div class="log-load"><span class="loader"></span></div>';
        let jobs = jobCache.get(m.sgbd);
        if (!jobs) {
          jobs = await logReadableJobs(m.sgbd);
          jobCache.set(m.sgbd, jobs);
        }
        if (!jobs.length) {
          body.innerHTML =
            '<div class="log-sum-empty">No readable jobs in this build.</div>';
          return;
        }
        body.innerHTML = '';
        for (const job of jobs) {
          const jd = document.createElement('details');
          jd.className = 'log-job';
          jd.innerHTML =
            `<summary class="log-job-head">${esc(job)}</summary>` +
            `<div class="log-keys"></div>`;
          const keysEl = jd.querySelector('.log-keys');
          jd.addEventListener('toggle', async () => {
            if (!jd.open || keysEl.dataset.loaded) return;
            keysEl.dataset.loaded = '1';
            keysEl.innerHTML =
              '<div class="log-load"><span class="loader"></span></div>';
            const ck = `${m.sgbd}/${job}`;
            let keys = keyCache.get(ck);
            if (!keys) {
              keys = await logResultKeys(m.sgbd, job);
              keyCache.set(ck, keys);
            }
            if (!keys.length) {
              keysEl.innerHTML =
                '<div class="log-sum-empty">This job declares no result registers.</div>';
              return;
            }
            keysEl.innerHTML = '';
            for (const k of keys) {
              const row = document.createElement('label');
              row.className = 'log-key';
              const cb = document.createElement('input');
              cb.type = 'checkbox';
              // the chart card's remove button finds this box by series id
              cb.dataset.series = logSeriesKey(m.sgbd, job, k.name);
              cb.checked = selection.has(m.sgbd, job, k.name);
              cb.onchange = () => {
                selection.set(m, job, k.name, cb.checked);
                syncCharts();
              };
              const text = document.createElement('span');
              text.className = 'log-key-text';
              text.innerHTML =
                `<span class="log-key-name">${esc(k.name)}</span>` +
                (k.unit
                  ? `<span class="log-key-unit">${esc(k.unit)}</span>`
                  : '') +
                (k.comment
                  ? `<span class="log-key-note">${esc(k.comment)}</span>`
                  : '');
              row.appendChild(cb);
              row.appendChild(text);
              keysEl.appendChild(row);
            }
          });
          body.appendChild(jd);
        }
      });
      treeEl.appendChild(det);
    }
  };

  searchEl.oninput = () => paintTree(searchEl.value);
  paintTree('');
  if (last) syncCharts(); // the kept readings get their cards back
  paintSummary();

  // ---- the controls -------------------------------------------------------
  barEl.innerHTML = `
    <button class="btn primary log-start">Start</button>
    <button class="btn log-clear">Clear</button>
    <span class="log-win"></span>
    <span class="log-spacer"></span>
    <button class="btn log-preset-save">Save preset</button>
    <select class="log-preset-load modal-input"><option value="">Load preset…</option></select>
    <button class="btn log-csv">Export CSV</button>`;
  const startBtn = barEl.querySelector('.log-start');
  const winEl = barEl.querySelector('.log-win');
  const presetSel = barEl.querySelector('.log-preset-load');

  LOG_WINDOWS.forEach((w) => {
    const b = document.createElement('button');
    b.className = 'btn log-win-btn' + (w.ms === keptWin ? ' on' : '');
    b.textContent = w.label;
    b.onclick = () => {
      grid.setWindow(w.ms);
      [...winEl.children].forEach((c) => c.classList.remove('on'));
      b.classList.add('on');
      logLastSet(car, { rows: selection.toJSON(), windowMs: w.ms });
    };
    winEl.appendChild(b);
  });

  /**
   * Refresh the preset dropdown from the store.
   * @returns {void}
   */
  const paintPresets = () => {
    const saved = logPresetsGet(car);
    presetSel.innerHTML =
      '<option value="">Load preset…</option>' +
      Object.keys(saved)
        .sort()
        .map((n) => `<option value="${esc(n)}">${esc(n)}</option>`)
        .join('');
  };
  paintPresets();

  presetSel.onchange = () => {
    const name = presetSel.value;
    if (!name) return;
    const saved = logPresetsGet(car)[name];
    if (saved) {
      selection.fromJSON(saved);
      store.clear();
      syncCharts();
      paintTree(searchEl.value); // checkboxes follow the loaded selection
      sbLeft.textContent = `preset "${name}"`;
    }
    presetSel.value = '';
  };

  barEl.querySelector('.log-preset-save').onclick = async () => {
    if (!selection.size) return;
    const name = await inputDialog({
      title: 'Save preset',
      body: 'A name for this selection.',
      example: 'Cold start',
      confirmLabel: 'Save',
    });
    if (!name) return;
    logPresetSave(car, name, selection.toJSON());
    paintPresets();
    sbLeft.textContent = `saved "${name}"`;
  };

  barEl.querySelector('.log-clear').onclick = () => {
    store.clear();
    grid.draw();
    paintSummary();
    sbLeft.textContent = 'cleared';
  };

  barEl.querySelector('.log-csv').onclick = async () => {
    const csv = logCsv(store);
    if (!csv) {
      sbLeft.textContent = 'nothing logged yet';
      return;
    }
    await logSaveCsv(`${car.toLowerCase()}-log.csv`, csv);
  };

  /**
   * Start or pause the run.
   * @returns {void}
   */
  const toggle = () => {
    if (sched && sched.running) {
      sched.stop();
      return;
    }
    if (!selection.size) {
      sbLeft.textContent = 'select a reading first';
      return;
    }
    syncCharts();
    sched = new LogScheduler({
      targets: selection.targets(),
      store,
      onState: (s) => {
        startBtn.textContent = s.running ? 'Pause' : 'Start';
        startBtn.classList.toggle('primary', !s.running);
        grid.live = s.running;
        sbLeft.textContent = s.error || (s.running ? 'logging' : 'paused');
        if (!s.running) grid.draw();
        paintActions();
      },
      onSample: () => grid.schedule(),
    });
    // the run is registered so the leave hook can stop it from anywhere
    if (_logRun) stopDataLogging();
    const onCable = (ev) => {
      // the cable went: the bus is gone, so stop rather than pile up failures
      if (ev && ev.detail && ev.detail.connected === false) {
        sched.stop();
        sbLeft.textContent = 'cable disconnected · logging stopped';
      }
    };
    window.addEventListener('bmweb-cable', onCable);
    _logRun = {
      store,
      grid,
      sched,
      chassis: car,
      onCable,
      // the rate readout is a second-scale fact, so it is repainted on its
      // own slow timer rather than on every sample
      timer: setInterval(paintSummary, 1000),
    };
    sched.start();
  };

  startBtn.onclick = toggle;

  /**
   * The F-key bar, which changes wording with the run state.
   * @returns {void}
   */
  const paintActions = () => {
    const running = !!(sched && sched.running);
    setActions([
      { key: '1', label: running ? 'Pause' : 'Start', fn: toggle },
      {
        key: '2',
        label: 'Clear',
        fn: () => barEl.querySelector('.log-clear').click(),
      },
      {
        key: '3',
        label: 'CSV',
        fn: () => barEl.querySelector('.log-csv').click(),
      },
      {
        key: 'Escape',
        keyLabel: 'Esc',
        label: 'Back',
        kind: 'back',
        fn: showLogging,
      },
    ]);
  };
  paintActions();
  grid.build();
}

/**
 * Write CSV to a file the user picks, falling back to a download where the
 * File System Access API is unavailable. Mirrors ipoSaveFileWrite's contract
 * (screens/ipo-runtime/dialogs.js) with a CSV media type, so a spreadsheet
 * opens it directly instead of treating it as plain text.
 * @param {string} suggested - The suggested file name.
 * @param {string} text - The CSV body.
 * @returns {Promise<void>}
 */
async function logSaveCsv(suggested, text) {
  /** @type {{name: string, handle?: FileSystemFileHandle}|null} */
  let picked;
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: suggested,
        types: [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }],
      });
      picked = { name: handle.name, handle };
    } catch (e) {
      return; // AbortError: the user cancelled
    }
  } else {
    const name = await inputDialog({
      title: 'Export CSV',
      body: 'File name for the download.',
      example: suggested,
      confirmLabel: 'Save',
    });
    if (name == null || !String(name).trim()) return;
    picked = { name: String(name).trim() };
  }
  if (picked.handle && typeof picked.handle.createWritable === 'function') {
    const w = await picked.handle.createWritable();
    await w.write(text);
    await w.close();
    sbLeft.textContent = `saved ${picked.name}`;
    return;
  }
  const blob = new Blob([text], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = picked.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  sbLeft.textContent = `saved ${picked.name}`;
}
