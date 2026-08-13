// ETK parts catalogue, from BMW's own data. tools/etk_import.py packs one .etk
// archive per car: tree.json (assembly groups -> diagrams -> parts) plus the
// exploded-view images (jpg/png). Same archive shape and loading path as the
// .wiring bundles -- fflate inflates, and the offline export inlines base64.

const ETK_CACHE = new Map();       // chassis -> { tree, files: Map(name -> u8) }
let etkChassisIds = null;          // memoised probe of which cars have data

// The .etk bundles are 6.4 GB across 246 cars -- too big to ship in the Pages
// repo. They live in a Hugging Face dataset and stream in at runtime (HF's
// resolve URLs reflect the request Origin, so cross-origin fetch from
// bmweb.danner.ink is CORS-clean -- verified). Local data/etk/ wins when
// present (dev + the offline single-file export), else fall back to HF.
const ETK_HF_BASE =
  'https://huggingface.co/datasets/CraigFf/bmweb-etk/resolve/main/';

function etkBundleUrl(id, local) {
  if (local) {
    const base = (typeof WEB_BASE === 'string') ? WEB_BASE : '';
    return `${base}/data/etk/${id}.etk`;
  }
  return `${ETK_HF_BASE}${id}.etk`;
}

// onProgress(loaded, total) is called as the bundle downloads; total is 0 when
// the server sends no Content-Length (then the caller shows an indeterminate bar).
async function loadEtk(chassisId, onProgress) {
  const id = chassisId.toUpperCase();
  if (ETK_CACHE.has(id)) return ETK_CACHE.get(id);
  let bytes;
  const inline = (typeof BMACW_ETK === 'object' && BMACW_ETK) ? BMACW_ETK[id] : null;
  if (inline) {
    const bin = atob(inline);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    const real = (typeof webRealFetch === 'function') ? webRealFetch : window.fetch.bind(window);
    // try local first, then HF
    let r = await real(etkBundleUrl(id, true)).catch(() => null);
    if (!r || !r.ok) r = await real(etkBundleUrl(id, false)).catch(() => null);
    if (!r || !r.ok) throw new Error(`no parts data for ${dispChassis(id)}`);
    bytes = await readWithProgress(r, onProgress);
  }
  const unzipped = fflate.unzipSync(bytes);
  const tree = JSON.parse(new TextDecoder().decode(unzipped['tree.json']));
  const files = new Map(Object.entries(unzipped));
  const data = { tree, files };
  ETK_CACHE.set(id, data);
  return data;
}

