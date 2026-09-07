/**
 * @file DESKTOP expert coding: one searchable nested tree, Module > Function
 * > Values, expanded in place. Data is BMW's DATEN description (datenFor)
 * fused with the scan's current values; a filter narrows across every level.
 */

/**
 * A module with its resolved function list, as the tree and the write path
 * carry it.
 * @typedef {CodeableModule & {fns: FunctionList, chassisId?: string}} BuiltModule
 */

/** Most functions drawn per module before "filter to narrow". */
const TREE_MODULE_CAP = 400;

/**
 * Draw the expert tree.
 * @param {string} chassisId - chassis id.
 * @param {CodeableModule[]} mods - the modules the car answered.
 * @param {HTMLElement} cont - the panel to draw into.
 * @param {() => void} back - the Back action.
 * @param {ScanCache|null} scan - the scan.
 * @param {(() => Promise<void>)|null} reScan - the hub's re-read, when any.
 * @param {boolean} [showAll] - skip the equipment-code module filter.
 * @returns {Promise<void>} resolves once drawn.
 */
async function expertTree(chassisId, mods, cont, back, scan, reScan, showAll) {
  cont.className = 'coding-panel coding-tree-wrap';
  cont.innerHTML = `
    <div class="tree-bar">
      <input class="wiring-search tree-filter" id="tree-filter" type="search"
             placeholder="Filter modules and functions…" autocomplete="off">
    </div>
    <div class="coding-tree" id="coding-tree"></div>`;
  const treeEl = cont.querySelector('#coding-tree');
  const filterEl = cont.querySelector('#tree-filter');

  // Extract SA codes from ZCS for FA/ZCS filtering
  const saCodes = extractSaCodesFromScan(scan);
  // ...and drop modules this car's equipment codes say it does not carry.
  const shown = showAll
    ? mods
    : await filterModulesByFa(chassisId, mods, saCodes);
  const hidden = mods.length - shown.length;

  // pull each module's DATEN functions (chassis variant union) once; skip
  // modules with no functions -- a 0-function row is a dead expand.
  /** @type {BuiltModule[]} */
  const built = [];
  for (const m of shown) {
    const fns = await moduleFunctions(
      chassisId,
      m.sgbd,
      codingIndexFromScan(scan, m.sgbd),
      saCodes
    );
    if (fns.length) built.push({ ...m, fns, chassisId });
  }

  // Never filter silently: say what the car's equipment codes hid, and offer
  // the way back. A module missing with no explanation reads as a bug.
  if (hidden > 0) {
    const note = document.createElement('div');
    note.className = 'cod-fa-note';
    note.innerHTML =
      `${hidden} module${hidden === 1 ? '' : 's'} hidden — ` +
      `this car's equipment codes say it doesn't have ` +
      `${hidden === 1 ? 'it' : 'them'}. ` +
      `<button class="linklike" id="fa-show-all">Show all</button>`;
    cont.querySelector('.tree-bar').insertAdjacentElement('afterend', note);
    note.querySelector('#fa-show-all').onclick = () =>
      expertTree(chassisId, mods, cont, back, scan, reScan, true);
  }

  const label = (name) =>
    typeof datLabel === 'function' ? datLabel(name) : name;

  // Per-function state: fkey "sgbd:name" -> {current, staged}, seeded from the
  // scan (seedState), so a function shows the same current + options everywhere.
  /** @type {Map<string, FunctionState>} */
  const state = new Map();
  const fkeyOf = (sgbd, name) => `${sgbd}:${name}`;
  for (const m of built) {
    seedState(state, m.sgbd, m.fns, scan && scan.get(m.sgbd));
  }

  // which modules/functions are expanded, preserved across redraws
  const openMods = new Set();
  const openFns = new Set();

  /**
   * One module's expandable node with its function list.
   * @param {BuiltModule} m - the module.
   * @param {DatenField[]} shownFns - the functions to list.
   * @param {string} q - the active filter, lowercased.
   * @returns {HTMLElement} the node.
   */
  const moduleNode = (m, shownFns, q) => {
    const node = document.createElement('details');
    node.className = 'tree-mod';
    node.dataset.sgbd = m.sgbd;
    // keep whatever was open across a redraw; a filter also expands hits
    if (q || openMods.has(m.sgbd)) node.open = true;
    node.ontoggle = () =>
      node.open ? openMods.add(m.sgbd) : openMods.delete(m.sgbd);
    node.innerHTML =
      `<summary class="tree-mod-h">` +
      `<span class="tree-name">${esc(m.label)}</span>` +
      `<span class="tree-meta mono">${esc(m.sgbd)}.prg · ` +
      `${shownFns.length} function${shownFns.length === 1 ? '' : 's'}</span>` +
      `</summary>`;
    const body = document.createElement('div');
    body.className = 'tree-fns';
    // cap very large modules for performance; a filter reveals the rest
    const cap = q
      ? shownFns.length
      : Math.min(shownFns.length, TREE_MODULE_CAP);
    let lastBlock = null; // emit a group header when the block changes
    for (let i = 0; i < cap; i++) {
      const f = shownFns[i];
      // BMW names each coding block ("Grundkonfiguration_ALC-SG"). Heading
      // the run of fields with it turns a flat list of 83 into the labelled
      // sections NCS-Expert shows. Fields arrive grouped by address, so a
      // simple change-detect is enough -- no re-sorting, which would break
      // the address order the rest of the screen relies on.
      if (f.block !== lastBlock) {
        lastBlock = f.block;
        const bn = blockName(m.sgbd, f.block);
        if (bn) {
          const h = document.createElement('div');
          h.className = 'tree-blk-h';
          h.innerHTML =
            `<span class="tree-blk-key mono">CODING</span>` +
            `<span class="tree-blk-name">${esc(bn.name)}</span>` +
            (bn.en ? `<span class="tree-blk-en">${esc(bn.en)}</span>` : '');
          body.appendChild(h);
        }
      }
      const fkey = fkeyOf(m.sgbd, f.name);
      const valsHtml = treeValues(f.values || [], label, fkey, state, f);
      const fl = document.createElement('details');
      fl.className = 'tree-fn';
      fl.dataset.fkey = fkey;
      if (openFns.has(fkey)) fl.open = true;
      fl.ontoggle = () => (fl.open ? openFns.add(fkey) : openFns.delete(fkey));
      fl.innerHTML =
        `<summary class="tree-fn-h">` +
        `<span class="tree-name">${esc(label(f.name))}` +
        `${treeStagedDot(state, fkey)}</span>` +
        `<span class="tree-key mono">len ${f.byte} · ` +
        `mask 0x${f.mask.toString(16).padStart(2, '0')}</span></summary>` +
        `<div class="tree-vals">${valsHtml}</div>`;
      body.appendChild(fl);
    }
    if (cap < shownFns.length) {
      const more = document.createElement('div');
      more.className = 'tree-more';
      more.textContent = `${shownFns.length - cap} more — filter to narrow`;
      body.appendChild(more);
    }
    node.appendChild(body);
    return node;
  };

  const draw = () => {
    const q = filterEl.value.trim().toLowerCase();
    treeEl.innerHTML = '';
    for (const m of built) {
      const fns = q
        ? m.fns.filter(
            (f) =>
              f.name.toLowerCase().includes(q) ||
              label(f.name).toLowerCase().includes(q)
          )
        : m.fns;
      const moduleMatches =
        !q ||
        m.label.toLowerCase().includes(q) ||
        m.sgbd.toLowerCase().includes(q);
      if (!fns.length && !moduleMatches) continue;
      const shownFns = fns.length ? fns : m.fns;
      treeEl.appendChild(moduleNode(m, shownFns, q));
    }
    if (!treeEl.children.length) {
      treeEl.innerHTML =
        `<div class="empty"><div>Nothing matches ` +
        `“${esc(filterEl.value)}”.</div></div>`;
    }
    updateBar();
  };

  // pick a value option: stage it (values were read up front by the scan)
  treeEl.addEventListener('click', (e) => treeOptionClick(e, state, draw));

  filterEl.oninput = () => {
    const at = filterEl.selectionStart;
    draw();
    const again = cont.querySelector('#tree-filter');
    if (again) {
      again.focus();
      again.setSelectionRange(at, at);
    }
  };

  // the softkey bar reflects the staged count: Review / Discard appear once
  // something is changed, the same shape the coding editor keeps.
  const updateBar = () => {
    const n = treeStagedCount(state);
    const acts = [];
    if (reScan)
      acts.push({
        key: '1',
        keyLabel: 'F1',
        kind: 'navAction',
        label: 'Re-read',
        fn: reScan,
      });
    if (n) {
      acts.push({
        key: '2',
        keyLabel: 'F2',
        label: `Review (${n})`,
        fn: () => treeReview(built, state, label),
      });
      acts.push({
        key: '3',
        keyLabel: 'F3',
        label: 'Discard',
        fn: () => {
          for (const s of state.values()) s.staged = null;
          draw();
        },
      });
    }
    acts.push({
      key: 'Escape',
      keyLabel: 'Esc',
      label: 'Back',
      kind: 'back',
      fn: back,
    });
    setActions(acts);
    sbLeft.textContent =
      `${dispChassis(chassisId)} · coding` + `${n ? ` · ${n} staged` : ''}`;
  };

  draw();
}

// The pieces the other coding screens call; published explicitly so the shared surface is visible.
if (typeof window !== 'undefined') {
  window.expertTree = expertTree;
}
