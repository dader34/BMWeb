/**
 * @file What the live .IPO runtime (screens/ipo-runtime/) borrows from the
 * module view: the shipped bytecode per SGBD, INPA's input dialogs, the job
 * names a key's body can send, and the exact-dictionary caption translation
 * (irLabel). The derived renderer that once drew screens from
 * data/inpa-ir/<ECU>.json is gone -- the module view is the running script.
 */

/** How many helper levels irItemBodyJobs follows into calluser bodies. */
const IR_JOB_SCAN_DEPTH = 2;

/** How many tokens before an INPAapiJob call its job-name constant may sit. */
const IR_JOB_LOOKBACK = 8;

/** A job name as the scripts write them: upper-case, at least four chars. */
const IR_JOB_NAME_RE = /^[A-Z][A-Z0-9_]{3,}$/;

/** The INPAapiJob / INP1apiJob call names. */
const IR_JOB_CALL_RE = /^INP.?apiJob/;

/**
 * The SGBD whose SCRIPT draws: the configured base when the car identified a
 * variant that ships no .IPO of its own (INPA loads one script per address).
 * @param {object} ecu - the module ({_irFrom, sgbd})
 * @returns {string} lower-case SGBD name
 */
function irExecSgbd(ecu) {
  return String((ecu && (ecu._irFrom || ecu.sgbd)) || '').toLowerCase();
}

/** @type {Map<string, Promise<object|null>>} exec per SGBD, fetched once */
const _irExecCache = new Map();

/**
 * {procs, byid} for an ECU, fetched once. null when the ECU ships no runnable
 * twin (an orphan, or a pre-phase-1 archive).
 * @param {string} sgbd - SGBD name
 * @returns {Promise<object|null>}
 */
function irLiveExec(sgbd) {
  const key = String(sgbd).toLowerCase();
  if (!_irExecCache.has(key)) {
    _irExecCache.set(
      key,
      api(`/api/ecu/${key}/ipoexec`)
        .then((x) => (x && x.procs ? x : null))
        .catch(() => null)
    );
  }
  return _irExecCache.get(key);
}

/**
 * Put an exec into the cache under a name, so the runtime finds it there
 * instead of fetching one.
 *
 * A script the user supplied is decoded in the browser and has no URL to be
 * fetched from. Seeding it here is what lets it open through the ordinary
 * module path -- same program driver, same confirmations, same write gates --
 * rather than through a second runtime that would have to re-earn that trust.
 * The entry lives only as long as the page.
 *
 * @param {string} sgbd - the name to file it under
 * @param {object|null} exec - {procs, byid}
 * @returns {void}
 */
function irSeedExec(sgbd, exec) {
  _irExecCache.set(String(sgbd).toLowerCase(), Promise.resolve(exec || null));
}

/**
 * One INPA ask, in INPA's own words. The driven VM suspends at every input
 * builtin; this renders the right dialog for its kind and returns what
 * resume() stores: a number (inputint/inputnum), a hex STRING (inputhex),
 * 1/0 from the two-choice box (inputdigital), or an ARRAY for the two-field
 * forms (input2int's Kalenderwoche/Jahr) -- one element per out-ref.
 * @param {IpoStep} step - the input suspension ({name, prompts, refs, lo, hi})
 * @param {string} [fallbackTitle] - the title when the script gave no prompt
 * @returns {Promise<number|string|Array<number|string>|null>} null =
 *   cancelled, and the keypress is abandoned
 */
