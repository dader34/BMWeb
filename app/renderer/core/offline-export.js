// Package what is loaded into a folder you can open with no server.
//
// The app is already static: the renderer plus a tree of .chassis archives,
// with webshim.js standing in for the API. So an offline copy is not a new
// build, it is the same files zipped -- which means the browser can do it
// with no help from us.
//
// SCOPED TO ONE CAR ON PURPOSE. The whole site is 203 MB and the fault
// database alone is 80 MB; zipping that in a tab means holding it all in
// memory and most machines will not. One chassis is 2 to 13 MB, which is the
// difference between "works" and "the tab dies".
//
// The result opens over file:// with no server, EXCEPT that a file:// page
// gets an opaque origin where fetch() is blocked. The README written into the
// zip says to serve it with one command instead of pretending otherwise.

// Files the renderer needs whatever car you picked.
const OFFLINE_SHELL = [
  'index.html', 'app.js', 'logo.svg',
  'css/styles.css', 'css/themes.css', 'css/lookup.css',
  'vendor/fflate.min.js',
  'core/webdemo.js', 'core/webshim.js', 'core/bestvm.js', 'core/vmbridge.js',
  'core/core.js', 'core/translate.js', 'core/nav.js',
  'screens/autoscan.js', 'screens/sweep.js', 'screens/fault-report.js',
  'screens/ir.js', 'screens/ecu.js', 'screens/flashing.js',
  'screens/activations.js', 'screens/syscheck.js', 'screens/coding.js',
  'screens/identity.js', 'screens/aif.js', 'screens/adaption.js',
  'screens/service.js', 'screens/special.js', 'screens/measurements.js',
  'screens/live.js', 'screens/faults.js', 'screens/lookup.js',
  'screens/tutorial.js',
];

// The fault tables. Lazy-loaded by the app and 80 MB together, so they are
// opt-in: without them fault CODES still read off the car, they just show
// without their English text.
const OFFLINE_FAULTS = [
  'data/faultdb.js', 'data/faultindex.js', 'data/pcodes.js',
  'data/faultmeta.js', 'data/faultinfo.js',
];

function offlineBase() {
  const p = location.pathname.replace(/\/[^/]*$/, '');
  return p.replace(/\/$/, '');
}

// FETCH THE FILE, NOT THE ROUTE. webshim.js installs over window.fetch and
// answers /api/... from inside the .chassis archives, so asking it for
// "api/chassis/E46.chassis" gets the shim's interpretation rather than the
// bytes on disk. Keep a reference to the real fetch from before the shim ran
// -- the shim stores it, so ask it for one.
const OFFLINE_FETCH = (typeof webRealFetch === 'function')
  ? webRealFetch : window.fetch.bind(window);

async function offlineGet(path) {
  const r = await OFFLINE_FETCH(`${offlineBase()}/${path}`);
  if (!r.ok) throw new Error(`missing ${path}`);
  return new Uint8Array(await r.arrayBuffer());
}

// Double-clickable launchers. The folder needs an HTTP server because a
// file:// page gets an opaque origin where fetch() is blocked, and asking
// someone to remember a python one-liner a year from now is how a working
// copy becomes an unopenable one.
//
// Both scripts do the same three things: find a runtime that can serve a
// directory, serve THIS folder on a free-ish port, and open a browser at it.
// They try python3, then python, then php, then node, so whichever the
// machine has is enough.
const OFFLINE_SH = `#!/bin/sh
# Run BMacW offline. Double-click this file.
#
# Serves this folder over HTTP and opens it. A browser will not let a page
# opened straight from disk read its own data files, which is why this needs
# a server at all.
set -e
cd "$(dirname "$0")"
PORT=8777

open_browser () {
  sleep 1
  if command -v open        >/dev/null 2>&1; then open "http://localhost:$PORT"
  elif command -v xdg-open  >/dev/null 2>&1; then xdg-open "http://localhost:$PORT"
  else echo "Open http://localhost:$PORT in your browser."
  fi
}

echo "BMacW offline  ->  http://localhost:$PORT"
echo "Press Ctrl-C to stop."
open_browser &

if   command -v python3 >/dev/null 2>&1; then exec python3 -m http.server "$PORT"
elif command -v python  >/dev/null 2>&1; then exec python  -m http.server "$PORT"
elif command -v php     >/dev/null 2>&1; then exec php -S "localhost:$PORT"
elif command -v npx     >/dev/null 2>&1; then exec npx --yes serve -l "$PORT" .
else
  echo "No python3, php or node found. Install any one of them, or serve"
  echo "this folder with any static web server and open it."
  exit 1
fi
`;

const OFFLINE_BAT = `@echo off
REM Run BMacW offline. Double-click this file.
REM
REM Serves this folder over HTTP and opens it. A browser will not let a page
REM opened straight from disk read its own data files, which is why this
REM needs a server at all.
setlocal
cd /d "%~dp0"
set PORT=8777

echo BMacW offline  -^>  http://localhost:%PORT%
echo Press Ctrl-C to stop.
start "" "http://localhost:%PORT%"

where python >nul 2>nul && (python -m http.server %PORT% & goto :eof)
where py     >nul 2>nul && (py -3 -m http.server %PORT% & goto :eof)
where php    >nul 2>nul && (php -S localhost:%PORT% & goto :eof)
where npx    >nul 2>nul && (npx --yes serve -l %PORT% . & goto :eof)

echo.
echo No Python, PHP or Node found. Install any one of them, or serve this
echo folder with any static web server and open it.
pause
`;

