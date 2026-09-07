/**
 * @file Tuning screen: the definition tree on the left -- search box, kind
 * filter chips, collapsible categories, one row per item with its editor
 * beneath -- and the two directions between tree and hex view: spotlight an
 * item's bytes, or open the item that owns a clicked byte.
 */

/* exported tnRenderDefs, tnOpenItemAt, tnSpotlight */

/** Debounce for the tree filter box. */
const TN_FILTER_DEBOUNCE_MS = 100;

/**
 * Render (or re-render) the whole definition pane.
 * @param {TuningEditor} ed
 * @returns {void}
 */
function tnRenderDefs(ed) {
  const els = ed.els;
  const def = tuningState.def;
  els.defs.innerHTML = '';
  if (!def) {
    els.defs.appendChild(tnDefsEmptyState());
    return;
  }

  // search box
  const searchWrap = document.createElement('div');
  searchWrap.className = 'tn-defs-search';
  searchWrap.innerHTML = `
      <span class="tn-defs-title">${esc(def.header.deftitle || 'Definition')}</span>
      <input type="text" class="tn-defs-filter" placeholder="Filter parameters…"
             spellcheck="false" autocomplete="off" value="${esc(tuningState.filter)}" />`;
  els.defs.appendChild(searchWrap);
  const filterInput = searchWrap.querySelector('.tn-defs-filter');

  const listWrap = document.createElement('div');
  listWrap.className = 'tn-defs-list';
  const catName = tnCategoryNamer(def);
  const renderList = () => tnRenderDefList(ed, listWrap, def, catName);

  const kindBar = tnRenderKindBar(def, renderList);
  if (kindBar) els.defs.appendChild(kindBar);
  els.defs.appendChild(listWrap);

  let debounce = null;
  filterInput.oninput = () => {
    tuningState.filter = filterInput.value;
    clearTimeout(debounce);
    debounce = setTimeout(renderList, TN_FILTER_DEBOUNCE_MS);
  };

  renderList();
}

/**
 * KIND FILTER. A 5,705-item definition is mostly one kind at a time: you are
 * hunting a table, or a flag, not both. The chips carry each kind's own
 * accent (same colours as the row badges) and its count, so the makeup of
 * the file is visible before you touch anything. Kinds the definition does
 * not contain are not offered; one kind only means nothing to filter.
 * @param {XdfFile} def
 * @param {() => void} onChange - Re-render the list after a chip click.
 * @returns {HTMLDivElement|null} The chip bar, or null when there is only one kind.
 */
function tnRenderKindBar(def, onChange) {
  const kindCounts = new Map();
  for (const it of def.items) {
    kindCounts.set(it.kind, (kindCounts.get(it.kind) || 0) + 1);
  }
  const presentKinds = [...kindCounts.keys()].sort(
    (a, b) => kindCounts.get(b) - kindCounts.get(a)
  );
  if (presentKinds.length <= 1) return null;

  const kindBar = document.createElement('div');
  kindBar.className = 'tn-kind-bar';
  const paintKinds = () => {
    const on = tuningState.kinds;
    kindBar.innerHTML = presentKinds
      .map((k) => {
        const sel = !on || on.has(k);
        return (
          `<button type="button" class="tn-kind-chip tn-kind-${esc(k)}` +
          `${sel ? ' on' : ''}" data-kind="${esc(k)}"` +
          ` title="${esc(k)} — click to show only this, click again for all">` +
          `<span class="tn-kind-chip-t">${esc(TN_KIND_LABEL[k] || k)}</span>` +
          `<span class="tn-kind-chip-n">${kindCounts.get(k)}</span>` +
          `</button>`
        );
      })
      .join('');
  };
  paintKinds();
  kindBar.addEventListener('click', (e) => {
    const b = e.target.closest('.tn-kind-chip');
    if (!b) return;
    const k = b.dataset.kind;
    const cur = tuningState.kinds;
    if (!cur) {
      // from "all", a click means "only this one"
      tuningState.kinds = new Set([k]);
    } else if (cur.has(k)) {
      cur.delete(k);
      // turning the last one off means "all" again, never an empty list
      if (!cur.size) tuningState.kinds = null;
    } else {
      cur.add(k);
      if (cur.size === presentKinds.length) tuningState.kinds = null;
    }
    paintKinds();
    onChange();
  });
  return kindBar;
}

/**
 * A category index -> name lookup for one definition.
 * @param {XdfFile} def
 * @returns {(idx: number) => string}
 */
