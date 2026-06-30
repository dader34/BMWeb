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
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title">${title}</div>
        <div class="modal-body">${body}</div>
        <input class="modal-input" type="text" placeholder="${placeholder}" value="${value}" />
        <div class="modal-actions">
          <button class="btn modal-cancel">Cancel<span class="modal-key">Esc</span></button>
          <button class="btn primary modal-confirm">Run<span class="modal-key">⏎</span></button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    const input = overlay.querySelector('.modal-input');
    const close = (val) => { overlay.classList.remove('show'); window.removeEventListener('keydown', onKey, true); setTimeout(() => overlay.remove(), 160); resolve(val); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(input.value.trim() || null); }
    };
    window.addEventListener('keydown', onKey, true);
    overlay.querySelector('.modal-cancel').onclick = () => close(null);
    overlay.querySelector('.modal-confirm').onclick = () => close(input.value.trim() || null);
    overlay.onclick = (e) => { if (e.target === overlay) close(null); };
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
      const label = `${argName} <span class="arg-type">(${a.ARGTYPE || 'string'})</span>`;
      let note = !isEnum && hint ? `<div class="arg-hint">${hint}</div>` : '';
      if (isBinary) note += `<div class="arg-warn">Binary argument: enter raw hex (e.g. <span class="mono">01 00 0A ...</span>). Must be a valid pre-built buffer for this job, or it may fail or harm the ECU.</div>`;
      const placeholder = isBinary ? 'hex bytes, e.g. 01 00 0A' : (a.ARGTYPE === 'int' ? '0' : '');
      const field = isEnum
        ? `<select class="modal-input arg-field" data-i="${i}">${enumVals.map(v => `<option>${v}</option>`).join('')}</select>`
        : `<input class="modal-input arg-field" data-i="${i}" data-binary="${isBinary ? 1 : 0}" type="text" placeholder="${placeholder}" />`;
      return `<div class="arg-row"><label class="arg-label">${label}</label>${field}${note}</div>`;
    }).join('');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title">${jobLabel(job)}</div>
        <div class="modal-body">This job needs ${argSpecs.length} argument${argSpecs.length === 1 ? '' : 's'}.</div>
        <div class="arg-fields">${fieldHtml}</div>
        <div class="modal-actions">
          <button class="btn modal-cancel">Cancel<span class="modal-key">Esc</span></button>
          <button class="btn primary modal-confirm">Run<span class="modal-key">⏎</span></button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
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
    const close = (val) => { overlay.classList.remove('show'); window.removeEventListener('keydown', onKey, true); setTimeout(() => overlay.remove(), 160); resolve(val); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(collect()); }
    };
    window.addEventListener('keydown', onKey, true);
    overlay.querySelector('.modal-cancel').onclick = () => close(null);
    overlay.querySelector('.modal-confirm').onclick = () => close(collect());
    overlay.onclick = (e) => { if (e.target === overlay) close(null); };
    setTimeout(() => fields[0] && fields[0].focus(), 50);
  });
}

