#!/usr/bin/env node
// Headless comparison: run the Python ipo_vm.py deriver AND the JS ipovm.js on
// the SAME proc of the SAME ECU, and diff the emissions. The bar: ipovm.js
// reproduces ipo_vm.py's output.
//
//   node tools/verify/ipovm_diff.js
//
// For each case it spawns python3 to get the reference emissions (as JSON),
// loads the ipo_exec.py dump, runs ipovm.js, and compares the fields that
// matter (title/menu/screen, items, jobs, reads, drawn lines/elements,
// messages, states, calls).

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { IpoVm } = require(path.join(ROOT, 'app/renderer/core/ipovm.js'));

// ---- reference: drive ipo_vm.py in a subprocess, emit JSON --------------

const PY = `
import sys, json
sys.path.insert(0, 'tools/decompile')
import ipo_vm as V

ecu, proc, mode = sys.argv[1], sys.argv[2], sys.argv[3]

def slim(out):
    def line(l):
        return {"label": l.get("label"),
                "elements": l.get("elements", []),
                "jobArg": l.get("jobArg")}
    return {
        "title": out.title, "menu": out.menu, "screen": out.screen,
        "items": out.items, "jobs": out.jobs,
        "reads": out.reads, "messages": out.messages,
        "states": out.states, "calls": out.calls,
        "lines": [line(l) for l in out.lines],
    }

vm = V.VM(ecu, budget=80000)
if mode == 'run':
    out = vm.run(proc)
    print(json.dumps(slim(out)))
elif mode == 'items':
    # run_item over every ITEM of a menu; emit the resolved items + per-item
    # jobs/calls
    toks = vm.procs[proc]
    marks = [(k, t.get("nr"), t.get("label")) for k, t in enumerate(toks)
             if t["op"] == "ITEM" and t.get("nr") is not None]
    res = []
    for idx, (k, nr, label) in enumerate(marks):
        end = marks[idx + 1][0] if idx + 1 < len(marks) else len(toks)
        v = V.VM(ecu, budget=80000)
        cur = {"nr": nr, "label": label}
        try:
            v.run_item(toks, k + 1, end, cur)
        except Exception:
            pass
        res.append({"item": cur, "jobs": v.out.jobs, "calls": v.out.calls})
    print(json.dumps(res))
`;

function pyRun(ecu, proc, mode) {
  const out = execFileSync('python3', ['-c', PY, ecu, proc, mode], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

// ---- JS side -----------------------------------------------------------

function loadExec(stem) {
  const f = `/tmp/${stem}.ipoexec.json`;
  if (!fs.existsSync(f)) {
    execFileSync('python3', ['tools/export/ipo_exec.py', stem, f], {
      cwd: ROOT,
    });
  }
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function jsRun(stem, proc) {
  const vm = new IpoVm(loadExec(stem), { budget: 80000 });
  const out = vm.run(proc);
  return {
    title: out.title,
    menu: out.menu,
    screen: out.screen,
    items: out.items,
    jobs: out.jobs,
    reads: out.reads,
    messages: out.messages,
    states: out.states,
    calls: out.calls,
    lines: out.lines.map((l) => ({
      label: l.label,
      elements: l.elements,
      jobArg: l.jobArg == null ? null : l.jobArg,
    })),
  };
}

function jsItems(stem, proc) {
  const exec = loadExec(stem);
  const toks = exec.procs[proc];
  const marks = [];
  toks.forEach((t, k) => {
    if (t.op === 'ITEM' && t.nr != null) marks.push([k, t.nr, t.label]);
  });
  const res = [];
  marks.forEach((m, idx) => {
    const [k, nr, label] = m;
    const end = idx + 1 < marks.length ? marks[idx + 1][0] : toks.length;
    const vm = new IpoVm(exec, { budget: 80000 });
    const cur = { nr, label };
    try {
      vm.runItem(toks, k + 1, end, cur);
    } catch (e) {
      /* noop */
    }
    res.push({ item: cur, jobs: vm.out.jobs, calls: vm.out.calls });
  });
  return res;
}

// ---- diff --------------------------------------------------------------

// Normalize for comparison: Python may emit tuples as arrays, sets omitted,
// _Bound as plain string. JSON canonicalization with sorted object keys.
function canon(x) {
  if (Array.isArray(x)) return x.map(canon);
  if (x && typeof x === 'object') {
    const o = {};
    for (const k of Object.keys(x).sort()) {
      if (x[k] === null || x[k] === undefined) continue;
      o[k] = canon(x[k]);
    }
    return o;
  }
  return x;
}

function eq(a, b) {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

function diffObj(py, js, fields) {
  const diffs = [];
  for (const f of fields) {
    if (!eq(py[f], js[f])) {
      diffs.push({ field: f, py: py[f], js: js[f] });
    }
  }
  return diffs;
}

// ---- cases -------------------------------------------------------------

let failures = 0;
const RESULTS = [];

function report(name, diffs) {
  const ok = diffs.length === 0;
  if (!ok) failures += 1;
  RESULTS.push({ name, ok, diffs });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  for (const d of diffs) {
    console.log(`      field ${d.field}`);
    console.log(`        py: ${JSON.stringify(d.py)}`);
    console.log(`        js: ${JSON.stringify(d.js)}`);
  }
}

function caseRun(stem, proc, fields) {
  const py = pyRun(stem, proc, 'run');
  const js = jsRun(stem, proc);
  report(`${stem}:${proc} run`, diffObj(py, js, fields));
}

function caseItems(stem, proc) {
  const py = pyRun(stem, proc, 'items');
  const js = jsItems(stem, proc);
  const diffs = [];
  if (!eq(py, js)) {
    diffs.push({ field: 'items[]', py, js });
  }
  report(`${stem}:${proc} run_item`, diffs);
}

const RUN_FIELDS = [
  'title',
  'menu',
  'screen',
  'items',
  'jobs',
  'reads',
  'messages',
  'states',
  'lines',
  'calls',
];

// --- lsz: messagebox + togglelist + STEUERN_IO ---
caseRun('lsz', 'inpainit', RUN_FIELDS); // the "variant checking" messagebox
caseItems('lsz', 'm_steuern'); // STEUERN_IO + builtin_16 togglelist

// --- MS450: fault screens draw DIFFERENTLY when helpers execute ---
caseRun('MS450', 's_fs_kurz', RUN_FIELDS);
caseRun('MS450', 's_fs_detail', RUN_FIELDS);

// --- gsds2: gauges render ---
caseRun('gsds2', 's_ana2_834', RUN_FIELDS);

// Cross-check that kurz and detail really differ (the whole point).
const kurz = jsRun('MS450', 's_fs_kurz');
const detail = jsRun('MS450', 's_fs_detail');
const differ = !eq(kurz.reads, detail.reads);
console.log(
  `${differ ? 'PASS' : 'FAIL'}  MS450 kurz vs detail reads differ ` +
    `(kurz=${kurz.reads.length} keys, detail=${detail.reads.length} keys)`
);
if (!differ) failures += 1;

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
