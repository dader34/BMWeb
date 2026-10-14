/**
 * @file Tuning screen: the table as a graph. A "Graph" list in the table
 * dialog opens a floating window that draws the map one of two ways, the
 * way a map editor does: the grid shows the figures, the graph shows the
 * shape -- a step, a hole or a ridge is plain there long before it is in a
 * column of numbers. Under live mode the point the DME is reading rides on
 * it.
 *
 * 3D is a shaded sheet, turned by dragging: each cell is a corner, each
 * patch between four cells is filled with the heat colour of their mean and
 * painted back to front. 2D is one line per row over the column axis, on a
 * dark plot. Both on a plain canvas.
 */
/* exported tnSurfaceAttach, tnSurfaceDetach, tnSurfaceRequest */

/** The window's size when it first opens. */
const TN_SURFACE_W = 480;
const TN_SURFACE_H = 440;
/** How much of the pane's height the value axis takes at full swing. */
const TN_SURFACE_Z = 0.55;
/** Where the choice is remembered between tables and visits: '2d', '3d',
 *  or '0' for no graph ('1' is the 3D tick this list replaced). */
const TN_SURFACE_KEY = 'bmweb.tuning.surface';
/** Where the window was last left, so the next table's opens there too. */
let tnSurfacePlace = null;

// The floating windows of this screen (the surface, the gauge, the values)
// stack by use: whichever was pressed or dragged last is on top. One
// listener for all of them, on the way down, so it runs before the window's
// own handlers and whatever they do.
let tnFloatTop = 70;
if (typeof document !== 'undefined' && document.addEventListener)
  document.addEventListener(
    'mousedown',
    (e) => {
      const win =
        e.target && e.target.closest
          ? e.target.closest('.tn-surface-win')
          : null;
      if (win && win.style.zIndex !== String(tnFloatTop))
        win.style.zIndex = String(++tnFloatTop);
    },
    true
  );

/**
 * The graph that was left on.
 * @returns {''|'2d'|'3d'}
 */
function tnSurfaceWanted() {
  try {
    const v = localStorage.getItem(TN_SURFACE_KEY);
    return v === '2d' ? '2d' : v === '3d' || v === '1' ? '3d' : '';
  } catch (e) {
    return '';
  }
}

/**
 * Add the Graph list to a table dialog that has just been built, and the
 * window it opens: a floating one of its own, moved by its title bar and
 * sized by its corner, so the grid keeps the dialog to itself. A curve (one
 * row or one column) has no surface, so its list offers 2D alone; a single
 * value has nothing to draw and gets no list.
 * @param {TableModal} m
 * @returns {void}
 */
