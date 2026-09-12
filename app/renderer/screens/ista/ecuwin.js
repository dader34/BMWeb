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

/* exported istaEcuFnLists istaEcuFnRows istaEcuWindow istaEcuTip istaEcuScreens */

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
  // the tool prints the diagnostic address in hex, which is how it appears
  // on a wiring diagram and in every EDIABAS trace
  const hex = (v) => {
    const n = Number(v);
    return Number.isFinite(n)
      ? `0x${n.toString(16).toUpperCase().padStart(2, '0')}`
      : '';
  };
  const rows = [
    ['Address', hex(box.addr)],
    // Group type is the SLOT's own short name and Name its long one; they
    // are two different facts and concatenating them ("EML (0x22)EML") made
    // one unreadable string out of both
    ['Group type', (box && box.name) || (slot && slot.abbr) || ''],
    ['Name', (slot && slot.name) || ''],
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
 * The window's two lists from the tool's own function data.
 *
 * ISTA does not list the INPA script's screens: per ECU variant its
 * database carries function groups (ECUStateReadStructure under Diagnosis
 * scan, ECUControllingActuatorStructure under Component triggering), each
 * with English-titled leaves that name one EDIABAS job, its arguments and
 * the results to show. tools/ista/ecu_functions_extract.py ships that per
 * variant; this hands the window the groups as the tool draws them.
 * @param {object|null} fn - data/ista/ecufn/<variant>.json, or null
 * @returns {{read: object[], write: object[]}} groups of items
 */
function istaEcuFnLists(fn) {
  const groups = (list) =>
    (Array.isArray(list) ? list : [])
      .filter((g) => g && Array.isArray(g.items) && g.items.length)
      .map((g) => ({
        title: String(g.title || ''),
        items: g.items.map((it) => ({
          title: String(it.title || it.job || ''),
          job: String(it.job || ''),
          args: String(it.args || ''),
          results: Array.isArray(it.results) ? it.results : [],
          ms: it.ms || 0,
        })),
      }));
  return { read: groups(fn && fn.reads), write: groups(fn && fn.acts) };
}

/**
 * The rows the right pane shows after a run: each declared result of the
 * item, found in the job's result sets by name (the VM uppercases result
 * keys), with its unit. An item that declares no results shows every value
 * the first data set carried, so nothing a module answered is hidden.
 * @param {object} item - the list item that ran
 * @param {object[]} sets - the job's result sets
 * @returns {Array<[string, string]>} label/value pairs
 */
function istaEcuFnRows(item, sets) {
  const data = (Array.isArray(sets) ? sets : []).filter(
    (x) => x && typeof x === 'object'
  );
  const find = (name) => {
    const want = String(name || '').toUpperCase();
    for (const set of data)
      for (const k of Object.keys(set))
        if (k.toUpperCase() === want) return set[k];
    return undefined;
  };
  const text = (v) =>
    v === undefined || v === null
      ? '-'
      : Array.isArray(v)
        ? v.map((b) => Number(b).toString(16).padStart(2, '0')).join(' ')
        : String(v);
  const rows = [];
  const declared = (item && item.results) || [];
  if (declared.length) {
    for (const r of declared) {
      const v = find(r.name);
      const unit = r.unit && v !== undefined && v !== null ? ` ${r.unit}` : '';
      rows.push([r.title || r.name, `${text(v)}${unit}`]);
    }
    return rows;
  }
  const first = data[0] || {};
  for (const k of Object.keys(first)) {
    if (/^_|^JOB_STATUS$|^SAETZE$/.test(k)) continue;
    rows.push([k, text(first[k])]);
  }
  const status = find('JOB_STATUS');
  if (status !== undefined) rows.push(['Job status', text(status)]);
  return rows;
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
  // ISTA's lists drill down: the groups first, then a group's items. With
  // the tool's function data the pane shows groups; a script-only module
  // keeps the flat screen list the app can offer.
  const fn = ctx.fn ? istaEcuFnLists(ctx.fn) : null;
  /** @type {object|null} the group opened on the current tab */
  let group = null;
  /** @type {Set<number>} item indexes ticked for Read state */
  let chosen = new Set();
  /** @type {string} the right pane's heading: the opened group */
  let resultHead = '';

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
    let rows;
    if (fn) {
      // groups, or the opened group's items; a ticked item reads on Read
      // state (the scan tab takes several, the trigger tab one)
      rows = group
        ? group.items
            .map(
              (it, i) =>
                `<div class="irbf-row${chosen.has(i) ? ' on' : ''}" ` +
                `data-i="${i}">${esc(it.title)}</div>`
            )
            .join('')
        : list.length
          ? list
              .map(
                (g, i) =>
                  `<div class="irbf-row" data-g="${i}">- ${esc(g.title)}</div>`
              )
              .join('')
          : `<div class="irbf-none">The tool lists no functions of this ` +
            `kind for this control unit.</div>`;
    } else {
      rows = list.length
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
    }
    const out =
      (resultHead
        ? `<div class="irbf-row irbf-sub">- ${esc(resultHead)}</div>`
        : '') +
      (results.length
        ? `<table class="irtable"><tbody>` +
          results
            .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`)
            .join('') +
          `</tbody></table>`
        : '');
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
      // ONE LINE EACH. The frames show these labels hyphenated across two
      // lines only because the real tool's tab is too narrow for them; that
      // is its layout losing an argument with its own text, not a name with
      // a hyphen in it. Ours are wide enough, so they read as words.
      ['trigger', 'Component triggering'],
      ['sw', 'Software information', true],
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
        group = null;
        chosen = new Set();
        resultHead = '';
        paint();
      };
    });

    const split = fn
      ? fn
      : ctx.ir
        ? istaEcuScreens(ctx.ir)
        : { read: [], write: [] };
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
    host.querySelectorAll('[data-g]').forEach((el) => {
      el.onclick = () => {
        group = list[Number(el.dataset.g)];
        chosen = new Set();
        results = [];
        resultHead = group.title;
        paint();
      };
    });
    host.querySelectorAll('[data-i]').forEach((el) => {
      el.onclick = () => {
        const i = Number(el.dataset.i);
        if (tab === 'trigger')
          chosen = chosen.has(i) ? new Set() : new Set([i]);
        else if (chosen.has(i)) chosen.delete(i);
        else chosen.add(i);
        paint();
      };
    });

    // the bottom row, per tab; only Read state and Trigger component reach
    // the car, and neither has been pressed yet
    const act = overlay.querySelector('.irecu-actions');
    const btns = [];
    const undo = () => {
      group = null;
      chosen = new Set();
      results = [];
      resultHead = '';
      paint();
    };
    const ready = fn ? group && chosen.size > 0 : !!picked;
    if (tab === 'scan')
      btns.push(
        ['Undo all', fn && (group || results.length) ? undo : null],
        ['Undo', fn && group ? undo : null],
        [
          'Read state',
          ready ? () => (fn ? fireItems(false) : fire(picked)) : null,
        ]
      );
    else if (tab === 'trigger')
      btns.push([
        'Trigger component',
        ready ? () => (fn ? fireItems(true) : fire(picked)) : null,
      ]);
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

  /**
   * Run the ticked items of the opened group and show their results in
   * the right pane, the way the tool does: one job per distinct job and
   * argument string, each item's declared results picked out by name.
   * @param {boolean} write - Component triggering (the job commands the ECU)
   * @returns {Promise<void>}
   */
  async function fireItems(write) {
    if (typeof ctx.runJob !== 'function' || !group) return;
    const items = [...chosen].sort((a, b) => a - b).map((i) => group.items[i]);
    results = [['Reading...', '']];
    paint();
    const rows = [];
    const done = new Map();
    for (const it of items) {
      const key = `${it.job}\u0000${it.args}`;
      try {
        if (!done.has(key))
          done.set(key, await ctx.runJob(it.job, it.args, write));
        const r = done.get(key);
        if (r === null) {
          rows.push([it.title, 'not sent']);
          continue;
        }
        rows.push(...istaEcuFnRows(it, (r && r.sets) || []));
      } catch (e) {
        rows.push([it.title, (e && e.message) || String(e)]);
      }
    }
    results = rows.length ? rows : [['-', 'the module answered nothing']];
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
    istaEcuFnLists,
    istaEcuFnRows,
    istaEcuWindow,
  };
}
