// The IR interpreter: draw an ECU's screens from data/inpa-ir/<ECU>.json
// instead of from hand-written or per-section layout code.
//
// tools/ipo_ir.py emits the whole INPA UI per ECU -- menus with INPA's own
// ITEM numbers, screens as ordered LINEs of positioned elements (text / value
// / gauge / lamp) with the row and column INPA itself draws them at, and the
// jobs each screen runs. This walks that structure.
//
// Nothing here knows anything about any particular ECU. The only per-ECU
// knowledge in the app after this is translation, which is applied at render
// time because each .IPO's strings are frozen in whatever language BMW
// compiled it with (`language` in the IR says which).
//
// Values still come from the existing live poller: an IR screen converts to
// the {job, rows, grid} shape showInpaScreens already consumes, so paging,
// gauge cells, lamp glyphs and the demo mode all work unchanged. The IR's
// contribution is WHICH rows, in WHAT order, with WHICH captions and ranges.

// screens whose elements are all static text have nothing to poll
function irReadable(scr) {
  return (scr.lines || []).some(ln =>
    (ln.elements || []).some(e => e.key && e.t !== 'text'));
}

// A screen's rows, in INPA's own drawing order.
//
// Captions: INPA prints a label as its own `text` element beside the value,
// so a row's caption is the nearest preceding text on the same line -- and
// when a LINE names several keys ("Wheel speed FL, Wheel speed FR" over
// "STAT_..._VL_WERT;STAT_..._VR_WERT"), the caption splits positionally.
function irRows(scr) {
  const rows = [];
  const cells = [];
  for (const ln of scr.lines || []) {
    const els = ln.elements || [];
    const caps = String(ln.caption || '').split(',').map(s => s.trim());
    const valued = els.filter(e => e.key && e.t !== 'text');
    // one caption for several unrelated keys is a LOOP screen: INPA draws the
    // heading once at a computed position and reuses it (RDC prints
    // "Position FL..RR" round a wheel loop). Applying it to every key labels
    // three different readouts identically, so take no label instead.
    const capForAll = caps.length === 1 && caps[0] && valued.length === 1;
    let pending = null;
    let unitAhead = null;
    let nth = 0;
    for (const e of els) {
      if (e.t === 'text') {
        const s = String(e.s || '').trim();
        // "[rpm]" printed above a gauge is its UNIT, not its caption
        const m = /^\[(.+)\]$/.exec(s);
        if (m) unitAhead = m[1].trim();
        else if (s) pending = s;
        continue;
      }
      if (!e.key) continue;
      // positional caption from the LINE header when it lists one per key
      let label = pending;
      if (!label && caps.length > 1 && valued.length === caps.length)
        label = caps[nth];
      if (!label && capForAll) label = caps[0];
      const row = {
        key: e.key,
        label: label || null,
        unit: e.unit || unitAhead || null,
        kind: e.t,
      };
      if (typeof e.min === 'number' && typeof e.max === 'number'
          && e.max > e.min) { row.min = e.min; row.max = e.max; }
      if (e.on) row.on = e.on;
      if (e.off) row.off = e.off;
      rows.push(row);
      if (typeof e.row === 'number')
        cells.push({ key: e.key, row: e.row, col: e.col || 0 });
      pending = null;
      unitAhead = null;
      nth++;
    }
  }
  return { rows, cells };
}

// One IR screen -> the screen objects showInpaScreens polls. A screen with
// several read jobs becomes one entry per job: the poller reads them all each
// tick and keeps whichever keys each answers.
function irScreens(scr) {
  const { rows, cells } = irRows(scr);
  if (!rows.length) return [];
  // write-shaped jobs are represented in the IR but never auto-run
  const jobs = (scr.jobs || []).filter(j => !j.write).map(j => j.name);
  if (!jobs.length) return [];
  return jobs.map(job => ({
    job,
    group: scr.title || null,
    rows,
    grid: cells.length ? { cells } : null,
  }));
}

// Translate a caption the way the rest of the app does. German-built .IPOs
// reach us German; English-built ones pass through unchanged.
function irLabel(s) {
  if (!s) return s;
  return (typeof deGerman === 'function' && deGerman(s)) || s;
}

// INPA's own state words, so a lamp reads ON/OFF in English mode
function irState(s) {
  if (s == null) return s;
  const t = String(s).trim();
  if (/^EIN$/i.test(t)) return 'ON';
  if (/^AUS$/i.test(t)) return 'OFF';
  if (/^JA$/i.test(t)) return 'YES';
  if (/^NEIN$/i.test(t)) return 'NO';
  return irLabel(t);
}

// captions INPA recomputes each pass of a loop, so whichever one the decode
// captured belongs to no single row: a bare index "(1)", a wheel position
// heading, or its own placeholder "??"
const IR_LOOP_CAPTION = /^(\(\d+\)|\?+|Index \d+|Rad \d+|Position (FL|FR|RL|RR|VL|VR|HL|HR))$/i;

