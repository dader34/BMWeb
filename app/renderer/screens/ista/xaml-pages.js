/**
 * @file The pages that draw from ISTA's own layout: Fault memory, Test plan
 * and Basic Features.
 *
 * A PAGE HERE IS A VIEW MODEL. ISTA's view binds to names -- a property for
 * every list and label, a command for every button -- and its C# fills them
 * in. Each function below is that view model for one view: it builds the
 * `data` and `commands` the template asks for out of what the app already
 * holds, hands them to screens/ista/xaml.js, and redraws when one changes.
 * The layout, the column list, the button row and every label come from the
 * template; nothing here names a column or a button's caption.
 *
 * EACH RETURNS false WHEN IT CANNOT DRAW (the template is not in this
 * build), and the shell then draws the hand-built page it always had. So a
 * page is switched over, never replaced: the setting picks which one draws,
 * and a build without the templates behaves exactly as before.
 *
 * A COMMAND THAT IS NOT SUPPLIED DRAWS ITS BUTTON OFF. Show symptoms and the
 * test plan's Filters exist in the tool and have nothing behind them here,
 * so they are in the row, greyed -- which is what the template says the row
 * is, and what the hand-built bars also do, without a second table listing
 * the buttons.
 */

/* exported istaXamlFaultMemory istaXamlTestPlan istaXamlBasic
   istaXamlCulture istaXamlUnitList istaXamlSae istaXamlActive
   istaXamlHitList istaXamlDetails istaSaeLookup istaXamlVin
   istaXamlReadout istaXamlDiagSearch istaDiagSearchHits */

/**
 * The string table's culture for the app's language setting.
 * @returns {string} e.g. 'en-GB'
 */
function istaXamlCulture() {
  const lang =
    typeof Settings === 'object' && Settings
      ? String(Settings.get('lang', 'en') || 'en')
      : 'en';
  const known = {
    en: 'en-GB',
    de: 'de-DE',
    es: 'es-ES',
    fr: 'fr-FR',
    it: 'it-IT',
    pl: 'pl-PL',
    cs: 'cs-CZ',
    pt: 'pt-PT',
    tr: 'tr-TR',
    sv: 'sv-SE',
    nl: 'nl-NL',
    ru: 'ru-RU',
    ja: 'ja-JP',
    ko: 'ko-KR',
    th: 'th-TH',
    zh: 'zh-CN',
  };
  return known[lang.slice(0, 2).toLowerCase()] || 'en-GB';
}

/**
 * Load a view and its strings, split into the shell's three parts.
 * @param {string} view - the view's class name
 * @returns {Promise<{parts: object, strings: object}|null>} null when this
 *   build does not ship the template
 */
async function istaXamlOpen(view) {
  const [tpl, strings, fallback] = await Promise.all([
    istaXamlLoad(view),
    istaXamlStrings(istaXamlCulture()),
    istaXamlStrings('en-GB'),
  ]);
  if (!tpl || !tpl.root) return null;
  return { parts: istaXamlParts(tpl), strings: strings || fallback || {} };
}

/**
 * Paint one view: content into the page, status into the status line,
 * buttons into the bottom bar.
 * @param {HTMLElement|null} host - the page, or null for the chrome alone
 * @param {object} parts - from istaXamlParts
 * @param {object} ctx - the render context
 * @param {{items?: Array<object>}} [extra] - status items the view has no
 *   row for, appended after its own
 * @returns {void}
 */
function istaXamlPaint(host, parts, ctx, extra) {
  ctx.declared = parts.resources;
  // a selection repaints only the chrome (host is null): replacing the rows
  // under the pointer would swallow the second click of a double click
  if (host) istaXamlRender(host, parts.content, ctx);
  const st = istaXamlStatus(parts.status, ctx);
  istaRealStatus({
    items: [...st.items, ...((extra && extra.items) || [])],
    legend: st.legend.length ? st.legend : null,
  });
  const rows = istaXamlButtons(parts.buttons, ctx);
  istaRealBottom(rows.length ? rows : null);
}

// ---- Troubleshooting / Fault memory -----------------------------------------

/**
 * Whether the fault filter lets a fault through.
 *
 * A PORT OF Logic.FilterDTCRelevance (RheingoldSessionController), branch
 * for branch:
 *  - a fault the database marks not relevant is hidden while `hideBogus` is
 *    on (the tool's default); one with no verdict is hidden only while
 *    `hideUnknown` is on (off by default)
 *  - a fault with no stored record at all is hidden as soon as either
 *    mileage bound is set: it has no mileage to hold against the range
 *  - with a lower bound, the fault passes when its current OR its first
 *    entry is at or above it; with an upper bound, when either is at or
 *    below it. An entry with no mileage counts as -1, which is how the tool
 *    reads one, and a missing first entry takes the current one's value
 *  - a fault whose class is ticked off is hidden
 * @param {object} f - {relevance, current, first, cls}; `current` and
 *   `first` are {km} or null
 * @param {object} [filter] - {lower, upper, hidden}; null bounds are unset
 * @param {object} [opts] - {hideBogus = true, hideUnknown = false}
 * @returns {boolean}
 */
function istaFaultRelevant(f, filter, opts) {
  if (!f) return false;
  const o = opts || {};
  const flt = filter || {};
  if (f.relevance == null) {
    if (o.hideUnknown) return false;
  } else if (f.relevance !== true && o.hideBogus !== false) return false;
  const lower = flt.lower == null ? null : Number(flt.lower);
  const upper = flt.upper == null ? null : Number(flt.upper);
  if (!f.current) {
    if (upper != null || lower != null) return false;
  } else {
    const cur = f.current.km == null ? -1 : Number(f.current.km);
    const first = f.first && f.first.km != null ? Number(f.first.km) : cur;
    if (lower != null && !(lower <= cur) && !(lower <= first)) return false;
    if (upper != null && upper < cur && upper < first) return false;
  }
  return !(flt.hidden && flt.hidden.includes(f.cls));
}

/**
 * Whether a fault filter is the default one: no bounds, no class hidden.
 * @param {object} [f] - {lower, upper, hidden}
 * @returns {boolean}
 */
function istaFaultFilterDefault(f) {
  return (
    !f || (f.lower == null && f.upper == null && !(f.hidden && f.hidden.length))
  );
}

/**
 * How far one press of a cursor arrow moves it.
 *
 * A PORT OF FaultFilterSettingsGraph.ProgressiveClickStep. Presses on the
 * same arrow less than 0.3 s apart count as a run, and the step grows with
 * the run: one kilometre at first, then a thousandth, a hundredth and a
 * tenth of the distance still open in that direction, never past it.
 * @param {number} increment - -1 or 1
 * @param {number} max - the distance left in that direction, in km
 * @param {object} run - {time, count, button}, kept between presses
 * @param {string} button - which arrow
 * @param {number} now - ms
 * @returns {number} the signed step in km
 */
function istaFaultCursorStep(increment, max, run, button, now) {
  if (button === run.button && now - run.time < 300) run.count++;
  else run.count = 0;
  run.button = button;
  run.time = now;
  let step = increment;
  if (run.count > 15) step *= Math.trunc(max / 10);
  else if (run.count > 10) step *= Math.trunc(max / 100);
  else if (run.count > 3) step *= Math.trunc(max / 1000);
  if (step === 0) step = increment;
  if (Math.abs(step) > Math.abs(max)) step = Math.sign(increment) * max;
  return step;
}

