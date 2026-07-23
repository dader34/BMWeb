// live values: runJob, gauges, units, multi-watch, screens
const JOB_ARGS = {
  MESSWERTBLOCK_LESEN:   { prompt: 'Measurement IDs, comma-separated (e.g. 0x4300,0x4301)', placeholder: '0x4300,0x4301' },
  SPEICHER_LESEN_ASCII:  { prompt: 'Memory area (e.g. LAR;0x...)', placeholder: 'LAR;0x0000' },
  C_FG_LESEN:            { fixed: ';0' },
  AIF_LESEN:             { fixed: '0' },
  IDENT_AIF:             { fixed: '0' },
  DIAGNOSE_MODE:         { fixed: 'DEFAULT' },
  FS_SPERREN:            { prompt: 'Lock fault memory? JA (yes) / NEIN (no)', placeholder: 'NEIN' },
  DIAGNOSEPROTOKOLL_SETZEN: { fixed: 'BMW-FAST' },
  // CBS reset service codes: br_h=brake fluid, oel=oil, mik=microfilter, zb=plugs
  CBS_RESET:             { prompt: 'CBS service to reset (br_h=brake fluid, oel=oil, mik=microfilter)', placeholder: 'oel', suffix: ';100;1;0;0;0x8000;1;0;0' },
};

// text-input modal -> Promise<string|null>
function promptDialog({ title, body, placeholder = '', value = '' }) {
  return new Promise((resolve) => {
    const { overlay, close } = openModal(`
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title">${title}</div>
        <div class="modal-body">${body}</div>
        <input class="modal-input" type="text" placeholder="${esc(placeholder)}" value="${esc(value)}" />
        <div class="modal-actions">
          <button class="btn modal-cancel">Cancel<span class="modal-key">Esc</span></button>
          <button class="btn primary modal-confirm">Run<span class="modal-key">⏎</span></button>
        </div>
      </div>`, {
      onClose: resolve,
      backdropValue: null,
      onKey: (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
        else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(input.value.trim() || null); }
      },
    });
    const input = overlay.querySelector('.modal-input');
    overlay.querySelector('.modal-cancel').onclick = () => close(null);
    overlay.querySelector('.modal-confirm').onclick = () => close(input.value.trim() || null);
    setTimeout(() => input.focus(), 50);
  });
}

// fetch a job's declared arguments from the SGBD (_ARGUMENTS). returns the list
// of {ARG, ARGTYPE, ARGCOMMENT0..} rows, or [] if the job takes none / on error.
async function fetchJobArgs(ecu, job) {
  try {
    const d = await api(`/api/ecu/${ecu.sgbd}/arguments/${encodeURIComponent(job)}`);
    return (d.arguments || []).filter(a => a.ARG); // header row has no ARG
  } catch { return []; }
}

