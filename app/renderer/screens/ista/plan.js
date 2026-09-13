/* exported istaPlanRows istaPlanAdd istaPlanSet istaPlanSetState
   istaPlanClear istaPlanGroupRows istaPlanSort ISTA_PLAN_KEY istaAblIndex
   istaAblLoad istaAblUrls istaPlanStateFor */
/* global Settings WEB_BASE webRealFetch */

// The Test plan: what this car's diagnosis decided to test, and where the
// procedures behind those rows come from.
//
// PER CAR, AND IT OUTLIVES THE SESSION. The plan the old shell held was a
// bare array in module scope, deliberately not persisted -- a plan that
// outlived the car on the ramp was reckoned worse than no plan. That is
// right about a plan following the WRONG car and wrong about the same car
// tomorrow: a technician who calculates a plan, drives the car onto the
// ramp and comes back after lunch should find their plan. So the store is
// keyed by the Garage car id, the way the scans are, and a plan belongs to
// exactly one car forever.
//
// A ROW IS A POINTER, NOT A COPY. It carries the module's identifier, its
// title, the component it sits under and its priority; the recovered graph
// itself is fetched when the row is opened. A plan row therefore stays a
// few hundred bytes whether the module is 12 KB or 200 KB.

/** Settings key holding the per-car test plans. */
const ISTA_PLAN_KEY = 'bmweb.ista.testplan';

/** Hosted copy of the recovered test modules. */
const ISTA_ABL_HF_BASE =
  'https://huggingface.co/datasets/CraigFf/bmweb-etk/resolve/main/ista/abl/';

/**
 * @typedef {object} IstaPlanRow
 * @property {string} id - the module identifier (ABL-DIT-B1362_D6LDF)
 * @property {string} type - always ABL here; the tool's Type column
 * @property {string} title - what the row reads as
 * @property {string} component - the heading row it sits under
 * @property {number} priority - the tool's Priority column, lower first
 * @property {string} state - none | performed | canceled | suspected
 * @property {string} [fault] - the fault code that put it here
 * @property {object} [doc] - a linked document, when the row came from one
 */

/**
 * Every plan, by car id.
 * @returns {Object<string, IstaPlanRow[]>}
 */
