/**
 * @file The Script runner app: drop an INPA script, read what it is, run it.
 *
 * The script the user supplies runs through the SAME path a shipped one does
 * -- it is decoded (or compiled) into the runtime's own exec shape, seeded
 * under the SGBD the script itself names, and opened by ipoProgramOpen. Every
 * confirmation and write gate the module view applies applies here unchanged,
 * because it is the module view: nothing about a file's origin relaxes what
 * the app will put on the wire.
 */

/** The script this screen currently holds, or null. Session only, never stored. */
let _scriptRunnerLoaded = null;

/**
 * Open the Script runner.
 * @returns {void}
 */
function showScriptRunner() {
  lastScreen = showScriptRunner;
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: 'Apps', fn: showApps },
    { label: 'Script runner' },
  ]);
  document.body.classList.add('apps-section');
  sbLeft.textContent = 'script runner';
  view.innerHTML =
    head(
      'INPA',
      'Script runner',
      'Run an INPA script against the car: a compiled .IPO, or a .IPS / .SRC source compiled here.'
    ) +
    `<div class="etk-idcard sr-card">
      <div class="sr-drop empty" id="sr-drop" tabindex="0" role="button"
           aria-label="Choose an INPA script">
        <div class="empty-big">Drop an INPA script</div>
        <div>A compiled <code>.IPO</code>, or a <code>.IPS</code> / <code>.SRC</code> source with the
             <code>.h</code> and <code>.SRC</code> files it includes. Nothing is uploaded or kept.</div>
        <button class="btn primary" id="sr-pick" type="button">Choose files</button>
        <div class="sr-loaded-line" id="sr-loaded" hidden></div>
      </div>
      <input type="file" id="sr-input" multiple hidden
             accept=".ipo,.IPO,.ips,.IPS,.src,.SRC,.h,.H" />
      <div class="results-panel" id="sr-report"></div>
      <div id="sr-run"></div>
    </div>`;
  scriptRunnerWire();
  scriptRunnerActions();
  if (_scriptRunnerLoaded) scriptRunnerRender(_scriptRunnerLoaded);
}

/**
 * The F-key bar for the app's own screens.
 * @param {Array<Object>} [extra] Keys to offer before Back.
 * @returns {void}
 */
function scriptRunnerActions(extra) {
  setActions([
    ...(extra || []),
    {
      key: 'p',
      label: 'Print',
      kind: 'print',
      fn: () => (typeof window.print === 'function' ? window.print() : null),
    },
    {
      key: 'Escape',
      keyLabel: 'Esc',
      label: 'Back',
      kind: 'back',
      fn: () => showApps(),
    },
  ]);
}

/**
 * Wire the drop zone and the file picker.
 * @returns {void}
 */
function scriptRunnerWire() {
  const drop = document.getElementById('sr-drop');
  const input = document.getElementById('sr-input');
  if (!drop || !input) return;
  const open = () => input.click();
  document.getElementById('sr-pick').addEventListener('click', (e) => {
    e.stopPropagation();
    open();
  });
  drop.addEventListener('click', open);
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });
  input.addEventListener('change', () => {
    if (input.files && input.files.length) scriptRunnerLoad(input.files);
  });
  for (const ev of ['dragenter', 'dragover']) {
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add('is-over');
    });
  }
  for (const ev of ['dragleave', 'drop']) {
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.remove('is-over');
    });
  }
  drop.addEventListener('drop', (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) scriptRunnerLoad(files);
  });
}

/**
 * Read, decode or compile the dropped files and show what they are.
 * @param {FileList} files The dropped or picked files.
 * @returns {Promise<void>}
 */
