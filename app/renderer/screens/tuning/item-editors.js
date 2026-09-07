/**
 * @file Tuning screen: the per-kind editors that open beneath a definition
 * row -- a scalar constant, a flag toggle, a table summary (the grid itself
 * lives in the table editor dialog), and patch apply/revert -- plus the axis
 * labels the table pieces share.
 */

/* exported tnRenderEditor, tnAxisLabels */

/**
 * Render the editor for `item` into `container`.
 * @param {TuningEditor} ed
 * @param {XdfItem} item
 * @param {HTMLElement} container
 * @returns {void}
 */
function tnRenderEditor(ed, item, container) {
  if (!tuningState.bin) {
    container.appendChild(makeNote('Load a BIN to edit this parameter.'));
    return;
  }
  if (item.description) {
    const d = document.createElement('div');
    d.className = 'tn-desc';
    d.textContent = item.description;
    container.appendChild(d);
  }
  if (item.kind === 'constant') tnRenderConstantEditor(ed, item, container);
  else if (item.kind === 'flag') tnRenderFlagEditor(ed, item, container);
  else if (item.kind === 'table') tnRenderTableEditor(ed, item, container);
  else if (item.kind === 'patch') tnRenderPatchEditor(ed, item, container);
}

/**
 * A scalar: a number box through the item's MATH, applied on Enter or the
 * Apply button, read back after the write so rounding is reflected honestly.
 * @param {TuningEditor} ed
 * @param {XdfConstant} item
 * @param {HTMLElement} container
 * @returns {void}
 */
function tnRenderConstantEditor(ed, item, container) {
  const h = tuningState.def.header;
  const val = window.XDF.decodeConstant(item, tuningState.bin, h);
  const invertible = window.XDF.invertLinear(item.mathEquation) !== null;
  const dp = item.decimalpl != null ? item.decimalpl : h.defaults.sigdigits;

  const wrap = document.createElement('div');
  wrap.className = 'tn-edit';
  wrap.innerHTML = `
      <div class="tn-field">
        <label>Value${item.units ? ` <span class="tn-unit">${esc(item.units)}</span>` : ''}</label>
        <div class="tn-input-row">
          <input type="number" class="tn-num" step="any"
                 value="${val == null ? '' : fmtNum(val, dp)}"
                 ${invertible ? '' : 'disabled'} />
          <button class="btn primary tn-apply" ${invertible ? '' : 'disabled'}>Apply</button>
        </div>
      </div>
      <div class="tn-meta">
        <span>MATH <code>${esc(item.mathEquation)}</code></span>
        ${
          item.rangelow != null || item.rangehigh != null
            ? `<span>range ${item.rangelow != null ? fmtNum(item.rangelow, dp) : '−∞'} … ${item.rangehigh != null ? fmtNum(item.rangehigh, dp) : '+∞'}</span>`
            : ''
        }
        <span class="tn-raw" id="tn-raw"></span>
      </div>
      ${invertible ? '' : '<div class="tn-warn">This parameter’s MATH is not invertible; read-only.</div>'}`;
  container.appendChild(wrap);

  const numEl = wrap.querySelector('.tn-num');
  const applyBtn = wrap.querySelector('.tn-apply');
  const rawEl = wrap.querySelector('#tn-raw');
  const showRaw = () => {
    const spec = window.XDF.resolveEmbedded(
      item.embed,
      h.baseOffset,
      h.defaults
    );
    const raw = window.XDF.readScalar(tuningState.bin, spec);
    rawEl.textContent =
      raw == null
        ? ''
        : `raw ${raw} · ${Math.max(1, Math.ceil(spec.sizeBits / 8))} B ${spec.lsbfirst ? 'LE' : 'BE'}${spec.signed ? ' signed' : ''}`;
  };
  showRaw();

  const apply = () => {
    const v = Number(numEl.value);
    if (!Number.isFinite(v)) {
      shake(numEl);
      return;
    }
    if (
      (item.rangelow != null && v < item.rangelow) ||
      (item.rangehigh != null && v > item.rangehigh)
    ) {
      shake(numEl);
      ed.els.status.textContent = 'value out of range';
      return;
    }
    const enc = window.XDF.encodeConstant(item, v, h);
    if (!enc) {
      shake(numEl);
      ed.els.status.textContent = 'value does not fit this field';
      return;
    }
    tnWriteBytes(ed, enc.address, enc.bytes);
    // read the value back so scaling/rounding is reflected honestly
    const back = window.XDF.decodeConstant(item, tuningState.bin, h);
    numEl.value = back == null ? '' : fmtNum(back, dp);
    showRaw();
    tnFlash(applyBtn);
  };
  applyBtn.onclick = apply;
  numEl.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      apply();
    }
  };
}

/**
 * A flag: one toggle over the masked bit.
 * @param {TuningEditor} ed
 * @param {XdfFlag} item
 * @param {HTMLElement} container
 * @returns {void}
 */
function tnRenderFlagEditor(ed, item, container) {
  const on = window.XDF.readFlag(
    tuningState.bin,
    tnItemAddress(item),
    item.mask
  );
  const wrap = document.createElement('div');
  wrap.className = 'tn-edit';
  wrap.innerHTML = `
      <label class="tn-toggle">
        <input type="checkbox" ${on ? 'checked' : ''} />
        <span class="tn-toggle-track"><span class="tn-toggle-dot"></span></span>
        <span class="tn-toggle-label">${on ? 'On' : 'Off'}</span>
      </label>
      <div class="tn-meta"><span>bit mask <code>0x${item.mask.toString(16).toUpperCase()}</code> @ byte 0x${tnItemAddress(item).toString(16).toUpperCase()}</span></div>`;
  container.appendChild(wrap);
  const cb = wrap.querySelector('input');
  const label = wrap.querySelector('.tn-toggle-label');
  cb.onchange = () => {
    const addr = tnItemAddress(item);
    const next = window.XDF.applyFlag(
      tuningState.bin[addr],
      item.mask,
      cb.checked
    );
    tnWriteBytes(ed, addr, new Uint8Array([next]));
    label.textContent = cb.checked ? 'On' : 'Off';
  };
}

