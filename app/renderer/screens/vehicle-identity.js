// Vehicle identity: read the car's build record, and say what it means.
//
// Two records, depending on the generation:
//   ZCS  E36..E53   three keys in a 20-byte region on the cluster/light module
//   FA   E60+       the build order as text, whose $ tokens are SA numbers
//
// WHICH ECU TO ASK IS DATA, NOT A LIST. BMW's SGFAM table flags, per control
// unit, whether it holds the order (FA) or the coding key (ZCS). On E46 that
// is KMB and EWS for the order, AKMB and ALSZ for the key. Hardcoding those
// names would be wrong on the next chassis and wrong again on a car whose
// DATEN ships a different family map, so the buttons below are generated from
// the table.
//
// LAYOUT. The reading is the headline: one summary card saying what the car
// IS, with the equipment underneath as labelled chips. The ECUs that produced
// it are a footnote strip, not the main event -- which control unit answered
// matters when a read fails and almost never otherwise.

// WHICH JOB, AND WHICH RESULT, ARE READ FROM THE ECU'S OWN DECLARATION.
//
// Nothing here is a list of names somebody typed. Every SGBD ships its job
// table -- each job's name, its results, and their comments -- and that table
// is what says how to read this control unit. A hand-written list of likely
// spellings is how the old scan came to look for GM_SCHLUESSEL on a module
// that calls it GM, and to miss C_AZCS_LESEN entirely.
//
// Two spellings the corpus actually contains, either of which a typed list
// would have got wrong:
//   ZCS_LESEN   returns GM, SA, VM   <- third key spelled VM
//   C_ZCS_LESEN returns GM, SA, VN   <- and VN here
// So the keys are matched by POSITION IN THE DECLARATION, not by name.

// A job reads the coding key if it declares three single-key results beside a
// status. The regex names the ROLE (grund/sonder/versions), never a spelling.
const VI_KEY_ROLE = [/^GM$/i, /^SA$/i, /^V[NM]$/i];

// Results that are transport plumbing, not data: every SGBD prefixes them.
const VI_INTERNAL = /^_/;

// Is this job a read? The write classifier is default-deny, so anything it
// cannot prove is a read stays out of an identity screen that must never
// change the car.
function viIsRead(name) {
  return typeof isWriteJob === 'function' ? !isWriteJob(name) : false;
}

// The job names an ECU declares. Names only -- the runtime endpoint does not
// carry each job's results, which is why viJobResults exists below.
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

// One job's declared results, as plain names.
//
// The endpoint answers with "NAME : comment" strings ("GM : Zentralcode C1 -
// Grundmerkmal"), so the name is the part before the first colon. Transport
// plumbing is dropped.
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

// The identity-job index: which job on which SGBD answers with a key or an
// order, derived from every shipped SGBD's own declarations by
// tools/decompile/ncs_tables.py. 20 jobs out of 27340 qualify.
//
// This is a CANDIDATE LIST, not the decision. Scanning it costs nothing, but
// what the module in front of us declares is still what settles it -- a car
// whose SGBD differs from the shipped copy is caught by the confirmation
// below rather than trusted from a table.
// The coding SGBD (CABD) paired with a diagnostic SGBD, from BMW's own SGFAM
// table -- the mapping NCS Expert uses. A diagnostic SGBD (kombi46) answers
// ZCS_LESEN with a stale / uninitialised SA whose region scan can lock onto
// coincidentally-valid but WRONG bytes; the CABD (C_KMB46) answers
// C_ZCS_LESEN / C_FA_LESEN with the authoritative value. SGFAM is keyed by SG
// short-name (KMB, EWS, LSZ, AKMB, ALSZ); the config gives us the diagnostic
// name (kombi46) and a `code` (kombi), so bridge to the short-name, take its
// `.cabd`, and use it only when it ships (loads by name) and exposes a coding
// read. Returns the CABD name (lowercased) or null so the caller falls back.
//
// A car lists several SGs sharing a family (KMB and AKMB both -> C_KMB46; LSZ
// and ALSZ -> C_LSZ / C_LSZA): prefer the CABD that carries a coding READ,
// which is how the identity role (fa/zcs) is expressed.
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

// The SGFAM short-names a diagnostic SGBD / config code could map to. SGFAM
// keys are terse (KMB, not kombi46), and a family may have an "A"-prefixed
// variant (AKMB, ALSZ) for the same CABD -- include both, plus a couple of
// well-known aliases the terse form does not spell out (kombi -> KMB).
function viSgShortNames(sgbd, code) {
  const raw = [String(code || ''), String(sgbd || '')]
    .map((x) => x.toUpperCase().replace(/[0-9]+$/, ''))
    .filter(Boolean);
  const alias = { KOMBI: 'KMB' };
  const out = new Set();
  for (const r of raw) {
    const base = alias[r] || r;
    out.add(base);
    out.add('A' + base); // AKMB, ALSZ, AEWS variants share the CABD
  }
  return [...out];
}

// Does a CABD SGBD load AND expose a coding read (C_ZCS_LESEN / C_FA_LESEN)?
async function viHasCodingRead(sgbd) {
  const jobs = await viJobs(sgbd);
  if (!jobs.length) return false;
  const names = jobs.map((j) => j.name);
  return names.includes('C_ZCS_LESEN') || names.includes('C_FA_LESEN');
}

function viIndexFor(sgbd) {
  const t = (typeof window !== 'undefined' && window.BMW_TABLES) || null;
  const idx = t && t._identity;
  return (idx && idx[String(sgbd).toLowerCase()]) || null;
}

// Confirm a candidate against the ECU's live declaration.
//
// Returns the same shape the candidate has, rebuilt from what the module
// actually says, so a spelling that moved (the third key is VM on one job and
// VN on another) is taken from the car and not from the index.
async function viConfirmZcs(sgbd, job) {
  if (!viIsRead(job)) return null;
  const names = await viJobResults(sgbd, job);
  const keys = VI_KEY_ROLE.map((re) => names.find((n) => re.test(n)));
  return keys.every(Boolean)
    ? { job, keys: { gm: keys[0], sa: keys[1], vn: keys[2] } }
    : null;
}

async function viConfirmFa(sgbd, job) {
  if (!viIsRead(job)) return null;
  const names = await viJobResults(sgbd, job);
  const hit = names.find((n) => /FAHRZEUGAUFTRAG|STANDARD_FA/i.test(n));
  return hit ? { job, result: hit } : null;
}