function istaPlanAll() {
  if (typeof Settings === 'undefined') return {};
  const raw = Settings.get(ISTA_PLAN_KEY, null);
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

/**
 * One car's test plan.
 * @param {object|string|null} car - the GarageCar, or its id
 * @returns {IstaPlanRow[]} the rows, oldest first
 */
function istaPlanRows(car) {
  const id = car && typeof car === 'object' ? car.id : car;
  if (!id) return [];
  const rows = istaPlanAll()[id];
  return Array.isArray(rows) ? rows : [];
}

/**
 * Write one car's plan back.
 * @param {string} id - the car id
 * @param {IstaPlanRow[]} rows - the plan
 * @returns {void}
 */
function istaPlanWrite(id, rows) {
  if (!id || typeof Settings === 'undefined') return;
  const all = istaPlanAll();
  if (rows && rows.length) all[id] = rows;
  else delete all[id];
  Settings.set(ISTA_PLAN_KEY, all);
}

/**
 * Add rows to a car's plan, skipping what is already there.
 *
 * A module reached from two faults is ONE row. The tool's plan is a list of
 * work, and the same procedure listed twice is two technicians doing it.
 * @param {object|string|null} car - the GarageCar, or its id
 * @param {IstaPlanRow[]} rows - what to add
 * @returns {number} how many were actually added
 */
/**
 * One caller's row as the store holds it.
 *
 * A row is a POINTER, so every field is flattened to the primitive the
 * store round-trips through Settings; handing in a live object would
 * otherwise put whatever it referenced into the saved plan.
 * @param {IstaPlanRow} r - the caller's row
 * @returns {IstaPlanRow} the stored shape
 */
function istaPlanRowOf(r) {
  return {
    id: String(r.id || ''),
    type: String(r.type || 'ABL'),
    title: String(r.title || r.id || ''),
    component: String(r.component || r.title || ''),
    priority: r.priority == null ? 0 : Number(r.priority),
    state: String(r.state || 'none'),
    fault: r.fault ? String(r.fault) : '',
    doc: r.doc || null,
  };
}

/**
 * The key that makes two rows the same piece of work.
 * @param {IstaPlanRow} r - a row
 * @returns {string} its identity
 */
function istaPlanKeyOf(r) {
  return `${r.type || 'ABL'}\u0000${r.id || r.title}`;
}

function istaPlanAdd(car, rows) {
  const id = car && typeof car === 'object' ? car.id : car;
  if (!id || !Array.isArray(rows) || !rows.length) return 0;
  const have = istaPlanRows(id);
  const seen = new Set(have.map(istaPlanKeyOf));
  let added = 0;
  for (const r of rows) {
    if (!r) continue;
    const key = istaPlanKeyOf(r);
    if (seen.has(key)) continue;
    seen.add(key);
    have.push(istaPlanRowOf(r));
    added++;
  }
  if (added) istaPlanWrite(id, have);
  return added;
}

/**
 * REPLACE a car's plan with these rows.
 *
 * WHY REPLACE RATHER THAN APPEND. "Calculate test plan" calculates A plan,
 * for the fault the technician just picked, and the tool's own frames show
 * it doing exactly that: the Test plan's hit count counts UP FROM ZERO
 * (0/0 -> 1/2 -> 2/3 -> 3/4) as the rows build, so what lands is that one
 * calculation's result and nothing else. Appending instead accumulated
 * every fault ever calculated on the car -- one picked code came back with
 * 59 rows, which is not a test plan, it is a pile.
 *
 * The work a technician already DID is not thrown away with the rows: a
 * module carried over from the previous plan keeps the state its run left
 * it in, so recalculating never silently un-performs a finished test.
 * @param {object|string|null} car - the GarageCar, or its id
 * @param {IstaPlanRow[]} rows - the whole new plan
 * @returns {number} how many rows the plan now holds
 */
function istaPlanSet(car, rows) {
  const id = car && typeof car === 'object' ? car.id : car;
  if (!id) return 0;
  // what the old plan knew about each module's run, keyed the same way the
  // de-duplication is, so a recalculated row is recognised as the same work
  const was = new Map();
  for (const r of istaPlanRows(id)) was.set(istaPlanKeyOf(r), r.state);
  const seen = new Set();
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r) continue;
    const key = istaPlanKeyOf(r);
    if (seen.has(key)) continue;
    seen.add(key);
    const row = istaPlanRowOf(r);
    // a row the caller left at 'none' takes back the verdict its last run
    // reached; an explicit state from the caller wins over the old one
    if (row.state === 'none' && was.has(key)) row.state = was.get(key);
    out.push(row);
  }
  istaPlanWrite(id, out);
  return out.length;
}

/**
 * The plan state a finished module's result leaves the row in.
 *
 * A module ends on one of ISTA's six CollectiveResult values, and the plan
 * has five states with their own colour in the legend. The mapping is what
 * each result MEANS for the row, not a rename:
 *  - Ok, Verified, Repaired: the test ran and settled. performed.
 *  - NotOk: the test ran and found the thing it was looking for, which is
 *    what puts a component under suspicion. suspected.
 *  - Unknown, None: it ran but reached no verdict, usually because a step
 *    was skipped. minimized, the tool's state for a test that did not
 *    complete on its own terms.
 *  - anything else, including a module the technician closed or a step
 *    this build could not run. canceled.
 * @param {string} result - the engine's verdict
 * @returns {string} none | performed | minimized | canceled | suspected
 */
function istaPlanStateFor(result) {
  switch (String(result || '')) {
    case 'Ok':
    case 'Verified':
    case 'Repaired':
      return 'performed';
    case 'NotOk':
      return 'suspected';
    case 'Unknown':
    case 'None':
      return 'minimized';
    default:
      return 'canceled';
  }
}

/**
 * Record what a run of a plan row came to.
 * @param {object|string|null} car - the GarageCar, or its id
 * @param {string} rowId - the module identifier
 * @param {string} state - none | performed | canceled | suspected
 * @returns {void}
 */
function istaPlanSetState(car, rowId, state) {
  const id = car && typeof car === 'object' ? car.id : car;
  if (!id || !rowId) return;
  const rows = istaPlanRows(id);
  let hit = false;
  for (const r of rows)
    if (r.id === rowId) {
      r.state = String(state || 'none');
      hit = true;
    }
  if (hit) istaPlanWrite(id, rows);
}

/**
 * Empty one car's plan.
 * @param {object|string|null} car - the GarageCar, or its id
 * @returns {void}
 */
function istaPlanClear(car) {
  const id = car && typeof car === 'object' ? car.id : car;
  if (id) istaPlanWrite(id, []);
}

