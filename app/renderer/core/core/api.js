/**
 * @file The engine API client and the result-set projection every screen
 * reads through: chassis -> section -> ECU -> job against the local sidecar
 * (native) or the in-page fetch shim (web).
 */

/* exported tryApi, flatResults, flashing */

/**
 * One EDIABAS result set: named registers plus the internal `_`-prefixed and
 * JOB_STATUS fields.
 * @typedef {Object<string, any>} ResultSet
 */

/**
 * GET/POST an engine route and return its JSON.
 * @param {string} path - Route, e.g. `/api/ecu/ms450ds0/run/FS_LESEN`.
 * @param {RequestInit} [opts] - fetch options (method, body, ...).
 * @returns {Promise<any>} The parsed JSON body.
 * @throws {Error} The server's `error` field, or the HTTP status text.
 */
async function api(path, opts) {
  const url = `${API}${path}`;
  const res = await fetch(url, opts);
  if (!res.ok)
    throw new Error(
      (await res.json().catch(() => ({}))).error || res.statusText
    );
  const data = await res.json();
  return data;
}

/**
 * {@link api} with shared failure rendering: an error block into `container`,
 * `msg` on the status line, and null instead of a throw.
 * @param {string} path - Route.
 * @param {RequestInit|null} opts - fetch options.
 * @param {HTMLElement} [container] - Where the error block renders.
 * @param {string} [msg='failed'] - Status-line text on failure.
 * @returns {Promise<any|null>}
 */
async function tryApi(path, opts, container, msg = 'failed') {
  try {
    return await api(path, opts);
  } catch (e) {
    if (container) container.innerHTML = errorBlock(e.message);
    sbLeft.textContent = msg;
    return null;
  }
}

// EDIABAS answers every job with a SYNTHETIC set 0 the runtime fills
// (OBJECT, VARIANTE, JOBNAME, SAETZE) ahead of the data sets. The native
// server passes that through; the browser VM (webshim) returns DATA SETS
// ONLY and carries the record beside them as `system`. Dropping "set 0" by
// position therefore threw away the first REAL set in the browser -- one
// stored fault rendered as "clean fault memory", nine rendered as eight.
// A system set is recognised by what it contains, never by where it sits.

/**
 * True for EDIABAS's synthetic system summary set.
 * @param {ResultSet|any} s - A result set.
 * @returns {boolean}
 */
function isSystemSet(s) {
  return (
    !!s &&
    typeof s === 'object' &&
    ('SAETZE' in s || 'JOBNAME' in s || 'OBJECT' in s)
  );
}

/**
 * The data sets of a job answer: the system summary dropped when it leads
 * (and kept when it is the only set there is).
 * @param {ResultSet[]|null|undefined} sets - A job's result sets.
 * @returns {ResultSet[]}
 */
function dataSets(sets) {
  const list = sets || [];
  return list.length && isSystemSet(list[0]) ? list.slice(1) : list;
}

// flatten result sets into ordered [key, value] pairs, skipping internal keys
/**
 * Every register of every data set, in order, minus internal keys.
 * @param {ResultSet[]|null|undefined} sets - A job's result sets.
 * @returns {Array<[string, any]>}
 */
function flatResults(sets) {
  const out = [];
  dataSets(sets).forEach((s) =>
    Object.entries(s).forEach(([k, v]) => {
      if (!k.startsWith('_') && k !== 'JOB_STATUS') out.push([k, v]);
    })
  );
  return out;
}

/**
 * True while a flash/backup holds the bus, so the status poll skips its DME
 * read instead of queueing behind the multi-minute flash. Set by the flasher.
 * @type {boolean}
 */
let flashing = false;

/**
 * An input-taking INPA function: the job, its entry instruction, and how to
 * prompt for the value.
 * @typedef {Object} InputFunction
 * @property {string} job - The SGBD job to run.
 * @property {string} [field] - The entry instruction shown as the prompt.
 * @property {string} [args_template] - A sample argument string.
 * @property {'text'|'number'|'hex'} [kind] - Field kind for the dialog.
 * @property {string} [example] - Placeholder example.
 */
