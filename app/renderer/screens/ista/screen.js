/**
 * @file The ISTA shell: workshop mode. A banner and a tab bar that stay up
 * while the app's own screens render underneath them.
 *
 * Nothing in here is a second copy of a screen. Every sub-tab resolves to a
 * show*() the app already has, called with the picked car filled in; the
 * shell's job is to be the frame around it and to know which of them exist
 * on this car. The pages it does draw itself (details.js, pages.js) are the
 * ones the app had no screen for.
 *
 * TWO FACES, ONE SHELL. With the layout setting on INPA (inpaMode, which
 * skin.js reads through istaSkinOn) the chrome is the workshop tool's own,
 * 1:1: toolbar row, header line, black tab bar, sub-tab strips, status line,
 * bottom button bar. With it on Modern, none of that is drawn and the shell
 * keeps the banner-and-pills look it had. The routing, the readiness checks
 * and the openers below are shared -- only the paint differs, so a tab
 * cannot work in one face and be missing in the other.
 *
 * HOW THE ROUTE SURVIVES. setCrumbs syncs the hash from `lastScreen` on
 * every render, so a wrapped screen would rewrite `#ista/...` into its own
 * route the moment it drew. istaOpen therefore sets `lastScreen` back to the
 * shell and re-stamps the hash AFTER the screen has rendered -- the screen
 * keeps its body, the shell keeps its URL, and Back lands in the shell.
 */

/* exported ISTA_CAR_KEY, ISTA_CHASSIS_KEY, istaState, istaChassis, istaSetCar, istaRestoreCar, istaOpenFaultMemory, istaTestRun, istaTestDone, istaTestError, istaOpenVehicleTest, istaTestPhase, istaTestCancel, istaOpenIdentScan, istaOpenService, istaOpenServiceResets, istaOpenTree, istaOpenHistory, istaOpenLatestReport, istaOpenIdentity, istaOpenModules, istaOpenCoding, istaProbe, istaSubReady */

/** Settings key holding the car the shell was last pointed at. */
const ISTA_CAR_KEY = 'bmweb.ista.car';

/** Settings key holding the chassis, for a shell with no saved car. */
const ISTA_CHASSIS_KEY = 'bmweb.ista.chassis';

/**
 * What the shell is pointed at now.
 * @type {{car: object|null, chassis: string, tab: string, sub: string|null,
 *   sub3: string|null, etk: object|null, tested: boolean}}
 */
const istaState = {
  car: null,
  chassis: '',
  tab: ISTA_HOME_TAB,
  sub: null,
  sub3: null,
  etk: null,
  tested: false,
};

/**
 * The chassis the shell works on: the picked car's, else the remembered one.
 * @returns {string} upper-case chassis id, or ''
 */
function istaChassis() {
  if (istaState.car && istaState.car.chassis)
    return String(istaState.car.chassis).toUpperCase();
  return String(istaState.chassis || '').toUpperCase();
}

/**
 * Point the shell at a car (or, with null, at a bare chassis) and remember
 * it for next time.
 * @param {object|null} car - a GarageCar, or null
 * @param {string} [chassis] - the chassis, when there is no car
 * @returns {void}
 */
function istaSetCar(car, chassis) {
  istaState.car = car || null;
  istaState.chassis = String(
    (car && car.chassis) || chassis || ''
  ).toUpperCase();
  // the VIN decode behind the header line and the details grid; it is a
  // catalogue lookup, not a read, so it costs the car nothing
  istaState.etk = null;
  if (car && car.vin && typeof viEtkDecode === 'function')
    viEtkDecode(car.vin)
      .then((e) => {
        if (istaState.car === car) {
          istaState.etk = e;
          if (istaChromeActive()) istaPaintChrome();
        }
      })
      .catch(() => {
        /* the parts index is optional */
      });
  if (typeof Settings === 'object' && Settings && Settings.set) {
    Settings.set(ISTA_CAR_KEY, car ? car.id : '');
    Settings.set(ISTA_CHASSIS_KEY, istaState.chassis);
  }
}

/**
 * Restore the remembered car, or fall back to the newest saved one. A
 * remembered car that has since been deleted falls back rather than leaving
 * the shell pointed at nothing.
 * @param {string|null} [carId] - a car id from the route, which wins
 * @returns {void}
 */
