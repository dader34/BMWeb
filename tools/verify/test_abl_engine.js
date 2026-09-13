#!/usr/bin/env node
// The test-module step player, against the module the video shows running.
//
// ABL-DIT-B1362_D6LDF is the charging pressure sensor test. The recorded
// session walks it screen by screen, so this drives the same module with a
// scripted user and a fake car and asserts the screens come out in the same
// order with the same words -- including the one number the tool COMPUTES
// rather than reads (the difference between boost and ambient pressure),
// which is the only place a wrong expression evaluator shows up as a wrong
// answer rather than a crash.
//
// What a failure here means:
//   wrong step order     -- a branch read the wrong way; a technician is sent
//                           down the other half of the test
//   wrong verdict        -- the No answer on a setpoint stopped setting
//                           NotOk, and every sensor test silently passes
//   a halt that was not  -- the engine met a node kind it should model
//   no halt where one is -- an unmodelled kind was skipped, and the procedure
//                           did less than the tool would have, quietly
//
//   node tools/verify/test_abl_engine.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FIX = path.join(__dirname, 'fixtures', 'abl');
let passed = 0;
const ok = (what) => {
  passed++;
  if (process.env.V) console.log('  ok', what);
};

// the engine is a renderer script: plain <script> globals plus a module
// export, so requiring it directly is enough (it touches no DOM)
const E = require(
  path.join(ROOT, 'app', 'renderer', 'core', 'abl', 'engine.js')
);
const { AblEngine, AblHalt, ablText, ablEval, ablJobResult, ablJobSpec } = E;

/** @param {string} name @returns {object} the fixture graph */
const load = (name) =>
  JSON.parse(fs.readFileSync(path.join(FIX, `${name}.json`), 'utf8'));

const B1362 = load('B1362');
const FSLISTE1 = load('FSLISTE1');

