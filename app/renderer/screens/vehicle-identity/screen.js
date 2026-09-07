/**
 * @file Vehicle identity: the screen. Identify the car if no chassis was
 * given, read every master into its own column, and draw the three boxes.
 *
 * Last piece of screens/vehicle-identity/; publishes the entry points the
 * nav and the coding hub call on the window.
 *
 * LAYOUT. The reading is the headline: one summary card saying what the car
 * IS, with the equipment underneath as labelled chips. The ECUs that produced
 * it are a footnote strip, not the main event -- which control unit answered
 * matters when a read fails and almost never otherwise.
 */

/**
 * Options for showVehicleIdentity.
 * @typedef {object} ViScreenOpts
 * @property {ViDetectedCar} [detected] - How the car was identified, when
 *   the screen was entered without a chassis.
 */

/**
 * A pass token: a re-read while one is running must not paint over the
 * newer one when its slower jobs come back. Each entry bumps the counter and
 * the older pass goes stale.
 * @typedef {object} ViPass
 * @property {() => boolean} stale - True once a newer pass has started.
 * @property {(text: string) => void} wait - Paint a progress line, unless
 *   stale.
 */

/**
 * Claim a new pass over the panel.
 * @param {HTMLElement} panel - The pane the progress line is painted into.
 * @returns {ViPass} The pass.
 */
function viNewPass(panel) {
  const pass = (showVehicleIdentity._pass =
    (showVehicleIdentity._pass || 0) + 1);
  const stale = () => showVehicleIdentity._pass !== pass;
  const wait = (text) => {
    if (stale()) return;
    panel.innerHTML = viLoading(text);
    sbLeft.textContent = text;
  };
  return { stale, wait };
}

/**
 * Create the screen's panel under a fresh head.
 * @param {string} title - The head's title.
 * @param {string} subtitle - The head's subtitle.
 * @returns {HTMLElement} The panel.
 */
function viPanel(title, subtitle) {
  view.innerHTML = head('Identity', title, subtitle);
  const panel = document.createElement('div');
  panel.className = 'vi-panel';
  view.appendChild(panel);
  return panel;
}

/**
 * The chassis-free entry: identify the car, then show its identity.
 * @returns {Promise<void>} Resolves when the screen is drawn.
 */
async function identifyCar() {
  return showVehicleIdentity(null);
}

/**
 * No chassis given: ask the car, then come back with the answer.
 * @returns {Promise<void>} Resolves when the identity screen is drawn or
 *   the failure is shown.
 */
async function viShowDetecting() {
  lastScreen = () => showVehicleIdentity(null);
  setCrumbs([{ label: 'Vehicles', fn: showChassis }, { label: 'Identity' }]);
  sbLeft.textContent = 'identifying the car';
  const panel = viPanel(
    'Any car',
    'Asks the cluster which car this is, then reads its build record.'
  );
  setActions([
    {
      key: '1',
      keyLabel: 'F1',
      label: 'Retry',
      fn: () => showVehicleIdentity(null),
    },
    {
      key: 'Escape',
      keyLabel: 'Esc',
      label: 'Back',
      kind: 'back',
      fn: showChassis,
    },
  ]);
  const { stale, wait } = viNewPass(panel);
  if (typeof loadTables === 'function') await loadTables();
  let found;
  try {
    found = await viDetectCar(wait);
  } catch (e) {
    if (stale()) return;
    panel.innerHTML = errorBlock(
      `Could not identify the car: ${esc(e && e.message ? e.message : e)}`
    );
    sbLeft.textContent = 'car not identified';
    return;
  }
  if (stale()) return;
  return showVehicleIdentity(found.chassis, { detected: found });
}

/**
 * The source-strip entry for how the car was identified.
 * @param {ViDetectedCar} detected - The detection.
 * @param {string} id - Upper-case chassis id.
 * @returns {ViSource} The entry.
 */
