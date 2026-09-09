#!/usr/bin/env node
// The corpus-wide job search: the exported index's shape, and the matcher
// over it.
//
// TWO HALVES, TWO KINDS OF PROOF.
//
// The BUILDER half runs tools/export/search_index.py over real chassis
// folders into a temp dir and asserts the shape the app reads: the version
// stamp, one module record per SGBD with the cars that carry it, key entries
// carrying the menu and F-key number a deep link needs, screen entries
// carrying their result keys, and -- the thing most likely to rot -- both the
// German label and its English, because a script whose captions are German
// with a dictionary beside it must answer an English query.
//
// The MATCHER half runs against a hand-built index, so a ranking assertion
// says what it means instead of depending on which BMW script happens to
// hold a word. All-words matching, the EN/DE pairing, and the ranking order
// are pinned here.
//
//   node tools/verify/test_search.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');
const { execFileSync } = require('child_process');
const { loadClassic } = require('./lib/load_classic.js');

const ROOT = path.join(__dirname, '..', '..');
let passed = 0;
const ok = (what) => {
  passed++;
  if (process.env.V) console.log('  ok', what);
};

// ---- the matcher, loaded the way the page loads it -------------------------
// screens/search/ is a folder of classic scripts sharing one scope. Only the
// pure halves are exercised here; render.js and bar.js touch the DOM.
global.window = global.window || {};
const S = loadClassic('screens/search/');

// ---- half 1: the builder's output shape ------------------------------------
// Two chassis with very different scripts: E46 is the reference car (German
// captions with dictionaries), E90 is a later one whose scripts print
// English. A builder that only ever saw one of those would pass on a
// language assumption that does not hold.
// 'vehicle' holds INPA's whole-vehicle scripts (E46.IPO and friends), which
// the index must carry as modules of their own.
const CHASSIS = ['E46', 'E90', 'vehicle'];
const tree = path.join(ROOT, 'data', 'chassis');
const haveTree = CHASSIS.every((c) => fs.existsSync(path.join(tree, c)));

