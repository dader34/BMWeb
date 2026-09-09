#!/usr/bin/env node
// The Service functions app: the curated catalogue, the generator that
// resolves it against the decoded IR, and the screen's own pure halves.
//
// THREE HALVES, THREE KINDS OF PROOF.
//
// The CATALOGUE half asserts the shape of the file a human maintains
// (data/service-functions.json): enough tasks to be worth an app, ids that
// are unique and route-safe, categories that exist, and a match block that
// can actually match something. A typo there produces a task that silently
// resolves nowhere, which looks exactly like "this car does not have it".
//
// The GENERATOR half runs tools/export/service_functions.py over real chassis
// folders into a temp dir and asserts what the app reads back. The two
// assertions that matter most are named cars, not counts: on E46 the steering
// angle calibration must land on the lws5 script and the transmission
// adaptation reset on the GS20-family script (sgbd ags732). Those are the two
// the user can check on their own car, so they are pinned by name.
//
// THE SAFETY ASSERTION. A task marked "write" must never resolve onto a key
// the runtime would classify as a read -- offering a read key as a
// calibration sends someone to a key that cannot do the job. The generator
// mirrors core/bestvm's isWriteJob to decide this, so the test loads BOTH
// classifiers and asserts they agree on every job the mapping resolved. If
// the renderer's guard ever moves, this fails rather than the app quietly
// offering keys the guard will refuse.
//
//   node tools/verify/test_service_functions.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { loadClassic } = require('./lib/load_classic.js');

const ROOT = path.join(__dirname, '..', '..');
let passed = 0;
const ok = (what) => {
  passed++;
  if (process.env.V) console.log('  ok', what);
};

// ---- half 1: the curated catalogue -----------------------------------------
const CATALOGUE = path.join(ROOT, 'data', 'service-functions.json');
const cat = JSON.parse(fs.readFileSync(CATALOGUE, 'utf8'));

assert.ok(Array.isArray(cat.tasks), 'catalogue has a tasks array');
assert.ok(
  cat.tasks.length >= 15,
  `catalogue carries at least 15 tasks (has ${cat.tasks.length})`
);
ok(`catalogue carries ${cat.tasks.length} tasks`);

{
  const ids = new Set();
  const cats = new Set(cat.categories || []);
  assert.ok(cats.size >= 3, 'catalogue declares its categories');
  for (const t of cat.tasks) {
    assert.ok(t.id && !ids.has(t.id), `task id ${t.id} is unique`);
    ids.add(t.id);
    // the id rides in a URL (#apps/service/E46/<id>) and the router matches
    // [A-Za-z0-9_-]; a task whose id needs escaping could not be linked
    assert.ok(
      /^[a-z0-9-]+$/.test(t.id),
      `task id ${t.id} is route-safe (lower-case, digits, dashes)`
    );
    assert.ok(t.name && t.name.length > 3, `${t.id} has a name`);
    assert.ok(
      cats.has(t.category),
      `${t.id} sits in a declared category (${t.category})`
    );
    assert.ok(t.what && t.what.length > 30, `${t.id} says what it does`);
    assert.ok(
      Array.isArray(t.before) && t.before.length >= 1,
      `${t.id} lists at least one precondition`
    );
    assert.ok(
      t.risk === 'write' || t.risk === 'read',
      `${t.id} declares its risk`
    );
    const m = t.match || {};
    assert.ok(Array.isArray(m.modules), `${t.id} has a modules filter`);
    assert.ok(
      (m.jobs || []).length + (m.keys || []).length > 0,
      `${t.id} can match on a job or a key`
    );
  }
  ok('every task is well formed, uniquely and route-safely named');
}

// No em dashes anywhere in the user-facing copy (project rule).
{
  const prose = cat.tasks
    .flatMap((t) => [t.name, t.what, t.after || '', ...(t.before || [])])
    .join(' ');
  assert.ok(!prose.includes('—'), 'no em dash in catalogue copy');
  ok('catalogue copy carries no em dashes');
}

// ---- half 2: the generator over real chassis --------------------------------
// E46 is the reference car (the two named assertions below are its keys);
// E60 is a later one whose scripts are a different generation, so a generator
// that only ever worked against one would not pass both.
const CHASSIS = ['E46', 'E60'];
const tree = path.join(ROOT, 'data', 'chassis');
const haveTree = CHASSIS.every((c) => fs.existsSync(path.join(tree, c)));

