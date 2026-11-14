#!/usr/bin/env node
/**
 * @file Package a built dist-web into downloadable offline web builds.
 */
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
// WebKFP's SP-Daten (BMW's program and data files) ride separately. Packed
// (tools/export/kfp_spdaten_pack.py, scripts/build/fetch_spdaten.py) every
// module family but the head-unit images is about 0.8 GB: three times the
// rest of the build, and only someone who flashes needs it. So when
// dist-web/data/sp-daten is there, the release-asset variants leave it out
// and it becomes its own zip:
//   bmweb-<ver>-offline-spdaten.zip     unzip INTO an offline build's folder
// The complete variant, which is not a GitHub asset, carries it inside.
//
// THE DATA IS PACKED. dist-web carries each car's data in that car's own
// archives (its ECUs, its ISTA bundle, its wiring, its parts catalogue), so
// an ECU fitted to nine cars is in the download nine times, each copy
// deflated alone, and a parts diagram once per model that uses the part.
// Those archives were 969 MB of a 1,058 MB zip, and 6 GB more in the
// complete build. scripts/build/pack_offline.py stores each file once, like
// beside like, in zstd packs (a fifth of that; the catalogue's pictures,
// which do not compress, once each as plain files), and every variant here
// takes those in place of the archives and the plain data files. The app
// reads either layout; --no-pack builds the old way. The hosted site is not
// packed: a hosted reader fetches one car, and a pack is a slice of every car.
//
// Each build is self-contained static HTML: unzip and open index.html (or serve
// the folder over any static HTTP server).

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  rmSync,
  mkdirSync,
  existsSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  lstatSync,
  statSync,
} from 'node:fs';
import { join, basename } from 'node:path';

/**
 * The value following `--<name>` on the command line, or a default.
 * @param {string} name - the option name without the leading dashes
 * @param {string} def - the value when the option is absent
 * @returns {string} the option value
 */
function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const DIST = arg('dist', 'dist-web');
const OUT = arg('out', 'release-builds');
if (!existsSync(join(DIST, 'index.html'))) {
  console.error(
    `error: ${DIST}/index.html not found -- build dist-web first ` +
      `(scripts/build/build-web.sh)`
  );
  process.exit(1);
}

/**
 * The version the web build stamped into version.js (window.BMWEB_VERSION=...).
 * @returns {string} the version, or '0.0.0' when none was stamped
 */
function readVersion() {
  try {
    const v = readFileSync(join(DIST, 'version.js'), 'utf8');
    const m = v.match(/BMWEB_VERSION\s*=\s*"([^"]+)"/);
    if (m && m[1] && m[1] !== 'web') return m[1];
  } catch {
    /* fall through */
  }
  return '0.0.0';
}
const VER = readVersion();

// The variants: name -> which data trees to DROP. Everything not dropped ships.
//   wiring: data/wiring/*.wiring  (the WDS diagrams, ~150 MB as released)
//   parts : data/etk/             (the ETK catalogue, ~5.8 GB; "complete" only)
const ALL_VARIANTS = [
  { name: '', dropWiring: false, dropParts: true },
  { name: '-no-wiring', dropWiring: true, dropParts: true },
  { name: '-complete', dropWiring: false, dropParts: false },
];
const WANT = arg('variant', 'github'); // github = the two release-asset zips
const VARIANTS =
  WANT === 'complete'
    ? ALL_VARIANTS.filter((v) => !v.dropParts)
    : WANT === 'all'
      ? ALL_VARIANTS
      : ALL_VARIANTS.filter((v) => v.dropParts);

// Offline means offline: the fault lookup data is fetched from Hugging Face by
// the hosted site, so a dist-web straight out of web_export.py does not have
// it. Refuse rather than ship a zip whose README promises fault lookup.
const REQUIRED = [
  'data/faultdb.js',
  'data/faultindex.js',
  'data/faultmeta.js',
  'data/faultinfo.js',
  'data/ista/faulttests.json',
];
const missing = REQUIRED.filter((f) => !existsSync(join(DIST, f)));
if (missing.length) {
  console.error(
    `error: ${DIST} is missing the fault-lookup data, so the build would ` +
      `not be offline:\n  ${missing.join('\n  ')}\n` +
      `Fetch faults/*.js and ista/faulttests.json from the CraigFf/bmweb-etk dataset ` +
      `into ${DIST}/data first (release-web.yml shows how).`
  );
  process.exit(1);
}
if (VARIANTS.some((v) => !v.dropParts)) {
  const n = existsSync(join(DIST, 'data', 'etk'))
    ? readdirSync(join(DIST, 'data', 'etk')).filter((f) => f.endsWith('.etk'))
        .length
    : 0;
  if (n < 200 || !existsSync(join(DIST, 'data', 'etk', 'index.json'))) {
    console.error(
      `error: the complete variant needs the ETK tree in ${DIST}/data/etk ` +
        `(found ${n} .etk bundles, want 246 plus index.json).`
    );
    process.exit(1);
  }
}

