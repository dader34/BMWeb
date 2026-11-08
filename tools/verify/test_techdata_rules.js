#!/usr/bin/env node
// The renderer's validity-rule evaluator against its Python twin.
//
// techDataRuleEval (screens/techdata/data.js) and rule_eval
// (tools/ista/validity_rules.py) decide the same documents for the same
// cars: the extractor shards with one, the app filters with the other.
// tools/verify/make_techdata_rules_fixture.py samples real rule trees from
// the wiring index (every leaf kind the corpus has, plus composed document
// rules) and records the Python verdicts for E46 type keys at a few build
// months, as a VIN-identified vehicle and with no vehicle at all. This
// replays every case through the JS evaluator.
//
//   node tools/verify/test_techdata_rules.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..', 'app', 'renderer');
const fixture = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'fixtures', 'techdata-rules.json'),
    'utf8'
  )
);
const aux = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', fixture.rulefacts), 'utf8')
);

const ctx = {
  console,
  window: {},
  WEB_BASE: '',
  TextDecoder,
  fetch: async () => ({ ok: false }),
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(
  fs.readFileSync(path.join(ROOT, 'screens/techdata/data.js'), 'utf8'),
  ctx,
  { filename: 'screens/techdata/data.js' }
);
const evalRule = vm.runInContext('techDataRuleEval', ctx);

const tri = (v) => (v === null ? 'N' : v ? 'T' : 'F');
const cars = fixture.cars.map((c) => ({
  ids: new Set(c.ids),
  roots: new Set(c.roots),
  ym: c.ym,
  built: c.built,
}));

let bad = 0;
const seen = { vehicle: {}, open: {} };
for (const [ri, ci, wantVehicle, wantOpen] of fixture.cases) {
  const rule = fixture.rules[ri];
  const car = cars[ci];
  const vehicle = tri(
    evalRule(rule, car.ids, {
      ym: car.ym,
      built: car.built,
      roots: car.roots,
      level: 3,
      prodart: 'P',
      aux,
      country: '',
    })
  );
  const open = tri(
    evalRule(rule, car.ids, { ym: car.ym, built: car.built, roots: car.roots })
  );
  seen.vehicle[vehicle] = (seen.vehicle[vehicle] || 0) + 1;
  seen.open[open] = (seen.open[open] || 0) + 1;
  if (vehicle !== wantVehicle || open !== wantOpen) {
    bad++;
    if (bad <= 5)
      console.log(
        `  MISMATCH rule ${ri} car ${fixture.cars[ci].key}@${car.ym}: vehicle ${vehicle} (python ${wantVehicle}), open ${open} (python ${wantOpen})\n  ${JSON.stringify(rule).slice(0, 300)}`
      );
  }
}
assert.ok(fixture.cases.length > 1000, 'the fixture carries a real sample');
assert.ok(seen.vehicle.T && seen.vehicle.F, 'both verdicts occur as a vehicle');
assert.ok(seen.open.N, 'the open mode leaves some leaves undecided');
assert.strictEqual(
  bad,
  0,
  `${bad} of ${fixture.cases.length} cases disagree with the Python evaluator`
);
console.log(
  `test_techdata_rules: ${fixture.cases.length} cases over ${fixture.rules.length} rules and ${fixture.cars.length} cars agree with validity_rules.py`
);
