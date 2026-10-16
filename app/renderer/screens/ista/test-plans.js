/**
 * @file ISTA shell: fault picking, the diagnostic documents, the test plan and the ABL runner that steps through a plan's modules.
 */

/* exported istaClearPicked, istaBrowse, istaDiagLoad, istaDiagBody, istaPlanGroups, istaOpenPlanDoc, istaCalcPlan, istaOpenPlanRow, istaAblRunner */

/**
 * Clear the fault memory of the module a picked fault came from.
 *
 * Routed through the app's own per-module clear, which asks first and then
 * RE-READS to prove the memory is empty. A clear that reports success
 * without re-reading hides a live fault that re-enters the moment the ECU
 * sees it again, so this must not grow a shortcut.
 * @param {object} row - the picked fault row
 * @param {() => void} after - redraw the table
 * @returns {Promise<void>}
 */
async function istaClearPicked(row, after) {
  if (!row || !row.sgbd) return;
  if (typeof clearModule !== 'function') return;
  await istaProbe(() =>
    clearModule({
      ecu: { sgbd: row.sgbd },
      label: row.module || row.sgbd,
      codes: [],
    })
  );
  if (typeof after === 'function') after();
}

/**
 * Draw a browser page (tree, list, document) into the content area.
 *
 * One call site for every structure page, so the deep-link slots and the
 * selection state are handled the same way whichever tree is showing.
 * @param {HTMLElement} host - where to draw
 * @param {object} src - a BrowserSource
 * @param {string} key - which browser's state this is
 * @param {object} [opts] - passed through to browserPaint
 * @returns {void}
 */
function istaBrowse(host, src, key, opts) {
  if (typeof browserPaint !== 'function') {
    host.innerHTML =
      `<div class="irgrey-w">The structure browser did not ship in this ` +
      `build.</div>`;
    return;
  }
  // THE BROWSER'S OWN STYLES ARE SCOPED under .ista-repair, because the
  // repair manual is where it was written. Every page that reuses it needs
  // that class on an ancestor or the two panes collapse into unstyled boxes
  // -- it names the widget's vocabulary, not the repair manual.
  host.classList.add('ista-repair');
  if (!istaState.browse) istaState.browse = {};
  if (!istaState.browse[key])
    istaState.browse[key] = {
      path: null,
      open: new Set(),
      hits: [],
      doc: null,
    };
  browserPaint(host, src, istaState.browse[key], opts || {});
}

/**
 * Load a diagnosis structure for a chassis.
 * @param {string} chassis - the chassis id
 * @param {string} which - fault-pattern, function-structure, component-structure
 * @returns {Promise<object|null>}
 */
async function istaDiagLoad(chassis, which, car) {
  const code = String(chassis || '').toUpperCase();
  if (!code) return null;
  const res = await istaDiagFetch(`${code}/${which}.json.gz`);
  if (!res) return null;
  // the structures ship gzipped, and a plain file server serves them as
  // bytes rather than as content-encoding: gzip, so they are unpacked here
  // with the same library the chassis archives use
  const buf = new Uint8Array(await res.arrayBuffer());
  if (typeof fflate === 'undefined') return null;
  const tree = JSON.parse(
    new TextDecoder('utf-8').decode(fflate.gunzipSync(buf))
  );
  // THE EXTRACT IS CHASSIS-WIDE; this car is one of the chassis's builds.
  // Narrowing here rather than at each page means the tree, the hits line
  // and Text Search all count the same documents -- a search that found a
  // document the tree does not list would be the worst of both.
  if (!car || typeof istaDiagGate !== 'function') return tree;
  const keys = await istaProbe(() =>
    typeof techDataCarKeys === 'function' ? techDataCarKeys(car, chassis) : null
  );
  if (!keys || !keys.ids || !keys.ids.size) return tree;
  // THE FACTS COME FROM THE ONE BUILDER EVERY GATE USES (techDataCarFacts):
  // the build date as year*100+month, the way the evaluator compares a DATE
  // leaf, and the order's SA codes the Garage keeps. A "YYYY-MM" string
  // built here once made every dated clause a decided false, which pruned
  // the branches it guarded instead of keeping them.
  const facts =
    typeof techDataVehicleFacts === 'function'
      ? await techDataVehicleFacts(car, chassis)
      : {};
  return istaDiagGate(tree, keys.ids, facts) || tree;
}

