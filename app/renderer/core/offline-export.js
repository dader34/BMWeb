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
  'index.html', 'app.js', 'logo.svg', 'thor_bridge.js',
  'css/styles.css', 'css/themes.css', 'css/lookup.css',
  'vendor/fflate.min.js',
  'core/webdemo.js', 'core/webshim.js', 'core/bestvm.js',
  'core/core.js', 'core/translate.js', 'core/nav.js',
  'screens/autoscan.js', 'screens/sweep.js', 'screens/fault-report.js',
  'screens/ir.js', 'screens/ecu.js', 'screens/flashing.js',
  'screens/activations.js', 'screens/syscheck.js', 'screens/coding.js',
  'screens/identity.js', 'screens/aif.js', 'screens/adaption.js',
  'screens/service.js', 'screens/special.js', 'screens/measurements.js',
  'screens/live.js', 'screens/faults.js', 'screens/lookup.js',
  'screens/tutorial.js', 'screens/wiring.js',
];

// The fault tables. Lazy-loaded by the app and 80 MB together, so they are
// opt-in: without them fault CODES still read off the car, they just show
// without their English text.
const OFFLINE_FAULTS = [
  'data/faultdb.js', 'data/faultindex.js', 'data/pcodes.js',
  'data/faultmeta.js', 'data/faultinfo.js',
];

// Starts the relay the THOR needs, from a double-click.
//
// TWO THINGS MACOS DOES TO A DOWNLOADED SCRIPT, both of which this survives:
//
// 1. Archive Utility DROPS THE EXECUTABLE BIT when it expands a zip on a
//    double-click, whatever the archive said. So the bit we set is a bonus,
//    not the plan: the folder also ships an .html page whose one job is to
//    show the "sh" one-liner, and the README leads with it. A launcher that
//    only works when the bit survives is a launcher that mostly does not.
//
// 2. Finder runs a .command from the user's HOME, not from where the file
//    lives, so this cd's to its own directory before looking for the bridge.
const THOR_LAUNCHER = `#!/bin/bash
# Double-click this to connect the THOR WiFi adapter.
#
# A browser cannot open the raw TCP socket the adapter uses, so this relays
# it over a local WebSocket the page can reach. Leave the window open while
# you use the adapter; close it when you are done.
cd "$(dirname "$0")"
# Put the bit back for next time. Archive Utility drops it on extraction, so
# the first run comes through "sh" and every run after is a double-click.
chmod +x "$0" 2>/dev/null
if ! command -v node >/dev/null 2>&1; then
  echo "node is not installed. Get it from https://nodejs.org and try again."
  echo
  read -n 1 -s -r -p "Press any key to close."
  exit 1
fi
echo "Starting the THOR bridge. Keep this window open."
echo "In the app: Settings > Adapter > THOR (WiFi), then click the cable chip."
echo
node thor_bridge.js
echo
read -n 1 -s -r -p "The bridge stopped. Press any key to close."
`;

