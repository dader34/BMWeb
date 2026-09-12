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
    ],
    "the main bar's labels are the real tool's"
  );
  // Measuring devices is GONE, not greyed: this build talks to a diagnostic
  // cable, and a tab for hardware it will never speak to is furniture
  assert.ok(
    !ISTA_TABS.some((t) => /measuring/i.test(t.id + t.label)),
    'no Measuring devices tab at all'
  );
  assert.deepStrictEqual(
    I.istaSubs3Of('operations', 'new').map((s) => s.label),
    ['VIN', 'Read Out Vehicle Data', 'Basic Features'],
    // Model code is GONE: it asks for the same four-character type key that
    // Basic Features offers as one criterion among twelve, and a second way
    // in is a second answer to "which car is this"
    'Operations / New has its three level-3 tabs'
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

  // the page kinds the shell draws itself: the two in details.js, the
  // workshop browser and the repair manual. A new one here must also be
  // dispatched in showIsta and probed in istaSubReady, or it draws nothing.
  const pages = ISTA_TABS.flatMap((t) =>
    (t.subs || []).flatMap((s) =>
      [s, ...(s.subs3 || [])].filter((x) => x.page).map((x) => x.page)
    )
  );
  assert.deepStrictEqual(
    [...new Set(pages)].sort(),
    [
      'active',
      'basic',
      'details',
      'diag',
      'diag-search',
      'equipment',
      'fault-memory',
      'finished',
      'history',
      'plan',
      'readout',
      'repair',
      'sae',
      'service-tree',
      'techdata',
      'tree',
      'unit-list',
      'vin',
    ],
    'only the pages the shell draws itself'
  );

  // THE TABS DO ISTA'S OWN WORK. Every one of these used to open one of the
  // app's screens inside the workshop chrome, which put a second tool's
  // layout inside this one's frame. They are pages now, and this pins that:
  // a regression here is the old screen coming back.
  for (const [tab, sub, sub3] of [
    ['management', 'troubleshooting', 'fault-memory'],
    ['management', 'troubleshooting', 'fault-pattern'],
    ['management', 'troubleshooting', 'function-structure'],
    ['management', 'troubleshooting', 'component-structure'],
    ['management', 'troubleshooting', 'sae-input'],
    ['management', 'service-functions', 'service-functions'],
  ]) {
    const leaf = I.istaSub3(tab, sub, sub3);
    assert.ok(leaf, `${tab}/${sub}/${sub3} exists`);
    assert.ok(leaf.page, `${tab}/${sub}/${sub3} is a page the shell draws`);
    assert.ok(!leaf.open, `${tab}/${sub}/${sub3} opens no app screen`);
  }
  for (const [tab, sub] of [
    ['information', 'tree'],
    ['operations', 'finished'],
    ['information', 'history'],
    ['information', 'unit-list'],
    ['service-plan', 'hit-list'],
    ['service-plan', 'test-plan'],
    ['service-plan', 'programming-plan'],
  ]) {
    const leaf = istaSub(tab, sub);
    assert.ok(leaf && leaf.page, `${tab}/${sub} is a page`);
    assert.ok(!leaf.open, `${tab}/${sub} opens no app screen`);
  }
  ok('every rebuilt tab is a page, not an app screen');

  // Operations report and Info from Service Consultation are GONE: the
  // report is reachable from Repair history, and the consultation feed is a
  // dealer system this build has no access to
  for (const gone of ['report', 'service-consultation'])
    assert.strictEqual(
      istaSub('information', gone),
      null,
      `Vehicle information has no ${gone} tab`
    );
  assert.deepStrictEqual(
    I.istaSubsOf('information').map((x) => x.label),
    [
      'Vehicle details',
      'Vehicle equipment',
      'Repair history',
      'Control unit tree',
      'Control unit list',
    ],
    'Vehicle information has its five tabs'
  );
  ok('the two dropped tabs are gone');
  ok('page kinds are the ones that exist');

  assert.strictEqual(istaTab('operations').label, 'Operations');
  assert.strictEqual(istaTab('nope'), null);
  assert.strictEqual(istaSub('service-plan', 'hit-list').page, 'plan');
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
    I.istaLeaf('operations', 'new', 'basic-features').id,
    'basic-features',
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
    view: null,
    item: null,
  });
  assert.deepStrictEqual(istaRouteParse('ista/information'), {
    tab: 'information',
    sub: null,
    sub3: null,
    car: null,
    view: null,
    item: null,
  });
  assert.deepStrictEqual(istaRouteParse('ista/information/details'), {
    tab: 'information',
    sub: 'details',
    sub3: null,
    car: null,
    view: null,
    item: null,
  });
  assert.deepStrictEqual(istaRouteParse('ista/operations/new/vin'), {
    tab: 'operations',
    sub: 'new',
    sub3: 'vin',
    car: null,
    view: null,
    item: null,
  });
  assert.deepStrictEqual(istaRouteParse('ista/operations/new/vin/abc-12'), {
    tab: 'operations',
    sub: 'new',
    sub3: 'vin',
    car: 'abc-12',
    view: null,
    item: null,
  });
  // the two slots a sub-tab with pages of its own fills, after the level-3
  // tab and the car
  assert.deepStrictEqual(
    istaRouteParse(
      'ista/management/repair/product-structure/abc-12/tree/2000006594283'
    ),
    {
      tab: 'management',
      sub: 'repair',
      sub3: 'product-structure',
      car: 'abc-12',
      view: 'tree',
      item: '2000006594283',
    }
  );
  // a route that skips the level-3 tab and the car still reaches them: '-'
  // holds the empty slots open so the ones after it keep their positions
  assert.deepStrictEqual(
    istaRouteParse('ista/management/repair/-/-/tree/doc9'),
    {
      tab: 'management',
      sub: 'repair',
      sub3: null,
      car: null,
      view: 'tree',
      item: 'doc9',
    }
  );
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
    view: null,
    item: null,
  });
  assert.deepStrictEqual(istaRouteParse('ista/operations/new/abc-12'), {
    tab: 'operations',
    sub: 'new',
    sub3: null,
    car: 'abc-12',
    view: null,
    item: null,
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
    [null, null, null, null, null, null],
    ['information', null, null, null, null, null],
    ['information', 'details', null, null, null, null],
    ['information', 'details', null, 'abc-12', null, null],
    ['operations', 'new', 'vin', null, null, null],
    ['operations', 'new', 'vin', 'abc-12', null, null],
    ['management', 'troubleshooting', 'fault-memory', 'x_9-Z', null, null],
    // the last two slots belong to a sub-tab with pages of its own
    ['management', 'repair', 'product-structure', 'abc-12', 'tree', null],
    ['management', 'repair', 'text-search', 'abc-12', 'hits', '2000006594283'],
  ];
  for (const [tab, sub, sub3, car, view, item] of cases) {
    const route = istaRouteBuild(tab, sub, sub3, car, view, item);
    const back = istaRouteParse(route);
    assert.ok(back, `${route} parses`);
    assert.strictEqual(back.tab, tab || 'operations', `${route} tab`);
    assert.strictEqual(back.sub, sub, `${route} sub`);
    assert.strictEqual(back.sub3, sub3, `${route} sub3`);
    assert.strictEqual(back.car, car, `${route} car`);
    assert.strictEqual(back.view, view, `${route} view`);
    assert.strictEqual(back.item, item, `${route} item`);
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

// ---- Basic Features: opening a vehicle without a VIN ------------------------
{
  const {
    istaBasicModel,
    istaBasicRoots,
    istaBasicHits,
    istaBasicValues,
    istaBasicChassis,
    istaBasicRow,
  } = I;

  // A stand-in for the workshop extract's three files, in their real shapes:
  // roots.json names the features, typekeys.json gives each type key one
  // value id per feature, characteristics.json prints a value id.
  //
  // Four type keys over three E46s and one E39, plus two features nothing
  // carries: 'Model month', which roots.json names and no type key answers,
  // and 'Doors', which one type key answers.
  const roots = {
    63685259: 'Model series',
    53088651: 'Development code',
    53046411: 'Body',
    53363595: 'Engine',
    53508235: 'Steering',
    63814539: 'Doors',
    '-101': 'Model month',
  };
  const chars = {
    11: "3'",
    12: "5'",
    21: 'E46',
    22: 'E39',
    31: 'COU',
    32: 'LIM',
    41: 'M54',
    42: 'M43',
    51: 'LL',
    52: 'RL',
    61: '4',
  };
  const typekeys = {
    AL01: {
      63685259: [11],
      53088651: [21],
      53046411: [31],
      53363595: [41],
      53508235: [51],
    },
    AL02: {
      63685259: [11],
      53088651: [21],
      53046411: [32],
      53363595: [42],
      53508235: [51],
      63814539: [61],
    },
    AL03: {
      63685259: [11],
      53088651: [21],
      53046411: [32],
      53363595: [41],
      53508235: [52],
    },
    DD62: {
      63685259: [12],
      53088651: [22],
      53046411: [32],
      53363595: [41],
      53508235: [51],
    },
  };
  const model = istaBasicModel(roots, typekeys, chars);
  assert.ok(model, 'the three files fold into one model');
  assert.strictEqual(model.keys.length, 4, 'one row per type key');
  ok('the characteristic tree folds');

  // A FEATURE NO TYPE KEY CARRIES IS NOT LISTED AT ALL. Drawing it would ask
  // a question this data can never answer.
  const listed = istaBasicRoots(model).map((r) => r.label);
  assert.ok(!listed.includes('Model month'), 'a feature with no values is out');
  assert.ok(listed.includes('Doors'), 'one carried value is enough to list it');
  // the frame's own rows keep the frame's order; the extras follow
  assert.deepStrictEqual(listed, [
    'Model series',
    'Development code',
    'Body',
    'Engine',
    'Steering',
    'Doors',
  ]);
  ok('the features listed are the ones the data can answer');

  // no choices yet: every value of every feature is on offer, deduped
  assert.deepStrictEqual(istaBasicValues(model, {}, '63685259'), ["3'", "5'"]);
  assert.deepStrictEqual(istaBasicValues(model, {}, '53046411'), [
    'COU',
    'LIM',
  ]);
  assert.strictEqual(istaBasicHits(model, {}).length, 4, 'Hits starts at all');

  // INTERSECT NARROWING: a value is offered when at least one type key
  // carries it AND carries every value already picked. Picking the 5' leaves
  // only the E39, so LL is the only steering still possible.
  assert.deepStrictEqual(
    istaBasicValues(model, { 63685259: "5'" }, '53088651'),
    ['E39']
  );
  assert.deepStrictEqual(
    istaBasicValues(model, { 63685259: "5'" }, '53508235'),
    ['LL']
  );
  assert.strictEqual(istaBasicHits(model, { 63685259: "3'" }).length, 3);
  // two features together narrow further than either alone
  assert.deepStrictEqual(
    istaBasicValues(model, { 63685259: "3'", 53046411: 'LIM' }, '53363595'),
    ['M43', 'M54']
  );
  ok('the panes intersect over the type keys');

  // A PICKED FEATURE KEEPS ITS OWN ALTERNATIVES: only the OTHER choices
  // narrow it, or changing your mind would mean clearing the whole form.
  assert.deepStrictEqual(
    istaBasicValues(model, { 63685259: "5'" }, '63685259'),
    ["3'", "5'"],
    'the picked feature still offers every value'
  );
  ok('a pane never narrows itself');

  // one type key is the bar for Open operation, and it resolves to a chassis
  const hits = istaBasicHits(model, {
    63685259: "3'",
    53046411: 'LIM',
    53363595: 'M54',
  });
  assert.strictEqual(hits.length, 1, 'three features identify one type key');
  assert.strictEqual(istaBasicChassis(hits[0]), 'E46');
  const row = istaBasicRow(model, hits[0]);
  assert.strictEqual(row.typeKey, 'AL03');
  assert.strictEqual(row.chassis, 'E46');
  assert.strictEqual(row.motor, 'M54');
  ok('one type key opens as a chassis');

  // a combination nobody built is 0 hits rather than an invented car
  assert.strictEqual(
    istaBasicHits(model, { 63685259: "5'", 53363595: 'M43' }).length,
    0,
    'an impossible combination matches nothing'
  );
  ok('an impossible combination yields no hits');

  // a build without the files degrades to null, which the page says out loud
  assert.strictEqual(istaBasicModel(null, typekeys, chars), null);
  assert.strictEqual(istaBasicModel(roots, null, chars), null);
  assert.deepStrictEqual(istaBasicRoots(null), []);
  assert.deepStrictEqual(istaBasicHits(null, {}), []);
  ok('a missing extract is null, not an empty picker');
}

// ---- one row per control unit SLOT, not per candidate SGBD -----------------
// THE BUG THIS PINS. The chassis config lists every SGBD a chassis could
// carry: an E46 lists eight engine variants because the model ran with any
// of them. Drawing that list gave one car eight engines, and because the
// fault state was matched by diagnostic address -- which all eight share --
// the single installed engine's faults lit up its siblings too.
{
  const { istaSlots, istaSlotFor } = I;
  const config = {
    sections: [
      {
        name: 'Engine',
        ecus: [
          { code: 'MS420', sgbd: 'ms420ds0', group: 'D_0012', label: 'MS42' },
          { code: 'MS430', sgbd: 'ms430ds0', group: 'D_0012', label: 'MS43' },
          { code: 'MS450', sgbd: 'ms450ds0', group: 'D_0012', label: 'MS45.1' },
        ],
      },
      {
        name: 'Body',
        ecus: [
          { code: 'LSZ', sgbd: 'lsz', group: 'D_00E8', label: 'Light switch' },
          { code: 'IHKA', sgbd: 'ihka46', group: 'D_005B', label: 'Climate' },
        ],
      },
    ],
  };

  // three engine candidates are ONE slot
  const cold = istaSlots(config, null, null);
  assert.strictEqual(cold.length, 3, 'three slots, not five rows');
  const eng = cold.find((x) => x.id === 'D_0012');
  assert.strictEqual(eng.candidates.length, 3, 'the slot holds its candidates');
  assert.strictEqual(eng.state, 'unread', 'nothing read it yet');
  // it must NOT borrow one candidate's name on a car nobody has read
  assert.ok(
    !/MS4[0-9]/.test(eng.name),
    `an unidentified slot does not claim a variant (got ${eng.name})`
  );
  assert.strictEqual(eng.name, 'Engine', 'it reads as its family');
  ok('candidates for one slot collapse to one row');

  // a scan that found ONE engine names the slot and lights only it
  const faults = {
    kind: 'faults',
    modules: [
      { sgbd: 'ms450ds0', via: 'ms450ds0', label: 'MS45.1', codes: [{}, {}] },
    ],
    silent: [{ target: 'ihka46', label: 'Climate' }],
  };
  const warm = istaSlots(config, faults, null);
  const e2 = warm.find((x) => x.id === 'D_0012');
  assert.strictEqual(e2.abbr, 'MS450', 'the slot takes the identified name');
  assert.strictEqual(e2.name, 'MS45.1');
  assert.strictEqual(e2.sgbd, 'ms450ds0');
  assert.strictEqual(e2.state, 'faults');
  assert.strictEqual(e2.faults, 2);
  // THE WHOLE POINT: no sibling inherits it
  assert.deepStrictEqual(
    warm.filter((x) => x.state === 'faults').map((x) => x.abbr),
    ['MS450'],
    'only the installed engine is amber'
  );
  assert.strictEqual(
    warm.find((x) => x.id === 'D_005B').state,
    'silent',
    'a module that did not answer is red'
  );
  assert.strictEqual(
    warm.find((x) => x.id === 'D_00E8').state,
    'unread',
    'a module nobody asked is grey, not green'
  );
  ok('the read names the slot, and lights only it');

  // an identification names the slot even with no fault scan
  const idOnly = istaSlots(config, null, {
    kind: 'ident',
    modules: [
      { sgbd: 'ms430ds0', via: 'ms430ds0', ident: { SG_VARIANTE: 'X' } },
    ],
  });
  const e3 = idOnly.find((x) => x.id === 'D_0012');
  assert.strictEqual(e3.abbr, 'MS430', 'the identification names it');
  assert.ok(e3.ident, 'and its identification is carried');
  assert.strictEqual(e3.state, 'unread', 'but its fault memory is unread');
  ok('an identification alone names the slot');

  // every candidate maps back to its slot, so the fault table and the tree
  // can ask "which control unit is this module" and get one answer
  assert.strictEqual(istaSlotFor(warm, 'ms420ds0').id, 'D_0012');
  assert.strictEqual(istaSlotFor(warm, 'ms450ds0').id, 'D_0012');
  assert.strictEqual(istaSlotFor(warm, 'nope'), null);
  ok('any candidate resolves to its slot');

  // THE BUS MAP DECIDES WHAT IS ONE UNIT. An E46's DME answers on two group
  // files (one per generation of the resolver), so keying on the group alone
  // drew the engine TWICE: the identified variant, and a second grey row for
  // the siblings filed under the other group. The map's box lists both
  // groups, which is the fact that they are one control unit.
  const split = {
    sections: [
      {
        name: 'Engine',
        ecus: [
          { code: 'MS450', sgbd: 'ms450ds0', group: 'D_0012', label: 'MS45.1' },
          { code: 'ME9', sgbd: 'me9n45', group: 'D_MOTOR', label: 'ME9.2' },
        ],
      },
      {
        name: 'Transmission',
        ecus: [
          { code: 'GS20', sgbd: 'ags732', group: 'D_0032', label: 'GS20' },
        ],
      },
    ],
  };
  const tree = {
    ecus: [
      { name: 'DME', addr: 18, groups: ['d_motor', 'd_0012'], bus: 'FACAN' },
      { name: 'EGS', addr: 50, groups: ['d_0032'], bus: 'FACAN' },
    ],
  };

  // read nothing: two slots, not three, and each named by the map
  const cold2 = istaSlots(split, null, null, tree);
  assert.strictEqual(cold2.length, 2, 'the two engine groups are one slot');
  assert.strictEqual(
    cold2[0].abbr,
    'DME',
    "the map's abbreviation, not D_0012"
  );
  assert.strictEqual(cold2[1].abbr, 'EGS');
  ok('the bus map merges the groups it files under one box');

  // once a variant is identified the slot takes its name, and there is no
  // leftover group row beside it
  const warm2 = istaSlots(
    split,
    {
      kind: 'faults',
      modules: [{ sgbd: 'ms450ds0', codes: [{}] }],
      silent: [],
    },
    null,
    tree
  );
  assert.strictEqual(warm2.length, 2, 'still two slots');
  const dme = warm2.find((x) => x.box && x.box.name === 'DME');
  assert.strictEqual(dme.abbr, 'MS450', 'the slot takes the identified name');
  assert.strictEqual(dme.state, 'faults');
  assert.strictEqual(
    warm2.filter((x) => /^D_/.test(x.abbr)).length,
    0,
    'no group-file placeholder survives beside an identified unit'
  );
  ok('an identified slot leaves no group row behind');

  // with no map at all the groups stand alone, which is the old behaviour
  // and still the honest one: nothing has said they are the same unit
  assert.strictEqual(
    istaSlots(split, null, null, null).length,
    3,
    'without a map, a group is a slot'
  );
  ok('no map means no merging');
}

// ---- the bus map under the skin: hover panel, and a click that only picks --
{
  const { istaEcuTip } = I;
  const box = { name: 'LM', addr: 0x70, bus: 'KCAN', col: 6, row: 6 };
  const slot = {
    abbr: 'LM',
    name: 'Light module',
    ident: {
      SG_VARIANTE: 'LM_AHL_2',
      BMW_NUMMER: '9154943',
      HARDWARE_NUMMER: '99',
      SERIENNUMMER: '000058790',
    },
  };
  const html = istaEcuTip(box, slot);

  // ONE ROW PER LINE, nine of them, in the tool's order. Laid out as a grid
  // the rows flowed side by side into a wide strip and ran the fields
  // together ("Group type EML (0x22)EML"), which reads as one sentence
  // rather than nine facts.
  const rows = [...html.matchAll(/irtip-k">([^<]*)</g)].map((m) => m[1]);
  assert.deepStrictEqual(rows, [
    'Address',
    'Group type',
    'Name',
    'Variant',
    'Part number',
    'Hardware number',
    'Serial number',
    'Data bus',
    'Tree coordinates',
  ]);
  const vals = [...html.matchAll(/irtip-v">([^<]*)</g)].map((m) => m[1]);
  // the address is HEX, as it appears on a wiring diagram and in a trace
  assert.strictEqual(vals[0], '0x70', 'the address is hex');
  // Group type and Name are two facts and never one string
  assert.strictEqual(vals[1], 'LM');
  assert.strictEqual(vals[2], 'Light module');
  assert.ok(!/LM.*Light module/.test(vals[1]), 'they are not concatenated');
  assert.strictEqual(vals[3], 'LM_AHL_2', 'the variant comes off the ident');
  assert.strictEqual(vals[4], '9154943');
  assert.strictEqual(vals[7], 'KCAN');
  assert.strictEqual(vals[8], '6 / 6');
  // a control unit nobody has read still names itself and says "-" for the
  // rest, rather than hiding the rows it cannot fill
  const cold = istaEcuTip(box, null);
  assert.strictEqual(
    [...cold.matchAll(/irtip-k">/g)].length,
    9,
    'all nine rows draw even unread'
  );
  assert.ok(/irtip-v">-</.test(cold), 'unknown values read as -');
  ok("the hover panel is the tool's nine rows, one per line");

  // A CLICK ONLY SELECTS. The tree app opens its own module sheet on click,
  // which is its way in on its own page; under this skin the window is a
  // separate, deliberate press of Call up ECU functions, so the sheet would
  // be a second answer to the same click.
  const tree = fs.readFileSync(
    path.join(ROOT, 'app', 'renderer', 'screens', 'tree', 'screen.js'),
    'utf8'
  );
  const guard = tree.slice(
    tree.indexOf('const open = () => {'),
    tree.indexOf('ecuTreeModuleSheet(car, box.ecu, st, hit);')
  );
  assert.ok(
    /istaSkinOn\(\)/.test(guard) && /return/.test(guard),
    'the tree sheet returns early while the workshop skin is up'
  );
  ok('a click on the map selects, and opens nothing');
}

// ---- Repair/maintenance resolves to the repair screen ----------------------
// THE SEAM BROKE ONCE ALREADY: the shell called an istaRepairShow that the
// The ECU functions window lists what the tool lists: per variant, ISTA's
// function groups and their English-titled leaves, each one EDIABAS job
// with its arguments and the results to show. The KOMBI showed "nothing of
// this kind" because the window read the INPA script's menus and the slot
// had no script loaded; the tool never reads the script at all.
{
  const fn = {
    variant: 'kombi46',
    reads: [
      {
        title: 'Supply, instrument cluster',
        items: [
          {
            title: 'Terminal 15',
            job: 'STATUS_IO_LESEN',
            args: '',
            results: [{ name: 'STAT_KL15_EIN', title: 'Terminal 15' }],
          },
        ],
      },
      { title: 'Empty group', items: [] },
    ],
    acts: [
      {
        title: 'General functions',
        items: [
          {
            title: 'Fuel gauge',
            job: 'STEUERN_ANZEIGE',
            args: 'TANKINHALT;25',
            ms: 5000,
          },
        ],
      },
    ],
  };
  const lists = I.istaEcuFnLists(fn);
  assert.strictEqual(lists.read.length, 1, 'an empty group is not listed');
  assert.strictEqual(lists.read[0].items[0].job, 'STATUS_IO_LESEN');
  assert.strictEqual(lists.write[0].items[0].args, 'TANKINHALT;25');
  assert.deepStrictEqual(I.istaEcuFnLists(null), { read: [], write: [] });
  ok('the window takes its groups from the tool data');
  const rows = I.istaEcuFnRows(lists.read[0].items[0], [
    { STAT_KL15_EIN: 1, JOB_STATUS: 'OKAY' },
  ]);
  assert.deepStrictEqual(rows, [['Terminal 15', '1']]);
  const unit = I.istaEcuFnRows(
    {
      title: 'x',
      results: [
        { name: 'STAT_TANKINHALT_WERT', title: 'Fuel level', unit: 'l' },
      ],
    },
    [{ STAT_TANKINHALT_WERT: 42.5 }]
  );
  assert.deepStrictEqual(unit, [['Fuel level', '42.5 l']]);
  const missing = I.istaEcuFnRows(lists.read[0].items[0], [{ OTHER: 1 }]);
  assert.deepStrictEqual(missing, [['Terminal 15', '-']]);
  const undeclared = I.istaEcuFnRows({ title: 'y', results: [] }, [
    { _TEL_ANTWORT: [1], STAT_A: 'on', JOB_STATUS: 'OKAY' },
  ]);
  assert.deepStrictEqual(undeclared, [
    ['STAT_A', 'on'],
    ['Job status', 'OKAY'],
  ]);
  ok('a run maps each declared result by name, with its unit');
}

// Show fault code stayed disabled with a fault picked: the bar treated the
// model's `off` (how a button looks before the page binds it) as permanent.
// A button with a handler is on. And the fault table names faults through
// the lazily loaded English texts, so the page must wait for them as the
// report views do, or it draws the raw German.
{
  const screen = fs.readFileSync(
    path.join(ROOT, 'app', 'renderer', 'screens', 'ista', 'screen.js'),
    'utf8'
  );
  const bar = screen.slice(
    screen.indexOf('function istaBottomBar('),
    screen.indexOf('function istaRealChromeBars(')
  );
  assert.ok(/off: !fn,/.test(bar), 'a button with a handler is on');
  assert.ok(
    !/!!b\.off \|\| !fn/.test(bar),
    "the model's off flag no longer pins a bound button shut"
  );
  const faults = screen.slice(
    screen.indexOf("if (s.page === 'fault-memory') {"),
    screen.indexOf('const draw = () => {')
  );
  assert.ok(
    /await loadFaultDb\(\)/.test(faults),
    'the fault table waits for the English fault texts'
  );
  ok('the fault memory buttons bind, and the names load in English');
}

// repair branch never defined, so Product Structure showed a grey "not in
// this build" over a browser that had shipped. Pin the real name.
{
  const screen = fs.readFileSync(
    path.join(ROOT, 'app', 'renderer', 'screens', 'ista', 'screen.js'),
    'utf8'
  );
  const branch = screen.slice(
    screen.indexOf("if (s.page === 'repair') {"),
    screen.indexOf("if (s.page === 'details') {")
  );
  assert.ok(branch, 'the repair page has a branch');
  assert.ok(
    /showRepair\(host, car, chassis, s\.id\)/.test(branch),
    'it calls showRepair with the host and the level-3 tab as the view'
  );
  assert.ok(
    !/istaRepairShow/.test(screen),
    'no call to a repair entry point that does not exist'
  );
  // the repair screen's two views are keyed by the level-3 tab ids, so
  // nothing has to be translated across the seam
  const repair = fs.readFileSync(
    path.join(ROOT, 'app', 'renderer', 'screens', 'repair', 'screen.js'),
    'utf8'
  );
  assert.ok(
    /id: 'product-structure'/.test(repair) && /id: 'text-search'/.test(repair),
    "the repair views use the shell's own tab ids"
  );
  for (const [tab, sub, sub3] of [
    ['management', 'repair', 'product-structure'],
    ['management', 'repair', 'text-search'],
  ]) {
    const leaf = I.istaSub3(tab, sub, sub3);
    assert.ok(leaf && leaf.page === 'repair', `${sub3} routes to the manual`);
  }
  ok('the repair seam resolves to the browser that shipped');
}

// ---- the fault detail dialog reads what the module actually returned ------
{
  const { istaEnvFind, istaFaultRows } = I;

  // env rows are label/value text straight off the module and their names
  // vary by SGBD, so a column is found by what its label SAYS
  const pairs = [
    ['km-Stand', '108032'],
    ['Fault-onset time', '14779076 Sek.'],
    ['Batteriespannung', '12.4 V'],
    ['Aussentemperatur', '18 C'],
    ['Drehzahl', '820 1/min'],
    ['Something the build has no label for', '7'],
  ];
  assert.strictEqual(istaEnvFind(pairs, /km|laufleistung/i), '108032');
  assert.strictEqual(istaEnvFind(pairs, /zeit|time/i), '14779076 Sek.');
  assert.strictEqual(istaEnvFind(pairs, /spannung|voltage/i), '12.4 V');
  assert.strictEqual(istaEnvFind(pairs, /drehzahl|rpm/i), '820 1/min');
  assert.strictEqual(istaEnvFind(pairs, /nothing matches this/i), '');
  assert.strictEqual(istaEnvFind(null, /x/), '', 'no rows, no value');
  ok('an ambient column is found by what its label says');

  // A FAULT THE SCAN READ carries its module, so the dialog has something to
  // report; one looked up from the SAE box does not, and must say "not read
  // on this car" rather than "-", which would claim the module answered.
  //
  // faultFields and envPairs are the app's own projections of the raw wire
  // row (screens/faults.js), which this test does not load; the stubs are
  // the shape they return, so what is under test is istaFaultRows' use of
  // them rather than a second copy of their logic.
  global.faultFields = (c) => ({
    code: String(c.F_ORT_TEXT || '').split(' ')[0],
    name: c.F_ORT_TEXT || '',
    present: /momentan vorhanden/.test(c.F_VORHANDEN_TEXT || ''),
    count: c.F_HFK || '',
  });
  global.envPairs = (c) => {
    const out = [];
    for (let i = 1; i <= 8; i++) {
      const t = c[`F_UW${i}_TEXT`];
      if (t == null) continue;
      out.push([t, `${c[`F_UW${i}_WERT`]} ${c[`F_UW${i}_EINH`] || ''}`.trim()]);
    }
    return out;
  };
  const read = istaFaultRows({
    modules: [
      {
        sgbd: 'ms450ds0',
        label: 'MS45.1',
        codes: [
          {
            F_ORT_TEXT: '2761 Secondary air',
            F_VORHANDEN_TEXT: 'Fehler momentan vorhanden',
            F_UW1_TEXT: 'km-Stand',
            F_UW1_WERT: 108032,
            F_UW1_EINH: 'km',
            F_UW2_TEXT: 'Batteriespannung',
            F_UW2_WERT: 12.4,
            F_UW2_EINH: 'V',
          },
        ],
      },
    ],
  });
  assert.strictEqual(read.length, 1);
  assert.strictEqual(read[0].sgbd, 'ms450ds0', 'a read fault knows its module');
  assert.strictEqual(read[0].km, '108032', 'and its mileage, off the env rows');
  assert.strictEqual(read[0].present, true, 'and whether it is there now');
  ok('a read fault carries what the dialog needs');
  delete global.faultFields;
  delete global.envPairs;
}

// ---- a fault's name reaches its procedure ---------------------------------
// THE HIT LIST SAID "no procedure is linked to this fault in this build" for
// every fault on a car whose procedures were right there. faultName returns
// "CODE Name" because a technician reads the code first, and the procedure
// set is keyed by the component alone -- so every fault slugged to
// "2761-secondary-air-system" and matched nothing.
{
  const data = fs.readFileSync(
    path.join(ROOT, 'app', 'renderer', 'screens', 'lookup', 'data.js'),
    'utf8'
  );
  const m = /const LOOKUP_CODE_PREFIX_RE = (\/.*\/[a-z]*);/.exec(data);
  assert.ok(m, 'the code prefix is stripped before the name is slugged');
  const re = eval(m[1]);
  const strip = (t) => t.replace(re, '').trim();

  assert.strictEqual(
    strip('2761 Secondary air system'),
    'Secondary air system'
  );
  assert.strictEqual(strip('27C3 Oil level sensor'), 'Oil level sensor');
  assert.strictEqual(strip('BE Instrument cluster'), 'Instrument cluster');
  assert.strictEqual(strip('P0171 Mixture too lean'), 'Mixture too lean');
  // A COMPONENT NAME THAT STARTS WITH A NUMBER keeps it: there is no
  // space-separated hex token in front of it, and eating the digit would
  // turn a real name into a different one.
  assert.strictEqual(strip('4 wheel drive'), '4 wheel drive');
  assert.strictEqual(strip('3 series'), '3 series');
  // nor does it eat a name with no code at all
  assert.strictEqual(strip('Secondary air system'), 'Secondary air system');
  ok('the fault code comes off before the name is matched');
}

// ---- the control unit window's tabs are words, not hyphenated fragments ----
{
  const win = fs.readFileSync(
    path.join(ROOT, 'app', 'renderer', 'screens', 'ista', 'ecuwin.js'),
    'utf8'
  );
  // the frames hyphenate these only because the real tool's tab is too
  // narrow for them, which is its layout losing an argument with its own
  // text rather than a name with a hyphen in it
  for (const label of [
    'Identification',
    'Diagnosis scan',
    'Component triggering',
    'Software information',
  ])
    assert.ok(win.includes(`'${label}'`), `the ${label} tab reads as words`);
  assert.ok(
    !/Component trig-|Software infor-/.test(win),
    'no hyphenated fragment survives'
  );
  ok("the window's tab labels are whole words");
}

console.log(`test_ista: ${passed} checks passed`);
