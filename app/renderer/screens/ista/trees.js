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

/* exported istaServiceSource istaDiagSource */

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
  const tree = (data && data.tree) || [];

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
    docHtml: (d) => bodyOf(d),
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { istaServiceSource, istaDiagSource };
}