async function irAskInput(step, fallbackTitle) {
  const refs = Math.max(1, Number(step.refs || 1));
  const name = String(step.name || '');
  const tr = (x) => esc(irLabel(x || '') || x || '');
  const p0 = step.prompts[0] || fallbackTitle || '';
  const p1 = step.prompts[1] || '';
  if (name === 'inputdigital') {
    // (out bool, title, text, FalseStr, TrueStr): the box offers the two
    // words, nothing else -- INPA's yes/no. Which word PROCEEDS is the
    // script's business (IHKA46 asks "Are you sure? yes/no" with yes = 0 and
    // sends on 0), so neither button may double as "dismiss": Esc and the
    // backdrop cancel the run instead of answering with one of them.
    const f = step.prompts[step.prompts.length - 2] || 'OFF';
    const t = step.prompts[step.prompts.length - 1] || 'ON';
    const yes = await confirmDialog({
      title: tr(p0),
      body: tr(p1),
      confirmLabel: tr(t),
      cancelLabel: tr(f),
      dismissValue: null,
    });
    if (yes == null) return null;
    return yes ? 1 : 0;
  }
  // (out, title, text) with nothing else: INPA's plain OK/Cancel box -- the
  // fault-memory clear asks "Do you really want to delete the error-memory?
  // <OK>-Key or <Return>-Key clears!" and then tests getinputstate == 0.
  // There is no value to type; asking for a number blocked the clear.
  if (name === 'builtin_3f' && step.prompts.length <= 2 && refs === 1) {
    const yes = await confirmDialog({
      title: tr(p0),
      body: tr(p1),
      confirmLabel: 'OK',
      cancelLabel: 'Cancel',
      dismissValue: null,
    });
    return yes ? 0 : null;
  }
  const hex = /hex/i.test(name);
  // input2text and its kin ask for words (a comment to save with the
  // protocol), and an empty line is an answer there, not a cancel
  const text = /text/i.test(name);
  // inputnum asks for a real: decimals stay
  const real = name === 'inputnum';
  const vals = [];
  for (let k = 0; k < refs; k++) {
    // a two-field form captions each field after the title/help pair
    const cap =
      refs > 1 ? step.prompts[2 + k] || `${p0} (${k + 1}/${refs})` : p1;
    const asked = await inputDialog({
      title: tr(p0),
      body:
        tr(cap) +
        (step.lo != null && step.hi != null && !hex
          ? `<br><br>Accepted range <b>${step.lo}</b> to <b>${step.hi}</b>.`
          : ''),
      kind: hex || text ? 'text' : 'number',
      example: hex || text ? '' : step.lo != null ? String(step.lo) : '',
      confirmLabel: 'OK',
    });
    if (asked == null) return null;
    if (text) {
      vals.push(String(asked));
      continue;
    }
    if (String(asked).trim() === '') return null;
    if (hex) {
      vals.push(String(asked).trim());
      continue;
    }
    const n = real ? Number(asked) : Math.trunc(Number(asked));
    if (!Number.isFinite(n)) return null;
    if (
      refs === 1 &&
      step.lo != null &&
      step.hi != null &&
      (n < step.lo || n > step.hi)
    )
      return null;
    vals.push(n);
  }
  return refs > 1 ? vals : vals[0];
}

/**
 * Every job name an item's body (and its helpers, one level) can send: the
 * job-name constant pushed before each INPAapiJob call.
 * @param {object} exec - the decoded script ({procs, byid})
 * @param {IpoToken[]} toks - the menu proc's tokens
 * @param {number} i0 - first token index of the body
 * @param {number} end - token index the body ends at (exclusive)
 * @returns {string[]}
 */
function irItemBodyJobs(exec, toks, i0, end) {
  const out = [];
  const scan = (tk, a, b, depth) => {
    for (let i = a; i < Math.min(b, tk.length); i++) {
      const t = tk[i];
      if (t.op === 'call' && IR_JOB_CALL_RE.test(t.name || '')) {
        for (let j = i - 1; j >= Math.max(0, i - IR_JOB_LOOKBACK); j--) {
          const c = tk[j];
          if (
            c.op === 'const' &&
            c.t === 's' &&
            IR_JOB_NAME_RE.test(String(c.v))
          ) {
            if (!out.includes(c.v)) out.push(c.v);
            break;
          }
          if (c.op === 'frame') break;
        }
      } else if (t.op === 'calluser' && depth < IR_JOB_SCAN_DEPTH) {
        const nm = (exec.byid || {})[`func:${t.n}`];
        const body = nm && exec.procs[nm];
        if (Array.isArray(body)) scan(body, 0, body.length, depth + 1);
      }
    }
  };
  scan(toks, i0, end, 0);
  return out;
}

// ---- captions: exact dictionaries only -----------------------------------
// Per-ECU map from data/inpa-i18n/<ECU>.json (shipped as ir.i18n), then the
// shared INPA chrome table (data/i18n-shared.js). No word rules: a caption
// with no entry shows as BMW wrote it.

