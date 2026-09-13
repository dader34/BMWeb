// Control unit tree: the tree-driven scan. Where scan.js drives INPA's
// whole-car .IPO headless, this walks ISTA's own control unit tree instead:
// every module the series can carry, addressed by the group SGBDs the tree
// names, one job at a time.
//
// Why both exist. INPA ships a whole-car script for 10 chassis; ISTA ships a
// tree for 52, so this is the only scan most chassis can have. Where both
// exist the tree is the wider read -- 94 groups against 41 on E46, reaching
// EGS, EML, CCM, EHPS and DSP, none of which the script sweeps -- but it is
// not a strict superset, so the target list unions in the handful of groups
// only the script names (see ecuTreeScanExtras).
//
// Read-only by construction: the only jobs sent are the fault read and the
// identification read, both chosen from what the SGBD itself declares, and
// the ident picker excludes every write verb. Nothing here can change a car.

/** How often the boxes are repainted while a scan runs. */
const ECU_TREE_WALK_TICK_MS = 250;

/**
 * Buses whose modules ISTA lists but never draws. An entry on one of these
 * is a placeholder (a virtual aggregate, an internal sub-address), not a
 * module that answers on the wire, so the walk skips them.
 */
const ECU_TREE_WALK_SKIP_BUSES = new Set([
  'UNKNOWN',
  'VIRTUAL',
  'NONE',
  'INTERNAL',
  'ROOT',
]);

/**
 * @typedef {object} EcuTreeWalkTarget
 * @property {string} group - the group SGBD to address
 * @property {string} label - the module's name, for the report and the log
 * @property {number} addr - the diagnostic address (-1 when the tree omits it)
 * @property {string} bus - the bus the tree draws it on ('' for a script extra)
 */

/**
 * The scan list for a chassis: every drawn tree entry, then the groups only
 * the INPA script reaches.
 *
 * One module can appear under several groups (the tree lists both d_0000 and
 * d_zke_gm for E46's ZKE, which is the same alias pair the chassis configs
 * disagree about) and one group can be shared by several entries. Each group
 * is addressed once, keeping the first entry's label and address, because a
 * second read of the same group would be the same module answering twice.
 * @param {string} chassis - the chassis id
 * @param {object} [deps] - the runtime pieces (tests hand in fakes)
 * @returns {Promise<EcuTreeWalkTarget[]>} in tree order, extras last
 */
async function ecuTreeWalkTargets(chassis, deps) {
  const D = {
    tree: typeof ecuTreeForChassis === 'function' ? ecuTreeForChassis : null,
    extras: typeof ecuTreeScanExtras === 'function' ? ecuTreeScanExtras : null,
    ...(deps || {}),
  };
  const tree = D.tree ? await D.tree(chassis) : null;
  /** @type {Map<string, EcuTreeWalkTarget>} */
  const byGroup = new Map();
  for (const e of (tree && tree.ecus) || []) {
    if (ECU_TREE_WALK_SKIP_BUSES.has(String(e.bus || '').toUpperCase()))
      continue;
    for (const g of e.groups || []) {
      const group = String(g || '').toLowerCase();
      if (!group || byGroup.has(group)) continue;
      byGroup.set(group, {
        group,
        label: String(e.name || group),
        addr: typeof e.addr === 'number' ? e.addr : -1,
        bus: String(e.bus || ''),
      });
    }
  }
  for (const x of (D.extras ? await D.extras(chassis) : []) || []) {
    const group = String(x.group || '').toLowerCase();
    if (!group || byGroup.has(group)) continue;
    byGroup.set(group, {
      group,
      label: String(x.label || group),
      addr: -1,
      bus: '',
    });
  }
  return [...byGroup.values()];
}

