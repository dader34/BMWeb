/**
 * @file Opening a search result: the deep link a hit becomes, and the
 * navigation that follows it.
 *
 * A result names a chassis, a module, a menu and a screen -- exactly the four
 * parts of the vehicle deep link the router already resolves
 * (#car/<CHASSIS>/<SGBD>/<MENU>/<SCREEN>). Setting the hash is the whole
 * navigation: the router replays it through showEcuDeep, the runtime starts
 * the script and lands on the named menu and screen.
 *
 * LANDING IS THE TARGET, NEVER PRESSING. The link carries names, not a key to
 * press, so opening a result runs a menu prologue and a screen's read cycle
 * and nothing else. A key that writes to a module (a clear, an activation) is
 * still found and still shown -- marked, so the row says so -- but reaching it
 * puts the user in front of it with the key unpressed, which is where INPA
 * would have put them too.
 */

/* exported searchHitRoute, searchOpenHit */

/**
 * The deep-link route a hit opens, without the leading '#'.
 *
 * A screen entry has no menu of its own, so it links to the screen alone and
 * lets the script's entry menu stand; a key links to the menu it sits on, and
 * to its screen when it opens one. A module no chassis owns cannot be linked
 * (the route needs a car), so those return null and the row renders unopenable
 * rather than pointing at a page that would 404.
 * @param {SearchHit} hit - the result row
 * @param {string} chassis - the chassis whose group the row is rendered under
 * @returns {string|null} the route, or null when the hit cannot be opened
 */
function searchHitRoute(hit, chassis) {
  const cid = String(chassis || '').toUpperCase();
  if (!cid || !hit || !hit.module || !hit.module.sgbd) return null;
  const parts = ['car', cid, encodeURIComponent(hit.module.sgbd)];
  const e = hit.entry;
  const menu = e.t === 'k' ? e.m : null;
  const screen = e.s || null;
  if (menu) {
    parts.push(encodeURIComponent(menu));
    if (screen) parts.push(encodeURIComponent(screen));
  } else if (screen) {
    // no menu to name: the router's tail is positional, so the entry menu
    // stands in for it and the screen keeps its place as the second part
    parts.push('', encodeURIComponent(screen));
  }
  return parts.join('/');
}

/**
 * Open a result: set the hash and let the router do the navigation.
 * @param {SearchHit} hit - the result row
 * @param {string} chassis - the chassis whose group the row is rendered under
 * @returns {boolean} false when the hit has no route
 */
function searchOpenHit(hit, chassis) {
  const route = searchHitRoute(hit, chassis);
  if (!route) return false;
  location.hash = '#' + route;
  return true;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { searchHitRoute, searchOpenHit };
}
