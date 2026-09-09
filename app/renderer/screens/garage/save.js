/**
 * @file Keeping a live whole-car read. The module view calls garageOfferSave
 * once per report it draws; this puts a Save button on the report's own bar
 * and, when the car identified itself by a VIN already in the garage, files
 * the scan against that car without asking.
 */

/* exported garageOfferSave, garageVinFromView */

/** The protocol header line E46's script writes for the VIN it read from EWS. */
const GARAGE_VIN_LINE_RE =
  /^\s*(?:Fg-Nummer|Fahrgestellnummer|VIN)\s*:\s*(.+)$/i;

/**
 * Trailing commentary the script appends to the VIN it printed ("... read
 * from EWS"), in the languages the shipped scripts use.
 */
const GARAGE_VIN_NOTE_RE =
  /\s+(?:aus\s+\w+\s+ausgelesen|read\s+from\s+\w+)\s*$/i;

/**
 * The VIN a finished read identified the car by.
 *
 * Two sources, in the order they can be trusted: an identification read puts
 * the chassis number in the modules' own IDENT answers, and every whole-car
 * read prints it in the protocol header the script wrote. Both are the
 * number the car reported, not one the user typed.
 * @param {object} view - the program view ({report, lines})
 * @returns {string} the VIN, '' when the read did not name one
 */
function garageVinFromView(view) {
  const v = view || {};
  for (const m of (v.report && v.report.modules) || []) {
    const id = m.ident || {};
    // kombi and EWS spell the same number differently
    const raw = id.FG_NR || id.AIF_FG_NR || id.VIN;
    const s = String(raw == null ? '' : raw).trim();
    if (s.length >= GARAGE_VIN_TAIL && !/error/i.test(s))
      return s.toUpperCase();
  }
  for (const line of v.lines || []) {
    const m = GARAGE_VIN_LINE_RE.exec(String(line));
    if (!m) continue;
    const s = m[1].replace(GARAGE_VIN_NOTE_RE, '').trim();
    // the script prints its own failure on this line ("EWS-Error: ...")
    if (s.length >= GARAGE_VIN_TAIL && !/error/i.test(s))
      return s.toUpperCase();
  }
  return '';
}

/**
 * Offer to keep the report the module view just drew.
 *
 * Called once per report. When the car named a VIN the garage already holds,
 * the scan is filed against that car straight away -- the user asked for the
 * read, and a history that only fills up when someone remembers to press a
 * button is not a history. Any other case puts a button on the bar.
 * @param {HTMLElement} el - the element the report was drawn into
 * @param {object} view - the program view ({report, lines})
 * @param {object} [ecu] - the module the read ran from, for its chassis
 * @returns {void}
 */
function garageOfferSave(el, view, ecu) {
  const rep = view && view.report;
  if (!rep || !(rep.modules || []).length) return;
  const bar = el.querySelector('.quick-bar-btns');
  if (!bar || bar.querySelector('.garage-save')) return;

  const chassis = (ecu && ecu.chassis) || '';
  const vin = garageVinFromView(view);
  const known = vin ? garageFindByVin(vin) : null;

  const btn = document.createElement('button');
  btn.className = 'btn garage-save';
  bar.appendChild(btn);

  /**
   * Report the scan as kept, and offer the way to its history.
   * @param {GarageCar} car - the car it was filed against
   * @param {GarageScan} scan - the stored scan
   * @returns {void}
   */
  const kept = (car, scan) => {
    btn.textContent = `Saved to ${garageCarLabel(car)}`;
    btn.title = 'Open this scan in the garage';
    btn.onclick = () => showGarageScan(car.id, scan.id);
  };

  // the read was launched from a car's own page: it belongs there, unless
  // the car on the cable identified itself as a different one
  const target = garageScanTarget(vin);
  if (target) {
    const scan = garageAddScan(target.id, view, { chassis });
    if (scan) {
      // a car saved by chassis alone learns its VIN from the first read
      if (vin && !target.vin) garageUpdateCar(target.id, { vin });
      garageScanTargetClear();
      kept(garageCar(target.id) || target, scan);
      return;
    }
  }

  if (known) {
    // the car identified itself and we know it: keep the read without asking
    const scan = garageAddScan(known.id, view, { chassis });
    if (scan) {
      kept(known, scan);
      return;
    }
  }

  btn.textContent = 'Save to garage';
  btn.onclick = async () => {
    const car = await garagePickCar({ vin, chassis });
    if (!car) return;
    const scan = garageAddScan(car.id, view, { chassis });
    if (scan) kept(car, scan);
  };
}

