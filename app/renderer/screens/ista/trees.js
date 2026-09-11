/**
 * @file The ISTA pages that are a TREE beside a list: Service functions, and
 * the diagnosis structures (Fault pattern, Function Structure, Component
 * Structure).
 *
 * NO SECOND TREE WIDGET. All of these are the page the repair manual already
 * draws -- a tree on the left, a Type/Title list of what is under the picked
 * node on the right, a document over both when a row is opened. So each one
 * here is a SOURCE for screens/repair/browser.js and nothing more: a tree of
 * nodes, a way to list what is under one, and a way to render a document.
 * The tree, the selection, the hits line and the deep link all come from
 * there, which is why adding a page costs a source and not a file.
 *
 * SERVICE FUNCTIONS IS BUILT, NOT SHIPPED. ISTA's tree is the car's own
 * modules filed under Power train / Chassis and suspension / Body, and under
 * each module the routines that module performs. The app has both halves
 * already -- the chassis config knows which modules the car carries, the
 * service index knows which routines resolve to a key on which module -- so
 * the tree is those two joined, per car, rather than a fourth data file.
 */

/* exported istaServiceSource istaDiagSource istaDiagBodyHtml */

/**
 * One diagnosis document's body as HTML, in the repair manual's vocabulary.
 *
 * WHY THIS IS NOT repairDocHtml. A repair instruction is a numbered job: its
 * model is sections of STEPS, and the renderer draws a step number beside
 * each one because a mechanic says "I'm on four". A diagnosis document is
 * reference material -- a pin table, an installation location, a functional
 * description -- and numbering its paragraphs would invent a sequence that
 * is not in the source and tell a reader to work through a wiring table in
 * order. So the extract keeps its own block shape and this draws it.
 *
 * TABLES ARE WHY THE SHAPES CANNOT MERGE. 5,619 of E46's 8,311 bodies carry
 * one, and a pin table is the document a wrong read makes dangerous: its six
 * columns are what say which wire to back-probe. The repair step model has
 * no table, only the torque widget, which is four fixed columns with a
 * right-aligned figure -- so folding a pin table into it would misalign the
 * one table that must not be misaligned. A real table is drawn instead.
 *
 * Everything a repair document and a diagnosis document genuinely share is
 * shared: the same `.ista-repair` class names, so the two read identically,
 * and repairPicUrl for the figures, because the picture pool IS the repair
 * extract's and these documents reference it rather than owning it.
 * @param {object|null} body - the extracted body {title, kind, sections}
 * @returns {string} HTML
 */
