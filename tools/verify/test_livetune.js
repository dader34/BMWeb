#!/usr/bin/env node
// The live-tune client (app/renderer/core/livetune.js): the tester's side of
// the MS45's own 2C-6C service, driven against a faithful stub of that
// service. The stub models what ms45emu/transport.py does on the DME -- the
// descriptor table at 0x3F9E10, the state block at 0x3F9E74, first-fit over
// four mirror pools, the five ops, and read-by-address -- so the client is
// held to the same contract the emulator proves on the DME side.
//
// WHAT THIS PROVES
//   1. A DME without the build (no state-block magic) is reported absent.
//   2. open seeds a mirror from the calibration and is found by its base in
//      the descriptors, not by a trusted count; a second open of the same
//      range returns the same entry.
//   3. sync sends only the differing bytes, aligned to the cell size so a
//      16-bit cell is never half-written, and the shadow tracks the mirror.
//   4. A write refused for range, and an open refused for room, surface as
//      LtError with the right code.
//   5. save: engine turning refuses (turning); engine stopped, the stub goes
//      silent and the client takes the null as a successful save+reset.
//   6. The client places the mirrors (op 07) and can
//      program them into blank flash, op 06): RAM running out parks the table
//      edited longest ago on the shelf and the DME still reads its edit;
//      editing it again brings it back; a reloaded page takes shelved tables
//      over; what an earlier session left on the shelf is never written over;
//      a save folds shelved and RAM tables alike.
//   7. The single values are live: the client reads the
//      DME's table of them, edits a value that has RAM of its own in place,
//      opens any other as a small mirror, never parks the first kind, and
//      says which values still wait for a save.
//
// Run: node tools/verify/test_livetune.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
  LT_STATUS,
  LT_VERSION,
  LT_POOLS,
  LT_SHELF,
  LT_SINGLES,
  LtError,
  LiveTune,
} = require('../../app/renderer/core/livetune.js');

// Load ms45.js's send-path in a context with the webshim globals it reaches,
// so the one seam the client itself cannot see -- the KWP2000* framing -- is
// held to the DME's telegram shape (B8 12 F1 len data xor).
function loadSender(onTx, answerData) {
  const ctx = { module: { exports: {} }, console, Uint8Array, Math, Date };
  ctx.globalThis = ctx;
  ctx.window = {};
  ctx.withBusLock = (fn) => fn();
  ctx.switchSession = async () => {};
  ctx.sessionFor = () => ({ comm: { concept: 0x10d } });
  ctx.webBusRawExchange = async (out) => {
    onTx(Array.from(out));
    const f = [0xb8, 0xf1, 0x12, answerData.length, ...answerData];
    let x = 0;
    for (const b of f) x ^= b;
    f.push(x);
    return f;
  };
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'app', 'renderer', 'core', 'ms45.js'),
    'utf8'
  );
  vm.runInNewContext(
    src + '\nmodule.exports.ms45LiveTuneSender = ms45LiveTuneSender;',
    ctx
  );
  return ctx.module.exports.ms45LiveTuneSender();
}

let passed = 0;
const ok = (m) => {
  passed++;
  console.log(`  ok    ${m}`);
};

// ---- the DME stub ----------------------------------------------------------
const CAL_BASE = 0xffe40000;
const CAL_LENGTH = 0x1d000;
const DESC = 0x3f9e10;
const DESC_MAGIC = 0x6c690000;
const STATE = 0x3f9e74;
const STATE_MAGIC = 0x4c54554e;
const POOLS = [
  [0x3f9e94, 0x3fa0a0],
  [0x3f9c48, 0x3f9e00],
  [0x3f9b48, 0x3f9c40],
  [0x3f9858, 0x3f98b0],
];

// A tiny sparse memory: calibration (a known pattern) and the RAM the state
// block, descriptors and mirrors live in.
// ms45emu/transport.py as built: thirty-six slots at 0x3F9C48, op 06
// programs blank flash on the shelf (whole words, 32 bytes a request, only
// over blank), op 07 places a slot's mirror in a RAM pool (seeding it from
// where the range reads now) or on the shelf, op 02 refuses a shelved mirror.

const SINGLES_POOL = [0x3ff580, 0x3ff900];

