/**
 * @file The trees ISTA's structure pages browse, as the tool builds them.
 *
 * EVERY STRUCTURE PAGE IN THE TOOL IS ONE MECHANISM (InfoBrowserTreeFactory,
 * DiagnosisObjectsTree, DiagnosisObjectsTreeNode, InfoObjFilter): a tree of
 * diagnosis objects from one root, the documents linked to the picked node
 * and to everything shown beneath it, and a filter by document type. The
 * pages differ in two things only:
 *
 *   Product structure    the product root        the tool's default types
 *   Operating fluids     the product root AGAIN  SBS, SWZ, MSM, SWS
 *   Workshop equipment   the "SWS" register      SBS, SWZ, MSM, SWS
 *   Mobile service       the "MOB" register      no type filter
 *
 * tools/ista/info_tree_extract.py ships each chassis's trees with the rule
 * of every node and document that the chassis alone could not rule out.
 * This asks those rules of the ONE car, which is the question the tool asks
 * (IsNodePathValid, IsInfoObjectValid), and hands the result to the browser
 * as a source.
 *
 * A document is drawn by whichever store holds its body: the repair manual
 * (REP), the workshop reference documents (TED, AZD, SBS, SWZ, SWS), the
 * bodies the tree extract ships beside the trees (every other type), or
 * the diagnosis documents. One this build has no body for is listed all
 * the same, because the tool lists it, and says so when opened.
 */

/* exported ISTA_INFO_TYPES istaInfoTreeLoad istaInfoNodes istaInfoDocsUnder
   istaInfoSource istaInfoTypeOk ISTA_INFO_DIALOG_TYPES istaInfoFilterSet
   istaInfoFilterDefault istaInfoFilterSame istaInfoTypeLabels */

/**
 * InfoObjFilter.SetDefault: the document types a page lists until the
 * reader changes the filter. `null` is the filter that passes everything
 * (the tool's "bogus" filter, which Mobile service uses).
 */
const ISTA_INFO_TYPES = {
  // InfoTypesUserSelection's default
  default:
    'FTD,KFA,SIT,MSM,SSP,ABL,FUB,FEB,TED,SPI,AZD,REP,EBO,PIB,STA,SBS,COM,REH,SWS',
  // MACHINERYMATERIALS and WORKSHOPQUIPMENT
  workshop: 'SBS,SWZ,MSM,SWS',
  // MOBILESERVICE
  mobile: null,
};

/**
 * The types the Filters dialog offers, in the order its layout places
 * them (InteractionFilterSettingsView: two columns, read down).
 */
const ISTA_INFO_DIALOG_TYPES = [
  'FTD',
  'KFA',
  'SIT',
  'MSM',
  'SSP',
  'ABL',
  'FUB',
  'FEB',
  'COM',
  'REH',
  'STA',
  'TED',
  'EBO',
  'SPI',
  'PIB',
  'AZD',
  'SWZ',
  'REP',
  'SBS',
  'SWS',
];

/**
 * Select all / Select nothing (InteractionFilterSettingsViewModel.SetAll):
 * every type the tool's user selection names is switched; one it does not
 * name is left as it was. Special tools (SWZ) are not in that selection,
 * so neither button touches them.
 * @param {Set<string>} on - the ticked types, changed in place
 * @param {boolean} state - tick or clear
 * @returns {Set<string>} `on`
 */
function istaInfoFilterSet(on, state) {
  for (const t of ISTA_INFO_TYPES.default.split(',')) {
    if (state) on.add(t);
    else on.delete(t);
  }
  return on;
}

/**
 * Default settings (ExecuteSetDefaultSettings): for the fault pattern page
 * SIT and ABL alone; for every other page everything, less special tools.
 * It is the same on the workshop pages, whose own starting filter is a
 * different one, so there it reads as user-defined afterwards.
 * @param {boolean} fault - the fault pattern page's dialog
 * @returns {Set<string>}
 */
function istaInfoFilterDefault(fault) {
  if (fault) return new Set(['SIT', 'ABL']);
  const on = istaInfoFilterSet(new Set(), true);
  on.delete('SWZ');
  return on;
}

