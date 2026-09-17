#!/usr/bin/env node
// A parts line's validity: the window, the steering side, the gearbox and the
// condition the catalogue prints -- what the bundle's per-variant `fit` list
// never carried, and why a 2004 E46 was shown the pre-facelift bumper trim
// beside its own. Pure helpers in screens/etk/lines.js.
//
//   node tools/verify/test_etk_lines.js
const assert = require('assert');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const L = require(
  path.join(ROOT, 'app', 'renderer', 'screens', 'etk', 'lines.js')
);
let passed = 0;
const ok = (m) => {
  passed++;
  if (process.env.V) console.log('  ok', m);
};

// THE GROUND TRUTH: E46 diagram 51_3267, callout 03, for VIN ...NJ87379
// (type ET37, built 2004-09). The catalogue: 51 13 8 227 641 up to 09/2001
// for cars with headlight washers; 51 13 7 043 407 from 09/2001, same
// condition; 7 043 409 from 09/2001 without it; 8 208 485 up to 09/2001.
const old = {
  pos: '03',
  sachnr: '8227641',
  ln: [
    { t: 200109, c: 'D', n: 'For vehicles with +Headlight cleaning system' },
  ],
};
const cur = {
  pos: '03',
  sachnr: '7043407',
  ln: [
    { f: 200109, c: 'D', n: 'For vehicles with +Headlight cleaning system' },
  ],
};
const plain = { pos: '03', sachnr: '7043409', ln: [{ f: 200109 }] };
const pre = { pos: '03', sachnr: '8208485', ln: [{ t: 200109 }] };
const car = { prod: 200409, steer: 'L', auto: null };
assert.strictEqual(
  L.etkLineFits(old, car),
  false,
  'the pre-facelift cover is out'
);
assert.strictEqual(L.etkLineFits(cur, car), true, 'the facelift cover is in');
assert.strictEqual(L.etkLineFits(plain, car), true);
assert.strictEqual(L.etkLineFits(pre, car), false);
ok("the user's car gets 7 043 407, not 8 227 641");

// the window is inclusive at both ends
assert.strictEqual(
  L.etkLineFits(old, { prod: 200109 }),
  true,
  'up to 09/2001 includes 09/2001'
);
assert.strictEqual(
  L.etkLineFits(cur, { prod: 200109 }),
  true,
  'from 09/2001 includes 09/2001'
);
assert.strictEqual(L.etkLineFits(old, { prod: 200110 }), false);
assert.strictEqual(L.etkLineFits(cur, { prod: 200108 }), false);
ok('the window is inclusive');

// no month known (a variant picked by hand): the window is not applied
assert.strictEqual(L.etkLineFits(old, { steer: 'L' }), true);
assert.strictEqual(L.etkLineFits(old, {}), true);
assert.strictEqual(L.etkLineFits(old, null), true);
ok('without a build month every window stays open');

// steering and gearbox
const rhd = { ln: [{ s: 'R' }] };
const auto = { ln: [{ a: 'A' }] };
assert.strictEqual(L.etkLineFits(rhd, { steer: 'L' }), false);
assert.strictEqual(L.etkLineFits(rhd, { steer: 'R' }), true);
assert.strictEqual(
  L.etkLineFits(rhd, { steer: null }),
  true,
  'unknown side: open'
);
assert.strictEqual(L.etkLineFits(auto, { auto: 'M' }), false);
assert.strictEqual(L.etkLineFits(auto, { auto: 'A' }), true);
assert.strictEqual(L.etkLineFits(auto, {}), true);
ok('steering side and gearbox lines are for one of each');

// several lines: the part fits when any does; no lines: always
const two = { ln: [{ t: 200109 }, { f: 200303 }] };
assert.strictEqual(L.etkLineFits(two, { prod: 200201 }), false, 'in the gap');
assert.strictEqual(L.etkLineFits(two, { prod: 200409 }), true);
assert.strictEqual(L.etkLineFits({ pos: '01', sachnr: '1' }, car), true);
assert.strictEqual(L.etkLineFits({ ln: [] }, car), true);
ok('a part fits when any of its lines does');

