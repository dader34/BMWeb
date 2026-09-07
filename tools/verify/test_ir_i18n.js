#!/usr/bin/env node
// Guard: captions translate through EXACT dictionaries only (screens/ir.js
// irLabel): the ECU's own map from data/inpa-i18n/<ECU>.json, then the shared
// INPA chrome table. No word rules -- a caption with no entry shows as BMW
// wrote it, and strings BMW shipped in English are never touched.
//
//   node tools/verify/test_ir_i18n.js
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..', '..');
const IRDIR = path.join(R, 'data', 'inpa-ir');
const load = (stem) =>
  JSON.parse(fs.readFileSync(path.join(IRDIR, `${stem}.json`), 'utf8'));

let LANG = 'en';
const lang = () => LANG;
eval(fs.readFileSync(path.join(R, 'app/renderer/core/translate.js'), 'utf8'));
// the shared caption table the app loads as a data script
global.window = {
  BMW_I18N_SHARED: JSON.parse(
    fs.readFileSync(path.join(R, 'data/inpa-i18n/_shared.json'), 'utf8')
  ),
};
// `function` declarations inside eval() stay local to this scope, which is
// where the assertions run -- no copies of the code under test
eval(fs.readFileSync(path.join(R, 'app/renderer/screens/ir.js'), 'utf8'));

const fails = [];
const ok = (cond, msg) => {
  if (!cond) fails.push(msg);
};

// ---- the ECU's own map, resolved offline --------------------------------
// INPA prints ONE heading over ten keys ("ABS primary signals [pulses/sec]"),
// so each DWS row shows the SGBD's own description -- German. Those strings
// never appear in the .IPO, so the per-ECU file carries them explicitly.
{
  const dws = load('DWS');
  irUseTranslations(dws);
  for (const [de, en] of [
    [
      'Rohsignal vom DSC/ABS RL (Impulse/sec)',
      'Raw signal from DSC/ABS RL (pulses/sec)',
    ],
    ['Radgeschwindigkeit vorne links', 'Wheel speed front left'],
    ['ABS-Rohsignale [Hz]', 'ABS raw signals [Hz]'],
    ['Bandmode', 'Plant mode'],
  ]) {
    ok(
      irLabel(de) === en,
      `DWS irLabel(${JSON.stringify(de)}) = ${JSON.stringify(irLabel(de))}`
    );
  }
  // a key legend keeps its key and translates the caption after it
  ok(
    irLabel('< F4  >         Bandmode') === '< F4  >         Plant mode' &&
      irLabel('< Shift > + < F6 >  Bandmode') ===
        '< Shift > + < F6 >  Plant mode',
    `key legend: ${JSON.stringify(irLabel('< F4  >         Bandmode'))}`
  );
  // a padded caption resolves through its collapsed form and keeps its
  // indentation, so a translated cell stays on its column
  ok(
    irLabel('  Radgeschwindigkeit   vorne links :') ===
      '  Wheel speed front left :',
    `padded lookup: ${JSON.stringify(irLabel('  Radgeschwindigkeit   vorne links :'))}`
  );
  // strings BMW already shipped in English pass through untouched
  for (const eng of [
    'Closing impulses left',
    'Encoder impulse count',
    'wheel speed impulse :  ',
    'impulse open',
  ]) {
    ok(
      irLabel(eng) === eng && phraseText(eng) === eng,
      `English mangled: ${JSON.stringify(eng)} -> ${JSON.stringify(irLabel(eng))}`
    );
  }
  // "Original (EDIABAS)" shows BMW's strings verbatim
  LANG = 'orig';
  ok(irLabel('Bandmode') === 'Bandmode', 'orig mode must not translate');
  LANG = 'en';
  irUseTranslations(null);
}

// ---- whole-phrase menu captions -------------------------------------------
// "Fehlerspeicher lesen" is verb-last and no word table can reorder it -- so
// each is an entry in the ECU's own file, or in the shared softkey table.
{
  const ms = load('MS450');
  ok(
    ms.i18n && Object.keys(ms.i18n).length > 100,
    'MS450 should carry a resolved translation map'
  );
  ok(
    !ms.strings,
    'the emitter hand-off list should be consumed, not shipped to the app'
  );
  ok(
    phraseText('Gesteuerte LuftFührung GLF') === 'Gesteuerte LuftFührung GLF',
    'phraseText must pass an unknown caption through unchanged'
  );
  irUseTranslations(ms);
  for (const [de, en] of [
    ['Fehlerspeicher lesen', 'Read fault memory'],
    ['Fehlerspeicher löschen', 'Clear error memory'],
    ['Anpassungswerte selektiv löschen', 'Clear selected adaptation values'],
    ['SG-Identifikation', 'ECU identification'],
    ['Stellgliedansteuerungen', 'Actuator activations'],
    ['Systemdiagnosen', 'System diagnostics'],
    ['Bildschirm drucken', 'Print screen'],
    ['Gesteuerte LuftFührung GLF', 'Controlled air guidance (GLF)'],
    // monitor rows arrive at RUNTIME from the SGBD's result descriptions,
    // exactly what a word table mangled ("Zaehler Ueberdrehzahl" ->
    // "counter UeberRPM"), so the override ships whether or not the
    // bytecode holds the string
    ['Ansteuerung Einlass mit 50 %', 'Activate intake at 50%'],
    ['Ansteuerung zurück an DME', 'Return control to DME'],
    ['DMTL Heizung ein', 'DMTL heater on'],
    ['Einspritzventil Zylinder 3', 'Injector cylinder 3'],
    ['Sekundärluft Adaption', 'Secondary air adaptation'],
    ['Fehlzündung', 'Misfire'],
    ['Zähler Überdrehzahl', 'Overspeed counter'],
    ['KATÜberwachung', 'Catalyst monitoring'],
  ]) {
    ok(
      irLabel(de) === en,
      `MS450 irLabel(${JSON.stringify(de)}) = ${JSON.stringify(irLabel(de))}`
    );
  }
  // every MS450 caption the script prints should be English by now
  let german = 0;
  for (const [de, en] of Object.entries(ms.i18n)) {
    if (/[äöüßÄÖÜ]/.test(en)) german++;
    if (irLabel(de) !== en) fails.push(`MS450 map entry not honoured: ${de}`);
  }
  ok(german === 0, `MS450: ${german} translations still carry umlauts`);
  irUseTranslations(null);
}

// ---- the shared chrome table needs no ECU map ------------------------------
{
  irUseTranslations(null);
  const shared = global.window.BMW_I18N_SHARED;
  const [de, en] = Object.entries(shared)[0];
  ok(
    irLabel(de) === en,
    `shared table: ${JSON.stringify(de)} -> ${irLabel(de)}`
  );
  ok(irLabel('') === '' && irLabel(null) === null, 'empty passes through');
}

if (fails.length) {
  console.error(`test_ir_i18n: ${fails.length} failure(s)`);
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log('test_ir_i18n: all pins hold');
