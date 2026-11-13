/**
 * @file The control unit tree, built the way ISTA builds it.
 *
 * A PORT OF EcuTreeNewViewModel, EcuTreeUtils and the EcuTreeNew view
 * (RheingoldPresentationFramework), over the series' EcuTreeConfiguration
 * that tools/ista/ecu_tree_extract.py ships. Nothing here decides where a
 * box goes or how a line runs: the tool's table gives every unit a cell and
 * every bus a column, and this follows the tool's own steps over them.
 *
 *   1. each unit takes its cell from the table; one with no cell, or with a
 *      cell another unit already has, is parked in a spare row below (14 on).
 *      (Parking a SECOND unit of a cell is the tool's ECUTreeShowDuplicates
 *      switch, off by default in 4.15, where the two are drawn on top of
 *      each other. It is on here: a workshop install's tree shows the E46's
 *      second brake unit parked, and one box hiding another helps nobody.)
 *   2. each bus line is a vertical at its column, from the root's row (or
 *      its MinRow) down to the lowest unit it serves, with a stub out to
 *      every unit on either side; where it runs to the root, lines sharing a
 *      side fan out an eighth of a row apart so they do not overlap
 *   3. lines that join two buses and housings that frame several units as
 *      one are drawn when their address rule holds for this car
 *   4. the legend names each bus that drew a line, by the series' own name
 *
 * THE GRID IS THE TOOL'S: a cell is 72 x 31 (a 60 x 25 button with a 6 / 3
 * margin), lines are 2 wide in the tool's bus colours, and a housing is the
 * tool's cadet-blue block behind its units.
 *
 * WHAT A UNIT'S COLOUR MEANS is setECUColor, for the mode this tool runs in
 * (ISTA_PLUS): green answered with no fault, yellow answered with a fault,
 * red-brown expected and silent, grey not read or not fitted, blue a
 * programming abort.
 *
 * Pure except for ecuTreeDraw: the build is testable without a DOM.
 */

/* exported ECU_TREE_CELL ECU_TREE_BUS_COLOR ECU_TREE_COLOR ecuTreeCheckRule
   ecuTreeHasBus ecuTreeBuild ecuTreeUnitColor ecuTreeDraw ecuTreeExpected
   ecuTreeHasGearboxEcu ECU_TREE_SERIES_RULES ecuTreeTitle ecuTreeShape
   ecuTreePossible */

/** One grid cell: EcuTreeButtonDiagnosisViewModel's size plus its margins. */
const ECU_TREE_CELL = { w: 72, h: 31, btnW: 60, btnH: 25, mx: 6, my: 3 };

/** The first spare row for a unit the table gives no cell (FirstRowUnset). */
const ECU_TREE_ROW_UNSET = 14;

/** How far apart lines to the root sit on one side (HorizonalStep). */
const ECU_TREE_STEP = 0.125;

/** BusTypeColorConverter: the colour each bus line is drawn in. */
const ECU_TREE_BUS_COLOR = {
  KCAN: '#0000ff',
  KCAN2: '#999999',
  KCAN3: '#990000',
  MOST: '#33cc00',
  FASCAN: '#ff3300',
  BCAN: '#999999',
  BCAN2: '#990000',
  CASCAN: '#00ffff',
  FLEXRAY: '#ff1493',
  SIBUS: '#c39f0d',
  SCAN: '#993300',
  ACAN: '#339900',
  ETHERNET: '#0066ff',
  FACAN: '#ffcc00',
  IBUS: '#489b46',
  DWA: '#ff7f44',
  ZGW: '#d6ff32',
  LOCAN: '#ffa01c',
  BYTEFLIGHT: '#c39f0d',
  HCAN: '#ff2bf0',
  IKCAN: '#9933ff',
  LECAN: '#ceff00',
  LE2CAN: '#ffff00',
  MRCAN: '#000000',
};

