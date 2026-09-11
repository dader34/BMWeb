/**
 * @file The ISTA shell: workshop mode. A banner and a tab bar that stay up
 * while the app's own screens render underneath them.
 *
 * Nothing in here is a second copy of a screen. Every sub-tab resolves to a
 * show*() the app already has, called with the picked car filled in; the
 * shell's job is to be the frame around it and to know which of them exist
 * on this car. The pages it does draw itself (details.js, pages.js) are the
 * ones the app had no screen for.
 *
 * TWO FACES, ONE SHELL. With the layout setting on INPA (inpaMode, which
 * skin.js reads through istaSkinOn) the chrome is the workshop tool's own,
 * 1:1: toolbar row, header line, black tab bar, sub-tab strips, status line,
 * bottom button bar. With it on Modern, none of that is drawn and the shell
 * keeps the banner-and-pills look it had. The routing, the readiness checks
 * and the openers below are shared -- only the paint differs, so a tab
 * cannot work in one face and be missing in the other.
 *
 * HOW THE ROUTE SURVIVES. setCrumbs syncs the hash from `lastScreen` on
 * every render, so a wrapped screen would rewrite `#ista/...` into its own
 * route the moment it drew. istaOpen therefore sets `lastScreen` back to the
 * shell and re-stamps the hash AFTER the screen has rendered -- the screen
 * keeps its body, the shell keeps its URL, and Back lands in the shell.
 */

/* exported showIsta */

/** Settings key holding the car the shell was last pointed at. */
const ISTA_CAR_KEY = 'bmweb.ista.car';

/** Settings key holding the chassis, for a shell with no saved car. */
const ISTA_CHASSIS_KEY = 'bmweb.ista.chassis';

/**
 * What the shell is pointed at now.
 * @type {{car: object|null, chassis: string, tab: string, sub: string|null,
 *   sub3: string|null, etk: object|null, tested: boolean}}
 */
const istaState = {
  car: null,
  chassis: '',
  tab: ISTA_HOME_TAB,
  sub: null,
  sub3: null,
  etk: null,
  tested: false,
};

/**
 * The chassis the shell works on: the picked car's, else the remembered one.
 * @returns {string} upper-case chassis id, or ''
 */
function istaChassis() {
  if (istaState.car && istaState.car.chassis)
    return String(istaState.car.chassis).toUpperCase();
  return String(istaState.chassis || '').toUpperCase();
}

/**
 * Point the shell at a car (or, with null, at a bare chassis) and remember
 * it for next time.
 * @param {object|null} car - a GarageCar, or null
 * @param {string} [chassis] - the chassis, when there is no car
 * @returns {void}
 */
function istaSetCar(car, chassis) {
  istaState.car = car || null;
  istaState.chassis = String(
    (car && car.chassis) || chassis || ''
  ).toUpperCase();
  // the VIN decode behind the header line and the details grid; it is a
  // catalogue lookup, not a read, so it costs the car nothing
  istaState.etk = null;
  if (car && car.vin && typeof viEtkDecode === 'function')
    viEtkDecode(car.vin)
      .then((e) => {
        if (istaState.car === car) {
          istaState.etk = e;
          if (istaChromeActive()) istaPaintChrome();
        }
      })
      .catch(() => {
        /* the parts index is optional */
      });
  if (typeof Settings === 'object' && Settings && Settings.set) {
    Settings.set(ISTA_CAR_KEY, car ? car.id : '');
    Settings.set(ISTA_CHASSIS_KEY, istaState.chassis);
  }
}

/**
 * Restore the remembered car, or fall back to the newest saved one. A
 * remembered car that has since been deleted falls back rather than leaving
 * the shell pointed at nothing.
 * @param {string|null} [carId] - a car id from the route, which wins
 * @returns {void}
 */
function istaRestoreCar(carId) {
  const cars = typeof garageCars === 'function' ? garageCars() : [];
  const want =
    carId ||
    (typeof Settings === 'object' && Settings && Settings.get
      ? Settings.get(ISTA_CAR_KEY, '')
      : '');
  const found = want ? cars.find((c) => c.id === want) : null;
  if (found) return istaSetCar(found);
  const chassis =
    typeof Settings === 'object' && Settings && Settings.get
      ? Settings.get(ISTA_CHASSIS_KEY, '')
      : '';
  if (cars.length) return istaSetCar(cars[0]);
  istaSetCar(null, chassis);
}

// ---- the openers -----------------------------------------------------------
// Each one is named in ISTA_TABS by string, and each is a thin call into a
// screen the app already ships. They exist so the tab table stays a table:
// the argument shuffling (which car, which menu key, which caption) lives
// here, once per tab, instead of in the model.

/**
 * The whole-car fault menu, filed against the picked car. Nothing is pressed
 * on arrival: the scan is the user's key, the tab only takes them to it.
 * @returns {void}
 */
function istaOpenFaultMemory() {
  const car = istaState.car;
  if (car && typeof garageRunScan === 'function')
    return garageRunScan(car, IPO_VEHICLE_FAULT_MENU, null);
  showVehicleScript(istaChassis(), IPO_VEHICLE_FAULT_MENU, null, null);
}

/**
 * The vehicle test: the bus map, with its Fault scan key. Nothing runs on
 * arrival; the read is the user's key.
 * @returns {Promise<void>}
 */
function istaOpenVehicleTest() {
  return showEcuTreeChassis(
    istaChassis(),
    istaState.car ? istaState.car.id : null
  );
}

/**
 * The whole-car script's main menu, filed against the picked car. Its Ident
 * key is the read; nothing is pressed on arrival.
 * @returns {void}
 */
function istaOpenIdentScan() {
  const car = istaState.car;
  if (car && typeof garageRunScan === 'function')
    return garageRunScan(car, null, null);
  showVehicleScript(istaChassis(), null, null, null);
}

/**
 * The service functions for this car.
 * @returns {Promise<void>}
 */
function istaOpenService() {
  return showService(istaChassis(), null, '');
}

/**
 * The service-reset routines. Same screen as Service functions -- the shell
 * lists it under the service plan too because that is where a workshop
 * looks for it, not because it is a second app.
 * @returns {Promise<void>}
 */
function istaOpenServiceResets() {
  return showService(istaChassis(), null, 'Service reset');
}

/**
 * The bus map.
 * @returns {Promise<void>}
 */
function istaOpenTree() {
  return showEcuTreeChassis(
    istaChassis(),
    istaState.car ? istaState.car.id : null
  );
}

/**
 * Every scan kept against this car.
 * @returns {Promise<void>}
 */
function istaOpenHistory() {
  return showGarageCar(istaState.car.id);
}

