/**
 * @file Range checks on the freeze-frame values a fault captured.
 *
 * A flagged value must always be able to say WHY, so every rule here has a
 * named source and no rule guesses. Three of them, checked in this order:
 *
 *   'script'  the band the script's own author declared. Every INPA gauge is
 *             drawn by analogout(value, row, col, min, max, minvalid,
 *             maxvalid, fmt); the decoded IR keeps the last two as okMin and
 *             okMax against the result key the gauge reads. If the module
 *             that logged the fault draws the same result key on a screen,
 *             that band is the author's own statement of normal.
 *   'physics' a short fixed table below: values no running car reaches,
 *             whatever the module. Written out with its reasoning so it can
 *             be argued with rather than trusted.
 *   'history' the same key in this car's earlier scans, and only when at
 *             least GARAGE_TREND_MIN of them agree. A trend over three
 *             stored reads is an observation; over two it is noise.
 *
 * A value that matches no rule is returned unflagged. Nothing here infers a
 * range from the value itself, from the units, or from the field's name.
 */

/* exported
   GARAGE_PHYSICS, GARAGE_TREND_MIN, garageWarnFor, garageEnvChecks,
   garageBandFor, garageEnvValue, garageEnvKeys, garageScreensFor */

/**
 * How many past scans must agree before a history note is worth making.
 */
const GARAGE_TREND_MIN = 3;

/**
 * Values outside what a working car physically reaches, whatever module
 * reported them. Each entry says what it covers and why the bound is where
 * it is; `match` is tested against the freeze-frame field's own label, and
 * only against an exact result key or a label this table names outright --
 * never against a substring of arbitrary prose.
 *
 * These are deliberately WIDE. The point is to catch a reading that cannot
 * be true (a 3 V battery, a 400 C coolant), not to second-guess a car that
 * is merely cold or working hard.
 * @type {{id: string, keys: string[], min: number, max: number, unit: string, why: string}[]}
 */
const GARAGE_PHYSICS = [
  {
    id: 'battery',
    // terminal 30 is the permanent battery feed; KL15/KLR are switched
    keys: [
      'STAT_SPANNUNG_KL30_WERT',
      'STAT_KLEMME30_WERT',
      'STAT_UBATT_WERT',
      'STAT_SPANNUNG_WERT',
      'Batteriespannung',
      'Klemme 30',
      'Spannung Klemme 30',
    ],
    min: 11.5,
    max: 15.0,
    unit: 'V',
    why: 'a charging system holds 13.5-14.8 V running and a rested battery sits near 12.6 V; under 11.5 V will not crank and over 15.0 V is a regulator fault',
  },
  {
    id: 'coolant',
    keys: [
      'STAT_MOTORTEMPERATUR_WERT',
      'STAT_KUEHLMITTELTEMPERATUR_WERT',
      'Kuehlmitteltemperatur',
      'Motortemperatur',
      '(Motor) - Kuehlmitteltemperatur',
    ],
    min: -30,
    max: 110,
    unit: '°C',
    why: 'a pressurised cooling system boils past about 120 C, so a logged 110 C is already overheating; below -30 C is colder than the sensor is specified for',
  },
  {
    id: 'airtemp',
    keys: [
      'STAT_TAUSSEN_WERT',
      'STAT_ANSAUGLUFTTEMPERATUR_WERT',
      'Ansauglufttemperatur',
      'Aussentemperatur',
    ],
    min: -40,
    max: 60,
    unit: '°C',
    why: 'ambient and intake air outside -40 to 60 C is beyond the sensor range; a reading past it is normally an open or shorted circuit',
  },
  {
    id: 'rpm',
    keys: [
      'STAT_MOTORDREHZAHL_WERT',
      'STAT_DREHZAHL_WERT',
      'Motordrehzahl',
      'Drehzahl',
    ],
    min: 0,
    max: 7000,
    unit: '/min',
    why: 'past 7000 rpm is beyond the rev limiter of the engines these modules were built for',
  },
];

/**
 * The freeze-frame fields one fault captured, as the raw label/value/unit
 * triples the rules are applied to. The renderers translate the label; the
 * rules match on the untranslated one, which is what the module reported.
 * @param {object} code - an FS_LESEN entry with its detail merged in
 * @returns {{i: number, label: string, value: string, unit: string}[]}
 */
function garageEnvKeys(code) {
  const out = [];
  const max = typeof ENV_FIELDS_MAX === 'number' ? ENV_FIELDS_MAX : 8;
  for (let i = 1; i <= max; i++) {
    const label = code[`F_UW${i}_TEXT`];
    const value = code[`F_UW${i}_WERT`];
    if (label == null || value == null) continue;
    out.push({
      i,
      label: String(label).trim(),
      value: String(value).trim(),
      unit: String(
        code[`F_UW${i}_EINH`] == null ? '' : code[`F_UW${i}_EINH`]
      ).trim(),
    });
  }
  return out;
}

/**
 * A freeze-frame reading as a number, or null when it is not one. INPA
 * reports enumerated states in the same fields ("0 ES - Motor steht"), and
 * those are not measurements: a leading number followed by letters is a
 * state, not a value.
 * @param {string} raw - the reported value
 * @returns {number|null}
 */
