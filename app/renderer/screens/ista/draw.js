/**
 * @file ISTA shell: drawing its pages, the operations, and the entry point showIsta.
 */

/* exported istaRedraw, istaPaintStates, showIsta */

/**
 * Draw one of the shell's own pages, in the face the setting asks for.
 * @param {IstaSub|IstaSub3} s - the leaf
 * @param {HTMLElement} host - where to draw
 * @returns {Promise<void>}
 */
async function istaDrawPage(s, host) {
  const real = istaSkinOn();
  const car = istaState.car;
  const chassis = istaChassis();

  if (s.page === 'vin') {
    if (!real) return istaPageVinModern(host);
    let valid = false;
    const bar = (ok) => {
      valid = ok;
      istaBottomBar('vin', {
        'open-operation': ok
          ? () => {
              const p = host._istaPick ? host._istaPick() : null;
              if (p) istaOpenOperation(p.car, p.vin);
            }
          : null,
      });
    };
    istaRealStatus({ items: [] });
    istaPageVin(host, {
      open: (c, vin) => istaOpenOperation(c, vin),
      onValid: bar,
    });
    bar(valid);
    return;
  }

  // ---- Operations / Finished ------------------------------------------------
  if (s.page === 'finished') {
    let picked = null;
    const bar = () =>
      istaBottomBar('finished', {
        'open-operation': picked ? () => istaOpenStoredScan(picked) : null,
      });
    const scans = istaPageFinished(host, {
      car,
      onPick: (sc) => {
        picked = sc;
        bar();
      },
    });
    istaRealStatus({
      items: [{ k: 'Operations:', v: `${scans.length} / ${scans.length}` }],
    });
    bar();
    return;
  }

  // ---- Vehicle information / Repair history ---------------------------------
  if (s.page === 'history') {
    let picked = null;
    const bar = () =>
      istaBottomBar('history', {
        display: picked ? () => istaOpenStoredScan(picked) : null,
      });
    const scans = istaPageHistory(host, {
      car,
      onPick: (sc) => {
        picked = sc;
        bar();
      },
    });
    istaRealStatus({
      items: [{ k: 'Entries:', v: `${scans.length} / ${scans.length}` }],
    });
    bar();
    return;
  }

  // ---- Troubleshooting / Fault memory ---------------------------------------
  if (s.page === 'fault-memory') {
    let picked = null;
    // the rows name faults through the English fault texts, which load
    // lazily: the report views wait for them, and so must this table, or
    // it draws the raw German F_ORT_TEXT until something else loads them
    if (typeof loadFaultDb === 'function') {
      try {
        await loadFaultDb();
      } catch (e) {
        /* the texts are optional: the raw name still shows */
      }
    }
    const draw = () => {
      const rows = istaPageFaultMemory(host, {
        car,
        filter: istaState.faultFilter || '',
        onPick: (r) => {
          picked = r;
          bar(rows);
        },
      });
      istaRealStatus({
        items: [
          {
            k: 'Number of fault memories:',
            v: `${rows.length} / ${rows.length}`,
          },
          { k: 'No. fault patterns:', v: '0' },
          { k: 'Filter:', v: istaState.faultFilter ? 'Module' : 'Default' },
        ],
      });
      bar(rows);
      return rows;
    };
    const bar = (rows) =>
      istaBottomBar('fault-memory', {
        'show-code': picked ? () => istaFaultDialog(picked) : null,
        // the clear is the app's own per-module one, behind its own confirm:
        // ISTA deletes the memory of the module the picked fault came from
        'delete-faults': picked ? () => istaClearPicked(picked, draw) : null,
        'filter-faults':
          picked && rows.length
            ? () => {
                istaState.faultFilter = picked.sgbd;
                draw();
              }
            : null,
        'delete-filter': istaState.faultFilter
          ? () => {
              istaState.faultFilter = '';
              draw();
            }
          : null,
        'show-all': istaState.faultFilter
          ? () => {
              istaState.faultFilter = '';
              draw();
            }
          : null,
        // CALCULATE TEST PLAN, on the fault the technician picked. The tool
        // resolves the procedures BMW links to that fault, puts them in the
        // plan, and lands on the plan so the next press is Display.
        //
        // IT REPLACES THE PLAN, it does not add to it. The button calculates
        // the plan for ONE picked fault, and the tool's frames show the Test
        // plan counting up from 0/0 as that calculation's rows arrive. When
        // this appended instead, rows from every fault ever calculated piled
        // up behind the one asked for -- a single code landed on 59 rows.
        'calc-plan': picked
          ? async () => {
              const rows = await istaCalcPlan(picked, car, chassis);
              if (typeof istaPlanSet === 'function') istaPlanSet(car, rows);
              if (!rows.length && typeof toast === 'function')
                toast(
                  `No procedure is linked to ${picked.code} in this build.`
                );
              return istaGo('service-plan', 'test-plan', null);
            }
          : null,
      });
    draw();
    return;
  }

  // ---- Troubleshooting / SAE fault code input -------------------------------
  if (s.page === 'sae') {
    let rows = [];
    const bar = () =>
      istaBottomBar('sae', {
        'show-code': rows.length
          ? () =>
              istaFaultDialog({
                code: rows[0][1],
                desc: rows[0][2],
                module: '',
                sgbd: '',
                raw: {},
              })
          : null,
      });
    // the car's own modules, so a code is read against the tables that can
    // actually tell its families apart
    const saeSlots = await istaLoadSlots(chassis, car);
    if (!host.isConnected) return;
    istaPageSae(host, {
      sgbds: saeSlots.map((x) => x.sgbd).filter(Boolean),
      onRows: (r) => {
        rows = r;
        istaRealStatus({
          items: [
            { k: 'No. fault patterns:', v: '0' },
            { k: 'SAE fault code number:', v: String(r.length) },
          ],
        });
        bar();
      },
    });
    istaRealStatus({
      items: [
        { k: 'No. fault patterns:', v: '0' },
        { k: 'SAE fault code number:', v: '0' },
      ],
    });
    bar();
    return;
  }

  // ---- Vehicle management / Service functions -------------------------------
  if (s.page === 'service-tree') {
    istaRealStatus({ items: [{ k: 'Hits:', v: '0 / 0' }] });
    istaBottomBar('service-functions', {});
    const cfg = await istaProbe(() => api(`/api/chassis/${chassis}`));
    const index = await istaProbe(() =>
      typeof serviceIndexLoad === 'function' ? serviceIndexLoad() : null
    );
    if (!host.isConnected) return;
    const src = istaServiceSource(cfg, index, chassis, (hit) => {
      if (typeof serviceRunHit === 'function') serviceRunHit(hit, chassis);
    });
    istaBrowse(host, src, 'service', { emptyTitle: 'Service Functions' });
    return;
  }

  // ---- Troubleshooting / the diagnosis structures ---------------------------
  if (s.page === 'diag') {
    istaRealStatus({ items: [{ k: 'Hits:', v: '0 / 0' }] });
    istaBottomBar(
      s.id === 'fault-pattern' ? 'fault-pattern' : 'service-functions',
      {}
    );
    const data = await istaProbe(() => istaDiagLoad(chassis, s.id, car));
    if (!host.isConnected) return;
    if (!data)
      return istaPageGrey(
        host,
        s.label,
        `no ${s.label.toLowerCase()} data ships for ${chassis || 'this vehicle'} ` +
          `in this build: run tools/ista/diag_structure_extract.py to add it`
      );
    const src = istaDiagSource(data, (d) => istaDiagBody(chassis, d));
    istaBrowse(host, src, `diag-${s.id}`, { emptyTitle: s.label });
    return;
  }

  // ---- Troubleshooting / Text Search ----------------------------------------
  if (s.page === 'diag-search') {
    istaRealStatus({ items: [{ k: 'Hits:', v: '0 / 0' }] });
    istaBottomBar('diag-search', {});
    const [fp, fn, cp] = await Promise.all([
      istaProbe(() => istaDiagLoad(chassis, 'fault-pattern', car)),
      istaProbe(() => istaDiagLoad(chassis, 'function-structure', car)),
      istaProbe(() => istaDiagLoad(chassis, 'component-structure', car)),
    ]);
    if (!host.isConnected) return;
    if (!fp && !fn && !cp)
      return istaPageGrey(
        host,
        s.label,
        `no diagnosis structures ship for ${chassis || 'this vehicle'} in ` +
          `this build: run tools/ista/diag_structure_extract.py to add them`
      );
    istaDiagSearch(host, {
      data: {
        'fault-pattern': fp,
        'function-structure': fn,
        'component-structure': cp,
      },
      onCount: (n) => {
        istaRealStatus({ items: [{ k: 'Hits:', v: `${n} / ${n}` }] });
        istaBottomBar('diag-search', {
          search: () => host._istaSearch && host._istaSearch.run(),
        });
      },
      onOpen: (hit) => istaOpenDiagDoc(chassis, hit.doc),
      // fetched once, on the first tick of "Search in document": searching
      // the bodies themselves would cost megabytes a keystroke
      loadBodies: () => istaDiagBodies(chassis),
    });
    istaBottomBar('diag-search', {
      search: () => host._istaSearch && host._istaSearch.run(),
    });
    return;
  }

  // ---- Service plan ---------------------------------------------------------
  if (s.page === 'plan') {
    let picked = null;
    const plan = s.id === 'test-plan';
    const draw = async () => {
      const groups = await istaPlanGroups(s.id, car);
      if (!host.isConnected) return;
      const flat = istaPageServicePlan(host, {
        groups,
        // the plan's own columns: the State glyph and the sortable Priority
        // the frames carry, which the hit list has nothing to put in
        state: plan,
        sortable: plan,
        desc: !!istaState.planDesc,
        onSort: plan
          ? () => {
              istaState.planDesc = !istaState.planDesc;
              draw();
            }
          : null,
        empty:
          s.id === 'hit-list'
            ? 'No fault has been read on this vehicle yet, so nothing points ' +
              'at a procedure.'
            : plan
              ? 'Nothing has been calculated into the test plan for this ' +
                'vehicle yet. Pick a fault on Fault memory and press ' +
                'Calculate test plan.'
              : 'Programming is not offered by this build.',
        onPick: (r) => {
          picked = r;
          bar();
        },
        onOpen: (r) => open(r),
      });
      istaRealStatus({
        items: [{ k: 'Hits:', v: `${flat.length} / ${flat.length}` }],
        legend: plan
          ? [
              { cls: 'none', label: 'not called' },
              { cls: 'ok', label: 'performed' },
              { cls: 'warn', label: 'minimized' },
              { cls: 'bad', label: 'canceled' },
              { cls: 'blue', label: 'suspected' },
            ]
          : null,
      });
      bar();
    };
    // a plan row opens the MODULE; a hit-list row has only its document
    const open = (r) =>
      plan ? istaOpenPlanRow(r, car, chassis, draw) : istaOpenPlanDoc(r);
    const bar = () =>
      istaBottomBar('hit-list', {
        back: () => showIsta('information', 'details', null),
        display: picked ? () => open(picked) : null,
      });
    await draw();
    return;
  }

  // ---- Vehicle information / Control unit tree ------------------------------
  if (s.page === 'tree') {
    // THE BUS MAP IS THE APP'S OWN DRAWING and it is the right one; what
    // does not belong inside the workshop chrome is the screen's heading,
    // its car picker and its Fault scan button, which the skin hides. It is
    // opened through istaOpen like any other wrapped screen, because that is
    // the path that holds the router's teardown off while it renders and
    // puts the shell's identity back afterwards.
    await istaOpen({
      label: s.label,
      _call: () => showEcuTreeChassis(chassis, car ? car.id : null),
    });
    if (!real) return;
    const slots = await istaLoadSlots(chassis, car);
    const faults = slots.reduce((a, x) => a + x.faults, 0);
    const read = slots.some((x) => x.state !== 'unread');
    let picked = null;
    const bar = () =>
      istaTestRun
        ? istaBottomBar('unit-list-busy', {
            cancel: () => istaTestCancel(),
          })
        : istaBottomBar('unit-list', {
            'vehicle-test': () => istaOpenVehicleTest(),
            'ecu-functions': picked
              ? () => istaOpenEcuWindow(picked.slot, picked.box, chassis)
              : null,
            'display-faults': () =>
              istaGo('management', 'troubleshooting', 'fault-memory'),
          });
    istaRealStatus({
      items: [
        { k: 'Fault memory', v: read ? String(faults) : 'Unknown' },
        ...(istaTestRun
          ? [{ k: 'Vehicle test', v: istaTestPhase() }]
          : istaTestError
            ? [{ k: 'Vehicle test', v: istaTestError }]
            : []),
      ],
      legend: [
        { cls: 'ok', label: 'ECU without fault memory' },
        { cls: 'warn', label: 'ECU with fault memory' },
        { cls: 'bad', label: 'ECU not responding' },
        { cls: 'blue', label: 'ECU with programming abort' },
      ],
    });
    bar();
    istaTreeBind(slots, chassis, (p) => {
      picked = p;
      bar();
    });
    return;
  }

  // ---- Vehicle information / Control unit list ------------------------------
  if (s.page === 'unit-list') {
    let picked = null;
    const slots = await istaLoadSlots(chassis, car);
    if (!host.isConnected) return;
    const faults = slots.reduce((a, x) => a + x.faults, 0);
    const read = slots.some((x) => x.state !== 'unread');
    const bar = () =>
      istaTestRun
        ? istaBottomBar('unit-list-busy', {
            cancel: () => istaTestCancel(),
          })
        : istaBottomBar('unit-list', {
            'vehicle-test': () => istaOpenVehicleTest(),
            // the window is about ONE control unit, so it needs one picked
            'ecu-functions': picked
              ? () => istaOpenEcuWindow(picked, null, chassis)
              : null,
            'display-faults': () =>
              istaGo('management', 'troubleshooting', 'fault-memory'),
          });
    istaPageUnitList(host, {
      slots,
      onPick: (x) => {
        picked = x;
        bar();
      },
    });
    istaRealStatus({
      items: [
        { k: 'Fault memory:', v: read ? String(faults) : 'Unknown' },
        ...(istaTestRun
          ? [{ k: 'Vehicle test:', v: istaTestPhase() }]
          : istaTestError
            ? [{ k: 'Vehicle test:', v: istaTestError }]
            : []),
      ],
      legend: [
        { cls: 'ok', label: 'ECU without fault memory' },
        { cls: 'warn', label: 'ECU with fault memory' },
        { cls: 'bad', label: 'ECU not responding' },
        { cls: 'dim', label: 'ECU not read' },
      ],
    });
    bar();
    return;
  }

  // ---- Operations / New / Basic Features ------------------------------------
  if (s.page === 'basic') {
    istaRealStatus({ items: [] });
    istaBottomBar('basic', {});
    // the gate is the CHARACTERISTIC TREE, not the parts catalogue: this
    // page is built from ISTA's own basic features and never touches a VIN
    const ok = await istaProbe(() =>
      typeof istaBasicPresent === 'function' ? istaBasicPresent() : false
    );
    if (!host.isConnected) return;
    if (!ok)
      return istaPageGrey(
        host,
        s.label,
        "BMW's characteristic tree is not in this build, so a vehicle " +
          'cannot be described feature by feature here'
      );
    istaPageBasic(host, {
      onChange: (n, row) => {
        istaRealStatus({ items: [{ k: 'Hits:', v: `${n} / ${n}` }] });
        istaBottomBar('basic', {
          // exactly ONE vehicle is the bar for opening: a set of choices
          // that still describes six cars has not identified one
          'open-operation': n === 1 && row ? () => istaOpenBasic(row) : null,
        });
      },
    });
    return;
  }

  if (s.page === 'readout') {
    istaRealStatus(real ? { items: [] } : null);
    // BOTH IDENTIFICATION BUTTONS READ THE CAR, so both need a cable. With
    // none connected they grey rather than offering a read that can only
    // fail: the page above already says to connect the interface, and a live
    // button beside that instruction contradicts it.
    const armReadout = (cable) =>
      istaBottomBar('readout', {
        cancel: () => istaGo('operations', 'new', 'vin'),
        'ident-only': cable
          ? () => istaGo('information', 'details', null)
          : null,
        // Complete identification IS the vehicle test: it reads the car
        'ident-full': cable ? () => istaOpenVehicleTest() : null,
      });
    if (real) armReadout(false);
    await istaPageReadout(host, { onCable: real ? armReadout : null });
    return;
  }

  if (s.page === 'active') {
    if (real) {
      istaRealStatus({ items: [] });
      istaBottomBar('none');
    }
    return istaPageActive(host, car, chassis);
  }

  if (s.page === 'repair') {
    // The repair manual draws its own page; what the shell owns is the
    // frame around it and WHICH VIEW it is on, which is the level-3 tab the
    // reader pressed. Its two views are keyed by those same tab ids, so
    // nothing has to be translated across the seam.
    if (real) {
      istaRealStatus({ items: [{ k: 'Hits:', v: '0 / 0' }] });
      istaBottomBar('product-structure', {});
    }
    if (typeof showRepair !== 'function') {
      const why = 'the repair document browser did not ship in this build';
      if (real) return istaPageGrey(host, s.label, why);
      host.innerHTML =
        `<div class="ista-page"><h2 class="ista-page-title">${esc(s.label)}` +
        `</h2><div class="ista-none-box">${esc(why)}</div></div>`;
      return;
    }
    return showRepair(host, car, chassis, s.id);
  }

  if (s.page === 'details') {
    if (!real) return istaShowDetails(host, car, chassis);
    istaRealStatus({ items: [] });
    istaBottomBar('details', {
      'vehicle-test': () => istaOpenVehicleTest(),
      'info-search': () =>
        istaGo('management', 'troubleshooting', 'text-search'),
    });
    // the grid draws from the catalogue decode at once, then fills in what a
    // read finds; nothing is read unless the user asked for it elsewhere
    istaRealDetails(host, car, istaState.etk, {});
    return;
  }

  if (s.page === 'equipment') {
    if (!real) return istaShowEquipment(host, car, chassis);
    istaRealStatus({ items: [] });
    istaBottomBar('equipment', {
      'show-test': () => istaGo('information', 'tree', null),
      'info-search': () =>
        istaGo('management', 'troubleshooting', 'text-search'),
    });
    istaRealEquipment(host, [], null);
    const got = await istaProbe(async () => {
      if (typeof readIdentityCodes !== 'function') return null;
      if (typeof loadTables === 'function') await loadTables();
      if (typeof loadSaNames === 'function') await loadSaNames();
      return readIdentityCodes(chassis);
    });
    if (!host.isConnected) return;
    const codes = (got && got.codes) || [];
    // THE ORDER'S CODES STAY WITH THE CAR. A validity rule's SA leaves are
    // decided from them, and the read costs a cable, so what came back is
    // kept on the Garage record for every later visit
    if (car && codes.length && typeof garageUpdateCar === 'function')
      garageUpdateCar(car.id, { sa: istaOrderWords(got) });
    const date = car && car.prod ? Number(String(car.prod).padEnd(8, '0')) : 0;
    // THE NAME LIVES ON VehicleIdentity, NOT AS A BARE GLOBAL. sa-names.js
    // assigns saName onto the VehicleIdentity namespace only, so a guard of
    // `typeof saName === 'function'` was ALWAYS false and returned '' --
    // every SA came out as a bare number, and the earlier fix to the
    // argument order (saName(code, date), not (chassis, code, date)) never
    // ran at all. The identity screen calls it the same way this does now.
    const names =
      typeof VehicleIdentity === 'object' &&
      VehicleIdentity &&
      typeof VehicleIdentity.saName === 'function'
        ? VehicleIdentity.saName
        : null;
    istaRealEquipment(host, codes, (c) => (names ? names(c, date) || '' : ''));
    return;
  }

  if (s.page === 'techdata') {
    if (!real) return showTechData(host, car, chassis);
    istaRealStatus({ items: [{ k: 'Filter:', v: 'Default' }] });
    await showTechData(host, car, chassis);
    if (!host.isConnected) return;
    // the app's page draws its own section tabs and a Show all checkbox; the
    // skin hides those (the level-3 strip is the sections, and Show all is a
    // filter) and this is the button that still reaches the checkbox
    istaBottomBar('techdata', {
      filters: () => istaTechDataFilter(host),
    });
    return;
  }
}

