/**
 * @file The Wiring & Documents screen for one car: the frame (WDS's own
 * chrome in INPA mode, a toolbar otherwise), the tree / document panes and
 * their pane switch, the category toggle (Diagrams | Components | Repair),
 * search, prev/next, the persisted tab workspace, deep links, and the Help
 * page. The pieces it mounts live beside it: archive, docs, vin, tabs, tree,
 * viewer, document, share-print.
 */

/**
 * WDS's pane buttons: a frame with the divider pushed one way; the filled
 * block is the pane that gets the room. doc=document, split=both, tree=tree.
 * @type {{doc: string, split: string, tree: string}}
 */
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

/** The category the tree shows when nothing is remembered. */
const WIRING_DEFAULT_CATEGORY = 'diagrams';

/**
 * WDS's own toolbar and title bar (INPA mode). It carries a few controls
 * (Series, Exit, Start) the modern layout reaches through its crumbs.
 * @param {string} chassisId - chassis code, for the title bar
 * @returns {string}
 */
function wiringWdsChromeHtml(chassisId) {
  return `
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
    </div>`;
}

/**
 * WDS's footer (INPA mode): the search word, the pane buttons and the zoom
 * group the schematic viewer fills.
 * @returns {string}
 */
function wiringWdsFooterHtml() {
  return `
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
    </div>`;
}

/**
 * The modern toolbar: Back, the category tabs, search, prev/next, the pane
 * buttons, Print and Help. The F-key bar is hidden on this screen, so the
 * route out is here (Esc still works).
 * @returns {string}
 */
function wiringModernToolbarHtml() {
  return `
    <div class="wiring-toolbar">
      <button class="btn wiring-tbtn" id="wds-back"
              title="Back to the vehicle list (Esc)">←&nbsp;Back</button>
      <span class="wiring-tsep"></span>
      <span class="wiring-cats" id="wiring-cats" role="tablist">
        <button class="btn wiring-tbtn wiring-cat" data-cat="diagrams"
                title="Wiring diagrams (WDS schematics)">Diagrams</button>
        <button class="btn wiring-tbtn wiring-cat" data-cat="components"
                title="Pin assignments, connector views, component locations">Components</button>
        <button class="btn wiring-tbtn wiring-cat" data-cat="repair"
                title="Repair instructions, technical data, torques">Repair</button>
      </span>
      <span class="wiring-tsep"></span>
      <input class="wiring-search" id="wiring-search" type="search"
             placeholder="Search…" autocomplete="off"
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
    </div>`;
}

/**
 * The whole frame. INPA mode wears WDS's own chrome; same code underneath,
 * only the frame changes. Both layouts carry the same controls.
 * @param {string} chassisId - chassis code
 * @param {boolean} classic - the INPA skin is on (WDS chrome)
 * @returns {string}
 */
function wiringFrameHtml(chassisId, classic) {
  return `
    ${classic ? wiringWdsChromeHtml(chassisId) : wiringModernToolbarHtml()}
    <div class="wiring-tabs" id="wiring-tabs" role="tablist" hidden></div>
    <div class="wiring-body">
      <nav class="split-nav wiring-nav">
        <div class="wiring-tree" id="wiring-tree"></div>
      </nav>
      <div class="split-content wiring-view" id="wiring-view"></div>
    </div>
    ${classic ? wiringWdsFooterHtml() : ''}`;
}

/**
 * Bind a click handler to a control of the frame, if the layout has it.
 * @param {HTMLElement} root - the frame
 * @param {string} sel - selector of the control
 * @param {() => void} fn - the handler
 * @returns {void}
 */
function wiringOn(root, sel, fn) {
  const el = root.querySelector(sel);
  if (el) el.onclick = fn;
}

/**
 * Show a pane: tree, document, or split. The setting sticks the way WDS
 * remembered it. An automatic switch (phone opening a diagram) must not
 * overwrite the choice the user made on desktop -- same setting -- so it
 * passes remember=false. No re-fit here: the viewer watches the stage and
 * re-fits on any box change, leaving a hand-zoomed view alone instead of
 * snapping it back.
 * @param {HTMLElement} split - the frame
 * @param {'tree' | 'split' | 'doc'} mode - which pane(s) show
 * @param {boolean} [remember] - persist the choice
 * @returns {void}
 */
