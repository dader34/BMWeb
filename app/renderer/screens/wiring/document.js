/**
 * @file The document pane: draws whatever a tab holds into the view -- a WDS
 * schematic (SVG, zoomable), a WDS description (HTML with archive photos and
 * cross-links), an ISTA reference document (typed blocks), a glossary entry
 * (a reference designation with the diagrams that mention it), or the empty
 * placeholder.
 */

/* exported
   wiringRenderEntry, wiringRenderPlaceholder */

/** Below this width the panes are exclusive: one of tree / document shows. */
const WIRING_PHONE_QUERY = '(max-width: 760px)';

/**
 * Is the layout in its one-pane-at-a-time (phone) form?
 * @returns {boolean}
 */
function wiringIsPhone() {
  return window.matchMedia(WIRING_PHONE_QUERY).matches;
}

/**
 * The live state of one open wiring view, shared by the pane renderers, the
 * tree and the screen that mounts them.
 * @typedef {Object} WiringViewCtx
 * @property {string} chassisId - chassis code
 * @property {boolean} classic - INPA mode (WDS chrome)
 * @property {HTMLElement} split - the whole frame
 * @property {HTMLElement} body - the .wiring-body holding both panes
 * @property {HTMLElement} treeEl - the tree pane
 * @property {HTMLElement} viewEl - the document pane
 * @property {HTMLInputElement} searchEl - the search box
 * @property {HTMLElement | null} catHost - the category tab strip (modern layout only)
 * @property {(mode: 'tree' | 'split' | 'doc', remember?: boolean) => void} setPane - show a pane
 * @property {() => void} leaveWiring - Back: the tree on a phone, else the picker
 * @property {Array<Object>} browseActions - the F-key set while browsing
 * @property {WiringArchive} data - the loaded .wiring archive
 * @property {WiringIndexEntry[]} index - the flat WDS index, in tree order
 * @property {WiringTabStrip} tabs - the open-document tabs
 * @property {DocsArchive | null} docsData - the .docs archive, once a document category needs it
 * @property {WiringCategory} cat - the category the tree shows
 * @property {number} atIndex - position of the open WDS document in `index`, for prev/next
 * @property {() => void} refreshCount - keep the doc count faithful to the filter
 */

/**
 * The bar above a document: its title and kind.
 * @param {string} title - document title
 * @param {string} kind - what sort of document it is
 * @returns {HTMLDivElement}
 */
function wiringDocBar(title, kind) {
  const bar = document.createElement('div');
  bar.className = 'wiring-bar';
  bar.innerHTML =
    `<div class="wiring-title">${esc(title)}</div>` +
    `<div class="wiring-kind">${esc(kind)}</div>`;
  return bar;
}

/**
 * Draw a tab's document into the view pane. A glossary leaf has no doc id --
 * route it to the glossary viewer; an ISTA document is keyed "d:<id>".
 * @param {WiringViewCtx} ctx - the open view
 * @param {WiringTabEntry} entry - what the tab holds
 * @returns {void}
 */
function wiringRenderEntry(ctx, entry) {
  if (entry.isDoc || (entry.doc && String(entry.doc).startsWith('d:')))
    wiringRenderIstaDoc(ctx, entry);
  else if (!entry.doc) wiringRenderGlossary(ctx, entry);
  else wiringRenderDocument(ctx, entry);
}

/**
 * The empty state: the document count and a hint.
 * @param {WiringViewCtx} ctx - the open view
 * @returns {void}
 */
function wiringRenderPlaceholder(ctx) {
  ctx.viewEl.innerHTML =
    `<div class="empty"><div>` +
    `<strong class="wiring-emptycount">${ctx.index.length} documents</strong></div>` +
    `<div>Pick a diagram on the left, or search. Open documents stack as ` +
    `tabs above. Diagrams are vector: scroll to zoom, drag to pan.</div></div>`;
  setActions(ctx.browseActions);
  ctx.refreshCount();
}

