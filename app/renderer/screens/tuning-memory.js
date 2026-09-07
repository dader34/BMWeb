// Tuning > Read from ECU: pull a live memory image off a module and hand it to
// the hex editor as if it had been loaded from a file.
//
// WHY THIS IS NOT screens/special.js. That one renders INPA's own "Read memory"
// screen: one 16-byte row at a time, and only for the 266 ECUs that declare
// such a screen (tools/decompile/ipo_memory.py mined their region tables). Not
// one E46 module does -- kombi46, zke5, lsz, ews3 all have NO mined regions --
// yet kombi46 plainly offers EEPROM_LESEN, RAM_LESEN, ROM_LESEN and DPRAM_LESEN
// as jobs. The capability is there; the screen BMW drew for it is not.
//
// WHERE A REGION COMES FROM, in order of trust:
//   1. A flash profile (core/flasher.js FLASH_PROFILES): a sourced memory map
//      for a DME family (MS43 calibration at 0x70000, 512 KB AM29F400, ...).
//   2. The job's OWN argument spec, arguments/<JOB>.json. Many jobs document
//      their bounds there, e.g. kombi46:
//        EEPROM_LESEN  ADRESSE  "Hexwert (0x00-0xFF) der WortAdresse ..."
//                      BYTE_ANZAHL "Anzahl der 2-Byte-Worte (max. 16 Worte = 32 Bytes)"
//        ROM_LESEN     ADRESSE  "Hexwert (0x0000-0xFFFF) ..."
//                      BYTE_ANZAHL "Anzahl der Bytes (max. 32 !)"
//      Note EEPROM_LESEN counts 2-BYTE WORDS and addresses WORDS, while
//      ROM_LESEN counts BYTES -- the unit is parsed per job, never assumed.
//   3. Nothing. The job exists but says nothing usable about its bounds
//      (MS43's "Startadresse High-Middle-Low"). Then the region is shown as
//      "range not declared" and the user types a start and a length.
//
// TWO THINGS THE FIRST VERSION GOT WRONG, and which this file now refuses to:
//   - "0x000000 - 0xFFFFFF" on 297 SGBDs is the WIDTH OF THE ADDRESS FIELD
//     (KWP2000 $23 takes a 3-byte address), not a 16 MB memory. It is shown
//     as a 24-bit address field, never as a size.
//   - A count comment without "max." was defaulted to 32. dsc_mk60 says
//     "1 - n ( 4 )": 32 made the SGBD's own argument check refuse the job
//     (JOB_STATUS = ERROR_NUMBER) before a single byte reached the bus, and
//     the dialog printed that token as if the DSC had rejected the read. An
//     unknown chunk is now unknown -- small default, editable, and labelled.
//
// READ ONLY. Every job here is a *_LESEN and is additionally passed through
// the write classifier (bestvm.js isWriteJob). There is deliberately no write
// path: writing an ECU's raw memory is how you brick a cluster.

const TM_MAX_TOTAL = 64 * 1024; // cap for spec-derived and typed spans
const TM_UNKNOWN_CHUNK = 16; // when the job does not say how much per read

// ---------------------------------------------------------------------------
// pure parsing (unit-tested in tools/verify/test_tuning_read.js)
// ---------------------------------------------------------------------------

// "Hexwert (0x00-0xFF) der WortAdresse" -> { lo: 0, hi: 0xFF, kind, digits }
// kind: 'declared' when the comment bounds a real region; 'field' when it
// merely spans the whole width of the address argument (0x0000-0xFFFF,
// 0x000000-0xFFFFFF) -- that is the telegram's address field, not a memory
// map, and the module's real extent is unknown.
function tmParseRange(comment) {
  const m = String(comment || '').match(
    /0x([0-9A-Fa-f]+)\s*(?:-|bis|\.\.)\s*(?:0x)?([0-9A-Fa-f]+)/
  );
  if (!m) return null;
  const lo = parseInt(m[1], 16);
  const hi = parseInt(m[2], 16);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return null;
  const digits = Math.max(m[1].length, m[2].length);
  const allF = /^f+$/i.test(m[2]);
  return {
    lo,
    hi,
    digits,
    kind: lo === 0 && allF ? 'field' : 'declared',
  };
}

