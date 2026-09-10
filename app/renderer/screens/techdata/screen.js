/**
 * @file The Workshop tab: technical data, tightening torques, operating
 * fluids and special tools, browsed the way ISTA browses them.
 *
 * Three sub-sections, as the original has: a two-pane browser (category tree
 * on the left, a Type / Title table on the right), a free-text search, and
 * the hit list the last search or tree pick produced.
 *
 * The car filter is on by default. A workshop looking up a torque figure
 * wants THIS car's figure, and the whole catalogue is nineteen thousand
 * documents across every model BMW has made -- unfiltered it is not a list,
 * it is a haystack. "Show all" is there for the times the filter is wrong
 * (a document whose validity rule did not decode, a part shared with a model
 * the car is not), and the counts in the tree follow whichever is on so the
 * two never disagree.
 */

/* exported showTechData */

/** The sub-sections, in bar order. */
const TECHDATA_SECTIONS = [
  { id: 'browse', label: 'Workshop Equipment' },
  { id: 'search', label: 'Text Search' },
  { id: 'hits', label: 'Hit list' },
];

/** Rows drawn in one go before the table stops. */
const TECHDATA_ROW_CAP = 500;

/**
 * What the tab is showing.
 * @type {{section: string, group: string|null, cls: string|null,
 *   query: string, hits: object[], all: boolean, open: object|null}}
 */
const techDataState = {
  section: 'browse',
  group: null,
  cls: null,
  query: '',
  hits: [],
  all: false,
  open: null,
};

/** The documents in scope for the current car filter. @type {object[]} */
let techDataScope = [];
/** Collapsed tree nodes, by group id. @type {Set<string>} */
const techDataCollapsed = new Set();

/**
 * Re-resolve which documents are in scope for the picked car.
 * @param {object|null} car - the picked GarageCar
 * @param {string} chassis - the chassis
 * @returns {Promise<{exact: boolean, typeKey: string|null, total: number}>}
 */
async function techDataRescope(car, chassis) {
  const idx = await techDataIndex();
  const docs = (idx && idx.docs) || [];
  if (techDataState.all) {
    techDataScope = docs.slice();
    return { exact: false, typeKey: null, total: docs.length };
  }
  const keys = await techDataCarKeys(car, chassis);
  techDataScope = techDataFilter(docs, keys.ids);
  return { exact: keys.exact, typeKey: keys.typeKey, total: docs.length };
}

/**
 * The rows for the right-hand pane, given what is selected.
 * @returns {object[]}
 */
function techDataRows() {
  if (techDataState.section === 'search' || techDataState.section === 'hits')
    return techDataState.hits;
  let rows = techDataScope;
  if (techDataState.group != null)
    rows = rows.filter(
      (d) => String(d.mainGroup || '0') === techDataState.group
    );
  if (techDataState.cls) rows = rows.filter((d) => d.cls === techDataState.cls);
  return rows;
}

/**
 * The Type / Title table.
 * @param {object[]} rows - the documents
 * @returns {string} HTML
 */
function techDataTableHtml(rows) {
  if (!rows.length)
    return `<div class="td-none">Nothing here for this vehicle. Turn on Show all to see every document.</div>`;
  const shown = rows.slice(0, TECHDATA_ROW_CAP);
  const body = shown
    .map(
      (d, i) =>
        `<tr class="td-row" data-i="${i}">` +
        `<td class="td-type">${esc(d.type || '')}` +
        (d.unsure
          ? `<span class="td-flag" title="Applicability could not be read">?</span>`
          : '') +
        `</td>` +
        `<td class="td-title">${esc(d.title || '(untitled)')}` +
        (d.subGroupName
          ? `<span class="td-sub">${esc(d.subGroupName)}</span>`
          : '') +
        `</td></tr>`
    )
    .join('');
  return (
    `<div class="td-table-wrap"><table class="td-table td-hits">` +
    `<thead><tr><th>Type</th><th>Title</th></tr></thead>` +
    `<tbody>${body}</tbody></table></div>` +
    (rows.length > shown.length
      ? `<p class="td-more">${rows.length - shown.length} more not shown. ` +
        `Narrow it with the tree or a search.</p>`
      : '')
  );
}

/**
 * The category tree.
 * @param {object} idx - the index (for the equipment node names)
 * @returns {string} HTML
 */
