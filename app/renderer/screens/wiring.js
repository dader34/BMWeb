// Wiring diagrams, from BMW's own WDS. tools/wds_import.py packs one .wiring
// archive per car: schematics as .svgz (gzipped SVG, vector) and functional
// descriptions as HTML, straight out of WDS. Inflating is fflate.

const WIRING_CACHE = new Map();   // chassis -> { tree, files: Map(name -> u8) }

// WDS's pane buttons: a frame with the divider pushed one way; the filled block
// is the pane that gets the room. doc=document, split=both, tree=tree.
const WDS_PANE_GLYPH = {
  doc: `<svg viewBox="0 0 16 14" width="16" height="14" aria-hidden="true">
    <rect x="1" y="1" width="14" height="12" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <rect x="1" y="1" width="3.5" height="12" fill="currentColor"/></svg>`,
  split: `<svg viewBox="0 0 16 14" width="16" height="14" aria-hidden="true">
    <rect x="1" y="1" width="14" height="12" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <rect x="6.5" y="1" width="3" height="12" fill="currentColor"/></svg>`,
  tree: `<svg viewBox="0 0 16 14" width="16" height="14" aria-hidden="true">
    <rect x="1" y="1" width="14" height="12" fill="none" stroke="currentColor" stroke-width="1.5"/>
    <rect x="11.5" y="1" width="3.5" height="12" fill="currentColor"/></svg>`,
};

// kinds the tree uses, in the order a person looks for them
const WIRING_KIND_LABEL = {
  schematic: 'Wiring diagram',
  location: 'Component location',
  connector: 'Connector view',
  pins: 'Pin assignment',
  specs: 'Specifications',
  test: 'Test procedure',
  description: 'Description',
  measurement: 'Measurement',
  help: 'Help',
  document: 'Document',
};

async function loadWiring(chassisId) {
  const id = chassisId.toUpperCase();
  if (WIRING_CACHE.has(id)) return WIRING_CACHE.get(id);
  // the offline export inlines archives as base64; use that when present
  let bytes;
  const inline = (typeof BMACW_WIRING === 'object' && BMACW_WIRING)
    ? BMACW_WIRING[id] : null;
  if (inline) {
    const bin = atob(inline);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    const base = (typeof WEB_BASE === 'string') ? WEB_BASE : '';
    const real = (typeof webRealFetch === 'function')
      ? webRealFetch : window.fetch.bind(window);
    const r = await real(`${base}/data/wiring/${id}.wiring`);
    if (!r.ok) throw new Error(`no wiring data shipped for ${dispChassis(id)}`);
    bytes = new Uint8Array(await r.arrayBuffer());
  }
  const unzipped = fflate.unzipSync(bytes);
  const tree = JSON.parse(new TextDecoder().decode(unzipped['tree.json']));
  const files = new Map(Object.entries(unzipped));
  const data = { tree, files };
  WIRING_CACHE.set(id, data);
  return data;
}

// A document ready for screen: schematics inflate to SVG, descriptions are HTML.
function wiringDoc(data, docId) {
  const svgz = data.files.get(`svg/${docId}.svgz`);
  if (svgz) {
    return { type: 'svg', text: fflate.strFromU8(fflate.gunzipSync(svgz)) };
  }
  const html = data.files.get(`doc/${docId}.html`);
  if (html) return { type: 'html', text: fflate.strFromU8(html) };
  return null;
}

// Photographs the .wiring archive doesn't carry (878 MB, over the GitHub Pages
// cap), fetched from a CDN on the hosted site. jsDelivr, not a release asset:
// release downloads send no access-control-allow-origin, jsDelivr is CORS-open.
// PINNED TO A COMMIT, not @main: a moving branch means a later repo reorg
// retroactively breaks the photos in every export ever shipped. Bump the SHA
// deliberately.
const WIRING_IMG_CDN =
  'https://cdn.jsdelivr.net/gh/dader34/BMacW-wiring-images@55cad337b4787326cfcacbea220fa4787aaa74e4/img/';
const WIRING_IMG_CACHE = 'bmacw-wiring-images-v3';  // bump with the CDN URL

// A blob URL per image, made once and kept: the same photo appears on many
// documents, and minting a URL per view would leak one each time.
function wiringImageUrl(data, path, bytesOrBlob) {
  if (!data.imgUrls) data.imgUrls = new Map();
  let url = data.imgUrls.get(path);
  if (!url) {
    // from the archive it is bytes; from the CDN it is already a Blob
    const blob = (bytesOrBlob instanceof Blob) ? bytesOrBlob
      : new Blob([bytesOrBlob], { type: 'image/png' });
    url = URL.createObjectURL(blob);
    data.imgUrls.set(path, url);
  }
  return url;
}

// Fetch a photograph the archive doesn't hold, and cache it (Cache API survives
// reloads, so a car browsed once keeps its pictures offline). A miss re-fetches.
async function wiringFetchImage(name) {
  const url = WIRING_IMG_CDN + name;
  try {
    const cache = await caches.open(WIRING_IMG_CACHE);
    const hit = await cache.match(url);
    if (hit) return hit.blob();
    const res = await fetch(url);
    if (!res.ok) return null;
    await cache.put(url, res.clone());
    return res.blob();
  } catch {
    // no Cache API (file://, private mode): still show the picture
    try {
      const res = await fetch(url);
      return res.ok ? res.blob() : null;
    } catch { return null; }
  }
}

