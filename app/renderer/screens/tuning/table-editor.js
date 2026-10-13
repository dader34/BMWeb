/**
 * @file Tuning screen: the table editor dialog -- the full grid, in a
 * dialog with the quality-of-life tools that make a map editable rather
 * than merely visible: a heat map so the SHAPE is readable, multi-cell
 * selection, and bulk set / scale / offset over a selection. This piece
 * builds the dialog and wires its lifetime; table-grid.js draws and paints
 * the grid, table-actions.js performs the edits.
 */

/* exported tnTableRefreshOpen, tnTableStages */
/* exported tnOpenTableModal */

/**
 * @typedef {Object} TableModal
 * Everything one open table dialog holds. Fields that change while the
 * dialog is open are mutated in place by the grid and action pieces.
 * @property {TuningEditor} ed
 * @property {XdfTable} item
 * @property {XdfHeader} h
 * @property {DecodedTable} t - The table as currently decoded from the image.
 * @property {(string|null)[]} xLabels
 * @property {(string|null)[]} yLabels
 * @property {boolean} invertible - Whether the Z MATH can be inverted (else read-only).
 * @property {number} dp - Display decimal places.
 * @property {number} fineStep - One raw LSB in engineering units.
 * @property {number} coarseStep - The +/- key step.
 * @property {number|null|undefined} zLo - The definition's DECLARED lower
 *   limit, engineering units. A display hint: it flags cells and labels the
 *   footer, and never bounds a write (see tnStorageLimits).
 * @property {number|null|undefined} zHi - The declared upper limit.
 * @property {boolean} hasLimit
 * @property {number|null} storeLo - Lowest value the cell's bytes can hold,
 *   in engineering units. This is what bounds a write.
 * @property {number|null} storeHi - Highest value the cell's bytes can hold.
 * @property {DecodedTable|null} baseTable - The table as it was when this
 *   FILE was loaded: tuningState.orig is the pristine image, so decoding
 *   this table out of it gives the baseline for both "vs original" shading
 *   and the revert op -- no extra bookkeeping.
 * @property {HTMLDivElement} back - The backdrop.
 * @property {HTMLDivElement} box - The dialog.
 * @property {HTMLElement} gridWrap
 * @property {HTMLInputElement} heatBox
 * @property {HTMLInputElement} cmpBox
 * @property {HTMLElement} heatScale
 * @property {HTMLElement} heatLo
 * @property {HTMLElement} heatHi
 * @property {HTMLElement} selInfo
 * @property {HTMLInputElement} bulkVal
 * @property {Set<string>} sel - The materialised set of "r,c" the bulk ops act on.
 * @property {{ r: number, c: number }|null} anchor - The corner a shift-click
 *   or drag extends FROM -- keeping it separate is what makes shift-click
 *   extend the same rectangle rather than starting a new one.
 * @property {Set<string>|null} baseSel - Selection to keep while additively dragging.
 * @property {boolean} dragging
 * @property {HTMLTextAreaElement|null} proxy - The hidden clipboard/focus proxy.
 * @property {EditHistory} history
 * @property {ReturnType<typeof setTimeout>|null} infoTimer
 * @property {() => void} endDrag - The window mouseup handler, removed on close.
 * @property {() => void} close
 */

/**
 * The dialog's static markup.
 * @param {XdfTable} item
 * @param {DecodedTable} t
 * @param {TableModal} m - For the derived numbers the footer shows.
 * @returns {string}
 */
