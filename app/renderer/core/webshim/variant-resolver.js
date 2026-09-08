/**
 * @file Group -> variant resolution over the live bus.
 *
 * Which SGBD is this ECU? EDIABAS answers with GROUP files: d_00a4 probes
 * diagnostic address 0xA4, decodes the ident answer, and reports VARIANTE
 * ("MRS4"), which IS the SGBD name to load. The groups in data/groups/ are
 * the same VM bytecode as any job (tools/export/sgbd_export.py); the newer
 * dialect additionally resolves through the t_grtb assignment table
 * (variants.json), reached by tabset/tabsetex "ZuordnungsTabelle".
 * ResolveSgbdFile in the reference engine does exactly this: run the
 * group's IDENTIFIKATION, read result VARIANTE from the first data set.
 */
/* exported forgetResolvedVariants, webResolveVariantLast, webResolveVariant */

/**
 * Why the last webResolveVariant call answered what it did.
 * @typedef {object} ResolveDiag
 * @property {string} group - The group name (lowercased).
 * @property {'no-probe-shipped'|'silent-recently'|'probe-error'|'bus-silent'|'resolved'|'answered-but-unmatched'} path -
 *   Which exit the resolver took.
 * @property {string} [variant] - The resolved SGBD name.
 * @property {string} [error] - The probe's error text.
 * @property {number} [empty] - Telegrams that got no usable answer.
 * @property {number} [real] - Telegrams that were answered.
 * @property {number} [sets] - Result sets the probe produced.
 */

/**
 * name -> Promise<code|null>; the PROMISE is cached so two concurrent
 * resolves of the same group fetch once.
 * @type {Map<string, Promise<any|null>>}
 */
const groupCodeCache = new Map();
/** @type {Promise<any|null>|null} */
let groupVariantsPromise = null;
/**
 * group -> variant. Successful resolutions only, per session: an ECU that
 * did not answer may be a module that was busy, so a re-sweep asks again.
 * @type {Map<string, string>}
 */
const groupVariantCache = new Map();
/**
 * Groups that answered NOTHING, by the time they were last probed. A
 * whole-vehicle script asks each group two or three jobs in a row (INFO,
 * FS_LESEN); an address that is not fitted must not eat a full probe
 * timeout for each of them. Short-lived on purpose: the next module the
 * user plugs in, or the ignition coming on, must be found again.
 * @type {Map<string, number>}
 */
const groupMissCache = new Map();
/** how long a silent address stays silent without re-probing (ms) */
const GROUP_MISS_TTL_MS = 15000;

/**
 * Load a group's VM bytecode from data/groups/<name>.json.gz, once.
 * @param {string} name - The group name (any case).
 * @returns {Promise<any|null>} The exported program, or null.
 */
function loadGroupCode(name) {
  const key = String(name).toLowerCase();
  if (!groupCodeCache.has(key)) {
    groupCodeCache.set(key, webFetchGz(`data/groups/${key}.json.gz`));
  }
  return groupCodeCache.get(key);
}

/**
 * Load the t_grtb assignment table (variants.json), once.
 * @returns {Promise<{table?: string, rows: any[]}|null>}
 */
function loadGroupVariants() {
  if (!groupVariantsPromise) {
    groupVariantsPromise = webFetchJson('data/groups/variants.json');
  }
  return groupVariantsPromise;
}

/**
 * Forget the resolved variants: they are facts about the CAR on the other
 * end of the cable, and the next connection may be a different one.
 */
function forgetResolvedVariants() {
  groupVariantCache.clear();
  groupMissCache.clear();
}

/**
 * The tables a group probe runs against: the group's OWN tables (tabset
 * dialect: d_0032 reaches its embedded ZuordnungsTabelle copy with a plain
 * `tabset`), plus t_grtb for the `tabsetex "ZuordnungsTabelle", "t_grtb"`
 * dialect. Each side also stands in for the other defensively: exports that
 * predate local tables get the t_grtb master under the local name (its keys
 * embed the address, so the same rows match), and a missing variants.json
 * falls back to the group's local copies as t_grtb -- but where both exist,
 * the real source wins (local copy for tabset, the t_grtb dump for
 * tabsetex), which is what the engine reads in each case.
 * @param {any} code - The group's exported program.
 * @param {{table?: string, rows: any[]}|null} variants - variants.json.
 * @returns {{tables: Record<string, any>, extTables: Record<string, any>}}
 */
function groupProbeTables(code, variants) {
  const tables = Object.assign({}, code.tables || {});
  const extTables = { t_grtb: Object.assign({}, code.tables || {}) };
  if (variants && Array.isArray(variants.rows)) {
    const tname = variants.table || 'ZuordnungsTabelle';
    extTables.t_grtb[tname] = variants.rows;
    const hasLocal = Object.keys(tables).some(
      (k) => k.toUpperCase() === tname.toUpperCase()
    );
    if (!hasLocal) tables[tname] = variants.rows;
  }
  return { tables, extTables };
}