/**
 * InfoObjFilter.IsDefault: whether a filter ticks exactly the types the
 * page's starting filter does.
 * @param {string|null} types - the filter's comma list
 * @param {string|null} start - the page's starting list
 * @returns {boolean}
 */
function istaInfoFilterSame(types, start) {
  const has = (list, t) => list != null && String(list).includes(t);
  return ISTA_INFO_DIALOG_TYPES.every((t) => has(types, t) === has(start, t));
}

/** @type {Promise<object>|null} the dialog's type names */
let istaInfoTypeLabelsCache = null;

/**
 * The names the Filters dialog gives the types ("Repair Instructions
 * (REP)"), or an empty table: the tool shows the bare abbreviation for a
 * type it has no name for, and so does the dialog.
 * @returns {Promise<Object<string, string>>}
 */
function istaInfoTypeLabels() {
  if (!istaInfoTypeLabelsCache)
    istaInfoTypeLabelsCache =
      typeof hfFetchFirst === 'function'
        ? hfFetchFirst('ista/infotree/types.json')
            .then((d) => d || {})
            .catch(() => ({}))
        : Promise.resolve({});
  return istaInfoTypeLabelsCache;
}

/** @type {Map<string, Promise<object|null>>} chassis -> its trees */
const istaInfoTreeCache = new Map();

/**
 * A chassis's trees, or null when this build ships none for it.
 * @param {string} chassis - the chassis id
 * @returns {Promise<object|null>} {trees: {product, sws, mob}, docs}
 */
function istaInfoTreeLoad(chassis) {
  const key = String(chassis || '').toUpperCase();
  if (!key) return Promise.resolve(null);
  if (!istaInfoTreeCache.has(key))
    istaInfoTreeCache.set(
      key,
      typeof hfFetchFirst === 'function'
        ? hfFetchFirst(`ista/infotree/${key}.json.gz`, { as: 'gzjson' })
            .then((d) => (d && d.trees && d.docs ? d : null))
            .catch(() => null)
        : Promise.resolve(null)
    );
  return istaInfoTreeCache.get(key);
}

/**
 * InfoObjFilter.IsValid for the type half of the filter: a document passes
 * when the filter's list holds its type. A document with no type passes,
 * and so does everything under the pass-all filter.
 * @param {string|null} types - the filter's comma list, or null for all
 * @param {string} type - the document's type
 * @returns {boolean}
 */
function istaInfoTypeOk(types, type) {
  if (types == null || !type) return true;
  // the tool tests the list with Contains, a substring test over the string
  return String(types).includes(type);
}

/**
 * A tree as the browser's nodes, with what the car's rules exclude left
 * out. A node is shown only when it passes its own rule; a node under one
 * that fails is never reached, which is the tool's "every node on the path
 * is valid" (IsNodePathValid).
 * @param {object[]} nodes - the extract's nodes: {id, t, r, d, k}
 * @param {(rule: object|undefined) => boolean} holds - the car's rule check
 * @returns {object[]} BrowserNode[], each keeping its extract node as `raw`
 */
function istaInfoNodes(nodes, holds) {
  const out = [];
  for (const n of nodes || []) {
    if (!holds(n.r)) continue;
    out.push({
      id: String(n.id),
      label: n.t || '',
      kids: istaInfoNodes(n.k, holds),
      raw: n,
    });
  }
  return out;
}

/**
 * Every document under a node: its own, then those of every shown child,
 * each once (DiagnosisObjectsTreeNode.InfoObjects, recursive). A document
 * is listed when it passes its own rule for the car.
 * @param {object} node - a node from istaInfoNodes
 * @param {object} docs - the extract's documents: id -> [type, title, rule]
 * @param {(rule: object|undefined) => boolean} holds - the car's rule check
 * @returns {Array<{id: string, type: string, title: string}>}
 */
function istaInfoDocsUnder(node, docs, holds) {
  const seen = new Set();
  const out = [];
  (function walk(n) {
    for (const id of (n.raw && n.raw.d) || []) {
      const key = String(id);
      if (seen.has(key)) continue;
      seen.add(key);
      const d = docs[key];
      if (!d || !holds(d[2])) continue;
      out.push({ id: key, type: d[0] || '', title: d[1] || '' });
    }
    for (const k of n.kids || []) walk(k);
  })(node);
  return out;
}

