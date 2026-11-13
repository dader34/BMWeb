/**
 * @file ISTA's Text Search, as the tool runs it.
 *
 * A PORT OF DatabaseProviderSQLite.GetOccurrences and what it calls. The
 * tool's text search does not search a tree; it searches every document in
 * the database, in up to four ways at once:
 *
 *   title      the title holds the term
 *   number     the document number, or a special tool's number, holds it
 *   structure  a diagnosis object's title holds it, and every document
 *              under that object is a hit
 *   content    a full-text index over the bodies (not in this build)
 *
 * WHAT A TERM IS (FormatSearchTerms): the typed string with quotes,
 * semicolons, brackets and backslashes removed, split on spaces, upper
 * case. A title must hold EVERY term; a number hit needs any one of them.
 * Each term also stands for its synonyms (GetPreferedTermForSearchTerm),
 * so a title matches a term when it holds the term or any of them.
 *
 * WHAT IS KEPT: a hit valid for the car, of a type the tool lists, and of a
 * type the page's filter passes; the search stops at a hundred
 * (Textsearch.MaxHitNumber) and says so.
 *
 * tools/ista/search_index_extract.py ships the documents the title and
 * number searches run over; the structure search runs over the trees
 * info-tree.js already holds.
 */

/* exported ISTA_SEARCH_MAX istaSearchLoad istaSearchSynonyms istaSearchTerms
   istaSearchVariants istaSearchHolds istaSearchRun */

/** BMW.Rheingold.ISTAGUI.Textsearch.MaxHitNumber. */
const ISTA_SEARCH_MAX = 100;

/** DatabaseUtil.IsDocumentTypeHidden: never listed, whatever matched. */
const ISTA_SEARCH_HIDDEN = new Set([
  'VUL',
  'GPI',
  'FKB',
  'ANL',
  'STG',
  'NEU',
  'BNT',
]);

/** @type {Map<string, Promise<object|null>>} chassis -> its index */
const istaSearchCache = new Map();
/** @type {Promise<object>|null} the synonym table */
let istaSearchSynCache = null;

/**
 * A chassis's search index, or null when this build ships none.
 * @param {string} chassis - the chassis id
 * @returns {Promise<{docs: Array, rules: object[]}|null>}
 */
function istaSearchLoad(chassis) {
  const key = String(chassis || '').toUpperCase();
  if (!key) return Promise.resolve(null);
  if (!istaSearchCache.has(key))
    istaSearchCache.set(
      key,
      typeof hfFetchFirst === 'function'
        ? hfFetchFirst(`ista/search/${key}.json.gz`, { as: 'gzjson' })
            .then((d) => (d && Array.isArray(d.docs) ? d : null))
            .catch(() => null)
        : Promise.resolve(null)
    );
  return istaSearchCache.get(key);
}

/**
 * The synonym table: a term, upper case, to the terms that stand beside it.
 * Empty when the build ships none, and the search then runs on the typed
 * terms alone.
 * @returns {Promise<Object<string, string[]>>}
 */
function istaSearchSynonyms() {
  if (!istaSearchSynCache)
    istaSearchSynCache =
      typeof hfFetchFirst === 'function'
        ? hfFetchFirst('ista/search/terms.json.gz', { as: 'gzjson' })
            .then((d) => d || {})
            .catch(() => ({}))
        : Promise.resolve({});
  return istaSearchSynCache;
}

/**
 * FormatSearchTerms: the typed string as the terms the search runs on.
 * @param {string} text - what was typed
 * @returns {string[]} upper case, in order
 */
function istaSearchTerms(text) {
  return String(text || '')
    .trim()
    .replace(/[';"\\()]/g, '')
    .trim()
    .split(' ')
    .filter((t) => t !== '')
    .map((t) => t.trim().toUpperCase());
}

/**
 * BuildSearchTerms: each term with its synonyms, upper case.
 * @param {string[]} terms - istaSearchTerms output
 * @param {Object<string, string[]>} synonyms - the table
 * @returns {string[][]} one list of alternatives per term
 */
function istaSearchVariants(terms, synonyms) {
  return terms.map((t) => {
    const out = (synonyms[t] || []).map((s) => String(s).toUpperCase());
    if (!out.includes(t)) out.push(t);
    return out;
  });
}

/**
 * Whether a title answers the search: it holds, for every term, the term
 * or one of its synonyms.
 * @param {string} title - a title
 * @param {string[][]} variants - istaSearchVariants output
 * @returns {boolean}
 */
function istaSearchHolds(title, variants) {
  const text = String(title || '').toUpperCase();
  return variants.every((alts) => alts.some((a) => text.includes(a)));
}

/**
 * Run a text search.
 * @param {object} o - the search
 * @param {string} o.text - what was typed
 * @param {{title: boolean, number: boolean, structure: boolean}} o.modes
 * @param {object|null} o.index - istaSearchLoad's result
 * @param {object|null} o.trees - istaInfoTreeLoad's result, for structure
 * @param {Object<string, string[]>} o.synonyms - the synonym table
 * @param {(rule: object|undefined) => boolean} o.holds - the car's rules
 * @param {string|null} o.types - the page's type filter (a comma list, or
 *   null for every type)
 * @param {number} [o.max] - where to stop
 * @returns {{hits: Array<{id: string, type: string, title: string,
 *   ident?: string}>, exceeded: boolean}}
 */
function istaSearchRun(o) {
  const terms = istaSearchTerms(o.text);
  const max = o.max || ISTA_SEARCH_MAX;
  const hits = [];
  const seen = new Set();
  if (!terms.length) return { hits, exceeded: false };
  const variants = istaSearchVariants(terms, o.synonyms || {});
  const typeOk = (type) =>
    !ISTA_SEARCH_HIDDEN.has(type) &&
    (o.types == null || !type || String(o.types).includes(type));
  const add = (doc) => {
    if (seen.has(doc.id) || hits.length >= max) return;
    seen.add(doc.id);
    hits.push(doc);
  };

  // the documents themselves, by title and by number
  const rules = (o.index && o.index.rules) || [];
  if (o.index && (o.modes.title || o.modes.number))
    for (const d of o.index.docs) {
      if (hits.length >= max) break;
      const [id, type, title, number, tool, rule] = d;
      if (!typeOk(type)) continue;
      const byTitle = o.modes.title && istaSearchHolds(title, variants);
      const byNumber =
        o.modes.number &&
        terms.some(
          (t) =>
            String(number).toUpperCase().includes(t) ||
            String(tool).toUpperCase().includes(t)
        );
      if (!byTitle && !byNumber) continue;
      if (rule >= 0 && !o.holds(rules[rule])) continue;
      add({ id: String(id), type, title });
    }

  // the structure: every document under a node whose title answers
  if (o.modes.structure && o.trees && typeof istaInfoNodes === 'function')
    for (const which of Object.keys(o.trees.trees || {})) {
      const walk = (nodes) => {
        for (const n of nodes) {
          if (hits.length >= max) return;
          if (istaSearchHolds(n.label, variants)) {
            for (const d of istaInfoDocsUnder(n, o.trees.docs, o.holds))
              if (typeOk(d.type)) add(d);
          } else walk(n.kids);
        }
      };
      walk(istaInfoNodes(o.trees.trees[which], o.holds));
    }
  return { hits, exceeded: hits.length >= max };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ISTA_SEARCH_MAX,
    istaSearchLoad,
    istaSearchSynonyms,
    istaSearchTerms,
    istaSearchVariants,
    istaSearchHolds,
    istaSearchRun,
  };
}
