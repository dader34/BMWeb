#!/usr/bin/env node
// Package a built dist-web into downloadable OFFLINE web builds, in variants.
//
// dist-web is already the whole static site (index.html + every file it loads),
// so a variant is just dist-web with some data trees left out. Three datasets
// are normally streamed from Hugging Face at runtime and MUST be present in
// dist-web/data before packaging, or the build is not offline at all:
//
//   data/faultdb.js faultindex.js faultmeta.js faultinfo.js   fault lookup (84 MB)
//   data/ista/faulttests.json                                 ISTA test plans (14 MB)
//   data/etk/                                                 parts catalogue (5.8 GB)
//
// The first two are required for every variant (this script refuses without
// them). The parts catalogue is only in the "complete" variant, which is too
// big for a GitHub release asset (2 GB cap) and is published to Hugging Face
// instead; the other variants hide the Parts entry.
//
//   node scripts/build/offline-build.mjs --dist dist-web --out release-builds
//   node scripts/build/offline-build.mjs --dist dist-web --out release-builds --variant complete
//
// Produces one .zip per variant:
//   bmweb-<ver>-offline.zip             diagnostics + coding + fault lookup + wiring
//   bmweb-<ver>-offline-no-wiring.zip   the same minus the WDS wiring diagrams (~150 MB)
//   bmweb-<ver>-offline-complete.zip    everything, parts catalogue included (~6.5 GB)
//
// Each build is self-contained static HTML: unzip and open index.html (or serve
// the folder over any static HTTP server).

import { execFileSync } from 'node:child_process';
import { cpSync, rmSync, mkdirSync, existsSync, writeFileSync, readFileSync,
         readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const DIST = arg('dist', 'dist-web');
const OUT = arg('out', 'release-builds');
if (!existsSync(join(DIST, 'index.html'))) {
  console.error(`error: ${DIST}/index.html not found -- build dist-web first `
    + `(scripts/build/build-web.sh)`);
  process.exit(1);
}

// the version the web build stamped into version.js (window.BMACW_VERSION=...)
function readVersion() {
  try {
    const v = readFileSync(join(DIST, 'version.js'), 'utf8');
    const m = v.match(/BMACW_VERSION\s*=\s*"([^"]+)"/);
    if (m && m[1] && m[1] !== 'web') return m[1];
  } catch { /* fall through */ }
  return '0.0.0';
}
const VER = readVersion();

// The variants: name -> which data trees to DROP. Everything not dropped ships.
//   wiring: data/wiring/*.wiring  (the WDS diagrams, ~150 MB as released)
//   parts : data/etk/             (the ETK catalogue, ~5.8 GB; "complete" only)
const ALL_VARIANTS = [
  { name: '',            dropWiring: false, dropParts: true  },
  { name: '-no-wiring',  dropWiring: true,  dropParts: true  },
  { name: '-complete',   dropWiring: false, dropParts: false },
];
const WANT = arg('variant', 'github');   // github = the two release-asset zips
const VARIANTS = WANT === 'complete' ? ALL_VARIANTS.filter((v) => !v.dropParts)
               : WANT === 'all'      ? ALL_VARIANTS
               :                       ALL_VARIANTS.filter((v) => v.dropParts);

// Offline means offline: the fault lookup data is fetched from Hugging Face by
// the hosted site, so a dist-web straight out of web_export.py does not have
// it. Refuse rather than ship a zip whose README promises fault lookup.
const REQUIRED = ['data/faultdb.js', 'data/faultindex.js', 'data/faultmeta.js',
                  'data/faultinfo.js', 'data/ista/faulttests.json'];
const missing = REQUIRED.filter((f) => !existsSync(join(DIST, f)));
if (missing.length) {
  console.error(`error: ${DIST} is missing the fault-lookup data, so the build would `
    + `not be offline:\n  ${missing.join('\n  ')}\n`
    + `Fetch faults/*.js and ista/faulttests.json from the CraigFf/bmweb-etk dataset `
    + `into ${DIST}/data first (release-web.yml shows how).`);
  process.exit(1);
}
if (VARIANTS.some((v) => !v.dropParts)) {
  const n = existsSync(join(DIST, 'data', 'etk'))
    ? readdirSync(join(DIST, 'data', 'etk')).filter((f) => f.endsWith('.etk')).length : 0;
  if (n < 200 || !existsSync(join(DIST, 'data', 'etk', 'index.json'))) {
    console.error(`error: the complete variant needs the ETK tree in ${DIST}/data/etk `
      + `(found ${n} .etk bundles, want 246 plus index.json).`);
    process.exit(1);
  }
}

// When parts are OFF: a tiny flag file the app reads to hide the parts-catalogue
// (ETK) entry rather than offer a feature this build cannot serve. Loaded before
// app.js, same mechanism as version.js.
const PARTS_OFF_JS = 'window.BMACW_NO_PARTS=true;\n';
const OFFLINE_JS = 'window.BMACW_OFFLINE=true;\n';

function humanSize(bytes) {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
function dirSize(dir) {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else try { total += statSync(p).size; } catch { /* skip */ }
  }
  return total;
}

mkdirSync(OUT, { recursive: true });
const results = [];

