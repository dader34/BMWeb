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
 * @returns {{ym?: number, built?: number}} facts for techDataRuleApplies
 */
function techDataCarFacts(car) {
  const facts = {};
  const prod = String((car && car.prod) || '').trim();
  if (/^\d{6}/.test(prod)) {
    const year = Number(prod.slice(0, 4));
    const month = Number(prod.slice(4, 6));
    if (month >= 1 && month <= 12) {
      facts.ym = year * 100 + month;
      // the production-date leaf compares .NET ticks; the tool takes the
      // exact date when it has one and the model month at day 1 otherwise
      const day = /^\d{8}/.test(prod) ? Number(prod.slice(6, 8)) : 1;
      facts.built = techDataDateTicks(
        year,
        month,
        day >= 1 && day <= 31 ? day : 1
      );
    }
  }
  return facts;
}

/** @type {object|null} the tables the vehicle leaves consult (rulefacts.json) */
let techDataRuleFacts = null;

/** The identification level at which the tool has read the car's modules. */
const TECHDATA_LEVEL_READOUT = 5;

/** The characteristic root that names the product type (P car, M motorcycle). */
const TECHDATA_PRODART_ROOT = '53073547';

/**
 * The tables the vehicle leaves consult, fetched once.
 * @returns {Promise<object>}
 */
async function techDataRuleFactsLoad() {
  if (techDataRuleFacts === null)
    techDataRuleFacts = (await techDataFetchJson('rulefacts.json')) || {};
  return techDataRuleFacts;
}

/**
 * The workshop's country, the way the tool reads its dealer data.
 *
 * A COUNTRY leaf compares the DEALER's outlet country, never the car's, so
 * it is a setting here; unset, the browser's region stands in for it.
 * @returns {string} a two-letter code, or ''
 */
function techDataCountry() {
  let code = '';
  try {
    if (typeof Settings === 'object' && Settings && Settings.get)
      code = String(Settings.get('istaCountry', '') || '');
  } catch {
    code = '';
  }
  if (!code && typeof navigator !== 'undefined' && navigator.language) {
    const m = /[-_]([A-Za-z]{2})$/.exec(String(navigator.language));
    if (m) code = m[1];
  }
  return code.toUpperCase();
}

/**
 * The modules the car has answered as, from the last read.
 *
 * The ISTA shell's slot loader knows the bus map, so it is asked first;
 * without it the Garage's stored scans say which variants answered and
 * through which group.
 * @param {object|null} car - a GarageCar
 * @param {string} [chassis] - the development code
 * @returns {Promise<{ecus: Set<string>, groups: Set<string>, titles: Set<string>}|null>}
 */
async function techDataReadModules(car, chassis) {
  const ecus = new Set();
  const groups = new Set();
  const titles = new Set();
  /** @type {Object<string, boolean|null>} the identification's feature verdicts */
  const ffm = {};
  const code = String((car && car.chassis) || chassis || '').toUpperCase();
  // the feature verdicts ride on the identification scan whichever way the
  // modules themselves are read
  if (car && car.id && typeof garageScans === 'function')
    for (const scan of garageScans(car.id) || []) {
      const r = scan && scan.report;
      if (r && r.kind === 'ident' && r.ffm && typeof r.ffm === 'object')
        for (const [k, v] of Object.entries(r.ffm))
          if (!Object.prototype.hasOwnProperty.call(ffm, k)) ffm[k] = v;
    }
  if (typeof istaLoadSlots === 'function' && code) {
    let slots = null;
    try {
      slots = await istaLoadSlots(code, car);
    } catch {
      slots = null;
    }
    for (const s of slots || []) {
      if (!s || !s.sgbd) continue;
      ecus.add(String(s.sgbd).toLowerCase());
      if (s.group) groups.add(String(s.group).toLowerCase());
      if (s.box && s.box.name) titles.add(String(s.box.name).toUpperCase());
    }
  } else if (car && car.id && typeof garageScans === 'function') {
    for (const scan of garageScans(car.id) || [])
      for (const m of (scan && scan.report && scan.report.modules) || []) {
        if (!m || !m.sgbd) continue;
        ecus.add(String(m.sgbd).toLowerCase());
        if (m.via) groups.add(String(m.via).toLowerCase());
      }
  }
  return ecus.size ? { ecus, groups, titles, ffm } : null;
}

/**
 * The car, described the way the tool's identification describes a
 * vehicle to its rule engine.
 *
 * THE FACTS SAY HOW FAR THE CAR IS IDENTIFIED, and the leaves answer
 * accordingly (techDataVehicleLeaf): a type key alone is level 1, a VIN
 * level 3, a car whose modules have been read level 5. The build date, the
 * order's codes the equipment page kept, the product type from the type
 * key, the workshop's country and today's date travel with it.
 * @param {object|null|undefined} car - a GarageCar
 * @param {string} [chassis] - the development code, when the car has none
 * @returns {Promise<object>} facts for techDataRuleApplies
 */
