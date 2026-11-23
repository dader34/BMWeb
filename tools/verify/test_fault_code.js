#!/usr/bin/env node
// Which number a fault is shown under (core/translate.js bmwCode /
// bmwTextCode, screens/module/faults.js faultFields).
//
// THE BUG THIS PINS. The code was "whatever 3-5 hex characters the fault's
// text begins with". A DME's text does lead with the fault's number ("27DA
// BSD-Generator") -- but a fault the SGBD has no row for gets the table's
// default text, "FFFF unbekannter Fehlerort", so every unknown fault was
// shown as code FFFF while the module had said 1F27; and a text that begins
// with a word made of A-F ("ACC-relevanter Fehler DSC", "DDE-Hauptrelais")
// or with another fault's number ("4214 Freigabeleitung zum CAS" under
// 4219) gave that as the code. The token is the code when it IS the fault's
// own number, and only then.
//
// The MS45 rows below are what its FS_LESEN job returns for those fault
// words, replayed through the VM (F_ORT_NR is the number; the text is the
// row it found, or the default row).
//
//   node tools/verify/test_fault_code.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const R = path.join(__dirname, '..', '..', 'app', 'renderer');
let passed = 0;
const ok = (what) => {
  passed++;
  if (process.env.V) console.log('  ok', what);
};

const ctx = {
  console,
  lang: () => 'en',
  ENV_NO_UNIT: '-',
  // where the fault database is fetched from: nothing is fetched here
  HF_MIRRORS: [],
  hfFolderMirrors: () => [],
  window: {
    // the MS45's own codespace, and the flat one every module shares
    BMW_FAULT_DB_SCOPED: { ms450ds0: { '27DA': 'Alternator BSD fault' } },
    BMW_FAULT_DB: { '5DC2': 'Steering angle sensor' },
  },
};
vm.createContext(ctx);
for (const f of ['core/translate.js', 'screens/module/faults.js'])
  vm.runInContext(fs.readFileSync(path.join(R, f), 'utf8'), ctx, {
    filename: f,
  });
const call = (expr) => vm.runInContext(expr, ctx);
ctx.c = null;
const fields = (c, sgbd) => {
  ctx.c = c;
  return call(`faultFields(c, ${JSON.stringify(sgbd || '')})`);
};
const code = (loc, hex, nr) => {
  ctx.c = { loc, hex, nr };
  return call('bmwCode(c.loc, c.hex, c.nr)');
};

// ---- the text's number is the code when it is the fault's own ---------------
{
  // as the VM returns them: the fault word as bytes, the number as a number
  assert.strictEqual(
    code('27DA BSD-Generator', [0x27, 0xda, 0x19], 10202),
    '27DA'
  );
  assert.strictEqual(
    code('2761 Sekundärluftsystem', '27-61-19', '10081'),
    '2761'
  );
  // a three-character number is one too
  assert.strictEqual(code('0E5 Drosselklappe', '', 229), '0E5');
  // a reader that gives the fault word and an index: the word decides
  assert.strictEqual(code('27C3 Lambdasonde', '27-C3', 31), '27C3');
  ok("a text leading with the fault's own number: that number");
}

// ---- and not when it is the default row, a word, or another fault's ---------
{
  // the SGBD has no row for 1F27: the default text, the fault's own code
  assert.strictEqual(
    code('FFFF unbekannter Fehlerort', [0x1f, 0x27, 0x2d], 7975),
    '1F27',
    'an unknown fault is shown under FFFF'
  );
  // words made of A-F, as the shipped fault tables have them
  for (const [text, nr, want] of [
    ['ACC-relevanter Fehler DSC', 0x5d17, '5D17'],
    ['DDE-Hauptrelais', 0x3510, '3510'],
    ['ADC Spannungsteiler Ubat nicht ok', 0x9c41, '9C41'],
    ['CBD -Block - CRC Fehler', 0x93d3, '93D3'],
    // BMW's own: one text for several faults, under one of their numbers
    ['4214 Freigabeleitung zum CAS, Ansteuerung', 0x4219, '4219'],
  ]) {
    const word = [nr >> 8, nr & 0xff, 0x21];
    assert.strictEqual(code(text, word, nr), want, `"${text}" under ${want}`);
  }
  // a body module's one-byte location: the word is no code, and there is none
  ctx.c = { loc: 'ADF', nr: 0x6b };
  assert.strictEqual(call('bmwTextCode(c.loc, "", c.nr)'), null);
  ok(
    "the default row, a word of A-F and another fault's number are not the code"
  );
}

// ---- what the fault list shows ------------------------------------------------
{
  const known = fields(
    {
      F_ORT_TEXT: '27DA BSD-Generator',
      F_HEX_CODE: [0x27, 0xda, 0x19],
      F_ORT_NR: 10202,
    },
    'ms450ds0'
  );
  assert.strictEqual(known.code, '27DA');
  assert.strictEqual(known.name, '27DA Alternator BSD fault');

  // the unknown fault: its own number (the module's codespace is 16-bit),
  // and the module's own words, since nothing names it
  const unknown = fields(
    {
      F_ORT_TEXT: 'FFFF unbekannter Fehlerort',
      F_HEX_CODE: [0x1f, 0x27, 0x2d],
      F_ORT_NR: 7975,
    },
    'ms450ds0'
  );
  assert.strictEqual(
    unknown.code,
    '1F27',
    'an unknown DME fault lost its number'
  );
  assert.strictEqual(unknown.name, 'FFFF unbekannter Fehlerort');
  assert.strictEqual(unknown.hex, '1F-27-2D');

  // a module with NO codespace of its own keeps the rule it had: a 16-bit
  // number the shared list knows is a code, one it does not is a location
  // byte with its detail (LWS 0B3F -> 0B)
  assert.strictEqual(
    fields({ F_ORT_TEXT: 'Lenkwinkelsensor', F_ORT_NR: 0x5dc2 }, 'dsc').code,
    '5DC2'
  );
  assert.strictEqual(
    fields(
      { F_ORT_TEXT: 'Sensorstrom ausserhalb Toleranz', F_ORT_NR: 0x0b3f },
      'lws5'
    ).code,
    '0B'
  );
  ok("the list shows the fault's own number, known or not");
}

console.log(`test_fault_code: ${passed} checks passed`);
