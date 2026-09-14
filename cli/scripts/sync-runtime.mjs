// Copy the renderer scripts the CLI runs into cli/runtime/.
//
// The CLI reuses the app's own code (the .IPO reader, the .IPS compiler, the
// job search, the Garage report codec and diff) rather than a port of it, so
// there is exactly one implementation to keep right. Those files live in
// app/renderer/ and the npm tarball has to be self-contained, so a build
// copies the exact list in src/runtime-files.json here. runtime/ is
// gitignored: the repo keeps one source of truth, the tarball keeps a copy.
//
// The list is in index.html load order, which matters: the files are plain
// browser scripts sharing one global scope, and a later one reads the
// earlier ones' top-level names. A listed file that is missing fails the
// build rather than shipping a runtime that throws on first use.
//
//   node scripts/sync-runtime.mjs
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..');
const REPO = join(CLI, '..');
const RENDERER = join(REPO, 'app', 'renderer');
const OUT = join(CLI, 'runtime');

/**
 * The renderer files the CLI needs, relative to app/renderer, in load order.
 * @returns {string[]}
 */
function runtimeFiles() {
  return JSON.parse(
    readFileSync(join(CLI, 'src', 'runtime-files.json'), 'utf8')
  );
}

/**
 * Copy the listed files, failing on any that is missing.
 * @returns {number} how many files were copied
 */
function sync() {
  const files = runtimeFiles();
  const missing = files.filter((rel) => !existsSync(join(RENDERER, rel)));
  if (missing.length) {
    console.error(
      `sync-runtime: missing under app/renderer: ${missing.join(', ')}`
    );
    process.exit(1);
  }
  // start clean so a file dropped from the list does not linger in the tarball
  rmSync(OUT, { recursive: true, force: true });
  for (const rel of files) {
    const dst = join(OUT, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(join(RENDERER, rel), dst);
  }
  // the package is licensed as the repo is; npm wants the file in the package dir
  copyFileSync(join(REPO, 'LICENSE'), join(CLI, 'LICENSE'));
  return files.length;
}

const n = sync();
console.log(`sync-runtime: ${n} files copied to cli/runtime/`);
