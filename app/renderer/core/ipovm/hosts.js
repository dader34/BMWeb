/**
 * @file Where the script's questions about the car get answered. The VM asks
 * its host for job results, JOB_STATUS and the input-dialog state; the
 * offline host answers with placeholders, the fed host serves what the wire
 * returned. The VM does not know the difference.
 */

/**
 * What a job's answer looks like when fed to the VM: the flat union of every
 * result set's keys, plus -- optionally -- the sets themselves, numbered as
 * EDIABAS numbers them (0 = the system record, 1..n = what the job produced).
 * @typedef {Map<string, string> & {sets?: Array<Record<string, string>>}} IpoFeed
 */

/**
 * The host interface the VM calls.
 * @typedef {object} IpoHost
 * @property {(sgbd: string|null, job: string|null, arg: string|null, results: null) => object} job -
 *   run a job (offline hosts return nothing; the driven VM suspends instead)
 * @property {(key: string, opts?: {integer?: boolean, set?: number, default?: *}) => (string|number)} result -
 *   INPAapiResult*: the value of a result key, numeric when asked as integer
 * @property {() => string} status - INPAapiCheckJobStatus: the last job's JOB_STATUS
 * @property {() => number} inputstate - getinputstate's placeholder
 * @property {(m: IpoFeed|object) => void} [feed] - accept a job's results (FeedHost)
 * @property {() => number} [count] - INPAapiResultSets: how many sets the job produced
 */

/**
 * The OFFLINE host (mirrors ipo_vm.py's Host): jobs return nothing, reads read
 * empty except the two invariants -- JOB_STATUS is OKAY, an integer read is 1
 * (one of every list) -- which is enough to walk the tree and draw the
 * maximal structure.
 * @implements {IpoHost}
 */
class OkHost {
  /**
   * A job run offline produces nothing.
   * @param {string|null} _sgbd - SGBD the script addressed
   * @param {string|null} _job - job name
   * @param {string|null} _arg - job argument
   * @param {null} _results - unused
   * @returns {object}
   */
  job(_sgbd, _job, _arg, _results) {
    return {};
  }

  /**
   * A placeholder read: JOB_STATUS, 1 for an integer, else the default or ''.
   * @param {string} key - result key
   * @param {{integer?: boolean, set?: number, default?: *}} [opts] - read options
   * @returns {string|number}
   */
  result(key, opts = {}) {
    if (key === 'JOB_STATUS') return this.status();
    if (opts.integer) return 1;
    return opts.default != null ? opts.default : '';
  }

  /**
   * Offline every job succeeds.
   * @returns {string}
   */
  status() {
    return 'OKAY';
  }

  /**
   * Offline every input is confirmed (the guard tests `== 0`).
   * @returns {number}
   */
  inputstate() {
    return 0;
  }
}

/**
 * A host the driver FEEDS: resume(resultsMap) lands here, and the machine's
 * INPAapiResult* reads serve from the most recent job's results -- including
 * JOB_STATUS, so INPAapiCheckJobStatus sees the wire's own verdict.
 * @implements {IpoHost}
 */
class FeedHost {
  constructor() {
    /** @type {Map<string, string>} the flat union of the last job's keys */
    this.map = new Map();
    /**
     * EDIABAS numbers a job's result sets 0..n: set 0 is the system record
     * (OBJECT, VARIANTE, JOBNAME, SAETZE), sets 1..n are what the job
     * produced -- one per fault for FS_LESEN, the last one carrying
     * JOB_STATUS. A feed may carry that array as `sets`; the flat map is the
     * union of every set and answers a read that names no set.
     * @type {Array<Record<string, string>>|null}
     */
    this.sets = null;
  }

  /**
   * Take a job's results as the current answer.
   * @param {IpoFeed|object} m - a Map (with an optional `sets` array) or a plain object
   * @returns {void}
   */
  feed(m) {
    this.map = m instanceof Map ? m : new Map(Object.entries(m || {}));
    this.sets = m && Array.isArray(m.sets) ? m.sets : null;
  }

  /**
   * The driven VM never runs a job through the host: it suspends and the
   * driver feeds the answer back.
   * @param {string|null} _sgbd - SGBD the script addressed
   * @param {string|null} _job - job name
   * @param {string|null} _arg - job argument
   * @param {null} _results - unused
   * @returns {object}
   */
  job(_sgbd, _job, _arg, _results) {
    return {};
  }

  /**
   * INPAapiResultSets: how many sets the job produced (n, without set 0).
   * @returns {number}
   */
  count() {
    return this.sets ? Math.max(0, this.sets.length - 1) : 1;
  }

  /**
   * A read served from the numbered set when one is named and carried, else
   * from the flat map. JOB_STATUS is asked of the last set; the wire's
   * verdict answers wherever the shim put it.
   * @param {string} key - result key
   * @param {{integer?: boolean, set?: number, default?: *}} [opts] - read options
   * @returns {string|number}
   */
  /**
   * The value behind a key as the wire delivered it (a binary result is
   * bytes, not text): from the numbered set when one is named, else the
   * flat map.
   * @param {string} key - the result name
   * @param {{set?: number}} [opts]
   * @returns {*}
   */
  raw(key, opts = {}) {
    const si = opts.set;
    if (this.sets && si != null && si >= 0 && si < this.sets.length) {
      const s = this.sets[si] || {};
      return Object.prototype.hasOwnProperty.call(s, key) ? s[key] : undefined;
    }
    return this.map.get(key);
  }

  result(key, opts = {}) {
    let v;
    const si = opts.set;
    if (this.sets && si != null && si >= 0 && si < this.sets.length) {
      const s = this.sets[si] || {};
      v = Object.prototype.hasOwnProperty.call(s, key) ? s[key] : undefined;
      if (v == null && key === 'JOB_STATUS') return this.status();
    } else {
      if (key === 'JOB_STATUS') return this.status();
      v = this.map.get(key);
    }
    if (v == null) {
      return opts.integer ? 0 : opts.default != null ? opts.default : '';
    }
    return opts.integer ? parseInt(v, 10) || 0 : String(v);
  }

  /**
   * The fed JOB_STATUS, OKAY when the feed carried none.
   * @returns {string}
   */
  status() {
    const st = this.map.get('JOB_STATUS');
    return st != null ? String(st) : 'OKAY';
  }

  /**
   * getinputstate's placeholder when nothing was driven.
   * @returns {number}
   */
  inputstate() {
    return 0;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { OkHost, FeedHost };
}
