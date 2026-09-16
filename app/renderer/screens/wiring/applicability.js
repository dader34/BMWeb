/**
 * @file Wiring applicability: match diagrams and documents to a decoded VIN
 * using BMW's OWN validity rules.
 *
 * Every WDS wiring schematic (an "SP" doc) carries a validity rule in ISTA's
 * DiagDocDb, and ISTA reaches the schematic through its diagnosis tree,
 * whose nodes carry rules of their own. tools/wiring/build_applicability.py
 * decodes both with ISTA's rule grammar (tools/ista/validity_rules.py) into
 * data/wiring-applicability.json.gz:
 *
 *     { "version": 2,
 *       "roots": { "chassis": 53088651, "engine": 53363595, "body": 53046411 },
 *       "rules": { "<object id>": <tree>, ... },
 *       "sp": { "SP0000014320": { "r": "<own rule>", "p": [["<ancestor>", ...]],
 *                                 "c": ["E46"], "u": 1 }, ... } }
 *
 * THE RULE IS A TREE, NOT A BAG OF IDS. The earlier index scanned the blob
 * for any chassis, engine or body id it recognised, which has no AND, OR or
 * NOT: "not M54" shipped as M54-only, and 378 E46 diagrams were another
 * car's. The tree is evaluated here the way the tool's engine would, three-
 * valued (techDataRuleEval): true shows, false hides, and a leaf the car has
 * no fact for is undecided and keeps the diagram.
 *
 * THE CAR'S FACTS come from the decoded VIN: a full VIN's type key names the
 * whole build (every characteristic root), and a production number names
 * the chassis, engine and body by name, so only those three roots are
 * decided and a leaf about anything else stays open. The build date decides
 * the DATE leaves.
 *
 * Match rule against a decoded VIN {vin?, chassis, motor, body, prod}:
 *   off      -> the composed rule is false for the car
 *   match    -> it is true
 *   neutral  -> it is undecidable, the doc has no rule, or the index is not
 *               loaded yet (nothing is hidden until it is)
 *
 * ISTA reference documents (.docs archives) embed a rule per document: the
 * current importer ships {r: tree}; older bundles carry {e, b} name lists,
 * which matchRule still scores the old way until they are rebuilt.
 */

/**
 * One applicability record as the index ships it.
 * @typedef {Object} WiringApplicabilityRec
 * @property {string} [r] - the document's own rule id (into `rules`), or an
 *   inline tree on an embedded document rule
 * @property {string[][]} [p] - paths of gated ancestors, rule ids
 * @property {string[]} [c] - chassis the composed rule holds for
 * @property {number} [u] - 1 when the rule did not decode (kept, unsure)
 * @property {string[]} [e] - LEGACY embedded shape: engine codes
 * @property {string[]} [b] - LEGACY embedded shape: body codes
 */

/**
 * How a document relates to the decoded VIN.
 * @typedef {'match' | 'off' | 'neutral'} WiringVinMatch
 */

