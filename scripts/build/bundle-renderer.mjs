#!/usr/bin/env node
/**
 * @file Concatenate the renderer's classic script files in index.html order.
 */
// Bundle the renderer's classic <script> files into ONE file, in the exact
// order index.html loads them. The renderer still shares one global scope (the
// full ESM migration is a later step), so this is a faithful concatenation, not
// a module bundle: same globals, same order, identical behaviour -- but 50+
// <script> tags collapse to one, and the offline exporter no longer needs its
// hand-maintained OFFLINE_SHELL mirror.
//
//   node scripts/build/bundle-renderer.mjs [srcdir] [outfile] [--minify] [--split]
//
// --split (the deployed site) leaves the parts named in chunks.json out of
// the bundle and writes each as bundle-<name>.js beside it, loaded the first
// time one of its entry functions is called: the bundle carries a stub of
// that name which loads the part, whose own declaration then replaces it.
// A stub marked "noop" just returns (the part cannot be running yet); its
// body is not empty, or the minifier deletes the calls to it.
//
// --minify (the deployed site) shrinks it with esbuild and writes
// <outfile>.map beside it. Top-level names are kept as they are -- the files
// share one global scope, and the router and the HTML's handlers look them
// up by name -- and no helper is added at the top level; only locals,
// whitespace and syntax shrink. Stack traces map back through the .map to
// the concatenated bundle, whose ==== labels name each file.
//
// The order is read FROM index.html (its <script src> sequence), so the bundle
// can never drift from what the page loads -- index.html stays the single source
// of truth for load order. vendor/ and any data/*.js that index.html pulls are
// included verbatim just like the app's own files.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const MINIFY = args.includes('--minify');
const SPLIT = args.includes('--split');
const pos = args.filter((a) => !a.startsWith('--'));
const SRC = pos[0] || join(ROOT, 'app/renderer');
const OUT = pos[1] || join(SRC, 'bundle.js');

const html = readFileSync(join(SRC, 'index.html'), 'utf8');
// every <script src="..."></script> in document order (local srcs only).
// version.js is excluded: it is injected separately into <head> to set
// window.BMWEB_VERSION before anything reads it, and stays its own tag (see
// bundle-index.mjs) rather than being folded into the bundle.
const srcs = [...html.matchAll(/<script\s+src="([^"]+)"><\/script>/g)]
  .map((m) => m[1])
  .filter((s) => !/^https?:\/\//.test(s) && s !== 'version.js');

const chunks = SPLIT
  ? JSON.parse(readFileSync(join(ROOT, 'scripts/build/chunks.json'), 'utf8'))
  : {};
const chunkOf = (rel) =>
  Object.keys(chunks).find((c) =>
    chunks[c].include.some((p) =>
      p.endsWith('/') ? rel.startsWith(p) : rel === p
    )
  );

/**
 * The files concatenated, each wrapped and labelled.
 * @param {string[]} list
 * @param {string} head
 * @returns {string}
 */
function concat(list, head) {
  const parts = [head];
  for (const rel of list) {
    let code;
    try {
      code = readFileSync(join(SRC, rel), 'utf8');
    } catch (e) {
      console.error(`bundle: missing ${rel}`);
      process.exit(1);
    }
    // wrap each file so a stray missing semicolon at EOF can't fuse two
    // files, and label it for stack traces
    parts.push(`\n;/* ==== ${rel} ==== */\n${code}\n`);
  }
  return parts.join('');
}

/**
 * The loader and the entry stubs, appended to the main bundle.
 * @returns {string}
 */
function loaderCode() {
  const out = [
    '\n;/* ==== chunk loader (bundle-renderer.mjs --split) ==== */',
    'var __bmwebChunks = {};',
    'function __bmwebChunk(name) {',
    '  if (!__bmwebChunks[name])',
    '    __bmwebChunks[name] = new Promise((resolve, reject) => {',
    "      const s = document.createElement('script');",
    "      s.src = 'bundle-' + name + '.js';",
    '      s.onload = () => resolve();',
    '      s.onerror = () => {',
    '        delete __bmwebChunks[name];',
    "        reject(new Error('could not load the ' + name + ' part of the app'));",
    '      };',
    '      document.head.appendChild(s);',
    '    });',
    '  return __bmwebChunks[name];',
    '}',
  ];
  for (const [chunk, spec] of Object.entries(chunks))
    for (const [fn, how] of Object.entries(spec.entries))
      out.push(
        how === 'noop'
          ? // not an empty body: the minifier deletes calls to an empty
            // function, so the part's own declaration would never be reached
            `function ${fn}() {\n  return __bmwebChunks.__noop;\n}`
          : `function ${fn}(...args) {\n` +
              `  const stub = ${fn};\n` +
              `  return __bmwebChunk(${JSON.stringify(chunk)}).then(() => {\n` +
              `    if (${fn} === stub) throw new Error(${JSON.stringify(`${chunk}: ${fn} is not in its part`)});\n` +
              `    return ${fn}(...args);\n` +
              '  });\n' +
              '}'
      );
  // warm the parts into the worker's cache once the app has settled, so an
  // offline session still has them
  out.push(
    'setTimeout(() => {',
    "  if (typeof fetch !== 'function' || (navigator.connection && navigator.connection.saveData)) return;",
    `  for (const name of ${JSON.stringify(Object.keys(chunks))})`,
    "    fetch('bundle-' + name + '.js').catch(() => {});",
    '}, 8000);'
  );
  return out.join('\n') + '\n';
}

/**
 * Write one output file, minified with a source map when asked.
 * @param {string} out
 * @param {string} code
 * @returns {Promise<string>} A size note.
 */
async function emit(out, code) {
  if (!MINIFY) {
    writeFileSync(out, code);
    return `${(code.length / 1024).toFixed(0)} KB`;
  }
  const { transform } = await import('esbuild');
  const r = await transform(code, {
    loader: 'js',
    minify: true,
    // as written: no lowering, so no helpers are added at the top level
    target: 'esnext',
    sourcemap: 'external',
    sourcefile: basename(out).replace(/\.js$/, '.src.js'),
    legalComments: 'none',
  });
  writeFileSync(out, r.code + `//# sourceMappingURL=${basename(out)}.map\n`);
  writeFileSync(out + '.map', r.map);
  return `${(code.length / 1024).toFixed(0)} KB, minified ${(r.code.length / 1024).toFixed(0)} KB`;
}

const head =
  '// GENERATED by scripts/build/bundle-renderer.mjs -- do not edit.\n' +
  '// Concatenation of the renderer scripts in index.html load order.\n';
const main = srcs.filter((s) => !chunkOf(s));
const note = await emit(OUT, concat(main, head) + (SPLIT ? loaderCode() : ''));
console.log(
  `bundled ${main.length} scripts -> ${OUT.replace(ROOT + '/', '')} (${note})`
);
for (const chunk of Object.keys(chunks)) {
  const list = srcs.filter((s) => chunkOf(s) === chunk);
  const out = join(dirname(OUT), `bundle-${chunk}.js`);
  const n = await emit(
    out,
    concat(
      list,
      head.replace(
        'index.html load order',
        `index.html load order: the ${chunk} part`
      )
    )
  );
  console.log(
    `  part ${chunk}: ${list.length} scripts -> ${out.replace(ROOT + '/', '')} (${n})`
  );
}
