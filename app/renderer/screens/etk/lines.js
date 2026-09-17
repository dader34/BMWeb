/**
 * @file A parts line's validity: when it applies, to which steering side
 * and gearbox, and under what condition -- the part of the ETK's fitment
 * the bundle's per-variant `fit` list does not carry.
 *
 * THE TYPE KEY IS NOT THE WHOLE FITMENT. A diagram line in the catalogue is
 * valid for a set of vehicle types (the bundle's `fit`), AND from a month,
 * AND up to a month, AND for one steering side, AND under a condition the
 * catalogue prints beside it ("For vehicles with +Headlight cleaning
 * system"). A 2004 E46 was shown the pre-facelift bumper trim next to its
 * own because only the first of those was applied: sixteen rows on one
 * callout where the catalogue shows four.
 *
 * The records come inline on a part (`part.ln`, bundles built after this)
 * or from the <CHASSIS>.lines.json.gz sidecar (bundles already published),
 * keyed by callout and part number. A part may carry several lines, one
 * window each; it fits when any line does. The records decide what a row
 * shows for the chosen car; nothing about them is printed on the row.
 */

/* exported etkLineFits, etkMergeLines, etkLineKey */

/**
 * One parts line's validity, as tools/etk_import.py writes it.
 * @typedef {object} EtkLine
 * @property {number} [f] - valid from, YYYYMM
 * @property {number} [t] - valid up to, YYYYMM (inclusive)
 * @property {string} [s] - steering side the line is for, L or R
 * @property {string} [a] - gearbox the line is for, A (automatic) or M (manual)
 * @property {string} [c] - the catalogue's condition letter
 * @property {string} [n] - the note printed beside the line
 */

/**
 * What is known about the car the catalogue is filtered to.
 * @typedef {object} EtkCarFacts
 * @property {number|null} [prod] - build month, YYYYMM, when a VIN said
 * @property {string|null} [steer] - L or R
 * @property {string|null} [auto] - A or M
 */

/**
 * The sidecar key of a part row: its callout and part number.
 * @param {{pos?: string, sachnr?: string}} p - a part row
 * @returns {string}
 */
function etkLineKey(p) {
  return `${p && p.pos != null ? p.pos : ''}|${(p && p.sachnr) || ''}`;
}

/**
 * Does one line hold for the car? A fact the car does not have leaves that
 * test open, the way the catalogue browses without a VIN.
 * @param {EtkLine} ln - the line
 * @param {EtkCarFacts} car - what is known
 * @returns {boolean}
 */
function etkOneLineFits(ln, car) {
  if (!ln) return true;
  const prod = car && car.prod != null ? Number(car.prod) : null;
  if (prod) {
    if (ln.f && prod < ln.f) return false;
    if (ln.t && prod > ln.t) return false;
  }
  if (car && car.steer && ln.s && ln.s !== car.steer) return false;
  if (car && car.auto && ln.a && ln.a !== car.auto) return false;
  return true;
}

/**
 * Does a part row fit the car, by its lines? A part with no line records
 * carries no condition and always fits.
 * @param {{ln?: EtkLine[]}} p - a part row
 * @param {EtkCarFacts} car - what is known
 * @returns {boolean}
 */
function etkLineFits(p, car) {
  const lines = p && Array.isArray(p.ln) ? p.ln : null;
  if (!lines || !lines.length) return true;
  return lines.some((ln) => etkOneLineFits(ln, car));
}

/**
 * Put a sidecar's line records onto the tree's parts. Inline records win:
 * a bundle built with them needs nothing from the sidecar.
 * @param {{maingroups?: object[], groups?: object[]}} tree - the bundle's tree
 * @param {{v?: number, ln?: Object<string, Object<string, EtkLine[]>>}|null} sidecar - the parsed file
 * @returns {number} how many parts received records
 */
function etkMergeLines(tree, sidecar) {
  const ln = sidecar && sidecar.ln;
  if (!ln || !tree) return 0;
  let n = 0;
  const groups = tree.maingroups
    ? tree.maingroups.flatMap((mg) => mg.groups || [])
    : tree.groups || [];
  for (const g of groups)
    for (const d of g.diagrams || []) {
      const byKey = ln[d.btnr];
      if (!byKey) continue;
      for (const p of d.parts || []) {
        if (Array.isArray(p.ln) && p.ln.length) continue;
        const recs = byKey[etkLineKey(p)];
        if (recs && recs.length) {
          p.ln = recs;
          n += 1;
        }
      }
    }
  return n;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { etkLineKey, etkLineFits, etkMergeLines };
}