function makeDme2(opts = {}) {
  const V = opts.version || LT_VERSION;
  const DESC2 = 0x3f9c48;
  const SLOTS2 = 36;
  const POOLS = LT_POOLS;
  const ram = new Map();
  const flash = new Map(); // calibration offset -> programmed byte (the shelf)
  const rd = (a) => ram.get(a) || 0;
  const wr = (a, v) => ram.set(a, v & 0xff);
  const cal = (off) =>
    flash.has(off)
      ? flash.get(off)
      : off >= CAL_LENGTH
        ? 0xff
        : (off * 7 + 0x11) & 0xff;
  const be32 = (a) =>
    ((rd(a) << 24) | (rd(a + 1) << 16) | (rd(a + 2) << 8) | rd(a + 3)) >>> 0;
  const putBe32 = (a, v) => {
    wr(a, v >> 24);
    wr(a + 1, v >> 16);
    wr(a + 2, v >> 8);
    wr(a + 3, v);
  };
  const dme = {
    built: opts.built !== false,
    turning: !!opts.turning,
    saved: null,
    count: 0,
    flash,
    programs: 0,
    ops: [],
    watch: null, // build 6: the range on the data breakpoint {base, end, mirror}
  };
  // the single-value table in the external flash, and the pool
  // it describes, filled from the calibration as the DME does at start-up
  const table = [];
  const pooled = new Map(); // calibration offset -> [length, address]
  if (opts.singles) {
    let at = 0;
    const body = [];
    for (const [off, len] of opts.singles.pool) {
      body.push(
        off >> 8,
        off & 0xff,
        (((len - 1) << 12) | at) >> 8,
        (((len - 1) << 12) | at) & 0xff
      );
      pooled.set(off, [len, SINGLES_POOL[0] + at]);
      at += len;
    }
    for (const [lo, hi] of opts.singles.runs)
      body.push(lo >> 8, lo & 0xff, (hi - lo) >> 8, (hi - lo) & 0xff);
    const n = opts.singles.pool.length;
    const r = opts.singles.runs.length;
    table.push(
      0x53,
      0x56,
      0x4c,
      0x31,
      n >> 8,
      n & 0xff,
      r >> 8,
      r & 0xff,
      0x00,
      0x3f,
      0xf5,
      0x80,
      0,
      0,
      0,
      0,
      ...body
    );
  }
  const fillPool = () => {
    for (const [off, [len, addr]] of pooled)
      for (let i = 0; i < len; i++) wr(addr + i, ((off + i) * 7 + 0x11) & 0xff);
  };
  fillPool();
  const ACK = [0x7f, 0x2c, 0x12];
  const any = (addr) => (addr >= CAL_BASE ? cal(addr - CAL_BASE) : rd(addr));
  /** What an instruction that reads the single value at `offset` gets. */
  dme.single = (offset, i = 0) => {
    const w = dme.watch;
    const a = (CAL_BASE + offset + i) >>> 0;
    if (w && a >= w.base && a < w.end) return any(w.mirror + (a - w.base));
    if (pooled.has(offset)) return rd(pooled.get(offset)[1] + i);
    // in a run every reader goes through the mirrors; elsewhere it is flash
    const runs = opts.singles ? opts.singles.runs : [];
    return runs.some(([lo, hi]) => lo <= offset && offset + i < hi)
      ? dme.lookup(offset, i)
      : cal(offset + i);
  };
  const slotAt = (s) => {
    const base = be32(DESC2 + 4 + s * 12);
    return {
      base,
      end: be32(DESC2 + 8 + s * 12),
      mirror: (base + be32(DESC2 + 12 + s * 12)) >>> 0,
    };
  };
  /** What a lookup of the table at `offset` reads: the first descriptor's mirror. */
  dme.lookup = (offset, i) => {
    for (let s = 0; s < dme.count; s++) {
      const d = slotAt(s);
      if (d.base === (CAL_BASE + offset) >>> 0) return any(d.mirror + i);
    }
    return cal(offset + i);
  };
  const finish = (status) => {
    putBe32(STATE + 4, status);
    return ACK;
  };

  dme.send = async (data) => {
    if (data[0] === 0x23) {
      const addr = (data[1] << 16) | (data[2] << 8) | data[3];
      const out = [0x63];
      if (data.length === 6) {
        // the segment form: external flash, the calibration at 0x40000
        if (data[4] !== 0x02) return [0x7f, 0x23, 0x31];
        for (let i = 0; i < data[5]; i++) {
          const t = addr + i - LT_SINGLES;
          out.push(
            t >= 0 && t < 0x2800
              ? t < table.length
                ? table[t]
                : 0xff
              : cal(addr - 0x40000 + i)
          );
        }
      } else {
        if (addr < 0x3f9800) return [0x7f, 0x23, 0x31]; // RAM only
        for (let i = 0; i < data[4]; i++) out.push(rd(addr + i));
      }
      return out;
    }
    if (data[0] !== 0x2c || data[1] !== 0x6c) return ACK;
    if (!dme.built) return ACK; // acks, but leaves no magic
    if (be32(STATE) !== STATE_MAGIC) {
      putBe32(STATE, STATE_MAGIC);
      putBe32(STATE + 4, 0);
      putBe32(STATE + 8, 0);
      putBe32(STATE + 12, V);
    }
    const op = data[2];
    dme.ops.push(op);
    if (op === 0x02) {
      const slot = data[3];
      const off = (data[4] << 8) | data[5];
      const nn = data[6];
      if (slot >= dme.count) return finish(LT_STATUS.SLOT);
      const d = slotAt(slot);
      if (d.mirror >= CAL_BASE) return finish(LT_STATUS.SHELVED);
      if (d.base + off + nn > d.end) return finish(LT_STATUS.RANGE);
      for (let i = 0; i < nn; i++) wr(d.mirror + off + i, data[7 + i]);
      return finish(LT_STATUS.OK);
    }
    const unwatch = () => {
      dme.watch = null;
      putBe32(STATE + 0x24, 0);
      putBe32(STATE + 0x28, 0);
    };
    if (op === 0x03) {
      putBe32(DESC2, 0);
      putBe32(DESC2 + 4, 0);
      dme.count = 0;
      putBe32(STATE + 8, 0);
      fillPool(); // a mirror placed on a value's own RAM left its edit there
      if (V >= 6) unwatch();
      return finish(LT_STATUS.OK);
    }
    if (op === 0x04) return finish(LT_STATUS.OK);
    if (op === 0x09 && V >= 6) {
      // the slot's descriptor, as it is now, on the breakpoint; 0xFF takes it off
      const slot = data[3];
      if (slot === 0xff) {
        unwatch();
        return finish(LT_STATUS.OK);
      }
      if (slot >= dme.count) return finish(LT_STATUS.SLOT);
      const d = slotAt(slot);
      dme.watch = { base: d.base, end: d.end, mirror: d.mirror };
      putBe32(STATE + 0x24, d.base);
      putBe32(STATE + 0x28, d.end);
      putBe32(STATE + 0x2c, (d.mirror - d.base) >>> 0);
      return finish(LT_STATUS.OK);
    }
    if (op === 0x08 && V >= 4) {
      wr(0x3f9892, data[3]); // 0x5A: the key-off saves
      return finish(LT_STATUS.OK);
    }
    if (op === 0x05) {
      if (dme.turning) return finish(LT_STATUS.TURNING);
      if (dme.count === 0) return finish(LT_STATUS.OK);
      const img = new Uint8Array(CAL_LENGTH);
      for (let i = 0; i < CAL_LENGTH; i++) img[i] = cal(i);
      for (let s = dme.count - 1; s >= 0; s--) {
        const d = slotAt(s);
        for (let i = 0; i < d.end - d.base; i++)
          img[d.base - CAL_BASE + i] = any(d.mirror + i);
      }
      dme.saved = img;
      flash.clear(); // the sector is erased: the shelf is blank again
      ram.clear();
      dme.count = 0;
      return null;
    }
    if (op === 0x06) {
      const at = (data[3] << 16) | (data[4] << 8) | data[5];
      const nn = data[6];
      if (
        !nn ||
        nn > 32 ||
        (at | nn) & 1 ||
        at < LT_SHELF[0] ||
        at + nn > LT_SHELF[1]
      )
        return finish(LT_STATUS.RANGE);
      for (let i = 0; i < nn; i++)
        if (cal(at + i) !== 0xff) return finish(LT_STATUS.USED);
      for (let i = 0; i < nn; i++) flash.set(at + i, data[7 + i]);
      dme.programs++;
      return finish(LT_STATUS.OK);
    }
    if (op === 0x07) {
      const slot = data[3];
      const offset = (data[4] << 16) | (data[5] << 8) | data[6];
      const length = (data[7] << 8) | data[8];
      let mirror = (data[9] << 16) | (data[10] << 8) | data[11];
      if (slot > dme.count) return finish(LT_STATUS.SLOT);
      if (slot >= SLOTS2) return finish(LT_STATUS.FULL);
      if (!length || offset + length > CAL_LENGTH)
        return finish(LT_STATUS.RANGE);
      const inRam = POOLS.concat(V >= 3 ? [SINGLES_POOL] : []).some(
        ([lo, hi]) => mirror >= lo && mirror + length <= hi
      );
      if (!inRam && (mirror < LT_SHELF[0] || mirror + length > LT_SHELF[1]))
        return finish(LT_STATUS.ROOM);
      const base = (CAL_BASE + offset) >>> 0;
      if (inRam) {
        const old = slot < dme.count ? slotAt(slot) : null;
        const from = old && old.base === base ? old.mirror : base;
        const seed = [];
        for (let i = 0; i < length; i++) seed.push(any(from + i));
        seed.forEach((v, i) => wr(mirror + i, v));
      } else mirror = (CAL_BASE + mirror) >>> 0;
      putBe32(DESC2, DESC_MAGIC);
      putBe32(DESC2 + 4 + slot * 12, base);
      putBe32(DESC2 + 8 + slot * 12, (base + length) >>> 0);
      putBe32(DESC2 + 12 + slot * 12, (mirror - base) >>> 0);
      if (slot === dme.count) {
        dme.count++;
        putBe32(DESC2 + 4 + dme.count * 12, 0);
        putBe32(STATE + 8, dme.count);
      }
      putBe32(STATE + 28, mirror);
      return finish(LT_STATUS.OK);
    }
    return finish(LT_STATUS.OP);
  };
  return dme;
}