// The number of things one read may return, in the unit the job counts.
//   "max. 16 Worte = 32 Bytes"        -> { max: 16, unit: 'word', known: true }
//   "Anzahl der Bytes (max. 32 !)"    -> { max: 32, unit: 'byte', known: true }
//   "1 - n ( 4 )"                     -> { max: 4 }        dsc_mk60
//   "1 - 32" / "1 bis 16" / "(2-28)" / "1..249" / "1 -> 32" -> upper bound
//   "Anzahl der auszulesenden BYTES"  -> { max: null, known: false }
// An unknown max is reported as unknown, never invented: a guessed 32 is
// exactly what made dsc_mk60 refuse every read.
function tmParseCount(comment) {
  const s = String(comment || '');
  const word = /wort|worte/i.test(s);
  let max = null;
  let m;
  if ((m = s.match(/max\.?\s*(\d+)/i))) max = parseInt(m[1], 10);
  else if ((m = s.match(/\bn\s*\(\s*(\d+)\s*\)/i))) max = parseInt(m[1], 10);
  else if (
    (m = s.match(
      /(\d+)\s*(?:\(0x[0-9A-Fa-f]+\))?\s*(?:-|bis|\.\.+|->|und\s*<=)\s*(\d+)/i
    ))
  ) {
    max = parseInt(m[2], 10);
  } else if ((m = s.match(/normal\s+(\d+)/i))) max = parseInt(m[1], 10);
  const known = Number.isFinite(max) && max > 0;
  return {
    max: known ? max : null,
    known,
    unit: word ? 'word' : 'byte',
    wordBytes: word ? 2 : 1,
  };
}

// Which memory a job reads, from its name. Order matters: DPRAM before RAM,
// EEPROM before ROM.
function tmMemoryKind(job) {
  const n = String(job || '').toUpperCase();
  if (/EEPROM/.test(n)) return 'EEPROM';
  if (/DPRAM/.test(n)) return 'DPRAM';
  if (/\bRAM|_RAM|^RAM/.test(n)) return 'RAM';
  if (/ROM/.test(n)) return 'ROM';
  if (/FLASH/.test(n)) return 'Flash';
  return 'Memory';
}

// Address digits to send when the comment does not show them: a DS2 DME
// documents "Startadresse High-Middle-Low" (three bytes), a KWP2000 `long`
// address is three bytes too; everything else is a 16-bit address.
function tmAddrDigits(addrArg) {
  const c = String((addrArg && addrArg.ARGCOMMENT0) || '');
  if (/high\s*-\s*middle\s*-\s*low|24\s*bit/i.test(c)) return 6;
  if (/high\s*-\s*low|16\s*bit/i.test(c)) return 4;
  if (/^long$/i.test(String((addrArg && addrArg.ARGTYPE) || ''))) return 6;
  return 4;
}

