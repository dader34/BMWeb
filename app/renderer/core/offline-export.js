// Package the loaded app into a folder that opens with no server: the app is
// already static, so an offline copy is the same files zipped in the browser.
// Scoped to one car (the whole site is 203 MB; one chassis is 2-13 MB).

// Files the renderer needs whatever car you picked.
// THIS LIST MUST MIRROR index.html: every <script src> and <link> the page
// carries appears here (or in offlineSingleFile's OMIT set). The single-file
// build FAILS LOUDLY on a tag it can't inline — a silently dropped script boots
// broken in the field with nothing to say why.
const OFFLINE_SHELL = [
  // the page itself, plus the icon it names
  'index.html', 'logo.svg',

  'css/styles.css',
  'css/lookup.css',
  'css/tuning.css',
  'css/themes.css',

  'vendor/fflate.min.js',

  'core/webdemo.js',
  'core/webshim.js',
  'core/bestvm.js',
  'core/core.js',
  'core/print.js',
  'core/router.js',
  'core/translate.js',
  'core/nav.js',
  'core/tuning-store.js',
  'core/xdf.js',

  'screens/autoscan.js',
  'screens/sweep.js',
  'screens/fault-report.js',
  'screens/ir.js',
  'screens/ecu.js',
  'screens/activations.js',

  'core/coding-encode.js',
  'core/coding-zcs.js',
  'core/coding-auftrag.js',
  'core/coding-custom.js',
  'core/coding-select.js',
  'core/vehicle-identity.js',
  'core/coding-write.js',

  'screens/coding-edit.js',
  'screens/curated-coding.js',
  'screens/coding-hub.js',
  'screens/coding-zcs-editor.js',
  'screens/navlang.js',
  'screens/identity.js',
  'screens/vehicle-identity.js',
  'screens/special.js',
  'screens/measurements.js',
  'screens/live.js',
  'screens/faults.js',
  'screens/lookup.js',
  'screens/wiring.js',
  'screens/etk.js',
  'screens/tool32.js',
  'screens/tuning-memory.js',
  'screens/tuning.js',
  'screens/apps.js',
  'screens/tutorial.js',

  'app.js',

  // coding-value meanings (small, so they travel with the shell not opt-in)
  'data/codingmap.js',
  // ...and BMW's own coding map for modules whose SGBD says nothing
  'data/datenmap.js',
];

// The fault tables, 80 MB together, so opt-in: without them CODES still read,
// they just show without English text.
const OFFLINE_FAULTS = [
  'data/faultdb.js', 'data/faultindex.js', 'data/pcodes.js',
  'data/faultmeta.js', 'data/faultinfo.js',
];

// The single file drops faultinfo (60 MB) + faultmeta (14 MB) and ships only
// the names and P-codes (5 MB) — a code still reads "Oil level sensor" not hex;
// only the extended prose is lost. 82 MB is too much for one .html on a phone.
const SINGLE_FAULTS = [
  'data/faultdb.js', 'data/faultindex.js', 'data/pcodes.js',
];

function offlineBase() {
  const p = location.pathname.replace(/\/[^/]*$/, '');
  return p.replace(/\/$/, '');
}

// Who built this copy, and when. Stamped into every export because a field file
// with no version is undebuggable.
function offlineStamp() {
  const app = (typeof APP_NAME === 'string') ? APP_NAME : 'BMWeb';
  const ver = (window.bmacw && window.bmacw.version)
    ? `v${window.bmacw.version}` : 'web';
  return `${app} ${ver} · exported ${new Date().toISOString()}`;
}

// A DROPPED PIECE MUST BE SAID. Exporters catch per-item failures and press on
// (right for a car WDS never covered), but other failures used to ship a copy
// silently missing pieces while the button read "saved". They collect here and
// this surfaces them, since the caller only prints success.
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

// The ECU index maps sgbd -> chassis. An entry pointing at a chassis not inlined
// here dead-ends (file:// blocks the fetch), including "SONDER", which has no
// archive at all. Keep only what this copy can resolve; in an all-cars export
// every entry should have matched, so a drop there is worth a warning by name.
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
// answers /api/... from the archives, so use the real pre-shim fetch (which
// the shim stores) to read the bytes on disk.
const OFFLINE_FETCH = (typeof webRealFetch === 'function')
  ? webRealFetch : window.fetch.bind(window);