(function () {
  'use strict';

  /** @type {object|null} the index as shipped */
  let INDEX = null;
  /** @type {Promise<object>|null} */
  let loading = null;
  /** @type {object|null} type key -> {root: [ids]} */
  let TYPEKEYS = null;
  /** @type {object|null} characteristic id -> name */
  let NAMES = null;
  /** @type {Map<number, Map<string, Set<number>>>|null} root -> name -> ids */
  let BY_NAME = null;
  /** @type {Map<string, object>} composed trees, per SP id */
  const COMPOSED = new Map();
  /** @type {{key: string, keys: object}|null} the last car's facts */
  let CAR = null;

  const EMPTY_INDEX = () => ({ version: 2, roots: {}, rules: {}, sp: {} });

  /**
   * One dataset file, through the app's mirror walker.
   * @param {string} rel - path under the dataset root
   * @returns {Promise<object|null>}
   */
  async function fetchJson(rel) {
    if (typeof hfFetchFirst === 'function') return hfFetchFirst(rel);
    return null;
  }

  /**
   * Load the index and the characteristic tables once. Any failure yields an
   * empty index so the screen shows everything rather than nothing.
   * @param {object|null} [hit] - the decoded VIN to prepare facts for
   * @returns {Promise<object>}
   */
  async function loadIndex(hit) {
    if (!INDEX) {
      if (!loading)
        loading = (async () => {
          const base = typeof WEB_BASE === 'string' ? WEB_BASE : '';
          try {
            const r = await fetch(`${base}/data/wiring/applicability.json.gz`);
            if (!r || !r.ok) throw new Error('no index');
            const buf = new Uint8Array(await r.arrayBuffer());
            const isGz = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
            let text;
            if (isGz) {
              if (typeof fflate === 'undefined') throw new Error('no inflater');
              text = fflate.strFromU8(fflate.gunzipSync(buf));
            } else text = new TextDecoder('utf-8').decode(buf);
            const idx = JSON.parse(text);
            INDEX = idx && idx.sp && idx.version >= 2 ? idx : EMPTY_INDEX();
          } catch {
            INDEX = EMPTY_INDEX();
          }
          try {
            [TYPEKEYS, NAMES] = await Promise.all([
              fetchJson('ista/techdata/typekeys.json'),
              fetchJson('ista/techdata/characteristics.json'),
            ]);
          } catch {
            TYPEKEYS = NAMES = null;
          }
          return INDEX;
        })();
      await loading;
    }
    if (hit) keysFor(hit);
    return INDEX;
  }

  /**
   * Upper-case a code for comparison; null and undefined become ''.
   * @param {unknown} s - any code value
   * @returns {string}
   */
  const up = (s) => String(s == null ? '' : s).toUpperCase();

  /**
   * ISTA body codes (LIM/COU/TOU/CAB/COM/ROA/SAV...) vs the vin-index body
   * codes decodeVin returns (Lim/Cou/Cab/Roa/SAV/CM...).
   * @type {Object<string, string>}
   */
  const BODY_TO_ISTA = {
    LIM: 'LIM',
    COU: 'COU',
    CAB: 'CAB',
    ROA: 'ROA',
    SAV: 'SAV',
    SAC: 'SAC',
    SAT: 'SAT',
    MPV: 'MPV',
    TOU: 'TOU',
    COM: 'COM',
    CM: 'COM',
    HB: 'HAT',
    HC: 'HAT',
    GC: 'HAT',
    GT: 'HAT',
  };

  /**
   * Translate a vin-index body code into ISTA's; unknown codes pass through
   * upper-cased.
   * @param {string} b - body code as decodeVin returns it
   * @returns {string}
   */
  const istaBody = (b) => BODY_TO_ISTA[up(b)] || up(b);

  /**
   * root -> name -> ids, from the type-key table, built once.
   * @returns {Map<number, Map<string, Set<number>>>}
   */
  function byName() {
    if (BY_NAME) return BY_NAME;
    BY_NAME = new Map();
    if (!TYPEKEYS || !NAMES) return BY_NAME;
    for (const tk of Object.values(TYPEKEYS))
      for (const [root, vals] of Object.entries(tk)) {
        const r = Number(root);
        let names = BY_NAME.get(r);
        if (!names) BY_NAME.set(r, (names = new Map()));
        for (const v of vals) {
          const n = up(NAMES[String(v)]);
          if (!n || n === '-') continue;
          let ids = names.get(n);
          if (!ids) names.set(n, (ids = new Set()));
          ids.add(v);
        }
      }
    return BY_NAME;
  }

  /**
   * The car's characteristic ids and the roots they cover, from the decoded
   * VIN. A full VIN's type key is the whole build; a production number gives
   * the chassis, engine and body by name and nothing else is decided.
   * @param {{vin?: string, chassis?: string, motor?: string, body?: string,
   *   prod?: string} | null} hit - the decoded VIN
   * @returns {{ids: Set<number>, facts: object}|null}
   */
  function keysFor(hit) {
    if (!hit) return null;
    const key = JSON.stringify([
      hit.vin,
      hit.chassis,
      hit.motor,
      hit.body,
      hit.prod,
    ]);
    if (CAR && CAR.key === key) return CAR.keys;
    const ids = new Set();
    const roots = new Set();
    const vin = up(hit.vin);
    const tk = vin.length === 17 && TYPEKEYS ? TYPEKEYS[vin.slice(3, 7)] : null;
    if (tk) {
      for (const [root, vals] of Object.entries(tk)) {
        roots.add(Number(root));
        for (const v of vals) ids.add(v);
      }
    } else {
      const R = (INDEX && INDEX.roots) || {};
      const want = [
        [R.chassis, up(hit.chassis)],
        [R.engine, up(hit.motor)],
        [R.body, hit.body ? istaBody(hit.body) : ''],
      ];
      const table = byName();
      for (const [root, name] of want) {
        if (!root || !name) continue;
        const found = table.get(Number(root));
        const got = found && found.get(name);
        if (!got) continue;
        roots.add(Number(root));
        for (const v of got) ids.add(v);
      }
    }
    const facts = { roots };
    const dated =
      typeof techDataCarFacts === 'function'
        ? techDataCarFacts({ prod: hit.prod })
        : {};
    if (dated.ym != null) facts.ym = dated.ym;
    CAR = { key, keys: { ids, facts } };
    return CAR.keys;
  }

  /**
   * The composed tree for one indexed document: own AND a gated path.
   * @param {string} spId - the SP doc id
   * @returns {object|null}
   */
  function composed(spId) {
    if (COMPOSED.has(spId)) return COMPOSED.get(spId);
    const rec = INDEX && INDEX.sp ? INDEX.sp[spId] : null;
    const tree = rec && !rec.u ? composeRec(rec, INDEX.rules || {}) : null;
    COMPOSED.set(spId, tree);
    return tree;
  }

  /**
   * Compose a record's own rule and its paths into one tree.
   * @param {WiringApplicabilityRec} rec - the record
   * @param {Object<string, object>} rules - the rule table
   * @returns {object|null}
   */
  function composeRec(rec, rules) {
    if (typeof techDataComposeRule !== 'function') return null;
    const own =
      rec.r == null ? null : typeof rec.r === 'object' ? rec.r : rules[rec.r];
    const paths = (rec.p || []).map((p) => p.map((id) => rules[id] || null));
    return techDataComposeRule(own || null, paths);
  }

  /**
   * Score one composed tree against the car.
   * @param {object|null} tree - the composed rule
   * @param {object|null} keys - from keysFor
   * @returns {WiringVinMatch}
   */
  function score(tree, keys) {
    if (!tree || !keys || typeof techDataRuleEval !== 'function')
      return 'neutral';
    const v = techDataRuleEval(tree, keys.ids, keys.facts);
    return v === true ? 'match' : v === false ? 'off' : 'neutral';
  }

  /**
   * Score one applicability record against a decoded VIN. A record carrying
   * a rule tree ({r}) is evaluated; a legacy embedded record ({e, b} name
   * lists, from bundles built before the grammar) is scored by name.
   * @param {WiringApplicabilityRec | null | undefined} rec - the rule
   * @param {{chassis?: string, motor?: string, body?: string} | null} hit - the decoded VIN
   * @returns {WiringVinMatch}
   */
  function matchRule(rec, hit) {
    if (!rec || !hit) return 'neutral';
    if (rec.r != null || rec.p)
      return score(composeRec(rec, (INDEX && INDEX.rules) || {}), keysFor(hit));
    let decided = false,
      ok = true;
    if (rec.c && rec.c.length && hit.chassis) {
      decided = true;
      if (!rec.c.some((c) => up(c) === up(hit.chassis))) ok = false;
    }
    if (ok && rec.e && rec.e.length && hit.motor) {
      decided = true;
      const m = up(hit.motor);
      if (!rec.e.some((e) => up(e) === m)) ok = false;
    }
    if (ok && rec.b && rec.b.length && hit.body) {
      decided = true;
      const b = istaBody(hit.body);
      if (!rec.b.some((x) => up(x) === b)) ok = false;
    }
    if (!decided) return 'neutral';
    return ok ? 'match' : 'off';
  }

  /**
   * Match one SP doc against a decoded VIN. Needs the index preloaded;
   * returns 'neutral' if the doc isn't indexed or nothing is decidable.
   * @param {string} spId - the SP doc id the tree carries (leaf.doc)
   * @param {object | null} hit - the decoded VIN
   * @returns {WiringVinMatch}
   */
  function matchDoc(spId, hit) {
    if (!INDEX || !INDEX.sp || !hit) return 'neutral';
    return score(composed(spId), keysFor(hit));
  }

  window.wiringApplicability = {
    load: loadIndex,
    match: matchDoc,
    matchRule: matchRule,
    ready: () => !!INDEX,
    istaBody: istaBody,
    // the car's characteristic ids and facts, for tests and the docs screen
    keys: keysFor,
  };
  window.istaBodyOf = istaBody;
})();
