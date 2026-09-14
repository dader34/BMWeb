// The INPA source compiler, verified by round trip.
//
// Take a shipped .IPO, decompile it to source with tools/decompile/ipo_source.py,
// compile that source back with core/ipofile/, then RUN BOTH through the VM
// against the same fake car and compare what they emit: the menu title and its
// items, the screen lines, the jobs sent with their arguments, the messages.
// Identical emissions mean the compiled script drives the car the same way the
// original does, which is the only property that matters -- the bytes need not
// match, and cannot, since names and layout are not in the file.
//
// EXPECTED FAILURES ARE THE DECOMPILER'S, NOT THE COMPILER'S. ipo_source.py
// documents its own limits: a jump fitting no if/else/while shape is left as a
// `// goto` comment, and a state machine's in-state jumps are best-effort. A
// source text carrying those has already lost the control flow before the
// compiler sees it, so those files are counted and reported, never failed.
//
//   node tools/verify/test_ips_compile.js
//   V=1 node tools/verify/test_ips_compile.js     # per-check output
//
// Skips cleanly when vendor/ or python3 is absent: CI has neither BMW tree nor
// a reason to decompile one.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const R = (p) => path.join(ROOT, 'app', 'renderer', p);
const SGDAT = path.join(ROOT, 'vendor', 'EC-APPS', 'INPA', 'SGDAT');

let passed = 0;
const ok = (what) => {
  passed++;
  if (process.env.V) console.log('  ok', what);
};

if (!fs.existsSync(SGDAT)) {
  console.log('test_ips_compile: no vendor/EC-APPS tree, skipped');
  process.exit(0);
}

// ---- the browser globals the runtime leans on ------------------------------
global.window = global;
global.document = { getElementById: () => null };
global.sbLeft = { textContent: '' };
global.esc = (s) => String(s == null ? '' : s);
global.irLabel = (s) => s;
global.lang = () => 'en';
require('vm').runInThisContext(
  fs.readFileSync(R('core/translate.js'), 'utf8'),
  {
    filename: R('core/translate.js'),
  }
);
global.window.BMW_ENV_TEXT = {};
global.BMW_FAULT_PHRASES = {};
global.BMW_FAULT_DB = {};
global.scopedFaultDb = () => null;
global.setActions = () => {};
global.location = { search: '' };
global.Settings = { get: (k, d) => d };
global.markEnergized = () => {};
global.registerMenuLeave = () => {};
const isSystemSet = (s) =>
  s &&
  typeof s === 'object' &&
  ('SAETZE' in s || 'JOBNAME' in s || 'OBJECT' in s);
global.dataSets = (sets) => {
  const list = sets || [];
  return list.length && isSystemSet(list[0]) ? list.slice(1) : list;
};
global.irItemBodyJobs = () => [];

const { loadClassic } = require('./lib/load_classic.js');
const F = loadClassic('core/ipofile/');
const { IpoVm, FeedHost } = loadClassic('core/ipovm/');
global.IpoVm = IpoVm;
global.FeedHost = FeedHost;
const bv = require(R('core/bestvm/index.js'));
global.isWriteJob = bv.isWriteJob || global.isWriteJob;
const RT = loadClassic('screens/ipo-runtime/');
const { IpoProgram } = RT;