/**
 * The modern face's VIN page: the Garage picker as a plain list.
 * @param {HTMLElement} host - where to draw
 * @returns {void}
 */
function istaPageVinModern(host) {
  host.innerHTML =
    `<div class="ista-page"><h2 class="ista-page-title">New operation</h2>` +
    `<p class="ista-page-note">Pick the vehicle to work on.</p>` +
    `<div class="ista-none-box">Use the vehicle picker in the banner ` +
    `above, or switch Settings to the Classic layout for the full start ` +
    `page.</div></div>`;
}

/**
 * Open a vehicle and go to its details: the VIN page's Open operation.
 *
 * A row that was picked is already a saved car. A VIN that was typed is
 * looked up in the Garage first (so the same car is not saved twice) and
 * only then decoded and added -- the decode is a catalogue lookup, so this
 * costs the car nothing and works with no cable at all.
 * @param {object|null} car - the picked GarageCar, or null
 * @param {string} vin - what was in the box
 * @returns {Promise<void>}
 */
async function istaOpenOperation(car, vin) {
  let use = car;
  const v = String(vin || '')
    .trim()
    .toUpperCase();
  if (!use && v) {
    if (typeof garageFindByVin === 'function') use = garageFindByVin(v) || null;
    if (!use) {
      const etk = await istaProbe(() =>
        typeof viEtkDecode === 'function' ? viEtkDecode(v) : null
      );
      if (!etk) {
        if (typeof toast === 'function')
          toast(`No vehicle in the parts index matches ${v}`);
        return;
      }
      if (typeof garageAddCar === 'function')
        use = garageAddCar({
          vin: v,
          chassis: etk.chassis,
          model: etk.model,
          body: etk.body,
          motor: etk.motor,
          prod: String(etk.prod || ''),
        });
    }
  }
  if (!use) return;
  istaSetCar(use);
  return istaGo('information', 'details', null);
}