/**
 * Sort a plan the way the tool's Priority column does.
 *
 * The frames sort ascending by default and the header carries the arrow.
 * Rows of equal priority keep the order they were added, which is the order
 * the faults were read in.
 * @param {IstaPlanRow[]} rows - the plan
 * @param {boolean} [desc] - largest first
 * @returns {IstaPlanRow[]} a new array
 */
function istaPlanSort(rows, desc) {
  const out = (rows || []).map((r, i) => [r, i]);
  out.sort((a, b) => {
    const d = (Number(a[0].priority) || 0) - (Number(b[0].priority) || 0);
    if (d) return desc ? -d : d;
    return a[1] - b[1];
  });
  return out.map((x) => x[0]);
}

/**
 * The plan as the Service plan's group list wants it.
 *
 * Rows are grouped under their component, and the heading carries the
 * group's own priority, because that is what the frames show: a grey
 * heading row with a number in the Priority column and its ABL rows beneath.
 * @param {IstaPlanRow[]} rows - the plan, already sorted
 * @returns {object[]} the groups
 */
function istaPlanGroupRows(rows) {
  /** @type {Map<string, object>} */
  const by = new Map();
  for (const r of rows || []) {
    const key = r.component || r.title || '-';
    if (!by.has(key))
      by.set(key, { title: key, priority: r.priority, rows: [] });
    const g = by.get(key);
    if (Number(r.priority) < Number(g.priority)) g.priority = r.priority;
    g.rows.push(r);
  }
  return [...by.values()];
}

/**
 * Where a recovered module is looked for: the local extract, then the
 * dataset. The same rule the diagnosis structures follow, so a build with
 * the extract never reaches the network and the hosted site still finds it.
 * @param {string} rel - the path under data/ista/abl/
 * @returns {string[]} the urls to try, in order
 */
function istaAblUrls(rel) {
  const base = typeof WEB_BASE === 'string' && WEB_BASE ? WEB_BASE : '.';
  return [`${base}/data/ista/abl/${rel}`, ISTA_ABL_HF_BASE + rel];
}

/**
 * Fetch and gunzip one JSON under data/ista/abl/.
 * @param {string} rel - the path under data/ista/abl/
 * @returns {Promise<object|null>} null when neither source answers
 */
async function istaAblFetch(rel) {
  if (typeof fflate === 'undefined') return null;
  const real =
    typeof webRealFetch === 'function'
      ? webRealFetch
      : typeof window !== 'undefined' && window.fetch
        ? window.fetch.bind(window)
        : null;
  if (!real) return null;
  for (const u of istaAblUrls(rel)) {
    try {
      const r = await real(u);
      if (!r || !r.ok) continue;
      const bytes = new Uint8Array(await r.arrayBuffer());
      const text = /\.gz$/.test(rel)
        ? new TextDecoder('utf-8').decode(fflate.gunzipSync(bytes))
        : new TextDecoder('utf-8').decode(bytes);
      return JSON.parse(text);
    } catch (e) {
      /* try the next source */
    }
  }
  return null;
}

/**
 * The per-chassis index of recovered modules, when one ships.
 *
 * The index answers two questions the plan needs: which modules apply to
 * this car at all, and which of them a fault code points at. A build
 * without the index is not broken -- the plan then carries whatever the
 * fault-to-procedure links already give it, and Display says which modules
 * it cannot open.
 * @param {string} chassis - the development code
 * @returns {Promise<object|null>}
 */
async function istaAblIndex(chassis) {
  const code = String(chassis || '').toUpperCase();
  if (!code) return null;
  return istaAblFetch(`${code}.json`);
}

/**
 * One recovered module's step graph.
 * @param {string} id - the module identifier (ABL-DIT-B1362_D6LDF)
 * @returns {Promise<object|null>} null when this build does not ship it
 */
async function istaAblLoad(id) {
  const name = String(id || '').trim();
  if (!name) return null;
  return istaAblFetch(`${name}.json.gz`);
}

if (typeof module !== 'undefined')
  module.exports = {
    ISTA_PLAN_KEY,
    ISTA_ABL_HF_BASE,
    istaPlanAll,
    istaPlanRows,
    istaPlanAdd,
    istaPlanSet,
    istaPlanSetState,
    istaPlanStateFor,
    istaPlanClear,
    istaPlanSort,
    istaPlanGroupRows,
    istaAblUrls,
    istaAblIndex,
    istaAblLoad,
  };
