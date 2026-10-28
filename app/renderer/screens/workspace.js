// Workspace: two to four of the app's screens side by side, on ONE cable.
//
// Each pane is a frame of BMWeb itself at a route, so anything goes in any
// pane -- the tune editor live, data logging, a module's fault memory,
// Web32 -- and nothing in those screens changes: every screen still owns
// the one #view of its own document. The cable is this page's: a pane
// adopts its shell's bus and lock (core/webshim/bus.js, busShell), so the
// panes' jobs take their turn on the one K-line, and a flash from a pane
// holds the cable for all of them as it would for the shell's own screens.
// A pane can pop out into its own window and keep the same cable through
// its opener; that is the road to a second tab on another monitor.
//
// Layouts are presets (left/right, top/bottom, one wide + two, 2 x 2).
// A pane is narrower than the app's compact-layout breakpoints (up to
// 900 px), so each frame gets a desktop-sized viewport (the "scale" width)
// and is scaled down to fit its pane: a pane is the desktop app, smaller,
// not the phone layout. Which app is in which pane, the layout and the
// scale width are remembered.
/* exported showWorkspace */

const WS_STORE = 'bmweb.workspace';

/** The presets: the grid's tracks, how many panes, and where each sits. */
const WS_LAYOUTS = {
  'two-lr': {
    label: 'Left / right',
    n: 2,
    cols: '1fr 1fr',
    rows: '1fr',
    areas: ['1 / 1', '1 / 2'],
  },
  'two-tb': {
    label: 'Top / bottom',
    n: 2,
    cols: '1fr',
    rows: '1fr 1fr',
    areas: ['1 / 1', '2 / 1'],
  },
  three: {
    label: 'One wide + two',
    n: 3,
    cols: '1fr 1fr',
    rows: '1fr 1fr',
    areas: ['1 / 1 / 2 / 3', '2 / 1', '2 / 2'],
  },
  four: {
    label: '2 × 2',
    n: 4,
    cols: '1fr 1fr',
    rows: '1fr 1fr',
    areas: ['1 / 1', '1 / 2', '2 / 1', '2 / 2'],
  },
};

/** What a pane can open: a route (core/router.js) and its name. */
const WS_APPS = [
  ['apps/tuning', 'Tuning (live tune)'],
  ['apps/logging', 'Data logging'],
  ['', 'Vehicles: modules, fault memory, live values'],
  ['apps/tool32', 'Web32 (tool32)'],
  ['apps/flashing', 'Flashing'],
  ['apps/history', 'Flashing history'],
  ['apps/coding', 'Coding'],
  ['apps/webkfp', 'WebKFP'],
  ['apps/job-search', 'Job search'],
  ['apps/script', 'Script runner'],
  ['apps/tree', 'ECU tree'],
  ['apps/service', 'Service'],
  ['garage', 'Garage'],
  ['inpa', 'INPA scripts'],
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

/** @returns {{layout: string, routes: string[]}} The saved workspace, or the default. */
function wsLoad() {
  try {
    const s = JSON.parse(localStorage.getItem(WS_STORE) || 'null');
    if (s && WS_LAYOUTS[s.layout] && Array.isArray(s.routes))
      return {
        layout: s.layout,
        routes: s.routes.map((r) => String(r || '')),
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

/** @param {{layout: string, routes: string[]}} state */
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
  const scaleOptions = WS_SCALES.map(
    ([w, name]) =>
      `<option value="${w}"${w === state.scale ? ' selected' : ''}>${esc(name)}</option>`
  ).join('');
  const layoutOptions = Object.entries(WS_LAYOUTS)
    .map(
      ([k, l]) =>
        `<option value="${k}"${k === state.layout ? ' selected' : ''}>${esc(l.label)}</option>`
    )
    .join('');
  view.innerHTML = `
    <div class="ws">
      <div class="ws-toolbar">
        <span class="ws-title">Workspace</span>
        <label class="ws-layout">Layout
          <select id="ws-layout">${layoutOptions}</select></label>
        <label class="ws-layout">Scale
          <select id="ws-scale" title="The width each pane's app is laid out at, then scaled to fit">${scaleOptions}</select></label>
        <span class="ws-note">One cable, shared: each pane's jobs take their
          turn on it. A flash from a pane holds the cable for all of them until
          it has finished.</span>
      </div>
      <div class="ws-grid" id="ws-grid"></div>
    </div>`;
  const grid = document.getElementById('ws-grid');
  /** @type {HTMLIFrameElement[]} */
  const frames = [];
  /** @type {HTMLElement[]} */
  const boxes = [];

  /** Lay the frame out at the scale width and shrink it to its box. */
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

  const paneHtml = (i) => {
    const picks = WS_APPS.map(
      ([r, name]) =>
        `<option value="${esc(r)}"${r === (state.routes[i] || '') ? ' selected' : ''}>${esc(name)}</option>`
    ).join('');
    return `
      <div class="ws-pane-head">
        <span class="ws-pane-no">${i + 1}</span>
        <select class="ws-pick" data-pane="${i}" title="What this pane shows">${picks}</select>
        <button type="button" class="btn ws-pop" data-pane="${i}"
          title="Open this pane in its own window (it keeps the same cable)">⧉</button>
      </div>
      <div class="ws-popped-note">
        <span>Open in its own window.</span>
        <button type="button" class="btn ws-back">Bring it back here</button>
      </div>
      <div class="ws-frame-box"></div>`;
  };

  function wire(pane, i) {
    pane.querySelector('.ws-pick').onchange = (e) => {
      state.routes[i] = e.target.value;
      wsSave(state);
      // the pane's own router follows its hash: no reload, the pane's
      // bus (the shell's) stays as it is
      try {
        frames[i].contentWindow.location.hash = '#' + state.routes[i];
      } catch {
        frames[i].src = wsPaneUrl(i, state.routes[i]);
      }
    };
    pane.querySelector('.ws-pop').onclick = () => {
      const w = window.open(
        wsPaneUrl(i, state.routes[i] || ''),
        `bmweb-pane-${i + 1}`,
        'width=1100,height=760'
      );
      if (!w) return; // blocked: the pane stays where it is
      frames[i].src = 'about:blank';
      pane.classList.add('ws-popped');
    };
    pane.querySelector('.ws-back').onclick = () => {
      pane.classList.remove('ws-popped');
      frames[i].src = wsPaneUrl(i, state.routes[i] || '');
    };
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
        grid.appendChild(pane);
        wire(pane, i);
      }
      // panes past the layout's count keep their frame (and its screen's
      // state) but are hidden, so switching 2 x 2 -> left/right -> 2 x 2
      // brings the same apps back
      pane.hidden = i >= L.n;
      pane.style.gridArea = i < L.n ? L.areas[i] : '';
    }
    wsSave(state);
    // the boxes have their new sizes once the grid has laid out
    requestAnimationFrame(fitAll);
  }

  document.getElementById('ws-layout').onchange = (e) => {
    state.layout = e.target.value;
    apply();
  };
  document.getElementById('ws-scale').onchange = (e) => {
    state.scale = Number(e.target.value) || 0;
    wsSave(state);
    fitAll();
  };
  apply();
}
