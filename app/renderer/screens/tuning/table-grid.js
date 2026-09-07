/**
 * @file Tuning screen, table editor: the grid itself -- building the
 * <table> with editable axis breakpoints and cells, the spreadsheet-style
 * selection gestures, and painting values, heat and selection over it.
 */

/* exported tnTableBuildGrid, tnTableSelectRect, tnTablePaint, tnTableRefresh, tnTableFlashInfo, tnTableUpdateOpState */

/** Data column width in the grid: seven tabular digits. */
const TN_GRID_CELL_W = 72;
/** The row-axis column width. */
const TN_GRID_ROWHEAD_W = 64;
/** How long a transient toolbar message stays before the count returns. */
const TN_INFO_FLASH_MS = 1800;

/**
 * Replace the selection with the rectangle anchor..(r,c), optionally
 * unioned with whatever was selected before an additive drag began, then
 * repaint.
 * @param {TableModal} m
 * @param {number} r
 * @param {number} c
 * @param {boolean} additive
 * @returns {void}
 */
function tnTableSelectRect(m, r, c, additive) {
  if (!m.anchor) m.anchor = { r, c };
  const r0 = Math.min(m.anchor.r, r),
    r1 = Math.max(m.anchor.r, r);
  const c0 = Math.min(m.anchor.c, c),
    c1 = Math.max(m.anchor.c, c);
  m.sel.clear();
  if (additive && m.baseSel) for (const k of m.baseSel) m.sel.add(k);
  for (let rr = r0; rr <= r1; rr++) {
    for (let cc = c0; cc <= c1; cc++) m.sel.add(tnCellKey(rr, cc));
  }
  tnTablePaint(m);
}

/**
 * Transient message in the toolbar's info slot, then back to the count.
 * @param {TableModal} m
 * @param {string} msg
 * @returns {void}
 */
function tnTableFlashInfo(m, msg) {
  m.selInfo.textContent = msg;
  if (m.infoTimer) clearTimeout(m.infoTimer);
  m.infoTimer = setTimeout(() => tnTablePaint(m), TN_INFO_FLASH_MS);
}

/**
 * Enable/disable the undo and redo buttons to match the stacks.
 * @param {TableModal} m
 * @returns {void}
 */
function tnTableUpdateOpState(m) {
  const u = m.box.querySelector('.tn-op[data-op="undo"]');
  if (u) u.disabled = !m.invertible || !tuningState.history.length;
  const r = m.box.querySelector('.tn-op[data-op="redo"]');
  if (r) r.disabled = !m.invertible || !tuningState.redo.length;
}

/**
 * Re-decode and repaint after the image changed underneath us.
 * @param {TableModal} m
 * @returns {void}
 */
function tnTableRefresh(m) {
  m.t = window.XDF.decodeTable(m.item, tuningState.bin, m.h);
  m.xLabels = tnAxisLabels(m.t.x, m.t.cols, m.h);
  m.yLabels = tnAxisLabels(m.t.y, m.t.rows, m.h);
  for (const th of m.gridWrap.querySelectorAll('th[data-axis="x"]')) {
    const i = +th.dataset.i;
    const inp = th.querySelector('.tn-axis-cell');
    if (inp && inp !== document.activeElement)
      inp.value = m.xLabels[i] != null ? m.xLabels[i] : i;
  }
  for (const th of m.gridWrap.querySelectorAll('th[data-axis="y"]')) {
    const i = +th.dataset.i;
    const inp = th.querySelector('.tn-axis-cell');
    if (inp && inp !== document.activeElement)
      inp.value = m.yLabels[i] != null ? m.yLabels[i] : i;
  }
  tnTablePaint(m);
}

/**
 * Whether an engineering value sits inside the definition's limits.
 * @param {TableModal} m
 * @param {number} v
 * @returns {boolean}
 */
function tnTableInRange(m, v) {
  if (m.zLo != null && v < m.zLo) return false;
  if (m.zHi != null && v > m.zHi) return false;
  return true;
}

/**
 * Paint one cell's background and ink for the current mode.
 * @param {TableModal} m
 * @param {HTMLInputElement} inp
 * @param {number|null} v - The cell's value.
 * @param {number|null|undefined} b0 - The original value, when comparing.
 * @param {{ cmp: boolean, heatOn: boolean, lo: number, span: number, dMax: number }} mode
 * @returns {void}
 */
