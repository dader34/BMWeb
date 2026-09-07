/**
 * @file The modern skin: the same cycle's emissions grouped the way the
 * script wrote them -- one row per LINE block -- and a menu's backdrop
 * legend shown as the function-group tiles the app has always used. Nothing
 * here decides what a line means: a row exists because the program painted
 * it this cycle, keyed by the result the script bound.
 */

/**
 * INPA's key-legend notation as a menu's backdrop prints it: "< F4 >
 * Fehlerspeicher lesen", "< Shift > + < F6 >  EWS". Group 1 = the Shift
 * prefix, 2 = the key number, 3 = the caption.
 * @type {RegExp}
 */
const IPO_KEY_LEGEND =
  /^\s*(<\s*Shift\s*>\s*\+\s*)?<\s*F\s*(\d+)\s*>\s*(\S.*)$/i;

/** How many tiles enter with a stagger before the animation is skipped. */
const IPO_TILE_STAGGER = 20;

/**
 * One row of the modern skin.
 * @typedef {object} IpoRow
 * @property {string} caption - the caption pieces joined
 * @property {string[]} parts - the caption pieces as printed
 * @property {IpoRowCell[]} cells - the value/lamp/gauge cells
 * @property {string} trailer - text printed after the values (a unit)
 * @property {boolean} band - first row of its logical line
 */

/**
 * A cell of a modern row.
 * @typedef {object} IpoRowCell
 * @property {'text'|'value'|'lamp'|'gauge'} kind - what drew it
 * @property {string|null} key - the result key
 * @property {string} text - the text
 * @property {string} [on] - a lamp's TrueText
 * @property {string} [off] - a lamp's FalseText
 * @property {IpoCellMeta|null} meta - the instrument's declaration
 */

/**
 * A menu shown as tiles.
 * @typedef {object} IpoMenuTiles
 * @property {Array<{nr: number, shift: boolean, label: string, legend: string, cat: string}>} tiles - one per key
 * @property {IpoRow[]} rest - the rows that were not legend lines
 */

/**
 * The rows of the last cycle, one per LINE block (a LINE that prints several
 * screen rows is several rows here too: INPA laid them out one under the
 * other). Within a row the text elements before the first value are its
 * caption, the value/lamp/gauge elements are its cells, text after a value
 * is a unit or trailer. A row with only text is a note -- unless it was
 * printed in two or more pieces at different columns, which is a caption
 * and its value (ZKE5's info screen: "Rework program" at column 0, ":" at
 * 33, the name at 35 -- copied into strings at startup and printed with
 * ftextout). The first piece is the caption, a lone ":" is dropped, the
 * rest are the value.
 * @param {IpoProgram} p - the program (its lines and cells)
 * @returns {IpoRow[]}
 */
function ipoLineRows(p) {
  const rows = [];
  for (const ln of p.lines || []) {
    const els = (ln.elements || [])
      .filter((el) => el.row != null && el.col != null)
      .sort((a, b) => a.row - b.row || a.col - b.col);
    if (!els.length) continue;
    const cellOf = (el) => p.cells.get(`${el.row}:${el.col}`);
    const byRow = new Map();
    for (const el of els) {
      if (!byRow.has(el.row)) byRow.set(el.row, []);
      byRow.get(el.row).push(el);
    }
    let first = true;
    for (const group of byRow.values()) {
      const caption = [];
      const cells = [];
      const trailer = [];
      for (const el of group) {
        const c = cellOf(el);
        const text = c ? c.text : '';
        if (el.t === 'text') {
          if (!text.trim()) continue;
          (cells.length ? trailer : caption).push(text.trim());
        } else {
          cells.push({
            kind: el.t,
            key: el.key || null,
            text,
            on: el.on,
            off: el.off,
            meta: c ? c.meta : null,
          });
        }
      }
      if (!caption.length && !cells.length) continue;
      if (
        !cells.length &&
        caption.length >= 2 &&
        !IPO_KEY_LEGEND.test(caption[0])
      ) {
        const rest = caption.slice(1).filter((t) => t !== ':');
        if (rest.length) {
          for (const t of rest)
            cells.push({ kind: 'text', key: null, text: t, meta: null });
          caption.length = 1;
        }
      }
      rows.push({
        caption: caption.join('  '),
        parts: caption,
        cells,
        trailer: trailer.join(' '),
        band: first, // first row of its logical line
      });
      first = false;
    }
  }
  return rows;
}

