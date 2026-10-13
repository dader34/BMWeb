/**
 * @file Tuning screen: live values in floating windows. While live mode is
 * armed, a dial for engine speed and a list of the engine's other figures
 * can each be opened as a small window of its own (the Gauge and Values
 * ticks in the live toolbar), moved and sized freely, whether or not a table
 * is open.
 *
 * With a table open they cost nothing extra on the wire: they ride in the
 * packet the live cursor already reads (live-cursor.js). With none open they
 * read the same packet themselves, one request a refresh.
 *
 * The addresses are RAM variables of program 0044570LO02S, the scaling and
 * units are the tuning definition's own for the axes those variables feed
 * (checked against it in ms45-emu); the names are ours, read off the table
 * names that use them.
 */
/* exported TN_GAUGES, tnGaugesInit, tnGaugesPieces, tnGaugesUpdate, tnGaugesSync, tnGaugesToolbarHtml */

/**
 * @typedef {Object} LiveGauge
 * @property {string} label
 * @property {number} address - RAM.
 * @property {1|2} size
 * @property {boolean} [signed] - The raw value is two's complement.
 * @property {number} a - value = a * raw + b
 * @property {number} b
 * @property {string} units
 * @property {number} dp - Decimal places shown.
 */

/**
 * The values shown, by the DME's own identifier for each: where it lives
 * and how its bytes scale come from the program's value table and the
 * SGBD's (core/ms45-value-map.js), so the figure here is the one a BMW
 * tester shows under that name. [identifier, label, units, decimals].
 * Engine speed is first: the dial is drawn from it.
 * @type {Array<[number, string, string, number]>}
 */
const TN_GAUGE_VALUES = [
  [0x410c, 'Engine speed', 'rpm', 0],
  [0x4119, 'Idle speed target', 'rpm', 0],
  [0x4113, 'Engine load', '%', 1],
  [0x4118, 'Air per stroke', 'mg/stk', 1],
  [0x4112, 'Air mass', 'kg/h', 1],
  [0x4114, 'Accelerator pedal', '%', 1],
  [0x4158, 'Throttle position', '°', 1],
  [0x410d, 'Vehicle speed', 'km/h', 0],
  [0x411f, 'Coolant', '°C', 0],
  [0x4120, 'Radiator outlet', '°C', 0],
  [0x4122, 'Oil', '°C', 0],
  [0x411e, 'Intake air', '°C', 0],
  [0x4133, 'Manifold pressure', 'hPa', 0],
  [0x4134, 'Ambient pressure', 'hPa', 0],
  [0x4115, 'Injection time', 'ms', 2],
  [0x4125, 'Ignition timing', '°', 1],
  [0x4116, 'Lambda control, bank 1', '%', 1],
  [0x4117, 'Lambda control, bank 2', '%', 1],
  [0x411a, 'Intake camshaft', '°', 1],
  [0x411c, 'Exhaust camshaft', '°', 1],
  [0x413c, 'Battery voltage', 'V', 1],
  [0x417f, 'Electric fan duty', '%', 0],
];

/**
 * Values the DME works out in a routine instead of keeping in one variable,
 * so its table gives no address for them: these were traced by hand.
 * @type {LiveGauge[]}
 */
const TN_GAUGES_TRACED = [
  {
    label: 'Lambda setpoint',
    address: 0x3fcb9c,
    size: 2,
    a: 0.000977,
    b: 0,
    units: 'λ',
    dp: 3,
  },
  // The DME's own misfire counters, one word a cylinder. They are what its
  // identifiers 41A3/41FD/41A9/41FE/41A4/41AA ("Anzahl Aussetzer Zylinder n")
  // read -- the addresses were found by watching which word each identifier
  // fetches -- and the 1/64 is the SGBD's own scaling for that word.
  ...[0x3fcbcc, 0x3fcbd4, 0x3fcbd0, 0x3fcbd6, 0x3fcbce, 0x3fcbd2].map(
    (address, n) => ({
      label: `Misfires cyl ${n + 1}`,
      address,
      size: /** @type {2} */ (2),
      a: 1 / 64,
      b: 0,
      units: '',
      dp: 0,
    })
  ),
];

/** @type {LiveGauge[]} */
const TN_GAUGES = [
  ...TN_GAUGE_VALUES.flatMap(([id, label, units, dp]) => {
    const v =
      typeof MS45_VALUE_MAP !== 'undefined' ? MS45_VALUE_MAP.values[id] : null;
    if (!v) return []; // not a plain variable on this build: not shown
    return [
      {
        label,
        address: v[0],
        size: /** @type {1|2} */ (v[1]),
        signed: !!v[2],
        a: v[3],
        b: v[4],
        units,
        dp,
      },
    ];
  }),
  ...TN_GAUGES_TRACED,
];
/** The dial: engine speed, to this. */
const TN_GAUGE_DIAL_MAX = 7000;
/** ...red from here. */
const TN_GAUGE_DIAL_RED = 6500;

