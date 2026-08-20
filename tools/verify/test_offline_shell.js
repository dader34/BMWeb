// OFFLINE_SHELL must mirror index.html.
//
// The exporter inlines every <script src> and <link href> the page carries, and
// throws on one it was not given ("OFFLINE_SHELL is missing X"). That guard is
// right -- a silently dropped script boots broken in the field -- but it only
// fires when someone exports. Eleven files were added to index.html over time
// (the tuning and coding screens, css/tuning.css) without the list following,
// so the single-file build was dead for months and said so only on click.
//
// Cheaper to catch here: the two lists are checked against each other.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..', 'app', 'renderer');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const src = fs.readFileSync(path.join(ROOT, 'core', 'offline-export.js'), 'utf8');

// evaluate just the declarations, so the lists are read as JS not scraped
const ctx = {};
vm.createContext(ctx);
vm.runInContext(src.slice(0, src.indexOf('function offlineBase')), ctx);
const shell = vm.runInContext('OFFLINE_SHELL', ctx);

// OMIT lives inside the export function; a small scrape is fine for a literal
const omitM = /OMIT = new Set\(\[([^\]]*)\]\)/.exec(src);
const omit = omitM ? [...omitM[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];

const refs = [...html.matchAll(/<(?:script src|link[^>]*href)="([^"]+\.(?:js|css|svg))"/g)]
  .map((m) => m[1]);

let bad = 0;
const missing = refs.filter((f) => !shell.includes(f) && !omit.includes(f));
if (missing.length) {
  bad++;
  console.log(`  offline-shell  MISSING from OFFLINE_SHELL: ${missing.join(', ')}`);
}

// the reverse: a file dropped from index.html but still listed fails the export
// too, because offlineGet 404s on it
const DATA_EXTRA = new Set(['index.html', 'logo.svg',
                            'data/codingmap.js', 'data/datenmap.js']);
const stale = shell.filter((f) => !refs.includes(f) && !DATA_EXTRA.has(f));
for (const f of stale) {
  if (!fs.existsSync(path.join(ROOT, f))) {
    bad++;
    console.log(`  offline-shell  listed but does not exist: ${f}`);
  }
}

if (bad) {
  console.log('\noffline-shell check FAILED');
  process.exit(1);
}
console.log(`  offline-shell  ${shell.length} entries mirror index.html (${refs.length} refs)`);
