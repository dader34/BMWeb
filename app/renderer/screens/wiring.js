// Wiring diagrams, from BMW's own WDS.
//
// tools/wds_import.py packs one .wiring archive per car: BMW's document tree
// plus the documents it references -- schematics as .svgz (gzipped SVG) and
// functional descriptions as HTML. Both come straight out of WDS, so a
// diagram here is the diagram the dealer traced circuits on.
//
// SVG, NOT IMAGES. The schematics are vector: they zoom without pixelating,
// their text is real text, and the browser draws them with no viewer
// library. Inflating is fflate, already shipped for the chassis archives.

const WIRING_CACHE = new Map();   // chassis -> { tree, files: Map(name -> u8) }

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
  // the offline export inlines archives as base64; use that when present,
  // exactly like the chassis loader does
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

// A document, ready to put on screen. Schematics inflate to SVG source;
// descriptions are already HTML.
function wiringDoc(data, docId) {
  const svgz = data.files.get(`svg/${docId}.svgz`);
  if (svgz) {
    return { type: 'svg', text: fflate.strFromU8(fflate.gunzipSync(svgz)) };
  }
  const html = data.files.get(`doc/${docId}.html`);
  if (html) return { type: 'html', text: fflate.strFromU8(html) };
  return null;
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

// Which cars WDS covers. Asked once and remembered: the picker draws only
// what can actually open, rather than offering dead cards.
let WIRING_CHASSIS = null;

async function wiringChassisList() {
  if (WIRING_CHASSIS) return WIRING_CHASSIS;
  const ids = await api('/api/chassis').catch(() => []);
  const found = [];
  for (const id of ids) {
    if (await hasWiring(id)) found.push(id);
  }
  WIRING_CHASSIS = found;
  return found;
}

// Wiring as its own section, like Fault Lookup: pick the car here rather
// than arriving through a chassis.
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
  view.appendChild(grid);

  const ids = await wiringChassisList();
  if (!ids.length) {
    view.innerHTML += errorBlock('No wiring data is shipped in this build. '
      + 'Build it with tools/wds_import.py from a WDS release.');
    return;
  }
  ids.forEach((id, i) => {
    const tag = (typeof CHASSIS_TAG === 'object' && CHASSIS_TAG[id]) || 'BMW';
    const card = document.createElement('button');
    if (classic) {
      // the vehicle select's own idiom: an F-key list, not cards
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
  // No page heading here: a schematic wants every pixel of height, and the
  // crumbs already say where you are. The browse screens keep theirs.
  view.innerHTML = '';

  const split = document.createElement('div');
  split.className = 'split wiring-split';
  split.innerHTML = `
    <nav class="split-nav wiring-nav">
      <input class="wiring-search" id="wiring-search" type="search"
             placeholder="Search diagrams…" autocomplete="off">
      <div class="wiring-tree" id="wiring-tree"></div>
    </nav>
    <div class="split-content wiring-view" id="wiring-view"></div>`;
  view.appendChild(split);

  const treeEl = split.querySelector('#wiring-tree');
  const viewEl = split.querySelector('#wiring-view');
  const searchEl = split.querySelector('#wiring-search');

  // the bar while nothing is open; a diagram replaces it with its zoom keys
  const browseActions = [{ key: 'Escape', keyLabel: 'Esc', label: 'Back',
                           kind: 'back', fn: showWiringChassis }];
  setActions(browseActions);

  loadWiring(chassisId).then((data) => {
    const index = wiringIndex(data.tree);
    sbLeft.textContent = 'wiring';
    sbRight.textContent = `${index.length} documents`;

    // ---- the tree: folders collapse, leaves open
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
        } else {
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
        }
      }
    };
    renderTree(data.tree, treeEl, 0);

    // ---- search: flat results across the whole car, tree hidden while typing
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

    // ---- the document pane
    function openDocument(entry) {
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

      // a schematic: drop the SVG in and let it fill the pane, then pan/zoom
      const stage = document.createElement('div');
      stage.className = 'wiring-stage';
      stage.innerHTML = doc.text;
      viewEl.appendChild(stage);
      const svg = stage.querySelector('svg');
      if (svg) {
        const zoom = fitAndPan(svg, stage, bar);
        // INPA's own idiom: the bar carries what the screen can do. A
        // diagram can zoom, so the keys are there rather than only on a
        // wheel a trackpad-less machine may not have.
        setActions([
          { key: '+', keyLabel: '+', label: 'Zoom in', fn: () => zoom.by(1 / 1.3) },
          { key: '-', keyLabel: '-', label: 'Zoom out', fn: () => zoom.by(1.3) },
          { key: '0', keyLabel: '0', label: 'Fit', fn: () => zoom.fit() },
          { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
            fn: showWiringChassis },
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

// Zoom and pan by rewriting the viewBox: the SVG stays vector at every
// scale, and nothing re-renders but the attribute.
function fitAndPan(svg, stage, bar) {
  const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  if (vb.length !== 4 || vb.some(Number.isNaN)) return null;
  const home = { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };
  const cur = { ...home };
  const apply = () => svg.setAttribute('viewBox',
    `${cur.x} ${cur.y} ${cur.w} ${cur.h}`);
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  // fill the pane rather than preserving the drawing's own letterboxing
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  // One zoom step. fx/fy is the fixed point in 0..1 of the pane: the
  // pointer for a wheel, the centre for a key, so what you are looking at
  // stays where it is either way.
  const zoomBy = (k, fx = 0.5, fy = 0.5) => {
    const w = Math.min(home.w * 4, Math.max(home.w / 60, cur.w * k));
    const h = w * (cur.h / cur.w);
    cur.x += (cur.w - w) * fx;
    cur.y += (cur.h - h) * fy;
    cur.w = w; cur.h = h;
    apply();
  };
  // FILL THE PANE, not the document's own aspect. BMW drew these very wide
  // (14000 x 2400 is common); dropping that box into a squarer pane letterboxes
  // it and wastes most of the screen. Widen or heighten the box to the pane's
  // ratio instead, keeping the drawing centred, so "Fit" means the diagram is
  // as large as it can be here.
  const fit = () => {
    const r = stage.getBoundingClientRect();
    const paneRatio = (r.width || 1) / (r.height || 1);
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
    // Where the pointer sits IN THE VIEWBOX, as a fraction of it. With the
    // letterboxing above that is not its fraction of the pane: the pane
    // shows k*width user units, of which the viewBox is only cur.w, centred.
    const k = Math.max(cur.w / r.width, cur.h / r.height);
    const fx = ((e.clientX - r.left) * k - (r.width * k - cur.w) / 2) / cur.w;
    const fy = ((e.clientY - r.top) * k - (r.height * k - cur.h) / 2) / cur.h;
    zoomBy(e.deltaY > 0 ? 1.12 : 1 / 1.12, fx, fy);
  }, { passive: false });

  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, vx: cur.x, vy: cur.y };
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('grabbing');
  });
  // ONE scale for both axes. preserveAspectRatio="meet" fits the viewBox
  // inside the pane at a single factor and letterboxes the remainder, so a
  // pixel is the same number of user units horizontally and vertically.
  // Dividing each axis by its own pane dimension assumed a stretch that does
  // not happen, and on BMW's very wide diagrams that made a left/right drag
  // crawl while up/down felt right.
  const unitsPerPixel = (r) => Math.max(cur.w / r.width, cur.h / r.height);
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const k = unitsPerPixel(stage.getBoundingClientRect());
    cur.x = drag.vx - (e.clientX - drag.x) * k;
    cur.y = drag.vy - (e.clientY - drag.y) * k;
    apply();
  });
  const end = () => { drag = null; stage.classList.remove('grabbing'); };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);

  // on-screen zoom controls, mirroring the F-keys
  const controls = document.createElement('div');
  controls.className = 'wiring-zoom';
  [['−', 'Zoom out', () => zoomBy(1.3)],
   ['+', 'Zoom in', () => zoomBy(1 / 1.3)],
   ['Fit', 'Fit to pane', fit]].forEach(([label, title, fn]) => {
    const b = document.createElement('button');
    b.className = 'btn wiring-fit';
    b.textContent = label;
    b.title = title;
    b.onclick = fn;
    controls.appendChild(b);
  });
  bar.appendChild(controls);

  return { by: zoomBy, fit };
}

// Does this car have wiring data? Cheap enough to ask before drawing a
// button that would only fail.
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
