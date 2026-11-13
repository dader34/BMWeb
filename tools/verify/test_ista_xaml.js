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
  // ...but never the first row: it always takes the plain number
  const lone = X.istaPlanPrioritise([
    { id: 's', component: 'S', state: 'suspected', links: [link('f', 100)] },
  ]);
  assert.strictEqual(lone[0].priority, 3);
  // present is read off the status number where the module reports one
  const pres = (nr, ver, flag) =>
    X.istaFaultPresent({
      raw: { F_VORHANDEN_NR: nr, F_VERSION: ver },
      present: flag,
    });
  assert.strictEqual(pres(0x23, 2), true);
  assert.strictEqual(pres(0x22, 2), true);
  assert.strictEqual(pres(0x21, 2, true), false);
  assert.strictEqual(pres(0x01, 3), true);
  assert.strictEqual(pres(0x41, 3), false);
  assert.strictEqual(pres(0x02, 3), false);
  // the Existent column reads the same number, by protocol
  const ex = (nr, ver, virtual) =>
    X.istaFaultExisting(
      { raw: { F_VORHANDEN_NR: nr, F_VERSION: ver }, virtual },
      { '#YesSmall': 'yes', '#NoSmall': 'No', '#UnknownSmall': 'unknown' }
    );
  assert.strictEqual(ex(35, 2), 'yes');
  assert.strictEqual(ex(33, 2), 'No');
  assert.strictEqual(ex(33, 3), 'yes');
  assert.strictEqual(ex(32, 3), 'No');
  assert.strictEqual(ex(99, 2), 'unknown');
  // a module that reports no status number (the oldest protocol) is unknown
  assert.strictEqual(ex('', ''), 'unknown');
  assert.strictEqual(ex('', '', true), 'yes');
  // with no status number, the text the table shows decides
  assert.strictEqual(X.istaFaultPresent({ raw: {}, present: true }), true);
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

