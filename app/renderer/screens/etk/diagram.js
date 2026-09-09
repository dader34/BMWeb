/**
 * @file A main group opened: the wiring-style split -- its function-group
 * tree of diagrams on the left, the selected diagram (exploded view + parts
 * table) on the right, all honouring the active variant filter, plus the
 * printable sheet of one diagram.
 */

/* exported showEtkGroup */

/** The media query below which the tree and the diagram are exclusive panes. */
const ETK_PHONE_QUERY = '(max-width: 760px)';

/** Exploded views narrower than this are upscaled so their callouts stay legible. */
const ETK_IMG_SMALL_PX = 500;

/** How much a small exploded view is upscaled by. */
const ETK_IMG_UPSCALE = 2;

/** Widest an upscaled exploded view may become. */
const ETK_IMG_MAX_PX = 700;

/**
 * The parts that fit the active variant (parts with no fit data always show).
 * @param {EtkPart[]} parts - a diagram's parts
 * @returns {EtkPart[]}
 */
function etkFitParts(parts) {
  return parts.filter(
    (p) =>
      ETK_STATE.variant == null || !p.fit || p.fit.includes(ETK_STATE.variant)
  );
}

/**
 * One collapsible function group in the tree: a header with the diagram
 * count, then a leaf per diagram.
 * @param {EtkGroup} g - the function group
 * @param {(leaf: HTMLButtonElement, d: EtkDiagram) => void} onLeaf - a leaf was clicked
 * @returns {HTMLDivElement}
 */
