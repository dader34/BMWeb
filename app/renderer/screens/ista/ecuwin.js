/**
 * @file The control unit window: what opens from "Call up ECU functions",
 * and the hover panel the bus map shows over a box.
 *
 * ONE CONTROL UNIT, FOUR QUESTIONS. The real tool opens a window titled
 * "Engine electronics (DME)" with four tabs: what this unit IS
 * (Identification), what it can tell you (Diagnosis scan), what it can be
 * made to do (Component triggering), and what software it carries (Software
 * information, which needs the programming data this build does not have).
 *
 * NOTHING RUNS WHEN IT OPENS. Identification is drawn from the scan the
 * Garage already holds. The other two tabs LIST what the module offers and
 * touch the car only when the reader presses Read state or Trigger
 * component -- the same rule the rest of the shell follows, and the reason
 * a technician can open this window on a car that is asleep.
 *
 * READ AND WRITE ARE SPLIT BY THE SAME CLASSIFIER the rest of the app uses
 * (isWriteJob, default-deny). Diagnosis scan gets the screens that read;
 * Component triggering gets the ones that drive something. A screen nobody
 * can classify counts as a write and lands under triggering behind its
 * confirm, because the cost of getting that backwards is a component firing
 * when someone expected a number.
 */

/* exported istaEcuWindow istaEcuTip istaEcuScreens */

/**
 * The identification rows, in the order the tool prints them.
 *
 * Each entry is [label, result names in preference order]. The names are
 * real EDIABAS result fields: an E-series module answers with different ones
 * than the F-series the tool was drawn against, so several are tried and the
 * first present wins. A row nothing answered shows "-", which is the honest
 * difference between "this module does not report it" and "we did not ask".
 * @type {Array<[string, string[]]>}
 */
const ISTA_IDENT_ROWS = [
  ['BMW part number', ['BMW_NUMMER', 'AIF_ZB_NR', 'ID_ZB_NR', 'ZB_NR']],
  ['Hardware number', ['HARDWARE_NUMMER', 'ID_HW_NR', 'AIF_HW_NR', 'HW_NR']],
  ['Software number', ['SOFTWARE_NUMMER', 'AIF_SW_NR', 'ID_SW_NR', 'SW_NR']],
  ['Coding index', ['CODIERINDEX', 'AIF_CODIERINDEX', 'ID_CODIERINDEX']],
  [
    'Diagnosis index',
    ['DIAGNOSEINDEX', 'AIF_DIAGNOSEINDEX', 'ID_DIAGNOSEINDEX'],
  ],
  ['Bus index', ['BUSINDEX', 'AIF_BUSINDEX', 'ID_BUSINDEX']],
  ['Supplier', ['LIEFERANT', 'AIF_LIEFERANT', 'ID_LIEFERANT', 'HERSTELLER']],
  ['Build date', ['DATUM', 'AIF_DATUM', 'ID_DATUM', 'BAU_DATUM']],
  ['Serial number', ['SERIENNUMMER', 'AIF_SERIENNUMMER', 'ID_SERIENNUMMER']],
  ['Data number', ['AIF_DATEN_NR', 'ID_DATEN_NR', 'DATEN_NR']],
  ['Variant', ['SG_VARIANTE', 'VARIANTE', 'AIF_SG_VARIANTE', 'ID_SG_VARIANTE']],
];

/**
 * The first present value among preferred result names.
 * @param {object|null} ident - the module's stored identification
 * @param {string[]} keys - result names, best first
 * @returns {string} the value, or ''
 */
function istaIdentValue(ident, keys) {
  if (!ident) return '';
  for (const k of keys) {
    const v = ident[k];
    if (v != null && String(v).trim() && !String(v).startsWith('_'))
      return String(v).trim();
  }
  return '';
}

/**
 * The hover panel the bus map shows over a control unit.
 *
 * Its nine rows are the tool's own, and every one comes from something this
 * build already knows: the tree data places the unit on its bus, the
 * identification read says which variant is in the slot and what its numbers
 * are. A car nobody has read shows the address and the bus and "-" for the
 * rest, which is exactly what is true of it.
 * @param {object} box - the tree's ECU box {name, addr, bus, col, row}
 * @param {object|null} slot - its slot, from istaSlots
 * @returns {string} HTML
 */
