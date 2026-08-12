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
//
// THIS LIST MUST MIRROR index.html. Every <script src> and stylesheet
// <link> the page carries has to appear here (or in the deliberate OMIT set
// in offlineSingleFile) -- the single-file build FAILS LOUDLY on a tag it
// cannot inline, because a silently dropped script is a copy that boots
// broken in the field with nothing to say why.
const OFFLINE_SHELL = [
  'index.html', 'app.js', 'logo.svg',
  'css/styles.css', 'css/themes.css', 'css/lookup.css',
  'vendor/fflate.min.js',
  'core/webdemo.js', 'core/webshim.js', 'core/bestvm.js',
  'core/core.js', 'core/translate.js', 'core/nav.js',
  'screens/autoscan.js', 'screens/sweep.js', 'screens/fault-report.js',
  'screens/ir.js', 'screens/ecu.js', 'screens/flashing.js',
  'screens/activations.js', 'screens/syscheck.js', 'screens/coding.js',
  'screens/coding-edit.js', 'screens/curated-coding.js', 'screens/coding-hub.js', 'screens/navlang.js',
  'screens/identity.js', 'screens/aif.js', 'screens/adaption.js',
  'screens/service.js', 'screens/special.js', 'screens/measurements.js',
  'screens/live.js', 'screens/faults.js', 'screens/lookup.js',
  'screens/tutorial.js', 'screens/wiring.js',
  // what an ECU's coding values mean. 73 KB, unlike the fault tables, so it
  // travels with the shell rather than being opt-in.
  'data/codingmap.js',
  // ...and BMW's own coding map for the modules whose SGBD says nothing.
  // 1.5 MB raw but ~140 KB over the wire, and it is the only description
  // those ECUs have, so it travels too.
  'data/datenmap.js',
];

// The fault tables. Lazy-loaded by the app and 80 MB together, so they are
// opt-in: without them fault CODES still read off the car, they just show
// without their English text.
const OFFLINE_FAULTS = [
  'data/faultdb.js', 'data/faultindex.js', 'data/pcodes.js',
  'data/faultmeta.js', 'data/faultinfo.js',
];

// THE SINGLE FILE CANNOT CARRY ALL OF THAT. faultinfo.js is 60 MB and
// faultmeta.js another 14 -- ISTA's extended descriptions and metadata,
// which turn a 7 MB download into 82 MB. In a zip you keep on a computer
// that is a fair trade; as one .html on a phone it is not.
//
// So the single file ships the names and the P-codes (5 MB), which is what
// makes a code read as "Oil level sensor" instead of bare hex. The extra
// prose is what you lose, not the identification.
const SINGLE_FAULTS = [
  'data/faultdb.js', 'data/faultindex.js', 'data/pcodes.js',
];

function offlineBase() {
  const p = location.pathname.replace(/\/[^/]*$/, '');
  return p.replace(/\/$/, '');
}

// Who built this copy, and when. Stamped into every export (README, inline
// data header, console at boot) because a field file with no version is
// undebuggable: "the export is broken" means nothing without knowing WHICH
// export it is.
function offlineStamp() {
  const app = (typeof APP_NAME === 'string') ? APP_NAME : 'BMWeb';
  const ver = (window.bmacw && window.bmacw.version)
    ? `v${window.bmacw.version}` : 'web';
  return `${app} ${ver} · exported ${new Date().toISOString()}`;
}

// A DROPPED PIECE MUST BE SAID. Both exporters catch per-item failures and
// press on -- which is right for a car WDS never covered, but a fetch that
// fails for any other reason used to ship an export silently missing pieces
// while the button read "saved". Failures collect in a list and surface
// here: the caller only ever prints success, so the warning draws itself.
function offlineWarn(warnings) {
  if (!warnings.length) return;
  warnings.forEach((w) => console.warn('offline export:', w));
  const box = document.createElement('div');
  box.className = 'offline-export-warning';
  box.style.cssText = 'position:fixed;left:50%;bottom:24px;'
    + 'transform:translateX(-50%);z-index:9999;max-width:min(560px,90vw);'
    + 'padding:12px 16px;border-radius:8px;'
    + 'background:var(--panel,#20242b);border:1px solid var(--red,#ef6b6b);'
    + 'color:var(--ink,#eef2f5);font-size:12.5px;line-height:1.5;'
    + 'box-shadow:0 8px 30px rgba(0,0,0,.45)';
  const title = document.createElement('div');
  title.style.cssText = 'font-weight:800;color:var(--red,#ef6b6b);margin-bottom:6px';
  title.textContent = 'Export saved, but incomplete';
  box.appendChild(title);
  warnings.forEach((w) => {
    const d = document.createElement('div');
    d.textContent = `· ${w}`;
    box.appendChild(d);
  });
  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.style.marginTop = '8px';
  btn.textContent = 'Dismiss';
  btn.onclick = () => box.remove();
  box.appendChild(btn);
  document.body.appendChild(box);
}

