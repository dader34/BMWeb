/**
 * @file Vehicle identity: which control units hold the car's build record,
 * asked of the modules' own job declarations.
 *
 * First piece of screens/vehicle-identity/. The folder reads the car's build
 * record and says what it means. Two records exist, depending on the
 * generation:
 *   ZCS  E36..E53   three keys in a 20-byte region on the cluster/light module
 *   FA   E60+       the build order as text, whose $ tokens are SA numbers
 *
 * WHICH ECU TO ASK IS DATA, NOT A LIST. BMW's SGFAM table flags, per control
 * unit, whether it holds the order (FA) or the coding key (ZCS). On E46 that
 * is KMB and EWS for the order, AKMB and ALSZ for the key. Hardcoding those
 * names would be wrong on the next chassis and wrong again on a car whose
 * DATEN ships a different family map, so the masters are derived from the
 * table -- and confirmed against the modules, below.
 *
 * WHICH JOB, AND WHICH RESULT, ARE READ FROM THE ECU'S OWN DECLARATION.
 *
 * Nothing here is a list of names somebody typed. Every SGBD ships its job
 * table -- each job's name, its results, and their comments -- and that table
 * is what says how to read this control unit. A hand-written list of likely
 * spellings is how the old scan came to look for GM_SCHLUESSEL on a module
 * that calls it GM, and to miss C_AZCS_LESEN entirely.
 *
 * Two spellings the corpus actually contains, either of which a typed list
 * would have got wrong:
 *   ZCS_LESEN   returns GM, SA, VM   <- third key spelled VM
 *   C_ZCS_LESEN returns GM, SA, VN   <- and VN here
 * So the keys are matched by POSITION IN THE DECLARATION, not by name.
 */

/**
 * A job as the runtime's job list names it.
 * @typedef {object} ViJob
 * @property {string} name - The job name (C_ZCS_LESEN).
 */

/**
 * The result names an ECU declares for its three coding keys.
 * @typedef {object} ViKeyNames
 * @property {string} gm - Result holding the Grundmerkmal.
 * @property {string} sa - Result holding the Sonderausstattung.
 * @property {string} vn - Result holding the Versionsnummer (VN or VM).
 */

/**
 * A confirmed coding-key read: the job and the result names to read.
 * @typedef {object} ViZcsJob
 * @property {string} job - The job to run.
 * @property {ViKeyNames} keys - Which result carries which key.
 */

/**
 * A confirmed vehicle-order read.
 * @typedef {object} ViFaJob
 * @property {string} job - The job to run.
 * @property {string} result - The result carrying the order.
 */

/**
 * A control unit that answers an identity read.
 * @typedef {object} ViIdentityModule
 * @property {string} sgbd - The SGBD to ask (the coding SGBD where it ships).
 * @property {string} diagSgbd - The diagnostic SGBD the chassis config lists
 *   for the same module; the VIN and stored odometer often live only there.
 * @property {string|null} code - The config's INPA code (kombi).
 * @property {string} label - The config's display label.
 * @property {boolean} fa - Answers with the vehicle order.
 * @property {boolean} zcs - Answers with the coding key.
 * @property {ViFaJob|null} faJob - The order read, when `fa`.
 * @property {ViZcsJob|null} zcsJob - The key read, when `zcs`.
 */

/**
 * The identity-job index entry for one SGBD (data/tables.js `_identity`).
 * @typedef {object} ViIndexEntry
 * @property {{ job: string }[]} [zcs] - Candidate key-returning jobs.
 * @property {{ job: string }[]} [fa] - Candidate order-returning jobs.
 */

// A job reads the coding key if it declares three single-key results beside a
// status. The regex names the ROLE (grund/sonder/versions), never a spelling.
/** Result-name roles of the three coding keys, in GM/SA/VN order. */
const VI_KEY_ROLE = [/^GM$/i, /^SA$/i, /^V[NM]$/i];

/** Results that are transport plumbing, not data: every SGBD prefixes them. */
const VI_INTERNAL = /^_/;

/** Result names that carry the vehicle order. */
const VI_FA_RESULT_ROLE = /FAHRZEUGAUFTRAG|STANDARD_FA/i;