/** Open a table and set every byte of it to `value`. */
async function fill(lt, offset, length, value) {
  const t = await lt.open(offset, length);
  await lt.sync(t, new Uint8Array(length).fill(value), 1);
  return t;
}

(async () => {
  console.log('\nlive-tune client');

  // 1. absent build
  {
    const dme = makeDme2({ built: false });
    const lt = new LiveTune(dme.send);
    let err = null;
    try {
      await lt.open(0x100, 16);
    } catch (e) {
      err = e;
    }
    assert(
      err instanceof LtError && err.code === 'absent',
      'absent build reported'
    );
    ok('a DME without the build is reported absent');
  }

  // 1b. ping is the build probe: null on a fresh DME without the build,
  //     a state on a fresh build DME (whose block is zero until op 04 runs)
  {
    const absent = new LiveTune(makeDme2({ built: false }).send);
    assert.strictEqual(await absent.ping(), null, 'ping sees no build');
    const built = new LiveTune(makeDme2().send);
    const st = await built.ping();
    assert(
      st && st.count === 0,
      'ping brings the block up on a fresh build DME'
    );
    ok('ping distinguishes the build even before any table is open');
  }

  // 2. open seeds + found by base
  {
    const dme = makeDme2();
    const lt = new LiveTune(dme.send);
    const t = await lt.open(0x4395, 16); // the odd-aligned byte curve the DME tests use
    assert.strictEqual(t.slot, 0);
    const want = Uint8Array.from(
      { length: 16 },
      (_, i) => ((0x4395 + i) * 7 + 0x11) & 0xff
    );
    assert.deepStrictEqual(
      [...t.shadow],
      [...want],
      'mirror seeded from the calibration'
    );
    const t2 = await lt.open(0x4395, 16);
    assert.strictEqual(
      t2,
      t,
      'a second open of the same range returns the same entry'
    );
    assert.strictEqual(dme.count, 1, 'and does not open a second slot');
    ok('open seeds the mirror and is found by base, idempotently');
  }

  // 2b. a range the DME already holds open is adopted, not opened twice:
  //     a second client (a reloaded page) lands on the same slot and mirror
  {
    const dme = makeDme2();
    const first = await new LiveTune(dme.send).open(0x1624, 1);
    const again = new LiveTune(dme.send); // the page was reloaded
    const t = await again.open(0x1624, 1);
    assert.strictEqual(dme.count, 1, 'no duplicate descriptor');
    assert.strictEqual(t.slot, first.slot);
    assert.strictEqual(
      t.mirror,
      first.mirror,
      "the mirror is the descriptor's, not the last op's"
    );
    await again.sync(t, Uint8Array.of(0xe6), 1);
    const back = await again.readMemory(first.mirror, 1);
    assert.strictEqual(
      back[0],
      0xe6,
      'the write landed in the mirror the DME reads'
    );
    const fresh = new LiveTune(dme.send);
    assert.strictEqual(
      await fresh.adopt(),
      1,
      'a new client takes over what is open'
    );
    assert.strictEqual(fresh.tables[0].shadow[0], 0xe6, 'with its live value');
    await fresh.closeAll();
    assert.strictEqual(dme.count, 0, 'and can close it');
    ok(
      'a table already open on the DME is adopted with its own slot and mirror'
    );
  }

  // 3. sync sends only diffs, cell-aligned
  {
    const dme = makeDme2();
    const lt = new LiveTune(dme.send);
    const t = await lt.open(0x5000, 32);
    const want = t.shadow.slice();
    want[10] = want[10] ^ 0xff; // one byte in a 16-bit cell at offset 10
    const sent = await lt.sync(t, want, 2);
    assert.strictEqual(
      sent,
      2,
      'a one-byte change in a 16-bit cell sends the whole cell'
    );
    assert.strictEqual(t.shadow[10], want[10], 'shadow tracks the write');
    // and the mirror on the DME holds it
    const back = await lt.readMemory(t.mirror, 32);
    assert.deepStrictEqual(
      [...back],
      [...t.shadow],
      'the mirror equals the shadow'
    );
    ok('sync sends only the differing cell, aligned, and the shadow tracks it');
  }

  // 4. refusals: write out of range, open with no room
  {
    const dme = makeDme2();
    const lt = new LiveTune(dme.send);
    const t = await lt.open(0x6000, 16);
    let err = null;
    try {
      await lt.writeRun(
        t,
        8,
        Uint8Array.from({ length: 16 }, () => 0)
      );
    } catch (e) {
      err = e;
    }
    assert(
      err instanceof LtError && err.code === 'refused',
      'out-of-range write refused'
    );
    ok('a write past the table end is refused');

    const dme2 = makeDme2();
    const lt2 = new LiveTune(dme2.send);
    await lt2.open(0, LT_POOLS[0][1] - LT_POOLS[0][0]); // fills pool 0 exactly
    await lt2.open(0x1000, 100); // fills pool 1 exactly
    let err2 = null;
    try {
      await lt2.open(0x2000, 600);
    } catch (e) {
      err2 = e;
    } // 600 is more than any pool holds: nothing to park for it
    assert(
      err2 instanceof LtError && err2.code === 'room',
      'no-room open refused'
    );
    ok('an open with no pool big enough is refused with room');
  }

  // 5. save: turning refuses; stopped saves and resets
  {
    const dme = makeDme2({ turning: true });
    const lt = new LiveTune(dme.send);
    const t = await lt.open(0x4395, 16);
    const want = t.shadow.slice();
    want[0] ^= 0x55;
    await lt.sync(t, want, 1);
    let err = null;
    try {
      await lt.save();
    } catch (e) {
      err = e;
    }
    assert(
      err instanceof LtError && err.code === 'turning',
      'turning refuses the save'
    );
    ok('a save with the engine turning is refused');

    dme.turning = false;
    await lt.save(); // silence => saved
    assert(dme.saved, 'the DME folded a calibration');
    assert.strictEqual(
      dme.saved[0x4395],
      want[0],
      'the edit landed in the saved calibration'
    );
    assert.strictEqual(
      lt.tables.length,
      0,
      'the client forgot its tables after the reset'
    );
    ok('a save with the engine stopped folds the edit and resets');
  }

  // 6. the send-path frames a request and strips the answer
  {
    let tx = null;
    const send = loadSender((out) => (tx = out), [0x7f, 0x2c, 0x12]);
    const answer = await send([0x2c, 0x6c, 0x04]);
    assert.deepStrictEqual(
      tx,
      [0xb8, 0x12, 0xf1, 3, 0x2c, 0x6c, 0x04],
      'request framed B8 12 F1 len data'
    );
    assert.deepStrictEqual(
      answer,
      [0x7f, 0x2c, 0x12],
      'answer stripped to data bytes'
    );
    ok('the send-path frames the request and strips the answer to data bytes');
  }

  // 7. the client places the mirror, in RAM
  {
    const dme = makeDme2();
    const lt = new LiveTune(dme.send);
    assert.strictEqual((await lt.ping()).version, LT_VERSION);
    const t = await fill(lt, 0x4395, 16, 0xa5);
    assert.strictEqual(t.slot, 0);
    assert.strictEqual(t.mirror, LT_POOLS[0][0], 'first fit in the first pool');
    assert.strictEqual(dme.lookup(0x4395, 7), 0xa5, 'the DME reads the edit');
    const u = await lt.open(0x5000, 16);
    assert.strictEqual(u.mirror, LT_POOLS[0][0] + 16, 'the next one beside it');
    assert(
      !dme.ops.includes(0x01) && dme.programs === 0,
      'no op 01, nothing shelved while RAM lasts'
    );
    let err = null;
    try {
      await lt.open(0x1000, 600);
    } catch (e) {
      err = e;
    }
    assert(
      err instanceof LtError && err.code === 'room',
      'a table no pool holds is refused'
    );
    ok('the mirrors are placed by the client');
  }

  // 8. RAM runs out: the table edited longest ago moves to the shelf, still
  //    read by the DME; editing it again swaps them
  {
    const dme = makeDme2();
    const lt = new LiveTune(dme.send);
    const a = await fill(lt, 0x1000, 500, 0xaa); // only the first pool holds 500
    const b = await fill(lt, 0x2000, 500, 0xbb);
    assert(lt.shelved(a) && !lt.shelved(b), 'the older one went to the shelf');
    assert.strictEqual(a.mirror, (CAL_BASE + LT_SHELF[0]) >>> 0);
    assert.strictEqual(
      b.mirror,
      LT_POOLS[0][0],
      'and the new one took its RAM'
    );
    assert.strictEqual(
      dme.lookup(0x1000, 499),
      0xaa,
      'the DME reads the shelved edit'
    );
    assert.strictEqual(dme.lookup(0x2000, 0), 0xbb);
    assert.strictEqual(dme.flash.get(LT_SHELF[0] + 499), 0xaa);

    const again = await fill(lt, 0x1000, 500, 0xcc); // edit the shelved one
    assert.strictEqual(again, a);
    assert(!lt.shelved(a) && lt.shelved(b), 'they swapped');
    assert.strictEqual(
      b.mirror,
      (CAL_BASE + LT_SHELF[0] + 500) >>> 0,
      'the shelf only grows'
    );
    assert.strictEqual(dme.lookup(0x1000, 3), 0xcc);
    assert.strictEqual(
      dme.lookup(0x2000, 499),
      0xbb,
      'and neither edit was lost'
    );
    assert.strictEqual(dme.count, 2, 'two slots throughout');
    const back = await lt.readTable(b, 0, 500);
    assert(
      back.every((v) => v === 0xbb),
      'a shelved table reads back through the calibration'
    );
    ok(
      'RAM running out parks the oldest table on the shelf, and editing it brings it back'
    );
  }

  // 9. small tables: twenty of them, the twenty-first is refused as full
  {
    const dme = makeDme2();
    const lt = new LiveTune(dme.send);
    for (let i = 0; i < 36; i++) await fill(lt, 0x3000 + 0x40 * i, 0x40, i + 1); // 2304 B: more than RAM
    assert.strictEqual(dme.count, 36);
    for (let i = 0; i < 36; i++)
      assert.strictEqual(
        dme.lookup(0x3000 + 0x40 * i, 0x3f),
        i + 1,
        `table ${i}`
      );
    assert(
      lt.tables.some((t) => lt.shelved(t)),
      'some had to be shelved'
    );
    let err = null;
    try {
      await lt.open(0x6000, 16);
    } catch (e) {
      err = e;
    }
    assert(
      err instanceof LtError && err.code === 'full',
      'the thirty-seventh is refused'
    );
    ok('thirty-six tables stay open in more bytes than RAM holds');
  }

  // 10. a reloaded page takes shelved tables over and shelves past them
  {
    const dme = makeDme2();
    const first = new LiveTune(dme.send);
    await fill(first, 0x1000, 500, 0xaa);
    await fill(first, 0x2000, 500, 0xbb); // 0x1000 is on the shelf now
    const lt = new LiveTune(dme.send);
    await lt.ping();
    assert.strictEqual(await lt.adopt(), 2);
    const a = lt.tables.find((t) => t.offset === 0x1000);
    assert(
      lt.shelved(a) && a.shadow.every((v) => v === 0xaa),
      'the shelved table came with its edit'
    );
    await fill(lt, 0x3000, 500, 0xdd); // parks 0x2000 past what is on the shelf
    const b = lt.tables.find((t) => t.offset === 0x2000);
    // the search for the shelf's blank part reads in steps of sixteen bytes
    assert.strictEqual(b.mirror, (CAL_BASE + LT_SHELF[0] + 512) >>> 0);
    assert.strictEqual(dme.lookup(0x1000, 0), 0xaa);
    assert.strictEqual(dme.lookup(0x2000, 0), 0xbb);
    assert.strictEqual(dme.lookup(0x3000, 0), 0xdd);
    ok('a reloaded page adopts shelved tables and never writes over them');
  }

  // 11. what an earlier session left on the shelf (closed, never saved) is
  //     found by the search, and a blank-looking hole in it by the DME
  {
    const dme = makeDme2();
    for (let i = 0; i < 0x700; i++) dme.flash.set(LT_SHELF[0] + i, 0x33);
    const lt = new LiveTune(dme.send);
    await fill(lt, 0x1000, 500, 0xaa);
    await fill(lt, 0x2000, 500, 0xbb);
    const a = lt.tables.find((t) => t.offset === 0x1000);
    assert.strictEqual(
      a.mirror,
      (CAL_BASE + LT_SHELF[0] + 0x700) >>> 0,
      'parked right after the old data'
    );
    assert.strictEqual(dme.lookup(0x1000, 250), 0xaa);

    const holed = makeDme2();
    for (let i = 0; i < 0x10; i++) holed.flash.set(LT_SHELF[0] + i, 0x33);
    for (let i = 0x60; i < 0x80; i++) holed.flash.set(LT_SHELF[0] + i, 0x44); // blank from 0x10 to 0x60
    const lt2 = new LiveTune(holed.send);
    lt2.shelfAt = LT_SHELF[0] + 0x10; // as if the search had landed in the hole
    await fill(lt2, 0x1000, 500, 0xaa);
    await fill(lt2, 0x2000, 500, 0xbb);
    const a2 = lt2.tables.find((t) => t.offset === 0x1000);
    assert.strictEqual(
      a2.mirror,
      (CAL_BASE + LT_SHELF[0] + 0x90) >>> 0,
      'moved on past the written part'
    ); // in whole requests
    assert.strictEqual(holed.lookup(0x1000, 499), 0xaa);
    assert.strictEqual(
      holed.flash.get(LT_SHELF[0] + 0x60),
      0x44,
      'nothing written over'
    );
    ok('old shelf contents are skipped, never written over');
  }

  // 12. a full shelf says so; a save folds shelved and RAM tables and empties it
  {
    const dme = makeDme2();
    for (let i = 0; i < LT_SHELF[1] - LT_SHELF[0] - 0x100; i++)
      dme.flash.set(LT_SHELF[0] + i, 0x33);
    const lt = new LiveTune(dme.send);
    await fill(lt, 0x1000, 500, 0xaa);
    let err = null;
    try {
      await lt.open(0x2000, 500);
    } catch (e) {
      err = e;
    }
    assert(
      err instanceof LtError &&
        err.code === 'room' &&
        /shelf/.test(err.message),
      'a full shelf is reported'
    );
    assert.strictEqual(
      dme.lookup(0x1000, 0),
      0xaa,
      'and the open table is untouched'
    );

    const dme2 = makeDme2();
    const lt2 = new LiveTune(dme2.send);
    await fill(lt2, 0x1000, 500, 0xaa);
    await fill(lt2, 0x2000, 500, 0xbb);
    await lt2.save();
    assert(
      dme2.saved &&
        dme2.saved[0x1000 + 499] === 0xaa &&
        dme2.saved[0x2000] === 0xbb,
      'both folded in'
    );
    assert.strictEqual(lt2.tables.length, 0);
    assert.strictEqual(
      lt2.shelfAt,
      null,
      'the shelf is looked at afresh after a save'
    );
    await fill(lt2, 0x1000, 500, 0x11);
    await fill(lt2, 0x2000, 500, 0x22);
    assert.strictEqual(
      lt2.tables[0].mirror,
      (CAL_BASE + LT_SHELF[0]) >>> 0,
      'and starts from its bottom again'
    );
    ok('a full shelf is reported; a save folds everything and empties it');
  }

  // 13. single values are live
  {
    const singles = {
      pool: [
        [0x1944, 1],
        [0x1950, 2],
      ], // two values the program reads often
      runs: [
        [0x1900, 0x1960],
        [0x5b40, 0x5b60],
      ], // where every reader is patched
    };
    const dme = makeDme2({ singles });
    const lt = new LiveTune(dme.send);
    assert.strictEqual((await lt.ping()).version, LT_VERSION);
    assert.strictEqual(await lt.loadSingles(), true);
    assert.deepStrictEqual([...lt.singles.pool.keys()], [0x1944, 0x1950]);
    assert.strictEqual(
      lt.singles.pool.get(0x1950).address,
      SINGLES_POOL[0] + 1
    );
    assert(
      lt.liveSingle(0x1944, 1) &&
        lt.liveSingle(0x1910, 2) &&
        lt.liveSingle(0x5b46, 2)
    );
    assert(
      !lt.liveSingle(0x2000, 1),
      'a value outside the runs waits for a save'
    );
    assert(
      !lt.liveSingle(0x1950, 1) && !lt.liveSingle(0x1943, 2),
      'a range that only part-matches a pooled value too'
    );

    // the speed limit: a byte with RAM of its own -- edited where the program reads it
    const vmax = await lt.open(0x1944, 1);
    assert(
      vmax.fixed && vmax.mirror === SINGLES_POOL[0],
      "the mirror is the value's own RAM"
    );
    await lt.sync(vmax, Uint8Array.of(0xff), 1);
    assert.strictEqual(dme.single(0x1944), 0xff, 'what the program reads');
    // another, read through the trap: a small mirror like any table
    const other = await lt.open(0x5b46, 2);
    assert(!other.fixed && other.mirror === LT_POOLS[0][0]);
    await lt.sync(other, Uint8Array.of(0x0b, 0xb8), 2);
    assert.strictEqual(
      (dme.single(0x5b46, 0) << 8) | dme.single(0x5b46, 1),
      3000
    );

    // RAM filling up parks tables, never a value on its own RAM
    await fill(lt, 0x1000, 500, 0xaa);
    await fill(lt, 0x2100, 500, 0xbb);
    assert(!lt.shelved(vmax) && vmax.mirror === SINGLES_POOL[0]);
    assert.strictEqual(dme.single(0x1944), 0xff);
    assert.strictEqual(
      (dme.single(0x5b46, 0) << 8) | dme.single(0x5b46, 1),
      3000,
      'the small mirror survived, wherever it is'
    );

    // a reloaded page knows the value's mirror is its own RAM
    const again = new LiveTune(dme.send);
    await again.ping();
    await again.loadSingles();
    await again.adopt();
    assert(again.tables.find((t) => t.offset === 0x1944).fixed);

    await lt.closeAll();
    assert.strictEqual(
      dme.single(0x1944),
      (0x1944 * 7 + 0x11) & 0xff,
      'close-all puts the calibration back'
    );

    // thirty-six slots; and a DME without the table sends single values as before
    const many = new LiveTune(makeDme2().send);
    for (let i = 0; i < 36; i++) await many.open(0x3000 + 4 * i, 2);
    let err = null;
    try {
      await many.open(0x6000, 2);
    } catch (e) {
      err = e;
    }
    assert(err instanceof LtError && err.code === 'full');
    assert.strictEqual(await many.loadSingles(), false);
    assert(!many.liveSingle(0x1944, 1));
    ok(
      'single values are edited live, in place where they have RAM of their own'
    );
  }

  // 13b. build 6: a single value no pool holds goes on the data breakpoint,
  //      the last one edited; the one before it waits for a save again
  {
    const singles = { pool: [[0x1944, 1]], runs: [] };
    const dme = makeDme2({ singles });
    const lt = new LiveTune(dme.send);
    await lt.ping();
    await lt.loadSingles();
    assert(lt.canWatch() && !lt.liveSingle(0x5b46, 2));
    const a = await lt.open(0x5b46, 2);
    await lt.sync(a, Uint8Array.of(0x0b, 0xb8), 2);
    await lt.watch(a);
    assert(lt.liveSingle(0x5b46, 2));
    assert.deepStrictEqual((await lt.readState()).watch, [
      (CAL_BASE + 0x5b46) >>> 0,
      (CAL_BASE + 0x5b48) >>> 0,
    ]);
    assert.strictEqual(
      (dme.single(0x5b46) << 8) | dme.single(0x5b46, 1),
      3000,
      'the program reads the mirror'
    );
    // another value takes the breakpoint over
    const b = await lt.open(0x2000, 1);
    await lt.sync(b, Uint8Array.of(0x42), 1);
    await lt.watch(b);
    assert(lt.liveSingle(0x2000, 1) && !lt.liveSingle(0x5b46, 2));
    assert.strictEqual(dme.single(0x2000), 0x42);
    assert.strictEqual(
      dme.single(0x5b46),
      (0x5b46 * 7 + 0x11) & 0xff,
      'the first waits for a save'
    );
    // RAM filling up parks the watched value: the breakpoint follows it to the shelf
    await fill(lt, 0x1000, 500, 0xaa);
    await fill(lt, 0x2100, 500, 0xbb);
    assert(lt.shelved(b) && dme.watch.mirror >= CAL_BASE);
    assert.strictEqual(dme.single(0x2000), 0x42);
    // a reloaded page knows which value is on the breakpoint
    const again = new LiveTune(dme.send);
    await again.ping();
    await again.loadSingles();
    await again.adopt();
    assert(again.liveSingle(0x2000, 1) && !again.liveSingle(0x5b46, 2));
    await lt.unwatch();
    assert(!lt.liveSingle(0x2000, 1));
    assert.strictEqual(dme.single(0x2000), (0x2000 * 7 + 0x11) & 0xff);
    await lt.watch(b);
    await lt.closeAll();
    assert(!dme.watch && !lt.watching);
    // a build-5 DME has no breakpoint: driven as before, nothing asked of it
    const v5 = new LiveTune(makeDme2({ version: 5, singles }).send);
    await v5.ping();
    assert(v5.supported() && !v5.canWatch());
    assert.strictEqual((await v5.readState()).watch, null);
    ok(
      'build 6 keeps the last single value edited live on the data breakpoint'
    );
  }

  // 14. the key-off keeps a tune only when asked
  {
    const dme = makeDme2();
    const lt = new LiveTune(dme.send);
    assert.strictEqual((await lt.ping()).version, LT_VERSION);
    await fill(lt, 0x1000, 16, 0xaa);
    assert.strictEqual(
      await lt.saveAsked(),
      false,
      'nothing is kept until asked'
    );
    await lt.askSave(true);
    assert.strictEqual(await lt.saveAsked(), true);
    const again = new LiveTune(dme.send); // a reloaded page reads the request back
    await again.ping();
    assert.strictEqual(await again.saveAsked(), true);
    await lt.askSave(false);
    assert.strictEqual(await lt.saveAsked(), false, 'and it can be taken back');
    assert.strictEqual(dme.count, 1, 'asking closes nothing');
    ok('the key-off saves only when asked, and the request can be taken back');
  }

  // 15. an earlier build is refused, not driven with the wrong layout
  {
    const old = new LiveTune(makeDme2({ version: 4 }).send);
    await old.ping();
    assert.strictEqual(old.version, 4);
    assert(!old.supported());
    let err = null;
    try {
      await old.open(0x1000, 16);
    } catch (e) {
      err = e;
    }
    assert(
      err instanceof LtError &&
        err.code === 'refused' &&
        /build 4/.test(err.message),
      'an old build is refused by name'
    );
    ok('a DME on an earlier build is refused with its version');
  }

  // 16. no pool may overlap the DME's own buffers: the request buffer
  //     (0x3F9A44-0x3F9B42) and the value-list store (0x3F9B43-0x3F9C42)
  //     that a tester's 2C F0 define writes, which once smashed pool B
  {
    for (const [lo, hi] of LT_POOLS)
      assert(
        hi <= 0x3f9a44 || lo >= 0x3f9c43,
        `pool ${lo.toString(16)}-${hi.toString(16)} overlaps the DME's buffers`
      );
    ok("no mirror pool overlaps the DME's request buffer or value-list store");
  }

  console.log(`\n${passed} passed\n`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
