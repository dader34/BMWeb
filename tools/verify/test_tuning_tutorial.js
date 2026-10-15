#!/usr/bin/env node
// The Flashing/Tuning & Logging tutorial: every step names a control that
// the screens really draw (a renamed control would make the tour skip the
// step silently), the MS45 branch is a superset of the plain walk, and the
// walk goes through logging for everyone.
//
// Run: node tools/verify/test_tuning_tutorial.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const renderer = path.join(__dirname, '..', '..', 'app', 'renderer');
const { tnTutorialSteps } = require(
  path.join(renderer, 'screens', 'tuning', 'tutorial.js')
);

let passed = 0;
const ok = (m) => {
  passed++;
  console.log(`  ok    ${m}`);
};

// every id and class the screens produce, from their source
const sources = [];
for (const dir of ['screens/tuning', 'screens/flashing', 'screens/logging']) {
  for (const f of fs.readdirSync(path.join(renderer, dir)))
    if (f.endsWith('.js'))
      sources.push(fs.readFileSync(path.join(renderer, dir, f), 'utf8'));
}
const all = sources.join('\n');
const drawn = (token) => {
  const name = token.slice(1);
  return token[0] === '#'
    ? new RegExp(`id=["']${name}["']|getElementById\\('${name}'\\)`).test(all)
    : new RegExp(
        `(class=["'][^"']*\\b|className = '[^']*\\b|classList\\.add\\('|\\.)${name}\\b`
      ).test(all);
};

const plain = tnTutorialSteps(false);
const ms45 = tnTutorialSteps(true);
{
  for (const step of ms45) {
    assert(step.screen && step.sel && step.title && step.body, step.title);
    for (const sel of step.sel.split(',')) {
      const token = sel.trim().split(/[\s>:[]/)[0];
      assert(drawn(token), `${step.title}: nothing draws ${token}`);
    }
  }
  ok(`every target of the ${ms45.length} steps is a control the screens draw`);
}
{
  const titles = (steps) => steps.map((s) => s.title);
  for (const t of titles(plain)) assert(titles(ms45).includes(t), t);
  assert(ms45.length > plain.length + 5, 'the MS45 branch adds its own steps');
  assert(
    ms45.some((s) => /LIVE ON/.test(s.title)) &&
      !plain.some((s) => /LIVE ON/.test(s.title))
  );
  ok('the MS45 walk is the plain walk plus custom options and live tuning');
}
{
  for (const steps of [plain, ms45]) {
    const logging = steps.filter((s) => s.screen === 'logging');
    assert(logging.length >= 5, 'logging is covered');
    assert(
      steps.some((s) => s.screen === 'history'),
      'and the replay'
    );
    assert.strictEqual(steps[0].screen, 'flashing', 'starts on flashing');
    assert(
      steps.some((s) => s.screen === 'tuning'),
      'covers the editor'
    );
    assert.strictEqual(
      steps[steps.length - 1].screen,
      'flashing',
      'ends on flashing'
    );
  }
  ok(
    'both walks start on flashing, cover the editor, go through logging and the replay'
  );
}
console.log(`\n${passed} passed`);