for (const v of VARIANTS) {
  const stageName = `bmweb-${VER}-offline${v.name}`;
  const stage = join(OUT, stageName);
  console.log(`\n==> building ${stageName}`);
  rmSync(stage, { recursive: true, force: true });
  // copy the whole site, then prune per variant. cpSync is a plain recursive
  // copy; the prune below removes the excluded trees before zipping.
  cpSync(DIST, stage, { recursive: true });

  if (v.dropWiring) {
    const w = join(stage, 'data', 'wiring');
    if (existsSync(w)) { rmSync(w, { recursive: true, force: true });
      console.log('    dropped data/wiring (WDS diagrams)'); }
    // also the inline bundle, if a previous export left one
    const wj = join(stage, 'data', 'wiring.js');
    if (existsSync(wj)) rmSync(wj, { force: true });
  }
  // every offline variant carries the flag the app reads to drop features
  // that only make sense online (the remote session). Same mechanism as
  // version.js / no-parts.js: a tiny script before app.js.
  writeFileSync(join(stage, 'offline.js'), OFFLINE_JS);
  if (!readFileSync(join(stage, 'index.html'), 'utf8').includes('offline.js')) {
    const html = readFileSync(join(stage, 'index.html'), 'utf8')
      .replace('<head>', '<head>\n  <script src="offline.js"></script>');
    writeFileSync(join(stage, 'index.html'), html);
  }

  if (v.dropParts) {
    // The catalogue is 5.8 GB and lives only in the complete build; hide the
    // Parts entry here rather than offer a screen that would try the network.
    writeFileSync(join(stage, 'no-parts.js'), PARTS_OFF_JS);
    if (!readFileSync(join(stage, 'index.html'), 'utf8').includes('no-parts.js')) {
      const html = readFileSync(join(stage, 'index.html'), 'utf8')
        .replace('<head>', '<head>\n  <script src="no-parts.js"></script>');
      writeFileSync(join(stage, 'index.html'), html);
    }
    const etk = join(stage, 'data', 'etk');
    if (existsSync(etk)) { rmSync(etk, { recursive: true, force: true });
      console.log('    dropped data/etk (parts catalogue)'); }
    console.log('    parts catalogue hidden (see the complete build)');
  }

  // a short readme so the download explains itself
  writeFileSync(join(stage, 'OFFLINE-README.txt'),
    `BMWeb ${VER} -- offline web build (offline${v.name})\n`
    + `${'='.repeat(48)}\n\n`
    + `HOW TO RUN\n`
    + `  Easiest: unzip, then open index.html in Chrome or Edge. The first time,\n`
    + `  click "Select folder" and choose THIS folder (the one holding\n`
    + `  index.html). The app then loads its car data straight from the folder --\n`
    + `  no internet, no server. It remembers the folder for next time.\n\n`
    + `  Alternative: serve this folder over any static HTTP server (e.g.\n`
    + `  "python3 -m http.server" in this folder, then open the shown URL). Then\n`
    + `  no folder pick is needed.\n\n`
    + `  Why the folder pick: a browser opening index.html directly (file://)\n`
    + `  blocks a page from reading its own data files unless you grant access to\n`
    + `  the folder. Chrome and Edge support this; Safari and Firefox do not, so\n`
    + `  on those use the HTTP-server option above.\n\n`
    + `Nothing in this build fetches from the internet. A K+DCAN cable talks to\n`
    + `the car through the browser (Web Serial, Chrome or Edge) or over WiFi\n`
    + `through the THOR adapter.\n\n`
    + `This build includes:\n`
    + `  - full diagnostics (every shipped SGBD), coding, fault memory\n`
    + `  - fault code lookup with English descriptions and ISTA test plans\n`
    + (v.dropWiring
        ? `  - NO wiring diagrams (WDS) -- excluded to keep this build small\n`
        : `  - WDS wiring diagrams (where covered)\n`)
    + (v.dropParts
        ? `  - NO parts catalogue (ETK). It is 5.8 GB, more than a GitHub release\n`
          + `    asset may hold, so the build that has it lives on Hugging Face:\n`
          + `    the "offline-complete" zip linked from the release notes.\n`
        : `  - the ETK parts catalogue, every chassis\n`)
    + `\nVersion ${VER}.\n`);

  const size = dirSize(stage);
  const zipPath = join(OUT, `${stageName}.zip`);
  rmSync(zipPath, { force: true });
  console.log(`    staged ${humanSize(size)}, zipping…`);
  // zip from inside OUT so the archive holds "<stageName>/..." not the full path
  execFileSync('zip', ['-r', '-q', '-1', basename(zipPath), stageName],
    { cwd: OUT, stdio: 'inherit' });
  rmSync(stage, { recursive: true, force: true });   // keep only the .zip
  const zsize = statSync(zipPath).size;
  console.log(`    -> ${basename(zipPath)} (${humanSize(zsize)})`);
  results.push({ name: v.name, zip: basename(zipPath), size: zsize });
}

console.log(`\n==> ${results.length} offline builds in ${OUT}:`);
for (const r of results) {
  console.log(`    ${r.zip.padEnd(40)} ${humanSize(r.size)}`);
}
// emit a machine-readable manifest for the release step
writeFileSync(join(OUT, 'manifest.json'),
  JSON.stringify({ version: VER, builds: results }, null, 2));
