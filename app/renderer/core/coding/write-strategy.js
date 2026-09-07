/**
 * @file The per-ECU-family coding write SEQUENCE, keyed off which jobs the
 * SGBD exposes. Published as the `CodingWriteStrategy` global; the runner
 * that executes a sequence is core/coding/write.js.
 *
 * We cannot run A_*.ipo host-side the way INPA/ISTA do, so when no derived
 * dispatcher is shipped for a module we replicate its job sequence by driving
 * the module's OWN SGBD jobs in the right order over our VM. The sequence
 * DIFFERS per ECU family:
 *
 *   codierdaten   AUTHENTISIERUNG -> NORMALER_DATENVERKEHR "NEIN"
 *                 -> CODIERDATEN_SCHREIBEN <netto-hex>
 *                 -> NORMALER_DATENVERKEHR "JA" -> SG_RESET
 *                 (E46 body/others; netto as ASCII-hex string arg)
 *   codierung     CODIERUNG_SCHREIBEN <netto-hex>   (IHKA46 and kin)
 *   cfg-chunked   C_S_AUFTRAG <binbuf> loop -> C_CHECKSUM <binbuf>
 *                 (ZKE5/GM5; needs BINARY job args)
 */

/**
 * A write strategy name.
 * @typedef {'codierdaten' | 'codierung' | 'cfg-chunked'} WriteStrategy
 */

/**
 * One step of a write plan.
 * @typedef {Object} WritePlanStep
 * @property {string} job - the SGBD job to run.
 * @property {string | {bin: number[]}} arg - a string (hex or literal) or a
 *   binary job argument.
 * @property {boolean} [required] - a step that runs even when the SGBD's job
 *   list does not name it (the write itself).
 */

/**
 * A job list in any of the shapes callers hold: names, a name-keyed object
 * (the shape of code.jobs), or a Set.
 * @typedef {string[] | Set<string> | Record<string, unknown> | null | undefined} JobList
 */

(function (root) {
  'use strict';

  /**
   * Normalise a jobs list to an uppercase Set.
   * @param {JobList} jobs - the job list.
   * @returns {Set<string>} uppercase job names.
   */
  function jobSet(jobs) {
    const s = new Set();
    if (!jobs) return s;
    const add = (n) => {
      if (n) s.add(String(n).toUpperCase());
    };
    if (jobs instanceof Set || Array.isArray(jobs)) {
      for (const n of jobs) add(n);
    } else if (typeof jobs === 'object') {
      for (const n of Object.keys(jobs)) add(n);
    }
    return s;
  }

  /**
   * Uppercase hex of a byte array.
   * @param {ArrayLike<number>} bytes - the bytes.
   * @returns {string} uppercase hex.
   */
  function toHex(bytes) {
    return Array.from(bytes, (b) => (b & 0xff).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  }

  // Order matters: a module that has BOTH a chunked cfg path and a plain
  // CODIERDATEN one is written the cfg way (that is the family's real
  // dispatcher).
  /**
   * Pick the write strategy from which jobs the SGBD exposes.
   * @param {string} sgbd - the module (for symmetry with the runner; unused).
   * @param {JobList} jobs - the SGBD's job list.
   * @returns {WriteStrategy|null} the strategy, or null when the SGBD exposes
   *   no write path we know.
   */
  function codingWriteStrategy(sgbd, jobs) {
    const j = jobSet(jobs);
    if (j.has('C_S_AUFTRAG')) return 'cfg-chunked';
    if (j.has('CODIERDATEN_SCHREIBEN')) return 'codierdaten';
    if (j.has('CODIERUNG_SCHREIBEN')) return 'codierung';
    return null;
  }

  // cfg-chunked and codierdaten both read via CODIERDATEN_LESEN when present;
  // codierung reads via CODIERUNG_LESEN. When the read job is absent the
  // runner skips the before-read but STILL proves by re-read after the write,
  // comparing to what we asked to write.
  /**
   * Which job reads the current netto back, per strategy.
   * @param {WriteStrategy} strategy - the strategy.
   * @param {JobList} jobs - the SGBD's job list.
   * @returns {string|null} the read job, or null when the SGBD has none.
   */
  function readJobFor(strategy, jobs) {
    const j = jobSet(jobs);
    if (strategy === 'codierung') {
      return j.has('CODIERUNG_LESEN') ? 'CODIERUNG_LESEN' : null;
    }
    return j.has('CODIERDATEN_LESEN')
      ? 'CODIERDATEN_LESEN'
      : j.has('CODIERUNG_LESEN')
        ? 'CODIERUNG_LESEN'
        : null;
  }

  // Steps whose job the SGBD lacks are dropped (SG_RESET /
  // NORMALER_DATENVERKEHR are optional on many modules); a `required` step
  // (the write itself) always stays.
  /**
   * The ordered write steps for a strategy, with the netto substituted in.
   * @param {WriteStrategy} strategy - the strategy.
   * @param {number[]} nettoBytes - the FULL netto to write.
   * @param {JobList} jobs - the SGBD's job list.
   * @returns {WritePlanStep[]|null} the runnable steps, or null for an
   *   unknown strategy.
   */
  function writeSteps(strategy, nettoBytes, jobs) {
    const j = jobSet(jobs);
    const hex = toHex(nettoBytes);
    /** @type {WritePlanStep[]} */
    let steps;
    if (strategy === 'codierdaten') {
      steps = [
        { job: 'AUTHENTISIERUNG', arg: '' },
        { job: 'NORMALER_DATENVERKEHR', arg: 'NEIN' },
        { job: 'CODIERDATEN_SCHREIBEN', arg: hex, required: true },
        { job: 'NORMALER_DATENVERKEHR', arg: 'JA' },
        { job: 'SG_RESET', arg: '' },
      ];
    } else if (strategy === 'codierung') {
      steps = [{ job: 'CODIERUNG_SCHREIBEN', arg: hex, required: true }];
    } else if (strategy === 'cfg-chunked') {
      // The SGBD's C_S_AUFTRAG takes the whole netto as a binary buffer and
      // writes it into the coding region itself (it walks its own slot table
      // internally, exactly as CDHGetApiJobData/CDHapiJobData feed it). We
      // hand it the whole blob once; C_CHECKSUM then validates the region.
      steps = [
        {
          job: 'C_S_AUFTRAG',
          arg: { bin: nettoBytes.slice() },
          required: true,
        },
        { job: 'C_CHECKSUM', arg: { bin: nettoBytes.slice() } },
      ];
    } else {
      return null;
    }
    return steps.filter(
      (s) => s.required || j.has(String(s.job).toUpperCase())
    );
  }

  const api = { jobSet, toHex, codingWriteStrategy, readJobFor, writeSteps };
  if (typeof root !== 'undefined') root.CodingWriteStrategy = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
