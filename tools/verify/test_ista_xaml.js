#!/usr/bin/env node
// Pages drawn from ISTA's own layout: the compiler's output shape (when the
// decompiled layouts are on this machine), and the pure half of the
// renderer on hand-built templates -- expressions, converters, the split of
// a view into content / status / buttons, and what the bottom bar and the
// status line come out as.
//
//   node tools/verify/test_ista_xaml.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadClassic } = require('./lib/load_classic.js');

const ROOT = path.join(__dirname, '..', '..');
let passed = 0;
const ok = (what) => {
  passed++;
  if (process.env.V) console.log('  ok', what);
};

global.window = global.window || {};
global.document = global.document || undefined;
global.esc = (s) => String(s == null ? '' : s);
const store = {};
global.Settings = {
  get: (k, d) => (k in store ? store[k] : d),
  set: (k, v) => {
    store[k] = v;
  },
};
loadClassic('core/webshim/data-fetch.js');
const X = loadClassic('screens/ista/');

const strings = {
  '#Hits': 'Hits:',
  '#Filter': 'Filter',
  '#FilterDefault': 'Default',
  '#FilterUserDefined': 'User-defined',
  '#Show': 'Show fault code',
  '#Calc': 'Calculate test plan',
  '#Expand': 'Show completely',
  '#Air': 'PuMA measures',
  '#NotCalled': 'not called',
  '#Performed': 'performed',
  '#TwoLines': 'Repair/\\nmaintenance',
};

// ---- the setting ------------------------------------------------------------
// the tool's layout is the page unless the setting turns it off
assert.strictEqual(X.istaXamlOn('fault-memory'), true);
store[X.ISTA_XAML_KEY] = { 'fault-memory': false };
assert.strictEqual(X.istaXamlOn('fault-memory'), false);
assert.strictEqual(X.istaXamlOn('test-plan'), true);
store[X.ISTA_XAML_KEY] = 'off';
assert.strictEqual(X.istaXamlOn('test-plan'), false);
delete store[X.ISTA_XAML_KEY];
ok('a page draws from the template unless the setting names it off');

// ---- expressions ------------------------------------------------------------
{
  const ctx = { strings };
  const data = {
    A: { B: 'deep' },
    List: [1, 2, 3],
    Flag: true,
    Empty: '',
    Settings: { IsDefault: false },
  };
  const ev = (e) => X.istaXamlEval(e, data, ctx);
  assert.strictEqual(ev({ lit: 'x' }), 'x');
  assert.strictEqual(ev({ loc: '#Show' }), 'Show fault code');
  assert.strictEqual(ev({ loc: '#Filter', colon: true }), 'Filter:');
  // a key that already ends in a colon does not get a second one
  assert.strictEqual(ev({ loc: '#Hits', colon: true }), 'Hits:');
  // an unknown key shows its name rather than nothing
  assert.strictEqual(ev({ loc: '#NoSuchKey' }), 'NoSuchKey');
  assert.strictEqual(ev({ loc: '#TwoLines' }), 'Repair/\nmaintenance');
  assert.strictEqual(ev({ bind: 'A.B' }), 'deep');
  assert.strictEqual(ev({ bind: 'List.Count' }), 3);
  assert.strictEqual(ev({ bind: 'A.Missing.Deeper' }), undefined);
  assert.strictEqual(ev({ bind: 'Nope', fallback: '-' }), '-');
  assert.strictEqual(
    ev({ multi: [{ bind: 'List.Count' }, { lit: '9' }], fmt: '{0} / {1}' }),
    '3 / 9'
  );
  assert.strictEqual(
    ev({ bind: 'Settings.IsDefault', conv: 'FilterDefaultInfoConverter' }),
    'User-defined'
  );
  // a binding to another element reads live WPF state nothing stands in for
  assert.strictEqual(ev({ bind: 'ActualWidth', rel: true }), undefined);
  ok('expressions: literals, keys, paths, multi, fallback, converters');

  const vis = (e) => X.istaXamlVisible(e, data, ctx);
  assert.strictEqual(vis(undefined), true);
  assert.strictEqual(
    vis({ bind: 'Flag', conv: 'BooleanVisibilityConverter' }),
    true
  );
  assert.strictEqual(
    vis({ bind: 'Flag', conv: 'BooleanVisibilityConverter', param: 'true' }),
    false
  );
  assert.strictEqual(
    vis({ bind: 'Empty', conv: 'HasValueVisibilityConverter' }),
    false
  );
  // the build runs as plain ISTA: a TELESERVICE-only column is hidden
  const mode = (p) =>
    vis({ bind: '.', conv: 'OperationalModeVisibilityConverter', param: p });
  assert.strictEqual(mode('TELESERVICE'), false);
  assert.strictEqual(mode('ISTA,ISTA_PLUS'), true);
  // a converter nobody supplies leaves the control SHOWN and is recorded
  const c2 = { strings };
  assert.strictEqual(
    X.istaXamlVisible({ bind: 'Flag', conv: 'SomeBrandConverter' }, data, c2),
    true
  );
  assert.ok(c2.missing.has('SomeBrandConverter'));
  ok('visibility: inversion, operational mode, unknown reads as shown');
}

