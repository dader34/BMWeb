/**
 * @file The catalogue's own line filter: which rows of a diagram a given car
 * gets, the way the ETK program decides it (docs/etk-filter-rules.md,
 * tools/etk_rules.py is the same logic in Python and the oracle this was
 * checked against).
 *
 * THE BUNDLE'S FIT LIST IS ONLY THE FIRST TEST. A diagram line is for a set
 * of model columns (the part's `fit`), AND for a steering side, a gearbox
 * and a window of build months, AND under an equipment rule: "B" might be
 * "with high-gloss shadow line", "D" "with headlight washers", "AR4" column
 * 4 of a decision table over three options. The catalogue evaluates those
 * rules in three-valued logic -- an option it cannot decide counts as true,
 * so an undecidable line is shown -- and once a rule IS decided, the
 * untagged fallback rows at that callout disappear, more specific rules
 * beat their over-rules, and the '--' rows hanging under a removed line go
 * with it. Then wiring-harness age rows, VIN changepoints, car-age rows and
 * PG rules.
 *
 * The data rides in the <CHASSIS>.rules.json.gz sidecar (tools/etk_import.py
 * --rules): per diagram the rules and one record per line, aligned to the
 * bundle's parts order and carrying the part number so the alignment is
 * proven before it is trusted (etkRulesMerge). The car is ETK_STATE plus
 * the garage's order codes and the reader's answers to the conditions the
 * catalogue would ask about (etkRulesCar).
 */

/** The three truth values the catalogue's rules take. */
const ETK_T = 'T';
const ETK_F = 'F';
const ETK_U = '?';

/**
 * Bedingung.ODER: three-valued OR.
 * @param {string} a - T, F or ?
 * @param {string} b - T, F or ?
 * @returns {string}
 */
export function etkOder(a, b) {
  if (a === ETK_T || b === ETK_T) return ETK_T;
  if (a === ETK_U || b === ETK_U) return ETK_U;
  return ETK_F;
}

/**
 * Bedingung.UND: three-valued AND.
 * @param {string} a - T, F or ?
 * @param {string} b - T, F or ?
 * @returns {string}
 */
export function etkUnd(a, b) {
  if (a === ETK_F || b === ETK_F) return ETK_F;
  if (a === ETK_U || b === ETK_U) return ETK_U;
  return ETK_T;
}

/**
 * WebetkUtils.modifyDate on a YYYYMM month.
 * @param {number} ym - YYYYMM
 * @param {number} months - how many months to shift, may be negative
 * @returns {number} YYYYMM
 */
export function etkShiftMonth(ym, months) {
  let y = Math.floor(ym / 100);
  let m = (ym % 100) - 1 + months;
  y += Math.floor(m / 12);
  m = ((m % 12) + 12) % 12;
  return y * 100 + m + 1;
}

/**
 * YYYYMM as the catalogue prints it, MM/YYYY (lines.js has the same; this
 * file stands alone in node).
 * @param {number} ym - the month
 * @returns {string}
 */
function etkRuleMonth(ym) {
  const t = String(ym || '');
  return t.length >= 6 ? `${t.slice(4, 6)}/${t.slice(0, 4)}` : '';
}

/**
 * The 'T' group's boolean expression over option codes: !, &&, ||,
 * parentheses, codes. An unknown option reads as false.
 * @param {string} expr - the expression as the catalogue stores it
 * @param {Object<string, boolean>} env - code -> fitted
 * @returns {boolean}
 */
export function etkEvalBool(expr, env) {
  const toks = String(expr).match(/&&|\|\||[!()]|[A-Za-z0-9_]+/g) || [];
  let pos = 0;
  const peek = () => (pos < toks.length ? toks[pos] : null);
  const take = () => toks[pos++];
  const bad = (t) => {
    throw new Error(`bad rule expression near ${t}`);
  };
  const atom = () => {
    const t = take();
    if (t === '!') return !atom();
    if (t === '(') {
      const v = orx();
      if (take() !== ')') bad(')');
      return v;
    }
    if (t == null || t === '&&' || t === '||' || t === ')') bad(t);
    return !!env[t];
  };
  const andx = () => {
    let v = atom();
    while (peek() === '&&') {
      take();
      const r = atom();
      v = r && v;
    }
    return v;
  };
  const orx = () => {
    let v = andx();
    while (peek() === '||') {
      take();
      const r = andx();
      v = r || v;
    }
    return v;
  };
  const v = orx();
  if (peek() != null) bad(peek());
  return v;
}

