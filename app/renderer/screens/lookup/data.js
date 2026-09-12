/**
 * @file Loading the fault database behind Diagnostic Plans and Trouble Codes:
 * the generated fault index (faultindex.js -> window.BMW_FAULT_INDEX), lazy-
 * loaded so the large literal isn't parsed before first paint, and the ISTA
 * component procedures, fetched only when a fault detail is opened.
 *
 * Each index entry is { chassis, module, sgbd, scheme, faults: [[key, english,
 * code]] }. scheme "code": key IS the hex DTC (code === key). scheme "text":
 * key is the SGBD German fault text, code the ORT hex from FORTTEXTE ("" if
 * unknown). Search matches the key, the English text, AND the code.
 */

/* exported loadFaultIndex, loadIstaTests, istaTestFor */

/**
 * One fault of an index entry: [key, English text, code].
 * @typedef {[string, string, string]} LookupFaultRow
 */

/**
 * One module variant's fault list in the generated index.
 * @typedef {object} LookupIndexEntry
 * @property {string} chassis - chassis code ("E46")
 * @property {string} module - module slug ("bms46"), the filter value
 * @property {string} sgbd - the SGBD the faults came from
 * @property {'code'|'text'} scheme - what `key` is: the hex DTC, or the German fault text
 * @property {LookupFaultRow[]} faults - the faults
 */

/**
 * A rendered result group: an index entry's matching rows (or a synthesised
 * ISTA-fleet group, chassis "ISTA").
 * @typedef {object} LookupResultGroup
 * @property {string} chassis - chassis code, or "ISTA" for fleet-only codes
 * @property {string} module - module slug
 * @property {string} sgbd - SGBD name
 * @property {'code'|'text'} scheme - the entry's key scheme
 * @property {LookupFaultRow[]} rows - the matching faults
 */

/**
 * One chapter of an ISTA component procedure. Newer extracts carry typed
 * `blocks`; the older flat `paras` shape is still tolerated.
 * @typedef {object} IstaChapter
 * @property {string} [heading] - chapter heading
 * @property {{ t: string, s?: string }[]} [blocks] - typed blocks (ui/typed-block.js)
 * @property {string[]} [paras] - older flat paragraphs ("• " prefix = bullet)
 */

/**
 * An ISTA guided-diagnostic component procedure: how the system works and how
 * to test it.
 * @typedef {object} IstaTestDoc
 * @property {string} [title] - the component
 * @property {IstaChapter[]} chapters - the procedure
 */

/**
 * One ECU-variant record of a fault code in BMW_FAULT_META.
 * @typedef {object} FaultMetaVariant
 * @property {string} sgbd - the SGBD this record is for
 * @property {string} name - the fault text on that module
 * @property {number|string} [info] - index into BMW_FAULT_INFO[hex]
 */

/**
 * The ISTA service document of one fault: every field is optional prose.
 * @typedef {Record<string, string>} FaultInfo
 */

// lazy-load window.BMW_FAULT_INDEX by injecting faultindex.js once. Like the
// other large BMW-derived fault data it isn't shipped in the repo -- try a
// local build copy first, then fall back to the Hugging Face dataset.
/** Hosted copy of the fault index. */
const FAULT_INDEX_HF =
  'https://huggingface.co/datasets/CraigFf/bmweb-etk/resolve/main/faults/faultindex.js';

/**
 * Inject faultindex.js once (local build copy first, then the hosted one).
 * Concurrent callers share the same in-flight promise.
 * @returns {Promise<void>} resolves once window.BMW_FAULT_INDEX is set
 */
function loadFaultIndex() {
  if (window.BMW_FAULT_INDEX) return Promise.resolve();
  if (window.__faultIndexLoading) return window.__faultIndexLoading;
  const base = typeof WEB_BASE === 'string' ? WEB_BASE : '';
  const urls = [`${base}/data/faultindex.js`, FAULT_INDEX_HF];
  // the local copy is probed quietly first (core/translate.js): a hosted
  // build has none and must not log a 404
  window.__faultIndexLoading = webInjectFirst(urls).then((loaded) => {
    if (!loaded) throw new Error('failed to load fault index');
  });
  return window.__faultIndexLoading;
}

// ISTA guided-diagnostic component procedures (tools/ista_extract.py from the
// decrypted DiagDocDb). slug -> { title, chapters:[{heading, paras}] }. ~12 MB,
// hosted on the same Hugging Face dataset as the ETK data, so it loads lazily
// the first time a fault detail is opened and never for a plain DTC search.
/** Hosted copy of the ISTA component procedures. */
const ISTA_TESTS_URL =
  'https://huggingface.co/datasets/CraigFf/bmweb-etk/resolve/main/ista/faulttests.json';

