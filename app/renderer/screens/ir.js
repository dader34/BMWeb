// What the live .IPO runtime (screens/ipo-runtime.js) borrows from the module
// view: the shipped bytecode per SGBD, INPA's input dialogs, the job names a
// key's body can send, and the exact-dictionary caption translation
// (irLabel). The derived renderer that once drew screens from
// data/inpa-ir/<ECU>.json is gone -- the module view is the running script.

// The SGBD whose SCRIPT draws: the configured base when the car identified a
// variant that ships no .IPO of its own (INPA loads one script per address).
function irExecSgbd(ecu) {
  return String((ecu && (ecu._irFrom || ecu.sgbd)) || '').toLowerCase();
}

// {procs, byid} for an ECU, fetched once. null when the ECU ships no runnable
// twin (an orphan, or a pre-phase-1 archive) -- callers fall back to frozen IR.
const _ipoExecCache = new Map();
function irLiveExec(sgbd) {
  const key = String(sgbd).toLowerCase();
  if (!_ipoExecCache.has(key)) {
    _ipoExecCache.set(
      key,
      api(`/api/ecu/${key}/ipoexec`)
        .then((x) => (x && x.procs ? x : null))
        .catch(() => null)
    );
  }
  return _ipoExecCache.get(key);
}

// One INPA ask, in INPA's own words. The driven VM suspends at every input
// builtin; this renders the right dialog for its kind and returns what
// resume() stores: a number (inputint/inputnum), a hex STRING (inputhex),
// 1/0 from the two-choice box (inputdigital), or an ARRAY for the two-field
// forms (input2int's Kalenderwoche/Jahr) -- one element per out-ref. null =
// cancelled, and the keypress is abandoned.
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
      kind: hex ? 'text' : 'number',
      example: hex ? '' : step.lo != null ? String(step.lo) : '',
      confirmLabel: 'OK',
    });
    if (asked == null || String(asked).trim() === '') return null;
    if (hex) {
      vals.push(String(asked).trim());
      continue;
    }
    const n = Math.trunc(Number(asked));
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

// The key's body in its menu proc: [toks, bodyStart, bodyEnd], or null when

// Every job name an item's body (and its helpers, one level) can send.
function irItemBodyJobs(exec, toks, i0, end) {
  const out = [];
  const scan = (tk, a, b, depth) => {
    for (let i = a; i < Math.min(b, tk.length); i++) {
      const t = tk[i];
      if (t.op === 'call' && /^INP.?apiJob/.test(t.name || '')) {
        for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
          const c = tk[j];
          if (
            c.op === 'const' &&
            c.t === 's' &&
            /^[A-Z][A-Z0-9_]{3,}$/.test(String(c.v))
          ) {
            if (!out.includes(c.v)) out.push(c.v);
            break;
          }
          if (c.op === 'frame') break;
        }
      } else if (t.op === 'calluser' && depth < 2) {
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
let _irI18n = null;
let _irI18nNorm = null;
let _irSharedNorm = null;
function irUseTranslations(ir) {
  _irI18n = (ir && ir.i18n) || null;
  _irI18nNorm = null;
}
function irI18nShared() {
  return (typeof window !== 'undefined' && window.BMW_I18N_SHARED) || null;
}

// The .IPO prints a caption padded to its column ("Drehzahl      :") and the
// same words appear elsewhere trimmed; both mean one thing. Look the string up
// as written, then by its collapsed form, and put the original's leading
// indentation back so a translated cell keeps its place on the grid.
function irI18nKey(s) {
  return String(s)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*[:=]\s*$/, '');
}
function irNormMap(map) {
  const out = new Map();
  for (const k of Object.keys(map)) {
    const nk = irI18nKey(k);
    if (nk && !out.has(nk)) out.set(nk, map[k]);
  }
  return out;
}
// INPA's key-legend notation: a menu screen prints "< F4  >   Fehlerspeicher
// lesen" or "< Shift > + < F6 >  EWS" as ONE string. The caption after the
// key is what the dictionaries carry, so it is looked up on its own and the
// key prefix is kept as printed. Syntax of the notation only, no word rules.
const IR_KEY_LEGEND =
  /^(\s*(?:<\s*Shift\s*>\s*\+\s*)?<\s*F\s*\d+\s*>\s*)(\S.*)$/i;
function irLabel(s) {
  if (!s) return s;
  // "Function labels: Original (EDIABAS)" shows BMW's own strings verbatim --
  // no i18n lookup. The setting is global (lang() in core.js).
  if (typeof lang === 'function' && lang() === 'orig') return s;
  const shared = irI18nShared();
  if (!_irI18n && !shared) return s;
  const legend = typeof s === 'string' ? s.match(IR_KEY_LEGEND) : null;
  if (legend) {
    const has = (m) => m && Object.prototype.hasOwnProperty.call(m, s);
    if (!has(_irI18n) && !has(shared)) return legend[1] + irLabel(legend[2]);
  }
  const has = (m) => m && Object.prototype.hasOwnProperty.call(m, s);
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