if (!haveTree) {
  // data/chassis is DERIVED and gitignored: a fresh checkout has none until
  // build_ecu_tree.py runs. Skipping loudly beats a red test that means
  // "you have not built the tree yet".
  console.log(
    '  skip  builder half: data/chassis missing ' +
      '(run tools/export/build_ecu_tree.py)'
  );
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmweb-search-'));
  // The builder walks the whole tree, so it is pointed at a scratch copy
  // holding only the two chassis under test -- a two-chassis run is seconds,
  // and the assertions below can then be exact about what is in it.
  const scratch = path.join(tmp, 'tree');
  fs.mkdirSync(scratch);
  for (const c of CHASSIS) {
    fs.cpSync(path.join(tree, c), path.join(scratch, c), { recursive: true });
  }
  const script = path.join(ROOT, 'tools', 'export', 'search_index.py');
  const runner = path.join(tmp, 'run.py');
  fs.writeFileSync(
    runner,
    'import sys, os\n' +
      `sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'tools', 'export'))})\n` +
      'import search_index as S\n' +
      `S.TREE = ${JSON.stringify(scratch)}\n` +
      `n, size = S.build_index(${JSON.stringify(tmp)}, verbose=False)\n` +
      'print(n)\n'
  );
  execFileSync('python3', [runner], { encoding: 'utf8' });
  assert.ok(fs.existsSync(script), 'the builder exists');

  const out = path.join(tmp, 'api', 'search-index.json.gz');
  const doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(out)).toString());
  ok('builder writes api/search-index.json.gz');

  assert.strictEqual(doc.v, 1, 'index stamps its format version');
  assert.ok(Array.isArray(doc.modules) && doc.modules.length > 40);
  assert.ok(Array.isArray(doc.entries) && doc.entries.length > 2000);
  ok(`${doc.entries.length} entries over ${doc.modules.length} modules`);

  // every entry points at a real module, and every module names its cars
  for (const e of doc.entries) {
    assert.ok(doc.modules[e.i], `entry ${e.t} points at a module`);
    assert.ok(e.t === 'k' || e.t === 's', 'entry is a key or a screen');
  }
  ok('every entry resolves to a module');

  const bySgbd = new Map(doc.modules.map((m) => [m.sgbd, m]));
  assert.strictEqual(
    bySgbd.size,
    doc.modules.length,
    'one module record per SGBD -- the same .prg is not indexed twice'
  );
  ok('modules are deduplicated by SGBD');

  for (const m of doc.modules) {
    assert.ok(Array.isArray(m.chassis), `${m.sgbd} lists its chassis`);
    for (const c of m.chassis) assert.strictEqual(c, c.toUpperCase());
  }
  ok('chassis ids are upper-case, as the deep link writes them');

  // THE REFERENCE MODULE. ms450ds0 is the E46 MS45.1 -- German captions with
  // a dictionary -- so it pins the language pairing and the deep-link fields.
  const ms45 = bySgbd.get('ms450ds0');
  assert.ok(ms45, 'the E46 MS45.1 is indexed');
  assert.ok(ms45.chassis.includes('E46'), 'ms450ds0 belongs to the E46');
  const ms45Entries = doc.entries.filter(
    (e) => doc.modules[e.i].sgbd === 'ms450ds0'
  );

  const readFs = ms45Entries.find(
    (e) => e.t === 'k' && e.l === 'Fehlerspeicher lesen' && e.m === 'm_fehlersp'
  );
  assert.ok(readFs, 'the fault-memory key is indexed on its own menu');
  assert.strictEqual(
    readFs.e,
    'Read fault memory',
    'German label carries its English'
  );
  assert.ok(
    (readFs.j || []).includes('FS_LESEN'),
    'the key names the job it sends'
  );
  assert.ok(readFs.s, 'the key names the screen it opens');
  assert.strictEqual(
    typeof readFs.n,
    'number',
    'the key carries its F-key number'
  );
  ok('a German key carries label, English, jobs, menu, screen and key number');

  // A WRITE KEY IS MARKED, NOT DROPPED. Finding the clear key is the point;
  // pressing it for the user is not (screens/search/open.js never does).
  const clear = ms45Entries.find(
    (e) => e.t === 'k' && (e.j || []).includes('FS_LOESCHEN')
  );
  assert.ok(clear, 'the clear-fault-memory key is indexed');
  ok('a write key is indexed');

  // SCREEN ENTRIES CARRY WHAT THEY READ. A key's label does not mention
  // DATEN_ASCII; the screen it opens is where that name lives.
  const withKeys = ms45Entries.filter((e) => e.t === 's' && (e.k || []).length);
  assert.ok(withKeys.length > 5, 'screens carry their result keys');
  ok(`${withKeys.length} MS45 screens carry result keys`);

  // INPA'S CHROME IS NOT INDEXED. "Print screen" and "Exit INPA" sit on
  // nearly every menu of every script; 17k copies would bury every real
  // answer under boilerplate.
  const chrome = doc.entries.filter(
    (e) => e.a === 'exit' || e.a === 'printscreen' || e.a === 'select'
  );
  assert.strictEqual(chrome.length, 0, 'chrome keys are dropped');
  ok('exit / print / select keys are not indexed');

  // THE WHOLE-VEHICLE SCRIPTS. INPA's E46.IPO reads every module's fault
  // memory through the group SGBDs; it is reached by the chassis stem, so it
  // must be indexed as a module like any other.
  const veh = bySgbd.get('e46');
  if (veh) {
    assert.strictEqual(veh.vehicle, 1, 'the vehicle script is flagged');
    assert.ok(veh.chassis.includes('E46'), 'it belongs to the E46');
    ok('the whole-vehicle script is indexed under its chassis');
  }

  // the runtime download budget: the whole corpus must stay in single-digit
  // MB, and two chassis of it in a small fraction of that
  const size = fs.statSync(out).size;
  assert.ok(size < 2 * 1024 * 1024, `two chassis fit in 2 MB (${size} bytes)`);
  ok(`two chassis index to ${Math.round(size / 1024)} KB gzipped`);

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- half 2: the matcher ---------------------------------------------------
// A hand-built index, so each assertion pins one rule rather than one BMW
// script's wording.
const IX = {
  v: 1,
  modules: [
    {
      sgbd: 'ms450ds0',
      label: 'MS45.1 for M54',
      code: 'MS450',
      chassis: ['E46'],
    },
    {
      sgbd: 'lws5_1b',
      label: 'Steering angle sensor',
      code: 'LWS',
      chassis: ['E46', 'E39'],
    },
    { sgbd: 'orphan', label: 'Unowned script', code: '', chassis: [] },
  ],
  entries: [
    // 0: German label with an English translation
    {
      t: 'k',
      i: 0,
      m: 'm_fehlersp',
      n: 1,
      l: 'Fehlerspeicher lesen',
      e: 'Read fault memory',
      s: 's_fs_kurz',
      j: ['FS_LESEN'],
    },
    // 1: a write key
    {
      t: 'k',
      i: 0,
      m: 'm_fehlersp',
      n: 5,
      l: 'Fehlerspeicher löschen',
      e: 'Clear fault memory',
      s: 's_fs_loesch',
      j: ['FS_LOESCHEN'],
      w: 1,
    },
    // 2: a screen whose value is in its result keys, not its title
    {
      t: 's',
      i: 1,
      s: 's_status',
      ti: 'Status',
      j: ['STATUS_LESEN'],
      k: ['LENKWINKEL', 'JOB_STATUS'],
      c: 'Steering angle',
      ce: 'Steering angle',
    },
    // 3: a key on a module no car owns
    { t: 'k', i: 2, m: 'm_main', n: 1, l: 'Read something', j: ['LESEN'] },
  ],
};