function wiringSetPane(split, mode, remember = true) {
  split.querySelector('.wiring-body').dataset.pane = mode;
  split
    .querySelectorAll('.wds-pane')
    .forEach((b) => b.classList.toggle('active', b.id === `wds-pane-${mode}`));
  if (remember) Settings.set('wdsPane', mode);
}

/**
 * The F-keys while browsing: Back, and Print. The visible Print control is
 * the frame's own toolbar button, but the action must ALSO be registered
 * here: the Cmd/Ctrl+P interceptor (core/print.js) looks up the current
 * screen's print action, and without one it lets the native dialog print the
 * live page -- toolbar, tab bar and all. The F-key bar is hidden on this
 * screen, so no duplicate button.
 * @param {string} chassisId - chassis code
 * @param {() => void} leaveWiring - what Back does
 * @returns {Array<Object>}
 */
function wiringBrowseActions(chassisId, leaveWiring) {
  return [
    {
      key: 'Escape',
      keyLabel: 'Esc',
      label: 'Back',
      kind: 'back',
      fn: leaveWiring,
    },
    {
      key: 'p',
      keyLabel: 'P',
      label: 'Print',
      kind: 'print',
      fn: () => printWiring(chassisId),
    },
  ];
}

/**
 * The bare ISTA document id a deep link names: openDoc looks like "d:<id>"
 * (the documents route) or is numeric; anything else is a WDS doc.
 * @param {string | null} openDoc - the doc argument of showWiring
 * @returns {string | null}
 */
function wiringDeepDocId(openDoc) {
  if (!openDoc) return null;
  if (/^d:/.test(openDoc)) return openDoc.slice(2);
  if (/^\d+$/.test(openDoc)) return openDoc;
  return null;
}

/**
 * Re-tie a persisted tab to a live entry: an ISTA document tab is
 * self-contained, a WDS doc must still exist in the index (a rebuilt archive
 * that dropped it just skips the tab), a glossary tab has no doc and is kept
 * as saved.
 * @param {WiringTabEntry} t - the saved tab
 * @param {WiringIndexEntry[]} index - the flat WDS index
 * @returns {WiringTabEntry | null}
 */
function wiringResolveSavedTab(t, index) {
  if (t.doc && String(t.doc).startsWith('d:'))
    return docsTabEntryById(String(t.doc).slice(2), t.name, t.kind);
  if (t.doc) return index.find((e) => e.doc === t.doc) || null;
  return { name: t.name, kind: t.kind };
}

/**
 * Keep the doc count (status bar + empty state) faithful to the mode: all
 * diagrams, or only those not off-build for the car.
 * @param {WiringViewCtx} ctx - the open view
 * @returns {void}
 */
function wiringRefreshCount(ctx) {
  const n = wiringCountShown(ctx.data.tree);
  const label =
    `${n} diagram${n === 1 ? '' : 's'}` +
    (wiringVinHit && wiringVinFilterOn ? ' for your car' : '');
  sbRight.textContent = label;
  const empty = ctx.viewEl.querySelector('.wiring-emptycount');
  if (empty) empty.textContent = label;
}

/**
 * Render whichever tree the active category calls for. Diagrams is the WDS
 * tree; Components and Repair render the ISTA document tree (loaded lazily)
 * filtered to their doc types. The tab workspace, VIN filter and search all
 * work across categories.
 * @param {WiringViewCtx} ctx - the open view
 * @returns {Promise<void>}
 */
async function wiringRenderCurrentTree(ctx) {
  const { catHost, searchEl, treeEl } = ctx;
  const openTab = (entry) => ctx.tabs.openTab(entry);
  catHost &&
    catHost
      .querySelectorAll('.wiring-cat')
      .forEach((b) => b.classList.toggle('active', b.dataset.cat === ctx.cat));
  searchEl.value = '';
  searchEl.dispatchEvent(new Event('input'));
  // clear the tree body but keep the VIN banner (first child) if present
  const banner = treeEl.querySelector('.wiring-vinbanner');
  treeEl.innerHTML = '';
  if (banner) treeEl.appendChild(banner);
  if (ctx.cat === 'diagrams') {
    wiringRenderTree(ctx.data.tree, treeEl, 0, openTab);
    ctx.refreshCount();
    return;
  }
  if (!ctx.docsData) {
    const wait = wiringLoadingEl('Loading documents…');
    treeEl.appendChild(wait);
    try {
      ctx.docsData = await loadDocs(ctx.chassisId);
    } catch (e) {
      wait.innerHTML = `<div class="wiring-empty">No documents shipped for ${esc(dispChassis(ctx.chassisId))}.</div>`;
      return;
    }
    wait.remove();
  }
  const pruned = docsPruneTree(
    ctx.docsData.tree,
    docsCategoryKeep(ctx.cat)
  ) || {
    name: '',
  };
  wiringRenderDocsTree(pruned, treeEl, 0, openTab);
  if (wiringVinHit) {
    const b = treeEl.querySelector('.wiring-vinbanner');
    if (b && b._applyFilter) b._applyFilter(wiringVinFilterOn);
  }
  const n = docsCount(pruned);
  sbRight.textContent = `${n} document${n === 1 ? '' : 's'}`;
}

