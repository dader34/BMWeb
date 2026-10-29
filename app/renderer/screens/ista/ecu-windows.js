/**
 * @file ISTA shell: opening it, the route it keeps in the URL, and the windows for one control unit (the tree, its slots, the live test, its documents).
 */

/* exported istaRouteStamp, istaOpen, istaBottomBar, istaTreeBind, istaLoadSlots, istaTestLiveState, istaTestLive, istaOpenEcuWindow, istaTestPlan, istaDiagFetch, istaDiagBodies, istaOpenDiagDoc, istaTechDataFilter, istaOpenBasic, istaOpenStoredScan */

// ---- the entry point -------------------------------------------------------

/**
 * Stamp the shell's route into the URL. Done by hand rather than through
 * ROUTE_FOR_SCREEN because the route carries the tab, the sub-tab, the
 * level-3 tab and the car, none of which a function name can express.
 *
 * THE LAST TWO SLOTS ARE NOT THE SHELL'S. A sub-tab with pages of its own
 * (Repair/maintenance, the diagnosis structures, Workshop) writes them, and
 * this runs BEFORE that sub-tab has drawn -- so stamping only the first four
 * would erase the view and the document a deep link named, a moment before
 * the sub-tab tried to read them. They are therefore carried through from
 * whatever is in the URL, but only while the tab, sub-tab and level-3 still
 * match: a stale view from the tab the reader just left would otherwise
 * follow them to the next one.
 * @returns {void}
 */