/** setECUColor's colours, by what they mean. */
const ECU_TREE_COLOR = {
  ok: '#008000',
  faults: '#c39f0d',
  silent: '#a52a2a',
  unread: '#a9a9a9',
  abort: '#4169e1',
};

/**
 * Whether a unit is on a bus: its own, or one of its sub-buses.
 *
 * BaseEcuCharacteristics.HasBus. A variant the series lists by name (the
 * SGBD bus table) answers for the unit when the unit has identified as it.
 * @param {string} bus - the bus asked about
 * @param {object} tree - the series' tree
 * @param {object} u - a unit: {bus, subBus, variant}
 * @returns {boolean}
 */
function ecuTreeHasBus(bus, tree, u) {
  if (u.variant && tree && tree.variants) {
    const v = tree.variants.find(
      (x) => x.variant === String(u.variant).toLowerCase()
    );
    if (v) return v.bus === bus || (v.subBus || []).includes(bus);
  }
  return u.bus === bus || (u.subBus || []).includes(bus);
}

/**
 * Does an address rule hold for this car?
 *
 * A PORT OF EcuTreeUtils.CheckRule. Each entry packs an address (low byte),
 * a sub-address or upper bound (next byte) and an operator (third byte):
 *   0    the unit must be fitted (AND)        1    or this one is (OR)
 *   2    the bus has between low and high units on it
 *   128  the unit must NOT be fitted          129  exactly one of (XOR)
 *   130  the bus does NOT have between low and high units on it
 * The first entry's operator seeds the running answer: false for the three
 * that only ever turn it on, true otherwise. No rule at all holds.
 * @param {object[]} units - the car's units
 * @param {number[]|undefined} rules - the packed entries
 * @param {string} bus - the bus the rule is asked for
 * @param {object} tree - the series' tree
 * @returns {boolean}
 */
function ecuTreeCheckRule(units, rules, bus, tree) {
  if (!rules || !rules.length) return true;
  const fitted = (addr, sub) =>
    units.some((u) => u.addr === addr && (sub == null || u.sub === sub));
  const between = (lo, hi) => {
    const n = units.filter((u) => ecuTreeHasBus(bus, tree, u)).length;
    return n >= lo && n <= hi;
  };
  let flag = null;
  for (const r of rules) {
    const low16 = r & 0xffff;
    const a = low16 & 0xff;
    const b = (low16 & 0xff00) >> 8;
    const op = (r & 0xff0000) >> 16;
    const has = fitted(a, null);
    const hasSub = fitted(a, b);
    if (flag === null) flag = !(op === 1 || op === 129 || op === 130);
    if (low16 < 255) {
      if (op === 128) flag = has ? false : flag;
      else if (op === 129) flag = flag !== has;
      else if (op === 130) flag = between(a, b) ? false : flag;
      else if (op === 1) flag = has || flag;
      else if (op === 2) flag = between(a, b) && flag;
      else flag = has && flag;
    } else if (low16 > 255 && low16 < 65535) {
      if (op === 128) flag = has || hasSub ? false : flag;
      else if (op === 129) flag = (flag !== has) !== hasSub;
      else if (op === 130) flag = between(a, b) ? false : flag;
      else if (op === 1) flag = hasSub || has || flag;
      else if (op === 2) flag = between(a, b) && flag;
      else flag = hasSub && has && flag;
    }
  }
  return flag === null ? true : flag;
}

/**
 * The colour a unit is drawn in.
 *
 * setECUColor for the ISTA_PLUS mode: a unit that answered is yellow when
 * it holds a fault that counts (relevant, or of unknown relevance) and
 * green when it holds none; one whose fault memory was not read is grey;
 * one that was expected and did not answer is red-brown; anything else is
 * grey.
 * @param {object} u - {state: ok|faults|silent|unread, abort}
 * @returns {string} a CSS colour
 */
function ecuTreeUnitColor(u) {
  if (u.abort) return ECU_TREE_COLOR.abort;
  return ECU_TREE_COLOR[u.state] || ECU_TREE_COLOR.unread;
}

