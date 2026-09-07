/**
 * @file The coding scan: which modules of a chassis can be coded, which
 * variant of each the car actually carries, and what each one is coded to
 * right now. Everything the coding screens draw is seeded from here.
 */

/**
 * A module the coding hub can show, with its kind: 'values' (the SGBD names
 * its coding -- editable read) or 'map' (BMW's DATEN description of the blob
 * -- reference).
 * @typedef {Object} CodeableModule
 * @property {string} sgbd - the module (retargeted when the car named a variant).
 * @property {string} label - display label.
 * @property {string} [group] - the diagnostic-address group.
 * @property {string} [section] - the chassis section it was listed under.
 * @property {'values'|'map'} kind - how its coding can be shown.
 * @property {SlotSelection} [select] - the SGET selection, when equipment codes decided.
 * @property {'identified'|'confirmed'|'unverified'|'sole'|'unbuilt'} [_codingVariant]
 *   - what the bus said about the variant.
 * @property {string} [_variantOf] - the configured name, when it was replaced.
 * @property {string} [_variantVia] - the variant the car named but this build cannot decode.
 * @property {ModuleStatus} [coding] - the scan's status, once filtered by it.
 */

/**
 * How one module answered the coding scan.
 * @typedef {Object} ModuleStatus
 * @property {'ok'|'raw'|'noread'|'silent'} state - answered with decodable
 *   fields / with only a raw blob / has no read job / did not answer.
 * @property {number} [fields] - how many decodable fields it answered with.
 * @property {string} [job] - its JOB_STATUS, when it answered.
 * @property {string} [error] - why it was silent.
 */

/**
 * The scan result: sgbd -> its flattened read results, plus per-module
 * status and the RESOLVED module list every consumer works from.
 * @typedef {Map<string, Map<string, string>> & {status: Map<string, ModuleStatus>, mods: CodeableModule[]}} ScanCache
 */

/**
 * Codeable modules per chassis + equipment, cached for the session.
 * @type {Map<string, CodeableModule[]>}
 */
const _codeableCache = new Map();

/**
 * Every module of a chassis whose coding the app can show, with its kind.
 * The cache key carries the equipment, because selection depends on it: the
 * same chassis resolves to different modules on different cars.
 * @param {string} chassisId - chassis id.
 * @param {string[]} [saCodes] - the car's equipment codes, when known.
 * @returns {Promise<CodeableModule[]>} the modules ([] when the chassis is unknown).
 */
async function codeableModules(chassisId, saCodes) {
  const id = String(chassisId || '').toUpperCase();
  const key = `${id}|${(saCodes || []).join(',')}`;
  if (_codeableCache.has(key)) return _codeableCache.get(key);
  let ch;
  try {
    ch = await api(`/api/chassis/${id}`);
  } catch {
    return [];
  }
  const seen = new Set();
  const all = [];
  for (const s of ch.sections || []) {
    for (const e of s.ecus) {
      if (seen.has(e.sgbd)) continue;
      seen.add(e.sgbd);
      all.push({ ...e, section: s.name });
    }
  }
  const kinds = await Promise.all(
    all.map(async (e) => {
      if (typeof codingFor === 'function' && (await codingFor(e.sgbd)))
        return 'values';
      if (typeof datenFor === 'function' && (await datenFor(e.sgbd)))
        return 'map';
      return null;
    })
  );
  let out = all.map((e, i) => ({ ...e, kind: kinds[i] })).filter((e) => e.kind);

  // WHICH VARIANT OF EACH MODULE THIS CAR ACTUALLY HAS.
  //
  // The chassis config names one module per slot, but a slot is filled by
  // different hardware across the build: E46's cluster is C_KMB46 early and
  // KOMBI46R after the redesign, and an M3 uses a different coding file again.
  // BMW answers that from the VEHICLE ORDER -- every SGET row carries a
  // predicate over the car's equipment codes, and the first row that holds
  // wins. That is what NCS Expert does, and CodingSelect does the same.
  //
  // Only with equipment codes in hand: without them there is nothing to
  // evaluate and the config's own name stands.
  if (saCodes && saCodes.length && typeof CodingSelect !== 'undefined') {
    try {
      if (typeof loadSget === 'function') await loadSget();
      out = CodingSelect.applySelection(id, out, saCodes);
    } catch (e) {
      /* no SGET for this chassis: keep the config's names */
    }
  }

  _codeableCache.set(key, out);
  return out;
}

