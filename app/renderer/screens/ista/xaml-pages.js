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
   istaXamlReadout istaXamlDiagSearch istaDiagSearchHits
   istaXamlBrowsePanes istaBrowseLeft istaBrowseRight istaBrowseNodes
   istaBrowseShell */

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
 * @param {object} [opts] - passed to istaXamlParts
 * @returns {Promise<{parts: object, strings: object}|null>} null when this
 *   build does not ship the template
 */
async function istaXamlOpen(view, opts) {
  const [tpl, strings, fallback] = await Promise.all([
    istaXamlLoad(view),
    istaXamlStrings(istaXamlCulture()),
    istaXamlStrings('en-GB'),
  ]);
  if (!tpl || !tpl.root) return null;
  return {
    parts: istaXamlParts(tpl, opts),
    strings: strings || fallback || {},
  };
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
  let rows = istaXamlButtons(parts.buttons, ctx);
  // a page may reshape its row (the browser's two resize buttons are the
  // bottom bar's centred arrow pair)
  if (typeof ctx.buttons === 'function') rows = ctx.buttons(rows);
  istaRealBottom(rows.length ? rows : null);
}

// ---- Troubleshooting / Fault memory -----------------------------------------

/** @type {Map<string, Promise<object|null>>} ECU variant -> its fault codes */
const istaFaultCodeTables = new Map();

/**
 * What ISTA's database says about one ECU variant's fault codes, or null
 * when this build ships nothing for it: {"<code, decimal>": [weighting,
 * relevance]} (tools/ista/faultcodes_extract.py).
 * @param {string} sgbd - the variant, as the app keys a module (ms450ds0)
 * @returns {Promise<object|null>}
 */
function istaFaultCodes(sgbd) {
  const key = String(sgbd || '').toLowerCase();
  if (!key) return Promise.resolve(null);
  if (!istaFaultCodeTables.has(key))
    istaFaultCodeTables.set(
      key,
      typeof hfFetchFirst === 'function'
        ? hfFetchFirst(`ista/faultcodes/${key}.json`).catch(() => null)
        : Promise.resolve(null)
    );
  return istaFaultCodeTables.get(key);
}

/**
 * A fault's location number: what the module reported, which is what ISTA's
 * database keys a fault code by.
 *
 * It is a number on the wire and decimal in the database; the hex a screen
 * shows is a rendering of the same number, and is what is read back when a
 * module's answer did not carry the number itself.
 * @param {object} row - a fault row (`raw.F_ORT_NR`, `code`)
 * @returns {number|null}
 */
function istaFaultOrt(row) {
  const raw = (row && row.raw) || {};
  const ort = Number(raw.F_ORT_NR);
  if (raw.F_ORT_NR != null && raw.F_ORT_NR !== '' && Number.isFinite(ort))
    return ort;
  const hex = parseInt(String((row && row.code) || ''), 16);
  return Number.isFinite(hex) ? hex : null;
}

/** @type {Map<string, Promise<object|null>>} chassis -> its plan links */
const istaTestPlanTables = new Map();

/**
 * What ISTA's test plan calculation reads for a chassis, or null when this
 * build does not ship it: the diagnosis objects each fault code points at,
 * every info object linked to each object, and the objects beneath it
 * (tools/ista/testplan_extract.py).
 * @param {string} chassis - e.g. 'E46'
 * @returns {Promise<object|null>}
 */
function istaTestPlanData(chassis) {
  const key = String(chassis || '').toUpperCase();
  if (!key) return Promise.resolve(null);
  if (!istaTestPlanTables.has(key))
    istaTestPlanTables.set(
      key,
      typeof hfFetchFirst === 'function'
        ? hfFetchFirst(`ista/testplan/${key}.json.gz`, { as: 'gzjson' }).catch(
            () => null
          )
        : Promise.resolve(null)
    );
  return istaTestPlanTables.get(key);
}

/**
 * The validity check for one car: does a shipped rule hold for it?
 *
 * THE EXTRACT IS CUT PER CHASSIS, AND A CHASSIS IS THE UNION OF ITS BUILDS.
 * "An M54 or an N42" is true of an E46 and false of any one E46, so a rule
 * that passed the extractor is decided again here against the car's own
 * characteristic ids, build date and options -- which is the question the
 * tool asks (EvaluateXepRulesById against the vehicle). Three-valued as
 * everywhere: no rule holds, a rule the car's facts cannot decide holds,
 * only a decided no drops. With no car to ask, everything holds.
 * @param {object|null} car - the picked car
 * @param {string} chassis - its chassis
 * @returns {Promise<(rule: object|undefined) => boolean>}
 */
async function istaCarRuleCheck(car, chassis) {
  const always = () => true;
  if (!car || typeof techDataRuleApplies !== 'function') return always;
  const keys = await istaProbe(() =>
    typeof techDataCarKeys === 'function' ? techDataCarKeys(car, chassis) : null
  );
  if (!keys || !keys.ids || !keys.ids.size) return always;
  const facts =
    typeof techDataVehicleFacts === 'function'
      ? (await istaProbe(() => techDataVehicleFacts(car, chassis))) || {}
      : {};
  return (rule) => !rule || techDataRuleApplies(rule, keys.ids, facts);
}

/**
 * Open a plan row's document.
 *
 * A plan lists every kind of document the tool links to a component. A
 * wiring diagram (SSP) lives in the wiring extract and the rest in the
 * diagnosis documents, so each is asked for where it lives first and in the
 * other place second, before the page says the body is not in this build.
 * @param {string} chassis - the chassis
 * @param {{id: number, title: string, type: string}} doc - the document
 * @returns {Promise<void>}
 */
async function istaOpenPlanDiag(chassis, doc) {
  if (!doc) return;
  const wiring = () =>
    typeof istaWiringDocHtml === 'function'
      ? istaProbe(() => istaWiringDocHtml(chassis, doc.id))
      : null;
  const html = doc.type === 'SSP' ? await wiring() : null;
  if (!html) {
    // the diagnosis documents first for everything that is not a diagram;
    // a body they do not hold may still be a diagram filed under another type
    const body = await istaProbe(() => istaDiagBody(chassis, doc));
    const missing = !body || /not in this build/i.test(String(body));
    const other = missing && doc.type !== 'SSP' ? await wiring() : null;
    if (!other) return istaOpenDiagDoc(chassis, doc);
    return istaPlanDocModal(doc, other);
  }
  return istaPlanDocModal(doc, html);
}

/**
 * Show a document body in the shell's document dialog.
 * @param {{title: string, type: string}} doc - what it is
 * @param {string} html - its body
 * @returns {void}
 */
function istaPlanDocModal(doc, html) {
  if (typeof openModal !== 'function') return;
  const { overlay, close } = openModal(
    `<div class="modal irdoc" role="dialog" aria-modal="true">` +
      `<div class="irdoc-title">${esc(
        `${doc.type || ''} ${doc.title || ''}`.trim()
      )}</div>` +
      `<div class="irdoc-body ista-repair">${html}</div>` +
      `<div class="modal-actions">` +
      `<button type="button" class="btn irdoc-close">Close</button>` +
      `</div></div>`
  );
  overlay.querySelector('.irdoc-close').onclick = () => close();
}

