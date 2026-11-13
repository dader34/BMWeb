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
 *   content    a word of the body begins with the term
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
 *
 * THE CONTENT SEARCH WITHOUT THE BODIES. The tool asks a full-text index
 * over fifteen gigabytes of bodies for each term as a prefix. What that
 * needs is which documents hold which words, and
 * tools/ista/search_content_extract.py ships exactly that, cut into small
 * files by a word's first two characters. A search fetches the files its
 * terms start with, takes every word beginning with the term, and joins
 * the documents; the chassis's index then decides, as for any other hit,
 * which of them this car may see.
 */

/* exported ISTA_SEARCH_MAX istaSearchLoad istaSearchSynonyms istaSearchTerms
   istaSearchVariants istaSearchHolds istaSearchRun istaSearchContent
   istaSearchWordDocs istaSearchContentJoin */

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

/** @type {Map<string, Promise<object|null>>} shard key -> its words */
const istaSearchShards = new Map();
/** @type {Promise<number[]|null>|null} the indexed documents, in order */
let istaSearchContentIds = null;

/**
 * One file of the content index.
 * @param {string} rel - the path under ista/search/content/
 * @returns {Promise<any|null>}
 */
function istaSearchContentFile(rel) {
  return typeof hfFetchFirst === 'function'
    ? hfFetchFirst(`ista/search/content/${rel}`, { as: 'gzjson' }).catch(
        () => null
      )
    : Promise.resolve(null);
}

/**
 * The places (in the index's document order) of every document holding a
 * word that begins with `prefix`, from one shard's table.
 * @param {Object<string, number[]>|null} table - a shard: word -> the
 *   first place, then the gap to each next one
 * @param {string} prefix - lower case
 * @returns {Set<number>}
 */
function istaSearchWordDocs(table, prefix) {
  const out = new Set();
  for (const word of Object.keys(table || {})) {
    if (!word.startsWith(prefix)) continue;
    let at = 0;
    for (const gap of table[word]) {
      at += gap;
      out.add(at);
    }
  }
  return out;
}

/**
 * Join what each term found: a document must answer EVERY term, by the
 * term itself or by one of its synonyms; a synonym of several words needs
 * all of them.
 * @param {string[][]} variants - per term, its alternatives
 * @param {(word: string) => Set<number>} docsOf - the documents holding a
 *   word beginning with this (lower-case) string
 * @returns {Set<number>|null} null when no term could be searched
 */
function istaSearchContentJoin(variants, docsOf) {
  let all = null;
  for (const alts of variants) {
    let term = null;
    for (const alt of alts) {
      const words = String(alt)
        .toLowerCase()
        .split(/[^0-9a-z\u0080-\uffff]+/)
        .filter((w) => w.length >= 2);
      if (!words.length) continue;
      let hit = null;
      for (const w of words) {
        const got = docsOf(w);
        hit = hit ? new Set([...hit].filter((d) => got.has(d))) : got;
      }
      term = term ? new Set([...term, ...hit]) : hit;
    }
    // a term too short to look up does not narrow the search
    if (!term) continue;
    all = all ? new Set([...all].filter((d) => term.has(d))) : term;
  }
  return all;
}

/**
 * "Search in document": the ids of the documents whose body answers.
 * @param {string} text - what was typed
 * @param {Object<string, string[]>} synonyms - the synonym table
 * @returns {Promise<Set<string>|null>} null when the build ships no content
 *   index, or nothing typed can be looked up
 */
async function istaSearchContent(text, synonyms) {
  const variants = istaSearchVariants(istaSearchTerms(text), synonyms || {});
  if (!variants.length) return null;
  if (!istaSearchContentIds)
    istaSearchContentIds = istaSearchContentFile('ids.json.gz');
  const ids = await istaSearchContentIds;
  if (!Array.isArray(ids)) return null;
  // every shard the words begin with, fetched once and together
  const keyOf = (w) => (/^[0-9a-z]{2}/.test(w) ? w.slice(0, 2) : '__');
  const need = new Set();
  for (const alts of variants)
    for (const alt of alts)
      for (const w of String(alt)
        .toLowerCase()
        .split(/[^0-9a-z\u0080-\uffff]+/))
        if (w.length >= 2) need.add(keyOf(w));
  await Promise.all(
    [...need].map((k) => {
      if (!istaSearchShards.has(k))
        istaSearchShards.set(k, istaSearchContentFile(`${k}.json.gz`));
      return istaSearchShards.get(k);
    })
  );
  const tables = new Map();
  for (const k of need) tables.set(k, await istaSearchShards.get(k));
  const places = istaSearchContentJoin(variants, (w) =>
    istaSearchWordDocs(tables.get(keyOf(w)), w)
  );
  if (!places) return null;
  return new Set([...places].map((p) => String(ids[p])));
}

/**
 * Run a text search.
 * @param {object} o - the search
 * @param {string} o.text - what was typed
 * @param {{title: boolean, number: boolean, structure: boolean,
 *   content?: boolean}} o.modes
 * @param {Set<string>|null} [o.content] - istaSearchContent's answer, when
 *   the content search is on
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
  if (o.index && (o.modes.title || o.modes.number || o.modes.content))
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
      const byContent =
        o.modes.content && !!o.content && o.content.has(String(id));
      if (!byTitle && !byNumber && !byContent) continue;
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
    istaSearchContent,
    istaSearchWordDocs,
    istaSearchContentJoin,
  };
}
