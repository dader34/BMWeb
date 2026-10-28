#!/usr/bin/env node
// The live cursor's arithmetic (app/renderer/core/ms45/livetune-cursor.js) and the
// map it works from (core/generated/ms45-cursor-map.js, generated in ms45-emu from the
// emulator, where each variable was checked against every lookup made).
//
// WHAT THIS PROVES
//   1. The map is well formed: every table and axis names a variable that
//      exists, in the MPC555's RAM, one or two bytes wide.
//   2. A traced table gets its own variables, axis by axis; an axis it was
//      not traced with gets none; a table never traced borrows from its axes
//      and says it is a guess; an unknown table gets nothing.
//   3. Variables close together are fetched in one read, distant ones are
//      not, and each value is cut out of the right block, signed or not.
//   4. The axis search matches the DME's lookup: held at both ends (and says
//      so), exact on a break point, a fraction between two.
//   5. The value under the cursor is the bilinear blend of its four cells.
//   6. The page's controller (screens/tuning/live-cursor.js), run against a
//      stand-in grid: it reads the two variables in the fewest requests, lights
//      the nearest cell (and tints the others it blends with by their share)
//      , says the values, lights the
//      whole row when only one axis is known, stays off the wire while an edit
//      is pending, and refuses a DME running another program.
//
// Run: node tools/verify/test_livetune_cursor.js
const assert = require('assert');
const {
  MS45_CURSOR_MAP: MAP,
} = require('../../app/renderer/core/generated/ms45-cursor-map.js');
const {
  LT_CURSOR_JOIN,
  ltCursorInputs,
  ltCursorReads,
  ltCursorValue,
  ltAxisPosition,
  ltCursorCell,
} = require('../../app/renderer/core/ms45/livetune-cursor.js');

// The ignition base map (ip_iga_bas__n__maf): load across, engine speed down.
const IGA = 0xad4c;
const IGA_MAF = 0x8812;
const IGA_N = 0x8992;
const N = 0x3fcc04; // engine speed, 16 bit
// Its sibling the run never reached, on the same two axes.
const IGA_ADD_MIN = 0xafcc;

let n = 0;
function test(name, fn) {
  fn();
  n++;
  console.log(`ok ${n} - ${name}`);
}

test('the map is well formed', () => {
  assert.strictEqual(MAP.program, '0044570LO02S');
  assert.ok(MAP.vars.length > 50 && Object.keys(MAP.tables).length > 400);
  for (const [address, size, signed] of MAP.vars) {
    assert.ok(
      address >= 0x3f9800 && address + size <= 0x400000,
      `0x${address.toString(16)} is RAM`
    );
    assert.ok(size === 1 || size === 2);
    assert.ok(signed === 0 || signed === 1);
  }
  for (const pairs of Object.values(MAP.tables))
    for (const [first, v] of pairs) {
      assert.ok(first > 0 && first < 0x1d000);
      assert.ok(MAP.vars[v]);
    }
  for (const v of Object.values(MAP.axes)) assert.ok(MAP.vars[v]);
});

test('a traced table gets its variables, a stranger none', () => {
  const [x, y] = ltCursorInputs(MAP, IGA, [IGA_MAF, IGA_N]);
  assert.strictEqual(y.address, N);
  assert.strictEqual(y.size, 2);
  assert.strictEqual(y.name, 'N');
  assert.strictEqual(y.guessed, false);
  assert.ok(x && x.address !== N && !x.guessed);
  // an axis this table was not seen with, though other tables use it
  const other = Object.keys(MAP.axes)
    .map(Number)
    .find((a) => a !== IGA_MAF && a !== IGA_N);
  assert.deepStrictEqual(ltCursorInputs(MAP, IGA, [other, null]), [null, null]);
  assert.deepStrictEqual(ltCursorInputs(MAP, 0x1cffe, [0x1cff0, 0x1cff8]), [
    null,
    null,
  ]);
});

test('an untraced table borrows from its axes, and says so', () => {
  assert.strictEqual(
    MAP.tables[IGA_ADD_MIN],
    undefined,
    'the run did not reach it'
  );
  const [x, y] = ltCursorInputs(MAP, IGA_ADD_MIN, [IGA_MAF, IGA_N]);
  assert.strictEqual(y.address, N);
  assert.ok(x.guessed && y.guessed);
});

