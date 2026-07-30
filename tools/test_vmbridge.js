#!/usr/bin/env node
// Does the RENDERER's path to the VM work -- not just the VM itself?
//
// tools/test_bestvm.js feeds the VM raw wire frames from a fixture bundle.
// The app has no such bundle: it has whatever the engine published as job
// results, and vmbridge.js has to turn that back into frames. Two lossy
// steps live in there and both were wrong on the first try:
//
//   * _TEL_ANTWORT is the PAYLOAD, header stripped ("61-F0-..."), where
//     xsend expects the wire frame ("9A-F1-12-61-F0-...").
//   * the frame carries a trailing CHECKSUM that jobs count in their length
//     check, so omitting it yields ERROR_ECU_INCORRECT_LEN.
//
// Neither is visible to test_bestvm.js, which is why this exists. It drives
// vmObserve() exactly as core.js does, with the engine's own published
// results as input.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

// A browser-ish sandbox: globals rather than modules, fetch reading data/.
const ctx = {
  console,
  window: {},
  Settings: { get: (k, d) => (k === 'vm' ? 'shadow' : d) },
  fetch: async (p) => {
    const f = path.join(ROOT, p);
    return fs.existsSync(f)
      ? { ok: true, json: async () => JSON.parse(fs.readFileSync(f, 'utf8')) }
      : { ok: false };
  },
};
ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of ['app/renderer/bestvm.js', 'app/renderer/vmbridge.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx);
}

const fixP = path.join(ROOT, 'data/sim-captures/vmfix.json');
if (!fs.existsSync(fixP)) {
  console.log('no vmfix.json; run tools/vm_fixtures.py first');
  process.exit(0);
}
const fix = JSON.parse(fs.readFileSync(fixP, 'utf8'));

// Only cases where the engine actually published telegrams can be replayed
// this way -- that IS the bridge's input, so a case without them is out of
// scope rather than a failure.
const usable = fix.cases.filter((c) => (c.sets || []).some(
  (s) => s._TEL_ANTWORT));

(async () => {
  let jobs = 0, checked = 0, disagreed = 0, skipped = 0;
  const bySkip = {};
  const worst = [];
  for (const c of usable) {
    const before = ctx.vmStats().checked;
    const st0 = { ...ctx.vmStats() };
    await ctx.vmObserve(c.sgbd, c.job, c.sets, c.args || null);
    const st = ctx.vmStats();
    if (st.skipped > st0.skipped) {
      skipped++;
      const why = Object.keys(st.bySkip).find(
        (k) => st.bySkip[k] !== st0.bySkip[k]);
      bySkip[why] = (bySkip[why] || 0) + 1;
      continue;
    }
    jobs++;
    checked += st.checked - before;
    const d = st.disagreed - st0.disagreed;
    disagreed += d;
    if (d) worst.push(`${c.sgbd}:${c.job} (${d})`);
  }
  console.log(`bridge replayed : ${jobs} jobs (${skipped} skipped)`);
  console.log(`results checked : ${checked}`);
  console.log(`  AGREE         : ${checked - disagreed}`
    + ` (${(100 * (checked - disagreed) / Math.max(checked, 1)).toFixed(1)}%)`);
  console.log(`  DISAGREE      : ${disagreed}`);
  if (Object.keys(bySkip).length) {
    console.log('skip reasons:');
    for (const [k, v] of Object.entries(bySkip)) console.log(`  ${v} ${k}`);
  }
  if (worst.length) {
    console.log('jobs with differences:');
    for (const w of worst.slice(0, 12)) console.log(`  ${w}`);
  }
  // The bridge is a lossy reconstruction of frames the engine already
  // consumed; a handful of jobs legitimately cannot be rebuilt (DS2 framing
  // carries no separable header, multi-telegram jobs publish one pair). Hold
  // the line where it is rather than at 100%, so a regression is visible.
  const rate = (checked - disagreed) / Math.max(checked, 1);
  if (rate < 0.95) {
    console.log(`\nFAIL: bridge agreement ${(100 * rate).toFixed(1)}% < 95%`);
    process.exit(1);
  }
  console.log('\nbridge holds');
})();