/** The two coding reads a CABD exposes; declaring either makes it usable. */
const VI_CODING_READS = ['C_ZCS_LESEN', 'C_FA_LESEN'];

/** Config codes whose SGFAM short name is spelled differently. */
const VI_SG_ALIAS = { KOMBI: 'KMB' };

/**
 * Is this job a read? The write classifier is default-deny, so anything it
 * cannot prove is a read stays out of an identity screen that must never
 * change the car.
 * @param {string} name - Job name.
 * @returns {boolean} True only when the classifier is loaded and clears it.
 */
function viIsRead(name) {
  return typeof isWriteJob === 'function' ? !isWriteJob(name) : false;
}

/**
 * The job names an ECU declares. Names only -- the runtime endpoint does not
 * carry each job's results, which is why viJobResults exists.
 * @param {string} sgbd - The SGBD.
 * @returns {Promise<ViJob[]>} The jobs; empty when no job table ships.
 */
async function viJobs(sgbd) {
  try {
    const list = await api(`/api/ecu/${sgbd}/jobs`);
    if (Array.isArray(list)) {
      return list
        .map((j) => (typeof j === 'string' ? { name: j } : j))
        .filter((j) => j && j.name);
    }
    if (list && typeof list === 'object') {
      return Object.keys(list).map((k) => ({ name: k, ...(list[k] || {}) }));
    }
  } catch (e) {
    /* no job table shipped for this module */
  }
  return [];
}

/**
 * One job's declared results, as plain names.
 *
 * The endpoint answers with "NAME : comment" strings ("GM : Zentralcode C1 -
 * Grundmerkmal"), so the name is the part before the first colon. Transport
 * plumbing is dropped.
 * @param {string} sgbd - The SGBD.
 * @param {string} job - The job.
 * @returns {Promise<string[]>} Result names, or empty on any failure.
 */
async function viJobResults(sgbd, job) {
  try {
    const rows = await api(
      `/api/ecu/${sgbd}/results/${encodeURIComponent(job)}`
    );
    if (!Array.isArray(rows)) return [];
    return rows
      .map((r) =>
        String(typeof r === 'string' ? r : (r && r.name) || '')
          .split(':')[0]
          .trim()
      )
      .filter((n) => n && !VI_INTERNAL.test(n));
  } catch (e) {
    return [];
  }
}

/**
 * The coding SGBD (CABD) paired with a diagnostic SGBD, from BMW's own SGFAM
 * table -- the mapping NCS Expert uses.
 *
 * A diagnostic SGBD (kombi46) answers ZCS_LESEN with a stale / uninitialised
 * SA whose region scan can lock onto coincidentally-valid but WRONG bytes;
 * the CABD (C_KMB46) answers C_ZCS_LESEN / C_FA_LESEN with the authoritative
 * value. SGFAM is keyed by SG short-name (KMB, EWS, LSZ, AKMB, ALSZ); the
 * config gives us the diagnostic name (kombi46) and a `code` (kombi), so
 * bridge to the short-name, take its `.cabd`, and use it only when it ships
 * (loads by name) and exposes a coding read.
 *
 * A car lists several SGs sharing a family (KMB and AKMB both -> C_KMB46; LSZ
 * and ALSZ -> C_LSZ / C_LSZA): prefer the CABD that carries a coding READ,
 * which is how the identity role (fa/zcs) is expressed.
 * @param {string} sgbd - The diagnostic SGBD the chassis config lists.
 * @param {string|null|undefined} code - The config's INPA code.
 * @param {string} chassisId - Upper-case chassis id, to scope the lookup.
 * @returns {Promise<string|null>} The CABD name, lowercased, or null so the
 *   caller falls back to the diagnostic SGBD.
 */