test('near variables share a read, far ones do not', () => {
  const v = (address, size) => ({ address, size, signed: false });
  assert.deepStrictEqual(
    ltCursorReads([v(0x3fcc04, 2), null, v(0x3fcc00, 1)]),
    [{ address: 0x3fcc00, length: 6 }]
  );
  assert.deepStrictEqual(
    ltCursorReads([v(0x3fcc04, 2), v(0x3fcc06 + LT_CURSOR_JOIN + 1, 1)]).length,
    2
  );
  // the same variable for both axes, and one inside another
  assert.deepStrictEqual(ltCursorReads([v(0x3fcab8, 2), v(0x3fcab8, 1)]), [
    { address: 0x3fcab8, length: 2 },
  ]);
  assert.deepStrictEqual(ltCursorReads([null, null]), []);
});

test('a value is cut out of the block that holds it', () => {
  const blocks = [
    { address: 0x3fcc00, bytes: Uint8Array.from([0x11, 0, 0, 0, 0x0b, 0xb8]) },
    { address: 0x3fd7b8, bytes: Uint8Array.from([0xff, 0xfe]) },
  ];
  assert.strictEqual(
    ltCursorValue({ address: N, size: 2, signed: false }, blocks),
    3000
  );
  assert.strictEqual(
    ltCursorValue({ address: 0x3fcc00, size: 1, signed: false }, blocks),
    0x11
  );
  assert.strictEqual(
    ltCursorValue({ address: 0x3fd7b8, size: 2, signed: true }, blocks),
    -2
  );
  assert.strictEqual(
    ltCursorValue({ address: 0x3fd7b8, size: 2, signed: false }, blocks),
    0xfffe
  );
  assert.strictEqual(
    ltCursorValue({ address: 0x3fcc05, size: 2, signed: false }, blocks),
    null
  );
});

test('the axis search is the lookup library’s', () => {
  const axis = [500, 1000, 2000, 4000];
  assert.deepStrictEqual(ltAxisPosition(1000, axis), { index: 1, edge: 0 });
  assert.deepStrictEqual(ltAxisPosition(1500, axis), { index: 1.5, edge: 0 });
  assert.deepStrictEqual(ltAxisPosition(3500, axis), { index: 2.75, edge: 0 });
  assert.deepStrictEqual(ltAxisPosition(500, axis), { index: 0, edge: 0 });
  assert.deepStrictEqual(ltAxisPosition(0, axis), { index: 0, edge: -1 });
  assert.deepStrictEqual(ltAxisPosition(4000, axis), { index: 3, edge: 0 });
  assert.deepStrictEqual(ltAxisPosition(2 ** 32 - 2, axis), {
    index: 3,
    edge: 1,
  });
  assert.deepStrictEqual(ltAxisPosition(7, [9]), { index: 0, edge: 0 });
  // a repeated break point is a step, not a division by zero
  assert.deepStrictEqual(ltAxisPosition(1000, [500, 1000, 1000, 4000]), {
    index: 2,
    edge: 0,
  });
  assert.strictEqual(ltAxisPosition(5, []), null);
  assert.strictEqual(ltAxisPosition(5, [1, NaN, 9]), null); // break points not read yet
});

test('the value under the cursor blends its four cells', () => {
  const cells = [
    [10, 20, 30],
    [20, 40, 60],
  ];
  assert.strictEqual(ltCursorCell(cells, 0, 0), 10);
  assert.strictEqual(ltCursorCell(cells, 0, 1.5), 25);
  assert.strictEqual(ltCursorCell(cells, 0.5, 0.5), 22.5);
  assert.strictEqual(ltCursorCell(cells, 1, 2), 60); // the last cell has no neighbours
  assert.strictEqual(ltCursorCell([[1, null]], 0, 0.5), null);
});