/**
 * Element.setAusweisung(String): the car's answer for one option -- '0'
 * unknown, '1' fitted, '2' not fitted -- becomes T/F/? per rule column,
 * honouring the element's sign and the decision-table row.
 * @param {{vz: string, regel: string, ausw: string}} e - the element
 * @param {string} value - '0', '1' or '2'
 * @returns {void}
 */
function etkElementSet(e, value) {
  const regel = e.regel || null;
  const v = value == null ? '0' : String(value);
  const a = e.ausw.split('');
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '-') continue;
    const rz = regel ? regel[i] : 'X';
    if (v === '0') {
      a[i] = ETK_U;
      continue;
    }
    if ((rz === 'X' && e.vz === '+') || (rz === '0' && e.vz === '-'))
      a[i] = v === '1' ? ETK_T : ETK_F;
    if ((rz === 'X' && e.vz === '-') || (rz === '0' && e.vz === '+'))
      a[i] = v === '1' ? ETK_F : ETK_T;
  }
  e.ausw = a.join('');
}

/**
 * One rule's verdict char at a column.
 * @param {{ausw: string}} x - an element or group
 * @param {number} i - the column
 * @returns {string}
 */
function etkAuswAt(x, i) {
  if (!x.ausw) return ' ';
  if (x.ausw.length === 1) return x.ausw[0];
  return x.ausw[i];
}

/**
 * Write a verdict char at a column.
 * @param {{ausw: string}} x - an element or group
 * @param {string} c - the char
 * @param {number} i - the column
 * @returns {void}
 */
function etkAuswSet(x, c, i) {
  if (!x.ausw || x.ausw.length <= 1) {
    x.ausw = c;
    return;
  }
  x.ausw = x.ausw.slice(0, i) + c + x.ausw.slice(i + 1);
}

/**
 * Obergruppe.auswertenIndex: fold the elements at one column.
 * @param {{vart: string, elems: object[], ausw: string}} og - the group
 * @param {number} i - the column
 * @returns {boolean} every value known
 */
function etkGroupIndex(og, i) {
  let known = true;
  let c = ' ';
  const orx = og.vart === 'O' || og.vart === 'R';
  const andx = ['U', 'A', 'E', 'B'].includes(og.vart);
  for (const e of og.elems) {
    const ec = etkAuswAt(e, i);
    if (orx) c = etkOder(ec, c);
    if (andx) c = etkUnd(ec, c);
    if (c === ETK_U) known = false;
    etkAuswSet(og, c, i);
    if ((orx && (c === ETK_U || c === ETK_T)) || (andx && c === ETK_F)) break;
  }
  return known;
}

/**
 * Obergruppe.auswerten.
 * @param {{vart: string, fzeile: string, elems: object[], ausw: string}} og - the group
 * @returns {boolean} every value known
 */