/** @type {Record<string, string>|null} the current ECU's caption map */
let _irI18n = null;
/** @type {Map<string, string>|null} that map keyed by collapsed caption */
let _irI18nNorm = null;
/** @type {(Map<string, string> & {src?: object})|null} the shared table, collapsed */
let _irSharedNorm = null;

/**
 * Take an ECU's caption dictionary as the current one.
 * @param {{i18n?: Record<string, string>}|null} ir - the ECU's shipped IR
 * @returns {void}
 */
function irUseTranslations(ir) {
  _irI18n = (ir && ir.i18n) || null;
  _irI18nNorm = null;
}

/**
 * The shared INPA chrome table, when data/i18n-shared.js is loaded.
 * @returns {Record<string, string>|null}
 */
function irI18nShared() {
  return (typeof window !== 'undefined' && window.BMW_I18N_SHARED) || null;
}

/**
 * A caption's lookup form. The .IPO prints a caption padded to its column
 * ("Drehzahl      :") and the same words appear elsewhere trimmed; both mean
 * one thing, so whitespace collapses and a trailing ':' or '=' is dropped.
 * @param {string} s - the caption
 * @returns {string}
 */
function irI18nKey(s) {
  return String(s)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*[:=]\s*$/, '');
}

/**
 * A dictionary keyed by collapsed caption (first entry wins).
 * @param {Record<string, string>} map - the dictionary
 * @returns {Map<string, string>}
 */
function irNormMap(map) {
  const out = new Map();
  for (const k of Object.keys(map)) {
    const nk = irI18nKey(k);
    if (nk && !out.has(nk)) out.set(nk, map[k]);
  }
  return out;
}

/**
 * INPA's key-legend notation: a menu screen prints "< F4  >   Fehlerspeicher
 * lesen" or "< Shift > + < F6 >  EWS" as ONE string. The caption after the
 * key is what the dictionaries carry, so it is looked up on its own and the
 * key prefix is kept as printed. Syntax of the notation only, no word rules.
 * Group 1 = the key prefix as printed, 2 = the caption.
 * @type {RegExp}
 */
const IR_KEY_LEGEND =
  /^(\s*(?:<\s*Shift\s*>\s*\+\s*)?<\s*F\s*\d+\s*>\s*)(\S.*)$/i;

/**
 * Translate a caption through the exact dictionaries: the ECU's own map,
 * then the shared table, first as written, then by its collapsed form with
 * the original's leading indentation and trailing ':' put back so a
 * translated cell keeps its place on the grid. "Function labels: Original
 * (EDIABAS)" (lang() === 'orig') shows BMW's own strings verbatim.
 * @param {string} s - the caption as the script printed it
 * @returns {string} the translation, or `s` when no dictionary has it
 */
function irLabel(s) {
  if (!s) return s;
  if (typeof lang === 'function' && lang() === 'orig') return s;
  const shared = irI18nShared();
  if (!_irI18n && !shared) return s;
  const has = (m) => m && Object.prototype.hasOwnProperty.call(m, s);
  const legend = typeof s === 'string' ? s.match(IR_KEY_LEGEND) : null;
  if (legend && !has(_irI18n) && !has(shared)) {
    return legend[1] + irLabel(legend[2]);
  }
  if (has(_irI18n)) return _irI18n[s];
  if (has(shared)) return shared[s];
  const str = String(s);
  const nk = irI18nKey(str);
  let hit = null;
  if (_irI18n) {
    if (!_irI18nNorm) _irI18nNorm = irNormMap(_irI18n);
    hit = _irI18nNorm.get(nk);
  }
  if (hit == null && shared) {
    if (!_irSharedNorm || _irSharedNorm.src !== shared) {
      _irSharedNorm = irNormMap(shared);
      _irSharedNorm.src = shared;
    }
    hit = _irSharedNorm.get(nk);
  }
  if (hit == null) return s;
  const lead = (str.match(/^\s*/) || [''])[0];
  const tail = (str.match(/\s*[:=]?\s*$/) || [''])[0];
  return lead + hit + tail;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    irExecSgbd,
    irLiveExec,
    irSeedExec,
    irAskInput,
    irItemBodyJobs,
    irUseTranslations,
    irLabel,
  };
}
