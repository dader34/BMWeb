/**
 * @file Data logging: a run kept in the History, and looked at again there.
 *
 * The Logging page shows a run as it happens, one card a reading, over a
 * window that slides. What a log is FOR comes afterwards: putting two
 * readings over each other, finding the moment something happened, going
 * through it slowly. So a run that is paused is saved, whole, as an entry in
 * the app's History (core/flash/flash-history.js), and opening it there gives the
 * other view of it: every reading on one time axis, a cursor that reads all
 * of them at once, and playback.
 *
 * This file is both halves: taking the run out of the store (logSnapshot,
 * logSaveToHistory) and the viewer (logReplayOpen). The arithmetic in
 * between -- the value at a time, the shared scales, the CSV -- has no page
 * in it and is tested on its own.
 */

/* exported logReplayPanes, logReplayStats, logReplayTicks, logSnapshot, logSaveToHistory, logResetWatch, LOG_RESET_BEFORE_MS, LOG_RESET_AFTER_MS, logReplayOpen, logReplayCsv, logReplayValueAt, logReplayScales, logReplayClock */

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
 * @property {{t: number, label: string}[]} [marks] - Moments worth a line on
 *   the time axis: a DME reset the run caught.
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
/**
 * The viewer's colours from the page's theme, read once per open: it draws
 * on a canvas, which sees no CSS. A light theme (the page's background
 * brighter than its ink) gets the traces darkened so they read on it.
 * @param {HTMLElement} host
 * @returns {{light: boolean, bg: string, panel: string, line: string, ink: string, inkDim: string, grid: string, cursor: string}}
 */
function logReplayTheme(host) {
  const css = getComputedStyle(host);
  const v = (name, fallback) =>
    (css.getPropertyValue(name) || '').trim() || fallback;
  const bg = v('--bg', '#0a0d11');
  const ink = v('--ink', '#e7edf2');
  const lum = (hex) => {
    const n = parseInt(hex.replace('#', ''), 16);
    if (!Number.isFinite(n) || hex.length < 7) return 0;
    return (
      (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) /
      255
    );
  };
  const light = lum(bg) > lum(ink);
  return {
    light,
    bg,
    panel: v('--panel-2', light ? '#ffffff' : '#161d25'),
    line: v('--line', light ? '#d7dde3' : '#263039'),
    ink,
    inkDim: v('--ink-dim', light ? '#5b6670' : '#8d9aa6'),
    grid: light ? 'rgba(40, 50, 60, 0.12)' : 'rgba(138, 151, 163, 0.16)',
    cursor: light ? 'rgba(20, 28, 36, 0.45)' : 'rgba(255, 255, 255, 0.5)',
  };
}

/**
 * The trace colours for a theme: as they are on a dark page, darkened and
 * saturated a little for a light one, where a pale yellow is invisible.
 * @param {string[]} base - Hex colours.
 * @param {boolean} light
 * @returns {string[]}
 */
