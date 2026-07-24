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

// ORT fault-code map for text-scheme ECUs (whose faults key on German text, not a
// code). data/ort-codes.json is { sgbd: { variant: { "German text": "0xNN" } } },
// dumped offline from every VARIANT of each SGBD's FORTTEXTE table (inpamac dumptable).
// The same location can have a different code in different variants (ihka46 Drucksensor
// is 0x1D but ihka46_3 is 0x1F), so the code map is kept PER VARIANT and the Lookup
// screen splits a module into one entry per variant (labelled by the variant SGBD).
// Keyed case-insensitively by the base sgbd. Optional: an absent file means no codes.
let ortMap = {};
try {
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'data', 'ort-codes.json'), 'utf8'));
  for (const [sgbd, m] of Object.entries(raw)) ortMap[sgbd.toLowerCase()] = m;
} catch { /* no ort map: text rows just carry no code */ }

const codes = {};    // HEXCODE -> English
const phrases = {};   // German fault text -> English
const errors = [];
let codeFiles = 0, ecuFiles = 0;

// structured per-ECU index for the fault Lookup screen (lookup.js): keeps the
// chassis/module grouping the flat DB throws away, so the UI can search and
// filter by chassis and ECU. one entry per per-ECU file with a non-empty faults map.
const index = []; // [{ chassis, module, sgbd, scheme, faults: [[key, en], ...] }]

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
    // record the structured entry(ies) for the Lookup screen (skip empty modules,
    // e.g. cvm/dwa4 whose SGBD table carried no descriptive text). each fault is
    // [key, english, code]: for "code" scheme the key IS the code.
    const chId = (obj.chassis || chassis.name).toUpperCase();
    const baseModule = obj.module || obj.sgbd || file.replace(/\.json$/i, '');
    const baseSgbd = obj.sgbd || '';
    const enFor = (k) => obj.faults[k];
    const pushEntry = (module, sgbd, faultRows) => {
      if (faultRows.length) index.push({ chassis: chId, module, sgbd, scheme, faults: faultRows });
    };

    if (scheme === 'code') {
      pushEntry(baseModule, baseSgbd,
        Object.entries(obj.faults).filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => [k, v, k]));
    } else {
      // text scheme: the ORT map is { variant -> { German: code } }. A location can
      // have a DIFFERENT code per SGBD variant (ihka46 Drucksensor 0x1D vs ihka46_3
      // 0x1F), so emit a SEPARATE module entry per variant, labelled with the variant
      // SGBD - each carrying only that variant's codes. Variants whose whole code map
      // is identical collapse into one entry (no point splitting when nothing differs).
      const vmap = ortMap[baseSgbd.toLowerCase()] || null;
      const rowsFor = (codeByPhrase) => {
        const rows = [];
        for (const [k, v] of Object.entries(obj.faults)) {
          if (typeof v !== 'string' || !v.trim()) continue;
          rows.push([k, v, (codeByPhrase && codeByPhrase[k]) || '']);
        }
        return rows;
      };
      if (!vmap) {
        pushEntry(baseModule, baseSgbd, rowsFor(null));
      } else {
        // collapse variants with an identical code map (by signature over this file's phrases)
        const phrases = Object.keys(obj.faults).filter(k => typeof obj.faults[k] === 'string' && obj.faults[k].trim());
        const sig = (m) => phrases.map(k => (m && m[k]) || '').join('|');
        const groups = new Map(); // signature -> { variants: [names], map }
        for (const [variant, m] of Object.entries(vmap)) {
          const s = sig(m);
          if (!groups.has(s)) groups.set(s, { variants: [], map: m });
          groups.get(s).variants.push(variant);
        }
        // every variant entry keeps the SAME module name, so the module filter list
        // shows one "IHKA" option (not one per variant). Only the sgbd differs, so the
        // results screen still splits into a card per variant (grouping keys on sgbd),
        // each showing that variant's own codes. The group containing the base sgbd
        // uses the base sgbd; others use their variant name.
        for (const { variants, map } of groups.values()) {
          const isBaseGroup = variants.some(v => v.toLowerCase() === baseSgbd.toLowerCase());
          const primaryVar = variants.slice().sort()[0]; // stable pick for the variant sgbd
          const sgbd = isBaseGroup ? baseSgbd : primaryVar;
          pushEntry(baseModule, sgbd, rowsFor(map));
        }
      }
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

// emit the structured index for the Lookup screen. sorted by chassis then module
// for stable diffs; each entry's faults keep their source order.
index.sort((a, b) => a.chassis.localeCompare(b.chassis) || String(a.module).localeCompare(String(b.module)));
const idxHeader = `// GENERATED FILE - do not edit by hand. Regenerate: node scripts/build-faultdb.mjs
// Structured per-ECU fault index for the Lookup screen (lookup.js). One entry per
// per-ECU file: { chassis, module, sgbd, scheme, faults: [[key, english, code], ...] }.
// scheme "code": key IS the hex DTC (code === key). scheme "text": key is the SGBD
// German fault text; code is its ORT hex from the FORTTEXTE table (data/ort-codes.json),
// or "" when the SGBD had no dump.
`;
const idxOut = path.join(root, 'app', 'renderer', 'faultindex.js');
const idxTotal = index.reduce((n, e) => n + e.faults.length, 0);
fs.writeFileSync(idxOut, `${idxHeader}window.BMW_FAULT_INDEX = ${JSON.stringify(index)};\n`);
console.log(`Wrote ${index.length} modules + ${idxTotal} faults to ${path.relative(root, idxOut)}.`);
