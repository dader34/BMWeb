/**
 * @file Navigation is locked while a control unit is being written.
 *
 * A flash that is cut off can leave a control unit that does not start. The
 * write itself does not depend on the screen that started it, but a user who
 * has left that screen no longer sees it running -- and may close the tab,
 * pull the cable or start something else. So while a write is in progress
 * the app stays where it is: Back, the breadcrumbs, the top bar's buttons,
 * the browser's own Back and Forward, and a script screen's Exit all do
 * nothing but say why.
 *
 * "A write is in progress" is the Flashing app's own word for it: it sets
 * the lock for the length of every flash (fbFlashingBar). Reads and Identify
 * do not lock anything.
 */

/* exported navLocked, navSetLocked, navRefuse */

/** How long the notice stays up, ms. */
const NAV_LOCK_NOTICE_MS = 4000;

/** What the notice says. */
const NAV_LOCK_TEXT =
  'A flash is running. Stay on this page until it has finished.';

/** Whether a write is in progress (navSetLocked). */
let _navLocked = false;

/**
 * Whether the app must stay on the screen it is on.
 * @returns {boolean}
 */
function navLocked() {
  return _navLocked;
}

/**
 * Lock or release navigation.
 * @param {boolean} locked - True while a control unit is being written.
 */
function navSetLocked(locked) {
  _navLocked = !!locked;
}

/** @type {number|null} The notice's timer. */
let _navLockTimer = null;

/** Show the notice, or keep it up a little longer when it is showing. */
function navLockNotice() {
  if (typeof document === 'undefined') return;
  let el = document.getElementById('nav-lock-notice');
  if (!el) {
    el = document.createElement('div');
    el.id = 'nav-lock-notice';
    el.className = 'nav-lock-notice';
    el.setAttribute('role', 'alert');
    el.textContent = NAV_LOCK_TEXT;
    document.body.appendChild(el);
  }
  el.hidden = false;
  if (_navLockTimer) clearTimeout(_navLockTimer);
  _navLockTimer = setTimeout(() => {
    el.hidden = true;
    _navLockTimer = null;
  }, NAV_LOCK_NOTICE_MS);
}

/**
 * Ask whether a move to another screen must be refused; when it must, say
 * so on the screen.
 * @returns {boolean} True when the caller must not navigate.
 */
function navRefuse() {
  if (!navLocked()) return false;
  navLockNotice();
  return true;
}

if (typeof document !== 'undefined')
  // the top bar: Back, the breadcrumbs, the home mark, Garage, the layout
  // switch, Report, Settings. The cable chip stays: it does not navigate.
  document.addEventListener(
    'click',
    (e) => {
      if (!navLocked()) return;
      const t = e.target;
      if (!t || typeof t.closest !== 'function') return;
      if (!t.closest('.topbar') || t.closest('#link-status, #win-controls'))
        return;
      e.preventDefault();
      e.stopImmediatePropagation();
      navLockNotice();
    },
    true
  );

if (typeof module !== 'undefined' && module.exports)
  module.exports = { navLocked, navSetLocked, navRefuse };