/**
 * The fault filter dialog, from InteractionFaultFilterSettingsView.
 *
 * Two tabs. "Mile axis" draws every fault at the mileage it was stored at
 * and, with Cursor on, a pair of cursors: what lies between them is what the
 * table keeps. "Class" ticks fault classes on and off, and is greyed while
 * no fault carries one. Nothing changes until Accept.
 *
 * THE GRAPH IS DRAWN HERE. The tool paints it in code on a Canvas, so the
 * template has an empty canvas where it goes; the axes and the cursors are
 * this build's drawing of the same thing. Zoom doubles and halves the scale
 * as the tool's does; its scroll bar is not built, so a zoomed axis shows
 * the range from its lower end.
 * @param {object} o - the dialog's inputs
 * @param {Array<{code: string, km: number|null, cls: string}>} o.faults
 * @param {object} o.filter - {lower, upper, hidden} as it stands
 * @param {object} o.strings - the string table
 * @param {(filter: object) => void} o.commit - Accept
 * @returns {Promise<boolean>} false when the template is not in this build
 */
async function istaXamlFaultFilter(o) {
  const tpl = await istaXamlLoad('InteractionFaultFilterSettingsView');
  if (!tpl || typeof openModal !== 'function') return false;
  const kms = o.faults.map((f) => f.km).filter((k) => k != null && k >= 0);
  const span = kms.length ? Math.max(...kms) - Math.min(...kms) : 0;
  const pad = Math.max(1000, Math.ceil(span * 0.1));
  const min = kms.length ? Math.max(0, Math.min(...kms) - pad) : 0;
  const max = kms.length ? Math.max(...kms) + pad : 1000;
  const g = {
    min,
    max,
    scale: 1,
    on: o.filter.lower != null || o.filter.upper != null,
    left: o.filter.lower == null ? min : Number(o.filter.lower),
    right: o.filter.upper == null ? max : Number(o.filter.upper),
  };
  const classes = [...new Set(o.faults.map((f) => f.cls).filter(Boolean))]
    .sort()
    .map((name) => ({
      Name: name,
      IsChecked: !(o.filter.hidden || []).includes(name),
    }));
  const run = { time: 0, count: 0, button: '' };

  const title = istaXamlText({ strings: o.strings }, '#FilterFaultCode');
  const { overlay, close } = openModal(
    `<div class="modal ixdialog" role="dialog" aria-modal="true">` +
      `<div class="modal-title">${esc(title)}</div>` +
      `<div class="ixdialog-host ista-real-body"></div></div>`
  );
  const host = overlay.querySelector('.ixdialog-host');
  const ctx = {
    strings: o.strings,
    tabs: {},
    data: { FaultClassList: classes },
    elements: { faultFilterGraph: {} },
    set: (path, value, n, row) => {
      if (row && path === 'IsChecked') row.IsChecked = value;
    },
    commands: {
      CmdCancel: () => close(),
      CmdCommit: () => {
        o.commit({
          lower: g.on ? g.left : null,
          upper: g.on ? g.right : null,
          hidden: classes.filter((c) => !c.IsChecked).map((c) => c.Name),
        });
        close();
      },
      CmdZoomIn: () => {
        g.scale *= 2;
        draw();
      },
    },
    widgets: {
      coordinateSystem: (el) => {
        el.innerHTML = istaFaultGraphSvg(o.faults, g);
      },
    },
  };
  // a cursor moves by a step that grows while its arrow is pressed in a run
  const move = (button, increment, from, room) => () => {
    const step = istaFaultCursorStep(
      increment,
      Math.max(0, room()),
      run,
      button,
      Date.now()
    );
    if (from) g.left = Math.min(g.right, Math.max(g.min, g.left + step));
    else g.right = Math.max(g.left, Math.min(g.max, g.right + step));
    draw();
  };
  function draw() {
    const e = ctx.elements.faultFilterGraph;
    e.LowerKMBound = g.on ? g.left : '';
    e.UpperKMBound = g.on ? g.right : '';
    e.IsCursorFromDownEnabled = g.on && g.left > g.min;
    e.IsCursorFromUpEnabled = g.on && g.left < g.right;
    e.IsCursorToDownEnabled = g.on && g.right > g.left;
    e.IsCursorToUpEnabled = g.on && g.right < g.max;
    ctx.toggles = {
      btnCursor: {
        on: g.on,
        toggle: () => {
          g.on = !g.on;
          // switching the cursors on puts them back at the ends of the axis
          if (g.on) {
            g.left = g.min;
            g.right = g.max;
          }
          draw();
        },
      },
    };
    ctx.commands.CmdZoomOut =
      g.scale > 1
        ? () => {
            g.scale /= 2;
            draw();
          }
        : null;
    ctx.clicks = {
      cursorFromDown: move('fd', -1, true, () => g.left - g.min),
      cursorFromUp: move('fu', 1, true, () => g.right - g.left),
      cursorToDown: move('td', -1, false, () => g.right - g.left),
      cursorToUp: move('tu', 1, false, () => g.max - g.right),
    };
    host.replaceChildren(
      ...(tpl.root.kids || []).map((k) => istaXamlNode(k, ctx.data, ctx))
    );
  }
  ctx.redraw = draw;
  draw();
  return true;
}

/**
 * The mileage axis as SVG: one row per fault, a tick where it was stored,
 * and the cursor pair when it is on.
 * @param {Array<{code: string, km: number|null}>} faults - what to plot
 * @param {object} g - {min, max, scale, on, left, right}
 * @returns {string} the SVG markup
 */
function istaFaultGraphSvg(faults, g) {
  const W = 840;
  const rowH = 22;
  const top = 12;
  const x0 = 70;
  const H = Math.max(160, top + faults.length * rowH + 40);
  const hi = g.min + (g.max - g.min) / g.scale;
  const x = (km) => x0 + ((km - g.min) / (hi - g.min || 1)) * (W - x0 - 20);
  const inView = (km) => km >= g.min && km <= hi;
  let out =
    `<svg class="ixgraph" viewBox="0 0 ${W} ${H}" width="${W}" ` +
    `height="${H}" role="img" aria-label="Faults by mileage">`;
  const base = H - 28;
  out += `<line x1="${x0}" y1="${base}" x2="${W - 20}" y2="${base}" class="ax"/>`;
  for (let i = 0; i <= 4; i++) {
    const km = Math.round(g.min + ((hi - g.min) * i) / 4);
    out +=
      `<line x1="${x(km)}" y1="${base}" x2="${x(km)}" y2="${base + 5}" ` +
      `class="ax"/><text x="${x(km)}" y="${base + 18}" ` +
      `text-anchor="middle">${km}</text>`;
  }
  faults.forEach((f, i) => {
    const y = top + i * rowH + rowH / 2;
    out +=
      `<text x="${x0 - 8}" y="${y + 4}" text-anchor="end">` +
      `${esc(f.code)}</text>` +
      `<line x1="${x0}" y1="${y}" x2="${W - 20}" y2="${y}" class="row"/>`;
    if (f.km != null && f.km >= 0 && inView(f.km))
      out += `<rect x="${x(f.km) - 3}" y="${y - 6}" width="6" height="12" class="mark"/>`;
  });
  if (g.on)
    for (const km of [g.left, g.right])
      if (inView(km))
        out += `<line x1="${x(km)}" y1="${top}" x2="${x(km)}" y2="${base}" class="cursor"/>`;
  return `${out}</svg>`;
}