/**
 * The ISTA shell.
 * @param {string} [tab] - the tab to open
 * @param {string|null} [sub] - the sub-tab on it
 * @param {string|null} [sub3] - the level-3 tab on that
 * @param {string|null} [carId] - a car id from the route
 * @returns {Promise<void>}
 */
/**
 * Draw the page the shell is already on again.
 *
 * The vehicle test uses this to colour the control units in as they answer,
 * so the read happens on the screen it was started from instead of a page
 * of its own. It is deliberately a re-render of the CURRENT route, not a
 * navigation: nothing about where the technician is changes.
 * @returns {Promise<void>}
 */
function istaRedraw() {
  return showIsta(istaState.tab, istaState.sub, istaState.sub3);
}

/**
 * Recolour the control units in place, without rebuilding the page.
 *
 * REDRAWING THE WHOLE SHELL ON EVERY ANSWER IS A FLASHING SCREEN. showIsta
 * rebuilds the chrome, the crumbs, the tab strips and the tree's canvas, so
 * calling it per module made the page blink about once a second and threw
 * away the drawing each time. The read only ever changes two things -- each
 * box's state class and the status line -- so those are all that is touched.
 * @param {object[]} slots - the slots as they stand now
 * @returns {void}
 */
function istaPaintStates(slots) {
  if (typeof document === 'undefined') return;
  const host = document.getElementById('view');
  if (!host) return;
  const find = (key) => {
    const at = String(key).lastIndexOf('@');
    const name = at > 0 ? String(key).slice(0, at) : String(key);
    const addr = at > 0 ? String(key).slice(at + 1) : '';
    return (
      (slots || []).find(
        (x) =>
          (x.box && x.box.name === name && String(x.box.addr) === addr) ||
          (x.box && x.box.name === name)
      ) || null
    );
  };
  // the bus map's boxes
  host.querySelectorAll('.tree-box').forEach((el) => {
    const slot = find(el.getAttribute('data-key') || '');
    const state = (slot && slot.state) || 'unread';
    for (const c of ['ok', 'faults', 'silent', 'unread'])
      el.classList.toggle(`tree-${c}`, c === state);
  });
  // the bus map's own progress bar, which the screen already ships: how far
  // the read has got, against the addresses this chassis's tree lists
  const bar = host.querySelector('.tree-progress');
  if (bar) {
    const live = istaTestLive();
    bar.hidden = !live;
    if (live) {
      // COUNT WHAT THE RUNNING PASS HAS HEARD. Counting slots that have left
      // 'unread' leaves the bar frozen for the whole identification pass,
      // because identification deliberately leaves them unread: it proves a
      // module is there without asking its fault memory.
      const r = live.phase === 'faults' ? live.faults : live.ident;
      const done =
        ((r && r.modules) || []).length + ((r && r.silent) || []).length;
      const total = (slots || []).length;
      const pct = total ? Math.min(100, Math.round((100 * done) / total)) : 0;
      if (bar.firstElementChild) bar.firstElementChild.style.width = `${pct}%`;
      bar.title =
        `${done} of about ${total} control units, ` +
        (live.phase === 'faults' ? 'fault memories' : 'identification');
    }
  }
  // the control unit list's state dots
  // EACH ROW NAMES ITS SLOT. The list is drawn sorted by state, and a read
  // changes states, so re-sorting here and zipping by index painted the
  // first answer's dot onto whichever row now sat at its old position
  const rows = host.querySelectorAll('.irunits tbody tr');
  if (rows.length) {
    const byId = new Map((slots || []).map((s) => [String(s.id || ''), s]));
    rows.forEach((tr) => {
      const dot = tr.querySelector('.irstate i');
      const slot = byId.get(String(tr.getAttribute('data-slot') || ''));
      if (dot && slot)
        dot.className =
          (typeof ISTA_STATE_CLASS !== 'undefined' &&
            ISTA_STATE_CLASS[slot.state]) ||
          'dim';
    });
  }
}

