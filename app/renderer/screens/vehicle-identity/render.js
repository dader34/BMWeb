/**
 * @file Vehicle identity: what a column SAYS about the car, and the HTML of
 * the three boxes -- NCS's "Information about car and ZCS/FA coding".
 *
 * Fifth piece of screens/vehicle-identity/. Three boxes, same as the
 * original: what the car is, the coding record, and the decoded option list.
 */

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

/**
 * A row of the parameter table: label, getter, and whether disagreement is
 * tolerated.
 * @typedef {[string, (c: ViColumn) => (string|number|null|undefined), boolean?]} ViTableRow
 */

/** The ZST keywords name the body in BMW's own vocabulary. */
const VI_BODY_WORDS = {
  LIM: 'Limousine',
  TOUR: 'Touring',
  COUP: 'Coupé',
  CABR: 'Cabrio',
  COMP: 'Compact',
};
/** An engine keyword: M52B25, N42B20, S62B50, W10B16. */
const VI_ENGINE_KW = /^[MNSW]\d{2,3}[A-Z]\d{2}/;
/** Gearbox letters the parts catalogue uses. */
const VI_GEAR_WORDS = { M: 'Manual', A: 'Automatic' };
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
  if (
    typeof loadVinIndex !== 'function' ||
    typeof decodeVin !== 'function' ||
    !vin
  )
    return null;
  try {
    const d = decodeVin(await loadVinIndex(), vin);
    if (!d) return null;
    let gear = null;
    if (typeof loadVehicles === 'function') {
      try {
        const veh = await loadVehicles();
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
 * What one column SAYS about the car, decoded from its own record.
 *
 * The type-key row of the ZST names the gearbox too (MAN / AUT beside LIM
 * and S62B50), which is how the original fills the cell without a parts
 * catalogue. ETK, when present, still wins: it knows the exact variant.
 * @param {string} id - Upper-case chassis id.
 * @param {ViColumn} col - The column.
 * @param {ViEtkDecode|null} etk - Its catalogue decode.
 * @returns {ViColumnInfo} The decoded facts.
 */
function viColInfo(id, col, etk) {
  const sa = col.keys ? VehicleIdentity.saCodesFromZcs(id, col.keys) : null;
  const kws = (sa && sa.keywords) || [];
  const bodyKw = kws.find((k) => VI_BODY_WORDS[k]);
  const engineKw = kws.find((k) => VI_ENGINE_KW.test(k));
  const gearKw = kws.includes('AUT')
    ? 'Automatic'
    : kws.includes('MAN')
      ? 'Manual'
      : null;
  return {
    chassis: (col.fa && col.fa.br) || id,
    model: (etk && etk.model) || null,
    body: (etk && etk.body) || (bodyKw ? VI_BODY_WORDS[bodyKw] : null),
    engine: engineKw || (etk && etk.motor) || null,
    gearbox: etk && etk.gear ? VI_GEAR_WORDS[etk.gear] || etk.gear : gearKw,
    typeKey: viTypeKey(col.vin) || (col.fa && col.fa.typ) || null,
    sa,
  };
}

/**
 * A key rendered the way the original renders it: body, dash, check
 * character.
 * @param {'Gm'|'Sa'|'Vn'} kind - Which key (selects the coding-zcs
 *   formatter).
 * @param {string|null|undefined} body - The key body.
 * @returns {string|null} "BODY-C", or the body as given when no formatter
 *   is loaded.
 */
function viZcsFmt(kind, body) {
  if (!body || typeof CodingZcs === 'undefined') return body || null;
  try {
    const f = CodingZcs['format' + kind](body);
    return `${f.slice(0, -1)}-${f.slice(-1)}`;
  } catch (e) {
    return body;
  }
}

/**
 * Parameter table: label column plus one column per master. A row nobody
 * answers is dropped; a row the columns DISAGREE on is flagged -- that
 * disagreement is the finding this screen exists to surface. Two values are
 * compatible when one contains the other (a short VIN inside the full one is
 * the same car, not a mismatch). `soft` rows never flag: the odometer copies
 * update at different moments and a 1 km skew is normal.
 * @param {ViColumn[]} cols - The columns, titled.
 * @param {ViTableRow[]} rows - The rows to render.
 * @returns {string} The table HTML.
 */
function viNcsTable(cols, rows) {
  let h =
    `<table class="vi-ncs"><thead><tr><th>Parameter</th>` +
    cols.map((c) => `<th>${esc(c.title)}</th>`).join('') +
    `</tr></thead><tbody>`;
  for (const [label, get, soft] of rows) {
    const vals = cols.map(get);
    if (!vals.some(Boolean)) continue;
    const norm = vals
      .filter(Boolean)
      .map((v) => String(v).replace(/\s+/g, '').toUpperCase());
    const compatible = norm.every((a) =>
      norm.every((b) => a.includes(b) || b.includes(a))
    );
    const mism = !soft && !compatible;
    h +=
      `<tr${mism ? ' class="vi-mismatch"' : ''}><td>${esc(label)}</td>` +
      vals.map((v) => `<td class="mono">${v ? esc(v) : '—'}</td>`).join('') +
      `</tr>`;
  }
  return h + `</tbody></table>`;
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

/**
 * The decoded option list, one column per master.
 * @param {string} id - Upper-case chassis id.
 * @param {ViColumn[]} cols - The columns, with `codes` and `etk` set.
 * @returns {string} The options box HTML.
 */
function viOptionsBox(id, cols) {
  const lists = cols
    .map((c) => {
      const codes = c.codes || [];
      if (!codes.length) {
        return (
          `<div><h4>${esc(c.title)}</h4>` +
          `<div class="vi-none">No options resolved.</div></div>`
        );
      }
      const date = (c.etk && c.etk.prod) || 0;
      const items = codes.map((code) => viOptionItem(id, code, date)).join('');
      return `<div><h4>${esc(c.title)}</h4><ul class="vi-opt">${items}</ul></div>`;
    })
    .join('');
  return (
    `<div class="vi-block"><h3>Options</h3>` +
    `<div class="vi-opt-grid" style="--vi-cols:${cols.length}">${lists}</div>` +
    `</div>`
  );
}

/**
 * The wait: a read is several jobs against several modules over a slow bus,
 * so the pane says what it is doing rather than sitting empty.
 * @param {string} text - What is happening.
 * @returns {string} The loading HTML.
 */
function viLoading(text) {
  return (
    `<div class="vi-loading"><span class="wiring-spinner"></span>` +
    `<span>${esc(text)}</span></div>`
  );
}

/**
 * The source strip: which ECU answered, and how.
 * @param {ViSource[]} entries - The strip entries.
 * @returns {string} The strip HTML, '' when empty.
 */
function viSources(entries) {
  if (!entries.length) return '';
  return (
    `<div class="vi-src">` +
    entries
      .map(
        (e) =>
          `<span class="vi-src-i ${e.ok ? 'ok' : 'bad'}">` +
          `<b>${esc(e.sg)}</b> ${esc(e.what)}</span>`
      )
      .join('') +
    `</div>`
  );
}
