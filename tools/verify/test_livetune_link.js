#!/usr/bin/env node
// Live mode's link check (tnLiveBeat in app/renderer/screens/tuning/live-mode.js):
// the ping that tells a DME that has gone quiet from one that has restarted.
//
// WHAT THIS PROVES
//   1. While the DME is being heard from (an edit, the cursor), nothing extra
//      is sent; after three quiet seconds its state is asked for.
//   2. One unanswered check is a lost telegram; two in a row is a disconnect:
//      the toolbar says so, live mode stays armed and keeps asking, faster.
//   3. Edits made while disconnected are not sent and not lost: they wait,
//      and go out when the DME answers again.
//   4. A DME that answers but holds nothing of ours has restarted: what was
//      open is dropped (resync), with no disconnect in between.
//   5. An edit that meets silence marks the link lost and keeps the edit,
//      instead of dropping out of live mode.
//   6. Disarming stops the checks.
//   7. The items that own an open range are what the list narrows to, and
//      leaving live mode widens it again.
//   9. A reloaded page goes back into live mode when it was left on: after
//      the saved session is restored, once the cable is there, and not after
//      it was switched off by hand.
//   8. Discard edits asks first, then closes every table, takes back a
//      requested save, and puts the calibration's bytes back in the editor
//      without that counting as an edit.
//
// Run: node tools/verify/test_livetune_link.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { LtError } = require('../../app/renderer/core/ms45/livetune.js');

const ITEM = { key: 'id_n_max_at', kind: 'table' };
const confirm = { answer: true };
const renders = { count: 0 };

function world() {
  let now = 1_000_000;
  const timers = [];
  const dme = {
    answering: true,
    state: { count: 1 },
    asked: 0,
    resyncs: 0,
    opens: 0,
  };
  const lt = {
    tables: [{ slot: 0, offset: 0x60e6, length: 16 }],
    readState: async () => {
      dme.asked++;
      if (!dme.answering)
        throw new LtError('silent', 'the DME did not answer a read');
      return dme.state;
    },
    resync: async () => {
      dme.resyncs++;
      lt.tables = [];
    },
    open: async () => {
      dme.opens++;
      if (!dme.answering) throw new LtError('silent', 'the DME did not answer');
      return { slot: 0, offset: 0x60e6, length: 16 };
    },
    sync: async () => {},
    closeAll: async () => {
      dme.closed = (dme.closed || 0) + 1;
      lt.tables = [];
    },
    askSave: async (on) => {
      dme.saveAsked = on;
    },
    readCal: async (offset, length) => new Uint8Array(length).fill(0x19), // what the calibration holds
    readTable: async () => new Uint8Array(16),
    liveSingle: () => true,
    singles: null,
  };
  const ctx = {
    console,
    Math,
    Map,
    Set,
    Uint8Array,
    Promise,
    LtError,
    Date: { now: () => now },
    setTimeout: (fn, ms) => timers.push(ms) && timers.length,
    clearTimeout: () => {},
    tuningState: {
      bin: new Uint8Array(0x60000),
      orig: new Uint8Array(0x60000).fill(0xff),
      fileName: 'ecu (live).bin',
      openTable: null,
      liveOnly: false,
    },
    tnItemByteRange: () => ({ start: 0x40000 + 0x60e6, end: 0x40000 + 0x60f6 }),
    window: {},
    confirmDialog: async () => confirm.answer,
    // the coverage map: one item owns the table, another the bytes after it
    tnOwnerRecordAt: (a) =>
      a >= 0x40000 + 0x60e6 && a < 0x40000 + 0x60f6
        ? { item: ITEM, start: 0x40000 + 0x60e6, end: 0x40000 + 0x60f6 }
        : null,
    tnRenderDefs: () => renders.count++,
  };
  vm.createContext(ctx);
  vm.runInContext(
    fs.readFileSync(
      path.join(__dirname, '../../app/renderer/screens/tuning/live-mode.js'),
      'utf8'
    ) +
      '\nthis.tnLive = tnLive; this.tnLiveBeat = tnLiveBeat; this.tnLiveSync = tnLiveSync; this.tnLiveDisarm = tnLiveDisarm;' +
      'this.tnLiveOnWrite = tnLiveOnWrite; this.tnLiveApplyStaged = tnLiveApplyStaged; this.tnLiveDropStaged = tnLiveDropStaged;' +
      'this.tnLiveBaseline = tnLiveBaseline; this.tnLiveBaselineKnown = tnLiveBaselineKnown;' +
      'this.tnLiveDiscard = tnLiveDiscard; this.tnLiveOpenItems = tnLiveOpenItems; this.tnLiveShowOpenOnly = tnLiveShowOpenOnly;',
    ctx,
    { filename: 'live-mode.js' }
  );
  Object.assign(ctx.tnLive, {
    armed: true,
    lt,
    heardAt: now,
    checkedAt: now,
    ed: { hex: { refresh() {} } },
  });
  return { ctx, live: ctx.tnLive, dme, lt, timers, pass: (ms) => (now += ms) };
}

