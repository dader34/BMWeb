#!/usr/bin/env node
// Resolve every caption an ECU displays, once, into its IR.
//
// Each ECU gets its own layer:
//
//   data/inpa-i18n/<ECU>.json   { "German caption": "English caption" }
//
// checked first, then the shared whole-caption table in
// data/inpa-i18n/_shared.json (INPA's standard chrome and softkey
// abbreviations: "Fehlerspeicher lesen", "Read EM"). Both are exact
// dictionaries written by hand. There is NO word-level fallback: a caption
// neither file carries ships untranslated and shows as BMW wrote it, exactly
// like a German INPA. `--gaps` lists those captions per ECU so they can be
// added deliberately.
//
// The shared table is also written once as app/renderer/data/i18n-shared.js
// (window.BMW_I18N_SHARED), so irLabel can translate a string that reaches the
// screen at RUNTIME from the SGBD ("Bandmode") without every ECU's map
// carrying the whole table.
//
// Keys match whitespace-collapsed and without a trailing ":"/"=" (the .IPO
// pads captions to their column), and the resolved map ships under the
// caption's original spelling so the interpreter's exact lookup hits.
//
//   node tools/decompile/ipo_i18n.js            # resolve every IR in place
//   node tools/decompile/ipo_i18n.js MS450      # one ECU
//   node tools/decompile/ipo_i18n.js --check    # report, write nothing
//   node tools/decompile/ipo_i18n.js --gaps [ECU ...]  # untranslated captions
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const R = path.join(__dirname, '..', '..');
const IR_DIR = path.join(R, 'data/inpa-ir');
const OVR_DIR = path.join(R, 'data/inpa-i18n');

const SHARED = (() => {
  const p = path.join(OVR_DIR, '_shared.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
})();

// A caption looks German when it carries an umlaut/sharp-s or a common
// German function word. Only the --gaps report uses this, to rank what is
// worth translating; resolution itself never guesses.
const GERMAN_HINT =
  /[\u00e4\u00f6\u00fc\u00c4\u00d6\u00dc\u00df]|\b(und|nicht|oder|der|die|das|mit|ohne|ein|eine|ist|bei|nach|von|vor|zu|auf|aus|ueber|unter|lesen|loeschen|l\u00f6schen|schreiben|ansteuern|ansteuerung|fehler|speicher|zur\u00fcck|zurueck|weiter|abbruch|ende|ja|nein|wert|werte|z\u00e4hler|zaehler|drehzahl|temperatur|spannung|druck|geschwindigkeit|kennung|auswahl|pr\u00fcfen|pruefen|motor|k\u00fchl|kuehl|luft|oel|\u00f6l|wasser|heizung|schalter|ventil|pumpe|relais|lampe|leuchte|t\u00fcr|tuer|fenster|sitz|spiegel|dach|bremse|kupplung|getriebe|gang|hinten|vorne|links|rechts|oben|unten|innen|aussen|au\u00dfen|eingabe|anzeige|steuerger\u00e4t|steuergeraet|einstellen|abgleich|programmierung|codierung|bitte|taste|dr\u00fccken|druecken|beenden|starten|aktiv|inaktiv|vorhanden|betrieb)\b/i;

// every caption an IR displays, for the check path (the emitter supplies the
// same list as `strings` on a fresh build)
function captionsOf(ir) {
  const out = new Set();
  for (const m of Object.values(ir.menus || {})) {
    for (const it of m.items || []) if (it.label) out.add(it.label);
  }
  const scanScreens = (screens) => {
    for (const s of Object.values(screens || {})) {
      if (s.title) out.add(s.title);
      for (const l of s.lines || []) {
        if (l.caption) out.add(l.caption);
        for (const e of l.elements || []) {
          // 'unit' is a result KEY (STAT_..._EINH), not a display caption --
          // the SGBD fills the unit text at runtime, so it needs no i18n.
          for (const k of ['s', 'on', 'off']) if (e[k]) out.add(e[k]);
        }
      }
    }
  };
  scanScreens(ir.screens);
  return [...out].sort();
}

// Override files are named after the ECU as the IR spells it, but the case
// drifts (klima_5B.json for KLIMA_5B); match case-insensitively so Linux CI
// resolves what a Mac checkout does.
const OVR_FILES = new Map(
  fs
    .readdirSync(OVR_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => [f.slice(0, -5).toLowerCase(), path.join(OVR_DIR, f)])
);
function overridesFor(ecu) {
  const p = OVR_FILES.get(String(ecu).toLowerCase());
  if (!p) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`  ${ecu}: overrides unreadable -- ${e.message}`);
    return null;
  }
}

// The caption irLabel is handed is not always the raw .IPO string: the app
// looks it up collapsed and without a trailing ":". A key written as in the
// bytecode ("Haeufigkeitszaehler1:    ") would then never match the label
// actually looked up ("Haeufigkeitszaehler1"), so both spellings ship. A
// COMMA-split caption is deliberately not aliased -- its halves label
// different rows and each needs its own translation.
function keyForms(s) {
  const t = String(s)
    .trim()
    .replace(/\s*[:=]\s*$/, '');
  return t && t !== s ? [s, t] : [s];
}

function normKey(s) {
  return String(s)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*[:=]\s*$/, '');
}

