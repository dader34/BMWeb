/**
 * @file Data logging: a run kept in the History, and looked at again there.
 *
 * The Logging page shows a run as it happens, one card a reading, over a
 * window that slides. What a log is FOR comes afterwards: putting two
 * readings over each other, finding the moment something happened, going
 * through it slowly. So a run that is paused is saved, whole, as an entry in
 * the app's History (core/flash-history.js), and opening it there gives the
 * other view of it: every reading on one time axis, a cursor that reads all
 * of them at once, and playback.
 *
 * This file is both halves: taking the run out of the store (logSnapshot,
 * logSaveToHistory) and the viewer (logReplayOpen). The arithmetic in
 * between -- the value at a time, the shared scales, the CSV -- has no page
 * in it and is tested on its own.
 */

/* exported logReplayPanes, logReplayStats, logReplayTicks, logSnapshot, logSaveToHistory, logReplayOpen, logReplayCsv, logReplayValueAt, logReplayScales, logReplayClock */

/**
 * @typedef {Object} ReplaySeries
 * @property {string} label - The reading's plain name.
 * @property {string} unit
 * @property {string} sgbd
 * @property {string} job
 * @property {string} key
 * @property {number[]} t - Sample times, ms since the epoch, rising.
 * @property {number[]} v - The values, one a time.
 */
/**
 * @typedef {Object} ReplayLog
 * @property {number} from - First sample's time.
 * @property {number} to - Last sample's time.
 * @property {ReplaySeries[]} series
 */

/** The History's name for a saved logging run. */
const LOG_HISTORY_OPERATION = 'data-log';
/** Colours for the overlaid traces: told apart on the app's dark panels. */
const LOG_REPLAY_COLOURS = [
  '#f4d35e',
  '#5ec8f4',
  '#f47a5e',
  '#8be28b',
  '#c79bf2',
  '#f2a65a',
  '#5ef4d0',
  '#f25e9c',
  '#b5c45a',
  '#8fa3ff',
  '#e0e0e0',
  '#d98a6a',
];
/** Playback speeds offered. */
const LOG_REPLAY_SPEEDS = [0.5, 1, 2, 4, 8];
/** How much the view scales per unit the wheel turns (about 4% a notch). */
const LOG_REPLAY_WHEEL_RATE = 0.0008;
/** How far an arrow key slides the view, as a share of what is in view. */
const LOG_REPLAY_KEY_STEP = 0.1;
/** The views of a run: id, name on its button, what it is. */
const LOG_REPLAY_MODES = [
  ['single', 'Single', 'Every channel on one plot'],
  ['split', 'Split', 'A pane a unit, on one time axis'],
  ['scatter', 'Scatter', 'One channel against another'],
  ['raw', 'Raw', 'The samples as a table'],
];
/** The most rows the Raw table is built with: more are thinned. */
const LOG_REPLAY_RAW_ROWS = 1500;
/** The narrowest stretch of a log the time axis zooms in to. */
const LOG_REPLAY_MIN_SPAN_MS = 500;

/**
 * A run out of the store: every reading's samples between two times.
 * @param {{series: Map<string, {t: number[], v: number[], unit?: string}>, meta: Map<string, {sgbd: string, job: string, key: string, label: string}>}} store
 * @param {number} from - Earliest time kept.
 * @param {number} to - Latest time kept.
 * @returns {ReplayLog|null} null when nothing was sampled in that stretch.
 */
function logSnapshot(store, from, to) {
  const series = [];
  let first = Infinity;
  let last = -Infinity;
  for (const [id, ring] of store.series) {
    const meta = store.meta.get(id);
    if (!meta) continue;
    const t = [];
    const v = [];
    for (let i = 0; i < ring.t.length; i++) {
      if (ring.t[i] < from || ring.t[i] > to) continue;
      t.push(ring.t[i]);
      v.push(ring.v[i]);
    }
    if (!t.length) continue;
    first = Math.min(first, t[0]);
    last = Math.max(last, t[t.length - 1]);
    series.push({
      label: meta.label,
      unit: ring.unit || '',
      sgbd: meta.sgbd,
      job: meta.job,
      key: meta.key,
      t,
      v,
    });
  }
  return series.length ? { from: first, to: last, series } : null;
}

/**
 * Keep a run in the History.
 * @param {ReplayLog} log
 * @param {{chassis?: string, module?: string}} [about]
 * @returns {Promise<object|null>} The entry, or null when there is no History
 *   to keep it in.
 */
async function logSaveToHistory(log, about = {}) {
  if (typeof flashHistory === 'undefined' || !log) return null;
  const seconds = Math.round((log.to - log.from) / 100) / 10;
  const samples = Math.max(...log.series.map((s) => s.t.length));
  // intervals, not samples: three samples span two of them
  const rate = seconds > 0 && samples > 1 ? (samples - 1) / seconds : 0;
  const names = log.series.map((s) => s.label);
  const entry = {
    started: log.from,
    seconds,
    operation: LOG_HISTORY_OPERATION,
    vin: about.chassis || '',
    module: about.module || '',
    details:
      `${log.series.length} reading${log.series.length === 1 ? '' : 's'}` +
      (rate ? ` at ${rate.toFixed(rate < 10 ? 1 : 0)}/s` : '') +
      `: ${names.slice(0, 4).join(', ')}${names.length > 4 ? ', …' : ''}`,
    status: names.join(' · '),
    result: 'saved',
    dataLog: log,
  };
  await flashHistory._append(entry);
  return entry;
}