function istaRestoreCar(carId) {
  const cars = typeof garageCars === 'function' ? garageCars() : [];
  const want =
    carId ||
    (typeof Settings === 'object' && Settings && Settings.get
      ? Settings.get(ISTA_CAR_KEY, '')
      : '');
  const found = want ? cars.find((c) => c.id === want) : null;
  if (found) return istaSetCar(found);
  const chassis =
    typeof Settings === 'object' && Settings && Settings.get
      ? Settings.get(ISTA_CHASSIS_KEY, '')
      : '';
  if (cars.length) return istaSetCar(cars[0]);
  istaSetCar(null, chassis);
}

// ---- the openers -----------------------------------------------------------
// Each one is named in ISTA_TABS by string, and each is a thin call into a
// screen the app already ships. They exist so the tab table stays a table:
// the argument shuffling (which car, which menu key, which caption) lives
// here, once per tab, instead of in the model.

/**
 * The whole-car fault menu, filed against the picked car. Nothing is pressed
 * on arrival: the scan is the user's key, the tab only takes them to it.
 * @returns {void}
 */
function istaOpenFaultMemory() {
  const car = istaState.car;
  if (car && typeof garageRunScan === 'function')
    return garageRunScan(car, IPO_VEHICLE_FAULT_MENU, null);
  showVehicleScript(istaChassis(), IPO_VEHICLE_FAULT_MENU, null, null);
}

/**
 * The vehicle test: the bus map, with its Fault scan key. Nothing runs on
 * arrival; the read is the user's key.
 * @returns {Promise<void>}
 */
/** The vehicle test that is on the bus right now, so a second cannot start. */
let istaTestRun = null;

/**
 * What the last finished test heard, so its colours stay on the screen.
 *
 * DECLARED HERE, WITH THE OTHER TEST STATE, BECAUSE `let` IS NOT HOISTED.
 * These were originally declared below istaOpenVehicleTest, which assigns
 * them: the assignment threw "Cannot access before initialization" inside
 * the finally block, so the result was dropped and the tree fell back to the
 * stored scan the moment a test finished.
 * @type {{ident: object|null, faults: object|null}|null}
 */
let istaTestDone = null;

/** @type {object|null} the pass on the bus, so Cancel can end it */
let istaTestHandle = null;

/** @type {string} why the last test could not finish, if it could not */
let istaTestError = '';

/**
 * Run the tool's vehicle test, in the tool's own window.
 *
 * THE TEST RUNS HERE. Every "Start vehicle test" button used to navigate to
 * the app's Control unit tree and read nothing, which is not a test: the
 * technician pressed a button and landed on another screen. This drives
 * INPA's whole-car fault read headless -- the same engine the tree screen
 * uses, which declines every write -- draws the modules as they answer,
 * keeps the result against the car in the Garage, and ends on the Control
 * unit list, which is where the tool leaves you.
 * @returns {Promise<void>}
 */