// the sidecar merges onto the bundle's parts by callout and part number;
// inline records win
const tree = {
  maingroups: [
    {
      hg: '51',
      groups: [
        {
          fg: '13',
          diagrams: [
            {
              btnr: '51_3267',
              parts: [
                { pos: '03', sachnr: '8227641' },
                { pos: '03', sachnr: '7043407' },
                { pos: '04', sachnr: '1111111', ln: [{ s: 'L' }] },
                { pos: '05', sachnr: '2222222' },
              ],
            },
          ],
        },
      ],
    },
  ],
};
const side = {
  v: 1,
  ln: {
    '51_3267': {
      '03|8227641': [{ t: 200109 }],
      '03|7043407': [{ f: 200109 }],
      '04|1111111': [{ s: 'R' }],
    },
  },
};
assert.strictEqual(
  L.etkLineKey({ pos: '03', sachnr: '8227641' }),
  '03|8227641'
);
assert.strictEqual(L.etkMergeLines(tree, side), 2);
const parts = tree.maingroups[0].groups[0].diagrams[0].parts;
assert.deepStrictEqual(parts[0].ln, [{ t: 200109 }]);
assert.deepStrictEqual(parts[1].ln, [{ f: 200109 }]);
assert.deepStrictEqual(parts[2].ln, [{ s: 'L' }], 'the inline record wins');
assert.strictEqual(
  parts[3].ln,
  undefined,
  'a part with no line record stays open'
);
assert.strictEqual(L.etkMergeLines(tree, null), 0);
assert.strictEqual(
  L.etkMergeLines(
    {
      groups: [
        { diagrams: [{ btnr: 'x', parts: [{ pos: '1', sachnr: '2' }] }] },
      ],
    },
    { ln: { x: { '1|2': [{ f: 1 }] } } }
  ),
  1,
  'the flat groups shape too'
);
ok('the sidecar lands on the parts, inline records first');

// THE ROWS THE TABLE DRAWS: one per callout and part number, the parts of a
// callout grouped, a part listed on two lines folded into one row that shows
// the line fitting the car, the supplement from the sidecar
{
  const parts = [
    { pos: '01', sachnr: '7519629', name: 'Vibration damper' },
    {
      pos: '01',
      sachnr: '7562509',
      name: 'Vibration damper',
      ln: [{ c: 'C', n: 'For vehicles with +Automatic transmission' }],
    },
    { pos: '02', sachnr: '7570107', name: 'Hub', ln: [{ t: 200903 }] },
    { pos: '02', sachnr: '7570107', name: 'Hub', ln: [{ t: 200903 }] },
    { pos: '02', sachnr: '7593701', name: 'Hub', ln: [{ f: 200903, q: '2' }] },
    { pos: '03', sachnr: '1439395', name: 'Hex Bolt', sup: 'M8X16' },
    { pos: '04', sachnr: '7564511', name: 'ASA-Bolt', ln: [{ q: '6' }] },
  ];
  const rows = L.etkRows(parts, { prod: 201001 });
  assert.deepStrictEqual(
    rows.map((g) => [g.pos, g.name, g.items.length]),
    [
      ['01', 'Vibration damper', 2],
      ['02', 'Hub', 2],
      ['03', 'Hex Bolt', 1],
      ['04', 'ASA-Bolt', 1],
    ]
  );
  assert.strictEqual(
    rows[1].items[0].part.ln.length,
    1,
    'the same line twice folds to one'
  );
  assert.deepStrictEqual(rows[1].items[1].line, { f: 200903, q: '2' });
  assert.deepStrictEqual(rows[3].items[0].line, { q: '6' });
  assert.strictEqual(
    rows[0].items[0].line,
    null,
    'no line record, nothing to show'
  );
  assert.strictEqual(
    rows[0].items[1].line.n,
    'For vehicles with +Automatic transmission'
  );
  ok("the table groups a callout's parts and folds repeated lines");

  // the line shown is the one that fits the car; without a car, the first
  const two = {
    pos: '05',
    sachnr: '1',
    name: 'x',
    ln: [{ t: 200109 }, { f: 200110, q: '3' }],
  };
  assert.deepStrictEqual(L.etkDisplayLine(two, { prod: 200409 }), {
    f: 200110,
    q: '3',
  });
  assert.deepStrictEqual(L.etkDisplayLine(two, { prod: 200001 }), {
    t: 200109,
  });
  assert.deepStrictEqual(L.etkDisplayLine(two, null), { t: 200109 });
  assert.strictEqual(L.etkDisplayLine({ pos: '1', sachnr: '2' }, null), null);
  ok('a row shows the line that fits the car');

  // a group whose parts differ in name takes the first's
  const mixed = L.etkRows(
    [
      { pos: '07', sachnr: '1', name: 'Bolt' },
      { pos: '07', sachnr: '2', name: 'Washer' },
    ],
    null
  );
  assert.strictEqual(mixed[0].name, 'Bolt');
  assert.strictEqual(L.etkMonth(200109), '09/2001');
  assert.strictEqual(L.etkMonth(undefined), '');
  ok('mixed groups and months');

  // the sidecar's supplements land on the parts
  const tree = {
    groups: [
      {
        diagrams: [
          {
            btnr: 'b',
            parts: [
              { pos: '1', sachnr: '7564511' },
              { pos: '2', sachnr: '9', sup: 'kept' },
            ],
          },
        ],
      },
    ],
  };
  L.etkMergeLines(tree, {
    v: 2,
    ln: {},
    sup: { 7564511: 'M8X16', 9: 'not this' },
  });
  assert.strictEqual(tree.groups[0].diagrams[0].parts[0].sup, 'M8X16');
  assert.strictEqual(
    tree.groups[0].diagrams[0].parts[1].sup,
    'kept',
    'an inline supplement wins'
  );
  ok('the Supplement column comes from the sidecar');
}

