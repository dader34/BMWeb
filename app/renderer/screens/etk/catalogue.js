/**
 * @file The parts catalogue screens above the diagram level: the chassis
 * picker (with the VIN Decoder entry), a chassis's main-group grid with its
 * variant filter, the printable main-group index, and the deep-link entry
 * that opens a main group or diagram straight from a #apps/parts URL.
 */

/* exported ETK_STATE, etkBackAction, showEtk, showEtkChassis, showEtkDeep */

/**
 * The variant filter, remembered across the whole chassis (module-level):
 * which catalogue variant parts are filtered to, or null for all.
 * @typedef {object} EtkFilterState
 * @property {number|null} variant - index into EtkTree.variants, or null = all
 * @property {string|null} variantLabel - the exact variant caption, so a printout names the vehicle it was filtered to
 */

/** @type {EtkFilterState} */
const ETK_STATE = { variant: null, variantLabel: null };

/** How many chassis get a number key on the picker. */
const ETK_FKEY_SLOTS = 9;

/** Stagger step (ms) of the chassis cards. */
const ETK_STAGGER_CARDS = 22;

/** Stagger step (ms) of the main-group grid. */
const ETK_STAGGER_GRID = 16;

/** Rows the variant dropdown renders before asking for a narrower search. */
const ETK_VARIANT_ROW_CAP = 200;

/**
 * The Esc / Back action every catalogue screen carries.
 * @param {() => void} fn - where Back goes
 * @returns {{ key: string, keyLabel: string, label: string, kind: string, fn: () => void }}
 */
function etkBackAction(fn) {
  return { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn };
}

/**
 * The VIN decoder entry: a card (like the Apps hub cards) that opens the
 * decoder page -- enter a VIN there and jump to that exact vehicle's parts.
 * @returns {HTMLButtonElement}
 */
function etkVinEntryCard() {
  const vinCard = document.createElement('button');
  vinCard.className = 'lookup-entry etk-vin-entry';
  vinCard.innerHTML = `
    <span class="lookup-entry-icon">⌗</span>
    <span class="lookup-entry-text">
      <span class="lookup-entry-title">VIN Decoder</span>
      <span class="lookup-entry-desc">Enter a VIN to jump straight to your exact vehicle</span>
    </span>
    <span class="lookup-entry-arrow">→</span>`;
  vinCard.onclick = () => showVinDecoder();
  return vinCard;
}

/**
 * The empty state when no chassis has a parts archive in this build.
 * @returns {HTMLDivElement}
 */
function etkNoDataNote() {
  const note = document.createElement('div');
  note.className = 'empty wiring-absent';
  note.innerHTML = `
      <div class="empty-big">No parts data in this build</div>
      <div>The catalogue comes from BMW's ETK, a separate import not part of this repository.</div>
      <div style="font-size:12px;color:var(--ink-faint)">Offline, it is in the
           <em>offline-complete</em> build linked from each release; from source,
           <code>tools/etk_import.py --db etk.sqlite --out data/etk</code>.</div>`;
  return note;
}

/**
 * One chassis card on the picker grid.
 * @param {string} id - chassis code
 * @returns {HTMLButtonElement}
 */
function etkChassisCard(id) {
  const tag = (typeof CHASSIS_TAG === 'object' && CHASSIS_TAG[id]) || 'BMW';
  const card = document.createElement('button');
  card.className = 'chassis-card';
  card.innerHTML = `
      <div class="chassis-code">${esc(dispChassis(id))}</div>
      <div class="chassis-tag">${esc(tag)}</div>
      <div class="chassis-arrow">→</div>`;
  card.onclick = () => showEtkChassis(id);
  return card;
}

/**
 * The parts catalogue landing: pick a vehicle to browse its catalogue.
 * @returns {Promise<void>}
 */
async function showEtk() {
  lastScreen = showEtk;
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: 'Apps', fn: showApps },
    { label: 'Parts Catalogue' },
  ]);
  document.body.classList.add('apps-section');
  sbLeft.textContent = 'parts';
  view.innerHTML = head(
    'ETK',
    'Parts Catalogue',
    "BMW's own parts diagrams. Pick a vehicle to browse its catalogue."
  );
  setActions([etkBackAction(showApps)]);

  view.appendChild(etkVinEntryCard());

  const grid = document.createElement('div');
  grid.className = 'chassis-grid stagger';
  const wait = document.createElement('div');
  wait.className = 'wiring-loading';
  wait.innerHTML = `<span class="wiring-spinner"></span><span>Looking for vehicles with parts data…</span>`;
  view.appendChild(wait);
  view.appendChild(grid);

  const ids = await etkChassisList();
  wait.remove();
  if (!ids.length) {
    view.appendChild(etkNoDataNote());
    return;
  }
  ids.forEach((id) => grid.appendChild(etkChassisCard(id)));
  stagger(grid, ETK_STAGGER_CARDS);
  sbRight.textContent = `${ids.length} chassis`;
  setActions([
    ...ids.slice(0, ETK_FKEY_SLOTS).map((id, i) => ({
      key: String(i + 1),
      label: dispChassis(id),
      fn: () => showEtkChassis(id),
    })),
    etkBackAction(showApps),
  ]);
}

