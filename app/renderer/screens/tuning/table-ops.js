/**
 * @file Tuning screen: the pure arithmetic behind the table editor --
 * value bounds, engineering-unit limits, step sizes, interpolation and
 * smoothing over a selection, and the tab-separated clipboard format. No DOM
 * and no state: every function takes the decoded cells and returns results.
 */

/* exported tnCellBounds, tnEngineeringLimits, tnStepSizes, tnInterpolateH, tnInterpolateV, tnInterpolate2D, tnSmoothSelection, tnSelectionBounds, tnParseCellKey, tnCellKey, tnCellsTsv, tnParseTsvGrid, tnMaxDelta */

/**
 * @typedef {Object} SelBounds
 * The bounding rectangle of a selection, inclusive.
 * @property {number} r0
 * @property {number} r1
 * @property {number} c0
 * @property {number} c1
 */

/** @typedef {[number, number, number]} CellValue - [row, col, engineering value] */

/**
 * The "r,c" key a selection set holds for a cell.
 * @param {number} r
 * @param {number} c
 * @returns {string}
 */
function tnCellKey(r, c) {
  return r + ',' + c;
}

/**
 * The [row, col] a selection key names.
 * @param {string} k
 * @returns {[number, number]}
 */
function tnParseCellKey(k) {
  const i = k.indexOf(',');
  return [+k.slice(0, i), +k.slice(i + 1)];
}

/**
 * Lowest and highest finite cell value.
 * @param {(number|null)[][]} cells
 * @returns {{ lo: number, hi: number, span: number, count: number }} `count`
 *   is the number of finite cells; lo/hi are ±Infinity when it is zero.
 */