// run a job and render its result sets. FS_LESEN gets the fault-card view, others
// a generic key/value table.
async function runJob(ecu, job, container, danger, presetArg) {
  // resolve a required argument first. hand-tuned JOB_ARGS overrides win (they
  // encode special encodings like CBS_RESET's tail); otherwise ask the SGBD what
  // the job declares and build a dialog from that.
  let arg = presetArg;
  const spec = JOB_ARGS[job];
  if (arg == null && spec) {
    if (spec.fixed != null) arg = spec.fixed;
    else if (spec.prompt) {
      arg = await promptDialog({ title: jobLabel(job), body: spec.prompt, placeholder: spec.placeholder || '' });
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
    const ok = await confirmDialog({
      title: isClear ? 'Clear fault codes?' : `Run ${jobLabel(job)}?`,
      body: isClear
        ? `This permanently erases the fault memory on <b>${ecu.label}</b>. Stored and pending faults will be deleted. This cannot be undone.`
        : `<b>${jobLabel(job)}</b> (<span class="mono">${job}</span>) writes to the ECU on <b>${ecu.label}</b>. Continue?`,
      confirmLabel: isClear ? 'Clear codes' : 'Run',
      danger: true,
    });
    if (!ok) return;
  }
  container.innerHTML = `<div class="empty"><span class="loader"></span><span>Running ${jobLabel(job)}…</span></div>`;
  container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  sbLeft.textContent = `${job}…`;
  try {
    const q = arg != null && arg !== '' ? `?arg=${encodeURIComponent(arg)}` : '';
    const data = await api(`/api/ecu/${ecu.sgbd}/run/${job}${q}`, { method: 'POST' });
    if (job === 'FS_LESEN' || job === 'FS_LESEN_DETAIL') {
      const codes = data.sets.slice(1); // set 0 = system summary
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
  const job = screen.job;
  const arg = screen.args || '';
  const rows = screen.rows || [];
  // result-key -> layout row spec, for labels/scaling
  const spec = new Map(rows.map(r => [r.key, r]));

  container.className = 'live-panel';
  container.innerHTML = `
    <div class="live-head">
      <span class="live-dot"></span>
      <span class="live-title">${screen.group || jobLabel(job)}</span>
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
    const sets = data.sets || [];
    const real = sets.length > 1 ? sets.slice(1) : sets;
    const vals = new Map();
    real.forEach(s => Object.entries(s).forEach(([k, v]) => { if (!k.startsWith('_') && k !== 'JOB_STATUS') vals.set(k, v); }));

    // render in layout row order so Bank 1 / Bank 2 pair up in two columns
    for (const r of rows) {
      if (!vals.has(r.key)) continue;
      let cell = cellEls.get(r.key);
      if (!cell) {
        cell = document.createElement('div');
        cell.className = 'live-cell gauge-cell';
        cell.innerHTML = gaugeCellHTML(r.label || r.key);
        grid.appendChild(cell);
        cellEls.set(r.key, cell);
      }
      updateGaugeSpec(cell, r, vals.get(r.key));
    }
    meta.textContent = `live · ${cellEls.size} values`;
    sbLeft.textContent = `${job}${arg ? ' ' + arg : ''} · live`;
  }
  await tick();
  if (liveTimer === null && container.querySelector('.inpa-grid')) liveTimer = setInterval(tick, 1000);
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
let liveTimer = null;
function stopLive() { if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } }

async function runJobLive(ecu, job, container) {
  stopLive();
  container.className = 'results-panel';
  container.innerHTML = `<div class="empty"><span class="loader"></span><span>Reading ${jobLabel(job)}…</span></div>`;
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
        <span class="live-title">${jobLabel(job)}</span>
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
      const sets = data.sets || [];
      const real = sets.length > 1 ? sets.slice(1) : sets;
      // flatten named, non-internal results into ordered key/value pairs
      const rows = [];
      real.forEach(set => Object.entries(set).forEach(([k, v]) => {
        if (!k.startsWith('_') && k !== 'JOB_STATUS') rows.push([k, v]);
      }));
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
  if (liveTimer === null && container.querySelector('.live-grid')) liveTimer = setInterval(tick, 1000);
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

// INPA-style gauge bars. EDIABAS gives a value (sometimes a unit). the min/max
// range is INPA's own presentation choice from its .ips scripts, not in the
// protocol, so reproduce common ranges by unit and auto-scale the rest. non-numeric
// values render as plain text.

// split "38.67", "-5.7", "1.02 V", "98 %" into { num, unit, raw }
function parseMeasurement(raw) {
  const s = String(raw).trim();
  // number (optional sign/decimal/exponent) then optional unit token
  const m = s.match(/^(-?\d+(?:[.,]\d+)?(?:[eE][-+]?\d+)?)\s*(.*)$/);
  if (!m) return { num: null, unit: '', raw: s };
  const num = parseFloat(m[1].replace(',', '.'));
  if (!isFinite(num)) return { num: null, unit: '', raw: s };
  let unit = (m[2] || '').trim();
  if (/^grad/i.test(unit)) unit = '°';
  return { num, unit, raw: s };
}

// pick [min,max] for a measurement, by unit first (INPA's ranges), then by the
// value's magnitude as a fallback for uncatalogued units
function rangeFor(unit, num, key) {
  const u = (unit || '').toLowerCase();
  const k = (key || '').toLowerCase();
  // unit-based ranges cover most MSD/MSV/MEVD status screens
  if (u === '%') {
    // correction factors (adaption/trim) are symmetric about 0
    if (/(adaption|adaptionsfaktor|korrektur|integrator|trim|gemischadaption|einspritzzeit)/.test(k))
      return [-50, 50];
    return [0, 100];
  }
  if (u === 'mg/stk' || u === 'mg/hub') return [-700, 700];
  if (u === 'v') return [0, 16];
  if (u === '°' || u === '°c' || u === 'c') return [-40, 140];
  if (u === '°kw' || u === 'kw') return [-30, 60];   // crank-angle (timing/VANOS)
  if (u === '1/min' || u === 'rpm' || u === 'u/min') return [0, 8000];
  if (u === 'km/h') return [0, 260];
  if (u === 'mbar' || u === 'hpa') return [0, 2500];
  if (u === 'bar') return [0, 5];
  if (u === 'nm') return [0, 600];
  if (u === 'ms') return [0, 25];
  if (u === 'l/h') return [0, 60];
  if (u === 'a') return [-30, 30];
  if (u === 'ohm') return [0, 100];
  if (u === '' ) {
    // unitless: lambda sits near 1.0, flags are 0/1
    if (/lambda|lambdawert/.test(k)) return [0, 2];
    if (num === 0 || num === 1) return [0, 1];
  }
  // auto-scale around the observed value
  if (num === 0) return [0, 1];
  const mag = Math.abs(num);
  if (num < 0) return [-roundNice(mag * 2), roundNice(mag * 2)];
  return [0, roundNice(mag * 1.5)];
}

function roundNice(x) {
  if (x <= 1) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(x)));
  const n = x / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

function fmtRange(n) {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(Math.abs(n) < 10 ? 1 : 0);
}

// German measurement-key tokens -> English, for humanizing raw STAT_*_WERT keys
// on ECUs with no mined layout (e.g. GSDS2 transmission)
const KEY_TOKENS = {
  MOTOR: 'engine', MOTORDREHZAHL: 'engine RPM', DREHZAHL: 'RPM', ABTRIEBSDREHZAHL: 'output speed',
  STEGDREHZAHL: 'planetary speed', RADDREHZAHL: 'wheel speed', GETRIEBE: 'gearbox',
  GETRIEBETEMPERATUR: 'gearbox temp', MOTORTEMPERATUR: 'engine temp', TEMPERATUR: 'temperature',
  TEMP: 'temp', LAST: 'load', DKG: 'clutch', UBAT: 'battery voltage', SPANNUNG: 'voltage',
  DRUCK: 'pressure', LADEDRUCK: 'boost', GANG: 'gear', FAHRSTUFE: 'gear position',
  KUPPLUNG: 'clutch', BREMSE: 'brake', LAMBDA: 'lambda', GEMISCH: 'mixture',
  ZUENDUNG: 'ignition', EINSPRITZ: 'injection', OEL: 'oil', KUEHL: 'coolant',
  GESCHWINDIGKEIT: 'speed', POSITION: 'position', SOLL: 'target', IST: 'actual',
  VL: 'front-left', VR: 'front-right', HL: 'rear-left', HR: 'rear-right',
  EIN: '', AUS: '', STATUS: 'status', WERT: '',
};
// normalize an EDIABAS unit string to a compact symbol
function normUnit(u) {
  const s = String(u || '').trim();
  if (/^grad\s*c$/i.test(s) || /^°?\s*c$/i.test(s)) return '°C';
  if (/^grad$/i.test(s)) return '°';
  if (/^1\/min$/i.test(s) || /^u\/min$/i.test(s)) return '1/min';
  if (/^volt$/i.test(s)) return 'V';
  return s;
}
// STAT_MOTORTEMPERATUR_WERT -> "Engine temp"
function humanizeKey(key) {
  let k = String(key).replace(/^STAT_/, '').replace(/_WERT$|_EINH$/i, '');
  const words = k.split('_').map(tok => {
    const up = tok.toUpperCase();
    if (up in KEY_TOKENS) return KEY_TOKENS[up];
    return tok.charAt(0) + tok.slice(1).toLowerCase();
  }).filter(Boolean);
  const label = words.join(' ').replace(/\s+/g, ' ').trim();
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : key;
}

// pair STAT_X_WERT with STAT_X_EINH and humanize the key. one entry per
// measurement, unit merged in ("13" + "Grad C" -> "13 °C"). keys without
// _WERT/_EINH structure pass through unchanged.
function pairWertEinh(merged) {
  const out = [];
  const seen = new Set();
  const has = (k) => merged.has(k);
  for (const [k, v] of merged) {
    if (seen.has(k)) continue;
    const m = k.match(/^(.*)_WERT$/);
    if (m) {
      const base = m[1];
      const unitKey = base + '_EINH';
      const unit = has(unitKey) ? normUnit(merged.get(unitKey)) : '';
      if (has(unitKey)) seen.add(unitKey);
      seen.add(k);
      out.push({ key: k, label: humanizeKey(k), value: v, unit });
      continue;
    }
    // stray _EINH with no matching _WERT: show as text
    if (/_EINH$/.test(k)) { seen.add(k); out.push({ key: k, label: humanizeKey(k), value: merged.get(k), unit: '' }); continue; }
    seen.add(k);
    out.push({ key: k, label: humanizeKey(k), value: v, unit: '' });
  }
  return out;
}

function gaugeCellHTML(key) {
  return `
    <div class="live-k">${key}</div>
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
        const real = (data.sets || []).slice(1).length ? data.sets.slice(1) : (data.sets || []);
        real.forEach(set => Object.entries(set).forEach(([k, v]) => {
          if (!k.startsWith('_') && k !== 'JOB_STATUS') merged.set(k, v);
        }));
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
  liveTimer = setInterval(tick, 1000);
}

// generic result renderer: one card per result set, key/value rows
function renderResultSets(sets, container, job) {
  if (!sets || sets.length === 0) {
    container.innerHTML = `<div class="empty"><div>No results from ${job}.</div></div>`;
    return;
  }
  container.className = 'results-panel stagger';
  container.innerHTML = '';
  // skip set 0 (system summary) when real sets follow
  const real = sets.length > 1 ? sets.slice(1) : sets;
  real.forEach((set, idx) => {
    const card = document.createElement('div');
    card.className = 'result-card';
    const rows = Object.entries(set)
      .filter(([k]) => !k.startsWith('_'))
      .map(([k, v]) => `<div class="kv"><span class="kv-k">${k}</span><span class="kv-v">${v}</span></div>`)
      .join('');
    card.innerHTML = `${real.length > 1 ? `<div class="result-head">set ${idx + 1}</div>` : ''}${rows}`;
    container.appendChild(card);
  });
  stagger(container, 30);
}

// fixed German -> English fault phrases (symptom / presence / warning-lamp /
// readiness texts)
