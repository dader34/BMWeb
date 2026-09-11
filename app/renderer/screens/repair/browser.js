/**
 * @file The reusable tree/list/document browser ISTA uses for every
 * structure page, and which this build draws the repair manual with.
 *
 * FOUR OF ISTA'S PAGES ARE THE SAME PAGE. Product Structure, Fault pattern,
 * Function Structure and Component Structure all draw a tree on the left, a
 * Type/Title list of whatever is under the picked node on the right, and a
 * document over both when a row is opened. Only the DATA differs: the
 * repair manual's group tree, the fault-pattern tree, the function net, the
 * component structure.
 *
 * So nothing here knows about repair instructions. A caller hands in a
 * SOURCE -- a tree of nodes, a way to list the documents under one, and a
 * way to render a document body -- and gets the page. The repair manual is
 * the first source (screens/repair/screen.js); the others can be added by
 * writing a source, not by copying this file.
 *
 * @typedef {object} BrowserNode
 * @property {string} id - unique among its siblings
 * @property {string} label - what the row shows after the number
 * @property {string} [num] - the leading number, drawn in tabular figures
 * @property {number} [n] - how many documents are under it, all levels
 * @property {BrowserNode[]} [kids] - its children
 *
 * @typedef {object} BrowserSource
 * @property {BrowserNode[]} tree - the root nodes
 * @property {(path: string[]) => object[]|Promise<object[]>} list - every
 *   document under the node at this path of ids, parents included
 * @property {(doc: object) => string} rowType - the Type column's value
 * @property {(doc: object) => string} rowTitle - the Title column's value
 * @property {(doc: object) => string} docTitle - the viewer's title bar text
 * @property {(doc: object) => Promise<string>} docHtml - the document body
 * @property {(doc: object) => string} [docId] - a stable id, for deep links
 */

/* exported browserPaint browserNodeAt browserCrumb browserTreeHtml
   browserRowsHtml browserFlatten */

/** Rows drawn in one go before the table stops. */
const BROWSER_ROW_CAP = 800;

/**
 * Every node of a tree, depth first, each with the path that reaches it.
 * @param {BrowserNode[]} nodes - the roots
 * @param {string[]} [prefix] - the path above them
 * @returns {Array<{node: BrowserNode, path: string[], depth: number}>}
 */
function browserFlatten(nodes, prefix) {
  const base = prefix || [];
  const out = [];
  for (const node of nodes || []) {
    const path = base.concat([String(node.id)]);
    out.push({ node, path, depth: path.length - 1 });
    if (node.kids && node.kids.length)
      out.push(...browserFlatten(node.kids, path));
  }
  return out;
}

/**
 * The node a path of ids reaches, or null.
 * @param {BrowserNode[]} tree - the roots
 * @param {string[]|null} path - the ids, outermost first
 * @returns {BrowserNode|null}
 */
function browserNodeAt(tree, path) {
  if (!path || !path.length) return null;
  let nodes = tree || [];
  let found = null;
  for (const want of path) {
    found = (nodes || []).find((n) => String(n.id) === String(want)) || null;
    if (!found) return null;
    nodes = found.kids || [];
  }
  return found;
}

/**
 * The pane title: the selected node's breadcrumb, or the fallback.
 *
 * ISTA shows the whole path ("21 Clutch / 2100 Clutch, check") rather than
 * the leaf alone, because a subgroup number means nothing without the group
 * it sits in -- "2100" is only "Clutch, check" once you know it is clutch.
 * @param {BrowserNode[]} tree - the roots
 * @param {string[]|null} path - the selected path
 * @param {string} fallback - what to show when nothing is selected
 * @returns {string} the plain-text title
 */
function browserCrumb(tree, path, fallback) {
  if (!path || !path.length) return fallback;
  const bits = [];
  let nodes = tree || [];
  for (const want of path) {
    const node = (nodes || []).find((n) => String(n.id) === String(want));
    if (!node) break;
    bits.push([node.num, node.label].filter(Boolean).join(' ').trim());
    nodes = node.kids || [];
  }
  return bits.length ? bits.join(' / ') : fallback;
}

/**
 * The tree, as rows.
 *
 * A node with children gets a +/- expander; a leaf gets neither, and its
 * label starts where the expanded ones' labels do so the column stays
 * straight. Depth is drawn by indent AND by fill -- top level white, deeper
 * rows grey -- which is what makes a long tree readable at a glance.
 * @param {BrowserNode[]} tree - the roots
 * @param {Set<string>} open - the expanded paths, joined by '/'
 * @param {string[]|null} sel - the selected path
 * @returns {string} HTML
 */
