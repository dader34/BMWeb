/**
 * @file Tuning > Read from ECU, part 2 of 2: the wire side. Lists the memory
 * regions a module can read, identifies the module before touching it, walks
 * a region chunk by chunk into one image, and remembers the car. Publishes
 * window.TuningMemory, which the Read from ECU dialog drives.
 *
 * READ ONLY. Every job here is a *_LESEN and is additionally passed through
 * the write classifier (bestvm.js isWriteJob). There is deliberately no write
 * path: writing an ECU's raw memory is how you brick a cluster.
 *
 * Loads after memory-spec.js (the pure helpers it calls).
 */

/**
 * @typedef {Object} TmIdentResult
 * @property {'ok'|'variant'|'silent'|'unmatched'|'refused'|'no-cable'|'error'|'unknown'|'pending'} state
 * @property {string} [variant] - The SGBD the car answered as, when not the one asked for.
 * @property {string|null} [group] - The group SGBD that probed.
 * @property {Object<string, string>} [ident] - IDENT fields that came back.
 * @property {string} [status] - The JOB_STATUS of a refused IDENT.
 * @property {string} [gloss]
 * @property {string} [detail] - Error text.
 */

/** Promise cache for the per-SGBD and per-chassis lookups this file makes. */
const tmCache = new Map();

/**
 * Run `fn` once per key and share the promise; a rejection evicts the entry
 * so the next call retries.
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function tmCached(key, fn) {
  if (tmCache.has(key)) return tmCache.get(key);
  const p = fn().catch((e) => {
    tmCache.delete(key);
    throw e;
  });
  tmCache.set(key, p);
  return p;
}

/**
 * Job names from a /jobs listing, which arrives as strings or {name} objects.
 * @param {(string|{ name?: string })[]|null|undefined} jobs
 * @returns {string[]}
 */
function tmJobNames(jobs) {
  return (jobs || []).map(
    (j) => (typeof j === 'string' ? j : j && j.name) || ''
  );
}

/**
 * Fill a region's selector values from the table its comment names.
 * @param {string} sgbd
 * @param {TmRegion} r
 * @returns {Promise<void>}
 */
async function tmFillSelectorTypes(sgbd, r) {
  if (!r.selArg || r.types.length || !r.selTable) return;
  try {
    const rows = await api(
      `/api/ecu/${sgbd}/table/${encodeURIComponent(r.selTable.table.toUpperCase())}`
    );
    const col = r.selTable.column.toUpperCase();
    r.types = (Array.isArray(rows) ? rows : [])
      .map((row) => {
        const k = Object.keys(row || {}).find((x) => x.toUpperCase() === col);
        return k ? String(row[k]).trim() : '';
      })
      .filter(Boolean);
  } catch (e) {
    /* no table: the selector stays free-form */
  }
}

/**
 * Every readable memory region an ECU declares: profile regions first, then
 * the job specs. Cheap: one small JSON per candidate job, and only for jobs
 * whose NAME already looks like a memory read and which the write classifier
 * scores as a read.
 * @param {string} sgbd
 * @returns {Promise<TmRegion[]>}
 */
async function tmRegionsFor(sgbd) {
  let jobs;
  try {
    jobs = await api(`/api/ecu/${sgbd}/jobs`);
  } catch (e) {
    return tmProfileRegions(sgbd);
  }
  const names = tmJobNames(jobs)
    .filter((n) =>
      /^(EEPROM|ROM|RAM|DPRAM|SPEICHER|FLASH)[A-Z_0-9]*_LESEN/i.test(n)
    )
    .filter((n) => typeof isWriteJob !== 'function' || !isWriteJob(n));
  const out = tmProfileRegions(sgbd);
  for (const n of names) {
    try {
      const spec = await api(
        `/api/ecu/${sgbd}/arguments/${encodeURIComponent(n)}`
      );
      const r = tmRegionFromArgs(n, spec);
      if (!r) continue;
      await tmFillSelectorTypes(sgbd, r);
      try {
        const res = await api(
          `/api/ecu/${sgbd}/results/${encodeURIComponent(n)}`
        );
        r.resultField = tmDataField(
          n,
          Array.isArray(res) ? res : res && res.results
        );
      } catch (e) {
        /* no result spec: DATEN stays the default */
      }
      out.push(r);
    } catch (e) {
      /* no spec: not a region we can bound, skip it */
    }
  }
  return out;
}

/**
 * The SGBD's JobResult rows, for telling an ECU refusal from an SGBD-side
 * argument check. Empty when the module declares none.
 * @param {string} sgbd
 * @returns {Promise<Object[]>}
 */