// The read job on this ECU that answers with the three coding keys, or null.
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

// The read job that answers with the vehicle order, or null.
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

// WHICH CONTROL UNITS HOLD THE IDENTITY, ASKED OF THE MODULES THEMSELVES.
//
// BMW's SGFAM table also flags this, but its logical names are not the SGBDs
// we address: E46's table says KMB and the shipped module is `kombi46`, says
// ALSZ where nothing by that name ships at all. Rather than invent a name
// transform, the question is put to the modules -- an ECU that declares a job
// returning the coding keys or the vehicle order IS an identity master.
//
// This lands on the same answer SGFAM gives (E46: the cluster and EWS) and
// keeps working where the naming does not line up. SGFAM is still used, for
// the human-readable family name in the source strip.
//
// Returns [{ sgbd, label, fa, zcs, faJob, zcsJob }] in chassis order.
async function viIdentityModules(chassisId) {
  const id = String(chassisId || '').toUpperCase();
  let ch;
  try {
    ch = await api(`/api/chassis/${id}`);
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
  if (typeof loadTables === 'function') await loadTables();
  const probed = await Promise.all(
    ecus.map(async (e) => {
      // READ CODING FROM THE CODING SGBD. The diagnostic SGBD a car lists
      // (kombi46) answers ZCS_LESEN with a stale / uninitialised SA -- its
      // region scan can lock onto a coincidentally-valid but WRONG 16 bytes
      // (FFFFFFA8EF020F05 vs the true blank FFFFFFFFFFFFFFFF). The paired
      // coding SGBD (c_kmb46) exposes C_ZCS_LESEN / C_FA_LESEN with NAMED
      // GM/SA/VN keys and returns the authoritative value -- the same read
      // NCS Expert performs. Prefer it whenever it ships (orphan .ecu, so it
      // loads by name), falling back to the configured diagnostic SGBD.
      const codingSgbd = await viCodingSgbdFor(e.sgbd, e.code, id);
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
    })
  );
  return probed.filter(Boolean);
}

// Cache: probing every module's job table is a handful of fetches, and both
// the nav tile and the screen ask the same question.
const _viIdentCache = new Map();

async function viIdentityModulesCached(chassisId) {
  const id = String(chassisId || '').toUpperCase();
  if (_viIdentCache.has(id)) return _viIdentCache.get(id);
  const p = viIdentityModules(id);
  _viIdentCache.set(id, p);
  return p;
}

// Does this chassis have anything that can answer? Drives the nav tile, and
// is the same test the screen runs -- so the tile never opens a dead end.
async function chassisHasIdentity(chassisId) {
  try {
    return (await viIdentityModulesCached(chassisId)).length > 0;
  } catch (e) {
    return false;
  }
}

// hex text -> bytes, or null. Accepts "0A 0B", "0A-0B" and "0x0A0B".
function viBytes(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return v.map((b) => b & 0xff);
  if (ArrayBuffer.isView(v)) return Array.from(v, (b) => b & 0xff);
  const s = String(v).trim().replace(/^0x/i, '');
  if (/^[0-9A-Fa-f]{2}([\s-][0-9A-Fa-f]{2})+$/.test(s)) {
    return s.split(/[\s-]+/).map((h) => parseInt(h, 16));
  }
  if (/^[0-9A-Fa-f]+$/.test(s) && s.length % 2 === 0) {
    const out = [];
    for (let i = 0; i < s.length; i += 2)
      out.push(parseInt(s.substr(i, 2), 16));
    return out;
  }
  return null;
}

// Pull the three coding keys out of a reply, using the result names the ECU
// itself declared for this job.
//
// Two shapes in the wild: an ECU that names each key, and one that answers
// with a raw region the keys sit inside. The named form needs no offset. The
// raw form goes through coding-zcs, which knows the 4-1-8-1-5-1 layout.
function viKeysFrom(values, keyNames) {
  const pick = (n) => {
    if (!n || !values.has(n)) return null;
    const s = String(values.get(n)).replace(/[^0-9A-Fa-f]/g, '');
    return s ? s.toUpperCase() : null;
  };
  const gm = pick(keyNames && keyNames.gm);
  const sa = pick(keyNames && keyNames.sa);
  const vn = pick(keyNames && keyNames.vn);
  // A key may carry its Mod-36 check character; the tables mask the body only.
  if (gm && sa && vn) {
    return {
      gm: gm.slice(0, 8),
      sa: sa.slice(0, 16),
      vn: vn.slice(0, 10),
      source: 'named',
    };
  }
  // No named keys: the reply may still CONTAIN the region. Every non-internal
  // result is a candidate blob, and the region is found by verifying its
  // check characters rather than by assuming where it starts -- see
  // viFindRegion. A blob that never verifies yields nothing.
  for (const [name, v] of values) {
    if (VI_INTERNAL.test(name)) continue;
    const bytes = viBytes(v);
    if (!bytes || bytes.length < 20) continue;
    const found = viFindRegion(bytes);
    if (found) return { ...found, source: 'region', from: name };
  }
  return null;
}

// Find the 20-byte ZCS region inside a larger blob by verifying its check
// characters. Returns {gm,sa,vn,offset} or null.
function viFindRegion(bytes) {
  if (typeof CodingZcs === 'undefined' || !CodingZcs.parseZcsRegion)
    return null;
  for (let off = 0; off + 20 <= bytes.length; off++) {
    let r;
    try {
      r = CodingZcs.parseZcsRegion(bytes.slice(off, off + 20));
    } catch (e) {
      continue;
    }
    // All three check characters must verify. One passing by chance is
    // common (1 in 36); three at the same offset is not.
    if (r.gm.valid && r.sa.valid && r.vn.valid) {
      return { gm: r.gm.body, sa: r.sa.body, vn: r.vn.body, offset: off };
    }
  }
  return null;
}

// The vehicle order, read from the result the ECU declared for it.
function viFaFrom(values, resultName) {
  if (!resultName || !values.has(resultName)) return null;
  const s = String(values.get(resultName)).trim();
  return s && /[_#*%&|$]/.test(s) ? s : null;
}

// The vehicle order as TEXT, whatever form the module keeps it in.
//
// A ZCS-era coding module (E46 c_kmb46, c_lsza) hands the order back exactly
// as its memory holds it: a bit-packed stream, six bits a character, that
// starts with a version byte and carries no marker characters at all. EDIABAS
// ships the decoder for that stream as its own SGBD -- FA.PRG's
// FA_STREAM2STRUCT takes the block number and the raw stream and answers
// with the marker-delimited order (STANDARD_FA) the parser understands. So a
// reply that is not already text is put through that job, and only the
// job's own answer is trusted: no hand-rolled unpacking of a format BMW
// already decodes for us.
async function viFaText(values, resultName) {
  if (!resultName || !values.has(resultName)) return null;
  const raw = values.get(resultName);
  const stream = Array.isArray(raw)
    ? String.fromCharCode(...raw.map((b) => Number(b) & 0xff))
    : String(raw);
  // Text or stream is decided by the BYTES, never by which characters happen
  // to occur: a packed stream carries 0x24 ('$') as data, and reading that
  // as "it has a marker, so it is text" fed the raw bytes to the order
  // parser. Text is printable ASCII throughout; a stream is not.
  const packed = Array.from(stream).some((c) => {
    const b = c.charCodeAt(0);
    return b < 0x20 || b > 0x7e;
  });
  if (!packed) return viFaFrom(values, resultName);
  // an empty or erased region (all 0xFF / 0x00) carries no order
  if (
    !stream ||
    !Array.from(stream).some((c) => {
      const b = c.charCodeAt(0);
      return b !== 0 && b !== 0xff;
    })
  )
    return null;
  try {
    const decoded = await viRunValues('fa', 'FA_STREAM2STRUCT', `1;${stream}`);
    const status = decoded.has('JOB_STATUS')
      ? String(decoded.get('JOB_STATUS'))
      : '';
    if (status !== 'OKAY') return null;
    return viFaFrom(decoded, 'STANDARD_FA');
  } catch (e) {
    return null;
  }
}

// THE IDENTITY READ, WITHOUT THE SCREEN.
//
// The coding hub needs the car's equipment codes before it can decide which
// module fills each slot, and it needs them as data, not as a rendered card.
// This is that read: same discovery, same job, same decoding, no DOM.
//
// Returns { codes, ci, fa, keys, source } -- `codes` being SA catalogue
// numbers, the namespace SGET predicates use. An empty `codes` means the car
// did not say, and callers must treat that as "nothing known" rather than
// "no equipment": selecting modules off an empty list would re-point them
// against nothing.
const _viCodesCache = new Map();

async function readIdentityCodes(chassisId) {
  const id = String(chassisId || '').toUpperCase();
  if (_viCodesCache.has(id)) return _viCodesCache.get(id);
  const p = (async () => {
    const empty = { codes: [], ci: {}, fa: null, keys: null, source: null };
    if (typeof VehicleIdentity === 'undefined') return empty;
    if (typeof loadTables === 'function') await loadTables();
    let masters = [];
    try {
      masters = await viIdentityModulesCached(id);
    } catch (e) {
      return empty;
    }
    if (!masters.length) return empty;

    // The order first: its tokens are already catalogue numbers.
    for (const m of masters.filter((x) => x.fa)) {
      try {
        const d = await api(`/api/ecu/${m.sgbd}/run/${m.faJob.job}`, {
          method: 'POST',
        });
        const text = await viFaText(
          new Map(flatResults(d.sets)),
          m.faJob.result
        );
        if (!text) continue;
        const fa = VehicleIdentity.parseFa(text);
        return {
          codes: VehicleIdentity.saCodesFromFa(fa),
          ci: {},
          fa,
          keys: null,
          source: `${m.sgbd}:${m.faJob.job}`,
        };
      } catch (e) {
        /* try the next master */
      }
    }

    // Then the coding key, translated through BMW's chassis tables. A key
    // whose SA body is blank (all-FF) carries no equipment -- keep it only as
    // a last resort so a real FA/ZCS on another master still wins, and never
    // let a blank key fabricate an option list.
    let blankFallback = null;
    for (const m of masters.filter((x) => x.zcs)) {
      try {
        const d = await api(`/api/ecu/${m.sgbd}/run/${m.zcsJob.job}`, {
          method: 'POST',
        });
        const keys = viKeysFrom(new Map(flatResults(d.sets)), m.zcsJob.keys);
        if (!keys) continue;
        const eq = VehicleIdentity.saCodesFromZcs(id, keys);
        const result = {
          codes: eq.codes,
          ci: eq.ci,
          fa: null,
          keys,
          blank: !!eq.blank,
          source: `${m.sgbd}:${m.zcsJob.job}`,
        };
        if (eq.blank || (!eq.resolved && !eq.codes.length)) {
          // remember the first blank/unresolved key, but keep looking
          if (!blankFallback) blankFallback = result;
          continue;
        }
        return result;
      } catch (e) {
        /* try the next master */
      }
    }
    // nothing resolved: return the blank key honestly (codes:[]) so the UI
    // shows "no options decoded" rather than inventing any
    return blankFallback || empty;
  })();
  _viCodesCache.set(id, p);
  return p;
}

// ---- rendering: NCS's "Information about car and ZCS/FA coding" ------------
//
// ONE COLUMN PER IDENTITY MASTER, read separately and never merged. The car
// stores its record twice (E46: cluster and EWS), and the whole reason this
// dialog exists is to compare the copies -- a swapped module shows up as two
// columns that disagree, which a first-answer-wins page can never show.
// Three boxes, same as the original: what the car is, the coding record, and
// the decoded option list.

// Roles for the car-info results, matched against DECLARED result names --
// same contract as VI_KEY_ROLE: the regex names the ROLE, never one spelling.
// (kombi46 declares AIF_FG_NR, ews declares FG_NR; both are the VIN.)
const VI_VIN_ROLE = /^(AIF_)?FG_?NR$|^FGSTNR/i;
// The STORED odometer a cluster declares outright: the Gesamtwegstrecken-
// zaehler out of its Anwenderinfofeld (AIF_GWSZ_LESEN on kombi39, kombi46,
// ike). Exact name, so GWSZ_MINUS_OFFSET's derived value never stands in.
const VI_KM_STORED_ROLE = /^STAT_GWSZ_WERT$/i;

// The read job on this ECU declaring a result in `role`. Scanning is archive
// reads only (each job's result table ships in the .ecu); the wire sees just
// the one job that wins.
//
// Several jobs may declare the role: the E46 light module's service-interval
// read (SIA_LESEN) returns FG_NR beside a dozen counters, and C_FG_LESEN
// returns FG_NR alone. The job that EXISTS to answer the question is the one
// declaring the fewest other results, so that is the one asked -- not the
// first in declaration order, which is where SIA_LESEN happens to sit.
async function viPickInfoJob(sgbd, jobs, role) {
  let best = null;
  for (const j of jobs) {
    if (!viIsRead(j.name)) continue;
    const names = await viJobResults(sgbd, j.name);
    const hit = names.find((n) => role.test(n));
    if (!hit) continue;
    const others = names.filter((n) => n !== hit && n !== 'JOB_STATUS').length;
    if (!best || others < best.others) {
      best = { job: j.name, result: hit, others };
    }
  }
  return best ? { job: best.job, result: best.result } : null;
}

// Run a job and answer with its results by name. flatResults drops the
// engine's JOB_STATUS as non-data, which it is for display -- but a decoder
// (FA_STREAM2STRUCT) says whether it understood its input ONLY through that
// status, so it travels along here under its own name.
async function viRunValues(sgbd, job, arg) {
  const q = arg != null ? `?arg=${encodeURIComponent(arg)}` : '';
  const d = await api(`/api/ecu/${sgbd}/run/${job}${q}`, { method: 'POST' });
  const values = new Map(flatResults(d.sets));
  const status = (d.sets || [])
    .map((s) => s && s.JOB_STATUS)
    .find((v) => v != null);
  if (status != null) values.set('JOB_STATUS', String(status));
  return values;
}

// The SGFAM family a master belongs to, for the column title and the source
// strip: EWS, KMB, LSZ -- the terse names NCS Expert's own dialog uses. The
// bridge is the one that chose the coding SGBD (viSgShortNames), read back:
// of the families the module's config names could be, the base name (KMB)
// beats its "A" variant (AKMB, the same module's second coding role), and
// between equals the family whose CABD is the SGBD that answered wins.
// Absent is fine -- it is a nicety, and the config label stands in.
function viFamilyName(fam, m) {
  if (!fam || !m) return null;
  const sg = String(m.sgbd || '').toUpperCase();
  const want = viSgShortNames(m.diagSgbd || m.sgbd, m.code);
  const cands = Object.keys(fam).filter((k) => k === sg || want.includes(k));
  if (!cands.length) return null;
  const cabdIs = (k) =>
    String((fam[k] && fam[k].cabd) || '').toUpperCase() === sg ? 0 : 1;
  cands.sort(
    (a, b) => a.length - b.length || cabdIs(a) - cabdIs(b) || (a < b ? -1 : 1)
  );
  return cands[0];
}

// Read ONE master completely: its record (FA or ZCS), its VIN, its odometer.
async function viReadColumn(m, sources, famName) {
  const col = { m, keys: null, fa: null, faRaw: null, vin: null, km: null };
  const sg = famName(m) || m.sgbd;
  if (m.fa) {
    try {
      const values = await viRunValues(m.sgbd, m.faJob.job);
      const text = await viFaText(values, m.faJob.result);
      if (text) {
        col.faRaw = text;
        col.fa = VehicleIdentity.parseFa(text);
        sources.push({ sg, ok: true, what: `order via ${m.faJob.job}` });
      } else {
        sources.push({
          sg,
          ok: false,
          what: `${m.faJob.job}: no order in reply`,
        });
      }
    } catch (e) {
      sources.push({ sg, ok: false, what: 'no answer' });
    }
  }
  if (m.zcs && !col.fa) {
    try {
      const values = await viRunValues(m.sgbd, m.zcsJob.job);
      const k = viKeysFrom(values, m.zcsJob.keys);
      if (k) {
        col.keys = k;
        sources.push({
          sg,
          ok: true,
          what:
            k.source === 'named'
              ? `keys via ${m.zcsJob.job}`
              : `key region at byte ${k.offset}`,
        });
      } else {
        // a reply whose keys do not check out is NOT shown as the car's
        sources.push({
          sg,
          ok: false,
          what: `${m.zcsJob.job}: no valid key in reply`,
        });
      }
    } catch (e) {
      sources.push({ sg, ok: false, what: 'no answer' });
    }
  }
  // VIN and odometer, from whatever job the module declares for them -- on
  // its coding SGBD first, then on its diagnostic one.
  const sgbds = [m.sgbd];
  if (m.diagSgbd && m.diagSgbd !== m.sgbd) sgbds.push(m.diagSgbd);
  const jobsOf = new Map();
  for (const sg of sgbds) jobsOf.set(sg, await viJobs(sg));
  // VIN from the module's own named result.
  for (const sg of sgbds) {
    if (col.vin) break;
    const pick = await viPickInfoJob(sg, jobsOf.get(sg), VI_VIN_ROLE);
    if (!pick) continue;
    try {
      const values = await viRunValues(sg, pick.job);
      const v = values.has(pick.result)
        ? String(values.get(pick.result)).trim()
        : '';
      if (v) col.vin = viVinBody(v);
    } catch (e) {
      /* try the next source; the row shows an em dash if none answers */
    }
  }

  // ODOMETER. Prefer the STORED value each module keeps in non-volatile
  // memory, never a live CAN broadcast:
  //   - Cluster (KMB): EEPROM word 0x28, bytes 1..3 BE km. The named
  //     STAT_KILOMETERSTAND_WERT is the CAN-signal mileage, which reads stale
  //     and DIFFERENT every time with the engine off (it is not being
  //     broadcast) -- exactly the drifting 79k/82k/94k values that looked like
  //     a mismatch. The EEPROM copy is stable and matches the dash.
  //   - EWS: KD block 0, bytes 2..4 LE km.
  // Both verified on a 231,364 mi car: KMB 372,358 km, EWS 372,346 km -- they
  // agree, which is why the car shows no tamper dot. Only if neither stored
  // read is available do we fall back to the module's named km result.
  // STORED copies only. A module without one shows an em dash rather than
  // a stand-in: the light module's service-interval counter is kept in
  // 100 km steps, and the cluster's CAN mileage drifts with the engine off
  // -- neither is the odometer, and putting either in the row made the
  // copies look like they disagreed.
  for (const sg of sgbds) {
    const stored = await viReadStoredOdometer(sg, jobsOf.get(sg));
    if (stored != null) {
      col.km = stored;
      break;
    }
  }
  return col;
}

// The stored (non-volatile) odometer for a module, or null. Cluster reads its
// EEPROM; EWS reads its KD block. Both return km. See viReadColumn's note for
// why the stored copy is preferred over any CAN-signal km.
async function viReadStoredOdometer(sgbd, jobs) {
  const has = (name) =>
    Array.isArray(jobs) && jobs.some((j) => j && j.name === name);
  // A cluster that DECLARES its stored odometer is asked for it by name.
  // The EEPROM word below was verified on an E46 cluster only; an E39 IKE
  // also answers EEPROM_LESEN, with a layout nobody has checked, so the
  // declared job goes first wherever one exists.
  {
    const pick = await viPickInfoJob(sgbd, jobs, VI_KM_STORED_ROLE);
    if (pick) {
      try {
        const values = await viRunValues(sgbd, pick.job);
        const v = values.has(pick.result)
          ? Number(String(values.get(pick.result)).trim())
          : NaN;
        if (Number.isFinite(v) && v > 0 && v < 2000000) return v;
      } catch (e) {
        /* fall through to the raw reads */
      }
    }
  }
  if (has('EEPROM_LESEN')) {
    const km = await viReadKmbOdometer(sgbd);
    if (km != null) return km;
  }
  if (has('KD_DATEN_LESEN')) {
    const km = await viReadEwsOdometer(sgbd);
    if (km != null) return km;
  }
  return null;
}

// Cluster stored odometer: EEPROM word 0x28 (4 words read), the mileage is
// bytes 1..3 big-endian km. Verified: 00 05 AE 86 ... -> 0x05AE86 = 372,358
// km, matching the dash. Rejects a blank/implausible read.
async function viReadKmbOdometer(sgbd) {
  try {
    const values = await viRunValues(sgbd, 'EEPROM_LESEN', '0x28;4');
    const bytes = viBytesOf(values.has('DATEN') ? values.get('DATEN') : null);
    if (!bytes || bytes.length < 4) return null;
    const km = (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
    if (km === 0 || km === 0xffffff) return null;
    // an E46 cluster tops out well under 2M km; anything past that is a
    // misread, not an odometer
    if (km > 2000000) return null;
    return km;
  } catch (e) {
    return null;
  }
}

// Read KD block 0 from an EWS and decode the stored odometer (3-byte LE km at
// offset 2). Returns the km number, or null when the module has no such job,
// the block is blank, or the value is implausible.
async function viReadEwsOdometer(sgbd) {
  let jobs;
  try {
    jobs = await viJobs(sgbd);
  } catch (e) {
    return null;
  }
  // viJobs returns [{ name }]; match on the declared job name.
  const hasKd =
    Array.isArray(jobs) && jobs.some((j) => j && j.name === 'KD_DATEN_LESEN');
  if (!hasKd) return null;
  try {
    // BLOCK 0. viRunValues drives the job the same way every other read here
    // does; the block index is the job's single int argument.
    const values = await viRunValues(sgbd, 'KD_DATEN_LESEN', '0');
    const raw = values.has('KD_DATEN') ? values.get('KD_DATEN') : null;
    const bytes = viBytesOf(raw);
    if (!bytes || bytes.length < 5) return null;
    // an all-FF (uninitialised) block carries no odometer
    if (bytes.slice(0, 5).every((b) => b === 0xff)) return null;
    const km = bytes[2] | (bytes[3] << 8) | (bytes[4] << 16);
    // a 3-byte field maxes at ~16.7M km; reject 0 and the all-FF sentinel
    if (km === 0 || km === 0xffffff) return null;
    return km;
  } catch (e) {
    return null;
  }
}

// KD_DATEN comes back the way EDIABAS publishes a binary result: a byte array,
// a "7A-AE-05" hex-dash string, or a plain hex string. Normalise to a number
// array; return null on anything else.
function viBytesOf(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return v.map((x) => Number(x) & 0xff);
  if (v instanceof Uint8Array) return Array.from(v);
  const s = String(v).trim();
  if (/^[0-9a-fA-F]{2}([-\s][0-9a-fA-F]{2})+$/.test(s)) {
    return s.split(/[-\s]+/).map((h) => parseInt(h, 16));
  }
  if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) {
    const out = [];
    for (let i = 0; i < s.length; i += 2)
      out.push(parseInt(s.substr(i, 2), 16));
    return out;
  }
  return null;
}

// The VIN as the car is registered by: a coding SGBD's C_FG_LESEN answers
// with the check character appended (WBAET37495NJ87379 + Q), the diagnostic
// SGBDs without it. The check is verified where the Mod-36 helper is
// loaded, and the body is what the row shows either way.
function viVinBody(v) {
  const s = String(v || '')
    .toUpperCase()
    .replace(/\s/g, '');
  if (!/^[A-Z0-9]{18}$/.test(s)) return s;
  if (typeof CodingEncode !== 'undefined' && CodingEncode.vinCheckChar) {
    try {
      if (CodingEncode.vinCheckChar(s.slice(0, 17)) !== s[17]) return s;
    } catch (e) {
      /* no helper: trust the shape */
    }
  }
  return s.slice(0, 17);
}

// A full 17-char VIN carries the type key at positions 4..7 (WBA AV36 ...).
// A short VIN cannot say; the row stays honest and empty.
function viTypeKey(vin) {
  const v = String(vin || '')
    .toUpperCase()
    .replace(/\s/g, '');
  return /^[A-Z0-9]{17}$/.test(v) ? v.slice(3, 7) : null;
}

// ETK's VIN index resolves even the 7-char short VIN a cluster stores into
// the exact production variant -- model, body, engine -- and vehicles.json
// adds that variant's gearbox. Best-effort: a build without the parts
// catalogue simply leaves those rows empty.
async function viEtkDecode(vin) {
  if (
    typeof loadVinIndex !== 'function' ||
    typeof decodeVin !== 'function' ||
    !vin
  )
    return null;
  try {
    const d = decodeVin(await loadVinIndex(), vin);
    if (!d) return null;
    let gear = null;
    if (typeof loadVehicles === 'function') {
      try {
        const veh = await loadVehicles();
        const rows = ((veh[d.chassis] || {})[d.body] || {})[d.model] || [];
        const hit = rows.find((r) => r[3] === d.mospid);
        if (hit) gear = hit[1];
      } catch (e) {
        /* no gearbox column then */
      }
    }
    return { ...d, gear };
  } catch (e) {
    return null;
  }
}

// The ZST keywords name the body and engine in BMW's own vocabulary.
const VI_BODY_WORDS = {
  LIM: 'Limousine',
  TOUR: 'Touring',
  COUP: 'Coupé',
  CABR: 'Cabrio',
  COMP: 'Compact',
};
const VI_ENGINE_KW = /^[MNSW]\d{2,3}[A-Z]\d{2}/;

// What one column SAYS about the car, decoded from its own record.
function viColInfo(id, col, etk) {
  const sa = col.keys ? VehicleIdentity.saCodesFromZcs(id, col.keys) : null;
  const kws = (sa && sa.keywords) || [];
  const bodyKw = kws.find((k) => VI_BODY_WORDS[k]);
  const engineKw = kws.find((k) => VI_ENGINE_KW.test(k));
  const gearMap = { M: 'Manual', A: 'Automatic' };
  // The type-key row of the ZST names the gearbox too (MAN / AUT beside
  // LIM and S62B50), which is how the original fills the cell without a
  // parts catalogue. ETK, when present, still wins: it knows the exact
  // variant.
  const gearKw = kws.includes('AUT')
    ? 'Automatic'
    : kws.includes('MAN')
      ? 'Manual'
      : null;
  return {
    chassis: (col.fa && col.fa.br) || id,
    model: (etk && etk.model) || null,
    body: (etk && etk.body) || (bodyKw ? VI_BODY_WORDS[bodyKw] : null),
    engine: engineKw || (etk && etk.motor) || null,
    gearbox: etk && etk.gear ? gearMap[etk.gear] || etk.gear : gearKw,
    typeKey: viTypeKey(col.vin) || (col.fa && col.fa.typ) || null,
    sa,
  };
}

// A key rendered the way the original renders it: body, dash, check character.
function viZcsFmt(kind, body) {
  if (!body || typeof CodingZcs === 'undefined') return body || null;
  try {
    const f = CodingZcs['format' + kind](body);
    return `${f.slice(0, -1)}-${f.slice(-1)}`;
  } catch (e) {
    return body;
  }
}

// Parameter table: label column plus one column per master. A row nobody
// answers is dropped; a row the columns DISAGREE on is flagged -- that
// disagreement is the finding this screen exists to surface. Two values are
// compatible when one contains the other (a short VIN inside the full one is
// the same car, not a mismatch). `soft` rows never flag: the odometer copies
// update at different moments and a 1 km skew is normal.
function viNcsTable(cols, rows) {
  let h =
    `<table class="vi-ncs"><thead><tr><th>Parameter</th>` +
    cols.map((c) => `<th>${esc(c.title)}</th>`).join('') +
    `</tr></thead><tbody>`;
  for (const [label, get, soft] of rows) {
    const vals = cols.map(get);
    if (!vals.some(Boolean)) continue;
    const norm = vals
      .filter(Boolean)
      .map((v) => String(v).replace(/\s+/g, '').toUpperCase());
    const compatible = norm.every((a) =>
      norm.every((b) => a.includes(b) || b.includes(a))
    );
    const mism = !soft && !compatible;
    h +=
      `<tr${mism ? ' class="vi-mismatch"' : ''}><td>${esc(label)}</td>` +
      vals.map((v) => `<td class="mono">${v ? esc(v) : '—'}</td>`).join('') +
      `</tr>`;
  }
  return h + `</tbody></table>`;
}

// The decoded option list, one column per master: <0530> Air conditioning.
//
// Two dictionaries name a number. The ETK catalogue has the English name,
// picked by the car's build date because BMW reused numbers (199 changed
// meaning in 1999). The chassis AT table has the SGET keyword the coding
// predicates key on (KLIMAREGELUNG). The name leads; the keyword stays on
// the row, dimmed, because it is what the coding filter actually matches.
function viOptionsBox(id, cols) {
  const lists = cols
    .map((c) => {
      const codes = c.codes || [];
      if (!codes.length) {
        return (
          `<div><h4>${esc(c.title)}</h4>` +
          `<div class="vi-none">No options resolved.</div></div>`
        );
      }
      const date = (c.etk && c.etk.prod) || 0;
      const items = codes
        .map((code) => {
          const kw = VehicleIdentity.saLabel(id, code);
          const name = VehicleIdentity.saName(code, date);
          // numbers are shown four wide (<0205>); an alphanumeric code
          // (<1CA>) is a name, not a number, and is shown as itself
          const shown = /^\d+$/.test(String(code))
            ? String(code).padStart(4, '0')
            : String(code);
          const num = `<span class="mono">&lt;${esc(shown)}&gt;</span>`;
          if (name) {
            return (
              `<li>${num} <span class="vi-opt-name">${esc(name)}</span>` +
              (kw ? ` <span class="vi-opt-kw">${esc(kw)}</span>` : '') +
              `</li>`
            );
          }
          return `<li>${num} ${kw ? esc(kw) : ''}</li>`;
        })
        .join('');
      return `<div><h4>${esc(c.title)}</h4><ul class="vi-opt">${items}</ul></div>`;
    })
    .join('');
  return (
    `<div class="vi-block"><h3>Options</h3>` +
    `<div class="vi-opt-grid" style="--vi-cols:${cols.length}">${lists}</div>` +
    `</div>`
  );
}

// The wait: a read is several jobs against several modules over a slow bus,
// so the pane says what it is doing rather than sitting empty.
function viLoading(text) {
  return (
    `<div class="vi-loading"><span class="wiring-spinner"></span>` +
    `<span>${esc(text)}</span></div>`
  );
}

// The source strip: which ECU answered, and how.
function viSources(entries) {
  if (!entries.length) return '';
  return (
    `<div class="vi-src">` +
    entries
      .map(
        (e) =>
          `<span class="vi-src-i ${e.ok ? 'ok' : 'bad'}">` +
          `<b>${esc(e.sg)}</b> ${esc(e.what)}</span>`
      )
      .join('') +
    `</div>`
  );
}

// ---- which car is plugged in, asked of the car --------------------------------
//
// PA Soft / NCS Expert do not ask the user which chassis it is. They put the
// cluster's own group probe on the wire (D_0080, the same bytecode INPA runs
// on open), read the coding key off whatever cluster answers, and the GM key
// names the car. The chassis tables do the naming here (chassisFromKeys); the
// group probe is the shipped D_0080 / D_0044 bytecode run in the VM, so this
// path has no address or variant list of its own.
//
// Returns { chassis, sgbd, keys, via, type } or throws with a reason the
// screen can print. `via` is 'gm' when the key named the chassis and
// 'config' when only the config membership of the answering SGBD did.
const VI_DETECT_GROUPS = ['d_0080', 'd_0044']; // cluster, then EWS

async function viDetectCar(wait) {
  if (typeof webResolveVariant !== 'function') {
    throw new Error('this build cannot probe the car (no group resolver)');
  }
  let sgbd = null;
  let group = null;
  for (const g of VI_DETECT_GROUPS) {
    wait(`Asking the ${g === 'd_0080' ? 'cluster' : 'EWS'} who it is…`);
    let v;
    try {
      v = await webResolveVariant(g);
    } catch (e) {
      v = null;
    }
    if (v) {
      sgbd = String(v).toLowerCase();
      group = g;
      break;
    }
  }
  if (!sgbd) {
    const why =
      typeof webResolveVariantLast === 'function'
        ? webResolveVariantLast()
        : null;
    throw new Error(
      'neither the cluster (0x80) nor the EWS (0x44) answered its group probe' +
        (why && why.path ? ` (${why.path})` : '')
    );
  }
  wait(`${sgbd.toUpperCase()} answered · reading its coding key…`);
  const jobs = await viJobs(sgbd);
  const zcsJob = await viPickZcsJob(sgbd, jobs);
  if (!zcsJob) {
    throw new Error(`${sgbd} answered but declares no coding-key read`);
  }
  const values = await viRunValues(sgbd, zcsJob.job);
  const keys = viKeysFrom(values, zcsJob.keys);
  if (!keys) {
    throw new Error(`${sgbd}: ${zcsJob.job} returned no valid coding key`);
  }
  // The key names the chassis. A key no table claims falls back to which
  // chassis configs list the answering SGBD -- data too, just weaker: a
  // cluster variant can serve more than one chassis.
  const byKey =
    typeof VehicleIdentity !== 'undefined'
      ? VehicleIdentity.chassisFromKeys(keys)
      : [];
  let listed = [];
  try {
    const ids = await api('/api/chassis');
    const cfgs = await Promise.all(
      (ids || []).map((c) => api(`/api/chassis/${c}`).catch(() => null))
    );
    listed = cfgs
      .filter(Boolean)
      .filter((c) =>
        (c.sections || []).some((sec) =>
          (sec.ecus || []).some(
            (e) => String(e.sgbd || '').toLowerCase() === sgbd
          )
        )
      )
      .map((c) => String(c.id).toUpperCase());
  } catch (e) {
    listed = [];
  }
  const agreed = byKey.filter((c) => listed.includes(c.chassis));
  // WHICH MODULE ANSWERED OUTRANKS WHAT ITS KEY SAYS. A cluster that only
  // one chassis config lists (kombi46r: E46) is the car; its GM key may be
  // stale or unprogrammed on an FA-era car (a 2004 325i answered 00020002,
  // which happens to be an E39 type row) and must not overrule that.
  const pick =
    agreed[0] ||
    (listed.length === 1 ? { chassis: listed[0], viaConfig: true } : null) ||
    byKey[0] ||
    null;
  if (pick && pick.viaConfig) {
    return { chassis: pick.chassis, sgbd, group, keys, via: 'config' };
  }
  if (pick) {
    return {
      chassis: pick.chassis,
      sgbd,
      group,
      keys,
      via: 'gm',
      type: pick.key,
      keywords: pick.keywords,
    };
  }
  throw new Error(
    `no chassis table claims GM ${keys.gm}` +
      (listed.length
        ? ` (the ${sgbd} cluster is listed on ${listed.join(', ')})`
        : '')
  );
}

// The chassis-free entry: identify the car, then show its identity.
async function identifyCar() {
  return showVehicleIdentity(null);
}

// ---- screen ----------------------------------------------------------------

async function showVehicleIdentity(chassisId, opts) {
  // No chassis given: ask the car, then come back here with the answer.
  if (!chassisId) {
    lastScreen = () => showVehicleIdentity(null);
    setCrumbs([{ label: 'Vehicles', fn: showChassis }, { label: 'Identity' }]);
    sbLeft.textContent = 'identifying the car';
    view.innerHTML = head(
      'Identity',
      'Any car',
      'Asks the cluster which car this is, then reads its build record.'
    );
    const panel = document.createElement('div');
    panel.className = 'vi-panel';
    view.appendChild(panel);
    setActions([
      {
        key: '1',
        keyLabel: 'F1',
        label: 'Retry',
        fn: () => showVehicleIdentity(null),
      },
      {
        key: 'Escape',
        keyLabel: 'Esc',
        label: 'Back',
        kind: 'back',
        fn: showChassis,
      },
    ]);
    const pass = (showVehicleIdentity._pass =
      (showVehicleIdentity._pass || 0) + 1);
    const stale = () => showVehicleIdentity._pass !== pass;
    const wait = (text) => {
      if (stale()) return;
      panel.innerHTML = viLoading(text);
      sbLeft.textContent = text;
    };
    if (typeof loadTables === 'function') await loadTables();
    let found;
    try {
      found = await viDetectCar(wait);
    } catch (e) {
      if (stale()) return;
      panel.innerHTML = errorBlock(
        `Could not identify the car: ${esc(e && e.message ? e.message : e)}`
      );
      sbLeft.textContent = 'car not identified';
      return;
    }
    if (stale()) return;
    return showVehicleIdentity(found.chassis, { detected: found });
  }
  const id = String(chassisId || '').toUpperCase();
  const detected = (opts && opts.detected) || null;
  lastScreen = () => showVehicleIdentity(chassisId, opts);
  const back = () =>
    typeof showSections === 'function'
      ? showSections(chassisId)
      : showChassis();
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: dispChassis(chassisId), fn: back },
    { label: 'Identity' },
  ]);
  sbLeft.textContent = `${dispChassis(chassisId)} · identity`;

  view.innerHTML = head(
    'Identity',
    dispChassis(chassisId),
    'What the car reports about its own build, and the equipment that follows ' +
      'from it.'
  );
  const panel = document.createElement('div');
  panel.className = 'vi-panel';
  view.appendChild(panel);

  const acts = [
    {
      key: '1',
      keyLabel: 'F1',
      label: 'Re-read',
      fn: () => showVehicleIdentity(chassisId, opts),
    },
    { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: back },
  ];
  setActions(acts);

  // A re-read while one is running: the older pass must not paint over the
  // newer one when its slower jobs come back.
  const pass = (showVehicleIdentity._pass =
    (showVehicleIdentity._pass || 0) + 1);
  const stale = () => showVehicleIdentity._pass !== pass;
  const wait = (text) => {
    if (stale()) return;
    panel.innerHTML = viLoading(text);
    sbLeft.textContent = text;
  };

  wait('Looking up which modules hold the build record…');
  if (typeof loadTables === 'function') await loadTables();
  if (typeof loadSaNames === 'function') await loadSaNames();

  // Who can answer, asked of the modules themselves.
  const masters = await viIdentityModulesCached(id);
  if (stale()) return;
  if (!masters.length) {
    panel.innerHTML = errorBlock(
      `No control unit on ${esc(dispChassis(chassisId))} declares a job that ` +
        `returns the build record. Without one there is nothing to read.`
    );
    sbLeft.textContent = 'no identity source';
    return;
  }

  // SGFAM's family name, for the column titles and the source strip.
  const fam =
    typeof VehicleIdentity !== 'undefined'
      ? VehicleIdentity.familyMap(id)
      : null;
  const famName = (m) => viFamilyName(fam, m);

  // EVERY master is read, and each keeps its own column -- the copies are the
  // point. A master that answers nothing at all drops out of the table but
  // stays on the source strip, so a dead module is a finding, not a blank.
  const sources = [];
  if (detected) {
    sources.push({
      sg: detected.sgbd.toUpperCase(),
      ok: true,
      what:
        detected.via === 'gm'
          ? `identified ${dispChassis(id)} from its GM key ` +
            `(type ${detected.type}${
              detected.keywords && detected.keywords.length
                ? ': ' + detected.keywords.join(' ')
                : ''
            })`
          : `identified ${dispChassis(id)} by which chassis list ${detected.sgbd}`,
    });
  }
  const cols = [];
  for (let i = 0; i < masters.length; i++) {
    const m = masters[i];
    wait(
      `Reading ${famName(m) || m.label || m.sgbd} ` +
        `(${i + 1} of ${masters.length})…`
    );
    const col = await viReadColumn(m, sources, famName);
    if (stale()) return;
    if (col.keys || col.fa || col.vin || col.km) cols.push(col);
  }

  if (!cols.length) {
    panel.innerHTML =
      errorBlock(
        'No control unit answered with a build record. Check the cable and the ' +
          'ignition (engine off, key on), then re-read.'
      ) + viSources(sources);
    sbLeft.textContent = 'no identity';
    return;
  }

  wait('Decoding the build record…');
  // A module that stores only the 7-char production number (kombi46) cannot
  // say its type key; a sibling holding the full 17-char VIN of THE SAME car
  // (same production number) can say it for both. The rows are still one
  // column per module: nothing else crosses over.
  const fullVinFor = (short) => {
    const s = String(short || '');
    if (s.length >= 17) return s;
    const hit = cols.find(
      (o) => o.vin && String(o.vin).length >= 17 && String(o.vin).endsWith(s)
    );
    return hit ? hit.vin : s;
  };
  for (const col of cols) {
    col.title = famName(col.m) || col.m.label || col.m.sgbd;
    col.etk = await viEtkDecode(col.vin);
    col.info = viColInfo(id, col, col.etk);
    if (!col.info.typeKey && col.vin) {
      col.info.typeKey = viTypeKey(fullVinFor(col.vin));
    }
    col.codes = col.fa
      ? VehicleIdentity.saCodesFromFa(col.fa)
      : (col.info.sa && col.info.sa.codes) || [];
  }

  const kmText = (v) =>
    v == null ? null : /^\d+(\.\d+)?$/.test(String(v)) ? `${v} km` : String(v);

  const infoRows = [
    ['Chassis', (c) => c.info.chassis],
    ['Model', (c) => c.info.model],
    ['Body', (c) => c.info.body],
    ['Engine', (c) => c.info.engine],
    ['Gearbox', (c) => c.info.gearbox],
    ['VIN', (c) => c.vin],
    // the copies update at different moments; a small skew is normal (soft)
    ['Odometer', (c) => kmText(c.km), true],
  ];
  const zcsRows = [
    ['Type-Key', (c) => c.info.typeKey],
    ['ZCS GM', (c) => (c.keys ? viZcsFmt('Gm', c.keys.gm) : null)],
    ['ZCS SA', (c) => (c.keys ? viZcsFmt('Sa', c.keys.sa) : null)],
    ['ZCS VN', (c) => (c.keys ? viZcsFmt('Vn', c.keys.vn) : null)],
    // the FA generation's record, in the same box (NCS titles it ZCS/FA)
    [
      'Order date',
      (c) => (c.fa && c.fa.date ? String(c.fa.date).replace(/^#/, '') : null),
    ],
    ['Paint', (c) => c.fa && c.fa.lack],
    ['Upholstery', (c) => c.fa && c.fa.polster],
  ];

  if (stale()) return;
  panel.innerHTML =
    `<div class="vi-block"><h3>Information about car</h3>` +
    `<div class="vi-ncs-wrap">${viNcsTable(cols, infoRows)}</div></div>` +
    `<div class="vi-block"><h3>ZCS/FA coding</h3>` +
    `<div class="vi-ncs-wrap">${viNcsTable(cols, zcsRows)}</div></div>` +
    viOptionsBox(id, cols) +
    cols
      .filter((c) => c.faRaw)
      .map(
        (c) =>
          `<details class="vi-raw"><summary>Raw order · ${esc(c.title)}` +
          `</summary><code class="mono">${esc(c.faRaw)}</code></details>`
      )
      .join('') +
    viSources(sources);

  const nCodes = Math.max(...cols.map((c) => (c.codes || []).length), 0);
  sbLeft.textContent = nCodes
    ? `${cols.length} module${cols.length === 1 ? '' : 's'} · ${nCodes} option codes`
    : 'identity read';
}

if (typeof window !== 'undefined') {
  window.showVehicleIdentity = showVehicleIdentity;
  window.identifyCar = identifyCar;
  window.chassisHasIdentity = chassisHasIdentity;
  window.readIdentityCodes = readIdentityCodes;
}
