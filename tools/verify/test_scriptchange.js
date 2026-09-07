#!/usr/bin/env node
// scriptchange: the entry script hands the whole UI to another .IPO.
//
// INPA loads one script per diagnostic address. E46's climate entry is
// KLIMA_5B, whose inpainit reads VARIANTE and, for an IHKA46_3, calls
// scriptchange("IHKA46") -- from then on INPA draws IHKA46.IPO's menus and
// runs its inpainit. KLIMA_5B's own menu guards never name IHKA46_3, so an
// app that stayed in it had no arm for the car's "Activate" key: the name-tag
// fallback picked a sibling chassis's page (s_steuern_ihr39, the E39 heater),
// a labelled readout, and the identity card said "no identity data".
//
// Real-car ground truth: E46 325i (M54, 2004), D_005B resolves to ihka46_3.
//
//   node tools/verify/test_scriptchange.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');

const R = path.join(__dirname, '..', '..');
const { IpoVm, FeedHost } = require(path.join(R, 'app/renderer/core/ipovm.js'));

const gz = (p) =>
  JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(R, p))).toString());
const js = (p) => JSON.parse(fs.readFileSync(path.join(R, p), 'utf8'));

const klimaExec = gz('data/chassis/E46/klima_5b/ipoexec.json.gz');
const klimaIr = js('data/chassis/E46/klima_5b/screens.json');
const ihka46Exec = gz('data/chassis/E46/ihka46/ipoexec.json.gz');
const ihka46Ir = js('data/chassis/E46/ihka46/screens.json');

let passed = 0;
const ok = (m) => {
  passed++;
  console.log(`  ok    ${m}`);
};

// ---- the VM records the target of scriptchange() -------------------------
// A host answering INITIALISIERUNG->VARIANTE with the given name; everything
// else answers as the SGBD would on a healthy module.
function variantHost(variant) {
  const info = new Map([
    ['ECU', 'Integrierte Heiz- Klimaautomatik E46'],
    ['ORIGIN', 'BMW TP-421 Drexel'],
    ['REVISION', '1.1'],
    ['AUTHOR', 'BMW TP-421 Drexel'],
    ['SPRACHE', 'deutsch'],
  ]);
  let pool = new Map();
  return {
    job(_sgbd, job) {
      const j = String(job).toUpperCase();
      pool =
        j === 'INITIALISIERUNG'
          ? new Map([
              ['DONE', '1'],
              ['VARIANTE', variant],
            ])
          : j === 'INFO'
            ? info
            : new Map();
      return {};
    },
    result(key, opts = {}) {
      if (key === 'JOB_STATUS') return 'OKAY';
      const v = pool.get(key);
      if (v == null)
        return opts.integer ? 0 : opts.default != null ? opts.default : '';
      return opts.integer ? parseInt(v, 10) || 0 : String(v);
    },
    status() {
      return 'OKAY';
    },
    inputstate() {
      return 0;
    },
  };
}
function runEntry(exec, variant) {
  const vm = new IpoVm(exec, { budget: 80000, host: variantHost(variant) });
  vm.run('__inpa_startup__');
  vm.out = new vm.out.constructor();
  return vm.run('inpainit');
}
{
  const out = runEntry(klimaExec, 'IHKA46_3');
  assert.strictEqual(
    out.scriptChange,
    'IHKA46',
    `KLIMA_5B must hand an IHKA46_3 to IHKA46.IPO, got ${out.scriptChange}`
  );
  assert.ok(
    !(out.messages || []).some((m) => /stopped/i.test(m.body || '')),
    'IHKA46_3 is in KLIMA_5B dispatch list: no "Program will be stopped"'
  );
  ok('KLIMA_5B inpainit: IHKA46_3 -> scriptchange("IHKA46")');
  // the other arms of the same chain (read off the bytecode, not guessed):
  // IHKA39_5 -> IHKA39.IPO, IHKA85 -> IHKX85.IPO; IHKA39 itself stays
  assert.strictEqual(runEntry(klimaExec, 'IHKA39_5').scriptChange, 'IHKA39');
  assert.strictEqual(runEntry(klimaExec, 'IHKA85').scriptChange, 'IHKX85');
  assert.strictEqual(runEntry(klimaExec, 'IHKA39').scriptChange, null);
  ok('KLIMA_5B inpainit: IHKA39_5 -> IHKA39.IPO, IHKA85 -> IHKX85.IPO');
  assert.strictEqual(
    runEntry(klimaExec, 'IHKA46').scriptChange,
    null,
    'a variant KLIMA_5B serves itself must not switch'
  );
  assert.strictEqual(runEntry(klimaExec, 'IHKA38').scriptChange, null);
  ok('KLIMA_5B inpainit: IHKA46 and IHKA38 stay in KLIMA_5B');
  // the script it switched to accepts the variant as its own
  const out2 = runEntry(ihka46Exec, 'IHKA46_3');
  assert.strictEqual(out2.scriptChange, null);
  assert.ok(
    !(out2.messages || []).some((m) => /stopped/i.test(m.body || '')),
    'IHKA46.IPO must accept IHKA46_3'
  );
  ok('IHKA46 inpainit: IHKA46_3 accepted, no further switch');
}

