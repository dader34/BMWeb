/**
 * @file Wiring as its own section: the landing page where the car is picked
 * (or identified by VIN) rather than arriving via a chassis.
 */

/* exported
   showWiringChassis, wiringClassic */

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
 * Whether wiring wears WDS's own look: the classic layout (the top bar's
 * switch) or the INPA skin.
 * @returns {boolean}
 */
function wiringClassic() {
  return (
    (typeof inpaMode === 'function' && inpaMode()) ||
    (typeof inpaTheme === 'function' && inpaTheme())
  );
}

/** WDS's series names: the model line before the chassis code. */
const WDS_SERIES = {
  E38: '7',
  E39: '5',
  E46: '3',
  E52: 'Z8',
  E53: 'X5',
  E60: '5',
  E63: '6',
  E65: '7',
  E70: 'X5',
  E71: 'X6',
  E83: 'X3',
  E85: 'Z4',
  E87: '1',
  E89: 'Z4',
  E90: '3',
  F01: '7',
};

/**
 * A side-on saloon in WDS's grey, standing in for the series photo when
 * there is none (WDS's pictures are not part of this build).
 * @returns {string} SVG markup
 */
function wiringCarSilhouette() {
  return `<svg class="wds-car-svg" viewBox="0 0 160 70" aria-hidden="true">
    <path d="M8 48 L12 36 Q16 31 26 30 L48 28 Q60 16 76 14 L104 14 Q118 15 130 27 L146 30 Q154 32 154 40 L154 48 Z"
          fill="#c9ccd2" stroke="#5a5f68" stroke-width="1.5"/>
    <path d="M56 28 Q66 18 78 17 L100 17 Q112 18 120 28 Z" fill="#8fa3bd" stroke="#5a5f68" stroke-width="1"/>
    <line x1="88" y1="17" x2="88" y2="28" stroke="#5a5f68" stroke-width="1.5"/>
    <circle cx="40" cy="49" r="11" fill="#2b2e33"/><circle cx="40" cy="49" r="5" fill="#9aa0a8"/>
    <circle cx="124" cy="49" r="11" fill="#2b2e33"/><circle cx="124" cy="49" r="5" fill="#9aa0a8"/>
  </svg>`;
}

/**
 * One series on WDS's selection page: the caption bar ("3  E46") over its
 * picture. A photo at img/wds-series/<chassis>.jpg is used when the build
 * carries one; otherwise the drawn car stands in.
 * @param {string} id - chassis code
 * @returns {HTMLButtonElement}
 */
function wiringSeriesTile(id) {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'wds-car';
  const series = WDS_SERIES[id] || '';
  tile.innerHTML =
    `<span class="wds-car-cap">${esc(series)}&nbsp;&nbsp;${esc(dispChassis(id))}</span>` +
    `<span class="wds-car-pic">${wiringCarSilhouette()}</span>`;
  const img = new Image();
  img.alt = '';
  img.onload = () => {
    const pic = tile.querySelector('.wds-car-pic');
    pic.innerHTML = '';
    pic.appendChild(img);
  };
  img.src = `img/wds-series/${encodeURIComponent(id)}.jpg`;
  tile.onclick = () => showWiring(id);
  return tile;
}

/**
 * WDS's series-selection page: its toolbar and blue title bar (the same
 * chrome the diagram screen wears), the "Series selection" bar, and the
 * white page the tiles go on.
 * @returns {string}
 */
function wiringSeriesFrameHtml() {
  return `
    <div class="wds-series">
      <div class="wds-toolbar">
        <button class="wds-btn" id="wds-sel-print" title="Print this page">Print</button>
        <button class="wds-btn" id="wds-sel-exit" title="Leave wiring and return home">Exit</button>
      </div>
      <div class="wds-titlebar">
        <span>WDS BMW Wiring Diagram System - English</span>
        <span class="wds-version">Version 5.0</span>
      </div>
      <div class="wds-sectionbar">Series selection</div>
      <div class="wds-series-body">
        <div class="wds-series-head">
          <span>Select series</span>
        </div>
      </div>
    </div>`;
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
  // the reader may leave while this screen loads (screenOwner)
  const _mine = screenOwner();
  sbLeft.textContent = 'wiring';
  // no F-key bar on wiring, either layout (the diagram screen drops it too);
  // Esc and the number keys still work. setCrumbs restores it.
  document.body.classList.add('wds-nofkeys');
  setActions([wiringPickerBackAction()]);

  // WDS's own look in the classic layout (or under the INPA skin): its
  // series-selection page, picture tiles under WDS's toolbar and title bar
  const classic = wiringClassic();
  let host = view;
  if (classic) {
    view.innerHTML = wiringSeriesFrameHtml();
    host = view.querySelector('.wds-series-body');
    wiringOn(view, '#wds-sel-exit', showApps);
    wiringOn(view, '#wds-sel-print', () => window.print());
  } else {
    view.innerHTML = head(
      'WDS',
      'Wiring Diagrams',
      'BMW’s own schematics. Enter a VIN or pick a vehicle to browse its diagrams.'
    );
  }

  // VIN search: decode the VIN to a chassis (same index the Parts catalogue
  // uses) and open its wiring. A saved VIN is remembered and pre-filled, so a
  // returning user is one Enter away from their car.
  host.appendChild(buildWiringVinBox());

  const grid = document.createElement('div');
  grid.className = classic ? 'wds-series-grid' : 'chassis-grid stagger';

  // fill the page while the 21 probes run (several seconds on a hosted site)
  const wait = wiringLoadingEl('Looking for the vehicles with diagrams…');
  host.appendChild(wait);
  host.appendChild(grid);

  const ids = await wiringChassisList();
  wait.remove();
  if (!ids.length) {
    host.appendChild(wiringAbsentNote());
    return;
  }
  ids.forEach((id, i) =>
    grid.appendChild(
      classic ? wiringSeriesTile(id) : wiringChassisCard(id, i, false)
    )
  );
  if (!classic) stagger(grid, 22);
  if (!_mine()) return;
  sbRight.textContent = `${ids.length} chassis`;
  if (!_mine()) return;
  setActions([
    ...ids.slice(0, WIRING_PICKER_HOTKEYS).map((id, i) => ({
      key: String(i + 1),
      label: dispChassis(id),
      fn: () => showWiring(id),
    })),
    wiringPickerBackAction(),
  ]);
}
