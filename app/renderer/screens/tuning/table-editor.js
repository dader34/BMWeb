/**
 * @file Tuning screen: the table editor dialog -- the full grid, in a
 * dialog with the quality-of-life tools that make a map editable rather
 * than merely visible: a heat map so the SHAPE is readable, multi-cell
 * selection, and bulk set / scale / offset over a selection. This piece
 * builds the dialog and wires its lifetime; table-grid.js draws and paints
 * the grid, table-actions.js performs the edits.
 */

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
 * @property {number|null|undefined} zLo - Engineering-unit lower limit.
 * @property {number|null|undefined} zHi - Engineering-unit upper limit.
 * @property {boolean} hasLimit
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
  const range =
    m.zLo != null || m.zHi != null
      ? ' · range ' +
        (m.zLo != null ? fmtNum(m.zLo, dp) : '−∞') +
        '…' +
        (m.zHi != null ? fmtNum(m.zHi, dp) : '∞')
      : '';
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
 * Open the table editor dialog for `item`.
 * @param {TuningEditor} ed
 * @param {XdfTable} item
 * @returns {void}
 */
function tnOpenTableModal(ed, item) {
  const h = tuningState.def.header;
  const t0 = window.XDF.decodeTable(item, tuningState.bin, h);
  if (!t0) return;
  tuningState.openTable = item.key;
  tnSaveSoon();
  const invertible = window.XDF.invertLinear(t0.z.mathEquation) !== null;
  const dp = t0.z.decimalpl != null ? t0.z.decimalpl : h.defaults.sigdigits;
  const steps = tnStepSizes(t0.z, dp);
  const limits = tnEngineeringLimits(t0.z);

  const back = document.createElement('div');
  back.className = 'tn-modal-back';
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

  m.history = tnCreateEditHistory(ed, {
    onReplay: () => tnTableRefresh(m),
    onStateChange: () => tnTableUpdateOpState(m),
    onInfo: (msg) => tnTableFlashInfo(m, msg),
  });

  tnTableBuildGrid(m);
  tnTableWireTools(m);

  const onKey = (e) => tnTableOnKey(m, e);
  m.close = () => {
    back.remove();
    tuningState.openTable = null;
    tnSaveSoon();
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('mouseup', m.endDrag); // added per-modal
    if (m.infoTimer) clearTimeout(m.infoTimer);
    tnRenderDefs(ed); // reflect any edits in the list + hex view
    ed.hex.refresh();
  };
  tnTableWireClipboard(m);

  document.addEventListener('keydown', onKey);
  box.querySelector('.tn-modal-x').onclick = m.close;
  box.querySelector('.tn-modal-done').onclick = m.close;
  back.onclick = (e) => {
    if (e.target === back) m.close();
  };

  document.body.appendChild(back);
  tnTablePaint(m);
}