// Stream a fetch Response into a Uint8Array, calling onProgress(loaded,total).
// Falls back to arrayBuffer() when the body isn't a readable stream.
async function readWithProgress(resp, onProgress) {
  const total = Number(resp.headers.get('content-length')) || 0;
  if (!resp.body || !resp.body.getReader || !onProgress) {
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (onProgress) onProgress(buf.length, buf.length);
    return buf;
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// Does this chassis have an .etk bundle? HEAD probe (local then HF), or the
// inline check. Cheap enough to run per car when building the picker.
async function hasEtk(chassisId) {
  const id = chassisId.toUpperCase();
  if (typeof BMACW_ETK === 'object' && BMACW_ETK) return !!BMACW_ETK[id];
  const real = (typeof webRealFetch === 'function') ? webRealFetch : window.fetch.bind(window);
  const probe = async (local) => {
    try {
      const r = await real(etkBundleUrl(id, local), { method: 'HEAD' });
      return r.ok;
    } catch (e) { return false; }
  };
  return (await probe(true)) || (await probe(false));
}

// The Apps hub asks these two: is ETK in this build at all, and open it.
function etkHasData() {
  if (typeof BMACW_ETK === 'object' && BMACW_ETK) return Object.keys(BMACW_ETK).length > 0;
  return true;   // web build: assume the data/ tree may carry it; the picker probes per car
}

async function etkChassisList() {
  if (etkChassisIds) return etkChassisIds;
  // one index.json lists every chassis that has a bundle -- read it instead of
  // HEAD-probing all ~135 cars (that would be hundreds of requests to HF).
  if (typeof BMACW_ETK === 'object' && BMACW_ETK) {
    etkChassisIds = Object.keys(BMACW_ETK).sort();
    return etkChassisIds;
  }
  const real = (typeof webRealFetch === 'function') ? webRealFetch : window.fetch.bind(window);
  const tryIndex = async (local) => {
    try {
      const url = local ? etkBundleUrl('index', true).replace('.etk', '.json')
                        : `${ETK_HF_BASE}index.json`;
      const r = await real(url);
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  };
  const idx = (await tryIndex(true)) || (await tryIndex(false));
  etkChassisIds = Array.isArray(idx) ? idx.slice().sort() : [];
  return etkChassisIds;
}

// An image ref in the tree ("319345.jpg") -> a blob URL the <img> can show.
const ETK_IMG_URLS = new Map();
function etkImageUrl(data, ref) {
  if (!ref) return null;
  const key = data.tree.chassis + '/' + ref;
  if (ETK_IMG_URLS.has(key)) return ETK_IMG_URLS.get(key);
  const bytes = data.files.get(`img/${ref}`);
  if (!bytes) return null;
  const ext = ref.split('.').pop().toLowerCase();
  const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  ETK_IMG_URLS.set(key, url);
  return url;
}

async function showEtk() {
  lastScreen = showEtk;
  setCrumbs([{ label: 'Vehicles', fn: showChassis },
             { label: 'Apps', fn: showApps }, { label: 'Parts Catalogue' }]);
  document.body.classList.add('etk-screen');
  sbLeft.textContent = 'parts';
  view.innerHTML = head('ETK', 'Parts Catalogue',
    "BMW's own parts diagrams. Pick a vehicle to browse its catalogue.");
  setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: showApps }]);

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
    const note = document.createElement('div');
    note.className = 'empty wiring-absent';
    note.innerHTML = `
      <div class="empty-big">No parts data in this build</div>
      <div>The catalogue comes from BMW's ETK, a separate import not part of this repository.</div>
      <div style="font-size:12px;color:var(--ink-faint)">To add it:
           <code>tools/etk_import.py --db etk.sqlite --out data/etk</code>.</div>`;
    view.appendChild(note);
    return;
  }
  ids.forEach((id) => {
    const tag = (typeof CHASSIS_TAG === 'object' && CHASSIS_TAG[id]) || 'BMW';
    const card = document.createElement('button');
    card.className = 'chassis-card';
    card.innerHTML = `
      <div class="chassis-code">${esc(dispChassis(id))}</div>
      <div class="chassis-tag">${esc(tag)}</div>
      <div class="chassis-arrow">→</div>`;
    card.onclick = () => showEtkChassis(id);
    grid.appendChild(card);
  });
  stagger(grid, 22);
  sbRight.textContent = `${ids.length} chassis`;
  setActions([
    ...ids.slice(0, 9).map((id, i) => ({ key: String(i + 1), label: dispChassis(id), fn: () => showEtkChassis(id) })),
    { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: showApps },
  ]);
}

// The chassis landing: ETK's "Search by Main Group" -- an icon grid of the HG
// groups, plus a variant selector so parts can be filtered to one exact vehicle.
// The selected variant is remembered across the whole chassis (module-level).
const ETK_STATE = { variant: null };   // chosen variant index, or null = all

async function showEtkChassis(chassisId) {
  const id = chassisId.toUpperCase();
  lastScreen = () => showEtkChassis(id);
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: 'Apps', fn: showApps },
    { label: 'Parts', fn: showEtk },
    { label: dispChassis(id) },
  ]);
  sbLeft.textContent = 'loading parts…';
  view.innerHTML = head('ETK', dispChassis(id), 'Pick a variant to filter, then a main group.');
  document.body.classList.remove('wds-nofkeys');
  document.body.classList.add('etk-screen');

  // the bundle streams from Hugging Face (~20 MB) -- a real wait, so show a
  // download progress bar instead of a blank pane while it loads.
  const loading = document.createElement('div');
  loading.className = 'etk-loading';
  loading.innerHTML = `
    <span class="wiring-spinner"></span>
    <div class="etk-progress-wrap">
      <div class="etk-progress-label">Loading ${esc(dispChassis(id))} parts catalogue…</div>
      <div class="etk-progress-track"><div class="etk-progress-bar" id="etk-progress"></div></div>
    </div>`;
  view.appendChild(loading);
  const bar = loading.querySelector('#etk-progress');
  const onProgress = (loaded, total) => {
    if (total > 0) {
      const pct = Math.min(100, Math.round((loaded / total) * 100));
      bar.style.width = pct + '%';
      loading.querySelector('.etk-progress-label').textContent =
        `Loading ${dispChassis(id)} parts catalogue… ${pct}%`;
    } else {
      bar.classList.add('etk-progress-indeterminate');   // no length -> animate
    }
  };

  let data;
  try { data = await loadEtk(id, onProgress); }
  catch (e) { loading.remove(); view.appendChild(errorBlock(String(e.message || e))); return; }
  loading.remove();
  ETK_STATE.variant = null;   // reset filter when entering a chassis

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
  stagger(grid, 16);

  sbLeft.textContent = `${(data.tree.maingroups || []).length} main groups`;
  sbRight.textContent = `${(data.tree.variants || []).length} variants`;
  setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: showEtk }]);
}