/**
 * The newest stored read, as its report. Routed through showGarageScan
 * rather than rendered here: that screen disarms the stored report's Clear
 * buttons, which would otherwise erase faults on whatever car is on the
 * cable right now.
 * @returns {Promise<void>}
 */
function istaOpenLatestReport() {
  const scans =
    typeof garageScans === 'function' ? garageScans(istaState.car.id) : [];
  return showGarageScan(istaState.car.id, scans[0].id);
}

/**
 * What the car reports about its own build.
 * @returns {Promise<void>}
 */
function istaOpenIdentity() {
  // the tab lands on the screen; the read is the user's key
  return showVehicleIdentity(istaChassis(), { idle: true });
}

/**
 * The chassis's module list, in whichever layout the user chose.
 *
 * NOT backToModules: that picks the right screen for the layout but returns
 * nothing, so awaiting it resolves before either async screen has painted --
 * and the shell would then re-stamp its F-keys over a pane still showing the
 * previous tab. Making the same choice here lets the promise come back.
 * @returns {Promise<void>}
 */
function istaOpenModules() {
  const id = istaChassis();
  if (typeof inpaMode === 'function' && inpaMode())
    // aborting INPA's picker leaves the popup, not the shell
    return showScriptSelection(id, () => showIsta(istaState.tab, null));
  return showSections(id);
}

/**
 * Coding: the chassis's coding hub (dev hosts only, see the model).
 * @returns {Promise<void>}
 */
function istaOpenCoding() {
  return showCodingHub(istaChassis());
}

/**
 * Await a probe, treating a throw as "no".
 *
 * Every readiness check below asks something optional -- does a tree ship for
 * this chassis, does any module hold the build record -- and each of those
 * can throw on a build without the data behind it. A throw means the same
 * thing as a false here: the tab greys with its reason rather than the shell
 * failing to draw.
 * @param {() => Promise<*>} probe - the check
 * @returns {Promise<*>} what it answered, or null when it threw
 */
async function istaProbe(probe) {
  try {
    return await probe();
  } catch (e) {
    return null;
  }
}

/**
 * Is a leaf openable on the car the shell is pointed at?
 *
 * This is where a grey row stops being a guess. A leaf can be dark for
 * three different reasons and the shell says which: the model marked it
 * `why` (nothing to open, ever, or not yet); the screen it names did not
 * ship in this build; or it needs something this particular car has not got
 * -- a whole-car script (only 10 of 27 chassis ship one), a saved car, a
 * stored scan.
 * @param {IstaSub|IstaSub3} sub - the leaf
 * @returns {Promise<{ok: boolean, why: string}>}
 */
async function istaSubReady(sub) {
  if (!sub) return { ok: false, why: 'no such tab' };
  if (sub.why) return { ok: false, why: sub.why };
  if (sub.needsCar && !istaChassis())
    return { ok: false, why: 'no vehicle picked' };
  if (sub.page) {
    // the workshop browser is nothing without its extract, so it says so;
    // every other page the shell draws always has something to draw
    if (sub.page === 'techdata') {
      if (typeof showTechData !== 'function')
        return { ok: false, why: 'not in this build' };
      const has = await istaProbe(() =>
        typeof techDataIndexPresent === 'function'
          ? techDataIndexPresent()
          : false
      );
      if (!has)
        return { ok: false, why: 'no workshop reference data in this build' };
    }
    // the repair manual ships per chassis, so "is it here" is asked of THIS
    // car's chassis, not of the extract as a whole: a build can carry E46's
    // manual and not F30's, and saying so is more use than a blank pane
    if (sub.page === 'repair') {
      if (typeof showRepair !== 'function')
        return { ok: false, why: 'not in this build' };
      const chassis = istaChassis();
      const has = await istaProbe(() =>
        typeof repairIndexPresent === 'function'
          ? repairIndexPresent(chassis)
          : false
      );
      if (!has)
        return {
          ok: false,
          why: `no repair data in this build for ${chassis}`,
        };
    }
    return { ok: true, why: '' };
  }
  const fn = sub.open ? window[sub.open] : null;
  if (typeof fn !== 'function') return { ok: false, why: 'not in this build' };

  // the per-car checks, by leaf id
  const chassis = istaChassis();
  if (sub.id === 'conversion-coding' || sub.id === 'remove-coding') {
    const has =
      typeof chassisHasCoding === 'function' &&
      (await istaProbe(chassisHasCoding(chassis)));
    if (!has) return { ok: false, why: 'no codeable modules for this chassis' };
  }
  if (sub.id === 'fault-memory' || sub.id === 'unit-list') {
    if (typeof vehicleScriptShipped === 'function') {
      const has = await vehicleScriptShipped(chassis);
      if (!has)
        return {
          ok: false,
          why: `no whole-car script ships for ${chassis}`,
        };
    }
  }
  if (sub.id === 'tree') {
    if (typeof ecuTreeNameFor === 'function') {
      const name = await istaProbe(() => ecuTreeNameFor(chassis));
      if (!name) return { ok: false, why: `no bus map ships for ${chassis}` };
    }
  }
  if ((sub.id === 'history' || sub.id === 'finished') && !istaState.car)
    return { ok: false, why: 'no saved car: add one in the Garage first' };
  if (sub.id === 'report') {
    if (!istaState.car)
      return { ok: false, why: 'no saved car: add one in the Garage first' };
    const scans =
      typeof garageScans === 'function' ? garageScans(istaState.car.id) : [];
    if (!scans.length) return { ok: false, why: 'no scan stored yet' };
  }
  if (
    sub.id === 'service-functions' &&
    typeof serviceIndexPresent === 'function'
  ) {
    const has = await istaProbe(() => serviceIndexPresent());
    if (!has) return { ok: false, why: 'no service mapping in this build' };
  }
  if (sub.id === 'text-search' && typeof searchIndexPresent === 'function') {
    const has = await istaProbe(() => searchIndexPresent());
    if (!has) return { ok: false, why: 'no job index in this build' };
  }
  return { ok: true, why: '' };
}

// ---- the chrome ------------------------------------------------------------

/**
 * Draw the chrome, in whichever face the layout setting asks for.
 *
 * The setting is re-read HERE, on every paint, rather than cached: Settings
 * fires no change event, and the Settings screen simply re-renders itself,
 * so the shell's next paint is the first moment it can notice. Coming back
 * to the shell after flipping the switch therefore lands on the right face.
 * @returns {void}
 */
function istaPaintChrome() {
  const el = istaChromeEnsure();
  if (!el) return;
  const real = istaSkinOn();
  el.classList.toggle('ista-real', real);
  if (typeof document !== 'undefined')
    document.body.classList.toggle('ista-real-body', real);
  if (real) return istaPaintRealChrome(el);
  istaRealStatus(null);
  istaRealBottom(null);
  istaPaintModernChrome(el);
}