// ---- the plan, from the tool's own links --------------------------------------
{
  const data = {
    faults: {
      'ms450ds0:10179': [1],
      'ms450ds0:300': [2],
      'dsc_mk60:5': [1, 3],
    },
    objects: {
      1: { t: 'Oil level sensor', i: [10, 11, 12] },
      // no test module of its own: the calculation descends
      2: { t: 'Lambda control', i: [13], k: [4] },
      3: { t: '', i: [14] },
      4: { t: 'Lambda probe', i: [15] },
    },
    infos: {
      10: { t: 'Oil level warning', y: 'FUB', n: 'FUB-1' },
      11: { t: 'Oil level', y: 'SSP', n: 'SSP-1' },
      12: { t: 'Oil level sensor', y: 'ABL', n: 'ABL-DIT-B1214' },
      13: { t: 'Lambda control', y: 'FUB', n: 'FUB-2' },
      14: { t: 'Untitled object', y: 'ABL', n: 'ABL-X' },
      15: { t: 'Lambda probe', y: 'ABL', n: 'ABL-DIT-L1' },
    },
  };
  const fault = (sgbd, ort, weight) => ({
    sgbd,
    code: ort.toString(16).toUpperCase(),
    raw: { F_ORT_NR: String(ort) },
    meta: { known: true, relevance: true, weight },
  });
  const rows = X.istaPlanExact(data, [
    fault('ms450ds0', 10179, 50),
    fault('ms450ds0', 300, 100),
    fault('dsc_mk60', 5, 25),
    fault('ms450ds0', 99999, 100),
  ]);
  const ids = rows.map((r) => `${r.component}/${r.type}/${r.id}`);
  // every info object of the object joins the plan, documents included
  assert.deepStrictEqual(ids.slice(0, 3), [
    'Oil level sensor/FUB/DIAG-10',
    'Oil level sensor/SSP/DIAG-11',
    'Oil level sensor/ABL/ABL-DIT-B1214',
  ]);
  // an object with no test module: its children first, then its own rows
  assert.deepStrictEqual(ids.slice(3), [
    'Lambda probe/ABL/ABL-DIT-L1',
    'Lambda control/FUB/DIAG-13',
  ]);
  // an untitled object is skipped; an unknown fault adds nothing
  assert.ok(!ids.some((i) => i.includes('ABL-X')));
  // one row however many faults lead to it, each fault remembered
  const abl = rows.find((r) => r.id === 'ABL-DIT-B1214');
  assert.deepStrictEqual(
    abl.links.map((l) => l.fault),
    ['ms450ds0:10179', 'dsc_mk60:5']
  );
  // a child reached by descent carries no fault of its own
  assert.strictEqual(rows.find((r) => r.id === 'ABL-DIT-L1').links.length, 0);
  // a document row opens from the structure, a module by its identifier
  assert.deepStrictEqual(rows[0].diag, {
    id: 10,
    title: 'Oil level warning',
    type: 'FUB',
  });
  assert.strictEqual(abl.diag, null);
  const ranked = X.istaPlanPrioritise(rows);
  const prio = Object.fromEntries(ranked.map((r) => [r.component, r.priority]));
  // sure suspicion first, then the middle+low object, then the descended one
  assert.strictEqual(prio['Lambda control'], 3);
  assert.strictEqual(prio['Oil level sensor'], 4);
  assert.strictEqual(prio['Lambda probe'], 5);
  ok('the exact plan: documents, descent, one row per object and document');

  // a fault pattern goes through the same objects, and always descends
  const withSymptoms = {
    ...data,
    symptoms: { 500: [1], 501: [2] },
    trees: [
      {
        id: 9,
        label: 'Fault patterns',
        vfc: 'RootOld',
        kids: [
          {
            id: 500,
            label: 'Oil warning',
            kids: [{ id: 501, label: 'Lambda' }],
          },
        ],
      },
    ],
  };
  const map = new Map();
  for (const r of X.istaPlanExact(withSymptoms, [fault('ms450ds0', 10179, 50)]))
    map.set(r.key, r);
  X.istaPlanPatternsExact(
    withSymptoms,
    [{ id: 500, label: 'Oil warning' }],
    map
  );
  const got = [...map.values()];
  // the object the fault had already named is the pattern's too: it is F now
  assert.ok(
    got.filter((r) => r.group === '1').every((r) => r.priority === 'F')
  );
  assert.strictEqual(got.filter((r) => r.group === '1').length, 3);
  // the symptom beneath the picked one is collected, and its object descended
  assert.deepStrictEqual(
    got
      .filter((r) => r.group !== '1')
      .map((r) => `${r.component}/${r.id}/${r.priority}`),
    ['Lambda control/DIAG-13/F', 'Lambda probe/ABL-DIT-L1/F']
  );
  // F is never renumbered by the ranking
  assert.ok(X.istaPlanPrioritise(got).every((r) => r.priority === 'F'));
  // the tree's root is a heading, never a pattern
  const tn = X.istaPatternNodes(withSymptoms.trees, true);
  assert.strictEqual(tn[0].IsSelectable, false);
  assert.strictEqual(tn[0].Children[0].IsSelectable, true);
  ok('fault patterns: same objects, full descent, priority F on the object');

  // the car's own validity check narrows what the chassis extract kept
  const ruled = {
    faults: { 'ms450ds0:1': [1], 'ms450ds0:2': [1] },
    faultRules: { 'ms450ds0:2': 'no' },
    objects: {
      1: { t: 'Obj', i: [10, 11], r: 'yes' },
      2: { t: 'Out', i: [10], r: 'no' },
    },
    infos: {
      10: { t: 'For M54', y: 'ABL', n: 'ABL-A', r: 'yes' },
      11: { t: 'For N42', y: 'ABL', n: 'ABL-B', r: 'no' },
    },
  };
  const check = (rule) => rule !== 'no';
  const kept = X.istaPlanExact(
    ruled,
    [fault('ms450ds0', 1, 50), fault('ms450ds0', 2, 50)],
    check
  );
  // the info object ruled out for this car is gone; so is the fault whose
  // own rule says no, which would otherwise have been a second link
  assert.deepStrictEqual(
    kept.map((r) => r.id),
    ['ABL-A']
  );
  assert.strictEqual(kept[0].links.length, 1);
  ruled.faults['ms450ds0:1'] = [2];
  assert.strictEqual(
    X.istaPlanExact(ruled, [fault('ms450ds0', 1, 50)], check).length,
    0
  );
  ok("the car's rules: an object, a document or a fault link can drop out");
}