async function offlineGet(path) {
  const r = await OFFLINE_FETCH(`${offlineBase()}/${path}`);
  if (!r.ok) throw new Error(`missing ${path}`);
  return new Uint8Array(await r.arrayBuffer());
}

// The fault tables are BMW-derived and NOT in the repo (see .gitignore), so a
// hosted build serves 404 for them and fetches them from Hugging Face at
// runtime instead -- which is what faults.js and translate.js already do. The
// exporter looked only at data/, so an offline copy taken from the hosted site
// came out with no fault text at all and warned about four missing files, on a
// site where fault text works. Fall back to the same dataset the app uses.
const OFFLINE_FAULT_HF =
  'https://huggingface.co/datasets/CraigFf/bmweb-etk/resolve/main/faults/';

async function offlineGetFault(path) {
  try { return await offlineGet(path); }
  catch (e) {
    const name = path.split('/').pop();
    const r = await OFFLINE_FETCH(OFFLINE_FAULT_HF + name);
    if (!r.ok) throw e;          // report the ORIGINAL miss, not the fallback's
    return new Uint8Array(await r.arrayBuffer());
  }
}

// README for the folder, so it is obvious how to open it a year from now.
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

// Build the zip. onProgress(text) is called as it goes; runs in the tab.
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

  // "*" means every car (the whole site in one Blob): offered, not the default.
  let ids;
  if (chassis === '*') {
    const r = await OFFLINE_FETCH(`${offlineBase()}/api/chassis.json`);
    ids = await r.json();
  } else {
    ids = [chassis];
  }
  // INLINE, NOT FETCHED. file:// gets an opaque origin where fetch() is blocked,
  // so data in separate files needs a server (or a launcher script macOS then
  // refuses to run). A <script> tag has no such restriction; base64 costs 33%
  // and lets the folder open by double-clicking index.html.
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
  // the stamp rides in the data file and prints at boot
  files['data/inline.js'] = enc0.encode(
    `// ${stamp}\n`
    + `console.log(${JSON.stringify(`offline copy: ${stamp}`)});\n`
    + `window.BMACW_INLINE=${JSON.stringify(inline)};`);

  // Wiring diagrams, inlined the same way. Absent for a car WDS never covered
  // (not an error). Opt-out, 2 to 24 MB per car.
  const wiring = {};
  if (withWiring) {
    for (const id of ids) {
      try {
        say(`collecting ${id} wiring`);
        wiring[id] = b64(await offlineGet(`data/wiring/${id}.wiring`));
      } catch (e) {
        // "missing ..." = WDS never covered it (normal); any other failure
        // dropped wiring the user asked for
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
      // not fatal, but a missing table means codes read as bare hex — say it
      try { files[f] = await offlineGet(f); }
      catch (e) { warnings.push(`fault table ${f.split('/').pop()}: ${e.message}`); }
    }
  }

  const enc = new TextEncoder();
  files['README.txt'] = enc.encode(
    offlineReadme(chassis === '*' ? ids.join(', ') : chassis, withFaults,
                  Object.keys(wiring).length > 0));

  // No relay launcher: flash the adapter (vendor/esp-link-ws) to serve the
  // WebSocket instead of shipping a node script; the README says how.

  say('compressing');
  const opts = { level: 6 };
  const zipped = fflate.zipSync(files, opts);

  say('saving');
  const name = `bmweb-${chassis === '*' ? 'all' : chassis.toLowerCase()}`
    + '-offline.zip';

  // ASK WHERE, when the host can: the macOS shell opens a real Save panel
  // (a WKWebView download lands somewhere unchosen); the web falls back to a
  // browser download.
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

// ONE FILE, EVERY PLATFORM. A phone can't unpack a zip and open one page, but a
// single .html taps open on every OS. Everything is inlined (file:// blocks
// fetch). Wiring is opt-in and expensive (72 MB for E46), so the caller chooses.
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
  // THE APP IS NOT ALWAYS index.html: on the published site the installer holds
  // that name and the app is app.html. Ask for both, real app first, and pick
  // the one that actually has the webshim.js tag.
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

  // REPORT FAILURES WHERE THEY CAN BE SEEN. A phone has no console (iOS local
  // origins hide it), so a boot error would leave the splash stuck silently.
  // Errors go to alert() and the splash; and because a hang is not an error,
  // the boot leaves CHECKPOINTS naming the last stage reached.
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
    // nothing thrown, nothing finished = a HANG; report it or the page just sits
    setTimeout(function () {
      if (!reported && !window.__bmwebBooted) {
        show('stuck after 12s');
      }
    }, 12000);
    mark('scripts loading');
  }());
  </script>
