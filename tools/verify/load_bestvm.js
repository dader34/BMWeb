// Load the BEST2 VM into a vm context the way the browser loads it.
//
// The VM ships as several classic-script pieces (app/renderer/core/bestvm/)
// that share one global scope; a harness that runs it in a vm context has to
// run every piece, in the order index.html does. The order is read FROM
// index.html so this loader cannot drift from what the page loads.
//
//   const { loadBestvm } = require('./load_bestvm.js');
//   const ctx = { module: { exports: {} }, console };
//   vm.createContext(ctx);
//   const { Best2Vm, isWriteJob } = loadBestvm(ctx);
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const RENDERER = path.join(ROOT, 'app', 'renderer');

// the bestvm/ <script src> tags, in document order
const BESTVM_PIECES = [
  ...fs
    .readFileSync(path.join(RENDERER, 'index.html'), 'utf8')
    .matchAll(/<script src="(core\/bestvm\/[^"]+)"><\/script>/g),
].map((m) => m[1]);

if (!BESTVM_PIECES.length) {
  throw new Error('load_bestvm: index.html lists no core/bestvm/ scripts');
}

/**
 * Run every VM piece inside `ctx` (an existing vm context) and return the
 * public surface index.js exported into `ctx.module.exports`, or the
 * context's globals when the caller gave it no `module`.
 * @param {object} ctx - A context created with vm.createContext.
 * @returns {object} The VM's exports (Best2Vm, VmError, isWriteJob, ...).
 */
function loadBestvm(ctx) {
  for (const rel of BESTVM_PIECES) {
    vm.runInContext(fs.readFileSync(path.join(RENDERER, rel), 'utf8'), ctx, {
      filename: rel,
    });
  }
  return ctx.module && ctx.module.exports ? ctx.module.exports : ctx;
}

/**
 * The concatenated source of every piece, for harnesses that `eval` the VM
 * into their own scope.
 * @returns {string} The pieces' source, in load order.
 */
function bestvmSource() {
  return BESTVM_PIECES.map((rel) =>
    fs.readFileSync(path.join(RENDERER, rel), 'utf8')
  ).join('\n');
}

module.exports = { BESTVM_PIECES, loadBestvm, bestvmSource };
