/**
 * @file Tuning > Read from ECU, part 1 of 2: the pure side -- turning a job's
 * argument spec into a readable memory region, parsing what comes back, and
 * putting a refused read into words. Nothing here touches the wire; every
 * function is unit-tested in tools/verify/test_tuning_memory.js and
 * test_tuning_read.js. memory-read.js drives the bus with these.
 *
 * WHY THIS IS NOT screens/special.js. That one renders INPA's own "Read memory"
 * screen: one 16-byte row at a time, and only for the 266 ECUs that declare
 * such a screen (tools/decompile/ipo_memory.py mined their region tables). Not
 * one E46 module does -- kombi46, zke5, lsz, ews3 all have NO mined regions --
 * yet kombi46 plainly offers EEPROM_LESEN, RAM_LESEN, ROM_LESEN and DPRAM_LESEN
 * as jobs. The capability is there; the screen BMW drew for it is not.
 *
 * WHERE A REGION COMES FROM, in order of trust:
 *   1. A flash profile (core/flasher.js FLASH_PROFILES): a sourced memory map
 *      for a DME family (MS43 calibration at 0x70000, 512 KB AM29F400, ...).
 *   2. The job's OWN argument spec, arguments/<JOB>.json. Many jobs document
 *      their bounds there, e.g. kombi46:
 *        EEPROM_LESEN  ADRESSE  "Hexwert (0x00-0xFF) der WortAdresse ..."
 *                      BYTE_ANZAHL "Anzahl der 2-Byte-Worte (max. 16 Worte = 32 Bytes)"
 *        ROM_LESEN     ADRESSE  "Hexwert (0x0000-0xFFFF) ..."
 *                      BYTE_ANZAHL "Anzahl der Bytes (max. 32 !)"
 *      Note EEPROM_LESEN counts 2-BYTE WORDS and addresses WORDS, while
 *      ROM_LESEN counts BYTES -- the unit is parsed per job, never assumed.
 *   3. Nothing. The job exists but says nothing usable about its bounds
 *      (MS43's "Startadresse High-Middle-Low"). Then the region is shown as
 *      "range not declared" and the user types a start and a length.
 *
 * TWO THINGS THE FIRST VERSION GOT WRONG, and which this file now refuses to:
 *   - "0x000000 - 0xFFFFFF" on 297 SGBDs is the WIDTH OF THE ADDRESS FIELD
 *     (KWP2000 $23 takes a 3-byte address), not a 16 MB memory. It is shown
 *     as a 24-bit address field, never as a size.
 *   - A count comment without "max." was defaulted to 32. dsc_mk60 says
 *     "1 - n ( 4 )": 32 made the SGBD's own argument check refuse the job
 *     (JOB_STATUS = ERROR_NUMBER) before a single byte reached the bus, and
 *     the dialog printed that token as if the DSC had rejected the read. An
 *     unknown chunk is now unknown -- small default, editable, and labelled.
 */

/** Cap for spec-derived and typed spans, in bytes. */
const TM_MAX_TOTAL = 64 * 1024;
/** Per-read count when the job does not say how much one read may return. */
const TM_UNKNOWN_CHUNK = 16;

/**
 * @typedef {Object} TmArgSpec
 * One row of arguments/<JOB>.json as web_export.py writes it.
 * @property {string} ARG - Argument name as the SGBD declares it.
 * @property {string} [ARGTYPE]
 * @property {string} [ARGCOMMENT0] - The author's comment, which carries the bounds.
 */

/**
 * @typedef {Object} TmRange
 * @property {number} lo
 * @property {number} hi
 * @property {number} digits - Hex digits the comment used, i.e. the address width.
 * @property {'declared'|'field'} kind - 'field' when the comment merely spans
 *   the whole address argument (0x0000-0xFFFF), not a real region.
 */

/**
 * @typedef {Object} TmCount
 * @property {number|null} max - Things per read, or null when unknown.
 * @property {boolean} known
 * @property {'word'|'byte'} unit - What the count argument counts.
 * @property {number} wordBytes - Bytes per counted unit (2 for words).
 */

/**
 * @typedef {Object} TmRegion
 * A readable memory region, from a flash profile or a job's argument spec.
 * @property {string} job - The *_LESEN job to run.
 * @property {'profile'|'spec'} source
 * @property {string} kind - Memory kind for the card title (EEPROM, ROM, Flash, ...).
 * @property {number} lo - First address, in the region's own address unit.
 * @property {number|null} hi - Last address, or null when undeclared.
 * @property {'profile'|'declared'|'field'|'unknown'} rangeKind
 * @property {number} addrDigits - Hex digits to send for the address.
 * @property {number} max - Per-read count to offer.
 * @property {boolean} maxKnown - Whether `max` was documented rather than defaulted.
 * @property {'word'|'byte'} unit
 * @property {number} wordBytes
 * @property {string|null} selArg - A leading selector argument (RAM_LESEN "INTERN"/"EXTERN"), if any.
 * @property {string[]} types - Legal selector values.
 * @property {string} [selType] - The selector value the user picked.
 * @property {{ table: string, column: string }|null} [selTable] - Where the
 *   selector's legal values live when the comment names a table.
 * @property {string} [addrArg] - The address argument's real name.
 * @property {string} [lenArg] - The count argument's real name.
 * @property {string[]} order - Argument order as the SGBD declares it.
 * @property {string} [addrComment] - The author's own words for the address.
 * @property {string} [countComment] - The author's own words for the count.
 * @property {string} resultField - The result register carrying the bytes.
 * @property {string} [profile] - Profile id (profile regions).
 * @property {string} [label] - Region label (profile regions).
 * @property {number} [segment] - Flash segment (profile regions).
 * @property {((at: number, count: number) => string)|null} [argFor] - Profile-supplied argument builder.
 * @property {string|null} [locked] - Why the region cannot be read here, or null.
 * @property {boolean} [verified] - Whether the profile is real-car verified.
 */