/**
 * Paint the workshop tool's own chrome.
 * @param {HTMLElement} el - the chrome container
 * @returns {void}
 */
function istaPaintRealChrome(el) {
  istaPaintReal(el, {
    car: istaState.car,
    etk: istaState.etk,
    tested: istaState.tested,
    tab: istaState.tab,
    sub: istaState.sub,
    sub3: istaState.sub3,
    go: (kind, ids) => {
      if (kind === 'tab') return istaGo(ids.tab, null, null);
      if (kind === 'sub') return istaGo(ids.tab, ids.sub, null);
      return istaGo(istaState.tab, istaState.sub, ids.sub3);
    },
    act: (a) => istaToolbarAct(a),
    pin: (ids) => {
      istaFavouriteToggle(ids.tab, ids.sub, ids.sub3);
      istaPaintChrome();
    },
  });
  istaBannerSync();
  if (typeof tipify === 'function') tipify(el);
}

/**
 * A toolbar icon was pressed.
 * @param {string} act - which one
 * @returns {void}
 */
function istaToolbarAct(act) {
  if (act === 'home' || act === 'close') {
    istaChromeHide();
    return act === 'home' && typeof showApps === 'function'
      ? showApps()
      : showChassis();
  }
  if (act === 'print') return window.print();
  if (act === 'settings')
    // a WINDOW over the page, not a navigation: the real tool never leaves
    // the vehicle to change a setting, and neither does this
    return typeof istaAdminOpen === 'function'
      ? istaAdminOpen(() =>
          showIsta(istaState.tab, istaState.sub, istaState.sub3)
        )
      : undefined;
  if (act === 'help')
    return typeof showDocs === 'function'
      ? showDocs()
      : window.open('README.md', '_blank');
  // NO CAR PICKER. ISTA opens a vehicle in exactly one place, Operations /
  // New, and a second way in is a second answer to "which car is this" --
  // the one question a workshop tool must never have two of.
  if (act === 'sessions') return istaGo('operations', 'new', 'vin');
  // tile and restore are window-manager buttons of the real tool's own
  // desktop shell: drawn so the row is the row, inert because a browser tab
  // has no windows to tile
}

/**
 * Draw the modern chrome: the banner and the pill tabs the shell had before
 * the workshop layout existed.
 * @param {HTMLElement} el - the chrome container
 * @returns {void}
 */
function istaPaintModernChrome(el) {
  const tabs = ISTA_TABS.map((t) => {
    const on = t.id === istaState.tab;
    return (
      `<button type="button" class="ista-tab${on ? ' on' : ''}" ` +
      `data-tab="${esc(t.id)}"${on ? ' aria-current="page"' : ''}>` +
      `${esc(String(t.label).replace(/\n/g, ' '))}</button>`
    );
  }).join('');
  const subs = istaSubsOf(istaState.tab);
  const subs3 = istaState.sub ? istaSubs3Of(istaState.tab, istaState.sub) : [];
  const stripOf = (rows, level) =>
    rows.length
      ? `<div class="ista-subs">` +
        rows
          .map((s) => {
            const owner = level === 2 ? s._tab || istaState.tab : istaState.tab;
            const on =
              level === 2
                ? s.id === istaState.sub && owner === istaState.tab
                : s.id === istaState.sub3;
            const pinned =
              level === 2
                ? istaIsFavourite(owner, s.id)
                : istaIsFavourite(istaState.tab, istaState.sub, s.id);
            const attr =
              level === 2
                ? `data-sub="${esc(s.id)}" data-owner="${esc(owner)}"`
                : `data-sub3="${esc(s.id)}"`;
            const star =
              level === 2
                ? `data-star="${esc(s.id)}" data-owner="${esc(owner)}"`
                : `data-star3="${esc(s.id)}"`;
            return (
              `<span class="ista-sub-wrap">` +
              `<button type="button" class="ista-sub${on ? ' on' : ''}" ` +
              `${attr}>${esc(s.label)}</button>` +
              `<button type="button" class="ista-star${pinned ? ' on' : ''}" ` +
              `${star} ` +
              `title="${pinned ? 'Unpin from Favourites' : 'Pin to Favourites'}" ` +
              `aria-label="${pinned ? 'Unpin' : 'Pin'} ${esc(s.label)}">` +
              `★</button></span>`
            );
          })
          .join('') +
        `</div>`
      : '';

  el.innerHTML =
    istaBannerHtml(istaState.car, istaState.chassis) +
    `<div class="ista-tabs" role="tablist">${tabs}</div>` +
    stripOf(subs, 2) +
    stripOf(subs3, 3);

  el.querySelectorAll('.ista-tab[data-tab]').forEach((b) => {
    b.onclick = () => istaGo(b.dataset.tab, null, null);
  });
  el.querySelectorAll('.ista-sub[data-sub]').forEach((b) => {
    b.onclick = () => istaGo(b.dataset.owner, b.dataset.sub, null);
  });
  el.querySelectorAll('.ista-sub[data-sub3]').forEach((b) => {
    b.onclick = () => istaGo(istaState.tab, istaState.sub, b.dataset.sub3);
  });
  el.querySelectorAll('.ista-star[data-star]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      istaFavouriteToggle(b.dataset.owner, b.dataset.star);
      istaPaintChrome();
    };
  });
  el.querySelectorAll('.ista-star[data-star3]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      istaFavouriteToggle(istaState.tab, istaState.sub, b.dataset.star3);
      istaPaintChrome();
    };
  });
  const pick = el.querySelector('#ista-car-pick');
  if (pick) pick.onclick = () => istaPickCar();
  istaBannerSync();
  if (typeof tipify === 'function') tipify(el);
}

/**
 * The car picker: every saved car, plus every chassis the build ships so a
 * car nobody saved still works.
 * @returns {Promise<void>}
 */
