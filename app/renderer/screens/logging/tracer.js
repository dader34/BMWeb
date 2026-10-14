/**
 * @file Logging > Replay, the Map view: a table out of the definition
 * loaded in Tuning, with where the run spent its time in it (dwell, a cell
 * at a time), or the mean of another reading over each cell, and the path
 * the run took across the table. The cells untouched by a drive stand out,
 * and a reading averaged over the table (lambda against its target, say)
 * says which cells want a change.
 *
 * The table's axes are matched to the run's readings through the cursor
 * map (which DME variable feeds the axis) and the value table (which
 * logged value is that variable); a table the map does not know falls back
 * to the axis's units and name. Both can be overridden from the viewer.
 *
 * Pure helpers first (node-tested), the drawing last.
 */
/* exported logTracerReady, logTracerRestore, logTracerRemembered, logTracerRemember, logTracerTables, logTracerDecode, logTracerMatch, logTracerBins, logTracerRender, LOG_TRACER_STEP_MAX_MS */

/** A gap between samples longer than this is not time in a cell: a stall, a reset. */
const LOG_TRACER_STEP_MAX_MS = 2000;

/**
 * What the Map view needs from the Tuning screen: a definition and an image.
 * @returns {{def: Object, bin: Uint8Array, header: Object}|null}
 */
function logTracerReady() {
  if (typeof tuningState === 'undefined') return null;
  const { def, bin } = tuningState;
  if (!def || !def.items || !def.header || !bin || !bin.length) return null;
  return { def, bin, header: def.header };
}

/**
 * Bring back the tune and definition the Tuning screen keeps between
 * visits, when that screen has not been opened this time: the Map view is
 * reached from the History, and the tables come from there.
 * @returns {Promise<boolean>} Whether the view has what it needs now.
 */
async function logTracerRestore() {
  if (logTracerReady()) return true;
  if (
    typeof tuningState === 'undefined' ||
    typeof TuningStore === 'undefined' ||
    typeof window.XDF === 'undefined' ||
    tuningState.bin ||
    tuningState.def
  )
    return false;
  let rec;
  try {
    rec = await TuningStore.loadSession();
  } catch (e) {
    return false;
  }
  if (!rec || !rec.bin || !rec.defText) return false;
  try {
    tuningState.def = window.XDF.parseXdf(rec.defText);
  } catch (e) {
    return false;
  }
  // the same fields the Tuning screen restores, so entering it later finds
  // the session whole (it restores nothing once an image is loaded)
  tuningState.bin = rec.bin;
  tuningState.orig = rec.orig || rec.bin.slice();
  tuningState.fileName = rec.fileName || 'firmware.bin';
  tuningState.defText = rec.defText;
  tuningState.defName = rec.defName || 'definition.xdf';
  tuningState.filter = rec.filter || '';
  tuningState.coverOn = rec.coverOn !== false;
  tuningState.kinds = rec.kinds && rec.kinds.length ? new Set(rec.kinds) : null;
  tuningState.openCats = rec.openCats ? new Set(rec.openCats) : null;
  tuningState.history = Array.isArray(rec.history) ? rec.history : [];
  tuningState.redo = Array.isArray(rec.redo) ? rec.redo : [];
  return !!logTracerReady();
}

/** Where the Map view keeps the readings picked for a table's axes. */
const LOG_TRACER_PICKS_KEY = 'bmweb.logging.map.axes';

/**
 * The readings (by series key) last picked for a table's axes, if any.
 * @param {number|null} offset - The table's calibration offset.
 * @returns {{x?: string, y?: string}}
 */
function logTracerRemembered(offset) {
  if (offset == null) return {};
  try {
    const all = JSON.parse(localStorage.getItem(LOG_TRACER_PICKS_KEY) || '{}');
    return all[offset.toString(16)] || {};
  } catch (e) {
    return {};
  }
}

/**
 * Remember a pick for a table's axis.
 * @param {number|null} offset
 * @param {'x'|'y'} which
 * @param {string|null} key - The series key, or null to forget.
 * @returns {void}
 */