function tnTableModalHtml(item, t, m) {
  const ro = m.invertible ? '' : 'disabled';
  const dp = m.dp;
  // Two different numbers, and conflating them is what made the old footer
  // misleading: the definition's declared range is a hint about what values
  // are SENSIBLE, while the storage limit is what can actually be WRITTEN.
  // Definitions disagree with their own storage often enough (a 16-bit
  // table declaring max 255) that showing only the declared one read as a
  // hard limit that was not there. Show the writable limit whenever it
  // differs from what the definition claims.
  const fmtSpan = (lo, hi) =>
    (lo != null ? fmtNum(lo, dp) : '−∞') +
    '…' +
    (hi != null ? fmtNum(hi, dp) : '∞');
  const declared =
    m.zLo != null || m.zHi != null
      ? ' · def range ' + fmtSpan(m.zLo, m.zHi)
      : '';
  const showStore =
    (m.storeLo != null || m.storeHi != null) &&
    (m.storeLo !== m.zLo || m.storeHi !== m.zHi);
  const range =
    declared + (showStore ? ' · holds ' + fmtSpan(m.storeLo, m.storeHi) : '');
  return (
    `
      <div class="tn-modal-head">
        <div class="tn-modal-title">
          <span class="tn-item-kind tn-kind-table">TBL</span>
          <span>${esc(item.title || '(untitled)')}</span>
        </div>
        <button type="button" class="tn-modal-x" aria-label="Close">×</button>
      </div>
      ${item.description ? `<div class="tn-modal-desc">${esc(item.description)}</div>` : ''}
      <div class="tn-modal-tools">
        <label class="tn-tool-check"><input type="checkbox" class="tn-heat" checked> heat</label>
        <span class="tn-tool-sep"></span>
        <span class="tn-sel-info">click, drag, or shift-click to select</span>
        <span class="tn-tool-spacer"></span>
        <input type="text" class="tn-bulk-v" placeholder="value" spellcheck="false"
               ${ro} />
        <button type="button" class="btn tn-bulk" data-op="set"   ${ro}>set</button>
        <button type="button" class="btn tn-bulk" data-op="add"   ${ro}>+/−</button>
        <button type="button" class="btn tn-bulk" data-op="scale" ${ro}>× %</button>
        <span class="tn-tool-sep"></span>
        <button type="button" class="btn tn-op" data-op="interp-h" title="Interpolate across the selection, left to right (Shift+H)" ${ro}>interp ↔</button>
        <button type="button" class="btn tn-op" data-op="interp-v" title="Interpolate down the selection, top to bottom (Shift+V)" ${ro}>interp ↕</button>
        <button type="button" class="btn tn-op" data-op="interp-2d" title="Interpolate both axes (Shift+I)" ${ro}>interp 2D</button>
        <button type="button" class="btn tn-op" data-op="smooth" title="Smooth the selection (Shift+S)" ${ro}>smooth</button>
        <span class="tn-tool-sep"></span>
        <button type="button" class="btn tn-op" data-op="undo" title="Undo the last change (Cmd/Ctrl+Z)" ${ro}>undo</button>
        <button type="button" class="btn tn-op" data-op="redo" title="Redo the change you undid (Cmd/Ctrl+Shift+Z)" ${ro}>redo</button>
        <button type="button" class="btn tn-op" data-op="revert" title="Revert the selection to the values this file loaded with" ${ro}>revert</button>
        <span class="tn-tool-sep"></span>
        <label class="tn-tool-check"><input type="checkbox" class="tn-cmp"> vs original</label>
      </div>
      <div class="tn-modal-grid"></div>
      <div class="tn-modal-foot">
        <span class="tn-modal-meta">${t.rows} × ${t.cols} · MATH <code>${esc(t.z.mathEquation)}</code>` +
    `${t.z.units ? ' · ' + esc(t.z.units) : ''}` +
    range +
    `${m.invertible ? '' : ' · read-only (MATH not invertible)'}</span>
        <span class="tn-heat-scale" hidden><b class="tn-hs-lo"></b><i></i><b class="tn-hs-hi"></b></span>
        <span class="tn-modal-keys">+/− step ${fmtNum(m.coarseStep, Math.max(dp, 2))} · [ ] fine ${fmtNum(m.fineStep, Math.max(dp, 2))} · ⇧H/⇧V/⇧I interp · ⇧S smooth · ⌘Z undo · ⇧⌘Z redo</span>
        <button type="button" class="btn tn-modal-done">Done</button>
      </div>`
  );
}

/**
 * Whether a span of the image belongs to the table that is open (its cells
 * or its break points). Live mode holds edits to it until Apply is pressed,
 * and sends everything else at once.
 * @param {number} start - IMAGE offset.
 * @param {number} length
 * @returns {boolean}
 */
function tnTableStages(start, length) {
  const m = tnOpenTable;
  if (!m || !m.stageRanges) return false;
  return m.stageRanges.some((r) => start < r.end && start + length > r.start);
}

/**
 * Rule the rest of the pane into blank cells at the table's own pitch, so a
 * small table reads as the filled corner of a sheet and not as a scrap in an
 * empty pane. The lines are a background measured off the real cells (and
 * measured again whenever the pane changes size), not cells of their own:
 * nothing to select, tab into or scroll.
 * @param {TableModal} m
 * @returns {void}
 */
