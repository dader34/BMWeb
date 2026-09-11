#!/usr/bin/env node
// The ISTA shell's pure half: the tab model, the route grammar, the
// favourites store, the banner's description line, and the two details-page
// formatters.
//
// The shell itself is chrome around screens this test cannot run (they want a
// bus and a DOM). What IS testable is everything that decides WHICH screen a
// click reaches and what the banner says about the car -- and those are
// exactly the parts a wrong answer would make silently useless: a route that
// does not round-trip strands a link, a favourite that resolves to nothing
// draws a dead row, an opener named in the table that no file defines greys a
// tab that should work.
//
//   node tools/verify/test_ista.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadClassic } = require('./lib/load_classic.js');

const ROOT = path.join(__dirname, '..', '..');
let passed = 0;
const ok = (what) => {
  passed++;
  if (process.env.V) console.log('  ok', what);
};

// the browser globals the pieces lean on at load
global.window = global.window || {};
global.document = global.document || undefined;
global.esc = (s) =>
  String(s == null ? '' : s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c]
  );

// Settings, the store the shell's favourites and car memory live in
const store = {};
global.Settings = {
  get: (k, d) => (k in store ? store[k] : d),
  set: (k, v) => {
    store[k] = v;
  },
};

const I = loadClassic('screens/ista/');

