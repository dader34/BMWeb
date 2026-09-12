/**
 * @file Repair instruction data: the per-chassis index, the group tree, the
 * lazily fetched bodies and the picture URLs.
 *
 * tools/ista/repair_extract.py writes what this reads (data/ista/repair/).
 * Loaded the way the other ISTA extracts are: a local copy first, then the
 * hosted dataset, and never before the tab is opened.
 *
 * THE CAR FILTER HAPPENED AT EXTRACT TIME, not here, and that is the
 * difference from the Workshop tab. A repair corpus is 67,634 documents and
 * 3.7 GB of XML; filtering that in the browser would mean shipping all of
 * it. So the extractor evaluates each document's validity rule against a
 * chassis and writes one folder per chassis. The app picks the folder.
 *
 * What the extractor could not decode it flags `unsure`, and an unsure
 * document is in EVERY chassis's folder, marked. In a workshop a repair
 * step that might not apply is a smaller problem than one that quietly went
 * missing, so the flag is the honest failure.
 */

/* exported repairIndex repairIndexPresent repairBody repairPicUrl repairPicShard
   repairGroupTree repairDocsIn repairDocsUnder repairBrowserTree
   repairSearch repairFindDoc repairDocNumber repairBodyIndex */

/** Hosted copy, beside the other ISTA extracts. */
const REPAIR_HF_BASE =
  'https://huggingface.co/datasets/CraigFf/bmweb-etk/resolve/main/ista/repair/';

/** How many rows a search returns before it stops counting. */
const REPAIR_SEARCH_CAP = 500;

/**
 * The body text of every document, by id, once a body search has asked for
 * it. Empty until then: the blob is worth fetching only when the reader
 * actually ticks "Search in document".
 * @type {Map<string, string>}
 */
let repairBodyText = new Map();

/** The chassis whose body text is loaded, so a car change reloads it. */
let repairBodyChassis = null;

/**
 * Load the body-text index for a chassis, once.
 *
 * Returns false when the extract ships none, which is not a failure: the
 * caller greys the scope and says so, and the other three keep working.
 * @param {string} chassis - the chassis id
 * @returns {Promise<boolean>} whether the index is now loaded
 */
async function repairBodyIndex(chassis) {
  const code = String(chassis || '').toUpperCase();
  if (!code) return false;
  if (repairBodyChassis === code) return repairBodyText.size > 0;
  repairBodyChassis = code;
  repairBodyText = new Map();
  try {
    // the index ships gzipped and a plain file server serves it as bytes
    // rather than as content-encoding gzip, so it is unpacked here with the
    // same library the chassis archives use
    const real =
      typeof webRealFetch === 'function'
        ? webRealFetch
        : window.fetch.bind(window);
    let raw = null;
    for (const u of repairUrls(`${code}/search-index.json.gz`)) {
      try {
        const r = await real(u);
        if (!r || !r.ok) continue;
        const bytes = new Uint8Array(await r.arrayBuffer());
        if (typeof fflate === 'undefined') return false;
        raw = JSON.parse(
          new TextDecoder('utf-8').decode(fflate.gunzipSync(bytes))
        );
        break;
      } catch (e) {
        /* try the next source */
      }
    }
    if (!raw) return false;
    for (const [id, text] of Object.entries(raw))
      repairBodyText.set(String(id), String(text || ''));
  } catch (e) {
    return false;
  }
  return repairBodyText.size > 0;
}

/** The chassis whose index is loaded, so a car change reloads it. */
let repairChassisLoaded = null;
/** @type {object|null} the loaded chassis index */
let repairIndexCache = null;
/** @type {Map<string, object|null>} shard name -> its bodies */
const repairBodyCache = new Map();
/** @type {Promise<object|null>|null} the in-flight index load */
let repairLoading = null;

/**
 * Where a repair file lives, local first then the dataset.
 *
 * Both are tried in order and the first that answers wins, so a build with
 * a local extract never reaches the network and one without still works.
 * @param {string} rel - the path under data/ista/repair/
 * @returns {string[]} the URLs to try, in order
 */
function repairUrls(rel) {
  const base = typeof WEB_BASE === 'string' ? WEB_BASE : '';
  return [`${base}/data/ista/repair/${rel}`, REPAIR_HF_BASE + rel];
}

/**
 * One JSON file, local first then the dataset. Null when neither has it.
 * @param {string} rel - the path under data/ista/repair/
 * @returns {Promise<object|null>}
 */
async function repairFetchJson(rel) {
  const real =
    typeof webRealFetch === 'function'
      ? webRealFetch
      : window.fetch.bind(window);
  for (const u of repairUrls(rel)) {
    try {
      const r = await real(u);
      if (r && r.ok) return await r.json();
    } catch (e) {
      /* try the next source */
    }
  }
  return null;
}

/**
 * One chassis's index: its group tree and every document in scope for it.
 *
 * Cached per chassis, so switching cars reloads rather than merging two
 * chassis's documents into one list.
 * @param {string} chassis - the development code, e.g. "E46"
 * @returns {Promise<object|null>}
 */
