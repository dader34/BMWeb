// coding-select: which control unit to code, and which coding file to use.
//
// This is NCS Expert's own answer to "the car lists a slot -- which of the
// several modules that could fill it is actually in front of me?", and it is
// answered FROM THE VEHICLE ORDER, not by asking the bus.
//
// Every SGET row describes one candidate:
//
//   SGNAME + CBD   the coding file to decode with   (MRS4_16 + C29 -> MRS4_16.C29)
//   SGBD           the module to run jobs against   (MRS4)
//   CABD           the dispatcher                   (A_MRS4)
//   UMRSG          the logical slot / label         (ABG)
//   AUFTRAGSAUSDRUCK  a predicate over the car's SA equipment codes
//
// Selection = evaluate every row's predicate against the car's own SA codes
// and keep the ones that hold. A row with no predicate applies to every car.
//
// THE ROWS ARE NOT MUTUALLY EXCLUSIVE, and pretending otherwise is the bug to
// avoid. Measured on the shipped E46 data, over the KMB slot's own referenced
// codes: 1616 of 4096 code combinations satisfy more than one row, and 4 of
// 44 realistic cars resolve to BOTH C_KMB46 and KOMBI46R. NCS Expert breaks
// that tie by row order -- first match wins -- so that is what happens here,
// and the ambiguity is REPORTED rather than hidden, because a caller about to
// write should be able to see that the order alone decided it.
//
// WHAT THIS DOES NOT DO. It resolves a slot among the candidates SGET lists.
// A module SGET does not mention is returned unchanged -- there is nothing to
// choose between. That covers the modules sharing a diagnostic address whose
// names never appear in SGET at all (bc_v/uhr_bc, msd80/msv80/msv70/mss60,
// amph70/ampt70); telling them apart needs the group's identification job,
// which is a different mechanism and deliberately not used here.

(function (root) {
  'use strict';

  const Auftrag =
    typeof window !== 'undefined' && window.CodingAuftrag
      ? window.CodingAuftrag
      : typeof require === 'function'
        ? require('./coding-auftrag.js')
        : null;

  // "2B53..." -> [0x2b, 0x53, ...]; null when unusable.
  function exprBytes(hex) {
    if (!hex) return null;
    const m = String(hex).match(/../g);
    if (!m) return null;
    const out = m.map((h) => parseInt(h, 16));
    return out.some((b) => Number.isNaN(b)) ? null : out;
  }

  // Does this row apply to a car carrying `codes`?
  //
  // An absent predicate means "no restriction" -- the row applies to every
  // car, which is the enumerator's own reading. An UNREADABLE predicate is a
  // different thing and must not be treated as a match: silently accepting a
  // row we could not evaluate is how a wrong module gets selected without
  // anything looking wrong.
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

  // The SGET rows for a chassis, or [].
  function rowsFor(chassisId) {
    const all = (typeof window !== 'undefined' && window.BMW_SGET) || null;
    const ch = all && all[String(chassisId || '').toUpperCase()];
    return (ch && ch.rows) || [];
  }

  // Every candidate for a slot, in file order.
  //
  // A slot is named by UMRSG. The same logical slot legitimately carries
  // several SGBDs across build variants -- E46's KMB slot is C_KMB46 on early
  // cars and KOMBI46R from the redesign -- which is exactly what selection is
  // for.
  function candidatesForSlot(chassisId, umrsg) {
    const want = String(umrsg || '').toUpperCase();
    return rowsFor(chassisId).filter(
      (r) => String(r.UMRSG || '').toUpperCase() === want
    );
  }

  // Which slot(s) is this SGBD a candidate for?
  //
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

  // Resolve one slot against the car's equipment.
  //
  // Returns null when the slot is unknown or nothing applies -- "no answer" is
  // a real outcome and must not collapse into a default. Otherwise:
  //
  //   { sgbd, cabd, sgname, cbd, file, umrsg, row,
  //     matched,     how many rows applied
  //     ambiguous,   more than one row applied naming DIFFERENT sgbds
  //     alternatives the other sgbds that also applied, if any }
  //
  // `ambiguous` is the honest part. Rows differing only by coding index are
  // not a conflict -- the index picks between them later -- so ambiguity is
  // reported only when the applying rows disagree about WHICH MODULE to talk
  // to, which is the case a caller must be able to see before writing.
  function resolveSlot(chassisId, umrsg, codes) {
    const rows = candidatesForSlot(chassisId, umrsg);
    if (!rows.length) return null;
    const hits = rows.filter((r) => rowApplies(r, codes));
    if (!hits.length) return null;
    const first = hits[0]; // NCS Expert: first match wins
    const sgbds = [];
    for (const h of hits) {
      const s = String(h.SGBD || '').toLowerCase();
      if (s && !sgbds.includes(s)) sgbds.push(s);
    }
    const chosen = String(first.SGBD || '').toLowerCase();
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

  // Resolve a module the caller knows by its configured SGBD name.
  //
  // Returns null when SGET does not mention it -- the caller then keeps what
  // the config said, because there is no choice to make. That is the common
  // case: most modules are unambiguous and never appear as competing rows.
  function resolveModule(chassisId, sgbd, codes) {
    const slots = slotsForSgbd(chassisId, sgbd);
    if (!slots.length) return null;
    for (const slot of slots) {
      const got = resolveSlot(chassisId, slot, codes);
      if (got) return got;
    }
    return null;
  }

  // Attach each module's selected coding variant.
  //
  // THE SGBD IS NOT TOUCHED. Selection answers "which coding FILE describes
  // this module on this car" -- it is expressed in the coding namespace
  // (C_LSZA, LSZ.C31), while jobs are run against the diagnostic name the
  // config carries (lsz). Overwriting one with the other sends every read to
  // a module name the engine has never heard of.
  //
  // So the module keeps its identity and gains `select`: which coding file to
  // decode against, and whether row order alone decided it.
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
