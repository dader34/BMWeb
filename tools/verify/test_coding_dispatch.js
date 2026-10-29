#!/usr/bin/env node
// The coding dispatcher (core/coding/dispatch.js, dispatch-host.js) and the
// write that runs on it (core/coding/write.js), OFFLINE and end to end:
//
//   BMW's own coding script for the E46 cluster (data/coding-dispatch/c_kmb46)
//     -> this app's host callbacks
//       -> BMW's own coding SGBD jobs (data/ecu-src/c_kmb46), in the BEST/2 VM
//         -> a simulated cluster that answers the DS2 telegrams from a
//            1024-byte coding memory.
//
// Nothing here is a mock of the layers under test: the job order, the request
// buffers and the telegrams are whatever BMW's script and jobs make of what
// the host hands them. That is the point -- the mistakes this guards were all
// in the seams (a buffer one byte short, a byte sent as a word, a failed job
// that did not stop the run, a write that was never sent and still reported
// done), and a mock bus agreed with every one of them.
//
// WHAT THIS PROVES
//   1. The request buffer is BMW's: 21 header bytes, the data, a closing 0x03;
//      byte count, word count, address in words, mask; BinBuf words
//      little-endian. The real read jobs refuse a buffer one byte short.
//   2. A write sends the module's whole coding region -- what it holds NOW,
//      with the edits laid on -- and nothing of the manufacturer or reserved
//      blocks; the module ends up differing at the edit and at the checksum
//      BMW's job then recomputes; and it is proved by reading it back.
//   3. A failed job stops the run; a module that ignores the write, a wrong
//      coding index, an edit the script will not send, an edit outside the
//      coding description, a module addressed by block: each is an error,
//      and the ones that can be known in advance send nothing first.
//   4. A read run cannot write, and a call the host cannot serve stops the
//      run instead of being skipped.
//   5. The exporter (tools/export/ipo_exec.py --coding) still turns the
//      vendored A_KMB46.IPO into a runnable program.
//
//   node tools/verify/test_coding_dispatch.js
//
// The generated data it reads (data/ecu-src, app/renderer/data) is not in the
// repository; without it the end-to-end part is skipped, and says so.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const CD = require(path.join(ROOT, 'app/renderer/core/coding/dispatch.js'));
const HOST = require(
  path.join(ROOT, 'app/renderer/core/coding/dispatch-host.js')
);
const W = require(path.join(ROOT, 'app/renderer/core/coding/write.js'));
const E = require(path.join(ROOT, 'app/renderer/core/coding/encode.js'));

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ok    ${msg}`);
  } else {
    fail++;
    console.error(`  FAIL  ${msg}`);
  }
}
async function thrown(fn) {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  return null;
}

// ---- 1. the host's request buffer, on its own -------------------------------
async function hostChecks() {
  console.log('\nthe request buffer');
  const netto = Array.from({ length: 64 }, (_, i) => 0x40 + i);
  const cabd = {
    fields: [
      { name: 'WHOLE', word: 8, byte: 4, mask: 0xff },
      { name: 'ODD_BYTE', word: 21, byte: 1, mask: 0xff },
      { name: 'NIBBLE', word: 30, byte: 2, mask: 0x0f, masks: [0x0f, 0xff] },
    ],
    groups: [{ name: 'Grp', start: 40, length: 6 }],
  };
  const mk = (wb, extra) => {
    const h = new HOST.CdhHost({
      sgbd: 'X',
      runJob: async () => [],
      netto,
      cabd,
      ...extra,
    });
    h.CDHSetDataOrg(wb, wb === 2 ? 1 : 0, 0);
    return h;
  };
  const bytesOf = (h, buf) => HOST.binToBytes(h.bufs.get(buf));

  // word mode: two edited bytes in different words, one of them odd
  let h = mk(2, { changed: [9, 21] });
  let buf = h.CDHBinBufCreate();
  h.CDHActivateAllFsw();
  h.CDHGetNettoDataFromCbd();
  let r = h.CDHGetApiJobData(12, buf);
  let p = bytesOf(h, buf);
  ok(
    r.nrOfData === 1 && r.bufSize === 22 + 2 && p.length === 24,
    'one word: 22 + 2 bytes, as the script is told'
  );
  ok(
    p[0] === 1 && p[1] === 2 && p[2] === 1,
    'data type 1, word width 2, the byte order the description names'
  );
  ok(
    p[13] === 2 && p[14] === 0 && p[15] === 1 && p[16] === 0,
    'byte count 2 at 0x0D, word count 1 at 0x0F'
  );
  ok(p[17] === 4 && p[18] === 0, 'address in WORDS at 0x11: byte 8 is word 4');
  ok(p[9] === 0xff && p[10] === 0xff, 'a whole word: mask FF FF at 0x09');
  ok(
    p[21] === netto[8] && p[22] === netto[9],
    'the data is the image in address order, both bytes of the word'
  );
  ok(p[23] === 0x03, 'closed by 0x03');
  r = h.CDHGetApiJobData(12, buf);
  p = bytesOf(h, buf);
  ok(
    r.nrOfData === 1 &&
      p[17] === 10 &&
      p[21] === netto[20] &&
      p[22] === netto[21],
    'the next run starts at the next word that differs (an odd byte brings its word)'
  );
  ok(
    h.CDHGetApiJobData(12, buf).nrOfData === 0 && h.CDHCheckDataUsed() === 0,
    'then nothing, and everything was dealt out'
  );

  // consecutive words go together, up to the script's limit
  h = mk(2, { changed: Array.from({ length: 40 }, (_, i) => i) });
  buf = h.CDHBinBufCreate();
  h.CDHActivateAllFsw();
  h.CDHGetNettoDataFromCbd();
  r = h.CDHGetApiJobData(12, buf);
  ok(
    r.nrOfData === 12 && r.bufSize === 22 + 24,
    'a run is cut at the limit the script gives (12 words)'
  );
  ok(h.CDHCheckDataUsed() === 1, 'and the rest is still to come');

  // byte mode
  h = mk(1, { changed: [8, 9, 10] });
  buf = h.CDHBinBufCreate();
  h.CDHActivateAllFsw();
  h.CDHGetNettoDataFromCbd();
  r = h.CDHGetApiJobData(30, buf);
  p = bytesOf(h, buf);
  ok(
    r.nrOfData === 3 &&
      p.length === 25 &&
      p[13] === 3 &&
      p[15] === 3 &&
      p[17] === 8 &&
      p[24] === 3,
    'byte mode: 22 + N, both counts N, the address in bytes'
  );

  // a function by name: as it stands, with its own bits as the mask
  h = mk(2, { changed: [] });
  buf = h.CDHBinBufCreate();
  ok(
    h.CDHGetFswDataFromCbd('odd_byte') === 0,
    'a function is found whatever its case'
  );
  r = h.CDHGetApiJobData(12, buf);
  p = bytesOf(h, buf);
  ok(
    r.nrOfData === 1 && p[17] === 10 && p[9] === 0x00 && p[10] === 0xff,
    'asked for by name it is sent unchanged or not, its word masked to its own byte (00 FF)'
  );
  h.CDHGetFswDataFromCbd('NIBBLE');
  h.CDHGetApiJobData(12, buf);
  p = bytesOf(h, buf);
  ok(
    p[9] === 0x0f && p[10] === 0xff,
    'and a function of part of a byte to its own bits (0F FF)'
  );
  ok(
    h.CDHGetFswDataFromCbd('NO_SUCH') !== 0 && /NO_SUCH/.test(h.errInfo),
    'a name the description lacks is an error, not an empty success'
  );
  ok(h.CDHGetGrpDataFromCbd('NO_SUCH') !== 0, 'likewise a group');

  // switching off
  h = mk(1, { changed: [8, 9, 21, 41] });
  h.CDHActivateAllFsw();
  h.CDHInactivateFsw('WHOLE');
  h.CDHInactivateGrp('grp');
  h.CDHGetNettoDataFromCbd();
  ok(
    h.slots.length === 1 && h.slots[0].addr === 21,
    'a function or group switched off is left out of "everything"'
  );
  h.CDHInactivateAllFsw();
  h.CDHActivateGrp('Grp');
  h.CDHGetNettoDataFromCbd();
  ok(
    h.slots.length === 1 && h.slots[0].addr === 41,
    'a group switched on brings what differs in it, not all of it'
  );
  ok(
    h.CDHInactivateFsw('NOT_IN_THIS_INDEX') === 0,
    'switching a function this index lacks is not an error (one script, many indexes)'
  );

  // BinBuf words are the PC's: little-endian whatever the module's order
  h = mk(2, {});
  buf = h.CDHBinBufCreate();
  h.CDHBinBufWriteWord(buf, 0x1234, 5);
  p = bytesOf(h, buf);
  ok(
    p[5] === 0x34 && p[6] === 0x12 && h.CDHBinBufReadWord(buf, 5) === 0x1234,
    'BinBuf words are little-endian even for a high-byte-first module'
  );

  // the coding index
  h = new HOST.CdhHost({
    runJob: async () => [],
    netto,
    cabd: { ...cabd, codingIndex: [7, 8] },
  });
  ok(
    h.CDHCheckIdent('CODIERINDEX', '8', '') === 0 &&
      h.CDHCheckIdent('CODIERINDEX', 6, '') !== 0,
    "CDHCheckIdent holds the module to the description's coding indexes"
  );

  // a binary result arrives as bytes, and the answer must be the request's size
  h = mk(2, { mode: 'read', readAddrs: [8, 9] });
  buf = h.CDHBinBufCreate();
  h.CDHActivateAllFsw();
  h.CDHGetNettoMaskFromCbd();
  h.CDHGetApiJobData(16, buf);
  // a coding job answers with the request's own header in front of the data
  const sent = h.bufs.get(buf).bytes.slice(0, 21);
  h.lastSets = [
    {
      JOB_STATUS: 'OKAY',
      CODIER_DATEN: [...sent, 0xaa, 0xbb, 3],
    },
  ];
  ok(
    h.CDHapiResultBinary(buf, 'CODIER_DATEN', 1) === 0 &&
      h.CDHBinBufToNettoData(buf) === 0 &&
      h.netto[8] === 0xaa &&
      h.netto[9] === 0xbb,
    "an answer buffer fills the image at the request's address"
  );
  // as the factory tool checks it: a different header, or no closing 0x03
  for (const [what, bytes] of [
    [
      'header',
      [...sent.slice(0, 17), sent[17] ^ 1, ...sent.slice(18), 1, 2, 3],
    ],
    ['end', [...sent, 1, 2, 0]],
  ]) {
    h.cursor = 0;
    h.slots.forEach((x) => (x.flags = 0));
    h.CDHGetApiJobData(16, buf);
    h.lastSets = [{ JOB_STATUS: 'OKAY', CODIER_DATEN: bytes }];
    h.CDHapiResultBinary(buf, 'CODIER_DATEN', 1);
    ok(
      h.CDHBinBufToNettoData(buf) !== 0,
      `an answer with a different ${what} is refused`
    );
  }
  h.CDHGetNettoMaskFromCbd();
  h.CDHGetApiJobData(16, buf);
  h.lastSets = [{ JOB_STATUS: 'OKAY', CODIER_DATEN: new Array(21).fill(0) }];
  h.CDHapiResultBinary(buf, 'CODIER_DATEN', 1);
  ok(
    h.CDHBinBufToNettoData(buf) !== 0,
    'a short answer is an error, not zeros'
  );
  ok(
    h.CDHapiResultBinary(buf, 'NOT_THERE', 1) !== 0,
    'and so is a missing result'
  );
}

// ---- 2. the interpreter ------------------------------------------------------
async function interpreterChecks() {
  console.log('\nthe script interpreter');
  const c = (v) => ({ op: 'const', v });
  const L = (n) => ({ op: 'var', n, sc: 2 });
  const refL = (n) => ({ op: 'procref', kind: 2, n });
  const call = (name) => ({ op: 'call', name });
  const ret = { op: 'ret' };
  const seen = [];
  const run = (procs, opts = {}) =>
    CD.runCodingDispatch(
      { coding: true, procs, byid: { 'func:1': 'Sub', 'func:2': 'cabimain' } },
      {
        confirmed: true,
        runJob: async (sg, job, arg) => {
          seen.push([job, arg]);
          return [
            { JOB_STATUS: job === 'BAD' ? 'ERROR_ECU_REJECTED' : 'OKAY' },
          ];
        },
        ...opts,
      }
    );

  // locals with initial values; strcat / strlen / midstr
  seen.length = 0;
  let r = await run({
    cabimain: [
      { op: 'block' },
      { op: 'decl' },
      c('Cod_'),
      c(30),
      { op: 'decl' },
      ret,
      // L1 = "Cod_" + "X"
      refL(0),
      L(1),
      c('X'),
      call('strcat'),
      ret,
      // L3 = strlen(L0) = 5
      refL(3),
      L(0),
      call('strlen'),
      ret,
      refL(0),
      c('WBAEV33443KL12345L'),
      c(10),
      c(7),
      call('midstr'),
      ret,
      // job = L0, para = L3
      c(''),
      L(0),
      L(3),
      c(''),
      call('CDHapiJob'),
      ret,
      // para = L2 = 30
      c(''),
      c('MAX'),
      L(2),
      c(''),
      call('CDHapiJob'),
      ret,
      c(0),
      call('CDHSetReturnVal'),
      ret,
      { op: 'endproc' },
    ],
  });
  ok(
    r.ok && seen[0][0] === 'KL12345' && seen[0][1] === '5',
    'strcat, strlen and midstr (from 0) do what the scripts rely on'
  );
  ok(
    seen[1][1] === '30',
    'a local declared with a value has it (MaxData), in its slot behind the bare ones'
  );

  // exit stops everything, and what was recorded decides the outcome
  seen.length = 0;
  r = await run({
    __inpa_startup__: [
      c(2047),
      { op: 'store', n: 9, sc: 0 },
      { op: 'stmt' },
      ret,
      { op: 'calluser', n: 2 },
    ],
    cabimain: [
      c(''),
      c('BAD'),
      c(''),
      c(''),
      call('CDHapiJob'),
      ret,
      { op: 'calluser', n: 1 },
      ret,
      c(''),
      c('NEVER'),
      c(''),
      c(''),
      call('CDHapiJob'),
      ret,
      c(0),
      call('CDHSetReturnVal'),
      ret,
      { op: 'endproc' },
    ],
    Sub: [
      { op: 'block' },
      { op: 'decl' },
      ret,
      refL(0),
      c('JOB_STATUS'),
      c(1),
      c(''),
      call('CDHapiResultText'),
      ret,
      L(0),
      c('OKAY'),
      { op: 'binop', name: 'ne' },
      { op: 'jfalse', to: 99 },
      { op: 'var', n: 9, sc: 0 },
      c('A.IPS'),
      c('Cod'),
      c(7),
      c('BAD: rejected'),
      call('CDHSetError'),
      ret,
      { op: 'var', n: 9, sc: 0 },
      call('CDHSetReturnVal'),
      ret,
      call('exit'),
      ret,
      { op: 'endproc', at: 99 },
    ],
  });
  ok(
    !r.ok && r.err === 2047 && r.ret === 2047,
    "a failed job is recorded under the script's own error number (its startup sets them)"
  );
  ok(
    seen.length === 1 && !seen.some((s) => s[0] === 'NEVER'),
    '`exit` stops the run: nothing after the failed job is sent'
  );
  ok(/rejected/.test(r.info), 'and what failed is kept');

  // a call the host cannot serve: a write is refused before the run starts
  const unserved = {
    cabimain: [c('x'), call('CDHSomethingNew'), ret, { op: 'endproc' }],
  };
  seen.length = 0;
  const refusal = await thrown(() => run(unserved));
  ok(
    refusal &&
      /CDHSomethingNew/.test(refusal.message) &&
      /nothing is sent/.test(refusal.message) &&
      !seen.length,
    'a write whose script calls something the host lacks is refused before anything runs'
  );
  // and a read that reaches one stops there
  seen.length = 0;
  r = await run(
    {
      cabimain: [
        c('x'),
        call('CDHSomethingNew'),
        ret,
        c(''),
        c('NEVER'),
        c(''),
        c(''),
        call('CDHapiJob'),
        ret,
        c(0),
        call('CDHSetReturnVal'),
        ret,
        { op: 'endproc' },
      ],
    },
    { mode: 'read' }
  );
  ok(
    !r.ok &&
      r.err === CD.ERR_UNSUPPORTED_CALL &&
      /CDHSomethingNew/.test(r.info) &&
      !seen.length,
    'a call the host cannot serve stops the run and is named, instead of being skipped'
  );

  // a module addressed by block
  let e = await thrown(() =>
    run(
      { cabimain: [{ op: 'endproc' }] },
      { cabd: { typ: 'BLOCK', fields: [] } }
    )
  );
  ok(
    e && /by block/.test(e.message),
    'a module that numbers its coding blocks is refused'
  );
  e = await thrown(() =>
    run(
      { cabimain: [{ op: 'endproc' }] },
      { cabd: { fields: [{ name: 'A', word: 0, byte: 1, block: 1 }] } }
    )
  );
  ok(e && /by block/.test(e.message), 'also when only its functions say so');

  e = await thrown(() =>
    CD.runCodingDispatch(
      { coding: true, procs: {} },
      { runJob: async () => [] }
    )
  );
  ok(e && /confirmed/.test(e.message), 'refuses without opts.confirmed');

  // what a script is told about the car
  const sys = W._systemDataFor({ vin: 'wbaev33443kl12345' });
  ok(
    sys.FAHRGESTELL_NR === E.formatFahrgestellNr('WBAEV33443KL12345') &&
      sys.FAHRGESTELL_NR.length === 18 &&
      sys.WERK_NR === '0000',
    'the VIN reaches a script as 17 characters and their check character; the plant number as "not a plant"'
  );
  ok(
    !('FAHRGESTELL_NR' in W._systemDataFor({ vin: 'TOO-SHORT' })) &&
      W._systemDataFor({ systemData: { WERK_NR: '1234' } }).WERK_NR === '1234',
    'a VIN that is not one is left out; explicit system data wins'
  );
  // the script's placeholder does not replace what the caller said
  const h = new HOST.CdhHost({
    runJob: async () => [],
    systemData: { FAHRGESTELL_NR: sys.FAHRGESTELL_NR },
  });
  h.CDHSetSystemData('FAHRGESTELL_NR', 'ZZ000000000000000X');
  h.CDHSetSystemData('GM_SCHLUESSEL', 'FFFFFFFFP');
  ok(
    h.CDHGetSystemData('FAHRGESTELL_NR') === sys.FAHRGESTELL_NR &&
      h.CDHGetSystemData('GM_SCHLUESSEL') === 'FFFFFFFFP',
    "a script's own value fills what was not given and leaves what was"
  );
  e = await thrown(() =>
    CD.runCodingDispatch(
      { procs: {}, coding: false },
      { confirmed: true, runJob: async () => [] }
    )
  );
  ok(
    e && /coding-dispatcher/.test(e.message),
    'refuses a program that is not a coding dispatcher'
  );
}

// ---- 3. end to end -----------------------------------------------------------
/**
 * A cluster on the K line: 1024 bytes of coding memory behind DS2 address 0x80.
 * @param {Uint8Array} mem - the memory, read and written in place.
 * @param {{index?: number, refuse?: boolean, deaf?: boolean}} [o] - the coding
 *   index it identifies with, and how it misbehaves.
 * @returns {{exchange: Function, log: number[][], writes: () => number[][]}}
 */
function cluster(mem, o = {}) {
  const log = [];
  const ds2 = (body) => {
    const f = [0x80, body.length + 3, ...body];
    let x = 0;
    for (const b of f) x ^= b;
    return [...f, x];
  };
  const word = (out) => ((out[5] << 8) | out[6]) * 2;
  const exchange = async (out) => {
    log.push(Array.from(out));
    const cmd = out[2];
    // identification: the coding index is the sixth byte
    if (cmd === 0x00)
      return ds2([
        0xa0,
        0x06,
        0x90,
        0x12,
        0x34,
        0x22,
        o.index ?? 8,
        0x10,
        0x20,
        0x30,
        0x03,
        0x04,
        0x41,
        0x31,
        0x32,
        0x05,
        0,
        0,
        0,
        0,
        0,
      ]);
    if (cmd === 0x02)
      return ds2([0xa0, 0x4e, 0x4a, 0x87, 0x37, 0x90, 0x0c, 0, 0]);
    if (cmd === 0x06)
      return ds2([0xa0, ...mem.slice(word(out), word(out) + out[7] * 2)]);
    if (cmd === 0x07) {
      if (o.refuse) return ds2([0xb0]);
      if (!o.deaf)
        for (let i = 0; i < out[7] * 2; i++) mem[word(out) + i] = out[8 + i];
      return ds2([0xa0]);
    }
    return ds2([0xa0]);
  };
  return { exchange, log, writes: () => log.filter((t) => t[2] === 0x07) };
}

/**
 * One job on the VM against the simulated wire (the test's own, minimal runner).
 * @returns {Promise<object[]>} the job's result sets.
 */
async function jobOverBus(job, argText, o, sim, code, tables, Best2Vm) {
  const answers = new Map();
  for (let attempt = 0; attempt < 128; attempt++) {
    let missing = null;
    let seq = 0;
    const m = new Best2Vm(code, {
      tables,
      args: argText,
      allowWrites: !!(o && o.allowWrites),
      shared: new Map(),
      inited: false,
      comm: null,
      now: new Date(0),
      send: (out) => {
        const key = `${seq++}:${Array.from(out)}`;
        if (answers.has(key)) return answers.get(key);
        missing = { key, out: Array.from(out) };
        const e = new Error('need');
        e.need = true;
        throw e;
      },
    });
    try {
      return m.run(job, argText);
    } catch (e) {
      if (!missing || !e.need) throw e;
      answers.set(missing.key, await sim.exchange(missing.out));
    }
  }
  throw new Error('did not settle');
}

async function endToEnd() {
  console.log(
    "\nend to end: BMW's cluster script and jobs against a simulated cluster"
  );
  const need = [
    'data/ecu-src/c_kmb46.job-code.json.gz',
    'data/ecu-src/c_gm5.job-code.json.gz',
    'app/renderer/data/coding-dispatch/c_kmb46.json',
    'app/renderer/data/daten/E46.json',
  ];
  const missing = need.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  if (missing.length) {
    console.log(`  skip  generated data not on disk (${missing.join(', ')})`);
    return;
  }
  const { loadBestvm } = require('./load_bestvm.js');
  const ctx = { module: { exports: {} }, console };
  vm.createContext(ctx);
  const { Best2Vm } = loadBestvm(ctx);
  const gz = (f) =>
    JSON.parse(
      zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'data/ecu-src', f)))
    );
  const code = gz('c_kmb46.job-code.json.gz');
  let tables = {};
  try {
    tables = gz('c_kmb46.tables.json.gz');
  } catch {
    /* an SGBD without tables */
  }
  const dispatch = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, 'app/renderer/data/coding-dispatch/c_kmb46.json'),
      'utf8'
    )
  );
  // the cluster's coding file under NCS's own name (daten_files.py)
  const kombi = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'app/renderer/data/daten/E46.json'), 'utf8')
  ).modules.KMB_E46;
  const variant = Object.keys(kombi.chassis.E46).find((k) =>
    k.split('+').includes('C08')
  );
  const fields = kombi.chassis.E46[variant];
  const lay = kombi.layout && kombi.layout.E46 && kombi.layout.E46[variant];
  ok(
    !!lay &&
      lay.typ === 'FREI' &&
      lay.wortBreite === 2 &&
      lay.index.includes(8),
    "the field map carries the cluster's layout: one address space, 2-byte words, coding index 8"
  );
  if (!lay) return;
  const cabd = {
    fields,
    groups: lay.groups.map(([name, start, length, block, kind]) => ({
      name,
      start,
      length,
      block,
      kind,
    })),
    codingIndex: lay.index,
    typ: lay.typ,
  };
  ok(
    cabd.groups.some(
      (g) => g.name === 'ZCS' && g.start === 368 && g.length === 20
    ) && cabd.groups.some((g) => g.name === 'Var_Fahrzeugparameter'),
    "and the named blocks BMW's script switches by name (ZCS at 368, Var_Fahrzeugparameter)"
  );

  // -- the real jobs refuse a buffer one byte short ---------------------------
  const runJobRaw = (sg, job, bytes) => {
    const c = sg === 'c_kmb46' ? code : gz(`${sg}.job-code.json.gz`);
    const args = String.fromCharCode(...bytes);
    let sent = false;
    const m = new Best2Vm(c, {
      tables: {},
      args,
      allowWrites: true,
      shared: new Map(),
      inited: false,
      comm: null,
      now: new Date(0),
      send: () => {
        sent = true;
        throw new Error('wire');
      },
    });
    try {
      return m.run(job, args)[0].JOB_STATUS;
    } catch (e) {
      if (sent) return 'reached the wire';
      throw e;
    }
  };
  const buffer = (n, wb, closed) => {
    const p = new Array(21 + n * wb + (closed ? 1 : 0)).fill(0);
    p[0] = 1;
    p[1] = wb;
    p[13] = n * wb;
    p[15] = n;
    if (closed) p[p.length - 1] = 3;
    return p;
  };
  ok(
    runJobRaw('c_kmb46', 'C_S_LESEN', buffer(4, 2, false)) ===
      'ERROR_BIN_BUFFER' &&
      runJobRaw('c_kmb46', 'C_S_LESEN', buffer(4, 2, true)) ===
        'reached the wire',
    "the cluster's read job refuses 21 + N bytes and takes 22 + N"
  );
  ok(
    runJobRaw('c_gm5', 'C_C_LESEN', buffer(4, 1, false)) ===
      'ERROR_BIN_BUFFER' &&
      runJobRaw('c_gm5', 'C_C_LESEN', buffer(4, 1, true)) ===
        'reached the wire',
    "so does the body module's"
  );

  // -- a coding memory to work on ---------------------------------------------
  // A real read when there is one (never in the repository), else a made-up
  // one; both are completed to the layout's 1024 bytes.
  const realPath =
    process.env.KMB_EEPROM ||
    path.join(
      process.env.HOME || '',
      'Desktop/e46bins/KOMBI-cluster/kombi46-EEPROM_LESEN-tuned.bin'
    );
  const fresh = () => {
    const mem = new Uint8Array(1024);
    for (let i = 0; i < mem.length; i++) mem[i] = (i * 37 + 11) & 0xff;
    if (fs.existsSync(realPath))
      mem.set(fs.readFileSync(realPath).subarray(0, 1024));
    return mem;
  };
  const field = (name) => fields.find((f) => f.name === name);
  const flip = (name, mem) => ({
    rule: field(name),
    value: E.decodeField(field(name), mem) ? 0 : 1,
  });
  ok(
    field('TEMPERATUR_EINHEIT').word === 0x71 &&
      field('ZEIT_EINHEIT').word === 0x71,
    'two one-bit settings share byte 0x71 (an odd address)'
  );
  const write = (want, base, sim, extra = {}) =>
    W.writeCoding('c_kmb46', Array.from(want), {
      confirmed: true,
      exchange: sim.exchange,
      code,
      tables,
      jobs: code.jobs,
      Best2Vm,
      dispatch,
      dataOrg: dispatch.dataOrg,
      cabd,
      base: base ? Array.from(base) : undefined,
      now: new Date(0),
      ...extra,
    });
  const changed = (a, b) => {
    const out = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push(i);
    return out;
  };
  const at = (list) => list.map((a) => `0x${a.toString(16)}`).join(' ');

  // -- the write ---------------------------------------------------------------
  {
    const mem = fresh();
    const base = Uint8Array.from(mem);
    const want = E.spliceEdits(mem, [
      flip('TEMPERATUR_EINHEIT', mem),
      flip('ZEIT_EINHEIT', mem),
    ]);
    // the module moved on since the read the edits were made on: the other
    // byte of the word is no longer what the base says
    mem[0x70] ^= 0x10;
    const live70 = mem[0x70];
    const sim = cluster(mem);
    const r = await write(want, base, sim);
    const jobs = r.log.map((l) => l.job);
    ok(r.ok && r.strategy === 'dispatch', 'the write reports done');
    const order = jobs.join(',').replace(/(C_S_\w+)(,\1)+/g, '$1*');
    ok(
      order ===
        'IDENT,C_S_LESEN,C_S_SCHREIBEN*,C_FG_LESEN,C_S_AUFTRAG*,C_CHECKSUM,SOFTWARE_RESET',
      `BMW's order: identify, read the status word, the service data, read the VIN, the coding blocks, checksum, reset (${order})`
    );
    const wr = sim.writes();
    // every word of the coding blocks went out, none of the others
    const sentWords = new Set();
    for (const t of wr.slice(0, -1))
      for (let i = 0; i < t[7]; i++) sentWords.add(((t[5] << 8) | t[6]) + i);
    const codingWords = new Set();
    const otherWords = new Set();
    for (const g of cabd.groups)
      for (let a = g.start; a < g.start + g.length; a++)
        (g.kind === 'coding' ? codingWords : otherWords).add(a >> 1);
    ok(
      sentWords.size === codingWords.size &&
        [...codingWords].every((w) => sentWords.has(w)) &&
        ![...otherWords].some((w) => sentWords.has(w) && !codingWords.has(w)),
      `the whole coding region went out (${sentWords.size} words: every coding block, the central key's among them), no manufacturer or reserved block with it`
    );
    const carrier = wr.find(
      (t) => ((t[5] << 8) | t[6]) <= 0x38 && ((t[5] << 8) | t[6]) + t[7] > 0x38
    );
    const off = 8 + (0x38 - ((carrier[5] << 8) | carrier[6])) * 2;
    ok(
      carrier[off] === live70 && carrier[off + 1] === want[0x71],
      'word 0x38 carries the edited byte, and its neighbour as the module holds it now'
    );
    const ck = wr[wr.length - 1];
    ok(
      ck[6] === 0xb7 && ck[9] === base[0x16f],
      'the checksum job stores its byte and leaves the "coding done" flag beside it alone'
    );
    const diff = changed(mem, base);
    ok(
      String(diff) === String([0x70, 0x71, 0x16e]) &&
        mem[0x70] === live70 &&
        mem[0x71] === want[0x71],
      `the module differs from before at the edit and the checksum only (${at(diff)})`
    );
    ok(
      mem[0x16e] === (base[0x16e] ^ base[0x71] ^ want[0x71] ^ 0x10),
      "and the checksum BMW's job computed follows the two changed bytes"
    );
    ok(
      String(r.edited) === String([0x71]) &&
        r.addrs.includes(0x70) &&
        r.addrs.length > 250 &&
        r.after[r.addrs.indexOf(0x71)] === want[0x71] &&
        !r.moved.length,
      `the result names the edit, everything written (${r.addrs.length} bytes) and what read back`
    );
    ok(
      !sim.log.some((t) => t[2] === 0x0c),
      'no service-interval reset: the plant number says "not on the line"'
    );
    const firstWrite = sim.log.findIndex((t) => t[2] === 0x07);
    const readsBefore = sim.log
      .slice(0, firstWrite)
      .filter(
        (t) =>
          t[2] === 0x06 &&
          ((t[5] << 8) | t[6]) <= 0x38 &&
          ((t[5] << 8) | t[6]) + t[7] > 0x38
      ).length;
    ok(
      readsBefore === 1,
      'the word is read through the script before anything is written'
    );
    const lastWrite = sim.log.map((t) => t[2]).lastIndexOf(0x07);
    const covers38 = (t) =>
      t[2] === 0x06 &&
      ((t[5] << 8) | t[6]) <= 0x38 &&
      ((t[5] << 8) | t[6]) + t[7] > 0x38;
    ok(
      sim.log.slice(lastWrite + 1).some(covers38),
      'and read back through it afterwards'
    );
  }

  // -- nothing to do -------------------------------------------------------------
  {
    const mem = fresh();
    const sim = cluster(mem);
    const r = await write(mem, mem, sim);
    ok(
      r.ok && /no write/.test(r.note) && !sim.log.length,
      'an image with no edits sends nothing at all'
    );
  }

  // -- without a base image ------------------------------------------------------
  {
    const mem = fresh();
    const base = Uint8Array.from(mem);
    const want = E.spliceEdits(mem, [flip('TEMPERATUR_EINHEIT', mem)]);
    const sim = cluster(mem);
    const r = await write(want, null, sim);
    ok(
      r.ok && String(changed(mem, base)) === String([0x71, 0x16e]),
      'without a base the edit is found by reading the module, and written the same'
    );
    const other = fresh();
    for (let i = 0x70; i < 0x170; i++) other[i] ^= 0x5a;
    const sim2 = cluster(fresh());
    const e = await thrown(() => write(other, null, sim2));
    ok(
      e && /not an edit/.test(e.message) && !sim2.writes().length,
      'an image that differs all over is refused as a wrong layout, unwritten'
    );
  }

  // -- the module says no ---------------------------------------------------------
  {
    const mem = fresh();
    const base = Uint8Array.from(mem);
    const want = E.spliceEdits(mem, [flip('TEMPERATUR_EINHEIT', mem)]);
    const sim = cluster(mem, { refuse: true });
    const e = await thrown(() => write(want, base, sim));
    ok(
      e &&
        e.code === 'ERROR_VERIFY' &&
        /C_S_(SCHREIBEN|AUFTRAG)/.test(e.message),
      `a refused write is an error naming the job (${e && e.message.slice(0, 96)})`
    );
    ok(
      sim.writes().length === 1 && !sim.log.some((t) => t[2] === 0x12),
      'and the run stops there: no checksum, no reset after it'
    );
    ok(!changed(mem, base).length, 'the module is as it was');
  }
  {
    const mem = fresh();
    const base = Uint8Array.from(mem);
    const want = E.spliceEdits(mem, [flip('TEMPERATUR_EINHEIT', mem)]);
    const sim = cluster(mem, { deaf: true });
    const e = await thrown(() => write(want, base, sim));
    ok(
      e && e.code === 'ERROR_VERIFY',
      'a module that acknowledges and does not store is caught (the job reads its own write back)'
    );
  }

  // -- the wrong coding index ------------------------------------------------------
  {
    const mem = fresh();
    const base = Uint8Array.from(mem);
    const want = E.spliceEdits(mem, [flip('TEMPERATUR_EINHEIT', mem)]);
    const sim = cluster(mem, { index: 6 });
    const e = await thrown(() => write(want, base, sim));
    ok(
      e && /coding index is 6/.test(e.message) && !sim.writes().length,
      'a module on another coding index is refused before anything is written'
    );
  }

  // -- an edit the script will not send ---------------------------------------------
  {
    const mem = fresh();
    const base = Uint8Array.from(mem);
    const want = Uint8Array.from(mem);
    want[field('CHECKSUM').word] ^= 0xff;
    const sim = cluster(mem);
    const e = await thrown(() => write(want, base, sim));
    ok(
      e && e.code === 'ERROR_VERIFY' && /without sending/.test(e.message),
      'an edit to something the script switches off (the checksum) is reported as not written, not as done'
    );
  }

  // -- an edit outside the description, and the refusals that need no wire ------------
  {
    const mem = fresh();
    const want = Uint8Array.from(mem);
    const covered = new Uint8Array(1024);
    for (const f of fields)
      for (let i = 0; i < f.byte; i++) covered[f.word + i] = 1;
    const hole = covered.indexOf(0);
    want[hole] ^= 1;
    const sim = cluster(mem);
    let e = await thrown(() => write(want, mem, sim));
    ok(
      e &&
        /outside what the coding description covers/.test(e.message) &&
        !sim.log.length,
      `an edit at an address no function owns (0x${hole.toString(16)}) is refused, unsent`
    );
    e = await thrown(() => write(want, mem, sim, { cabd: undefined }));
    ok(
      e && /needs the coding description/.test(e.message) && !sim.log.length,
      'so is a write without the coding description'
    );
    e = await thrown(() => write(want.subarray(0, 1023), null, sim));
    ok(
      e && /2-byte words/.test(e.message),
      'and an image that is not whole words'
    );
    e = await thrown(() =>
      W.writeCoding('c_kmb46', Array.from(want), {
        exchange: sim.exchange,
        dispatch,
        cabd,
      })
    );
    ok(e && /confirmed/.test(e.message), 'and anything unconfirmed');
    // the old way in: the bare image handed to the job
    e = await thrown(() =>
      W.writeCoding('c_kmb46', Array.from(want), {
        confirmed: true,
        exchange: sim.exchange,
        code,
        tables,
        jobs: code.jobs,
        Best2Vm,
      })
    );
    ok(
      e && /through its dispatcher/.test(e.message) && !sim.log.length,
      'without its dispatcher the cluster is not written: C_S_AUFTRAG takes request buffers, not an image'
    );
  }

  // -- a read run ------------------------------------------------------------------
  {
    const mem = fresh();
    const sim = cluster(mem);
    const all = [];
    for (let a = 0; a < 1024; a++) all.push(a);
    const r = await CD.runCodingDispatch(dispatch, {
      confirmed: true,
      sgbd: 'c_kmb46',
      runJob: (sg, job, argText, o) =>
        jobOverBus(job, argText, o, sim, code, tables, Best2Vm),
      cabd,
      dataOrg: dispatch.dataOrg,
      mode: 'read',
      jobname: 'CODIERDATEN_LESEN',
      netto: new Array(1024).fill(0),
      readAddrs: all,
    });
    ok(
      r.ok && r.read.length === 1024 && r.netto.every((b, i) => b === mem[i]),
      'a read run returns the whole coding memory, byte for byte'
    );
    ok(
      !sim.writes().length &&
        sim.log.filter((t) => t[2] === 0x06).every((t) => t[7] <= 16),
      "with nothing but reads on the wire, 16 words at a time (the script's own limit)"
    );
  }
}