/**
 * The fault-read job an SGBD declares, and the argument to send with it.
 *
 * FS_LESEN is near-universal, but neither the name nor the ARGUMENT is
 * uniform, so both come from what the module declares.
 *
 * The argument is why this returns a pair. E46's light switch centre (lsz_2)
 * stores faults in EIGHT blocks and declares `FS_LESEN(ALL_BLOCKS)`; called
 * bare it answers F_ZAHL 0 -- documented as "Gesamtfehler der Bloecke 1 bis 3
 * (schwere Fehler)" -- so a real fault sitting in block 5 reads as a clean
 * module. A current "Fernlicht rechts defekt" on a real car was invisible
 * exactly this way. INPA's own script has the same hole: it sends FS_LESEN
 * with an empty argument to every module.
 *
 * A declared argument's NAME is the keyword to pass (ALL_BLOCKS is both), so
 * a single-argument read is sent with its own name. A read wanting more than
 * one argument is not a sweep job -- nothing can supply those values here --
 * and is passed over for one that needs none.
 * @param {string} sgbd - the SGBD that answered
 * @param {(s: string) => Promise<string[]>} names - job-name lookup
 * @param {(s: string) => Promise<object[]>} [decls] - job declarations, for
 *   the arguments; without it every job is called bare, as before
 * @returns {Promise<{job: string, arg: string}|null>} the job and its
 *   argument (''), or null when the module declares no fault read
 */
async function ecuTreeFaultJobFor(sgbd, names, argsOf) {
  const all = await names(sgbd);
  const reads = all.filter((n) => /^FS_LESEN(_|$)/i.test(n));
  if (!reads.length) return null;
  // the detail read needs a fault code as an argument: never a sweep on its own
  const plain = reads.filter((n) => !/DETAIL/i.test(n));
  if (!plain.length) return null;

  // exact FS_LESEN first, then the narrowest prefixed read
  const order = [
    ...plain.filter((n) => /^FS_LESEN$/i.test(n)),
    ...plain
      .filter((n) => !/^FS_LESEN$/i.test(n))
      .sort((a, b) => a.length - b.length),
  ];
  if (!argsOf) return { job: order[0], arg: '' };
  for (const job of order) {
    const args = (await argsOf(sgbd, job)) || [];
    if (!args.length) return { job, arg: '' };
    // a declared argument's NAME is the keyword to pass (ALL_BLOCKS is both)
    if (args.length === 1) {
      const a = args[0];
      const name = String((a && (a.ARG || a.name)) || '');
      if (name) return { job, arg: name };
    }
    // more than one argument, or an unnamed one: nothing here can supply
    // those values, so try the next read rather than half-asking this one
  }
  return null;
}

/**
 * Walk a chassis's control unit tree, reading every module it can carry.
 *
 * Each target is resolved from its group to the variant the car actually
 * answers as (webResolveVariant drives the group's own IDENTIFIKATION over
 * the bus), then read. A group nothing answers on is recorded as silent,
 * which is how an option a car does not have is told from a module that
 * failed -- the same distinction the script path makes.
 *
 * The wire log is the same IpoWireRead[] the .IPO path produces, so the
 * result folds through ipoProtocolReport and every consumer of a scan
 * report -- the tree's boxes, the Garage store, the ISTA slots -- reads it
 * without knowing which scanner ran.
 * @param {string} chassis - the chassis id
 * @param {EcuTreeScanHooks} hooks - progress sinks (scan.js's shape)
 * @param {object} [deps] - the runtime pieces (tests hand in fakes)
 * @returns {EcuTreeScanHandle} done/cancel, as ecuTreeScanStart returns
 */
