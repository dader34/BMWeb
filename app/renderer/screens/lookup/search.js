/**
 * @file The search itself: the screen's filter state, query parsing (with the
 * P-code and location-byte forms a term can take), matching index entries,
 * and the ISTA-fleet fallback for 6-digit F/G-series codes. Pure over the
 * loaded data; no DOM.
 */

/* exported lookupState, LOOKUP_MAX, lookupLabels, lookupModuleLabel, lookupParseTerms, lookupSearch */

/**
 * One parsed search term.
 * @typedef {object} LookupTerm
 * @property {string} text - the lower-cased term as typed
 * @property {string|null} alt - a P-code term's BMW hex ("p2563" -> "27c3"), else null
 * @property {string|null} hi - a full 4-hex code's high byte ("0b3f" -> "0b"), for the location fallback
 */

/**
 * A finished search.
 * @typedef {object} LookupSearchResult
 * @property {boolean} useHiByte - the high-byte fallback was in force (the exact code was found nowhere)
 * @property {LookupResultGroup[]} groups - matching rows per module
 * @property {number} total - matching rows across every group
 */

/** The screen's filters, kept across re-renders within a visit. */
const lookupState = { q: '', chassis: '', module: '' };

/** Cap on rendered rows; the count line still reports the true total. */
const LOOKUP_MAX = 400;

/** Cap on synthesised ISTA-fleet rows, so a broad term can't flood. */
const ISTA_META_MAX = 400;

/** Length of a 6-digit F/G-series fleet code. */
const LOOKUP_FLEET_CODE_LEN = 6;

// prettified module labels harvested from the live chassis config, per chassis:
// { chassisId: { indexModuleValue: "Nice ECU Label" } }. Fault files carry only
// a slug ("bms46"); the config's label ("BMS46 for M43") is prettier. Filtering
// still uses the raw index module value.
/** @type {Record<string, Record<string, string>>} */
const lookupLabels = {};

/**
 * The display label of a module: the config's name when harvested, else the
 * raw slug.
 * @param {string} chassis - chassis code
 * @param {string} moduleValue - the index's module slug
 * @returns {string}
 */
function lookupModuleLabel(chassis, moduleValue) {
  const m = lookupLabels[chassis];
  return (m && m[moduleValue]) || moduleValue;
}

/**
 * The searchable text of one fault row: key, English and code, lower-cased.
 * @param {LookupFaultRow} row - the fault
 * @returns {string}
 */
function lookupHaystack([k, en, code]) {
  return (k + ' ' + en + ' ' + (code || '')).toLowerCase();
}

/**
 * The location byte a text-scheme code represents, as 2 hex ("0x0B" -> "0b").
 * null for anything that isn't a single location byte (real 4-hex DTCs), so
 * the high-byte fallback only ever matches text-scheme location entries.
 * @param {string} code - the row's code
 * @returns {string|null}
 */
function lookupCodeLocByte(code) {
  const c = (code || '').replace(/^0x/i, '').toLowerCase();
  return /^[0-9a-f]{1,2}$/.test(c) ? c.padStart(2, '0') : null;
}

/**
 * Parse a search string into terms. GOTCHA: text-scheme ECUs report a 16-bit
 * F_ORT_NR (0B3F) but FORTTEXTE only holds the high-byte location (0B ->
 * "LWS-ID wrong"), so a full 4-hex term records its HIGH BYTE ("0b") for the
 * fallback -- used ONLY when the exact code isn't found, else it floods.
 * @param {string} q - the search box contents
 * @returns {LookupTerm[]}
 */
function lookupParseTerms(q) {
  return q
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => {
      // a P-code term resolves to its BMW hex ("p2563" -> also match "27c3")
      const alt =
        /^p[0-9a-u][0-9a-f]{3}$/i.test(t) && typeof hexForPcode === 'function'
          ? (hexForPcode(t) || '').toLowerCase() || null
          : null;
      const m = (alt || t).match(/^(?:0x)?([0-9a-f]{4})$/i); // a full 4-hex code
      return { text: t, alt, hi: m ? m[1].slice(0, 2).toLowerCase() : null };
    });
}

/**
 * Does a term hit this haystack by its text or its P-code's hex?
 * @param {LookupTerm} t - the term
 * @param {string} hay - a row's searchable text
 * @returns {boolean}
 */
function lookupTermHits(t, hay) {
  return hay.includes(t.text) || !!(t.alt && hay.includes(t.alt));
}

/**
 * The rows of one index entry that pass the chassis / module filters and
 * every term. `useHiByte` is the high-byte fallback, kept off unless the exact
 * code wasn't found anywhere, so a full-DTC search stays precise and only
 * widens when it would otherwise return nothing.
 * @param {LookupIndexEntry} entry - the index entry
 * @param {LookupTerm[]} terms - parsed terms
 * @param {boolean} useHiByte - widen 4-hex terms to their location byte
 * @returns {LookupFaultRow[]|null} matching rows, or null when the entry is filtered out
 */
