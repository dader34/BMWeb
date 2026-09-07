/**
 * @file VIN identification for wiring. The decoder screen (VIN input, Save
 * button and the saved-vehicles panel) is the shared showVinDecoder, reused
 * 1:1 so Parts and Wiring never drift; wiring keeps its own saved list. Once a
 * VIN is decoded this piece scores every diagram and document against it
 * (match / off / neutral, from BMW's applicability data) and draws the
 * "my car" banner that toggles the filter.
 */

/* exported
   wiringVinFilterOn, wiringSubtreeHasMatch, docsSubtreeHasMatch,
   buildWiringVinBox, buildWiringVinBanner */

/**
 * A decoded VIN, as the shared decoder hands it over.
 * @typedef {Object} WiringVinHit
 * @property {string} chassis - chassis code (E46, ...)
 * @property {string} [vin] - the VIN as typed, upper-cased
 * @property {string} [model] - model name (325i, ...)
 * @property {string} [body] - body code as the vin index spells it
 * @property {string} [motor] - engine code
 * @property {string} [steer] - 'L' or 'R'
 * @property {string} [prod] - build date, YYYYMM(..)
 */

/** localStorage key of wiring's own saved-vehicles list. */
const WIRING_VINS_KEY = 'wiringVins';

/**
 * The VIN the current wiring view is filtered against (set by showWiring's
 * vin arg). View-scoped; cleared when a chassis opens without a VIN.
 * @type {WiringVinHit | null}
 */
let wiringVinHit = null;

/**
 * Whether the user has the "matches my vehicle" filter on. View-scoped.
 * @type {boolean}
 */
let wiringVinFilterOn = false;

/**
 * Tag a diagram against the current VIN using BMW's own applicability data
 * (SP-doc -> chassis/engine, decoded from ISTA). Keyed by the SP DOC ID
 * (leaf.doc), never the diagram name.
 * @param {string} doc - SP doc id
 * @returns {WiringVinMatch}
 */
function wiringDiagramMatch(doc) {
  if (!wiringVinHit || typeof wiringApplicability === 'undefined')
    return 'neutral';
  return wiringApplicability.match(doc, wiringVinHit);
}

/**
 * Should this folder stay visible under the "my car" filter? Keep it when its
 * subtree holds ANY diagram that isn't 'off' for the VIN (a match, or generic
 * neutral content), and hide it only when EVERY diagram in the subtree is
 * 'off' -- i.e. nothing in it applies to the car. This never hides a
 * container that holds real matches, and collapses only the folders that are
 * entirely wrong. (Off diagrams inside a kept folder are still hidden
 * individually.)
 * @param {WiringTreeNode} node - folder to test
 * @returns {boolean}
 */
function wiringSubtreeHasMatch(node) {
  let sawDoc = false;
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    for (const c of n.children || []) {
      if (c.doc) {
        sawDoc = true;
        if (wiringDiagramMatch(c.doc) !== 'off') return true;
      } else if (c.children) stack.push(c);
    }
  }
  return !sawDoc; // no diagrams at all -> keep (generic container)
}

/**
 * VIN match for an ISTA doc, from its embedded applicability {e, b}.
 * @param {DocsEntry} d - the document
 * @returns {WiringVinMatch}
 */
function docsVinMatch(d) {
  if (!wiringVinHit || !d.a) return 'neutral';
  return wiringApplicability.matchRule(d.a, wiringVinHit);
}

/**
 * The docs-tree counterpart of wiringSubtreeHasMatch: keep a folder while any
 * document under it is not 'off' for the VIN.
 * @param {DocsTreeNode} node - folder to test
 * @returns {boolean}
 */
function docsSubtreeHasMatch(node) {
  if (!wiringVinHit) return true;
  for (const d of node.docs || []) if (docsVinMatch(d) !== 'off') return true;
  for (const c of node.children || []) if (docsSubtreeHasMatch(c)) return true;
  return false;
}

/**
 * The wiring VIN decoder: the SAME screen the Parts catalogue uses (VIN box +
 * identify-by-attributes), retargeted to open wiring and remember the VIN.
 * @returns {void}
 */
