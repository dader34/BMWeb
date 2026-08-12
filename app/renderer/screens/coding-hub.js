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

  // Read the whole car up front -- one scan across every codeable module --
  // and both tabs work off the result, so their toggles start at the car's
  // current values without per-module Read buttons. Without a cable this is a
  // demo scan (webDemoCoding fills plausible values).
  const scanHost = document.createElement('div');
  view.appendChild(scanHost);
  const scan = await scanCoding(chassisId, scanHost);
  scanHost.remove();

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
      showCuratedCoding(chassisId, panel, back, scan);
    } else {
      showExpertCoding(chassisId, panel, back, scan);
    }
  };
  tabs.querySelectorAll('.coding-tab').forEach(b =>
    b.onclick = () => select(b.dataset.tab));
  select(tab);
}

// Scan the car's coding: read every codeable module's coding job once and
// return a cache { sgbd -> Map(resultName -> value) }. Shown with progress.
// Demo mode fills each read with plausible values (webDemoCoding), so the
// whole car "reads" without a cable. A module that fails to read is simply
// absent from the cache -- its toggles then show unknown.
async function scanCoding(chassisId, host) {
  const mods = await codeableModules(chassisId);
  const cache = new Map();
  const total = mods.length;
  const paint = (done, name) => {
    host.innerHTML = `<div class="coding-scan">`
      + `<div class="coding-scan-title">Reading the car…</div>`
      + `<div class="coding-scan-bar"><span style="width:`
      + `${Math.round(100 * done / Math.max(1, total))}%"></span></div>`
      + `<div class="coding-scan-mod mono">${esc(name || '')}`
      + ` · ${done}/${total} modules</div></div>`;
  };
  paint(0, '');
  for (let i = 0; i < mods.length; i++) {
    const m = mods[i];
    paint(i, m.label);
    const entry = typeof codingFor === 'function'
      ? await codingFor(m.sgbd) : null;
    if (entry && entry.read) {
      try {
        const d = await api(`/api/ecu/${m.sgbd}/run/${entry.read}`,
                            { method: 'POST' });
        cache.set(m.sgbd, new Map(flatResults(d.sets)));
      } catch { /* unreadable: leave absent */ }
    }
  }
  paint(total, '');
  return cache;
}

// Expert tab. Desktop gets the nested tree; mobile the drill-down list.
async function showExpertCoding(chassisId, cont, back, scan) {
  const mobile = window.matchMedia
    && window.matchMedia('(max-width: 760px)').matches;
  const mods = await codeableModules(chassisId);
  if (!mods.length) {
    cont.innerHTML = errorBlock('No codeable modules on this chassis.');
    return;
  }
  if (mobile) expertModuleList(chassisId, mods, cont, back);
  else expertTree(chassisId, mods, cont, back, scan);
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

// A value NAME that is a bare number (or wert_NN) is not a real setting name
// -- it is a numeric field's raw byte from another variant, not an enum label.
function treeIsNumericName(n) {
  return typeof n === 'number'
    || /^-?\d+$/.test(String(n)) || /^wert_\d+$/i.test(String(n));
}

// The pickable named options of a function: [[name, hexValue], ...] with real
// setting names (aktiv/nicht_aktiv/automatik...), excluding numeric fields and
// buffers. Empty when the function is not a simple multiple-choice.
function treeOptions(vals) {
  if (!vals.length) return [];
  if (vals.some(([, v]) => typeof v === 'string' && v.length > 4)) return [];
  if (vals.some(([n]) => treeIsNumericName(n))) return [];
  // dedupe by hex value; need at least two to be a choice
  const seen = new Set(); const out = [];
  for (const [n, v] of vals) {
    const key = String(v).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key); out.push([n, String(v)]);
  }
  return out.length >= 2 ? out : [];
}

