/**
 * @file Tuning screen: the entry point. Draws the toolbar and workspace,
 * builds the hex view, wires file loading, and owns the three operations
 * every other piece routes through -- writing bytes into the image,
 * recounting changes, and repainting the status line. Loads last.
 */

/* exported showTuning, tnWriteBytes, tnRecountChanges, tnUpdateStatus, tnShowLoadedImage */

/**
 * The toolbar markup.
 * @returns {string}
 */
function tnToolbarHtml() {
  return `
    <button class="btn tn-load-bin">Load BIN…</button>
    <button class="btn tn-read-ecu">Read from ECU…</button>
    <button class="btn tn-load-xdf" disabled>Load .xdf…</button>
    <button class="btn tn-browse-xdf" title="Browse the shared community definition library">Browse XDFs…</button>
    <button class="btn primary tn-save" disabled>Save BIN…</button>
    <button class="btn tn-clear" disabled title="Unload the firmware and definition, and forget the saved session">Clear</button>
    <span class="tn-file" id="tn-file"></span>
    <span class="tn-status" id="tn-status"></span>
    <input type="file" class="tn-file-input" id="tn-bin-input" hidden />
    <input type="file" class="tn-file-input" id="tn-xdf-input" accept=".xdf,.xml" hidden />`;
}

/**
 * The workspace markup: definitions (left) | hex (right).
 * @returns {string}
 */
function tnWorkspaceHtml() {
  return `
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
        <span class="tn-hs-hint" id="tn-hs-hint">click a shaded byte to open its parameter · click-drag to select · ⇧-click extends · arrows move · dbl-click edits</span>
      </div>
    </section>`;
}

/**
 * Look up the screen's live elements.
 * @param {HTMLElement} bar
 * @param {HTMLElement} workspace
 * @returns {TuningEls}
 */
function tnCollectEls(bar, workspace) {
  return {
    loadBin: bar.querySelector('.tn-load-bin'),
    readEcu: bar.querySelector('.tn-read-ecu'),
    loadXdf: bar.querySelector('.tn-load-xdf'),
    browseXdf: bar.querySelector('.tn-browse-xdf'),
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
}

/**
 * Read a File into bytes.
 * @param {File} file
 * @returns {Promise<Uint8Array>}
 */
function tnReadFileBytes(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(new Uint8Array(fr.result));
    fr.onerror = () => reject(new Error('could not read file'));
    fr.readAsArrayBuffer(file);
  });
}

/**
 * Show the loaded image's name and size, and enable what needs an image.
 * @param {TuningEditor} ed
 * @returns {void}
 */
function tnShowLoadedImage(ed) {
  const els = ed.els;
  els.loadXdf.disabled = false;
  els.save.disabled = false;
  els.file.textContent = `${tuningState.fileName} · ${fmtBytes(tuningState.bin.length)}`;
}

/**
 * A BIN was picked from disk.
 * @param {TuningEditor} ed
 * @param {File|undefined} file
 * @returns {Promise<void>}
 */
async function tnOnBinChosen(ed, file) {
  if (!file) return;
  try {
    const bytes = await tnReadFileBytes(file);
    tnAdoptImage(bytes, file.name || 'firmware.bin');
    tnShowLoadedImage(ed);
    tnBuildCoverage(); // addresses are BIN-relative; rebuild for this image
    tnSaveSoon();
    ed.hex.refresh();
    tnOfferDefinitionFor(ed, bytes); // ask, never auto-load
    // re-decode any open definition against the new image
    if (tuningState.def) tnRenderDefs(ed);
    tnUpdateStatus(ed);
  } catch (e) {
    ed.els.status.textContent = e.message;
  }
}

/**
 * A .xdf was picked from disk. Parse errors (bad XML, encrypted) surface in
 * the defs pane, non-fatally.
 * @param {TuningEditor} ed
 * @param {File|undefined} file
 * @returns {Promise<void>}
 */