async function istaOpenVehicleTest() {
  if (istaTestRun) return;
  if (typeof ecuTreeScanStart !== 'function') return;
  const chassis = istaChassis();
  const car = istaState.car || null;

  // THE TEST RUNS ON THE SCREEN YOU PRESSED IT FROM. The tool does not
  // leave for a progress page: the control units colour in where they are
  // already listed, exactly as the tree app's own Fault scan paints its
  // boxes. So this repaints the current ISTA page after every answer and
  // never navigates -- the earlier version opened a page of its own, which
  // is the thing to avoid.
  /**
   * Paint what has answered so far onto the screen already showing.
   * @param {boolean} [full] - rebuild the page (start and finish only)
   * @returns {Promise<void>|null}
   */
  const redraw = async (full) => {
    if (full) return istaRedraw();
    const slots = await istaLoadSlots(chassis, car);
    istaPaintStates(slots);
    istaTestStatus(slots);
    return null;
  };

  const token = {};
  /** true while a repaint is in flight, so ticks do not pile up */
  let painting = false;
  istaTestRun = token;
  istaTestError = '';
  istaTestDone = null;
  istaTestLiveState = { ident: null, faults: null, phase: 'ident' };

  /**
   * Run one pass of the whole-car script, painting as it answers.
   * @param {object|null} menu - the menu to open, null for the main one
   * @param {RegExp} key - the key to press, by caption
   * @param {'ident'|'faults'} slot - which half of the read this is
   * @returns {Promise<object>} {report, lines, cancelled}
   */
  const pass = (menu, key, slot) => {
    if (istaTestLiveState) istaTestLiveState.phase = slot;
    const handle = ecuTreeScanStart(
      chassis,
      {
        onProgress: (report) => {
          if (istaTestRun !== token || !report) return;
          istaTestLiveState[slot] = report;
          // the tick fires every 250 ms; a repaint that is still loading
          // its slots must not stack up behind the next one
          if (!painting) {
            painting = true;
            Promise.resolve(redraw())
              .catch(() => {})
              .then(() => {
                painting = false;
              });
          }
        },
      },
      { faultMenu: menu, faultKey: key }
    );
    istaTestRun = token;
    istaTestHandle = handle;
    return handle.done;
  };

  const identKey =
    typeof GARAGE_IDENT_KEY !== 'undefined'
      ? GARAGE_IDENT_KEY
      : /^(Ident|Identifikation|Identification)$/i;
  const faultKey =
    typeof GARAGE_FAULT_KEY !== 'undefined'
      ? GARAGE_FAULT_KEY
      : /^(FS lesen|Fehlerspeicher lesen|Read fault memory)$/i;
  const faultMenu =
    typeof IPO_VEHICLE_FAULT_MENU !== 'undefined'
      ? IPO_VEHICLE_FAULT_MENU
      : 'm_fs';

  const keep = (report, lines) => {
    if (!car || typeof garageAddScan !== 'function') return;
    if (!report || !(report.modules || []).length) return;
    garageAddScan(car.id, { report, lines }, { chassis });
  };
  /** the vehicle_state names table, for any module the detection runs */
  const vehicleText = await istaProbe(() =>
    typeof istaAblFetch === 'function'
      ? istaAblFetch('vehicle-states.json')
      : null
  );

  redraw(true);
  try {
    // identification names the variant in each slot, the fault read says
    // what each one has stored; the tool's test does both
    try {
      const r = await pass(null, identKey, 'ident');
      if (istaTestRun !== token) return;
      istaTestLiveState.ident = r.report;
      // THE FEATURES ARE DETECTED THE WAY THE TOOL DETECTS THEM. A validity
      // rule's EQUIPMENT leaf ("ASC MK60?", "trailer module?") is answered
      // by a test module the tool's FFM resolver runs on the car; the
      // identification is when this build runs them, and their verdicts
      // ride on the identification scan so every gate reads them later
      // without a cable.
      if (r.report && (r.report.modules || []).length) {
        istaTestLiveState.phase = 'features';
        istaTestLiveState.features = { done: 0, total: 0 };
        r.report.ffm = await istaFfmResolve(
          car,
          chassis,
          istaAblRunner(car, chassis, vehicleText),
          (done, total) => {
            if (istaTestRun !== token) return;
            istaTestLiveState.features = { done, total };
            if (!painting) {
              painting = true;
              Promise.resolve(redraw())
                .catch(() => {})
                .then(() => {
                  painting = false;
                });
            }
          },
          () => istaTestRun !== token
        );
        if (istaTestRun !== token) return;
      }
      keep(r.report, r.lines);
    } catch (e) {
      // a script with no Ident key still has fault memories worth reading,
      // but the reason must not vanish: a test that identified nothing
      // looked exactly like one that worked
      istaTestError = String((e && e.message) || e);
      console.warn('[ista] identification pass:', istaTestError);
    }
    if (istaTestRun !== token) return;
    const r2 = await pass(faultMenu, faultKey, 'faults');
    if (istaTestRun !== token) return;
    istaTestLiveState.faults = r2.report;
    keep(r2.report, r2.lines);
    istaState.tested = true;
  } catch (e) {
    istaTestError = String((e && e.message) || e);
    console.warn('[ista] vehicle test:', istaTestError);
  } finally {
    if (istaTestRun === token) {
      istaTestRun = null;
      istaTestHandle = null;
      // THE RESULT STAYS ON SCREEN. Clearing the live state and redrawing
      // hands the page back to the STORED scan, and everything the test just
      // found drops off the tree the moment it finishes -- which is what it
      // did. What this run heard is kept as the last result and goes on
      // being drawn; only starting another test replaces it.
      istaTestDone = istaTestLiveState;
      istaTestLiveState = null;
      // REBUILDING THE PAGE REDRAWS THE TREE FROM ITS OWN PATH, which knows
      // nothing about this run, so the colours went grey again the moment
      // the test ended even though the result was kept. Rebuild for the
      // buttons and the status line, then paint the states back on.
      Promise.resolve(redraw(true))
        .then(() => redraw())
        .catch(() => {});
    }
  }
}

