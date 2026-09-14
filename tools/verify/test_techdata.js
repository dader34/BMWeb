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
      [...byChassis.ids].sort((a, b) => a - b),
      [900, 901, 902],
      'both E46 type keys fold in'
    );
    ok('no VIN falls back to the chassis');

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