function resolve(ecu, strings) {
  const ovr = overridesFor(ecu);
  // exact spelling first, collapsed spelling second; an override written for
  // this ECU beats the shared abbreviation table
  const byNorm = new Map();
  for (const src of [SHARED, ovr || {}]) {
    for (const k of Object.keys(src)) {
      if (!src[k] || src[k] === k) continue;
      byNorm.set(normKey(k), src[k]);
    }
  }
  const exact = Object.assign({}, SHARED, ovr || {});
  const out = {};
  let fromOvr = 0,
    fromShared = 0;
  const gaps = [];
  // Every override ships, whether or not the .IPO contains that string. Some
  // captions reach the screen at RUNTIME from the SGBD's result descriptions
  // rather than from the bytecode -- MS450 labels its monitor rows that way
  // ("Fehlzuendung", "Zaehler Ueberdrehzahl") -- and irLabel consults this
  // map for them too, so an override written for one has to be here.
  const all = new Set(strings);
  if (ovr) for (const k of Object.keys(ovr)) all.add(k);
  for (const s of all) {
    const en = Object.prototype.hasOwnProperty.call(exact, s)
      ? exact[s]
      : byNorm.get(normKey(s));
    if (!en || en === s) {
      if (!Object.prototype.hasOwnProperty.call(exact, s)) gaps.push(s);
      continue;
    }
    // the override on the whole caption also answers for the label form
    // irRows derives from it, unless that form has its own entry
    for (const k of keyForms(s)) {
      if (out[k] === undefined && !(k !== s && exact[k] !== undefined))
        out[k] = en;
    }
    if (ovr && byNorm.get(normKey(s)) === (ovr[s] || byNorm.get(normKey(s))))
      fromOvr++;
    else fromShared++;
  }
  return { map: out, fromOvr, fromShared, hasOvr: !!ovr, gaps };
}

function writeSharedRuntime() {
  const p = path.join(R, 'app/renderer/data/i18n-shared.js');
  const body =
    '// GENERATED by tools/decompile/ipo_i18n.js from data/inpa-i18n/_shared.json.\n' +
    '// Whole-caption English for INPA chrome and softkeys shared across ECUs;\n' +
    "// irLabel (screens/ir.js) consults it after the ECU's own map. Exact\n" +
    '// strings only -- edit the JSON, not this file.\n' +
    'window.BMW_I18N_SHARED = ' +
    JSON.stringify(SHARED, null, 2) +
    ';\n';
  if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== body)
    fs.writeFileSync(p, body);
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const gapsMode = args.includes('--gaps');
  const only = args.filter((a) => !a.startsWith('--'));
  const files = only.length
    ? only.map((e) => e + '.json')
    : fs.readdirSync(IR_DIR).filter((f) => f.endsWith('.json'));

  let ecus = 0,
    strings = 0,
    translated = 0,
    overridden = 0,
    withOvr = 0;
  let problems = 0;
  if (!check && !gapsMode) writeSharedRuntime();
  for (const f of files) {
    const p = path.join(IR_DIR, f);
    if (!fs.existsSync(p)) {
      console.error(`no IR for ${f}`);
      problems++;
      continue;
    }
    const ir = JSON.parse(fs.readFileSync(p, 'utf8'));
    // `strings` is the emitter's hand-off and is consumed on the first run, so
    // --check re-derives it from what the IR actually holds. That also makes
    // the check independent of whether this step has run yet.
    const src = Array.isArray(ir.strings) ? ir.strings : captionsOf(ir);
    if (!src.length) continue;
    const r = resolve(ir.ecu, src);
    ecus++;
    strings += src.length;
    translated += Object.keys(r.map).length;
    overridden += r.fromOvr;
    if (r.hasOvr) withOvr++;
    if (gapsMode) {
      // German-looking first, then the rest, so the list reads as a to-do
      const de = r.gaps.filter((g) => GERMAN_HINT.test(g));
      const other = r.gaps.filter((g) => !GERMAN_HINT.test(g));
      console.log(
        `${ir.ecu || f}: ${src.length} captions, ${r.gaps.length} untranslated ` +
          `(${de.length} look German)`
      );
      for (const g of [...de, ...other]) console.log('  ' + JSON.stringify(g));
      continue;
    }
    if (check) {
      // The invariant: what resolution WOULD produce is what the IR on disk
      // CARRIES. An unconsumed `strings` hand-off means the emitter ran
      // after this step (the "raw German captions" regression check.sh's
      // header describes); a map entry the IR lacks means an override or
      // the vocabulary changed and this step has not been re-run.
      const have = ir.i18n || {};
      const missing = Object.keys(r.map).filter((k) => have[k] !== r.map[k]);
      if (Array.isArray(ir.strings)) {
        console.error(
          `  ${ir.ecu || f}: strings hand-off unconsumed -- ` +
            `run node tools/decompile/ipo_i18n.js`
        );
        problems++;
      } else if (missing.length) {
        console.error(
          `  ${ir.ecu || f}: ${missing.length} resolved captions ` +
            `missing from i18n (e.g. ${JSON.stringify(missing[0])}) -- ` +
            `run node tools/decompile/ipo_i18n.js`
        );
        problems++;
      }
      continue;
    }
    if (Object.keys(r.map).length) ir.i18n = r.map;
    else delete ir.i18n;
    // `strings` was the emitter's hand-off to this step; the app never needs
    // the untranslated list, only the map.
    delete ir.strings;
    const out = JSON.stringify(ir);
    fs.writeFileSync(p, out);
    // The .json.gz is the COMMITTED source (CI expands it back to .json), so it
    // must carry the resolved i18n too -- writing only the .json left the gz
    // stale and CI rendered raw German captions. Rewrite the gz in step.
    fs.writeFileSync(p + '.gz', zlib.gzipSync(out));
  }
  console.log(
    `  i18n       ${ecus} ECUs, ${strings} captions, ` +
      `${translated} translated (${overridden} from per-ECU files, ` +
      `${withOvr} ECUs have one; the rest show as written)`
  );
  if (check && problems) {
    console.error(`  i18n check FAILED: ${problems} IR(s) out of step`);
    process.exitCode = 1;
  }
}

main();
