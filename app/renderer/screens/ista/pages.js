/**
 * @file The pages the ISTA layout draws itself: the VIN start page, Read Out
 * Vehicle Data, the four-column Vehicle details, Vehicle equipment, the
 * session list, and the honest greyed page for a tab the real tool has that
 * this build cannot fill.
 *
 * NOTHING HERE READS THE CAR ON ARRIVAL. Every page below draws from what is
 * already known -- the Garage's saved columns, the parts catalogue's decode
 * of a VIN, the cable's own port label -- and a read starts only when a
 * button on the page is pressed. That is the rule the real tool follows and
 * the one that keeps a tab from waking a car nobody asked it to touch.
 *
 * A GREYED PAGE STILL DRAWS ITS LAYOUT. The tool has tabs this build has no
 * data for (fault patterns, the measures plan, programming). Leaving them out
 * would make the chrome read as broken; drawing an empty white page would
 * make it read as failed. So each one draws the real layout -- its headings,
 * its empty bordered table, its Attention box -- with the honest reason
 * written in it. The technician sees the tab they expect, and sees exactly
 * why it has nothing in it.
 */

/* exported istaPageVin istaPageReadout istaPageActive istaPageGrey
   istaRealDetails istaRealEquipment */

/** A VIN is 17 characters, or the 7-character production number alone. */
const ISTA_VIN_RE = /^(?:[A-HJ-NPR-Z0-9]{17}|[A-Z0-9]{7})$/;

/**
 * Is this a VIN the shell will act on?
 * @param {string} v - what was typed
 * @returns {boolean}
 */
function istaVinOk(v) {
  return ISTA_VIN_RE.test(
    String(v || '')
      .trim()
      .toUpperCase()
  );
}

/**
 * A value, or the tool's "-" placeholder.
 * @param {*} v - the value
 * @returns {string} HTML-escaped text
 */
function istaVal(v) {
  return v == null || v === '' ? '-' : esc(String(v));
}

// ---- Operations / New / VIN ------------------------------------------------

/**
 * The VIN start page: the centred input, and under it the Garage table.
 *
 * The Garage table is OURS, not the real tool's -- it has a dealer's order
 * system where we have the cars this machine has already seen. It sits in
 * the same place and speaks the same table language, so it reads as part of
 * the page rather than as a bolt-on.
 * @param {HTMLElement} host - where to draw
 * @param {object} ctx - the shell's callbacks
 * @param {(car: object|null, vin: string) => void} ctx.open - open a vehicle
 * @param {(fn: (ok: boolean) => void) => void} ctx.onValid - tell the bottom
 *   bar whether Open operation should be live
 * @returns {void}
 */
function istaPageVin(host, ctx) {
  const cars = typeof garageCars === 'function' ? garageCars() : [];
  const rows = cars
    .map((c) => {
      const scans = typeof garageScans === 'function' ? garageScans(c.id) : [];
      const last = scans.length ? scans[0].at : '';
      const when = last ? String(last).slice(0, 10) : '-';
      const name =
        typeof garageCarLabel === 'function' ? garageCarLabel(c) : c.label;
      return (
        `<tr data-car="${esc(c.id)}">` +
        `<td>${istaVal(c.vin)}</td>` +
        `<td>${istaVal(name)}</td>` +
        `<td>${esc(when)}</td></tr>`
      );
    })
    .join('');

  host.innerHTML =
    `<div class="irvin">` +
    `<div class="irvin-label">Input VIN:</div>` +
    `<input class="irvin-box" id="ista-vin-box" maxlength="17" ` +
    `autocomplete="off" spellcheck="false" aria-label="Input VIN" />` +
    `<div class="irvin-garage">` +
    `<h3>Garage</h3>` +
    `<table class="irtable"><thead><tr>` +
    `<th>VIN</th><th>Vehicle</th><th>Last scan</th>` +
    `</tr></thead><tbody>${rows}</tbody></table>` +
    (rows
      ? ''
      : `<div class="irvin-empty">No vehicles saved yet. Type a VIN ` +
        `above, or read one off the car on Read Out Vehicle Data.</div>`) +
    `</div></div>`;

  const box = host.querySelector('#ista-vin-box');
  let picked = null;

  const sync = () => {
    const ok = picked != null || istaVinOk(box.value);
    if (ctx.onValid) ctx.onValid(ok);
  };

  box.oninput = () => {
    // typing is a different intent from picking: clear the row selection so
    // the two cannot disagree about which car Open operation means
    if (picked) {
      picked = null;
      host.querySelectorAll('tbody tr.sel').forEach((r) => {
        r.classList.remove('sel');
      });
    }
    sync();
  };
  box.onkeydown = (e) => {
    if (e.key === 'Enter' && (picked || istaVinOk(box.value)))
      ctx.open(picked, box.value);
  };

  host.querySelectorAll('tbody tr[data-car]').forEach((tr) => {
    tr.onclick = () => {
      host.querySelectorAll('tbody tr.sel').forEach((r) => {
        r.classList.remove('sel');
      });
      tr.classList.add('sel');
      picked = cars.find((c) => c.id === tr.dataset.car) || null;
      if (picked && picked.vin) box.value = picked.vin;
      sync();
    };
    tr.ondblclick = () => {
      const c = cars.find((x) => x.id === tr.dataset.car) || null;
      if (c) ctx.open(c, c.vin || '');
    };
  });

  // the shell's Open operation button asks for these when it fires
  host._istaPick = () => ({ car: picked, vin: box.value });
  sync();
  if (box.focus) box.focus();
}