// ---- fault patterns ----------------------------------------------------------
{
  const tree = [
    {
      id: 1,
      label: '01 Powertrain',
      sel: 0,
      kids: [
        {
          id: 2,
          label: 'Engine noise',
          docs: [{ id: 10, title: 'Noise check', type: 'ABL' }],
          kids: [
            {
              id: 3,
              label: 'Noise when cold',
              docs: [
                { id: 11, title: 'Cold start', type: 'FUB' },
                { id: 10, title: 'Noise check', type: 'ABL' },
              ],
            },
          ],
        },
        { id: 4, label: 'Engine noise group', sel: 0, kids: [] },
      ],
    },
  ];
  const nodes = X.istaPatternNodes(tree);
  // SELECTABLE = 0 is a heading; everything else can be picked
  assert.strictEqual(nodes[0].IsSelectable, false);
  assert.strictEqual(nodes[0].Children[0].IsSelectable, true);
  const found = X.istaPatternSearch(nodes, 'NOISE');
  // the path to every match is opened, but only pickable matches count
  assert.deepStrictEqual([...found.open].sort(), [1, 2]);
  assert.strictEqual(found.hits, 2);
  assert.strictEqual(found.first.id, 2);
  assert.strictEqual(X.istaPatternSearch(nodes, '').hits, 0);
  ok('the symptom tree: which nodes can be picked, and the search');

  // the patterns live with the operation, one list per car
  global.istaState = global.istaState || {};
  const mine = X.istaPatterns({ id: 'car-a' });
  mine.push({ id: 2, label: 'Engine noise', node: tree[0].kids[0] });
  assert.strictEqual(X.istaPatterns({ id: 'car-a' }).length, 1);
  assert.strictEqual(X.istaPatterns({ id: 'car-b' }).length, 0);
  ok('fault patterns are kept per car');
}