async function viCodingSgbdFor(sgbd, code, chassisId) {
  const t = (typeof window !== 'undefined' && window.BMW_TABLES) || null;
  // Scope to THIS chassis's sgfam: the same SG short-name (KMB) recurs across
  // chassis with different CABDs, so scanning every table adds cross-chassis
  // noise. Fall back to all tables only when the chassis isn't resolvable.
  const one = t && chassisId && t[String(chassisId).toUpperCase()];
  const tables =
    one && one.sgfam
      ? [one]
      : t
        ? Object.values(t).filter((x) => x && x.sgfam)
        : [];
  const wantKeys = viSgShortNames(sgbd, code);
  const cabds = [];
  for (const tbl of tables) {
    for (const [sg, row] of Object.entries(tbl.sgfam)) {
      if (!row || !row.cabd) continue;
      if (wantKeys.includes(sg.toUpperCase())) {
        // rank a row that declares a coding read ahead of a bare one
        cabds.push({
          cabd: String(row.cabd).toLowerCase(),
          rank: (row.zcs ? 2 : 0) + (row.fa ? 1 : 0),
        });
      }
    }
  }
  cabds.sort((a, b) => b.rank - a.rank);
  for (const { cabd } of cabds) {
    if (cabd.startsWith('c_') && (await viHasCodingRead(cabd))) return cabd;
  }
  return null;
}

/**
 * The SGFAM short-names a diagnostic SGBD / config code could map to. SGFAM
 * keys are terse (KMB, not kombi46), and a family may have an "A"-prefixed
 * variant (AKMB, ALSZ) for the same CABD -- include both, plus a couple of
 * well-known aliases the terse form does not spell out (kombi -> KMB).
 * @param {string|null|undefined} sgbd - The diagnostic SGBD.
 * @param {string|null|undefined} code - The config's INPA code.
 * @returns {string[]} Candidate short names, upper case.
 */
function viSgShortNames(sgbd, code) {
  const raw = [String(code || ''), String(sgbd || '')]
    .map((x) => x.toUpperCase().replace(/[0-9]+$/, ''))
    .filter(Boolean);
  const out = new Set();
  for (const r of raw) {
    const base = VI_SG_ALIAS[r] || r;
    out.add(base);
    out.add('A' + base); // AKMB, ALSZ, AEWS variants share the CABD
  }
  return [...out];
}

/**
 * Does a CABD SGBD load AND expose a coding read (C_ZCS_LESEN / C_FA_LESEN)?
 * @param {string} sgbd - The CABD name.
 * @returns {Promise<boolean>} True when it ships and declares either read.
 */
async function viHasCodingRead(sgbd) {
  const jobs = await viJobs(sgbd);
  if (!jobs.length) return false;
  const names = jobs.map((j) => j.name);
  return VI_CODING_READS.some((n) => names.includes(n));
}

/**
 * The identity-job index entry for an SGBD: which job on which SGBD answers
 * with a key or an order, derived from every shipped SGBD's own declarations
 * by tools/decompile/ncs_tables.py. 20 jobs out of 27340 qualify.
 *
 * This is a CANDIDATE LIST, not the decision. Scanning it costs nothing, but
 * what the module in front of us declares is still what settles it -- a car
 * whose SGBD differs from the shipped copy is caught by the confirmation
 * rather than trusted from a table.
 * @param {string} sgbd - The SGBD.
 * @returns {ViIndexEntry|null} The entry, or null when the index has none.
 */
function viIndexFor(sgbd) {
  const t = (typeof window !== 'undefined' && window.BMW_TABLES) || null;
  const idx = t && t._identity;
  return (idx && idx[String(sgbd).toLowerCase()]) || null;
}

/**
 * Confirm a key-read candidate against the ECU's live declaration.
 *
 * Returns the same shape the candidate has, rebuilt from what the module
 * actually says, so a spelling that moved (the third key is VM on one job and
 * VN on another) is taken from the car and not from the index.
 * @param {string} sgbd - The SGBD.
 * @param {string} job - The candidate job.
 * @returns {Promise<ViZcsJob|null>} The confirmed read, or null.
 */
async function viConfirmZcs(sgbd, job) {
  if (!viIsRead(job)) return null;
  const names = await viJobResults(sgbd, job);
  const keys = VI_KEY_ROLE.map((re) => names.find((n) => re.test(n)));
  return keys.every(Boolean)
    ? { job, keys: { gm: keys[0], sa: keys[1], vn: keys[2] } }
    : null;
}

/**
 * Confirm an order-read candidate against the ECU's live declaration.
 * @param {string} sgbd - The SGBD.
 * @param {string} job - The candidate job.
 * @returns {Promise<ViFaJob|null>} The confirmed read, or null.
 */
