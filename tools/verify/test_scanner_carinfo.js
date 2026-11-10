#!/usr/bin/env node
// BMWeb Scanner's Car ident window (app/renderer/screens/scanner/
// scanner-carinfo.js): the reference's reads answered with the E46's own
// answers from the USB capture (fixtures/scanner-carinfo.json, keyed by the
// telegram the reference's adapter put on the line), decoded and looked up
// the reference's way, must give what its window showed for that car.
//
// Run: node tools/verify/test_scanner_carinfo.js
const assert = require('assert');
const path = require('path');
const SCANNER_FA_TABLES =
  require('./scanner_pack.js').scannerPackOrSkip('scanner carinfo').faTables;
global.SCANNER_FA_TABLES = SCANNER_FA_TABLES;
const c = require('../../app/renderer/screens/scanner/scanner-carinfo.js');
const fx = require(path.join(__dirname, 'fixtures/scanner-carinfo.json'));

const hex = (a) => a.map((b) => b.toString(16).padStart(2, '0')).join(' ');
const sent = [];
const link = {
  ds2: async (addr, payload) => {
    const t = [addr, payload.length + 3, ...payload];
    sent.push(hex(t));
    const a = fx.answers[hex(t)];
    return a ? a.split(' ').map((x) => parseInt(x, 16)) : null;
  },
};

(async () => {
  const info = await c.scannerReadCarInfo(link);
  for (const [name, m] of [
    ['IKE', info.ike],
    ['LCM', info.lcm],
  ]) {
    assert.ok(m, name + ' answered');
    assert.strictEqual(m.vin, 'AB12345');
    assert.deepStrictEqual(
      [m.fa.chassis, m.fa.time, m.fa.typeKey, m.fa.paint, m.fa.upholstery],
      ['E46', '0904', 'ET37', '0354', 'K4SW']
    );
    assert.deepStrictEqual(
      [m.car.chassis, m.car.model, m.car.body, m.car.engine, m.car.gearbox],
      ['E46', '325i', 'Limousine', 'M54B25', 'Automatic']
    );
    // the reference's table order: 205 first, then 534, 550 ...
    assert.deepStrictEqual(
      m.car.options.slice(0, 3).map((o) => o.code),
      ['205', '534', '550']
    );
    console.log(
      `  ok   ${name}: E46 325i M54B25 Automatic, ${m.car.options.length} options`
    );
  }
  assert.strictEqual(info.ike.odometer, '123456 km');
  assert.strictEqual(info.lcm.odometer, '123400 km');
  // the reads, in the reference's order
  assert.deepStrictEqual(sent.slice(0, 3), [
    '80 05 02 02',
    '80 05 02 01',
    '80 09 06 03 00 00 c2 10',
  ]);
  assert.strictEqual(sent.filter((t) => t.startsWith('d0 05 15')).length, 18);
  console.log('  ok   VIN, odometer and the read order');
  console.log('ALL PASS');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