/**
 * Fault memory, from FaultMemoryView.
 *
 * The rows are the newest stored scan's faults (istaFaultRows), projected
 * onto the names the view binds and passed through the tool's own filter.
 * What the buttons do is the tool's too:
 *  - Delete fault memory clears the WHOLE VEHICLE, then reads it again
 *  - Filter fault memory opens the mileage / class dialog
 *  - Show completely is a toggle that lets long texts wrap
 *  - Calculate test plan works on every fault the table shows
 * @param {HTMLElement} host - where to draw
 * @param {object} o - {car, chassis}
 * @returns {Promise<boolean>} false when the template is not in this build
 */
async function istaXamlFaultMemory(host, o) {
  const car = o.car;
  let picked = null;
  let expanded = false;
  let cable = false;
  const filter = () => istaState.faultRange || null;

  const api = await istaXamlMount(host, 'FaultMemoryView', (page) => {
    const scan = istaNewestScan(car);
    const all = istaFaultRows(scan && scan.report).map((r) => {
      const km = r.km === '' || r.km == null ? null : Number(r.km);
      // a module that stored anything with the fault has a current record,
      // whether or not that record carries a mileage
      const stored =
        km != null || Object.keys(r.raw || {}).some((k) => /^F_UW/.test(k));
      return {
        DTC: { FortAsHexString: r.code, F_UW_KM: r.km || '' },
        ECU: { TITLE_ECUTREE: r.module, VARIANTE: r.sgbd, BUS: '' },
        FaultLabel: r.desc,
        Existing: r.present ? 'yes' : 'No',
        FaultClass: '-',
        test: {
          relevance: null,
          current: stored ? { km: Number.isFinite(km) ? km : null } : null,
          first: null,
          cls: '',
        },
        row: r,
      };
    });
    const shown = all.filter((x) => istaFaultRelevant(x.test, filter()));
    // the rows are rebuilt on every pass, wrapper and fault row alike, so
    // the pick is carried by the scan's own code object underneath them
    picked = picked
      ? shown.find((x) => x.row.raw === picked.row.raw) || null
      : null;
    const open = (it) =>
      istaFaultDialog(it.row, {
        rows: shown.map((x) => x.row),
        index: shown.indexOf(it),
      });
    const modules = ((scan && scan.report && scan.report.modules) || []).filter(
      (m) => m.sgbd
    );
    return {
      data: {
        FaultsCollectionView: shown,
        SelectedItem: picked,
        FaultFilterSettings: { IsDefault: istaFaultFilterDefault(filter()) },
        IsAirActive: false,
        Logic: {
          VecInfo: { PerceivedSymptoms: istaState.patterns || [] },
          CurrentOperation: {
            DataContext: { VecInfo: { FaultCodeSum: all.length } },
          },
        },
      },
      resources: { FaultCollectionViewSource: shown },
      converters: { FaultCodeSumStateConverter: (v) => v },
      empty: {
        lvFaultList: all.length
          ? 'The filter hides every fault. Press Delete filter to see them.'
          : 'No fault memory has been read on this vehicle yet. Run Start ' +
            'vehicle test on Vehicle details or the Control unit list.',
      },
      select: (name, row) => {
        picked = row;
        page.chrome();
      },
      toggles: {
        ExpandViewButton: {
          on: expanded,
          toggle: () => {
            expanded = !expanded;
            page.draw();
          },
        },
      },
      commands: {
        // the button needs a pick; a double click brings its own row
        CmdDislpayFaultCode: {
          off: !picked,
          run: (it) => open(it && it.row ? it : picked),
        },
        // THE WHOLE VEHICLE, as the tool's quick delete is. It needs the car
        // on the cable and nothing else running on it.
        CmdQuickDelete:
          cable && modules.length && !istaTestRun
            ? () => istaQuickDelete(modules)
            : null,
        CmdShowFaultFilterSettings: all.length
          ? () =>
              istaXamlFaultFilter({
                faults: all.map((x) => ({
                  code: x.row.code,
                  km: x.test.current ? x.test.current.km : null,
                  cls: x.test.cls,
                })),
                filter: filter() || {},
                strings: page.strings,
                commit: (f) => {
                  istaState.faultRange = istaFaultFilterDefault(f) ? null : f;
                  page.draw();
                },
              })
          : null,
        CmdDefaultFaultFilterSettings: istaFaultFilterDefault(filter())
          ? null
          : () => {
              istaState.faultRange = null;
              page.draw();
            },
        // every fault the table shows, as the tool calculates it
        CmdCalculateTestplan: shown.length
          ? async () => {
              const rows = await istaCalcPlanAll(
                shown.map((x) => x.row),
                car,
                o.chassis
              );
              if (typeof istaPlanSet === 'function') istaPlanSet(car, rows);
              if (!rows.length && typeof toast === 'function')
                toast('No procedure is linked to these faults in this build.');
              return istaGo('service-plan', 'test-plan', null);
            }
          : null,
      },
      after: (h) => {
        // Show completely lets a long fault text wrap instead of being cut
        const table = h.querySelector('.ixtable');
        if (table) table.classList.toggle('ixfull', expanded);
      },
    };
  });
  if (!api) return false;
  // whether the car can be reached decides Delete fault memory, and is a
  // question for the engine, not for this page: asked once, after the draw
  try {
    const st = await window.api('/api/state');
    cable = !!(st && st.connected);
  } catch (e) {
    /* no engine: the button stays off */
  }
  if (!cable && typeof webBus === 'object' && webBus && webBus.connected)
    cable = true;
  if (cable && host.isConnected) api.chrome();
  return true;
}

/**
 * Clear the fault memory of every module the last test reached, then test
 * the vehicle again.
 *
 * ONE QUESTION, THEN EVERY MODULE. The tool's quick delete is one action on
 * the car, not one per control unit. THE RE-READ IS THE RESULT: a clear that
 * reports success hides a live fault that re-enters the moment its module
 * sees it again, so the vehicle test runs afterwards and the table shows
 * what that finds, not what the clear claimed.
 * @param {Array<{sgbd: string, label?: string}>} modules - who to clear
 * @returns {Promise<void>}
 */
async function istaQuickDelete(modules) {
  const ok =
    typeof confirmDialog === 'function'
      ? await confirmDialog({
          title: 'Delete fault memory?',
          body:
            `Erases the fault memory of all ${modules.length} control ` +
            `units the last vehicle test reached, then reads the vehicle ` +
            `again. Anything still present will show again.`,
          confirmLabel: 'Delete',
          danger: true,
        })
      : false;
  if (!ok) return;
  const failed = [];
  for (const m of modules) {
    try {
      await window.api(`/api/ecu/${m.sgbd}/run/FS_LOESCHEN`, {
        method: 'POST',
      });
    } catch (e) {
      failed.push(m.label || m.sgbd);
    }
  }
  if (failed.length && typeof toast === 'function')
    toast(`Did not clear: ${failed.join(', ')}`);
  return istaOpenVehicleTest();
}

/**
 * The test plan for a list of faults: every fault's procedures, once each.
 * @param {object[]} faults - fault rows
 * @param {object|null} car - the picked car
 * @param {string} chassis - its chassis
 * @returns {Promise<object[]>} plan rows
 */
async function istaCalcPlanAll(faults, car, chassis) {
  const out = [];
  const seen = new Set();
  for (const f of faults)
    for (const row of await istaCalcPlan(f, car, chassis)) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(row);
    }
  return out;
}

// ---- Service plan / Test plan -----------------------------------------------

/**
 * Test plan, from TestPlanView.
 *
 * The view lists TestPlanItems grouped by their diagnosis object
 * (DiagParent), which is the plan's "component" here. The State column's
 * dot is drawn by the app (its colour comes from a trigger a template does
 * not carry), through the same istaPlanStateCell the hand-built page uses.
 * @param {HTMLElement} host - where to draw
 * @param {object} o - {car, chassis}
 * @returns {Promise<boolean>} false when the template is not in this build
 */
