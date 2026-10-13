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
 * @typedef {Map<string, Map<string, string>> & {status: Map<string, ModuleStatus>, mods: CodeableModule[], images: Map<string, CodingImage>, sources: Map<string, CodingSource>}} ScanCache
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
      if (typeof loadTables === 'function') await loadTables();
      // the predicates are written in keyword ids, not catalogue numbers;
      // with no keyword table for the chassis nothing is selected
      const ids = CodingSelect.aswIds(
        id,
        saCodes,
        saCodes.keywords,
        saCodes.time
      );
      if (ids && ids.length) out = CodingSelect.applySelection(id, out, ids);
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
      // The result is an integer, and reads as one: 52 for the light
      // module's index 0x34. (It used to be parsed as hex, which is the same
      // thing up to 9 and a different index from 10 on.) Only text that says
      // it is hex is taken as hex.
      const text = String(res.get(k)).trim();
      const n = /^0x[0-9a-f]+$/i.test(text)
        ? parseInt(text.slice(2), 16)
        : /^\d+$/.test(text)
          ? parseInt(text, 10)
          : NaN;
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

// WHERE A MODULE'S CODING IS READ FROM, by BMW's own tables:
//
//   the coding description      which FILE (KMB_E46) and, by the module's
//   (DATEN map)                 coding index, which variant of it (C08)
//   the selection table (SGET)  for that file and variant, the CODING SGBD
//                               to run jobs on (KOMBI46R -- not the one the
//                               diagnostic side uses) and the coding SCRIPT
//                               (A_KMB46 for a car coded by its central key,
//                               A_AKMB46 for one coded by its vehicle order)
//   the script index            which shipped file holds that script
//
// A module whose description numbers its blocks is not read through its
// script (the address its jobs expect is not established); for those the raw
// block a diagnostic read hands back is used, and it is block 0 only.
/**
 * How one module's coding image is obtained.
 * @typedef {Object} CodingSource
 * @property {'script'|'blob'} route - through the coding script, or the raw
 *   block of the diagnostic read.
 * @property {string} [sgbd] - script route: the coding SGBD.
 * @property {string} [script] - script route: the script's name (A_KMB46).
 * @property {string} [dispatchKey] - script route: the file it ships in.
 * @property {object} [cabd] - script route: the coding description.
 * @property {boolean} [decided] - script route: the car's equipment (or the
 *   table itself) settled WHICH script is this car's. A read does not depend
 *   on it; a write does.
 * @property {string} [why] - when there is no source: the reason, for display.
 */

/** @type {Promise<Record<string, string>|null>|null} script name -> file key */
let _codingScripts = null;
/**
 * The shipped coding scripts, by name.
 * @returns {Promise<Record<string, string>>} name (uppercase) -> file key.
 */
function codingScriptIndex() {
  if (!_codingScripts) {
    _codingScripts = (
      typeof webFetchJson === 'function'
        ? webFetchJson('data/coding-dispatch/scripts.json')
        : api('/data/coding-dispatch/scripts.json')
    )
      .then((d) => d || {})
      .catch(() => ({}));
  }
  return _codingScripts;
}

/**
 * Work out where a module's coding is read from.
 * @param {string} chassisId - chassis id.
 * @param {CodeableModule} m - the module (its diagnostic SGBD).
 * @param {FunctionList} fns - its functions, resolved by coding index.
 * @param {number[]|null} [equipment] - the car's equipment as keyword ids.
 * @returns {Promise<CodingSource|{route: null, why: string}>} the source, or
 *   why there is none.
 */
async function codingSourceOf(chassisId, m, fns, equipment) {
  const none = (why) => ({ route: null, why });
  const cabd = typeof codingCabdOf === 'function' ? codingCabdOf(fns) : null;
  // The index did select a file, but this copy of the coding data has no
  // layout for it: it is an older copy than the code (the data files are
  // served cache-first and catch up on the next load).
  if (!cabd && fns && fns.codingIsResolved)
    return none(
      'the coding data on this device is older than the app: reload the page to update it'
    );
  if (!cabd) return none('its coding index did not select one coding file');
  const numbered =
    cabd.typ === 'BLOCK' ||
    cabd.fields.some((f) => f.block > 0) ||
    cabd.groups.some((g) => g.block > 0);
  if (numbered) return { route: 'blob' };
  const daten = typeof datenFor === 'function' ? await datenFor(m.sgbd) : null;
  const ci = fns.codingIndex;
  const cbd = `C${ci.toString(16).padStart(2, '0')}`.toUpperCase();
  const id = String(chassisId || '').toUpperCase();
  if (typeof loadSget === 'function') await loadSget();
  const all = (typeof window !== 'undefined' && window.BMW_SGET) || {};
  const table = (all[id] && (all[id].rows || all[id])) || [];
  const file = String((daten && daten.daten) || '').toUpperCase();
  const rows = table.filter(
    (r) =>
      String(r.SGNAME || '').toUpperCase() === file &&
      String(r.CBD || '').toUpperCase() === cbd &&
      r.SGBD &&
      r.CABD
  );
  if (!rows.length) return none(`the selection table has no ${file}.${cbd}`);
  const sgbds = [...new Set(rows.map((r) => String(r.SGBD).toLowerCase()))];
  if (sgbds.length !== 1)
    return none(
      `the selection table names ${sgbds.length} coding SGBDs for it`
    );
  // the rows the car's own equipment satisfies, when that is known
  const applies =
    equipment && typeof CodingSelect !== 'undefined'
      ? rows.filter((r) => CodingSelect.rowApplies(r, equipment))
      : [];
  const candidates = applies.length ? applies : rows;
  const names = [
    ...new Set(candidates.map((r) => String(r.CABD).toUpperCase())),
  ];
  const scripts = await codingScriptIndex();
  const script = names.find((n) => scripts[n]);
  if (!script)
    return none(`its coding script ${names.join(' / ')} is not shipped`);
  return {
    route: 'script',
    sgbd: sgbds[0],
    script,
    dispatchKey: scripts[script],
    cabd,
    decided: names.length === 1,
  };
}

