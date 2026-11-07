#!/usr/bin/env node
// The Fault codes rail page of the Flashing/Tuning app
// (app/renderer/screens/flashing/faults-page.js): the part with no car in it.
//
// WHAT THIS PROVES
//   1. A row is the shared fault projection plus what a detail read adds:
//      the mileage (the flat F_UW_KM result, digits only) and the freeze
//      frame; a plain read leaves both empty.
//   2. The CSV names the module, quotes what needs quoting, and flattens the
//      freeze frame into one cell.
//   3. The gates: a chosen DME reads without Identify; a transmission
//      waits for Identify to name its SGBD; nothing reads while the screen
//      is busy; the table marks a present fault and lists its freeze frame.
//
// Run: node tools/verify/test_faults_page.js
const assert = require('assert');
const path = require('path');

// the screen's globals the page reads (the real ones live in screen.js,
// module/faults.js and core/translate.js)
const el = () => {
  const e = { disabled: false, checked: false, textContent: '', className: '' };
  return e;
};
const list = { innerHTML: '' };
global.fbEls = {
  'dtc-read': el(),
  'dtc-clear': el(),
  'dtc-scan': el(),
  'dtc-csv': el(),
  'dtc-detail': el(),
  'dtc-status': el(),
  'dtc-list': list,
};
global.fbState = { module: null, running: false, page: 'faults', tcu: {} };
global.Settings = { get: (k, d) => d, set: () => {} };
global.esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
  );
global.phraseText = (s) => (s === 'MIL an' ? 'MIL on' : s || '');
global.envPairs = (c) =>
  c.F_UW1_TEXT ? [[c.F_UW1_TEXT, `${c.F_UW1_WERT} ${c.F_UW1_EINH}`]] : [];
global.faultFields = (c, sgbd) => ({
  code: c.F_ORT_TEXT.slice(0, 4),
  hex: '',
  pcode: c.F_PCODE_STRING || '',
  name: `${c.F_ORT_TEXT}${sgbd === 'ms450ds0' ? '' : ' ?'}`,
  present: /momentan vorhanden/.test(c.F_VORHANDEN_TEXT || ''),
  ftype: /statisch/.test(c.F_ART1_TEXT || '') ? 'static' : '',
  count: c.F_HFK || '',
});

const P = require(
  path.join(__dirname, '../../app/renderer/screens/flashing/faults-page.js')
);

let passed = 0;
const ok = (m) => {
  passed++;
  console.log(`  ok    ${m}`);
};

// ---- 1. a row --------------------------------------------------------------
const plain = {
  F_ORT_NR: 10,
  F_ORT_TEXT: '27DA BSD-Generator',
  F_VORHANDEN_TEXT: 'momentan vorhanden',
  F_ART1_TEXT: 'statisch',
  F_HFK: 3,
};
let r = P.fbFaultsRow(plain, 'ms450ds0');
assert.strictEqual(r.code, '27DA');
assert.strictEqual(r.name, '27DA BSD-Generator');
assert.strictEqual(r.present, true);
assert.strictEqual(r.ftype, 'static');
assert.strictEqual(
  P.fbFaultsRow({ ...plain, F_ART1_TEXT: '-' }, 'ms450ds0').ftype,
  '',
  'a "-" type is nothing'
);
assert.strictEqual(r.count, 3);
assert.strictEqual(r.km, '');
assert.deepStrictEqual(r.env, []);
ok('a plain read: the shared projection, no mileage, no freeze frame');

const detailed = {
  ...plain,
  F_PCODE_STRING: 'P0620',
  F_UW_KM: '183 432 km',
  F_WARNUNG_TEXT: 'MIL an',
  F_UW1_TEXT: 'Drehzahl',
  F_UW1_WERT: 812,
  F_UW1_EINH: '1/min',
};
r = P.fbFaultsRow(detailed, 'ms450ds0');
assert.strictEqual(r.pcode, 'P0620');
assert.strictEqual(r.km, '183432', 'digits only');
assert.strictEqual(r.warn, 'MIL on');
assert.deepStrictEqual(r.env, [['Drehzahl', '812 1/min']]);
ok('a detail read: P-code, mileage as digits, warning lamp, freeze frame');

