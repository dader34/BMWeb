// Validates the community fault-code files in data/faults/*.json. Fails (exit 1)
// on anything that would break the lookup, so bad PRs are caught early.
//   node scripts/check-faults.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const faultsDir = path.join(root, 'data', 'faults');

const errors = [];
const warnings = [];
const seen = new Map(); // CODE -> file

const files = fs.readdirSync(faultsDir).filter(f => f.endsWith('.json')).sort();
if (files.length === 0) errors.push('no data/faults/*.json files found');

for (const file of files) {
  const full = path.join(faultsDir, file);
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (e) {
    errors.push(`${file}: invalid JSON - ${e.message}`);
    continue;
  }
  if (typeof obj !== 'object' || Array.isArray(obj) || obj === null) {
    errors.push(`${file}: must be a JSON object { "CODE": "description", ... }`);
    continue;
  }
  for (const [code, desc] of Object.entries(obj)) {
    // key: 3-5 hex chars, uppercase, no separators
    if (!/^[0-9A-F]{3,5}$/.test(code)) {
      errors.push(`${file}: bad code key "${code}" (want uppercase hex like 27DA, no dashes)`);
    }
    if (typeof desc !== 'string' || desc.trim().length === 0) {
      errors.push(`${file}: "${code}" has an empty or non-string description`);
    } else {
      if (desc.length > 80) warnings.push(`${file}: "${code}" description is long (${desc.length} chars)`);
      if (/[äöüÄÖÜß]/.test(desc)) warnings.push(`${file}: "${code}" still has German characters: "${desc}"`);
    }
    const up = code.toUpperCase();
    if (seen.has(up) && seen.get(up) !== file)
      warnings.push(`${up} appears in both ${seen.get(up)} and ${file}`);
    seen.set(up, file);
  }
}

for (const w of warnings) console.warn(`warning: ${w}`);
for (const e of errors) console.error(`error:   ${e}`);

if (errors.length) {
  console.error(`\nFAILED: ${errors.length} error(s), ${warnings.length} warning(s).`);
  process.exit(1);
}
console.log(`OK: ${seen.size} codes across ${files.length} file(s), ${warnings.length} warning(s).`);
