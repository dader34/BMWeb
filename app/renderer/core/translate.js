// Exact-match English lookups for text the SGBD sends at runtime, plus the
// fault-code helpers. Pure lookup, no DOM, no word-level rewriting: a string
// is translated when a dictionary carries it whole, else it shows as BMW
// wrote it. Gated on Settings language (lang()==='orig' keeps German for
// EDIABAS-faithful mode). Captions from the .IPO scripts are NOT handled here
// -- each ECU carries its own map (data/inpa-i18n, irLabel in screens/ir.js).
const FAULT_PHRASES = [
  // symptom (F_SYMPTOM_TEXT)
  ['kein Signal oder Wert', 'No signal or value'],
  // fault-type (FA) texts as BMW composes them into F_PCODE_TEXT
  // ("P1128 Motoroelniveausensor - kein Signal"): the part after " - "
  ['kein Signal', 'no signal'],
  ['System zu fett', 'system too rich'],
  ['System zu mager', 'system too lean'],
  ['Unterbrechung', 'open circuit'],
  ['Signal unplausibel', 'signal implausible'],
  ['Signal zu hoch', 'signal too high'],
  ['Signal zu niedrig', 'signal too low'],
  ['Signal oder Wert unterhalb Schwelle', 'Signal or value below threshold'],
  ['Signal oder Wert oberhalb Schwelle', 'Signal or value above threshold'],
  ['Signal oder Wert unplausibel', 'Signal or value implausible'],
  ['Kurzschluss nach Masse', 'Short circuit to ground'],
  ['Kurzschluss nach Plus', 'Short circuit to positive'],
  ['Kurzschluss nach Batterie', 'Short circuit to battery'],
  ['Leitungsunterbrechung', 'Open circuit'],
  ['mechanischer Fehler', 'Mechanical fault'],
  ['elektrischer Fehler', 'Electrical fault'],
  // presence (F_VORHANDEN_TEXT)
  [
    'Fehler momentan nicht vorhanden, OBD-entprellt',
    'Not currently present (OBD-confirmed)',
  ],
  [
    'Fehler momentan nicht vorhanden, nicht OBD-entprellt',
    'Not currently present (not OBD-confirmed)',
  ],
  [
    'Fehler momentan vorhanden, noch nicht OBD-entprellt',
    'Currently present (not yet OBD-confirmed)',
  ],
  [
    'Fehler momentan vorhanden, nicht OBD-entprellt',
    'Currently present (not OBD-confirmed)',
  ],
  [
    'Fehler momentan vorhanden, OBD-entprellt',
    'Currently present (OBD-confirmed)',
  ],
  ['Fehler momentan nicht vorhanden', 'Not currently present'],
  ['Fehler momentan vorhanden', 'Currently present'],
  // warning lamp (F_WARNUNG_TEXT)
  ['Fehler verursacht kein Aufleuchten der Warnlampe (MIL)', 'No MIL'],
  [
    'Fehler wuerde das Aufleuchten der Warnlampe (MIL) verursachen',
    'Would trigger MIL',
  ],
  ['Fehler verursacht das Aufleuchten der Warnlampe (MIL)', 'Triggers MIL'],
  // readiness (F_READY_TEXT). The "noch nicht" variant must precede the
  // plain "nicht" one: whichever is a leading match wins, and this phrase is
  // "not YET met", not "not met".
  ['Testbedingungen noch nicht erfüllt', 'Test conditions not yet met'],
  ['Testbedingungen erfüllt', 'Test conditions met'],
  ['Testbedingungen nicht erfüllt', 'Test conditions not met'],
];
// Exact full-sentence translations for job-argument comments. Keyed on
// trimmed text.
const ARG_PHRASES = {
  'Als Argument wird ein vorgefuellter Binaerbuffer uebergeben':
    'Pass a pre-built binary buffer as the argument',
  '"ja"   -> Funktionale Adresse 0xEF wird benutzt':
    '"yes" -> use functional address 0xEF',
  '0x????: Angabe eines einzelnen Fehlers': '0x????: a single fault',
  'Zu übertragende Blocknummer (Zähler) bei langen Datenstreams':
    'block number (counter) to transfer for long data streams',
  "Wenn 'JA' wird der Messwertblock im SG gelöscht":
    "'YES' clears the measurement block in the ECU",
  'Abgleichdaten in folgendem Format':
    'adjustment data in the following format',
  'Auswahl eines Stellers (Pflicht)': 'select an actuator (required)',
  'Auswahl eines Tests (Pflicht)': 'select a test (required)',
  'Auswahl eines Tests': 'select a test',
  'Nummer der auszulesenden Stützstellenkombination':
    'number of the reference-point combination to read',
  'Länge der folgenden Information wie die Antwort erhalten wird.':
    'length of the following info on how the response is received.',
  'ASCII-codiert Information wie die Antwort erhalten wird:':
    'ASCII-coded info on how the response is received:',
  'wird die Nummer des zu lesenden Fehlers im Fehlerspeicher uebergeben':
    'pass the number of the fault to read from the fault memory',
  'wird die Nummer des zu lesenden Fehlers uebergeben':
    'pass the number of the fault to read',
  'kleines x muss Charakter sein 0-9 oder A-Z':
    'lowercase x must be a character 0-9 or A-Z',
  'Dieser Job ist mit Passwort geschützt': 'This job is password protected',
  'Wird nur bei Motoren mit 2 Bänken benötigt (M67TÜ)':
    'only needed on engines with 2 banks (M67TU)',
  'gibt einen absoluten Verstellwinkel an (0..180 Grd)':
    'specifies an absolute adjustment angle (0..180 deg)',
  'Dient nur zur Sicherheit, wird nicht': 'for safety only, is not',
  'Länge des Individualisierungs Datenstream oder -streamstücks':
    'length of the individualization data stream or stream piece',
  'Individualdaten können via CAN oder MOST oder XY erreicht werden':
    'individual data can be reached via CAN or MOST or XY',
  'Individualdaten können via CAN oder MOST oder XY geschrieben werden':
    'individual data can be written via CAN or MOST or XY',
  'Übergabe im Format Messagenummern zB.: 00C0000D für N und V':
    'pass as message numbers, e.g. 00C0000D for N and V',
  'Einzelkerze rücksetzen: GLU1 ... GLU6 (... GLU8)':
    'reset single glow plug: GLU1 ... GLU6 (... GLU8)',
  'Wert der vorzugebenden Soll-Foerdermenge':
    'value of the target delivery quantity to set',
};

