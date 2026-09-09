#!/usr/bin/env node
// The Control unit tree: the extractor's output shape (when the ISTA DLL is
// on this machine), and the pure half of the app on a hand-built tree: the
// layout (every box on its bus line, lines painted to the root), the status
// join against a whole-car report, and which config row a box opens.
//
//   node tools/verify/test_ecu_tree.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadClassic } = require('./lib/load_classic.js');

const ROOT = path.join(__dirname, '..', '..');
let passed = 0;
const ok = (what) => {
  passed++;
  if (process.env.V) console.log('  ok', what);
};

global.window = global.window || {};
const T = loadClassic('screens/tree/');

// ---- a hand-built tree in ISTA's shape --------------------------------------
const tree = {
  series: 'T46',
  mainSgbd: 'zcs_all',
  ecus: [
    {
      name: 'KOMBI',
      addr: 128,
      groups: ['d_0080', 'd_kombi'],
      bus: 'ROOT',
      col: 5,
      row: 0,
    },
    { name: 'IHKA', addr: 91, groups: ['d_005b'], bus: 'KBUS', col: 0, row: 1 },
    {
      name: 'ZKE',
      addr: 0,
      groups: ['d_0000', 'd_zke_gm'],
      bus: 'KBUS',
      col: 1,
      row: 1,
    },
    { name: 'EWS', addr: 68, groups: ['d_0044'], bus: 'KBUS', col: 2, row: 1 },
    {
      name: 'DME',
      addr: 18,
      groups: ['d_motor', 'd_0012'],
      bus: 'FACAN',
      col: 7,
      row: 1,
    },
    { name: 'DSC', addr: 86, groups: ['d_0056'], bus: 'FACAN', col: 7, row: 5 },
    { name: 'LM', addr: 208, groups: ['d_00d0'], bus: 'FACAN', col: 7, row: 8 },
    {
      name: 'GHOST',
      addr: 99,
      groups: ['d_0099'],
      bus: 'VIRTUAL',
      col: 3,
      row: 3,
    },
  ],
  buses: [
    {
      bus: 'KBUS',
      col: 1,
      paintToRoot: true,
      connectOnlyRight: false,
      vertical: true,
      horizontal: true,
    },
    {
      bus: 'KBUS',
      col: 2,
      paintToRoot: true,
      connectOnlyRight: true,
      vertical: true,
      horizontal: true,
    },
    {
      bus: 'FACAN',
      col: 7,
      paintToRoot: true,
      connectOnlyRight: false,
      vertical: true,
      horizontal: true,
    },
  ],
};

