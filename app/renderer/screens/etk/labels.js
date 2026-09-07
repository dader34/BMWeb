/**
 * @file Human-readable labels for the catalogue's coded attributes: body and
 * steering codes, gearboxes, introduction dates, the one-line variant caption,
 * and BMW's grouped 11-digit part-number layout.
 */

/* exported bodyLabel, etkSteerAbbrev, etkSteerLabel, etkGearLabel, etkYearMonth, etkVariantLabel, fmtSachnr */

/** Body code -> readable (Lim = Sedan, Tou = Touring, Cou = Coupé, Cab = Convertible...). */
const ETK_BODY_LABELS = {
  Lim: 'Sedan',
  Tou: 'Touring',
  Cou: 'Coupé',
  Cab: 'Convertible',
  com: 'Compact',
  Cabrio: 'Convertible',
};

/** Steering code -> the short form used in captions. */
const ETK_STEER_ABBREV = { L: 'LHD', R: 'RHD' };

/** Steering code -> the long form used in the attribute selector. */
const ETK_STEER_LABELS = { L: 'Left-hand drive', R: 'Right-hand drive' };

// ETK stores gearbox N = "Neutral" on chassis whose catalogue isn't split by
// transmission (the terminal shows "Neutral" there too, not a blank).
/** Gearbox code -> the long form used in the attribute selector. */
const ETK_GEAR_LABELS = { A: 'Automatic', M: 'Manual', N: 'Neutral' };

/** Gearbox code -> the short form used in the variant caption ('' = omit). */
const ETK_GEAR_ABBREV = { A: 'auto', M: 'man.', N: '' };

/** Length of a full YYYYMMDD date in the variant records. */
const ETK_DATE_LEN = 8;

/**
 * Readable body style for a body code; unknown codes pass through.
 * @param {string|undefined} b - body code (Lim, Tou, Cou, Cab, com, Cabrio...)
 * @returns {string}
 */
function bodyLabel(b) {
  return ETK_BODY_LABELS[b] || b || '';
}

/**
 * Short steering caption: LHD / RHD, '' for anything else.
 * @param {string|undefined} steer - 'L' or 'R'
 * @returns {string}
 */
function etkSteerAbbrev(steer) {
  return ETK_STEER_ABBREV[steer] || '';
}

/**
 * Long steering caption; unknown codes pass through.
 * @param {string} steer - 'L' or 'R'
 * @returns {string}
 */
function etkSteerLabel(steer) {
  return ETK_STEER_LABELS[steer] || steer;
}

/**
 * Long gearbox caption; unknown codes pass through, a blank reads "Neutral".
 * @param {string|undefined} gear - 'A', 'M' or 'N'
 * @returns {string}
 */
function etkGearLabel(gear) {
  return ETK_GEAR_LABELS[gear] || gear || 'Neutral';
}

/**
 * "YYYY-MM" from the front of a YYYYMMDD (or longer) date string.
 * @param {string} d - date digits
 * @returns {string}
 */
function etkYearMonth(d) {
  return `${d.slice(0, 4)}-${d.slice(4, 6)}`;
}

/**
 * One-line caption for a catalogue variant: "325i · Lim · M54 · LHD · man. · 2001-09".
 * @param {EtkVariant} v - the variant record
 * @returns {string}
 */
function etkVariantLabel(v) {
  const parts = [];
  if (v.model) parts.push(v.model);
  if (v.body) parts.push(v.body);
  if (v.motor) parts.push(v.motor);
  if (v.steer) parts.push(ETK_STEER_ABBREV[v.steer] || v.steer);
  if (v.gear) {
    const g = ETK_GEAR_ABBREV[v.gear];
    if (g) parts.push(g);
  }
  if (v.date) {
    const d = String(v.date);
    if (d.length === ETK_DATE_LEN) parts.push(etkYearMonth(d));
  }
  return parts.join(' · ');
}

/**
 * BMW part numbers print as the full 11-digit number when we have the group
 * prefix: main-group + subgroup + 7-digit sachnr, grouped "11 13 7 791 531".
 * Without a prefix, fall back to grouping the 7-digit number alone.
 * @param {string|number} s - the 7-digit part number
 * @param {string|number} [prefix] - the 4-digit main-group + subgroup prefix
 * @returns {string|number} the grouped number, or the input untouched when it isn't 7 digits
 */
function fmtSachnr(s, prefix) {
  const d = String(s).replace(/\D/g, '');
  if (prefix && d.length === 7) {
    const p = String(prefix).replace(/\D/g, '');
    if (p.length === 4) {
      // HG(2) UG(2) X(1) XXX(3) XXX(3)
      return `${p.slice(0, 2)} ${p.slice(2, 4)} ${d.slice(0, 1)} ${d.slice(1, 4)} ${d.slice(4)}`;
    }
  }
  if (d.length === 7) return `${d.slice(0, 2)} ${d.slice(2, 4)} ${d.slice(4)}`;
  return s;
}
