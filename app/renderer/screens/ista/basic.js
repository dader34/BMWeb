/**
 * @file Operations / New / Basic Features: open a vehicle without a VIN.
 *
 * THE OTHER WAY IN. The VIN page needs a number off the car. This one is for
 * when you have the car in front of you and not its papers: you pick what it
 * IS -- a 3', an E46, a Coupe, an M54 -- and the page narrows to the vehicle
 * those choices describe. ISTA calls the choices "basic features" and lays
 * them out in three panes: the criteria on the left, the values of whichever
 * criterion is selected in the middle, and the choices made so far on the
 * right. That is what this draws.
 *
 * THE CRITERIA AND THEIR VALUES ARE ISTA'S OWN. The workshop extract ships
 * the tool's characteristic tree: roots.json names the basic features,
 * typekeys.json says which value each feature takes for each of the 7,630
 * type keys, and characteristics.json turns a value id into the string the
 * tool prints. So a criterion is listed because the tool has one, its values
 * are the values BMW recorded, and a set of choices narrows to real type
 * keys rather than to a description nobody built.
 *
 * WHY THE TYPE KEY IS THE UNIT. Every row of typekeys.json is one four-
 * character type key -- the same key a VIN carries at characters 4-7 -- and
 * it holds exactly one value per feature. That makes "how many vehicles do
 * these choices still describe" a count of matching rows, and it makes the
 * answer openable: the type key's Development code IS the chassis, which is
 * what the rest of the app needs to load a car.
 *
 * WHY A FEATURE WITH NO VALUES IS NOT LISTED. Fifteen of the tool's
 * fifty-three roots (the HEAT placeholders, model year, model month) are
 * named in roots.json and carried by no type key at all. Listing them would
 * offer a question this data can never answer, so they are dropped entirely
 * rather than drawn as a dead row.
 */

/* exported istaBasicModel istaBasicRoots istaBasicHits istaBasicValues
   istaBasicChassis istaBasicRow istaBasicLoad istaBasicPresent
   istaPageBasic */

/**
 * The characteristic root whose value is the chassis (E46, F10 ...).
 *
 * The same id the Workshop tab filters on, for the same reason: ISTA calls
 * it the Development code and that string is what this app calls a chassis.
 */
const ISTA_BASIC_CHASSIS_ROOT = '53088651';

/**
 * The features the tool's own frame shows first, in its order.
 *
 * Root IDS, not names: two roots are both called "Electric motor", and the
 * frame's "Electrical machine" row is the composite 8-digit one, the way its
 * "Engine" row is the 3-character family rather than the 8-character code.
 * Naming them would pick the wrong one of each pair. Any root not listed
 * here still appears, after these -- the extract carries more features than
 * the frame has room for, and hiding them would lose real choices.
 * @type {string[]}
 */
const ISTA_BASIC_ORDER = [
  '63685259', // Model series
  '53088651', // Development code
  '53046411', // Body
  '63826443', // Sales designation
  '53363595', // Engine
  '20000143363276', // Electrical machine, 8-digit
  '2000016666796', // Basic version
  '53508235', // Steering
  '64555275', // Transmission
  '53513611', // Model code
];

/** @type {object|null} the loaded model, built once per page load */
let istaBasicCache = null;
/** @type {Promise<object|null>|null} the in-flight load */
let istaBasicLoading = null;

/**
 * The three files folded into one model the panes can query.
 *
 * ONE PASS, BECAUSE THE PANES ARE ASKED CONSTANTLY. Every keystroke redraws
 * three panes over 7,630 type keys, so the value ids are interned to the
 * strings the reader sees here, once, and the panes compare strings. Sharing
 * one string per value also makes the "values still consistent" intersect a
 * set membership test instead of a lookup per candidate.
 * @param {object|null} roots - root id to feature name
 * @param {object|null} typekeys - type key to {root id: [value ids]}
 * @param {object|null} chars - value id to its printed name
 * @returns {object|null} the model, or null when a file is missing
 */