function etkGroupEval(og) {
  if (['O', 'U', 'A', 'R'].includes(og.vart)) return etkGroupIndex(og, 0);
  if (og.vart === 'E' || og.vart === 'B') {
    let known = false;
    for (let i = 0; i < og.ausw.length; i++)
      if (og.ausw[i] !== '-' && etkGroupIndex(og, i)) known = true;
    return known;
  }
  if (og.vart === 'T') {
    if (!og.fzeile) return false;
    const env = {};
    for (const e of og.elems) env[e.code] = e.ausw === ETK_T;
    try {
      etkAuswSet(og, etkEvalBool(og.fzeile, env) ? ETK_T : ETK_F, 0);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** The catalogue's rewrite table for a rule's term, in its order. */
const ETK_TERM_REWRITES = [
  ['T&T', 'T'],
  ['T&F', 'F'],
  ['T&?', '?'],
  ['F&T', 'F'],
  ['F&F', 'F'],
  ['F&?', 'F'],
  ['?&T', '?'],
  ['?&F', 'F'],
  ['?&?', '?'],
  ['T/T', 'T'],
  ['T/F', 'T'],
  ['T/?', 'T'],
  ['F/T', 'T'],
  ['F/F', 'F'],
  ['F/?', '?'],
  ['?/T', 'T'],
  ['?/F', '?'],
  ['?/?', '?'],
  ['(T)', 'T'],
  ['(F)', 'F'],
  ['(?)', '?'],
  ['-T', 'F'],
  ['-F', 'T'],
  ['-?', '?'],
  ['+T', 'T'],
  ['+F', 'F'],
  ['+?', '?'],
];

/**
 * Bedingung.auswertenIndex: substitute each group's verdict into the term
 * and reduce it.
 * @param {{vz: string, term: string, ogs: object[], ausw: string}} bed - the rule
 * @param {number} i - the column
 * @returns {string} T or F
 */
function etkRuleIndex(bed, i) {
  if (!bed.term) return ' ';
  let term = bed.term.replace(/ /g, '');
  for (const og of bed.ogs) term = term.split(og.id).join(etkAuswAt(og, i));
  while (term.length > 1) {
    const before = term.length;
    for (const [src, dst] of ETK_TERM_REWRITES)
      term = term.split(src).join(dst);
    if (term.length === before) {
      term = ETK_T; // "nicht auswertbar => wird auf T gesetzt"
      break;
    }
  }
  let c = term[0];
  if (bed.vz === '-') c = c === ETK_T ? ETK_F : ETK_T;
  if (c === ETK_U) c = ETK_T;
  etkAuswSet(bed, c, i);
  return c;
}

/**
 * Bedingung.auswerten: which of the rule's keys hold for the car, and
 * whether each was fully decided (no unknown anywhere).
 * @param {{k: string, vz: string, term: string, ogs: object[], ausw: string}} bed - the rule
 * @returns {Object<string, boolean>} rule key -> decided
 */
function etkRuleEval(bed) {
  let complete = true;
  for (const og of bed.ogs) {
    if (og.vart === 'E' || og.vart === 'B') {
      const etVz = bed.term ? bed.term[0] : '';
      if (bed.vz === '-' && etVz === '-') {
        bed.vz = '+';
        bed.term = bed.term.slice(1);
      } else if (bed.vz === '-' || etVz === '-') {
        bed.vz = '+';
        if (etVz === '-') bed.term = bed.term.slice(1);
        // a negated decision table: swap the X and 0 columns
        og.fzeile = og.fzeile
          .split('')
          .filter((c) => c === 'X' || c === '0')
          .map((c) => (c === 'X' ? '0' : 'X'))
          .join('');
        og.ausw = og.fzeile
          .split('')
          .map((c) => (c === 'X' ? ' ' : '-'))
          .join('');
        bed.ausw = og.ausw;
      }
    }
    if (og.vart === 'T' && bed.vz === '-' && og.fzeile)
      og.fzeile = `!(${og.fzeile})`;
    if (!etkGroupEval(og)) complete = false;
  }
  const out = {};
  const n = bed.ausw.length;
  for (let i = 1; i <= n; i++) {
    if (bed.ausw[i - 1] === '-') continue;
    const c = etkRuleIndex(bed, i - 1);
    if (c !== ETK_F) out[bed.k + (n > 1 ? String(i) : '')] = complete;
  }
  return out;
}

/**
 * CurrentBTE.ladenBedingungenFzg: the sidecar's rule record as the
 * evaluator's tree, decision-table rows generated the catalogue's way.
 * @param {{k: string, vz: string, t: string, og: Array}} r - a sidecar rule
 * @returns {{k: string, vz: string, term: string, ausw: string, ogs: object[]}}
 */
function etkRuleTree(r) {
  const bed = { k: r.k, vz: r.vz || '', term: r.t || '', ausw: ' ', ogs: [] };
  for (const [ogid, vart, fz, members] of r.og || []) {
    const fzeile = fz || '';
    const og = {
      id: ogid,
      vart: vart || '',
      fzeile,
      elems: [],
      ausw: ' ',
    };
    const et = vart === 'E' || vart === 'B';
    if (et) {
      og.ausw = fzeile
        .split('')
        .map((c) => (c === 'X' ? ' ' : '-'))
        .join('');
      bed.ausw = og.ausw;
    }
    let npos = 1;
    for (const [evz, elemid] of members || []) {
      let ausw = ' ';
      let regel = '';
      if (et) {
        ausw =
          bed.vz === '+'
            ? fzeile.replace(/X/g, ' ').replace(/0/g, '-')
            : fzeile.replace(/X/g, '-').replace(/0/g, ' ');
        const n = fzeile.length;
        const half = Math.floor(n / 2 ** npos);
        for (let a = 0; a < 2 ** (npos - 1); a++)
          regel += 'X'.repeat(half) + '0'.repeat(half);
        npos += 1;
      }
      og.elems.push({
        vz: evz || '+',
        elemid: String(elemid),
        regel,
        ausw,
        code: '',
      });
    }
    bed.ogs.push(og);
  }
  return bed;
}

/**
 * Does an option code the car carries name this element? The garage's
 * order words come in several spellings: S760A, 760A, 760, $760.
 * @param {string} code - the element's code, S760A
 * @param {string} word - the car's word
 * @returns {boolean}
 */
export function etkRulesCodeMatches(code, word) {
  const w = String(word || '')
    .trim()
    .toUpperCase()
    .replace(/^\$/, '');
  const c = String(code || '').toUpperCase();
  if (!w || !c) return false;
  if (w === c) return true;
  const m = /^([A-Z])?([0-9A-Z]{3})([A-Z])?$/.exec(w);
  if (!m) return false;
  const [, art, pnr, hz] = m;
  return (
    c.slice(1, 4) === pnr &&
    (!art || c[0] === art) &&
    (!hz || c.slice(4) === hz)
  );
}

/**
 * The car's own codes as element values: every option element the order
 * names, valid at the build month (BMW reused the numbers).
 * @param {string[]} elemids - the elements the diagram's rules mention
 * @param {Object<string, Array>} el - the sidecar's element table
 * @param {{prod?: number|null, sa?: string[]}} car - the car
 * @returns {Object<string, string>} elemid -> '1'
 */
function etkInterfaceValues(elemids, el, car) {
  const out = {};
  const words = (car.sa || []).filter(Boolean);
  if (!words.length) return out;
  const prod8 = car.prod ? Number(car.prod) * 100 : null;
  for (const id of elemids) {
    const inf = el[id];
    if (!inf || inf[0] !== 'S' || !inf[1]) continue;
    if (!words.some((w) => etkRulesCodeMatches(inf[1], w))) continue;
    const [, , , , , gv, gb] = inf;
    if (prod8 && gv && Number(gv) > prod8) continue;
    if (prod8 && gb && Number(gb) < prod8) continue;
    out[id] = '1';
  }
  return out;
}

/**
 * Bedingungsmenge.insertBedingungen: the value '0'/'1'/'2' of every element
 * for this car. The order's codes are '1'; when any are known, every other
 * non-retrofittable option is '2'; in an exclusive group a '1' forces the
 * siblings to '2'; everything else is '0' = unknown; the reader's answers
 * override.
 * @param {string[]} elemids - the elements the diagram's rules mention
 * @param {Object<string, Array>} el - the sidecar's element table
 * @param {{prod?: number|null, sa?: string[], answers?: Object<string, string>}} car - the car
 * @returns {{values: Object<string, string>, iface: Object<string, string>}}
 */
function etkConditionValues(elemids, el, car) {
  const values = {};
  const groups = {};
  const iface = etkInterfaceValues(elemids, el, car);
  const hasIface = Object.keys(iface).length > 0;
  const ids = elemids.slice().sort((a, b) => Number(a) - Number(b));
  for (const id of ids) {
    const g = el[id] && el[id][3];
    if (g) (groups[g] = groups[g] || []).push(id);
  }
  for (const id of ids) if (iface[id]) values[id] = '1';
  for (const id of ids) {
    if (values[id]) continue;
    const inf = el[id] || [];
    let val = '0';
    const g = inf[3];
    if (g && (groups[g] || []).some((o) => values[o] === '1')) val = '2';
    if (inf[0] === 'S' && hasIface && !inf[4]) val = '2';
    values[id] = val;
  }
  const answers = car.answers || {};
  for (const id of Object.keys(answers))
    if (['0', '1', '2'].includes(answers[id])) values[id] = answers[id];
  for (const id of Object.keys(values)) {
    const g = values[id] === '1' && el[id] ? el[id][3] : null;
    if (!g) continue;
    for (const o of groups[g] || [])
      if (o !== id && values[o] !== '1') values[o] = '2';
  }
  return { values, iface };
}

/**
 * The lines the catalogue loads for the car: one per bundle part that fits
 * the variant, in order, with the sidecar's line record, the callout number
 * the '--' rows inherit, and what is per-variant resolved.
 * @param {{parts: object[], rules: object}} d - the diagram with its sidecar record
 * @param {{variant: number|null}} car - the car
 * @returns {object[]|null} null when the sidecar does not line up
 */
function etkRuleLines(d, car) {
  const R = d.rules;
  if (!R || !Array.isArray(R.ln) || R.ln.length !== (d.parts || []).length)
    return null;
  const out = [];
  let merk = 0;
  for (let i = 0; i < d.parts.length; i++) {
    const p = d.parts[i];
    const r = R.ln[i];
    if (!r || String(r[0] || '').trim() !== String(p.sachnr || '').trim())
      return null;
    if (p.fit && car.variant != null && !p.fit.includes(car.variant)) continue;
    const [, callout, key, g, b, f, t, s, a, pg, extra] = r;
    const co = callout == null ? '' : String(callout);
    if (co && co !== '--') {
      const n = parseInt(co, 10);
      merk = Number.isFinite(n) ? n : 0;
    } else if (!co) merk = 0;
    const ln = {
      i,
      sachnr: p.sachnr,
      callout: co,
      cint: merk,
      key: key || null,
      g: g || 0,
      b: b || 0,
      f: f || 0,
      t: t || 0,
      s: s || '',
      a: a || '',
      pg: pg || null,
      alt: false,
      age: null,
      cps: [],
      why: null,
    };
    if (extra) {
      if (extra.alt && car.variant != null && extra.alt.includes(car.variant))
        ln.alt = true;
      if (extra.age && car.variant != null && extra.age[String(car.variant)])
        ln.age = extra.age[String(car.variant)];
      if (extra.cp)
        ln.cps = extra.cp.filter(
          (c) => !c[0] || car.variant == null || c[0].includes(car.variant)
        );
    }
    out.push(ln);
  }
  return out;
}

/**
 * CurrentBTE.auswertenEinschraenkungFzg: steering, gearbox and build month
 * per line, last line up; a numbered line takes the '--' lines under it
 * that fail the same test.
 * @param {object[]} lines - the lines, edited in place
 * @param {{prod?: number|null, steer?: string|null, auto?: string|null, byVin?: boolean}} car - the car
 * @param {object[]} gone - removed lines collect here
 * @returns {void}
 */
function etkRestrict(lines, car, gone) {
  const steer = car.steer || null;
  const gear = car.auto || null;
  const prod = car.prod ? Number(car.prod) : null;
  if (!steer && !gear && !prod) return;
  const byVin = !!car.byVin;
  const kill = (i, why, test) => {
    const ln = lines[i];
    if (ln.callout !== '--') {
      let j = i + 1;
      while (j < lines.length && lines[j].callout === '--') {
        if (test(lines[j])) {
          lines[j].why = `${why} (with its main row)`;
          gone.push(lines[j]);
          lines.splice(j, 1);
        } else j += 1;
      }
    }
    ln.why = why;
    gone.push(ln);
    lines.splice(i, 1);
  };
  const einsOf = (z) => etkShiftMonth(z.f, byVin ? 0 : -2);
  const auslOf = (z) => etkShiftMonth(z.t, byVin ? -1 : 1);
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i];
    if (steer && ln.s && ln.s !== steer)
      kill(
        i,
        `for ${ln.s === 'L' ? 'left' : 'right'}-hand drive`,
        (z) => z.s && z.s !== steer
      );
    else if (gear && ln.a && ln.a !== gear)
      kill(
        i,
        `for ${ln.a === 'A' ? 'automatic' : 'manual'} gearbox`,
        (z) => z.a && z.a !== gear
      );
    else if (prod) {
      if (ln.f && prod < einsOf(ln))
        kill(
          i,
          `from ${etkRuleMonth(ln.f)}, after the car`,
          (z) => z.f && prod < einsOf(z)
        );
      else if (ln.t && prod > auslOf(ln))
        kill(
          i,
          `up to ${etkRuleMonth(ln.t)}, before the car`,
          (z) => z.t && prod > auslOf(z)
        );
    }
  }
}

/**
 * CurrentBTE.removeZeilenNichtRelevant and its passes.
 * @param {object[]} lines - the lines, edited in place
 * @param {Object<string, boolean>|null} relevant - rule key -> decided, for the keys that hold
 * @param {Object<string, string[]>} ueber - rule -> its over-rules
 * @param {string|null} bed - the rule the whole diagram is under
 * @param {object[]} gone - removed lines collect here
 * @returns {void}
 */
function etkApplyRules(lines, relevant, ueber, bed, gone) {
  const strip = (k) =>
    String(k)
      .replace(/[0-9]*/g, '')
      .trim();
  const drop = (i, why) => {
    const ln = lines[i];
    ln.why = why;
    gone.push(ln);
    lines.splice(i, 1);
  };
  if (bed != null) {
    const held =
      relevant && Object.keys(relevant).some((k) => strip(k) === bed);
    if (!held) {
      while (lines.length)
        drop(0, `the diagram is under rule ${bed}, which fails`);
      return;
    }
  }
  const blocks = [];
  const addBlock = (b) => {
    if (b && !blocks.includes(b)) blocks.push(b);
  };
  const dropHanging = (i, why) => {
    while (i < lines.length && lines[i].callout === '--') drop(i, why);
  };
  // ByBed: a tagged line whose rule did not hold
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.key != null && (!relevant || !(ln.key in relevant))) {
      addBlock(ln.b);
      drop(i, `rule ${ln.key} does not hold for the car`);
      dropHanging(i, `under a line of rule ${ln.key}`);
      i -= 1;
    }
  }
  // OhneBed: a callout decided by a rule loses its untagged fallback lines
  if (relevant && Object.keys(relevant).length) {
    const decided = [];
    for (const ln of lines)
      if (ln.key != null && relevant[ln.key] === true) {
        if (!decided.includes(ln.cint)) decided.push(ln.cint);
        addBlock(ln.b);
      }
    for (const bp of decided)
      for (let i = 0; i < lines.length; i++)
        if (lines[i].cint === bp && lines[i].key == null) {
          drop(
            i,
            `callout ${bp} is decided by a rule; the untagged line yields`
          );
          i -= 1;
        }
  }
  // ByUeberBed: a line yields to a same-group line under a decided over-rule
  if (
    relevant &&
    Object.keys(relevant).length &&
    ueber &&
    Object.keys(ueber).length
  ) {
    const sameCps = (x, y) =>
      x.length === y.length && JSON.stringify(x) === JSON.stringify(y);
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (ln.key == null || !(ln.key in relevant)) continue;
      let hit = null;
      for (const ku of ueber[ln.key] || []) {
        if (relevant[ku] !== true) continue;
        if (
          lines.some(
            (z) =>
              z.g === ln.g &&
              z.key === ku &&
              ((!z.cps.length && z.callout !== '--') ||
                (ln.cps.length && sameCps(z.cps, ln.cps)))
          )
        ) {
          hit = ku;
          break;
        }
      }
      if (hit) {
        addBlock(ln.b);
        drop(i, `over-rule ${hit} takes precedence over ${ln.key}`);
        dropHanging(i, `under a line over-rule ${hit} removed`);
        i -= 1;
      }
    }
  }
  // checkZeilenByBlockNr: a block that lost a line loses its '--' lines
  for (const b of blocks)
    for (let i = 0; i < lines.length; i++)
      if (lines[i].b === b && lines[i].callout === '--') {
        drop(i, `its block lost a line`);
        i -= 1;
      }
}

