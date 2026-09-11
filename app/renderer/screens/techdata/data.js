/**
 * @file Workshop reference data: the index, the per-car validity filter, and
 * the lazily fetched document bodies.
 *
 * tools/ista/technical_data_extract.py writes what this reads
 * (data/ista/techdata/). Loaded the way the other extracts are: a local copy
 * first, then the hosted dataset, and never before the tab is opened.
 *
 * THE FILTER IS THE INTERESTING PART. Every document carries a validity rule
 * -- a small AND/OR/NOT tree over "this car has characteristic X" -- and a
 * car is a set of characteristic ids looked up from its VIN type key. So
 * "does this document apply" is one pure evaluation, no guessing from the
 * title. What the extractor could not decode it flags `unsure`, and an
 * unsure document is SHOWN, marked: in a workshop, a document that might not
 * apply is a smaller problem than a torque figure that quietly went missing.
 */

/* exported techDataIndex techDataIndexPresent techDataBody techDataCarKeys
   techDataRuleApplies techDataRuleEval techDataCompare techDataDateTicks
   techDataFilter techDataGroups techDataSearch */

/** Hosted copy, beside the other ISTA extracts. */
const TECHDATA_HF_BASE =
  'https://huggingface.co/datasets/CraigFf/bmweb-etk/resolve/main/ista/techdata/';

/** The characteristic root that names a car's chassis (E46, F10 ...). */
const TECHDATA_CHASSIS_ROOT = '53088651';

/** How many rows a search returns before it stops counting. */
const TECHDATA_SEARCH_CAP = 400;

/** @type {object|null} */
let techDataIndexCache = null;
/** @type {Map<string, object|null>} shard name -> its bodies */
const techDataBodyCache = new Map();
/** @type {object|null} */
let techDataTypeKeys = null;
/** @type {object|null} */
let techDataCharNames = null;

/**
 * One file, local first then the dataset. Null when neither has it.
 * @param {string} rel - the file name (index.json, body/torque-11.json)
 * @returns {Promise<object|null>}
 */
async function techDataFetchJson(rel) {
  const real =
    typeof webRealFetch === 'function'
      ? webRealFetch
      : window.fetch.bind(window);
  const base = typeof WEB_BASE === 'string' ? WEB_BASE : '';
  for (const u of [
    `${base}/data/ista/techdata/${rel}`,
    TECHDATA_HF_BASE + rel,
  ]) {
    try {
      const r = await real(u);
      if (r && r.ok) return await r.json();
    } catch (e) {
      /* try the next source */
    }
  }
  return null;
}

/**
 * The index: every document, its title, group and validity rule.
 * @returns {Promise<object|null>}
 */
async function techDataIndex() {
  if (techDataIndexCache) return techDataIndexCache;
  if (window.__techDataLoading) return window.__techDataLoading;
  window.__techDataLoading = (async () => {
    const idx = await techDataFetchJson('index.json');
    techDataIndexCache = idx && Array.isArray(idx.docs) ? idx : null;
    return techDataIndexCache;
  })();
  return window.__techDataLoading;
}

/**
 * Did this build ship the reference documents?
 * @returns {Promise<boolean>}
 */
async function techDataIndexPresent() {
  const idx = await techDataIndex().catch(() => null);
  return !!(idx && idx.docs && idx.docs.length);
}

/**
 * One document's body, fetching its shard the first time.
 * @param {object} doc - an index entry
 * @returns {Promise<object|null>}
 */
async function techDataBody(doc) {
  if (!doc || !doc.shard) return null;
  if (!techDataBodyCache.has(doc.shard)) {
    techDataBodyCache.set(
      doc.shard,
      await techDataFetchJson(`body/${doc.shard}.json`)
    );
  }
  const shard = techDataBodyCache.get(doc.shard);
  return (shard && shard[String(doc.id)]) || null;
}

/**
 * The characteristic ids that describe one car.
 *
 * A VIN gives the exact build: characters 4-7 are the type key, which the
 * extract maps to every characteristic BMW recorded for it. Without a VIN
 * the best that can be said is the chassis, so the set is every type key of
 * that development code folded together -- broader than the real car, but
 * broad in the honest direction: a saved car with no VIN still sees its
 * chassis's documents rather than none.
 * @param {object|null} car - a GarageCar
 * @param {string} [chassis] - the chassis, when the car has no VIN
 * @returns {Promise<{ids: Set<number>, exact: boolean, typeKey: string|null}>}
 */
