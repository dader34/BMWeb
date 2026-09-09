/**
 * @file Comparing two stored scans. Pure data in, pure data out -- the screen
 * draws what this returns and the harness pins it without a DOM.
 *
 * What a fault is matched on: the module it sits in (SGBD, the variant that
 * answered) plus the fault's own identity within that module. A stored fault
 * carries both a hex code (F_HEX_CODE) and a location number (F_ORT_NR); the
 * hex is the DTC and is preferred, and the location number is the fallback
 * for the older modules that report no hex. Matching on the text would make a
 * translation change look like a different fault.
 *
 * Presence (F_VORHANDEN / "currently present" vs merely stored) is NOT part of
 * the identity: the same fault going from stored-only to present is the same
 * fault, and is reported as unchanged rather than as one cleared and one new.
 */

/* exported garageFaultKeys, garageDiffScans, garageFaultKey, garageDiffCounts */

/**
 * What changed between two scans.
 * @typedef {object} GarageDiff
 * @property {GarageScan} from - the older scan
 * @property {GarageScan} to - the newer scan
 * @property {'faults'|'ident'|'mixed'} kind - what the two reads were
 * @property {GarageDiffModule[]} modules - per module, in the newer scan's order
 * @property {GarageDiffSilence[]} silence - modules whose answering changed
 */

/**
 * One module's changes.
 * @typedef {object} GarageDiffModule
 * @property {string} sgbd
 * @property {string} label
 * @property {object[]} added - faults only the newer scan has
 * @property {object[]} cleared - faults only the older scan has
 * @property {object[]} same - faults in both
 * @property {object[]} recurred - of those, the ones logged again since (a
 *   higher occurrence count, or a different freeze frame)
 * @property {GarageDiffField[]} fields - ident fields whose value changed
 * @property {boolean} changed - anything at all differs
 */

/**
 * One ident field that moved.
 * @typedef {object} GarageDiffField
 * @property {string} key - the EDIABAS result name (ID_SW_NR, ...)
 * @property {string} label - its caption
 * @property {string} from - the older value ('' when absent)
 * @property {string} to - the newer value ('' when absent)
 */

/**
 * A module whose answering changed between the two reads.
 * @typedef {object} GarageDiffSilence
 * @property {string} target - the address or SGBD
 * @property {string} label
 * @property {'silent'|'answering'} state - 'silent' = answered before, quiet now
 * @property {string} [error] - the failure the newer scan recorded
 */

/**
 * The identity of one fault inside its module: the DTC where the module
 * reports one, else its location number, else the code its text leads with.
 * @param {object} code - an FS_LESEN entry
 * @returns {string} a stable key, '' when the entry names none of them
 */
function garageFaultKey(code) {
  return garageFaultKeys(code)[0] || '';
}

/**
 * EVERY identity a fault carries, strongest first. Two reads of the same
 * module do not always carry the same fields for the same fault: one read
 * has F_HEX_CODE and the next has only F_ORT_NR, one F_ORT_TEXT leads with
 * the DTC ("27C3 DMTL ...") and the next is the bare description -- so a
 * fault is matched on ANY identity it shares with the other read, or the
 * one fault shows up as cleared AND new.
 * @param {object} code - an FS_LESEN entry
 * @returns {string[]} keys: 'H:<hex digits>' (from F_HEX_CODE or the text's leading DTC), 'N:<location nr>'
 */
