/**
 * @file VIN decoding. A BMW VIN's last 7 characters are the sequential
 * production number. vin-index maps each production-number range to a
 * vehicle, so a VIN resolves to its exact chassis + variant and the catalogue
 * (or the wiring viewer, which shares this) opens pre-filtered.
 */

/* exported VIN_PROD_LEN, loadVinIndex, decodeVin */

/**
 * The gzipped vin-index.json.
 * @typedef {object} EtkVinIndex
 * @property {[string, string, string, string, string, string][]} variants - [chassis, mospid, model, body, motor, steer]
 * @property {[string, string, number, string][]} ranges - [from, to, variant index, production date], sorted by `from`
 */

/**
 * A decoded VIN (or a vehicle picked by attributes, which produces the same
 * shape minus `motor`/`pn`). This is what the identify screen hands to its
 * `onResolve` and what the saved-vehicles panel stores.
 * @typedef {object} EtkVinHit
 * @property {string} [pn] - the 7-character production number
 * @property {string} chassis - chassis code
 * @property {string} [mospid] - ETK's internal vehicle id
 * @property {string} [model] - model name
 * @property {string} [body] - body code
 * @property {string} [motor] - engine code (VIN path only)
 * @property {string} [steer] - 'L' or 'R'
 * @property {string} [gear] - gearbox code (attribute path only)
 * @property {string} [prod] - production / introduction date as YYYYMMDD
 * @property {string} [vin] - the VIN as entered, upper-cased
 */

/** Length of the production number at the end of a BMW VIN. */
const VIN_PROD_LEN = 7;

/** @type {EtkVinIndex|null} */
let etkVinIndex = null;

/**
 * Load (and cache) the VIN index, gunzipping it in the browser.
 * @param {EtkProgressFn} [onProgress] - called as the file downloads
 * @returns {Promise<EtkVinIndex>}
 * @throws {Error} when neither copy is reachable
 */
async function loadVinIndex(onProgress) {
  if (etkVinIndex) return etkVinIndex;
  const hit = await etkFetchFirst('vin-index.json.gz');
  if (!hit) throw new Error('VIN data not available');
  const bytes = await readWithProgress(hit.resp, onProgress);
  const json = fflate.strFromU8(fflate.gunzipSync(bytes));
  etkVinIndex = JSON.parse(json);
  return etkVinIndex;
}

/**
 * Resolve a VIN (or a bare 7-character production number) to its vehicle.
 * The ranges are sorted by their start, so this binary-searches them.
 * @param {EtkVinIndex} idx - the loaded index
 * @param {string} vinRaw - the VIN as typed (whitespace and case are forgiven)
 * @returns {EtkVinHit|null} the vehicle, or null when no range covers the number
 */
function decodeVin(idx, vinRaw) {
  const vin = String(vinRaw || '')
    .trim()
    .toUpperCase()
    .replace(/\s/g, '');
  // last 7 chars are the production number; a bare 7-char code is accepted too
  const pn =
    vin.length >= VIN_PROD_LEN
      ? vin.slice(-VIN_PROD_LEN)
      : vin.padStart(VIN_PROD_LEN, '0');
  const R = idx.ranges;
  let lo = 0,
    hi = R.length - 1,
    hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [von, bis] = R[mid];
    if (pn < von) hi = mid - 1;
    else if (pn > bis) lo = mid + 1;
    else {
      hit = mid;
      break;
    }
  }
  if (hit < 0) return null;
  const [, , vi, prod] = R[hit];
  const v = idx.variants[vi]; // [chassis,mospid,model,body,motor,steer]
  return {
    pn,
    chassis: v[0],
    mospid: v[1],
    model: v[2],
    body: v[3],
    motor: v[4],
    steer: v[5],
    prod,
  };
}
