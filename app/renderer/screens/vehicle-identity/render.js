/**
 * @file Vehicle identity: the two pieces of presentation the build record's
 * readers share -- the parts catalogue's decode of a VIN, and one equipment
 * option as a list item. (The workshop mode's Vehicle data draws with them.)
 *
 * Fifth piece of screens/vehicle-identity/.
 */

/* exported viEtkDecode, viOptionItem */

/**
 * The parts catalogue's decode of a VIN (screens/etk.js decodeVin), plus the
 * variant's gearbox from vehicles.json.
 * @typedef {object} ViEtkDecode
 * @property {string} chassis - Chassis (E46).
 * @property {string} body - Body style.
 * @property {string} model - Model name.
 * @property {string} [motor] - Engine.
 * @property {string} mospid - The production variant id.
 * @property {number} [prod] - Build date as YYYYMMDD.
 * @property {string|null} gear - Gearbox letter (M/A) or null.
 */

/**
 * What one column says about the car, decoded from its own record.
 * @typedef {object} ViColumnInfo
 * @property {string} chassis - The order's series, else the chassis id.
 * @property {string|null} model - From the parts catalogue.
 * @property {string|null} body - Catalogue body, else the ZST body keyword.
 * @property {string|null} engine - ZST engine keyword, else catalogue motor.
 * @property {string|null} gearbox - Catalogue gearbox, else the ZST MAN/AUT.
 * @property {string|null} typeKey - From the VIN or the order.
 * @property {ZcsEquipment|null} sa - The ZCS bridge answer, on a ZCS column.
 */

/** Width a numeric SA code is shown at (<0205>). */
const VI_SA_SHOWN_WIDTH = 4;

/**
 * ETK's VIN index resolves even the 7-char short VIN a cluster stores into
 * the exact production variant -- model, body, engine -- and vehicles.json
 * adds that variant's gearbox. Best-effort: a build without the parts
 * catalogue simply leaves those rows empty.
 * @param {string|null} vin - The VIN.
 * @returns {Promise<ViEtkDecode|null>} The decode, or null.
 */
async function viEtkDecode(vin) {
  if (typeof etk === 'undefined' || !vin) return null;
  try {
    const d = etk.decodeVin(await etk.loadVinIndex(), vin);
    if (!d) return null;
    let gear = null;
    {
      try {
        const veh = await etk.loadVehicles();
        const rows = ((veh[d.chassis] || {})[d.body] || {})[d.model] || [];
        const hit = rows.find((r) => r[3] === d.mospid);
        if (hit) gear = hit[1];
      } catch (e) {
        /* no gearbox column then */
      }
    }
    return { ...d, gear };
  } catch (e) {
    return null;
  }
}

/**
 * One option as a list item: <0530> Air conditioning KLIMAREGELUNG.
 *
 * Two dictionaries name a number. The ETK catalogue has the English name,
 * picked by the car's build date because BMW reused numbers (199 changed
 * meaning in 1999). The chassis AT table has the SGET keyword the coding
 * predicates key on (KLIMAREGELUNG). The name leads; the keyword stays on
 * the row, dimmed, because it is what the coding filter actually matches.
 * @param {string} id - Upper-case chassis id.
 * @param {string} code - The SA code.
 * @param {number} date - Build date for the dated name, 0 for none.
 * @returns {string} The <li> HTML.
 */
function viOptionItem(id, code, date) {
  const kw = VehicleIdentity.saLabel(id, code);
  const name = VehicleIdentity.saName(code, date);
  // numbers are shown four wide (<0205>); an alphanumeric code (<1CA>) is
  // a name, not a number, and is shown as itself
  const shown = /^\d+$/.test(String(code))
    ? String(code).padStart(VI_SA_SHOWN_WIDTH, '0')
    : String(code);
  const num = `<span class="mono">&lt;${esc(shown)}&gt;</span>`;
  if (name) {
    return (
      `<li>${num} <span class="vi-opt-name">${esc(name)}</span>` +
      (kw ? ` <span class="vi-opt-kw">${esc(kw)}</span>` : '') +
      `</li>`
    );
  }
  return `<li>${num} ${kw ? esc(kw) : ''}</li>`;
}