function tnSurfaceAttach(m) {
  if (m.t.rows < 2 && m.t.cols < 2) return;
  const flat = m.t.rows < 2 || m.t.cols < 2;
  const pick = document.createElement('span');
  pick.className = 'tn-live-apps tn-graph-pick';
  pick.innerHTML =
    '<button type="button" class="btn tn-live-apps-btn" aria-haspopup="true" aria-expanded="false" title="Draw the table in a window of its own">Graph ▾</button>' +
    '<div class="tn-live-apps-menu" hidden>' +
    '<button type="button" class="tn-graph-opt" data-mode="2d" title="One line per row over the column axis">2D lines</button>' +
    (flat
      ? ''
      : '<button type="button" class="tn-graph-opt" data-mode="3d" title="A shaded sheet: drag to turn it">3D surface</button>') +
    '</div>';
  const pickBtn = pick.querySelector('.tn-live-apps-btn');
  const menu = pick.querySelector('.tn-live-apps-menu');
  m.heatBox.closest('label').after(pick);

  const win = document.createElement('div');
  win.className = 'tn-surface-win';
  win.hidden = true;
  win.innerHTML =
    `<div class="tn-surface-head"><span>${esc(m.item.title || 'table')}</span>` +
    '<button type="button" class="tn-surface-x" aria-label="Close">×</button></div>' +
    '<div class="tn-surface"><canvas></canvas></div>';
  const head = win.querySelector('.tn-surface-head');
  const pane = win.querySelector('.tn-surface');
  const canvas = win.querySelector('canvas');
  // on the page itself, above everything: the table editor is docked in a
  // pane that clips, and this window is free to sit anywhere
  document.body.appendChild(win);
  const place = tnSurfacePlace || {
    left: Math.max(8, window.innerWidth - TN_SURFACE_W - 24),
    top: 72,
    width: TN_SURFACE_W,
    height: TN_SURFACE_H,
  };
  win.style.left = `${place.left}px`;
  win.style.top = `${place.top}px`;
  win.style.width = `${place.width}px`;
  win.style.height = `${place.height}px`;

  const s = {
    mode: '',
    shut: null,
    win,
    pane,
    canvas,
    yaw: -0.65,
    pitch: 0.5,
    drag: null,
    frame: 0,
    move: null,
    up: null,
    sized: null,
  };
  m.surface = s;

  canvas.onmousedown = (e) => {
    if (e.button !== 0 || s.mode !== '3d') return; // only the sheet turns
    e.preventDefault();
    s.drag = {
      turn: true,
      x: e.clientX,
      y: e.clientY,
      yaw: s.yaw,
      pitch: s.pitch,
    };
  };
  head.onmousedown = (e) => {
    if (e.button !== 0 || e.target.closest('.tn-surface-x')) return;
    e.preventDefault();
    s.drag = {
      turn: false,
      x: e.clientX,
      y: e.clientY,
      left: win.offsetLeft,
      top: win.offsetTop,
    };
  };
  s.move = (e) => {
    if (!s.drag) return;
    const dx = e.clientX - s.drag.x;
    const dy = e.clientY - s.drag.y;
    if (s.drag.turn) {
      s.yaw = s.drag.yaw - dx * 0.01;
      s.pitch = Math.max(0.12, Math.min(1.45, s.drag.pitch + dy * 0.008));
      tnSurfaceRequest(m);
    } else {
      // never wholly off the page: the title bar stays reachable
      win.style.left = `${Math.max(40 - win.offsetWidth, Math.min(window.innerWidth - 40, s.drag.left + dx))}px`;
      win.style.top = `${Math.max(0, Math.min(window.innerHeight - 28, s.drag.top + dy))}px`;
    }
  };
  s.up = () => {
    s.drag = null;
    if (!win.hidden)
      tnSurfacePlace = {
        left: win.offsetLeft,
        top: win.offsetTop,
        width: win.offsetWidth,
        height: win.offsetHeight,
      };
  };
  window.addEventListener('mousemove', s.move);
  window.addEventListener('mouseup', s.up);
  // dragged by its corner: draw again at the new size
  if (typeof ResizeObserver === 'function') {
    s.sized = new ResizeObserver(() => tnSurfaceRequest(m));
    s.sized.observe(pane);
  }

  const show = (mode) => {
    s.mode = mode;
    win.hidden = !mode;
    pane.classList.toggle('tn-surface-flat', mode === '2d');
    for (const o of menu.querySelectorAll('.tn-graph-opt'))
      o.classList.toggle('on', o.dataset.mode === mode);
    pickBtn.classList.toggle('on', !!mode);
    if (mode) tnSurfaceRequest(m);
  };
  const set = (mode) => {
    try {
      localStorage.setItem(TN_SURFACE_KEY, mode || '0');
    } catch (e) {
      /* not remembered, still shown */
    }
    show(mode);
  };
  const openMenu = (on) => {
    menu.hidden = !on;
    pickBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
  };
  pickBtn.onclick = () => openMenu(menu.hidden);
  menu.onclick = (e) => {
    const o = e.target.closest('.tn-graph-opt');
    if (!o) return;
    openMenu(false);
    // the one that is showing, picked again, closes the window
    set(o.dataset.mode === s.mode ? '' : o.dataset.mode);
  };
  // a press anywhere else puts the list away
  s.shut = (e) => {
    if (!menu.hidden && !pick.contains(e.target)) openMenu(false);
  };
  document.addEventListener('mousedown', s.shut);
  win.querySelector('.tn-surface-x').onclick = () => set('');
  // what was left on, where this table can draw it (shown, not re-stored: a
  // curve opening as 2D must not turn the next map's 3D into 2D)
  const wanted = tnSurfaceWanted();
  show(flat && wanted ? '2d' : wanted);
}