async function istaPickCar() {
  const cars = typeof garageCars === 'function' ? garageCars() : [];
  // every chassis the build ships, so a car nobody saved still works
  const ids = (await istaProbe(() => api('/api/chassis'))) || [];
  const rows =
    cars
      .map(
        (c) =>
          `<button type="button" class="ista-pick-row" data-car="${esc(c.id)}">` +
          `<span class="ista-pick-name">${esc(garageCarLabel(c))}</span>` +
          `<span class="ista-pick-bits">${esc(
            [
              typeof dispChassis === 'function'
                ? dispChassis(c.chassis)
                : c.chassis,
              istaCarBits(c),
              c.vin,
            ]
              .filter(Boolean)
              .join(' · ')
          )}</span></button>`
      )
      .join('') +
    ids
      .map(
        (id) =>
          `<button type="button" class="ista-pick-row ista-pick-bare" ` +
          `data-chassis="${esc(id)}">` +
          `<span class="ista-pick-name">${esc(
            typeof dispChassis === 'function' ? dispChassis(id) : id
          )}</span>` +
          `<span class="ista-pick-bits">chassis only, no saved car</span>` +
          `</button>`
      )
      .join('');

  const html =
    `<div class="modal ista-pick-modal" role="dialog" aria-modal="true">` +
    `<div class="modal-title">Which vehicle?</div>` +
    `<div class="modal-body ista-pick">` +
    (cars.length
      ? ''
      : `<p class="ista-pick-note">No saved cars yet. Pick a chassis to ` +
        `work on, or add a car in the Garage to keep its scans.</p>`) +
    rows +
    `</div>` +
    `<div class="modal-actions">` +
    `<button type="button" class="btn ista-pick-cancel">Cancel</button>` +
    `</div></div>`;
  const { overlay, close } = openModal(html);
  overlay.querySelectorAll('.ista-pick-row').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.car) {
        const c = cars.find((x) => x.id === b.dataset.car);
        if (c) istaSetCar(c);
      } else if (b.dataset.chassis) {
        istaSetCar(null, b.dataset.chassis);
      }
      close();
      // the picked car changes what every tab can do, so redraw from the top
      showIsta(istaState.tab, istaState.sub, istaState.sub3);
    };
  });
  const cancel = overlay.querySelector('.ista-pick-cancel');
  if (cancel) cancel.onclick = () => close();
}

/**
 * Navigate inside the shell.
 * @param {string} tab - the tab id
 * @param {string|null} sub - the sub-tab id, or null for the tab's first
 * @param {string|null} [sub3] - the level-3 tab id, or null for the first
 * @returns {Promise<void>}
 */
