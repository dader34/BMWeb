/**
 * @file Vehicle identity: the assembled `VehicleIdentity` API.
 *
 * Last piece of core/vehicle-identity/. In the browser the earlier pieces
 * have already filled the namespace by load order and this only pins it to
 * the window; under node it requires them, so
 * `require('core/vehicle-identity/index.js')` answers with the same surface
 * the single file used to export:
 *
 *   tables.js    tables, tablesFor, identityMasters, familyMap
 *   zcs.js       maskHolds, zstMatches, sabitsMatches, typeRows,
 *                chassisFromKeys, saCodesFromZcs, keysFromRegion
 *   fa.js        FA_MARKERS, parseFa, formatFa, saCode, saCodesFromFa
 *   sa-names.js  saLabel, saName
 */

(function (root) {
  'use strict';

  const VI = root.VehicleIdentity || (root.VehicleIdentity = {});
  if (typeof require === 'function' && !VI.saCodesFromZcs) {
    for (const piece of [
      './tables.js',
      './zcs.js',
      './fa.js',
      './sa-names.js',
    ]) {
      Object.assign(VI, require(piece));
    }
  }
  root.VehicleIdentity = VI;
  if (typeof module !== 'undefined' && module.exports) module.exports = VI;
})(typeof window !== 'undefined' ? window : this);
