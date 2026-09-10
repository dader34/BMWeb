/**
 * @file The two pages the ISTA shell draws itself: Vehicle details and
 * Vehicle equipment.
 *
 * EVERY VALUE HERE IS READ BY CODE THAT ALREADY EXISTS. The FA comes out of
 * viFaText (which routes a packed 6-bit stream through the shipped FA.PRG
 * job rather than unpacking it by hand), the option names out of
 * readIdentityCodes and viOptionItem, the odometer out of
 * viReadStoredOdometer. This file decodes nothing. It is a layout over what
 * the identity screen already knows how to ask for, in the two shapes a
 * workshop wants them: "what is this car" and "what was it built with".
 *
 * What the Garage saved and what the car says are shown SIDE BY SIDE rather
 * than merged. When they disagree that is a finding -- a cluster swap, a
 * mis-typed VIN, the wrong car picked -- and merging them would hide it.
 */

/* exported istaShowDetails istaShowEquipment */

/** Odometer readings above this are not believed (see column.js VI_KM_MAX). */
const ISTA_KM_MAX = 2000000;

/**
 * One labelled row of the details table.
 * @param {string} label - the field name
 * @param {string} saved - what the Garage has, or ''
 * @param {string} read - what the car said, or ''
 * @returns {string} HTML
 */
function istaDetailRow(label, saved, read) {
  const same = saved && read && saved === read;
  const differs = saved && read && saved !== read;
  return (
    `<tr${differs ? ' class="ista-differs"' : ''}>` +
    `<th scope="row">${esc(label)}</th>` +
    `<td>${saved ? esc(saved) : '<span class="ista-none">—</span>'}</td>` +
    `<td>${
      read
        ? esc(read) + (same ? ' <span class="ista-match">✓</span>' : '')
        : '<span class="ista-none">—</span>'
    }</td></tr>`
  );
}

/**
 * Kilometres as a workshop writes them.
 * @param {number|null|undefined} km - the reading
 * @returns {string} e.g. "184 300 km", or '' when there is none
 */
function istaKm(km) {
  if (km == null || !Number.isFinite(Number(km))) return '';
  const n = Number(km);
  if (n <= 0 || n >= ISTA_KM_MAX) return '';
  return `${Math.round(n).toLocaleString('en-GB').replace(/,/g, ' ')} km`;
}

/**
 * Read what the car says about itself: VIN, odometer, and its build order.
 *
 * Reuses the identity screen's own discovery and column read, so a module
 * that can answer is found the same way and the FA is decoded by the same
 * job. Returns nulls rather than throwing: with no cable this page still has
 * the Garage half to show, and "the car did not answer" is a fine answer.
 * @param {string} chassis - the chassis id
 * @param {(t: string) => void} [say] - progress callback
 * @returns {Promise<{vin: string|null, km: number|null, fa: object|null,
 *   prod: number, sources: number}>}
 */
async function istaReadCar(chassis, say) {
  const out = { vin: null, km: null, fa: null, prod: 0, sources: 0 };
  if (typeof viIdentityModulesCached !== 'function') return out;
  const id = String(chassis || '').toUpperCase();
  try {
    if (typeof loadTables === 'function') await loadTables();
    if (typeof loadSaNames === 'function') await loadSaNames();
    if (say) say('Looking up which modules hold the build record…');
    const masters = await viIdentityModulesCached(id);
    if (!masters || !masters.length) return out;
    const fam =
      typeof VehicleIdentity !== 'undefined' && VehicleIdentity.familyMap
        ? VehicleIdentity.familyMap(id)
        : null;
    const famName = (m) =>
      typeof viFamilyName === 'function' ? viFamilyName(fam, m) : null;
    const sources = [];
    // every master is asked; the first that answers a field fills it, so a
    // cluster with no VIN still contributes its odometer
    for (let i = 0; i < masters.length; i++) {
      const m = masters[i];
      if (say)
        say(
          `Reading ${famName(m) || m.label || m.sgbd} ` +
            `(${i + 1} of ${masters.length})…`
        );
      let col;
      try {
        col = await viReadColumn(m, sources, famName);
      } catch (e) {
        continue; // a module that fails is not a page failure
      }
      out.sources++;
      if (!out.vin && col.vin) out.vin = col.vin;
      if (out.km == null && col.km != null) out.km = col.km;
      if (!out.fa && col.fa) out.fa = col.fa;
    }
    // the build date, for the dated SA names (BMW reused option numbers)
    if (out.vin && typeof viEtkDecode === 'function') {
      try {
        const etk = await viEtkDecode(out.vin);
        if (etk && etk.prod) out.prod = etk.prod;
      } catch (e) {
        /* the parts index is optional */
      }
    }
  } catch (e) {
    /* nothing answered; the saved half still draws */
  }
  return out;
}

/**
 * Vehicle details: what the car is, from the Garage and from the car.
 * @param {HTMLElement} host - where the page draws
 * @param {object|null} car - the picked GarageCar
 * @param {string} chassis - the chassis id
 * @returns {Promise<void>}
 */
