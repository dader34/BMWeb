/**
 * @file Vehicle identity: the ZCS side -- matching the three coding keys
 * against BMW's ZST and SABITS tables, naming the chassis from the GM key,
 * and the bridge from key bits to SA catalog numbers.
 *
 * Second piece of core/vehicle-identity/; leans on tables.js for table
 * access and on core/coding-zcs.js for the key layout and the blank-key test.
 */

/**
 * The three coding keys, hex bodies without check characters.
 * @typedef {object} ZcsKeys
 * @property {string} gm - Grundmerkmal, 8 hex digits.
 * @property {string} sa - Sonderausstattung, 16 hex digits (a bit field).
 * @property {string} vn - Versionsnummer, 10 hex digits.
 */

/**
 * One chassis's claim on a set of keys, from chassisFromKeys.
 * @typedef {object} ChassisClaim
 * @property {string} chassis - Chassis id (E39).
 * @property {string} key - The type key that held (DE93).
 * @property {string[]} keywords - That type row's keywords (body, engine,
 *   gearbox, market).
 * @property {boolean} exact - The GM equals the row's mask outright.
 * @property {number} bits - Bits in the row's GM mask (specificity).
 * @property {number} rows - How many of the chassis's type rows held.
 */

/**
 * What the coding keys say about the car's equipment.
 * @typedef {object} ZcsEquipment
 * @property {string[]} codes - SA catalog numbers, the namespace SGET
 *   predicates use, unpadded and sorted.
 * @property {string[]} keywords - Every ZST keyword that held, resolved or
 *   not.
 * @property {Object<string, number>} ci - Coding-index stamps by SG short
 *   name (KMBI_CI_04 -> KMBI: 4), saying WHICH .Cxx a module should be read
 *   against.
 * @property {string[]} unresolved - Keywords carrying no SA number:
 *   body/engine/market names, and the reason a caller must not read "no
 *   code" as "no option".
 * @property {boolean} resolved - At least one code came through.
 * @property {number} rows - ZST rows that held.
 * @property {number} [bits] - SABITS rows that held.
 * @property {boolean} [blank] - The SA key was blank (all-FF/all-00), so
 *   nothing was matched at all.
 */

/**
 * The three keys as pulled out of a raw 20-byte region.
 * @typedef {object} RegionKeys
 * @property {string} gm - GM key body.
 * @property {string} sa - SA key body.
 * @property {string} vn - VN key body.
 * @property {object} region - The parsed region, as core/coding-zcs
 *   returns it (per-key body, check character and validity).
 */

