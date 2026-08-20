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
  defText: null,      // the .xdf SOURCE, kept so a reload can re-parse it
                      // (the parsed graph is too big to store, and re-parsing
                      // 4.7 MB costs ~290 ms -- see core/tuning-store.js)
  selectedId: null,   // stable key of the open item (xdf.js `key`)
  changed: 0,         // count of bytes differing from orig
  highlight: null,    // { start, end } byte range to spotlight in the hex view
  filter: '',         // definition-tree search text
  // Category names the user has expanded. Closed is the default: a real
  // definition is ~300 categories deep (MS45.1 has 298), and rendering every
  // row of every one buries the thing you came for. A filter overrides this
  // -- see renderList.
  openCats: null,     // Set<string>, lazily created per definition
  shutCats: null,     // Set<string>: sections collapsed while a filter is on
  // MAP OVERLAY. A byte -> colour-slot index over the whole BIN, so the hex
  // pane can show at a glance which areas the definition describes and where
  // one parameter ends and the next begins -- without clicking anything.
  // 0 = not described; 1..COVER_COLOURS = a slot. Built once per (def, bin).
  cover: null,        // Uint8Array | null: byte -> colour slot
  owner: null,        // Int32Array | null: byte -> 1-based index into owners
  owners: null,       // [{item, start, end}] the region each byte belongs to
  coverOn: true,      // user toggle
  coverInfo: null,    // { described, total, items } for the legend
  // Which item kinds the list shows. A Set of 'constant'|'flag'|'table'|
  // 'patch', or null for "everything" -- null rather than a full Set so a
  // definition carrying a kind we have not met still shows by default.
  kinds: null,
};

