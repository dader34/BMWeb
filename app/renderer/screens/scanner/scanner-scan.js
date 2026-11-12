/**
 * @file BMWeb Scanner: the scan itself, with no screen in it.
 *
 * One walk down a list of units: identify each, read the fault counts of
 * those that answered, and -- as asked -- read their fault lists or clear
 * them. The Scanner's window (scanner.js) draws it; opened for a Garage
 * car it also has the fault lists read, which scanner-report.js files
 * against the car.
 *
 * Everything that touches the cable comes in through `io`, so the walk is
 * plain control flow that tools/verify/test_scanner_scan.js runs against a
 * fake car.
 */

/* exported scannerScanUnits, scannerFaultListWanted */

/**
 * What a scan learned about one unit that answered.
 * @typedef {object} ScannerUnitResult
 * @property {ScannerModule} module
 * @property {ScannerIdent} id - Its identification.
 * @property {number[]} raw - The identification answer, as received.
 * @property {'found'} state
 * @property {number|null} errors - The fault count; null when not given.
 * @property {number|null} shadow - The shadow-memory count; null when the
 *   unit has none or did not give it.
 * @property {{errors: ScannerFault[]|null, shadow: ScannerFault[]|null}} [faults] -
 *   The fault lists, when the scan was asked for them and the counts did
 *   not already say both are empty.
 * @property {string[]|null} [trace] - Every telegram of a clearing scan.
 * @property {number|null} [after] - The fault count read after a clear.
 */

/**
 * The cable, as the walk uses it.
 * @typedef {object} ScannerScanIo
 * @property {(m: ScannerModule) => Promise<{id: ScannerIdent, raw: number[]}|null>} identify
 * @property {(m: ScannerModule, how: object, rec: string[]|null) => Promise<{errors: number|null, shadow: number|null}>} counts
 * @property {(m: ScannerModule, how: object) => Promise<{errors: ScannerFault[]|null, shadow: ScannerFault[]|null}>} faultList
 * @property {(m: ScannerModule, how: object, rec: string[]|null) => Promise<{ok: boolean, left: number|null, error?: string}>} clearFaults
 */

/**
 * Where a walk stands, for whoever draws it.
 *   ask      the unit is about to be identified
 *   silent   it did not answer
 *   failed   asking it threw (the cable went away); the walk ends
 *   found    it identified (`r` is its result from here on)
 *   counted  its fault counts are in
 *   clearing its fault memory is about to be cleared
 *   cleared  the clear and the read after it are in
 *   done     nothing more will be read from it
 * @typedef {'ask'|'silent'|'failed'|'found'|'counted'|'clearing'|'cleared'|'done'} ScannerScanPhase
 */

/**
 * Is a unit's fault list worth reading once its counts are known?
 *
 * Not when the counts say every memory it has is empty. A count that did
 * not come is not a zero, so that unit is read; and the light module is
 * always read, because its 04 00 count does not cover the eight blocks its
 * faults are filed in.
 * @param {ScannerModule} m
 * @param {{errors: number|null, shadow: number|null}} counts
 * @returns {boolean}
 */
function scannerFaultListWanted(m, counts) {
  const how = SCANNER_FAULT_READ[m.name] || {};
  if (how.lcm) return true;
  if (counts.errors !== 0) return true;
  return SCANNER_SHADOW.includes(m.name) && counts.shadow !== 0;
}

/**
 * Walk the units: identify, count, and optionally list or clear.
 *
 * A clearing scan clears every unit with stored or shadow-memory faults, as
 * the reference does, and reads its count again. Fault lists are read
 * before any clear. The walk never throws: a cable failure ends it and
 * comes back as `error`, with everything read up to then.
 * @param {object} opts
 * @param {ScannerModule[]} opts.units - The units, in the order to ask.
 * @param {() => boolean} opts.alive - False once the scan is stopped.
 * @param {ScannerScanIo} opts.io - The cable.
 * @param {boolean} [opts.clear] - Clear the units that have faults.
 * @param {boolean} [opts.faults] - Read the fault lists.
 * @param {(phase: ScannerScanPhase, m: ScannerModule, r: ScannerUnitResult|null, index: number) => void} [opts.on]
 * @returns {Promise<{answered: ScannerUnitResult[], cleared: number, error: Error|null}>}
 */
async function scannerScanUnits(opts) {
  const { units, alive, io } = opts;
  const clear = !!opts.clear;
  const on = opts.on || (() => {});
  /** @type {ScannerUnitResult[]} */
  const answered = [];
  let cleared = 0;
  let error = null;
  try {
    for (let i = 0; i < units.length && alive(); i++) {
      const m = units[i];
      on('ask', m, null, i);
      let found;
      try {
        found = await io.identify(m);
      } catch (e) {
        on('failed', m, null, i);
        throw e;
      }
      // stopped while this unit was being asked: its answer is not kept
      if (!alive()) break;
      if (!found) {
        on('silent', m, null, i);
        continue;
      }
      /** @type {ScannerUnitResult} */
      const r = {
        module: m,
        id: found.id,
        raw: found.raw,
        state: 'found',
        errors: null,
        shadow: null,
        trace: clear ? [] : null,
      };
      answered.push(r);
      on('found', m, r, i);
      const how = { kwp: !!found.id.kwp, raw: found.raw };
      const counts = await io.counts(m, how, r.trace);
      r.errors = counts.errors;
      r.shadow = counts.shadow;
      on('counted', m, r, i);
      if (opts.faults && alive() && scannerFaultListWanted(m, counts))
        r.faults = await io.faultList(m, how);
      // the reference clears a unit with stored OR shadow-memory faults
      if (clear && (r.errors || r.shadow) && alive()) {
        on('clearing', m, r, i);
        const out = await io.clearFaults(m, how, r.trace);
        if (out.error) r.trace.push('clear: ' + out.error);
        r.after = out.left;
        if (out.ok) cleared++;
        on('cleared', m, r, i);
      }
      on('done', m, r, i);
    }
  } catch (e) {
    error = e instanceof Error ? e : new Error(String(e));
  }
  return { answered, cleared, error };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { scannerScanUnits, scannerFaultListWanted };
}