const run = (q, opts) => S.searchRun(IX, q, opts);

// ALL WORDS MUST MATCH. "clear fault" must not answer with the read key just
// because it holds "fault".
{
  const r = run('clear fault');
  const labels = r.groups.flatMap((g) =>
    g.modules.flatMap((m) => m.hits.map((h) => h.label))
  );
  assert.deepStrictEqual(labels, ['Clear fault memory']);
  ok('all query words must match (clear fault -> only the clear key)');
}
{
  assert.strictEqual(run('fault memory zzzz').total, 0);
  ok('a word matching nothing kills the result');
}

// BOTH LANGUAGES. The same key answers a German and an English query.
{
  const de = run('fehlerspeicher lesen');
  const en = run('read fault memory');
  const pick = (r) => r.groups[0].modules[0].hits[0].entry;
  assert.strictEqual(pick(de), IX.entries[0]);
  assert.strictEqual(pick(en), IX.entries[0]);
  ok('a German key answers both a German and an English query');
}

// SUBSTRINGS, because German compounds. "fehler" must reach
// "Fehlerspeicher".
{
  assert.ok(run('fehler').total >= 2, 'a substring matches inside a compound');
  ok('substring matching (fehler -> Fehlerspeicher)');
}

// CASE-INSENSITIVE, both ways round.
{
  assert.strictEqual(run('FEHLERSPEICHER').total, run('fehlerspeicher').total);
  assert.ok(run('fs_lesen').total > 0, 'a lower-cased job name matches');
  ok('matching is case-insensitive');
}

// A JOB NAME WINS OUTRIGHT. Someone typing FS_LESEN knows what they want.
{
  const r = run('FS_LESEN');
  const first = r.groups[0].modules[0].hits[0];
  assert.strictEqual(first.entry, IX.entries[0]);
  assert.ok(first.score >= 60, 'an exact job hit scores above every label hit');
  ok('an exact job name outranks label matches');
}

// RESULT KEYS ARE SEARCHABLE. The angle sensor's screen says "Status"; the
// name a user knows it by is in its keys.
{
  const r = run('lenkwinkel');
  assert.strictEqual(r.total, 2, 'the screen is offered in both its cars');
  const cars = r.groups.map((g) => g.chassis).sort();
  assert.deepStrictEqual(cars, ['E39', 'E46']);
  ok('a result key is searchable, in every car that carries the module');
}

// A KEY OUTRANKS A SCREEN saying the same thing: one is something to press.
{
  const key = S.searchRank(IX.entries[0], IX.modules[0], ['fehlerspeicher']);
  const scr = S.searchRank(
    { t: 's', i: 0, ti: 'Fehlerspeicher' },
    IX.modules[0],
    ['fehlerspeicher']
  );
  assert.ok(key > scr, 'a key outranks a screen with the same words');
  ok('a key outranks an equally-worded screen');
}

// A WORD-START HIT OUTRANKS ONE BURIED MID-WORD.
{
  const start = S.searchRank(
    { t: 's', i: 0, ti: 'Lambda sensor' },
    IX.modules[0],
    ['lambda']
  );
  const buried = S.searchRank({ t: 's', i: 0, ti: 'Gelambda' }, IX.modules[0], [
    'lambda',
  ]);
  assert.ok(start > buried, 'the start of a word outranks the middle of one');
  ok('a word-boundary hit outranks a buried substring');
}

// TOO SHORT IS NOT A QUERY: one letter matches most of the corpus.
{
  assert.deepStrictEqual(S.searchTerms('f'), []);
  assert.strictEqual(run('f').total, 0);
  ok('a one-letter query runs nothing');
}

