/**
 * @file The Garage's car list: the vehicles the owner keeps, each with the
 * count of scans held against it. Adding a car reuses the shared VIN decoder
 * screen (screens/etk/identify.js) rather than a second VIN input, so a car
 * saved here decodes exactly as it does in Parts and Wiring.
 */

/* exported showGarage, showGarageAdd, garageDateText */

/** How many cars get a number key on the F-key bar. */
const GARAGE_FKEY_SLOTS = 8;

/**
 * The Settings key the add screen's own saved-VIN panel uses. The garage
 * keeps its cars in its own store; this is only the decoder's recent list, so
 * a VIN typed once is one click away the next time.
 */
const GARAGE_SAVED_VINS_KEY = 'garageVins';

/**
 * The Back action every Garage screen carries, in the shape the F-key bar
 * takes (core/core/actionbar.js).
 * @param {() => void} fn - where Back goes
 * @returns {object} the action
 */
function garageBackAction(fn) {
  return {
    key: 'Escape',
    keyLabel: 'Esc',
    label: 'Back',
    kind: 'back',
    fn,
  };
}

/**
 * An ISO timestamp as a short local date and time.
 * @param {string} iso - the timestamp
 * @returns {string}
 */
function garageDateText(iso) {
  const d = new Date(iso || '');
  if (isNaN(d.getTime())) return '';
  return (
    d.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }) +
    ' ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  );
}

/**
 * The one-line description under a car's name: chassis, engine, build date.
 * @param {GarageCar} car - the car
 * @returns {string}
 */
function garageCarBits(car) {
  const disp =
    typeof dispChassis === 'function' && car.chassis
      ? dispChassis(car.chassis)
      : car.chassis || '';
  const date =
    car.prod && typeof etkYearMonth === 'function'
      ? etkYearMonth(String(car.prod))
      : '';
  const body =
    car.body && typeof bodyLabel === 'function' ? bodyLabel(car.body) : '';
  return [disp, body, car.motor, date].filter(Boolean).join(' · ');
}

/**
 * The Garage: every saved car, newest first.
 * @returns {Promise<void>}
 */
async function showGarage() {
  lastScreen = showGarage;
  setCrumbs([{ label: 'Vehicles', fn: showChassis }, { label: 'Garage' }]);
  document.body.classList.add('apps-section'); // after setCrumbs, which clears it
  sbLeft.textContent = 'garage';
  view.innerHTML = head(
    'Garage',
    'My Vehicles',
    'Cars you keep, with the scan history read from each.'
  );

  const cars = garageCars();
  const list = document.createElement('div');
  list.className = 'garage-list stagger';
  view.appendChild(list);

  const addCard = document.createElement('button');
  addCard.type = 'button';
  addCard.className = 'lookup-entry garage-add';
  addCard.innerHTML = `
    <span class="lookup-entry-icon">+</span>
    <span class="lookup-entry-text">
      <span class="lookup-entry-title">Add a vehicle</span>
      <span class="lookup-entry-desc">Enter a VIN, or pick the chassis, to keep it here</span>
    </span>
    <span class="lookup-entry-arrow">→</span>`;
  addCard.onclick = () => showGarageAdd();
  list.appendChild(addCard);

  if (!cars.length) {
    const empty = document.createElement('div');
    empty.className = 'garage-empty';
    empty.textContent =
      'No vehicles yet. Add one, then save a whole-car scan to it from the module view.';
    list.appendChild(empty);
  }

  for (const car of cars) list.appendChild(garageCarCard(car));
  stagger(list, 20);
  sbRight.textContent = `${cars.length} vehicle${cars.length === 1 ? '' : 's'}`;

  setActions([
    ...cars.slice(0, GARAGE_FKEY_SLOTS).map((c, i) => ({
      key: String(i + 1),
      label: garageCarLabel(c).split(' ')[0],
      fn: () => showGarageCar(c.id),
    })),
    garageBackAction(showChassis),
  ]);
}

/**
 * One car's card: its name, what it is, and how much history it holds.
 * @param {GarageCar} car - the car
 * @returns {HTMLDivElement}
 */
