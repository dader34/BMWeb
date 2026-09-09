/**
 * @file The Garage's persistence: the cars the user owns and the whole-car
 * scans kept against each. Pure data, no DOM -- the screens draw what these
 * return, and the node harness drives them directly.
 *
 * Two keys sit beside the app's other settings (core/core/settings.js writes
 * the whole map to localStorage on every set):
 *
 *   bmweb.garage.cars   GarageCar[]                  the saved vehicles
 *   bmweb.garage.scans  {[carId]: GarageScan[]}      newest first, capped
 *
 * Scans are kept per car rather than in one flat list so dropping a car drops
 * its history in one write, and so the cap is per car -- a car scanned every
 * week never pushes another car's history out.
 */

/* exported
   GARAGE_CARS_KEY, GARAGE_SCANS_KEY, GARAGE_SCAN_CAP,
   garageCars, garageCar, garageAddCar, garageUpdateCar, garageRemoveCar,
   garageCarLabel, garageFindByVin, garageScans, garageScan, garageAddScan,
   garageRemoveScan, garageScanSummary, garageCarFromHit, garageNewId,
   garageScanFor, garageScanTargetClear, garageScanTarget */

/** Settings key holding the saved cars. */
const GARAGE_CARS_KEY = 'bmweb.garage.cars';

/** Settings key holding the per-car scan history. */
const GARAGE_SCANS_KEY = 'bmweb.garage.scans';

/**
 * How many scans are kept per car. The oldest is dropped past this. Reports
 * carry every fault of every module, so the whole history has to stay inside
 * localStorage's few megabytes.
 */
const GARAGE_SCAN_CAP = 50;

/** Characters at the end of a BMW VIN that identify the car (production number). */
const GARAGE_VIN_TAIL = 7;

/**
 * One car in the garage.
 * @typedef {object} GarageCar
 * @property {string} id - stable local id; scans are keyed by it
 * @property {string} [vin] - full VIN or the 7-character production number, upper-case
 * @property {string} chassis - chassis code (E46, ...)
 * @property {string} label - what the lists show
 * @property {string} added - ISO timestamp
 * @property {string} [notes] - the owner's own note
 * @property {string} [model] - model name, when a VIN decoded it
 * @property {string} [body] - body code
 * @property {string} [motor] - engine code
 * @property {string} [prod] - build date, YYYYMM(DD)
 */

/**
 * One stored whole-car read. `report` is the live view's own report object
 * (screens/ipo-runtime/protocol.js builds it), kept as-is so the history view
 * can hand it straight back to that file's renderer.
 * @typedef {object} GarageScan
 * @property {string} id - stable local id
 * @property {string} carId - the car it belongs to
 * @property {string} at - ISO timestamp of the read
 * @property {'faults'|'ident'} kind
 * @property {string} [chassis] - the chassis it was read on
 * @property {object} report - the IpoProtocolReport as stored
 * @property {string[]} [lines] - INPA's own protocol text
 * @property {GarageScanSummary} summary - counts, so a list needs no report walk
 */

/**
 * The counts a history row shows.
 * @typedef {object} GarageScanSummary
 * @property {number} modules - modules that answered
 * @property {number} withFaults - of those, how many had stored faults
 * @property {number} faults - total stored faults
 * @property {number} silent - addresses that did not answer
 */

/**
 * Read a JSON value from Settings, guarding the shape the caller expects.
 * A hand-edited or half-written value must not take the screen down, so
 * anything of the wrong shape reads as empty.
 * @param {string} key - the Settings key
 * @param {*} fallback - value when unset or the wrong shape
 * @param {(v: *) => boolean} shapeOk - shape guard
 * @returns {*}
 */
function garageRead(key, fallback, shapeOk) {
  if (typeof Settings !== 'object' || !Settings || !Settings.get)
    return fallback;
  const v = Settings.get(key, fallback);
  return shapeOk(v) ? v : fallback;
}

/**
 * Write a JSON value to Settings.
 * @param {string} key - the Settings key
 * @param {*} val - the value
 * @returns {void}
 */
function garageWrite(key, val) {
  if (typeof Settings === 'object' && Settings && Settings.set)
    Settings.set(key, val);
}