/**
 * @typedef {Object} TmStatusInfo
 * @property {string} status - The JOB_STATUS token.
 * @property {'ecu'|'sgbd'|'unknown'} origin - Who produced it.
 * @property {string|null} sb - The response byte (ECU) or "?NN?" check code (SGBD).
 * @property {string} gloss - Plain English for the token, '' when none.
 */

/**
 * @typedef {Object} TmFailure
 * What tmExplainFailure needs to phrase a failed read.
 * @property {string} [status]
 * @property {'ecu'|'sgbd'|'unknown'} [origin]
 * @property {string|null} [sb]
 * @property {string} [gloss]
 * @property {string} [arg] - The argument string that was sent.
 * @property {string} [message]
 * @property {string} [sgbd]
 * @property {string} [job]
 * @property {boolean} [noCable]
 * @property {boolean} [silent]
 */

/**
 * @typedef {Object} TmCarModule
 * @property {string} sgbd - Lower-cased SGBD name.
 * @property {string} label
 * @property {string} section - The chassis-config section it sits in.
 * @property {string|null} group - Its diagnostic group SGBD, lower-cased.
 */

// ---------------------------------------------------------------------------
// pure parsing (unit-tested in tools/verify/test_tuning_read.js)
// ---------------------------------------------------------------------------

/**
 * Parse an address range out of an argument comment, e.g. "Hexwert
 * (0x00-0xFF) der WortAdresse" -> { lo: 0, hi: 0xFF, kind, digits }.
 * kind is 'declared' when the comment bounds a real region and 'field' when
 * it merely spans the whole width of the address argument (0x0000-0xFFFF,
 * 0x000000-0xFFFFFF) -- that is the telegram's address field, not a memory
 * map, and the module's real extent is unknown.
 * @param {string|undefined} comment
 * @returns {TmRange|null}
 */
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

/**
 * The number of things one read may return, in the unit the job counts.
 *   "max. 16 Worte = 32 Bytes"        -> { max: 16, unit: 'word', known: true }
 *   "Anzahl der Bytes (max. 32 !)"    -> { max: 32, unit: 'byte', known: true }
 *   "1 - n ( 4 )"                     -> { max: 4 }        dsc_mk60
 *   "1 - 32" / "1 bis 16" / "(2-28)" / "1..249" / "1 -> 32" -> upper bound
 *   "Anzahl der auszulesenden BYTES"  -> { max: null, known: false }
 * An unknown max is reported as unknown, never invented: a guessed 32 is
 * exactly what made dsc_mk60 refuse every read.
 * @param {string|undefined} comment
 * @returns {TmCount}
 */
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

/**
 * Which memory a job reads, from its name. Order matters: DPRAM before RAM,
 * EEPROM before ROM.
 * @param {string} job
 * @returns {string}
 */
function tmMemoryKind(job) {
  const n = String(job || '').toUpperCase();
  if (/EEPROM/.test(n)) return 'EEPROM';
  if (/DPRAM/.test(n)) return 'DPRAM';
  if (/\bRAM|_RAM|^RAM/.test(n)) return 'RAM';
  if (/ROM/.test(n)) return 'ROM';
  if (/FLASH/.test(n)) return 'Flash';
  return 'Memory';
}

/**
 * Address digits to send when the comment does not show them: a DS2 DME
 * documents "Startadresse High-Middle-Low" (three bytes), a KWP2000 `long`
 * address is three bytes too; everything else is a 16-bit address.
 * @param {TmArgSpec|undefined} addrArg
 * @returns {number} Hex digits (4 or 6).
 */
function tmAddrDigits(addrArg) {
  const c = String((addrArg && addrArg.ARGCOMMENT0) || '');
  if (/high\s*-\s*middle\s*-\s*low|24\s*bit/i.test(c)) return 6;
  if (/high\s*-\s*low|16\s*bit/i.test(c)) return 4;
  if (/^long$/i.test(String((addrArg && addrArg.ARGTYPE) || ''))) return 6;
  return 4;
}

/**
 * The "table SpeicherSegment SEG_NAME SEG_TEXT" reference in a selector's
 * comment: the selector's legal values are the named column of that table.
 * @param {TmArgSpec} sel
 * @returns {{ table: string, column: string }|null}
 */