// ---- the tab model ---------------------------------------------------------
{
  const { ISTA_TABS, istaTab, istaSub, istaSubsOf, istaFirstSub } = I;
  assert.ok(ISTA_TABS.length >= 6, 'the shell has its tabs');
  ok('tabs exist');

  // ids are unique, and so are the sub-ids inside a tab -- the route addresses
  // a sub-tab by (tab, sub), so a duplicate makes one of them unreachable
  const tabIds = ISTA_TABS.map((t) => t.id);
  assert.strictEqual(new Set(tabIds).size, tabIds.length, 'tab ids are unique');
  for (const t of ISTA_TABS) {
    const ids = (t.subs || []).map((s) => s.id);
    assert.strictEqual(
      new Set(ids).size,
      ids.length,
      `sub ids unique in ${t.id}`
    );
  }
  ok('ids are unique');

  // EVERY row is exactly one of the four kinds. A row that is none of them
  // draws as an enabled button that does nothing when clicked; a row that is
  // two of them has an opener the shell will never reach.
  const kindOf = (s) => [s.open, s.page, s.why, s.subs3].filter(Boolean).length;
  for (const t of ISTA_TABS) {
    for (const s of t.subs || []) {
      assert.strictEqual(
        kindOf(s),
        1,
        `${t.id}/${s.id} is exactly one of open|page|why|subs3 (got ${kindOf(s)})`
      );
      assert.ok(s.label, `${t.id}/${s.id} has a label`);
      if (s.open || s.page)
        assert.ok(s.desc, `${t.id}/${s.id} has a description`);
      // a level-3 strip's own rows follow the same rule, minus the nesting:
      // the tree is exactly three deep and never four
      for (const c of s.subs3 || []) {
        const k = [c.open, c.page, c.why].filter(Boolean).length;
        assert.strictEqual(
          k,
          1,
          `${t.id}/${s.id}/${c.id} is exactly one of open|page|why (got ${k})`
        );
        assert.ok(c.label, `${t.id}/${s.id}/${c.id} has a label`);
        assert.ok(!c.subs3, `${t.id}/${s.id}/${c.id} does not nest further`);
        if (c.open || c.page)
          assert.ok(c.desc, `${t.id}/${s.id}/${c.id} has a description`);
      }
      // level-3 ids are unique inside their strip
      const ids3 = (s.subs3 || []).map((c) => c.id);
      assert.strictEqual(
        new Set(ids3).size,
        ids3.length,
        `level-3 ids unique in ${t.id}/${s.id}`
      );
    }
  }
  ok('every row is open, page, why or a level-3 strip');

  // THE TAB LABELS ARE BMW'S, verbatim. They are landmarks a technician
  // navigates by, so a tidy-up here is a tool that no longer matches the one
  // they trained on -- this pins the seven that name the main bar.
  assert.deepStrictEqual(
    ISTA_TABS.map((t) => t.label.replace(/\n/g, '')),
    [
      'Operations',
      'Vehicle information',
      'Vehicle management',
      'Service plan',
      'Favourites',
      'Workshop/Operating fluids',
      'Measuring devices',
    ],
    "the main bar's labels are the real tool's"
  );
  assert.deepStrictEqual(
    I.istaSubs3Of('operations', 'new').map((s) => s.label),
    ['VIN', 'Read Out Vehicle Data', 'Model code', 'Basic Features'],
    'Operations / New has its four level-3 tabs'
  );
  assert.deepStrictEqual(
    I.istaSubs3Of('management', 'troubleshooting').map((s) => s.label),
    [
      'Fault memory',
      'Fault pattern',
      'Function Structure',
      'Component Structure',
      'Text Search',
      'SAE fault code input',
    ],
    'Troubleshooting has its six level-3 tabs'
  );
  assert.deepStrictEqual(
    ISTA_TABS.find((t) => t.id === 'service-plan').subs.map((s) => s.label),
    ['Hit list', 'Test plan', 'Programming plan'],
    'Service plan has its three sub-tabs'
  );
  ok("the labels are the real tool's");

  // Activation codes are gone for good, and the dev-only rows (Coding,
  // Programming) never reach the public site: not listed, not routable, and
  // a stale pin to one resolves to nothing there
  for (const t of ISTA_TABS)
    for (const s of t.subs || [])
      assert.notStrictEqual(s.id, 'activation-codes', 'no activation codes');
  for (const t of ISTA_TABS)
    for (const s of t.subs || [])
      assert.notStrictEqual(s.id, 'cbs', 'no CBS status row');
  // the dev-only rows are the two coding leaves under Vehicle modification;
  // programming has no row at all any more, it is a `why` on every leaf that
  // would have needed it
  const devIds = ISTA_TABS.flatMap((t) =>
    (t.subs || []).flatMap((s) =>
      [s, ...(s.subs3 || [])].filter((x) => x.dev).map((x) => x.id)
    )
  );
  assert.deepStrictEqual(devIds.sort(), ['conversion-coding', 'remove-coding']);
  assert.ok(
    I.istaSub3('management', 'modification', 'conversion-coding'),
    'dev host lists the coding leaf'
  );
  global.codingReady = () => false;
  try {
    const pub = I.istaSubs3Of('management', 'modification').map((s) => s.id);
    assert.ok(!pub.includes('conversion-coding'), 'public: no Coding leaf');
    assert.ok(!pub.includes('remove-coding'), 'public: no second Coding leaf');
    assert.ok(pub.includes('retrofit'), 'public keeps the rest');
    assert.strictEqual(
      I.istaSub3('management', 'modification', 'conversion-coding'),
      null,
      'not routable'
    );
  } finally {
    delete global.codingReady;
  }
  // programming is refused everywhere it could be asked for, by a reason
  // rather than by a missing tab
  const progWhy = ISTA_TABS.flatMap((t) =>
    (t.subs || []).flatMap((s) =>
      [s, ...(s.subs3 || [])].filter((x) => /programming/i.test(x.why || ''))
    )
  );
  assert.ok(progWhy.length >= 4, 'programming is refused, with a reason');
  ok('activation codes gone; coding is dev-only; programming is refused');

  // the page kinds are the two details.js draws, and nothing else
  const pages = ISTA_TABS.flatMap((t) =>
    (t.subs || []).flatMap((s) =>
      [s, ...(s.subs3 || [])].filter((x) => x.page).map((x) => x.page)
    )
  );
  assert.deepStrictEqual(
    [...new Set(pages)].sort(),
    [
      'active',
      'details',
      'equipment',
      'readout',
      'repair-host',
      'techdata',
      'vin',
    ],
    'only the pages the shell draws itself'
  );
  ok('page kinds are the ones that exist');

  assert.strictEqual(istaTab('operations').label, 'Operations');
  assert.strictEqual(istaTab('nope'), null);
  assert.strictEqual(istaSub('service-plan', 'hit-list').open, 'showLookup');
  assert.strictEqual(istaSub('operations', 'nope'), null);
  assert.strictEqual(istaSub('nope', 'hit-list'), null);
  assert.strictEqual(
    I.istaSub3('operations', 'new', 'vin').page,
    'vin',
    'a level-3 tab looks up'
  );
  assert.strictEqual(I.istaSub3('operations', 'new', 'nope'), null);
  assert.strictEqual(I.istaSub3('operations', 'finished', 'vin'), null);
  ok('lookups by id');

  assert.strictEqual(
    istaFirstSub('operations').id,
    'new',
    'a tab opens on its first sub-tab'
  );
  assert.strictEqual(
    I.istaFirstSub3('operations', 'new').id,
    'vin',
    'a sub-tab with a strip opens on its first level-3 tab'
  );
  assert.strictEqual(
    I.istaFirstSub3('operations', 'finished'),
    null,
    'a sub-tab with no strip has no level-3 tab'
  );
  assert.strictEqual(istaSubsOf('nope').length, 0);
  ok('first sub-tab');

  // THE LEAF: what a route actually lands on. A sub-tab with a strip resolves
  // to a level-3 row; one without resolves to itself. Everything downstream
  // works on this, so a wrong answer here opens the wrong screen.
  assert.strictEqual(
    I.istaLeaf('operations', 'new', null).id,
    'vin',
    'a group resolves to its first leaf'
  );
  assert.strictEqual(
    I.istaLeaf('operations', 'new', 'model-code').id,
    'model-code',
    'a named leaf wins'
  );
  assert.strictEqual(
    I.istaLeaf('operations', 'new', 'nope').id,
    'vin',
    'an unknown leaf falls back to the first'
  );
  assert.strictEqual(
    I.istaLeaf('operations', 'finished', null).id,
    'finished',
    'a sub-tab with no strip is its own leaf'
  );
  assert.strictEqual(I.istaLeaf('operations', 'nope', null), null);
  ok('the leaf resolves');
}