function tnCategoryNamer(def) {
  const cats = def.header.categories || [];
  return (idx) => {
    const c = cats.find((x) => x.index === idx);
    return c ? c.name : `Category ${idx}`;
  };
}

/**
 * Group the items that pass the text and kind filters by category (an item
 * can appear in several; the uncategorised collect under "Other").
 * @param {XdfFile} def
 * @param {string} filter
 * @param {(idx: number) => string} catName
 * @returns {Map<string, XdfItem[]>} Category name -> items, in first-seen order.
 */
function tnBuildGroups(def, filter, catName) {
  const f = filter.trim().toLowerCase();
  const kinds = tuningState.kinds;
  const match = (it) =>
    (!kinds || kinds.has(it.kind)) &&
    (!f ||
      (it.title || '').toLowerCase().includes(f) ||
      (it.description || '').toLowerCase().includes(f) ||
      it.kind.includes(f));
  const groups = new Map();
  const push = (name, it) => {
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(it);
  };
  for (const it of def.items) {
    if (!match(it)) continue;
    if (it.categoryIndices && it.categoryIndices.length) {
      for (const ci of it.categoryIndices) push(catName(ci), it);
    } else {
      push('Other', it);
    }
  }
  return groups;
}

/**
 * Render the category sections into `listWrap`. Re-run on every filter,
 * chip or collapse change.
 * @param {TuningEditor} ed
 * @param {HTMLElement} listWrap
 * @param {XdfFile} def
 * @param {(idx: number) => string} catName
 * @returns {void}
 */
function tnRenderDefList(ed, listWrap, def, catName) {
  listWrap.innerHTML = '';
  const groups = tnBuildGroups(def, tuningState.filter, catName);
  if (!groups.size) {
    listWrap.appendChild(makeEmpty('⌕', 'No parameters match.', ''));
    return;
  }
  if (!tuningState.openCats) tuningState.openCats = new Set();
  if (!tuningState.shutCats) tuningState.shutCats = new Set();
  const open = tuningState.openCats;
  const shut = tuningState.shutCats; // explicitly collapsed while filtering
  // A live filter means the user is hunting: show what matched rather than
  // making them open sections to find it. With no filter, only what they
  // opened -- plus whichever section holds the row they have selected, so
  // an open editor never hides itself.
  const filtering = !!tuningState.filter.trim() || !!tuningState.kinds;

  let shown = 0;
  for (const [name, items] of groups) {
    const holdsSelected =
      tuningState.selectedId != null &&
      items.some((it) => it.key === tuningState.selectedId);
    // filtering opens everything that matched, EXCEPT a section the user
    // deliberately collapsed; otherwise a click on a filtered section
    // would do nothing and read as broken
    const isOpen =
      holdsSelected || (filtering ? !shut.has(name) : open.has(name));

    const cat = document.createElement('div');
    cat.className = 'tn-cat' + (isOpen ? ' open' : '');
    cat.innerHTML = `<button class="tn-cat-head" type="button"
            aria-expanded="${isOpen ? 'true' : 'false'}">
            <span class="tn-cat-caret">${isOpen ? '▾' : '▸'}</span>
            <span class="tn-cat-name">${esc(name)}</span>
            <span class="tn-cat-count">${items.length}</span>
          </button>`;
    const body = document.createElement('div');
    body.className = 'tn-cat-body';
    if (isOpen) {
      for (const it of items) {
        shown++;
        body.appendChild(tnRenderItemRow(ed, it));
      }
    } else {
      shown += items.length; // counted as present, just not drawn
    }
    cat.appendChild(body);

    cat.querySelector('.tn-cat-head').onclick = () => {
      // Toggle against whichever set governs the current mode, so the
      // click always visibly does something.
      if (filtering) {
        if (shut.has(name)) shut.delete(name);
        else shut.add(name);
      } else if (open.has(name)) {
        open.delete(name);
      } else {
        open.add(name);
      }
      tnRenderDefList(ed, listWrap, def, catName);
    };
    listWrap.appendChild(cat);
  }
  if (ed.els.hexMeta) ed.els.hexMeta.dataset.shown = String(shown);
}

/**
 * A single definition row; selecting it spotlights its bytes and expands
 * the editor beneath it (accordion: one open row at a time).
 * @param {TuningEditor} ed
 * @param {XdfItem} item
 * @returns {HTMLDivElement}
 */