async function tnOnXdfChosen(ed, file) {
  if (!file) return;
  try {
    const text = await file.text();
    const def = window.XDF.parseXdf(text);
    tnAdoptDefinition(def, text, file.name || 'definition.xdf');
    tnApplyDefinition(ed);
  } catch (e) {
    tuningState.def = null;
    ed.els.defs.innerHTML = '';
    ed.els.defs.appendChild(
      makeEmpty(
        '⚠',
        `Could not parse ${esc(file.name || '.xdf')}`,
        esc(e.message)
      )
    );
  }
}

/**
 * Applying an edit: splice new bytes into the working image, recount
 * changes, repaint the hex view, and refresh the status line.
 * @param {TuningEditor} ed
 * @param {number} address
 * @param {Uint8Array} bytes
 * @returns {boolean} False when the write would run outside the image.
 */
function tnWriteBytes(ed, address, bytes) {
  if (
    !tuningState.bin ||
    address < 0 ||
    address + bytes.length > tuningState.bin.length
  )
    return false;
  for (let i = 0; i < bytes.length; i++)
    tuningState.bin[address + i] = bytes[i];
  tnRecountChanges();
  ed.hex.refresh();
  tnUpdateStatus(ed);
  return true;
}

/**
 * Recount the bytes differing from the load-time snapshot, and schedule a
 * session save.
 * @returns {void}
 */
function tnRecountChanges() {
  tnSaveSoon();
  const a = tuningState.bin,
    b = tuningState.orig;
  if (!a || !b) {
    tuningState.changed = 0;
    return;
  }
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  tuningState.changed = n;
}

/**
 * Repaint the map toggle. The control only means anything once a
 * definition has been placed against a BIN. Its label carries the coverage
 * figure, which is the useful number: how much of this image the
 * definition actually describes.
 * @param {TuningEditor} ed
 * @returns {void}
 */
