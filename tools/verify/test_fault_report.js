#!/usr/bin/env node
// The Full Module Error Scan PDF: layout invariants for the two report builders
// in app/renderer/screens/fault-report.js.
//
// The bug this guards against: each faulty module renders its OWN <table>, and
// with an elastic DESCRIPTION column and no shared fixed <colgroup> the browser
// auto-sized Code/Type/Count/State to a different x-position in every block --
// so scanning the report the STATE column wandered left/right module to module,
// and a compact (no-detail) module dropped Type/Count entirely, moving STATE
// again. The fix is ONE faultColumns() definition, always five fixed-width
// columns, feeding an explicit <colgroup> in both the native savePdf path
// (faultModuleBlock) and the web print path (printFaultReport).
//
// So the invariants under test:
//   1. faultColumns() is always the same 5 columns (never 3) -- detail and
//      compact modules share the grid, so STATE stays put.
//   2. In BOTH render paths, every module table emits a <colgroup> with as many
//      <col> as there are <th>, and every body fault row emits exactly that many
//      <td>. Header count == cell count, for a module WITH detail and one
//      WITHOUT -- if a path ever drops a column for compact modules again, the
//      counts diverge and this fails.
//   3. A freeze-frame env pair is emitted as one label+value unit that a wrap
//      can't split, and its row carries a break-inside:avoid class.
//
//   node tools/verify/test_fault_report.js

const assert = require('assert');
const path = require('path');

let passed = 0;
const ok = (what) => {
  passed++;
  if (process.env.V) console.log('  ok', what);
};

// ---- stub the free globals the browser script leans on --------------------
// fault-report.js is a browser <script>; in Node we give it just enough of the
// renderer's ambient helpers to run the pure builders. faultFields / envPairs
// are stubbed so THIS test controls whether a module reads as detailed and
// whether a fault carries an env snapshot -- the point is the column grid, not
// the fault decode (faults.js owns that, tested elsewhere).
global.esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
global.APP_NAME = 'BMWeb';
global.IS_WEB = true;
global.dispChassis = (id) => id || 'E46';

// codes ARE already field objects in the fixtures (faultFields is identity).
// env pairs are keyed by object identity via a Map so distinct fault objects
// don't collide the way plain-object keys ("[object Object]") would.
let ENV = new Map(); // fault-object -> [[k,v],...]
global.envPairs = (c) => ENV.get(c) || [];
global.faultFields = (c) => c;

// printFaultReport is async and ends in printDoc(); capture the section HTML it
// builds instead of printing. printHeading/printHtml mirror core/print.js.
let CAPTURED = null;
global.printHeading = (t) => ({
  html: `<h2 class="pr-h2">${global.esc(t)}</h2>`,
});
global.printHtml = (h) => ({ html: h || '' });
global.printDoc = (opts) => {
  CAPTURED = opts;
  return Promise.resolve();
};
global.loadFaultMeta = async () => {};
global.loadPcodes = async () => {};

const R = require(
  path.join(
    __dirname,
    '..',
    '..',
    'app',
    'renderer',
    'screens',
    'fault-report.js'
  )
);

// ---- helpers to count columns in a rendered table -------------------------
const count = (html, re) => (html.match(re) || []).length;
// <th>, <td>, <col> counts. The env row's colspan <td> is excluded from the
// per-fault cell count by matching only rows without an env class.
function tableParts(tableHtml) {
  const colgroup = /<colgroup>([\s\S]*?)<\/colgroup>/.exec(tableHtml);
  const thead = /<thead>([\s\S]*?)<\/thead>/.exec(tableHtml);
  return {
    cols: colgroup ? count(colgroup[1], /<col\b/g) : 0,
    ths: thead ? count(thead[1], /<th\b/g) : 0,
    html: tableHtml,
  };
}
// the first ordinary fault row (not an env row) and its <td> count
function firstFaultRowCells(tableHtml, faultRowClass) {
  const re = new RegExp(
    `<tr class="[^"]*${faultRowClass}[^"]*">([\\s\\S]*?)</tr>`
  );
  const m = re.exec(tableHtml);
  assert.ok(m, `no fault row (.${faultRowClass}) in table`);
  return count(m[1], /<td\b/g);
}

