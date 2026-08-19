// Tuning: a client-side ECU firmware editor in the TunerPro mould. Load a
// firmware BIN, view it as raw hex (virtualized so multi-MB images stay
// smooth), load a TunerPro .xdf definition to edit named constants / flags /
// tables through their scaling, then save the modified BIN back. Nothing is
// uploaded -- the bytes never leave the machine.
//
// The parser + raw<->engineering codec live in core/xdf.js (window.XDF), which
// is unit-tested (tools/verify/test_xdf.js). This file is the UI: file I/O,
// the virtualized hex grid, the definition tree, and the per-item editors.

// Screen state persists within a visit so re-renders don't drop a loaded image.
const tuningState = {
  bin: null,          // Uint8Array, the working image (edited in place via splice)
  orig: null,         // Uint8Array snapshot at load, for changed-byte highlighting
  fileName: '',       // BIN file name (for the Save default)
  def: null,          // parsed .xdf { header, items } or null
  defName: '',        // .xdf file name
  selectedId: null,   // uniqueid of the open item
  changed: 0,         // count of bytes differing from orig
  highlight: null,    // { start, end } byte range to spotlight in the hex view
  filter: '',         // definition-tree search text
};

const TUNE_HEX = {
  BYTES_PER_ROW: 16,
  ROW_H: 20,
  OVERSCAN: 8,
};