async function scriptRunnerLoad(files) {
  const report = document.getElementById('sr-report');
  const runner = document.getElementById('sr-run');
  if (runner) runner.innerHTML = '';
  if (report) report.innerHTML = '<div class="result-card">Reading…</div>';
  let read;
  try {
    read = await scriptRunnerRead(files);
  } catch (e) {
    if (report)
      report.innerHTML = errorBlock(
        `could not read the files: ${e && e.message}`
      );
    return;
  }
  if (!read.script) {
    if (report) {
      report.innerHTML = errorBlock(
        'no script among those files -- one of them has to be a .IPO, .IPS or .SRC'
      );
    }
    return;
  }
  const built = scriptRunnerBuild(read.script, read.includes);
  const loaded = {
    name: read.script.name,
    stem: ipofStem(read.script.name),
    dropped: Object.keys(read.includes),
    ignored: read.ignored,
    built,
  };
  _scriptRunnerLoaded = loaded;
  scriptRunnerRender(loaded);
}

/**
 * Draw the parse report and, when the script is runnable, the Run button.
 * @param {Object} loaded The loaded script and its build result.
 * @returns {void}
 */
function scriptRunnerRender(loaded) {
  // the drop zone shrinks to one line once a script is in: the report and
  // the Run card take the page, and a new drop or Choose still works on it
  const drop = document.getElementById('sr-drop');
  const line = document.getElementById('sr-loaded');
  if (drop && line) {
    drop.classList.add('sr-loaded');
    line.hidden = false;
    line.innerHTML =
      `<span class="sr-loaded-name">${esc(loaded.name)}</span>` +
      `<span class="sr-loaded-hint">Drop or choose another script to replace it</span>`;
  }
  const report = document.getElementById('sr-report');
  if (!report) return;
  const b = loaded.built;
  const rows = [];
  const kv = (k, v) =>
    `<div class="kv"><span class="kv-k">${esc(k)}</span>` +
    `<span class="kv-v">${esc(v)}</span></div>`;
  rows.push(kv('File', loaded.name));
  rows.push(
    kv(
      'Form',
      b.kind === 'compiled' ? 'compiled .IPO' : 'source, compiled here'
    )
  );
  if (b.includes && b.includes.length)
    rows.push(kv('Includes', b.includes.join(', ')));
  if (loaded.dropped.length)
    rows.push(kv('Dropped alongside', loaded.dropped.join(', ')));
  if (loaded.ignored.length)
    rows.push(kv('Ignored', loaded.ignored.join(', ')));

  if (!b.ok) {
    const lines = b.errors
      .map(
        (e) =>
          `<div class="kv"><span class="kv-k">${e.line ? `line ${e.line}` : 'error'}</span>` +
          `<span class="kv-v">${esc(e.text || e.message)}</span></div>`
      )
      .join('');
    report.innerHTML =
      `<div class="result-card"><div class="result-head">Script</div>${rows.join('')}</div>` +
      `<div class="result-card sr-bad"><div class="result-head">` +
      `${b.errors.length} problem${b.errors.length === 1 ? '' : 's'}</div>${lines}</div>` +
      (b.missing && b.missing.length
        ? `<div class="result-card"><div class="result-head">What is missing</div>` +
          `<div class="kv"><span class="kv-v">Drop ${esc(b.missing.join(', '))} in with the ` +
          `script. These are BMW's own files and are not part of this app.</span></div></div>`
        : '');
    const run = document.getElementById('sr-run');
    if (run) run.innerHTML = '';
    scriptRunnerActions();
    return;
  }

  const exec = b.exec;
  const inv = ipofInventory(exec);
  const entry = exec.procs.inpainit
    ? 'inpainit'
    : exec.procs.SgbdInpaCheck
      ? 'SgbdInpaCheck'
      : null;
  rows.push(kv('Procedures', String(Object.keys(exec.procs).length)));
  rows.push(kv('Menus', inv.menus.length ? inv.menus.join(', ') : 'none'));
  rows.push(kv('Screens', String(inv.screens.length)));
  if (inv.machines.length)
    rows.push(kv('State machines', String(inv.machines.length)));
  if (exec.imports && Object.keys(exec.imports).length) {
    rows.push(kv('DLL imports', Object.values(exec.imports).join(', ')));
  }
  rows.push(
    kv('Entry', entry || 'none -- this script has no INPA entry point')
  );
  if (exec.coding) {
    rows.push(
      kv('Dialect', 'an NCS coding dispatcher, not a diagnostic script')
    );
  }

  report.innerHTML = `<div class="result-card"><div class="result-head">Script</div>${rows.join('')}</div>`;

  const run = document.getElementById('sr-run');
  if (!run) return;
  if (!entry || exec.coding) {
    run.innerHTML =
      `<div class="result-card"><div class="result-head">Not runnable</div>` +
      `<div class="kv"><span class="kv-v">${
        exec.coding
          ? 'This is a coding dispatcher. It reads correctly, but it drives the coding host, not a diagnostic session.'
          : 'INPA starts a script at inpainit or SgbdInpaCheck. This file declares neither, so there is nothing to start.'
      }</span></div></div>`;
    scriptRunnerActions();
    return;
  }
  run.innerHTML =
    `<div class="result-card"><div class="result-head">Run</div>` +
    `<div class="kv"><span class="kv-v" id="sr-target">Choosing the module…</span></div>` +
    `<div style="margin-top:12px"><button class="btn primary" id="sr-go" type="button">Run this script</button></div>` +
    '</div>';
  scriptRunnerTarget(loaded);
}