// ---- 4. the exporter ---------------------------------------------------------
function exporterChecks() {
  console.log('\nthe exporter');
  const exporter = path.join(ROOT, 'tools/export/ipo_exec.py');
  const ipo = path.join(ROOT, 'vendor/EC-APPS/INPA/SGDAT/A_KMB46.IPO');
  if (!fs.existsSync(exporter) || !fs.existsSync(ipo)) {
    console.log('  skip  the vendored A_KMB46.IPO is not on disk');
    return;
  }
  const out = path.join(require('os').tmpdir(), 'A_KMB46.test.ipoexec.json');
  const args = [exporter, 'A_KMB46', out, '--coding'];
  const daten = path.join(ROOT, 'vendor/EC-APPS/NCSEXPER/DATEN');
  for (const chassis of fs.existsSync(daten) ? fs.readdirSync(daten) : []) {
    let files;
    try {
      files = fs.readdirSync(path.join(daten, chassis));
    } catch {
      continue;
    }
    const m = files.find((f) => /^KMB_E46\.C0/i.test(f));
    if (m) {
      args.push(`--cabd=${path.join(daten, chassis, m)}`);
      break;
    }
  }
  execFileSync('python3', args, { cwd: ROOT });
  const exec = JSON.parse(fs.readFileSync(out, 'utf8'));
  ok(
    exec.coding === true && !!exec.procs.cabimain && !!exec.procs.Cod,
    'A_KMB46.IPO exports as a coding program with cabimain and Cod'
  );
  ok(
    !exec.dataOrg ||
      (exec.dataOrg.wortBreite === 2 && exec.dataOrg.byteFolge === 1),
    "carrying the cluster's word organisation (2-byte words, high byte first)"
  );
  ok(
    exec.procs.cabimain.some((t) => t.op === 'const' && t.v === 'JOBNAME'),
    'and its constants inlined (cabimain asks for JOBNAME)'
  );
}

(async () => {
  await hostChecks();
  await interpreterChecks();
  await endToEnd();
  exporterChecks();
  console.log(`\ncoding dispatch: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
