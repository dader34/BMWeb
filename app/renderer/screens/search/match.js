/**
 * @file The matcher: query -> ranked, grouped results. Pure over a loaded
 * index; no DOM, no fetch.
 *
 * ALL WORDS MUST MATCH. A query is split on whitespace and every word has to
 * appear somewhere in an entry's searchable text -- "clear adaptation" must
 * not answer with every key holding the word "clear". Words match as
 * substrings, so "fehler" finds "Fehlerspeicher" and "lambda" finds
 * "Lambdasonde", which is what INPA's German compounds require.
 *
 * BOTH LANGUAGES, ALWAYS. INPA's scripts are a mix -- some print English,
 * some German with a dictionary beside them -- and the builder indexes both
 * forms. A German-only user searching "Fehlerspeicher" and an English-only
 * user searching "fault memory" must both find the same key, so the haystack
 * carries the label as BMW wrote it AND its translation.
 *
 * RANKING answers "which of these did they mean". A whole-word hit on a label
 * beats a substring buried in a caption blob; a key (something to press)
 * beats a screen (somewhere to land) when both say the same thing; and an
 * exact job-name match wins outright, because someone typing FS_LESEN knows
 * exactly what they want.
 */

/* exported SEARCH_MAX_RESULTS, searchTerms, searchEntryText, searchRank, searchRun */

/** Cap on rows handed to the renderer; the count line reports the true total. */
const SEARCH_MAX_RESULTS = 200;

/** Shortest query worth running: one letter matches most of the corpus. */
const SEARCH_MIN_QUERY = 2;

/** Score for a term that hits a job name exactly. */
const SCORE_JOB_EXACT = 60;

/** Score for a term that starts a word in the label or title. */
const SCORE_WORD_START = 24;

/** Score for a term found anywhere in the label or title. */
const SCORE_LABEL = 12;

/** Score for a term found only in the weaker fields (captions, result keys). */
const SCORE_WEAK = 3;

/** Bonus for a key: something to press beats somewhere to land. */
const SCORE_IS_KEY = 8;

/** Bonus for an entry that names any job at all: it does something concrete. */
const SCORE_HAS_JOB = 4;

// A module no chassis config names -- BMW ships the .prg, no car's menu lists
// it -- is real and worth finding, but it has no car to open it in, and the
// deep link needs one. Over half the corpus is these, so without a penalty
// they crowd out the openable answer to every broad query: "fault memory"
// led with an unopenable trailer-module row. Penalised, not filtered: the
// row still appears, below every result the user can actually reach.
/** Penalty for a module no car carries: findable, but not openable. */
const SCORE_NO_CAR = -20;

/**
 * One result row, ready to render.
 * @typedef {object} SearchHit
 * @property {SearchEntry} entry - the index entry that matched
 * @property {SearchModule} module - the module it belongs to
 * @property {number} score - the rank; higher is better
 * @property {string} label - what to show as the row's name
 * @property {string} sub - the screen title, when it adds anything
 * @property {string[]} jobs - the job names to show
 */

/**
 * Results for one module, within one chassis.
 * @typedef {object} SearchModuleGroup
 * @property {SearchModule} module - the module
 * @property {SearchHit[]} hits - its matching rows, best first
 */

/**
 * Results for one chassis.
 * @typedef {object} SearchChassisGroup
 * @property {string} chassis - the chassis id, or '' for a module no car owns
 * @property {SearchModuleGroup[]} modules - its modules, best first
 * @property {number} total - matching rows in this chassis
 */

/**
 * A finished search.
 * @typedef {object} SearchResult
 * @property {SearchChassisGroup[]} groups - chassis groups, best first
 * @property {number} total - matching rows across every group
 * @property {number} shown - rows actually placed in the groups
 */

/**
 * Split a query into the words that must all match.
 * @param {string} q - the raw query
 * @returns {string[]} lower-cased words, empty when the query is too short
 */
function searchTerms(q) {
  const s = String(q || '')
    .toLowerCase()
    .trim();
  if (s.length < SEARCH_MIN_QUERY) return [];
  return s.split(/\s+/).filter(Boolean);
}

/**
 * The two haystacks of an entry: the strong fields a user names a thing by,
 * and the weak ones that should match but not rank.
 * @param {SearchEntry} e - the entry
 * @param {SearchModule} mod - its module
 * @returns {{strong: string, weak: string, jobs: string[]}} lower-cased text
 */
