#!/usr/bin/env node
// A decoded VIN lands on the catalogue variant it names, and the caption says
// when the CAR was built, not when its type key was introduced.
//
//   node tools/verify/test_etk_identify.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..', '..', 'app', 'renderer');
let passed = 0;
const ok = (m) => {
  passed++;
  if (process.env.V) console.log('  ok', m);
};
const ctx = {
  console,
  window: {},
  document: {
    createElement: () => ({
      style: {},
      classList: { add() {} },
      appendChild() {},
      querySelector: () => null,
      addEventListener() {},
    }),
  },
  esc: (s) => String(s),
};
ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of ['screens/etk/labels.js', 'screens/etk/identify.js'])
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, {
    filename: f,
  });

// the E46 325i variants as the bundle lists them: four type keys of the same
// model, introduced on different months
const variants = [
  {
    key: 'AN37',
    model: '325i M54',
    body: 'Lim',
    motor: 'M54',
    steer: 'L',
    gear: 'N',
    date: 20001001,
  },
  {
    key: 'AV33',
    model: '325i M54',
    body: 'Lim',
    motor: 'M54',
    steer: 'L',
    gear: 'N',
    date: 20000901,
  },
  {
    key: 'ET37',
    model: '325i M54',
    body: 'Lim',
    motor: 'M54',
    steer: 'L',
    gear: 'N',
    date: 20011001,
  },
  {
    key: 'EV33',
    model: '325i M54',
    body: 'Lim',
    motor: 'M54',
    steer: 'L',
    gear: 'N',
    date: 20010901,
  },
  {
    key: 'AZ96',
    model: '325i',
    body: 'Lim',
    motor: 'M54',
    steer: 'L',
    gear: 'N',
    date: 20031101,
  },
];
const hit = {
  chassis: 'E46',
  vin: 'WBAET37495NJ87379',
  pn: 'NJ87379',
  model: '325i M54',
  body: 'Lim',
  motor: 'M54',
  steer: 'L',
  prod: '200409',
};

// THE VIN NAMES THE TYPE KEY: characters 4 to 7 are ET37, and that is the
// variant, whatever the model-and-body tiers would have picked
assert.strictEqual(ctx.etkMatchVariant(variants, hit), 2);
assert.strictEqual(
  ctx.etkMatchVariant(variants, { ...hit, vin: 'WBAAZ96010NJ87379' }),
  4,
  'another type key, another variant'
);
ok("a full VIN's type key picks the variant outright");

// without a full VIN the tiers still work, nearest introduction before the
// build month
assert.strictEqual(
  ctx.etkMatchVariant(variants, { ...hit, vin: undefined }),
  2,
  'ET37 (10/2001) is the last split before 09/2004'
);
assert.strictEqual(
  ctx.etkMatchVariant(variants, { ...hit, vin: 'NJ87379' }),
  2,
  'a bare production number is not a type key'
);
assert.strictEqual(
  ctx.etkMatchVariant(variants, { ...hit, vin: undefined, prod: '200103' }),
  0,
  'a 03/2001 car belongs to the 10/2000 split'
);
assert.strictEqual(ctx.etkMatchVariant([], hit), -1);
ok('without a type key the model tiers and the nearest introduction decide');

// THE CAPTION SAYS WHEN THE CAR WAS BUILT. The variant's own date is its
// introduction; beside a 2004 car "10/2001" read as the car's year.
assert.strictEqual(
  ctx.etkVariantLabel(variants[2]),
  '325i M54 · Lim · M54 · LHD · 10/2001'
);
assert.strictEqual(
  ctx.etkCarLabel(variants[2], hit),
  '325i M54 · Lim · M54 · LHD · built 09/2004'
);
assert.strictEqual(
  ctx.etkCarLabel(variants[2], { prod: 20040915 }),
  '325i M54 · Lim · M54 · LHD · built 09/2004',
  'a day is fine'
);
assert.strictEqual(
  ctx.etkCarLabel(variants[2], {}),
  ctx.etkVariantLabel(variants[2]),
  'no build month: the variant label'
);
assert.strictEqual(
  ctx.etkCarLabel(variants[2], null),
  ctx.etkVariantLabel(variants[2])
);
ok("the caption names the car's build month, not the type key's introduction");

// the picker draws its rows from its own text, so the pre-selected row must
// carry the car's caption or the picker still reads "10/2001" over a 2004 car
const cat = fs.readFileSync(
  path.join(ROOT, 'screens', 'etk', 'catalogue.js'),
  'utf8'
);
const dd = cat.slice(
  cat.indexOf('function buildVariantDropdown'),
  cat.indexOf('makeDropdown({')
);
assert.ok(
  dd.includes('i === ETK_STATE.variant && ETK_STATE.variantLabel'),
  'the pre-selected row uses the car caption'
);
ok("the vehicle picker's selected row reads as the car");

console.log(`test_etk_identify: ${passed} checks passed`);