// The page that gets someone past the one obstacle macOS puts in the way.
// Opened from Finder like index.html, so it needs no permissions of its own,
// and it carries a copy button rather than asking anyone to retype a path.
const THOR_LAUNCHER_HELP = `<!doctype html>
<meta charset="utf-8"><title>Start the THOR bridge</title>
<style>
  body { font: 15px/1.6 -apple-system, Segoe UI, sans-serif; color: #111;
         background: #fff; max-width: 44rem; margin: 8vh auto; padding: 0 6vw; }
  h1 { font-size: 21px; margin: 0 0 4px; }
  p.lead { color: #555; margin: 0 0 26px; }
  ol { padding-left: 20px; } li { margin-bottom: 14px; }
  code { font: 13px/1.5 ui-monospace, Menlo, monospace; background: #f2f3f5;
         border: 1px solid #e0e2e6; border-radius: 5px; padding: 2px 6px; }
  .cmd { display: flex; gap: 8px; align-items: center; margin: 10px 0 0; }
  .cmd code { flex: 1; padding: 10px 12px; overflow-x: auto; white-space: nowrap; }
  button { font: 600 13px -apple-system, sans-serif; cursor: pointer;
           background: #111; color: #fff; border: 0; border-radius: 5px;
           padding: 10px 14px; }
  .note { color: #666; font-size: 13.5px; border-top: 1px solid #e5e7ea;
          margin-top: 30px; padding-top: 16px; }
</style>
<h1>Start the THOR bridge</h1>
<p class="lead">The adapter speaks TCP and a browser cannot open a TCP socket,
so a small relay carries it. It needs
<a href="https://nodejs.org">node</a> installed.</p>
<ol>
  <li>Plug the THOR into the car and join its <code>Thor_Wifi</code> network.</li>
  <li>Double-click <code>Start THOR bridge.command</code> in this folder.
    <p style="margin:8px 0 0;color:#555">If macOS says it "could not be executed
    because you do not have appropriate access privileges", that is macOS
    dropping the executable flag when it unzipped the folder. Open Terminal
    and paste this once. Every double-click after it works.</p>
    <div class="cmd">
      <code id="c">sh "$PWD_PLACEHOLDER/Start THOR bridge.command"</code>
      <button onclick="copyCmd()">Copy</button>
    </div>
  </li>
  <li>Leave that window open, then open <code>index.html</code> and set
      <b>Settings &rsaquo; Adapter</b> to <b>THOR (WiFi)</b>.</li>
  <li>Click the cable chip in the top bar to connect.</li>
</ol>
<p class="note">Battery voltage, ignition state and the adapter's identity read
out today. Running diagnostic jobs over the THOR is still being wired up.</p>
<script>
  // the folder's real path, as the browser sees it: turns the instruction
  // into something that can be pasted rather than reconstructed by hand
  var dir = decodeURIComponent(location.pathname.replace(/\\/[^/]*$/, ''));
  var cmd = 'sh ' + JSON.stringify(dir + '/Start THOR bridge.command');
  document.getElementById('c').textContent = cmd;
  function copyCmd() {
    navigator.clipboard.writeText(cmd).then(function () {
      var b = document.querySelector('button');
      b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy'; }, 2000);
    });
  }
</script>
`;

const THOR_LAUNCHER_BAT = `@echo off
rem Double-click this to connect the THOR WiFi adapter.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo node is not installed. Get it from https://nodejs.org and try again.
  pause
  exit /b 1
)
echo Starting the THOR bridge. Keep this window open.
echo In the app: Settings ^> Adapter ^> THOR (WiFi), then click the cable chip.
echo.
node thor_bridge.js
pause
`;

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

// README for the folder, so it is obvious how to open it a year from now.
// Always branded BMWeb: the copy runs in a browser no matter who exported it.
function offlineReadme(chassis, withFaults, withWiring) {
  return `BMWeb offline copy - ${chassis}
${'='.repeat(21 + chassis.length)}

Everything needed to browse ${chassis} with no internet and no server
install: the app itself, ${chassis}'s ECU data, and the BEST2 VM that
decodes it.

RUNNING IT

Open index.html. That is the whole procedure: double-click it, or drag it
into a browser. No server, no install, no launcher script.

Everything this folder needs is inside it, and the ECU data is embedded in
data/inline.js rather than loaded as separate files, which is what lets a
page opened straight from disk read it at all.

WHAT WORKS OFFLINE

  reading screens, jobs, tables and coding data for ${chassis}
${withWiring ? `  the wiring diagrams, where WDS covers ${chassis}\n` : ''}  the demo mode, which fills screens with plausible values
${withFaults ? '  fault code lookup with full English descriptions\n' : '  fault codes read off a car (their English text is NOT included)\n'}
WHAT NEEDS A CABLE

Running a job against a real ECU needs a K+DCAN cable and a browser with
Web Serial (desktop Chrome or Edge). Nothing here talks to a car by itself.

THE THOR WIFI ADAPTER

The THOR WiFi dongle works too, through a small relay this folder ships
(browsers cannot open the raw TCP connection the adapter uses). It needs
node from nodejs.org.

1. Plug the THOR into the car and join its Thor_Wifi network.
2. Start the relay and leave its window open:
     macOS    double-click "Start THOR bridge.command"
     Windows  double-click start-thor-bridge.bat
     Linux    node thor_bridge.js

   macOS may refuse the first time with "you do not have appropriate access
   privileges". That is macOS dropping the executable flag when it unzipped
   this folder, not a broken file. Open
   "Start THOR bridge (read me first).html" for a command you can copy, or
   run this once in Terminal from this folder:

     sh "Start THOR bridge.command"

   It puts the flag back, so every double-click after that works.

3. Open index.html and set Settings > Adapter to "THOR (WiFi)".
4. Click the cable chip in the top bar to connect.

Battery voltage, ignition state and the adapter identity read out today;
running jobs over the THOR is still being wired up.

Other chassis are not included. Export them separately from Settings.
`;
}

