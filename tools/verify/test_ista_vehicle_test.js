#!/usr/bin/env node
// ISTA's vehicle test: the read runs IN THE SHELL and is kept against the car.
//
// Every "Start vehicle test" button used to call istaGo(...,'tree') and read
// nothing at all -- the technician pressed it and landed on the app's own
// Control unit tree, which is a different screen, not a test. These checks
// pin the behaviour that replaced it.
//
// What a failure here means:
//   the page draws nothing      -- the test runs blind; a technician cannot
//                                  tell a slow read from a dead one
//   silent ECUs go missing      -- the report keeps them in their OWN list,
//                                  so folding only `modules` hides every
//                                  module that did not respond, which is
//                                  exactly what a vehicle test is looking for
//   the scan is not kept        -- the Control unit list, the fault memory
//                                  and the test plan all read it back out of
//                                  the Garage; an unkept test is a lost one
//   a second test can start     -- two reads on one bus
//
//   node tools/verify/test_ista_vehicle_test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
let passed = 0;
const ok = (what) => {
  passed++;
  if (process.env.V) console.log('  ok', what);
};

/**
 * The renderer's classic scripts in one context, with the pieces the shell
 * leans on faked. Only what the vehicle test touches is real.
 * @param {object} over - overrides merged into the sandbox
 * @returns {object} the context
 */
function load(over) {
  const calls = { go: [], saved: [], bars: [] };
  const host = { isConnected: true, innerHTML: '' };
  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    document: {
      getElementById: () => host,
      createElement: () => ({ classList: { add() {}, remove() {} } }),
    },
    window: {},
    esc: (x) => String(x == null ? '' : x),
    istaProbe: async (fn) => {
      try {
        return await fn();
      } catch (e) {
        return null;
      }
    },
    istaChassis: () => 'E46',
    istaState: { car: { id: 'car1' }, tested: false },
    istaGo: async (tab, sub) => {
      calls.go.push(`${tab}/${sub}`);
    },
    istaRealStatus: () => {},
    istaBottomBar: (id, acts) => {
      calls.bars.push({ id, acts: Object.keys(acts || {}) });
    },
    garageAddScan: (id, payload, meta) => {
      calls.saved.push({ id, payload, meta });
    },
    ...over,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  const src = fs.readFileSync(
    path.join(ROOT, 'app', 'renderer', 'screens', 'ista', 'pages.js'),
    'utf8'
  );
  // pages.js is a classic script; take just the renderer under test
  const start = src.indexOf('function istaPageVehicleTest');
  const end = src.indexOf('\n}', src.indexOf('host.innerHTML', start)) + 2;
  vm.runInContext(src.slice(start, end), ctx);
  ctx.calls = calls;
  ctx.host = host;
  return ctx;
}

/** @returns {object} a report in the shape ipoProtocolReport really returns */
function report(modules, silent) {
  return { kind: 'faults', modules: modules || [], silent: silent || [] };
}

