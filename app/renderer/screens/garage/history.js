/**
 * @file One car's scan history: the list of reads kept against it, and a
 * stored read drawn exactly as the live module view draws it.
 *
 * The renderer is not duplicated. screens/ipo-runtime/protocol.js's
 * ipoProtocolRender(el, p) reads only `p.view` off the program it is handed,
 * so a stored scan is drawn by handing it a stand-in carrying the same view
 * shape. Printing goes the same way through ipoProtocolPrintSections.
 */

/* exported showGarageCar, showGarageScan, garageViewFor */

/**
 * The stand-in the protocol renderer takes in place of a running program. It
 * carries the one field that file reads, so the stored report draws through
 * the same code path as a live one.
 * @param {GarageScan} scan - the stored scan
 * @returns {{view: {report: object, lines: string[]}}}
 */
function garageViewFor(scan) {
  return {
    view: {
      report: (scan && scan.report) || null,
      lines: (scan && scan.lines) || [],
    },
  };
}

/**
 * Take the live controls off a redrawn stored report.
 *
 * The shared renderer puts a Clear button on every module that had faults,
 * and that button runs FS_LOESCHEN on the car currently on the cable. A
 * stored scan is history -- possibly of a different car entirely -- so
 * offering to erase from it would clear the wrong module on the wrong
 * vehicle. The row keeps its fault count; only the button goes.
 * @param {HTMLElement} el - the element the report was drawn into
 * @returns {void}
 */
function garageDisarmStoredReport(el) {
  el.querySelectorAll('.quick-clear').forEach((b) => b.remove());
}

/**
 * A scan's headline counts, as the history row shows them.
 * @param {GarageScan} scan - the stored scan
 * @returns {string}
 */
function garageScanCountsText(scan) {
  const s = scan.summary || garageScanSummary(scan.report);
  if (scan.kind === 'ident')
    return `${s.modules} module${s.modules === 1 ? '' : 's'} answered · ${s.silent} no response`;
  return (
    `${s.withFaults} with faults · ${s.faults} fault${s.faults === 1 ? '' : 's'} · ` +
    `${s.modules} read · ${s.silent} no response`
  );
}

/**
 * One car: what it is, and every scan kept against it, newest first.
 * @param {string} carId - the car
 * @returns {Promise<void>}
 */