// flatten the tree once for search: every leaf with the folder path above it
function wiringIndex(tree) {
  const out = [];
  (function walk(node, trail) {
    for (const c of node.children || []) {
      if (c.doc) out.push({ name: c.name, kind: c.kind, doc: c.doc, trail });
      else walk(c, [...trail, c.name]);
    }
  })(tree, []);
  return out;
}

// Which cars WDS covers, asked once and remembered so the picker draws only
// what can actually open.
let WIRING_CHASSIS = null;

async function wiringChassisList() {
  if (WIRING_CHASSIS) return WIRING_CHASSIS;
  const ids = await api('/api/chassis').catch(() => []);
  // all 21 probes in parallel: serially it was seconds of blank screen
  const have = await Promise.all(ids.map((id) => hasWiring(id)));
  WIRING_CHASSIS = ids.filter((_, i) => have[i]);
  return WIRING_CHASSIS;
}

// Wiring as its own section: pick the car here rather than arriving via chassis.
async function showWiringChassis() {
  lastScreen = showWiringChassis;
  setCrumbs([{ label: 'Vehicles', fn: showChassis }, { label: 'Wiring' }]);
  sbLeft.textContent = 'wiring';
  view.innerHTML = head('WDS', 'Wiring Diagrams',
    'BMW’s own schematics. Pick a vehicle to browse its diagrams.');
  setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
                fn: showChassis }]);

  const classic = typeof inpaMode === 'function' && inpaMode();
  const grid = document.createElement('div');
  grid.className = classic ? 'inpa-vlist' : 'chassis-grid stagger';

  // fill the page while the 21 probes run (several seconds on a hosted site)
  const wait = document.createElement('div');
  wait.className = 'wiring-loading';
  wait.innerHTML = `<span class="wiring-spinner"></span>`
    + `<span>Looking for the vehicles with diagrams…</span>`;
  view.appendChild(wait);
  view.appendChild(grid);

  const ids = await wiringChassisList();
  wait.remove();
  if (!ids.length) {
    // NOT an error (errorBlock's cable/ignition advice would be irrelevant):
    // the hosted site just can't carry 1.1 GB over the GitHub Pages cap.
    const note = document.createElement('div');
    note.className = 'empty wiring-absent';
    note.innerHTML = `
      <div class="empty-big">No wiring data in this build</div>
      <div>The diagrams come from BMW's WDS, which is a separate download and
           not part of this repository.</div>
      <div style="font-size:12px;color:var(--ink-faint)">To add them:
           <code>scripts/setup/fetch-wds.sh</code> then
           <code>tools/wds_import.py --wds vendor/WDS</code>.</div>`;
    view.appendChild(note);
    return;
  }
  ids.forEach((id, i) => {
    const tag = (typeof CHASSIS_TAG === 'object' && CHASSIS_TAG[id]) || 'BMW';
    const card = document.createElement('button');
    if (classic) {
      // INPA idiom: an F-key list, not cards
      card.className = 'inpa-fn';
      card.innerHTML = `<span class="inpa-fn-key">&lt; F${i + 1} &gt;</span>`
        + `<span class="inpa-fn-label">${esc(dispChassis(id))} · ${esc(tag)}</span>`;
    } else {
      card.className = 'chassis-card';
      card.innerHTML = `
        <div class="chassis-code">${esc(dispChassis(id))}</div>
        <div class="chassis-tag">${esc(tag)}</div>
        <div class="chassis-arrow">→</div>`;
    }
    card.onclick = () => showWiring(id);
    grid.appendChild(card);
  });
  if (!classic) stagger(grid, 22);
  sbRight.textContent = `${ids.length} chassis`;
  setActions([
    ...ids.slice(0, 9).map((id, i) => ({
      key: String(i + 1), label: dispChassis(id), fn: () => showWiring(id),
    })),
    { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: showChassis },
  ]);
}

