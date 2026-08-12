// Synthetic readings, so the UI can be walked with no car attached. Reads each
// job's declared results from the metadata we ship (data/job-meta/<sgbd>.json)
// and invents a plausible number per unit; every declared result appears, so
// screens populate as they would on a real read.
//
// OPT-IN ONLY. Without demo mode a missing cable fails as it should. A
// diagnostic tool must never invent values that could be mistaken for the
// car's -- also why the response is badged demo:true and fault jobs are
// special-cased below.

const WEB_DEMO_STATES = ['ein', 'aus', 'aktiv', 'bereit', 'nicht aktiv'];

// i mod n, FOLDED so it never snaps. Plain `i % n` jumps n-1 back to 0 as the
// seed crosses a multiple of n -- on a drifting seed, a gauge falling off a
// cliff once every n reads. Folding walks 0..n-1..0 so each shape wanders
// inside its band whatever its modulus.
function tri(i, n) {
  const t = ((i % (n * 2)) + (n * 2)) % (n * 2);
  return t < n ? t : (n * 2) - 1 - t;
}

// unit -> a believable idling-engine value, so gauges sit mid-scale rather
// than pinned at either end
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

// `i` drifts once a second so gauges animate; `steady` is the same seed with
// the drift removed. ANYTHING DISCRETE USES steady: a lamp or coding flag that
// flips every second reads as a fault in the tool, not a moving measurement.
// Numbers drift; words and flags hold.
function webDemoValue(name, desc, i, steady) {
  if (steady == null) steady = i;
  // _TEXT / _EINH carriers read as words, not numbers
  if (/_TEXT\d*$/i.test(name)) {
    return WEB_DEMO_STATES[steady % WEB_DEMO_STATES.length];
  }
  // A UNIT CARRIER ALREADY KNOWS ITS UNIT (BMW writes it as the result's own
  // comment), so answering a flat "%" mislabels every gauge on MSD80's VANOS
  // page, cam angles included.
  if (/_EINH\d*$/i.test(name)) {
    const u = (desc || '').trim();
    // ...but a SHORT word is not automatically a unit: these German
    // placeholders (MS45 comments every result "Messwert") have no unit to
    // show, and sailed through the length test as "[Messwert]".
    if (/^(messwert|wert|text|einheit|status|kein[e]?)$/i.test(u)) return '';
    // the comment is the unit only when SHORT and not prose ("Text von
    // CAM_IN[1]" describes the carrier, it is not a unit)
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
  // ...and so does one the NAME declares boolean (DWA4's NEIGUNGSGEBER_VERBAUT
  // came back 34 and drew a bar, its description saying nothing).
  if (/(_VERBAUT|_EIN|_AUS|_AKTIV|_INAKTIV|_MOEGLICH|_VORHANDEN|_OFFEN|_GESCHLOSSEN|_GEDRUECKT|_BETAETIGT|_GELOEST|_ERKANNT|_OK)\d*$/i
      .test(name)) {
    return (steady % 2) === 0 ? 'ja' : 'nein';
  }
  // the description often states the valid span ("Werte -48 bis 48"): sit
  // inside it so the gauge lands mid-scale instead of at 0
  const span = /(-?\d+)\s*bis\s*(-?\d+)/.exec(desc || '');
  if (span) {
    let lo = parseInt(span[1], 10);
    let hi = parseInt(span[2], 10);
    if (lo > hi) [lo, hi] = [hi, lo];
    return String(Math.round(lo + ((hi - lo) * (30 + tri(i, 40))) / 100));
  }
  // LAST RESORT: a result whose unit nothing recognises. A bare `i % 100`
  // walked in lockstep with the seed (2, 5, 8, 11 …), an arithmetic ladder
  // that reads as corrupt data. Hash the NAME so each row sits differently,
  // and let the drift move it.
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return String(20 + tri(h + i, 60));
}

// How far the demo has drifted, in seed steps. One step per second (matching
// the pollers' 1 Hz tick), taken from the clock rather than a counter so every
// job on a screen advances together and a reload does not restart the animation.
function webDemoPhase() {
  return Math.floor(Date.now() / 1000);
}

// One result set for a job, from the metadata we ship. Returns null when the
// job has no declared schema, so the caller can answer honestly.
function webDemoSets(meta, job, arg) {
  const name = String(job).toUpperCase();

  // A FABRICATED FAULT IS WORSE THAN A FABRICATED GAUGE READING: it names a
  // component and reads exactly like a real DTC. Answer fault jobs with a CLEAN
  // memory instead -- the honest thing to show with no car attached.
  if (/^FS_/i.test(name)) return [{ JOB_STATUS: 'OKAY', F_ANZAHL: '0' }];

  const j = meta && meta.jobs
    && (meta.jobs[name] || meta.jobs[job] || meta.jobs[String(job)]);
  const row = { JOB_STATUS: 'OKAY' };
  if (!j || !Array.isArray(j.results)) return [row];

  // Seed from the job NAME so two jobs sharing a schema do not return identical
  // values (intake vs exhaust); summed chars, so the same job shows the same
  // numbers every load. Then DRIFT it (via webDemoPhase) so a polled screen
  // looks alive rather than frozen.
  let base = 0;
  for (const ch of name) base = (base + ch.charCodeAt(0)) % 101;
  // NOT re-reduced mod 101: that would snap the seed back every 101 seconds and
  // undo the fold. tri() bounds each shape itself.
  // A coding read answers what the module IS CODED TO, not a measurement: it
  // must return the same values on every Re-read, so the drift stays off it.
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

// Overlay a coding read's results with values the module could actually hold:
// where BMW's DATEN lists this field's legal values (codDatEnums), replace the
// invented number with one -- picked by a hash of the result name, so it is
// stable across reads and differs between fields. Guarded, because the offline
// bundle may load this file without the coding screen.
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

if (typeof window !== 'undefined') {
  window.webDemoSets = webDemoSets;
  window.webDemoValue = webDemoValue;
  window.webDemoCoding = webDemoCoding;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { webDemoSets, webDemoValue, webDemoEcho, webDemoCoding };
}
