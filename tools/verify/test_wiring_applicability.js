#!/usr/bin/env node
// The wiring VIN filter evaluates ISTA's own rule trees.
//
// The index used to be a bag of ids scraped off each rule blob, so a rule
// reading "NOT engine M54" shipped as engine {M54} and hid the diagram from
// the one car it was for. The index now ships the decoded trees and the app
// evaluates them three-valued against the decoded VIN: true shows, false
// hides, a leaf the car has no fact for keeps the diagram.
//
//   node tools/verify/test_wiring_applicability.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..', 'app', 'renderer');
let passed = 0;
const ok = (what) => {
  passed++;
  if (process.env.V) console.log('  ok', what);
};

const CHASSIS = 53088651;
const ENGINE = 53363595;
const BODY = 53046411;
const STEER = 53508235;
const eq = (root, val) => ({ op: 'eq', root, val });

// the car table: E46 with M54 or M52, saloon, left- or right-hand drive
const typekeys = {
  ET37: { [CHASSIS]: [900], [ENGINE]: [901], [BODY]: [910], [STEER]: [920] },
  ET47: { [CHASSIS]: [900], [ENGINE]: [902], [BODY]: [910], [STEER]: [921] },
};
const chars = {
  900: 'E46',
  901: 'M54',
  902: 'M52',
  910: 'LIM',
  920: 'LL',
  921: 'RL',
};
const rules = {
  // NOT M54, on an E46
  1: {
    op: 'and',
    kids: [eq(CHASSIS, 900), { op: 'not', kids: [eq(ENGINE, 901)] }],
  },
  // left-hand drive only
  2: eq(STEER, 920),
  // an ancestor gated to M52
  3: eq(ENGINE, 902),
  // an ancestor gated to M54
  4: eq(ENGINE, 901),
};
const index = {
  version: 2,
  roots: { chassis: CHASSIS, engine: ENGINE, body: BODY },
  rules,
  sp: {
    SP1: { r: '1' },
    SP2: { r: '2' },
    SP3: { r: '2', p: [['3'], ['4']] },
    SP4: { r: '1', p: [['4']] },
    SP5: { u: 1 },
    SP6: {},
  },
};

const ctx = {
  console,
  window: {},
  WEB_BASE: '',
  TextDecoder,
  fetch: async () => ({
    ok: true,
    arrayBuffer: async () =>
      new TextEncoder().encode(JSON.stringify(index)).buffer,
  }),
  hfFetchFirst: async (rel) =>
    rel.includes('typekeys')
      ? typekeys
      : rel.includes('characteristics')
        ? chars
        : null,
};
ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of ['screens/techdata/data.js', 'screens/wiring/applicability.js'])
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, {
    filename: f,
  });
const A = ctx.window.wiringApplicability;

(async () => {
  const m54 = { chassis: 'E46', motor: 'M54', body: 'Lim' };
  const m52 = { chassis: 'E46', motor: 'M52', body: 'Lim' };
  assert.strictEqual(
    A.match('SP1', m54),
    'neutral',
    'nothing hides before the index loads'
  );
  await A.load(m54);
  assert.ok(A.ready());

  // NOT is NOT: the M54 car is the one the diagram excludes
  assert.strictEqual(A.match('SP1', m54), 'off');
  assert.strictEqual(A.match('SP1', m52), 'match');
  ok(
    'a "not M54" rule hides the diagram from the M54 car and shows it to the M52'
  );

  // a production number names chassis, engine and body: a steering leaf is
  // undecided, and the diagram stays; a full VIN's type key decides it
  assert.strictEqual(A.match('SP2', m54), 'neutral');
  assert.strictEqual(
    A.match('SP2', { ...m54, vin: 'WBAET37010ABC1234' }),
    'match'
  );
  assert.strictEqual(
    A.match('SP2', { ...m52, vin: 'WBAET47010ABC1234' }),
    'off'
  );
  ok('a leaf about a root the car has no fact for keeps the diagram');

  // the paths that reach a document: own AND (path 3 OR path 4)
  assert.strictEqual(
    A.match('SP3', { ...m54, vin: 'WBAET37010ABC1234' }),
    'match'
  );
  assert.strictEqual(
    A.match('SP3', { ...m52, vin: 'WBAET47010ABC1234' }),
    'off'
  );
  assert.strictEqual(
    A.match('SP4', m54),
    'off',
    'own rule NOT M54 fails for M54'
  );
  assert.strictEqual(A.match('SP4', m52), 'off', 'the only path needs M54');
  ok('a document is gated by its own rule and the tree path down to it');

  // an undecoded rule and a generic document keep showing
  assert.strictEqual(A.match('SP5', m54), 'neutral');
  assert.strictEqual(A.match('SP6', m54), 'neutral');
  assert.strictEqual(A.match('SP-none', m54), 'neutral');
  ok('unsure and generic documents are neutral');

  // an embedded document rule: the importer ships a tree now, and bundles
  // built before it carry name lists that still score
  assert.strictEqual(A.matchRule({ r: rules[1] }, m54), 'off');
  assert.strictEqual(A.matchRule({ r: rules[1] }, m52), 'match');
  assert.strictEqual(A.matchRule({ e: ['M54'] }, m54), 'match');
  assert.strictEqual(A.matchRule({ e: ['M54'] }, m52), 'off');
  assert.strictEqual(A.matchRule({ b: ['COU'] }, m54), 'off');
  assert.strictEqual(A.matchRule({}, m54), 'neutral');
  ok('embedded document rules score, tree or legacy list');

  // the car's keys: names decide three roots, a VIN decides them all
  const byName = A.keys(m54);
  assert.deepStrictEqual(
    [...byName.facts.roots].sort(),
    [CHASSIS, ENGINE, BODY].sort()
  );
  assert.deepStrictEqual([...byName.ids].sort(), [900, 901, 910]);
  const byVin = A.keys({ ...m54, vin: 'WBAET37010ABC1234', prod: '200203' });
  assert.strictEqual(byVin.facts.roots.size, 4);
  assert.strictEqual(byVin.facts.ym, 200203);
  ok("the car's facts come from its type key, or its names");

  console.log(`test_wiring_applicability: ${passed} checks passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
