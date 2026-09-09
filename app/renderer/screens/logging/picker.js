/**
 * @file Data logging: choosing what to log -- the module list, the readable
 * jobs on a module, and the result registers a job declares.
 *
 * Fourth piece of screens/logging/ (see store.js for the folder map).
 *
 * NOTHING THAT WRITES IS OFFERED. A logging run polls its selection over and
 * over for as long as the user leaves it going; a write in that rotation
 * would be fired hundreds of times against a live car. isWriteJob
 * (core/bestvm/write-guard.js) is default-deny -- an unrecognised name counts
 * as a write -- so the filter here is the same one the VM's guard uses, and
 * an oddly named job is left out rather than logged.
 */

/* exported logReadableJobs, logResultKeys, LogSelection */

/**
 * The modules of a chassis, flattened out of its sections.
 * @param {string} chassis - The chassis id, e.g. 'E46'.
 * @returns {Promise<Array<{sgbd: string, label: string, code: string, group: string|null, section: string}>>}
 */
async function logModulesFor(chassis) {
  const ch = await api(`/api/chassis/${encodeURIComponent(chassis)}`);
  const out = [];
  for (const sec of (ch && ch.sections) || []) {
    for (const ecu of sec.ecus || []) {
      if (!ecu || !ecu.sgbd) continue;
      // the whole record travels: `group` is what lets a job be routed to the
      // variant actually fitted, and rebuilding the object later drops it
      out.push({
        sgbd: ecu.sgbd,
        label: ecu.label || ecu.code || ecu.sgbd,
        code: ecu.code || '',
        group: ecu.group || null,
        section: sec.name || '',
      });
    }
  }
  return out;
}

/**
 * The jobs on a module that are safe to poll: everything the build shipped,
 * minus every write.
 *
 * INITIALISIERUNG and ENDE are excluded by the write classifier already
 * (INITIALISIER is a write token) -- which is correct here for a second
 * reason: the session machinery runs them itself, and scheduling them would
 * fight it.
 * @param {string} sgbd - The module's SGBD.
 * @returns {Promise<string[]>} Readable job names, sorted.
 */
async function logReadableJobs(sgbd) {
  const names = await jobNamesFor(sgbd);
  return names.filter((n) => !isWriteJob(n)).sort((a, b) => a.localeCompare(b));
}

/**
 * The result registers a job declares, with the comment the SGBD carries.
 *
 * /api/ecu/<s>/results/<JOB> ships either "NAME : comment" strings (what the
 * web export writes) or {name, unit} objects (the spec export), so both are
 * normalised. Registers starting with '_' are EDIABAS internals (the raw hex
 * telegrams) and JOB_STATUS is the call's own OK flag -- neither is a
 * measurement, so neither is offered.
 *
 * The unit is usually absent here and only becomes known once the ECU
 * answers (see logUnitFor in store.js); when the spec build did carry one it
 * is passed through so the picker can show it up front.
 * @param {string} sgbd - The module's SGBD.
 * @param {string} job - The job name.
 * @returns {Promise<Array<{name: string, comment: string, unit: string}>>} The keys; [] when none shipped.
 */
async function logResultKeys(sgbd, job) {
  let raw;
  try {
    raw = await api(
      `/api/ecu/${String(sgbd).toLowerCase()}/results/${encodeURIComponent(job)}`
    );
  } catch (e) {
    return []; // no result schema shipped for this job
  }
  return (Array.isArray(raw) ? raw : [])
    .map((r) => {
      if (typeof r === 'string') {
        const i = r.indexOf(' : ');
        return i < 0
          ? { name: r.trim(), comment: '', unit: '' }
          : {
              name: r.slice(0, i).trim(),
              comment: r.slice(i + 3).trim(),
              unit: '',
            };
      }
      return {
        name: (r && r.name) || '',
        comment: (r && r.comment) || '',
        unit: (r && r.unit) || '',
      };
    })
    .filter(
      (r) => r.name && !r.name.startsWith('_') && r.name !== 'JOB_STATUS'
    );
}

/**
 * What the user has chosen to log, and the rules for changing it.
 *
 * Held as a flat map of series id -> the module/job/key it names, because
 * that is exactly what the store declares and the scheduler groups; the UI's
 * tree shape is rebuilt from it on demand rather than stored twice.
 */
class LogSelection {
  constructor() {
    /** @type {Map<string, {sgbd: string, label: string, group: string|null, job: string, key: string}>} */
    this.items = new Map();
  }

  /**
   * Whether a key is selected.
   * @param {string} sgbd - The module.
   * @param {string} job - The job.
   * @param {string} key - The register.
   * @returns {boolean}
   */
  has(sgbd, job, key) {
    return this.items.has(logSeriesKey(sgbd, job, key));
  }

  /**
   * Select or deselect one key.
   * @param {{sgbd: string, label: string, group: string|null}} mod - The module.
   * @param {string} job - The job.
   * @param {string} key - The register.
   * @param {boolean} on - Whether it should be selected.
   * @returns {void}
   */
  set(mod, job, key, on) {
    const id = logSeriesKey(mod.sgbd, job, key);
    if (!on) {
      this.items.delete(id);
      return;
    }
    // a write must never enter the rotation, whatever called this
    if (isWriteJob(job)) return;
    this.items.set(id, {
      sgbd: mod.sgbd,
      label: mod.label || mod.sgbd,
      group: mod.group || null,
      job,
      key,
    });
  }

  /** @returns {number} How many keys are selected. */
  get size() {
    return this.items.size;
  }

  /**
   * Forget everything.
   * @returns {void}
   */
  clear() {
    this.items.clear();
  }

  /**
   * The selection as the scheduler wants it: one entry per (module, job),
   * carrying every key chosen on it.
   * @returns {Array<{sgbd: string, label: string, group: string|null, job: string, keys: string[]}>}
   */
  targets() {
    const byPair = new Map();
    for (const it of this.items.values()) {
      const k = `${String(it.sgbd).toLowerCase()}/${it.job}`;
      if (!byPair.has(k)) {
        byPair.set(k, {
          sgbd: it.sgbd,
          label: it.label,
          group: it.group,
          job: it.job,
          keys: [],
        });
      }
      byPair.get(k).keys.push(it.key);
    }
    return [...byPair.values()];
  }

  /**
   * A plain object for a saved preset.
   * @returns {Array<{sgbd: string, label: string, group: string|null, job: string, key: string}>}
   */
  toJSON() {
    return [...this.items.values()];
  }

  /**
   * Rebuild from a saved preset, dropping anything that would now be a write
   * -- the classifier can tighten between builds, and a preset must not be a
   * way around it.
   * @param {Array<{sgbd: string, label: string, group: string|null, job: string, key: string}>} rows - Saved rows.
   * @returns {LogSelection} this.
   */
  fromJSON(rows) {
    this.items.clear();
    for (const r of rows || []) {
      if (!r || !r.sgbd || !r.job || !r.key) continue;
      this.set(
        { sgbd: r.sgbd, label: r.label || r.sgbd, group: r.group || null },
        r.job,
        r.key,
        true
      );
    }
    return this;
  }
}

// node loads these pieces as modules; the browser gives them one shared scope
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    logModulesFor,
    logReadableJobs,
    logResultKeys,
    LogSelection,
  };
}
