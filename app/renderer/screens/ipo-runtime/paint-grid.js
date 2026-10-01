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
    const empty = `<div class="ipo-empty">${esc(ipoText(p.title || ''))}</div>`;
    if (gridEl._ipoHtml !== empty) {
      gridEl._ipoHtml = empty;
      gridEl.innerHTML = empty;
    }
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
  // DO NOT REBUILD A SCREEN THAT DID NOT CHANGE. A frequent screen repaints
  // every cycle, and replacing the markup destroys the node under the
  // pointer -- the hover wash dropped and came back a second later, which
  // read as a flashing highlight. Values that really changed still repaint;
  // an identical frame is left alone, so the hover survives it.
  const next = html.join('');
  if (gridEl._ipoHtml === next) return;
  gridEl._ipoHtml = next;
  gridEl.innerHTML = next;
  ipoWireScreenKeys(gridEl, p);
}

/**
 * The key legend a script prints into its own screen: "< F4 >  Read fault
 * memory", and the shifted form "< Shift > + < F6 >  EWS start value
 * matching". INPA's own screens are read with the keyboard, but the rows
 * are sitting right there under the pointer, so make them do what the key
 * does -- the same p.press() the F-key bar and the keyboard call.
 *
 * The row's TEXT is untouched: the legend keeps the columns the script laid
 * out. Only a span around the "< Fn >" token becomes a button, so a row
 * that merely mentions a key in prose is not turned into a control.
 * @type {RegExp}
 */
const IPO_SCREEN_KEY_RE =
  /(&lt;\s*Shift\s*&gt;\s*\+\s*)?&lt;\s*F(\d{1,2})\s*&gt;/gi;

/**
 * Make every "< Fn >" the script printed into the screen clickable.
 * @param {HTMLElement} gridEl - the painted grid
 * @param {IpoProgram} p - the program, for press()
 * @returns {void}
 */
function ipoWireScreenKeys(gridEl, p) {
  if (!p || typeof p.press !== 'function') return;
  const shiftBase = typeof IPO_SHIFT_BASE === 'number' ? IPO_SHIFT_BASE : 10;
  for (const cap of gridEl.querySelectorAll('.ipo-cap')) {
    const html = cap.innerHTML;
    if (!/&lt;\s*F\d/i.test(html)) continue;
    // A LEGEND IS THE KEY *AND* ITS LABEL. "< F4 >  Read fault memory" reads
    // as one thing and should behave as one: the whole span up to the next
    // legend (or the end of the line) becomes the target, so the words are
    // as clickable as the number. Two legends on a row each keep their own
    // half -- "< F6 > Actuator activations" and "< Shift > + < F6 > EWS
    // start value matching" light and fire separately.
    IPO_SCREEN_KEY_RE.lastIndex = 0;
    const hits = [];
    for (
      let m = IPO_SCREEN_KEY_RE.exec(html);
      m;
      m = IPO_SCREEN_KEY_RE.exec(html)
    ) {
      const nr = Number(m[2]) + (m[1] ? shiftBase : 0);
      // only a key the running screen actually offers: a legend for a key
      // this menu does not carry must stay plain text
      if ((p.items || []).some((it) => it.nr === nr))
        hits.push({ start: m.index, end: m.index + m[0].length, nr });
    }
    if (!hits.length) continue;
    let next = '';
    let at = 0;
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      // the label runs to the next legend, or to the end of the row
      const stop = i + 1 < hits.length ? hits[i + 1].start : html.length;
      next += html.slice(at, h.start);
      const body = html.slice(h.start, stop);
      // trailing run-out stays outside the button so the underline/wash
      // stops with the words rather than running to the window edge
      const tail = (body.match(/\s+$/) || [''])[0];
      const label = tail ? body.slice(0, -tail.length) : body;
      next += `<button type="button" class="ipo-key" data-nr="${h.nr}">${label}</button>${tail}`;
      at = stop;
    }
    next += html.slice(at);
    if (next !== html) cap.innerHTML = next;
  }
  for (const b of gridEl.querySelectorAll('.ipo-key')) {
    b.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      p.press(Number(b.dataset.nr));
    };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ipoPaintGrid, ipoWireScreenKeys };
}