async function istaXamlTestPlan(host, o) {
  const view = await istaXamlOpen('TestPlanView');
  if (!view || !host.isConnected) return !!view;
  const car = o.car;
  let picked = null;
  let collapsed = false;

  const draw = async (chromeOnly) => {
    const groups = await istaPlanGroups('test-plan', car);
    if (!host.isConnected) return;
    const sorted = [...groups].sort(
      (a, b) =>
        (Number(a.priority) - Number(b.priority)) *
        (istaState.planDesc ? -1 : 1)
    );
    const items = [];
    for (const g of sorted)
      for (const r of g.rows || [])
        items.push({
          InfoObjectSource: {
            XepInfoObject: { InfoType: r.type || '-' },
            Title: r.title || '',
            State: r.state || 'none',
            Note: '',
          },
          DiagParent: {
            Id: g.title,
            Title: g.title,
            MainPriority: { Prio: r.priority == null ? '' : r.priority },
            GroupPrio: g.priority == null ? '' : g.priority,
          },
          row: r,
        });
    // the rows are rebuilt on every pass (the plan is read back from the
    // store), so the pick is carried by the module's identifier
    picked = picked
      ? items.find(
          (x) => x.row.id === picked.row.id && x.row.title === picked.row.title
        ) || null
      : null;
    const open = (it) => istaOpenPlanRow(it.row, car, o.chassis, () => draw());

    const ctx = {
      strings: view.strings,
      data: {
        SelectedTestPlanEntry: picked,
        PruefplanFilterSettings: { IsDefault: true },
        IsAirActive: false,
        Logic: { VecInfo: { Testplan: { Item: items } } },
      },
      resources: { TestPlanCollectionViewSource: items },
      converters: { NoteVisibilityConverter: (v) => !!(v && v.Note) },
      empty: {
        testPlanDataGrid:
          'Nothing has been calculated into the test plan for this vehicle ' +
          'yet. Pick a fault on Fault memory and press Calculate test plan.',
      },
      groups: {
        testPlanDataGrid: (it) => ({
          key: it.DiagParent.Id,
          cells: [it.DiagParent.Title, it.DiagParent.GroupPrio],
        }),
      },
      cells: {
        testPlanDataGrid: {
          columnStatus: (it) => istaPlanStateCell(it.InfoObjectSource.State),
          columnType: (it) => esc(it.InfoObjectSource.XepInfoObject.InfoType),
        },
      },
      // Priority is the order a technician works the plan in, and the one
      // column this build can re-order by
      sort: {
        testPlanDataGrid: {
          cols: ['columnPriority'],
          run: () => {
            istaState.planDesc = !istaState.planDesc;
            draw();
          },
        },
      },
      select: (name, it) => {
        picked = it;
        draw(true);
      },
      commands: {
        CommandNavBackToGuidedTroubleShootingPage: () =>
          istaGo('management', 'troubleshooting', 'fault-memory'),
        CommandCollapseExpand: items.length
          ? () => {
              collapsed = !collapsed;
              draw();
            }
          : null,
        CommandDisplay: picked ? () => open(picked) : null,
      },
    };
    istaXamlPaint(chromeOnly === true ? null : host, view.parts, ctx);
    if (chromeOnly === true) return;
    const table = host.querySelector('.ixtable');
    if (table) {
      table.classList.add('irplan');
      table.classList.toggle('ixcollapsed', collapsed);
      // a double click displays the row, as the Display button does
      table.querySelectorAll('tbody tr[data-i]').forEach((tr) => {
        tr.ondblclick = () => open(items[Number(tr.dataset.i)]);
      });
    }
  };
  await draw();
  return true;
}

// ---- Operations / New / Basic Features --------------------------------------

/**
 * Basic Features, from BasicFeaturesView.
 *
 * Three lists over the same characteristic tree the hand-built page reads:
 * the features, the values of the selected one, and every feature with the
 * value chosen for it. Undo takes back the newest choice, Undo all every
 * one, and Accept opens the vehicle once the choices describe exactly one.
 * @param {HTMLElement} host - where to draw
 * @param {object} [o] - {model} a prebuilt model, for tests
 * @returns {Promise<boolean>} false when the template or the tree is absent
 */
async function istaXamlBasic(host, o) {
  const [view, model] = await Promise.all([
    istaXamlOpen('BasicFeaturesView'),
    o && o.model !== undefined ? o.model : istaBasicLoad().catch(() => null),
  ]);
  if (!view || !model || !model.roots.length) return false;
  if (!host.isConnected) return true;
  /** @type {Object<string, string>} root id -> chosen value */
  const picked = {};
  /** @type {string[]} root ids, in the order they were chosen */
  const order = [];
  let active = model.roots[0].id;

  const draw = () => {
    const features = model.roots.map((r) => ({
      id: r.id,
      Title: r.label,
      Value: picked[r.id] || '',
    }));
    const current = features.find((f) => f.id === active) || features[0];
    const values = istaBasicValues(model, picked, current.id);
    const hits = istaBasicHits(model, picked);
    const one = hits.length === 1 ? istaBasicRow(model, hits[0]) : null;

    const ctx = {
      strings: view.strings,
      data: {
        BasicFeatureItems: features,
        SelectedBasicFeature: current,
        BasicFeatureValues: values,
        SelectedBasicFeatureValue: picked[current.id] || null,
        IsWorking: false,
      },
      select: (name, row) => {
        if (name === 'BasicFeatureItems') active = row.id;
        else if (picked[current.id] === row) {
          // the chosen value again takes the choice back
          delete picked[current.id];
          order.splice(order.indexOf(current.id), 1);
        } else {
          if (!(current.id in picked)) order.push(current.id);
          picked[current.id] = row;
        }
        draw();
      },
      commands: {
        CommandUndoAllBasicFeature: order.length
          ? () => {
              for (const id of order.splice(0)) delete picked[id];
              draw();
            }
          : null,
        CommandUndoBasicFeature: order.length
          ? () => {
              delete picked[order.pop()];
              draw();
            }
          : null,
        CommandAcceptBasicFeatures: one ? () => istaOpenBasic(one) : null,
      },
    };
    istaXamlPaint(host, view.parts, ctx, {
      items: [{ k: 'Hits:', v: `${hits.length} / ${hits.length}` }],
    });
    const root = host.querySelector('.ixaml');
    if (root) root.classList.add('ixbasic');
  };
  host._istaBasic = () => ({ picked, hits: istaBasicHits(model, picked) });
  draw();
  return true;
}

// ---- one page, mounted -------------------------------------------------------

/**
 * Mount a view on a page and keep it drawn.
 *
 * `build` is the view model: called on every pass, it returns the render
 * context for the state as it stands. The returned handle redraws the whole
 * page (`draw`) or only the status line and bottom bar (`chrome`), which is
 * what a row pick needs: replacing the rows under the pointer would swallow
 * the second click of a double click.
 *
 * A box the reader is typing in survives a redraw: the element is new, so
 * the focus and the caret are put back on the one carrying the same name.
 * @param {HTMLElement} host - the page
 * @param {string} name - the view's class name
 * @param {(api: object) => object|Promise<object>} build - the view model
 * @returns {Promise<object|null>} {draw, chrome}, or null when this build
 *   does not ship the template
 */