/**
 * A diagnosis document's body, rendered.
 * @param {string} chassis - the chassis id
 * @param {object} doc - the document row
 * @returns {Promise<string>} HTML
 */
async function istaDiagBody(chassis, doc) {
  const code = String(chassis || '').toUpperCase();
  // an ABL test module is a compiled procedure: its halves are documents but
  // the procedure itself cannot run here, and the page says so rather than
  // pretending a button will start it
  if (doc && doc.type === 'ABL')
    return (
      `<div class="irabl"><div class="irabl-pane">` +
      `<div class="irpane-head">Procedure</div>` +
      `<div class="irgrey-w">This test module is a compiled procedure and ` +
      `cannot run in this build. Its linked documents are on the right.` +
      `</div></div></div>`
    );
  const body = await istaProbe(async () => {
    const r = await istaDiagFetch(`${code}/docs/${doc.id}.json.gz`);
    if (!r || typeof fflate === 'undefined') return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    return JSON.parse(
      new TextDecoder('utf-8').decode(fflate.gunzipSync(bytes))
    );
  });
  // istaDiagBodyHtml handles a missing body itself, and it is the ONLY path
  // from here: the old fallback tested for a repairBodyHtml that does not
  // exist anywhere in the app, so every document fell through to a raw
  // JSON dump.
  return istaDiagBodyHtml(body);
}

/**
 * The Service plan's groups, per list.
 *
 * The hit list groups the linked procedures UNDER THE FAULT that points at
 * them, because that is the question a technician is asking: this fault is
 * stored, what does BMW say to do about it. A fault with no linked procedure
 * keeps its heading and says so.
 * @param {string} which - hit-list, test-plan or programming-plan
 * @param {object|null} car - the picked GarageCar
 * @returns {Promise<object[]>} the groups
 */
async function istaPlanGroups(which, car) {
  if (which === 'programming-plan') return [];
  if (which === 'test-plan') {
    // the plan groups UNDER THE COMPONENT, which is what the frames show: a
    // grey heading row carrying the group's priority, its ABL rows beneath
    const rows = istaTestPlan(car);
    return rows.length && typeof istaPlanGroupRows === 'function'
      ? istaPlanGroupRows(rows)
      : rows.length
        ? [{ title: 'Test plan', rows }]
        : [];
  }
  const scan =
    typeof istaNewestScan === 'function' ? istaNewestScan(car) : null;
  const rows =
    typeof istaFaultRows === 'function'
      ? istaFaultRows(scan && scan.report)
      : [];
  if (!rows.length) return [];
  await istaProbe(() =>
    typeof loadIstaTests === 'function' ? loadIstaTests() : null
  );
  return rows.map((r) => {
    const doc = typeof istaTestFor === 'function' ? istaTestFor(r.desc) : null;
    return {
      title: `${r.code}  ${r.desc}`,
      none: 'no procedure is linked to this fault in this build',
      rows: doc
        ? [{ type: 'ABL', title: doc.title || r.desc, state: '', _doc: doc }]
        : [],
    };
  });
}

/**
 * Open a Service plan row's document in the viewer.
 * @param {object} row - the picked row
 * @returns {void}
 */
function istaOpenPlanDoc(row) {
  if (!row || !row._doc || typeof openModal !== 'function') return;
  const doc = row._doc;
  const chapters = (doc.chapters || [])
    .map(
      (ch) =>
        `<h3>${esc(ch.heading || '')}</h3>` +
        (ch.paras || []).map((p) => `<p>${esc(p)}</p>`).join('')
    )
    .join('');
  const { overlay, close } = openModal(
    `<div class="modal irdoc" role="dialog" aria-modal="true">` +
      `<div class="irdoc-title">${esc(doc.title || row.title)}</div>` +
      `<div class="irdoc-body">${chapters}</div>` +
      `<div class="modal-actions">` +
      `<button type="button" class="btn irdoc-close">Close</button>` +
      `</div></div>`
  );
  overlay.querySelector('.irdoc-close').onclick = () => close();
}