/**
 * The dialog is closing: let go of the window listeners.
 * @param {TableModal} m
 * @returns {void}
 */
function tnSurfaceDetach(m) {
  const s = m.surface;
  if (!s) return;
  window.removeEventListener('mousemove', s.move);
  window.removeEventListener('mouseup', s.up);
  if (s.shut) document.removeEventListener('mousedown', s.shut);
  if (s.sized) s.sized.disconnect();
  if (s.frame) cancelAnimationFrame(s.frame);
  s.win.remove();
  m.surface = null;
}

/**
 * Something the surface shows has changed (a cell, the live point, the
 * angle): redraw on the next frame, once however often this is asked.
 * @param {TableModal} m
 * @returns {void}
 */
function tnSurfaceRequest(m) {
  const s = m.surface;
  if (!s || s.win.hidden || s.frame) return;
  s.frame = requestAnimationFrame(() => {
    s.frame = 0;
    if (m.surface !== s) return;
    if (s.mode === '2d') tnGraphDraw(m, s);
    else tnSurfaceDraw(m);
  });
}

/**
 * Size a pane's canvas to it at the screen's own resolution and clear it.
 * @param {{pane:HTMLElement, canvas:HTMLCanvasElement}} s
 * @returns {{g:CanvasRenderingContext2D, w:number, h:number}|null} null
 *   while the pane is too small to draw in.
 */
function tnSurfaceCanvas(s) {
  const w = s.pane.clientWidth;
  const h = s.pane.clientHeight;
  if (w < 40 || h < 40) return null;
  const dpr = window.devicePixelRatio || 1;
  if (
    s.canvas.width !== Math.round(w * dpr) ||
    s.canvas.height !== Math.round(h * dpr)
  ) {
    s.canvas.width = Math.round(w * dpr);
    s.canvas.height = Math.round(h * dpr);
    s.canvas.style.width = `${w}px`;
    s.canvas.style.height = `${h}px`;
  }
  const g = s.canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}

/**
 * Round steps for an axis: about `n` of them across lo..hi.
 * @param {number} lo
 * @param {number} hi
 * @param {number} n
 * @returns {number[]} The values to mark, within lo..hi.
 */