function logReplayPalette(base, light) {
  if (!light) return base;
  return base.map((hex) => {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) / 255;
    const g = ((n >> 8) & 255) / 255;
    const b = (n & 255) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0;
    const l = (max + min) / 2;
    const d = max - min;
    let sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
    }
    const lo = Math.min(l, 0.4);
    sat = Math.min(1, sat * 1.15);
    const c = (1 - Math.abs(2 * lo - 1)) * sat;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = lo - c / 2;
    const [r1, g1, b1] =
      h < 60
        ? [c, x, 0]
        : h < 120
          ? [x, c, 0]
          : h < 180
            ? [0, c, x]
            : h < 240
              ? [0, x, c]
              : h < 300
                ? [x, 0, c]
                : [c, 0, x];
    const to = (q) =>
      Math.round((q + m) * 255)
        .toString(16)
        .padStart(2, '0');
    return `#${to(r1)}${to(g1)}${to(b1)}`;
  });
}

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
  ['map', 'Map', 'A table of the tune, with where the run spent its time'],
  ['raw', 'Raw', 'The samples as a table'],
];
/** The least height a Split pane is drawn at; more panes than fit scroll. */
const LOG_REPLAY_PANE_MIN = 120;
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
 * @param {{chassis?: string, module?: string, reset?: number, record?: object}} [about] -
 *   `reset`: the run was cut out around a DME reset at that time (ms);
 *   `record`: what the DME's own self-reset record said afterwards.
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
  let details =
    `${log.series.length} reading${log.series.length === 1 ? '' : 's'}` +
    (rate ? ` at ${rate.toFixed(rate < 10 ? 1 : 0)}/s` : '') +
    `: ${names.slice(0, 4).join(', ')}${names.length > 4 ? ', …' : ''}`;
  if (about.reset) {
    log.marks = [{ t: about.reset, label: 'DME reset' }];
    const before = Math.round((about.reset - log.from) / 1000);
    const after = Math.round((log.to - about.reset) / 1000);
    details = `DME reset at ${new Date(about.reset).toLocaleTimeString()}, ${before} s before and ${after} s after · ${details}`;
    if (about.record && typeof ms45ResetRecordText === 'function')
      details += ` · DME self-resets: ${ms45ResetRecordText(about.record)}`;
  }
  const entry = {
    started: log.from,
    seconds,
    operation: LOG_HISTORY_OPERATION,
    vin: about.chassis || '',
    module: about.module || '',
    details,
    status: `logged for ${seconds} s`,
    result: 'saved',
    dataLog: log,
  };
  await flashHistory._append(entry);
  return entry;
}

/** The reading that counts the DME's running time: it starts over at a reset. */
const LOG_UPTIME_LABEL = /time since start|betriebszeit|laufzeit|uptime/i;
/** How much of the run the black box keeps on either side of a reset, ms. */
const LOG_RESET_BEFORE_MS = 30000;
const LOG_RESET_AFTER_MS = 5000;
/** A fall of the running time by at least this many seconds is a restart. */
const LOG_RESET_DROP_S = 2;
/** Two restarts closer than this are one: the counter settles after one. */
const LOG_RESET_APART_MS = 10000;

/**
 * The black box: watch the run for a DME reset, which shows as the running
 * time falling back towards zero, and say when one happened. Called after
 * each answer is ingested; cheap when the run logs no running time.
 * @param {{series: Map<string, {t: number[], v: number[]}>, meta: Map<string, {label: string}>}} store
 * @param {(at: number) => void} onReset - Told the time (ms) of the reset.
 * @returns {() => void} The check to run after every sample.
 */
