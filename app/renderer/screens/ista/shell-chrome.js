/**
 * @file ISTA shell: the chrome around the view (title bar, tabs, bottom bar) and its state.
 */

/* exported istaPaintChrome, istaGo */

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
  // the same rule the workshop chrome follows: no vehicle, no tabs
  const locked = !istaState.car;
  const tabs = ISTA_TABS.map((t) => {
    const on = t.id === istaState.tab;
    const off = locked && !t.entry;
    return (
      `<button type="button" class="ista-tab${on ? ' on' : ''}` +
      `${off ? ' off' : ''}" data-tab="${esc(t.id)}"` +
      `${off ? ' disabled title="Start an operation first"' : ''}` +
      `${on ? ' aria-current="page"' : ''}>` +
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
    if (b.disabled) return;
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
  let t = istaTab(tab) ? tab : ISTA_HOME_TAB;
  // A ROUTE CANNOT WALK PAST THE GATE EITHER. The tabs are greyed with no
  // car, but a bookmarked or reloaded URL addresses one directly -- so a
  // tab that needs a vehicle lands on Operations instead, which is where
  // the vehicle is identified.
  const entry = (istaTab(t) || {}).entry;
  if (!istaState.car && !entry) {
    const home = ISTA_TABS.find((x) => x.entry);
    if (home) {
      t = home.id;
      sub = null;
      sub3 = null;
    }
  }
  const s = sub || (istaFirstSub(t) || {}).id || null;
  const s3 = sub3 || (s ? (istaFirstSub3(t, s) || {}).id || null : null);
  return showIsta(t, s, s3);
}