function etkTreeGroup(g, onLeaf) {
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
                        <span class="etk-lcount">${etkFitParts(d.parts).length}</span>`;
    leaf._btnr = d.btnr;
    leaf.onclick = () => onLeaf(leaf, d);
    kids.appendChild(leaf);
  });
  grp.appendChild(hdr);
  grp.appendChild(kids);
  return grp;
}

/**
 * Show one main group: the diagram tree beside the open diagram.
 * @param {EtkBundle} data - the loaded archive
 * @param {string} chassisId - chassis code, any case
 * @param {EtkMainGroup} mg - the main group to open
 * @param {string|null} [openBtnr] - a diagram to open (deep link), else the first
 * @returns {void}
 */
function showEtkGroup(data, chassisId, mg, openBtnr = null) {
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
  // wds-nofkeys hides the F-key bar; apps-section reveals the topbar Back button
  // (the ETK diagram screen has no toolbar Back of its own, unlike the WDS
  // viewer -- so it needs the topbar one).
  document.body.classList.add('wds-nofkeys');
  document.body.classList.add('apps-section');

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
  // On a phone the panes are exclusive, WDS-style: the tree OR the diagram,
  // never both squeezed side by side. data-pane drives the CSS; desktop
  // ignores it (the rules live in the mobile media block).
  const bodyEl = split.querySelector('.etk-body');
  const phone = () => window.matchMedia(ETK_PHONE_QUERY).matches;
  bodyEl.dataset.pane = 'tree';

  let selectedLeaf = null;
  let shownDiagram = null; // the diagram currently on screen
  const onLeaf = (leaf, d) => {
    if (selectedLeaf) selectedLeaf.classList.remove('active');
    leaf.classList.add('active');
    selectedLeaf = leaf;
    shownDiagram = d; // remember it for Print
    renderDiagram(data, id, d, viewEl);
    if (phone()) bodyEl.dataset.pane = 'doc';
    // reflect the open diagram in the URL so it's a shareable deep link
    if (typeof routeSetEtkDiagram === 'function') {
      routeSetEtkDiagram(id, mg.hg, d.btnr);
    }
  };
  mg.groups.forEach((g) => treeEl.appendChild(etkTreeGroup(g, onLeaf)));

  // open the requested diagram (deep link), else the first so the pane isn't
  // empty. A deep-linked leaf may sit in a collapsed group -- open it first.
  let target = null;
  if (openBtnr) {
    target = [...treeEl.querySelectorAll('.etk-tleaf')].find(
      (l) => l._btnr === openBtnr
    );
    if (target) {
      const kids = target.closest('.etk-tkids');
      if (kids && kids.style.display === 'none') {
        const hdr = kids.previousElementSibling;
        if (hdr) hdr.click(); // expand the group
      }
      target.scrollIntoView({ block: 'center' });
    }
  }
  (target || treeEl.querySelector('.etk-tleaf'))?.click();
  // the auto-opened FIRST diagram must not steal the screen on a phone --
  // land on the tree so the group is navigable. A deep-linked diagram was
  // asked for by name, so that one does take the screen.
  if (!openBtnr) bodyEl.dataset.pane = 'tree';

  sbLeft.textContent = mg.name;
  // a back action so the mobile top-left chevron appears (and Esc works),
  // returning to this chassis's main-group grid. On a phone, Back from a
  // DIAGRAM returns to the tree first (panes are exclusive there, so leaving
  // outright would skip a level -- same rule as the WDS viewer). Print emits
  // a clean, theme-agnostic sheet of the diagram currently open.
  const leaveGroup = () => {
    if (phone() && bodyEl.dataset.pane === 'doc') {
      bodyEl.dataset.pane = 'tree';
      return;
    }
    showEtkChassis(id);
  };
  setActions([
    etkBackAction(leaveGroup),
    {
      key: 'p',
      keyLabel: 'P',
      label: 'Print',
      fn: () => {
        if (shownDiagram) printEtkDiagram(data, id, mg, shownDiagram);
      },
    },
  ]);
}

/**
 * A single diagram as a clean printout: exploded-view image on top, the
 * numbered parts list below (filtered to the active variant, same as on screen).
 * @param {EtkBundle} data - the loaded archive
 * @param {string} chassisId - chassis code
 * @param {EtkMainGroup} mg - the main group the diagram belongs to
 * @param {EtkDiagram} d - the diagram
 * @returns {void}
 */
function printEtkDiagram(data, chassisId, mg, d) {
  const parts = etkFitParts(d.parts);
  const rows = parts.map((p) => [p.pos, fmtSachnr(p.sachnr, p.pre), p.name]);
  const veh = ETK_STATE.variantLabel || dispChassis(chassisId);
  printDoc({
    title: d.name,
    subtitle: veh,
    meta: [
      ['Main group', `${mg.hg} ${mg.name}`],
      ['Parts', String(parts.length)],
    ],
    sections: [
      printImage(etkImageUrl(data, d.img), d.name),
      printTable(['No.', 'Part number', 'Description'], rows, [
        'pr-num',
        'pr-mono',
        '',
      ]),
    ],
    footer: `${APP_NAME} · BMW ETK · ${dispChassis(chassisId)} · printed ${new Date().toLocaleDateString()}`,
  });
}

/**
 * Render one diagram into the right pane: exploded-view image on top, its
 * numbered parts list below, filtered to the chosen variant.
 * @param {EtkBundle} data - the loaded archive
 * @param {string} chassisId - chassis code (unused today; kept so callers match the print path)
 * @param {EtkDiagram} d - the diagram
 * @param {HTMLElement} viewEl - the pane to draw into
 * @returns {void}
 */
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
      if (w && w < ETK_IMG_SMALL_PX)
        img.style.width = Math.min(w * ETK_IMG_UPSCALE, ETK_IMG_MAX_PX) + 'px';
    };
    img.src = url;
    img.title = 'Click to enlarge';
    fig.appendChild(img);
    const hint = document.createElement('span');
    hint.className = 'etk-figure-hint';
    hint.textContent = '⌕ enlarge';
    fig.appendChild(hint);
    fig.onclick = () => etkOpenLightbox(url, d.name);
    wrap.appendChild(fig);
  }

  const parts = etkFitParts(d.parts);

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
  sbRight.textContent =
    `${parts.length} part${parts.length === 1 ? '' : 's'}` +
    (filtered ? ` (of ${d.parts.length})` : '');
}

/** How much the loupe magnifies the scan. */
const ETK_LOUPE_ZOOM = 2.5;

/** The loupe's diameter, px. */
const ETK_LOUPE_PX = 220;

/**
 * The enlarged view: the scan as big as the window allows on a white plate,
 * with a round magnifier that follows the pointer over it. Esc, the ×, or a
 * click on the backdrop closes it.
 * @param {string} url - the image URL (a blob URL from the archive)
 * @param {string} name - the diagram's name, for the caption
 * @returns {void}
 */
function etkOpenLightbox(url, name) {
  if (typeof openModal !== 'function') return;
  const m = openModal(
    `<div class="etk-lightbox">
       <div class="etk-lightbox-head">
         <span class="etk-lightbox-title">${esc(name)}</span>
         <span class="etk-lightbox-hint">Move over the drawing to magnify</span>
         <button type="button" class="etk-lightbox-close" aria-label="Close">×</button>
       </div>
       <div class="etk-lightbox-plate">
         <img class="etk-lightbox-img" alt="${esc(name)}" src="${esc(url)}" />
         <div class="etk-loupe" hidden></div>
       </div>
     </div>`
  );
  const box = m.overlay.querySelector('.etk-lightbox');
  const img = box.querySelector('.etk-lightbox-img');
  const loupe = box.querySelector('.etk-loupe');
  box.querySelector('.etk-lightbox-close').onclick = () => m.close();
  loupe.style.width = loupe.style.height = ETK_LOUPE_PX + 'px';
  loupe.style.backgroundImage = `url("${url}")`;
  const plate = box.querySelector('.etk-lightbox-plate');
  img.onpointermove = (ev) => {
    const r = img.getBoundingClientRect();
    const pr = plate.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const fx = (ev.clientX - r.left) / r.width;
    const fy = (ev.clientY - r.top) / r.height;
    const bw = r.width * ETK_LOUPE_ZOOM;
    const bh = r.height * ETK_LOUPE_ZOOM;
    loupe.hidden = false;
    // the loupe sits in the plate, so it is placed against the plate's box
    loupe.style.left = ev.clientX - pr.left - ETK_LOUPE_PX / 2 + 'px';
    loupe.style.top = ev.clientY - pr.top - ETK_LOUPE_PX / 2 + 'px';
    loupe.style.backgroundSize = `${bw}px ${bh}px`;
    loupe.style.backgroundPosition = `${ETK_LOUPE_PX / 2 - fx * bw}px ${ETK_LOUPE_PX / 2 - fy * bh}px`;
  };
  img.onpointerleave = () => {
    loupe.hidden = true;
  };
}