// ---- the control unit tree, built as the tool builds it ----------------------
{
  const tree = {
    series: 'T',
    ecus: [],
    buses: [
      {
        bus: 'KBUS',
        col: 1,
        minRow: 0,
        maxRowLimit: -1,
        paintToRoot: true,
        connectOnlyRight: false,
        vertical: true,
        horizontal: true,
        x: 0,
        y: 0,
      },
      {
        bus: 'FACAN',
        col: 3,
        minRow: 0,
        maxRowLimit: -1,
        paintToRoot: true,
        connectOnlyRight: false,
        vertical: true,
        horizontal: true,
        x: 0,
        y: 0,
      },
      {
        bus: 'MOST',
        col: 5,
        minRow: 1,
        maxRowLimit: -1,
        paintToRoot: false,
        connectOnlyRight: false,
        vertical: true,
        horizontal: true,
        x: 0,
        y: 0,
        req: [0x63],
      },
    ],
    links: [{ bus: 'MOST', x1: 4, y1: 1.5, x2: 5, y2: 1.5, req: [99] }],
    housings: [{ col: 0, row: 1, count: 2, req: [1, 2] }],
    busNames: { FACAN: 'PT-CAN' },
  };
  const u = (name, addr, bus, col, row, state) => ({
    name,
    addr,
    bus,
    col,
    row,
    state: state || 'ok',
  });
  const units = [
    u('KOMBI', 128, 'ROOT', 2, 0),
    u('ZKE', 1, 'KBUS', 0, 1),
    u('IHKA', 2, 'KBUS', 0, 2, 'faults'),
    u('RADIO', 3, 'KBUS', 1, 3, 'silent'),
    u('DME', 18, 'FACAN', 3, 1, 'unread'),
    u('LOST', 77, 'KBUS', -1, -1),
    u('GHOST', 78, 'VIRTUAL', 4, 4),
  ];
  const built = X.ecuTreeBuild(tree, units);
  const seg = (l) => `${l.bus} ${l.x1},${l.y1} ${l.x2},${l.y2}`;
  const lines = built.lines.map(seg);
  // the K-bus column: a vertical from the root's row down to its lowest
  // unit, a run across to the root, and a stub to each unit either side
  assert.ok(lines.includes('KBUS 1,0.3 1,3.5'));
  assert.ok(lines.includes('KBUS 1,0.3 2.5,0.3'));
  assert.ok(lines.includes('KBUS 1,1.5 0.5,1.5'));
  assert.ok(lines.includes('KBUS 1,2.5 0.5,2.5'));
  assert.ok(lines.includes('KBUS 1,3.5 1.5,3.5'));
  // a bus on the root's other side starts from the other fan
  assert.ok(lines.includes('FACAN 3,0.7 3,1.5'));
  assert.ok(lines.includes('FACAN 3,0.7 2.5,0.7'));
  // a bus whose address rule fails draws nothing, nor does its link
  assert.ok(!lines.some((l) => l.startsWith('MOST')));
  // a housing frames its units when they are all fitted
  assert.deepStrictEqual(built.housings, [{ col: 0, row: 1, count: 2 }]);
  // the legend names each bus that drew a line, by the series' own name
  assert.deepStrictEqual(
    built.legend.map((l) => `${l.name} ${l.color}`),
    ['KBUS #000000', 'PT-CAN #ffcc00']
  );
  // a unit with no cell is parked in the spare row; a virtual one is not drawn
  const lost = built.units.find((x) => x.name === 'LOST');
  assert.deepStrictEqual([lost.col, lost.row], [0, 14]);
  assert.ok(!built.units.some((x) => x.name === 'GHOST'));
  assert.strictEqual(built.rows, 15);
  ok('the tree: bus columns, the fan at the root, rules, housings, legend');

  // the address rule's operators
  const fitted = [
    { addr: 1, bus: 'KBUS' },
    { addr: 2, bus: 'KBUS' },
  ];
  const rule = (r) => X.ecuTreeCheckRule(fitted, r, 'KBUS', tree);
  assert.strictEqual(rule(undefined), true);
  assert.strictEqual(rule([1, 2]), true);
  assert.strictEqual(rule([1, 9]), false);
  // OR (1): either is enough
  assert.strictEqual(rule([0x10000 | 9, 0x10000 | 2]), true);
  // NOT (128): the unit must be absent
  assert.strictEqual(rule([0x800000 | 9]), true);
  assert.strictEqual(rule([0x800000 | 1]), false);
  // bus count (2): between low and high units on the bus
  assert.strictEqual(rule([0x20000 | (5 << 8) | 2]), true);
  assert.strictEqual(rule([0x20000 | (5 << 8) | 3]), false);
  ok('the address rule: and, or, not, and the bus count');

  // what a colour means
  assert.strictEqual(X.ecuTreeUnitColor({ state: 'ok' }), '#008000');
  assert.strictEqual(X.ecuTreeUnitColor({ state: 'faults' }), '#c39f0d');
  assert.strictEqual(X.ecuTreeUnitColor({ state: 'silent' }), '#a52a2a');
  assert.strictEqual(X.ecuTreeUnitColor({ state: 'unread' }), '#a9a9a9');
  assert.strictEqual(
    X.ecuTreeUnitColor({ state: 'ok', abort: true }),
    '#4169e1'
  );

  // the units a car is expected to carry, from its options
  const e46 = { series: 'E46', minimal: [0, 128], excluded: [154], compat: [] };
  const facts = (sa, over) => ({
    sa: new Set(sa),
    motor: 'M54',
    typ: 'ET37',
    prod: 200409,
    absOnly: false,
    ...over,
  });
  // a car with no known options is run with none: the minimal units and
  // the engine, nothing that hangs on an option
  const bare = X.ecuTreeExpected(e46, facts([]));
  assert.deepStrictEqual(
    [...bare].sort((x, y) => x - y),
    [0, 18, 87, 128]
  );
  assert.strictEqual(X.ecuTreeExpected(null, facts([])), null);
  const want = X.ecuTreeExpected(e46, facts(['534', '205', '403']));
  // the engine, the automatic gearbox, climate control and the sunroof
  for (const a of [18, 50, 91, 8, 87, 0, 128])
    assert.ok(want.has(a), `expects ${a}`);
  assert.ok(!want.has(114));
  // a manual car has no gearbox unit
  assert.ok(!X.ecuTreeExpected(e46, facts(['534'])).has(50));
  // a compatibility line adds its unit for the right type key and options
  const withLine = {
    ...e46,
    compat: ['5B;D_005B;ET37 EV53;534&-520;;012000;122005'],
  };
  assert.ok(X.ecuTreeExpected(withLine, facts(['534'])).has(0x5b));
  ok('colours, and the units a car is expected to carry');

  // the text on a unit's button
  const names = {
    variants: { lsz: 'LSZ', zke5: 'GM' },
    groups: {
      d_0000: [['GM']],
      d_zke_gm: [['GM']],
      d_00d0: [['LCM'], ['LM'], ['LSZ']],
      d_motor: [
        ['DME', { petrol: true }],
        ['DDE', { petrol: false }],
      ],
    },
  };
  const title = (v) => X.ecuTreeTitle(names, v);
  // every candidate variant agrees: the representative's name
  assert.strictEqual(
    title({ name: 'ZKE', addr: 0, groups: ['d_0000', 'D_ZKE_GM'] }),
    'GM'
  );
  // candidates disagree: the series' name with the address
  assert.strictEqual(
    title({ name: 'LM', addr: 208, groups: ['d_00d0'] }),
    'LM_0xD0'
  );
  // identified: its own variant decides
  assert.strictEqual(
    title({ name: 'LM', addr: 208, groups: ['d_00d0'], variant: 'LSZ' }),
    'LSZ'
  );
  // the car's own rules narrow the candidates to one
  const dme = { name: 'DME', addr: 18, groups: ['d_motor'] };
  assert.strictEqual(title(dme), 'DME_0x12');
  assert.strictEqual(
    X.ecuTreeTitle(names, dme, (r) => !r || r.petrol),
    'DME'
  );
  // the app's plain form leaves the address off
  assert.strictEqual(X.ecuTreeTitle(names, dme, null, true), 'DME');
  // no candidates at all, and a one-digit address
  assert.strictEqual(title({ name: 'SHD', addr: 8, groups: [] }), 'SHD_0x08');
  // without the name data the series' name stands
  assert.strictEqual(X.ecuTreeTitle(null, { name: 'LM', addr: 208 }), 'LM');

  // one-of sets: an identified member removes the ones that are not
  const shape = (us, t) => X.ecuTreeShape(t, us).map((x) => x.addr);
  const oneOf = { xor: [[41, 86, 54]], unsure: [7] };
  assert.deepStrictEqual(
    shape([{ addr: 41, identified: true }, { addr: 86 }, { addr: 9 }], oneOf),
    [41, 9]
  );
  // nothing identified yet: both stay
  assert.deepStrictEqual(shape([{ addr: 41 }, { addr: 86 }], oneOf), [41, 86]);
  // a unit the series is unsure of stays only when it identified
  assert.deepStrictEqual(shape([{ addr: 7 }, { addr: 9 }], oneOf), [9]);
  assert.deepStrictEqual(shape([{ addr: 7, identified: true }], oneOf), [7]);

  // the second unit of a cell is parked beside the ones with no cell
  const two = X.ecuTreeBuild({ buses: [] }, [
    u('A', 1, 'KBUS', 3, 2),
    u('B', 2, 'KBUS', 3, 2),
    u('C', 3, 'KBUS', -1, -1),
  ]);
  assert.deepStrictEqual(
    two.units.map((x) => [x.name, x.col, x.row]),
    [
      ['A', 3, 2],
      ['B', 0, 14],
      ['C', 1, 14],
    ]
  );

  // the units a K-bus car might carry: each listed group whose rule holds,
  // found in the table by a substring of the unit's joined group names
  const table = {
    ecus: [
      { addr: 0, groups: ['d_0000', 'd_zke_gm'] },
      { addr: 114, groups: ['d_0072', 'd_0072b'] },
      { addr: 156, groups: ['d_009c'] },
    ],
  };
  const list = [
    { g: 'd_zke_gm' },
    { g: 'D_0072' },
    { g: 'd_009c', r: { no: true } },
    { g: 'd_nowhere' },
  ];
  assert.deepStrictEqual(
    [...X.ecuTreePossible(table, list, (r) => !r)],
    [
      [0, ['d_zke_gm']],
      [114, ['d_0072']],
    ]
  );
  assert.deepStrictEqual(
    [...X.ecuTreePossible(table, list, () => true).keys()],
    [0, 114, 156]
  );
  assert.strictEqual(X.ecuTreePossible(table, undefined, () => true).size, 0);
  ok('unit titles, one-of sets, and parking, and the possible units');
}

