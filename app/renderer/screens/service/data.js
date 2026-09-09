/**
 * @file Loading the resolved service-function mapping, once.
 *
 * The mapping is built at export time (tools/export/service_functions.py)
 * from our own curated catalogue (data/service-functions.json) and the
 * decoded IR of every shipped script. Answering "where does the steering
 * angle calibration live on this car?" in the browser would mean scanning
 * every module's menus, so the scan runs once, at build time, and this
 * fetches the finished answer.
 *
 * The fetch goes through webRealFetch (the FILE, not the shim's /api/
 * router) because the mapping is a static artifact, not a route the shim
 * computes -- the same way the job search index is loaded.
 */

/* exported SERVICE_INDEX_VERSION, serviceIndexLoad, serviceIndexPeek, serviceIndexPresent, serviceTasksFor, serviceTaskById */

/** The mapping format this code understands; the builder stamps it as `v`. */
const SERVICE_INDEX_VERSION = 1;

/**
 * One curated task, as the catalogue describes it. The same task appears
 * once here however many chassis carry it.
 * @typedef {object} ServiceTask
 * @property {string} id - stable id, also the route's task part
 * @property {string} name - the task's English name
 * @property {string} category - one of the mapping's `categories`
 * @property {string} what - a sentence or two on what it does to the car
 * @property {string[]} before - what must be true before running it
 * @property {string} [after] - how to confirm it worked
 * @property {'write'|'read'} risk - whether running it changes the car
 */

/**
 * Where one task lives on one chassis: the module script, the menu the key
 * sits on, and the key itself.
 * @typedef {object} ServiceHit
 * @property {string} sgbd - the module's .prg name, lower-case
 * @property {string} module - the module's human name
 * @property {string} menu - the IR menu proc the key sits on
 * @property {number} nr - the key's F-key number
 * @property {string} label - the key's label as the script prints it
 * @property {string} job - the job it sends, '' when it runs a script body
 * @property {string|null} screen - the screen it opens, when it opens one
 * @property {'job'|'key'|'both'} why - what matched, for review
 * @property {boolean} writes - how the runtime's guard classifies this key
 */

/**
 * The whole mapping as the builder writes it.
 * @typedef {object} ServiceIndex
 * @property {number} v - format version
 * @property {ServiceTask[]} tasks - the curated catalogue
 * @property {string[]} categories - the display order of the categories
 * @property {Object<string, Object<string, ServiceHit[]>>} chassis - chassis id -> task id -> hits
 */

/** @type {ServiceIndex|null} the loaded mapping */
let serviceIndex = null;

/** @type {Promise<ServiceIndex|null>|null} the in-flight load, shared */
let serviceIndexPromise = null;

/**
 * Load the mapping, once. Concurrent callers share one fetch, and a failure
 * is remembered as "no mapping" rather than retried on every render.
 * @returns {Promise<ServiceIndex|null>} the mapping, or null when it cannot load
 */
function serviceIndexLoad() {
  if (serviceIndex) return Promise.resolve(serviceIndex);
  if (serviceIndexPromise) return serviceIndexPromise;
  const base = typeof WEB_BASE === 'string' ? WEB_BASE : '';
  const real =
    typeof webRealFetch === 'function'
      ? webRealFetch
      : window.fetch.bind(window);
  serviceIndexPromise = (async () => {
    try {
      const r = await real(`${base}/data/service-functions.chassis.json`);
      if (!r || !r.ok) return null;
      const doc = await r.json();
      // a format the app does not understand would be read field-by-field
      // into nonsense rows; refusing it shows the empty state instead
      if (!doc || doc.v !== SERVICE_INDEX_VERSION || !Array.isArray(doc.tasks))
        return null;
      serviceIndex = doc;
      return doc;
    } catch {
      return null;
    }
  })();
  return serviceIndexPromise;
}

/**
 * The mapping if it is already loaded, without starting a load.
 * @returns {ServiceIndex|null}
 */
function serviceIndexPeek() {
  return serviceIndex;
}

