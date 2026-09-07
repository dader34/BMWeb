/**
 * @file The Coding hub: the one place coding lives, reached from the chassis
 * Coding tile. Two tabs:
 *   Features  -- curated owner-facing toggles (showCuratedCoding), only where a
 *                chassis has a curated map.
 *   Expert    -- every codeable module's raw coding. Desktop: one searchable
 *                nested tree (expertTree). Mobile: a module list that drills
 *                into expertModuleScreen.
 *
 * The hub reads the whole car up front (scanCoding) so both tabs' toggles
 * start at the car's current values without per-module Read buttons.
 */

/**
 * Does this chassis have anything to code? Drives the chassis-screen tile.
 * @param {string} chassisId - chassis id.
 * @returns {Promise<boolean>} true when at least one module is codeable.
 */
async function chassisHasCoding(chassisId) {
  return (await codeableModules(chassisId)).length > 0;
}

/**
 * The "Connect a cable to code" empty state, drawn when no port is open.
 * @param {() => void} back - the Back action.
 * @returns {void}
 */
function codingNeedsCable(back) {
  const need = document.createElement('div');
  need.className = 'empty';
  need.innerHTML =
    `<div class="empty-big" style="color:var(--amber)">Connect a cable to code</div>` +
    `<div>Coding shows what the car is set to now, and stages changes ` +
    `against it. With nothing connected there is nothing to read.</div>` +
    `<div style="font-size:12px;color:var(--ink-faint);max-width:48ch">` +
    `Showing defaults here would look like the car’s own settings. ` +
    `Connect the cable and open Coding again.</div>`;
  view.appendChild(need);
  setActions([
    {
      key: 'Escape',
      keyLabel: 'Esc',
      label: 'Back',
      kind: 'back',
      fn: back,
    },
  ]);
  sbLeft.textContent = 'coding needs a cable';
}

/**
 * The indeterminate loading shell shown while the car identifies itself.
 * @param {string} title - the headline.
 * @param {string} [sub] - the small mono line under the bar.
 * @returns {string} HTML.
 */
function codingScanShell(title, sub) {
  return (
    `<div class="coding-scan">` +
    `<div class="coding-scan-title">${esc(title)}</div>` +
    `<div class="coding-scan-bar coding-scan-indef"><span></span></div>` +
    `<div class="coding-scan-mod mono">${esc(sub || '')}</div></div>`
  );
}

/**
 * The Coding hub screen.
 * @param {string} chassisId - chassis id.
 * @param {'features'|'expert'} [initialTab] - which tab opens first.
 * @returns {Promise<void>} resolves once drawn (or abandoned).
 */