function istaEcuTip(box, slot) {
  const id = (slot && slot.ident) || null;
  const dash = (v) => (v ? esc(String(v)) : '-');
  const rows = [
    ['Address', box.addr != null ? String(box.addr) : ''],
    ['Group type', (slot && slot.abbr) || box.name || ''],
    ['Name', (slot && slot.name) || box.name || ''],
    ['Variant', istaIdentValue(id, ISTA_IDENT_ROWS[10][1])],
    ['Part number', istaIdentValue(id, ISTA_IDENT_ROWS[0][1])],
    ['Hardware number', istaIdentValue(id, ISTA_IDENT_ROWS[1][1])],
    ['Serial number', istaIdentValue(id, ISTA_IDENT_ROWS[8][1])],
    ['Data bus', box.bus || ''],
    [
      'Tree coordinates',
      box.col != null && box.row != null ? `${box.col} / ${box.row}` : '',
    ],
  ];
  return (
    `<div class="irtip">` +
    rows
      .map(
        ([k, v]) =>
          `<div class="irtip-row"><span class="irtip-k">${esc(k)}</span>` +
          `<span class="irtip-s">:</span>` +
          `<span class="irtip-v">${dash(v)}</span></div>`
      )
      .join('') +
    `</div>`
  );
}

/**
 * A module's screens, split into the ones that read and the ones that drive.
 *
 * The IR's menus carry every screen the INPA script offers with the caption
 * it shows. Which side a screen falls on is the app's own write classifier
 * over the job it sends, so this page and the rest of the app can never
 * disagree about what counts as a write.
 * @param {object|null} ir - the module's decoded script
 * @returns {{read: object[], write: object[]}} the two lists
 */
function istaEcuScreens(ir) {
  /** @type {object[]} */
  const read = [];
  /** @type {object[]} */
  const write = [];
  const seen = new Set();
  const screens = (ir && ir.screens) || {};

  for (const menu of Object.values((ir && ir.menus) || {}))
    for (const item of menu.items || []) {
      const name = item.screen;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const label = item.label || item.short || name;
      // a screen with no caption is a jump target the script uses to get
      // somewhere, not a function a technician chooses
      if (!item.label && !item.short) continue;
      const scr = screens[name] || {};
      const jobs = [];
      for (const j of scr.jobs || []) jobs.push(j.job || j.name || j);
      const writes = jobs.length
        ? jobs.some((j) => typeof isWriteJob === 'function' && isWriteJob(j))
        : // no job means the screen only draws; it cannot touch the car
          false;
      (writes ? write : read).push({ name, label, jobs, writes });
    }
  return { read, write };
}

/**
 * The control unit window.
 * @param {object} ctx - what to draw
 * @param {object} ctx.slot - the slot, from istaSlots
 * @param {object|null} ctx.box - its tree box, when opened from the map
 * @param {object|null} ctx.ir - the module's decoded script
 * @param {(screen: object) => Promise<object[]>} ctx.run - run one screen and
 *   give back its result rows as [label, value] pairs
 * @returns {void}
 */