/**
 * Calculate the test plan for one stored fault.
 *
 * TWO SOURCES, AND THE BETTER ONE WINS PER FAULT. The fault-to-procedure
 * links the Hit list already uses name the procedure in words; the
 * recovered modules' per-chassis index names it by identifier, which is
 * what the module window needs to open anything. So a fault the index
 * covers contributes a runnable row, a fault only the links cover
 * contributes a readable one, and a fault neither covers contributes
 * nothing rather than a row that dead-ends.
 * @param {object} fault - the picked fault row, from istaFaultRows
 * @param {object|null} car - the picked GarageCar
 * @param {string} chassis - the development code
 * @returns {Promise<object[]>} the rows to push into the plan
 */
async function istaCalcPlan(fault, car, chassis) {
  if (!fault) return [];
  /** @type {object[]} */
  const out = [];
  const code = String(fault.code || '').toUpperCase();
  const idx = await istaProbe(() =>
    typeof istaAblIndex === 'function' ? istaAblIndex(chassis) : null
  );
  // the index's fault links: {faults: {"0041AA": ["ABL-DIT-B1362_D6LDF"]}}
  // and a per-module row of what to call it and where it belongs
  const byFault = (idx && idx.faults) || {};
  const modules = (idx && idx.modules) || {};
  // THE INDEX KEYS FAULTS IN DECIMAL, AND THE SCREEN SHOWS HEX. ISTA's own
  // database stores XEP_FAULTCODES.CODE as a decimal string -- the fault a
  // workshop writes 0B32 is keyed "2866" -- so a hex code looked up as-is
  // either misses or, far worse, hits a different fault that happens to
  // share the digits. "0B" found decimal key 11 and returned its 46 modules:
  // brake light switch, coolant temperature, oil level, heating flaps. A
  // steering-angle fault produced a plan about the heater.
  //
  // THE TABLE ALSO SHOWS THE LOCATION BYTE, NOT THE WHOLE WORD. faultFields
  // prefers the short form a workshop reads (0B), while the links are keyed
  // on the full fault word (0B32). The raw answer is still on the row, so
  // the full word is recovered from it and tried first -- it identifies one
  // procedure where the location byte alone identifies dozens.
  const raw = fault.raw || {};
  const sgbd = String(fault.sgbd || '').toLowerCase();
  const full =
    typeof hexText === 'function'
      ? String(hexText(raw.F_HEX_CODE) || '').replace(/[^0-9a-fA-F]/g, '')
      : '';

  // THE INDEX IS KEYED TWO WAYS, AND ONLY ONE OF THEM IS SAFE ALONE.
  // BMW's links are written both bare ("B7") and scoped to the module that
  // reports them ("dsc_e46:B7"). The bare key is a LOCATION BYTE shared
  // across the whole car: "B" links 48 procedures spanning mirrors, seats,
  // headlights and the K-bus, because dozens of modules number a fault at
  // that location. Handing those to a technician who picked one row is
  // worse than handing them nothing -- it buries the answer in noise and
  // implies BMW linked them.
  //
  // So the scoped key is tried first, then the full fault word, and the
  // bare location byte only when it is specific enough to mean something.
  const spell = (h) => {
    const out = [];
    for (const k of [h, h.replace(/^0+/, ''), h.padStart(4, '0')])
      if (k && !out.includes(k)) out.push(k);
    return out;
  };
  const tiers = [];
  // 1. this module's own link for this code
  if (sgbd)
    tiers.push(
      [...(full ? spell(full) : []), ...spell(code)].map((k) => `${sgbd}:${k}`)
    );
  // 2. the full fault word, which identifies one fault rather than a family
  if (full && full !== code) tiers.push(spell(full));
  // 3. the bare code, but only when it is a whole word rather than the
  //    location byte a hundred modules share
  if (code.replace(/^0+/, '').length > 2) tiers.push(spell(code));

  const collect = (list) => {
    const got = [];
    for (const k of list)
      for (const one of byFault[k] || []) if (!got.includes(one)) got.push(one);
    return got;
  };
  let ids = [];
  for (const tier of tiers) {
    ids = collect(tier);
    if (ids.length) break;
  }
  for (const id of ids) {
    const m = modules[id] || {};
    out.push({
      id,
      type: 'ABL',
      title: m.title || id,
      component: m.component || m.title || fault.desc || id,
      priority: m.priority == null ? 0 : Number(m.priority),
      state: 'none',
      fault: code,
    });
  }
  if (out.length) return out;
  // no index, or no link for this fault: the linked document still tells a
  // technician what BMW says to do, so the row is worth having
  await istaProbe(() =>
    typeof loadIstaTests === 'function' ? loadIstaTests() : null
  );
  const doc =
    typeof istaTestFor === 'function' ? istaTestFor(fault.desc) : null;
  if (doc)
    out.push({
      id: `DOC ${doc.slug || doc.title || fault.desc}`,
      type: 'ABL',
      title: doc.title || fault.desc,
      component: fault.desc || doc.title,
      priority: 0,
      state: 'none',
      fault: code,
      doc,
    });
  return out;
}