/**
 * The plan rows for a list of faults, from the tool's own links.
 *
 * A PORT OF TestplanCalculator.ProcessDiagObjects over the rows
 * DatabaseProviderSQLite returns:
 *  - a fault is resolved by its location number under its ECU variant, and
 *    names the diagnosis objects it points at
 *  - EVERY info object linked to an object joins the plan under it: the
 *    documents (FUB, SSP ...) as well as the test modules (ABL)
 *  - an object with no test module of its own is descended first: its
 *    children's info objects join the plan under the children
 *  - there is one row per (object, info object), however many faults lead
 *    to it; each fault that pointed at the object itself is remembered on
 *    its rows, which is what the ranking counts
 * A child reached by descent carries no fault of its own, so it ranks after
 * every object a fault named.
 * @param {object} data - istaTestPlanData output
 * @param {object[]} faults - fault rows the calculation follows
 * @param {(rule: object|undefined) => boolean} [ok] - the car's validity
 *   check (istaCarRuleCheck); everything holds without one
 * @returns {object[]} plan rows, in the order the tool adds them
 */
function istaPlanExact(data, faults, ok) {
  const holds = ok || (() => true);
  /** @type {Map<string, object>} "object:info" -> its row */
  const by = new Map();
  const objects = (data && data.objects) || {};
  const infos = (data && data.infos) || {};
  const walk = (ids, link, path) => {
    for (const oid of ids || []) {
      const o = objects[String(oid)];
      if (!o || !o.t || !o.i || path.includes(oid)) continue;
      // not valid for this car: the object, and everything under it, is out
      if (!holds(o.r)) continue;
      const own = o.i
        .map((i) => [i, infos[String(i)]])
        .filter(([, x]) => x && holds(x.r));
      if (own.every(([, x]) => x.y !== 'ABL'))
        walk(o.k, null, path.concat([oid]));
      for (const [iid, x] of own) {
        const key = `${oid}:${iid}`;
        if (!by.has(key))
          by.set(key, {
            key,
            // a test module is opened by its identifier, a document by its id
            id: x.y === 'ABL' && x.n ? x.n : `DIAG-${iid}`,
            type: x.y || '-',
            title: x.t || x.n || '',
            component: o.t,
            group: String(oid),
            priority: 0,
            state: 'none',
            fault: link ? link.label : '',
            diag:
              x.y === 'ABL' ? null : { id: Number(iid), title: x.t, type: x.y },
            links: [],
          });
        if (link) by.get(key).links.push(link);
      }
    }
  };
  for (const f of faults || []) {
    const ort = istaFaultOrt(f);
    if (ort == null || !f.sgbd) continue;
    const fkey = `${String(f.sgbd).toLowerCase()}:${ort}`;
    const hit = data.faults[fkey];
    if (!hit || !holds((data.faultRules || {})[fkey])) continue;
    walk(
      hit,
      {
        fault: `${f.sgbd}:${ort}`,
        label: f.code || '',
        weight: f.meta ? f.meta.weight : null,
        present: istaFaultPresent(f),
      },
      []
    );
  }
  return [...by.values()];
}

/**
 * Add the plan rows of the selected fault patterns, from the tool's links.
 *
 * A PORT OF TestplanCalculator.CollectInfoObjectsForTestplan and
 * ProcessDiagObjectsForSymptom:
 *  - a symptom names diagnosis objects the way a fault code does; every info
 *    object of each joins the plan under it
 *  - beneath a symptom's object the tool ALWAYS descends, test module or
 *    not, and the children's info objects join under the children
 *  - the symptoms beneath the picked one are collected the same way
 *  - every object reached is given priority F -- and it is the OBJECT that
 *    carries it, so a row a stored fault had already put under that object
 *    becomes F as well
 * @param {object} data - istaTestPlanData output
 * @param {Array<{id: number, label: string}>} patterns - the picked symptoms
 * @param {Map<string, object>} by - "object:info" -> row, added to in place
 * @param {(rule: object|undefined) => boolean} [ok] - the car's validity
 *   check (istaCarRuleCheck)
 * @returns {void}
 */
function istaPlanPatternsExact(data, patterns, by, ok) {
  const holds = ok || (() => true);
  const objects = (data && data.objects) || {};
  const infos = (data && data.infos) || {};
  const links = (data && data.symptoms) || {};
  /** @type {Set<string>} the objects a pattern reached */
  const marked = new Set();
  const walk = (ids, label, path) => {
    for (const oid of ids || []) {
      const o = objects[String(oid)];
      if (!o || path.includes(oid) || !holds(o.r)) continue;
      marked.add(String(oid));
      if (!o.t || !o.i) continue;
      for (const iid of o.i) {
        const x = infos[String(iid)];
        if (!x || !holds(x.r)) continue;
        const key = `${oid}:${iid}`;
        if (!by.has(key))
          by.set(key, {
            key,
            id: x.y === 'ABL' && x.n ? x.n : `DIAG-${iid}`,
            type: x.y || '-',
            title: x.t || x.n || '',
            component: o.t,
            group: String(oid),
            priority: 'F',
            state: 'none',
            fault: label,
            diag:
              x.y === 'ABL' ? null : { id: Number(iid), title: x.t, type: x.y },
            links: [],
          });
      }
      walk(o.k, label, path.concat([oid]));
    }
  };
  /** The symptom's node in the shipped trees, to reach the ones beneath it. */
  const find = (nodes, id) => {
    for (const n of nodes || []) {
      if (n.id === id) return n;
      const hit = find(n.kids, id);
      if (hit) return hit;
    }
    return null;
  };
  const collect = (node, id, label) => {
    walk(links[String(id)], label, []);
    for (const k of (node && node.kids) || [])
      if (holds(k.r)) collect(k, k.id, k.label);
  };
  for (const p of patterns || [])
    collect(find(data.trees, p.id), p.id, p.label);
  for (const row of by.values())
    if (marked.has(String(row.group))) row.priority = 'F';
}

/**
 * A fault's verdict and weighting, as the tool resolves them when it reads
 * the fault memory (VehicleIdent.doECUReadFS).
 *
 * THREE ANSWERS, AND THE THIRD IS NOT A NO. A code the variant's table
 * lists is relevant unless RELEVANCE is 0. A code it does not list has no
 * verdict (null): the tool still SHOWS such a fault, but it never enters the
 * test plan. With no table for the variant at all, `known` is false so a
 * caller can tell "ISTA has no verdict" from "this build has no data".
 * @param {object} row - a fault row (`raw.F_ORT_NR`, `code`)
 * @param {object|null} table - the variant's fault codes
 * @returns {{known: boolean, relevance: boolean|null, weight: number|null}}
 */
function istaFaultMeta(row, table) {
  if (!table) return { known: false, relevance: null, weight: null };
  const code = istaFaultOrt(row);
  const hit = code == null ? null : table[String(code)];
  if (!hit) return { known: true, relevance: null, weight: null };
  return { known: true, relevance: hit[1] !== 0, weight: hit[0] };
}

/**
 * Whether a fault is present right now, as the plan's ranking reads it.
 *
 * A PORT OF THE TEST IN TestplanCalculator.CalculatePriorityNew, which
 * reads the status number rather than its text: for a fault memory of
 * version 3, bit 0 set and bit 6 clear; for version 2, a status of hex 22 or
 * 23. Anything else is not present. Where a module reports neither number,
 * the status text the fault table shows is used instead.
 * @param {object} row - a fault row (`raw`, `present`)
 * @returns {boolean}
 */
