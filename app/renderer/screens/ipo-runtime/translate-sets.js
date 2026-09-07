/**
 * @file ENGLISH FOR WHAT A JOB RETURNS. The script reads F_ORT_TEXT,
 * F_SYMPTOM_TEXT, F_READY_TEXT... and glues them into its own lines before
 * it paints, so by paint time there is one string nobody can split; the swap
 * has to happen on the result values as they are fed to the VM. Exact
 * dictionary lookups only (phraseText: the fault phrase tables and the
 * generated fault-location dictionary), plus the fault-code lookup the fault
 * screen uses for a location whose text has no entry but whose number the
 * ECU's own codespace knows. A string without an entry is fed exactly as the
 * ECU sent it; Original mode feeds everything untouched. Captions the .IPO
 * prints itself are not this: irLabel handles those at paint.
 */

/** A P-code text: "P1128 " + the fault location + " - " + the fault type. */
const IPO_PCODE_RE = /^(P[0-9A-F]{4}\s+)([\s\S]*)$/i;

/** The result keys of a fault's freeze-frame (Umwelt) labels and values. */
const IPO_ENV_TEXT_KEY_RE = /^F_(UW|FF)\d*_TEXT$/;
const IPO_ENV_VALUE_KEY_RE = /^F_(UW|FF)\d*_WERT$/;

/** The result keys of a fault's P-code text. */
const IPO_PCODE_KEY_RE = /^F_PCODE7?_TEXT$/;

/**
 * Whether fed results are translated: the dictionaries are loaded and the
 * language setting is not Original.
 * @returns {boolean}
 */
function ipoTranslating() {
  return (
    typeof phraseText === 'function' &&
    typeof lang === 'function' &&
    lang() !== 'orig'
  );
}

/**
 * F_ORT_TEXT: the phrase dictionary, else the code. The code is the one the
 * text leads with ("27DA BSD-Generator", kept as a prefix because the ECU
 * wrote it there) or F_HEX_CODE, else the 16-bit F_ORT_NR when a codespace
 * knows it whole (a DTC, not a location+detail word). The ECU's own
 * codespace outranks the flat DB: 27C3 is the oil-level sensor on the E46
 * MS45 and something else elsewhere.
 * @param {Record<string, string>} set - the result set the text belongs to
 * @param {string} text - the F_ORT_TEXT value
 * @param {string} sgbd - the SGBD that answered (its codespace)
 * @returns {string}
 */
function ipoLocationText(set, text, sgbd) {
  const hit = phraseText(text);
  if (hit !== text) return hit;
  const own = typeof scopedFaultDb === 'function' ? scopedFaultDb(sgbd) : null;
  const flat = (typeof window !== 'undefined' && window.BMW_FAULT_DB) || null;
  if (!own && !flat) return text;
  const codes = [];
  const led =
    typeof bmwCode === 'function' ? bmwCode(text, set.F_HEX_CODE) : null;
  if (led) codes.push({ code: led, flatOk: true });
  const full = typeof ortNrFull === 'function' ? ortNrFull(set.F_ORT_NR) : null;
  if (full) codes.push({ code: full, flatOk: !own });
  for (const { code, flatOk } of codes) {
    const name = (own && own[code]) || (flatOk && flat && flat[code]) || null;
    if (!name) continue;
    return new RegExp(`^${code}\\b`, 'i').test(String(text).trim())
      ? `${code} ${name}`
      : name;
  }
  return text;
}

/**
 * F_PCODE_TEXT, translated part by part: the code prefix is kept, the fault
 * location (FO) and the fault type (FA) are each a dictionary string of
 * their own; a part with no entry stays German.
 * @param {string} v - the value
 * @returns {string}
 */
function ipoPcodeText(v) {
  const whole = phraseText(v);
  if (whole !== v) return whole;
  const m = String(v).match(IPO_PCODE_RE);
  const code = m ? m[1] : '';
  const rest = m ? m[2] : String(v);
  const parts = rest.split(' - ');
  if (parts.length < 2) return v;
  const en = parts.map((x) => phraseText(x.trim()));
  if (en.every((x, i) => x === parts[i].trim())) return v;
  return code + en.join(' - ');
}

/**
 * Freeze-frame (Umwelt) labels and their enum values have their own curated
 * dictionary (envLabel over envmap.js): "(Motor) - Öltemperatur" -> "Engine
 * oil temperature", "0 ES - Motor steht" -> "0 ES - engine stopped".
 * @param {string} v - the value
 * @returns {string}
 */
function ipoEnvText(v) {
  const e = typeof envLabel === 'function' ? envLabel(v) : v;
  return e !== v ? e : phraseText(v);
}

/**
 * One result set with its *_TEXT strings in English where a dictionary
 * carries them; every other value, and every string without an entry, as
 * sent. A new object: the wire's answer is not rewritten in place.
 * @param {Record<string, *>} set - a result set
 * @param {string} sgbd - the SGBD that answered
 * @returns {Record<string, *>}
 */
function ipoTranslateSet(set, sgbd) {
  const out = {};
  for (const [k, v] of Object.entries(set || {})) {
    let t = v;
    if (typeof v === 'string') {
      if (k === 'F_ORT_TEXT') t = ipoLocationText(set, v, sgbd);
      else if (IPO_PCODE_KEY_RE.test(k)) t = ipoPcodeText(v);
      else if (IPO_ENV_TEXT_KEY_RE.test(k)) t = ipoEnvText(v);
      else if (IPO_ENV_VALUE_KEY_RE.test(k) && /[A-Za-z]/.test(v))
        t = ipoEnvText(v); // an enum value, not a number
      else if (/_TEXT$/.test(k)) t = phraseText(v);
    }
    out[k] = t;
  }
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ipoTranslating, ipoTranslateSet };
}
