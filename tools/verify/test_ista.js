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

  // EVERY sub-tab is exactly one of the three kinds. A row that is none of
  // them draws as an enabled button that does nothing when clicked.
  for (const t of ISTA_TABS) {
    for (const s of t.subs || []) {
      const kinds = [s.open, s.page, s.why].filter(Boolean).length;
      assert.strictEqual(
        kinds,
        1,
        `${t.id}/${s.id} is exactly one of open|page|why (got ${kinds})`
      );
      assert.ok(s.label, `${t.id}/${s.id} has a label`);
      // an openable row must say what it does; a grey one says why instead
      if (s.open || s.page)
        assert.ok(s.desc, `${t.id}/${s.id} has a description`);
    }
  }
  ok('every sub-tab is open, page or why');

  // Activation codes are gone for good, and the dev-only rows (Coding,
  // Programming) never reach the public site: not listed, not routable, and
  // a stale pin to one resolves to nothing there
  for (const t of ISTA_TABS)
    for (const s of t.subs || [])
      assert.notStrictEqual(s.id, 'activation-codes', 'no activation codes');
  for (const t of ISTA_TABS)
    for (const s of t.subs || [])
      assert.notStrictEqual(s.id, 'cbs', 'no CBS status row');
  const devIds = ISTA_TABS.flatMap((t) =>
    (t.subs || []).filter((s) => s.dev).map((s) => s.id)
  );
  assert.deepStrictEqual(devIds.sort(), ['coding', 'programming']);
  assert.ok(istaSub('management', 'coding'), 'dev host lists Coding');
  global.codingReady = () => false;
  try {
    const pub = istaSubsOf('management').map((s) => s.id);
    assert.ok(!pub.includes('coding'), 'public: no Coding row');
    assert.ok(!pub.includes('programming'), 'public: no Programming row');
    assert.ok(pub.includes('unit-functions'), 'public keeps the rest');
    assert.strictEqual(istaSub('management', 'coding'), null, 'not routable');
    assert.ok(istaSub('management', 'unit-functions'), 'others route');
  } finally {
    delete global.codingReady;
  }
  ok('activation codes gone; coding and programming are dev-only');

  // the page kinds are the two details.js draws, and nothing else
  const pages = ISTA_TABS.flatMap((t) =>
    (t.subs || []).filter((s) => s.page).map((s) => s.page)
  );
  assert.deepStrictEqual(
    pages.sort(),
    ['details', 'equipment', 'techdata'],
    'only the pages the shell draws itself'
  );
  ok('page kinds are the ones that exist');

  assert.strictEqual(istaTab('operations').label, 'Operations');
  assert.strictEqual(istaTab('nope'), null);
  assert.strictEqual(istaSub('operations', 'test-plan').open, 'showLookup');
  assert.strictEqual(istaSub('operations', 'nope'), null);
  assert.strictEqual(istaSub('nope', 'test-plan'), null);
  ok('lookups by id');

  assert.strictEqual(
    istaFirstSub('operations').id,
    'fault-memory',
    'a tab opens on its first sub-tab'
  );
  assert.strictEqual(istaSubsOf('nope').length, 0);
  ok('first sub-tab');
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
      if (!s.open) continue;
      assert.ok(
        names.has(s.open),
        `${t.id}/${s.id} names ${s.open}, which no renderer file defines`
      );
    }
  }
  ok('every named opener is a real function');
}

// ---- the route grammar -----------------------------------------------------
{
  const { istaRouteParse, istaRouteBuild } = I;

  assert.deepStrictEqual(istaRouteParse('ista'), {
    tab: 'home',
    sub: null,
    car: null,
  });
  assert.deepStrictEqual(istaRouteParse('ista/operations'), {
    tab: 'operations',
    sub: null,
    car: null,
  });
  assert.deepStrictEqual(istaRouteParse('ista/operations/test-plan'), {
    tab: 'operations',
    sub: 'test-plan',
    car: null,
  });
  assert.deepStrictEqual(istaRouteParse('ista/operations/test-plan/abc-12'), {
    tab: 'operations',
    sub: 'test-plan',
    car: 'abc-12',
  });
  ok('routes parse');

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
    [null, null, null],
    ['operations', null, null],
    ['operations', 'test-plan', null],
    ['operations', 'test-plan', 'abc-12'],
    ['information', 'details', 'x_9-Z'],
  ];
  for (const [tab, sub, car] of cases) {
    const route = istaRouteBuild(tab, sub, car);
    const back = istaRouteParse(route);
    assert.ok(back, `${route} parses`);
    assert.strictEqual(back.tab, tab || 'home', `${route} tab`);
    assert.strictEqual(back.sub, sub, `${route} sub`);
    assert.strictEqual(back.car, car, `${route} car`);
  }
  ok('routes round-trip');

  assert.strictEqual(istaRouteBuild(null, null, null), 'ista');
  assert.strictEqual(istaRouteBuild('home', null, null), 'ista');
  // a car with no tab has nowhere positional to sit; the bare route stands
  assert.strictEqual(istaRouteBuild(null, null, 'abc'), 'ista');
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
  assert.strictEqual(istaIsFavourite('operations', 'test-plan'), false);

  assert.strictEqual(istaFavouriteToggle('operations', 'test-plan'), true);
  assert.strictEqual(istaIsFavourite('operations', 'test-plan'), true);
  assert.deepStrictEqual(istaFavourites(), [
    { tab: 'operations', sub: 'test-plan' },
  ]);
  ok('a pin sticks');

  // newest first
  istaFavouriteToggle('information', 'details');
  assert.deepStrictEqual(istaFavourites()[0], {
    tab: 'information',
    sub: 'details',
  });
  ok('newest pin leads');

  assert.strictEqual(istaFavouriteToggle('operations', 'test-plan'), false);
  assert.strictEqual(istaIsFavourite('operations', 'test-plan'), false);
  assert.strictEqual(istaFavourites().length, 1, 'unpin removes it');
  ok('a pin unpins');

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
    'screens/ista/details.js',
    'screens/ista/screen.js',
  ]) {
    assert.ok(html.includes(f), `index.html loads ${f}`);
    assert.ok(off.includes(f), `OFFLINE_SHELL carries ${f}`);
  }
  assert.ok(html.includes('id="ista-btn"'), 'the topbar has the entry');
  const apps = fs.readFileSync(
    path.join(ROOT, 'app', 'renderer', 'screens', 'apps.js'),
    'utf8'
  );
  assert.ok(/id: 'ista'/.test(apps), 'the hub has the tile');
  ok('the shell is wired into the app');
}

console.log(`test_ista: ${passed} checks passed`);