function logResetWatch(store, onReset) {
  let id = null;
  let seen = 0; // samples of the running time looked at so far
  let lastAt = 0;
  return () => {
    if (id == null || !store.series.has(id)) {
      id = null;
      seen = 0;
      for (const [k, meta] of store.meta)
        if (LOG_UPTIME_LABEL.test(meta.label || '')) {
          id = k;
          break;
        }
      if (id == null) return;
    }
    const ring = store.series.get(id);
    const n = ring.t.length;
    if (n < 2 || n === seen) return;
    // the window may have been trimmed: only the newest pair matters
    seen = n;
    const prev = ring.v[n - 2];
    const cur = ring.v[n - 1];
    if (!(prev - cur >= LOG_RESET_DROP_S)) return;
    // the reset fell between the two samples; the counter restarted `cur`
    // seconds before the newer one
    const at = Math.max(ring.t[n - 2], ring.t[n - 1] - cur * 1000);
    if (lastAt && at - lastAt < LOG_RESET_APART_MS) return;
    lastAt = at;
    onReset(at);
  };
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
  const theme = logReplayTheme(host);
  const palette = logReplayPalette(LOG_REPLAY_COLOURS, theme.light);
  const colour = (i) => palette[i % palette.length];
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
    // Map: the table (decoded), which channels drive its axes, which is
    // averaged over it (-1: dwell), and the bins for the current window
    map: { item: null, d: null, xi: -1, yi: -1, zi: -1, bins: null, key: '' },
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
          <div class="log-replay-maprows" hidden>
            <div class="log-replay-sidebar">
              <span class="log-replay-x-label">Table</span>
              <span class="log-replay-map-slot" data-pick="table"></span>
            </div>
            <div class="log-replay-sidebar">
              <span class="log-replay-x-label">Across</span>
              <span class="log-replay-map-slot" data-pick="x"></span>
            </div>
            <div class="log-replay-sidebar">
              <span class="log-replay-x-label">Down</span>
              <span class="log-replay-map-slot" data-pick="y"></span>
            </div>
            <div class="log-replay-sidebar">
              <span class="log-replay-x-label">Colour</span>
              <span class="log-replay-map-slot" data-pick="z"></span>
            </div>
            <div class="log-replay-map-note" hidden></div>
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
          <div class="log-replay-map tn-table-scroll" hidden></div>
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

  // ---- Map: the run over a table of the tune -----------------------------------
  const mapRows = q('.log-replay-maprows');
  const mapNote = q('.log-replay-map-note');
  const mapEl = q('.log-replay-map');
  const mapPicks = {};
  let mapTables = null;
  const mapRebin = () => {
    state.map.key = '';
    draw();
  };
  const mapChannels = (none) => [
    { val: '-1', label: none, meta: '' },
    ...log.series.map((s, i) => ({
      val: String(i),
      label: s.label,
      meta: s.unit,
    })),
  ];
  /** Fill the pickers the first time the view is opened. */
  const mapSetup = async () => {
    if (mapTables) return;
    let ready = typeof logTracerReady === 'function' && logTracerReady();
    if (!ready && typeof logTracerRestore === 'function') {
      mapNote.hidden = false;
      mapNote.textContent = 'loading the tune…';
      if (await logTracerRestore()) ready = logTracerReady();
      if (state.closed || state.mode !== 'map') return;
    }
    if (!ready) {
      mapNote.hidden = false;
      mapNote.textContent =
        'Load a tune and its definition in Tuning, then come back: the tables come from there.';
      return;
    }
    mapNote.hidden = true;
    mapTables = logTracerTables(ready.def);
    if (typeof lookupDropdown !== 'function') return;
    const put = (name, dd) => {
      dd.el.classList.add('log-replay-x');
      q(`.log-replay-map-slot[data-pick="${name}"]`).replaceWith(dd.el);
      mapPicks[name] = dd;
    };
    put(
      'table',
      lookupDropdown(
        'Table…',
        mapTables.map((t, i) => ({
          val: String(i),
          label: t.label,
          meta: t.item.title !== t.label ? t.item.title : '',
        })),
        '',
        (v) => {
          if (v !== '') mapChoose(mapTables[Number(v)].item);
        }
      )
    );
    draw();
    put(
      'x',
      lookupDropdown('Across…', mapChannels('one column'), '-1', (v) => {
        state.map.xi = Number(v);
        logTracerRemember(
          state.map.d && state.map.d.offset,
          'x',
          state.map.xi >= 0 ? log.series[state.map.xi].key : null
        );
        mapRebin();
      })
    );
    put(
      'y',
      lookupDropdown('Down…', mapChannels('one row'), '-1', (v) => {
        state.map.yi = Number(v);
        logTracerRemember(
          state.map.d && state.map.d.offset,
          'y',
          state.map.yi >= 0 ? log.series[state.map.yi].key : null
        );
        mapRebin();
      })
    );
    put(
      'z',
      lookupDropdown('Colour…', mapChannels('time spent'), '-1', (v) => {
        state.map.zi = Number(v);
        mapRebin();
      })
    );
  };
  /** A table picked: decode it and match its axes to the run's readings. */
  const mapChoose = (item) => {
    const m = state.map;
    m.item = item;
    m.d = logTracerDecode(item);
    m.key = '';
    if (!m.d) {
      mapNote.hidden = false;
      mapNote.textContent = 'This table has nothing to show.';
      draw();
      return;
    }
    const match = logTracerMatch(m.d, log);
    // a pick made before for this table wins over the guess
    const kept = logTracerRemembered(m.d.offset);
    const byKey = (key) => log.series.findIndex((s) => s.key === key);
    m.xi = m.d.x
      ? kept.x && byKey(kept.x) >= 0
        ? byKey(kept.x)
        : match.x
      : -1;
    m.yi = m.d.y
      ? kept.y && byKey(kept.y) >= 0
        ? byKey(kept.y)
        : match.y
      : -1;
    if (mapPicks.x) mapPicks.x.set(String(m.xi));
    if (mapPicks.y) mapPicks.y.set(String(m.yi));
    const missing = [];
    if (m.d.x && match.x < 0)
      missing.push(`across (${m.d.x.title || m.d.x.units})`);
    if (m.d.y && match.y < 0)
      missing.push(`down (${m.d.y.title || m.d.y.units})`);
    mapNote.hidden = !missing.length;
    mapNote.textContent = missing.length
      ? `No logged reading matched the ${missing.join(' and ')} axis: pick one.`
      : '';
    draw();
  };
  const drawMap = () => {
    const m = state.map;
    if (!m.d) {
      mapEl.dataset.for = '';
      mapEl.innerHTML = `<div class="log-replay-map-empty">${
        mapTables
          ? 'pick a table'
          : 'load a tune and its definition in Tuning first'
      }</div>`;
      return;
    }
    const key = `${m.xi}:${m.yi}:${m.zi}:${state.viewFrom}:${state.viewTo}`;
    if (m.key !== key) {
      m.bins = logTracerBins(
        log,
        m.d,
        m.xi,
        m.yi,
        m.zi,
        state.viewFrom,
        state.viewTo
      );
      m.key = key;
    }
    logTracerRender(mapEl, m.d, m.bins, {
      viewFrom: state.viewFrom,
      viewTo: state.viewTo,
      cursor: state.cursor,
      mean: m.zi >= 0,
      fmt,
      // a cell pressed: go to the first moment the run was in it
      onCell: (r, c) => {
        const p =
          m.bins &&
          m.bins.path.find(
            (q) => Math.round(q.row) === r && Math.round(q.col) === c
          );
        if (p) seek(p.t);
      },
    });
  };

  // ---- which view --------------------------------------------------------------
  const modeBtns = [...host.querySelectorAll('.log-replay-modes .seg-btn')];
  const setMode = (mode) => {
    state.mode = mode;
    for (const b of modeBtns)
      b.classList.toggle('active', b.dataset.mode === mode);
    xRow.hidden = mode !== 'scatter';
    mapRows.hidden = mode !== 'map';
    mapEl.hidden = mode !== 'map';
    if (mode === 'map') mapSetup();
    canvas.hidden = mode === 'raw' || mode === 'map';
    rawEl.hidden = mode !== 'raw';
    tip.hidden = true;
    hint.textContent =
      mode === 'raw'
        ? 'click a row to go to it'
        : mode === 'scatter'
          ? 'each dot a sample · click a name to plot it'
          : mode === 'map'
            ? 'the run over a table · scrub to follow it'
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
  const GRID = theme.grid;
  const INK = theme.inkDim;

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
    if (state.mode === 'map') return drawMap();

    const w = plot.clientWidth;
    if (w < 80 || plot.clientHeight < 60) return;
    // Split gives every pane room to be read: with many units on at once
    // the panes do not shrink to slivers, the plot grows and scrolls
    const paneCount =
      state.mode === 'split'
        ? logReplayPanes(log.series, state.shown).length
        : 1;
    const h = Math.max(
      plot.clientHeight,
      state.mode === 'split' ? paneCount * (LOG_REPLAY_PANE_MIN + 8) + 34 : 0
    );
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

    // a moment the run caught, a DME reset: a dashed line through every
    // pane with its name at the top (on the time axis only)
    if (!scatter && log.marks)
      for (const m of log.marks) {
        if (m.t < state.viewFrom || m.t > state.viewTo) continue;
        const x = Math.round(X(m.t)) + 0.5;
        g.save();
        g.strokeStyle = 'rgba(255, 96, 64, 0.9)';
        g.fillStyle = 'rgba(255, 96, 64, 0.9)';
        g.setLineDash([4, 3]);
        g.beginPath();
        g.moveTo(x, box.t);
        g.lineTo(x, box.b);
        g.stroke();
        g.setLineDash([]);
        g.textAlign = 'left';
        g.textBaseline = 'top';
        g.fillText(m.label, x + 4, box.t + 2);
        g.restore();
      }

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
          Math.max(2, Math.floor((pane.b - pane.t) / 40))
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
        g.strokeStyle = theme.cursor;
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
          g.strokeStyle = theme.bg;
          g.lineWidth = 1.5;
          g.beginPath();
          g.arc(cx, y, 3.5, 0, Math.PI * 2);
          g.fill();
          g.stroke();
          marks.push({ i, v });
        }
        if (!scatter && marks.length) {
          // the readout: the pane's channels at the cursor, in a quiet box
          // pinned to the pane's top right corner, where it never covers
          // the point being read and never jumps about with the cursor.
          // More channels than the pane is tall go into further columns.
          g.font = '10.5px ui-sans-serif, system-ui, sans-serif';
          const lineH = 14;
          const rowsFit = Math.max(
            1,
            Math.floor((pane.b - pane.t - 14) / lineH)
          );
          const texts = marks.map(
            (m) =>
              `${log.series[m.i].label}  ${fmt(m.v)}${log.series[m.i].unit ? ` ${log.series[m.i].unit}` : ''}`
          );
          const colW =
            Math.max(...texts.map((t) => g.measureText(t).width)) + 22;
          const cols = Math.max(
            1,
            Math.min(
              Math.ceil(texts.length / rowsFit),
              Math.floor((pane.r - pane.l - 80) / colW)
            )
          );
          const rows = Math.ceil(texts.length / cols);
          const tw = colW * cols;
          const th = lineH * Math.min(rows, rowsFit) + 8;
          const left = pane.r - tw - 6;
          const top = pane.t + 5;
          g.save();
          g.globalAlpha = 0.92;
          g.fillStyle = theme.panel;
          g.strokeStyle = theme.line;
          g.lineWidth = 1;
          g.beginPath();
          g.roundRect(left + 0.5, top + 0.5, tw, th, 4);
          g.fill();
          g.stroke();
          g.restore();
          g.textAlign = 'left';
          g.textBaseline = 'middle';
          marks.forEach((m, k) => {
            const c = Math.floor(k / rows);
            const r = k % rows;
            if (r >= rowsFit) return; // a pane too short for even the columns: the list has it
            const x = left + c * colW;
            const y = top + 4 + lineH * r + lineH / 2;
            g.fillStyle = colour(m.i);
            g.beginPath();
            g.arc(x + 9, y, 2.5, 0, Math.PI * 2);
            g.fill();
            g.fillStyle = theme.ink;
            g.fillText(texts[k], x + 16, y);
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
  const timed = () =>
    state.mode === 'single' || state.mode === 'split' || state.mode === 'map';
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
    logResetWatch,
    logReplayValueAt,
    logReplayPalette,
    logReplayScales,
    logReplayClock,
    logReplayCsv,
    logReplayStats,
    logReplayTicks,
    logReplayPanes,
  };
}
