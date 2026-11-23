#!/usr/bin/env node
// The label a coding keyword is shown under (screens/coding/vocab.js): an
// exact translation, or the keyword as BMW wrote it -- never something made
// from its parts.
//
// THE BUG THIS PINS. A 500-word German glossary used to be applied word by
// word, and its result "tidied": EKS_GEDRUECKT/OFFEN was shown as
// "EKS_GEDRUECKT/open", and 300 of BMW's own identifiers were re-cased
// (VBATTOPLIMIT as "Vbattoplimit"). A label that is half a guess is worse
// than the keyword: it is what the user reads before writing to the car.
//
//   node tools/verify/test_coding_labels.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'app/renderer/screens/coding/vocab.js'),
  'utf8'
);
let passed = 0;
const ok = (what) => {
  passed++;
  if (process.env.V) console.log('  ok', what);
};
/** The file as the page runs it, over a community list and a language. */
const load = (i18n, language) => {
  const ctx = { window: { BMW_DATEN_I18N: i18n }, lang: () => language };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return ctx.window;
};

{
  const { datLabel, datI18n } = load(
    { kaltueberwachung_bl: 'Cold monitoring, brake lights', aktiv: 'Enabled' },
    'en'
  );
  assert.strictEqual(
    datLabel('KALTUEBERWACHUNG_BL'),
    'Cold monitoring, brake lights'
  );
  assert.strictEqual(datLabel('aktiv'), 'Enabled');
  assert.strictEqual(
    datI18n('KALTUEBERWACHUNG_BL'),
    datLabel('KALTUEBERWACHUNG_BL')
  );
  ok('a keyword the community list carries is shown as that list has it');

  // nothing else is translated, in whole or in part: these all hold words
  // the old glossary knew (OFFEN, FH, AUF, ZV, GRAD)
  for (const kw of [
    'EKS_GEDRUECKT/OFFEN',
    'FH_FAHRERTUER_TIPP_AUF',
    'ZV_SELEKTIV',
    'VBATTOPLIMIT',
    'AUTO_LED/SCHRIFTZUG',
    '0_005nms/grad',
  ]) {
    assert.strictEqual(datLabel(kw), kw, `${kw} is shown as BMW wrote it`);
    assert.strictEqual(datI18n(kw), '', `${kw} has no translation`);
  }
  assert.strictEqual(datLabel('nicht_aktiv'), 'Nicht_aktiv');
  assert.strictEqual(datLabel('wert_01'), 'Wert_01');
  ok('a keyword with no translation is the keyword, its first letter raised');

  // the hand-kept translations are WHOLE keywords
  assert.strictEqual(datLabel('TYP'), 'Type');
  assert.strictEqual(datLabel('gong'), 'Chime');
  assert.strictEqual(datLabel('TYP_E46'), 'TYP_E46');
  assert.strictEqual(datLabel('GONG_TYP'), 'GONG_TYP');
  ok('a hand translation is of a whole keyword, never of a part');

  assert.strictEqual(datLabel(''), '');
  assert.strictEqual(datLabel(null), '');
  assert.strictEqual(datI18n(undefined), '');
  // a keyword named like something every object has is still just a keyword
  assert.strictEqual(datI18n('constructor'), '');
  assert.strictEqual(datLabel('toString'), 'ToString');
  ok('nothing, and a keyword named like a built-in');
}

{
  // orig (EDIABAS) language: BMW's keyword, untouched
  const { datLabel, datI18n } = load({ aktiv: 'Enabled' }, 'orig');
  assert.strictEqual(datLabel('aktiv'), 'aktiv');
  assert.strictEqual(datLabel('TYP'), 'TYP');
  assert.strictEqual(datI18n('aktiv'), '');
  ok('the original-language setting shows the keyword itself');
}

console.log(`test_coding_labels: ${passed} checks passed`);