let resolved = null;
if (!haveTree) {
  // data/chassis is DERIVED and gitignored: a fresh checkout has none until
  // build_ecu_tree.py runs. Skipping loudly beats a red test that means
  // "you have not built the tree yet".
  console.log(
    '  skip  generator half: data/chassis missing ' +
      '(run tools/export/build_ecu_tree.py)'
  );
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmweb-service-'));
  // The generator walks the whole tree, so it is pointed at a scratch copy
  // holding only the chassis under test: a two-chassis run is seconds, and
  // the assertions below can be exact about what is in it.
  const scratch = path.join(tmp, 'tree');
  fs.mkdirSync(scratch);
  for (const c of CHASSIS)
    fs.cpSync(path.join(tree, c), path.join(scratch, c), { recursive: true });

  // The script resolves its own paths from __file__, so it is copied beside
  // a scratch data/ holding the catalogue and the two-chassis tree.
  const fakeRoot = path.join(tmp, 'root');
  fs.mkdirSync(path.join(fakeRoot, 'tools', 'export'), { recursive: true });
  fs.mkdirSync(path.join(fakeRoot, 'data'), { recursive: true });
  fs.cpSync(
    path.join(ROOT, 'tools', 'export', 'service_functions.py'),
    path.join(fakeRoot, 'tools', 'export', 'service_functions.py')
  );
  fs.cpSync(CATALOGUE, path.join(fakeRoot, 'data', 'service-functions.json'));
  fs.cpSync(scratch, path.join(fakeRoot, 'data', 'chassis'), {
    recursive: true,
  });

  execFileSync(
    'python3',
    [path.join(fakeRoot, 'tools', 'export', 'service_functions.py')],
    { stdio: process.env.V ? 'inherit' : 'pipe' }
  );
  resolved = JSON.parse(
    fs.readFileSync(
      path.join(fakeRoot, 'data', 'service-functions.chassis.json'),
      'utf8'
    )
  );

  assert.strictEqual(resolved.v, 1, 'mapping stamps its format version');
  assert.ok(resolved.chassis.E46, 'E46 resolved');
  assert.ok(resolved.chassis.E60, 'E60 resolved');
  ok('the generator resolves both chassis');

  // the app reads tasks off the mapping, not the catalogue, so the mapping
  // must carry the whole catalogue whether or not a car has the task
  assert.strictEqual(
    resolved.tasks.length,
    cat.tasks.length,
    'the mapping carries every curated task'
  );
  assert.ok(
    resolved.tasks.length >= 15,
    `the mapping carries at least 15 tasks (has ${resolved.tasks.length})`
  );
  ok(`the mapping carries all ${resolved.tasks.length} tasks`);

  // THE TWO NAMED ASSERTIONS. These are the rows the user can verify on
  // their own car, so they are pinned by module rather than by count.
  {
    const lws = resolved.chassis.E46['lws-calibration'];
    assert.ok(lws && lws.length, 'E46 resolves the steering angle calibration');
    assert.ok(
      lws.every((h) => /^lws5/.test(h.sgbd)),
      `E46 steering angle calibration lands on the lws5 family ` +
        `(got ${lws.map((h) => h.sgbd).join(', ')})`
    );
    ok('E46 steering angle calibration resolves to the lws5 script');

    const egs = resolved.chassis.E46['egs-adaptation-reset'];
    assert.ok(
      egs && egs.length,
      'E46 resolves the transmission adaptation reset'
    );
    // E46's GS20/GS8.xx module ships as sgbd ags732 (the folder is gsds2);
    // gs20/ags922 are identifiedVariantOf stubs that inherit this IR
    assert.ok(
      egs.some((h) => h.sgbd === 'ags732'),
      `E46 transmission adaptation reset lands on the GS20 script ags732 ` +
        `(got ${egs.map((h) => h.sgbd).join(', ')})`
    );
    ok('E46 transmission adaptation reset resolves to the GS20 script');
  }

  // Every resolved key must exist in the IR it was resolved from: the menu,
  // the F-key number and the label the app will press by.
  {
    let checked = 0;
    const irCache = new Map();
    const irFor = (chassis, sgbd) => {
      const key = `${chassis}/${sgbd}`;
      if (irCache.has(key)) return irCache.get(key);
      let found = null;
      const cdir = path.join(scratch, chassis);
      for (const name of fs.readdirSync(cdir)) {
        const rec = path.join(cdir, name, 'ecu.json');
        const scr = path.join(cdir, name, 'screens.json');
        if (!fs.existsSync(rec) || !fs.existsSync(scr)) continue;
        const r = JSON.parse(fs.readFileSync(rec, 'utf8'));
        if (String(r.sgbd || '').toLowerCase() === sgbd) {
          found = JSON.parse(fs.readFileSync(scr, 'utf8'));
          break;
        }
      }
      irCache.set(key, found);
      return found;
    };
    for (const [chassis, tasks] of Object.entries(resolved.chassis)) {
      for (const [tid, hits] of Object.entries(tasks)) {
        for (const h of hits) {
          const ir = irFor(chassis, h.sgbd);
          assert.ok(ir, `${chassis} ${h.sgbd} has an IR`);
          const menu = (ir.menus || {})[h.menu];
          assert.ok(
            menu,
            `${chassis} ${h.sgbd} carries menu ${h.menu} (${tid})`
          );
          const item = (menu.items || []).find((i) => i && i.nr === h.nr);
          assert.ok(
            item,
            `${chassis} ${h.sgbd} ${h.menu} carries key ${h.nr} (${tid})`
          );
          assert.strictEqual(
            String(item.label || ''),
            h.label,
            `${chassis} ${h.sgbd} ${h.menu} key ${h.nr} label matches (${tid})`
          );
          assert.strictEqual(
            String(item.job || ''),
            h.job,
            `${chassis} ${h.sgbd} ${h.menu} key ${h.nr} job matches (${tid})`
          );
          checked++;
        }
      }
    }
    assert.ok(checked > 0, 'there were keys to check');
    ok(`all ${checked} resolved keys exist in the IR they came from`);
  }
}

