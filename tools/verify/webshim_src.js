// The transport shim's source, for the verify tests that read it as TEXT.
//
// core/webshim.js is now the core/webshim/ folder, one piece per concern,
// loaded by index.html in a fixed order and concatenated in that same order
// into the bundle. Tests that used to slice or regex the single file get the
// same text back from here: every piece joined in index.html load order, so
// "class WebSerialBus up to const webBus =" still means what it did. The
// pure helpers -- everything before the first transport -- are the pieces
// through transport-base.js (readWebshimSource('transport-base.js')).
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

// the pieces' source, joined in load order; with `through`, only the pieces
// up to and including the one of that file name
function readWebshimSource(through) {
  let pieces = webshimPieces();
  if (!pieces.length)
    throw new Error('index.html loads no core/webshim/ piece');
  if (through) {
    const last = pieces.indexOf(`core/webshim/${through}`);
    if (last < 0)
      throw new Error(`index.html loads no core/webshim/${through}`);
    pieces = pieces.slice(0, last + 1);
  }
  return pieces
    .map((rel) => fs.readFileSync(path.join(RENDERER, rel), 'utf8'))
    .join('\n');
}

module.exports = { webshimPieces, readWebshimSource };
