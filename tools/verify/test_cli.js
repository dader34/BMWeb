#!/usr/bin/env node
// bmweb-cli: the app's tools as an npm command line, built and tested.
//
// The package under cli/ runs copies of the renderer's own scripts (the
// .IPO reader, the .IPS compiler, the job search, the Garage report codec
// and diff) inside a node:vm context. Its build copies those files from
// app/renderer/ and fails when one is missing; its tests load them and
// drive the commands. So a renderer change that breaks one of those files
// for node, or moves one, shows up here rather than in a published package.
//
// Needs cli/node_modules (esbuild, typescript, @types/node): installed from
// cli/package-lock.json when absent. Skips loudly when npm is not on PATH.
//
//   node tools/verify/test_cli.js
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const CLI = path.join(ROOT, 'cli');

/**
 * Run an npm script inside cli/ and fail this test on a non-zero exit.
 * @param {string[]} args - the npm arguments
 * @returns {void}
 */
function npm(args) {
  const r = spawnSync('npm', args, { cwd: CLI, stdio: 'inherit' });
  if (r.error && r.error.code === 'ENOENT') {
    console.log('  skip  npm is not on PATH');
    process.exit(0);
  }
  if (r.status !== 0) {
    console.log(`  cli  FAIL: npm ${args.join(' ')} exited ${r.status}`);
    process.exit(1);
  }
}

if (!fs.existsSync(path.join(CLI, 'node_modules', '@types', 'node'))) {
  // a fresh clone: the package's own dev tooling is not in the root install
  npm(['ci', '--no-audit', '--no-fund', '--silent']);
}
npm(['run', 'build', '--silent']);
npm(['test', '--silent']);

// the tarball must carry only the project's own files: the built binary,
// the copied runtime, the README and the licence. --ignore-scripts: the
// build just ran, and prepack's own output would land ahead of the JSON.
const pack = spawnSync(
  'npm',
  ['pack', '--dry-run', '--json', '--ignore-scripts'],
  { cwd: CLI, encoding: 'utf8' }
);
if (pack.status !== 0) {
  console.log('  cli  FAIL: npm pack --dry-run failed');
  process.exit(1);
}
const json = pack.stdout.slice(pack.stdout.indexOf('['));
const files = JSON.parse(json)[0].files.map((f) => f.path);
const allowed = /^(dist\/|runtime\/|README\.md$|LICENSE$|package\.json$)/;
const stray = files.filter((f) => !allowed.test(f));
if (stray.length) {
  console.log(`  cli  FAIL: tarball carries ${stray.join(', ')}`);
  process.exit(1);
}
// ...except the app's own home script and its include (app/renderer/home/,
// written by the project), which ship so `ipo info` can read them
const vendorish = files.filter(
  (f) => /\.(prg|ipo|ips|src|h)$/i.test(f) && !/^runtime\/home\//.test(f)
);
if (vendorish.length) {
  console.log(
    `  cli  FAIL: BMW-format files in the tarball: ${vendorish.join(', ')}`
  );
  process.exit(1);
}
console.log(`  cli  ok (${files.length} files in the tarball)`);
