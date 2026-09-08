/**
 * @file Wiring as its own section: the landing page where the car is picked
 * (or identified by VIN) rather than arriving via a chassis.
 */

/* exported
   showWiringChassis */

/** How many chassis get a number key on the picker's F-key bar. */
const WIRING_PICKER_HOTKEYS = 9;

/**
 * One car on the picker: an F-key row in INPA mode, a card otherwise.
 * @param {string} id - chassis code
 * @param {number} i - position in the list (numbers the F-key row)
 * @param {boolean} classic - the INPA skin is on (WDS chrome)
 * @returns {HTMLButtonElement}
 */
function wiringChassisCard(id, i, classic) {
  const tag = (typeof CHASSIS_TAG === 'object' && CHASSIS_TAG[id]) || 'BMW';
  const card = document.createElement('button');
  if (classic) {
    // INPA idiom: an F-key list, not cards
    card.className = 'inpa-fn';
    card.innerHTML =
      `<span class="inpa-fn-key">&lt; F${i + 1} &gt;</span>` +
      `<span class="inpa-fn-label">${esc(dispChassis(id))} · ${esc(tag)}</span>`;
  } else {
    card.className = 'chassis-card';
    card.innerHTML = `
        <div class="chassis-code">${esc(dispChassis(id))}</div>
        <div class="chassis-tag">${esc(tag)}</div>
        <div class="chassis-arrow">→</div>`;
  }
  card.onclick = () => showWiring(id);
  return card;
}

/**
 * The note shown when no car ships wiring. NOT an error (errorBlock's
 * cable/ignition advice would be irrelevant): the hosted site just can't
 * carry 1.1 GB over the GitHub Pages cap.
 * @returns {HTMLDivElement}
 */
function wiringAbsentNote() {
  const note = document.createElement('div');
  note.className = 'empty wiring-absent';
  note.innerHTML = `
      <div class="empty-big">No wiring data in this build</div>
      <div>The diagrams come from BMW's WDS, which is a separate download and
           not part of this repository.</div>
      <div style="font-size:12px;color:var(--ink-faint)">To add them:
           <code>scripts/setup/fetch-wds.sh</code> then
           <code>tools/wds_import.py --wds vendor/WDS</code>.</div>`;
  return note;
}

/**
 * The picker's Back key: out to the Apps hub.
 * @returns {{key: string, keyLabel: string, label: string, kind: string, fn: () => void}}
 */
function wiringPickerBackAction() {
  return {
    key: 'Escape',
    keyLabel: 'Esc',
    label: 'Back',
    kind: 'back',
    fn: showApps,
  };
}

/**
 * The picker: a VIN entry card, then every car with diagrams.
 * @returns {Promise<void>}
 */
async function showWiringChassis() {
  lastScreen = showWiringChassis;
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: 'Apps', fn: showApps },
    { label: 'Wiring' },
  ]);
  sbLeft.textContent = 'wiring';
  view.innerHTML = head(
    'WDS',
    'Wiring Diagrams',
    'BMW’s own schematics. Enter a VIN or pick a vehicle to browse its diagrams.'
  );
  setActions([wiringPickerBackAction()]);

  // VIN search: decode the VIN to a chassis (same index the Parts catalogue
  // uses) and open its wiring. A saved VIN is remembered and pre-filled, so a
  // returning user is one Enter away from their car.
  view.appendChild(buildWiringVinBox());

  // the WDS look follows the INPA skin, not the layout mode
  const classic = typeof inpaTheme === 'function' && inpaTheme();
  const grid = document.createElement('div');
  grid.className = classic ? 'inpa-vlist' : 'chassis-grid stagger';

  // fill the page while the 21 probes run (several seconds on a hosted site)
  const wait = wiringLoadingEl('Looking for the vehicles with diagrams…');
  view.appendChild(wait);
  view.appendChild(grid);

  const ids = await wiringChassisList();
  wait.remove();
  if (!ids.length) {
    view.appendChild(wiringAbsentNote());
    return;
  }
  ids.forEach((id, i) => grid.appendChild(wiringChassisCard(id, i, classic)));
  if (!classic) stagger(grid, 22);
  sbRight.textContent = `${ids.length} chassis`;
  setActions([
    ...ids.slice(0, WIRING_PICKER_HOTKEYS).map((id, i) => ({
      key: String(i + 1),
      label: dispChassis(id),
      fn: () => showWiring(id),
    })),
    wiringPickerBackAction(),
  ]);
}
