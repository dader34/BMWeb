// ECU menu: job labels, variant resolution, showEcu.

/**
 * A control module as the chassis config lists it, plus the fields the
 * screens attach while it is open.
 * @typedef {Object} EcuRecord
 * @property {string} sgbd - The SGBD that drives it (retargeted after group resolution).
 * @property {string} code - The module designation shown on the card.
 * @property {string} label - The module name.
 * @property {string} [group] - The diagnostic-address group SGBD, when grouped.
 * @property {string} [chassis] - The chassis it was opened from (set by showEcu).
 * @property {string} [_variant] - The variant name the car answered with, upper-cased.
 * @property {'ungrouped'|'unavailable'|'nogroup'|'unverified'|'confirmed'|'identified'|null} [_variantSource] -
 *   How much the car confirmed about `sgbd`.
 * @property {string} [_sgbdBase] - The configured SGBD, once `sgbd` was retargeted.
 * @property {boolean} [_groupTried] - Whether group resolution ran this screen entry.
 * @property {object|null} [_ir] - The loaded script IR.
 * @property {string} [_irFrom] - The SGBD whose script `_ir` came from, when not `sgbd`.
 */

/**
 * English captions for the handful of raw job names the screens show as-is.
 * @type {Object<string, string>}
 */
const JOB_LABELS = {
  FS_LESEN: 'Read fault codes',
  FS_LESEN_DETAIL: 'Read fault codes (detail)',
  FS_LOESCHEN: 'Clear fault codes',
  IDENT: 'Identify ECU',
  INFO: 'ECU info',
  STATUS_LESEN: 'Read status',
  SERIENNUMMER_LESEN: 'Read serial number',
  CBS_DATEN_LESEN: 'Read CBS service data',
};

/**
 * A caption for a job name: the curated label, else the SNAKE_CASE humanised.
 * @param {string} j - The job name.
 * @returns {string}
 */
const jobLabel = (j) => {
  if (JOB_LABELS[j]) return JOB_LABELS[j];
  // humanise SNAKE_CASE
  return j
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
};

// BEFORE the IR loads: let the ecu's diagnostic-address group name the real
// variant, exactly like the scan does (and like INPA does on open). The
// configured SGBD can be a wrong-generation sibling that happily answers --
// the E46 config maps Airbag to zae while the car carries an MRS, and zae
// decodes the MRS's answer as a false 0 faults. The group's IDENTIFIKATION
// (D_00A4 bytecode in the VM) is immune to that mixup. One attempt per ecu
// per screen entry; webResolveVariant caches per session underneath, so the
// wire sees one ident exchange per group per connection.
/** The one in-flight/settled fetch of the group index. @type {Promise<{groups?: string[]}|null>|null} */
let _ecuGroupIndexP = null;

/**
 * The shipped group index (which diagnostic-address groups carry bytecode),
 * fetched once per session; null when the build has none.
 * @returns {Promise<{groups?: string[]}|null>}
 */
const ecuGroupIndex = () =>
  (_ecuGroupIndexP ??= fetch('data/groups/index.json')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null));

/**
 * Let the ECU's diagnostic-address group name the real variant before the IR
 * loads, recording how much the car confirmed in `_variantSource` and
 * retargeting `sgbd` only when a concrete variant SGBD actually ships.
 * @param {EcuRecord} ecu - The module being opened (mutated in place).
 * @returns {Promise<void>}
 */