function showWiringVinDecoder() {
  if (typeof showVinDecoder !== 'function') {
    showWiringChassis();
    return;
  }
  showVinDecoder({
    eyebrow: 'WDS',
    title: 'Vehicle Identification',
    subtitle:
      'Enter your VIN, or identify your vehicle by series, body and model, to open its wiring.',
    crumbs: [
      { label: 'Vehicles', fn: showChassis },
      { label: 'Apps', fn: showApps },
      { label: 'Wiring', fn: showWiringChassis },
      { label: 'VIN' },
    ],
    back: showWiringChassis,
    savedKey: WIRING_VINS_KEY, // wiring keeps its own saved-vehicles list
    resolvable: (chassis) => wiringHasChassis(chassis),
    openLabel: (disp) => `Open ${disp} diagrams →`,
    unavailable: (disp) => `⚠ No wiring diagrams shipped for ${disp} yet.`,
    // carry the decoded VIN into the diagram view so it can filter by build
    // engine / body, from ISTA's applicability data
    onResolve: (hit) => showWiring(hit.chassis, null, hit),
  });
}

/**
 * The "Identify by VIN" entry card shown atop the wiring chassis picker. It
 * opens the full decoder submenu, where the VIN input, Save button and the
 * saved-vehicles panel live.
 * @returns {HTMLButtonElement}
 */
function buildWiringVinBox() {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'wiring-vin-entry';
  card.innerHTML = `
    <span class="wiring-vin-entry-body">
      <span class="wiring-vin-entry-title">Identify by VIN</span>
      <span class="wiring-vin-entry-desc">Enter a VIN, or pick year / make / model, to open its wiring</span>
    </span>
    <span class="wiring-vin-entry-arrow">→</span>`;
  card.onclick = () => showWiringVinDecoder();
  return card;
}

/**
 * One-line description of the decoded car for the banner: model, body,
 * engine and build month, whichever are known.
 * @param {WiringVinHit} hit - the decoded VIN
 * @returns {string}
 */
function wiringVinDescription(hit) {
  return [
    hit.model,
    typeof bodyLabel === 'function' && hit.body ? bodyLabel(hit.body) : '',
    hit.motor,
    hit.prod
      ? `${String(hit.prod).slice(0, 4)}-${String(hit.prod).slice(4, 6)}`
      : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * VIN mode: a "your car" header at the top of the tree with a Show all / My
 * car toggle. Opening via a VIN defaults to MY CAR (filtered) -- that is the
 * whole point -- and the toggle flips to the full tree. The returned element
 * carries `_applyFilter(on)`; the caller invokes it once the tree exists
 * (folders must be present for the CSS filter to have anything to hide).
 * @param {WiringVinHit} hit - the decoded VIN
 * @param {HTMLElement | null} body - the .wiring-body whose class carries the filter
 * @param {() => void} refreshCount - re-count the documents the filter shows
 * @returns {HTMLDivElement & {_applyFilter: (on: boolean) => void}}
 */
function buildWiringVinBanner(hit, body, refreshCount) {
  const banner = document.createElement('div');
  banner.className = 'wiring-vinbanner';
  banner.innerHTML = `
        <div class="wiring-vinbanner-veh">
          <span class="wiring-vinbanner-desc">${esc(wiringVinDescription(hit))}</span>
          <span class="wiring-vinbanner-vin">${esc(hit.vin || '')}</span>
        </div>
        <div class="wiring-vinseg" role="group" aria-label="Diagram filter">
          <button type="button" class="wiring-vinseg-btn" data-mode="mine">My car</button>
          <button type="button" class="wiring-vinseg-btn" data-mode="all">Show all</button>
        </div>`;
  const seg = banner.querySelector('.wiring-vinseg');
  const applyFilter = (on) => {
    wiringVinFilterOn = on;
    body?.classList.toggle('vin-filtered', on); // CSS hides off leaves + empty folders
    seg
      .querySelectorAll('.wiring-vinseg-btn')
      .forEach((b) =>
        b.classList.toggle('active', b.dataset.mode === (on ? 'mine' : 'all'))
      );
    refreshCount();
  };
  seg
    .querySelectorAll('.wiring-vinseg-btn')
    .forEach((b) => (b.onclick = () => applyFilter(b.dataset.mode === 'mine')));
  // default ON when opened via a VIN
  wiringVinFilterOn = true;
  banner._applyFilter = applyFilter;
  return banner;
}
