/**
 * @file Tuning screen, table editor: everything that changes cells --
 * committing a typed value, the bulk set / offset / scale buttons,
 * interpolate / smooth / revert, the tab-separated clipboard, and the
 * keyboard shortcuts. Every write goes through the dialog's edit history so
 * it can be undone.
 */

/* exported tnTableApplyCell, tnTableCommitCell, tnTableWireTools, tnTableRunOp, tnTableWireClipboard, tnTableFocusProxy, tnTableOnKey */

/** The smoothing blend: half original, half neighbourhood average. */
const TN_SMOOTH_ALPHA = 0.5;

/**
 * One cell <- engineering value, via the same encoder the inline editor
 * uses. Clamps to the definition's range rather than rejecting, so a bulk
 * op over a selection does something sane at the edges instead of leaving
 * a ragged hole where cells refused to move; a single typed cell reports
 * the clamp so the user is never lied to.
 * @param {TableModal} m
 * @param {number} r
 * @param {number} c
 * @param {number} v
 * @param {{ strict?: boolean }} [opts] - `strict` refuses instead of clamping.
 * @returns {{ ok: boolean, clamped: boolean }}
 */
function tnTableApplyCell(m, r, c, v, opts) {
  let val = v;
  let clamped = false;
  if (m.zLo != null && val < m.zLo) {
    val = m.zLo;
    clamped = true;
  }
  if (m.zHi != null && val > m.zHi) {
    val = m.zHi;
    clamped = true;
  }
  if (clamped && opts && opts.strict) return { ok: false, clamped: true };
  const enc = window.XDF.encodeTableCell(m.item, m.h, r, c, val);
  if (!enc) return { ok: false, clamped };
  return { ok: m.history.write(enc.address, enc.bytes), clamped };
}

/**
 * Commit a typed cell value on Enter or blur.
 * @param {TableModal} m
 * @param {HTMLInputElement} input
 * @returns {void}
 */
function tnTableCommitCell(m, input) {
  const r = Number(input.dataset.r),
    c = Number(input.dataset.c);
  const v = Number(input.value);
  const dp = m.dp;
  const cur = m.t.cells[r][c];
  if (!Number.isFinite(v)) {
    input.value = fmtNum(cur, dp);
    return;
  }
  // Nothing typed: a click that focused the cell and a blur that left it
  // is not an edit. Writing the same bytes back would still add an undo
  // step and mark the cell changed.
  if (cur != null && fmtNum(v, dp) === fmtNum(cur, dp)) {
    input.value = fmtNum(cur, dp);
    return;
  }
  m.history.begin();
  const res = tnTableApplyCell(m, r, c, v);
  m.history.end('cell edit');
  if (!res.ok) {
    shake(input);
    return;
  }
  if (res.clamped)
    tnTableFlashInfo(
      m,
      `clamped to ${fmtNum(m.zLo != null && v < m.zLo ? m.zLo : m.zHi, dp)}`
    );
  m.t = window.XDF.decodeTable(m.item, tuningState.bin, m.h);
  tnTablePaint(m);
  // paint deliberately skips the focused cell, so refresh this one by
  // hand: the value it shows should be what the ECU will actually hold
  // (quantised by the MATH equation), not the raw text that was typed.
  const back = m.t.cells[r][c];
  input.value = back == null ? '' : fmtNum(back, dp);
  input.classList.add('tn-cell-edited');
  // Say so when the stored value is not the typed one: the cell holds a
  // raw integer, so only multiples of the MATH slope exist, and "4" in
  // a 0.375-degree map can only be 4.125. Silent snapping read as a bug.
  if (
    !res.clamped &&
    back != null &&
    Math.abs(back - v) > Math.pow(10, -dp) / 2
  ) {
    tnTableFlashInfo(
      m,
      `${fmtNum(v, dp)} stored as ${fmtNum(back, dp)} · this map's resolution is ${fmtNum(m.fineStep, Math.max(dp, 2))}${m.t.z.units ? ' ' + m.t.z.units : ''}`
    );
  }
}

