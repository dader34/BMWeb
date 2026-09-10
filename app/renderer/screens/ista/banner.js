/**
 * @file The ISTA shell's persistent chrome: the banner (car, VIN, KL15/KL30)
 * and the tab bar under it.
 *
 * THE POINT OF THIS FILE IS THAT IT IS NOT A SCREEN. The app's screens all
 * work the same way -- they replace `#view`'s content and own it. If the
 * shell were a screen it would have to re-implement every screen it wraps.
 * So the chrome lives OUTSIDE `#view`, in its own container between the
 * topbar and the view, and a sub-tab simply calls the app's existing show*()
 * function. The screen renders into `#view` underneath, unchanged and
 * unaware, and the banner stays put because nothing it owns was touched.
 *
 * `body.ista-mode` is what shows the container; leaving the shell removes it.
 */

/* exported istaChromeEnsure istaChromeShow istaChromeHide istaChromeActive
   istaBannerSync istaStateStart istaStateStop istaOpening istaOpeningSet */

/** How often the banner re-reads KL15 / KL30, in ms. Matches the topbar poll. */
const ISTA_STATE_MS = 3000;

/** The chrome container's id. */
const ISTA_CHROME_ID = 'ista-chrome';

/** The state poll's timer, or null when the shell is down. @type {*} */
let istaStateTimer = null;

/**
 * True while the shell is deliberately opening one of the app's screens.
 *
 * The router tears the chrome down when a screen renders under it, because
 * that is what "the user navigated away" looks like from the outside. A
 * wrapped sub-tab renders exactly the same way, so it has to say that it is
 * the shell's own doing. Kept here rather than in screen.js because the
 * router reads it and this file is the one that owns the chrome's state.
 * @type {boolean}
 */
let istaOpeningFlag = false;

/**
 * Is the shell opening one of its wrapped screens right now?
 * @returns {boolean}
 */
function istaOpening() {
  return istaOpeningFlag;
}

/**
 * Mark the shell as opening (or done opening) a wrapped screen.
 * @param {boolean} on - true while the screen renders
 * @returns {void}
 */
function istaOpeningSet(on) {
  istaOpeningFlag = !!on;
}

/**
 * The chrome container, created on first use. It is inserted BEFORE `#view`
 * so the banner sits under the topbar and above whatever screen is up.
 * @returns {HTMLElement|null} the container, or null with no DOM
 */
function istaChromeEnsure() {
  if (typeof document === 'undefined') return null;
  let el = document.getElementById(ISTA_CHROME_ID);
  if (el) return el;
  const host = document.getElementById('view');
  if (!host || !host.parentNode) return null;
  el = document.createElement('div');
  el.id = ISTA_CHROME_ID;
  el.className = 'ista-chrome';
  el.hidden = true;
  host.parentNode.insertBefore(el, host);
  return el;
}

/**
 * Is the shell up?
 * @returns {boolean}
 */
function istaChromeActive() {
  return (
    typeof document !== 'undefined' &&
    document.body.classList.contains('ista-mode')
  );
}

/**
 * Put the shell up: show the chrome and start the state poll.
 * @returns {void}
 */
function istaChromeShow() {
  const el = istaChromeEnsure();
  if (!el) return;
  el.hidden = false;
  document.body.classList.add('ista-mode');
  istaStateStart();
}

/**
 * Take the shell down: hide the chrome, stop the poll. Called when a
 * non-ISTA route opens, so a screen reached from inside the shell (a module
 * the tree opened, say) does not keep a banner describing a car it left.
 * @returns {void}
 */
function istaChromeHide() {
  istaStateStop();
  istaOpeningSet(false);
  if (typeof document === 'undefined') return;
  document.body.classList.remove('ista-mode');
  const el = document.getElementById(ISTA_CHROME_ID);
  if (el) el.hidden = true;
}

/**
 * The banner's markup for one car.
 *
 * The VIN is shown in full, as the Garage shows it: this is the owner's own
 * car on the owner's own machine, and a workshop banner whose VIN is starred
 * out cannot be checked against the one on the screen. (The beta journal and
 * shared report links DO mask it -- those leave the machine; this does not.)
 * @param {object|null} car - the picked GarageCar, or null
 * @param {string|null} chassis - the chassis, when no car is picked
 * @returns {string} HTML
 */
