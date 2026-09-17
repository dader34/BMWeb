#!/usr/bin/env node
// Workshop reference documents: the validity evaluator, the car's
// characteristic set, the tree and search, and the four body renderers.
//
// The extractor's own half (counts against the real DB, the rule grammar's
// parse rate) is test_techdata_extract.py, which skips when the ISTA
// databases are not on this machine. This half is pure and always runs.
//
// The evaluator is the piece worth guarding hardest. It decides which
// documents a mechanic sees for the car in front of them, and both ways of
// being wrong are bad in ways a screenshot would not show: too strict and a
// torque figure silently vanishes, too loose and the figure on screen
// belongs to another engine.
//
//   node tools/verify/test_techdata.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadClassic } = require('./lib/load_classic.js');

const ROOT = path.join(__dirname, '..', '..');
let passed = 0;
const ok = (what) => {
  passed++;
  if (process.env.V) console.log('  ok', what);
};

global.window = global.window || {};
global.esc = (s) =>
  String(s == null ? '' : s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c]
  );

const T = loadClassic('screens/techdata/');

// ---- the rule evaluator ----------------------------------------------------
{
  const { techDataRuleApplies } = T;
  const car = new Set([100, 200, 300]);

  // no rule at all means "every car" -- that is what the source means by a
  // document with no rule, not "no car"
  assert.strictEqual(techDataRuleApplies(null, car), true);
  assert.strictEqual(techDataRuleApplies(undefined, car), true);
  ok('an absent rule applies');

  assert.strictEqual(
    techDataRuleApplies({ op: 'eq', root: 1, val: 100 }, car),
    true
  );
  assert.strictEqual(
    techDataRuleApplies({ op: 'eq', root: 1, val: 999 }, car),
    false
  );
  ok('a leaf tests membership');

  const eq = (v) => ({ op: 'eq', root: 1, val: v });
  assert.strictEqual(
    techDataRuleApplies({ op: 'and', kids: [eq(100), eq(200)] }, car),
    true
  );
  assert.strictEqual(
    techDataRuleApplies({ op: 'and', kids: [eq(100), eq(999)] }, car),
    false,
    'AND needs every operand'
  );
  assert.strictEqual(
    techDataRuleApplies({ op: 'or', kids: [eq(999), eq(200)] }, car),
    true
  );
  assert.strictEqual(
    techDataRuleApplies({ op: 'or', kids: [eq(998), eq(999)] }, car),
    false
  );
  ok('AND and OR');

  assert.strictEqual(
    techDataRuleApplies({ op: 'not', kids: [eq(999)] }, car),
    true
  );
  assert.strictEqual(
    techDataRuleApplies({ op: 'not', kids: [eq(100)] }, car),
    false
  );
  ok('NOT');

  // THIS is the distinction the older scan-for-ids decoder cannot make, and
  // the reason the structured grammar was worth decoding: the same two ids
  // under AND and under OR mean different cars.
  const both = { op: 'and', kids: [eq(100), eq(999)] };
  const either = { op: 'or', kids: [eq(100), eq(999)] };
  assert.notStrictEqual(
    techDataRuleApplies(both, car),
    techDataRuleApplies(either, car),
    'AND and OR over the same ids must differ'
  );
  ok('AND is not OR');

  // nesting
  assert.strictEqual(
    techDataRuleApplies(
      {
        op: 'and',
        kids: [
          { op: 'or', kids: [eq(100), eq(999)] },
          { op: 'not', kids: [eq(998)] },
        ],
      },
      car
    ),
    true
  );
  ok('nested rules');

  // An unknown node applies rather than excluding, for the same reason the
  // extractor keeps undecoded rules: a document that might not apply beats a
  // figure that quietly went missing.
  assert.strictEqual(techDataRuleApplies({ op: 'whatever' }, car), true);
  // ISTA's dated and single-id leaves: decided from facts, unknown otherwise
  const { techDataRuleEval, techDataDateTicks } = T;
  assert.strictEqual(techDataDateTicks(2003, 3, 1), 631820736000000000);
  const mfd = { op: 'mfd', cmp: 'ge', ticks: techDataDateTicks(2003, 3) };
  assert.strictEqual(
    techDataRuleApplies(mfd, car, { built: techDataDateTicks(2004, 9) }),
    true
  );
  assert.strictEqual(
    techDataRuleApplies(mfd, car, { built: techDataDateTicks(2002, 1) }),
    false
  );
  assert.strictEqual(techDataRuleApplies(mfd, car), true);
  assert.strictEqual(techDataRuleEval({ op: 'not', kids: [mfd] }, car), null);
  assert.strictEqual(
    techDataRuleApplies({ op: 'not', kids: [mfd] }, car),
    true
  );
  assert.strictEqual(
    techDataRuleApplies({ op: 'salapa', val: 42 }, car, {
      salapa: new Set([42]),
    }),
    true
  );
  assert.strictEqual(
    techDataRuleApplies({ op: 'salapa', val: 42 }, car, {
      salapa: new Set([1]),
    }),
    false
  );
  assert.strictEqual(
    techDataRuleApplies({ op: 'and', kids: [mfd, eq(999)] }, car),
    false
  );
  const ym = { op: 'date', cmp: 'ge', ym: 199809 };
  assert.strictEqual(techDataRuleApplies(ym, car, { ym: 200409 }), true);
  assert.strictEqual(techDataRuleApplies(ym, car, { ym: 199803 }), false);
  assert.strictEqual(techDataRuleApplies(ym, car), true);
  assert.strictEqual(techDataRuleApplies({ op: 'and', kids: [] }, car), true);
  assert.strictEqual(techDataRuleApplies({ op: 'or', kids: [] }, car), false);
  ok('an unknown node applies');
}