// README for the folder, so it is obvious how to open it a year from now.
function offlineReadme(chassis, withFaults) {
  return `BMacW offline copy - ${chassis}
${'='.repeat(24 + chassis.length)}

Everything needed to browse ${chassis} with no internet and no server
install: the app itself, ${chassis}'s ECU data, and the BEST2 VM that
decodes it.

RUNNING IT

  macOS      double-click "Run BMacW.command"
  Windows    double-click run-windows.bat
  Linux      sh run-linux.sh

Those serve this folder and open a browser at it. A browser will not let a
page opened straight from disk (file://) read its own data files, which is
why a server is involved at all; the scripts use whatever they find of
python3, python, php or node.

By hand, if you prefer:

    python3 -m http.server 8777

then open http://localhost:8777 .

WHAT WORKS OFFLINE

  reading screens, jobs, tables and coding data for ${chassis}
  the demo mode, which fills screens with plausible values
${withFaults ? '  fault code lookup with full English descriptions\n' : '  fault codes read off a car (their English text is NOT included)\n'}
WHAT NEEDS A CABLE

Running a job against a real ECU needs a K+DCAN cable and a browser with
Web Serial (desktop Chrome or Edge). Nothing here talks to a car by itself.

Other chassis are not included. Export them separately from Settings.
`;
}

// Build the zip. onProgress(text) is called as it goes; the whole thing runs
// in the tab, so the caller should keep the UI responsive.
async function offlineExport(chassis, withFaults, onProgress) {
  if (typeof fflate === 'undefined') {
    throw new Error('fflate is not loaded');
  }
  const files = {};

  const say = (t) => { if (onProgress) onProgress(t); };

  say('collecting the app');
  for (const f of OFFLINE_SHELL) {
    files[f] = await offlineGet(f);
  }

  // "*" means every car: read the real list and take them all. This is the
  // whole site in one Blob, so it is offered but not the default.
  let ids;
  if (chassis === '*') {
    const r = await OFFLINE_FETCH(`${offlineBase()}/api/chassis.json`);
    ids = await r.json();
  } else {
    ids = [chassis];
  }
  files['api/chassis.json'] = new TextEncoder().encode(JSON.stringify(ids));
  for (const id of ids) {
    say(`collecting ${id}`);
    files[`api/chassis/${id}.chassis`] =
      await offlineGet(`api/chassis/${id}.chassis`);
  }
  // the shim reads this to find which car owns an SGBD
  try {
    files['api/ecu-index.json'] = await offlineGet('api/ecu-index.json');
  } catch { /* optional: only used for a cross-chassis lookup */ }

  if (withFaults) {
    for (const f of OFFLINE_FAULTS) {
      say(`collecting ${f.split('/').pop()}`);
      try { files[f] = await offlineGet(f); }
      catch { /* a fault table that was never built is not fatal */ }
    }
  }

  const enc = new TextEncoder();
  files['README.txt'] = enc.encode(
    offlineReadme(chassis === '*' ? ids.join(', ') : chassis, withFaults));
  // DOUBLE-CLICKABLE ON MACOS. Finder always opens a .command in Terminal,
  // where a .sh may go to an editor depending on what the user has set, and
  // 0o755 in the high half of the external attributes means it arrives
  // runnable rather than needing chmod.
  //
  // EXACTLY ONE ENTRY GETS attrs. This fflate build mishandles more than
  // one: with two tuples the second is dropped and its bit reappears on
  // whatever entry happens to be last. With a single tuple the bit lands
  // correctly wherever the entry sits, and the stray copy falls on the .bat,
  // which is harmless because Windows ignores POSIX modes.
  //
  // Linux therefore gets the same script without the bit. Its file managers
  // mostly refuse to run a downloaded script on double-click anyway, so the
  // README tells Linux users to run it, which is what they would do.
  files['Run BMacW.command'] = [enc.encode(OFFLINE_SH), { attrs: 0o755 << 16 }];
  files['run-linux.sh'] = enc.encode(OFFLINE_SH);
  files['run-windows.bat'] = enc.encode(OFFLINE_BAT);

  say('compressing');
  // level 0 on the .chassis entry: it is already a zip of deflated members,
  // and recompressing it costs time for nothing.
  const opts = { level: 6 };
  const zipped = fflate.zipSync(files, opts);

  say('saving');
  const name = `bmacw-${chassis === '*' ? 'all' : chassis.toLowerCase()}`
    + '-offline.zip';

  // ASK WHERE, when the host can. In the macOS app a browser download lands
  // wherever WKWebView decides, which is neither visible nor chosen; the
  // shell opens a real Save panel instead. On the web there is no such thing,
  // so fall back to the download the browser does know how to do.
  if (window.bmacw && typeof window.bmacw.saveFile === 'function') {
    const r = await window.bmacw.saveFile(name, zipped);
    if (r && r.cancelled) throw new Error('cancelled');
    return zipped.length;
  }

  const blob = new Blob([zipped], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return zipped.length;
}

if (typeof window !== 'undefined') {
  window.offlineExport = offlineExport;
}