async function tmJobResultRows(sgbd) {
  return tmCached(`jobresult:${sgbd}`, async () => {
    let names;
    try {
      names = await api(`/api/ecu/${sgbd}/tables`);
    } catch (e) {
      return [];
    }
    const list = Array.isArray(names) ? names : Object.keys(names || {});
    const pick =
      list.find((n) => String(n).toUpperCase() === 'JOBRESULT') ||
      list.find((n) => /JOBRESULT/i.test(n));
    if (!pick) return [];
    try {
      const rows = await api(
        `/api/ecu/${sgbd}/table/${encodeURIComponent(pick)}`
      );
      return Array.isArray(rows) ? rows : [];
    } catch (e) {
      return [];
    }
  });
}

/**
 * Classify a status token against the module's own JobResult table.
 * @param {string} sgbd
 * @param {string} status
 * @returns {Promise<TmStatusInfo>}
 */
async function tmStatusInfo(sgbd, status) {
  const rows = await tmJobResultRows(sgbd).catch(() => []);
  return tmClassifyStatus(status, rows);
}

/**
 * One chunk. `at` is in the region's own address unit (words for a word-
 * addressed EEPROM), `count` in the unit the count argument takes.
 * @param {string} sgbd
 * @param {TmRegion} region
 * @param {number} at
 * @param {number} count
 * @returns {Promise<{ bytes: Uint8Array, arg: string }>}
 * @throws {Error & { jobStatus: string, arg: string, job: string }} When the
 *   job reports anything but OKAY.
 */
async function tmReadChunk(sgbd, region, at, count) {
  const arg = tmChunkArg(region, at, count);
  const d = await api(
    `/api/ecu/${sgbd}/run/${encodeURIComponent(region.job)}?arg=${encodeURIComponent(arg)}`,
    { method: 'POST' }
  );
  const map = new Map(flatResults(d.sets));
  // JOB_STATUS is deliberately stripped by flatResults (core.js), so read it
  // off the raw sets -- checking the flattened map would silently never fire
  // and every refused read would look like an empty region.
  const status = String(tmJobStatus(d.sets) ?? '').trim();
  if (status && !/^OKAY$/i.test(status)) {
    const e = new Error(status);
    e.jobStatus = status;
    e.arg = arg;
    e.job = region.job;
    throw e;
  }
  const field = region.resultField || 'DATEN';
  const raw = map.has(field) ? map.get(field) : map.get('DATEN');
  return { bytes: tmParseBytes(raw), arg };
}

/**
 * Walk a region start..end, one chunk at a time, into one image.
 * @param {string} sgbd
 * @param {TmRegion} region
 * @param {number} start - First address, in the region's address unit.
 * @param {number} endInclusive - Last address.
 * @param {((done: number, total: number, lastArg: string) => boolean|void)|null} onProgress -
 *   Drives the UI; returning false cancels.
 * @param {{ chunk?: number, cap?: number }} [opts] - `chunk` overrides the
 *   region's per-read count; `cap` the size cap.
 * @returns {Promise<{ bytes: Uint8Array, firstArg: string }>}
 * @throws {Error} When the read exceeds the size cap, or a chunk fails.
 */
