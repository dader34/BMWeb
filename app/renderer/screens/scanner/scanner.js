/**
 * @file BMWeb Scanner: the reference scanner's full car scan (BMW Scanner
 * 1.4.0.7), rebuilt on BMWeb's own cable.
 *
 * The reference walks its module table in order, identifies each module
 * (DS2 identification, KWP2000 for the modules it flags), reads the fault
 * memory of every module that answered, and writes one log. This does the
 * same over a plain K+DCAN cable: the identification goes straight down the
 * wire (no SGBD), the way the reference's adapter sends it; the fault count
 * comes from the module's own FS_LESEN until the reference's fault read is
 * reproduced byte for byte.
 *
 * Data and formatting live in scanner-data.js; this file is the wire and
 * the screen.
 */

/* exported showScanner */

/** The identification line parameters (scanner-proc.js holds them all). */
const scannerDs2Comm = () => ({ ...SCANNER_COMM.ds2Ident });
const scannerKwpComm = () => ({ ...SCANNER_COMM.kwpIdent });

/**
 * Identify one module, holding the bus for the whole question so nothing
 * else talks between the DS2 try and the KWP2000 one.
 * @param {ScannerModule} m
 * @returns {Promise<{id: ScannerIdent, raw: number[]}|null>} Null when the
 *   module did not answer either way.
 */
function scannerIdentify(m) {
  const pa = scannerPasoft();
  if (pa) return scannerIdentifyPasoft(pa, m);
  return withBusLock(async () => {
    if (!scannerKwpOnly(m)) {
      try {
        const r = await webBusRawExchange(
          [m.address, 4, 0x00],
          scannerDs2Comm()
        );
        const id = scannerParseDs2Ident(r);
        if (id) return { id, raw: Array.from(r) };
      } catch (e) {
        // silence: the module is not there, or speaks KWP2000
      }
    }
    if (scannerTriesKwp(m)) {
      try {
        const r = await webBusRawExchange(
          [0xb8, scannerKwpAddress(m), 0xf1, 0x02, 0x1a, 0x80],
          scannerKwpComm()
        );
        const id = scannerParseKwpIdent(r);
        if (id) return { id, raw: Array.from(r) };
      } catch (e) {
        // silent in KWP2000 as well
      }
    }
    return null;
  });
}

/**
 * The PA Soft cable when it is the cable to use: connected, and no K+DCAN
 * cable beside it (that one can do everything, so it wins).
 * @returns {PasoftCable|null}
 */
function scannerPasoft() {
  if (typeof webBus !== 'undefined' && webBus && webBus.connected) return null;
  if (typeof pasoftCable === 'undefined' || !pasoftCable) return null;
  return pasoftCable.connected ? pasoftCable : null;
}

/** Modules PA Soft sets up the bus for with its slow timing (0x6B9395). */
const SCANNER_PASOFT_SLOW = ['DME', 'DME2', 'SRS', 'TEL', 'SBE', 'URS'];

/**
 * Identify one module through the PA Soft cable: its adapter's own words,
 * 46F1 (DS2 00) and 06F3 (KWP 1A 80). The module's answer comes back, not
 * the bus echo, so the same parsers read it.
 * @param {PasoftCable} pa
 * @param {ScannerModule} m
 * @returns {Promise<{id: ScannerIdent, raw: number[]}|null>}
 */
function scannerIdentifyPasoft(pa, m) {
  const slow = SCANNER_PASOFT_SLOW.includes(m.name);
  return pa.run(async (port) => {
    if (!scannerKwpOnly(m)) {
      const r = await port.identifyDs2(m.address, slow);
      const id = r.status === 'ok' && scannerParseDs2Ident(r.reply);
      if (id) return { id, raw: Array.from(r.reply) };
    }
    if (scannerTriesKwp(m)) {
      const r = await port.identifyKwp(scannerKwpAddress(m));
      const id = r.status === 'ok' && scannerParseKwpIdent(r.reply);
      if (id) return { id, raw: Array.from(r.reply) };
    }
    return null;
  });
}

