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

/* exported etkLineFits, etkMergeLines, etkLineKey, etkDisplayLine, etkRows, etkMonth */

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
 * YYYYMM as the catalogue prints it, MM/YYYY.
 * @param {number|undefined} ym - the month
 * @returns {string} '' when there is none
 */
function etkMonth(ym) {
  const s = String(ym || '');
  return s.length >= 6 ? `${s.slice(4, 6)}/${s.slice(0, 4)}` : '';
}

/**
 * The line a part row shows: with a car, the first line that fits it; without
 * one, the first line. A part with no line records shows none.
 * @param {{ln?: EtkLine[]}} p - a part row
 * @param {EtkCarFacts|null} car - what is known
 * @returns {EtkLine|null}
 */
function etkDisplayLine(p, car) {
  const lines = p && Array.isArray(p.ln) ? p.ln : null;
  if (!lines || !lines.length) return null;
  if (car && (car.prod || car.steer || car.auto))
    return lines.find((ln) => etkOneLineFits(ln, car)) || lines[0];
  return lines[0];
}

/**
 * The table's rows, the way the catalogue lays them out: one row per callout
 * and part number, and the parts that share a callout GROUPED under it. A
 * callout with one part is a plain row; one with several (alternatives by
 * date, condition or fitting) is a collapsed row that expands to them.
 *
 * The bundle lists a part once per catalogue line, so a part on two lines of
 * the same callout arrives twice; those fold into one row carrying both
 * lines, and the line shown is the one that fits the car (etkDisplayLine).
 * @param {EtkPart[]} parts - the parts to draw (already filtered to the car)
 * @param {EtkCarFacts|null} car - what is known
 * @returns {Array<{pos: string, name: string, items: Array<{part: EtkPart, line: EtkLine|null}>}>}
 */
function etkRows(parts, car) {
  /** @type {Map<string, {part: EtkPart, lines: EtkLine[]}>} */
  const byKey = new Map();
  const order = [];
  for (const p of parts || []) {
    const key = etkLineKey(p);
    let e = byKey.get(key);
    if (!e) {
      e = { part: { ...p }, lines: [] };
      byKey.set(key, e);
      order.push(key);
    }
    for (const ln of (Array.isArray(p.ln) && p.ln) || [])
      if (!e.lines.some((x) => JSON.stringify(x) === JSON.stringify(ln)))
        e.lines.push(ln);
    if (!e.part.sup && p.sup) e.part.sup = p.sup;
  }
  /** @type {Map<string, {pos: string, name: string, items: object[]}>} */
  const groups = new Map();
  const out = [];
  for (const key of order) {
    const e = byKey.get(key);
    const part = e.lines.length ? { ...e.part, ln: e.lines } : e.part;
    const pos = String(part.pos == null ? '' : part.pos);
    let g = groups.get(pos);
    if (!g) {
      g = { pos, name: String(part.name || ''), items: [] };
      groups.set(pos, g);
      out.push(g);
    }
    g.items.push({ part, line: etkDisplayLine(part, car) });
  }
  for (const g of out)
    if (!g.items.every((it) => String(it.part.name || '') === g.name))
      g.name = String(g.items[0].part.name || '');
  return out;
}

/**
 * Put a sidecar's line records onto the tree's parts. Inline records win:
 * a bundle built with them needs nothing from the sidecar. The sidecar's
 * per-part supplements (the ETK's Supplement column) land the same way.
 * @param {{maingroups?: object[], groups?: object[]}} tree - the bundle's tree
 * @param {{v?: number, ln?: Object<string, Object<string, EtkLine[]>>}|null} sidecar - the parsed file
 * @returns {number} how many parts received records
 */
function etkMergeLines(tree, sidecar) {
  const ln = sidecar && sidecar.ln;
  if (!ln || !tree) return 0;
  const sup = (sidecar && sidecar.sup) || {};
  let n = 0;
  const groups = tree.maingroups
    ? tree.maingroups.flatMap((mg) => mg.groups || [])
    : tree.groups || [];
  for (const g of groups)
    for (const d of g.diagrams || []) {
      const byKey = ln[d.btnr] || {};
      for (const p of d.parts || []) {
        if (!p.sup && sup[p.sachnr]) p.sup = sup[p.sachnr];
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
  module.exports = {
    etkLineKey,
    etkLineFits,
    etkMergeLines,
    etkDisplayLine,
    etkRows,
    etkMonth,
  };
}