/**
 * A tile's category class from the SGBD job the key's body sends (a fixed
 * vocabulary), never from the caption.
 * @param {string|null|undefined} job - job name
 * @returns {string}
 */
function ipoJobCategory(job) {
  if (!job) return '';
  if (/^(FS|IS|HS)_/i.test(job)) return 'gt-fault';
  if (/^(STATUS|MESSWERT)/i.test(job)) return 'gt-live';
  if (/^(STEUERN|START)/i.test(job)) return 'gt-act';
  if (/IDENT|^INFO$/i.test(job)) return 'gt-info';
  if (/COD|ADAPT|ABGLEICH/i.test(job)) return 'gt-code';
  return '';
}

/**
 * nr -> the caption the current screen printed for that key in its legend.
 * @param {IpoProgram} p - the program
 * @param {string[]|null} [notes] - collects the caption pieces that are not legend lines
 * @returns {Map<number, string>}
 */
function ipoLegendMap(p, notes) {
  const legend = new Map();
  for (const r of ipoLineRows(p)) {
    for (const t of r.parts || []) {
      const m = t.match(IPO_KEY_LEGEND);
      if (!m) {
        if (notes) notes.push(t);
        continue;
      }
      const nr = Number(m[2]) + (m[1] ? IPO_SHIFT_BASE : 0);
      if (!legend.has(nr)) legend.set(nr, m[3].trim());
    }
  }
  return legend;
}

/**
 * A menu's backdrop as tiles: one per ITEM the script declared, captioned
 * by the ITEM's own short label, described by the legend line the screen
 * printed for that key. A screen that prints no legend is a readout, drawn
 * as rows (null). ZKE5's main screen prints BOTH -- the part number and
 * build date above the legend -- so those rows stay rows (`rest`) and the
 * legend becomes the tiles.
 * @param {IpoProgram} p - the program
 * @returns {IpoMenuTiles|null}
 */
function ipoMenuTiles(p) {
  const rows = ipoLineRows(p);
  const legend = ipoLegendMap(p, null);
  if (!legend.size) return null;
  const items = (p.items || []).filter((it) => !it.hidden || legend.has(it.nr));
  if (!items.length || !items.some((it) => legend.has(it.nr))) return null;
  const rest = rows.filter(
    (r) => !(r.parts || []).some((t) => IPO_KEY_LEGEND.test(t))
  );
  const toks = p.exec && p.exec.procs ? p.exec.procs[p.menu] : null;
  const tiles = items.map((it) => {
    let cat = '';
    if (toks && typeof irItemBodyJobs === 'function') {
      const jobs = irItemBodyJobs(p.exec, toks, it.start, it.end) || [];
      for (const j of jobs) {
        cat = ipoJobCategory(j);
        if (cat) break;
      }
    }
    return {
      nr: it.nr,
      shift: !!it.shift,
      label: it.label || legend.get(it.nr) || '',
      legend: legend.get(it.nr) || '',
      cat: cat || 'gt-default',
    };
  });
  return { tiles, rest };
}

/**
 * Paint a menu's tiles. A backdrop screen can be frequent: the cycle
 * repaints every tick. The tiles are rebuilt (and their entrance animation
 * replayed) only when what they show changed, else the grid is left exactly
 * as it is.
 * @param {HTMLElement} gridEl - the screen container
 * @param {IpoProgram} p - the program
 * @param {IpoMenuTiles} menu - the tiles to draw
 * @returns {void}
 */