/**
 * Changepoint.auswertenChangepointDatum.
 * @param {string} art - FROM or TO
 * @param {number|null} datum - YYYYMMDD
 * @param {number} prod8 - the car's YYYYMMDD (day 00 when month-exact)
 * @returns {boolean} the line is still relevant
 */
function etkCpDate(art, datum, prod8) {
  if (!prod8 || datum == null) return true;
  let d = String(datum);
  let p = String(prod8);
  if (p.length !== 8) return true;
  if (p.slice(6) === '00') {
    d = d.slice(0, 6);
    p = p.slice(0, 6);
  }
  return art === 'FROM' ? Number(p) >= Number(d) : Number(p) <= Number(d);
}

/**
 * Changepoint.auswertenChangepointVin.
 * @param {string} art - FROM or TO
 * @param {string|null} vinCp - the changeover production number
 * @param {number|null} vinProd - its month
 * @param {string|null} vinMin - the range start
 * @param {number} prod8 - the car's YYYYMMDD
 * @param {string} vin - the car's production number
 * @returns {boolean}
 */
function etkCpVin(art, vinCp, vinProd, vinMin, prod8, vin) {
  if (!prod8 || vinCp == null) return true;
  const p = Number(String(prod8).slice(0, 6));
  const d = Number(vinProd);
  const V = String(vin).toUpperCase();
  const min = String(vinMin || '').toUpperCase();
  const cp = String(vinCp).toUpperCase();
  if (art === 'FROM') {
    if (p > d) return true;
    if (p < d) return false;
    return V >= min && V >= cp;
  }
  if (p < d) return true;
  if (p > d) return false;
  return V >= min && V <= cp;
}