// Build the zip. onProgress(text) is called as it goes; the whole thing runs
// in the tab, so the caller should keep the UI responsive.
async function offlineExport(chassis, withFaults, onProgress, withWiring = true) {
  if (typeof fflate === 'undefined') {
    throw new Error('fflate is not loaded');
  }
  const files = {};
  const enc0 = new TextEncoder();

  const say = (t) => { if (onProgress) onProgress(t); };

  say('collecting the app');
  for (const f of OFFLINE_SHELL) {
    files[f] = await offlineGet(f);
  }
  // the inline data has to exist before webshim.js looks for it
  {
    const html = new TextDecoder().decode(files['index.html'])
      .replace('<script src="core/webshim.js"></script>',
               '<script src="data/inline.js"></script>\n'
               + '  <script src="data/wiring.js"></script>\n'
               + '  <script src="core/webshim.js"></script>');
    files['index.html'] = enc0.encode(html);
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
  // INLINE, NOT FETCHED. A file:// page gets an opaque origin where fetch()
  // is blocked, so an offline copy that keeps its data in separate files
  // needs a web server to read them -- which meant shipping a launcher
  // script, which macOS then refuses to run (Archive Utility drops the
  // executable bit, and the download carries com.apple.quarantine).
  //
  // A <script> tag has no such restriction. Base64 costs 33% over the raw
  // archive and removes the server, the launcher and both macOS problems, so
  // the folder genuinely opens by double-clicking index.html.
  const b64 = (u8) => {
    let str = '';
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) {
      str += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    }
    return btoa(str);
  };
  const inline = {};
  for (const id of ids) {
    say(`collecting ${id}`);
    inline[id] = b64(await offlineGet(`api/chassis/${id}.chassis`));
  }
  try {
    const idx = await offlineGet('api/ecu-index.json');
    inline._index = JSON.parse(new TextDecoder().decode(idx));
  } catch { /* only used for a cross-chassis lookup */ }
  files['data/inline.js'] = enc0.encode(
    `window.BMACW_INLINE=${JSON.stringify(inline)};`);

  // Wiring diagrams, inlined the same way and for the same reason. Absent
  // for a car WDS never covered, which is not an error: the Wiring entry
  // simply does not appear. Opt-out, because it is 2 to 24 MB per car.
  const wiring = {};
  if (withWiring) {
    for (const id of ids) {
      try {
        say(`collecting ${id} wiring`);
        wiring[id] = b64(await offlineGet(`data/wiring/${id}.wiring`));
      } catch { /* no WDS data for this car */ }
    }
  }
  if (Object.keys(wiring).length) {
    files['data/wiring.js'] = enc0.encode(
      `window.BMACW_WIRING=${JSON.stringify(wiring)};`);
  }

  if (withFaults) {
    for (const f of OFFLINE_FAULTS) {
      say(`collecting ${f.split('/').pop()}`);
      try { files[f] = await offlineGet(f); }
      catch { /* a fault table that was never built is not fatal */ }
    }
  }

  const enc = new TextEncoder();
  files['README.txt'] = enc.encode(
    offlineReadme(chassis === '*' ? ids.join(', ') : chassis, withFaults,
                  Object.keys(wiring).length > 0));

  // Double-clickable starter for the THOR bridge. A page cannot spawn a
  // process -- that is the sandbox doing its job -- so the nearest thing to
  // a button off the macOS app is a file Finder will run.
  //
  // .command, not .sh: Finder always opens a .command in Terminal, while a
  // .sh may go to whatever editor the user has associated. 0o755 in the high
  // half of the external attributes makes it arrive runnable instead of
  // needing chmod.
  //
  // EXACTLY ONE ENTRY MAY CARRY attrs in this fflate build: with two tuples
  // the second is dropped and its bit reappears on whatever entry is last.
  // This is the only one, so it is safe.
  files['Start THOR bridge.command'] = [enc.encode(THOR_LAUNCHER),
                                        { attrs: 0o755 << 16 }];
  files['start-thor-bridge.bat'] = enc.encode(THOR_LAUNCHER_BAT);
  files['Start THOR bridge (read me first).html'] =
    enc.encode(THOR_LAUNCHER_HELP);

  say('compressing');
  // level 0 on the .chassis entry: it is already a zip of deflated members,
  // and recompressing it costs time for nothing.
  const opts = { level: 6 };
  const zipped = fflate.zipSync(files, opts);

  say('saving');
  const name = `bmweb-${chassis === '*' ? 'all' : chassis.toLowerCase()}`
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