/**
 * Why the last webResolveVariant call answered null -- the gate screens
 * read this so a failed probe reports WHICH way it failed instead of a
 * generic "no answer". Five exits share that null, and on a live car they
 * mean completely different things (silent bus vs. answered-but-unmatched).
 * @type {ResolveDiag|null}
 */
let _lastResolve = null;

/**
 * The diagnosis of the most recent resolve.
 * @returns {ResolveDiag|null}
 */
function webResolveVariantLast() {
  return _lastResolve;
}

/**
 * Record how a resolve ended: for webResolveVariantLast, the console, and
 * the session journal (a beta Report must say WHY a module was not
 * identified, not just that inpainit stopped afterwards).
 * @param {string} key - The group name (lowercased).
 * @param {ResolveDiag['path']} path - Which exit was taken.
 * @param {Partial<ResolveDiag>} [extra] - Counters, variant or error text.
 */
function noteResolve(key, path, extra) {
  _lastResolve = { group: key, path, ...extra };
  console.info(`[variant] ${key}: ${path}`, extra || '');
  if (typeof Journal !== 'undefined' && Journal.log) {
    Journal.log(
      'variant',
      `${key}: ${path}` + (extra ? ' ' + JSON.stringify(extra) : '')
    );
  }
}

/**
 * Resolve one group to a concrete variant over the live bus: run the
 * group's IDENTIFIKATION exactly the way webRunJob drives a job (passes
 * with memoised answers over webBus.exchange), and return the VARIANTE it
 * reports, LOWERCASED -- that is the SGBD name every loader here expects.
 * IDENTIFIKATION is a read (IDENT is a strong read token), so no
 * allowWrites is involved.
 *
 * A GROUP PROBES SEVERAL PROTOCOLS AT ONE ADDRESS, AND SILENCE ON ONE OF
 * THEM IS A NORMAL STEP, NOT THE END OF THE JOB. d_0012 opens with a DS2
 * frame (12 04 00), then falls back to KWP2000* (B8 12 F1 02 1A 80). An MS45
 * ignores the first and answers the second -- verified against EDIABAS's own
 * ifh.trc on a real E46, which logs SetError EDIABAS_IFH_0009 on the DS2
 * probe and keeps going. The bytecode branches on the answer's LENGTH
 * (slen), so an empty answer is what carries it to the next telegram.
 * Letting that rejection escape returned "no variant" for a DME that was
 * answering perfectly, and the sweep drew it as "not installed" -- hiding
 * ten real stored faults. driveJobOverBus applies the same rule for both.
 * @param {string} groupName - The group (d_xxxx) to probe, any case.
 * @returns {Promise<string|null>} The lowercased SGBD name, or null when
 *   nothing answered, the answer matched no variant, or the group could not
 *   be loaded; never a made-up name.
 */
async function webResolveVariant(groupName) {
  const key = String(groupName).toLowerCase();
  if (groupVariantCache.has(key)) return groupVariantCache.get(key);
  const missedAt = groupMissCache.get(key);
  if (missedAt != null && Date.now() - missedAt < GROUP_MISS_TTL_MS) {
    noteResolve(key, 'silent-recently');
    return null;
  }
  const code = await loadGroupCode(key);
  if (!code || !code.jobs || code.jobs.IDENTIFIKATION === undefined) {
    noteResolve(key, 'no-probe-shipped');
    return null;
  }
  const variants = await loadGroupVariants();
  const { tables, extTables } = groupProbeTables(code, variants);

  let sets;
  const tally = newTally();
  try {
    const r = await driveJobOverBus(
      (send, now) =>
        new Best2Vm(code, {
          tables,
          extTables,
          args: '',
          // Group probing walks diagnostic addresses to find out WHICH module
          // answers, so it must never transmit anything that changes one. It
          // only ever needs idents, and this stays refused on purpose.
          allowWrites: false,
          now,
          send,
        }),
      'IDENTIFIKATION',
      '',
      tally
    );
    sets = r.sets;
  } catch (e) {
    // A job-level failure (bad bytecode, unusable answer) means the address
    // did not identify. Absence of an ANSWER is handled inside the drive.
    noteResolve(key, 'probe-error', {
      error: String((e && e.message) || e),
      empty: tally.empty,
      real: tally.real,
    });
    groupMissCache.set(key, Date.now());
    return null;
  }
  // Nothing on this address answered anything: the module is genuinely not
  // there. Distinguished from a resolution that ran but matched no variant,
  // which is a shipped-tables problem rather than a silent bus.
  if (tally.empty && !tally.real) {
    noteResolve(key, 'bus-silent', { empty: tally.empty });
    groupMissCache.set(key, Date.now());
    return null;
  }
  for (const s of sets || []) {
    if (typeof s.VARIANTE === 'string' && s.VARIANTE) {
      const v = s.VARIANTE.toLowerCase();
      noteResolve(key, 'resolved', {
        variant: v,
        empty: tally.empty,
        real: tally.real,
      });
      groupVariantCache.set(key, v);
      return v;
    }
  }
  noteResolve(key, 'answered-but-unmatched', {
    empty: tally.empty,
    real: tally.real,
    sets: (sets || []).length,
  });
  groupMissCache.set(key, Date.now());
  return null;
}