function showWiring(chassisId, openDoc = null) {
  lastScreen = () => showWiring(chassisId);
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: 'Wiring', fn: showWiringChassis },
    { label: dispChassis(chassisId) },
  ]);
  sbLeft.textContent = 'loading wiring…';
  // no page heading: a schematic wants every pixel of height, crumbs say where
  // you are
  view.innerHTML = '';

  // INPA mode wears WDS's own chrome; same code underneath, only the frame
  // changes.
  const classic = typeof inpaMode === 'function' && inpaMode();
  // no F-key bar either mode: both layouts carry Back/print/help on their own
  // chrome, and the bar would cost the diagram 52px. setCrumbs restores it.
  document.body.classList.add('wds-nofkeys');
  const split = document.createElement('div');
  split.className = 'split wiring-split' + (classic ? ' wds-frame' : '');
  split.innerHTML = `
    ${classic ? `
    <div class="wds-toolbar">
      <button class="wds-btn" id="wds-series"
              title="Back to the vehicle list">&lt;&lt; Series</button>
      <button class="wds-btn" id="wds-print"
              title="Print this diagram, filling the sheet">Print</button>
      <button class="wds-btn" id="wds-exit"
              title="Leave wiring and return to the vehicles">Exit</button>
      <button class="wds-btn" id="wds-start"
              title="Back to the top of this vehicle's tree">Start</button>
      <span class="wds-nav-pair">
        <button class="wds-btn wds-btn-sq" id="wds-prev"
                title="Previous document in tree order">&lt;&lt;</button>
        <button class="wds-btn wds-btn-sq" id="wds-next"
                title="Next document in tree order">&gt;&gt;</button>
      </span>
      <button class="wds-btn wds-help" id="wds-help"
              title="How to use this screen">Help</button>
    </div>
    <div class="wds-titlebar">
      <span>WDS BMW Wiring Diagram System - ${esc(dispChassis(chassisId))}</span>
      <span class="wds-version">Version</span>
    </div>` : ''}
    ${classic ? '' : `
    <div class="wiring-toolbar">
      <button class="btn wiring-tbtn" id="wds-back"
              title="Back to the vehicle list (Esc)">←&nbsp;Back</button>
      <span class="wiring-tsep"></span>
      <input class="wiring-search" id="wiring-search" type="search"
             placeholder="Search diagrams…" autocomplete="off"
             title="Search every document title in this vehicle">
      <button class="btn wiring-tbtn" id="wds-new"
              title="Clear the search and show the whole tree">Clear</button>
      <span class="wiring-tsep"></span>
      <button class="btn wiring-tbtn" id="wds-prev"
              title="Previous document in tree order">←</button>
      <button class="btn wiring-tbtn" id="wds-next"
              title="Next document in tree order">→</button>
      <span class="wiring-panegroup">
        <button class="btn wiring-tbtn wds-pane" id="wds-pane-tree"
                title="Give the whole window to the tree">${WDS_PANE_GLYPH.tree}</button>
        <button class="btn wiring-tbtn wds-pane" id="wds-pane-split"
                title="Show the tree and the diagram side by side">${WDS_PANE_GLYPH.split}</button>
        <button class="btn wiring-tbtn wds-pane" id="wds-pane-doc"
                title="Give the whole window to the diagram">${WDS_PANE_GLYPH.doc}</button>
      </span>
      <span class="wiring-tspacer"></span>
      <button class="btn wiring-tbtn" id="wds-print"
              title="Print this diagram, filling the sheet">Print</button>
      <button class="btn wiring-tbtn" id="wds-help"
              title="How to use this screen">Help</button>
    </div>`}
    <div class="wiring-body">
      <nav class="split-nav wiring-nav">
        <div class="wiring-tree" id="wiring-tree"></div>
      </nav>
      <div class="split-content wiring-view" id="wiring-view"></div>
    </div>
    ${classic ? `
    <div class="wds-footer">
      <label class="wds-searchlabel" for="wiring-search">Enter search word</label>
      <input class="wds-input" id="wiring-search" type="search" autocomplete="off"
             title="Search every document title in this vehicle">
      <button class="wds-btn" id="wds-find"
              title="Search for the word above">Search</button>
      <button class="wds-btn" id="wds-new"
              title="Clear the search and show the whole tree">New</button>
      <span class="wds-panegroup">
        <button class="wds-btn wds-btn-sq wds-pane" id="wds-pane-doc"
                title="Give the whole window to the diagram">${WDS_PANE_GLYPH.doc}</button>
        <button class="wds-btn wds-btn-sq wds-pane" id="wds-pane-split"
                title="Show the tree and the diagram side by side">${WDS_PANE_GLYPH.split}</button>
        <button class="wds-btn wds-btn-sq wds-pane" id="wds-pane-tree"
                title="Give the whole window to the tree">${WDS_PANE_GLYPH.tree}</button>
      </span>
      <span class="wds-zoomgroup" id="wds-zoomgroup"></span>
    </div>` : ''}`;
  view.appendChild(split);

  const treeEl = split.querySelector('#wiring-tree');
  // the archive is 2-24 MB: real wait before the tree appears, so fill it
  treeEl.innerHTML = `<div class="wiring-loading">`
    + `<span class="wiring-spinner"></span>`
    + `<span>Loading ${esc(dispChassis(chassisId))} diagrams…</span></div>`;
  const viewEl = split.querySelector('#wiring-view');
  const searchEl = split.querySelector('#wiring-search');

  // Both layouts carry the same controls; WDS's toolbar has a few extra
  // (Series, Exit, Start) the modern layout reaches through its crumbs.
  const on = (sel, fn) => {
    const el = split.querySelector(sel);
    if (el) el.onclick = fn;
  };
  on('#wds-series', showWiringChassis);
  on('#wds-exit', showChassis);
  // modern Back: the F-key bar is hidden here, so the route out is on the
  // toolbar (Esc still works)
  on('#wds-back', showWiringChassis);
  on('#wds-start', () => showWiring(chassisId));
  on('#wds-help', () => showWiringHelp(chassisId));
  on('#wds-print', () => printWiring(chassisId));
  on('#wds-new', () => {
    searchEl.value = '';
    searchEl.dispatchEvent(new Event('input'));
  });
  on('#wds-find', () => searchEl.dispatchEvent(new Event('input')));

  // The pane buttons: tree, document, or split. The setting sticks the way WDS
  // remembered it.
  const body = split.querySelector('.wiring-body');
  const setPane = (mode, remember = true) => {
    body.dataset.pane = mode;
    split.querySelectorAll('.wds-pane').forEach((b) =>
      b.classList.toggle('active', b.id === `wds-pane-${mode}`));
    // an automatic switch (phone opening a diagram) must not overwrite the
    // choice the user made on desktop -- same setting
    if (remember) Settings.set('wdsPane', mode);
    // no re-fit here: fitAndPan watches the stage and re-fits on any box change,
    // leaving a hand-zoomed view alone instead of snapping it back
  };
  on('#wds-pane-doc', () => setPane('doc'));
  on('#wds-pane-split', () => setPane('split'));
  on('#wds-pane-tree', () => setPane('tree'));
  setPane(Settings.get('wdsPane', 'split'));
  tipify(split);

  // Back from the tree leaves wiring; back from a DIAGRAM on a phone returns to
  // the tree first -- panes are exclusive there, so leaving would skip a level.
  const leaveWiring = () => {
    if (window.matchMedia('(max-width: 760px)').matches
        && body.dataset.pane === 'doc') {
      setPane('tree', false);
      return;
    }
    showWiringChassis();
  };
  const browseActions = [{ key: 'Escape', keyLabel: 'Esc', label: 'Back',
                           kind: 'back', fn: leaveWiring }];
  setActions(browseActions);

  loadWiring(chassisId).then((data) => {
    const index = wiringIndex(data.tree);
    sbLeft.textContent = 'wiring';
    sbRight.textContent = `${index.length} documents`;

    // prev/next step through documents in tree order (the flat index IS that
    // order)
    let atIndex = -1;
    const step = (d) => {
      if (!index.length) return;
      atIndex = (atIndex + d + index.length) % index.length;
      openDocument(index[atIndex]);
    };
    on('#wds-prev', () => step(-1));
    on('#wds-next', () => step(1));

    // the tree: folders collapse, leaves open
    const renderTree = (node, parent, depth) => {
      for (const c of node.children || []) {
        if (c.doc) {
          const leaf = document.createElement('button');
          leaf.className = `wiring-leaf kind-${c.kind}`;
          leaf.style.paddingLeft = `${10 + depth * 12}px`;
          leaf.innerHTML = `<span class="wiring-dot"></span>`
            + `<span class="wiring-leaf-name">${esc(c.name)}</span>`;
          leaf.title = WIRING_KIND_LABEL[c.kind] || c.kind;
          leaf.onclick = () => openDocument(c);
          parent.appendChild(leaf);
        } else if (c.children && c.children.length > 0) {
          const wrap = document.createElement('div');
          const btn = document.createElement('button');
          btn.className = 'wiring-folder';
          btn.style.paddingLeft = `${10 + depth * 12}px`;
          btn.innerHTML = `<span class="wiring-caret">▸</span>`
            + `<span>${esc(c.name)}</span>`;
          const kids = document.createElement('div');
          kids.className = 'wiring-kids';
          kids.hidden = true;
          btn.onclick = () => {
            kids.hidden = !kids.hidden;
            btn.classList.toggle('open', !kids.hidden);
            if (!kids.dataset.built) {
              renderTree(c, kids, depth + 1);
              kids.dataset.built = '1';
            }
          };
          wrap.appendChild(btn);
          wrap.appendChild(kids);
          parent.appendChild(wrap);
        } else {
          // Glossary / Signal definition leaf
          const leaf = document.createElement('button');
          leaf.className = 'wiring-leaf kind-specs';
          leaf.style.paddingLeft = `${10 + depth * 12}px`;
          leaf.innerHTML = `<span class="wiring-dot" style="background: var(--amber);"></span>`
            + `<span class="wiring-leaf-name">${esc(c.name)}</span>`;
          leaf.title = 'Signal / Component definition';
          leaf.onclick = () => openGlossary(c);
          parent.appendChild(leaf);
        }
      }
    };
    treeEl.innerHTML = '';           // drop the "loading" placeholder
    renderTree(data.tree, treeEl, 0);

    // search: flat results across the whole car, tree hidden while typing
    let searchWrap = null;
    searchEl.oninput = () => {
      const q = searchEl.value.trim().toLowerCase();
      if (searchWrap) { searchWrap.remove(); searchWrap = null; }
      treeEl.hidden = !!q;
      if (!q) return;
      const hits = index.filter(e => e.name.toLowerCase().includes(q)).slice(0, 300);
      searchWrap = document.createElement('div');
      searchWrap.className = 'wiring-results';
      if (!hits.length) {
        searchWrap.innerHTML = `<div class="wiring-empty">no match</div>`;
      }
      hits.forEach((e) => {
        const b = document.createElement('button');
        b.className = `wiring-leaf kind-${e.kind}`;
        b.innerHTML = `<span class="wiring-dot"></span>`
          + `<span class="wiring-leaf-name">${esc(e.name)}</span>`
          + `<span class="wiring-trail">${esc(e.trail.slice(-1)[0] || '')}</span>`;
        b.onclick = () => openDocument(e);
        searchWrap.appendChild(b);
      });
      treeEl.parentNode.appendChild(searchWrap);
      sbRight.textContent = `${hits.length} match${hits.length === 1 ? '' : 'es'}`;
    };

    // the glossary / signal definition viewer
    function openGlossary(entry) {
      if (window.matchMedia('(max-width: 760px)').matches) setPane('doc', false);
      viewEl.innerHTML = '';
      const bar = document.createElement('div');
      bar.className = 'wiring-bar';
      bar.innerHTML = `<div class="wiring-title">${esc(entry.name)}</div>
        <div class="wiring-kind">Signal / Component Information</div>`;
      viewEl.appendChild(bar);

      const parts = entry.name.split(/\s+/);
      const code = parts[0] || entry.name;
      const desc = parts.slice(1).join(' ') || entry.name;

      const codeLower = code.toLowerCase();
      const related = index.filter(e => e.name.toLowerCase().includes(codeLower)).slice(0, 40);

      const art = document.createElement('article');
      art.className = 'wiring-doc';

      let relatedHtml = '';
      if (related.length > 0) {
        relatedHtml = `
          <div style="margin-top: 20px;">
            <h2 style="font-size: 14px; font-weight: 700; color: var(--amber); margin: 0 0 10px; text-transform: uppercase; letter-spacing: 0.5px;">
              Referenced in ${related.length} Diagram${related.length === 1 ? '' : 's'}
            </h2>
            <div style="display: flex; flex-direction: column; gap: 6px;">
              ${related.map((r, idx) => `
                <div class="setting-row" style="cursor: pointer; padding: 10px 14px; border-radius: 6px; background: var(--panel-2); border: 1px solid var(--line);" data-doc="${esc(r.doc)}">
                  <div>
                    <div style="font-weight: 700; font-size: 13.5px; color: var(--ink);">${esc(r.name)}</div>
                    <div style="font-size: 11px; color: var(--ink-dim); margin-top: 2px;">${esc(r.trail.slice(-2).join(' › '))}</div>
                  </div>
                  <span style="color: var(--amber); font-size: 12px; font-weight: 700; white-space: nowrap;">View →</span>
                </div>
              `).join('')}
            </div>
          </div>`;
      } else {
        relatedHtml = `
          <div style="margin-top: 20px; padding: 14px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 6px;">
            <div style="font-size: 13px; color: var(--ink-dim);">
              Use the search bar at the top to search across all vehicle schematics for <strong>${esc(code)}</strong>.
            </div>
          </div>`;
      }

      art.innerHTML = `
        <div style="padding: 16px 18px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px;">
          <div style="display: inline-block; font-family: var(--mono); font-size: 12px; font-weight: 800; color: var(--amber); background: rgba(255, 158, 44, 0.12); border: 1px solid rgba(255, 158, 44, 0.3); border-radius: 4px; padding: 2px 7px; margin-bottom: 8px;">
            ${esc(code)}
          </div>
          <h1 style="font-size: 17px; font-weight: 800; margin: 0 0 6px;">${esc(desc)}</h1>
          <p style="color: var(--ink-dim); margin: 0; font-size: 12.5px;">
            BMW WDS Component / Signal Reference Designation.
          </p>
        </div>
        ${relatedHtml}
      `;

      art.querySelectorAll('[data-doc]').forEach((el) => {
        el.onclick = () => {
          const did = el.getAttribute('data-doc');
          const hit = index.find(e => e.doc === did);
          if (hit) openDocument(hit);
        };
      });

      viewEl.appendChild(art);
      viewEl.scrollTop = 0;
      setActions(browseActions);
    }

    // the document pane
    function openDocument(entry) {
      atIndex = index.findIndex(e => e.doc === entry.doc);
      // ONE PANE AT A TIME ON A PHONE: below 760px the CSS hides the unselected
      // pane, so loading into it means a 0x0 stage. Switch to it; no-op on
      // desktop.
      if (window.matchMedia('(max-width: 760px)').matches) setPane('doc', false);
      const doc = wiringDoc(data, entry.doc);
      viewEl.innerHTML = '';
      const bar = document.createElement('div');
      bar.className = 'wiring-bar';
      bar.innerHTML = `<div class="wiring-title">${esc(entry.name)}</div>
        <div class="wiring-kind">${esc(WIRING_KIND_LABEL[entry.kind] || entry.kind)}</div>`;
      viewEl.appendChild(bar);

      setActions(browseActions);   // reset; a schematic adds its zoom keys
      if (!doc) {
        viewEl.insertAdjacentHTML('beforeend',
          `<div class="empty"><div>This document is not in the WDS release the `
          + `data was built from.</div></div>`);
        return;
      }
      if (doc.type === 'html') {
        const art = document.createElement('article');
        art.className = 'wiring-doc';
        art.innerHTML = doc.text;
        // pictures live in the archive, not on a server, so an <img src> of
        // "img/x.png" resolves to nothing -- hand each one its bytes as a blob
        art.querySelectorAll('img[src^="img/"]').forEach((im) => {
          const path = im.getAttribute('src');
          const bytes = data.files.get(path);
          if (bytes) { im.src = wiringImageUrl(data, path, bytes); return; }
          // not in this archive: the hosted build keeps them on a CDN
          im.classList.add('wiring-img-loading');
          wiringFetchImage(path.slice(4)).then((blob) => {
            im.classList.remove('wiring-img-loading');
            if (!blob) { im.remove(); return; }  // gone: a box helps nobody
            im.src = wiringImageUrl(data, path, blob);
          });
        });
        // cross-document links resolve inside the app, never the network
        art.querySelectorAll('a[href^="#wds/"]').forEach((a) => {
          const target = a.getAttribute('href').slice(5);
          a.onclick = (ev) => {
            ev.preventDefault();
            const hit = index.find(e => e.doc === target);
            openDocument(hit || { name: target, kind: 'document', doc: target });
          };
        });
        viewEl.appendChild(art);
        viewEl.scrollTop = 0;
        return;
      }

      // a schematic: drop the SVG in, then pan/zoom
      const stage = document.createElement('div');
      stage.className = 'wiring-stage';
      stage.innerHTML = doc.text;
      viewEl.appendChild(stage);
      const svg = stage.querySelector('svg');
      if (svg) {
        // drop BMW's per-drawing <title> ("...Copyright BMW AG 2004"): it's an
        // SVG tooltip, so hovering popped a copyright notice. Name's in the bar.
        svg.querySelectorAll(':scope > title').forEach((t) => t.remove());
        // WDS kept zoom buttons in the footer; the modern layout on the bar
        const zoomHost = classic ? split.querySelector('#wds-zoomgroup') : bar;
        const zoom = fitAndPan(svg, stage, zoomHost, classic);
        // zoom keys on the bar too (a trackpad-less machine)
        setActions([
          { key: '+', keyLabel: '+', label: 'Zoom in', fn: () => zoom.by(1 / 1.3) },
          { key: '-', keyLabel: '-', label: 'Zoom out', fn: () => zoom.by(1.3) },
          { key: '0', keyLabel: '0', label: 'Fit', fn: () => zoom.fit() },
          // leaveWiring, not showWiringChassis: on a phone back from a diagram
          // returns to the tree first (identical on desktop)
          { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
            fn: leaveWiring },
        ]);
      }
      sbLeft.textContent = entry.name;
    }

    // open straight to a document when asked (ECU deep-link)
    if (openDoc) {
      const hit = index.find(e => e.doc === openDoc)
        || index.find(e => e.name === openDoc);
      if (hit) openDocument(hit);
    } else {
      viewEl.innerHTML = `<div class="empty"><div>`
        + `<strong>${index.length} documents</strong></div>`
        + `<div>Pick a diagram on the left, or search. Diagrams are vector: `
        + `scroll to zoom, drag to pan.</div></div>`;
    }
  }).catch((e) => {
    viewEl.innerHTML = errorBlock(e.message);
    sbLeft.textContent = 'no wiring data';
  });
}

