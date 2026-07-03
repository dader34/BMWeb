// measurement parsing, formatting, and gauge-range logic — the DOM-less layer
// behind the live value gauges. INPA-style gauge bars need a numeric value, a
// unit, and a [min,max] range: EDIABAS gives value (sometimes a unit), the range
// is INPA's own presentation choice from its .ips scripts (not in the protocol),
// so we reproduce common ranges by unit and auto-scale the rest. The DOM cells
// that consume these live in live.js (updateGauge/updateGaugeSpec).

// split "38.67", "-5.7", "1.02 V", "98 %" into { num, unit, raw }
function parseMeasurement(raw) {
  const s = String(raw).trim();
  // number (optional sign/decimal/exponent) then optional unit token
  const m = s.match(/^(-?\d+(?:[.,]\d+)?(?:[eE][-+]?\d+)?)\s*(.*)$/);
  if (!m) return { num: null, unit: '', raw: s };
  const num = parseFloat(m[1].replace(',', '.'));
  if (!isFinite(num)) return { num: null, unit: '', raw: s };
  let unit = (m[2] || '').trim();
  if (/^grad/i.test(unit)) unit = '°';
  return { num, unit, raw: s };
}

// pick [min,max] for a measurement, by unit first (INPA's ranges), then by the
// value's magnitude as a fallback for uncatalogued units
function rangeFor(unit, num, key) {
  const u = (unit || '').toLowerCase();
  const k = (key || '').toLowerCase();
  // unit-based ranges cover most MSD/MSV/MEVD status screens
  if (u === '%') {
    // correction factors (adaption/trim) are symmetric about 0
    if (/(adaption|adaptionsfaktor|korrektur|integrator|trim|gemischadaption|einspritzzeit)/.test(k))
      return [-50, 50];
    return [0, 100];
  }
  if (u === 'mg/stk' || u === 'mg/hub') return [-700, 700];
  if (u === 'v') return [0, 16];
  if (u === '°' || u === '°c' || u === 'c') return [-40, 140];
  if (u === '°kw' || u === 'kw') return [-30, 60];   // crank-angle (timing/VANOS)
  if (u === '1/min' || u === 'rpm' || u === 'u/min') return [0, 8000];
  if (u === 'km/h') return [0, 260];
  if (u === 'mbar' || u === 'hpa') return [0, 2500];
  if (u === 'bar') return [0, 5];
  if (u === 'nm') return [0, 600];
  if (u === 'ms') return [0, 25];
  if (u === 'l/h') return [0, 60];
  if (u === 'a') return [-30, 30];
  if (u === 'ohm') return [0, 100];
  if (u === '' ) {
    // unitless: lambda sits near 1.0, flags are 0/1
    if (/lambda|lambdawert/.test(k)) return [0, 2];
    if (num === 0 || num === 1) return [0, 1];
  }
  // auto-scale around the observed value
  if (num === 0) return [0, 1];
  const mag = Math.abs(num);
  if (num < 0) return [-roundNice(mag * 2), roundNice(mag * 2)];
  return [0, roundNice(mag * 1.5)];
}

function roundNice(x) {
  if (x <= 1) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(x)));
  const n = x / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

function fmtRange(n) {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(Math.abs(n) < 10 ? 1 : 0);
}

// German measurement-key tokens -> English, for humanizing raw STAT_*_WERT keys
// on ECUs with no mined layout (e.g. GSDS2 transmission)
const KEY_TOKENS = {
  MOTOR: 'engine', MOTORDREHZAHL: 'engine RPM', DREHZAHL: 'RPM', ABTRIEBSDREHZAHL: 'output speed',
  STEGDREHZAHL: 'planetary speed', RADDREHZAHL: 'wheel speed', GETRIEBE: 'gearbox',
  GETRIEBETEMPERATUR: 'gearbox temp', MOTORTEMPERATUR: 'engine temp', TEMPERATUR: 'temperature',
  TEMP: 'temp', LAST: 'load', DKG: 'clutch', UBAT: 'battery voltage', SPANNUNG: 'voltage',
  DRUCK: 'pressure', LADEDRUCK: 'boost', GANG: 'gear', FAHRSTUFE: 'gear position',
  KUPPLUNG: 'clutch', BREMSE: 'brake', LAMBDA: 'lambda', GEMISCH: 'mixture',
  ZUENDUNG: 'ignition', EINSPRITZ: 'injection', OEL: 'oil', KUEHL: 'coolant',
  GESCHWINDIGKEIT: 'speed', POSITION: 'position', SOLL: 'target', IST: 'actual',
  VL: 'front-left', VR: 'front-right', HL: 'rear-left', HR: 'rear-right',
  EIN: '', AUS: '', STATUS: 'status', WERT: '',
  ABGL: 'calibration', LRW: 'steering wheel', LWS: 'LWS', ID: 'ID',
  FGSTNR: 'chassis no. (VIN)',
};
// normalize an EDIABAS unit string to a compact symbol
function normUnit(u) {
  const s = String(u || '').trim();
  if (/^grad\s*c$/i.test(s) || /^°?\s*c$/i.test(s)) return '°C';
  if (/^grad$/i.test(s)) return '°';
  if (/^1\/min$/i.test(s) || /^u\/min$/i.test(s)) return '1/min';
  if (/^volt$/i.test(s)) return 'V';
  return s;
}
// STAT_MOTORTEMPERATUR_WERT -> "Engine temp"
function humanizeKey(key) {
  let k = String(key).replace(/^STAT_/, '').replace(/_WERT$|_EINH$/i, '');
  const words = k.split('_').map(tok => {
    const up = tok.toUpperCase();
    if (up in KEY_TOKENS) return KEY_TOKENS[up];
    return tok.charAt(0) + tok.slice(1).toLowerCase();
  }).filter(Boolean);
  const label = words.join(' ').replace(/\s+/g, ' ').trim();
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : key;
}

// pair STAT_X_WERT with STAT_X_EINH and humanize the key. one entry per
// measurement, unit merged in ("13" + "Grad C" -> "13 °C"). keys without
// _WERT/_EINH structure pass through unchanged.
function pairWertEinh(merged) {
  const out = [];
  const seen = new Set();
  const has = (k) => merged.has(k);
  for (const [k, v] of merged) {
    if (seen.has(k)) continue;
    const m = k.match(/^(.*)_WERT$/);
    if (m) {
      const base = m[1];
      const unitKey = base + '_EINH';
      const unit = has(unitKey) ? normUnit(merged.get(unitKey)) : '';
      if (has(unitKey)) seen.add(unitKey);
      seen.add(k);
      out.push({ key: k, label: humanizeKey(k), value: v, unit });
      continue;
    }
    // stray _EINH with no matching _WERT: show as text
    if (/_EINH$/.test(k)) { seen.add(k); out.push({ key: k, label: humanizeKey(k), value: merged.get(k), unit: '' }); continue; }
    seen.add(k);
    out.push({ key: k, label: humanizeKey(k), value: v, unit: '' });
  }
  return out;
}