// When parts are OFF: a tiny flag file the app reads to hide the parts-catalogue
// (ETK) entry rather than offer a feature this build cannot serve. Loaded before
// app.js, same mechanism as version.js.
const PARTS_OFF_JS = 'window.BMWEB_NO_PARTS=true;\n';
const OFFLINE_JS = 'window.BMWEB_OFFLINE=true;\n';
// What zip stores rather than deflates: the archives whose members are
// deflated already and the images. Deflating these again gains 2-4 % at
// ~45 MB/s. NOT the .etk, .chassis and .docs archives: those store their
// members, so zip -1 still takes 6-13 % off them (0.5 GB of the complete
// build), worth the two minutes.
const STORED_SUFFIXES =
  '.ista:.wiring:.gz:.zip:.jpg:.jpeg:.png:.gif:.webp:.woff2:.spk:.zst';
// What a GitHub release asset may hold. A build over it cannot be attached,
// and finding that out at the upload step wastes the whole run.
const GITHUB_ASSET_MAX = 2 * 1024 * 1024 * 1024;

/**
 * What the SP-Daten in dist-web cover, from their index.
 * @returns {{families: number, chassis: string[], leftOut: string[]}|null}
 *   null when dist-web has none
 */
function readSpdaten() {
  const p = join(DIST, 'data', 'sp-daten', 'index.json');
  if (!existsSync(p)) return null;
  const idx = JSON.parse(readFileSync(p, 'utf8'));
  const chassis = new Set();
  for (const by of Object.values(idx.modules || {}))
    for (const c of Object.keys(by)) chassis.add(c);
  return {
    families: Object.keys(idx.modules || {}).length,
    chassis: [...chassis].sort(),
    leftOut: idx.leftOut || [],
  };
}
const SPDATEN = readSpdaten();
/**
 * The readme lines about WebKFP's files, for a build that does or does not
 * carry them.
 * @param {boolean} inside - whether this build has data/sp-daten
 * @returns {string} the lines
 */
function spdatenLines(inside) {
  if (!SPDATEN)
    return (
      `  - NO SP-Daten (BMW's program and data files). WebKFP flashes from a\n` +
      `    folder you import, or fetches the files when there is internet.\n`
    );
  const what =
    `${SPDATEN.families} module families for ${SPDATEN.chassis.join(', ')}` +
    (SPDATEN.leftOut.length
      ? `;\n    not the head-unit, navigation and telephone images, which do not\n` +
        `    pack (${SPDATEN.leftOut.join(', ')})`
      : '');
  return inside
    ? `  - WebKFP's SP-Daten: ${what}\n`
    : `  - NO SP-Daten in this zip: they are the separate download\n` +
        `    bmweb-${VER}-offline-spdaten.zip, to unzip INTO this folder\n` +
        `    (${what}).\n` +
        `    Without it WebKFP flashes from a folder you import.\n`;
}

/**
 * Write a file in the stage, replacing rather than overwriting it. The stage
 * is hard links to dist-web: writing through an existing name would change
 * dist-web's file too, so the name is removed first.
 * @param {string} path - the file to write
 * @param {string} text - its new contents
 */
function writeFresh(path, text) {
  rmSync(path, { force: true });
  writeFileSync(path, text);
}

/**
 * A byte count as a short human-readable size ("1.5 MB").
 * @param {number} bytes - the size in bytes
 * @returns {string} the formatted size
 */
function humanSize(bytes) {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0,
    n = bytes;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
/**
 * The total size of every file under a directory, recursively.
 * @param {string} dir - the directory to measure
 * @returns {number} the size in bytes
 */
function dirSize(dir) {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else
      try {
        total += statSync(p).size;
      } catch {
        /* skip */
      }
  }
  return total;
}