/**
 * Ask which car this read belongs to, offering to add a new one. When the
 * read named a VIN, the new car is pre-filled with it.
 * @param {{vin: string, chassis: string}} ctx - what the read identified
 * @returns {Promise<GarageCar|null>} the chosen car, or null when dismissed
 */
async function garagePickCar(ctx) {
  const cars = garageCars();
  const addLabel = ctx.vin
    ? `Add a new vehicle (${ctx.vin})`
    : 'Add a new vehicle';
  if (!cars.length) {
    const ok = await confirmDialog({
      title: 'Save to garage',
      body: esc(
        ctx.vin
          ? `Keep this read against a new vehicle, ${ctx.vin}?`
          : 'The garage is empty. Keep this read against a new vehicle?'
      ),
      confirmLabel: 'Add vehicle',
    });
    return ok ? garageNewCarFrom(ctx) : null;
  }
  const choice = await garageCarDialog([
    ...cars.map((c) => ({
      value: c.id,
      label: garageCarLabel(c),
      note: c.vin || garageCarBits(c),
    })),
    { value: '_new', label: addLabel, note: '' },
  ]);
  if (!choice) return null;
  if (choice === '_new') return garageNewCarFrom(ctx);
  return garageCar(choice);
}

/**
 * Pick one car from a list, in the app's modal (core/core/dialogs.js).
 * @param {{value: string, label: string, note: string}[]} options - the choices
 * @returns {Promise<string|null>} the chosen value, or null when dismissed
 */
function garageCarDialog(options) {
  return new Promise((resolve) => {
    const { overlay, close } = openModal(
      `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title">Save to garage</div>
        <div class="modal-body">Which vehicle is this?</div>
        <div class="garage-pick">
          ${options
            .map(
              (o) =>
                `<button type="button" class="garage-pick-row" data-v="${esc(o.value)}">` +
                `<span class="garage-pick-name">${esc(o.label)}</span>` +
                (o.note
                  ? `<span class="garage-pick-note mono">${esc(o.note)}</span>`
                  : '') +
                `</button>`
            )
            .join('')}
        </div>
        <div class="modal-actions">
          <button class="btn modal-cancel">Cancel<span class="modal-key">Esc</span></button>
        </div>
      </div>`,
      { onClose: resolve, backdropValue: null }
    );
    overlay
      .querySelectorAll('.garage-pick-row')
      .forEach((b) => (b.onclick = () => close(b.dataset.v)));
    overlay.querySelector('.modal-cancel').onclick = () => close(null);
  });
}

/**
 * Add the car a read identified, decoding its VIN when one was reported so
 * the new entry carries the model rather than only a chassis code.
 * @param {{vin: string, chassis: string}} ctx - what the read identified
 * @returns {Promise<GarageCar>} the new car
 */
async function garageNewCarFrom(ctx) {
  /** @type {object} */
  let entry = { vin: ctx.vin, chassis: ctx.chassis };
  if (ctx.vin && typeof loadVinIndex === 'function') {
    try {
      const hit = decodeVin(await loadVinIndex(), ctx.vin);
      if (hit) {
        hit.vin = ctx.vin;
        entry = garageCarFromHit(hit);
      }
    } catch (e) {
      // no VIN index in this build: the chassis the read came from is enough
    }
  }
  if (!entry.chassis) entry.chassis = ctx.chassis;
  return garageAddCar(entry);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { garageVinFromView };
}
