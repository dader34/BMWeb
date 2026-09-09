/**
 * @file Data logging: the chart grid -- one canvas per series, all on one
 * time axis, with a cursor that reads every chart at the same instant.
 *
 * Third piece of screens/logging/ (see store.js for the folder map).
 *
 * No chart library. The drawing is a polyline, two axis labels and a cursor,
 * which is less code than configuring a library would be, and it lets the
 * colours come from the skin: the app ships several themes (and a light one),
 * so every colour is read from the CSS custom properties at draw time rather
 * than written as a literal that would vanish on one of them.
 */

/* exported LOG_WINDOWS, logChartColors, logNiceScale, LogChartGrid */

/**
 * The time windows the user can choose, newest-first on the right.
 * @type {Array<{ms: number, label: string}>}
 */
const LOG_WINDOWS = [
  { ms: 30 * 1000, label: '30 s' },
  { ms: 2 * 60 * 1000, label: '2 min' },
  { ms: 10 * 60 * 1000, label: '10 min' },
];

/**
 * The skin's colours, resolved now.
 *
 * A canvas cannot inherit a CSS variable, so the tokens are read off the
 * document element and handed to the drawing code. Re-read on every theme
 * change (the grid listens) so the charts follow the skin instead of staying
 * dark on a light background.
 * @param {HTMLElement} [el] - Element to resolve against; defaults to <html>.
 * @returns {{ink: string, dim: string, faint: string, line: string, accent: string, panel: string}}
 */
function logChartColors(el) {
  const target =
    el || (typeof document !== 'undefined' ? document.documentElement : null);
  const cs =
    target && typeof getComputedStyle === 'function'
      ? getComputedStyle(target)
      : null;
  /**
   * One token, with a fallback for the case where the stylesheet has not
   * applied yet (a canvas drawn on the first frame of a cold load).
   * @param {string} name - Custom property name.
   * @param {string} fallback - Value to use when unset.
   * @returns {string}
   */
  const tok = (name, fallback) => {
    const v = cs ? cs.getPropertyValue(name).trim() : '';
    return v || fallback;
  };
  return {
    ink: tok('--ink', '#ffffff'),
    dim: tok('--ink-dim', '#d6ecff'),
    faint: tok('--ink-faint', '#a9cdef'),
    line: tok('--line', 'rgba(255,255,255,0.35)'),
    accent: tok('--amber', '#aaff00'),
    panel: tok('--panel', 'rgba(255,255,255,0.14)'),
  };
}

/**
 * A readable value range for an axis: the data's own span, padded, and never
 * zero-height.
 *
 * Auto-scaling from the values seen is the only honest default -- the shipped
 * INPA gauge declarations carry an analogout min/max for some keys, but they
 * are not served with the result schema, so a fixed range would have to be
 * guessed. A flat line (every sample equal) gets a band around it rather than
 * a zero-height box that would divide by zero.
 * @param {number} min - Smallest value seen.
 * @param {number} max - Largest value seen.
 * @returns {{lo: number, hi: number}} The axis range.
 */
function logNiceScale(min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { lo: 0, hi: 1 };
  if (max === min) {
    const pad = Math.abs(min) > 1 ? Math.abs(min) * 0.05 : 0.5;
    return { lo: min - pad, hi: max + pad };
  }
  const pad = (max - min) * 0.1; // headroom, so the trace never touches the frame
  return { lo: min - pad, hi: max + pad };
}

/**
 * The grid of charts: builds the DOM, redraws on request, and owns the
 * shared cursor.
 */
class LogChartGrid {
  /**
   * @param {HTMLElement} host - Where the grid renders.
   * @param {LogStore} store - The samples to draw.
   */
  constructor(host, store) {
    /** @type {HTMLElement} */
    this.host = host;
    /** @type {LogStore} */
    this.store = store;
    /** @type {number} The visible window in ms. */
    this.windowMs = LOG_WINDOWS[0].ms;
    /** @type {Map<string, {wrap: HTMLElement, canvas: HTMLCanvasElement, head: HTMLElement, read: HTMLElement}>} */
    this.cards = new Map();
    /** @type {number|null} The cursor's instant, ms since epoch; null when not hovering. */
    this.cursorT = null;
    /** @type {number} The store revision last drawn, so a frame with no new data is skipped. */
    this._drawn = -1;
    /** @type {number|null} */
    this._raf = null;
    /** @type {boolean} Whether the run is live (a paused chart still redraws on resize). */
    this.live = false;
    /** @type {{ink: string, dim: string, faint: string, line: string, accent: string, panel: string}} */
    this.colors = logChartColors();
    /**
     * Someone who asked for less motion gets the data, not the animation:
     * the charts still update, but on a slower cadence rather than every
     * frame, and nothing eases or transitions.
     * @type {boolean}
     */
    this.reduceMotion =
      typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches;
    /** @type {number} Last draw time, for the reduced-motion throttle. */
    this._lastDraw = 0;
    this._onResize = () => {
      this._drawn = -1; // force a redraw at the new size
      this.draw();
    };
    if (typeof window !== 'undefined')
      window.addEventListener('resize', this._onResize);
  }

