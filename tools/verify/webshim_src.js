// The transport shim's source, for the verify tests that read it as TEXT.
//
// core/webshim.js is now the core/webshim/ folder, one piece per concern,
// loaded by index.html in a fixed order and concatenated in that same order
// into the bundle. Tests that used to slice or regex the single file get the
// same text back from here: every piece joined in index.html load order, so
// "everything above class NativeSerialBus" and "class WebSerialBus up to
// const webBus =" still mean what they did.
const fs = require('fs');
const path = require('path');

const RENDERER = path.join(__dirname, '..', '..', 'app', 'renderer');

// the pieces' paths, in load order, read from index.html (the same source
// bundle-renderer.mjs and test_global_collisions.js use)
function webshimPieces() {
  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
  return [
    ...html.matchAll(/<script src="(core\/webshim\/[^"]+)"><\/script>/g),
  ].map((m) => m[1]);
}

// the pieces' source, joined in load order
function readWebshimSource() {
  const pieces = webshimPieces();
  if (!pieces.length)
    throw new Error('index.html loads no core/webshim/ piece');
  return pieces
    .map((rel) => fs.readFileSync(path.join(RENDERER, rel), 'utf8'))
    .join('\n');
}

module.exports = { webshimPieces, readWebshimSource };