async function istaXamlMount(host, name, build) {
  const view = await istaXamlOpen(name);
  if (!view) return null;
  const api = {
    strings: view.strings,
    draw: async (chromeOnly) => {
      const ctx = await build(api);
      if (!host.isConnected || !ctx) return;
      ctx.strings = view.strings;
      const active =
        typeof document !== 'undefined' ? document.activeElement : null;
      const typing =
        !chromeOnly && active && host.contains(active) && active.dataset
          ? { name: active.dataset.xname, at: active.selectionStart }
          : null;
      istaXamlPaint(
        chromeOnly === true ? null : host,
        view.parts,
        ctx,
        ctx.extra
      );
      if (chromeOnly !== true && ctx.after) ctx.after(host);
      if (typing && typing.name) {
        const again = host.querySelector(`[data-xname="${typing.name}"]`);
        if (again) {
          again.focus();
          if (typing.at != null && again.setSelectionRange)
            again.setSelectionRange(typing.at, typing.at);
        }
      }
      if (ctx.chrome) ctx.chrome();
    },
    chrome: () => api.draw(true),
  };
  await api.draw();
  return api;
}

// ---- Vehicle information / Control unit list --------------------------------

/**
 * Control unit list, from EcuListView.
 *
 * One row per slot, as the hand-built list has it (istaLoadSlots), under the
 * view's three sortable columns and its own state bar. The state dot is the
 * app's: its colour comes from a trigger a template does not carry.
 * @param {HTMLElement} host - where to draw
 * @param {object} o - {car, chassis}
 * @returns {Promise<boolean>} false when the template is not in this build
 */
async function istaXamlUnitList(host, o) {
  const slots = await istaLoadSlots(o.chassis, o.car);
  if (!host.isConnected) return true;
  let picked = null;
  let sort = null;
  const rank = { faults: 0, ok: 1, silent: 2, unread: 3 };
  const keys = {
    '#Status': (x) => rank[x.slot.state] ?? 9,
    '#Abbreviation': (x) => String(x.TITLE_ECUTREE).toLowerCase(),
    '#ControlUnitName': (x) => String(x.XepEcuClique.Title).toLowerCase(),
  };
  const api = await istaXamlMount(host, 'EcuListView', () => {
    const rows = istaUnitListOrder(slots).map((slot) => ({
      TITLE_ECUTREE: slot.abbr,
      XepEcuClique: { Title: slot.name },
      slot,
    }));
    if (sort) {
      const key = keys[sort.col];
      rows.sort((a, b) => {
        const x = key(a);
        const y = key(b);
        return (x < y ? -1 : x > y ? 1 : 0) * (sort.desc ? -1 : 1);
      });
    }
    const faults = slots.reduce((a, x) => a + x.faults, 0);
    const read = slots.some((x) => x.state !== 'unread');
    const sel = picked ? rows.find((r) => r.slot === picked) || null : null;
    return {
      data: {
        DefaultEcuStateBarVisibility: true,
        IstaEcuStateBarVisibility: false,
        TeleServiceEcuStateBarVisibility: false,
        Logic: {
          IndustrialCustomer: { UsesFaultMemory: true },
          VecInfo: { ECU: rows, SelectedECU: sel, FaultCodeSum: faults },
        },
      },
      resources: { EcuCollectionViewSource: rows },
      converters: {
        FaultCodeSumStateConverter: (v) => (read ? String(v) : 'Unknown'),
      },
      empty: {
        EcuCollectionViewSource: 'No module list ships for this chassis.',
      },
      cells: {
        EcuCollectionViewSource: {
          '#Status': (r) =>
            `<span class="irstate"><i class="${
              ISTA_STATE_CLASS[r.slot.state] || 'dim'
            }"></i></span>`,
        },
      },
      sort: {
        EcuCollectionViewSource: (col) => {
          sort = { col, desc: !!(sort && sort.col === col && !sort.desc) };
          api.draw();
        },
      },
      select: (name, r) => {
        picked = r.slot;
        api.chrome();
      },
      commands: {
        CommandStartVehicleTest: istaTestRun
          ? null
          : () => istaOpenVehicleTest(),
        // the window is about ONE control unit, so it needs one picked
        CommandECUFunctions:
          picked && !istaTestRun
            ? () => istaOpenEcuWindow(picked, null, o.chassis)
            : null,
        CommandNav32: istaTestRun
          ? null
          : () => istaGo('management', 'troubleshooting', 'fault-memory'),
      },
      extra: {
        items: istaTestRun
          ? [{ k: 'Vehicle test:', v: istaTestPhase() }]
          : istaTestError
            ? [{ k: 'Vehicle test:', v: istaTestError }]
            : [],
      },
      // WHILE THE TEST RUNS the read owns the cable, and the only safe thing
      // to offer is stopping it. The view has no such row (the tool covers
      // the page with a progress dialog), so the shell's own one is drawn.
      chrome: () => {
        if (istaTestRun)
          istaBottomBar('unit-list-busy', { cancel: () => istaTestCancel() });
      },
    };
  });
  return !!api;
}

// ---- Troubleshooting / SAE fault code input ---------------------------------

/**
 * What the two boxes of the SAE page find.
 *
 * THE CAR'S OWN MODULES COME FIRST. The flat fault table collides across ECU
 * families, and only the SGBD's own table can tell them apart, so every
 * module this car carries is asked in turn and the shared table is the
 * fallback rather than the answer.
 * @param {string} pcode - what was typed as an SAE code
 * @param {string} bmw - what was typed as a BMW fault code
 * @param {string[]} sgbds - the car's own modules
 * @returns {Array<{PKode: string, DTC: object, FaultLabel: string, sgbd: string}>}
 */
function istaSaeLookup(pcode, bmw, sgbds) {
  const textFor = (code) => {
    if (typeof faultName !== 'function') return { text: '', sgbd: '' };
    for (const sgbd of sgbds || []) {
      const own =
        typeof scopedFaultDb === 'function' ? scopedFaultDb(sgbd) : null;
      if (own && own[code]) {
        const t = faultName('', code, sgbd);
        if (t) return { text: t, sgbd };
      }
    }
    return { text: faultName('', code, '') || '', sgbd: '' };
  };
  const p = String(pcode || '')
    .trim()
    .toUpperCase();
  const b = String(bmw || '')
    .trim()
    .toUpperCase();
  const found = [];
  const row = (sae, code, t) => ({
    PKode: sae,
    DTC: { FortAsHexString: code },
    // which module's table answered, when one did: the same code reads
    // differently on another engine and the row says whose
    FaultLabel: (t.text || '-') + (t.sgbd ? ` (${t.sgbd})` : ''),
    desc: t.text,
    sgbd: t.sgbd,
  });
  if (p && typeof hexForPcode === 'function') {
    const hex = hexForPcode(p);
    if (hex) found.push(row(p, hex, textFor(hex)));
  }
  if (b) {
    const ps = typeof pcodesForHex === 'function' ? pcodesForHex(b) || [] : [];
    const t = textFor(b);
    if (ps.length) for (const one of ps) found.push(row(one, b, t));
    else found.push(row('-', b, t));
  }
  return found;
}

/**
 * SAE fault code input, from PCodeView.
 * @param {HTMLElement} host - where to draw
 * @param {object} o - {car, chassis}
 * @returns {Promise<boolean>} false when the template is not in this build
 */
