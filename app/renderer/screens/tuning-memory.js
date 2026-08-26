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
// SO THE REGIONS COME FROM THE JOB'S OWN ARGUMENT SPEC, not from a mined
// screen. Every one of these jobs documents its own bounds, in its own
// arguments/<JOB>.json, e.g. kombi46:
//
//   EEPROM_LESEN  ADRESSE  "Hexwert (0x00-0xFF) der WortAdresse ..."
//                 BYTE_ANZAHL "Anzahl der 2-Byte-Worte (max. 16 Worte = 32 Bytes)"
//   ROM_LESEN     ADRESSE  "Hexwert (0x0000-0xFFFF) ..."
//                 BYTE_ANZAHL "Anzahl der Bytes (max. 32 !)"
//
// Note EEPROM_LESEN counts 2-BYTE WORDS and addresses WORDS, while ROM_LESEN
// counts BYTES -- so a reader that assumed one unit would silently produce a
// dump at the wrong scale. The unit is parsed per job, never assumed.
//
// READ ONLY. Every job here is a *_LESEN, which the write classifier
// (bestvm.js isWriteJob) scores as a read, so none of this touches the write
// gate. There is deliberately no write path: writing an ECU's raw memory is
// how you brick a cluster, and it needs a car in front of you to test.

const TM_MAX_TOTAL = 64 * 1024;    // refuse absurd spans; real regions are far smaller

// A region parsed out of one job's argument spec.
//   { job, addrArg, lenArg, lo, hi, max, unit, wordBytes, needsType, types }
// `unit` is what BYTE_ANZAHL counts: 'byte' or 'word'.

// "Hexwert (0x00-0xFF) der WortAdresse" -> { lo: 0, hi: 0xFF }
function tmParseRange(comment) {
  const m = String(comment || '').match(
    /0x([0-9A-Fa-f]+)\s*-\s*(?:0x)?([0-9A-Fa-f]+)/);
  if (!m) return null;
  const lo = parseInt(m[1], 16);
  const hi = parseInt(m[2], 16);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return null;
  return { lo, hi };
}

// "max. 16 Worte = 32 Bytes" -> { max: 16, unit: 'word', wordBytes: 2 }
// "Anzahl der Bytes (max. 32 !)" -> { max: 32, unit: 'byte', wordBytes: 1 }
function tmParseCount(comment) {
  const s = String(comment || '');
  const word = /wort|worte/i.test(s);
  // the first "max. N" is the count in the unit the job actually takes
  const m = s.match(/max\.?\s*(\d+)/i);
  const max = m ? parseInt(m[1], 10) : (word ? 16 : 32);
  return { max: Math.max(1, max), unit: word ? 'word' : 'byte',
           wordBytes: word ? 2 : 1 };
}

