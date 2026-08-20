// Synthetic readings so the UI can be walked with no car attached: reads each
// job's declared results from the shipped metadata and invents a plausible
// number per unit.
//
// OPT-IN ONLY. A diagnostic tool must never invent values mistakable for the
// car's — hence demo:true badging and the fault-job special-case below.

const WEB_DEMO_STATES = ['ein', 'aus', 'aktiv', 'bereit', 'nicht aktiv'];

// i mod n, FOLDED so it never snaps: plain `i % n` jumps n-1 back to 0 on a
// drifting seed (a gauge falling off a cliff every n reads). Fold walks
// 0..n-1..0 so each shape wanders inside its band.
function tri(i, n) {
  const t = ((i % (n * 2)) + (n * 2)) % (n * 2);
  return t < n ? t : (n * 2) - 1 - t;
}

// unit -> a believable idling-engine value, so gauges sit mid-scale
const WEB_DEMO_SHAPES = [
  [/\bU\/min|1\/min|rpm\b/i, (i) => String(760 + tri(i, 40))],
  [/°C/i, (i) => String(82 + tri(i, 8))],
  [/\bkm\/h\b/i, () => '0'],
  [/\bV\b/, (i) => (13.8 + tri(i, 5) * 0.05).toFixed(2)],
  [/\bA\b/, (i) => (2.4 + tri(i, 7) * 0.1).toFixed(1)],
  [/%/, (i) => String(12 + tri(i, 70))],
  [/\bmbar|hPa\b/i, (i) => String(980 + tri(i, 40))],
  [/\bbar\b/i, (i) => (3.4 + tri(i, 6) * 0.1).toFixed(1)],
  [/\bms\b/i, (i) => (3.1 + tri(i, 9) * 0.2).toFixed(1)],
  [/\bNm\b/i, (i) => String(40 + tri(i, 60))],
  [/\bmg\/(hub|stk)\b/i, (i) => String(180 + tri(i, 60))],
  [/\bohm\b/i, (i) => String(8 + tri(i, 4))],
  [/°KW|Kurbelwelle/i, (i) => String(-20 + tri(i, 40))],
];

// "0x5B" / "91" -> the plain number an actuator readback would report
function webDemoEcho(arg) {
  const s = String(arg).split(';')[0].trim();
  if (/^0x[0-9a-f]+$/i.test(s)) return String(parseInt(s.slice(2), 16));
  return /^-?\d+$/.test(s) ? String(parseInt(s, 10)) : s;
}

// `i` drifts once a second so gauges animate; `steady` removes the drift.
// ANYTHING DISCRETE USES steady: a lamp or coding flag that flips every second
// reads as a fault, not a moving measurement. Numbers drift; words and flags hold.
function webDemoValue(name, desc, i, steady) {
  if (steady == null) steady = i;
  // _TEXT / _EINH carriers read as words, not numbers
  if (/_TEXT\d*$/i.test(name)) {
    return WEB_DEMO_STATES[steady % WEB_DEMO_STATES.length];
  }
  // a _EINH carrier ALREADY KNOWS ITS UNIT (BMW writes it as the comment); a
  // flat "%" mislabels every gauge on MSD80's VANOS page.
  if (/_EINH\d*$/i.test(name)) {
    const u = (desc || '').trim();
    // ...but a short German placeholder (MS45's "Messwert") is not a unit
    if (/^(messwert|wert|text|einheit|status|kein[e]?)$/i.test(u)) return '';
    // the comment is a unit only when short and not prose ("Text von CAM_IN[1]")
    if (u.length > 0 && u.length <= 12 && !u.includes(' ')) return u;
    return '%';
  }
  for (const [re, val] of WEB_DEMO_SHAPES) {
    if (re.test(desc) || re.test(name)) return val(i);
  }
  // a described on/off bit reads as a state word
  if (/\b0=|1=|Statusbit|aktiv|bereit\b/i.test(desc)) {
    return WEB_DEMO_STATES[steady % WEB_DEMO_STATES.length];
  }
  // ...and so does one the NAME declares boolean (DWA4's _VERBAUT came back 34
  // and drew a bar)
  if (/(_VERBAUT|_EIN|_AUS|_AKTIV|_INAKTIV|_MOEGLICH|_VORHANDEN|_OFFEN|_GESCHLOSSEN|_GEDRUECKT|_BETAETIGT|_GELOEST|_ERKANNT|_OK)\d*$/i
      .test(name)) {
    return (steady % 2) === 0 ? 'ja' : 'nein';
  }
  // the description often states the valid span ("Werte -48 bis 48"): sit inside it
  const span = /(-?\d+)\s*bis\s*(-?\d+)/.exec(desc || '');
  if (span) {
    let lo = parseInt(span[1], 10);
    let hi = parseInt(span[2], 10);
    if (lo > hi) [lo, hi] = [hi, lo];
    return String(Math.round(lo + ((hi - lo) * (30 + tri(i, 40))) / 100));
  }
  // LAST RESORT (unrecognised unit): a bare `i % 100` walked in lockstep with
  // the seed and read as corrupt data. Hash the NAME so each row sits differently.
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return String(20 + tri(h + i, 60));
}