/** Rest between refreshes when the gauges are reading for themselves. */
const TN_GAUGES_REST_MS = 250;
/** Where each window's place, size and whether it is open are kept. */
const TN_GAUGES_KEY = 'bmweb.tuning.gauges';

/** The two windows and the loop that feeds them when no table is open. */
const tnGauges = {
  dial: null, // {win, canvas}
  list: null, // {win, cells}
  faults: null, // {win}: the fault memory window (live-faults.js)
  open: { dial: false, list: false, faults: false },
  place: {},
  rpm: null,
  plan: null, // the packet read when the gauges read for themselves
  timer: null,
};

/**
 * The "UI apps" list for the live toolbar: one tick per floating window.
 * @returns {string}
 */
function tnGaugesToolbarHtml() {
  return (
    '<div class="tn-live-apps" id="tn-live-apps" hidden>' +
    '<button type="button" class="btn tn-live-apps-btn" id="tn-live-apps-btn" aria-haspopup="true" aria-expanded="false" title="Floating windows: the gauge, the live values, the fault memory">UI apps ▾</button>' +
    '<div class="tn-live-apps-menu" id="tn-live-apps-menu" hidden>' +
    '<label class="tn-tool-check" title="Engine speed on a dial, in a window of its own"><input type="checkbox" id="tn-live-gauge-box"> Gauge</label>' +
    '<label class="tn-tool-check" title="The engine\'s live values, in a window of their own"><input type="checkbox" id="tn-live-values-box"> Values</label>' +
    '<label class="tn-tool-check" title="The DME\'s fault memory: read, live scan, save, clear"><input type="checkbox" id="tn-live-faults-box"> Faults</label>' +
    '</div></div>'
  );
}

/**
 * The pieces of memory the open windows need, for the packet: none when
 * neither is open.
 * @returns {Array<{address:number, size:number}>}
 */
function tnGaugesPieces() {
  if (tnGauges.open.list)
    return TN_GAUGES.map((g) => ({ address: g.address, size: g.size }));
  if (tnGauges.open.dial)
    return [{ address: TN_GAUGES[0].address, size: TN_GAUGES[0].size }];
  return [];
}

/**
 * A small floating window: moved by its title bar, sized by its corner,
 * closed by its x; where it was left is remembered.
 * @param {'dial'|'list'|'faults'} which
 * @param {string} title
 * @param {string} bodyHtml
 * @param {{left:number, top:number, width:number, height:number}} first - Where it opens the first time.
 * @returns {HTMLElement} The window (hidden).
 */
function tnGaugeWindow(which, title, bodyHtml, first) {
  const win = document.createElement('div');
  win.className = `tn-surface-win tn-gauge-win tn-gauge-win-${which}`;
  win.hidden = true;
  win.innerHTML =
    `<div class="tn-surface-head"><span>${esc(title)}</span>` +
    '<button type="button" class="tn-surface-x" aria-label="Close">×</button></div>' +
    `<div class="tn-gauge-body">${bodyHtml}</div>`;
  document.body.appendChild(win);
  const p = tnGauges.place[which] || first;
  win.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, p.left))}px`;
  win.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, p.top))}px`;
  win.style.width = `${p.width}px`;
  win.style.height = `${p.height}px`;
  let drag = null;
  win.querySelector('.tn-surface-head').onmousedown = (e) => {
    if (e.button !== 0 || e.target.closest('.tn-surface-x')) return;
    e.preventDefault();
    drag = {
      x: e.clientX,
      y: e.clientY,
      left: win.offsetLeft,
      top: win.offsetTop,
    };
  };
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    win.style.left = `${Math.max(40 - win.offsetWidth, Math.min(window.innerWidth - 40, drag.left + e.clientX - drag.x))}px`;
    win.style.top = `${Math.max(0, Math.min(window.innerHeight - 28, drag.top + e.clientY - drag.y))}px`;
  });
  window.addEventListener('mouseup', () => {
    drag = null;
    if (!win.hidden) {
      tnGauges.place[which] = {
        left: win.offsetLeft,
        top: win.offsetTop,
        width: win.offsetWidth,
        height: win.offsetHeight,
      };
      tnGaugesRemember();
    }
  });
  win.querySelector('.tn-surface-x').onclick = () => tnGaugesSet(which, false);
  return win;
}

