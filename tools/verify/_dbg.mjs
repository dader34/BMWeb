#!/usr/bin/env node
// WebKFP end to end against an emulated module: BMW's programming script
// (data/kfp) on the CDH host (core/kfp), its SGBD on the app's own job VM,
// over the app's own transport, into gs20-emu or ms45-emu through the
// gateway they serve (tools/kline.py --ws PORT).
//
//   node tools/verify/kfp_emu.mjs gs20|ms45|<family> <SP-Daten data dir> <ZB> [--gateway ws://localhost:8770] [--fast] [--new]
//
// Not part of check.sh: it needs an emulator running, and a flash takes
// minutes at the module's own pace.
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { connectBus, disconnectBus } from '../../cli/src/live.ts';
import { runtimeGlobals } from '../../cli/src/runtime.ts';

const require = createRequire(import.meta.url);
const ROOT = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..'
);
const R = path.join(ROOT, 'app', 'renderer');
const kfp = require(path.join(R, 'core', 'kfp', 'run.js'));
const hostmod=require(path.join(R,"core","kfp","host.js"));
const _orig=kfp;

const daten = require(path.join(R, 'core', 'kfp', 'daten.js'));

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
// the options that take a value, so it is not read as a positional
const VALUED = ['--gateway', '--only'];
const [modId, spDir, zb] = args.filter(
  (a, i) => !a.startsWith('--') && !(i > 0 && VALUED.includes(args[i - 1]))
);
// gs20 / ms45, or any family data/kfp/families.json lists (mds43, ...)
const families = JSON.parse(
  readFileSync(path.join(R, 'data', 'kfp', 'families.json'))
);
const fam = families.find(
  (f) => f.folder.toLowerCase() === String(modId).toLowerCase()
);
const mod = kfp.MODULES[modId] || (fam && kfp.moduleOf(fam));
if (!mod || !spDir || !zb) {
  console.error(
    'usage: kfp_emu.mjs gs20|ms45|<family> <SP-Daten data dir> <ZB> [--gateway url] [--fast] [--new] [--only data|program]'
  );
  process.exit(2);
}

const folder = path.join(spDir, mod.folder);
const names = readdirSync(folder);
const row = daten
  .parseZbTable(readFileSync(path.join(folder, mod.table), 'latin1'))
  .find((r) => r.zb === zb);
if (!row) throw new Error(`no ZB ${zb} in ${mod.table}`);
const which = daten.filesFor(row, names);
const files = {};
for (const kind of ['program', 'data'])
  if (which[kind])
    files[kind] = {
      name: which[kind],
      file: daten.parseFile(
        readFileSync(path.join(folder, which[kind]), 'latin1')
      ),
    };
console.log(`ZB ${zb}: program ${which.program}, data ${which.data}`);

const exec = JSON.parse(
  readFileSync(path.join(R, 'data', 'kfp', `${mod.pabd}.json`))
);
const gz = (f) =>
  JSON.parse(
    gunzipSync(readFileSync(path.join(R, 'data', 'kfp', f))).toString()
  );

const { R: runtime } = await connectBus({
  gateway: opt('--gateway', 'ws://localhost:8770'),
});
const g = runtimeGlobals();
g.webProvideJobCode(
  mod.sgbd,
  gz(`${mod.sgbd}.job-code.json.gz`),
  gz(`${mod.sgbd}.tables.json.gz`)
);

const started = Date.now();
const t = () => ((Date.now() - started) / 1000).toFixed(1).padStart(6);
let lastPct = -1;
try {
  const r = await kfp.program({
    confirmed: true,
    module: mod,
    exec,
    files,
    programIsNew: flag('--new'),
    // expert mode's Prog. Data / Prog. Program: that file alone
    only: opt('--only', undefined),
    fast: flag('--fast'),
    aif: {
      vin: 'WBAEV53482KM12345',
      zb,
      km: '123456',
      sw: row.sw,
      changeIndex: row.swIndex,
    },
    // as WebKFP does: on an EDIC, so fast baud reaches the wire
    runJob: async (sgbd, job, arg) =>
      (
        await g.webRunJob(sgbd, job, arg, {
          interfaceType: 'EDIC',
          maxPasses: 2048,
        })
      ).sets,
    onStage: (s) => console.log(`${t()}  ${s}`),
    onJob: (e) => {
      if (e.job === 'FLASH_SCHREIBEN' && /^OKAY$/.test(e.status)) return;
      console.log(
        `${t()}    ${e.job} [${e.arg.slice(0, 60)}] -> ${e.status}${e.error ? ` (${e.error})` : ''}`
      );
    },
    onProgress: (sent, total, name) => {
      const pct = Math.floor((sent * 100) / total);
      if (pct !== lastPct && pct % 10 === 0)
        console.log(`${t()}    ${name} ${pct}%`);
      lastPct = pct;
    },
  });
  console.log(r);
  process.exitCode = r.ok ? 0 : 1;
} finally {
  await disconnectBus(runtime);
}