// A custom searchable dropdown for the 297 variants -- the native <select> is
// unstyleable and unsearchable. Options: "All variants" plus one per variant,
// sorted by model+date, filterable by a search box. Sets ETK_STATE.variant.
function buildVariantDropdown(variants) {
  const order = variants.map((v, i) => ({ i, v, text: variantLabel(v) }))
    .sort((a, b) => (a.v.model || '').localeCompare(b.v.model || '') ||
                    String(a.v.date).localeCompare(String(b.v.date)));

  const root = document.createElement('div');
  root.className = 'etk-vdd';
  const btn = document.createElement('button');
  btn.className = 'etk-vdd-btn';
  btn.innerHTML = `<span class="etk-vdd-cur">All variants (${variants.length})</span>
                   <span class="etk-vdd-caret">▾</span>`;
  const menu = document.createElement('div');
  menu.className = 'etk-vdd-menu';
  menu.hidden = true;
  const search = document.createElement('input');
  search.className = 'etk-vdd-search';
  search.type = 'search';
  search.placeholder = 'Search 316i, LHD, N42, 2003…';
  const list = document.createElement('div');
  list.className = 'etk-vdd-list';
  menu.appendChild(search);
  menu.appendChild(list);
  root.appendChild(btn);
  root.appendChild(menu);

  const cur = btn.querySelector('.etk-vdd-cur');

  function choose(idx, text, ev) {
    if (ev) { ev.preventDefault(); ev.stopPropagation(); }
    ETK_STATE.variant = idx;
    cur.textContent = text;
    cur.classList.toggle('etk-vdd-filtered', idx != null);
    close();
  }

  function renderList(q) {
    list.innerHTML = '';
    const ql = (q || '').toLowerCase();
    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'etk-vdd-opt' + (ETK_STATE.variant == null ? ' active' : '');
    all.textContent = `All variants (${variants.length})`;
    all.onclick = (e) => choose(null, `All variants (${variants.length})`, e);
    if (!ql) list.appendChild(all);
    let shown = 0;
    for (const o of order) {
      if (ql && !o.text.toLowerCase().includes(ql)) continue;
      if (++shown > 200) break;   // cap the DOM; search narrows it
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'etk-vdd-opt' + (ETK_STATE.variant === o.i ? ' active' : '');
      el.textContent = o.text;
      el.onclick = (e) => choose(o.i, o.text, e);
      list.appendChild(el);
    }
  }

  let outside = null;
  function open() {
    menu.hidden = false; search.value = ''; renderList(''); search.focus();
    // arm the outside-click closer on the NEXT tick so this same click that
    // opened the menu doesn't immediately close it.
    setTimeout(() => {
      outside = (e) => { if (!root.contains(e.target)) close(); };
      document.addEventListener('click', outside);
    }, 0);
  }
  function close() {
    menu.hidden = true;
    if (outside) { document.removeEventListener('click', outside); outside = null; }
  }

  btn.type = 'button';
  btn.onclick = (e) => { e.stopPropagation(); menu.hidden ? open() : close(); };
  search.oninput = () => renderList(search.value);
  search.onclick = (e) => e.stopPropagation();

  return root;
}

function variantLabel(v) {
  const parts = [];
  if (v.model) parts.push(v.model);
  if (v.body) parts.push(v.body);
  if (v.motor) parts.push(v.motor);
  if (v.steer) parts.push(v.steer === 'R' ? 'RHD' : v.steer === 'L' ? 'LHD' : v.steer);
  if (v.gear) parts.push({ A: 'auto', M: 'man.', N: '—' }[v.gear] || v.gear);
  if (v.date) {
    const d = String(v.date);
    if (d.length === 8) parts.push(`${d.slice(0, 4)}-${d.slice(4, 6)}`);
  }
  return parts.join(' · ');
}