async function repairIndex(chassis) {
  const want = String(chassis || '').toUpperCase();
  if (!want) return null;
  if (repairChassisLoaded === want && repairIndexCache) return repairIndexCache;
  if (repairChassisLoaded === want && repairLoading) return repairLoading;
  repairChassisLoaded = want;
  repairIndexCache = null;
  repairBodyCache.clear();
  repairLoading = (async () => {
    const idx = await repairFetchJson(`${want}/index.json`);
    repairIndexCache = idx && Array.isArray(idx.docs) ? idx : null;
    return repairIndexCache;
  })();
  return repairLoading;
}

/**
 * Did this build ship repair instructions for this chassis?
 * @param {string} chassis - the development code
 * @returns {Promise<boolean>}
 */
async function repairIndexPresent(chassis) {
  const idx = await repairIndex(chassis).catch(() => null);
  return !!(idx && idx.docs && idx.docs.length);
}

/**
 * One document's body, fetching its shard the first time.
 * @param {string} chassis - the development code
 * @param {object} doc - an index entry
 * @returns {Promise<object|null>}
 */
async function repairBody(chassis, doc) {
  if (!doc || !doc.shard) return null;
  const key = `${String(chassis).toUpperCase()}/${doc.shard}`;
  if (!repairBodyCache.has(key)) {
    repairBodyCache.set(
      key,
      await repairFetchJson(
        `${String(chassis).toUpperCase()}/body/${doc.shard}.json`
      )
    );
  }
  const shard = repairBodyCache.get(key);
  return (shard && shard[String(doc.id)]) || null;
}

/**
 * Where one illustration lives.
 *
 * POOLED, NOT PER CHASSIS, because chassis share artwork: 156,190
 * per-chassis references across the 23 the app ships resolve to 53,344
 * distinct pictures. One pool is 66% smaller, and a reader who has browsed
 * one chassis arrives at the next with its shared pictures already cached.
 * The chassis is therefore not part of the path.
 *
 * The extractor already resolved every GRAPHIC to its stream id, so the app
 * asks for a file name rather than re-deriving BMW's picture-naming rules
 * in JavaScript. Only the first URL is returned: an <img> cannot try two
 * sources, and the local copy is the one a packaged build has.
 * @param {number|string} pic - the picture's stream id
 * @param {boolean} [hosted] - use the dataset rather than the local copy
 * @returns {string} the URL
 */
function repairPicUrl(pic, hosted) {
  const urls = repairUrls(`pics/${repairPicShard(pic)}/${pic}.webp`);
  return hosted ? urls[1] : urls[0];
}

/**
 * The pool folder a picture lives in: the last two digits of its stream id.
 *
 * The pool is one set of 54,000 files shared by every chassis, and the
 * dataset host caps a folder at 10,000 entries, so the files sit in a
 * hundred folders of a few hundred each. The extractor's write_pictures
 * uses the same rule; the two must agree.
 * @param {number|string} pic - the picture's stream id
 * @returns {string} two characters
 */
function repairPicShard(pic) {
  const id = String(pic);
  return id.length >= 2 ? id.slice(-2) : id.padStart(2, '0');
}

/**
 * The document's number, the way ISTA titles it.
 *
 * ISTA shows "COM-AZD-2121" or a bare job number; what the data always
 * carries is the group, subgroup and job, which concatenate to the number
 * printed in every BMW repair manual ("61 31 040"). That is what a mechanic
 * would quote, so that is what is shown.
 * @param {object} doc - an index entry
 * @returns {string} the number, or '' when the parts are missing
 */
function repairDocNumber(doc) {
  if (!doc) return '';
  const parts = [doc.g, doc.s, doc.job]
    .filter((p) => p !== undefined && p !== null && String(p) !== '')
    // "..." IS BMW'S OWN PLACEHOLDER for a document with no job number, on
    // 6,643 of the 65,115 documents. Joining it printed titles like
    // "11 65 ... Test steps in the event of turbocharger damage", where the
    // ellipsis reads as a truncation of the number rather than as its
    // absence. The group and subgroup still identify the document.
    .filter((p) => !/^\.{2,}$/.test(String(p).trim()));
  if (parts.length < 2) return '';
  return parts.join(' ');
}

/**
 * The group tree for a chassis, main groups each carrying their subgroups.
 *
 * Comes straight from the index: the extractor counted the documents that
 * survived the car filter, so the numbers beside a group are the documents
 * actually behind it and never a catalogue figure the user cannot reach.
 * @param {object|null} idx - the chassis index
 * @returns {Array<object>} the main groups, in number order
 */
function repairGroupTree(idx) {
  const tree = (idx && idx.tree) || [];
  return tree.slice().sort((a, b) => {
    const na = Number(a.id);
    const nb = Number(b.id);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return String(a.id).localeCompare(String(b.id));
  });
}

/**
 * The documents in one group, or one subgroup of it.
 * @param {object|null} idx - the chassis index
 * @param {string|null} group - the main group id, null for all
 * @param {string|null} sub - the subgroup id, null for the whole group
 * @returns {object[]} the documents, in job order
 */
