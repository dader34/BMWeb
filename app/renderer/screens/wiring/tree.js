/**
 * @file The tree pane: folder and leaf rows for the WDS diagram tree and the
 * ISTA document tree, the flat search results that replace the tree while
 * typing, the deep-link expansion that lands a reader in context, and the
 * document counts the status bar shows.
 */

/* exported
   wiringLoadingEl, wiringRenderTree, wiringRenderDocsTree,
   wiringCountShown, wiringExpandTreeToDoc, wiringSearchHits,
   wiringSearchResultsEl */

/** Left padding of a top-level tree row, px. */
const WIRING_TREE_INDENT_BASE = 10;
/** Extra left padding per nesting level, px. */
const WIRING_TREE_INDENT_STEP = 12;
/** Search results are capped so a one-letter query stays responsive. */
const WIRING_SEARCH_MAX_HITS = 300;
/** The kind-coloured dot every row starts with. */
const WIRING_DOT_HTML = '<span class="wiring-dot"></span>';
/** The star a row wears when it matches the decoded VIN. */
const WIRING_VIN_STAR_HTML =
  '<span class="wiring-vinstar" title="Matches your vehicle">★</span>';

/**
 * Row indentation for a nesting depth.
 * @param {number} depth - 0 at the root
 * @returns {string} a CSS length
 */
function wiringTreeIndent(depth) {
  return `${WIRING_TREE_INDENT_BASE + depth * WIRING_TREE_INDENT_STEP}px`;
}

/**
 * The class a row carries for its VIN verdict; nothing for neutral.
 * @param {WiringVinMatch} vm - the verdict
 * @returns {string}
 */
function wiringVinClass(vm) {
  return vm === 'match' ? ' vin-match' : vm === 'off' ? ' vin-off' : '';
}

/**
 * The star markup for a matching row; nothing otherwise.
 * @param {WiringVinMatch} vm - the verdict
 * @returns {string}
 */
function wiringVinStar(vm) {
  return vm === 'match' ? WIRING_VIN_STAR_HTML : '';
}

/**
 * What a leaf row needs to draw.
 * @typedef {Object} WiringLeafSpec
 * @property {string} kind - tree kind, sets the dot colour (kind-<kind>)
 * @property {string} html - the row's inner markup, already escaped
 * @property {() => void} onClick - what opening the row does
 * @property {WiringVinMatch} [vm] - VIN verdict; tags the row for the filter
 * @property {number} [depth] - nesting depth; omitted on a search result
 * @property {string} [title] - tooltip
 */

/**
 * A leaf row: a button with the kind dot, the name and any VIN marks.
 * @param {WiringLeafSpec} spec - what to draw
 * @returns {HTMLButtonElement}
 */
function wiringLeafButton(spec) {
  const leaf = document.createElement('button');
  leaf.className =
    `wiring-leaf kind-${spec.kind}` + (spec.vm ? wiringVinClass(spec.vm) : '');
  if (spec.vm) leaf.dataset.vin = spec.vm;
  if (spec.depth != null) leaf.style.paddingLeft = wiringTreeIndent(spec.depth);
  leaf.innerHTML = spec.html;
  if (spec.title) leaf.title = spec.title;
  leaf.onclick = spec.onClick;
  return leaf;
}

/**
 * A spinner with a caption, for the waits the archives impose.
 * @param {string} text - what is being waited for
 * @returns {HTMLDivElement}
 */
function wiringLoadingEl(text) {
  const wait = document.createElement('div');
  wait.className = 'wiring-loading';
  wait.innerHTML =
    `<span class="wiring-spinner"></span>` + `<span>${esc(text)}</span>`;
  return wait;
}

/**
 * A collapsing folder row, shared by the diagram tree and the document tree
 * (their leaf rows differ, but the folder is identical): a caret + name
 * button that lazily builds its children via `recurse` on first open, and
 * carries data-vin-empty so the VIN filter can hide a wholly-off-build branch
 * without expanding it.
 * @template T
 * @param {T & {name: string}} c - the folder node
 * @param {HTMLElement} parent - where the row goes
 * @param {number} depth - nesting depth
 * @param {(node: T, parent: HTMLElement, depth: number) => void} recurse - draws the children
 * @param {(node: T) => boolean} hasMatch - the per-tree subtree test (diagrams vs docs)
 * @returns {void}
 */
