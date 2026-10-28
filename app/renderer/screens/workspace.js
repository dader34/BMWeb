// Workspace: two to four of the app's screens side by side, on ONE cable.
//
// Each pane is a frame of BMWeb itself at a route, so anything goes in any
// pane -- the tune editor live, data logging, a module's fault memory,
// Web32 -- and nothing in those screens changes: every screen still owns
// the one #view of its own document. The cable is this page's: a pane
// adopts its shell's bus and lock (core/webshim/bus.js, busShell), so the
// panes' jobs take their turn on the one K-line, and a flash from a pane
// holds the cable for all of them as it would for the shell's own screens.
//
// Layouts are presets (left/right, top/bottom, one wide + two, 2 x 2).
// A pane is narrower than the app's compact-layout breakpoints (up to
// 900 px), so each frame gets a desktop-sized viewport (the "scale" width)
// and is scaled down to fit its pane: a pane is the desktop app, smaller,
// not the phone layout. What a pane shows is picked from a tile grid over
// the pane (the same tiles as Home); a pane can float over the grid as a
// window of its own (dragged by its header, resized from its corner) and
// dock back. The pane's frame never moves in the DOM -- moving an iframe
// reloads it -- only its styling changes. Which app is in which pane, the
// layout and the scale width are remembered.
/* exported showWorkspace */

const WS_STORE = 'bmweb.workspace';

/** The presets: the grid's tracks, how many panes, and where each sits. */
const WS_LAYOUTS = {
  'two-lr': {
    label: 'Left / right',
    glyph: '◧',
    n: 2,
    cols: '1fr 1fr',
    rows: '1fr',
    areas: ['1 / 1', '1 / 2'],
  },
  'two-tb': {
    label: 'Top / bottom',
    glyph: '⬒',
    n: 2,
    cols: '1fr',
    rows: '1fr 1fr',
    areas: ['1 / 1', '2 / 1'],
  },
  three: {
    label: 'One wide + two',
    glyph: '⬓',
    n: 3,
    cols: '1fr 1fr',
    rows: '1fr 1fr',
    areas: ['1 / 1 / 2 / 3', '2 / 1', '2 / 2'],
  },
  four: {
    label: '2 × 2',
    glyph: '⊞',
    n: 4,
    cols: '1fr 1fr',
    rows: '1fr 1fr',
    areas: ['1 / 1', '1 / 2', '2 / 1', '2 / 2'],
  },
};

/** What a pane can open: a route (core/router.js), as a tile. */
const WS_APPS = [
  {
    route: 'apps/tuning',
    icon: '⛁',
    title: 'Tuning',
    desc: 'Edit the tune; LIVE on the running engine',
  },
  {
    route: 'apps/logging',
    icon: '∿',
    title: 'Data logging',
    desc: 'Chart readings while you drive',
  },
  {
    route: '',
    icon: '▣',
    title: 'Diagnostics',
    desc: 'A module: fault memory, live values, activations',
  },
  {
    route: 'apps/tool32',
    icon: '⌗',
    title: 'Web32',
    desc: 'Run any SGBD job, read its registers',
  },
  {
    route: 'apps/flashing',
    icon: '↯',
    title: 'Flashing',
    desc: 'Read and write the DME and the gearbox',
  },
  {
    route: 'apps/history',
    icon: '⟲',
    title: 'Flashing history',
    desc: 'Every session, with its log',
  },
  {
    route: 'apps/coding',
    icon: '⚙',
    title: 'Coding',
    desc: 'Change car configurations',
  },
  {
    route: 'apps/webkfp',
    icon: '↯',
    title: 'WebKFP',
    desc: 'Flash stock programs',
  },
  {
    route: 'apps/script',
    icon: '⌁',
    title: 'Script runner',
    desc: 'Run an INPA script of your own',
  },
  {
    route: 'inpa',
    icon: '▤',
    title: 'INPA scripts',
    desc: 'The vehicle list, as INPA shows it',
  },
];