function searchEntryText(e, mod) {
  const strong = [e.l, e.e, e.ti, e.tie]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  // the module's own names go in the weak half so "kombi abs" can narrow to a
  // module without a module name outranking the key the user asked for
  const weak = [
    e.c,
    e.ce,
    (e.k || []).join(' '),
    e.s,
    e.m,
    mod.sgbd,
    mod.label,
    mod.code,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const jobs = (e.j || []).map((j) => j.toLowerCase());
  return { strong, weak, jobs };
}

/**
 * Score an entry against the query, or 0 when a term is missing anywhere.
 *
 * Every term must land somewhere; the score is the sum of where each landed,
 * so a query whose words all hit labels outranks one whose words scattered
 * across a caption blob.
 * @param {SearchEntry} e - the entry
 * @param {SearchModule} mod - its module
 * @param {string[]} terms - the query words (searchTerms)
 * @returns {number} the score, 0 when the entry does not match
 */
function searchRank(e, mod, terms) {
  const { strong, weak, jobs } = searchEntryText(e, mod);
  const jobText = jobs.join(' ');
  let score = 0;
  for (const t of terms) {
    if (jobs.includes(t)) {
      score += SCORE_JOB_EXACT;
      continue;
    }
    const at = strong.indexOf(t);
    if (at >= 0) {
      // at a word boundary the user typed the start of the name, not a
      // fragment that happens to sit inside a longer German compound
      const boundary = at === 0 || !/[a-z0-9]/.test(strong[at - 1]);
      score += boundary ? SCORE_WORD_START : SCORE_LABEL;
      continue;
    }
    if (weak.indexOf(t) >= 0 || jobText.indexOf(t) >= 0) {
      score += SCORE_WEAK;
      continue;
    }
    return 0; // a term matched nothing: not a result
  }
  if (e.t === 'k') score += SCORE_IS_KEY;
  if (e.j && e.j.length) score += SCORE_HAS_JOB;
  if (!(mod.chassis || []).length) score += SCORE_NO_CAR;
  // a penalty must never turn a match into a non-match: 0 means "did not
  // match" everywhere else in this file
  return score > 0 ? score : 1;
}

/**
 * The row's display name: the English when a dictionary has it (the app
 * paints English everywhere else), else the script's own words. A screen
 * entry with no key of its own falls back to its title, then its proc name --
 * a proc name is a poor label but it is never nothing.
 * @param {SearchEntry} e - the entry
 * @returns {string}
 */
function searchHitLabel(e) {
  return e.e || e.l || e.tie || e.ti || e.s || e.m || '';
}

/**
 * The row's second line: the screen title, when it is not already the label.
 * @param {SearchEntry} e - the entry
 * @param {string} label - what searchHitLabel returned
 * @returns {string} the subtitle, or ''
 */
function searchHitSub(e, label) {
  const t = e.tie || e.ti || '';
  return t && t !== label ? t : '';
}

/**
 * Run a query over the index and group the results by chassis, then module.
 *
 * A module several cars carry (the same .prg sits in up to 18 chassis trees)
 * contributes its hits to EACH of those cars, because the deep link a row
 * opens names a chassis -- a result the user cannot open in a car they own is
 * not an answer.
 * @param {SearchIndex|null} index - the loaded index
 * @param {string} q - the raw query
 * @param {{max?: number, chassis?: string}} [opts] - row cap, chassis filter
 * @returns {SearchResult}
 */
function searchRun(index, q, opts = {}) {
  const empty = { groups: [], total: 0, shown: 0 };
  const terms = searchTerms(q);
  if (!index || !terms.length) return empty;
  const max = opts.max || SEARCH_MAX_RESULTS;
  const only = opts.chassis ? String(opts.chassis).toUpperCase() : '';
  const mods = index.modules || [];

  const scored = [];
  for (const e of index.entries || []) {
    const mod = mods[e.i];
    if (!mod) continue;
    if (only && !(mod.chassis || []).includes(only)) continue;
    const score = searchRank(e, mod, terms);
    if (!score) continue;
    scored.push({ e, mod, score });
  }
  scored.sort((a, b) => b.score - a.score);

  // group: chassis -> module -> rows, keeping the best-first order the sort
  // produced (Map preserves insertion order, so the first chassis a top hit
  // belongs to leads the page)
  /** @type {Map<string, Map<string, SearchModuleGroup>>} */
  const byChassis = new Map();
  let shown = 0;
  let total = 0;
  for (const { e, mod, score } of scored) {
    const cars = (mod.chassis || []).length ? mod.chassis : [''];
    const targets = only ? [only] : cars;
    total += targets.length;
    if (shown >= max) continue;
    const label = searchHitLabel(e);
    const hit = {
      entry: e,
      module: mod,
      score,
      label,
      sub: searchHitSub(e, label),
      jobs: e.j || [],
    };
    for (const c of targets) {
      if (shown >= max) break;
      let mm = byChassis.get(c);
      if (!mm) byChassis.set(c, (mm = new Map()));
      let g = mm.get(mod.sgbd);
      if (!g) mm.set(mod.sgbd, (g = { module: mod, hits: [] }));
      g.hits.push(hit);
      shown++;
    }
  }

  const groups = [];
  for (const [chassis, mm] of byChassis) {
    const modules = [...mm.values()];
    groups.push({
      chassis,
      modules,
      total: modules.reduce((n, g) => n + g.hits.length, 0),
    });
  }
  return { groups, total, shown };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SEARCH_MAX_RESULTS,
    searchTerms,
    searchEntryText,
    searchRank,
    searchRun,
  };
}
