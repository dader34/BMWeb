/**
 * @file The Repair/maintenance sub-tab: the repair manual, browsed and
 * searched the way ISTA browses it.
 *
 * Two views behind a level-3 tab strip of their own, exactly as the
 * original has them: PRODUCT STRUCTURE, the group tree beside a Type/Title
 * list, and TEXT SEARCH, a form with the four scopes ISTA offers. Either
 * opens a document, which replaces the panes with the instruction itself.
 *
 * THE PAGE ITSELF IS screens/repair/browser.js, and deliberately so: ISTA
 * draws Fault pattern, Function Structure and Component Structure with the
 * same tree-list-document page and only different data. This file is the
 * repair manual's SOURCE for that page -- a tree, a way to list what is
 * under a node, and a way to render a document -- so those other trees can
 * be added by writing a source rather than by copying a screen.
 *
 * NOTHING HERE TOUCHES THE CAR. The section works from the Garage car's
 * chassis alone -- it is a manual, not a diagnostic -- so arriving on it
 * never puts a byte on the bus. That is also why it is safe to deep-link
 * into: opening a link to a document cannot start anything.
 */

/* exported showRepair */

/** The two views, in strip order. */
/**
 * The two views, keyed by the LEVEL-3 TAB IDS the shell routes with.
 *
 * They used to have ids of their own ('structure', 'search') from when this
 * section drew its own view picker. The shell's level-3 strip is that picker
 * now, so a second set of names would be two vocabularies for one choice and
 * a deep link would have to be translated between them.
 */
/**
 * Whether the body-text index has loaded, so the "Search in document" box
 * can be live rather than greyed. Asked for on the first body search: the
 * blob is worth fetching only when the reader actually wants it.
 */
let repairBodyReady = false;
/** Whether the index was asked for and answered, so "none" means none. */
let repairBodyTried = false;

const REPAIR_VIEWS = [
  { id: 'product-structure', label: 'Product Structure' },
  { id: 'text-search', label: 'Text Search' },
];

/**
 * What the section is showing. Kept at module scope so leaving the sub-tab
 * and coming back lands where the reader left, which is what a workshop
 * expects of a manual it was halfway through.
 * @type {object}
 */
const repairState = {
  view: 'product-structure',
  query: '',
  scopes: { structures: true, title: true, document: false, number: false },
  /** the Product Structure browser's own state */
  browse: { path: null, open: new Set(), hits: [], doc: null, loading: null },
  /** the Text Search results, shown in the same Type/Title table */
  found: [],
  foundDoc: null,
};

/**
 * Put the current view and open document in the URL.
 *
 * Positional slots mean a view can only be stamped once the car is known,
 * so a reader with no saved car still browses -- they just do not get a
 * link. istaRouteStamp owns the first three slots; this adds the last two.
 * @returns {void}
 */
function repairStamp() {
  if (typeof history === 'undefined' || !history.replaceState) return;
  if (typeof istaRouteBuild !== 'function') return;
  const car =
    typeof istaState === 'object' && istaState && istaState.car
      ? istaState.car.id
      : null;
  if (!car) return;
  const open =
    repairState.view === 'text-search'
      ? repairState.foundDoc
      : repairState.browse.doc;
  // the six-slot grammar: the view is the LEVEL-3 tab, and the car sits
  // after it. Writing the old five-slot shape put the view where the shell
  // reads the car.
  const route = istaRouteBuild(
    'management',
    'repair',
    repairState.view,
    car,
    repairState.view,
    open ? String(open.id) : null
  );
  history.replaceState(null, '', '#' + route);
}

/**
 * The repair manual as a browser source.
 *
 * Everything the generic page needs to know about repair instructions is
 * here and nowhere else.
 * @param {object} idx - the chassis index
 * @param {string} chassis - the development code
 * @returns {object} a BrowserSource
 */