// ---- Operations / New / Read Out Vehicle Data ------------------------------

/**
 * Read Out Vehicle Data: the two instruction lines and the connection
 * manager, with one row for the cable this machine has.
 *
 * The row's fields are the ones the cable can actually answer. Device ID is
 * its port label, Type is the interface this app speaks, State says whether
 * it is open. Colour, VIN and KL15 are the tool's columns for a workshop
 * full of networked interfaces and stay "-" here: inventing a colour code
 * for a USB cable would be decoration pretending to be data.
 * @param {HTMLElement} host - where to draw
 * @param {object} ctx - the shell's callbacks
 * @returns {Promise<void>}
 */
async function istaPageReadout(host, ctx) {
  host.innerHTML =
    `<div class="irread">` +
    `<ul class="irread-lines">` +
    `<li>- Connect the vehicle interface.</li>` +
    `<li>- Switch on the ignition or activate the ` +
    `testing-analysis-diagnosis at the vehicle.</li>` +
    `</ul>` +
    `<div class="irconn">` +
    `<div class="irconn-head">Connection manager</div>` +
    `<table class="irtable"><thead><tr>` +
    `<th>Device ID</th><th>Color</th><th>Type</th><th>VIN</th>` +
    `<th>Connection</th><th>KL15 [V]</th><th>State</th>` +
    `</tr></thead><tbody id="ista-conn-rows"></tbody></table>` +
    `<div class="irconn-foot">` +
    `<button type="button" class="irbtn" disabled>Configure vehicle ` +
    `interface</button>` +
    `<button type="button" class="irbtn" disabled>Break connection</button>` +
    `<button type="button" class="irbtn" disabled>Set up connection</button>` +
    `</div></div></div>`;

  const tb = host.querySelector('#ista-conn-rows');
  // the cable's own label, and whether the engine says it is open
  let label = '';
  let connected = false;
  let kl15 = '';
  try {
    const st = await api('/api/state');
    connected = !!st.connected;
    label = st.port || '';
    if (st.ignition === true && st.battery != null && !st.derived)
      kl15 = Number(st.battery).toFixed(1);
  } catch (e) {
    /* no engine: the row still draws, as "not connected" */
  }
  if (!host.isConnected) return;
  if (!label && typeof webBus === 'object' && webBus && webBus.connected)
    label = webBus.portLabel();

  tb.innerHTML =
    `<tr class="sel"><td>${istaVal(label || 'No interface')}</td>` +
    `<td>-</td><td>K+DCAN</td><td>-</td>` +
    `<td>${connected ? 'USB' : '-'}</td>` +
    `<td>${istaVal(kl15)}</td>` +
    `<td>${connected ? 'Connected' : 'Free'}</td></tr>`;
}

// ---- Operations / Active ---------------------------------------------------

/**
 * The session list: the vehicle this shell is open on.
 * @param {HTMLElement} host - where to draw
 * @param {object|null} car - the picked GarageCar
 * @param {string} chassis - the chassis id
 * @returns {void}
 */
