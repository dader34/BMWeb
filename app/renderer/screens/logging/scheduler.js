/**
 * @file Data logging: the poll loop -- who gets asked what, in which order,
 * and what stops it.
 *
 * Second piece of screens/logging/ (see store.js for the folder map).
 *
 * WHY THE ORDER IS BY MODULE, NOT BY JOB. The shim holds ONE EDIABAS session
 * open at a time; switchSession (core/webshim/job-runner.js) sees a different
 * SGBD, runs the outgoing module's ENDE, drops the wire state, and the next
 * job pays a fresh INITIALISIERUNG before it can transmit. On a K-line car
 * that pair is the most expensive thing on the bus -- far dearer than the
 * reads themselves. A naive round-robin over (module, job) pairs alternating
 * A,B,A,B pays it on EVERY step and collapses the sample rate to a fraction
 * of what one module alone would manage.
 *
 * So the loop is grouped: every selected job of one module runs back to back
 * inside that module's session, and only then does the next module get the
 * bus. One switch per module per round instead of one per job. The cost is
 * that a module's samples arrive in bursts separated by the other modules'
 * turns -- which is why the charts share a time axis and the CSV never
 * carries a value forward: the gaps are real and are shown as gaps.
 */

/* exported LOG_MIN_GAP_MS, LogScheduler */

/**
 * The pause between jobs, so a logging run cannot monopolise the bus and
 * starve the status poll that watches for the cable going away.
 * @type {number}
 */
const LOG_MIN_GAP_MS = 10;

/**
 * The round-robin poller.
 *
 * Owns no UI. It takes a selection, writes samples into a {@link LogStore},
 * and calls back when something changed; the screen decides what to draw.
 */
class LogScheduler {
  /**
   * @param {object} opts - Wiring.
   * @param {Array<{sgbd: string, label: string, group?: string|null, job: string, keys: string[]}>} opts.targets -
   *   The selection: one entry per (module, job), each naming the result keys wanted.
   * @param {LogStore} opts.store - Where samples land.
   * @param {(state: {running: boolean, error?: string}) => void} [opts.onState] - Told when the loop starts, stops or fails.
   * @param {() => void} [opts.onSample] - Told after each answer is ingested.
   * @param {number} [opts.gapMs=LOG_MIN_GAP_MS] - Pause between jobs.
   */
  constructor({ targets, store, onState, onSample, gapMs = LOG_MIN_GAP_MS }) {
    /** @type {Array<{sgbd: string, label: string, group?: string|null, job: string, keys: string[]}>} */
    this.targets = targets || [];
    /** @type {LogStore} */
    this.store = store;
    /** @type {(state: {running: boolean, error?: string}) => void} */
    this.onState = onState || (() => {});
    /** @type {() => void} */
    this.onSample = onSample || (() => {});
    /** @type {number} */
    this.gapMs = gapMs;
    /** @type {boolean} Whether the loop should keep going. */
    this.running = false;
    /**
     * Bumped on every stop. An in-flight job resolves after the user has
     * left, and its `token !== this.token` tells it the answer is stale --
     * the same guard stopLive uses, and the reason a late answer cannot
     * write into a cleared store.
     * @type {number}
     */
    this.token = 0;
    /** @type {Promise<void>|null} The running loop, so stop() can await it. */
    this._loop = null;
    /** @type {string[]} Job names that errored, so they are not retried forever. */
    this.dead = [];
  }

  /**
   * The selection grouped by module, preserving the order the user picked.
   * @returns {Array<{sgbd: string, label: string, group?: string|null, jobs: Array<{job: string, keys: string[]}>}>}
   */
  plan() {
    const byModule = new Map();
    for (const t of this.targets) {
      const k = String(t.sgbd).toLowerCase();
      if (!byModule.has(k)) {
        byModule.set(k, {
          sgbd: t.sgbd,
          label: t.label || t.sgbd,
          group: t.group || null,
          jobs: [],
        });
      }
      byModule.get(k).jobs.push({ job: t.job, keys: t.keys || [] });
    }
    return [...byModule.values()];
  }

  /**
   * Start polling. Does nothing when already running or nothing is selected.
   * @returns {void}
   */
  start() {
    if (this.running || !this.targets.length) return;
    this.running = true;
    this.dead = [];
    this.onState({ running: true });
    this._loop = this._run(this.token);
  }

  /**
   * Stop polling and wait for the job in flight to settle.
   *
   * Awaiting matters: the bus is a single shared resource, and returning
   * before the outstanding exchange finishes would let the next screen's job
   * interleave with this one's on the wire.
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this.running) return;
    this.running = false;
    this.token++;
    const loop = this._loop;
    this._loop = null;
    this.onState({ running: false });
    if (loop) await loop.catch(() => {});
  }

  /**
   * The loop: rounds of (each module in turn, each of its jobs back to back).
   * @param {number} token - The token this run was started with.
   * @returns {Promise<void>}
   */
  async _run(token) {
    const plan = this.plan();
    while (this.running && token === this.token) {
      for (const mod of plan) {
        if (!this.running || token !== this.token) return;
        let ran = 0;
        // every job of THIS module before any other module gets the bus:
        // one ENDE + INITIALISIERUNG per module per round, not per job
        for (const j of mod.jobs) {
          if (!this.running || token !== this.token) return;
          if (this.dead.includes(`${mod.sgbd}/${j.job}`)) continue;
          const okRun = await this._one(mod, j, token);
          if (okRun) ran++;
          await bmwSleep(this.gapMs);
        }
        if (ran) this.store.countRound(mod.sgbd);
      }
      // every job of every module is dead: nothing left to poll, so stop
      // rather than spin an empty loop on the bus forever
      if (this.dead.length >= this.targets.length) {
        this.running = false;
        this.onState({
          running: false,
          error: 'No selected job returned data. Logging stopped.',
        });
        return;
      }
    }
  }

  /**
   * Run one job and ingest its answer.
   * @param {{sgbd: string, group?: string|null}} mod - The module.
   * @param {{job: string, keys: string[]}} j - The job and the keys wanted.
   * @param {number} token - The run's token.
   * @returns {Promise<boolean>} True when an answer was ingested.
   */
  async _one(mod, j, token) {
    try {
      const q = mod.group ? `?group=${encodeURIComponent(mod.group)}` : '';
      const data = await api(
        `/api/ecu/${String(mod.sgbd).toLowerCase()}/run/${encodeURIComponent(j.job)}${q}`,
        { method: 'POST' }
      );
      if (!this.running || token !== this.token) return false; // stale answer
      // one job can answer in several sets (a block read); merge them, later
      // sets winning, so a key present in only one set is still logged
      const row = {};
      for (const set of dataSets(data && data.sets)) Object.assign(row, set);
      const n = this.store.ingest(mod.sgbd, j.job, row, j.keys);
      if (n) this.onSample();
      return true;
    } catch (e) {
      if (!this.running || token !== this.token) return false;
      // A job that fails on the wire fails the same way every round (the ECU
      // does not know it, or the session cannot be built). Retrying it every
      // round would spend the whole sample budget on a known-bad read, so it
      // is dropped from the rotation and the others keep logging.
      this.dead.push(`${mod.sgbd}/${j.job}`);
      return false;
    }
  }
}

// node loads these pieces as modules; the browser gives them one shared scope
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LOG_MIN_GAP_MS, LogScheduler };
}