/**
 * A download progress block for a chassis archive: the bundle streams from
 * the hosted dataset (~20 MB) -- a real wait, so show a bar instead of a
 * blank pane while it loads.
 * @param {string} id - chassis code
 * @returns {{ el: HTMLDivElement, onProgress: EtkProgressFn }}
 */
function etkProgressBlock(id) {
  const el = document.createElement('div');
  el.className = 'etk-loading';
  el.innerHTML = `
    <span class="wiring-spinner"></span>
    <div class="etk-progress-wrap">
      <div class="etk-progress-label">Loading ${esc(dispChassis(id))} parts catalogue…</div>
      <div class="etk-progress-track"><div class="etk-progress-bar" id="etk-progress"></div></div>
    </div>`;
  const bar = el.querySelector('#etk-progress');
  const onProgress = (loaded, total) => {
    if (total > 0) {
      const pct = Math.min(100, Math.round((loaded / total) * 100));
      bar.style.width = pct + '%';
      el.querySelector('.etk-progress-label').textContent =
        `Loading ${dispChassis(id)} parts catalogue… ${pct}%`;
    } else {
      bar.classList.add('etk-progress-indeterminate'); // no length -> animate
    }
  };
  return { el, onProgress };
}

/**
 * The chassis landing: ETK's "Search by Main Group" -- an icon grid of the
 * main groups, plus a variant selector so parts can be filtered to one exact
 * vehicle. Entering a chassis resets the variant filter.
 * @param {string} chassisId - chassis code, any case
 * @param {{variant: number, label: string}|{hit: EtkVinHit}|null} [preselect] - a variant to open filtered to (its index and label), or the resolved vehicle to match one from once the archive is in
 * @returns {Promise<void>}
 */
async function showEtkChassis(chassisId, preselect) {
  const id = chassisId.toUpperCase();
  lastScreen = () => showEtkChassis(id, preselect);
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: 'Apps', fn: showApps },
    { label: 'Parts', fn: showEtk },
    { label: dispChassis(id) },
  ]);
  sbLeft.textContent = 'loading parts…';
  view.innerHTML = head(
    'ETK',
    dispChassis(id),
    'Pick a variant to filter, then a main group.'
  );
  document.body.classList.remove('wds-nofkeys');
  document.body.classList.add('apps-section');

  const loading = etkProgressBlock(id);
  view.appendChild(loading.el);

  let data;
  try {
    data = await loadEtk(id, loading.onProgress);
  } catch (e) {
    loading.el.remove();
    view.appendChild(errorBlock(String(e.message || e)));
    return;
  }
  loading.el.remove();
  // entering a chassis clears the filter, unless the caller (a decoded VIN,
  // a garage car) brought the vehicle it is: that is matched to a variant
  // here, after the archive is in, so the progress block above covers the
  // download instead of the previous screen sitting still
  let pre = preselect || null;
  if (pre && pre.hit) {
    const vs = data.tree.variants || [];
    const m =
      typeof etkMatchVariant === 'function' ? etkMatchVariant(vs, pre.hit) : -1;
    pre = m >= 0 ? { variant: m, label: etkVariantLabel(vs[m]) } : null;
  }
  ETK_STATE.variant = pre ? pre.variant : null;
  ETK_STATE.variantLabel = pre ? pre.label : null;

  // --- variant selector (custom searchable dropdown) ---
  const vbar = document.createElement('div');
  vbar.className = 'etk-variant-bar';
  const label = document.createElement('span');
  label.className = 'etk-variant-label';
  label.textContent = 'Vehicle:';
  vbar.appendChild(label);
  vbar.appendChild(buildVariantDropdown(data.tree.variants || []));
  view.appendChild(vbar);

  // --- main-group icon grid ---
  const grid = document.createElement('div');
  grid.className = 'etk-grid stagger';
  view.appendChild(grid);

  (data.tree.maingroups || []).forEach((mg) => {
    const card = document.createElement('button');
    card.className = 'etk-gcard';
    const iconUrl = etkImageUrl(data, mg.icon);
    card.innerHTML = `
      <span class="etk-gnum">${esc(mg.hg)}</span>
      <span class="etk-gicon">${iconUrl ? `<img src="${iconUrl}" alt="">` : ''}</span>
      <span class="etk-gname">${esc(mg.name)}</span>`;
    card.onclick = () => showEtkGroup(data, id, mg);
    grid.appendChild(card);
  });
  stagger(grid, ETK_STAGGER_GRID);

  sbLeft.textContent = `${(data.tree.maingroups || []).length} main groups`;
  sbRight.textContent = `${(data.tree.variants || []).length} variants`;
  // Print here isn't the icon grid (a navigation menu) -- it's a clean catalogue
  // index: the vehicle and its list of main groups.
  setActions([
    etkBackAction(showEtk),
    {
      key: 'p',
      keyLabel: 'P',
      label: 'Print',
      fn: () => printEtkIndex(data, id),
    },
  ]);
}

