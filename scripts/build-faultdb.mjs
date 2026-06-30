// Generates app/renderer/faultdb.js from the community translation files in
// data/faults/*.json. Run after editing any translation file:
//   node scripts/build-faultdb.mjs
// Contributors edit only the JSON; this regenerates the bundled lookup.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const faultsDir = path.join(root, 'data', 'faults');
const out = path.join(root, 'app', 'renderer', 'faultdb.js');

const files = fs.readdirSync(faultsDir).filter(f => f.endsWith('.json')).sort();
const merged = {};
const sources = {}; // code -> file, to report collisions
let total = 0;

for (const file of files) {
  const obj = JSON.parse(fs.readFileSync(path.join(faultsDir, file), 'utf8'));
  for (const [code, desc] of Object.entries(obj)) {
    const key = code.toUpperCase();
    if (key in merged && merged[key] !== desc)
      console.warn(`! ${key} differs across ${sources[key]} and ${file} (last wins)`);
    merged[key] = desc;
    sources[key] = file;
    total++;
  }
}

// emit sorted, grouped by 2-char prefix for readable diffs
const keys = Object.keys(merged).sort();
let body = '';
let last = null;
for (const k of keys) {
  const pre = k.slice(0, 2);
  if (pre !== last) { body += `  // ${pre}xx\n`; last = pre; }
  body += `  '${k}': ${JSON.stringify(merged[k])},\n`;
}

const header = `// GENERATED FILE - do not edit by hand.
// Source: data/faults/*.json. Regenerate with: node scripts/build-faultdb.mjs
// hex DTC (first token of F_ORT_TEXT, e.g. "27DA") -> English. used by faults.js.
`;
fs.writeFileSync(out, `${header}window.BMW_FAULT_DB = {\n${body}};\n`);
console.log(`Wrote ${keys.length} codes to ${path.relative(root, out)} from ${files.length} file(s).`);