// The ECU index maps sgbd -> chassis so webshim can find the car a module
// belongs to. In an offline copy a chassis that is NOT inlined cannot be
// fetched (file:// blocks it), so an entry pointing elsewhere dead-ends --
// including "SONDER", which ecu-index.json contains but which has no
// archive at all. Keep only what this copy can resolve; in an all-cars
// export every entry SHOULD have matched, so anything dropped there is
// worth a warning by name.
function offlineFilterIndex(idx, ids, allCars, warnings) {
  const have = new Set(ids.map((i) => String(i).toUpperCase()));
  const out = {};
  const dropped = {};
  for (const [sgbd, cid] of Object.entries(idx)) {
    if (have.has(String(cid).toUpperCase())) out[sgbd] = cid;
    else dropped[cid] = (dropped[cid] || 0) + 1;
  }
  const gone = Object.keys(dropped);
  if (allCars && gone.length) {
    warnings.push('ECU index: dropped '
      + gone.map((c) => `${dropped[c]} ECU${dropped[c] === 1 ? '' : 's'} mapped to ${c}`)
          .join(', ')
      + ' (no such chassis archive in this export)');
  }
  return out;
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

Built by ${offlineStamp()}

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

The THOR WiFi dongle talks to this app directly, over its own WebSocket --
no relay, no node, nothing else running. That works on a phone as well as a
computer.

It needs the WebSocket firmware flashed once. The adapter ships with stock
esp-link, which serves only raw telnet a browser cannot open. Flashing is an
upload through esp-link's own web page; see vendor/esp-link-ws/ in the
project for the images and the steps.

Once it is flashed:

1. Plug the THOR into the car and join its Thor_Wifi network.
2. Open index.html and set Settings > Adapter to "THOR (WiFi)".
3. Click the cable chip in the top bar to connect.

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
  const warnings = [];
  const stamp = offlineStamp();

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
    inline._index = offlineFilterIndex(
      JSON.parse(new TextDecoder().decode(idx)), ids, chassis === '*', warnings);
  } catch (e) {
    // only used for a cross-chassis lookup, but its absence must be said
    warnings.push(`ECU index (cross-chassis lookup): ${e.message}`);
  }
  // the stamp rides in the data file and prints at boot, so a field copy
  // can always say which build made it
  files['data/inline.js'] = enc0.encode(
    `// ${stamp}\n`
    + `console.log(${JSON.stringify(`offline copy: ${stamp}`)});\n`
    + `window.BMACW_INLINE=${JSON.stringify(inline)};`);

  // Wiring diagrams, inlined the same way and for the same reason. Absent
  // for a car WDS never covered, which is not an error: the Wiring entry
  // simply does not appear. Opt-out, because it is 2 to 24 MB per car.
  const wiring = {};
  if (withWiring) {
    for (const id of ids) {
      try {
        say(`collecting ${id} wiring`);
        wiring[id] = b64(await offlineGet(`data/wiring/${id}.wiring`));
      } catch (e) {
        // a car WDS never covered is normal ("missing ..." from offlineGet);
        // any OTHER failure means wiring the user asked for was dropped
        if (!/^missing /.test(e.message)) warnings.push(`${id} wiring: ${e.message}`);
      }
    }
  }
  if (Object.keys(wiring).length) {
    files['data/wiring.js'] = enc0.encode(
      `window.BMACW_WIRING=${JSON.stringify(wiring)};`);
  }

  if (withFaults) {
    for (const f of OFFLINE_FAULTS) {
      say(`collecting ${f.split('/').pop()}`);
      // not fatal, but the user asked for fault text: a missing table means
      // codes read as bare hex, and that has to be said rather than shipped
      try { files[f] = await offlineGet(f); }
      catch (e) { warnings.push(`fault table ${f.split('/').pop()}: ${e.message}`); }
    }
  }

  const enc = new TextEncoder();
  files['README.txt'] = enc.encode(
    offlineReadme(chassis === '*' ? ids.join(', ') : chassis, withFaults,
                  Object.keys(wiring).length > 0));

  // NO RELAY LAUNCHER. An offline copy used to ship .command/.bat starters
  // for thor_bridge.js, because a browser cannot open the raw TCP socket a
  // stock esp-link adapter listens on. That is "install node and run a
  // script first" -- the thing this app exists to avoid, and impossible on
  // a phone. Flash the adapter instead (vendor/esp-link-ws) and it serves
  // the WebSocket itself; the copy's README says how.

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
    offlineWarn(warnings);
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
  offlineWarn(warnings);
  return zipped.length;
}

