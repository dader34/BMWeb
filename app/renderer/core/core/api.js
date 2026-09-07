/**
 * @file The engine API client and the result-set projection every screen
 * reads through: chassis -> section -> ECU -> job against the local sidecar
 * (native) or the in-page fetch shim (web).
 */

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

/**
 * `?group=` query for an ECU with a diagnostic-address group SGBD, so the
 * server (LoadForJob) lets EDIABAS pick the installed variant.
 * @param {{group?: string}|null|undefined} o - An ECU record.
 * @returns {string} The query string, or '' when ungrouped.
 */
const groupQuery = (o) =>
  o && o.group ? `?group=${encodeURIComponent(o.group)}` : '';

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

/**
 * Prompt for a value, then run the job with it and render the result.
 * @param {{sgbd: string}} ecu - The target ECU.
 * @param {InputFunction} input - The function to run.
 * @param {HTMLElement} container - Where the result (or error) renders.
 * @returns {Promise<void>}
 */
async function runInputFunction(ecu, input, container) {
  // THE CANONICAL CLASSIFIER DECIDES, not a word list. The old regex looked
  // for English write-words in the job name and prompt, so 1,029 of the
  // corpus's 6,544 job names that isWriteJob() calls writes got the soft
  // "Run" button instead of "Send" -- FS_LOESCHEN (clear fault memory, 364
  // modules), FLASH_SCHREIBEN, PRUEFSTEMPEL_SCHREIBEN and INITIALISIERUNG
  // among them, none of which contain an English verb. isWriteJob is
  // token-based and default-deny, and is the same gate bestvm enforces
  // before a job reaches the bus.
  const danger =
    typeof isWriteJob === 'function'
      ? isWriteJob(input.job || '')
      : // no classifier in scope: fall back to the prompt text rather than
        // silently calling an unknown job safe
        /steuern|command|throttle|setpoint|write|store|reset/i.test(
          (input.field || '') + ' ' + (input.job || '')
        );
  const val = await inputDialog({
    title: esc(
      typeof jobLabel === 'function' ? jobLabel(input.job) : input.job
    ),
    // input.field is the entry instruction ("Enter as LABEL;VALUE1"), shown as the prompt
    body:
      `${input.field ? `<div>${esc(input.field)}</div>` : ''}` +
      `${input.args_template ? `<span class="muted">${esc(input.args_template)}</span><br>` : ''}` +
      `<span class="mono" style="font-size:11px;color:var(--ink-faint)">job: ${esc(input.job)}</span>`,
    kind: input.kind || 'text',
    example: input.example || '',
    confirmLabel: danger ? 'Send' : 'Run',
    danger,
  });
  if (val == null) {
    sbLeft.textContent = 'cancelled';
    return;
  }

  container.className = 'results-panel';
  container.innerHTML = `<div class="empty"><span class="loader"></span><span>Running ${esc(input.field || input.job)}…</span></div>`;
  try {
    const data = await api(
      `/api/ecu/${ecu.sgbd}/run/${input.job}?arg=${encodeURIComponent(val)}`,
      { method: 'POST' }
    );
    renderResultSets(data.sets, container, input.job);
    sbLeft.textContent = `${input.job} ${val} · done`;
  } catch (e) {
    container.innerHTML = errorBlock(e.message);
    sbLeft.textContent = 'failed';
  }
}