/**
 * The ambiguous-group table, when the app exposes one.
 * @returns {Promise<Record<string, unknown>|null>} group -> variants, or null.
 */
const _codingGroupNames = () =>
  typeof groupNames === 'function' ? groupNames() : Promise.resolve(null);

// ASK THE CAR WHICH VARIANT EACH MODULE IS, before reading its coding.
//
// applySelection above is BMW's own method and it is right, but it reasons
// from the VEHICLE ORDER -- it needs SA codes, and it never touches the wire.
// The bus knows better: a diagnostic address is shared, and running the
// group's IDENTIFIKATION is what says which of the candidates is actually
// fitted. On a real E46, EDIABAS answered ews3 where the config says ews,
// kombi46r where it says kombi46, and ihka46_3 where it says ihka38 -- three
// wrong coding maps out of fifteen modules.
//
// That matters more here than anywhere else in the app. A coding read still
// ANSWERS on the wrong variant (same address, same job name), so the bytes
// look fine and only the bit-to-meaning mapping is wrong -- and a write is a
// delta spliced onto that image, so a wrong map changes a bit nobody chose.
// assertResolvedForWrite cannot catch it: that guard checks the coding INDEX
// within one SGBD's own DATEN, and never consults the bus.
/**
 * Ask the bus which variant each module is, retargeting `sgbd` where the car
 * named a variant this build can decode. Sets `_codingVariant` on each
 * module ('identified' | 'confirmed' | 'unverified' | 'sole' | 'unbuilt') and
 * `_variantOf` (the configured name) when replaced.
 * @param {CodeableModule[]} mods - the modules, mutated in place.
 * @returns {Promise<CodeableModule[]>} the same array.
 */
async function codingResolveVariants(mods) {
  if (typeof webResolveVariant !== 'function') return mods;
  const amb = await _codingGroupNames();
  const cache = new Map();
  for (const m of mods) {
    const g = String(m.group || '').toLowerCase();
    if (!g) {
      m._codingVariant = 'sole';
      continue;
    }
    // a group that can name only one variant has nothing to resolve
    if (amb && !amb[g]) {
      m._codingVariant = 'sole';
      continue;
    }
    if (!cache.has(g)) {
      let v;
      try {
        v = await webResolveVariant(g);
      } catch {
        v = null;
      }
      cache.set(g, v);
    }
    const via = cache.get(g);
    if (!via) {
      m._codingVariant = 'unverified';
      continue;
    }
    if (via === String(m.sgbd).toLowerCase()) {
      m._codingVariant = 'confirmed';
      continue;
    }
    // The car named a DIFFERENT variant. Retarget only when this build has a
    // coding map for it -- otherwise the module is present but undecodable
    // here, which is a different statement from "wrong map applied".
    const entry = typeof codingFor === 'function' ? await codingFor(via) : null;
    const daten =
      !entry && typeof datenFor === 'function' ? await datenFor(via) : null;
    if (!entry && !daten) {
      m._codingVariant = 'unbuilt';
      m._variantVia = via;
      continue;
    }
    m._variantOf = m.sgbd;
    m.sgbd = via;
    m.kind = entry ? 'values' : 'map';
    m._codingVariant = 'identified';
  }
  return mods;
}

