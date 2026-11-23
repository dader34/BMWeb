#!/usr/bin/env node
// The flashing screens' write flows (app/renderer/screens/flashing/
// dme-flash.js, dme-fast.js, dme-oneclick.js, faults-page.js), each loaded
// as the page loads it -- one classic script in a scope of globals -- with
// the car, the dialogs and the engines stood in for.
//
// WHAT THIS PROVES
//   1. Flash Tune: only a write that went through is followed by the
//      re-identify and the fault clear. A write declined at the map switch
//      warning, or one that threw before it started, is followed by neither,
//      ends on the words History reads as "not written", and still closes
//      its session.
//   2. A file that is not a calibration stops where every tune flash
//      prepares it, before a session is opened.
//   3. The one-click: the tune is prepared (its KWP read, its header check)
//      BEFORE the DME is fired into the flasher, with a read that cannot go
//      on to unlock the loader; Flash Program hands the entry to the flash
//      to run once everything is built.
//   4. A fast-flasher session asks before every WRITE, whichever way the
//      flasher was reached; only a read from a one-click-started body goes
//      without a second question.
//   5. The fault page's live scan: with the cable out it rests instead of
//      asking for a port from a timer; while Clear Faults asks its question
//      no scan read can start under it.
//
// Run: node tools/verify/test_flash_screens.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
const ok = (m) => {
  passed++;
  console.log(`  ok    ${m}`);
};
const screen = (name) =>
  fs.readFileSync(
    path.join(__dirname, '../../app/renderer/screens/flashing', name),
    'utf8'
  );