function wiringMakeFolder(c, parent, depth, recurse, hasMatch) {
  const wrap = document.createElement('div');
  wrap.className = 'wiring-folderwrap';
  if (wiringVinHit && !hasMatch(c)) wrap.dataset.vinEmpty = '1';
  const btn = document.createElement('button');
  btn.className = 'wiring-folder';
  btn.style.paddingLeft = wiringTreeIndent(depth);
  btn.innerHTML =
    `<span class="wiring-caret">▸</span>` + `<span>${esc(c.name)}</span>`;
  const kids = document.createElement('div');
  kids.className = 'wiring-kids';
  kids.hidden = true;
  btn.onclick = () => {
    kids.hidden = !kids.hidden;
    btn.classList.toggle('open', !kids.hidden);
    if (!kids.dataset.built) {
      recurse(c, kids, depth + 1);
      kids.dataset.built = '1';
    }
  };
  wrap.appendChild(btn);
  wrap.appendChild(kids);
  parent.appendChild(wrap);
}

/**
 * The WDS tree: folders collapse, leaves open. A leaf with a doc is a
 * diagram or description; a childless leaf without one is a glossary /
 * signal definition.
 * @param {WiringTreeNode} node - subtree root
 * @param {HTMLElement} parent - where the rows go
 * @param {number} depth - nesting depth
 * @param {(entry: WiringTreeNode) => void} onOpen - opens a leaf
 * @returns {void}
 */
function wiringRenderTree(node, parent, depth, onOpen) {
  const recurse = (n, p, d) => wiringRenderTree(n, p, d, onOpen);
  for (const c of node.children || []) {
    if (c.doc) {
      const vm = wiringDiagramMatch(c.doc); // match | off | neutral
      parent.appendChild(
        wiringLeafButton({
          kind: c.kind,
          vm,
          depth,
          html:
            WIRING_DOT_HTML +
            `<span class="wiring-leaf-name">${esc(c.name)}</span>` +
            wiringVinStar(vm),
          title: WIRING_KIND_LABEL[c.kind] || c.kind,
          onClick: () => onOpen(c),
        })
      );
    } else if (c.children && c.children.length > 0) {
      wiringMakeFolder(c, parent, depth, recurse, wiringSubtreeHasMatch);
    } else {
      // Glossary / Signal definition leaf
      parent.appendChild(
        wiringLeafButton({
          kind: 'specs',
          depth,
          html:
            `<span class="wiring-dot" style="background: var(--amber);"></span>` +
            `<span class="wiring-leaf-name">${esc(c.name)}</span>`,
          title: 'Signal / Component definition',
          onClick: () => onOpen(c),
        })
      );
    }
  }
}

/**
 * A docs-tree node -> DOM (mirrors wiringRenderTree but for ISTA doc leaves,
 * which wear a type badge).
 * @param {DocsTreeNode} node - subtree root
 * @param {HTMLElement} parent - where the rows go
 * @param {number} depth - nesting depth
 * @param {(entry: WiringTabEntry) => void} onOpen - opens a document tab
 * @returns {void}
 */
function wiringRenderDocsTree(node, parent, depth, onOpen) {
  const recurse = (n, p, d) => wiringRenderDocsTree(n, p, d, onOpen);
  for (const d of node.docs || []) {
    const vm = docsVinMatch(d);
    parent.appendChild(
      wiringLeafButton({
        kind: docsTypeKind(d.type),
        vm,
        depth,
        html:
          WIRING_DOT_HTML +
          `<span class="wiring-leaf-name">${esc(d.title)}</span>` +
          wiringVinStar(vm) +
          `<span class="docs-badge">${esc(d.type)}</span>`,
        title: docsTypeLabel(d.type),
        onClick: () => onOpen(docsTabEntry(d)),
      })
    );
  }
  for (const c of node.children || []) {
    if (!c.children && !c.docs) continue;
    wiringMakeFolder(c, parent, depth, recurse, docsSubtreeHasMatch);
  }
}

/**
 * Count the diagrams the current mode would show (all, or only those not
 * off-build when the VIN filter is on).
 * @param {WiringTreeNode} tree - the archive's root
 * @returns {number}
 */
function wiringCountShown(tree) {
  let n = 0;
  (function walk(node) {
    for (const c of node.children || []) {
      if (c.doc) {
        if (!wiringVinFilterOn || wiringDiagramMatch(c.doc) !== 'off') n++;
      } else if (c.children) walk(c);
    }
  })(tree);
  return n;
}

/**
 * The path of nodes from the root down to a document: every folder above it,
 * then the leaf itself.
 * @param {WiringTreeNode} node - subtree root
 * @param {string} doc - SP doc id
 * @param {WiringTreeNode[]} [trail] - folders walked so far
 * @returns {WiringTreeNode[] | null}
 */
function wiringDocPath(node, doc, trail = []) {
  for (const c of node.children || []) {
    if (c.doc === doc) return trail.concat(c);
    if (c.children && c.children.length) {
      const r = wiringDocPath(c, doc, trail.concat(c));
      if (r) return r;
    }
  }
  return null;
}