// How far the demo has drifted, in seed steps (1/sec). From the clock not a
// counter, so every job advances together and a reload doesn't restart it.
function webDemoPhase() {
  return Math.floor(Date.now() / 1000);
}

// One result set for a job, from the shipped metadata. Returns null when the
// job has no declared schema, so the caller can answer honestly.
function webDemoSets(meta, job, arg) {
  const name = String(job).toUpperCase();

  // Fault jobs are filled in by webDemoFaults() from the ECU's OWN fault table,
  // so a demo scan shows faults that module can really report rather than
  // invented ones. It runs as an async overlay (the tables load lazily), so
  // this returns a clean memory and the overlay replaces it. If the tables are
  // unreachable the clean answer stands -- the honest fallback.
  //
  // STILL FABRICATED, and still dangerous in a way a gauge reading is not: a
  // fault list names components and gets screenshotted. Every fault carries
  // _DEMO so no screen can render one without knowing.
  if (/^FS_/i.test(name)) return [{ JOB_STATUS: 'OKAY', F_ANZAHL: '0' }];

  const j = meta && meta.jobs
    && (meta.jobs[name] || meta.jobs[job] || meta.jobs[String(job)]);
  const row = { JOB_STATUS: 'OKAY' };
  if (!j || !Array.isArray(j.results)) return [row];

  // Seed from the job NAME (summed chars) so jobs sharing a schema differ but
  // each is stable per load; then DRIFT it so a polled screen looks alive.
  let base = 0;
  for (const ch of name) base = (base + ch.charCodeAt(0)) % 101;
  // NOT re-reduced mod 101, which would snap the seed back and undo the fold.
  // A coding read must return the same values on every re-read, so no drift.
  const codingJob = /CODIER|^COD_/i.test(name);
  let i = base + (codingJob ? 0 : webDemoPhase());
  let steady = base;

  for (const r of j.results) {
    const rn = r.name || '';
    if (!rn || rn.startsWith('_') || rn === 'JOB_STATUS') continue;
    // an actuator's readback echoes what was just commanded, so driving a key
    // visibly moves its gauge instead of leaving it at 0
    row[rn] = (arg != null && rn.startsWith('STAT_AUSGANG')
               && !/_EINH$/.test(rn) && !/_TEXT$/.test(rn))
      ? webDemoEcho(arg)
      : webDemoValue(rn, r.comment || '', i++, steady++);
  }
  return [row];
}

// Overlay a coding read with legal values from BMW's DATEN (codDatEnums),
// picked by a hash of the result name so they're stable and differ per field.
// Guarded, since the offline bundle may load this without the coding screen.
async function webDemoCoding(sgbd, job, sets) {
  if (!/CODIER|^COD_/i.test(String(job))) return;
  if (typeof codDatEnums !== 'function'
      || typeof codEnumMatch !== 'function') return;
  let enums = null;
  try { enums = await codDatEnums(String(sgbd).toLowerCase()); } catch { return; }
  if (!enums) return;
  for (const row of sets || []) {
    const matched = codEnumMatch(Object.keys(row), enums);
    for (const [rn, en] of matched) {
      if (!en.length) continue;
      let h = 0;
      for (const c of rn) h = (h * 31 + c.charCodeAt(0)) % 997;
      row[rn] = String(en[h % en.length][1]);
    }
  }
}


