// Synthetic readings, so the UI can be walked with no car attached.
//
// A port of the C# DemoMode that went with InpaMac.Api. Same rules, same
// values: it reads each job's declared results out of the metadata we already
// ship (data/job-meta/<sgbd>.json, the description block from the .prg) and
// invents a plausible number per unit. Every declared result appears, so
// screens populate exactly as they would on a real read.
//
// OPT-IN ONLY. Without demo mode a missing cable fails as it should. A
// diagnostic tool must never invent values that could be mistaken for the
// car's, which is also why the response is badged demo:true and why fault
// jobs are special-cased below.

const WEB_DEMO_STATES = ['ein', 'aus', 'aktiv', 'bereit', 'nicht aktiv'];

// unit -> a believable idling-engine value, so gauges sit mid-scale rather
// than pinned at either end
const WEB_DEMO_SHAPES = [
  [/\bU\/min|1\/min|rpm\b/i, (i) => String(760 + (i % 40))],
  [/°C/i, (i) => String(82 + (i % 8))],
  [/\bkm\/h\b/i, () => '0'],
  [/\bV\b/, (i) => (13.8 + (i % 5) * 0.05).toFixed(2)],
  [/\bA\b/, (i) => (2.4 + (i % 7) * 0.1).toFixed(1)],
  [/%/, (i) => String(12 + (i % 70))],
  [/\bmbar|hPa\b/i, (i) => String(980 + (i % 40))],
  [/\bbar\b/i, (i) => (3.4 + (i % 6) * 0.1).toFixed(1)],
  [/\bms\b/i, (i) => (3.1 + (i % 9) * 0.2).toFixed(1)],
  [/\bNm\b/i, (i) => String(40 + (i % 60))],
  [/\bmg\/(hub|stk)\b/i, (i) => String(180 + (i % 60))],
  [/\bohm\b/i, (i) => String(8 + (i % 4))],
  [/°KW|Kurbelwelle/i, (i) => String(-20 + (i % 40))],
];

// "0x5B" / "91" -> the plain number an actuator readback would report
function webDemoEcho(arg) {
  const s = String(arg).split(';')[0].trim();
  if (/^0x[0-9a-f]+$/i.test(s)) return String(parseInt(s.slice(2), 16));
  return /^-?\d+$/.test(s) ? String(parseInt(s, 10)) : s;
}

function webDemoValue(name, desc, i) {
  // _TEXT / _EINH carriers read as words, not numbers
  if (/_TEXT\d*$/i.test(name)) {
    return WEB_DEMO_STATES[i % WEB_DEMO_STATES.length];
  }
  // A UNIT CARRIER ALREADY KNOWS ITS UNIT. BMW writes it as the result's own
  // comment, so answering a flat "%" labelled every gauge on MSD80's VANOS
  // page a percentage, cam angles included.
  if (/_EINH\d*$/i.test(name)) {
    const u = (desc || '').trim();
    // the comment is the unit only when it is SHORT and not prose ("Text von
    // CAM_IN[1]" describes the carrier, it is not a unit)
    if (u.length > 0 && u.length <= 12 && !u.includes(' ')) return u;
    return '%';
  }
  for (const [re, val] of WEB_DEMO_SHAPES) {
    if (re.test(desc) || re.test(name)) return val(i);
  }
  // a described on/off bit reads as a state word
  if (/\b0=|1=|Statusbit|aktiv|bereit\b/i.test(desc)) {
    return WEB_DEMO_STATES[i % WEB_DEMO_STATES.length];
  }
  // ...and so does one the NAME declares boolean. A coding flag answers
  // yes/no: DWA4's NEIGUNGSGEBER_VERBAUT ("with tilt alarm sensor") came back
  // as 34 and drew a bar, because its description says nothing.
  if (/(_VERBAUT|_EIN|_AUS|_AKTIV|_INAKTIV|_MOEGLICH|_VORHANDEN|_OFFEN|_GESCHLOSSEN|_GEDRUECKT|_BETAETIGT|_GELOEST|_ERKANNT|_OK)\d*$/i
      .test(name)) {
    return (i % 2) === 0 ? 'ja' : 'nein';
  }
  // the description often states the valid span ("Werte -48 bis 48"): sit
  // inside it so the gauge lands mid-scale instead of at 0
  const span = /(-?\d+)\s*bis\s*(-?\d+)/.exec(desc || '');
  if (span) {
    let lo = parseInt(span[1], 10);
    let hi = parseInt(span[2], 10);
    if (lo > hi) [lo, hi] = [hi, lo];
    return String(Math.round(lo + ((hi - lo) * (30 + (i % 40))) / 100));
  }
  return String(i % 100);
}

// One result set for a job, from the metadata we ship. Returns null when the
// job has no declared schema, so the caller can answer honestly.
function webDemoSets(meta, job, arg) {
  const name = String(job).toUpperCase();

  // A FABRICATED FAULT IS WORSE THAN A FABRICATED GAUGE READING. It names a
  // component, a mileage and a frequency, and reads exactly like a real DTC
  // the car is reporting. Answer fault jobs with a CLEAN memory instead: the
  // honest thing to show when there is no car attached.
  if (/^FS_/i.test(name)) return [{ JOB_STATUS: 'OKAY', F_ANZAHL: '0' }];

  const j = meta && meta.jobs
    && (meta.jobs[name] || meta.jobs[job] || meta.jobs[String(job)]);
  const row = { JOB_STATUS: 'OKAY' };
  if (!j || !Array.isArray(j.results)) return [row];

  // Seed from the job NAME so two jobs sharing a schema do not return
  // identical values (intake vs exhaust). Summed chars rather than a hash, so
  // the same job shows the same numbers on every load.
  let i = 0;
  for (const ch of name) i = (i + ch.charCodeAt(0)) % 101;

  for (const r of j.results) {
    const rn = r.name || '';
    if (!rn || rn.startsWith('_') || rn === 'JOB_STATUS') continue;
    // an actuator's readback echoes what was just commanded, so driving a key
    // visibly moves its gauge instead of leaving it at 0
    row[rn] = (arg != null && rn.startsWith('STAT_AUSGANG')
               && !/_EINH$/.test(rn) && !/_TEXT$/.test(rn))
      ? webDemoEcho(arg)
      : webDemoValue(rn, r.comment || '', i++);
  }
  return [row];
}

if (typeof window !== 'undefined') {
  window.webDemoSets = webDemoSets;
  window.webDemoValue = webDemoValue;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { webDemoSets, webDemoValue, webDemoEcho };
}