// Where the shared definition library lives. Same pattern as screens/etk.js
// and core/translate.js: a HuggingFace dataset served over plain HTTPS, no
// auth, CORS-readable. The three mirrors carry identical content -- if one is
// unreachable we try the next rather than giving up.
const XDF_MIRRORS = [
  'https://huggingface.co/datasets/CraigFf/bmw-files/resolve/main/tuning/xdf/',
  'https://huggingface.co/datasets/HarryG8/bmw-files/resolve/main/tuning/xdf/',
  'https://huggingface.co/datasets/VerilP0/bmw-files/resolve/main/tuning/xdf/',
];

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
    <button class="btn tn-read-ecu">Read from ECU…</button>
    <button class="btn tn-load-xdf" disabled>Load .xdf…</button>
    <button class="btn primary tn-save" disabled>Save BIN…</button>
    <button class="btn tn-clear" disabled title="Unload the firmware and definition, and forget the saved session">Clear</button>
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
        <button type="button" class="tn-map-toggle" id="tn-map-toggle" hidden
                title="Shade the bytes this definition describes">
          <span class="tn-map-swatches" aria-hidden="true"></span>
          <span class="tn-map-label">map</span>
        </button>
        <label class="tn-goto-wrap">jump
          <input type="text" class="tn-goto" id="tn-goto" placeholder="0x0000"
                 spellcheck="false" autocomplete="off"
                 title="Absolute (0x1000, 4096) or relative (+0x100, -256)" />
        </label>
        <label class="tn-goto-wrap">cols
          <select class="tn-cols" id="tn-cols" title="Bytes per row">
            <option value="8">8</option>
            <option value="16" selected>16</option>
            <option value="32">32</option>
          </select>
        </label>
        <span class="tn-hex-meta" id="tn-hex-meta"></span>
      </div>
      <div class="tn-find" id="tn-find">
        <label class="tn-goto-wrap">find
          <input type="text" class="tn-goto tn-find-q" id="tn-find-q" placeholder="DE AD BE EF"
                 spellcheck="false" autocomplete="off" />
        </label>
        <div class="tn-find-modes" id="tn-find-modes">
          <button type="button" class="tn-find-mode on" data-mode="hex">hex</button>
          <button type="button" class="tn-find-mode" data-mode="text">text</button>
        </div>
        <button type="button" class="tn-find-nav" id="tn-find-prev" title="Previous match (Shift+Enter)">◀</button>
        <button type="button" class="tn-find-nav" id="tn-find-next" title="Next match (Enter)">▶</button>
        <span class="tn-find-count" id="tn-find-count"></span>
      </div>
      <div class="tn-hex-body">
        <div class="tn-hex-scroll" id="tn-hex-scroll" tabindex="0">
          <div class="tn-hex-empty" id="tn-hex-empty">No BIN loaded.</div>
          <div class="tn-hex-spacer" id="tn-hex-spacer" hidden>
            <div class="tn-hex-window" id="tn-hex-window"></div>
          </div>
        </div>
        <aside class="tn-insp" id="tn-insp">
          <div class="tn-insp-head">
            <span>Data inspector</span>
          </div>
          <div class="tn-insp-rows" id="tn-insp-rows"></div>
        </aside>
      </div>
      <div class="tn-hex-status" id="tn-hex-status">
        <span class="tn-hs-cur" id="tn-hs-cur"></span>
        <span class="tn-hs-sel" id="tn-hs-sel"></span>
        <span class="tn-hs-hint" id="tn-hs-hint">click-drag to select · ⇧-click extends · arrows move · dbl-click edits</span>
      </div>
    </section>`;
  view.appendChild(workspace);

  const els = {
    loadBin: bar.querySelector('.tn-load-bin'),
    readEcu: bar.querySelector('.tn-read-ecu'),
    loadXdf: bar.querySelector('.tn-load-xdf'),
    clear: bar.querySelector('.tn-clear'),
    save: bar.querySelector('.tn-save'),
    file: bar.querySelector('#tn-file'),
    status: bar.querySelector('#tn-status'),
    binInput: bar.querySelector('#tn-bin-input'),
    xdfInput: bar.querySelector('#tn-xdf-input'),
    defs: workspace.querySelector('#tn-defs'),
    hexPane: workspace.querySelector('#tn-hexpane'),
    hexScroll: workspace.querySelector('#tn-hex-scroll'),
    hexSpacer: workspace.querySelector('#tn-hex-spacer'),
    hexWindow: workspace.querySelector('#tn-hex-window'),
    hexEmpty: workspace.querySelector('#tn-hex-empty'),
    hexMeta: workspace.querySelector('#tn-hex-meta'),
    mapToggle: workspace.querySelector('#tn-map-toggle'),
    goto: workspace.querySelector('#tn-goto'),
    cols: workspace.querySelector('#tn-cols'),
    insp: workspace.querySelector('#tn-insp'),
    inspRows: workspace.querySelector('#tn-insp-rows'),
    findQ: workspace.querySelector('#tn-find-q'),
    findModes: workspace.querySelector('#tn-find-modes'),
    findPrev: workspace.querySelector('#tn-find-prev'),
    findNext: workspace.querySelector('#tn-find-next'),
    findCount: workspace.querySelector('#tn-find-count'),
    hsCur: workspace.querySelector('#tn-hs-cur'),
    hsSel: workspace.querySelector('#tn-hs-sel'),
  };

  // ==========================================================================
  // Virtualized hex view -- only the visible rows exist in the DOM, so a
  // multi-MB image scrolls without laying out hundreds of thousands of rows.
  // ==========================================================================
  const hex = createHexView(els, {
    onByteClick: (off) => openItemAt(off),
    onWriteByte: (off, val) => writeBytes(off, new Uint8Array([val])),
    // one call for a range: a fill or a paste is a single edit, so it should
    // be one write (and one undo step), not N
    onWriteBytes: (off, buf) => writeBytes(off, buf),
    // what the context menu shows on "Open ..." -- the name of the parameter
    // that owns this byte, or null when the definition describes nothing here
    // Nearest byte the definition actually describes, searching outward from
    // `off`. Bounded: a right-click must not walk a 1 MB array, and if there
    // is nothing within a few hundred KB the honest answer is "nowhere near".
    nearestMapped: (off) => {
      const owner = tuningState.owner;
      if (!owner || !owner.length) return null;
      const LIMIT = 1 << 18;                   // 256 KB either way
      for (let d = 1; d <= LIMIT; d++) {
        const a = off - d;
        if (a >= 0 && owner[a]) return a;
        const b = off + d;
        if (b < owner.length && owner[b]) return b;
        if (a < 0 && b >= owner.length) break;  // ran off both ends
      }
      return null;
    },
    ownerAt: (off) => {
      const owner = tuningState.owner;
      const owners = tuningState.owners;
      if (!owner || !owners || off < 0 || off >= owner.length) return null;
      const oid = owner[off];
      const rec = oid ? owners[oid - 1] : null;
      return rec && rec.item ? (rec.item.title || null) : null;
    },
  });

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

  // the legend: one dot per colour slot, so the rotation is self-explaining
  if (els.mapToggle) {
    els.mapToggle.querySelector('.tn-map-swatches').innerHTML =
      Array.from({ length: 8 }, (_, i) => `<i class="tn-cv${i + 1}"></i>`).join('');
    els.mapToggle.onclick = () => {
      tuningState.coverOn = !tuningState.coverOn;
      updateStatus();
      hex.refresh();
    };
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
      buildCoverage();          // addresses are BIN-relative; rebuild for this image
      saveSoon();
      hex.refresh();
      offerDefinitionFor(bytes);   // ask, never auto-load
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
      tuningState.defText = text;
      tuningState.defName = file.name || 'definition.xdf';
      tuningState.selectedId = null;
      // a kind filter belongs to the definition that was open, not to the
      // next one -- carrying it over could hide every item in the new file
      tuningState.kinds = null;
      tuningState.openCats = null;   // and every section starts collapsed
      tuningState.shutCats = null;
      buildCoverage();
      saveSoon();
      renderDefs();
      hex.refresh();            // the map only exists once a definition is open
      updateStatus();
    } catch (e) {
      // parse errors (bad XML, encrypted) surface in the defs pane, non-fatally
      tuningState.def = null;
      els.defs.innerHTML = '';
      els.defs.appendChild(makeEmpty('⚠', `Could not parse ${esc(file.name || '.xdf')}`,
        esc(e.message)));
    }
  }

  // ---- Read from ECU -------------------------------------------------------
  // Pull a live memory image off a module and treat it exactly like a loaded
  // file, so the whole hex editor (find, inspector, goto, .xdf overlay) works
  // on it unchanged. READ ONLY: every job offered here is a *_LESEN.
  //
  // The regions are not hardcoded and not mined from an INPA screen -- they
  // come from each job's own argument spec, which declares its address range,
  // its max chunk, and crucially its UNIT. kombi46's EEPROM_LESEN addresses
  // and counts 2-byte WORDS; its ROM_LESEN counts BYTES. See tuning-memory.js.
  async function onReadFromEcu() {
    if (typeof window.TuningMemory === 'undefined') {
      els.status.textContent = 'memory reader not loaded';
      return;
    }
    const TM = window.TuningMemory;

    let sgbds = [];
    try {
      sgbds = (typeof tool32SgbdList === 'function') ? await tool32SgbdList() : [];
    } catch (e) { /* fall through to the empty-state below */ }

    const { overlay, close } = openModal(`
      <div class="modal tn-ecu-modal" role="dialog" aria-modal="true">
        <div class="modal-title">Read memory from an ECU</div>
        <div class="modal-body">
          <div class="tn-ecu-row">
            <label class="tn-ecu-lbl" for="tn-ecu-sgbd">Module</label>
            <div class="tn-ecu-combo" id="tn-ecu-combo">
              <input class="tn-ecu-in" id="tn-ecu-sgbd" role="combobox"
                     aria-expanded="false" aria-controls="tn-ecu-sug" aria-autocomplete="list"
                     placeholder="Select or search a module…" spellcheck="false" autocomplete="off">
              <button type="button" class="tn-ecu-caret" id="tn-ecu-caret"
                      aria-label="Show all modules" tabindex="-1">▾</button>
            </div>
          </div>
          <div class="tn-ecu-sug" id="tn-ecu-sug" role="listbox" hidden></div>
          <div class="tn-ecu-regions" id="tn-ecu-regions">
            <div class="tn-ecu-hint">Pick a module to see what it can read.</div>
          </div>
          <div class="tn-ecu-prog" id="tn-ecu-prog" hidden></div>
        </div>
        <div class="modal-actions">
          <button class="btn" id="tn-ecu-cancel">Cancel</button>
          <button class="btn primary" id="tn-ecu-go" disabled>Read</button>
        </div>
      </div>`, { backdropValue: null });

    const $ = (sel) => overlay.querySelector(sel);
    const sgbdIn = $('#tn-ecu-sgbd');
    const regionBox = $('#tn-ecu-regions');
    const prog = $('#tn-ecu-prog');
    const goBtn = $('#tn-ecu-go');
    const st = { sgbd: '', regions: [], pick: null, busy: false, cancel: false };

    $('#tn-ecu-cancel').onclick = () => { st.cancel = true; close(); };

    const fmtAddr = (n, wide) => '0x' + n.toString(16).toUpperCase()
      .padStart(wide ? 4 : 2, '0');

    function paintRegions() {
      if (!st.regions.length) {
        regionBox.innerHTML = `<div class="tn-ecu-hint">`
          + `This module declares no readable memory region.</div>`;
        goBtn.disabled = true;
        return;
      }
      regionBox.innerHTML = st.regions.map((r, i) => {
        const wide = r.hi > 0xFF;
        const span = r.hi - r.lo + 1;
        const bytes = span * r.wordBytes;
        const sel = r.types.length
          ? `<select class="tn-ecu-type" data-i="${i}">${
              r.types.map(t => `<option>${esc(t)}</option>`).join('')}</select>`
          : '';
        return `<label class="tn-ecu-region">
          <input type="radio" name="tn-ecu-r" value="${i}">
          <span class="tn-ecu-job">${esc(r.job)}</span>
          <span class="tn-ecu-meta">${fmtAddr(r.lo, wide)}–${fmtAddr(r.hi, wide)}`
          + ` · ${span} ${r.unit === 'word' ? 'words' : 'bytes'}`
          + (r.unit === 'word' ? ` (${bytes} bytes)` : '')
          + ` · ${r.max}/read</span>${sel}</label>`;
      }).join('');
      regionBox.querySelectorAll('input[name=tn-ecu-r]').forEach(el => {
        el.onchange = () => {
          st.pick = st.regions[+el.value];
          goBtn.disabled = false;
        };
      });
      regionBox.querySelectorAll('.tn-ecu-type').forEach(sel => {
        sel.onchange = () => { st.regions[+sel.dataset.i].selType = sel.value; };
      });
    }

    // A DROPDOWN, not a bare search box. A native <datalist> renders in OS
    // chrome -- it escaped the modal, ignored the theme, and offered no way to
    // browse. This opens on click showing every module, and typing narrows it.
    // The list is in normal flow inside the dialog rather than floating, so it
    // can neither be clipped by the modal nor overlap the page behind it.
    const sug = $('#tn-ecu-sug');
    const caret = $('#tn-ecu-caret');
    let sugItems = [];
    let sugAt = -1;
    let sugOpen = false;

    function closeSug() {
      sugOpen = false;
      sug.hidden = true; sug.innerHTML = ''; sugItems = []; sugAt = -1;
      sgbdIn.setAttribute('aria-expanded', 'false');
    }

    function paintSug() {
      if (!sugItems.length) {
        sug.hidden = false;
        sug.innerHTML = '<div class="tn-ecu-sug-empty">No module matches.</div>';
        sgbdIn.setAttribute('aria-expanded', 'true');
        return;
      }
      sug.innerHTML = sugItems.map((name, i) =>
        `<button type="button" class="etk-lb-row tn-ecu-sug-row${i === sugAt ? ' active' : ''}"`
        + ` role="option" data-i="${i}">${esc(name)}</button>`).join('');
      sug.hidden = false;
      sgbdIn.setAttribute('aria-expanded', 'true');
      sug.querySelectorAll('.tn-ecu-sug-row').forEach(el => {
        el.onmousedown = (ev) => {       // mousedown: fires before the input blurs
          ev.preventDefault();
          choose(sugItems[+el.dataset.i]);
        };
      });
      const active = sug.querySelector('.active');
      if (active) active.scrollIntoView({ block: 'nearest' });
    }

    function choose(name) {
      sgbdIn.value = name;
      closeSug();
      lookup();
    }

    // `all` = the caret / an empty box: show everything rather than nothing.
    function openSug(all) {
      sugOpen = true;
      const q = all ? '' : sgbdIn.value.trim().toLowerCase();
      if (!q) {
        sugItems = sgbds.slice(0, 400);
      } else {
        // Prefix matches first: typing "kom" should put kombi46 above a module
        // that merely contains those letters somewhere.
        const starts = [], has = [];
        for (const n of sgbds) {
          const l = n.toLowerCase();
          if (l.startsWith(q)) starts.push(n);
          else if (l.includes(q)) has.push(n);
        }
        sugItems = starts.concat(has).slice(0, 400);
      }
      // Keep the current value highlighted so reopening lands where you were.
      const cur = sgbdIn.value.trim().toLowerCase();
      sugAt = cur ? sugItems.findIndex(n => n.toLowerCase() === cur) : -1;
      paintSug();
    }

    caret.onmousedown = (e) => {
      e.preventDefault();               // don't steal focus from the input
      if (sugOpen) { closeSug(); return; }
      sgbdIn.focus();
      openSug(true);
    };
    sgbdIn.onfocus = () => { if (!sugOpen) openSug(!sgbdIn.value.trim()); };
    sgbdIn.onblur = () => setTimeout(closeSug, 120);

    sgbdIn.onkeydown = (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!sugOpen) { openSug(!sgbdIn.value.trim()); return; }
        if (!sugItems.length) return;
        sugAt += (e.key === 'ArrowDown' ? 1 : -1);
        if (sugAt < 0) sugAt = sugItems.length - 1;
        if (sugAt >= sugItems.length) sugAt = 0;
        paintSug();
      } else if (e.key === 'Enter') {
        if (sugOpen && sugAt >= 0) { e.preventDefault(); choose(sugItems[sugAt]); }
      } else if (e.key === 'Escape') {
        // Escape closes the list first, and only then the dialog.
        if (sugOpen) { e.stopPropagation(); closeSug(); }
      }
    };

    let lookupSeq = 0;
    async function lookup() {
      const sgbd = sgbdIn.value.trim().toLowerCase();
      st.sgbd = sgbd; st.pick = null; goBtn.disabled = true;
      if (!sgbd) {
        regionBox.innerHTML = `<div class="tn-ecu-hint">`
          + `Pick a module to see what it can read.</div>`;
        return;
      }
      const seq = ++lookupSeq;
      regionBox.innerHTML = `<div class="tn-ecu-hint">Reading ${esc(sgbd)} job list…</div>`;
      let regions = [];
      try { regions = await TM.regionsFor(sgbd); } catch (e) { regions = []; }
      if (seq !== lookupSeq) return;     // a newer lookup already won
      st.regions = regions;
      paintRegions();
    }
    sgbdIn.oninput = () => {
      openSug(false);                 // typing always narrows the open list
      clearTimeout(sgbdIn._t);
      sgbdIn._t = setTimeout(lookup, 250);
    };

    goBtn.onclick = async () => {
      if (!st.pick || st.busy) return;
      st.busy = true; st.cancel = false;
      goBtn.disabled = true; sgbdIn.disabled = true;
      prog.hidden = false;
      prog.textContent = 'Reading…';
      const r = st.pick;
      try {
        const { bytes, firstArg, demo } = await TM.readRange(
          st.sgbd, r, r.lo, r.hi,
          (done, total, arg) => {
            if (st.cancel) return false;
            const pct = Math.min(100, Math.round((done / total) * 100));
            prog.textContent = `${pct}%  ·  ${arg}`;
            return true;
          });
        // REFUSE a synthesized answer. With no cable the shim badges its reply
        // demo:true and hands back invented bytes; loading those into the hex
        // editor produces something indistinguishable from a real dump of the
        // car. A memory image you cannot trust is worse than no image.
        if (demo) {
          prog.innerHTML = '<b>No car is answering.</b><br>'
            + 'Connect the cable (or the WiFi adapter) and try again.';
          st.busy = false; goBtn.disabled = false; sgbdIn.disabled = false;
          return;
        }
        if (!bytes.length) {
          prog.textContent = 'The ECU returned no data.';
          st.busy = false; goBtn.disabled = false; sgbdIn.disabled = false;
          return;
        }
        // Hand it to the editor as a loaded image. tuningState.orig is the
        // same bytes so the dirty count starts at zero and any later edit is
        // measured against what the car actually holds.
        tuningState.bin = bytes;
        tuningState.orig = bytes.slice();
        tuningState.fileName = `${st.sgbd}-${r.job}.bin`;
        tuningState.changed = 0;
        tuningState.highlight = null;
        // Reading is not editing: the image came off a car, and there is no
        // write path back. Save is still offered because saving it to disk is
        // exactly how you keep a backup before touching anything.
        els.loadXdf.disabled = false;
        els.save.disabled = false;
        els.clear.disabled = false;
        els.file.textContent = `${tuningState.fileName} · ${fmtBytes(bytes.length)}`;
        buildCoverage();
        saveSoon();
        hex.refresh();
        if (tuningState.def) renderDefs();
        updateStatus();
        els.status.textContent = `read ${bytes.length} B from ${st.sgbd} · ${firstArg}`;
        close();
      } catch (e) {
        // Show the argument that failed: with a job whose spec we parsed, a
        // failure is usually the ECU refusing the range, not a bad format.
        const extra = e && e.arg ? ` · sent ${e.arg}` : '';
        prog.textContent = `${String(e.message || e)}${extra}`;
        st.busy = false; goBtn.disabled = false; sgbdIn.disabled = false;
      }
    };

    setTimeout(() => sgbdIn.focus(), 0);
  }

  els.readEcu.onclick = onReadFromEcu;
  els.loadBin.onclick = () => els.binInput.click();
  els.loadXdf.onclick = () => els.xdfInput.click();
  els.binInput.onchange = () => { onBinChosen(els.binInput.files[0]); els.binInput.value = ''; };
  els.xdfInput.onchange = () => { onXdfChosen(els.xdfInput.files[0]); els.xdfInput.value = ''; };

  // ==========================================================================
  // Definition auto-match
  // ==========================================================================
  //
  // On loading a BIN with no definition open, look for one that fits and OFFER
  // it. Never load silently: a definition decides how every byte is
  // interpreted, and a wrong one produces plausible-looking numbers at
  // plausible-looking addresses -- the worst kind of wrong. The user confirms.
  //
  // MATCHING IS TWO-STAGE, and both stages matter:
  //   1. SIZE picks the layout. The MS45.1 pair are otherwise identical
  //      definitions; only the BIN length distinguishes the 116 KB
  //      calibration-only read from the 1 MB full flash.
  //   2. The IDENTITY STRING proves the software version. Every MS45 image
  //      carries an ASCII block at the definition's own baseOffset
  //      ("LO00SJ2R457O0L..."); the definition's `software` field must appear
  //      in it. Size alone would happily match a same-length image built from
  //      different DME software.
  // A size hit WITHOUT the version confirmation is reported as a weak match
  // and says so in the prompt, rather than being hidden or auto-accepted.

  async function fetchXdfIndex() {
    for (const base of XDF_MIRRORS) {
      try {
        const r = await fetch(base + 'index.json', { cache: 'no-store' });
        if (!r.ok) continue;
        const j = await r.json();
        if (j && Array.isArray(j.definitions)) return { base, index: j };
      } catch (e) { /* try the next mirror */ }
    }
    return null;
  }

  // Read the ASCII identity block a definition expects at its baseOffset.
  function identityAt(bin, offset, len = 24) {
    if (!bin || offset < 0 || offset + 2 > bin.length) return '';
    let out = '';
    const end = Math.min(bin.length, offset + len);
    for (let i = offset; i < end; i++) {
      const b = bin[i];
      out += (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : ' ';
    }
    return out;
  }

  // Some definitions carry no ASCII header block at all. The pre-1996 DME
  // images instead store the BMW chip number as REVERSED ASCII digits (the
  // definitions label it "read hex backwards"): 0xFE4F reads "3267537621",
  // which reversed is the real part number 1267357623. An index entry opts
  // into this with identityReversed:true.
  function identityAtReversed(bin, offset, len = 10) {
    const fwd = identityAt(bin, offset, len);
    return fwd.split('').reverse().join('');
  }

  function matchDefinitions(bin, defs) {
    const out = [];
    for (const d of defs) {
      if (!d || typeof d.binSize !== 'number') continue;
      if (d.binSize !== bin.length) continue;              // stage 1: layout
      // The marker is NOT always at baseOffset: MS45 happens to put them in
      // the same place, MS43 keeps its identity block at 0x8 (64 KB layout)
      // or 0x70008 (512 KB), while its maps start at 0. So the index names
      // the offset explicitly and we fall back to baseOffset only for older
      // entries that predate the field.
      const at = (d.identityOffset != null) ? d.identityOffset : (d.baseOffset || 0);
      const identLen = (typeof d.identityLength === 'number') ? d.identityLength : 24;
      const ident = d.identityReversed
        ? identityAtReversed(bin, at, identLen)
        : identityAt(bin, at, identLen);
      // Three ways an entry can prove itself, strongest first:
      //   software       a fixed version string that must appear (MS43/MS45)
      //   knownParts     this exact chip is one we have seen for this DME
      //   identityPattern a well-formed BMW part number reads here at all --
      //                  weaker, but it still rules out the wrong DME family,
      //                  because the wrong offset yields obvious garbage.
      const trimmed = ident.trim();
      let confirmed = false;
      let via = '';
      if (d.software && ident.includes(d.software)) { confirmed = true; via = 'software'; }
      else if (Array.isArray(d.knownParts) && d.knownParts.includes(trimmed)) {
        confirmed = true; via = 'part';
      } else if (d.identityPattern && new RegExp(d.identityPattern).test(trimmed)) {
        confirmed = true; via = 'pattern';
      }
      out.push({ def: d, ident: trimmed, confirmed, via });
    }
    // Confirmed first, and among those the stronger evidence first: an exact
    // known chip number beats "a part number reads here".
    const rank = (h) => (h.confirmed ? (h.via === 'pattern' ? 1 : 2) : 0);
    out.sort((a, b) => rank(b) - rank(a));
    return out;
  }

  async function offerDefinitionFor(bin) {
    if (tuningState.def) return;                 // user already chose one
    if (!bin || typeof fetch !== 'function') return;
    let found = null;
    try { found = await fetchXdfIndex(); } catch (e) { return; }
    if (!found) return;                          // offline / mirrors down: silent
    const hits = matchDefinitions(bin, found.index.definitions);
    if (!hits.length) return;                    // nothing fits: say nothing
    if (tuningState.def) return;                 // they loaded one while we fetched

    const best = hits[0];
    const d = best.def;
    // The OBD1 definitions are tens of KB, not megabytes -- a fixed MB format
    // renders every one of them as "0.0 MB".
    const sizeKb = d.bytes >= 1048576
      ? `${(d.bytes / 1048576).toFixed(1)} MB`
      : `${Math.max(1, Math.round(d.bytes / 1024))} KB`;
    const ok = await confirmDialog({
      title: 'Definition found',
      body: `<p>This image matches a definition in the shared library.</p>`
        + `<div class="tn-match">`
        + `<div><b>${esc(d.title || d.file)}</b></div>`
        + `<div class="tn-match-row">${esc(d.ecu || '')} · `
        + (d.software
            ? `software <code>${esc(d.software)}</code>`
            // Only name a chip when one actually validated. On a size-only
            // hit `ident` is whatever bytes happened to sit at the offset --
            // printing that as "chip" dresses up noise as identification.
            : best.confirmed && best.ident
              ? `chip <code>${esc(best.ident.slice(0, 20))}</code>`
              : `${esc(d.items || '?')} items`)
        + ` · ${sizeKb}</div>`
        + (best.confirmed
            ? (best.via === 'pattern'
                ? `<div class="tn-match-warn">⚠ this looks like the right DME `
                  + `family — part number <code>${esc(best.ident.slice(0, 20))}</code> `
                  + `reads where this definition expects one, but it is not a chip `
                  + `we have seen. The addresses may not line up; check the maps `
                  + `look sane before editing.</div>`
                : `<div class="tn-match-ok">✓ version confirmed in the image `
                  + `(<code>${esc(best.ident.slice(0, 20))}</code>)</div>`)
            : `<div class="tn-match-warn">⚠ size matches but the software `
              + `version could not be confirmed in this image — the addresses `
              + `may not line up. Check before editing.</div>`)
        + `</div>`
        + `<p class="tn-match-foot">Downloading ${sizeKb}. Nothing is uploaded.</p>`,
      confirmLabel: 'Load definition',
      cancelLabel: 'Not now',
      // A pattern-only hit is not a proven match -- keep the destructive
      // styling so it reads as "probably right", not "confirmed".
      danger: !best.confirmed || best.via === 'pattern',
    });
    if (!ok) return;

    els.status.textContent = `downloading ${d.file}…`;
    try {
      const r = await fetch(found.base + d.file, { cache: 'no-store' });
      if (!r.ok) throw new Error(`mirror returned ${r.status}`);
      const text = await r.text();
      tuningState.def = window.XDF.parseXdf(text);
      tuningState.defText = text;
      tuningState.defName = d.file;
      tuningState.selectedId = null;
      tuningState.kinds = null;
      tuningState.openCats = null;
      tuningState.shutCats = null;
      buildCoverage();
      saveSoon();
      renderDefs();
      hex.refresh();
      updateStatus();
    } catch (e) {
      els.status.textContent = `could not load ${d.file}: ${e.message}`;
    }
  }

  // ==========================================================================
  // Session persistence -- survive a reload with the files (and edits) intact
  // ==========================================================================

  // What is worth keeping. Derived state (parsed definition, coverage map) is
  // deliberately excluded and rebuilt on restore; see core/tuning-store.js.
  function sessionSnapshot() {
    return {
      fileName: tuningState.fileName,
      defName: tuningState.defName,
      bin: tuningState.bin,
      orig: tuningState.orig,
      defText: tuningState.defText,
      filter: tuningState.filter,
      coverOn: tuningState.coverOn,
      kinds: tuningState.kinds,
      openCats: tuningState.openCats,
    };
  }

  function saveSoon() {
    if (typeof TuningStore === 'undefined') return;
    if (!tuningState.bin && !tuningState.defText) return;   // nothing to keep
    TuningStore.scheduleSave(sessionSnapshot);
  }

  // A reload can arrive without warning, and a debounce timer will not survive
  // it -- flush on the way out. pagehide covers the bfcache case that
  // beforeunload misses on Safari/iOS.
  const onHide = () => {
    if (typeof TuningStore === 'undefined') return;
    if (!tuningState.bin && !tuningState.defText) return;
    TuningStore.flushSave(sessionSnapshot);
  };
  window.addEventListener('pagehide', onHide);
  window.addEventListener('beforeunload', onHide);

  // Restore, if a previous session left anything. Runs once per screen entry;
  // an already-loaded image wins, so re-entering the screen mid-session never
  // clobbers what is open.
  async function restoreSession() {
    if (typeof TuningStore === 'undefined') return;
    if (tuningState.bin || tuningState.def) return;
    let rec = null;
    try { rec = await TuningStore.loadSession(); } catch (e) { rec = null; }
    if (!rec || (!rec.bin && !rec.defText)) return;

    if (rec.bin) {
      tuningState.bin = rec.bin;
      tuningState.orig = rec.orig || rec.bin.slice();
      tuningState.fileName = rec.fileName || 'firmware.bin';
      els.loadXdf.disabled = false;
      els.save.disabled = false;
      els.file.textContent = `${tuningState.fileName} · ${fmtBytes(rec.bin.length)}`;
    }
    if (rec.defText) {
      try {
        tuningState.def = window.XDF.parseXdf(rec.defText);
        tuningState.defText = rec.defText;
        tuningState.defName = rec.defName || 'definition.xdf';
      } catch (e) {
        tuningState.def = null;          // a definition we can no longer parse
        tuningState.defText = null;      // is not worth carrying forward
      }
    }
    // view state
    tuningState.filter = rec.filter || '';
    tuningState.coverOn = rec.coverOn !== false;
    tuningState.kinds = rec.kinds && rec.kinds.length ? new Set(rec.kinds) : null;
    tuningState.openCats = rec.openCats ? new Set(rec.openCats) : null;
    // NOT the selection. Restoring selectedId made renderDefs() call
    // spotlight() for that item on load, painting a highlight over bytes the
    // user never clicked -- which then survived every reload and looked like
    // the hex view was highlighting at random. The files and the view state
    // are worth keeping across a reload; a transient selection is not.
    tuningState.selectedId = null;
    tuningState.highlight = null;

    recountChanges();
    buildCoverage();
    if (tuningState.def) renderDefs();
    hex.refresh();
    updateStatus();

    // Say so, rather than silently resurrecting files: seeing an image you did
    // not just load is confusing unless the app tells you why it is there.
    const when = rec.savedAt ? new Date(rec.savedAt) : null;
    els.status.innerHTML = `<span class="tn-restored">restored`
      + `${when ? ' from ' + esc(when.toLocaleString()) : ''}</span>`
      + `<span class="tn-sep">·</span><span>`
      + `<button type="button" class="tn-linklike" id="tn-forget">clear</button></span>`;
    const forget = els.status.querySelector('#tn-forget');
    if (forget) forget.onclick = () => clearEverything();
  }
  // CLEAR: unload the session AND wipe the store.
  //
  // "forget" used to only delete the stored record, leaving the BIN and
  // definition loaded -- so the next edit re-saved them and a reload brought
  // everything back, which read as the button not working. Clearing has to
  // mean both: drop what is in memory, then drop what is on disk, in that
  // order so nothing can re-save in between.
  async function clearEverything() {
    const dirty = tuningState.changed > 0;
    if (dirty) {
      const ok = await confirmDialog({
        title: 'Clear the editor?',
        body: `<p>${tuningState.changed.toLocaleString()} byte`
          + `${tuningState.changed === 1 ? '' : 's'} changed. Clearing discards `
          + 'the loaded firmware and definition along with those edits. '
          + 'Save the BIN first if you want to keep them.</p>',
        confirmLabel: 'Clear anyway',
        cancelLabel: 'Cancel',
        danger: true,
      });
      if (!ok) return;
    }
    // memory first: any save scheduled after this point stores nothing
    tuningState.bin = null;
    tuningState.orig = null;
    tuningState.fileName = '';
    tuningState.def = null;
    tuningState.defText = null;
    tuningState.defName = '';
    tuningState.selectedId = null;
    tuningState.highlight = null;
    tuningState.changed = 0;
    tuningState.filter = '';
    tuningState.kinds = null;
    tuningState.openCats = null;
    tuningState.shutCats = null;
    tuningState.cover = null;
    tuningState.owner = null;
    tuningState.owners = null;
    tuningState.coverInfo = null;

    try { await TuningStore.clearSession(); } catch (e) { /* best-effort */ }

    // put the screen back to its empty state
    els.loadXdf.disabled = true;
    els.save.disabled = true;
    els.file.textContent = '';
    els.status.textContent = '';
    els.defs.innerHTML = '';
    els.defs.appendChild(makeEmpty('⛃',
      'Load a .xdf definition to edit named parameters.',
      'Without one you can still browse and edit raw hex.'));
    hex.refresh();
    updateStatus();
  }

  if (els.clear) els.clear.onclick = () => clearEverything();

  restoreSession();

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
    saveSoon();
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

    if (els.clear) els.clear.disabled = !(tuningState.bin || tuningState.def);

    // The map control only means anything once a definition has been placed
    // against a BIN. Its label carries the coverage figure, which is the
    // useful number: how much of this image the definition actually describes.
    const info = tuningState.coverInfo;
    if (els.mapToggle) {
      els.mapToggle.hidden = !info;
      if (info) {
        const pct = info.total ? (100 * info.described / info.total) : 0;
        els.mapToggle.classList.toggle('on', !!tuningState.coverOn);
        els.mapToggle.setAttribute('aria-pressed', tuningState.coverOn ? 'true' : 'false');
        els.mapToggle.querySelector('.tn-map-label').textContent =
          `map · ${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
        els.mapToggle.title = `${info.items} parameters cover `
          + `${info.described.toLocaleString()} of ${info.total.toLocaleString()} bytes `
          + `(${pct.toFixed(1)}%) — click to ${tuningState.coverOn ? 'hide' : 'show'}`;
      }
    }
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

    // KIND FILTER. A 5,705-item definition is mostly one kind at a time: you
    // are hunting a table, or a flag, not both. The chips carry each kind's
    // own accent (same colours as the row badges) and its count, so the
    // makeup of the file is visible before you touch anything. Kinds the
    // definition does not contain are not offered.
    const KIND_LABEL = { constant: 'VAL', flag: 'FLG', table: 'TBL', patch: 'PATCH' };
    const kindCounts = new Map();
    for (const it of def.items) {
      kindCounts.set(it.kind, (kindCounts.get(it.kind) || 0) + 1);
    }
    const presentKinds = [...kindCounts.keys()]
      .sort((a, b) => kindCounts.get(b) - kindCounts.get(a));

    let kindBar = null;
    if (presentKinds.length > 1) {          // one kind only: nothing to filter
      kindBar = document.createElement('div');
      kindBar.className = 'tn-kind-bar';
      const paintKinds = () => {
        const on = tuningState.kinds;
        kindBar.innerHTML = presentKinds.map((k) => {
          const sel = !on || on.has(k);
          return `<button type="button" class="tn-kind-chip tn-kind-${esc(k)}`
            + `${sel ? ' on' : ''}" data-kind="${esc(k)}"`
            + ` title="${esc(k)} — click to show only this, click again for all">`
            + `<span class="tn-kind-chip-t">${esc(KIND_LABEL[k] || k)}</span>`
            + `<span class="tn-kind-chip-n">${kindCounts.get(k)}</span>`
            + `</button>`;
        }).join('');
      };
      paintKinds();
      kindBar.addEventListener('click', (e) => {
        const b = e.target.closest('.tn-kind-chip');
        if (!b) return;
        const k = b.dataset.kind;
        const cur = tuningState.kinds;
        if (!cur) {
          // from "all", a click means "only this one"
          tuningState.kinds = new Set([k]);
        } else if (cur.has(k)) {
          cur.delete(k);
          // turning the last one off means "all" again, never an empty list
          if (!cur.size) tuningState.kinds = null;
        } else {
          cur.add(k);
          if (cur.size === presentKinds.length) tuningState.kinds = null;
        }
        paintKinds();
        renderList();
      });
      els.defs.appendChild(kindBar);
    }

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
      const kinds = tuningState.kinds;
      const match = (it) => (!kinds || kinds.has(it.kind))
        && (!f
            || (it.title || '').toLowerCase().includes(f)
            || (it.description || '').toLowerCase().includes(f)
            || it.kind.includes(f));
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
      if (!tuningState.openCats) tuningState.openCats = new Set();
      if (!tuningState.shutCats) tuningState.shutCats = new Set();
      const open = tuningState.openCats;
      const shut = tuningState.shutCats;   // explicitly collapsed while filtering
      // A live filter means the user is hunting: show what matched rather than
      // making them open sections to find it. With no filter, only what they
      // opened -- plus whichever section holds the row they have selected, so
      // an open editor never hides itself.
      const filtering = !!tuningState.filter.trim() || !!tuningState.kinds;

      let shown = 0;
      for (const [name, items] of groups) {
        const holdsSelected = tuningState.selectedId != null
          && items.some((it) => it.key === tuningState.selectedId);
        // filtering opens everything that matched, EXCEPT a section the user
        // deliberately collapsed; otherwise a click on a filtered section
        // would do nothing and read as broken
        const isOpen = holdsSelected
          || (filtering ? !shut.has(name) : open.has(name));

        const cat = document.createElement('div');
        cat.className = 'tn-cat' + (isOpen ? ' open' : '');
        cat.innerHTML = `<button class="tn-cat-head" type="button"
            aria-expanded="${isOpen ? 'true' : 'false'}">
            <span class="tn-cat-caret">${isOpen ? '\u25be' : '\u25b8'}</span>
            <span class="tn-cat-name">${esc(name)}</span>
            <span class="tn-cat-count">${items.length}</span>
          </button>`;
        const body = document.createElement('div');
        body.className = 'tn-cat-body';
        if (isOpen) {
          for (const it of items) {
            shown++;
            body.appendChild(renderItemRow(it));
          }
        } else {
          shown += items.length;   // counted as present, just not drawn
        }
        cat.appendChild(body);

        cat.querySelector('.tn-cat-head').onclick = () => {
          // Toggle against whichever set governs the current mode, so the
          // click always visibly does something.
          if (filtering) {
            if (shut.has(name)) shut.delete(name); else shut.add(name);
          } else if (open.has(name)) {
            open.delete(name);
          } else {
            open.add(name);
          }
          renderList();
        };
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
    row.className = 'tn-item' + (tuningState.selectedId === item.key ? ' open' : '');
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
      const isOpen = tuningState.selectedId === item.key;
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
      tuningState.selectedId = item.key;
      row.classList.add('open');
      renderEditor(item, body);
      spotlight(item);
    };
    if (tuningState.selectedId === item.key) {
      renderEditor(item, body);
      spotlight(item, { noScroll: !!suppressSpotlightScroll });
    }
    return row;
  }

  // CLICK A MAPPED BYTE -> open the parameter that owns it.
  //
  // The reverse of spotlight(): instead of "show me where this parameter
  // lives", it answers "what is this byte?" -- which is the question you have
  // when staring at an unfamiliar image. Resolving it needs the owner index
  // built alongside the colour map, because a colour slot is shared by every
  // eighth region and cannot identify anything on its own.
  //
  // Returns true when a parameter was opened, so the caller can fall through
  // to other behaviour (raw editing) on an unmapped byte.
  let suppressSpotlightScroll = false;   // set while opening from a hex click

  function openItemAt(off) {
    const owner = tuningState.owner;
    const owners = tuningState.owners;
    if (!owner || !owners || off < 0 || off >= owner.length) return false;
    const oid = owner[off];
    if (!oid) return false;                    // byte the definition does not describe
    const rec = owners[oid - 1];
    if (!rec) return false;

    // Highlight the WHOLE region, not just the byte, so the extent of the
    // thing you clicked is visible immediately.
    tuningState.highlight = { start: rec.start, end: rec.end };
    tuningState.selectedId = rec.item.key;

    // Open its section on the left and scroll the row into view. renderDefs
    // re-renders the tree; the section holding the selected item is forced
    // open by the collapse logic, so the row is guaranteed to exist after.
    suppressSpotlightScroll = true;
    try { renderDefs(); } finally { suppressSpotlightScroll = false; }
    const row = els.defs.querySelector(`.tn-item.open`);
    if (row && row.scrollIntoView) {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    hex.refresh();                             // repaint with the new highlight

    // A TABLE's home is the grid, not a row in the tree. Selecting it on the
    // left and stopping there looked like nothing happened -- the row is one
    // of thousands and may be scrolled far off. Constants and flags edit
    // inline in the tree, so for those the selection IS the destination.
    if (rec.item.kind === 'table' && tuningState.bin) {
      openTableModal(rec.item);
    }
    return true;
  }

  // highlight an item's byte footprint in the hex view and scroll it into view
  function spotlight(item, opts = {}) {
    const range = itemByteRange(item);
    tuningState.highlight = range;
    hex.refresh();
    // Skip the scroll when the user got here BY clicking that byte -- they
    // are already looking at it, and yanking the view is disorienting.
    if (range && !opts.noScroll) hex.scrollTo(range.start);
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

  // ---- coverage map ---------------------------------------------------------
  //
  // A byte -> colour-slot index over the whole BIN, so the hex pane SHOWS what
  // the definition describes instead of making you click 5,705 rows to find
  // out. Neighbouring parameters get different slots, so the boundary between
  // two adjacent tables is visible rather than one undifferentiated wash.
  //
  // Built once per (definition, BIN) because the hex view is virtualised: it
  // re-renders on every scroll frame, so the per-byte question has to be one
  // array read, not a search over the item list.
  //
  // Slot 0 means "not described". Slots 1..COVER_SLOTS rotate.
  const COVER_SLOTS = 8;

  function buildCoverage() {
    tuningState.cover = null;
    tuningState.owner = null;
    tuningState.owners = null;
    tuningState.coverInfo = null;
    const bin = tuningState.bin;
    const def = tuningState.def;
    if (!bin || !def) return;

    const cover = new Uint8Array(bin.length);   // 0 = uncovered
    // WHICH item owns each byte, so clicking a shaded byte can open it. Kept
    // as a parallel typed array rather than objects-per-byte: a 1 MB image
    // would otherwise mean a million references. 0 = none, else index+1 into
    // `owners`.
    const owner = new Int32Array(bin.length);
    const owners = [];                          // parallel: {item, start, end}
    let slot = 0;
    let described = 0;
    let placed = 0;

    // Address order, so the rotation follows the layout of the file and
    // adjacent regions reliably differ.
    const ranges = [];
    for (const it of def.items) {
      let r = null;
      try { r = itemByteRange(it); } catch (e) { r = null; }
      if (!r || r.start == null || r.end == null) continue;
      const start = Math.max(0, r.start | 0);
      const end = Math.min(bin.length, r.end | 0);
      if (end <= start) continue;
      ranges.push([start, end, it]);
    }
    ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    for (const [start, end, it] of ranges) {
      slot = (slot % COVER_SLOTS) + 1;          // 1..COVER_SLOTS, never 0
      placed++;
      owners.push({ item: it, start, end });
      const oid = owners.length;                // 1-based; 0 means "none"
      for (let i = start; i < end; i++) {
        if (cover[i] === 0) described++;        // count each byte once
        cover[i] = slot;
        owner[i] = oid;                         // last writer wins, as with cover
      }
    }

    tuningState.cover = cover;
    tuningState.owner = owner;
    tuningState.owners = owners;
    tuningState.coverInfo = { described, total: bin.length, items: placed };
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

  // A table's grid does not belong inline in a 5,000-row list: a 16x16 map
  // pushes everything else off screen, and the cells are too cramped to work
  // in. The row shows a summary and a View button; the grid opens in a modal
  // with room to actually tune -- see openTableModal.
  function renderTableEditor(item, container) {
    const h = tuningState.def.header;
    const t = window.XDF.decodeTable(item, tuningState.bin, h);
    if (!t) { container.appendChild(makeNote('This table has no Z axis to edit.')); return; }
    const invertible = window.XDF.invertLinear(t.z.mathEquation) !== null;

    // summary + the way in
    const bar = document.createElement('div');
    bar.className = 'tn-tbl-summary';
    let lo = Infinity, hi = -Infinity, n = 0;
    for (const row of t.cells) {
      for (const v of row) {
        if (v == null || !Number.isFinite(v)) continue;
        if (v < lo) lo = v; if (v > hi) hi = v; n++;
      }
    }
    const dp0 = t.z.decimalpl != null ? t.z.decimalpl : h.defaults.sigdigits;
    bar.innerHTML = `<span class="tn-tbl-dims">${t.rows} × ${t.cols}</span>`
      + (n ? `<span class="tn-tbl-range">${fmtNum(lo, dp0)} … ${fmtNum(hi, dp0)}`
             + `${t.z.units ? ' ' + esc(t.z.units) : ''}</span>` : '')
      + (invertible ? '' : '<span class="tn-warn-inline">read-only</span>');
    const viewBtn = document.createElement('button');
    viewBtn.type = 'button';
    viewBtn.className = 'btn tn-tbl-view';
    viewBtn.textContent = 'View table…';
    viewBtn.onclick = () => openTableModal(item);
    bar.appendChild(viewBtn);
    container.appendChild(bar);
  }

  // The full grid, in a dialog with the quality-of-life tools that make a map
  // editable rather than merely visible: a heat map so the SHAPE is readable,
  // multi-cell selection, and bulk set / scale / offset over a selection.
  function openTableModal(item) {
    const h = tuningState.def.header;
    const t0 = window.XDF.decodeTable(item, tuningState.bin, h);
    if (!t0) return;
    let t = t0;
    const invertible = window.XDF.invertLinear(t.z.mathEquation) !== null;
    const dp = t.z.decimalpl != null ? t.z.decimalpl : h.defaults.sigdigits;
    let xLabels = axisLabels(t.x, t.cols, h);
    let yLabels = axisLabels(t.y, t.rows, h);

    // STEP SIZE for the +/- keys. One raw LSB is the smallest change the image
    // can actually hold, so that is the fine step: derive it from the MATH by
    // measuring what one raw count is worth in engineering units. The coarse
    // step is a round 10x of that, floored at the display resolution so a
    // press always visibly moves the number rather than rounding away.
    const fineStep = (() => {
      try {
        const conv = window.XDF.compileMath(t.z.mathEquation);
        const slope = Math.abs(conv(1) - conv(0));
        if (Number.isFinite(slope) && slope > 0) return slope;
      } catch (e) { /* fall through */ }
      return Math.pow(10, -dp);
    })();
    const coarseStep = Math.max(fineStep * 10, Math.pow(10, -dp));

    // RANGE LIMITS. The XDF carries rangelow/rangehigh per axis; the encoder
    // only enforces what fits the storage type, which is a much wider net (a
    // 1-byte cell happily takes 255 when the definition says 0..100). Clamping
    // to the definition is what stops a bulk op from quietly writing nonsense.
    // XDFAXIS spells its limits <min>/<max> (XDFCONSTANT uses rangelow/
    // rangehigh); accept either so both shapes of definition are honoured.
    const zLo = t.z.min != null ? t.z.min : t.z.rangelow;
    const zHi = t.z.max != null ? t.z.max : t.z.rangehigh;
    const hasLimit = zLo != null || zHi != null;
    function inRange(v) {
      if (zLo != null && v < zLo) return false;
      if (zHi != null && v > zHi) return false;
      return true;
    }

    const back = document.createElement('div');
    back.className = 'tn-modal-back';
    const box = document.createElement('div');
    box.className = 'tn-modal';
    back.appendChild(box);

    box.innerHTML = `
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
               ${invertible ? '' : 'disabled'} />
        <button type="button" class="btn tn-bulk" data-op="set"   ${invertible ? '' : 'disabled'}>set</button>
        <button type="button" class="btn tn-bulk" data-op="add"   ${invertible ? '' : 'disabled'}>+/−</button>
        <button type="button" class="btn tn-bulk" data-op="scale" ${invertible ? '' : 'disabled'}>× %</button>
        <span class="tn-tool-sep"></span>
        <button type="button" class="btn tn-op" data-op="interp-h" title="Interpolate across the selection, left to right (Shift+H)" ${invertible ? '' : 'disabled'}>interp ↔</button>
        <button type="button" class="btn tn-op" data-op="interp-v" title="Interpolate down the selection, top to bottom (Shift+V)" ${invertible ? '' : 'disabled'}>interp ↕</button>
        <button type="button" class="btn tn-op" data-op="interp-2d" title="Interpolate both axes (Shift+I)" ${invertible ? '' : 'disabled'}>interp 2D</button>
        <button type="button" class="btn tn-op" data-op="smooth" title="Smooth the selection (Shift+S)" ${invertible ? '' : 'disabled'}>smooth</button>
        <span class="tn-tool-sep"></span>
        <button type="button" class="btn tn-op" data-op="undo" title="Undo the last change (Cmd/Ctrl+Z)" ${invertible ? '' : 'disabled'}>undo</button>
        <button type="button" class="btn tn-op" data-op="revert" title="Revert the selection to the values this file loaded with" ${invertible ? '' : 'disabled'}>revert</button>
        <span class="tn-tool-sep"></span>
        <label class="tn-tool-check"><input type="checkbox" class="tn-cmp"> vs original</label>
      </div>
      <div class="tn-modal-grid"></div>
      <div class="tn-modal-foot">
        <span class="tn-modal-meta">${t.rows} × ${t.cols} · MATH <code>${esc(t.z.mathEquation)}</code>`
          + `${t.z.units ? ' · ' + esc(t.z.units) : ''}`
          + `${(zLo != null || zHi != null) ? ' · range ' + (zLo != null ? fmtNum(zLo, dp) : '−∞') + '…' + (zHi != null ? fmtNum(zHi, dp) : '∞') : ''}`
          + `${invertible ? '' : ' · read-only (MATH not invertible)'}</span>
        <span class="tn-modal-keys">+/− step ${fmtNum(coarseStep, Math.max(dp, 2))} · [ ] fine ${fmtNum(fineStep, Math.max(dp, 2))} · ⇧H/⇧V/⇧I interp · ⇧S smooth · ⌘Z undo</span>
        <button type="button" class="btn tn-modal-done">Done</button>
      </div>`;

    const gridWrap = box.querySelector('.tn-modal-grid');
    const heatBox = box.querySelector('.tn-heat');
    const cmpBox = box.querySelector('.tn-cmp');
    const selInfo = box.querySelector('.tn-sel-info');
    const bulkVal = box.querySelector('.tn-bulk-v');

    // The table as it was when this FILE was loaded. tuningState.orig is the
    // pristine image, so decoding this table out of it gives the baseline for
    // both "vs original" shading and the revert op -- no extra bookkeeping.
    const baseTable = tuningState.orig
      ? window.XDF.decodeTable(item, tuningState.orig, h)
      : null;

    // UNDO. Each entry is the set of byte writes an operation performed, held
    // as {address, before} so undo is a straight replay backwards. Byte-level
    // rather than cell-level because that is the layer edits actually land at,
    // and it stays correct for axis writes too.
    const history = [];
    let batch = null;              // collects writes while an op is running
    function beginBatch() { batch = []; }
    function endBatch(label) {
      if (batch && batch.length) history.push({ label, writes: batch });
      batch = null;
      updateOpState();
    }
    // Record the prior bytes, then write. Everything that mutates the image
    // from inside this modal goes through here so undo can never miss a write.
    function writeTracked(address, bytes) {
      // Snapshot BEFORE the write, but only keep it if the write was actually
      // accepted -- writeBytes refuses out-of-bounds addresses, and recording
      // a no-op would make undo replay bytes that were never changed.
      const before = tuningState.bin.slice(address, address + bytes.length);
      const ok = writeBytes(address, bytes);
      if (ok && batch) batch.push({ address, before });
      return ok;
    }
    function undoLast() {
      const entry = history.pop();
      if (!entry) return false;
      // backwards: later writes in the same op may overlap earlier ones
      for (let i = entry.writes.length - 1; i >= 0; i--) {
        const w = entry.writes[i];
        writeBytes(w.address, w.before);
      }
      refresh();
      flashInfo(`undid ${entry.label}`);
      return true;
    }

    // Re-decode and repaint after the image changed underneath us.
    function refresh() {
      t = window.XDF.decodeTable(item, tuningState.bin, h);
      xLabels = axisLabels(t.x, t.cols, h);
      yLabels = axisLabels(t.y, t.rows, h);
      for (const th of gridWrap.querySelectorAll('th[data-axis="x"]')) {
        const i = +th.dataset.i;
        const inp = th.querySelector('.tn-axis-cell');
        if (inp && inp !== document.activeElement) inp.value = xLabels[i] != null ? xLabels[i] : i;
      }
      for (const th of gridWrap.querySelectorAll('th[data-axis="y"]')) {
        const i = +th.dataset.i;
        const inp = th.querySelector('.tn-axis-cell');
        if (inp && inp !== document.activeElement) inp.value = yLabels[i] != null ? yLabels[i] : i;
      }
      paint();
    }

    function updateOpState() {
      const u = box.querySelector('.tn-op[data-op="undo"]');
      if (u) u.disabled = !invertible || !history.length;
    }

    // SELECTION, spreadsheet semantics.
    //
    //   click        -> select just that cell, clearing everything else
    //   drag         -> rectangular range from where the drag started
    //   shift-click  -> extend the rectangle from the existing anchor
    //   cmd/ctrl     -> add a cell (or a dragged rectangle) to what is there
    //
    // `sel` is the materialised set of "r,c" the bulk ops act on. `anchor` is
    // the corner a shift-click or drag extends FROM -- keeping it separate is
    // what makes shift-click extend the same rectangle rather than starting a
    // new one, which is the behaviour that makes a grid feel like a grid.
    const sel = new Set();
    const selKey = (r, c) => r + ',' + c;
    let anchor = null;          // {r, c} the fixed corner of the current range
    let baseSel = null;         // selection to keep while additively dragging

    // Replace `sel` with the rectangle anchor..(r,c), optionally unioned with
    // whatever was selected before an additive drag began.
    function selectRect(r, c, additive) {
      if (!anchor) anchor = { r, c };
      const r0 = Math.min(anchor.r, r), r1 = Math.max(anchor.r, r);
      const c0 = Math.min(anchor.c, c), c1 = Math.max(anchor.c, c);
      sel.clear();
      if (additive && baseSel) for (const k of baseSel) sel.add(k);
      for (let rr = r0; rr <= r1; rr++) {
        for (let cc = c0; cc <= c1; cc++) sel.add(selKey(rr, cc));
      }
      paint();
    }

    function bounds() {
      let lo = Infinity, hi = -Infinity;
      for (const row of t.cells) {
        for (const v of row) {
          if (v == null || !Number.isFinite(v)) continue;
          if (v < lo) lo = v; if (v > hi) hi = v;
        }
      }
      return { lo, hi, span: hi - lo };
    }

    function paint() {
      const { lo, span } = bounds();
      const heat = heatBox.checked;
      const cmp = cmpBox.checked && baseTable;
      // For "vs original" the scale that matters is the size of the CHANGE,
      // not the size of the value, so it gets its own symmetric range: the
      // largest delta in either direction sets full saturation.
      let dMax = 0;
      if (cmp) {
        for (let r = 0; r < t.rows; r++) {
          for (let c = 0; c < t.cols; c++) {
            const a = t.cells[r][c], b0 = baseTable.cells[r] && baseTable.cells[r][c];
            if (a == null || b0 == null) continue;
            const d = Math.abs(a - b0);
            if (d > dMax) dMax = d;
          }
        }
      }
      const focused = document.activeElement;
      for (const inp of gridWrap.querySelectorAll('.tn-cell')) {
        const r = +inp.dataset.r, c = +inp.dataset.c;
        const v = t.cells[r][c];
        // NEVER overwrite the cell the user is typing in. paint() runs on
        // every selection change, and mousedown on another cell fires BEFORE
        // this one's blur -- so rewriting .value here silently threw away
        // half-typed input.
        if (inp !== focused) inp.value = v == null ? '' : fmtNum(v, dp);
        inp.classList.toggle('sel', sel.has(selKey(r, c)));
        // Heat is a background tint scaled across the table's own range, so
        // the shape of a map reads at a glance -- the single most useful thing
        // when judging whether a change looks sane.
        if (cmp) {
          // green = raised, red = lowered, transparent = untouched
          const b0 = baseTable.cells[r] && baseTable.cells[r][c];
          const d = (v == null || b0 == null) ? 0 : v - b0;
          if (d !== 0 && dMax > 0) {
            const f = Math.min(1, Math.abs(d) / dMax);
            inp.style.background = `hsla(${d > 0 ? 140 : 0}, 70%, 45%, ${0.15 + 0.35 * f})`;
          } else {
            inp.style.background = '';
          }
        } else if (heat && v != null && Number.isFinite(v) && span > 0) {
          const f = (v - lo) / span;                    // 0..1
          const hue = 210 - 210 * f;                    // blue -> red
          inp.style.background = `hsla(${hue}, 70%, 45%, ${0.13 + 0.3 * f})`;
        } else {
          inp.style.background = '';
        }
        // a cell sitting outside the definition's declared range is worth
        // flagging even when we did not put it there
        inp.classList.toggle('tn-cell-oor',
          hasLimit && v != null && Number.isFinite(v) && !inRange(v));
        if (cmp && baseTable) {
          const b0 = baseTable.cells[r] && baseTable.cells[r][c];
          inp.title = (v != null && b0 != null && v !== b0)
            ? `was ${fmtNum(b0, dp)} · ${v - b0 > 0 ? '+' : ''}${fmtNum(v - b0, dp)}` : '';
        } else if (inp.title) inp.title = '';
      }
      selInfo.textContent = sel.size
        ? `${sel.size} cell${sel.size === 1 ? '' : 's'} selected`
        : 'click, drag, or shift-click to select';
    }

    // build the grid once; paint() refreshes values/heat/selection
    const table = document.createElement('table');
    table.className = 'tn-table tn-table-modal';

    // AXIS EDITING. The X/Y breakpoints are real values in the image just like
    // the Z cells, and every established tool lets you move them -- retuning a
    // map for a bigger turbo usually means restretching the load axis first.
    // An axis is editable when it has an address (values read from the image)
    // and an invertible MATH; label-only axes stay static text.
    const xEditable = !!(t.x && t.x.embed && t.x.embed.address
      && window.XDF.invertLinear(t.x.mathEquation) !== null);
    const yEditable = !!(t.y && t.y.embed && t.y.embed.address
      && window.XDF.invertLinear(t.y.mathEquation) !== null);

    function commitAxis(axis, index, input, isX) {
      const v = Number(input.value);
      const labels = isX ? xLabels : yLabels;
      if (!Number.isFinite(v)) { input.value = labels[index] != null ? labels[index] : index; return; }
      const enc = window.XDF.encodeAxisPoint(axis, h, index, v);
      if (!enc) { shake(input); return; }
      beginBatch();
      writeTracked(enc.address, enc.bytes);
      endBatch('axis edit');
      refresh();
      const back = window.XDF.decodeAxisPoint(axis, tuningState.bin, h, index);
      input.value = back == null ? '' : fmtNum(back, axis.decimalpl != null ? axis.decimalpl : 0);
      input.classList.add('tn-cell-edited');
    }

    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    const corner = document.createElement('th');
    corner.className = 'tn-corner';
    htr.appendChild(corner);
    for (let c = 0; c < t.cols; c++) {
      const th = document.createElement('th');
      th.dataset.axis = 'x'; th.dataset.i = c;
      if (xEditable) {
        const ai = document.createElement('input');
        ai.type = 'text';
        ai.className = 'tn-axis-cell';
        ai.value = xLabels[c] != null ? xLabels[c] : c;
        ai.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); ai.blur(); } };
        ai.onblur = () => commitAxis(t.x, c, ai, true);
        th.appendChild(ai);
      } else {
        th.textContent = xLabels[c] != null ? xLabels[c] : c;
      }
      htr.appendChild(th);
    }
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    let dragging = false;
    for (let r = 0; r < t.rows; r++) {
      const tr = document.createElement('tr');
      const rh = document.createElement('th');
      rh.className = 'tn-rowhead';
      rh.dataset.axis = 'y'; rh.dataset.i = r;
      if (yEditable) {
        const ai = document.createElement('input');
        ai.type = 'text';
        ai.className = 'tn-axis-cell';
        ai.value = yLabels[r] != null ? yLabels[r] : r;
        ai.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); ai.blur(); } };
        ai.onblur = () => commitAxis(t.y, r, ai, false);
        rh.appendChild(ai);
      } else {
        rh.textContent = yLabels[r] != null ? yLabels[r] : r;
      }
      tr.appendChild(rh);
      for (let c = 0; c < t.cols; c++) {
        const td = document.createElement('td');
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'tn-cell';
        input.dataset.r = r; input.dataset.c = c;
        input.disabled = !invertible || t.cells[r][c] == null;
        input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); commitCell(input); } };
        input.onblur = () => commitCell(input);
        input.onmousedown = (e) => {
          if (e.button !== 0) return;
          // Commit whatever is being typed in ANOTHER cell first: mousedown
          // beats blur, so without this the pending edit is lost when the
          // selection repaints.
          const act = document.activeElement;
          if (act && act !== input && act.classList
              && act.classList.contains('tn-cell')) {
            commitCell(act);
          }
          const add = e.metaKey || e.ctrlKey;
          if (e.shiftKey) {
            // extend from the existing anchor; never move it
            e.preventDefault();
            dragging = true;
            baseSel = add ? new Set(sel) : null;
            selectRect(r, c, add);
            return;
          }
          // A plain mousedown starts a range and clears what was there. We do
          // NOT preventDefault: the cell must still take focus so a click can
          // be followed by typing. Selection only becomes visible once the
          // pointer moves (see onmouseenter), so a simple click-to-edit does
          // not paint a selection the user did not ask for.
          dragging = true;
          anchor = { r, c };
          baseSel = add ? new Set(sel) : null;
          if (!add) { sel.clear(); paint(); }
        };
        input.onmouseenter = () => {
          if (dragging && anchor) selectRect(r, c, !!baseSel);
        };
        // a click that never moved: select exactly this cell
        input.onclick = (e) => {
          if (e.shiftKey || e.metaKey || e.ctrlKey) return;
          if (sel.size > 1) return;              // a drag just happened
          sel.clear();
          sel.add(selKey(r, c));
          anchor = { r, c };
          paint();
          // the cell keeps focus for typing; the proxy takes over only once
          // focus leaves it (see onblur below)
        };
        td.appendChild(input);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    gridWrap.appendChild(table);
    const endDrag = () => {
      dragging = false;
      baseSel = null;
      // hand focus to the clipboard proxy so Cmd-C / Cmd-V and the arrow keys
      // reach the grid straight after a drag-select
      if (sel.size) focusProxy();
    };
    window.addEventListener('mouseup', endDrag);

    function commitCell(input) {
      const r = Number(input.dataset.r), c = Number(input.dataset.c);
      const v = Number(input.value);
      if (!Number.isFinite(v)) { input.value = fmtNum(t.cells[r][c], dp); return; }
      beginBatch();
      const res = applyCell(r, c, v);
      endBatch('cell edit');
      if (!res.ok) { shake(input); return; }
      if (res.clamped) flashInfo(`clamped to ${fmtNum(zLo != null && v < zLo ? zLo : zHi, dp)}`);
      t = window.XDF.decodeTable(item, tuningState.bin, h);
      paint();
      // paint() deliberately skips the focused cell, so refresh this one by
      // hand: the value it shows should be what the ECU will actually hold
      // (quantised by the MATH equation), not the raw text that was typed.
      const back = t.cells[r][c];
      input.value = back == null ? '' : fmtNum(back, dp);
      input.classList.add('tn-cell-edited');
    }

    // one cell -> bytes, via the same encoder the inline editor used
    // one cell <- engineering value. Clamps to the definition's range rather
    // than rejecting, so a bulk op over a selection does something sane at the
    // edges instead of leaving a ragged hole where cells refused to move; a
    // single typed cell reports the clamp so the user is never lied to.
    function applyCell(r, c, v, opts) {
      let val = v;
      let clamped = false;
      if (zLo != null && val < zLo) { val = zLo; clamped = true; }
      if (zHi != null && val > zHi) { val = zHi; clamped = true; }
      if (clamped && opts && opts.strict) return { ok: false, clamped: true };
      const enc = window.XDF.encodeTableCell(item, h, r, c, val);
      if (!enc) return { ok: false, clamped };
      return { ok: writeTracked(enc.address, enc.bytes), clamped };
    }

    // BULK OPS over the selection -- the reason a modal earns its place.
    // set: absolute. add: +/- delta. scale: percentage of current.
    box.querySelectorAll('.tn-bulk').forEach((b) => {
      b.onclick = () => {
        const raw = Number(bulkVal.value);
        if (!Number.isFinite(raw)) { shake(bulkVal); return; }
        const op = b.dataset.op;
        const targets = sel.size
          ? [...sel].map((k) => k.split(',').map(Number))
          : null;
        if (!targets) { shake(bulkVal); return; }   // never touch the whole table by accident
        let n = 0, clamped = 0;
        beginBatch();
        for (const [r, c] of targets) {
          const cur = t.cells[r][c];
          if (cur == null || !Number.isFinite(cur)) continue;
          const next = op === 'set' ? raw
            : op === 'add' ? cur + raw
            : cur * (1 + raw / 100);
          const res = applyCell(r, c, next);
          if (res.ok) n++;
          if (res.clamped) clamped++;
        }
        endBatch(op === 'set' ? 'set' : op === 'add' ? 'offset' : 'scale');
        refresh();
        if (!n) shake(bulkVal);
        else if (clamped) flashInfo(`${n} cells · ${clamped} clamped to range`);
      };
    });

    // ---- interpolation, smoothing, undo, revert -----------------------------
    //
    // Interpolation is the operation every established tuning tool has and the
    // one most used after typing a number. It fills the INTERIOR of a selection
    // by walking a straight line between its edge cells. Following RomRaider,
    // the line is drawn against the REAL AXIS VALUES where the axis is numeric,
    // not against the cell index -- on a non-uniform axis (and RPM/load axes
    // are never uniform) those give visibly different answers, and the axis one
    // is the physically meaningful result.
    function axisPos(labels, i) {
      const v = labels && labels[i] != null ? Number(labels[i]) : NaN;
      return Number.isFinite(v) ? v : i;
    }
    function lerp(x, x1, x2, y1, y2) {
      return (x1 === x2) ? y1 : (y1 + (x - x1) * (y2 - y1) / (x2 - x1));
    }

    // Horizontal: for each row of the selection, run the line from the leftmost
    // selected column to the rightmost, rewriting everything between.
    function interpolateH(b, out) {
      if (b.c1 - b.c0 < 2) return;
      for (let r = b.r0; r <= b.r1; r++) {
        const y1 = t.cells[r][b.c0], y2 = t.cells[r][b.c1];
        if (y1 == null || y2 == null) continue;
        const x1 = axisPos(xLabels, b.c0), x2 = axisPos(xLabels, b.c1);
        for (let c = b.c0 + 1; c < b.c1; c++) {
          if (t.cells[r][c] == null) continue;
          out.push([r, c, lerp(axisPos(xLabels, c), x1, x2, y1, y2)]);
        }
      }
    }
    // Vertical: same, down each column.
    function interpolateV(b, out) {
      if (b.r1 - b.r0 < 2) return;
      for (let c = b.c0; c <= b.c1; c++) {
        const y1 = t.cells[b.r0][c], y2 = t.cells[b.r1][c];
        if (y1 == null || y2 == null) continue;
        const x1 = axisPos(yLabels, b.r0), x2 = axisPos(yLabels, b.r1);
        for (let r = b.r0 + 1; r < b.r1; r++) {
          if (t.cells[r][c] == null) continue;
          out.push([r, c, lerp(axisPos(yLabels, r), x1, x2, y1, y2)]);
        }
      }
    }

    // 2D: bilinear from the four CORNERS of the selection, which is what makes
    // "select a region, flatten it into a plane" a single action. (RomRaider
    // reaches the same place by running vertical then horizontal; doing it in
    // one pass from the corners avoids depending on the order.)
    function interpolate2D(b, out) {
      if (b.r1 - b.r0 < 1 || b.c1 - b.c0 < 1) return;
      const q11 = t.cells[b.r0][b.c0], q12 = t.cells[b.r0][b.c1];
      const q21 = t.cells[b.r1][b.c0], q22 = t.cells[b.r1][b.c1];
      if (q11 == null || q12 == null || q21 == null || q22 == null) return;
      const x1 = axisPos(xLabels, b.c0), x2 = axisPos(xLabels, b.c1);
      const y1 = axisPos(yLabels, b.r0), y2 = axisPos(yLabels, b.r1);
      for (let r = b.r0; r <= b.r1; r++) {
        for (let c = b.c0; c <= b.c1; c++) {
          if (r === b.r0 && c === b.c0) continue;   // corners are the input
          if (r === b.r0 && c === b.c1) continue;
          if (r === b.r1 && c === b.c0) continue;
          if (r === b.r1 && c === b.c1) continue;
          if (t.cells[r][c] == null) continue;
          const top = lerp(axisPos(xLabels, c), x1, x2, q11, q12);
          const bot = lerp(axisPos(xLabels, c), x1, x2, q21, q22);
          out.push([r, c, lerp(axisPos(yLabels, r), y1, y2, top, bot)]);
        }
      }
    }

    // Smooth: 3x3 neighbourhood average blended with the original by alpha,
    // the same shape TunerPro's smoothing takes. Reads from a snapshot so the
    // pass is simultaneous rather than cascading across the selection, and
    // only cells INSIDE the selection contribute or move.
    function smoothSel(b, out, alpha) {
      const src = t.cells.map((row) => row.slice());
      for (let r = b.r0; r <= b.r1; r++) {
        for (let c = b.c0; c <= b.c1; c++) {
          if (!sel.has(selKey(r, c)) || src[r][c] == null) continue;
          let sum = 0, n = 0;
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              const rr = r + dr, cc = c + dc;
              if (rr < b.r0 || rr > b.r1 || cc < b.c0 || cc > b.c1) continue;
              const v = src[rr][cc];
              if (v == null || !Number.isFinite(v)) continue;
              sum += v; n++;
            }
          }
          if (!n) continue;
          out.push([r, c, src[r][c] * (1 - alpha) + (sum / n) * alpha]);
        }
      }
    }

    function runOp(op) {
      if (!invertible) return;
      if (op === 'undo') { if (!undoLast()) flashInfo('nothing to undo'); return; }
      const b = selBounds();
      if (!b) { flashInfo('select some cells first'); return; }

      if (op === 'revert') {
        if (!baseTable) { flashInfo('no original to revert to'); return; }
        let n = 0;
        beginBatch();
        for (let r = b.r0; r <= b.r1; r++) {
          for (let c = b.c0; c <= b.c1; c++) {
            if (!sel.has(selKey(r, c))) continue;
            const was = baseTable.cells[r] && baseTable.cells[r][c];
            if (was == null || !Number.isFinite(was)) continue;
            if (applyCell(r, c, was).ok) n++;
          }
        }
        endBatch('revert');
        refresh();
        flashInfo(n ? `reverted ${n} cell${n === 1 ? '' : 's'}` : 'nothing to revert');
        return;
      }

      const out = [];
      if (op === 'interp-h') interpolateH(b, out);
      else if (op === 'interp-v') interpolateV(b, out);
      else if (op === 'interp-2d') interpolate2D(b, out);
      else if (op === 'smooth') smoothSel(b, out, 0.5);

      if (!out.length) {
        flashInfo(op === 'smooth' ? 'select cells to smooth'
          : 'select at least 3 cells across to interpolate');
        return;
      }
      let n = 0, clamped = 0;
      beginBatch();
      for (const [r, c, v] of out) {
        const res = applyCell(r, c, v);
        if (res.ok) n++;
        if (res.clamped) clamped++;
      }
      endBatch(op === 'smooth' ? 'smooth' : 'interpolate');
      refresh();
      flashInfo(`${op === 'smooth' ? 'smoothed' : 'interpolated'} ${n} cell${n === 1 ? '' : 's'}`
        + (clamped ? ` · ${clamped} clamped` : ''));
    }

    box.querySelectorAll('.tn-op').forEach((b) => { b.onclick = () => runOp(b.dataset.op); });
    updateOpState();
    cmpBox.onchange = paint;

    heatBox.onchange = paint;

    const close = () => {
      back.remove();
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('mouseup', endDrag);   // added per-modal
      if (infoTimer) clearTimeout(infoTimer);
      renderDefs();          // reflect any edits in the list + hex view
      hex.refresh();
    };
    // ---- clipboard ---------------------------------------------------------
    //
    // TAB-SEPARATED VALUES, because that is what spreadsheets speak: copy a
    // block here and it pastes straight into Excel/Numbers/Sheets, and a block
    // copied from a spreadsheet (or another table in this app) pastes back.
    // TunerPro uses the same convention.
    //
    // Copy takes the BOUNDING BOX of the selection, not the sparse set --
    // a rectangle is the only shape a spreadsheet can represent, and holes
    // inside it come through as the cells' real values rather than blanks.
    function selBounds() {
      if (!sel.size) return null;
      let r0 = Infinity, r1 = -Infinity, c0 = Infinity, c1 = -Infinity;
      for (const k of sel) {
        const i = k.indexOf(',');
        const r = +k.slice(0, i), c = +k.slice(i + 1);
        if (r < r0) r0 = r; if (r > r1) r1 = r;
        if (c < c0) c0 = c; if (c > c1) c1 = c;
      }
      return { r0, r1, c0, c1 };
    }

    // CLIPBOARD.
    //
    // Route everything through a hidden, always-focused <textarea> rather than
    // navigator.clipboard. That API needs a secure context and a permission
    // the user has to grant, and it silently no-ops on plain http://localhost;
    // a real copy/paste EVENT carries its data with no permission at all. So:
    //
    //   copy  -- put the TSV in the proxy, select it, let the browser's own
    //            copy handler take it. Runs inside the keydown, so the
    //            user-gesture requirement is satisfied.
    //   paste -- the proxy is focused, so the native paste event fires on it
    //            and hands us the text directly.
    //
    // The proxy also gives the grid somewhere to hold focus between clicks,
    // which is what makes the shortcuts work at all after a drag-select.
    const proxy = document.createElement('textarea');
    proxy.className = 'tn-clip-proxy';
    proxy.setAttribute('aria-hidden', 'true');
    proxy.tabIndex = -1;
    box.appendChild(proxy);

    // Focus the proxy whenever the grid has the user's attention but no cell
    // is being typed in -- after a click, after a drag, after a bulk op.
    function focusProxy() {
      const act = document.activeElement;
      if (act && act.classList && act.classList.contains('tn-cell')) return;
      try { proxy.focus({ preventScroll: true }); } catch (e) { proxy.focus(); }
    }

    // Selection -> TSV. The BOUNDING BOX, because a rectangle is the only
    // shape a spreadsheet can represent; holes inside it carry their real
    // values rather than blanks.
    function selectionTsv() {
      const b = selBounds();
      if (!b) return null;
      const rows = [];
      for (let r = b.r0; r <= b.r1; r++) {
        const cells = [];
        for (let c = b.c0; c <= b.c1; c++) {
          const v = (t.cells[r] || [])[c];
          cells.push(v == null || !Number.isFinite(v) ? '' : fmtNum(v, dp));
        }
        rows.push(cells.join('\t'));
      }
      return { text: rows.join('\n'), rows: b.r1 - b.r0 + 1, cols: b.c1 - b.c0 + 1 };
    }

    // Paste a TSV block at the selection's top-left. Clipped to the table;
    // out-of-range values are refused by the encoder and counted, never
    // silently clamped. The pasted block becomes the new selection, which is
    // what every spreadsheet and tuning app does -- it shows you exactly what
    // landed and lets you immediately scale or undo it as a unit.
    function pasteTsv(text) {
      if (!invertible) { flashInfo('read-only table'); return; }
      const b = selBounds();
      if (!b) { flashInfo('select a cell first'); return; }
      const grid = String(text).replace(/\r\n?/g, '\n').replace(/\n+$/, '')
        .split('\n').map((line) => line.split('\t'));
      if (!grid.length || !grid[0].length) return;

      let wrote = 0, refused = 0, clipped = 0;
      let maxR = b.r0, maxC = b.c0;
      for (let i = 0; i < grid.length; i++) {
        const r = b.r0 + i;
        for (let j = 0; j < grid[i].length; j++) {
          const c = b.c0 + j;
          if (r >= t.rows || c >= t.cols) { clipped++; continue; }
          const raw = String(grid[i][j]).trim().replace(/,/g, '');
          if (raw === '') continue;             // blank leaves the cell alone
          const v = Number(raw);
          if (!Number.isFinite(v)) { clipped++; continue; }
          if (applyCell(r, c, v)) {
            wrote++;
            if (r > maxR) maxR = r;
            if (c > maxC) maxC = c;
          } else refused++;
        }
      }
      if (!wrote && !refused) { flashInfo('nothing to paste'); return; }

      t = window.XDF.decodeTable(item, tuningState.bin, h);
      // select what landed
      sel.clear();
      for (let r = b.r0; r <= maxR; r++) {
        for (let c = b.c0; c <= maxC; c++) sel.add(selKey(r, c));
      }
      anchor = { r: b.r0, c: b.c0 };
      paint();
      flashInfo(`pasted ${wrote}`
        + (refused ? `, ${refused} out of range` : '')
        + (clipped ? `, ${clipped} off-table` : ''));
    }

    // transient message in the toolbar's info slot, then back to the count
    let infoTimer = null;
    function flashInfo(msg) {
      selInfo.textContent = msg;
      if (infoTimer) clearTimeout(infoTimer);
      infoTimer = setTimeout(paint, 1800);
    }

    // The proxy's own copy/paste events: this is the path that actually runs.
    proxy.addEventListener('copy', (e) => {
      const tsv = selectionTsv();
      if (!tsv) return;
      e.preventDefault();
      e.clipboardData.setData('text/plain', tsv.text);
      flashInfo(`copied ${tsv.rows} × ${tsv.cols}`);
    });
    proxy.addEventListener('cut', (e) => {
      const tsv = selectionTsv();
      if (!tsv) return;
      e.preventDefault();
      e.clipboardData.setData('text/plain', tsv.text);
      flashInfo(`copied ${tsv.rows} × ${tsv.cols}`);
    });
    proxy.addEventListener('paste', (e) => {
      const txt = e.clipboardData && e.clipboardData.getData('text/plain');
      if (!txt) return;
      e.preventDefault();
      pasteTsv(txt);
    });

    const onKey = (e) => {
      if (e.key === 'Escape') { close(); return; }
      const act = document.activeElement;
      const inCell = act && act.classList && act.classList.contains('tn-cell');

      // Arrow keys move the selection when not editing text -- the way a grid
      // is expected to behave, and what makes keyboard-only tuning possible.
      if (!inCell && sel.size && /^Arrow(Up|Down|Left|Right)$/.test(e.key)) {
        e.preventDefault();
        const b = selBounds();
        const dr = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
        const dc = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
        if (e.shiftKey && anchor) {
          // extend the rectangle from the anchor
          const r = Math.min(t.rows - 1, Math.max(0, (b.r1 === anchor.r ? b.r0 : b.r1) + dr));
          const c = Math.min(t.cols - 1, Math.max(0, (b.c1 === anchor.c ? b.c0 : b.c1) + dc));
          selectRect(r, c, false);
        } else {
          const r = Math.min(t.rows - 1, Math.max(0, b.r0 + dr));
          const c = Math.min(t.cols - 1, Math.max(0, b.c0 + dc));
          sel.clear(); sel.add(selKey(r, c));
          anchor = { r, c };
          paint();
        }
        focusProxy();
        return;
      }

      const mod = e.metaKey || e.ctrlKey;

      // UNDO. Cmd/Ctrl+Z, the one shortcut users try without being told.
      if (mod && !e.shiftKey && /^z$/i.test(e.key) && !inCell) {
        e.preventDefault(); runOp('undo'); return;
      }

      // INCREMENT / DECREMENT. +/- nudge the selection by a step derived from
      // the table's own resolution, with a fine step on the bracket keys --
      // the two-tier coarse/fine split RomRaider uses. This is what makes
      // keyboard-only tuning practical: select a region, hold +, watch it move.
      if (!inCell && sel.size && invertible) {
        let dir = 0, fine = false;
        if (e.key === '+' || e.key === '=') dir = 1;
        else if (e.key === '-' || e.key === '_') dir = -1;
        else if (e.key === ']') { dir = 1; fine = true; }
        else if (e.key === '[') { dir = -1; fine = true; }
        if (dir) {
          e.preventDefault();
          const step = (fine ? fineStep : coarseStep) * dir;
          let n = 0, clamped = 0;
          beginBatch();
          for (const k of sel) {
            const i = k.indexOf(',');
            const r = +k.slice(0, i), c = +k.slice(i + 1);
            const cur = t.cells[r][c];
            if (cur == null || !Number.isFinite(cur)) continue;
            const res = applyCell(r, c, cur + step);
            if (res.ok) n++;
            if (res.clamped) clamped++;
          }
          endBatch(dir > 0 ? 'increment' : 'decrement');
          refresh();
          if (clamped) flashInfo(`${n} cells · ${clamped} clamped to range`);
          focusProxy();
          return;
        }
      }

      // Interpolate / smooth, on the same Shift+letter keys RomRaider uses.
      if (!inCell && e.shiftKey && !mod && sel.size) {
        const k = e.key.toUpperCase();
        if (k === 'H' || k === 'V' || k === 'I' || k === 'S') {
          e.preventDefault();
          runOp(k === 'H' ? 'interp-h' : k === 'V' ? 'interp-v'
            : k === 'I' ? 'interp-2d' : 'smooth');
          focusProxy();
          return;
        }
      }

      // The clipboard shortcuts themselves are handled by the proxy's copy /
      // paste events; we only need to make sure the proxy has focus when the
      // user reaches for them, and that a cell mid-edit keeps its own.
      if (mod && /^[cxv]$/i.test(e.key) && !inCell && sel.size) focusProxy();
    };
    document.addEventListener('keydown', onKey);
    box.querySelector('.tn-modal-x').onclick = close;
    box.querySelector('.tn-modal-done').onclick = close;
    back.onclick = (e) => { if (e.target === back) close(); };

    document.body.appendChild(back);
    paint();
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
    // Accepts decimal, 0x-hex, bare hex, and relative (+0x100 / -256). The
    // parse lives in the hex view because a relative jump is measured from
    // the cursor, which only it knows about.
    if (!hex.gotoExpr(raw)) shake(els.goto);
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
function createHexView(els, hooks = {}) {
  const { ROW_H, OVERSCAN } = TUNE_HEX;
  let raf = null;
  let cols = TUNE_HEX.BYTES_PER_ROW;

  // Cursor / selection. `anchor` is where the gesture started and `cursor` is
  // the live end, so a drag or a shift-click extends in either direction
  // without needing a separate "direction" flag. Selection is the inclusive
  // range between them; a bare cursor is a one-byte selection.
  let cursor = 0;
  let anchor = 0;
  let dragging = false;

  // Find state. `hits` holds match START offsets, sorted -- a plain sorted
  // Int32Array so the render loop can binary-search a row's span in O(log n)
  // instead of scanning every match for every byte.
  let find = { pattern: null, hits: null, at: -1, mode: 'hex' };

  // The inspector is always on: it is the panel that makes a hex dump
  // readable, and a toggle only ever hid the useful half of the pane.
  const inspectorOn = true;

  // Scratch view over one 8-byte window, reused so the inspector never
  // allocates per keystroke.
  const inspBuf = new ArrayBuffer(8);
  const inspU8 = new Uint8Array(inspBuf);
  const inspDV = new DataView(inspBuf);

  const clampOff = (o) => {
    const n = tuningState.bin ? tuningState.bin.length : 0;
    if (!n) return 0;
    return o < 0 ? 0 : o >= n ? n - 1 : o;
  };
  const selStart = () => Math.min(anchor, cursor);
  const selEnd = () => Math.max(anchor, cursor);   // inclusive
  const hex2 = (b) => b.toString(16).padStart(2, '0').toUpperCase();
  const hexOff = (o) => o.toString(16).padStart(6, '0').toUpperCase();

  // ---- find -----------------------------------------------------------------
  // Index of the first hit >= off, or hits.length. Used both to jump between
  // matches and to find where a row's matches begin.
  function lowerBound(hits, off) {
    let lo = 0;
    let hi = hits.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (hits[mid] < off) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  // Naive scan. A firmware image is at most a couple of MB and patterns are
  // short, so the worst case is a few million byte compares -- well under a
  // frame, and it saves carrying a KMP table around.
  function searchAll(bytes, pat) {
    const out = [];
    if (!pat || !pat.length || pat.length > bytes.length) return out;
    const last = bytes.length - pat.length;
    const p0 = pat[0];
    for (let i = 0; i <= last; i++) {
      if (bytes[i] !== p0) continue;
      let j = 1;
      while (j < pat.length && bytes[i + j] === pat[j]) j++;
      if (j === pat.length) out.push(i);
    }
    return out;
  }

  // "DE AD BE EF", "deadbeef" and "DE-AD" all mean the same four bytes. An odd
  // number of hex digits is a half-typed byte, not an error worth shouting
  // about -- we just decline to search until it is complete.
  function parseHexPattern(text) {
    const clean = text.replace(/(0x)|[^0-9a-fA-F]/g, '');
    if (!clean.length || clean.length % 2) return null;
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
  }

  // Latin-1, not UTF-8: firmware strings are single-byte, and a UTF-8 encode
  // would silently turn a typed 'é' into two bytes that are not in the image.
  function parseTextPattern(text) {
    if (!text.length) return null;
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
    return out;
  }

  function runFind() {
    const raw = els.findQ ? els.findQ.value : '';
    const bytes = tuningState.bin;
    find.pattern = null;
    find.hits = null;
    find.at = -1;
    if (bytes && raw.trim()) {
      const pat = find.mode === 'hex' ? parseHexPattern(raw) : parseTextPattern(raw);
      if (pat) {
        find.pattern = pat;
        find.hits = Int32Array.from(searchAll(bytes, pat));
      }
    }
    paintFindCount();
    schedule();
  }

  function paintFindCount() {
    if (!els.findCount) return;
    if (!find.hits) { els.findCount.textContent = ''; return; }
    if (!find.hits.length) { els.findCount.textContent = 'no match'; return; }
    const nth = find.at >= 0 ? `${find.at + 1}/` : '';
    els.findCount.textContent = `${nth}${find.hits.length} match${find.hits.length === 1 ? '' : 'es'}`;
  }

  function stepFind(dir) {
    if (!find.hits || !find.hits.length) return;
    let idx;
    if (find.at < 0) {
      // First step starts from the cursor rather than from the top, so the
      // search follows where you were already looking.
      idx = lowerBound(find.hits, dir > 0 ? cursor + 1 : cursor);
      if (dir < 0) idx -= 1;
    } else {
      idx = find.at + dir;
    }
    if (idx < 0) idx = find.hits.length - 1;
    if (idx >= find.hits.length) idx = 0;
    find.at = idx;
    const off = find.hits[idx];
    setCursor(off, false);
    // select the whole match, so its length is visible in the status strip
    anchor = off;
    cursor = clampOff(off + find.pattern.length - 1);
    scrollIntoView(off);
    paintFindCount();
    schedule();
  }

  // ---- data inspector -------------------------------------------------------
  // Pure decode of up to 8 bytes at `off`. Split out from the DOM so it can be
  // unit-checked against known patterns.
  function inspectAt(bytes, off) {
    const avail = Math.min(8, bytes.length - off);
    inspU8.fill(0);
    for (let i = 0; i < avail; i++) inspU8[i] = bytes[off + i];
    const b = inspU8[0];
    const out = {
      avail,
      binary: b.toString(2).padStart(8, '0'),
      char: b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : null,
      int8: inspDV.getInt8(0),
      uint8: b,
      int16le: avail >= 2 ? inspDV.getInt16(0, true) : null,
      uint16le: avail >= 2 ? inspDV.getUint16(0, true) : null,
      int16be: avail >= 2 ? inspDV.getInt16(0, false) : null,
      uint16be: avail >= 2 ? inspDV.getUint16(0, false) : null,
      int32le: avail >= 4 ? inspDV.getInt32(0, true) : null,
      uint32le: avail >= 4 ? inspDV.getUint32(0, true) : null,
      int32be: avail >= 4 ? inspDV.getInt32(0, false) : null,
      uint32be: avail >= 4 ? inspDV.getUint32(0, false) : null,
      f32le: avail >= 4 ? inspDV.getFloat32(0, true) : null,
      f32be: avail >= 4 ? inspDV.getFloat32(0, false) : null,
      f64le: avail >= 8 ? inspDV.getFloat64(0, true) : null,
      f64be: avail >= 8 ? inspDV.getFloat64(0, false) : null,
    };
    return out;
  }

  // Floats in firmware are as often garbage as not, so show enough digits to
  // recognise a real constant without letting 1e-40 noise blow the column out.
  function fmtFloat(v) {
    if (v == null) return '—';
    if (!Number.isFinite(v)) return Number.isNaN(v) ? 'NaN' : (v > 0 ? '+Inf' : '-Inf');
    if (v === 0) return '0';
    const a = Math.abs(v);
    if (a >= 1e-4 && a < 1e9) return String(Number(v.toPrecision(9)));
    return v.toExponential(6);
  }
  const fmtInt = (v) => (v == null ? '—' : String(v));

  function paintInspector() {
    if (!els.inspRows) return;
    const bytes = tuningState.bin;
    if (!bytes || !bytes.length) { els.inspRows.innerHTML = ''; return; }
    const d = inspectAt(bytes, cursor);
    const rows = [
      ['int8', String(d.int8), ''],
      ['uint8', String(d.uint8), `0x${hex2(d.uint8)}`],
      ['int16 LE', fmtInt(d.int16le), fmtInt(d.uint16le)],
      ['int16 BE', fmtInt(d.int16be), fmtInt(d.uint16be)],
      ['int32 LE', fmtInt(d.int32le), fmtInt(d.uint32le)],
      ['int32 BE', fmtInt(d.int32be), fmtInt(d.uint32be)],
      ['float32 LE', fmtFloat(d.f32le), ''],
      ['float32 BE', fmtFloat(d.f32be), ''],
      ['float64 LE', fmtFloat(d.f64le), ''],
      ['float64 BE', fmtFloat(d.f64be), ''],
      ['binary', d.binary, ''],
      ['char', d.char == null ? '—' : d.char, d.char == null ? 'non-printable' : ''],
    ];
    els.inspRows.innerHTML = rows.map(([k, v, alt]) =>
      `<div class="tn-insp-row"><span class="tn-insp-k">${esc(k)}</span>`
      + `<span class="tn-insp-v">${esc(v)}</span>`
      + `<span class="tn-insp-alt">${esc(alt || '')}</span></div>`).join('');
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---- status strip ---------------------------------------------------------
  function paintStatus() {
    const bytes = tuningState.bin;
    if (els.hsCur) {
      els.hsCur.textContent = bytes
        ? `0x${hexOff(cursor)} · ${cursor.toLocaleString()} · row ${Math.floor(cursor / cols)} col ${cursor % cols}`
        : '';
    }
    if (els.hsSel) {
      if (!bytes) { els.hsSel.textContent = ''; return; }
      const s = selStart();
      const e = selEnd();
      const n = e - s + 1;
      els.hsSel.textContent = n > 1
        ? `sel 0x${hexOff(s)}–0x${hexOff(e)} · ${n.toLocaleString()} bytes`
        : `1 byte`;
    }
  }

  // ---- rendering ------------------------------------------------------------
  function rowHtml(off, bytes, hitIdx) {
    const len = Math.min(cols, bytes.length - off);
    const hl = tuningState.highlight;
    // the coverage map, when a definition is open and the overlay is on
    const cover = tuningState.coverOn ? tuningState.cover : null;
    const ss = selStart();
    const se = selEnd();
    const curRow = Math.floor(cursor / cols) === Math.floor(off / cols);
    const curCol = cursor % cols;
    const patLen = find.pattern ? find.pattern.length : 0;
    let hexCells = '';
    let ascii = '';
    for (let i = 0; i < cols; i++) {
      // a subtle gap every 8 bytes, the way every real hex editor groups them
      const gap = i > 0 && i % 8 === 0 ? ' tn-hb-gap' : '';
      if (i >= len) { hexCells += `<span class="tn-hb tn-hb-pad${gap}">  </span>`; ascii += ' '; continue; }
      const abs = off + i;
      const b = bytes[abs];
      const changed = tuningState.orig && tuningState.orig[abs] !== b;
      const inHl = hl && abs >= hl.start && abs < hl.end;
      const inSel = abs >= ss && abs <= se;
      // one array read -- this runs for every byte on every scroll frame
      const slot = cover ? cover[abs] : 0;
      // hitIdx was resolved once for the row; walking it forward is O(1) here
      let inHit = false;
      if (patLen) {
        while (hitIdx.i < hitIdx.hits.length && hitIdx.hits[hitIdx.i] + patLen <= abs) hitIdx.i++;
        inHit = hitIdx.i < hitIdx.hits.length && hitIdx.hits[hitIdx.i] <= abs;
      }
      let cls = 'tn-hb' + gap;
      if (slot) cls += ' tn-cv tn-cv' + slot;
      if (changed) cls += ' tn-hb-changed';
      if (inHl) cls += ' tn-hb-hl';
      if (inHit) cls += ' tn-hb-hit';
      if (inSel) cls += ' tn-hb-sel';
      if (abs === cursor) cls += ' tn-hb-cur';
      else if (curRow || i === curCol) cls += ' tn-hb-cross';
      hexCells += `<span class="${cls}" data-off="${abs}" title="0x${abs.toString(16).toUpperCase()}">${hex2(b)}</span>`;
      const ch = b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
      const acls = 'tn-ha' + (inHl ? ' tn-ha-hl' : '') + (changed ? ' tn-ha-changed' : '')
        + (inSel ? ' tn-ha-sel' : '') + (inHit ? ' tn-ha-hit' : '');
      ascii += `<span class="${acls}" data-off="${abs}">${ch === '<' ? '&lt;' : ch === '&' ? '&amp;' : ch}</span>`;
    }
    return `<div class="tn-hex-row${curRow ? ' tn-hex-row-cur' : ''}" style="height:${ROW_H}px">`
      + `<span class="tn-hoff">${hexOff(off)}</span>`
      + `<span class="tn-hbytes">${hexCells}</span>`
      + `<span class="tn-hascii">${ascii}</span></div>`;
  }

  function render() {
    raf = null;
    const bytes = tuningState.bin;
    if (!bytes) {
      els.hexEmpty.hidden = false;
      els.hexSpacer.hidden = true;
      // drop the rows too: the container is hidden, but leaving a previous
      // file's bytes in the DOM means Clear only *looks* like it worked, and
      // anything walking the document still finds them
      els.hexWindow.innerHTML = '';
      if (els.inspRows) els.inspRows.innerHTML = '';
      paintStatus();
      return;
    }
    els.hexEmpty.hidden = true;
    els.hexSpacer.hidden = false;
    const totalRows = Math.ceil(bytes.length / cols);
    els.hexSpacer.style.height = totalRows * ROW_H + 'px';
    const st = els.hexScroll.scrollTop;
    const vh = els.hexScroll.clientHeight || 480;
    const first = Math.max(0, Math.floor(st / ROW_H) - OVERSCAN);
    const count = Math.min(totalRows - first, Math.ceil(vh / ROW_H) + 2 * OVERSCAN);
    els.hexWindow.style.transform = `translateY(${first * ROW_H}px)`;
    // Seed the match cursor once for the whole window rather than per byte:
    // one binary search, then a forward walk that never rewinds.
    const patLen = find.pattern ? find.pattern.length : 0;
    const hitIdx = { hits: find.hits || [], i: 0 };
    if (patLen && find.hits && find.hits.length) {
      hitIdx.i = Math.max(0, lowerBound(find.hits, first * cols - patLen + 1));
    }
    let html = '';
    for (let r = 0; r < count; r++) {
      html += rowHtml((first + r) * cols, bytes, hitIdx);
    }
    els.hexWindow.innerHTML = html;
    if (els.hexMeta) {
      els.hexMeta.textContent = `${totalRows.toLocaleString()} rows · ${fmtBytes(bytes.length)}`;
    }
    paintStatus();
    paintInspector();
  }

  const schedule = () => { if (raf == null) raf = requestAnimationFrame(render); };
  els.hexScroll.addEventListener('scroll', schedule, { passive: true });

  // Keep the cursor row on screen without yanking the view when it is already
  // visible -- scrollTo() always centres, which is jarring for arrow keys.
  function scrollIntoView(off) {
    const row = Math.floor(off / cols);
    const top = row * ROW_H;
    const vh = els.hexScroll.clientHeight || 480;
    const st = els.hexScroll.scrollTop;
    if (top < st) els.hexScroll.scrollTop = top;
    else if (top + ROW_H > st + vh) els.hexScroll.scrollTop = top + ROW_H - vh;
  }

  function setCursor(off, extend) {
    cursor = clampOff(off);
    if (!extend) anchor = cursor;
    // Repaint: the status strip and the data inspector both read `cursor`,
    // and a click moves it without any scroll to trigger render() on its own.
    // moveCursor() schedules too -- double-scheduling is free, the rAF guard
    // collapses it to one frame.
    schedule();
  }

  function moveCursor(delta, extend) {
    setCursor(cursor + delta, extend);
    scrollIntoView(cursor);
    schedule();
  }

  // ---- pointer selection ----------------------------------------------------
  function offsetFromEvent(e) {
    const cell = e.target.closest && e.target.closest('[data-off]');
    return cell ? Number(cell.dataset.off) : null;
  }

  els.hexWindow.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !tuningState.bin) return;
    const off = offsetFromEvent(e);
    if (off == null) return;
    setCursor(off, e.shiftKey);      // shift-click extends from the old anchor
    dragging = true;
    // Text selection would fight the drag, and the row is `white-space: pre`
    // so the browser's own selection is useless here anyway.
    e.preventDefault();
    els.hexScroll.focus();
    schedule();
  });

  els.hexWindow.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const off = offsetFromEvent(e);
    if (off == null || off === cursor) return;
    cursor = clampOff(off);
    schedule();
  });

  // on window, not the pane: a drag that ends off the grid must still end
  window.addEventListener('mouseup', () => { dragging = false; });

  // NO click-to-open on the hex grid.
  //
  // Single-clicking a mapped byte used to select its whole region and open the
  // owning parameter. It never worked reliably -- the highlight it painted was
  // entangled with the definition tree's own spotlight logic -- and a plain
  // click is better spent on moving the cursor, which is what a hex editor is
  // expected to do. The same action lives on the right-click menu ("Open ..."),
  // where it is explicit and does work.

  // ---- context menu ---------------------------------------------------------
  //
  // Right-click replaces the browser's own menu, which offers nothing useful
  // over a hex dump. The actions are the ones a tuner reaches for at a byte:
  // move data in and out, write a value across a range, and jump to whatever
  // parameter owns this address.
  //
  // The menu acts on the SELECTION when the clicked byte is inside one, and on
  // the single clicked byte otherwise -- so right-clicking away from a
  // selection does the obvious local thing instead of silently operating on
  // bytes elsewhere in the file.
  let menuEl = null;

  function closeMenu() {
    if (!menuEl) return;
    menuEl.remove();
    menuEl = null;
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onMenuKey, true);
  }
  const onDocDown = (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); };
  const onMenuKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } };

  // bytes -> "DE AD BE EF"
  function hexOfRange(s, e) {
    const bytes = tuningState.bin;
    const out = [];
    for (let i = s; i <= e && i < bytes.length; i++) out.push(hex2(bytes[i]));
    return out.join(' ');
  }

  // Write text to the clipboard without the async API, which is
  // permission-gated and silently denied on plain http:// origins. A hidden
  // textarea inside the user-gesture stack is the route that actually works.
  function copyText(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (err) { return false; }
  }

  async function pasteHexAt(off) {
    let text = '';
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        text = await navigator.clipboard.readText();
      }
    } catch (err) { text = ''; }
    if (!text) {
      text = await inputDialog({
        title: 'Paste bytes',
        body: `Paste hex bytes to write at 0x${hexOff(off)}. `
          + 'Spaces optional; 0x prefixes ignored.',
        kind: 'text', example: 'DE AD BE EF', confirmLabel: 'Write',
      }) || '';
    }
    const clean = String(text).replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '');
    if (clean.length < 2) return;
    const bytes = [];
    for (let i = 0; i + 1 < clean.length; i += 2) bytes.push(parseInt(clean.substr(i, 2), 16));
    const room = tuningState.bin.length - off;
    const n = Math.min(bytes.length, room);
    if (n <= 0) return;
    if (typeof hooks.onWriteBytes === 'function') {
      hooks.onWriteBytes(off, new Uint8Array(bytes.slice(0, n)));
    } else if (typeof hooks.onWriteByte === 'function') {
      for (let i = 0; i < n; i++) hooks.onWriteByte(off + i, bytes[i]);
    }
    schedule();
  }

  // Fill a range with one byte value -- the "write values" case, and the one
  // that most wants a range rather than a single cell.
  async function fillRange(s, e) {
    const n = e - s + 1;
    const v = await inputDialog({
      title: `Write value across ${n} byte${n === 1 ? '' : 's'}`,
      body: `Every byte from 0x${hexOff(s)} to 0x${hexOff(e)} will be set to `
        + 'this value. Enter hex (00-FF) or decimal.',
      kind: 'text', example: 'FF', confirmLabel: 'Write', danger: true,
    });
    if (v == null) return;
    const raw = String(v).trim();
    const parsed = /^0x/i.test(raw) || /[a-f]/i.test(raw)
      ? parseInt(raw.replace(/^0x/i, ''), 16) : parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 0xff) return;
    const buf = new Uint8Array(n).fill(parsed & 0xff);
    if (typeof hooks.onWriteBytes === 'function') hooks.onWriteBytes(s, buf);
    else if (typeof hooks.onWriteByte === 'function') {
      for (let i = 0; i < n; i++) hooks.onWriteByte(s + i, parsed & 0xff);
    }
    schedule();
  }

  function openMenu(x, y, off) {
    closeMenu();
    const bytes = tuningState.bin;
    if (!bytes) return;
    // act on the selection only when the click landed inside it
    const inSel = off >= selStart() && off <= selEnd() && selEnd() > selStart();
    const s = inSel ? selStart() : off;
    const e = inSel ? selEnd() : off;
    const n = e - s + 1;
    const owns = (typeof hooks.ownerAt === 'function') ? hooks.ownerAt(off) : null;

    const items = [
      { label: `Copy ${n} byte${n === 1 ? '' : 's'} as hex`,
        run: () => copyText(hexOfRange(s, e)) },
      { label: 'Copy offset', sub: `0x${hexOff(off)}`,
        run: () => copyText('0x' + hexOff(off)) },
      { sep: true },
      { label: 'Paste hex here', run: () => pasteHexAt(off) },
      { label: n === 1 ? 'Write value…' : `Fill ${n} bytes…`,
        run: () => fillRange(s, e) },
      { label: 'Edit this byte…', run: () => editRawByte(off) },
      { sep: true },
      { label: owns ? `Open ${owns}` : 'Open in table view',
        // Say WHY it is unavailable. A greyed item with no reason reads as a
        // bug; "no parameter here" is the actual answer, and it points at the
        // real situation -- the definition describes other addresses, not
        // this one.
        sub: owns ? null : 'no parameter here',
        disabled: !owns,
        run: () => { if (typeof hooks.onByteClick === 'function') hooks.onByteClick(off); } },
    ];

    // ...and offer a way OUT of an undescribed region, rather than leaving a
    // dead item as the only answer. Only when there is somewhere to go.
    const near = (typeof hooks.nearestMapped === 'function') ? hooks.nearestMapped(off) : null;
    if (!owns && near != null) {
      items.push({ label: 'Go to nearest mapped byte',
        sub: '0x' + hexOff(near),
        run: () => { setCursor(near, false); scrollIntoView(near); schedule(); } });
    }

    const m = document.createElement('div');
    m.className = 'tn-ctx';
    m.innerHTML = items.map((it, i) => it.sep
      ? '<div class="tn-ctx-sep"></div>'
      : `<button type="button" class="tn-ctx-item${it.disabled ? ' disabled' : ''}"`
        + ` data-i="${i}"${it.disabled ? ' disabled' : ''}>`
        + `<span>${esc(it.label)}</span>`
        + (it.sub ? `<span class="tn-ctx-sub mono">${esc(it.sub)}</span>` : '')
        + '</button>').join('');
    document.body.appendChild(m);

    // keep it on screen
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
    m.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';

    m.addEventListener('click', (ev) => {
      const b = ev.target.closest('.tn-ctx-item');
      if (!b || b.disabled) return;
      const it = items[Number(b.dataset.i)];
      closeMenu();
      if (it && typeof it.run === 'function') it.run();
    });
    menuEl = m;
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onMenuKey, true);
  }

  // Bound to the whole PANE, not just the byte cells: right-clicking the
  // offset column, a gap between groups, or the empty space past the last
  // byte on a row should still get the menu. When the click did not land on a
  // byte we act at the cursor, which is where the status strip already says
  // we are.
  els.hexPane.addEventListener('contextmenu', (e) => {
    if (!tuningState.bin) return;
    // let the find box, jump box and toolbar keep the native menu, where
    // the browser's own cut/copy/paste is genuinely what you want
    if (e.target.closest('input, select, textarea, .tn-hex-head, .tn-find')) return;
    e.preventDefault();
    const cell = e.target.closest && e.target.closest('[data-off]');
    const off = cell ? Number(cell.dataset.off) : cursor;
    // a right-click outside the selection moves the cursor there first, so the
    // menu and the status strip agree about what is being acted on
    if (cell && !(off >= selStart() && off <= selEnd() && selEnd() > selStart())) {
      setCursor(off, false);
    }
    openMenu(e.clientX, e.clientY, off);
  });

  // double-click a byte to edit it raw
  // RAW EDIT ON DOUBLE-CLICK.
  //
  // Not a 'dblclick' listener: render() rebuilds hexWindow.innerHTML, so the
  // first click's repaint replaces the cell node and the second click lands on
  // a different element -- the browser then never pairs them and dblclick
  // never fires. MouseEvent.detail counts clicks in the sequence regardless of
  // which node they hit, so it survives the re-render.
  els.hexWindow.addEventListener('mousedown', (e) => {
    if (e.detail < 2) return;
    const cell = e.target.closest && e.target.closest('.tn-hb[data-off]');
    if (!cell || !tuningState.bin) return;
    e.preventDefault();          // stop the text-selection a 2nd click starts
    editRawByte(Number(cell.dataset.off));
  });

  // ---- keyboard -------------------------------------------------------------
  els.hexScroll.addEventListener('keydown', (e) => {
    if (!tuningState.bin) return;
    const ext = e.shiftKey;
    const page = Math.max(1, Math.floor((els.hexScroll.clientHeight || 480) / ROW_H) - 1) * cols;
    switch (e.key) {
      case 'ArrowLeft': moveCursor(-1, ext); break;
      case 'ArrowRight': moveCursor(1, ext); break;
      case 'ArrowUp': moveCursor(-cols, ext); break;
      case 'ArrowDown': moveCursor(cols, ext); break;
      case 'PageUp': moveCursor(-page, ext); break;
      case 'PageDown': moveCursor(page, ext); break;
      // Home/End are row-local; with Ctrl they run to the ends of the image,
      // which is the convention every editor shares.
      case 'Home': moveCursor(e.ctrlKey || e.metaKey ? -cursor : -(cursor % cols), ext); break;
      case 'End': moveCursor(e.ctrlKey || e.metaKey
        ? tuningState.bin.length - 1 - cursor
        : (cols - 1 - (cursor % cols)), ext); break;
      case 'Enter': editRawByte(cursor); break;
      default: return;
    }
    e.preventDefault();
  });

  async function editRawByte(off) {
    const cur = tuningState.bin[off];
    const v = await inputDialog({
      title: `Edit byte 0x${off.toString(16).toUpperCase()}`,
      body: `Current value 0x${hex2(cur)} (${cur}). Enter a new byte as hex (00–FF) or decimal.`,
      kind: 'text', example: 'FF', confirmLabel: 'Write',
    });
    if (v == null) return;
    const parsed = /^0x/i.test(v) || /[a-f]/i.test(v) ? parseInt(v, 16) : parseInt(v, 10);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 0xff) return;
    // Route through the owner's writer rather than poking `bin` directly: it is
    // what recounts changed bytes and schedules the session save, so a raw hex
    // edit shows up in the toolbar and survives a revisit exactly like an edit
    // made through a definition does.
    if (typeof hooks.onWriteByte === 'function') {
      hooks.onWriteByte(off, parsed & 0xff);
    } else {
      tuningState.bin[off] = parsed & 0xff;
    }
    render();
  }

  // ---- chrome wiring --------------------------------------------------------
  if (els.cols) {
    // the markup defaults to 16; adopt the width from a previous visit instead
    els.cols.value = String(cols);
    els.cols.onchange = () => {
      cols = Number(els.cols.value) || 16;
      // written back so re-entering the screen restores the chosen width
      TUNE_HEX.BYTES_PER_ROW = cols;
      scrollIntoView(cursor);
      schedule();
    };
  }

  if (els.findQ) {
    let timer = null;
    els.findQ.oninput = () => {
      // debounce: a full-image scan per keystroke is wasted work while the
      // pattern is still being typed
      if (timer) clearTimeout(timer);
      timer = setTimeout(runFind, 140);
    };
    els.findQ.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (timer) { clearTimeout(timer); timer = null; runFind(); }
      stepFind(e.shiftKey ? -1 : 1);
    };
  }
  if (els.findModes) {
    els.findModes.onclick = (e) => {
      const b = e.target.closest && e.target.closest('.tn-find-mode');
      if (!b) return;
      find.mode = b.dataset.mode;
      els.findModes.querySelectorAll('.tn-find-mode')
        .forEach((x) => x.classList.toggle('on', x === b));
      if (els.findQ) {
        els.findQ.placeholder = find.mode === 'hex' ? 'DE AD BE EF' : 'BOSCH';
        els.findQ.focus();
      }
      runFind();
    };
  }
  if (els.findPrev) els.findPrev.onclick = () => stepFind(-1);
  if (els.findNext) els.findNext.onclick = () => stepFind(1);

  return {
    refresh() {
      // refresh() is the "bytes may have changed" signal, so any find results
      // are stale by definition -- re-run rather than leave phantom matches
      // highlighted over bytes that no longer hold the pattern.
      if (tuningState.bin && cursor >= tuningState.bin.length) { cursor = 0; anchor = 0; }
      if (find.pattern) runFind();
      else schedule();
    },
    scrollTo(off) {
      setCursor(off, false);
      const row = Math.floor(off / cols);
      const vh = els.hexScroll.clientHeight || 480;
      els.hexScroll.scrollTop = Math.max(0, row * ROW_H - vh / 2);
      schedule();
    },
    // "0x1000" / "4096" / "+0x100" / "-256" -> true if we could jump
    gotoExpr(raw) {
      const bytes = tuningState.bin;
      if (!bytes) return false;
      const m = /^([+-]?)\s*(0x)?([0-9a-fA-F]+)$/.exec(String(raw).trim());
      if (!m) return false;
      // No 0x prefix and no letters means the user typed decimal; anything
      // with a hex digit a-f can only have been meant as hex.
      const hexish = !!m[2] || /[a-fA-F]/.test(m[3]);
      const mag = parseInt(m[3], hexish ? 16 : 10);
      if (!Number.isFinite(mag)) return false;
      const target = m[1] ? cursor + (m[1] === '-' ? -mag : mag) : mag;
      if (target < 0 || target >= bytes.length) return false;
      this.scrollTo(target);
      return true;
    },
    // exposed for unit checks
    _inspectAt: inspectAt,
    _searchAll: searchAll,
    _parseHexPattern: parseHexPattern,
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
