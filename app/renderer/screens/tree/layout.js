// Control unit tree: the pure half. Which boxes are drawn, where, which bus
// line each hangs on, and what colour a box gets from a stored scan. No DOM
// here, so the harness can pin the geometry and the status join.

/** Grid geometry: ISTA's cells, in CSS pixels. */
const ECU_TREE_GEOM = {
  colW: 112,
  rowH: 38,
  boxW: 84,
  boxH: 26,
  padX: 24,
  padY: 22,
};

/**
 * How each bus is named and coloured. ISTA's legend names K-CAN, MOST,
 * F-CAN and PT-CAN; its trees spell the powertrain bus FACAN and the E46's
 * body bus KBUS. Anything unlisted draws grey with its own name.
 * @type {Object<string, {label: string, color: string}>}
 */
const ECU_TREE_BUS_STYLE = {
  ROOT: { label: 'Gateway', color: '#8d9aa6' },
  KBUS: { label: 'K-Bus', color: '#3d7bd9' },
  IBUS: { label: 'I-Bus', color: '#2aa198' },
  SIBUS: { label: 'SI-Bus', color: '#c0392b' },
  KCAN: { label: 'K-CAN', color: '#3d7bd9' },
  KCAN2: { label: 'K-CAN2', color: '#5b8fe0' },
  KCAN3: { label: 'K-CAN3', color: '#7aa6e8' },
  IKCAN: { label: 'K-CAN', color: '#3d7bd9' },
  FACAN: { label: 'PT-CAN', color: '#e0b422' },
  FASCAN: { label: 'FAS-CAN', color: '#c99a12' },
  ACAN: { label: 'A-CAN', color: '#9b59b6' },
  BCAN: { label: 'B-CAN', color: '#1abc9c' },
  BCAN2: { label: 'B-CAN2', color: '#16a085' },
  SCAN: { label: 'S-CAN', color: '#d35400' },
  HCAN: { label: 'H-CAN', color: '#27ae60' },
  LOCAN: { label: 'Lo-CAN', color: '#95a5a6' },
  LECAN: { label: 'LE-CAN', color: '#7f8c8d' },
  LE2CAN: { label: 'LE2-CAN', color: '#7f8c8d' },
  MRCAN: { label: 'CAN', color: '#3d7bd9' },
  MOST: { label: 'MOST', color: '#3ba55d' },
  BYTEFLIGHT: { label: 'byteflight', color: '#8a5cd6' },
  FLEXRAY: { label: 'FlexRay', color: '#8a5cd6' },
  ETHERNET: { label: 'Ethernet', color: '#888888' },
};

/**
 * A bus's legend entry.
 * @param {string} bus - the bus name
 * @returns {{label: string, color: string}}
 */
function ecuTreeBusStyle(bus) {
  return ECU_TREE_BUS_STYLE[bus] || { label: bus, color: '#8d9aa6' };
}

/**
 * The modules a tree draws: those on a drawn bus, ONE BOX PER CELL.
 *
 * ISTA's tree is a picture of slots, and it lists every module that can
 * fill a slot on the same cell: E46 has DME at 0x10, 0x12 and 0x13 all on
 * (7,1), EGS at 0x18 and 0x32 on one cell, and so on across 40 trees.
 * Drawn one over the other, the topmost hides the one that answered (the
 * scan reads the 0x12 DME through D_MOTOR; the 0x13 box lay on top and
 * stayed grey). So the cell is the box: its addresses and groups are the
 * union, its name the first's, and `slots` keeps each member so the box
 * can be labelled with the one that answered (ABS / DSC / DXC is one slot).
 * @param {EcuTree} tree - the tree
 * @returns {EcuTreeEcu[]}
 */
function ecuTreeDrawn(tree) {
  const hidden =
    typeof ECU_TREE_HIDDEN !== 'undefined'
      ? ECU_TREE_HIDDEN
      : new Set(['UNKNOWN', 'VIRTUAL', 'NONE', 'INTERNAL']);
  const out = [];
  const byCell = new Map();
  for (const e of tree.ecus || []) {
    if (hidden.has(e.bus)) continue;
    const cell = e.col >= 0 && e.row >= 0 ? `${e.col},${e.row}` : null;
    const have = cell ? byCell.get(cell) : null;
    if (!have) {
      const box = {
        ...e,
        groups: [...(e.groups || [])],
        addrs: [e.addr],
        slots: [{ name: e.name, addr: e.addr, groups: [...(e.groups || [])] }],
      };
      out.push(box);
      if (cell) byCell.set(cell, box);
      continue;
    }
    have.addrs.push(e.addr);
    have.slots.push({
      name: e.name,
      addr: e.addr,
      groups: [...(e.groups || [])],
    });
    for (const g of e.groups || [])
      if (!have.groups.includes(g)) have.groups.push(g);
  }
  return out;
}

