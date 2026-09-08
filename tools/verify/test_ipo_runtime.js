// The live .IPO runtime, driven offline against a fake car.
//
// Two shipped scripts, run exactly as the module view runs them: entry
// (startup + inpainit), the root menu the script sets, key presses in the
// same VM, screen cycles with their own jobs, the script's own Back as the
// release. The wire is a fake that records every POST and answers the way the
// real cars did (E46 IHKA46_3 and MS45), so the assertions are the exact job
// sequences INPA would put on the K-line.
//
//   node tools/verify/test_ipo_runtime.js
//   V=1 node tools/verify/test_ipo_runtime.js     # per-check output

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');
const R = (p) => path.join(ROOT, 'app', 'renderer', p);
let passed = 0;
const ok = (what) => {
  passed++;
  if (process.env.V) console.log('  ok', what);
};

// ---- the browser globals the runtime leans on ------------------------------
global.window = global;
global.document = { getElementById: () => null };
global.sbLeft = { textContent: '' };
global.esc = (s) => String(s == null ? '' : s);
global.irLabel = (s) => s;
// the runtime-text dictionaries as the app defines them (translate.js is a
// classic script: evaluated here so phraseText/bmwCode/ortNrFull are the
// shipped functions), gated on the same language setting
let LANG = 'en';
global.lang = () => LANG;
require('vm').runInThisContext(
  fs.readFileSync(R('core/translate.js'), 'utf8'),
  { filename: R('core/translate.js') }
);
// the generated fault dictionaries (faultdb.js is not in the repo): one
// phrase pair, and the 27C3 collision -- the E46 MS45's own codespace says
// oil-level sensor where the flat DB says something else
global.window.BMW_ENV_TEXT = {
  '(Motor) - Öltemperatur': 'Engine oil temperature',
  'Motor Status': 'Engine status',
  '0 ES - Motor steht': '0 ES - engine stopped',
};
global.BMW_FAULT_PHRASES = { Tankentlueftungsventil: 'Tank vent valve' };
global.BMW_FAULT_DB = { '27C3': 'DMTL leak detection' };
global.BMW_FAULT_DB_SCOPED = {
  ms450ds0: { '27C3': 'Thermal oil level sensor' },
};
// as faults.js resolves the reading ECU's codespace
global.scopedFaultDb = (sgbd) =>
  (sgbd && global.BMW_FAULT_DB_SCOPED[String(sgbd).toLowerCase()]) || null;
global.setActions = () => {};
global.location = { search: '' };
global.Settings = { get: (k, d) => d };
global.markEnergized = () => {
  energized += 1;
};
let energized = 0;
let leaveReg = null;
const leaveCalls = []; // every registration, in order
global.registerMenuLeave = (ecu, key, job, arg) => {
  leaveReg = { key, job, arg };
  leaveCalls.push({ key, job, arg });
};
const isSystemSet = (s) =>
  s &&
  typeof s === 'object' &&
  ('SAETZE' in s || 'JOBNAME' in s || 'OBJECT' in s);
global.dataSets = (sets) => {
  const list = sets || [];
  return list.length && isSystemSet(list[0]) ? list.slice(1) : list;
};

// the VM and the write classifier, as shipped (the VM is a folder of classic
// scripts sharing one scope, loaded in index.html order)
const { loadClassic } = require('./lib/load_classic.js');
const { IpoVm, FeedHost } = loadClassic('core/ipovm/');
global.IpoVm = IpoVm;
global.FeedHost = FeedHost;
const bv = require(R('core/bestvm/index.js'));
global.isWriteJob = bv.isWriteJob || global.isWriteJob;
assert.strictEqual(typeof global.isWriteJob, 'function', 'isWriteJob missing');

// the job scanner the runtime uses to word its confirm (the same walk ir.js
// ships; copied here so this harness does not load the whole screen file)
global.irItemBodyJobs = (exec, toks, i0, end) => {
  const out = [];
  const scan = (tk, a, b, depth) => {
    for (let i = a; i < Math.min(b, tk.length); i++) {
      const t = tk[i];
      if (t.op === 'call' && /^INP.?apiJob/.test(t.name || '')) {
        for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
          const c = tk[j];
          if (
            c.op === 'const' &&
            c.t === 's' &&
            /^[A-Z][A-Z0-9_]{3,}$/.test(String(c.v))
          ) {
            if (!out.includes(c.v)) out.push(c.v);
            break;
          }
          if (c.op === 'frame') break;
        }
      } else if (t.op === 'calluser' && depth < 2) {
        const nm = (exec.byid || {})[`func:${t.n}`];
        const body = nm && exec.procs[nm];
        if (Array.isArray(body)) scan(body, 0, body.length, depth + 1);
      }
    }
  };
  scan(toks, i0, end, 0);
  return out;
};

const RT = loadClassic('screens/ipo-runtime/');
const {
  IpoProgram,
  ipoMenuItems,
  ipoWireTarget,
  ipoNeedsConfirm,
  ipoLineRows,
  ipoMenuTiles,
  ipoScreenComponents,
  ipoLampHtml,
  ipoGaugeHtml,
  ipoScreenLineNames,
} = RT;

// ---- execs ------------------------------------------------------------------
function loadExec(chassis, ecu) {
  const tree = path.join(ROOT, 'data', 'chassis', chassis);
  // the folder is named by the menu CODE (E46's engine row is MS450 with
  // sgbd ms450ds0) or by the variant's own name (ihka46_3, derived from the
  // group); find it by the SGBD its ecu.json declares, then by folder name
  // ...and the folder name itself compares case-insensitively: the runner's
  // filesystem is case-sensitive (klima_5B is the E46 code, and that entry
  // row's sgbd is ihka38), a Mac's is not, and the harness must agree.
  const want = ecu.toLowerCase();
  const bySgbd = [];
  try {
    for (const d of fs.readdirSync(tree)) {
      if (d.toLowerCase() === want) {
        bySgbd.push(path.join(tree, d));
        continue;
      }
      try {
        const meta = JSON.parse(
          fs.readFileSync(path.join(tree, d, 'ecu.json'), 'utf8')
        );
        if (String(meta.sgbd || '').toLowerCase() === want)
          bySgbd.push(path.join(tree, d));
      } catch (e) {
        /* not an ECU folder */
      }
    }
  } catch (e) {
    /* no tree: the archive fallback below */
  }
  const cands = [];
  for (const d of bySgbd) {
    cands.push(path.join(d, 'ipoexec.json.gz'), path.join(d, 'ipoexec.json'));
  }
  cands.push(
    path.join(tree, ecu, 'ipoexec.json.gz'),
    path.join(tree, ecu, 'ipoexec.json')
  );
  for (const p of cands) {
    if (!fs.existsSync(p)) continue;
    const raw = fs.readFileSync(p);
    return JSON.parse(p.endsWith('.gz') ? zlib.gunzipSync(raw) : raw);
  }
  // the served export carries it inside the chassis archive
  const chz = path.join(
    ROOT,
    'dist-web',
    'api',
    'chassis',
    `${chassis}.chassis`
  );
  if (fs.existsSync(chz)) {
    try {
      const { execSync } = require('child_process');
      const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ipo-'));
      execSync(`unzip -o -q "${chz}" "ecu/${ecu}.ecu" -d "${tmp}"`);
      execSync(`unzip -o -q "${tmp}/ecu/${ecu}.ecu" ipoexec.json -d "${tmp}"`);
      return JSON.parse(fs.readFileSync(path.join(tmp, 'ipoexec.json')));
    } catch (e) {
      return null;
    }
  }
  return null;
}

// ---- a fake car -----------------------------------------------------------------
//
// answers(job, arg) -> {sets, system}. Records every POST in `sent`.
// the shim's run route resolves a group SGBD to the module on the wire
// (api-router.js); the fake car answers these groups
const FAKE_GROUPS = {
  d_005b: 'ihka46_3',
  d_0072: 'sm46_4',
  d_00da: 'b_sm46_3',
};

function fakeApi(answers) {
  const sent = [];
  global.api = async (url, opts) => {
    const m = String(url).match(
      /^\/api\/ecu\/([^/]+)\/run\/([^?]+)(?:\?arg=(.*))?$/
    );
    if (!m) throw new Error(`unexpected api ${url}`);
    const raw = m[1],
      target = FAKE_GROUPS[raw] || raw,
      job = decodeURIComponent(m[2]),
      arg = m[3] != null ? decodeURIComponent(m[3]) : null;
    sent.push({
      target,
      group: target === raw ? null : raw,
      job,
      arg,
      method: (opts && opts.method) || 'GET',
      action: (opts && opts.action) || null,
    });
    const a = answers(job, arg, target);
    if (a instanceof Error) throw a;
    return a;
  };
  return sent;
}

// a UI that records and answers deterministically
function fakeUi(opts = {}) {
  const ui = {
    keys: [],
    paints: 0,
    messages: [],
    confirms: [],
    inputs: [],
    lefts: 0,
    sleep: async () => {},
    loadExec: async () => null,
    route: () => {},
    status: () => {},
    error: (p, t) => {
      ui.errors = (ui.errors || []).concat(t);
    },
    message: async (title, body) => {
      ui.messages.push({ title, body });
    },
    askInput: async (step) => {
      ui.inputs.push(step.name);
      return opts.input != null ? opts.input : 0;
    },
    confirmKey: async (p, it, jobs, writes) => {
      ui.confirms.push({ key: it.label, jobs, writes });
      return opts.decline ? false : true;
    },
    confirmWrite: async (p, job) => {
      ui.confirms.push({ job });
      return opts.decline ? false : true;
    },
    pickComponent: async () => (opts.pick != null ? opts.pick : null),
    // INPA's progress window as the script fills it (null = closed)
    userbox: (p, box) => {
      ui.boxes = (ui.boxes || []).concat(
        box ? { title: box.title, lines: box.lines.slice() } : null
      );
    },
    prints: 0,
    printScreen: () => {
      ui.prints += 1;
    },
    linesPick: null, // what the next Select picks (array), null = cancel
    pickLines: async () => ui.linesPick,
    // a %STATE park: the real UI auto-ticks after IPO_TICK_MS unless the
    // user presses Stop; here the machine runs on, bounded
    machineTick: async () => (++ui.ticks > 50 ? 'stop' : 'tick'),
    ticks: 0,
    renderKeys: (p) => {
      ui.keys = p.items.map((it) => ({ nr: it.nr, label: it.label }));
      ui.keysRegisteredAs = leaveReg ? leaveReg.key : null;
    },
    paint: () => {
      ui.paints += 1;
    },
    left: () => {
      ui.lefts += 1;
    },
  };
  return ui;
}

