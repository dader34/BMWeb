/**
 * @file Reference documents, from BMW's own ISTA diagnostic database. Each
 * .docs archive (tools/ista_docs_import.py) packs one car's text documents --
 * repair instructions, pin assignments, installation locations, connector
 * views, functional descriptions, technical data, torques and more -- as
 * parsed typed-block JSON, grouped into ISTA's component tree.
 *
 * These documents live inside the merged Wiring & Documents screen, reached
 * by its Components / Repair category toggle. This piece provides the data
 * access, the category split and the rendering helpers that screen calls; it
 * has no screen of its own.
 */

/* exported
   docsTypeLabel, docsTypeKind, loadDocs, docsDoc, docsChapterHtml,
   docsCategoryKeep, docsPruneTree, docsCount, docsFlatIndex, docsFindById,
   docsTabEntry, docsTabEntryById */

/**
 * One ISTA document as the archive's tree lists it.
 * @typedef {Object} DocsEntry
 * @property {string | number} id - document id (the archive member docs/<id>.json)
 * @property {string} title - document title
 * @property {string} type - ISTA INFOTYPE, a DOCS_TYPE_LABEL key
 * @property {WiringApplicabilityRule} [a] - embedded applicability (engines / bodies)
 */

/**
 * One node of the ISTA component tree: folders hold documents and children.
 * @typedef {Object} DocsTreeNode
 * @property {string} name - folder name ('' at the root)
 * @property {DocsTreeNode[]} [children] - sub-folders
 * @property {DocsEntry[]} [docs] - documents filed directly here
 */

/**
 * A loaded .docs archive.
 * @typedef {Object} DocsArchive
 * @property {DocsTreeNode} tree - the root of ISTA's component tree
 * @property {Map<string, Uint8Array>} files - every archive member by path
 */

/**
 * A search hit: a document plus the folder path above it.
 * @typedef {DocsEntry & {trail: string[]}} DocsIndexEntry
 */

/**
 * The document categories the merged screen offers. 'diagrams' is the WDS
 * tree; the other two split the ISTA documents by type.
 * @typedef {'diagrams' | 'components' | 'repair'} WiringCategory
 */

/** @type {Map<string, DocsArchive>} chassis -> loaded archive */
const DOCS_CACHE = new Map();

/**
 * Document-type badges: ISTA INFOTYPE -> label.
 * @type {Object<string, string>}
 */
const DOCS_TYPE_LABEL = {
  REP: 'Repair',
  FKB: 'Fault code',
  EBO: 'Installation location',
  STA: 'Connector view',
  FUB: 'Functional description',
  PIB: 'Pin assignment',
  TED: 'Technical data',
  AZD: 'Tightening torques',
  SWZ: 'Special tool',
  FTD: 'Technical information',
  SIT: 'Service information',
  SBS: 'Reference',
  SWS: 'Special equipment',
  NEU: "What's new",
  MSM: 'Mobile service',
  FEB: 'Troubleshooting',
  REH: 'Repair note',
  COM: 'Compilation',
  GPI: 'Programming/coding',
};

/**
 * ISTA INFOTYPE -> the wiring tree kind whose dot colour it borrows.
 * @type {Object<string, string>}
 */
const DOCS_TYPE_KIND = {
  REP: 'test',
  FEB: 'test',
  REH: 'test',
  PIB: 'pins',
  STA: 'connector',
  EBO: 'location',
  TED: 'specs',
  AZD: 'specs',
  SWZ: 'specs',
  SWS: 'specs',
  FUB: 'description',
  FTD: 'description',
  SIT: 'description',
  SBS: 'description',
  NEU: 'description',
  MSM: 'description',
  COM: 'description',
  GPI: 'description',
  FKB: 'schematic',
};

/**
 * The document types the Components category shows (pin assignments,
 * connector views, installation locations, functional descriptions); Repair
 * is everything else.
 * @type {Set<string>}
 */
const DOCS_COMPONENT_TYPES = new Set(['PIB', 'STA', 'EBO', 'FUB']);

/**
 * Human label for an ISTA document type; the raw type when unknown.
 * @param {string} type - ISTA INFOTYPE
 * @returns {string}
 */
function docsTypeLabel(type) {
  return DOCS_TYPE_LABEL[type] || type;
}

/**
 * The wiring tree kind (dot colour) for an ISTA document type.
 * @param {string} type - ISTA INFOTYPE
 * @returns {string}
 */
function docsTypeKind(type) {
  return DOCS_TYPE_KIND[type] || 'document';
}

/**
 * Load one car's .docs archive, once. The offline export inlines archives as
 * base64; that copy wins when present.
 * @param {string} chassisId - chassis code, any case
 * @returns {Promise<DocsArchive>}
 */