async function showIsta(tab, sub, sub3, carId) {
  if (typeof cancelSweep === 'function') cancelSweep();
  if (!istaState.car && !istaState.chassis) istaRestoreCar(carId);
  else if (carId) istaRestoreCar(carId);
  istaState.tab = istaTab(tab) ? tab : ISTA_HOME_TAB;
  const firstSub = (istaFirstSub(istaState.tab) || {}).id || null;
  istaState.sub = istaSub(istaState.tab, sub) ? sub : firstSub;
  const first3 = istaState.sub
    ? (istaFirstSub3(istaState.tab, istaState.sub) || {}).id || null
    : null;
  istaState.sub3 =
    istaState.sub && istaSub3(istaState.tab, istaState.sub, sub3)
      ? sub3
      : first3;

  lastScreen = () => showIsta(istaState.tab, istaState.sub, istaState.sub3);
  // the shell drawing itself is not the user leaving it: hold the flag over
  // setCrumbs so the router's teardown check sees the shell's own render
  istaOpeningSet(true);
  try {
    setCrumbs([
      { label: 'Vehicles', fn: showChassis },
      { label: 'Workshop', fn: () => showIsta(ISTA_HOME_TAB, null, null) },
      { label: (istaTab(istaState.tab) || {}).label || istaState.tab },
    ]);
  } finally {
    istaOpeningSet(false);
  }
  istaChromeShow(); // after setCrumbs: it clears the body classes
  istaPaintChrome();
  istaRouteStamp();
  sbLeft.textContent = 'workshop';
  sbRight.textContent = istaChassis() || 'no vehicle';

  const real = istaSkinOn();
  const printAction = {
    key: 'p',
    label: 'Print',
    kind: 'print',
    fn: () => window.print(),
  };
  const homeAction = {
    key: 'Escape',
    keyLabel: 'Esc',
    label: 'Back',
    kind: 'back',
    fn: () => {
      istaChromeHide();
      showChassis();
    },
  };

  const s = istaLeaf(istaState.tab, istaState.sub, istaState.sub3);
  if (!s) {
    // an empty tab (Favourites before anything is pinned) is not a broken
    // sub-tab: it says what to do rather than erroring about a missing row
    view.innerHTML = '';
    setActions([printAction, homeAction]);
    if (real) {
      istaRealStatus({ items: [] });
      istaBottomBar('none');
      istaPageGrey(
        view,
        (istaTab(istaState.tab) || {}).label || istaState.tab,
        istaState.tab === 'favourites'
          ? 'Nothing pinned yet. The star on a sub-tab pins it here.'
          : 'Nothing here yet.'
      );
    } else {
      await istaHome(view, istaState.tab);
    }
    return;
  }

  const state = await istaSubReady(s);

  if (!state.ok) {
    view.innerHTML = '';
    setActions([printAction, homeAction]);
    if (real) {
      istaRealStatus({ items: [] });
      // a greyed tab still shows the row of buttons its page would carry,
      // all refused: the control is visible and does nothing, which says
      // more than an empty bar
      istaBottomBar(s.id);
      // the greyed tabs that have a layout of their own get it drawn
      const shape = ISTA_GREY_SHAPES[s.id] || null;
      istaPageGrey(view, s.label, state.why, shape);
    } else {
      view.innerHTML =
        `<div class="ista-page"><h2 class="ista-page-title">${esc(
          s.label
        )}</h2>` + `<div class="ista-none-box">${esc(state.why)}</div></div>`;
    }
    return;
  }

  // a page the shell draws itself
  if (s.page) {
    view.innerHTML = '';
    setActions([printAction, homeAction]);
    const host = document.createElement('div');
    view.appendChild(host);
    await istaDrawPage(s, host);
    return;
  }

  // a screen the app already has
  await istaOpen(s);
}