async function main() {
  // ---- the pieces the walker leans on ----------------------------------------
  {
    // an EDIABAS answer, in the shape the app's job runner returns
    const answer = {
      sets: [
        { OBJECT: 'd63mm670', SAETZE: 1, VARIANTE: 'D63MM670' },
        { STAT_LADEDRUCK_WERT: 1034, STAT_UMGEBUNGSDRUCK_WERT: 1002 },
      ],
    };
    assert.strictEqual(ablJobResult(answer, '/Result/Rows/$Count'), 1);
    assert.strictEqual(
      ablJobResult(answer, '/Result/Status/VARIANTE'),
      'D63MM670'
    );
    assert.strictEqual(
      ablJobResult(answer, '/Result/Rows/Row[0]/STAT_LADEDRUCK_WERT'),
      1034
    );
    assert.strictEqual(
      ablJobResult(answer, '/Result/Rows/Row[1]/STAT_LADEDRUCK_WERT'),
      null
    );
    ok('result paths map onto EDIABAS sets');

    // the browser VM carries the system record beside the sets, not ahead
    const web = {
      sets: [{ STAT_LADEDRUCK_WERT: 7 }],
      system: { VARIANTE: 'ms450ds0', SAETZE: 1 },
    };
    assert.strictEqual(ablJobResult(web, '/Result/Rows/$Count'), 1);
    assert.strictEqual(
      ablJobResult(web, '/Result/Status/VARIANTE'),
      'ms450ds0'
    );
    ok('the browser VM answer shape reads the same');
  }

  {
    // THE RULE THE EXIT DISPATCH LEANS ON: an unset register is 0, so the
    // compiler's `num3 != 0` is false and the false arm -- the one carrying
    // goto_step -- is taken. Every step in the corpus ends this way.
    const ctx = { vars: {}, out: {}, answer: null };
    assert.strictEqual(ablEval('num3 != 0', ctx), false);
    assert.strictEqual(ablEval('(num) != 0', ctx), false);
    assert.strictEqual(ablEval('num3 != 1', ctx), true);
    ok('an unset exit register reads as zero');

    const vars = { SgbdM_v: 'd63mm670', Patm_v: 1002, Plad_v: 1034, SELEKT: 2 };
    const c2 = { vars, out: { Result: 2 }, answer: null };
    assert.strictEqual(ablEval('SgbdM_v == "d63mm670"', c2), true);
    assert.strictEqual(ablEval('SgbdM_v == "D63MM670"', c2), false);
    assert.strictEqual(
      ablEval('__convertToDouble((Patm_v - Plad_v))', c2),
      -32
    );
    assert.strictEqual(ablEval('out.Result', c2), 2);
    assert.strictEqual(ablEval('SELEKT == 1', c2), false);
    ok('the expression dialect evaluates');
  }

  {
    // the job descriptor: the group is ISTA's own addressing, and an override
    // that names a variable is the variant a previous IDENT resolved
    const start = B1362.steps.Start.nodes.find((n) => n.type === 'ecu_job');
    const s1 = ablJobSpec(start, {});
    assert.strictEqual(s1.job, 'IDENT');
    assert.strictEqual(s1.group, 'D_MOTOR');
    assert.strictEqual(s1.sgbd, '', 'the literal override is the group itself');

    const live = B1362.steps.Status_Fuehler_05_s.nodes.find(
      (n) => n.type === 'ecu_job'
    );
    const s2 = ablJobSpec(live, { Sgbd_v: 'd63mm670' });
    assert.strictEqual(s2.job, 'STATUS_MESSWERTBLOCK_LESEN');
    assert.strictEqual(s2.sgbd, 'd63mm670', 'the override names the variant');
    assert.strictEqual(s2.argText, '1;IPUMG;IPLAD');
    ok('a job node flattens to job, address and argument text');
  }

  {
    // placeholders name module variables, and a measured double prints the
    // way the frames show it (1034mbar, -32mbar) rather than as a float
    const live = B1362.steps.Status_Fuehler_05_s.nodes.find(
      (n) =>
        n.type === 'message' &&
        n.params &&
        n.params.txtParam &&
        n.params.txtParam.params
    );
    const t = ablText(live.params.txtParam, {
      Plad_v: 1034,
      Patm_v: 1002,
      Pdiff_v: -32,
    });
    assert.ok(t.includes('Boost pressure: 1034 mbar'), t);
    assert.ok(t.includes('Difference: -32 mbar'), t);
    ok('a text substitutes its variables');

    // A COMPOSITE TEXT IS LINES, NOT ONE RUN. The measurement instruction
    // is built by concatenation, and the recovery carries the base API's
    // newline flag as an empty _NEWLINE part. Joining the list with nothing
    // gives "Voltage measurementTest probe 1 (+): A_LDF", which is one
    // unreadable sentence where the frames show four lines.
    const meas = B1362.steps.Pruefung_Sensor_08_s.nodes.find(
      (n) => n.type === 'measurement'
    );
    assert.strictEqual(
      ablText(meas.params.AdaptionsText, {}),
      'Voltage measurement\n\n' +
        'Test probe 1 (+): A_LDF\n' +
        'Test probe 1 (-): M_LDF\n' +
        'Measure voltage with engine stationary.'
    );
    ok('a composite text lays out as the lines the frames show');
  }

  // ---- a scripted run of the whole module ------------------------------------

  /**
   * A run of B1362 with a scripted user and a fake car.
   * @param {object} script - {selections, value, reached, quits}
   * @returns {Promise<object>} {verdict, engine, shown}
   */
  async function runB1362(script) {
    const picks = (script.selections || []).slice();
    /** @type {object[]} what the screen was asked to show, in order */
    const shown = [];
    /** @type {string[]} the steps the module entered, in order */
    const steps = [];
    let liveQuit = script.liveQuit == null ? 1 : script.liveQuit;
    const engine = new AblEngine(B1362, {
      onStep: (s) => {
        if (steps.at(-1) !== s) steps.push(s);
      },
      ui: {
        message: async (m) => {
          shown.push(m);
          // the live frame is the loop's own redraw: it answers "not yet"
          // until the pass the script says the user pressed Continue on
          if (m.live) return { quit: --liveQuit <= 0 };
          return { quit: true };
        },
        selection: async (s) => {
          shown.push(s);
          const p = picks.shift();
          assert.ok(p != null, 'the script ran out of selections');
          return p;
        },
        value: async (v) => {
          shown.push(v);
          return { value: script.value, reached: script.reached };
        },
        hide: async () => {
          shown.push({ kind: 'hide' });
        },
      },
      job: async (spec) => {
        shown.push({ kind: 'job', job: spec.job, sgbd: spec.sgbd });
        if (spec.job === 'IDENT')
          return { sets: [{ SAETZE: 0, VARIANTE: 'd63mm670' }] };
        if (spec.job === 'STATUS_MESSWERTBLOCK_LESEN')
          return {
            sets: [
              { SAETZE: 1, VARIANTE: 'd63mm670' },
              { STAT_LADEDRUCK_WERT: 1034, STAT_UMGEBUNGSDRUCK_WERT: 1002 },
            ],
          };
        return { sets: [] };
      },
      native: {
        // the fault-memory library stands in: the app has already read the
        // car's faults, so the module gets the count and the resolved SGBD
        submodule: async ({ identifier, seed }) => {
          assert.strictEqual(identifier, 'ABL-GEN-GISTA_FSLISTE1');
          // the caller fills the compiler's string[300] before handing it
          // over, so the group arrives as element 0 of an array, and the
          // library's answers come back the same way
          assert.deepStrictEqual(
            seed.SG_gruppe_v,
            ['D_MOTOR'],
            'the caller hands the group down'
          );
          return {
            Status_Fehlerspeicher_v: script.faults == null ? 1 : script.faults,
            Sgbd_v: ['d63mm670'],
            Status_Ident_v: ['OKAY'],
          };
        },
      },
      module: async () => FSLISTE1,
    });
    const verdict = await engine.run();
    return { verdict, engine, shown, steps };
  }

  {
    // THE RUN THE VIDEO SHOWS: a stored fault, the live comparison read off
    // the car, Check boost pressure sensor, 1.3 V, and Yes.
    const { verdict, engine, shown, steps } = await runB1362({
      faults: 1,
      selections: [2, 3, 4],
      value: 1.3,
      reached: true,
    });

    // the step order the recovery names, walked for real
    assert.deepStrictEqual(
      steps,
      [
        'Start',
        'Initialisierung_01_s',
        'G9999_FSLESEN30',
        'Fehlerstatus_04_s',
        'Status_Fuehler_05_s',
        'Auswahl_06_s',
        'Pruefung_Sensor_08_s',
        'Auswahl_06_s',
        'Massnahme_33_s',
      ],
      'the module walks its own step order'
    );
    ok('B1362 walks its steps');

    // what the left pane said, in order
    const texts = shown.filter((s) => s.kind === 'message').map((s) => s.text);
    assert.ok(
      texts[0].startsWith(
        'In the next test step, the boost pressure is measured'
      ),
      texts[0]
    );
    assert.ok(
      texts.some((t) => t.startsWith('Compare setpoints and actual values')),
      'the comparison frame was drawn'
    );
    assert.ok(
      texts.some((t) => t.startsWith('Possible causes of fault')),
      'the causes screen followed the comparison'
    );
    assert.ok(
      texts.some((t) => t === 'Go to Selection'),
      'the sensor test returns to the selection'
    );
    assert.strictEqual(
      texts.at(-1),
      'End of test module. Continue in testing schedule.',
      'the module signs off the way the tool does'
    );
    ok('the texts are the ones the frames show');

    // THE NUMBER THE TOOL COMPUTES. The frames read 1034 / 1002 / -32.
    const cmp = texts.find((t) => t.startsWith('Compare setpoints'));
    assert.ok(cmp.includes('Boost pressure: 1034 mbar'), cmp);
    assert.ok(cmp.includes('Ambient pressure: 1002 mbar'), cmp);
    assert.ok(cmp.includes('Difference: -32 mbar'), cmp);
    assert.strictEqual(engine.vars.Pdiff_v, -32);
    ok('the computed difference is -32');

    // the selection the user answered, with the choices the frames list
    const sel = shown.find((s) => s.kind === 'selection');
    assert.deepStrictEqual(
      sel.choices.map((c) => c.text),
      [
        'Check lines and plug connections',
        'Check boost pressure sensor',
        'End test module with feedback',
      ]
    );
    ok('the selection offers the frames three choices');

    // the measurement step, and the verdict a Yes leaves behind
    const val = shown.find((s) => s.kind === 'value');
    assert.ok(val.instruction.includes('Voltage measurement'), val.instruction);
    assert.ok(val.instruction.includes('A_LDF'), val.instruction);
    assert.ok(val.question.includes('Setpoint: 1.1-1.5 V'), val.question);
    assert.strictEqual(val.unit, 'V');
    assert.strictEqual(val.manual, true, 'no meter: the number is typed in');
    assert.strictEqual(engine.vars.MessWert_v, 1.3);
    assert.strictEqual(verdict, 'Ok');
    ok('a reached setpoint ends the module Ok');

    // the job went to the variant the fault read resolved, not to the group
    const jobs = shown.filter((s) => s.kind === 'job');
    assert.deepStrictEqual(
      jobs.map((j) => j.job),
      ['IDENT', 'STATUS_MESSWERTBLOCK_LESEN'],
      'the identification, then the one live read'
    );
    assert.strictEqual(jobs[1].sgbd, 'd63mm670');
    ok('the measurement job addresses the resolved variant');

    // the documents the module opened: the wiring diagram and the function
    // description, one per pane, exactly as the two right-hand tabs show
    assert.deepStrictEqual(
      engine.documents.map((d) => [d.name, d.info, d.slot]),
      [
        ['Ladedruckregelung_DDE', 'Schaltplan', 0],
        ['', 'Funktionsbeschreibung', 1],
      ]
    );
    ok('the module asks for its two documents');
  }

  {
    // ANSWERING NO IS THE OTHER HALF OF EVERY SENSOR TEST. The dialog sets
    // NotOk, the module branches on it, and the causes-of-fault screen shows
    // instead of the bare return to the selection.
    const { shown } = await runB1362({
      faults: 1,
      selections: [2, 3, 4],
      value: 0.2,
      reached: false,
    });
    const after = shown
      .filter((s) => s.step === 'Pruefung_Sensor_08_s' && s.kind === 'message')
      .map((s) => s.text);
    assert.ok(
      after[0].startsWith('Possible causes of fault'),
      'No takes the causes arm: ' + after[0]
    );
    ok('a missed setpoint takes the causes-of-fault arm');
  }

  {
    // A CLEAN FAULT MEMORY takes the other arm of Fehlerstatus_04_s: the
    // "no fault code is stored" selection, whose second button ends the
    // module with the no-fault-found feedback.
    // picking 2 there shows the no-fault-found feedback and then goes on
    // to the pressure comparison anyway, which is what the graph does; the
    // rest of the script carries it to the end
    const { shown, verdict } = await runB1362({
      faults: 0,
      selections: [2, 3, 4],
      value: 1.3,
      reached: true,
    });
    const sel = shown.find((s) => s.kind === 'selection');
    assert.ok(
      sel.prior.startsWith('No fault code is stored'),
      'the clean-memory selection came up: ' + sel.prior
    );
    assert.deepStrictEqual(
      sel.choices.map((c) => c.text),
      ['Continue test module', 'End test module with feedback']
    );
    const msgs = shown.filter((s) => s.kind === 'message').map((s) => s.text);
    assert.ok(
      msgs.some((t) => t.startsWith('No fault found')),
      msgs.join(' | ')
    );
    assert.strictEqual(verdict, 'Ok');
    ok('a clean fault memory offers its own selection');
  }

  // ---- the library module, run for real --------------------------------------
  {
    // With no native stand-in the engine loads and runs the recovered library
    // graph itself. FSLISTE1 reads the fault list through a service with no
    // GUI, so the native side supplies that one, and the sub-module's
    // variables travel home by name.
    let ran = 0;
    // the selections that walk the module to its end rather than round its
    // own loop: the sensor test, then the feedback
    const picks = [2, 3, 4];
    const engine = new AblEngine(B1362, {
      ui: {
        message: async () => ({ quit: true }),
        selection: async () => picks.shift() || 3,
        value: async () => ({ value: 1.3, reached: true }),
        hide: async () => {},
      },
      job: async (spec) =>
        spec.job === 'IDENT'
          ? { sets: [{ SAETZE: 0, VARIANTE: 'd63mm670', JOB_STATUS: 'OKAY' }] }
          : { sets: [{ SAETZE: 1 }, { STAT_LADEDRUCK_WERT: 1034 }] },
      module: async ({ identifier }) => {
        ran++;
        assert.strictEqual(identifier, 'ABL-GEN-GISTA_FSLISTE1');
        return FSLISTE1;
      },
      native: {
        // the fault-memory service the library calls
        faultList: async () => ({
          Anzahl_Fehlerspeicher_v: 2,
          gSgbd_v: 'd63mm670',
          gJobstat1_v: 'OKAY',
        }),
      },
    });
    await engine.run();
    assert.strictEqual(ran, 1, 'the library module was loaded and run');
    const sub = engine.trace.find((t) => t.kind === 'submodule');
    assert.strictEqual(sub.identifier, 'ABL-GEN-GISTA_FSLISTE1');
    assert.strictEqual(sub.title, 'Read fault memory list');
    assert.ok(
      engine.trace.some(
        (t) => t.kind === 'native' && t.service === 'faultList'
      ),
      'the library reached the fault-list service'
    );
    ok('the library module runs as a real sub-module');
  }

  // ---- what it refuses -------------------------------------------------------
  {
    // AN UNKNOWN NODE KIND HALTS, NAMING ITSELF. Skipping it would show a
    // procedure that quietly did less than the tool would have.
    const graph = {
      entry: 'Start',
      steps: {
        Start: {
          entry: 1,
          nodes: [
            { type: 'startstep', id: 1, next: 2 },
            { type: 'oscilloscope', id: 2, next: 3 },
            { type: 'end', id: 3 },
          ],
        },
      },
    };
    const eng = new AblEngine(graph, { ui: {} });
    await assert.rejects(
      () => eng.run(),
      (e) => {
        assert.ok(
          e instanceof AblHalt,
          'it halts rather than throwing anything'
        );
        assert.ok(/oscilloscope/.test(e.message), e.message);
        assert.ok(/Start/.test(e.message), e.message);
        assert.strictEqual(e.where.kind, 'oscilloscope');
        return true;
      }
    );
    ok('an unknown node kind halts, naming the kind and the step');
  }

  {
    // a step the recovery did not reach is named too, rather than ending the
    // module as though it had finished
    const graph = {
      entry: 'Start',
      steps: {
        Start: {
          entry: 1,
          nodes: [{ type: 'goto_step', step: 'Missing_09_s', id: 1 }],
        },
      },
    };
    await assert.rejects(
      () => new AblEngine(graph, { ui: {} }).run(),
      (e) => {
        assert.ok(/Missing_09_s/.test(e.message), e.message);
        return e instanceof AblHalt;
      }
    );
    ok('a step the recovery did not carry halts by name');
  }

  {
    // a service with no handler halts by the service's own name, so a build
    // that cannot answer the vehicle-state wait says which one it was
    const graph = {
      entry: 'Start',
      steps: {
        Start: {
          entry: 1,
          nodes: [
            { type: 'dialog', dialog_ref: '51872651', id: 1, next: 2 },
            { type: 'end', id: 2 },
          ],
        },
      },
    };
    await assert.rejects(
      () => new AblEngine(graph, { ui: {}, native: {} }).run(),
      (e) => {
        assert.ok(/vehicleState/.test(e.message), e.message);
        return e instanceof AblHalt;
      }
    );
    ok('a service this build lacks halts by name');
  }

  // ---- a job that never settles must not stop the module forever -------------
  // There was no timeout on a job at all. On the real car a module sat on
  // "Fault code memory being read..." indefinitely -- no error, no halt,
  // nothing in the console -- because a runner promise never resolved. A
  // module that reads nothing is a path the flow already handles; a module
  // that hangs is not.
  {
    const graph = {
      identifier: 'T',
      entry: 'S',
      steps: {
        S: {
          nodes: [
            { type: 'startstep', id: 1, next: 2 },
            {
              type: 'ecu_job',
              id: 2,
              job: 'IDENT',
              args: {},
              group_path: ['Group', 'D_0000'],
              results: ['JOB_STATUS'],
              next: 3,
            },
            { type: 'end', id: 3 },
          ],
        },
      },
    };
    const eng = new AblEngine(graph, {
      ui: {},
      native: {},
      jobTimeoutMs: 300,
      job: () => new Promise(() => {}), // never settles
    });
    const t0 = Date.now();
    const v = await Promise.race([
      eng.run(),
      new Promise((r) => setTimeout(() => r('__stuck__'), 5000)),
    ]);
    assert.notStrictEqual(
      v,
      '__stuck__',
      'a never-settling job hangs the module'
    );
    assert.ok(Date.now() - t0 < 4000, 'the timeout fired far too late');
    const job = eng.trace.find((t) => t.kind === 'job');
    assert.ok(job && job.timedOut, 'the trace does not record the timeout');
    ok('a job that never settles times out and the module goes on');
  }

  // ---- what a finished run leaves on the plan row ----------------------------
  // A module that ran and was never written back is a plan the technician
  // cannot read: every row stays "not called" however much work was done.
  // So every CollectiveResult the engine can return must land on a state
  // the legend has a colour for, and the mapping must not quietly widen
  // when a new result value is added to the engine.
  {
    const PLAN = require(
      path.join(ROOT, 'app', 'renderer', 'screens', 'ista', 'plan.js')
    );
    const want = {
      Ok: 'performed',
      Verified: 'performed',
      Repaired: 'performed',
      NotOk: 'suspected',
      Unknown: 'minimized',
      None: 'minimized',
    };
    for (const [result, state] of Object.entries(want))
      assert.strictEqual(PLAN.istaPlanStateFor(result), state, result);
    ok('every result maps to its plan state');

    // the engine's own list is the whole domain: a value it can return and
    // this table does not name would fall through to "canceled" and read as
    // a test the technician abandoned
    for (const r of E.ABL_RESULTS)
      assert.ok(want[r], `ABL_RESULTS has ${r} but the plan does not map it`);
    ok('the plan maps every result the engine can return');

    // closing the window, and a step this build cannot run, are both
    // canceled rather than a pass
    assert.strictEqual(PLAN.istaPlanStateFor('canceled'), 'canceled');
    assert.strictEqual(PLAN.istaPlanStateFor(''), 'canceled');
    ok('an abandoned run is canceled, not performed');

    // and each of those states must be one the State column can draw
    const css = fs.readFileSync(
      path.join(ROOT, 'app', 'renderer', 'css', 'ista-real.css'),
      'utf8'
    );
    for (const state of new Set(Object.values(want)))
      assert.ok(
        css.includes(`.irplan-st-${state}`),
        `no colour for state ${state}`
      );
    ok('every plan state has its legend colour');
  }
}

main().then(
  () => console.log(`test_abl_engine: ${passed} checks passed`),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