async function irResolveGroupVariant(ecu) {
  // One attempt per screen entry, EXCEPT after a failure to verify: a user
  // who plugs the cable in and re-opens the module must get a real answer,
  // not a cached "we never asked".
  if (
    ecu._groupTried &&
    !['unverified', 'unavailable'].includes(ecu._variantSource)
  )
    return;
  ecu._groupTried = true;
  // WHY the configured SGBD is still the one on screen. The chassis config
  // lists every variant BMW fitted at an address and the app opens the first
  // -- 609 of the 1000 grouped rows sit behind a group that can name a
  // DIFFERENT variant, so "we did not ask" and "the car confirmed it" are
  // completely different statements and the header must not render them the
  // same way. Set on every early return; cleared only by a real answer.
  ecu._variantSource = null;
  const g = String(ecu.group || '').toLowerCase();
  if (!g) {
    ecu._variantSource = 'ungrouped';
    return;
  }
  if (typeof webResolveVariant !== 'function') {
    ecu._variantSource = 'unavailable';
    return;
  }
  const idx = await ecuGroupIndex();
  if (!idx || !(idx.groups || []).includes(g)) {
    ecu._variantSource = 'nogroup';
    return;
  }
  let v = null;
  try {
    v = await webResolveVariant(g);
  } catch {
    /* silence: treated as no answer below */
  }
  if (!v) {
    // No cable, or the address stayed silent. Either way nothing verified
    // this SGBD, and the screen says so rather than implying the car agreed.
    ecu._variantSource = 'unverified';
    return;
  }
  if (v === String(ecu.sgbd).toLowerCase()) {
    ecu._variant = v.toUpperCase();
    ecu._variantSource = 'confirmed';
    return;
  }
  // THE VARIANT NAME IS INPAINIT'S GROUND TRUTH. The group's IDENTIFIKATION
  // returns the concrete variant (SM46_4) -- the same thing inpainit checks
  // against its expected list. Record it ALWAYS, even when this build cannot
  // load a separate SGBD for it: a family .prg (sm46 covering SM46_3/_4/C_*)
  // runs one script and inpainit validates the variant INSIDE it, so without
  // the real name inpainit compared its list against the SGBD filename "SM46"
  // -- which matches none of SM46_3/_4/... -- and stopped with a
  // self-contradictory "Requested 'SM46' not found. Found 'SM46'".
  ecu._variant = v.toUpperCase();
  ecu._variantSource = 'confirmed';
  // only RETARGET the SGBD when a concrete variant SGBD actually ships;
  // otherwise keep the family SGBD and just carry the resolved variant name.
  try {
    const jobs = await api(`/api/ecu/${v}/jobs`);
    if (!Array.isArray(jobs) || !jobs.length) return;
  } catch {
    return;
  }
  ecu._sgbdBase = ecu._sgbdBase || ecu.sgbd;
  ecu.sgbd = v;
  ecu._variantSource = 'identified';
  // The group ran IDENTIFIKATION and the answer IS the variant name -- the same
  // thing inpainit reads from INITIALISIERUNG. Record it: without
  // this the variant stayed unknown whenever the group answered first, and
  // every per-variant menu guard (menuFor) had nothing to match, so an E46 took
  // the first branch and landed on the E38 pages.
  if (!ecu._variant) ecu._variant = v.toUpperCase();
}

/**
 * Open a module from a deep link (#car/<CHASSIS>/<SGBD>[/<MENU>]): find it in
 * the chassis config and open it, else fall back to the module list.
 * @param {string} chassisId - The chassis id.
 * @param {string} sgbd - The module's SGBD (case-insensitive).
 * @param {string|null} [menuName] - A submenu to descend into once the script is up.
 * @returns {Promise<void>}
 */
async function showEcuDeep(chassisId, sgbd, menuName) {
  const ch = await tryApi(
    `/api/chassis/${chassisId}`,
    null,
    view,
    `failed to load ${dispChassis(chassisId)}`
  );
  if (!ch) return;
  const want = String(sgbd).toLowerCase();
  // the whole-vehicle script is reached by its chassis stem (#car/E46/e46)
  if (want === String(chassisId).toLowerCase())
    return showVehicleScript(chassisId, menuName);
  for (const sec of ch.sections || []) {
    const hit = (sec.ecus || []).find(
      (e) => String(e.sgbd).toLowerCase() === want
    );
    if (hit) return showEcu(chassisId, sec.name, hit, menuName);
  }
  sbLeft.textContent = `${sgbd} not in ${dispChassis(chassisId)}`;
  return backToModules(chassisId);
}

// ECU main menu: the running .IPO (screens/ipo-runtime.js). inpainit names
// the root, keys run their own bodies, screens send their own jobs; the
// module view is whatever the script draws. openMenu (optional) is a menu a
// deep link descends into once the script is up.
//
// Nothing here checks for a cable. The script's first job (INITIALISIERUNG)
// fails without one, and that failure IS the gate: "No adapter connected"
// with a Back key, the same words every other cable-needing screen shows.
/**
 * The module view: resolve the variant, load the script IR, and hand the
 * screen to the live .IPO runtime (or say there is no script to run).
 * @param {string} chassisId - The chassis id.
 * @param {string} sectionName - The config section the module sits in.
 * @param {EcuRecord} ecu - The module (mutated: chassis, variant, IR).
 * @param {string|null} [openMenu] - A menu a deep link descends into once the script is up.
 * @returns {Promise<void>}
 */