/**
 * Apply a list of [r, c, value] as one undo step, then refresh.
 * @param {TableModal} m
 * @param {CellValue[]} values
 * @param {string} label - The undo label.
 * @returns {{ n: number, clamped: number }} Cells written and cells clamped.
 */
function tnTableApplyMany(m, values, label) {
  let n = 0,
    clamped = 0;
  m.history.begin();
  for (const [r, c, v] of values) {
    const res = tnTableApplyCell(m, r, c, v);
    if (res.ok) n++;
    if (res.clamped) clamped++;
  }
  m.history.end(label);
  tnTableRefresh(m);
  return { n, clamped };
}

/**
 * The selected cells with their current finite values, as [r, c, value].
 * @param {TableModal} m
 * @returns {CellValue[]}
 */
function tnSelectedValues(m) {
  const out = [];
  for (const k of m.sel) {
    const [r, c] = tnParseCellKey(k);
    const cur = m.t.cells[r][c];
    if (cur == null || !Number.isFinite(cur)) continue;
    out.push([r, c, cur]);
  }
  return out;
}

/**
 * Wire the toolbar: BULK OPS over the selection (set: absolute, add: +/-
 * delta, scale: percentage of current -- the reason a modal earns its
 * place), the op buttons, and the heat / vs-original checkboxes.
 * @param {TableModal} m
 * @returns {void}
 */
function tnTableWireTools(m) {
  m.box.querySelectorAll('.tn-bulk').forEach((b) => {
    b.onclick = () => {
      const raw = Number(m.bulkVal.value);
      if (!Number.isFinite(raw)) {
        shake(m.bulkVal);
        return;
      }
      const op = b.dataset.op;
      if (!m.sel.size) {
        shake(m.bulkVal); // never touch the whole table by accident
        return;
      }
      const values = tnSelectedValues(m).map(([r, c, cur]) => [
        r,
        c,
        op === 'set' ? raw : op === 'add' ? cur + raw : cur * (1 + raw / 100),
      ]);
      const { n, clamped } = tnTableApplyMany(
        m,
        values,
        op === 'set' ? 'set' : op === 'add' ? 'offset' : 'scale'
      );
      if (!n) shake(m.bulkVal);
      else if (clamped)
        tnTableFlashInfo(m, `${n} cells · ${clamped} clamped to range`);
    };
  });

  m.box.querySelectorAll('.tn-op').forEach((b) => {
    b.onclick = () => tnTableRunOp(m, b.dataset.op);
  });
  tnTableUpdateOpState(m);
  m.cmpBox.onchange = () => tnTablePaint(m);
  m.heatBox.onchange = () => tnTablePaint(m);
}

/**
 * Revert the selection to the values the file loaded with.
 * @param {TableModal} m
 * @param {SelBounds} b
 * @returns {void}
 */
function tnTableRevert(m, b) {
  if (!m.baseTable) {
    tnTableFlashInfo(m, 'no original to revert to');
    return;
  }
  const values = [];
  for (let r = b.r0; r <= b.r1; r++) {
    for (let c = b.c0; c <= b.c1; c++) {
      if (!m.sel.has(tnCellKey(r, c))) continue;
      const was = m.baseTable.cells[r] && m.baseTable.cells[r][c];
      if (was == null || !Number.isFinite(was)) continue;
      values.push([r, c, was]);
    }
  }
  const { n } = tnTableApplyMany(m, values, 'revert');
  tnTableFlashInfo(
    m,
    n ? `reverted ${n} cell${n === 1 ? '' : 's'}` : 'nothing to revert'
  );
}

/**
 * Run a toolbar / shortcut operation.
 * @param {TableModal} m
 * @param {string} op - undo | redo | revert | interp-h | interp-v | interp-2d | smooth
 * @returns {void}
 */