/**
 * The one link everything after identification sends through: BMWeb's own
 * cable with raw telegrams, or the reference's cable with its adapter's word
 * for each (scannerPasoftLink). With `rec`, every telegram and its answer
 * (or error) is written down.
 * @param {string[]} [rec]
 * @returns {ScannerLink}
 */
const scannerLink = (rec) => {
  const pa = scannerPasoft();
  const base = pa
    ? scannerPasoftLink(pa)
    : scannerProcLink(webBusRawExchange, withBusLock);
  if (!rec) return base;
  const hex = (a) =>
    Array.from(a || [], (b) => b.toString(16).padStart(2, '0')).join(' ');
  const noted = (kind, fn) => async (addr, payload) => {
    const out = `${kind} ${hex([addr])}: ${hex(payload)}`;
    try {
      const r = await fn(addr, payload);
      rec.push(`${out}  ->  ${r && r.length ? hex(r) : '(empty)'}`);
      return r;
    } catch (e) {
      rec.push(`${out}  ->  ${(e && (e.ifh || e.message)) || e}`);
      throw e;
    }
  };
  return { ...base, ds2: noted('DS2', base.ds2), kwp: noted('KWP', base.kwp) };
};

/** The tool buttons' glyphs (css/scanner.css), by tool id. */
const SCANNER_GLYPH = {
  ident: 'car-ident',
  page1: 'page-1',
  page2: 'page-2',
  page3: 'page-3',
  page4: 'page-4',
  scan: 'scan',
  clear: 'clear-dtc',
  settings: 'settings',
  stop: 'stop',
};

/**
 * The fault and shadow-memory counts, read the reference's way: DS2 04 00
 * and 14 00, KWP2000 18 02 FF FF (scanner-proc.js), on either cable. Null
 * for a count the module did not give.
 * @param {ScannerModule} m
 * @param {{kwp: boolean, raw: number[]|null}} found - How it identified.
 * @returns {Promise<{errors: number|null, shadow: number|null}>}
 */
async function scannerCounts(m, found, rec) {
  try {
    return await scannerReadCounts(scannerLink(rec), m, found);
  } catch (e) {
    return { errors: null, shadow: null };
  }
}

/**
 * Clear one module's fault memory the reference's way (scannerClearProc),
 * then read its count again.
 * @param {ScannerModule} m
 * @param {{kwp: boolean, raw: number[]|null}} found - How it identified.
 * @param {string[]} [rec] - Telegram log.
 * @returns {Promise<{ok: boolean, left: number|null, sent?: string[], error?: string}>}
 */
async function scannerClearFaults(m, found, rec) {
  try {
    const out = await scannerClearProc(scannerLink(rec), m, found);
    const after = await scannerCounts(m, found, rec);
    return { ok: out.ok, left: after.errors, sent: out.sent };
  } catch (e) {
    return { ok: false, left: null, error: String((e && e.message) || e) };
  }
}

/**
 * The cable a scan runs over (scanner-scan.js): whichever is connected,
 * through the functions above.
 * @returns {ScannerScanIo}
 */
const scannerCableIo = () => ({
  identify: scannerIdentify,
  counts: scannerCounts,
  faultList: (m, found) => scannerReadFaultList(scannerLink(), m, found),
  clearFaults: scannerClearFaults,
});

/** The log's title line, the reference's layout with this app's name. */
function scannerTitle() {
  const left = `${typeof APP_NAME === 'string' ? APP_NAME : 'BMWeb'} Scanner`;
  const right = `Time: ${new Date().toLocaleString('en-US')}`;
  return (
    left + ' '.repeat(Math.max(2, 123 - left.length - right.length)) + right
  );
}

/** Rows on one page of the unit grid, as the reference draws them. */
const SCANNER_PAGE_ROWS = 20;