/** Keep which windows are open, and where, for the next visit. */
function tnGaugesRemember() {
  try {
    localStorage.setItem(
      TN_GAUGES_KEY,
      JSON.stringify({ open: tnGauges.open, place: tnGauges.place })
    );
  } catch (e) {
    /* not remembered */
  }
}

/**
 * Build the two windows and wire the toolbar ticks. Once per screen.
 * @returns {void}
 */
function tnGaugesInit() {
  try {
    const saved = JSON.parse(localStorage.getItem(TN_GAUGES_KEY) || 'null');
    if (saved) {
      tnGauges.open = {
        dial: !!(saved.open && saved.open.dial),
        list: !!(saved.open && saved.open.list),
        faults: !!(saved.open && saved.open.faults),
      };
      tnGauges.place = saved.place || {};
    }
  } catch (e) {
    /* start closed */
  }
  for (const old of document.querySelectorAll('.tn-gauge-win')) old.remove(); // a screen rebuilt
  const right = window.innerWidth - 24;
  const dialWin = tnGaugeWindow(
    'dial',
    'Engine speed',
    '<canvas class="tn-gauge-dial"></canvas>',
    {
      left: right - 260,
      top: 96,
      width: 260,
      height: 290,
    }
  );
  tnGauges.dial = { win: dialWin, canvas: dialWin.querySelector('canvas') };
  const listWin = tnGaugeWindow(
    'list',
    'Live values',
    '<div class="tn-gauge-list">' +
      TN_GAUGES.map(
        (g, i) =>
          `<div class="tn-gauge-row"><span class="tn-gauge-name">${esc(g.label)}</span>` +
          `<b class="tn-gauge-value" data-i="${i}">–</b><span class="tn-gauge-unit">${esc(g.units)}</span></div>`
      ).join('') +
      '</div>',
    { left: right - 260, top: 320, width: 260, height: 560 }
  );
  tnGauges.list = {
    win: listWin,
    cells: [...listWin.querySelectorAll('.tn-gauge-value')],
  };
  if (typeof ResizeObserver === 'function')
    new ResizeObserver(() => {
      if (tnGauges.rpm != null && !dialWin.hidden)
        tnGaugeDial(tnGauges.dial.canvas, tnGauges.rpm);
    }).observe(dialWin);
  if (typeof tnFaultsBuild === 'function')
    tnGauges.faults = { win: tnFaultsBuild(tnGaugeWindow) };
  const dialBox = document.getElementById('tn-live-gauge-box');
  const listBox = document.getElementById('tn-live-values-box');
  const faultsBox = document.getElementById('tn-live-faults-box');
  if (dialBox) dialBox.onchange = () => tnGaugesSet('dial', dialBox.checked);
  if (listBox) listBox.onchange = () => tnGaugesSet('list', listBox.checked);
  if (faultsBox)
    faultsBox.onchange = () => tnGaugesSet('faults', faultsBox.checked);
  // the list opens under its button and closes on a press anywhere else
  const apps = document.getElementById('tn-live-apps');
  const appsBtn = document.getElementById('tn-live-apps-btn');
  const menu = document.getElementById('tn-live-apps-menu');
  if (apps && appsBtn && menu) {
    const show = (on) => {
      menu.hidden = !on;
      appsBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
    };
    appsBtn.onclick = () => show(menu.hidden);
    document.addEventListener('mousedown', (e) => {
      if (!menu.hidden && !apps.contains(e.target)) show(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !menu.hidden) show(false);
    });
  }
  tnGaugesSync();
}

/**
 * Open or close one of the windows (a tick, or its x).
 * @param {'dial'|'list'} which
 * @param {boolean} on
 * @returns {void}
 */
function tnGaugesSet(which, on) {
  tnGauges.open[which] = on;
  tnGaugesRemember();
  if (which !== 'faults') {
    tnGauges.plan = null; // the packet's pieces have changed
    if (typeof tnLiveCursorReplan === 'function') tnLiveCursorReplan();
  }
  tnGaugesSync();
}

/**
 * Bring the ticks and the windows in line with live mode: the ticks show
 * while it is armed, a window shows when its tick is on, and the gauges read
 * for themselves while no table is doing it for them. Called from the live
 * toolbar's repaint.
 * @returns {void}
 */