// ---------------------------------------------------------------------------
// Demo fault memory, drawn from the ECU's OWN fault table.
//
// The source is window.BMW_FAULT_INDEX (data/faultindex.js), one entry per
// module carrying its scheme and its real fault rows:
//
//   kombi46  scheme "text"  [["K-Bus", "K-bus", "0x87"], ...]
//   ms_s65   scheme "code"  [["27DA", "Alternator BSD fault", "27DA"], ...]
//
// so a demo scan of the cluster shows faults THE CLUSTER can report, in the
// dialect it reports them in. That matters: a text-scheme ECU hands back
// German in F_ORT_TEXT and the screen translates it, while a code-scheme one
// is read from F_ORT_NR. Feeding the wrong dialect gives a fault the screen
// cannot name.
//
// STILL FABRICATED. A fault list is more dangerous than a gauge reading: it
// names components and it gets screenshotted. Every row carries _DEMO so no
// screen can render one without knowing, and the count is seeded from the SGBD
// so a module's demo faults are stable rather than reshuffling each read
// (which would read as an intermittent fault rather than a demo).
function webDemoFaultHash(str) {
  let h = 2166136261;
  for (const ch of String(str)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// This module's own fault rows: [germanOrCode, english, hexCode][], or [].
function webDemoFaultTable(sgbd) {
  const idx = (typeof window !== 'undefined' && window.BMW_FAULT_INDEX) || null;
  if (!idx || !idx.length) return null;
  const key = String(sgbd).toLowerCase();
  const hits = idx.filter(e => String(e.sgbd || '').toLowerCase() === key);
  if (!hits.length) return null;
  // Same SGBD across chassis: take the richest table rather than the first.
  hits.sort((a, b) => (b.faults || []).length - (a.faults || []).length);
  return hits[0];
}

// One FS_LESEN-shaped row. The German/status strings are the exact ones the
// fault screen keys on (faults.js: "momentan vorhanden", "statisch").
function webDemoFaultRow(entry, seed) {
  const [key, english, code] = entry;
  const textScheme = /^text$/i.test(entry._scheme || '');
  return {
    // code scheme reads F_ORT_NR; text scheme is named from F_ORT_TEXT
    F_ORT_NR: code || '',
    F_ORT_TEXT: textScheme ? key : (english || key),
    F_HFK: String(1 + (seed % 8)),
    F_ART_ANZ: '1',
    F_ART1_NR: String(1 + (seed % 3)),
    F_ART1_TEXT: (seed % 3 === 0) ? 'Fehler sporadisch' : 'Fehler statisch',
    F_VORHANDEN_TEXT: (seed % 4 === 0)
      ? 'Fehler momentan vorhanden' : 'Fehler momentan nicht vorhanden',
    F_LZ: String(1 + (seed % 250)),
    _DEMO: '1',
  };
}

// Replace a demo fault read with faults this ECU can actually report.
// Async because faultindex.js is lazy-loaded; mirrors webDemoCoding.
async function webDemoFaults(sgbd, job, sets) {
  if (!/^FS_LESEN/i.test(String(job))) return;   // FS_LOESCHEN etc. stay as-is
  if (typeof loadFaultIndex === 'function') {
    try { await loadFaultIndex(); } catch (e) { /* fall through to the check */ }
  }
  const entry = webDemoFaultTable(sgbd);
  // No table for this module: leave the clean memory. Borrowing another ECU's
  // faults is exactly the fabrication worth avoiding.
  if (!entry || !(entry.faults || []).length) return;

  const rows = entry.faults;
  const seed = webDemoFaultHash(String(sgbd).toLowerCase());
  // 0-4 faults, weighted so a clean memory stays a common outcome
  const n = Math.min([0, 1, 1, 2, 2, 3, 4][seed % 7], rows.length);
  if (!n) return;

  const picked = [];
  const used = new Set();
  for (let k = 0; picked.length < n && k < rows.length * 2; k++) {
    const i = (seed + k * 7919) % rows.length;
    if (used.has(i)) continue;
    used.add(i);
    const r = rows[i].slice();
    r._scheme = entry.scheme;
    picked.push(webDemoFaultRow(r, seed + k));
  }
  if (!picked.length) return;

  sets.length = 0;
  sets.push({ JOB_STATUS: 'OKAY', F_ANZAHL: String(picked.length), _DEMO: '1' });
  for (const r of picked) sets.push(r);
}

if (typeof window !== 'undefined') {
  window.webDemoSets = webDemoSets;
  window.webDemoValue = webDemoValue;
  window.webDemoCoding = webDemoCoding;
  window.webDemoFaults = webDemoFaults;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { webDemoSets, webDemoValue, webDemoEcho, webDemoCoding,
                   webDemoFaults, webDemoFaultRow, webDemoFaultHash };
}