function ipoPaintTiles(gridEl, p, menu) {
  const sig = JSON.stringify([p.menu, menu.tiles, menu.rest]);
  if (gridEl._ipoTilesSig === sig) return;
  gridEl._ipoTilesSig = sig;
  const notes = ipoRowsHtml(menu.rest);
  const grid = document.createElement('div');
  grid.className = 'group-grid stagger';
  for (const t of menu.tiles) {
    const tile = document.createElement('div');
    tile.className = `group-tile ${t.cat}`;
    const fk = `${t.shift ? 'Shift+' : ''}F${t.nr > IPO_SHIFT_BASE ? t.nr - IPO_SHIFT_BASE : t.nr}`;
    const name = ipoText(t.label);
    const desc = t.legend ? ipoText(t.legend) : '';
    tile.innerHTML =
      `<div class="group-header-row"><span class="group-fkey">${esc(fk)}</span></div>` +
      `<div class="group-name">${esc(name)}</div>` +
      `<div class="group-count">${esc(desc !== name ? desc : '')}</div>` +
      `<div class="group-arrow">→</div>`;
    tile.onclick = () => p.press(t.nr);
    grid.appendChild(tile);
  }
  gridEl.classList.add('ipo-tiles');
  gridEl.innerHTML = notes ? `<div class="ipo-notes">${notes}</div>` : '';
  gridEl.appendChild(grid);
  if (typeof stagger === 'function') stagger(grid, IPO_TILE_STAGGER);
}

/**
 * Paint the modern skin: a menu's tiles when the screen printed a legend,
 * else the LINE rows; a screen func that printed without LINE blocks (a
 * userbox, a banner) falls back to its rows of text in order.
 * @param {HTMLElement} gridEl - the screen container
 * @param {IpoProgram} p - the program
 * @returns {void}
 */
function ipoPaintLines(gridEl, p) {
  const menu = ipoMenuTiles(p);
  if (menu) {
    ipoPaintTiles(gridEl, p, menu);
    return;
  }
  gridEl._ipoTilesSig = null;
  gridEl.classList.remove('ipo-tiles');
  const rows = ipoLineRows(p);
  if (!rows.length) {
    const texts = [...p.cells.values()]
      .filter((c) => c.text && c.text.trim())
      .sort((a, b) => a.row - b.row || a.col - b.col);
    if (!texts.length) {
      gridEl.innerHTML = `<div class="ipo-empty">${esc(ipoText(p.title || ''))}</div>`;
      return;
    }
    const byRow = new Map();
    for (const c of texts) {
      if (!byRow.has(c.row)) byRow.set(c.row, []);
      byRow.get(c.row).push(ipoText(c.text).trim());
    }
    gridEl.innerHTML = [...byRow.values()]
      .map(
        (parts) =>
          `<div class="ipo-line ipo-line-note">${esc(parts.join(' '))}</div>`
      )
      .join('');
    return;
  }
  gridEl.innerHTML = ipoRowsHtml(rows);
}

/**
 * The modern rows' HTML (see ipoLineRows). A logical line's first row gets
 * air above it (one LINE per fault); a row with no caption is the value
 * itself (a fault's own header row).
 * @param {IpoRow[]} rows - the rows
 * @returns {string} HTML
 */
function ipoRowsHtml(rows) {
  const html = [];
  const capHtml = (parts) =>
    parts
      .map((t) => esc(ipoText(t).replace(/\s*[:=]\s*$/, '')))
      .join('<span class="ipo-line-gap"></span>');
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const cap = capHtml(r.parts || [r.caption]);
    const band = i > 0 && r.band ? ' ipo-band' : '';
    if (!r.cells.length) {
      html.push(`<div class="ipo-line ipo-line-note${band}">${cap}</div>`);
      continue;
    }
    const cells = r.cells
      .map((c) => {
        const text = ipoText(c.text);
        const key = c.key ? ` data-key="${esc(c.key)}"` : '';
        if (c.kind === 'lamp') return ipoLampHtml(c);
        if (c.kind === 'gauge') return ipoGaugeHtml(c);
        return `<span class="ipo-line-val ipo-${c.kind}"${key}>${esc(text.trim())}</span>`;
      })
      .join('');
    const unit = r.trailer
      ? `<span class="ipo-line-unit">${esc(ipoText(r.trailer))}</span>`
      : '';
    const nocap = r.parts && r.parts.length ? '' : ' ipo-nocap';
    html.push(
      `<div class="ipo-line${band}${nocap}">` +
        `<span class="ipo-line-cap">${cap}</span>` +
        `<span class="ipo-line-cells">${cells}${unit}</span>` +
        `</div>`
    );
  }
  return html.join('');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    IPO_KEY_LEGEND,
    ipoLineRows,
    ipoJobCategory,
    ipoLegendMap,
    ipoMenuTiles,
    ipoPaintTiles,
    ipoPaintLines,
    ipoRowsHtml,
  };
}
