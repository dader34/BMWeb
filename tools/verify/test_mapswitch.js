#!/usr/bin/env node
// The map switch builder (app/renderer/core/mapswitch.js), ported from the
// macOS flasher's MapSwitch.cs whose build runs on the car.
//
// WHAT THIS PROVES
//   1. On the stock donor pair (when on disk) the three builds -- DSC x4,
//      DSC x2, pedals -- are byte-identical to the C# builder's output, pinned
//      by SHA-256; the external flash is the same for all three (only the
//      safety monitor's sum and map 2 change there).
//   2. On a synthetic stock-like pair, always: the gates (program version,
//      free area, stock instructions, matching pair), the build, recognition
//      of what was built (installed / current / state on car), a rebuild that
//      changes nothing, a trigger change that replaces the code, and the
//      map 2 rules.
//
// Run: node tools/verify/test_mapswitch.js
//      MS45_DIR=/path/to/e46bins/MS45-DME node tools/verify/test_mapswitch.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { mapSwitch } = require('../../app/renderer/core/mapswitch.js');

let passed = 0;
const ok = (m) => {
  passed++;
  console.log(`  ok    ${m}`);
};
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ── 1. the reference builds ─────────────────────────────────────────────────
console.log('\nreference builds');
const dir =
  process.env.MS45_DIR ||
  path.join(process.env.HOME || '', 'Desktop/e46bins/MS45-DME');
const stockFlash = path.join(
  dir,
  'stock',
  'NJ87379_0044570_Flash_donor_stock.bin'
);
const stockMpc = path.join(dir, 'stock', 'NJ87379_0044570_MPC_donor_stock.bin');
const PINNED = {
  stockFlash:
    'b4241f614bb2e7b9f21db8dfab1d3b738710bfea72625f5ef4d35d89ce21e8b6',
  stockMpc: '84dafd81fe779f08a68f458cc6b9e48d26a3e222a3f214bb69c0be8e50f5d38a',
  flash: '21c89bf937d90af4e66b4285ebc0b3837f411b4c4bd31bc0d72e74c324c8ef7f',
  dsc4: '767de0a81305b8513f75fa56b9b19ebd71dd298605d54e33ae4106c339b95cde',
  dsc2: '6e221fcedbafe86174fae51e4f280c3d8daaa96929caf97f5ef75c54473738a3',
  pedals: '6182d5eba983210a4589bf09c92ed8753cc71a3ce3dc7fab447b23b561f6ba8b',
};
if (fs.existsSync(stockFlash) && fs.existsSync(stockMpc)) {
  const flash = new Uint8Array(fs.readFileSync(stockFlash));
  const mpc = new Uint8Array(fs.readFileSync(stockMpc));
  if (sha(flash) === PINNED.stockFlash && sha(mpc) === PINNED.stockMpc) {
    assert.strictEqual(mapSwitch.blockedReason(flash, mpc), null);
    for (const [name, trigger, presses] of [
      ['dsc4', 'dsc', 4],
      ['dsc2', 'dsc', 2],
      ['pedals', 'pedals', 4],
    ]) {
      const r = mapSwitch.build(flash, mpc, null, null, trigger, presses);
      assert.strictEqual(sha(r.flash), PINNED.flash, `${name} flash`);
      assert.strictEqual(sha(r.mpc), PINNED[name], `${name} mpc`);
    }
    ok(
      'DSC x4, DSC x2 and pedals builds are byte-identical to the C# reference (SHA-256 pinned)'
    );
  } else console.log('  skip  the stock pair on disk is not the pinned one');
} else console.log('  skip  reference builds (set MS45_DIR to run this)');