// "Has a read job" is not "has fields". Verified against a real E46: zke5
// declares 41 fields and answers with a single raw COD_DATEN blob; szm46
// declares 1 and answers with raw CODE bytes. Rendering a module's toggles off
// a map it did not fill would show 41 switches backed by nothing, every one of
// them a default rather than the car. A module like that is readable but not
// editable, and has to say so.
/**
 * How many of a module's declared fields the coding read actually named.
 * @param {CodingMapEntry|null} entry - the module's coding map entry.
 * @param {Map<string, string>|null|undefined} got - its flattened read.
 * @returns {number} the count of decodable fields (0 = raw blob only).
 */
function codingDecoded(entry, got) {
  if (!got || !got.size) return 0;
  const names = new Set(((entry && entry.fields) || []).map((f) => f.name));
  let n = 0;
  for (const k of got.keys()) if (names.has(k)) n++;
  return n;
}

// A module that answered with decodable fields is editable. One that answered
// with only a raw blob (zke5's COD_DATEN, szm46's CODE) is present but has no
// decoder here, so it is kept and marked rather than shown as toggles it
// cannot back. One that never answered is dropped: on a real car that is
// almost always hardware this car does not carry.
/**
 * The modules this car actually has, out of the ones the chassis map lists.
 * @param {CodeableModule[]} mods - the modules.
 * @param {ScanCache|null|undefined} scan - the scan.
 * @returns {CodeableModule[]} the present modules, each with `coding` set;
 *   the input unchanged for pre-scan callers.
 */
function codingPresent(mods, scan) {
  const status = (scan && scan.status) || new Map();
  if (!status.size) return mods; // pre-scan callers: unchanged
  return mods
    .map((m) => ({ ...m, coding: status.get(m.sgbd) || { state: 'silent' } }))
    .filter((m) => m.coding.state === 'ok' || m.coding.state === 'raw');
}

/**
 * The result names that carry a coding index, in the order
 * {@link codingIndexFromScan} reads them. Declared once so the scan can ask
 * "did the read already give me one?" with the same vocabulary.
 * @type {string[]}
 */
const CI_RESULTS = [
  'ID_COD_INDEX',
  'CODIER_INDEX',
  'CODIERINDEX',
  'COD_INDEX',
  'ID_CODIERINDEX',
];

/** Jobs that expose the coding index when the coding read does not. */
const CI_JOBS = ['C_CI_LESEN', 'IDENT'];

/**
 * Job names per SGBD, cached per session.
 * @type {Map<string, Promise<string[]>>}
 */
const _codJobNames = new Map();

/**
 * Job names one SGBD declares. Used only to avoid running a job the module
 * does not have -- a 404 there is noise, not information.
 * @param {string} sgbd - the module.
 * @returns {Promise<string[]>} the job names ([] on any failure).
 */