/**
 * The category tabs (modern layout): switching re-renders the tree and
 * remembers the choice.
 * @param {WiringViewCtx} ctx - the open view
 * @returns {void}
 */
function wiringBindCategories(ctx) {
  if (!ctx.catHost) return;
  ctx.catHost.querySelectorAll('.wiring-cat').forEach((btn) => {
    btn.onclick = () => {
      if (ctx.cat === btn.dataset.cat) return;
      ctx.cat = btn.dataset.cat;
      Settings.set('wiringCat', ctx.cat);
      wiringRenderCurrentTree(ctx);
    };
  });
}

/**
 * Search: flat results across the active category, tree hidden while typing.
 * @param {WiringViewCtx} ctx - the open view
 * @returns {void}
 */
function wiringBindSearch(ctx) {
  const { searchEl, treeEl } = ctx;
  let searchWrap = null;
  searchEl.oninput = () => {
    const q = searchEl.value.trim().toLowerCase();
    if (searchWrap) {
      searchWrap.remove();
      searchWrap = null;
    }
    treeEl.hidden = !!q;
    if (!q) return;
    const hits = wiringSearchHits(
      q,
      ctx.cat,
      ctx.index,
      ctx.docsData ? ctx.docsData.tree : null
    );
    searchWrap = wiringSearchResultsEl(hits, ctx.cat, (entry) =>
      ctx.tabs.openTab(entry)
    );
    treeEl.parentNode.appendChild(searchWrap);
    sbRight.textContent = `${hits.length} match${hits.length === 1 ? '' : 'es'}`;
  };
}

/**
 * Prev/next step through documents in tree order (the flat index IS that
 * order), moving the active tab rather than opening one per step.
 * @param {WiringViewCtx} ctx - the open view
 * @param {number} d - +1 or -1
 * @returns {void}
 */
function wiringStep(ctx, d) {
  const index = ctx.index;
  if (!index.length) return;
  ctx.atIndex = (ctx.atIndex + d + index.length) % index.length;
  const entry = index[ctx.atIndex];
  const active = ctx.tabs.activeEntry();
  if (active && active.doc) ctx.tabs.replaceActive(entry);
  else ctx.tabs.openTab(entry);
}

/**
 * Open the first document: a deep-linked ISTA doc or WDS doc (ECU / shared
 * link), else the tab that was active when the user last left, else the
 * placeholder. A deep link becomes a tab too, on top of any restored ones.
 * @param {WiringViewCtx} ctx - the open view
 * @param {string | null} openDoc - the doc argument of showWiring
 * @param {string | null} deepDocId - the bare ISTA id when openDoc names one
 * @returns {void}
 */
function wiringOpenInitial(ctx, openDoc, deepDocId) {
  const { tabs, treeEl, data, index } = ctx;
  // openTab focuses an already-open tab, but focusTab short-circuits when
  // that tab is already the active one -- which it is right after a reload
  // that restored this same doc as the active tab, so nothing would draw.
  // Render it explicitly in that case; otherwise open/focus as normal.
  const openOrRedraw = (entry) => {
    if (tabs.isActive(entry) && tabs.has(entry)) tabs.renderActive();
    else tabs.openTab(entry);
  };
  if (deepDocId) {
    const entry = docsTabEntryById(deepDocId, 'Document', '');
    // recover its title/type from the loaded docs tree if available
    const d = ctx.docsData ? docsFindById(ctx.docsData.tree, deepDocId) : null;
    if (d) {
      entry.name = d.title;
      entry.kind = d.type;
    }
    openOrRedraw(entry);
  } else if (openDoc) {
    const hit =
      index.find((e) => e.doc === openDoc) ||
      index.find((e) => e.name === openDoc);
    if (hit) {
      openOrRedraw(hit);
      wiringExpandTreeToDoc(treeEl, data.tree, hit.doc);
    } else if (tabs.active) {
      tabs.renderActive();
    } else wiringRenderPlaceholder(ctx);
  } else if (tabs.active) {
    // reopen the tab that was active when the user last left
    tabs.renderActive();
    const act = tabs.open.find((t) => t.doc && wiringTabKey(t) === tabs.active);
    if (act) wiringExpandTreeToDoc(treeEl, data.tree, act.doc);
  } else {
    wiringRenderPlaceholder(ctx);
  }
}