/**
 * The main-group index for a vehicle as a clean printout (not the icon grid).
 * @param {EtkBundle} data - the loaded archive
 * @param {string} chassisId - chassis code
 * @returns {void}
 */
function printEtkIndex(data, chassisId) {
  const mgs = data.tree.maingroups || [];
  const rows = mgs.map((mg) => [mg.hg, mg.name]);
  printDoc({
    title: `${dispChassis(chassisId)} · parts catalogue`,
    subtitle: ETK_STATE.variantLabel || '',
    meta: [
      ['Main groups', String(mgs.length)],
      ['Variants', String((data.tree.variants || []).length)],
    ],
    sections: [printTable(['Group', 'Name'], rows, ['pr-mono', ''])],
    footer: `${APP_NAME} · BMW ETK · printed ${new Date().toLocaleDateString()}`,
  });
}

/**
 * A custom searchable dropdown for the ~300 variants -- the native <select>
 * is unstyleable and unsearchable. Options: "All variants" plus one per
 * variant, sorted by model+date, filterable by a search box. Selection writes
 * ETK_STATE (there is no callback consumer) and lights the button amber.
 * @param {EtkVariant[]} variants - the chassis's variants
 * @returns {HTMLElement} the dropdown root
 */
function buildVariantDropdown(variants) {
  // The variant rows, sorted by model then date. Each item keeps its ORIGINAL
  // index (i) -- that index is the value ETK_STATE.variant holds.
  const order = variants
    .map((v, i) => ({ i, v, text: etkVariantLabel(v) }))
    .sort(
      (a, b) =>
        (a.v.model || '').localeCompare(b.v.model || '') ||
        String(a.v.date).localeCompare(String(b.v.date))
    );
  const allLabel = `All variants (${variants.length})`;

  // The shared dropdown (ui/dropdown.js) in the fault lookup's `.lkd` skin,
  // so this picker reads like the chassis and module filters there; the
  // behaviour is this control's own: no drop-up, no Esc, click-to-close,
  // immediate focus, a row cap and a synthetic "All" row.
  const dd = makeDropdown({
    items: order,
    value: ETK_STATE.variant != null ? ETK_STATE.variant : null,
    classPrefix: 'lkd',
    parts: { cur: 'val', menu: 'pop', opt: 'item' },
    searchType: 'search',
    searchPlaceholder: 'Search 316i, LHD, N42, 2003…',
    itemValue: (o) => o.i,
    itemLabel: (o) => o.text,
    filterItem: (o, q) => o.text.toLowerCase().includes(q),
    renderRow: (o) => `<span class="lkd-item-label">${esc(o.text)}</span>`,
    emptyText: 'No matches',
    synthetic: { value: null, label: allLabel },
    placeholder: allLabel,
    rowCap: ETK_VARIANT_ROW_CAP,
    flip: false,
    escClose: false,
    closeOn: 'click',
    focusDelay: null, // focus immediately, as before
    activeClass: 'etk-vdd-filtered',
    onChange: (idx, item) => {
      ETK_STATE.variant = idx;
      // the exact variant string, so a printed diagram names the vehicle it was
      // filtered to; null = all variants
      ETK_STATE.variantLabel = idx != null && item ? item.text : null;
    },
  });
  dd.el.classList.add('etk-vdd');
  return dd.el;
}

/**
 * Deep-link entry: open a chassis's main group (and optionally a specific
 * diagram) directly from a URL like #apps/parts/E46/11 or
 * #apps/parts/E46/11/11_0100. Renders the chassis screen first so a slow
 * load still shows something and Back has somewhere to go, then swaps to the
 * group once data is in hand. Falls back to the chassis grid.
 * @param {string} chassisId - chassis code, any case
 * @param {string} [hg] - main-group number
 * @param {string} [btnr] - diagram number within that main group
 * @returns {Promise<void>}
 */
async function showEtkDeep(chassisId, hg, btnr) {
  const id = String(chassisId || '').toUpperCase();
  if (!hg) {
    return showEtkChassis(id);
  }
  await showEtkChassis(id);
  try {
    const data = await loadEtk(id);
    const mg = (data.tree.maingroups || []).find(
      (m) => String(m.hg) === String(hg)
    );
    if (mg) showEtkGroup(data, id, mg, btnr || null);
  } catch (e) {
    /* the chassis grid is already up */
  }
}