async function techDataCarKeys(car, chassis) {
  const out = { ids: new Set(), exact: false, typeKey: null };
  if (!techDataTypeKeys)
    techDataTypeKeys = (await techDataFetchJson('typekeys.json')) || {};
  const vin = String((car && car.vin) || '').toUpperCase();
  // a full 17-character VIN carries the type key at 4-7; a 7-character
  // production number does not, so it is not looked at
  const key = vin.length >= 11 ? vin.slice(3, 7) : '';
  if (key && techDataTypeKeys[key]) {
    for (const vals of Object.values(techDataTypeKeys[key]))
      for (const v of vals) out.ids.add(v);
    out.exact = true;
    out.typeKey = key;
    return out;
  }
  // no VIN: every type key whose development code is this chassis
  const want = String((car && car.chassis) || chassis || '').toUpperCase();
  if (!want) return out;
  if (!techDataCharNames)
    techDataCharNames = (await techDataFetchJson('characteristics.json')) || {};
  const chassisIds = new Set(
    Object.keys(techDataCharNames).filter(
      (id) => String(techDataCharNames[id]).toUpperCase() === want
    )
  );
  if (!chassisIds.size) return out;
  for (const tk of Object.values(techDataTypeKeys)) {
    const codes = tk[TECHDATA_CHASSIS_ROOT] || [];
    if (!codes.some((c) => chassisIds.has(String(c)))) continue;
    for (const vals of Object.values(tk)) for (const v of vals) out.ids.add(v);
  }
  return out;
}

/**
 * Compare two numbers with a rule's operator name.
 * @param {number} left - the car's value
 * @param {string} cmp - eq, ne, gt, ge, lt or le
 * @param {number} right - the rule's value
 * @returns {boolean}
 */
function techDataCompare(left, cmp, right) {
  if (cmp === 'eq') return left === right;
  if (cmp === 'ne') return left !== right;
  if (cmp === 'gt') return left > right;
  if (cmp === 'ge') return left >= right;
  if (cmp === 'lt') return left < right;
  return left <= right;
}

/**
 * The .NET tick count ISTA stores dates in, for a calendar date.
 * @param {number} year - four-digit year
 * @param {number} month - 1 to 12
 * @param {number} [day=1] - day of month
 * @returns {number}
 */
function techDataDateTicks(year, month, day = 1) {
  // days from 0001-01-01 to the date, times ticks per day; UTC keeps the
  // arithmetic free of the local zone, and setUTCFullYear avoids Date.UTC
  // reading a small year as 19xx
  const y1 = new Date(0);
  y1.setUTCFullYear(1, 0, 1);
  y1.setUTCHours(0, 0, 0, 0);
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(0, 0, 0, 0);
  const days = Math.round((d.getTime() - y1.getTime()) / 86400000);
  return days * 864000000000;
}

/**
 * Three-valued rule evaluation: true, false, or null for "not decidable".
 *
 * The leaf kinds are ISTA's own (a characteristic, a production date, an SA
 * code, a country ...). A leaf the caller has no fact for is null, and null
 * propagates the way the tool's engine would if it lacked the fact: NOT null
 * is null, an AND is false on any false else null on any null, an OR is true
 * on any true else null on any null. So a NOT over an unknown leaf never
 * turns a missing fact into an exclusion.
 * @param {object|null|undefined} rule - the decoded rule tree
 * @param {Set<number>} ids - the car's characteristic ids
 * @param {object} [facts] - `built` (production date in ticks, see
 *   techDataDateTicks), `ym` (model year * 100 + month) and, per leaf
 *   kind, a Set of ids the car carries
 * @returns {boolean|null}
 */