// ---- the entry gate follows the switch --------------------------------------
// ir.js as the app runs it, with the shim replaced by a router over the two
// archives and canned wire answers.
const lang = () => 'en';
eval(fs.readFileSync(path.join(R, 'app/renderer/core/translate.js'), 'utf8'));
const inpaMode = () => true,
  esc = (s) => s,
  stagger = () => {},
  FKEY_SLOTS = 9;
globalThis.IpoVm = IpoVm;
const isSystemSet = (s) =>
  s && typeof s === 'object' && 'VARIANTE' in s && 'JOBNAME' in s;
const dataSets = (sets) => (sets || []).filter((s) => !isSystemSet(s));
const flatResults = (sets) => {
  const out = [];
  dataSets(sets).forEach((s) =>
    Object.entries(s).forEach(([k, v]) => {
      if (!k.startsWith('_') && k !== 'JOB_STATUS') out.push([k, v]);
    })
  );
  return out;
};
const wireLog = [];
const api = async (url) => {
  const m = String(url).match(
    /^\/api\/ecu\/([^/]+)\/(ir|ipoexec|run)(?:\/([^?]+))?/
  );
  if (!m) throw new Error(`no route ${url}`);
  const [, sgbd, kind, job] = m;
  if (kind === 'run') {
    wireLog.push(`${sgbd}/${job}`);
    if (job === 'INITIALISIERUNG')
      return {
        sets: [{ DONE: '1' }],
        system: { OBJECT: sgbd, VARIANTE: 'IHKA46_3', JOBNAME: job, SAETZE: 1 },
      };
    if (job === 'INFO')
      return {
        sets: [
          {
            ECU: 'Integrierte Heiz- Klimaautomatik E46',
            ORIGIN: 'BMW TP-421 Drexel',
            REVISION: '1.1',
            AUTHOR: 'BMW TP-421 Drexel',
            SPRACHE: 'deutsch',
          },
        ],
        system: { OBJECT: sgbd, VARIANTE: 'IHKA46_3', JOBNAME: job, SAETZE: 1 },
      };
    throw new Error(`unexpected job ${job}`);
  }
  // the archives the shim serves: the E46 config's ihka38 row carries
  // KLIMA_5B's script; ihka46 ships its own; ihka46_3 ships no screens
  const arch = {
    ihka38: { ir: klimaIr, ipoexec: klimaExec },
    ihka46: { ir: ihka46Ir, ipoexec: ihka46Exec },
  }[sgbd];
  if (!arch || !arch[kind]) throw new Error(`${kind} not found for ${sgbd}`);
  return arch[kind];
};
const console_info = console.info;
console.info = () => {};
let _irSrc = fs.readFileSync(
  path.join(R, 'app/renderer/screens/ir.js'),
  'utf8'
);
for (const fn of [
  'irRunEntry',
  'irFollowScriptChange',
  'irRootMenu',
  'irMenuItems',
  'irMenuAllowedForVariant',
  'irIsCard',
  'irOpensMenu',
  'irModeGroup',
  'irItemBody',
  'irItemActs',
]) {
  _irSrc = _irSrc.replace(
    new RegExp(`(async )?function ${fn}\\(`),
    `globalThis.${fn} = ${fn}; $1function ${fn}(`
  );
}
eval(_irSrc);

