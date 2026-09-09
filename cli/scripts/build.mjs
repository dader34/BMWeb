// Bundle the CLI and its tests with esbuild.
//
// One file per entry: src/bmweb.ts becomes dist/bmweb.js (the `bmweb`
// binary, with a shebang) and each test/*.test.ts becomes dist-test/*.test.js
// so `node --test` runs them on any Node the package supports without a
// TypeScript loader. The version is baked in from package.json at build time
// so the binary never reads its own package.json at run time.
//
//   node scripts/build.mjs
import { build } from 'esbuild';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(CLI, 'package.json'), 'utf8'));

/** Options every bundle shares. */
const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  define: { __BMWEB_VERSION__: JSON.stringify(pkg.version) },
  // serialport carries a native binding found on disk at run time; bundling
  // it breaks that lookup, so it stays a real import from node_modules (and
  // an optional one: the offline commands never reach it)
  external: ['serialport'],
  logLevel: 'warning',
};

await build({
  ...common,
  entryPoints: [join(CLI, 'src', 'bmweb.ts')],
  outfile: join(CLI, 'dist', 'bmweb.js'),
  banner: { js: '#!/usr/bin/env node' },
});

const tests = readdirSync(join(CLI, 'test'))
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => join(CLI, 'test', f));
await build({
  ...common,
  entryPoints: tests,
  outdir: join(CLI, 'dist-test'),
});
console.log(
  `build: dist/bmweb.js v${pkg.version}, ${tests.length} test bundles`
);
