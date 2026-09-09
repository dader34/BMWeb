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
      ...(run ? garageRunActions(car, 0) : []),
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
        <button type="button" class="garage-scan-del" title="Delete this scan" aria-label="Delete">✕</button>
      </span>`;
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
  if (run) acts.push(...garageRunActions(car, acts.length));
  acts.push(garageBackAction(showGarage));
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
  if (
    !car.chassis ||
    typeof showVehicleScript !== 'function' ||
    typeof vehicleScriptShipped !== 'function' ||
    !(await vehicleScriptShipped(car.chassis))
  )
    return null;
  const box = document.createElement('div');
  box.className = 'garage-run';
  box.innerHTML = `
    <span class="garage-run-text">
      <span class="garage-run-title">Run a scan</span>
      <span class="garage-run-note">${esc(
        `INPA's ${dispChassis(car.chassis)} script reads every module on the cable; the result is kept here.`
      )}</span>
    </span>
    <button type="button" class="btn garage-run-faults">Fault scan</button>
    <button type="button" class="btn garage-run-ident">Identification</button>`;
  box.querySelector('.garage-run-faults').onclick = () =>
    garageRunScan(car, IPO_VEHICLE_FAULT_MENU, GARAGE_FAULT_KEY);
  box.querySelector('.garage-run-ident').onclick = () =>
    garageRunScan(car, null, GARAGE_IDENT_KEY);
  return box;
}

/**
 * The F-keys for the run row, numbered after the keys already on the bar.
 * @param {GarageCar} car - the car
 * @param {number} from - how many number keys the bar already holds
 * @returns {Array<{key: string, label: string, fn: Function}>}
 */
function garageRunActions(car, from) {
  return [
    {
      key: String(from + 1),
      label: 'Fault scan',
      fn: () => garageRunScan(car, IPO_VEHICLE_FAULT_MENU, GARAGE_FAULT_KEY),
    },
    {
      key: String(from + 2),
      label: 'Identification',
      fn: () => garageRunScan(car, null, GARAGE_IDENT_KEY),
    },
  ];
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
