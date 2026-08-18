// IPO Lab: drop any INPA .IPO script and run its decompiled screens live.
//
// The decompiler is NOT reimplemented here -- that pipeline (ipo_screens /
// ipo_disasm / ipo_ir) took months of correlation work and a JS port would
// drift. Instead the REAL Python sources ship as assets (data/ipolab/, a
// synced copy checked by tools/check.sh) and run in Pyodide (CPython on
// WASM) inside the page. The resulting IR is handed to the same interpreter
// (screens/ir.js) that renders every shipped ECU, so an uploaded screen
// behaves exactly like a built-in one -- including running its jobs, when
// the SGBD it names exists in this build.
//
// Pyodide (~7 MB) loads lazily from the CDN on first use and caches; the
// single-file/offline build shows a clear "needs network once" note instead.

const IPOLAB_PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js';
const IPOLAB_SOURCES = ['ipo_screens.py', 'ipo_disasm.py', 'ipo_ir.py'];

let _pyodideP = null;   // one runtime per session; each decompile reuses it

function ipoLabRuntime(onStatus) {
  if (_pyodideP) return _pyodideP;
  _pyodideP = (async () => {
    onStatus('Loading Python runtime (first use only)…');
    if (!window.loadPyodide) {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = IPOLAB_PYODIDE;
        s.onload = res;
        s.onerror = () => rej(new Error(
          'Could not load the Python runtime. The IPO Lab needs the network '
          + 'once to fetch it (~7 MB); after that it is cached.'));
        document.head.appendChild(s);
      });
    }
    const py = await window.loadPyodide();
    onStatus('Loading the decompiler…');
    py.FS.mkdirTree('/lab');
    for (const name of IPOLAB_SOURCES) {
      const r = await fetch(`data/ipolab/${name}`);
      if (!r.ok) throw new Error(`missing decompiler source ${name}`);
      py.FS.writeFile(`/lab/${name}`, await r.text());
    }
    py.runPython(`
import sys, json
sys.path.insert(0, '/lab')
import ipo_screens, ipo_disasm, ipo_ir
# the pipeline resolves ECU names against INPA's SGDAT tree; the lab has
# exactly one file, so every lookup answers with the upload
ipo_screens.ipo_path = lambda ecu: '/lab/upload.ipo'

def lab_decompile(name):
    ir = ipo_ir.build(name)
    return json.dumps(ir) if ir else ''
`);
    return py;
  })();
  _pyodideP.catch(() => { _pyodideP = null; });   // failed load can retry
  return _pyodideP;
}

async function ipoLabDecompile(file, onStatus) {
  const py = await ipoLabRuntime(onStatus);
  onStatus(`Decompiling ${file.name}…`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  py.FS.writeFile('/lab/upload.ipo', bytes);
  const stem = file.name.replace(/\.ipo$/i, '');
  const out = py.globals.get('lab_decompile')(stem);
  if (!out) {
    throw new Error('This file has no screen definitions to decompile. '
      + 'Roughly 200 of BMW’s own .IPOs (activation scripts, A_* helpers) '
      + 'carry code but draw no screens — INPA shows them nothing either.');
  }
  return JSON.parse(out);
}

async function showIpoLab() {
  lastScreen = showIpoLab;
  setCrumbs([{ label: 'Vehicles', fn: showChassis },
             { label: 'Apps', fn: showApps }, { label: 'IPO Lab' }]);
  document.body.classList.add('apps-section');
  sbLeft.textContent = 'ipo lab';
  view.innerHTML = head('IPO', 'IPO Lab',
    'Drop an INPA .IPO script and run its decompiled screens, live.');
  setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
                fn: showApps }]);

  const card = document.createElement('div');
  card.className = 'ipolab-drop';
  card.innerHTML = `
    <div class="ipolab-drop-icon">⇪</div>
    <div class="ipolab-drop-title">Drop an .IPO file here</div>
    <div class="ipolab-drop-hint">or tap to choose one. The decompiler runs
      entirely in this page — the file never leaves your machine. If the
      script’s SGBD is in this build, its readouts and functions run for
      real over the cable.</div>
    <input type="file" accept=".ipo,.IPO" hidden>`;
  view.appendChild(card);
  const input = card.querySelector('input');
  const status = document.createElement('div');
  status.className = 'ipolab-status';
  status.hidden = true;
  view.appendChild(status);

  const say = (t) => { status.hidden = !t; status.textContent = t || ''; };

  const accept = async (file) => {
    if (!file) return;
    card.classList.remove('ipolab-drag');
    try {
      const ir = await ipoLabDecompile(file, say);
      say('');
      renderIpoLabResult(file, ir);
    } catch (e) {
      say('');
      const err = document.createElement('div');
      err.innerHTML = errorBlock(String(e.message || e));
      view.appendChild(err);
    }
  };

  card.onclick = () => input.click();
  input.onchange = () => accept(input.files[0]);
  card.ondragover = (e) => { e.preventDefault(); card.classList.add('ipolab-drag'); };
  card.ondragleave = () => card.classList.remove('ipolab-drag');
  card.ondrop = (e) => { e.preventDefault(); accept(e.dataTransfer.files[0]); };
}

// BMW names .IPOs after the ECU, not the SGBD (MS450_N.ipo runs ms450ds0),
// so bind the upload to a runnable SGBD by probing this build's job index:
// exact stem, stem minus the variant suffix (_N, _SP2), and the dsN forms.
async function ipoLabResolveSgbd(stem) {
  const s = stem.toLowerCase();
  const base = s.replace(/_(n|sp\d*|d|e\d*)$/, '');
  const cands = [s, `${s}ds0`, base, `${base}ds0`, `${base}ds1`];
  try {
    const list = new Set((await tool32SgbdList()).map(x => String(x).toLowerCase()));
    for (const c of cands) if (list.has(c)) return c;
  } catch { /* no job index in this build */ }
  return null;
}

// The decompiled screen, driven by the SAME interpreter as the shipped ECUs.
async function renderIpoLabResult(file, ir) {
  const stem = file.name.replace(/\.ipo$/i, '');
  const sgbd = await ipoLabResolveSgbd(stem);
  view.innerHTML = head('IPO', stem,
    `Decompiled live from ${file.name} · ${Object.keys(ir.screens || {}).length}`
    + ` screens, ${Object.keys(ir.menus || {}).length} menus`
    + (ir.language ? ` · ${ir.language}` : '')
    + (sgbd ? ` · jobs run against ${sgbd}`
            : ' · SGBD not in this build, readouts stay blank'));
  setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
                fn: showIpoLab }]);
  sbLeft.textContent = stem.toLowerCase();

  const grid = document.createElement('div');
  grid.className = inpaMode() ? 'inpa-haupt' : 'group-grid stagger';
  view.appendChild(grid);

  const ecu = { sgbd: sgbd || stem.toLowerCase(), code: 'ipolab', label: stem };
  const root = irRootMenu(ir, null);
  if (!root) {
    grid.innerHTML = errorBlock('Decompiled, but the script declares no root '
      + 'menu — nothing for INPA (or the lab) to draw.');
    return;
  }
  renderIrMenu(ecu, ir, root, grid, showIpoLab);
}