// ---- the structure browser ------------------------------------------------
{
  // the two arrows resize: left gives the list the width, right the tree,
  // and each undoes the other (ResizeLeft / ResizeRight)
  assert.strictEqual(X.istaBrowseLeft('both'), 'list');
  assert.strictEqual(X.istaBrowseLeft('tree'), 'both');
  assert.strictEqual(X.istaBrowseLeft('list'), null);
  assert.strictEqual(X.istaBrowseRight('both'), 'tree');
  assert.strictEqual(X.istaBrowseRight('list'), 'both');
  assert.strictEqual(X.istaBrowseRight('tree'), null);
  // a source's tree as the control's nodes: the id is the path
  const nodes = X.istaBrowseNodes([
    {
      id: 11,
      num: '11',
      label: 'Engine',
      kids: [{ id: 1100, label: 'Engine' }],
    },
    { id: 'x', label: '' },
  ]);
  assert.deepStrictEqual(
    nodes.map((n) => [n.id, n.Title]),
    [
      ['11', '11 Engine'],
      ['x', ''],
    ]
  );
  assert.strictEqual(nodes[0].Children[0].id, '11/1100');
  assert.deepStrictEqual(nodes[0].Children[0].path, ['11', '1100']);

  // a view that only frames one nested view is split in the nested grid
  const frame = {
    root: {
      t: 'UserControl',
      kids: [
        {
          t: 'Grid',
          rows: ['*', 'Auto'],
          kids: [
            {
              t: 'Inner',
              a: { row: '0' },
              kids: [
                {
                  t: 'Grid',
                  rows: ['*', 'Auto', 'Auto'],
                  kids: [
                    { t: 'Grid', a: { row: '0' }, kids: [{ t: 'TreeView' }] },
                    { t: 'Grid', a: { row: '1' }, kids: [{ t: 'Label' }] },
                    { t: 'Grid', a: { row: '2' }, kids: [{ t: 'Button' }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };
  const outer = X.istaXamlParts(frame);
  assert.deepStrictEqual(
    [outer.content.length, outer.status.length, outer.buttons.length],
    [1, 0, 0]
  );
  const inner = X.istaXamlParts(frame, { inner: true });
  assert.deepStrictEqual(
    [inner.content.length, inner.status.length, inner.buttons.length],
    [1, 1, 1]
  );
  ok('the structure browser: resize steps, nodes, and the inner skeleton');
}

// ---- the tool's own trees ---------------------------------------------------
{
  // the type filter: the page's list holds the type, or it passes all
  assert.strictEqual(X.istaInfoTypeOk('SBS,SWZ,MSM,SWS', 'SWZ'), true);
  assert.strictEqual(X.istaInfoTypeOk('SBS,SWZ,MSM,SWS', 'REP'), false);
  assert.strictEqual(X.istaInfoTypeOk(null, 'REP'), true);
  assert.strictEqual(X.istaInfoTypeOk('SBS', ''), true);
  // the tool's defaults: special tools are not in the product page's list,
  // and the two workshop pages share one list
  assert.ok(!X.ISTA_INFO_TYPES.default.includes('SWZ'));
  assert.ok(X.ISTA_INFO_TYPES.default.includes('AZD'));
  assert.strictEqual(X.ISTA_INFO_TYPES.workshop, 'SBS,SWZ,MSM,SWS');
  assert.strictEqual(X.ISTA_INFO_TYPES.mobile, null);

  // a node the car's rule excludes is not shown, nor anything under it
  const holds = (r) => !r || r.yes === true;
  const extract = [
    {
      id: 11,
      t: '11 Engine',
      d: [1, 2],
      k: [
        { id: 1100, t: '1100 Engine', d: [2, 3] },
        { id: 1128, t: '1128 Belt', r: { yes: false }, d: [4] },
      ],
    },
    { id: 28, t: '28 DKG', r: { yes: false }, k: [{ id: 2800, t: 'x' }] },
  ];
  const nodes = X.istaInfoNodes(extract, holds);
  assert.deepStrictEqual(
    nodes.map((n) => [n.id, n.label, n.kids.map((k) => k.id)]),
    [['11', '11 Engine', ['1100']]]
  );
  // a node lists its own documents and those of every shown child, each
  // once, less the ones the car's rule excludes
  const docs = {
    1: ['REP', 'one'],
    2: ['TED', 'two'],
    3: ['SWZ', 'three', { yes: false }],
    4: ['REP', 'under a hidden node'],
  };
  assert.deepStrictEqual(
    X.istaInfoDocsUnder(nodes[0], docs, holds).map((d) => [d.id, d.type]),
    [
      ['1', 'REP'],
      ['2', 'TED'],
    ]
  );
  // a source over the tree lists by path
  const src = X.istaInfoSource(
    { trees: { product: extract }, docs },
    'product',
    holds,
    'E46'
  );
  assert.deepStrictEqual(
    src.list(['11', '1100']).map((d) => d.id),
    ['2']
  );
  assert.deepStrictEqual(src.list(['28']), []);

  // the Filters dialog: Select all and Select nothing switch the tool's
  // user selection, which leaves special tools as they were
  const on = new Set(['SWZ', 'REP']);
  X.istaInfoFilterSet(on, false);
  assert.deepStrictEqual([...on], ['SWZ']);
  X.istaInfoFilterSet(on, true);
  assert.strictEqual(on.size, 20);
  // Default settings: everything but special tools; the fault pattern
  // page's is SIT and ABL alone
  const def = X.istaInfoFilterDefault(false);
  assert.strictEqual(def.size, 19);
  assert.ok(!def.has('SWZ'));
  assert.deepStrictEqual([...X.istaInfoFilterDefault(true)].sort(), [
    'ABL',
    'SIT',
  ]);
  // a filter is the default when it ticks what the page started with
  const start = X.ISTA_INFO_TYPES.default;
  assert.ok(X.istaInfoFilterSame([...def].join(','), start));
  assert.ok(!X.istaInfoFilterSame(`${start},SWZ`, start));
  // on a workshop page Default settings is NOT the page's starting filter
  assert.ok(
    !X.istaInfoFilterSame([...def].join(','), X.ISTA_INFO_TYPES.workshop)
  );
  // the dialog offers twenty types, the page's nineteen and special tools
  assert.strictEqual(X.ISTA_INFO_DIALOG_TYPES.length, 20);
  ok("the tool's trees: type filter, validity, documents, the dialog");
}

// ---- text search --------------------------------------------------------------
{
  // FormatSearchTerms: illegal characters out, split on spaces, upper case
  assert.deepStrictEqual(X.istaSearchTerms("  oil  'filter' (m54);  "), [
    'OIL',
    'FILTER',
    'M54',
  ]);
  assert.deepStrictEqual(X.istaSearchTerms('   '), []);
  // each term stands for its synonyms too
  const syn = { FILTER: ['Strainer'] };
  const variants = X.istaSearchVariants(['OIL', 'FILTER'], syn);
  assert.deepStrictEqual(variants, [['OIL'], ['STRAINER', 'FILTER']]);
  // a title must hold every term, by itself or by a synonym
  assert.ok(X.istaSearchHolds('Oil pump with strainer', variants));
  assert.ok(!X.istaSearchHolds('Air filter', variants));

  const holds = (r) => !r || r.yes === true;
  const index = {
    rules: [{ yes: false }, { yes: true }],
    docs: [
      [1, 'REP', 'Replacing oil filter', 'REP-1', '', -1],
      [2, 'REP', 'Oil filter, other engine', 'REP-2', '', 0],
      [3, 'SWZ', 'Oil filter wrench', 'SWZ-3', '11 9 240', 1],
      [4, 'FKB', 'Oil filter', 'FKB-4', '', -1],
      [5, 'TED', 'Brakes', 'TED-119', '', -1],
    ],
  };
  const run = (text, modes, types) =>
    X.istaSearchRun({
      text,
      modes: { title: false, number: false, structure: false, ...modes },
      index,
      trees: {
        trees: {
          product: [{ id: 11, t: 'Oil filter housing', d: [9], k: [] }],
        },
        docs: { 9: ['ABL', 'Check oil pressure'] },
      },
      synonyms: {},
      holds,
      types: types === undefined ? null : types,
    }).hits.map((h) => h.id);
  // by title: valid for the car, and not of a type the tool never lists
  assert.deepStrictEqual(run('oil filter', { title: true }), ['1', '3']);
  // the page's filter decides which types the hit list shows
  assert.deepStrictEqual(run('oil filter', { title: true }, 'REP,TED'), ['1']);
  // by number: the document number or a special tool's number, any term
  assert.deepStrictEqual(run('119', { number: true }), ['5']);
  assert.deepStrictEqual(run('240 zzz', { number: true }), ['3']);
  // by structure: every document under a node whose title answers
  assert.deepStrictEqual(run('oil filter', { structure: true }), ['9']);
  // nothing typed finds nothing
  assert.deepStrictEqual(run('  ', { title: true }), []);
  // the search stops where it is told to, and says it did
  const capped = X.istaSearchRun({
    text: 'oil',
    modes: { title: true, number: false, structure: false },
    index,
    trees: null,
    synonyms: {},
    holds,
    types: null,
    max: 1,
  });
  assert.strictEqual(capped.hits.length, 1);
  assert.strictEqual(capped.exceeded, true);

  // "Search in document": a shard is word -> first place, then the gaps
  const shard = { conrod: [2, 3], conrods: [9], connect: [1], bolt: [5, 4] };
  assert.deepStrictEqual(
    [...X.istaSearchWordDocs(shard, 'conrod')].sort((a, b) => a - b),
    [2, 5, 9]
  );
  assert.strictEqual(X.istaSearchWordDocs(null, 'x').size, 0);
  // every term must answer; a synonym of several words needs all of them
  const docsOf = (w) => X.istaSearchWordDocs(shard, w);
  const join = (v) => {
    const got = X.istaSearchContentJoin(v, docsOf);
    return got ? [...got].sort((a, b) => a - b) : got;
  };
  assert.deepStrictEqual(join([['CONROD'], ['BOLT']]), [5, 9]);
  assert.deepStrictEqual(join([['NOTHING', 'CONROD']]), [2, 5, 9]);
  // a synonym of several words: the earlier words whole, the last a prefix
  const docsOf2 = (w, whole) => X.istaSearchWordDocs(shard, w, whole);
  const join2 = (v) =>
    [...(X.istaSearchContentJoin(v, docsOf2) || [])].sort((a, b) => a - b);
  assert.deepStrictEqual(join2([['CONNECT BOLT']]), []);
  assert.deepStrictEqual(join2([['CONROD BOLT']]), [5]);
  assert.deepStrictEqual(join2([['CONRODS BOLT']]), [9]);
  assert.deepStrictEqual(join2([['BOLT CONROD']]), [5, 9]);
  // a term of one character is a prefix like any other: here it finds the
  // words beginning with "c", and then narrows as every term does
  assert.deepStrictEqual(join([['C'], ['BOLT']]), [5, 9]);
  assert.deepStrictEqual(join([['Z'], ['BOLT']]), []);
  // a term that is all punctuation has nothing to look up, and does not
  // narrow; a search of nothing but such terms is no search
  assert.deepStrictEqual(join([['--'], ['BOLT']]), [5, 9]);
  assert.strictEqual(join([['--']]), null);
  // a term is lower-cased whole, then split as the tool's tokenizer
  // splits: runs of letters and digits, and of anything above ASCII
  assert.deepStrictEqual(X.istaSearchWords('11 9 240/Öl-FILTER_a'), [
    '11',
    '9',
    '240',
    'öl',
    'filter',
    'a',
  ]);
  // which file a word is looked up in
  assert.strictEqual(X.istaSearchShardOf('oil'), 'oi');
  assert.strictEqual(X.istaSearchShardOf('öl'), '__');
  assert.strictEqual(X.istaSearchShardOf('a'), '1a');
  assert.strictEqual(X.istaSearchShardOf('ö'), '1_');
  // the one-character list is filed under the empty word
  assert.deepStrictEqual(
    [...X.istaSearchWordDocs({ '': [3, 2] }, 'a')].sort((x, y) => x - y),
    [3, 5]
  );
  // a body hit is a hit like any other: checked against the car and type
  assert.deepStrictEqual(
    X.istaSearchRun({
      text: 'whatever',
      modes: { title: false, number: false, structure: false, content: true },
      content: new Set(['2', '5', '4']),
      index,
      trees: null,
      synonyms: {},
      holds,
      types: null,
    }).hits.map((h) => h.id),
    ['5']
  );
  ok('text search: terms, synonyms, the checks, the cap, and the body index');
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