// Turn one arguments/<JOB>.json into a region, or null when it is not an
// address+count read (STEUERN_*, SLEEP_MODE and friends all land here).
function tmRegionFromArgs(job, spec) {
  const args = (spec && spec.arguments) || [];
  const addr = args.find(a => /ADRESSE|ADDRESS/i.test(a.ARG || ''));
  const len = args.find(a => /ANZAHL|COUNT|LAENGE/i.test(a.ARG || ''));
  if (!addr || !len) return null;
  const range = tmParseRange(addr.ARGCOMMENT0);
  if (!range) return null;
  const count = tmParseCount(len.ARGCOMMENT0);
  // Some reads take a leading selector (RAM_LESEN: "INTERN"/"EXTERN"/"DP_RAM").
  // Its allowed values are quoted in the comment.
  const sel = args.find(a => a !== addr && a !== len
                        && /TYPE|TYP|BEREICH/i.test(a.ARG || ''));
  const types = sel
    ? (String(sel.ARGCOMMENT0 || '').match(/"([A-Z_0-9]+)"/g) || [])
        .map(s => s.replace(/"/g, ''))
    : [];
  return {
    job,
    lo: range.lo, hi: range.hi,
    max: count.max, unit: count.unit, wordBytes: count.wordBytes,
    selArg: sel ? sel.ARG : null, types,
    // the ACTUAL names this job gave its address and count args -- SPEICHER_LESEN
    // calls the count ANZAHL, EEPROM_LESEN calls it BYTE_ANZAHL. tmReadChunk must
    // fill them by these names, not a hardcoded pair, or the count comes out
    // blank and the ECU gets ";0x0000" (empty count) and refuses the read.
    addrArg: addr.ARG, lenArg: len.ARG,
    // argument order as the SGBD declares it, so the ";" string is built right
    order: args.map(a => a.ARG),
  };
}

// Every readable memory region an ECU declares. Cheap: one small JSON per
// candidate job, and only for jobs whose NAME already looks like a memory read.
async function tmRegionsFor(sgbd) {
  let jobs = [];
  try { jobs = await api(`/api/ecu/${sgbd}/jobs`); } catch (e) { return []; }
  const names = (jobs || [])
    .map(j => (typeof j === 'string' ? j : (j && j.name)) || '')
    .filter(n => /^(EEPROM|ROM|RAM|DPRAM|SPEICHER)[A-Z_]*_LESEN/i.test(n)
              || /^SPEICHER_LESEN/i.test(n));
  const out = [];
  for (const n of names) {
    try {
      const spec = await api(`/api/ecu/${sgbd}/arguments/${encodeURIComponent(n)}`);
      const r = tmRegionFromArgs(n, spec);
      if (r) out.push(r);
    } catch (e) { /* no spec: not a region we can bound, skip it */ }
  }
  return out;
}

// DATEN comes back as a hex string ("01 BF 48 ..." or "01BF48..."); some ECUs
// hand back decimal byte lists instead. Accept both, ignore anything else.
function tmParseBytes(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return new Uint8Array(0);
  if (/^[0-9A-Fa-f\s,]+$/.test(t) && /[A-Fa-f]/.test(t.replace(/[\s,]/g, ''))) {
    const h = t.replace(/[^0-9A-Fa-f]/g, '');
    const n = h.length >> 1;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
  }
  // decimal list
  const parts = t.split(/[\s,]+/).filter(Boolean);
  if (parts.length && parts.every(p => /^\d+$/.test(p) && +p <= 255)) {
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
  const list = (typeof dataSets === 'function') ? dataSets(sets) : (sets || []);
  for (const s of (list || [])) {
    if (s && typeof s === 'object' && s.JOB_STATUS != null) return s.JOB_STATUS;
  }
  return '';
}

// One chunk. `at` is in the region's own address unit (words for a word-
// addressed EEPROM), `count` in the unit BYTE_ANZAHL takes.
async function tmReadChunk(sgbd, region, at, count) {
  const hexAddr = '0x' + at.toString(16).toUpperCase()
    .padStart(region.hi > 0xFF ? 4 : 2, '0');
  // fill by the job's OWN arg names -- SPEICHER_LESEN calls its count ANZAHL,
  // EEPROM_LESEN calls it BYTE_ANZAHL. Hardcoding one pair left the other blank
  // and sent the ECU an empty count (";0x0000"). Prefer the names the region
  // resolved from the spec; fall back to matching them out of `order` (same
  // rule as tmRegionFromArgs) so a region built without them still works.
  const order = region.order || [];
  const addrArg = region.addrArg
    || order.find(a => /ADRESSE|ADDRESS/i.test(a || ''));
  const lenArg = region.lenArg
    || order.find(a => /ANZAHL|COUNT|LAENGE/i.test(a || ''));
  const vals = {};
  if (addrArg) vals[addrArg] = hexAddr;
  if (lenArg) vals[lenArg] = String(count);
  if (region.selArg) vals[region.selArg] = region.selType || (region.types[0] || '');
  const arg = order.map(a => vals[a] != null ? vals[a] : '').join(';');
  const d = await api(
    `/api/ecu/${sgbd}/run/${encodeURIComponent(region.job)}?arg=${encodeURIComponent(arg)}`,
    { method: 'POST' });
  const map = new Map(flatResults(d.sets));
  // JOB_STATUS is deliberately stripped by flatResults (core.js:177), so read
  // it off the raw sets -- checking the flattened map would silently never
  // fire and every refused read would look like an empty region.
  const status = String(tmJobStatus(d.sets) ?? '').trim();
  if (status && !/^OKAY$/i.test(status)) {
    const e = new Error(status);
    e.jobStatus = status;
    e.arg = arg;
    throw e;
  }
  // The shim badges synthesized responses with demo:true precisely so they
  // "can't pass for real" (core.js:135). Carry it up: a dump of invented bytes
  // that looks like a genuine EEPROM read is the worst thing this tool could
  // produce, because nothing about the hex says it is fiction.
  return { bytes: tmParseBytes(map.get('DATEN')), arg, demo: !!d.demo };
}

// Walk a region start..end, one max-sized chunk at a time, into one image.
// `onProgress(done, total, lastArg)` drives the UI; returning false cancels.
async function tmReadRange(sgbd, region, start, endInclusive, onProgress) {
  const step = region.max;
  const chunks = [];
  let total = 0;
  let firstArg = '';
  let demo = false;
  for (let at = start; at <= endInclusive; at += step) {
    const count = Math.min(step, endInclusive - at + 1);
    const { bytes, arg, demo: chunkDemo } = await tmReadChunk(sgbd, region, at, count);
    if (!firstArg) firstArg = arg;
    if (chunkDemo) {
      // One synthesized chunk means there is no car answering. Stop at once
      // rather than paging the whole region collecting made-up bytes.
      demo = true;
      chunks.push(bytes);
      total += bytes.length;
      break;
    }
    chunks.push(bytes);
    total += bytes.length;
    if (total > TM_MAX_TOTAL) throw new Error('read exceeded the size cap');
    // An ECU that answers short is at the end of what it will give up; stop
    // rather than looping to the declared bound collecting empties.
    if (!bytes.length) break;
    if (onProgress && onProgress(at - start + count, endInclusive - start + 1, arg) === false) {
      break;
    }
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return { bytes: out, firstArg, demo };
}

if (typeof window !== 'undefined') {
  window.TuningMemory = {
    regionsFor: tmRegionsFor,
    readRange: tmReadRange,
    readChunk: tmReadChunk,
    parseBytes: tmParseBytes,
    // exported for the unit test
    _parseRange: tmParseRange,
    _parseCount: tmParseCount,
    _regionFromArgs: tmRegionFromArgs,
  };
}
