/**
 * @file Which control unit to code, and which coding file to use. Published
 * as the `CodingSelect` global.
 *
 * This is NCS Expert's own answer to "the car lists a slot -- which of the
 * several modules that could fill it is actually in front of me?", and it is
 * answered FROM THE VEHICLE ORDER, not by asking the bus.
 *
 * Every SGET row describes one candidate:
 *
 *   SGNAME + CBD   the coding file to decode with   (MRS4_16 + C29 -> MRS4_16.C29)
 *   SGBD           the module to run jobs against   (MRS4)
 *   CABD           the dispatcher                   (A_MRS4)
 *   UMRSG          the logical slot / label         (ABG)
 *   AUFTRAGSAUSDRUCK  a predicate over the car's SA equipment codes
 *
 * Selection = evaluate every row's predicate against the car's own SA codes
 * and keep the ones that hold. A row with no predicate applies to every car.
 *
 * THE ROWS ARE NOT MUTUALLY EXCLUSIVE, and pretending otherwise is the bug to
 * avoid. Measured on the shipped E46 data, over the KMB slot's own referenced
 * codes: 1616 of 4096 code combinations satisfy more than one row, and 4 of
 * 44 realistic cars resolve to BOTH C_KMB46 and KOMBI46R. NCS Expert breaks
 * that tie by row order -- first match wins -- so that is what happens here,
 * and the ambiguity is REPORTED rather than hidden, because a caller about to
 * write should be able to see that the order alone decided it.
 *
 * WHAT THIS DOES NOT DO. It resolves a slot among the candidates SGET lists.
 * A module SGET does not mention is returned unchanged -- there is nothing to
 * choose between. That covers the modules sharing a diagnostic address whose
 * names never appear in SGET at all (bc_v/uhr_bc, msd80/msv80/msv70/mss60,
 * amph70/ampt70); telling them apart needs the group's identification job,
 * which is a different mechanism and deliberately not used here.
 */

/**
 * One SGET row as data/sget.js ships it.
 * @typedef {Object} SgetRow
 * @property {string} [SGBD] - the module to run jobs against.
 * @property {string} [SGNAME] - base name of the coding file.
 * @property {string} [CBD] - coding file extension (coding index).
 * @property {string} [CABD] - the dispatcher name.
 * @property {string} [UMRSG] - the logical slot / label.
 * @property {string} [exprHex] - AUFTRAGSAUSDRUCK bytes as hex, when any.
 */

/**
 * The outcome of resolving one slot against the car's equipment.
 * @typedef {Object} SlotSelection
 * @property {string} sgbd - the chosen module (lowercase).
 * @property {string|null} cabd - its dispatcher.
 * @property {string|null} sgname - coding file base name.
 * @property {string|null} cbd - coding file extension.
 * @property {string|null} file - the coding file NCS Expert would open.
 * @property {string|null} umrsg - the slot.
 * @property {SgetRow} row - the winning row.
 * @property {number} matched - how many rows applied.
 * @property {boolean} ambiguous - more than one row applied naming DIFFERENT sgbds.
 * @property {string[]} alternatives - the other sgbds that also applied.
 */