mkdirSync(OUT, { recursive: true });
const results = [];

// Pack once, for every variant: an overlay of the packed files and the list
// of dist-web's files they stand in for. Then read every packed file back
// through the app's own decoder before any zip may carry it.
const PACKED = process.argv.includes('--no-pack') ? null : join(OUT, 'packed');
/** @type {string[]} */
let REPLACED = [];
if (PACKED) {
  console.log('\n==> packing the data (scripts/build/pack_offline.py)');
  rmSync(PACKED, { recursive: true, force: true });
  execFileSync('python3', ['scripts/build/pack_offline.py', DIST, PACKED], {
    stdio: 'inherit',
  });
  execFileSync('node', ['scripts/build/verify_packs.mjs', '--site', PACKED], {
    stdio: 'inherit',
  });
  REPLACED = JSON.parse(readFileSync(join(PACKED, 'replaced.json'), 'utf8'));
}
/** Every file of the overlay, by its path in the site. @type {string[]} */
const PACKED_FILES = [];
if (PACKED) {
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name), `${rel}${e.name}/`);
      else if (rel) PACKED_FILES.push(rel + e.name);
    }
  };
  walk(PACKED, '');
}

/**
 * The first folder on the way to a path inside a stage that is a symlink,
 * so that the path is really somewhere else.
 * @param {string} stage - the staged build
 * @param {string} rel - a path inside it
 * @returns {string|null} the linked folder, or null when the path is the stage's own
 */
function linkOnTheWay(stage, rel) {
  let at = stage;
  for (const part of rel.split('/').slice(0, -1)) {
    at = join(at, part);
    try {
      if (lstatSync(at).isSymbolicLink()) return at;
    } catch {
      return null; // not there yet: it will be made, inside the stage
    }
  }
  return null;
}