function repairSource(idx, chassis) {
  return {
    tree: repairBrowserTree(idx),
    /**
     * Every document under a node.
     * @param {string[]} path - the node's ids
     * @returns {object[]}
     */
    list: (path) => repairDocsUnder(idx, path),
    /**
     * The Type column: ISTA's short document-class code.
     * @param {object} d - an index entry
     * @returns {string}
     */
    rowType: (d) => String(d.type || ''),
    /**
     * The Title column.
     * @param {object} d - an index entry
     * @returns {string}
     */
    rowTitle: (d) => String(d.title || '(untitled)'),
    /**
     * The viewer's title bar: number, title, and the unsure mark.
     * @param {object} d - an index entry
     * @returns {string}
     */
    docTitle: (d) => {
      const num = repairDocNumber(d);
      return (
        (num ? `${num} - ` : '') +
        String(d.title || '(untitled)') +
        (d.unsure ? ' (applicability unread)' : '')
      );
    },
    /**
     * The document's body, fetched and drawn.
     * @param {object} d - an index entry
     * @returns {Promise<string>}
     */
    docHtml: async (d) =>
      repairDocHtml(d, await repairBody(chassis, d), chassis),
  };
}

/**
 * The Text Search form: ISTA's four scopes, and what this build can honour.
 * @returns {string} HTML
 */
function repairSearchFormHtml() {
  const box = (id, label, note) => {
    const on = !!repairState.scopes[id];
    // the body box was pinned disabled for good, and ticking it was what
    // fetched the index: a box nobody can tick never asks. It is live once
    // the index has loaded, and the view asks for the index on open.
    const off = id === 'document' && !repairBodyReady;
    return (
      `<label class="rp-check${off ? ' rp-check-off' : ''}">` +
      `<input type="checkbox" data-scope="${esc(id)}"` +
      `${on ? ' checked' : ''}${off ? ' disabled' : ''}> ` +
      `<span>${esc(label)}</span>` +
      (note ? `<span class="rp-check-note">${esc(note)}</span>` : '') +
      `</label>`
    );
  };
  return (
    `<div class="rp-search-form">` +
    `<label class="rp-search-label" for="rp-q">Search string:</label>` +
    `<input type="search" id="rp-q" class="rp-search-input" ` +
    `value="${esc(repairState.query)}">` +
    box('structures', 'Search in structures') +
    box('title', 'Search in document title') +
    // live once the body-text index has loaded; until then it says why
    box(
      'document',
      'Search in document',
      repairBodyReady
        ? ''
        : repairBodyTried
          ? 'no text index in this build'
          : 'loading the text index'
    ) +
    box('number', 'Search for the document number') +
    `</div>`
  );
}

/**
 * The Repair/maintenance sub-tab.
 * @param {HTMLElement} host - where to draw
 * @param {object|null} car - the picked GarageCar
 * @param {string} chassis - the chassis
 * @returns {Promise<void>}
 */