// ONE FILE, EVERY PLATFORM.
//
// The zip above is right for a computer: a folder you keep, with the bridge
// launcher beside it. It is wrong for a phone. iOS and Android will happily
// download a zip and then give you no good way to unpack it and open one
// page out of it in a browser -- Safari in particular cannot.
//
// A single .html has no such problem. Downloads, sits in Files or Downloads,
// opens by tapping it, on Windows, macOS, iPhone and Android alike. Which
// makes it the only artifact that covers all four, and the one that pairs
// with the adapter's own WebSocket: tap the file, join the adapter's WiFi,
// and the whole app is running with no server, no relay and no internet.
//
// Everything is inlined because a file:// page gets an opaque origin where
// fetch() is blocked -- the same reason the zip inlines its data. Here it
// extends to the scripts and styles too, since there is nowhere else to put
// them.
//
// Wiring is OPT-IN and expensive: 72 MB for an E46 against 13 MB for the
// whole rest of the car. Worth it on a laptop, rarely on a phone -- so the
// caller chooses rather than the format deciding.
async function offlineSingleFile(chassis, withFaults, onProgress,
                                 withWiring = false) {
  const say = (t) => { if (onProgress) onProgress(t); };
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  const warnings = [];
  const stamp = offlineStamp();

  say('collecting the app');
  const shell = {};
  for (const f of OFFLINE_SHELL) {
    if (f === 'thor_bridge.js') continue;     // a page cannot run node
    if (f === 'index.html') continue;         // fetched by name below
    shell[f] = await offlineGet(f);
  }
  // THE APP IS NOT ALWAYS index.html. On the published site the INSTALLER
  // holds that name and the app is app.html, so fetching "index.html"
  // blind got the installer -- which has no <script src> tags at all, and
  // tripped the "no webshim.js tag" guard. Ask for both, in the order that
  // puts the real app first.
  for (const name of ['app.html', 'index.html']) {
    try {
      const doc = await offlineGet(name);
      const txt = new TextDecoder().decode(doc);
      if (txt.includes('webshim.js')) { shell['index.html'] = doc; break; }
    } catch { /* try the next name */ }
  }
  if (!shell['index.html']) {
    throw new Error('could not find the app page (app.html / index.html)');
  }

  let html = dec.decode(shell['index.html']);

  // REPORT FAILURES WHERE THEY CAN BE SEEN. A phone has no console you can
  // open, and the restricted origins a local file gets on iOS
  // (edge://external-file, Quick Look) hide console output entirely -- so a
  // script that throws during boot leaves the splash on "starting engine"
  // forever with nothing to go on.
  //
  // alert() survives all of that, so errors go there as well as to the
  // splash. And because a hang is not an error, the boot leaves CHECKPOINTS:
  // if it stalls, the splash names the last stage reached, which is what
  // turns "it does not work" into a line number.
  html = html.replace('</head>',
    `  <!-- ${stamp} -->
  <script>
  console.log(${JSON.stringify(`offline export: ${stamp}`)});
  (function () {
    var reported = false;
    var mark = function (s) {
      window.__bmwebStage = s;
      var el = document.getElementById('splash-status');
      if (el) el.textContent = s;
    };
    var show = function (msg) {
      var full = msg + ' [stage: ' + (window.__bmwebStage || 'start') + ']';
      var el = document.getElementById('splash-status');
      if (el) { el.textContent = full; el.style.color = '#ef6b6b'; }
      var bar = document.getElementById('splash-bar-fill');
      if (bar) bar.style.display = 'none';
      if (!reported) { reported = true; try { alert(full); } catch (e) {} }
    };
    window.__bmwebMark = mark;
    window.addEventListener('error', function (e) {
      show((e.message || 'script error') + (e.lineno ? ' @' + e.lineno : ''));
    });
    window.addEventListener('unhandledrejection', function (e) {
      show('' + ((e.reason && e.reason.message) || e.reason || 'promise rejected'));
    });
    // Nothing has thrown and nothing has finished: that is a HANG, and it
    // needs its own report or the page just sits there.
    setTimeout(function () {
      if (!reported && !window.__bmwebBooted) {
        show('stuck after 12s');
      }
    }, 12000);
    mark('scripts loading');
  }());
  </script>
</head>`);

  // styles first, in the order the document had them. A sheet the shell
  // list does not carry is a BROKEN EXPORT, not a tag to drop quietly.
  html = html.replace(/[ \t]*<link rel="stylesheet" href="([^"]+)"[^>]*>\n?/g,
    (m, href) => {
      if (!shell[href]) {
        throw new Error(`OFFLINE_SHELL is missing ${href} (the list must mirror index.html)`);
      }
      return `  <style>\n${dec.decode(shell[href])}\n  </style>\n`;
    });

  // Then the scripts, each in place, so load order is preserved exactly.
  // The car's data has to be defined BEFORE webshim.js runs (it reads
  // BMACW_INLINE as it loads), so that script tag is the anchor: emit the
  // data immediately ahead of it. Doing it here rather than with a second
  // pass avoids matching against text this pass has already rewritten.
  // A sentinel that cannot appear in source or prose: " DATA " could --
  // bestvm.js has "0-based over DATA rows" in a comment, and a marker that
  // collides with the payload it marks corrupts the output silently.
  const MARK = '<!--BMWEB_DATA_HERE-->';
  // tags the page carries that a single file deliberately leaves out: a page
  // cannot run node, and a copy does not offer copies of itself
  const OMIT = new Set(['thor_bridge.js', 'core/offline-export.js']);
  let sawWebshim = false;
  html = html.replace(/[ \t]*<script src="([^"]+)"><\/script>\n?/g,
    (m, src) => {
      if (OMIT.has(src)) return '';
      if (!shell[src]) {
        // a silently dropped script is a copy that boots broken with
        // nothing to say why; fail the export instead
        throw new Error(`OFFLINE_SHELL is missing ${src} (the list must mirror index.html)`);
      }
      // </script> inside a string literal would end the tag early
      const js = dec.decode(shell[src]).replace(/<\/script>/gi, '<\\/script>');
      // A checkpoint before each file: a script that hangs or throws leaves
      // the PREVIOUS mark on screen, which names it. Cheap, and the only
      // way to localise a failure on an origin with no console.
      const tag = `  <script>window.__bmwebMark&&window.__bmwebMark('loading ${src}');</script>\n`
        + `  <script>\n${js}\n  </script>\n`;
      if (src === 'core/webshim.js') { sawWebshim = true; return MARK + tag; }
      return tag;
    });
  if (!sawWebshim) throw new Error('index.html has no webshim.js tag');

  // the car's data, as the same globals the zip build sets
  const b64 = (u8) => {
    let str = '';
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) {
      str += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    }
    return btoa(str);
  };
  let ids;
  if (chassis === '*') {
    const r = await OFFLINE_FETCH(`${offlineBase()}/api/chassis.json`);
    ids = await r.json();
  } else {
    ids = [chassis];
  }
  // ONE COPY AT A TIME. Building an object of every car's base64 and then
  // JSON.stringify-ing it holds the whole payload TWICE, and "all cars" is
  // 184 MB of base64 -- so the peak ran to roughly 700 MB for a 190 MB
  // file and iOS killed the tab (which looks like a spontaneous reload,
  // since an out-of-memory kill raises nothing to catch).
  //
  // Emit the object literal as fragments instead: each car is encoded,
  // appended, and dropped before the next is fetched. JSON.stringify on
  // one string at a time still escapes it correctly; base64 has nothing
  // needing escapes anyway, but this stays honest about that.
  const dataParts = ['window.BMACW_INLINE={'];
  let first = true;
  for (const id of ids) {
    say(`collecting ${id}`);
    const enc64 = b64(await offlineGet(`api/chassis/${id}.chassis`));
    dataParts.push(`${first ? '' : ','}${JSON.stringify(id)}:${JSON.stringify(enc64)}`);
    first = false;
  }
  try {
    // PARSED, NOT SPLICED RAW. The bytes used to be pasted straight into
    // the object literal, so a truncated ecu-index.json corrupted the whole
    // data script silently. JSON.parse makes a bad file fail HERE, where it
    // can be reported, and the filter drops entries no offline copy can
    // resolve (see offlineFilterIndex).
    const idx = JSON.parse(dec.decode(await offlineGet('api/ecu-index.json')));
    dataParts.push(`,"_index":${JSON.stringify(
      offlineFilterIndex(idx, ids, chassis === '*', warnings))}`);
  } catch (e) {
    // only used for a cross-chassis lookup, but its absence must be said
    warnings.push(`ECU index (cross-chassis lookup): ${e.message}`);
  }
  dataParts.push('};');
  if (withWiring) {
    const parts = [];
    let wfirst = true;
    for (const id of ids) {
      try {
        say(`collecting ${id} wiring`);
        const w = b64(await offlineGet(`data/wiring/${id}.wiring`));
        parts.push(`${wfirst ? '' : ','}${JSON.stringify(id)}:${JSON.stringify(w)}`);
        wfirst = false;
      } catch (e) {
        // a car WDS never covered stays absent ("missing ..." from
        // offlineGet); any other failure dropped wiring the user asked for
        if (!/^missing /.test(e.message)) warnings.push(`${id} wiring: ${e.message}`);
      }
    }
    if (parts.length) {
      dataParts.push('\nwindow.BMACW_WIRING={', ...parts, '};');
    }
  }
  if (withFaults) {
    for (const f of SINGLE_FAULTS) {
      say(`collecting ${f.split('/').pop()}`);
      // not fatal, but the user asked for fault text: a missing table means
      // codes read as bare hex, and that has to be said rather than shipped
      try { dataParts.push('\n', dec.decode(await offlineGet(f))); }
      catch (e) { warnings.push(`fault table ${f.split('/').pop()}: ${e.message}`); }
    }
  }
  // codingmap.js and datenmap.js have NO <script src> tag -- translate.js
  // lazy-loads them on demand -- so the tag inliner above never carries
  // them, and a single file has no sibling for the lazy <script src> to
  // find: every coding label was silently lost. Inline them with the data
  // instead; loadCodingMap()/loadDatenMap() check window.BMW_CODING_MAP /
  // window.BMW_DATEN_MAP before fetching, so the inlined copy makes the
  // lazy path a no-op. ~6 MB together, which the coding screens are worth.
  for (const f of ['data/codingmap.js', 'data/datenmap.js']) {
    if (shell[f]) dataParts.push('\n', dec.decode(shell[f]));
    else warnings.push(`${f}: not in the app shell, coding labels will be missing`);
  }
  const dataJs = dataParts.join('');
  dataParts.length = 0;

  // The data is the biggest single script by far -- a 6 MB string literal
  // for an E46. If a parser or a memory limit is going to give out, it is
  // most likely here, so bracket it with its own marks.
  html = html.replace(MARK,
    '  <script>window.__bmwebMark&&window.__bmwebMark(\'parsing car data\');</script>\n'
    + `  <script>\n${dataJs.replace(/<\/script>/gi, '<\\/script>')}\n  </script>\n`
    + '  <script>window.__bmwebMark&&window.__bmwebMark('
    + '\'car data parsed: \'+(window.BMACW_INLINE?Object.keys(window.BMACW_INLINE).join(","):\'MISSING\'));</script>\n');
  if (html.includes(MARK)) {
    throw new Error('single-file: the data marker survived the build');
  }

  say('saving');
  const name = `bmweb-${chassis === '*' ? 'all' : chassis.toLowerCase()}.html`;

  // The native shell wants bytes; a browser does not. enc.encode() makes
  // one more full-size copy, so only pay for it where it is used.
  if (window.bmacw && typeof window.bmacw.saveFile === 'function') {
    const bytes = enc.encode(html);
    const r = await window.bmacw.saveFile(name, bytes);
    if (r && r.cancelled) throw new Error('cancelled');
    offlineWarn(warnings);
    return bytes.length;
  }
  // A Blob takes PARTS, so the document never has to exist as one string
  // AND one byte array at the same time. html is dropped straight after.
  const size = html.length;
  const blob = new Blob([html], { type: 'text/html' });
  html = '';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  offlineWarn(warnings);
  return size;
}

if (typeof window !== 'undefined') {
  window.offlineExport = offlineExport;
  window.offlineSingleFile = offlineSingleFile;
}
