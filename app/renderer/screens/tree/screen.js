// Control unit tree: the app. ISTA's Vehicle information tab drawn from its
// own topology data (screens/tree/data.js), the boxes coloured by the last
// fault scan the Garage holds for the car, a click opening the module's
// script. Pick a chassis; a saved car of that chassis supplies the status.

/**
 * The Control unit tree app: pick a chassis.
 * @returns {Promise<void>}
 */
async function showEcuTree() {
  lastScreen = showEcuTree;
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: 'Apps', fn: showApps },
    { label: 'Control unit tree' },
  ]);
  sbLeft.textContent = 'select chassis';
  sbRight.textContent = '';
  view.innerHTML = head(
    'Control unit tree',
    'Control unit tree',
    "ISTA's bus map of every module a chassis can carry, coloured by the last fault scan."
  );
  setActions([
    {
      key: 'Escape',
      keyLabel: 'Esc',
      label: 'Back',
      kind: 'back',
      fn: showApps,
    },
    { key: 'p', label: 'Print', kind: 'print', fn: () => window.print() },
  ]);
  const list = document.createElement('div');
  list.className = 'chassis-grid stagger';
  view.appendChild(list);
  const [ids, idx] = await Promise.all([
    tryApi('/api/chassis', null, view, 'failed to load vehicles'),
    ecuTreeIndex(),
  ]);
  if (!ids) return;
  const have = (idx && idx.chassis) || {};
  ids.forEach((id) => {
    const card = document.createElement('button');
    card.className = 'chassis-card';
    const tag = (typeof CHASSIS_TAG === 'object' && CHASSIS_TAG[id]) || 'BMW';
    const tree = have[String(id).toUpperCase()];
    card.innerHTML =
      `<div class="chassis-code">${esc(dispChassis(id))}</div>` +
      `<div class="chassis-tag">${esc(tree ? tag : 'no ISTA tree')}</div>` +
      `<div class="chassis-arrow">→</div>`;
    if (!tree) card.disabled = true;
    card.onclick = () => showEcuTreeChassis(id);
    list.appendChild(card);
  });
  stagger(list);
  sbRight.textContent = `${Object.keys(have).length} chassis with a tree`;
}

/**
 * The newest fault scan a saved car holds, for the box colours.
 * @param {string|null} carId - the car
 * @returns {object|null} the scan
 */
function ecuTreeScanFor(carId) {
  if (!carId || typeof garageScans !== 'function') return null;
  return garageScans(carId).find((s) => s.kind === 'faults') || null;
}

/**
 * The tree for one chassis, coloured by one of its saved cars.
 * @param {string} chassis - the chassis id
 * @param {string|null} [carId] - a Garage car of that chassis whose last scan colours the boxes
 * @returns {Promise<void>}
 */