console.log('1. layout');
{
  const drawn = T.ecuTreeDrawn(tree);
  assert.strictEqual(drawn.length, 7, 'the VIRTUAL module is not drawn');
  ok('hidden buses are dropped');
  const L = T.ecuTreeLayout(tree);
  assert.strictEqual(L.boxes.length, 7);
  assert.ok(L.root && L.root.ecu.name === 'KOMBI', 'the ROOT box is the root');
  /** the connector that touches a box (several boxes share a row) */
  const stub = (name) => {
    const b = L.boxes.find((x) => x.ecu.name === name);
    return L.stubs.find(
      (s) => s.y === b.y + b.h / 2 && (s.x1 === b.x + b.w || s.x2 === b.x)
    );
  };
  // IHKA (col 0) hangs on the K-Bus line at col 1, to its right
  const ihka = L.boxes.find((b) => b.ecu.name === 'IHKA');
  const sI = stub('IHKA');
  assert.ok(
    sI && sI.bus === 'KBUS' && sI.x1 === ihka.x + ihka.w,
    'IHKA connects rightwards to the col-1 K-Bus line'
  );
  // EWS (col 2): the col-2 line takes only its right column, so EWS hangs on its LEFT
  const ews = L.boxes.find((b) => b.ecu.name === 'EWS');
  const sE = stub('EWS');
  assert.ok(
    sE && sE.x2 === ews.x && sE.x1 < ews.x,
    'EWS connects leftwards to the col-2 K-Bus line'
  );
  // ZKE (col 1): its own column's line is to its left
  const zke = L.boxes.find((b) => b.ecu.name === 'ZKE');
  const sZ = stub('ZKE');
  assert.ok(sZ && sZ.x2 === zke.x, 'ZKE connects leftwards to the col-1 line');
  ok('modules hang on the right bus line, on the right side');
  const fac = L.lines.find((l) => l.bus === 'FACAN');
  const rootY = L.root.y + L.root.h / 2;
  assert.ok(fac.y1 <= rootY, 'the PT-CAN line reaches the root row');
  const lm = L.boxes.find((b) => b.ecu.name === 'LM');
  assert.strictEqual(
    fac.y2,
    lm.y + lm.h / 2,
    'and runs down to its last module'
  );
  assert.ok(
    L.stubs.some((s) => s.bus === 'FACAN' && s.y === rootY),
    'with a turn to the gateway at the root row'
  );
  ok('bus lines paint to the root');
  assert.ok(
    L.width > 0 && L.height > 0 && L.buses.length === 2,
    'size and legend buses'
  );
  assert.strictEqual(T.ecuTreeBusStyle('FACAN').label, 'PT-CAN');
  assert.strictEqual(T.ecuTreeBusStyle('KBUS').label, 'K-Bus');
  assert.strictEqual(
    T.ecuTreeBusStyle('ODDBUS').label,
    'ODDBUS',
    'an unknown bus keeps its name'
  );
  ok('legend names');
}

console.log('2. status from a whole-car report');
{
  const report = {
    kind: 'faults',
    modules: [
      {
        sgbd: 'ms450ds0',
        via: 'd_motor',
        label: 'Motor',
        codes: [{ F_ORT_NR: 1 }, { F_ORT_NR: 2 }],
      },
      { sgbd: 'kombi46', via: 'd_0080', label: 'Kombi', codes: [] },
      { sgbd: 'zke5', via: 'd_zke_gm', label: 'ZKE', codes: [] },
    ],
    silent: [{ target: 'd_0056', label: 'DSC', error: 'ERROR_NO_ANSWER' }],
  };
  const st = T.ecuTreeStatus(tree, report);
  const of = (n) => st.get(`${n}@${tree.ecus.find((e) => e.name === n).addr}`);
  assert.deepStrictEqual(
    [of('DME').state, of('DME').faults],
    ['faults', 2],
    'the DME answered with two faults'
  );
  assert.strictEqual(of('KOMBI').state, 'ok', 'the cluster answered clean');
  assert.strictEqual(
    of('ZKE').state,
    'ok',
    'matched through its second group name'
  );
  assert.strictEqual(
    of('DSC').state,
    'silent',
    'a silent target is not responding'
  );
  assert.strictEqual(
    of('LM').state,
    'unread',
    'a module the scan never reached'
  );
  assert.strictEqual(st.has('GHOST@99'), false, 'hidden modules get no status');
  ok('join by group: answered, faults, silent, unread');
  const none = T.ecuTreeStatus(tree, null);
  assert.ok(
    [...none.values()].every((s) => s.state === 'unread'),
    'no scan: everything unread'
  );
  ok('no scan');
}

console.log('3. the config row a box opens');
{
  const config = {
    sections: [
      {
        name: 'Engine',
        ecus: [
          { code: 'MS430', sgbd: 'ms430ds0', group: 'D_0012' },
          { code: 'MS450', sgbd: 'ms450ds0', group: 'D_0012' },
        ],
      },
      { name: 'Body', ecus: [{ code: 'LSZ', sgbd: 'lsz', group: 'D_00D0' }] },
    ],
  };
  const dme = tree.ecus.find((e) => e.name === 'DME');
  const first = T.ecuTreeModuleRow(dme, config, null);
  assert.strictEqual(
    first.row.sgbd,
    'ms430ds0',
    'without a scan: the first row of the group'
  );
  const mine = T.ecuTreeModuleRow(dme, config, {
    sgbd: 'ms450ds0',
    via: 'd_motor',
  });
  assert.strictEqual(
    mine.row.sgbd,
    'ms450ds0',
    'with a scan: the variant that answered'
  );
  const lm = T.ecuTreeModuleRow(
    tree.ecus.find((e) => e.name === 'LM'),
    config,
    null
  );
  assert.deepStrictEqual(
    [lm.section, lm.row.sgbd],
    ['Body', 'lsz'],
    'group match is case-insensitive'
  );
  assert.strictEqual(
    T.ecuTreeModuleRow(
      tree.ecus.find((e) => e.name === 'EWS'),
      config,
      null
    ),
    null,
    'no row: null'
  );
  ok('module rows');
}

