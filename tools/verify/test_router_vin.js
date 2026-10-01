#!/usr/bin/env node
// The vehicle a view is filtered to rides in the URL: #apps/parts/<CHASSIS>
// [/<HG>[/<BTNR>]][/~<VIN>] and #apps/wiring/<CHASSIS>[/<DOC>][/~<VIN>], the
// VIN as base64url. A reload or a shared link comes back filtered.
//
//   node tools/verify/test_router_vin.js
const assert = require('assert');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', 'app', 'renderer');
let passed = 0;
const ok = (m) => {
  passed++;
  if (process.env.V) console.log('  ok', m);
};
// the router is a classic script with a module export; the screens it
// resolves to are stubs that record what they were asked to open
const calls = [];
global.showEtkChassis = (chassis, pre) => calls.push(['chassis', chassis, pre]);
global.showEtkDeep = (chassis, hg, btnr, pre) =>
  calls.push(['deep', chassis, hg, btnr, pre]);
global.showWiring = (chassis, doc, hit) =>
  calls.push(['wiring', chassis, doc, hit]);
global.loadVinIndex = async () => ({ stub: true });
global.decodeVin = (idx, vin) =>
  vin === 'WBAET37495NJ87379' || vin === 'NJ87379'
    ? {
        chassis: 'E46',
        model: '325i M54',
        body: 'Lim',
        motor: 'M54',
        steer: 'L',
        prod: '200409',
      }
    : null;
const R = require(path.join(ROOT, 'core', 'router.js'));

(async () => {
  // the code: base64url of the upper-cased VIN, no padding, and back
  const code = R.routeVinCode('wbaet37495nj87379');
  assert.strictEqual(code, 'V0JBRVQzNzQ5NU5KODczNzk');
  assert.strictEqual(R.routeVinFrom(code), 'WBAET37495NJ87379');
  assert.strictEqual(
    R.routeVinFrom(R.routeVinCode('NJ87379')),
    'NJ87379',
    'a production number travels too'
  );
  assert.strictEqual(R.routeVinCode(''), '');
  assert.strictEqual(R.routeVinCode('ab'), '', 'too short to be a VIN');
  assert.strictEqual(R.routeVinCode('WBA ET37'), '', 'not a VIN');
  assert.strictEqual(R.routeVinFrom('not*base64'), null);
  assert.strictEqual(
    R.routeVinFrom(R.routeVinCode('12345678901234567890')),
    null,
    'too long'
  );
  assert.strictEqual(R.routeVinFrom(null), null);
  assert.ok(!/[+/=]/.test(code), 'url-safe');
  ok('a VIN round-trips through its url segment');

  assert.strictEqual(
    R.routeWithVin('apps/parts/E46/51/51_3267', 'WBAET37495NJ87379'),
    `apps/parts/E46/51/51_3267/~${code}`
  );
  assert.strictEqual(
    R.routeWithVin('apps/parts/E46', null),
    'apps/parts/E46',
    'no vehicle, no segment'
  );
  ok('a route carries the vehicle only when there is one');

  // parsing: the parts routes, with and without the vehicle
  const hit = {
    chassis: 'E46',
    model: '325i M54',
    body: 'Lim',
    motor: 'M54',
    steer: 'L',
    prod: '200409',
    vin: 'WBAET37495NJ87379',
  };
  calls.length = 0;
  await R.resolveRoute('apps/parts/E46')();
  await R.resolveRoute(`apps/parts/E46/~${code}`)();
  await R.resolveRoute('apps/parts/E46/51/51_3267')();
  await R.resolveRoute(`apps/parts/E46/51/51_3267/~${code}`)();
  await R.resolveRoute(`apps/parts/E46/51/~${code}`)();
  assert.deepStrictEqual(calls, [
    ['chassis', 'E46', null],
    ['chassis', 'E46', { hit }],
    ['deep', 'E46', '51', '51_3267', null],
    ['deep', 'E46', '51', '51_3267', { hit }],
    ['deep', 'E46', '51', null, { hit }],
  ]);
  ok('the parts routes open filtered to the vehicle the URL names');

  // an unknown VIN opens unfiltered rather than not at all
  calls.length = 0;
  await R.resolveRoute(`apps/parts/E46/~${R.routeVinCode('ZZZ9999')}`)();
  assert.deepStrictEqual(calls, [['chassis', 'E46', null]]);
  ok('an unknown vehicle opens the chassis unfiltered');

  // wiring
  calls.length = 0;
  await R.resolveRoute('apps/wiring/E46')();
  await R.resolveRoute(`apps/wiring/E46/~${code}`)();
  await R.resolveRoute(`apps/wiring/E46/SP0000014337/~${code}`)();
  assert.deepStrictEqual(calls, [
    ['wiring', 'E46', null, null],
    ['wiring', 'E46', null, hit],
    ['wiring', 'E46', 'SP0000014337', hit],
  ]);
  ok('the wiring routes open filtered to the vehicle the URL names');

  // the VIN decoder's own route is untouched
  assert.strictEqual(typeof R.resolveRoute('apps/parts/vin'), 'function');
  calls.length = 0;
  ok('the VIN decoder route still stands');

  console.log(`test_router_vin: ${passed} checks passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