(async () => {
  // showEcu's state on this car: the resolved SGBD is ihka46_3, its archive
  // has no IR, so the IR fell back to the configured base (ihka38 = KLIMA_5B)
  const ecu = {
    code: 'klima_5B',
    sgbd: 'ihka46_3',
    group: 'D_005B',
    _sgbdBase: 'ihka38',
    _irFrom: 'ihka38',
    _variant: 'IHKA46_3',
    _ir: klimaIr,
  };
  ecu._ir._variant = 'IHKA46_3';

  // WITHOUT following the switch, KLIMA_5B has no Activate menu for this car:
  // the key ends up on a screen its guards never chose. This is the bug.
  {
    const root = irRootMenu(klimaIr, 'IHKA46_3');
    const act = irMenuItems(klimaIr, root, 'IHKA46_3').find((i) =>
      /^Activ/i.test(i.label)
    );
    assert.ok(act, 'KLIMA_5B root must list Activate');
    const guarded = Object.values(act.menuFor || {}).flat();
    assert.ok(
      !guarded.some((v) => String(v).toUpperCase() === 'IHKA46_3'),
      'precondition: KLIMA_5B Activate guards never name IHKA46_3'
    );
    ok('KLIMA_5B alone cannot serve IHKA46_3 Activate (needs the switch)');
  }

  let entry = await irRunEntry(ecu);
  assert.ok(entry.ran, 'entry must run');
  assert.strictEqual(entry.script, 'IHKA46', 'entry must report the switch');
  assert.strictEqual(entry.variant, 'IHKA46_3');
  ok('irRunEntry reports script: IHKA46');

  const before = wireLog.length;
  entry = await irFollowScriptChange(ecu, entry);
  assert.ok(entry.ran, 'the followed entry must run');
  assert.strictEqual(entry.script, null, 'IHKA46.IPO ends the chain');
  assert.strictEqual(ecu._irFrom, 'ihka46', 'IR now comes from ihka46');
  assert.strictEqual(ecu._ir, ihka46Ir, 'ecu._ir swapped to IHKA46 script');
  assert.strictEqual(ecu._ir._variant, 'IHKA46_3');
  assert.strictEqual(ecu.sgbd, 'ihka46_3', 'the SGBD we TALK to is unchanged');
  assert.strictEqual(
    wireLog.length,
    before,
    `the second inpainit must reuse the wire answers, sent ${wireLog
      .slice(before)
      .join(',')}`
  );
  assert.ok(
    !(entry.messages || []).some((m) => /stopped/i.test(m.body || '')),
    'IHKA46 inpainit accepts the car'
  );
  ok('irFollowScriptChange swaps to IHKA46 without a second wire read');

  // and now Activate is a real submenu guarded for this very variant
  {
    const ir = ecu._ir;
    const root = irRootMenu(ir, ecu._variant);
    const items = irMenuItems(ir, root, ecu._variant);
    const act = items.find((i) => /^Activ/i.test(i.label));
    assert.ok(act, 'IHKA46 root must list Activate');
    assert.strictEqual(
      act.menu,
      'm_steuern_ihka46_ihka46_2_ihka46_3',
      `Activate must open the IHKA46_3 menu, got ${act.menu}`
    );
    assert.ok(
      irMenuAllowedForVariant(ir, act.menu, ecu._variant),
      'the menu is allowed for IHKA46_3'
    );
    const sub = irMenuItems(ir, act.menu, ecu._variant);
    assert.ok(sub.length >= 3, `activation submenu has keys (${sub.length})`);
    // none of its keys is a labelled readout that would land on the ID card
    const scr = act.screen && ir.screens[act.screen];
    assert.ok(!scr || !irIsCard(scr), 'Activate backdrop is not an ID card');
    ok(
      `IHKA46_3 Activate -> ${act.menu} (${sub.map((i) => i.label).join(', ')})`
    );
  }

  // a switch to a script with no archive keeps what we have (bounded)
  {
    const e2 = {
      sgbd: 'ihka46_3',
      _irFrom: 'ihka38',
      _variant: 'IHKA46_3',
      _ir: klimaIr,
    };
    const r = await irFollowScriptChange(e2, {
      ran: true,
      script: 'NOSUCH',
      messages: [],
      variant: 'IHKA46_3',
      wire: { results: {}, silent: false, anyAnswer: true },
    });
    assert.strictEqual(e2._irFrom, 'ihka38', 'unknown script: IR unchanged');
    assert.strictEqual(r.script, 'NOSUCH', 'entry returned as-is');
    ok('a script with no archive leaves the IR alone');
  }

  // ---- one level down: the Activate submenu's own keys ----------------------
  // On the car, "Digital output" fell through to its empty backdrop ("could
  // not decode"), "Display test" likewise, and "Cancel compressor
  // deactivation" said "not decoded". Three separate faults, each proven here.
  const actMenu = 'm_steuern_ihka46_ihka46_2_ihka46_3';
  const ir = ecu._ir;
  const sub = irMenuItems(ir, actMenu, ecu._variant);
  const byLabel = (re) => sub.find((i) => re.test(i.label));
  {
    // (1) a lone unguarded submenu survives the variant-tag pass
    const dig = byLabel(/^Digital output/i);
    const disp = byLabel(/^Display/i);
    assert.strictEqual(
      dig && dig.menu,
      'm_steuern_digital_ihka46_ihka46_2_ihka46_3',
      `Digital output must keep its submenu, got ${dig && dig.menu}`
    );
    assert.strictEqual(
      disp && disp.menu,
      'm_steuern_display_ihka46_ihka46_2_ihka46_3',
      `Display test must keep its submenu, got ${disp && disp.menu}`
    );
    assert.ok(irOpensMenu(ir, dig, actMenu), 'Digital output opens its menu');
    assert.ok(irOpensMenu(ir, disp, actMenu), 'Display test opens its menu');
    const digKeys = irMenuItems(ir, dig.menu, ecu._variant);
    assert.deepStrictEqual(
      digKeys.map((i) => i.job),
      [
        'STEUERN_ZUHEIZER',
        'STEUERN_RELAIS_HECKSCHEIBE',
        'STEUERN_ZUSATZWASSERPUMPE',
      ],
      'the digital submenu lists its three actuator keys'
    );
    ok('Digital output / Display test keep their single unguarded submenus');

    // (2) Testpattern 1..4 write slot 29 = the job ARGUMENT, not a mode flag
    const dispKeys = irMenuItems(ir, disp.menu, ecu._variant);
    assert.strictEqual(dispKeys.length, 4);
    for (const k of dispKeys) {
      assert.strictEqual(k.job, 'STEUERN_DISPLAY');
      assert.strictEqual(
        irModeGroup(ir, disp.menu, k),
        null,
        `${k.label} must not be swallowed as a radio-group mode`
      );
    }
    ok('Testpattern keys are actions (STEUERN_DISPLAY n), not a mode group');
  }

  // (3) the wire sequences INPA's own key bodies produce, driven live
  const vm = new IpoVm(ihka46Exec, {
    budget: 800000,
    wireJobs: true,
    host: new FeedHost(),
  });
  {
    let st = vm.stepStart('__inpa_startup__');
    for (let n = 0; n < 50 && st && st.kind !== 'done'; n++)
      st = vm.resume(new Map());
  }
  const drive = (step, answer) => {
    const sent = [];
    const asked = [];
    for (let n = 0; n < 200 && step && step.kind !== 'done'; n++) {
      if (step.kind === 'job') {
        sent.push([step.job, step.arg || '']);
        step = vm.resume(new Map([['JOB_STATUS', 'OKAY']]));
      } else if (step.kind === 'input') {
        asked.push(step);
        step = vm.resume(answer);
      } else if (step.kind === 'wait') step = vm.resume();
      else break;
    }
    assert.ok(
      step && step.kind === 'done',
      `body did not finish (${step && step.kind})`
    );
    return { sent, asked };
  };
  const item = (menu, nr, answer) => drive(vm.stepStartItem(menu, nr), answer);
  const prologue = (menu) => {
    const first = ihka46Exec.procs[menu].findIndex((t) => t.op === 'ITEM');
    return drive(vm.stepStartRange(menu, 0, first)).sent;
  };
  {
    const disp = 'm_steuern_display_ihka46_ihka46_2_ihka46_3';
    assert.deepStrictEqual(
      prologue(disp),
      [['STEUERN_DISPLAY', '1']],
      'entering Displaytest switches pattern 1 on, as INPA does'
    );
    assert.deepStrictEqual(item(disp, 2).sent, [['STEUERN_DISPLAY', '2']]);
    assert.deepStrictEqual(
      item(disp, 10).sent,
      [['STEUERN_DISPLAY', '0']],
      'its Back key is the release: pattern off'
    );
    ok('Displaytest: prologue 1, F2 -> 2, Back -> 0');

    const dig = 'm_steuern_digital_ihka46_ihka46_2_ihka46_3';
    prologue(dig);
    assert.deepStrictEqual(item(dig, 1).sent, [
      ['STEUERN_ZUHEIZER', 'ON'],
      ['STATUS_IO', ''],
    ]);
    assert.deepStrictEqual(
      item(dig, 1).sent,
      [
        ['STEUERN_ZUHEIZER', 'OFF'],
        ['STATUS_IO', ''],
      ],
      'a second press toggles the output off'
    );
    ok(
      'Digital output: Additional heater ON, then OFF, each re-reading STATUS_IO'
    );

    // the compressor-lock key: its body acts, INPA asks yes/no, sends on "yes"
    const body = irItemBody(ihka46Exec, actMenu, 6);
    assert.ok(body && irItemActs(ihka46Exec, body[0], body[1], body[2]));
    prologue(actMenu);
    const yes = item(actMenu, 6, 0); // "yes" is FalseStr = 0
    assert.strictEqual(yes.asked.length, 1, 'INPA asks once');
    assert.strictEqual(yes.asked[0].name, 'inputdigital');
    assert.deepStrictEqual(yes.asked[0].prompts.slice(-2), ['yes', 'no']);
    assert.deepStrictEqual(yes.sent, [['KOMPRESSOR_SPERRE', 'OFF']]);
    const no = item(actMenu, 6, 1);
    assert.strictEqual(no.asked.length, 1);
    assert.deepStrictEqual(no.sent, [], '"no" sends nothing');
    ok(
      'Cancel compressor deactivation: yes -> KOMPRESSOR_SPERRE OFF, no -> nothing'
    );
  }

  console.info = console_info;
  console.log(`\n${passed} checks passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