function showTuning() {
  if (typeof cancelSweep === 'function') cancelSweep();
  lastScreen = showTuning;
  setCrumbs([{ label: 'Vehicles', fn: showChassis },
             { label: 'Apps', fn: showApps }, { label: 'Tuning' }]);
  document.body.classList.add('apps-section');
  sbLeft.textContent = 'tuning';

  view.innerHTML = head('Tuning', 'ECU Firmware Editor',
    'Load a firmware BIN and edit it as raw hex, or open a TunerPro .xdf to '
    + 'tune named constants, flags and tables. Everything stays on this device.');

  if (typeof window.XDF === 'undefined') {
    view.insertAdjacentHTML('beforeend',
      errorBlock('The XDF engine (core/xdf.js) did not load.', 'red'));
    setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: () => showApps() }]);
    return;
  }

  // ---- toolbar -------------------------------------------------------------
  const bar = document.createElement('div');
  bar.className = 'tn-bar';
  bar.innerHTML = `
    <button class="btn tn-load-bin">Load BIN…</button>
    <button class="btn tn-load-xdf" disabled>Load .xdf…</button>
    <button class="btn primary tn-save" disabled>Save BIN…</button>
    <span class="tn-file" id="tn-file"></span>
    <span class="tn-status" id="tn-status"></span>
    <input type="file" class="tn-file-input" id="tn-bin-input" hidden />
    <input type="file" class="tn-file-input" id="tn-xdf-input" accept=".xdf,.xml" hidden />`;
  view.appendChild(bar);

  // ---- workspace: definitions (left) | hex (right) -------------------------
  const workspace = document.createElement('div');
  workspace.className = 'tn-workspace';
  workspace.innerHTML = `
    <section class="tn-defs" id="tn-defs">
      <div class="tn-empty" id="tn-defs-empty">
        <div class="tn-empty-icon">⛃</div>
        <div>Load a <strong>.xdf</strong> definition to edit named parameters.</div>
        <div class="tn-empty-sub">Without one you can still browse and edit raw hex.</div>
      </div>
    </section>
    <section class="tn-hexpane" id="tn-hexpane">
      <div class="tn-hex-head">
        <span class="tn-hex-title">Hex</span>
        <label class="tn-goto-wrap">jump
          <input type="text" class="tn-goto" id="tn-goto" placeholder="0x0000"
                 spellcheck="false" autocomplete="off" />
        </label>
        <span class="tn-hex-meta" id="tn-hex-meta"></span>
      </div>
      <div class="tn-hex-scroll" id="tn-hex-scroll" tabindex="0">
        <div class="tn-hex-empty" id="tn-hex-empty">No BIN loaded.</div>
        <div class="tn-hex-spacer" id="tn-hex-spacer" hidden>
          <div class="tn-hex-window" id="tn-hex-window"></div>
        </div>
      </div>
    </section>`;
  view.appendChild(workspace);

  const els = {
    loadBin: bar.querySelector('.tn-load-bin'),
    loadXdf: bar.querySelector('.tn-load-xdf'),
    save: bar.querySelector('.tn-save'),
    file: bar.querySelector('#tn-file'),
    status: bar.querySelector('#tn-status'),
    binInput: bar.querySelector('#tn-bin-input'),
    xdfInput: bar.querySelector('#tn-xdf-input'),
    defs: workspace.querySelector('#tn-defs'),
    hexScroll: workspace.querySelector('#tn-hex-scroll'),
    hexSpacer: workspace.querySelector('#tn-hex-spacer'),
    hexWindow: workspace.querySelector('#tn-hex-window'),
    hexEmpty: workspace.querySelector('#tn-hex-empty'),
    hexMeta: workspace.querySelector('#tn-hex-meta'),
    goto: workspace.querySelector('#tn-goto'),
  };

  // ==========================================================================
  // Virtualized hex view -- only the visible rows exist in the DOM, so a
  // multi-MB image scrolls without laying out hundreds of thousands of rows.
  // ==========================================================================
  const hex = createHexView(els);

  // ==========================================================================
  // File loading
  // ==========================================================================
  function readFileBytes(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(new Uint8Array(fr.result));
      fr.onerror = () => reject(new Error('could not read file'));
      fr.readAsArrayBuffer(file);
    });
  }

  async function onBinChosen(file) {
    if (!file) return;
    try {
      const bytes = await readFileBytes(file);
      tuningState.bin = bytes;
      tuningState.orig = bytes.slice();      // snapshot for change tracking
      tuningState.fileName = file.name || 'firmware.bin';
      tuningState.changed = 0;
      tuningState.highlight = null;
      els.loadXdf.disabled = false;
      els.save.disabled = false;
      els.file.textContent = `${tuningState.fileName} · ${fmtBytes(bytes.length)}`;
      hex.refresh();
      // re-decode any open definition against the new image
      if (tuningState.def) renderDefs();
      updateStatus();
    } catch (e) {
      els.status.textContent = e.message;
    }
  }

  async function onXdfChosen(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const def = window.XDF.parseXdf(text);
      tuningState.def = def;
      tuningState.defName = file.name || 'definition.xdf';
      tuningState.selectedId = null;
      renderDefs();
      updateStatus();
    } catch (e) {
      // parse errors (bad XML, encrypted) surface in the defs pane, non-fatally
      tuningState.def = null;
      els.defs.innerHTML = '';
      els.defs.appendChild(makeEmpty('⚠', `Could not parse ${esc(file.name || '.xdf')}`,
        esc(e.message)));
    }
  }

  els.loadBin.onclick = () => els.binInput.click();
  els.loadXdf.onclick = () => els.xdfInput.click();
  els.binInput.onchange = () => { onBinChosen(els.binInput.files[0]); els.binInput.value = ''; };
  els.xdfInput.onchange = () => { onXdfChosen(els.xdfInput.files[0]); els.xdfInput.value = ''; };

  // ==========================================================================
  // Save
  // ==========================================================================
  els.save.onclick = async () => {
    if (!tuningState.bin) return;
    const name = tuningState.fileName.replace(/\.(bin|hex|ori|orig)$/i, '') + '-tuned.bin';
    try {
      // Prefer the host's real Save panel (macOS shell); fall back to a browser
      // download. Same pattern core/offline-export.js uses.
      if (window.bmacw && typeof window.bmacw.saveFile === 'function') {
        const r = await window.bmacw.saveFile(name, tuningState.bin);
        if (r && r.cancelled) return;
      } else {
        const blob = new Blob([tuningState.bin], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      }
      els.status.textContent = `saved ${name}`;
    } catch (e) {
      els.status.textContent = `save failed: ${e.message}`;
    }
  };

  // ==========================================================================
  // Applying an edit: splice new bytes into the working image, recount changes,
  // repaint the touched hex rows, and keep the editor's read-back in sync.
  // ==========================================================================
  function writeBytes(address, bytes) {
    if (!tuningState.bin || address < 0 || address + bytes.length > tuningState.bin.length) return false;
    for (let i = 0; i < bytes.length; i++) tuningState.bin[address + i] = bytes[i];
    recountChanges();
    hex.refresh();
    updateStatus();
    return true;
  }
  function recountChanges() {
    const a = tuningState.bin, b = tuningState.orig;
    if (!a || !b) { tuningState.changed = 0; return; }
    let n = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
    tuningState.changed = n;
  }
  function updateStatus() {
    const parts = [];
    if (tuningState.def) {
      const n = tuningState.def.items.length;
      parts.push(`${esc(tuningState.defName)} · ${n} item${n === 1 ? '' : 's'}`);
    }
    if (tuningState.changed) parts.push(`${tuningState.changed} byte${tuningState.changed === 1 ? '' : 's'} changed`);
    els.status.innerHTML = parts.map((p, i) =>
      i === 1 ? `<span class="tn-dirty">${p}</span>` : `<span>${p}</span>`).join('<span class="tn-sep">·</span>');
    sbRight.textContent = tuningState.bin
      ? `${fmtBytes(tuningState.bin.length)}${tuningState.changed ? ` · ${tuningState.changed} Δ` : ''}` : '';
  }

  // ==========================================================================
  // Definition tree + per-item editors
  // ==========================================================================
  function renderDefs() {
    const def = tuningState.def;
    els.defs.innerHTML = '';
    if (!def) {
      els.defs.appendChild(makeEmpty('⛃', 'Load a .xdf definition to edit named parameters.',
        'Without one you can still browse and edit raw hex.'));
      return;
    }

    // search box
    const searchWrap = document.createElement('div');
    searchWrap.className = 'tn-defs-search';
    searchWrap.innerHTML = `
      <span class="tn-defs-title">${esc(def.header.deftitle || 'Definition')}</span>
      <input type="text" class="tn-defs-filter" placeholder="Filter parameters…"
             spellcheck="false" autocomplete="off" value="${esc(tuningState.filter)}" />`;
    els.defs.appendChild(searchWrap);
    const filterInput = searchWrap.querySelector('.tn-defs-filter');

    const listWrap = document.createElement('div');
    listWrap.className = 'tn-defs-list';
    els.defs.appendChild(listWrap);

    // group items by category (an item can appear in several; also collect the
    // uncategorised into "Other")
    const cats = def.header.categories || [];
    const catName = (idx) => {
      const c = cats.find((x) => x.index === idx);
      return c ? c.name : `Category ${idx}`;
    };

    function buildGroups(filter) {
      const f = filter.trim().toLowerCase();
      const match = (it) => !f
        || (it.title || '').toLowerCase().includes(f)
        || (it.description || '').toLowerCase().includes(f)
        || it.kind.includes(f);
      const groups = new Map();      // name -> items[]
      const push = (name, it) => { if (!groups.has(name)) groups.set(name, []); groups.get(name).push(it); };
      for (const it of def.items) {
        if (!match(it)) continue;
        if (it.categoryIndices && it.categoryIndices.length) {
          for (const ci of it.categoryIndices) push(catName(ci), it);
        } else {
          push('Other', it);
        }
      }
      return groups;
    }

    function renderList() {
      listWrap.innerHTML = '';
      const groups = buildGroups(tuningState.filter);
      if (!groups.size) {
        listWrap.appendChild(makeEmpty('⌕', 'No parameters match.', ''));
        return;
      }
      let shown = 0;
      for (const [name, items] of groups) {
        const cat = document.createElement('div');
        cat.className = 'tn-cat';
        cat.innerHTML = `<div class="tn-cat-head">
            <span class="tn-cat-name">${esc(name)}</span>
            <span class="tn-cat-count">${items.length}</span>
          </div>`;
        const body = document.createElement('div');
        body.className = 'tn-cat-body';
        for (const it of items) {
          shown++;
          body.appendChild(renderItemRow(it));
        }
        cat.appendChild(body);
        listWrap.appendChild(cat);
      }
      els.hexMeta && (els.hexMeta.dataset.shown = String(shown));
    }

    let debounce = null;
    filterInput.oninput = () => {
      tuningState.filter = filterInput.value;
      clearTimeout(debounce);
      debounce = setTimeout(renderList, 100);
    };

    renderList();
  }

  // a single definition row; selecting it spotlights its bytes and expands the
  // editor beneath it
  function renderItemRow(item) {
    const row = document.createElement('div');
    row.className = 'tn-item' + (tuningState.selectedId === item.uniqueid ? ' open' : '');
    const kindTag = { constant: 'VAL', flag: 'FLG', table: 'TBL', patch: 'PATCH' }[item.kind] || item.kind;
    const addr = itemAddress(item);
    row.innerHTML = `
      <button class="tn-item-head" type="button">
        <span class="tn-item-kind tn-kind-${item.kind}">${kindTag}</span>
        <span class="tn-item-title">${esc(item.title || '(untitled)')}</span>
        <span class="tn-item-addr">${addr != null ? '0x' + addr.toString(16).toUpperCase() : ''}</span>
      </button>
      <div class="tn-item-body"></div>`;
    const headBtn = row.querySelector('.tn-item-head');
    const body = row.querySelector('.tn-item-body');
    headBtn.onclick = () => {
      const isOpen = tuningState.selectedId === item.uniqueid;
      // close others (accordion)
      els.defs.querySelectorAll('.tn-item.open').forEach((n) => {
        n.classList.remove('open');
        const b = n.querySelector('.tn-item-body'); if (b) b.innerHTML = '';
      });
      if (isOpen) {
        tuningState.selectedId = null;
        tuningState.highlight = null;
        hex.refresh();
        return;
      }
      tuningState.selectedId = item.uniqueid;
      row.classList.add('open');
      renderEditor(item, body);
      spotlight(item);
    };
    if (tuningState.selectedId === item.uniqueid) {
      renderEditor(item, body);
      spotlight(item);
    }
    return row;
  }

  // highlight an item's byte footprint in the hex view and scroll it into view
  function spotlight(item) {
    const range = itemByteRange(item);
    tuningState.highlight = range;
    hex.refresh();
    if (range) hex.scrollTo(range.start);
  }

  function itemAddress(item) {
    const h = tuningState.def.header;
    if (item.kind === 'constant' || item.kind === 'flag') {
      return window.XDF.resolveEmbedded(item.embed, h.baseOffset, h.defaults).address;
    }
    if (item.kind === 'table') {
      const z = item.axes.find((a) => a.id === 'z');
      if (z) return window.XDF.resolveEmbedded(z.embed, h.baseOffset, h.defaults).address;
    }
    if (item.kind === 'patch' && item.entries.length) return item.entries[0].address;
    return null;
  }

  // the contiguous byte span an item occupies (best-effort, for highlighting)
  function itemByteRange(item) {
    const h = tuningState.def.header;
    if (item.kind === 'constant') {
      const s = window.XDF.resolveEmbedded(item.embed, h.baseOffset, h.defaults);
      return { start: s.address, end: s.address + Math.max(1, Math.ceil(s.sizeBits / 8)) };
    }
    if (item.kind === 'flag') {
      const s = window.XDF.resolveEmbedded(item.embed, h.baseOffset, h.defaults);
      return { start: s.address, end: s.address + 1 };
    }
    if (item.kind === 'table') {
      const t = window.XDF.decodeTable(item, tuningState.bin || new Uint8Array(0), h);
      if (!t) return null;
      const first = window.XDF.tableCellAddress(t.embed, 0, 0);
      const last = window.XDF.tableCellAddress(t.embed, t.rows - 1, t.cols - 1);
      if (first == null || last == null) return null;
      const bytesPer = Math.max(1, Math.ceil(t.spec.sizeBits / 8));
      return { start: Math.min(first, last), end: Math.max(first, last) + bytesPer };
    }
    if (item.kind === 'patch' && item.entries.length) {
      const e = item.entries[0];
      return { start: e.address, end: e.address + e.patchdata.length };
    }
    return null;
  }

  // -------- per-kind editors ------------------------------------------------
  function renderEditor(item, container) {
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
    if (item.kind === 'constant') return renderConstantEditor(item, container);
    if (item.kind === 'flag') return renderFlagEditor(item, container);
    if (item.kind === 'table') return renderTableEditor(item, container);
    if (item.kind === 'patch') return renderPatchEditor(item, container);
  }

  function renderConstantEditor(item, container) {
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
        ${item.rangelow != null || item.rangehigh != null
          ? `<span>range ${item.rangelow != null ? fmtNum(item.rangelow, dp) : '−∞'} … ${item.rangehigh != null ? fmtNum(item.rangehigh, dp) : '+∞'}</span>` : ''}
        <span class="tn-raw" id="tn-raw"></span>
      </div>
      ${invertible ? '' : '<div class="tn-warn">This parameter’s MATH is not invertible; read-only.</div>'}`;
    container.appendChild(wrap);

    const numEl = wrap.querySelector('.tn-num');
    const applyBtn = wrap.querySelector('.tn-apply');
    const rawEl = wrap.querySelector('#tn-raw');
    const showRaw = () => {
      const spec = window.XDF.resolveEmbedded(item.embed, h.baseOffset, h.defaults);
      const raw = window.XDF.readScalar(tuningState.bin, spec);
      rawEl.textContent = raw == null ? '' : `raw ${raw} · ${Math.max(1, Math.ceil(spec.sizeBits / 8))} B ${spec.lsbfirst ? 'LE' : 'BE'}${spec.signed ? ' signed' : ''}`;
    };
    showRaw();

    const apply = () => {
      const v = Number(numEl.value);
      if (!Number.isFinite(v)) { shake(numEl); return; }
      if ((item.rangelow != null && v < item.rangelow) || (item.rangehigh != null && v > item.rangehigh)) {
        shake(numEl); els.status.textContent = 'value out of range'; return;
      }
      const enc = window.XDF.encodeConstant(item, v, h);
      if (!enc) { shake(numEl); els.status.textContent = 'value does not fit this field'; return; }
      writeBytes(enc.address, enc.bytes);
      // read the value back so scaling/rounding is reflected honestly
      const back = window.XDF.decodeConstant(item, tuningState.bin, h);
      numEl.value = back == null ? '' : fmtNum(back, dp);
      showRaw();
      tnFlash(applyBtn);
    };
    applyBtn.onclick = apply;
    numEl.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } };
  }

  function renderFlagEditor(item, container) {
    const on = window.XDF.readFlag(tuningState.bin, itemAddress(item), item.mask);
    const wrap = document.createElement('div');
    wrap.className = 'tn-edit';
    wrap.innerHTML = `
      <label class="tn-toggle">
        <input type="checkbox" ${on ? 'checked' : ''} />
        <span class="tn-toggle-track"><span class="tn-toggle-dot"></span></span>
        <span class="tn-toggle-label">${on ? 'On' : 'Off'}</span>
      </label>
      <div class="tn-meta"><span>bit mask <code>0x${item.mask.toString(16).toUpperCase()}</code> @ byte 0x${itemAddress(item).toString(16).toUpperCase()}</span></div>`;
    container.appendChild(wrap);
    const cb = wrap.querySelector('input');
    const label = wrap.querySelector('.tn-toggle-label');
    cb.onchange = () => {
      const addr = itemAddress(item);
      const next = window.XDF.applyFlag(tuningState.bin[addr], item.mask, cb.checked);
      writeBytes(addr, new Uint8Array([next]));
      label.textContent = cb.checked ? 'On' : 'Off';
    };
  }

  function renderTableEditor(item, container) {
    const h = tuningState.def.header;
    const t = window.XDF.decodeTable(item, tuningState.bin, h);
    if (!t) { container.appendChild(makeNote('This table has no Z axis to edit.')); return; }
    const invertible = window.XDF.invertLinear(t.z.mathEquation) !== null;
    const dp = t.z.decimalpl != null ? t.z.decimalpl : h.defaults.sigdigits;

    const info = document.createElement('div');
    info.className = 'tn-meta';
    info.innerHTML = `<span>${t.rows} × ${t.cols}</span>`
      + `<span>MATH <code>${esc(t.z.mathEquation)}</code></span>`
      + (t.z.units ? `<span>${esc(t.z.units)}</span>` : '')
      + (invertible ? '' : '<span class="tn-warn-inline">read-only (MATH not invertible)</span>');
    container.appendChild(info);

    // column headers from the X axis labels when present
    const xLabels = axisLabels(t.x, t.cols, h);
    const yLabels = axisLabels(t.y, t.rows, h);

    const scroll = document.createElement('div');
    scroll.className = 'tn-table-scroll';
    const grid = document.createElement('table');
    grid.className = 'tn-table';
    let thead = '<thead><tr><th class="tn-corner"></th>';
    for (let c = 0; c < t.cols; c++) thead += `<th>${esc(xLabels[c] != null ? xLabels[c] : c)}</th>`;
    thead += '</tr></thead>';
    grid.innerHTML = thead;
    const tbody = document.createElement('tbody');
    for (let r = 0; r < t.rows; r++) {
      const tr = document.createElement('tr');
      const rh = document.createElement('th');
      rh.className = 'tn-rowhead';
      rh.textContent = yLabels[r] != null ? yLabels[r] : r;
      tr.appendChild(rh);
      for (let c = 0; c < t.cols; c++) {
        const td = document.createElement('td');
        const cell = t.cells[r][c];
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'tn-cell';
        input.value = cell == null ? '' : fmtNum(cell, dp);
        input.disabled = !invertible || cell == null;
        input.dataset.r = r; input.dataset.c = c;
        input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); commitCell(input); } };
        input.onblur = () => commitCell(input);
        td.appendChild(input);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    grid.appendChild(tbody);
    scroll.appendChild(grid);
    container.appendChild(scroll);

    function commitCell(input) {
      const r = Number(input.dataset.r), c = Number(input.dataset.c);
      const v = Number(input.value);
      if (!Number.isFinite(v)) { input.value = fmtNum(t.cells[r][c], dp); return; }
      const enc = window.XDF.encodeTableCell(item, h, r, c, v);
      if (!enc) { shake(input); return; }
      writeBytes(enc.address, enc.bytes);
      const re = window.XDF.decodeTable(item, tuningState.bin, h);
      t.cells = re.cells;
      input.value = fmtNum(re.cells[r][c], dp);
      input.classList.add('tn-cell-edited');
    }
  }

  function renderPatchEditor(item, container) {
    const h = tuningState.def.header;
    const wrap = document.createElement('div');
    wrap.className = 'tn-edit tn-patch';
    for (const e of item.entries) {
      const state = window.XDF.patchEntryState(tuningState.bin, e.address, e.patchdata, e.basedata);
      const row = document.createElement('div');
      row.className = 'tn-patch-row';
      const canRevert = e.basedata.length === e.patchdata.length && e.basedata.length > 0;
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
        writeBytes(e.address, e.patchdata);
        renderDefs();   // refresh states
      };
      const rev = row.querySelector('.tn-patch-revert');
      if (canRevert) rev.onclick = () => { writeBytes(e.address, e.basedata); renderDefs(); };
      wrap.appendChild(row);
    }
    container.appendChild(wrap);
  }

  // axis display labels: explicit LABELs win, else the decoded axis values
  function axisLabels(axis, count, header) {
    const out = new Array(count).fill(null);
    if (!axis) return out;
    if (axis.labels && axis.labels.length) {
      for (const l of axis.labels) if (l.index < count) out[l.index] = l.value;
      if (out.some((x) => x != null)) return out;
    }
    // decode the axis scale from the image when it points at real bytes
    if (tuningState.bin && axis.embed && axis.embed.address) {
      const spec = window.XDF.resolveEmbedded(axis.embed, header.baseOffset, header.defaults);
      let conv; try { conv = window.XDF.compileMath(axis.mathEquation); } catch (e) { conv = (v) => v; }
      const per = Math.max(1, Math.ceil(spec.sizeBits / 8));
      for (let i = 0; i < count; i++) {
        const raw = window.XDF.readScalar(tuningState.bin, Object.assign({}, spec, { address: spec.address + i * per }));
        if (raw != null) out[i] = fmtNum(conv(raw), axis.decimalpl != null ? axis.decimalpl : 0);
      }
    }
    return out;
  }

  // ==========================================================================
  // jump-to-offset
  // ==========================================================================
  els.goto.onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    const raw = els.goto.value.trim();
    if (!raw) return;
    const off = /^0x/i.test(raw) ? parseInt(raw, 16) : parseInt(raw, 10);
    if (Number.isFinite(off) && tuningState.bin && off >= 0 && off < tuningState.bin.length) {
      hex.scrollTo(off);
    } else {
      shake(els.goto);
    }
  };

  // restore any state from a previous visit
  if (tuningState.bin) {
    els.loadXdf.disabled = false;
    els.save.disabled = false;
    els.file.textContent = `${tuningState.fileName} · ${fmtBytes(tuningState.bin.length)}`;
    hex.refresh();
  }
  if (tuningState.def) renderDefs();
  updateStatus();

  setActions([
    { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: () => showApps() },
    { key: '1', label: 'Load BIN', fn: () => els.loadBin.click() },
    { key: '2', label: 'Load .xdf', fn: () => !els.loadXdf.disabled && els.loadXdf.click() },
    { key: '3', label: 'Save', fn: () => !els.save.disabled && els.save.click() },
  ]);
}

// ============================================================================
// Virtualized hex grid factory. Renders only the rows in (and near) the
// viewport; a spacer div carries the full scroll height. 16 bytes/row.
// ============================================================================
function createHexView(els) {
  const { BYTES_PER_ROW, ROW_H, OVERSCAN } = TUNE_HEX;
  let raf = null;

  function rowHtml(off, bytes) {
    const len = Math.min(BYTES_PER_ROW, bytes.length - off);
    const hl = tuningState.highlight;
    let hexCells = '';
    let ascii = '';
    for (let i = 0; i < BYTES_PER_ROW; i++) {
      if (i >= len) { hexCells += '<span class="tn-hb tn-hb-pad">  </span>'; ascii += ' '; continue; }
      const abs = off + i;
      const b = bytes[abs];
      const changed = tuningState.orig && tuningState.orig[abs] !== b;
      const inHl = hl && abs >= hl.start && abs < hl.end;
      let cls = 'tn-hb';
      if (changed) cls += ' tn-hb-changed';
      if (inHl) cls += ' tn-hb-hl';
      hexCells += `<span class="${cls}" data-off="${abs}" title="0x${abs.toString(16).toUpperCase()}">${b.toString(16).padStart(2, '0').toUpperCase()}</span>`;
      const ch = b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
      ascii += `<span class="tn-ha${inHl ? ' tn-ha-hl' : ''}${changed ? ' tn-ha-changed' : ''}">${ch === '<' ? '&lt;' : ch === '&' ? '&amp;' : ch}</span>`;
    }
    return `<div class="tn-hex-row" style="height:${ROW_H}px">`
      + `<span class="tn-hoff">${off.toString(16).padStart(6, '0').toUpperCase()}</span>`
      + `<span class="tn-hbytes">${hexCells}</span>`
      + `<span class="tn-hascii">${ascii}</span></div>`;
  }

  function render() {
    raf = null;
    const bytes = tuningState.bin;
    if (!bytes) {
      els.hexEmpty.hidden = false;
      els.hexSpacer.hidden = true;
      return;
    }
    els.hexEmpty.hidden = true;
    els.hexSpacer.hidden = false;
    const totalRows = Math.ceil(bytes.length / BYTES_PER_ROW);
    els.hexSpacer.style.height = totalRows * ROW_H + 'px';
    const st = els.hexScroll.scrollTop;
    const vh = els.hexScroll.clientHeight || 480;
    const first = Math.max(0, Math.floor(st / ROW_H) - OVERSCAN);
    const count = Math.min(totalRows - first, Math.ceil(vh / ROW_H) + 2 * OVERSCAN);
    els.hexWindow.style.transform = `translateY(${first * ROW_H}px)`;
    let html = '';
    for (let r = 0; r < count; r++) {
      const off = (first + r) * BYTES_PER_ROW;
      html += rowHtml(off, bytes);
    }
    els.hexWindow.innerHTML = html;
    if (els.hexMeta) {
      els.hexMeta.textContent = `${totalRows.toLocaleString()} rows · ${fmtBytes(bytes.length)}`;
    }
  }

  const schedule = () => { if (raf == null) raf = requestAnimationFrame(render); };
  els.hexScroll.addEventListener('scroll', schedule, { passive: true });

  // double-click a byte to edit it raw
  els.hexWindow.addEventListener('dblclick', (e) => {
    const cell = e.target.closest && e.target.closest('.tn-hb[data-off]');
    if (!cell || !tuningState.bin) return;
    const off = Number(cell.dataset.off);
    editRawByte(off);
  });

  async function editRawByte(off) {
    const cur = tuningState.bin[off];
    const v = await inputDialog({
      title: `Edit byte 0x${off.toString(16).toUpperCase()}`,
      body: `Current value 0x${cur.toString(16).padStart(2, '0').toUpperCase()} (${cur}). Enter a new byte as hex (00–FF) or decimal.`,
      kind: 'text', example: 'FF', confirmLabel: 'Write',
    });
    if (v == null) return;
    const parsed = /^0x/i.test(v) || /[a-f]/i.test(v) ? parseInt(v, 16) : parseInt(v, 10);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 0xff) return;
    tuningState.bin[off] = parsed & 0xff;
    render();
  }

  return {
    refresh: schedule,
    scrollTo(off) {
      const row = Math.floor(off / BYTES_PER_ROW);
      const top = row * ROW_H;
      const vh = els.hexScroll.clientHeight || 480;
      els.hexScroll.scrollTop = Math.max(0, top - vh / 2);
      schedule();
    },
  };
}

// ---- small shared helpers --------------------------------------------------
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
function fmtNum(v, dp) {
  if (v == null || !Number.isFinite(v)) return '';
  if (dp == null || dp < 0) dp = 2;
  // integers show clean; otherwise fixed to dp then trim trailing zeros
  if (Number.isInteger(v)) return String(v);
  const s = v.toFixed(Math.min(dp, 8));
  return s.replace(/\.?0+$/, '');
}
function makeEmpty(icon, title, sub) {
  const d = document.createElement('div');
  d.className = 'tn-empty';
  d.innerHTML = `<div class="tn-empty-icon">${icon}</div><div>${title}</div>`
    + (sub ? `<div class="tn-empty-sub">${sub}</div>` : '');
  return d;
}
function makeNote(text) {
  const d = document.createElement('div');
  d.className = 'tn-note';
  d.textContent = text;
  return d;
}
function shake(el) {
  el.classList.add('tn-shake');
  setTimeout(() => el.classList.remove('tn-shake'), 350);
}
function tnFlash(el) {
  el.classList.add('tn-flash');
  setTimeout(() => el.classList.remove('tn-flash'), 400);
}