function techDataTreeHtml(idx) {
  const groups = techDataGroups(techDataScope);
  // ISTA's equipment nodes name the top level where the data has no name of
  // its own; a group the data does not fill is shown empty rather than hidden
  const named = new Map(
    ((idx && idx.equipmentTree) || []).map((n) => [n.id, n.name])
  );
  const rows = groups
    .map((g) => {
      const open = !techDataCollapsed.has(g.id);
      const on = techDataState.group === g.id && !techDataState.cls;
      const name = g.name || named.get(g.id) || `Group ${g.id}`;
      const kids = new Map();
      for (const d of techDataScope) {
        if (String(d.mainGroup || '0') !== g.id) continue;
        kids.set(d.type, (kids.get(d.type) || 0) + 1);
      }
      const clsRows = open
        ? [...kids.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([label, n]) => {
              const cls = (
                techDataScope.find(
                  (d) => String(d.mainGroup || '0') === g.id && d.type === label
                ) || {}
              ).cls;
              const sel =
                techDataState.group === g.id && techDataState.cls === cls;
              return (
                `<button type="button" class="td-node td-node-cls` +
                `${sel ? ' on' : ''}" data-group="${esc(g.id)}" ` +
                `data-cls="${esc(cls || '')}">` +
                `<span class="td-node-name">${esc(label)}</span>` +
                `<span class="td-node-n">${n}</span></button>`
              );
            })
            .join('')
        : '';
      return (
        `<div class="td-branch">` +
        `<button type="button" class="td-node td-node-top${on ? ' on' : ''}" ` +
        `data-group="${esc(g.id)}" aria-expanded="${open}">` +
        `<span class="td-twist">${open ? '▾' : '▸'}</span>` +
        `<span class="td-node-num">${esc(g.id)}</span>` +
        `<span class="td-node-name">${esc(name)}</span>` +
        `<span class="td-node-n">${g.count}</span></button>` +
        clsRows +
        `</div>`
      );
    })
    .join('');
  return (
    `<div class="td-tree-head">` +
    `<span class="td-tree-title">Categories</span>` +
    `<button type="button" class="btn td-collapse">Collapse all</button>` +
    `</div><div class="td-tree-body">${rows || '<div class="td-none">No categories.</div>'}</div>`
  );
}

/**
 * The Workshop tab.
 * @param {HTMLElement} host - where to draw
 * @param {object|null} car - the picked GarageCar
 * @param {string} chassis - the chassis
 * @returns {Promise<void>}
 */