/**
 * The name a box shows: the slot that answered when a read says which, else
 * the cell's first. Every slot's name is in `names` for the hover and sheet.
 * @param {EcuTreeEcu} ecu - the box (ecuTreeDrawn output)
 * @param {EcuTreeStatus|null|undefined} st - what a read said about it
 * @returns {{label: string, names: string}}
 */
function ecuTreeBoxName(ecu, st) {
  const slots = ecu.slots || [
    { name: ecu.name, addr: ecu.addr, groups: ecu.groups || [] },
  ];
  const via =
    st && st.module && st.module.via ? String(st.module.via).toLowerCase() : '';
  const hit = via ? slots.find((x) => (x.groups || []).includes(via)) : null;
  const seen = [];
  for (const x of slots) if (!seen.includes(x.name)) seen.push(x.name);
  return { label: (hit || slots[0]).name, names: seen.join(' / ') };
}

/**
 * A box's key: the same module can appear twice (two DME slots), so the
 * address tells them apart.
 * @param {EcuTreeEcu} ecu - the module
 * @returns {string}
 */
function ecuTreeKey(ecu) {
  return `${ecu.name}@${ecu.addr}`;
}

/**
 * @typedef {object} EcuTreeStatus
 * @property {'faults'|'ok'|'silent'|'unread'} state
 * @property {number} faults - stored faults, when read
 * @property {object|null} module - the report module that answered, if any
 */

/**
 * What a stored scan says about each box. ISTA's legend: a module with
 * fault memory, one without, one not responding. A whole-car report names
 * every module by the group it was reached through (`via`) and every
 * address that stayed silent by its group (`target`); a tree box lists the
 * groups it stands for, so the join is by group name.
 * @param {EcuTree} tree - the tree
 * @param {object|null} report - an IpoProtocolReport (kind 'faults'), or null
 * @returns {Map<string, EcuTreeStatus>} box key -> status
 */
function ecuTreeStatus(tree, report) {
  const out = new Map();
  const answered = new Map();
  const silent = new Set();
  for (const m of (report && report.modules) || [])
    if (m && m.via) answered.set(String(m.via).toLowerCase(), m);
  for (const s of (report && report.silent) || [])
    if (s && s.target) silent.add(String(s.target).toLowerCase());
  for (const ecu of ecuTreeDrawn(tree)) {
    let hit = null;
    for (const g of ecu.groups || []) {
      if (answered.has(g)) {
        hit = answered.get(g);
        break;
      }
    }
    let state = 'unread';
    let faults = 0;
    if (hit) {
      faults = (hit.codes || []).length;
      state = faults ? 'faults' : 'ok';
    } else if ((ecu.groups || []).some((g) => silent.has(g))) {
      state = 'silent';
    }
    out.set(ecuTreeKey(ecu), { state, faults, module: hit });
  }
  return out;
}

/**
 * @typedef {object} EcuTreeBox
 * @property {EcuTreeEcu} ecu
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 */

/**
 * @typedef {object} EcuTreeLine
 * @property {string} bus
 * @property {number} x
 * @property {number} y1
 * @property {number} y2
 */

/**
 * @typedef {object} EcuTreeStub
 * @property {string} bus
 * @property {number} x1
 * @property {number} x2
 * @property {number} y
 */

/**
 * @typedef {object} EcuTreeLayout
 * @property {number} width
 * @property {number} height
 * @property {EcuTreeBox[]} boxes
 * @property {EcuTreeLine[]} lines - the vertical bus lines
 * @property {EcuTreeStub[]} stubs - box-to-line and line-to-root connectors
 * @property {EcuTreeBox|null} root
 * @property {string[]} buses - the buses drawn, for the legend
 */

/**
 * Lay the tree out the way ISTA paints it: a bus line runs down the gap to
 * the left of its column; a module hangs on the line of its bus that is
 * immediately left of it, or immediately right of it when that line takes
 * modules from both sides; every line that paints to the root turns at the
 * root row and joins the gateway box.
 * @param {EcuTree} tree - the tree
 * @param {Partial<typeof ECU_TREE_GEOM>} [geom] - geometry overrides
 * @returns {EcuTreeLayout}
 */