/**
 * The layouts the greyed tabs draw under their reason.
 *
 * Each one is the real tool's own layout for that page, so the tab reads as
 * the tab it is rather than as an error. The reason itself comes from the
 * model, not from here.
 * @type {Object<string, object>}
 */
const ISTA_GREY_SHAPES = {
  before: { cols: ['Abbreviation', 'Control unit name', 'Replaced'] },
  after: { cols: ['Abbreviation', 'Control unit name', 'Replaced'] },
  retrofit: {
    cols: ['Description', 'Selection'],
    attention:
      'For a change of control unit (installation or exchange), also ' +
      "select the relevant control unit via the 'After Replacement' button.",
  },
  conversion: { cols: ['Description', 'Selection'] },
  removal: { cols: ['Description', 'Selection'] },
  immediate: { cols: ['Description', 'Selection'] },
  comfort: {
    attention:
      'Programming is not offered by this build: flashing a module can ' +
      'brick it.',
  },
  advanced: {
    attention:
      'Programming is not offered by this build: flashing a module can ' +
      'brick it.',
  },
  additional: {
    attention:
      'Programming is not offered by this build: flashing a module can ' +
      'brick it.',
  },
  'test-plan': { cols: ['Type', 'Title', 'State', 'Priority'] },
  'programming-plan': { cols: ['Type', 'Title', 'State', 'Priority'] },
  'fault-pattern': { cols: ['Hits', 'Search terms'] },
};