function istaDiagBodyHtml(body) {
  if (!body || !(body.sections || []).length)
    return `<div class="rp-none">This document's body is not in this build.</div>`;

  /**
   * One content block.
   * @param {object} b - {t, s} or {t:'table', rows}
   * @returns {string} HTML
   */
  const block = (b) => {
    if (!b) return '';
    if (b.t === 'p') return `<p class="rp-step-p">${esc(b.s || '')}</p>`;
    if (b.t === 'bullet') return `<li>${esc(b.s || '')}</li>`;
    if (b.t === 'pic') {
      // the extract resolves a GRAPHIC to the pooled picture's stream id, so
      // the repair manual's own URL builder finds it; an unresolved figure
      // keeps its name in the data and is not drawn as a broken image
      const url =
        typeof repairPicUrl === 'function' && typeof b.s === 'number'
          ? repairPicUrl(b.s)
          : '';
      return url
        ? `<div class="rp-pics"><img class="rp-pic" loading="lazy" ` +
            `alt="Illustration" src="${esc(url)}"></div>`
        : '';
    }
    if (b.t === 'table') {
      const rows = b.rows || [];
      if (!rows.length) return '';
      // every row is padded to the widest, so a source that omits a trailing
      // empty cell cannot shift the column a reader counts across to
      const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
      const cells = (r, tag) => {
        let out = '';
        for (let i = 0; i < width; i++)
          out += `<${tag}>${esc(r[i] || '')}</${tag}>`;
        return out;
      };
      // `head: 0` marks a table whose first row is data (a legend's
      // name/explanation pairs); drawing it as a heading would lose a part
      const headed = b.head !== 0;
      const head = headed ? `<tr>${cells(rows[0], 'th')}</tr>` : '';
      const bodyRows = (headed ? rows.slice(1) : rows)
        .map((r) => `<tr>${cells(r, 'td')}</tr>`)
        .join('');
      // rp-tq is the repair manual's framed, banded table: nothing in its
      // styling is about torque, and reusing it is what keeps a pin table
      // looking like every other table in workshop mode
      return (
        `<div class="rp-tq"><table class="rp-tq-table">` +
        head +
        `<tbody>${bodyRows}</tbody></table></div>`
      );
    }
    return '';
  };

  const parts = [
    `<h2 class="rp-doc-h">${esc(body.title || '(untitled)')}</h2>`,
  ];
  for (const sec of body.sections || []) {
    // bullets are gathered into one list rather than each becoming its own,
    // which is what the source means by a run of LISTENTRYs
    let drawn = '';
    let bullets = '';
    for (const b of sec.blocks || []) {
      const html = block(b);
      if (!html) continue;
      if (b.t === 'bullet') {
        bullets += html;
        continue;
      }
      if (bullets) {
        drawn += `<ul class="rp-dg">${bullets}</ul>`;
        bullets = '';
      }
      drawn += html;
    }
    if (bullets) drawn += `<ul class="rp-dg">${bullets}</ul>`;
    if (!drawn) continue;
    parts.push(
      `<section class="rp-sec">` +
        (sec.heading ? `<div class="rp-sec-h">${esc(sec.heading)}</div>` : '') +
        `<div class="rp-step-body">${drawn}</div></section>`
    );
  }
  return parts.length > 1
    ? parts.join('')
    : parts[0] + `<div class="rp-none">This document has no content.</div>`;
}

/**
 * The Service functions source: the car's modules, and what each performs.
 *
 * A module with no routine in the index still gets its row: ISTA lists the
 * control unit whether or not it has a service function, and an empty module
 * says "nothing here for this car" where a missing one would read as a
 * module the car has not got.
 * @param {object|null} config - the chassis config
 * @param {object|null} index - the service index
 * @param {string} chassis - the chassis id
 * @param {(hit: object) => void} run - open a routine on the car
 * @returns {object} a BrowserSource
 */
function istaServiceSource(config, index, chassis, run) {
  const groups =
    typeof istaModuleGroups === 'function' ? istaModuleGroups(config) : [];

  // every routine the index resolved for this car, filed by the module it
  // runs on: the index is keyed by task, and the tree is keyed by module
  /** @type {Map<string, object[]>} */
  const bySgbd = new Map();
  const cats =
    typeof serviceTasksFor === 'function'
      ? serviceTasksFor(index, String(chassis || '').toUpperCase())
      : [];
  for (const cat of cats)
    for (const t of cat.tasks || [])
      for (const hit of t.hits || []) {
        const key = String(hit.sgbd || '').toLowerCase();
        if (!bySgbd.has(key)) bySgbd.set(key, []);
        bySgbd.get(key).push({
          id: `${hit.sgbd}:${hit.menu}:${hit.nr}`,
          title: (t.task && t.task.name) || hit.label || '',
          label: hit.label || '',
          hit,
          writes: !!hit.writes,
        });
      }

  const tree = groups.map((g) => ({
    id: g.name,
    label: g.name,
    n: g.ecus.reduce(
      (a, e) =>
        a + (bySgbd.get(String(e.sgbd || '').toLowerCase()) || []).length,
      0
    ),
    kids: g.ecus.map((e) => {
      const rows = bySgbd.get(String(e.sgbd || '').toLowerCase()) || [];
      return {
        id: String(e.sgbd || e.code || e.label),
        label: e.label || e.sgbd || '',
        n: rows.length,
        _rows: rows,
      };
    }),
  }));
  // the leaf ISTA puts at the bottom of every group: the app's own job
  // search, which is the same question asked across every script at once
  for (const g of tree)
    g.kids.push({
      id: `${g.id}::search`,
      label: '- Service functions search',
      n: 0,
      _search: true,
    });

  return {
    tree,
    list: (path) => {
      const node =
        typeof browserNodeAt === 'function' ? browserNodeAt(tree, path) : null;
      if (!node) return [];
      if (node._search) {
        if (typeof showJobSearch === 'function') showJobSearch();
        return [];
      }
      if (node._rows) return node._rows;
      // a group: everything under it, so picking Power train lists the
      // whole drivetrain's routines the way ISTA does
      const out = [];
      for (const k of node.kids || []) out.push(...(k._rows || []));
      return out;
    },
    rowType: () => 'ABL',
    rowTitle: (d) => d.title || d.label || '',
    docTitle: (d) => d.title || d.label || '',
    docId: (d) => d.id,
    // a service routine is not a document: opening it RUNS it on the car,
    // which is the whole point of the row, so the viewer never draws
    docHtml: async (d) => {
      if (typeof run === 'function') run(d.hit);
      return '';
    },
  };
}

