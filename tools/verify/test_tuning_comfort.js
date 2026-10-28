#!/usr/bin/env node
// Tuning > Comfort: the hand-made list resolves against a definition by
// symbol name, and the generated "Always live" group (the single values the
// live-tune build keeps in RAM of their own) is appended to it -- every
// entry a constant the definition carries, no symbol twice, a plain name on
// each -- and left out when the generated file is absent.
//
// Run: node tools/verify/test_tuning_comfort.js
const assert = require('assert');
const path = require('path');

const live = require(
  path.join(
    __dirname,
    '..',
    '..',
    'app',
    'renderer',
    'core',
    'generated',
    'comfort-live.js'
  )
).TN_COMFORT_LIVE;
global.TN_COMFORT_LIVE = live;
const { TN_COMFORT_MS45, TN_COMFORT_MIN, tnComfortFor } = require(
  path.join(
    __dirname,
    '..',
    '..',
    'app',
    'renderer',
    'screens',
    'tuning',
    'comfort.js'
  )
);

let passed = 0;
const ok = (m) => {
  passed++;
  console.log(`  ok    ${m}`);
};

// a definition that carries everything both lists name, plus noise
const titles = new Set();
for (const g of TN_COMFORT_MS45)
  for (const s of g.subjects) for (const [t] of s.items) titles.add(t);
const liveTitles = live.subjects.flatMap((s) => s.items.map(([t]) => t));
for (const t of liveTitles) titles.add(t);
const def = {
  items: [...titles].map((title, i) => ({ title, key: i })),
};
def.items.push({ title: 'c_something_else', key: 99999 });

{
  assert(
    live.count === liveTitles.length && live.count > 400,
    'the group is populated'
  );
  assert.strictEqual(
    new Set(liveTitles).size,
    liveTitles.length,
    'no symbol twice'
  );
  for (const s of live.subjects) {
    assert(s.name && s.items.length, `subject ${s.name}`);
    for (const [t, label] of s.items)
      assert(t && label && label.length <= 90, t);
  }
  ok(
    `the generated group names ${live.count} always-live values in ${live.subjects.length} subjects`
  );
}

{
  const groups = tnComfortFor(def);
  assert(groups && groups.length >= 2);
  const last = groups[groups.length - 1];
  assert.strictEqual(last.name, live.name);
  const rows = last.subjects.flatMap((s) => s.rows);
  assert.strictEqual(rows.length, live.count, 'every entry resolved');
  assert(rows.every((r) => r.item && r.label));
  assert.strictEqual(tnComfortFor(def), groups, 'remembered on the definition');
  ok(
    'the always-live group comes last in the comfort list, every entry resolved to its item'
  );
}

{
  const few = { items: def.items.slice(0, TN_COMFORT_MIN - 1) };
  assert.strictEqual(tnComfortFor(few), null);
  delete global.TN_COMFORT_LIVE;
  const plain = tnComfortFor({ items: def.items.slice() });
  assert(plain && plain[plain.length - 1].name !== live.name);
  ok(
    'a thin definition gets no list; without the generated file the group is simply absent'
  );
}

console.log(`\n${passed} passed`);
