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
    if (typeof document !== 'undefined')
      document.body.classList.remove('ista-real-body');
    istaRealStatus(null);
    istaRealBottom(null);
    return act === 'home' && typeof showApps === 'function'
      ? showApps()
      : showChassis();
  }
  if (act === 'print') return window.print();
  if (act === 'settings')
    return typeof showSettings === 'function' ? showSettings() : undefined;
  if (act === 'help')
    return typeof showDocs === 'function'
      ? showDocs()
      : window.open('README.md', '_blank');
  if (act === 'sessions') return istaPickCar();
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
 * @returns {void}
 */
function istaRouteStamp() {
  if (typeof history === 'undefined' || !history.replaceState) return;
  const route = istaRouteBuild(
    istaState.tab,
    istaState.sub,
    istaState.sub3,
    istaState.car ? istaState.car.id : null
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
  const fn = window[sub.open];
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

  if (s.page === 'readout') {
    istaRealStatus(real ? { items: [] } : null);
    if (real)
      istaBottomBar('readout', {
        cancel: () => istaGo('operations', 'new', 'vin'),
        'ident-only': () => istaGo('information', 'details', null),
        'ident-full': () => {
          istaState.tested = true;
          return istaGo('information', 'tree', null);
        },
      });
    return istaPageReadout(host, {});
  }

  if (s.page === 'active') {
    if (real) {
      istaRealStatus({ items: [] });
      istaBottomBar('none');
    }
    return istaPageActive(host, car, chassis);
  }

  if (s.page === 'repair-host') {
    // Repair/maintenance is built on its own branch: it scopes its CSS under
    // .ista-repair and draws into this host. Left empty here on purpose --
    // the strip, the route and the frame are this branch's half of the seam.
    host.innerHTML = `<div class="irrepair-host" id="ista-repair-host"></div>`;
    if (real) {
      istaRealStatus({ items: [{ k: 'Hits:', v: '0 / 0' }] });
      istaBottomBar('product-structure', {});
    }
    if (typeof istaRepairShow === 'function')
      return istaRepairShow(host.firstChild, s.id, car, chassis);
    if (real)
      return istaPageGrey(
        host,
        s.label,
        'the repair document browser is not in this build yet'
      );
    host.innerHTML =
      `<div class="ista-page"><h2 class="ista-page-title">${esc(s.label)}` +
      `</h2><div class="ista-none-box">the repair document browser is ` +
      `not in this build yet</div></div>`;
    return;
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
    if (real) {
      istaRealStatus({ items: [{ k: 'Filter:', v: 'Default' }] });
      istaBottomBar('none');
    }
    return showTechData(host, car, chassis);
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
      if (typeof document !== 'undefined')
        document.body.classList.remove('ista-real-body');
      istaRealStatus(null);
      istaRealBottom(null);
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