/**
 * Changepoint.auswertenChangePointKB: an age cut-off, months before today.
 * @param {string} art - FROM or TO
 * @param {number|null} alter - months
 * @param {number} prod8 - the car's YYYYMMDD
 * @returns {boolean}
 */
function etkCpAge(art, alter, prod8) {
  if (alter == null) return true;
  const now = new Date();
  const d = new Date(
    now.getFullYear(),
    now.getMonth() - Number(alter),
    Math.min(now.getDate(), 28)
  );
  const cutoff =
    d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  if (art === 'FROM') return !(prod8 >= cutoff);
  return !(prod8 <= cutoff);
}

/**
 * CurrentBTE.auswertenChangepoints: the diagram's own window first, then
 * each line's cut-ins for the car's type and plant. Needs a VIN; without a
 * plant only the diagram's own window applies, as in the catalogue.
 * @param {object[]} lines - the lines, edited in place
 * @param {Array<[string, number]>} bteCps - the diagram's changepoints
 * @param {{vin?: string|null, prod?: number|null, typ?: string|null, werk?: string|null}} car - the car
 * @param {object[]} gone - removed lines collect here
 * @returns {void}
 */
function etkChangepoints(lines, bteCps, car, gone) {
  if (!car.vin || !car.prod) return;
  const prod8 = Number(car.prod) * 100;
  if ((bteCps || []).some(([art, datum]) => !etkCpDate(art, datum, prod8))) {
    for (const ln of lines) {
      ln.why = 'the diagram is outside its changepoint window';
      gone.push(ln);
    }
    lines.length = 0;
    return;
  }
  if (!car.typ || !car.werk) return;
  let dropHang = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (dropHang && ln.callout === '--') {
      ln.why = 'under a changepoint-removed line';
      gone.push(ln);
      lines.splice(i, 1);
      i -= 1;
      continue;
    }
    dropHang = false;
    let ok = true;
    if (!ln.cps.length) ok = !ln.alt;
    else
      for (const [
        ,
        typ,
        werk,
        art,
        datum,
        vinCp,
        vinProd,
        vinMin,
        ,
        alter,
      ] of ln.cps) {
        if (typ !== car.typ) continue;
        if (werk === 'NN') {
          ok = true;
          break;
        }
        if (werk !== car.werk) continue;
        if (
          !etkCpDate(art, datum, prod8) ||
          !etkCpVin(art, vinCp, vinProd, vinMin, prod8, car.vin) ||
          !etkCpAge(art, alter, prod8)
        ) {
          ok = false;
          break;
        }
      }
    if (!ok) {
      dropHang = ln.callout !== '--';
      ln.why = 'not built in for this VIN, plant and date';
      gone.push(ln);
      lines.splice(i, 1);
      i -= 1;
    }
  }
}