// ---- every named opener actually exists ------------------------------------
// The model names its openers by STRING, which the shell resolves off window
// at click time. A typo there is invisible until someone clicks the tab and
// gets a grey "not in this build" for a screen that shipped fine.
{
  const html = fs.readFileSync(
    path.join(ROOT, 'app', 'renderer', 'index.html'),
    'utf8'
  );
  const srcs = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(
    (m) => m[1]
  );
  let all = '';
  for (const rel of srcs) {
    const p = path.join(ROOT, 'app', 'renderer', rel);
    if (fs.existsSync(p)) all += fs.readFileSync(p, 'utf8') + '\n';
  }
  const names = new Set(
    [
      ...all.matchAll(/^(?:async function|function)\s+([A-Za-z_$][\w$]*)/gm),
    ].map((m) => m[1])
  );
  for (const t of I.ISTA_TABS) {
    for (const s of t.subs || []) {
      for (const x of [s, ...(s.subs3 || [])]) {
        if (!x.open) continue;
        assert.ok(
          names.has(x.open),
          `${t.id}/${s.id}/${x.id} names ${x.open}, which no renderer ` +
            `file defines`
        );
      }
    }
  }
  ok('every named opener is a real function');
}

// ---- the route grammar -----------------------------------------------------
{
  const { istaRouteParse, istaRouteBuild } = I;

  assert.deepStrictEqual(istaRouteParse('ista'), {
    tab: 'operations',
    sub: null,
    sub3: null,
    car: null,
  });
  assert.deepStrictEqual(istaRouteParse('ista/information'), {
    tab: 'information',
    sub: null,
    sub3: null,
    car: null,
  });
  assert.deepStrictEqual(istaRouteParse('ista/information/details'), {
    tab: 'information',
    sub: 'details',
    sub3: null,
    car: null,
  });
  assert.deepStrictEqual(istaRouteParse('ista/operations/new/vin'), {
    tab: 'operations',
    sub: 'new',
    sub3: 'vin',
    car: null,
  });
  assert.deepStrictEqual(istaRouteParse('ista/operations/new/vin/abc-12'), {
    tab: 'operations',
    sub: 'new',
    sub3: 'vin',
    car: 'abc-12',
  });
  ok('routes parse');

  // A THREE-PART ROUTE WRITTEN BEFORE THE LEVEL-3 STRIPS EXISTED still opens
  // the car it named. The two shapes cannot be told apart by their text, so
  // the third part is read as a level-3 tab only when the tab and sub-tab
  // ahead of it really have one of that name -- which no old link ever did.
  assert.deepStrictEqual(istaRouteParse('ista/information/details/abc-12'), {
    tab: 'information',
    sub: 'details',
    sub3: null,
    car: 'abc-12',
  });
  assert.deepStrictEqual(istaRouteParse('ista/operations/new/abc-12'), {
    tab: 'operations',
    sub: 'new',
    sub3: null,
    car: 'abc-12',
  });
  ok('old three-part routes still name a car');

  // a route that is not ours is not ours -- the router must fall through to
  // the vehicle and apps patterns rather than swallowing them
  for (const bad of [
    '',
    'apps',
    'apps/tree',
    'garage/x',
    'istanbul',
    'car/E46',
  ])
    assert.strictEqual(
      istaRouteParse(bad),
      null,
      `${bad} is not an ISTA route`
    );
  ok('foreign routes are refused');

  // round-trip: build then parse gives back what went in
  const cases = [
    [null, null, null, null],
    ['information', null, null, null],
    ['information', 'details', null, null],
    ['information', 'details', null, 'abc-12'],
    ['operations', 'new', 'vin', null],
    ['operations', 'new', 'vin', 'abc-12'],
    ['management', 'troubleshooting', 'fault-memory', 'x_9-Z'],
  ];
  for (const [tab, sub, sub3, car] of cases) {
    const route = istaRouteBuild(tab, sub, sub3, car);
    const back = istaRouteParse(route);
    assert.ok(back, `${route} parses`);
    assert.strictEqual(back.tab, tab || 'operations', `${route} tab`);
    assert.strictEqual(back.sub, sub, `${route} sub`);
    assert.strictEqual(back.sub3, sub3, `${route} sub3`);
    assert.strictEqual(back.car, car, `${route} car`);
  }
  ok('routes round-trip');

  // the car sits in the fourth slot, so a route with a car and no level-3
  // must still fill the slot ahead of it or the two would swap places
  assert.strictEqual(
    istaRouteBuild('information', 'details', null, 'abc'),
    'ista/information/details/-/abc'
  );
  assert.strictEqual(istaRouteBuild(null, null, null, null), 'ista');
  assert.strictEqual(istaRouteBuild(null, null, null, 'abc'), 'ista');
  ok('the home route is bare');
}