  /**
   * Build one card per declared series. Called when the selection changes.
   * @returns {void}
   */
  build() {
    this.host.innerHTML = '';
    this.cards.clear();
    const ids = [...this.store.meta.keys()];
    if (!ids.length) {
      this.host.innerHTML =
        '<div class="empty"><div>No keys selected yet.</div></div>';
      return;
    }
    for (const id of ids) {
      const meta = this.store.meta.get(id);
      const wrap = document.createElement('div');
      wrap.className = 'log-chart';
      wrap.innerHTML = `
        <div class="log-chart-head">
          <span class="log-chart-title">${esc(meta.label)}</span>
          <span class="log-chart-sub">${esc(meta.sgbd)} · ${esc(meta.job)}</span>
        </div>
        <div class="log-chart-read"><span class="log-now">—</span></div>
        <canvas class="log-canvas"></canvas>`;
      this.host.appendChild(wrap);
      this.cards.set(id, {
        wrap,
        canvas: wrap.querySelector('canvas'),
        head: wrap.querySelector('.log-chart-head'),
        read: wrap.querySelector('.log-chart-read'),
      });
      this._wireCursor(wrap.querySelector('canvas'));
    }
    this._drawn = -1;
  }

  /**
   * A pointer over any chart sets the shared cursor instant, and every chart
   * draws a line at it -- so the reader can line up "what was the load when
   * the temperature spiked" across charts that were never sampled together.
   * @param {HTMLCanvasElement} canvas - The canvas to listen on.
   * @returns {void}
   */
  _wireCursor(canvas) {
    const toTime = (ev) => {
      const r = canvas.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      const { from, to } = this.range();
      return from + frac * (to - from);
    };
    canvas.addEventListener('pointermove', (ev) => {
      this.cursorT = toTime(ev);
      this._drawn = -1;
      this.draw();
    });
    canvas.addEventListener('pointerleave', () => {
      this.cursorT = null;
      this._drawn = -1;
      this.draw();
    });
  }

  /**
   * The visible time span: the window, ending at the newest sample while
   * live, or at the end of the data once stopped (so a paused chart does not
   * scroll itself empty).
   * @returns {{from: number, to: number}}
   */
  range() {
    const span = this.store.span();
    const to = this.live ? Date.now() : span ? span.to : Date.now();
    return { from: to - this.windowMs, to };
  }

  /**
   * Ask for a redraw on the next frame. Coalesces: several samples landing
   * between two frames still cost one draw.
   * @returns {void}
   */
  schedule() {
    if (this._raf != null) return;
    const run = () => {
      this._raf = null;
      this.draw();
    };
    this._raf =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(run)
        : setTimeout(run, 16);
  }

  /**
   * Draw every chart, unless nothing has changed since the last frame.
   * @returns {void}
   */
  draw() {
    // only new samples (or an explicit invalidation) justify a repaint; while
    // live the window itself slides, so a live run always redraws
    if (!this.live && this._drawn === this.store.revision) return;
    if (this.reduceMotion && this.live) {
      const now = Date.now();
      if (now - this._lastDraw < 500) return; // 2 Hz is legible without motion
      this._lastDraw = now;
    }
    this._drawn = this.store.revision;
    const { from, to } = this.range();
    for (const [id, card] of this.cards) {
      const ring = this.store.series.get(id);
      if (ring) this._drawOne(card, ring, from, to);
    }
  }

