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
  'core/webdemo.js', 'core/webshim.js', 'core/bestvm.js',
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

Open index.html. That is the whole procedure: double-click it, or drag it
into a browser. No server, no install, no launcher script.

Everything this folder needs is inside it, and the ECU data is embedded in
data/inline.js rather than loaded as separate files, which is what lets a
page opened straight from disk read it at all.

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