// multi-field argument dialog built from the _ARGUMENTS schema. one input per arg,
// the German ARGCOMMENT as a hint, and a <select> when comments enumerate values
// (ARGCOMMENT0/1 like 'Programm'/'Daten'). resolves to the ';'-joined arg string
// EDIABAS expects, or null if cancelled.
function argsDialog(job, argSpecs) {
  return new Promise((resolve) => {
    const tr = (s) => (typeof deGerman === 'function' ? deGerman(s) : s) || s;
    const fieldHtml = argSpecs.map((a, i) => {
      const hint = tr((a.ARGCOMMENT0 || '').replace(/^'|'$/g, ''));
      // enumerated values: ARGCOMMENT0/1/2 each a quoted token
      const enumVals = Object.keys(a).filter(k => /^ARGCOMMENT\d+$/.test(k))
        .map(k => a[k]).filter(v => /^'.*'$/.test(v)).map(v => v.replace(/^'|'$/g, ''));
      const isEnum = enumVals.length >= 2 && (a.ARGTYPE === 'string');
      const isBinary = a.ARGTYPE === 'binary';
      // arg name comes from the SGBD in German (ZEIT, DAUER); humanize + translate
      const argName = tr(humanizeKey(a.ARG));
      const label = `${esc(argName)} <span class="arg-type">(${esc(a.ARGTYPE || 'string')})</span>`;
      let note = !isEnum && hint ? `<div class="arg-hint">${esc(hint)}</div>` : '';
      if (isBinary) note += `<div class="arg-warn">Binary argument: enter raw hex (e.g. <span class="mono">01 00 0A ...</span>). Must be a valid pre-built buffer for this job, or it may fail or harm the ECU.</div>`;
      const placeholder = isBinary ? 'hex bytes, e.g. 01 00 0A' : (a.ARGTYPE === 'int' ? '0' : '');
      const field = isEnum
        ? `<select class="modal-input arg-field" data-i="${i}">${enumVals.map(v => `<option>${esc(v)}</option>`).join('')}</select>`
        : `<input class="modal-input arg-field" data-i="${i}" data-binary="${isBinary ? 1 : 0}" type="text" placeholder="${placeholder}" />`;
      return `<div class="arg-row"><label class="arg-label">${label}</label>${field}${note}</div>`;
    }).join('');
    const { overlay, close } = openModal(`
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title">${esc(jobLabel(job))}</div>
        <div class="modal-body">This job needs ${argSpecs.length} argument${argSpecs.length === 1 ? '' : 's'}.</div>
        <div class="arg-fields">${fieldHtml}</div>
        <div class="modal-actions">
          <button class="btn modal-cancel">Cancel<span class="modal-key">Esc</span></button>
          <button class="btn primary modal-confirm">Run<span class="modal-key">⏎</span></button>
        </div>
      </div>`, {
      onClose: resolve,
      backdropValue: null,
      onKey: (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
        else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(collect()); }
      },
    });
    const fields = [...overlay.querySelectorAll('.arg-field')];
    const collect = () => fields.map(f => {
      let v = f.value.trim();
      // binary args: normalize hex to a compact "0xAABBCC" form EDIABAS accepts
      if (f.dataset.binary === '1' && v) {
        const hex = v.replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '');
        v = hex ? '0x' + hex.toUpperCase() : '';
      }
      return v;
    }).join(';');
    overlay.querySelector('.modal-cancel').onclick = () => close(null);
    overlay.querySelector('.modal-confirm').onclick = () => close(collect());
    setTimeout(() => fields[0] && fields[0].focus(), 50);
  });
}

// run a job and render its result sets. FS_LESEN gets the fault-card view, others
// a generic key/value table.
async function runJob(ecu, job, container, danger, presetArg) {
  if (job === 'FS_LESEN' || job === 'FS_LESEN_DETAIL') loadFaultDb(); // warm the name db
  // resolve a required argument first. hand-tuned JOB_ARGS overrides win (they
  // encode special encodings like CBS_RESET's tail); otherwise ask the SGBD what
  // the job declares and build a dialog from that.
  let arg = presetArg;
  const spec = JOB_ARGS[job];
  if (arg == null && spec) {
    if (spec.fixed != null) arg = spec.fixed;
    else if (spec.prompt) {
      arg = await promptDialog({ title: esc(jobLabel(job)), body: spec.prompt, placeholder: spec.placeholder || '' });
      if (arg == null) return; // cancelled
      if (spec.suffix) arg += spec.suffix; // e.g. CBS_RESET service code + tail
    }
  } else if (arg == null) {
    const argSpecs = await fetchJobArgs(ecu, job);
    if (argSpecs.length) {
      arg = await argsDialog(job, argSpecs);
      if (arg == null) return; // cancelled
    }
  }
  if (danger) {
    const isClear = job === 'FS_LOESCHEN';
    // describe what the job actually does — not everything flagged is a write.
    // flash-session reads are cautioned because they can disrupt a programming
    // sequence, not because they change anything.
    const j = job.toUpperCase();
    let effect;
    if (/LESEN/.test(j) && /FLASH|AUTHENTIS|SIGNATUR|CRC|PRUEF/.test(j))
      effect = `is part of the flash-programming sequence on <b>${esc(ecu.label)}</b>. It reads from the ECU but can disrupt an in-progress flash if run out of order.`;
    else if (/LOESCHEN/.test(j))
      effect = `erases data on <b>${esc(ecu.label)}</b>. This cannot be undone.`;
    else if (/SCHREIBEN|_SETZEN|PROGRAMMIER|FLASH/.test(j))
      effect = `writes to the ECU on <b>${esc(ecu.label)}</b> and can change how it runs.`;
    else if (/RESET/.test(j))
      effect = `resets the ECU on <b>${esc(ecu.label)}</b>.`;
    else
      effect = `runs a protected function on <b>${esc(ecu.label)}</b>.`;
    const ok = await confirmDialog({
      title: isClear ? 'Clear fault codes?' : `Run ${esc(jobLabel(job))}?`,
      body: isClear
        ? `This permanently erases the fault memory on <b>${esc(ecu.label)}</b>. Stored and pending faults will be deleted. This cannot be undone.`
        : `<b>${esc(jobLabel(job))}</b> (<span class="mono">${esc(job)}</span>) ${effect} Continue?`,
      confirmLabel: isClear ? 'Clear codes' : 'Run',
      danger: true,
    });
    if (!ok) return;
  }
  container.innerHTML = `<div class="empty"><span class="loader"></span><span>Running ${esc(jobLabel(job))}…</span></div>`;
  container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  sbLeft.textContent = `${job}…`;
  try {
    let q = arg != null && arg !== '' ? `?arg=${encodeURIComponent(arg)}` : '';
    // fault jobs load via the diagnostic-address group so EDIABAS picks the exact
    // variant (see server LoadForJob); other jobs stay on the concrete SGBD.
    if (ecu.group && /^FS_/.test(job)) q += `${q ? '&' : '?'}group=${encodeURIComponent(ecu.group)}`;
    const data = await api(`/api/ecu/${ecu.sgbd}/run/${job}${q}`, { method: 'POST' });
    if (job === 'FS_LESEN' || job === 'FS_LESEN_DETAIL') {
      const codes = data.sets.slice(1); // set 0 = system summary
      await loadFaultDb(); // names resolve synchronously in the render
      renderFaults(codes, container, ecu);
      sbLeft.textContent = `${codes.length} fault(s)`;
    } else if (job === 'FS_LOESCHEN') {
      container.innerHTML = `<div class="empty"><div class="empty-big">Fault memory cleared</div><div>Re-read to confirm.</div></div>`;
      sbLeft.textContent = 'cleared';
    } else {
      renderResultSets(data.sets, container, job);
      sbLeft.textContent = 'done';
    }
  } catch (e) {
    container.innerHTML = errorBlock(e.message);
    sbLeft.textContent = 'failed';
  }
}