function istaFaultPresent(row) {
  const raw = (row && row.raw) || {};
  const nr = Number(raw.F_VORHANDEN_NR);
  const ver = Number(raw.F_VERSION);
  const has = (v) => v != null && v !== '';
  if (has(raw.F_VORHANDEN_NR) && has(raw.F_VERSION) && Number.isFinite(nr)) {
    if (ver === 3) return (nr & 1) === 1 && (nr & 0x40) === 0;
    if (ver === 2) return nr === 0x23 || nr === 0x22;
    return false;
  }
  return !!(row && row.present);
}

/**
 * What the Existent column says for a fault: yes, No or unknown.
 *
 * A PORT OF Fault.SetExisting. The answer is read off the status NUMBER and
 * depends on the fault memory's protocol; anything the tables below do not
 * list -- and every fault of the oldest (DS2) modules, which report no such
 * number -- is "unknown", which is the tool's own word for it:
 *   KWP (fault memory version 2)   34, 35 yes; 32, 33 no
 *   UDS (version 3)                5, 9, 13, 33, 37, 41, 45 yes;
 *                                  4, 8, 12, 32, 36, 40, 44 no
 * A virtual fault (a control unit that did not answer) is always yes.
 * @param {object} row - a fault row (`raw`, `virtual`)
 * @param {object} [strings] - ISTA's string table, for the three words
 * @returns {string}
 */
function istaFaultExisting(row, strings) {
  const word = (key) => istaXamlText({ strings: strings || {} }, key);
  if (row && row.virtual) return word('#YesSmall');
  const raw = (row && row.raw) || {};
  const has = (v) => v != null && v !== '';
  const nr = Number(raw.F_VORHANDEN_NR);
  if (!has(raw.F_VORHANDEN_NR) || !Number.isFinite(nr))
    return word('#UnknownSmall');
  const ver = Number(raw.F_VERSION);
  const yes = ver === 3 ? [5, 9, 13, 33, 37, 41, 45] : [34, 35];
  const no = ver === 3 ? [4, 8, 12, 32, 36, 40, 44] : [32, 33];
  if (ver !== 2 && ver !== 3) return word('#UnknownSmall');
  if (yes.includes(nr)) return word('#YesSmall');
  if (no.includes(nr)) return word('#NoSmall');
  return word('#UnknownSmall');
}

/**
 * How two components rank against each other in the test plan.
 *
 * A PORT OF MainPriorityCalculator.DiagObjectPriorityComparer: by how many
 * faults point at the component with sure suspicion, then strong, middle
 * and low weighting, and last by whether any of those faults is present.
 * @param {object} x - {sure, strong, middle, low, present}
 * @param {object} y - the same
 * @returns {number} negative, zero or positive
 */
function istaPlanCompare(x, y) {
  for (const k of ['sure', 'strong', 'middle', 'low']) {
    const d = Math.sign((x[k] || 0) - (y[k] || 0));
    if (d) return d;
  }
  if (!!x.present !== !!y.present) return x.present ? 1 : -1;
  return 0;
}

/**
 * Give every row of a calculated plan its component's priority.
 *
 * A PORT OF TestplanCalculator.CalculatePriorityNew followed by
 * MainPriorityCalculator.Calculate:
 *  - every fault counts ONCE toward each component it is linked to, in the
 *    bucket its weighting names (100 sure, 75 strong, 50 middle, 25 low);
 *    a component is "present" when one of its faults is
 *  - the rows are ordered by their component, strongest first; the first
 *    component gets priority 3 and the number goes up by one each time the
 *    ranking changes, so components that rank the same share a priority
 *  - a row already marked suspected reads a tenth lower than its peers
 *    (from the second row on: the first always gets the plain number)
 *  - a component added from a fault pattern (F) or by hand (M) keeps that
 *    letter and is never renumbered
 * @param {object[]} rows - plan rows: {component, state, priority, links}
 *   where `links` is [{fault, weight, present}], the faults that led to it
 * @returns {object[]} the same rows, `priority` set, strongest first
 */