// Exact-match phrase lookup for text that arrives at RUNTIME from the SGBD
// (fault symptom/location text, job-argument comments): the tables above,
// then the generated fault-location dictionary (faultdb.js). Text without an
// entry is returned as BMW wrote it -- there is no word-level rewriting.
// Captions the .IPO prints are translated by the per-ECU i18n map instead
// (irLabel, built from data/inpa-i18n/<ECU>.json).
function phraseText(text) {
  if (!text) return text;
  if (typeof lang === 'function' && lang() === 'orig') return text;
  // web VM results can be numbers (see bmwCode); only strings have .trim()
  const trimmed = String(text).trim();
  if (Object.prototype.hasOwnProperty.call(ARG_PHRASES, trimmed))
    return ARG_PHRASES[trimmed];
  // per-ECU fault-location text (SGBD FORTTEXTE tables, faultdb.js), variant-agnostic
  if (typeof window !== 'undefined' && window.BMW_FAULT_PHRASES) {
    const hit = window.BMW_FAULT_PHRASES[trimmed];
    if (hit) return hit;
  }
  for (const [de, en] of FAULT_PHRASES) if (trimmed === de) return en;
  return text;
}

// Freeze-frame (Umwelt) field labels and enum values -- a pure lookup over the
// MAINTAINED dictionary window.BMW_ENV_TEXT (app/renderer/data/envmap.js,
// generated from tools/decompile/env_i18n_de.json). No word-munging: an entry
// is present with a curated English translation, or the German passes through
// unchanged. Keyed on the EXACT string, including any leading state code an
// enum value carries ("2 IS - Motor im Leerlauf"). Skipped in Original mode.
// Deliberately does NOT call phraseText -- that heuristic path never touches
// environment text.
function envLabel(text) {
  if (lang() === 'orig' || !text) return text;
  const s = String(text).trim();
  const map = (typeof window !== 'undefined' && window.BMW_ENV_TEXT) || null;
  if (map && Object.prototype.hasOwnProperty.call(map, s)) return map[s];
  return text;
}