function codingJobNames(sgbd) {
  const key = String(sgbd).toLowerCase();
  if (!_codJobNames.has(key)) {
    _codJobNames.set(
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
  return _codJobNames.get(key);
}

/**
 * The ECU's coding index (Cxx), read from the scan. INPA returns it as
 * ID_COD_INDEX / CODIER_INDEX alongside the coding read; it's the number after
 * the "C" in the variant key (C06 -> 6).
 * @param {ScanCache|Map<string, Map<string, string>>|null|undefined} scan - the scan.
 * @param {string} sgbd - the module.
 * @returns {number|null} the index, or null when the scan didn't name it
 *   (offline, or a module that doesn't report it).
 */
function codingIndexFromScan(scan, sgbd) {
  const res = scan && scan.get(String(sgbd).toLowerCase());
  if (!res) return null;
  for (const k of CI_RESULTS) {
    if (res.has(k)) {
      const n = parseInt(String(res.get(k)).replace(/^0x/i, ''), 16);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

// THE CODING INDEX, WHICH THE READ JOB USUALLY DOES NOT RETURN. Only 3 of 29
// coding modules name it in their own read; ZKE5's COD_LESEN hands back the
// raw COD_DATEN blob and nothing else. The index is what picks which DATEN
// variant describes those bytes (ZKE5 ships C01/C02/C04/C05+C06), and
// codDatenField only trusts a field when the index selected it -- so without
// this EVERY curated feature decoded as "unknown" and drew as an empty toggle,
// on a car that had answered perfectly well.
//
// 23 more modules expose it on IDENT (or C_CI_LESEN). One extra read per
// module, and only when the coding read did not already carry it.
/**
 * Fill in the coding index from IDENT / C_CI_LESEN when the coding read did
 * not carry it.
 * @param {string} sgbd - the module.
 * @param {Map<string, string>} got - its flattened coding read, mutated.
 * @returns {Promise<void>} resolves once an index is found or both jobs tried.
 */
async function scanCodingIndex(sgbd, got) {
  if (CI_RESULTS.some((k) => got.has(k))) return;
  for (const j of CI_JOBS) {
    try {
      const names = await codingJobNames(sgbd);
      if (!names.includes(j)) continue;
      const idr = await api(`/api/ecu/${sgbd}/run/${j}`, {
        method: 'POST',
      });
      for (const [k, v] of flatResults(idr.sets)) {
        if (CI_RESULTS.includes(k) && !got.has(k)) got.set(k, v);
      }
      if (CI_RESULTS.some((k) => got.has(k))) break;
    } catch {
      /* no index from this job: try the next */
    }
  }
}

// THE STATUS IS THE POINT. This used to swallow every failure and return only
// what answered, so with no cable the cache came back EMPTY and the editor
// still drew every toggle -- at library defaults, indistinguishable from the
// car's real settings. Coding writes are a delta against what was read, so a
// phantom baseline makes the diff meaningless. Now each module records whether
// it answered, and with how many decodable fields, and the caller shows only
// what the car really has.
/**
 * Scan the car's coding: read every codeable module's coding job once.
 * @param {string} chassisId - chassis id.
 * @param {HTMLElement} host - where the progress bar paints.
 * @param {string[]} [saCodes] - the car's equipment codes, when known.
 * @returns {Promise<ScanCache>} values per module, status per module, and
 *   the resolved module list.
 */
async function scanCoding(chassisId, host, saCodes) {
  const mods = await codingResolveVariants(
    await codeableModules(chassisId, saCodes)
  );
  const cache = /** @type {ScanCache} */ (new Map());
  const status = new Map();
  cache.status = status;
  // the RESOLVED modules, so every consumer works from the variants the car
  // named rather than re-deriving the config's guess (see showExpertCoding)
  cache.mods = mods;
  const total = mods.length;
  const paint = (done, name) => {
    host.innerHTML =
      `<div class="coding-scan">` +
      `<div class="coding-scan-title">Reading the car…</div>` +
      `<div class="coding-scan-bar"><span style="width:` +
      `${Math.round((100 * done) / Math.max(1, total))}%"></span></div>` +
      `<div class="coding-scan-mod mono">${esc(name || '')}` +
      ` · ${done}/${total} modules</div></div>`;
  };
  paint(0, '');
  for (let i = 0; i < mods.length; i++) {
    const m = mods[i];
    paint(i, m.label);
    const entry =
      typeof codingFor === 'function' ? await codingFor(m.sgbd) : null;
    if (!entry || !entry.read) {
      // described by DATEN only: nothing to read, so nothing to stage against
      status.set(m.sgbd, { state: 'noread' });
      continue;
    }
    try {
      const d = await api(`/api/ecu/${m.sgbd}/run/${entry.read}`, {
        method: 'POST',
      });
      const got = new Map(flatResults(d.sets));
      await scanCodingIndex(m.sgbd, got);
      const n = codingDecoded(entry, got);
      cache.set(m.sgbd, got);
      status.set(m.sgbd, {
        state: n ? 'ok' : 'raw',
        fields: n,
        // an ECU that answers a coding read with an error status is present but
        // refusing -- not the same as absent, and worth saying differently
        job: String(got.get('JOB_STATUS') || ''),
      });
    } catch (e) {
      // No answer. On a real car this is overwhelmingly a module the car does
      // not have (the E46 map lists SMG2, RDC, DWA, mirror memory... for cars
      // that carry them); it can also be one that is asleep or on another bus,
      // which is why this is recorded rather than assumed to mean "not fitted".
      status.set(m.sgbd, {
        state: 'silent',
        error: String((e && e.message) || e),
      });
    }
  }
  paint(total, '');
  return cache;
}

// These are BMW's SA catalogue numbers (205 automatic, 210 DSC), the namespace
// every SGET predicate is written against. Two sources, by generation:
//
//   the vehicle order (FA)  E60+   its `$` tokens ARE catalogue numbers
//   the coding key (ZCS)    older  bit indices, translated through BMW's own
//                                  ZST + AT tables (see core/vehicle-identity.js)
/**
 * THE CAR'S OWN EQUIPMENT CODES, read before anything else.
 * @param {string} chassisId - chassis id.
 * @returns {Promise<string[]>} the codes, or [] when the car will not say --
 *   no cable, no identity module, or a key whose bits carry no catalogue
 *   number. That is not a failure: callers treat an empty list as "nothing
 *   known", which leaves the configured module names in place rather than
 *   selecting on a guess.
 */
async function readVehicleSaCodes(chassisId) {
  if (
    typeof showVehicleIdentity !== 'function' ||
    typeof VehicleIdentity === 'undefined'
  )
    return [];
  try {
    const got = await readIdentityCodes(chassisId);
    return (got && got.codes) || [];
  } catch (e) {
    return [];
  }
}

/** Modules that commonly hold the ZCS keys (KMB / IKE / kombi). */
const ZCS_MODULES = ['kmb', 'ike', 'kombi', 'ih'];
/** Result names an SA key is published under. */
const ZCS_SA_RESULTS = ['SA_SCHLUESSEL', 'SA_WERT', 'ZCS_SA'];

/**
 * Extract SA codes (bit indices) from the scan's ZCS read results, for the
 * field-level FA/ZCS filter.
 * @param {ScanCache|null|undefined} scan - the scan.
 * @returns {string[]|null} the codes, or null when no module carried a
 *   usable SA key.
 */
function extractSaCodesFromScan(scan) {
  if (!scan || typeof CodingZcs === 'undefined') return null;

  for (const mod of ZCS_MODULES) {
    const res = scan.get(mod) || scan.get(mod + '46');
    if (!res) continue;

    for (const k of ZCS_SA_RESULTS) {
      if (res.has(k)) {
        const val = String(res.get(k)).replace(/^0x/i, '').replace(/\s/g, '');
        // SA body is 16 hex chars; with check digit it's 17
        const body = val.length >= 16 ? val.slice(0, 16) : null;
        // an all-FF / all-00 body is an erased or "no special equipment" key,
        // not a bitfield -- decoding it would invent ~60 phantom SA codes
        if (
          body &&
          /^[0-9A-F]{16}$/i.test(body) &&
          !CodingZcs.isBlankKeyBody(body)
        ) {
          return CodingZcs.extractSaCodes(body);
        }
      }
    }
  }

  return null;
}

// FA/ZCS MODULE FILTER. BMW's SGET rows say which ECUs a chassis CAN carry;
// each row's AUFTRAGSAUSDRUCK is a boolean expression over the car's equipment
// codes deciding whether THIS car carries it. Evaluating it is what turns
// "every module an E46 could ever have" into "the modules in front of you".
//
// This filters MODULES, not fields. SGET is the ECU-selection table -- field
// visibility is a different mechanism, and the old field-level `asw` matcher
// never had data behind it (BMW's DATEN carries no asw column, so it passed
// everything through and did nothing).
//
// FAIL OPEN, ALWAYS. No SGET for the chassis, no SA codes read from the car,
// or a module SGET simply does not mention -> SHOW IT. A filter that hides a
// module the car really has is worse than one that shows a spare: the user
// loses access to real coding with no way to tell why. Only an explicit
// predicate that evaluates FALSE against known codes hides anything.
/**
 * Drop modules the car's equipment codes say it does not carry. DISABLED
 * PENDING THE ASW MAPPING: returns the input unchanged (see the note inside).
 * @param {string} chassisId - chassis id.
 * @param {CodeableModule[]} mods - the modules.
 * @param {string[]|null} saCodes - the car's SA codes (bit indices).
 * @returns {Promise<CodeableModule[]>} the modules to show.
 */
async function filterModulesByFa(chassisId, mods, saCodes) {
  // DISABLED PENDING THE ASW MAPPING -- do not turn on without it.
  //
  // The predicates are real and the evaluator is verified (439 SGET rows,
  // 508/508 parse; test_coding_auftrag.js). What is missing is the NUMBERING
  // BRIDGE between the two sides:
  //
  //   CodingZcs.extractSaCodes() yields BIT INDICES of the 64-bit ZCS SA
  //   field -- 0..63, and only ever 0..63.
  //   SGET predicates reference BMW's SA CATALOG numbers -- observed 2..512
  //   across the shipped corpus, 304 distinct.
  //
  // Those are different numbering systems. Comparing them directly is not a
  // near-miss, it is a category error: measured on real E46 data it hid 37 of
  // 44 modules, including DSC and airbag. Failing open here costs nothing
  // (the user sees the same list as before); failing closed silently removes
  // real coding from a real car.
  //
  // To finish: BMW resolves codes through the chassis dictionaries
  // (<BR>AT.000 / AT.M00 / ZST.000, which we DO ship -- see E46AT.000,
  // E46ZST.*) in coapiGetAswFromAuftrag, building the ASW bit-vector the
  // predicates are actually written against. Parse those into a
  // bit-index -> SA-code map, map extractSaCodes() through it, then delete
  // this early return and re-run the measurement above: a correct mapping
  // should hide few modules on a well-equipped car, not most of them.
  return mods;

  /* eslint-disable no-unreachable */
  if (!saCodes || !saCodes.length) return mods; // nothing to test against
  if (typeof loadSget !== 'function' || typeof CodingAuftrag === 'undefined')
    return mods;
  try {
    await loadSget();
  } catch {
    return mods;
  }
  const all = (typeof window !== 'undefined' && window.BMW_SGET) || null;
  const ch = all && all[String(chassisId || '').toUpperCase()];
  if (!ch || !ch.rows || !ch.rows.length) return mods;

  // sgbd -> its rows (a module can appear once per coding index)
  const bySgbd = new Map();
  for (const r of ch.rows) {
    const k = String(r.SGBD || '').toLowerCase();
    if (!k) continue;
    if (!bySgbd.has(k)) bySgbd.set(k, []);
    bySgbd.get(k).push(r);
  }

  return mods.filter((m) => {
    const rows = bySgbd.get(String(m.sgbd || '').toLowerCase());
    if (!rows || !rows.length) return true; // not in SGET: fail open
    // ANY row passing means the car can carry this module (rows are per
    // coding index / build variant, and only one needs to apply).
    return rows.some((r) => {
      if (!r.exprHex) return true;
      try {
        const bytes = r.exprHex.match(/../g).map((h) => parseInt(h, 16));
        return CodingAuftrag.matchesAuftrag(bytes, saCodes);
      } catch {
        return true; // unreadable predicate: fail open
      }
    });
  });
  /* eslint-enable no-unreachable */
}

// The pieces the other coding screens call; published explicitly so the
// shared surface is visible.
if (typeof window !== 'undefined') {
  window.codeableModules = codeableModules;
  window.codingResolveVariants = codingResolveVariants;
  window.codingDecoded = codingDecoded;
  window.codingPresent = codingPresent;
  window.codingJobNames = codingJobNames;
  window.codingIndexFromScan = codingIndexFromScan;
  window.scanCoding = scanCoding;
  window.readVehicleSaCodes = readVehicleSaCodes;
  window.extractSaCodesFromScan = extractSaCodesFromScan;
  window.filterModulesByFa = filterModulesByFa;
}