/** The frame's viewport width in CSS px (0 = the pane's own, unscaled). */
const WS_SCALES = [
  [1000, 'Compact (1000 px)'],
  [1200, 'Desktop (1200 px)'],
  [1440, 'Wide (1440 px)'],
  [0, 'None (pane size)'],
];

const WS_DEFAULT = {
  layout: 'four',
  routes: ['apps/tuning', 'apps/logging', '', 'apps/tool32'],
  scale: 1200,
};

/** @returns {{layout: string, routes: string[], scale: number}} The saved workspace, or the default. */
function wsLoad() {
  try {
    const s = JSON.parse(localStorage.getItem(WS_STORE) || 'null');
    if (s && WS_LAYOUTS[s.layout] && Array.isArray(s.routes))
      return {
        layout: s.layout,
        // a saved pick the picker no longer offers falls back to the
        // pane's default, instead of coming back under its raw route
        routes: WS_DEFAULT.routes.map((d, i) => {
          const r = String(s.routes[i] || '');
          return WS_APPS.some((a) => a.route === r) ? r : d;
        }),
        scale: WS_SCALES.some(([w]) => w === s.scale)
          ? s.scale
          : WS_DEFAULT.scale,
      };
  } catch {
    /* no storage, or an older shape: the default stands */
  }
  return {
    layout: WS_DEFAULT.layout,
    routes: [...WS_DEFAULT.routes],
    scale: WS_DEFAULT.scale,
  };
}

/** @param {{layout: string, routes: string[], scale: number}} state */
function wsSave(state) {
  try {
    localStorage.setItem(WS_STORE, JSON.stringify(state));
  } catch {
    /* nothing to persist to */
  }
}

/**
 * A pane's URL: this same page, marked as pane N (install.js reads the
 * mark for body.pane), at the route.
 * @param {number} i @param {string} route @returns {string}
 */
function wsPaneUrl(i, route) {
  return `index.html?pane=${i + 1}#${route}`;
}

/** @param {string} route @returns {{icon: string, title: string}} */
function wsAppOf(route) {
  return (
    WS_APPS.find((a) => a.route === route) || {
      icon: '▢',
      title: route || 'Diagnostics',
    }
  );
}