// BMW hex fault number (e.g. 27DA) -> OBD-II P-code. only real mappings; no
// fabricated codes.
const PCODE_MAP = {
  2761: 'P0410', // secondary air system
  '27C3': 'P2563', // oil level sensor (thermal)
  '27DA': 'P1734', // BSD bus / alternator comms (BMW-specific)
  '27C2': 'P2562',
  '27C4': 'P2564',
};
// Flatten an EDIABAS result value to the same text the native bridge produces
// (src/EdiabasMac/Diag.cs Format): byte arrays become dashed hex ("27-DA"),
// everything else its plain string. The web VM returns live typed values --
// `ergy` (binary) emits a byte Array, `ergi`/`ergb`/... emit numbers -- so
// screens that only ever saw the native path's strings funnel through here.
// An empty binary result ([]) is truthy but must read as "no code", which the
// join handles by yielding ''.
function hexText(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'string') return v;
  // duck-typed, not `instanceof`: a typed array from another realm (worker,
  // iframe) fails the instanceof check and would stringify as "39,218".
  if (Array.isArray(v) || ArrayBuffer.isView(v))
    return Array.from(v, (b) =>
      (b & 0xff).toString(16).toUpperCase().padStart(2, '0')
    ).join('-');
  if (typeof v === 'number')
    return Number.isFinite(v) && v !== 0
      ? (v >>> 0).toString(16).toUpperCase().padStart(4, '0')
      : '';
  return String(v);
}

// BMW fault number = first token of F_ORT_TEXT ("27DA BSD-Generator" -> 27DA).
// GOTCHA: F_HEX_CODE is declared `binary` in every SGBD that has it. The native
// path flattens it first (Diag.Format -> BitConverter.ToString -> "27-DA", hence
// the dash strip below), but the web VM hands us the raw Uint8Array, which has
// no .replace. Most ECUs never reach here because their F_ORT_TEXT leads with
// the code; KOMBI's text is German-only, so it falls through to `hex`.
function bmwCode(loc, hex) {
  const text = loc == null ? '' : String(loc);
  if (text) {
    const m = text.match(/^([0-9A-F]{3,5})\b/i);
    if (m) return m[1].toUpperCase();
  }
  const h = hexText(hex);
  return h ? h.replace(/-/g, '').slice(0, 4).toUpperCase() : null;
}

// F_ORT_NR (BMW "Fehlerort") -> the LOCATION BYTE the SGBD FORTTEXTE table keys
// on (IHKA 0x1F, LWS 0x0B). For a 16-bit value (LWS 0x0B3F) the location is the
// HIGH byte; the low byte is symptom detail. EDIABAS gives it decimal ("2879");
// hex ("0x0B3F"/"1F") is accepted too. Returns two hex digits.
function ortNrCode(nr) {
  if (nr == null) return null;
  const s = String(nr).trim();
  if (!s) return null;
  let val = null;
  let m =
    s.match(/^0x([0-9A-Fa-f]+)$/) ||
    s.match(/^([0-9A-Fa-f]*[A-Fa-f][0-9A-Fa-f]*)$/);
  if (m) val = parseInt(m[1], 16);
  else if (/^\d+$/.test(s)) val = parseInt(s, 10);
  if (val == null || Number.isNaN(val)) return s; // unknown format: show as-is
  const loc = val > 0xff ? (val >> 8) & 0xff : val; // high byte if 16-bit
  return loc.toString(16).toUpperCase().padStart(2, '0');
}
function pCode(loc, hex) {
  const code = bmwCode(loc, hex);
  return code && PCODE_MAP[code] ? PCODE_MAP[code] : null;
}