</head>`);

  // styles first, in document order. A sheet the shell list lacks is a BROKEN
  // EXPORT, not a tag to drop quietly.
  html = html.replace(/[ \t]*<link rel="stylesheet" href="([^"]+)"[^>]*>\n?/g,
    (m, href) => {
      if (!shell[href]) {
        throw new Error(`OFFLINE_SHELL is missing ${href} (the list must mirror index.html)`);
      }
      return `  <style>\n${dec.decode(shell[href])}\n  </style>\n`;
    });

  // Then the scripts, each in place, preserving load order. The car's data must
  // be defined BEFORE webshim.js runs (it reads BMACW_INLINE as it loads), so
  // that tag is the anchor; a MARK sentinel reserves the spot. The sentinel must
  // not appear in source or prose or it corrupts the output silently.
  const MARK = '<!--BMWEB_DATA_HERE-->';
  // tags a single file leaves out: no node, and no copies of itself
  const OMIT = new Set(['thor_bridge.js', 'core/offline-export.js']);
  let sawWebshim = false;
  html = html.replace(/[ \t]*<script src="([^"]+)"><\/script>\n?/g,
    (m, src) => {
      if (OMIT.has(src)) return '';
      if (!shell[src]) {
        // fail the export: a silently dropped script boots broken with no clue why
        throw new Error(`OFFLINE_SHELL is missing ${src} (the list must mirror index.html)`);
      }
      // </script> inside a string literal would end the tag early
      const js = dec.decode(shell[src]).replace(/<\/script>/gi, '<\\/script>');
      // a checkpoint before each file: a hang/throw leaves the PREVIOUS mark on
      // screen, naming it — the only way to localise a failure with no console
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
  // ONE COPY AT A TIME. Building an object of all cars then JSON.stringify-ing
  // it holds the payload TWICE; "all cars" is 184 MB, so the peak hit ~700 MB
  // and iOS killed the tab (an OOM kill raises nothing to catch). Emit the
  // object literal as fragments: encode, append and drop each car before the next.
  const dataParts = ['window.BMACW_INLINE={'];
  let first = true;
  for (const id of ids) {
    say(`collecting ${id}`);
    const enc64 = b64(await offlineGet(`api/chassis/${id}.chassis`));
    dataParts.push(`${first ? '' : ','}${JSON.stringify(id)}:${JSON.stringify(enc64)}`);
    first = false;
  }
  try {
    // PARSED, NOT SPLICED RAW: a truncated ecu-index.json spliced straight in
    // used to corrupt the data script silently. JSON.parse fails HERE where it
    // can be reported (and the filter drops unresolvable entries).
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
        // "missing ..." = WDS never covered it; any other failure dropped
        // wiring the user asked for
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
      // not fatal, but a missing table means codes read as bare hex — say it
      try { dataParts.push('\n', dec.decode(await offlineGetFault(f))); }
      catch (e) { warnings.push(`fault table ${f.split('/').pop()}: ${e.message}`); }
    }
  }
  // codingmap.js / datenmap.js have NO <script src> tag (translate.js lazy-loads
  // them), so the tag inliner never carries them and a single file has no
  // sibling to fetch — coding labels were silently lost. Inline them with the
  // data; loadCodingMap()/loadDatenMap() check the globals first, so the lazy
  // path becomes a no-op.
  for (const f of ['data/codingmap.js', 'data/datenmap.js']) {
    if (shell[f]) dataParts.push('\n', dec.decode(shell[f]));
    else warnings.push(`${f}: not in the app shell, coding labels will be missing`);
  }
  const dataJs = dataParts.join('');
  dataParts.length = 0;

  // the biggest single script by far, so bracket it with its own marks: a
  // parser or memory limit is most likely to give out here.
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

  // native shell wants bytes (one more full-size copy), so only encode when used
  if (window.bmacw && typeof window.bmacw.saveFile === 'function') {
    const bytes = enc.encode(html);
    const r = await window.bmacw.saveFile(name, bytes);
    if (r && r.cancelled) throw new Error('cancelled');
    offlineWarn(warnings);
    return bytes.length;
  }
  // a Blob takes PARTS, so the doc never exists as string AND bytes at once
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
