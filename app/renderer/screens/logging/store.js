/**
 * @file Data logging: the sample store -- what a polled job's answer becomes
 * once it is a number on a time axis.
 *
 * First piece of screens/logging/. The rest of the folder reads these names:
 *   store.js      this file -- ring buffers, numeric parsing, units, CSV
 *   scheduler.js  the round-robin poll loop over the selected (module, job)s
 *   charts.js     the canvas grid and the shared time cursor
 *   picker.js     chassis -> modules -> jobs -> result keys
 *   screen.js     the screen itself: controls, presets, the route
 *
 * A logged series is (timestamp, number). EDIABAS hands back strings, and a
 * good half of a job's registers are never numbers at all (status words, hex
 * telegrams, unit names). Parsing is therefore allowed to fail, and a key
 * whose value does not parse is simply not plotted -- dropping the sample is
 * right, because a chart of "OKAY" has no meaning and a zero substituted for
 * it would be a lie about the car.
 */

/* exported LOG_CAP_MS, logSeriesKey, logParseNumber, logUnitFor, LogRing,
   LogStore, logCsv */

/**
 * How much history a series keeps: 20 minutes. The cap is by TIME, not by
 * sample count, because the sample rate is whatever the wire managed -- a
 * count-based cap would hold ten minutes of one module and forty seconds of
 * another, and the charts share one time axis.
 * @type {number}
 */
const LOG_CAP_MS = 20 * 60 * 1000;

/**
 * The stable id of one logged series.
 *
 * Two modules can both declare STAT_SPANNUNG, and the same job can be
 * selected on two modules at once, so neither the key nor job+key is unique.
 * The SGBD is lower-cased because that is how every other route spells it.
 * @param {string} sgbd - The module's SGBD.
 * @param {string} job - The job name.
 * @param {string} key - The result register.
 * @returns {string} e.g. "ms450ds0/STATUS_MOTORTEMPERATUR/STAT_MOTORTEMPERATUR_WERT".
 */
function logSeriesKey(sgbd, job, key) {
  return `${String(sgbd).toLowerCase()}/${job}/${key}`;
}

/**
 * Read a number out of an EDIABAS result value.
 *
 * Values arrive as strings and carry their unit inline as often as not
 * ("13.8 V", "-40.0 °C", "1,013 mbar"). Accepts a leading sign, a decimal
 * comma (German SGBDs write one) and an exponent, and refuses anything that
 * is not a number at the front -- so "OKAY", "aktiv" and a hex telegram all
 * come back null and are dropped by the caller rather than logged as 0.
 *
 * A bare thousands separator is NOT handled: "1,013" is read as 1.013,
 * because a decimal comma is overwhelmingly the commoner meaning in these
 * registers and guessing the other way would silently scale a reading by
 * 1000.
 * @param {*} v - The raw result value.
 * @returns {number|null} The number, or null when the value is not numeric.
 */
function logParseNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  // hex telegrams are numeric-looking but are payload, never a measurement
  if (/^0x/i.test(s)) return null;
  const m = /^[+-]?(\d+([.,]\d+)?|[.,]\d+)([eE][+-]?\d+)?/.exec(s);
  if (!m) return null;
  const n = Number(m[0].replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * The unit for a result key, from the answer that carried it.
 *
 * BMW's SGBDs pair a value register with a unit register by name:
 * STAT_MOTORTEMPERATUR_WERT is measured in whatever STAT_MOTORTEMPERATUR_EINH
 * says ("°C"). The unit is therefore a RUNTIME value, not something the
 * shipped result schema knows -- the schema only lists the register names and
 * a German comment, and the decoded `unit` field that does exist offline in
 * data/chassis/<CH>/<ECU>/specs.json is not packed into the .ecu archives the
 * API serves. So the unit is read off the same answer the value came from,
 * and only falls back to a unit written inline in the value itself.
 *
 * normUnit (screens/measurements.js) does the spelling: the ECUs write
 * "Grad C" and "kgperh" where a chart wants "°C" and "kg/h".
 * @param {string} key - The value register's name.
 * @param {Object<string, *>} row - The flattened answer the value came from.
 * @returns {string} The unit, or '' when the answer named none.
 */
function logUnitFor(key, row) {
  const tidy = (u) =>
    typeof normUnit === 'function'
      ? String(normUnit(u) || '').trim()
      : String(u).trim();
  const paired = String(key).replace(/_WERT$/, '_EINH');
  if (paired !== key && row && row[paired] != null) {
    const u = tidy(String(row[paired]).trim());
    // a blank or placeholder _EINH means the ECU declined to name a unit
    if (u && !/^(kein|none|-|--|0-n)$/i.test(u)) return u;
  }
  // no paired register: a unit written after the number in the value itself
  const raw = row && row[key] != null ? String(row[key]).trim() : '';
  const tail = /^[+-]?[\d.,]+(?:[eE][+-]?\d+)?\s*(.+)$/.exec(raw);
  if (tail) {
    const u = tail[1].trim();
    // a trailing word is a unit only if it is short and not prose
    if (u && u.length <= 8 && !/\s/.test(u)) return u;
  }
  return '';
}

/**
 * One series' rolling history: timestamps and values in two parallel arrays,
 * trimmed to {@link LOG_CAP_MS}.
 *
 * Parallel arrays rather than an array of points: the chart walks the whole
 * window every frame, and per-point objects made that walk allocate for
 * nothing.
 */
class LogRing {
  /**
   * @param {number} [capMs=LOG_CAP_MS] - How much history to keep, in ms.
   */
  constructor(capMs = LOG_CAP_MS) {
    /** @type {number[]} Sample times, ms since epoch, ascending. */
    this.t = [];
    /** @type {number[]} Sample values, parallel to {@link t}. */
    this.v = [];
    /** @type {number} The history window in ms. */
    this.capMs = capMs;
    /** @type {string} The unit last seen for this series. */
    this.unit = '';
  }

  /**
   * Append one sample and drop whatever fell out of the window.
   * @param {number} t - Sample time, ms since epoch.
   * @param {number} v - The value.
   * @returns {void}
   */
  push(t, v) {
    this.t.push(t);
    this.v.push(v);
    this.trim(t);
  }

  /**
   * Drop samples older than the cap, measured back from `now`.
   * Splice once rather than shift per sample: at a few hundred samples a
   * second the shift loop is the whole frame budget.
   * @param {number} now - The current time, ms since epoch.
   * @returns {void}
   */
  trim(now) {
    const floor = now - this.capMs;
    let drop = 0;
    while (drop < this.t.length && this.t[drop] < floor) drop++;
    if (drop) {
      this.t.splice(0, drop);
      this.v.splice(0, drop);
    }
  }

  /** @returns {number} How many samples are held. */
  get length() {
    return this.t.length;
  }

  /** @returns {number|null} The newest value, or null when empty. */
  last() {
    return this.t.length ? this.v[this.v.length - 1] : null;
  }

  /**
   * The min, max and newest value within a time window.
   * @param {number} from - Window start, ms since epoch.
   * @param {number} to - Window end, ms since epoch.
   * @returns {{min: number, max: number, last: number, n: number}|null} null when the window holds nothing.
   */
  stats(from, to) {
    let min = Infinity;
    let max = -Infinity;
    let last = 0;
    let n = 0;
    for (let i = 0; i < this.t.length; i++) {
      const ts = this.t[i];
      if (ts < from || ts > to) continue;
      const val = this.v[i];
      if (val < min) min = val;
      if (val > max) max = val;
      last = val;
      n++;
    }
    return n ? { min, max, last, n } : null;
  }

  /**
   * The value at (or last before) an instant -- what the shared cursor shows.
   * @param {number} t - The instant, ms since epoch.
   * @param {number} [tolMs=2000] - How far back a sample may be and still count.
   * @returns {number|null} The value, or null when nothing is near enough.
   */
  at(t, tolMs = 2000) {
    // walk back from the end: the cursor is normally near the newest samples
    for (let i = this.t.length - 1; i >= 0; i--) {
      if (this.t[i] <= t) return t - this.t[i] <= tolMs ? this.v[i] : null;
    }
    return null;
  }

  /**
   * Forget every sample, keeping the unit.
   * @returns {void}
   */
  clear() {
    this.t.length = 0;
    this.v.length = 0;
  }
}

/**
 * Every series being logged, plus the per-module sample-rate tally.
 *
 * The store is the one thing the scheduler writes and the charts read, so
 * the poll loop and the render loop share no other state.
 */
class LogStore {
  /**
   * @param {number} [capMs=LOG_CAP_MS] - History window for every series.
   */
  constructor(capMs = LOG_CAP_MS) {
    /** @type {Map<string, LogRing>} Series id -> its history. */
    this.series = new Map();
    /** @type {Map<string, {sgbd: string, job: string, key: string, label: string}>} Series id -> what it is. */
    this.meta = new Map();
    /** @type {Map<string, {n: number, first: number, last: number}>} SGBD -> its round tally. */
    this.rounds = new Map();
    /** @type {number} History window in ms. */
    this.capMs = capMs;
    /** @type {number} Bumped on every accepted sample, so the chart redraws only on new data. */
    this.revision = 0;
  }

  /**
   * Declare a series before any sample arrives, so its chart exists (empty)
   * from the moment the user starts rather than popping in on first answer.
   * @param {string} sgbd - The module.
   * @param {string} job - The job.
   * @param {string} key - The result register.
   * @param {string} [label] - Display label; defaults to the key.
   * @returns {string} The series id.
   */
  declare(sgbd, job, key, label) {
    const id = logSeriesKey(sgbd, job, key);
    if (!this.series.has(id)) this.series.set(id, new LogRing(this.capMs));
    this.meta.set(id, {
      sgbd: String(sgbd).toLowerCase(),
      job,
      key,
      label: label || key,
    });
    return id;
  }

  /**
   * Record one job answer: every declared key in it that parses as a number
   * becomes a sample, and its unit is refreshed from the same answer.
   * @param {string} sgbd - The module the answer came from.
   * @param {string} job - The job that produced it.
   * @param {Object<string, *>} row - The flattened answer (key -> value).
   * @param {string[]} keys - The result registers the user selected.
   * @param {number} [now=Date.now()] - Sample time.
   * @returns {number} How many samples were accepted.
   */
  ingest(sgbd, job, row, keys, now = Date.now()) {
    let taken = 0;
    for (const key of keys) {
      const n = logParseNumber(row ? row[key] : null);
      if (n == null) continue; // not a number: this key is not plottable
      const id = this.declare(sgbd, job, key);
      const ring = this.series.get(id);
      const unit = logUnitFor(key, row);
      if (unit) ring.unit = unit;
      ring.push(now, n);
      taken++;
    }
    if (taken) this.revision++;
    return taken;
  }

  /**
   * Count one completed pass over a module's jobs, for the achieved-rate
   * readout.
   * @param {string} sgbd - The module.
   * @param {number} [now=Date.now()] - When the round finished.
   * @returns {void}
   */
  countRound(sgbd, now = Date.now()) {
    const k = String(sgbd).toLowerCase();
    const r = this.rounds.get(k);
    if (!r) this.rounds.set(k, { n: 1, first: now, last: now });
    else {
      r.n++;
      r.last = now;
    }
  }

  /**
   * The achieved sample rate for a module: rounds per second since its first
   * round. Reported from the second round on -- one round has no interval to
   * divide by, and a made-up rate from a single sample is worse than none.
   * @param {string} sgbd - The module.
   * @returns {number|null} Rounds per second, or null when not yet known.
   */
  rateFor(sgbd) {
    const r = this.rounds.get(String(sgbd).toLowerCase());
    if (!r || r.n < 2) return null;
    const span = r.last - r.first;
    return span > 0 ? (r.n - 1) / (span / 1000) : null;
  }

  /**
   * The series that hold at least one sample, in declaration order.
   * @returns {Array<{id: string, ring: LogRing, meta: {sgbd: string, job: string, key: string, label: string}}>}
   */
  active() {
    const out = [];
    for (const [id, ring] of this.series) {
      if (ring.length) out.push({ id, ring, meta: this.meta.get(id) });
    }
    return out;
  }

  /**
   * The span every series covers together.
   * @returns {{from: number, to: number}|null} null when nothing is logged.
   */
  span() {
    let from = Infinity;
    let to = -Infinity;
    for (const ring of this.series.values()) {
      if (!ring.length) continue;
      if (ring.t[0] < from) from = ring.t[0];
      if (ring.t[ring.t.length - 1] > to) to = ring.t[ring.t.length - 1];
    }
    return to >= from ? { from, to } : null;
  }

  /**
   * Drop every sample and every rate tally, keeping the selection.
   * @returns {void}
   */
  clear() {
    for (const ring of this.series.values()) ring.clear();
    this.rounds.clear();
    this.revision++;
  }
}

/**
 * The buffer as CSV: one row per timestamp, one column per series.
 *
 * The modules are polled in turn, so two series almost never share an exact
 * timestamp -- a naive join on equal times would produce one row per sample
 * with a single filled cell and a sea of blanks. Rows are therefore the union
 * of every sample time, and a cell is filled only by a sample AT that time.
 * That keeps the file honest: a blank means "this key was not read at that
 * instant", which is the truth about a round-robin log, rather than a value
 * carried forward that the car never reported.
 *
 * Time is written twice: ISO for a human, and seconds from the first sample
 * for a plot.
 * @param {LogStore} store - The store to dump.
 * @returns {string} CSV text with CRLF endings, or '' when nothing is logged.
 */
function logCsv(store) {
  const cols = store.active();
  if (!cols.length) return '';
  const times = new Set();
  cols.forEach((c) => c.ring.t.forEach((t) => times.add(t)));
  const rows = [...times].sort((a, b) => a - b);
  const t0 = rows[0];
  // per column, a time -> value map, so the row build is a lookup not a scan
  const byTime = cols.map((c) => {
    const m = new Map();
    for (let i = 0; i < c.ring.t.length; i++) m.set(c.ring.t[i], c.ring.v[i]);
    return m;
  });
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const head = ['time', 'seconds'].concat(
    cols.map((c) =>
      q(`${c.meta.sgbd} ${c.meta.key}${c.ring.unit ? ` [${c.ring.unit}]` : ''}`)
    )
  );
  const lines = [head.join(',')];
  for (const t of rows) {
    const cells = [
      new Date(t).toISOString(),
      ((t - t0) / 1000).toFixed(3),
    ].concat(byTime.map((m) => (m.has(t) ? String(m.get(t)) : '')));
    lines.push(cells.join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

// node loads these pieces as modules; the browser gives them one shared scope
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    LOG_CAP_MS,
    logSeriesKey,
    logParseNumber,
    logUnitFor,
    LogRing,
    LogStore,
    logCsv,
  };
}