/**
 * Render an ISTA reference document (Components/Repair) into the view pane,
 * reusing the fault-modal typography. The .docs archive loads here on first
 * use when a deep link arrives before the document tree did.
 * @param {WiringViewCtx} ctx - the open view
 * @param {WiringTabEntry} entry - the document's tab entry
 * @returns {Promise<void>}
 */
async function wiringRenderIstaDoc(ctx, entry) {
  const id = entry.docId || String(entry.doc).replace(/^d:/, '');
  if (wiringIsPhone()) ctx.setPane('doc', false);
  if (typeof routeSetDocsDoc === 'function') routeSetDocsDoc(ctx.chassisId, id);
  const viewEl = ctx.viewEl;
  viewEl.innerHTML = '';
  const bar = wiringDocBar(entry.name, docsTypeLabel(entry.kind) || 'Document');
  bar.appendChild(wiringShareButton(false));
  viewEl.appendChild(bar);
  setActions(ctx.browseActions);
  if (!ctx.docsData) {
    try {
      ctx.docsData = await loadDocs(ctx.chassisId);
    } catch (e) {
      ctx.docsData = null;
    }
  }
  const doc = ctx.docsData ? docsDoc(ctx.docsData, id) : null;
  if (!doc || !doc.chapters || !doc.chapters.length) {
    viewEl.insertAdjacentHTML(
      'beforeend',
      `<div class="empty"><div>This document has no readable content.</div></div>`
    );
    return;
  }
  const art = document.createElement('article');
  art.className = 'wiring-doc fm-tp-body docs-doc';
  art.innerHTML = doc.chapters.map(docsChapterHtml).join('');
  viewEl.appendChild(art);
  viewEl.scrollTop = 0;
  sbLeft.textContent = entry.name;
}

/**
 * The "referenced in" list of a glossary entry: every diagram whose title
 * carries the designation, or a hint to search when none does.
 * @param {WiringIndexEntry[]} related - diagrams mentioning the code
 * @param {string} code - the reference designation
 * @returns {string}
 */
function wiringGlossaryRelatedHtml(related, code) {
  if (related.length > 0) {
    return `
          <div style="margin-top: 20px;">
            <h2 style="font-size: 14px; font-weight: 700; color: var(--amber); margin: 0 0 10px; text-transform: uppercase; letter-spacing: 0.5px;">
              Referenced in ${related.length} Diagram${related.length === 1 ? '' : 's'}
            </h2>
            <div style="display: flex; flex-direction: column; gap: 6px;">
              ${related
                .map(
                  (r) => `
                <div class="setting-row" style="cursor: pointer; padding: 10px 14px; border-radius: 6px; background: var(--panel-2); border: 1px solid var(--line);" data-doc="${esc(r.doc)}">
                  <div>
                    <div style="font-weight: 700; font-size: 13.5px; color: var(--ink);">${esc(r.name)}</div>
                    <div style="font-size: 11px; color: var(--ink-dim); margin-top: 2px;">${esc(r.trail.slice(-2).join(' › '))}</div>
                  </div>
                  <span style="color: var(--amber); font-size: 12px; font-weight: 700; white-space: nowrap;">View →</span>
                </div>
              `
                )
                .join('')}
            </div>
          </div>`;
  }
  return `
          <div style="margin-top: 20px; padding: 14px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 6px;">
            <div style="font-size: 13px; color: var(--ink-dim);">
              Use the search bar at the top to search across all vehicle schematics for <strong>${esc(code)}</strong>.
            </div>
          </div>`;
}

/**
 * The glossary / signal definition viewer: the designation, its meaning, and
 * the diagrams it appears in.
 * @param {WiringViewCtx} ctx - the open view
 * @param {WiringTabEntry} entry - the glossary leaf
 * @returns {void}
 */