async function showEcuTreeChassis(chassis, carId) {
  const car = String(chassis).toUpperCase();
  const cars =
    typeof garageCars === 'function'
      ? garageCars().filter((c) => String(c.chassis).toUpperCase() === car)
      : [];
  let picked = (carId && cars.find((c) => c.id === carId)) || cars[0] || null;
  lastScreen = () => showEcuTreeChassis(car, picked ? picked.id : null);
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: 'Apps', fn: showApps },
    { label: 'Control unit tree', fn: showEcuTree },
    { label: dispChassis(car) },
  ]);
  if (typeof history !== 'undefined' && history.replaceState)
    history.replaceState(
      null,
      '',
      `#apps/tree/${car}${picked ? `/${encodeURIComponent(picked.id)}` : ''}`
    );
  sbLeft.textContent = 'loading tree';
  view.innerHTML = head(
    dispChassis(car),
    'Control unit tree',
    'Every module the chassis can carry, on its bus. Click a box to open the module.'
  );
  const wrap = document.createElement('div');
  wrap.className = 'tree-wrap';
  wrap.innerHTML =
    `<div class="tree-bar">` +
    `<label class="tree-bar-item">Status from <select class="tree-car modal-input"></select></label>` +
    `<span class="tree-bar-note"></span>` +
    `<span class="tree-bar-spacer"></span>` +
    `<button type="button" class="btn tree-scan" hidden>Fault scan</button>` +
    `</div>` +
    `<div class="tree-canvas"><div class="empty"><span class="loader"></span></div></div>` +
    `<div class="tree-legend-slot"></div>`;
  view.appendChild(wrap);
  const sel = wrap.querySelector('.tree-car');
  const note = wrap.querySelector('.tree-bar-note');
  const canvas = wrap.querySelector('.tree-canvas');
  const legendSlot = wrap.querySelector('.tree-legend-slot');
  const scanBtn = wrap.querySelector('.tree-scan');

  const [tree, config] = await Promise.all([
    ecuTreeForChassis(car),
    tryApi(
      `/api/chassis/${car}`,
      null,
      canvas,
      `failed to load ${dispChassis(car)}`
    ),
  ]);
  if (!tree) {
    canvas.innerHTML = `<div class="empty">ISTA has no control unit tree for ${esc(dispChassis(car))}.</div>`;
    sbLeft.textContent = 'no tree';
    return;
  }
  const layout = ecuTreeLayout(tree);
  legendSlot.innerHTML = ecuTreeLegendHtml(layout);

  // the car whose scan colours the boxes: any saved car of this chassis
  sel.innerHTML =
    `<option value="">none (topology only)</option>` +
    cars
      .map(
        (c) =>
          `<option value="${esc(c.id)}"${picked && c.id === picked.id ? ' selected' : ''}>${esc(
            typeof garageCarLabel === 'function'
              ? garageCarLabel(c)
              : c.label || c.id
          )}</option>`
      )
      .join('');
  if (!cars.length) sel.disabled = true;

  /** @type {Map<string, EcuTreeStatus>} */
  let status = new Map();
  const paint = () => {
    const scan = ecuTreeScanFor(picked ? picked.id : null);
    status = ecuTreeStatus(tree, scan ? scan.report : null);
    canvas.innerHTML = `<div class="tree-scroll">${ecuTreeSvg(layout, status)}</div>`;
    const n = { ok: 0, faults: 0, silent: 0, unread: 0 };
    for (const s of status.values()) n[s.state]++;
    note.textContent = scan
      ? `scan of ${new Date(scan.at).toLocaleString()}: ${n.ok + n.faults} answered, ${n.faults} with faults, ${n.silent} not responding`
      : picked
        ? 'no fault scan saved for this car yet'
        : '';
    sbLeft.textContent = `${layout.boxes.length} modules`;
    sbRight.textContent = tree.series !== car ? `ISTA tree ${tree.series}` : '';
    canvas.querySelectorAll('.tree-box').forEach((g) => {
      const open = () => {
        const key = g.getAttribute('data-key');
        const box = layout.boxes.find((b) => ecuTreeKey(b.ecu) === key);
        if (!box) return;
        const st = status.get(key);
        const hit = ecuTreeModuleRow(box.ecu, config, st && st.module);
        if (!hit) {
          sbLeft.textContent = `${box.ecu.name}: not in ${dispChassis(car)}'s module list`;
          return;
        }
        if (typeof showEcu === 'function') showEcu(car, hit.section, hit.row);
      };
      g.addEventListener('click', open);
      g.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
    });
  };
  sel.onchange = () => {
    picked = cars.find((c) => c.id === sel.value) || null;
    lastScreen = () => showEcuTreeChassis(car, picked ? picked.id : null);
    if (typeof history !== 'undefined' && history.replaceState)
      history.replaceState(
        null,
        '',
        `#apps/tree/${car}${picked ? `/${encodeURIComponent(picked.id)}` : ''}`
      );
    paint();
  };
  paint();

  // ISTA's "Start vehicle test": the whole-car fault read, filed against
  // the picked car when there is one
  const shipped =
    typeof vehicleScriptShipped === 'function' &&
    (await vehicleScriptShipped(car).catch(() => false));
  const acts = [
    {
      key: 'Escape',
      keyLabel: 'Esc',
      label: 'Back',
      kind: 'back',
      fn: showEcuTree,
    },
    { key: 'p', label: 'Print', kind: 'print', fn: () => window.print() },
  ];
  if (shipped && typeof showVehicleScript === 'function') {
    const run = () => {
      if (picked && typeof garageRunScan === 'function')
        return garageRunScan(picked, IPO_VEHICLE_FAULT_MENU, GARAGE_FAULT_KEY);
      return showVehicleScript(
        car,
        IPO_VEHICLE_FAULT_MENU,
        null,
        GARAGE_FAULT_KEY
      );
    };
    scanBtn.hidden = false;
    scanBtn.onclick = run;
    acts.push({ key: '1', label: 'Fault scan', fn: run });
  }
  setActions(acts);
}