(function (root) {
  'use strict';

  const Auftrag =
    typeof window !== 'undefined' && window.CodingAuftrag
      ? window.CodingAuftrag
      : typeof require === 'function'
        ? require('./auftrag.js')
        : null;

  /**
   * "2B53..." -> [0x2b, 0x53, ...].
   * @param {string|null|undefined} hex - the predicate as hex.
   * @returns {number[]|null} the bytes, or null when unusable.
   */
  function exprBytes(hex) {
    if (!hex) return null;
    const m = String(hex).match(/../g);
    if (!m) return null;
    const out = m.map((h) => parseInt(h, 16));
    return out.some((b) => Number.isNaN(b)) ? null : out;
  }

  // An absent predicate means "no restriction" -- the row applies to every
  // car, which is the enumerator's own reading. An UNREADABLE predicate is a
  // different thing and must not be treated as a match: silently accepting a
  // row we could not evaluate is how a wrong module gets selected without
  // anything looking wrong.
  /**
   * Does this row apply to a car carrying `codes`?
   * @param {SgetRow|null|undefined} row - the row.
   * @param {EquipmentCodes|null|undefined} codes - the car's equipment codes.
   * @returns {boolean} true when the row applies.
   */
  function rowApplies(row, codes) {
    if (!row) return false;
    if (!row.exprHex) return true;
    const bytes = exprBytes(row.exprHex);
    if (!bytes || !Auftrag) return false;
    try {
      return Auftrag.matchesAuftrag(bytes, codes || []);
    } catch (e) {
      return false;
    }
  }

  /**
   * The SGET rows for a chassis.
   * @param {string} chassisId - chassis id (any case).
   * @returns {SgetRow[]} the rows, or [] when none are loaded.
   */
  function rowsFor(chassisId) {
    const all = (typeof window !== 'undefined' && window.BMW_SGET) || null;
    const ch = all && all[String(chassisId || '').toUpperCase()];
    return (ch && ch.rows) || [];
  }

  // A slot is named by UMRSG. The same logical slot legitimately carries
  // several SGBDs across build variants -- E46's KMB slot is C_KMB46 on early
  // cars and KOMBI46R from the redesign -- which is exactly what selection is
  // for.
  /**
   * Every candidate for a slot, in file order.
   * @param {string} chassisId - chassis id.
   * @param {string} umrsg - the slot name.
   * @returns {SgetRow[]} the rows naming that slot.
   */
  function candidatesForSlot(chassisId, umrsg) {
    const want = String(umrsg || '').toUpperCase();
    return rowsFor(chassisId).filter(
      (r) => String(r.UMRSG || '').toUpperCase() === want
    );
  }

  // TWO NAMESPACES MEET HERE, and they do not line up. Our chassis config
  // names modules the way EDIABAS addresses them -- `kombi46`, `lsz`, `ews`.
  // SGET's SGBD column names them the way the CODING side does -- `c_kmb46`,
  // `c_lsz`, `c_ews3` -- the same namespace SGFAM's CABD column uses. Measured
  // on E46: of 17 configured codeable modules only 2 appear in SGET's SGBD
  // column at all.
  //
  // So a module is looked up by every name a row carries that could be it:
  // the coding name (SGBD), the coding file's base name (SGNAME) and the
  // logical slot (UMRSG). On E46 that lifts the join from 1/11 to 8/11.
  // The rest have no SGET row under any spelling, and are left alone -- which
  // is the correct outcome, not a silent miss: there is nothing to choose
  // between for a module SGET does not describe.
  /**
   * Which slot(s) is this SGBD a candidate for?
   * @param {string} chassisId - chassis id.
   * @param {string} sgbd - a module name in any of the three spellings.
   * @returns {string[]} the slot names (uppercase), in file order.
   */
  function slotsForSgbd(chassisId, sgbd) {
    const want = String(sgbd || '').toLowerCase();
    if (!want) return [];
    const out = [];
    for (const r of rowsFor(chassisId)) {
      const names = [r.SGBD, r.SGNAME, r.UMRSG].map((x) =>
        String(x || '').toLowerCase()
      );
      if (!names.includes(want)) continue;
      const u = String(r.UMRSG || '').toUpperCase();
      if (u && !out.includes(u)) out.push(u);
    }
    return out;
  }

  // A row of the block that names only a variant (older chassis: E31, E32,
  // E34, E36) carries no SGBD. The module to talk to is then the slot's own,
  // from the chassis's family table (its C_SGBD column, kept under `cabd`).
  /**
   * The coding SGBD a row stands for.
   * @param {string} chassisId - chassis id.
   * @param {SgetRow} row - the row.
   * @returns {string} lowercase, '' when neither the row nor the family
   *   table names one.
   */
  function sgbdOfRow(chassisId, row) {
    const own = String(row.SGBD || '').toLowerCase();
    if (own) return own;
    const tables = root.BMW_TABLES || {};
    const ch = tables[String(chassisId || '').toUpperCase()];
    const fam = (ch && ch.sgfam) || {};
    for (const key of [row.UMRSG, row.SGNAME]) {
      const hit = key && fam[String(key).toUpperCase()];
      if (hit && hit.cabd) return String(hit.cabd).toLowerCase();
    }
    return '';
  }

  // WHAT A PREDICATE'S NUMBERS ARE. `S121` is entry 121 of the chassis's own
  // keyword table (SWTASW): KMBI_CI_07 on the E46, whose cluster rows read
  // "PU01 and KMBI_CI_07 and not (KMBI_CI_08 or S54B32)". They are NOT option
  // catalogue numbers -- catalogue 205 is the automatic gearbox, S205 is
  // PDC_CI_02, and the automatic is S37. So a car's equipment has to come to
  // a predicate as keyword ids: the keywords its coding key decodes to, and
  // the keywords the option catalogue (AT) gives for its catalogue numbers.
  /**
   * The car's equipment in the predicates' own numbering.
   * @param {string} chassisId - chassis id.
   * @param {Array<string|number>|null|undefined} saCodes - option catalogue numbers.
   * @param {string[]|null|undefined} [keywords] - equipment keywords already
   *   known (a coding key's, with its `*_CI_nn` stamps).
   * @param {string|null|undefined} [time] - a vehicle order's time criterion
   *   (`#0904` or `0904`): the option catalogue's row for it carries what no
   *   option does -- the order-coding marker and the modules' revision
   *   stamps.
   * @returns {number[]|null} the keyword ids, or null when the chassis ships
   *   no keyword table -- then nothing can be evaluated, which is not the
   *   same as "the car has none of it".
   */
  function aswIds(chassisId, saCodes, keywords, time) {
    const tables = root.BMW_TABLES || {};
    const ch = tables[String(chassisId || '').toUpperCase()];
    const asw = ch && ch.asw;
    if (!asw) return null;
    const ids = new Set();
    const add = (kw) => {
      const id = asw[String(kw || '').toUpperCase()];
      if (id != null) ids.add(id);
    };
    for (const kw of keywords || []) add(kw);
    const byTime = (ch.at && ch.at.time) || {};
    const when = String(time || '').replace(/^#/, '');
    for (const kw of byTime[when] || []) add(kw);
    const bySa = (ch.at && ch.at.sa) || {};
    for (const c of saCodes || []) {
      const n = String(parseInt(String(c).trim(), 10));
      for (const kw of bySa[n] || bySa[String(c).trim()] || []) add(kw);
    }
    return Array.from(ids).sort((x, y) => x - y);
  }

  // `ambiguous` is the honest part. Rows differing only by coding index are
  // not a conflict -- the index picks between them later -- so ambiguity is
  // reported only when the applying rows disagree about WHICH MODULE to talk
  // to, which is the case a caller must be able to see before writing.
  /**
   * Resolve one slot against the car's equipment.
   * @param {string} chassisId - chassis id.
   * @param {string} umrsg - the slot name.
   * @param {EquipmentCodes|null|undefined} codes - the car's equipment codes.
   * @returns {SlotSelection|null} the selection, or null when the slot is
   *   unknown or nothing applies -- "no answer" is a real outcome and must
   *   not collapse into a default.
   */
  function resolveSlot(chassisId, umrsg, codes) {
    const rows = candidatesForSlot(chassisId, umrsg);
    if (!rows.length) return null;
    const hits = rows.filter((r) => rowApplies(r, codes));
    if (!hits.length) return null;
    // NCS Expert: first match wins. The rows arrive in the order the file's
    // three blocks are consulted -- the ones naming a variant AND a module,
    // then a module, then only a variant -- so the first hit is the right one
    // across blocks too.
    const first = hits[0];
    const sgbds = [];
    for (const h of hits) {
      const s = sgbdOfRow(chassisId, h);
      if (s && !sgbds.includes(s)) sgbds.push(s);
    }
    const chosen = sgbdOfRow(chassisId, first);
    // A resolution must name a module to talk to. A row that names none and
    // whose slot the family table does not know either is "no answer".
    if (!chosen) return null;
    return {
      sgbd: chosen,
      cabd: first.CABD || null,
      sgname: first.SGNAME || null,
      cbd: first.CBD || null,
      // the coding file NCS Expert would open for this row
      file: first.SGNAME && first.CBD ? `${first.SGNAME}.${first.CBD}` : null,
      umrsg: first.UMRSG || null,
      row: first,
      matched: hits.length,
      ambiguous: sgbds.length > 1,
      alternatives: sgbds.filter((s) => s !== chosen),
    };
  }

  /**
   * Resolve a module the caller knows by its configured SGBD name.
   * @param {string} chassisId - chassis id.
   * @param {string} sgbd - the configured module name.
   * @param {EquipmentCodes|null|undefined} codes - the car's equipment codes.
   * @returns {SlotSelection|null} the selection, or null when SGET does not
   *   mention it -- the caller then keeps what the config said, because there
   *   is no choice to make. That is the common case: most modules are
   *   unambiguous and never appear as competing rows.
   */
  function resolveModule(chassisId, sgbd, codes) {
    const slots = slotsForSgbd(chassisId, sgbd);
    if (!slots.length) return null;
    for (const slot of slots) {
      const got = resolveSlot(chassisId, slot, codes);
      if (got) return got;
    }
    return null;
  }

  // THE SGBD IS NOT TOUCHED. Selection answers "which coding FILE describes
  // this module on this car" -- it is expressed in the coding namespace
  // (C_LSZA, LSZ.C31), while jobs are run against the diagnostic name the
  // config carries (lsz). Overwriting one with the other sends every read to
  // a module name the engine has never heard of.
  //
  // So the module keeps its identity and gains `select`: which coding file to
  // decode against, and whether row order alone decided it.
  /**
   * Attach each module's selected coding variant.
   * @template {{sgbd: string}} M
   * @param {string} chassisId - chassis id.
   * @param {M[]} mods - the configured modules.
   * @param {EquipmentCodes|null|undefined} codes - the car's equipment as
   *   KEYWORD IDS (see aswIds), not option catalogue numbers.
   * @returns {Array<M & {select?: SlotSelection}>} the modules, each with a
   *   `select` where SGET could decide; the input unchanged when there are no
   *   codes or no SGET rows.
   */
  function applySelection(chassisId, mods, codes) {
    if (!Array.isArray(mods) || !mods.length) return mods || [];
    if (!codes || !codes.length) return mods;
    if (!rowsFor(chassisId).length) return mods;
    return mods.map((m) => {
      const got = resolveModule(chassisId, m.sgbd, codes);
      return got ? { ...m, select: got } : m;
    });
  }

  const api = {
    aswIds,
    rowApplies,
    rowsFor,
    candidatesForSlot,
    slotsForSgbd,
    resolveSlot,
    resolveModule,
    applySelection,
  };

  root.CodingSelect = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