function irRowsTranslated(scr, descs) {
  return irScreens(scr).map(s => ({
    ...s,
    group: irLabel(s.group),
    rows: s.rows.map(r => ({
      ...r,
      // INPA's own caption first; for rows it draws without one -- loop
      // screens print a heading once at a computed position -- the SGBD's
      // result description, and only then the bare key.
      // A caption INPA itself computes per iteration ("Position RR", "(1)",
      // "??") is left over from the last pass of a loop and describes no
      // particular row, so the SGBD description wins over it.
      label: irLabel(
        (IR_LOOP_CAPTION.test(r.label || '') ? null : r.label)
        || (descs && descs.get(r.key)) || r.label || r.key),
      unit: r.unit ? irLabel(r.unit) : r.unit,
      on: irState(r.on),
      off: irState(r.off),
    })),
  }));
}

// result-name -> description, straight from the SGBD (offline, no cable).
// Cached per ECU: the same job serves several screens.
const _irDescCache = new Map();
async function irDescs(ecu, scr) {
  const jobs = (scr.jobs || []).filter(j => !j.write).map(j => j.name);
  const out = new Map();
  for (const job of jobs) {
    const ck = `${ecu.sgbd}:${job}`;
    if (!_irDescCache.has(ck)) {
      let m = new Map();
      try {
        const d = await api(`/api/ecu/${ecu.sgbd}/results/${job}`);
        for (const line of Array.isArray(d) ? d : []) {
          const i = String(line).indexOf(':');
          if (i > 0) {
            m.set(String(line).slice(0, i).trim(),
                  String(line).slice(i + 1).trim());
          }
        }
      } catch { m = new Map(); }
      _irDescCache.set(ck, m);
    }
    for (const [k, v] of _irDescCache.get(ck)) if (!out.has(k)) out.set(k, v);
  }
  return out;
}

// A menu's entries, in INPA's order, keeping ITEM numbers as the F-keys.
// Chrome INPA implements itself (print/select/exit) is dropped: the app has
// those natively, and Back is the Esc key.
const IR_CHROME = /^(Back|Exit|Print|Zur(ü|ue)ck|Ende|End|Select|Deselect|Auswahl|Abwahl|Druck|Drucken|Gesamt)$/i;

function irMenuItems(ir, menuName) {
  const menu = (ir.menus || {})[menuName];
  if (!menu) return [];
  const seen = new Set();
  return (menu.items || [])
    .filter(it => it.label && !IR_CHROME.test(it.label.trim()))
    // an item with no navigation target is an ACTION INPA performs in place:
    // its actuator items only flip state flags and let the screen send the
    // job. Those are listed (the caption is INPA's own, joined from the
    // screen's softkey help by F-number) but never runnable here -- firing an
    // actuator is gated on car verification, and the arming semantics are
    // not decoded.
    .filter(it => it.screen || it.menu || !it.action)
    // a write entry that opens the same SCREEN as a read entry (RDC's
    // "MV write" reuses s_abgleichwert_lesen): INPA's difference is an input
    // dialog and a write job in the ITEM body, neither of which we run until
    // verified on a car, so what remains is a duplicate of the read page
    .filter(it => {
      const dup = it.screen && seen.has(it.screen)
        && /write|schreiben|reset|clear|loesch/i.test(it.label);
      if (it.screen) seen.add(it.screen);
      return !dup;
    })
    .map(it => ({
      nr: it.nr,
      label: irLabel(it.label.trim()) || it.label.trim(),
      screen: it.screen || null,
      menu: it.menu || null,
      // no target and no action: INPA runs this in place (actuator toggles)
      inPlace: !it.screen && !it.menu,
      readable: it.screen ? irReadable((ir.screens || {})[it.screen] || {})
        : false,
    }));
}