async function istaGo(tab, sub, sub3) {
  const t = istaTab(tab) ? tab : ISTA_HOME_TAB;
  const s = sub || (istaFirstSub(t) || {}).id || null;
  const s3 = sub3 || (s ? (istaFirstSub3(t, s) || {}).id || null : null);
  return showIsta(t, s, s3);
}

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
      label: 'ISTA',
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
 * a fact about that page rather than a template every page inherits -- which
 * is what used to put the pair of nav arrows on pages the frames show
 * without them.
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
    return {
      label: b.label,
      fn: fn || null,
      off: !!b.off || !fn,
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
  const faults = (scans.find((x) => x.kind === 'faults') || {}).report || null;
  const ident = (scans.find((x) => x.kind === 'ident') || {}).report || null;
  return typeof istaSlots === 'function'
    ? istaSlots(cfg, faults, ident, tree)
    : [];
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
  const ir = slot.sgbd
    ? await istaProbe(() => api(`/api/ecu/${slot.sgbd}/ir${code}`))
    : null;
  istaEcuWindow({
    slot,
    box,
    ir,
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
 * Session state the Service plan's Test plan holds.
 *
 * Deliberately in memory and not in Settings: a test plan is what THIS
 * session decided to look at, and a plan that outlived the car on the ramp
 * would be worse than no plan at all.
 * @type {object[]}
 */
const istaTestPlan = [];

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
  const base = typeof WEB_BASE === 'string' && WEB_BASE ? WEB_BASE : '.';
  const raw = await istaProbe(async () => {
    const r = await fetch(
      `${base}/data/ista/diag/${code}/search-index.json.gz`
    );
    if (!r.ok || typeof fflate === 'undefined') return null;
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
  if (typeof garageAddCar === 'function')
    car = garageAddCar({
      chassis: row.chassis,
      model: row.model,
      body: row.body,
      motor: row.motor,
      prod: `${row._year || ''}${row._month || ''}`,
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
  const base = typeof WEB_BASE === 'string' && WEB_BASE ? WEB_BASE : '.';
  const res = await fetch(`${base}/data/ista/diag/${code}/${which}.json.gz`);
  if (!res.ok) return null;
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
  return istaDiagGate(tree, keys.ids, istaDiagFacts(car)) || tree;
}

/**
 * The dated facts a validity rule can test, for one car.
 *
 * A rule may ask when the car was built as well as what it is, so the
 * production date travels with the characteristic ids. A car whose date
 * nobody knows simply leaves those clauses undecided, which the gate keeps.
 * @param {object|null} car - the picked GarageCar
 * @returns {object} the facts
 */
function istaDiagFacts(car) {
  const prod = String((car && car.prod) || '');
  if (prod.length < 6) return {};
  return { ym: `${prod.slice(0, 4)}-${prod.slice(4, 6)}` };
}

/**
 * A diagnosis document's body, rendered.
 * @param {string} chassis - the chassis id
 * @param {object} doc - the document row
 * @returns {Promise<string>} HTML
 */
async function istaDiagBody(chassis, doc) {
  const code = String(chassis || '').toUpperCase();
  const base = typeof WEB_BASE === 'string' && WEB_BASE ? WEB_BASE : '.';
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
    const r = await fetch(
      `${base}/data/ista/diag/${code}/docs/${doc.id}.json.gz`
    );
    if (!r.ok || typeof fflate === 'undefined') return null;
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
  if (which === 'test-plan')
    return istaTestPlan.length
      ? [{ title: 'Test plan', rows: istaTestPlan }]
      : [];
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
 * Draw one of the shell's own pages, in the face the setting asks for.
 * @param {IstaSub|IstaSub3} s - the leaf
 * @param {HTMLElement} host - where to draw
 * @returns {Promise<void>}
 */
async function istaDrawPage(s, host) {
  const real = istaSkinOn();
  const car = istaState.car;
  const chassis = istaChassis();

  if (s.page === 'vin') {
    if (!real) return istaPageVinModern(host);
    let valid = false;
    const bar = (ok) => {
      valid = ok;
      istaBottomBar('vin', {
        'open-operation': ok
          ? () => {
              const p = host._istaPick ? host._istaPick() : null;
              if (p) istaOpenOperation(p.car, p.vin);
            }
          : null,
      });
    };
    istaRealStatus({ items: [] });
    istaPageVin(host, {
      open: (c, vin) => istaOpenOperation(c, vin),
      onValid: bar,
    });
    bar(valid);
    return;
  }

  // ---- Operations / Finished ------------------------------------------------
  if (s.page === 'finished') {
    let picked = null;
    const bar = () =>
      istaBottomBar('finished', {
        'open-operation': picked ? () => istaOpenStoredScan(picked) : null,
      });
    const scans = istaPageFinished(host, {
      car,
      onPick: (sc) => {
        picked = sc;
        bar();
      },
    });
    istaRealStatus({
      items: [{ k: 'Operations:', v: `${scans.length} / ${scans.length}` }],
    });
    bar();
    return;
  }

  // ---- Vehicle information / Repair history ---------------------------------
  if (s.page === 'history') {
    let picked = null;
    const bar = () =>
      istaBottomBar('history', {
        display: picked ? () => istaOpenStoredScan(picked) : null,
      });
    const scans = istaPageHistory(host, {
      car,
      onPick: (sc) => {
        picked = sc;
        bar();
      },
    });
    istaRealStatus({
      items: [{ k: 'Entries:', v: `${scans.length} / ${scans.length}` }],
    });
    bar();
    return;
  }

  // ---- Troubleshooting / Fault memory ---------------------------------------
  if (s.page === 'fault-memory') {
    let picked = null;
    const draw = () => {
      const rows = istaPageFaultMemory(host, {
        car,
        filter: istaState.faultFilter || '',
        onPick: (r) => {
          picked = r;
          bar(rows);
        },
      });
      istaRealStatus({
        items: [
          {
            k: 'Number of fault memories:',
            v: `${rows.length} / ${rows.length}`,
          },
          { k: 'No. fault patterns:', v: '0' },
          { k: 'Filter:', v: istaState.faultFilter ? 'Module' : 'Default' },
        ],
      });
      bar(rows);
      return rows;
    };
    const bar = (rows) =>
      istaBottomBar('fault-memory', {
        'show-code': picked ? () => istaFaultDialog(picked) : null,
        // the clear is the app's own per-module one, behind its own confirm:
        // ISTA deletes the memory of the module the picked fault came from
        'delete-faults': picked ? () => istaClearPicked(picked, draw) : null,
        'filter-faults':
          picked && rows.length
            ? () => {
                istaState.faultFilter = picked.sgbd;
                draw();
              }
            : null,
        'delete-filter': istaState.faultFilter
          ? () => {
              istaState.faultFilter = '';
              draw();
            }
          : null,
        'show-all': istaState.faultFilter
          ? () => {
              istaState.faultFilter = '';
              draw();
            }
          : null,
      });
    draw();
    return;
  }

  // ---- Troubleshooting / SAE fault code input -------------------------------
  if (s.page === 'sae') {
    let rows = [];
    const bar = () =>
      istaBottomBar('sae', {
        'show-code': rows.length
          ? () =>
              istaFaultDialog({
                code: rows[0][1],
                desc: rows[0][2],
                module: '',
                sgbd: '',
                raw: {},
              })
          : null,
      });
    // the car's own modules, so a code is read against the tables that can
    // actually tell its families apart
    const saeSlots = await istaLoadSlots(chassis, car);
    if (!host.isConnected) return;
    istaPageSae(host, {
      sgbds: saeSlots.map((x) => x.sgbd).filter(Boolean),
      onRows: (r) => {
        rows = r;
        istaRealStatus({
          items: [
            { k: 'No. fault patterns:', v: '0' },
            { k: 'SAE fault code number:', v: String(r.length) },
          ],
        });
        bar();
      },
    });
    istaRealStatus({
      items: [
        { k: 'No. fault patterns:', v: '0' },
        { k: 'SAE fault code number:', v: '0' },
      ],
    });
    bar();
    return;
  }

  // ---- Vehicle management / Service functions -------------------------------
  if (s.page === 'service-tree') {
    istaRealStatus({ items: [{ k: 'Hits:', v: '0 / 0' }] });
    istaBottomBar('service-functions', {});
    const cfg = await istaProbe(() => api(`/api/chassis/${chassis}`));
    const index = await istaProbe(() =>
      typeof serviceIndexLoad === 'function' ? serviceIndexLoad() : null
    );
    if (!host.isConnected) return;
    const src = istaServiceSource(cfg, index, chassis, (hit) => {
      if (typeof serviceRunHit === 'function') serviceRunHit(hit, chassis);
    });
    istaBrowse(host, src, 'service', { emptyTitle: 'Service Functions' });
    return;
  }

  // ---- Troubleshooting / the diagnosis structures ---------------------------
  if (s.page === 'diag') {
    istaRealStatus({ items: [{ k: 'Hits:', v: '0 / 0' }] });
    istaBottomBar(
      s.id === 'fault-pattern' ? 'fault-pattern' : 'service-functions',
      {}
    );
    const data = await istaProbe(() => istaDiagLoad(chassis, s.id, car));
    if (!host.isConnected) return;
    if (!data)
      return istaPageGrey(
        host,
        s.label,
        `no ${s.label.toLowerCase()} data ships for ${chassis || 'this vehicle'} ` +
          `in this build: run tools/ista/diag_structure_extract.py to add it`
      );
    const src = istaDiagSource(data, (d) => istaDiagBody(chassis, d));
    istaBrowse(host, src, `diag-${s.id}`, { emptyTitle: s.label });
    return;
  }

  // ---- Troubleshooting / Text Search ----------------------------------------
  if (s.page === 'diag-search') {
    istaRealStatus({ items: [{ k: 'Hits:', v: '0 / 0' }] });
    istaBottomBar('diag-search', {});
    const [fp, fn, cp] = await Promise.all([
      istaProbe(() => istaDiagLoad(chassis, 'fault-pattern', car)),
      istaProbe(() => istaDiagLoad(chassis, 'function-structure', car)),
      istaProbe(() => istaDiagLoad(chassis, 'component-structure', car)),
    ]);
    if (!host.isConnected) return;
    if (!fp && !fn && !cp)
      return istaPageGrey(
        host,
        s.label,
        `no diagnosis structures ship for ${chassis || 'this vehicle'} in ` +
          `this build: run tools/ista/diag_structure_extract.py to add them`
      );
    istaDiagSearch(host, {
      data: {
        'fault-pattern': fp,
        'function-structure': fn,
        'component-structure': cp,
      },
      onCount: (n) => {
        istaRealStatus({ items: [{ k: 'Hits:', v: `${n} / ${n}` }] });
        istaBottomBar('diag-search', {
          search: () => host._istaSearch && host._istaSearch.run(),
        });
      },
      onOpen: (hit) => istaOpenDiagDoc(chassis, hit.doc),
      // fetched once, on the first tick of "Search in document": searching
      // the bodies themselves would cost megabytes a keystroke
      loadBodies: () => istaDiagBodies(chassis),
    });
    istaBottomBar('diag-search', {
      search: () => host._istaSearch && host._istaSearch.run(),
    });
    return;
  }

  // ---- Service plan ---------------------------------------------------------
  if (s.page === 'plan') {
    let picked = null;
    const groups = await istaPlanGroups(s.id, car);
    if (!host.isConnected) return;
    const bar = () =>
      istaBottomBar('hit-list', {
        back: () => showIsta('information', 'details', null),
        display: picked ? () => istaOpenPlanDoc(picked) : null,
      });
    const flat = istaPageServicePlan(host, {
      groups,
      empty:
        s.id === 'hit-list'
          ? 'No fault has been read on this vehicle yet, so nothing points ' +
            'at a procedure.'
          : s.id === 'test-plan'
            ? 'Nothing has been added to the test plan in this session.'
            : 'Programming is not offered by this build.',
      onPick: (r) => {
        picked = r;
        bar();
      },
      onOpen: (r) => istaOpenPlanDoc(r),
    });
    istaRealStatus({
      items: [{ k: 'Hits:', v: `${flat.length} / ${flat.length}` }],
    });
    bar();
    return;
  }

  // ---- Vehicle information / Control unit tree ------------------------------
  if (s.page === 'tree') {
    // THE BUS MAP IS THE APP'S OWN DRAWING and it is the right one; what
    // does not belong inside the workshop chrome is the screen's heading,
    // its car picker and its Fault scan button, which the skin hides. It is
    // opened through istaOpen like any other wrapped screen, because that is
    // the path that holds the router's teardown off while it renders and
    // puts the shell's identity back afterwards.
    await istaOpen({
      label: s.label,
      _call: () => showEcuTreeChassis(chassis, car ? car.id : null),
    });
    if (!real) return;
    const slots = await istaLoadSlots(chassis, car);
    const faults = slots.reduce((a, x) => a + x.faults, 0);
    const read = slots.some((x) => x.state !== 'unread');
    let picked = null;
    const bar = () =>
      istaBottomBar('unit-list', {
        'vehicle-test': () => {
          istaState.tested = true;
          return istaOpenVehicleTest();
        },
        'ecu-functions': picked
          ? () => istaOpenEcuWindow(picked.slot, picked.box, chassis)
          : null,
        'display-faults': () =>
          istaGo('management', 'troubleshooting', 'fault-memory'),
      });
    istaRealStatus({
      items: [{ k: 'Fault memory', v: read ? String(faults) : 'Unknown' }],
      legend: [
        { cls: 'ok', label: 'ECU without fault memory' },
        { cls: 'warn', label: 'ECU with fault memory' },
        { cls: 'bad', label: 'ECU not responding' },
        { cls: 'blue', label: 'ECU with programming abort' },
      ],
    });
    bar();
    istaTreeBind(slots, chassis, (p) => {
      picked = p;
      bar();
    });
    return;
  }

  // ---- Vehicle information / Control unit list ------------------------------
  if (s.page === 'unit-list') {
    let picked = null;
    const slots = await istaLoadSlots(chassis, car);
    if (!host.isConnected) return;
    const faults = slots.reduce((a, x) => a + x.faults, 0);
    const read = slots.some((x) => x.state !== 'unread');
    const bar = () =>
      istaBottomBar('unit-list', {
        'vehicle-test': () => {
          istaState.tested = true;
          return istaGo('information', 'tree', null);
        },
        // the window is about ONE control unit, so it needs one picked
        'ecu-functions': picked
          ? () => istaOpenEcuWindow(picked, null, chassis)
          : null,
        'display-faults': () =>
          istaGo('management', 'troubleshooting', 'fault-memory'),
      });
    istaPageUnitList(host, {
      slots,
      onPick: (x) => {
        picked = x;
        bar();
      },
    });
    istaRealStatus({
      items: [{ k: 'Fault memory:', v: read ? String(faults) : 'Unknown' }],
      legend: [
        { cls: 'ok', label: 'ECU without fault memory' },
        { cls: 'warn', label: 'ECU with fault memory' },
        { cls: 'bad', label: 'ECU not responding' },
        { cls: 'dim', label: 'ECU not read' },
      ],
    });
    bar();
    return;
  }

  // ---- Operations / New / Basic Features ------------------------------------
  if (s.page === 'basic') {
    istaRealStatus({ items: [] });
    istaBottomBar('basic', {});
    // the gate is the CHARACTERISTIC TREE, not the parts catalogue: this
    // page is built from ISTA's own basic features and never touches a VIN
    const ok = await istaProbe(() =>
      typeof istaBasicPresent === 'function' ? istaBasicPresent() : false
    );
    if (!host.isConnected) return;
    if (!ok)
      return istaPageGrey(
        host,
        s.label,
        "BMW's characteristic tree is not in this build, so a vehicle " +
          'cannot be described feature by feature here'
      );
    istaPageBasic(host, {
      onChange: (n, row) => {
        istaRealStatus({ items: [{ k: 'Hits:', v: `${n} / ${n}` }] });
        istaBottomBar('basic', {
          // exactly ONE vehicle is the bar for opening: a set of choices
          // that still describes six cars has not identified one
          'open-operation': n === 1 && row ? () => istaOpenBasic(row) : null,
        });
      },
    });
    return;
  }

  if (s.page === 'readout') {
    istaRealStatus(real ? { items: [] } : null);
    // BOTH IDENTIFICATION BUTTONS READ THE CAR, so both need a cable. With
    // none connected they grey rather than offering a read that can only
    // fail: the page above already says to connect the interface, and a live
    // button beside that instruction contradicts it.
    const armReadout = (cable) =>
      istaBottomBar('readout', {
        cancel: () => istaGo('operations', 'new', 'vin'),
        'ident-only': cable
          ? () => istaGo('information', 'details', null)
          : null,
        'ident-full': cable
          ? () => {
              istaState.tested = true;
              return istaGo('information', 'tree', null);
            }
          : null,
      });
    if (real) armReadout(false);
    await istaPageReadout(host, { onCable: real ? armReadout : null });
    return;
  }

  if (s.page === 'active') {
    if (real) {
      istaRealStatus({ items: [] });
      istaBottomBar('none');
    }
    return istaPageActive(host, car, chassis);
  }

  if (s.page === 'repair') {
    // The repair manual draws its own page; what the shell owns is the
    // frame around it and WHICH VIEW it is on, which is the level-3 tab the
    // reader pressed. Its two views are keyed by those same tab ids, so
    // nothing has to be translated across the seam.
    if (real) {
      istaRealStatus({ items: [{ k: 'Hits:', v: '0 / 0' }] });
      istaBottomBar('product-structure', {});
    }
    if (typeof showRepair !== 'function') {
      const why = 'the repair document browser did not ship in this build';
      if (real) return istaPageGrey(host, s.label, why);
      host.innerHTML =
        `<div class="ista-page"><h2 class="ista-page-title">${esc(s.label)}` +
        `</h2><div class="ista-none-box">${esc(why)}</div></div>`;
      return;
    }
    return showRepair(host, car, chassis, s.id);
  }

  if (s.page === 'details') {
    if (!real) return istaShowDetails(host, car, chassis);
    istaRealStatus({ items: [] });
    istaBottomBar('details', {
      'vehicle-test': () => {
        istaState.tested = true;
        return istaGo('information', 'tree', null);
      },
      'info-search': () =>
        istaGo('management', 'troubleshooting', 'text-search'),
    });
    // the grid draws from the catalogue decode at once, then fills in what a
    // read finds; nothing is read unless the user asked for it elsewhere
    istaRealDetails(host, car, istaState.etk, {});
    return;
  }

  if (s.page === 'equipment') {
    if (!real) return istaShowEquipment(host, car, chassis);
    istaRealStatus({ items: [] });
    istaBottomBar('equipment', {
      'show-test': () => istaGo('information', 'tree', null),
      'info-search': () =>
        istaGo('management', 'troubleshooting', 'text-search'),
    });
    istaRealEquipment(host, [], null);
    const got = await istaProbe(async () => {
      if (typeof readIdentityCodes !== 'function') return null;
      if (typeof loadTables === 'function') await loadTables();
      if (typeof loadSaNames === 'function') await loadSaNames();
      return readIdentityCodes(chassis);
    });
    if (!host.isConnected) return;
    const codes = (got && got.codes) || [];
    const date = car && car.prod ? Number(String(car.prod).padEnd(8, '0')) : 0;
    istaRealEquipment(host, codes, (c) =>
      typeof saName === 'function' ? saName(chassis, c, date) : ''
    );
    return;
  }

  if (s.page === 'techdata') {
    if (!real) return showTechData(host, car, chassis);
    istaRealStatus({ items: [{ k: 'Filter:', v: 'Default' }] });
    await showTechData(host, car, chassis);
    if (!host.isConnected) return;
    // the app's page draws its own section tabs and a Show all checkbox; the
    // skin hides those (the level-3 strip is the sections, and Show all is a
    // filter) and this is the button that still reaches the checkbox
    istaBottomBar('techdata', {
      filters: () => istaTechDataFilter(host),
    });
    return;
  }
}

/**
 * The modern face's VIN page: the Garage picker as a plain list.
 * @param {HTMLElement} host - where to draw
 * @returns {void}
 */
function istaPageVinModern(host) {
  host.innerHTML =
    `<div class="ista-page"><h2 class="ista-page-title">New operation</h2>` +
    `<p class="ista-page-note">Pick the vehicle to work on.</p>` +
    `<div class="ista-none-box">Use the vehicle picker in the banner ` +
    `above, or switch Settings to the INPA layout for the full start ` +
    `page.</div></div>`;
}

/**
 * Open a vehicle and go to its details: the VIN page's Open operation.
 *
 * A row that was picked is already a saved car. A VIN that was typed is
 * looked up in the Garage first (so the same car is not saved twice) and
 * only then decoded and added -- the decode is a catalogue lookup, so this
 * costs the car nothing and works with no cable at all.
 * @param {object|null} car - the picked GarageCar, or null
 * @param {string} vin - what was in the box
 * @returns {Promise<void>}
 */
async function istaOpenOperation(car, vin) {
  let use = car;
  const v = String(vin || '')
    .trim()
    .toUpperCase();
  if (!use && v) {
    if (typeof garageFindByVin === 'function') use = garageFindByVin(v) || null;
    if (!use) {
      const etk = await istaProbe(() =>
        typeof viEtkDecode === 'function' ? viEtkDecode(v) : null
      );
      if (!etk) {
        if (typeof toast === 'function')
          toast(`No vehicle in the parts index matches ${v}`);
        return;
      }
      if (typeof garageAddCar === 'function')
        use = garageAddCar({
          vin: v,
          chassis: etk.chassis,
          model: etk.model,
          body: etk.body,
          motor: etk.motor,
          prod: String(etk.prod || ''),
        });
    }
  }
  if (!use) return;
  istaSetCar(use);
  return istaGo('information', 'details', null);
}

/**
 * The ISTA shell.
 * @param {string} [tab] - the tab to open
 * @param {string|null} [sub] - the sub-tab on it
 * @param {string|null} [sub3] - the level-3 tab on that
 * @param {string|null} [carId] - a car id from the route
 * @returns {Promise<void>}
 */
async function showIsta(tab, sub, sub3, carId) {
  if (typeof cancelSweep === 'function') cancelSweep();
  if (!istaState.car && !istaState.chassis) istaRestoreCar(carId);
  else if (carId) istaRestoreCar(carId);
  istaState.tab = istaTab(tab) ? tab : ISTA_HOME_TAB;
  const firstSub = (istaFirstSub(istaState.tab) || {}).id || null;
  istaState.sub = istaSub(istaState.tab, sub) ? sub : firstSub;
  const first3 = istaState.sub
    ? (istaFirstSub3(istaState.tab, istaState.sub) || {}).id || null
    : null;
  istaState.sub3 =
    istaState.sub && istaSub3(istaState.tab, istaState.sub, sub3)
      ? sub3
      : first3;

  lastScreen = () => showIsta(istaState.tab, istaState.sub, istaState.sub3);
  // the shell drawing itself is not the user leaving it: hold the flag over
  // setCrumbs so the router's teardown check sees the shell's own render
  istaOpeningSet(true);
  try {
    setCrumbs([
      { label: 'Vehicles', fn: showChassis },
      { label: 'ISTA', fn: () => showIsta(ISTA_HOME_TAB, null, null) },
      { label: (istaTab(istaState.tab) || {}).label || istaState.tab },
    ]);
  } finally {
    istaOpeningSet(false);
  }
  istaChromeShow(); // after setCrumbs: it clears the body classes
  istaPaintChrome();
  istaRouteStamp();
  sbLeft.textContent = 'workshop';
  sbRight.textContent = istaChassis() || 'no vehicle';

  const real = istaSkinOn();
  const printAction = {
    key: 'p',
    label: 'Print',
    kind: 'print',
    fn: () => window.print(),
  };
  const homeAction = {
    key: 'Escape',
    keyLabel: 'Esc',
    label: 'Back',
    kind: 'back',
    fn: () => {
      istaChromeHide();
      showChassis();
    },
  };

  const s = istaLeaf(istaState.tab, istaState.sub, istaState.sub3);
  if (!s) {
    // an empty tab (Favourites before anything is pinned) is not a broken
    // sub-tab: it says what to do rather than erroring about a missing row
    view.innerHTML = '';
    setActions([printAction, homeAction]);
    if (real) {
      istaRealStatus({ items: [] });
      istaBottomBar('none');
      istaPageGrey(
        view,
        (istaTab(istaState.tab) || {}).label || istaState.tab,
        istaState.tab === 'favourites'
          ? 'Nothing pinned yet. The star on a sub-tab pins it here.'
          : 'Nothing here yet.'
      );
    } else {
      await istaHome(view, istaState.tab);
    }
    return;
  }

  const state = await istaSubReady(s);

  if (!state.ok) {
    view.innerHTML = '';
    setActions([printAction, homeAction]);
    if (real) {
      istaRealStatus({ items: [] });
      // a greyed tab still shows the row of buttons its page would carry,
      // all refused: the control is visible and does nothing, which says
      // more than an empty bar
      istaBottomBar(s.id);
      // the greyed tabs that have a layout of their own get it drawn
      const shape = ISTA_GREY_SHAPES[s.id] || null;
      istaPageGrey(view, s.label, state.why, shape);
    } else {
      view.innerHTML =
        `<div class="ista-page"><h2 class="ista-page-title">${esc(
          s.label
        )}</h2>` + `<div class="ista-none-box">${esc(state.why)}</div></div>`;
    }
    return;
  }

  // a page the shell draws itself
  if (s.page) {
    view.innerHTML = '';
    setActions([printAction, homeAction]);
    const host = document.createElement('div');
    view.appendChild(host);
    await istaDrawPage(s, host);
    return;
  }

  // a screen the app already has
  await istaOpen(s);
}

/**
 * The layouts the greyed tabs draw under their reason.
 *
 * Each one is the real tool's own layout for that page, so the tab reads as
 * the tab it is rather than as an error. The reason itself comes from the
 * model, not from here.
 * @type {Object<string, object>}
 */
const ISTA_GREY_SHAPES = {
  before: { cols: ['Abbreviation', 'Control unit name', 'Replaced'] },
  after: { cols: ['Abbreviation', 'Control unit name', 'Replaced'] },
  retrofit: {
    cols: ['Description', 'Selection'],
    attention:
      'For a change of control unit (installation or exchange), also ' +
      "select the relevant control unit via the 'After Replacement' button.",
  },
  conversion: { cols: ['Description', 'Selection'] },
  removal: { cols: ['Description', 'Selection'] },
  immediate: { cols: ['Description', 'Selection'] },
  comfort: {
    attention:
      'Programming is not offered by this build: flashing a module can ' +
      'brick it.',
  },
  advanced: {
    attention:
      'Programming is not offered by this build: flashing a module can ' +
      'brick it.',
  },
  additional: {
    attention:
      'Programming is not offered by this build: flashing a module can ' +
      'brick it.',
  },
  'test-plan': { cols: ['Type', 'Title', 'State', 'Priority'] },
  'programming-plan': { cols: ['Type', 'Title', 'State', 'Priority'] },
  'fault-pattern': { cols: ['Hits', 'Search terms'] },
};

// ---- the shell's own home (modern face only) -------------------------------

/**
 * The modern face's home: every tab as a card, and every sub-tab under it.
 * @param {HTMLElement} host - where to draw
 * @param {string} [onlyTab] - draw just this tab's card
 * @returns {Promise<void>}
 */
async function istaHome(host, onlyTab) {
  const chassis = istaChassis();
  const show = onlyTab ? ISTA_TABS.filter((t) => t.id === onlyTab) : ISTA_TABS;
  host.innerHTML =
    `<div class="ista-home">` +
    (onlyTab
      ? ''
      : `<p class="ista-home-note">${
          chassis
            ? `ISTA on ${esc(
                typeof dispChassis === 'function'
                  ? dispChassis(chassis)
                  : chassis
              )}.`
            : `Pick a vehicle in the banner above to begin.`
        }</p>`) +
    `<div class="ista-home-grid"></div></div>`;
  const grid = host.querySelector('.ista-home-grid');

  for (const t of show) {
    const subs = istaSubsOf(t.id);
    const card = document.createElement('section');
    card.className = 'ista-card';
    card.innerHTML =
      `<h2 class="ista-card-title">${esc(
        String(t.label).replace(/\n/g, ' ')
      )}</h2>` +
      (t.desc ? `<p class="ista-card-desc">${esc(t.desc)}</p>` : '') +
      `<div class="ista-card-rows"></div>`;
    const rows = card.querySelector('.ista-card-rows');
    if (!subs.length) {
      rows.innerHTML = `<div class="ista-row-none">${
        t.id === 'favourites'
          ? 'Nothing pinned yet. The star beside a sub-tab pins it here.'
          : 'Nothing here yet.'
      }</div>`;
    }
    for (const s of subs) {
      const owner = s._tab || t.id;
      // a sub-tab with a strip under it is a group: its first leaf is what
      // the row would open, so that is what it reports on
      const leaf = s.subs3 ? istaFirstSub3(owner, s.id) || s : s;
      const state = await istaSubReady(leaf);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'ista-row' + (state.ok ? '' : ' ista-row-off');
      row.innerHTML =
        `<span class="ista-row-label">${esc(s.label)}</span>` +
        `<span class="ista-row-desc">${esc(
          state.ok ? s.desc || leaf.desc || '' : state.why
        )}</span>` +
        `<span class="ista-row-arrow">${state.ok ? '→' : ''}</span>`;
      if (state.ok) row.onclick = () => istaGo(owner, s.id, null);
      else row.disabled = true;
      rows.appendChild(row);
    }
    grid.appendChild(card);
  }
}

if (typeof document !== 'undefined' && document.getElementById) {
  const btn = document.getElementById('ista-btn');
  if (btn) btn.onclick = () => showIsta();
}

if (typeof window !== 'undefined') {
  window.showIsta = showIsta;
  window.istaOpenFaultMemory = istaOpenFaultMemory;
  window.istaOpenVehicleTest = istaOpenVehicleTest;
  window.istaOpenIdentScan = istaOpenIdentScan;
  window.istaOpenService = istaOpenService;
  window.istaOpenServiceResets = istaOpenServiceResets;
  window.istaOpenTree = istaOpenTree;
  window.istaOpenHistory = istaOpenHistory;
  window.istaOpenLatestReport = istaOpenLatestReport;
  window.istaOpenIdentity = istaOpenIdentity;
  window.istaOpenCoding = istaOpenCoding;
  window.istaOpenModules = istaOpenModules;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ISTA_CAR_KEY,
    ISTA_CHASSIS_KEY,
    ISTA_GREY_SHAPES,
    istaState,
    istaChassis,
    istaSetCar,
    istaRestoreCar,
    istaSubReady,
    istaRouteStamp,
    istaOpenOperation,
    showIsta,
  };
}