function browserTreeHtml(tree, open, sel) {
  if (!tree || !tree.length)
    return `<div class="rp-none">Nothing in this structure.</div>`;
  const selKey = sel ? sel.join('/') : null;

  /**
   * One level of nodes, and the levels their open children need.
   * @param {BrowserNode[]} nodes - this level
   * @param {string[]} prefix - the path above them
   * @returns {string} HTML
   */
  const level = (nodes, prefix) =>
    (nodes || [])
      .map((node) => {
        const path = prefix.concat([String(node.id)]);
        const key = path.join('/');
        const kids = node.kids || [];
        const isOpen = open.has(key);
        const on = selKey === key;
        const depth = path.length - 1;
        return (
          `<button type="button" class="rp-node` +
          `${depth ? ' rp-node-deep' : ''}${on ? ' on' : ''}" ` +
          `data-path="${esc(key)}" ` +
          `style="padding-left:${8 + depth * 18}px" ` +
          (kids.length ? `aria-expanded="${isOpen}"` : '') +
          `>` +
          `<span class="rp-twist">${
            kids.length ? (isOpen ? '−' : '+') : ''
          }</span>` +
          (node.num
            ? `<span class="rp-node-num">${esc(node.num)}</span>`
            : '') +
          `<span class="rp-node-name">${esc(node.label || '')}</span>` +
          (node.n
            ? `<span class="rp-node-n">${node.n}</span>`
            : '<span class="rp-node-n"></span>') +
          `</button>` +
          (isOpen && kids.length ? level(kids, path) : '')
        );
      })
      .join('');
  return level(tree, []);
}

/**
 * The Type / Title table.
 * @param {object[]} rows - the documents
 * @param {BrowserSource} src - for the two column accessors
 * @param {number} [selected] - the row index that is open
 * @returns {string} HTML
 */
function browserRowsHtml(rows, src, selected) {
  const head =
    `<table class="rp-rows"><thead><tr>` +
    `<th class="rp-col-type">Type</th><th class="rp-col-title">Title</th>` +
    `</tr></thead>`;
  if (!rows || !rows.length) return head + `<tbody></tbody></table>`;
  const shown = rows.slice(0, BROWSER_ROW_CAP);
  const body = shown
    .map(
      (d, i) =>
        `<tr class="rp-row${i === selected ? ' on' : ''}" data-i="${i}">` +
        `<td class="rp-col-type">${esc(src.rowType(d))}</td>` +
        `<td class="rp-col-title">${esc(src.rowTitle(d))}</td></tr>`
    )
    .join('');
  return (
    head +
    `<tbody>${body}</tbody></table>` +
    (rows.length > shown.length
      ? `<p class="rp-more">${rows.length - shown.length} more not shown. ` +
        `Pick a node further down, or search.</p>`
      : '')
  );
}

/**
 * Draw and drive the browser inside a host element.
 *
 * Owns its own state object so two browsers (Product Structure and, later,
 * Component Structure) can be on screen in different tabs without sharing
 * a selection.
 * @param {HTMLElement} host - where to draw
 * @param {BrowserSource} src - the data
 * @param {object} state - {path, open, hits, doc, loading} kept by the caller
 * @param {object} [opts] - {emptyTitle, onChange}
 * @returns {void}
 */