// ---- the filter ------------------------------------------------------------
{
  const { techDataFilter } = T;
  const docs = [
    { id: 1, rule: { op: 'eq', root: 1, val: 10 } },
    { id: 2, rule: { op: 'eq', root: 1, val: 99 } },
    { id: 3 }, // no rule: every car
  ];
  assert.deepStrictEqual(
    techDataFilter(docs, new Set([10])).map((d) => d.id),
    [1, 3]
  );
  // an empty or absent set is "do not filter", which is what Show all wants
  assert.strictEqual(techDataFilter(docs, new Set()).length, 3);
  assert.strictEqual(techDataFilter(docs, null).length, 3);
  ok('the filter keeps what applies');
}

// ---- the tree --------------------------------------------------------------
{
  const { techDataGroups } = T;
  const docs = [
    { mainGroup: '11', mainGroupName: 'Engine', type: 'Technical data' },
    { mainGroup: '11', mainGroupName: 'Engine', type: 'Tightening torques' },
    { mainGroup: '2', mainGroupName: 'Body', type: 'Technical data' },
    { mainGroup: '11', type: 'Technical data' },
  ];
  const g = techDataGroups(docs);
  assert.deepStrictEqual(
    g.map((x) => [x.id, x.name, x.count]),
    [
      ['2', 'Body', 1],
      ['11', 'Engine', 3],
    ],
    'groups are numeric-sorted with their counts'
  );
  // 2 before 11: a string sort would put "11" first and the tree would read
  // as though the body group came after the engine one
  assert.strictEqual(g[0].id, '2', 'groups sort as numbers, not strings');
  assert.deepStrictEqual(techDataGroups([]), []);
  ok('the tree groups and counts');
}

// ---- search ----------------------------------------------------------------
{
  const { techDataSearch, TECHDATA_SEARCH_CAP } = T;
  const docs = [
    { title: 'Camshaft torque values', type: 'Tightening torques' },
    { title: 'Camshaft clearance', type: 'Technical data' },
    { title: 'Wheel alignment', type: 'Technical data' },
  ];
  assert.strictEqual(techDataSearch(docs, '').length, 0, 'no query, no rows');
  assert.strictEqual(techDataSearch(docs, '   ').length, 0);
  assert.strictEqual(techDataSearch(docs, 'camshaft').length, 2);
  // every term has to land, so two words narrow rather than widen
  assert.strictEqual(techDataSearch(docs, 'camshaft torque').length, 1);
  assert.strictEqual(techDataSearch(docs, 'CAMSHAFT').length, 2, 'case-blind');
  // the type is searchable too, which is how someone finds "every torque table"
  assert.strictEqual(techDataSearch(docs, 'tightening').length, 1);
  assert.strictEqual(techDataSearch(docs, 'nothinghere').length, 0);

  const many = Array.from({ length: TECHDATA_SEARCH_CAP + 50 }, () => ({
    title: 'camshaft',
  }));
  assert.strictEqual(
    techDataSearch(many, 'camshaft').length,
    TECHDATA_SEARCH_CAP,
    'the cap holds'
  );
  ok('search narrows on every term');
}