/**
 * A short, collision-free local id. Time-prefixed so ids sort by creation
 * even when two are minted in the same millisecond.
 * @returns {string}
 */
function garageNewId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/**
 * Every saved car, in the order they were added to the front (newest first).
 * @returns {GarageCar[]}
 */
function garageCars() {
  return garageRead(GARAGE_CARS_KEY, [], Array.isArray).slice();
}

/**
 * One saved car by id.
 * @param {string} id - the car id
 * @returns {GarageCar|null}
 */
function garageCar(id) {
  return garageCars().find((c) => c.id === id) || null;
}

/**
 * A car's display name: the owner's label, else what the VIN decoded to,
 * else the bare chassis.
 * @param {GarageCar} car - the car
 * @returns {string}
 */
function garageCarLabel(car) {
  if (!car) return '';
  if (car.label) return car.label;
  const disp =
    typeof dispChassis === 'function'
      ? dispChassis(car.chassis)
      : car.chassis || '';
  return [disp, car.model].filter(Boolean).join(' ') || car.vin || 'Vehicle';
}

/**
 * The car a VIN belongs to. BMW VINs are matched on the 7-character
 * production number at the end, so a car saved by its short code still
 * matches the full VIN a module reports (and the other way round).
 * @param {string} vin - a VIN or production number
 * @returns {GarageCar|null}
 */
function garageFindByVin(vin) {
  const v = String(vin || '')
    .trim()
    .toUpperCase()
    .replace(/\s/g, '');
  if (v.length < GARAGE_VIN_TAIL) return null;
  const tail = v.slice(-GARAGE_VIN_TAIL);
  return (
    garageCars().find((c) => {
      const cv = String(c.vin || '')
        .trim()
        .toUpperCase();
      return (
        cv.length >= GARAGE_VIN_TAIL && cv.slice(-GARAGE_VIN_TAIL) === tail
      );
    }) || null
  );
}

/**
 * Add a car, or fold it into the one already holding that VIN. Returns the
 * stored car either way, so a caller can navigate straight to it.
 * @param {Partial<GarageCar>} entry - at least a chassis, usually a VIN too
 * @returns {GarageCar} the stored car
 */
function garageAddCar(entry) {
  const e = entry || {};
  const vin = String(e.vin || '')
    .trim()
    .toUpperCase()
    .replace(/\s/g, '');
  const existing = vin ? garageFindByVin(vin) : null;
  if (existing) {
    // same car re-saved: keep its id (and its scans) and refresh what decoded.
    // The longer VIN wins -- a car first saved by the 7-character production
    // number gains the full number when a read reports it, and never loses
    // the full one to a later short match.
    const prev = String(existing.vin || '');
    return garageUpdateCar(existing.id, {
      chassis: e.chassis || existing.chassis,
      label: e.label || existing.label,
      model: e.model || existing.model,
      body: e.body || existing.body,
      motor: e.motor || existing.motor,
      prod: e.prod || existing.prod,
      vin: vin.length >= prev.length ? vin || prev : prev,
    });
  }
  /** @type {GarageCar} */
  const car = {
    id: garageNewId(),
    chassis: String(e.chassis || '').toUpperCase(),
    label: String(e.label || ''),
    added: new Date().toISOString(),
  };
  if (vin) car.vin = vin;
  if (e.notes) car.notes = String(e.notes);
  for (const k of ['model', 'body', 'motor', 'prod'])
    if (e[k]) car[k] = String(e[k]);
  if (!car.label) car.label = garageCarLabel(car);
  garageWrite(GARAGE_CARS_KEY, [car, ...garageCars()]);
  return car;
}

/**
 * Change a saved car's fields.
 * @param {string} id - the car id
 * @param {Partial<GarageCar>} patch - fields to set; undefined values are ignored
 * @returns {GarageCar|null} the updated car
 */
function garageUpdateCar(id, patch) {
  const list = garageCars();
  const i = list.findIndex((c) => c.id === id);
  if (i < 0) return null;
  const next = { ...list[i] };
  for (const [k, v] of Object.entries(patch || {}))
    if (v !== undefined && k !== 'id') next[k] = v;
  list[i] = next;
  garageWrite(GARAGE_CARS_KEY, list);
  return next;
}