/**
 * A reading's value at a time: the latest sample at or before it (what the
 * car had last said), the first sample for a time before any.
 * @param {{t: number[], v: number[]}} s
 * @param {number} time
 * @returns {number|null} null for a series with no samples.
 */
function logReplayValueAt(s, time) {
  const n = s.t.length;
  if (!n) return null;
  if (time <= s.t[0]) return s.v[0];
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s.t[mid] <= time) lo = mid;
    else hi = mid - 1;
  }
  return s.v[lo];
}

/**
 * The value scale each reading is drawn to. Readings in the same unit share
 * one, so two of a kind (both front oxygen sensors) can be compared by eye;
 * a reading with no unit, or the only one in its unit, has its own.
 * @param {ReplaySeries[]} series
 * @returns {Array<{lo: number, hi: number}>} One per series, in order.
 */
function logReplayScales(series) {
  const byUnit = new Map();
  const own = series.map((s) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of s.v) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (s.unit) {
      const u = byUnit.get(s.unit) || { lo: Infinity, hi: -Infinity };
      u.lo = Math.min(u.lo, lo);
      u.hi = Math.max(u.hi, hi);
      byUnit.set(s.unit, u);
    }
    return { lo, hi };
  });
  return series.map((s, i) => {
    const r = s.unit ? byUnit.get(s.unit) : own[i];
    // a flat reading still needs a band to be drawn in
    if (!(r.hi > r.lo)) {
      const pad = Math.abs(r.lo) > 1 ? Math.abs(r.lo) * 0.05 : 0.5;
      return { lo: r.lo - pad, hi: r.hi + pad };
    }
    const pad = (r.hi - r.lo) * 0.06;
    return { lo: r.lo - pad, hi: r.hi + pad };
  });
}

/**
 * A time into the log as minutes:seconds.tenths.
 * @param {number} ms
 * @returns {string}
 */
function logReplayClock(ms) {
  const tenths = Math.max(0, Math.round(ms / 100));
  const m = Math.floor(tenths / 600);
  const s = Math.floor((tenths % 600) / 10);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${tenths % 10}`;
}

/**
 * The log as a CSV: a row a sample time, a column a reading, each cell the
 * value sampled at exactly that time (blank when that reading was not).
 * @param {ReplayLog} log
 * @returns {string}
 */
function logReplayCsv(log) {
  const times = new Set();
  for (const s of log.series) for (const t of s.t) times.add(t);
  const rows = [...times].sort((a, b) => a - b);
  const at = log.series.map((s) => {
    const m = new Map();
    for (let i = 0; i < s.t.length; i++) m.set(s.t[i], s.v[i]);
    return m;
  });
  const q = (text) => `"${String(text).replace(/"/g, '""')}"`;
  const lines = [
    ['time', 'seconds']
      .concat(
        log.series.map((s) => q(s.label + (s.unit ? ` [${s.unit}]` : '')))
      )
      .join(','),
  ];
  for (const t of rows)
    lines.push(
      [new Date(t).toISOString(), ((t - log.from) / 1000).toFixed(3)]
        .concat(at.map((m) => (m.has(t) ? String(m.get(t)) : '')))
        .join(',')
    );
  return lines.join('\r\n') + '\r\n';
}

/**
 * A reading's lowest, highest and mean value over a stretch of the run.
 * @param {{t: number[], v: number[]}} s
 * @param {number} from
 * @param {number} to
 * @returns {{min: number, max: number, avg: number, n: number}|null} null
 *   when it was not sampled in that stretch.
 */
function logReplayStats(s, from, to) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < s.t.length; i++) {
    if (s.t[i] < from || s.t[i] > to) continue;
    const v = s.v[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    n++;
  }
  return n ? { min, max, avg: sum / n, n } : null;
}

/**
 * Round steps for an axis: about `n` of them across lo..hi.
 * @param {number} lo
 * @param {number} hi
 * @param {number} n
 * @returns {number[]}
 */
function logReplayTicks(lo, hi, n) {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const raw = span / Math.max(1, n);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((k) => k * mag).find((k) => k >= raw);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step)
    out.push(Math.abs(v) < step * 1e-6 ? 0 : v);
  return out;
}

/**
 * The panes of the split view: the shown channels that share a unit share a
 * pane (and a scale), a channel with no unit has one to itself.
 * @param {ReplaySeries[]} series
 * @param {boolean[]} shown
 * @returns {number[][]} Each pane's channels, by index, in list order.
 */
function logReplayPanes(series, shown) {
  const panes = [];
  const byUnit = new Map();
  series.forEach((s, i) => {
    if (!shown[i]) return;
    if (s.unit && byUnit.has(s.unit)) return byUnit.get(s.unit).push(i);
    const pane = [i];
    panes.push(pane);
    if (s.unit) byUnit.set(s.unit, pane);
  });
  return panes;
}

