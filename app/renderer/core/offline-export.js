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

// README for the folder, so it is obvious how to open it a year from now.
function offlineReadme(chassis, withFaults) {
  return `BMacW offline copy - ${chassis}
${'='.repeat(24 + chassis.length)}

Everything needed to browse ${chassis} with no internet and no server
install: the app itself, ${chassis}'s ECU data, and the BEST2 VM that
decodes it.

RUNNING IT

A browser will not let a page opened straight from disk (file://) read its
own data files, so serve the folder over HTTP. Any one of these:

    python3 -m http.server 8080
    npx serve .
    php -S localhost:8080

then open http://localhost:8080 .

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

  files['README.txt'] = new TextEncoder()
    .encode(offlineReadme(chassis === '*' ? ids.join(', ') : chassis,
                          withFaults));

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