async function viConfirmFa(sgbd, job) {
  if (!viIsRead(job)) return null;
  const names = await viJobResults(sgbd, job);
  const hit = names.find((n) => VI_FA_RESULT_ROLE.test(n));
  return hit ? { job, result: hit } : null;
}

/**
 * The read job on this ECU that answers with the three coding keys, or null.
 * @param {string} sgbd - The SGBD.
 * @param {ViJob[]} jobs - Its declared jobs.
 * @returns {Promise<ViZcsJob|null>} The confirmed read, or null.
 */
async function viPickZcsJob(sgbd, jobs) {
  const declared = new Set(jobs.map((j) => j.name));
  const idx = viIndexFor(sgbd);
  for (const cand of (idx && idx.zcs) || []) {
    if (!declared.has(cand.job)) continue;
    const got = await viConfirmZcs(sgbd, cand.job);
    if (got) return got;
  }
  return null;
}

/**
 * The read job that answers with the vehicle order, or null.
 * @param {string} sgbd - The SGBD.
 * @param {ViJob[]} jobs - Its declared jobs.
 * @returns {Promise<ViFaJob|null>} The confirmed read, or null.
 */
async function viPickFaJob(sgbd, jobs) {
  const declared = new Set(jobs.map((j) => j.name));
  const idx = viIndexFor(sgbd);
  for (const cand of (idx && idx.fa) || []) {
    if (!declared.has(cand.job)) continue;
    const got = await viConfirmFa(sgbd, cand.job);
    if (got) return got;
  }
  return null;
}

/**
 * Every distinct ECU a chassis config lists, in config order.
 * @param {string} chassisId - Upper-case chassis id.
 * @returns {Promise<object[]>} The config's ECU rows, deduplicated by SGBD;
 *   empty when the config cannot be loaded.
 */
async function viConfigEcus(chassisId) {
  let ch;
  try {
    ch = await api(`/api/chassis/${chassisId}`);
  } catch (e) {
    return [];
  }
  const seen = new Set();
  const ecus = [];
  for (const s of ch.sections || []) {
    for (const e of s.ecus || []) {
      if (!e.sgbd || seen.has(e.sgbd)) continue;
      seen.add(e.sgbd);
      ecus.push(e);
    }
  }
  return ecus;
}

/**
 * Probe one configured ECU for an identity read, on its coding SGBD first
 * and its diagnostic SGBD second.
 *
 * READ CODING FROM THE CODING SGBD. The diagnostic SGBD a car lists
 * (kombi46) answers ZCS_LESEN with a stale / uninitialised SA -- its
 * region scan can lock onto a coincidentally-valid but WRONG 16 bytes
 * (FFFFFFA8EF020F05 vs the true blank FFFFFFFFFFFFFFFF). The paired
 * coding SGBD (c_kmb46) exposes C_ZCS_LESEN / C_FA_LESEN with NAMED
 * GM/SA/VN keys and returns the authoritative value -- the same read
 * NCS Expert performs. Prefer it whenever it ships (orphan .ecu, so it
 * loads by name), falling back to the configured diagnostic SGBD.
 * @param {object} e - A chassis-config ECU row ({ sgbd, code, label }).
 * @param {string} chassisId - Upper-case chassis id.
 * @returns {Promise<ViIdentityModule|null>} The module, or null when neither
 *   SGBD declares an identity read.
 */
async function viProbeEcu(e, chassisId) {
  const codingSgbd = await viCodingSgbdFor(e.sgbd, e.code, chassisId);
  for (const sgbd of [codingSgbd, e.sgbd]) {
    if (!sgbd) continue;
    const jobs = await viJobs(sgbd);
    if (!jobs.length) continue;
    const zcsJob = await viPickZcsJob(sgbd, jobs);
    const faJob = await viPickFaJob(sgbd, jobs);
    if (!zcsJob && !faJob) continue;
    return {
      sgbd,
      // The diagnostic SGBD the car lists for the same module. The coding
      // SGBD answers the identity; the VIN and the stored odometer often
      // live only on the diagnostic one (EWS keeps its KD blocks on `ews`,
      // c_ews3 declares no such read), so both are asked in turn.
      diagSgbd: String(e.sgbd).toLowerCase(),
      code: e.code || null,
      label: e.label || e.sgbd,
      fa: !!faJob,
      zcs: !!zcsJob,
      faJob,
      zcsJob,
    };
  }
  return null;
}