for (const v of VARIANTS) {
  const stageName = `bmweb-${VER}-offline${v.name}`;
  const stage = join(OUT, stageName);
  console.log(`\n==> building ${stageName}`);
  rmSync(stage, { recursive: true, force: true });
  // Stage the whole site, then prune per variant. The stage is HARD LINKS to
  // dist-web, not a copy: the complete variant is ~8 GB, and copying it took
  // longer than zipping it. Pruning unlinks only the stage's names, and the
  // files edited below are replaced (unlinked, then written) rather than
  // written in place, so dist-web is never touched. cp -l is GNU and BSD;
  // a cp without it falls back to a plain copy.
  try {
    execFileSync('cp', ['-al', DIST, stage], { stdio: 'pipe' });
  } catch {
    cpSync(DIST, stage, { recursive: true });
  }

  if (PACKED) {
    // NOTHING HERE MAY REACH OUT OF THE STAGE. The stage is links to
    // dist-web, and a development dist-web has folders that are SYMLINKS to
    // the real data: removing "a replaced file" through one would delete
    // the real file, and laying packs over one would write into the real
    // folder. A built dist-web has no such links. If this one does on any
    // path about to be touched, stop before touching anything.
    const linked = [
      ...new Set(
        [...REPLACED, ...PACKED_FILES]
          .map((rel) => linkOnTheWay(stage, rel))
          .filter(Boolean)
      ),
    ];
    if (linked.length) {
      console.error(
        `error: ${DIST} is a development copy: these folders are links to ` +
          `the real data, and packing would change what they point at:\n  ` +
          linked.map((p) => p.slice(stage.length + 1)).join('\n  ') +
          `\nBuild dist-web first (scripts/build/build-web.sh), or pass --no-pack.`
      );
      rmSync(stage, { recursive: true, force: true });
      process.exit(1);
    }
    // the packed files in, the files they stand in for out
    for (const rel of REPLACED) rmSync(join(stage, rel), { force: true });
    for (const top of readdirSync(PACKED, { withFileTypes: true })) {
      if (!top.isDirectory()) continue;
      const from = join(PACKED, top.name);
      const to = join(stage, top.name);
      mkdirSync(to, { recursive: true });
      try {
        execFileSync('cp', ['-al', `${from}/.`, to], { stdio: 'pipe' });
      } catch {
        cpSync(from, to, { recursive: true });
      }
    }
    console.log(`    packed data in, ${REPLACED.length} archives out`);
  }

  if (v.dropWiring) {
    const w = join(stage, 'data', 'wiring');
    if (existsSync(w)) {
      rmSync(w, { recursive: true, force: true });
      console.log('    dropped data/wiring (WDS diagrams)');
    }
    // also the inline bundle, if a previous export left one
    const wj = join(stage, 'data', 'wiring.js');
    if (existsSync(wj)) rmSync(wj, { force: true });
  }
  // every offline variant carries the flag the app reads to drop features
  // that only make sense online (the remote session). Same mechanism as
  // version.js / no-parts.js: a tiny script before app.js.
  writeFresh(join(stage, 'offline.js'), OFFLINE_JS);
  if (!readFileSync(join(stage, 'index.html'), 'utf8').includes('offline.js')) {
    const html = readFileSync(join(stage, 'index.html'), 'utf8').replace(
      '<head>',
      '<head>\n  <script src="offline.js"></script>'
    );
    writeFresh(join(stage, 'index.html'), html);
  }

  // the release-asset variants leave the SP-Daten to their own zip (below)
  const spdInside = !!SPDATEN && !v.dropParts;
  if (SPDATEN && !spdInside)
    rmSync(join(stage, 'data', 'sp-daten'), { recursive: true, force: true });

  if (v.dropParts) {
    // The catalogue is 5.8 GB and lives only in the complete build; hide the
    // Parts entry here rather than offer a screen that would try the network.
    writeFresh(join(stage, 'no-parts.js'), PARTS_OFF_JS);
    if (
      !readFileSync(join(stage, 'index.html'), 'utf8').includes('no-parts.js')
    ) {
      const html = readFileSync(join(stage, 'index.html'), 'utf8').replace(
        '<head>',
        '<head>\n  <script src="no-parts.js"></script>'
      );
      writeFresh(join(stage, 'index.html'), html);
    }
    const etk = join(stage, 'data', 'etk');
    if (existsSync(etk)) {
      rmSync(etk, { recursive: true, force: true });
      console.log('    dropped data/etk (parts catalogue)');
    }
    console.log('    parts catalogue hidden (see the complete build)');
  }

  // a short readme so the download explains itself
  writeFresh(
    join(stage, 'OFFLINE-README.txt'),
    `BMWeb ${VER} -- offline web build (offline${v.name})\n` +
      `${'='.repeat(48)}\n\n` +
      `HOW TO RUN\n` +
      `  Easiest: unzip, then open index.html in Chrome or Edge. The first time,\n` +
      `  click "Select folder" and choose THIS folder (the one holding\n` +
      `  index.html). The app then loads its car data straight from the folder --\n` +
      `  no internet, no server. It remembers the folder for next time.\n\n` +
      `  Alternative: serve this folder over any static HTTP server (e.g.\n` +
      `  "python3 -m http.server" in this folder, then open the shown URL). Then\n` +
      `  no folder pick is needed.\n\n` +
      `  Why the folder pick: a browser opening index.html directly (file://)\n` +
      `  blocks a page from reading its own data files unless you grant access to\n` +
      `  the folder. Chrome and Edge support this; Safari and Firefox do not, so\n` +
      `  on those use the HTTP-server option above.\n\n` +
      `Nothing in this build fetches from the internet. A K+DCAN cable talks to\n` +
      `the car through the browser (Web Serial, Chrome or Edge).\n\n` +
      `This build includes:\n` +
      `  - full diagnostics (every shipped SGBD), coding, fault memory\n` +
      `  - fault code lookup with English descriptions and ISTA test plans\n` +
      (v.dropWiring
        ? `  - NO wiring diagrams (WDS) -- excluded to keep this build small\n`
        : `  - WDS wiring diagrams (where covered)\n`) +
      (v.dropParts
        ? `  - NO parts catalogue (ETK). It is 5.8 GB, more than a GitHub release\n` +
          `    asset may hold, so the build that has it lives on Hugging Face:\n` +
          `    the "offline-complete" zip linked from the release notes.\n`
        : `  - the ETK parts catalogue, every chassis\n`) +
      spdatenLines(spdInside) +
      `\nVersion ${VER}.\n`
  );

  const size = dirSize(stage);
  const zipPath = join(OUT, `${stageName}.zip`);
  rmSync(zipPath, { force: true });
  console.log(`    staged ${humanSize(size)}, zipping…`);
  // zip from inside OUT so the archive holds "<stageName>/..." not the full
  // path. -n stores the file types that would not shrink (see
  // STORED_SUFFIXES) instead of running deflate over them for nothing.
  execFileSync(
    'zip',
    ['-r', '-q', '-1', '-n', STORED_SUFFIXES, basename(zipPath), stageName],
    { cwd: OUT, stdio: 'inherit' }
  );
  rmSync(stage, { recursive: true, force: true }); // keep only the .zip
  const zsize = statSync(zipPath).size;
  console.log(`    -> ${basename(zipPath)} (${humanSize(zsize)})`);
  if (v.dropParts && zsize > GITHUB_ASSET_MAX) {
    console.error(
      `error: ${basename(zipPath)} is ${humanSize(zsize)}, over the 2 GB a ` +
        `GitHub release asset may hold.`
    );
    process.exit(1);
  }
  results.push({ name: v.name, zip: basename(zipPath), size: zsize });
}