/**
 * The text on a unit's button (its TITLE_ECUTREE).
 *
 * A PORT OF VehicleDataConverter.FillEcuNames and ECU.FillEcuTitleTree. The
 * unit's candidate variants are the one it identified as, else every
 * variant of its group(s) valid for the car; each variant's clique names a
 * representative ("GM", "RAD", "MRS"). When the candidates agree on one
 * representative, that is the title; otherwise it is the series' own name
 * for the unit with its address, "SM_0x72".
 * @param {{variants: Object<string, string>, groups: Object<string,
 *   Array<[string, object?]>>}|null} names - tools/ista/ecu_names_extract.py,
 *   for the chassis: each group's names, with the rule to ask of the car
 * @param {object} u - {name, addr, variant (when identified), groups}
 * @param {(rule: object|undefined) => boolean} [holds] - the car's rule
 *   check; without one every name the chassis allows is a candidate
 * @returns {string}
 */
function ecuTreeTitle(names, u, holds) {
  const hex = Number(u.addr).toString(16).toUpperCase().padStart(2, '0');
  const fallback = `${u.name || ''}_0x${hex}`;
  if (!names) return u.name || fallback;
  const shorts = new Set();
  const own = u.variant && names.variants[String(u.variant).toLowerCase()];
  if (own) shorts.add(own);
  else
    for (const g of u.groups || [])
      for (const [s, rule] of names.groups[String(g).toLowerCase()] || [])
        if (!holds || holds(rule)) shorts.add(s);
  return shorts.size === 1 ? [...shorts][0] : fallback;
}

/**
 * Drop the units a read has ruled out.
 *
 * A PORT OF BaseEcuCharacteristics.ShapeECUConfiguration, which the tool
 * runs after identification: of each set the car carries ONE of, once a
 * member has identified the members that have not are removed; and a unit
 * the series is unsure of is removed unless it identified.
 * @param {object} tree - the series' tree ({xor, unsure})
 * @param {object[]} units - the car's units: {addr, identified}
 * @returns {object[]} the units that stay
 */
function ecuTreeShape(tree, units) {
  const gone = new Set();
  const at = (addr) => units.find((u) => u.addr === addr);
  for (const set of (tree && tree.xor) || []) {
    if (!set || set.length < 2) continue;
    let valid = -1;
    for (const a of set) {
      const u = at(a);
      if (u && u.identified) valid = a;
    }
    if (valid < 0) continue;
    for (const a of set) {
      const u = at(a);
      if (a !== valid && u && !u.identified) gone.add(u);
    }
  }
  for (const a of (tree && tree.unsure) || []) {
    const u = at(a);
    if (u && !u.identified) gone.add(u);
  }
  return units.filter((u) => !gone.has(u));
}

/**
 * Build the tree for a car.
 * @param {object} tree - the series' tree (ecu_tree_extract.py)
 * @param {object[]} input - the car's units: {addr, sub, name, bus, subBus,
 *   variant, col, row, state, ...}; `col`/`row` -1 when the table has none
 * @returns {{units: object[], lines: object[], housings: object[],
 *   legend: Array<{bus: string, name: string, color: string}>,
 *   cols: number, rows: number}}
 */