/**
 * A table: a summary and the way in. A table's grid does not belong inline
 * in a 5,000-row list: a 16x16 map pushes everything else off screen, and
 * the cells are too cramped to work in. The grid opens in a modal with room
 * to actually tune -- see tnOpenTableModal.
 * @param {TuningEditor} ed
 * @param {XdfTable} item
 * @param {HTMLElement} container
 * @returns {void}
 */
function tnRenderTableEditor(ed, item, container) {
  const h = tuningState.def.header;
  const t = window.XDF.decodeTable(item, tuningState.bin, h);
  if (!t) {
    container.appendChild(makeNote('This table has no Z axis to edit.'));
    return;
  }
  const invertible = window.XDF.invertLinear(t.z.mathEquation) !== null;

  const bar = document.createElement('div');
  bar.className = 'tn-tbl-summary';
  const { lo, hi, count } = tnCellBounds(t.cells);
  const dp0 = t.z.decimalpl != null ? t.z.decimalpl : h.defaults.sigdigits;
  bar.innerHTML =
    `<span class="tn-tbl-dims">${t.rows} × ${t.cols}</span>` +
    (count
      ? `<span class="tn-tbl-range">${fmtNum(lo, dp0)} … ${fmtNum(hi, dp0)}` +
        `${t.z.units ? ' ' + esc(t.z.units) : ''}</span>`
      : '') +
    (invertible ? '' : '<span class="tn-warn-inline">read-only</span>');
  const viewBtn = document.createElement('button');
  viewBtn.type = 'button';
  viewBtn.className = 'btn tn-tbl-view';
  viewBtn.textContent = 'View table…';
  viewBtn.onclick = () => tnOpenTableModal(ed, item);
  bar.appendChild(viewBtn);
  container.appendChild(bar);
}

/**
 * A patch: one row per entry with its current state and Apply / Revert.
 * @param {TuningEditor} ed
 * @param {XdfPatch} item
 * @param {HTMLElement} container
 * @returns {void}
 */
function tnRenderPatchEditor(ed, item, container) {
  const wrap = document.createElement('div');
  wrap.className = 'tn-edit tn-patch';
  for (const e of item.entries) {
    const state = window.XDF.patchEntryState(
      tuningState.bin,
      e.address,
      e.patchdata,
      e.basedata
    );
    const row = document.createElement('div');
    row.className = 'tn-patch-row';
    const canRevert =
      e.basedata.length === e.patchdata.length && e.basedata.length > 0;
    row.innerHTML = `
        <div class="tn-patch-info">
          <span class="tn-patch-name">${esc(e.name || 'patch')}</span>
          <span class="tn-patch-addr">0x${e.address.toString(16).toUpperCase()} · ${e.patchdata.length} B</span>
          <span class="tn-patch-state tn-state-${state}">${state}</span>
        </div>
        <div class="tn-patch-btns">
          <button class="btn tn-patch-apply" ${state === 'applied' ? 'disabled' : ''}>Apply</button>
          <button class="btn tn-patch-revert" ${!canRevert || state === 'virgin' ? 'disabled' : ''}>Revert</button>
        </div>`;
    row.querySelector('.tn-patch-apply').onclick = () => {
      tnWriteBytes(ed, e.address, e.patchdata);
      tnRenderDefs(ed); // refresh states
    };
    const rev = row.querySelector('.tn-patch-revert');
    if (canRevert)
      rev.onclick = () => {
        tnWriteBytes(ed, e.address, e.basedata);
        tnRenderDefs(ed);
      };
    wrap.appendChild(row);
  }
  container.appendChild(wrap);
}

/**
 * Axis display labels: explicit LABELs win, else the decoded axis values
 * read from the image when the axis points at real bytes.
 * @param {XdfAxis|undefined} axis
 * @param {number} count - Breakpoints to produce.
 * @param {XdfHeader} header
 * @returns {(string|null)[]}
 */
function tnAxisLabels(axis, count, header) {
  const out = new Array(count).fill(null);
  if (!axis) return out;
  if (axis.labels && axis.labels.length) {
    for (const l of axis.labels) if (l.index < count) out[l.index] = l.value;
    if (out.some((x) => x != null)) return out;
  }
  if (tuningState.bin && axis.embed && axis.embed.address) {
    const spec = window.XDF.resolveEmbedded(
      axis.embed,
      header.baseOffset,
      header.defaults
    );
    let conv;
    try {
      conv = window.XDF.compileMath(axis.mathEquation);
    } catch (e) {
      conv = (v) => v;
    }
    const per = Math.max(1, Math.ceil(spec.sizeBits / 8));
    for (let i = 0; i < count; i++) {
      const raw = window.XDF.readScalar(
        tuningState.bin,
        Object.assign({}, spec, { address: spec.address + i * per })
      );
      if (raw != null)
        out[i] = fmtNum(conv(raw), axis.decimalpl != null ? axis.decimalpl : 0);
    }
  }
  return out;
}