// Zoom and pan by rewriting the viewBox: nothing re-renders but the attribute.
function fitAndPan(svg, stage, bar, classic = false) {
  let rawVb = svg.getAttribute('viewBox') || svg.getAttribute('viewbox');
  let vb = rawVb ? rawVb.trim().split(/[\s,]+/).map(Number) : [];
  if (vb.length !== 4 || vb.some(Number.isNaN)) {
    const w = parseFloat(svg.getAttribute('width')) || 10000;
    const h = parseFloat(svg.getAttribute('height')) || 2500;
    vb = [0, 0, w, h];
  }
  const home = { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };
  const cur = { ...home };
  const apply = () => svg.setAttribute('viewBox', `${cur.x} ${cur.y} ${cur.w} ${cur.h}`);
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.dataset.homeViewbox = `${home.x} ${home.y} ${home.w} ${home.h}`;

  let touched = false;
  const zoomBy = (k, fx = 0.5, fy = 0.5) => {
    touched = true;
    const w = Math.min(home.w * 20, Math.max(home.w / 100, cur.w * k));
    const h = w * (cur.h / cur.w);
    cur.x += (cur.w - w) * fx;
    cur.y += (cur.h - h) * fy;
    cur.w = w; cur.h = h;
    apply();
  };

  const fit = () => {
    touched = false;
    const r = stage.getBoundingClientRect();
    const pw = r.width || window.innerWidth || 360;
    const ph = r.height || (window.innerHeight - 100) || 600;
    const paneRatio = pw / ph;
    let w = home.w, h = home.h;
    if (home.w / home.h > paneRatio) h = home.w / paneRatio;
    else w = home.h * paneRatio;
    cur.x = home.x - (w - home.w) / 2;
    cur.y = home.y - (h - home.h) / 2;
    cur.w = w; cur.h = h;
    apply();
  };

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    const k = Math.max(cur.w / (r.width || 1), cur.h / (r.height || 1));
    const fx = ((e.clientX - r.left) * k - (r.width * k - cur.w) / 2) / cur.w;
    const fy = ((e.clientY - r.top) * k - (r.height * k - cur.h) / 2) / cur.h;
    zoomBy(e.deltaY > 0 ? 1.12 : 1 / 1.12, fx, fy);
  }, { passive: false });

  // touch: pinch-zoom + one-finger pan (iOS / mobile)
  let lastTouchDist = 0;
  let lastTouchMidX = 0;
  let lastTouchMidY = 0;
  let lastTouchX = 0;
  let lastTouchY = 0;

  stage.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      lastTouchX = e.touches[0].clientX;
      lastTouchY = e.touches[0].clientY;
      lastTouchDist = 0;
    } else if (e.touches.length >= 2) {
      const t1 = e.touches[0], t2 = e.touches[1];
      lastTouchDist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
      lastTouchMidX = (t1.clientX + t2.clientX) / 2;
      lastTouchMidY = (t1.clientY + t2.clientY) / 2;
    }
  }, { passive: false });

  stage.addEventListener('touchmove', (e) => {
    e.preventDefault();
    touched = true;

    if (e.touches.length >= 2) {
      const t1 = e.touches[0], t2 = e.touches[1];
      const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
      const midX = (t1.clientX + t2.clientX) / 2;
      const midY = (t1.clientY + t2.clientY) / 2;

      if (lastTouchDist > 0 && dist > 0) {
        const factor = lastTouchDist / dist;
        const r = stage.getBoundingClientRect();
        const k = Math.max(cur.w / (r.width || 1), cur.h / (r.height || 1));
        const fx = Math.max(0, Math.min(1, ((midX - r.left) * k - (r.width * k - cur.w) / 2) / cur.w));
        const fy = Math.max(0, Math.min(1, ((midY - r.top) * k - (r.height * k - cur.h) / 2) / cur.h));

        zoomBy(factor, fx, fy);        // around the touch centre
        const dx = (lastTouchMidX - midX) * k;  // pan with the midpoint
        const dy = (lastTouchMidY - midY) * k;
        cur.x += dx;
        cur.y += dy;
        apply();
      }

      lastTouchDist = dist;
      lastTouchMidX = midX;
      lastTouchMidY = midY;
    } else if (e.touches.length === 1) {
      const t = e.touches[0];
      const r = stage.getBoundingClientRect();
      const k = Math.max(cur.w / (r.width || 1), cur.h / (r.height || 1));
      const dx = (lastTouchX - t.clientX) * k;
      const dy = (lastTouchY - t.clientY) * k;

      cur.x += dx;
      cur.y += dy;
      apply();

      lastTouchX = t.clientX;
      lastTouchY = t.clientY;
      lastTouchDist = 0;
    }
  }, { passive: false });

  const onTouchEnd = (e) => {
    if (e.touches.length === 1) {
      lastTouchX = e.touches[0].clientX;
      lastTouchY = e.touches[0].clientY;
      lastTouchDist = 0;
    } else if (e.touches.length === 0) {
      lastTouchDist = 0;
    }
  };
  stage.addEventListener('touchend', onTouchEnd, { passive: false });
  stage.addEventListener('touchcancel', onTouchEnd, { passive: false });

  // mouse drag to pan (desktop)
  let mouseDrag = null;
  stage.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    mouseDrag = { x: e.clientX, y: e.clientY, vx: cur.x, vy: cur.y };
    stage.classList.add('grabbing');
  });
  window.addEventListener('mousemove', (e) => {
    if (!mouseDrag) return;
    touched = true;
    const r = stage.getBoundingClientRect();
    const k = Math.max(cur.w / (r.width || 1), cur.h / (r.height || 1));
    cur.x = mouseDrag.vx - (e.clientX - mouseDrag.x) * k;
    cur.y = mouseDrag.vy - (e.clientY - mouseDrag.y) * k;
    apply();
  });
  window.addEventListener('mouseup', () => {
    if (mouseDrag) {
      mouseDrag = null;
      stage.classList.remove('grabbing');
    }
  });

  // on-screen zoom controls, mirroring the F-keys
  const controls = document.createElement('div');
  controls.className = 'wiring-zoom';
  [[classic ? '⊕' : '+', 'Zoom in (+ key, or scroll the wheel)', () => zoomBy(1 / 1.3)],
   [classic ? '⊖' : '−', 'Zoom out (- key)', () => zoomBy(1.3)],
   [classic ? '⊡' : 'Fit', 'Fit the whole diagram (0 key)', fit]]
    .forEach(([label, title, fn]) => {
    const b = document.createElement('button');
    b.className = classic ? 'wds-btn wds-btn-sq' : 'btn wiring-fit';
    b.textContent = label;
    b.title = title;
    b.onclick = fn;
    controls.appendChild(b);
  });
  if (classic) bar.innerHTML = '';
  bar.appendChild(controls);
  if (typeof tipify === 'function') tipify(controls);

  let last = '';
  const ro = new ResizeObserver(() => {
    const r = stage.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const sig = `${Math.round(r.width)}x${Math.round(r.height)}`;
    if (sig === last) return;
    last = sig;
    if (!touched) fit();
  });
  ro.observe(stage);

  return { by: zoomBy, fit };
}