async function loadDocs(chassisId) {
  const id = chassisId.toUpperCase();
  if (DOCS_CACHE.has(id)) return DOCS_CACHE.get(id);
  const inline =
    typeof BMACW_DOCS === 'object' && BMACW_DOCS ? BMACW_DOCS[id] : null;
  const data = await wiringFetchArchive(
    `docs/${id}.docs`,
    inline,
    `no reference documents shipped for ${dispChassis(id)}`
  );
  DOCS_CACHE.set(id, data);
  return data;
}

/**
 * One document body, inflated + parsed from the archive. Null when the
 * member is missing or unreadable.
 * @param {DocsArchive} data - the loaded archive
 * @param {string | number} docId - document id
 * @returns {{chapters?: any[]} | null}
 */
function docsDoc(data, docId) {
  const raw = data.files.get(`docs/${docId}.json`);
  if (!raw) return null;
  try {
    return JSON.parse(fflate.strFromU8(raw));
  } catch (e) {
    return null;
  }
}

/**
 * One chapter -> HTML: heading, then its typed blocks. Uses the shared
 * typed-block renderer (ui/typed-block.js); `breaks:true` keeps a HINT title
 * + its sub-lines as separate lines, which document bodies rely on.
 * @param {any} ch - a parsed chapter
 * @returns {string}
 */
function docsChapterHtml(ch) {
  return renderTpChapter(ch, { breaks: true });
}

/**
 * The type filter for a document category.
 * @param {WiringCategory} cat - 'components' or 'repair'
 * @returns {(type: string) => boolean}
 */
function docsCategoryKeep(cat) {
  return cat === 'components'
    ? (t) => DOCS_COMPONENT_TYPES.has(t)
    : (t) => !DOCS_COMPONENT_TYPES.has(t); // repair = everything else
}

/**
 * Filter a docs tree to one category's types, dropping empty branches.
 * @param {DocsTreeNode} node - subtree root
 * @param {(type: string) => boolean} keep - which document types stay
 * @returns {DocsTreeNode | null} the pruned copy, or null when nothing is left
 */
function docsPruneTree(node, keep) {
  const docs = (node.docs || []).filter((d) => keep(d.type));
  const kids = (node.children || [])
    .map((c) => docsPruneTree(c, keep))
    .filter(Boolean);
  if (!docs.length && !kids.length) return null;
  const out = { name: node.name };
  if (kids.length) out.children = kids;
  if (docs.length) out.docs = docs;
  return out;
}

/**
 * How many documents a subtree holds.
 * @param {DocsTreeNode} node - subtree root
 * @returns {number}
 */
function docsCount(node) {
  let n = (node.docs || []).length;
  for (const c of node.children || []) n += docsCount(c);
  return n;
}

/**
 * Flatten a docs tree for search: every document of the kept types with the
 * folder path above it.
 * @param {DocsTreeNode | null | undefined} tree - the archive's root, or null before it loads
 * @param {(type: string) => boolean} keep - which document types stay
 * @returns {DocsIndexEntry[]}
 */
function docsFlatIndex(tree, keep) {
  if (!tree) return [];
  const out = [];
  (function walk(node, trail) {
    const here = node.name ? [...trail, node.name] : trail;
    for (const d of node.docs || []) {
      if (keep(d.type)) out.push({ ...d, trail: here });
    }
    for (const c of node.children || []) walk(c, here);
  })(tree, []);
  return out;
}

/**
 * Find a document anywhere in a docs tree by id.
 * @param {DocsTreeNode} node - subtree root
 * @param {string | number} docId - document id
 * @returns {DocsEntry | null}
 */
function docsFindById(node, docId) {
  for (const d of node.docs || []) if (String(d.id) === String(docId)) return d;
  for (const c of node.children || []) {
    const hit = docsFindById(c, docId);
    if (hit) return hit;
  }
  return null;
}

/**
 * A tab entry for an ISTA doc: keyed by "d:<id>" so it never collides with a
 * WDS SP doc id, and carrying what the doc renderer + persistence need.
 * @param {DocsEntry} d - the document
 * @returns {WiringTabEntry}
 */
function docsTabEntry(d) {
  return {
    doc: 'd:' + d.id,
    docId: d.id,
    name: d.title,
    kind: d.type,
    isDoc: true,
  };
}

/**
 * Rebuild an ISTA doc tab entry from its persisted form or a deep link.
 * @param {string} docId - the bare document id
 * @param {string} name - title to show (recovered from the tree when known)
 * @param {string} kind - ISTA INFOTYPE, or '' when unknown
 * @returns {WiringTabEntry}
 */
function docsTabEntryById(docId, name, kind) {
  return { doc: 'd:' + docId, docId, name, kind, isDoc: true };
}
