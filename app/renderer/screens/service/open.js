/**
 * @file Running a service function: the route it opens, and the press that
 * follows.
 *
 * THIS SCREEN INVENTS NO EXECUTION PATH. A resolved task names a chassis, a
 * module, a menu and a key -- and the app already knows how to land on a
 * module's menu (showEcuDeep, the same deep link the job search opens) and
 * how to press a named key on arrival (showEcu's pressKey, the same one the
 * Garage's Fault scan button uses). Running a task is those two things and
 * nothing more, so everything the runtime guarantees about a keypress keeps
 * holding here: a write key still raises the runtime's own confirmation
 * (ipoNeedsConfirm over core/bestvm's isWriteJob), actuators are still
 * released on leave, and a script that stops itself still says why.
 *
 * PRESSING IS THE POINT, and it is what separates this app from the job
 * search. A search result LANDS and never presses, because the user was
 * looking for where something is. Here the user picked a task by name and
 * asked to run it, so the key is pressed for them exactly as their own press
 * would be -- which means through the confirmation, never around it.
 *
 * THE KEY IS PRESSED BY ITS LABEL, not its number. The runtime matches the
 * caption because a script resolves its own variant at run time and can land
 * on a different menu of the same family than the one the mapping recorded
 * (E46's lws5 ships m_abgleich_entwickler_5_0 and _5_2 for two sensor
 * generations, with the same key on each). A label that is not on the menu
 * the script actually opened simply does not press, which leaves the user in
 * front of the menu -- the same place a search result would have left them.
 */

/* exported serviceHitRoute, serviceRunHit */

/**
 * The deep-link route a hit opens, without the leading '#'.
 *
 * Same shape as a job-search result (#car/<CHASSIS>/<SGBD>/<MENU>[/<SCREEN>]),
 * because it is the same router and the same runtime on the other end.
 * @param {ServiceHit} hit - the resolved key
 * @param {string} chassis - the chassis it was resolved for
 * @returns {string|null} the route, or null when the hit cannot be opened
 */
function serviceHitRoute(hit, chassis) {
  const cid = String(chassis || '').toUpperCase();
  if (!cid || !hit || !hit.sgbd || !hit.menu) return null;
  const parts = [
    'car',
    cid,
    encodeURIComponent(hit.sgbd),
    encodeURIComponent(hit.menu),
  ];
  if (hit.screen) parts.push(encodeURIComponent(hit.screen));
  return parts.join('/');
}

/**
 * Open the module at the task's menu and press its key.
 *
 * Goes through showEcuDeep's own resolution (config lookup, then the live
 * runtime) rather than the hash, because the hash carries no "press this"
 * part -- by design: a link someone sends must never press a key on the
 * recipient's car. The press is a thing this screen asks for in the moment,
 * on a task the user just chose.
 * @param {ServiceHit} hit - the resolved key
 * @param {string} chassis - the chassis it was resolved for
 * @returns {boolean} false when the hit cannot be opened
 */
function serviceRunHit(hit, chassis) {
  const cid = String(chassis || '').toUpperCase();
  if (!hit || !hit.sgbd || !hit.menu || !cid) return false;
  if (typeof serviceOpenModule !== 'function') return false;
  serviceOpenModule(cid, hit.sgbd, hit.menu, hit.screen || null, hit.label);
  return true;
}

/**
 * Open one module at one menu, optionally pressing a key by its caption.
 *
 * The chassis config is what says which section a module sits in and which
 * record describes it, and showEcu needs both; showEcuDeep already does that
 * lookup but takes no key to press, so this repeats the lookup and calls
 * showEcu directly. A whole-car script (the module name IS the chassis) goes
 * through showVehicleScript, which carries the same pressKey argument.
 * @param {string} chassisId - the chassis id, upper-case
 * @param {string} sgbd - the module's SGBD
 * @param {string|null} menu - the menu to open
 * @param {string|null} screen - the screen to show on it
 * @param {string|null} pressLabel - a key to press on arrival, by its caption
 * @returns {Promise<void>}
 */
async function serviceOpenModule(chassisId, sgbd, menu, screen, pressLabel) {
  const want = String(sgbd).toLowerCase();
  // an exact, anchored caption match: a task's key must not press a
  // different key whose label merely contains the same words
  const press = pressLabel
    ? new RegExp(
        `^${String(pressLabel)
          .trim()
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
        'i'
      )
    : null;
  if (want === String(chassisId).toLowerCase()) {
    if (typeof showVehicleScript === 'function')
      return showVehicleScript(chassisId, menu, screen, press);
    return;
  }
  const ch =
    typeof tryApi === 'function'
      ? await tryApi(
          `/api/chassis/${chassisId}`,
          null,
          view,
          `failed to load ${typeof dispChassis === 'function' ? dispChassis(chassisId) : chassisId}`
        )
      : null;
  if (!ch) return;
  for (const sec of ch.sections || []) {
    const ecu = (sec.ecus || []).find(
      (e) => String(e.sgbd).toLowerCase() === want
    );
    if (ecu && typeof showEcu === 'function')
      return showEcu(chassisId, sec.name, ecu, menu, screen, press);
  }
  // the mapping named a module this chassis config does not list. Falling
  // back to the module list beats a blank screen: the car is still open.
  if (typeof sbLeft !== 'undefined' && sbLeft)
    sbLeft.textContent = `${sgbd} not in ${typeof dispChassis === 'function' ? dispChassis(chassisId) : chassisId}`;
  if (typeof backToModules === 'function') return backToModules(chassisId);
}

if (typeof window !== 'undefined') {
  window.serviceOpenModule = serviceOpenModule;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { serviceHitRoute, serviceRunHit, serviceOpenModule };
}