// ---- a view in ISTA's skeleton ----------------------------------------------
const view = {
  version: 1,
  view: 'T',
  resources: { Src: { source: { bind: 'Rows' } } },
  root: {
    t: 'UserControl',
    kids: [
      {
        t: 'Border',
        kids: [
          {
            t: 'Grid',
            rows: ['*', 'Auto', 'Auto'],
            kids: [
              {
                t: 'ListViewDataGrid',
                n: 'grid',
                items: { bind: 'Rows' },
                columns: [{ t: 'DataGridTextColumn', bind: { bind: 'Code' } }],
              },
              {
                t: 'Grid',
                a: { row: '1' },
                kids: [
                  { t: 'Label', text: { loc: '#Hits' } },
                  { t: 'TextBlock', text: { bind: 'Count', res: 'Src' } },
                  { t: 'Label', text: { loc: '#Filter', colon: true } },
                  {
                    t: 'TextBlock',
                    text: {
                      bind: 'F.IsDefault',
                      conv: 'FilterDefaultInfoConverter',
                    },
                  },
                  {
                    t: 'ContentControl',
                    view: 'Legend',
                    kids: [
                      { t: 'Border', kids: [{ t: 'Ellipse' }] },
                      { t: 'Label', text: { loc: '#NotCalled' } },
                      { t: 'Border', kids: [{ t: 'Ellipse' }] },
                      { t: 'Label', text: { loc: '#Performed' } },
                    ],
                  },
                ],
              },
              {
                t: 'DockPanel',
                a: { row: '2' },
                kids: [
                  {
                    t: 'Button',
                    n: 'b1',
                    text: { loc: '#Show' },
                    cmd: { bind: 'CmdShow' },
                  },
                  {
                    t: 'ToggleButton',
                    n: 'Expand',
                    text: { loc: '#Expand' },
                  },
                  {
                    t: 'Button',
                    n: 'air',
                    text: { loc: '#Air' },
                    cmd: { bind: 'CmdAir' },
                    vis: {
                      bind: 'IsAirActive',
                      conv: 'BooleanVisibilityConverter',
                    },
                  },
                  {
                    t: 'Grid',
                    a: { horizontalAlignment: 'Stretch' },
                    kids: [
                      {
                        t: 'Button',
                        n: 'b7',
                        a: { horizontalAlignment: 'Right' },
                        text: { loc: '#Calc' },
                        cmd: { bind: 'CmdCalc' },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
};

{
  const parts = X.istaXamlParts(view);
  assert.strictEqual(parts.content.length, 1);
  assert.strictEqual(parts.content[0].n, 'grid');
  assert.strictEqual(parts.status.length, 1);
  assert.strictEqual(parts.buttons.length, 1);
  assert.ok(parts.resources.Src);
  ok('a view splits into content, status and buttons through its wrapper');

  let ran = '';
  let on = false;
  const ctx = {
    strings,
    declared: parts.resources,
    data: {
      Rows: [{ Code: '1' }, { Code: '2' }],
      F: { IsDefault: true },
      IsAirActive: false,
    },
    commands: {
      CmdShow: () => {
        ran = 'show';
      },
    },
    toggles: {
      Expand: {
        on,
        toggle: () => {
          on = !on;
        },
      },
    },
  };
  const bar = X.istaXamlButtons(parts.buttons, ctx);
  // the hidden button is gone; the right-aligned one follows a spacer
  assert.deepStrictEqual(
    bar.map((b) => (b.spacer ? '|' : b.label)),
    ['Show fault code', 'Show completely', '|', 'Calculate test plan']
  );
  assert.strictEqual(bar[0].off, false);
  bar[0].fn();
  assert.strictEqual(ran, 'show');
  // a command the page did not supply draws its button off
  assert.strictEqual(bar[3].off, true);
  assert.strictEqual(bar[3].fn, null);
  // a toggle is live through the page's own state
  bar[1].fn();
  assert.strictEqual(on, true);
  ok('the bottom bar: order, the spacer, hidden and unsupplied commands');

  // a command object can be off for the button yet live for a double click
  ctx.commands.CmdShow = { off: true, run: () => {} };
  assert.strictEqual(X.istaXamlButtons(parts.buttons, ctx)[0].off, true);
  ok('a command can be off as a button and still carry a handler');

  const st = X.istaXamlStatus(parts.status, ctx);
  assert.deepStrictEqual(st.items, [
    { k: 'Hits:', v: '2' },
    { k: 'Filter:', v: 'Default' },
  ]);
  assert.deepStrictEqual(st.legend, [
    { cls: 'none', label: 'not called' },
    { cls: 'ok', label: 'performed' },
  ]);
  ok('the status line: label/value pairs and the legend');

  // a page may hand a resource its rows instead of the declared source
  ctx.resources = { Src: [1, 2, 3, 4] };
  assert.strictEqual(X.istaXamlStatus(parts.status, ctx).items[0].v, '4');
  ok("a page's own rows win over a resource's declared source");
}

// ---- rows that are not what their position suggests -------------------------
{
  // a form above the table is content, not a status row; and a button row
  // laid out as a Grid splits at its star column
  const v2 = {
    root: {
      t: 'UserControl',
      kids: [
        {
          t: 'Grid',
          rows: ['Auto', '*', 'Auto'],
          kids: [
            { t: 'Grid', kids: [{ t: 'TextBox', text: { bind: 'Q' } }] },
            {
              t: 'ListView',
              a: { row: '1' },
              items: { bind: '.', res: 'R' },
              columns: [{ t: 'GridViewColumn' }],
            },
            {
              t: 'Grid',
              a: { row: '2' },
              cols: ['143', '*', '143'],
              kids: [
                { t: 'Button', text: { lit: 'L' }, cmd: { bind: 'A' } },
                {
                  t: 'Button',
                  a: { col: '2' },
                  text: { lit: 'R' },
                  cmd: { bind: 'B' },
                },
              ],
            },
          ],
        },
      ],
    },
  };
  const parts = X.istaXamlParts(v2);
  assert.strictEqual(parts.content.length, 2);
  assert.strictEqual(parts.status.length, 0);
  const bar = X.istaXamlButtons(parts.buttons, { strings, data: {} });
  assert.deepStrictEqual(
    bar.map((b) => (b.spacer ? '|' : b.label)),
    ['L', '|', 'R']
  );
  // an empty pair of fields is an empty line, not a line of separators
  assert.strictEqual(
    X.istaXamlEval(
      { multi: [{ bind: 'A' }, { bind: 'B' }], fmt: '{0} / {1}' },
      {},
      { strings }
    ),
    ''
  );
  ok('a form row is content; a Grid of buttons splits at its star column');
}

// ---- the SAE lookup ---------------------------------------------------------
{
  global.hexForPcode = (p) => (p === 'P0171' ? '2774' : '');
  global.pcodesForHex = (h) => (h === '2774' ? ['P0171', 'P0174'] : []);
  global.scopedFaultDb = (sgbd) => (sgbd === 'ms450ds0' ? { 2774: 1 } : null);
  global.faultName = (a, code, sgbd) =>
    code === '2774' ? (sgbd ? 'Mixture too lean' : 'shared text') : '';
  const own = X.istaSaeLookup('p0171', '', ['dsc_mk60', 'ms450ds0']);
  assert.strictEqual(own.length, 1);
  assert.strictEqual(own[0].DTC.FortAsHexString, '2774');
  // the car's own module answers, and the row says whose table it was
  assert.strictEqual(own[0].FaultLabel, 'Mixture too lean (ms450ds0)');
  assert.strictEqual(
    X.istaSaeLookup('', '2774', [])[0].FaultLabel,
    'shared text'
  );
  assert.deepStrictEqual(
    X.istaSaeLookup('', '2774', []).map((r) => r.PKode),
    ['P0171', 'P0174']
  );
  assert.strictEqual(X.istaSaeLookup('', 'FFFF', [])[0].PKode, '-');
  ok("the SAE lookup: the car's own module first, both directions");
}

// ---- the diagnosis text search ----------------------------------------------
{
  const data = {
    'function-structure': {
      tree: [
        {
          label: 'Engine',
          kids: [
            {
              label: 'Oil supply',
              docs: [
                { id: 'FUB-1', title: 'Oil level sensor', type: 'FUB' },
                { id: 'SSP-9', title: 'Wiring diagram', type: 'SSP' },
              ],
            },
          ],
        },
      ],
    },
    'component-structure': null,
  };
  const all = { structures: true, title: true, number: false, document: false };
  const find = (q, sc, bodies) =>
    X.istaDiagSearchHits(data, q, sc || all, bodies).map((h) => h.doc.id);
  assert.deepStrictEqual(find('sensor'), ['FUB-1']);
  // the path counts: both documents sit under "Oil supply"
  assert.deepStrictEqual(find('oil supply'), ['FUB-1', 'SSP-9']);
  assert.deepStrictEqual(find('oil supply', { ...all, structures: false }), []);
  // one character is not a search
  assert.deepStrictEqual(find('o'), []);
  assert.deepStrictEqual(find('ssp-9'), []);
  assert.deepStrictEqual(find('ssp-9', { ...all, number: true }), ['SSP-9']);
  // the body scope finds nothing until its index has loaded
  const body = { ...all, title: false, structures: false, document: true };
  assert.deepStrictEqual(find('pin 4', body, null), []);
  assert.deepStrictEqual(
    find('pin 4', body, new Map([['SSP-9', 'Connector X6, pin 4']])),
    ['SSP-9']
  );
  ok('the diagnosis search: title, path, number and body scopes');
}

// ---- the fault filter, as Logic.FilterDTCRelevance decides it ---------------
{
  const f = (o) => ({
    relevance: null,
    current: { km: 100 },
    first: null,
    ...o,
  });
  const pass = (fault, filter, opts) =>
    X.istaFaultRelevant(fault, filter, opts);
  // no filter: everything with an unknown verdict shows
  assert.strictEqual(pass(f({})), true);
  // a fault the database calls not relevant is hidden by default
  assert.strictEqual(pass(f({ relevance: false })), false);
  assert.strictEqual(
    pass(f({ relevance: false }), null, { hideBogus: false }),
    true
  );
  assert.strictEqual(pass(f({ relevance: true })), true);
  assert.strictEqual(pass(f({}), null, { hideUnknown: true }), false);
  // the bounds are inclusive
  assert.strictEqual(pass(f({}), { lower: 100, upper: 100 }), true);
  assert.strictEqual(pass(f({}), { lower: 101 }), false);
  assert.strictEqual(pass(f({}), { upper: 99 }), false);
  // either entry inside the range keeps the fault
  const both = f({ current: { km: 500 }, first: { km: 50 } });
  assert.strictEqual(pass(both, { lower: 400 }), true);
  assert.strictEqual(pass(both, { upper: 60 }), true);
  assert.strictEqual(pass(both, { lower: 501 }), false);
  assert.strictEqual(pass(both, { upper: 49 }), false);
  // no record at all: hidden as soon as a bound is set, shown otherwise
  assert.strictEqual(pass(f({ current: null })), true);
  assert.strictEqual(pass(f({ current: null }), { lower: 0 }), false);
  assert.strictEqual(pass(f({ current: null }), { upper: 9e9 }), false);
  // a record with no mileage counts as -1
  assert.strictEqual(pass(f({ current: { km: null } }), { lower: 0 }), false);
  assert.strictEqual(pass(f({ current: { km: null } }), { upper: 10 }), true);
  // a class ticked off hides its faults
  assert.strictEqual(pass(f({ cls: 'A' }), { hidden: ['A'] }), false);
  assert.strictEqual(pass(f({ cls: 'B' }), { hidden: ['A'] }), true);
  assert.strictEqual(X.istaFaultFilterDefault(null), true);
  assert.strictEqual(X.istaFaultFilterDefault({ hidden: [] }), true);
  assert.strictEqual(X.istaFaultFilterDefault({ lower: 0 }), false);
  ok('the fault filter: relevance, mileage range on either entry, class');

  // the cursor step grows while one arrow is pressed in a run
  const run = { time: 0, count: 0, button: '' };
  const press = (t, btn, max, inc) =>
    X.istaFaultCursorStep(inc || 1, max, run, btn || 'a', t);
  assert.strictEqual(press(1000, 'a', 100000), 1);
  for (let i = 1; i <= 3; i++)
    assert.strictEqual(press(1000 + i * 100, 'a', 100000), 1);
  assert.strictEqual(press(1400, 'a', 100000), 100);
  for (let i = 0; i < 6; i++) press(1500 + i * 100, 'a', 100000);
  assert.strictEqual(press(2100, 'a', 100000), 1000);
  for (let i = 0; i < 4; i++) press(2200 + i * 100, 'a', 100000);
  assert.strictEqual(press(2600, 'a', 100000), 10000);
  // a pause, or another arrow, starts over
  assert.strictEqual(press(3000, 'a', 100000), 1);
  press(3100, 'a', 100000);
  assert.strictEqual(press(3200, 'b', 100000, -1), -1);
  // never past what is left in that direction
  run.count = 20;
  run.time = 5000;
  run.button = 'c';
  assert.strictEqual(press(5100, 'c', 5), 1);
  assert.strictEqual(press(5200, 'c', 0), 0);
  ok('the filter cursor: the progressive step and its reset');
}

// ---- what the database says about a fault, and the plan's priorities --------
{
  const table = { 10179: [50, 1], 10200: [100, 0], 300: [25, 1] };
  const meta = (row, t) => X.istaFaultMeta(row, t === undefined ? table : t);
  // the fault location arrives as a number and is looked up in decimal
  assert.deepStrictEqual(meta({ raw: { F_ORT_NR: '10179' }, code: 'XX' }), {
    known: true,
    relevance: true,
    weight: 50,
  });
  // without one, the hex on screen is the same number
  assert.strictEqual(meta({ raw: {}, code: '27C3' }).weight, 50);
  // RELEVANCE 0 is a verdict; a code the table lacks has none
  assert.strictEqual(meta({ raw: { F_ORT_NR: 10200 } }).relevance, false);
  assert.strictEqual(meta({ raw: { F_ORT_NR: 999 } }).relevance, null);
  assert.strictEqual(meta({ raw: { F_ORT_NR: 999 } }).known, true);
  // no table for the variant is "no data here", not "no verdict"
  assert.strictEqual(meta({ raw: { F_ORT_NR: 300 } }, null).known, false);
  ok('a fault: relevant, not relevant, no verdict, no data');

  const link = (fault, weight, present) => ({ fault, weight, present });
  const rows = X.istaPlanPrioritise([
    { id: 'a', component: 'Low', state: 'none', links: [link('f1', 25)] },
    { id: 'b', component: 'Sure', state: 'none', links: [link('f2', 100)] },
    {
      id: 'c',
      component: 'Middle x2',
      state: 'none',
      links: [link('f3', 50), link('f4', 50)],
    },
    { id: 'd', component: 'Middle', state: 'none', links: [link('f3', 50)] },
    {
      id: 'e',
      component: 'Middle, present',
      state: 'none',
      links: [link('f5', 50, true)],
    },
    // a second procedure under the same component shares its priority
    {
      id: 'g',
      component: 'Sure',
      state: 'suspected',
      links: [link('f2', 100)],
    },
    { id: 'h', component: 'Pattern', state: 'none', priority: 'F', links: [] },
  ]);
  const prio = Object.fromEntries(rows.map((r) => [r.id, r.priority]));
  // strongest first, from 3; one step per change in ranking
  assert.strictEqual(prio.c, 4);
  assert.strictEqual(prio.e, 5);
  assert.strictEqual(prio.d, 6);
  assert.strictEqual(prio.a, 7);
  // the component's rows share one priority: the last row walked sets it,
  // and that row is suspected, so it reads a tenth lower
  assert.strictEqual(prio.b, 3.1);
  assert.strictEqual(prio.g, 3.1);
  // a fault pattern's component keeps its letter
  assert.strictEqual(prio.h, 'F');
  // the same fault twice counts once for a component
  const once = X.istaPlanPrioritise([
    { id: 'x', component: 'A', links: [link('f', 50), link('f', 50)] },
    { id: 'y', component: 'B', links: [link('g', 50)] },
  ]);
  assert.strictEqual(once[0].priority, once[1].priority);
  assert.strictEqual(X.istaPlanCompare({ sure: 1 }, { strong: 9 }), 1);
  assert.strictEqual(
    X.istaPlanCompare({ low: 1, present: true }, { low: 1 }),
    1
  );
  ok('plan priorities: weighting buckets, shared ranks, suspected, F kept');
}

// ---- lengths ----------------------------------------------------------------
assert.strictEqual(X.istaXamlLen('140'), '140px');
assert.strictEqual(X.istaXamlLen('Auto'), 'auto');
assert.strictEqual(X.istaXamlLen('*', true), 'minmax(0, 1fr)');
assert.strictEqual(X.istaXamlLen('2*', true), 'minmax(0, 2fr)');
// WPF writes left,top,right,bottom; CSS wants top right bottom left
assert.strictEqual(X.istaXamlThickness('7,0,3,2'), '0px 3px 2px 7px');
assert.strictEqual(X.istaXamlThickness('5'), '5px');
ok('lengths and thicknesses convert to CSS');

// ---- the compiler, where the decompiled layouts are on this machine ---------
const BMWFILES =
  process.env.BMWFILES || path.join(os.homedir(), 'Development/code/BMWFILES');
const SRC = path.join(BMWFILES, 'ista', 'extracted', 'decompiled');
if (fs.existsSync(path.join(SRC, 'ISTAGUI', 'xaml', 'views', 'tabs'))) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ista-xaml-'));
  execFileSync(
    'python3',
    [path.join(ROOT, 'tools/ista/xaml_compile.py'), '--out', out],
    { stdio: 'pipe' }
  );
  const load = (f) => JSON.parse(fs.readFileSync(path.join(out, f), 'utf8'));
  const index = load('index.json');
  assert.deepStrictEqual(Object.keys(index.views).sort(), [
    'BasicFeaturesView',
    'FaultMemoryView',
    'TestPlanView',
  ]);
  assert.ok(index.cultures.includes('en-GB'));
  assert.ok(index.cultures.includes('de-DE'));
  const gb = load('strings.en-GB.json');
  const de = load('strings.de-DE.json');
  assert.strictEqual(gb['#CalculateTestPlan'], 'Calculate test plan');
  assert.notStrictEqual(de['#CalculateTestPlan'], gb['#CalculateTestPlan']);
  ok('the compiler writes the pilot views and every language');

  const labels = (name, data) => {
    const parts = X.istaXamlParts(load(`${name}.json`));
    const ctx = { strings: gb, declared: parts.resources, data: data || {} };
    return {
      parts,
      bar: X.istaXamlButtons(parts.buttons, ctx).map((b) =>
        b.spacer ? '|' : b.label
      ),
      st: X.istaXamlStatus(parts.status, ctx),
      cols: (table) =>
        table.columns
          .filter((c) => X.istaXamlVisible(c.vis, {}, ctx))
          .map((c) => X.istaXamlEval(c.header, {}, ctx)),
    };
  };

  // Fault memory: the tool's own columns and button row, in its order
  const fm = labels('FaultMemoryView', { IsAirActive: false });
  assert.deepStrictEqual(fm.cols(fm.parts.content[0]), [
    'Code',
    'Description',
    'Mileage',
    'Existent',
    'Class',
  ]);
  assert.deepStrictEqual(fm.bar, [
    'Show fault code',
    'Delete fault memory',
    'Filter fault memory',
    'Delete filter',
    'Show completely',
    '|',
    'Calculate test plan',
  ]);
  assert.deepStrictEqual(
    fm.st.items.map((i) => i.k),
    ['Number of fault memories:', 'No. fault patterns:', 'Filter:']
  );
  ok('FaultMemoryView: columns, button row and status line');

  // Test plan: Priority is a plan column, and the row has Collapse / expand
  const tp = labels('TestPlanView', { IsAirActive: false });
  assert.deepStrictEqual(tp.cols(tp.parts.content[0]), [
    'Type',
    'Title',
    'State',
    'Priority',
  ]);
  assert.deepStrictEqual(tp.bar, [
    'Back',
    'Filters',
    'Show symptoms',
    'Collapse / expand',
    'Set standard filter',
    '|',
    'Display',
  ]);
  assert.deepStrictEqual(
    tp.st.legend.map((l) => l.label),
    ['not called', 'performed', 'minimized', 'canceled', 'suspected']
  );
  assert.deepStrictEqual(
    tp.st.legend.map((l) => l.cls),
    ['none', 'ok', 'warn', 'bad', 'blue']
  );
  ok('TestPlanView: columns, button row and the state legend');

  // Basic Features: three lists, and Undo all / Undo / Accept
  const bf = labels('BasicFeaturesView', { IsWorking: false });
  const lists = [];
  (function walk(n) {
    if (n.columns) lists.push(n);
    (n.kids || []).forEach(walk);
  })({ kids: bf.parts.content });
  assert.deepStrictEqual(
    lists.map((l) => l.a.width),
    ['278', '422', '278']
  );
  assert.deepStrictEqual(bf.bar, ['Undo all', 'Undo', '|', 'Accept']);
  ok('BasicFeaturesView: three lists at 278 / 422 / 278 and its buttons');
  // a converter parameter with commas of its own survives whole
  execFileSync(
    'python3',
    [
      path.join(ROOT, 'tools/ista/xaml_compile.py'),
      '--out',
      out,
      'views/tabs/eculistview.xaml',
      'views/tabs/hitlistview.xaml',
      'views/tabs/vehicledetailsview.xaml',
    ],
    { stdio: 'pipe' }
  );
  const raw = fs.readFileSync(
    path.join(out, 'VehicleDetailsView.json'),
    'utf8'
  );
  assert.ok(raw.includes('"param":"ISTA,ISTA_PLUS,'));
  const el = labels('EcuListView', {
    DefaultEcuStateBarVisibility: true,
    IstaEcuStateBarVisibility: false,
    TeleServiceEcuStateBarVisibility: false,
    Logic: { IndustrialCustomer: { UsesFaultMemory: true } },
  });
  assert.deepStrictEqual(el.cols(el.parts.content[0]), [
    'State',
    'Abbreviation',
    'Control unit name',
  ]);
  assert.deepStrictEqual(el.bar, [
    'Start vehicle test',
    'Call up ECU functions',
    '|',
    'Display fault memory',
  ]);
  assert.deepStrictEqual(
    el.st.legend.map((l) => l.cls),
    ['ok', 'warn', 'bad', 'blue']
  );
  ok('EcuListView: columns, the split button row and the state legend');

  // the hit list has no Priority column and its own button row
  const hl = labels('HitListView', {
    IsAirActive: false,
    IsDocumentExportAllowed: false,
  });
  assert.ok(!hl.cols(hl.parts.content[0]).includes('Priority'));
  assert.deepStrictEqual(hl.bar, [
    'Back',
    'Filters',
    'Show completely',
    '|',
    'Display',
  ]);
  ok('HitListView: no Priority column, Show completely in the row');
  fs.rmSync(out, { recursive: true, force: true });
} else {
  console.log('  SKIP compiler checks: no decompiled layouts under', SRC);
}

console.log(`test_ista_xaml: ${passed} checks passed`);