/** The Workspace page. */
function showWorkspace() {
  lastScreen = showWorkspace;
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: 'Apps', fn: showApps },
    { label: 'Workspace' },
  ]);
  document.body.classList.add('apps-section');
  sbLeft.textContent = 'workspace';
  const state = wsLoad();
  view.innerHTML = `
    <div class="ws">
      <div class="ws-toolbar">
        <span class="ws-eyebrow">Workspace</span>
        <div class="ws-ctl">
          <span class="ws-ctl-label">Layout</span>
          <div class="ws-dd" id="ws-layout-dd"></div>
        </div>
        <div class="ws-ctl">
          <span class="ws-ctl-label">Scale</span>
          <div class="ws-dd ws-dd-scale" id="ws-scale-dd"></div>
        </div>
      </div>
      <div class="ws-grid" id="ws-grid"></div>
    </div>`;
  const grid = document.getElementById('ws-grid');
  /** @type {HTMLIFrameElement[]} */
  const frames = [];
  /** @type {HTMLElement[]} */
  const boxes = [];
  /** @type {HTMLElement[]} */
  const panes = [];

  // ---- the frame, laid out at the scale width and shrunk to its box ----
  function fit(i) {
    const f = frames[i];
    const box = boxes[i];
    if (!f || !box) return;
    const W = state.scale;
    const bw = box.clientWidth;
    const bh = box.clientHeight;
    if (!W || !bw || !bh || bw >= W) {
      f.style.width = '100%';
      f.style.height = '100%';
      f.style.transform = '';
      return;
    }
    const k = bw / W;
    f.style.width = `${W}px`;
    f.style.height = `${Math.round(bh / k)}px`;
    f.style.transform = `scale(${k})`;
  }
  const fitAll = () => {
    for (let i = 0; i < frames.length; i++) fit(i);
  };
  const ro =
    typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fitAll) : null;

  // ---- the picker: the tiles over a pane ----------------------------------
  const tilesHtml = (i) =>
    WS_APPS.map(
      (a) =>
        `<button type="button" class="ws-tile" data-pane="${i}" data-route="${esc(a.route)}"
          aria-pressed="${a.route === (state.routes[i] || '')}">
          <span class="ws-tile-icon">${a.icon}</span>
          <span class="ws-tile-title">${esc(a.title)}</span>
          <span class="ws-tile-desc">${esc(a.desc)}</span>
        </button>`
    ).join('');

  function setName(i) {
    const app = wsAppOf(state.routes[i] || '');
    const name = panes[i].querySelector('.ws-name');
    name.innerHTML = `<span class="ws-name-icon">${app.icon}</span>${esc(app.title)}<span class="ws-name-caret">▾</span>`;
  }

  function openPicker(i) {
    const p = panes[i].querySelector('.ws-picker');
    p.innerHTML = `<div class="ws-picker-head">Pane ${i + 1}: what it shows</div>
      <div class="ws-tiles">${tilesHtml(i)}</div>`;
    p.hidden = false;
    for (const t of p.querySelectorAll('.ws-tile'))
      t.onclick = () => {
        pick(i, t.dataset.route);
        p.hidden = true;
      };
  }

  function pick(i, route) {
    state.routes[i] = route;
    wsSave(state);
    setName(i);
    // the pane's own router follows its hash: no reload, the pane's
    // bus (the shell's) stays as it is
    try {
      frames[i].contentWindow.location.hash = '#' + route;
    } catch {
      frames[i].src = wsPaneUrl(i, route);
    }
  }

  // ---- floating: the pane as a window over the grid -----------------------
  function float(i, on) {
    const pane = panes[i];
    if (on) {
      const r = pane.getBoundingClientRect();
      // fixed to the window, so a pane can be dragged over the app's own
      // top bar, right up to the top of the window
      pane.classList.add('ws-float');
      // a grid child with a grid-area is placed relative to that CELL once
      // it is positioned: a floating pane has none
      pane.style.gridArea = '';
      pane.style.left = `${Math.round(r.left)}px`;
      pane.style.top = `${Math.round(r.top)}px`;
      pane.style.width = `${Math.round(r.width)}px`;
      pane.style.height = `${Math.round(r.height)}px`;
      raise(i);
    } else {
      pane.classList.remove('ws-float');
      pane.style.left =
        pane.style.top =
        pane.style.width =
        pane.style.height =
          '';
      pane.style.zIndex = '';
      pane.style.gridArea = WS_LAYOUTS[state.layout].areas[i] || '';
    }
    pane.querySelector('.ws-float-btn').textContent = on ? '⇲' : '⇱';
    pane.querySelector('.ws-float-btn').title = on
      ? 'Dock this pane back into the grid'
      : 'Float this pane as a window over the grid';
    requestAnimationFrame(fitAll);
  }
  // the floating panes keep z-indexes 100..103 in their stacking order:
  // over the page and its top bar, under the app's dialogs (9000+)
  const raise = (i) => {
    const order = panes
      .filter((p) => p && p.classList.contains('ws-float') && p !== panes[i])
      .sort(
        (a, b) => Number(a.style.zIndex || 100) - Number(b.style.zIndex || 100)
      );
    order.push(panes[i]);
    order.forEach((p, k) => {
      p.style.zIndex = String(100 + k);
    });
  };

  function drag(i, e) {
    const pane = panes[i];
    if (!pane.classList.contains('ws-float') || e.button !== 0) return;
    e.preventDefault();
    raise(i);
    const r0 = pane.getBoundingClientRect();
    const x0 = e.clientX - r0.left;
    const y0 = e.clientY - r0.top;
    // the frames would swallow the pointer mid-drag
    grid.classList.add('ws-dragging');
    const move = (ev) => {
      pane.style.left = `${Math.max(0, ev.clientX - x0)}px`;
      pane.style.top = `${Math.max(0, ev.clientY - y0)}px`;
    };
    const up = () => {
      grid.classList.remove('ws-dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // ---- the panes --------------------------------------------------------------
  const paneHtml = (i) => `
      <div class="ws-pane-head">
        <span class="ws-pane-no">${i + 1}</span>
        <button type="button" class="ws-name" title="Pick what this pane shows"></button>
        <span class="ws-grip" title="Drag a floating pane here; double-click to float or dock"></span>
        <button type="button" class="ws-float-btn" title="Float this pane as a window over the grid">⇱</button>
      </div>
      <div class="ws-picker" hidden></div>
      <div class="ws-frame-box"></div>`;

  function wire(pane, i) {
    pane.querySelector('.ws-name').onclick = () => {
      const p = pane.querySelector('.ws-picker');
      if (p.hidden) openPicker(i);
      else p.hidden = true;
    };
    const fb = pane.querySelector('.ws-float-btn');
    fb.onclick = () => float(i, !pane.classList.contains('ws-float'));
    const head = pane.querySelector('.ws-pane-head');
    head.onpointerdown = (e) => {
      if (e.target.closest('button')) return;
      drag(i, e);
    };
    head.ondblclick = (e) => {
      if (e.target.closest('button')) return;
      float(i, !pane.classList.contains('ws-float'));
    };
    pane.onpointerdown = () => {
      if (pane.classList.contains('ws-float')) raise(i);
    };
    if (ro) ro.observe(pane); // a resize from the corner refits the frame
  }

  function apply() {
    const L = WS_LAYOUTS[state.layout];
    grid.style.gridTemplateColumns = L.cols;
    grid.style.gridTemplateRows = L.rows;
    for (let i = 0; i < 4; i++) {
      let pane = grid.children[i];
      if (!pane) {
        pane = document.createElement('div');
        pane.className = 'ws-pane';
        pane.innerHTML = paneHtml(i);
        const f = document.createElement('iframe');
        f.className = 'ws-frame';
        f.title = `pane ${i + 1}`;
        // the pane never asks for the port itself (the shell holds it),
        // but a pane that does should be allowed to, not refused silently
        f.setAttribute('allow', 'serial');
        f.src = wsPaneUrl(i, state.routes[i] || '');
        frames[i] = f;
        const box = pane.querySelector('.ws-frame-box');
        boxes[i] = box;
        box.appendChild(f);
        if (ro) ro.observe(box);
        panes[i] = pane;
        grid.appendChild(pane);
        wire(pane, i);
        setName(i);
      }
      // panes past the layout's count keep their frame (and its screen's
      // state) but are hidden, so switching 2 x 2 -> left/right -> 2 x 2
      // brings the same apps back
      pane.hidden = i >= L.n;
      if (!pane.classList.contains('ws-float'))
        pane.style.gridArea = i < L.n ? L.areas[i] : '';
    }
    wsSave(state);
    // the boxes have their new sizes once the grid has laid out
    requestAnimationFrame(fitAll);
  }

  const dd = (items, value, onChange, renderRow) =>
    makeDropdown({
      items,
      value,
      classPrefix: 'lkd',
      parts: { cur: 'val', menu: 'pop', opt: 'item' },
      searchable: false,
      renderRow,
      onChange,
    });
  const layoutDd = dd(
    Object.entries(WS_LAYOUTS).map(([k, l]) => ({
      val: k,
      label: `${l.glyph}\u2003${l.label}`,
      glyph: l.glyph,
      name: l.label,
    })),
    state.layout,
    (v) => {
      state.layout = v;
      apply();
    },
    (o) =>
      `<span class="ws-dd-glyph">${o.glyph}</span><span class="lkd-item-label">${esc(o.name)}</span>`
  );
  document.getElementById('ws-layout-dd').appendChild(layoutDd.el);
  const scaleDd = dd(
    WS_SCALES.map(([w, name]) => ({ val: w, label: name })),
    state.scale,
    (v) => {
      state.scale = Number(v) || 0;
      wsSave(state);
      fitAll();
    },
    (o) => `<span class="lkd-item-label">${esc(o.label)}</span>`
  );
  document.getElementById('ws-scale-dd').appendChild(scaleDd.el);
  apply();
}