function tnGaugesSync() {
  if (!tnGauges.dial) return;
  const armed = typeof tnLive !== 'undefined' && tnLive.armed;
  const apps = document.getElementById('tn-live-apps');
  if (apps) {
    apps.hidden = !armed;
    if (!armed) {
      const menu = document.getElementById('tn-live-apps-menu');
      if (menu) menu.hidden = true;
    }
  }
  let openCount = 0;
  for (const [id, which] of [
    ['tn-live-gauge-box', 'dial'],
    ['tn-live-values-box', 'list'],
    ['tn-live-faults-box', 'faults'],
  ]) {
    const box = document.getElementById(id);
    if (box) box.checked = tnGauges.open[which];
    if (tnGauges.open[which]) openCount++;
  }
  const appsBtn = document.getElementById('tn-live-apps-btn');
  if (appsBtn)
    appsBtn.textContent = openCount ? `UI apps (${openCount}) ▾` : 'UI apps ▾';
  tnGauges.dial.win.hidden = !(armed && tnGauges.open.dial);
  tnGauges.list.win.hidden = !(armed && tnGauges.open.list);
  if (tnGauges.faults) {
    const show = armed && tnGauges.open.faults;
    if (tnGauges.faults.win.hidden === show) {
      tnGauges.faults.win.hidden = !show;
      if (typeof tnFaultsOpened === 'function') tnFaultsOpened(show);
    }
  }
  if (armed && (tnGauges.open.dial || tnGauges.open.list) && !tnGauges.timer)
    tnGauges.timer = setTimeout(tnGaugesTick, 0);
}

/**
 * The gauges' own turn on the wire: only while no table is open (an open
 * table's cursor carries their variables in its packet), and never ahead of
 * an edit.
 * @returns {Promise<void>}
 */
async function tnGaugesTick() {
  tnGauges.timer = null;
  const lt = tnLive.armed ? tnLive.lt : null;
  if (!lt || !(tnGauges.open.dial || tnGauges.open.list)) return; // tnGaugesSync starts it again
  let wait = TN_GAUGES_REST_MS;
  try {
    const table = typeof tnCursor !== 'undefined' && tnCursor.m;
    if (table || document.hidden || tnLive.link === 'lost' || tnPacketLent())
      wait = 1000;
    else if (tnLive.busy || tnLive.pumping || tnLive.pending.size) wait = 150;
    else if (!(await tnLiveCursorKnows(lt)))
      wait = 5000; // another program: the addresses mean nothing
    else {
      if (!tnGauges.plan) {
        const wanted = tnGaugesPieces();
        tnGauges.plan = {
          pieces: [
            { address: LT_CURSOR_CANARY.address, size: LT_CURSOR_CANARY.size },
            ...wanted,
          ],
          reads: ltCursorReads(wanted),
          packet: undefined,
        };
      }
      tnGaugesUpdate(await tnLiveCursorFetch(tnGauges.plan, lt));
    }
  } catch (e) {
    wait = 1500; // the link check is what decides the DME is gone
  }
  if (tnLive.armed && tnLive.lt === lt && !tnGauges.timer)
    tnGauges.timer = setTimeout(tnGaugesTick, wait);
}

/**
 * Put a fresh set of values on the gauges.
 * @param {Array<{address:number, bytes:Uint8Array}>} blocks - What the packet
 *   (or the reads by address) returned.
 * @returns {void}
 */
function tnGaugesUpdate(blocks) {
  if (!tnGauges.dial) return;
  TN_GAUGES.forEach((g, i) => {
    const raw = ltCursorValue(
      { address: g.address, size: g.size, signed: !!g.signed },
      blocks
    );
    if (tnGauges.open.list) {
      const text = raw == null ? '–' : fmtNum(g.a * raw + g.b, g.dp);
      if (tnGauges.list.cells[i].textContent !== text)
        tnGauges.list.cells[i].textContent = text;
    }
    const rpm = i === 0 && raw != null ? g.a * raw + g.b : null;
    if (rpm != null && rpm !== tnGauges.rpm) {
      tnGauges.rpm = rpm;
      if (tnGauges.open.dial) {
        tnGaugeDial(tnGauges.dial.canvas, rpm);
        // the exact figure goes in the title bar: on the face it sat among
        // the scale's own numbers and read as a second 0
        const title =
          tnGauges.dial.win.querySelector &&
          tnGauges.dial.win.querySelector('.tn-surface-head span');
        if (title) title.textContent = `Engine speed · ${Math.round(rpm)} rpm`;
      }
    }
  });
}

/**
 * Draw the engine speed dial, in the manner of the car's own rev counter: a
 * round dark face, amber ticks and slanted figures 0 to 7, a red band at the
 * top of the range, an amber needle on a dark hub. No digital figure on the
 * face; the window's title carries it.
 * @param {HTMLCanvasElement} canvas
 * @param {number} rpm
 * @returns {void}
 */