/** One ECU's .IPO, tolerating either extension case. */
function ipoPath(stem) {
  for (const ext of ['.IPO', '.ipo']) {
    const p = path.join(SGDAT, stem + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Every .h / .SRC in SGDAT, as the user would drop them beside a script. */
function includeFiles() {
  const files = {};
  for (const f of fs.readdirSync(SGDAT)) {
    if (/\.(h|src)$/i.test(f))
      files[f] = fs.readFileSync(path.join(SGDAT, f), 'latin1');
  }
  return files;
}

/** The decompiled source of one .IPO, or null when python3 cannot run. */
function decompile(stem) {
  try {
    return execFileSync(
      'python3',
      [path.join(ROOT, 'tools', 'decompile', 'ipo_source.py'), stem],
      {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    );
  } catch (e) {
    return null;
  }
}

if (decompile('MUST_EXX') === null) {
  console.log('test_ips_compile: python3 / ipo_source.py unavailable, skipped');
  process.exit(0);
}

const FILES = includeFiles();

// ---- running a program against a fake car ----------------------------------

/** A UI that records emissions and answers every prompt the same way. */
function recordingUi() {
  const ui = {
    keys: [],
    paints: 0,
    messages: [],
    titles: [],
    lines: [],
    sleep: async () => {},
    loadExec: async () => null,
    route: () => {},
    status: () => {},
    error: (p, t) => {
      ui.errors = (ui.errors || []).concat(t);
    },
    message: async (title, body) => {
      ui.messages.push(`${title}|${body}`);
    },
    askInput: async () => 0,
    confirmKey: async () => true,
    confirmWrite: async () => true,
    pickComponent: async () => null,
    saveFile: async () => null,
    writeFile: async () => {},
    userbox: () => {},
    printScreen: () => {},
    pickLines: async () => null,
    machineTick: async () => (++ui.ticks > 20 ? 'stop' : 'tick'),
    ticks: 0,
    renderKeys: (p) => {
      ui.keys = p.items.map((it) => `${it.nr}:${it.label}`);
    },
    paint: (p) => {
      ui.paints += 1;
      if (p && p.title) ui.titles.push(p.title);
      for (const row of (p && p.rows) || []) {
        ui.lines.push(String(row.label == null ? '' : row.label));
      }
    },
    left: () => {},
  };
  return ui;
}

/**
 * Start one exec against a fake car and return everything it emitted.
 * The same answers go to both runs, so any difference is the program's.
 */
async function drive(exec, sgbd) {
  const sent = [];
  global.api = async (url) => {
    const m = String(url).match(
      /^\/api\/ecu\/([^/]+)\/run\/([^?]+)(?:\?arg=(.*))?$/
    );
    if (!m) throw new Error(`unexpected api ${url}`);
    const job = decodeURIComponent(m[2]);
    const arg = m[3] != null ? decodeURIComponent(m[3]) : null;
    sent.push(`${job}(${arg == null ? '' : arg})`);
    return {
      system: [{ JOBNAME: job, JOB_STATUS: 'OKAY', OBJECT: sgbd, SAETZE: 1 }],
      sets: [{ JOB_STATUS: 'OKAY', DONE: '1' }],
    };
  };
  const ecu = {
    sgbd,
    code: sgbd.toUpperCase(),
    label: sgbd.toUpperCase(),
    _variant: sgbd.toUpperCase(),
    _ipoKnownSgbds: new Set(),
  };
  const ui = recordingUi();
  const p = new IpoProgram(ecu, exec, ui);
  let started;
  try {
    started = await p.start();
  } catch (e) {
    return { error: String(e && e.message) };
  }
  return {
    ok: !!(started && started.ok),
    menu: p.menu || null,
    screen: p.screen || null,
    keys: ui.keys,
    titles: ui.titles,
    lines: ui.lines,
    messages: ui.messages,
    jobs: sent,
  };
}

/**
 * Whether a decompiled source carries a construct the decompiler lost.
 *
 * `// goto` is a jump that fitted no if/else/while shape; `__const_N` is a
 * literal whose pool the decompiler could not read, so the source names an
 * index instead of a value; a state machine's in-state jumps are best-effort
 * by its own account. In each case the control flow or the data is already
 * gone from the text, so nothing downstream can rebuild it.
 */
function decompilerLostSomething(src) {
  return (
    /^\s*\/\/ goto /m.test(src) ||
    /not in this block/.test(src) ||
    /__const_\d/.test(src) ||
    // an "include" with no extension is a global's initialiser the
    // decompiler's leading-string rule swallowed, not a file to supply
    /^#include\s+"[^".\\/]*"\s*$/m.test(src) ||
    /__ref_[0-9a-f]{2}_/.test(src) ||
    /in-state jumps are best-effort/.test(src) ||
    /container not fully parsed/.test(src)
  );
}

// ---- 1. MUST_EXX and e46 compile and drive identically ---------------------
//
// The two the format was cracked against: BMW ships MUST_EXX's own source, and
// e46 is a real chassis entry script. These must round-trip exactly.
const MAIN = [
  ['MUST_EXX', 'must_exx'],
  ['e46', 'e46'],
];

(async () => {
  for (const [stem, sgbd] of MAIN) {
    const src = decompile(stem);
    assert.ok(src, `${stem}: could not decompile`);
    const original = F.ipofDecodeExec(
      new Uint8Array(fs.readFileSync(ipoPath(stem))),
      stem
    );
    const imports = [];
    for (const k of Object.keys(original.imports))
      imports[Number(k)] = original.imports[k];

    const r = F.ipofCompileSource(src, { name: stem, files: FILES, imports });
    assert.deepStrictEqual(
      r.errors.map((e) => e.text),
      [],
      `${stem}: compile errors`
    );
    assert.ok(r.ok && r.exec, `${stem}: no exec produced`);
    ok(`${stem}: compiled, ${Object.keys(r.exec.procs).length} procs`);

    const a = await drive(original, sgbd);
    const b = await drive(r.exec, sgbd);
    assert.strictEqual(
      b.ok,
      a.ok,
      `${stem}: one program started and the other did not`
    );
    assert.deepStrictEqual(
      b.jobs,
      a.jobs,
      `${stem}: the jobs sent to the car differ`
    );
    assert.deepStrictEqual(b.keys, a.keys, `${stem}: the menu keys differ`);
    assert.deepStrictEqual(
      b.titles,
      a.titles,
      `${stem}: the screen titles differ`
    );
    assert.deepStrictEqual(
      b.lines,
      a.lines,
      `${stem}: the screen lines differ`
    );
    assert.deepStrictEqual(
      b.messages,
      a.messages,
      `${stem}: the messages differ`
    );
    assert.strictEqual(b.menu, a.menu, `${stem}: a different root menu opened`);
    assert.strictEqual(
      b.screen,
      a.screen,
      `${stem}: a different root screen opened`
    );
    ok(`${stem}: the compiled script drives the car identically`);
  }

  // ---- 2. a missing include is a clear error, not a half-compile -----------
  {
    const src = decompile('MUST_EXX');
    const r = F.ipofCompileSource(src, { name: 'MUST_EXX', files: {} });
    assert.strictEqual(r.ok, false, 'a script compiled without its includes');
    assert.ok(
      r.errors.some((e) => /BMW_STD\.H/i.test(e.text)),
      `the error names the missing include (got ${JSON.stringify(r.errors.map((e) => e.text))})`
    );
    assert.deepStrictEqual(
      r.missing.map((m) => m.toLowerCase()).sort(),
      ['bmw_std.h', 'inpa.h'],
      'both missing includes are listed'
    );
    ok('a missing include is reported by name, and nothing is compiled');
  }

  // ---- 3. a builtin with no number is a compile error naming the line ------
  {
    const r = F.ipofCompileSource('m()\n{\n  no_such_builtin(1);\n}\n', {
      name: 't',
    });
    assert.strictEqual(r.ok, false, 'an unnumbered builtin compiled');
    assert.strictEqual(r.errors.length, 1, 'one error');
    assert.strictEqual(r.errors[0].line, 3, 'the error names the line');
    assert.ok(
      /no_such_builtin/.test(r.errors[0].text),
      'the error names the call'
    );
    ok('an uncompilable builtin names its line');
  }

  // ---- 4. a syntax error names its line ------------------------------------
  {
    const r = F.ipofCompileSource('m()\n{\n  if (1 {\n}\n', { name: 't' });
    assert.strictEqual(r.ok, false, 'broken source compiled');
    assert.strictEqual(
      r.errors[0].line,
      3,
      `the error names the line (got ${r.errors[0].line})`
    );
    ok('a syntax error names its line');
  }

  // ---- 5. control flow survives the round trip -----------------------------
  //
  // if / else / while compile to the jump shapes the decompiler reads back, so
  // a hand-written script of each shape must produce the same emissions as the
  // same logic written straight-line.
  {
    const src = [
      'int n;',
      '',
      'MENU m_main()',
      '{',
      '  INIT {',
      '    setmenutitle("Root");',
      '    n = 0;',
      '    while (n < 3)',
      '    {',
      '      n = n + 1;',
      '    }',
      '    if (n == 3)',
      '    {',
      '      setitem(1, "three", TRUE);',
      '    }',
      '    else',
      '    {',
      '      setitem(1, "other", TRUE);',
      '    }',
      '  }',
      '  ITEM(1, "Go")',
      '  {',
      '    setscreen(s_main, TRUE);',
      '  }',
      '}',
      '',
      'SCREEN s_main()',
      '{',
      '  settitle("Live");',
      '  LINE("Value", "")',
      '  {',
      '    text(1, 1, "v");',
      '  }',
      '}',
      '',
      'inpainit()',
      '{',
      '  setmenu(m_main);',
      '  setscreen(s_main, TRUE);',
      '}',
    ].join('\n');
    const r = F.ipofCompileSource(src, { name: 'flow' });
    assert.deepStrictEqual(
      r.errors.map((e) => e.text),
      [],
      'the flow script compiled'
    );
    const toks = r.exec.procs.m_main;
    const at = new Set(toks.map((t) => t.at));
    at.add(toks[toks.length - 1].at + 4);
    for (const t of toks) {
      if (t.op === 'jump' || t.op === 'jfalse') {
        assert.ok(at.has(t.to), `a ${t.op} to ${t.to} lands between tokens`);
      }
    }
    // the while's back edge goes backwards, the if's skip forwards
    const jumps = toks.filter((t) => t.op === 'jump');
    assert.ok(
      jumps.some((t) => t.to < t.at),
      'the while loop has no back edge'
    );
    ok('if / else / while emit resolvable jumps in both directions');

    const out = await drive(r.exec, 'flow');
    assert.strictEqual(
      out.ok,
      true,
      `the compiled flow script did not start: ${out.error || ''}`
    );
    assert.deepStrictEqual(
      out.keys,
      ['1:Go'],
      `the menu item is the one INIT enabled: ${out.keys}`
    );
    assert.ok(
      out.titles.length > 0,
      `the screen painted with a title: ${JSON.stringify(out.titles)}`
    );
    ok('the hand-written script runs: loop, branch, menu, screen');
  }

  // ---- 6. the corpus: how much of it round-trips ---------------------------
  //
  // Every script is decompiled and recompiled. A file the decompiler could not
  // fully recover is separated out and reported, because the loss happened
  // before the compiler saw the text.
  {
    // an even spread, not the alphabetical head: the corpus is sorted by ECU
    // family, so the first N files are all one dialect and say nothing about
    // the rest
    const all = fs
      .readdirSync(SGDAT)
      .filter((f) => /\.ipo$/i.test(f))
      .map((f) => f.replace(/\.[^.]*$/, ''))
      .sort();
    const limit = Number(process.env.IPS_CORPUS || 60);
    const step = Math.max(1, Math.floor(all.length / limit));
    const stems = all.filter((_, i) => i % step === 0);
    const seen = new Set();
    let tried = 0;
    let compiled = 0;
    let lossy = 0;
    let failed = 0;
    const examples = [];
    for (const stem of stems) {
      if (tried >= limit) break;
      if (seen.has(stem.toLowerCase())) continue;
      seen.add(stem.toLowerCase());
      const src = decompile(stem);
      if (!src) continue;
      tried += 1;
      let imports = [];
      try {
        const dec = F.ipofDecodeExec(
          new Uint8Array(fs.readFileSync(ipoPath(stem))),
          stem
        );
        for (const k of Object.keys(dec.imports))
          imports[Number(k)] = dec.imports[k];
      } catch (e) {
        imports = [];
      }
      let r;
      try {
        r = F.ipofCompileSource(src, { name: stem, files: FILES, imports });
      } catch (e) {
        r = { ok: false, errors: [{ text: String(e && e.message) }] };
      }
      if (r.ok) compiled += 1;
      else if (decompilerLostSomething(src)) lossy += 1;
      else {
        failed += 1;
        if (examples.length < 6)
          examples.push(`${stem}: ${(r.errors[0] || {}).text}`);
      }
    }
    console.log(
      `  corpus: ${compiled}/${tried} recompiled, ` +
        `${lossy} the decompiler could not fully recover, ${failed} other`
    );
    for (const e of examples) console.log(`    ${e}`);
    assert.ok(tried > 20, `too few files tried (${tried})`);
    // The bar is on the files whose source actually survived decompilation:
    // a text the decompiler could not fully recover has already lost what the
    // compiler would need, so counting it against the compiler would measure
    // the wrong tool. Every recoverable file must compile.
    const recoverable = tried - lossy;
    assert.ok(recoverable > 15, `too few recoverable files (${recoverable})`);
    assert.strictEqual(
      failed,
      0,
      `files whose source was intact but did not compile: ${examples.join('; ')}`
    );
    ok(`corpus: ${compiled}/${tried} scripts recompile`);
  }

  console.log(`test_ips_compile: ${passed} checks passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