async function istaXamlSae(host, o) {
  const slots = await istaLoadSlots(o.chassis, o.car);
  if (!host.isConnected) return true;
  const sgbds = slots.map((x) => x.sgbd).filter(Boolean);
  const state = { PCode: '', FaultCode: '' };
  let picked = null;
  const api = await istaXamlMount(host, 'PCodeView', () => {
    const rows = istaSaeLookup(state.PCode, state.FaultCode, sgbds);
    const sel =
      (picked &&
        rows.find(
          (r) =>
            r.PKode === picked.PKode &&
            r.DTC.FortAsHexString === picked.DTC.FortAsHexString
        )) ||
      null;
    const show = sel || rows[0] || null;
    return {
      data: {
        PCode: state.PCode,
        FaultCode: state.FaultCode,
        SelectedItem: sel,
        Logic: {
          VecInfo: { PerceivedSymptoms: [] },
          CurrentOperation: { DataContext: { VecInfo: { PKodeList: rows } } },
        },
      },
      resources: { FaultCollectionViewSource: rows },
      set: (path, value) => {
        state[path] = value;
        api.draw();
      },
      select: (name, r) => {
        picked = r;
        api.chrome();
      },
      commands: {
        CmdShowPCode: show
          ? () =>
              istaFaultDialog({
                code: show.DTC.FortAsHexString,
                desc: show.desc,
                module: '',
                sgbd: show.sgbd,
                raw: {},
              })
          : null,
        CmdDeletePCode:
          state.PCode || state.FaultCode
            ? () => {
                state.PCode = '';
                state.FaultCode = '';
                picked = null;
                api.draw();
              }
            : null,
      },
    };
  });
  // the P-code table and the fault texts are separate loads; a page that
  // opens before they land simply finds nothing until they do
  if (api)
    Promise.all([
      typeof loadPcodes === 'function' ? loadPcodes() : null,
      typeof loadFaultDb === 'function' ? loadFaultDb() : null,
    ])
      .then(() => api.draw())
      .catch(() => {
        /* both are optional: the page then finds nothing */
      });
  return !!api;
}

// ---- Operations / Active ----------------------------------------------------

/**
 * Operations / Active, from OperationActiveListView.
 *
 * The tool lists every operation open at once; this build holds one, so the
 * list has one row or none. Close operation lets go of the vehicle and goes
 * back to where one is opened.
 * @param {HTMLElement} host - where to draw
 * @param {object} o - {car, chassis}
 * @returns {Promise<boolean>} false when the template is not in this build
 */
async function istaXamlActive(host, o) {
  let picked = null;
  const api = await istaXamlMount(host, 'OperationActiveListView', () => {
    const car = o.car;
    let port = '';
    if (typeof webBus === 'object' && webBus && webBus.connected)
      port = typeof webBus.portLabel === 'function' ? webBus.portLabel() : '';
    const rows = car
      ? [
          {
            Number: 1,
            DataContext: {
              VecInfo: { VIN17: car.vin || '', VCI: { DevId: port } },
            },
            car,
          },
        ]
      : [];
    if (picked && !rows.includes(picked)) picked = rows[0] || null;
    const one = picked || (rows.length === 1 ? rows[0] : null);
    return {
      data: { Logic: { IstaOperationController: { Operations: rows } } },
      resources: { OperationsCollectionViewSource: rows },
      empty: {
        operationsListView:
          'No vehicle is open. Start one on Operations / New.',
      },
      cells: {
        operationsListView: {
          '#Color': () => `<i class="ixdot ixdot-op"></i>`,
          '#BasicFeatures': (r) =>
            esc(
              typeof garageCarLabel === 'function'
                ? garageCarLabel(r.car)
                : r.car.label || ''
            ),
        },
      },
      select: (name, r) => {
        picked = r;
        api.chrome();
      },
      commands: {
        CommandAcceptIstaOperation: one
          ? () => istaGo('information', 'details', null)
          : null,
        CommandCloseIstaOperation: one
          ? () => {
              istaSetCar(null);
              return istaGo('operations', 'new', 'vin');
            }
          : null,
      },
    };
  });
  return !!api;
}

// ---- Service plan / Hit list ------------------------------------------------

/**
 * Hit list, from HitListView.
 *
 * The documents each stored fault points at, grouped under the fault. The
 * view has no Priority column (that is the test plan's) and its own button
 * row: Show completely here, where the plan has Show symptoms.
 * @param {HTMLElement} host - where to draw
 * @param {object} o - {car, chassis}
 * @returns {Promise<boolean>} false when the template is not in this build
 */
async function istaXamlHitList(host, o) {
  const api = await istaXamlHitView(host, {
    load: async () => {
      const groups = await istaPlanGroups('hit-list', o.car);
      const items = [];
      for (const g of groups)
        for (const r of g.rows || [])
          items.push({
            XepInfoObject: { InfoType: r.type || '-', AwNummer: '' },
            Title: r.title || '',
            State: r.state || 'none',
            group: g.title,
            key: r._doc,
            row: r,
          });
      return items;
    },
    grouped: true,
    empty:
      'No stored fault on this vehicle points at a document in this build.',
    back: () => showIsta('information', 'details', null),
    open: (it) => istaOpenPlanDoc(it.row),
  });
  return !!api;
}

/**
 * HitListView over any list of documents.
 *
 * The tool uses this one view for two things: the documents the stored
 * faults point at, and what a text search found -- which is why its first
 * button is Back, to the page the list was reached from.
 * @param {HTMLElement} host - where to draw
 * @param {object} o - the list
 * @param {() => Promise<object[]>|object[]} o.load - the rows, each with
 *   XepInfoObject, Title, State and a stable `key`
 * @param {boolean} [o.grouped] - rows carry a `group` to head them with
 * @param {string} o.empty - what an empty list says
 * @param {() => void} o.back - the Back button
 * @param {(item: object) => void} o.open - Display, and a double click
 * @returns {Promise<object|null>} the mounted page, or null with no template
 */
async function istaXamlHitView(host, o) {
  let picked = null;
  let expanded = false;
  const api = await istaXamlMount(host, 'HitListView', async () => {
    const items = [...(await o.load())];
    // the view counts what is listed against everything there is to list
    items.SourceCollection = items;
    picked = picked ? items.find((x) => x.key === picked.key) || null : null;
    return {
      data: {
        CollectionViewSource: { View: items },
        IsDocumentExportAllowed: false,
        IsAirActive: false,
        LogicData: {
          CurrentSearchResult: { InfoObjectFilter: { IsDefault: true } },
        },
      },
      empty: { hitListViewDataGrid: o.empty },
      groups: o.grouped
        ? {
            hitListViewDataGrid: (it) => ({
              key: it.group,
              cells: [it.group],
            }),
          }
        : null,
      cells: {
        hitListViewDataGrid: {
          columnType: (it) => esc(it.XepInfoObject.InfoType),
          '#Status': (it) => istaPlanStateCell(it.State),
        },
      },
      select: (name, it) => {
        picked = it;
        api.chrome();
      },
      commands: {
        CommandNavBackToSearchPage: o.back,
        CommandExpandView: items.length
          ? () => {
              expanded = !expanded;
              api.draw();
            }
          : null,
        // the button needs a pick; a double click brings its own row
        CommandDisplay: {
          off: !picked,
          run: (it) => o.open(it && it.XepInfoObject ? it : picked),
        },
      },
      after: (h) => {
        const table = h.querySelector('.ixtable');
        if (table) {
          table.classList.add('irplan');
          table.classList.toggle('ixfull', expanded);
        }
      },
    };
  });
  return api;
}

// ---- Vehicle information / Vehicle details ----------------------------------

