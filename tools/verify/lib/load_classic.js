// Load a folder of the renderer's classic scripts into the shared global
// scope, the way the page does.
//
// The renderer ships as plain <script> files sharing one global scope; a
// file split into a folder of pieces (core/ipovm/, screens/ipo-runtime/)
// has each piece reading the earlier ones' top-level names, and a later
// folder reading an earlier folder's. require() gives every file its own
// module scope, so requiring one piece cannot see the rest. This
// concatenates the pieces in index.html order (the load order the page and
// the bundler use) and evaluates them in the process's global scope -- a
// top-level function/const/class becomes a global binding exactly as a
// <script> tag's does -- then returns the union of every piece's
// `module.exports`.
//
//   const { loadClassic } = require('./lib/load_classic.js');
//   const { IpoVm, FeedHost } = loadClassic('core/ipovm/');
//   const RT = loadClassic('screens/ipo-runtime/'); // sees the VM's names
//
// A harness sets the browser globals a piece leans on (window, document,
// esc, ...) before loading, exactly as it did for the single files. Each
// prefix loads once per process: a second load would redeclare its names.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RENDERER = path.join(__dirname, '..', '..', '..', 'app', 'renderer');

/**
 * The renderer scripts index.html loads under a path prefix, in load order.
 * @param {string} prefix - e.g. 'core/ipovm/'
 * @returns {string[]} paths relative to app/renderer
 */
function rendererScripts(prefix) {
  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
  return [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
    .map((m) => m[1])
    .filter((s) => s.startsWith(prefix));
}

/**
 * Evaluate the pieces under a prefix in the global scope.
 * @param {string} prefix - e.g. 'core/ipovm/'
 * @returns {Record<string, *>} the union of the pieces' module.exports
 */
function loadClassic(prefix) {
  const srcs = rendererScripts(prefix);
  if (!srcs.length)
    throw new Error(`no <script> under ${prefix} in index.html`);
  const body = srcs
    .map(
      (rel) =>
        `\n;/* ==== ${rel} ==== */\n` +
        fs.readFileSync(path.join(RENDERER, rel), 'utf8') +
        '\n'
    )
    .join('');
  // each piece assigns module.exports = {...}; a global `module` collects
  // the union for as long as the pieces run, so the last piece can
  // re-export the API the single file had and the others can export what
  // only their siblings use
  const collected = {};
  const collector = {
    get exports() {
      return collected;
    },
    set exports(v) {
      Object.assign(collected, v);
    },
  };
  const had = Object.prototype.hasOwnProperty.call(global, 'module');
  const prev = global.module;
  global.module = collector;
  try {
    vm.runInThisContext(body, { filename: `${prefix}*` });
  } finally {
    if (had) global.module = prev;
    else delete global.module;
  }
  return collected;
}

module.exports = { rendererScripts, loadClassic };