async function techDataVehicleFacts(car, chassis) {
  const facts = techDataCarFacts(car);
  facts.aux = await techDataRuleFactsLoad();
  facts.today = new Date().toISOString().slice(0, 10);
  const vin = String((car && car.vin) || '').toUpperCase();
  facts.level = vin.length === 17 ? 3 : 1;
  const sa = car && Array.isArray(car.sa) ? car.sa : null;
  if (sa && sa.length) {
    facts.fa = true;
    facts.sa = new Set(
      sa.map((c) =>
        String(c || '')
          .trim()
          .toUpperCase()
      )
    );
  }
  facts.prodart = await techDataProdart(car, chassis);
  const read = await techDataReadModules(car, chassis);
  if (read) {
    facts.level = TECHDATA_LEVEL_READOUT;
    facts.ecus = read.ecus;
    facts.groups = read.groups;
    facts.titles = read.titles;
    facts.ffm = read.ffm || {};
  }
  facts.ilevel = String((car && car.ilevel) || '');
  facts.ilevelWerk = String((car && car.ilevelWerk) || '');
  facts.country = techDataCountry();
  return facts;
}

/**
 * The car's product type, P or M, from its type key's characteristics.
 * @param {object|null|undefined} car - a GarageCar
 * @param {string} [chassis] - the development code
 * @returns {Promise<string>} 'P' or 'M'
 */
async function techDataProdart(car, chassis) {
  const keys = await techDataCarKeys(car, chassis);
  if (!techDataCharNames)
    techDataCharNames = (await techDataFetchJson('characteristics.json')) || {};
  const may = (keys && (keys.may || keys.ids)) || new Set();
  const names = new Set();
  for (const tk of Object.values(techDataTypeKeys || {}))
    for (const v of tk[TECHDATA_PRODART_ROOT] || [])
      if (may.has(v)) names.add(String(techDataCharNames[String(v)] || ''));
  if (names.size === 1) return [...names][0] === 'M' ? 'M' : 'P';
  // no type key: a motorcycle chassis is a K number
  const code = String((car && car.chassis) || chassis || '').toUpperCase();
  return /^K\d/.test(code) ? 'M' : 'P';
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
    case 'eq': {
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
    }
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
    default:
      // ONE VEHICLE ANSWERS THE TOOL'S WAY. With an identification level in
      // the facts the leaf is decided exactly as the tool's own evaluator
      // decides it, missing data included; without one (a set of builds at
      // extract time, or a caller with no car) a leaf the facts cannot
      // decide is undecided.
      if (f.level != null) return techDataVehicleLeaf(rule, ids, f);
      return techDataOpenLeaf(rule, f);
  }
}

/**
 * A leaf with no vehicle behind it: decided only when the caller supplied
 * that kind of fact, undecided otherwise.
 * @param {object} rule - the leaf
 * @param {object} f - the facts
 * @returns {boolean|null}
 */