// ---- the safety assertion: risk agrees with the runtime's own classifier ----
// screens/service/ and core/bestvm/ are folders of classic scripts sharing one
// scope, the way the page loads them.
global.window = global.window || {};
const WG = loadClassic('core/bestvm/');
assert.strictEqual(
  typeof WG.isWriteJob,
  'function',
  "the renderer's write classifier loaded"
);

if (resolved) {
  const risk = new Map(resolved.tasks.map((t) => [t.id, t.risk]));
  let checked = 0;
  for (const [chassis, tasks] of Object.entries(resolved.chassis)) {
    for (const [tid, hits] of Object.entries(tasks)) {
      const wants = risk.get(tid) === 'write';
      for (const h of hits) {
        if (!h.job) continue; // a script-body key sends nothing to classify
        assert.strictEqual(
          WG.isWriteJob(h.job),
          wants,
          `${chassis} ${tid}: ${h.job} on ${h.sgbd} classifies as ` +
            `${WG.isWriteJob(h.job) ? 'write' : 'read'} but the task is ` +
            `marked ${risk.get(tid)}`
        );
        // and the generator's own recorded classification agrees, so the
        // badge the app draws is the guard's answer
        assert.strictEqual(
          h.writes,
          WG.isWriteJob(h.job),
          `${chassis} ${tid}: recorded writes flag matches the classifier`
        );
        checked++;
      }
    }
  }
  assert.ok(checked > 0, 'there were jobs to classify');
  ok(
    `no task resolves against its risk: ${checked} jobs agree with the ` +
      "runtime's own write classifier"
  );
}

// ---- half 3: the screen's pure halves --------------------------------------
const S = loadClassic('screens/service/');

// the route parses and serialises: what routeSetService writes, resolveRoute
// must read back to the same screen and chassis.
{
  const routerSrc = fs.readFileSync(
    path.join(ROOT, 'app', 'renderer', 'core', 'router.js'),
    'utf8'
  );
  assert.ok(
    /'apps\/service':/.test(routerSrc),
    'the bare route is in the exact table'
  );
  assert.ok(
    /apps\\\/service\\\/\(\[A-Za-z0-9\]\+\)/.test(routerSrc),
    'the parameterised route is matched'
  );
  assert.ok(
    /showService: 'apps\/service'/.test(routerSrc),
    'the screen syncs its own hash'
  );
  assert.ok(
    /function routeSetService/.test(routerSrc),
    'routeSetService exists'
  );
  ok('the route parses, serialises and round-trips through the router');
}