// render one mined layout screen as a refreshing gauge-bar panel using the screen's
// own labels/units/ranges, polling its job/args. two-column when the layout marks
// columns:2 (Bank 1 / Bank 2).
async function showInpaScreen(ecu, screen, container) {
  stopLive();
  const liveTok = _liveToken;
  const job = screen.job;
  const arg = screen.args || '';
  const rows = screen.rows || [];
  // result-key -> layout row spec, for labels/scaling
  const spec = new Map(rows.map(r => [r.key, r]));

  container.className = 'live-panel';
  container.innerHTML = `
    <div class="live-head">
      <span class="live-dot"></span>
      <span class="live-title">${esc(deGerman(screen.group) || jobLabel(job))}</span>
      <span class="live-meta" id="live-meta">connecting…</span>
      <button class="btn danger live-stop">Stop</button>
    </div>
    <div class="live-grid inpa-grid${screen.columns === 2 ? ' two-col' : ''}" id="live-grid"></div>`;
  container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const grid = container.querySelector('#live-grid');
  const meta = container.querySelector('#live-meta');
  const dot = container.querySelector('.live-dot');
  container.querySelector('.live-stop').onclick = () => {
    stopLive(); dot.classList.add('stopped'); meta.textContent = 'stopped'; sbLeft.textContent = 'stopped';
  };

  const cellEls = new Map(); // key -> gauge cell

  async function tick() {
    let data;
    try {
      const url = `/api/ecu/${ecu.sgbd}/run/${job}` + (arg ? `?arg=${encodeURIComponent(arg)}` : '');
      data = await api(url, { method: 'POST' });
    } catch (e) {
      stopLive(); container.className = 'results-panel';
      container.innerHTML = errorBlock(e.message); sbLeft.textContent = 'failed'; return;
    }
    // flatten sets into key->value
    const vals = new Map(flatResults(data.sets));

    // render in layout row order so Bank 1 / Bank 2 pair up in two columns
    for (const r of rows) {
      if (!vals.has(r.key)) continue;
      let cell = cellEls.get(r.key);
      if (!cell) {
        cell = document.createElement('div');
        cell.className = 'live-cell gauge-cell';
        cell.innerHTML = gaugeCellHTML(deGerman(r.label) || r.key);
        grid.appendChild(cell);
        cellEls.set(r.key, cell);
      }
      updateGaugeSpec(cell, r, vals.get(r.key));
    }
    meta.textContent = `live · ${cellEls.size} values`;
    sbLeft.textContent = `${job}${arg ? ' ' + arg : ''} · live`;
  }
  await tick();
  if (liveTok === _liveToken && container.querySelector('.inpa-grid')) scheduleLive(tick);
}

