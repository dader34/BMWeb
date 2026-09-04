#!/usr/bin/env node
// Guard against cross-file global-name collisions in the renderer.
//
// The renderer ships as one concatenated bundle (scripts/build/bundle-renderer.mjs)
// and, until the full ESM migration, all files share one global scope. That
// means two files declaring the same top-level name is a real bug: the
// later-loaded one silently wins, and a caller that meant the earlier one gets
// the wrong function (this is exactly how the endSession / variantLabel bugs
// happened -- see the Stage 1 fix). ESM would make this a compile error; until
// then, this test is that compile error. It also protects the concatenated
// bundle, where two top-level `const`/`let`/`class` of the same name would throw
// at load ("Identifier X has already been declared").
//
// It reads the load order from index.html (the same source bundle-renderer.mjs
// uses) and flags any name declared at top level in more than one file.
//
// Run: node tools/verify/test_global_collisions.js
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const RENDERER = path.join(ROOT, 'app', 'renderer');

const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
const srcs = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((m) => m[1])
  .filter((s) => !/^https?:\/\//.test(s) && s !== 'version.js');

// top-level declarations only: a keyword at column 0 (the codebase indents every
// nested declaration, so column-0 == top level). Covers function/class/const/
// let/var; `const`/`let` are the ones that hard-throw in a shared scope.
const declRe =
  /^(?:async function|function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;

const owner = new Map(); // name -> first file that declared it
const collisions = [];
for (const rel of srcs) {
  let code;
  try {
    code = fs.readFileSync(path.join(RENDERER, rel), 'utf8');
  } catch (e) {
    continue; // a data/ file that index.html lists but isn't present locally
  }
  const names = new Set();
  let m;
  while ((m = declRe.exec(code))) names.add(m[1]);
  for (const n of names) {
    if (owner.has(n)) {
      collisions.push({ name: n, first: owner.get(n), second: rel });
    } else {
      owner.set(n, rel);
    }
  }
}

if (collisions.length) {
  console.error(
    `global-collisions: FAILED -- ${collisions.length} cross-file top-level ` +
      `name collision(s). In the shared global scope the later file wins; ` +
      `rename one (see the Stage 1 endSession/variantLabel fix):`
  );
  for (const c of collisions) {
    console.error(`  ${c.name}: ${c.first}  vs  ${c.second}`);
  }
  process.exit(1);
}

console.log(
  `global-collisions: ok -- ${owner.size} top-level names across ` +
    `${srcs.length} files, no collisions`
);