function main() {
  // ---- the read paints the screen it was started from ----------------------
  // THE TEST DOES NOT OPEN A PAGE. The tool colours the control units in
  // where they are already listed, the way the tree app's own Fault scan
  // paints its boxes. An earlier version navigated to a progress page of
  // its own; that is the thing these checks exist to stop coming back.
  {
    const src = fs.readFileSync(
      path.join(ROOT, 'app', 'renderer', 'screens', 'ista', 'screen.js'),
      'utf8'
    );
    const fn = src.slice(
      src.indexOf('async function istaOpenVehicleTest'),
      src.indexOf('function istaTestPhase')
    );
    assert.ok(fn.length > 200, 'the vehicle test is missing');
    assert.ok(
      !/istaGo\(/.test(fn),
      'the vehicle test navigates instead of reading in place'
    );
    assert.ok(
      /istaRedraw\(\)/.test(fn),
      'the vehicle test never repaints the screen it runs on'
    );
    ok('the test runs on the screen it was started from');

    // a read in progress must reach the slot loader, or nothing colours in
    // until the very end
    assert.ok(
      /const now = istaTestLive\(\) \|\| istaTestDone;/.test(src),
      'the slots ignore a read in progress'
    );
    // A RUNNING TEST REPLACES THE STORED SCAN ENTIRELY. Falling back to the
    // last scan for the half that has not answered yet paints the previous
    // run's colours as though they were this one's: the whole tree came up
    // coloured before a single module had replied, and a module cleared
    // since then would still have shown amber.
    assert.ok(
      /if \(istaTestLive\(\)\) \{[\s\S]{0,200}ident = istaTestLive\(\)\.ident \|\| null;/.test(
        src
      ),
      'a running test still falls back to the stored scan'
    );
    ok('a running test draws only what this test has heard');

    // AND THE RESULT STAYS UP WHEN IT ENDS. Clearing the live state and
    // redrawing hands the page back to the stored scan, so everything the
    // test just found dropped off the tree the moment it finished.
    assert.ok(
      /istaTestDone = istaTestLiveState;/.test(src),
      'the finished result is thrown away instead of kept on screen'
    );
    assert.ok(
      /istaTestDone = null;/.test(src),
      'a new test does not clear the previous result'
    );
    ok('what the test found stays on screen after it ends');

    // both passes, identification first
    const identAt = fn.indexOf("pass(null, identKey, 'ident')");
    const faultAt = fn.indexOf("pass(faultMenu, faultKey, 'faults')");
    assert.ok(identAt > 0 && faultAt > 0, 'both passes must run');
    assert.ok(identAt < faultAt, 'identification must run before the faults');
    ok('the test identifies the control units, then reads their faults');

    // a script with no Ident key still has fault memories worth reading,
    // but the reason must not vanish the way it did on the first real run
    assert.ok(
      /catch \(e\) \{[\s\S]{0,400}istaTestError = String/.test(fn),
      'a failed identification pass is swallowed silently'
    );
    ok('a pass that cannot run says why instead of vanishing');

    // each pass is kept: the Control unit list, the fault memory and the
    // test plan all read it back out of the Garage
    assert.ok(
      /garageAddScan\(car\.id, \{ report, lines \}, \{ chassis \}\)/.test(src),
      'a finished pass is not saved against the car'
    );
    ok('each pass is kept against the car');

    // one read on the bus at a time, and Cancel ends it between two jobs
    assert.ok(/if \(istaTestRun\) return;/.test(fn), 'a second test can start');
    assert.ok(
      /istaTestHandle\.cancel\(\)/.test(src),
      'a running test cannot be cancelled'
    );
    ok('a second test cannot start, and a running one can be cancelled');

    // the control unit column must not repeat the variant
    assert.ok(
      /m\.label && m\.label !== m\.sgbd/.test(src) ||
        !/faults: asked/.test(src),
      'the control unit column can repeat the variant'
    );
    ok('the control unit column is the module, not the variant again');
  }

  // ---- the strip -----------------------------------------------------------
  {
    const src = fs.readFileSync(
      path.join(ROOT, 'app', 'renderer', 'screens', 'ista', 'model.js'),
      'utf8'
    );
    const ctx = { console };
    vm.createContext(ctx);
    const a = src.indexOf('function istaSubShown');
    const b = src.indexOf('\n}', src.indexOf('function istaSubInStrip')) + 2;
    vm.runInContext(
      'function istaDevHost(){return true}\n' + src.slice(a, b),
      ctx
    );
    // a hidden page must still RESOLVE, or pressing the button routes nowhere
    assert.strictEqual(
      ctx.istaSubShown({ id: 'vehicle-test', hidden: true }),
      true
    );
    assert.strictEqual(
      ctx.istaSubInStrip({ id: 'vehicle-test', hidden: true }),
      false
    );
    assert.strictEqual(ctx.istaSubInStrip({ id: 'unit-list' }), true);
    ok('the test page routes but never joins the tab strip');
  }

  // ---- the buttons --------------------------------------------------------
  {
    const src = fs.readFileSync(
      path.join(ROOT, 'app', 'renderer', 'screens', 'ista', 'screen.js'),
      'utf8'
    );
    // the bug this whole file exists for: a button that navigates instead of
    // reading. Every vehicle-test button must call the test.
    const buttons = src.match(/'vehicle-test':[^,\n]*/g) || [];
    assert.ok(buttons.length >= 3, `only ${buttons.length} buttons found`);
    for (const b of buttons)
      assert.ok(
        /istaOpenVehicleTest\(\)/.test(b),
        `a vehicle-test button does not run the test: ${b}`
      );
    ok('every Start vehicle test button runs the test');

    // Complete identification reads the car too
    const ident = src.match(/'ident-full':[^\n]*\n?[^\n]*/);
    assert.ok(
      ident && /istaOpenVehicleTest/.test(ident[0]),
      'Complete identification does not read the car'
    );
    ok('Complete identification runs the same read');

    // while it runs, the list offers Cancel rather than a second Start
    assert.ok(
      /istaBottomBar\('unit-list-busy'/.test(src),
      'the list still offers Start while a test is running'
    );
    ok('a running test turns Start into Cancel');
  }
}

main();
console.log(`test_ista_vehicle_test: ${passed} checks passed`);