function istaBasicModel(roots, typekeys, chars) {
  if (!roots || !typekeys || !chars) return null;
  /** @type {Array<{key: string, vals: Object<string, string>}>} */
  const keys = [];
  /** @type {Map<string, Set<string>>} root id -> the values it takes */
  const seen = new Map();
  for (const key of Object.keys(typekeys)) {
    const raw = typekeys[key] || {};
    /** @type {Object<string, string>} */
    const vals = {};
    for (const root of Object.keys(raw)) {
      const ids = raw[root] || [];
      // one value per feature per type key is what the extract holds; a
      // second would mean the type key answers the question twice, so the
      // first is taken and the rest ignored rather than guessed between
      const name = ids.length ? chars[String(ids[0])] : null;
      if (name == null) continue;
      vals[root] = String(name);
      if (!seen.has(root)) seen.set(root, new Set());
      seen.get(root).add(String(name));
    }
    keys.push({ key, vals });
  }
  /** @type {Array<{id: string, label: string}>} */
  const listed = [];
  const rank = (id) => {
    const i = ISTA_BASIC_ORDER.indexOf(id);
    return i < 0 ? ISTA_BASIC_ORDER.length : i;
  };
  for (const id of Object.keys(roots)) {
    // a feature no type key carries cannot be answered, so it is not asked
    if (!seen.has(id) || !seen.get(id).size) continue;
    listed.push({ id, label: String(roots[id]) });
  }
  listed.sort((a, b) => {
    const d = rank(a.id) - rank(b.id);
    if (d) return d;
    // the frame's own rows keep the frame's order; the extras behind them
    // are alphabetical, which is the only order the data suggests
    return a.label.localeCompare(b.label, 'en', { numeric: true });
  });
  return { roots: listed, keys, values: seen };
}

/**
 * The features this build can offer, in the tool's order.
 * @param {object|null} model - see istaBasicModel
 * @returns {Array<{id: string, label: string}>}
 */
function istaBasicRoots(model) {
  return model ? model.roots.slice() : [];
}

/**
 * Does a type key carry every value picked so far?
 * @param {object} row - one type key's {root id: value}
 * @param {Array<[string, string]>} want - the picks, as pairs
 * @returns {boolean}
 */
function istaBasicFits(row, want) {
  for (const [root, val] of want) if (row.vals[root] !== val) return false;
  return true;
}

/**
 * The type keys still described by the choices made so far.
 *
 * No choices is every type key, which is what the tool's "Hits" reads before
 * the first click.
 * @param {object|null} model - see istaBasicModel
 * @param {Object<string, string>} picked - root id to value
 * @returns {object[]} the matching type key rows
 */
function istaBasicHits(model, picked) {
  if (!model) return [];
  const want = Object.entries(picked || {});
  if (!want.length) return model.keys.slice();
  return model.keys.filter((row) => istaBasicFits(row, want));
}

/**
 * The values one feature can still take, given the others.
 *
 * ONLY THE OTHER CHOICES NARROW IT. A feature has to keep offering its own
 * alternatives after one of them is picked, or changing your mind would mean
 * clearing the whole form. So the intersect is taken over the picks EXCEPT
 * this feature's: a value is offered when at least one type key carries it
 * and carries everything else already chosen.
 * @param {object|null} model - see istaBasicModel
 * @param {Object<string, string>} picked - root id to value
 * @param {string} root - the feature being listed
 * @returns {string[]} its values, deduped and sorted naturally
 */