// full 16-bit F_ORT_NR as 4-hex ("24002" -> "5DC2"), or null for single bytes.
// Lets the caller tell a real 2-byte DTC (DSC 5DC2, in the DB) from a text-scheme
// location+detail word (LWS 0B3F, not in the DB -> show the location byte).
function ortNrFull(nr) {
  if (nr == null) return null;
  const s = String(nr).trim();
  if (!s) return null;
  let val = null;
  let m =
    s.match(/^0x([0-9A-Fa-f]+)$/) ||
    s.match(/^([0-9A-Fa-f]*[A-Fa-f][0-9A-Fa-f]*)$/);
  if (m) val = parseInt(m[1], 16);
  else if (/^\d+$/.test(s)) val = parseInt(s, 10);
  if (val == null || Number.isNaN(val) || val <= 0xff) return null;
  return val.toString(16).toUpperCase().padStart(4, '0');
}

// P-code lookup backed by window.BMW_PCODES (BMW hex -> [SAE P-codes], primary
// first); PCODE_MAP is the fallback. Lazy-injected; fault screens warm it.
let _pcodesPromise = null;
function loadPcodes() {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.BMW_PCODES) return Promise.resolve();
  if (_pcodesPromise) return _pcodesPromise;
  _pcodesPromise = new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'data/pcodes.js';
    s.onload = () => resolve();
    s.onerror = () => {
      _pcodesPromise = null;
      resolve();
    };
    document.head.appendChild(s);
  });
  return _pcodesPromise;
}

// rich ISTA fault metadata + service-info documents (decrypted DiagDocDb).
// Lazy-loaded: meta (14MB) warms with the fault screens; info (60MB) only on a
// fault detail panel.
//
// The large BMW-derived fault data (faultinfo/faultmeta/faultdb/faultindex) is
// NOT shipped in the repo -- it is BMW's copyrighted ISTA/EDIABAS text. It is
// hosted on the same Hugging Face dataset as the ETK data and loaded from there
// at runtime, with a local `data/` copy taking precedence when a build ships
// one (offline/desktop). Loading is a plain <script src> that sets a window
// global; cross-origin classic scripts load fine from HF.
const FAULT_HF_BASE =
  'https://huggingface.co/datasets/CraigFf/bmweb-etk/resolve/main/faults/';

function _lazyScript(src, ready, holder) {
  return function () {
    if (typeof window === 'undefined') return Promise.resolve();
    if (window[ready]) return Promise.resolve();
    if (holder.p) return holder.p;
    // basename for the HF fallback (src is like 'data/faultinfo.js')
    const base = typeof WEB_BASE === 'string' ? WEB_BASE : '';
    const file = src.split('/').pop();
    const urls = [`${base}/${src}`, `${FAULT_HF_BASE}${file}`];
    holder.p = new Promise((resolve) => {
      let i = 0;
      const tryNext = () => {
        if (i >= urls.length) {
          holder.p = null;
          resolve();
          return;
        }
        const s = document.createElement('script');
        s.src = urls[i++];
        s.onload = () => resolve();
        s.onerror = () => {
          s.remove();
          tryNext();
        }; // local missing -> HF
        document.head.appendChild(s);
      };
      tryNext();
    });
    return holder.p;
  };
}
const _metaHolder = {},
  _infoHolder = {},
  _codingHolder = {},
  _datenHolder = {};
