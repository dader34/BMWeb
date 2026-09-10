/**
 * @file The ISTA shell: workshop mode. A banner and a tab bar that stay up
 * while the app's own screens render underneath them.
 *
 * Nothing in here is a second copy of a screen. Every sub-tab resolves to a
 * show*() the app already has, called with the picked car filled in; the
 * shell's job is to be the frame around it and to know which of them exist
 * on this car. The two pages it does draw itself (details.js) are the ones
 * the app had no screen for.
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
 * @type {{car: object|null, chassis: string, tab: string, sub: string|null}}
 */
const istaState = {
  car: null,
  chassis: '',
  tab: ISTA_HOME_TAB,
  sub: null,
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
 * The whole-car fault scan, filed against the picked car.
 * @returns {void}
 */
function istaOpenFaultMemory() {
  const car = istaState.car;
  if (car && typeof garageRunScan === 'function')
    return garageRunScan(car, IPO_VEHICLE_FAULT_MENU, GARAGE_FAULT_KEY);
  showVehicleScript(
    istaChassis(),
    IPO_VEHICLE_FAULT_MENU,
    null,
    GARAGE_FAULT_KEY
  );
}

/**
 * The vehicle test: the bus map, which can run the scan in place.
 * @returns {Promise<void>}
 */
function istaOpenVehicleTest() {
  return showEcuTreeChassis(
    istaChassis(),
    istaState.car ? istaState.car.id : null,
    { scan: true }
  );
}

/**
 * The identification read, filed against the picked car.
 * @returns {void}
 */
function istaOpenIdentScan() {
  const car = istaState.car;
  if (car && typeof garageRunScan === 'function')
    return garageRunScan(car, null, GARAGE_IDENT_KEY);
  showVehicleScript(istaChassis(), null, null, GARAGE_IDENT_KEY);
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
  return showVehicleIdentity(istaChassis());
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
 * Is a sub-tab openable on the car the shell is pointed at?
 *
 * This is where a grey row stops being a guess. A sub-tab can be dark for
 * three different reasons and the shell says which: the model marked it
 * `why` (nothing to open, ever, or not yet); the screen it names did not
 * ship in this build; or it needs something this particular car has not got
 * -- a whole-car script (only 10 of 27 chassis ship one), a saved car, a
 * stored scan.
 * @param {IstaSub} sub - the sub-tab
 * @returns {Promise<{ok: boolean, why: string}>}
 */
async function istaSubReady(sub) {
  if (!sub) return { ok: false, why: 'no such tab' };
  if (sub.why) return { ok: false, why: sub.why };
  if (sub.needsCar && !istaChassis())
    return { ok: false, why: 'no vehicle picked' };
  if (sub.page) {
    // the two identity pages read the car and always have something to draw;
    // the workshop browser is nothing without its extract, so it says so
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

  // the per-car checks, by sub-tab
  const chassis = istaChassis();
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
  if (sub.id === 'vehicle-test' || sub.id === 'tree') {
    if (typeof ecuTreeNameFor === 'function') {
      const name = await istaProbe(() => ecuTreeNameFor(chassis));
      if (!name) return { ok: false, why: `no bus map ships for ${chassis}` };
    }
  }
  if (sub.id === 'history' && !istaState.car)
    return { ok: false, why: 'no saved car: add one in the Garage first' };
  if (sub.id === 'report') {
    if (!istaState.car)
      return { ok: false, why: 'no saved car: add one in the Garage first' };
    const scans =
      typeof garageScans === 'function' ? garageScans(istaState.car.id) : [];
    if (!scans.length) return { ok: false, why: 'no scan stored yet' };
  }
  if (sub.id === 'identification' && typeof chassisHasIdentity === 'function') {
    const any = await istaProbe(() => chassisHasIdentity(chassis));
    if (!any)
      return {
        ok: false,
        why: `no module on ${chassis} declares the build record`,
      };
  }
  if (
    (sub.id === 'service-functions' || sub.id === 'resets') &&
    typeof serviceIndexPresent === 'function'
  ) {
    const has = await istaProbe(() => serviceIndexPresent());
    if (!has) return { ok: false, why: 'no service mapping in this build' };
  }
  if (
    sub.id === 'function-search' &&
    typeof searchIndexPresent === 'function'
  ) {
    const has = await istaProbe(() => searchIndexPresent());
    if (!has) return { ok: false, why: 'no job index in this build' };
  }
  return { ok: true, why: '' };
}

// ---- the chrome ------------------------------------------------------------

/**
 * Draw the banner and the tab bar. Called on every navigation inside the
 * shell, so the active tab and the car description stay right.
 * @returns {void}
 */
function istaPaintChrome() {
  const el = istaChromeEnsure();
  if (!el) return;
  const tabs = ISTA_TABS.map((t) => {
    const on = t.id === istaState.tab;
    return (
      `<button type="button" class="ista-tab${on ? ' on' : ''}" ` +
      `data-tab="${esc(t.id)}"${on ? ' aria-current="page"' : ''}>` +
      `${esc(t.label)}</button>`
    );
  }).join('');
  const subs = istaSubsOf(istaState.tab);
  const strip = subs.length
    ? `<div class="ista-subs">` +
      subs
        .map((s) => {
          const owner = s._tab || istaState.tab;
          const on = s.id === istaState.sub && owner === istaState.tab;
          const pinned = istaIsFavourite(owner, s.id);
          return (
            `<span class="ista-sub-wrap">` +
            `<button type="button" class="ista-sub${on ? ' on' : ''}" ` +
            `data-sub="${esc(s.id)}" data-owner="${esc(owner)}">` +
            `${esc(s.label)}</button>` +
            `<button type="button" class="ista-star${pinned ? ' on' : ''}" ` +
            `data-star="${esc(s.id)}" data-owner="${esc(owner)}" ` +
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
    `<div class="ista-tabs" role="tablist">` +
    `<button type="button" class="ista-tab ista-tab-home` +
    `${istaState.tab === ISTA_HOME_TAB ? ' on' : ''}" ` +
    `data-tab="${ISTA_HOME_TAB}" title="Back to the shell's home">⌂</button>` +
    tabs +
    `</div>` +
    strip;

  el.querySelectorAll('.ista-tab[data-tab]').forEach((b) => {
    b.onclick = () => istaGo(b.dataset.tab, null);
  });
  el.querySelectorAll('.ista-sub[data-sub]').forEach((b) => {
    b.onclick = () => istaGo(istaState.tab, b.dataset.sub, b.dataset.owner);
  });
  el.querySelectorAll('.ista-star[data-star]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      istaFavouriteToggle(b.dataset.owner, b.dataset.star);
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
      showIsta(istaState.tab, istaState.sub);
    };
  });
  const cancel = overlay.querySelector('.ista-pick-cancel');
  if (cancel) cancel.onclick = () => close();
}

/**
 * Navigate inside the shell.
 * @param {string} tab - the tab id
 * @param {string|null} sub - the sub-tab id, or null for the tab's first
 * @param {string} [owner] - the tab a pinned sub-tab really belongs to
 * @returns {Promise<void>}
 */
async function istaGo(tab, sub, owner) {
  const t = istaTab(tab) ? tab : ISTA_HOME_TAB;
  istaState.tab = t;
  if (t === ISTA_HOME_TAB) {
    istaState.sub = null;
    return showIsta(t, null);
  }
  const first = sub || (istaFirstSub(t) || {}).id || null;
  istaState.sub = first;
  return showIsta(t, first, owner);
}

// ---- the shell's own home --------------------------------------------------

/**
 * The shell's home: every tab as a card, and every sub-tab under it. This is
 * what a keyboard user navigates -- the tab bar is a pointer affordance, the
 * cards are the real list.
 * @param {HTMLElement} host - where to draw
 * @param {string} [onlyTab] - draw just this tab's card (an empty tab lands
 *   here rather than on a sub-tab it has not got)
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
              )}. Every tab opens one of the app's own screens with this ` +
              `vehicle already filled in.`
            : `Pick a vehicle in the banner above to begin. Every tab opens ` +
              `one of the app's own screens with it already filled in.`
        }</p>`) +
    `<div class="ista-home-grid"></div></div>`;
  const grid = host.querySelector('.ista-home-grid');

  for (const t of show) {
    const subs = istaSubsOf(t.id);
    const card = document.createElement('section');
    card.className = 'ista-card';
    card.innerHTML =
      `<h2 class="ista-card-title">${esc(t.label)}</h2>` +
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
      const state = await istaSubReady(s);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'ista-row' + (state.ok ? '' : ' ista-row-off');
      row.innerHTML =
        `<span class="ista-row-label">${esc(s.label)}</span>` +
        `<span class="ista-row-desc">${esc(
          state.ok ? s.desc || '' : state.why
        )}</span>` +
        `<span class="ista-row-arrow">${state.ok ? '→' : ''}</span>`;
      if (state.ok) row.onclick = () => istaGo(t.id, s.id, owner);
      else row.disabled = true;
      rows.appendChild(row);
    }
    grid.appendChild(card);
  }
}

// ---- the entry point -------------------------------------------------------

/**
 * Stamp the shell's route into the URL. Done by hand rather than through
 * ROUTE_FOR_SCREEN because the route carries the tab, the sub-tab and the
 * car, none of which a function name can express.
 * @returns {void}
 */
function istaRouteStamp() {
  if (typeof history === 'undefined' || !history.replaceState) return;
  const route = istaRouteBuild(
    istaState.tab,
    istaState.sub,
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
 * @param {IstaSub} sub - the sub-tab being opened
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
  lastScreen = () => showIsta(istaState.tab, istaState.sub);
  istaRouteStamp();
  istaBackAction();
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
      fn: () => showIsta(ISTA_HOME_TAB, null),
    },
  ]);
}

/**
 * The ISTA shell.
 * @param {string} [tab] - the tab to open
 * @param {string|null} [sub] - the sub-tab on it
 * @param {string} [owner] - the tab a pinned sub-tab belongs to
 * @param {string|null} [carId] - a car id from the route
 * @returns {Promise<void>}
 */
async function showIsta(tab, sub, owner, carId) {
  if (typeof cancelSweep === 'function') cancelSweep();
  if (!istaState.car && !istaState.chassis) istaRestoreCar(carId);
  else if (carId) istaRestoreCar(carId);
  istaState.tab = istaTab(tab) ? tab : ISTA_HOME_TAB;
  istaState.sub = istaState.tab === ISTA_HOME_TAB ? null : sub || null;

  lastScreen = () => showIsta(istaState.tab, istaState.sub);
  // the shell drawing itself is not the user leaving it: hold the flag over
  // setCrumbs so the router's teardown check sees the shell's own render
  istaOpeningSet(true);
  try {
    setCrumbs([
      { label: 'Vehicles', fn: showChassis },
      { label: 'ISTA', fn: () => showIsta(ISTA_HOME_TAB, null) },
      ...(istaState.tab === ISTA_HOME_TAB
        ? []
        : [{ label: (istaTab(istaState.tab) || {}).label || istaState.tab }]),
    ]);
  } finally {
    istaOpeningSet(false);
  }
  istaChromeShow(); // after setCrumbs: it clears the body classes
  istaPaintChrome();
  istaRouteStamp();
  sbLeft.textContent = 'workshop';

  const backAction = {
    key: 'Escape',
    keyLabel: 'Esc',
    label: 'Back',
    kind: 'back',
    fn: () => {
      istaChromeHide();
      showChassis();
    },
  };
  const printAction = {
    key: 'p',
    label: 'Print',
    kind: 'print',
    fn: () => window.print(),
  };

  // the home tab: the cards
  if (istaState.tab === ISTA_HOME_TAB) {
    view.innerHTML = '';
    setActions([printAction, backAction]);
    await istaHome(view);
    sbRight.textContent = istaChassis() || 'no vehicle';
    return;
  }

  // A tab with nothing in it is not a broken sub-tab, it is an empty tab --
  // Favourites before anything is pinned. Show the tab's own (empty) card so
  // it says what to do, rather than a sub-tab error about a row that is not
  // there.
  const s =
    istaSub(istaState.tab, istaState.sub) || istaFirstSub(istaState.tab);
  if (!s) {
    view.innerHTML = '';
    setActions([printAction, backAction]);
    await istaHome(view, istaState.tab);
    sbRight.textContent = istaChassis() || 'no vehicle';
    return;
  }
  const homeAction = {
    key: 'Escape',
    keyLabel: 'Esc',
    label: 'ISTA',
    kind: 'back',
    fn: () => showIsta(ISTA_HOME_TAB, null),
  };
  const state = await istaSubReady(s);
  sbRight.textContent = istaChassis() || 'no vehicle';

  if (!state.ok) {
    view.innerHTML =
      `<div class="ista-page"><h2 class="ista-page-title">${esc(
        s.label
      )}</h2>` + `<div class="ista-none-box">${esc(state.why)}</div></div>`;
    setActions([printAction, homeAction]);
    return;
  }

  // a page the shell draws itself
  if (s.page) {
    view.innerHTML = '';
    setActions([printAction, homeAction]);
    const host = document.createElement('div');
    view.appendChild(host);
    if (s.page === 'details')
      await istaShowDetails(host, istaState.car, istaChassis());
    else if (s.page === 'techdata')
      await showTechData(host, istaState.car, istaChassis());
    else await istaShowEquipment(host, istaState.car, istaChassis());
    return;
  }

  // a screen the app already has
  await istaOpen(s);
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
  window.istaOpenModules = istaOpenModules;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ISTA_CAR_KEY,
    ISTA_CHASSIS_KEY,
    istaState,
    istaChassis,
    istaSetCar,
    istaRestoreCar,
    istaSubReady,
    istaRouteStamp,
    showIsta,
  };
}