function repairDocsIn(idx, group, sub) {
  const docs = (idx && idx.docs) || [];
  const rows = docs.filter(
    (d) =>
      (group == null || String(d.g) === String(group)) &&
      (sub == null || String(d.s) === String(sub))
  );
  return rows.sort((a, b) => {
    const ja = String(a.job || '');
    const jb = String(b.job || '');
    if (ja !== jb) return ja.localeCompare(jb);
    return String(a.title || '').localeCompare(String(b.title || ''));
  });
}

/**
 * Free-text search over the documents in scope.
 *
 * The four checkboxes are ISTA's, and they mean what they say: structures
 * searches the group names, title searches the document title, number
 * searches the job number, document searches the step text itself.
 *
 * THE BODY SEARCH NEEDS AN INDEX, not the bodies. The step text lives in
 * shards this has not fetched, and pulling every shard to answer a keystroke
 * would cost megabytes per letter. So the extract ships one lowercased text
 * blob per document, loaded once on the first body search; until it lands
 * this scope simply matches nothing rather than blocking the other three.
 *
 * THE SCOPES ARE AN OR. A document matches when every term is found in AT
 * LEAST ONE ticked scope -- ticking more can only find more, which is what a
 * reader expects of a checkbox that widens a search.
 *
 * Every term has to match somewhere, so "front brake" finds the front brake
 * job rather than everything about either word.
 * @param {object|null} idx - the chassis index
 * @param {string} query - what was typed
 * @param {{structures?: boolean, title?: boolean, number?: boolean}} where -
 *   which fields to look in
 * @returns {object[]} the matches, capped
 */
function repairSearch(idx, query, where) {
  const terms = String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!terms.length) return [];
  const opts = where || {};
  const docs = (idx && idx.docs) || [];
  // group names are not on a document, so they are looked up per group
  const names = new Map();
  for (const g of repairGroupTree(idx)) {
    names.set(String(g.id), `${g.id} ${g.name || ''}`);
    for (const s of g.subs || [])
      names.set(`${g.id}/${s.id}`, `${s.id} ${s.name || ''}`);
  }
  const body = opts.document ? repairBodyText : null;
  const out = [];
  for (const d of docs) {
    const bits = [];
    if (opts.title !== false) bits.push(d.title || '');
    if (opts.structures)
      bits.push(names.get(String(d.g)) || '', names.get(`${d.g}/${d.s}`) || '');
    if (opts.number) bits.push(repairDocNumber(d), String(d.aw || ''));
    if (body) bits.push(body.get(String(d.id)) || '');
    const hay = bits.join(' ').toLowerCase();
    if (terms.every((t) => hay.includes(t))) out.push(d);
    if (out.length >= REPAIR_SEARCH_CAP) break;
  }
  return out;
}

/**
 * Every document UNDER a node, its own and its children's.
 *
 * This is the behaviour that separates the tree from a filter: picking "0
 * Maintenance and general note" lists all 74 documents beneath it, not the
 * handful filed directly on the node. A mechanic picking a group wants to
 * see the group, and making them open every subgroup to find out what is in
 * it would turn one click into twenty.
 * @param {object|null} idx - the chassis index
 * @param {string[]|null} path - [mainGroup] or [mainGroup, subGroup]
 * @returns {object[]} the documents, in number order
 */
function repairDocsUnder(idx, path) {
  if (!path || !path.length) return [];
  const group = String(path[0]);
  const sub = path.length > 1 ? String(path[1]) : null;
  return repairDocsIn(idx, group, sub);
}

/**
 * The group tree as the generic browser's node shape.
 *
 * The browser knows nothing about repair groups, so the index's own shape
 * is translated here rather than the browser being taught about it.
 * @param {object|null} idx - the chassis index
 * @returns {Array<object>} BrowserNode roots
 */
function repairBrowserTree(idx) {
  return repairGroupTree(idx).map((g) => ({
    id: String(g.id),
    num: String(g.id),
    label: g.name || '',
    n: g.n,
    kids: (g.subs || []).map((s) => ({
      id: String(s.id),
      // ISTA numbers a subgroup with its group in front: "21" + "00" reads
      // "2100", which is how the manual itself cites it
      num: `${g.id}${s.id}`,
      label: s.name || '',
      n: s.n,
    })),
  }));
}

/**
 * One document by id, for reopening a deep link.
 * @param {object|null} idx - the chassis index
 * @param {string|number} id - the document id
 * @returns {object|null}
 */
function repairFindDoc(idx, id) {
  const docs = (idx && idx.docs) || [];
  const want = String(id);
  return docs.find((d) => String(d.id) === want) || null;
}

if (typeof window !== 'undefined') {
  window.repairIndexPresent = repairIndexPresent;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    REPAIR_HF_BASE,
    REPAIR_SEARCH_CAP,
    repairUrls,
    repairFetchJson,
    repairIndex,
    repairIndexPresent,
    repairBody,
    repairPicUrl,
    repairPicShard,
    repairDocNumber,
    repairGroupTree,
    repairDocsIn,
    repairDocsUnder,
    repairBrowserTree,
    repairSearch,
    repairFindDoc,
  };
}