const loadFaultMeta = _lazyScript(
  'data/faultmeta.js',
  'BMW_FAULT_META',
  _metaHolder
);
const loadFaultInfo = _lazyScript(
  'data/faultinfo.js',
  'BMW_FAULT_INFO',
  _infoHolder
);
// what an ECU's coding values MEAN, for the SGBDs that name their own
const loadCodingMap = _lazyScript(
  'data/codingmap.js',
  'BMW_CODING_MAP',
  _codingHolder
);
// ...and from BMW's DATEN, for ECUs whose SGBD says nothing
const loadDatenMap = _lazyScript(
  'data/datenmap.js',
  'BMW_DATEN_MAP',
  _datenHolder
);
// which ECUs a car actually has: SGET rows + their AUFTRAGSAUSDRUCK predicate
const _sgetHolder = {};
const loadSget = _lazyScript('data/sget.js', 'BMW_SGET', _sgetHolder);
// SGFAM (which ECU holds the vehicle order / the central coding key), AT
// (SA number -> equipment keywords) and ZST (ZCS key bits -> keywords)
const _tablesHolder = {};
const loadTables = _lazyScript('data/tables.js', 'BMW_TABLES', _tablesHolder);
// SA option numbers -> English names, dated (BMW reused the numbers)
const _saNamesHolder = {};
const loadSaNames = _lazyScript(
  'data/sanames.js',
  'BMW_SA_NAMES',
  _saNamesHolder
);

// per-ECU-variant records for a hex code: [{sgbd, name, info?}], or []. `info`
// indexes into BMW_FAULT_INFO[hex].
function variantsForHex(code) {
  if (!code) return [];
  const c = String(code).replace(/^0x/i, '').toUpperCase();
  const m = (typeof window !== 'undefined' && window.BMW_FAULT_META) || null;
  return (m && m[c] && m[c].variants) || [];
}

// the service-info document for a hex code + variant info-index, or null.
function faultInfoFor(code, infoIdx) {
  if (code == null || infoIdx == null) return null;
  const c = String(code).replace(/^0x/i, '').toUpperCase();
  const db = (typeof window !== 'undefined' && window.BMW_FAULT_INFO) || null;
  const bucket = db && db[c];
  return (bucket && bucket[String(infoIdx)]) || null;
}

// all SAE P-codes for a BMW hex code ("27C3" -> ["P0456"], primary first), or [].
// Prefers ISTA meta, then the pcodes map, then the fallback.
function pcodesForHex(code) {
  if (!code) return [];
  const c = String(code).replace(/^0x/i, '').toUpperCase();
  const m = (typeof window !== 'undefined' && window.BMW_FAULT_META) || null;
  if (m && m[c] && m[c].pcodes) return m[c].pcodes;
  const db = (typeof window !== 'undefined' && window.BMW_PCODES) || null;
  if (db && db[c]) return db[c];
  if (PCODE_MAP[c]) return [PCODE_MAP[c]];
  return [];
}

// UNAMBIGUOUS offline P-code for a hex code, or null. Many BMW codes map to
// SEVERAL SAE P-codes gated by ECU variant; guessing the first misleads, so
// offline we return one ONLY when the code has exactly one. A live read's own
// F_PCODE_STRING is exact and always preferred.
function pcodeForHexSgbd(code, sgbd) {
  if (!code) return null;
  const list = pcodesForHex(code);
  return list.length === 1 ? list[0] : null;
}

// primary P-code for a bare BMW hex code ("27C3" -> "P0456"), or null.
function pcodeForHex(code) {
  const list = pcodesForHex(code);
  return list.length ? list[0] : null;
}

// reverse lookup for search: "P0456" -> "27C3", null if unknown. Built once from
// the richest source available (BMW_FAULT_META, then BMW_PCODES, then fallback).
let _PCODE_REV = null,
  _PCODE_REV_SRC = null;
function hexForPcode(p) {
  const meta = (typeof window !== 'undefined' && window.BMW_FAULT_META) || null;
  const db = (typeof window !== 'undefined' && window.BMW_PCODES) || null;
  const src = meta || db || PCODE_MAP;
  if (_PCODE_REV_SRC !== src) {
    _PCODE_REV = {};
    _PCODE_REV_SRC = src;
    for (const [h, v] of Object.entries(src)) {
      const list = meta ? v.pcodes || [] : Array.isArray(v) ? v : [v];
      for (const pc of list) {
        const k = String(pc).toUpperCase();
        if (!(k in _PCODE_REV)) _PCODE_REV[k] = h;
      }
    }
  }
  return _PCODE_REV[String(p).toUpperCase()] || null;
}
