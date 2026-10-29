/**
 * @file NCS Expert, recreated the way WebKFP recreates WinKFP: BMW's coding
 * tool's own window, keys and dialogs, over BMWeb's coding engine.
 *
 * The flow is NCS Expert's. Main: VIN/ZCS/FA (enter the car's key, read it
 * from an ECU, load it from a file, or just pick the chassis), then Process
 * ECU: pick the module, pick the job, execute. Read ECU writes the module's
 * coding as FSW_PSW.TRC; SG_CODIEREN codes it with FSW_PSW.MAN laid over what
 * it holds — the expert's usual round trip.
 *
 * Underneath is the coding engine, unchanged: one ECU is read through its own
 * coding script (scanCoding), decoded with BMW's DATEN (moduleFunctions), and
 * written through treeWriteModule, which backs the module up and proves the
 * write by reading it back. The flow lives in ncs-actions.js; the files and
 * FSW_PSW format in ncs-files.js.
 */

/* exported showNcsExpert */
/* global ncsProfile, ncsFiles, ncsSaveFiles, NCS_PROFILES, ncsBindActions,
   ncsBindDummy */

/** One NCS per page: coming back finds the car and module as they were. */
const ncsLive = { state: null, win: null };

/**
 * Render NCS Expert.
 * @returns {void}
 */