function tnGaugeDial(canvas, rpm) {
  // round, and as big as its window allows
  const box = canvas.parentElement;
  const w = Math.max(
    120,
    Math.min(box ? box.clientWidth : 220, box ? box.clientHeight : 220)
  );
  const dpr = window.devicePixelRatio || 1;
  if (
    canvas.width !== Math.round(w * dpr) ||
    canvas.height !== Math.round(w * dpr)
  ) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(w * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${w}px`;
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, w);
  const cx = w / 2;
  const cy = w / 2;
  const R = w / 2 - 2;
  const AMBER = '#ff7a52';
  const RED = '#e3261c';
  // 0 at the lower left, clockwise over the top to 7 at the lower right
  const A0 = (135 * Math.PI) / 180;
  const SWEEP = (262 * Math.PI) / 180;
  const at = (v) =>
    A0 +
    (Math.max(0, Math.min(TN_GAUGE_DIAL_MAX, v)) / TN_GAUGE_DIAL_MAX) * SWEEP;
  const polar = (a, r) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r];

  // the bezel and the face
  g.beginPath();
  g.arc(cx, cy, R, 0, Math.PI * 2);
  g.fillStyle = '#050607';
  g.fill();
  const face = g.createRadialGradient(cx, cy * 0.8, R * 0.1, cx, cy, R);
  face.addColorStop(0, '#26292d');
  face.addColorStop(1, '#101214');
  g.beginPath();
  g.arc(cx, cy, R * 0.955, 0, Math.PI * 2);
  g.fillStyle = face;
  g.fill();

  // the red band, as blocks, from the red line to the end of the scale
  const outer = R * 0.9;
  g.lineCap = 'butt';
  for (let v = TN_GAUGE_DIAL_RED; v < TN_GAUGE_DIAL_MAX; v += 125) {
    g.beginPath();
    g.arc(cx, cy, outer - R * 0.055, at(v) + 0.006, at(v + 125) - 0.006);
    g.strokeStyle = RED;
    g.lineWidth = R * 0.11;
    g.stroke();
  }

  // ticks: a heavy one at each thousand, a light one at each half
  for (let v = 0; v <= TN_GAUGE_DIAL_MAX; v += 500) {
    const major = v % 1000 === 0;
    const a = at(v);
    const [x0, y0] = polar(a, outer);
    const [x1, y1] = polar(a, outer - R * (major ? 0.14 : 0.1));
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.strokeStyle = v > TN_GAUGE_DIAL_RED ? RED : AMBER;
    g.lineWidth = Math.max(1.2, R * (major ? 0.034 : 0.014));
    g.stroke();
  }

  // the figures, slanted like the cluster's
  g.fillStyle = AMBER;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `italic 600 ${Math.round(R * 0.2)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  for (let k = 0; k <= TN_GAUGE_DIAL_MAX / 1000; k++) {
    const [x, y] = polar(at(k * 1000), outer - R * 0.29);
    g.fillText(String(k), x, y);
  }
  g.font = `italic ${Math.round(R * 0.085)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  g.fillText('1/min', cx + R * 0.2, cy - R * 0.42);
  g.fillText('x1000', cx + R * 0.2, cy - R * 0.32);

  // the needle: a tapered amber blade over a dark hub
  const a = at(rpm);
  const tip = polar(a, outer - R * 0.04);
  const tail = polar(a + Math.PI, R * 0.12);
  const half = R * 0.028;
  const nx = Math.cos(a + Math.PI / 2) * half;
  const ny = Math.sin(a + Math.PI / 2) * half;
  g.beginPath();
  g.moveTo(tail[0] + nx, tail[1] + ny);
  g.lineTo(tip[0] + nx * 0.25, tip[1] + ny * 0.25);
  g.lineTo(tip[0] - nx * 0.25, tip[1] - ny * 0.25);
  g.lineTo(tail[0] - nx, tail[1] - ny);
  g.closePath();
  g.shadowColor = 'rgba(0, 0, 0, 0.6)';
  g.shadowBlur = R * 0.04;
  g.fillStyle = AMBER;
  g.fill();
  g.shadowBlur = 0;
  const hub = g.createRadialGradient(
    cx - R * 0.03,
    cy - R * 0.03,
    R * 0.01,
    cx,
    cy,
    R * 0.13
  );
  hub.addColorStop(0, '#5a5f66');
  hub.addColorStop(1, '#2b2e33');
  g.beginPath();
  g.arc(cx, cy, R * 0.13, 0, Math.PI * 2);
  g.fillStyle = hub;
  g.fill();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TN_GAUGES };
}