function tnTableRunOp(m, op) {
  if (!m.invertible) return;
  if (op === 'undo') {
    if (!m.history.undo()) tnTableFlashInfo(m, 'nothing to undo');
    return;
  }
  if (op === 'redo') {
    if (!m.history.redo()) tnTableFlashInfo(m, 'nothing to redo');
    return;
  }
  const b = tnSelectionBounds(m.sel);
  if (!b) {
    tnTableFlashInfo(m, 'select some cells first');
    return;
  }
  if (op === 'revert') {
    tnTableRevert(m, b);
    return;
  }

  const t = m.t;
  const out = [];
  if (op === 'interp-h') tnInterpolateH(t.cells, m.xLabels, b, out);
  else if (op === 'interp-v') tnInterpolateV(t.cells, m.yLabels, b, out);
  else if (op === 'interp-2d')
    tnInterpolate2D(t.cells, m.xLabels, m.yLabels, b, out);
  else if (op === 'smooth')
    tnSmoothSelection(
      t.cells,
      (r, c) => m.sel.has(tnCellKey(r, c)),
      b,
      out,
      TN_SMOOTH_ALPHA
    );

  if (!out.length) {
    tnTableFlashInfo(
      m,
      op === 'smooth'
        ? 'select cells to smooth'
        : 'select at least 3 cells across to interpolate'
    );
    return;
  }
  const { n, clamped } = tnTableApplyMany(
    m,
    out,
    op === 'smooth' ? 'smooth' : 'interpolate'
  );
  tnTableFlashInfo(
    m,
    `${op === 'smooth' ? 'smoothed' : 'interpolated'} ${n} cell${n === 1 ? '' : 's'}` +
      (clamped ? ` · ${clamped} clamped` : '')
  );
}

/**
 * Focus the proxy whenever the grid has the user's attention but no cell
 * is being typed in -- after a click, after a drag, after a bulk op.
 * `force` takes focus even from a cell: after a drag the cell the drag
 * started on still holds it, and without this every key you press for the
 * selection ([ ] +/- Cmd-C) was typed into that one cell instead.
 * @param {TableModal} m
 * @param {boolean} force
 * @returns {void}
 */
function tnTableFocusProxy(m, force) {
  const act = document.activeElement;
  const inCell = !!(act && act.classList && act.classList.contains('tn-cell'));
  if (!force && inCell) return;
  if (force && inCell) act.blur(); // commits it -- a no-op unless something was typed
  try {
    m.proxy.focus({ preventScroll: true });
  } catch (e) {
    m.proxy.focus();
  }
}

/**
 * Paste a TSV block at the selection's top-left. Clipped to the table;
 * out-of-range values are refused by the encoder and counted, never
 * silently clamped. The pasted block becomes the new selection, which is
 * what every spreadsheet and tuning app does -- it shows you exactly what
 * landed and lets you immediately scale or undo it as a unit.
 * @param {TableModal} m
 * @param {string} text
 * @returns {void}
 */