/**
 * The tool's FFM resolver: run each feature's detection module on the car.
 *
 * READ FROM THE TOOL. EquipmentExpression asks the vehicle for a cached
 * feature verdict and, failing that, evaluates the feature's own rule;
 * when that holds it hands the feature's linked test module (an ABL-IDE
 * procedure) to FFMDynamicResolver, which runs it and maps its
 * CollectiveResult: Ok and Verified are the feature fitted, NotOk is not,
 * and any other outcome -- Unknown, a module that could not run, an
 * exception -- is null, which the expression treats as fitted. The
 * verdict is cached on the vehicle for the session. This does the same,
 * for every feature whose own rule holds for this car, with the module
 * window's own runner, and returns the cache the facts builder hands the
 * evaluator.
 *
 * NOTHING INTERACTIVE. A detection module reads identifications; one that
 * stops to ask the technician something cannot be answered here, and that
 * run ends as the resolver's null rather than with a guessed answer.
 * @param {object|null} car - the picked GarageCar
 * @param {string} chassis - the development code
 * @param {object} runner - istaAblRunner output
 * @param {(done: number, total: number) => void} [onProgress] - per module
 * @param {() => boolean} [cancelled] - true once the test was stopped
 * @returns {Promise<Object<string, boolean|null>>} feature name -> verdict
 */
async function istaFfmResolve(car, chassis, runner, onProgress, cancelled) {
  /** @type {Object<string, boolean|null>} */
  const out = {};
  if (
    typeof techDataVehicleFacts !== 'function' ||
    typeof techDataCarKeys !== 'function' ||
    typeof techDataRuleApplies !== 'function' ||
    typeof AblEngine === 'undefined'
  )
    return out;
  const facts = await techDataVehicleFacts(car, chassis);
  const keys = await techDataCarKeys(car, chassis);
  const ids = (keys && keys.ids) || new Set();
  const table = (facts.aux && facts.aux.equipment) || {};
  // the features the tool would resolve: those whose own rule holds
  const wanted = Object.values(table).filter(
    (e) => e && e.n && e.m && techDataRuleApplies(e.r, ids, facts)
  );
  let done = 0;
  if (typeof onProgress === 'function') onProgress(0, wanted.length);
  for (const e of wanted) {
    if (typeof cancelled === 'function' && cancelled()) break;
    out[e.n] = await istaFfmRun(e.m, chassis, runner);
    done += 1;
    if (typeof onProgress === 'function') onProgress(done, wanted.length);
  }
  return out;
}

/**
 * Run one feature-detection module headlessly and map its verdict.
 * @param {string} module - the module's identifier, DLL spelling
 * @param {string} chassis - the development code
 * @param {object} runner - istaAblRunner output
 * @returns {Promise<boolean|null>} fitted, not fitted, or the resolver's null
 */
async function istaFfmRun(module, chassis, runner) {
  const graph = await istaProbe(() =>
    typeof istaAblLoad === 'function' ? istaAblLoad(module, chassis) : null
  );
  if (!graph) return null;
  const refuse = async () => {
    throw new Error('feature detection cannot answer a prompt');
  };
  let verdict;
  try {
    const engine = new AblEngine(graph, {
      job: runner.job,
      module: runner.module,
      native: runner.native || {},
      vehicleText: runner.vehicleText || null,
      ui: {
        // a timed or plain message is read and passed; anything that needs
        // an answer ends the run as unresolved
        message: async (m) => ({ quit: !(m && m.live) }),
        input: refuse,
        selection: refuse,
        question: refuse,
        value: refuse,
        hide: async () => {},
      },
    });
    verdict = await engine.run();
  } catch (e) {
    return null;
  }
  // FFMDynamicResolver.Resolve: Ok and Verified succeed, NotOk fails,
  // everything else is "unsupported result" and null
  if (verdict === 'Ok' || verdict === 'Verified') return true;
  if (verdict === 'NotOk') return false;
  return null;
}

/**
 * The status line while the test runs: the count and what it is doing.
 * @param {object[]} slots - the slots as they stand now
 * @returns {void}
 */
function istaTestStatus(slots) {
  if (typeof istaRealStatus !== 'function') return;
  const faults = (slots || []).reduce((a, x) => a + x.faults, 0);
  const read = (slots || []).some((x) => x.state !== 'unread');
  istaRealStatus({
    items: [
      { k: 'Fault memory', v: read ? String(faults) : 'Unknown' },
      { k: 'Vehicle test', v: istaTestPhase() },
    ],
    legend: [
      { cls: 'ok', label: 'ECU without fault memory' },
      { cls: 'warn', label: 'ECU with fault memory' },
      { cls: 'bad', label: 'ECU not responding' },
      { cls: 'blue', label: 'ECU with programming abort' },
    ],
  });
}