// A MODULE NO CAR CARRIES SINKS. Over half the corpus is .prg files no menu
// names -- real scripts, findable, but with no car the deep link can name. On
// a broad query they used to lead the page with rows that could not be
// opened at all.
{
  const owned = S.searchRank(IX.entries[0], IX.modules[0], ['read']);
  const orphan = S.searchRank(IX.entries[3], IX.modules[2], ['read']);
  assert.ok(orphan > 0, 'an unowned module still matches');
  assert.ok(owned > orphan, 'but it ranks below one the user can open');
  ok('a module no car carries ranks below an openable one');
}

// THE CHASSIS FILTER narrows to one car.
{
  const r = run('lenkwinkel', { chassis: 'E46' });
  assert.strictEqual(r.groups.length, 1);
  assert.strictEqual(r.groups[0].chassis, 'E46');
  ok('the chassis filter narrows to one car');
}

// THE ROW CAP holds, and the true total is still reported.
{
  const r = run('lenkwinkel', { max: 1 });
  assert.strictEqual(r.shown, 1);
  assert.strictEqual(r.total, 2, 'the cap does not lie about how many matched');
  ok('the row cap caps rows, not the count');
}

// ---- the deep link a result opens ------------------------------------------
// This is the whole point of the feature: a row must become the exact route
// the router already resolves.
{
  const hit = { entry: IX.entries[0], module: IX.modules[0] };
  assert.strictEqual(
    S.searchHitRoute(hit, 'E46'),
    'car/E46/ms450ds0/m_fehlersp/s_fs_kurz'
  );
  ok('a key becomes #car/<CHASSIS>/<SGBD>/<MENU>/<SCREEN>');
}
{
  // a screen has no menu of its own: the empty part keeps the screen in the
  // position the router reads it from
  const hit = { entry: IX.entries[2], module: IX.modules[1] };
  assert.strictEqual(S.searchHitRoute(hit, 'E46'), 'car/E46/lws5_1b//s_status');
  ok('a screen with no menu keeps its position in the route');
}
{
  // a module no car owns has no route: the row cannot be opened, and saying
  // so beats linking at a page that would 404
  const hit = { entry: IX.entries[3], module: IX.modules[2] };
  assert.strictEqual(S.searchHitRoute(hit, ''), null);
  ok('a module no car owns yields no route');
}

// THE ROUTE THE ROUTER PARSES BACK. The link is only useful if resolveRoute
// splits it into the same four parts -- pinned here against the real regex
// and tail split, so a change to either surfaces as this test.
{
  const src = fs.readFileSync(
    path.join(ROOT, 'app/renderer/core/router.js'),
    'utf8'
  );
  const seen = [];
  const sandbox = {
    showEcuDeep: (...a) => seen.push(a),
    decodeURIComponent,
    console,
  };
  // lift resolveRoute's #car arm by evaluating the file's own regex against
  // the routes above rather than re-typing the pattern here
  const m = src.match(/const c = (\/\^car[^\n]*?)\.exec\(/);
  assert.ok(m, 'the #car route regex is where this test expects it');
  const re = new RegExp(m[1].slice(1, m[1].lastIndexOf('/')));
  for (const route of [
    'car/E46/ms450ds0/m_fehlersp/s_fs_kurz',
    'car/E46/lws5_1b//s_status',
    'car/E46/ms450ds0/m_fehlersp',
    'car/E46/ms450ds0',
  ]) {
    assert.ok(re.exec(route), `${route} is a #car route`);
  }
  const parts = re.exec('car/E46/ms450ds0/m_fehlersp/s_fs_kurz');
  const tail = parts[3].split('/');
  assert.strictEqual(parts[1].toUpperCase(), 'E46');
  assert.strictEqual(parts[2].toLowerCase(), 'ms450ds0');
  assert.strictEqual(tail[0], 'm_fehlersp');
  assert.strictEqual(tail[1], 's_fs_kurz');
  ok('the router parses a search route back into chassis/sgbd/menu/screen');

  // AND THE OLD LINKS STILL WORK. Every #car link written before the screen
  // part existed is a two-part tail, and must stay menu-only.
  const old = re.exec('car/E46/kombi46/MENU_FS');
  assert.strictEqual(old[3].split('/')[0], 'MENU_FS');
  assert.strictEqual(old[3].split('/')[1], undefined);
  ok('a pre-existing menu-only link is unchanged');
  void sandbox;
  void seen;
}

console.log(`search: ${passed} checks passed`);
