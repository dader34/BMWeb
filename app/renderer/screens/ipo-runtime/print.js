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
 * The keys the script offers on this menu, drawn as the F-key bar the app
 * shows under the screen: ten slots F1..F10 with the short caption, a
 * second row for the Shift keys when the menu has any, and the menu's own
 * legend text under a caption where it says more. Empty slots stay as
 * blank boxes, as on the bar.
 * @param {IpoProgram} p - the program
 * @returns {string} HTML, empty when the menu has no keys
 */
function ipoPrintKeysHtml(p, inpa) {
  const items = (p.items || []).filter((it) => it.nr !== 20);
  if (!items.length) return '';
  if (inpa) return ipoPrintInpaKeysHtml(p, items);
  const menu = ipoMenuTiles(p);
  const legend = new Map();
  for (const t of (menu && menu.tiles) || []) {
    if (t.legend) legend.set(`${t.shift ? 's' : ''}${t.nr}`, t.legend);
  }
  const byKey = new Map(items.map((it) => [it.nr, it]));
  const row = (shift) => {
    let any = false;
    const slots = [];
    for (let k = 1; k <= 10; k++) {
      const nr = shift ? IPO_SHIFT_BASE + k : k;
      const it = byKey.get(nr);
      const label = it ? ipoKeyLabel(p, it) : '';
      if (label) any = true;
      const lg = it ? legend.get(`${shift ? 's' : ''}${nr}`) : null;
      const sub =
        lg && ipoText(lg).trim() !== label.trim()
          ? `<span class="pr-fkey-s">${esc(ipoText(lg).trim())}</span>`
          : '';
      slots.push(
        `<span class="pr-fkey${label ? '' : ' empty'}">` +
          `<span class="pr-fkey-k">${shift ? '⇧' : ''}F${k}</span>` +
          `<span class="pr-fkey-l">${esc(label)}</span>${sub}</span>`
      );
    }
    return any ? `<div class="pr-fkeys">${slots.join('')}</div>` : '';
  };
  const plain = row(false);
  const shifted = row(true);
  if (!plain && !shifted) return '';
  return `<div class="pr-keys">${plain}${shifted}</div>`;
}

/**
 * The print document for the module view as it stands: what printDoc()
 * takes. Pure, so the harness can pin it without a printer.
 * @param {IpoProgram} p - the program
 * @param {EcuRecord} ecu - the module
 * @param {boolean} inpa - INPA layout (the text grid) rather than the modern rows
 * @returns {PrintDocOptions}
 */
/**
 * The key bar the way the INPA layout draws it on screen: a row of key
 * numbers over a row of flat boxes with the caption centred, and a Shift
 * row below when the menu has shifted keys.
 * @param {object} p - the running program
 * @param {object[]} items - the menu's keys (Shift+F10 excluded)
 * @returns {string} HTML
 */
function ipoPrintInpaKeysHtml(p, items) {
  const byKey = new Map(items.map((it) => [it.nr, it]));
  const row = (shift) => {
    let any = false;
    const nums = [];
    const btns = [];
    for (let k = 1; k <= 10; k++) {
      const it = byKey.get(shift ? IPO_SHIFT_BASE + k : k);
      const label = it ? ipoKeyLabel(p, it) : '';
      if (label) any = true;
      nums.push(`<span class="pr-ikey-num">${shift ? '⇧' : ''}F${k}</span>`);
      btns.push(
        `<span class="pr-ikey${label ? '' : ' empty'}">${esc(label)}</span>`
      );
    }
    return any
      ? `<div class="pr-ikeys"><div class="pr-ikey-nums">${nums.join('')}</div>` +
          `<div class="pr-ikey-btns">${btns.join('')}</div></div>`
      : '';
  };
  const plain = row(false);
  const shifted = row(true);
  if (!plain && !shifted) return '';
  return `<div class="pr-keys">${plain}${shifted}</div>`;
}

function ipoPrintDocument(p, ecu, inpa) {
  const title = ipoText(p.title || '') || p.menu || '';
  const sections = [];
  if (
    p.view &&
    p.view.report &&
    typeof ipoProtocolPrintSections === 'function'
  ) {
    // viewopen over a fault read: the scan report's tables, then INPA's text
    sections.push(...ipoProtocolPrintSections(p.view));
  } else if (p.view) {
    // viewopen: the file the script wrote
    sections.push({
      html: `<pre class="pr-screen">${esc((p.view.lines || []).join('\n'))}</pre>`,
    });
  } else if (inpa) {
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
  const keys = ipoPrintKeysHtml(p, inpa);
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

/**
 * Whether a printfile names the file the viewer is showing: the same path,
 * or the same text (the API's fault read and a save-as can leave the
 * script holding a different name for the same protocol).
 * @param {IpoProgram} p - the program
 * @param {string} name - the file name printfile passed
 * @param {string[]} lines - the file's lines
 * @returns {boolean}
 */
function ipoPrintFileIsView(p, name, lines) {
  const v = p.view;
  if (!v) return false;
  if (v.path && v.path === name) return true;
  const shown = v.lines || [];
  return (
    shown.length > 0 &&
    shown.length === lines.length &&
    shown.every((l, i) => l === lines[i])
  );
}

/**
 * The print document for INPA's printfile: the fault protocol as the
 * report's tables plus INPA's text when the file is the one the viewer
 * shows (what printscreen prints over that view), else the file's lines
 * as a monospace sheet. Pure, so the harness can pin it.
 * @param {IpoProgram} p - the program
 * @param {EcuRecord} ecu - the module
 * @param {string} name - the file's name
 * @param {string[]} lines - the file's lines
 * @returns {PrintDocOptions}
 */
function ipoPrintFileDocument(p, ecu, name, lines) {
  const isView = ipoPrintFileIsView(p, name, lines);
  const sections = [];
  if (
    isView &&
    p.view.report &&
    typeof ipoProtocolPrintSections === 'function'
  ) {
    sections.push(...ipoProtocolPrintSections(p.view));
  } else {
    sections.push({
      html: `<pre class="pr-screen">${esc((lines || []).join('\n'))}</pre>`,
    });
  }
  const subtitle =
    isView && p.view.title ? ipoText(p.view.title) : ipoText(p.title || '');
  return {
    title: ecu.label || ecu.sgbd,
    subtitle: subtitle || name,
    meta: [
      ecu.chassis ? ['Chassis', String(ecu.chassis).toUpperCase()] : null,
      ['SGBD', `${ecu.sgbd}.prg`],
      ['File', name],
      ['Printed', new Date().toLocaleString()],
    ],
    sections,
  };
}

/**
 * INPA's printfile for the module view: the clean sheet when the print
 * builder is loaded, nothing otherwise (the browser's own print would show
 * the screen, not the file).
 * @param {IpoProgram} p - the program
 * @param {EcuRecord} ecu - the module
 * @param {string} name - the file's name
 * @param {string[]} lines - the file's lines
 * @returns {Promise<void>}
 */
function ipoPrintFile(p, ecu, name, lines) {
  if (typeof printDoc === 'function') {
    return printDoc(ipoPrintFileDocument(p, ecu, name, lines));
  }
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
    ipoPrintFileDocument,
    ipoPrintFile,
  };
}
