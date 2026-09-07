/**
 * @file Vehicle identity: what an SA number is called -- the chassis order
 * dictionary's keyword and the parts catalogue's dated English name.
 *
 * Fourth piece of core/vehicle-identity/; leans on tables.js for the
 * chassis tables and on fa.js for the code spelling.
 */

/**
 * One dated name row off data/sanames.js: [art, from, to, name].
 * @typedef {[string, number, number, string]} SaNameRow
 */

(function (root) {
  'use strict';

  const VI = root.VehicleIdentity || (root.VehicleIdentity = {});
  const Tables = VI.tablesFor ? VI : require('./tables.js');
  const Fa = VI.saCode ? VI : require('./fa.js');

  /**
   * Rank of the catalogue "art" letter when several rows share a number:
   * options ('S') outrank the country/package/accessory codes that share
   * the number space -- <0807> is "National version Japan" only because no
   * option 807 exists.
   */
  const SA_ART_RANK = { S: 0, L: 1, Q: 2, N: 3, Y: 4, X: 5, V: 6 };
  /** Rank for an art letter the table above does not list. */
  const SA_ART_UNRANKED = 9;

  /**
   * What an SA number means, from the chassis order dictionary. Falls back
   * to null so a caller can show the bare number rather than invent a label.
   * The dictionaries are keyed by number; an alphanumeric code has no entry
   * and must not borrow one by way of its digits.
   * @param {string|null|undefined} chassis - Chassis id.
   * @param {unknown} code - The SA code.
   * @returns {string|null} The keyword(s), comma-joined, or null.
   */
  function saLabel(chassis, code) {
    const t = Tables.tablesFor(chassis);
    const at = t && t.at;
    const key = Fa.saCode(code);
    if (!at || !at.sa || !key || !/^\d+$/.test(key)) return null;
    const names = at.sa[key];
    return names && names.length ? names.join(', ') : null;
  }

  /**
   * What an SA number is CALLED, in English, off the ETK catalogue
   * (tools/etk_sa_names.py -> data/sanames.js). BMW reused numbers over the
   * years, so the name is chosen by the car's build date (YYYYMMDD; a
   * YYYYMM00 from the VIN index is fine). Without a date the earliest
   * window wins, since a bare number is most often quoted in its original
   * sense.
   * @param {unknown} code - The SA code.
   * @param {number|string|null|undefined} date - Build date as YYYYMMDD, or
   *   0/undefined for "earliest".
   * @returns {string|null} The English name, or null when the catalogue does
   *   not know the number (or is not loaded), so the caller falls back to the
   *   SGET keywords.
   */
  function saName(code, date) {
    const db = (typeof window !== 'undefined' && window.BMW_SA_NAMES) || null;
    const key = Fa.saCode(code);
    if (!db || !key || !/^\d+$/.test(key)) return null;
    /** @type {SaNameRow[]|undefined} */
    const rows = db[key];
    if (!rows || !rows.length) return null;
    const d = Number(date) || 0;
    const rank = (r) =>
      r[0] in SA_ART_RANK ? SA_ART_RANK[r[0]] : SA_ART_UNRANKED;
    const inWindow = (r) => d >= r[1] && (!r[2] || d < r[2]);
    const pool = d ? rows.filter(inWindow) : rows;
    if (!pool.length) return null;
    const best = pool
      .slice()
      .sort((a, b) => rank(a) - rank(b) || a[1] - b[1])[0];
    return best[3] || null;
  }

  const api = { saLabel, saName };
  Object.assign(VI, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