async function istaShowDetails(host, car, chassis) {
  const id = String(chassis || '').toUpperCase();
  const disp = typeof dispChassis === 'function' ? dispChassis(id) : id;
  host.innerHTML =
    `<div class="ista-page">` +
    `<h2 class="ista-page-title">Vehicle details</h2>` +
    `<p class="ista-page-note">What the Garage has saved for this car, ` +
    `beside what the car itself reports. A row that disagrees is marked.</p>` +
    `<div class="ista-page-body"></div></div>`;
  const body = host.querySelector('.ista-page-body');
  const say = (t) => {
    if (body.querySelector('.ista-wait'))
      body.querySelector('.ista-wait span:last-child').textContent = t;
  };
  body.innerHTML =
    `<div class="ista-wait"><span class="wiring-spinner"></span>` +
    `<span>Asking the car…</span></div>`;

  const read = await istaReadCar(id, say);
  // the page may have been left while the bus was slow
  if (!host.isConnected) return;

  const savedProd =
    car && car.prod && typeof etkYearMonth === 'function'
      ? etkYearMonth(String(car.prod))
      : '';
  const readProd =
    read.prod && typeof etkYearMonth === 'function'
      ? etkYearMonth(String(read.prod))
      : '';
  const fa = read.fa;
  const rows =
    istaDetailRow('VIN', (car && car.vin) || '', read.vin || '') +
    istaDetailRow('Chassis', disp, fa && fa.br ? fa.br : '') +
    istaDetailRow(
      'Model',
      (car && car.model) || '',
      fa && fa.typ ? fa.typ : ''
    ) +
    istaDetailRow('Engine', (car && car.motor) || '', '') +
    istaDetailRow(
      'Body',
      car && car.body && typeof bodyLabel === 'function'
        ? bodyLabel(car.body)
        : (car && car.body) || '',
      ''
    ) +
    istaDetailRow('Build date', savedProd, readProd || (fa && fa.date) || '') +
    istaDetailRow('Paint', '', fa && fa.lack ? fa.lack : '') +
    istaDetailRow('Upholstery', '', fa && fa.polster ? fa.polster : '') +
    istaDetailRow('Odometer', '', istaKm(read.km));

  body.innerHTML =
    `<table class="ista-details">` +
    `<thead><tr><th scope="col">Field</th>` +
    `<th scope="col">Saved in the Garage</th>` +
    `<th scope="col">Read from the car</th></tr></thead>` +
    `<tbody>${rows}</tbody></table>` +
    (read.sources
      ? `<p class="ista-page-foot">${read.sources} module${
          read.sources === 1 ? '' : 's'
        } answered.</p>`
      : `<p class="ista-page-foot">Nothing answered on the bus, so the ` +
        `right-hand column is empty. The saved column is what the Garage ` +
        `holds.</p>`);
}

/**
 * Vehicle equipment: the SA option list, with names.
 *
 * readIdentityCodes is the whole read: it tries the build order first (its
 * tokens are already catalogue numbers), then the ZCS coding key through
 * BMW's chassis tables, and refuses to let a blank all-FF key fabricate a
 * list. viOptionItem names each one, dated, because BMW reused numbers.
 * @param {HTMLElement} host - where the page draws
 * @param {object|null} car - the picked GarageCar
 * @param {string} chassis - the chassis id
 * @returns {Promise<void>}
 */
async function istaShowEquipment(host, car, chassis) {
  const id = String(chassis || '').toUpperCase();
  host.innerHTML =
    `<div class="ista-page">` +
    `<h2 class="ista-page-title">Vehicle equipment</h2>` +
    `<p class="ista-page-note">Every option the car's build record carries. ` +
    `The number is BMW's; the name beside it is the catalogue's, picked by ` +
    `the build date.</p>` +
    `<div class="ista-page-body"><div class="ista-wait">` +
    `<span class="wiring-spinner"></span>` +
    `<span>Reading the build record…</span></div></div></div>`;
  const body = host.querySelector('.ista-page-body');

  if (typeof readIdentityCodes !== 'function') {
    body.innerHTML =
      `<div class="ista-none-box">This build has no vehicle-identity ` +
      `reader, so there is nothing to decode the option list with.</div>`;
    return;
  }

  // a build without the tables, or a bus that answers nothing, reads as "no
  // list" rather than taking the page down
  const got = await (async () => {
    try {
      if (typeof loadTables === 'function') await loadTables();
      if (typeof loadSaNames === 'function') await loadSaNames();
      return await readIdentityCodes(id);
    } catch (e) {
      return null;
    }
  })();
  if (!host.isConnected) return;

  const codes = (got && got.codes) || [];
  if (!codes.length) {
    body.innerHTML =
      `<div class="ista-none-box">No option list came back. Either no ` +
      `module on this car holds the build record, or nothing answered on ` +
      `the bus.</div>`;
    return;
  }

  // the build date the names are picked by: the saved one is enough, and it
  // does not cost a second read
  let date = 0;
  if (car && car.prod) date = Number(String(car.prod).padEnd(8, '0')) || 0;
  const items =
    typeof viOptionItem === 'function'
      ? codes.map((c) => viOptionItem(id, c, date)).join('')
      : codes
          .map((c) => `<li><span class="mono">${esc(c)}</span></li>`)
          .join('');
  body.innerHTML =
    `<ul class="vi-opt ista-equip">${items}</ul>` +
    `<p class="ista-page-foot">${codes.length} option${
      codes.length === 1 ? '' : 's'
    }${got && got.source ? ` · read from ${esc(got.source)}` : ''}</p>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ISTA_KM_MAX,
    istaDetailRow,
    istaKm,
    istaReadCar,
    istaShowDetails,
    istaShowEquipment,
  };
}