function garageFaultKeys(code) {
  const c = code || {};
  const out = [];
  // "27C3" from one read and "27-C3" (bytes joined by hexText) from another
  // are the same hex: only the digits are the identity
  const hex = String(c.F_HEX_CODE == null ? '' : c.F_HEX_CODE)
    .trim()
    .toUpperCase()
    .replace(/^0X/, '')
    .replace(/[^0-9A-F]/g, '');
  if (hex) out.push('H:' + hex);
  const nr = c.F_ORT_NR;
  if (nr != null && String(nr).trim() !== '' && Number.isFinite(Number(nr)))
    out.push('N:' + String(Number(nr)));
  // the DTC a fault text leads with IS the hex code, so it shares the hex
  // namespace: a read that carries only the text still meets one that
  // carries only F_HEX_CODE
  const m = /^([0-9A-F]{3,5})\b/i.exec(String(c.F_ORT_TEXT || '').trim());
  if (m) {
    const t = 'H:' + m[1].toUpperCase();
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * Index a report's modules by SGBD.
 * @param {object} report - a stored report
 * @returns {Map<string, object>}
 */
function garageModuleMap(report) {
  const m = new Map();
  for (const mod of (report && report.modules) || [])
    m.set(String(mod.sgbd || '').toLowerCase(), mod);
  return m;
}

/**
 * Index a module's faults by identity. An entry naming neither a hex nor a
 * location number cannot be matched, so it is left out of the comparison
 * rather than being reported as both added and cleared every time.
 * @param {object} mod - a module record
 * @returns {Map<string, object>}
 */
function garageFaultMap(mod) {
  const m = new Map();
  for (const c of (mod && mod.codes) || []) {
    for (const k of garageFaultKeys(c)) if (!m.has(k)) m.set(k, c);
  }
  return m;
}

/**
 * The counterpart of a fault in the other read: the entry sharing any of
 * its identities.
 * @param {Map<string, object>} map - the other read's fault map
 * @param {object} code - the fault to find
 * @returns {object|null}
 */
function garageFaultMatch(map, code) {
  for (const k of garageFaultKeys(code)) {
    const hit = map.get(k);
    if (hit) return hit;
  }
  return null;
}

/**
 * The ident fields that differ between two module records, in the order the
 * protocol prints them.
 * @param {object} a - the older module record
 * @param {object} b - the newer module record
 * @returns {GarageDiffField[]}
 */
function garageIdentFields(a, b) {
  const ia = (a && a.ident) || null;
  const ib = (b && b.ident) || null;
  if (!ia && !ib) return [];
  const rows =
    typeof IPO_IDENT_ROWS !== 'undefined'
      ? IPO_IDENT_ROWS
      : [[['VARIANTE'], 'Variant']];
  const out = [];
  const seen = new Set();
  const val = (id, k) => (id && id[k] != null ? String(id[k]).trim() : '');
  for (const [keys, cap] of rows) {
    for (const k of keys) {
      seen.add(k);
      const from = val(ia, k);
      const to = val(ib, k);
      if (from !== to)
        out.push({
          key: k,
          label: keys.length > 1 ? `${cap} (${k})` : cap,
          from,
          to,
        });
    }
  }
  // anything the module answered that the printed table does not cover still
  // counts as a change -- a new coding index matters whether or not it has a
  // caption
  const extra = new Set([...Object.keys(ia || {}), ...Object.keys(ib || {})]);
  for (const k of extra) {
    if (seen.has(k) || k.startsWith('_')) continue;
    const from = val(ia, k);
    const to = val(ib, k);
    if (from !== to) out.push({ key: k, label: k, from, to });
  }
  return out;
}

/**
 * Compare two stored scans, older against newer.
 * @param {GarageScan} from - the older scan
 * @param {GarageScan} to - the newer scan
 * @returns {GarageDiff}
 */
function garageDiffScans(from, to) {
  const ra = (from && from.report) || { modules: [], silent: [] };
  const rb = (to && to.report) || { modules: [], silent: [] };
  const A = garageModuleMap(ra);
  const B = garageModuleMap(rb);
  const kind = ra.kind === rb.kind ? rb.kind || 'faults' : 'mixed';

  /** @type {GarageDiffModule[]} */
  const modules = [];
  // the newer scan's order first, then anything only the older one saw
  const order = [...B.keys(), ...[...A.keys()].filter((k) => !B.has(k))];
  for (const sgbd of order) {
    const a = A.get(sgbd);
    const b = B.get(sgbd);
    const fa = garageFaultMap(a);
    const added = [];
    const cleared = [];
    const same = [];
    // a fault present in both is unchanged unless its freeze frame moved: a
    // new occurrence count, or different values captured, means the module
    // logged it again since the last read
    const recurred = [];
    const matched = new Set(); // the older read's entries that found a partner
    for (const c of (b && b.codes) || []) {
      if (!garageFaultKeys(c).length) continue; // nothing to match on
      const old = garageFaultMatch(fa, c);
      if (!old) {
        added.push(c);
        continue;
      }
      matched.add(old);
      same.push(c);
      if (typeof garageEnvSummary === 'function') {
        const s = garageEnvSummary(old, c);
        if (s.recurred) recurred.push(c);
      }
    }
    for (const c of (a && a.codes) || [])
      if (garageFaultKeys(c).length && !matched.has(c)) cleared.push(c);
    const fields = kind === 'faults' ? [] : garageIdentFields(a, b);
    modules.push({
      sgbd,
      label: (b && b.label) || (a && a.label) || sgbd,
      added,
      cleared,
      same,
      recurred,
      fields,
      changed: !!(
        added.length ||
        cleared.length ||
        fields.length ||
        recurred.length
      ),
    });
  }

  // answering changed: a module that answered before and is quiet now (or the
  // other way round). Reading the silent lists alone would miss a module that
  // simply stopped being asked, so both sides are checked.
  const silentA = new Map(
    (ra.silent || []).map((s) => [String(s.target || '').toLowerCase(), s])
  );
  const silentB = new Map(
    (rb.silent || []).map((s) => [String(s.target || '').toLowerCase(), s])
  );
  /** @type {GarageDiffSilence[]} */
  const silence = [];
  for (const [t, s] of silentB)
    if (!silentA.has(t))
      silence.push({
        target: t,
        label: s.label || t.toUpperCase(),
        state: 'silent',
        error: s.error,
      });
  for (const [t, s] of silentA)
    if (!silentB.has(t))
      silence.push({
        target: t,
        label: s.label || t.toUpperCase(),
        state: 'answering',
      });

  return { from, to, kind, modules, silence };
}

/**
 * The headline counts of a diff.
 * @param {GarageDiff} diff - the comparison
 * @returns {{added: number, cleared: number, same: number, fields: number, silence: number, modules: number}}
 */
function garageDiffCounts(diff) {
  const mods = (diff && diff.modules) || [];
  const n = (pick) => mods.reduce((t, m) => t + m[pick].length, 0);
  return {
    added: n('added'),
    cleared: n('cleared'),
    same: n('same'),
    recurred: n('recurred'),
    fields: n('fields'),
    silence: ((diff && diff.silence) || []).length,
    modules: mods.filter((m) => m.changed).length,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    garageDiffScans,
    garageFaultKey,
    garageFaultKeys,
    garageDiffCounts,
    garageIdentFields,
  };
}