function tnTablePasteTsv(m, text) {
  if (!m.invertible) {
    tnTableFlashInfo(m, 'read-only table');
    return;
  }
  const b = tnSelectionBounds(m.sel);
  if (!b) {
    tnTableFlashInfo(m, 'select a cell first');
    return;
  }
  const grid = tnParseTsvGrid(text);
  if (!grid.length || !grid[0].length) return;

  let wrote = 0,
    refused = 0,
    clipped = 0;
  let maxR = b.r0,
    maxC = b.c0;
  for (let i = 0; i < grid.length; i++) {
    const r = b.r0 + i;
    for (let j = 0; j < grid[i].length; j++) {
      const c = b.c0 + j;
      if (r >= m.t.rows || c >= m.t.cols) {
        clipped++;
        continue;
      }
      const raw = String(grid[i][j]).trim().replace(/,/g, '');
      if (raw === '') continue; // blank leaves the cell alone
      const v = Number(raw);
      if (!Number.isFinite(v)) {
        clipped++;
        continue;
      }
      if (tnTableApplyCell(m, r, c, v)) {
        wrote++;
        if (r > maxR) maxR = r;
        if (c > maxC) maxC = c;
      } else refused++;
    }
  }
  if (!wrote && !refused) {
    tnTableFlashInfo(m, 'nothing to paste');
    return;
  }

  m.t = window.XDF.decodeTable(m.item, tuningState.bin, m.h);
  // select what landed
  m.sel.clear();
  for (let r = b.r0; r <= maxR; r++) {
    for (let c = b.c0; c <= maxC; c++) m.sel.add(tnCellKey(r, c));
  }
  m.anchor = { r: b.r0, c: b.c0 };
  tnTablePaint(m);
  tnTableFlashInfo(
    m,
    `pasted ${wrote}` +
      (refused ? `, ${refused} out of range` : '') +
      (clipped ? `, ${clipped} off-table` : '')
  );
}

/**
 * CLIPBOARD. Route everything through a hidden, always-focused <textarea>
 * rather than navigator.clipboard. That API needs a secure context and a
 * permission the user has to grant, and it silently no-ops on plain
 * http://localhost; a real copy/paste EVENT carries its data with no
 * permission at all. So:
 *
 *   copy  -- put the TSV in the proxy, select it, let the browser's own
 *            copy handler take it. Runs inside the keydown, so the
 *            user-gesture requirement is satisfied.
 *   paste -- the proxy is focused, so the native paste event fires on it
 *            and hands us the text directly.
 *
 * The proxy also gives the grid somewhere to hold focus between clicks,
 * which is what makes the shortcuts work at all after a drag-select.
 * @param {TableModal} m
 * @returns {void}
 */
function tnTableWireClipboard(m) {
  const proxy = document.createElement('textarea');
  proxy.className = 'tn-clip-proxy';
  proxy.setAttribute('aria-hidden', 'true');
  proxy.tabIndex = -1;
  m.box.appendChild(proxy);
  m.proxy = proxy;

  const copySelection = (e) => {
    const b = tnSelectionBounds(m.sel);
    if (!b) return;
    const tsv = tnCellsTsv(m.t.cells, b, m.dp);
    e.preventDefault();
    e.clipboardData.setData('text/plain', tsv.text);
    tnTableFlashInfo(m, `copied ${tsv.rows} × ${tsv.cols}`);
  };
  // The proxy's own copy/paste events: this is the path that actually runs.
  proxy.addEventListener('copy', copySelection);
  proxy.addEventListener('cut', copySelection);
  proxy.addEventListener('paste', (e) => {
    const txt = e.clipboardData && e.clipboardData.getData('text/plain');
    if (!txt) return;
    e.preventDefault();
    tnTablePasteTsv(m, txt);
  });
}

/**
 * Move or extend the selection with the arrow keys.
 * @param {TableModal} m
 * @param {KeyboardEvent} e
 * @returns {void}
 */
function tnTableArrowKey(m, e) {
  const t = m.t;
  const b = tnSelectionBounds(m.sel);
  const dr = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
  const dc = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
  if (e.shiftKey && m.anchor) {
    // extend the rectangle from the anchor
    const r = Math.min(
      t.rows - 1,
      Math.max(0, (b.r1 === m.anchor.r ? b.r0 : b.r1) + dr)
    );
    const c = Math.min(
      t.cols - 1,
      Math.max(0, (b.c1 === m.anchor.c ? b.c0 : b.c1) + dc)
    );
    tnTableSelectRect(m, r, c, false);
  } else {
    const r = Math.min(t.rows - 1, Math.max(0, b.r0 + dr));
    const c = Math.min(t.cols - 1, Math.max(0, b.c0 + dc));
    m.sel.clear();
    m.sel.add(tnCellKey(r, c));
    m.anchor = { r, c };
    tnTablePaint(m);
  }
}

