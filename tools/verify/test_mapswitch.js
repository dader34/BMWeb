#!/usr/bin/env node
// The map switch builder (app/renderer/core/mapswitch.js), ported from the
// macOS flasher's MapSwitch.cs whose two-map build runs on the car, and
// extended to several maps stored as the blocks that differ.
//
// WHAT THIS PROVES
//   1. On the stock donor pair (when on disk) the generation 3 builds -- DSC
//      x4, DSC x2, pedals, gear lever -- are still byte-identical to what ran
//      on the car, pinned by SHA-256, so a car carrying one stays recognised
//      and the code that recognises it has not drifted. The generation 4
//      builds are pinned as first built.
//   2. On a synthetic stock-like pair, always: the gates (program version,
//      free area, stock instructions, matching pair), the build, recognition
//      of what was built (installed / current / state on car), a rebuild that
//      changes nothing, a trigger change that replaces the code, and the
//      rules for the maps.
//   3. The block layout: every map holds the r2 blocks in place in a window
//      of its own, a changed block is stored with its neighbours and the
//      table sends only the right ones there, maps read back whole from the
//      tables, an earlier build is replaced, and a map that cannot fit is
//      refused with the room that is left.
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
const FREE = 0x6e550;
const CHECK = mapSwitch.CAR_CHECK_LENGTH;
const gen5 = (trigger, presses, maps = 2) =>
  mapSwitch._version(
    trigger,
    'immediateLong',
    'car',
    'fullTune',
    presses,
    true,
    5,
    maps
  );
const gen3 = (trigger, presses) =>
  mapSwitch._version(
    trigger,
    'immediateLong',
    'car',
    'fullTune',
    presses,
    true,
    3
  );