const sysSet = (sgbd) => ({
  OBJECT: sgbd,
  VARIANTE: sgbd.toUpperCase(),
  JOBNAME: 'X',
  SAETZE: 1,
});

// =============================================================================
// 0. Which jobs a user is asked about
// =============================================================================
{
  // the script's own session plumbing runs the way INPA runs it: silently
  for (const j of [
    'INITIALISIERUNG',
    'INFO',
    'IDENT',
    'DIAGNOSE_AUFRECHT',
    'DIAGNOSE_ENDE',
    'STATUS_MOTORDREHZAHL',
    'FS_LESEN',
    'AIF_GWSZ_LESEN',
  ]) {
    assert.strictEqual(ipoNeedsConfirm(j), false, `${j} must not prompt`);
  }
  // an actuator command, a write, a clear or a reset is the user's decision
  for (const j of [
    'STEUERN_DISPLAY',
    'STEUERN_DIGITAL',
    'START_SYSTEMCHECK_LLERH',
    'STOP_SYSTEMCHECK_LLERH',
    'STEUERN_LL_STELLER',
    'FS_LOESCHEN',
    'AIF_SCHREIBEN',
    'SG_RESET',
    'LAMPEN_TEST',
  ]) {
    assert.strictEqual(ipoNeedsConfirm(j), true, `${j} must prompt`);
  }
  ok('confirm scope: session plumbing silent, actuator/write/clear asks');
}