/**
 * The modules on a page: twenty per page in table order, the last page
 * holding what is left (page 1 is DME .. BMBT, as the reference shows it).
 * @param {number} page - 1-based.
 * @returns {ScannerModule[]}
 */
function scannerPage(page) {
  const list = scannerGridModules();
  const pages = scannerPageCount();
  const from = (page - 1) * SCANNER_PAGE_ROWS;
  const to = page === pages ? list.length : from + SCANNER_PAGE_ROWS;
  return list.slice(from, to);
}

/**
 * The modules the grid and the scan walk: the reference's table less the
 * second DME, which it keeps off its pages (its page 1 runs DME, EGS, EWS
 * ... BMBT) -- sixty units on three pages of twenty -- and then the units
 * it does not have (SCANNER_EXTRA_MODULES), on a page of their own.
 * @returns {ScannerModule[]}
 */
const scannerGridModules = () =>
  scannerUnits().filter((m) => m.name !== 'DME2');

/**
 * The page a module sits on.
 * @param {ScannerModule} m
 * @returns {number}
 */
const scannerPageOf = (m) =>
  Math.min(
    scannerPageCount(),
    Math.floor(scannerGridModules().indexOf(m) / SCANNER_PAGE_ROWS) + 1
  );

/** @returns {number} How many pages the table fills. */
const scannerPageCount = () =>
  Math.max(1, Math.ceil(scannerGridModules().length / SCANNER_PAGE_ROWS));

/**
 * What a module's second cell says once it is identified: the part number,
 * then hardware and software, the way the reference words it.
 * @param {ScannerIdent} id
 * @returns {string}
 */
const scannerIdentText = (id) => `${id.part}   hw: ${id.hw}  sw: ${id.sw}`;

/**
 * A fault count the way the reference's grid prints it.
 * @param {number|null|undefined} n
 * @returns {string}
 */
const scannerCountText = (n) =>
  n == null ? '' : n === 0 ? 'no errors' : n === 1 ? '1 error' : `${n} errors`;

/** The running scan's token; leaving the screen or a new scan bumps it. */
let _scannerToken = 0;

/**
 * What the scanner keeps between visits: the page shown and what each
 * module answered (by name), so leaving and coming back keeps the grid.
 */
const scannerLive = {
  page: 1,
  /** @type {Map<string, {id: ScannerIdent|null, raw: number[]|null, errors: number|null, state: string}>} */
  results: new Map(),
  log: '',
  running: false,
  /** The grid moves with the scan until the user picks a page. */
  follow: true,
};

/**
 * The BMWeb Scanner screen: the reference's main window -- tool buttons on
 * the left, the unit grid on the right, one page of twenty units at a time,
 * every unit listed before anything is asked.
 *
 * Opened for a Garage car (its Fault scan or its Identification), every
 * reading scan of the visit also reads the units' fault lists and is filed
 * against that car, and Back returns to its page.
 * @param {object} [opts]
 * @param {GarageCar} [opts.car] - The Garage car the scans are kept against.
 * @param {boolean} [opts.scan] - Start a scan at once.
 * @param {boolean} [opts.ident] - Start Car ident at once.
 * @returns {void}
 */
