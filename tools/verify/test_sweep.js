#!/usr/bin/env node
// Whole-vehicle sweep (INPA "Functional Jobs"): the plan, and the rules that
// decide what a row is allowed to claim about the car.
//
// The thing under test is that the sweep is FORMULAIC and chassis-agnostic.
// It used to carry a hand-written VARIANT_GROUPS table covering E46 and E36,
// and nav gated the whole menu on that table's keys -- so 24 of the 26
// shipped chassis had no whole-vehicle scan at all. The replacement reads the
// per-ECU `group` field that tools/export/inpa_config.py validates at
// generation time, so these tests assert against the SHIPPED CONFIGS rather
// than against fixtures: if the generator's coverage regresses, this fails.
//
//   node tools/verify/test_sweep.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');
let passed = 0;
const ok = (what) => { passed++; if (process.env.V) console.log('  ok', what); };

// ---- load the sweep's pure half -------------------------------------------
// sweep.js is a browser script, not a module. Lift the planning functions by
// name into a sandbox instead of slicing on comments: a reworded comment
// silently returns -1 from indexOf and evaluates the whole file, throwing far
// from the real cause.
const SRC = fs.readFileSync(
  path.join(ROOT, 'app/renderer/screens/sweep.js'), 'utf8');

// core.js's own dataSets, so the lifted code sees the projection the renderer
// gives it: set 0 is the EDIABAS system summary and is dropped whenever there
// is anything else, and kept when it is all there is.
const CORE = fs.readFileSync(path.join(ROOT, 'app/renderer/core/core.js'), 'utf8');
const DATASETS = CORE.slice(CORE.indexOf('function dataSets'),
  CORE.indexOf('// flatten result sets'));
assert.ok(/function dataSets/.test(DATASETS), 'core.js no longer defines dataSets');

// The file with comments stripped. Several checks below assert that a dead
// route or a replaced table no longer APPEARS -- and this file documents what
// it replaced by name, so those checks must read code, not prose.
const CODE = SRC.split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');

function lift(names) {
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(DATASETS, ctx);
  // Only the declarations we need, pulled out by a balanced-brace scan from
  // each declaration site. Nothing here touches the DOM or the wire.
  for (const n of names) {
    const decl = new RegExp(`^(?:function ${n}\\b|const ${n} =)`, 'm');
    const m = decl.exec(SRC);
    assert.ok(m, `sweep.js no longer declares ${n}`);
    const i = m.index;
    let end = -1;
    if (SRC.startsWith('function', i)) {
      // a function declaration ends at the brace that closes its BODY, so
      // only braces count -- the parameter list's parens must not open depth
      let depth = 0, seen = false;
      for (let j = SRC.indexOf('{', i); j < SRC.length; j++) {
        const c = SRC[j];
        if (c === '{') { depth++; seen = true; }
        else if (c === '}' && --depth === 0 && seen) { end = j + 1; break; }
      }
    } else {
      // `const x = ...;` -- the terminating semicolon at bracket depth 0
      let depth = 0;
      for (let j = i; j < SRC.length; j++) {
        const c = SRC[j];
        if ('{(['.includes(c)) depth++;
        else if ('})]'.includes(c)) depth--;
        else if (c === ';' && depth === 0) { end = j + 1; break; }
      }
    }
    assert.ok(end > i, `could not delimit ${n} in sweep.js`);
    // `const` in a vm context is a lexical binding, not a property of the
    // context object, so it would be invisible to the caller. Assign each
    // lifted name onto the context explicitly.
    vm.runInContext(`${SRC.slice(i, end)}\n;this.${n} = ${n};`, ctx);
  }
  return ctx;
}

const S = lift(['sameSgbd', 'sweepPlan', 'targetLabel', 'rowForVariant',
                'identValue', 'isMissingJob', 'IDENT_FIELDS', 'IDENT_BUILD']);

// ---- the shipped configs ---------------------------------------------------
const CFG = path.join(ROOT, 'data', 'chassis-config');
assert.ok(fs.existsSync(CFG),
  'data/chassis-config missing -- regenerate with tools/export/inpa_config.py');