/**
 * Read one module's coding image from its source.
 * @param {CodingSource|{route: null}} source - from codingSourceOf.
 * @param {Map<string, string>|null} got - the module's diagnostic read, for
 *   the raw-block route.
 * @returns {Promise<CodingImage|null>} the image, or null when the source
 *   yields none.
 * @throws {Error} when a script read fails.
 */
async function codingReadImage(source, got) {
  if (!source || !source.route) return null;
  if (source.route === 'script') {
    const r = await webReadCoding(source.sgbd, {
      dispatchKey: source.dispatchKey,
      cabd: source.cabd,
    });
    return {
      bytes: r.netto,
      known: new Set(r.read),
      block: null,
      route: 'script',
    };
  }
  // the raw block a diagnostic read returns, under the three names the
  // SGBDs use for it
  const bytes = codBytesOf(
    got && (got.get('COD_DATEN') ?? got.get('CODE') ?? got.get('CODIERDATEN'))
  );
  return bytes ? { bytes, known: null, block: 0, route: 'blob' } : null;
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
  // each module's coding image and where it came from: what the screens show
  // every setting from (see codingImageValue)
  cache.images = new Map();
  cache.sources = new Map();
  const chId = String(chassisId || '').toUpperCase();
  let equipment = null;
  if (saCodes && saCodes.length && typeof CodingSelect !== 'undefined') {
    try {
      if (typeof loadTables === 'function') await loadTables();
      equipment = CodingSelect.aswIds(
        chId,
        saCodes,
        saCodes.keywords,
        saCodes.time
      );
    } catch {
      equipment = null;
    }
  }
  /**
   * Read a module's coding image, recording the source and any failure.
   * @param {CodeableModule} m - the module.
   * @param {Map<string, string>} got - its diagnostic read.
   * @returns {Promise<boolean>} true when an image was read.
   */
  const readImage = async (m, got) => {
    let source;
    try {
      const fns = await moduleFunctions(
        chassisId,
        m.sgbd,
        codingIndexFromScan(cache, m.sgbd)
      );
      source = await codingSourceOf(chassisId, m, fns, equipment);
    } catch (e) {
      source = { route: null, why: String((e && e.message) || e) };
    }
    cache.sources.set(m.sgbd, source);
    try {
      const image = await codingReadImage(source, got);
      if (image) cache.images.set(m.sgbd, image);
      return !!image;
    } catch (e) {
      source.why = String((e && e.message) || e);
      return false;
    }
  };
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
      // No diagnostic coding read. Its coding script may still read it: the
      // coding index comes from the module's identification, and a module
      // that answers that way is present.
      const got = new Map();
      cache.set(m.sgbd, got);
      let image;
      try {
        await scanCodingIndex(m.sgbd, got);
        image = await readImage(m, got);
      } catch {
        image = false;
      }
      if (!image) cache.delete(m.sgbd);
      status.set(
        m.sgbd,
        image ? { state: 'ok', fields: 0 } : { state: 'noread' }
      );
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
      const image = await readImage(m, got);
      status.set(m.sgbd, {
        // an image makes every function at a read address decodable; without
        // one, only what the diagnostic read names
        state: image || n ? 'ok' : 'raw',
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

// These are BMW's SA catalogue numbers (205 automatic, 210 DSC). Module
// selection does not test them directly: an SGET predicate is written in the
// chassis's keyword ids, and CodingSelect.aswIds translates. Two sources, by
// generation:
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
    const codes = ((got && got.codes) || []).slice();
    // the keywords a coding key decodes to ride along (the module-revision
    // stamps among them have no catalogue number, and module selection is
    // decided on exactly those); not enumerable, so the list is still a list
    Object.defineProperty(codes, 'keywords', {
      value: (got && got.keywords) || [],
    });
    // a vehicle order's time criterion (#0904): the order table's row for it
    // is where an order-coded car's revision stamps come from
    Object.defineProperty(codes, 'time', {
      value: (got && got.fa && got.fa.date) || null,
    });
    return codes;
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
  // STILL OFF, for a narrower reason than before.
  //
  // The predicates are written in the ids of the chassis's own keyword table
  // (S37 is AUTOMATIK on the E46), and that numbering is now available:
  // CodingSelect.aswIds turns a car's equipment into it. What this function
  // is HANDED is not that -- `saCodes` here are bit positions of the coding
  // key's option field, 0..63 -- and compared directly, as the code below
  // does, it once hid 37 of 44 modules on a real E46, DSC and the airbag
  // among them.
  //
  // To turn it on: take the equipment from the identity read (catalogue
  // numbers and keywords), pass it through aswIds, evaluate with
  // CodingSelect.rowApplies, and measure on a car before trusting it -- a
  // right mapping hides few modules on a well-equipped car, not most.
  // Failing open costs nothing; failing closed takes real coding away with
  // no way to tell why.
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
  window.codingSourceOf = codingSourceOf;
  window.codingReadImage = codingReadImage;
  window.scanCoding = scanCoding;
  window.readVehicleSaCodes = readVehicleSaCodes;
  window.extractSaCodesFromScan = extractSaCodesFromScan;
  window.filterModulesByFa = filterModulesByFa;
}
