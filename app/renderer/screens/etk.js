// ETK parts catalogue, from BMW's own data. tools/etk_import.py packs one .etk
// archive per car: tree.json (assembly groups -> diagrams -> parts) plus the
// exploded-view images (jpg/png). Same archive shape and loading path as the
// .wiring bundles -- fflate inflates, and the offline export inlines base64.

const ETK_CACHE = new Map();       // chassis -> { tree, files: Map(name -> u8) }
let etkChassisIds = null;          // memoised probe of which cars have data

async function loadEtk(chassisId) {
  const id = chassisId.toUpperCase();
  if (ETK_CACHE.has(id)) return ETK_CACHE.get(id);
  let bytes;
  const inline = (typeof BMACW_ETK === 'object' && BMACW_ETK) ? BMACW_ETK[id] : null;
  if (inline) {
    const bin = atob(inline);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    const base = (typeof WEB_BASE === 'string') ? WEB_BASE : '';
    const real = (typeof webRealFetch === 'function') ? webRealFetch : window.fetch.bind(window);
    const r = await real(`${base}/data/etk/${id}.etk`);
    if (!r.ok) throw new Error(`no parts data shipped for ${dispChassis(id)}`);
    bytes = new Uint8Array(await r.arrayBuffer());
  }
  const unzipped = fflate.unzipSync(bytes);
  const tree = JSON.parse(new TextDecoder().decode(unzipped['tree.json']));
  const files = new Map(Object.entries(unzipped));
  const data = { tree, files };
  ETK_CACHE.set(id, data);
  return data;
}

// Does this chassis have an .etk bundle? HEAD probe (or inline check), same as
// hasWiring. Cheap enough to run per car when building the picker.
async function hasEtk(chassisId) {
  const id = chassisId.toUpperCase();
  if (typeof BMACW_ETK === 'object' && BMACW_ETK) return !!BMACW_ETK[id];
  try {
    const base = (typeof WEB_BASE === 'string') ? WEB_BASE : '';
    const real = (typeof webRealFetch === 'function') ? webRealFetch : window.fetch.bind(window);
    const r = await real(`${base}/data/etk/${id}.etk`, { method: 'HEAD' });
    return r.ok;
  } catch (e) { return false; }
}

// The Apps hub asks these two: is ETK in this build at all, and open it.
function etkHasData() {
  if (typeof BMACW_ETK === 'object' && BMACW_ETK) return Object.keys(BMACW_ETK).length > 0;
  return true;   // web build: assume the data/ tree may carry it; the picker probes per car
}

async function etkChassisList() {
  if (etkChassisIds) return etkChassisIds;
  const all = (typeof CHASSIS_TAG === 'object') ? Object.keys(CHASSIS_TAG) : [];
  const ids = [];
  await Promise.all(all.map(async (id) => { if (await hasEtk(id)) ids.push(id); }));
  etkChassisIds = ids.sort();
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

async function showEtkChassis(chassisId, openBtnr = null) {
  const id = chassisId.toUpperCase();
  lastScreen = () => showEtkChassis(id);
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: 'Apps', fn: showApps },
    { label: 'Parts', fn: showEtk },
    { label: dispChassis(id) },
  ]);
  sbLeft.textContent = 'loading parts…';
  view.innerHTML = '';   // no page heading: the diagram wants the height, crumbs say where

  let data;
  try { data = await loadEtk(id); }
  catch (e) { view.appendChild(errorBlock(String(e.message || e))); return; }

  // this is a full-window split like wiring; the F-key bar isn't useful here
  document.body.classList.add('wds-nofkeys');

  // Same split shape as wiring: a persistent tree on the left, the selected
  // diagram (image + parts) on the right. The tree is assembly groups that
  // expand to their diagrams.
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

  // build the tree: group headers that toggle their diagram leaves
  let selectedLeaf = null;
  data.tree.groups.forEach((g, gi) => {
    const grp = document.createElement('div');
    grp.className = 'etk-tgroup';
    const hdr = document.createElement('button');
    hdr.className = 'etk-tgroup-hdr';
    hdr.innerHTML = `<span class="etk-tw">▸</span>
                     <span class="etk-tname">${esc(g.name)}</span>
                     <span class="etk-tcount">${g.diagrams.length}</span>`;
    const kids = document.createElement('div');
    kids.className = 'etk-tkids';
    kids.style.display = 'none';
    hdr.onclick = () => {
      const open = kids.style.display !== 'none';
      kids.style.display = open ? 'none' : 'block';
      hdr.querySelector('.etk-tw').textContent = open ? '▸' : '▾';
    };
    g.diagrams.forEach((d) => {
      const leaf = document.createElement('button');
      leaf.className = 'etk-tleaf';
      leaf.innerHTML = `<span class="etk-lname">${esc(d.name)}</span>
                        <span class="etk-lcount">${d.parts.length}</span>`;
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

  // open the first group + its first diagram so the right pane isn't empty
  const firstGrp = treeEl.querySelector('.etk-tgroup');
  if (firstGrp) {
    firstGrp.querySelector('.etk-tgroup-hdr').click();
    const firstLeaf = firstGrp.querySelector('.etk-tleaf');
    if (firstLeaf) firstLeaf.click();
  }

  sbLeft.textContent = `${data.tree.groups.length} assembly groups`;
  setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Vehicles', kind: 'back', fn: showEtk }]);
}

// Render one diagram into the right pane: exploded-view image on top, its
// numbered parts list below.
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
    // small scans (the old microfiche ~230px) look lost at native size in a wide
    // pane; show them at ~2x, capped, so they read like a diagram not a stamp.
    img.onload = () => {
      const w = img.naturalWidth;
      if (w && w < 500) img.style.width = Math.min(w * 2, 700) + 'px';
    };
    img.src = url;
    fig.appendChild(img);
    wrap.appendChild(fig);
  }

  const table = document.createElement('table');
  table.className = 'etk-parts';
  table.innerHTML = `<thead><tr><th>No.</th><th>Part number</th><th>Description</th></tr></thead>`;
  const tb = document.createElement('tbody');
  d.parts.forEach((p) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="etk-pos">${esc(p.pos)}</td>
                    <td class="etk-sachnr">${esc(fmtSachnr(p.sachnr))}</td>
                    <td class="etk-name">${esc(p.name)}</td>`;
    tb.appendChild(tr);
  });
  table.appendChild(tb);
  wrap.appendChild(table);
  viewEl.appendChild(wrap);
  viewEl.scrollTop = 0;
  sbRight.textContent = `${d.parts.length} part${d.parts.length === 1 ? '' : 's'}`;
  // a diagram is a detail view inside the split -- no F-key action bar (just Esc
  // to leave the whole chassis, which the crumbs already offer).
  setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Vehicles', kind: 'back', fn: showEtk }]);
}

// BMW part numbers print grouped 00 00 000 (7 digits) for readability.
function fmtSachnr(s) {
  const d = String(s).replace(/\D/g, '');
  if (d.length === 7) return `${d.slice(0, 2)} ${d.slice(2, 4)} ${d.slice(4)}`;
  return s;
}