function tnPaintCellColour(m, inp, v, b0, mode) {
  if (mode.cmp) {
    // green = raised, red = lowered, transparent = untouched
    const d = v == null || b0 == null ? 0 : v - b0;
    if (d !== 0 && mode.dMax > 0) {
      const f = Math.min(1, Math.abs(d) / mode.dMax);
      inp.style.backgroundColor =
        d > 0
          ? `rgba(56, 224, 138, ${0.22 + 0.5 * f})`
          : `rgba(255, 66, 66, ${0.22 + 0.5 * f})`;
    } else {
      inp.style.backgroundColor = '';
    }
    inp.style.color = '';
  } else if (mode.heatOn && v != null && Number.isFinite(v)) {
    // Full-strength colour, the way every map editor paints a table: the
    // shape of the map is the thing you are judging, and a faint wash never
    // showed it. The ink flips to keep contrast on the bright middle of the
    // scale.
    const hc = heatColor((v - mode.lo) / mode.span);
    inp.style.backgroundColor = hc.bg;
    inp.style.color = hc.ink;
  } else {
    inp.style.backgroundColor = '';
    inp.style.color = '';
  }
}

/**
 * Repaint values, heat, "vs original" shading, selection and the axis
 * highlights. Runs on every selection change.
 * @param {TableModal} m
 * @returns {void}
 */
function tnTablePaint(m) {
  const t = m.t;
  const { lo, span } = tnCellBounds(t.cells);
  const heat = m.heatBox.checked;
  const cmp = !!(m.cmpBox.checked && m.baseTable);
  // For "vs original" the scale that matters is the size of the CHANGE, not
  // the size of the value, so it gets its own symmetric range: the largest
  // delta in either direction sets full saturation.
  const dMax = cmp ? tnMaxDelta(t.cells, m.baseTable.cells, t.rows, t.cols) : 0;
  const focused = document.activeElement;
  const tableEl = m.gridWrap.querySelector('.tn-table');
  const heatOn = !!(heat && !cmp && span > 0);
  if (tableEl) tableEl.classList.toggle('tn-heat-on', heatOn);
  if (m.heatScale) {
    m.heatScale.hidden = !heatOn;
    if (heatOn) {
      m.heatLo.textContent = fmtNum(lo, m.dp);
      m.heatHi.textContent = fmtNum(lo + span, m.dp);
    }
  }
  const mode = { cmp, heatOn, lo, span, dMax };
  for (const inp of m.gridWrap.querySelectorAll('.tn-cell')) {
    const r = +inp.dataset.r,
      c = +inp.dataset.c;
    const v = t.cells[r][c];
    // NEVER overwrite the cell the user is typing in. paint runs on every
    // selection change, and mousedown on another cell fires BEFORE this
    // one's blur -- so rewriting .value here silently threw away half-typed
    // input.
    if (inp !== focused) inp.value = v == null ? '' : fmtNum(v, m.dp);
    inp.classList.toggle('sel', m.sel.has(tnCellKey(r, c)));
    const b0 = cmp ? m.baseTable.cells[r] && m.baseTable.cells[r][c] : null;
    tnPaintCellColour(m, inp, v, b0, mode);
    // a cell sitting outside the definition's declared range is worth
    // flagging even when we did not put it there
    inp.classList.toggle(
      'tn-cell-oor',
      m.hasLimit && v != null && Number.isFinite(v) && !tnTableInRange(m, v)
    );
    if (cmp) {
      inp.title =
        v != null && b0 != null && v !== b0
          ? `was ${fmtNum(b0, m.dp)} · ${v - b0 > 0 ? '+' : ''}${fmtNum(v - b0, m.dp)}`
          : '';
    } else if (inp.title) inp.title = '';
  }
  // light up the breakpoints the selection sits under
  if (tableEl) {
    const selR = new Set();
    const selC = new Set();
    for (const k of m.sel) {
      const [r, c] = tnParseCellKey(k);
      selR.add(r);
      selC.add(c);
    }
    for (const th of tableEl.querySelectorAll('th[data-axis]')) {
      const on = (th.dataset.axis === 'x' ? selC : selR).has(+th.dataset.i);
      th.classList.toggle('tn-ax-hl', on);
    }
  }
  m.selInfo.textContent = m.sel.size
    ? `${m.sel.size} cell${m.sel.size === 1 ? '' : 's'} selected`
    : 'click, drag, or shift-click to select';
}

/**
 * Commit an edited axis breakpoint. AXIS EDITING: the X/Y breakpoints are
 * real values in the image just like the Z cells, and every established
 * tool lets you move them -- retuning a map for a bigger turbo usually
 * means restretching the load axis first.
 * @param {TableModal} m
 * @param {XdfAxis} axis
 * @param {number} index
 * @param {HTMLInputElement} input
 * @param {boolean} isX
 * @returns {void}
 */