async function showRepair(host, car, chassis, view) {
  const code = String(chassis || '').toUpperCase();
  host.innerHTML =
    `<div class="ista-repair"><div class="rp-loading">` +
    `<span class="wiring-spinner"></span>` +
    `<span>Loading the repair manual…</span></div></div>`;
  const idx = await repairIndex(code);
  if (!host.isConnected) return;
  if (!idx) {
    host.innerHTML =
      `<div class="ista-none-box">No repair data in this build for ` +
      `${esc(code || 'this vehicle')}. Run tools/ista/repair_extract.py ` +
      `to add it.</div>`;
    return;
  }
  const src = repairSource(idx, code);

  // a deep link naming a view and a document opens both, before anything
  // is drawn, so the reader lands on the page the link meant
  const route =
    typeof istaRouteParse === 'function' && typeof location !== 'undefined'
      ? istaRouteParse(String(location.hash || '').replace(/^#/, ''))
      : null;
  // THE SHELL OWNS THE VIEW. Its level-3 strip is what the reader pressed,
  // so an explicit view wins over anything left in the URL; the route is
  // still read for the document, which only this section knows how to find.
  if (view && REPAIR_VIEWS.some((v) => v.id === view)) repairState.view = view;
  if (route && route.sub === 'repair') {
    if (!view && route.view && REPAIR_VIEWS.some((v) => v.id === route.view))
      repairState.view = route.view;
    if (route.item) {
      const doc = repairFindDoc(idx, route.item);
      if (doc) {
        // land the tree on the document's own subgroup, so closing it shows
        // the neighbours rather than an empty pane
        const path = [String(doc.g), String(doc.s)];
        repairState.browse.path = path;
        repairState.browse.open.add(path[0]);
        repairState.browse.open.add(path.join('/'));
        repairState.browse.hits = repairDocsUnder(idx, path);
        const match = repairState.browse.hits.find(
          (d) => String(d.id) === String(doc.id)
        );
        if (repairState.view === 'text-search') repairState.foundDoc = doc;
        else repairState.browse.doc = match || doc;
      }
    }
  }

  // no view picker of its own: the shell's level-3 strip is that picker, and
  // drawing a second row of the same two names under it would be two
  // controls for one choice
  host.innerHTML = `<div class="ista-repair"><div class="rp-body"></div></div>`;
  const body = host.querySelector('.rp-body');

  /** Redraw whichever view is on. */
  function paint() {
    repairStamp();
    if (repairState.view === 'product-structure') {
      browserPaint(body, src, repairState.browse, {
        emptyTitle: 'Product structure',
        onChange: repairStamp,
      });
      return;
    }
    paintSearch();
  }

  /** The Text Search view: the form, its results, and an opened document. */
  function paintSearch() {
    if (repairState.foundDoc) {
      // the search results ARE the hit list the viewer steps through, so
      // the same browser state shape is handed to the same painter
      browserPaint(
        body,
        src,
        {
          path: null,
          open: new Set(),
          hits: repairState.found,
          doc: repairState.foundDoc,
          loading: null,
        },
        {
          onChange: (st) => {
            repairState.foundDoc = st.doc;
            repairStamp();
            if (!st.doc) paintSearch();
          },
        }
      );
      return;
    }
    const rows = repairState.found;
    body.innerHTML =
      `<div class="rp-search">` +
      repairSearchFormHtml() +
      `<div class="rp-results">${
        repairState.query
          ? browserRowsHtml(rows, src)
          : `<div class="rp-none">Type a search string.</div>`
      }</div></div>` +
      `<div class="rp-status">` +
      `<span class="rp-hits">Hits: ${rows.length} / ${rows.length}` +
      `&nbsp;&nbsp;Filter: Default</span>` +
      `<span class="rp-bottom">` +
      `<button type="button" class="rp-btn" disabled>Keyboard</button>` +
      `<button type="button" class="rp-btn rp-go">Start search</button>` +
      `</span></div>`;
    const q = body.querySelector('#rp-q');
    /** Re-run the search and redraw. */
    const run = () => {
      repairState.query = q.value;
      repairState.found = repairSearch(idx, q.value, repairState.scopes);
      paintSearch();
      const again = body.querySelector('#rp-q');
      if (again) {
        again.focus();
        again.setSelectionRange(again.value.length, again.value.length);
      }
    };
    q.oninput = () => {
      repairState.query = q.value;
      repairState.found = repairSearch(idx, q.value, repairState.scopes);
      body.querySelector('.rp-results').innerHTML = repairState.query
        ? browserRowsHtml(repairState.found, src)
        : `<div class="rp-none">Type a search string.</div>`;
      const hits = body.querySelector('.rp-hits');
      if (hits)
        hits.innerHTML =
          `Hits: ${repairState.found.length} / ${repairState.found.length}` +
          `&nbsp;&nbsp;Filter: Default`;
      wireFound();
    };
    // the body index is asked for when the search view opens, once per
    // chassis, so the box goes live by itself; ticking it before the index
    // lands simply searches the other scopes until the redraw
    if (!repairBodyReady && !repairBodyTried) {
      repairBodyTried = true;
      repairBodyIndex(chassis).then((ok) => {
        repairBodyReady = ok;
        if (body.isConnected) paint();
      });
    }
    body.querySelectorAll('[data-scope]').forEach((cb) => {
      cb.onchange = () => {
        repairState.scopes[cb.dataset.scope] = cb.checked;
        run();
      };
    });
    const go = body.querySelector('.rp-go');
    if (go) go.onclick = run;
    q.focus();
    wireFound();
  }

  /** Make each search result open its document. */
  function wireFound() {
    body.querySelectorAll('.rp-row').forEach((tr) => {
      tr.onclick = () => {
        const d = repairState.found[Number(tr.dataset.i)];
        if (!d) return;
        repairState.foundDoc = d;
        paintSearch();
      };
    });
  }

  paint();
}

if (typeof window !== 'undefined') {
  window.showRepair = showRepair;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    REPAIR_VIEWS,
    repairState,
    repairSource,
    repairSearchFormHtml,
    showRepair,
  };
}