function garageCarCard(car) {
  const scans = garageScans(car.id);
  const last = scans[0];
  const row = document.createElement('div');
  row.className = 'garage-car';
  const faults = last ? last.summary.faults : 0;
  const state = !last
    ? 'no scans yet'
    : `${scans.length} scan${scans.length === 1 ? '' : 's'} · last ${garageDateText(last.at)}`;
  // the fault count is the one styled fragment of the state line, so it is
  // built as markup while everything around it stays escaped
  const faultBit =
    last && last.kind === 'faults'
      ? ` · <b class="${faults ? 'garage-bad' : 'garage-good'}">${faults} fault${
          faults === 1 ? '' : 's'
        }</b>`
      : '';
  row.innerHTML = `
    <button type="button" class="garage-car-open">
      <span class="garage-car-name">${esc(garageCarLabel(car))}</span>
      <span class="garage-car-bits">${esc(garageCarBits(car))}</span>
      <span class="garage-car-state">${esc(state)}${faultBit}</span>
      ${car.vin ? `<span class="garage-car-vin mono">${esc(car.vin)}</span>` : ''}
    </button>
    <button type="button" class="garage-car-del" title="Remove this vehicle" aria-label="Remove">✕</button>`;
  row.querySelector('.garage-car-open').onclick = () => showGarageCar(car.id);
  row.querySelector('.garage-car-del').onclick = async () => {
    const n = scans.length;
    const ok = await confirmDialog({
      title: 'Remove vehicle',
      body: esc(
        `Remove ${garageCarLabel(car)}?` +
          (n ? ` Its ${n} saved scan${n === 1 ? '' : 's'} go too.` : '')
      ),
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    garageRemoveCar(car.id);
    showGarage();
  };
  return row;
}

/**
 * Add a vehicle: the shared VIN decoder, retargeted to keep the car rather
 * than open a catalogue. A chassis with no VIN is saved from the same screen's
 * attribute picker, so both paths land in the garage.
 * @returns {void}
 */
function showGarageAdd() {
  if (typeof showVinDecoder !== 'function') {
    // a build without the parts catalogue has no VIN index; fall back to the
    // chassis list, where picking a car saves it
    showGarageAddChassis();
    return;
  }
  showVinDecoder({
    eyebrow: 'Garage',
    title: 'Add a Vehicle',
    subtitle:
      'Enter your VIN, or identify the vehicle by series, body and model, to keep it in the garage.',
    crumbs: [
      { label: 'Vehicles', fn: showChassis },
      { label: 'Garage', fn: showGarage },
      { label: 'Add' },
    ],
    back: showGarage,
    savedKey: GARAGE_SAVED_VINS_KEY,
    openLabel: (disp) => `Keep this ${disp} in the garage →`,
    onResolve: (hit) => {
      const car = garageAddCar(garageCarFromHit(hit));
      showGarageCar(car.id);
    },
  });
}

/**
 * Fallback add screen: pick a chassis from the ones the build ships. Used
 * when no VIN index is present.
 * @returns {Promise<void>}
 */
async function showGarageAddChassis() {
  lastScreen = showGarageAddChassis;
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: 'Garage', fn: showGarage },
    { label: 'Add' },
  ]);
  document.body.classList.add('apps-section');
  sbLeft.textContent = 'add vehicle';
  view.innerHTML = head(
    'Garage',
    'Add a Vehicle',
    'Pick the chassis to keep in the garage.'
  );
  setActions([garageBackAction(showGarage)]);
  const ids = (await tryApi('/api/chassis', null, view)) || [];
  const grid = document.createElement('div');
  grid.className = 'chassis-grid stagger';
  for (const id of ids) {
    const card = document.createElement('div');
    card.className = 'chassis-card';
    card.innerHTML = `
      <div class="chassis-code">${esc(dispChassis(id))}</div>
      <div class="chassis-tag">${CHASSIS_TAG[id] || 'BMW'}</div>
      <div class="chassis-arrow">→</div>`;
    card.onclick = () => {
      const car = garageAddCar({ chassis: id, label: dispChassis(id) });
      showGarageCar(car.id);
    };
    grid.appendChild(card);
  }
  view.appendChild(grid);
  stagger(grid, 18);
}

// The topbar Garage button (index.html) opens the car list from any screen.
// The scripts load after the header is parsed, so the button exists here.
if (typeof document !== 'undefined' && document.getElementById) {
  const garageBtn = document.getElementById('garage-btn');
  if (garageBtn) garageBtn.onclick = () => showGarage();
}