function tnCellBounds(cells) {
  let lo = Infinity,
    hi = -Infinity,
    count = 0;
  for (const row of cells) {
    for (const v of row) {
      if (v == null || !Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      count++;
    }
  }
  return { lo, hi, span: hi - lo, count };
}

/**
 * The definition's range limits for a table's Z axis, in ENGINEERING units.
 *
 * The XDF carries rangelow/rangehigh per axis; the encoder only enforces
 * what fits the storage type, which is a much wider net (a 1-byte cell
 * happily takes 255 when the definition says 0..100). Clamping to the
 * definition is what stops a bulk op from quietly writing nonsense.
 * XDFAXIS spells its limits <min>/<max> (XDFCONSTANT uses rangelow/
 * rangehigh); accept either so both shapes of definition are honoured.
 *
 * min/max are in the STORAGE domain (raw bytes), but every value the user
 * types and every cell shown is ENGINEERING (post-MATH). A table with math
 * "32 * X" and max 255 means 8160 rpm, not 255 rpm -- comparing a typed
 * 1600 rpm against a raw 255 clamped every cell to 255 (the "why is it 256"
 * bug). Convert the limits through the same math and take the true low/high,
 * since a subtractive equation (e.g. 0.375*X - 35.625) flips the ends. A
 * math failure falls back to the raw limits rather than blocking.
 * @param {XdfAxis} z
 * @returns {{ lo: number|null|undefined, hi: number|null|undefined }}
 */
function tnEngineeringLimits(z) {
  const rawLo = z.min != null ? z.min : z.rangelow;
  const rawHi = z.max != null ? z.max : z.rangehigh;
  let lo = rawLo;
  let hi = rawHi;
  if (
    (rawLo != null || rawHi != null) &&
    z.mathEquation &&
    window.XDF &&
    window.XDF.compileMath
  ) {
    try {
      const conv = window.XDF.compileMath(z.mathEquation);
      const ends = [];
      if (rawLo != null) ends.push(conv(rawLo));
      if (rawHi != null) ends.push(conv(rawHi));
      const finite = ends.filter((v) => Number.isFinite(v));
      if (finite.length) {
        lo = rawLo != null && rawHi != null ? Math.min(...finite) : lo;
        hi = rawLo != null && rawHi != null ? Math.max(...finite) : hi;
        // when only one end is given, map that one through
        if (rawLo != null && rawHi == null) {
          lo = Math.min(...finite);
          hi = null;
        }
        if (rawHi != null && rawLo == null) {
          hi = Math.max(...finite);
          lo = null;
        }
      }
    } catch (e) {
      /* keep the raw limits: better a wide clamp than none */
    }
  }
  return { lo, hi };
}

/**
 * STEP SIZE for the +/- keys. One raw LSB is the smallest change the image
 * can actually hold, so that is the fine step: derive it from the MATH by
 * measuring what one raw count is worth in engineering units. The coarse
 * step is a round 10x of that, floored at the display resolution so a press
 * always visibly moves the number rather than rounding away.
 * @param {XdfAxis} z
 * @param {number} dp - Display decimal places.
 * @returns {{ fine: number, coarse: number }}
 */
function tnStepSizes(z, dp) {
  let fine = Math.pow(10, -dp);
  try {
    const conv = window.XDF.compileMath(z.mathEquation);
    const slope = Math.abs(conv(1) - conv(0));
    if (Number.isFinite(slope) && slope > 0) fine = slope;
  } catch (e) {
    /* keep the display resolution */
  }
  return { fine, coarse: Math.max(fine * 10, Math.pow(10, -dp)) };
}

// ---- interpolation, smoothing -----------------------------------------------
//
// Interpolation is the operation every established tuning tool has and the
// one most used after typing a number. It fills the INTERIOR of a selection
// by walking a straight line between its edge cells. The line is drawn
// against the REAL AXIS VALUES where the axis is numeric, not against the
// cell index -- on a non-uniform axis (and RPM/load axes are never uniform)
// those give visibly different answers, and the axis one is the physically
// meaningful result.

/**
 * The numeric position of breakpoint `i`: its label when that is a number,
 * else the index.
 * @param {(string|null)[]|null} labels
 * @param {number} i
 * @returns {number}
 */
function tnAxisPos(labels, i) {
  const v = labels && labels[i] != null ? Number(labels[i]) : NaN;
  return Number.isFinite(v) ? v : i;
}

/**
 * Linear interpolation of y at x between (x1, y1) and (x2, y2).
 * @param {number} x
 * @param {number} x1
 * @param {number} x2
 * @param {number} y1
 * @param {number} y2
 * @returns {number}
 */
function tnLerp(x, x1, x2, y1, y2) {
  return x1 === x2 ? y1 : y1 + ((x - x1) * (y2 - y1)) / (x2 - x1);
}

/**
 * Horizontal: for each row of the selection, run the line from the leftmost
 * selected column to the rightmost, rewriting everything between.
 * @param {(number|null)[][]} cells
 * @param {(string|null)[]} xLabels
 * @param {SelBounds} b
 * @param {CellValue[]} out - Receives the new values.
 * @returns {void}
 */
function tnInterpolateH(cells, xLabels, b, out) {
  if (b.c1 - b.c0 < 2) return;
  for (let r = b.r0; r <= b.r1; r++) {
    const y1 = cells[r][b.c0],
      y2 = cells[r][b.c1];
    if (y1 == null || y2 == null) continue;
    const x1 = tnAxisPos(xLabels, b.c0),
      x2 = tnAxisPos(xLabels, b.c1);
    for (let c = b.c0 + 1; c < b.c1; c++) {
      if (cells[r][c] == null) continue;
      out.push([r, c, tnLerp(tnAxisPos(xLabels, c), x1, x2, y1, y2)]);
    }
  }
}

/**
 * Vertical: the same, down each column.
 * @param {(number|null)[][]} cells
 * @param {(string|null)[]} yLabels
 * @param {SelBounds} b
 * @param {CellValue[]} out
 * @returns {void}
 */
function tnInterpolateV(cells, yLabels, b, out) {
  if (b.r1 - b.r0 < 2) return;
  for (let c = b.c0; c <= b.c1; c++) {
    const y1 = cells[b.r0][c],
      y2 = cells[b.r1][c];
    if (y1 == null || y2 == null) continue;
    const x1 = tnAxisPos(yLabels, b.r0),
      x2 = tnAxisPos(yLabels, b.r1);
    for (let r = b.r0 + 1; r < b.r1; r++) {
      if (cells[r][c] == null) continue;
      out.push([r, c, tnLerp(tnAxisPos(yLabels, r), x1, x2, y1, y2)]);
    }
  }
}

/**
 * 2D: bilinear from the four CORNERS of the selection, which is what makes
 * "select a region, flatten it into a plane" a single action. (Running
 * vertical then horizontal reaches the same place; doing it in one pass
 * from the corners avoids depending on the order.)
 * @param {(number|null)[][]} cells
 * @param {(string|null)[]} xLabels
 * @param {(string|null)[]} yLabels
 * @param {SelBounds} b
 * @param {CellValue[]} out
 * @returns {void}
 */
function tnInterpolate2D(cells, xLabels, yLabels, b, out) {
  if (b.r1 - b.r0 < 1 || b.c1 - b.c0 < 1) return;
  const q11 = cells[b.r0][b.c0],
    q12 = cells[b.r0][b.c1];
  const q21 = cells[b.r1][b.c0],
    q22 = cells[b.r1][b.c1];
  if (q11 == null || q12 == null || q21 == null || q22 == null) return;
  const x1 = tnAxisPos(xLabels, b.c0),
    x2 = tnAxisPos(xLabels, b.c1);
  const y1 = tnAxisPos(yLabels, b.r0),
    y2 = tnAxisPos(yLabels, b.r1);
  for (let r = b.r0; r <= b.r1; r++) {
    for (let c = b.c0; c <= b.c1; c++) {
      if (r === b.r0 && c === b.c0) continue; // corners are the input
      if (r === b.r0 && c === b.c1) continue;
      if (r === b.r1 && c === b.c0) continue;
      if (r === b.r1 && c === b.c1) continue;
      if (cells[r][c] == null) continue;
      const top = tnLerp(tnAxisPos(xLabels, c), x1, x2, q11, q12);
      const bot = tnLerp(tnAxisPos(xLabels, c), x1, x2, q21, q22);
      out.push([r, c, tnLerp(tnAxisPos(yLabels, r), y1, y2, top, bot)]);
    }
  }
}

/**
 * Smooth: 3x3 neighbourhood average blended with the original by alpha.
 * Reads from a snapshot so the pass is simultaneous rather than cascading
 * across the selection, and only cells INSIDE the selection contribute or
 * move.
 * @param {(number|null)[][]} cells
 * @param {(r: number, c: number) => boolean} isSelected
 * @param {SelBounds} b
 * @param {CellValue[]} out
 * @param {number} alpha - 0 = unchanged, 1 = the plain average.
 * @returns {void}
 */
function tnSmoothSelection(cells, isSelected, b, out, alpha) {
  const src = cells.map((row) => row.slice());
  for (let r = b.r0; r <= b.r1; r++) {
    for (let c = b.c0; c <= b.c1; c++) {
      if (!isSelected(r, c) || src[r][c] == null) continue;
      let sum = 0,
        n = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr,
            cc = c + dc;
          if (rr < b.r0 || rr > b.r1 || cc < b.c0 || cc > b.c1) continue;
          const v = src[rr][cc];
          if (v == null || !Number.isFinite(v)) continue;
          sum += v;
          n++;
        }
      }
      if (!n) continue;
      out.push([r, c, src[r][c] * (1 - alpha) + (sum / n) * alpha]);
    }
  }
}

