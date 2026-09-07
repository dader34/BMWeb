/**
 * @file Whole-vehicle sweep: resolving one target to the SGBD to talk to --
 * the group probe as presence test, and what a silent or unreadable
 * address is allowed to be reported as.
 *
 * Second piece of screens/sweep/.
 */

/**
 * The shipped-groups index (data/groups/index.json).
 * @typedef {object} GroupIndex
 * @property {string[]} groups - Lower-case group SGBD names this build ships.
 */

/**
 * The shipped-groups index, fetched once per session.
 * @type {Promise<GroupIndex|null>|null}
 */
let _groupIndexP = null;

/**
 * The shipped-groups index gates the strict path: a group whose bytecode this
 * build ships can be run, and running it IS the presence test. One fetch per
 * session, shared by both sweeps and the background scan (ecu.js keeps its
 * own for the same reason -- it is a small static file and the browser
 * caches it).
 * @returns {Promise<GroupIndex|null>} The index, or null when it cannot be
 *   fetched.
 */
const groupIndex = () =>
  (_groupIndexP ??= fetch('data/groups/index.json')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null));

/**
 * Can this build run a group's probe?
 * @param {string|null|undefined} g - Lower-case group name.
 * @returns {Promise<boolean>} True when the resolver exists and the group is
 *   shipped.
 */
async function groupRunnable(g) {
  if (!g || typeof webResolveVariant !== 'function') return false;
  const idx = await groupIndex();
  return !!(idx && (idx.groups || []).includes(g));
}

/**
 * A group -> variant resolver for one sweep run. webResolveVariant caches
 * successful resolutions per session underneath (and drops them on
 * disconnect), so this layer only stops a single run from re-probing when
 * two sections list the same group.
 * @returns {(g: string) => Promise<string|null>} The resolver.
 */
function variantResolver() {
  const cache = new Map();
  return async (g) => {
    if (!cache.has(g)) {
      let v;
      try {
        v = await webResolveVariant(g);
      } catch {
        v = null;
      }
      cache.set(g, v);
    }
    return cache.get(g);
  };
}

/**
 * Cache of job-name lists by lower-case SGBD, for the session.
 * @type {Map<string, Promise<string[]>>}
 */
const _jobNames = new Map();

/**
 * The job names one SGBD declares.
 *
 * /api/ecu/<s>/jobs has TWO shapes, because two exporters write it:
 * web_export.py writes `sorted(jobs.keys())` (a string array) and
 * sgbd_export.py writes the lifted spec object `{jobs:[{name,...}]}`. Reading
 * only one of them silently sees zero jobs on every module the other exported
 * -- which here would report a present module as "not in build". This is the
 * same normalisation viJobs (screens/vehicle-identity/discovery.js) and
 * tool32.js already do.
 *
 * Cached per SGBD for the session: this is a fact about the BUILD (which job
 * code was exported), not about the car, so it cannot go stale on reconnect.
 * @param {string} sgbd - The SGBD.
 * @returns {Promise<string[]>} Its job names; empty on any failure.
 */
function jobNamesFor(sgbd) {
  const key = String(sgbd).toLowerCase();
  if (!_jobNames.has(key)) {
    _jobNames.set(
      key,
      api(`/api/ecu/${key}/jobs`)
        .then((j) => {
          const list = Array.isArray(j) ? j : (j && j.jobs) || [];
          return list
            .map((x) => (typeof x === 'string' ? x : x && x.name))
            .filter(Boolean);
        })
        .catch(() => [])
    );
  }
  return _jobNames.get(key);
}

/**
 * Can this build actually run jobs on this SGBD? The ident can name a variant
 * whose job code was never exported ('xyz' is BMW's own catch-all, and exotic
 * variants exist that no chassis config lists). Asking first is what lets the
 * row say "identified but not in this build" instead of "no response", which
 * are completely different facts about the car. Same test ecu.js uses before
 * it retargets a screen.
 * @param {string} sgbd - The SGBD.
 * @returns {Promise<boolean>} True when at least one job shipped.
 */
const buildHasVariant = async (sgbd) => (await jobNamesFor(sgbd)).length > 0;

/**
 * What to print for a target the resolver could not place. The group probe
 * records WHY it gave up (webResolveVariantLast): silence on the bus is the
 * only case that means "not installed"; a module that answered but matched
 * no variant, or a probe that failed, must not be reported as absent -- the
 * steering-angle sensor on a real E46 was, for a transport bug, and the row
 * read as a missing part.
 * @param {SweepTarget} t - The target.
 * @returns {string} The status text.
 */
function absentLabel(t) {
  if (!t.group) return 'no response';
  const rd =
    typeof webResolveVariantLast === 'function'
      ? webResolveVariantLast()
      : null;
  if (rd && rd.group === String(t.group).toLowerCase()) {
    if (rd.path === 'answered-but-unmatched') return 'answered, not identified';
    if (rd.path === 'probe-error') return 'probe failed';
  }
  return 'not installed';
}

/**
 * Resolve one target to the SGBD to talk to.
 *
 * STRICT MEANS STRICT: when a group is runnable and stays silent, the module
 * is absent and we do NOT fall back to reading a configured sibling. That
 * fallback is the exact trap this design exists to close -- the E46 config
 * maps Airbag to `zae` while many cars carry an MRS, and `zae` will happily
 * answer an MRS and decode its reply as a confident "0 faults". A diagnostic
 * tool reporting a clean airbag module that it never actually spoke to is the
 * worst failure available to it, so silence is reported as silence.
 * @param {SweepTarget} t - The target.
 * @param {(g: string) => Promise<string|null>} resolve - This run's resolver.
 * @returns {Promise<SweepResolution>} ok / absent / unbuilt.
 */
async function resolveTarget(t, resolve) {
  if (await groupRunnable(t.group)) {
    const via = await resolve(t.group);
    if (!via) return { state: 'absent' };
    if (!(await buildHasVariant(via))) return { state: 'unbuilt', via };
    return { state: 'ok', sgbd: via, ecu: rowForVariant(t, via), strict: true };
  }
  // No runnable group: the only thing left is the configured SGBD, read
  // directly. This is a weaker statement and the UI says so.
  const ecu = t.ecus[0];
  if (!ecu || !ecu.sgbd) return { state: 'absent' };
  return { state: 'ok', sgbd: ecu.sgbd, ecu, strict: false };
}

/**
 * resolveTarget, with a thrown probe reported as absence rather than a
 * crashed sweep.
 * @param {SweepTarget} t - The target.
 * @param {(g: string) => Promise<string|null>} resolve - This run's resolver.
 * @returns {Promise<SweepResolution>} The resolution.
 */
async function resolveTargetSafe(t, resolve) {
  try {
    return await resolveTarget(t, resolve);
  } catch {
    return { state: 'absent' };
  }
}
