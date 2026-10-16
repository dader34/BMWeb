/* exported humanizeKey, normUnit */

// measurement parsing, formatting, and gauge-range logic — the DOM-less layer
// behind the live gauges (consumed by updateGauge in live.js). The [min,max]
// range is INPA's presentation choice, not in the protocol, so we reproduce
// common ranges by unit and auto-scale the rest.

/**
 * A parsed measurement string.
 * @typedef {Object} Measurement
 * @property {number|null} num - The numeric part, or null when not a number.
 * @property {string} unit - The unit text ('' when none; "grad" -> '°').
 * @property {string} raw - The trimmed input.
 */

/**
 * German measurement-key tokens -> English, for STAT_*_WERT keys on ECUs with
 * no mined layout (e.g. GSDS2 transmission). An empty value drops the token.
 * @type {Object<string, string>}
 */
const KEY_TOKENS = {
  MOTOR: 'engine',
  MOTORDREHZAHL: 'engine RPM',
  DREHZAHL: 'RPM',
  ABTRIEBSDREHZAHL: 'output speed',
  STEGDREHZAHL: 'planetary speed',
  RADDREHZAHL: 'wheel speed',
  GETRIEBE: 'gearbox',
  GETRIEBETEMPERATUR: 'gearbox temp',
  MOTORTEMPERATUR: 'engine temp',
  TEMPERATUR: 'temperature',
  TEMP: 'temp',
  LAST: 'load',
  DKG: 'clutch',
  UBAT: 'battery voltage',
  SPANNUNG: 'voltage',
  DRUCK: 'pressure',
  LADEDRUCK: 'boost',
  GANG: 'gear',
  FAHRSTUFE: 'gear position',
  KUPPLUNG: 'clutch',
  BREMSE: 'brake',
  LAMBDA: 'lambda',
  GEMISCH: 'mixture',
  ZUENDUNG: 'ignition',
  EINSPRITZ: 'injection',
  OEL: 'oil',
  KUEHL: 'coolant',
  GESCHWINDIGKEIT: 'speed',
  POSITION: 'position',
  SOLL: 'target',
  IST: 'actual',
  VL: 'front-left',
  VR: 'front-right',
  HL: 'rear-left',
  HR: 'rear-right',
  EIN: '',
  AUS: '',
  STATUS: 'status',
  WERT: '',
  ABGL: 'calibration',
  LRW: 'steering wheel',
  LWS: 'LWS',
  ID: 'ID',
  FGSTNR: 'chassis no. (VIN)',
};
/**
 * Normalize an EDIABAS unit string to a compact symbol ("Grad C" -> "°C",
 * "kgperh" -> "kg/h"); unknown units pass through trimmed.
 * @param {any} u - The unit as delivered.
 * @returns {string}
 */
function normUnit(u) {
  const s = String(u || '').trim();
  if (/^grad\s*c$/i.test(s) || /^°?\s*c$/i.test(s)) return '°C';
  if (/^grad$/i.test(s)) return '°';
  if (/^1\/min$/i.test(s) || /^u\/min$/i.test(s)) return '1/min';
  if (/^volt$/i.test(s)) return 'V';
  // CRANK/CAM ANGLE: BMW spells it four ways ("°CRK", "degreeCRK", "degree_KW",
  // "Grad KW"); normalise to the symbol (KW = Kurbelwelle = crankshaft).
  if (/^(°|deg(ree)?)[\s_]*(crk|kw)$/i.test(s)) return '°KW';
  if (/^grad[\s_]*kw$/i.test(s)) return '°KW';
  // WHOLE WORDS FIRST: "percent" contains "per" and the rate pattern below would
  // split it into 1/cent.
  if (/^percent$/i.test(s)) return '%';
  if (/^ampere$/i.test(s)) return 'A';
  // rate units written as words ("kgperh" -> "kg/h"): the corpus ships many
  // (kgperh, mgperstk, gpers, perMinute), so translate "per" generally. Both
  // sides must be a known UNIT (or empty), so it doesn't eat an ordinary word.
  const per =
    /^(|1|[munkcdhKMG]?(?:g|m|l|s|A|V|W|J|N|Pa|bar|Hz|U|km|mg|kg))per([a-z]+?)_?$/i.exec(
      s
    );
  if (per) {
    const DENOM = {
      h: 'h',
      s: 's',
      min: 'min',
      minute: 'min',
      stk: 'stk',
      stroke: 'stroke',
      hub: 'hub',
    };
    const d = DENOM[per[2].toLowerCase()];
    if (d) return per[1] ? `${per[1]}/${d}` : `1/${d}`;
  }
  return s;
}
/**
 * A result key as a caption: STAT_MOTORTEMPERATUR_WERT -> "Engine temp".
 * @param {string} key - The result register name.
 * @returns {string}
 */
function humanizeKey(key) {
  let k = String(key)
    .replace(/^STAT_/, '')
    .replace(/_WERT$|_EINH$/i, '');
  const words = k
    .split('_')
    .map((tok) => {
      const up = tok.toUpperCase();
      if (up in KEY_TOKENS) return KEY_TOKENS[up];
      return tok.charAt(0) + tok.slice(1).toLowerCase();
    })
    .filter(Boolean);
  const label = words.join(' ').replace(/\s+/g, ' ').trim();
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : key;
}

// The unit the ECU shipped beside ONE value, for the IR screen path: a single-
// key _WERT -> _EINH hop. GOTCHA: without it, a layout omitting the literal
// "[unit]" text (MSD80's whole VANOS page) printed cam angles as bare numbers,
// dropping the °CRK the ECU already sent.
/**
 * A display row built from the merged result values.
 * @typedef {Object} MeasurementRow
 * @property {string} key - The result key.
 * @property {string} label - The humanised caption.
 * @property {any} value - The value.
 * @property {string} unit - The normalised unit ('' when none).
 */