function garageEnvValue(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  // a bare number, with an optional sign, decimal part and exponent
  if (!/^[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?$/.test(s.replace(',', '.')))
    return null;
  const n = parseFloat(s.replace(',', '.'));
  return isFinite(n) ? n : null;
}

/**
 * The band the module's own script declared for a result key, if it draws
 * that key on any of its screens.
 *
 * okMin/okMax are INPA's minvalid/maxvalid. A gauge that declares neither
 * leaves both at 0, which is not a band -- treating 0..0 as one would flag
 * every non-zero reading -- so a band is only returned when the two differ.
 * @param {object|null} screens - the module's decoded screens.json
 * @param {string} key - the result key
 * @returns {{min: number, max: number}|null}
 */
function garageBandFor(screens, key) {
  if (!screens || !key) return null;
  let found = null;
  /**
   * Walk the IR for a gauge drawing this key.
   * @param {*} node - any IR node
   * @returns {void}
   */
  const walk = (node) => {
    if (found || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const v of node) walk(v);
      return;
    }
    if (node.t === 'gauge' && node.key === key) {
      const lo = Number(node.okMin);
      const hi = Number(node.okMax);
      if (isFinite(lo) && isFinite(hi) && lo !== hi)
        found = { min: lo, max: hi };
      // a gauge with no declared band keeps looking: another screen may
      // draw the same key with one
    }
    for (const v of Object.values(node)) walk(v);
  };
  walk(screens);
  return found;
}

/**
 * Check one freeze-frame reading against every source, most specific first.
 * @param {{label: string, value: string, unit: string}} field - the reading
 * @param {object} [ctx] - {screens} the module's IR, {history} past values
 * @returns {{level: string, source: string, text: string}|null} the flag, or null
 */
function garageWarnFor(field, ctx) {
  const n = garageEnvValue(field.value);
  if (n == null) return null; // an enumerated state is not a measurement
  const c = ctx || {};

  // 1. the script author's own band for this result key
  const band = garageBandFor(c.screens, field.label);
  if (band && (n < band.min || n > band.max)) {
    return {
      level: 'warn',
      source: 'script',
      text:
        `outside the script's normal band (${band.min} to ${band.max}` +
        `${field.unit ? ' ' + field.unit : ''})`,
    };
  }

  // 2. the fixed physics table
  for (const rule of GARAGE_PHYSICS) {
    if (!rule.keys.includes(field.label)) continue;
    if (n >= rule.min && n <= rule.max) break; // in range: this rule is satisfied
    return {
      level: 'warn',
      source: 'physics',
      text:
        `outside the physical range ${rule.min} to ${rule.max} ${rule.unit} ` +
        `(source: fixed table -- ${rule.why})`,
    };
  }

  // 3. what this car's own history says, once enough of it agrees
  const past = (c.history || []).map(garageEnvValue).filter((v) => v != null);
  if (past.length >= GARAGE_TREND_MIN) {
    const rule = GARAGE_PHYSICS.find((r) => r.keys.includes(field.label));
    if (rule && past.every((v) => v < rule.min)) {
      return {
        level: 'note',
        source: 'history',
        text:
          `every one of the ${past.length} stored occurrences logged this ` +
          `under ${rule.min} ${rule.unit}`,
      };
    }
  }
  return null;
}

/**
 * Every freeze-frame reading of one fault, each with its flag when a rule
 * fired. The renderers walk this rather than the raw fields, so the screen
 * and the printed sheet flag the same values for the same reasons.
 * @param {object} code - the fault
 * @param {object} [ctx] - {screens} the module's IR, {historyFor} a lookup
 * @returns {{label: string, value: string, unit: string, warn: object|null}[]}
 */
function garageEnvChecks(code, ctx) {
  const c = ctx || {};
  return garageEnvKeys(code).map((f) => ({
    ...f,
    warn: garageWarnFor(f, {
      screens: c.screens,
      history: c.historyFor ? c.historyFor(f.label) : null,
    }),
  }));
}

/**
 * The decoded screens of one module, cached for the session. Used only to
 * read the gauge bands its author declared; a module whose archive has none
 * (or a page with no engine behind it) resolves to null and the script rule
 * simply does not fire.
 * @type {Map<string, object|null>}
 */
const _garageScreens = new Map();

/**
 * Load a module's decoded screens, once per session.
 * @param {string} sgbd - the module
 * @returns {Promise<object|null>} its IR, or null when it has none
 */
async function garageScreensFor(sgbd) {
  const key = String(sgbd || '').toLowerCase();
  if (!key) return null;
  if (_garageScreens.has(key)) return _garageScreens.get(key);
  let out = null;
  try {
    if (typeof api === 'function') out = await api(`/api/ecu/${key}/screens`);
  } catch (e) {
    out = null; // no archive for this module: the band rule stays quiet
  }
  _garageScreens.set(key, out);
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    GARAGE_PHYSICS,
    GARAGE_TREND_MIN,
    garageScreensFor,
    garageWarnFor,
    garageEnvChecks,
    garageBandFor,
    garageEnvValue,
    garageEnvKeys,
  };
}