/**
 * A diagnosis-structure source: Fault pattern, Function or Component.
 *
 * The three are one shape -- a tree of objects, each carrying the documents
 * BMW linked to it -- so they are one source with the tree handed in. The
 * data ships per chassis under data/ista/diag; a build without it draws an
 * empty tree that says so rather than failing.
 * @param {object|null} data - the extracted structure {tree}
 * @param {(doc: object) => Promise<string>} bodyOf - render a document
 * @returns {object} a BrowserSource
 */
function istaDiagSource(data, bodyOf) {
  // the extractor writes ONE root node per structure ("Fault patterns",
  // "Function net root"); a source wants the roots it shows, so the root's
  // own children are the tree and its label becomes the pane title. A file
  // that already holds a list is taken as it comes.
  const tree = !data
    ? []
    : Array.isArray(data)
      ? data
      : Array.isArray(data.tree)
        ? data.tree
        : Array.isArray(data.kids)
          ? data.kids
          : [];

  /**
   * Every document under a node, parents included.
   * @param {object} node - the node
   * @returns {object[]} its documents
   */
  const under = (node) => {
    const out = [];
    const walk = (n) => {
      for (const d of n.docs || []) out.push(d);
      for (const k of n.kids || []) walk(k);
    };
    if (node) walk(node);
    return out;
  };

  return {
    tree,
    list: (path) => {
      const node =
        typeof browserNodeAt === 'function' ? browserNodeAt(tree, path) : null;
      return node ? under(node) : [];
    },
    rowType: (d) => d.type || '-',
    rowTitle: (d) => d.title || '',
    docTitle: (d) => `${d.type || ''} ${d.title || ''}`.trim(),
    docId: (d) => String(d.id),
    // an SSP row is a wiring diagram, and this build ships none: E46 alone
    // references 10,048 of them and their SVGs come to tens of megabytes, so
    // they belong to the wiring importer rather than to this extract. The
    // row still lists -- ISTA holds the diagram and a reader should see that
    // it exists -- and says what it is instead of drawing anything.
    docHtml: (d) =>
      d && d.type === 'SSP'
        ? `<div class="rp-none">This is a wiring diagram. Diagrams are ` +
          `not in this build.</div>`
        : bodyOf(d),
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    istaServiceSource,
    istaDiagSource,
    istaDiagSearch,
    istaDiagBodyHtml,
  };
}

/**
 * Troubleshooting / Text Search: find a document across the three diagnosis
 * structures.
 *
 * The same centred form the repair manual's Text Search uses, because it is
 * the same question asked of a different shelf, and a technician should not
 * have to learn two search pages. The scopes it offers are the ones this
 * data can actually answer: the node titles and the document titles. A
 * document's BODY is a separate file per document, and fetching thousands of
 * them to answer a keystroke would cost more than the answer is worth, so
 * that box is shown disabled with the reason rather than silently matching
 * nothing.
 * @param {HTMLElement} host - where to draw
 * @param {object} ctx - {data: {tree} per structure, onOpen, onCount}
 * @returns {void}
 */
