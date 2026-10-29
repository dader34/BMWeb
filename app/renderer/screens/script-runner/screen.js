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

/** The script this screen currently holds, or null. */
let _scriptRunnerLoaded = null;

/**
 * Where the files the user gave are kept for this tab: sessionStorage, so a
 * reload (or the layout switch's redraw) brings the script back -- running,
 * if it was -- and closing the tab forgets it. Never sent anywhere.
 */
const SR_KEEP = 'bmweb.scriptRunner';

/**
 * Keep the given files for this tab (base64, with their names).
 * @param {File[]} files
 * @returns {Promise<void>}
 */
async function scriptRunnerKeep(files) {
  try {
    const list = [];
    for (const f of Array.from(files || [])) {
      const b = new Uint8Array(await f.arrayBuffer());
      let bin = '';
      for (let i = 0; i < b.length; i += 0x8000)
        bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
      list.push({ name: f.name, b64: btoa(bin) });
    }
    sessionStorage.setItem(
      SR_KEEP,
      JSON.stringify({ files: list, running: false })
    );
  } catch (e) {
    // storage blocked or full: the script just will not survive a reload
  }
}

/** @returns {{files: {name: string, b64: string}[], running: boolean}|null} */
function scriptRunnerKept() {
  try {
    return JSON.parse(sessionStorage.getItem(SR_KEEP) || 'null');
  } catch (e) {
    return null;
  }
}

/**
 * Note whether the kept script is running, so a reload starts it again.
 * @param {boolean} on
 * @returns {void}
 */
function scriptRunnerKeepRunning(on) {
  const k = scriptRunnerKept();
  if (!k) return;
  k.running = on;
  try {
    sessionStorage.setItem(SR_KEEP, JSON.stringify(k));
  } catch (e) {
    // as above
  }
}

/**
 * After a reload: load the kept files again and, when the script was
 * running, start it again (as a shipped module's deep link does).
 * @returns {Promise<void>}
 */
async function scriptRunnerRestore() {
  const k = scriptRunnerKept();
  if (!k || !Array.isArray(k.files) || !k.files.length) return;
  const files = k.files.map(
    (f) =>
      new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name)
  );
  await scriptRunnerLoad(files, false);
  const loaded = _scriptRunnerLoaded;
  if (!k.running || !loaded || lastScreen !== showScriptRunner) return;
  await scriptRunnerTarget(loaded);
  if (lastScreen === showScriptRunner) scriptRunnerRun(loaded);
}

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
  const input = `<input type="file" id="sr-input" multiple hidden
             accept=".ipo,.IPO,.ips,.IPS,.src,.SRC,.h,.H" />`;
  // Two looks over one flow (the ids are the contract): the INPA-style layout
  // draws a Windows tool -- a file field, group boxes, a status bar -- and the
  // modern one a drop card over a summary and the Run card.
  view.innerHTML = inpaMode()
    ? `<div class="t32-win sr-win" id="sr-win">
      <div class="t32-titlebar">Script runner</div>
      <div class="sr-win-body">
        <fieldset class="sr-win-group" id="sr-drop" tabindex="0"
                  role="button" aria-label="Choose an INPA script">
          <legend>Script file</legend>
          <div class="sr-win-file">
            <span class="sr-win-field" id="sr-loaded">(no script loaded)</span>
            <button class="sr-win-btn" id="sr-pick" type="button">Open...</button>
          </div>
          <div class="sr-win-hint">A compiled .IPO, or a .IPS / .SRC source with the .h and .SRC
            files it includes. Drop them anywhere on this window; nothing is uploaded, and only this tab keeps them.</div>
        </fieldset>
        ${input}
        <div class="sr-win-results">
          <div id="sr-report"></div>
          <div id="sr-run"></div>
        </div>
      </div>
      <div class="sr-win-status"><span id="sr-status">Ready</span></div>
    </div>`
    : head(
        'INPA',
        'Script runner',
        'Run an INPA script against the car: a compiled .IPO, or a .IPS / .SRC source compiled here.'
      ) +
      `<div class="sr-modern">
      <div class="sr-mdrop" id="sr-drop" tabindex="0" role="button"
           aria-label="Choose an INPA script">
        <div class="sr-mdrop-icon" aria-hidden="true">⇪</div>
        <div class="sr-mdrop-text">
          <div class="sr-mdrop-title">Drop an INPA script here</div>
          <div class="sr-mdrop-sub">
            <span class="sr-chip">.IPO</span> compiled, or
            <span class="sr-chip">.IPS</span><span class="sr-chip">.SRC</span> source with its
            <span class="sr-chip">.h</span> includes. Nothing is uploaded; only this tab keeps them.
          </div>
          <div class="sr-loaded-line" id="sr-loaded" hidden></div>
        </div>
        <button class="btn primary" id="sr-pick" type="button">Choose files</button>
      </div>
      ${input}
      <div class="sr-mgrid">
        <div id="sr-report"></div>
        <div id="sr-run"></div>
      </div>
    </div>`;
  scriptRunnerWire();
  scriptRunnerActions();
  if (_scriptRunnerLoaded) scriptRunnerRender(_scriptRunnerLoaded);
  else scriptRunnerRestore();
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
  const input = document.getElementById('sr-input');
  // the file area opens the picker; a drop lands anywhere on the classic
  // window, as on a Windows tool, or on the modern drop card
  const area = document.getElementById('sr-drop');
  const drop = document.getElementById('sr-win') || area;
  if (!area || !drop || !input) return;
  const open = () => input.click();
  document.getElementById('sr-pick').addEventListener('click', (e) => {
    e.stopPropagation();
    open();
  });
  area.addEventListener('click', open);
  area.addEventListener('keydown', (e) => {
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
 * @param {boolean} [keep=true] Keep them for this tab (false: they came
 *   from what was kept).
 * @returns {Promise<void>}
 */
async function scriptRunnerLoad(files, keep = true) {
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
  if (keep) await scriptRunnerKeep(files);
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
 * The classic window's status line; the modern layout has none.
 * @param {string} text
 * @returns {void}
 */
function scriptRunnerStatus(text) {
  const s = document.getElementById('sr-status');
  if (s) s.textContent = text || 'Ready';
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
    scriptRunnerStatus(
      `${loaded.name}: ${b.errors.length} problem${b.errors.length === 1 ? '' : 's'}`
    );
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
  if (inv.menus.length) rows.push(kv('Menus', inv.menus.join(', ')));
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
  scriptRunnerStatus(
    `${loaded.name}: ${b.kind === 'compiled' ? 'compiled .IPO' : 'source, compiled here'}`
  );

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
    `<div class="sr-run-row"><span class="kv-v" id="sr-target">Choosing the module…</span>` +
    `<button class="btn primary" id="sr-go" type="button">Run this script</button></div>` +
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
  // the running script is the screen: the layout switch and a reload open
  // it again instead of dropping back to the file page
  lastScreen = () => scriptRunnerRun(loaded);
  scriptRunnerKeepRunning(true);
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
  const back = () => {
    scriptRunnerKeepRunning(false);
    showScriptRunner();
  };
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