/** A scope with the screen's globals stood in for; `calls` records what ran. */
function scope(extra = {}) {
  const calls = [];
  const rec =
    (name, ret) =>
    async (...a) => {
      calls.push([name, ...a]);
      return typeof ret === 'function' ? ret(...a) : ret;
    };
  const ctx = {
    console,
    calls,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Uint8Array,
    MS45_CAL_LENGTH: 0x1d000,
    MS45_CAL_START: 0x40000,
    MS45_FULL_FLASH_LENGTH: 0x100000,
    FB_FLASH_CANCELLED: 'Cancelled: nothing was written',
    fbState: {
      running: false,
      dme: {
        identified: true,
        flash: new Uint8Array(0x1d000),
        mpc: new Uint8Array(0x70000),
        flashName: 'tune.bin',
        fullBin: false,
        carMapLayout: null,
        carMapCount: null,
        ident: {
          vin: 'WBATEST',
          hwRef: '0044570',
          progRef: 'OTHER',
          diagProtocol: 'KWP2000*',
        },
        bootLoader: null,
        fastFlasher: null,
      },
    },
    statuses: [],
    fbSetStatus: (t) => ctx.statuses.push(t),
    fbSetStatusInPlace: () => {},
    fbFlashingBar: () => {},
    fbProgress: () => {},
    fbLog: () => {},
    fbDescribeError: (e) => (e && e.message) || String(e),
    flashLog: {
      note: () => {},
      attach: () => {},
      trace: () => {},
      // how the flow says the session went (History's result)
      outcome: (r) => ctx.calls.push(['outcome', r]),
    },
    fbSessionStart: rec('session-start'),
    fbSessionStop: rec('session-stop'),
    fbConfirm: rec('confirm', true),
    fbMessage: rec('message'),
    fbDmeIdentify: rec('identify'),
    fbFaultsClearAfterFlash: rec('clear-faults'),
    fbFlashRun: rec('flash-run', { ok: true, status: 'Flash successful' }),
    fbDmeIsMs451: () => true,
    fbDmeIsMs45: () => true,
    ewsDelete: {
      SUPPORTED_PROGRAM_VERSION: '0044570LO02S',
      PROGRAM_STATE_OFFSET: 0xdb1c7,
      PROGRAM_MASK_OFFSET: 0xdb1d3,
      programBytesAreDeleted: () => false,
      calibrationHasStockImmobilizer: () => false,
    },
    mapSwitch: { readDataVersion: () => 'V1' },
    ms45ReadCarBytes: rec('read-car', null),
    ms45Checksums: {
      parameterProblem: () => ctx.badCal || null,
      programProblem: () => null,
      correctParameterChecksums: (c) => c,
      signParameters: (c) => c,
      correctProgramChecksums: (f) => f,
      signProgram: (f) => f,
    },
    badCal: null,
    ...extra,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  return ctx;
}

(async () => {
  // ---- 1. Flash Tune's after-steps ------------------------------------------
  console.log('\nFlash Tune');
  {
    const c = scope();
    vm.runInContext(screen('dme-flash.js'), c);
    await vm.runInContext('fbDmeFlashTune()', c);
    const names = c.calls.map((x) => x[0]);
    assert.deepStrictEqual(
      names.filter((n) => /identify|clear-faults|session/.test(n)),
      ['session-start', 'identify', 'clear-faults', 'session-stop'],
      'a write that went through: identified again, faults cleared, session closed'
    );
    ok('a finished write is followed by the re-identify and the fault clear');
  }
  {
    // the map switch warning, declined
    const c = scope();
    c.fbState.dme.carMapLayout = 'blocks';
    c.fbState.dme.carMapCount = 3;
    c.fbConfirm = async (...a) => {
      c.calls.push(['confirm', ...a]);
      return false;
    };
    vm.runInContext(screen('dme-flash.js'), c);
    await vm.runInContext('fbDmeFlashTune()', c);
    const names = c.calls.map((x) => x[0]);
    assert.ok(!names.includes('flash-run'), 'nothing was sent');
    assert.ok(
      !names.includes('identify') && !names.includes('clear-faults'),
      'a declined write is not followed by an identify or a fault clear'
    );
    assert.ok(names.includes('session-stop'), 'the session is closed');
    assert.deepStrictEqual(c.statuses, ['Cancelled: nothing was written']);
    assert.deepStrictEqual(
      c.calls.filter((x) => x[0] === 'outcome'),
      [['outcome', 'cancelled']],
      'and History is told it was cancelled, not left to read the words'
    );
    ok(
      'a write declined at the map switch warning: no identify, no fault clear, the words of a cancelled write'
    );
  }
  {
    // the flash itself throws
    const c = scope();
    c.fbFlashRun = async () => {
      c.calls.push(['flash-run']);
      throw new Error('the cable went away');
    };
    vm.runInContext(screen('dme-flash.js'), c);
    await assert.rejects(
      vm.runInContext('fbDmeFlashTune()', c),
      /the cable went away/
    );
    assert.deepStrictEqual(
      c.calls.filter((x) => x[0] === 'outcome'),
      [['outcome', 'failed']],
      'a flash that threw is recorded as failed'
    );
    const names = c.calls.map((x) => x[0]);
    assert.ok(
      !names.includes('identify') && !names.includes('clear-faults'),
      'a write that threw is not followed by an identify or a fault clear'
    );
    assert.ok(names.includes('session-stop'));
    ok('a write that threw: no identify, no fault clear, the session closed');
  }
  {
    // the identify after a good write throws: the session still closes
    const c = scope();
    c.fbDmeIdentify = async () => {
      c.calls.push(['identify']);
      throw new Error('identify slipped');
    };
    vm.runInContext(screen('dme-flash.js'), c);
    await assert.rejects(
      vm.runInContext('fbDmeFlashTune()', c),
      /identify slipped/
    );
    assert.ok(c.calls.map((x) => x[0]).includes('session-stop'));
    ok('a slip in the steps after the write still closes the session');
  }

  // ---- 2. a file that is not a calibration ----------------------------------
  console.log('\nthe calibration check');
  {
    const c = scope();
    c.badCal = 'its header does not name one checksum segment';
    vm.runInContext(screen('dme-flash.js'), c);
    await assert.rejects(
      vm.runInContext('fbDmeFlashTune()', c),
      /tune\.bin is not a calibration the DME would accept.*Nothing was sent/
    );
    assert.ok(!c.calls.map((x) => x[0]).includes('flash-run'));
    assert.throws(
      () =>
        vm.runInContext(
          'fbDmeChipImage(new Uint8Array(0x100000), new Uint8Array(0x70000), true)',
          c
        ),
      /not a program the DME would accept/
    );
    ok(
      'a file that is not a calibration stops at the prepare, for the tune and for a program pair that carries one'
    );
  }
  {
    // the one-click's plain read never asks for security access
    const c = scope();
    c.fbState.dme.ident.progRef = '0044570LO02S';
    vm.runInContext(screen('dme-flash.js'), c);
    await vm.runInContext('fbDmePrepareTuneCal({ plainRead: true })', c);
    await vm.runInContext('fbDmePrepareTuneCal()', c);
    const reads = c.calls.filter((x) => x[0] === 'read-car');
    assert.strictEqual(reads[0][4], 'BMW-FAST');
    assert.strictEqual(reads[1][4], 'KWP2000*');
    ok(
      'plainRead reads as the protocol that never unlocks; the stock path as the DME reported'
    );
  }

  // ---- 3. the one-click's order ------------------------------------------------
  console.log('\none-click');
  {
    const fired = [];
    const c = scope({
      fbFastFlasherWanted: () => true,
      webBus: { port: { setSignals: async () => {} } },
      fastFlasherBlob: {},
      triggerWire: { triggerBodyFromBlob: () => new Uint8Array(8) },
      oneClick: {
        grantAndFire: async () => {
          fired.push('fire');
        },
      },
      ms45LiveTuneSender: () => async () => null,
      fbDmeProgramTuneNote: () => '',
      fbDmeProgramLead: () => '',
      fbDmeProgramHasNoTune: () => false,
      fastFlashWire: {},
    });
    let spec = null;
    c.fbDmeFastFlash = async (s) => {
      spec = s;
    };
    let prepOpts = null;
    c.fbDmePrepareTuneCal = async (o) => {
      prepOpts = o;
      throw new Error('not a calibration');
    };
    let program = null;
    c.fbDmeFastFlashProgram = async (o) => {
      program = o;
    };
    vm.runInContext(screen('dme-oneclick.js'), c);
    await vm.runInContext('fbDmeOneClickFlashTune()', c);
    assert.ok(spec && spec.confirmed === true && spec.what === 'calibration');
    await assert.rejects(spec.prepare(), /not a calibration/);
    // (an object from the script's own realm: compared by its field)
    assert.strictEqual(prepOpts && prepOpts.plainRead, true);
    assert.deepStrictEqual(
      fired,
      [],
      'the DME was not fired into the flasher before the tune was prepared'
    );
    ok(
      'Flash Tune: the tune is prepared, by a plain read, before the entry -- a bad file never fires the DME'
    );

    await vm.runInContext('fbDmeOneClickFlashProgram()', c);
    assert.ok(program && program.confirmed === true);
    assert.strictEqual(typeof program.enter, 'function');
    assert.deepStrictEqual(
      fired,
      [],
      'Flash Program does not enter the flasher itself'
    );
    ok(
      'Flash Program: asked first, and the entry handed to the flash to run once the images are built'
    );
  }

  // ---- 4. a session asks before every write -------------------------------------
  console.log('\nfast-flasher session');
  {
    const c = scope({
      fastFlashWire: {},
      fastFlasher: { describe: () => 'Fast flasher present' },
    });
    c.fbConfirm = async (...a) => {
      c.calls.push(['confirm', ...a]);
      return false; // declined: the session ends before anything else runs
    };
    vm.runInContext(screen('dme-fast.js'), c);
    // a one-click started the body (the tabs' autoEnter)
    c.fbState.dme.bootLoader = { version: 28, flags: 0x12, triggered: true };
    const run = (what, confirmed) =>
      vm.runInContext(
        `fbDmeFastFlash({ title: 'T', operation: 'o', what: ${JSON.stringify(what)}, confirm: 'Sure?', confirmed: ${confirmed}, note: '', push: async () => ({}) })`,
        c
      );
    for (const what of ['aif', 'boot loader', 'calibration', 'program']) {
      c.calls.length = 0;
      await run(what, false);
      assert.deepStrictEqual(
        c.calls.map((x) => x[0]),
        ['confirm'],
        `${what}: asked, and nothing started on a no`
      );
    }
    ok(
      'every write asks on a one-click-started body: the log, the boot sector, the tune, the program'
    );
    c.calls.length = 0;
    c.fbSessionStart = async () => {
      c.calls.push(['session-start']);
      throw new Error('stop here');
    };
    await assert.rejects(run('read', false), /stop here/);
    assert.deepStrictEqual(
      c.calls.map((x) => x[0]),
      ['session-start'],
      'a read on a one-click-started body goes without a second question'
    );
    c.fbState.dme.bootLoader = { version: 15, flags: 0x12 };
    c.calls.length = 0;
    c.fbSessionStart = async () => {
      c.calls.push(['session-start']);
    };
    await run('read', false);
    assert.deepStrictEqual(
      c.calls.map((x) => x[0]),
      ['confirm'],
      'a read reached by a reset (a ring) still asks'
    );
    ok('a read is only unasked when a one-click just started the body');

    // the note for a DME with no bootloader record at all
    c.fbState.dme.bootLoader = null;
    assert.strictEqual(
      vm.runInContext('fbDmeFlasherNote()', c),
      'Fast flasher present'
    );
    c.fbState.dme.bootLoader = { version: 15 };
    assert.strictEqual(vm.runInContext('fbDmeFlasherNote()', c), 'BL15');
    ok('the session note does not need a bootloader record');
  }

  // ---- 5. the fault page's live scan ----------------------------------------------
  console.log('\nfault page');
  {
    let ensured = 0;
    let confirmUp = null;
    global.fbEls = {};
    global.fbState = {
      module: 'dme',
      running: false,
      page: 'faults',
      tcu: {},
    };
    global.Settings = { get: (k, d) => d, set: () => {} };
    global.esc = (s) => String(s);
    global.webBus = { connected: false };
    global.fbOnSharedCar = () => false;
    global.fbEnsureCable = async () => {
      ensured++;
      return false;
    };
    global.fbConfirm = () =>
      new Promise((resolve) => {
        confirmUp = resolve;
      });
    global.fbSetStatus = () => {};
    const F = require('../../app/renderer/screens/flashing/faults-page.js');
    await F.fbFaultsRead(true);
    assert.strictEqual(
      ensured,
      0,
      'a scan read with the cable out does not ask for the cable'
    );
    await F.fbFaultsRead(false);
    assert.strictEqual(ensured, 1, 'a click still does');
    ok(
      'live scan with the cable out: rests, no port request from a timer; a click still asks'
    );

    F.fbFaults.scan = true;
    F.fbFaultsSchedule();
    assert.ok(F.fbFaults.timer, 'the scan is scheduled');
    const clearing = F.fbFaultsClear();
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(confirmUp, 'the question is up');
    assert.strictEqual(
      F.fbFaults.timer,
      null,
      'no scan read can start while the question is up'
    );
    confirmUp(false);
    await clearing;
    assert.ok(F.fbFaults.timer, 'declined: the scan goes on');
    clearTimeout(F.fbFaults.timer);
    F.fbFaults.scan = false;
    ok(
      'Clear Faults: the live scan rests while the question is up and resumes after'
    );
  }

  console.log(`\nflash-screens: ${passed} checks passed`);
})().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});