/**
 * Fill the mounted frame once the archive (and, with a VIN, the
 * applicability index) is in: tabs, prev/next, the VIN banner, categories,
 * the tree, search, the restored workspace and the first document.
 * @param {WiringViewCtx} ctx - the open view, with data and index set
 * @param {string | null} openDoc - the doc argument of showWiring
 * @returns {void}
 */
function wiringPopulate(ctx, openDoc) {
  const { split, treeEl, data } = ctx;
  ctx.tabs = new WiringTabStrip(
    split.querySelector('#wiring-tabs'),
    ctx.chassisId,
    {
      render: (entry) => wiringRenderEntry(ctx, entry),
      empty: () => wiringRenderPlaceholder(ctx),
    }
  );
  const openTab = (entry) => ctx.tabs.openTab(entry);
  wiringOn(split, '#wds-prev', () => wiringStep(ctx, -1));
  wiringOn(split, '#wds-next', () => wiringStep(ctx, 1));

  treeEl.innerHTML = ''; // drop the "loading" placeholder
  ctx.refreshCount = () => wiringRefreshCount(ctx);
  if (wiringVinHit) {
    // applied after the tree renders below (folders must exist first)
    treeEl.appendChild(
      buildWiringVinBanner(wiringVinHit, ctx.body, ctx.refreshCount)
    );
  }
  wiringBindCategories(ctx);

  // A deep-linked ISTA doc forces a document category; otherwise honour the
  // remembered/param category.
  const deepDocId = wiringDeepDocId(openDoc);
  if (ctx.cat === 'diagrams' && !deepDocId) {
    wiringRenderTree(data.tree, treeEl, 0, openTab);
    // now that the tree exists, apply the default VIN filter (folders present)
    if (wiringVinHit) {
      const banner = treeEl.querySelector('.wiring-vinbanner');
      banner && banner._applyFilter(true);
    }
    ctx.refreshCount();
  } else {
    // a doc category (or a deep-linked doc): render that tree instead
    if (deepDocId && ctx.cat === 'diagrams') ctx.cat = 'repair';
    wiringRenderCurrentTree(ctx);
  }
  wiringBindSearch(ctx);

  // restore the persisted tab workspace for this chassis
  ctx.tabs.restore(wiringTabsLoad(ctx.chassisId), (t) =>
    wiringResolveSavedTab(t, ctx.index)
  );
  wiringOpenInitial(ctx, openDoc, deepDocId);
}

/**
 * The Wiring & Documents screen for one car. `vin` (a decoded VIN hit) turns
 * on ISTA-style applicability filtering: each diagram is tagged match / off
 * / neutral against the vehicle, and a toggle can hide the off ones. Null =
 * no filtering. `openDoc` opens straight to a document (an SP doc id or
 * name, "d:<id>" or a bare numeric ISTA id); `category` picks the tree
 * (remembered otherwise; a deep-linked doc picks its own).
 * @param {string} chassisId - chassis code
 * @param {string | null} [openDoc] - document to open first
 * @param {WiringVinHit | null} [vin] - decoded VIN to filter against
 * @param {WiringCategory | null} [category] - tree to show
 * @returns {void}
 */