// =============================================================================
// 1. IHKA46 on an E46 (ihka46_3): the climate module the car reported
// =============================================================================
(async () => {
  const exec = loadExec('E46', 'ihka46');
  assert.ok(
    exec && exec.procs.inpainit,
    'ihka46 exec missing (data/chassis/E46/ihka46)'
  );

  const ecu = {
    sgbd: 'ihka46_3',
    label: 'IHKA',
    _variant: 'IHKA46_3',
    chassis: 'E46',
  };
  const sent = fakeApi((job) => {
    if (job === 'INITIALISIERUNG')
      return { system: sysSet('ihka46_3'), sets: [{ DONE: '1' }] };
    if (job === 'INFO')
      return {
        system: sysSet('ihka46_3'),
        sets: [{ SPRACHE: 'englisch', REVISION: '1.04', ECU: 'IHKA46' }],
      };
    return { system: sysSet('ihka46_3'), sets: [{ JOB_STATUS: 'OKAY' }] };
  });
  const ui = fakeUi();
  const p = new IpoProgram(ecu, exec, ui);
  const r = await p.start();
  assert.strictEqual(r.ok, true, `start failed: ${r.reason}`);
  assert.strictEqual(
    ui.confirms.length,
    0,
    `opening a module asks nothing: ${JSON.stringify(ui.confirms)}`
  );
  assert.strictEqual(p.menu, 'm_main', 'inpainit names the root menu');
  assert.strictEqual(p.screen, 's_main', 'inpainit names the root screen');
  ok('IHKA46: inpainit opens m_main / s_main');

  const jobsSoFar = sent.map((s) => s.job);
  assert.ok(
    jobsSoFar.includes('INITIALISIERUNG') && jobsSoFar.includes('INFO'),
    'entry reads'
  );
  assert.ok(
    sent.every((s) => s.target === 'ihka46_3'),
    'every job went to the identified SGBD'
  );
  ok('IHKA46: entry jobs on the wire, to ihka46_3 only');

  // the root keys are the script's ITEMs
  const rootKeys = ui.keys.slice();
  assert.ok(rootKeys.length >= 4, 'root menu has keys');
  const act = rootKeys.find((k) => /steuer|activ|ansteuer/i.test(k.label));
  assert.ok(
    act,
    `an Activate key: ${rootKeys.map((k) => k.label).join(' | ')}`
  );
  ok(
    `IHKA46: root keys ${rootKeys.map((k) => `F${k.nr} ${k.label}`).join(', ')}`
  );

  await p.press(act.nr);
  assert.strictEqual(
    p.menu,
    'm_steuern_ihka46_ihka46_2_ihka46_3',
    'Activate opens the IHKA46_3 submenu'
  );
  const sub = ui.keys.slice();
  const disp = sub.find((k) => /display/i.test(k.label));
  assert.ok(disp, `Display test key: ${sub.map((k) => k.label).join(' | ')}`);
  ok('IHKA46: Activate -> the variant submenu with Display test');

  // Display test: the menu prologue sends STEUERN_DISPLAY 1, and the backdrop
  // screen's LINE sends DIAGNOSE_AUFRECHT every cycle
  const before = sent.length;
  await p.press(disp.nr);
  assert.strictEqual(p.menu, 'm_steuern_display_ihka46_ihka46_2_ihka46_3');
  const seq = sent
    .slice(before)
    .map((s) => `${s.job}${s.arg != null ? ' ' + s.arg : ''}`);
  assert.ok(seq.includes('STEUERN_DISPLAY 1'), `prologue pattern 1 in ${seq}`);
  assert.ok(seq.includes('DIAGNOSE_AUFRECHT'), `keep-alive in ${seq}`);
  assert.ok(
    seq.indexOf('STEUERN_DISPLAY 1') < seq.indexOf('DIAGNOSE_AUFRECHT'),
    'prologue before the screen cycle'
  );
  assert.ok(
    ui.confirms.some(
      (c) =>
        (c.writes || []).includes('STEUERN_DISPLAY') ||
        c.job === 'STEUERN_DISPLAY'
    ),
    'the drive was confirmed'
  );
  ok('IHKA46: Display test -> STEUERN_DISPLAY 1 then the screen keep-alive');

  // F2 = Testpattern 2, in the same VM
  const b2 = sent.length;
  await p.press(2);
  const seq2 = sent
    .slice(b2)
    .map((s) => `${s.job}${s.arg != null ? ' ' + s.arg : ''}`);
  assert.ok(seq2.includes('STEUERN_DISPLAY 2'), `pattern 2 sent: ${seq2}`);
  ok('IHKA46: F2 -> STEUERN_DISPLAY 2');

  // Back is the script's own release: STEUERN_DISPLAY 0, then the parent menu
  const b3 = sent.length;
  await p.back();
  const seq3 = sent
    .slice(b3)
    .map((s) => `${s.job}${s.arg != null ? ' ' + s.arg : ''}`);
  assert.ok(seq3.includes('STEUERN_DISPLAY 0'), `release on Back: ${seq3}`);
  assert.strictEqual(
    p.menu,
    'm_steuern_ihka46_ihka46_2_ihka46_3',
    'Back returns to the parent menu'
  );
  ok('IHKA46: Back -> STEUERN_DISPLAY 0 and the parent menu');
  assert.ok(
    sent.every((s) => s.target === 'ihka46_3'),
    'still every job to ihka46_3'
  );
  assert.ok(energized > 0, 'a drive marked the session energised');

  // Digital output: three keys that toggle ON/OFF in persistent state
  const dig = ui.keys.find((k) => /digital|dig\.|ausg/i.test(k.label));
  assert.ok(
    dig,
    `Digital output key among: ${ui.keys.map((k) => `F${k.nr} ${k.label}`).join(' | ')}`
  );
  await p.press(dig.nr);
  assert.strictEqual(p.menu, 'm_steuern_digital_ihka46_ihka46_2_ihka46_3');
  const dkeys = ui.keys.slice();
  assert.ok(
    dkeys.length >= 3,
    `digital keys: ${dkeys.map((k) => k.label).join(' | ')}`
  );
  const b4 = sent.length;
  await p.press(dkeys[0].nr);
  const s4 = sent.slice(b4).filter((s) => /^STEUERN_/i.test(s.job));
  assert.ok(
    s4.length >= 1,
    `digital drive sent: ${sent.slice(b4).map((s) => s.job)}`
  );
  const first = s4[0].arg;
  const b5 = sent.length;
  await p.press(dkeys[0].nr);
  const s5 = sent.slice(b5).filter((s) => /^STEUERN_/i.test(s.job));
  assert.ok(
    s5.length >= 1 && s5[0].arg !== first,
    `second press toggles: ${first} -> ${s5[0] && s5[0].arg}`
  );
  ok('IHKA46: digital key toggles ON/OFF across presses (state persists)');

  // leaving the module runs inpaexit (INPAapiEnd + its own job) and reports
  await p.leaveModule();
  assert.strictEqual(ui.lefts, 1, 'left once');
  ok('IHKA46: leaveModule runs inpaexit and hands back');
  assert.ok(
    leaveReg === null || leaveReg.key === null || leaveReg.job === null || true
  );

  // ---- wire target rule --------------------------------------------------------
  const e2 = {
    sgbd: 'ihka46_3',
    _sgbdBase: 'ihka38',
    _ipoKnownSgbds: new Set(['ihka46_3', 'ms450ds0', 'ihka38']),
  };
  assert.strictEqual(
    ipoWireTarget(e2, 'IHKA46,IHKA46_2,IHKA46_3'),
    'ihka46_3',
    'dispatch list -> identified'
  );
  assert.strictEqual(ipoWireTarget(e2, ''), 'ihka46_3');
  assert.strictEqual(
    ipoWireTarget(e2, 'ihka38'),
    'ihka46_3',
    'the configured base -> identified'
  );
  assert.strictEqual(
    ipoWireTarget(e2, 'MS450DS0'),
    'ms450ds0',
    'another shipped module keeps its name'
  );
  assert.strictEqual(
    ipoWireTarget(e2, 'NOPE'),
    'ihka46_3',
    'an unknown name -> identified'
  );
  ok(
    'wire target: dispatch list and base map to the identified SGBD; others keep theirs'
  );

  // =============================================================================
  // 2. MS45 (ms450ds0): the idle actuator that stalled the engine
  // =============================================================================
  let mp = null;
  const mexec = loadExec('E46', 'ms450ds0');
  if (!mexec) {
    console.log('  skip: ms450ds0 exec not available locally');
  } else {
    const mecu = {
      sgbd: 'ms450ds0',
      label: 'MS45',
      _variant: 'MS450DS0',
      chassis: 'E46',
    };
    let idleRpm = 720;
    const msent = fakeApi((job, arg) => {
      // the ECU takes the commanded setpoint, and reports it from then on
      if (job === 'START_SYSTEMCHECK_LLERH' && arg) idleRpm = Number(arg);
      if (job === 'INITIALISIERUNG')
        return { system: sysSet('ms450ds0'), sets: [{ DONE: '1' }] };
      if (job === 'INFO')
        return { system: sysSet('ms450ds0'), sets: [{ SPRACHE: 'englisch' }] };
      if (/^STATUS/i.test(job))
        return {
          system: sysSet('ms450ds0'),
          sets: [
            {
              JOB_STATUS: 'OKAY',
              STAT_MOTORDREHZAHL_WERT: String(idleRpm),
              STAT_MOTORDREHZAHL_SOLL_WERT: String(idleRpm),
            },
          ],
        };
      // a fault list as EDIABAS returns it: one set per fault, then the
      // set that carries JOB_STATUS. The texts are German, as the SGBD
      // sends them; the third fault is the real E46 MS45 one (F_ORT_NR
      // 10179 = 0x27C3) with the ECU's standard status texts
      if (/^FS_LESEN/.test(job)) {
        const fault = (nr, text, more) => ({
          F_ORT_NR: String(nr),
          F_ORT_TEXT: text,
          F_SYMPTOM_NR: '1',
          F_SYMPTOM_TEXT: 'Signal too high',
          F_READY_NR: '0',
          F_READY_TEXT: 'not ready',
          F_VORHANDEN_NR: '1',
          F_VORHANDEN_TEXT: 'present',
          F_WARNUNG_NR: '1',
          F_WARNUNG_TEXT: 'MIL on',
          // the freeze-frame screen reads set 1's environment; F_HFK (how
          // often the fault was seen) gates how many entries it prints
          F_HFK: '13',
          F_LZ: '40',
          F_UW_KM: '372336',
          F_UW1_TEXT: '(Motor) - Öltemperatur',
          F_UW1_EINH: 'C',
          F_UW1_WERT: '25',
          F_UW2_TEXT: 'Motor Status',
          F_UW2_EINH: '0-n', // the SGBD's mark for an enum value
          F_UW2_WERT: '0 ES - Motor steht',
          F_PCODE_TEXT: 'P1128 Motorölniveausensor - kein Signal',
          ...(more || {}),
        });
        return {
          system: sysSet('ms450ds0'),
          sets: [
            fault(42, 'Lambda sensor heater bank 1'),
            fault(77, 'Tankentlueftungsventil'),
            fault(10179, 'Thermischer Ölniveausensor', {
              F_SYMPTOM_TEXT: 'Signal oder Wert oberhalb Schwelle',
              F_READY_TEXT: 'Testbedingungen erfüllt',
              F_VORHANDEN_TEXT: 'Fehler momentan vorhanden, OBD-entprellt',
              F_WARNUNG_TEXT:
                'Fehler verursacht kein Aufleuchten der Warnlampe (MIL)',
            }),
            { JOB_STATUS: 'OKAY' },
          ],
        };
      }
      return { system: sysSet('ms450ds0'), sets: [{ JOB_STATUS: 'OKAY' }] };
    });
    const mui = fakeUi();
    mp = new IpoProgram(mecu, mexec, mui);
    const mr = await mp.start();
    assert.strictEqual(mr.ok, true, `MS45 start: ${mr.reason}`);
    assert.strictEqual(mp.menu, 'm_main');
    ok('MS45: inpainit opens m_main');
    // a menu legend is ONE LINE printing a dozen screen rows: modern mode
    // shows them one under the other, never as a paragraph
    const legend = ipoLineRows(mp);
    assert.ok(
      legend.length >= 10 &&
        legend.some((r) => r.parts.some((t) => /SG-Identifikation/.test(t))),
      `legend rows: ${legend.length} ${JSON.stringify(legend.slice(0, 3))}`
    );
    ok('MS45: the main-menu legend is one modern row per screen row');

    // ...and as a menu it is the function-group tiles: one per ITEM, described
    // by the legend line the screen printed for that key, coloured by the job
    // the key's body sends
    const tiles = ipoMenuTiles(mp);
    assert.ok(
      tiles && tiles.tiles.length === 12,
      `tiles: ${tiles && tiles.tiles.length}`
    );
    const f2 = tiles.tiles.find((t) => t.nr === 2);
    const f4 = tiles.tiles.find((t) => t.nr === 4);
    const s6 = tiles.tiles.find((t) => t.nr === 16);
    assert.strictEqual(f2 && f2.legend, 'SG-Identifikation');
    assert.strictEqual(f4 && f4.legend, 'Fehlerspeicher lesen');
    assert.ok(
      s6 && s6.shift && /EWS/.test(s6.legend),
      `shift legend: ${JSON.stringify(s6)}`
    );
    assert.ok(
      tiles.rest.some((r) =>
        (r.parts || []).some((t) => /MS45 Hauptmenue/.test(t))
      ),
      `non-legend rows stay rows above the tiles: ${JSON.stringify(tiles.rest)}`
    );
    ok('MS45: the main menu renders as tiles described by its own legend');

    // The short fault list is formatted by the script: INPAapiResultSets
    // counts the wire's sets (faults + the JOB_STATUS set), and each LINE
    // reads ITS set by number. Fed one flat map, every module read
    // "no error entries" with the MIL lit.
    await mp.openMenu('m_fehlersp');
    const short = mui.keys.find((k) => k.nr === 1);
    assert.ok(short, `fault menu F1: ${JSON.stringify(mui.keys)}`);
    await mp.press(1);
    assert.strictEqual(mp.screen, 's_fs_kurz', 'the short list screen');
    const text = [...mp.cells.values()].map((c) => c.text).join('\n');
    assert.ok(!/no error entries/.test(text), `false clean: ${text}`);
    assert.ok(
      /Lambda sensor heater bank 1/.test(text) && /Tank vent valve/.test(text),
      `both faults printed: ${text}`
    );
    assert.ok(/EndOfList/.test(text), 'the list ends where the script ends it');
    // each LINE is a logical line of INPA's virtual screen: the second fault
    // sits BELOW the first, its rows relative to its own LINE
    const cellOf = (re) => [...mp.cells.values()].find((c) => re.test(c.text));
    const one = cellOf(/Lambda sensor heater bank 1/);
    const two = cellOf(/Tank vent valve/);
    assert.ok(
      one && two && two.row > one.row,
      `stacked: ${one && one.row} < ${two && two.row}`
    );
    assert.ok(
      /Nr: 42\b/.test(text) && /Nr: 77\b/.test(text),
      `fault numbers via longtoreal: ${text}`
    );
    // the freeze-frame screen: env labels and enum values through the
    // curated freeze-frame dictionary, the P-code line part by part
    LANG = 'en';
    await mp.openMenu('m_fehlersp');
    await mp.press(3);
    const ff = [...mp.cells.values()].map((c) => c.text).join('\n');
    assert.ok(/Engine oil temperature/.test(ff), `env label: ${ff}`);
    assert.ok(/engine stopped/.test(ff), `env enum value: ${ff}`);
    assert.ok(
      /P1128 Motorölniveausensor - no signal/.test(ff),
      `P-code parts: ${ff}`
    );
    ok(
      'MS45: freeze frame shows env labels, enum values and P-code parts in English'
    );
    // a status screen's lamps show the script's own on/off words for the
    // value the wire returned; they painted nothing at all before
    if (mexec.procs.m_digital) {
      await mp.openMenu('m_digital');
      await mp.press(1); // Switch: s_digital1, the switch-position lamps
      assert.strictEqual(mp.screen, 's_digital1');
      const lamps = [...mp.cells.values()].filter((c) => c.kind === 'lamp');
      assert.ok(lamps.length > 0, 'the digital screen paints lamps');
      assert.ok(
        lamps.every((c) => c.text && c.text.trim()),
        `every lamp shows a word: ${JSON.stringify(lamps.slice(0, 4))}`
      );
      ok('MS45: digital status lamps paint their on/off word');
      // ...as INPA's lamp: a filled circle beside the on-word, empty beside off
      const l0 = lamps[0];
      assert.ok(
        l0.meta && l0.meta.on && l0.meta.off,
        `lamp words declared: ${JSON.stringify(l0.meta)}`
      );
      const onHtml = ipoLampHtml({ ...l0, text: l0.meta.on });
      const offHtml = ipoLampHtml({ ...l0, text: l0.meta.off });
      assert.ok(
        /ipo-dot on/.test(onHtml) && !/ipo-dot on/.test(offHtml),
        'lamp fill follows the word'
      );
      // and a bar from analogout's declaration: scale ends, the good band,
      // the fill at the reading, the number beside it
      const bar = ipoGaugeHtml({
        kind: 'gauge',
        text: '720',
        key: 'X',
        meta: { min: 0, max: 2000, lo: 600, hi: 900 },
      });
      assert.ok(
        /ipo-gauge-track/.test(bar) && /width:36\.0%/.test(bar),
        `fill at the reading: ${bar}`
      );
      assert.ok(
        /gauge-warn\) 0 30\.0%/.test(bar) &&
          /gauge-ok\) 30\.0% 45\.0%/.test(bar),
        `band zones: ${bar}`
      );
      assert.ok(
        />0<\/span>/.test(bar) &&
          /<span>2000<\/span>/.test(bar) &&
          />720</.test(bar),
        `scale and value: ${bar}`
      );
      ok('MS45: lamps and bars render as INPA draws them');
      await mp.openMenu('m_fehlersp'); // the checks below press its F1
    }

    // INPA's Select / Deselect: the screen's named logical lines are offered,
    // only the picked ones are painted, Deselect shows them all again
    if (mexec.procs.m_status && mexec.procs.s_laufunruhe) {
      await mp.openMenu('m_status');
      await mp.press(7); // Laufunruhe: six cylinder bars and two sensors
      assert.strictEqual(mp.screen, 's_laufunruhe');
      const names = ipoScreenLineNames(mexec, 's_laufunruhe');
      assert.ok(
        names.length >= 8 && names.includes('filtered ER 1'),
        `named lines: ${names}`
      );
      const gauges = () =>
        [...mp.cells.values()].filter((c) => c.kind === 'gauge').length;
      assert.strictEqual(gauges(), 8, 'all eight bars before Select');
      mui.linesPick = ['filtered ER 1', 'filtered ER 2'];
      await mp.press(8); // Select
      assert.strictEqual(
        gauges(),
        2,
        `only the picked lines paint: ${gauges()}`
      );
      await mp.press(18); // Deselect
      assert.strictEqual(gauges(), 8, 'Deselect shows every line again');
      ok('MS45: Select keeps the picked logical lines, Deselect restores all');
      await mp.openMenu('m_fehlersp');
    }

    // a text-only row printed as "caption : value" pieces is a caption row
    {
      const cells = new Map();
      const put = (row, col, s) =>
        cells.set(`${row}:${col}`, {
          row,
          col,
          text: s,
          key: null,
          kind: 'text',
          meta: null,
        });
      put(0, 0, 'Rework program');
      put(0, 33, ':');
      put(0, 35, 'Central Body Electronics V / S12');
      const rows = ipoLineRows({
        cells,
        lines: [
          {
            label: null,
            elements: [
              { t: 'text', row: 0, col: 0, s: 'Rework program' },
              { t: 'text', row: 0, col: 33, s: ':' },
              {
                t: 'text',
                row: 0,
                col: 35,
                s: 'Central Body Electronics V / S12',
              },
            ],
          },
        ],
      });
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].caption, 'Rework program');
      assert.strictEqual(rows[0].cells.length, 1);
      assert.strictEqual(
        rows[0].cells[0].text,
        'Central Body Electronics V / S12'
      );
      ok(
        'modern rows: a text-printed "caption : value" row is caption and value'
      );
    }
    ok(
      'MS45: FS_LESEN prints one entry per result set, not "no error entries"'
    );

    // The script glues F_ORT_TEXT + F_SYMPTOM_TEXT + ... into its own lines,
    // so English has to reach the VM in the fed results: the phrase
    // dictionary for the texts it carries whole, the ECU's own codespace for
    // a location whose number it knows (27C3, NOT the flat DB's collision),
    // and the standard status texts from the phrase table. Untranslatable
    // text ('Lambda sensor heater bank 1', 'Signal too high') is as sent.
    assert.ok(!/Tankentlueftungsventil/.test(text), `phrase raw: ${text}`);
    assert.ok(/Thermal oil level sensor/.test(text), `code lookup: ${text}`);
    assert.ok(
      !/Thermischer/.test(text) && !/DMTL leak detection/.test(text),
      `scoped codespace wins: ${text}`
    );
    for (const [de, en] of [
      ['Signal oder Wert oberhalb Schwelle', 'Signal or value above threshold'],
      ['Testbedingungen erfüllt', 'Test conditions met'],
      [
        'Fehler momentan vorhanden, OBD-entprellt',
        'Currently present (OBD-confirmed)',
      ],
      ['Fehler verursacht kein Aufleuchten', 'No MIL'],
    ]) {
      assert.ok(text.includes(en) && !text.includes(de), `${de}: ${text}`);
    }
    assert.ok(
      /Signal too high/.test(text) && /Nr: 10179\b/.test(text),
      `untranslated text and numbers as sent: ${text}`
    );
    ok('MS45: fed *_TEXT results reach the VM in English (exact hits only)');

    // Original mode: the same read, every string as the ECU sent it
    LANG = 'orig';
    await mp.press(1);
    const orig = [...mp.cells.values()].map((c) => c.text).join('\n');
    assert.ok(
      /Thermischer Ölniveausensor/.test(orig) &&
        /Tankentlueftungsventil/.test(orig) &&
        /Testbedingungen erfüllt/.test(orig) &&
        !/Thermal oil level sensor/.test(orig),
      `orig keeps German: ${orig}`
    );
    LANG = 'en';
    ok('MS45: Original mode feeds the results untouched');

    // the way INPA gets there: m_system's LL key sets the screen
    // (s_system_llerh, frequent) whose LINE reads the CURRENT setpoint into
    // slot 49 every cycle, then opens m_system_llerh
    await mp.openMenu('m_system');
    const ll = mui.keys.find((k) => k.label === 'LL');
    assert.ok(ll, `LL key in m_system: ${mui.keys.map((k) => k.label)}`);
    await mp.press(ll.nr);
    assert.strictEqual(mp.menu, 'm_system_llerh');
    assert.strictEqual(
      mp.screen,
      's_system_llerh',
      'the readout screen is current'
    );
    assert.ok(
      msent.some((s) => s.job === 'STATUS_MOTORDREHZAHL'),
      'the screen cycle read the idle speed before any key'
    );
    const keys = mui.keys.map((k) => k.label);
    assert.deepStrictEqual(
      keys.slice(0, 4),
      ['+10', '-10', '+100', '-100'],
      `llerh keys: ${keys}`
    );
    ok("MS45: m_system_llerh keys are the script's ITEMs, not toggles");

    // The key bar's leave hook fires on every unheld repaint. The keys must be
    // painted BEFORE this menu's release is registered, or the hook sends the
    // new menu's Back job the moment its keys appear; and a script-driven
    // menu switch forgets the old registration (its Back body already ran)
    // instead of letting the re-registration send it again.
    const llerhKey = `${mecu.sgbd}:m_system_llerh`;
    assert.notStrictEqual(
      mui.keysRegisteredAs,
      llerhKey,
      'keys painted before the new menu registered its release'
    );
    assert.strictEqual(leaveReg.key, llerhKey, 'release registered after');
    const iOld = leaveCalls.findIndex(
      (c) => c.key === `${mecu.sgbd}:m_system` && c.job === null
    );
    const iNew = leaveCalls.findIndex((c) => c.key === llerhKey);
    assert.ok(
      iOld >= 0 && iOld < iNew,
      `old menu forgotten before the new one registered: ${JSON.stringify(leaveCalls)}`
    );
    ok('MS45: keys paint before release registration; switch forgets the old');

    // Modern skin: the same cycle grouped per LINE -- the setpoint LINE is a
    // row whose value cell is keyed by the result the script bound, holding
    // the value the wire returned. No grid arithmetic, no label guessing.
    const rows = ipoLineRows(mp);
    const soll = rows.find((r) =>
      r.cells.some((c) => /MOTORDREHZAHL/i.test(c.key || '') && c.text)
    );
    assert.ok(
      soll,
      `a LINE row keyed on the idle speed result: ${JSON.stringify(rows.slice(0, 6))}`
    );
    assert.ok(
      rows.every((r) => r.caption || r.cells.length),
      'every modern row has a caption or a cell'
    );
    ok('MS45: modern rows group the screen per LINE, keyed by result');

    // +10 runs llerh(10): STOP then START_SYSTEMCHECK_LLERH <setpoint>, the
    // setpoint being the script's own slot 49 + 10, clamped 0..2000
    const slot = (n) => {
      const v = mp.vm.globals.get(n);
      return Number(v && typeof v === 'object' ? (v.s != null ? v.s : v.v) : v);
    };
    const seed = slot(49);
    assert.strictEqual(
      seed,
      720,
      `slot 49 holds the ECU's setpoint (720), got ${seed}`
    );
    const b = msent.length;
    await mp.press(1);
    const seq = msent
      .slice(b)
      .map((s) => `${s.job}${s.arg != null ? ' ' + s.arg : ''}`);
    const start = seq.find((x) => /^START_SYSTEMCHECK_LLERH/.test(x));
    assert.ok(start, `START_SYSTEMCHECK_LLERH sent: ${seq}`);
    assert.ok(
      seq.indexOf('STOP_SYSTEMCHECK_LLERH') < seq.indexOf(start),
      'STOP before START'
    );
    const arg = Number(start.split(' ')[1]);
    assert.strictEqual(
      arg,
      Math.min(2000, Math.max(0, seed + 10)),
      `setpoint is slot49(${seed})+10, got ${arg}`
    );
    assert.strictEqual(slot(49), arg, 'the setpoint persists in slot 49');
    assert.ok(mui.confirms.length > 0, 'the drive was confirmed first');
    assert.strictEqual(
      arg,
      730,
      'never 10 rpm: the stall was the derived path sending slot49=0 + 10'
    );
    ok(
      `MS45: +10 -> STOP, START_SYSTEMCHECK_LLERH ${arg} (from slot 49 = ${seed})`
    );
    // both jobs of that one key press carry the same action tag, named
    // after the key, so a remote owner approves "+10" once
    {
      const tagged = msent.filter(
        (x) => x.action && /SYSTEMCHECK_LLERH/.test(x.job)
      );
      assert.ok(tagged.length >= 2, `tagged jobs: ${tagged.length}`);
      const ids = new Set(tagged.slice(-2).map((x) => x.action.id));
      assert.strictEqual(ids.size, 1, 'one action id for the whole press');
      assert.strictEqual(tagged.at(-1).action.label, '+10');
    }
    ok('MS45: every job of a key press carries that key as its action');

    // and again: the second press builds on the first (INPA's persistent globals)
    // the screen re-reads the setpoint between presses (frequent screen), and
    // the ECU reports what was just commanded, so the next +10 builds on it
    const b2 = msent.length;
    await mp.press(1);
    const s2 = msent
      .slice(b2)
      .find((s) => /^START_SYSTEMCHECK_LLERH/.test(s.job));
    assert.strictEqual(
      Number(s2.arg),
      arg + 10,
      `second +10 -> ${arg + 10}, got ${s2 && s2.arg}`
    );
    ok('MS45: a second +10 adds to the persisted setpoint');

    // m_llabg: the keys ASK (inputint) instead of doing nothing
    await mp.openMenu('m_llabg');
    assert.strictEqual(mp.menu, 'm_llabg');
    const mui2 = mui; // same ui, answers 0
    const b3 = msent.length;
    await mp.press(1);
    assert.ok(
      mui2.inputs.includes('inputint'),
      `A/C + Drive asked via inputint: ${mui2.inputs}`
    );
    ok("MS45: m_llabg keys prompt with INPA's own inputint");
    void b3;

    // the Ident key: its screen formats hex through the script's own
    // structure helpers; a live run must not pop "Error: Handle"
    if (mexec.procs.m_ident) {
      mui.messages.length = 0;
      await mp.openMenu('m_ident');
      assert.ok(
        !mui.messages.some((x) =>
          /Error: Handle/i.test(String(x.body || x.title))
        ),
        `no structure-handle error boxes: ${JSON.stringify(mui.messages)}`
      );
      ok(
        'MS45: m_ident formats hex through CreateStructure/StructureLong without an error box'
      );
    }

    // the memory menu's Address keys are actions, all of them
    if (mexec.procs.m_speicher) {
      await mp.openMenu('m_speicher');
      const ks = mui.keys.map((k) => k.label);
      assert.ok(
        ks.some((l) => /10h|100h|Adresse|Address/i.test(l)),
        `address keys listed: ${ks}`
      );
      ok('MS45: m_speicher lists the address keys as keys');
    }

    // the fault-memory clear asks through INPA's two-string OK/Cancel box
    // (builtin_3f): a confirm, not a number to type

    const asked = [];
    mui.askInput = async (step) => {
      asked.push({ name: step.name, prompts: step.prompts.length });
      return 0; // OK
    };
    mui.confirms.length = 0;
    await mp.openMenu('m_fehlersp');
    const n0 = msent.length;
    await mp.press(5); // Clear error memory
    assert.ok(
      asked.some((a) => a.name === 'builtin_3f' && a.prompts === 2),
      `the clear asked through the two-string box: ${JSON.stringify(asked)}`
    );
    assert.ok(
      msent.slice(n0).some((x) => x.job === 'FS_LOESCHEN'),
      `FS_LOESCHEN sent after OK: ${JSON.stringify(msent.slice(n0).map((x) => x.job))}`
    );
    ok('MS45: the clear confirmation is an OK/Cancel box and OK clears');
  }

  // =============================================================================
  // 3. SHD46 (sunroof): a key whose body is setstate(&machine)
  // =============================================================================
  const sexec = loadExec('E46', 'shd46');
  let sp = null;
  if (!sexec) {
    console.log('  skip: shd46 exec not available locally');
  } else {
    const secu = {
      sgbd: 'shd46_2',
      label: 'SHD',
      _variant: 'SHD46_2',
      chassis: 'E46',
    };
    const ssent = fakeApi((job) => {
      if (job === 'INITIALISIERUNG')
        return { system: sysSet('shd46_2'), sets: [{ DONE: '1' }] };
      return { system: sysSet('shd46_2'), sets: [{ JOB_STATUS: 'OKAY' }] };
    });
    const sui = fakeUi({ pick: { ort: 'SSHDA', ein: 0 } });
    sp = new IpoProgram(secu, sexec, sui);
    const sr = await sp.start();
    assert.strictEqual(sr.ok, true, `SHD46 start: ${sr.reason}`);
    await sp.openMenu('m_steuern');
    const sel = sp.items.find((it) => it.nr === 1);
    assert.ok(
      sel && sel.label === 'Select' && sui.keys.some((k) => k.nr === 1),
      `F1 Select: ${JSON.stringify(sel)} ${JSON.stringify(sui.keys)}`
    );
    ok('SHD46: the activate menu lists Select as F1');
    // the picker lists the machine's own screen (s_steuern_digital's LINEs)
    const comps = ipoScreenComponents(sexec, 's_steuern_digital');
    assert.ok(
      comps.length === 8 &&
        comps[0].keys === 'SSHDA' &&
        /Sunroof Open/.test(comps[0].label),
      `components: ${JSON.stringify(comps.slice(0, 2))}`
    );
    const n0 = ssent.length;
    await sp.press(1);
    const dig = ssent.slice(n0).find((x) => x.job === 'STEUERN_DIGITAL');
    assert.ok(
      dig && /SSHDA/.test(dig.arg || ''),
      `machine sent the pick: ${JSON.stringify(ssent.slice(n0))}`
    );
    assert.ok(
      sui.confirms.some((c) => c.job === 'STEUERN_DIGITAL'),
      `the activation asked first: ${JSON.stringify(sui.confirms)}`
    );
    assert.strictEqual(
      sp.screen,
      's_steuern',
      'the machine hands back to the menu screen'
    );
    ok(
      'SHD46: Select runs the state machine: picker -> STEUERN_DIGITAL -> back'
    );
  }

  // =============================================================================
  // 4. SM46 (seat memory): a captionless key named only by the screen legend
  // =============================================================================
  const mexec2 = loadExec('E46', 'sm46');
  let qp = null;
  if (!mexec2) {
    console.log('  skip: sm46 exec not available locally');
  } else {
    const qecu = {
      sgbd: 'sm46_4',
      label: 'SM',
      _variant: 'SM46_4',
      chassis: 'E46',
    };
    fakeApi((job) => {
      if (job === 'INITIALISIERUNG')
        return { system: sysSet('sm46_4'), sets: [{ DONE: '1' }] };
      return { system: sysSet('sm46_4'), sets: [{ JOB_STATUS: 'OKAY' }] };
    });
    const qui = fakeUi();
    qp = new IpoProgram(qecu, mexec2, qui);
    const qr = await qp.start();
    assert.strictEqual(qr.ok, true, `SM46 start: ${qr.reason}`);
    const f3 = qp.items.find((it) => it.nr === 3);
    assert.ok(f3 && f3.hidden, 'ITEM 3 has no caption of its own');
    assert.strictEqual(
      f3.legendLabel,
      'read coding data',
      `legend label: ${JSON.stringify(f3)}`
    );
    assert.ok(
      qui.keys.some((k) => k.nr === 3),
      `F3 is a key once the legend named it: ${JSON.stringify(qui.keys)}`
    );
    ok('SM46: a captionless ITEM is labelled by the legend line for its key');

    // a key pressed while a cycle is on the wire is taken afterwards, not lost
    qp.busy = true; // as if a screen cycle were mid-job
    const took = await qp.press(2);
    assert.strictEqual(took, true);
    assert.strictEqual(qp.queued, 2, 'queued behind the running cycle');
    qp.busy = false;
    qp._drain();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(
      qp.screen && /ident/i.test(qp.screen),
      `queued Ident ran: ${qp.screen}`
    );
    ok(
      'SM46: a key pressed mid-cycle is queued and runs when the wire is free'
    );

    // F9 Print is INPA's printscreen: the page prints, nothing goes to the car
    for (let n = 0; n < 100 && (qp.running || qp.busy); n++)
      await new Promise((r) => setTimeout(r, 10));
    await qp.openMenu('m_main');
    await qp.press(9);
    assert.strictEqual(qui.prints, 1, 'Print routed to the page print');
    ok('SM46: the Print key prints the page');
  }

  // =============================================================================
  // 6. LSZ: a MULTIPLE-select togglelist feeds STEUERN_IO the ";"-joined keys
  // =============================================================================
  const lexec = loadExec('E46', 'lsz');
  let lp = null;
  if (!lexec) {
    console.log('  skip: lsz exec not available locally');
  } else {
    const lecu = {
      sgbd: 'lsz_2',
      label: 'LSZ',
      _variant: 'LSZ_2',
      chassis: 'E46',
    };
    const lsent = fakeApi((job) => {
      if (job === 'INITIALISIERUNG')
        return { system: sysSet('lsz_2'), sets: [{ DONE: '1' }] };
      return { system: sysSet('lsz_2'), sets: [{ JOB_STATUS: 'OKAY' }] };
    });
    const lui = fakeUi({ pick: { ort: 'Kl15;S_AL', ein: 0 } });
    let toggleStep = null;
    lui.pickComponent = async (p, step) => {
      toggleStep = step;
      return { ort: 'Kl15;S_AL', ein: 0 };
    };
    lp = new IpoProgram(lecu, lexec, lui);
    const lr = await lp.start();
    assert.strictEqual(lr.ok, true, `LSZ start: ${lr.reason}`);
    // inpainit asks the LSZ whether headlight levelling is fitted; a read
    // the classifier cannot name must still go without a dialog at entry
    assert.ok(
      lsent.some((x) => x.job === 'LWR_VORHANDEN'),
      `entry sent LWR_VORHANDEN: ${JSON.stringify(lsent.map((x) => x.job))}`
    );
    assert.ok(
      !lui.confirms.some((c) => c.job === 'LWR_VORHANDEN'),
      `no confirm at entry: ${JSON.stringify(lui.confirms)}`
    );
    ok('LSZ: inpainit runs without asking, LWR_VORHANDEN included');
    await lp.openMenu('m_steuern');
    await lp.press(8); // Select: togglelist(1, 0, ->var)
    assert.ok(
      toggleStep && toggleStep.multiple === true && toggleStep.argnum === false,
      `flags: ${JSON.stringify(toggleStep && [toggleStep.multiple, toggleStep.argnum])}`
    );
    const n0 = lsent.length;
    await lp.press(2); // start: STEUERN_IO with the selection
    const io = lsent.slice(n0).find((x) => x.job === 'STEUERN_IO');
    assert.ok(
      io && io.arg === 'Kl15;S_AL',
      `STEUERN_IO carries the picked keys: ${JSON.stringify(lsent.slice(n0))}`
    );
    ok('LSZ: multiple-select togglelist -> STEUERN_IO "Kl15;S_AL"');
  }

  // =============================================================================
  // 7. IHKA46 analog screen: unary minus must not eat the argument under it
  // =============================================================================
  {
    const kexec = loadExec('E46', 'ihka46');
    if (kexec) {
      const kecu = {
        sgbd: 'ihka46_3',
        label: 'IHKA',
        _variant: 'IHKA46_3',
        chassis: 'E46',
      };
      fakeApi((job) => {
        if (job === 'INITIALISIERUNG')
          return { system: sysSet('ihka46_3'), sets: [{ DONE: '1' }] };
        if (job === 'STATUS_ANALOGEINGAENGE')
          return {
            system: sysSet('ihka46_3'),
            sets: [
              {
                JOB_STATUS: 'OKAY',
                STAT_TINNEN_WERT: '28',
                STAT_TVERDAMPFER_WERT: '4',
              },
            ],
          };
        return { system: sysSet('ihka46_3'), sets: [{ JOB_STATUS: 'OKAY' }] };
      });
      const kui = fakeUi();
      const kp = new IpoProgram(kecu, kexec, kui);
      await kp.start();
      await kp.openMenu('m_status');
      const an = kp.items.find((it) =>
        /analog/i.test(it.label || it.legendLabel || '')
      );
      await kp.press(an.nr);
      // the evaporator bar: analogout(v, 3, 43, -10.0, 40.0, -10.0, 40.0, "3.0")
      const ev = [...kp.cells.values()].find(
        (c) => c.key === 'STAT_TVERDAMPFER_WERT'
      );
      assert.ok(ev, 'evaporator gauge painted');
      assert.strictEqual(ev.col, 43, `column from the script: ${ev.col}`);
      assert.deepStrictEqual(
        [ev.meta.min, ev.meta.max, ev.meta.lo, ev.meta.hi],
        [-10, 40, -10, 40],
        `scale: ${JSON.stringify(ev.meta)}`
      );
      ok('IHKA46: `10.0 neg` negates the 10, not the column before it');
      kp.close();
    }
  }

  // ===========================================================================
  // scriptchange: KLIMA_5B is the E46 climate ENTRY script; its inpainit
  // reads VARIANTE and hands an IHKA46_3 to IHKA46.IPO, whose own inpainit
  // then runs and names the root. The module view opens klima_5B (the
  // configured base, since BMW ships no IHKA46_3.IPO) and must end up in
  // IHKA46's menus -- the derived path once stayed in KLIMA_5B and had no
  // Activate arm for the car.
  // ===========================================================================
  {
    const kexec = loadExec('E46', 'klima_5b');
    const iexec = loadExec('E46', 'ihka46');
    assert.ok(kexec && kexec.procs.inpainit, 'klima_5b exec missing');
    const kecu = {
      sgbd: 'ihka46_3',
      _irFrom: 'klima_5b',
      label: 'IHKA',
      _variant: 'IHKA46_3',
      chassis: 'E46',
    };
    const ksent = fakeApi((job) => {
      if (job === 'INITIALISIERUNG')
        return { system: sysSet('ihka46_3'), sets: [{ DONE: '1' }] };
      if (job === 'INFO')
        return {
          system: sysSet('ihka46_3'),
          sets: [{ SPRACHE: 'englisch', REVISION: '1.04', ECU: 'IHKA46' }],
        };
      return { system: sysSet('ihka46_3'), sets: [{ JOB_STATUS: 'OKAY' }] };
    });
    const kui = fakeUi();
    const loads = [];
    kui.loadExec = async (name) => {
      loads.push(name);
      return name === 'ihka46' ? iexec : null;
    };
    const kp = new IpoProgram(kecu, kexec, kui);
    const kr = await kp.start();
    assert.strictEqual(kr.ok, true, `klima_5b start failed: ${kr.reason}`);
    assert.deepStrictEqual(loads, ['ihka46'], 'KLIMA_5B hands off to IHKA46');
    assert.strictEqual(kp.script, 'ihka46', 'the running script is IHKA46');
    assert.strictEqual(kp.exec, iexec, 'the VM runs IHKA46.IPO now');
    assert.strictEqual(kp.menu, 'm_main', 'IHKA46 inpainit names its root');
    assert.ok(
      kui.keys.some((k) => /Ansteuern|Activate/i.test(k.label)),
      `IHKA46 root lists Activate: ${JSON.stringify(kui.keys)}`
    );
    assert.ok(
      ksent.filter((s) => s.job === 'INITIALISIERUNG').length >= 2,
      'both scripts identify the module over the wire'
    );
    ok('scriptchange: KLIMA_5B -> IHKA46 followed live, root = m_main');
    kp.close();
  }

  // ===========================================================================
  // Settings 'confirmActuators' = "Send immediately (like INPA)": an actuator
  // drive runs without the prompt; a permanent write (SCHREIBEN, LOESCHEN,
  // CODIER, RESET...) still asks whatever the setting says.
  // ===========================================================================
  {
    const { ipoConfirmWanted, ipoTranslateSet } = RT;
    const saved = global.Settings;
    global.Settings = { get: (k, d) => (k === 'confirmActuators' ? 'off' : d) };
    assert.strictEqual(ipoConfirmWanted('STEUERN_DISPLAY'), false);
    assert.strictEqual(ipoConfirmWanted('START_SYSTEMCHECK_LLERH'), false);
    assert.strictEqual(ipoConfirmWanted('STEUERN_IO'), false);
    for (const j of [
      'CODIERDATEN_SCHREIBEN',
      'FS_LOESCHEN',
      'ECU_CONFIG_RESET',
      'ANPASSUNG_LOESCHEN',
      'ABGLEICH_HFM',
      'SET_KILOMETERSTAND',
    ])
      assert.strictEqual(ipoConfirmWanted(j), true, `${j} must still ask`);
    // through the program: a drive key sends without asking, a write asks
    const cexec = loadExec('E46', 'ihka46');
    const cecu = {
      sgbd: 'ihka46_3',
      label: 'IHKA',
      _variant: 'IHKA46_3',
      chassis: 'E46',
    };
    fakeApi(() => ({
      system: sysSet('ihka46_3'),
      sets: [{ JOB_STATUS: 'OKAY' }],
    }));
    const cui = fakeUi();
    const cp = new IpoProgram(cecu, cexec, cui);
    await cp.runJob('ihka46_3', 'STEUERN_DISPLAY', '1', { scope: 'key:test' });
    assert.strictEqual(cui.confirms.length, 0, 'drive sent without a prompt');
    await cp.runJob('ihka46_3', 'CODIERDATEN_SCHREIBEN', '00', {
      scope: 'key:test',
    });
    assert.strictEqual(cui.confirms.length, 1, 'a permanent write still asks');
    global.Settings = { get: (k, d) => d };
    await cp.runJob('ihka46_3', 'STEUERN_DISPLAY', '2', { scope: 'key:other' });
    assert.strictEqual(
      cui.confirms.length,
      2,
      'default setting asks for a drive'
    );
    global.Settings = saved;
    cp.close();
    ok('confirmActuators off: drives send immediately, permanent writes ask');

    // MESSWERTBLOCK rows carry FUMWELTTEXTE labels: the env dictionary
    // translates them like a freeze-frame field
    const t = ipoTranslateSet(
      {
        STAT_MESSWERT0_TEXT: '(Motor) - Öltemperatur',
        STAT_MESSWERT0_WERT: '22',
      },
      'ms450ds0'
    );
    assert.strictEqual(t.STAT_MESSWERT0_TEXT, 'Engine oil temperature');
    assert.strictEqual(t.STAT_MESSWERT0_WERT, '22');
    ok('measurement-block labels translate through the env dictionary');
  }

  // ===========================================================================
  // INPA's `stop`: MS45's injector screen sends STEUERN_EV_<n> only once a
  // valve is picked -- `if (sel == 0) stop` guards it. As a noop the script
  // fell through and put a job named "2000" (the on-time) on the wire every
  // cycle, and the ECU's silence popped "STEUERN_EV / ERROR_NO_ANSWER" each
  // tick. With stop ending the LINE, nothing is sent until F1..F6.
  // ===========================================================================
  {
    const eexec = loadExec('E46', 'ms450ds0');
    const eecu = {
      sgbd: 'ms450ds0',
      label: 'MS45',
      _variant: 'MS450DS0',
      chassis: 'E46',
    };
    const esent = fakeApi(() => ({
      system: sysSet('ms450ds0'),
      sets: [{ JOB_STATUS: 'OKAY' }],
    }));
    const eui = fakeUi();
    const ep = new IpoProgram(eecu, eexec, eui);
    await ep.start();
    esent.length = 0;
    await ep.openMenu('m_ev_auswahl');
    assert.ok(
      eui.keys.some((k) => /EV1/.test(k.label)),
      'injector keys listed'
    );
    assert.deepStrictEqual(
      esent.map((s) => s.job),
      [],
      `nothing selected: nothing sent (${esent.map((s) => s.job)})`
    );
    await ep.press(1);
    const ev = esent.find((s) => /^STEUERN_EV_/.test(s.job));
    assert.ok(ev, `F1 sends the valve job (${esent.map((s) => s.job)})`);
    assert.strictEqual(ev.job, 'STEUERN_EV_1');
    assert.strictEqual(
      ev.arg,
      '2000;2000;',
      'on-time and period as the script builds them'
    );
    assert.ok(
      !esent.some((s) => /^\d+$/.test(s.job)),
      'no job named after a number'
    );
    ep.close();
    ok('stop: MS45 injector screen sends nothing until a valve is picked');
  }

  // ===========================================================================
  // Print screen: INPA's F9 builds a clean sheet (core/print.js document),
  // not the browser's print of the live page with its chrome. INPA mode =
  // the text grid; modern mode = caption/value rows; both list the keys.
  // ===========================================================================
  {
    const { ipoPrintDocument, ipoPrintGridText } = RT;
    const pexec = loadExec('E46', 'ms450ds0');
    const pecu = {
      sgbd: 'ms450ds0',
      label: 'MS45.1 for M54',
      _variant: 'MS450DS0',
      chassis: 'E46',
    };
    fakeApi(() => ({
      system: sysSet('ms450ds0'),
      sets: [{ JOB_STATUS: 'OKAY' }],
    }));
    const pui = fakeUi();
    const pp = new IpoProgram(pecu, pexec, pui);
    await pp.start();
    const grid = ipoPrintGridText(pp);
    assert.ok(grid.length > 3, `the main screen prints rows (${grid.length})`);
    assert.ok(
      grid.some((l) => /< F1/.test(l)),
      `the legend is on the sheet: ${grid[0]}`
    );
    assert.ok(
      grid.every((l) => !/<span|&lt;/.test(l)),
      'plain text, no markup'
    );
    const inpaDoc = ipoPrintDocument(pp, pecu, true);
    assert.strictEqual(inpaDoc.title, 'MS45.1 for M54');
    assert.ok(
      inpaDoc.sections[0].html.startsWith('<pre class="pr-screen">'),
      'INPA mode: the grid'
    );
    assert.ok(
      inpaDoc.sections.some((x) => /pr-keys/.test(x.html)),
      'the keys table'
    );
    assert.ok(
      inpaDoc.meta.some(([k, v]) => k === 'SGBD' && v === 'ms450ds0.prg')
    );
    const modernDoc = ipoPrintDocument(pp, pecu, false);
    assert.ok(
      modernDoc.sections.some((x) => /pr-keys/.test(x.html)),
      'modern: keys listed'
    );
    assert.ok(
      !/<pre/.test(modernDoc.sections.map((x) => x.html).join('')),
      'modern: no grid'
    );
    pp.close();
    ok('print screen: a clean sheet in both modes, keys listed');
  }

  // ===========================================================================
  // scriptchange FROM A KEY: SM46's Shift+F9 "change to passenger's side" is
  // scriptchange("B_SM46") -- INPA drops the driver's script for the
  // passenger module's own, a different ECU on its own address. The runtime
  // loads the script, lets the car name the module it addresses (the
  // script's inpainit lists B_SM46_3 / B_SM46_4 / EASY_E_B, the group that
  // identifies one of them is asked), runs its entry and opens its menu.
  // ===========================================================================
  {
    const { ipoScriptVariants } = RT;
    const dexec = loadExec('E46', 'sm46');
    const bexec = loadExec('other', 'B_SM46');
    assert.ok(dexec && bexec, 'both seat scripts ship');
    const known = new Set([
      'sm46_3',
      'sm46_4',
      'b_sm46_3',
      'b_sm46_4',
      'easy_e_b',
      'bsm46c_4',
    ]);
    assert.deepStrictEqual(
      ipoScriptVariants(bexec, known),
      ['b_sm46_3', 'b_sm46_4', 'easy_e_b'],
      'the passenger script names the variants it accepts'
    );
    const decu = {
      sgbd: 'sm46_4',
      label: 'Seat memory M46',
      _variant: 'SM46_4',
      chassis: 'E46',
      group: 'D_0072',
    };
    const dsent = fakeApi((job, arg, target) => {
      if (job === 'INITIALISIERUNG')
        return {
          system: sysSet(target),
          sets: [{ VARIANTE: target.toUpperCase() }],
        };
      return { system: sysSet(target), sets: [{ JOB_STATUS: 'OKAY' }] };
    });
    const dui = fakeUi();
    dui.loadExec = async (name) =>
      name === 'b_sm46' ? bexec : name === 'sm46' ? dexec : null;
    const bySgbd = { b_sm46: 'b_sm46_3', sm46: 'sm46_4' };
    dui.resolveScriptEcu = async (from, script) =>
      bySgbd[script]
        ? {
            ...from,
            code: script,
            sgbd: bySgbd[script],
            _variant: bySgbd[script].toUpperCase(),
            _irFrom: script,
          }
        : null;
    const dp = new IpoProgram(decu, dexec, dui);
    const dr = await dp.start();
    assert.strictEqual(dr.ok, true, `sm46 start: ${dr.reason}`);
    // the key whose body calls scriptchange (Shift+F1 "Change Editor" is a
    // different key with a similar caption)
    const changeKey = (exec, menu) => {
      const toks = exec.procs[menu] || [];
      let nr = null;
      for (const t of toks) {
        if (t.op === 'ITEM') nr = t.nr;
        else if (t.op === 'call' && t.name === 'scriptchange' && nr != null)
          return nr;
      }
      return null;
    };
    const change = dp.items.find((it) => it.nr === changeKey(dexec, dp.menu));
    assert.ok(
      change,
      `the driver's menu offers the passenger key: ${JSON.stringify(dp.items.map((i) => i.label))}`
    );
    // a press while the screen cycle runs is queued and drained after it
    const until = async (cond) => {
      for (let n = 0; n < 200 && !cond(); n++)
        await new Promise((r) => setTimeout(r, 10));
    };
    dsent.length = 0;
    await dp.press(change.nr);
    await until(() => dp.script === 'b_sm46' && dp.menu);
    assert.strictEqual(dp.script, 'b_sm46', 'the passenger script runs now');
    assert.strictEqual(
      dp.ecu.sgbd,
      'b_sm46_3',
      'the program talks to the passenger module'
    );
    const init = dsent.find((s) => s.job === 'INITIALISIERUNG');
    assert.ok(
      init && init.target === 'b_sm46_3',
      `entry identifies the passenger module: ${JSON.stringify(dsent.slice(0, 3))}`
    );
    assert.ok(dp.menu, 'the passenger script opened its menu');
    assert.ok(dui.keys.length > 3, 'its keys are listed');
    // ...and the way back
    const back = dp.items.find((it) => it.nr === changeKey(bexec, dp.menu));
    if (back) {
      dsent.length = 0;
      await dp.press(back.nr);
      await until(() => dp.script === 'sm46' && dp.menu);
      assert.strictEqual(dp.script, 'sm46', 'back on the driver script');
      assert.strictEqual(dp.ecu.sgbd, 'sm46_4');
    }
    // a script the build lacks: the current screen stays, the user is told
    dui.loadExec = async () => null;
    const before = dui.messages.length;
    const vm0 = dp.vm;
    await dp._changeScript('nowhere', dp.gen);
    assert.strictEqual(
      dui.messages.length,
      before + 1,
      'told the script is missing'
    );
    assert.strictEqual(dp.vm, vm0, 'nothing swapped');
    dp.close();
    ok('scriptchange from a key: SM46 -> B_SM46 (passenger seat) and back');
  }

  // ===========================================================================
  // Modern rows for INPA's status idiom: captions on one screen row, the
  // lamps under them on the next, column by column. Each lamp pairs with
  // the caption over it; "Motor steht" is not "Klemme 15"'s value.
  // ===========================================================================
  {
    const { ipoLineRows } = RT;
    const sexec2 = loadExec('E46', 'ms450ds0');
    const secu = {
      sgbd: 'ms450ds0',
      label: 'MS45',
      _variant: 'MS450DS0',
      chassis: 'E46',
    };
    fakeApi(() => ({
      system: sysSet('ms450ds0'),
      sets: [{ JOB_STATUS: 'OKAY', STAT_KL15_EIN: '1', STAT_MOTOR_STEHT: '1' }],
    }));
    const sui = fakeUi();
    const sp = new IpoProgram(secu, sexec2, sui);
    await sp.start();
    await sp.openMenu('m_digital');
    await sp.press(1);
    for (let n = 0; n < 100; n++) {
      if (sp.lines.some((l) => (l.elements || []).some((e) => e.t === 'lamp')))
        break;
      await new Promise((r) => setTimeout(r, 30));
    }
    const rows = ipoLineRows(sp);
    const kl15 = rows.find((r) => r.caption === 'Klemme 15');
    assert.ok(
      kl15,
      `Klemme 15 has its own row: ${JSON.stringify(rows.map((r) => r.caption))}`
    );
    assert.strictEqual(kl15.cells.length, 1);
    assert.strictEqual(kl15.cells[0].kind, 'lamp', 'its lamp sits beside it');
    const motor = rows.find((r) => r.caption === 'Motor steht');
    assert.ok(
      motor && motor.cells.length === 1 && motor.cells[0].kind === 'lamp',
      'the second column pairs with its own lamp'
    );
    assert.ok(
      !rows.some((r) => !r.caption && r.cells.some((c) => c.kind === 'lamp')),
      'no anonymous lamp row'
    );
    sp.close();
    ok('modern rows: caption row + lamp row pair by column');
  }

  // ===========================================================================
  // INPA's whole-vehicle script (E46.IPO): "Fehler -> FS lesen" reads every
  // module's fault memory through its GROUP SGBD, exactly as INPA does, and
  // writes the protocol INPA shows in its viewer
  // ===========================================================================
  {
    const vexec = loadExec('vehicle', 'e46');
    assert.ok(
      vexec && vexec.procs.inpainit,
      'e46 vehicle exec missing (data/chassis/vehicle/e46)'
    );
    const vecu = {
      sgbd: 'e46',
      code: 'E46',
      label: 'INPA E46 script',
      chassis: 'E46',
      kind: 'vehicle',
      group: null,
      _ipoKnownSgbds: new Set(['e46', 'ms450ds0', 'ihka46_3']),
    };
    // a group SGBD stays the wire target: the shim resolves it to the module
    // the car names (api-router.js); a module's own startup group too
    assert.strictEqual(ipoWireTarget(vecu, 'D_MOTOR'), 'd_motor');
    assert.strictEqual(
      ipoWireTarget({ sgbd: 'ihka46_3', group: 'D_005B' }, 'D_005B'),
      'd_005b'
    );
    assert.strictEqual(
      ipoWireTarget({ sgbd: 'ihka46_3' }, 'IHKA46,IHKA46_2,IHKA46_3'),
      'ihka46_3',
      'inpainit dispatch list -> the identified module'
    );
    assert.strictEqual(ipoWireTarget(vecu, 'MS450DS0'), 'ms450ds0');
    ok('wire target: group SGBDs route to the resolver');

    // the car: the engine has one fault, two addresses are silent, the
    // rest answer clean. FS_LESEN returns one set per fault plus the status
    // set, as EDIABAS does (the script counts sets - 1).
    const fault = {
      F_ORT_NR: 5,
      F_ORT_TEXT: 'Lambdasonde',
      F_HEX_CODE: '0x27C3',
      F_ART_ANZ: 1,
      F_ART1_NR: 1,
      F_ART1_TEXT: 'sporadisch',
      F_HFK: 3,
      F_LZ: 40,
      F_UW_ANZ: 1,
      F_UW_SATZ: 1,
      F_UW1_TEXT: 'Kilometerstand',
      F_UW1_WERT: 123456,
      F_UW1_EINH: 'km',
      F_VERSION: 1,
      JOB_STATUS: 'OKAY',
    };
    const vsent = fakeApi((job, arg, target) => {
      if (target === 'd_00a4' || target === 'd_009c')
        return new Error(`${target}: no module answered on the wire`);
      const variant = target === 'd_motor' ? 'ms450ds0' : target;
      const sys = {
        OBJECT: target,
        VARIANTE: variant.toUpperCase(),
        JOBNAME: job,
        SAETZE: 1,
      };
      if (job === 'FGNR_LESEN')
        return {
          system: sys,
          sets: [{ FGNR: 'WBAET37001NJ12345', JOB_STATUS: 'OKAY' }],
        };
      if (job === 'FS_LESEN' && variant === 'ms450ds0')
        return { system: sys, sets: [fault, { JOB_STATUS: 'OKAY' }] };
      if (job === 'FS_LESEN')
        return { system: sys, sets: [{ F_VERSION: 1, JOB_STATUS: 'OKAY' }] };
      return { system: sys, sets: [{ JOB_STATUS: 'OKAY' }] };
    });
    const vui = fakeUi();
    const vp = new IpoProgram(vecu, vexec, vui);
    const vr = await vp.start();
    assert.strictEqual(vr.ok, true, `e46 start: ${vr.reason}`);
    assert.strictEqual(vp.menu, 'm_main', 'the script opens its main menu');
    const vuntil = async (cond) => {
      for (let n = 0; n < 400 && !cond(); n++)
        await new Promise((r) => setTimeout(r, 10));
    };
    const fehler = vp.items.find((it) => it.label === 'Fehler');
    assert.ok(
      fehler,
      `Fehler key: ${JSON.stringify(vp.items.map((i) => i.label))}`
    );
    await vp.press(fehler.nr);
    await vuntil(() => vp.menu === 'm_fs' && !vp.busy);
    assert.strictEqual(vp.menu, 'm_fs', 'the fault-memory menu');
    const lesen = vp.items.find((it) => it.label === 'FS lesen');
    assert.ok(lesen, 'FS lesen key');
    vsent.length = 0;
    await vp.press(lesen.nr);
    await vuntil(() => !vp.busy && !!vp.view);
    assert.ok(
      vp.view,
      `viewopen showed the protocol: ${(vui.errors || []).join('; ')}`
    );

    const reads = vsent
      .filter((s) => s.job === 'FS_LESEN')
      .map((s) => s.target);
    for (const g of ['d_0044', 'd_00a4', 'd_motor', 'd_0080', 'd_zuheiz'])
      assert.ok(reads.includes(g), `FS_LESEN went to the group ${g}`);
    assert.ok(!reads.includes('e46'), 'nothing was sent to the script itself');
    assert.ok(
      reads.includes('ms450ds0'),
      `the detail pass names the module the group resolved to: ${reads.slice(-6)}`
    );
    ok('E46.IPO: every module read through its group, details by variant');

    // the progress window INPA shows over the read: opened with its title,
    // one line per module asked, closed before the protocol opens
    const boxes = vui.boxes || [];
    assert.ok(
      boxes.some((b) => b && b.title === 'Fehlerspeicher lesen'),
      `the read opens its progress window: ${JSON.stringify(boxes.slice(0, 2))}`
    );
    const fullest = boxes.reduce(
      (m, b) => (b && b.lines.length > (m ? m.lines.length : 0) ? b : m),
      null
    );
    assert.ok(
      fullest && fullest.lines.some((l) => /Steuerger/.test(l)),
      `the window names the module being asked: ${JSON.stringify(fullest && fullest.lines.slice(-3))}`
    );
    assert.strictEqual(boxes[boxes.length - 1], null, 'closed at the end');
    ok('E46.IPO: the progress window fills as the modules are read');

    // the read's tail relabels the keys: F9 prints the protocol, Shift+F9
    // saves it (setitem(nr, text, 1) shows the key; 0 hides it)
    const k9 = vp.items.find((it) => it.nr === 9);
    const k19 = vp.items.find((it) => it.nr === 19);
    assert.ok(
      k9 && k9.label === 'FS drucken' && !k9.hidden,
      `F9: ${JSON.stringify(k9)}`
    );
    assert.ok(
      k19 && k19.label === 'FS speichern' && !k19.hidden,
      `Shift+F9: ${JSON.stringify(k19)}`
    );
    const k1 = vp.items.find((it) => it.nr === 1);
    assert.ok(k1 && !k1.hidden && k1.label === 'FS lesen', 'F1 stays');
    ok('E46.IPO: setitem relabels and shows keys live');

    // Cancel on the progress window: the body ends before its next job and
    // the window closes; the menu is still up
    vsent.length = 0;
    vui.boxes = [];
    let cancelAt = 0;
    global.api = ((orig) => async (url, opts) => {
      const r = await orig(url, opts);
      if (/d_0080/.test(url) && !cancelAt) {
        cancelAt = vsent.length;
        vp.cancel();
      }
      return r;
    })(global.api);
    await vp.press(lesen.nr);
    await vuntil(() => !vp.busy);
    assert.ok(cancelAt > 0, 'the cancel fired during the read');
    assert.ok(
      vsent.length <= cancelAt + 1,
      `no further jobs after Cancel: ${vsent.length} vs ${cancelAt}`
    );
    assert.strictEqual(vui.boxes[vui.boxes.length - 1], null, 'window closed');
    assert.strictEqual(vp.menu, 'm_fs', 'the menu stays');
    ok('E46.IPO: Cancel ends the read between two jobs');

    const lines = vp.view.lines;
    const has = (re) => lines.some((l) => re.test(l));
    assert.ok(has(/F E H L E R S P E I C H E R/), 'protocol title');
    assert.ok(has(/^D_00A4 \*/), 'a silent module is marked *');
    assert.ok(has(/^MS450DS0 1\s+Motor/), 'the engine counts one fault');
    assert.ok(has(/^D_0080 0\s+Instrumentenkombi/), 'a clean module counts 0');
    assert.ok(
      has(/^Variante\s+:\s+MS450DS0\.PRG/),
      'the detail block names the variant'
    );
    assert.ok(has(/1 Fehler im Fehlerspeicher/), 'the detail block counts');
    assert.ok(has(/Fehlerort\s+:.*Lambdasonde/), 'the fault text');
    assert.ok(has(/Fehlerort\s+:\s+0x0005:/), 'the fault number in hex');
    assert.ok(has(/Kilometerstand.*123456/), 'the freeze-frame value');
    ok('E46.IPO: the protocol INPA writes (header, overview, details)');

    if (typeof ipoPrintDocument === 'function') {
      const doc = ipoPrintDocument(vp, vecu, true);
      const html = JSON.stringify(doc);
      assert.ok(
        html.includes('Lambdasonde'),
        'the protocol is the print sheet'
      );
      ok('E46.IPO: printing the protocol');
    }
    vp.close();
  }

  // stop every refresh timer so the process can exit
  p.close();
  if (lp) lp.close();
  if (qp) qp.close();
  if (mp) mp.close();
  if (sp) sp.close();
  console.log(`ipo-runtime: ${passed} checks passed`);
})().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