function ecuTreeBuild(tree, input) {
  // IsEcuRelevant: units on no bus, or on a virtual one, are not drawn
  const relevant = (u) =>
    !['VIRTUALBUSCHECK', 'NONE', 'VIRTUAL'].includes(u.bus);

  // ---- 1. positions (CalculateEcuPositions) ---------------------------------
  let colUnset = 0;
  let rowUnset = ECU_TREE_ROW_UNSET;
  const park = () => {
    // CalculatePositionMisplacedOrUndefinedEcus: ten to a spare row
    let col;
    if (colUnset < 10) {
      col = colUnset;
      colUnset++;
    } else {
      colUnset = 0;
      col = colUnset;
      rowUnset++;
    }
    return [col, rowUnset];
  };
  const taken = new Set();
  const units = (input || []).map((u) => {
    let col = u.col == null ? -1 : u.col;
    let row = u.row == null ? -1 : u.row;
    // a unit with no cell is parked, and so is the second unit of a cell
    // (ECUTreeShowDuplicates; see the note at the top of the file)
    if (col === -1 || row === -1 || taken.has(`${col}:${row}`))
      [col, row] = park();
    taken.add(`${col}:${row}`);
    return { ...u, col, row };
  });

  const root = units.find((u) => u.bus === 'ROOT' || u.bus === 'VIRTUALROOT');
  const rootCol = root ? root.col : 0;
  const rootRow = root ? root.row : 0;
  const onBus = (u, bus) => u.bus === bus || ecuTreeHasBus(bus, tree, u);
  const exists = (bus, row, col) =>
    units.some((u) => onBus(u, bus) && u.row === row && u.col === col);
  const rootAt = (col, row) => !!root && root.col === col && root.row === row;

  /** @type {object[]} */
  const lines = [];
  const add = (x1, y1, x2, y2, bus) => {
    // AddBusConnectionIfValid: a line that starts off the grid is dropped
    const col = Math.min(Math.trunc(x1), Math.trunc(x2));
    const row = Math.min(Math.trunc(y1), Math.trunc(y2));
    if (Math.min(col, row) < 0) return;
    lines.push({ x1, y1, x2, y2, bus });
  };

  // ---- 2. bus lines (BuildBusConnections) -----------------------------------
  /** @type {Map<string, number>} */
  const toRootLeft = new Map();
  /** @type {Map<string, number>} */
  const toRootRight = new Map();
  for (const e of (tree && tree.buses) || []) {
    if (!ecuTreeCheckRule(units, e.req, e.bus, tree)) continue;
    if (e.bike) {
      // BuildBusConnectionsBike: one rail over every unit of the bus
      const cols = units.filter((u) => onBus(u, e.bus)).map((u) => u.col);
      const left = cols.length ? Math.min(...cols) : 1000;
      const right = cols.length ? Math.max(...cols) : -1;
      const x = left + 0.5;
      if (units.length > 1) add(x, 1.5, x + right - left, 1.5, e.bus);
      for (const u of units)
        add(x + (u.col - left), 1.5, x + (u.col - left), 2.5, e.bus);
      continue;
    }
    // BuildBusConnectionsCarEx
    const xo = e.x || 0;
    const yo = e.y || 0;
    // FindMaxRow: the lowest unit of the bus beside this column
    let maxRow = -1;
    for (const u of units) {
      const beside =
        u.col === e.col || (!e.connectOnlyRight && u.col === e.col - 1);
      if (!beside || !onBus(u, e.bus)) continue;
      if (u.row > maxRow && u.row < ECU_TREE_ROW_UNSET) {
        if (e.connectOnlyRight && u.col === e.col - 1) continue;
        maxRow = u.row;
      }
    }
    if (e.maxRowLimit !== -1) maxRow = e.maxRowLimit;
    if (maxRow === -1) continue;
    let toRoot = !!e.paintToRoot;
    let top;
    if (e.minRow !== -1 && e.minRow !== rootRow) {
      top = e.minRow + 0.5 + yo;
    } else {
      toRoot = true;
      const side = rootCol <= e.col - 1 ? toRootRight : toRootLeft;
      if (!side.has(e.bus))
        side.set(
          e.bus,
          side === toRootRight
            ? rootRow + 0.7 - side.size * ECU_TREE_STEP
            : rootRow + 0.3 + side.size * ECU_TREE_STEP
        );
      top = side.get(e.bus);
    }
    const flat = Math.abs(top - (maxRow + 0.5 + yo)) < 0.001;
    if (e.vertical && !flat)
      add(e.col + xo, top, e.col + xo, maxRow + 0.5 + yo, e.bus);
    if (toRoot) add(e.col + xo, top, rootCol + 0.5, top, e.bus);
    if (e.horizontal && !flat)
      for (let i = 0; i <= maxRow; i++) {
        if (
          !e.connectOnlyRight &&
          !rootAt(e.col - 1, i) &&
          exists(e.bus, i, e.col - 1)
        )
          add(e.col + xo, i + yo + 0.5, e.col + xo - 0.5, i + yo + 0.5, e.bus);
        if (!rootAt(e.col, i) && exists(e.bus, i, e.col))
          add(e.col + xo, i + yo + 0.5, e.col + xo + 0.5, i + yo + 0.5, e.bus);
      }
  }
  for (const l of (tree && tree.links) || [])
    if (ecuTreeCheckRule(units, l.req, l.bus, tree))
      add(l.x1, l.y1, l.x2, l.y2, l.bus);

  // ---- 3. housings (BuildCombinedEcuHousings) -------------------------------
  const housings = ((tree && tree.housings) || [])
    .filter((h) => ecuTreeCheckRule(units, h.req, 'UNKNOWN', tree))
    .map((h) => ({ col: h.col, row: h.row, count: h.count }));

  // ---- 4. legend, and the grid the items span (CalculateGrid) ---------------
  const names = (tree && tree.busNames) || {};
  const legend = [...new Set(lines.map((l) => l.bus))].map((bus) => ({
    bus,
    name: names[bus] || bus,
    color: ECU_TREE_BUS_COLOR[bus] || '#000000',
  }));
  const drawn = units.filter(relevant);
  let cols = 0;
  let rows = 0;
  for (const u of drawn) {
    cols = Math.max(cols, u.col + 1);
    rows = Math.max(rows, u.row + 1);
  }
  for (const h of housings) {
    cols = Math.max(cols, h.col + 1);
    rows = Math.max(rows, h.row + h.count);
  }
  for (const l of lines) {
    cols = Math.max(cols, Math.trunc(Math.max(l.x1, l.x2)) + 1);
    rows = Math.max(rows, Math.trunc(Math.max(l.y1, l.y2)) + 1);
  }
  return { units: drawn, lines, housings, legend, cols, rows };
}

