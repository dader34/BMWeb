#!/usr/bin/env node
// The parts diagram's callout hotspots: the file tools/etk_import.py --hotspots
// writes, and the pure helpers screens/etk/callouts.js joins it to the parts
// table with.
//
// Two halves:
//   1. FILE SHAPE + THE POS JOIN. A tiny hand-built fixture pins the contract
//      (version, btnr -> [[pos,x1,y1,x2,y2]], integers, ordered corners), and
//      the generated data/etk/<CHASSIS>.hs.json.gz is checked against the
//      bundle beside it -- every hotspot btnr must be a diagram the bundle
//      carries, and the callout numbers must be the ones the parts rows use.
//      That real-data half SKIPS when the data is not present (CI, a fresh
//      clone): the generated files are gitignored, like the rest of data/.
//   2. THE HELPERS. etkScaleHotspot maps a stored rectangle onto the image as
//      drawn (the upscale rule, the lightbox and a resize all change that
//      size), and etkPosRowIndex joins a callout to the rows carrying it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const R = path.join(__dirname, '..', '..');

let passed = 0;
const ok = (m) => {
  passed++;
  console.log(`  ok    ${m}`);
};
const skip = (m) => console.log(`  SKIP  ${m}`);

// ---------------------------------------------------------------------------
// the helpers, loaded the way the page loads them: a classic script whose
// top-level functions become globals
// ---------------------------------------------------------------------------
const sandbox = { window: {}, document: undefined };
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(R, 'app/renderer/screens/etk/callouts.js'), 'utf8'),
  sandbox
);
const etkScaleHotspot = vm.runInContext('etkScaleHotspot', sandbox);
const etkPosRowIndex = vm.runInContext('etkPosRowIndex', sandbox);
const etkHotspotName = vm.runInContext('etkHotspotName', sandbox);
assert.strictEqual(
  typeof etkScaleHotspot,
  'function',
  'callouts.js must define etkScaleHotspot'
);
assert.strictEqual(
  typeof etkPosRowIndex,
  'function',
  'callouts.js must define etkPosRowIndex'
);
ok('callouts.js loads as a classic script and defines its helpers');

// ---------------------------------------------------------------------------
// 1a. the file shape, against a fixture
// ---------------------------------------------------------------------------
/**
 * Assert one parsed hotspot file has the shape the viewer relies on.
 * @param {object} data - the parsed file
 * @param {string} where - what is being checked, for the messages
 * @returns {number} how many rectangles it carries
 */
function checkShape(data, where) {
  assert.ok(data && typeof data === 'object', `${where}: parses to an object`);
  assert.strictEqual(data.v, 1, `${where}: format version is 1`);
  assert.ok(data.bt && typeof data.bt === 'object', `${where}: has a bt map`);
  let n = 0;
  for (const [btnr, rects] of Object.entries(data.bt)) {
    assert.ok(btnr.length > 0, `${where}: btnr keys are non-empty`);
    assert.ok(
      Array.isArray(rects) && rects.length > 0,
      `${where}: ${btnr} has a non-empty rectangle list`
    );
    for (const r of rects) {
      assert.ok(
        Array.isArray(r) && r.length === 5,
        `${where}: ${btnr} rectangle is [pos,x1,y1,x2,y2]`
      );
      assert.strictEqual(
        typeof r[0],
        'string',
        `${where}: ${btnr} pos is a string`
      );
      for (let i = 1; i < 5; i++) {
        assert.ok(
          Number.isInteger(r[i]),
          `${where}: ${btnr} coordinate ${i} is an integer (small file)`
        );
      }
      // corners ordered and the box non-degenerate: an inverted or zero-area
      // rectangle would be an unclickable dead target
      assert.ok(r[3] > r[1], `${where}: ${btnr} x2 > x1`);
      assert.ok(r[4] > r[2], `${where}: ${btnr} y2 > y1`);
      assert.ok(r[1] >= 0 && r[2] >= 0, `${where}: ${btnr} corners are >= 0`);
      n++;
    }
  }
  return n;
}

const fixture = {
  v: 1,
  bt: {
    '11_1151': [
      ['01', 998, 588, 1015, 609],
      ['02', 1000, 266, 1016, 287],
      ['03', 446, 405, 463, 426],
    ],
    // one pos owning two rectangles: the same part drawn in two places
    '11_0100': [
      ['07', 10, 10, 30, 30],
      ['07', 90, 10, 110, 30],
    ],
  },
};
assert.strictEqual(checkShape(fixture, 'fixture'), 5, 'fixture has 5 rects');
ok('fixture matches the hotspot file contract (v, bt, integer ordered boxes)');

// the file must survive a real gzip round-trip: that is how it ships and how
// the viewer reads it back (fflate.gunzipSync over the same bytes)
const gz = zlib.gzipSync(Buffer.from(JSON.stringify(fixture), 'utf8'), {
  level: 9,
});
const back = JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
assert.deepStrictEqual(back, fixture, 'gzip round-trip is lossless');
ok('the file gzips and gunzips back byte-for-byte');

