/**
 * @file Grouping vehicles.json's series codes the way ETK's Vehicle
 * Identification does: marketing series ("5'", "X3", "MINI") derived from
 * each chassis's model names, and a stable ordering within and across them.
 */

/* exported seriesSort, groupBySeries */

/**
 * Chassis codes bucketed by marketing series, in display order.
 * @typedef {object} EtkSeriesGroups
 * @property {string[]} order - series names in ETK's display order
 * @property {Record<string, string[]>} groups - series name -> sorted chassis codes
 */

/** Era rank of the leading letter of a car chassis code (E46 < F30 < G20...). */
const ETK_ERA_RANK = { E: 0, F: 1, G: 2, I: 3, U: 4 };

// Chassis whose model prefix is ambiguous, or which predate the numbering
// scheme, so their series can't be derived from the model names.
/** Hard overrides: chassis code -> marketing series. */
const ETK_SERIES_HARD = {
  E52: 'Z',
  E26: 'M',
  E72: 'X6',
  E169: 'Moto',
  E3: 'Classic',
  E9: 'Classic',
};

/** Display order of the series buckets (index = rank). */
const ETK_SERIES_ORDER = ['Z', 'M', 'i', 'MINI', 'Moto'];

/** Bucket rank for numbered series ("5'") and X series, which sort before the named ones. */
const ETK_SERIES_RANK_NUMBER = 0;
const ETK_SERIES_RANK_X = 1;
/** Named buckets start after number and X series. */
const ETK_SERIES_RANK_NAMED = 2;

// vehicles.json keys are BMW's internal ETK series codes. Most are the
// familiar chassis E-numbers (E46, F30, G20), but a tail of them are raw
// internal codes for motorcycles (K/R bikes), the classic '02 range and a few
// oddments (114, 2471, R56, MOSP...). Alphabetical sort buries the cars the
// user is actually after under those codes, so we bucket by kind: modern cars
// first (E/F/G/I/U + digits), then Minis (R5x/F5x/F6x), then everything else.
/**
 * Sort key for one series code: [kind, era, number, code].
 * @param {string} code - a vehicles.json series code
 * @returns {[number, number, number, string]}
 */
function seriesRank(code) {
  if (/^[EFGIU]\d/.test(code)) {
    // BMW car chassis: E46, F30, G20...
    const era = ETK_ERA_RANK[code[0]];
    const num = parseInt(code.slice(1), 10) || 0;
    return [0, era, num, code];
  }
  if (/^(R5|F5|F6)/.test(code)) return [1, 0, 0, code]; // MINI
  return [2, 0, 0, code]; // bikes / classics / internal codes
}

/**
 * Series codes sorted cars-first, then Minis, then everything else.
 * @param {string[]} codes - series codes
 * @returns {string[]} a new sorted array
 */
function seriesSort(codes) {
  return codes.slice().sort((a, b) => {
    const ra = seriesRank(a),
      rb = seriesRank(b);
    for (let i = 0; i < ra.length; i++) {
      if (ra[i] < rb[i]) return -1;
      if (ra[i] > rb[i]) return 1;
    }
    return 0;
  });
}

/**
 * Is this model name a motorcycle? R-/K-/C-prefixed engine names, or the
 * F/G three-digit bikes.
 * @param {string} model - a model name from vehicles.json
 * @returns {boolean}
 */
function etkIsBikeModel(model) {
  const m = model.trim();
  return /^[RKC]\s?\d/.test(m) || /^F \d{3}/.test(m) || /^G \d{3}/.test(m);
}

/**
 * The marketing-series key a model name votes for: X3 -> "X3", Z4 -> "Z",
 * M3 -> "M", 525i -> "5'", or null when it says nothing.
 * @param {string} model - a model name from vehicles.json
 * @returns {string|null}
 */
function etkModelSeriesKey(model) {
  const t = model.trim();
  const x = t.match(/^(X\d)/); // X3, X5
  if (x) return x[1];
  if (/^Z\d/.test(t)) return 'Z'; // Z3, Z4 -> one "Z" series
  if (/^M(\d)\b/.test(t)) return 'M'; // M3, M5
  if (/^\d/.test(t)) return t[0] + "'"; // 5xx -> 5'
  return null;
}

// ETK's Vehicle Identification lists a top-level marketing series ("5'", "X3",
// "MINI"...) which expands to the chassis under it (E60, E61, F10, F18...).
// The internal series codes in vehicles.json don't carry that grouping, so we
// derive it from each chassis's model names: the dominant model prefix names
// the series (5xx -> 5', X3 xx -> X3, "R 1200" -> Moto). This mirrors what a
// user sees on the dealer terminal without needing a hand-kept 296-row table.
/**
 * The marketing series one chassis belongs to.
 * @param {string} code - the chassis / series code
 * @param {Iterable<string>} models - every model name under that chassis
 * @returns {string} the series name ("5'", "X3", "Z", "M", "i", "MINI", "Moto", "Classic", "Other")
 */
function chassisSeries(code, models) {
  if (ETK_SERIES_HARD[code]) return ETK_SERIES_HARD[code];
  if (/^I\d/.test(code)) return 'i'; // i3 / i8
  if (/^(R5|R13|R56|R57|R58|R59|F5|F6)/.test(code)) return 'MINI';
  const list = [...models];
  const bike = list.filter(etkIsBikeModel).length;
  if (bike > list.length / 2) return 'Moto';
  const tally = {};
  for (const m of list) {
    const key = etkModelSeriesKey(m);
    if (key) tally[key] = (tally[key] || 0) + 1;
  }
  let best = null,
    n = -1;
  for (const k in tally)
    if (tally[k] > n) {
      n = tally[k];
      best = k;
    }
  return best || 'Other';
}

// order the marketing-series buckets the way ETK does: number series, then X,
// then Z, M, i, MINI, motorcycles, classics/other.
/**
 * Sort key for a series bucket: [bucket rank, number within the bucket].
 * @param {string} s - a series name
 * @returns {[number, number]}
 */
function seriesGroupRank(s) {
  if (/^\d'$/.test(s)) return [ETK_SERIES_RANK_NUMBER, parseInt(s, 10)];
  if (/^X\d$/.test(s)) return [ETK_SERIES_RANK_X, parseInt(s.slice(1), 10)];
  const named = ETK_SERIES_ORDER.indexOf(s);
  if (named >= 0) return [ETK_SERIES_RANK_NAMED + named, 0];
  return [ETK_SERIES_RANK_NAMED + ETK_SERIES_ORDER.length, 0];
}

/**
 * Group every chassis in the vehicle tree by marketing series, each bucket
 * sorted, buckets in ETK's display order.
 * @param {EtkVehicleTree} veh - the loaded vehicles.json
 * @returns {EtkSeriesGroups}
 */
function groupBySeries(veh) {
  const groups = {};
  for (const code of Object.keys(veh)) {
    const models = new Set();
    for (const body in veh[code])
      for (const m in veh[code][body]) models.add(m);
    const s = chassisSeries(code, models);
    (groups[s] = groups[s] || []).push(code);
  }
  const order = Object.keys(groups).sort((a, b) => {
    const ra = seriesGroupRank(a),
      rb = seriesGroupRank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || (a < b ? -1 : 1);
  });
  for (const s of order) groups[s] = seriesSort(groups[s]);
  return { order, groups };
}