// ── 2. a synthetic stock-like pair ─────────────────────────────────────────
console.log('\nsynthetic pair');
const LOOKUPS = [
  0xcfc8, 0xd054, 0xd0e4, 0xd178, 0xd210, 0xd264, 0xd2c0, 0xd31c, 0xd380,
  0xd38c, 0xd39c, 0xd3b8, 0xd3dc, 0xd44c, 0xd4c0, 0xd660,
];
const STOCK = [
  0x89830000, 0x88e30000, 0xa1830000, 0xa0e30000, 0x88a30000, 0x88a30000,
  0xa0a30000, 0xa0a30000, 0x898dd7c6, 0x898dd7c6, 0x898dd7c6, 0x898dd7c6,
  0x38e30000, 0x38e30000, 0x88add7c4, 0x88add7c4,
];
function w32(a, at, v) {
  a[at] = (v >>> 24) & 0xff;
  a[at + 1] = (v >>> 16) & 0xff;
  a[at + 2] = (v >>> 8) & 0xff;
  a[at + 3] = v & 0xff;
}
function syntheticPair() {
  const mpc = new Uint8Array(mapSwitch.MPC_LENGTH);
  for (let i = 0; i < mpc.length; i++) mpc[i] = (i * 13 + 5) & 0xff;
  mpc.fill(0xff, 0x6e550, 0x70000);
  LOOKUPS.forEach((e, i) => w32(mpc, e, STOCK[i]));
  w32(mpc, 0x4b6c4, 0xb06dc4d8);
  w32(mpc, 0x4bb78, 0x980dc4fb);
  w32(mpc, 0x4bba4, 0x900dc4f8);
  const nv = 0x28ac + 56 * 0x1c;
  [0xfffca0f8, 0xfffca104, 0xfffca110].forEach((v, i) =>
    w32(mpc, nv + 4 * i, v)
  );
  // the pair-match numbers: flash 0x60310 - mpc 0x100 == 500
  mpc.set(Buffer.from('0000001000'), 0x100);

  const flash = new Uint8Array(mapSwitch.FULL_FLASH_LENGTH);
  for (let i = 0; i < flash.length; i++) flash[i] = (i * 7 + 1) & 0xff;
  flash.fill(0xff, 0xe0000, 0xf8000);
  flash.set(Buffer.from('0044570LO02S'), 0x6031c);
  flash.set(Buffer.from('0000001500'), 0x60310);
  const ranges = [
    0x0000bae8, 0x0000f5f8, 0xfff60630, 0xfff68c2c, 0x00000140, 0x000002d4,
    0xffe40240, 0xffe407c8,
  ];
  ranges.forEach((v, i) => w32(flash, 0x60608 + 4 * i, v));
  // a tune: data version, immobilizer stock, nothing past the map 2 length
  flash.fill(
    0xff,
    0x40000 + mapSwitch.MAP2_LENGTH,
    0x40000 + mapSwitch.CALIBRATION_LENGTH
  );
  flash.set(Buffer.from('0044570LO00S'), 0x40010);
  flash[0x48f2c] = 0x10;
  flash[0x48f3e] = 0x10;
  flash[0xdb1c7] = 0x01;
  flash[0xdb1d3] = 0x3f;
  // the safety monitor's sums as the stock code gives them
  const cal = flash.subarray(0x40000, 0x40000 + mapSwitch.CALIBRATION_LENGTH);
  const calSum = mapSwitch._calTestSum(cal);
  w32(flash, 0x40000 + 0x57dc, Number((calSum >> 32n) & 0xffffffffn));
  w32(flash, 0x40000 + 0x57e0, Number(calSum & 0xffffffffn));
  const romSum = mapSwitch._romTestSum(flash, mpc);
  w32(flash, 0x60600, Number((romSum >> 32n) & 0xffffffffn));
  w32(flash, 0x60604, Number(romSum & 0xffffffffn));
  return { flash, mpc };
}

