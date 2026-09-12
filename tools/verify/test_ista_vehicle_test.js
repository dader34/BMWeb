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
  // ---- the page ------------------------------------------------------------
  {
    const ctx = load();
    ctx.istaPageVehicleTest(ctx.host, {
      running: true,
      text: 'Reading DME',
      modules: [{ label: 'DME', sgbd: 'ms450ds0', faults: 2, note: '' }],
    });
    const html = ctx.host.innerHTML;
    assert.ok(/Vehicle test/.test(html), 'no heading');
    assert.ok(/Reading DME/.test(html), 'the progress line is not drawn');
    // the app's shared loader (the roundel), not a spinner of its own
    assert.ok(/class="loader"/.test(html), 'a running read shows no activity');
    assert.ok(/ms450ds0/.test(html), 'the module is not listed');
    ok('a running test draws its progress and what has answered');

    ctx.istaPageVehicleTest(ctx.host, { running: false, modules: [] });
    assert.ok(
      !/class="loader"/.test(ctx.host.innerHTML),
      'a finished test still shows the loader'
    );
    assert.ok(
      /No control unit has answered/.test(ctx.host.innerHTML),
      'an empty result says nothing at all'
    );
    ok('a finished test stops spinning');

    ctx.istaPageVehicleTest(ctx.host, {
      running: false,
      done: true,
      error: 'No adapter connected',
    });
    assert.ok(
      /No adapter connected/.test(ctx.host.innerHTML),
      'the failure is not shown'
    );
    ok('a test that could not run says why');

    ctx.istaPageVehicleTest(ctx.host, {
      running: false,
      done: true,
      answered: 9,
      faults: 2,
      stopped: true,
      modules: [],
    });
    assert.ok(/9 control units answered/.test(ctx.host.innerHTML));
    assert.ok(/2 with an entry/.test(ctx.host.innerHTML));
    assert.ok(/cancelled/.test(ctx.host.innerHTML), 'a stopped test hides it');
    ok('the tally, and that the test was cancelled');
  }

  // ---- folding the report --------------------------------------------------
  // This is the check that matters most: ipoProtocolReport keeps modules that
  // never answered in a SEPARATE `silent` list, so folding only `modules`
  // drops every non-responding ECU from a screen whose whole job is to show
  // them.
  {
    const r = report(
      [
        { sgbd: 'ms450ds0', label: 'DME', codes: [{ F_HEX_CODE: '27C3' }] },
        { sgbd: 'ihka46', label: 'IHKA', codes: [] },
      ],
      [{ target: 'ews', label: 'EWS', error: 'IFH-0009' }]
    );
    const mods = r.modules;
    const silent = r.silent;
    const rows = mods
      .map((m) => ({
        label: m.label,
        sgbd: m.sgbd,
        faults: Array.isArray(m.codes) ? m.codes.length : null,
        note: '',
      }))
      .concat(
        silent.map((x) => ({
          label: x.label,
          sgbd: String(x.target).toLowerCase(),
          faults: null,
          note: 'no answer',
        }))
      );
    assert.strictEqual(rows.length, 3, 'the silent module was dropped');
    assert.deepStrictEqual(
      rows.map((r2) => r2.note),
      ['', '', 'no answer']
    );
    assert.strictEqual(
      mods.filter((m) => m.codes.length).length,
      1,
      'the fault tally is wrong'
    );
    ok('a module that never answered is still on the list');
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
    assert.ok(
      !/istaState\.tested = true;\s*\n\s*return istaGo\(/.test(src),
      'a button still marks the car tested and then navigates away'
    );
    ok('every Start vehicle test button runs the test');

    // Complete identification reads the car too
    const ident = src.match(/'ident-full':[^\n]*\n?[^\n]*/);
    assert.ok(
      ident && /istaOpenVehicleTest/.test(ident[0]),
      'Complete identification does not read the car'
    );
    ok('Complete identification runs the same read');

    // and the result is kept, or the Control unit list has nothing to show
    assert.ok(
      /garageAddScan\(car\.id, \{ report, lines \}, \{ chassis \}\)/.test(src),
      'the finished test is not saved against the car'
    );
    ok('a finished test is kept against the car');

    // one read on the bus at a time
    assert.ok(
      /if \(istaTestRun\) return;/.test(src),
      'a second test can start'
    );
    ok('a second test cannot start while one is running');

    // TWO PASSES. A fault read alone never sets `ident`, so every control
    // unit keeps reading "not identified yet" -- and the message telling the
    // technician to run the vehicle test could not be satisfied by running
    // it. Identification goes first, and its own result is kept.
    assert.ok(
      /GARAGE_IDENT_KEY/.test(src),
      'the test never identifies the control units'
    );
    const identAt = src.indexOf('Identifying the control units');
    const faultAt = src.indexOf('Reading the fault memories');
    assert.ok(identAt > 0 && faultAt > 0, 'both passes must be announced');
    assert.ok(identAt < faultAt, 'identification must run before the faults');
    ok('the test identifies the control units, then reads their faults');

    // a script with no Ident key still has fault memories worth reading
    assert.ok(
      /ident = await pass\(null, identKey[\s\S]{0,200}catch/.test(src),
      'a missing Ident key fails the whole test'
    );
    ok('a script with no Ident key still gets its fault read');

    // and the Control unit column must not repeat the variant
    assert.ok(
      /m\.label && m\.label !== m\.sgbd/.test(src),
      'the control unit column can repeat the variant'
    );
    ok('the control unit column is the module, not the variant again');
  }
}

main();
console.log(`test_ista_vehicle_test: ${passed} checks passed`);