function tnRenderItemRow(ed, item) {
  const row = document.createElement('div');
  row.className =
    'tn-item' + (tuningState.selectedId === item.key ? ' open' : '');
  const kindTag = TN_KIND_LABEL[item.kind] || item.kind;
  const addr = tnItemAddress(item);
  row.innerHTML = `
      <button class="tn-item-head" type="button">
        <span class="tn-item-kind tn-kind-${item.kind}">${kindTag}</span>
        <span class="tn-item-title">${esc(item.title || '(untitled)')}</span>
        <span class="tn-item-addr">${addr != null ? '0x' + addr.toString(16).toUpperCase() : ''}</span>
      </button>
      <div class="tn-item-body"></div>`;
  const headBtn = row.querySelector('.tn-item-head');
  const body = row.querySelector('.tn-item-body');
  headBtn.onclick = () => {
    const isOpen = tuningState.selectedId === item.key;
    // close others (accordion)
    ed.els.defs.querySelectorAll('.tn-item.open').forEach((n) => {
      n.classList.remove('open');
      const b = n.querySelector('.tn-item-body');
      if (b) b.innerHTML = '';
    });
    if (isOpen) {
      tuningState.selectedId = null;
      tuningState.highlight = null;
      ed.hex.refresh();
      return;
    }
    tuningState.selectedId = item.key;
    row.classList.add('open');
    tnRenderEditor(ed, item, body);
    tnSpotlight(ed, item);
  };
  if (tuningState.selectedId === item.key) {
    tnRenderEditor(ed, item, body);
    tnSpotlight(ed, item, { noScroll: !!ed.suppressSpotlightScroll });
  }
  return row;
}

/**
 * CLICK A MAPPED BYTE -> open the parameter that owns it.
 *
 * The reverse of tnSpotlight: instead of "show me where this parameter
 * lives", it answers "what is this byte?" -- which is the question you have
 * when staring at an unfamiliar image. Resolving it needs the owner index
 * built alongside the colour map, because a colour slot is shared by every
 * eighth region and cannot identify anything on its own.
 * @param {TuningEditor} ed
 * @param {number} off
 * @param {{ modal?: boolean }} [opts] - `modal:false` selects a table's row
 *   without opening its dialog (a plain click); the context menu's explicit
 *   "Open ..." leaves it on.
 * @returns {boolean} True when a parameter was opened, so the caller can
 *   fall through to other behaviour (raw editing) on an unmapped byte.
 */
function tnOpenItemAt(ed, off, opts = {}) {
  const rec = tnOwnerRecordAt(off);
  if (!rec) return false; // byte the definition does not describe

  // Highlight the WHOLE region, not just the byte, so the extent of the
  // thing you clicked is visible immediately.
  tuningState.highlight = { start: rec.start, end: rec.end };
  tuningState.selectedId = rec.item.key;

  // Open its section on the left and scroll the row into view. tnRenderDefs
  // re-renders the tree; the section holding the selected item is forced
  // open by the collapse logic, so the row is guaranteed to exist after.
  ed.suppressSpotlightScroll = true;
  try {
    tnRenderDefs(ed);
  } finally {
    ed.suppressSpotlightScroll = false;
  }
  const row = ed.els.defs.querySelector(`.tn-item.open`);
  if (row && row.scrollIntoView) {
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  // The selection becomes the whole region: no crosshair, no single cursor
  // byte, and the status strip names the parameter. The user is already
  // looking at these bytes, so no scroll.
  ed.hex.selectRegion(
    { start: rec.start, end: rec.end },
    { scroll: false, label: rec.item.title || '' }
  );
  ed.hex.refresh(); // repaint with the new highlight

  // A TABLE's home is the grid, not a row in the tree. From the context
  // menu's explicit "Open ..." that means the modal; a plain click only
  // selects the row on the left, so a click never throws a dialog over the
  // hex view.
  if (opts.modal !== false && rec.item.kind === 'table' && tuningState.bin) {
    tnOpenTableModal(ed, rec.item);
  }
  return true;
}

/**
 * Highlight an item's byte footprint in the hex view and, when the user
 * picked it in the tree, select its bytes and bring them on screen. A tree
 * re-render (filter, collapse) passes noScroll and must not touch the hex
 * selection -- that entanglement is what broke click-to-open the first time
 * round.
 * @param {TuningEditor} ed
 * @param {XdfItem} item
 * @param {{ noScroll?: boolean }} [opts]
 * @returns {void}
 */
function tnSpotlight(ed, item, opts = {}) {
  const range = tnItemByteRange(item);
  tuningState.highlight = range;
  ed.hex.refresh();
  if (range && !opts.noScroll)
    ed.hex.selectRegion(range, { scroll: true, label: item.title || '' });
}