/**
 * What the running test is doing, for the status line.
 * @returns {string}
 */
function istaTestPhase() {
  const live = istaTestLiveState;
  if (!live) return 'starting...';
  // WHICH PASS IS ON THE BUS IS SAID, NOT INFERRED. Reading it off
  // `live.ident` was wrong: that report fills in as the identification
  // PROGRESSES, so the line flipped to "reading fault memories" the moment
  // the first module identified -- for the whole of the pass that was
  // actually running.
  if (live.phase === 'features') {
    const f = live.features || { done: 0, total: 0 };
    return `detecting features (${f.done} of ${f.total} modules)`;
  }
  const r = live.phase === 'faults' ? live.faults : live.ident;
  const n = ((r && r.modules) || []).length + ((r && r.silent) || []).length;
  return live.phase === 'faults'
    ? `reading fault memories (${n} answered)`
    : `identifying control units (${n} answered)`;
}

/**
 * End the vehicle test between two jobs.
 *
 * The handle's own cancel stops the script after the job on the bus
 * finishes, rather than abandoning a read mid-telegram.
 * @returns {void}
 */
function istaTestCancel() {
  if (istaTestHandle && typeof istaTestHandle.cancel === 'function')
    istaTestHandle.cancel();
}

/**
 * The whole-car script's main menu, filed against the picked car. Its Ident
 * key is the read; nothing is pressed on arrival.
 * @returns {void}
 */
function istaOpenIdentScan() {
  const car = istaState.car;
  if (car && typeof garageRunScan === 'function')
    return garageRunScan(car, null, null);
  showVehicleScript(istaChassis(), null, null, null);
}

/**
 * The service functions for this car.
 * @returns {Promise<void>}
 */
function istaOpenService() {
  return showService(istaChassis(), null, '');
}

/**
 * The service-reset routines. Same screen as Service functions -- the shell
 * lists it under the service plan too because that is where a workshop
 * looks for it, not because it is a second app.
 * @returns {Promise<void>}
 */
function istaOpenServiceResets() {
  return showService(istaChassis(), null, 'Service reset');
}

/**
 * The bus map.
 * @returns {Promise<void>}
 */
function istaOpenTree() {
  return showEcuTreeChassis(
    istaChassis(),
    istaState.car ? istaState.car.id : null
  );
}

/**
 * Every scan kept against this car.
 * @returns {Promise<void>}
 */
function istaOpenHistory() {
  return showGarageCar(istaState.car.id);
}

/**
 * The newest stored read, as its report. Routed through showGarageScan
 * rather than rendered here: that screen disarms the stored report's Clear
 * buttons, which would otherwise erase faults on whatever car is on the
 * cable right now.
 * @returns {Promise<void>}
 */
function istaOpenLatestReport() {
  const scans =
    typeof garageScans === 'function' ? garageScans(istaState.car.id) : [];
  return showGarageScan(istaState.car.id, scans[0].id);
}

/**
 * What the car reports about its own build.
 * @returns {Promise<void>}
 */
function istaOpenIdentity() {
  // the tab lands on the screen; the read is the user's key
  return showVehicleIdentity(istaChassis(), { idle: true });
}

/**
 * The chassis's module list, in whichever layout the user chose.
 *
 * NOT backToModules: that picks the right screen for the layout but returns
 * nothing, so awaiting it resolves before either async screen has painted --
 * and the shell would then re-stamp its F-keys over a pane still showing the
 * previous tab. Making the same choice here lets the promise come back.
 * @returns {Promise<void>}
 */
function istaOpenModules() {
  const id = istaChassis();
  if (typeof inpaMode === 'function' && inpaMode())
    // aborting INPA's picker leaves the popup, not the shell
    return showScriptSelection(id, () => showIsta(istaState.tab, null));
  return showSections(id);
}

/**
 * Coding: the chassis's coding hub (dev hosts only, see the model).
 * @returns {Promise<void>}
 */
function istaOpenCoding() {
  return showCodingHub(istaChassis());
}

/**
 * Await a probe, treating a throw as "no".
 *
 * Every readiness check below asks something optional -- does a tree ship for
 * this chassis, does any module hold the build record -- and each of those
 * can throw on a build without the data behind it. A throw means the same
 * thing as a false here: the tab greys with its reason rather than the shell
 * failing to draw.
 * @param {() => Promise<*>} probe - the check
 * @returns {Promise<*>} what it answered, or null when it threw
 */
