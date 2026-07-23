// Generates app/renderer/faultdb.js from the fault translation files.
//   node scripts/build-faultdb.mjs
//
// Sources (all authoritative, derived from the BMW SGBD FORTTEXTE tables):
//   data/faults/*.json          - flat { "<HEXCODE>": "English" } cross-ECU DTC maps.
//   data/faults/<chassis>/*.json - per-ECU files { sgbd, scheme, faults }:
//        scheme "code" -> merged into the code DB (4-char DTC ECUs, keyed by hex).
//        scheme "text" -> merged into the phrase map (2-char-code ECUs whose fault
//                         memory returns descriptive German; keyed on that German
//                         text, so it is variant-agnostic - the D_00xx group loads
//                         the right variant and its German text maps here).
// Emits window.BMW_FAULT_DB (code -> English) and window.BMW_FAULT_PHRASES
// (German fault text -> English), both consumed by faults.js / translate.js.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const faultsDir = path.join(root, 'data', 'faults');

const codes = {};    // HEXCODE -> English
const phrases = {};   // German fault text -> English
const errors = [];
let codeFiles = 0, ecuFiles = 0;

function addCode(key, val, where) {
  key = String(key).toUpperCase();
  if (!/^[0-9A-F]{2,5}$/.test(key)) { errors.push(`${where}: bad code "${key}"`); return; }
  if (typeof val !== 'string' || !val.trim()) { errors.push(`${where}: empty desc for "${key}"`); return; }
  if (/[ÄÖÜäöüß]/.test(val)) errors.push(`${where}: German chars in "${key}": ${val}`);
  codes[key] = val;
}
function addPhrase(de, en, where) {
  if (typeof de !== 'string' || !de.trim()) return;
  if (typeof en !== 'string' || !en.trim()) { errors.push(`${where}: empty translation for "${de}"`); return; }
  if (/[ÄÖÜäöüß]/.test(en)) errors.push(`${where}: German chars in value "${en}"`);
  phrases[de.trim()] = en;
}

// 1) flat cross-ECU DTC files (data/faults/*.json)
for (const file of fs.readdirSync(faultsDir).filter(f => f.endsWith('.json')).sort()) {
  const obj = JSON.parse(fs.readFileSync(path.join(faultsDir, file), 'utf8'));
  for (const [code, desc] of Object.entries(obj)) addCode(code, desc, file);
  codeFiles++;
}

// 2) per-ECU chassis files (data/faults/<chassis>/*.json)
for (const chassis of fs.readdirSync(faultsDir, { withFileTypes: true }).filter(d => d.isDirectory())) {
  const dir = path.join(faultsDir, chassis.name);
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
    const where = `${chassis.name}/${file}`;
    const obj = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (!obj || typeof obj.faults !== 'object') { errors.push(`${where}: missing "faults" object`); continue; }
    const scheme = obj.scheme === 'text' ? 'text' : 'code';
    for (const [k, v] of Object.entries(obj.faults)) {
      if (scheme === 'text') addPhrase(k, v, where); else addCode(k, v, where);
    }
    ecuFiles++;
  }
}

if (errors.length) {
  for (const e of errors.slice(0, 40)) console.error(`error: ${e}`);
  console.error(`\nFAILED: ${errors.length} error(s).`);
  process.exit(1);
}

// emit code DB, grouped by 2-char prefix for readable diffs
const ck = Object.keys(codes).sort();
let cbody = '', last = null;
for (const k of ck) {
  const pre = k.slice(0, 2);
  if (pre !== last) { cbody += `  // ${pre}xx\n`; last = pre; }
  cbody += `  ${JSON.stringify(k)}: ${JSON.stringify(codes[k])},\n`;
}
// emit phrase map, sorted
let pbody = '';
for (const k of Object.keys(phrases).sort()) pbody += `  ${JSON.stringify(k)}: ${JSON.stringify(phrases[k])},\n`;

const header = `// GENERATED FILE - do not edit by hand. Regenerate: node scripts/build-faultdb.mjs
// Source of truth: BMW SGBD FORTTEXTE tables (data/faults/**). Injected lazily via
// loadFaultDb() in faults.js so this literal isn't parsed before first paint.
// BMW_FAULT_DB: hex DTC -> English. BMW_FAULT_PHRASES: German fault text -> English.
`;
const out = path.join(root, 'app', 'renderer', 'faultdb.js');
fs.writeFileSync(out, `${header}window.BMW_FAULT_DB = {\n${cbody}};\nwindow.BMW_FAULT_PHRASES = {\n${pbody}};\n`);
console.log(`Wrote ${ck.length} codes + ${Object.keys(phrases).length} phrases to ${path.relative(root, out)} (${codeFiles} flat + ${ecuFiles} per-ECU files).`);