// ---- the controller, against a stand-in page -------------------------------
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function fakeEl() {
  const classes = new Set();
  return {
    hidden: false,
    style: {
      vars: {},
      setProperty(k, v) {
        this.vars[k] = v;
      },
      removeProperty(k) {
        delete this.vars[k];
      },
    },
    dataset: {},
    textContent: '',
    title: '',
    children: [],
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    set className(v) {
      classes.clear();
      v.split(' ')
        .filter(Boolean)
        .forEach((x) => classes.add(x));
    },
    appendChild(e) {
      this.children.push(e);
    },
    before(e) {
      this.prev = e;
    },
  };
}

/** A 3-row, 4-column table: cells 72 x 24 px, the first at (64, 24). */
function page({ program = MAP.program, vars, packets = true }) {
  const ROWS = 3;
  const COLS = 4;
  const X_AT = 0x48812; // image offsets: the ignition map's own axes and cells
  const Y_AT = 0x48992;
  const xPts = [100, 200, 400, 800];
  const yPts = [1000, 2000, 4000];
  const inputs = [];
  const heads = {};
  const gridWrap = fakeEl();
  gridWrap.scrollLeft = 0;
  gridWrap.scrollTop = 0;
  gridWrap.getBoundingClientRect = () => ({
    left: 10,
    top: 10,
    width: 400,
    height: 200,
  });
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const inp = fakeEl();
      inp.dataset = { r: String(r), c: String(c) };
      const td = fakeEl();
      td.firstChild = inp;
      td.getBoundingClientRect = () => ({
        left: 10 + 64 + c * 72,
        top: 10 + 24 + r * 24,
        width: 72,
        height: 24,
      });
      inp.parentElement = td;
      inputs.push(inp);
    }
  const table = {
    querySelector: (sel) => {
      const k = /data-axis="(.)"\]\[data-i="(\d+)"/.exec(sel);
      return (heads[k[1] + k[2]] = heads[k[1] + k[2]] || fakeEl());
    },
  };
  gridWrap.querySelectorAll = () => inputs;
  gridWrap.querySelector = () => table;
  const sent = [];
  const valueOf = (address, length) => {
    if (address === 0x3f9e74) return Uint8Array.from([0x4c, 0x54, 0x55, 0x4e]); // the state block's magic
    const out = new Uint8Array(length);
    for (const [at, size, value] of vars)
      for (let i = 0; i < size; i++)
        if (at + i >= address && at + i < address + length)
          out[at + i - address] = (value >> (8 * (size - 1 - i))) & 0xff;
    return out;
  };
  const lt = {
    defined: null, // the packet's pieces, as the DME holds them
    definitions: 0,
    definePacket: async (pieces) => {
      lt.definitions++;
      if (!packets) return false;
      lt.defined = pieces.map((q) => ({ ...q }));
      return true;
    },
    cleared: 0,
    clearPacket: async () => {
      lt.cleared++;
      lt.defined = null;
    },
    readPacket: async () => {
      sent.push(['packet']);
      if (!lt.defined) return null;
      const parts = lt.defined.map((q) => valueOf(q.address, q.size));
      return Uint8Array.from(parts.flatMap((q) => [...q]));
    },
    readFlash: async () => Uint8Array.from(Buffer.from(program)),
    readMemory: async (address, length) => {
      sent.push([address, length]);
      const out = new Uint8Array(length);
      for (const [at, size, value] of vars)
        for (let i = 0; i < size; i++)
          if (at + i >= address && at + i < address + length)
            out[at + i - address] = (value >> (8 * (size - 1 - i))) & 0xff;
      return out;
    },
  };
  const timers = [];
  const ctx = {
    console,
    Date,
    Math,
    Set,
    Object,
    String,
    Uint8Array,
    Number,
    MS45_CURSOR_MAP: MAP,
    TN_CAL_START: 0x40000,
    TN_CAL_END: 0x5d000,
    tuningState: { bin: new Uint8Array(0) },
    tnLive: {
      armed: true,
      lt,
      busy: false,
      pumping: false,
      pending: new Map(),
    },
    Promise,
    Proxy,
    tnItemByteRange: () => ({ start: 0x40000 + IGA, end: 0x40000 + IGA + 24 }),
    fmtNum: (v, dp) => v.toFixed(dp),
    esc: (x) => String(x),
    document: { createElement: fakeEl },
    setTimeout: (fn, ms) => timers.push(ms) && timers.length,
    clearTimeout: () => {},
    window: {
      XDF: {
        resolveEmbedded: (embed) => ({ address: embed.address, sizeBits: 16 }),
        readScalar: (bin, spec) =>
          spec.address >= Y_AT
            ? yPts[(spec.address - Y_AT) / 2]
            : xPts[(spec.address - X_AT) / 2],
        compileMath: (eq) => (eq === 'rpm' ? (v) => v : (v) => v / 10),
      },
    },
  };
  vm.createContext(ctx);
  for (const f of [
    'core/ms45/livetune-cursor.js',
    'core/generated/ms45-value-map.js',
    'screens/tuning/live-gauges.js',
    'screens/tuning/live-cursor.js',
  ])
    vm.runInContext(
      fs.readFileSync(path.join(__dirname, '../../app/renderer', f), 'utf8'),
      ctx,
      { filename: f }
    );
  const m = {
    item: {},
    h: { baseOffset: 0, defaults: { sigdigits: 2 } },
    dp: 1,
    t: {
      rows: ROWS,
      cols: COLS,
      z: { units: 'lambda' },
      cells: [
        [0, 10, 20, 30],
        [10, 20, 30, 40],
        [20, 30, 40, 50],
      ],
      x: {
        embed: { address: X_AT },
        mathEquation: 'load',
        units: 'mg',
        decimalpl: 1,
      },
      y: {
        embed: { address: Y_AT },
        mathEquation: 'rpm',
        units: 'rpm',
        decimalpl: 0,
      },
    },
    gridWrap,
  };
  vm.runInContext('this.TN_GAUGES = TN_GAUGES;', ctx);
  return { ctx, m, sent, timers, heads, inputs, lt };
}

