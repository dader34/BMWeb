// Control unit tree: the app. ISTA's Vehicle information tab drawn from its
// own topology data (screens/tree/data.js), the boxes coloured by the last
// fault scan the Garage holds for the car, a click opening the module's
// script. Pick a chassis; a saved car of that chassis supplies the status.

/** the read running on the tree screen, so leaving it ends the read */
let ecuTreeActiveScan = null;
/** bumps per showEcuTreeChassis: an older render that resumes after an await stops */
let ecuTreeGen = 0;

/**
 * End a running tree scan, if any (leaving the screen, starting another).
 * @returns {void}
 */
function ecuTreeStopScan() {
  if (ecuTreeActiveScan) {
    ecuTreeActiveScan.cancel();
    ecuTreeActiveScan = null;
  }
}

/**
 * The Control unit tree app: pick a chassis.
 * @returns {Promise<void>}
 */
async function showEcuTree() {
  ecuTreeStopScan();
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
 * How many addresses the last fault scan of a saved car reached, for the
 * progress bar's estimate. The tree never colours itself from a stored
 * scan: what is on screen is only ever what this screen read.
 * @param {string|null} carId - the car
 * @returns {number} 0 when there is no stored scan
 */
function ecuTreeLastScanSize(carId) {
  if (!carId || typeof garageScans !== 'function') return 0;
  const scan = garageScans(carId).find((s) => s.kind === 'faults');
  if (!scan || !scan.report) return 0;
  return (scan.report.modules || []).length + (scan.report.silent || []).length;
}

/**
 * The tree for one chassis, coloured by one of its saved cars.
 * @param {string} chassis - the chassis id
 * @param {string|null} [carId] - a Garage car of that chassis the finished read is kept under
 * @param {{scan?: boolean}} [opts] - scan: start the whole-car read on arrival
 * @returns {Promise<void>}
 */
async function showEcuTreeChassis(chassis, carId, opts) {
  ecuTreeStopScan();
  const gen = ++ecuTreeGen;
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
    `<label class="tree-bar-item"><span class="tree-bar-lbl">Keep under</span><span class="tree-car-slot"></span></label>` +
    `<span class="tree-bar-note"></span>` +
    `<span class="tree-bar-spacer"></span>` +
    `<button type="button" class="btn tree-scan" hidden>Fault scan</button>` +
    `<button type="button" class="btn tree-stop" hidden>Stop</button>` +
    `</div>` +
    `<div class="tree-progress" hidden><i></i></div>` +
    `<div class="tree-canvas"><div class="empty"><span class="loader"></span></div></div>` +
    `<div class="tree-legend-slot"></div>`;
  view.appendChild(wrap);
  const carSlot = wrap.querySelector('.tree-car-slot');
  const note = wrap.querySelector('.tree-bar-note');
  const canvas = wrap.querySelector('.tree-canvas');
  const legendSlot = wrap.querySelector('.tree-legend-slot');
  const scanBtn = wrap.querySelector('.tree-scan');
  const stopBtn = wrap.querySelector('.tree-stop');
  const progress = wrap.querySelector('.tree-progress');

  const [tree, config] = await Promise.all([
    ecuTreeForChassis(car),
    tryApi(
      `/api/chassis/${car}`,
      null,
      canvas,
      `failed to load ${dispChassis(car)}`
    ),
  ]);
  if (gen !== ecuTreeGen) return; // another render took the screen meanwhile
  if (!tree) {
    canvas.innerHTML = `<div class="empty">ISTA has no control unit tree for ${esc(dispChassis(car))}.</div>`;
    sbLeft.textContent = 'no tree';
    return;
  }
  const layout = ecuTreeLayout(tree);
  legendSlot.innerHTML = ecuTreeLegendHtml(layout);

  // where the finished read is filed: a saved car of this chassis, or
  // nowhere; the app's own dropdown, like every other picker
  const carOptions = [
    { val: '', label: 'Nowhere (not kept)' },
    ...cars.map((c) => ({
      val: c.id,
      label:
        typeof garageCarLabel === 'function'
          ? garageCarLabel(c)
          : c.label || c.id,
    })),
  ];
  const onPickCar = (v) => {
    picked = cars.find((c) => c.id === v) || null;
    lastScreen = () => showEcuTreeChassis(car, picked ? picked.id : null);
    if (typeof history !== 'undefined' && history.replaceState)
      history.replaceState(
        null,
        '',
        `#apps/tree/${car}${picked ? `/${encodeURIComponent(picked.id)}` : ''}`
      );
    paint();
  };
  if (typeof lookupDropdown === 'function') {
    carSlot.appendChild(
      lookupDropdown(
        'Nowhere (not kept)',
        carOptions,
        picked ? picked.id : '',
        onPickCar
      ).el
    );
  }
  if (!cars.length) carSlot.classList.add('tree-busy');

  /** @type {Map<string, EcuTreeStatus>} */
  let status = new Map();
  /** the read in progress, when one is: its reads so far, and its line */
  let live = null;
  /** the read this screen finished, if one did: the only history it shows */
  let done = null;
  const paint = () => {
    const report = live ? live.report : done ? done.report : null;
    status = ecuTreeStatus(tree, report);
    canvas.innerHTML = `<div class="tree-scroll">${ecuTreeSvg(layout, status)}</div>`;
    const n = { ok: 0, faults: 0, silent: 0, unread: 0 };
    for (const s of status.values()) n[s.state]++;
    const counts = `${n.ok + n.faults} answered, ${n.faults} with faults, ${n.silent} not responding`;
    note.textContent = live
      ? `reading${live.text ? `: ${live.text}` : '\u2026'}  ${counts}`
      : done
        ? `${done.stopped ? 'stopped' : 'read'} ${done.at.toLocaleTimeString()}: ${counts}${done.kept ? `, kept under ${done.kept}` : done.unkept ? ', not kept (no Garage car picked)' : ''}`
        : 'press Fault scan to read the car';
    wrap.classList.toggle('tree-live', !!live);
    // how far the read is: reads so far over what the last scan of this car
    // reached, else over the addresses the tree lists
    progress.hidden = !live;
    if (live) {
      const expected =
        ecuTreeLastScanSize(picked ? picked.id : null) ||
        new Set(layout.boxes.flatMap((b) => b.ecu.groups)).size;
      const sofar = n.ok + n.faults + n.silent;
      const pct = expected
        ? Math.min(100, Math.round((100 * sofar) / expected))
        : 0;
      progress.firstElementChild.style.width = `${pct}%`;
      progress.title = `${sofar} of about ${expected} addresses`;
    }
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
  paint();

  // ISTA's "Start vehicle test": INPA's whole-car fault read, run right
  // here. The boxes colour in as modules answer; the finished read is kept
  // against the picked car like one run from the Garage.
  const shipped =
    typeof vehicleScriptShipped === 'function' &&
    (await vehicleScriptShipped(car).catch(() => false));
  if (gen !== ecuTreeGen) return;
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
  const run = () => {
    if (ecuTreeActiveScan || typeof ecuTreeScanStart !== 'function') return;
    live = { report: null, text: '' };
    scanBtn.hidden = true;
    stopBtn.hidden = false;
    carSlot.classList.add('tree-busy');
    paint();
    const handle = ecuTreeScanStart(car, {
      onProgress: (report, text) => {
        if (!live || ecuTreeActiveScan !== handle) return;
        if (report) live.report = report;
        if (text) live.text = text;
        paint();
      },
      onMessage: (title, body) => {
        if (!live || ecuTreeActiveScan !== handle) return;
        live.text = `${title}${body ? `: ${body}` : ''}`;
        paint();
      },
    });
    ecuTreeActiveScan = handle;
    const finish = () => {
      if (ecuTreeActiveScan === handle) ecuTreeActiveScan = null;
      live = null;
      scanBtn.hidden = false;
      stopBtn.hidden = true;
      carSlot.classList.toggle('tree-busy', !cars.length);
    };
    handle.done.then(
      ({ report, lines, cancelled }) => {
        finish();
        const got = report && (report.modules || []).length;
        done = {
          report,
          at: new Date(),
          stopped: !!cancelled,
          kept: '',
          unkept: false,
        };
        if (picked && got && typeof garageAddScan === 'function') {
          garageAddScan(picked.id, { report, lines }, { chassis: car });
          done.kept =
            typeof garageCarLabel === 'function'
              ? garageCarLabel(picked)
              : picked.label || picked.id;
        } else if (got && !picked) done.unkept = true;
        paint();
      },
      (e) => {
        finish();
        paint();
        note.textContent = String((e && e.message) || e);
      }
    );
  };
  if (shipped) {
    scanBtn.hidden = false;
    scanBtn.onclick = run;
    stopBtn.onclick = () => ecuTreeStopScan();
    acts.push({ key: '1', label: 'Fault scan', fn: run });
  }
  setActions(acts);
  // ISTA's "Start vehicle test" lands here with the read already running
  if (opts && opts.scan && shipped) run();
}