// ---------------------------------------------------------------------------
// 1b. the pos join, against the generated data
// ---------------------------------------------------------------------------
const ETK_DIR = path.join(R, 'data', 'etk');
const hsFiles = fs.existsSync(ETK_DIR)
  ? fs.readdirSync(ETK_DIR).filter((f) => f.endsWith('.hs.json.gz'))
  : [];
if (!hsFiles.length) {
  skip('no data/etk/*.hs.json.gz generated -- run etk_import.py --hotspots');
} else {
  let checkedRects = 0;
  for (const f of hsFiles) {
    const data = JSON.parse(
      zlib.gunzipSync(fs.readFileSync(path.join(ETK_DIR, f))).toString('utf8')
    );
    checkedRects += checkShape(data, f);
  }
  ok(
    `${hsFiles.length} generated hotspot file(s) match the contract ` +
      `(${checkedRects.toLocaleString()} rectangles)`
  );

  // the join, wherever a bundle is present to join against: every hotspot
  // btnr must be a diagram in that chassis's tree (the importer derives both
  // from the same fitment query, so an orphan means they drifted apart), and
  // the callout numbers must be drawn from the pos values the parts carry.
  let joined = 0;
  for (const f of hsFiles) {
    const chassis = f.replace(/\.hs\.json\.gz$/, '');
    const etk = path.join(ETK_DIR, `${chassis}.etk`);
    if (!fs.existsSync(etk)) continue;
    const data = JSON.parse(
      zlib.gunzipSync(fs.readFileSync(path.join(ETK_DIR, f))).toString('utf8')
    );
    const tree = readTreeJson(etk);
    /** @type {Map<string, Set<string>>} btnr -> the pos values its parts carry */
    const diagrams = new Map();
    for (const mg of tree.maingroups || []) {
      for (const g of mg.groups || []) {
        for (const d of g.diagrams || []) {
          diagrams.set(d.btnr, new Set((d.parts || []).map((p) => p.pos)));
        }
      }
    }
    const orphans = Object.keys(data.bt).filter((b) => !diagrams.has(b));
    assert.strictEqual(
      orphans.length,
      0,
      `${chassis}: every hotspot btnr is a diagram in the bundle ` +
        `(orphans: ${orphans.slice(0, 5).join(', ')})`
    );
    // the pos values must overlap heavily: a graphic is shared across chassis,
    // so a callout for a part no variant of THIS car fits is legitimate (it
    // simply highlights nothing), but a wholesale mismatch would mean the key
    // is wrong, which is the bug this guards.
    let hit = 0;
    let tot = 0;
    for (const [btnr, rects] of Object.entries(data.bt)) {
      const poss = diagrams.get(btnr);
      for (const r of rects) {
        tot++;
        if (poss.has(r[0])) hit++;
      }
    }
    const pct = (100 * hit) / tot;
    assert.ok(
      pct > 80,
      `${chassis}: callout numbers join to parts rows (${pct.toFixed(1)}% of ` +
        `${tot} rectangles name a pos the diagram carries)`
    );
    ok(
      `${chassis}: ${Object.keys(data.bt).length} diagrams, ${tot} rectangles, ` +
        `${pct.toFixed(1)}% join to a parts row`
    );
    joined++;
  }
  if (!joined)
    skip('no <CHASSIS>.etk bundle beside the hotspot files -- join unchecked');
}

/**
 * Read tree.json out of a .etk archive without a zip library: walk the
 * end-of-central-directory record to the entry, then inflate it.
 * @param {string} file - path to the .etk
 * @returns {object} the parsed tree
 */
function readTreeJson(file) {
  const buf = fs.readFileSync(file);
  // end of central directory: scan back for its signature (no zip comment is
  // written, but scan anyway rather than assume a fixed offset)
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 70000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.ok(eocd >= 0, `${file}: has a zip end-of-central-directory record`);
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    assert.strictEqual(
      buf.readUInt32LE(off),
      0x02014b50,
      'central directory header'
    );
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nlen).toString('utf8');
    if (name === 'tree.json') {
      const lnlen = buf.readUInt16LE(lho + 26);
      const lelen = buf.readUInt16LE(lho + 28);
      const start = lho + 30 + lnlen + lelen;
      const raw = buf.slice(start, start + csize);
      const json = method === 0 ? raw : zlib.inflateRawSync(raw);
      return JSON.parse(json.toString('utf8'));
    }
    off += 46 + nlen + elen + clen;
  }
  throw new Error(`${file}: no tree.json`);
}

// ---------------------------------------------------------------------------
// 2. etkScaleHotspot: the stored rectangle onto the image as drawn
// ---------------------------------------------------------------------------
/**
 * Place a rectangle and return it as a plain object of THIS realm. The helper
 * runs inside a vm context, so the object it builds has that context's
 * Object.prototype and deepStrictEqual (which compares prototypes) would
 * reject an otherwise identical result.
 * @param {...*} args - etkScaleHotspot's arguments
 * @returns {object|null}
 */
