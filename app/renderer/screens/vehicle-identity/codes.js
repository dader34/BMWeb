/**
 * @file Vehicle identity: THE IDENTITY READ, WITHOUT THE SCREEN.
 *
 * Third piece of screens/vehicle-identity/. The coding hub needs the car's
 * equipment codes before it can decide which module fills each slot, and it
 * needs them as data, not as a rendered card. This is that read: same
 * discovery, same job, same decoding, no DOM.
 */

/**
 * The car's equipment as data.
 * @typedef {object} ViIdentityCodes
 * @property {string[]} codes - SA catalogue numbers, the namespace SGET
 *   predicates use. An empty list means the car did not say, and callers
 *   must treat that as "nothing known" rather than "no equipment": selecting
 *   modules off an empty list would re-point them against nothing.
 * @property {Object<string, number>} ci - Coding-index stamps from the ZCS
 *   bridge (empty on an FA car).
 * @property {FaOrder|null} fa - The parsed order, on an FA car.
 * @property {ViReadKeys|null} keys - The coding keys, on a ZCS car.
 * @property {boolean} [blank] - The key read back blank.
 * @property {string|null} source - "sgbd:JOB" the answer came from.
 */

/**
 * Cache of readIdentityCodes by chassis, for the session.
 * @type {Map<string, Promise<ViIdentityCodes>>}
 */
const _viCodesCache = new Map();

/**
 * The empty answer: nothing known.
 * @returns {ViIdentityCodes} Empty codes.
 */
function viNoCodes() {
  return { codes: [], ci: {}, fa: null, keys: null, source: null };
}

/**
 * Read the order off one master and translate it. The order's tokens are
 * already catalogue numbers, so nothing else is needed.
 * @param {ViIdentityModule} m - A master with `fa`.
 * @returns {Promise<ViIdentityCodes|null>} The codes, or null when the
 *   master answered with no order.
 */
async function viCodesFromOrder(m) {
  const d = await api(`/api/ecu/${m.sgbd}/run/${m.faJob.job}`, {
    method: 'POST',
  });
  const text = await viFaText(new Map(flatResults(d.sets)), m.faJob.result);
  if (!text) return null;
  const fa = VehicleIdentity.parseFa(text);
  return {
    codes: VehicleIdentity.saCodesFromFa(fa),
    ci: {},
    fa,
    keys: null,
    source: `${m.sgbd}:${m.faJob.job}`,
  };
}

/**
 * Read the coding key off one master and translate it through BMW's
 * chassis tables.
 * @param {ViIdentityModule} m - A master with `zcs`.
 * @param {string} id - Upper-case chassis id.
 * @returns {Promise<ViIdentityCodes|null>} The codes (possibly blank and
 *   unresolved), or null when the reply held no valid key.
 */
async function viCodesFromKey(m, id) {
  const d = await api(`/api/ecu/${m.sgbd}/run/${m.zcsJob.job}`, {
    method: 'POST',
  });
  const keys = viKeysFrom(new Map(flatResults(d.sets)), m.zcsJob.keys);
  if (!keys) return null;
  const eq = VehicleIdentity.saCodesFromZcs(id, keys);
  return {
    codes: eq.codes,
    ci: eq.ci,
    fa: null,
    keys,
    blank: !!eq.blank,
    source: `${m.sgbd}:${m.zcsJob.job}`,
  };
}

/**
 * The car's equipment codes, read from its identity masters and memoised
 * per chassis for the session.
 * @param {string|null|undefined} chassisId - Chassis id, any case.
 * @returns {Promise<ViIdentityCodes>} The codes; empty when nothing
 *   answered.
 */
async function readIdentityCodes(chassisId) {
  const id = String(chassisId || '').toUpperCase();
  if (_viCodesCache.has(id)) return _viCodesCache.get(id);
  const p = (async () => {
    if (typeof VehicleIdentity === 'undefined') return viNoCodes();
    if (typeof loadTables === 'function') await loadTables();
    let masters;
    try {
      masters = await viIdentityModulesCached(id);
    } catch (e) {
      return viNoCodes();
    }
    if (!masters.length) return viNoCodes();

    // The order first: its tokens are already catalogue numbers.
    for (const m of masters.filter((x) => x.fa)) {
      try {
        const got = await viCodesFromOrder(m);
        if (got) return got;
      } catch (e) {
        /* try the next master */
      }
    }

    // Then the coding key, translated through BMW's chassis tables. A key
    // whose SA body is blank (all-FF) carries no equipment -- keep it only as
    // a last resort so a real FA/ZCS on another master still wins, and never
    // let a blank key fabricate an option list.
    let blankFallback = null;
    for (const m of masters.filter((x) => x.zcs)) {
      try {
        const result = await viCodesFromKey(m, id);
        if (!result) continue;
        if (result.blank || !result.codes.length) {
          // remember the first blank/unresolved key, but keep looking
          if (!blankFallback) blankFallback = result;
          continue;
        }
        return result;
      } catch (e) {
        /* try the next master */
      }
    }
    // nothing resolved: return the blank key honestly (codes:[]) so the UI
    // shows "no options decoded" rather than inventing any
    return blankFallback || viNoCodes();
  })();
  _viCodesCache.set(id, p);
  return p;
}
