/**
 * @file Tuning screen: the table as a surface. A "3D" tick in the table
 * dialog opens a floating window that draws the map as a shaded sheet,
 * the way a map editor does: the grid shows the figures, the sheet shows
 * the shape -- a step, a hole or a ridge is plain there long before it is in
 * a column of numbers. Drag it to turn it. Under live mode the point the
 * DME is reading rides on it.
 *
 * Drawn on a plain canvas: each cell is a corner of the sheet, each patch
 * between four cells is filled with the heat colour of their mean and
 * painted back to front.
 */
/* exported tnSurfaceAttach, tnSurfaceDetach, tnSurfaceRequest */

/** The window's size when it first opens. */
const TN_SURFACE_W = 480;
const TN_SURFACE_H = 440;
/** How much of the pane's height the value axis takes at full swing. */
const TN_SURFACE_Z = 0.55;
/** Where the tick is remembered between tables and visits. */
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
 * Whether the surface was left on.
 * @returns {boolean}
 */
function tnSurfaceWanted() {
  try {
    return localStorage.getItem(TN_SURFACE_KEY) === '1';
  } catch (e) {
    return false;
  }
}

/**
 * Add the 3D tick to a table dialog that has just been built, and the
 * window it opens: a floating one of its own, moved by its title bar and
 * sized by its corner, so the grid keeps the dialog to itself. A curve (one
 * row or one column) has no surface and gets neither.
 * @param {TableModal} m
 * @returns {void}
 */
function tnSurfaceAttach(m) {
  if (m.t.rows < 2 || m.t.cols < 2) return;
  const label = document.createElement('label');
  label.className = 'tn-tool-check';
  label.title =
    'Open the table as a surface in a window of its own (drag to turn it)';
  const box = document.createElement('input');
  box.type = 'checkbox';
  label.append(box, ' 3D');
  m.heatBox.closest('label').after(label);

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
    box,
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
    if (e.button !== 0) return;
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

  const set = (on) => {
    box.checked = on;
    try {
      localStorage.setItem(TN_SURFACE_KEY, on ? '1' : '0');
    } catch (e) {
      /* not remembered, still shown */
    }
    win.hidden = !on;
    if (on) tnSurfaceRequest(m);
  };
  box.onchange = () => set(box.checked);
  win.querySelector('.tn-surface-x').onclick = () => set(false);
  box.checked = tnSurfaceWanted();
  win.hidden = !box.checked;
  if (box.checked) tnSurfaceRequest(m);
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
    if (m.surface === s) tnSurfaceDraw(m);
  });
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
  const w = s.pane.clientWidth;
  const h = s.pane.clientHeight;
  if (w < 40 || h < 40) return;
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
      p.r === liveR && p.c === liveC ? '#0b2a6b' : heatColor(p.f).bg;
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