function logTracerRemember(offset, which, key) {
  if (offset == null) return;
  try {
    const all = JSON.parse(localStorage.getItem(LOG_TRACER_PICKS_KEY) || '{}');
    const id = offset.toString(16);
    all[id] = all[id] || {};
    if (key) all[id][which] = key;
    else delete all[id][which];
    localStorage.setItem(LOG_TRACER_PICKS_KEY, JSON.stringify(all));
  } catch (e) {
    /* no storage: not remembered */
  }
}

/**
 * The tables worth tracing: those with an axis read from the image, named
 * the Comfort way when the Comfort list knows them.
 * @param {Object} def - The loaded definition.
 * @returns {Array<{item: Object, label: string}>}
 */
function logTracerTables(def) {
  const labels = new Map();
  const comfort =
    typeof tnComfortFor === 'function' ? tnComfortFor(def) : def.comfortList;
  if (comfort)
    for (const g of comfort)
      for (const s of g.subjects)
        for (const r of s.rows) labels.set(r.item, r.label);
  const out = [];
  for (const it of def.items) {
    if (it.kind !== 'table' || !it.axes) continue;
    const sized = it.axes.some(
      (a) => (a.id === 'x' || a.id === 'y') && a.embed && a.embed.address
    );
    if (!sized) continue;
    out.push({ item: it, label: labels.get(it) || it.title || '' });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * One axis as the tracer needs it: its break points as numbers, where its
 * first one lies in the calibration, its units and name.
 * @param {Object|undefined} axis
 * @param {number} count
 * @param {Object} header
 * @returns {{points: number[], first: number|null, units: string, title: string}|null}
 */
function logTracerAxis(axis, count, header) {
  if (!axis || count <= 1) return null;
  const labels =
    typeof tnAxisLabels === 'function'
      ? tnAxisLabels(axis, count, header)
      : new Array(count).fill(null);
  const points = labels.map((l) => {
    const n = parseFloat(String(l == null ? '' : l).replace(',', '.'));
    return Number.isFinite(n) ? n : NaN;
  });
  let first = null;
  if (axis.embed && axis.embed.address && typeof TN_CAL_START !== 'undefined') {
    const spec = window.XDF.resolveEmbedded(
      axis.embed,
      header.baseOffset,
      header.defaults
    );
    first = spec.address - TN_CAL_START;
  }
  return {
    points,
    first,
    units: axis.units || '',
    title: axis.title || axis.id || '',
  };
}

/**
 * A table decoded for tracing.
 * @param {Object} item - The table.
 * @returns {{rows: number, cols: number, cells: Array<Array<number|null>>,
 *   offset: number|null, dp: number, units: string, x: Object|null, y: Object|null}|null}
 */
function logTracerDecode(item) {
  const ready = logTracerReady();
  if (!ready) return null;
  const t = window.XDF.decodeTable(item, ready.bin, ready.header);
  if (!t) return null;
  const range =
    typeof tnItemByteRange === 'function' ? tnItemByteRange(item) : null;
  return {
    rows: t.rows,
    cols: t.cols,
    cells: t.cells,
    offset:
      range && typeof TN_CAL_START !== 'undefined'
        ? range.start - TN_CAL_START
        : null,
    dp: t.z && t.z.decimalpl != null ? t.z.decimalpl : 2,
    units: (t.z && t.z.units) || '',
    x: logTracerAxis(t.x, t.cols, ready.header),
    y: logTracerAxis(t.y, t.rows, ready.header),
  };
}

/** The reading an axis usually is, by its units and name, when nothing traced it. */
const LOG_TRACER_GUESSES = [
  [/rpm|1\/min|min-1/i, /./, /engine speed|drehzahl/i],
  [/%/, /load|last|\brl\b|fuel/i, /engine load/i],
  [/%/, /pedal|pwg|accel/i, /accelerator pedal/i],
  [/°|deg/i, /throttle|dk\b|drossel/i, /throttle position/i],
  [/°c|grad/i, /cool|tmot|water|motor/i, /^coolant/i],
  [/°c|grad/i, /oil|toel/i, /^oil/i],
  [/°c|grad/i, /air|tans|intake|ansaug/i, /intake air/i],
  [/km\/h|kmh/i, /./, /vehicle speed/i],
  [/mg|kg\/h/i, /air|luft|rl\b/i, /air per stroke|air mass/i],
  [/hpa|mbar|kpa/i, /./, /manifold pressure|ambient pressure/i],
  [/\bv\b/i, /batt|ubat|volt/i, /battery voltage/i],
  [/ms/i, /inj|ti\b|einspritz/i, /injection time/i],
];

/**
 * Which of the run's readings each axis is: by the cursor map and the
 * value table where the DME traced them, by units and name otherwise.
 * @param {ReturnType<typeof logTracerDecode>} d
 * @param {{series: Array<{label: string, key: string, unit: string}>}} log
 * @returns {{x: number, y: number}} Series indexes, -1 when unmatched.
 */
function logTracerMatch(d, log) {
  const byKey = new Map(log.series.map((s, i) => [s.key, i]));
  const traced = [-1, -1];
  if (
    d.offset != null &&
    typeof MS45_CURSOR_MAP !== 'undefined' &&
    typeof MS45_VALUE_MAP !== 'undefined' &&
    typeof ltCursorInputs === 'function'
  ) {
    const inputs = ltCursorInputs(MS45_CURSOR_MAP, d.offset, [
      d.x ? d.x.first : null,
      d.y ? d.y.first : null,
    ]);
    inputs.forEach((v, k) => {
      if (!v) return;
      for (const [id, spec] of Object.entries(MS45_VALUE_MAP.values)) {
        if (spec[0] !== v.address) continue;
        const key = `MW${Number(id).toString(16).toUpperCase().padStart(4, '0')}_WERT`;
        if (byKey.has(key)) {
          traced[k] = byKey.get(key);
          return;
        }
      }
    });
  }
  const guess = (axis) => {
    if (!axis) return -1;
    for (const [units, title, label] of LOG_TRACER_GUESSES) {
      if (!units.test(axis.units) || !title.test(axis.title)) continue;
      const i = log.series.findIndex((s) => label.test(s.label));
      if (i >= 0) return i;
    }
    return -1;
  };
  return {
    x: traced[0] >= 0 ? traced[0] : guess(d.x),
    y: traced[1] >= 0 ? traced[1] : guess(d.y),
  };
}

/**
 * The run binned over the table: how long it spent in each cell, the mean
 * of a reading there, and the path it took.
 * @param {{series: Array<{t: number[], v: number[]}>}} log
 * @param {{rows: number, cols: number, x: {points: number[]}|null, y: {points: number[]}|null}} d
 * @param {number} xi - Series index driving the columns, -1 for a one-column table.
 * @param {number} yi - Series index driving the rows, -1 for a one-row table.
 * @param {number} zi - Series index to average, -1 for dwell only.
 * @param {number} from - Time window start.
 * @param {number} to - Time window end.
 * @returns {{dwell: Float64Array, mean: Float64Array|null, total: number,
 *   path: Array<{col: number, row: number, t: number}>}|null}
 *   `dwell` and `mean` are rows*cols, row-major; `mean` holds NaN where the
 *   run never was. null when neither axis has a reading.
 */
function logTracerBins(log, d, xi, yi, zi, from, to) {
  const xs = xi >= 0 ? log.series[xi] : null;
  const ys = yi >= 0 ? log.series[yi] : null;
  const lead = xs || ys;
  if (!lead) return null;
  const n = d.rows * d.cols;
  const dwell = new Float64Array(n);
  const sum = zi >= 0 ? new Float64Array(n) : null;
  const weight = zi >= 0 ? new Float64Array(n) : null;
  const zs = zi >= 0 ? log.series[zi] : null;
  const path = [];
  let total = 0;
  const place = (axis, series, t, k, count) => {
    if (count <= 1 || !axis) return 0;
    const v = series === lead ? series.v[k] : logReplayValueAt(series, t);
    const p = ltAxisPosition(v, axis.points);
    return p ? Math.min(count - 1, Math.max(0, p.index)) : null;
  };
  for (let k = 0; k < lead.t.length; k++) {
    const t = lead.t[k];
    if (t < from || t > to) continue;
    const next = k + 1 < lead.t.length ? lead.t[k + 1] : t;
    const dt = Math.min(LOG_TRACER_STEP_MAX_MS, Math.max(0, next - t)) / 1000;
    const col = xs ? place(d.x, xs, t, k, d.cols) : 0;
    const row = ys ? place(d.y, ys, t, k, d.rows) : 0;
    if (col == null || row == null) continue;
    path.push({ col, row, t });
    const cell = Math.round(row) * d.cols + Math.round(col);
    dwell[cell] += dt;
    total += dt;
    if (zs) {
      const z = logReplayValueAt(zs, t);
      if (z != null && Number.isFinite(z)) {
        sum[cell] += z * dt;
        weight[cell] += dt;
      }
    }
  }
  let mean = null;
  if (sum) {
    mean = new Float64Array(n);
    for (let i = 0; i < n; i++)
      mean[i] = weight[i] > 0 ? sum[i] / weight[i] : NaN;
  }
  return { dwell, mean, total, path };
}

/**
 * Show the table with the run over it, as a grid like the tuning page's:
 * the axis break points as headers, the cells heat-coloured by the table's
 * own values the way the editor paints them, the time spent in a cell (or
 * the mean of the chosen reading) as a badge in its corner with a tint to
 * match, and the run's path and the cursor's cell drawn on a canvas laid
 * over the grid. The grid is built once per table; the badges, tints and
 * path are redrawn on every call.
 * @param {HTMLElement} host - The map pane: a scroll box with the table and the overlay.
 * @param {ReturnType<typeof logTracerDecode>} d
 * @param {ReturnType<typeof logTracerBins>} bins
 * @param {{viewFrom: number, viewTo: number, cursor: number, mean: boolean,
 *   fmt: (v: number) => string, onCell?: (row: number, col: number) => void}} o
 * @returns {void}
 */
function logTracerRender(host, d, bins, o) {
  let table = host.querySelector('table');
  let overlay = host.querySelector('canvas');
  if (!table || host.dataset.for !== String(d.offset)) {
    host.innerHTML = '';
    table = document.createElement('table');
    table.className = 'tn-table log-tracer-table';
    const heat = { lo: Infinity, hi: -Infinity };
    for (const row of d.cells)
      for (const v of row)
        if (v != null && Number.isFinite(v)) {
          if (v < heat.lo) heat.lo = v;
          if (v > heat.hi) heat.hi = v;
        }
    const span = heat.hi - heat.lo;
    let html = '<thead><tr><th class="tn-corner">';
    html +=
      (d.y
        ? `<span class="tn-corner-y">${esc(d.y.units || 'y')} ↓</span>`
        : '') +
      (d.x
        ? `<span class="tn-corner-x">${esc(d.x.units || 'x')} →</span>`
        : '');
    html += '</th>';
    for (let c = 0; c < d.cols; c++) {
      const p = d.x ? d.x.points[c] : NaN;
      html += `<th>${Number.isFinite(p) ? esc(o.fmt(p)) : ''}</th>`;
    }
    html += '</tr></thead><tbody>';
    for (let r = 0; r < d.rows; r++) {
      const p = d.y ? d.y.points[r] : NaN;
      html += `<tr><th class="tn-rowhead">${Number.isFinite(p) ? esc(o.fmt(p)) : ''}</th>`;
      for (let c = 0; c < d.cols; c++) {
        const v = d.cells[r] ? d.cells[r][c] : null;
        const ok = v != null && Number.isFinite(v);
        const hc = ok
          ? heatColor(span > 0 ? (v - heat.lo) / span : 0)
          : { bg: '', ink: '' };
        html += `<td data-r="${r}" data-c="${c}"><div class="log-tracer-cell" style="background:${hc.bg};color:${hc.ink}"><span class="log-tracer-v">${ok ? esc(fmtNum(v, d.dp)) : ''}</span><span class="log-tracer-b"></span></div></td>`;
      }
      html += '</tr>';
    }
    html += '</tbody>';
    table.innerHTML = html;
    host.appendChild(table);
    overlay = document.createElement('canvas');
    overlay.className = 'log-tracer-path';
    host.appendChild(overlay);
    host.dataset.for = String(d.offset);
    table.onclick = (e) => {
      const td = e.target.closest('td');
      if (td && o.onCell) o.onCell(Number(td.dataset.r), Number(td.dataset.c));
    };
  }
  // the badges and tints
  let peak = 0;
  let spread = 0;
  if (bins) {
    for (const v of bins.dwell) if (v > peak) peak = v;
    if (bins.mean)
      for (const v of bins.mean)
        if (Number.isFinite(v) && Math.abs(v) > spread) spread = Math.abs(v);
  }
  const cursorCell = (() => {
    if (!bins) return null;
    let last = null;
    for (const p of bins.path) {
      if (p.t > o.cursor) break;
      last = p;
    }
    return last ? { r: Math.round(last.row), c: Math.round(last.col) } : null;
  })();
  for (const td of table.tBodies[0].querySelectorAll('td')) {
    const r = Number(td.dataset.r);
    const c = Number(td.dataset.c);
    const i = r * d.cols + c;
    const cell = td.firstChild;
    const badge = cell.lastChild;
    let text = '';
    let tint = '';
    if (bins && bins.mean) {
      const m = bins.mean[i];
      if (Number.isFinite(m)) {
        const f = spread > 0 ? Math.min(1, Math.abs(m) / spread) : 0;
        tint =
          m >= 0
            ? `rgba(255, 96, 64, ${0.2 + 0.6 * f})`
            : `rgba(80, 150, 255, ${0.2 + 0.6 * f})`;
        text = o.fmt(m);
      }
    } else if (bins && bins.dwell[i] > 0) {
      const f = peak > 0 ? Math.sqrt(bins.dwell[i] / peak) : 0;
      tint = `rgba(255, 255, 255, ${0.15 + 0.45 * f})`;
      text = `${bins.dwell[i].toFixed(bins.dwell[i] < 10 ? 1 : 0)}s`;
    }
    if (badge.textContent !== text) badge.textContent = text;
    cell.style.boxShadow = tint ? `inset 0 0 0 2px ${tint}` : '';
    cell.classList.toggle('log-tracer-off', !!bins && !text);
    td.classList.toggle(
      'log-tracer-here',
      !!cursorCell && cursorCell.r === r && cursorCell.c === c
    );
    td.title = text
      ? bins.mean
        ? `mean ${text} here`
        : `${text} spent here`
      : bins
        ? 'the run was never here'
        : '';
  }
  // the legend, under the grid
  let legend = host.querySelector('.log-tracer-legend');
  if (!legend) {
    legend = document.createElement('div');
    legend.className = 'log-tracer-legend';
    host.appendChild(legend);
  }
  const text = !bins
    ? 'pick the readings that drive the axes'
    : o.mean
      ? 'cells outlined by the mean of the reading there: red above zero, blue below, stronger with size · click a cell to go to it'
      : 'cells badged with the time spent there, outlined brighter the longer · click a cell to go to it';
  if (legend.textContent !== text) legend.textContent = text;
  // the path, over the grid
  const w = table.offsetWidth;
  const h = table.offsetHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  overlay.style.width = `${w}px`;
  overlay.style.height = `${h}px`;
  if (overlay.width !== Math.round(w * dpr))
    overlay.width = Math.round(w * dpr);
  if (overlay.height !== Math.round(h * dpr))
    overlay.height = Math.round(h * dpr);
  const g = overlay.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (!bins || !bins.path.length) return;
  const first = table.tBodies[0].rows[0];
  if (!first || first.cells.length < 2) return;
  const cell0 = first.cells[1];
  const cw = cell0.offsetWidth;
  const ch = cell0.offsetHeight;
  const ox = cell0.offsetLeft;
  const oy = cell0.offsetTop;
  const at = (p) => [ox + (p.col + 0.5) * cw, oy + (p.row + 0.5) * ch];
  g.strokeStyle = 'rgba(255, 255, 255, 0.45)';
  g.lineWidth = 1.25;
  g.lineJoin = 'round';
  g.beginPath();
  let drawn = false;
  let last = null;
  for (const p of bins.path) {
    if (p.t < o.viewFrom || p.t > o.viewTo) continue;
    const [x, y] = at(p);
    if (!drawn) g.moveTo(x, y);
    else g.lineTo(x, y);
    drawn = true;
    if (p.t <= o.cursor) last = p;
  }
  g.stroke();
  if (last) {
    const [x, y] = at(last);
    g.fillStyle = '#ff6040';
    g.beginPath();
    g.arc(x, y, 5, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#fff';
    g.lineWidth = 1.5;
    g.stroke();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    LOG_TRACER_STEP_MAX_MS,
    logTracerTables,
    logTracerMatch,
    logTracerBins,
  };
}