console.log('4. the picture');
{
  const L = T.ecuTreeLayout(tree);
  const st = T.ecuTreeStatus(tree, {
    modules: [{ via: 'd_motor', sgbd: 'x', codes: [{}] }],
    silent: [],
  });
  const svg = T.ecuTreeSvg(L, st);
  assert.ok(/^<svg /.test(svg) && /<\/svg>$/.test(svg));
  assert.strictEqual(
    (svg.match(/class="tree-box /g) || []).length,
    7,
    'one box per drawn module'
  );
  assert.ok(
    /tree-box tree-faults/.test(svg) && /tree-badge-n[^>]*>1</.test(svg),
    'the fault count rides on the box'
  );
  assert.ok(/tree-root/.test(svg), 'the gateway is marked');
  assert.ok(/<line class="tree-bus"/.test(svg), 'bus lines drawn');
  const leg = T.ecuTreeLegendHtml(L);
  assert.ok(
    /PT-CAN/.test(leg) && /K-Bus/.test(leg) && /not responding/.test(leg)
  );
  ok('svg + legend');
}

console.log('5. the extractor');
{
  const dll = path.join(
    process.env.BMWFILES ||
      path.join(os.homedir(), 'Development', 'code', 'BMWFILES'),
    'ista',
    'RheingoldDiagnostics.dll'
  );
  if (!fs.existsSync(dll)) {
    console.log('  SKIP (no RheingoldDiagnostics.dll on this machine)');
  } else {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ecutree-'));
    execFileSync(
      'python3',
      [
        path.join(ROOT, 'tools/ista/ecu_tree_extract.py'),
        '--dll',
        dll,
        '--out',
        out,
      ],
      { stdio: 'pipe' }
    );
    const idx = JSON.parse(
      fs.readFileSync(path.join(out, 'index.json'), 'utf8')
    );
    assert.ok(Object.keys(idx.trees).length >= 40, 'dozens of trees');
    assert.strictEqual(idx.chassis.E46, 'E46');
    assert.strictEqual(idx.chassis.F10, 'F01');
    const e46 = JSON.parse(fs.readFileSync(path.join(out, 'E46.json'), 'utf8'));
    const names = e46.ecus.map((e) => e.name);
    for (const n of ['KOMBI', 'DME', 'EWS', 'IHKA', 'LWS', 'LM', 'DSC', 'ZAE'])
      assert.ok(names.includes(n), `E46 tree has ${n}`);
    const root = e46.ecus.find((e) => e.bus === 'ROOT');
    assert.ok(
      root && root.name === 'KOMBI' && root.addr === 128,
      'the E46 gateway is the cluster at 0x80'
    );
    const dme = e46.ecus.find((e) => e.name === 'DME' && e.addr === 18);
    assert.deepStrictEqual(
      dme.groups,
      ['d_motor', 'd_0012'],
      'group SGBDs lower-cased and split'
    );
    assert.ok(
      e46.buses.some((b) => b.bus === 'FACAN' && b.paintToRoot),
      'bus lines with paint flags'
    );
    const L = T.ecuTreeLayout(e46);
    assert.ok(
      L.boxes.length >= 50 && L.lines.length === 4,
      'the real E46 lays out with its four bus lines'
    );
    fs.rmSync(out, { recursive: true, force: true });
    ok('extractor output');
  }
}

console.log(`\necu-tree: ${passed} checks passed`);