const LOAD = MAP.vars[MAP.tables[IGA].find((p) => p[0] === IGA_MAF)[1]][0];

async function later() {
  // case 6
  const lit = (p) =>
    p.inputs
      .filter((i) => i.classList.contains('tn-cell-live'))
      .map((i) => `${i.dataset.r},${i.dataset.c}`);
  let p = page({
    vars: [
      [N, 2, 3100],
      [LOAD, 2, 290],
    ],
  });
  p.ctx.tnLiveCursorAttach(p.m);
  await p.ctx.tnLiveCursorTick();
  // both variables in ONE exchange: the DME's packet, defined once
  assert.deepStrictEqual(p.sent, [['packet']]);
  assert.strictEqual(p.lt.definitions, 1);
  await p.ctx.tnLiveCursorTick();
  assert.deepStrictEqual(p.sent, [['packet'], ['packet']]);
  assert.strictEqual(p.lt.definitions, 1);
  // the DME restarted and forgot it: that refresh reads by address, the next defines again
  p.lt.defined = null;
  p.sent.length = 0;
  await p.ctx.tnLiveCursorTick();
  assert.strictEqual(
    p.sent.length,
    1 + ltCursorReads(ltCursorInputs(MAP, IGA, [IGA_MAF, IGA_N])).length
  );
  assert.deepStrictEqual(lit(p), ['2,1']);
  await p.ctx.tnLiveCursorTick();
  assert.strictEqual(p.lt.definitions, 2);
  // another job defined a packet of its own, the same size as ours (BMW's
  // VANOS block is two 2-byte pieces): the canary is not there, so it is not
  // taken for load and speed -- that refresh reads by address, the next redefines
  p.lt.defined = [
    { address: 0x3fd000, size: 4 },
    { address: N, size: 2 },
    { address: LOAD, size: 2 },
  ];
  p.sent.length = 0;
  await p.ctx.tnLiveCursorTick();
  assert.ok(p.sent.length > 1 && p.sent[0][0] === 'packet');
  assert.deepStrictEqual(lit(p), ['2,1']);
  await p.ctx.tnLiveCursorTick();
  assert.strictEqual(p.lt.definitions, 3);
  assert.strictEqual(p.lt.defined[0].address, 0x3f9e74);
  // closing the dialog hands the packet back
  p.ctx.tnLiveCursorDetach(p.m);
  assert.strictEqual(p.lt.cleared, 1);
  // a DME that will not take a packet: reads by address from then on, asked once
  {
    const q = page({
      vars: [
        [N, 2, 3100],
        [LOAD, 2, 290],
      ],
      packets: false,
    });
    q.ctx.tnLiveCursorAttach(q.m);
    await q.ctx.tnLiveCursorTick();
    await q.ctx.tnLiveCursorTick();
    assert.strictEqual(q.lt.definitions, 1);
    assert.ok(q.sent.length >= 2 && q.sent.every((x) => x[0] !== 'packet'));
    assert.deepStrictEqual(lit(q), ['2,1']);
  }
  // load 290 is nearest column 1 (200 | 400), 3100 rpm nearest row 2 (2000 | 4000): one cell
  assert.deepStrictEqual(lit(p), ['2,1']);
  // all four it is blended from are shaded by their share, the nearest most:
  // column 1.45, row 1.55 -> (1,1) 0.2475, (1,2) 0.2025, (2,1) 0.3025, (2,2) 0.2475
  const near = (q) =>
    q.inputs
      .filter((i) => i.classList.contains('tn-cell-near'))
      .map((i) => `${i.dataset.r},${i.dataset.c}=${i.style.vars['--live-w']}`);
  assert.deepStrictEqual(near(p), [
    '1,1=0.32',
    '1,2=0.29',
    '2,1=0.36',
    '2,2=0.32',
  ]);
  const said = (q) =>
    q.m.cursor.info.innerHTML
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  assert.strictEqual(said(p), 'LIVE mg 29.0 rpm 3100 lambda 30.0');
  assert.strictEqual(p.m.cursor.info.hidden, false);
  assert.strictEqual(Object.keys(p.heads).length, 0); // the axis headers are left alone
  assert.strictEqual(p.timers[p.timers.length - 1], 200);

  // past the top of the speed axis: held on the last row, and said
  p = page({
    vars: [
      [N, 2, 6500],
      [LOAD, 2, 100],
    ],
  });
  p.ctx.tnLiveCursorAttach(p.m);
  await p.ctx.tnLiveCursorTick();
  assert.deepStrictEqual(lit(p), ['2,0']);
  assert.deepStrictEqual(near(p), ['2,0=0.85']); // on a break point on both axes: the one cell, all of it
  assert.ok(
    p.inputs
      .find((i) => i.dataset.r === '2' && i.dataset.c === '0')
      .classList.contains('tn-cell-deep')
  );
  assert.strictEqual(said(p), 'LIVE mg 10.0 rpm 6500 lambda 20.0'); // the figures, no remark

  // only the row axis is known: the whole row
  p = page({ vars: [[N, 2, 1000]] });
  p.m.t.x = { mathEquation: 'load' }; // labels only, no address
  p.ctx.tnLiveCursorAttach(p.m);
  await p.ctx.tnLiveCursorTick();
  assert.deepStrictEqual(lit(p), ['0,0', '0,1', '0,2', '0,3']);

  // an edit is waiting: nothing is read
  p = page({ vars: [] });
  p.ctx.tnLive.pending.set(1, {});
  p.ctx.tnLiveCursorAttach(p.m);
  await p.ctx.tnLiveCursorTick();
  assert.strictEqual(p.sent.length, 0);
  assert.strictEqual(p.timers[p.timers.length - 1], 150);

  // just after an edit: it still refreshes, then rests four times as long
  p = page({
    vars: [
      [N, 2, 3000],
      [LOAD, 2, 300],
    ],
  });
  p.ctx.tnLive.editedAt = Date.now();
  p.ctx.tnLiveCursorAttach(p.m);
  await p.ctx.tnLiveCursorTick();
  assert.ok(p.sent.length > 0);
  assert.strictEqual(p.timers[p.timers.length - 1], 800);

  // the tab is hidden: nothing is read
  p = page({
    vars: [
      [N, 2, 3000],
      [LOAD, 2, 300],
    ],
  });
  p.ctx.document.hidden = true;
  p.ctx.tnLiveCursorAttach(p.m);
  await p.ctx.tnLiveCursorTick();
  assert.strictEqual(p.sent.length, 0);
  assert.strictEqual(p.timers[p.timers.length - 1], 1500);

  // the 3D window is redrawn when the point moves, not on every refresh
  p = page({
    vars: [
      [N, 2, 3000],
      [LOAD, 2, 300],
    ],
  });
  let redraws = 0;
  p.ctx.tnSurfaceRequest = () => redraws++;
  p.ctx.tnLiveCursorAttach(p.m);
  await p.ctx.tnLiveCursorTick();
  await p.ctx.tnLiveCursorTick();
  assert.strictEqual(redraws, 1);

  // another program: the addresses mean nothing there
  p = page({ program: '0044570LO99S', vars: [] });
  p.ctx.tnLiveCursorAttach(p.m);
  await p.ctx.tnLiveCursorTick();
  assert.strictEqual(p.sent.length, 0);
  assert.deepStrictEqual(lit(p), []);
  assert.ok(/not mapped/.test(said(p)));

  // disarmed: the cell goes dark
  p = page({
    vars: [
      [N, 2, 3000],
      [LOAD, 2, 300],
    ],
  });
  p.ctx.tnLiveCursorAttach(p.m);
  await p.ctx.tnLiveCursorTick();
  assert.strictEqual(lit(p).length, 1);
  p.ctx.tnLive.armed = false;
  await p.ctx.tnLiveCursorTick();
  assert.deepStrictEqual(lit(p), []);
  assert.strictEqual(p.m.cursor.info.hidden, true);
  assert.deepStrictEqual(near(p), []);
  assert.ok(p.inputs.every((i) => !('--live-w' in i.style.vars)));
  n++;
  console.log(
    `ok ${n} - the controller lights one cell, yields to edits, refuses a strange program`
  );

  // the gauge windows: with a table open they ride in its packet; with none
  // open they read the same packet themselves; closed, they cost nothing
  {
    const g2d = new Proxy(
      {},
      {
        get: (o, k) =>
          k in o
            ? o[k]
            : k === 'createRadialGradient'
              ? () => ({ addColorStop() {} })
              : () => {},
        set: (o, k, v) => ((o[k] = v), true),
      }
    );
    const withGauges = (q, open) => {
      q.drawn = [];
      q.ctx.window.devicePixelRatio = 1;
      q.ctx.gaugeParts = {
        dial: {
          win: fakeEl(),
          canvas: {
            style: {},
            parentElement: { clientWidth: 240, clientHeight: 150 },
            getContext: () => (q.drawn.push(1), g2d),
          },
        },
        list: { win: fakeEl(), cells: null },
        open,
      };
      vm.runInContext(
        'gaugeParts.list.cells = TN_GAUGES.map(() => ({ textContent: "" }));' +
          'tnGauges.dial = gaugeParts.dial; tnGauges.list = gaugeParts.list; tnGauges.open = gaugeParts.open;' +
          'this.gauges = tnGauges; this.tick = tnGaugesTick; this.setGauge = tnGaugesSet;',
        q.ctx
      );
      return q;
    };
    const shown = (q) =>
      Object.fromEntries(
        q.ctx.TN_GAUGES.map((g, i) => [
          g.label,
          q.ctx.gauges.list.cells[i].textContent,
        ])
      );
    const VARS = [
      [N, 2, 3100],
      [LOAD, 2, 17312],
      // where the DME's own value table keeps each (core/generated/ms45-value-map.js)
      [0x3fd7b9, 1, 184],
      [0x3fd7cb, 1, 130],
      [0x3fd791, 1, 64],
      [0x3fbe4e, 2, 0xff00],
    ];

    // a table open: one exchange for the table and every gauge
    let q = withGauges(page({ vars: VARS }), { dial: true, list: true });
    q.ctx.tnLiveCursorAttach(q.m);
    await q.ctx.tnLiveCursorTick();
    assert.deepStrictEqual(q.sent, [['packet']]);
    assert.strictEqual(shown(q)['Engine speed'], '3100');
    assert.strictEqual(shown(q)['Air per stroke'], '366.9'); // 17312 x 0.021194 mg/stk
    assert.strictEqual(shown(q).Coolant, '90'); // 184 x 0.75 - 48
    assert.strictEqual(shown(q).Oil, '90'); // 130 - 40
    assert.strictEqual(shown(q)['Accelerator pedal'], '25.0'); // 64 x 0.390625 %
    assert.strictEqual(shown(q)['Lambda control, bank 1'], '-0.4'); // a signed word: -256 x 0.001526 %
    assert.strictEqual(q.drawn.length, 1, 'the dial drawn');
    await q.ctx.tnLiveCursorTick();
    assert.strictEqual(
      q.drawn.length,
      1,
      'and not again while the speed has not moved'
    );
    // the gauges' own loop stands back while the table's cursor is feeding them
    q.sent.length = 0;
    await q.ctx.tick();
    assert.deepStrictEqual(q.sent, []);
    // closing the list window while the table is open: the packet shrinks to what is still wanted
    const before = q.lt.defined.length;
    q.ctx.document.getElementById = () => null;
    q.ctx.document.querySelectorAll = () => [];
    q.ctx.setGauge('list', false);
    await q.ctx.tnLiveCursorTick();
    assert.ok(q.lt.defined.length < before);

    // no table open: the gauges read for themselves, one exchange a refresh
    q = withGauges(page({ vars: VARS }), { dial: false, list: true });
    await q.ctx.tick();
    assert.deepStrictEqual(q.sent, [['packet']]);
    assert.strictEqual(
      q.lt.defined[0].address,
      0x3f9e74,
      'their packet leads with the canary too'
    );
    assert.strictEqual(shown(q)['Engine speed'], '3100');
    assert.strictEqual(q.timers[q.timers.length - 1], 250);
    // an edit waiting goes first
    q.sent.length = 0;
    q.ctx.tnLive.pending.set(1, {});
    await q.ctx.tick();
    assert.deepStrictEqual(q.sent, []);
    // both windows closed, or live mode off: nothing is read and the loop ends
    q = withGauges(page({ vars: VARS }), { dial: false, list: false });
    const timersBefore = q.timers.length;
    await q.ctx.tick();
    assert.deepStrictEqual(q.sent, []);
    assert.strictEqual(q.timers.length, timersBefore);
    // and a table with nothing to follow, and no gauge open, reads nothing at all
    q.ctx.tnItemByteRange = () => ({
      start: 0x40000 + 0x1cffe,
      end: 0x40000 + 0x1cfff,
    });
    q.m.t.x = { mathEquation: 'load' }; // axes that are labels only: nothing to borrow a variable from
    q.m.t.y = { mathEquation: 'rpm' };
    q.ctx.tnLiveCursorAttach(q.m);
    await q.ctx.tnLiveCursorTick();
    assert.deepStrictEqual(q.sent, []);
    n++;
    console.log(
      `ok ${n} - the gauge windows share the table's packet, or read their own when no table is open`
    );
  }

  // the client's side of the packet: the DME's own telegrams, byte for byte
  {
    const { LiveTune } = require('../../app/renderer/core/ms45/livetune.js');
    const wire = [];
    const dme = new LiveTune(async (req) => {
      wire.push(req);
      if (req[0] === 0x2c) return [0x6c, 0xf0];
      return wire.length < 4
        ? [0x61, 0xf0, 0x05, 0xdc, 0x43, 0xa0]
        : [0x7f, 0x21, 0x22];
    });
    assert.strictEqual(
      await dme.definePacket([
        { address: 0x3fcc04, size: 2 },
        { address: 0x3fcab8, size: 2 },
      ]),
      true
    );
    assert.deepStrictEqual(
      wire[0],
      [0x2c, 0xf0, 0x03, 1, 2, 0x3f, 0xcc, 0x04, 0x03, 3, 2, 0x3f, 0xca, 0xb8]
    );
    assert.deepStrictEqual(
      [...(await dme.readPacket())],
      [0x05, 0xdc, 0x43, 0xa0]
    );
    assert.deepStrictEqual(wire[1], [0x21, 0xf0]);
    await dme.readPacket();
    assert.strictEqual(await dme.readPacket(), null); // 7F 21 22: nothing defined
    n++;
    console.log(`ok ${n} - the packet is the DME's own 2C F0 / 21 F0`);
  }
  console.log(`\n${n} passed`);
}

later().catch((e) => {
  console.error(e);
  process.exit(1);
});