/**
 * WHICH CONTROL UNITS HOLD THE IDENTITY, ASKED OF THE MODULES THEMSELVES.
 *
 * BMW's SGFAM table also flags this, but its logical names are not the SGBDs
 * we address: E46's table says KMB and the shipped module is `kombi46`, says
 * ALSZ where nothing by that name ships at all. Rather than invent a name
 * transform, the question is put to the modules -- an ECU that declares a job
 * returning the coding keys or the vehicle order IS an identity master.
 *
 * This lands on the same answer SGFAM gives (E46: the cluster and EWS) and
 * keeps working where the naming does not line up. SGFAM is still used, for
 * the human-readable family name in the source strip.
 * @param {string|null|undefined} chassisId - Chassis id, any case.
 * @returns {Promise<ViIdentityModule[]>} The masters, in chassis-config order.
 */
async function viIdentityModules(chassisId) {
  const probes = await viIdentityProbes(chassisId);
  const probed = await Promise.all(probes);
  return probed.filter(Boolean);
}

/**
 * One probe per module of the chassis, started together. Kept apart from
 * the list so a caller that only needs to know whether ANY module answers
 * can stop at the first hit instead of waiting for all fifty-odd archives.
 * @param {string|null|undefined} chassisId - Chassis id, any case.
 * @returns {Promise<Array<Promise<ViIdentityModule|null>>>} The probes.
 */
async function viIdentityProbes(chassisId) {
  const id = String(chassisId || '').toUpperCase();
  const ecus = await viConfigEcus(id);
  if (!ecus.length) return [];
  if (typeof loadTables === 'function') await loadTables();
  return ecus.map((e) => viProbeEcu(e, id).catch(() => null));
}

/**
 * Cache of viIdentityModules by chassis: probing every module's job table is
 * a handful of fetches, and both the nav tile and the screen ask the same
 * question.
 * @type {Map<string, Promise<ViIdentityModule[]>>}
 */
const _viIdentCache = new Map();

/**
 * The chassis's probes, memoised for the session: `all` is the full list
 * (the screen), `any` settles true at the FIRST module that answers (the
 * nav row), so a menu does not wait on every archive before it can show
 * the entry. Both share the same underlying fetches.
 * @param {string|null|undefined} chassisId - Chassis id, any case.
 * @returns {{all: Promise<ViIdentityModule[]>, any: Promise<boolean>}}
 */
function viIdentityCached(chassisId) {
  const id = String(chassisId || '').toUpperCase();
  if (_viIdentCache.has(id)) return _viIdentCache.get(id);
  const probesP = viIdentityProbes(id);
  const all = probesP
    .then((ps) => Promise.all(ps))
    .then((list) => list.filter(Boolean));
  const any = probesP.then(
    (ps) =>
      new Promise((resolve) => {
        if (!ps.length) return resolve(false);
        let left = ps.length;
        for (const p of ps) {
          p.then((r) => {
            if (r) resolve(true);
            if (--left === 0) resolve(false);
          });
        }
      })
  );
  const rec = { all, any };
  _viIdentCache.set(id, rec);
  return rec;
}

/**
 * viIdentityModules, memoised per chassis for the session.
 * @param {string|null|undefined} chassisId - Chassis id, any case.
 * @returns {Promise<ViIdentityModule[]>} The masters.
 */
function viIdentityModulesCached(chassisId) {
  return viIdentityCached(chassisId).all;
}

/**
 * Does this chassis have anything that can answer? Drives the nav tile, and
 * is the same test the screen runs -- so the tile never opens a dead end.
 * @param {string|null|undefined} chassisId - Chassis id, any case.
 * @returns {Promise<boolean>} True when at least one master was found.
 */
async function chassisHasIdentity(chassisId) {
  try {
    return await viIdentityCached(chassisId).any;
  } catch (e) {
    return false;
  }
}
