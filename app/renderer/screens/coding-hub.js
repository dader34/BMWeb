// The Coding hub: the one place coding lives, reached from a Coding tile on
// the chassis screen. Two tabs, BimmerCode-style:
//
//   Features  -- the curated owner-facing toggles (showCuratedCoding), shown
//                only where a chassis has a curated map.
//   Expert    -- every codeable module's raw coding, the adopted "Coding map".
//                Desktop: one searchable nested tree (Module > Function >
//                Values, expand in place), BimmerUtility-style. Mobile: a
//                touch-friendly module list that drills into showCoding.
//
// This replaces the scattered old entry points (the Script-selection Coding
// row, the ECU screen's C key / "Coding map" tile). Everything routes here.

// Every module of a chassis whose coding the app can show, with its kind:
// 'values' (SGBD names its coding -- editable read) or 'map' (BMW's DATEN
// description of the blob -- reference). Cached per chassis for the session.
const _codeableCache = new Map();
async function codeableModules(chassisId) {
  const id = String(chassisId || '').toUpperCase();
  if (_codeableCache.has(id)) return _codeableCache.get(id);
  let ch;
  try { ch = await api(`/api/chassis/${id}`); }
  catch { return []; }
  const seen = new Set(); const all = [];
  for (const s of ch.sections || []) {
    for (const e of s.ecus) {
      if (seen.has(e.sgbd)) continue;
      seen.add(e.sgbd);
      all.push({ ...e, section: s.name });
    }
  }
  const kinds = await Promise.all(all.map(async (e) => {
    if (typeof codingFor === 'function' && await codingFor(e.sgbd)) return 'values';
    if (typeof datenFor === 'function' && await datenFor(e.sgbd)) return 'map';
    return null;
  }));
  const out = all.map((e, i) => ({ ...e, kind: kinds[i] })).filter(e => e.kind);
  _codeableCache.set(id, out);
  return out;
}

// Does this chassis have anything to code? Drives the chassis-screen tile.
async function chassisHasCoding(chassisId) {
  return (await codeableModules(chassisId)).length > 0;
}

async function showCodingHub(chassisId, initialTab) {
  const id = String(chassisId || '').toUpperCase();
  lastScreen = () => showCodingHub(chassisId, initialTab);
  const back = () => (typeof backToModules === 'function'
    ? backToModules(chassisId)
    : (typeof showSections === 'function' ? showSections(chassisId) : showChassis()));
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: dispChassis(chassisId), fn: back },
    { label: 'Coding' },
  ]);
  sbLeft.textContent = `${dispChassis(chassisId)} · coding`;

  const curated = typeof hasCurated === 'function' && hasCurated(chassisId);
  let tab = initialTab || (curated ? 'features' : 'expert');

  view.innerHTML = head('Coding', dispChassis(chassisId),
    'Change how the car is configured. Nothing is sent — changes are staged '
    + 'for review.');
  const tabs = document.createElement('div');
  tabs.className = 'coding-tabs';
  tabs.innerHTML =
    (curated ? `<button class="coding-tab" data-tab="features">Features</button>` : '')
    + `<button class="coding-tab" data-tab="expert">Expert</button>`;
  view.appendChild(tabs);
  const panel = document.createElement('div');
  panel.className = 'coding-panel';
  view.appendChild(panel);

  const select = (t) => {
    tab = t;
    tabs.querySelectorAll('.coding-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === t));
    if (t === 'features' && typeof showCuratedCoding === 'function') {
      showCuratedCoding(chassisId, panel, back);
    } else {
      showExpertCoding(chassisId, panel, back);
    }
  };
  tabs.querySelectorAll('.coding-tab').forEach(b =>
    b.onclick = () => select(b.dataset.tab));
  select(tab);
}

// Expert tab. Desktop gets the nested tree; mobile the drill-down list.
async function showExpertCoding(chassisId, cont, back) {
  const mobile = window.matchMedia
    && window.matchMedia('(max-width: 760px)').matches;
  cont.innerHTML = `<div class="empty"><span class="loader"></span>`
    + `<span>Finding codeable modules…</span></div>`;
  const mods = await codeableModules(chassisId);
  if (!mods.length) {
    cont.innerHTML = errorBlock('No codeable modules on this chassis.');
    return;
  }
  if (mobile) expertModuleList(chassisId, mods, cont, back);
  else expertTree(chassisId, mods, cont, back);
}

// MOBILE: a grouped list of modules; tapping one opens its coding screen
// (showCoding handles both the editable read and the DATEN reference).
function expertModuleList(chassisId, mods, cont, back) {
  cont.className = 'coding-panel';
  cont.innerHTML = `<div class="cur-list" id="exp-list"></div>`;
  const list = cont.querySelector('#exp-list');
  mods.forEach((m) => {
    const row = document.createElement('button');
    row.className = 'cur-row exp-row'; row.type = 'button';
    row.innerHTML = `<span class="cur-label">${esc(m.label)}`
      + `<span class="exp-sgbd mono">${esc(m.sgbd)}.prg</span></span>`
      + `<span class="exp-kind">${m.kind}</span>`
      + `<span class="exp-arrow">›</span>`;
    row.onclick = () => {
      const reopen = () => showCodingHub(chassisId, 'expert');
      setCrumbs([
        { label: 'Vehicles', fn: showChassis },
        { label: dispChassis(chassisId), fn: back },
        { label: 'Coding', fn: reopen },
        { label: m.label },
      ]);
      view.innerHTML = head('Coding', m.label, `SGBD ${m.sgbd}.prg`);
      const grid = document.createElement('div');
      view.appendChild(grid);
      showCoding({ sgbd: m.sgbd, code: m.code, label: m.label },
                 grid, reopen, chassisId);
    };
    list.appendChild(row);
  });
  setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
                fn: back }]);
}