/**
 * One document's body, from whichever store holds it.
 * @param {string} chassis - the chassis
 * @param {{id: string, type: string, title: string}} doc - the document
 * @returns {Promise<string>} HTML
 */
async function istaInfoDocHtml(chassis, doc) {
  const none = `<div class="rp-none">This document's body is not in this build.</div>`;
  const quiet = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      return null;
    }
  };
  // the repair manual: repair instructions and repair notes
  if (/^(REP|REH)$/.test(doc.type) && typeof repairIndex === 'function') {
    const idx = await quiet(() => repairIndex(chassis));
    const hit = idx && repairFindDoc(idx, doc.id);
    const body = hit && (await quiet(() => repairBody(chassis, hit)));
    if (body) return repairDocHtml(hit, body, chassis);
  }
  // the workshop reference documents
  if (
    /^(TED|AZD|SBS|SWZ|SWS)$/.test(doc.type) &&
    typeof techDataIndex === 'function'
  ) {
    const idx = await quiet(() => techDataIndex());
    const hit = idx && idx.docs.find((d) => String(d.id) === String(doc.id));
    const body = hit && (await quiet(() => techDataBody(hit)));
    if (hit && body) return techDataDocHtml(hit, body);
  }
  // the wiring extract holds the diagrams, and with them the pin
  // assignments, connector views and installation locations a diagram
  // links to; the diagnosis extract may hold the last three as well
  if (
    /^(SSP|PIB|STA|EBO)$/.test(doc.type) &&
    typeof istaWiringDocHtml === 'function'
  ) {
    const html = await quiet(() => istaWiringDocHtml(chassis, doc.id));
    if (html) return html;
    if (doc.type === 'SSP')
      return (
        `<div class="rp-none">This is a wiring diagram, and it is not in ` +
        `this build's wiring data.</div>`
      );
  }
  // the bodies the tree extract ships itself: every type the two stores
  // above do not carry (SIT, REH, FTD, FEB, COM, MSM ...)
  if (
    typeof hfFetchFirst === 'function' &&
    typeof istaDiagBodyHtml === 'function'
  ) {
    const body = await quiet(() =>
      hfFetchFirst(
        `ista/infotree/${String(chassis).toUpperCase()}/docs/${doc.id}.json.gz`,
        { as: 'gzjson' }
      )
    );
    if (body && (body.sections || []).length) return istaDiagBodyHtml(body);
  }
  // the diagnosis documents
  if (typeof istaDiagBody === 'function') {
    const html = await quiet(() => istaDiagBody(chassis, doc));
    if (html) return html;
  }
  return none;
}

/**
 * A browser source over one of a chassis's trees, for one car.
 * @param {object} data - istaInfoTreeLoad's result
 * @param {string} which - product | sws | mob
 * @param {(rule: object|undefined) => boolean} holds - the car's rule check
 * @param {string} chassis - the chassis, for document bodies
 * @returns {object} a BrowserSource
 */
function istaInfoSource(data, which, holds, chassis) {
  const tree = istaInfoNodes((data.trees || {})[which], holds);
  const at = (path) => {
    let nodes = tree;
    let found = null;
    for (const want of path || []) {
      found = nodes.find((n) => n.id === String(want)) || null;
      if (!found) return null;
      nodes = found.kids;
    }
    return found;
  };
  return {
    tree,
    list: (path) => {
      const node = at(path);
      return node ? istaInfoDocsUnder(node, data.docs, holds) : [];
    },
    rowType: (d) => d.type || '',
    rowTitle: (d) => d.title || '',
    docTitle: (d) => `${d.type || ''} ${d.title || ''}`.trim(),
    docId: (d) => String(d.id),
    docHtml: (d) => istaInfoDocHtml(chassis, d),
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ISTA_INFO_TYPES,
    ISTA_INFO_DIALOG_TYPES,
    istaInfoFilterSet,
    istaInfoFilterDefault,
    istaInfoFilterSame,
    istaInfoTypeLabels,
    istaInfoTreeLoad,
    istaInfoTypeOk,
    istaInfoNodes,
    istaInfoDocsUnder,
    istaInfoSource,
  };
}
