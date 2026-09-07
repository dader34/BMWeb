/**
 * @file INPA mode: the canvas. One DOM row per screen row, each cell placed
 * at its column (padding with spaces), captions and values marked, lamps and
 * bars drawn inline at the column the script gave them.
 */

/** A logical line at least this tall (a fault entry) gets air above it. */
const IPO_BAND_MIN_ROWS = 3;

/** Columns a lamp's dot and spacing take beyond its word. */
const IPO_LAMP_EXTRA_COLS = 2;

/**
 * The cells of the grid by row, translated and width-kept. INPA's virtual
 * screen has as many logical lines as the script prints (a four-fault
 * freeze-frame list runs past 30 rows and INPA scrolls); the page scrolls
 * the same way, so nothing is cut off. A translated cell keeps the width
 * the script gave the German, so the columns INPA laid out stay put
 * ("Motordrehzahl" and its value at column 40 -> "Engine speed" padded to
 * the same width). A longer English pushes only its own row right.
 * @param {IpoProgram} p - the program
 * @returns {Map<number, Array<{col: number, text: string, kind: string, key: string|null, meta: IpoCellMeta|null}>>}
 */
function ipoGridRows(p) {
  const byRow = new Map();
  for (const c of p.cells.values()) {
    const r = Number(c.row),
      col = Number(c.col);
    if (!(r >= 0) || !(col >= 0)) continue;
    let text = ipoText(c.text);
    if (!text) continue;
    if (text !== c.text && text.length < c.text.length)
      text = text.padEnd(c.text.length);
    if (!byRow.has(r)) byRow.set(r, []);
    byRow.get(r).push({ col, text, kind: c.kind, key: c.key, meta: c.meta });
  }
  return byRow;
}

/**
 * One screen row's HTML: its cells in column order, a cell that starts
 * before the previous one ended still getting one space so overlapping
 * draws never merge into one word.
 * @param {Array<{col: number, text: string, kind: string, key: string|null, meta: IpoCellMeta|null}>} cells - the row's cells
 * @returns {string} HTML
 */
function ipoGridRowHtml(cells) {
  let out = '';
  let at = 0;
  for (const c of cells) {
    const gap = Math.max(c.col - at, at > 0 ? 1 : 0);
    out += ' '.repeat(gap);
    if (c.kind === 'lamp') {
      out += ipoLampHtml(c);
      at = c.col + c.text.length + IPO_LAMP_EXTRA_COLS;
      continue;
    }
    if (c.kind === 'gauge') {
      out += ipoGaugeHtml(c);
      at = c.col + IPO_GAUGE_COLS + c.text.length;
      continue;
    }
    const cls = c.kind === 'value' ? 'ipo-val' : 'ipo-cap';
    out += `<span class="${cls}"${c.key ? ` data-key="${esc(c.key)}"` : ''}>${esc(c.text)}</span>`;
    at = c.col + c.text.length;
  }
  // a value the script padded to its column width ends in blanks that
  // would only widen the row
  return out.replace(/\s+$/, '');
}

/**
 * Paint the INPA grid into the screen container.
 * @param {HTMLElement} gridEl - the screen container
 * @param {IpoProgram} p - the program
 * @returns {void}
 */
function ipoPaintGrid(gridEl, p) {
  const byRow = ipoGridRows(p);
  const rows = [...byRow.keys()].sort((a, b) => a - b);
  if (!rows.length) {
    gridEl.innerHTML = `<div class="ipo-empty">${esc(ipoText(p.title || ''))}</div>`;
    return;
  }
  const last = rows[rows.length - 1];
  const html = [];
  for (let r = 0; r <= last; r++) {
    const cells = (byRow.get(r) || []).sort((a, b) => a.col - b.col);
    // a logical line's first row gets a little air above it (the fault
    // list is one LINE per entry); the top of the screen needs none
    const band =
      r > 0 && p.bandTops && (p.bandTops.get(r) || 0) >= IPO_BAND_MIN_ROWS
        ? ' ipo-band'
        : '';
    if (!cells.length) {
      html.push(`<div class="ipo-row${band}">&nbsp;</div>`);
      continue;
    }
    html.push(`<div class="ipo-row${band}">${ipoGridRowHtml(cells)}</div>`);
  }
  gridEl.innerHTML = html.join('');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ipoPaintGrid };
}