function istaPageActive(host, car, chassis) {
  const name =
    car && typeof garageCarLabel === 'function' ? garageCarLabel(car) : '';
  const rows = car
    ? `<tr class="sel"><td>${istaVal(car.vin)}</td>` +
      `<td>${istaVal(name)}</td>` +
      `<td>${istaVal(typeof dispChassis === 'function' ? dispChassis(chassis) : chassis)}</td>` +
      `<td>${istaVal(String(car.added || '').slice(0, 10))}</td></tr>`
    : '';
  host.innerHTML =
    `<div class="irread">` +
    `<table class="irtable"><thead><tr>` +
    `<th>VIN</th><th>Vehicle</th><th>Chassis</th><th>Opened</th>` +
    `</tr></thead><tbody>${rows}</tbody></table>` +
    (rows
      ? ''
      : `<div class="irvin-empty">No vehicle is open. Start one on ` +
        `Operations / New.</div>`) +
    `</div>`;
}

// ---- a tab the real tool has that this build cannot fill -------------------

/**
 * A greyed page: the real layout, with the honest reason written in it.
 * @param {HTMLElement} host - where to draw
 * @param {string} title - the tab's name
 * @param {string} why - why it has nothing in it
 * @param {object} [shape] - the layout to draw under the reason
 * @param {string[]} [shape.cols] - an empty table with these column heads
 * @param {string} [shape.attention] - an Attention box with this text
 * @returns {void}
 */
function istaPageGrey(host, title, why, shape) {
  const s = shape || {};
  host.innerHTML =
    `<div class="irgrey">` +
    `<div class="irgrey-t">${esc(title)}</div>` +
    `<div class="irgrey-w">${esc(why)}</div>` +
    (s.cols
      ? `<table class="irtable" style="margin-top:16px"><thead><tr>` +
        s.cols.map((c) => `<th>${esc(c)}</th>`).join('') +
        `</tr></thead><tbody></tbody></table>` +
        `<div class="irempty-box"></div>`
      : '') +
    (s.attention
      ? `<div class="irgrey-att"><b>Attention:</b> ${esc(s.attention)}</div>`
      : '') +
    `</div>`;
}

// ---- Vehicle details, the four-column grid ---------------------------------

/**
 * The four columns of Vehicle details, in the tool's own order.
 *
 * The order is not alphabetical and not grouped by source: it is the order
 * the real tool uses, which a technician reads by position. Each entry is
 * [label, value, warn].
 *
 * THE TRIANGLE IS NOT "THIS CAME FROM THE VIN". The frames settle it: on a
 * fully decoded E46 the tool draws exactly one triangle, on Sales
 * designation, and none on Series, Engine, Body or Production date -- all of
 * which the VIN gave it. It marks the field the tool could not resolve at
 * all, so that is what it marks here: a flagged field whose value is still
 * missing. Flagging every VIN-derived field instead covers the grid in
 * triangles and makes the one that matters invisible.
 * @param {object|null} car - the picked GarageCar
 * @param {object|null} etk - the VIN decode
 * @param {object} read - what a read found: {km, fa, vin}
 * @returns {Array<Array<Array>>} four columns of [label, value, fromVin]
 */
function istaDetailColumns(car, etk, read) {
  const e = etk || {};
  const c = car || {};
  const fa = read.fa || {};
  const prod = String(e.prod || c.prod || '');
  const yr = prod.length >= 4 ? prod.slice(0, 4) : '';
  const mo = prod.length >= 6 ? prod.slice(4, 6) : '';
  const date =
    prod.length >= 8
      ? `${prod.slice(6, 8)}/${prod.slice(4, 6)}/${prod.slice(0, 4)}`
      : prod.length >= 6
        ? `${mo}/${yr}`
        : '';
  const body =
    typeof bodyLabel === 'function' ? bodyLabel(e.body || c.body) : e.body;
  const gear = e.gear === 'A' ? 'AUTO' : e.gear === 'M' ? 'MANUAL' : '';
  const steer = e.steer === 'R' ? 'RL' : e.steer === 'L' ? 'LL' : '';
  const km = typeof istaKm === 'function' ? istaKm(read.km) : '';
  // the fields the tool flags when it has no value for them
  const flagged = new Set(['Sales designation']);
  const f = (label, value) => [label, value, flagged.has(label) && !value];
  return [
    [
      f('VIN', read.vin || c.vin || ''),
      f('Mileage:', km),
      f('Drive type', ''),
      f('Production date', date),
      f('Body', body),
      f('First registration', ''),
      f('Basic version', e.market || ''),
    ],
    [
      f('Series', e.model || c.model || ''),
      f('Engine', e.motor || c.motor || ''),
      f('Engine label', fa.motor || ''),
      f('Construction date:', yr && mo ? `${yr} / ${mo}` : ''),
      f('Steering', steer),
      f('Engine number', ''),
      f('Upholstery code', fa.polster || ''),
    ],
    [
      f(
        'Development code:',
        String(e.chassis || c.chassis || '').toUpperCase()
      ),
      f('Electrical drive unit', ''),
      f('E-drive unit designation', ''),
      f('I-Level factory:', ''),
      f('Model code', e.mospid || ''),
      f('Gearbox number', ''),
      f('Paint code', fa.lack || ''),
    ],
    [
      f('Sales designation', ''),
      f('Gearbox', gear),
      f('HMI version', ''),
      f('I-Level actual:', ''),
      f('Last used program version:', ''),
      f('Type approval no.:', ''),
      f('Road-Map/Abo', ''),
    ],
  ];
}