function istaPlanPrioritise(rows) {
  /** @type {Map<string, object>} component -> its counts */
  const by = new Map();
  const bucket = { 100: 'sure', 75: 'strong', 50: 'middle', 25: 'low' };
  for (const r of rows) {
    const key = r.group || r.component || r.title || '-';
    if (!by.has(key))
      by.set(key, {
        sure: 0,
        strong: 0,
        middle: 0,
        low: 0,
        present: false,
        seen: new Set(),
      });
    const c = by.get(key);
    for (const l of r.links || []) {
      if (c.seen.has(l.fault)) continue;
      c.seen.add(l.fault);
      if (l.present) c.present = true;
      if (bucket[l.weight]) c[bucket[l.weight]]++;
    }
  }
  const of = (r) => by.get(r.group || r.component || r.title || '-');
  const fixed = (r) => r.priority === 'F' || r.priority === 'M';
  const out = rows
    .map((r, i) => [r, i])
    .sort((a, b) => istaPlanCompare(of(b[0]), of(a[0])) || a[1] - b[1])
    .map(([r]) => r);
  let num = 3;
  /** @type {Map<object, number|string>} counts -> the priority they got */
  const given = new Map();
  out.forEach((r, i) => {
    if (fixed(r)) return;
    if (i > 0 && istaPlanCompare(of(out[i - 1]), of(r)) !== 0) num++;
    // the first row is given the plain number: the tool applies the
    // suspected tenth only from the second row on
    given.set(of(r), i > 0 && r.state === 'suspected' ? num + 0.1 : num);
  });
  for (const r of out) if (!fixed(r)) r.priority = given.get(of(r));
  return out;
}

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

  const api = await istaXamlMount(host, 'FaultMemoryView', async (page) => {
    const scan = istaNewestScan(car);
    const found = istaFaultRows(scan && scan.report);
    // what ISTA's database says about each module's codes; cached, so only
    // the first draw waits for it
    const sgbds = [...new Set(found.map((r) => r.sgbd).filter(Boolean))];
    const tables = {};
    await Promise.all(
      sgbds.map(async (sg) => {
        tables[sg] = await istaFaultCodes(sg);
      })
    );
    const all = found.map((r) => {
      const meta = istaFaultMeta(r, tables[r.sgbd] || null);
      const km = r.km === '' || r.km == null ? null : Number(r.km);
      // a module that stored anything with the fault has a current record,
      // whether or not that record carries a mileage
      const stored =
        km != null || Object.keys(r.raw || {}).some((k) => /^F_UW/.test(k));
      return {
        DTC: { FortAsHexString: r.code, F_UW_KM: r.km || '' },
        ECU: { TITLE_ECUTREE: r.module, VARIANTE: r.sgbd, BUS: '' },
        FaultLabel: r.desc,
        Existing: istaFaultExisting(r, page.strings),
        FaultClass: '-',
        meta,
        test: {
          relevance: meta.relevance,
          current: stored ? { km: Number.isFinite(km) ? km : null } : null,
          first: null,
          cls: '',
        },
        row: r,
      };
    });
    // A CONTROL UNIT THAT DID NOT ANSWER HAS A FAULT OF ITS OWN: the tool
    // files a virtual fault code under the unit's group ("S 0003 No
    // communication possible with: ...") and lists it with the rest. It has
    // no relevance verdict, so it is shown and never reaches the test plan.
    const plan = await istaTestPlanData(o.chassis);
    if (plan && plan.noAnswer) {
      const holds = await istaCarRuleCheck(car, o.chassis);
      for (const quiet of (scan && scan.report && scan.report.silent) || []) {
        const group = String((quiet && quiet.target) || '').toLowerCase();
        for (const v of plan.noAnswer[group] || []) {
          if (!holds(v.r)) continue;
          all.push({
            DTC: { FortAsHexString: v.c, F_UW_KM: '' },
            ECU: { TITLE_ECUTREE: quiet.label || group, VARIANTE: '', BUS: '' },
            FaultLabel: v.t,
            Existing: istaFaultExisting({ virtual: true }, page.strings),
            FaultClass: '-',
            meta: { known: true, relevance: null, weight: null },
            test: {
              relevance: null,
              current: { km: null },
              first: null,
              cls: '',
            },
            row: {
              code: v.c,
              desc: v.t,
              km: '',
              present: true,
              sgbd: '',
              module: quiet.label || group,
              // the extract's own row: stable across redraws, so a pick
              // survives them the way a real fault's does
              raw: v,
              virtual: true,
            },
          });
        }
      }
    }
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
          VecInfo: { PerceivedSymptoms: istaPatterns(car) },
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
        CmdCalculateTestplan:
          shown.length || istaPatterns(car).length
            ? async () => {
                const rows = await istaCalcPlanAll(
                  shown.map((x) => ({ ...x.row, meta: x.meta })),
                  car,
                  o.chassis,
                  istaPatterns(car)
                );
                istaPlanReplace(car, rows);
                if (!rows.length && typeof toast === 'function')
                  toast(
                    'No procedure is linked to these faults in this build.'
                  );
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
 * The test plan for a list of faults.
 *
 * AS TestplanCalculator.CalculateTestplan RUNS IT: only a fault the database
 * calls relevant is followed to its procedures -- one with no verdict stays
 * in the fault memory but adds nothing to the plan. Each procedure is listed
 * once, remembering every fault that led to it, and the components are then
 * ranked by those faults' weightings (istaPlanPrioritise).
 *
 * A fault whose module this build has no database extract for is followed
 * anyway: there the missing verdict means "no data here", not "ISTA has no
 * entry", and dropping it would empty the plan for want of a file.
 * @param {object[]} faults - fault rows, each with its `meta` (istaFaultMeta)
 * @param {object|null} car - the picked car
 * @param {string} chassis - its chassis
 * @param {object[]} [patterns] - the selected fault patterns (istaPatterns)
 * @returns {Promise<object[]>} plan rows, strongest component first
 */
async function istaCalcPlanAll(faults, car, chassis, patterns) {
  /** @type {Map<string, object>} procedure id -> its plan row */
  const by = new Map();
  // A FAULT PATTERN BRINGS ITS OWN DOCUMENTS, and its components are filed
  // under priority F ahead of everything a fault memory entry ranks
  // (TestplanCalculator.CollectInfoObjectsForTestplan): the symptom's own
  // documents, then those of every symptom beneath it.
  const collect = (node, title) => {
    for (const d of node.docs || []) {
      const id = `DIAG-${d.id}`;
      if (!by.has(id))
        by.set(id, {
          id,
          type: d.type || '-',
          title: d.title || '',
          component: title,
          priority: 'F',
          state: 'none',
          fault: title,
          diag: d,
          links: [],
        });
    }
    for (const k of node.kids || []) collect(k, title);
  };
  // WITH THE TOOL'S OWN LINKS, THE CALCULATION IS THE TOOL'S. Where the
  // build ships them for this chassis, faults and fault patterns are both
  // resolved through them and nothing else, in the tool's order: the
  // faults first, then the patterns. The index of test modules below is the
  // older, looser route for a chassis that has no such extract yet.
  const data = await istaTestPlanData(chassis);
  if (data && data.faults) {
    const relevant = faults.filter((f) => f.meta && f.meta.relevance === true);
    /** @type {Map<string, object>} "object:info" -> row */
    const rows = new Map();
    const ok = await istaCarRuleCheck(car, chassis);
    for (const row of istaPlanExact(data, relevant, ok)) rows.set(row.key, row);
    if (data.symptoms) istaPlanPatternsExact(data, patterns, rows, ok);
    return istaPlanPrioritise([...rows.values()]);
  }
  for (const p of patterns || []) if (p.node) collect(p.node, p.label);
  for (const f of faults) {
    const meta = f.meta || { known: false, relevance: null, weight: null };
    if (meta.known && meta.relevance !== true) continue;
    // where the database has the module's codes, only its own link for
    // this exact fault counts; without them the looser lookup still runs
    const found = await istaCalcPlan(f, car, chassis, { exact: meta.known });
    for (const row of found) {
      if (!by.has(row.id)) by.set(row.id, { ...row, links: [] });
      by.get(row.id).links.push({
        fault: `${f.sgbd}:${f.code}`,
        weight: meta.weight,
        present: istaFaultPresent(f),
      });
    }
  }
  return istaPlanPrioritise([...by.values()]);
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
    // F (fault pattern) and M (manual) come before every number
    const rank = (p) => (p === 'F' ? -2 : p === 'M' ? -1 : Number(p) || 0);
    const sorted = [...groups].sort(
      (a, b) =>
        (rank(a.priority) - rank(b.priority)) * (istaState.planDesc ? -1 : 1)
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
    const open = (it) =>
      it.row.diag
        ? istaOpenPlanDiag(o.chassis, it.row.diag)
        : istaOpenPlanRow(it.row, car, o.chassis, () => draw());

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
 * @param {object} [opts] - passed to istaXamlParts
 * @returns {Promise<object|null>} {draw, chrome}, or null when this build
 *   does not ship the template
 */
async function istaXamlMount(host, name, build, opts) {
  const view = await istaXamlOpen(name, opts);
  if (!view) return null;
  const api = {
    strings: view.strings,
    draw: async (chromeOnly) => {
      const ctx = await build(api);
      if (!host.isConnected || !ctx) return;
      ctx.strings = view.strings;
      const active =
        typeof document !== 'undefined' ? document.activeElement : null;
      // a box being typed in is found again by its place among the page's
      // boxes: the element is rebuilt by the draw and may carry no name
      const boxes = () => [...host.querySelectorAll('input, textarea')];
      const typing =
        !chromeOnly && active && host.contains(active)
          ? { at: boxes().indexOf(active), caret: active.selectionStart }
          : null;
      // WHERE THE READER HAD SCROLLED TO SURVIVES A REDRAW. A draw rebuilds
      // the page, so a click half-way down a long tree would otherwise
      // throw the reader back to its top; each scrolling pane is found
      // again by its place among the page's panes.
      const panes = () => [
        ...host.querySelectorAll('.ixtree, .ixscroll, .ixaml, .ixtable'),
      ];
      const scrolled = chromeOnly ? [] : panes().map((p) => p.scrollTop);
      istaXamlPaint(
        chromeOnly === true ? null : host,
        view.parts,
        ctx,
        ctx.extra
      );
      if (chromeOnly !== true && ctx.after) ctx.after(host);
      if (scrolled.some(Boolean))
        panes().forEach((p, i) => {
          if (scrolled[i]) p.scrollTop = scrolled[i];
        });
      if (typing && typing.at >= 0) {
        const again = boxes()[typing.at];
        if (again) {
          again.focus();
          if (typing.caret != null && again.setSelectionRange)
            again.setSelectionRange(typing.caret, typing.caret);
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

// ---- Troubleshooting / Fault pattern ----------------------------------------

/**
 * The fault patterns selected for a car: what the customer says is wrong,
 * in BMW's own vocabulary.
 *
 * They belong to the operation, as the tool has it: kept for as long as the
 * shell is up and never written to the Garage, because a complaint is about
 * this visit and not a fact about the car.
 * @param {object|null} car - the picked car
 * @returns {Array<{id: number, label: string, node: object}>} the live list
 */
function istaPatterns(car) {
  const key = car && car.id ? car.id : '-';
  if (!istaState.patterns || typeof istaState.patterns !== 'object')
    istaState.patterns = {};
  if (!Array.isArray(istaState.patterns[key])) istaState.patterns[key] = [];
  return istaState.patterns[key];
}

/**
 * The symptom tree as the view's nodes.
 *
 * WHICH NODES CAN BE PICKED is the tool's rule (PerceivedSymptomViewModel):
 * one the database marks SELECTABLE = 0 is a heading, and so is a root.
 * @param {object[]} nodes - the extract's nodes: {id, label, kids, sel}
 * @param {boolean} [root] - these are the tree's first level
 * @returns {object[]} {id, Title, Children, IsSelectable, node}
 */
function istaPatternNodes(nodes, root) {
  return (nodes || []).map((n) => ({
    id: n.id,
    Title: n.label || '',
    // not a root (by position, or by the type the database gives a root),
    // and not marked unselectable
    IsSelectable: n.sel !== 0 && !root && !/^Root/.test(n.vfc || ''),
    Children: istaPatternNodes(n.kids, false),
    node: n,
  }));
}

/**
 * Search the symptom tree: open the path to every symptom whose name holds
 * the string, and count the ones that can be picked.
 *
 * AS StartResultProcessing DOES IT: the tree is collapsed first, each hit's
 * ancestors are opened, and the number shown is of SELECTABLE hits -- a
 * heading that matches is opened but not counted. The tool also searches a
 * synonym table this build does not ship, so only the names are searched.
 * @param {object[]} nodes - istaPatternNodes output
 * @param {string} query - what was typed
 * @returns {{open: Set<number>, hits: number, first: object|null}}
 */
function istaPatternSearch(nodes, query) {
  const q = String(query || '')
    .trim()
    .toLowerCase();
  const open = new Set();
  let hits = 0;
  let first = null;
  const walk = (list, trail) => {
    for (const n of list) {
      if (q && String(n.Title).toLowerCase().includes(q)) {
        for (const id of trail) open.add(id);
        if (n.IsSelectable) {
          hits++;
          if (!first) first = n;
        }
      }
      walk(n.Children, trail.concat([n.id]));
    }
  };
  walk(nodes, []);
  return { open, hits, first };
}

/**
 * Fault pattern, from FaultPatternView.
 *
 * The page is the symptom tree with its search, and three live buttons:
 * Add fault pattern (for a symptom that can be picked and is not in the list
 * yet), Show fault pattern (the list, where one can be taken out again) and
 * Calculate test plan, which runs over the stored faults AND the patterns.
 * @param {HTMLElement} host - where to draw
 * @param {object} o - {car, chassis, data} with `data` the loaded tree
 * @returns {Promise<boolean>} false when the template is not in this build
 */
async function istaXamlFaultPattern(host, o) {
  const car = o.car;
  const data = o.data || {};
  // THE TOOL'S OWN TREES, where the build ships them: the roots the tool
  // shows for this vehicle (an E46 gets "Fault patterns" alone -- the two
  // newer vocabularies are ruled out for it), each a heading over its
  // groups. Without them, the groups of the older extract are listed bare.
  const plan = await istaTestPlanData(o.chassis);
  const exact = !!(plan && Array.isArray(plan.trees) && plan.trees.length);
  const roots = exact
    ? plan.trees
    : Array.isArray(data)
      ? data
      : Array.isArray(data.tree)
        ? data.tree
        : Array.isArray(data.kids)
          ? data.kids
          : [];
  // a symptom the car's rule excludes is not shown, nor anything under it
  const holds = exact ? await istaCarRuleCheck(car, o.chassis) : () => true;
  const prune = (list) =>
    (list || [])
      .filter((n) => holds(n.r))
      .map((n) => ({ ...n, kids: prune(n.kids) }));
  const nodes = istaPatternNodes(prune(roots), exact);
  const tree = { open: new Set(), selected: null, node: null };
  const state = { SearchString: '', ResultNumber: '', SearchSynonym: '' };
  const patterns = () => istaPatterns(car);

  const page = await istaXamlMount(host, 'FaultPatternView', (api) => {
    tree.select = (n) => {
      tree.node = n;
      api.draw();
    };
    const picked = tree.node;
    const scan = istaNewestScan(car);
    const stored = istaFaultRows(scan && scan.report).length > 0;
    const canAdd =
      !!picked &&
      picked.IsSelectable &&
      !patterns().some((p) => p.id === picked.id);
    const vm = {
      ...state,
      TreeObjects: nodes,
      SelectedPerceivedSymptom: picked,
      IsSearchInProgress: false,
      IsProcessingResult: false,
    };
    return {
      trees: { perceivedSymptomsTreeView: tree },
      elements: { perceivedSymptomsTreeView: { SelectedItem: picked } },
      data: {
        TraversablePerceivedSymptomsTreeViewModel: vm,
        IsRefreshButtonVisible: false,
        IsAirActive: false,
        Logic: { VecInfo: { PerceivedSymptoms: patterns() } },
      },
      converters: {
        SelectedTreeItemTitleConverter: (v) => (v && v.Title) || '',
      },
      set: (path, value) => {
        state[path.split('.').pop()] = value;
        // the search buttons sit in the page, not the bottom bar, so the
        // page is what has to notice the box is no longer empty
        api.draw();
      },
      commands: {
        CmdStartSearch: state.SearchString.trim()
          ? () => {
              const found = istaPatternSearch(nodes, state.SearchString);
              tree.open = found.open;
              state.ResultNumber = String(found.hits);
              state.SearchSynonym = '';
              api.draw();
            }
          : null,
        CmdCollapseAll: () => {
          tree.open = new Set();
          api.draw();
        },
        CmdAddFaultPattern: canAdd
          ? () => {
              patterns().push({
                id: picked.id,
                label: picked.Title,
                node: picked.node,
              });
              api.draw();
            }
          : null,
        CmdShowFaultPattern: patterns().length
          ? () =>
              istaXamlPatternDialog({
                patterns: patterns(),
                strings: api.strings,
                commit: (keep) => {
                  const list = patterns();
                  list.splice(0, list.length, ...keep);
                  api.draw();
                },
              })
          : null,
        // LIVE ONLY WHEN THERE IS SOMETHING TO CALCULATE FROM, as the tool
        // has it (CanCalculateTestplanExecute): a stored fault, or a fault
        // pattern. With neither the button is off rather than a press that
        // visibly does nothing.
        CmdCalculateTestplan:
          stored || patterns().length
            ? async () => {
                const faults = await istaPlanFaults(car);
                const rows = await istaCalcPlanAll(
                  faults,
                  car,
                  o.chassis,
                  patterns()
                );
                istaPlanReplace(car, rows);
                // a symptom is a heading in BMW's vocabulary first and a
                // pointer to documents second: many carry none for a car
                if (!rows.length && typeof toast === 'function')
                  toast(
                    'Nothing is linked to these fault patterns or faults ' +
                      'for this vehicle, so the test plan is empty.'
                  );
                return istaGo('service-plan', 'test-plan', null);
              }
            : null,
      },
      after: (h) => {
        const root = h.querySelector('.ixaml');
        if (root) root.classList.add('ixpattern');
      },
    };
  });
  return !!page;
}

/**
 * Put a freshly calculated plan in place of the old one.
 *
 * THE OLD PLAN IS CLEARED FIRST, as the tool does before it calculates
 * (IstaOperationActionImpl.PerformCalculateTestplan calls ClearTestplan):
 * a recalculated plan starts every row at "not called", including one that
 * was run under the plan before it.
 * @param {object|null} car - the picked car
 * @param {object[]} rows - the new plan
 * @returns {void}
 */
function istaPlanReplace(car, rows) {
  if (typeof istaPlanClear === 'function') istaPlanClear(car);
  if (typeof istaPlanSet === 'function') istaPlanSet(car, rows);
}

/**
 * The stored faults a test plan is calculated from: the newest scan's, with
 * the database's verdict on each, as the fault filter leaves them.
 * @param {object|null} car - the picked car
 * @returns {Promise<object[]>} fault rows carrying `meta`
 */
async function istaPlanFaults(car) {
  const scan = istaNewestScan(car);
  const found = istaFaultRows(scan && scan.report);
  const out = [];
  for (const r of found) {
    const meta = istaFaultMeta(r, await istaFaultCodes(r.sgbd));
    const km = r.km === '' || r.km == null ? null : Number(r.km);
    const stored =
      km != null || Object.keys(r.raw || {}).some((k) => /^F_UW/.test(k));
    const test = {
      relevance: meta.relevance,
      current: stored ? { km: Number.isFinite(km) ? km : null } : null,
      first: null,
      cls: '',
    };
    if (istaFaultRelevant(test, istaState.faultRange || null))
      out.push({ ...r, meta });
  }
  return out;
}

/**
 * The "Show fault pattern" dialog, from FaultPatternDialog.
 *
 * IT WORKS ON A COPY. Delete takes the picked pattern out of the dialog's
 * list; only Close makes that so, and Cancel leaves the selection as it was.
 * @param {object} o - {patterns, strings, commit(kept)}
 * @returns {Promise<boolean>} false when the template is not in this build
 */
async function istaXamlPatternDialog(o) {
  const tpl = await istaXamlLoad('FaultPatternDialog');
  if (!tpl || typeof openModal !== 'function') return false;
  const copy = o.patterns.slice();
  let picked = null;
  const title = istaXamlText({ strings: o.strings }, '#ChosenFaultPatterns');
  const { overlay, close } = openModal(
    `<div class="modal ixdialog ixdialog-narrow" role="dialog" ` +
      `aria-modal="true"><div class="modal-title">${esc(title)}</div>` +
      `<div class="ixdialog-host ista-real-body"></div></div>`
  );
  const host = overlay.querySelector('.ixdialog-host');
  const ctx = { strings: o.strings };
  const draw = () => {
    ctx.data = { FaultPattern: copy };
    ctx.cells = {
      lvContentFaultPattern: { '#ListFaultPatterns': (p) => esc(p.label) },
    };
    ctx.select = (name, row) => {
      picked = row;
      draw();
    };
    ctx.commands = {
      CommandCancelDialog: () => close(),
      CommandDeleteFaultPattern:
        picked && copy.includes(picked)
          ? () => {
              copy.splice(copy.indexOf(picked), 1);
              picked = null;
              draw();
            }
          : null,
      CommandCommitDialog: () => {
        o.commit(copy);
        close();
      },
    };
    host.replaceChildren(
      ...(tpl.root.kids || []).map((k) => istaXamlNode(k, ctx.data, ctx))
    );
    // the pick is the dialog's own state: the view binds no SelectedItem
    host.querySelectorAll('.ixtable tbody tr').forEach((tr) => {
      if (copy[Number(tr.dataset.i)] === picked) tr.classList.add('sel');
    });
  };
  ctx.redraw = draw;
  draw();
  return true;
}

// ---- Vehicle information / Control unit tree ---------------------------------

/**
 * Control unit tree, from EcuTreeView, drawn by the port of the tool's own
 * tree (screens/ista/ecu-tree.js).
 *
 * WHICH UNITS ARE ON IT. The tool draws the vehicle's units: the ones it
 * expects from the build (the series' rules over the car's options) and the
 * ones that answered. Here that is every unit a read reached or found
 * silent, plus the expected set where the Garage holds the car's options.
 * Without the options the rules cannot be run, so every unit the series'
 * table places is drawn instead -- wider than the tool, and said so here
 * rather than guessed at.
 *
 * A UNIT'S COLOUR follows the faults that COUNT: one the database calls not
 * relevant does not turn a unit yellow, exactly as it does not appear in
 * the fault memory.
 * @param {HTMLElement} host - where to draw
 * @param {object} o - {car, chassis}
 * @returns {Promise<boolean>} false when the template or the tree is absent
 */
async function istaXamlTree(host, o) {
  const car = o.car;
  const tree = await istaProbe(() =>
    typeof ecuTreeForChassis === 'function'
      ? ecuTreeForChassis(o.chassis)
      : null
  );
  if (!tree || !tree.ecus) return false;
  let picked = null;

  const api = await istaXamlMount(host, 'EcuTreeView', async (page) => {
    const slots = await istaLoadSlots(o.chassis, car);
    const scan = istaNewestScan(car);
    // the faults that count, per module: relevant, or with no verdict
    const counted = new Map();
    for (const r of istaFaultRows(scan && scan.report)) {
      const meta = istaFaultMeta(r, await istaFaultCodes(r.sgbd));
      if (meta.relevance === false) continue;
      const key = String(r.sgbd || '').toLowerCase();
      counted.set(key, (counted.get(key) || 0) + 1);
    }
    const sa = new Set(
      ((car && car.sa) || []).map((c) => String(c).toUpperCase())
    );
    const etk = istaState.etk || {};
    const prod = String((car && car.prod) || etk.prod || '');
    const expected = ecuTreeExpected(tree, {
      sa,
      motor: etk.motor || (car && car.motor) || '',
      gearbox: /aut/i.test(String(etk.gearbox || etk.getriebe || ''))
        ? 'AUT'
        : '',
      typ: String(etk.mospid || etk.typ || '').toUpperCase(),
      prod: prod.length >= 6 ? Number(prod.slice(0, 6)) : 0,
      absOnly: false,
      mk60: slots.some((x) => /^dsc_mk60/i.test(x.sgbd || '')),
    });
    const names = await istaProbe(() =>
      hfFetchFirst(`ista/ecu-names/${String(o.chassis).toUpperCase()}.json`)
    );
    // the units the car might carry besides, grey until one answers.
    //
    // TWO DELIBERATE DEPARTURES FROM THE TOOL, both asked for:
    //  - the tool adds these only at the END of a vehicle test, so a car no
    //    test has read shows a handful of expected units. Here they are
    //    drawn from the start: the tree is the map of the car, and a bare
    //    one before the first read helps nobody.
    //  - a unit whose candidates disagree on a name is titled with the
    //    series' own name alone ("SM"), where the tool appends the address
    //    ("SM_0x72") until the unit identifies.
    const holds = await istaCarRuleCheck(car, o.chassis);
    const possible = ecuTreePossible(tree, names && names.full, holds);
    let units = [];
    for (const slot of slots) {
      const box = slot.box;
      if (!box) continue;
      // a unit that answered: it identified, or its fault memory was read
      const heard =
        slot.state === 'ok' || slot.state === 'faults' || !!slot.ident;
      const wanted = !expected || expected.has(box.addr);
      if (!heard && !wanted && !possible.has(box.addr)) continue;
      let state = slot.state;
      if (state === 'faults' && !counted.get(String(slot.sgbd).toLowerCase()))
        state = 'ok';
      // only a unit the car was EXPECTED to carry is "not responding"; one
      // that was merely possible and stayed silent is not fitted
      if (state === 'silent' && !wanted) state = 'unread';
      const variant = heard ? slot.sgbd || '' : '';
      units.push({
        addr: box.addr,
        sub: box.sub,
        name: ecuTreeTitle(
          names,
          {
            name: box.name || slot.abbr,
            addr: box.addr,
            variant,
            groups: wanted ? box.groups : possible.get(box.addr) || box.groups,
          },
          holds,
          true
        ),
        bus: box.bus,
        subBus: box.subBus,
        variant,
        identified: heard,
        col: box.col,
        row: box.row,
        state,
        slot,
        box,
      });
    }
    // A UNIT THE APP HAS NO MODULE FOR IS STILL ON THE CAR'S TREE. The slots
    // come from the app's own module list, which does not reach every unit
    // the series' table holds; one the car expects or might carry is drawn
    // all the same, as a box with no module window behind it.
    const drawn = new Set(units.map((u) => u.addr));
    for (const box of tree.ecus) {
      if (drawn.has(box.addr)) continue;
      if (!(expected && expected.has(box.addr)) && !possible.has(box.addr))
        continue;
      drawn.add(box.addr);
      units.push({
        addr: box.addr,
        sub: box.sub,
        name: ecuTreeTitle(
          names,
          {
            name: box.name,
            addr: box.addr,
            variant: '',
            groups:
              expected && expected.has(box.addr)
                ? box.groups
                : possible.get(box.addr) || box.groups,
          },
          holds,
          true
        ),
        bus: box.bus,
        subBus: box.subBus,
        variant: '',
        identified: false,
        col: box.col,
        row: box.row,
        state: 'unread',
        slot: null,
        box,
      });
    }
    units = ecuTreeShape(tree, units);
    // WHERE TWO UNITS SHARE A CELL, THE ONE THAT ANSWERED KEEPS IT and the
    // other is parked below. (The tool keeps whichever its list holds
    // first; ours has no such order, and the unit on the car is the one to
    // show in place.)
    units.sort((a, b) => Number(b.identified) - Number(a.identified));
    const built = ecuTreeBuild(tree, units);
    const total = [...counted.values()].reduce((a, n) => a + n, 0);
    const read = slots.some((x) => x.state !== 'unread');
    if (picked) picked = units.find((u) => u.addr === picked.addr) || null;
    return {
      data: {
        DefaultEcuStateBarVisibility: true,
        IstaEcuStateBarVisibility: false,
        TeleServiceEcuStateBarVisibility: false,
        IsCommandSwitchEcuTreeViewModeVisible: false,
        EcuTreeNewViewModel: { EcuTreeViewMode: 'Diagnosis' },
        Logic: {
          IndustrialCustomer: { UsesFaultMemory: true },
          VecInfo: { FaultCodeSum: total },
        },
      },
      converters: {
        FaultCodeSumStateConverter: (v) => (read ? String(v) : 'Unknown'),
        EcuTreeViewModeVisibilityConverter: () => true,
      },
      widgets: {
        ecuTree: (el) =>
          ecuTreeDraw(el, built, {
            selected: (u) => !!picked && u.addr === picked.addr,
            pick: (u) => {
              picked = u;
              page.draw();
            },
            tip: (u) =>
              typeof istaEcuTip === 'function' ? istaEcuTip(u.box, u.slot) : '',
          }),
      },
      commands: {
        CommandStartVehicleTest: istaTestRun
          ? null
          : () => istaOpenVehicleTest(),
        // the window is about ONE control unit, so it needs one picked
        CommandECUFunctions:
          picked && picked.slot && !istaTestRun
            ? () => istaOpenEcuWindow(picked.slot, picked.box, o.chassis)
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
      chrome: () => {
        if (istaTestRun)
          istaBottomBar('unit-list-busy', { cancel: () => istaTestCancel() });
      },
      after: (h) => {
        const root = h.querySelector('.ixaml');
        if (root) root.classList.add('ixtreepage');
      },
    };
  });
  return !!api;
}

// ---- the structure browsers ---------------------------------------------------

/**
 * The `panes` option for the browser, where the workshop shell is drawing
 * from the tool's layouts; undefined anywhere else, and the browser draws
 * its own panes.
 * @param {object} [facts] - {car, plan, planRow} for Add to test plan
 * @returns {((o: object) => Promise<boolean>)|undefined}
 */
function istaBrowseShell(facts) {
  const real =
    typeof document !== 'undefined' &&
    document.body.classList.contains('ista-real-body');
  if (!real || !istaXamlOn('browse')) return undefined;
  return (o) => istaXamlBrowsePanes({ ...o, ...(facts || {}) });
}

/**
 * The step the browser's left arrow takes (ResizeLeft), or null when the
 * arrow is off: both panes -> the list alone; the tree alone -> both.
 * @param {string} layout - both | tree | list
 * @returns {string|null}
 */
function istaBrowseLeft(layout) {
  return layout === 'list' ? null : layout === 'tree' ? 'both' : 'list';
}

/**
 * The step the browser's right arrow takes (ResizeRight), or null when the
 * arrow is off: both panes -> the tree alone; the list alone -> both.
 * @param {string} layout - both | tree | list
 * @returns {string|null}
 */
function istaBrowseRight(layout) {
  return layout === 'tree' ? null : layout === 'list' ? 'both' : 'tree';
}

/**
 * A browser source's tree as the nodes the tree control draws. A node's id
 * is its path, which is what the browser's own state keys its open set by.
 * @param {object[]} nodes - BrowserNode[]
 * @param {string[]} [above] - the path above them
 * @returns {object[]}
 */
function istaBrowseNodes(nodes, above) {
  const base = above || [];
  return (nodes || []).map((n) => {
    const path = base.concat([String(n.id)]);
    return {
      id: path.join('/'),
      Title: [n.num, n.label].filter((x) => x != null && x !== '').join(' '),
      Children: istaBrowseNodes(n.kids, path),
      path,
    };
  });
}

/**
 * The two panes of a structure browser, from TreeviewInfoSearchView.
 *
 * The tool draws Product, Function and Component structure and the service
 * functions with ONE view (TraversableDiagnosisObjectTreeView): the tree
 * with the picked node's title over it and Collapse all beside that, the
 * Type / Title / State list of every document under the picked node, a
 * "Searching..." bar with Cancel while that list loads, and under them
 * Hits, Filter and the state legend. This is its view model
 * (TraversableDiagnosisObjectTreeViewModel) over the app's browser source
 * and the browser's own state, so deep links and the open document, which
 * stay with the browser, see the same selection.
 *
 * THE TWO ARROWS RESIZE; THEY DO NOT NAVIGATE. Left gives the list the
 * whole width, right gives it to the tree, and each undoes the other
 * (ResizeLeft / ResizeRight). With both panes shown the tree takes four
 * sevenths.
 *
 * Add to test plan is drawn only where the tool draws it: for the function
 * structure and the service functions, not the product structure.
 * @param {object} o - the browser's hand-over, and the page's own facts
 * @param {HTMLElement} o.host - where to draw
 * @param {object} o.src - the BrowserSource
 * @param {object} o.state - the browser's state: {path, open, hits, doc,
 *   loading}, to which `layout` and `pick` are added
 * @param {() => void} o.paint - the browser's own repaint (opens a document)
 * @param {object|null} [o.car] - the picked car, for Add to test plan
 * @param {boolean} [o.plan] - whether Add to test plan is offered
 * @param {(doc: object) => object} [o.planRow] - a document as a plan row
 * @param {string|null} [o.types] - the page's document type filter
 *   (InfoObjFilter): a comma list, or null/undefined to list every type.
 *   Hits then reads "listed / found", as the tool counts them.
 * @returns {Promise<boolean>} false when the template is not in this build
 */
async function istaXamlBrowsePanes(o) {
  const { host, src, state } = o;
  if (!state.layout) state.layout = 'both';
  const nodes = istaBrowseNodes(src.tree);
  const byId = new Map();
  (function index(list) {
    for (const n of list) {
      byId.set(n.id, n);
      index(n.Children);
    }
  })(nodes);
  const tree = {
    open: state.open,
    selected: state.path ? state.path.join('/') : null,
  };
  const docKey = (d) => (src.docId ? src.docId(d) : src.rowTitle(d));

  const page = await istaXamlMount(
    host,
    'TreeviewInfoSearchView',
    (api) => {
      tree.selected = state.path ? state.path.join('/') : null;
      tree.select = (n) => {
        // the control has already opened or shut the node; what is left is
        // the list of everything under it
        state.path = n.path;
        state.pick = null;
        const token = {};
        state.loading = token;
        api.draw();
        Promise.resolve(src.list(n.path)).then((rows) => {
          // a slower earlier load must not overwrite a faster later one
          if (state.loading !== token) return;
          state.loading = null;
          state.hits = rows || [];
          if (host.isConnected) api.draw();
        });
      };
      const node = tree.selected ? byId.get(tree.selected) || null : null;
      const busy = !!state.loading;
      const found = state.hits || [];
      // the filter is applied to what was found (FilterSearchResults)
      const items = found
        .filter(
          (d) =>
            typeof istaInfoTypeOk !== 'function' ||
            istaInfoTypeOk(o.types == null ? null : o.types, src.rowType(d))
        )
        .map((d) => ({
          XepInfoObject: { InfoType: src.rowType(d), AwNummer: '' },
          Title: src.rowTitle(d),
          State: 'none',
          key: docKey(d),
          doc: d,
        }));
      items.Count = items.length;
      const picked = state.pick
        ? items.find((x) => x.key === state.pick) || null
        : null;
      const show = (it) => {
        const row = it && it.doc ? it : picked;
        if (!row) return;
        state.doc = row.doc;
        // the open document is the browser's page, with its own bar
        istaRealStatus({ items: [] });
        istaRealBottom(null);
        o.paint();
      };
      // nothing picked yet still counts: "0 / 0", under an empty title bar
      const selected = {
        Title: node ? node.Title : '',
        IsSearchInProgress: busy,
        SingleTreeSearchResult: { InfoObjResult: { Count: found.length } },
      };
      const vm = {
        TreeObjects: nodes,
        IsTreeViewVisible: state.layout !== 'list',
        IsTreeViewHitlistVisible: state.layout !== 'tree',
        IsCollapsAllVisible: state.layout !== 'list',
        IsAddToTestPlanEnabled: !!o.plan,
        IsAirActive: false,
        SelectedDiagnosisObject: selected,
        InfoObjFilter: { IsDefault: true },
        Mode: 'Search',
      };
      return {
        trees: { diagObjTreeView: tree },
        elements: { diagObjTreeView: { SelectedItem: selected } },
        data: { ...vm, TraversableDiagnosisObjectTreeViewModel: vm },
        resources: {
          DiagObjectsCollectionViewSource: items,
          ProxyDataContext: {
            Data: { IsAwNumberVisible: false, IsStatusVisible: true },
          },
        },
        converters: {
          SelectedTreeItemTitleConverter: (v) => (v && v.Title) || '',
          SearchPageVisibilityConverter: () => true,
        },
        cells: {
          DiagObjectsCollectionViewSource: {
            '#Type': (it) => esc(it.XepInfoObject.InfoType),
            '#Status': (it) => istaPlanStateCell(it.State),
          },
        },
        picked: {
          DiagObjectsCollectionViewSource: (it) => it.key === state.pick,
        },
        select: (name, it) => {
          state.pick = it ? it.key : null;
          api.chrome();
        },
        commands: {
          CmdCollapseAll: () => {
            state.open.clear();
            api.draw();
          },
          CancelSearchCommand: () => {
            // a cancelled load leaves the previous list standing
            state.loading = null;
            api.draw();
          },
          ResizeLeftCommand: istaBrowseLeft(state.layout)
            ? () => {
                state.layout = istaBrowseLeft(state.layout);
                api.draw();
              }
            : null,
          ResizeRightCommand: istaBrowseRight(state.layout)
            ? () => {
                state.layout = istaBrowseRight(state.layout);
                api.draw();
              }
            : null,
          CommandAddToTestPlan:
            o.plan && picked && o.car && o.planRow
              ? () => {
                  const added = istaPlanAdd(o.car, [o.planRow(picked.doc)]);
                  if (typeof toast === 'function')
                    toast(
                      added
                        ? 'Added to the test plan.'
                        : 'Already in the test plan.'
                    );
                }
              : null,
          // the button needs a pick; a double click brings its own row
          CommandDisplay: { off: !picked, run: show },
          CommandDoNothing: () => {},
        },
        // the two resize buttons are the bar's centred arrow pair
        buttons: (rows) => {
          const arrow = (name) => rows.find((r) => r.command === name);
          const left = arrow('ResizeLeftCommand');
          const right = arrow('ResizeRightCommand');
          if (!left || !right) return rows;
          const rest = rows.filter(
            (r) => r !== left && r !== right && !r.spacer
          );
          const at = rows.indexOf(left);
          const before = rest.filter((r) => rows.indexOf(r) < at);
          const after = rest.filter((r) => rows.indexOf(r) > at);
          return [
            ...before,
            { nav: true, back: left.fn, fwd: right.fn },
            ...after,
          ];
        },
        after: (h) => {
          const root = h.querySelector('.ixaml');
          if (!root) return;
          root.classList.add('ixbrowse', `ixbrowse-${state.layout}`);
          const table = root.querySelector('.ixtable');
          if (table) table.classList.add('irplan');
        },
      };
    },
    { inner: true }
  );
  return !!page;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    istaBrowseShell,
    istaBrowseLeft,
    istaBrowseRight,
    istaBrowseNodes,
    istaXamlCulture,
    istaXamlFaultMemory,
    istaFaultRelevant,
    istaFaultFilterDefault,
    istaFaultCursorStep,
    istaFaultGraphSvg,
    istaXamlFaultFilter,
    istaQuickDelete,
    istaCalcPlanAll,
    istaFaultCodes,
    istaFaultMeta,
    istaPlanCompare,
    istaFaultExisting,
    istaFaultOrt,
    istaTestPlanData,
    istaPlanExact,
    istaPlanPatternsExact,
    istaCarRuleCheck,
    istaOpenPlanDiag,
    istaFaultPresent,
    istaPlanPrioritise,
    istaXamlTestPlan,
    istaXamlBasic,
    istaXamlMount,
    istaXamlUnitList,
    istaSaeLookup,
    istaXamlSae,
    istaXamlActive,
    istaXamlHitList,
    istaXamlDetails,
    istaXamlTree,
    istaPatterns,
    istaPatternNodes,
    istaPatternSearch,
    istaXamlFaultPattern,
    istaPlanFaults,
    istaXamlPatternDialog,
    istaXamlHitView,
    istaXamlVin,
    istaXamlReadout,
    istaDiagSearchHits,
    istaXamlDiagSearch,
  };
}
