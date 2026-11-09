#!/usr/bin/env node
// The ES-module screens reach the classic scripts through
// screens/*/shell.mjs, which reads each name off globalThis when called. A
// top-level `function` lands there by itself; a top-level `const`/`let` does
// not (and the prod minifier renames it), so each one the shells read must be
// put there by name (`globalThis.X = X;`). Prod's Wiring & Documents broke on
// exactly this (`c.esc is not a function`).
//
// Run: node tools/verify/test_shell_globals.js
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '../../app/renderer');
const walk = (d) =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory())
      return e.name === 'generated' || e.name === 'node_modules' ? [] : walk(p);
    return e.name.endsWith('.js') && p !== path.join(root, 'bundle.js')
      ? [p]
      : [];
  });
const files = walk(root).map((p) => [p, fs.readFileSync(p, 'utf8')]);
const shells = ['screens/wiring/shell.mjs', 'screens/etk/shell.mjs'].map((f) =>
  fs.readFileSync(path.join(root, f), 'utf8')
);
const names = new Set(
  shells.flatMap((s) =>
    [...s.matchAll(/\bg\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1])
  )
);
const bad = [];
for (const n of names) {
  const decl = new RegExp(`^(?:const|let)\\s+${n}\\b`, 'm');
  const exposed = new RegExp(`^globalThis\\.${n}\\s*=\\s*${n}\\s*;`, 'm');
  const lexical = files.filter(([, s]) => decl.test(s));
  if (lexical.length && !lexical.some(([, s]) => exposed.test(s)))
    bad.push(`${n} (${path.relative(root, lexical[0][0])})`);
}
if (bad.length) {
  console.error(
    'shell globals declared const/let but not put on globalThis:\n  ' +
      bad.join('\n  ')
  );
  process.exit(1);
}
console.log(`ALL PASS (${names.size} shell globals reachable)`);