function techDataOpenLeaf(rule, f) {
  switch (rule.op) {
    case 'mfd':
      if (f.built == null) return null;
      return techDataCompare(f.built, rule.cmp, rule.ticks);
    case 'date':
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
 * One leaf, answered the way ISTA's rule engine answers it for a vehicle.
 *
 * READ FROM THE TOOL, NOT GUESSED: RheingoldCoreFramework 4.15.16,
 * RuleHandling.*Expression.Evaluate(Vehicle, IFFMDynamicResolver), from
 * the decompiled assembly. The tool is strictly boolean, and a missing
 * fact has a definite answer per leaf kind -- an unread order makes an SA
 * leaf true, a missing model year makes a date leaf false -- and those
 * answers are reproduced here, not softened. The twin is vehicle_leaf in
 * tools/ista/validity_rules.py.
 * @param {object} rule - the leaf
 * @param {Set<number>} ids - the car's characteristic ids
 * @param {object} f - techDataVehicleFacts output
 * @returns {boolean}
 */
function techDataVehicleLeaf(rule, ids, f) {
  const aux = f.aux || {};
  const key = String(rule.val);
  const level = Number(f.level) || 0;
  switch (rule.op) {
    case 'date':
      // DateExpression: no model year and month -> false
      return f.ym == null ? false : techDataCompare(f.ym, rule.cmp, rule.ym);
    case 'mfd':
      // ManufactoringDateExpression: the production date, else the model
      // month at day 1 (both are `built` here), else false
      return f.built == null
        ? false
        : techDataCompare(f.built, rule.cmp, rule.ticks);
    case 'salapa': {
      // SaLaPaExpression: unknown id or the other product type -> false; no
      // order read, or not yet a vehicle readout -> true; else hasSA
      const row = (aux.salapas || {})[key];
      if (!row) return false;
      if (row[1] !== (f.prodart || 'P')) return false;
      if (!f.fa || level < TECHDATA_LEVEL_READOUT) return true;
      return !!(f.sa && f.sa.has(String(row[0]).toUpperCase()));
    }
    case 'country': {
      // CountryExpression: the WORKSHOP's outlet country, not the car's
      const code = (aux.countries || {})[key];
      return !!code && code === f.country;
    }
    case 'istufe': {
      // IStufeExpression: no I-level, or the "0" wildcard -> true
      const have = f.ilevel || '';
      if (!have || have === '0') return true;
      return (aux.istufen || {})[key] === have;
    }
    case 'istufex':
      return techDataIstufexLeaf(rule, f, aux);
    case 'equipment': {
      // EquipmentExpression: an unknown feature is false; a feature the
      // resolver has run for (the vehicle test's detection pass) answers
      // with the module's verdict, a verdict it could not read being true
      // as the tool answers; otherwise the feature's own rule decides, and
      // holds unless it is false
      const row = (aux.equipment || {})[key];
      if (!row) return false;
      const name = String(row.n || '');
      if (f.ffm && Object.prototype.hasOwnProperty.call(f.ffm, name))
        return f.ffm[name] == null ? true : !!f.ffm[name];
      return techDataRuleEval(row.r, ids, f) !== false;
    }
    case 'ecuclique':
      return techDataCliqueLeaf(rule.val, ids, f, aux);
    case 'ecurep': {
      // EcuRepresentativeExpression: unknown -> false; before a readout ->
      // true; else the control-unit tree carries that abbreviation
      const kurz = (aux.ecureps || {})[key];
      if (!kurz) return false;
      if (level < TECHDATA_LEVEL_READOUT || !f.titles) return true;
      return f.titles.has(String(kurz).toUpperCase());
    }
    case 'sifa':
      // SiFaExpression: a dealer's protection-vehicle service; none here
      return false;
    case 'validfrom':
    case 'validto': {
      // compared with the wall clock, never with the car
      if (!rule.iso || !f.today) return true;
      return rule.op === 'validfrom'
        ? f.today >= rule.iso
        : f.today <= rule.iso;
    }
    case 'ecugroup':
      // never stored in this corpus; before a readout the tool says true
      return level < TECHDATA_LEVEL_READOUT;
    default:
      return false;
  }
}

/**
 * FormatConverter.ExtractNumericalILevel: the digits of a 14-character
 * I-level ("E89X-21-03-500" -> 2103500), else null.
 * @param {string} s - an I-level
 * @returns {number|null}
 */
function techDataNumericIlevel(s) {
  const t = String(s || '');
  if (t.length !== 14) return null;
  const n = Number(t.replace(/-/g, '').slice(4));
  return Number.isFinite(n) ? n : null;
}

/**
 * IStufeXExpression: the factory or current I-level against the rule's, by
 * series prefix then numerically, with the tool's own answers for an empty
 * or unparsable level.
 * @param {object} rule - the leaf (cmp, flag, val)
 * @param {object} f - the facts
 * @param {object} aux - the rule tables
 * @returns {boolean}
 */
function techDataIstufexLeaf(rule, f, aux) {
  const literal = (aux.istufen || {})[String(rule.val)];
  if (!literal) return false;
  const have = String((rule.flag ? f.ilevelWerk : f.ilevel) || '');
  if (!have || have === '0') return true;
  const parts = String(literal).split('-');
  if (
    parts.length > 1 &&
    have.slice(0, parts[0].length).toUpperCase() !== parts[0].toUpperCase()
  )
    return false;
  const a = techDataNumericIlevel(have);
  const b = techDataNumericIlevel(literal);
  if (rule.cmp === 'eq')
    return (a || 0) === (b || 0) && (a == null) === (b == null);
  if (rule.cmp === 'ne')
    return (a || 0) !== (b || 0) || (a == null) !== (b == null);
  if (a == null || b == null) return false;
  return techDataCompare(a, rule.cmp, b);
}

/**
 * EcuCliqueExpression: an unknown clique is true; one with no variants is
 * false; before a vehicle readout a variant whose own rule and whose
 * group's rule hold makes it true; after one, a variant the car answered
 * as does.
 * @param {number} val - the clique id
 * @param {Set<number>} ids - the car's characteristic ids
 * @param {object} f - the facts
 * @param {object} aux - the rule tables
 * @returns {boolean}
 */
function techDataCliqueLeaf(val, ids, f, aux) {
  const clique = (aux.cliques || {})[String(val)];
  if (!clique) return true;
  const variants = aux.variants || {};
  const groups = aux.groups || {};
  const names = clique.v || [];
  if (!names.length) return false;
  if ((Number(f.level) || 0) < TECHDATA_LEVEL_READOUT || !f.ecus) {
    for (const vid of names) {
      const v = variants[String(vid)] || {};
      if (techDataRuleEval(v.r, ids, f) === false) continue;
      const g = v.g ? groups[String(v.g)] : null;
      if (g && techDataRuleEval(g.r, ids, f) === false) continue;
      return true;
    }
    return false;
  }
  for (const vid of names) {
    const v = variants[String(vid)] || {};
    if (f.ecus.has(String(v.n || '').toLowerCase())) return true;
  }
  return false;
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
    techDataVehicleFacts,
    techDataVehicleLeaf,
    techDataCountry,
    techDataProdart,
    techDataRuleFactsLoad,
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