/**
 * Draw a built tree.
 *
 * Three layers, in the tool's z-order: the bus lines, the housings over
 * them, the units on top. A unit is a toggle: the picked one turns light
 * grey with a thick border in its own colour, as the tool's does.
 * @param {HTMLElement} host - where to draw
 * @param {object} built - ecuTreeBuild output
 * @param {object} [o] - {selected(unit) -> boolean, pick(unit), tip(unit)}
 * @returns {void}
 */
function ecuTreeDraw(host, built, o) {
  const opt = o || {};
  const C = ECU_TREE_CELL;
  const W = Math.max(1, built.cols) * C.w;
  const H = Math.max(1, built.rows) * C.h;
  const wrap = document.createElement('div');
  wrap.className = 'ixecutree';
  const grid = document.createElement('div');
  grid.className = 'ixecutree-grid';
  grid.style.width = `${W}px`;
  grid.style.height = `${H}px`;

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('width', String(W));
  svg.setAttribute('height', String(H));
  svg.setAttribute('class', 'ixecutree-lines');
  for (const l of built.lines) {
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', String(l.x1 * C.w));
    line.setAttribute('y1', String(l.y1 * C.h));
    line.setAttribute('x2', String(l.x2 * C.w));
    line.setAttribute('y2', String(l.y2 * C.h));
    line.setAttribute('stroke', ECU_TREE_BUS_COLOR[l.bus] || '#000000');
    line.setAttribute('stroke-width', '2');
    svg.appendChild(line);
  }
  grid.appendChild(svg);

  for (const h of built.housings) {
    const box = document.createElement('div');
    box.className = 'ixecutree-housing';
    box.style.left = `${h.col * C.w + 3}px`;
    box.style.top = `${h.row * C.h}px`;
    box.style.width = `${C.w - 6}px`;
    box.style.height = `${h.count * C.h}px`;
    grid.appendChild(box);
  }

  for (const u of built.units) {
    const b = document.createElement('button');
    b.type = 'button';
    const on = !!(opt.selected && opt.selected(u));
    b.className = `ixecutree-unit${on ? ' on' : ''}`;
    b.style.left = `${u.col * C.w + C.mx}px`;
    b.style.top = `${u.row * C.h + C.my}px`;
    b.style.width = `${C.btnW}px`;
    b.style.height = `${C.btnH}px`;
    b.style.setProperty('--ecu', ecuTreeUnitColor(u));
    b.textContent = u.name || '';
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (opt.tip) {
      const tip = opt.tip(u);
      if (tip) b.dataset.tip = '1';
      b.onmouseenter = () => {
        const html = opt.tip(u);
        if (!html) return;
        let pop = wrap.querySelector('.ixecutree-tip');
        if (!pop) {
          pop = document.createElement('div');
          pop.className = 'ixecutree-tip';
          wrap.appendChild(pop);
        }
        pop.innerHTML = html;
        pop.style.left = `${u.col * C.w + C.w}px`;
        pop.style.top = `${u.row * C.h + C.h}px`;
        pop.hidden = false;
      };
      b.onmouseleave = () => {
        const pop = wrap.querySelector('.ixecutree-tip');
        if (pop) pop.hidden = true;
      };
    }
    b.onclick = () => {
      if (opt.pick) opt.pick(u);
    };
    grid.appendChild(b);
  }
  wrap.appendChild(grid);

  const legend = document.createElement('div');
  legend.className = 'ixecutree-legend';
  for (const l of built.legend) {
    const item = document.createElement('span');
    item.className = 'ixecutree-legend-item';
    const name = document.createElement('span');
    name.textContent = l.name;
    const swatch = document.createElement('i');
    swatch.style.background = l.color;
    item.append(name, swatch);
    legend.appendChild(item);
  }
  wrap.appendChild(legend);
  host.replaceChildren(wrap);
}

