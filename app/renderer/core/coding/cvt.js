/**
 * @file The value each coding function takes for one car: BMW's CVT
 * (data/cvt.js, tools/decompile/ncs_cvt.py) evaluated against the car's
 * equipment. Published as the `CodingCvt` global.
 *
 * NCS Expert codes a module "from the vehicle order" with this table, and
 * Process car codes every module that way. As the factory tool does it
 * (CVT_PROC.C GetCvtFile, read out of NCSEXPER.exe): EXACTLY ONE rule of
 * each GRUPPE group must hold for the car -- none, or more than one, and it
 * refuses to code (errors 0x116B / 0x119A); the holding rule's entries are
 * applied in order, a later one overwriting an earlier, and a later group
 * overwriting an earlier one's value for the same function. An entry naming
 * a function without a value leaves it "no value" (0xFFFF), which stops a
 * coding that needs the function. INDIVID groups name the functions the
 * driver personalises (Key Memory); those are reported, never given a value.
 *
 * The predicates speak the chassis's keyword ids (CodingSelect.aswIds); the
 * chassis's own keyword (E46 is id 1, the rule of feste_Daten_E46) holds for
 * every car of it and is added here. Functions and values are named as the
 * coding files name them, so a module's read (moduleFunctions) is matched by
 * name. A name of the form `#<id>` is a keyword BMW's tables lack: it is
 * reported, and nothing is decided for it.
 */
(function (root) {
  /**
   * @typedef {Object} CvtTarget
   * @property {string|null} psw - the value; null for an entry that names
   *   the function without one.
   * @property {string} group - the CVT group that decided it.
   * @property {string} expr - the rule that held.
   */

  /**
   * @typedef {Object} CvtTargets
   * @property {Map<string, CvtTarget>} values - FSW (upper case) -> value.
   * @property {Set<string>} personal - FSWs (upper case) the driver
   *   personalises under a rule that holds.
   * @property {string[]} undecided - GRUPPE groups none of whose rules held.
   * @property {string[]} unnamed - `group: FSW = PSW` entries naming a
   *   keyword BMW's tables lack.
   * @property {string[]} ambiguous - GRUPPE groups more than one of whose
   *   rules held.
   * @property {string[]} errors - why the factory tool would refuse to code
   *   from this order (a group with no holding rule, or several).
   */

  /**
   * Evaluate the chassis's CVT for a car.
   * @param {string} chassisId - chassis id (E46).
   * @param {number[]} equipment - the car's keyword ids (CodingSelect.aswIds).
   * @param {object} [cvt] - BMW_CVT; the loaded global when omitted.
   * @param {object} [tables] - BMW_TABLES; the loaded global when omitted.
   * @returns {CvtTargets|null} null when the chassis has no CVT.
   */
  function targets(chassisId, equipment, cvt, tables) {
    const ch = String(chassisId || '').toUpperCase();
    const data = (cvt || root.BMW_CVT || {})[ch];
    if (!data) return null;
    const ids = new Set(equipment || []);
    const asw = ((tables || root.BMW_TABLES || {})[ch] || {}).asw || {};
    if (asw[ch] != null) ids.add(asw[ch]);
    const A = root.CodingAuftrag;
    const has = (id) => ids.has(id);
    const holds = (rule) => {
      if (!rule.exprHex) return true;
      const bytes = rule.exprHex.match(/../g).map((h) => parseInt(h, 16));
      return A.evalTree(A.compile(bytes).tree, has);
    };

    /** @type {CvtTargets} */
    const out = {
      values: new Map(),
      personal: new Set(),
      undecided: [],
      unnamed: [],
      ambiguous: [],
      errors: [],
    };
    const put = (fsw, psw, g, rule) => {
      if (fsw.startsWith('#') || (psw && psw.startsWith('#'))) {
        out.unnamed.push(`${g.name}: ${fsw} = ${psw}`);
        return;
      }
      out.values.set(fsw.toUpperCase(), {
        psw,
        group: g.name,
        expr: rule.expr,
      });
    };
    for (const g of data.groups || []) {
      if (g.kind === 'INDIVID') {
        for (const rule of g.rules)
          if (holds(rule))
            for (const f of rule.fsw) out.personal.add(f.toUpperCase());
        continue;
      }
      const held = g.rules.filter(holds);
      if (!held.length) {
        out.undecided.push(g.name);
        out.errors.push(`no rule of group ${g.name} holds for the car`);
        continue;
      }
      if (held.length > 1) {
        out.ambiguous.push(g.name);
        out.errors.push(
          `${held.length} rules of group ${g.name} hold for the car (${held
            .map((r) => r.expr || 'always')
            .join(' | ')})`
        );
      }
      for (const rule of held) {
        for (const [fsw, psw] of rule.set) put(fsw, psw, g, rule);
        for (const fsw of rule.fsw || []) put(fsw, null, g, rule);
      }
    }
    return out;
  }

  /**
   * FSW_PSW.MAN that codes a module's functions to the car's values: every
   * function the CVT decides, flush left, its value after a tab. Personal
   * functions are left out (the driver's choice stays), and so are the ones
   * the module's description marks as not coding data. A function the order
   * does not decide is coded as the factory tool codes it (the netto build,
   * CBD_PROC.C): with its only value when it has one, and not at all when it
   * has several -- the factory refuses (error 8), and so does `refused`. A
   * function the order names without a value is refused too (error 0x11).
   * @param {Array<{name: string, values?: Array<[string, string]>}> &
   *   {codingLocked?: Set<string>}} fns - the module's functions
   *   (moduleFunctions).
   * @param {CvtTargets} t - from targets().
   * @returns {{text: string, count: number, personal: string[],
   *   unknown: string[], single: string[], refused: string[]}} the MAN, how
   *   many functions it sets, the personal functions left alone, the
   *   functions the CVT decides nothing for, those of them coded with their
   *   only value, and why the factory would refuse.
   */
  function man(fns, t) {
    const lines = [];
    const personal = [];
    const unknown = [];
    const single = [];
    const refused = [];
    for (const f of fns || []) {
      if (fns.codingLocked && fns.codingLocked.has(f.name)) continue;
      const key = String(f.name).toUpperCase();
      if (t.personal.has(key)) {
        personal.push(f.name);
        continue;
      }
      const v = t.values.get(key);
      if (v && v.psw == null) {
        refused.push(`${f.name}: the order names it without a value`);
        continue;
      }
      if (v) {
        lines.push(f.name, `\t${v.psw}`);
        continue;
      }
      unknown.push(f.name);
      const opts = (f.values || []).map(([name]) => name);
      if (opts.length === 1) {
        single.push(f.name);
        lines.push(f.name, `\t${opts[0]}`);
      } else
        refused.push(
          `${f.name}: the order decides nothing for it and it has ${opts.length} values`
        );
    }
    return {
      text: lines.join('\r\n') + (lines.length ? '\r\n' : ''),
      count: lines.length / 2,
      personal,
      unknown,
      single,
      refused,
    };
  }

  const api = { targets, man };
  root.CodingCvt = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