// Print the DOCUMENT, not the app around it (the print stylesheet hides the
// chrome; this adds the caption header). The zoomed viewBox is NOT printed: a
// printout wants the whole circuit, so the full drawing is restored then put
// back after.
function printWiring(chassisId) {
  const stage = document.querySelector('.wiring-stage');
  const svg = stage && stage.querySelector('svg');
  const title = document.querySelector('.wiring-title');
  const kind = document.querySelector('.wiring-kind');
  if (!title) { triggerPrint(); return; }   // a description prints as it is

  const head = document.createElement('div');
  head.className = 'print-head';
  head.innerHTML = `
    <div class="print-title">${esc(title.textContent)}</div>
    <div class="print-meta">
      <span>${esc(dispChassis(chassisId))}</span>
      <span>${esc((kind && kind.textContent) || 'Wiring diagram')}</span>
      <span>BMW WDS · printed ${new Date().toLocaleDateString()}</span>
    </div>`;
  document.body.appendChild(head);

  // show the whole drawing, not the part currently zoomed to
  const zoomed = svg && svg.getAttribute('viewBox');
  if (svg && svg.dataset.homeViewbox) {
    svg.setAttribute('viewBox', svg.dataset.homeViewbox);
  }
  // Clean up ONCE, whichever route gets there first (promise, afterprint, or
  // the timer for a WKWebView that fires neither). Removing the header mid-print
  // would corrupt the page.
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    head.remove();
    if (svg && zoomed) svg.setAttribute('viewBox', zoomed);
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  triggerPrint().then(cleanup, cleanup);
  setTimeout(cleanup, 20000);   // last resort if nothing ever settles
}