// Pair a DATEN function to its value in a module's coding read. The read names
// results differently (COD_* / STAT_*), so match on shared tokens, then reduce
// the answer to one of the function's known option hex values. Returns the
// matched hex value string, or null.
function treeMatchRead(kw, opts, read) {
  const toks = (s) => new Set(String(s)
    .replace(/^(COD|STAT|STATUS|CODIER)_/i, '').toUpperCase()
    .split('_').filter(t => t.length > 2));
  const kt = toks(kw);
  let best = null, bestOverlap = 0;
  for (const [name, val] of read) {
    const nt = toks(name);
    const ov = [...kt].filter(t => nt.has(t)).length;
    if (ov > bestOverlap && ov >= Math.min(2, kt.size)) { bestOverlap = ov; best = val; }
  }
  if (best == null) return null;
  const s = String(best).trim().toLowerCase();
  // numeric answer -> hex; boolean word -> 0/1
  let num = null;
  if (/^-?\d+$/.test(s)) num = parseInt(s, 10);
  else if (typeof codIsOn === 'function' && typeof codKnown === 'function'
           && codKnown(s)) num = codIsOn(s) ? 1 : 0;
  if (num == null) return null;
  const hex = num.toString(16).padStart(2, '0');
  // only accept if it is actually one of this function's options
  return opts.some(([, v]) => String(v).toLowerCase() === hex) ? hex : null;
}

// Render a function's value list the way DATEN actually means it. When the
// function is a real multiple-choice AND a value has been read (state has a
// current), the options render as SELECTABLE chips (the friendly tier over the
// tree): the current one is marked, and picking another stages it. Otherwise
// it is the static reference: numeric field, default, or buffer.
function treeValues(vals, label, fkey, state) {
  if (!vals.length) return '<span class="ink-faint">—</span>';
  const opts = treeOptions(vals);
  if (opts.length && state && state.has(fkey)) {
    const s = state.get(fkey);                 // {current, staged}
    const sel = s.staged != null ? s.staged : s.current;
    return `<div class="tree-opts" data-fkey="${esc(fkey)}">`
      + opts.map(([n, v]) => {
        const on = String(v).toLowerCase() === String(sel).toLowerCase();
        const isCur = String(v).toLowerCase() === String(s.current).toLowerCase();
        return `<button class="tree-opt${on ? ' sel' : ''}" `
          + `data-v="${esc(v)}" type="button">`
          + `<span class="tree-opt-n">${esc(label(n))}</span>`
          + `<span class="tree-opt-v mono">0x${esc(v)}</span>`
          + `${isCur ? '<span class="tree-opt-cur">current</span>' : ''}`
          + `</button>`;
      }).join('') + `</div>`;
  }
  // ---- static reference (numeric / default / buffer / unread) ----
  const long = vals.filter(([, v]) => typeof v === 'string' && v.length > 4);
  if (long.length === vals.length && vals.length > 1) {
    const bytes = String(vals[0][1]).length / 2;
    return `<span class="tree-val" title="${esc(
      vals.map(([n, v]) => `${n}: ${v}`).join('\n'))}">`
      + `<span class="tree-val-n">${vals.length} variants</span>`
      + `<span class="tree-val-v mono">${bytes} bytes each</span></span>`;
  }
  if (vals.every(([n]) => treeIsNumericName(n))) {
    const uniq = [...new Set(vals.map(([, v]) => String(v)))];
    const tag = vals.length === 1 ? 'default' : 'value';
    return `<span class="tree-val"><span class="tree-val-n">${tag}</span>`
      + uniq.map(v => `<span class="tree-val-v mono">0x${esc(v)}</span>`).join('')
      + `</span>`;
  }
  return vals.map(([n, v]) => {
    const big = typeof v === 'string' && v.length > 4;
    return `<span class="tree-val"${big ? ` title="${esc(v)}"` : ''}>`
      + `<span class="tree-val-n">${esc(label(n))}</span>`
      + `<span class="tree-val-v mono">`
      + `${big ? `${String(v).length / 2} bytes` : '0x' + esc(v)}</span></span>`;
  }).join('');
}