/**
 * Open a test plan row: the module window when the module ships, the
 * document when only the link does, and a grey note when neither.
 * @param {object} row - the picked plan row
 * @param {object|null} car - the picked GarageCar
 * @param {string} chassis - the development code
 * @param {Function} [after] - called when the window closes, to redraw
 * @returns {Promise<void>}
 */
async function istaOpenPlanRow(row, car, chassis, after) {
  if (!row) return;
  const graph =
    row.id && typeof istaAblLoad === 'function'
      ? await istaProbe(() => istaAblLoad(row.id, chassis))
      : null;
  if (!graph) {
    // a row whose module this build does not ship still has its document
    if (row.doc) return istaOpenPlanDoc(row);
    if (typeof istaPageGrey === 'function' && typeof showIsta === 'function')
      return istaOpenPlanNote(row);
    return;
  }
  await istaOpen({
    label: row.title || row.id,
    _call: () => istaRunAblModule(graph, row, car, chassis, after),
  });
}

/**
 * What a test module needs from the app to run against this car.
 *
 * ONE RUNNER FOR EVERY MODULE RUN: the module window and the feature
 * detection the vehicle test performs (istaFfmResolve) drive the same
 * hooks, so an activation asks first in both, a group resolves to the
 * variant that answers in both, and the fault list comes off the stored
 * scan in both.
 * @param {object|null} car - the picked GarageCar
 * @param {string} chassis - the development code
 * @param {object|null} vehicleText - the vehicle_state names table
 * @returns {object} the engine's host hooks (job, module, native, vehicleText)
 */