async function showGarageCar(carId) {
  const car = garageCar(carId);
  if (!car) return showGarage();
  lastScreen = () => showGarageCar(carId);
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: 'Garage', fn: showGarage },
    { label: garageCarLabel(car) },
  ]);
  // the reader may leave while this screen loads (screenOwner)
  const _mine = screenOwner();
  document.body.classList.add('apps-section');
  garageRouteSet(`garage/${carId}`);
  sbLeft.textContent = 'scan history';
  view.innerHTML = head(
    'Garage',
    garageCarLabel(car),
    [garageCarBits(car), car.vin].filter(Boolean).join('  ·  ')
  );

  const scans = garageScans(carId);
  sbRight.textContent = `${scans.length} scan${scans.length === 1 ? '' : 's'}`;

  const notes = garageNotesBox(car);
  view.appendChild(notes);

  // Run a scan from here: the whole-car script opens for this car and the
  // read that comes back is filed against it without asking.
  const run = await garageRunBox(car);
  if (run) view.appendChild(run);

  if (!scans.length) {
    const empty = document.createElement('div');
    empty.className = 'garage-empty';
    empty.textContent = run
      ? 'No scans yet. Run a fault scan or an identification read above and it is kept here.'
      : 'No scans yet. Run the whole-car fault or identification read in the module view, then press Save to garage.';
    view.appendChild(empty);
    setActions([
      ...(run ? garageRunActions(car, 0, run) : []),
      garageBackAction(showGarage),
    ]);
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'quick-sweep garage-history';
  wrap.innerHTML =
    `<div class="quick-bar"><div class="quick-head">${esc(
      `${scans.length} scan${scans.length === 1 ? '' : 's'}`
    )}</div><div class="quick-bar-btns"></div></div>` +
    `<div class="quick-rows"></div>`;
  const rowsEl = wrap.querySelector('.quick-rows');
  if (!_mine()) return;
  view.appendChild(wrap);

  // a fault scan compares with the fault scan before it, an identification
  // read with the one before it; the button names which pair it offers
  const pair = garageScanPair(scans);
  if (pair) {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent =
      pair.to.kind === 'ident'
        ? 'Compare latest identifications'
        : 'Compare latest fault scans';
    btn.onclick = () => showGarageDiff(carId, pair.from.id, pair.to.id);
    wrap.querySelector('.quick-bar-btns').appendChild(btn);
  }

  scans.forEach((scan) => {
    const row = document.createElement('div');
    row.className = 'quick-row garage-scan-row';
    const bad = scan.kind === 'faults' && scan.summary.faults > 0;
    row.classList.add(bad ? 'has-faults' : 'clean');
    row.innerHTML = `
      <span class="quick-ecu">
        <span class="garage-scan-when">${esc(garageDateText(scan.at))}</span>
        <span class="garage-scan-counts">${esc(garageScanCountsText(scan))}</span>
      </span>
      <span class="quick-status">
        <span class="garage-scan-kind">${esc(scan.kind === 'ident' ? 'Ident' : 'Faults')}</span>
        <button type="button" class="btn garage-scan-open">Open</button>
        <span class="garage-scan-share"></span>
        <button type="button" class="garage-scan-del" title="Delete this scan" aria-label="Delete">✕</button>
      </span>`;
    // Share beside Open: the link carries the report, nothing is stored
    if (typeof garageShareButton === 'function')
      row
        .querySelector('.garage-scan-share')
        .appendChild(garageShareButton(scan, car));
    row.querySelector('.garage-scan-open').onclick = () =>
      showGarageScan(carId, scan.id);
    row.querySelector('.garage-scan-del').onclick = async () => {
      const ok = await confirmDialog({
        title: 'Delete scan',
        body: esc(`Delete the scan from ${garageDateText(scan.at)}?`),
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      garageRemoveScan(carId, scan.id);
      showGarageCar(carId);
    };
    rowsEl.appendChild(row);
  });

  const acts = [
    {
      key: '1',
      label: 'Open latest',
      fn: () => showGarageScan(carId, scans[0].id),
    },
  ];
  if (pair)
    acts.push({
      key: '2',
      label: 'Compare',
      fn: () => showGarageDiff(carId, pair.from.id, pair.to.id),
    });
  if (run) acts.push(...garageRunActions(car, acts.length, run));
  acts.push(garageBackAction(showGarage));
  if (!_mine()) return;
  setActions(acts);
}

/**
 * Open the whole-car script for a car with the next save filed against it.
 * @param {GarageCar} car - the car
 * @param {string|null} menu - the script menu to open (m_fs for faults; the
 *   main menu carries the Identification key)
 * @param {RegExp} pressKey - the read key to press once the menu is up, by
 *   its caption, so the scan starts without a second press
 * @returns {void}
 */
function garageRunScan(car, menu, pressKey) {
  garageScanFor(car.id);
  showVehicleScript(car.chassis, menu, null, pressKey);
}

/** The live tree scan on a car's page, so only one runs at a time. */
let garageTreeScan = null;

/**
 * Run the merged fault scan on the car's own page, the way the tool does.
 *
 * NOT the whole-car .IPO script: that reads only the groups its author typed
 * out (41 on the E46) and sends every fault read with an empty argument,
 * which hides the blocks a module stores past the third. This walks ISTA's
 * control unit tree unioned with the groups only the script names (98 on the
 * E46) and asks each module for the read IT declares -- see
 * ecuTreeWalkTargets and ecuTreeFaultJobFor.
 *
 * The report is painted as each module answers, through the same renderer
 * the script path uses, and filed against the car when the walk ends.
 * @param {GarageCar} car - the car
 * @param {HTMLElement} box - the run row, for the buttons and the status line
 * @returns {void}
 */
function garageRunTreeScan(car, box) {
  if (garageTreeScan) return;
  const faultsBtn = box.querySelector('.garage-run-faults');
  const identBtn = box.querySelector('.garage-run-ident');
  const stopBtn = box.querySelector('.garage-run-stop');
  const out = box.querySelector('.garage-run-out');
  const note = box.querySelector('.garage-run-note');
  const wasNote = note ? note.textContent : '';
  if (faultsBtn) faultsBtn.hidden = true;
  if (identBtn) identBtn.disabled = true;
  if (stopBtn) stopBtn.hidden = false;
  if (out) out.hidden = false;

  /** Repaint the report, coalesced: a tick must not stack behind the last. */
  let painting = false;
  let latest = null;
  const paint = () => {
    if (!out || painting || !latest) return;
    painting = true;
    Promise.resolve(ipoProtocolRender(out, { view: { report: latest } }))
      .catch(() => {})
      .then(() => {
        painting = false;
      });
  };

  const handle = ecuTreeWalkStart(car.chassis, {
    onProgress: (report, text) => {
      if (garageTreeScan !== handle) return;
      if (report) latest = report;
      if (note && text) note.textContent = text;
      paint();
    },
  });
  garageTreeScan = handle;

  const finish = () => {
    if (garageTreeScan === handle) garageTreeScan = null;
    if (faultsBtn) faultsBtn.hidden = false;
    if (identBtn) identBtn.disabled = false;
    if (stopBtn) stopBtn.hidden = true;
  };
  handle.done.then(
    ({ report, lines, cancelled }) => {
      finish();
      latest = report || latest;
      paint();
      const got = report && (report.modules || []).length;
      if (!got) {
        if (note)
          note.textContent = cancelled
            ? 'Scan stopped. Nothing answered yet.'
            : 'Nothing answered on the bus.';
        return;
      }
      // the read is the car's own: filed without asking, as the tree screen does
      if (typeof garageAddScan === 'function')
        garageAddScan(
          car.id,
          { report, lines: lines || [] },
          { chassis: car.chassis }
        );
      if (note)
        note.textContent = cancelled
          ? 'Scan stopped. What was read is kept.'
          : 'Scan kept against this car.';
    },
    (e) => {
      finish();
      if (note) note.textContent = String((e && e.message) || e) || wasNote;
    }
  );
}

/**
 * The fault-memory read key of INPA's whole-vehicle scripts, by caption
 * (E46.IPO says "FS lesen"; others spell it out or ship it in English).
 */
const GARAGE_FAULT_KEY = /^(FS lesen|Fehlerspeicher lesen|Read fault memory)$/i;

/** The identification key on those scripts' main menu, by caption. */
const GARAGE_IDENT_KEY = /^(Ident|Identifikation|Identification)$/i;

/**
 * The "run a scan" row on a car's page: Fault scan and Identification, where
 * INPA's whole-car script ships for the chassis; nothing where it does not
 * (the module view is then the only way to read, and Save to garage asks).
 * @param {GarageCar} car - the car
 * @returns {Promise<HTMLDivElement|null>}
 */
async function garageRunBox(car) {
  if (!car.chassis) return null;
  // THE FAULT SCAN NO LONGER NEEDS THE SCRIPT. It walks the control unit
  // tree, so a chassis INPA ships no whole-car script for -- 17 of the 27 --
  // can still be scanned; only Identification, which is still a script read,
  // is gated on one being there.
  const canWalk =
    typeof ecuTreeWalkStart === 'function' &&
    typeof ipoProtocolRender === 'function' &&
    typeof ecuTreeNameFor === 'function' &&
    !!(await ecuTreeNameFor(car.chassis).catch(() => null));
  const hasScript =
    typeof showVehicleScript === 'function' &&
    typeof vehicleScriptShipped === 'function' &&
    (await vehicleScriptShipped(car.chassis).catch(() => false));
  if (!canWalk && !hasScript) return null;
  const box = document.createElement('div');
  box.className = 'garage-run';
  box.innerHTML = `
    <span class="garage-run-text">
      <span class="garage-run-title">Run a scan</span>
      <span class="garage-run-note">${esc(
        canWalk
          ? `Reads every control unit on ${dispChassis(car.chassis)}'s bus map; the result is kept here.`
          : `INPA's ${dispChassis(car.chassis)} script reads every module on the cable; the result is kept here.`
      )}</span>
    </span>
    <button type="button" class="btn garage-run-faults">Fault scan</button>
    <button type="button" class="btn garage-run-stop" hidden>Stop</button>
    <button type="button" class="btn garage-run-ident">Identification</button>
    <button type="button" class="btn garage-run-tree" hidden>Control unit tree</button>`;
  const outEl = document.createElement('div');
  outEl.className = 'garage-run-out';
  outEl.hidden = true;
  box.appendChild(outEl);
  // the fault scan runs HERE, on the tree, rather than opening the script;
  // without tree data it falls back to the script the way it always did
  const faultsEl = box.querySelector('.garage-run-faults');
  faultsEl.onclick = canWalk
    ? () => garageRunTreeScan(car, box)
    : () => garageRunScan(car, IPO_VEHICLE_FAULT_MENU, GARAGE_FAULT_KEY);
  box.querySelector('.garage-run-stop').onclick = () => {
    if (garageTreeScan) garageTreeScan.cancel();
  };
  // identification is still a script read: no script, no button
  const identEl = box.querySelector('.garage-run-ident');
  if (hasScript)
    identEl.onclick = () => garageRunScan(car, null, GARAGE_IDENT_KEY);
  else identEl.hidden = true;
  // ISTA's control unit tree, the boxes coloured by this car's last scan;
  // shown once the tree data says the chassis has one
  const treeBtn = box.querySelector('.garage-run-tree');
  if (
    typeof ecuTreeNameFor === 'function' &&
    typeof showEcuTreeChassis === 'function'
  ) {
    ecuTreeNameFor(car.chassis)
      .then((name) => {
        if (!name) return;
        treeBtn.hidden = false;
        treeBtn.onclick = () => showEcuTreeChassis(car.chassis, car.id);
      })
      .catch(() => {});
  }
  return box;
}

/**
 * The F-keys for the run row, numbered after the keys already on the bar.
 * @param {GarageCar} car - the car
 * @param {number} from - how many number keys the bar already holds
 * @returns {Array<{key: string, label: string, fn: Function}>}
 */
function garageRunActions(car, from, box) {
  // the keys PRESS THE ROW'S OWN BUTTONS rather than repeating what they do:
  // which scan Fault runs, and whether Identification exists at all, is
  // decided once in garageRunBox and must not be decided a second way here.
  const click = (sel) => () => {
    const b = box && box.querySelector(sel);
    if (b && !b.hidden && !b.disabled) b.click();
  };
  const acts = [
    {
      key: String(from + 1),
      label: 'Fault scan',
      fn: click('.garage-run-faults'),
    },
  ];
  const ident = box && box.querySelector('.garage-run-ident');
  if (!ident || !ident.hidden)
    acts.push({
      key: String(from + 2),
      label: 'Identification',
      fn: click('.garage-run-ident'),
    });
  return acts;
}

/**
 * The car's own note, saved as it is typed away from.
 * @param {GarageCar} car - the car
 * @returns {HTMLDivElement}
 */
function garageNotesBox(car) {
  const box = document.createElement('div');
  box.className = 'garage-notes';
  box.innerHTML = `
    <label class="garage-notes-label" for="garage-notes-input">Notes</label>
    <textarea id="garage-notes-input" class="garage-notes-input" rows="2"
      placeholder="Mileage, work done, anything to remember about this car."></textarea>`;
  const ta = box.querySelector('.garage-notes-input');
  ta.value = car.notes || '';
  ta.onchange = () => garageUpdateCar(car.id, { notes: ta.value });
  return box;
}

/**
 * One stored scan, drawn by the live view's own renderer.
 * @param {string} carId - the car
 * @param {string} scanId - the scan
 * @returns {Promise<void>}
 */
async function showGarageScan(carId, scanId) {
  const car = garageCar(carId);
  const scan = car && garageScan(carId, scanId);
  if (!scan) return showGarageCar(carId);
  lastScreen = () => showGarageScan(carId, scanId);
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: 'Garage', fn: showGarage },
    { label: garageCarLabel(car), fn: () => showGarageCar(carId) },
    { label: garageDateText(scan.at) },
  ]);
  // the reader may leave while this screen loads (screenOwner)
  const _mine = screenOwner();
  document.body.classList.add('apps-section');
  garageRouteSet(`garage/${carId}/${scanId}`);
  sbLeft.textContent = 'saved scan';
  view.innerHTML = head(
    'Garage',
    garageCarLabel(car),
    `${scan.kind === 'ident' ? 'Identification' : 'Fault memories'} · ${garageDateText(scan.at)}`
  );
  sbRight.textContent = garageScanCountsText(scan);

  const body = document.createElement('div');
  view.appendChild(body);
  // the running view's renderer, handed a stand-in carrying the stored report
  if (typeof ipoProtocolRender === 'function')
    await ipoProtocolRender(body, garageViewFor(scan));
  garageDisarmStoredReport(body);
  // the values each fault captured, with the range flags, under its row
  if (typeof garageAttachEnv === 'function')
    await garageAttachEnv(body, scan.report, {
      screensFor:
        typeof garageScreensFor === 'function' ? garageScreensFor : null,
    });

  // Share: a link that carries this report, nothing stored anywhere
  const bar = body.querySelector('.quick-bar-btns');
  if (bar && typeof garageShareButton === 'function')
    bar.appendChild(garageShareButton(scan, car));

  const scans = garageScans(carId);
  const prev = garagePrevSameKind(scans, scanId); // like with like only
  const acts = [];
  if (prev)
    acts.push({
      key: '1',
      label: 'Compare previous',
      fn: () => showGarageDiff(carId, prev.id, scanId),
    });
  acts.push({
    key: 'p',
    label: 'Print',
    kind: 'print',
    fn: () => garagePrintScan(car, scan),
  });
  if (typeof garageShareButton === 'function')
    acts.push({
      key: 's',
      label: 'Share',
      fn: () => {
        const b = view.querySelector('.garage-share');
        if (b) b.click();
      },
    });
  acts.push(garageBackAction(() => showGarageCar(carId)));
  if (!_mine()) return;
  setActions(acts);
}

/**
 * Print one stored scan on the app's sheet, through the same sections the
 * live view prints.
 * @param {GarageCar} car - the car
 * @param {GarageScan} scan - the scan
 * @returns {Promise<void>}
 */
function garagePrintScan(car, scan) {
  if (typeof printDoc !== 'function') return Promise.resolve();
  const sections =
    typeof ipoProtocolPrintSections === 'function'
      ? ipoProtocolPrintSections(garageViewFor(scan).view)
      : [];
  return printDoc({
    title: garageCarLabel(car),
    subtitle:
      scan.kind === 'ident' ? 'Identification' : 'Vehicle fault memories',
    meta: [
      ['Read', garageDateText(scan.at)],
      ['VIN', car.vin || '—'],
      ['Chassis', scan.chassis || car.chassis || '—'],
    ],
    sections,
  });
}
