#!/usr/bin/env node
// A screen that is still loading must not paint into the one that replaced it.
//
// THE BUG: a show*() paints, awaits its data, then keeps writing -- appending
// nodes it captured before the await, calling setActions, setting the status
// bar. Navigate away during that await and all of it lands on whoever is on
// screen now: the parts catalogue's chassis F-keys appearing on the VIN
// decoder, one screen's tiles under another's heading.
//
//   node tools/verify/test_screen_owner.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const R = (p) => path.join(ROOT, 'app', 'renderer', p);
let passed = 0;
const ok = (m) => {
  passed++;
  if (process.env.V) console.log('  ok', m);
};

// the guard itself, lifted out of ui.js (it leans on no DOM)
const src = fs.readFileSync(R('core/core/ui.js'), 'utf8');
const gen = src.match(/let _screenGen = 0;/);
const fn = src.match(/function screenOwner\(\)[\s\S]*?\n}/);
assert.ok(gen && fn, 'ui.js defines _screenGen and screenOwner()');
let _screenGen = 0;
eval(fn[0]);
const newScreen = () => (_screenGen += 1); // what setCrumbs() does

{
  newScreen();
  const mine = screenOwner();
  assert.strictEqual(mine(), true, 'the screen owns itself while nothing else draws');
  ok('a screen owns the view it just claimed');
}
{
  newScreen();
  const first = screenOwner();
  newScreen(); // someone else drew
  assert.strictEqual(first(), false, 'the abandoned screen knows it lost the view');
  const second = screenOwner();
  assert.strictEqual(second(), true, 'the new screen owns it');
  ok('a screen replaced mid-load loses ownership');
}
{
  // the real shape: two loads race, the slower one must not paint
  newScreen();
  const slow = screenOwner();
  newScreen();
  const fast = screenOwner();
  const painted = [];
  const finish = (who, guard) => {
    if (!guard()) return;
    painted.push(who);
  };
  finish('fast', fast);
  finish('slow', slow);
  assert.deepStrictEqual(painted, ['fast'], 'only the screen that owns the view paints');
  ok('the loser of a race paints nothing');
}

// every async screen that writes after an await must take an owner
{
  const files = [
    'screens/etk/catalogue.js',
    'screens/apps.js',
    'core/nav.js',
    'screens/garage/history.js',
    'screens/logging/screen.js',
  ];
  for (const f of files) {
    const s = fs.readFileSync(R(f), 'utf8');
    assert.ok(
      s.includes('screenOwner()'),
      `${f} claims the screen before it awaits`
    );
    assert.ok(
      s.includes('if (!_mine()) return;'),
      `${f} guards a write that follows an await`
    );
  }
  ok('the screens that load asynchronously carry the guard');
}

console.log(`screen-owner: ${passed} checks passed`);