const CHASSIS = fs.readdirSync(CFG)
  .filter((f) => f.endsWith('.json') && f !== 'index.json')
  .map((f) => JSON.parse(fs.readFileSync(path.join(CFG, f), 'utf8')));
assert.ok(CHASSIS.length >= 20, `only ${CHASSIS.length} chassis configs`);

const GROUPS = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'data', 'groups', 'index.json'), 'utf8'));
const SHIPPED = new Set(GROUPS.groups || []);

// ---- 1. no hardcoded chassis knowledge -------------------------------------

{
  // The whole point of the rewrite. A chassis id anywhere in this file is a
  // per-car special case, which is exactly what was removed.
  //
  // CODE, not SRC: the file's own history note NAMES the tables it replaced,
  // and a check that cannot tell a mention from a use would make documenting
  // the change impossible.
  const code = CODE;
  assert.ok(!/VARIANT_GROUPS/.test(code),
    'sweep.js still defines or reads VARIANT_GROUPS');
  assert.ok(!/variantGroups/.test(code),
    'sweep.js still reads the weaker derived variantGroups array');
  const ids = (code.match(/['"](E\d\d|F\d\d\d?|R\d\d|RR\d|K\d\d)['"]/g) || [])
    .filter((s) => s !== "'E46'");   // the documented `chassisId || 'E46'` default
  assert.deepStrictEqual(ids, [],
    `sweep.js hardcodes chassis ids: ${ids.join(', ')}`);
  ok('sweep.js carries no per-chassis tables or chassis ids');
}

{
  // The nav gate that hid Functional Jobs on 24 chassis must be gone too.
  const nav = fs.readFileSync(path.join(ROOT, 'app/renderer/core/nav.js'), 'utf8');
  assert.ok(!/VARIANT_GROUPS/.test(nav),
    'nav.js still gates Functional Jobs on the hand-written table');
  ok('nav.js no longer gates Functional Jobs on a hand-written table');
}

// ---- 2. the plan, over every shipped chassis --------------------------------

{
  // Every chassis must produce a plan. This is the coverage claim: the sweep
  // works on all of them, not two.
  for (const ch of CHASSIS) {
    const plan = S.sweepPlan(ch);
    assert.ok(plan.length > 0, `${ch.id}: sweepPlan produced no targets`);
    for (const t of plan) {
      assert.ok(t.ecus.length > 0, `${ch.id}: target ${t.group} has no ecus`);
      assert.ok(S.targetLabel(t), `${ch.id}: target ${t.group} has no label`);
    }
  }
  ok(`every shipped chassis produces a scan plan (${CHASSIS.length})`);
}

{
  // A group is ONE bus address, so it must appear as exactly one target even
  // when several sections list members of it. Collapsing is the entire reason
  // the sweep is shorter than the config.
  for (const ch of CHASSIS) {
    const plan = S.sweepPlan(ch);
    const groups = plan.filter((t) => t.group).map((t) => t.group);
    assert.strictEqual(new Set(groups).size, groups.length,
      `${ch.id}: a group appears as more than one target`);
  }
  ok('each diagnostic-address group is probed exactly once per chassis');
}

{
  // The plan must be strictly smaller than the raw ecu list wherever variants
  // exist -- otherwise nothing was collapsed and the sweep is just the config.
  const ch = CHASSIS.find((c) => c.id === 'E46');
  assert.ok(ch, 'E46 config missing');
  const rawCount = ch.sections.reduce((n, s) => n + s.ecus.length, 0);
  const plan = S.sweepPlan(ch);
  assert.ok(plan.length < rawCount,
    `E46: plan (${plan.length}) did not collapse the ecu list (${rawCount})`);
  // The twelve engine rows share D_0012 / D_MOTOR: the plan must probe two
  // addresses, not twelve modules.
  const engine = ch.sections.find((s) => /engine/i.test(s.name));
  const engineGroups = new Set(engine.ecus.filter((e) => e.group)
    .map((e) => e.group.toLowerCase()));
  const engineTargets = plan.filter((t) =>
    t.group && engineGroups.has(t.group) && t.section === engine.name);
  assert.strictEqual(engineTargets.length, engineGroups.size);
  assert.ok(engine.ecus.length > engineTargets.length * 3,
    'E46 engine did not collapse meaningfully');
  ok(`E46 collapses ${rawCount} config rows to ${plan.length} bus probes`);
}

{
  // Every grouped target must name a group this build can actually run,
  // otherwise the strict presence test silently degrades to a direct read.
  // 0 misses is the current state and the thing worth protecting.
  const misses = [];
  for (const ch of CHASSIS) {
    for (const t of S.sweepPlan(ch)) {
      if (t.group && !SHIPPED.has(t.group)) misses.push(`${ch.id}:${t.group}`);
    }
  }
  assert.deepStrictEqual(misses, [],
    `groups referenced but not shipped: ${misses.join(', ')}`);
  ok('every group in every plan is shipped in data/groups (strict path live)');
}

{
  // Ungrouped rows are the honest exception, not the norm. If this ratio ever
  // inverts, the generator regressed and most of the car is being direct-read
  // with no presence test at all.
  let grouped = 0, solo = 0;
  for (const ch of CHASSIS) {
    for (const t of S.sweepPlan(ch)) (t.group ? grouped++ : solo++);
  }
  assert.ok(grouped > solo * 2,
    `only ${grouped} grouped vs ${solo} ungrouped targets across all chassis`);
  ok(`grouped targets dominate (${grouped} grouped / ${solo} ungrouped)`);
}

{
  // Sections are preserved: the popup and the printed report group by them.
  for (const ch of CHASSIS) {
    for (const t of S.sweepPlan(ch)) {
      assert.ok(t.section, `${ch.id}: target ${t.group} lost its section`);
    }
  }
  ok('every target keeps the section it came from');
}

{
  // Order is chassis-config order, which is INPA's menu order -- engine first.
  const ch = CHASSIS.find((c) => c.id === 'E46');
  const plan = S.sweepPlan(ch);
  assert.strictEqual(plan[0].section, ch.sections[0].name);
  ok('plan order follows the config (INPA menu order), engine section first');
}

// ---- 3. variant -> config row ----------------------------------------------

{
  const t = {
    group: 'd_0012',
    ecus: [
      { code: 'MS430', sgbd: 'ms430ds0', label: 'MS43 for M54' },
      { code: 'BMS46', sgbd: 'bms46ds0', label: 'BMS46 for M43', variants: ['bms46ds1'] },
    ],
  };
  assert.strictEqual(S.rowForVariant(t, 'ms430ds0').code, 'MS430');
  ok('an identified variant matches its own config row');

  // The declared alias must match too: BMS46 ships bms46ds1 as a variant, and
  // an ident naming it is still the BMS46 row.
  assert.strictEqual(S.rowForVariant(t, 'bms46ds1').code, 'BMS46');
  ok('an identified variant matches a row via its declared aliases');

  // Case never decides anything: config casing is inconsistent by design
  // (D50M57D0 vs ms430ds0 -- see the inpa_config fidelity notes).
  assert.strictEqual(S.rowForVariant(t, 'MS430DS0').code, 'MS430');
  ok('variant matching is case-insensitive');

  // BMW ships variants the menu never listed, and the row must then be NULL
  // rather than an unrelated sibling. E46's D_MOTOR probes the broadcast
  // address, so on an MS45 car it answers ms450ds0 while its only rows are
  // d50m47b1/ME9N45; returning ecus[0] labelled that car's engine "DDE 5.0
  // for M47 new" and drew its faults under a diesel it does not have.
  assert.strictEqual(S.rowForVariant(t, 'ms450ds0'), null,
    'an unlisted variant must NOT borrow a sibling row for its label');
  ok('an unlisted variant yields no row, so the identified name is the label');
}

{
  assert.ok(S.sameSgbd('MS430DS0', 'ms430ds0'));
  assert.ok(!S.sameSgbd('ms430ds0', 'ms450ds0'));
  assert.ok(!S.sameSgbd(null, undefined) === false || S.sameSgbd(null, undefined));
  ok('sameSgbd compares case-insensitively');
}

// ---- 4. identification field extraction ------------------------------------

{
  // dataSets() drops set 0 (the EDIABAS system summary) when more than one set
  // is present -- mirror that here so the fixtures match the real shape.
  const sets = [{ _SYSTEM: 1 }, { SG_VARIANTE: 'MS430DS0', AIF_SW_NR: '7519308' }];
  assert.strictEqual(S.identValue(sets, S.IDENT_FIELDS), 'MS430DS0');
  assert.strictEqual(S.identValue(sets, S.IDENT_BUILD), '7519308');
  assert.strictEqual(S.identValue([{ _S: 1 }], S.IDENT_FIELDS), null);
  ok('identification reads the variant and build fields, or reports nothing');

  // Field order is preference order: the first listed name that is present
  // wins, so a module answering both keeps the more specific one.
  const both = [{ _S: 1 }, { VARIANTE: 'GENERIC', SG_VARIANTE: 'SPECIFIC' }];
  assert.strictEqual(S.identValue(both, S.IDENT_FIELDS), 'SPECIFIC');
  ok('the first listed identification field wins (preference order)');
}

{
  // The ident job must never be assumed to be called IDENT: 16% of the
  // shipped corpus does not declare one, and assuming it made present
  // F-series modules report "no response".
  assert.ok(/identJobFor/.test(CODE),
    'sweep.js no longer asks the module which ident job it declares');
  assert.ok(!/run\/IDENT`/.test(CODE),
    'sweep.js still hardcodes the IDENT job name');
  // INITIALISIERUNG classifies as a write and must not be an ident candidate.
  assert.ok(!/INITIALISIERUNG/.test(CODE),
    'sweep.js would run INITIALISIERUNG, which the write classifier guards');
  ok('the ident job is discovered per module, never assumed');
}

{
  // THE PICKER MUST NEVER SELECT A WRITE. The corpus ships IDENT_SCHREIBEN,
  // IDENT_VIN_SCHREIBEN and IDENT_PRODUCTION_DATA_SCHREIBEN -- jobs that write
  // the module's identity -- and bestvm's isWriteJob() clears every one of
  // them, because a read token anywhere wins and IDENT is a strong read token.
  // So this is exercised over EVERY ident-shaped job name in the shipped
  // corpus, not over a fixture: a sweep that picked one of these would write
  // identity data to every module on the car.
  const bv = { window: {}, console };
  vm.createContext(bv);
  vm.runInContext(fs.readFileSync(
    path.join(ROOT, 'app/renderer/core/bestvm.js'), 'utf8'), bv);
  assert.strictEqual(typeof bv.isWriteJob, 'function',
    'bestvm.js no longer exposes isWriteJob');

  const pk = { console, isWriteJob: bv.isWriteJob };
  vm.createContext(pk);
  for (const n of ['IDENT_JOB_RE', 'IDENT_WRITE_RE', 'isIdentReadJob']) {
    const m = new RegExp(`^const ${n} =`, 'm').exec(SRC);
    assert.ok(m, `sweep.js no longer declares ${n}`);
    const end = SRC.indexOf(';', m.index) + 1;
    vm.runInContext(`${SRC.slice(m.index, end)}\n;this.${n} = ${n};`, pk);
  }

  // the sanity check that motivates the rule
  assert.strictEqual(bv.isWriteJob('IDENT_SCHREIBEN'), false,
    'isWriteJob now guards IDENT_SCHREIBEN -- re-check whether the explicit '
    + 'write-verb gate in sweep.js is still the right one');
  assert.strictEqual(pk.isIdentReadJob('IDENT_SCHREIBEN'), false,
    'the sweep would run IDENT_SCHREIBEN as an identification read');

  // every ident-shaped name any shipped module declares
  const names = new Set();
  const tree = path.join(ROOT, 'data', 'chassis');
  if (fs.existsSync(tree)) {
    for (const ch of fs.readdirSync(tree)) {
      const cd = path.join(tree, ch);
      if (!fs.statSync(cd).isDirectory()) continue;
      for (const sg of fs.readdirSync(cd)) {
        const jc = path.join(cd, sg, 'job-code.json.gz');
        if (!fs.existsSync(jc)) continue;
        let d;
        try { d = JSON.parse(zlib.gunzipSync(fs.readFileSync(jc)).toString()); }
        catch { continue; }
        for (const j of Object.keys(d.jobs || {})) {
          if (/^(IDENT|IDENTIFIKATION)(_|$)/i.test(j)) names.add(j);
        }
      }
    }
  }
  assert.ok(names.size > 20,
    `only ${names.size} ident job names found -- is data/chassis generated?`);
  const writes = [...names].filter((n) =>
    /(SCHREIBEN|_SETZEN|_WRITE|PROGRAMMIER)/i.test(n) && pk.isIdentReadJob(n));
  assert.deepStrictEqual(writes, [],
    `the sweep would run these WRITE jobs as identification: ${writes.join(', ')}`);
  ok(`no write job is selectable as an ident read (${names.size} names in corpus)`);
}

// ---- 5. the routes actually exist ------------------------------------------

{
  // The old code called /api/ecu/<s>/read and /clear, which are C#-server
  // routes the web build never implemented -- webshim only routes
  // /api/ecu/<s>/run/<JOB>, so every module 404'd and reported "no response".
  assert.ok(!/\/read`/.test(CODE), 'sweep.js still calls the dead /read route');
  assert.ok(!/\/clear`/.test(CODE), 'sweep.js still calls the dead /clear route');
  assert.ok(/run\/FS_LESEN`/.test(CODE), 'sweep.js must read via run/FS_LESEN');
  assert.ok(/run\/FS_LOESCHEN`/.test(CODE), 'sweep.js must clear via run/FS_LOESCHEN');

  const shim = fs.readFileSync(
    path.join(ROOT, 'app/renderer/core/webshim.js'), 'utf8');
  const run = /\/\^\\\/api\\\/ecu\\\/\(\[\^\/\]\+\)\\\/run/.test(shim)
    || /api\\\/ecu\\\/\(\[\^\/\]\+\)\\\/run/.test(shim);
  assert.ok(run, 'webshim no longer routes /api/ecu/<sgbd>/run/<job>');
  ok('the sweep calls only routes the web build actually serves');
}

{
  // Same dead route in the background scan.
  const auto = fs.readFileSync(
    path.join(ROOT, 'app/renderer/screens/autoscan.js'), 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!/\/read`/.test(auto),
    'autoscan.js still calls the dead /read route');
  ok('autoscan.js reads through the live route too');
}

{
  assert.ok(S.isMissingJob(new Error('404 not found')));
  assert.ok(S.isMissingJob(new Error('no job code shipped for xyz')));
  assert.ok(S.isMissingJob(new Error('no static route for /api/ecu/x/read')));
  assert.ok(!S.isMissingJob(new Error('IFH-0009: no answer from ECU (timeout)')));
  ok('a missing job is told apart from a silent bus');
}

// ---- 6. the safety rule ----------------------------------------------------

{
  // The rule the whole design exists for: when a runnable group stays silent,
  // the module is ABSENT and no configured sibling may be read instead. The
  // E46 config maps Airbag to `zae` while many cars carry an MRS, and `zae`
  // will answer an MRS and decode a confident "0 faults".
  const body = SRC.slice(SRC.indexOf('async function resolveTarget'),
    SRC.indexOf('// wire helpers'));
  assert.ok(/state: 'absent'/.test(body),
    'resolveTarget no longer reports absence');
  // there must be no path from a null resolution to a configured-sgbd read
  const strictBranch = body.slice(body.indexOf('groupRunnable'),
    body.indexOf('// No runnable group'));
  assert.ok(!/t\.ecus\[0\]/.test(strictBranch.replace(/rowForVariant\([^)]*\)/g, '')),
    'a silent runnable group can still fall back to a configured sibling');
  ok('a silent runnable group reports absence, never a sibling read');
}

{
  // A clear must be proven by re-reading, not trusted.
  const clear = SRC.slice(SRC.indexOf('async function clearModule'));
  assert.ok(/re-read/i.test(clear) && /readFaults/.test(clear),
    'clearModule no longer proves the clear by re-reading');
  assert.ok(/confirmDialog/.test(clear), 'clearModule no longer confirms');
  ok('clearing confirms first and proves the result by re-reading');
}

console.log(`\nsweep: ${passed} checks passed`);