function tnTableCommitAxis(m, axis, index, input, isX) {
  const v = Number(input.value);
  const labels = isX ? m.xLabels : m.yLabels;
  if (!Number.isFinite(v)) {
    input.value = labels[index] != null ? labels[index] : index;
    return;
  }
  // unchanged breakpoint: leave the bytes, the undo stack and the
  // changed-marker alone (same rule as the cell commit)
  const adp = axis.decimalpl != null ? axis.decimalpl : 0;
  const cur = window.XDF.decodeAxisPoint(axis, tuningState.bin, m.h, index);
  if (cur != null && fmtNum(v, adp) === fmtNum(cur, adp)) {
    input.value = fmtNum(cur, adp);
    return;
  }
  const enc = window.XDF.encodeAxisPoint(axis, m.h, index, v);
  if (!enc) {
    shake(input);
    return;
  }
  m.history.begin();
  m.history.write(enc.address, enc.bytes);
  m.history.end('axis edit');
  tnTableRefresh(m);
  const back = window.XDF.decodeAxisPoint(axis, tuningState.bin, m.h, index);
  input.value = back == null ? '' : fmtNum(back, adp);
  input.classList.add('tn-cell-edited');
}

/**
 * An axis header cell: an input when the axis is editable (it has an
 * address and an invertible MATH), else static text.
 * @param {TableModal} m
 * @param {XdfAxis|undefined} axis
 * @param {number} i - Breakpoint index.
 * @param {boolean} isX
 * @param {boolean} editable
 * @returns {HTMLTableCellElement}
 */
function tnAxisHeaderCell(m, axis, i, isX, editable) {
  const th = document.createElement('th');
  if (!isX) th.className = 'tn-rowhead';
  th.dataset.axis = isX ? 'x' : 'y';
  th.dataset.i = String(i);
  const labels = isX ? m.xLabels : m.yLabels;
  const label = labels[i] != null ? labels[i] : i;
  if (editable) {
    const ai = document.createElement('input');
    ai.type = 'text';
    ai.className = 'tn-axis-cell';
    ai.value = label;
    ai.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        ai.blur();
      }
    };
    ai.onblur = () => tnTableCommitAxis(m, axis, i, ai, isX);
    th.appendChild(ai);
  } else {
    th.textContent = label;
  }
  return th;
}

/**
 * One data cell with the SELECTION gestures, spreadsheet semantics:
 *
 *   click        -> select just that cell, clearing everything else
 *   drag         -> rectangular range from where the drag started
 *   shift-click  -> extend the rectangle from the existing anchor
 *   cmd/ctrl     -> add a cell (or a dragged rectangle) to what is there
 * @param {TableModal} m
 * @param {number} r
 * @param {number} c
 * @returns {HTMLTableCellElement}
 */
function tnGridCell(m, r, c) {
  const td = document.createElement('td');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tn-cell';
  input.dataset.r = String(r);
  input.dataset.c = String(c);
  input.disabled = !m.invertible || m.t.cells[r][c] == null;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      tnTableCommitCell(m, input);
    }
  };
  input.onblur = () => tnTableCommitCell(m, input);
  input.onmousedown = (e) => {
    if (e.button !== 0) return;
    // Commit whatever is being typed in ANOTHER cell first: mousedown beats
    // blur, so without this the pending edit is lost when the selection
    // repaints.
    const act = document.activeElement;
    if (
      act &&
      act !== input &&
      act.classList &&
      act.classList.contains('tn-cell')
    ) {
      tnTableCommitCell(m, act);
    }
    const add = e.metaKey || e.ctrlKey;
    if (e.shiftKey) {
      // extend from the existing anchor; never move it
      e.preventDefault();
      m.dragging = true;
      m.baseSel = add ? new Set(m.sel) : null;
      tnTableSelectRect(m, r, c, add);
      return;
    }
    // A plain mousedown starts a range and clears what was there. We do
    // NOT preventDefault: the cell must still take focus so a click can
    // be followed by typing. Selection only becomes visible once the
    // pointer moves (see onmouseenter), so a simple click-to-edit does
    // not paint a selection the user did not ask for.
    m.dragging = true;
    m.anchor = { r, c };
    m.baseSel = add ? new Set(m.sel) : null;
    if (!add) {
      m.sel.clear();
      tnTablePaint(m);
    }
  };
  input.onmouseenter = () => {
    if (m.dragging && m.anchor) tnTableSelectRect(m, r, c, !!m.baseSel);
  };
  // a click that never moved: select exactly this cell
  input.onclick = (e) => {
    if (e.shiftKey || e.metaKey || e.ctrlKey) return;
    if (m.sel.size > 1) return; // a drag just happened
    m.sel.clear();
    m.sel.add(tnCellKey(r, c));
    m.anchor = { r, c };
    tnTablePaint(m);
    // the cell keeps focus for typing; the proxy takes over only once
    // focus leaves it (see the window mouseup handler)
  };
  td.appendChild(input);
  return td;
}