// ---- 2. the CSV ------------------------------------------------------------
P.fbFaults.sgbd = 'ms450ds0';
P.fbFaults.readAt = new Date('2026-11-06T16:00:00.000Z');
P.fbFaults.rows = [
  r,
  P.fbFaultsRow(
    { ...plain, F_ORT_NR: 11, F_ORT_TEXT: '2A5F Lambda, "Bank 1"' },
    'ms450ds0'
  ),
];
const csv = P.fbFaultsCsv().split('\n');
assert.strictEqual(
  csv[0],
  'module,code,p_code,fault,status,type,count,mileage_km,freeze_frame,read_at'
);
assert.strictEqual(
  csv[1],
  'ms450ds0,27DA,P0620,27DA BSD-Generator,present,static,3,183432,Drehzahl: 812 1/min,2026-11-06T16:00:00.000Z'
);
assert.ok(csv[2].includes('"2A5F Lambda, ""Bank 1"""'), 'quoted and doubled');
assert.strictEqual(csv[3], '', 'ends with a newline');
ok('the CSV: the module, one row per fault, quoting, the freeze frame flat');

// ---- 3. the gates and the table -------------------------------------------
const E = global.fbEls;
P.fbFaults.rows = [];
P.fbFaults.readAt = null;
P.fbFaults.sgbd = '';

global.fbState.module = null;
P.fbFaultsPaint();
assert.strictEqual(E['dtc-read'].disabled, true);
assert.strictEqual(E['dtc-clear'].disabled, true);
assert.strictEqual(E['dtc-scan'].disabled, true);
assert.strictEqual(E['dtc-status'].textContent, 'Choose a control unit above.');
assert.ok(/Not read yet/.test(list.innerHTML));
ok('no module chosen: nothing to read, the status line says so');

global.fbState.module = 'tcu';
global.fbState.tcu = { sgbd: null };
P.fbFaultsPaint();
assert.strictEqual(E['dtc-read'].disabled, true);
assert.strictEqual(E['dtc-status'].textContent, 'Identify the TCU first.');
ok('a transmission not yet identified: Read waits for its SGBD');

global.fbState.tcu = { sgbd: 'gs20' };
P.fbFaultsPaint();
assert.strictEqual(E['dtc-read'].disabled, false);
assert.strictEqual(E['dtc-status'].textContent, '');
ok('an identified GS20: Read over gs20');

global.fbState.module = 'dme';
P.fbFaultsPaint();
assert.strictEqual(E['dtc-read'].disabled, false);
assert.strictEqual(E['dtc-csv'].disabled, true, 'nothing read yet');
assert.strictEqual(E['dtc-status'].textContent, '');
ok('a DME: Read without Identify, over ms450ds0');

global.fbState.running = true;
P.fbFaultsPaint();
assert.strictEqual(E['dtc-read'].disabled, true);
assert.strictEqual(E['dtc-clear'].disabled, true);
global.fbState.running = false;
ok('the screen busy: Read and Clear wait');

P.fbFaults.sgbd = 'ms450ds0';
P.fbFaults.readAt = new Date('2026-11-06T16:00:00.000Z');
P.fbFaults.rows = [
  P.fbFaultsRow(detailed, 'ms450ds0'),
  P.fbFaultsRow(
    {
      ...plain,
      F_ORT_NR: 12,
      F_ORT_TEXT: '2A5F Lambda',
      F_VORHANDEN_TEXT: 'nicht vorhanden',
    },
    'ms450ds0'
  ),
];
P.fbFaultsPaint();
assert.strictEqual(E['dtc-csv'].disabled, false);
assert.ok(
  /^2 faults · 1 present · ms450ds0 · /.test(E['dtc-status'].textContent)
);
const rows = list.innerHTML.match(/<tr[^>]*>/g);
assert.deepStrictEqual(rows, [
  '<tr>',
  '<tr class="present fb-faults-has-env">',
  '<tr class="fb-faults-env">',
  '<tr class="">',
]);
assert.ok(
  list.innerHTML.startsWith('<table class="tn-faults-table fb-faults-table">')
);
assert.ok(
  list.innerHTML.includes('<th>Mileage</th>'),
  'a detail read adds the column'
);
assert.ok(
  list.innerHTML.includes(
    '<td class="mono">27DA <span class="tn-faults-p">P0620</span></td>'
  )
);
assert.ok(
  list.innerHTML.includes('<td>BSD-Generator</td>'),
  'the code is not repeated in the name'
);
assert.ok(list.innerHTML.includes('<td>present · static · MIL on</td>'));
assert.ok(
  list.innerHTML.includes(
    '<td class="mono">3</td><td class="mono">183,432</td>'
  )
);
assert.ok(
  list.innerHTML.includes(
    '<td colspan="5"><span class="fb-faults-kv"><span class="fb-faults-k">Drehzahl</span> 812 1/min</span></td>'
  )
);
assert.ok(list.innerHTML.includes('<td>stored · static</td>'));
assert.ok(!list.innerHTML.includes('>-<'), 'no "-" type');
ok(
  'the list: a present fault marked, its freeze frame under it, a stored one plain'
);