// ---- the car's characteristic set ------------------------------------------
{
  // techDataCarKeys fetches; feed it a stubbed fetch rather than the network
  const typekeys = {
    ET37: { 53088651: [900], 53363595: [901] },
    AB12: { 53088651: [900], 53363595: [902] },
    ZZ99: { 53088651: [910] },
  };
  const chars = { 900: 'E46', 910: 'E90', 901: 'M54', 902: 'M52' };
  global.webRealFetch = async (url) => ({
    ok: true,
    json: async () =>
      url.includes('typekeys')
        ? typekeys
        : url.includes('characteristics')
          ? chars
          : null,
  });
  global.WEB_BASE = '';
  // the page fetches through the mirror walker; the test answers it directly
  global.hfFetchFirst = async (rel) =>
    rel.includes('typekeys')
      ? typekeys
      : rel.includes('characteristics')
        ? chars
        : null;

  (async () => {
    // a full VIN names the exact build: chars 4-7 are the type key
    const exact = await T.techDataCarKeys({ vin: 'WBAET37010ABC1234' });
    assert.strictEqual(exact.exact, true, 'a VIN gives the exact build');
    assert.strictEqual(exact.typeKey, 'ET37');
    assert.deepStrictEqual(
      [...exact.ids].sort((a, b) => a - b),
      [900, 901]
    );
    ok('a VIN resolves to its type key');

    // no VIN: every type key of that development code, folded together. Wider
    // than the real car, but wide in the honest direction -- a saved car
    // without a VIN still sees its chassis's documents rather than none.
    const byChassis = await T.techDataCarKeys({ chassis: 'E46' });
    assert.strictEqual(byChassis.exact, false);
    assert.deepStrictEqual(
      [...byChassis.may].sort((a, b) => a - b),
      [900, 901, 902],
      'both E46 type keys fold in'
    );
    ok('no VIN falls back to the chassis');

    // THE FOLD IS TWO SETS. Every E46 build carries the chassis id, only
    // some carry M54 or M52: a leaf on the shared id decides, a leaf on an
    // engine is undecided, and NOT over it stays undecided -- the union
    // alone made "not M54" false for every E46 and hid the document
    assert.deepStrictEqual(
      [...byChassis.ids].sort((a, b) => a - b),
      [900]
    );
    assert.deepStrictEqual(
      [...byChassis.may].sort((a, b) => a - b),
      [900, 901, 902]
    );
    const m54 = { op: 'eq', root: 2, val: 901 };
    assert.strictEqual(
      T.techDataRuleEval({ op: 'eq', root: 1, val: 900 }, byChassis.ids, {}),
      true
    );
    assert.strictEqual(T.techDataRuleEval(m54, byChassis.ids, {}), null);
    assert.strictEqual(
      T.techDataRuleEval({ op: 'not', kids: [m54] }, byChassis.ids, {}),
      null
    );
    assert.strictEqual(
      T.techDataRuleEval({ op: 'eq', root: 2, val: 999 }, byChassis.ids, {}),
      false
    );
    assert.strictEqual(
      T.techDataFilter(
        [{ id: 'x', rule: { op: 'not', kids: [m54] } }],
        byChassis.ids
      ).length,
      1,
      'a document for the non-M54 builds stays in the chassis view'
    );
    ok('a chassis fold decides only what every build shares');

    // a 7-character production number is not a type key and must not be read
    // as one: VIN[3..7] of "JT12345" is meaningless
    const short = await T.techDataCarKeys({ vin: 'JT12345', chassis: 'E46' });
    assert.strictEqual(short.exact, false, 'a short VIN is not a type key');
    assert.ok(short.ids.size > 0, 'and still falls back to the chassis');
    ok('a production number is not mistaken for a type key');

    // nothing known at all
    const none = await T.techDataCarKeys(null, '');
    assert.strictEqual(none.ids.size, 0);
    assert.strictEqual(none.exact, false);
    const unknown = await T.techDataCarKeys({ chassis: 'X99' });
    assert.strictEqual(unknown.ids.size, 0, 'an unknown chassis matches none');
    ok('an unknown car resolves to nothing');

    // ---- the dated facts -----------------------------------------------
    // ONE SHAPE FOR EVERY GATE: the evaluator compares a DATE leaf as
    // year*100+month, so that is what the builder hands over. The Garage
    // stores the build date as `prod`, YYYYMM or YYYYMMDD.
    const { techDataCarFacts, techDataFilter, techDataRuleEval } = T;
    const { techDataDateTicks } = T;
    assert.deepStrictEqual(techDataCarFacts({ prod: '200203' }), {
      ym: 200203,
      built: techDataDateTicks(2002, 3, 1),
    });
    assert.deepStrictEqual(techDataCarFacts({ prod: '20020315' }), {
      ym: 200203,
      built: techDataDateTicks(2002, 3, 15),
    });
    assert.deepStrictEqual(techDataCarFacts({ prod: 20020315 }), {
      ym: 200203,
      built: techDataDateTicks(2002, 3, 15),
    });
    assert.strictEqual(
      techDataRuleEval(
        { op: 'mfd', cmp: 'ge', ticks: techDataDateTicks(2002, 3, 10) },
        new Set(),
        techDataCarFacts({ prod: '20020315' })
      ),
      true,
      'the production-date leaf is decided from the build date'
    );
    assert.deepStrictEqual(techDataCarFacts({ prod: '' }), {});
    assert.deepStrictEqual(techDataCarFacts({}), {});
    assert.deepStrictEqual(techDataCarFacts(null), {});
    assert.deepStrictEqual(techDataCarFacts({ prod: '200213' }), {});
    ok('the build date travels as year*100+month, or not at all');

    // a document valid from 09/2001: kept for a 2002 car, dropped for a
    // 1999 car, kept for a car whose date nobody knows
    const from0901 = {
      op: 'and',
      kids: [
        { op: 'eq', root: 1, val: 900 },
        { op: 'date', cmp: 'ge', ym: 200109 },
      ],
    };
    const docs = [{ id: 'a', rule: from0901 }];
    const ids = new Set([900]);
    assert.strictEqual(
      techDataFilter(docs, ids, techDataCarFacts({ prod: '200203' })).length,
      1
    );
    assert.strictEqual(
      techDataFilter(docs, ids, techDataCarFacts({ prod: '199905' })).length,
      0
    );
    assert.strictEqual(
      techDataFilter(docs, ids, techDataCarFacts(null)).length,
      1,
      'an unknown date keeps the document'
    );
    assert.strictEqual(
      techDataFilter(docs, ids).length,
      1,
      'no facts at all keeps it too'
    );
    ok('the technical data narrows by build date');

    // ---- the roots the car has facts for ------------------------------
    // A CHARACTERISTIC THE CALLER KNOWS NOTHING ABOUT IS UNDECIDED. A car
    // named by chassis and engine carries those two roots; a leaf about
    // its steering must stay open, not read false because the id is
    // absent from a set that never held that root.
    const steer = { op: 'eq', root: 7, val: 700 };
    const named = { roots: new Set([1]) };
    assert.strictEqual(techDataRuleEval(steer, ids, named), null);
    assert.strictEqual(
      techDataRuleEval({ op: 'eq', root: 1, val: 900 }, ids, named),
      true
    );
    assert.strictEqual(
      techDataRuleEval({ op: 'eq', root: 1, val: 901 }, ids, named),
      false
    );
    assert.strictEqual(
      techDataRuleEval({ op: 'not', kids: [steer] }, ids, named),
      null,
      'NOT of an unknown root stays unknown'
    );
    assert.strictEqual(
      techDataRuleEval(steer, ids, {}),
      false,
      'without roots every leaf is decided'
    );
    ok('a leaf about a root the car has no fact for is undecided');

    // ---- one vehicle answers the tool's way -------------------------
    // READ FROM THE TOOL: RuleHandling.*Expression.Evaluate in the
    // decompiled RheingoldCoreFramework 4.15.16. Strictly boolean, and a
    // missing fact has a definite answer per leaf kind.
    global.hfFetchFirst = async (rel) =>
      rel.includes('typekeys')
        ? typekeys
        : rel.includes('characteristics')
          ? chars
          : rel.includes('rulefacts')
            ? {
                salapas: { 5001: ['403', 'P'], 5002: ['403', 'M'] },
                countries: { 7001: 'US', 7002: 'DE' },
                istufen: { 8001: 'E89X-21-03-500', 8002: 'F001-12-03-500' },
                equipment: {
                  9001: { n: 'ascmk60', r: { op: 'eq', root: 1, val: 900 } },
                  9002: { n: 'ahm3p', r: { op: 'eq', root: 1, val: 999 } },
                },
                ecureps: { 6001: 'DME', 6002: 'LSZ' },
                cliques: {
                  4001: { k: 'dme', v: ['4101', '4102'] },
                  4002: { k: 'none', v: [] },
                },
                variants: {
                  4101: {
                    n: 'ms430ds0',
                    g: '4201',
                    r: { op: 'eq', root: 2, val: 901 },
                  },
                  4102: {
                    n: 'ms450ds0',
                    g: '4201',
                    r: { op: 'eq', root: 2, val: 902 },
                  },
                },
                groups: { 4201: { n: 'd_motor', r: null } },
              }
            : null;
    const { techDataVehicleFacts, techDataVehicleLeaf } = T;
    const vinCar = { vin: 'WBAET37010ABC1234', prod: '200203' };
    const v3 = await techDataVehicleFacts(vinCar, 'E46');
    assert.strictEqual(v3.level, 3, 'a VIN without a readout is level 3');
    assert.strictEqual(v3.prodart, 'P');
    assert.strictEqual(v3.ym, 200203);
    assert.ok(v3.aux && v3.aux.salapas, 'the rule tables travel with it');
    const v1 = await techDataVehicleFacts({ chassis: 'E46' }, 'E46');
    assert.strictEqual(v1.level, 1, 'a type key alone is level 1');
    ok('the facts say how far the car is identified');

    const leaf = (rule, f) => techDataVehicleLeaf(rule, ids, f);
    // SaLaPa: unknown -> false; other product type -> false; no order or
    // no readout -> true; a readout with the order -> hasSA
    assert.strictEqual(leaf({ op: 'salapa', val: 5999 }, v3), false);
    assert.strictEqual(
      leaf({ op: 'salapa', val: 5002 }, v3),
      false,
      'a motorcycle SA on a car'
    );
    assert.strictEqual(
      leaf({ op: 'salapa', val: 5001 }, v3),
      true,
      'no order read: true'
    );
    const v5 = {
      ...v3,
      level: 5,
      fa: true,
      sa: new Set(['403', 'L807']),
      ecus: new Set(['ms450ds0']),
      titles: new Set(['DME']),
    };
    assert.strictEqual(leaf({ op: 'salapa', val: 5001 }, v5), true);
    assert.strictEqual(
      leaf({ op: 'salapa', val: 5001 }, { ...v5, sa: new Set(['205']) }),
      false
    );
    assert.strictEqual(
      leaf({ op: 'salapa', val: 5001 }, { ...v5, fa: false, sa: undefined }),
      true,
      'a readout without an order: true'
    );
    ok('the SA leaf answers as SaLaPaExpression does');

    // dates: missing -> false, not undecided
    assert.strictEqual(leaf({ op: 'date', cmp: 'ge', ym: 200109 }, v3), true);
    assert.strictEqual(
      leaf({ op: 'date', cmp: 'ge', ym: 200109 }, { ...v3, ym: undefined }),
      false
    );
    assert.strictEqual(
      leaf({ op: 'mfd', cmp: 'lt', ticks: 0 }, { ...v3, built: undefined }),
      false
    );
    ok('a date leaf without a model year is false, as DateExpression says');

    // the workshop's country, the I-levels, the features, the reps
    assert.strictEqual(
      leaf({ op: 'country', val: 7001 }, { ...v3, country: 'US' }),
      true
    );
    assert.strictEqual(
      leaf({ op: 'country', val: 7002 }, { ...v3, country: 'US' }),
      false
    );
    assert.strictEqual(
      leaf({ op: 'country', val: 7001 }, { ...v3, country: '' }),
      false
    );
    assert.strictEqual(
      leaf({ op: 'istufe', val: 8001 }, v3),
      true,
      'no I-level: true'
    );
    assert.strictEqual(
      leaf({ op: 'istufe', val: 8001 }, { ...v3, ilevel: '0' }),
      true
    );
    assert.strictEqual(
      leaf({ op: 'istufe', val: 8001 }, { ...v3, ilevel: 'E89X-21-03-500' }),
      true
    );
    assert.strictEqual(
      leaf({ op: 'istufe', val: 8002 }, { ...v3, ilevel: 'E89X-21-03-500' }),
      false
    );
    const x = (cmp, val, f) =>
      leaf({ op: 'istufex', cmp, flag: false, val }, f);
    assert.strictEqual(x('ge', 8001, v3), true, 'no I-level: true');
    assert.strictEqual(
      x('ge', 8001, { ...v3, ilevel: 'E89X-21-05-500' }),
      true
    );
    assert.strictEqual(
      x('gt', 8001, { ...v3, ilevel: 'E89X-21-03-500' }),
      false
    );
    assert.strictEqual(
      x('ge', 8001, { ...v3, ilevel: 'F001-21-05-500' }),
      false,
      'another series'
    );
    assert.strictEqual(x('ge', 8999, v3), false, 'an unknown I-level id');
    assert.strictEqual(
      leaf({ op: 'equipment', val: 9001 }, v3),
      true,
      "the feature's own rule holds"
    );
    assert.strictEqual(leaf({ op: 'equipment', val: 9002 }, v3), false);
    assert.strictEqual(leaf({ op: 'equipment', val: 9999 }, v3), false);
    // the resolver's cache: the detection module's verdict wins, and a
    // verdict it could not read is true, as EquipmentExpression answers
    assert.strictEqual(
      leaf({ op: 'equipment', val: 9001 }, { ...v3, ffm: { ascmk60: false } }),
      false,
      'the module said NotOk'
    );
    assert.strictEqual(
      leaf({ op: 'equipment', val: 9002 }, { ...v3, ffm: { ahm3p: true } }),
      true,
      'the module said Ok, whatever the rule'
    );
    assert.strictEqual(
      leaf({ op: 'equipment', val: 9001 }, { ...v3, ffm: { ascmk60: null } }),
      true,
      'an unreadable verdict is true'
    );
    assert.strictEqual(
      leaf({ op: 'equipment', val: 9001 }, { ...v3, ffm: { other: false } }),
      true,
      "another feature's verdict is not this one's"
    );
    assert.strictEqual(
      leaf({ op: 'ecurep', val: 6001 }, v3),
      true,
      'before a readout: true'
    );
    assert.strictEqual(leaf({ op: 'ecurep', val: 6001 }, v5), true);
    assert.strictEqual(leaf({ op: 'ecurep', val: 6002 }, v5), false);
    assert.strictEqual(leaf({ op: 'ecurep', val: 6999 }, v5), false);
    assert.strictEqual(leaf({ op: 'sifa', val: 1 }, v3), false);
    assert.strictEqual(
      leaf({ op: 'validfrom', val: 1, iso: '2011-07-14' }, v3),
      true
    );
    assert.strictEqual(
      leaf({ op: 'validto', val: 1, iso: '2011-07-14' }, v3),
      false
    );
    assert.strictEqual(
      leaf({ op: 'validfrom', val: 1 }, v3),
      true,
      'no date on the leaf: true'
    );
    ok(
      'country, I-level, feature, representative and window leaves answer as the tool does'
    );

    // the ECU clique: before a readout the variants' rules decide against
    // the car; after one, the variant it answered as
    const m54ids = new Set([900, 901]);
    assert.strictEqual(
      techDataVehicleLeaf({ op: 'ecuclique', val: 4001 }, m54ids, v3),
      true,
      'an M54 build fits ms430ds0'
    );
    const m52ids = new Set([900, 902]);
    assert.strictEqual(
      techDataVehicleLeaf({ op: 'ecuclique', val: 4001 }, m52ids, v3),
      true,
      'an M52 build fits ms450ds0'
    );
    assert.strictEqual(
      techDataVehicleLeaf(
        { op: 'ecuclique', val: 4001 },
        new Set([900, 903]),
        v3
      ),
      false,
      'neither variant fits'
    );
    assert.strictEqual(
      leaf({ op: 'ecuclique', val: 4001 }, v5),
      true,
      'the car answered as ms450ds0'
    );
    assert.strictEqual(
      leaf({ op: 'ecuclique', val: 4001 }, { ...v5, ecus: new Set(['zke5']) }),
      false
    );
    assert.strictEqual(
      leaf({ op: 'ecuclique', val: 4002 }, v5),
      false,
      'no variants'
    );
    assert.strictEqual(
      leaf({ op: 'ecuclique', val: 4999 }, v5),
      true,
      'an unknown clique'
    );
    ok(
      'the ECU clique leaf walks the rule tables before a readout and the car after'
    );

    // through the tree: the vehicle mode decides every leaf, so NOT works
    assert.strictEqual(
      T.techDataRuleApplies(
        { op: 'not', kids: [{ op: 'salapa', val: 5001 }] },
        ids,
        v3
      ),
      false,
      'NOT over a true SA leaf hides the document'
    );
    assert.strictEqual(
      T.techDataRuleApplies(
        { op: 'not', kids: [{ op: 'salapa', val: 5001 }] },
        ids,
        {}
      ),
      true,
      'without a vehicle the same leaf is undecided and the document stays'
    );
    ok('a vehicle decides every leaf; a set of builds keeps the undecided');

    // ---- composing a document with its gated path ----------------------
    const { techDataComposeRule } = T;
    const eq = (v) => ({ op: 'eq', root: 1, val: v });
    const own = eq(100);
    assert.deepStrictEqual(techDataComposeRule(own, []), own);
    assert.deepStrictEqual(techDataComposeRule(null, []), null);
    assert.deepStrictEqual(techDataComposeRule(own, [[eq(200)]]), {
      op: 'and',
      kids: [own, eq(200)],
    });
    assert.deepStrictEqual(
      techDataComposeRule(own, [[eq(200), eq(300)], [eq(400)]]),
      {
        op: 'and',
        kids: [
          own,
          {
            op: 'or',
            kids: [{ op: 'and', kids: [eq(200), eq(300)] }, eq(400)],
          },
        ],
      }
    );
    assert.deepStrictEqual(
      techDataComposeRule(own, [[eq(200)], []]),
      own,
      'an ungated path reaches the document unconditionally'
    );
    ok('a document composes with the paths that reach it');

    renderChecks();
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

/** The body renderers. Run after the async car-key checks. */
function renderChecks() {
  const { techDataDocHtml, techDataRowsHtml } = T;

  // a torque table keeps its columns AND its unit: a figure without its Nm
  // is not a smaller piece of information, it is a dangerous one
  const torque = techDataDocHtml(
    { title: 'Vibration damper', type: 'Tightening torques', mainGroup: '11' },
    {
      torques: [
        { part: 'Damper bolt', thread: 'M12', torque: '110', unit: 'Nm' },
        { part: 'Pulley', torque: '22', unit: 'Nm', engines: ['M54'] },
      ],
    }
  );
  assert.ok(torque.includes('110 Nm'), 'the unit travels with the number');
  assert.ok(torque.includes('22 Nm'));
  assert.ok(torque.includes('Damper bolt'));
  assert.ok(torque.includes('M12'), 'the thread column is drawn when present');
  assert.ok(torque.includes('td-tag'), 'per-row engine validity is tagged');
  ok('torque rows keep their units');

  // prose
  const fluids = techDataDocHtml(
    { title: 'Engine oil', type: 'Operating fluids' },
    {
      headline: 'SI 00 13 96',
      hints: ['Observe the approval list.'],
      blocks: [
        { t: 'p', s: 'Approved oils are listed below.' },
        { t: 'bullet', s: 'BMW Longlife-01' },
        { t: 'bullet', s: 'BMW Longlife-04' },
      ],
    }
  );
  assert.ok(fluids.includes('Approved oils'));
  assert.ok(
    fluids.includes('<ul class="td-list">'),
    'bullets group into a list'
  );
  assert.strictEqual(
    (fluids.match(/<ul class="td-list">/g) || []).length,
    1,
    'consecutive bullets make ONE list, not one list each'
  );
  assert.ok(fluids.includes('td-hint'));
  ok('prose renders');

  // a special tool leads with the number someone came for
  const tool = techDataDocHtml(
    { title: 'Foil', type: 'Special tools' },
    { toolNumber: '0495608', toolNumberOld: '001161', designation: 'Foil' }
  );
  assert.ok(tool.includes('0495608'));
  assert.ok(tool.includes('Tool number'));
  ok('a special tool shows its numbers');

  // an unsure document is shown, and says so
  const unsure = techDataDocHtml(
    { title: 'X', type: 'Technical data', unsure: true },
    { blocks: [{ t: 'p', s: 'body' }] }
  );
  assert.ok(unsure.includes('td-unsure'), 'an unsure doc is marked');
  assert.ok(/could not be read/.test(unsure));
  ok('an unsure document says so');

  // a missing body is a stated fact, not a blank pane
  const nobody = techDataDocHtml({ title: 'X', type: 'Technical data' }, null);
  assert.ok(nobody.includes('not in this build'));
  const empty = techDataDocHtml({ title: 'X', type: 'Technical data' }, {});
  assert.ok(empty.includes('no body text'));
  ok('a missing body is stated');

  // every rendered value is escaped: the bodies are BMW's text, not ours
  const nasty = techDataDocHtml(
    { title: '<script>x</script>', type: 'Technical data' },
    { blocks: [{ t: 'p', s: '<img onerror=1>' }] }
  );
  assert.ok(!nasty.includes('<script>'), 'the title is escaped');
  assert.ok(!nasty.includes('<img'), 'body text is escaped');
  ok('document text is escaped');

  // tables
  assert.strictEqual(techDataRowsHtml([], true), '');
  assert.strictEqual(techDataRowsHtml(null, true), '');
  const t = techDataRowsHtml(
    [
      ['A', 'B'],
      ['1', '2'],
    ],
    true
  );
  assert.ok(t.includes('<thead>') && t.includes('<th>A</th>'));
  assert.ok(t.includes('<td>1</td>'));
  // a ragged row is padded, so the columns still line up
  const ragged = techDataRowsHtml([['A', 'B', 'C'], ['1']], true);
  assert.strictEqual(
    (ragged.match(/<td>/g) || []).length,
    3,
    'short rows are padded to the widest'
  );
  ok('tables render and pad');

  // the hit table
  const rows = T.techDataTableHtml([
    { type: 'Technical data', title: 'Camshaft', unsure: true },
  ]);
  assert.ok(rows.includes('td-flag'), 'an unsure row carries the flag');
  assert.ok(rows.includes('Camshaft'));
  assert.ok(
    T.techDataTableHtml([]).includes('Show all'),
    'empty says what to do'
  );
  ok('the hit table renders');

  // ---- wired into the app -------------------------------------------------
  const html = fs.readFileSync(
    path.join(ROOT, 'app', 'renderer', 'index.html'),
    'utf8'
  );
  const off = fs.readFileSync(
    path.join(ROOT, 'app', 'renderer', 'core', 'offline-export.js'),
    'utf8'
  );
  for (const f of [
    'screens/techdata/data.js',
    'screens/techdata/render.js',
    'screens/techdata/screen.js',
  ]) {
    assert.ok(html.includes(f), `index.html loads ${f}`);
    assert.ok(off.includes(f), `OFFLINE_SHELL carries ${f}`);
  }
  // the shell's Workshop tab opens it
  const model = fs.readFileSync(
    path.join(ROOT, 'app', 'renderer', 'screens', 'ista', 'model.js'),
    'utf8'
  );
  assert.ok(/page: 'techdata'/.test(model), 'the Workshop tab opens the page');
  ok('the tab is wired into the shell');

  console.log(`test_techdata: ${passed} checks passed`);
}
