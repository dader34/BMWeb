/**
 * @file Vehicle identity: access to the per-chassis coding tables, and the
 * SGFAM family map that says which control unit holds the car's identity.
 *
 * This is the first piece of core/vehicle-identity/. The pieces share one
 * namespace object (`VehicleIdentity` on the window) that each of them adds
 * to; in the browser that object is populated by load order, and under node
 * each piece requires the ones it leans on. The index piece is what callers
 * and tests require.
 *
 * BACKGROUND, for the whole folder. Two vehicle-level identity records exist,
 * on different generations of car:
 *
 *   ZCS (Zentral-Codier-Schluessel) -- E36..E53. Three keys (GM/SA/VN) in a
 *        20-byte region on the cluster or light module. The SA key is a
 *        64-bit FIELD OF BITS, not a list of option numbers.
 *   FA  (Fahrzeugauftrag) -- E60 and later. The build order as TEXT, whose
 *        `$` tokens ARE the SA catalog numbers.
 *
 * WHY THIS MODULE EXISTS. An SGET row decides whether the car has an ECU by
 * testing a predicate over SA CATALOG NUMBERS (S205 = automatic, S210 = DSC).
 * A ZCS key can only say "bit 45 is set". Comparing those two directly is a
 * namespace error: measured on a real E46 it hid 37 of 44 modules, DSC and
 * the airbag among them, which is why the equipment filter had been sitting
 * disabled behind an unconditional `return mods`.
 *
 * BMW ships the translation as two text tables (tools/decompile/ncs_tables.py):
 *
 *   ZST -> which keywords hold when given key bits are set
 *   AT  -> which SA number each keyword belongs to
 *
 * so the chain is
 *
 *   ZCS keys -> ZST mask match -> keywords -> AT -> SA numbers -> SGET
 *
 * On FA cars none of that is needed: the `$` tokens are already SA numbers.
 * That is the whole reason an FA read is worth having beyond showing a build
 * sheet -- it sidesteps the bridge entirely.
 *
 * COVERAGE IS PARTIAL AND SAYS SO. Of 63 E46 ZST keywords only 12 carry an SA
 * number; the rest are body, engine and market names (LIM, COUP, M52B25, US)
 * that have no catalog number by design. So the bridge reports what it could
 * resolve AND what it could not, and callers must treat an unresolved car as
 * "filter unknown" rather than "option absent" -- see saCodesFromZcs().
 */

/**
 * One ZST row: the keywords that hold when the given key bits are set.
 * @typedef {object} ZstRow
 * @property {string} key - The row's own key: a type key (DE93), an option
 *   number (0214) or a bare word (GVN).
 * @property {string} gm - Hex mask over the GM key; all-zero when
 *   unconstrained.
 * @property {string} sa - Hex mask over the SA key.
 * @property {string} vn - Hex mask over the VN key.
 * @property {string[]} keywords - The keywords the row asserts.
 * @property {Object<string, number>} [ci] - Coding-index stamps the row
 *   carries, keyed by SG short name (KMBI -> 4).
 * @property {boolean} [empty] - True for a retired ("ausblenden") row.
 */

/**
 * One SABITS row (ZST.K00): the bits an option sets when it is encoded.
 * @typedef {object} SabitsRow
 * @property {string} key - The SA number, as the table spells it (0194).
 * @property {string} gm - Hex mask over the GM key.
 * @property {string} sa - Hex mask over the SA key.
 * @property {string} vn - Hex mask over the VN key.
 */

/**
 * One SGFAM row: what a logical control unit is and what it holds.
 * @typedef {object} SgfamRow
 * @property {string} cabd - The coding SGBD (C_KMB46) for this family.
 * @property {string} [asw] - The application SGBD, where SGFAM names one.
 * @property {boolean|number} [fa] - Truthy when the module holds the order.
 * @property {boolean|number} [zcs] - Truthy when the module holds the key.
 */

/**
 * The tables one chassis ships, as tools/decompile/ncs_tables.py writes them.
 * @typedef {object} ChassisTables
 * @property {Object<string, SgfamRow>} [sgfam] - Family map by SG short name.
 * @property {ZstRow[]} [zst] - The decoding table.
 * @property {SabitsRow[]} [sabits] - The encoding table (ZST.K00).
 * @property {{ kw?: Object<string, string[]>, sa?: Object<string, string[]> }} [at]
 *   - The assignment table: keyword -> SA numbers and SA number -> keywords.
 */

/**
 * An identity master as the UI offers it: one ECU able to answer a read.
 * @typedef {object} IdentityMaster
 * @property {string} sg - SGFAM short name (KMB, EWS, ALSZ).
 * @property {string} cabd - Its coding SGBD.
 * @property {string|undefined} asw - Its application SGBD, if any.
 * @property {boolean} fa - Holds the vehicle order.
 * @property {boolean} zcs - Holds the coding key.
 */

(function (root) {
  'use strict';

  const VI = root.VehicleIdentity || (root.VehicleIdentity = {});

  /**
   * Every chassis's tables, off the lazily loaded data/tables.js global.
   * @returns {Object<string, ChassisTables>|null} Tables by chassis id, or
   *   null before the data has loaded.
   */
  function tables() {
    return (typeof window !== 'undefined' && window.BMW_TABLES) || null;
  }

  /**
   * A chassis's tables, or null. Chassis ids arrive in mixed case from routes.
   * @param {string|null|undefined} chassis - Chassis id (e46, E46).
   * @returns {ChassisTables|null} That chassis's tables, or null.
   */
  function tablesFor(chassis) {
    const t = tables();
    if (!t) return null;
    const id = String(chassis || '').toUpperCase();
    return t[id] || null;
  }

  /**
   * The ECUs that can answer an identity read, in the order the UI should
   * offer them.
   *
   * Derived from SGFAM's own flag columns rather than a hardcoded per-chassis
   * list, because the answer differs by chassis AND by which SGFAM ships: on
   * E46 it is AKMB and KMB (both CABD C_KMB46), ALSZ (C_LSZA) and EWS
   * (C_EWS3), with FA and ZCS split across them.
   * @param {string|null|undefined} chassis - Chassis id.
   * @returns {IdentityMaster[]} The masters, sorted by short name; empty when
   *   the chassis ships no family map.
   */
  function identityMasters(chassis) {
    const t = tablesFor(chassis);
    const sgfam = t && t.sgfam;
    if (!sgfam) return [];
    return Object.keys(sgfam)
      .filter((sg) => sgfam[sg].fa || sgfam[sg].zcs)
      .sort()
      .map((sg) => ({
        sg,
        cabd: sgfam[sg].cabd,
        asw: sgfam[sg].asw,
        fa: !!sgfam[sg].fa,
        zcs: !!sgfam[sg].zcs,
      }));
  }

  /**
   * The whole family map, for showing which SGBD backs a logical ECU name.
   * @param {string|null|undefined} chassis - Chassis id.
   * @returns {Object<string, SgfamRow>|null} SGFAM rows by short name, or
   *   null when the chassis ships none.
   */
  function familyMap(chassis) {
    const t = tablesFor(chassis);
    return (t && t.sgfam) || null;
  }

  const api = { tables, tablesFor, identityMasters, familyMap };
  Object.assign(VI, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