P.fbFaults.rows = [P.fbFaultsRow(plain, 'ms450ds0')];
P.fbFaultsPaint();
assert.ok(
  !list.innerHTML.includes('Mileage'),
  'no column without a detail read'
);
assert.ok(!list.innerHTML.includes('fb-faults-env'));
assert.ok(list.innerHTML.includes('<td class="mono">27DA</td>'));
ok('a plain read: four columns, no freeze-frame line');

P.fbFaults.rows = [];
P.fbFaultsPaint();
assert.ok(/tn-faults-empty">No faults stored/.test(list.innerHTML));
assert.ok(/^0 faults/.test(E['dtc-status'].textContent));
ok('a clean memory says so');

// ---- 4. the clear after a flash -------------------------------------------
const calls = [];
const logLines = [];
/** @type {Object<string, 'ok'|'refuse'|'silent'>} what each SGBD does */
let answers = {};
global.webRunJob = async (sgbd, job, arg) => {
  calls.push([sgbd, job, arg]);
  const how = answers[sgbd] || 'ok';
  if (how === 'silent') throw new Error('no answer');
  return {
    sets: [{ JOB_STATUS: how === 'ok' ? 'OKAY' : 'ERROR_ECU_REJECTED' }],
  };
};
global.fbLog = (line) => logLines.push(line);
global.fbDescribeError = (e) => e.message;
global.flashLog = { note: () => {} };
global.FB_TCU_VARIANTS = ['gs20', 'gs8600', 'gs8602'];
let settingOn = false;
global.Settings.get = (k, d) => (k === 'flashClearFaults' ? settingOn : d);
const sgbds = () => calls.map((c) => c[0]);
const logged = (re) => logLines.some((l) => re.test(l));
(async () => {
  global.fbState.module = 'dme';
  global.fbState.tcu = { sgbd: null };
  assert.strictEqual(await P.fbFaultsClearAfterFlash('dme'), false);
  assert.deepStrictEqual(calls, []);
  ok('the setting off: nothing is sent');

  settingOn = true;
  answers = { gs20: 'silent' };
  assert.strictEqual(await P.fbFaultsClearAfterFlash('dme'), true);
  assert.deepStrictEqual(sgbds(), ['ms450ds0', 'gs20', 'gs8600']);
  assert.ok(calls.every((c) => c[1] === 'FS_LOESCHEN' && c[2] === ''));
  assert.ok(logged(/^DME fault memory cleared after the flash$/));
  assert.ok(logged(/^TCU \(gs8600\) fault memory cleared after the flash$/));
  assert.strictEqual(
    P.fbFaults.tcuSgbd,
    'gs8600',
    'the variant that answered is kept'
  );
  assert.strictEqual(
    P.fbFaults.readAt,
    null,
    'the list read before the flash is dropped'
  );
  ok('a DME flash: the DME, then the transmission found by variant');

  calls.length = 0;
  assert.strictEqual(await P.fbFaultsClearAfterFlash('dme'), true);
  assert.deepStrictEqual(sgbds(), ['ms450ds0', 'gs8600']);
  ok('next time the variant that answered is tried first');

  calls.length = 0;
  global.fbState.tcu = { sgbd: 'gs20' };
  answers = {};
  assert.strictEqual(await P.fbFaultsClearAfterFlash('tcu'), true);
  assert.deepStrictEqual(sgbds(), ['gs20', 'ms450ds0']);
  ok('a transmission flash: the identified TCU first, then the DME');

  calls.length = 0;
  logLines.length = 0;
  global.fbState.tcu = { sgbd: null };
  P.fbFaults.tcuSgbd = '';
  answers = {
    ms450ds0: 'silent',
    gs20: 'silent',
    gs8600: 'silent',
    gs8602: 'silent',
  };
  assert.strictEqual(await P.fbFaultsClearAfterFlash('dme'), false);
  assert.deepStrictEqual(sgbds(), ['ms450ds0', 'gs20', 'gs8600', 'gs8602']);
  assert.ok(
    logged(/^DME fault memory not cleared after the flash: no answer$/)
  );
  assert.ok(
    logged(
      /^TCU fault memory not cleared after the flash: no transmission answered$/
    )
  );
  ok('nothing answers (a manual car, a dead line): two log lines, no throw');

  calls.length = 0;
  logLines.length = 0;
  answers = { ms450ds0: 'refuse', gs20: 'refuse' };
  assert.strictEqual(await P.fbFaultsClearAfterFlash('dme'), true);
  assert.ok(
    logged(/^DME fault memory not cleared after the flash: the DME refused$/)
  );
  assert.ok(logged(/^TCU \(gs8600\) fault memory cleared after the flash$/));
  ok('a refusal is told apart from silence, and the next variant still tried');

  console.log(`\n${passed} passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