function istaAblRunner(car, chassis, vehicleText) {
  return {
    // the module addresses a GROUP; the app resolves it to the variant
    // that answers on this car, exactly as every other screen does
    job: async (spec) => {
      let sgbd = spec.sgbd;
      if (!sgbd && spec.group && typeof webResolveVariant === 'function')
        sgbd = await istaProbe(() => webResolveVariant(spec.group));
      if (!sgbd) return null;
      const q = spec.argText ? `?arg=${encodeURIComponent(spec.argText)}` : '';
      // AN ACTIVATION ASKS FIRST. A module's STEUERN_* job drives a
      // component (the cluster self-test sweeps every gauge and lamp),
      // and the app's contract is that a write is confirmed unless the
      // user turned actuator confirmations off -- the same rule the ECU
      // window and the raw job runner follow. The module's own words are
      // the warning; this is the consent.
      // DIAGNOSE_ENDE is classed a write (no read token, default-deny)
      // but it ends the diagnostic session and drives nothing, and the
      // library modules send it after every activation: a confirm for
      // it would be noise on every run, teaching the hand to click
      // through the confirm that matters.
      const write =
        typeof isWriteJob === 'function' &&
        isWriteJob(spec.job) &&
        !/^DIAGNOSE_ENDE$/i.test(String(spec.job || ''));
      if (
        write &&
        (typeof confirmActuators !== 'function' || confirmActuators()) &&
        typeof confirmDialog === 'function'
      ) {
        const okGo = await confirmDialog({
          title: `${spec.job} commands ${sgbd}`,
          body:
            'The test module is about to drive a component rather than ' +
            'read it. Make sure the module and anything it moves are safe.',
          confirmLabel: 'Trigger',
          danger: true,
        });
        if (!okGo) return { refused: true, job: spec.job, sgbd };
      }
      // A FAILED JOB IS REPORTED, NOT SWALLOWED. api() throws the
      // router's real reason -- "no module answered on the wire", an
      // IFH code, "no job code shipped" -- and turning that into null
      // told the engine "no communication" and told the technician
      // nothing: an activation they had just been warned about could
      // simply not happen, silently. The reason travels back; an
      // activation's failure is shown, a read's is the flow's own
      // no-communication path.
      try {
        return await api(
          `/api/ecu/${sgbd}/run/${encodeURIComponent(spec.job)}${q}`,
          { method: 'POST' }
        );
      } catch (e) {
        return {
          error: String((e && e.message) || e),
          notify: write,
          job: spec.job,
          sgbd,
        };
      }
    },
    module: ({ identifier }) =>
      typeof istaAblLoad === 'function'
        ? istaAblLoad(identifier, chassis)
        : null,
    vehicleText: vehicleText || null,
    native: {
      // THE FAULT LIST IS ALREADY READ. The library module the engine
      // would otherwise run asks the car for the fault memory of a
      // group; the Garage scan holds that answer, so the stand-in
      // filters the stored faults by the module's own fault locations
      // rather than putting the car back on the bus for them.
      submodule: async ({ seed }) => istaAblFaultList(seed, car),
      faultList: async ({ vars }) => istaAblFaultList(vars, car),
    },
  };
}

/**
 * Run a recovered test module in the shell's content area.
 *
 * This is the seam between the step player and the app: the engine asks for
 * a job, a library module, a fault list or a document, and each of those is
 * something the app already does. Nothing here re-implements any of them.
 * @param {object} graph - the recovered module
 * @param {object} row - the plan row it came from
 * @param {object|null} car - the picked GarageCar
 * @param {string} chassis - the development code
 * @param {Function} [after] - called when the window closes
 * @returns {Promise<void>} resolves when the window is closed
 */
