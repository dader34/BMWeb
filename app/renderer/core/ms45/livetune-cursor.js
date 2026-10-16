/**
 * @file The live cursor's arithmetic: where on a table the DME is reading.
 *
 * Nothing on the DME reports that. But every lookup searches an axis with a
 * value that comes straight out of one RAM variable, and which variable is
 * known per table and axis (core/ms45/ms45-cursor-map.js, traced in the emulator
 * and checked there against every lookup the program made). So: read the
 * variable with the stock read-by-address, search the axis the way the
 * lookup library does, and the cell is known -- on any live-tune build, with
 * nothing added to the program.
 *
 * This file is the part with no page in it: which variables a table needs,
 * how to fetch several in few requests, and the search itself.
 */
/* exported LT_PROGRAM_AT, LT_CURSOR_CANARY, ltCursorInputs, ltCursorReads, ltCursorValue, ltAxisPosition, ltCursorCell */

/** Where the program reference sits in the external flash (12 ASCII bytes). */
const LT_PROGRAM_AT = 0x6031c;
/** Two variables this close are fetched in one request: a request costs far
 *  more in turnaround than the bytes between them do on the wire. */
const LT_CURSOR_JOIN = 48;

/** The first piece of the cursor's packet: the live-tune state block's
 *  magic, four bytes that never change while the build runs. The DME has one
 *  definable packet and BMW's own measurement-block jobs define it too, some
 *  with pieces the same total size as ours; a packet that does not begin
 *  with this is somebody else's. */
const LT_CURSOR_CANARY = {
  address: 0x3f9e74,
  size: 4,
  bytes: [0x4c, 0x54, 0x55, 0x4e],
};

/**
 * @typedef {Object} CursorInput
 * @property {number} address - The RAM variable.
 * @property {1|2} size
 * @property {boolean} signed
 * @property {string} name - What the variable is, when known.
 * @property {boolean} guessed - Not traced for this table: the variable every
 *   other table reading this axis uses.
 */

/**
 * The variable behind each of a table's axes.
 * @param {{vars:Array, tables:Object, axes:Object}} map - MS45_CURSOR_MAP.
 * @param {number} table - Calibration offset of the table's first cell.
 * @param {Array<number|null>} axes - Calibration offset of each axis's first
 *   break point; null for an axis the definition gives no address.
 * @returns {Array<CursorInput|null>} One per axis asked for.
 */
function ltCursorInputs(map, table, axes) {
  const traced = map.tables[table];
  return axes.map((first) => {
    if (first == null) return null;
    let index;
    let guessed = false;
    if (traced) {
      // a table the program was seen reading: only what was seen counts
      const hit = traced.find((pair) => pair[0] === first);
      if (hit) index = hit[1];
    } else if (map.axes[first] != null) {
      index = map.axes[first];
      guessed = true;
    }
    if (index == null) return null;
    const v = map.vars[index];
    return {
      address: v[0],
      size: v[1],
      signed: !!v[2],
      name: v[3] || '',
      guessed,
    };
  });
}

/**
 * The fewest reads that cover a set of variables.
 * @param {Array<CursorInput|null>} inputs
 * @returns {Array<{address:number, length:number}>} Ascending, not overlapping.
 */
function ltCursorReads(inputs) {
  const spans = inputs
    .filter(Boolean)
    .map((v) => ({ address: v.address, length: v.size }))
    .sort((a, b) => a.address - b.address);
  const out = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s.address <= last.address + last.length + LT_CURSOR_JOIN)
      last.length = Math.max(last.length, s.address + s.length - last.address);
    else out.push(s);
  }
  return out;
}

/**
 * One variable's value out of what the reads returned.
 * @param {CursorInput} input
 * @param {Array<{address:number, bytes:Uint8Array}>} blocks
 * @returns {number|null} null when no block holds it.
 */
function ltCursorValue(input, blocks) {
  for (const b of blocks) {
    const at = input.address - b.address;
    if (at < 0 || at + input.size > b.bytes.length) continue;
    let v = 0;
    for (let i = 0; i < input.size; i++) v = v * 256 + b.bytes[at + i];
    const top = 2 ** (8 * input.size);
    return input.signed && v >= top / 2 ? v - top : v;
  }
  return null;
}

/**
 * Where a value falls on an axis, as the lookup library finds it: held at
 * the first break point below it and at the last above it, a fraction of the
 * way between two otherwise.
 * @param {number} value - In the units the break points are in.
 * @param {number[]} points - The break points, rising.
 * @returns {{index:number, edge:-1|0|1}|null} `index` runs 0..points.length-1
 *   and may be fractional; `edge` says the value is off the axis's low (-1) or
 *   high (1) end. null for an axis that cannot be searched.
 */
function ltAxisPosition(value, points) {
  const n = points.length;
  if (!n || !Number.isFinite(value) || points.some((p) => !Number.isFinite(p)))
    return null;
  if (n === 1) return { index: 0, edge: 0 };
  if (value >= points[n - 1])
    return { index: n - 1, edge: value > points[n - 1] ? 1 : 0 };
  if (value <= points[0]) return { index: 0, edge: value < points[0] ? -1 : 0 };
  // from the top down, as the library walks it
  for (let i = n - 2; i >= 0; i--) {
    if (points[i] <= value) {
      const span = points[i + 1] - points[i];
      return { index: span > 0 ? i + (value - points[i]) / span : i, edge: 0 };
    }
  }
  return null; // break points that do not rise
}

/**
 * The table's value at a position, interpolated between the cells around it.
 * @param {Array<Array<number|null>>} cells - Rows of columns.
 * @param {number} row - May be fractional.
 * @param {number} col - May be fractional.
 * @returns {number|null}
 */
function ltCursorCell(cells, row, col) {
  const r0 = Math.floor(row);
  const c0 = Math.floor(col);
  const r1 = Math.min(cells.length - 1, r0 + 1);
  const c1 = Math.min(cells[0].length - 1, c0 + 1);
  const at = (r, c) => (cells[r] ? cells[r][c] : null);
  const q = [at(r0, c0), at(r0, c1), at(r1, c0), at(r1, c1)];
  if (q.some((v) => v == null || !Number.isFinite(v))) return null;
  const fr = row - r0;
  const fc = col - c0;
  const top = q[0] + (q[1] - q[0]) * fc;
  const bottom = q[2] + (q[3] - q[2]) * fc;
  return top + (bottom - top) * fr;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    LT_PROGRAM_AT,
    LT_CURSOR_JOIN,
    LT_CURSOR_CANARY,
    ltCursorInputs,
    ltCursorReads,
    ltCursorValue,
    ltAxisPosition,
    ltCursorCell,
  };
}