// GOTCHA: window.print() is a no-op inside a WKWebView (no dialog behind it), so
// the Mac app runs an NSPrintOperation over the live view; the browser build's
// dialog is real. The promise resolves when the panel closes.
function triggerPrint() {
  if (window.bmacw && typeof window.bmacw.printPage === 'function') {
    return window.bmacw.printPage().catch(() => {});
  }
  window.print();          // browser build: the dialog is real
  return Promise.resolve();
}

// WDS's own Help page, with our controls (a wheel and a drag, not Strg+click).
function showWiringHelp(chassisId) {
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: 'Wiring', fn: showWiringChassis },
    { label: dispChassis(chassisId), fn: () => showWiring(chassisId) },
    { label: 'Help' },
  ]);
  view.innerHTML = head('WDS', 'Operation and navigation', '');
  const art = document.createElement('article');
  art.className = 'wiring-doc wds-help-doc';
  art.innerHTML = `
    <h2>Navigation</h2>
    <ul>
      <li>Click a folder in the tree to open it, click again to close it.</li>
      <li><strong>New</strong> clears the search and returns to the full tree.</li>
      <li><strong>&lt;&lt;</strong> and <strong>&gt;&gt;</strong> step through the
          documents in tree order.</li>
    </ul>
    <h2>Search</h2>
    <ul>
      <li>Type in the field at the bottom left; results replace the tree as
          you type, and <strong>Search</strong> repeats the current word.</li>
      <li>Every document title in this vehicle is searched at once.</li>
    </ul>
    <h2>Zooming and moving a diagram</h2>
    <ul>
      <li>Scroll the wheel over a diagram to zoom about the pointer.</li>
      <li>Drag with the mouse to move it.</li>
      <li>The footer buttons and the keys <strong>+</strong>,
          <strong>-</strong> and <strong>0</strong> (fit) do the same.</li>
      <li>Diagrams are vector, so they stay sharp at any magnification.</li>
    </ul>
    <h2>What the marks in the tree mean</h2>
    <ul>
      <li><span class="wiring-dot" style="background:var(--amber)"></span>
          wiring diagram &nbsp;
          <span class="wiring-dot" style="background:var(--green)"></span>
          component location &nbsp;
          <span class="wiring-dot" style="background:#6ab0ff"></span>
          connector view</li>
      <li><span class="wiring-dot" style="background:#b98cff;border-radius:50%"></span>
          pin assignment &nbsp;
          <span class="wiring-dot" style="background:#ffd166;border-radius:50%"></span>
          specification values &nbsp;
          <span class="wiring-dot" style="background:var(--red)"></span>
          test procedure</li>
    </ul>
    <p>The diagrams, their titles and their arrangement are BMW's own, taken
       from WDS. Printing uses the browser's print dialog.</p>`;
  view.appendChild(art);
  setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
                fn: () => showWiring(chassisId) }]);
}

// Does this car have wiring data? Asked before drawing a button that'd fail.
async function hasWiring(chassisId) {
  const id = chassisId.toUpperCase();
  if (WIRING_CACHE.has(id)) return true;
  if (typeof BMACW_WIRING === 'object' && BMACW_WIRING) return !!BMACW_WIRING[id];
  try {
    const base = (typeof WEB_BASE === 'string') ? WEB_BASE : '';
    const real = (typeof webRealFetch === 'function')
      ? webRealFetch : window.fetch.bind(window);
    const r = await real(`${base}/data/wiring/${id}.wiring`, { method: 'HEAD' });
    return r.ok;
  } catch { return false; }
}