function wiringRenderGlossary(ctx, entry) {
  if (wiringIsPhone()) ctx.setPane('doc', false);
  const viewEl = ctx.viewEl;
  viewEl.innerHTML = '';
  viewEl.appendChild(
    wiringDocBar(entry.name, 'Signal / Component Information')
  );

  const parts = entry.name.split(/\s+/);
  const code = parts[0] || entry.name;
  const desc = parts.slice(1).join(' ') || entry.name;

  const codeLower = code.toLowerCase();
  const related = ctx.index
    .filter((e) => e.name.toLowerCase().includes(codeLower))
    .slice(0, 40);

  const art = document.createElement('article');
  art.className = 'wiring-doc';
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
        ${wiringGlossaryRelatedHtml(related, code)}
      `;

  art.querySelectorAll('[data-doc]').forEach((el) => {
    el.onclick = () => {
      const did = el.getAttribute('data-doc');
      const hit = ctx.index.find((e) => e.doc === did);
      if (hit) ctx.tabs.openTab(hit);
    };
  });

  viewEl.appendChild(art);
  viewEl.scrollTop = 0;
  setActions(ctx.browseActions);
}

/**
 * Hand a description's pictures their bytes. Pictures live in the archive,
 * not on a server, so an <img src> of "img/x.png" resolves to nothing; one
 * not in this archive comes from the CDN the hosted build keeps them on, and
 * a picture that is gone is removed (a box helps nobody).
 * @param {HTMLElement} art - the rendered description
 * @param {WiringArchive} data - the archive
 * @returns {void}
 */
function wiringResolveImages(art, data) {
  art.querySelectorAll('img[src^="img/"]').forEach((im) => {
    const path = im.getAttribute('src');
    const bytes = data.files.get(path);
    if (bytes) {
      im.src = wiringImageUrl(data, path, bytes);
      return;
    }
    im.classList.add('wiring-img-loading');
    wiringFetchImage(path.slice(4)).then((blob) => {
      im.classList.remove('wiring-img-loading');
      if (!blob) {
        im.remove();
        return;
      }
      im.src = wiringImageUrl(data, path, blob);
    });
  });
}

/**
 * Cross-document links resolve inside the app, never the network: an
 * "#wds/<DOC>" href opens that document as a tab.
 * @param {HTMLElement} art - the rendered description
 * @param {WiringViewCtx} ctx - the open view
 * @returns {void}
 */
function wiringBindCrossLinks(art, ctx) {
  art.querySelectorAll('a[href^="#wds/"]').forEach((a) => {
    const target = a.getAttribute('href').slice(5);
    a.onclick = (ev) => {
      ev.preventDefault();
      const hit = ctx.index.find((e) => e.doc === target);
      ctx.tabs.openTab(hit || { name: target, kind: 'document', doc: target });
    };
  });
}

/**
 * The F-keys while a schematic is up: zoom in/out/fit, plus Print and Back
 * again -- this list replaces browseActions, and Cmd/Ctrl+P and the mobile
 * ƒ sheet read THIS list.
 * @param {WiringViewCtx} ctx - the open view
 * @param {WiringPanZoom} zoom - the schematic's camera
 * @returns {Array<Object>}
 */
function wiringSchematicActions(ctx, zoom) {
  return [
    {
      key: '+',
      keyLabel: '+',
      label: 'Zoom in',
      fn: () => zoom.by(1 / WIRING_ZOOM_STEP),
    },
    {
      key: '-',
      keyLabel: '-',
      label: 'Zoom out',
      fn: () => zoom.by(WIRING_ZOOM_STEP),
    },
    { key: '0', keyLabel: '0', label: 'Fit', fn: () => zoom.fit() },
    {
      key: 'p',
      keyLabel: 'P',
      label: 'Print',
      kind: 'print',
      fn: () => printWiring(ctx.chassisId),
    },
    // leaveWiring, not showWiringChassis: on a phone back from a diagram
    // returns to the tree first (identical on desktop)
    {
      key: 'Escape',
      keyLabel: 'Esc',
      label: 'Back',
      kind: 'back',
      fn: ctx.leaveWiring,
    },
  ];
}

/**
 * A WDS description: HTML straight from the archive, with its photos and
 * cross-links resolved. A description has no zoom controls, so its bar gets
 * a Share button (schematics get theirs from fitAndPan, into the same bar).
 * @param {WiringViewCtx} ctx - the open view
 * @param {HTMLElement} bar - the document bar
 * @param {WiringDocContent} doc - the inflated document
 * @returns {void}
 */
function wiringRenderDescription(ctx, bar, doc) {
  bar.appendChild(wiringShareButton(false));
  const art = document.createElement('article');
  art.className = 'wiring-doc';
  art.innerHTML = doc.text;
  wiringResolveImages(art, ctx.data);
  wiringBindCrossLinks(art, ctx);
  ctx.viewEl.appendChild(art);
  ctx.viewEl.scrollTop = 0;
}

/**
 * A WDS schematic: drop the SVG in, then pan/zoom.
 * @param {WiringViewCtx} ctx - the open view
 * @param {HTMLElement} bar - the document bar
 * @param {WiringDocContent} doc - the inflated document
 * @returns {void}
 */
function wiringRenderSchematic(ctx, bar, doc) {
  const stage = document.createElement('div');
  stage.className = 'wiring-stage';
  stage.innerHTML = doc.text;
  ctx.viewEl.appendChild(stage);
  const svg = stage.querySelector('svg');
  if (!svg) return;
  // drop BMW's per-drawing <title> ("...Copyright BMW AG 2004"): it's an SVG
  // tooltip, so hovering popped a copyright notice. Name's in the bar.
  svg.querySelectorAll(':scope > title').forEach((t) => t.remove());
  // WDS kept zoom buttons in the footer; the modern layout on the bar
  const zoomHost = ctx.classic
    ? ctx.split.querySelector('#wds-zoomgroup')
    : bar;
  const zoom = fitAndPan(svg, stage, zoomHost, ctx.classic);
  // zoom keys on the bar too (a trackpad-less machine)
  setActions(wiringSchematicActions(ctx, zoom));
}

/**
 * The document pane for a WDS leaf: a schematic or a description. Reflects
 * the open diagram in the URL so it's a shareable deep link
 * (#apps/wiring/<CHASSIS>/<DOC>); best-effort, the viewer works without it.
 * @param {WiringViewCtx} ctx - the open view
 * @param {WiringTabEntry} entry - the leaf's tab entry
 * @returns {void}
 */
function wiringRenderDocument(ctx, entry) {
  ctx.atIndex = ctx.index.findIndex((e) => e.doc === entry.doc);
  if (typeof routeSetWiringDoc === 'function' && entry && entry.doc) {
    routeSetWiringDoc(ctx.chassisId, entry.doc);
  }
  // ONE PANE AT A TIME ON A PHONE: below 760px the CSS hides the unselected
  // pane, so loading into it means a 0x0 stage. Switch to it; no-op on
  // desktop.
  if (wiringIsPhone()) ctx.setPane('doc', false);
  const doc = wiringDoc(ctx.data, entry.doc);
  const viewEl = ctx.viewEl;
  viewEl.innerHTML = '';
  const bar = wiringDocBar(
    entry.name,
    WIRING_KIND_LABEL[entry.kind] || entry.kind
  );
  viewEl.appendChild(bar);

  setActions(ctx.browseActions); // reset; a schematic adds its zoom keys
  if (!doc) {
    viewEl.insertAdjacentHTML(
      'beforeend',
      `<div class="empty"><div>This document is not in the WDS release the ` +
        `data was built from.</div></div>`
    );
    return;
  }
  if (doc.type === 'html') {
    wiringRenderDescription(ctx, bar, doc);
    return;
  }
  wiringRenderSchematic(ctx, bar, doc);
  sbLeft.textContent = entry.name;
}