// update a gauge cell from the layout row's unit/min/max, falling back to the
// heuristic range only where the layout left them null
function updateGaugeSpec(cellEl, rowSpec, raw) {
  const p = parseMeasurement(raw);
  const valEl = cellEl.querySelector('.gauge-val');
  if (p.num === null) {
    cellEl.classList.add('text-only');
    if (valEl.textContent !== p.raw) { valEl.textContent = p.raw; flash(valEl); }
    return;
  }
  cellEl.classList.remove('text-only');
  let min = rowSpec.min, max = rowSpec.max;
  if (min == null || max == null) {
    const r = rangeFor(rowSpec.unit || p.unit, p.num, rowSpec.label);
    if (min == null) min = r[0];
    if (max == null) max = r[1];
  }
  if (p.num < min) min = p.num;
  if (p.num > max) max = p.num;
  const span = (max - min) || 1;
  const pct = Math.max(0, Math.min(100, ((p.num - min) / span) * 100));
  cellEl.querySelector('.gauge-fill').style.width = pct.toFixed(1) + '%';
  cellEl.querySelector('.gauge-min').textContent = fmtRange(min);
  cellEl.querySelector('.gauge-max').textContent = fmtRange(max);
  const unit = rowSpec.unit ? ` ${rowSpec.unit}` : (p.unit ? ` ${p.unit}` : '');
  const shown = `${p.num}${unit}`;
  if (valEl.textContent !== shown) { valEl.textContent = shown; flash(valEl); }
}

// live Status view: poll a measurement job into a refreshing value table. stops
// on leave or Stop.
// self-scheduling live loop: each tick runs to completion (a real K-line
// transaction) before the next is queued ~1s later, so slow reads never pile up
// the way setInterval ticks did. stopLive() bumps the token, which also stops
// any in-flight tick from rescheduling.
let liveTimer = null;   // pending setTimeout handle for the next tick
let _liveToken = 0;
function stopLive() { _liveToken++; if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; } }
function scheduleLive(tick) {
  const token = _liveToken;
  const loop = async () => {
    liveTimer = null;
    try { await tick(); } // ticks render their own errors (and may call stopLive)
    catch { /* an unexpected throw shouldn't kill the loop */ }
    if (token !== _liveToken) return;
    liveTimer = setTimeout(loop, 1000);
  };
  liveTimer = setTimeout(loop, 1000);
}

async function runJobLive(ecu, job, container) {
  stopLive();
  const liveTok = _liveToken;
  container.className = 'results-panel';
  container.innerHTML = `<div class="empty"><span class="loader"></span><span>Reading ${esc(jobLabel(job))}…</span></div>`;
  container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // build the panel once; ticks update gauge cells in place (no flicker)
  let built = false;
  let grid = null, metaEl = null, dotEl = null, titleEl = null;
  const cellEls = new Map(); // key -> gauge cell element

  function build() {
    container.className = 'live-panel';
    container.innerHTML = `
      <div class="live-head">
        <span class="live-dot"></span>
        <span class="live-title">${esc(jobLabel(job))}</span>
        <span class="live-meta" id="live-meta">connecting…</span>
        <button class="btn danger live-stop">Stop</button>
      </div>
      <div class="live-grid" id="live-grid"></div>`;
    grid = container.querySelector('#live-grid');
    metaEl = container.querySelector('#live-meta');
    dotEl = container.querySelector('.live-dot');
    titleEl = container.querySelector('.live-title');
    container.querySelector('.live-stop').onclick = () => {
      stopLive(); dotEl.classList.add('stopped'); metaEl.textContent = 'stopped';
      sbLeft.textContent = 'stopped';
    };
    built = true;
  }

  async function tick() {
    try {
      const data = await api(`/api/ecu/${ecu.sgbd}/run/${job}`, { method: 'POST' });
      // flatten named, non-internal results into ordered key/value pairs
      const rows = flatResults(data.sets);
      if (!built) build();
      if (rows.length === 0 && cellEls.size === 0) {
        grid.innerHTML = '<div class="empty"><div>No live values returned.</div></div>';
      }
      for (const [k, v] of rows) {
        let cell = cellEls.get(k);
        if (!cell) {
          cell = document.createElement('div');
          cell.className = 'live-cell gauge-cell';
          cell.innerHTML = gaugeCellHTML(k);
          grid.appendChild(cell);
          cellEls.set(k, cell);
        }
        updateGauge(cell, k, v);
      }
      metaEl.textContent = `live · ${cellEls.size} values`;
      sbLeft.textContent = `${job} · live`;
    } catch (e) {
      stopLive();
      container.className = 'results-panel';
      container.innerHTML = errorBlock(e.message);
      sbLeft.textContent = 'failed';
    }
  }
  await tick();
  if (liveTok === _liveToken && container.querySelector('.live-grid')) scheduleLive(tick);
}