function showScanner(opts) {
  const car = (opts && opts.car) || null;
  // coming back to the screen redraws it; it does not scan again. The plain
  // Scanner is routed by its own name (#scanner); for a Garage car the
  // address carries the car, set below
  lastScreen = car ? () => showScanner({ car }) : showScanner;
  setCrumbs(
    car
      ? [
          { label: 'Vehicles', fn: showChassis },
          { label: 'Garage', fn: showGarage },
          { label: garageCarLabel(car), fn: () => showGarageCar(car.id) },
          { label: 'BMWeb Scanner' },
        ]
      : [
          { label: 'Vehicles', fn: showChassis },
          { label: 'Apps', fn: showApps },
          { label: 'BMWeb Scanner' },
        ]
  );
  if (car && typeof garageRouteSet === 'function')
    garageRouteSet(`scanner/${car.id}`);
  document.body.classList.add('apps-section', 'scn-page');
  sbLeft.textContent = 'scanner';
  // the reference data pack (layouts, texts, glyphs): fetched once, in the
  // background; the windows that need it wait for it themselves
  scannerAssetsLoad();
  view.innerHTML = '';
  const leave = () => {
    _scannerToken++;
    scannerLive.running = false;
    if (car) showGarageCar(car.id);
    else showApps();
  };
  setActions([
    { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: leave },
  ]);

  // the reference's window only: no modern skin, whatever the layout setting
  const modern = false;
  const TIP = "Tip : double-click on unit's name to explore it";
  const win = document.createElement('div');
  win.className = modern ? 'ncs-modern scn-modern' : 'wkfp-win scn-win';
  win.innerHTML = modern
    ? `
    <div class="ncsm-head">
      <div><div class="ncsm-eyebrow">Diagnostics</div><div class="ncsm-title">BMWeb Scanner</div></div>
      <div class="ncsm-menubar" id="scn-menubar"></div>
    </div>
    <div class="scn-body">
      <section class="ncsm-card scn-tools" id="scn-tools"></section>
      <section class="ncsm-card scn-gridcard"><div class="scn-grid" id="scn-grid"></div></section>
    </div>
    <div class="ncsm-status"><span id="scn-status">${esc(TIP)}</span></div>`
    : `
    <div class="wkfp-titlebar">BMWeb Scanner</div>
    <div class="wkfp-menubar" id="scn-menubar"></div>
    <div class="scn-body">
      <div class="scn-tools" id="scn-tools"></div>
      <div class="scn-grid" id="scn-grid"></div>
    </div>
    <div class="wkfp-statusbar"><span id="scn-status">${esc(TIP)}</span></div>`;
  view.appendChild(win);
  if (!modern && typeof winMaximizable === 'function') winMaximizable(win);
  const $ = (id) => win.querySelector('#' + id);
  const setStatus = (t) => {
    $('scn-status').textContent = t || TIP;
  };
  const connected = () =>
    (typeof webBus !== 'undefined' && webBus && webBus.connected) ||
    !!scannerPasoft();

  // ---- the unit grid ---------------------------------------------------------
  /** @type {Map<string, HTMLElement>} the row of each module on the page */
  const rows = new Map();
  function paintGrid() {
    const grid = $('scn-grid');
    grid.innerHTML = '';
    rows.clear();
    for (const m of scannerPage(scannerLive.page)) {
      const row = document.createElement('div');
      row.className = 'scn-row';
      row.innerHTML = `
        <button type="button" class="scn-name" title="${esc(m.desc)}">${esc(m.name)}</button>
        <div class="scn-cell scn-id"></div>
        <div class="scn-cell scn-err"></div>
        <div class="scn-cell scn-shadow"></div>
        <div class="scn-cell scn-desc">${esc(m.desc)}</div>`;
      row.querySelector('.scn-name').ondblclick = () => explore(m);
      row.querySelector('.scn-err').ondblclick = () => errorsWindow(m);
      grid.appendChild(row);
      rows.set(m.name, row);
      paintRow(m);
    }
    paintTools();
  }
  function paintRow(m) {
    const row = rows.get(m.name);
    if (!row) return;
    const r = scannerLive.results.get(m.name);
    const idCell = row.querySelector('.scn-id');
    const errCell = row.querySelector('.scn-err');
    const shadowCell = row.querySelector('.scn-shadow');
    row.classList.toggle('scn-busy', !!r && r.state === 'asking');
    // the row's colours are the reference's: green for a unit that answered
    // and has no faults (one whose count was read, and is zero), blue for
    // one that answered KWP2000, grey for one that did not answer, the
    // window's own colour until it has been asked
    const faults = !r
      ? null
      : r.after !== undefined && r.errors
        ? r.after
        : r.errors;
    row.classList.toggle('scn-found', !!(r && r.id));
    row.classList.toggle('scn-clean', !!(r && r.id) && faults === 0);
    row.classList.toggle('scn-kwp', !!(r && r.id && r.id.kwp));
    row.classList.toggle('scn-missing', !!r && r.state === 'silent');
    if (!r) {
      idCell.textContent = '';
      errCell.textContent = '';
      errCell.classList.remove('scn-bad');
      shadowCell.textContent = '';
      shadowCell.classList.remove('scn-bad');
      return;
    }
    shadowCell.textContent =
      r.id && r.shadow != null ? scannerCountText(r.shadow) : '';
    shadowCell.classList.toggle('scn-bad', !!(r.id && r.shadow));
    if (r.state === 'asking') idCell.textContent = 'scanning…';
    else if (r.id) idCell.textContent = scannerIdentText(r.id);
    else idCell.textContent = '<not found>';
    idCell.title = r.raw
      ? 'Answer: ' + r.raw.map((b) => b.toString(16).padStart(2, '0')).join(' ')
      : '';
    errCell.textContent = r.id
      ? scannerCountText(r.errors) +
        (r.after !== undefined && r.errors
          ? ` → ${r.after == null ? '?' : r.after}`
          : '')
      : '';
    errCell.classList.toggle('scn-bad', !!faults);
    row.querySelector('.scn-name').textContent =
      m.name + (r.id && r.id.kwp ? '*' : '');
  }

  // ---- the tool buttons and the menus ----------------------------------------
  const tools = () => [
    {
      id: 'ident',
      label: 'Car ident',
      icon: '🚗',
      on: !scannerLive.running,
      fn: carIdent,
    },
    ...Array.from({ length: scannerPageCount() }, (_, i) => ({
      id: 'page' + (i + 1),
      label: `Page ${i + 1}`,
      icon: '▤',
      on: true,
      active: scannerLive.page === i + 1,
      fn: () => {
        scannerLive.page = i + 1;
        scannerLive.follow = false;
        paintGrid();
      },
    })),
    {
      id: 'scan',
      label: 'Scan!',
      icon: '⌕',
      on: !scannerLive.running,
      fn: scan,
    },
    {
      id: 'clear',
      label: 'Clear DTC',
      icon: '✎',
      on: !scannerLive.running,
      fn: clearDtc,
    },
    { id: 'settings', label: 'Settings', icon: '⚙', on: false, fn: () => {} },
    { id: 'stop', label: 'Stop', icon: '⊘', on: scannerLive.running, fn: stop },
  ];
  function paintTools() {
    const box = $('scn-tools');
    box.innerHTML = '';
    for (const t of tools()) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className =
        (modern ? 'btn scn-tool' : 'scn-tool') +
        (t.active ? ' scn-active' : '');
      b.disabled = !t.on;
      const glyph = SCANNER_GLYPH[t.id];
      if (glyph) b.classList.add('scn-has-glyph', 'scn-ico-' + glyph);
      b.title = t.label;
      b.innerHTML = glyph
        ? `<span class="scn-glyph"></span><span class="scn-label">${esc(t.label)}</span>`
        : `<span class="scn-icon">${t.icon}</span><span class="scn-label">${esc(t.label)}</span>`;
      b.onclick = () => t.fn();
      box.appendChild(b);
    }
    paintMenu();
  }
  const menus = () => [
    [
      'Scanner',
      [
        ['Car ident', !scannerLive.running, carIdent],
        ['Scan!', !scannerLive.running, scan],
        ['Stop', scannerLive.running, stop],
        ['Exit', true, leave],
      ],
    ],
    [
      'Units',
      Array.from({ length: scannerPageCount() }, (_, i) => [
        `Page ${i + 1}`,
        true,
        () => {
          scannerLive.page = i + 1;
          scannerLive.follow = false;
          paintGrid();
        },
      ]),
    ],
    ['View log', [['Scan log', !!scannerLive.log, viewLog]]],
    ['Help', [['About', true, about]]],
  ];
  let openMenu = null;
  const closeMenu = () => {
    if (openMenu) openMenu.remove();
    openMenu = null;
  };
  function paintMenu() {
    const bar = $('scn-menubar');
    bar.innerHTML = '';
    for (const [name, items] of menus()) {
      const b = document.createElement('button');
      b.className = modern ? 'btn ncsm-menu' : 'wkfp-menu';
      b.textContent = modern ? `${name} ▾` : name;
      b.onclick = (e) => {
        e.stopPropagation();
        const wasMine = openMenu && openMenu.dataset.menu === name;
        closeMenu();
        if (wasMine) return;
        const drop = document.createElement('div');
        drop.className = 'wkfp-drop';
        drop.dataset.menu = name;
        for (const [label, on, fn] of items) {
          const it = document.createElement('button');
          it.className = 'wkfp-drop-item';
          it.textContent = label;
          it.disabled = !on;
          it.onclick = (ev) => {
            ev.stopPropagation();
            closeMenu();
            fn();
          };
          drop.appendChild(it);
        }
        drop.style.left = `${b.offsetLeft}px`;
        bar.appendChild(drop);
        openMenu = drop;
      };
      bar.appendChild(b);
    }
  }
  win.addEventListener('click', closeMenu);

  // ---- actions -----------------------------------------------------------------
  const message = (kind, text, buttons, title) =>
    wkfpMessage(win, kind, text, buttons, title);

  async function needCable() {
    if (connected()) return true;
    await message(
      'warn',
      'No cable is connected. Connect it in the top bar first.'
    );
    return false;
  }

  function begin() {
    const token = ++_scannerToken;
    scannerLive.running = true;
    scannerLive.follow = true;
    paintTools();
    return () => token === _scannerToken;
  }
  function end() {
    scannerLive.running = false;
    paintTools();
  }

  /**
   * Car ident: the reference's prompt, then what its car identification
   * reads -- the FA, VIN and odometer of the IKE and the LCM -- shown in its
   * "Information about car and ZCS/FA coding" window (scanner-carinfo.js).
   */
  async function carIdent() {
    if (!(await needCable())) return;
    await scannerAssetsLoad();
    const go = await message(
      'info',
      'Switch ON ignition and press "Continue"',
      ['Continue >', 'Cancel'],
      'Car identification'
    );
    if (go !== 'Continue >') return;
    const alive = begin();
    let info = null;
    try {
      setStatus('Car identification: reading the IKE and the LCM…');
      info = await scannerReadCarInfo(scannerLink());
    } catch (e) {
      setStatus('Stopped: ' + ((e && e.message) || e));
    }
    end();
    if (!alive() && !info) return;
    if (!info || (!info.ike && !info.lcm)) {
      setStatus(
        'Car identification: neither the IKE nor the LCM answered. Is the ignition on?'
      );
      await message(
        'warn',
        'Neither the IKE nor the LCM answered. Is the ignition on?',
        ['OK'],
        'Car identification'
      );
      return;
    }
    const car = (info.ike && info.ike.car) || (info.lcm && info.lcm.car);
    setStatus(
      car
        ? `Car identification: ${car.chassis} ${car.model} (${car.engine}, ${car.gearbox}).`
        : 'Car identification: the FA did not match a known type key.'
    );
    await wkfpDialog(win, {
      title: 'Information about car and ZCS/FA coding',
      body: scannerCarInfoBody(info),
      cls: 'scn-cidlg',
      buttons: ['Close'],
    });
  }

  /**
   * The reference's scan, unit by unit down the pages: identify, read the
   * fault count, and -- for Clear DTC, which is the same scan in clear mode
   * (0x6C5DEC runs 0x6C3850 with its flag set) -- clear every unit that has
   * faults, wait the unit's settle time, and read it again for the log's
   * ERRORS AFTER CLEAR column. Clear DTC starts at once, as the reference's
   * does; Stop ends either between units.
   * @param {boolean} [clear]
   */
  async function scan(clear = false) {
    if (!(await needCable())) return;
    if (clear && scannerPasoft()) {
      await message(
        'warn',
        'Clear DTC is not available on the BMW Scanner (PA Soft) cable yet. Use Scan! to read the fault counts, or connect a K+DCAN cable to clear.'
      );
      return;
    }
    const alive = begin();
    const title = scannerTitle();
    const started = Date.now();
    const list = scannerGridModules();
    const verb = clear ? 'Clear DTC' : 'Scanning';
    // a reading scan for a Garage car is kept: it needs the faults
    // themselves, not only their counts
    const keep = !!car && !clear;
    /** What the Garage is handed: units read to the end, and the silent. */
    const read = [];
    const silent = [];
    const { answered, cleared, error } = await scannerScanUnits({
      units: list,
      alive,
      clear,
      faults: keep,
      io: scannerCableIo(),
      on: (phase, m, r, i) => {
        if (phase === 'ask') {
          // the grid follows the scan until the user picks a page
          const page = scannerPageOf(m);
          if (scannerLive.follow && page !== scannerLive.page) {
            scannerLive.page = page;
            paintGrid();
          }
          setStatus(`${verb}: ${m.name} (${i + 1}/${list.length})…`);
          scannerLive.results.set(m.name, {
            id: null,
            raw: null,
            errors: null,
            state: 'asking',
          });
        } else if (phase === 'failed') {
          scannerLive.results.delete(m.name);
        } else if (phase === 'silent') {
          silent.push(m);
          scannerLive.results.set(m.name, {
            id: null,
            raw: null,
            errors: null,
            state: 'silent',
          });
        } else if (phase === 'found') {
          scannerLive.results.set(m.name, r);
        } else if (phase === 'clearing') {
          setStatus(`Clear DTC: clearing ${m.name}…`);
        } else if (phase === 'done' && alive()) {
          // (a unit the stop cut short is left out rather than half filed)
          read.push(r);
        }
        paintRow(m);
      },
    });
    if (error) setStatus('Stopped: ' + error.message);
    scannerLive.log = scannerLog({
      title,
      clear,
      rows: answered.map((r) => ({
        module: r.module,
        id: r.id,
        errors: r.errors,
        shadow: r.shadow == null ? null : r.shadow,
        trace: r.trace || null,
        after: clear ? (r.errors || r.shadow ? r.after : r.errors) : undefined,
      })),
    });
    const secs = Math.round((Date.now() - started) / 1000);
    if (!alive())
      setStatus(`Stopped: ${answered.length} unit(s) answered so far.`);
    else if (clear)
      setStatus(
        `Clear DTC finished: ${cleared} unit(s) cleared in ${secs} s. View log > Scan log.`
      );
    else
      setStatus(
        `Scan finished: ${answered.length} unit(s) answered in ${secs} s. View log > Scan log.`
      );
    const stopped = !alive();
    end();
    if (keep && read.length) await keepInGarage(read, silent, stopped);
  }

  /**
   * File a scan against the Garage car this visit is for, and say so after
   * the scan's own status.
   * @param {ScannerUnitResult[]} read - The units read to the end.
   * @param {ScannerModule[]} silent - The units that did not answer.
   * @param {boolean} stopped - The scan was stopped before its end.
   */
  async function keepInGarage(read, silent, stopped) {
    const said = $('scn-status') ? $('scn-status').textContent : '';
    const report = await scannerGarageReport(car.chassis, read, silent);
    const kept = garageAddScan(car.id, { report }, { chassis: car.chassis });
    // the reader may have left, or started another scan, while it was filed
    if (!kept || !win.isConnected || scannerLive.running) return;
    setStatus(
      `${said} ${stopped ? 'What was read is kept' : 'Kept'} in the Garage against ${garageCarLabel(car)}.`
    );
  }

  const clearDtc = () => scan(true);

  function stop() {
    _scannerToken++;
    scannerLive.running = false;
    for (const [name, r] of scannerLive.results)
      if (r.state === 'asking') scannerLive.results.delete(name);
    paintGrid();
    setStatus('Stopped.');
  }

  function viewLog() {
    const pre = document.createElement('pre');
    pre.className = 'wkfp-logview scn-logview';
    pre.textContent = scannerLive.log;
    wkfpDialog(win, {
      title: 'Scan log',
      body: pre,
      cls: 'scn-logdlg',
      buttons: ['Save', 'Copy', 'Close'],
      check: (b) => {
        if (b === 'Copy') {
          navigator.clipboard.writeText(scannerLive.log).then(
            () => setStatus('Log copied.'),
            () => setStatus('Copy failed.')
          );
          return false;
        }
        if (b === 'Save') {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(
            new Blob([scannerLive.log], { type: 'text/plain' })
          );
          const t = new Date();
          const p = (n) => String(n).padStart(2, '0');
          a.download = `scan-${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}.log`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          return false;
        }
        return true;
      },
    });
  }

  /**
   * The reference's Errors window for one unit (double-click on its errors
   * cell): its fault list read the reference's way, its texts and markers.
   * @param {ScannerModule} m
   * @param {HTMLElement} [where] - Where it opens (over a Unit info window).
   */
  async function errorsWindow(m, where = win) {
    const r = scannerLive.results.get(m.name);
    if (!r || !r.id) {
      await message(
        'info',
        `${m.name} has not answered a scan yet. Scan the car first.`,
        ['OK'],
        m.name
      );
      return;
    }
    if (!(await needCable())) return;
    await scannerAssetsLoad();
    const found = { kwp: !!r.id.kwp, raw: r.raw };
    await scannerErrorsWindow(where, m, found, {
      read: async () => {
        const res = await scannerReadFaultList(scannerLink(), m, found);
        if (res.errors) r.errors = res.errors.length;
        if (res.shadow) r.shadow = res.shadow.length;
        paintRow(m);
        return res;
      },
      clear: async () => {
        const out = await scannerClearFaults(m, found);
        if (out.error) setStatus(`${m.name}: ${out.error}`);
      },
    });
  }

  /**
   * The reference's Unit info window (double-click on a unit's name).
   * @param {ScannerModule} m
   */
  async function explore(m) {
    if (!(await scannerAssetsLoad())) {
      await message(
        'warn',
        'The window layouts could not be loaded (no connection to the data mirrors). Try again when online.',
        ['OK'],
        m.name
      );
      return;
    }
    return scannerUnitInfo(win, m, scannerLive.results.get(m.name), {
      errors: (where) => errorsWindow(m, where),
      link: () => (connected() ? scannerLink() : null),
    });
  }

  function about() {
    message(
      'info',
      'BMWeb Scanner\n\nA full car scan modelled on BMW Scanner 1.4.0.7.',
      ['OK'],
      'About'
    );
  }

  paintGrid();
  if (!connected())
    setStatus('Connect the cable in the top bar, then Car ident or Scan!');
  if (opts && opts.scan) whenCableIsUp(scan);
  else if (opts && opts.ident) whenCableIsUp(carIdent);

  /**
   * Start what the screen was opened for, once the cable has had its chance
   * to come up: right after a page load it is still reconnecting, and a
   * read started then would only say there is none.
   * @param {() => void} start - The scan, or Car ident.
   */
  async function whenCableIsUp(start) {
    if (typeof window !== 'undefined' && window.cableReady)
      await window.cableReady.catch(() => {});
    if (win.isConnected && !scannerLive.running) start();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    scannerIdentify,
    scannerPasoft,
    scannerCounts,
    scannerClearFaults,
    scannerCableIo,
    scannerPageOf,
    scannerDs2Comm,
    scannerKwpComm,
    scannerPage,
    scannerGridModules,
    scannerPageCount,
    scannerIdentText,
  };
}