async function istaRunAblModule(graph, row, car, chassis, after) {
  const view = document.getElementById('view');
  if (!view || typeof istaAblWindow !== 'function') return Promise.resolve();
  view.innerHTML = '';
  const host = document.createElement('div');
  host.className = 'irablhost';
  view.appendChild(host);
  if (typeof setActions === 'function') setActions([]);

  // A TEST HOOK, AND ONLY BEHIND A QUERY FLAG. Driving the window headless
  // needs a car that answers; wiring one in without the flag would mean a
  // build that can be fed fake readings from a link.
  const fake =
    typeof location !== 'undefined' &&
    /[?&]abltest=1\b/.test(location.search) &&
    typeof window !== 'undefined' &&
    typeof window.__ablRunner === 'object'
      ? window.__ablRunner
      : null;

  // the documents the module's diagnosis object links to, by identifier
  const idx = await istaProbe(() =>
    typeof istaAblIndex === 'function' ? istaAblIndex(chassis) : null
  );
  const linked =
    (idx &&
      idx.modules &&
      idx.modules[(row && row.id) || (graph && graph.identifier)] &&
      idx.modules[(row && row.id) || (graph && graph.identifier)].documents) ||
    [];

  // the names a vehicle_state step shows ("Ignition", "Switch on terminal
  // R."), one small table for every module rather than a copy in each graph
  const vehicleText = await istaProbe(() =>
    typeof istaAblFetch === 'function'
      ? istaAblFetch('vehicle-states.json')
      : null
  );

  return new Promise((resolve) => {
    istaAblWindow(host, {
      graph,
      // A PLAN ROW IS A POINTER, NOT A COPY (see plan.js), so the row
      // carries no documents to hand on: the module's own linked documents
      // are read from the index when the window opens, the same place the
      // graph itself comes from.
      docs: (doc, label) => istaAblDocHtml(doc, label, chassis, linked),
      // clicking a component on a schematic is how the tool moves from
      // "which wire" to "where is it": the anchor carries the designator,
      // and these two hand the window the lookup without teaching it the
      // shape of the wiring index
      bindDesignators: (box, open) =>
        istaWiringBindDesignators(box, chassis, open),
      designatorDocs: (key) => istaWiringForDesignator(chassis, key),
      designatorHtml: (id) => istaWiringDocHtml(chassis, id),
      runner: fake || istaAblRunner(car, chassis, vehicleText),
      // THE RUN IS WRITTEN BACK. A module that ends leaves its result on
      // the plan row, so the State column's square carries the legend's
      // colour and the technician can see at a glance what has been done
      // and what is still open. The mapping from the six CollectiveResult
      // values to the plan's five states lives in plan.js.
      onDone: (verdict) => {
        if (!row || !row.id || typeof istaPlanSetState !== 'function') return;
        const state =
          typeof istaPlanStateFor === 'function'
            ? istaPlanStateFor(verdict)
            : verdict === 'canceled'
              ? 'canceled'
              : 'performed';
        istaPlanSetState(car, row.id, state);
      },
      onClose: () => {
        if (typeof after === 'function') after();
        resolve();
      },
    });
  });
}

/**
 * The fault-memory library module's contract, off the stored scan.
 *
 * The recovered library returns a wall of parallel arrays; what its callers
 * actually read out of them is the count of matching faults, the resolved
 * SGBD and the identification status. Those three come straight from the
 * scan the Garage already holds, filtered to the fault locations the
 * calling module named.
 * @param {object} vars - the caller's variables (SG_gruppe_v, Fehlerorte_v)
 * @param {object|null} car - the picked GarageCar
 * @returns {object} the variables the caller reads back
 */
function istaAblFaultList(vars, car) {
  const v = vars || {};
  const first = (x) => (Array.isArray(x) ? x[0] : x);
  const group = String(first(v.SG_gruppe_v) || '').toUpperCase();
  const places = (Array.isArray(v.Fehlerorte_v) ? v.Fehlerorte_v : [])
    .filter(Boolean)
    .map((x) => String(x).toUpperCase().replace(/^0X/, ''));
  const scan =
    typeof istaNewestScan === 'function' ? istaNewestScan(car) : null;
  const rows =
    typeof istaFaultRows === 'function'
      ? istaFaultRows(scan && scan.report)
      : [];
  // the module names an ECU GROUP; the scan names the variant that answered
  // for it, so the match is on the module the fault came from rather than
  // on a group name the scan never carried
  const mine = rows.filter((r) => {
    if (!places.length) return true;
    const code = String(r.code || '')
      .toUpperCase()
      .replace(/^0X/, '');
    return places.some((p) => code.endsWith(p));
  });
  const sgbd = (mine[0] && mine[0].sgbd) || (rows[0] && rows[0].sgbd) || '';
  return {
    Status_Fehlerspeicher_v: mine.length,
    Anzahl_Fehlerspeicher_v: mine.length,
    Sgbd_v: [sgbd],
    gSgbd_v: sgbd,
    Status_Ident_v: [scan ? 'OKAY' : ''],
    gJobstat1_v: scan ? 'OKAY' : '',
    Fkode_hex_v: mine.map((r) => String(r.code || '')),
    Fkode_Text_v: mine.map((r) => String(r.desc || '')),
    Fkode_Anzahl_ges_v: mine.length,
    Status_Ident_ges_v: scan ? 'OKAY' : '',
    SG_gruppe_v: [group],
  };
}
