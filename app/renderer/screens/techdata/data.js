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
  return hfFetchFirst(`ista/techdata/${rel}`);
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
  // THE FOLD IS TWO SETS: what every build of the chassis carries (the ids
  // a rule may decide true) and what any build carries (`may`, which a rule
  // must leave undecided). The union alone decided "engine is M54" true for
  // every E46 and so "not M54" false for every E46.
  let must = null;
  const may = new Set();
  for (const tk of Object.values(techDataTypeKeys)) {
    const codes = tk[TECHDATA_CHASSIS_ROOT] || [];
    if (!codes.some((c) => chassisIds.has(String(c)))) continue;
    const build = new Set();
    for (const vals of Object.values(tk)) for (const v of vals) build.add(v);
    for (const v of build) may.add(v);
    must = must ? new Set([...must].filter((v) => build.has(v))) : build;
  }
  if (!must) return out;
  out.ids = must;
  out.ids.may = may;
  out.may = may;
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
 * The dated facts a validity rule can test, for one car.
 *
 * ONE BUILDER, ONE SHAPE. A rule's DATE leaf carries year*100+month as a
 * number (see techDataRuleEval), so the car's build date is handed over in
 * exactly that shape; the Garage stores it as `prod`, "YYYYMM" or
 * "YYYYMMDD". Two earlier builders disagreed with each other and with the
 * evaluator: one passed "YYYY-MM" (a string, so every DATE comparison was a
 * decided false and the documents it guarded vanished), the other read
 * fields the record never carries (so no date was ever known). A car whose
 * date nobody knows gets no `ym`, and the evaluator keeps the document.
 * @param {object|null|undefined} car - a GarageCar
 * @returns {{ym?: number}} facts for techDataRuleApplies
 */
function techDataCarFacts(car) {
  const facts = {};
  const prod = String((car && car.prod) || '').trim();
  if (/^\d{6}/.test(prod)) {
    const year = Number(prod.slice(0, 4));
    const month = Number(prod.slice(4, 6));
    if (month >= 1 && month <= 12) facts.ym = year * 100 + month;
  }
  // THE ORDER'S OPTION CODES DECIDE THE SA LEAVES. A SALAPA leaf names an
  // XEP_SALAPAS id and the car's order names a code (403, 2VB); the shipped
  // bridge turns one into the other. A car whose codes nobody has read
  // leaves those leaves undecided, which keeps the document -- the same
  // posture as an unknown build date.
  const sa = techDataSalapaIds(car && car.sa);
  if (sa) facts.salapa = sa;
  return facts;
}

/** @type {Object<string, number[]>|null} SA code -> XEP_SALAPAS ids */
let techDataSalapas = null;

/**
 * The XEP_SALAPAS ids for a car's option codes, once the bridge is loaded.
 * @param {string[]|null|undefined} codes - the order's SA codes
 * @returns {Set<number>|null} the ids, or null when there are no codes or
 *   the bridge has not loaded yet
 */
function techDataSalapaIds(codes) {
  if (!techDataSalapas || !Array.isArray(codes) || !codes.length) return null;
  const out = new Set();
  for (const raw of codes) {
    const code = String(raw || '')
      .trim()
      .toUpperCase();
    if (!code) continue;
    // the order writes an SA as its bare number ("403"); a coding key's
    // catalogue form may carry the S prefix ("S403A"), which the table does
    // not
    const forms = [code];
    const m = /^S(\w{3})[A-Z]?$/.exec(code);
    if (m) forms.push(m[1]);
    for (const f of forms)
      for (const id of techDataSalapas[f] || []) out.add(id);
  }
  return out;
}

/**
 * The car's facts with the SA bridge loaded first.
 *
 * The bridge is one small file that every gate needs before it can decide
 * an option leaf, so it is fetched once here and techDataCarFacts stays
 * synchronous for callers that already hold it.
 * @param {object|null|undefined} car - a GarageCar
 * @returns {Promise<object>} facts for techDataRuleApplies
 */
async function techDataCarFactsAsync(car) {
  if (techDataSalapas === null && car && Array.isArray(car.sa) && car.sa.length)
    techDataSalapas = (await techDataFetchJson('salapas.json')) || {};
  return techDataCarFacts(car);
}

/**
 * One tree for a document reached through gated tree nodes.
 *
 * The twin of compose_rule in validity_rules.py: the document applies when
 * its own rule holds AND some path of ancestors down to it holds, so own
 * AND (OR over paths of AND over the path). A path with no gated node
 * reaches the document unconditionally.
 * @param {object|null} own - the document's own tree
 * @param {Array<Array<object|null>>} paths - the ancestor trees per path
 * @returns {object|null} the composed tree, or null for "no rule"
 */
function techDataComposeRule(own, paths) {
  let ors = [];
  for (const path of paths || []) {
    const kids = (path || []).filter(Boolean);
    if (!kids.length) {
      ors = null;
      break;
    }
    ors.push(kids.length === 1 ? kids[0] : { op: 'and', kids });
  }
  const kids = [];
  if (own) kids.push(own);
  if (ors && ors.length)
    kids.push(ors.length === 1 ? ors[0] : { op: 'or', kids: ors });
  if (!kids.length) return null;
  return kids.length === 1 ? kids[0] : { op: 'and', kids };
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
      // A CHARACTERISTIC THE CALLER KNOWS NOTHING ABOUT IS UNDECIDED. A car
      // identified by name (chassis, engine, body) carries facts for those
      // roots only; a leaf about its steering or sales designation stays
      // open rather than reading false because the id is absent from a set
      // that never held that root. Without `roots`, the ids are the whole
      // build (a type key's) and every leaf is decided.
      if (f.roots && !f.roots.has(rule.root)) return null;
      if (ids.has(rule.val)) return true;
      // A FOLD OF MANY BUILDS IS NOT ONE CAR. When the ids stand for every
      // build of a chassis (a Garage car without a VIN), `may` carries what
      // any build has: a leaf in it is undecided, not false, so NOT over it
      // cannot hide a document from the builds it is for.
      const may = f.may || ids.may;
      if (may && may.has(rule.val)) return null;
      return false;
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
 * @param {object} [facts] - the car's dated facts (techDataCarFacts); a
 *   rule's date clause is undecided without them and the document is kept
 * @returns {object[]}
 */
function techDataFilter(docs, ids, facts) {
  if (!ids || !ids.size) return docs.slice();
  return docs.filter((d) => techDataRuleApplies(d.rule, ids, facts || {}));
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
    techDataCarFacts,
    techDataCarFactsAsync,
    techDataSalapaIds,
    techDataComposeRule,
    techDataRuleApplies,
    techDataRuleEval,
    techDataCompare,
    techDataDateTicks,
    techDataFilter,
    techDataGroups,
    techDataSearch,
  };
}