/**
 * Show a saved run the way a log viewer does: the channels listed down the
 * left with their figures, the run drawn beside them, and a crosshair that
 * reads every channel at once. Four views of the same run:
 *
 *   Single    every channel over the others on one plot
 *   Split     a pane a unit, stacked on one time axis, each with its scale
 *   Scatter   one channel against another instead of against time
 *   Raw       the samples themselves, a row a moment
 *
 *   move over the plot      the crosshair follows and reads the values
 *   drag across it          zoom to that stretch (Reset zoom, or double click)
 *   shift + drag            slide the zoomed stretch along
 *   wheel                   zoom about the pointer
 *   left / right            slide the zoomed stretch (shift: further)
 *   click a channel's name  Single: its scale is the one on the left axis;
 *                           Scatter: it is the one plotted
 *
 * @param {HTMLElement} host - Emptied and filled.
 * @param {ReplayLog} log
 * @param {{title?: string, onClose?: () => void, save?: (name: string, text: string) => void}} [opts]
 * @returns {{close: () => void}}
 */
function logReplayOpen(host, log, opts = {}) {
  const span = Math.max(1, log.to - log.from);
  // Over time, channels in one unit share a scale so they can be compared.
  // Against each other (Scatter) each fills the plot on its own: a target
  // that moves 90 rpm, drawn to the scale of an engine that moves 8000, is
  // a flat line along the bottom.
  const sharedScales = logReplayScales(log.series);
  const ownScales = logReplayScales(
    log.series.map((s) => ({ ...s, unit: '' }))
  );
  const whole = log.series.map((s) => logReplayStats(s, log.from, log.to));
  const colour = (i) => LOG_REPLAY_COLOURS[i % LOG_REPLAY_COLOURS.length];
  const state = {
    mode: 'split',
    cursor: log.from,
    viewFrom: log.from,
    viewTo: log.to,
    shown: log.series.map(() => true),
    focus: 0, // Single: the channel whose scale the left axis shows
    xAxis: 0, // Scatter: the channel the others are drawn against
    playing: false,
    speed: 1,
    raf: 0,
    lastFrame: 0,
    drag: null, // {x0, x1, t0, pan, from, to} while the button is down on the plot
    rawKey: '', // what the Raw table was last built for
    closed: false,
  };

  host.innerHTML = `
    <div class="log-replay">
      <div class="log-replay-bar">
        <button type="button" class="btn primary log-replay-play">Play</button>
        <span class="seg log-replay-speeds">${LOG_REPLAY_SPEEDS.map(
          (s) =>
            `<button type="button" class="seg-btn${s === 1 ? ' active' : ''}" data-speed="${s}">${s}×</button>`
        ).join('')}</span>
        <input type="range" class="log-replay-scrub" min="0" max="1000" value="0" aria-label="Position in the log" />
        <span class="log-replay-clock"></span>
        <span class="log-replay-title">${esc(opts.title || '')}</span>
        <span class="seg log-replay-modes">${LOG_REPLAY_MODES.map(
          ([id, name, about]) =>
            `<button type="button" class="seg-btn" data-mode="${id}" title="${esc(about)}">${name}</button>`
        ).join('')}</span>
        <button type="button" class="btn log-replay-reset" disabled>Reset zoom</button>
        <button type="button" class="btn log-replay-csv">Export CSV</button>
        <button type="button" class="btn log-replay-close" aria-label="Close">×</button>
      </div>
      <div class="log-replay-body">
        <div class="log-replay-side">
          <div class="log-replay-sidebar log-replay-xrow" hidden>
            <span class="log-replay-x-label">X axis</span>
            <span class="log-replay-x-slot"></span>
          </div>
          <div class="log-replay-sidebar">
            <span class="log-replay-x-label">Channels</span>
            <span class="log-replay-fill"></span>
            <button type="button" class="btn log-replay-all">All</button>
            <button type="button" class="btn log-replay-none">None</button>
          </div>
          <div class="log-replay-legend"></div>
        </div>
        <div class="log-replay-plot">
          <canvas></canvas>
          <div class="log-replay-raw" hidden></div>
          <div class="log-replay-tip" hidden></div>
          <div class="log-replay-hint">drag to zoom · ← → to slide</div>
        </div>
      </div>
    </div>`;
  const q = (sel) => host.querySelector(sel);
  const playBtn = q('.log-replay-play');
  const resetBtn = /** @type {HTMLButtonElement} */ (q('.log-replay-reset'));
  const scrub = /** @type {HTMLInputElement} */ (q('.log-replay-scrub'));
  const clock = q('.log-replay-clock');
  const plot = q('.log-replay-plot');
  const canvas = /** @type {HTMLCanvasElement} */ (q('canvas'));
  const rawEl = q('.log-replay-raw');
  const tip = q('.log-replay-tip');
  const hint = q('.log-replay-hint');
  const legend = q('.log-replay-legend');
  const xRow = q('.log-replay-xrow');

  const fmt = (v) => {
    if (v == null || !Number.isFinite(v)) return '–';
    const a = Math.abs(v);
    return v.toFixed(a >= 1000 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3);
  };

  // ---- the channel list: a row a reading -------------------------------------
  legend.innerHTML = log.series
    .map(
      (s, i) =>
        `<div class="log-replay-row" data-i="${i}">` +
        `<input type="checkbox" data-i="${i}" checked aria-label="Show ${esc(s.label)}" />` +
        `<i style="background:${colour(i)}"></i>` +
        `<button type="button" class="log-replay-name" data-i="${i}" title="Show this channel's scale on the axis">${esc(s.label)}</button>` +
        `<b></b><span class="log-replay-unit">${esc(s.unit)}</span>` +
        // where the value sits between the lowest and highest it reached
        `<span class="log-replay-meter"><span style="background:${colour(i)}"></span></span>` +
        `<span class="log-replay-stats"></span></div>`
    )
    .join('');
  const rows = [...legend.querySelectorAll('.log-replay-row')];
  const figures = rows.map((r) => r.querySelector('b'));
  const meters = rows.map(
    (r) =>
      /** @type {HTMLElement} */ (r.querySelector('.log-replay-meter span'))
  );
  const statEls = rows.map((r) => r.querySelector('.log-replay-stats'));
  const boxes = rows.map(
    (r) => /** @type {HTMLInputElement} */ (r.querySelector('input'))
  );
  legend.onchange = (e) => {
    const box = /** @type {HTMLInputElement} */ (e.target);
    if (box.dataset.i == null) return;
    state.shown[Number(box.dataset.i)] = box.checked;
    draw();
  };
  legend.onclick = (e) => {
    const name = e.target.closest('.log-replay-name');
    if (!name) return;
    state.focus = Number(name.dataset.i);
    // its trace is no use hidden
    state.shown[state.focus] = true;
    boxes[state.focus].checked = true;
    draw();
  };
  const showAll = (on) => {
    state.shown = state.shown.map(() => on);
    boxes.forEach((b) => (b.checked = on));
    draw();
  };
  q('.log-replay-all').onclick = () => showAll(true);
  q('.log-replay-none').onclick = () => showAll(false);

  // Scatter: the channel the others are drawn against
  if (typeof lookupDropdown === 'function') {
    const xPick = lookupDropdown(
      'X axis…',
      log.series.map((s, i) => ({
        val: String(i),
        label: s.label,
        meta: s.unit,
      })),
      '0',
      (v) => {
        if (v === '') return;
        state.xAxis = Number(v);
        draw();
      }
    );
    xPick.el.classList.add('log-replay-x');
    q('.log-replay-x-slot').replaceWith(xPick.el);
  }

  // ---- which view --------------------------------------------------------------
  const modeBtns = [...host.querySelectorAll('.log-replay-modes .seg-btn')];
  const setMode = (mode) => {
    state.mode = mode;
    for (const b of modeBtns)
      b.classList.toggle('active', b.dataset.mode === mode);
    xRow.hidden = mode !== 'scatter';
    canvas.hidden = mode === 'raw';
    rawEl.hidden = mode !== 'raw';
    tip.hidden = true;
    hint.textContent =
      mode === 'raw'
        ? 'click a row to go to it'
        : mode === 'scatter'
          ? 'each dot a sample · click a name to plot it'
          : mode === 'single'
            ? 'drag to zoom · ← → to slide · click a name for its scale'
            : 'drag to zoom · ← → to slide';
    state.rawKey = '';
    draw();
  };
  q('.log-replay-modes').onclick = (e) => {
    const b = e.target.closest('.seg-btn');
    if (b) setMode(b.dataset.mode);
  };

  /**
   * Scatter's Y channel: the focused one. When that is the channel on the
   * X axis (nothing has been picked yet), the first channel in another unit:
   * a second reading of the same thing (a target beside its actual) against
   * itself tells nothing.
   * @returns {number}
   */
  const scatterY = () => {
    if (state.focus !== state.xAxis || log.series.length < 2)
      return state.focus;
    const x = log.series[state.xAxis];
    const other = log.series.findIndex(
      (s, i) => i !== state.xAxis && s.unit !== x.unit
    );
    return other >= 0 ? other : (state.xAxis + 1) % log.series.length;
  };

  /** The area the panes share, for a canvas of w by h. */
  const boxOf = (w, h) => ({ l: 58, r: w - 10, t: 10, b: h - 24 });
  const yOf = (pane, sc, v) =>
    pane.b - 4 - ((v - sc.lo) / (sc.hi - sc.lo)) * (pane.b - pane.t - 8);
  const GRID = 'rgba(138, 151, 163, 0.16)';
  const INK = '#8a97a3';

  /**
   * The samples as a table: a row a moment in view, a column a shown channel.
   * Built again only when what it shows has changed; the row at the cursor is
   * marked on every draw.
   * @returns {void}
   */
  function drawRaw() {
    const cols = log.series.map((s, i) => i).filter((i) => state.shown[i]);
    const key = `${state.viewFrom}|${state.viewTo}|${cols.join(',')}`;
    if (key !== state.rawKey) {
      state.rawKey = key;
      const times = new Set();
      for (const i of cols)
        for (const t of log.series[i].t)
          if (t >= state.viewFrom && t <= state.viewTo) times.add(t);
      let list = [...times].sort((a, b) => a - b);
      // a long run is thinned to what a page can hold: zoom in for every row
      const stride = Math.ceil(list.length / LOG_REPLAY_RAW_ROWS);
      const thinned = stride > 1;
      if (thinned) list = list.filter((_, k) => k % stride === 0);
      rawEl.innerHTML =
        (thinned
          ? `<div class="log-replay-raw-note">every ${stride}th sample shown: zoom in for all of them</div>`
          : '') +
        '<table><thead><tr><th>Time</th>' +
        cols
          .map(
            (i) =>
              `<th><i style="background:${colour(i)}"></i>${esc(log.series[i].label)}${log.series[i].unit ? ` <em>${esc(log.series[i].unit)}</em>` : ''}</th>`
          )
          .join('') +
        '</tr></thead><tbody>' +
        list
          .map(
            (t) =>
              `<tr data-t="${t}"><td>${logReplayClock(t - log.from)}</td>` +
              cols
                .map(
                  (i) => `<td>${fmt(logReplayValueAt(log.series[i], t))}</td>`
                )
                .join('') +
              '</tr>'
          )
          .join('') +
        '</tbody></table>';
    }
    // the row the cursor is on: the last one at or before it
    let at = null;
    for (const tr of rawEl.querySelectorAll('tbody tr')) {
      if (Number(tr.dataset.t) > state.cursor) break;
      at = tr;
    }
    const was = rawEl.querySelector('tr.at');
    if (was !== at) {
      if (was) was.classList.remove('at');
      if (at) {
        at.classList.add('at');
        if (state.playing && at.scrollIntoView)
          at.scrollIntoView({ block: 'nearest' });
      }
    }
  }
  rawEl.onclick = (e) => {
    const tr = e.target.closest('tbody tr');
    if (tr) seek(Number(tr.dataset.t));
  };

  /**
   * The plot (or the table), the clock and the list's figures for where the
   * cursor is.
   * @returns {void}
   */
  function draw() {
    if (state.closed) return;
    // the list first: it is the same whatever the view
    log.series.forEach((s, i) => {
      const v = logReplayValueAt(s, state.cursor);
      const text = fmt(v);
      if (figures[i].textContent !== text) figures[i].textContent = text;
      const st = logReplayStats(s, state.viewFrom, state.viewTo);
      const stats = st
        ? `min ${fmt(st.min)} · avg ${fmt(st.avg)} · max ${fmt(st.max)}`
        : 'no samples in view';
      if (statEls[i].textContent !== stats) statEls[i].textContent = stats;
      const all = whole[i];
      const part =
        all && v != null && all.max > all.min
          ? (v - all.min) / (all.max - all.min)
          : 0;
      meters[i].style.width =
        `${Math.round(Math.min(1, Math.max(0, part)) * 100)}%`;
      rows[i].classList.toggle(
        'focus',
        (state.mode === 'single' && i === state.focus) ||
          (state.mode === 'scatter' && i === scatterY())
      );
      rows[i].classList.toggle('off', !state.shown[i]);
    });
    clock.textContent = `${logReplayClock(state.cursor - log.from)} / ${logReplayClock(span)}`;
    const pos = String(Math.round(((state.cursor - log.from) / span) * 1000));
    if (scrub.value !== pos) scrub.value = pos;
    resetBtn.disabled = state.viewFrom <= log.from && state.viewTo >= log.to;
    if (state.mode === 'raw') return drawRaw();

    const w = plot.clientWidth;
    const h = plot.clientHeight;
    if (w < 80 || h < 60) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * dpr))
      canvas.width = Math.round(w * dpr);
    if (canvas.height !== Math.round(h * dpr))
      canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const box = boxOf(w, h);
    g.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.lineWidth = 1;

    const scatter = state.mode === 'scatter';
    const scales = scatter ? ownScales : sharedScales;
    const xs = scatter ? log.series[state.xAxis] : null;
    const xsc = scatter ? scales[state.xAxis] : null;
    const X = scatter
      ? (v) => box.l + ((v - xsc.lo) / (xsc.hi - xsc.lo)) * (box.r - box.l)
      : (t) =>
          box.l +
          ((t - state.viewFrom) / (state.viewTo - state.viewFrom)) *
            (box.r - box.l);

    // the panes: Split stacks one a unit, the other views have the one.
    // Scatter draws ONE channel against the X channel: every channel at
    // once, each to a scale of its own, is a cloud that says nothing.
    const groups =
      state.mode === 'split'
        ? logReplayPanes(log.series, state.shown)
        : scatter
          ? [[scatterY()]]
          : [log.series.map((s, i) => i).filter((i) => state.shown[i])];
    const gap = 8;
    const each =
      (box.b - box.t - gap * Math.max(0, groups.length - 1)) /
      Math.max(1, groups.length);
    const panes = groups.map((idx, k) => {
      const t = box.t + k * (each + gap);
      return { idx, l: box.l, r: box.r, t, b: t + each };
    });

    // the bottom axis: round seconds of the run, or the X channel's values
    const ticksX = [];
    if (scatter) {
      for (const v of logReplayTicks(
        xsc.lo,
        xsc.hi,
        Math.max(2, Math.floor((box.r - box.l) / 90))
      ))
        ticksX.push([
          X(v),
          fmt(v) + (xs.unit ? ` ${xs.unit}` : ''),
          colour(state.xAxis),
        ]);
    } else {
      const raw =
        (state.viewTo - state.viewFrom) /
        Math.max(2, Math.floor((box.r - box.l) / 110));
      const step =
        [100, 200, 500, 1000, 2000, 5000, 10000, 30000, 60000, 300000].find(
          (k) => k >= raw
        ) || 600000;
      for (
        let t = Math.ceil((state.viewFrom - log.from) / step) * step;
        log.from + t <= state.viewTo;
        t += step
      )
        ticksX.push([X(log.from + t), logReplayClock(t), INK]);
    }
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (const [x, text, ink] of ticksX) {
      g.fillStyle = ink;
      g.fillText(text, x, box.b + 6);
    }

    const cxv = scatter ? logReplayValueAt(xs, state.cursor) : state.cursor;
    const cx = cxv == null ? null : X(cxv);

    for (const pane of panes) {
      // the pane's value axis: Split, the unit its channels share; else the
      // focused channel's, in its colour
      const lead =
        state.mode === 'split'
          ? pane.idx[0]
          : pane.idx.includes(state.focus)
            ? state.focus
            : pane.idx[0];
      if (lead != null) {
        const sc = scales[lead];
        g.textAlign = 'right';
        g.textBaseline = 'middle';
        for (const v of logReplayTicks(
          sc.lo,
          sc.hi,
          Math.max(1, Math.floor((pane.b - pane.t) / 46))
        )) {
          const y = Math.round(yOf(pane, sc, v)) + 0.5;
          if (y < pane.t + 2 || y > pane.b - 2) continue;
          g.strokeStyle = GRID;
          g.beginPath();
          g.moveTo(pane.l, y);
          g.lineTo(pane.r, y);
          g.stroke();
          g.fillStyle = state.mode === 'split' ? INK : colour(lead);
          g.fillText(fmt(v), pane.l - 6, y);
        }
      }
      for (const [x] of ticksX) {
        g.strokeStyle = GRID;
        g.beginPath();
        g.moveTo(Math.round(x) + 0.5, pane.t);
        g.lineTo(Math.round(x) + 0.5, pane.b);
        g.stroke();
      }
      g.strokeStyle = 'rgba(138, 151, 163, 0.4)';
      g.strokeRect(
        pane.l + 0.5,
        Math.round(pane.t) + 0.5,
        pane.r - pane.l,
        Math.round(pane.b - pane.t)
      );

      g.save();
      g.beginPath();
      g.rect(pane.l, pane.t, pane.r - pane.l, pane.b - pane.t);
      g.clip();
      g.lineJoin = 'round';
      for (const i of pane.idx) {
        if (scatter && i === state.xAxis) continue;
        const s = log.series[i];
        const sc = scales[i];
        const bold = state.mode === 'single' && i === state.focus;
        g.strokeStyle = colour(i);
        g.fillStyle = colour(i);
        g.lineWidth = bold ? 2.25 : 1.4;
        // dots that land on each other show as denser, not as one
        g.globalAlpha = scatter
          ? 0.55
          : state.mode === 'single' && !bold
            ? 0.85
            : 1;
        if (scatter) {
          // against a channel: a dot a sample, where that channel was then
          for (let k = 0; k < s.t.length; k++) {
            if (s.t[k] < state.viewFrom || s.t[k] > state.viewTo) continue;
            const xv = logReplayValueAt(xs, s.t[k]);
            if (xv == null) continue;
            g.beginPath();
            g.arc(X(xv), yOf(pane, sc, s.v[k]), 2.5, 0, Math.PI * 2);
            g.fill();
          }
          continue;
        }
        g.beginPath();
        let pen = false;
        for (let k = 0; k < s.t.length; k++) {
          // one sample either side of the view, so the line runs off its edges
          if (k + 1 < s.t.length && s.t[k + 1] < state.viewFrom) continue;
          const x = X(s.t[k]);
          const y = yOf(pane, sc, s.v[k]);
          if (pen) g.lineTo(x, y);
          else g.moveTo(x, y);
          pen = true;
          if (s.t[k] > state.viewTo) break;
        }
        g.stroke();
      }
      g.globalAlpha = 1;

      // the crosshair, a dot on every trace where it crosses, and (Split)
      // each channel's name and value written beside it
      if (cx != null) {
        g.strokeStyle = 'rgba(255, 255, 255, 0.5)';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(Math.round(cx) + 0.5, pane.t);
        g.lineTo(Math.round(cx) + 0.5, pane.b);
        g.stroke();
        const marks = [];
        for (const i of pane.idx) {
          if (scatter && i === state.xAxis) continue;
          const v = logReplayValueAt(log.series[i], state.cursor);
          if (v == null) continue;
          const y = yOf(pane, scales[i], v);
          g.fillStyle = colour(i);
          g.strokeStyle = '#0b0f14';
          g.lineWidth = 1.5;
          g.beginPath();
          g.arc(cx, y, 3.5, 0, Math.PI * 2);
          g.fill();
          g.stroke();
          marks.push({ i, v });
        }
        if (state.mode === 'split' && marks.length) {
          g.font = '11px ui-sans-serif, system-ui, sans-serif';
          const lineH = 15;
          const texts = marks.map(
            (m) =>
              `${log.series[m.i].label}   ${fmt(m.v)}${log.series[m.i].unit ? ` ${log.series[m.i].unit}` : ''}`
          );
          const tw = Math.max(...texts.map((t) => g.measureText(t).width)) + 24;
          const th = lineH * marks.length + 6;
          const left = cx + 10 + tw > pane.r ? cx - 10 - tw : cx + 10;
          const top = Math.max(
            pane.t + 2,
            Math.min(pane.b - th - 2, (pane.t + pane.b) / 2 - th / 2)
          );
          g.fillStyle = 'rgba(11, 15, 20, 0.88)';
          g.fillRect(left, top, tw, th);
          g.textAlign = 'left';
          g.textBaseline = 'middle';
          marks.forEach((m, k) => {
            const y = top + 3 + lineH * k + lineH / 2;
            g.fillStyle = colour(m.i);
            g.beginPath();
            g.arc(left + 9, y, 3, 0, Math.PI * 2);
            g.fill();
            g.fillStyle = '#e8eef4';
            g.fillText(texts[k], left + 17, y);
          });
          g.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
        }
      }
      g.restore();
    }

    // the stretch being dragged out, across every pane
    if (state.drag && !state.drag.pan) {
      const a = Math.min(state.drag.x0, state.drag.x1);
      const b = Math.max(state.drag.x0, state.drag.x1);
      g.fillStyle = 'rgba(244, 211, 94, 0.14)';
      g.strokeStyle = 'rgba(244, 211, 94, 0.7)';
      g.lineWidth = 1;
      g.fillRect(a, box.t, b - a, box.b - box.t);
      g.strokeRect(Math.round(a) + 0.5, box.t + 0.5, b - a, box.b - box.t);
    }
  }

  /**
   * Move the cursor, keeping it in the run and in view.
   * @param {number} t
   * @returns {void}
   */
  function seek(t) {
    state.cursor = Math.min(log.to, Math.max(log.from, t));
    const view = state.viewTo - state.viewFrom;
    // a zoomed view follows the cursor out of its edges
    if (state.cursor > state.viewTo) {
      state.viewTo = Math.min(log.to, state.cursor + view * 0.1);
      state.viewFrom = state.viewTo - view;
    } else if (state.cursor < state.viewFrom) {
      state.viewFrom = Math.max(log.from, state.cursor - view * 0.1);
      state.viewTo = state.viewFrom + view;
    }
    draw();
  }

  /**
   * Show a stretch of the run.
   * @param {number} from
   * @param {number} to
   * @returns {void}
   */
  function zoomTo(from, to) {
    const width = Math.min(span, Math.max(LOG_REPLAY_MIN_SPAN_MS, to - from));
    state.viewFrom = Math.max(log.from, Math.min(log.to - width, from));
    state.viewTo = state.viewFrom + width;
    draw();
  }
  resetBtn.onclick = () => zoomTo(log.from, log.to);

  // ---- playback ---------------------------------------------------------------
  function frame(now) {
    state.raf = 0;
    if (!state.playing || state.closed) return;
    const dt = state.lastFrame ? now - state.lastFrame : 0;
    state.lastFrame = now;
    seek(state.cursor + dt * state.speed);
    if (state.cursor >= log.to) return play(false);
    state.raf = requestAnimationFrame(frame);
  }
  function play(on) {
    state.playing = on;
    playBtn.textContent = on ? 'Pause' : 'Play';
    playBtn.classList.toggle('primary', !on);
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
    if (!on) return;
    tip.hidden = true;
    if (state.cursor >= log.to) seek(log.from); // from the end: again from the start
    state.lastFrame = 0;
    state.raf = requestAnimationFrame(frame);
  }
  playBtn.onclick = () => play(!state.playing);
  q('.log-replay-speeds').onclick = (e) => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    state.speed = Number(b.dataset.speed);
    for (const x of host.querySelectorAll('.log-replay-speeds .seg-btn'))
      x.classList.toggle('active', x === b);
  };
  scrub.oninput = () => seek(log.from + (Number(scrub.value) / 1000) * span);

  // ---- the pointer on the plot ---------------------------------------------------
  /** Whether the bottom axis is time: what zooming and sliding work on. */
  const timed = () => state.mode === 'single' || state.mode === 'split';
  const pointer = (ev) => {
    const r = canvas.getBoundingClientRect();
    const box = boxOf(r.width, r.height);
    const x = Math.min(box.r, Math.max(box.l, ev.clientX - r.left));
    return {
      x,
      y: ev.clientY - r.top,
      w: r.width,
      h: r.height,
      time:
        state.viewFrom +
        ((x - box.l) / (box.r - box.l)) * (state.viewTo - state.viewFrom),
    };
  };
  /** Single: the box of values beside the pointer (Split writes them in its panes). */
  const showTip = (p) => {
    const lines = log.series
      .map((s, i) => ({ s, i, v: logReplayValueAt(s, state.cursor) }))
      .filter((k) => state.shown[k.i] && k.v != null);
    tip.innerHTML =
      `<div class="log-replay-tip-t">${esc(logReplayClock(state.cursor - log.from))}</div>` +
      lines
        .slice(0, 16)
        .map(
          (k) =>
            `<div class="log-replay-tip-row"><i style="background:${colour(k.i)}"></i>` +
            `<span>${esc(k.s.label)}</span><b>${esc(fmt(k.v))}</b><em>${esc(k.s.unit)}</em></div>`
        )
        .join('') +
      (lines.length > 16
        ? `<div class="log-replay-tip-more">+${lines.length - 16} more</div>`
        : '');
    tip.hidden = false;
    // beside the pointer, on whichever side has the room
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    tip.style.left = `${p.x + 14 + tw > p.w ? Math.max(4, p.x - 14 - tw) : p.x + 14}px`;
    tip.style.top = `${Math.max(4, Math.min(p.h - th - 4, p.y - th / 2))}px`;
  };
  canvas.onmousedown = (ev) => {
    if (ev.button !== 0 || !timed()) return;
    ev.preventDefault();
    const p = pointer(ev);
    state.drag = {
      x0: p.x,
      x1: p.x,
      t0: p.time,
      pan: ev.shiftKey,
      from: state.viewFrom,
      to: state.viewTo,
    };
    tip.hidden = true;
  };
  const onMove = (ev) => {
    if (state.closed) return;
    const d = state.drag;
    if (d) {
      const p = pointer(ev);
      d.x1 = p.x;
      if (d.pan) {
        // the run slides under the pointer
        const box = boxOf(p.w, p.h);
        const shift = ((d.x0 - p.x) / (box.r - box.l)) * (d.to - d.from);
        zoomTo(d.from + shift, d.to + shift);
      } else draw();
      return;
    }
    if (ev.target !== canvas || state.playing || !timed()) return;
    const p = pointer(ev);
    seek(p.time);
    if (state.mode === 'single') showTip(p);
  };
  const onUp = (ev) => {
    const d = state.drag;
    if (!d) return;
    state.drag = null;
    if (d.pan) return draw();
    const p = pointer(ev);
    // a real drag zooms to it; a press that went nowhere is a click
    if (Math.abs(d.x1 - d.x0) > 6)
      zoomTo(Math.min(d.t0, p.time), Math.max(d.t0, p.time));
    else seek(d.t0);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  canvas.onmouseleave = () => {
    tip.hidden = true;
  };
  canvas.ondblclick = () => zoomTo(log.from, log.to);
  canvas.addEventListener(
    'wheel',
    (ev) => {
      if (!timed()) return;
      ev.preventDefault();
      const about = pointer(ev).time;
      const view = state.viewTo - state.viewFrom;
      // by how far the wheel turned, gently: a trackpad sends a stream of
      // small steps and a fixed jump per event ran away with the view
      const turn = Math.max(-60, Math.min(60, ev.deltaY));
      const next = Math.min(
        span,
        Math.max(
          LOG_REPLAY_MIN_SPAN_MS,
          view * Math.exp(turn * LOG_REPLAY_WHEEL_RATE)
        )
      );
      const from = about - ((about - state.viewFrom) / view) * next;
      zoomTo(from, from + next);
    },
    { passive: false }
  );

  // left and right slide the view along the run a tenth at a time (half
  // with shift); with the whole run in view there is nowhere to slide, so
  // they step the crosshair instead
  const onKey = (ev) => {
    if (state.closed || (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight'))
      return;
    const at = /** @type {HTMLElement|null} */ (ev.target);
    if (at && /^(INPUT|TEXTAREA|SELECT)$/.test(at.tagName || '')) return;
    ev.preventDefault();
    const dir = ev.key === 'ArrowLeft' ? -1 : 1;
    const view = state.viewTo - state.viewFrom;
    const step = view * (ev.shiftKey ? 0.5 : LOG_REPLAY_KEY_STEP) * dir;
    if (view >= span || !timed())
      seek(state.cursor + span * 0.01 * dir * (ev.shiftKey ? 5 : 1));
    else zoomTo(state.viewFrom + step, state.viewTo + step);
  };
  document.addEventListener('keydown', onKey);

  const sized =
    typeof ResizeObserver === 'function' ? new ResizeObserver(draw) : null;
  if (sized) sized.observe(plot);

  const close = () => {
    if (state.closed) return;
    state.closed = true;
    if (state.raf) cancelAnimationFrame(state.raf);
    if (sized) sized.disconnect();
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    document.removeEventListener('keydown', onKey);
    host.innerHTML = '';
    if (opts.onClose) opts.onClose();
  };
  q('.log-replay-close').onclick = close;
  q('.log-replay-csv').onclick = () => {
    const d = new Date(log.from);
    const p = (n) => String(n).padStart(2, '0');
    const name = `datalog-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.csv`;
    if (opts.save) opts.save(name, logReplayCsv(log));
  };

  setMode('split');
  return { close };
}

// node loads these pieces as modules; the browser gives them one shared scope
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    LOG_HISTORY_OPERATION,
    logSnapshot,
    logSaveToHistory,
    logReplayValueAt,
    logReplayScales,
    logReplayClock,
    logReplayCsv,
    logReplayStats,
    logReplayTicks,
    logReplayPanes,
  };
}