/**
 * The bounding box of a selection.
 * @param {Set<string>} keys - "r,c" keys.
 * @returns {SelBounds|null} null when nothing is selected.
 */
function tnSelectionBounds(keys) {
  if (!keys.size) return null;
  let r0 = Infinity,
    r1 = -Infinity,
    c0 = Infinity,
    c1 = -Infinity;
  for (const k of keys) {
    const [r, c] = tnParseCellKey(k);
    if (r < r0) r0 = r;
    if (r > r1) r1 = r;
    if (c < c0) c0 = c;
    if (c > c1) c1 = c;
  }
  return { r0, r1, c0, c1 };
}

/**
 * A rectangle of cells as TAB-SEPARATED VALUES, because that is what
 * spreadsheets speak. The BOUNDING BOX, because a rectangle is the only
 * shape a spreadsheet can represent; holes inside it carry their real
 * values rather than blanks.
 * @param {(number|null)[][]} cells
 * @param {SelBounds} b
 * @param {number} dp
 * @returns {{ text: string, rows: number, cols: number }}
 */
function tnCellsTsv(cells, b, dp) {
  const rows = [];
  for (let r = b.r0; r <= b.r1; r++) {
    const line = [];
    for (let c = b.c0; c <= b.c1; c++) {
      const v = (cells[r] || [])[c];
      line.push(v == null || !Number.isFinite(v) ? '' : fmtNum(v, dp));
    }
    rows.push(line.join('\t'));
  }
  return {
    text: rows.join('\n'),
    rows: b.r1 - b.r0 + 1,
    cols: b.c1 - b.c0 + 1,
  };
}

/**
 * Pasted text as a grid of raw cell strings (line and tab separated).
 * @param {string} text
 * @returns {string[][]}
 */
function tnParseTsvGrid(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\n+$/, '')
    .split('\n')
    .map((line) => line.split('\t'));
}

/**
 * The largest change in either direction between two tables, which sets full
 * saturation for the "vs original" shading.
 * @param {(number|null)[][]} cells
 * @param {(number|null)[][]} base
 * @param {number} rows
 * @param {number} cols
 * @returns {number}
 */
function tnMaxDelta(cells, base, rows, cols) {
  let dMax = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = cells[r][c],
        b0 = base[r] && base[r][c];
      if (a == null || b0 == null) continue;
      const d = Math.abs(a - b0);
      if (d > dMax) dMax = d;
    }
  }
  return dMax;
}