function tnTableBlankSheet(m) {
  if (!m.back.classList.contains('tn-docked')) return;
  const rule = () => {
    const cell = m.gridWrap.querySelector('.tn-cell');
    const table = m.gridWrap.querySelector('.tn-table');
    if (!cell || !table) return;
    const td = cell.parentElement.getBoundingClientRect();
    const tb = table.getBoundingClientRect();
    if (!td.width || !td.height) return;
    const s = m.gridWrap.style;
    s.setProperty('--sheet-w', `${td.width}px`);
    s.setProperty('--sheet-h', `${td.height}px`);
    // where the first data cell starts: past the row heads and the header row
    s.setProperty('--sheet-x', `${td.left - tb.left}px`);
    s.setProperty('--sheet-y', `${td.top - tb.top}px`);
    m.gridWrap.classList.add('tn-sheet');
  };
  rule();
  if (typeof ResizeObserver === 'function') {
    m.sheet = new ResizeObserver(rule);
    m.sheet.observe(m.gridWrap);
  }
}

/** The table editor that is open, if one is. */
let tnOpenTable = null;

/**
 * Re-decode and repaint the open table editor after the image changed from
 * outside it (a live read-back, a discard): with the editor docked in the
 * page, the rest of the screen can change bytes under it.
 * @returns {void}
 */
function tnTableRefreshOpen() {
  if (tnOpenTable) tnTableRefresh(tnOpenTable);
}

/**
 * Open the table editor dialog for `item`.
 * @param {TuningEditor} ed
 * @param {XdfTable} item
 * @returns {void}
 */
