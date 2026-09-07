/**
 * @file INPA's Print screen (the script's printscreen, the F9 key, Cmd/Ctrl+P
 * on a module view) as a clean sheet: the module and menu named at the top,
 * the screen as the car answered it, the keys the script offers, and no app
 * chrome. In INPA mode the sheet is the 80-column text grid, lamps and bars
 * spelled out; in modern mode it is the same rows as a caption / value /
 * unit table. Built on core/print.js, so it paginates and prints
 * black-on-white whatever theme the app wears.
 */

/** Columns of INPA's virtual screen the printed grid keeps. */
const IPO_PRINT_COLS = 80;

/**
 * One grid row as plain text: cells placed at their columns, a lamp as
 * "[x] word" / "[ ] word", a bar as its reading followed by the declared
 * scale.
 * @param {Array<{col: number, text: string, kind: string, meta: IpoCellMeta|null}>} cells - the row's cells, column order
 * @returns {string}
 */
function ipoPrintRowText(cells) {
  let out = '';
  for (const c of cells) {
    const gap = Math.max(c.col - out.length, out.length > 0 ? 1 : 0);
    out += ' '.repeat(gap);
    if (c.kind === 'lamp') {
      out += `[${ipoLampOn(c) ? 'x' : ' '}] ${ipoText(c.text).trim()}`;
    } else if (c.kind === 'gauge') {
      out += `${ipoText(c.text).trim()}${ipoPrintScale(c.meta)}`;
    } else {
      out += c.text;
    }
  }
  return out.replace(/\s+$/, '');
}

/**
 * A bar's declared scale for the sheet: " (min..max)" when it has one.
 * @param {IpoCellMeta|null} m - the cell's declaration
 * @returns {string}
 */
function ipoPrintScale(m) {
  if (
    !m ||
    m.min == null ||
    m.max == null ||
    !Number.isFinite(m.min) ||
    !Number.isFinite(m.max)
  )
    return '';
  return ` (${ipoScaleLabel(m.min)}..${ipoScaleLabel(m.max)})`;
}

/**
 * The INPA grid as text lines, top row to the last printed one, blank rows
 * kept so the layout INPA chose survives on paper.
 * @param {IpoProgram} p - the program
 * @returns {string[]}
 */
function ipoPrintGridText(p) {
  const byRow = ipoGridRows(p);
  const rows = [...byRow.keys()].sort((a, b) => a - b);
  if (!rows.length) return [];
  const last = rows[rows.length - 1];
  const out = [];
  for (let r = 0; r <= last; r++) {
    const cells = (byRow.get(r) || []).sort((a, b) => a.col - b.col);
    out.push(cells.length ? ipoPrintRowText(cells) : '');
  }
  // trailing blank rows only lengthen the sheet
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}

/**
 * A modern-mode cell as text for the sheet.
 * @param {{kind: string, text: string, meta: IpoCellMeta|null}} c - the cell
 * @returns {string}
 */
function ipoPrintCellText(c) {
  const text = ipoText(c.text).trim();
  if (c.kind === 'lamp') return `${ipoLampOn(c) ? '●' : '○'} ${text}`;
  if (c.kind === 'gauge') return `${text}${ipoPrintScale(c.meta)}`;
  return text;
}

/**
 * The modern rows as a caption / value / unit table, notes spanning the
 * width, a logical line's first row separated from the one before.
 * @param {IpoRow[]} rows - the rows (see ipoLineRows)
 * @returns {string} HTML
 */
function ipoPrintRowsHtml(rows) {
  if (!rows.length) return '';
  const body = rows
    .map((r, i) => {
      const cap = (r.parts || [r.caption])
        .map((t) => ipoText(t).replace(/\s*[:=]\s*$/, ''))
        .join('  ');
      const band = i > 0 && r.band ? ' class="pr-band"' : '';
      if (!r.cells.length) {
        return `<tr${band}><td colspan="3" class="pr-note">${esc(cap)}</td></tr>`;
      }
      const vals = r.cells.map(ipoPrintCellText).filter(Boolean).join('  ');
      return (
        `<tr${band}><td>${esc(cap)}</td>` +
        `<td class="pr-mono pr-num">${esc(vals)}</td>` +
        `<td class="pr-unit">${esc(r.trailer ? ipoText(r.trailer) : '')}</td></tr>`
      );
    })
    .join('');
  return `<table class="pr-table pr-screen-table"><tbody>${body}</tbody></table>`;
}

