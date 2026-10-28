// The committed builds of the ES module directories (core/generated/*.js
// from scripts/build/modules.json) match a fresh build. A module edited
// without `npm run build` would ship its old self: the page and the
// offline export load the committed file, not the source.
//
// Run: node tools/verify/test_modules_built.js
const { spawnSync } = require('child_process');
const path = require('path');

const r = spawnSync(
  process.execPath,
  [
    path.join(__dirname, '..', '..', 'scripts', 'build', 'bundle-modules.mjs'),
    '--check',
  ],
  { encoding: 'utf8' }
);
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);
if (r.status !== 0) {
  console.log('FAILED: a module build is stale');
  process.exit(1);
}
console.log('1 checks passed');
