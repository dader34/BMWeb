#!/usr/bin/env node
// Build the single-file release, headlessly.
//
//   node tools/export/build_single.js <CHASSIS|all> <outdir> [--faults]
//
// The exporter (app/renderer/core/offline-export.js) was written to run in
// the browser tab: it fetches the app's own files from beside the page and
// hands back a Blob. That is the right place for it -- the user picks a car
// and gets a download with no server involved -- but it means the artifact
// only exists if someone opens the app and clicks a button.
//
// CI needs the same file without a browser. Rather than keep a second
// implementation in step with the first (they would drift, and the drift
// would be silent), this runs the REAL exporter in a VM context with the
// four browser things it touches stubbed: fetch, Blob, URL and document.
// One implementation, two callers.
//
// Reads dist-web/, so scripts/build/build-web.sh runs first.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const [, , which = 'E46', outDir = 'dist-single', ...rest] = process.argv;
const withFaults = rest.includes('--faults');
// Wiring roughly SEVENS the file (13 MB -> 85 MB for an E46), so it is a
// separate artifact rather than a bigger default. CI publishes both where
// the data exists and the installer lets the user pick.
const withWiring = rest.includes('--wiring');
const ROOT = process.env.BMWEB_DIST || 'dist-web';

if (!fs.existsSync(ROOT)) {
  console.error(`no ${ROOT}/ -- run scripts/build/build-web.sh first`);
  process.exit(1);
}

// The exporter asks for paths relative to the page. Serve them off disk.
const get = async (u) => {
  const rel = String(u).replace(/^FILEBASE\//, '').replace(/^\//, '');
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return { ok: false, status: 404 };
  const b = fs.readFileSync(p);
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length),
    json: async () => JSON.parse(b.toString()),
    text: async () => b.toString(),
  };
};

function makeContext() {
  let saved = null;
  const ctx = {
    console, TextDecoder, TextEncoder, btoa, Uint8Array, JSON, Error,
    Promise, String, Object, Array, RegExp, Math, setTimeout,
  };
  ctx.window = ctx;
  ctx.fetch = get;
  ctx.webRealFetch = get;
  ctx.Blob = class { constructor(parts) { saved = parts[0]; } };
  ctx.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
  ctx.document = {
    createElement: () => ({ click() {}, remove() {} }),
    body: { appendChild() {} },
  };
  ctx.location = {
    href: 'http://x/index.html', pathname: '/index.html',
    protocol: 'http:', search: '',
  };
  vm.createContext(ctx);
  vm.runInContext(
    fs.readFileSync('app/renderer/core/offline-export.js', 'utf8'), ctx);
  // offlineBase() derives from location.pathname in the browser; pin it so
  // the fetch stub above sees a predictable prefix.
  vm.runInContext('offlineBase=()=>"FILEBASE";', ctx);
  return { ctx, saved: () => saved };
}

(async () => {
  let ids;
  if (which === 'all') {
    ids = JSON.parse(fs.readFileSync(
      path.join(ROOT, 'api', 'chassis.json'), 'utf8'));
  } else {
    ids = [which];
  }
  fs.mkdirSync(outDir, { recursive: true });

  let failed = 0;
  for (const id of ids) {
    // A FRESH CONTEXT PER CAR. The exporter caches parsed chassis archives
    // in module scope, so reusing one context across 27 cars would hold
    // every car's data in memory at once.
    const { ctx, saved } = makeContext();
    const suffix = withWiring ? '-wiring' : '';
    const out = path.join(outDir, `bmweb-${id.toLowerCase()}${suffix}.html`);
    try {
      const n = await ctx.offlineSingleFile(id, withFaults, () => {},
                                            withWiring);
      fs.writeFileSync(out, Buffer.from(saved()));
      console.log(`${id.padEnd(8)} ${(n / 1048576).toFixed(1)} MB  ${out}`);
    } catch (e) {
      failed++;
      console.error(`${id.padEnd(8)} FAILED: ${e.message}`);
    }
  }
  if (failed) {
    console.error(`\n${failed} of ${ids.length} failed`);
    process.exit(1);
  }
  console.log(`\n${ids.length} file(s) -> ${outDir}`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