/**
 * Vehicle details, in the tool's four-column layout.
 * @param {HTMLElement} host - where to draw
 * @param {object|null} car - the picked GarageCar
 * @param {object|null} etk - the VIN decode
 * @param {object} read - what a read found, or {} for none
 * @returns {void}
 */
function istaRealDetails(host, car, etk, read) {
  const cols = istaDetailColumns(car, etk, read || {});
  const warn = `<span class="irdet-warn">${istaRealIcon('warn')}</span>`;
  // the triangle marks the flagged field the tool could not resolve, so it
  // rides on the EMPTY one: gating it on a value would hide the only case
  // it exists for
  const field = ([label, value, flag]) =>
    `<div class="irdet-f">` +
    `<div class="irdet-l">${esc(label)}` +
    (flag ? warn : '') +
    `</div>` +
    `<div class="irdet-v">${istaVal(value)}</div></div>`;

  host.innerHTML =
    `<div class="irdet">` +
    cols
      .map((col, i) => {
        const fields = col.map(field).join('');
        // the Technical actions mini table hangs off the first column
        const extra =
          i === 0
            ? `<div class="irdet-sub">Technical actions:</div>` +
              `<table class="irdet-ta"><thead><tr>` +
              `<th>State</th><th>Special defect code</th><th>Title</th>` +
              `</tr></thead><tbody></tbody></table>`
            : '';
        return `<div class="irdet-col">${fields}${extra}</div>`;
      })
      .join('') +
    `<div class="irdet-bd">` +
    `<div class="irdet-bd-l">Breakdown:</div>` +
    `<div class="irdet-bd-r">` +
    `<label><input type="radio" name="ista-bd" value="yes" /> Yes</label>` +
    `<label><input type="radio" name="ista-bd" value="no" checked /> No` +
    `</label></div></div>` +
    `</div>`;
}

// ---- Vehicle equipment -----------------------------------------------------

/**
 * Vehicle equipment, in the tool's layout: the activation-code header, the
 * Retrofit heading, then the option list.
 * @param {HTMLElement} host - where to draw
 * @param {string[]} codes - the SA codes the build record carries
 * @param {(code: string) => string} nameOf - the catalogue name for a code
 * @returns {void}
 */
function istaRealEquipment(host, codes, nameOf) {
  const list = (codes || [])
    .map(
      (c) => `<li><b>${esc(c)}</b>${esc(nameOf ? nameOf(c) || '' : '')}</li>`
    )
    .join('');
  host.innerHTML =
    `<div class="ireq">` +
    `<h3>Activation code status (before implementation of the measures ` +
    `plan)</h3>` +
    `<table class="irtable"><thead><tr>` +
    `<th>Control unit</th><th>SWID</th><th>Description</th><th>Status</th>` +
    `</tr></thead><tbody></tbody></table>` +
    `<h3>Retrofit</h3>` +
    `<div class="ireq-empty">-</div>` +
    `<h3>Optional equipment</h3>` +
    (list
      ? `<ul class="ireq-list">${list}</ul>`
      : `<div class="ireq-empty">No option list came back. Either no ` +
        `module on this car holds the build record, or nothing answered ` +
        `on the bus.</div>`) +
    `</div>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ISTA_VIN_RE,
    istaVinOk,
    istaVal,
    istaPageVin,
    istaPageReadout,
    istaPageActive,
    istaPageGrey,
    istaDetailColumns,
    istaRealDetails,
    istaRealEquipment,
  };
}