function showWiring(chassisId, openDoc = null, vin = null, category = null) {
  lastScreen = () => showWiring(chassisId, null, vin);
  wiringVinHit = vin || null; // module-level so the tree and search can read it
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: 'Apps', fn: showApps },
    { label: 'Wiring & Documents', fn: showWiringChassis },
    { label: dispChassis(chassisId) },
  ]);
  sbLeft.textContent = 'loading…';
  // no page heading: a schematic wants every pixel of height, crumbs say where
  // you are
  view.innerHTML = '';

  // the WDS look follows the INPA skin, not the layout mode
  const classic = typeof inpaTheme === 'function' && inpaTheme();
  // no F-key bar either mode: both layouts carry Back/print/help on their own
  // chrome, and the bar would cost the diagram 52px. setCrumbs restores it.
  document.body.classList.add('wds-nofkeys');
  const split = document.createElement('div');
  split.className = 'split wiring-split' + (classic ? ' wds-frame' : '');
  split.innerHTML = wiringFrameHtml(chassisId, classic);
  view.appendChild(split);

  const treeEl = split.querySelector('#wiring-tree');
  // the archive is 2-24 MB: real wait before the tree appears, so fill it
  treeEl.appendChild(
    wiringLoadingEl(`Loading ${dispChassis(chassisId)} diagrams…`)
  );
  const viewEl = split.querySelector('#wiring-view');
  const searchEl = split.querySelector('#wiring-search');
  const body = split.querySelector('.wiring-body');

  wiringOn(split, '#wds-series', showWiringChassis);
  wiringOn(split, '#wds-exit', showChassis);
  wiringOn(split, '#wds-back', showWiringChassis);
  wiringOn(split, '#wds-start', () => showWiring(chassisId));
  wiringOn(split, '#wds-help', () => showWiringHelp(chassisId));
  wiringOn(split, '#wds-print', () => printWiring(chassisId));
  wiringOn(split, '#wds-new', () => {
    searchEl.value = '';
    searchEl.dispatchEvent(new Event('input'));
  });
  wiringOn(split, '#wds-find', () =>
    searchEl.dispatchEvent(new Event('input'))
  );

  const setPane = (mode, remember = true) =>
    wiringSetPane(split, mode, remember);
  wiringOn(split, '#wds-pane-doc', () => setPane('doc'));
  wiringOn(split, '#wds-pane-split', () => setPane('split'));
  wiringOn(split, '#wds-pane-tree', () => setPane('tree'));
  // opened via a VIN: the point is the FILTERED TREE, so force it visible even
  // if the saved pref was diagram-only (don't overwrite that pref). Otherwise
  // honour the remembered pane.
  if (wiringVinHit) {
    const pref = Settings.get('wdsPane', 'split');
    setPane(pref === 'doc' ? 'split' : pref, false);
  } else {
    setPane(Settings.get('wdsPane', 'split'));
  }
  tipify(split);

  // Back from the tree leaves wiring; back from a DIAGRAM on a phone returns to
  // the tree first -- panes are exclusive there, so leaving would skip a level.
  const leaveWiring = () => {
    if (wiringIsPhone() && body.dataset.pane === 'doc') {
      setPane('tree', false);
      return;
    }
    showWiringChassis();
  };
  const browseActions = wiringBrowseActions(chassisId, leaveWiring);
  setActions(browseActions);

  /** @type {WiringViewCtx} */
  const ctx = {
    chassisId,
    classic,
    split,
    body,
    treeEl,
    viewEl,
    searchEl,
    catHost: split.querySelector('#wiring-cats'),
    setPane,
    leaveWiring,
    browseActions,
    data: null,
    index: [],
    tabs: null,
    docsData: null, // the .docs bundle, loaded on first non-diagram use
    cat: category || Settings.get('wiringCat', WIRING_DEFAULT_CATEGORY),
    atIndex: -1,
    refreshCount: () => {},
  };

  // load the archive and (when filtering by VIN) BMW's applicability index in
  // parallel, so leaves can be tagged the moment the tree renders
  Promise.all([
    loadWiring(chassisId),
    wiringVinHit && typeof wiringApplicability !== 'undefined'
      ? wiringApplicability.load().catch(() => null)
      : Promise.resolve(),
  ])
    .then(([data]) => {
      ctx.data = data;
      ctx.index = wiringIndex(data.tree);
      sbLeft.textContent = 'wiring';
      // sbRight is set by refreshCount so it stays faithful to the mode
      wiringPopulate(ctx, openDoc);
    })
    .catch((e) => {
      viewEl.innerHTML = errorBlock(e.message);
      sbLeft.textContent = 'no wiring data';
    });
}

/**
 * WDS's own Help page, with our controls (a wheel and a drag, not Strg+click).
 * @param {string} chassisId - chassis code, to return to its tree
 * @returns {void}
 */
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
  setActions([
    {
      key: 'Escape',
      keyLabel: 'Esc',
      label: 'Back',
      kind: 'back',
      fn: () => showWiring(chassisId),
    },
  ]);
}
