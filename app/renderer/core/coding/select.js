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
  // a predicate as keyword ids, and it gets there the way the factory tool
  // gets it (read out of NCSEXPER.exe, 2026-10-26):
  //
  //   vehicle order (FA) -> the AT table, row by row      (AT_PROC.C)
  //   coding key (ZCS)   -> the ZST table, row by row     (ZST_PROC.C)
  //   a module's coding file -> its SGVT row's keywords  (SGV_PROC.C)

  /**
   * A table's keyword names as ids, unknown names left out.
   * @param {object} ch - the chassis's tables.
   * @param {Iterable<string>} names - keyword names.
   * @param {Set<number>} into - where the ids go.
   */
  function addNames(ch, names, into) {
    const asw = (ch && ch.asw) || {};
    for (const kw of names || []) {
      const id = asw[String(kw || '').toUpperCase()];
      if (id != null) into.add(id);
    }
  }

  /**
   * The factory's date column of an AT row (checkDateWithZeitkriterium):
   * `V0302` holds for a car built before 03/02, `N0302` from 03/02 on. The
   * year is compared as its two characters, before the month -- so, as in
   * the factory tool, a car of 1999 ("99") counts as built after 2002.
   * @param {string} date - `V` or `N` and MMYY.
   * @param {string} time - the car's MMYY.
   * @returns {boolean}
   */
  function dateHolds(date, time) {
    if (!/^\d{4}$/.test(time || '')) return false;
    const rm = date.slice(1, 3);
    const ry = date.slice(3, 5);
    const cm = time.slice(0, 2);
    const cy = time.slice(2, 4);
    const before = cy < ry || (cy === ry && cm < rm);
    return date[0].toUpperCase() === 'V' ? before : !before;
  }

  /**
   * An AT row's order-code condition (`185`, `205+(EU31,EV91)`): each code
   * holds when the order carries it (`?` in the condition matches any
   * character), `+` is and, `,` or, `!` not, NOT before AND before OR.
   * @param {string} cond - the condition, without its `=`.
   * @param {Set<string>} codes - the order's codes.
   * @returns {boolean}
   */
  function condHolds(cond, codes) {
    const toks =
      String(cond)
        .toUpperCase()
        .match(/[!+,()]|[^!+,()&]+/g) || [];
    let i = 0;
    const has = (pat) => {
      for (const c of codes) {
        if (c.length !== pat.length) continue;
        let ok = true;
        for (let k = 0; k < pat.length && ok; k++)
          ok = pat[k] === '?' || pat[k] === c[k];
        if (ok) return true;
      }
      return false;
    };
    const factor = () => {
      if (toks[i] === '!') {
        i++;
        return !factor();
      }
      if (toks[i] === '(') {
        i++;
        const v = or();
        if (toks[i++] !== ')') throw new Error(`AT condition ${cond}`);
        return v;
      }
      const t = toks[i++];
      if (!t || /[!+,()]/.test(t)) throw new Error(`AT condition ${cond}`);
      return has(t);
    };
    const and = () => {
      let v = factor();
      while (toks[i] === '+') {
        i++;
        v = factor() && v;
      }
      return v;
    };
    const or = () => {
      let v = and();
      while (toks[i] === ',') {
        i++;
        v = and() || v;
      }
      return v;
    };
    const v = or();
    if (i !== toks.length) throw new Error(`AT condition ${cond}`);
    return v;
  }

  /**
   * The keywords a vehicle order gives, through the chassis's AT table as
   * the factory tool walks it (GetAtFile): a `Z`/`A` row holds for the car
   * whose time criterion it names; a `W`, `E`, `H` or `K` row when its code
   * is one of the order's codes -- the type key (`*`), options (`$`), HO
   * words (`+`) and E words (`-`), compared as written -- and then its date
   * and its condition hold.
   * @param {string} chassisId - chassis id.
   * @param {{codes: string[], time?: string|null}} order - the order's codes
   *   (no markers) and its time criterion (`0904` or `#0904`).
   * @returns {{keywords: string[], errors: string[]}|null} null when the
   *   chassis ships no AT rows.
   */
  function atKeywords(chassisId, order) {
    const tables = root.BMW_TABLES || {};
    const ch = tables[String(chassisId || '').toUpperCase()];
    const rows = ch && ch.at && ch.at.rows;
    if (!rows) return null;
    const codes = new Set(
      (order.codes || []).map((c) => String(c).trim().toUpperCase())
    );
    const time = String(order.time || '').replace(/^#/, '');
    const keywords = [];
    const errors = [];
    for (const r of rows) {
      let holds;
      if (r.k === 'Z' || r.k === 'A') holds = r.code === time;
      else {
        holds = codes.has(r.code);
        if (holds && r.date) {
          if (!time) {
            errors.push(
              `the order has no time criterion, and AT row ${r.k} ${r.code} ${r.date} needs one`
            );
            holds = false;
          } else holds = dateHolds(r.date, time);
        }
        if (holds && r.cond)
          try {
            holds = condHolds(r.cond, codes);
          } catch (e) {
            errors.push(String(e.message || e));
            holds = false;
          }
      }
      if (!holds) continue;
      for (const kw of r.kw) if (!keywords.includes(kw)) keywords.push(kw);
    }
    return { keywords, errors };
  }

  /**
   * Hex digits of a key, upper case.
   * @param {unknown} s - the key.
   * @returns {string}
   */
  function hexOf(s) {
    return String(s == null ? '' : s)
      .replace(/[^0-9A-Fa-f]/g, '')
      .toUpperCase();
  }

  /**
   * Does every bit of the row's field sit in the car's (an all-zero field
   * holds for every car)?
   * @param {string} car - the car's key, hex.
   * @param {string} row - the row's field, hex.
   * @returns {boolean}
   */
  function bitsHold(car, row) {
    for (let i = 0; i < row.length; i++) {
      const m = parseInt(row[i], 16);
      if (!m) continue;
      const k = parseInt(car[i] || '0', 16);
      if ((k & m) !== m) return false;
    }
    return true;
  }

  /**
   * The GM field as the factory tool tests it (ZST_PROC.C): it is no mask.
   * Characters 1-4 are a value that must equal the car's (0000 = any), 5-6
   * the same (00 = any), 7 a mask, 8 a value again (0 = any).
   * @param {string} car - the car's GM, 8 hex digits.
   * @param {string} row - the row's GM.
   * @returns {boolean}
   */
  function gmHolds(car, row) {
    const c = car.padEnd(8, '0');
    const r = row.padEnd(8, '0');
    const same = (a, b) =>
      /^0+$/.test(r.slice(a, b)) || r.slice(a, b) === c.slice(a, b);
    const m = parseInt(r[6], 16);
    return (
      same(0, 4) && same(4, 6) && (parseInt(c[6], 16) & m) === m && same(7, 8)
    );
  }

  /**
   * The keywords a coding key gives, through the chassis's ZST table as the
   * factory tool matches it: every row whose SA and VN bits the car's keys
   * carry and whose GM fits (gmHolds) -- an all-zero row holds for every
   * car -- with all its keywords, the modules' `*_CI_nn` stamps included.
   * @param {string} chassisId - chassis id.
   * @param {{gm?: string, sa?: string, vn?: string}} keys - the car's keys.
   * @returns {string[]|null} null when the chassis ships no ZST.
   */
  function zstKeywords(chassisId, keys) {
    const tables = root.BMW_TABLES || {};
    const ch = tables[String(chassisId || '').toUpperCase()];
    const rows = ch && ch.zst;
    if (!rows) return null;
    const gm = hexOf(keys && keys.gm);
    const sa = hexOf(keys && keys.sa);
    const vn = hexOf(keys && keys.vn);
    const out = [];
    for (const r of rows) {
      if (!gmHolds(gm, r.gm) || !bitsHold(sa, r.sa) || !bitsHold(vn, r.vn))
        continue;
      const names =
        r.names ||
        r.keywords.concat(
          Object.entries(r.ci || {}).map(
            ([sg, n]) => `${sg}_CI_${String(n).padStart(2, '0')}`
          )
        );
      for (const n of names) if (!out.includes(n)) out.push(n);
    }
    return out;
  }

  /**
   * A module's row of the chassis's SGVT (version table), as the factory
   * tool reads it before coding the module: the row of its family and
   * coding file must have a predicate that holds for the car -- if not, the
   * coding file does not fit the order (error 0x11A0) -- and its keywords
   * join the car's.
   * @param {string} chassisId - chassis id.
   * @param {string} family - the module's family (SGFAM slot, `KMB`).
   * @param {string} cbd - its coding file's extension (`C08`).
   * @param {number[]} ids - the car's keyword ids so far.
   * @returns {{found: boolean, holds: boolean, add: number[]}}
   */
  function sgvtRow(chassisId, family, cbd, ids) {
    const tables = root.BMW_TABLES || {};
    const ch = tables[String(chassisId || '').toUpperCase()];
    const fam = String(family || '').toUpperCase();
    const c = String(cbd || '').toUpperCase();
    const row = ((ch && ch.sgvt) || []).find(
      (r) => r.fam === fam && r.cbd === c
    );
    if (!row) return { found: false, holds: true, add: [] };
    const holds = rowApplies(row, ids);
    return { found: true, holds, add: holds ? row.asw.slice() : [] };
  }

  /**
   * The car's equipment in the predicates' own numbering.
   * @param {string} chassisId - chassis id.
   * @param {Array<string|number>|null|undefined} orderCodes - the vehicle
   *   order's codes, without their markers (type key, options, HO and E
   *   words), compared as written.
   * @param {string[]|null|undefined} [keywords] - equipment keywords already
   *   known (a coding key's, see zstKeywords).
   * @param {string|null|undefined} [time] - the order's time criterion
   *   (`#0904` or `0904`).
   * @returns {number[]|null} the keyword ids, or null when the chassis ships
   *   no keyword table -- then nothing can be evaluated, which is not the
   *   same as "the car has none of it".
   */
  function aswIds(chassisId, orderCodes, keywords, time) {
    const tables = root.BMW_TABLES || {};
    const ch = tables[String(chassisId || '').toUpperCase()];
    if (!ch || !ch.asw) return null;
    const ids = new Set();
    addNames(ch, keywords, ids);
    if ((orderCodes && orderCodes.length) || time) {
      const at = atKeywords(chassisId, { codes: orderCodes || [], time });
      if (at) addNames(ch, at.keywords, ids);
    }
    return Array.from(ids).sort((x, y) => x - y);
  }

  /**
   * The vehicle order's codes the factory tool matches the AT against: the
   * type key (`*`), options (`$`), HO words (`+`) and E words (`-`), each
   * without its marker. The paint (`%`), upholstery (`&`) and build numbers
   * (`|`) are not among them.
   * @param {object|null} fa - a parsed order (VehicleIdentity.parseFa).
   * @returns {string[]}
   */
  function orderCodes(fa) {
    if (!fa) return [];
    return [fa.typ, ...(fa.sa || []), ...(fa.howort || []), ...(fa.ewort || [])]
      .filter(Boolean)
      .map((c) => String(c).toUpperCase());
  }

  /**
   * The car's equipment from what is known of it: its vehicle order when
   * there is one, else its coding key -- as keyword names, ids, and what
   * went wrong on the way.
   * @param {string} chassisId - chassis id.
   * @param {{fa?: string|object|null, zcs?: object|null,
   *   keywords?: string[]}} car - the order (text or parsed) and/or the
   *   coding keys; `keywords` are equipment names given by hand, which the
   *   factory tool takes too (its keyword entry), added to either.
   * @returns {{ids: number[]|null, keywords: string[], source: string|null,
   *   time: string|null, errors: string[]}}
   */
  function carEquipment(chassisId, car) {
    const VI = root.VehicleIdentity;
    let fa = car && car.fa;
    if (typeof fa === 'string')
      fa = fa && VI && VI.parseFa ? VI.parseFa(fa) : null;
    const tables = root.BMW_TABLES || {};
    const ch = tables[String(chassisId || '').toUpperCase()];
    const out = {
      ids: null,
      keywords: [],
      source: null,
      time: null,
      errors: [],
    };
    if (!ch || !ch.asw) return out;
    if (fa) {
      out.source = 'FA';
      out.time = fa.date ? String(fa.date).replace(/^#/, '') : null;
      const at = atKeywords(chassisId, {
        codes: orderCodes(fa),
        time: out.time,
      });
      if (at) {
        out.keywords = at.keywords;
        out.errors.push(...at.errors);
      }
    } else if (car && car.zcs) {
      out.source = 'ZCS';
      out.keywords = zstKeywords(chassisId, car.zcs) || [];
    } else if (car && car.keywords && car.keywords.length)
      out.source = 'keywords';
    else return out;
    for (const kw of (car && car.keywords) || [])
      if (!out.keywords.includes(kw)) out.keywords.push(kw);
    const ids = new Set();
    addNames(ch, out.keywords, ids);
    out.ids = Array.from(ids).sort((x, y) => x - y);
    return out;
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
    atKeywords,
    zstKeywords,
    sgvtRow,
    orderCodes,
    carEquipment,
    gmHolds,
    dateHolds,
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