/**
 * INCREMENT / DECREMENT. +/- nudge the selection by a step derived from
 * the table's own resolution, with a fine step on the bracket keys -- a
 * two-tier coarse/fine split. This is what makes keyboard-only tuning
 * practical: select a region, hold +, watch it move.
 * @param {TableModal} m
 * @param {string} key
 * @returns {boolean} True when the key was a step key and was handled.
 */
function tnTableStepKey(m, key) {
  let dir = 0,
    fine = false;
  if (key === '+' || key === '=') dir = 1;
  else if (key === '-' || key === '_') dir = -1;
  else if (key === ']') {
    dir = 1;
    fine = true;
  } else if (key === '[') {
    dir = -1;
    fine = true;
  }
  if (!dir) return false;
  const step = (fine ? m.fineStep : m.coarseStep) * dir;
  const values = tnSelectedValues(m).map(([r, c, cur]) => [r, c, cur + step]);
  const { n, clamped } = tnTableApplyMany(
    m,
    values,
    dir > 0 ? 'increment' : 'decrement'
  );
  if (clamped) tnTableFlashInfo(m, `${n} cells · ${clamped} clamped to range`);
  return true;
}

/**
 * The dialog's keyboard handler (bound on document while it is open).
 * @param {TableModal} m
 * @param {KeyboardEvent} e
 * @returns {void}
 */
function tnTableOnKey(m, e) {
  if (e.key === 'Escape') {
    m.close();
    return;
  }
  const act = document.activeElement;
  // Any text field that is not the hidden key proxy is being typed in: a
  // grid cell, an axis breakpoint, the value box. The shortcuts below
  // must not eat its keystrokes -- '-' doubles as step-down, so a
  // negative value could not be typed into the value box.
  const inCell = !!(
    act &&
    act !== m.proxy &&
    (act.tagName === 'INPUT' || act.tagName === 'TEXTAREA')
  );

  // Arrow keys move the selection when not editing text -- the way a grid
  // is expected to behave, and what makes keyboard-only tuning possible.
  if (!inCell && m.sel.size && /^Arrow(Up|Down|Left|Right)$/.test(e.key)) {
    e.preventDefault();
    tnTableArrowKey(m, e);
    tnTableFocusProxy(m, false);
    return;
  }

  const mod = e.metaKey || e.ctrlKey;

  // UNDO / REDO. Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z (or Cmd/Ctrl+Y), the
  // shortcuts users try without being told.
  if (mod && /^z$/i.test(e.key) && !inCell) {
    e.preventDefault();
    tnTableRunOp(m, e.shiftKey ? 'redo' : 'undo');
    return;
  }
  if (mod && /^y$/i.test(e.key) && !inCell) {
    e.preventDefault();
    tnTableRunOp(m, 'redo');
    return;
  }

  if (!inCell && m.sel.size && m.invertible) {
    if (tnTableStepKey(m, e.key)) {
      e.preventDefault();
      tnTableFocusProxy(m, false);
      return;
    }
  }

  // Interpolate / smooth on Shift+letter keys.
  if (!inCell && e.shiftKey && !mod && m.sel.size) {
    const k = e.key.toUpperCase();
    if (k === 'H' || k === 'V' || k === 'I' || k === 'S') {
      e.preventDefault();
      tnTableRunOp(
        m,
        k === 'H'
          ? 'interp-h'
          : k === 'V'
            ? 'interp-v'
            : k === 'I'
              ? 'interp-2d'
              : 'smooth'
      );
      tnTableFocusProxy(m, false);
      return;
    }
  }

  // The clipboard shortcuts themselves are handled by the proxy's copy /
  // paste events; we only need to make sure the proxy has focus when the
  // user reaches for them, and that a cell mid-edit keeps its own.
  if (mod && /^[cxv]$/i.test(e.key) && !inCell && m.sel.size)
    tnTableFocusProxy(m, false);
}
