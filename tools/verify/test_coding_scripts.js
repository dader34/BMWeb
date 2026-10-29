#!/usr/bin/env node
// EVERY SHIPPED CODING SCRIPT, through the dispatcher, in both directions.
//
//   node tools/verify/test_coding_scripts.js
//
// The offline rig (test_coding_dispatch.js) proves one script end to end
// against a simulated cluster. This one proves the other thing that matters
// before a script meets a car: that no script reaches a call the host cannot
// serve after it has started writing. Each script in
// app/renderer/data/coding-dispatch runs a read (CODIERDATEN_LESEN) and a
// write (SG_CODIEREN) against a stub bus that answers every job OKAY and
// echoes request buffers back. Asserted:
//   - no read and no write stops on an unserved call ("not supported");
//   - a write whose script calls something the host refuses (another module
//     to code) is refused before any job goes out;
//   - the factory tool's vehicle-order walk (getFaElement) hands EWS3 its
//     upholstery and paint codes, and no order ends the run before its
//     paint/upholstery job;
//   - CDHGetInfo serves the module's ident lists, and ends the run without;
//   - the write runner refuses EWS3 up front without an order;
//   - the post-reset wait (settimer/testtimer) really waits.
// The stub's data is not a module's: a script that fails on it for a data
// reason (a function the stub description lacks) is fine here.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const R = path.join(ROOT, 'app/renderer');
const CD = require(path.join(R, 'core/coding/dispatch.js'));
const W = require(path.join(R, 'core/coding/write.js'));
const DIR = path.join(R, 'data/coding-dispatch');

let failures = 0;
let passed = 0;
const ok = (cond, msg) => {
  if (cond) {
    passed++;
    console.log(`  ok    ${msg}`);
  } else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
};

if (!fs.existsSync(DIR)) {
  console.log(
    'coding scripts: no data/coding-dispatch (run the data fetch); skipped'
  );
  process.exit(0);
}

/** A stub description: 16 byte-wide functions over a 32-byte coding block. */
function stubCabd() {
  const fields = [];
  for (let i = 0; i < 16; i++)
    fields.push({ name: `F${i}`, word: i, byte: 1, mask: 0xff, masks: [0xff] });
  return {
    fields,
    groups: [{ name: 'CODIERDATEN', start: 0, length: 32, kind: 'coding' }],
    codingIndex: [1],
    typ: 'FREI',
  };
}

const VIN = 'WBAAV33471FU91768';
const FA = 'E46_#0904*AV31&LCSW%475$205$249$302';

/**
 * A bus that answers every job OKAY, a coding index of 01, and a request
 * buffer with itself.
 * @param {Array<[string, string]>} trace - jobs and arguments, in order.
 */
function stubJob(trace) {
  return async (sg, job, arg, o) => {
    trace.push([job, o && o.binary ? '#' : String(arg)]);
    const set = new Proxy(
      {},
      {
        get: (t, k) => {
          if (typeof k !== 'string') return undefined;
          if (k === 'JOB_STATUS') return 'OKAY';
          if (/COD_INDEX|CODIERINDEX/.test(k)) return '01';
          if (/DATEN|BLOCK|BUFFER/.test(k))
            return o && o.binary
              ? Array.from(arg, (c) => c.charCodeAt(0))
              : '00';
          if (/FGNR|FAHRGESTELL|VIN/.test(k)) return VIN;
          return '1';
        },
      }
    );
    return [set, set];
  };
}

/**
 * Run one script once.
 * @returns {Promise<{r: any, err: string|null, trace: Array<[string, string]>}>}
 */
async function runScript(exec, mode, extra = {}) {
  const trace = [];
  const netto = new Array(64).fill(0x11);
  const all = Array.from({ length: 32 }, (_, a) => a);
  try {
    const r = await CD.runCodingDispatch(exec, {
      confirmed: true,
      sgbd: exec.cabd,
      cabd: stubCabd(),
      dataOrg: exec.dataOrg,
      systemData: {
        FAHRGESTELL_NR: VIN,
        WERK_NR: '0000',
        ...(extra.sys || {}),
      },
      runJob: stubJob(trace),
      netto,
      readAddrs: all,
      held: netto.slice(),
      changed: all,
      mode,
      jobname: mode === 'read' ? 'CODIERDATEN_LESEN' : 'SG_CODIEREN',
      fa: extra.fa,
    });
    return { r, err: null, trace };
  } catch (e) {
    return { r: null, err: String(e.message || e), trace };
  }
}

const load = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));

