/**
 * @file MOBILE expert coding: a module list that drills into one module's
 * coding, drawn from the SAME DATEN function list the desktop tree shows so a
 * module matches its desktop view.
 */

/**
 * The module list: tapping one opens {@link expertModuleScreen}.
 * @param {string} chassisId - chassis id.
 * @param {CodeableModule[]} mods - the modules the car answered.
 * @param {HTMLElement} cont - the panel to draw into.
 * @param {() => void} back - the Back action.
 * @param {ScanCache|null} scan - the scan.
 * @param {(() => Promise<void>)|null} reScan - the hub's re-read, when any.
 * @returns {void}
 */
function expertModuleList(chassisId, mods, cont, back, scan, reScan) {
  cont.className = 'coding-panel';
  cont.innerHTML = `<div class="cur-list" id="exp-list"></div>`;
  const list = cont.querySelector('#exp-list');
  mods.forEach((m) => {
    const row = document.createElement('button');
    row.className = 'cur-row exp-row';
    row.type = 'button';
    row.innerHTML =
      `<span class="cur-label">${esc(m.label)}` +
      `<span class="exp-sgbd mono">${esc(m.sgbd)}.prg</span></span>` +
      `<span class="exp-arrow">›</span>`;
    row.onclick = () => expertModuleScreen(chassisId, m, back, scan);
    list.appendChild(row);
  });
  const acts = [];
  if (reScan)
    acts.push({
      key: '1',
      keyLabel: 'F1',
      kind: 'navAction',
      label: 'Re-read',
      fn: reScan,
    });
  acts.push({
    key: 'Escape',
    keyLabel: 'Esc',
    label: 'Back',
    kind: 'back',
    fn: back,
  });
  setActions(acts);
}

/**
 * One module's DATEN functions as selectable value groups. Identical data
 * and rules to an expanded module in the desktop tree.
 * @param {string} chassisId - chassis id.
 * @param {CodeableModule} m - the module.
 * @param {() => void} back - the chassis-level Back action.
 * @param {ScanCache|null} scan - the scan.
 * @returns {Promise<void>} resolves once drawn.
 */
async function expertModuleScreen(chassisId, m, back, scan) {
  const reopen = () => showCodingHub(chassisId, 'expert');
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: dispChassis(chassisId), fn: back },
    { label: 'Coding', fn: reopen },
    { label: m.label },
  ]);
  lastScreen = () => expertModuleScreen(chassisId, m, back, scan);
  view.innerHTML = head('Coding', m.label, `${m.sgbd}.prg`);
  const host = document.createElement('div');
  host.className = 'coding-panel coding-tree-wrap';
  view.appendChild(host);
  host.innerHTML = skeletonList ? skeletonList(6) : '';

  const ci = codingIndexFromScan(scan, m.sgbd);
  const fns = await moduleFunctions(chassisId, m.sgbd, ci);
  const label = (name) =>
    typeof datLabel === 'function' ? datLabel(name) : name;
  /** @type {Map<string, FunctionState>} */
  const state = new Map();
  const read = scan && scan.get(m.sgbd);
  seedState(state, m.sgbd, fns, read);

  // only functions that are a real multiple-choice show as editable groups;
  // the rest (numeric fields, buffers, defaults) render as static reference.
  const rows = fns.filter((f) => (f.values || []).length);
  if (!rows.length) {
    host.innerHTML = errorBlock('No coding functions in this module.');
    return;
  }

  // expanded functions, preserved across the redraw a value tap triggers.
  // Start collapsed: the list opens as a scannable index of function names.
  const openFns = new Set();

  const draw = () => {
    host.innerHTML = '<div class="coding-tree" id="m-tree"></div>';
    const tree = host.querySelector('#m-tree');
    for (const f of rows) {
      const fkey = `${m.sgbd}:${f.name}`;
      const valsHtml = treeValues(f.values || [], label, fkey, state, f);
      const fl = document.createElement('details');
      fl.className = 'tree-fn';
      fl.dataset.fkey = fkey;
      fl.open = openFns.has(fkey);
      fl.ontoggle = () => (fl.open ? openFns.add(fkey) : openFns.delete(fkey));
      fl.innerHTML =
        `<summary class="tree-fn-h">` +
        `<span class="tree-name">${esc(label(f.name))}` +
        `${treeStagedDot(state, fkey)}</span>` +
        `<span class="tree-key mono">blk ${f.block} · byte ${f.byte} · ` +
        `mask 0x${f.mask.toString(16).padStart(2, '0')}</span></summary>` +
        `<div class="tree-vals">${valsHtml}</div>`;
      tree.appendChild(fl);
    }
    updateBar();
  };

  host.addEventListener('click', (e) => treeOptionClick(e, state, draw));

  /** @type {BuiltModule[]} */
  const built = [{ ...m, fns: /** @type {FunctionList} */ (rows) }];
  // No F-key bar on mobile (CSS hides it for .coding-panel); controls live in
  // the nav bar -- Back top-left, and once staged an Apply (Review) top-right.
  const updateBar = () => {
    const n = treeStagedCount(state);
    const acts = [];
    if (n) {
      acts.push({
        key: '2',
        keyLabel: 'F2',
        kind: 'navAction',
        label: `Apply (${n})`,
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
      fn: reopen,
    });
    setActions(acts);
    sbLeft.textContent =
      `${dispChassis(chassisId)} · ${m.label}` + `${n ? ` · ${n} staged` : ''}`;
  };

  draw();
}

// The pieces the other coding screens call; published explicitly so the shared surface is visible.
if (typeof window !== 'undefined') {
  window.expertModuleList = expertModuleList;
  window.expertModuleScreen = expertModuleScreen;
}