// DESKTOP: one searchable nested tree, Module > Function > Values, expand in
// place -- BimmerUtility's layout. The function/value data is BMW's DATEN
// description (datenFor); modules that only name values in the SGBD still
// list under their read job. A filter box narrows across every level.
async function expertTree(chassisId, mods, cont, back) {
  cont.className = 'coding-panel coding-tree-wrap';
  cont.innerHTML = `
    <div class="tree-bar">
      <input class="wiring-search tree-filter" id="tree-filter" type="search"
             placeholder="Filter modules and functions…" autocomplete="off">
    </div>
    <div class="coding-tree" id="coding-tree"></div>`;
  const treeEl = cont.querySelector('#coding-tree');
  const filterEl = cont.querySelector('#tree-filter');

  // pull each module's DATEN functions (first E46 variant, else first) once
  const chId = String(chassisId || '').toUpperCase();
  const built = [];
  for (const m of mods) {
    const daten = typeof datenFor === 'function' ? await datenFor(m.sgbd) : null;
    let fns = [];
    if (daten) {
      const chassis = daten.chassis[chId]
        || daten.chassis[Object.keys(daten.chassis)[0]];
      if (chassis) {
        // union the functions across variants (dedupe by name)
        const byName = new Map();
        for (const variant of Object.values(chassis)) {
          for (const f of variant) if (!byName.has(f.name)) byName.set(f.name, f);
        }
        fns = [...byName.values()];
      }
    }
    built.push({ ...m, fns });
  }

  const label = (name) => (typeof datLabel === 'function'
    ? datLabel(name) : name);

  const draw = () => {
    const q = filterEl.value.trim().toLowerCase();
    treeEl.innerHTML = '';
    for (const m of built) {
      const fns = q
        ? m.fns.filter(f => f.name.toLowerCase().includes(q)
            || label(f.name).toLowerCase().includes(q))
        : m.fns;
      const moduleMatches = !q || m.label.toLowerCase().includes(q)
        || m.sgbd.toLowerCase().includes(q);
      if (!fns.length && !moduleMatches) continue;

      const node = document.createElement('details');
      node.className = 'tree-mod';
      if (q) node.open = true;                    // filtering expands hits
      const shownFns = fns.length ? fns : m.fns;
      node.innerHTML = `<summary class="tree-mod-h">`
        + `<span class="tree-name">${esc(m.label)}</span>`
        + `<span class="tree-meta mono">${esc(m.sgbd)}.prg · `
        + `${shownFns.length} function${shownFns.length === 1 ? '' : 's'}</span>`
        + `</summary>`;
      const body = document.createElement('div');
      body.className = 'tree-fns';
      // cap very large modules for performance; a filter reveals the rest
      const cap = q ? shownFns.length : Math.min(shownFns.length, 400);
      for (let i = 0; i < cap; i++) {
        const f = shownFns[i];
        const vals = (f.values || []);
        const valsHtml = vals.length
          ? vals.map(([n, v]) => `<span class="tree-val">`
              + `<span class="tree-val-n">${esc(label(n))}</span>`
              + `<span class="tree-val-v mono">${esc(v)}</span></span>`).join('')
          : '<span class="ink-faint">—</span>';
        const fl = document.createElement('details');
        fl.className = 'tree-fn';
        fl.innerHTML = `<summary class="tree-fn-h">`
          + `<span class="tree-name">${esc(label(f.name))}</span>`
          + `<span class="tree-key mono">blk ${f.block} · byte ${f.byte} · `
          + `mask 0x${f.mask.toString(16).padStart(2, '0')}</span></summary>`
          + `<div class="tree-vals">${valsHtml}</div>`;
        body.appendChild(fl);
      }
      if (cap < shownFns.length) {
        const more = document.createElement('div');
        more.className = 'tree-more';
        more.textContent = `${shownFns.length - cap} more — filter to narrow`;
        body.appendChild(more);
      }
      node.appendChild(body);
      treeEl.appendChild(node);
    }
    if (!treeEl.children.length) {
      treeEl.innerHTML = `<div class="empty"><div>Nothing matches `
        + `“${esc(filterEl.value)}”.</div></div>`;
    }
  };

  filterEl.oninput = () => {
    const at = filterEl.selectionStart;
    draw();
    const again = cont.querySelector('#tree-filter');
    if (again) { again.focus(); again.setSelectionRange(at, at); }
  };
  draw();
  setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
                fn: back }]);
}

if (typeof window !== 'undefined') {
  window.showCodingHub = showCodingHub;
  window.chassisHasCoding = chassisHasCoding;
  window.codeableModules = codeableModules;
}