function viDetectedSource(detected, id) {
  return {
    sg: detected.sgbd.toUpperCase(),
    ok: true,
    what:
      detected.via === 'gm'
        ? `identified ${dispChassis(id)} from its GM key ` +
          `(type ${detected.type}${
            detected.keywords && detected.keywords.length
              ? ': ' + detected.keywords.join(' ')
              : ''
          })`
        : `identified ${dispChassis(id)} by which chassis list ${detected.sgbd}`,
  };
}

/**
 * Decode every column: catalogue lookup, what it says, its codes.
 *
 * A module that stores only the 7-char production number (kombi46) cannot
 * say its type key; a sibling holding the full 17-char VIN of THE SAME car
 * (same production number) can say it for both. The rows are still one
 * column per module: nothing else crosses over.
 * @param {string} id - Upper-case chassis id.
 * @param {ViColumn[]} cols - The columns that answered.
 * @param {(m: ViIdentityModule) => string|null} famName - Family lookup.
 * @returns {Promise<void>} Resolves once every column is decoded.
 */
async function viDecodeColumns(id, cols, famName) {
  const fullVinFor = (short) => {
    const s = String(short || '');
    if (s.length >= VI_VIN_LEN) return s;
    const hit = cols.find(
      (o) =>
        o.vin && String(o.vin).length >= VI_VIN_LEN && String(o.vin).endsWith(s)
    );
    return hit ? hit.vin : s;
  };
  for (const col of cols) {
    col.title = famName(col.m) || col.m.label || col.m.sgbd;
    col.etk = await viEtkDecode(col.vin);
    col.info = viColInfo(id, col, col.etk);
    if (!col.info.typeKey && col.vin) {
      col.info.typeKey = viTypeKey(fullVinFor(col.vin));
    }
    col.codes = col.fa
      ? VehicleIdentity.saCodesFromFa(col.fa)
      : (col.info.sa && col.info.sa.codes) || [];
  }
}

/**
 * The three boxes and the raw orders, as HTML.
 * @param {string} id - Upper-case chassis id.
 * @param {ViColumn[]} cols - Decoded columns.
 * @param {ViSource[]} sources - The source strip.
 * @returns {string} The panel HTML.
 */