function lookupMatches(entry, terms, useHiByte) {
  if (lookupState.chassis && entry.chassis !== lookupState.chassis) return null;
  if (lookupState.module && entry.module !== lookupState.module) return null;
  if (!terms.length) return entry.faults;
  return entry.faults.filter((row) => {
    const hay = lookupHaystack(row);
    const loc = lookupCodeLocByte(row[2]);
    return terms.every(
      (t) =>
        lookupTermHits(t, hay) || (useHiByte && t.hi && loc && loc === t.hi)
    ); // fallback: DTC -> location
  });
}

/**
 * Is the exact code present anywhere in the index? If so, skip the high-byte
 * fallback.
 * @param {LookupIndexEntry[]} index - the whole fault index
 * @param {LookupTerm[]} terms - parsed terms
 * @returns {boolean} true when there is nothing to fall back for
 */
function lookupHasExactCodeHit(index, terms) {
  const hexTerms = terms.filter((t) => t.hi);
  if (!hexTerms.length) return true; // no code terms -> nothing to fall back for
  return index.some((e) =>
    e.faults.some((row) => {
      const hay = lookupHaystack(row);
      return terms.every((t) => lookupTermHits(t, hay));
    })
  );
}

/**
 * Search BMW_FAULT_META (the ISTA fleet: hex -> {pcodes, variants}) for codes
 * matching all terms, one group per ISTA sgbd. Skips codes in seenCodes (shown
 * by the curated index).
 * @param {Record<string, { pcodes?: string[], variants?: FaultMetaVariant[] }>} meta - window.BMW_FAULT_META
 * @param {LookupTerm[]} terms - parsed terms
 * @param {Set<string>} seenCodes - upper-cased codes the curated index already covered
 * @returns {LookupResultGroup[]}
 */
function lookupMatchIsta(meta, terms, seenCodes) {
  const bySgbd = new Map(); // sgbd -> rows[[hex, name, hex]]
  let n = 0;
  for (const hex in meta) {
    if (n >= ISTA_META_MAX) break;
    if (hex.length !== LOOKUP_FLEET_CODE_LEN) continue; // 6-digit F/G-series codes only
    if (seenCodes.has(hex)) continue;
    const e = meta[hex];
    const pcodes = (e.pcodes || []).join(' ').toLowerCase();
    const hl = hex.toLowerCase();
    for (const v of e.variants || []) {
      const hay = hl + ' ' + (v.name || '').toLowerCase() + ' ' + pcodes;
      const ok = terms.every(
        (t) => hay.includes(t.text) || (t.alt && hl.includes(t.alt))
      );
      if (!ok) continue;
      if (!bySgbd.has(v.sgbd)) bySgbd.set(v.sgbd, []);
      bySgbd.get(v.sgbd).push([hex, v.name, hex]);
      n++;
      if (n >= ISTA_META_MAX) break;
    }
  }
  return [...bySgbd.entries()].map(([sgbd, rows]) => ({
    chassis: 'ISTA',
    module: sgbd,
    sgbd,
    scheme: 'code',
    rows,
  }));
}

/**
 * Run a search over the index under the current filters: the curated index
 * first, then the ISTA fleet fallback for 6-digit codes it doesn't carry.
 * @param {LookupIndexEntry[]} index - the whole fault index
 * @param {LookupTerm[]} terms - parsed terms
 * @returns {LookupSearchResult}
 */
function lookupSearch(index, terms) {
  // widen a full-DTC search to its high byte ("0B3F" -> "0B") when the exact
  // code isn't found: the low byte is runtime-only and not in the offline
  // tables, so several modules can match and each row's module chip says which
  const useHiByte = !lookupHasExactCodeHit(index, terms);

  const groups = [];
  let total = 0;
  const seenCodes = new Set(); // codes the curated index already covered
  for (const entry of index) {
    const rows = lookupMatches(entry, terms, useHiByte);
    if (!rows || !rows.length) continue;
    total += rows.length;
    rows.forEach((r) => {
      if (r[2]) seenCodes.add(String(r[2]).toUpperCase());
    });
    groups.push({
      chassis: entry.chassis,
      module: entry.module,
      sgbd: entry.sgbd,
      scheme: entry.scheme,
      rows,
    });
  }

  // ISTA fleet fallback, ONLY for 6-digit F/G-series codes the curated
  // E-series index doesn't carry. Skipped under a chassis/module filter (meta
  // has no chassis attribution).
  const meta = (typeof window !== 'undefined' && window.BMW_FAULT_META) || null;
  const wants6 = terms.some((t) => /^[0-9a-f]{6}$/i.test(t.text));
  if (meta && wants6 && !lookupState.chassis && !lookupState.module) {
    for (const g of lookupMatchIsta(meta, terms, seenCodes)) {
      total += g.rows.length;
      groups.push(g);
    }
  }
  return { useHiByte, groups, total };
}