async function showTechData(host, car, chassis) {
  host.innerHTML =
    `<div class="td-wrap"><div class="td-loading">` +
    `<span class="wiring-spinner"></span>` +
    `<span>Loading the reference documents…</span></div></div>`;
  const idx = await techDataIndex();
  if (!host.isConnected) return;
  if (!idx) {
    host.innerHTML =
      `<div class="ista-none-box">No workshop reference data in this ` +
      `build. Run tools/ista/technical_data_extract.py to add it.</div>`;
    return;
  }
  const scope = await techDataRescope(car, chassis);
  if (!host.isConnected) return;

  host.innerHTML =
    `<div class="td-wrap">` +
    `<div class="td-bar">` +
    TECHDATA_SECTIONS.map(
      (s) =>
        `<button type="button" class="td-sec` +
        `${s.id === techDataState.section ? ' on' : ''}" ` +
        `data-sec="${esc(s.id)}">${esc(s.label)}</button>`
    ).join('') +
    `<span class="td-bar-spacer"></span>` +
    `<label class="td-all"><input type="checkbox" id="td-all"` +
    `${techDataState.all ? ' checked' : ''}> Show all</label>` +
    `<span class="td-scope"></span>` +
    `</div>` +
    `<div class="td-body"></div></div>`;
  const body = host.querySelector('.td-body');
  const scopeEl = host.querySelector('.td-scope');

  const sayScope = () => {
    scopeEl.textContent = techDataState.all
      ? `${scope.total} documents, every vehicle`
      : `${techDataScope.length} of ${scope.total} for this vehicle` +
        (scope.exact ? ` (${scope.typeKey})` : ' (by chassis)');
  };

  /** Redraw the pane for the current section and selection. */
  const paint = () => {
    sayScope();
    if (techDataState.open) {
      body.innerHTML =
        `<div class="td-doc"><button type="button" class="btn td-back">` +
        `Back to the list</button><div class="td-doc-body"></div></div>`;
      const docHost = body.querySelector('.td-doc-body');
      docHost.innerHTML = `<div class="td-loading"><span class="wiring-spinner"></span><span>Opening…</span></div>`;
      const doc = techDataState.open;
      techDataBody(doc).then((b) => {
        if (techDataState.open === doc && docHost.isConnected)
          docHost.innerHTML = techDataDocHtml(doc, b);
      });
      body.querySelector('.td-back').onclick = () => {
        techDataState.open = null;
        paint();
      };
      return;
    }
    if (techDataState.section === 'search') {
      body.innerHTML =
        `<div class="td-search"><input type="search" id="td-q" ` +
        `class="td-q" placeholder="Search every title in this tab" ` +
        `value="${esc(techDataState.query)}"></div>` +
        `<div class="td-results">${
          techDataState.query
            ? techDataTableHtml(techDataState.hits)
            : '<div class="td-none">Type to search the documents in scope.</div>'
        }</div>`;
      const q = body.querySelector('#td-q');
      q.oninput = () => {
        techDataState.query = q.value;
        techDataState.hits = techDataSearch(techDataScope, q.value);
        body.querySelector('.td-results').innerHTML = techDataState.query
          ? techDataTableHtml(techDataState.hits)
          : '<div class="td-none">Type to search the documents in scope.</div>';
        wireRows();
      };
      q.focus();
      wireRows();
      return;
    }
    if (techDataState.section === 'hits') {
      body.innerHTML = `<div class="td-results">${
        techDataState.hits.length
          ? techDataTableHtml(techDataState.hits)
          : '<div class="td-none">No hits yet. Search, or pick a category.</div>'
      }</div>`;
      wireRows();
      return;
    }
    // the browser: tree beside the table
    body.innerHTML =
      `<div class="td-split">` +
      `<aside class="td-tree">${techDataTreeHtml(idx)}</aside>` +
      `<section class="td-results">${techDataTableHtml(techDataRows())}</section>` +
      `</div>`;
    body.querySelectorAll('.td-node-top').forEach((b) => {
      b.onclick = () => {
        const g = b.dataset.group;
        // clicking the node it is already on collapses it; otherwise select
        if (techDataState.group === g && !techDataState.cls) {
          if (techDataCollapsed.has(g)) techDataCollapsed.delete(g);
          else techDataCollapsed.add(g);
        } else {
          techDataCollapsed.delete(g);
        }
        techDataState.group = g;
        techDataState.cls = null;
        techDataState.hits = techDataRows();
        paint();
      };
    });
    body.querySelectorAll('.td-node-cls').forEach((b) => {
      b.onclick = () => {
        techDataState.group = b.dataset.group;
        techDataState.cls = b.dataset.cls || null;
        techDataState.hits = techDataRows();
        paint();
      };
    });
    const collapse = body.querySelector('.td-collapse');
    if (collapse)
      collapse.onclick = () => {
        techDataGroups(techDataScope).forEach((g) =>
          techDataCollapsed.add(g.id)
        );
        paint();
      };
    wireRows();
  };

  /** Make each drawn row open its document. */
  function wireRows() {
    const rows = techDataRows();
    body.querySelectorAll('.td-row').forEach((tr) => {
      tr.onclick = () => {
        const d = rows[Number(tr.dataset.i)];
        if (!d) return;
        techDataState.open = d;
        paint();
      };
    });
  }

  host.querySelectorAll('.td-sec').forEach((b) => {
    b.onclick = () => {
      techDataState.section = b.dataset.sec;
      techDataState.open = null;
      host
        .querySelectorAll('.td-sec')
        .forEach((x) => x.classList.toggle('on', x === b));
      paint();
    };
  });
  const all = host.querySelector('#td-all');
  all.onchange = async () => {
    techDataState.all = all.checked;
    const next = await techDataRescope(car, chassis);
    scope.exact = next.exact;
    scope.typeKey = next.typeKey;
    techDataState.hits = techDataRows();
    paint();
  };

  paint();
}

if (typeof window !== 'undefined') {
  window.showTechData = showTechData;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TECHDATA_SECTIONS,
    TECHDATA_ROW_CAP,
    techDataState,
    techDataTableHtml,
    techDataTreeHtml,
    showTechData,
  };
}