async function showEcu(chassisId, sectionName, ecu, openMenu) {
  lastScreen = () => showEcu(chassisId, sectionName, ecu, openMenu);
  // the ECU object comes from the chassis config and doesn't know which chassis
  // it came from; screens that build links/reports off it need that
  ecu.chassis = chassisId;
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: dispChassis(chassisId), fn: () => backToModules(chassisId) },
    { label: ecu.label },
  ]);
  sbLeft.textContent = `${ecu.sgbd}.prg`;
  view.innerHTML = head(
    `${sectionName} · ${ecu.code}`,
    ecu.label,
    `SGBD ${ecu.sgbd}.prg · running INPA's script`
  );

  const grid = document.createElement('div');
  grid.className = 'group-grid stagger';
  view.appendChild(grid);
  // shimmer placeholders while the script loads and identifies the module
  grid.innerHTML = skeletonList(6, false);

  // the silent reconnect on load may still be running: wait for it, or a
  // reload on a module deep link runs inpainit before the cable is back
  if (window.cableReady) await window.cableReady.catch(() => {});

  // group first, so the script runs against the variant the car actually
  // carries (zae's script is useless against an MRS4); the runtime hands
  // inpainit the name the group's IDENTIFIKATION returned
  await irResolveGroupVariant(ecu);
  // THE HEADER WAS WRITTEN BEFORE WE KNEW WHICH MODULE THIS IS: an E46
  // whose climate unit identifies as ihka46_3 must not read "ihka38.prg"
  if (ecu._sgbdBase && ecu._sgbdBase !== ecu.sgbd) {
    const sub = view.querySelector('.subtitle');
    if (sub) {
      sub.textContent =
        `SGBD ${ecu.sgbd}.prg · identified by the car ` +
        `(configured ${ecu._sgbdBase}) · running INPA's script`;
    }
  }
  // THE SGBD IS WHAT WE TALK TO; THE SCRIPT IS WHAT DRAWS. INPA loads ONE
  // script per diagnostic address (E46 climate = klima_5B, whose inpainit
  // hands an IHKA46_3 to IHKA46.IPO) and BMW ships no IHKA46_3.IPO. So when
  // the identified variant has no archive of its own, the configured base
  // SGBD's script is the one to run (irExecSgbd reads _irFrom). The archive's
  // ir carries the per-ECU caption dictionary (ir.i18n) the runtime draws with.
  const codeHint = ecu.code ? `?code=${encodeURIComponent(ecu.code)}` : '';
  ecu._ir = await api(`/api/ecu/${ecu.sgbd}/ir${codeHint}`).catch(() => null);
  if (
    (!ecu._ir || !Object.keys(ecu._ir.menus || {}).length) &&
    ecu._sgbdBase &&
    ecu._sgbdBase !== ecu.sgbd
  ) {
    const base = await api(`/api/ecu/${ecu._sgbdBase}/ir${codeHint}`).catch(
      () => null
    );
    if (base && Object.keys(base.menus || {}).length) {
      ecu._ir = base;
      ecu._irFrom = ecu._sgbdBase;
    }
  }

  const back = () => backToModules(chassisId);
  const took =
    typeof ipoProgramOpen === 'function' &&
    (await ipoProgramOpen(ecu, grid, back, openMenu));
  if (took) return;

  // No runnable script. Only reachable for the handful of ECUs BMW itself
  // never drew a UI for -- they carry "[OBT_SCREEN] ScreenCount=0" in INPA's
  // own .ini, and INPA shows them nothing either. Say so rather than
  // rendering a menu we invented.
  grid.className = 'results-panel';
  grid.innerHTML = errorBlock(
    'This ECU has no INPA screen definition (ScreenCount=0). ' +
      'Its jobs are shipped in ecus/ but INPA draws no UI for it.'
  );
  sbLeft.textContent = 'no screen';
  setActions([
    { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: back },
  ]);
}

/**
 * Number keys 1..9 bind to footer F-keys; anything past that needs another
 * selector (the Settings screen spells the overflow as Shift+Fn).
 * @type {number}
 */
const FKEY_SLOTS = 9;