function istaBannerHtml(car, chassis) {
  const cid = (car && car.chassis) || chassis || '';
  const disp =
    cid && typeof dispChassis === 'function' ? dispChassis(cid) : cid;
  const name =
    car && typeof garageCarLabel === 'function'
      ? garageCarLabel(car)
      : disp || 'No vehicle';
  const bits = typeof istaCarBits === 'function' ? istaCarBits(car) : '';
  const vin = (car && car.vin) || '';
  return (
    `<div class="ista-banner">` +
    `<div class="ista-banner-id">` +
    `<button type="button" class="ista-car-pick" id="ista-car-pick" ` +
    `title="Choose which vehicle the shell works on">` +
    `<span class="ista-car-name">${esc(name)}</span>` +
    `<span class="ista-car-caret" aria-hidden="true">▾</span>` +
    `</button>` +
    (disp ? `<span class="ista-chassis">${esc(disp)}</span>` : '') +
    (vin
      ? `<span class="ista-vin mono" title="Vehicle identification number">` +
        `${esc(vin)}</span>`
      : '') +
    `</div>` +
    (bits ? `<div class="ista-banner-desc">${esc(bits)}</div>` : '') +
    `<div class="ista-banner-state">` +
    `<span class="ista-kl" title="Terminal 30: battery">` +
    `<span class="ista-kl-name">KL30</span>` +
    `<span class="ista-kl-led" id="ista-kl30"></span>` +
    `<span class="ista-kl-val" id="ista-kl30-v">--</span></span>` +
    `<span class="ista-kl" title="Terminal 15: ignition">` +
    `<span class="ista-kl-name">KL15</span>` +
    `<span class="ista-kl-led" id="ista-kl15"></span>` +
    `<span class="ista-kl-val" id="ista-kl15-v">--</span></span>` +
    `</div></div>`
  );
}

/**
 * Read KL15 / KL30 and paint the banner's two lamps.
 *
 * The same truth rules the INPA start screen's lamps use (core/nav.js
 * syncVselState): battery is on when `/api/state` reports a voltage at all,
 * ignition only on a strict `true`. With no cable both read "--" rather than
 * "off" -- unknown is not the same as off, and a workshop banner that
 * confidently says "off" about a car it cannot see is worse than one that
 * admits it does not know.
 * @returns {Promise<void>}
 */
async function istaBannerSync() {
  if (typeof document === 'undefined') return;
  const b = document.getElementById('ista-kl30');
  const bv = document.getElementById('ista-kl30-v');
  const i = document.getElementById('ista-kl15');
  const iv = document.getElementById('ista-kl15-v');
  if (!b || !bv || !i || !iv) return;
  let st = { battery: null, ignition: null, connected: false };
  try {
    st = await api('/api/state');
  } catch {
    /* no engine: the lamps stay unknown */
  }
  // the banner may have been redrawn (or the shell left) while we waited
  if (!document.getElementById('ista-kl30')) return;
  const known = !!st.connected;
  const batOn = st.battery != null;
  const ignOn = st.ignition === true;
  b.className = 'ista-kl-led' + (known && batOn ? ' on' : '');
  i.className = 'ista-kl-led' + (known && ignOn ? ' on' : '');
  if (!known) {
    bv.textContent = '--';
    iv.textContent = '--';
    return;
  }
  // a voltage when the cable reports one; the nominal flag means the cable
  // cannot read its own lines, so say "on" rather than inventing a number
  bv.textContent = batOn
    ? st.derived
      ? 'on'
      : `${Number(st.battery).toFixed(1)} V`
    : 'off';
  iv.textContent = ignOn ? 'on' : 'off';
}

/**
 * Start the banner's state poll (idempotent).
 * @returns {void}
 */
function istaStateStart() {
  istaBannerSync();
  if (istaStateTimer != null) return;
  if (typeof setInterval !== 'function') return;
  istaStateTimer = setInterval(() => {
    // the shell may have gone down without a stop (a screen navigated away)
    if (!istaChromeActive()) return istaStateStop();
    istaBannerSync();
  }, ISTA_STATE_MS);
}

/**
 * Stop the banner's state poll.
 * @returns {void}
 */
function istaStateStop() {
  if (istaStateTimer != null && typeof clearInterval === 'function')
    clearInterval(istaStateTimer);
  istaStateTimer = null;
}

if (typeof window !== 'undefined') {
  window.istaChromeHide = istaChromeHide;
  window.istaChromeActive = istaChromeActive;
  window.istaOpening = istaOpening;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ISTA_STATE_MS,
    ISTA_CHROME_ID,
    istaChromeEnsure,
    istaChromeShow,
    istaChromeHide,
    istaChromeActive,
    istaBannerHtml,
    istaBannerSync,
    istaStateStart,
    istaStateStop,
    istaOpening,
    istaOpeningSet,
  };
}