async function showCodingHub(chassisId, initialTab) {
  // STALENESS TOKEN. The read is several awaits long; if the user backs out
  // mid-read, a later screen reassigns lastScreen, and this run must abort
  // rather than paint the coding panel onto whatever is showing now. Every
  // screen fn sets lastScreen at entry, so "is my token still installed?"
  // is the honest test.
  const myToken = () => showCodingHub(chassisId, initialTab);
  lastScreen = myToken;
  const alive = () => lastScreen === myToken;
  const back = () =>
    typeof backToModules === 'function'
      ? backToModules(chassisId)
      : typeof showSections === 'function'
        ? showSections(chassisId)
        : showChassis();
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: dispChassis(chassisId), fn: back },
    { label: 'Coding' },
  ]);
  sbLeft.textContent = `${dispChassis(chassisId)} · coding`;

  const curated = typeof hasCurated === 'function' && hasCurated(chassisId);
  let tab = initialTab || (curated ? 'features' : 'expert');

  view.innerHTML = head(
    'Coding',
    dispChassis(chassisId),
    'Change how the car is configured. Nothing is sent — changes are staged ' +
      'for review.'
  );

  // A CABLE IS REQUIRED TO CODE. Every toggle here is the car's current
  // setting, and a change is staged as a delta against it. With nothing
  // connected the reads all fail and the editor used to draw the whole car
  // anyway, at library defaults -- settings that look read but are invented.
  {
    let port = null;
    try {
      ({ port } = await api('/api/port'));
    } catch {
      /* treated as none */
    }
    if (!port) {
      codingNeedsCable(back);
      return;
    }
  }

  // ONE LOADING REGION FOR THE WHOLE READ. Two awaits precede the module
  // scan -- the vehicle SA codes (an identity read) and the scan itself --
  // and both were silent before, so the pane sat blank, then the scan bar
  // appeared mid-render. A single host, shown immediately and replaced
  // atomically, covers the lot: the reader never sees a blank coding page or
  // a progress bar arriving after the toggles.
  const loadHost = document.createElement('div');
  view.appendChild(loadHost);
  loadHost.innerHTML = codingScanShell(
    'Reading the car…',
    'identifying equipment…'
  );
  setActions([
    { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: back },
  ]);

  // THE CAR'S EQUIPMENT FIRST, THEN THE MODULES.
  //
  // Which module fills a slot depends on what the car was built with, so the
  // equipment codes have to be in hand before the module list is built. BMW
  // reads them from the vehicle order (or, on older cars, decodes them out of
  // the coding key) and evaluates each candidate's predicate against them.
  //
  // A car that will not say is not a failure: with no codes the config's own
  // module names stand, exactly as before.
  const saCodes = await readVehicleSaCodes(chassisId);
  if (!alive()) return; // backed out during identify

  // Read the whole car up front so both tabs' toggles start at the car's
  // current values without per-module Read buttons. The scan paints its
  // determinate progress into the SAME host, so the bar continues from the
  // indeterminate identify phase with no flash of empty page between.
  let scan = await scanCoding(chassisId, loadHost, saCodes);
  if (!alive()) {
    loadHost.remove();
    return;
  } // backed out mid-scan
  loadHost.remove();

  const tabs = document.createElement('div');
  tabs.className = 'coding-tabs';
  tabs.innerHTML =
    (curated
      ? `<button class="coding-tab" data-tab="features">Features</button>`
      : '') + `<button class="coding-tab" data-tab="expert">Expert</button>`;
  view.appendChild(tabs);
  const panel = document.createElement('div');
  panel.className = 'coding-panel';
  view.appendChild(panel);

  // Re-read the whole car and redraw the active tab. The single Re-read
  // control, surfaced top-right on mobile (kind:'navAction') like Back top-left.
  const reScan = async () => {
    const host = document.createElement('div');
    panel.replaceWith(host);
    host.id = 'coding-panel';
    host.className = 'coding-panel';
    scan = await scanCoding(chassisId, host, saCodes);
    if (!alive()) {
      host.remove();
      return;
    }
    host.replaceWith(panel);
    panel.innerHTML = '';
    select(tab);
  };

  const select = (t) => {
    tab = t;
    tabs
      .querySelectorAll('.coding-tab')
      .forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    if (t === 'features' && typeof showCuratedCoding === 'function') {
      showCuratedCoding(chassisId, panel, back, scan, reScan);
    } else {
      showExpertCoding(chassisId, panel, back, scan, reScan);
    }
  };
  tabs
    .querySelectorAll('.coding-tab')
    .forEach((b) => (b.onclick = () => select(b.dataset.tab)));
  select(tab);
}

/** Viewport query below which the Expert tab drills down instead of nesting. */
const CODING_MOBILE_QUERY = '(max-width: 760px)';

/**
 * Expert tab. Desktop gets the nested tree, mobile the drill-down list, both
 * from the SAME source (DATEN description fused with the scan's current
 * values) so a module reads identically on either.
 * @param {string} chassisId - chassis id.
 * @param {HTMLElement} cont - the panel to draw into.
 * @param {() => void} back - the Back action.
 * @param {ScanCache|null} scan - the scan.
 * @param {(() => Promise<void>)|null} reScan - the hub's re-read, when any.
 * @returns {Promise<void>} resolves once drawn.
 */
async function showExpertCoding(chassisId, cont, back, scan, reScan) {
  const mobile =
    window.matchMedia && window.matchMedia(CODING_MOBILE_QUERY).matches;
  // THE SAME LIST THE SCAN READ. This used to call codeableModules without
  // saCodes, so the expert tab built its tree from the UNSELECTED names while
  // the scan had read the selected ones -- the two disagreed about which
  // variant a slot holds. Take the scan's own modules, which are also the
  // ones codingResolveVariants retargeted.
  const all = (scan && scan.mods) || (await codeableModules(chassisId));
  if (!all.length) {
    cont.innerHTML = errorBlock('No codeable modules on this chassis.');
    return;
  }
  // ONLY WHAT THE CAR ANSWERED. The chassis map lists every module BMW ever
  // fitted to this shell -- on a real E46 that is SMG2, RDC, DWA, mirror
  // memory, cruise, the rollover sensor, none of which this car has. Reading
  // the car found 7 of 15. Offering the other eight means offering settings
  // for hardware that is not there.
  const mods = codingPresent(all, scan);
  if (!mods.length) {
    cont.innerHTML = errorBlock(
      'No module answered a coding read. Check the cable and ignition ' +
        '(engine off, key on), then re-read.'
    );
    return;
  }
  if (mobile) expertModuleList(chassisId, mods, cont, back, scan, reScan);
  else expertTree(chassisId, mods, cont, back, scan, reScan);
}

if (typeof window !== 'undefined') {
  window.showCodingHub = showCodingHub;
  window.chassisHasCoding = chassisHasCoding;
}
