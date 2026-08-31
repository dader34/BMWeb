#!/usr/bin/env node
// The freeze-frame (Umwelt) dictionary: envmap.js ships curated English for
// the common env labels/enum values, and envLabel() is a pure lookup over it --
// a hit returns the English, a miss passes the German through unchanged, and it
// never calls the deGerman heuristic. Sandbox-eval like the other data files.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const R = path.join(__dirname, '..', '..');

let passed = 0;
const ok = (m) => { passed++; console.log(`  ok    ${m}`); };

// envmap.js sets a global; eval it in a sandbox so this test's `window` is the
// one translate.js reads.
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(R, 'app/renderer/data/envmap.js'), 'utf8'), sandbox);
const MAP = sandbox.window.BMW_ENV_TEXT;
assert.ok(MAP && typeof MAP === 'object', 'envmap.js must set window.BMW_ENV_TEXT');
ok('envmap.js sets window.BMW_ENV_TEXT');

// load envLabel() from translate.js against that same window. lang() is what
// gates the translation; provide it in the eval scope.
let lang = () => 'en';
global.window = sandbox.window;
eval(fs.readFileSync(path.join(R, 'app/renderer/core/translate.js'), 'utf8')
  // pull envLabel into this scope: translate.js's top-level `function`
  // declarations are visible after eval in the same scope.
);

// --- known keys translate ----------------------------------------------------
const known = {
  'Batteriespannung': 'Battery voltage',
  'Motordrehzahl': 'Engine RPM',
  'Fahrzeuggeschwindigkeit': 'Vehicle speed',
  'Zeit seit Startende': 'Time since engine start',
  'Abbtriebsdrehzahl': 'Output shaft RPM',
  'Beginnfehleruhr': 'Fault-onset time',
  'Endefehleruhr': 'Fault-end time',
  '2 IS - Motor im Leerlauf': '2 IS - engine idling',
  '1. Gang': '1st gear',
};
for (const [de, en] of Object.entries(known)) {
  assert.strictEqual(MAP[de], en, `dictionary: ${de} -> ${en}`);
  assert.strictEqual(envLabel(de), en, `envLabel(${JSON.stringify(de)}) -> ${en}`);
}
ok(`envLabel translates the known env labels and enum values (${Object.keys(known).length} checked)`);

// leading/trailing whitespace on the incoming string is trimmed before lookup
assert.strictEqual(envLabel('  Batteriespannung  '), 'Battery voltage',
  'envLabel must trim before lookup');
ok('envLabel trims the input before the lookup');

// --- an unknown string passes through unchanged ------------------------------
const unknown = 'Völlig Unbekannter Umweltwert XYZ';
assert.strictEqual(envLabel(unknown), unknown,
  'an untranslated German string must pass through unchanged');
assert.ok(!(unknown in MAP), 'the unknown string must not be in the dictionary');
ok('envLabel passes an unknown string through unchanged (no heuristic munging)');

// --- Original (EDIABAS) mode keeps German ------------------------------------
lang = () => 'orig';
assert.strictEqual(envLabel('Batteriespannung'), 'Batteriespannung',
  'Original mode must keep the German label');
ok('envLabel keeps German in Original (EDIABAS) mode');
lang = () => 'en';

console.log(`\nenv-i18n: ${passed} checks passed`);