/**
 * Build the grid once into m.gridWrap; tnTablePaint refreshes values, heat
 * and selection over it. Also installs the window mouseup handler that ends
 * a drag.
 * @param {TableModal} m
 * @returns {void}
 */
function tnTableBuildGrid(m) {
  const t = m.t;
  const table = document.createElement('table');
  table.className = 'tn-table tn-table-modal';
  // Fixed layout: the only way an input can fill its cell exactly (see the
  // GEOMETRY note in tuning.css). The grid takes the full width of the
  // dialog the way a map view does, the row-axis column stays 64px, the
  // data columns share the rest equally and never drop under 72px (seven
  // tabular digits) -- past that the pane scrolls sideways.
  table.style.tableLayout = 'fixed';
  table.style.width = '100%';
  const natural = TN_GRID_ROWHEAD_W + t.cols * TN_GRID_CELL_W;
  table.style.minWidth = `${natural}px`;
  // a table wider than the toolbar widens the dialog to fit it, up to the
  // viewport; beyond that the grid pane scrolls
  m.box.style.minWidth = `min(96vw, max(560px, ${natural + 2}px))`;
  const cg = document.createElement('colgroup');
  const c0 = document.createElement('col');
  c0.style.width = `${TN_GRID_ROWHEAD_W}px`;
  cg.appendChild(c0);
  for (let c = 0; c < t.cols; c++)
    cg.appendChild(document.createElement('col'));
  table.appendChild(cg);

  // An axis is editable when it has an address (values read from the image)
  // and an invertible MATH; label-only axes stay static text.
  const xEditable = !!(
    t.x &&
    t.x.embed &&
    t.x.embed.address &&
    window.XDF.invertLinear(t.x.mathEquation) !== null
  );
  const yEditable = !!(
    t.y &&
    t.y.embed &&
    t.y.embed.address &&
    window.XDF.invertLinear(t.y.mathEquation) !== null
  );

  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  const corner = document.createElement('th');
  corner.className = 'tn-corner';
  // name the axes where a printed map would: units when the definition
  // gives them, the bare axis letter when it does not. A 1-row or 1-col
  // table has only one axis worth naming.
  const xName = (t.x && t.x.units) || 'x';
  const yName = (t.y && t.y.units) || 'y';
  corner.innerHTML =
    (t.rows > 1 ? `<span class="tn-corner-y">${esc(yName)} ↓</span>` : '') +
    (t.cols > 1 ? `<span class="tn-corner-x">${esc(xName)} →</span>` : '');
  htr.appendChild(corner);
  for (let c = 0; c < t.cols; c++) {
    htr.appendChild(tnAxisHeaderCell(m, t.x, c, true, xEditable));
  }
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (let r = 0; r < t.rows; r++) {
    const tr = document.createElement('tr');
    tr.appendChild(tnAxisHeaderCell(m, t.y, r, false, yEditable));
    for (let c = 0; c < t.cols; c++) tr.appendChild(tnGridCell(m, r, c));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  m.gridWrap.appendChild(table);

  m.endDrag = () => {
    // fires on EVERY mouse-up in the window; only a drag that started on a
    // cell gets to move focus, or clicking the value box (or any button)
    // would lose focus the instant the mouse came up
    const wasDragging = m.dragging;
    m.dragging = false;
    m.baseSel = null;
    if (!wasDragging) return;
    // hand focus to the clipboard proxy so Cmd-C / Cmd-V, the arrow keys and
    // the step keys reach the grid straight after a drag-select. A range
    // means a real drag: take focus from the origin cell. A single cell is
    // a click, and keeps focus for typing.
    if (m.sel.size > 1) tnTableFocusProxy(m, true);
    else if (m.sel.size) tnTableFocusProxy(m, false);
  };
  window.addEventListener('mouseup', m.endDrag);
}