/**
 * The evaluation of one diagram for one car.
 * @typedef {object} EtkRulesResult
 * @property {boolean} applies - the sidecar lined up and a variant is chosen
 * @property {Set<number>} keep - indices into diagram.parts that survive
 * @property {Array<{i: number, sachnr: string, callout: string, why: string}>} removed - the rest, with why
 * @property {Array<{k: string, verdict: 'decided'|'open'|'false'}>} rules - the rules that apply, with their verdict
 * @property {Array<{id: string, kind: string, code: string, name: string, value: string, fromOrder: boolean, saz: boolean}>} conds - the options the rules ask about, with the car's value
 */

/**
 * CurrentBTE for one diagram and one car: the rows the catalogue shows.
 * @param {{btnr: string, parts: object[], rules?: object}} d - the diagram, with its sidecar record (etkRulesMerge)
 * @param {object} car - the car (etkRulesCar)
 * @returns {EtkRulesResult}
 */
export function etkRulesEvaluate(d, car) {
  const none = {
    applies: false,
    keep: new Set((d.parts || []).map((_, i) => i)),
    removed: [],
    rules: [],
    conds: [],
  };
  const R = d.rules;
  if (!R || car.variant == null) return none;
  const lines = etkRuleLines(d, car);
  if (!lines) return none;
  const el = R.el || {};
  const gone = [];
  // 2. steering, gearbox, build month
  etkRestrict(lines, car, gone);
  // 3. the equipment rules
  const rules = (R.rules || [])
    .filter((r) => !r.fit || r.fit.includes(car.variant))
    .map(etkRuleTree);
  const elemids = [];
  for (const bed of rules)
    for (const og of bed.ogs)
      for (const e of og.elems)
        if (!elemids.includes(e.elemid)) elemids.push(e.elemid);
  const { values, iface } = etkConditionValues(elemids, el, car);
  let relevant = null;
  if (rules.length) {
    relevant = {};
    for (const bed of rules) {
      for (const og of bed.ogs)
        for (const e of og.elems) {
          etkElementSet(e, values[e.elemid] || '0');
          e.code = (el[e.elemid] && el[e.elemid][1]) || '';
        }
      Object.assign(relevant, etkRuleEval(bed));
    }
    const keys = rules.map((r) => r.k);
    const ueber = {};
    for (const k of Object.keys(R.ueber || {}))
      if (keys.includes(k) || (R.ueber[k] || []).some((u) => keys.includes(u)))
        ueber[k] = R.ueber[k];
    etkApplyRules(lines, relevant, ueber, R.bed || null, gone);
  }
  // 4. wiring-harness age rows need a dealer VIN with a day-exact date
  for (let i = 0; i < lines.length; i++)
    if (lines[i].alt) {
      lines[i].why = 'a wiring-harness age row (needs a day-exact build date)';
      gone.push(lines[i]);
      lines.splice(i, 1);
      i -= 1;
    }
  // 5. changepoints
  etkChangepoints(lines, R.cp || [], car, gone);
  // 6. car age
  if (car.prod) {
    const y = Math.floor(Number(car.prod) / 100);
    const m = Number(car.prod) % 100;
    const months = (Date.now() - new Date(y, m - 1, 1).getTime()) / 2.628e9;
    for (let i = 0; i < lines.length; i++) {
      const a = lines[i].age;
      if (
        a &&
        a[1] &&
        ((a[0] === 'A' && months < a[1]) || (a[0] === 'B' && months > a[1]))
      ) {
        lines[i].why =
          `only for cars ${a[0] === 'A' ? 'older' : 'younger'} than ${a[1]} months`;
        gone.push(lines[i]);
        lines.splice(i, 1);
        i -= 1;
      }
    }
  }
  // 7. PG rules on '--' lines
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.callout === '--' && ln.pg && (!relevant || !(ln.pg in relevant))) {
      ln.why = `PG rule ${ln.pg} does not hold`;
      gone.push(ln);
      lines.splice(i, 1);
      i -= 1;
    }
  }
  const verdict = (k) => {
    const held = Object.keys(relevant || {}).filter(
      (x) => x.replace(/[0-9]*/g, '') === k
    );
    if (!held.length) return 'false';
    return held.every((x) => relevant[x] === true) ? 'decided' : 'open';
  };
  return {
    applies: true,
    keep: new Set(lines.map((ln) => ln.i)),
    removed: gone
      .map((ln) => ({
        i: ln.i,
        sachnr: ln.sachnr,
        callout: ln.callout,
        why: ln.why,
      }))
      .sort((a, b) => a.i - b.i),
    rules: rules.map((r) => ({ k: r.k, verdict: verdict(r.k) })),
    conds: elemids.map((id) => {
      const inf = el[id] || [];
      return {
        id,
        kind: inf[0] || 'T',
        code: inf[1] || '',
        name: inf[2] || '',
        value: values[id] || '0',
        fromOrder: !!iface[id],
        saz: !!inf[4],
      };
    }),
  };
}