// Turn one arguments/<JOB>.json into a region, or null when it is not an
// address+count read (STEUERN_*, SLEEP_MODE and friends all land here, as do
// reads that split the address over H_ADR/L_ADR, which this reader does not
// drive).
function tmRegionFromArgs(job, spec) {
  const args = (spec && spec.arguments) || [];
  const addrs = args.filter((a) =>
    /ADRESSE|ADDRESS|(^|_)ADR$/i.test(a.ARG || '')
  );
  const len = args.find((a) => /ANZAHL|COUNT|LAENGE|LENGTH/i.test(a.ARG || ''));
  if (addrs.length !== 1 || !len) return null;
  const addr = addrs[0];
  const range = tmParseRange(addr.ARGCOMMENT0);
  const count = tmParseCount(len.ARGCOMMENT0);
  // Some reads take a leading selector (RAM_LESEN: "INTERN"/"EXTERN"/"DP_RAM").
  // Its allowed values are quoted in the comment.
  const sel = args.find(
    (a) =>
      a !== addr && a !== len && /TYPE|TYP|BEREICH|SEGMENT/i.test(a.ARG || '')
  );
  const types = sel
    ? (String(sel.ARGCOMMENT0 || '').match(/"([A-Z_0-9]+)"/g) || []).map((s) =>
        s.replace(/"/g, '')
      )
    : [];
  return {
    job,
    source: 'spec',
    kind: tmMemoryKind(job),
    lo: range ? range.lo : 0,
    hi: range ? range.hi : null,
    rangeKind: range ? range.kind : 'unknown',
    addrDigits: range ? range.digits : tmAddrDigits(addr),
    max: count.known ? count.max : TM_UNKNOWN_CHUNK,
    maxKnown: count.known,
    unit: count.unit,
    wordBytes: count.wordBytes,
    selArg: sel ? sel.ARG : null,
    types,
    // "table SpeicherSegment SEG_NAME SEG_TEXT": the selector's legal values
    // are the named column of that table; tmRegionsFor fills `types` from it
    selTable: sel
      ? (() => {
          const t = String(sel.ARGCOMMENT0 || '').match(
            /table\s+([A-Za-z_0-9]+)\s+([A-Za-z_0-9]+)/i
          );
          return t ? { table: t[1], column: t[2] } : null;
        })()
      : null,
    // the ACTUAL names this job gave its address and count args -- SPEICHER_LESEN
    // calls the count ANZAHL, EEPROM_LESEN calls it BYTE_ANZAHL. tmReadChunk must
    // fill them by these names, not a hardcoded pair, or the count comes out
    // blank and the ECU gets ";0x0000" (empty count) and refuses the read.
    addrArg: addr.ARG,
    lenArg: len.ARG,
    // argument order as the SGBD declares it, so the ";" string is built right
    order: args.map((a) => a.ARG),
    // the SGBD's own words, shown on the card so the user reads what the
    // author wrote rather than what this parser made of it
    addrComment: String(addr.ARGCOMMENT0 || ''),
    countComment: String(len.ARGCOMMENT0 || ''),
    resultField: 'DATEN',
  };
}

// Which result register carries the bytes. results/<JOB>.json arrives as
// "NAME : comment" lines in the web build or as objects natively; DATEN is
// the convention, the DS2 DMEs answer in <JOB>_WERT.
function tmDataField(job, results) {
  const names = (results || [])
    .map((r) =>
      typeof r === 'string'
        ? r.split(':')[0].trim()
        : String((r && (r.name || r.RESULT)) || '')
    )
    .filter(Boolean);
  const up = names.map((n) => n.toUpperCase());
  if (up.includes('DATEN')) return 'DATEN';
  const wert = names.find((n) => /_WERT$/i.test(n));
  if (wert) return wert;
  const data = names.find((n) => /DATEN|DATA/i.test(n) && !/ASCII/i.test(n));
  return data || 'DATEN';
}

// Regions a flash profile documents for this SGBD. Single-segment parts only:
// the two-segment MSx70 full read belongs to ECU Backup. A profile whose DME
// needs the unlock session is listed but locked, pointing at ECU Backup,
// because a raw SPEICHER_LESEN on such a DME answers SECURITY_ACCESS_DENIED.
function tmProfileRegions(sgbd, profiles) {
  const list = Array.isArray(profiles)
    ? profiles
    : typeof FLASH_PROFILES !== 'undefined'
      ? FLASH_PROFILES
      : [];
  const out = [];
  for (const p of list) {
    if (!p || String(p.sgbd || '').toLowerCase() !== String(sgbd).toLowerCase())
      continue;
    const rj = p.readJob || {};
    const locked = p.security && p.security.kind && p.security.kind !== 'none';
    for (const reg of p.regions || []) {
      const parts = reg.parts || [];
      if (parts.length !== 1) continue;
      const part = parts[0];
      out.push({
        job: rj.name,
        source: 'profile',
        profile: p.id,
        label: reg.label || reg.name,
        kind: 'Flash',
        lo: part.start,
        hi: part.end,
        rangeKind: 'profile',
        addrDigits: 6,
        max: rj.chunk || TM_UNKNOWN_CHUNK,
        maxKnown: !!rj.chunk,
        unit: 'byte',
        wordBytes: 1,
        selArg: null,
        types: [],
        order: [],
        segment: part.segment,
        argFor:
          typeof rj.arg === 'function'
            ? (at, count) => rj.arg(part.segment, at, count)
            : null,
        resultField: rj.result || 'DATEN',
        locked: locked
          ? 'needs the unlock session: use Apps > ECU Backup'
          : null,
        verified: !!p.verified,
      });
    }
  }
  return out;
}

// Plain English for the status tokens memory reads produce. The token itself
// is always shown too; this is the gloss beside it.
const TM_STATUS_GLOSS = {
  ERROR_NUMBER: 'byte count out of the range the job allows',
  ERROR_NUMBER_ARGUMENT: 'wrong number of arguments',
  ERROR_RANGE_ARGUMENT: 'an argument is out of range',
  ERROR_ADDRESS: 'address out of the range the job allows',
  ERROR_SEGMENT: 'unknown memory segment',
  ERROR_DATA_OUT_OF_RANGE: 'address or length out of range',
  ERROR_ECU_REJECTED: 'the module rejected the request',
  ERROR_ECU_NACK: 'the module answered NACK',
  ERROR_ECU_GENERAL_REJECT: 'the module rejected the request',
  ERROR_ECU_SERVICE_NOT_SUPPORTED:
    'this module does not support memory reads over diagnostics',
  ERROR_ECU_SUBFUNCTION_NOT_SUPPORTED__INVALID_FORMAT:
    'the module does not accept this request format',
  ERROR_ECU_REQUEST_OUT_OF_RANGE:
    'address or length outside what the module allows',
  ERROR_ECU_CANNOT_UPLOAD_FROM_SPECIFIED_ADDRESS:
    'the module will not read from this address',
  ERROR_ECU_CANNOT_UPLOAD_NUMBER_OF_BYTES_REQUESTED:
    'too many bytes per read for this module',
  ERROR_ECU_SECURITY_ACCESS_DENIED__SECURITY_ACCESS_REQUESTED:
    'this memory needs security access (an unlock session)',
  ERROR_ECU_SECURITY_ACCESS_DENIED:
    'this memory needs security access (an unlock session)',
  ERROR_ECU_CONDITIONS_NOT_CORRECT:
    'the module is not in a state that allows this (ignition, engine running)',
  ERROR_ECU_CONDITIONS_NOT_CORRECT_OR_REQUEST_SEQUENCE_ERROR:
    'the module is not in a state that allows this, or expects another request first',
  ERROR_ECU_BUSY_REPEAT_REQUEST: 'the module is busy; try again',
  ERROR_ECU_SERVICE_NOT_SUPPORTED_IN_ACTIVE_DIAGNOSTIC_MODE:
    'not allowed in the current diagnostic mode',
  ERROR_ECU_UNKNOWN_STATUSBYTE:
    'the answer had an unrecognised status byte (often no or a garbled answer)',
  ERROR_ECU_INCORRECT_RESPONSE_ID: 'the answer did not match the request',
  ERROR_ECU_INCORRECT_LEN: 'the answer had the wrong length',
  ERROR_ECU_NO_RESPONSE: 'the module did not answer',
  ERROR_ECU_PARAMETER: 'the module refused a parameter',
  ERROR_ECU_FUNCTION: 'the module refused the function',
  ERROR_BIN_BUFFER: 'the answer did not fit the buffer',
  BUSY: 'the module is busy; try again',
};

function tmStatusGloss(status) {
  const s = String(status || '')
    .trim()
    .toUpperCase();
  if (TM_STATUS_GLOSS[s]) return TM_STATUS_GLOSS[s];
  if (/^ERROR_ECU_/.test(s))
    return s
      .replace(/^ERROR_ECU_/, '')
      .replace(/_+/g, ' ')
      .toLowerCase();
  return '';
}

// Where a JOB_STATUS token came from, per the SGBD's own JobResult table.
// EDIABAS SGBDs use one table for both: rows keyed by a real response byte
// ("0x31") are what the ECU said; rows keyed "?NN?" are the SGBD's own checks
// (argument range, telegram shape) and mean NOTHING was sent -- exactly the
// difference between "the DSC refused" and "we asked wrong".
//   -> { origin: 'ecu' | 'sgbd' | 'unknown', sb, gloss }
function tmClassifyStatus(status, rows) {
  const s = String(status || '').trim();
  const gloss = tmStatusGloss(s);
  const row = (rows || []).find(
    (r) =>
      r &&
      String(r.STATUS_TEXT || r.TEXT || '')
        .trim()
        .toUpperCase() === s.toUpperCase()
  );
  if (!row) return { status: s, origin: 'unknown', sb: null, gloss };
  const sb = String(row.SB || row.STATUS || '').trim();
  return {
    status: s,
    origin: /^\?/.test(sb) ? 'sgbd' : 'ecu',
    sb,
    gloss,
  };
}

// The sentence for a failed read. `f` = { status, origin, sb, gloss, arg,
// message, sgbd, job }. Pure, so every shape has a test.
function tmExplainFailure(f) {
  const sgbd = f.sgbd || 'the module';
  const arg = f.arg ? ` · sent ${f.arg}` : '';
  const msg = String(f.message || '');
  if (f.noCable || /no cable/i.test(msg)) {
    return {
      headline: 'No cable connected.',
      detail: 'Connect the cable and try again.',
    };
  }
  if (f.silent || /IFH-0009|did not answer/i.test(msg)) {
    return {
      headline: `${sgbd} did not answer on the bus.`,
      detail:
        'No such module on this car, ignition off, or a different variant at this address.',
    };
  }
  if (f.status) {
    const gloss = f.gloss ? ` — ${f.gloss}` : '';
    if (f.origin === 'sgbd') {
      return {
        headline: `The ${f.job || 'read'} job refused its arguments before transmitting (${f.status}${gloss}).`,
        detail: `Nothing was sent to the car${arg}. Adjust the start, length or chunk size.`,
      };
    }
    if (f.origin === 'ecu') {
      return {
        headline: `${sgbd} rejected the read (${f.status}${gloss}).`,
        detail: `Negative response ${f.sb}${arg}.`,
      };
    }
    return {
      headline: `The read did not succeed (${f.status}${gloss}).`,
      detail: arg ? `Sent ${f.arg}.` : '',
    };
  }
  return {
    headline: msg || 'The read failed.',
    detail: arg ? `Sent ${f.arg}.` : '',
  };
}

// Rank the module list: the ones the car's chassis config lists first, in
// config order, each with its label and diagnostic group, then everything else.
//   -> { car: [{ sgbd, label, section, group }], other: [sgbd] }
function tmRankModules(all, chassisCfg) {
  const car = [];
  const seen = new Set();
  const pool = new Set((all || []).map((s) => String(s).toLowerCase()));
  for (const sec of (chassisCfg && chassisCfg.sections) || []) {
    for (const e of sec.ecus || []) {
      const sgbd = String((e && e.sgbd) || '').toLowerCase();
      if (!sgbd || seen.has(sgbd)) continue;
      if (pool.size && !pool.has(sgbd)) continue;
      seen.add(sgbd);
      car.push({
        sgbd,
        label: e.label || e.code || sgbd,
        section: sec.name || '',
        group: e.group ? String(e.group).toLowerCase() : null,
      });
    }
  }
  const other = (all || [])
    .map((s) => String(s))
    .filter((s) => !seen.has(s.toLowerCase()))
    .sort();
  return { car, other };
}

// DATEN comes back as a hex string ("01 BF 48 ..." / "01BF48..." / "01-BF-48"),
// a decimal byte list, or -- from the VM directly -- a number array.
function tmParseBytes(s) {
  if (s instanceof Uint8Array) return s;
  if (Array.isArray(s)) return Uint8Array.from(s.map((v) => Number(v) & 0xff));
  const t = String(s == null ? '' : s).trim();
  if (!t) return new Uint8Array(0);
  if (
    /^[0-9A-Fa-f\s,-]+$/.test(t) &&
    /[A-Fa-f]/.test(t.replace(/[\s,-]/g, ''))
  ) {
    const h = t.replace(/[^0-9A-Fa-f]/g, '');
    const n = h.length >> 1;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
  }
  // decimal list
  const parts = t.split(/[\s,]+/).filter(Boolean);
  if (parts.length && parts.every((p) => /^\d+$/.test(p) && +p <= 255)) {
    return new Uint8Array(parts.map(Number));
  }
  const h = t.replace(/[^0-9A-Fa-f]/g, '');
  const n = h.length >> 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

// JOB_STATUS, straight off the raw result sets. flatResults() filters this key
// out on purpose, so anything wanting the ECU's own verdict has to look here.
function tmJobStatus(sets) {
  const list = typeof dataSets === 'function' ? dataSets(sets) : sets || [];
  for (const s of list || []) {
    if (s && typeof s === 'object' && s.JOB_STATUS != null) return s.JOB_STATUS;
  }
  return '';
}

// The argument string one chunk sends. `at` is in the region's own address
// unit, `count` in the unit the count argument takes.
function tmChunkArg(region, at, count) {
  if (typeof region.argFor === 'function') return region.argFor(at, count);
  const hexAddr =
    '0x' +
    at
      .toString(16)
      .toUpperCase()
      .padStart(region.addrDigits || (region.hi > 0xff ? 4 : 2), '0');
  const order = region.order || [];
  const addrArg =
    region.addrArg || order.find((a) => /ADRESSE|ADDRESS/i.test(a || ''));
  const lenArg =
    region.lenArg || order.find((a) => /ANZAHL|COUNT|LAENGE/i.test(a || ''));
  const vals = {};
  if (addrArg) vals[addrArg] = hexAddr;
  if (lenArg) vals[lenArg] = String(count);
  if (region.selArg)
    vals[region.selArg] = region.selType || (region.types || [])[0] || '';
  return order.map((a) => (vals[a] != null ? vals[a] : '')).join(';');
}

// ---------------------------------------------------------------------------
// wire
// ---------------------------------------------------------------------------

const tmCache = new Map();
async function tmCached(key, fn) {
  if (tmCache.has(key)) return tmCache.get(key);
  const p = fn().catch((e) => {
    tmCache.delete(key);
    throw e;
  });
  tmCache.set(key, p);
  return p;
}

// Every readable memory region an ECU declares: profile regions first, then
// the job specs. Cheap: one small JSON per candidate job, and only for jobs
// whose NAME already looks like a memory read and which the write classifier
// scores as a read.
async function tmRegionsFor(sgbd) {
  let jobs;
  try {
    jobs = await api(`/api/ecu/${sgbd}/jobs`);
  } catch (e) {
    return tmProfileRegions(sgbd);
  }
  const names = (jobs || [])
    .map((j) => (typeof j === 'string' ? j : j && j.name) || '')
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
      if (r.selArg && !r.types.length && r.selTable) {
        try {
          const rows = await api(
            `/api/ecu/${sgbd}/table/${encodeURIComponent(r.selTable.table.toUpperCase())}`
          );
          const col = r.selTable.column.toUpperCase();
          r.types = (Array.isArray(rows) ? rows : [])
            .map((row) => {
              const k = Object.keys(row || {}).find(
                (x) => x.toUpperCase() === col
              );
              return k ? String(row[k]).trim() : '';
            })
            .filter(Boolean);
        } catch (e) {
          /* no table: the selector stays free-form */
        }
      }
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

// The SGBD's JobResult rows, for telling an ECU refusal from an SGBD-side
// argument check. Empty when the module declares none.
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

async function tmStatusInfo(sgbd, status) {
  const rows = await tmJobResultRows(sgbd).catch(() => []);
  return tmClassifyStatus(status, rows);
}

// One chunk. `at` is in the region's own address unit (words for a word-
// addressed EEPROM), `count` in the unit the count argument takes.
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

// Walk a region start..end, one chunk at a time, into one image.
// `onProgress(done, total, lastArg)` drives the UI; returning false cancels.
// opts.chunk overrides the region's per-read count; opts.cap the size cap.
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
//   -> { state: 'ok'|'variant'|'silent'|'unmatched'|'refused'|'no-cable'|
//               'error'|'unknown', variant?, ident?, status?, detail? }
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

const TM_IDENT_FIELDS = [
  'ID_BMW_NR',
  'ID_HW_NR',
  'ID_SW_NR',
  'ID_COD_INDEX',
  'ID_DIAG_INDEX',
  'ID_DATUM_KW',
  'ID_DATUM_JAHR',
];

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
    let v;
    try {
      v = await webResolveVariant(g);
    } catch (e) {
      if (/no cable/i.test(String(e.message || e)))
        return { state: 'no-cable' };
      return { state: 'error', detail: String(e.message || e) };
    }
    if (v && String(v).toLowerCase() !== key) {
      return { state: 'variant', variant: String(v).toLowerCase(), group: g };
    }
    if (v) viaGroup = true;
    if (!v) {
      const last =
        typeof webResolveVariantLast === 'function'
          ? webResolveVariantLast()
          : null;
      const path = last && last.group === g ? last.path : '';
      if (path === 'answered-but-unmatched')
        return { state: 'unmatched', group: g };
      if (path === 'probe-error')
        return { state: 'error', group: g, detail: last.error || last.message };
      if (path === 'bus-silent' || !path) return { state: 'silent', group: g };
      // no-probe-shipped: fall through to the SGBD's own IDENT
    }
  }
  let jobs;
  try {
    jobs = await api(`/api/ecu/${key}/jobs`);
  } catch (e) {
    return { state: 'error', detail: String(e.message || e) };
  }
  const names = (jobs || []).map((j) =>
    String((typeof j === 'string' ? j : j && j.name) || '').toUpperCase()
  );
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

// What to print for an identify outcome. Pure.
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