function istaDiagSearch(host, ctx) {
  let query = '';
  /** @type {object[]} */
  let hits = [];
  const scopes = { structures: true, title: true };

  /** Every document in every loaded structure, with the path that reaches it. */
  const all = () => {
    const out = [];
    for (const [where, data] of Object.entries(ctx.data || {})) {
      const roots = !data
        ? []
        : Array.isArray(data)
          ? data
          : Array.isArray(data.tree)
            ? data.tree
            : Array.isArray(data.kids)
              ? data.kids
              : [];
      const walk = (n, trail) => {
        const here = trail.concat([n.label || '']);
        for (const d of n.docs || [])
          out.push({ doc: d, where, path: here.join(' > ') });
        for (const k of n.kids || []) walk(k, here);
      };
      for (const r of roots) walk(r, []);
    }
    return out;
  };

  /** Run the search and redraw the rows. */
  const run = () => {
    const q = query.trim().toLowerCase();
    hits = [];
    if (q.length >= 2) {
      const seen = new Set();
      for (const row of all()) {
        const inTitle =
          scopes.title &&
          String(row.doc.title || '')
            .toLowerCase()
            .includes(q);
        const inPath = scopes.structures && row.path.toLowerCase().includes(q);
        if (!inTitle && !inPath) continue;
        const key = `${row.where}:${row.doc.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push(row);
        if (hits.length >= 500) break;
      }
    }
    paint();
    if (ctx.onCount) ctx.onCount(hits.length);
  };

  /** Draw the form and whatever the last search found. */
  function paint() {
    const box = (id, label, note) =>
      `<label class="rp-check${note ? ' rp-check-off' : ''}">` +
      `<input type="checkbox" data-scope="${esc(id)}"` +
      `${scopes[id] ? ' checked' : ''}${note ? ' disabled' : ''}> ` +
      `<span>${esc(label)}</span>` +
      (note ? `<span class="rp-check-note">${esc(note)}</span>` : '') +
      `</label>`;
    host.innerHTML =
      `<div class="ista-repair"><div class="rp-search">` +
      `<div class="rp-search-form">` +
      `<label class="rp-search-label" for="ista-dq">Search string:</label>` +
      `<input type="search" id="ista-dq" class="rp-search-input" ` +
      `value="${esc(query)}">` +
      box('structures', 'Search in structures') +
      box('title', 'Search in document title') +
      box('document', 'Search in document', 'not in this build') +
      box('number', 'Search for the document number', 'not in this build') +
      `</div>` +
      (hits.length
        ? `<table class="irtable"><thead><tr><th>Type</th><th>Title</th>` +
          `</tr></thead><tbody>` +
          hits
            .map(
              (h, i) =>
                `<tr data-h="${i}"><td>${esc(h.doc.type || '-')}</td>` +
                `<td>${esc(h.doc.title || '')}</td></tr>`
            )
            .join('') +
          `</tbody></table>`
        : query.trim().length >= 2
          ? `<div class="irvin-empty">Nothing matched.</div>`
          : '') +
      `</div></div>`;

    const q = host.querySelector('#ista-dq');
    q.oninput = () => {
      query = q.value;
    };
    q.onkeydown = (e) => {
      if (e.key === 'Enter') run();
    };
    host.querySelectorAll('[data-scope]').forEach((el) => {
      el.onchange = () => {
        scopes[el.dataset.scope] = el.checked;
      };
    });
    host.querySelectorAll('tbody tr[data-h]').forEach((tr) => {
      tr.onclick = () => {
        host.querySelectorAll('tbody tr.sel').forEach((x) => {
          x.classList.remove('sel');
        });
        tr.classList.add('sel');
      };
      tr.ondblclick = () => {
        if (ctx.onOpen) ctx.onOpen(hits[Number(tr.dataset.h)]);
      };
    });
    host._istaSearch = { run, pick: () => hits };
  }
  paint();
}