// ---- the shell's own home (modern face only) -------------------------------

/**
 * The modern face's home: every tab as a card, and every sub-tab under it.
 * @param {HTMLElement} host - where to draw
 * @param {string} [onlyTab] - draw just this tab's card
 * @returns {Promise<void>}
 */
async function istaHome(host, onlyTab) {
  const chassis = istaChassis();
  const show = onlyTab ? ISTA_TABS.filter((t) => t.id === onlyTab) : ISTA_TABS;
  host.innerHTML =
    `<div class="ista-home">` +
    (onlyTab
      ? ''
      : `<p class="ista-home-note">${
          chassis
            ? `ISTA on ${esc(
                typeof dispChassis === 'function'
                  ? dispChassis(chassis)
                  : chassis
              )}.`
            : `Pick a vehicle in the banner above to begin.`
        }</p>`) +
    `<div class="ista-home-grid"></div></div>`;
  const grid = host.querySelector('.ista-home-grid');

  for (const t of show) {
    const subs = istaSubsOf(t.id);
    const card = document.createElement('section');
    card.className = 'ista-card';
    card.innerHTML =
      `<h2 class="ista-card-title">${esc(
        String(t.label).replace(/\n/g, ' ')
      )}</h2>` +
      (t.desc ? `<p class="ista-card-desc">${esc(t.desc)}</p>` : '') +
      `<div class="ista-card-rows"></div>`;
    const rows = card.querySelector('.ista-card-rows');
    if (!subs.length) {
      rows.innerHTML = `<div class="ista-row-none">${
        t.id === 'favourites'
          ? 'Nothing pinned yet. The star beside a sub-tab pins it here.'
          : 'Nothing here yet.'
      }</div>`;
    }
    for (const s of subs) {
      const owner = s._tab || t.id;
      // a sub-tab with a strip under it is a group: its first leaf is what
      // the row would open, so that is what it reports on
      const leaf = s.subs3 ? istaFirstSub3(owner, s.id) || s : s;
      const state = await istaSubReady(leaf);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'ista-row' + (state.ok ? '' : ' ista-row-off');
      row.innerHTML =
        `<span class="ista-row-label">${esc(s.label)}</span>` +
        `<span class="ista-row-desc">${esc(
          state.ok ? s.desc || leaf.desc || '' : state.why
        )}</span>` +
        `<span class="ista-row-arrow">${state.ok ? '→' : ''}</span>`;
      if (state.ok) row.onclick = () => istaGo(owner, s.id, null);
      else row.disabled = true;
      rows.appendChild(row);
    }
    grid.appendChild(card);
  }
}

if (typeof window !== 'undefined') {
  window.showIsta = showIsta;
  window.istaOpenFaultMemory = istaOpenFaultMemory;
  window.istaOpenVehicleTest = istaOpenVehicleTest;
  window.istaOpenIdentScan = istaOpenIdentScan;
  window.istaOpenService = istaOpenService;
  window.istaOpenServiceResets = istaOpenServiceResets;
  window.istaOpenTree = istaOpenTree;
  window.istaOpenHistory = istaOpenHistory;
  window.istaOpenLatestReport = istaOpenLatestReport;
  window.istaOpenIdentity = istaOpenIdentity;
  window.istaOpenCoding = istaOpenCoding;
  window.istaOpenModules = istaOpenModules;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ISTA_CAR_KEY,
    ISTA_CHASSIS_KEY,
    ISTA_GREY_SHAPES,
    istaState,
    istaChassis,
    istaSetCar,
    istaRestoreCar,
    istaSubReady,
    istaRouteStamp,
    istaOpenOperation,
    istaOrderWords,
    showIsta,
  };
}