console.log(`test_etk_lines: ${passed} checks passed`);

// THE PART INFORMATION WINDOW: the i on every part opens what the sidecar's
// pt record knows -- weight, comment, the supersession chain, a set's
// contents, REACH substances -- laid out as a head, a fact grid, the note
// and tables, and only what is known.
{
  const fmt = (s) => `#${s}`;
  const sec = L.etkPartInfoSections(
    { sachnr: '7553142', name: 'Hub', sup: 'M8X16' },
    { n: 'Note Repair Manual', q: '2', k: '+' },
    {
      w: 0.759,
      c: 'black',
      h: 1,
      dn: 'DIN 933',
      e: 200903,
      x: '7553143',
      rep: [['7593701', 'Hub']],
      for: [
        ['7519630', 'Hub'],
        ['7557356', ''],
      ],
      kit: [
        ['7191670', 'Lock set', '1', 1],
        ['6965050', 'Control unit CAS', '2', 0],
      ],
      reach: [['7439-92-1', 'Lead', 3.5, 'Bushing']],
    },
    fmt
  );
  assert.deepStrictEqual(sec.head, { sachnr: '#7553142', name: 'Hub' });
  assert.deepStrictEqual(sec.facts, [
    ['Comment', 'black'],
    ['Supplement', 'M8X16'],
    ['Quantity', '2'],
    ['Weight', '0.759 kg'],
    ['Standard', 'DIN 933'],
    ['Hazardous goods', 'yes'],
    ['Discontinued', '03/2009'],
    ['Exchange part', '#7553143'],
  ]);
  assert.strictEqual(sec.note, 'Note Repair Manual');
  assert.deepStrictEqual(
    sec.tables.map((t) => t.title),
    ['Superseded by', 'Replaces', 'Set contents', 'REACH substances']
  );
  assert.deepStrictEqual(sec.tables[1].rows, [
    ['#7519630', 'Hub'],
    ['#7557356', ''],
  ]);
  assert.deepStrictEqual(sec.tables[2].rows, [
    ['1', '#7191670', 'Lock set', ''],
    ['2', '#6965050', 'Control unit CAS', 'not sold separately'],
  ]);
  assert.deepStrictEqual(sec.tables[3].rows, [
    ['Lead', '7439-92-1', '3.5', 'Bushing'],
  ]);
  ok('the Part information sections carry everything the record knows');

  const bare = L.etkPartInfoSections(
    { sachnr: '1439395', name: 'Hex Bolt' },
    null,
    null
  );
  assert.deepStrictEqual(bare, {
    head: { sachnr: '1439395', name: 'Hex Bolt' },
    facts: [],
    note: '',
    tables: [],
  });
  ok('a part without a record shows its number and name only');
}

// The Kat mark rides on the line like steering and gearbox do, and the
// part records reach the tree once, off the sidecar.
{
  const tree = {
    groups: [{ diagrams: [{ btnr: 'b', parts: [{ pos: '1', sachnr: '9' }] }] }],
  };
  L.etkMergeLines(tree, {
    v: 3,
    ln: { b: { '1|9': [{ k: '+', a: 'A', s: 'L' }] } },
    sup: {},
    pt: { 9: { w: 1.5 } },
  });
  const p = tree.groups[0].diagrams[0].parts[0];
  assert.deepStrictEqual(p.ln, [{ k: '+', a: 'A', s: 'L' }]);
  assert.deepStrictEqual(tree.pt, { 9: { w: 1.5 } });
  const [g] = L.etkRows([p], { prod: null, steer: null, auto: null });
  assert.strictEqual(g.items[0].line.k, '+');
  ok('the Kat mark and the part records come through the sidecar');
}

console.log(`test_etk_lines: ${passed} checks passed (part information)`);
