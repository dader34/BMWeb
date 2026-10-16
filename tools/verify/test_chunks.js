#!/usr/bin/env node
// The deployed site loads the parts named in scripts/build/chunks.json only
// when one of their entry functions is first called (bundle-renderer.mjs
// --split). That is safe only while the rest of the app reaches a part
// through those entries: a call to anything else in it, or any use of it
// while the page loads, would be a ReferenceError on the live site and
// nowhere else (the dev page loads every file). This holds the code to it.
//
// Run: node tools/verify/test_chunks.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const R = path.join(ROOT, 'app', 'renderer');
const from = (m) =>
  require(
    require.resolve(m, { paths: [path.join(ROOT, 'node_modules/eslint')] })
  );
const espree = from('espree');
const eslintScope = from('eslint-scope');

let passed = 0;
const ok = (m) => {
  passed++;
  console.log(`  ok    ${m}`);
};

const chunks = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'scripts/build/chunks.json'), 'utf8')
);
const html = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
const srcs = [...html.matchAll(/<script\s+src="([^"]+)"><\/script>/g)]
  .map((m) => m[1])
  .filter((s) => !/^https?:/.test(s) && s !== 'version.js');
const chunkOf = (rel) =>
  Object.keys(chunks).find((c) =>
    chunks[c].include.some((p) =>
      p.endsWith('/') ? rel.startsWith(p) : rel === p
    )
  );

// every file's global definitions and its references to other files' globals
const defs = new Map();
const files = {};
for (const rel of srcs) {
  const code = fs.readFileSync(path.join(R, rel), 'utf8');
  const ast = espree.parse(code, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    range: true,
  });
  const g = eslintScope.analyze(ast, { ecmaVersion: 2022 }).globalScope;
  const kinds = new Map();
  for (const n of ast.body) {
    if (n.type === 'FunctionDeclaration') kinds.set(n.id.name, 'function');
    if (n.type === 'VariableDeclaration')
      for (const d of n.declarations)
        if (d.id.type === 'Identifier') kinds.set(d.id.name, n.kind);
  }
  const mine = new Set(g.variables.map((v) => v.name));
  for (const n of mine)
    if (!defs.has(n)) defs.set(n, { file: rel, kind: kinds.get(n) });
  const parent = new Map();
  (function walk(n, p) {
    if (!n || typeof n.type !== 'string') return;
    parent.set(n, p);
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => walk(c, n));
      else if (v && typeof v.type === 'string') walk(v, n);
    }
  })(ast, null);
  const refs = [];
  (function collect(scope) {
    for (const r of scope.references) {
      if (r.resolved && r.resolved.scope !== g) continue;
      const name = r.identifier.name;
      if (r.resolved && mine.has(name)) continue;
      const p0 = parent.get(r.identifier);
      const isTypeof =
        p0 && p0.type === 'UnaryExpression' && p0.operator === 'typeof';
      let n = r.identifier;
      let inFn = false;
      while ((n = parent.get(n)))
        if (/Function/.test(n.type)) {
          inFn = true;
          break;
        }
      const line = code.slice(0, r.identifier.range[0]).split('\n').length;
      refs.push({ name, isTypeof, inFn, line });
    }
    scope.childScopes.forEach(collect);
  })(g);
  files[rel] = refs;
}

for (const [chunk, spec] of Object.entries(chunks)) {
  const members = srcs.filter((s) => chunkOf(s) === chunk);
  assert(members.length, `${chunk}: no file of index.html is in it`);
  for (const p of spec.include)
    assert(
      srcs.some((s) => (p.endsWith('/') ? s.startsWith(p) : s === p)),
      `${chunk}: ${p} matches no script index.html loads`
    );

  // the entries are functions the part declares
  for (const fn of Object.keys(spec.entries)) {
    const d = defs.get(fn);
    assert(
      d && chunkOf(d.file) === chunk,
      `${chunk}: ${fn} is not declared in it`
    );
    assert.strictEqual(
      d.kind,
      'function',
      `${chunk}: ${fn} must be a function declaration (its stub is replaced by redeclaring it)`
    );
  }
  ok(
    `${chunk}: ${members.length} files; its ${Object.keys(spec.entries).length} entries are functions it declares`
  );

  // the rest of the app touches nothing else in it, and nothing at load time
  const bad = [];
  for (const rel of srcs) {
    if (chunkOf(rel) === chunk) continue;
    for (const r of files[rel]) {
      const d = defs.get(r.name);
      if (!d || chunkOf(d.file) !== chunk) continue;
      if (!r.inFn && !r.isTypeof)
        bad.push(`${rel}:${r.line} uses ${r.name} while the page loads`);
      else if (!r.isTypeof && !spec.entries[r.name])
        bad.push(`${rel}:${r.line} calls ${r.name}, which is not an entry`);
    }
  }
  assert.deepStrictEqual(
    bad,
    [],
    `${chunk}: reached other than through its entries:\n  ` + bad.join('\n  ')
  );
  ok(`${chunk}: the rest of the app reaches it only through its entries`);
}

// a split build: the bundle lacks the parts, carries the stubs, and each
// part is written beside it
{
  const os = require('os');
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmweb-chunks-'));
  execFileSync(
    'node',
    [
      path.join(ROOT, 'scripts/build/bundle-renderer.mjs'),
      R,
      path.join(dir, 'bundle.js'),
      '--split',
    ],
    { stdio: 'ignore' }
  );
  const main = fs.readFileSync(path.join(dir, 'bundle.js'), 'utf8');
  for (const [chunk, spec] of Object.entries(chunks)) {
    const part = fs.readFileSync(path.join(dir, `bundle-${chunk}.js`), 'utf8');
    for (const rel of srcs.filter((s) => chunkOf(s) === chunk)) {
      assert(part.includes(`/* ==== ${rel} ==== */`), `${rel} not in its part`);
      assert(
        !main.includes(`/* ==== ${rel} ==== */`),
        `${rel} in the bundle too`
      );
    }
    for (const fn of Object.keys(spec.entries))
      assert(
        new RegExp(`\\bfunction ${fn}\\(`).test(main),
        `no stub for ${fn}`
      );
  }
  fs.rmSync(dir, { recursive: true, force: true });
  ok('a split build leaves each part out of the bundle, with a stub per entry');
}

console.log(`\n${passed} passed`);