  /**
   * Draw one chart and update its numeric readout.
   * @param {{canvas: HTMLCanvasElement, read: HTMLElement}} card - The card.
   * @param {LogRing} ring - Its samples.
   * @param {number} from - Window start.
   * @param {number} to - Window end.
   * @returns {void}
   */
  _drawOne(card, ring, from, to) {
    const canvas = card.canvas;
    const cssW = canvas.clientWidth || 240;
    const cssH = canvas.clientHeight || 120;
    const dpr =
      typeof devicePixelRatio === 'number' && devicePixelRatio > 0
        ? Math.min(devicePixelRatio, 2)
        : 1;
    if (canvas.width !== Math.round(cssW * dpr))
      canvas.width = Math.round(cssW * dpr);
    if (canvas.height !== Math.round(cssH * dpr))
      canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const c = this.colors;
    const stats = ring.stats(from, to);
    const unit = ring.unit ? ` ${ring.unit}` : '';

    // the frame, always: an empty chart should read as "nothing yet", not as
    // a missing element
    ctx.strokeStyle = c.line;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, cssW - 1, cssH - 1);
    if (!stats) {
      ctx.fillStyle = c.faint;
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText('waiting…', 8, cssH / 2);
      card.read.innerHTML = '<span class="log-now">—</span>';
      return;
    }

    const { lo, hi } = logNiceScale(stats.min, stats.max);
    const x = (t) => ((t - from) / (to - from)) * cssW;
    const y = (v) => cssH - ((v - lo) / (hi - lo)) * cssH;

    // min/max guides, so the eye gets the band without a full gridwork
    ctx.strokeStyle = c.line;
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.moveTo(0, y(stats.max));
    ctx.lineTo(cssW, y(stats.max));
    ctx.moveTo(0, y(stats.min));
    ctx.lineTo(cssW, y(stats.min));
    ctx.stroke();
    ctx.globalAlpha = 1;

    // the trace
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < ring.t.length; i++) {
      const t = ring.t[i];
      if (t < from || t > to) continue;
      const px = x(t);
      const py = y(ring.v[i]);
      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // axis extremes, drawn inside the frame so no gutter is needed
    ctx.fillStyle = c.faint;
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText(this._fmt(hi), 4, 11);
    ctx.fillText(this._fmt(lo), 4, cssH - 4);

    // the shared cursor
    let cursorVal = null;
    if (this.cursorT != null && this.cursorT >= from && this.cursorT <= to) {
      const cx = x(this.cursorT);
      ctx.strokeStyle = c.ink;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, cssH);
      ctx.stroke();
      ctx.globalAlpha = 1;
      cursorVal = ring.at(this.cursorT, Math.max(2000, this.windowMs / 50));
      if (cursorVal != null) {
        ctx.fillStyle = c.ink;
        ctx.beginPath();
        ctx.arc(cx, y(cursorVal), 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const shown = cursorVal != null ? cursorVal : stats.last;
    card.read.innerHTML =
      `<span class="log-now">${esc(this._fmt(shown))}${esc(unit)}</span>` +
      `<span class="log-range">min ${esc(this._fmt(stats.min))} · ` +
      `max ${esc(this._fmt(stats.max))}</span>`;
  }

  /**
   * Format a value for a readout: enough precision to see a change, without
   * the float noise a raw toString would show.
   * @param {number} v - The value.
   * @returns {string}
   */
  _fmt(v) {
    if (!Number.isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1000) return v.toFixed(0);
    if (a >= 10) return v.toFixed(1);
    if (a >= 1) return v.toFixed(2);
    return v.toFixed(3);
  }

  /**
   * Change the visible window.
   * @param {number} ms - The new window in ms.
   * @returns {void}
   */
  setWindow(ms) {
    this.windowMs = ms;
    this._drawn = -1;
    this.draw();
  }

  /**
   * Re-read the skin's colours (the theme changed) and redraw.
   * @returns {void}
   */
  refreshTheme() {
    this.colors = logChartColors();
    this._drawn = -1;
    this.draw();
  }

  /**
   * Drop the resize listener and any pending frame.
   * @returns {void}
   */
  destroy() {
    if (typeof window !== 'undefined')
      window.removeEventListener('resize', this._onResize);
    if (this._raf != null) {
      if (typeof cancelAnimationFrame === 'function')
        cancelAnimationFrame(this._raf);
      else clearTimeout(this._raf);
      this._raf = null;
    }
  }
}

// node loads these pieces as modules; the browser gives them one shared scope
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LOG_WINDOWS, logChartColors, logNiceScale, LogChartGrid };
}