{
  const { flash, mpc } = syntheticPair();
  assert.strictEqual(mapSwitch.blockedReason(flash, mpc), null);
  assert.strictEqual(mapSwitch.readProgramVersion(flash), '0044570LO02S');
  assert.ok(!mapSwitch.isAlreadyPatched(mpc));
  assert.deepStrictEqual(
    mapSwitch.stateOnCar(mpc.subarray(0x6e550, 0x6e550 + 0x600)),
    { state: 'notInstalled', trigger: null, presses: null, scope: null }
  );
  ok('a stock-like pair passes every gate and reads as not installed');

  const other = Uint8Array.from(flash);
  other.set(Buffer.from('0044570LO00S'), 0x6031c);
  assert.match(mapSwitch.blockedReason(other, mpc), /only built for program/);
  const busy = Uint8Array.from(mpc);
  busy[0x6e560] = 0;
  assert.match(mapSwitch.blockedReason(flash, busy), /free area/);
  const used = Uint8Array.from(flash);
  used[0xe0010] = 0;
  assert.match(mapSwitch.blockedReason(used, mpc), /map 2/);
  const hooked = Uint8Array.from(mpc);
  w32(hooked, 0xcfc8, 0x48000000);
  assert.match(mapSwitch.blockedReason(flash, hooked), /lookup routine 0xCFC8/);
  assert.match(mapSwitch.blockedReason(new Uint8Array(10), mpc), /1 MB/);
  assert.match(mapSwitch.blockedReason(flash, new Uint8Array(10)), /448 KB/);
  ok(
    'another program, a used free area, a used map 2 area, a hooked lookup and wrong sizes are refused'
  );

  const r = mapSwitch.build(flash, mpc, null, null, 'dsc', 4);
  assert.strictEqual(
    r.codeBytes,
    1132,
    'the DSC build is 1132 bytes, as the C# one'
  );
  assert.ok(!r.wasAlreadyPatched && !r.wasUpdated && r.mapsIdentical);
  assert.ok(
    mapSwitch.isAlreadyPatched(r.mpc) && mapSwitch.isCurrentVersion(r.mpc)
  );
  assert.deepStrictEqual(mapSwitch.installed(r.mpc), {
    trigger: 'dsc',
    presses: 4,
    scope: 'fullTune',
  });
  assert.deepStrictEqual(
    mapSwitch.stateOnCar(r.mpc.subarray(0x6e550, 0x6e550 + 0x600)),
    { state: 'current', trigger: 'dsc', presses: 4, scope: 'fullTune' }
  );
  assert.ok(mapSwitch.hasMap2(r.flash, r.mpc));
  assert.deepStrictEqual(
    r.flash.subarray(0xe0000, 0xe0000 + mapSwitch.MAP2_LENGTH),
    r.flash.subarray(0x40000, 0x40000 + mapSwitch.MAP2_LENGTH),
    'map 2 is a copy of map 1'
  );
  assert.ok(
    flash.subarray(0xe0000, 0xe0010).every((b) => b === 0xff),
    'the inputs are left alone'
  );
  assert.strictEqual(
    mapSwitch._romTestSum(r.flash, r.mpc),
    (BigInt((r.flash[0x60600] << 24) >>> 0) << 32n) |
      BigInt(
        ((r.flash[0x60604] << 24) |
          (r.flash[0x60605] << 16) |
          (r.flash[0x60606] << 8) |
          r.flash[0x60607]) >>>
          0
      ) |
      (BigInt(
        ((r.flash[0x60601] << 16) |
          (r.flash[0x60602] << 8) |
          r.flash[0x60603]) >>>
          0
      ) <<
        32n)
  );
  ok(
    'DSC x4 builds: 1132 bytes, hooks recognised as current, map 2 stored, code sum corrected, inputs untouched'
  );

  const again = mapSwitch.build(r.flash, r.mpc, null, null, 'dsc', 4);
  assert.ok(again.wasAlreadyPatched && !again.wasUpdated);
  assert.deepStrictEqual(again.mpc, r.mpc);
  assert.deepStrictEqual(again.flash, r.flash);
  ok('rebuilding the same version changes nothing');

  const ped = mapSwitch.build(r.flash, r.mpc, null, null, 'pedals');
  assert.ok(ped.wasAlreadyPatched && ped.wasUpdated);
  assert.strictEqual(ped.codeBytes, 948);
  assert.deepStrictEqual(mapSwitch.installed(ped.mpc), {
    trigger: 'pedals',
    presses: 0,
    scope: 'fullTune',
  });
  assert.ok(
    ped.log.some((l) =>
      /replaced the map switch, was DSC button pressed 4 times/.test(l)
    )
  );
  ok(
    'a trigger change replaces the code whole (948 bytes for the pedals) and says what it was'
  );

  assert.throws(
    () => mapSwitch.build(flash, mpc, null, null, 'dsc', 3),
    /2 or 4 presses/
  );
  const map2 = Uint8Array.from(
    flash.subarray(0x40000, 0x40000 + mapSwitch.CALIBRATION_LENGTH)
  );
  map2.set(Buffer.from('0044570LO02S'), 0x10);
  assert.match(
    mapSwitch.map2BlockedReason(
      map2,
      flash.subarray(0x40000, 0x40000 + mapSwitch.CALIBRATION_LENGTH)
    ),
    /share one layout/
  );
  const tooLong = Uint8Array.from(
    flash.subarray(0x40000, 0x40000 + mapSwitch.CALIBRATION_LENGTH)
  );
  tooLong[mapSwitch.MAP2_LENGTH + 4] = 0;
  assert.match(mapSwitch.map2BlockedReason(tooLong, tooLong), /does not fit/);
  const tune2 = Uint8Array.from(
    flash.subarray(0x40000, 0x40000 + mapSwitch.CALIBRATION_LENGTH)
  );
  tune2[0x1000] ^= 0xff;
  const two = mapSwitch.build(flash, mpc, null, tune2, 'dsc', 2);
  assert.ok(!two.mapsIdentical);
  assert.strictEqual(two.flash[0xe1000], tune2[0x1000]);
  assert.deepStrictEqual(
    mapSwitch
      .map2AsCalibration(
        two.flash.subarray(0xe0000, 0xe0000 + mapSwitch.MAP2_LENGTH)
      )
      .subarray(0, mapSwitch.MAP2_LENGTH),
    tune2.subarray(0, mapSwitch.MAP2_LENGTH)
  );
  assert.strictEqual(
    mapSwitch.map2AsCalibration(
      new Uint8Array(mapSwitch.MAP2_LENGTH).fill(0xff)
    ),
    null
  );
  assert.strictEqual(
    mapSwitch.extractCalibration(flash).length,
    mapSwitch.CALIBRATION_LENGTH
  );
  assert.strictEqual(
    mapSwitch.extractCalibration(new Uint8Array(0x20000)).length,
    mapSwitch.CALIBRATION_LENGTH
  );
  assert.throws(
    () => mapSwitch.extractCalibration(new Uint8Array(100)),
    /0x1D000 bytes/
  );
  ok(
    'map 2 rules: layout must match map 1, must fit, a different tune is stored and reads back; calibration extraction'
  );

  const wrongSum = syntheticPair();
  wrongSum.flash[0x60604] ^= 1;
  assert.throws(
    () => mapSwitch.build(wrongSum.flash, wrongSum.mpc, null, null),
    /code sum in the program header/
  );
  ok(
    'an unpatched pair whose safety-monitor sum does not match its code is refused'
  );
}

console.log(`\nmapswitch: ${passed} checks passed`);