// multi-watch: poll several Status jobs together into one live grid, optionally
// streaming timestamped rows to CSV
let logId = null;          // active CSV log id from the main process
let logColumns = null;     // fixed column order while logging
function stopLogging() {
  if (logId && window.bmacw) window.bmacw.stopLog(logId);
  logId = null; logColumns = null;
}

let logStart = 0;
function highlightWatched(view, jobs) {
  const map = view && view._rowByJob;
  if (!map) return;
  map.forEach((row) => row.classList.remove('watching'));
  if (jobs) jobs.forEach((j) => map.get(j)?.classList.add('watching'));
}

// INPA-style gauge bars. EDIABAS gives a value (sometimes a unit); the min/max
// range and value/unit parsing come from measurements.js. non-numeric values
// render as plain text.

function gaugeCellHTML(key) {
  return `
    <div class="live-k">${esc(key)}</div>
    <div class="gauge">
      <div class="gauge-track"><div class="gauge-fill"></div></div>
      <div class="gauge-foot">
        <span class="gauge-min"></span>
        <span class="gauge-val live-v"></span>
        <span class="gauge-max"></span>
      </div>
    </div>`;
}

// update a gauge cell in place from a parsed measurement
function updateGauge(cellEl, key, raw) {
  const p = parseMeasurement(raw);
  const valEl = cellEl.querySelector('.gauge-val');
  // non-numeric: plain text, hide the bar
  if (p.num === null) {
    cellEl.classList.add('text-only');
    if (valEl.textContent !== p.raw) {
      valEl.textContent = p.raw;
      flash(valEl);
    }
    return;
  }
  cellEl.classList.remove('text-only');
  let [min, max] = rangeFor(p.unit, p.num, key);
  // expand the range if the live value blows past it (keeps the bar honest)
  if (p.num < min) min = p.num;
  if (p.num > max) max = p.num;
  const span = max - min || 1;
  const pct = Math.max(0, Math.min(100, ((p.num - min) / span) * 100));
  const fill = cellEl.querySelector('.gauge-fill');
  fill.style.width = pct.toFixed(1) + '%';
  cellEl.querySelector('.gauge-min').textContent = fmtRange(min);
  cellEl.querySelector('.gauge-max').textContent = fmtRange(max);
  // round long decimals for display (e.g. 8.969696969 -> 8.97), keep the unit
  const numStr = Number.isInteger(p.num) ? String(p.num)
    : (Math.abs(p.num) >= 100 ? p.num.toFixed(1) : p.num.toFixed(2));
  const shown = p.unit ? `${numStr} ${p.unit}` : numStr;
  if (valEl.textContent !== shown) {
    valEl.textContent = shown;
    flash(valEl);
  }
}