function techDataRuleEval(rule, ids, facts) {
  if (!rule) return true;
  const f = facts || {};
  switch (rule.op) {
    case 'eq':
      return ids.has(rule.val);
    case 'and': {
      let out = true;
      for (const k of rule.kids || []) {
        const v = techDataRuleEval(k, ids, f);
        if (v === false) return false;
        if (v === null) out = null;
      }
      return out;
    }
    case 'or': {
      let out = false;
      for (const k of rule.kids || []) {
        const v = techDataRuleEval(k, ids, f);
        if (v === true) return true;
        if (v === null) out = null;
      }
      return out;
    }
    case 'not': {
      const v = techDataRuleEval((rule.kids || [])[0], ids, f);
      return v === null ? null : !v;
    }
    case 'mfd':
      if (f.built == null) return null;
      return techDataCompare(f.built, rule.cmp, rule.ticks);
    case 'date':
      // the tool compares model year * 100 + month against this leaf
      if (f.ym == null) return null;
      return techDataCompare(f.ym, rule.cmp, rule.ym);
    case 'istufex':
      return null;
    default: {
      const have = f[rule.op];
      if (!have || typeof have.has !== 'function') return null;
      return have.has(rule.val);
    }
  }
}

/**
 * Does a validity rule hold for a car?
 *
 * Pure, and total: an absent rule applies to everything (that is what the
 * source means by no rule), and a rule the facts cannot decide applies
 * rather than excluding, for the same reason the extractor keeps undecoded
 * rules. The Python twin is rule_applies in tools/ista/validity_rules.py.
 * @param {object|null|undefined} rule - the decoded rule tree
 * @param {Set<number>} ids - the car's characteristic ids
 * @param {object} [facts] - see techDataRuleEval
 * @returns {boolean}
 */
function techDataRuleApplies(rule, ids, facts) {
  return techDataRuleEval(rule, ids, facts) !== false;
}

/**
 * The documents that apply to a car.
 * @param {object[]} docs - index entries
 * @param {Set<number>|null} ids - the car's characteristic ids, null for all
 * @returns {object[]}
 */
function techDataFilter(docs, ids) {
  if (!ids || !ids.size) return docs.slice();
  return docs.filter((d) => techDataRuleApplies(d.rule, ids));
}

/**
 * The tree: main groups, each with the classes and counts under it.
 *
 * Built from the documents actually in scope, so the counts follow the car
 * filter rather than describing a catalogue the user is not looking at.
 * @param {object[]} docs - the documents in scope
 * @returns {Array<{id: string, name: string, count: number}>}
 */
function techDataGroups(docs) {
  const by = new Map();
  for (const d of docs) {
    const id = String(d.mainGroup || '0');
    if (!by.has(id)) by.set(id, { id, name: d.mainGroupName || '', count: 0 });
    const node = by.get(id);
    node.count++;
    if (!node.name && d.mainGroupName) node.name = d.mainGroupName;
  }
  return [...by.values()].sort((a, b) => {
    const na = Number(a.id);
    const nb = Number(b.id);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return String(a.id).localeCompare(String(b.id));
  });
}

/**
 * Free-text search over the titles and group names in scope.
 *
 * Every term has to appear somewhere in the row, so "torque camshaft" finds
 * the camshaft torque table rather than everything about either. Titles
 * only: the bodies are in shards this has not fetched, and downloading 33 MB
 * to answer a keystroke would cost more than the search is worth.
 * @param {object[]} docs - the documents in scope
 * @param {string} query - what was typed
 * @returns {object[]} the matches, capped
 */
function techDataSearch(docs, query) {
  const terms = String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!terms.length) return [];
  const out = [];
  for (const d of docs) {
    const hay = `${d.title || ''} ${d.subGroupName || ''} ${
      d.mainGroupName || ''
    } ${d.type || ''}`.toLowerCase();
    if (terms.every((t) => hay.includes(t))) out.push(d);
    if (out.length >= TECHDATA_SEARCH_CAP) break;
  }
  return out;
}

if (typeof window !== 'undefined') {
  window.techDataIndexPresent = techDataIndexPresent;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TECHDATA_CHASSIS_ROOT,
    TECHDATA_SEARCH_CAP,
    techDataFetchJson,
    techDataIndex,
    techDataIndexPresent,
    techDataBody,
    techDataCarKeys,
    techDataRuleApplies,
    techDataRuleEval,
    techDataCompare,
    techDataDateTicks,
    techDataFilter,
    techDataGroups,
    techDataSearch,
  };
}
