#!/usr/bin/env node
// Package a built dist-web into downloadable OFFLINE web builds, in variants.
//
// The in-browser export (app/renderer/core/offline-export.js) zips the live
// site from a running page; this does the same job server-side so CI can attach
// the builds to a GitHub release. It does NOT reimplement the shell file list --
// dist-web is already the whole static site (index.html + every file it loads),
// so a variant is just dist-web with some data directories left out.
//
//   node scripts/build/offline-build.mjs --dist dist-web --out release-builds
//
// Produces one .zip per variant:
//   bmweb-<ver>-offline-full.zip        everything (diagnostics + coding + faults
//                                        + wiring + parts-catalogue support)
//   bmweb-<ver>-offline-no-wiring.zip   full minus the WDS wiring diagrams (~1 GB)
//   bmweb-<ver>-offline-no-parts.zip    full minus the parts catalogue (ETK)
//   bmweb-<ver>-offline-lite.zip        minus BOTH wiring and parts catalogue
//
// Each build is self-contained static HTML: unzip and open index.html (or serve
// the folder over any static HTTP server). Wiring/ETK, when excluded, degrade to
// a "not included in this build" notice -- nothing else changes.

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
//   wiring: data/wiring/*.wiring  (the WDS diagrams, ~1 GB -- the big one)
//   parts : the ETK parts catalogue. ETK data is fetched remotely, not bundled,
//           so "without parts" ships a flag that hides the catalogue entry --
//           see PARTS_OFF below -- rather than deleting a local tree.
const VARIANTS = [
  { name: 'full',       dropWiring: false, dropParts: false },
  { name: 'no-wiring',  dropWiring: true,  dropParts: false },
  { name: 'no-parts',   dropWiring: false, dropParts: true  },
  { name: 'lite',       dropWiring: true,  dropParts: true  },
];

// When parts are OFF: a tiny flag file the app reads to hide the parts-catalogue
// (ETK) entry rather than offer a feature this build cannot serve. Loaded before
// app.js, same mechanism as version.js.
const PARTS_OFF_JS = 'window.BMACW_NO_PARTS=true;\n';

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
  const stageName = `bmweb-${VER}-offline-${v.name}`;
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
  if (v.dropParts) {
    // ETK is remote-fetched, so there is usually no local tree to delete; ship
    // the flag that hides the catalogue entry and drop any local etk data.
    writeFileSync(join(stage, 'no-parts.js'), PARTS_OFF_JS);
    if (!readFileSync(join(stage, 'index.html'), 'utf8').includes('no-parts.js')) {
      const html = readFileSync(join(stage, 'index.html'), 'utf8')
        .replace('<head>', '<head>\n  <script src="no-parts.js"></script>');
      writeFileSync(join(stage, 'index.html'), html);
    }
    const etk = join(stage, 'data', 'etk');
    if (existsSync(etk)) { rmSync(etk, { recursive: true, force: true });
      console.log('    dropped data/etk (parts catalogue)'); }
    console.log('    parts catalogue disabled');
  }

  // a short readme so the download explains itself
  writeFileSync(join(stage, 'OFFLINE-README.txt'),
    `BMWeb ${VER} -- offline web build (${v.name})\n`
    + `${'='.repeat(48)}\n\n`
    + `Unzip this folder and open index.html in a browser, or serve the folder\n`
    + `over any static HTTP server. Everything runs locally -- no internet needed\n`
    + `for diagnostics, coding and fault reading. A K+DCAN / ENET cable talks to\n`
    + `the car through the browser (Web Serial) or the THOR WiFi adapter.\n\n`
    + `This build includes:\n`
    + `  - full diagnostics (every shipped SGBD), coding, fault memory\n`
    + `  - fault code lookup with English descriptions\n`
    + (v.dropWiring
        ? `  - NO wiring diagrams (WDS) -- excluded to keep this build small\n`
        : `  - WDS wiring diagrams (where covered)\n`)
    + (v.dropParts
        ? `  - NO parts catalogue (ETK) -- excluded from this build\n`
        : `  - parts catalogue (ETK) support\n`)
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
