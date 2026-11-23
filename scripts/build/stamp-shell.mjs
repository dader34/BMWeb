#!/usr/bin/env node
/**
 * @file Turn a copied renderer into the shipped shell: version, bundle, page.
 */
// Every build ends the same way, once the renderer's files are in the dist
// tree: say which version this is, concatenate the scripts into one bundle,
// and collapse the page's script tags onto it. Those three steps were
// written out four times (build-web.sh, ci-dist-web.sh, deploy-inplace.sh
// and inline in pages.yml) and had already drifted once: the Pages deploy
// skipped the version stamp, so every beta report said app "dev". This is
// the one copy.
//
//   node scripts/build/stamp-shell.mjs <dist> [--src <dir>] [--minify] [--split]
//                                             [--sw-cache <name>]
//
//   <dist>              the tree being built; its index.html is rewritten
//   --src <dir>         where the scripts are read from (default: <dist>,
//                       which holds a copy of the renderer). The in-place
//                       deploy reads the working tree instead.
//   --minify, --split   passed to bundle-renderer.mjs (the deployed site)
//   --sw-cache <name>   name the service worker's shell cache after this
//                       build, so a release drops the last one's cached shell
//
// ONE VERSION SOURCE: package.json. version.js sets window.BMWEB_VERSION and
// is its own <script> at the top of <head>, ahead of everything that reads
// it; it is not part of the bundle (bundle-index.mjs leaves the tag alone).
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const args = process.argv.slice(2);
/** The value after a flag, removed from the argument list with it. */
const option = (flag) => {
  const at = args.indexOf(flag);
  if (at < 0) return null;
  const value = args[at + 1];
  if (!value || value.startsWith('--')) {
    console.error(`stamp-shell: ${flag} needs a value`);
    process.exit(1);
  }
  args.splice(at, 2);
  return value;
};
const src = option('--src');
const swCache = option('--sw-cache');
const flags = args.filter((a) => a.startsWith('--'));
const [dist] = args.filter((a) => !a.startsWith('--'));
const unknown = flags.filter((f) => f !== '--minify' && f !== '--split');
if (!dist || unknown.length) {
  console.error(
    unknown.length
      ? `stamp-shell: unknown option ${unknown.join(' ')}`
      : 'usage: stamp-shell.mjs <dist> [--src <dir>] [--minify] [--split] [--sw-cache <name>]'
  );
  process.exit(1);
}

const { version } = JSON.parse(
  readFileSync(join(ROOT, 'package.json'), 'utf8')
);
if (!version) {
  console.error('stamp-shell: package.json has no version');
  process.exit(1);
}
writeFileSync(
  join(dist, 'version.js'),
  `window.BMWEB_VERSION=${JSON.stringify(version)};\n`
);

// the tag, right after the opening <head>: cheap, and before app.js reads it
const page = join(dist, 'index.html');
let html = readFileSync(page, 'utf8');
if (!html.includes('version.js')) {
  if (!html.includes('<head>')) {
    console.error(`stamp-shell: ${page} has no <head> to put version.js in`);
    process.exit(1);
  }
  html = html.replace('<head>', '<head>\n  <script src="version.js"></script>');
  writeFileSync(page, html);
}

const node = (script, ...rest) =>
  execFileSync(process.execPath, [join(HERE, script), ...rest], {
    stdio: 'inherit',
  });
node('bundle-renderer.mjs', src || dist, join(dist, 'bundle.js'), ...flags);
node('bundle-index.mjs', page);
if (!readFileSync(page, 'utf8').includes('bundle.js')) {
  console.error(`stamp-shell: ${page} does not load bundle.js`);
  process.exit(1);
}

if (swCache) {
  const sw = join(dist, 'sw.js');
  const was = readFileSync(sw, 'utf8');
  const now = was.replace(
    /const SHELL_CACHE = '[^']*'/,
    `const SHELL_CACHE = '${swCache}'`
  );
  if (!now.includes(`'${swCache}'`)) {
    console.error(`stamp-shell: ${sw} declares no SHELL_CACHE to name`);
    process.exit(1);
  }
  writeFileSync(sw, now);
}
console.log(`stamp-shell: ${dist} is ${version}`);