function tnOpenTableModal(ed, item) {
  const h = tuningState.def.header;
  const t0 = window.XDF.decodeTable(item, tuningState.bin, h);
  if (!t0) return;
  // one table at a time: the pane it sits in holds one
  if (tnOpenTable) tnOpenTable.close();
  tuningState.openTable = item.key;
  tnSaveSoon();
  const invertible = window.XDF.invertLinear(t0.z.mathEquation) !== null;
  const dp = t0.z.decimalpl != null ? t0.z.decimalpl : h.defaults.sigdigits;
  const steps = tnStepSizes(t0.z, dp);
  const limits = tnEngineeringLimits(t0.z);
  const store = tnStorageLimits(t0.spec, t0.z);

  // The table takes over the right-hand pane (the hex view and inspector
  // make way) instead of floating over the page: the list, the live toolbar
  // and everything else stay in reach while it is open. `back` is still the
  // dialog's wrapper, docked in the pane; without the pane (never, today)
  // it falls back to an overlay.
  const pane = document.getElementById('tn-hexpane');
  const back = document.createElement('div');
  back.className = pane ? 'tn-modal-back tn-docked' : 'tn-modal-back';
  const box = document.createElement('div');
  box.className = 'tn-modal';
  back.appendChild(box);

  /** @type {TableModal} */
  const m = {
    ed,
    item,
    h,
    t: t0,
    xLabels: tnAxisLabels(t0.x, t0.cols, h),
    yLabels: tnAxisLabels(t0.y, t0.rows, h),
    invertible,
    dp,
    fineStep: steps.fine,
    coarseStep: steps.coarse,
    zLo: limits.lo,
    zHi: limits.hi,
    hasLimit: limits.lo != null || limits.hi != null,
    storeLo: store.lo,
    storeHi: store.hi,
    baseTable: tuningState.orig
      ? window.XDF.decodeTable(item, tuningState.orig, h)
      : null,
    back,
    box,
    gridWrap: null,
    heatBox: null,
    cmpBox: null,
    heatScale: null,
    heatLo: null,
    heatHi: null,
    selInfo: null,
    bulkVal: null,
    sel: new Set(),
    anchor: null,
    baseSel: null,
    dragging: false,
    proxy: null,
    history: null,
    infoTimer: null,
    endDrag: null,
    close: null,
  };
  box.innerHTML = tnTableModalHtml(item, t0, m);
  m.gridWrap = box.querySelector('.tn-modal-grid');
  m.heatBox = box.querySelector('.tn-heat');
  m.cmpBox = box.querySelector('.tn-cmp');
  m.heatScale = box.querySelector('.tn-heat-scale');
  m.heatLo = box.querySelector('.tn-hs-lo');
  m.heatHi = box.querySelector('.tn-hs-hi');
  m.selInfo = box.querySelector('.tn-sel-info');
  m.bulkVal = box.querySelector('.tn-bulk-v');

  // The closing button reads "Apply" once this visit has changed something
  // (a figure being typed counts), and "Done" while it has not -- or again
  // after everything was undone.
  // LIVE: the same button is what sends. Edits to this table are held (not
  // sent to the car as each figure is typed) until Apply is pressed; the
  // table then stays open and the button goes back to "Done". Closing the
  // table without Apply drops what was not applied.
  const doneBtn = box.querySelector('.tn-modal-done');
  const undoAtOpen = tuningState.history.length;
  m.appliedAt = undoAtOpen; // how far the edit history has been applied to the car
  let typing = false;
  const live = () => typeof tnLive !== 'undefined' && tnLive.armed;
  const unapplied = () => live() && (tnLive.staged.size > 0 || typing);
  const labelDone = () => {
    doneBtn.textContent = live()
      ? unapplied()
        ? 'Apply'
        : 'Done'
      : typing || tuningState.history.length !== undoAtOpen
        ? 'Apply'
        : 'Done';
    doneBtn.classList.toggle('primary', unapplied());
  };
  m.labelDone = labelDone;
  m.gridWrap.addEventListener('input', () => {
    typing = true;
    labelDone();
  });
  m.gridWrap.addEventListener('focusout', () => {
    // the figure was committed (or dropped): the undo stack says which
    typing = false;
    setTimeout(labelDone, 0);
  });

  m.history = tnCreateEditHistory(ed, {
    onReplay: () => tnTableRefresh(m),
    onStateChange: () => {
      tnTableUpdateOpState(m);
      labelDone();
    },
    onInfo: (msg) => tnTableFlashInfo(m, msg),
  });

  tnTableBuildGrid(m);
  tnTableWireTools(m);
  if (typeof tnSurfaceAttach === 'function') tnSurfaceAttach(m);

  const onKey = (e) => tnTableOnKey(m, e);
  m.close = () => {
    // LIVE, with edits that were never applied: they were not sent, so the
    // editor's copy goes back to what the car has
    if (typeof tnLive !== 'undefined' && tnLive.armed && tnLive.staged.size) {
      while (tuningState.history.length > m.appliedAt && m.history.undo());
      tnLiveDropStaged();
    }
    back.remove();
    if (pane) pane.classList.remove('tn-has-table');
    if (tnOpenTable === m) tnOpenTable = null;
    tuningState.openTable = null;
    tnSaveSoon();
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('mouseup', m.endDrag); // added per-modal
    if (typeof tnLiveCursorDetach === 'function') tnLiveCursorDetach(m);
    if (typeof tnSurfaceDetach === 'function') tnSurfaceDetach(m);
    if (m.sheet) m.sheet.disconnect();
    if (m.infoTimer) clearTimeout(m.infoTimer);
    tnRenderDefs(ed); // reflect any edits in the list + hex view
    ed.hex.refresh();
  };
  tnTableWireClipboard(m);

  document.addEventListener('keydown', onKey);
  box.querySelector('.tn-modal-x').onclick = m.close;
  doneBtn.onclick = () => {
    // the figure being typed was committed when the button took focus
    if (unapplied()) {
      typing = false;
      tnLiveApplyStaged();
      m.appliedAt = tuningState.history.length;
      labelDone();
      tnTableFlashInfo(m, 'applied to the ECU');
      return;
    }
    m.close();
  };
  // A click on the backdrop closes -- but only one that STARTED there. A
  // drag-select released outside the dialog also "clicks" the backdrop (the
  // nearest common ancestor of where it began and ended), and that closed
  // the table under a selection in progress.
  let pressedBack = false;
  back.onmousedown = (e) => {
    pressedBack = e.target === back;
  };
  back.onclick = (e) => {
    if (e.target === back && pressedBack) m.close();
  };

  if (pane) {
    pane.classList.add('tn-has-table');
    pane.appendChild(back);
  } else document.body.appendChild(back);
  tnOpenTable = m;
  // what "this table" covers, for holding live edits: its cells and its axes
  m.stageRanges = [];
  try {
    const cells = tnItemByteRange(item);
    if (cells) m.stageRanges.push(cells);
    for (const [axis, count] of [
      [t0.x, t0.cols],
      [t0.y, t0.rows],
    ]) {
      if (!axis || !axis.embed || !axis.embed.address) continue;
      const spec = window.XDF.resolveEmbedded(
        axis.embed,
        h.baseOffset,
        h.defaults
      );
      const width = Math.max(1, Math.ceil(spec.sizeBits / 8));
      m.stageRanges.push({
        start: spec.address,
        end: spec.address + count * width,
      });
    }
  } catch (e) {
    /* nothing held: edits are sent as they are made */
  }
  tnTablePaint(m);
  tnTableBlankSheet(m);
  // LIVE mode: mark the cell the DME is reading while this table is open
  if (typeof tnLiveCursorAttach === 'function') tnLiveCursorAttach(m);

  // LIVE mode: read this map's values from the ECU on demand, then re-decode
  // and repaint the grid with what the car actually holds.
  if (typeof tnLiveFillTable === 'function') {
    tnLiveFillTable(item).then(() => {
      if (tuningState.openTable === item.key) tnTableRefresh(m);
    });
  }
}