// ---- fixtures --------------------------------------------------------------
// A detailed module (ms450ds0-like): faults carry type + count, one with env.
const detailFaults = [
  {
    code: 'P0301',
    pcode: 'P0301',
    hex: '',
    name: 'Cyl 1 misfire',
    present: true,
    ftype: 'static',
    count: '3',
  },
  {
    code: 'P0420',
    pcode: 'P0420',
    hex: '',
    name: 'Catalyst below threshold',
    present: false,
    ftype: 'intermittent',
    count: '1',
  },
  {
    code: '5DC2',
    pcode: '',
    hex: '',
    name: 'No detail on this one',
    present: false,
    ftype: '',
    count: '',
  }, // still 5 columns; type/count '—'
];
// A compact module (dsc_mk60-like): state only, no type/count, no env.
const compactFaults = [
  {
    code: '5DC2',
    pcode: '',
    hex: '',
    name: 'Wheel speed sensor FL',
    present: true,
    ftype: '',
    count: '',
  },
  {
    code: '5DC3',
    pcode: '',
    hex: '',
    name: 'Wheel speed sensor FR',
    present: false,
    ftype: '',
    count: '',
  },
];
// A body module (mrs4-like): env with Begin/Endefehleruhr, no type/count.
const bodyFaults = [
  {
    code: '00A2',
    pcode: '',
    hex: '',
    name: 'Crash sensor',
    present: false,
    ftype: '',
    count: '',
  },
];

// ---- 1. faultColumns is always the same five ------------------------------
{
  const cols = R.faultColumns();
  assert.strictEqual(
    cols.length,
    5,
    `faultColumns must be 5 (Code/Description/Type/Count/State); got ${cols.length}`
  );
  assert.deepStrictEqual(
    cols.map((c) => c.key),
    ['code', 'name', 'type', 'count', 'state'],
    'faultColumns order changed -- both paths depend on it'
  );
  // Code/Type/Count/State are fixed-width; Description is the elastic one.
  for (const c of cols) {
    if (c.key === 'name')
      assert.strictEqual(
        c.width,
        '',
        'Description must stay elastic (no fixed width)'
      );
    else
      assert.ok(
        c.width,
        `${c.key} needs a fixed <colgroup> width to align across blocks`
      );
  }
  ok('faultColumns() is one fixed 5-column grid, Description elastic');
}

// ---- 2. native savePdf path: header == col == cell, both branches ---------
function checkNative(label, sgbd, codes) {
  const html = R.faultModuleBlock(label, sgbd, codes);
  const p = tableParts(html);
  assert.strictEqual(p.ths, 5, `${label}: expected 5 <th>, got ${p.ths}`);
  assert.strictEqual(
    p.cols,
    5,
    `${label}: <colgroup> must have 5 <col>, got ${p.cols}`
  );
  const cells = firstFaultRowCells(html, 'faultrow');
  assert.strictEqual(
    cells,
    p.ths,
    `${label}: fault row has ${cells} <td> but header has ${p.ths} <th>`
  );
  return html;
}
{
  ENV = new Map();
  const withDetail = checkNative('ms450ds0', 'ms450ds0', detailFaults);
  const compact = checkNative('dsc_mk60', 'dsc_mk60', compactFaults);
  // the compact module still reserves Type/Count (blank), so STATE aligns
  assert.ok(
    /<col style="width:/.test(compact),
    'compact module lost its fixed <colgroup> -- STATE would drift'
  );
  ok('native faultModuleBlock: 5 th == 5 col == 5 td for detail AND compact');
}