function istaBasicValues(model, picked, root) {
  if (!model) return [];
  const want = Object.entries(picked || {}).filter(([id]) => id !== root);
  const out = new Set();
  for (const row of model.keys) {
    const v = row.vals[root];
    if (v === undefined || out.has(v)) continue;
    if (istaBasicFits(row, want)) out.add(v);
  }
  return [...out].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

/**
 * The chassis a type key belongs to.
 *
 * Its Development code, straight out of the model: that root's value IS the
 * chassis string the rest of the app uses. A type key whose Development code
 * the extract does not carry has no chassis, and says so with null rather
 * than with a guess the garage would then store.
 * @param {object|null} row - a type key row
 * @returns {string|null}
 */
function istaBasicChassis(row) {
  const v = row && row.vals && row.vals[ISTA_BASIC_CHASSIS_ROOT];
  // "-" is the extract's own placeholder for "not recorded", and it is not
  // a chassis
  return v && v !== '-' ? v : null;
}

/**
 * One matched type key, in the shape the opener wants.
 *
 * `chassis` is what loads the car; `typeKey` rides along so a type key with
 * no Development code can still be opened by its own id rather than
 * silently doing nothing.
 * @param {object|null} model - see istaBasicModel
 * @param {object|null} row - a type key row
 * @returns {object|null}
 */
function istaBasicRow(model, row) {
  if (!row) return null;
  const at = (id) => row.vals[id] || '';
  return {
    typeKey: row.key,
    chassis: istaBasicChassis(row) || '',
    model: at('63685259'),
    body: at('53046411'),
    motor: at('53363595'),
    sales: at('63826443'),
    mospid: at('53513611'),
    steer: at('53508235'),
    _year: '',
    _month: '',
  };
}

/**
 * The three files, local copy first then the hosted dataset.
 *
 * Fetched through the Workshop tab's helper rather than a second path of its
 * own: the files live in that extract's folder and resolve the same two
 * ways, and two fetchers would be two answers to "is this build offline".
 * Loaded once and kept -- typekeys.json alone is 5 MB, and a redraw per
 * keystroke cannot pay for it twice.
 * @returns {Promise<object|null>} the model, null when the files are absent
 */
function istaBasicLoad() {
  if (istaBasicCache) return Promise.resolve(istaBasicCache);
  if (istaBasicLoading) return istaBasicLoading;
  istaBasicLoading = (async () => {
    if (typeof techDataFetchJson !== 'function') return null;
    const [roots, typekeys, chars] = await Promise.all([
      techDataFetchJson('roots.json'),
      techDataFetchJson('typekeys.json'),
      techDataFetchJson('characteristics.json'),
    ]);
    istaBasicCache = istaBasicModel(roots, typekeys, chars);
    return istaBasicCache;
  })();
  return istaBasicLoading;
}

/**
 * Did this build ship the characteristic tree?
 * @returns {Promise<boolean>}
 */
async function istaBasicPresent() {
  const m = await istaBasicLoad().catch(() => null);
  return !!(m && m.roots.length);
}

/**
 * Operations / New / Basic Features.
 * @param {HTMLElement} host - where to draw
 * @param {object} ctx - the shell's hooks
 * @param {object} [ctx.model] - a prebuilt model, for tests
 * @param {(n: number, row: object|null) => void} ctx.onChange - narrowed
 * @returns {Promise<void>}
 */
async function istaPageBasic(host, ctx) {
  const model =
    ctx && ctx.model !== undefined ? ctx.model : await istaBasicLoad();
  if (!host.isConnected && typeof document !== 'undefined') return;
  if (!model || !model.roots.length) {
    host.innerHTML =
      `<div class="irbf"><div class="irbf-pane"><div class="irbf-head">` +
      `Basic features</div><div class="irbf-list"><div class="irbf-none">` +
      `the vehicle characteristic tree is not in this build, so a vehicle ` +
      `cannot be described feature by feature here</div></div></div></div>`;
    if (ctx && ctx.onChange) ctx.onChange(0, null);
    return;
  }

  /** @type {Object<string, string>} */
  const picked = {};
  let active = model.roots[0].id;

  /** Redraw all three panes. */
  function paint() {
    const left = model.roots
      .map(
        (r) =>
          `<div class="irbf-row${r.id === active ? ' on' : ''}" ` +
          `data-c="${esc(r.id)}">${esc(r.label)}</div>`
      )
      .join('');

    const cur = model.roots.find((r) => r.id === active) || model.roots[0];
    const vals = istaBasicValues(model, picked, cur.id);
    const mid = vals
      .map(
        (v) =>
          `<div class="irbf-row${picked[cur.id] === v ? ' on' : ''}" ` +
          `data-v="${esc(v)}">${esc(v)}</div>`
      )
      .join('');

    const chosen = model.roots
      .map((r) => {
        const v = picked[r.id];
        return (
          `<div class="irbf-row${v ? ' has' : ''}" data-x="${esc(r.id)}">` +
          `<span class="irbf-k">${esc(r.label)}</span>` +
          (v ? `<span class="irbf-v">${esc(v)}</span>` : '') +
          `</div>`
        );
      })
      .join('');

    host.innerHTML =
      `<div class="irbf">` +
      `<div class="irbf-pane"><div class="irbf-head">Basic features</div>` +
      `<div class="irbf-list">${left}</div></div>` +
      `<div class="irbf-pane"><div class="irbf-head">${esc(cur.label)}</div>` +
      `<div class="irbf-list">${mid}</div></div>` +
      `<div class="irbf-pane irbf-sel">` +
      `<div class="irbf-head">Selected basic features</div>` +
      `<div class="irbf-list">${chosen}</div></div>` +
      `</div>`;

    host.querySelectorAll('[data-c]').forEach((el) => {
      el.onclick = () => {
        active = el.dataset.c;
        paint();
      };
    });
    host.querySelectorAll('[data-v]').forEach((el) => {
      el.onclick = () => {
        // clicking the chosen value again clears it, which is how a reader
        // backs out of a choice without reloading the page
        if (picked[cur.id] === el.dataset.v) delete picked[cur.id];
        else picked[cur.id] = el.dataset.v;
        paint();
      };
    });
    host.querySelectorAll('[data-x]').forEach((el) => {
      el.onclick = () => {
        delete picked[el.dataset.x];
        paint();
      };
    });

    const hits = istaBasicHits(model, picked);
    if (ctx && ctx.onChange)
      ctx.onChange(
        hits.length,
        hits.length === 1 ? istaBasicRow(model, hits[0]) : null
      );
  }

  host._istaBasic = () => ({ picked, hits: istaBasicHits(model, picked) });
  paint();
}

if (typeof window !== 'undefined') {
  window.istaBasicPresent = istaBasicPresent;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ISTA_BASIC_CHASSIS_ROOT,
    ISTA_BASIC_ORDER,
    istaBasicModel,
    istaBasicRoots,
    istaBasicHits,
    istaBasicValues,
    istaBasicChassis,
    istaBasicRow,
    istaBasicLoad,
    istaBasicPresent,
    istaPageBasic,
  };
}