function flash(el) {
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

async function watchMulti(ecu, jobs, container, view) {
  stopLive();
  stopLogging();
  const liveTok = _liveToken;
  highlightWatched(view, jobs);

  // build the panel once; ticks only update value cells (no flicker)
  container.className = 'live-panel';
  container.innerHTML = `
    <div class="live-head">
      <span class="live-dot"></span>
      <span class="live-title">Watching ${jobs.length} job${jobs.length === 1 ? '' : 's'}</span>
      <span class="live-meta" id="live-meta">connecting…</span>
      <button class="btn live-log" id="live-log">Stream to file…</button>
      <button class="btn danger live-stop" id="live-stop">Stop</button>
    </div>
    <div class="live-grid" id="live-grid"></div>`;
  container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const grid = container.querySelector('#live-grid');
  const meta = container.querySelector('#live-meta');
  const dot = container.querySelector('.live-dot');
  const logBtn = container.querySelector('#live-log');
  const cellEls = new Map(); // key -> value <div> (updated in place)

  const stop = () => {
    stopLive(); stopLogging();
    highlightWatched(view, null);
    dot.classList.add('stopped');
    meta.textContent = 'stopped';
    container.querySelector('.live-title').textContent = `Stopped · ${jobs.length} job${jobs.length === 1 ? '' : 's'}`;
    logBtn.textContent = 'Stream to file…';
    sbLeft.textContent = 'stopped';
  };
  container.querySelector('#live-stop').onclick = stop;
  logBtn.onclick = () => toggleLogging();

  function toggleLogging() {
    if (!window.bmacw) { sbLeft.textContent = 'logging unavailable'; return; }
    if (logId) { stopLogging(); logBtn.textContent = 'Stream to file…'; meta.classList.remove('rec'); sbLeft.textContent = 'log saved'; return; }
    logColumns = [...cellEls.keys()];
    if (logColumns.length === 0) { sbLeft.textContent = 'no values yet'; return; }
    const header = ['timestamp_iso', 'elapsed_ms', ...logColumns];
    const name = `bmacw-${ecu.sgbd}-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.csv`;
    window.bmacw.startLog(name, header).then((res) => {
      if (res && res.ok) { logId = res.id; logStart = Date.now(); logBtn.textContent = 'Stop logging'; meta.classList.add('rec'); sbLeft.textContent = `logging → ${res.path.split('/').pop()}`; }
    });
  }

  async function readAll() {
    const merged = new Map();
    await Promise.all(jobs.map(async (job) => {
      try {
        const data = await api(`/api/ecu/${ecu.sgbd}/run/${job}`, { method: 'POST' });
        flatResults(data.sets).forEach(([k, v]) => merged.set(k, v));
      } catch { /* one job failing shouldn't kill the whole watch */ }
    }));
    return merged;
  }

  async function tick() {
    let merged;
    try { merged = await readAll(); }
    catch (e) {
      stop();
      meta.textContent = 'read failed';
      return;
    }
    // pair value+unit (STAT_x_WERT + STAT_x_EINH -> one reading), humanize key to
    // English, update each gauge cell in place
    const entries = pairWertEinh(merged);
    for (const e of entries) {
      let cell = cellEls.get(e.key);
      if (!cell) {
        cell = document.createElement('div');
        cell.className = 'live-cell gauge-cell';
        cell.innerHTML = gaugeCellHTML(e.label);
        grid.appendChild(cell);
        cellEls.set(e.key, cell);
      }
      // feed value + merged unit so the gauge shows "13 °C" and scales by unit
      updateGauge(cell, e.label, e.unit ? `${e.value} ${e.unit}` : e.value);
    }
    meta.textContent = `live · ${cellEls.size} values`;
    if (logId && logColumns) {
      window.bmacw.appendLog(logId, [new Date().toISOString(), String(Date.now() - logStart),
        ...logColumns.map(k => merged.has(k) ? merged.get(k) : '')]);
    }
  }

  await tick();
  if (liveTok === _liveToken) scheduleLive(tick);
}

// generic result renderer: one card per result set, key/value rows
function renderResultSets(sets, container, job) {
  if (!sets || sets.length === 0) {
    container.innerHTML = `<div class="empty"><div>No results from ${esc(job)}.</div></div>`;
    return;
  }
  container.className = 'results-panel stagger';
  container.innerHTML = '';
  // skip set 0 (system summary) when real sets follow
  const real = dataSets(sets);
  real.forEach((set, idx) => {
    const card = document.createElement('div');
    card.className = 'result-card';
    const rows = Object.entries(set)
      .filter(([k]) => !k.startsWith('_'))
      .map(([k, v]) => `<div class="kv"><span class="kv-k">${esc(k)}</span><span class="kv-v">${esc(v)}</span></div>`)
      .join('');
    card.innerHTML = `${real.length > 1 ? `<div class="result-head">set ${idx + 1}</div>` : ''}${rows}`;
    container.appendChild(card);
  });
  stagger(container, 30);
}