/**
 * Whether a car has a gearbox control unit (Vehicle.HasGearboxECU).
 * @param {object} f - {motor, gearbox, sa: Set<string>}
 * @returns {boolean}
 */
function ecuTreeHasGearboxEcu(f) {
  if (String(f.motor || '').toUpperCase() === 'W10') return false;
  if (String(f.gearbox || '').toUpperCase() === 'AUT') return true;
  return ['205', '206', '2TB', '2TC', '2MK'].some((c) => f.sa.has(c));
}

/**
 * The series' own additions to the expected units, from its
 * EcuCharacteristics class. Each returns [add, remove] address lists.
 *
 * ONLY THE SERIES PORTED SO FAR ARE HERE. Every series has such a class
 * (51 of them); one that is missing falls back to the table's minimal
 * configuration and whatever the car's reads found.
 * @type {Object<string, (f: object) => [number[], number[]]>}
 */
const ECU_TREE_SERIES_RULES = {
  // E46EcuCharacteristics.CalculateECUConfiguration
  E46: (f) => {
    const add = [];
    const motor = String(f.motor || '').toUpperCase();
    if (motor === 'M73') add.push(16, 20, 34);
    else if (motor === 'M67') add.push(18, 19);
    else add.push(18);
    if (ecuTreeHasGearboxEcu(f)) add.push(50);
    for (const [sa, addr] of [
      ['534', 91],
      ['459', 114],
      ['256', 80],
      ['508', 96],
      ['403', 8],
      ['602', 240],
      ['265', 112],
      ['0549', 40],
      ['0540', 166],
    ])
      if (f.sa.has(sa) || f.sa.has(sa.replace(/^0/, ''))) add.push(addr);
    // "not an ABS-only car": the stability control unit is expected, unless
    // an MK60 answered on a car without DSC (SA 210), where it is the ABS
    if (f.absOnly === false && !(f.mk60 && !f.sa.has('210'))) add.push(87);
    return [add, motor === 'M54' ? [101] : []];
  },
};

