/**
 * @file Wire and API-layer tracing: the in-browser ifh.trc and api.trc.
 *
 * Off by default (zero cost: every call site is behind `busTrace.on`). Turn it
 * on from the console with `busTrace.start()`, run the failing action, then
 * `busTrace.dump()` to print what actually went over the wire. This exists
 * because a transport bug is invisible from the error text alone -- IFH-0003
 * says "the echo was wrong" without ever showing you the echo.
 */
/* exported busTrace, apiTrace */

/** Rows kept while verbose tracing is on (busTrace.start's default). */
const BUS_TRACE_LIMIT = 400;
/** Rows kept in the always-on ring buffer of recent wire activity. */
const BUS_TRACE_RECENT_LIMIT = 60;
/** Job rows kept by the API-layer trace. */
const API_TRACE_LIMIT = 500;

/**
 * One wire event.
 * @typedef {object} BusTraceRow
 * @property {number} t - Date.now() when it was recorded.
 * @property {string} tag - 'tx', 'rx', 'err' or 'kline'.
 * @property {string} hex - The bytes as upper-case hex pairs ('' when none).
 * @property {number} n - Byte count.
 * @property {string|undefined} note - Free text (timeouts, DTR holds, errors).
 */

/**
 * The wire trace (EDIABAS's ifh.trc equivalent): every telegram sent and
 * received, plus K-line control events, with a small always-on ring buffer so
 * an IFH error can print the telegrams that led to it without anyone having
 * run busTrace.start() first.
 */
const busTrace = {
  on: false,
  /** @type {BusTraceRow[]} */
  rows: [],
  limit: BUS_TRACE_LIMIT,
  // A small ALWAYS-ON ring buffer of the most recent wire activity, kept even
  // when verbose tracing is off (it is cheap -- a handful of {tag,hex,note}
  // objects). When an IFH error surfaces to the user, dumpRecent() prints this
  // so the failing telegrams are on the console without anyone having to have
  // run busTrace.start() first.
  /** @type {BusTraceRow[]} */
  recent: [],
  recentLimit: BUS_TRACE_RECENT_LIMIT,
  /**
   * Start verbose tracing, clearing the previous rows.
   * @param {number} [limit] - Override the row cap for this run.
   * @returns {string} A console-friendly acknowledgement.
   */
  start(limit) {
    this.on = true;
    this.rows = [];
    if (limit) this.limit = limit;
    console.log(
      '[bus] tracing ON — reproduce the failure, then busTrace.dump()'
    );
    return 'tracing';
  },
  /**
   * Stop verbose tracing; the rows stay for dump().
   * @returns {string} A console-friendly acknowledgement.
   */
  stop() {
    this.on = false;
    return `tracing OFF (${this.rows.length} rows kept)`;
  },
  /**
   * Record one wire event into the ring buffer and, while tracing, the rows.
   * @param {string} tag - 'tx', 'rx', 'err' or 'kline'.
   * @param {ArrayLike<number>|null} bytes - The telegram, or null for an event.
   * @param {string} [note] - What happened (timeout, DTR hold, error text).
   */
  add(tag, bytes, note) {
    const row = {
      t: Date.now(),
      tag,
      hex: busTrace.hex(bytes),
      n: bytes ? bytes.length : 0,
      note,
    };
    // ring buffer: always on, bounded, drops the oldest
    this.recent.push(row);
    if (this.recent.length > this.recentLimit) this.recent.shift();
    // verbose buffer: only while explicitly tracing
    if (!this.on) return;
    if (this.rows.length >= this.limit) return;
    this.rows.push(row);
  },
  /**
   * Print the recent ring buffer -- called automatically when an IFH error
   * reaches the UI, or by hand. Labelled so it is obvious it is the auto-dump.
   * @param {string} [why] - The error the dump precedes, for the group label.
   */
  dumpRecent(why) {
    if (!this.recent.length) return;
    const t0 = this.recent[0].t;
    console.groupCollapsed(
      `[bus] wire trace before ${why || 'error'} ` +
        `(${this.recent.length} rows) — expand for telegrams`
    );
    console.table(busTrace.tableRows(this.recent, t0));
    console.groupEnd();
  },
  /**
   * Format bytes as upper-case hex pairs.
   * @param {ArrayLike<number>|null|undefined} b - The bytes.
   * @returns {string} 'AA BB CC', or '' for nothing.
   */
  hex(b) {
    if (!b) return '';
    return Array.from(b, (x) =>
      (x & 0xff).toString(16).padStart(2, '0').toUpperCase()
    ).join(' ');
  },
  /**
   * Shape rows for console.table, with times relative to the first row.
   * @param {BusTraceRow[]} rows - The rows to print.
   * @param {number} t0 - The timestamp the `ms` column counts from.
   * @returns {Array<{ms: number, what: string, len: number, bytes: string, note: string}>}
   */
  tableRows(rows, t0) {
    return rows.map((r) => ({
      ms: r.t - t0,
      what: r.tag,
      len: r.n,
      bytes: r.hex,
      note: r.note || '',
    }));
  },
  /**
   * Print the verbose rows collected since start().
   * @returns {string|undefined} A row count, or nothing when there is no trace.
   */
  dump() {
    if (!this.rows.length) {
      console.log('[bus] nothing traced — busTrace.start() first');
      return;
    }
    const t0 = this.rows[0].t;
    console.table(busTrace.tableRows(this.rows, t0));
    return `${this.rows.length} rows`;
  },
};
if (typeof window !== 'undefined') window.busTrace = busTrace;

/**
 * One job run as the API layer saw it.
 * @typedef {object} ApiTraceEntry
 * @property {number} t - Date.now() when the job finished.
 * @property {string} sgbd - The SGBD the job ran on.
 * @property {string} job - The job name.
 * @property {string|null} arg - Its argument string.
 * @property {object[]} [sets] - The result sets on success.
 * @property {string} [status] - JOB_STATUS of the first set.
 * @property {string} [error] - The error message on failure.
 */

/**
 * The API-LAYER trace: EDIABAS's api.trc equivalent. busTrace is ifh.trc (the
 * raw telegrams); this is the layer above -- one row per job run, with its
 * arguments, its result sets and the JOB_STATUS. Tool32's Trace window shows
 * both layers; the wire tells you WHAT went over the bus, the API layer tells
 * you what the JOB did with it. Recording is gated on `on` (Tool32's trace
 * toggle sets it), matching how EDIABAS only writes the trace when the level
 * is non-zero.
 */
const apiTrace = {
  on: false,
  /** @type {ApiTraceEntry[]} */
  rows: [],
  limit: API_TRACE_LIMIT,
  /**
   * Start recording job runs.
   * @returns {string} A console-friendly acknowledgement.
   */
  start() {
    this.on = true;
    return 'api trace ON';
  },
  /**
   * Stop recording; the rows stay.
   * @returns {string} A console-friendly acknowledgement.
   */
  stop() {
    this.on = false;
    return 'api trace OFF';
  },
  /** Drop every recorded row. */
  clear() {
    this.rows = [];
  },
  /**
   * Record one job: {sgbd, job, arg, sets, status, error}; the time is added.
   * @param {Omit<ApiTraceEntry, 't'>} entry - The job's outcome.
   */
  add(entry) {
    if (!this.on) return;
    if (this.rows.length >= this.limit) return;
    this.rows.push({ t: Date.now(), ...entry });
  },
};
if (typeof window !== 'undefined') window.apiTrace = apiTrace;