/** @type {Promise<boolean>|null} the in-flight presence probe, shared */
let serviceIndexPresentPromise = null;

/**
 * Whether this build ships the mapping at all, WITHOUT downloading it.
 *
 * The Apps hub greys a card whose data did not ship and asks every app that
 * question when it draws, so this asks for the headers only. A HEAD a static
 * host does not answer falls back to reporting present: a card wrongly shown
 * opens a screen that explains itself, while one wrongly hidden cannot be
 * found at all.
 * @returns {Promise<boolean>}
 */
function serviceIndexPresent() {
  if (serviceIndex) return Promise.resolve(true);
  if (serviceIndexPresentPromise) return serviceIndexPresentPromise;
  const base = typeof WEB_BASE === 'string' ? WEB_BASE : '';
  const real =
    typeof webRealFetch === 'function'
      ? webRealFetch
      : window.fetch.bind(window);
  serviceIndexPresentPromise = (async () => {
    try {
      const r = await real(`${base}/data/service-functions.chassis.json`, {
        method: 'HEAD',
      });
      return !!(r && r.ok);
    } catch {
      return true;
    }
  })();
  return serviceIndexPresentPromise;
}

/**
 * One task by id.
 * @param {ServiceIndex|null} index - the loaded mapping
 * @param {string} id - the task id
 * @returns {ServiceTask|null}
 */
function serviceTaskById(index, id) {
  if (!index) return null;
  return (index.tasks || []).find((t) => t.id === id) || null;
}

/**
 * Every task, grouped by category, with where it lives on one chassis.
 *
 * A task with no hits on this chassis is NOT dropped: it is returned with an
 * empty `hits`, so the screen can say "not in INPA for this chassis" rather
 * than silently shrinking the list. Knowing a function does not exist here is
 * an answer.
 * @param {ServiceIndex|null} index - the loaded mapping
 * @param {string} chassis - the chassis id, upper-case
 * @returns {Array<{category: string, tasks: Array<{task: ServiceTask, hits: ServiceHit[]}>}>}
 */
function serviceTasksFor(index, chassis) {
  if (!index) return [];
  const cid = String(chassis || '').toUpperCase();
  const forCar = (index.chassis && index.chassis[cid]) || {};
  const order = index.categories || [];
  const byCat = new Map(order.map((c) => [c, []]));
  for (const task of index.tasks || []) {
    if (!byCat.has(task.category)) byCat.set(task.category, []);
    byCat.get(task.category).push({ task, hits: forCar[task.id] || [] });
  }
  const out = [];
  for (const [category, tasks] of byCat) {
    if (!tasks.length) continue;
    // available first inside a category, so what the car can actually do
    // reads before what it cannot; stable by name within each half
    tasks.sort((a, b) => {
      const av = a.hits.length ? 0 : 1;
      const bv = b.hits.length ? 0 : 1;
      return av - bv || a.task.name.localeCompare(b.task.name);
    });
    out.push({ category, tasks });
  }
  return out;
}

/**
 * The chassis the mapping resolved anything for, with how many tasks each
 * carries -- the rows of the screen's chassis picker.
 * @param {ServiceIndex|null} index - the loaded mapping
 * @returns {Array<{val: string, label: string, meta: string, count: number}>}
 */
function serviceChassisOptions(index) {
  const all = (index && index.chassis) || {};
  return Object.keys(all)
    .sort()
    .map((id) => ({
      val: id,
      label: typeof dispChassis === 'function' ? dispChassis(id) : id,
      meta: (typeof CHASSIS_TAG !== 'undefined' && CHASSIS_TAG[id]) || '',
      count: Object.keys(all[id] || {}).length,
    }));
}

if (typeof window !== 'undefined') {
  window.serviceIndexLoad = serviceIndexLoad;
  window.serviceIndexPresent = serviceIndexPresent;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SERVICE_INDEX_VERSION,
    serviceIndexLoad,
    serviceIndexPeek,
    serviceIndexPresent,
    serviceTaskById,
    serviceTasksFor,
    serviceChassisOptions,
  };
}