const place = (...args) => {
  const r = etkScaleHotspot(...args);
  return (
    r && {
      pos: r.pos,
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
    }
  );
};

// 1:1 -- the image at its natural size
assert.deepStrictEqual(
  place(['01', 100, 200, 150, 260], 1000, 800, 1000, 800),
  { pos: '01', left: 100, top: 200, width: 50, height: 60 },
  'at natural size the stored pixels are used unchanged'
);
ok('etkScaleHotspot is the identity when the image is drawn at natural size');

// halved -- the pane's max-height rule shrinking a wide drawing
assert.deepStrictEqual(
  place(['02', 100, 200, 150, 260], 1000, 800, 500, 400),
  { pos: '02', left: 50, top: 100, width: 25, height: 30 },
  'a half-size rendering halves every coordinate'
);
ok('etkScaleHotspot follows a shrunk rendering');

// doubled -- the small-image upscale rule (ETK_IMG_UPSCALE)
assert.deepStrictEqual(
  place(['03', 10, 20, 30, 40], 400, 300, 800, 600),
  { pos: '03', left: 20, top: 40, width: 40, height: 40 },
  'the 2x upscale rule doubles every coordinate'
);
ok('etkScaleHotspot survives the small-image upscale');

// the axes scale independently, so a non-uniform box still lands right
assert.deepStrictEqual(
  place(['04', 100, 100, 200, 200], 1000, 500, 500, 500),
  { pos: '04', left: 50, top: 100, width: 50, height: 100 },
  'x and y scale by their own ratios'
);
ok('etkScaleHotspot scales each axis by its own ratio');

// the pos is stringified, so a numeric callout still joins to the table text
assert.strictEqual(
  etkScaleHotspot([7, 0, 0, 10, 10], 100, 100, 100, 100).pos,
  '7',
  'pos comes back as a string'
);
ok('etkScaleHotspot returns pos as a string (the table holds text)');

// unusable input must yield null rather than a rectangle at NaN
for (const [label, args] of [
  [
    'no natural size yet (image not decoded)',
    [['01', 0, 0, 5, 5], 0, 0, 10, 10],
  ],
  ['not laid out yet (zero rendered size)', [['01', 0, 0, 5, 5], 10, 10, 0, 0]],
  ['a degenerate stored box', [['01', 5, 5, 5, 5], 10, 10, 10, 10]],
  ['a short row', [['01', 1, 2], 10, 10, 10, 10]],
  ['no row at all', [null, 10, 10, 10, 10]],
]) {
  assert.strictEqual(
    etkScaleHotspot(...args),
    null,
    `etkScaleHotspot returns null: ${label}`
  );
}
ok('etkScaleHotspot returns null for every unusable input (never NaN boxes)');

// ---------------------------------------------------------------------------
// 3. etkPosRowIndex: the pos -> rows join
// ---------------------------------------------------------------------------
/**
 * A stand-in for a rendered parts row: only its callout number matters here.
 * @param {string} pos - the callout the row carries
 * @returns {{pos: string}}
 */
const row = (pos) => ({ pos });
const rows = [
  row('01'),
  row('--'),
  row('01'), // a second part at the same callout (a fitment variant)
  row('02'),
  row('--'),
  row(' 03 '), // the cell's text can carry whitespace
  row(''),
];
const idx = etkPosRowIndex(rows, (r) => r.pos);
assert.deepStrictEqual(
  [...idx.keys()].sort(),
  ['01', '02', '03'],
  'only real callouts are indexed'
);
ok('etkPosRowIndex indexes only real callout numbers');
assert.strictEqual(
  idx.get('01').length,
  2,
  'one callout can name several parts rows'
);
ok('etkPosRowIndex joins one callout to every row carrying it');
assert.ok(!idx.has('--'), "'--' (no callout on the drawing) never joins");
assert.ok(!idx.has(''), 'a blank pos never joins');
ok("etkPosRowIndex refuses '--' and blank, which name no point on the drawing");
assert.strictEqual(idx.get('03').length, 1, 'a padded cell is trimmed');
ok('etkPosRowIndex trims the cell text before joining');

// rows the variant filter removed are simply not passed in, so their callouts
// highlight nothing: the rule holds by construction, and this pins it
const fitted = etkPosRowIndex([row('01'), row('02')], (r) => r.pos);
assert.ok(
  !fitted.has('03'),
  'a callout whose only row was filtered out joins to nothing'
);
ok('a filtered-out row leaves its callout highlighting nothing');

// ---------------------------------------------------------------------------
// 4. the accessible name
// ---------------------------------------------------------------------------
assert.strictEqual(etkHotspotName('01', 0), 'callout 01');
assert.strictEqual(etkHotspotName('01', 1), 'callout 01, 1 part');
assert.strictEqual(etkHotspotName('07', 3), 'callout 07, 3 parts');
ok('etkHotspotName names a rectangle for a screen reader');

console.log(`\netk-hotspots: ${passed} checks passed`);