/**
 * Work out which module the script drives and offer to run it.
 * @param {Object} loaded The loaded script.
 * @returns {Promise<void>}
 */
async function scriptRunnerTarget(loaded) {
  const line = document.getElementById('sr-target');
  const go = document.getElementById('sr-go');
  let target;
  try {
    target = await scriptRunnerSgbd(loaded.built.exec, loaded.stem);
  } catch (e) {
    target = {
      sgbd: loaded.stem.toLowerCase(),
      how: "the script's own name",
      choices: [],
    };
  }
  loaded.target = target;
  if (line) {
    line.textContent =
      `Jobs go to ${target.sgbd.toUpperCase()}: ${target.how}` +
      (target.choices.length > 1
        ? ` (of ${target.choices.length} it names)`
        : '');
  }
  if (go) go.addEventListener('click', () => scriptRunnerRun(loaded));
  scriptRunnerActions([
    { key: '1', label: 'Run', fn: () => scriptRunnerRun(loaded) },
  ]);
}

/**
 * Hand the script to the live runtime.
 *
 * The exec is seeded under the SGBD the script named, then opened exactly as a
 * shipped module is: the runtime fetches it from the cache, applies its own
 * confirmations and write gates, and talks to the car through the same shim.
 *
 * @param {Object} loaded The loaded script.
 * @returns {Promise<void>}
 */
async function scriptRunnerRun(loaded) {
  const target = loaded.target || { sgbd: loaded.stem.toLowerCase() };
  const sgbd = target.sgbd;
  if (
    typeof irSeedExec !== 'function' ||
    typeof ipoProgramOpen !== 'function'
  ) {
    const run = document.getElementById('sr-run');
    if (run) run.innerHTML = errorBlock('the live script runtime did not load');
    return;
  }
  irSeedExec(sgbd, loaded.built.exec);
  const ecu = {
    sgbd,
    code: loaded.stem.toUpperCase(),
    label: `${loaded.name} (supplied script)`,
    _variant: sgbd.toUpperCase(),
    // no chassis: this screen is not a car's module, and setting one would
    // send the runtime's own routing to the vehicle view
  };
  view.innerHTML =
    '<div class="etk-idcard sr-card"><div class="results-panel" id="sr-host"></div></div>';
  const host = document.getElementById('sr-host');
  const back = () => showScriptRunner();
  sbLeft.textContent = `${sgbd}.prg · starting`;
  let opened;
  try {
    opened = await ipoProgramOpen(ecu, host, back);
  } catch (e) {
    opened = false;
    if (host)
      host.innerHTML = errorBlock(`the script stopped: ${e && e.message}`);
  }
  if (!opened && host && !host.innerHTML) {
    host.innerHTML = errorBlock(
      `${sgbd} did not start -- the runtime would not take this script`
    );
  }
  if (!opened) {
    setActions([
      {
        key: 'Escape',
        keyLabel: 'Esc',
        label: 'Back',
        kind: 'back',
        fn: back,
      },
    ]);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    showScriptRunner,
    scriptRunnerLoad,
    scriptRunnerRender,
    scriptRunnerRun,
  };
}