/**
 * A folder button is "<caret>▸</caret><span>Name</span>" -- read the label
 * span, not textContent (which includes the caret glyph).
 * @param {HTMLElement} b - a .wiring-folder button
 * @returns {string}
 */
function wiringFolderLabel(b) {
  const span = b.querySelector('span:not(.wiring-caret)');
  return (span ? span.textContent : b.textContent).trim();
}

/**
 * Expand the tree down to a specific document and highlight/scroll to it.
 * Used by the deep-link path so a shared #apps/wiring/<CHASSIS>/<DOC> link
 * lands the reader IN CONTEXT, not on a diagram with a collapsed tree. The
 * tree is lazy (folders build children only when opened), so walk the doc's
 * path in the data and click each folder open in order, then find the leaf.
 * @param {HTMLElement} treeEl - the tree pane
 * @param {WiringTreeNode} tree - the archive's root
 * @param {string} doc - SP doc id
 * @returns {void}
 */
function wiringExpandTreeToDoc(treeEl, tree, doc) {
  const path = wiringDocPath(tree, doc);
  if (!path) return;
  let container = treeEl;
  // every path element except the last is a folder to open
  for (let i = 0; i < path.length - 1; i++) {
    const name = path[i].name;
    const folder = [
      ...container.querySelectorAll(
        ':scope > div > .wiring-folder, :scope > .wiring-folder'
      ),
    ].find((b) => wiringFolderLabel(b) === name);
    if (!folder) return;
    if (!folder.classList.contains('open')) folder.click(); // builds+shows kids
    container = folder.parentElement.querySelector('.wiring-kids') || container;
  }
  // highlight + scroll the leaf
  const leaf = [...container.querySelectorAll(':scope > .wiring-leaf')].find(
    (b) =>
      (b.querySelector('.wiring-leaf-name') || {}).textContent ===
      path[path.length - 1].name
  );
  if (leaf) {
    treeEl
      .querySelectorAll('.wiring-leaf.active')
      .forEach((a) => a.classList.remove('active'));
    leaf.classList.add('active');
    leaf.scrollIntoView({ block: 'center' });
  }
}

/**
 * Title search across the active category: Diagrams searches the WDS index,
 * Components/Repair search the docs of that category.
 * @param {string} q - the query, trimmed and lower-cased
 * @param {WiringCategory} cat - the active category
 * @param {WiringIndexEntry[]} index - the flat WDS index
 * @param {DocsTreeNode | null} docsTree - the docs tree, or null before it loads
 * @returns {WiringIndexEntry[] | DocsIndexEntry[]}
 */
function wiringSearchHits(q, cat, index, docsTree) {
  if (cat === 'diagrams') {
    return index
      .filter((e) => e.name.toLowerCase().includes(q))
      .slice(0, WIRING_SEARCH_MAX_HITS);
  }
  return docsFlatIndex(docsTree, docsCategoryKeep(cat))
    .filter((d) => d.title.toLowerCase().includes(q))
    .slice(0, WIRING_SEARCH_MAX_HITS);
}

/**
 * Flat search results, one row per hit with its folder for context; "no
 * match" when there are none. A doc hit opens as an ISTA-doc tab.
 * @param {WiringIndexEntry[] | DocsIndexEntry[]} hits - what wiringSearchHits found
 * @param {WiringCategory} cat - the category searched
 * @param {(entry: WiringTabEntry) => void} onOpen - opens a hit
 * @returns {HTMLDivElement}
 */
function wiringSearchResultsEl(hits, cat, onOpen) {
  const wrap = document.createElement('div');
  wrap.className = 'wiring-results';
  if (cat === 'diagrams') {
    hits.forEach((e) => {
      wrap.appendChild(
        wiringLeafButton({
          kind: e.kind,
          html:
            WIRING_DOT_HTML +
            `<span class="wiring-leaf-name">${esc(e.name)}</span>` +
            `<span class="wiring-trail">${esc(e.trail.slice(-1)[0] || '')}</span>`,
          onClick: () => onOpen(e),
        })
      );
    });
  } else {
    hits.forEach((d) => {
      wrap.appendChild(
        wiringLeafButton({
          kind: docsTypeKind(d.type),
          html:
            WIRING_DOT_HTML +
            `<span class="wiring-leaf-name">${esc(d.title)}` +
            `<span class="wiring-trail">${esc((d.trail || []).slice(-2).join(' › '))}</span></span>` +
            `<span class="docs-badge">${esc(d.type)}</span>`,
          onClick: () => onOpen(docsTabEntry(d)),
        })
      );
    });
  }
  if (!hits.length) wrap.innerHTML = `<div class="wiring-empty">no match</div>`;
  return wrap;
}