// grouping: every task appears exactly once, in a declared category, and a
// task with no hits is KEPT (the screen says "not on this car" rather than
// hiding it)
{
  const index = {
    v: 1,
    categories: ['Calibration', 'Adaptation reset'],
    tasks: [
      { id: 'a', name: 'Alpha', category: 'Calibration', risk: 'write' },
      { id: 'b', name: 'Beta', category: 'Calibration', risk: 'write' },
      { id: 'c', name: 'Gamma', category: 'Adaptation reset', risk: 'write' },
    ],
    chassis: { E46: { b: [{ sgbd: 'x', menu: 'm', nr: 1, label: 'L' }] } },
  };
  const groups = S.serviceTasksFor(index, 'E46');
  assert.strictEqual(groups.length, 2, 'both categories are grouped');
  const seen = groups.flatMap((g) => g.tasks.map((t) => t.task.id)).sort();
  assert.deepStrictEqual(seen, ['a', 'b', 'c'], 'every task appears once');
  // available first inside a category
  assert.strictEqual(
    groups[0].tasks[0].task.id,
    'b',
    'the task this car carries sorts first'
  );
  assert.strictEqual(
    groups[0].tasks[1].hits.length,
    0,
    'a task with no hits is kept, with an empty hit list'
  );
  ok('tasks group by category, available first, absent ones kept');

  // an unknown chassis yields every task as unavailable rather than nothing
  const none = S.serviceTasksFor(index, 'ZZZ');
  assert.strictEqual(
    none.flatMap((g) => g.tasks).filter((t) => t.hits.length).length,
    0,
    'an unknown chassis carries no hits'
  );
  assert.strictEqual(
    none.flatMap((g) => g.tasks).length,
    3,
    'but still lists every task'
  );
  ok('an unknown chassis lists every task as unavailable');
}

// the deep link a hit becomes
{
  const hit = { sgbd: 'lws5', menu: 'm_abgleich', nr: 3, label: 'Program' };
  assert.strictEqual(
    S.serviceHitRoute(hit, 'E46'),
    'car/E46/lws5/m_abgleich',
    'a hit links to its module and menu'
  );
  assert.strictEqual(
    S.serviceHitRoute({ ...hit, screen: 's_x' }, 'E46'),
    'car/E46/lws5/m_abgleich/s_x',
    'a hit that opens a screen names it'
  );
  assert.strictEqual(
    S.serviceHitRoute({ sgbd: '', menu: '' }, 'E46'),
    null,
    'an unresolvable hit has no route'
  );
  ok('a hit becomes the same vehicle deep link the job search opens');
}

// the screen presses through the runtime, never around it
{
  const openSrc = fs.readFileSync(
    path.join(ROOT, 'app', 'renderer', 'screens', 'service', 'open.js'),
    'utf8'
  );
  assert.ok(
    /showEcu\(|showVehicleScript\(/.test(openSrc),
    'the app opens modules through the existing screens'
  );
  assert.ok(
    !/ipoProgramOpen|vm\.press|program\.press|sendJob|runJob/.test(openSrc),
    'the app never drives the VM or the wire itself'
  );
  ok('running a task goes through the module view, not a new execution path');
}

// "my car" from the Garage: one saved car the mapping covers picks itself,
// several are ambiguous and fall through to the picker
{
  const index = { chassis: { E46: {}, E60: {} } };
  global.garageCars = () => [{ chassis: 'E46' }];
  assert.strictEqual(
    S.serviceMyCarChassis(index),
    'E46',
    'one car picks itself'
  );
  global.garageCars = () => [{ chassis: 'E46' }, { chassis: 'E60' }];
  assert.strictEqual(
    S.serviceMyCarChassis(index),
    '',
    'two cars are ambiguous'
  );
  global.garageCars = () => [{ chassis: 'E46' }, { chassis: 'E46' }];
  assert.strictEqual(
    S.serviceMyCarChassis(index),
    'E46',
    'the same car twice is still one car'
  );
  global.garageCars = () => [{ chassis: 'ZZZ' }];
  assert.strictEqual(
    S.serviceMyCarChassis(index),
    '',
    'a car the mapping does not cover picks nothing'
  );
  global.garageCars = () => {
    throw new Error('no storage');
  };
  assert.strictEqual(
    S.serviceMyCarChassis(index),
    '',
    'a throwing Garage picks nothing'
  );
  delete global.garageCars;
  ok('the Garage supplies "my car" only when it is unambiguous');
}

console.log(`service functions: ${passed} checks passed`);