function ecuTreeWalkStart(chassis, hooks, deps) {
  const D = {
    targets: ecuTreeWalkTargets,
    resolve:
      typeof webResolveVariant === 'function' ? webResolveVariant : null,
    jobNames: typeof jobNamesFor === 'function' ? jobNamesFor : null,
    identJob: typeof identJobFor === 'function' ? identJobFor : null,
    run: (sgbd, job, arg) =>
      api(
        `/api/ecu/${sgbd}/run/${job}` +
          (arg ? `?arg=${encodeURIComponent(arg)}` : ''),
        { method: 'POST' }
      ),
    /**
     * A job's declared arguments (/api/ecu/<s>/arguments/<JOB>).
     *
     * NOT the /jobs route: that answers a plain list of NAMES, with no
     * arguments on it at all. The arguments live on their own route, and a
     * job that declares none 404s there -- which is the common case, so a
     * failure here means "no arguments", not an error.
     */
    jobArgs: async (sgbd, job) => {
      try {
        const j = await api(`/api/ecu/${sgbd}/arguments/${job}`);
        return (j && j.arguments) || [];
      } catch (e) {
        return [];
      }
    },
    report:
      typeof ipoProtocolReport === 'function' ? ipoProtocolReport : null,
    cableReady: typeof window !== 'undefined' ? window.cableReady : null,
    ...(deps || {}),
  };
  const h = hooks || {};
  let cancelled = false;
  const done = (async () => {
    // the target list first: "no tree for this chassis" is the answer the
    // caller acts on, and it must not be masked by a runtime-wiring check
    const targets = await D.targets(chassis, deps);
    if (!targets.length)
      throw new Error(`ISTA ships no control unit tree for ${chassis}`);
    if (!D.resolve || !D.report || !D.jobNames)
      throw new Error('the scan runtime is not loaded');
    if (D.cableReady) await D.cableReady.catch(() => {});

    /** @type {object[]} the wire log, in ipoProtocolReport's shape */
    const reads = [];
    /**
     * Variants already read. The tree lists ALIASES -- E46's ZKE is both
     * d_0000 and d_zke_gm -- and both resolve to the same module, so
     * reading the second is the same module answering twice. It would also
     * be lost: ipoProtocolReport keys a module by the variant that answered,
     * so a second read folds into the first and the extra group's own entry
     * disappears. Skipping here keeps the log honest and the scan shorter.
     * @type {Map<string, string>} variant -> the group that reached it
     */
    const seen = new Map();
    let answered = 0;
    const tick = (text) => {
      if (h.onProgress) h.onProgress(D.report(reads, []), text || '');
    };
    for (let i = 0; i < targets.length; i++) {
      if (cancelled) break;
      const t = targets[i];
      const at = `${i + 1}/${targets.length}`;
      tick(`${at} ${t.label} (${t.group})`);
      let sgbd = null;
      try {
        sgbd = await D.resolve(t.group);
      } catch (e) {
        sgbd = null;
      }
      if (!sgbd) {
        // nothing answered this group: the option is not fitted, or the
        // module is dead. Recorded, never guessed at.
        reads.push({
          target: t.group,
          job: 'FS_LESEN',
          error: 'no response',
        });
        tick(`${at} ${t.label} (${t.group}) - silent`);
        continue;
      }
      if (seen.has(sgbd)) {
        // an alias of a module already read: not silent, not read again
        continue;
      }
      seen.set(sgbd, t.group);
      const pick = await ecuTreeFaultJobFor(sgbd, D.jobNames, D.jobArgs);
      if (!pick) {
        reads.push({
          target: t.group,
          variant: sgbd,
          job: 'FS_LESEN',
          error: 'declares no fault read',
        });
        continue;
      }
      const { job, arg } = pick;
      try {
        const d = await D.run(sgbd, job, arg);
        reads.push({
          target: t.group,
          variant: sgbd,
          job,
          arg: arg || null,
          sets: (d && d.sets) || [],
        });
        answered++;
        tick(`${at} ${t.label} -> ${sgbd}`);
      } catch (e) {
        reads.push({
          target: t.group,
          variant: sgbd,
          job,
          arg: arg || null,
          error: String((e && e.message) || e),
        });
      }
      tick('');
    }
    // every address failing is a missing cable, not a car of silent modules
    if (!answered && reads.length && reads.every((r) => r.error))
      throw new Error('No adapter connected');
    return { report: D.report(reads, []), lines: [], cancelled };
  })();
  return {
    done,
    cancel: () => {
      cancelled = true;
    },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ECU_TREE_WALK_TICK_MS,
    ECU_TREE_WALK_SKIP_BUSES,
    ecuTreeWalkTargets,
    ecuTreeFaultJobFor,
    ecuTreeWalkStart,
  };
}