/**
 * Drop a car and every scan kept against it.
 * @param {string} id - the car id
 * @returns {void}
 */
function garageRemoveCar(id) {
  garageWrite(
    GARAGE_CARS_KEY,
    garageCars().filter((c) => c.id !== id)
  );
  const all = garageAllScans();
  if (id in all) {
    delete all[id];
    garageWrite(GARAGE_SCANS_KEY, all);
  }
}

/**
 * The whole scan map, car id -> scans.
 * @returns {Object<string, GarageScan[]>}
 */
function garageAllScans() {
  return garageRead(
    GARAGE_SCANS_KEY,
    {},
    (v) => !!v && typeof v === 'object' && !Array.isArray(v)
  );
}

/**
 * A car's scans, newest first.
 * @param {string} carId - the car id
 * @returns {GarageScan[]}
 */
function garageScans(carId) {
  const list = garageAllScans()[carId];
  return Array.isArray(list) ? list.slice() : [];
}

/**
 * One stored scan.
 * @param {string} carId - the car id
 * @param {string} scanId - the scan id
 * @returns {GarageScan|null}
 */
function garageScan(carId, scanId) {
  return garageScans(carId).find((s) => s.id === scanId) || null;
}

/**
 * Count what a report holds, for the history rows.
 * @param {object} report - an IpoProtocolReport
 * @returns {GarageScanSummary}
 */
function garageScanSummary(report) {
  const mods = (report && report.modules) || [];
  const withFaults = mods.filter((m) => (m.codes || []).length);
  return {
    modules: mods.length,
    withFaults: withFaults.length,
    faults: withFaults.reduce((n, m) => n + m.codes.length, 0),
    silent: ((report && report.silent) || []).length,
  };
}

/**
 * One fault, ready to be stored as JSON.
 *
 * F_HEX_CODE arrives from the web VM as a byte array. JSON.stringify turns a
 * typed array into {"0":39,"1":218}, which hexText() then cannot read -- the
 * reloaded fault would draw as "[object Object]". Flattening it here to the
 * same dashed string the native path produces keeps a reloaded scan
 * byte-identical to a live one, and costs less space than the byte map.
 * @param {object} code - an FS_LESEN entry
 * @returns {object} the entry as stored
 */
function garageCompactCode(code) {
  const out = { ...code };
  if (out.F_HEX_CODE != null && typeof out.F_HEX_CODE !== 'string') {
    const flat =
      typeof hexText === 'function'
        ? hexText(out.F_HEX_CODE)
        : String(out.F_HEX_CODE);
    if (flat) out.F_HEX_CODE = flat;
    else delete out.F_HEX_CODE;
  }
  return out;
}

/**
 * Strip a report down to what the history needs to redraw and diff it. The
 * live report carries whatever the wire returned; only the fields the
 * renderer and the diff read are kept, so a long history stays inside
 * localStorage.
 * @param {object} report - the live IpoProtocolReport
 * @returns {object} the stored report
 */
function garageCompactReport(report) {
  const r = report || {};
  return {
    kind: r.kind === 'ident' ? 'ident' : 'faults',
    modules: (r.modules || []).map((m) => {
      /** @type {object} */
      const out = {
        sgbd: m.sgbd,
        via: m.via,
        label: m.label,
        codes: (m.codes || []).map(garageCompactCode),
      };
      if (m.ident) out.ident = { ...m.ident };
      return out;
    }),
    silent: (r.silent || []).map((s) => ({
      target: s.target,
      label: s.label,
      error: s.error,
    })),
    // the viewer's own toggle, never persisted as "on": a reopened scan
    // always shows the table first
    showText: false,
  };
}

/**
 * Keep a scan against a car, dropping the oldest past the cap.
 * @param {string} carId - the car it belongs to
 * @param {object} view - the program view ({report, lines}) or a bare report
 * @param {{chassis?: string, at?: string}} [meta] - what the live view knows
 * @returns {GarageScan|null} the stored scan, or null when there is no report
 */