function browserPaint(host, src, state, opts) {
  const options = opts || {};
  const stamp = () => {
    if (typeof options.onChange === 'function') options.onChange(state);
  };

  /** Redraw everything for the current state. */
  function paint() {
    stamp();
    if (state.doc) return paintDoc();
    paintPanes();
  }

  /** The two panes, the hits line and the bottom bar. */
  function paintPanes() {
    const rows = state.hits || [];
    const title = browserCrumb(
      src.tree,
      state.path,
      options.emptyTitle || 'Structure'
    );
    host.innerHTML =
      `<div class="rp-split">` +
      `<aside class="rp-pane">` +
      `<div class="rp-pane-head">` +
      `<span class="rp-pane-title">${esc(title)}</span>` +
      `<button type="button" class="rp-collapse">Collapse all</button>` +
      `</div>` +
      `<div class="rp-tree">${browserTreeHtml(
        src.tree,
        state.open,
        state.path
      )}</div></aside>` +
      `<section class="rp-results">` +
      (state.loading
        ? `<div class="rp-searching">` +
          `<div class="rp-searching-t">Searching...</div>` +
          `<div class="rp-bar"><div class="rp-bar-fill"></div></div>` +
          `<button type="button" class="rp-cancel">Cancel</button></div>`
        : browserRowsHtml(rows, src)) +
      `</section></div>` +
      `<div class="rp-status">` +
      `<span class="rp-hits">Hits: ${rows.length} / ${rows.length}` +
      `&nbsp;&nbsp;Filter: Default</span></div>`;

    host.querySelectorAll('.rp-node').forEach((b) => {
      b.onclick = () => pick(String(b.dataset.path).split('/'));
    });
    const collapse = host.querySelector('.rp-collapse');
    if (collapse)
      collapse.onclick = () => {
        state.open.clear();
        paint();
      };
    const cancel = host.querySelector('.rp-cancel');
    if (cancel)
      cancel.onclick = () => {
        // a cancelled load leaves the previous list standing rather than
        // blanking the pane: the reader asked to stop, not to lose it
        state.loading = null;
        paint();
      };
    wireRows(rows);
  }

  /**
   * Select a node: expand it, and list everything under it.
   *
   * Clicking the node already selected toggles it shut, so one click
   * always changes something -- ISTA's own behaviour, and the reason the
   * tree never feels stuck.
   * @param {string[]} path - the node's path of ids
   * @returns {void}
   */
  function pick(path) {
    const key = path.join('/');
    if (state.path && state.path.join('/') === key && state.open.has(key))
      state.open.delete(key);
    else state.open.add(key);
    state.path = path;
    const token = {};
    state.loading = token;
    paint();
    Promise.resolve(src.list(path)).then((rows) => {
      // a slower earlier load must not overwrite a faster later one
      if (state.loading !== token) return;
      state.loading = null;
      state.hits = rows || [];
      if (host.isConnected) paint();
    });
  }

  /** The open document, over both panes. */
  function paintDoc() {
    const doc = state.doc;
    const rows = state.hits || [];
    const at = rows.indexOf(doc);
    host.innerHTML =
      `<div class="rp-doc">` +
      `<div class="rp-doc-bar">` +
      `<span class="rp-doc-bar-t">${esc(src.docTitle(doc))}</span>` +
      `<span class="rp-doc-nav">` +
      `<button type="button" class="rp-prev" title="Previous document"` +
      `${at > 0 ? '' : ' disabled'}>◀</button>` +
      `<button type="button" class="rp-next" title="Next document"` +
      `${at >= 0 && at < rows.length - 1 ? '' : ' disabled'}>▶</button>` +
      `<button type="button" class="rp-x" title="Close">✕</button>` +
      `</span></div>` +
      `<div class="rp-doc-body"><div class="rp-loading">` +
      `<span class="wiring-spinner"></span></div></div></div>` +
      `<div class="rp-status">` +
      `<span class="rp-hits">Hits: ${rows.length} / ${rows.length}` +
      `&nbsp;&nbsp;Filter: Default</span>` +
      `<span class="rp-bottom">` +
      `<button type="button" class="rp-btn" disabled>Parts information</button>` +
      `<button type="button" class="rp-btn rp-close">Close</button>` +
      `</span></div>`;
    const body = host.querySelector('.rp-doc-body');
    Promise.resolve(src.docHtml(doc)).then((html) => {
      if (state.doc === doc && body.isConnected) body.innerHTML = html;
    });
    const close = () => {
      state.doc = null;
      paint();
    };
    host.querySelector('.rp-x').onclick = close;
    host.querySelector('.rp-close').onclick = close;
    const prev = host.querySelector('.rp-prev');
    const next = host.querySelector('.rp-next');
    if (prev && at > 0)
      prev.onclick = () => {
        state.doc = rows[at - 1];
        paint();
      };
    if (next && at >= 0 && at < rows.length - 1)
      next.onclick = () => {
        state.doc = rows[at + 1];
        paint();
      };
  }

  /**
   * Make each drawn row open its document.
   * @param {object[]} rows - what the table was drawn from
   * @returns {void}
   */
  function wireRows(rows) {
    host.querySelectorAll('.rp-row').forEach((tr) => {
      tr.onclick = () => {
        const d = rows[Number(tr.dataset.i)];
        if (!d) return;
        state.doc = d;
        paint();
      };
    });
  }

  paint();
  return { paint, pick };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    BROWSER_ROW_CAP,
    browserFlatten,
    browserNodeAt,
    browserCrumb,
    browserTreeHtml,
    browserRowsHtml,
    browserPaint,
  };
}