// ---- 3. env pairs stay paired (native) ------------------------------------
{
  ENV = new Map([
    [
      detailFaults[0],
      [
        ['Begin', '1000 km'],
        ['Endefehleruhr', '55 h'],
        ['Battery', '13.10 V'],
        ['RPM', '750 1/min'],
      ],
    ],
  ]);
  const html = R.faultModuleBlock('ms450ds0', 'ms450ds0', detailFaults);
  assert.ok(/class="envrow"/.test(html), 'env row missing');
  // each pair is one .e-item carrying BOTH .e-k and .e-v -- the value can't
  // detach from its label because they live in the same grid cell
  const items =
    html.match(/<span class="e-item">[\s\S]*?<\/span><\/span>/g) || [];
  assert.strictEqual(
    items.length,
    4,
    `expected 4 paired env items, got ${items.length}`
  );
  for (const it of items) {
    assert.ok(
      /class="e-k"/.test(it) && /class="e-v"/.test(it),
      'an env item lost its label or value -- pair broken'
    );
  }
  // the fault row and its env row both carry break-avoid classes
  assert.ok(
    /<tr class="faultrow/.test(html) && /<tr class="envrow"/.test(html),
    'fault row / env row classes missing (page-break-inside:avoid hook)'
  );
  ok('native env pairs render as inseparable label+value units');
}

// ---- 4. web print path: header == col == cell, both branches --------------
// the web builder is async (printFaultReport), so its checks run inside main().
async function checkWeb(label, faultyList) {
  CAPTURED = null;
  await R.printFaultReport('E46', faultyList, { scanned: 1, skipped: 0 });
  assert.ok(CAPTURED && CAPTURED.sections, `${label}: printDoc not called`);
  // sections alternate heading, table, heading, table...; find the tables
  const tables = CAPTURED.sections
    .map((s) => (s && s.html) || '')
    .filter((h) => /<table class="pr-table/.test(h));
  assert.ok(
    tables.length === faultyList.length,
    `${label}: expected ${faultyList.length} tables, got ${tables.length}`
  );
  for (const t of tables) {
    const p = tableParts(t);
    assert.strictEqual(
      p.ths,
      5,
      `${label}: web table needs 5 <th>, got ${p.ths}`
    );
    assert.strictEqual(
      p.cols,
      5,
      `${label}: web table needs 5 <col>, got ${p.cols}`
    );
    const cells = firstFaultRowCells(t, 'pr-faultrow');
    assert.strictEqual(
      cells,
      p.ths,
      `${label}: web fault row ${cells} <td> vs ${p.ths} <th>`
    );
    assert.ok(
      /table-layout|pr-fault-table/.test(t) || /pr-fault-table/.test(t),
      `${label}: web table not tagged pr-fault-table (fixed layout)`
    );
  }
}
async function main() {
  // ---- 4 (cont.): web print path, detail AND compact ----------------------
  ENV = new Map();
  await checkWeb('detail', [
    { ecu: { label: 'DME', sgbd: 'ms450ds0' }, codes: detailFaults },
  ]);
  await checkWeb('compact', [
    { ecu: { label: 'DSC', sgbd: 'dsc_mk60' }, codes: compactFaults },
  ]);
  ok('web printFaultReport: 5 th == 5 col == 5 td for detail AND compact');

  // ---- 5. web env pairs stay paired + break-avoid -------------------------
  ENV = new Map([
    [
      bodyFaults[0],
      [
        ['Begin', '1000 km'],
        ['Endefehleruhr', '55 h'],
      ],
    ],
  ]);
  CAPTURED = null;
  await R.printFaultReport(
    'E46',
    [{ ecu: { label: 'MRS', sgbd: 'mrs4' }, codes: bodyFaults }],
    { scanned: 1, skipped: 0 }
  );
  const table = CAPTURED.sections
    .map((s) => (s && s.html) || '')
    .find((h) => /pr-envtr/.test(h));
  assert.ok(table, 'web env row (pr-envtr) missing');
  const rows = table.match(/<div class="pr-env-row">[\s\S]*?<\/div>/g) || [];
  assert.strictEqual(
    rows.length,
    2,
    `expected 2 env pairs, got ${rows.length}`
  );
  for (const r of rows) {
    assert.ok(
      /pr-env-k/.test(r) && /pr-env-v/.test(r),
      'web env pair broke apart'
    );
  }
  ok('web env pairs render as inseparable label+value units');

  console.log(`test_fault_report: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