/**
 * The addresses a car is expected to carry before any unit has answered.
 *
 * A PORT OF BaseEcuCharacteristics.CalculateECUConfiguration: the series'
 * own rules, then the table's compatibility lines (address; group; type
 * keys; options; and optionally an I-level and a build-date window), then
 * the minimal configuration, less what the series excludes and removes.
 * A car whose options are not known is run with none, as the tool runs one
 * whose vehicle order it could not read: the units that hang on an option
 * are then simply not expected until a read finds them.
 * @param {object} tree - the series' tree
 * @param {object|null} f - {motor, gearbox, typ, sa: Set, prod: number
 *   (yyyymm), absOnly, mk60}
 * @returns {Set<number>|null} null only when there is no tree
 */
function ecuTreeExpected(tree, f) {
  if (!tree || !f) return null;
  if (!f.sa) f = { ...f, sa: new Set() };
  const want = new Set();
  const rule = ECU_TREE_SERIES_RULES[tree.series];
  const [add, remove] = rule ? rule(f) : [[], []];
  for (const a of add) want.add(a);
  for (const line of tree.compat || []) {
    const p = line.split(';');
    const addr = parseInt(p[0], 16);
    if (!Number.isFinite(addr) || want.has(addr)) continue;
    if (!String(p[2] || '').includes(String(f.typ || '\u0000'))) continue;
    if (p.length === 7) {
      const ym = (s) =>
        /^\d{6}$/.test(s || '') ? Number(s.slice(2) + s.slice(0, 2)) : null;
      const from = ym(p[5]);
      const to = ym(p[6]);
      if (f.prod && from && f.prod < from) continue;
      // the tool allows a month past the window's end
      const after = to ? (to % 100 === 12 ? to + 89 : to + 1) : null;
      if (f.prod && after && f.prod > after) continue;
    }
    const fits = String(p[3] || '')
      .split('&')
      .filter(Boolean)
      .every((c) => (c.startsWith('-') ? !f.sa.has(c.slice(1)) : f.sa.has(c)));
    if (fits) want.add(addr);
  }
  for (const a of tree.minimal || []) want.add(a);
  for (const a of tree.excluded || []) want.delete(a);
  for (const a of remove) want.delete(a);
  return want;
}

/**
 * The units a K-bus car might carry beyond the ones it is expected to.
 *
 * A PORT OF VehicleIdent.GetFullVehicleECU and SetupECUListByGrpList. The
 * tool walks a fixed list of group files, keeps each whose validity rule
 * holds for the car, and adds the unit the series' table files that group
 * under (the first entry whose groups contain the name). They are the grey
 * boxes on a tree: possible on this car, never confirmed, and so never red
 * when they do not answer.
 * @param {object} tree - the series' tree
 * @param {Array<{g: string, r?: object}>|undefined} full - the list, cut
 *   to the chassis (tools/ista/ecu_names_extract.py)
 * @param {(rule: object|undefined) => boolean} holds - the car's rule check
 * @returns {Set<number>} addresses
 */
function ecuTreePossible(tree, full, holds) {
  const out = new Set();
  for (const entry of full || []) {
    if (!holds(entry.r)) continue;
    const g = String(entry.g).toLowerCase();
    // getECUAdrByECU_GRUPPE: a substring match over the joined group names
    const hit = ((tree && tree.ecus) || []).find((e) =>
      (e.groups || []).join('|').toLowerCase().includes(g)
    );
    if (hit) out.add(hit.addr);
  }
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ECU_TREE_CELL,
    ECU_TREE_BUS_COLOR,
    ECU_TREE_COLOR,
    ecuTreeHasBus,
    ecuTreeCheckRule,
    ecuTreeUnitColor,
    ecuTreeBuild,
    ecuTreeDraw,
    ecuTreeHasGearboxEcu,
    ecuTreeExpected,
    ecuTreeTitle,
    ecuTreeShape,
    ecuTreePossible,
    ECU_TREE_SERIES_RULES,
  };
}