// A main group opened: the wiring-style split -- its function-group tree of
// diagrams on the left, the selected diagram on the right, all honouring the
// active variant filter.
function showEtkGroup(data, chassisId, mg) {
  const id = chassisId.toUpperCase();
  lastScreen = () => showEtkGroup(data, id, mg);
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: 'Apps', fn: showApps },
    { label: 'Parts', fn: showEtk },
    { label: dispChassis(id), fn: () => showEtkChassis(id) },
    { label: `${mg.hg} ${mg.name}` },
  ]);
  view.innerHTML = '';
  document.body.classList.add('wds-nofkeys');

  const split = document.createElement('div');
  split.className = 'etk-split';
  split.innerHTML = `
    <div class="etk-body">
      <nav class="etk-nav"><div class="etk-tree" id="etk-tree"></div></nav>
      <div class="etk-view" id="etk-view"></div>
    </div>`;
  view.appendChild(split);
  const treeEl = split.querySelector('#etk-tree');
  const viewEl = split.querySelector('#etk-view');

  let selectedLeaf = null;
  mg.groups.forEach((g) => {
    const grp = document.createElement('div');
    grp.className = 'etk-tgroup';
    const hdr = document.createElement('button');
    hdr.className = 'etk-tgroup-hdr';
    hdr.innerHTML = `<span class="etk-tw">▾</span>
                     <span class="etk-tname">${esc(g.name)}</span>
                     <span class="etk-tcount">${g.diagrams.length}</span>`;
    const kids = document.createElement('div');
    kids.className = 'etk-tkids';
    hdr.onclick = () => {
      const open = kids.style.display !== 'none';
      kids.style.display = open ? 'none' : 'block';
      hdr.querySelector('.etk-tw').textContent = open ? '▸' : '▾';
    };
    g.diagrams.forEach((d) => {
      const leaf = document.createElement('button');
      leaf.className = 'etk-tleaf';
      leaf.innerHTML = `<span class="etk-lname">${esc(d.name)}</span>
                        <span class="etk-lcount">${countFit(d.parts)}</span>`;
      leaf.onclick = () => {
        if (selectedLeaf) selectedLeaf.classList.remove('active');
        leaf.classList.add('active');
        selectedLeaf = leaf;
        renderDiagram(data, id, d, viewEl);
      };
      kids.appendChild(leaf);
    });
    grp.appendChild(hdr);
    grp.appendChild(kids);
    treeEl.appendChild(grp);
  });

  // open the first diagram so the pane isn't empty
  const firstLeaf = treeEl.querySelector('.etk-tleaf');
  if (firstLeaf) firstLeaf.click();

  sbLeft.textContent = mg.name;
  setActions([]);
}

// parts count honouring the active variant filter
function countFit(parts) {
  if (ETK_STATE.variant == null) return parts.length;
  return parts.filter((p) => !p.fit || p.fit.includes(ETK_STATE.variant)).length;
}

// Render one diagram into the right pane: exploded-view image on top, its
// numbered parts list below, filtered to the chosen variant.
function renderDiagram(data, chassisId, d, viewEl) {
  viewEl.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'etk-diagram';

  const title = document.createElement('div');
  title.className = 'etk-dtitle';
  title.textContent = d.name;
  wrap.appendChild(title);

  const url = etkImageUrl(data, d.img);
  if (url) {
    const fig = document.createElement('div');
    fig.className = 'etk-figure';
    const img = document.createElement('img');
    img.alt = d.name;
    img.loading = 'lazy';
    img.onload = () => {
      const w = img.naturalWidth;
      if (w && w < 500) img.style.width = Math.min(w * 2, 700) + 'px';
    };
    img.src = url;
    fig.appendChild(img);
    wrap.appendChild(fig);
  }

  // filter parts to the active variant (parts with no fit data always show)
  const parts = d.parts.filter((p) =>
    ETK_STATE.variant == null || !p.fit || p.fit.includes(ETK_STATE.variant));

  const table = document.createElement('table');
  table.className = 'etk-parts';
  table.innerHTML = `<thead><tr><th>No.</th><th>Part number</th><th>Description</th></tr></thead>`;
  const tb = document.createElement('tbody');
  parts.forEach((p) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="etk-pos">${esc(p.pos)}</td>
                    <td class="etk-sachnr">${esc(fmtSachnr(p.sachnr, p.pre))}</td>
                    <td class="etk-name">${esc(p.name)}</td>`;
    tb.appendChild(tr);
  });
  table.appendChild(tb);
  wrap.appendChild(table);
  viewEl.appendChild(wrap);
  viewEl.scrollTop = 0;
  const filtered = ETK_STATE.variant != null && parts.length < d.parts.length;
  sbRight.textContent = `${parts.length} part${parts.length === 1 ? '' : 's'}`
    + (filtered ? ` (of ${d.parts.length})` : '');
}

// BMW part numbers print as the full 11-digit number when we have the group
// prefix: main-group + subgroup + 7-digit sachnr, grouped "11 13 7 791 531".
// Without a prefix, fall back to grouping the 7-digit number alone.
function fmtSachnr(s, prefix) {
  const d = String(s).replace(/\D/g, '');
  if (prefix && d.length === 7) {
    const p = String(prefix).replace(/\D/g, '');
    if (p.length === 4) {
      // HG(2) UG(2) X(1) XXX(3) XXX(3)
      return `${p.slice(0, 2)} ${p.slice(2, 4)} ${d.slice(0, 1)} ${d.slice(1, 4)} ${d.slice(4)}`;
    }
  }
  if (d.length === 7) return `${d.slice(0, 2)} ${d.slice(2, 4)} ${d.slice(4)}`;
  return s;
}