function ecuTreeLayout(tree, geom) {
  const G = { ...ECU_TREE_GEOM, ...(geom || {}) };
  const ecus = ecuTreeDrawn(tree);
  const buses = tree.buses || [];
  const lineForBus = (e) =>
    buses.some(
      (b) =>
        b.bus === e.bus &&
        (b.col === e.col || (b.col === e.col + 1 && !b.connectOnlyRight))
    );
  const cols = new Set(
    ecus.filter((e) => e.bus === 'ROOT' || lineForBus(e)).map((e) => e.col)
  );
  for (const b of buses) cols.add(b.col);
  const colList = [...cols].sort((a, b) => a - b);
  const colIx = new Map(colList.map((c, i) => [c, i]));
  const rows = ecus.map((e) => e.row);
  const rowMin = rows.length ? Math.min(...rows) : 0;
  const rowMax = rows.length ? Math.max(...rows) : 0;
  const xOf = (col) => G.padX + (colIx.get(col) || 0) * G.colW;
  const yOf = (row) => G.padY + (row - rowMin) * G.rowH;
  const lineX = (col) => xOf(col) - (G.colW - G.boxW) / 2;

  /** the line a module hangs on: same bus, left of it, or right when open */
  const lineFor = (e) => {
    const same = buses.filter((b) => b.bus === e.bus);
    return (
      same.find((b) => b.col === e.col) ||
      same.find((b) => b.col === e.col + 1 && !b.connectOnlyRight) ||
      null
    );
  };
  // a module on a bus the tree draws no line for (the E46's SI-Bus
  // satellites) would float unconnected; ISTA lists it, the picture skips it
  const boxes = ecus
    .filter((e) => e.bus === 'ROOT' || lineFor(e))
    .map((e) => ({
      ecu: e,
      x: xOf(e.col),
      y: yOf(e.row),
      w: G.boxW,
      h: G.boxH,
    }));
  const root = boxes.find((b) => b.ecu.bus === 'ROOT') || null;
  const rootY = root ? root.y + root.h / 2 : yOf(rowMin);
  const stubs = [];
  const extent = new Map();
  for (const box of boxes) {
    if (box.ecu.bus === 'ROOT') continue;
    const line = lineFor(box.ecu);
    if (!line) continue;
    const lx = lineX(line.col);
    const y = box.y + box.h / 2;
    const left = lx < box.x;
    stubs.push({
      bus: line.bus,
      x1: left ? lx : box.x + box.w,
      x2: left ? box.x : lx,
      y,
    });
    const k = `${line.bus}@${line.col}`;
    const ex = extent.get(k) || { line, y1: y, y2: y };
    ex.y1 = Math.min(ex.y1, y);
    ex.y2 = Math.max(ex.y2, y);
    extent.set(k, ex);
  }
  const lines = [];
  for (const { line, y1, y2 } of extent.values()) {
    const lx = lineX(line.col);
    let top = y1;
    if (line.paintToRoot && root) {
      top = Math.min(top, rootY);
      // the turn at the root row: to the gateway's nearest edge
      const rootLeft = lx < root.x;
      stubs.push({
        bus: line.bus,
        x1: rootLeft ? lx : root.x + root.w,
        x2: rootLeft ? root.x : lx,
        y: rootY,
      });
    }
    lines.push({ bus: line.bus, x: lx, y1: top, y2 });
  }
  const width =
    G.padX * 2 + (colList.length ? (colList.length - 1) * G.colW + G.boxW : 0);
  const height = G.padY * 2 + (rowMax - rowMin) * G.rowH + G.boxH;
  return {
    width,
    height,
    boxes,
    lines,
    stubs,
    root,
    buses: [...new Set(lines.map((l) => l.bus))],
  };
}

/**
 * The module row in the chassis config a box opens: the first row whose
 * group is one the box stands for, preferring the one the scan says
 * answered (an engine slot lists every DME the chassis ever had).
 * @param {EcuTreeEcu} ecu - the box's module
 * @param {object} config - the chassis config ({sections:[{name, ecus:[{sgbd, group}]}]})
 * @param {object|null} [answered] - the report module that answered, if any
 * @returns {{section: string, row: object}|null}
 */
function ecuTreeModuleRow(ecu, config, answered) {
  const groups = new Set((ecu.groups || []).map((g) => g.toLowerCase()));
  const want =
    answered && answered.sgbd ? String(answered.sgbd).toLowerCase() : '';
  let first = null;
  for (const sec of (config && config.sections) || []) {
    for (const row of sec.ecus || []) {
      const g = String(row.group || '').toLowerCase();
      if (!groups.has(g)) continue;
      if (want && String(row.sgbd || '').toLowerCase() === want)
        return { section: sec.name, row };
      if (!first) first = { section: sec.name, row };
    }
  }
  return first;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ECU_TREE_GEOM,
    ecuTreeBusStyle,
    ecuTreeDrawn,
    ecuTreeKey,
    ecuTreeBoxName,
    ecuTreeStatus,
    ecuTreeLayout,
    ecuTreeModuleRow,
  };
}