/**
 * Vehicle details, from VehicleDetailsView.
 *
 * The view binds to the vehicle record's German field names (Baureihe,
 * Ereihe, Getriebe ...). Every value is the one the hand-built grid already
 * works out (istaDetailColumns), filed under the name the view asks for, so
 * the two faces cannot disagree about the car. In this version of the tool
 * the equipment lists are part of this page, under the grid.
 *
 * NOTHING IS READ ON ARRIVAL. The option list is the one a read left on the
 * Garage record, and is empty until one has been made.
 * @param {HTMLElement} host - where to draw
 * @param {object} o - {car, chassis}
 * @returns {Promise<boolean>} false when the template is not in this build
 */
async function istaXamlDetails(host, o) {
  const car = o.car;
  const names =
    typeof VehicleIdentity === 'object' &&
    VehicleIdentity &&
    typeof VehicleIdentity.saName === 'function'
      ? VehicleIdentity.saName
      : null;
  if (names && typeof loadSaNames === 'function')
    await istaProbe(() => loadSaNames());
  if (!host.isConnected) return true;
  const api = await istaXamlMount(host, 'VehicleDetailsView', () => {
    const cols = istaDetailColumns(car, istaState.etk, {});
    /** @type {Object<string, string>} label -> value */
    const by = {};
    for (const [label, value] of cols.flat())
      by[String(label).replace(/:$/, '')] = value || '';
    const construction = String(by['Construction date'] || '').split(' / ');
    const date = car && car.prod ? Number(String(car.prod).padEnd(8, '0')) : 0;
    const options = ((car && car.sa) || [])
      .filter((c) => /^[0-9A-Z]{3,4}$/.test(String(c)))
      .map((c) => ({ Id: c, Title: names ? names(c, date) || '' : '' }));
    const tested =
      !!car &&
      typeof garageScans === 'function' &&
      (garageScans(car.id) || []).some((s) => s.kind === 'faults');
    const text = (v) => (v == null || v === '' ? undefined : v);
    return {
      data: {
        ShowDefaultTechnicalCampaign: true,
        IsToyota: false,
        IsTherapyPlanCmdVisible: false,
        LogicData: {
          VecInfo: {
            Prodart: 'P',
            VIN17: by.VIN,
            Baureihe: by.Series,
            Ereihe: by['Development code'],
            VerkaufsBezeichnung: by['Sales designation'],
            Gwsz: text(by.Mileage),
            Motor: by.Engine,
            Getriebe: by.Gearbox,
            Antrieb: by['Drive type'],
            MOTBezeichnung: by['Engine label'],
            ProductionDate: by['Production date'],
            Modelljahr: construction[0] || '',
            Modellmonat: construction[1] || '',
            Karosserie: by.Body,
            Lenkung: by.Steering,
            Typ: by['Model code'],
            BaseVersion: by['Basic version'],
            FA: { POLSTER: by['Upholstery code'], LACK: by['Paint code'] },
            Pannenfall: istaState.breakdown,
            TechnicalCampaigns: [],
          },
        },
      },
      resources: { SaItems: options, SaDealerItems: [] },
      converters: {
        VehicleCharacteristicsConverter: text,
        VinConverter: (v) => (v && v[0]) || '-',
        DateConverter: text,
        FirstRegistrationConverter: (v) => text(v) || '-',
        ProgmanVersionConverter: (v) => text(v) || '-',
        TechnicalActionStateConverter: (v) => v,
        ProductTypeInVisibilityConverter: (v, p) =>
          String(p || '').includes(String(v || 'P')),
        NullableBooleanConverter: (v, p) =>
          v != null && String(v) === String(p),
        // one slot, two buttons: Start before a test has run, Show after
        VehicleTestButtonConverter: (v, p) => (p === 'SHOW') === tested,
      },
      commands: {
        CommandStartVehicleTest: () => istaOpenVehicleTest(),
        CommandNav2: () => istaGo('information', 'tree', null),
        CommandNav31: () =>
          istaGo('management', 'troubleshooting', 'text-search'),
        CommandPannenfall: (answer) => {
          istaState.breakdown = answer === 'true';
        },
      },
      after: (h) => {
        const root = h.querySelector('.ixaml');
        if (root) root.classList.add('ixdetails');
      },
    };
  });
  // THE CATALOGUE DECODE MAY LAND AFTER THE PAGE. Body, steering and gearbox
  // come from it, and it is fetched when the car is picked -- on a reload
  // that is the same moment this page draws. It is a lookup, not a read, so
  // waiting for it and drawing again costs the car nothing.
  if (
    api &&
    car &&
    car.vin &&
    !istaState.etk &&
    typeof viEtkDecode === 'function'
  )
    viEtkDecode(car.vin)
      .then((e) => {
        if (istaState.car !== car) return;
        if (!istaState.etk) istaState.etk = e;
        api.draw();
      })
      .catch(() => {
        /* the parts index is optional */
      });
  return !!api;
}

// ---- Operations / New / VIN -------------------------------------------------

/**
 * Operations / New / VIN, from VinInputView, with the Garage under it.
 *
 * The view is the tool's: one box and Open operation. THE GARAGE LIST IS
 * OURS and is kept on purpose: the tool finds a car it has seen before under
 * Operations / Finished, and this build's Finished list is per car, so
 * without the list a saved car could only be reopened by retyping its VIN.
 * Picking a row fills the box, so the two cannot name different cars.
 * @param {HTMLElement} host - where to draw
 * @param {object} o - {open(car, vin)}
 * @returns {Promise<boolean>} false when the template is not in this build
 */
async function istaXamlVin(host, o) {
  const cars = typeof garageCars === 'function' ? garageCars() : [];
  const state = { VIN: '' };
  let picked = null;
  const ready = () => picked != null || istaVinOk(state.VIN);
  const go = () => o.open(picked, state.VIN);
  const api = await istaXamlMount(host, 'VinInputView', () => ({
    data: { VIN: state.VIN },
    set: (path, value) => {
      state.VIN = value;
      // typing is a different intent from picking: let go of the row so the
      // two cannot disagree about which car Open operation means
      if (picked && String(value).toUpperCase() !== String(picked.vin)) {
        picked = null;
        host.querySelectorAll('.irvin-garage tr.sel').forEach((r) => {
          r.classList.remove('sel');
        });
      }
      api.chrome();
    },
    commands: { CommandVinVehicleData: ready() ? go : null },
    after: (h) => {
      const root = h.querySelector('.ixaml');
      const box = h.querySelector('input');
      if (!root || !box) return;
      root.classList.add('ixvin');
      box.onkeydown = (e) => {
        if (e.key === 'Enter' && ready()) go();
      };
      const rows = cars
        .map((c) => {
          const scans =
            typeof garageScans === 'function' ? garageScans(c.id) : [];
          const when = scans.length ? String(scans[0].at).slice(0, 10) : '-';
          const name =
            typeof garageCarLabel === 'function' ? garageCarLabel(c) : c.label;
          return (
            `<tr data-car="${esc(c.id)}"><td>${istaVal(c.vin)}</td>` +
            `<td>${istaVal(name)}</td><td>${esc(when)}</td></tr>`
          );
        })
        .join('');
      const garage = document.createElement('div');
      garage.className = 'irvin-garage';
      garage.innerHTML =
        `<h3>Garage</h3><table class="irtable"><thead><tr>` +
        `<th>VIN</th><th>Vehicle</th><th>Last scan</th>` +
        `</tr></thead><tbody>${rows}</tbody></table>` +
        (rows
          ? ''
          : `<div class="irvin-empty">No vehicles saved yet. Type a VIN ` +
            `above, or read one off the car on Read Out Vehicle Data.</div>`);
      root.appendChild(garage);
      garage.querySelectorAll('tr[data-car]').forEach((tr) => {
        const car = cars.find((c) => c.id === tr.dataset.car) || null;
        tr.onclick = () => {
          garage.querySelectorAll('tr.sel').forEach((r) => {
            r.classList.remove('sel');
          });
          tr.classList.add('sel');
          picked = car;
          if (car && car.vin) {
            state.VIN = car.vin;
            box.value = car.vin;
          }
          api.chrome();
        };
        tr.ondblclick = () => {
          if (car) o.open(car, car.vin || '');
        };
      });
      if (box.focus) box.focus();
    },
  }));
  // the shell's Open operation path asks for these when it fires
  host._istaPick = () => ({ car: picked, vin: state.VIN });
  return !!api;
}