/**
 * Put the sidecar's records onto the tree's diagrams, each proven to line
 * up with the bundle's parts (same count, same part number at every index)
 * before it is attached; a diagram whose record does not line up keeps the
 * plain filter.
 * @param {{maingroups?: object[], groups?: object[]}} tree - the bundle's tree
 * @param {{v?: number, el?: object, dg?: object}|null} sidecar - the parsed file
 * @returns {number} how many diagrams received records
 */
export function etkRulesMerge(tree, sidecar) {
  const dg = sidecar && sidecar.dg;
  if (!dg || !tree) return 0;
  const el = sidecar.el || {};
  let n = 0;
  const groups = tree.maingroups
    ? tree.maingroups.flatMap((mg) => mg.groups || [])
    : tree.groups || [];
  for (const g of groups)
    for (const d of g.diagrams || []) {
      const rec = dg[d.btnr];
      if (!rec || !Array.isArray(rec.ln)) continue;
      const parts = d.parts || [];
      if (rec.ln.length !== parts.length) continue;
      if (
        !rec.ln.every(
          (r, i) =>
            r &&
            String(r[0] || '').trim() === String(parts[i].sachnr || '').trim()
        )
      )
        continue;
      d.rules = { ...rec, el };
      n += 1;
    }
  return n;
}

/**
 * The car the filter judges by, from the catalogue state and the garage.
 * @param {object} st - ETK_STATE
 * @returns {object}
 */
export function etkRulesCar(st) {
  const vin = st.vin ? String(st.vin).toUpperCase().replace(/\s/g, '') : null;
  return {
    variant: st.variant,
    prod: st.prod || null,
    steer: st.steer || null,
    auto: st.auto || null,
    byVin: !!vin,
    vin: vin ? vin.slice(-7) : null,
    typ: st.typ || null,
    werk: st.werk || null,
    sa: Array.isArray(st.sa) ? st.sa : [],
    answers: st.answers || {},
  };
}

/**
 * A key that changes whenever the car the filter judges by changes, so an
 * evaluation can be cached per diagram.
 * @param {object} st - ETK_STATE
 * @returns {string}
 */
export function etkRulesCarKey(st) {
  return JSON.stringify(etkRulesCar(st));
}
