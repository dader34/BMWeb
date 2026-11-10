#!/usr/bin/env node
// BMWeb Scanner's Read / Write EEPROM (app/renderer/screens/scanner/
// scanner-eeprom.js) held to BMW Scanner 1.4.0.7's own read of a body
// module: the 64 telegrams of its USB capture, answered in
// fixtures/scanner-eeprom.json with a made-up image; the same telegrams, the
// same image; and its write: DS2 07 hi lo b per byte, an A1 answer asked
// once more, then a read back.
//
// Run: node tools/verify/test_scanner_eeprom.js
const assert = require('assert');
const fx = require('./fixtures/scanner-eeprom.json');
const e = require('../../app/renderer/screens/scanner/scanner-eeprom.js');

const hex = (a) => a.map((b) => b.toString(16).padStart(2, '0')).join(' ');
const parse = (s) => s.split(' ').map((x) => parseInt(x, 16));
const zke = { name: 'ZKE', address: 0x00 };

(async () => {
  // the variant: the reference's switch on the diagnostic index (byte 9),
  // checked against what its own routine gave (oracle: ZKE DI 0x46 -> 9)
  const ident = (di) => [
    0x00,
    0x10,
    0xa0,
    0x86,
    0x94,
    0x48,
    0x40,
    0x20,
    0x05,
    di,
    0x13,
    0x31,
    0x04,
    0x19,
    0x41,
    0xb7,
  ];
  const cases = {
    0x10: 7,
    0x20: 3,
    0x22: 3,
    0x23: 0,
    0x25: 5,
    0x30: 0,
    0x40: 8,
    0x42: 8,
    0x43: 0,
    0x45: 9,
    0x46: 9,
    0x50: 8,
    0x55: 9,
    0x56: 9,
    0x57: 0,
    0x80: 4,
    0x81: 4,
    0x85: 6,
    0xa0: 1,
    0xa3: 2,
    0xff: 0,
  };
  for (const [di, v] of Object.entries(cases))
    assert.strictEqual(e.scannerZkeVariant(ident(Number(di))), v, `DI ${di}`);
  const own = e.scannerEepromPlan(zke, null, ident(0x46));
  assert.deepStrictEqual(
    [own.variant, own.base, own.size, own.ds2],
    [9, 0x2800, 0x400, true]
  );
  assert.strictEqual(e.scannerEepromPlan(zke, null, ident(0x40)).base, 0x0d80);
  assert.strictEqual(e.scannerEepromPlan(zke, null, ident(0x85)).base, 0x3000);

  // the plan per variant (0x5DD798)
  assert.deepStrictEqual(
    [e.scannerEepromPlan(zke, 9).base, e.scannerEepromPlan(zke, 9).size],
    [0x2800, 0x400]
  );
  assert.strictEqual(e.scannerEepromPlan(zke, 8).base, 0x0d80);
  assert.strictEqual(
    e.scannerEepromPlan(zke, null, [...ident(0x30).slice(0, 14), 0x10, 0]).base,
    0x0d00
  );
  assert.strictEqual(
    e.scannerEepromPlan(zke, null, [...ident(0x30).slice(0, 14), 0x40, 0]).base,
    0x3000
  );
  assert.strictEqual(e.scannerEepromPlan({ name: 'IKE' }, null), null);

  // read: the reference's 64 telegrams, its image
  const sent = [];
  const image = Uint8Array.from(Buffer.from(fx.image, 'hex'));
  const readLink = {
    ds2: async (addr, pl) => {
      const t = [addr, pl.length + 3, ...pl];
      t.push(t.reduce((a, b) => a ^ b, 0));
      sent.push(hex(t));
      const a = fx.reads[hex(t)];
      if (!a) throw new Error('silent ' + hex(t));
      return parse(a);
    },
    sleep: async () => {},
  };
  const plan = e.scannerEepromPlan(zke, 9);
  const got = await e.scannerEepromRead(readLink, zke, plan);
  assert.strictEqual(sent.length, 64);
  assert.deepStrictEqual(sent, Object.keys(fx.reads));
  assert.deepStrictEqual(Buffer.from(got), Buffer.from(image));

  // write: one 07 per byte; A1 asked once more after 1.3 s, then on
  const mem = new Uint8Array(image);
  const writes = [];
  const sleeps = [];
  let busyOnce = true;
  const writeLink = {
    ds2: async (addr, pl) => {
      if (pl[0] === 0x07) {
        writes.push(pl);
        const at = ((pl[1] << 8) | pl[2]) - 0x2800;
        if (at === 4 && busyOnce) {
          busyOnce = false;
          return [0x00, 0x04, 0xa1, 0xa5];
        }
        mem[at] = pl[3];
        return [0x00, 0x04, 0xa0, 0xa4];
      }
      const at = ((pl[2] << 8) | pl[3]) - 0x2800;
      return [0x00, 0x14, 0xa0, ...mem.slice(at, at + 16), 0];
    },
    sleep: async (ms) => sleeps.push(ms),
  };
  const data = new Uint8Array(image);
  data[0x10] ^= 0xff;
  const out = await e.scannerEepromWrite(writeLink, zke, plan, data);
  assert.strictEqual(writes.length, 0x400 + 1);
  assert.deepStrictEqual(writes[0], [0x07, 0x28, 0x00, data[0]]);
  assert.deepStrictEqual(sleeps, [1300]);
  assert.deepStrictEqual(out.refused, []);
  assert.deepStrictEqual(out.differ, []);
  assert.strictEqual(mem[0x10], data[0x10]);
  // a stop asked for mid-write ends at the next byte and says where; nothing
  // more goes out, and a cancelled read does the same
  {
    let n = 0;
    const stopLink = {
      ds2: async (addr, pl) => {
        if (pl[0] === 0x07) n++;
        return [0x00, 0x04, 0xa0, 0xa4];
      },
      sleep: async () => {},
    };
    await assert.rejects(
      () => e.scannerEepromWrite(stopLink, zke, plan, data, null, () => n >= 5),
      (err) => err.stopped === true && err.at === 5
    );
    assert.strictEqual(n, 5);
    let reads = 0;
    await assert.rejects(
      () =>
        e.scannerEepromRead(
          {
            ds2: async () => (
              reads++,
              [0, 0x14, 0xa0, ...new Array(16).fill(0), 0]
            ),
            sleep: async () => {},
          },
          zke,
          plan,
          null,
          () => reads >= 2
        ),
      (err) => err.stopped === true && err.at === 0x20
    );
  }

  // the editor's Find: hex pairs or text, first match at or after a place
  assert.deepStrictEqual(e.scannerHexQuery('4e 4A'), [0x4e, 0x4a]);
  assert.deepStrictEqual(e.scannerHexQuery('4E4a'), [0x4e, 0x4a]);
  assert.deepStrictEqual(e.scannerHexQuery('ZKE'), [0x5a, 0x4b, 0x45]);
  {
    const hay = Uint8Array.from([1, 2, 3, 1, 2, 3, 4]);
    assert.strictEqual(e.scannerHexFind(hay, [1, 2, 3]), 0);
    assert.strictEqual(e.scannerHexFind(hay, [1, 2, 3], 1), 3);
    assert.strictEqual(e.scannerHexFind(hay, [3, 4]), 5);
    assert.strictEqual(e.scannerHexFind(hay, [4, 5]), -1);
    assert.strictEqual(e.scannerHexFind(hay, []), -1);
  }

  await assert.rejects(() =>
    e.scannerEepromWrite(writeLink, zke, plan, new Uint8Array(10))
  );

  console.log('ALL PASS (EEPROM read = capture, write + read back)');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