/**
 * The keys the script offers on this menu, as INPA's own legend reads.
 * @param {IpoProgram} p - the program
 * @returns {string} HTML, empty when the menu has no keys
 */
function ipoPrintKeysHtml(p) {
  const items = (p.items || []).filter((it) => it.nr !== 20);
  if (!items.length) return '';
  // a menu screen's own legend ("< F1 >  Digitalwerte") says more than the
  // key's short caption ("Digital"): both go on the sheet when it has one
  const menu = ipoMenuTiles(p);
  const legend = new Map();
  for (const t of (menu && menu.tiles) || []) {
    if (t.legend) legend.set(`${t.shift ? 's' : ''}${t.nr}`, t.legend);
  }
  const rows = items
    .map((it) => {
      const key = it.shift ? `Shift+F${it.nr - IPO_SHIFT_BASE}` : `F${it.nr}`;
      const label = ipoKeyLabel(p, it);
      if (!label) return '';
      const lg = legend.get(`${it.shift ? 's' : ''}${it.nr}`);
      const more =
        lg && ipoText(lg).trim() !== label.trim()
          ? `<td class="pr-legend">${esc(ipoText(lg).trim())}</td>`
          : '<td></td>';
      return `<tr><td class="pr-mono">${esc(key)}</td><td>${esc(label)}</td>${more}</tr>`;
    })
    .filter(Boolean)
    .join('');
  if (!rows) return '';
  return (
    `<h2 class="pr-h2">Keys</h2>` +
    `<table class="pr-table pr-keys"><tbody>${rows}</tbody></table>`
  );
}

/**
 * The print document for the module view as it stands: what printDoc()
 * takes. Pure, so the harness can pin it without a printer.
 * @param {IpoProgram} p - the program
 * @param {EcuRecord} ecu - the module
 * @param {boolean} inpa - INPA layout (the text grid) rather than the modern rows
 * @returns {PrintDocOptions}
 */
function ipoPrintDocument(p, ecu, inpa) {
  const title = ipoText(p.title || '') || p.menu || '';
  const sections = [];
  if (inpa) {
    const lines = ipoPrintGridText(p);
    if (lines.length) {
      sections.push({
        html: `<pre class="pr-screen">${esc(lines.join('\n'))}</pre>`,
      });
    }
  } else {
    const menu = ipoMenuTiles(p);
    const rows = menu && menu.tiles.length ? menu.rest : ipoLineRows(p);
    const html = ipoPrintRowsHtml(rows);
    if (html) sections.push({ html });
  }
  const keys = ipoPrintKeysHtml(p);
  if (keys) sections.push({ html: keys, avoidBreak: true });
  if (!sections.length) {
    sections.push({
      html: `<p class="pr-p">${esc(title || 'Nothing on screen yet.')}</p>`,
    });
  }
  const meta = [
    ecu.chassis ? ['Chassis', String(ecu.chassis).toUpperCase()] : null,
    ['SGBD', `${ecu.sgbd}.prg`],
    p.menu ? ['Menu', p.menu] : null,
    p.screen ? ['Screen', p.screen] : null,
    ['Printed', new Date().toLocaleString()],
  ];
  return {
    title: ecu.label || ecu.sgbd,
    subtitle: title,
    meta,
    sections,
    landscape:
      inpa && ipoPrintGridText(p).some((l) => l.length > IPO_PRINT_COLS),
  };
}

/**
 * INPA's printscreen for the module view: the clean sheet when the print
 * builder is loaded, the browser's own print otherwise.
 * @param {IpoProgram} p - the program
 * @param {EcuRecord} ecu - the module
 * @param {boolean} inpa - INPA layout
 * @returns {Promise<void>}
 */
function ipoPrintScreen(p, ecu, inpa) {
  if (typeof printDoc === 'function') {
    return printDoc(ipoPrintDocument(p, ecu, inpa));
  }
  if (typeof window !== 'undefined' && typeof window.print === 'function')
    window.print();
  return Promise.resolve();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    IPO_PRINT_COLS,
    ipoPrintGridText,
    ipoPrintRowsHtml,
    ipoPrintKeysHtml,
    ipoPrintDocument,
    ipoPrintScreen,
  };
}