function showNcsExpert() {
  lastScreen = showNcsExpert;
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: 'Apps', fn: showApps },
    { label: 'Coding' },
  ]);
  document.body.classList.add('apps-section');
  sbLeft.textContent = 'coding';
  view.innerHTML = '';
  setActions([
    {
      key: 'Escape',
      keyLabel: 'Esc',
      label: 'Back',
      kind: 'back',
      fn: showApps,
    },
  ]);

  const state =
    ncsLive.state ||
    (ncsLive.state = {
      /** 'main' | 'vin' | 'ecu' */
      mode: 'main',
      chassis: '',
      fg: '',
      /** {gm, sa, vn} */
      zcs: null,
      /** the vehicle order's text, where the car has one */
      fa: '',
      /** equipment codes from the key, for module selection */
      saCodes: null,
      /** the picked module (the chassis map's row) */
      mod: null,
      job: 'SG_CODIEREN',
      /** the last read: {mod, fns, image, source} */
      read: null,
      msg: [],
      status: '',
      busy: false,
    });
  const profile = ncsProfile();
  // The INPA-style layout is NCS Expert's own window; the modern one is the
  // same flow -- the same keys, menu, dialogs and actions, bound to the same
  // ids -- drawn as a BMWeb screen (styles.css, .ncs-modern).
  const modern = !inpaMode();

  const win = document.createElement('div');
  if (modern) {
    win.className = 'ncs-modern';
    win.innerHTML =
      '<div class="ncsm-head">' +
      '<div><div class="ncsm-eyebrow">Coding</div>' +
      '<div class="ncsm-title" id="ncs-title"></div></div>' +
      '<div class="ncsm-menubar" id="ncs-menubar"></div>' +
      '</div>' +
      '<div class="ncsm-steps" id="ncsm-steps"></div>' +
      '<div class="ncsm-grid">' +
      '<section class="ncsm-card"><div class="ncsm-label">Vehicle</div>' +
      '<div class="ncs-car ncsm-car" id="ncs-car"></div>' +
      '<div class="ncsm-nrcl">Session <span id="ncs-nrcl"></span></div></section>' +
      '<section class="ncsm-card ncsm-msgcard"><div class="ncsm-label">Messages</div>' +
      '<div class="ncs-msg ncsm-msg" id="ncs-msg"></div></section>' +
      '</div>' +
      '<div class="ncsm-actions" id="ncs-fkeys"></div>' +
      '<div class="ncsm-status"><span id="ncs-status">Ready</span></div>' +
      '<input type="file" id="ncs-file" hidden>';
  } else {
    win.className = 'wkfp-win ncs-win';
    win.innerHTML =
      '<div class="wkfp-titlebar" id="ncs-title"></div>' +
      '<div class="wkfp-menubar" id="ncs-menubar"></div>' +
      '<div class="wkfp-client">' +
      '<fieldset class="wkfp-panel ncs-info">' +
      '<div class="ncs-car" id="ncs-car"></div>' +
      '<div class="ncs-nrcl"><span>Nrcl-No.:</span><span id="ncs-nrcl"></span></div>' +
      '</fieldset>' +
      '<fieldset class="wkfp-panel ncs-msgpanel"><div class="ncs-msg" id="ncs-msg"></div></fieldset>' +
      '<fieldset class="wkfp-panel wkfp-fkeys ncs-fkeys" id="ncs-fkeys"></fieldset>' +
      '</div>' +
      '<div class="wkfp-statusbar"><span id="ncs-status">Ready</span>' +
      '<span class="wkfp-lock">CAP</span><span class="wkfp-lock">NUM</span>' +
      '<span class="wkfp-lock">SCRL</span></div>' +
      '<input type="file" id="ncs-file" hidden>';
  }
  view.appendChild(win);
  ncsLive.win = win;
  if (!modern) winMaximizable(win);
  const $ = (id) => win.querySelector('#' + id);

  // The flow (keys, dialogs, read/code) is bound here; `ctx` is everything it
  // needs of this render.
  const ctx = {
    state,
    profile,
    win,
    $,
    paint,
    setStatus,
    say,
    setMode,
    log,
    keys: () => keys(),
  };

  // ---- painting --------------------------------------------------------------
  function paint() {
    const profileName = NCS_PROFILES[profile.id] || 'Expertmode';
    $('ncs-title').textContent = modern
      ? profileName
      : 'BMWeb Coding - ' + profileName;
    if (modern) paintSteps();
    const rows = [
      ['CHASSIS:', state.chassis ? `${state.chassis} (${state.chassis})` : ''],
    ];
    rows.push(['FG', state.fg]);
    if (state.fa) rows.push(['FA', state.fa]);
    else {
      rows.push(['GM', state.zcs ? state.zcs.gm : '']);
      rows.push(['SA', state.zcs ? state.zcs.sa : '']);
      rows.push(['VN', state.zcs ? state.zcs.vn : '']);
    }
    $('ncs-car').innerHTML = rows
      .map(([k, v]) => `<span>${esc(k)}</span><span>${esc(v || '')}</span>`)
      .join('');
    $('ncs-nrcl').textContent = state.chassis ? 'BMWEB' : '';
    $('ncs-msg').textContent = ecuText().concat(state.msg).join('\n');
    $('ncs-status').textContent = state.status || 'Ready';
    paintKeys();
    paintMenu();
  }

  /**
   * The modern layout's progress line: the car, the module, the job -- what
   * NCS's window says across its panels, as three steps.
   */
  function paintSteps() {
    const steps = [
      [
        'Vehicle',
        state.chassis
          ? `${state.chassis}${state.fg ? ' · ' + state.fg : ''}`
          : 'not chosen',
        !!state.chassis,
        state.mode === 'vin' || (state.mode === 'main' && !state.chassis),
      ],
      [
        'Module',
        state.mod
          ? state.mod.umrsg || state.mod.label || state.mod.sgbd
          : 'not chosen',
        !!state.mod,
        state.mode === 'ecu' && !state.read,
      ],
      [
        'Job',
        state.mode === 'ecu' ? state.job : '—',
        state.mode === 'ecu' && !!state.read,
        state.mode === 'ecu' && !!state.read,
      ],
    ];
    $('ncsm-steps').innerHTML = steps
      .map(
        ([name, value, done, current], i) =>
          `<div class="ncsm-step${done ? ' done' : ''}${current ? ' current' : ''}">` +
          `<span class="ncsm-step-n">${done ? '✓' : i + 1}</span>` +
          `<span class="ncsm-step-text"><span class="ncsm-step-name">${esc(name)}</span>` +
          `<span class="ncsm-step-val">${esc(value)}</span></span></div>`
      )
      .join('<span class="ncsm-step-sep">›</span>');
  }

  /** The module panel's lines while an ECU is picked ("get coded: ..."). */
  function ecuText() {
    if (state.mode !== 'ecu' || !state.mod) return [];
    const r = state.read;
    const src = r && r.source;
    // the files NCS names: the coding file SGET routed it to, the coding
    // script, the coding SGBD
    const file =
      src && src.file
        ? `${src.file}.${src.cbd}`
        : `${(state.mod.files && state.mod.files[0]) || state.mod.umrsg}.C??`;
    const script = `${String((src && src.script) || state.mod.asw || 'A_????').toUpperCase()}.IPO`;
    const sgbd = String((src && src.sgbd) || state.mod.sgbd).toUpperCase();
    return [
      'get coded:',
      state.mod.umrsg || state.mod.label || sgbd,
      '',
      `JOBNAME = ${state.job}`,
      `${file}, ${script}, ${sgbd}.PRG`,
      '',
    ];
  }

  function setStatus(text) {
    state.status = text || '';
    $('ncs-status').textContent = state.status || 'Ready';
  }
  function say(...lines) {
    state.msg = lines;
    paint();
  }
  function log(line) {
    const f = ncsFiles();
    f.log.push(`${new Date().toISOString()}  ${line}`);
    ncsSaveFiles(f);
  }

  // ---- the F-keys ------------------------------------------------------------
  const actions = ncsBindActions(ctx);
  // NCS Dummy's half: the trace as a table of English names and options
  if (typeof ncsBindDummy === 'function')
    Object.assign(actions, ncsBindDummy(ctx, actions));
  ctx.traceEditor = actions.traceEditor;
  function keys() {
    const idle = !state.busy;
    const car = !!state.chassis;
    if (state.mode === 'vin') {
      const list = [];
      if (profile.keyEnter)
        list.push(['Enter Vin/ZCS', idle, actions.enterZcs]);
      if (profile.keyEcu)
        list.push(['Read Vin/ZCS from car', idle, actions.zcsFromEcu]);
      if (profile.keyFile)
        list.push(['Read Vin/ZCS from file', idle, actions.zcsFromFile]);
      if (profile.keyChassis)
        list.push(['Choose chassis', idle, actions.pickChassisOnly]);
      while (list.length < 5) list.push(['', false]);
      list.push(['Back', idle, () => setMode('main')]);
      return list;
    }
    if (state.mode === 'ecu')
      return [
        ['Change ECU', idle, actions.chooseEcu],
        ['Change job', idle, actions.changeJob],
        ['Execute job', idle, actions.executeJob],
        ['Read ECU', idle, () => actions.readEcu(true)],
        ['Basic functions', idle, actions.basicFunctions],
        ['Back to main', idle, () => setMode('main')],
      ];
    return [
      ['VIN/ZCS/FA', idle, () => setMode('vin')],
      // Process car is not offered; its slot stays empty so the keys keep
      // NCS's places (Process ECU on F3)
      ['', false],
      ['Process ECU', idle && car, actions.chooseEcu],
      ['Clear fields', idle, clearFields],
      ['', false],
      ['Exit', idle, showApps],
    ];
  }
  function paintKeys() {
    const box = $('ncs-fkeys');
    box.innerHTML = '';
    if (modern) {
      // the same six keys as buttons, their F-key beside the name; NCS's
      // blank slots are left out
      keys().forEach(([label, on, fn], i) => {
        if (!label) return;
        const b = document.createElement('button');
        b.className =
          'btn ncsm-key' + (i === 2 && state.mode === 'ecu' ? ' primary' : '');
        b.innerHTML = `<kbd>F${i + 1}</kbd><span>${esc(label)}</span>`;
        b.disabled = !on;
        if (on && fn) b.onclick = fn;
        box.appendChild(b);
      });
      return;
    }
    keys().forEach(([label, on, fn], i) => {
      const cell = document.createElement('div');
      cell.className = 'wkfp-fkey';
      const k = document.createElement('span');
      k.textContent = `F${i + 1}`;
      const b = document.createElement('button');
      b.className = 'wkfp-btn';
      b.textContent = label;
      b.disabled = !on;
      if (on && fn) b.onclick = fn;
      cell.append(k, b);
      box.appendChild(cell);
    });
  }
  /**
   * Clear fields: no chassis, VIN, ZCS/FA or module, the job back to
   * SG_CODIEREN, and the main window. The profile and the trace files stay.
   */
  function clearFields() {
    if (state.busy) return;
    Object.assign(state, {
      mode: 'main',
      chassis: '',
      fg: '',
      zcs: null,
      fa: '',
      saCodes: null,
      mod: null,
      job: 'SG_CODIEREN',
      read: null,
      msg: [],
    });
    setStatus('');
    paint();
  }
  function setMode(mode) {
    state.mode = mode;
    if (mode !== 'ecu') state.msg = [];
    paint();
  }
  const onKey = (e) => {
    if (!document.body.contains(win)) {
      document.removeEventListener('keydown', onKey);
      return;
    }
    const m = /^F([1-6])$/.exec(e.key);
    if (!m) return;
    e.preventDefault();
    const k = keys()[Number(m[1]) - 1];
    if (k && k[1] && k[2]) k[2]();
  };
  document.addEventListener('keydown', onKey);

  // ---- the menu --------------------------------------------------------------
  let openMenu = null;
  function closeMenu() {
    if (openMenu) openMenu.remove();
    openMenu = null;
  }
  // NCS Expert's menu bar (from NCSEXPER.exe MENU 2048/2): the profile, then
  // the trace and report views, all under File; Help; nothing else.
  function menus() {
    const idle = !state.busy;
    const SEP = ['-'];
    return [
      [
        'File',
        [
          ['Edit Profile...', idle, actions.editProfile],
          SEP,
          ['Edit FSW_PSW.MAN...', idle, actions.editMan],
          ['Import FSW_PSW.MAN...', idle, actions.importMan],
          ['Compare ECU with vehicle order...', idle, actions.compareOrder],
          SEP,
          ['ERROR.LOG', true, actions.showLog],
          ['CABD-Parameter', true, actions.showCabdPar],
          ['Systemdata', true, actions.showSystemdata],
          ['FSW-/PSW-Tracefile', true, actions.showTrc],
          ['Nettodata-Tracefile', true, actions.showNetto],
          SEP,
          ['Trace editor (English)...', idle, actions.traceEditor],
          SEP,
          ['Exit', idle, showApps],
        ],
      ],
      ['Help', [['About BMWeb Coding...', true, actions.about]]],
    ];
  }
  function paintMenu() {
    const bar = $('ncs-menubar');
    bar.innerHTML = '';
    for (const [name, items] of menus()) {
      const b = document.createElement('button');
      b.className = modern ? 'btn ncsm-menu' : 'wkfp-menu';
      // NCS's File menu holds the profile, the MAN file and the trace views
      b.textContent = modern
        ? name === 'File'
          ? 'Files & traces ▾'
          : `${name} ▾`
        : name;
      b.onclick = (e) => {
        e.stopPropagation();
        const wasMine = openMenu && openMenu.dataset.menu === name;
        closeMenu();
        if (wasMine) return;
        const drop = document.createElement('div');
        drop.className = 'wkfp-drop';
        drop.dataset.menu = name;
        for (const [label, on, fn] of items) {
          if (label === '-') {
            const hr = document.createElement('div');
            hr.className = 'wkfp-drop-sep';
            drop.appendChild(hr);
            continue;
          }
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

  paint();
}

if (typeof window !== 'undefined') {
  window.showNcsExpert = showNcsExpert;
}