function garageAddScan(carId, view, meta) {
  const v = view || {};
  const report = v.report || (v.modules ? v : null);
  if (!carId || !report || !(report.modules || []).length) return null;
  const m = meta || {};
  const compact = garageCompactReport(report);
  /** @type {GarageScan} */
  const scan = {
    id: garageNewId(),
    carId,
    at: m.at || new Date().toISOString(),
    kind: compact.kind,
    report: compact,
    summary: garageScanSummary(compact),
  };
  if (m.chassis) scan.chassis = String(m.chassis).toUpperCase();
  if (Array.isArray(v.lines) && v.lines.length) scan.lines = v.lines.slice();
  const all = garageAllScans();
  const list = Array.isArray(all[carId]) ? all[carId] : [];
  all[carId] = [scan, ...list].slice(0, GARAGE_SCAN_CAP);
  garageWrite(GARAGE_SCANS_KEY, all);
  return scan;
}

/**
 * Drop one scan.
 * @param {string} carId - the car id
 * @param {string} scanId - the scan id
 * @returns {void}
 */
function garageRemoveScan(carId, scanId) {
  const all = garageAllScans();
  if (!Array.isArray(all[carId])) return;
  all[carId] = all[carId].filter((s) => s.id !== scanId);
  garageWrite(GARAGE_SCANS_KEY, all);
}

/**
 * Turn a decoded VIN (the shared decoder's EtkVinHit) into a garage entry.
 * @param {object} hit - the decoded VIN
 * @returns {Partial<GarageCar>}
 */
function garageCarFromHit(hit) {
  const h = hit || {};
  const disp =
    typeof dispChassis === 'function' && h.chassis
      ? dispChassis(h.chassis)
      : h.chassis || '';
  return {
    vin: h.vin,
    chassis: h.chassis,
    label: [disp, h.model].filter(Boolean).join(' '),
    model: h.model,
    body: h.body,
    motor: h.motor,
    prod: h.prod,
  };
}

// ---- the car a scan launched from the garage belongs to ----------------------

/**
 * How long a scan started from a car's page stays filed against that car
 * (a whole-car read on a cold cable can take minutes; a day is generous).
 */
const GARAGE_TARGET_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The car whose page launched the read now running, if any. In memory only:
 * it lives exactly as long as the page the scan runs in.
 * @type {{carId: string, at: number}|null}
 */
let garageTarget = null;

/**
 * File the next saved scan against this car: the garage's own Fault scan /
 * Identification buttons call it before opening the whole-car script.
 * @param {string} carId - the car
 * @returns {void}
 */
function garageScanFor(carId) {
  garageTarget = carId ? { carId: String(carId), at: Date.now() } : null;
}

/**
 * Forget the pending target (after a save took it).
 * @returns {void}
 */
function garageScanTargetClear() {
  garageTarget = null;
}

/**
 * The car a just-finished read should be filed against without asking: the
 * one whose page launched it, provided the read did not identify itself as
 * a different car. A VIN the read found must match the car's own when the
 * car has one; a car saved without a VIN accepts whatever the read found.
 * @param {string} [vin] - the VIN the read identified, if any
 * @returns {GarageCar|null}
 */
function garageScanTarget(vin) {
  if (!garageTarget) return null;
  if (Date.now() - garageTarget.at > GARAGE_TARGET_TTL_MS) {
    garageTarget = null;
    return null;
  }
  const car = garageCar(garageTarget.carId);
  if (!car) {
    garageTarget = null;
    return null;
  }
  if (vin && car.vin) {
    const a = String(vin).toUpperCase().slice(-GARAGE_VIN_TAIL);
    const b = String(car.vin).toUpperCase().slice(-GARAGE_VIN_TAIL);
    if (a !== b) return null;
  }
  return car;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    GARAGE_CARS_KEY,
    GARAGE_SCANS_KEY,
    GARAGE_SCAN_CAP,
    garageCars,
    garageCar,
    garageAddCar,
    garageUpdateCar,
    garageRemoveCar,
    garageCarLabel,
    garageFindByVin,
    garageScans,
    garageScan,
    garageAddScan,
    garageRemoveScan,
    garageScanSummary,
    garageCompactReport,
    garageCarFromHit,
    garageNewId,
    garageScanFor,
    garageScanTargetClear,
    garageScanTarget,
  };
}
