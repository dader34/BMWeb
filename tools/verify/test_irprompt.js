#!/usr/bin/env node
// The prompted-activation flow: INPA asks for a value, the job's argument ends
// in ';', and the answer is appended.
//
// WHY THIS EXISTS. These screens used to refuse outright ("listed but not
// sent") because we did not know where the answer went in the argument. The
// IR carries both halves all along:
//
//   jobArg "TACHO;" + user "45" -> STEUERN_ANZEIGE "TACHO;45"
//
// The trailing ';' IS the value slot -- 170 entries across the corpus use it.
// This test runs the real parser over the REAL IR, so a fix that only worked
// for the speedometer would fail here.

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
let failures = 0;
const ok = (c, m) => {
  if (c) console.log('  ok   ' + m);
  else {
    failures++;
    console.log('  FAIL ' + m);
  }
};

const src = fs.readFileSync(
  path.join(ROOT, 'app/renderer/screens/ir.js'),
  'utf8'
);
const m = src.match(/function irPromptRange\(prompt\)[\s\S]*?\n\}/);
if (!m) {
  console.error('irPromptRange not found');
  process.exit(1);
}
const irPromptRange = new Function(m[0] + '; return irPromptRange;')();

console.log('every range dialect BMW actually wrote');
{
  const cases = [
    [['speedometer', '10-90 [degrees]'], 10, 90, 'degrees'],
    [['Recirculation', 'valve position (0-100 %)'], 0, 100, '%'],
    [['key 0 configuration', 'DSC-Mode eingeben (0..3)'], 0, 3, ''],
    [['Suchbeleuchtung', 'Angabe in Zahl von 0 bis 255 '], 0, 255, ''],
    [['Lenkwinkel', 'Lenkwinkel [-3...+3°]'], -3, 3, '-3...+3°'],
  ];
  for (const [prompt, lo, hi] of cases) {
    const r = irPromptRange(prompt);
    ok(
      r.lo === lo && r.hi === hi,
      `${JSON.stringify(prompt[1])} -> ${r.lo}..${r.hi}`
    );
  }
}

console.log('\nfree-form prompts are asked, not refused');
{
  const r = irPromptRange(['Kalibrierung', 'Bitte ´ON´ oder ´OFF´ eingeben']);
  ok(r.lo === null, 'no range parsed');
  ok(
    /ON/.test(r.ask),
    'but the question is still carried to the user: ' + r.ask
  );
}

console.log('\nthe real IR corpus');
{
  const dir = path.join(ROOT, 'data/inpa-ir');
  let prompted = 0,
    withSlot = 0,
    ranged = 0,
    asked = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    let d;
    try {
      d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch (e) {
      continue;
    }
    (function walk(o) {
      if (o && typeof o === 'object') {
        if (!Array.isArray(o) && o.prompt && o.job) {
          prompted++;
          if (String(o.jobArg || '').endsWith(';')) {
            withSlot++;
            const r = irPromptRange(o.prompt);
            if (r.lo !== null) ranged++;
            if (r.ask) asked++;
          }
        }
        for (const v of Array.isArray(o) ? o : Object.values(o)) walk(v);
      }
    })(d);
  }
  console.log(
    `  (${prompted} prompted jobs, ${withSlot} with a ';' value slot)`
  );
  ok(withSlot > 100, `${withSlot} entries gain a working prompt (was 0)`);
  ok(ranged > 100, `${ranged} of them get a validated numeric range`);
  ok(
    asked === withSlot,
    "and every one carries INPA's own question to the user"
  );
}

console.log('\nthe flow is wired, and still refuses what it cannot place');
{
  ok(
    /it\.prompt && String\(it\.jobArg \|\| ''\)\.endsWith\(';'\)/.test(src),
    'a trailing ";" is what enables the prompt'
  );
  ok(
    /it = \{ \.\.\.it, jobArg: it\.jobArg \+ val \}/.test(src),
    'the answer is appended to the argument'
  );
  ok(
    /no value slot we can identify/.test(src),
    'a prompt with no ";" slot is still listed-not-sent rather than guessed'
  );
  ok(
    /outside the range INPA accepts here/.test(src),
    'and an out-of-range value is refused before it reaches the ECU'
  );
}

console.log(
  failures
    ? `\nFAILED (${failures})`
    : '\nAll prompted-activation checks passed'
);
process.exit(failures ? 1 : 0);