const sameCal = (a, b) => {
  // the stored copy carries map 1's safety-monitor sum
  for (let i = 0; i < a.length; i++)
    if (a[i] !== b[i] && !(i >= 0x57dc && i < 0x57e4)) return false;
  return true;
};

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
  // generation 3: one full copy of map 2 at 0xE0000, as it runs on the car
  flash: '21c89bf937d90af4e66b4285ebc0b3837f411b4c4bd31bc0d72e74c324c8ef7f',
  dsc4: '767de0a81305b8513f75fa56b9b19ebd71dd298605d54e33ae4106c339b95cde',
  dsc2: '6e221fcedbafe86174fae51e4f280c3d8daaa96929caf97f5ef75c54473738a3',
  pedals: '6182d5eba983210a4589bf09c92ed8753cc71a3ce3dc7fab447b23b561f6ba8b',
  shifter: '07d9eefbfe2eae04de8126676368dd14ca075173bce5767795763b6d17d9dfa9',
  // generation 4, two identical maps
  flash4: null,
  dsc4_4: null,
  shifter_4: null,
  pedals_4: null,
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
      ['shifter', 'shifter', 4],
    ]) {
      const r = mapSwitch._buildVersion(
        flash,
        mpc,
        null,
        null,
        gen3(trigger, presses)
      );
      assert.strictEqual(sha(r.flash), PINNED.flash, `${name} flash`);
      assert.strictEqual(sha(r.mpc), PINNED[name], `${name} mpc`);
      assert.deepStrictEqual(mapSwitch.installed(r.mpc), {
        trigger,
        presses: trigger === 'dsc' ? presses : 0,
        scope: 'fullTune',
        maps: 2,
        layout: 'copy',
      });
    }
    ok(
      'generation 3 builds (DSC x4, DSC x2, pedals, gear lever) are byte-identical to what runs on the car (SHA-256 pinned) and recognised'
    );
    const pins = {};
    for (const [name, trigger, presses] of [
      ['dsc4_4', 'dsc', 4],
      ['shifter_4', 'shifter', 4],
      ['pedals_4', 'pedals', 4],
    ]) {
      const r = mapSwitch.build(flash, mpc, null, null, trigger, presses);
      pins[name] = sha(r.mpc);
      pins.flash4 = sha(r.flash);
      if (PINNED[name]) assert.strictEqual(sha(r.mpc), PINNED[name], name);
      if (PINNED.flash4)
        assert.strictEqual(sha(r.flash), PINNED.flash4, `${name} flash`);
    }
    ok(
      `generation 4 builds on the stock pair${PINNED.flash4 ? ' are the pinned ones' : ': ' + JSON.stringify(pins)}`
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
const r32 = (a, at) =>
  ((a[at] << 24) | (a[at + 1] << 16) | (a[at + 2] << 8) | a[at + 3]) >>> 0;
const r16 = (a, at) => (a[at] << 8) | a[at + 1];
const SYN_CODE = 0x20000; // where the synthetic pair's stretch of calibration-reading code is
const SYN_SITES = [
  [0x8a3c, 2, SYN_CODE + 4],
  [0x8a3e, 1, SYN_CODE + 12],
  [0x5ebc, 2, SYN_CODE + 16],
  [0x12fdc, 2, SYN_CODE + 24],
  [0x10010, 1, SYN_CODE + 32],
  [0x8a40, 4, SYN_CODE + 36],
];
function syntheticPair() {
  const mpc = new Uint8Array(mapSwitch.MPC_LENGTH);
  for (let i = 0; i < mpc.length; i++) mpc[i] = (i * 13 + 5) & 0xff;
  mpc.fill(0xff, 0x6e550, 0x70000);
  LOOKUPS.forEach((e, i) => w32(mpc, e, STOCK[i]));
  w32(mpc, 0xf4fc, 0x898dd7c6); // the 17th lookup
  w32(mpc, 0x4b6c4, 0xb06dc4d8);
  // a stretch of code reading single values of the calibration, the ways
  // the program does: through r2, through r2 + 0x10000, through an absolute
  // base; the site scan must find them all (and only them)
  const code = [
    0x7c0802a6, // mflr r0
    0xa1620a4c, // lhz r11, 0xA4C(r2)      -> 0x8A3C  (2 bytes)
    0x898dd7c6, // lbz r12, -0x283A(r13)   (RAM, not a site)
    0x89820a4e, // lbz r12, 0xA4E(r2)      -> 0x8A3E  (1 byte)
    0xa862decc, // lha r3, -0x2134(r2)     -> 0x5EBC  (2 bytes, signed)
    0x3d420001, // addis r10, r2, 1
    0xa12aafec, // lhz r9, -0x5014(r10)    -> 0x12FDC (upper half)
    0x3c60ffe5, // lis r3, 0xFFE5
    0x88830010, // lbz r4, 0x10(r3)        -> 0x10010 (absolute)
    0x80a20a50, // lwz r5, 0xA50(r2)       -> 0x8A40  (4 bytes)
    0x4e800020, // blr
  ];
  code.forEach((w, i) => w32(mpc, SYN_CODE + 4 * i, w));
  w32(mpc, 0x4bb78, 0x980dc4fb);
  w32(mpc, 0x4bba4, 0x900dc4f8);
  const nv = 0x28ac + 56 * 0x1c;
  [0xfffca0f8, 0xfffca104, 0xfffca110].forEach((v, i) =>
    w32(mpc, nv + 4 * i, v)
  );
  // the pair-match numbers: flash 0x60310 - mpc 0x100 == 500
  mpc.set(Buffer.from('0000001000'), 0x100);
  // the accesses to the calibration's upper half, addis rX, r2, 1: 62 in the
  // MPC and 719 in the flash, as in the program (the filler holds none)
  for (let i = 0; i < 61; i++)
    w32(mpc, 0x4ec88 + 8 * i, 0x3c020001 | ((3 + (i % 9)) << 21)); // 61 + the one in the code stretch
  w32(mpc, 0x10f6c, 0x3d420000); // the MAF table readers' addis r10/r11, r2, 0
  w32(mpc, 0x11030, 0x3d620000);

  const flash = new Uint8Array(mapSwitch.FULL_FLASH_LENGTH);
  for (let i = 0; i < flash.length; i++) flash[i] = (i * 7 + 1) & 0xff;
  for (const [s, e] of mapSwitch._POOLS) flash.fill(0xff, s, e);
  flash.set(Buffer.from('0044570LO02S'), 0x6031c);
  flash.set(Buffer.from('0000001500'), 0x60310);
  for (let i = 0; i < 719; i++)
    w32(flash, 0x8792c + 8 * i, 0x3c020001 | ((3 + (i % 9)) << 21));
  const ranges = [
    0x0000bae8, 0x0000f5f8, 0xfff60630, 0xfff68c2c, 0x00000140, 0x000002d4,
    0xffe40240, 0xffe407c8,
  ];
  ranges.forEach((v, i) => w32(flash, 0x60608 + 4 * i, v));
  // a tune: data version, immobilizer stock, nothing past the old map 2 length
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
const calOf = (flash) =>
  Uint8Array.from(
    flash.subarray(0x40000, 0x40000 + mapSwitch.CALIBRATION_LENGTH)
  );
const notInstalled = {
  state: 'notInstalled',
  trigger: null,
  presses: null,
  scope: null,
  maps: null,
  layout: null,
};

{
  const { flash, mpc } = syntheticPair();
  assert.strictEqual(mapSwitch.blockedReason(flash, mpc), null);
  assert.strictEqual(mapSwitch.readProgramVersion(flash), '0044570LO02S');
  assert.ok(!mapSwitch.isAlreadyPatched(mpc));
  assert.deepStrictEqual(
    mapSwitch.stateOnCar(mpc.subarray(FREE, FREE + CHECK)),
    notInstalled
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
  assert.match(mapSwitch.blockedReason(used, mpc), /area for the maps/);
  const usedLow = Uint8Array.from(flash);
  usedLow[0xdcc10] = 0;
  assert.match(mapSwitch.blockedReason(usedLow, mpc), /area for the maps/);
  const hooked = Uint8Array.from(mpc);
  w32(hooked, 0xcfc8, 0x48000000);
  assert.match(mapSwitch.blockedReason(flash, hooked), /lookup routine 0xCFC8/);
  assert.match(mapSwitch.blockedReason(new Uint8Array(10), mpc), /1 MB/);
  assert.match(mapSwitch.blockedReason(flash, new Uint8Array(10)), /448 KB/);
  ok(
    'another program, a used free area, a used map area, a hooked lookup and wrong sizes are refused'
  );

  const r = mapSwitch.build(flash, mpc, null, null, 'dsc', 4);
  assert.strictEqual(r.codeBytes, 1856, 'the DSC build is 1856 bytes');
  assert.ok(r.codeBytes <= CHECK, 'the code fits the car check read');
  assert.ok(!r.wasAlreadyPatched && !r.wasUpdated && r.mapsIdentical);
  assert.strictEqual(r.maps, 2);
  assert.ok(
    mapSwitch.isAlreadyPatched(r.mpc) && mapSwitch.isCurrentVersion(r.mpc)
  );
  assert.deepStrictEqual(mapSwitch.installed(r.mpc), {
    trigger: 'dsc',
    presses: 4,
    scope: 'fullTune',
    maps: 2,
    layout: 'chunks',
  });
  assert.deepStrictEqual(
    mapSwitch.stateOnCar(r.mpc.subarray(FREE, FREE + CHECK)),
    {
      state: 'current',
      trigger: 'dsc',
      presses: 4,
      scope: 'fullTune',
      maps: 2,
      layout: 'chunks',
    }
  );
  assert.ok(mapSwitch.hasMap2(r.flash, r.mpc));
  const stored = mapSwitch.storedMaps(r.flash, r.mpc);
  assert.strictEqual(stored.length, 1);
  assert.ok(sameCal(stored[0], calOf(flash)), 'map 2 reads back as map 1');
  // generation 6: the header says chunks and sites, r2 is map 1's for every
  // map, an identical map 2 stores nothing and switches nothing
  const h = mapSwitch._HEADER;
  assert.strictEqual(
    Buffer.from(r.flash.subarray(h, h + 8)).toString(),
    'MS45MAPS'
  );
  assert.strictEqual(r.flash[h + 8], 2);
  assert.strictEqual(r.flash[h + 9], 6, 'layout byte: chunks and sites');
  assert.strictEqual(r32(r.flash, h + 0x10), 0xffe47ff0);
  assert.strictEqual(
    r32(r.flash, h + 0x14),
    0xffe47ff0,
    "map 2's r2 is map 1's"
  );
  const sitesEnd = r32(r.flash, h + 0xc);
  assert.strictEqual(
    sitesEnd,
    mapSwitch._SITES + 0x100,
    'an empty site area is one chunk'
  );
  const dir = mapSwitch._readSites(
    r.flash.subarray(mapSwitch._SITES, sitesEnd)
  );
  assert.ok(dir && dir.scalars.length === 0 && dir.sites.length === 0);
  for (let e = 0; e < 0x200; e++)
    assert.strictEqual(
      r16(r.flash, h + 0x400 + 2 * e),
      0xffff,
      'no chunk redirected'
    );
  assert.ok(
    r.flash.subarray(sitesEnd, 0xf8000).every((b) => b === 0xff) &&
      r.flash.subarray(0xfa800, 0xffc00).every((b) => b === 0xff),
    'nothing stored'
  );
  assert.ok(
    flash.subarray(0xdcc00, 0xdcc10).every((b) => b === 0xff),
    'the inputs are left alone'
  );
  assert.strictEqual(
    mapSwitch._romTestSum(r.flash, r.mpc),
    (BigInt(r32(r.flash, 0x60600)) << 32n) | BigInt(r32(r.flash, 0x60604))
  );
  assert.strictEqual(
    mapSwitch._upperSites(r.flash, r.mpc).length,
    781,
    'the upper half is left as it is: r2 does not move'
  );
  assert.strictEqual(
    r32(r.mpc, 0xf4fc) >>> 26,
    18,
    'the 17th lookup is hooked'
  );
  ok(
    'DSC x4 builds: 1856 bytes, recognised as current, header + chunk tables + empty site area as designed, code sum corrected, inputs untouched'
  );

  // generation 5, built on request: the nested r2 windows and the upper-half rewrite
  const r5 = mapSwitch._buildVersion(flash, mpc, null, null, gen5('dsc', 4));
  assert.strictEqual(r5.codeBytes, 3060);
  // the header: magic, count, r2 for map 1 and for map 2's window
  assert.strictEqual(
    Buffer.from(r5.flash.subarray(h, h + 8)).toString(),
    'MS45MAPS'
  );
  assert.strictEqual(r5.flash[h + 8], 2);
  assert.strictEqual(r32(r5.flash, h + 0x10), 0xffe47ff0);
  const window = 0xdd400;
  assert.strictEqual(r32(r5.flash, h + 0x14), 0xfff00000 + window + 0x7ff0);
  // the table: nothing differs, so every lookup stays map 1's; the window
  // holds the r2 blocks, and only them, at their offsets from its base
  const table = (idx) => {
    const t = [];
    for (let e = 0; e < 128; e++)
      t.push(r16(r5.flash, h + 0x100 * idx + 2 * e));
    return t;
  };
  const t1 = table(1);
  assert.ok(
    t1.every((e) => e === 0xffff),
    'an identical map redirects no lookup'
  );
  for (let b = 0; b < 0x19; b++) {
    const stored = r5.flash.subarray(
      window + b * 0x400,
      window + (b + 1) * 0x400
    );
    if (mapSwitch._R2_BLOCKS.includes(b))
      assert.deepStrictEqual(
        stored,
        flash.subarray(0x40000 + b * 0x400, 0x40000 + (b + 1) * 0x400),
        `r2 block ${b} in the window`
      );
    else
      assert.ok(
        stored.every((x) => x === 0xff),
        `window slot ${b} is a gap`
      );
  }
  assert.ok(
    flash.subarray(0xdcc00, 0xdcc10).every((b) => b === 0xff),
    'the inputs are left alone'
  );
  assert.strictEqual(
    mapSwitch._romTestSum(r5.flash, r5.mpc),
    (BigInt(r32(r5.flash, 0x60600)) << 32n) | BigInt(r32(r5.flash, 0x60604))
  );
  // the accesses to the calibration's upper half now read map 1's: every
  // addis rX, r2, 1 became lis rX, 0xFFE5, rX kept, nothing else touched
  assert.strictEqual(mapSwitch._upperSites(flash, mpc).length, 781);
  assert.strictEqual(mapSwitch._upperSites(r5.flash, r5.mpc).length, 0);
  for (let i = 0; i < 719; i++)
    assert.strictEqual(
      r32(r5.flash, 0x8792c + 8 * i),
      (0x3c00ffe5 | ((3 + (i % 9)) << 21)) >>> 0
    );
  for (let i = 0; i < 61; i++)
    assert.strictEqual(
      r32(r5.mpc, 0x4ec88 + 8 * i),
      (0x3c00ffe5 | ((3 + (i % 9)) << 21)) >>> 0
    );
  let touched = 0;
  for (let i = 0x60608; i < 0xdcc00; i++)
    if (r5.flash[i] !== flash[i]) touched++;
  assert.ok(
    touched <= 719 * 3 + 4 * 6,
    `only the sites and the program sums change in the program: ${touched} bytes`
  );
  assert.ok(
    r5.log.some((l) => /783 accesses to the calibration's upper half/.test(l))
  );
  assert.strictEqual(r32(r5.mpc, 0x10f6c), 0x3d40ffe4);
  assert.strictEqual(r32(r5.mpc, 0x11030), 0x3d60ffe4);
  assert.strictEqual(mapSwitch._sensorSitesState(r5.mpc), 'rewritten');
  ok(
    'generation 5 on request: 3060 bytes, header + block table + nested r2 window as designed, upper-half accesses rewritten'
  );

  const again = mapSwitch.build(r.flash, r.mpc, null, null, 'dsc', 4);
  assert.ok(again.wasAlreadyPatched && !again.wasUpdated);
  assert.deepStrictEqual(again.mpc, r.mpc);
  assert.deepStrictEqual(again.flash, r.flash);
  ok('rebuilding the same version changes nothing');

  const ped = mapSwitch.build(r.flash, r.mpc, null, null, 'pedals');
  assert.ok(ped.wasAlreadyPatched && ped.wasUpdated);
  assert.strictEqual(ped.codeBytes, 1672);
  assert.deepStrictEqual(mapSwitch.installed(ped.mpc), {
    trigger: 'pedals',
    presses: 0,
    scope: 'fullTune',
    maps: 2,
    layout: 'chunks',
  });
  assert.ok(
    ped.log.some((l) =>
      /replaced the map switch, was DSC button pressed 4 times/.test(l)
    )
  );
  ok(
    'a trigger change replaces the code whole (1672 bytes for the pedals) and says what it was'
  );

  const lever = mapSwitch.build(r.flash, r.mpc, null, null, 'shifter');
  assert.ok(lever.wasAlreadyPatched && lever.wasUpdated);
  assert.strictEqual(lever.codeBytes, 1852);
  assert.ok(mapSwitch.isCurrentVersion(lever.mpc));
  assert.deepStrictEqual(
    mapSwitch.stateOnCar(lever.mpc.subarray(FREE, FREE + CHECK)),
    {
      state: 'current',
      trigger: 'shifter',
      presses: 0,
      scope: 'fullTune',
      maps: 2,
      layout: 'chunks',
    }
  );
  assert.deepStrictEqual(
    lever.flash,
    r.flash,
    'the trigger changes nothing in the external flash'
  );
  assert.strictEqual(
    mapSwitch.describeTrigger('shifter'),
    'gear lever activation style'
  );
  const fresh = mapSwitch.build(flash, mpc, null, null, 'shifter');
  assert.deepStrictEqual(fresh.mpc, lever.mpc);
  const backToDsc = mapSwitch.build(lever.flash, lever.mpc, null, null, 'dsc');
  assert.deepStrictEqual(backToDsc.mpc, r.mpc);
  assert.ok(
    backToDsc.log.some((l) => /was gear lever activation style/.test(l))
  );
  // the lever is read from the stored EGS1 frame: gear in byte 0, program
  // symbol in the top of byte 2, both reached through r13
  const words = [];
  const code = mapSwitch._buildCode(
    mapSwitch._version(
      'shifter',
      'immediateLong',
      'car',
      'fullTune',
      0,
      true,
      4,
      2
    )
  );
  for (let i = code.tachStub - FREE; i < code.runStub - FREE; i += 4)
    words.push(r32(code.code, i));
  const r13 = 0x4017f0;
  const lbz = (reg, addr) =>
    ((34 << 26) | (reg << 21) | (13 << 16) | ((addr - r13) & 0xffff)) >>> 0;
  assert.strictEqual(words[0], lbz(12, mapSwitch.RAM.canEgs1 + 7));
  assert.ok(words.includes(lbz(12, mapSwitch.RAM.canEgs1 + 5)));
  ok(
    'the gear lever trigger: 1852 bytes, recognised, replaces and is replaced by the DSC build, reads EGS1 bytes 0 and 2'
  );

  assert.throws(
    () => mapSwitch.build(flash, mpc, null, null, 'dsc', 3),
    /2 or 4 presses/
  );
  assert.throws(
    () => mapSwitch.build(flash, mpc, null, null, 'paddles'),
    /unknown map switch trigger/
  );
  const otherLayout = calOf(flash);
  otherLayout.set(Buffer.from('0044570LO02S'), 0x10);
  assert.match(
    mapSwitch.mapBlockedReason(otherLayout, calOf(flash), 3),
    /Map 3 is for data version .* share one layout/
  );
  assert.throws(
    () => mapSwitch.build(flash, mpc, null, [otherLayout], 'dsc'),
    /share one layout/
  );
  assert.throws(
    () =>
      mapSwitch.build(flash, mpc, null, new Array(7).fill(calOf(flash)), 'dsc'),
    /at most 7 maps/
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
    'map rules: layout must match map 1, at most 7 maps; calibration extraction'
  );

  // ── three maps that differ ──
  const map1 = calOf(flash);
  const map2 = Uint8Array.from(map1);
  map2[0x1000] ^= 0xff; // block 4: an r2 block, in the window anyway
  map2[0x8f2c] = 0x00; // block 0x23: a lone change, far from the window
  map2[0x8f3e] = 0x00;
  const map3 = Uint8Array.from(map1);
  for (let i = 0; i < 0x1000; i++) map3[0x10000 + i] ^= 0x5a; // blocks 0x40-0x43
  const three = mapSwitch._buildVersion(
    flash,
    mpc,
    null,
    [map2, map3],
    gen5('dsc', 2, 3)
  );
  assert.ok(!three.mapsIdentical);
  assert.strictEqual(three.maps, 3);
  assert.deepStrictEqual(mapSwitch.installed(three.mpc), {
    trigger: 'dsc',
    presses: 2,
    scope: 'fullTune',
    maps: 3,
    layout: 'blocks',
  });
  assert.ok(
    !mapSwitch.isCurrentVersion(three.mpc),
    'a generation 5 build is not current'
  );
  assert.strictEqual(three.flash[h + 8], 3);
  const t2 = [];
  const t3 = [];
  for (let e = 0; e < 128; e++) {
    t2.push(r16(three.flash, h + 0x100 + 2 * e));
    t3.push(r16(three.flash, h + 0x200 + 2 * e));
  }
  // map 2: block 0x23 changed -> 0x22 and 0x23 redirected, 0x24 carried after them but not redirected
  assert.notStrictEqual(t2[0x22], 0xffff);
  assert.strictEqual(t2[0x23], t2[0x22] + 1);
  assert.strictEqual(t2[0x24], 0xffff);
  assert.strictEqual(t2[0x21], 0xffff);
  assert.deepStrictEqual(
    three.flash.subarray((t2[0x23] + 1) * 0x400, (t2[0x23] + 2) * 0x400),
    map2.subarray(0x24 * 0x400, 0x25 * 0x400),
    'the block after the changed one follows it in the flash'
  );
  assert.strictEqual(three.flash[t2[0x23] * 0x400 + 0x32c], 0x00);
  // block 4 changed: redirected to its window slot, and block 3 before it
  // too; the other r2 blocks are read through r2 only and stay map 1's
  // for lookups
  assert.strictEqual(t2[4], (window >> 10) + 4);
  assert.strictEqual(t2[3], (window >> 10) + 3);
  for (const b of [0, 1, 2, 5, 6, 0x11, 0x12, 0x14, 0x15, 0x17, 0x18])
    assert.strictEqual(t2[b], 0xffff, `block ${b} is map 1's for lookups`);
  // map 3: blocks 0x40-0x43 changed -> 0x3F-0x43 redirected, 0x44 carried;
  // its window nests in map 2's, 7 KB up, its r2 blocks in map 2's gaps
  for (const b of [0x3f, 0x40, 0x41, 0x42, 0x43])
    assert.strictEqual(t3[b], t3[0x3f] + b - 0x3f);
  assert.strictEqual(t3[0x44], 0xffff);
  assert.strictEqual(t3[0x3e], 0xffff);
  const window3 = r32(three.flash, h + 0x18) - 0xfff00000 - 0x7ff0;
  assert.strictEqual(window3, window + 7 * 0x400);
  for (const b of mapSwitch._R2_BLOCKS)
    assert.deepStrictEqual(
      three.flash.subarray(window3 + b * 0x400, window3 + (b + 1) * 0x400),
      map3.subarray(b * 0x400, (b + 1) * 0x400),
      `map 3's r2 block ${b}`
    );
  // the lone run of three went into a gap the two windows leave
  assert.ok(
    t2[0x22] >= window >> 10 && t2[0x22] < (window3 >> 10) + 0x18,
    'spill lives in a window gap'
  );
  // every map reads back whole from the tables
  const back = mapSwitch.storedMaps(three.flash, three.mpc);
  assert.strictEqual(back.length, 2);
  assert.ok(sameCal(back[0], map2) && sameCal(back[1], map3));
  // and through the car-read helpers, block by block
  const area = three.flash.subarray(
    mapSwitch.TABLES_OFFSET,
    mapSwitch.TABLES_OFFSET + mapSwitch.TABLES_LENGTH
  );
  assert.strictEqual(mapSwitch.mapCountFrom(area), 3);
  const ranges = mapSwitch.blockRangesFrom(area, 2);
  assert.ok(
    ranges.length === 1 && ranges.every((x) => (x.end - x.start) % 0x400 === 0),
    'map 3 is read back from the car as its one redirected run'
  );
  const chunks = ranges.map((x) => ({
    start: x.start,
    data: three.flash.subarray(x.start, x.end),
  }));
  assert.ok(sameCal(mapSwitch.mapFromChunks(map1, area, 2, chunks), map3));
  assert.strictEqual(
    mapSwitch.locateFrom(area, 2, 0x10010),
    t3[0x40] * 0x400 + 0x10
  );
  assert.strictEqual(
    mapSwitch.locateFrom(area, 2, 0x8020),
    0x40000 + 0x8020,
    "an unstored block is map 1's"
  );
  assert.strictEqual(mapSwitch.selectedIndex(0x22, 'blocks'), 2);
  assert.strictEqual(mapSwitch.selectedIndex(0x01, 'copy'), 1);
  assert.strictEqual(mapSwitch.selectedIndex(0x01, 'blocks'), 0);
  // the safety monitor's calibration sum: map 1's, in every map's window
  const sum1 = three.flash.subarray(0x40000 + 0x57dc, 0x40000 + 0x57e4);
  for (const w of [window, window3])
    assert.deepStrictEqual(three.flash.subarray(w + 0x57dc, w + 0x57e4), sum1);
  assert.ok(
    three.log.some((l) => /Map 2: 2 KB differ from map 1/.test(l)) &&
      three.log.some((l) => /Map 3: 4 KB differ from map 1/.test(l)) &&
      three.log.some((l) => /Maps: 3 in all/.test(l))
  );
  ok(
    'three maps: changed blocks stored with their neighbours and redirected as designed, windows nested, maps read back whole, car-read helpers agree'
  );

  // replacing the stored maps re-lays them out against the image's map 1
  const map2b = Uint8Array.from(map2);
  map2b[0x8f2c] = 0x10;
  const replaced = mapSwitch.replaceStoredMaps(three.flash, three.mpc, [
    map2b,
    map3,
  ]);
  assert.deepStrictEqual(
    replaced.mpc,
    three.mpc,
    'a generation 5 build keeps its MPC'
  );
  const back2 = mapSwitch.storedMaps(replaced.flash, replaced.mpc);
  assert.ok(sameCal(back2[0], map2b) && sameCal(back2[1], map3));
  assert.throws(
    () => mapSwitch.replaceStoredMaps(three.flash, three.mpc, [map2b]),
    /cycles through 3 maps/
  );
  // and on the current build, where the single values live at their load
  // sites, the MPC changes with them
  const six = mapSwitch.build(flash, mpc, null, [map2, map3], 'dsc', 2);
  const replaced6 = mapSwitch.replaceStoredMaps(six.flash, six.mpc, [
    map2b,
    map3,
  ]);
  const back6 = mapSwitch.storedMaps(replaced6.flash, replaced6.mpc);
  assert.ok(sameCal(back6[0], map2b) && sameCal(back6[1], map3));
  assert.ok(mapSwitch.isCurrentVersion(replaced6.mpc));
  ok(
    'replaceStoredMaps re-lays the maps out and keeps the count the code was built for'
  );

  // an earlier (generation 3) build on the pair is replaced, its full copy erased
  const old = mapSwitch._buildVersion(
    flash,
    mpc,
    null,
    map2,
    gen3('shifter', 0)
  );
  assert.deepStrictEqual(mapSwitch.installed(old.mpc), {
    trigger: 'shifter',
    presses: 0,
    scope: 'fullTune',
    maps: 2,
    layout: 'copy',
  });
  assert.ok(sameCal(mapSwitch.storedMaps(old.flash, old.mpc)[0], map2));
  assert.deepStrictEqual(
    mapSwitch.stateOnCar(old.mpc.subarray(FREE, FREE + CHECK)),
    {
      state: 'earlier',
      trigger: 'shifter',
      presses: 0,
      scope: 'fullTune',
      maps: 2,
      layout: 'copy',
    }
  );
  const upgraded = mapSwitch.build(
    old.flash,
    old.mpc,
    null,
    [map2, map3],
    'shifter'
  );
  assert.ok(upgraded.wasUpdated);
  assert.ok(
    upgraded.log.some((l) =>
      /replaced the map switch, was gear lever activation style, full tune, 2 maps/.test(
        l
      )
    )
  );
  assert.deepStrictEqual(
    upgraded.flash.subarray(0x40000, 0x5d000),
    old.flash.subarray(0x40000, 0x5d000)
  );
  const after = mapSwitch.storedMaps(upgraded.flash, upgraded.mpc);
  assert.strictEqual(after.length, 2);
  assert.ok(sameCal(after[0], map2) && sameCal(after[1], map3));
  ok(
    'a generation 3 build is recognised as earlier and replaced by a block build with more maps'
  );

  // a generation 4 build (block tables, but a lookup hook that misses the
  // table pointers the program forms from r2) is recognised and replaced too
  const gen4 = mapSwitch._buildVersion(
    flash,
    mpc,
    null,
    [map2, map3],
    mapSwitch._version('dsc', 'immediateLong', 'car', 'fullTune', 2, true, 4, 3)
  );
  assert.deepStrictEqual(
    mapSwitch.stateOnCar(gen4.mpc.subarray(FREE, FREE + CHECK)),
    {
      state: 'earlier',
      trigger: 'dsc',
      presses: 2,
      scope: 'fullTune',
      maps: 3,
      layout: 'blocks',
    }
  );
  assert.ok(!mapSwitch.isCurrentVersion(gen4.mpc));
  const from4 = mapSwitch.build(
    gen4.flash,
    gen4.mpc,
    null,
    [map2, map3],
    'dsc',
    2
  );
  const fresh6 = mapSwitch.build(flash, mpc, null, [map2, map3], 'dsc', 2);
  assert.ok(from4.wasUpdated && mapSwitch.isCurrentVersion(from4.mpc));
  assert.deepStrictEqual(from4.mpc, fresh6.mpc);
  assert.deepStrictEqual(from4.flash, fresh6.flash);
  const from5 = mapSwitch.build(
    three.flash,
    three.mpc,
    null,
    [map2, map3],
    'dsc',
    2
  );
  assert.ok(from5.wasUpdated && mapSwitch.isCurrentVersion(from5.mpc));
  const back5 = mapSwitch.storedMaps(from5.flash, from5.mpc);
  assert.ok(sameCal(back5[0], map2) && sameCal(back5[1], map3));
  ok(
    'generation 4 and 5 builds are recognised as earlier and replaced by the current one'
  );

  // room, generation 5's layout: a map costs its r2 blocks (11 KB) plus
  // what differs; the windows nest at 0, 7, 31, 38, 62 and 69 KB
  const same = mapSwitch._layout(map1, [map1, map1, map1, map1, map1, map1]);
  assert.deepStrictEqual(
    same.maps.map((m) => m.windowBase - (window >> 10)),
    [0, 7, 31, 38, 62, 69]
  );
  const dense = Uint8Array.from(map1);
  for (let i = 0; i < 0x6000; i += 0x400) dense[i] ^= 0xff;
  const packed = mapSwitch._layout(map1, [map1, map1, map1, map1, map1, dense]);
  assert.ok(
    !packed.ok && /the 25 KB the program reads through r2/.test(packed.reason),
    packed.reason
  );
  ok(
    'generation 5 layout: six windows nest into 93 KB; one that cannot is refused'
  );

  // room, the current build: a map costs what differs, as 256-byte chunks
  // with two before (a table there may run into them) and two after; the
  // single values cost a stub each, not a chunk. Without the program to
  // scan, plan() counts every differing byte as a chunk
  const plan2 = mapSwitch.plan(map1, [map2, map3], flash, mpc);
  assert.ok(
    plan2.ok && plan2.canAddAnother && plan2.kbTotal === 130,
    JSON.stringify(plan2)
  );
  // map 2: a byte in chunk 4 and two in chunk 0x8F -> runs 2-6 and 0x8D-0x91, 2.5 KB; map 3: 16 chunks -> 0x3E-0x41 .. 0x4F-0x4F.., 5 KB
  assert.deepStrictEqual(plan2.perMapKb, [2.5, 5]);
  const seven = mapSwitch.plan(
    map1,
    [map2, map3, map1, map1, map1, map1],
    flash,
    mpc
  );
  assert.ok(
    seven.ok && !seven.canAddAnother,
    'seven maps fit, the most there are'
  );
  assert.strictEqual(seven.kbUsed, 8.3 + 2.5 + 5);
  const blind = mapSwitch.plan(map1, [map2, map3]);
  assert.deepStrictEqual(
    blind.perMapKb,
    plan2.perMapKb,
    'without the program, these maps have no single values anyway'
  );
  // maps that change half of everything do not fit: 56 KB each, in one piece
  const all = Uint8Array.from(map1);
  for (let i = 0x200; i < 0xe000; i += 0x100) all[i] ^= 0xff;
  const full = mapSwitch.plan(map1, [all, all], flash, mpc);
  assert.ok(!full.ok && /Map 3 does not fit/.test(full.reason), full.reason);
  assert.throws(
    () => mapSwitch.build(flash, mpc, null, [all, all], 'dsc'),
    /Map 3 does not fit/
  );
  const sevenBuilt = mapSwitch.build(
    flash,
    mpc,
    null,
    [map2, map3, map1, map1, map1, map1],
    'dsc'
  );
  assert.strictEqual(sevenBuilt.maps, 7);
  const sevenBack = mapSwitch.storedMaps(sevenBuilt.flash, sevenBuilt.mpc);
  assert.strictEqual(sevenBack.length, 6);
  assert.ok(
    sameCal(sevenBack[0], map2) &&
      sameCal(sevenBack[1], map3) &&
      sameCal(sevenBack[5], map1)
  );
  assert.ok(
    mapSwitch.plan(null, []).canAddAnother,
    'with nothing loaded, a second map can be added'
  );
  ok(
    'room: the plan counts KB and says when another map fits; seven maps build, maps changing everything are refused'
  );

  // ── the load sites (generation 6) ──
  {
    const scan = mapSwitch._scanSites(flash, mpc);
    for (const [off, size, at] of SYN_SITES) {
      const found = (scan.sites.get(off) || []).filter(
        (x) => x.at === at && x.image === 'mpc'
      );
      assert.strictEqual(
        found.length,
        1,
        `site for 0x${off.toString(16)} at 0x${at.toString(16)}`
      );
      assert.strictEqual(found[0].size, size);
    }
    assert.strictEqual(scan.sites.get(0x8a3c)[0].op, 40);
    assert.strictEqual(
      scan.sites.get(0x5ebc)[0].op,
      42,
      'the signed load keeps its opcode'
    );
    // maps that change those values, and one table
    const mA = Uint8Array.from(map1);
    mA[0x8a3c] = 0x12;
    mA[0x8a3d] = 0x34;
    mA[0x8a3e] = 0x56;
    mA[0x5ebc] = 0xfe;
    mA[0x5ebd] = 0xdc;
    mA[0x12fdc] = 0x11;
    mA[0x10010] = 0x22;
    mA[0x8a40] = 0x01;
    mA[0x8a43] = 0x04;
    for (let i = 0; i < 16; i++) mA[0x4395 + i] ^= 0x55; // chunk 0x43
    const mB = Uint8Array.from(map1);
    mB[0x5ebc] = 0x77;
    mB[0x5ebd] = 0x88;
    mB[0x10010] = 0x99;
    const b = mapSwitch.build(flash, mpc, null, [mA, mB], 'dsc', 4);
    const h = mapSwitch._HEADER;
    const dir = mapSwitch._readSites(
      b.flash.subarray(mapSwitch._SITES, r32(b.flash, h + 0xc))
    );
    assert.strictEqual(dir.scalars.length, 6);
    assert.strictEqual(dir.sites.length, 6);
    const byOff = new Map(dir.scalars.map((x, i) => [x.offset, { ...x, i }]));
    assert.deepStrictEqual(
      [...byOff.get(0x5ebc).values[0]],
      [...map1.subarray(0x5ebc, 0x5ebe)],
      "index 0: map 1's value"
    );
    assert.deepStrictEqual([...byOff.get(0x5ebc).values[1]], [0xfe, 0xdc]);
    assert.deepStrictEqual([...byOff.get(0x5ebc).values[2]], [0x77, 0x88]);
    assert.deepStrictEqual(
      [...byOff.get(0x5ebc).values[7]],
      [...map1.subarray(0x5ebc, 0x5ebe)],
      "absent maps: map 1's"
    );
    assert.deepStrictEqual(
      [...byOff.get(0x8a40).values[1]],
      [...mA.subarray(0x8a40, 0x8a44)]
    );
    for (const site of dir.sites) {
      const [off, size, at] = SYN_SITES.find((x) => x[2] === site.address);
      assert.strictEqual(site.stock, r32(mpc, at), 'the stock word is kept');
      assert.strictEqual(
        r32(b.mpc, at),
        ((18 << 26) | (((0xfff00000 + site.stub) & 0x03fffffc) >>> 0) | 2) >>>
          0,
        'the site is an absolute branch to its stub'
      );
      const stub = [0, 1, 2, 3, 4].map((k) => r32(b.flash, site.stub + 4 * k));
      const rt = (site.stock >>> 21) & 31;
      assert.strictEqual(stub[0] >>> 26, 34, 'lbz the flag');
      assert.strictEqual((stub[0] >>> 21) & 31, rt);
      assert.strictEqual((stub[0] >>> 16) & 31, 13);
      assert.strictEqual(
        stub[1] >>> 26,
        21,
        'rlwinm: the index times the size'
      );
      assert.strictEqual(stub[2] >>> 26, 15, 'addis');
      assert.strictEqual(
        stub[3] >>> 26,
        site.stock >>> 26,
        'the load keeps its width and sign'
      );
      assert.strictEqual(
        stub[4],
        ((18 << 26) | ((at + 4) & 0x03fffffc) | 2) >>> 0,
        'back to the instruction after the site'
      );
      // the values the stub reaches: addis high half + load low half = the scalar's values
      const hi = ((stub[2] & 0xffff) << 16) >>> 0;
      const lo = ((stub[3] & 0xffff) << 16) >> 16;
      assert.strictEqual(
        ((hi + lo) >>> 0) - 0xfff00000,
        dir.scalars[site.scalar].offset === off
          ? (() => {
              let a = mapSwitch._SITES + 16;
              for (let i = 0; i < site.scalar; i++)
                a += 4 + ((8 * dir.scalars[i].size + 3) & ~3);
              return a + 4;
            })()
          : -1,
        `stub values address for 0x${off.toString(16)}`
      );
      assert.strictEqual(dir.scalars[site.scalar].size, size);
    }
    // the table went into chunks, with two before and two after; the single values did not
    const t1 = [];
    for (let e = 0; e < 0x200; e++) t1.push(r16(b.flash, h + 0x400 + 2 * e));
    assert.ok(
      t1[0x43] !== 0xffff &&
        t1[0x42] !== 0xffff &&
        t1[0x41] !== 0xffff &&
        t1[0x40] === 0xffff,
      'chunk 0x43 and the two before redirected'
    );
    assert.strictEqual(t1[0x44], 0xffff);
    assert.strictEqual(t1[0x45], 0xffff);
    assert.deepStrictEqual(
      b.flash.subarray((t1[0x43] + 1) * 0x100, (t1[0x43] + 2) * 0x100),
      mA.subarray(0x4400, 0x4500),
      'the chunk after follows it'
    );
    assert.strictEqual(
      t1[0x8a],
      0xffff,
      'a chunk whose only change is a single value is not stored'
    );
    assert.strictEqual(t1[0x5e], 0xffff);
    const back = mapSwitch.storedMaps(b.flash, b.mpc);
    assert.ok(
      sameCal(back[0], mA) && sameCal(back[1], mB),
      'maps read back, single values included'
    );
    assert.ok(
      b.log.some((l) =>
        /6 single values differ between the maps, read at 6 places/.test(l)
      )
    );
    // car-read helpers: the ranges include the site area; the map comes back whole from them
    const area = b.flash.subarray(h, mapSwitch._CHUNK_TABLES_END);
    assert.ok(
      mapSwitch.isChunksLayout(area) &&
        mapSwitch.tablesLength('chunks') === 0x2000
    );
    const ranges = mapSwitch.blockRangesFrom(area, 1);
    assert.strictEqual(ranges[0].start, mapSwitch._SITES);
    const chunks = ranges.map((x) => ({
      start: x.start,
      data: b.flash.subarray(x.start, x.end),
    }));
    assert.ok(sameCal(mapSwitch.mapFromChunks(map1, area, 1, chunks), mA));
    assert.strictEqual(
      mapSwitch.locateFrom(area, 1, 0x4395),
      t1[0x43] * 0x100 + 0x95
    );
    assert.strictEqual(
      mapSwitch.locateFrom(area, 1, 0x8a3c),
      0x40000 + 0x8a3c,
      'a single value is not in the chunks'
    );
    const scalars = mapSwitch.scalarsFrom(chunks[0].data, 1);
    assert.ok(
      scalars.some(
        (x) => x.offset === 0x8a3c && x.data[0] === 0x12 && x.data[1] === 0x34
      )
    );
    // a rebuild with maps that no longer change a value puts the stock instruction back
    const b2 = mapSwitch.build(b.flash, b.mpc, null, [mB, mB], 'dsc', 4);
    assert.strictEqual(
      r32(b2.mpc, SYN_CODE + 4),
      0xa1620a4c,
      'the 0x8A3C site is stock again'
    );
    assert.notStrictEqual(
      r32(b2.mpc, SYN_CODE + 16),
      0xa862decc,
      'the 0x5EBC site is still a stub'
    );
    assert.ok(
      b2.log.some((l) => /stock instructions put back at the 6/.test(l))
    );
    assert.ok(sameCal(mapSwitch.storedMaps(b2.flash, b2.mpc)[0], mB));
    // a value read in a way no stub can take over is reported, and stays map 1's
    const mpcF = Uint8Array.from(mpc);
    w32(mpcF, SYN_CODE + 40, 0xc0220a54); // lfs f1, 0xA54(r2) -> 0x8A44 in place of the blr
    w32(mpcF, SYN_CODE + 44, 0x4e800020);
    const mC = Uint8Array.from(map1);
    mC[0x8a44] ^= 0xff;
    const bf = mapSwitch.build(flash, mpcF, null, [mC], 'dsc', 4);
    assert.ok(
      bf.log.some((l) =>
        /WARNING: 1 differing bytes \(0x8A44\) are read in a way no stub/.test(
          l
        )
      ),
      bf.log.join('\n')
    );
    ok(
      'load sites: found by the scan, patched with a stub and a values table each, read back, restored when no longer needed, the unswitchable told'
    );
  }

  const fewer = syntheticPair();
  w32(fewer.mpc, 0x4ec88, 0x60000000);
  assert.ok(
    /found 780, readers stock/.test(
      mapSwitch.blockedReason(fewer.flash, fewer.mpc)
    ),
    'a program without all the upper-half accesses is refused'
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