let n = 0;
async function test(name, fn) {
  await fn();
  n++;
  console.log(`ok ${n} - ${name}`);
}

(async () => {
  await test('nothing is asked while the DME is being heard from', async () => {
    const w = world();
    w.pass(1000);
    await w.ctx.tnLiveBeat();
    w.pass(1000);
    w.live.heardAt = w.ctx.Date.now(); // the cursor just read something
    w.pass(2500);
    await w.ctx.tnLiveBeat();
    assert.strictEqual(w.dme.asked, 0);
    w.pass(600); // now three seconds of quiet
    await w.ctx.tnLiveBeat();
    assert.strictEqual(w.dme.asked, 1);
    assert.strictEqual(w.live.link, 'up');
    assert.strictEqual(w.timers[w.timers.length - 1], 1000);
  });

  await test('two unanswered checks is a disconnect; it stays armed and asks faster', async () => {
    const w = world();
    w.dme.answering = false;
    w.pass(3000);
    await w.ctx.tnLiveBeat();
    assert.strictEqual(w.live.link, 'up', 'one lost telegram is ordinary');
    w.pass(3000);
    await w.ctx.tnLiveBeat();
    assert.strictEqual(w.live.link, 'lost');
    assert.strictEqual(w.live.armed, true);
    w.pass(1000);
    await w.ctx.tnLiveBeat();
    assert.strictEqual(w.dme.asked, 2, 'not yet');
    w.pass(600);
    await w.ctx.tnLiveBeat();
    assert.strictEqual(w.dme.asked, 3, 'every 1.5 s while it is gone');
  });

  await test('edits made while disconnected wait, and are sent when it is back', async () => {
    const w = world();
    w.live.link = 'lost';
    w.live.misses = 2;
    w.live.pending.set(0x60e6, {
      offset: 0x60e6,
      length: 16,
      cell: 2,
      table: true,
    });
    await w.ctx.tnLivePump();
    assert.strictEqual(w.dme.opens, 0);
    assert.strictEqual(w.live.pending.size, 1);
    w.pass(1500);
    await w.ctx.tnLiveBeat();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(w.live.link, 'up');
    assert.strictEqual(w.dme.opens, 1);
    assert.strictEqual(w.live.pending.size, 0);
  });

  await test('a DME that answers with nothing open has restarted', async () => {
    const w = world();
    w.dme.state = null; // the state block is gone: its RAM started empty
    w.pass(3000);
    await w.ctx.tnLiveBeat();
    assert.strictEqual(w.dme.resyncs, 1);
    assert.strictEqual(w.live.link, 'up');
    assert.strictEqual(w.live.armed, true);
    assert.strictEqual(w.live.error, null);
    // and one that still holds our table is left alone
    const v = world();
    v.pass(3000);
    await v.ctx.tnLiveBeat();
    assert.strictEqual(v.dme.resyncs, 0);
  });

  await test('an edit that meets silence marks the link lost and is kept', async () => {
    const w = world();
    w.dme.answering = false;
    const range = { offset: 0x60e6, length: 16, cell: 2, table: true };
    await w.ctx.tnLiveSync([range]);
    assert.strictEqual(w.live.armed, true);
    assert.strictEqual(w.live.link, 'lost');
    assert.strictEqual(w.live.pending.size, 1);
  });

  await test('disarming stops the checks', async () => {
    const w = world();
    await w.ctx.tnLiveDisarm();
    const before = w.timers.length;
    w.pass(5000);
    await w.ctx.tnLiveBeat();
    assert.strictEqual(w.dme.asked, 0);
    assert.strictEqual(w.timers.length, before);
  });

  await test('ignition off and a pulled cable are said at once, without asking the DME', async () => {
    const w = world();
    w.ctx.webBus = {
      connected: true,
      readState: async () => ({ ignition: false, sensed: true }),
    };
    w.pass(1000);
    await w.ctx.tnLiveBeat();
    assert.strictEqual(w.live.link, 'lost');
    assert.strictEqual(w.live.why, 'ignition');
    assert.strictEqual(
      w.dme.asked,
      0,
      'the DME still answers during its after-run; it is not asked'
    );
    assert.strictEqual(w.live.armed, true);
    // back on: the DME is asked again straight away, and has restarted
    w.ctx.webBus.readState = async () => ({ ignition: true, sensed: true });
    w.dme.state = null;
    w.pass(1000);
    await w.ctx.tnLiveBeat();
    assert.strictEqual(w.live.link, 'up');
    assert.strictEqual(w.dme.resyncs, 1);
    // a cable that only assumes the ignition is on proves nothing either way
    const v = world();
    v.ctx.webBus = {
      connected: true,
      readState: async () => ({ ignition: false, derived: true }),
    };
    v.pass(1000);
    await v.ctx.tnLiveBeat();
    assert.strictEqual(v.live.link, 'up');
    // unplugged
    v.ctx.webBus.connected = false;
    v.pass(1000);
    await v.ctx.tnLiveBeat();
    assert.strictEqual(v.live.link, 'lost');
    assert.strictEqual(v.live.why, 'cable');
  });

  await test('on the blank live image the original is unknown until it is read off the car', async () => {
    const w = world();
    // nothing read yet: the snapshot is erased flash, and Revert must not use it
    assert.strictEqual(w.ctx.tnLiveBaselineKnown(ITEM), false);
    w.ctx.tnLiveBaseline(0x40000 + 0x60e6, new Uint8Array(8).fill(0x19));
    assert.strictEqual(
      w.ctx.tnLiveBaselineKnown(ITEM),
      false,
      'half a table is not a table'
    );
    w.ctx.tnLiveBaseline(0x40000 + 0x60ee, new Uint8Array(8).fill(0x19));
    assert.strictEqual(w.ctx.tnLiveBaselineKnown(ITEM), true);
    assert.strictEqual(w.ctx.tuningState.orig[0x40000 + 0x60e6], 0x19);
    assert.strictEqual(
      w.ctx.tuningState.orig[0x40000 + 0x60e5],
      0xff,
      'and nothing beside it'
    );
    // a loaded file is its own original: always known, never overwritten
    w.ctx.tuningState.fileName = 'my-tune.bin';
    w.ctx.tuningState.orig.fill(0x55);
    w.ctx.tnLiveBaseline(0x40000 + 0x60e6, new Uint8Array(16).fill(0x19));
    assert.strictEqual(w.ctx.tuningState.orig[0x40000 + 0x60e6], 0x55);
    assert.strictEqual(w.ctx.tnLiveBaselineKnown(ITEM), true);
  });

  await test('edits to the open table are held until Apply; anything else is sent at once', async () => {
    const settle = async () => {
      for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
    };
    const w = world();
    w.lt.tables = [];
    w.ctx.tnTableStages = (start) =>
      start >= 0x40000 + 0x60e6 && start < 0x40000 + 0x60f6; // the open table
    w.ctx.tnLiveOnWrite(0x40000 + 0x60e6, 2);
    w.ctx.tnLiveOnWrite(0x40000 + 0x60e8, 2);
    await settle();
    assert.strictEqual(w.dme.opens, 0, 'nothing sent while typing');
    assert.strictEqual(w.live.staged.size, 1, 'one table, however many cells');
    assert.strictEqual(w.live.pending.size, 0);
    w.ctx.tnLiveApplyStaged();
    await settle();
    assert.strictEqual(w.dme.opens, 1, 'Apply sends it');
    assert.strictEqual(w.live.staged.size, 0);
    // closed without Apply: dropped, never sent
    w.ctx.tnLiveOnWrite(0x40000 + 0x60e6, 2);
    w.ctx.tnLiveDropStaged();
    await settle();
    assert.strictEqual(w.dme.opens, 1);
    // with no table open (a single value edited in the list), it goes straight out
    w.ctx.tnTableStages = () => false;
    w.ctx.tnLiveOnWrite(0x40000 + 0x60e6, 2);
    await settle();
    assert.strictEqual(w.dme.opens, 2);
  });

  await test('the open tables are the list filter', async () => {
    const w = world();
    assert.deepStrictEqual([...w.ctx.tnLiveOpenItems()], [ITEM]);
    renders.count = 0;
    w.ctx.tnLiveShowOpenOnly(true);
    assert.strictEqual(w.ctx.tuningState.liveOnly, true);
    assert.strictEqual(renders.count, 1);
    await w.ctx.tnLiveDisarm(); // leaving live mode widens the list again
    assert.strictEqual(w.ctx.tuningState.liveOnly, false);
  });

  await test('discard closes everything and puts the calibration back in the editor', async () => {
    const w = world();
    const bin = w.ctx.tuningState.bin;
    bin.fill(0xee, 0x40000 + 0x60e6, 0x40000 + 0x60f6); // the edit, as the editor holds it
    w.live.saveAsked = true;
    w.live.pending.set(0x60e6, { offset: 0x60e6, length: 16 });
    confirm.answer = false; // asked first, and "Cancel" changes nothing
    await w.ctx.tnLiveDiscard();
    assert.strictEqual(w.dme.closed, undefined);
    assert.strictEqual(bin[0x40000 + 0x60e6], 0xee);
    confirm.answer = true;
    await w.ctx.tnLiveDiscard();
    assert.strictEqual(w.dme.closed, 1);
    assert.strictEqual(
      w.dme.saveAsked,
      false,
      'a save that was asked for is taken back'
    );
    assert.strictEqual(w.live.saveAsked, false);
    assert.strictEqual(w.live.pending.size, 0);
    assert.ok(
      bin.slice(0x40000 + 0x60e6, 0x40000 + 0x60f6).every((b) => b === 0x19)
    );
    assert.strictEqual(bin[0x40000 + 0x60e5], 0, 'and nothing next to it');
    assert.strictEqual(bin[0x40000 + 0x60f6], 0);
    assert.strictEqual(w.live.armed, true, 'live mode stays on');
    assert.strictEqual(
      w.dme.opens,
      0,
      'putting the values back is not an edit'
    );
    // and those values are now the image's original: Revert has something true to go back to
    assert.ok(
      w.ctx.tuningState.orig
        .slice(0x40000 + 0x60e6, 0x40000 + 0x60f6)
        .every((b) => b === 0x19)
    );
    assert.strictEqual(w.ctx.tnLiveBaselineKnown(ITEM), true);
  });

  await test('a reloaded page rejoins only when live mode was left on', async () => {
    const store = new Map();
    const make = () => {
      const w = world();
      w.ctx.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, v),
        removeItem: (k) => store.delete(k),
      };
      w.live.armed = false; // a fresh page
      w.live.lt = null;
      w.arms = [];
      // stand in for arming itself (it is the connecting dialog and the DME's answers)
      w.ctx.tnLiveArm = async (rejoin) => w.arms.push(rejoin);
      vm.runInContext('tnLiveArm = this.tnLiveArm;', w.ctx);
      return w;
    };
    const realTimeout = (w) => (w.ctx.setTimeout = (fn) => setImmediate(fn));
    let w = make();
    realTimeout(w);
    await vm.runInContext('tnLiveRejoin()', w.ctx);
    assert.deepStrictEqual(w.arms, [], 'never armed before: stays off');
    vm.runInContext('tnLiveRemember(true)', w.ctx); // what a successful arm does
    w = make();
    realTimeout(w);
    let restored = false;
    w.live.ed.restored = new Promise((resolve) =>
      setImmediate(() => {
        restored = true;
        resolve();
      })
    );
    await vm.runInContext('tnLiveRejoin()', w.ctx);
    assert.deepStrictEqual(w.arms, [true], 'armed again, as a reconnect');
    assert.ok(restored, 'and only after the saved session was back');
    // no cable: it waits, then stays off without forgetting
    w = make();
    let t = 0;
    w.ctx.Date = { now: () => (t += 3000) };
    realTimeout(w);
    w.ctx.webBus = { connected: false };
    await vm.runInContext('tnLiveRejoin()', w.ctx);
    assert.deepStrictEqual(w.arms, []);
    assert.strictEqual(store.get('bmweb.tuning.live'), '1');
    // switching live mode off by hand is remembered too
    w = make();
    w.live.armed = true;
    await w.ctx.tnLiveDisarm();
    assert.strictEqual(store.has('bmweb.tuning.live'), false);
  });

  console.log(`\n${n} passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