(async () => {
  console.log('every shipped script, read and write, against a stub bus');
  const files = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
  let scripts = 0;
  const unserved = [];
  const refused = [];
  for (const f of files) {
    const exec = load(f);
    if (!exec.coding || !exec.procs) continue;
    scripts++;
    for (const mode of ['read', 'write']) {
      const { r, err, trace } = await runScript(exec, mode, { fa: FA });
      const text = err || (r && r.info) || '';
      if (/not supported/.test(text)) unserved.push(`${f} ${mode}: ${text}`);
      if (err && mode === 'write') refused.push([f, err, trace.length]);
    }
  }
  ok(scripts > 50, `${scripts} coding scripts found`);
  ok(
    !unserved.length,
    'no script stops on a call the host cannot serve' +
      (unserved.length ? `\n        ${unserved.join('\n        ')}` : '')
  );
  ok(
    refused.every(([, , n]) => n === 0),
    'every write refused up front sent nothing first'
  );
  ok(
    refused.some(([f, e]) => f === 'c_lwr.json' && /CDHSetSgName/.test(e)),
    'the headlight-range script, which goes on to code the light module too, is refused before it starts'
  );

  console.log('\nthe vehicle order (EWS3 paint and upholstery)');
  const ews = load('c_ews3.json');
  let got = await runScript(ews, 'write', { fa: FA });
  const kd = got.trace.find(([j]) => /polster_lack/i.test(j));
  ok(got.r && got.r.ok, 'with an order, the EWS3 write runs to the end');
  ok(
    kd && /LCSW/.test(kd[1]) && /475/.test(kd[1]),
    `its paint/upholstery job carries the order's codes (${kd ? kd[1] : 'not run'})`
  );
  got = await runScript(ews, 'write', {});
  ok(
    got.r &&
      !got.r.ok &&
      /vehicle order/.test(got.r.info) &&
      !got.trace.some(([j]) => /polster_lack/i.test(j)),
    'without one the run ends at the order, before that job'
  );
  {
    const H = new CD.CdhHost({ runJob: async () => [], fa: FA });
    const seq = [
      H.CDHGetFaElement('&', 1),
      H.CDHGetFaElement('%', 1),
      H.CDHGetFaElement('$', 1),
      H.CDHGetFaElement('$', 0),
      H.CDHGetFaElement('', 0),
      H.CDHGetFaElement('-', 1),
    ];
    ok(
      JSON.stringify(seq) ===
        JSON.stringify(['&LCSW', '%475', '$205', '$249', '$302', '']),
      `the walk is the factory tool's: first=1 restarts, others continue, a missing marker is '' (${seq.join(' ')})`
    );
  }

  console.log("\nthe module's ident lists (CDHGetInfo)");
  {
    const H = new CD.CdhHost({
      runJob: async () => [],
      systemData: { HARDWARE_NUMMER: '6904143,6904144' },
    });
    const a = H.CDHGetInfo('HARDWARE_NUMMER', 2);
    const all = H.CDHGetInfo('HARDWARE_NUMMER', 0);
    ok(
      a.text === '6904144' &&
        a.count === 2 &&
        a.retVal === 0 &&
        all.text === '6904143,6904144',
      'an entry by number, or the whole list'
    );
    const H2 = new CD.CdhHost({ runJob: async () => [] });
    H2.CDHGetInfo('SOFTWARE_NUMMER', 1);
    ok(!!H2.hostFault, 'one nobody read ends the run');
  }
  {
    const smc = load('a_smcds2.json');
    const r1 = await runScript(smc, 'read', {});
    ok(
      r1.r && !r1.r.ok && /HARDWARE_NUMMER/.test(r1.r.info) && !r1.trace.length,
      'the seat module script, without its hardware number, stops before the wire'
    );
  }

  console.log('\nthe write runner asks first');
  {
    let sent = 0;
    let e = null;
    try {
      await W.writeCoding('c_ews3', '00'.repeat(32), {
        confirmed: true,
        exchange: async () => {
          sent++;
          return [];
        },
        code: { jobs: {} },
        Best2Vm: function () {},
        dispatch: ews,
        dataOrg: ews.dataOrg,
        cabd: stubCabd(),
        base: '11'.repeat(32),
        vin: VIN,
      });
    } catch (x) {
      e = x;
    }
    ok(
      e && /vehicle order/.test(e.message) && sent === 0,
      'an EWS3 write with no order is refused with nothing on the wire'
    );
    e = null;
    try {
      await W.writeCoding('c_ews3', '00'.repeat(32), {
        confirmed: true,
        exchange: async () => {
          sent++;
          return [];
        },
        code: { jobs: {} },
        Best2Vm: function () {},
        dispatch: ews,
        dataOrg: ews.dataOrg,
        cabd: stubCabd(),
        base: '11'.repeat(32),
        vin: VIN,
        fa: 'E46_#0904*AV31$205',
      });
    } catch (x) {
      e = x;
    }
    ok(
      e && /upholstery code and paint code/.test(e.message) && sent === 0,
      'nor with an order that lacks the codes it writes'
    );
  }

  console.log('\nthe cable lost mid-write');
  {
    const exec = load('c_btm46.json');
    let n = 0;
    const netto = new Array(64).fill(0x11);
    const all = Array.from({ length: 32 }, (_, a) => a);
    const echo = stubJob([]);
    const r = await CD.runCodingDispatch(exec, {
      confirmed: true,
      sgbd: exec.cabd,
      cabd: stubCabd(),
      dataOrg: exec.dataOrg,
      systemData: { FAHRGESTELL_NR: VIN },
      runJob: async (sg, job, arg, o) => {
        if (/AUFTRAG/.test(job) && ++n === 2) throw new Error('no answer');
        return echo(sg, job, arg, o);
      },
      netto,
      readAddrs: all,
      held: netto.slice(),
      changed: all,
      mode: 'write',
    });
    ok(
      !r.ok && /no answer/.test(r.info) && r.writesTried === 2,
      `a bus error on the second write telegram is a failed run that counts both (${r.writesTried} tried, "${r.info}")`
    );
  }

  console.log('\nthe wait after a reset');
  {
    const prog = {
      coding: true,
      byid: {},
      procs: {
        cabimain: [
          { op: 'const', v: 1 },
          { op: 'const', v: 120 },
          { op: 'call', name: 'settimer' },
          { op: 'const', v: 1 },
          { op: 'procref', kind: 2, n: 1 },
          { op: 'call', name: 'testtimer' },
          { op: 'endproc' },
        ],
      },
    };
    const t0 = Date.now();
    const H = await CD.runCodingDispatch(prog, {
      mode: 'read',
      runJob: async () => [],
      netto: [],
    });
    const waited = Date.now() - t0;
    ok(
      H.ok && waited >= 40,
      `testtimer sleeps instead of spinning (${waited} ms)`
    );
  }

  console.log(`\ncoding scripts: ${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