function viIdentityHtml(id, cols, sources) {
  const kmText = (v) =>
    v == null ? null : /^\d+(\.\d+)?$/.test(String(v)) ? `${v} km` : String(v);
  /** @type {ViTableRow[]} */
  const infoRows = [
    ['Chassis', (c) => c.info.chassis],
    ['Model', (c) => c.info.model],
    ['Body', (c) => c.info.body],
    ['Engine', (c) => c.info.engine],
    ['Gearbox', (c) => c.info.gearbox],
    ['VIN', (c) => c.vin],
    // the copies update at different moments; a small skew is normal (soft)
    ['Odometer', (c) => kmText(c.km), true],
  ];
  /** @type {ViTableRow[]} */
  const zcsRows = [
    ['Type-Key', (c) => c.info.typeKey],
    ['ZCS GM', (c) => (c.keys ? viZcsFmt('Gm', c.keys.gm) : null)],
    ['ZCS SA', (c) => (c.keys ? viZcsFmt('Sa', c.keys.sa) : null)],
    ['ZCS VN', (c) => (c.keys ? viZcsFmt('Vn', c.keys.vn) : null)],
    // the FA generation's record, in the same box (NCS titles it ZCS/FA)
    [
      'Order date',
      (c) => (c.fa && c.fa.date ? String(c.fa.date).replace(/^#/, '') : null),
    ],
    ['Paint', (c) => c.fa && c.fa.lack],
    ['Upholstery', (c) => c.fa && c.fa.polster],
  ];
  return (
    `<div class="vi-block"><h3>Information about car</h3>` +
    `<div class="vi-ncs-wrap">${viNcsTable(cols, infoRows)}</div></div>` +
    `<div class="vi-block"><h3>ZCS/FA coding</h3>` +
    `<div class="vi-ncs-wrap">${viNcsTable(cols, zcsRows)}</div></div>` +
    viOptionsBox(id, cols) +
    cols
      .filter((c) => c.faRaw)
      .map(
        (c) =>
          `<details class="vi-raw"><summary>Raw order · ${esc(c.title)}` +
          `</summary><code class="mono">${esc(c.faRaw)}</code></details>`
      )
      .join('') +
    viSources(sources)
  );
}

/**
 * The identity screen for a chassis; with no chassis, identify the car
 * first.
 * @param {string|null|undefined} chassisId - Chassis id, or null to ask the
 *   car.
 * @param {ViScreenOpts} [opts] - Screen options.
 * @returns {Promise<void>} Resolves when the screen is drawn.
 */
async function showVehicleIdentity(chassisId, opts) {
  if (!chassisId) return viShowDetecting();
  const id = String(chassisId || '').toUpperCase();
  const detected = (opts && opts.detected) || null;
  lastScreen = () => showVehicleIdentity(chassisId, opts);
  const back = () =>
    typeof showSections === 'function'
      ? showSections(chassisId)
      : showChassis();
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: dispChassis(chassisId), fn: back },
    { label: 'Identity' },
  ]);
  sbLeft.textContent = `${dispChassis(chassisId)} · identity`;
  const panel = viPanel(
    dispChassis(chassisId),
    'What the car reports about its own build, and the equipment that follows ' +
      'from it.'
  );
  setActions([
    {
      key: '1',
      keyLabel: 'F1',
      label: 'Re-read',
      fn: () => showVehicleIdentity(chassisId, opts),
    },
    { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: back },
  ]);
  const { stale, wait } = viNewPass(panel);

  wait('Looking up which modules hold the build record…');
  if (typeof loadTables === 'function') await loadTables();
  if (typeof loadSaNames === 'function') await loadSaNames();

  // Who can answer, asked of the modules themselves.
  const masters = await viIdentityModulesCached(id);
  if (stale()) return;
  if (!masters.length) {
    panel.innerHTML = errorBlock(
      `No control unit on ${esc(dispChassis(chassisId))} declares a job that ` +
        `returns the build record. Without one there is nothing to read.`
    );
    sbLeft.textContent = 'no identity source';
    return;
  }

  // SGFAM's family name, for the column titles and the source strip.
  const fam =
    typeof VehicleIdentity !== 'undefined'
      ? VehicleIdentity.familyMap(id)
      : null;
  const famName = (m) => viFamilyName(fam, m);

  // EVERY master is read, and each keeps its own column -- the copies are the
  // point. A master that answers nothing at all drops out of the table but
  // stays on the source strip, so a dead module is a finding, not a blank.
  const sources = [];
  if (detected) sources.push(viDetectedSource(detected, id));
  const cols = [];
  for (let i = 0; i < masters.length; i++) {
    const m = masters[i];
    wait(
      `Reading ${famName(m) || m.label || m.sgbd} ` +
        `(${i + 1} of ${masters.length})…`
    );
    const col = await viReadColumn(m, sources, famName);
    if (stale()) return;
    if (col.keys || col.fa || col.vin || col.km) cols.push(col);
  }

  if (!cols.length) {
    panel.innerHTML =
      errorBlock(
        'No control unit answered with a build record. Check the cable and the ' +
          'ignition (engine off, key on), then re-read.'
      ) + viSources(sources);
    sbLeft.textContent = 'no identity';
    return;
  }

  wait('Decoding the build record…');
  await viDecodeColumns(id, cols, famName);
  if (stale()) return;
  panel.innerHTML = viIdentityHtml(id, cols, sources);

  const nCodes = Math.max(...cols.map((c) => (c.codes || []).length), 0);
  sbLeft.textContent = nCodes
    ? `${cols.length} module${cols.length === 1 ? '' : 's'} · ${nCodes} option codes`
    : 'identity read';
}

if (typeof window !== 'undefined') {
  window.showVehicleIdentity = showVehicleIdentity;
  window.identifyCar = identifyCar;
  window.chassisHasIdentity = chassisHasIdentity;
  window.readIdentityCodes = readIdentityCodes;
}