// The SP-Daten add-on: data/sp-daten alone, rooted so that unzipping it
// inside an offline build's folder puts it where the app looks.
if (SPDATEN && VARIANTS.some((v) => v.dropParts)) {
  const stageName = `bmweb-${VER}-offline-spdaten`;
  const stage = join(OUT, stageName);
  console.log(`\n==> building ${stageName}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, 'data'), { recursive: true });
  try {
    execFileSync(
      'cp',
      ['-al', join(DIST, 'data', 'sp-daten'), join(stage, 'data', 'sp-daten')],
      { stdio: 'pipe' }
    );
  } catch {
    cpSync(join(DIST, 'data', 'sp-daten'), join(stage, 'data', 'sp-daten'), {
      recursive: true,
    });
  }
  writeFileSync(
    join(stage, 'SP-DATEN-README.txt'),
    `BMWeb ${VER} -- SP-Daten for the offline web build\n` +
      `${'='.repeat(48)}\n\n` +
      `BMW's program and data files, which WebKFP flashes a module from:\n` +
      `${SPDATEN.families} module families for ${SPDATEN.chassis.join(', ')}.\n\n` +
      `HOW TO ADD IT\n` +
      `  Unzip this INTO the folder of an offline build (the one holding\n` +
      `  index.html), so that its data folder gains data/sp-daten. Any\n` +
      `  bmweb-${VER}-offline build takes it. WebKFP then lists the files\n` +
      `  with no internet.\n\n` +
      `The files are packed (data/sp-daten/packs/*.spk): 40 GB of BMW's\n` +
      `files in a fraction of that. WebKFP unpacks the one it needs and checks\n` +
      `it against the original's length and checksum before using it.\n` +
      (SPDATEN.leftOut.length
        ? `\nNOT INCLUDED: ${SPDATEN.leftOut.join(', ')}. These are head-unit,\n` +
          `navigation and telephone images, already compressed, several GB\n` +
          `between them. WebKFP fetches them when there is internet.\n`
        : '')
  );
  const zipPath = join(OUT, `${stageName}.zip`);
  rmSync(zipPath, { force: true });
  execFileSync(
    'zip',
    [
      '-r',
      '-q',
      '-1',
      '-n',
      STORED_SUFFIXES,
      join('..', basename(zipPath)),
      '.',
    ],
    { cwd: stage, stdio: 'inherit' }
  );
  rmSync(stage, { recursive: true, force: true });
  const zsize = statSync(zipPath).size;
  console.log(`    -> ${basename(zipPath)} (${humanSize(zsize)})`);
  if (zsize > GITHUB_ASSET_MAX) {
    console.error(
      `error: ${basename(zipPath)} is ${humanSize(zsize)}, over the 2 GB a ` +
        `GitHub release asset may hold. Fetch fewer SP-Daten ` +
        `(fetch_spdaten.py --max-module-mb).`
    );
    process.exit(1);
  }
  results.push({ name: '-spdaten', zip: basename(zipPath), size: zsize });
}

if (PACKED) rmSync(PACKED, { recursive: true, force: true });

console.log(`\n==> ${results.length} offline builds in ${OUT}:`);
for (const r of results) {
  console.log(`    ${r.zip.padEnd(40)} ${humanSize(r.size)}`);
}
// emit a machine-readable manifest for the release step
writeFileSync(
  join(OUT, 'manifest.json'),
  JSON.stringify({ version: VER, builds: results }, null, 2)
);