async function tmReadRange(
  sgbd,
  region,
  start,
  endInclusive,
  onProgress,
  opts
) {
  const o = opts || {};
  const step = Math.max(1, o.chunk || region.max || TM_UNKNOWN_CHUNK);
  const cap =
    o.cap != null
      ? o.cap
      : region.source === 'profile'
        ? Infinity
        : TM_MAX_TOTAL;
  const chunks = [];
  let total = 0;
  let firstArg = '';
  for (let at = start; at <= endInclusive; at += step) {
    const count = Math.min(step, endInclusive - at + 1);
    const { bytes, arg } = await tmReadChunk(sgbd, region, at, count);
    if (!firstArg) firstArg = arg;
    chunks.push(bytes);
    total += bytes.length;
    if (total > cap) throw new Error('read exceeded the size cap');
    // An ECU that answers short is at the end of what it will give up; stop
    // rather than looping to the declared bound collecting empties.
    if (!bytes.length) break;
    if (
      onProgress &&
      onProgress(at - start + count, endInclusive - start + 1, arg) === false
    ) {
      break;
    }
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return { bytes: out, firstArg };
}

// ---- identify -------------------------------------------------------------
// Is the module there, and is it the one named? A group SGBD (D_0012, D_ABSKWP)
// runs its own IDENTIFIKATION bytecode and names the variant at that address
// (group-variant-resolution); silence there IS absence. Without a runnable
// group, the SGBD's own IDENT job is the presence test.

/**
 * Whether the group SGBD ships a runnable probe (data/groups/index.json).
 * @param {string|null} group
 * @returns {Promise<boolean>}
 */
async function tmGroupRunnable(group) {
  if (!group) return false;
  const idx = await tmCached('groups-index', async () => {
    try {
      const r = await fetch('data/groups/index.json');
      return r.ok ? await r.json() : null;
    } catch (e) {
      return null;
    }
  });
  return !!(idx && (idx.groups || []).includes(String(group).toLowerCase()));
}

/** IDENT result fields worth showing beside the module name. */
const TM_IDENT_FIELDS = [
  'ID_BMW_NR',
  'ID_HW_NR',
  'ID_SW_NR',
  'ID_COD_INDEX',
  'ID_DIAG_INDEX',
  'ID_DATUM_KW',
  'ID_DATUM_JAHR',
];

/**
 * Probe through the group SGBD. Returns a final result, or null to fall
 * through to the module's own IDENT (with `viaGroup` telling whether the
 * probe already named this very module).
 * @param {string} key - Lower-cased SGBD.
 * @param {string} g - Lower-cased group.
 * @returns {Promise<{ done: TmIdentResult|null, viaGroup: boolean }>}
 */
async function tmIdentifyViaGroup(key, g) {
  let v;
  try {
    v = await webResolveVariant(g);
  } catch (e) {
    if (/no cable/i.test(String(e.message || e)))
      return { done: { state: 'no-cable' }, viaGroup: false };
    return {
      done: { state: 'error', detail: String(e.message || e) },
      viaGroup: false,
    };
  }
  if (v && String(v).toLowerCase() !== key) {
    return {
      done: { state: 'variant', variant: String(v).toLowerCase(), group: g },
      viaGroup: false,
    };
  }
  if (v) return { done: null, viaGroup: true };
  const last =
    typeof webResolveVariantLast === 'function'
      ? webResolveVariantLast()
      : null;
  const path = last && last.group === g ? last.path : '';
  if (path === 'answered-but-unmatched')
    return { done: { state: 'unmatched', group: g }, viaGroup: false };
  if (path === 'probe-error')
    return {
      done: { state: 'error', group: g, detail: last.error || last.message },
      viaGroup: false,
    };
  if (path === 'bus-silent' || !path)
    return { done: { state: 'silent', group: g }, viaGroup: false };
  // no-probe-shipped: fall through to the SGBD's own IDENT
  return { done: null, viaGroup: false };
}

/**
 * Identify a module before reading it.
 * @param {string} sgbd
 * @param {string|null} group - Its diagnostic group SGBD, when known.
 * @returns {Promise<TmIdentResult>}
 */
async function tmIdentify(sgbd, group) {
  const key = String(sgbd).toLowerCase();
  const g = group ? String(group).toLowerCase() : null;
  let viaGroup = false; // the group probe already named this very module
  // The group probe talks to the bus directly, so without a cable it must
  // not run at all: the IDENT path below goes through api(), which reports
  // no cable honestly.
  const wired =
    typeof webBus === 'undefined' || !webBus || webBus.connected === true;
  if (
    g &&
    wired &&
    typeof webResolveVariant === 'function' &&
    (await tmGroupRunnable(g))
  ) {
    const probe = await tmIdentifyViaGroup(key, g);
    if (probe.done) return probe.done;
    viaGroup = probe.viaGroup;
  }
  let jobs;
  try {
    jobs = await api(`/api/ecu/${key}/jobs`);
  } catch (e) {
    return { state: 'error', detail: String(e.message || e) };
  }
  const names = tmJobNames(jobs).map((n) => String(n).toUpperCase());
  if (!names.includes('IDENT')) {
    return viaGroup
      ? { state: 'ok', ident: {}, group: g }
      : { state: 'unknown' };
  }
  let d;
  try {
    d = await api(`/api/ecu/${key}/run/IDENT`, { method: 'POST' });
  } catch (e) {
    const m = String(e.message || e);
    if (/no cable/i.test(m)) return { state: 'no-cable' };
    if (/IFH-0009|did not answer/i.test(m)) return { state: 'silent' };
    return { state: 'error', detail: m };
  }
  const status = String(tmJobStatus(d.sets) ?? '').trim();
  if (status && !/^OKAY$/i.test(status)) {
    const info = await tmStatusInfo(key, status);
    return { state: 'refused', status, ...info };
  }
  const map = new Map(flatResults(d.sets));
  const ident = {};
  for (const f of TM_IDENT_FIELDS) {
    if (map.has(f) && String(map.get(f)).trim() !== '')
      ident[f] = String(map.get(f)).trim();
  }
  return { state: 'ok', ident };
}

/**
 * What to print for an identify outcome. Pure.
 * @param {string} sgbd
 * @param {TmIdentResult|null} r
 * @returns {string}
 */
function tmIdentText(sgbd, r) {
  const s = sgbd;
  switch (r && r.state) {
    case 'ok': {
      const id = r.ident || {};
      const bits = [];
      if (id.ID_BMW_NR) bits.push(`BMW no. ${id.ID_BMW_NR}`);
      if (id.ID_HW_NR) bits.push(`HW ${id.ID_HW_NR}`);
      if (id.ID_SW_NR) bits.push(`SW ${id.ID_SW_NR}`);
      if (id.ID_DIAG_INDEX) bits.push(`diag ${id.ID_DIAG_INDEX}`);
      return `${s} answered${bits.length ? ': ' + bits.join(' · ') : ''}.`;
    }
    case 'variant':
      return `At this address the car identifies as ${r.variant}, not ${s}.`;
    case 'silent':
      return `${s} did not answer on the bus (no such module on this car, ignition off, or a different variant at this address).`;
    case 'unmatched':
      return `Something answered at ${s}'s address, but it is not a variant this build can read.`;
    case 'refused':
      return `${s} answered IDENT with ${r.status}${r.gloss ? ` — ${r.gloss}` : ''}.`;
    case 'no-cable':
      return 'No cable connected: the module cannot be identified.';
    case 'error':
      return `Could not identify ${s}: ${r.detail || 'probe failed'}.`;
    default:
      return `${s} declares no IDENT job; presence cannot be checked before the read.`;
  }
}

// ---- the car's modules ----------------------------------------------------
// The chassis config lists what this car carries (sgbd + label + group). The
// selection is remembered; failing that, the chassis whose DME the last-opened
// car list aimed the status poll at (autoscan's stateSgbd) is found among the
// shipped configs.

/**
 * Every chassis id the build ships a config for.
 * @returns {Promise<string[]>}
 */
async function tmChassisList() {
  return tmCached('chassis-list', async () => {
    try {
      const ids = await api('/api/chassis');
      return Array.isArray(ids) ? ids : [];
    } catch (e) {
      return [];
    }
  });
}

/**
 * One chassis config, or null when it cannot be fetched.
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
async function tmChassisConfig(id) {
  if (!id) return null;
  return tmCached(`chassis:${String(id).toUpperCase()}`, async () => {
    try {
      return await api(
        `/api/chassis/${encodeURIComponent(String(id).toUpperCase())}`
      );
    } catch (e) {
      return null;
    }
  });
}

/**
 * The chassis to preselect: the remembered one, else the one whose config
 * carries the DME the status poll is aimed at, else ''.
 * @returns {Promise<string>}
 */
async function tmDefaultChassis() {
  const saved =
    typeof Settings !== 'undefined' && Settings && Settings.get
      ? Settings.get('tuningCar', '')
      : '';
  if (saved) return String(saved).toUpperCase();
  const dme =
    typeof stateSgbd === 'string' && stateSgbd ? stateSgbd.toLowerCase() : '';
  if (!dme) return '';
  for (const id of await tmChassisList()) {
    const cfg = await tmChassisConfig(id);
    const has = ((cfg && cfg.sections) || []).some((sec) =>
      (sec.ecus || []).some(
        (e) => String((e && e.sgbd) || '').toLowerCase() === dme
      )
    );
    if (has) return String(id).toUpperCase();
  }
  return '';
}

/**
 * Remember the chassis picked in the dialog.
 * @param {string} id
 * @returns {void}
 */
function tmRememberChassis(id) {
  if (typeof Settings !== 'undefined' && Settings && Settings.set) {
    try {
      Settings.set('tuningCar', String(id || '').toUpperCase());
    } catch (e) {
      /* settings unavailable: the pick still applies for this dialog */
    }
  }
}

if (typeof window !== 'undefined') {
  window.TuningMemory = {
    regionsFor: tmRegionsFor,
    readRange: tmReadRange,
    readChunk: tmReadChunk,
    parseBytes: tmParseBytes,
    identify: tmIdentify,
    identText: tmIdentText,
    statusInfo: tmStatusInfo,
    explainFailure: tmExplainFailure,
    rankModules: tmRankModules,
    chassisList: tmChassisList,
    chassisConfig: tmChassisConfig,
    defaultChassis: tmDefaultChassis,
    rememberChassis: tmRememberChassis,
    MAX_TOTAL: TM_MAX_TOTAL,
    UNKNOWN_CHUNK: TM_UNKNOWN_CHUNK,
    // exported for the unit tests
    _parseRange: tmParseRange,
    _parseCount: tmParseCount,
    _regionFromArgs: tmRegionFromArgs,
    _profileRegions: tmProfileRegions,
    _dataField: tmDataField,
    _memoryKind: tmMemoryKind,
    _classifyStatus: tmClassifyStatus,
    _statusGloss: tmStatusGloss,
    _chunkArg: tmChunkArg,
  };
}
