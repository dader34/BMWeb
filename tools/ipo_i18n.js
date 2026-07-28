#!/usr/bin/env node
// Resolve every caption an ECU displays, once, into its IR.
//
// The renderer used to call deGerman at draw time from 24 places, which meant
// the same string was re-resolved on every repaint and -- worse -- a caption
// that came out wrong for ONE ECU had nowhere to live. BMW's compounds are
// not shared vocabulary: "Gesteuerte LuftFuehrung GLF" is MS450's phrase for
// its air-guidance actuator, and a word rule general enough to translate it
// mangles other ECUs ("Gecontrolse").
//
// So each ECU gets its own layer:
//
//   data/inpa-i18n/<ECU>.json   { "German caption": "English caption" }
//
// checked first, then the shared vocabulary in app/renderer/translate.js.
// The result lands in the IR as `i18n`, and the interpreter reads that map
// instead of translating. An ECU with no overrides file simply gets the
// shared vocabulary, exactly as before.
//
//   node tools/ipo_i18n.js            # resolve every IR in place
//   node tools/ipo_i18n.js MS450      # one ECU
//   node tools/ipo_i18n.js --check    # report, write nothing
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..');
const IR_DIR = path.join(R, 'data/inpa-ir');
const OVR_DIR = path.join(R, 'data/inpa-i18n');

// the shared vocabulary, loaded the same way the guards load it
const lang = () => 'en';
eval(fs.readFileSync(path.join(R, 'app/renderer/translate.js'), 'utf8'));

// every caption an IR displays, for the check path (the emitter supplies the
// same list as `strings` on a fresh build)
function captionsOf(ir) {
  const out = new Set();
  for (const m of Object.values(ir.menus || {})) {
    for (const it of m.items || []) if (it.label) out.add(it.label);
  }
  for (const s of Object.values(ir.screens || {})) {
    if (s.title) out.add(s.title);
    for (const l of s.lines || []) {
      if (l.caption) out.add(l.caption);
      for (const e of l.elements || []) {
        for (const k of ['s', 'unit', 'on', 'off']) if (e[k]) out.add(e[k]);
      }
    }
  }
  return [...out].sort();
}

function overridesFor(ecu) {
  const p = path.join(OVR_DIR, ecu + '.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`  ${ecu}: overrides unreadable -- ${e.message}`);
    return null;
  }
}

function resolve(ecu, strings) {
  const ovr = overridesFor(ecu);
  const out = {};
  let fromOvr = 0, fromVocab = 0;
  // Every override ships, whether or not the .IPO contains that string. Some
  // captions reach the screen at RUNTIME from the SGBD's result descriptions
  // rather than from the bytecode -- MS450 labels its monitor rows that way
  // ("Fehlzuendung", "Zaehler Ueberdrehzahl") -- and those are exactly the
  // ones a word table mangles ("counter UeberRPM"). irLabel consults this map
  // for them too, so an override written for one has to be here to be found.
  const all = new Set(strings);
  if (ovr) for (const k of Object.keys(ovr)) all.add(k);
  for (const s of all) {
    // a per-ECU override wins: it was written for this ECU's own wording
    if (ovr && Object.prototype.hasOwnProperty.call(ovr, s)) {
      if (ovr[s] && ovr[s] !== s) { out[s] = ovr[s]; fromOvr++; }
      continue;
    }
    const en = deGerman(s);
    if (en && en !== s) { out[s] = en; fromVocab++; }
  }
  return { map: out, fromOvr, fromVocab, hasOvr: !!ovr };
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const only = args.filter(a => !a.startsWith('--'));
  const files = only.length
    ? only.map(e => e + '.json')
    : fs.readdirSync(IR_DIR).filter(f => f.endsWith('.json'));

  let ecus = 0, strings = 0, translated = 0, overridden = 0, withOvr = 0;
  for (const f of files) {
    const p = path.join(IR_DIR, f);
    if (!fs.existsSync(p)) { console.error(`no IR for ${f}`); continue; }
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
    if (check) continue;
    if (Object.keys(r.map).length) ir.i18n = r.map;
    else delete ir.i18n;
    // `strings` was the emitter's hand-off to this step; the app never needs
    // the untranslated list, only the map.
    delete ir.strings;
    fs.writeFileSync(p, JSON.stringify(ir));
  }
  console.log(`  i18n       ${ecus} ECUs, ${strings} captions, `
    + `${translated} translated (${overridden} from per-ECU overrides, `
    + `${withOvr} ECUs have an overrides file)`);
}

main();