function tnPaintMapToggle(ed) {
  const info = tuningState.coverInfo;
  const toggle = ed.els.mapToggle;
  if (!toggle) return;
  toggle.hidden = !info;
  if (!info) return;
  const pct = info.total ? (100 * info.described) / info.total : 0;
  toggle.classList.toggle('on', !!tuningState.coverOn);
  toggle.setAttribute('aria-pressed', tuningState.coverOn ? 'true' : 'false');
  toggle.querySelector('.tn-map-label').textContent =
    `map · ${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
  toggle.title =
    `${info.items} parameters cover ` +
    `${info.described.toLocaleString()} of ${info.total.toLocaleString()} bytes ` +
    `(${pct.toFixed(1)}%) — click to ${tuningState.coverOn ? 'hide' : 'show'}`;
}

/**
 * Repaint the toolbar status line, the status-bar figure, the Clear
 * button and the map toggle.
 * @param {TuningEditor} ed
 * @returns {void}
 */
function tnUpdateStatus(ed) {
  const els = ed.els;
  const parts = [];
  if (tuningState.def) {
    const n = tuningState.def.items.length;
    parts.push(`${esc(tuningState.defName)} · ${n} item${n === 1 ? '' : 's'}`);
  }
  if (tuningState.changed)
    parts.push(
      `${tuningState.changed} byte${tuningState.changed === 1 ? '' : 's'} changed`
    );
  els.status.innerHTML = parts
    .map((p, i) =>
      i === 1 ? `<span class="tn-dirty">${p}</span>` : `<span>${p}</span>`
    )
    .join('<span class="tn-sep">·</span>');
  sbRight.textContent = tuningState.bin
    ? `${fmtBytes(tuningState.bin.length)}${tuningState.changed ? ` · ${tuningState.changed} Δ` : ''}`
    : '';

  if (els.clear) els.clear.disabled = !(tuningState.bin || tuningState.def);
  tnPaintMapToggle(ed);
}

/**
 * Enter the Tuning screen.
 * @returns {void}
 */
function showTuning() {
  if (typeof cancelSweep === 'function') cancelSweep();
  lastScreen = showTuning;
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: 'Apps', fn: showApps },
    { label: 'Tuning' },
  ]);
  document.body.classList.add('apps-section');
  sbLeft.textContent = 'tuning';

  view.innerHTML = head(
    'Tuning',
    'ECU Firmware Editor',
    'Load a firmware BIN and edit it as raw hex, or open a TunerPro .xdf to ' +
      'tune named constants, flags and tables. Everything stays on this device.'
  );

  const backAction = {
    key: 'Escape',
    keyLabel: 'Esc',
    label: 'Back',
    kind: 'back',
    fn: () => showApps(),
  };

  if (typeof window.XDF === 'undefined') {
    view.insertAdjacentHTML(
      'beforeend',
      errorBlock('The XDF engine (core/xdf/) did not load.', 'red')
    );
    setActions([backAction]);
    return;
  }

  const bar = document.createElement('div');
  bar.className = 'tn-bar';
  bar.innerHTML = tnToolbarHtml();
  view.appendChild(bar);

  const workspace = document.createElement('div');
  workspace.className = 'tn-workspace';
  workspace.innerHTML = tnWorkspaceHtml();
  view.appendChild(workspace);

  const els = tnCollectEls(bar, workspace);
  /** @type {TuningEditor} */
  const ed = { els, hex: null, suppressSpotlightScroll: false };
  ed.hex = createHexView(els, {
    onByteClick: (off, opts) => tnOpenItemAt(ed, off, opts),
    regionAt: tnRegionAt,
    onWriteByte: (off, val) => tnWriteBytes(ed, off, new Uint8Array([val])),
    onWriteBytes: (off, buf) => tnWriteBytes(ed, off, buf),
    nearestMapped: tnNearestMapped,
    ownerAt: tnOwnerTitleAt,
  });

  // the legend: one dot per colour slot, so the rotation is self-explaining
  if (els.mapToggle) {
    els.mapToggle.querySelector('.tn-map-swatches').innerHTML = Array.from(
      { length: TN_COVER_SLOTS },
      (_, i) => `<i class="tn-cv${i + 1}"></i>`
    ).join('');
    els.mapToggle.onclick = () => {
      tuningState.coverOn = !tuningState.coverOn;
      tnUpdateStatus(ed);
      ed.hex.refresh();
    };
  }

  els.readEcu.onclick = () => tnOpenReadFromEcu(ed);
  els.loadBin.onclick = () => els.binInput.click();
  els.loadXdf.onclick = () => els.xdfInput.click();
  els.browseXdf.onclick = () => tnOpenXdfBrowser(ed);
  els.binInput.onchange = () => {
    tnOnBinChosen(ed, els.binInput.files[0]);
    els.binInput.value = '';
  };
  els.xdfInput.onchange = () => {
    tnOnXdfChosen(ed, els.xdfInput.files[0]);
    els.xdfInput.value = '';
  };
  if (els.clear) els.clear.onclick = () => tnClearEverything(ed);

  tnRestoreSession(ed);

  els.save.onclick = () => tnSaveBin(ed);

  // jump-to-offset. Accepts decimal, 0x-hex, bare hex, and relative
  // (+0x100 / -256). The parse lives in the hex view because a relative
  // jump is measured from the cursor, which only it knows about.
  els.goto.onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    const raw = els.goto.value.trim();
    if (!raw) return;
    if (!ed.hex.gotoExpr(raw)) shake(els.goto);
  };

  // restore any state from a previous visit
  if (tuningState.bin) {
    tnShowLoadedImage(ed);
    ed.hex.refresh();
  }
  if (tuningState.def) tnRenderDefs(ed);
  tnUpdateStatus(ed);

  setActions([
    backAction,
    { key: '1', label: 'Load BIN', fn: () => els.loadBin.click() },
    {
      key: '2',
      label: 'Load .xdf',
      fn: () => !els.loadXdf.disabled && els.loadXdf.click(),
    },
    {
      key: '3',
      label: 'Save',
      fn: () => !els.save.disabled && els.save.click(),
    },
  ]);
}
