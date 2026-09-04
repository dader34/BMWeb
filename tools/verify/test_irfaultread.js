#!/usr/bin/env node
// "Read error memory" entries that carry no job of their own.
//
// WHY THIS EXISTS. In INPA, choosing "Read error memory" DISPLAYS the fault
// list, and the submenu it points at is the toolbar over that display -- Print,
// Back, Exit. The decompiler captured the toolbar but not the implied read, so
// the entry names a memory it never reads. The app dropped it, and a kombi46
// fault screen offered only "Clear error memory" with no way to read.
//
// 614 entries across the corpus are in that shape, so this is fixed by rule,
// not per screen: if the caption says it reads a memory and nothing downstream
// actually does, run the read the caption names.

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

// Pull the real matchers out of ir.js so the test cannot drift from the app.
const memWord = src.match(/const IR_MEM_WORD =[\s\S]*?;\n/)[0];
const faultRead = src.match(
  /const IR_FAULT_READ = new RegExp\([\s\S]*?\);\n/
)[0];
const faultJob = src.match(/const IR_FAULT_JOB = \[[\s\S]*?\];\n/)[0];
const env = new Function(
  memWord + faultRead + faultJob + 'return { IR_FAULT_READ, IR_FAULT_JOB };'
)();

console.log('the caption still decides WHICH memory');
{
  const pick = (label) =>
    (env.IR_FAULT_JOB.find(([re]) => re.test(label)) || [null, 'FS_LESEN'])[1];
  ok(pick('Read error memory') === 'FS_LESEN', 'error memory -> FS_LESEN');
  ok(pick('Read IM') === 'IS_LESEN', 'info memory -> IS_LESEN');
  ok(pick('Historienspeicher lesen') === 'HS_LESEN', 'history -> HS_LESEN');
  ok(env.IR_FAULT_READ.test('Read error memory'), 'the caption matches at all');
  ok(
    !env.IR_FAULT_READ.test('Clear error memory'),
    'and CLEAR is not mistaken for a read'
  );
}

console.log('\nthe rule is wired into the dispatch');
{
  ok(
    /const subReads\s*=\s*subMenu/.test(src),
    'the submenu is checked for a real read job'
  );
  ok(
    /\(!it\.job && !faultScreen && !subReads\)/.test(src),
    'a captioned read with nothing downstream now runs'
  );
  ok(
    /IR_FAULT_READ\.test\(it\.label\)/.test(src),
    'and only when the caption actually says "read <memory>"'
  );
}

console.log('\nand it SURVIVES the empty-submenu filter');
{
  // THE BUG THIS GUARDS. The dispatch fix alone was not enough: the item was
  // dropped one step earlier by the "menu holds nothing runnable" filter,
  // because m_fehler_lesen is only Print/Back/Exit. The entry never reached
  // the dispatch at all, and the screen still showed just "Clear error
  // memory".
  const filt = src.match(
    /\.filter\(\s*\(?it\)?\s*=>\s*!it\.menu\s*\|\|\s*it\.screen[\s\S]*?\)\s*\);/
  );
  ok(filt !== null, 'the empty-submenu filter is still there');
  ok(
    filt && /IR_FAULT_READ\.test\(it\.label\)/.test(filt[0]),
    'and a captioned fault read is exempt from it'
  );
}

console.log('\nagainst the real IR corpus');
{
  const dir = path.join(ROOT, 'data/inpa-ir');
  let dead = 0,
    wouldRun = 0,
    clears = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    let d;
    try {
      d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch (e) {
      continue;
    }
    const menus = d.menus || {};
    for (const m of Object.values(menus)) {
      for (const it of m.items || []) {
        const lbl = String(it.label || '');
        if (/^(Clear|Loesch|Lösch)/i.test(lbl)) {
          clears++;
          continue;
        }
        if (!env.IR_FAULT_READ.test(lbl) || it.job) continue;
        const sub = menus[it.menu];
        const subReads =
          sub &&
          (sub.items || []).some((x) =>
            /^(FS|IS|HS)_/i.test(String(x.job || ''))
          );
        const faultScreen = it.screen && (d.screens || {})[it.screen];
        if (!faultScreen && !subReads) {
          dead++;
          wouldRun++;
        }
      }
    }
  }
  console.log(`  (${dead} captioned reads had nothing to run)`);
  // A SAMPLE-SIZE FLOOR, not a correctness bound: the rule below is only
  // meaningful if the corpus still holds a decent number of captioned reads
  // that name no job. Positional job decoding (frame argument 1, replacing
  // the old key-shaped-string scan) resolved most of them -- 548 -> 190 --
  // so the floor moved with it. If this trips again, check whether the
  // population shrank because decoding IMPROVED before raising it.
  ok(dead > 100, `${dead} dead read entries found across the corpus`);
  ok(wouldRun === dead, 'every one of them now resolves to a read job');
  ok(clears > 0, `and ${clears} Clear entries are untouched by the rule`);
}

console.log(
  failures ? `\nFAILED (${failures})` : '\nAll fault-read checks passed'
);
process.exit(failures ? 1 : 0);