/** @type {Record<string, IstaTestDoc>|null} slug -> procedure, once loaded */
let istaTestDocs = null;

/**
 * Load (and cache) the ISTA component procedures. Never rejects: when neither
 * copy answers it resolves to an empty map and the modal still works.
 * @returns {Promise<Record<string, IstaTestDoc>>}
 */
function loadIstaTests() {
  if (istaTestDocs) return Promise.resolve(istaTestDocs);
  if (window.__istaTestsLoading) return window.__istaTestsLoading;
  const real =
    typeof webRealFetch === 'function'
      ? webRealFetch
      : window.fetch.bind(window);
  const base = typeof WEB_BASE === 'string' ? WEB_BASE : '';
  window.__istaTestsLoading = (async () => {
    // local copy first (if a build ever ships one), then Hugging Face
    for (const u of [`${base}/data/ista/faulttests.json`, ISTA_TESTS_URL]) {
      try {
        const r = await real(u);
        if (r && r.ok) {
          istaTestDocs = await r.json();
          return istaTestDocs;
        }
      } catch (e) {
        /* try next */
      }
    }
    istaTestDocs = {}; // give up quietly; modal still works
    return istaTestDocs;
  })();
  return window.__istaTestsLoading;
}

/** Shortest component slug the loose prefix match is allowed to use. */
const LOOKUP_SLUG_MIN = 4;

/**
 * A short all-caps MODULE: prefix in front of a fault name ("KOMBI: ..."):
 * fault names from the variant metadata are qualified by their ECU, and the
 * component is what follows. Only a short all-caps token qualifies, so a real
 * component name containing a colon is left alone.
 */
const LOOKUP_MODULE_PREFIX_RE = /^[A-Z][A-Z0-9_ -]{1,14}:\s*/;

/**
 * A leading fault CODE in front of a fault name ("27C3 Oil level sensor").
 *
 * faultName returns "CODE Name", because a technician reads the code first,
 * and the fault table and the hit list both show it that way. The procedure
 * set is keyed by the component alone, so the code has to come off before
 * the name is slugged -- otherwise every fault slugs to "27c3-oil-level-
 * sensor", matches nothing, and the hit list says no procedure is linked to
 * a fault whose procedure is right there.
 *
 * Two to six hex digits, or a P-code, followed by a space and a letter: a
 * component name that happens to START with a number ("4 wheel drive") has
 * no space-separated hex token in front of it and is left alone.
 */
const LOOKUP_CODE_PREFIX_RE = /^(?:[0-9A-F]{2,6}|P[0-9A-F]{4})\s+(?=[A-Za-z])/i;

/**
 * Slug form of a component name, as the procedure set is keyed.
 * @param {string} s - free text
 * @returns {string}
 */
function lookupSlug(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Match a fault's English text to an ISTA component procedure. Fault text
 * names its component up front ("Throttle valve, sensor 1, signal: Short
 * circuit"), so try the leading noun phrase (before the first comma/colon),
 * then looser contains matches, against the slug set.
 * @param {string} faultText - the fault's English name
 * @returns {IstaTestDoc|null} the procedure, or null when nothing matches or the set isn't loaded
 */
function istaTestFor(faultText) {
  if (!istaTestDocs || !faultText) return null;
  let t = String(faultText).trim();
  // Drop a leading MODULE: prefix first -- without this, the phrase before the
  // first colon is the module ("KOMBI"), which matches no component slug and
  // loses the procedure entirely.
  t = t.replace(LOOKUP_MODULE_PREFIX_RE, '').trim() || t;
  // and the fault code the name is prefixed with, for the same reason
  t = t.replace(LOOKUP_CODE_PREFIX_RE, '').trim() || t;
  // the component is the phrase before the first comma or colon
  const lead = t.split(/[,:]/)[0].trim();
  const candidates = [lead, t];
  for (const c of candidates) {
    const slug = lookupSlug(c);
    if (slug && istaTestDocs[slug]) return istaTestDocs[slug];
  }
  // loosen: a slug that starts with the lead component, or vice versa, taking
  // the shortest (most general) match so "throttle valve" doesn't grab a long
  // unrelated slug that merely contains the words
  const leadSlug = lookupSlug(lead);
  if (leadSlug.length >= LOOKUP_SLUG_MIN) {
    let best = null;
    for (const slug in istaTestDocs) {
      if (
        slug === leadSlug ||
        slug.startsWith(leadSlug + '-') ||
        leadSlug.startsWith(slug + '-')
      ) {
        if (!best || slug.length < best.length) best = slug;
      }
    }
    if (best) return istaTestDocs[best];
  }
  return null;
}