// Walk the IR from a menu: list its entries, open a screen, descend into a
// submenu, Esc back up one level -- INPA's own navigation, and ours.
function renderIrMenu(ecu, ir, menuName, container, back, trail = []) {
  const items = irMenuItems(ir, menuName);
  if (!items.length) return false;

  const open = async (it) => {
    if (it.inPlace) {
      // INPA runs this from the menu: each key sets its own REQ/VAL pair in
      // ONE argument string, and a single job re-commands every actuator on
      // the ECU at once. The pairing is decoded (comp.items) -- what is not
      // established is the neutral word: whether all-REQ-zero is a true
      // no-op. Until that is confirmed on a car, pressing one key would be
      // asserting a value for six actuators nobody chose.
      const comp = (ir.menus[menuName] || {}).composite;
      const pair = comp && comp.items && comp.items[String(it.nr)];
      container.className = 'results-panel';
      container.innerHTML = `<div class="empty"><div>`
        + `<strong>${esc(it.label)}</strong></div>`
        + (pair
          ? `<div>INPA sends this as part of <code>${esc(comp.job)}</code> — `
            + `one job carrying all ${comp.fields} fields, of which this key `
            + `owns arguments ${pair[0]} and ${pair[1]} (its enable and its `
            + `value). Every press re-commands all `
            + `${Object.keys(comp.items).length} actuators at once.</div>`
            + (comp.baseline
              ? `<div>INPA's own neutral word is `
                + `<code>${esc(comp.baseline)}</code>, so a press sends that `
                + `with this pair set. Decoded, but not yet confirmed against `
                + `a car — so it stays inert.</div>`
              : `<div>The neutral word for the other fields is not decoded, `
                + `so it stays inert.</div>`)
          : `<div>INPA runs this from the menu itself. The command sequence `
            + `is not decoded, so this is listed but not runnable here.`
            + `</div>`)
        + `</div>`;
      sbLeft.textContent = `${ecu.sgbd}.prg · ${it.label} · not runnable`;
      setActions([...keys(), {
        key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
        fn: () => renderIrMenu(ecu, ir, menuName, container, back, trail),
      }]);
      return;
    }
    if (it.menu && !it.screen) {
      renderIrMenu(ecu, ir, it.menu, container, () =>
        renderIrMenu(ecu, ir, menuName, container, back, trail), [...trail, it.label]);
      return;
    }
    const scr = (ir.screens || {})[it.screen];
    const screens = scr
      ? irRowsTranslated(scr, await irDescs(ecu, scr)) : [];
    if (screens.length) {
      showInpaCategory(ecu, screens, container, irLabel(scr.title) || it.label);
    } else {
      container.className = 'results-panel';
      container.innerHTML = `<div class="empty"><div>`
        + (scr && !irReadable(scr)
          ? `In INPA this entry performs an action, not a readout — it is not `
            + `offered here until verified on a car.`
          : `INPA lists this entry, but it has no readouts.`)
        + `</div></div>`;
    }
    sbLeft.textContent = `${ecu.sgbd}.prg · ${[...trail, it.label].join(' · ')}`;
    setActions([...keys(), {
      key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
      fn: () => renderIrMenu(ecu, ir, menuName, container, back, trail),
    }]);
  };

  const keys = () => items.slice(0, FKEY_SLOTS).map((it, n) => ({
    key: String(n + 1), keyLabel: `F${it.nr}`, label: it.label,
    fn: () => open(it),
  }));

  const count = (it) => {
    if (it.inPlace) return 'not runnable';
    if (!it.screen) return '';
    const scr = (ir.screens || {})[it.screen];
    if (!scr) return '';
    const n = irRows(scr).rows.length;
    return n ? `${n} value${n === 1 ? '' : 's'}` : '';
  };

  if (inpaMode()) {
    container.className = 'results-panel';
    container.innerHTML = `<div class="act-key-list" id="ir-list"></div>`;
    const list = container.querySelector('#ir-list');
    items.forEach((it) => {
      const row = document.createElement('button');
      row.className = 'inpa-fn act-key-row';
      row.innerHTML = `<span class="inpa-fn-key">&lt; F${it.nr} &gt;</span>`
        + `<span class="inpa-fn-label">${esc(it.label)}</span>`
        + `<span class="act-key-val">${esc(count(it))}</span>`;
      row.onclick = () => open(it);
      list.appendChild(row);
    });
  } else {
    container.className = 'group-grid stagger';
    container.innerHTML = '';
    items.forEach((it) => {
      const tile = document.createElement('div');
      tile.className = 'group-tile';
      tile.innerHTML = `
        <div class="group-name">${esc(it.label)}</div>
        <div class="group-count">${esc(count(it))}</div>
        <div class="group-arrow">→</div>`;
      tile.onclick = () => open(it);
      container.appendChild(tile);
    });
    stagger(container, 30);
  }

  setActions([...keys(), {
    key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: back,
  }]);
  return true;
}

// Which IR menu serves an app section. The root menu's item labels are
// INPA's own, so the section is found by matching them -- the same mapping
// ROOT_SECTION uses, but resolved through the IR's navigation rather than
// through mined section files.
const IR_SECTION = [
  [/^Status$|^Read status$|^Status lesen$/i, 'Status'],
  [/^Activate$|^Ansteuern$|^Steuern$/i, 'Activations'],
];

function irSectionMenu(ir, section) {
  const root = (ir.menus || {})[(ir.entry || {}).menu];
  if (!root) return null;
  for (const it of root.items || []) {
    const hit = IR_SECTION.find(([re, name]) =>
      name === section && re.test((it.label || '').trim()));
    if (hit && it.menu) return it.menu;
  }
  return null;
}