function tnGraphTicks(lo, hi, n) {
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
 * Draw the table as lines: one per row over the column axis (a table of one
 * column is drawn as its one line over the row axis). The line of the row
 * the DME is reading in is the bright one, with the point itself on it.
 * @param {TableModal} m
 * @param {{pane:HTMLElement, canvas:HTMLCanvasElement}} s
 * @returns {void}
 */
function tnGraphDraw(m, s) {
  const c = tnSurfaceCanvas(s);
  if (!c) return;
  const { g, w, h } = c;
  const t = m.t;
  // along: the axis under the plot; lines: one per step of the other
  const upright = t.cols < 2;
  const n = upright ? t.rows : t.cols;
  const lines = upright ? 1 : t.rows;
  const labels = upright ? m.yLabels : m.xLabels;
  const axis = upright ? t.y : t.x;
  const cell = (line, i) => (upright ? t.cells[i][0] : t.cells[line][i]);
  const xs = [];
  for (let i = 0; i < n; i++) xs.push(tnAxisPos(labels, i));
  // break points that do not rise cannot be an axis: fall back to the index
  if (xs.some((v, i) => i && v <= xs[i - 1]))
    for (let i = 0; i < n; i++) xs[i] = i;
  const { lo, span, count } = tnCellBounds(t.cells);
  if (!count) return; // nothing read yet
  const pad = span > 0 ? span * 0.06 : 1;
  const y0 = lo - pad;
  const y1 = lo + span + pad;

  g.fillStyle = '#05070a';
  g.fillRect(0, 0, w, h);
  g.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  const yTicks = tnGraphTicks(y0, y1, Math.max(2, Math.floor(h / 44)));
  const left =
    Math.max(...yTicks.map((v) => g.measureText(fmtNum(v, m.dp)).width)) + 14;
  const box = { l: left, t: 12, r: w - 14, b: h - 34 };
  if (box.r - box.l < 20 || box.b - box.t < 20) return;
  const X = (v) =>
    box.l + ((v - xs[0]) / (xs[n - 1] - xs[0] || 1)) * (box.r - box.l);
  const Y = (v) => box.b - ((v - y0) / (y1 - y0)) * (box.b - box.t);

  // ---- the grid and its figures --------------------------------------------
  g.lineWidth = 1;
  g.strokeStyle = 'rgba(138, 151, 163, 0.22)';
  g.fillStyle = '#8a97a3';
  g.textAlign = 'right';
  g.textBaseline = 'middle';
  for (const v of yTicks) {
    const y = Math.round(Y(v)) + 0.5;
    g.beginPath();
    g.moveTo(box.l, y);
    g.lineTo(box.r, y);
    g.stroke();
    g.fillText(fmtNum(v, m.dp), box.l - 6, y);
  }
  g.textAlign = 'center';
  g.textBaseline = 'top';
  const xTicks = tnGraphTicks(
    xs[0],
    xs[n - 1],
    Math.max(2, Math.floor((box.r - box.l) / 64))
  );
  for (const v of xTicks) {
    const x = Math.round(X(v)) + 0.5;
    g.beginPath();
    g.moveTo(x, box.t);
    g.lineTo(x, box.b);
    g.stroke();
    g.fillText(String(Math.round(v * 1000) / 1000), x, box.b + 5);
  }
  g.strokeStyle = 'rgba(138, 151, 163, 0.5)';
  g.strokeRect(box.l + 0.5, box.t + 0.5, box.r - box.l, box.b - box.t);
  if (axis && axis.units)
    g.fillText(axis.units, (box.l + box.r) / 2, box.b + 19);

  // ---- the lines: the lowest row coolest, the live one last and brightest ---
  const live = m.cursor && m.cursor.shown ? m.cursor.pos : null;
  const across = live ? (upright ? live.row : live.col) : null;
  // a table of one line has no second axis to be read on: its line is it
  const down = lines === 1 ? { index: 0 } : live ? live.row : null;
  const liveLine = across && down ? Math.round(down.index) : -1;
  const order = [];
  for (let k = 0; k < lines; k++) if (k !== liveLine) order.push(k);
  if (liveLine >= 0 && liveLine < lines) order.push(liveLine);
  for (const k of order) {
    const isLive = k === liveLine;
    const colour = isLive
      ? '#ffffff'
      : heatColorBright(lines > 1 ? k / (lines - 1) : 0.5).bg;
    g.strokeStyle = colour;
    g.fillStyle = '#05070a';
    g.lineWidth = isLive ? 2 : 1.25;
    g.globalAlpha = live && !isLive ? 0.55 : 1;
    g.beginPath();
    let pen = false;
    const marks = [];
    for (let i = 0; i < n; i++) {
      const v = cell(k, i);
      if (v == null || !Number.isFinite(v)) {
        pen = false;
        continue;
      }
      const x = X(xs[i]);
      const y = Y(v);
      if (pen) g.lineTo(x, y);
      else g.moveTo(x, y);
      pen = true;
      marks.push([x, y]);
    }
    g.stroke();
    // a square on every break point, where the space allows one
    if ((box.r - box.l) / n > 9)
      for (const [x, y] of marks) {
        g.fillRect(x - 2.5, y - 2.5, 5, 5);
        g.strokeRect(x - 2.5, y - 2.5, 5, 5);
      }
  }
  g.globalAlpha = 1;

  // ---- the live point: where along the axis, and the value read there ------
  if (across) {
    const i0 = Math.min(n - 1, Math.floor(across.index));
    const i1 = Math.min(n - 1, i0 + 1);
    const x = X(xs[i0] + (xs[i1] - xs[i0]) * (across.index - i0));
    g.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(Math.round(x) + 0.5, box.t);
    g.lineTo(Math.round(x) + 0.5, box.b);
    g.stroke();
    const v = !down
      ? null
      : upright
        ? ltCursorCell(t.cells, across.index, 0)
        : ltCursorCell(t.cells, down.index, across.index);
    if (v != null) {
      g.beginPath();
      g.arc(x, Y(v), 4.5, 0, Math.PI * 2);
      g.fillStyle = '#fff';
      g.fill();
      g.lineWidth = 2;
      g.strokeStyle = '#2f6fed';
      g.stroke();
    }
  }
}

/**
 * Draw the table as a surface.
 * @param {TableModal} m
 * @param {{pane:HTMLElement, canvas:HTMLCanvasElement, yaw:number, pitch:number}} [s] -
 *   Where to draw and from what angle: the floating window's, or a chart's.
 * @returns {void}
 */
function tnSurfaceDraw(m, s = m.surface) {
  const t = m.t;
  const made = tnSurfaceCanvas(s);
  if (!made) return;
  const { g, w, h } = made;

  const { lo, span } = tnCellBounds(t.cells);
  const frac = (v) => (span > 0 ? (v - lo) / span : 0);
  const cy = Math.cos(s.yaw);
  const sy = Math.sin(s.yaw);
  const cp = Math.cos(s.pitch);
  const sp = Math.sin(s.pitch);
  const scale = Math.min(w, h) * 0.6;
  /**
   * A point of the unit box (x across the columns, y down the rows, z up the
   * values, each -0.5..0.5) on the canvas, with how near the viewer it is.
   */
  const project = (x, y, z) => {
    const rx = x * cy - y * sy;
    const ry = x * sy + y * cy;
    return {
      x: w / 2 + rx * scale,
      y: h / 2 + (ry * sp - z * TN_SURFACE_Z * cp) * scale + h * 0.03,
      near: ry * cp + z * TN_SURFACE_Z * sp,
    };
  };
  const at = (r, c) => {
    const v = t.cells[r][c];
    const ok = v != null && Number.isFinite(v);
    return { ok, f: ok ? frac(v) : 0 };
  };
  const px = (c) => c / (t.cols - 1) - 0.5;
  const py = (r) => r / (t.rows - 1) - 0.5;

  // ---- the floor and the value axis, behind the sheet -----------------------
  const ink = '#8a97a3';
  g.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  g.lineWidth = 1;
  const floor = [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
  ].map(([x, y]) => ({ x, y, p: project(x, y, -0.5) }));
  g.strokeStyle = 'rgba(138, 151, 163, 0.35)';
  g.beginPath();
  floor.forEach((k, i) =>
    i ? g.lineTo(k.p.x, k.p.y) : g.moveTo(k.p.x, k.p.y)
  );
  g.closePath();
  g.stroke();
  // the value axis stands on the corner farthest from the viewer
  const back = floor.reduce((a, b) => (b.p.near < a.p.near ? b : a));
  const top = project(back.x, back.y, 0.5);
  g.beginPath();
  g.moveTo(back.p.x, back.p.y);
  g.lineTo(top.x, top.y);
  g.stroke();
  g.fillStyle = ink;
  g.textAlign = 'center';
  g.textBaseline = 'bottom';
  g.fillText(fmtNum(lo + span, m.dp), top.x, top.y - 3);
  g.textBaseline = 'top';
  g.fillText(fmtNum(lo, m.dp), back.p.x, back.p.y + 3);

  // ---- the sheet: patches between four cells, far ones first ----------------
  const patches = [];
  for (let r = 0; r < t.rows - 1; r++)
    for (let c = 0; c < t.cols - 1; c++) {
      const q = [at(r, c), at(r, c + 1), at(r + 1, c + 1), at(r + 1, c)];
      if (q.some((k) => !k.ok)) continue;
      const pts = [
        project(px(c), py(r), q[0].f - 0.5),
        project(px(c + 1), py(r), q[1].f - 0.5),
        project(px(c + 1), py(r + 1), q[2].f - 0.5),
        project(px(c), py(r + 1), q[3].f - 0.5),
      ];
      patches.push({
        r,
        c,
        pts,
        near: (pts[0].near + pts[1].near + pts[2].near + pts[3].near) / 4,
        f: (q[0].f + q[1].f + q[2].f + q[3].f) / 4,
      });
    }
  patches.sort((a, b) => a.near - b.near);
  const live = m.cursor && m.cursor.shown ? m.cursor.pos : null;
  const liveR =
    live && live.row ? Math.min(t.rows - 2, Math.floor(live.row.index)) : -1;
  const liveC =
    live && live.col ? Math.min(t.cols - 2, Math.floor(live.col.index)) : -1;
  g.strokeStyle = 'rgba(0, 0, 0, 0.5)';
  g.lineJoin = 'round';
  for (const p of patches) {
    // the patch the DME is reading in is the dark one
    g.fillStyle =
      p.r === liveR && p.c === liveC ? '#0b2a6b' : heatColorBright(p.f).bg;
    g.beginPath();
    p.pts.forEach((k, i) => (i ? g.lineTo(k.x, k.y) : g.moveTo(k.x, k.y)));
    g.closePath();
    g.fill();
    g.stroke();
  }

  // ---- the live point itself, riding on the sheet ---------------------------
  if (live && live.row && live.col) {
    const v = ltCursorCell(t.cells, live.row.index, live.col.index);
    if (v != null) {
      const p = project(
        live.col.index / (t.cols - 1) - 0.5,
        live.row.index / (t.rows - 1) - 0.5,
        frac(v) - 0.5
      );
      g.beginPath();
      g.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
      g.fillStyle = '#fff';
      g.fill();
      g.lineWidth = 2;
      g.strokeStyle = '#0b0f14';
      g.stroke();
      g.lineWidth = 1;
    }
  }

  // ---- the two axes, named along the floor edges nearest the viewer ---------
  const edge = (a, b, first, last, name) => {
    const pa = project(a[0], a[1], -0.5);
    const pb = project(b[0], b[1], -0.5);
    g.fillStyle = ink;
    g.textBaseline = 'top';
    g.textAlign = 'center';
    g.fillText(String(first), pa.x, pa.y + 5);
    g.fillText(String(last), pb.x, pb.y + 5);
    if (name) g.fillText(name, (pa.x + pb.x) / 2, (pa.y + pb.y) / 2 + 16);
  };
  const nearer = (y1, y2) =>
    project(0, y1, -0.5).near > project(0, y2, -0.5).near ? y1 : y2;
  const nearerX = (x1, x2) =>
    project(x1, 0, -0.5).near > project(x2, 0, -0.5).near ? x1 : x2;
  const ey = nearer(-0.5, 0.5);
  const ex = nearerX(-0.5, 0.5);
  const lab = (labels, i) => (labels[i] != null ? labels[i] : i);
  edge(
    [-0.5, ey],
    [0.5, ey],
    lab(m.xLabels, 0),
    lab(m.xLabels, t.cols - 1),
    (t.x && t.x.units) || ''
  );
  edge(
    [ex, -0.5],
    [ex, 0.5],
    lab(m.yLabels, 0),
    lab(m.yLabels, t.rows - 1),
    (t.y && t.y.units) || ''
  );
}