// ---- the router carries the route ------------------------------------------
{
  const router = fs.readFileSync(
    path.join(ROOT, 'app', 'renderer', 'core', 'router.js'),
    'utf8'
  );
  assert.ok(/\bista:\s*\(\)\s*=>/.test(router), 'router has the exact route');
  assert.ok(/\^ista\\\//.test(router), 'router has the parametrised route');
  assert.ok(
    /istaChromeActive/.test(router) && /istaChromeHide/.test(router),
    'router tears the shell down when a foreign screen renders'
  );
  assert.ok(
    /istaOpening/.test(router),
    "router exempts the shell's own wrapped screens from that teardown"
  );
  ok('router is wired');
}

// ---- favourites ------------------------------------------------------------
{
  const {
    istaFavourites,
    istaIsFavourite,
    istaFavouriteToggle,
    ISTA_FAVS_KEY,
    ISTA_FAVS_CAP,
  } = I;

  delete store[ISTA_FAVS_KEY];
  assert.deepStrictEqual(istaFavourites(), [], 'empty to begin with');
  assert.strictEqual(istaIsFavourite('service-plan', 'hit-list'), false);

  assert.strictEqual(istaFavouriteToggle('service-plan', 'hit-list'), true);
  assert.strictEqual(istaIsFavourite('service-plan', 'hit-list'), true);
  assert.deepStrictEqual(istaFavourites(), [
    { tab: 'service-plan', sub: 'hit-list' },
  ]);
  ok('a pin sticks');

  // newest first
  istaFavouriteToggle('information', 'details');
  assert.deepStrictEqual(istaFavourites()[0], {
    tab: 'information',
    sub: 'details',
  });
  ok('newest pin leads');

  assert.strictEqual(istaFavouriteToggle('service-plan', 'hit-list'), false);
  assert.strictEqual(istaIsFavourite('service-plan', 'hit-list'), false);
  assert.strictEqual(istaFavourites().length, 1, 'unpin removes it');
  ok('a pin unpins');

  // A LEVEL-3 PIN IS ITS OWN PIN. Pinning Troubleshooting/Fault memory must
  // not read as pinning Troubleshooting itself, or the star on the strip
  // would light for a row nobody pinned and un-pin one they did.
  store[ISTA_FAVS_KEY] = [];
  assert.strictEqual(
    istaFavouriteToggle('management', 'troubleshooting', 'fault-memory'),
    true
  );
  assert.strictEqual(
    istaIsFavourite('management', 'troubleshooting', 'fault-memory'),
    true
  );
  assert.strictEqual(
    istaIsFavourite('management', 'troubleshooting'),
    false,
    'the level-3 pin is not a pin on its parent'
  );
  assert.deepStrictEqual(istaFavourites(), [
    { tab: 'management', sub: 'troubleshooting', sub3: 'fault-memory' },
  ]);
  assert.strictEqual(
    istaFavouriteToggle('management', 'troubleshooting', 'fault-memory'),
    false
  );
  assert.deepStrictEqual(istaFavourites(), []);
  ok('a level-3 pin is its own pin');

  // a pin naming a level-3 tab this build no longer has is dropped too
  store[ISTA_FAVS_KEY] = [
    { tab: 'management', sub: 'troubleshooting', sub3: 'gone-away' },
    { tab: 'management', sub: 'troubleshooting', sub3: 'fault-memory' },
  ];
  assert.deepStrictEqual(istaFavourites(), [
    { tab: 'management', sub: 'troubleshooting', sub3: 'fault-memory' },
  ]);
  ok('stale level-3 pins are dropped');

  // A pin naming a sub-tab this build no longer has is DROPPED, not drawn.
  // Otherwise a renamed tab leaves a row that greys with no reason and
  // cannot be un-pinned, because the star it would need is the one that is
  // gone.
  store[ISTA_FAVS_KEY] = [
    { tab: 'operations', sub: 'gone-away' },
    { tab: 'no-such-tab', sub: 'details' },
    { tab: 'information', sub: 'details' },
  ];
  assert.deepStrictEqual(istaFavourites(), [
    { tab: 'information', sub: 'details' },
  ]);
  ok('stale pins are dropped');

  // junk in the store must not take the screen down
  store[ISTA_FAVS_KEY] = 'not an array';
  assert.deepStrictEqual(istaFavourites(), []);
  store[ISTA_FAVS_KEY] = [null, 42, { tab: 'operations' }, { sub: 'x' }];
  assert.deepStrictEqual(istaFavourites(), []);
  ok('junk in the store reads as empty');

  // the cap holds
  store[ISTA_FAVS_KEY] = [];
  const subs = I.ISTA_TABS.flatMap((t) =>
    (t.subs || []).map((s) => ({ tab: t.id, sub: s.id }))
  );
  store[ISTA_FAVS_KEY] = [];
  for (let i = 0; i < ISTA_FAVS_CAP + 5; i++) {
    const s = subs[i % subs.length];
    store[ISTA_FAVS_KEY] = [
      { tab: s.tab, sub: s.sub },
      ...store[ISTA_FAVS_KEY],
    ];
  }
  assert.ok(istaFavourites().length <= ISTA_FAVS_CAP, 'the cap holds');
  ok('the favourites cap holds');

  // the Favourites tab resolves its pins back to real sub-tabs
  store[ISTA_FAVS_KEY] = [{ tab: 'information', sub: 'details' }];
  const fav = I.istaSubsOf('favourites');
  assert.strictEqual(fav.length, 1);
  assert.strictEqual(fav[0].id, 'details');
  assert.strictEqual(fav[0].label, 'Vehicle details');
  assert.strictEqual(fav[0]._tab, 'information', 'the owning tab is carried');
  ok('favourites resolve to their sub-tabs');
}

// ---- the banner's description line -----------------------------------------
{
  const { istaCarBits } = I;
  // the formatters the Garage uses; the shell must go through them so a date
  // reads the same in both places
  global.etkYearMonth = (p) => `${p.slice(0, 4)}-${p.slice(4, 6)}`;
  global.bodyLabel = (b) => ({ LIM: 'Saloon', TOU: 'Touring' })[b] || b;

  assert.strictEqual(istaCarBits(null), '', 'no car, no line');
  assert.strictEqual(istaCarBits({}), '', 'nothing known, no line');
  assert.strictEqual(
    istaCarBits({
      model: '330i',
      body: 'LIM',
      motor: 'M54B30',
      prod: '200206',
    }),
    '330i · Saloon · M54B30 · 2002-06'
  );
  // the chassis is NOT in the line: the banner already shows it on its own
  assert.ok(
    !istaCarBits({ chassis: 'E46', model: '330i' }).includes('E46'),
    'the chassis is not repeated in the description'
  );
  // partial cars still read
  assert.strictEqual(istaCarBits({ model: '330i' }), '330i');
  assert.strictEqual(istaCarBits({ motor: 'M54B30' }), 'M54B30');
  ok('the banner description composes');
}

// ---- the details page's formatters -----------------------------------------
{
  const { istaKm, istaDetailRow, ISTA_KM_MAX } = I;

  assert.strictEqual(istaKm(null), '');
  assert.strictEqual(istaKm(undefined), '');
  assert.strictEqual(istaKm(0), '', 'zero is not a reading');
  assert.strictEqual(istaKm(-5), '');
  assert.strictEqual(istaKm(ISTA_KM_MAX), '', 'the implausible cap holds');
  assert.strictEqual(istaKm('nonsense'), '');
  assert.strictEqual(istaKm(184300), '184 300 km');
  assert.strictEqual(istaKm(999), '999 km');
  ok('kilometres format');

  // the saved and read columns disagreeing is a finding, and the row says so
  assert.ok(
    istaDetailRow('VIN', 'AAA', 'BBB').includes('ista-differs'),
    'a disagreement is marked'
  );
  assert.ok(
    !istaDetailRow('VIN', 'AAA', 'AAA').includes('ista-differs'),
    'agreement is not marked'
  );
  assert.ok(
    istaDetailRow('VIN', 'AAA', 'AAA').includes('ista-match'),
    'agreement is ticked'
  );
  // one side missing is not a disagreement -- it is a blank
  assert.ok(!istaDetailRow('VIN', 'AAA', '').includes('ista-differs'));
  assert.ok(!istaDetailRow('VIN', '', 'BBB').includes('ista-differs'));
  assert.ok(istaDetailRow('VIN', '', '').includes('ista-none'));
  ok('the details rows mark what disagrees');
}

// ---- the shell is listed where the app expects it ---------------------------
{
  const html = fs.readFileSync(
    path.join(ROOT, 'app', 'renderer', 'index.html'),
    'utf8'
  );
  const off = fs.readFileSync(
    path.join(ROOT, 'app', 'renderer', 'core', 'offline-export.js'),
    'utf8'
  );
  for (const f of [
    'screens/ista/model.js',
    'screens/ista/banner.js',
    'screens/ista/skin.js',
    'screens/ista/details.js',
    'screens/ista/pages.js',
    'screens/ista/screen.js',
  ]) {
    assert.ok(html.includes(f), `index.html loads ${f}`);
    assert.ok(off.includes(f), `OFFLINE_SHELL carries ${f}`);
  }
  assert.ok(html.includes('css/ista-real.css'), 'index.html loads the skin');
  assert.ok(
    off.includes('css/ista-real.css'),
    'OFFLINE_SHELL carries the skin'
  );
  assert.ok(html.includes('id="ista-btn"'), 'the topbar has the entry');
  const apps = fs.readFileSync(
    path.join(ROOT, 'app', 'renderer', 'screens', 'apps.js'),
    'utf8'
  );
  assert.ok(/id: 'ista'/.test(apps), 'the hub has the tile');
  ok('the shell is wired into the app');
}

// ---- the skin is scoped, and shaped by its one rule -------------------------
// THE WHOLE POINT OF THE SCOPE CLASS is that the Modern layout and the rest
// of the app are untouched. A rule that escapes .ista-real restyles screens
// nobody asked to restyle, and the only way that is caught is by reading the
// stylesheet: it has no test a click could fail.
{
  const css = fs.readFileSync(
    path.join(ROOT, 'app', 'renderer', 'css', 'ista-real.css'),
    'utf8'
  );
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = body
    .split('}')
    .map((b) => b.split('{')[0].trim())
    .filter((sel) => sel && !sel.startsWith('@') && !/^\d+%$/.test(sel));
  for (const sel of selectors)
    for (const one of sel.split(','))
      assert.ok(
        /\.ista-real/.test(one),
        `every rule is scoped under .ista-real, but "${one.trim()}" is not`
      );
  ok('every skin rule is scoped');

  // the shape rule, in one function: square while another strip follows,
  // trapezoid when it is the last strip on the page. Getting this backwards
  // is the single most visible way to miss the real tool's chrome.
  const { istaStripClass } = I;
  assert.strictEqual(istaStripClass(true), 'irstrip-cut');
  assert.strictEqual(istaStripClass(false), 'irstrip-grid');
  assert.ok(
    /irstrip-cut[^{]*\{[^}]*clip-path/.test(body.replace(/\n/g, '')),
    'the cut strip is the one with the clip-path'
  );
  ok('the strip shape rule holds');

  // the measured palette: these three carry the look and are sampled off
  // the frames, not chosen -- a drifted value is what makes a skin read as
  // an imitation, and nothing else in the app would notice
  for (const [name, value] of [
    ['--ir-teal', '#5e958f'],
    ['--ir-grey', '#c5c5c5'],
    ['--ir-head', '#4d4d4d'],
  ])
    assert.ok(
      new RegExp(`${name}:\\s*${value}`).test(body),
      `${name} is the measured ${value}`
    );
  ok('the measured palette is intact');
}

// ---- the skin's own pieces --------------------------------------------------
{
  const { istaRealIcon, istaRealClock, istaRealVehicleLine } = I;

  // EVERY ICON IS DRAWN. An emoji is a font the machine may not have, and a
  // toolbar that renders a tofu box where its close button should be is
  // worse than no icon at all.
  for (const n of [
    'home',
    'tile',
    'print',
    'wrench',
    'help',
    'restore',
    'close',
    'list',
    'star',
    'warn',
  ]) {
    const svg = istaRealIcon(n);
    assert.ok(svg.startsWith('<svg'), `${n} is an svg`);
    assert.ok(/<path/.test(svg), `${n} has a path`);
    // no emoji anywhere in the chrome
    assert.ok(
      !/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(svg),
      `${n} is drawn, not an emoji`
    );
  }
  assert.strictEqual(istaRealIcon('no-such-icon'), '');
  ok('every toolbar icon is drawn');

  assert.strictEqual(
    istaRealClock(new Date(2021, 0, 27, 17, 2, 32)),
    '27/01/2021 17:02:32',
    "the clock is in the tool's own format"
  );
  ok('the clock formats');

  // the header's vehicle line is POSITIONAL: ten slash-separated parts, with
  // a '-' wherever nobody knows, so it can be read by position even when
  // half of it is unknown
  const line = istaRealVehicleLine(
    { chassis: 'E46' },
    {
      model: "3'",
      chassis: 'E46',
      body: 'Cou',
      motor: 'M54',
      gear: 'M',
      market: 'US',
      steer: 'L',
      prod: 20020115,
    }
  );
  assert.strictEqual(line.split('/').length, 10, 'ten parts, always');
  assert.ok(line.includes('M54'), 'the engine is in it');
  assert.ok(line.includes('MANUAL'), 'the gearbox reads as a word');
  assert.ok(line.includes('LL'), 'the steering reads as LL/RL');
  assert.ok(line.endsWith('2002/01'), 'the build year and month end it');
  assert.strictEqual(
    istaRealVehicleLine(null, null),
    '',
    'nothing known, no line'
  );
  assert.strictEqual(
    istaRealVehicleLine({}, {}).split('/').length,
    10,
    'an unknown car still keeps its ten slots'
  );
  ok('the header vehicle line composes');
}

// ---- the VIN the start page will act on -------------------------------------
{
  const { istaVinOk, istaVal } = I;
  assert.ok(istaVinOk('WBABN53422JU26661'), 'a full VIN');
  assert.ok(istaVinOk('JU26661'), 'the seven-character production number');
  assert.ok(istaVinOk(' wbabn53422ju26661 '), 'trimmed and upper-cased');
  assert.ok(!istaVinOk(''), 'nothing is not a VIN');
  assert.ok(!istaVinOk('ABC'), 'too short');
  assert.ok(!istaVinOk('WBABN53422JU266611'), 'too long');
  // I, O and Q are not VIN characters: a typo for 1 or 0 must not open a car
  assert.ok(!istaVinOk('WBABN53422IU26661'), 'I is not a VIN character');
  assert.ok(!istaVinOk('WBABN53422OU26661'), 'O is not a VIN character');
  ok('the VIN box knows what a VIN is');

  assert.strictEqual(istaVal(''), '-', 'the tool writes - for nothing');
  assert.strictEqual(istaVal(null), '-');
  assert.strictEqual(istaVal(undefined), '-');
  assert.strictEqual(istaVal(0), '0', 'zero is a value, not nothing');
  assert.strictEqual(istaVal('<b>'), '&lt;b&gt;', 'values are escaped');
  ok('the - placeholder holds');
}

// ---- the details grid is the tool's own four columns ------------------------
{
  const { istaDetailColumns } = I;
  const cols = istaDetailColumns(
    { vin: 'WBABN53422JU26661', chassis: 'E46' },
    {
      model: "3'",
      chassis: 'E46',
      body: 'Cou',
      motor: 'M54',
      gear: 'M',
      market: 'US',
      steer: 'L',
      mospid: 'BN53',
      prod: 20020101,
    },
    {}
  );
  assert.strictEqual(cols.length, 4, 'four columns');
  for (const c of cols)
    assert.strictEqual(c.length, 7, 'seven fields in each column');
  // THE ORDER IS THE TOOL'S, not alphabetical and not grouped by source: a
  // technician reads this grid by position, so a re-ordered column is a
  // field they will read as the wrong one
  assert.deepStrictEqual(
    cols.map((c) => c[0][0]),
    ['VIN', 'Series', 'Development code:', 'Sales designation'],
    'each column starts where the tool starts it'
  );
  assert.deepStrictEqual(
    cols[0].map((f) => f[0]),
    [
      'VIN',
      'Mileage:',
      'Drive type',
      'Production date',
      'Body',
      'First registration',
      'Basic version',
    ],
    "the first column is the tool's"
  );
  const flat = cols.flat();
  assert.ok(
    flat.some((f) => f[0] === 'Gearbox' && f[1] === 'MANUAL'),
    'the gearbox reads as a word'
  );
  assert.ok(
    flat.some((f) => f[0] === 'Model code' && f[1] === 'BN53'),
    'the model code comes off the catalogue decode'
  );
  // THE TRIANGLE IS NOT "THIS CAME FROM THE VIN". On a fully decoded E46 the
  // real tool draws exactly one, on Sales designation, and none on Series,
  // Engine, Body or Production date -- all of which the VIN gave it. It marks
  // the one flagged field it could not resolve at all, so flagging every
  // VIN-derived field would cover the grid and hide the one that matters.
  assert.strictEqual(
    flat.filter((f) => f[2]).length,
    1,
    'exactly one triangle on a decoded car'
  );
  assert.strictEqual(
    flat.find((f) => f[0] === 'Sales designation')[2],
    true,
    'the unresolved flagged field carries it'
  );
  for (const label of ['Series', 'Engine', 'Body', 'Production date', 'VIN'])
    assert.strictEqual(
      flat.find((f) => f[0] === label)[2],
      false,
      `${label} came from the VIN and is NOT flagged`
    );
  // a flagged field that DID resolve loses its triangle
  const withSales = istaDetailColumns(
    { vin: 'X' },
    { model: 'X', sales: 'y' },
    {}
  ).flat();
  assert.strictEqual(
    withSales.filter((f) => f[2]).length,
    1,
    'still only the flagged field can carry one'
  );
  ok("the details grid is the tool's four columns");
}

// ---- the bottom bar is per page, not one template ---------------------------
// THE NAV ARROWS ARE THE POINT. Every page used to inherit one template, so
// every page grew the pair of black nav blocks. The frames show them only on
// pages that STEP THROUGH a list of hits: the two-pane browsers and the
// Service plan lists. A page that is not such a list must not have them.
{
  const { ISTA_BOTTOM, istaBottomFor } = I;
  const hasNav = (id) => istaBottomFor(id).some((b) => b.nav);

  for (const id of ['service-functions', 'product-structure', 'hit-list'])
    assert.ok(hasNav(id), `${id} steps through hits, so it keeps the arrows`);
  for (const id of [
    'vin',
    'readout',
    'details',
    'equipment',
    'fault-memory',
    'fault-pattern',
    'none',
  ])
    assert.ok(!hasNav(id), `${id} is not a hit list: no nav arrows`);
  ok('the nav arrows are only where the frames have them');

  // Vehicle details, straight off key2/t0159.0.jpg: four buttons, the first
  // two greyed, and no arrows
  assert.deepStrictEqual(
    istaBottomFor('details')
      .filter((b) => b.label)
      .map((b) => [b.label, !!b.off]),
    [
      ['Display measures plan', true],
      ['Write service history', true],
      ['Start vehicle test', false],
      ['Information search', false],
    ],
    "Vehicle details carries the frame's own four buttons"
  );
  // the VIN start page: Keyboard greyed at the left, Open operation at the
  // right, and nothing between them
  assert.deepStrictEqual(
    istaBottomFor('vin').map((b) => b.label || (b.spacer ? '|' : '?')),
    ['Keyboard', '|', 'Open operation']
  );
  ok("the frames' own button rows");

  // a page with nothing of its own draws NO bar rather than a bare pair of
  // arrows that step through nothing
  assert.deepStrictEqual(istaBottomFor('none'), []);
  assert.deepStrictEqual(istaBottomFor('no-such-page'), []);
  ok('an unknown page gets no bar');

  // every descriptor is exactly one kind, and every button has an id the
  // screen can bind: a label with no id can never be wired to anything
  for (const [page, rows] of Object.entries(ISTA_BOTTOM))
    for (const b of rows) {
      const kinds = [b.nav, b.spacer, b.label].filter(Boolean).length;
      assert.strictEqual(kinds, 1, `${page}: one kind per descriptor`);
      if (b.label) assert.ok(b.id, `${page}/${b.label} has an id to bind`);
    }
  ok('every bottom-bar descriptor is bindable');
}

// ---- the header's values are the tool's, not the catalogue's ----------------
{
  const { istaAscii, istaSeries, istaGearbox, istaMarket } = I;

  // the tool's header is a fixed-pitch slash string and prints ASCII: it
  // writes "Coupe", never "Coupé"
  assert.strictEqual(istaAscii('Coupé'), 'Coupe');
  assert.strictEqual(istaAscii('Cabriolet'), 'Cabriolet');
  assert.strictEqual(istaAscii(''), '');
  assert.strictEqual(istaAscii(null), '');
  ok('the header folds to ASCII');

  // the SERIES, not the model name: the frames read 3'/E46/Coupe, never
  // 330Ci/E46/Coupe
  assert.strictEqual(istaSeries('330Ci'), "3'");
  assert.strictEqual(istaSeries('525i tour'), "5'");
  assert.strictEqual(istaSeries("3'"), "3'", 'an already-series name holds');
  // a name with no leading digit is passed through: inventing a series for
  // an X or i car would be worse than showing what we have
  assert.strictEqual(istaSeries('X5'), 'X5');
  assert.strictEqual(istaSeries(''), '');
  ok('the series comes off the model name');

  assert.strictEqual(istaGearbox({ gear: 'M' }, {}), 'MANUAL');
  assert.strictEqual(istaGearbox({ gear: 'A' }, {}), 'AUTO');
  // the saved column is tried before giving up, so "-" means nobody knows
  // rather than "we did not look"
  assert.strictEqual(istaGearbox({}, { gear: 'A' }), 'AUTO');
  assert.strictEqual(istaGearbox({}, {}), '');
  ok('the gearbox reads as a word, from either source');

  assert.strictEqual(istaMarket({ market: 'us' }, {}), 'US');
  assert.strictEqual(istaMarket({}, { market: 'ece' }), 'ECE');
  assert.strictEqual(istaMarket({}, {}), '');
  ok('the basic version is the market');
}

console.log(`test_ista: ${passed} checks passed`);