(function (root) {
  'use strict';

  const VI = root.VehicleIdentity || (root.VehicleIdentity = {});
  const Tables = VI.tablesFor ? VI : require('./tables.js');

  /**
   * The ZCS key codec: the window global in the browser; under node, the
   * coding module wherever the tree keeps it (core/coding/zcs.js, else the
   * flat core/coding-zcs.js), so either layout loads.
   * @returns {object|null} The codec, or null when none can be found.
   */
  function loadCodingZcs() {
    if (typeof window !== 'undefined' && window.CodingZcs)
      return window.CodingZcs;
    if (typeof require !== 'function') return null;
    for (const p of ['../coding/zcs.js', '../coding-zcs.js']) {
      try {
        return require(p);
      } catch (e) {
        /* not this layout */
      }
    }
    return null;
  }
  const Zcs = loadCodingZcs();

  /** Bytes in a ZCS region: GM (4+1), SA (8+1), VN (5+1), check chars inclusive. */
  const ZCS_REGION_BYTES = 20;

  /** The three key fields a ZST or SABITS row may constrain. */
  const KEY_FIELDS = ['gm', 'sa', 'vn'];

  /**
   * A hex string reduced to its hex digits, upper case. Strips the C1/C2/C3
   * channel tags' punctuation and a `-X` check suffix's dash, so a key the
   * screen holds as "C2FFFF...-S" still compares against a bare mask.
   * @param {unknown} s - Any value; null yields ''.
   * @returns {string} Upper-case hex digits only.
   */
  function up(s) {
    return s == null
      ? ''
      : String(s)
          .replace(/[^0-9A-Fa-f]/g, '')
          .toUpperCase();
  }

  /**
   * Does `key` (hex string) have every bit of `mask` (hex string) set?
   *
   * The keys are up to 64 bits, past what a JS number holds exactly, so this
   * compares nibble by nibble rather than going through parseInt.
   * @param {string|null|undefined} key - The key's hex body.
   * @param {string|null|undefined} mask - The mask's hex body, same width.
   * @returns {boolean} True when every masked bit is set; an all-zero mask
   *   matches nothing.
   */
  function maskHolds(key, mask) {
    if (!key || !mask || key.length !== mask.length) return false;
    let any = false;
    for (let i = 0; i < mask.length; i++) {
      const m = parseInt(mask[i], 16);
      if (!m) continue; // this nibble is unconstrained
      any = true;
      const k = parseInt(key[i], 16);
      if (Number.isNaN(k) || (k & m) !== m) return false;
    }
    return any; // all-zero mask matches nothing
  }

  /**
   * Does a table row hold for these keys? A row constrains any combination of
   * GM, SA and VN, and an all-zero mask is BMW retiring an entry
   * ("ausblenden fuer ZEKO") rather than a wildcard -- so a row matches only
   * where it actually constrains something, and every field it does
   * constrain must hold.
   * @param {ZstRow|SabitsRow} row - The row, with hex masks per key field.
   * @param {ZcsKeys} keys - Normalised keys (see up()).
   * @returns {boolean} True when the row constrains at least one field and
   *   all constrained fields hold.
   */
  function rowHolds(row, keys) {
    let held = false;
    for (const field of KEY_FIELDS) {
      const mask = row[field];
      if (!mask || !/[^0]/.test(mask)) continue; // unconstrained here
      if (!maskHolds(keys[field], mask)) return false; // constrained and failed
      held = true;
    }
    return held;
  }

  /**
   * The keys with each body reduced to its hex digits.
   * @param {Partial<ZcsKeys>|null|undefined} keys - Keys as read.
   * @returns {ZcsKeys} Normalised keys, '' where missing.
   */
  function normKeys(keys) {
    return {
      gm: up(keys && keys.gm),
      sa: up(keys && keys.sa),
      vn: up(keys && keys.vn),
    };
  }

  /**
   * Every ZST row whose masks hold for these keys (see rowHolds); retired
   * rows never match.
   * @param {string|null|undefined} chassis - Chassis id.
   * @param {Partial<ZcsKeys>|null|undefined} keys - The car's keys.
   * @returns {ZstRow[]} The rows that hold, in table order.
   */
  function zstMatches(chassis, keys) {
    const t = Tables.tablesFor(chassis);
    const rows = (t && t.zst) || [];
    const k = normKeys(keys);
    return rows.filter((r) => !r.empty && rowHolds(r, k));
  }

  /**
   * Every SABITS row (ZST.K00, SA number -> the bits that option sets)
   * whose masks hold for these keys. Same rule as zstMatches.
   *
   * This is the table the factory ENCODES a key from, and it outlives the
   * decoding table: E39's ZST.000 retired 0194/0364/0645 and never listed
   * 0223/0316/0403/0677, all of which K00 still carries. Without it an E39
   * shows six of the thirteen options the car actually has.
   * @param {string|null|undefined} chassis - Chassis id.
   * @param {Partial<ZcsKeys>|null|undefined} keys - The car's keys.
   * @returns {SabitsRow[]} The rows that hold, in table order.
   */
  function sabitsMatches(chassis, keys) {
    const t = Tables.tablesFor(chassis);
    const rows = (t && t.sabits) || [];
    const k = normKeys(keys);
    return rows.filter((r) => rowHolds(r, k));
  }

  /**
   * Bits set in a hex mask.
   * @param {string|null|undefined} mask - Hex digits.
   * @returns {number} The population count.
   */
  function popcount(mask) {
    let n = 0;
    for (const ch of String(mask || '')) {
      const v = parseInt(ch, 16);
      if (!Number.isNaN(v))
        n += (v & 1) + ((v >> 1) & 1) + ((v >> 2) & 1) + ((v >> 3) & 1);
    }
    return n;
  }

  /**
   * The type-key rows that hold for the GM, most specific first.
   *
   * A type-key row is one keyed by a type (DE93), not an option number, and
   * constraining the GM. Several hold for one car -- the GM column is a
   * mask, and 54110000 (DE11, the 535i) is a subset of 54930000 (DE93, the
   * M5) bit for bit -- so "holds" is not "is". The row that NAMES the car is
   * the most specific one: the exact value first, else the most bits. Its
   * keywords are the car's body, engine, gearbox and market; the weaker
   * rows' keywords (M62B35 for an S62 car) are not.
   *
   * ON THE GM ALONE. A type row may also stamp a VN bit (DE93 carries
   * 0000000001), but the type is the GM value; the SA/VN keys say what
   * was fitted, not what the car is, and must not veto the name.
   * @param {string|null|undefined} chassis - Chassis id.
   * @param {Partial<ZcsKeys>|null|undefined} keys - The car's keys; only gm
   *   is read.
   * @returns {ZstRow[]} Holding type rows, best first.
   */
  function typeRows(chassis, keys) {
    const gm = up(keys && keys.gm);
    const t = Tables.tablesFor(chassis);
    const rows = (t && t.zst) || [];
    return rows
      .filter(
        (r) =>
          !r.empty &&
          r.gm &&
          /[^0]/.test(r.gm) &&
          !/^\d+$/.test(r.key) &&
          maskHolds(gm, r.gm)
      )
      .sort((a, b) => {
        const ea = a.gm === gm ? 1 : 0;
        const eb = b.gm === gm ? 1 : 0;
        return (
          eb - ea ||
          popcount(b.gm) - popcount(a.gm) ||
          b.keywords.length - a.keywords.length
        );
      });
  }

  /**
   * The chassis a set of keys belongs to, ranked best first; empty when no
   * table claims the key.
   *
   * THIS IS HOW A PLUG-IN-AND-GO TOOL KNOWS THE CAR WITHOUT BEING TOLD. The
   * Grundmerkmal key (54930000) is the car's type key in BMW's own numbering,
   * and every chassis ZST carries the type-key rows for the types it was
   * built as (DE93 -> LIM, S62B50, MAN, LL, US). Asking every table for its
   * most specific holding type row names the chassis -- no address list, no
   * VIN prefix table, and it keeps working for a car whose VIN the cluster
   * cannot say in full. An exact type value beats any subset (E38's GJ83
   * mask sits inside the M5's GM bit for bit; DE93 equals it).
   * @param {Partial<ZcsKeys>|null|undefined} keys - The car's keys.
   * @returns {ChassisClaim[]} Claims, exact matches first, then by mask
   *   specificity.
   */
  function chassisFromKeys(keys) {
    const t = Tables.tables();
    if (!t) return [];
    const gm = up(keys && keys.gm);
    const out = [];
    for (const chassis of Object.keys(t)) {
      if (chassis.startsWith('_')) continue;
      const held = typeRows(chassis, keys);
      if (!held.length) continue;
      const best = held[0];
      out.push({
        chassis,
        key: best.key,
        keywords: best.keywords,
        exact: best.gm === gm,
        bits: popcount(best.gm),
        rows: held.length,
      });
    }
    return out.sort(
      (a, b) => (b.exact ? 1 : 0) - (a.exact ? 1 : 0) || b.bits - a.bits
    );
  }

  /**
   * The answer for a key that carries no equipment at all.
   * @returns {ZcsEquipment} Empty equipment, flagged blank.
   */
  function blankEquipment() {
    return {
      codes: [],
      keywords: [],
      ci: {},
      unresolved: [],
      resolved: false,
      rows: 0,
      blank: true,
    };
  }

  /**
   * What the car's ZCS keys say about its equipment: the bridge from key
   * bits to SA catalog numbers.
   *
   * A BLANK SA KEY IS NOT AN EQUIPMENT LIST. An all-FF (or all-00) SA body
   * is an erased or never-programmed region -- and BMW's own "no special
   * equipment" key is FFFFFFFFFFFFFFFF with a valid check char, so it looks
   * structurally sound while carrying zero options. A modern car keeps its
   * real equipment in the FA (parseFa/saCodesFromFa); its legacy ZCS SA key
   * is legitimately blank. Matching that blank against the assignment table
   * invents SA numbers the car does not have (the phantom-options bug), so
   * the bridge declines and lets the caller fall back to the FA or report
   * "no VO".
   * @param {string|null|undefined} chassis - Chassis id.
   * @param {Partial<ZcsKeys>|null|undefined} keys - The car's keys.
   * @returns {ZcsEquipment} Codes, keywords, stamps and what stayed
   *   unresolved.
   */
  function saCodesFromZcs(chassis, keys) {
    if (
      Zcs &&
      typeof Zcs.isBlankSaKey === 'function' &&
      Zcs.isBlankSaKey(keys && keys.sa)
    ) {
      return blankEquipment();
    }
    const t = Tables.tablesFor(chassis);
    const at = (t && t.at) || null;
    const rows = zstMatches(chassis, keys);
    // Of the type-key rows only the most specific one speaks for the car
    // (see typeRows); every other row is an option or a series stamp.
    const types = typeRows(chassis, keys);
    const spoken = new Set(types.slice(1));
    const keywords = [];
    const ci = {};
    for (const r of rows) {
      if (spoken.has(r)) continue;
      for (const k of r.keywords) if (!keywords.includes(k)) keywords.push(k);
      for (const sg of Object.keys(r.ci || {})) ci[sg] = r.ci[sg];
    }
    const codes = [];
    const unresolved = [];
    for (const k of keywords) {
      const nums = at && at.kw && at.kw[k];
      if (nums && nums.length) {
        for (const n of nums) if (!codes.includes(n)) codes.push(n);
      } else {
        unresolved.push(k);
      }
    }
    // A ZST row KEYED BY A NUMBER is an option row, and the key is the SA
    // number itself (H 0214 ... ASC): that is how the chassis without an AT
    // dictionary -- every ZCS chassis but E46 -- still name their options.
    // Type-key rows (DE93) and words (GVN, PU97) are not numbers and fall
    // through to the keyword path above.
    for (const r of rows) {
      if (!/^\d+$/.test(r.key)) continue;
      const n = String(parseInt(r.key, 10));
      if (!codes.includes(n)) codes.push(n);
    }
    // The SA numbers straight off the encoding table. Unpadded, the way the
    // AT numbers and the SGET predicates (S261) spell them.
    const bits = sabitsMatches(chassis, keys);
    for (const r of bits) {
      const n = String(parseInt(r.key, 10));
      if (!codes.includes(n)) codes.push(n);
    }
    return {
      codes: codes.sort((a, b) => Number(a) - Number(b)),
      keywords,
      ci,
      unresolved,
      resolved: codes.length > 0,
      rows: rows.length,
      bits: bits.length,
    };
  }

  /**
   * Pull the three keys out of a 20-byte ZCS region. Thin wrapper over
   * coding-zcs so callers get {gm,sa,vn} without knowing the layout.
   * @param {number[]|null|undefined} bytes - At least 20 bytes.
   * @returns {RegionKeys|null} The keys, or null when the region is short,
   *   the layout helper is not loaded, or the parse throws.
   */
  function keysFromRegion(bytes) {
    if (!Zcs || !bytes || bytes.length < ZCS_REGION_BYTES) return null;
    try {
      const r = Zcs.parseZcsRegion(bytes.slice(0, ZCS_REGION_BYTES));
      return { gm: r.gm, sa: r.sa, vn: r.vn, region: r };
    } catch (e) {
      return null;
    }
  }

  const api = {
    maskHolds,
    zstMatches,
    sabitsMatches,
    typeRows,
    chassisFromKeys,
    saCodesFromZcs,
    keysFromRegion,
  };
  Object.assign(VI, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