function istaEcuWindow(ctx) {
  if (typeof openModal !== 'function') return;
  const slot = ctx.slot || {};
  const abbr = slot.abbr || '';
  const title = `${slot.name || abbr} (${abbr})`;
  let tab = 'ident';
  let picked = null;
  /** @type {Array<[string, string]>} rows the last run produced */
  let results = [];

  const html =
    `<div class="modal irecu" role="dialog" aria-modal="true">` +
    `<div class="modal-title irecu-title">${esc(title)}` +
    `<button type="button" class="irecu-x" aria-label="Close">` +
    `${typeof istaRealIcon === 'function' ? istaRealIcon('close') : ''}` +
    `</button></div>` +
    `<div class="iradmin-tabs irecu-tabs"></div>` +
    `<div class="irecu-host"></div>` +
    `<div class="modal-actions irecu-actions"></div>` +
    `</div>`;
  const { overlay, close } = openModal(html);

  /** The Identification tab: what the scan already knows. */
  function identHtml() {
    const id = slot.ident || null;
    const state =
      slot.state === 'silent'
        ? 'ECU not responding'
        : slot.state === 'unread'
          ? 'ECU not read'
          : 'ECU responding properly';
    const head = [
      ['ECU name:', `${abbr} - ${slot.name || ''}`],
      ['Data bus:', (ctx.box && ctx.box.bus) || '-'],
      ['ECU state:', state],
    ];
    const info = ISTA_IDENT_ROWS.map(([label, keys]) => [
      label,
      istaIdentValue(id, keys),
    ]).filter(([, v]) => v || id);
    return (
      `<div class="irecu-ident">` +
      head
        .map(
          ([k, v]) =>
            `<div class="irecu-h"><span class="irecu-hk">${esc(k)}</span>` +
            `<span class="irecu-hv">${esc(v)}</span></div>`
        )
        .join('') +
      `<div class="irecu-h"><span class="irecu-hk">ECU information:</span>` +
      `</div>` +
      (id
        ? `<table class="irtable irecu-info"><tbody>` +
          info
            .map(
              ([k, v]) =>
                `<tr><td>${esc(k)}</td><td>${v ? esc(v) : '-'}</td></tr>`
            )
            .join('') +
          `</tbody></table>`
        : `<div class="irgrey-w">This control unit has not been ` +
          `identified yet. Run Start vehicle test, or the Ident key on the ` +
          `Control unit list, to fill this in.</div>`)
    );
  }

  /** The two-pane tabs: a list of screens, and what the last one returned. */
  function paneHtml(list, headLeft) {
    const rows = list.length
      ? list
          .map(
            (s, i) =>
              `<div class="irbf-row${
                picked && picked.name === s.name ? ' on' : ''
              }" data-s="${i}">- ${esc(s.label)}</div>`
          )
          .join('')
      : `<div class="irbf-none">This module's script offers nothing of ` +
        `this kind.</div>`;
    const out = results.length
      ? `<table class="irtable"><tbody>` +
        results
          .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`)
          .join('') +
        `</tbody></table>`
      : '';
    return (
      `<div class="irecu-split">` +
      `<div class="irbf-pane"><div class="irbf-head">${esc(headLeft)}</div>` +
      `<div class="irbf-list">${rows}</div></div>` +
      `<div class="irbf-pane"><div class="irbf-head">Function and state ` +
      `information</div><div class="irbf-list">${out}</div></div></div>`
    );
  }

  /** Redraw the strip, the body and the buttons. */
  function paint() {
    const tabs = [
      ['ident', 'Identification'],
      ['scan', 'Diagnosis scan'],
      ['trigger', 'Component trig-\ngering'],
      ['sw', 'Software infor-\nmation', true],
    ];
    overlay.querySelector('.irecu-tabs').innerHTML = tabs
      .map(
        ([id, label, off]) =>
          `<button type="button" class="iradmin-tab${
            id === tab ? ' on' : ''
          }${off ? ' off' : ''}" data-t="${id}"${off ? ' disabled' : ''}>` +
          `${esc(label)}</button>`
      )
      .join('');
    overlay.querySelectorAll('.irecu-tabs [data-t]').forEach((b) => {
      b.onclick = () => {
        tab = b.dataset.t;
        picked = null;
        results = [];
        paint();
      };
    });

    const split = ctx.ir ? istaEcuScreens(ctx.ir) : { read: [], write: [] };
    const list = tab === 'scan' ? split.read : split.write;
    const host = overlay.querySelector('.irecu-host');
    host.innerHTML =
      tab === 'ident'
        ? identHtml()
        : tab === 'sw'
          ? `<div class="irgrey-w">Software information needs BMW's ` +
            `programming data, which this build does not carry.</div>`
          : paneHtml(list, tab === 'scan' ? 'ECU function' : 'Component');
    host.querySelectorAll('[data-s]').forEach((el) => {
      el.onclick = () => {
        picked = list[Number(el.dataset.s)];
        paint();
      };
    });

    // the bottom row, per tab; only Read state and Trigger component reach
    // the car, and neither has been pressed yet
    const act = overlay.querySelector('.irecu-actions');
    const btns = [];
    if (tab === 'scan')
      btns.push(
        ['Undo all', null],
        ['Undo', null],
        ['Read state', picked ? () => fire(picked) : null]
      );
    else if (tab === 'trigger')
      btns.push(['Trigger component', picked ? () => fire(picked) : null]);
    btns.push(['Close', () => close()]);
    act.innerHTML = btns
      .map(
        ([label, fn], i) =>
          `<button type="button" class="btn irbtn" data-b="${i}"` +
          `${fn ? '' : ' disabled'}>${esc(label)}</button>`
      )
      .join('');
    act.querySelectorAll('[data-b]').forEach((b) => {
      const fn = btns[Number(b.dataset.b)][1];
      if (fn) b.onclick = () => fn();
    });
  }

  /**
   * Run the picked screen on the car and show what it answered.
   * @param {object} screen - the picked screen
   * @returns {Promise<void>}
   */
  async function fire(screen) {
    if (typeof ctx.run !== 'function') return;
    results = [['Reading...', '']];
    paint();
    let rows = [];
    try {
      rows = (await ctx.run(screen)) || [];
    } catch (e) {
      rows = [['Error', (e && e.message) || String(e)]];
    }
    results = rows;
    paint();
  }

  const x = overlay.querySelector('.irecu-x');
  if (x) x.onclick = () => close();
  paint();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ISTA_IDENT_ROWS,
    istaIdentValue,
    istaEcuTip,
    istaEcuScreens,
    istaEcuWindow,
  };
}