function istaRouteStamp() {
  if (typeof history === 'undefined' || !history.replaceState) return;
  const now =
    typeof location !== 'undefined'
      ? istaRouteParse(String(location.hash || '').replace(/^#/, ''))
      : null;
  const same =
    now &&
    now.tab === istaState.tab &&
    now.sub === istaState.sub &&
    now.sub3 === istaState.sub3;
  const route = istaRouteBuild(
    istaState.tab,
    istaState.sub,
    istaState.sub3,
    istaState.car ? istaState.car.id : null,
    same ? now.view : null,
    same ? now.item : null
  );
  history.replaceState(null, '', '#' + route);
}

/**
 * Open a wrapped screen and keep the shell around it.
 *
 * The screen renders into `#view` as it always does. What this adds is the
 * two lines that stop it taking the shell's identity with it: `lastScreen`
 * goes back to the shell (so the next setCrumbs, wherever it comes from,
 * syncs to the shell rather than the wrapped screen), and the hash is
 * re-stamped after the render (so the wrapped screen's own routeSetX call
 * does not win). Esc is re-pointed at the shell's home for the same reason.
 * @param {IstaSub|IstaSub3} sub - the leaf being opened
 * @returns {Promise<void>}
 */
async function istaOpen(sub) {
  // a synthetic row (a stored scan, one module's script) carries its own
  // call rather than a global name: the tab table names functions, but these
  // are built from a row the reader just picked
  const fn = sub._call || window[sub.open];
  istaOpeningSet(true); // the router must not read this render as "left"
  try {
    await fn();
  } catch (e) {
    // a wrapped screen that throws must not take the shell down with it
    const host = document.getElementById('view');
    if (host && typeof errorBlock === 'function')
      host.innerHTML = errorBlock(
        `${esc(sub.label)} could not open: ${esc(e && e.message ? e.message : e)}`
      );
  } finally {
    istaOpeningSet(false);
  }
  lastScreen = () => showIsta(istaState.tab, istaState.sub, istaState.sub3);
  istaRouteStamp();
  istaBackAction();
  // the wrapped screen owns #view; the shell still owns the bars around it
  if (istaSkinOn()) istaRealChromeBars(sub);
}

/**
 * Put the shell's Back on Esc, keeping whatever else the wrapped screen
 * installed. A wrapped screen owns its F-keys; the shell only claims the
 * back slot, so Esc leaves the sub-tab rather than the app.
 *
 * kind:'print' is carried through whatever the screen had, and the shell's
 * own rows always ship one, so Cmd/Ctrl+P keeps working on every screen in
 * the shell (core/print.js searches only the row painted right now).
 * @returns {void}
 */
function istaBackAction() {
  const keep = (
    (typeof actionBar !== 'undefined' && actionBar.current) ||
    []
  ).filter((a) => a && a.kind !== 'back');
  setActions([
    ...keep,
    {
      key: 'Escape',
      keyLabel: 'Esc',
      label: 'Workshop',
      kind: 'back',
      fn: () => showIsta(ISTA_HOME_TAB, null, null),
    },
  ]);
}

/**
 * Draw the bottom bar a page offers, binding each button id to what it does.
 *
 * The WHAT and the ORDER live in the model's ISTA_BOTTOM table; this is the
 * only place that knows what any of them does. So a page's row of buttons is
 * a fact about that page rather than a template every page inherits.
 *
 * A button whose id has no action here draws greyed rather than dead: the
 * tool shows the control and refuses it, which is the honest shape.
 * @param {string} pageId - the key into ISTA_BOTTOM
 * @param {Object<string, Function|null>} [actions] - id to what it does
 * @returns {void}
 */
function istaBottomBar(pageId, actions) {
  const act = actions || {};
  const rows = istaBottomFor(pageId).map((b) => {
    if (b.nav)
      return { nav: true, back: act._back || null, fwd: act._fwd || null };
    if (b.spacer) return { spacer: true };
    const fn = act[b.id];
    // A button is off when the page gave it nothing to do. The model's
    // `off` only says what the button looks like before a page binds it
    // (Show fault code with no fault picked); it must not pin a button
    // shut once the page hands it a handler, which it did.
    return {
      label: b.label,
      fn: fn || null,
      off: !fn,
      title: b.title || '',
    };
  });
  istaRealBottom(rows.length ? rows : null);
}

/**
 * The status line and bottom bar for a wrapped screen.
 *
 * A wrapped screen keeps its own F-key row (which the skin hides) and its
 * own buttons inside #view. What the skin adds around it is the status line;
 * the buttons are whatever the model says that page offers, which for a
 * screen the shell merely wraps is nothing of its own.
 * @param {IstaSub|IstaSub3} sub - the leaf that was opened
 * @returns {void}
 */
function istaRealChromeBars(sub) {
  istaRealStatus({ items: [{ k: 'Filter:', v: 'Default' }] });
  istaBottomBar(sub.id, {
    'delete-faults': null,
    'filter-faults': null,
    'show-all': null,
    filters: null,
    display: null,
    back: () => showIsta(istaState.tab, istaState.sub, istaState.sub3),
  });
}

/**
 * Give the drawn bus map ISTA's own behaviour: hover shows the unit's
 * details, a click SELECTS it and nothing else.
 *
 * The app's own tree opens a module when a box is clicked, which is one
 * click too few for this tool: ISTA selects, and the window is a separate,
 * deliberate press of Call up ECU functions. So the box's own handler is
 * replaced rather than wrapped.
 * @param {IstaSlot[]} slots - the car's slots
 * @param {string} chassis - the chassis id
 * @param {(p: {slot: object, box: object}|null) => void} onPick - selection
 * @returns {void}
 */
function istaTreeBind(slots, chassis, onPick) {
  if (typeof document === 'undefined') return;
  const host = document.getElementById('view');
  if (!host) return;
  let tip = null;
  const drop = () => {
    if (tip && tip.parentNode) tip.parentNode.removeChild(tip);
    tip = null;
  };
  host.querySelectorAll('.tree-box').forEach((el) => {
    // the tree stamps data-key as "<name>@<addr>", which is the box's own
    // identity; its text is a caption that may have been shortened
    const key = String(el.getAttribute('data-key') || '');
    const at = key.lastIndexOf('@');
    const name = at > 0 ? key.slice(0, at) : key;
    const addr = at > 0 ? key.slice(at + 1) : '';
    // the slot carries the box it was keyed on, so a box matches its own
    // slot by identity rather than by a name that may have been replaced
    // with the identified variant's
    const slot =
      (slots || []).find(
        (x) =>
          (x.box && x.box.name === name && String(x.box.addr) === addr) ||
          (x.box && x.box.name === name)
      ) || null;
    const box = {
      name,
      addr: slot && slot.box ? slot.box.addr : addr,
      bus: slot && slot.box ? slot.box.bus : '',
      col: slot && slot.box ? slot.box.col : null,
      row: slot && slot.box ? slot.box.row : null,
    };
    el.onmouseenter = () => {
      if (typeof istaEcuTip !== 'function') return;
      drop();
      const d = document.createElement('div');
      d.className = 'irtip-wrap';
      d.innerHTML = istaEcuTip(box, slot);
      document.body.appendChild(d);
      // anchored below the box, and pulled back inside the window when the
      // box sits near its right or bottom edge
      const r = el.getBoundingClientRect();
      const t = d.getBoundingClientRect();
      const x = Math.min(r.left, window.innerWidth - t.width - 8);
      const y =
        r.bottom + t.height + 8 > window.innerHeight
          ? Math.max(4, r.top - t.height - 4)
          : r.bottom + 4;
      d.style.left = `${Math.round(Math.max(4, x))}px`;
      d.style.top = `${Math.round(y)}px`;
      tip = d;
    };
    el.onmouseleave = drop;
    el.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      host.querySelectorAll('.tree-box.ista-sel').forEach((x) => {
        x.classList.remove('ista-sel');
      });
      el.classList.add('ista-sel');
      if (onPick) onPick(slot ? { slot, box } : null);
    };
  });
}

/**
 * The car's control unit slots, with what the newest scans found in each.
 *
 * Both scans are asked for: the fault scan says which slots hold faults, the
 * identification scan says WHICH VARIANT is in a slot. They are different
 * reads and a car may have had only one of them.
 * @param {string} chassis - the chassis id
 * @param {object|null} car - the picked GarageCar
 * @returns {Promise<IstaSlot[]>}
 */
async function istaLoadSlots(chassis, car) {
  // the bus map comes along because it is the authority on what counts as
  // ONE control unit: an E46's DME is filed under two group files, and only
  // the map's box says they are the same unit
  const [cfg, tree] = await Promise.all([
    istaProbe(() => api(`/api/chassis/${chassis}`)),
    istaProbe(() =>
      typeof ecuTreeForChassis === 'function'
        ? ecuTreeForChassis(chassis)
        : null
    ),
  ]);
  const scans =
    car && typeof garageScans === 'function' ? garageScans(car.id) : [];
  let faults = (scans.find((x) => x.kind === 'faults') || {}).report || null;
  let ident = (scans.find((x) => x.kind === 'ident') || {}).report || null;
  // A READ IN PROGRESS REPLACES THE STORED ONE ENTIRELY. The test paints the
  // screen it is already on as each module answers, the way the tree app's
  // own Fault scan does. Falling back to the LAST scan for the half that has
  // not answered yet would paint the previous run's colours as though they
  // were this one's -- a module cleared since then would still show amber,
  // and the whole tree came up coloured before a single module had replied.
  // While a test runs, only what this test has heard is drawn.
  const now = istaTestLive() || istaTestDone;
  if (now) {
    ident = now.ident || ident;
    faults = now.faults || faults;
  }
  // while a test is RUNNING, only what it has heard is drawn: falling back
  // to the last scan would paint the previous run's colours as this one's
  if (istaTestLive()) {
    ident = istaTestLive().ident || null;
    faults = istaTestLive().faults || null;
  }
  return typeof istaSlots === 'function'
    ? istaSlots(cfg, faults, ident, tree)
    : [];
}

/** @type {{ident: object|null, faults: object|null}|null} the live read */
let istaTestLiveState = null;

/**
 * The vehicle test's reads so far, while one is running.
 * @returns {{ident: object|null, faults: object|null}|null}
 */
function istaTestLive() {
  return istaTestLiveState;
}

/**
 * Open the control unit window for a slot.
 *
 * The module's decoded script comes with it, because the window's two live
 * tabs list the screens that script offers. A slot nothing has identified
 * has no script to list, and the window says so on its Identification tab
 * rather than guessing which of eight candidates to load.
 * @param {object} slot - the slot, from istaSlots
 * @param {object|null} box - its tree box, when opened from the map
 * @param {string} chassis - the chassis id
 * @returns {Promise<void>}
 */
async function istaOpenEcuWindow(slot, box, chassis) {
  if (!slot || typeof istaEcuWindow !== 'function') return;
  // the same endpoint the module view reads its script from, so the window
  // lists exactly the screens that view would offer
  const code =
    slot.ecu && slot.ecu.code
      ? `?code=${encodeURIComponent(slot.ecu.code)}`
      : '';
  // AN UNIDENTIFIED SLOT IS IDENTIFIED BEFORE IT IS TALKED TO. A slot no
  // scan has read has only its candidates -- one for most, eight for an
  // E46 engine -- and the tool's function lists are per variant. Sending
  // a candidate's jobs on the wire is sending MS42 jobs to an MSS54, so
  // the slot's group is probed first, the way the vehicle test identifies
  // it; the car's own answer picks the variant. When nothing answers (no
  // cable, or a module that is not there) the window lists the first
  // candidate's functions to read, says so, and refuses to send them.
  let variant = slot.sgbd || '';
  let identified = !!variant;
  if (!variant && typeof webResolveVariant === 'function') {
    const groups = [slot.group]
      .concat((slot.box && slot.box.groups) || [])
      .map((g) => String(g || '').toLowerCase())
      .filter((g, i, a) => g && a.indexOf(g) === i);
    for (const g of groups) {
      const got = await istaProbe(() => webResolveVariant(g));
      if (got) {
        variant = String(got).toLowerCase();
        identified = true;
        break;
      }
    }
  }
  const candidates = (slot.candidates || [])
    .map((c) => c && String(c.sgbd || '').toLowerCase())
    .filter((n, i, a) => n && a.indexOf(n) === i);
  let fn = variant ? await istaEcuFnLoad(variant) : null;
  if (!variant) {
    for (const n of candidates) {
      fn = await istaEcuFnLoad(n);
      if (fn) {
        variant = n;
        break;
      }
    }
    if (!variant && candidates.length) variant = candidates[0];
  }
  const ir = variant
    ? await istaProbe(() => api(`/api/ecu/${variant}/ir${code}`))
    : null;
  istaEcuWindow({
    slot,
    box,
    ir,
    fn,
    notice: identified
      ? ''
      : `Control unit not identified. The lists show candidate ` +
        `${variant || '-'}; run Identification (Start vehicle test) ` +
        `before reading or triggering it.`,
    runJob: async (job, args, write) => {
      if (!identified)
        throw new Error(
          'control unit not identified: run Identification first'
        );
      // the same rule the raw job runner follows: a job that commands the
      // ECU asks first unless the user turned actuator confirmations off
      if (
        write &&
        (typeof confirmActuators !== 'function' || confirmActuators())
      ) {
        const okGo =
          typeof confirmDialog === 'function'
            ? await confirmDialog({
                title: `${job} commands ${slot.abbr || variant}`,
                body:
                  'This function drives a component rather than reading ' +
                  'it. Make sure the module and anything it moves are safe.',
                confirmLabel: 'Trigger',
                danger: true,
              })
            : true;
        if (!okGo) return null;
      }
      const q = args ? `?arg=${encodeURIComponent(args)}` : '';
      return api(`/api/ecu/${variant}/run/${encodeURIComponent(job)}${q}`, {
        method: 'POST',
      });
    },
    run: async (screen) => {
      // RUNNING A SCREEN IS LEAVING THIS WINDOW. The app already has one
      // path that opens a module at a named screen, with the confirm on
      // anything that writes and the release-on-leave that a live actuator
      // needs; re-implementing a second runner inside a dialog would be a
      // second place for those promises to be got wrong. So the window
      // closes and the module view opens where it was pointed.
      if (typeof showEcu !== 'function' || !slot.ecu) return [];
      await istaOpen({
        label: slot.name || slot.abbr,
        _call: () =>
          showEcu(chassis, slot.section, slot.ecu, null, screen.name),
      });
      return [];
    },
  });
}

/**
 * The Service plan's Test plan, for the car in front of the shell.
 *
 * The plan is stored per car (plan.js); this is the shell's reader of it.
 * @param {object|null} [car] - the picked GarageCar; the shell's by default
 * @returns {object[]} the rows, in the tool's Priority order
 */
function istaTestPlan(car) {
  const c = car === undefined ? istaState.car : car;
  if (typeof istaPlanRows !== 'function') return [];
  return typeof istaPlanSort === 'function'
    ? istaPlanSort(istaPlanRows(c), istaState.planDesc)
    : istaPlanRows(c);
}

/** Hosted copy of the tool's control-unit function lists. */

/**
 * The tool's function lists for one ECU variant, local first then the
 * dataset; null when neither ships it (36 configured modules have none).
 * @param {string} variant - the SGBD name
 * @returns {Promise<object|null>}
 */
async function istaEcuFnLoad(variant) {
  const v = String(variant || '').toLowerCase();
  if (!v || typeof fflate === 'undefined') return null;
  const base = typeof WEB_BASE === 'string' && WEB_BASE ? WEB_BASE : '.';
  const real =
    typeof webRealFetch === 'function'
      ? webRealFetch
      : window.fetch.bind(window);
  for (const u of [
    `${base}/data/ista/ecufn/${v}.json.gz`,
    ...hfUrls(`ista/ecufn/${v}.json.gz`).slice(1),
  ]) {
    try {
      const r = await real(u);
      if (!r || !r.ok) continue;
      const bytes = new Uint8Array(await r.arrayBuffer());
      return JSON.parse(
        new TextDecoder('utf-8').decode(fflate.gunzipSync(bytes))
      );
    } catch (e) {
      /* try the next source */
    }
  }
  return null;
}

/** Hosted copy of the diagnosis structures, beside the repair extract. */

/**
 * Fetch one diagnosis-structure file, local first then the dataset.
 *
 * The same rule as repairUrls: a build with a local extract never reaches
 * the network, and the hosted site, which ships no data/ista/diag, still
 * finds the file. Null when neither answers.
 * @param {string} rel - the path under data/ista/diag/
 * @returns {Promise<Response|null>}
 */
async function istaDiagFetch(rel) {
  const cut = String(rel || '').indexOf('/');
  if (cut > 0 && typeof istaBundleFile === 'function') {
    const hit = await istaBundleFile(
      rel.slice(0, cut),
      `diag/${rel.slice(cut + 1)}`
    );
    if (hit) return hit;
  }
  const real =
    typeof webRealFetch === 'function'
      ? webRealFetch
      : window.fetch.bind(window);
  for (const u of hfUrls(`ista/diag/${rel}`)) {
    try {
      const r = await real(u);
      if (r && r.ok) return r;
    } catch (e) {
      /* try the next source */
    }
  }
  return null;
}

/**
 * The body text of every diagnosis document for a chassis, by id.
 *
 * The extract ships one lowercased blob so the page can offer a full-text
 * search without fetching thousands of per-document files. A build without
 * it gets an empty map, and the scope says it has no index rather than
 * silently matching nothing.
 * @param {string} chassis - the chassis id
 * @returns {Promise<Map<string, string>>}
 */
async function istaDiagBodies(chassis) {
  const code = String(chassis || '').toUpperCase();
  const out = new Map();
  if (!code) return out;
  const raw = await istaProbe(async () => {
    const r = await istaDiagFetch(`${code}/search-index.json.gz`);
    if (!r || typeof fflate === 'undefined') return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    return JSON.parse(
      new TextDecoder('utf-8').decode(fflate.gunzipSync(bytes))
    );
  });
  for (const [id, text] of Object.entries(raw || {}))
    out.set(String(id), String(text || ''));
  return out;
}

/**
 * Open one diagnosis document in the viewer.
 * @param {string} chassis - the chassis id
 * @param {object} doc - the document row
 * @returns {Promise<void>}
 */
async function istaOpenDiagDoc(chassis, doc) {
  if (!doc || typeof openModal !== 'function') return;
  const body = await istaDiagBody(chassis, doc);
  const { overlay, close } = openModal(
    `<div class="modal irdoc" role="dialog" aria-modal="true">` +
      `<div class="irdoc-title">${esc(
        `${doc.type || ''} ${doc.title || ''}`.trim()
      )}</div>` +
      `<div class="irdoc-body ista-repair">${body}</div>` +
      `<div class="modal-actions">` +
      `<button type="button" class="btn irdoc-close">Close</button>` +
      `</div></div>`
  );
  overlay.querySelector('.irdoc-close').onclick = () => close();
}

/**
 * The Workshop page's Filter dialog.
 *
 * One checkbox, because the app's page has one filter worth exposing: by
 * default it shows the documents that apply to THIS car, and Show all drops
 * that scoping. The checkbox it drives is the page's own, so the two cannot
 * disagree about what is on screen.
 * @param {HTMLElement} host - the page
 * @returns {void}
 */
function istaTechDataFilter(host) {
  const box = host.querySelector('#td-all');
  if (!box || typeof openModal !== 'function') return;
  const { overlay, close } = openModal(
    `<div class="modal iradmin" role="dialog" aria-modal="true">` +
      `<div class="modal-title iradmin-title">Filter</div>` +
      `<div class="iradmin-host"><div class="iradmin-row">` +
      `<label class="iradmin-opt"><input type="checkbox" id="ista-td-only"` +
      `${box.checked ? '' : ' checked'} /> ` +
      `<span>Only this vehicle</span></label></div></div>` +
      `<div class="modal-actions iradmin-actions">` +
      `<button type="button" class="btn iradmin-cancel">Cancel</button>` +
      `<button type="button" class="btn iradmin-ok">OK</button>` +
      `</div></div>`
  );
  overlay.querySelector('.iradmin-cancel').onclick = () => close();
  overlay.querySelector('.iradmin-ok').onclick = () => {
    const only = overlay.querySelector('#ista-td-only').checked;
    // "Only this vehicle" is the inverse of the page's "Show all"
    if (box.checked === only) box.click();
    close();
  };
}

/**
 * Open the vehicle a set of basic features narrowed to.
 *
 * There is no VIN here, so the car is filed by what the catalogue says it
 * is. The Garage keeps it like any other, which is what lets its scans be
 * stored against it afterwards.
 * @param {object} row - the single matching catalogue row
 * @returns {Promise<void>}
 */
async function istaOpenBasic(row) {
  if (!row) return;
  let car = null;
  // a build date the characteristic tree does not carry is LEFT OUT, not
  // stored as an empty string: a car saved with prod '' reads as dateless
  // forever, and every dated validity rule stays undecided for it
  const prod = `${row._year || ''}${row._month || ''}`;
  if (typeof garageAddCar === 'function')
    car = garageAddCar({
      chassis: row.chassis,
      model: row.model,
      body: row.body,
      motor: row.motor,
      ...(prod ? { prod } : {}),
    });
  if (car) istaSetCar(car);
  else istaSetCar(null, row.chassis);
  return istaGo('information', 'details', null);
}

/**
 * Open a stored scan's report inside the shell.
 * @param {object} scan - a GarageScan
 * @returns {Promise<void>}
 */
function istaOpenStoredScan(scan) {
  if (!scan) return Promise.resolve();
  // inside the shell the scan is redrawn in the tool's own language rather
  // than opening the Garage's INPA-faithful sheet; outside it, that sheet is
  // still the right thing and nothing here changes it
  if (!istaSkinOn()) {
    if (typeof showGarageScan !== 'function' || !istaState.car)
      return Promise.resolve();
    return istaOpen({
      label: 'Operations report',
      _call: () => showGarageScan(istaState.car.id, scan.id),
    });
  }
  view.innerHTML = '';
  const host = document.createElement('div');
  view.appendChild(host);
  istaPageReport(host, scan);
  const sum = scan.summary || {};
  istaRealStatus({
    items: [
      { k: 'Modules:', v: String(sum.modules || 0) },
      { k: 'Faults:', v: String(sum.faults || 0) },
    ],
  });
  istaBottomBar('report', {
    close: () => showIsta(istaState.tab, istaState.sub, istaState.sub3),
  });
  return Promise.resolve();
}
