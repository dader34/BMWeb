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

console.log(`test_etk_lines: ${passed} checks passed`);