// ---- Operations / New / Read Out Vehicle Data --------------------------------

/**
 * Read Out Vehicle Data, from StartVehicleTestView.
 *
 * The view is two instructions and the identification buttons. BOTH BUTTONS
 * READ THE CAR, so both need a cable: with none connected they are off
 * rather than offering a read that can only fail, and the status line says
 * which interface the build sees. (The tool shows its interfaces in a
 * connection dialog; the status line is where this build has room for it.)
 * @param {HTMLElement} host - where to draw
 * @returns {Promise<boolean>} false when the template is not in this build
 */
async function istaXamlReadout(host) {
  let label = '';
  let connected = false;
  const page = await istaXamlMount(host, 'StartVehicleTestView', () => ({
    data: {
      BrandVisibilityPKW: true,
      BrandVisibilityNoPKW: false,
      IsProgrammingAndStartWithMeasurePlanEnabled: false,
      IsIdentifyVehicleAllowed: true,
    },
    commands: {
      // Complete identification IS the vehicle test: it reads the car
      CommandReadVehicleDataWithTest: connected
        ? () => istaOpenVehicleTest()
        : null,
      CommandReadVehicleData: connected
        ? () => istaGo('information', 'details', null)
        : null,
    },
    extra: {
      items: [
        {
          k: 'Vehicle interface:',
          v: `${label || 'none'} (${connected ? 'connected' : 'not connected'})`,
        },
      ],
    },
  }));
  if (!page) return false;
  try {
    const st = await api('/api/state');
    connected = !!st.connected;
    label = st.port || '';
  } catch (e) {
    /* no engine: the page still draws, as "not connected" */
  }
  if (!label && typeof webBus === 'object' && webBus && webBus.connected)
    label = webBus.portLabel();
  if (host.isConnected) page.chrome();
  return true;
}

// ---- Troubleshooting / Text Search -------------------------------------------

/**
 * Every document in the loaded diagnosis structures a search string finds.
 * @param {Object<string, object|null>} data - structure id -> its tree
 * @param {string} query - what was typed
 * @param {object} scopes - {structures, title, number, document}
 * @param {Map<string, string>|null} [bodies] - document id -> body text
 * @returns {Array<{doc: object, where: string, path: string}>} at most 500
 */
function istaDiagSearchHits(data, query, scopes, bodies) {
  const q = String(query || '')
    .trim()
    .toLowerCase();
  if (q.length < 2) return [];
  const hits = [];
  const seen = new Set();
  const has = (v) =>
    String(v || '')
      .toLowerCase()
      .includes(q);
  const walk = (n, trail, where) => {
    const here = trail.concat([n.label || '']);
    for (const d of n.docs || []) {
      if (hits.length >= 500) return;
      const key = `${where}:${d.id}`;
      if (seen.has(key)) continue;
      const found =
        (scopes.title && has(d.title)) ||
        (scopes.structures && has(here.join(' > '))) ||
        (scopes.number && has(d.id)) ||
        (scopes.document && bodies && has(bodies.get(String(d.id))));
      if (!found) continue;
      seen.add(key);
      hits.push({ doc: d, where, path: here.join(' > ') });
    }
    for (const k of n.kids || []) walk(k, here, where);
  };
  for (const [where, tree] of Object.entries(data || {})) {
    const roots = !tree
      ? []
      : Array.isArray(tree)
        ? tree
        : Array.isArray(tree.tree)
          ? tree.tree
          : Array.isArray(tree.kids)
            ? tree.kids
            : [];
    for (const r of roots) walk(r, [], where);
  }
  return hits;
}

/**
 * Troubleshooting / Text Search, from FullTextSearchView.
 *
 * The form is the page; what a search finds is shown in the HIT LIST, which
 * is where the tool puts it, and the hit list's Back comes back to the form
 * with the string and the ticks as they were left.
 * @param {HTMLElement} host - where to draw
 * @param {object} o - {data, open(hit), loadBodies()}
 * @returns {Promise<boolean>} false when a template is not in this build
 */
async function istaXamlDiagSearch(host, o) {
  const state = {
    SearchString: '',
    SelectStructures: true,
    SelectTitel: true,
    SelectContent: false,
    SelectIdentifikator: false,
  };
  /** @type {Map<string, string>|null} */
  let bodies = null;
  let form = null;

  const search = async () => {
    const hits = istaDiagSearchHits(
      o.data,
      state.SearchString,
      {
        structures: state.SelectStructures,
        title: state.SelectTitel,
        number: state.SelectIdentifikator,
        document: state.SelectContent,
      },
      bodies
    );
    const shown = await istaXamlHitView(host, {
      load: () =>
        hits.map((h) => ({
          XepInfoObject: { InfoType: h.doc.type || '-', AwNummer: '' },
          Title: h.doc.title || '',
          State: 'none',
          key: `${h.where}:${h.doc.id}`,
          hit: h,
        })),
      empty: `Nothing matched "${state.SearchString.trim()}".`,
      back: () => form.draw(),
      open: (it) => o.open(it.hit),
    });
    if (!shown) form.draw();
  };

  form = await istaXamlMount(host, 'FullTextSearchView', () => ({
    data: {
      ...state,
      IsStructureSearchAvailable: true,
      CheckBoxTextFulltextSearchVisibility: true,
    },
    set: (path, value) => {
      state[path] = value;
      // ticking the body scope is what asks for its index: the blob is
      // worth fetching only when the reader actually wants it
      if (path === 'SelectContent' && value && !bodies && o.loadBodies)
        Promise.resolve(o.loadBodies())
          .then((m) => {
            bodies = m || new Map();
          })
          .catch(() => {
            /* the index is optional */
          });
      form.chrome();
    },
    commands: {
      CommandFullTextSearch:
        state.SearchString.trim().length >= 2 ? search : null,
    },
    extra: { items: [{ k: 'Hits:', v: '0 / 0' }] },
    after: (h) => {
      const root = h.querySelector('.ixaml');
      if (root) root.classList.add('ixsearch');
      const box = h.querySelector('input[type="text"]');
      if (box && box.focus) box.focus();
    },
  }));
  return !!form;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    istaXamlCulture,
    istaXamlFaultMemory,
    istaFaultRelevant,
    istaFaultFilterDefault,
    istaFaultCursorStep,
    istaFaultGraphSvg,
    istaXamlFaultFilter,
    istaQuickDelete,
    istaCalcPlanAll,
    istaXamlTestPlan,
    istaXamlBasic,
    istaXamlMount,
    istaXamlUnitList,
    istaSaeLookup,
    istaXamlSae,
    istaXamlActive,
    istaXamlHitList,
    istaXamlDetails,
    istaXamlHitView,
    istaXamlVin,
    istaXamlReadout,
    istaDiagSearchHits,
    istaXamlDiagSearch,
  };
}