function tmSelectorTable(sel) {
  const t = String(sel.ARGCOMMENT0 || '').match(
    /table\s+([A-Za-z_0-9]+)\s+([A-Za-z_0-9]+)/i
  );
  return t ? { table: t[1], column: t[2] } : null;
}

/**
 * Turn one arguments/<JOB>.json into a region, or null when it is not an
 * address+count read (STEUERN_*, SLEEP_MODE and friends all land here, as do
 * reads that split the address over H_ADR/L_ADR, which this reader does not
 * drive).
 * @param {string} job
 * @param {{ arguments?: TmArgSpec[] }|null|undefined} spec
 * @returns {TmRegion|null}
 */
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
    // tmRegionsFor fills `types` from the named table when the comment
    // quotes no values itself
    selTable: sel ? tmSelectorTable(sel) : null,
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

/**
 * Which result register carries the bytes. results/<JOB>.json arrives as
 * "NAME : comment" lines in the web build or as objects natively; DATEN is
 * the convention, the DS2 DMEs answer in <JOB>_WERT.
 * @param {string} job
 * @param {(string|{ name?: string, RESULT?: string })[]|undefined} results
 * @returns {string}
 */
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

/**
 * Regions a flash profile documents for this SGBD. Single-segment parts only:
 * the two-segment MSx70 full read belongs to ECU Backup. A profile whose DME
 * needs the unlock session is listed but locked, pointing at ECU Backup,
 * because a raw SPEICHER_LESEN on such a DME answers SECURITY_ACCESS_DENIED.
 * @param {string} sgbd
 * @param {Object[]} [profiles] - Defaults to the global FLASH_PROFILES.
 * @returns {TmRegion[]}
 */
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

/**
 * Plain English for the status tokens memory reads produce. The token itself
 * is always shown too; this is the gloss beside it.
 * @type {Object<string, string>}
 */
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

/**
 * The gloss for a status token: the table entry, else an ERROR_ECU_* token
 * spelled out in lower-case words, else ''.
 * @param {string} status
 * @returns {string}
 */
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

/**
 * Where a JOB_STATUS token came from, per the SGBD's own JobResult table.
 * EDIABAS SGBDs use one table for both: rows keyed by a real response byte
 * ("0x31") are what the ECU said; rows keyed "?NN?" are the SGBD's own checks
 * (argument range, telegram shape) and mean NOTHING was sent -- exactly the
 * difference between "the DSC refused" and "we asked wrong".
 * @param {string} status
 * @param {Object[]|undefined} rows - The JobResult table rows.
 * @returns {TmStatusInfo}
 */
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

/**
 * The sentence for a failed read. Pure, so every shape has a test.
 * @param {TmFailure} f
 * @returns {{ headline: string, detail: string }}
 */
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

/**
 * Rank the module list: the ones the car's chassis config lists first, in
 * config order, each with its label and diagnostic group, then everything
 * else sorted.
 * @param {string[]} all - Every SGBD in the build.
 * @param {{ sections?: { name?: string, ecus?: Object[] }[] }|null} chassisCfg
 * @returns {{ car: TmCarModule[], other: string[] }}
 */
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

/**
 * Bytes from a run of hex digits, ignoring separators.
 * @param {string} t
 * @returns {Uint8Array}
 */
function tmHexToBytes(t) {
  const h = t.replace(/[^0-9A-Fa-f]/g, '');
  const n = h.length >> 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

/**
 * DATEN as bytes. It comes back as a hex string ("01 BF 48 ..." /
 * "01BF48..." / "01-BF-48"), a decimal byte list, or -- from the VM directly
 * -- a number array.
 * @param {Uint8Array|number[]|string|null|undefined} s
 * @returns {Uint8Array}
 */
function tmParseBytes(s) {
  if (s instanceof Uint8Array) return s;
  if (Array.isArray(s)) return Uint8Array.from(s.map((v) => Number(v) & 0xff));
  const t = String(s == null ? '' : s).trim();
  if (!t) return new Uint8Array(0);
  if (
    /^[0-9A-Fa-f\s,-]+$/.test(t) &&
    /[A-Fa-f]/.test(t.replace(/[\s,-]/g, ''))
  ) {
    return tmHexToBytes(t);
  }
  // decimal list
  const parts = t.split(/[\s,]+/).filter(Boolean);
  if (parts.length && parts.every((p) => /^\d+$/.test(p) && +p <= 255)) {
    return new Uint8Array(parts.map(Number));
  }
  return tmHexToBytes(t);
}

/**
 * JOB_STATUS, straight off the raw result sets. flatResults() filters this
 * key out on purpose, so anything wanting the ECU's own verdict has to look
 * here.
 * @param {Object[]} sets
 * @returns {string}
 */
function tmJobStatus(sets) {
  const list = typeof dataSets === 'function' ? dataSets(sets) : sets || [];
  for (const s of list || []) {
    if (s && typeof s === 'object' && s.JOB_STATUS != null) return s.JOB_STATUS;
  }
  return '';
}

/**
 * The argument string one chunk sends. `at` is in the region's own address
 * unit, `count` in the unit the count argument takes.
 * @param {TmRegion} region
 * @param {number} at
 * @param {number} count
 * @returns {string}
 */
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