// DESKTOP: one searchable nested tree, Module > Function > Values, expand in
// place -- BimmerUtility's layout. The function/value data is BMW's DATEN
// description (datenFor); modules that only name values in the SGBD still
// list under their read job. A filter box narrows across every level.
async function expertTree(chassisId, mods, cont, back, scan) {
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

  // Per-function state: fkey "sgbd:name" -> {current, staged}. The current
  // value comes from the up-front scan (the module's coding read, demo-filled
  // without a cable). Every choosable function is pre-populated, so the tree
  // shows the car's current setting from the first frame -- no Read buttons.
  const state = new Map();
  const fkeyOf = (sgbd, name) => `${sgbd}:${name}`;
  for (const m of mods) {
    const read = scan && scan.get(m.sgbd);
    const fns = (built.find(b => b.sgbd === m.sgbd) || {}).fns || [];
    for (const f of fns) {
      const opts = treeOptions(f.values || []);
      if (!opts.length) continue;
      const fkey = fkeyOf(m.sgbd, f.name);
      let cur = read ? treeMatchRead(f.name, opts, read) : null;
      if (cur == null) {
        // no cable / unmatched: a deterministic pick so there is still a
        // current to select against (stable per load)
        let h = 0;
        for (const c of f.name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
        cur = opts[h % opts.length][1];
      }
      state.set(fkey, { current: cur, staged: null });
    }
  }

  // which modules/functions are expanded, preserved across redraws
  const openMods = new Set();
  const openFns = new Set();
  const stagedCount = () =>
    [...state.values()].filter(s => s.staged != null).length;

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
      node.dataset.sgbd = m.sgbd;
      // keep whatever was open across a redraw; a filter also expands hits
      if (q || openMods.has(m.sgbd)) node.open = true;
      node.ontoggle = () => node.open ? openMods.add(m.sgbd) : openMods.delete(m.sgbd);
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
        const fkey = fkeyOf(m.sgbd, f.name);
        const valsHtml = treeValues(f.values || [], label, fkey, state);
        const fl = document.createElement('details');
        fl.className = 'tree-fn';
        fl.dataset.fkey = fkey;
        if (openFns.has(fkey)) fl.open = true;
        fl.ontoggle = () => fl.open ? openFns.add(fkey) : openFns.delete(fkey);
        fl.innerHTML = `<summary class="tree-fn-h">`
          + `<span class="tree-name">${esc(label(f.name))}`
          + `${state.has(fkey) && state.get(fkey).staged != null
              ? '<span class="tree-staged-dot"></span>' : ''}</span>`
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
    updateBar();
  };

  // pick a value option: stage it (values were read up front by the scan)
  treeEl.addEventListener('click', (e) => {
    const opt = e.target.closest('.tree-opt');
    if (opt) {
      const wrap = opt.closest('.tree-opts');
      const fkey = wrap && wrap.dataset.fkey;
      const s = fkey && state.get(fkey);
      if (!s) return;
      const v = opt.dataset.v;
      s.staged = (String(v).toLowerCase()
        === String(s.current).toLowerCase()) ? null : v;
      draw();
    }
  });

  filterEl.oninput = () => {
    const at = filterEl.selectionStart;
    draw();
    const again = cont.querySelector('#tree-filter');
    if (again) { again.focus(); again.setSelectionRange(at, at); }
  };

  // the softkey bar reflects the staged count: Review / Discard appear once
  // something is changed, the same shape the coding editor keeps.
  const updateBar = () => {
    const n = stagedCount();
    const acts = [];
    if (n) {
      acts.push({ key: '2', keyLabel: 'F2', label: `Review (${n})`,
        fn: () => treeReview(built, state, label) });
      acts.push({ key: '3', keyLabel: 'F3', label: 'Discard',
        fn: () => { for (const s of state.values()) s.staged = null; draw(); } });
    }
    acts.push({ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
                fn: back });
    setActions(acts);
    sbLeft.textContent = `${dispChassis(chassisId)} · coding`
      + `${n ? ` · ${n} staged` : ''}`;
  };

  draw();
}

// The staged-changes review for the Expert tree, sharing the curated review's
// readable row + demo-aware footer.
function treeReview(built, state, label) {
  const rows = [];
  for (const m of built) {
    for (const f of m.fns) {
      const s = state.get(`${m.sgbd}:${f.name}`);
      if (!s || s.staged == null) continue;
      rows.push(codingReviewRow(label(f.name), `${m.sgbd}.prg · ${f.name}`,
        `0x${s.current}`, `0x${s.staged}`));
    }
  }
  confirmDialog(codingReviewDialog('Staged coding changes', rows));
}

if (typeof window !== 'undefined') {
  window.showCodingHub = showCodingHub;
  window.chassisHasCoding = chassisHasCoding;
  window.codeableModules = codeableModules;
}