async function istaProbe(probe) {
  try {
    return await probe();
  } catch (e) {
    return null;
  }
}

/**
 * Is a leaf openable on the car the shell is pointed at?
 *
 * This is where a grey row stops being a guess. A leaf can be dark for
 * three different reasons and the shell says which: the model marked it
 * `why` (nothing to open, ever, or not yet); the screen it names did not
 * ship in this build; or it needs something this particular car has not got
 * -- a whole-car script (only 10 of 27 chassis ship one), a saved car, a
 * stored scan.
 * @param {IstaSub|IstaSub3} sub - the leaf
 * @returns {Promise<{ok: boolean, why: string}>}
 */
async function istaSubReady(sub) {
  if (!sub) return { ok: false, why: 'no such tab' };
  if (sub.why) return { ok: false, why: sub.why };
  if (sub.needsCar && !istaChassis())
    return { ok: false, why: 'no vehicle picked' };
  if (sub.page) {
    // the workshop browser is nothing without its extract, so it says so;
    // every other page the shell draws always has something to draw
    if (sub.page === 'techdata') {
      if (typeof showTechData !== 'function')
        return { ok: false, why: 'not in this build' };
      const has = await istaProbe(() =>
        typeof techDataIndexPresent === 'function'
          ? techDataIndexPresent()
          : false
      );
      if (!has)
        return { ok: false, why: 'no workshop reference data in this build' };
    }
    // the vehicle test needs the scan engine; without it the button would
    // open a page that can never read anything
    if (sub.page === 'vehicle-test' && typeof ecuTreeScanStart !== 'function')
      return { ok: false, why: 'not in this build' };
    // the repair manual ships per chassis, so "is it here" is asked of THIS
    // car's chassis, not of the extract as a whole: a build can carry E46's
    // manual and not F30's, and saying so is more use than a blank pane
    if (sub.page === 'repair') {
      if (typeof showRepair !== 'function')
        return { ok: false, why: 'not in this build' };
      const chassis = istaChassis();
      const has = await istaProbe(() =>
        typeof repairIndexPresent === 'function'
          ? repairIndexPresent(chassis)
          : false
      );
      if (!has)
        return {
          ok: false,
          why: `no repair data in this build for ${chassis}`,
        };
    }
    return { ok: true, why: '' };
  }
  const fn = sub.open ? window[sub.open] : null;
  if (typeof fn !== 'function') return { ok: false, why: 'not in this build' };

  // the per-car checks, by leaf id
  const chassis = istaChassis();
  if (sub.id === 'conversion-coding' || sub.id === 'remove-coding') {
    const has =
      typeof chassisHasCoding === 'function' &&
      (await istaProbe(() => chassisHasCoding(chassis)));
    if (!has) return { ok: false, why: 'no codeable modules for this chassis' };
  }
  if (sub.id === 'fault-memory' || sub.id === 'unit-list') {
    if (typeof vehicleScriptShipped === 'function') {
      const has = await vehicleScriptShipped(chassis);
      if (!has)
        return {
          ok: false,
          why: `no whole-car script ships for ${chassis}`,
        };
    }
  }
  if (sub.id === 'tree') {
    if (typeof ecuTreeNameFor === 'function') {
      const name = await istaProbe(() => ecuTreeNameFor(chassis));
      if (!name) return { ok: false, why: `no bus map ships for ${chassis}` };
    }
  }
  if ((sub.id === 'history' || sub.id === 'finished') && !istaState.car)
    return { ok: false, why: 'no saved car: add one in the Garage first' };
  if (sub.id === 'report') {
    if (!istaState.car)
      return { ok: false, why: 'no saved car: add one in the Garage first' };
    const scans =
      typeof garageScans === 'function' ? garageScans(istaState.car.id) : [];
    if (!scans.length) return { ok: false, why: 'no scan stored yet' };
  }
  if (
    sub.id === 'service-functions' &&
    typeof serviceIndexPresent === 'function'
  ) {
    const has = await istaProbe(() => serviceIndexPresent());
    if (!has) return { ok: false, why: 'no service mapping in this build' };
  }
  if (sub.id === 'text-search' && typeof searchIndexPresent === 'function') {
    const has = await istaProbe(() => searchIndexPresent());
    if (!has) return { ok: false, why: 'no job index in this build' };
  }
  return { ok: true, why: '' };
}
