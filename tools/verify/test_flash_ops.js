#!/usr/bin/env node
// The flash module (app/renderer/core/flash-ops.js) and the remote engine's
// side of it: a whole flashing operation crosses to a shared car's owner as
// one request, and the owner runs it on its own cable.
//
// WHAT THIS PROVES
//   1. A payload survives the data channel: bytes go as base64 and come
//      back identical for every operation; a payload that is not the
//      operation's shape (wrong length, too large, unknown operation, a
//      record that is not one) is refused before anything runs.
//   2. The operations drive the cable in the documented order with the
//      helper's prepared images, against stubbed primitives: the DME's
//      session, erase, write, record, verify; the transmission's writer
//      with the module's state carried on failure.
//   3. The owner's registry: one operation at a time, with its own session
//      log; a second one is refused while the first runs.
//   4. The engine's transport for it: a message over the channel's size
//      goes as ordered parts and joins again, out-of-bounds parts are
//      dropped; the operation route crosses the wire and needs approval.
//
// Run: node tools/verify/test_flash_ops.js
const assert = require('assert');
global.window = undefined;
global.crypto = require('crypto').webcrypto;
global.Response = class {
  constructor(b, o) {
    this.body = b;
    this.status = (o || {}).status;
    this.ok = !this.status || this.status === 200;
  }
  async json() {
    return JSON.parse(this.body);
  }
};

let passed = 0;
const ok = (m) => {
  passed++;
  console.log(`  ok    ${m}`);
};
const bytes = (n, seed) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 7 + seed) & 0xff;
  return b;
};

// ---- the module needs the DME's constants and primitives as globals ----
global.MS45_CAL_LENGTH = 0x1d000;
global.MS45_FULL_FLASH_LENGTH = 0x100000;
global.MS45_MPC_LENGTH = 0x70000;
global.MS45_CAL_START = 0x40000;
global.MS45_PROGRAM_START = 0x60000;
const calls = [];
global.ms45SecurityAccess = async (proto, stage) => {
  calls.push(['unlock', proto]);
  stage('Requesting Security Access');
  return !global.refuseUnlock;
};
global.ms45Job = async (job, arg) => {
  calls.push(['job', job, String(arg)]);
  return { ok: true, status: 'OKAY', res: { sets: [] } };
};
global.ms45Erase = async (start, length) => {
  calls.push(['erase', start, length]);
  return true;
};
global.ms45FlashBlock = async (data, start, end, opts) => {
  calls.push(['write', start, end, data.length]);
  opts.onProgress(50);
  opts.onProgress(100);
  return global.failWriteAt == null || global.failWriteAt !== start;
};
global.ms45WriteAif = async (args) => {
  calls.push(['aif', args]);
  return { ok: true, status: 'OKAY', number: '3' };
};
global.ms45FinishFlash = async (area, reset, proto, stage) => {
  calls.push(['finish', area, reset]);
  stage('Checking signature');
  return true;
};
global.ms45SetJobTrace = () => {};
global.ms45Checksums = {
  correctParameterChecksums: (c) => c,
  signParameters: (c) => c,
  correctProgramChecksums: (f) => f,
  signProgram: (f) => f,
};
global.gs20WriteCalibration = async (cal, opts) => {
  calls.push([
    'tcu-cal',
    cal.length,
    !!opts.fast,
    opts.aifRecord && opts.aifRecord.length,
  ]);
  opts.onStage('unlocking');
  opts.onProgress(100);
  if (global.failTcu) {
    const e = new Error('the transmission did not confirm');
    e.eraseStarted = true;
    throw e;
  }
  return { eraseStarted: true, aif: { left: 11 } };
};
global.gs20WriteProgram = async (prog, opts) => {
  calls.push([
    'tcu-program',
    prog.length,
    opts.calibration && opts.calibration.length,
  ]);
  opts.onStage('erasing, 1 of 4');
  if (global.failTcu) {
    const e = new Error('lost the module after the program');
    e.erasedSectors = 4;
    e.programWritten = true;
    e.calibrationEraseStarted = false;
    throw e;
  }
  return { aif: null };
};
global.ms45ReadMemory = async (start, end, segment, opts) => {
  calls.push(['read', segment, start, end]);
  opts && opts.onProgress && opts.onProgress(100);
  return bytes(end - start + 1, segment === 'LAR' ? 9 : 8);
};
global.ms45LeaveProgrammingMode = async () => {
  calls.push(['leave']);
  return true;
};
global.gs20ReadCalibration = async (opts) => {
  calls.push(['tcu-cal-read', !!opts.fast]);
  opts.onProgress(100);
  return bytes(0x10000, 12);
};
global.gs20ReadFull = async (opts) => {
  calls.push(['tcu-full-read', !!opts.fast]);
  opts.onStage('reading');
  return bytes(0x80000, 13);
};
global.mapSwitch = {
  CALIBRATION_START: 0x40000,
  CALIBRATION_LENGTH: 0x1d000,
  MAP2_START: 0xe0000,
  MAP2_LENGTH: 0x18000,
  map2AsCalibration: (area) => {
    const cal = new Uint8Array(0x1d000).fill(0xff);
    cal.set(area, 0);
    return cal;
  },
};
const logLines = [];
global.flashLog = {
  async start(op, car) {
    logLines.push(`start ${op} ${car.module}`);
  },
  note: (t) => logLines.push(`note ${t}`),
  attach: (n) => logLines.push(`attach ${n}`),
  trace: () => {},
  job: () => {},
  async stop() {
    logLines.push('stop');
  },
};

const {
  flashOps,
  flashOperations,
} = require('../../app/renderer/core/flash-ops.js');

(async () => {
  // ---- 1. payloads cross the channel whole, wrong ones are refused ----------
  console.log('\npayloads');
  const cal = bytes(0x1d000, 1);
  const text = flashOps.encode({
    cal,
    diagProtocol: 'KWP-2000*',
    aifArgs: 'WBA;01.01.2026;x',
    describe: 'DME calibration',
    vin: 'WBAET37414NG12345',
    hwRef: '0044570',
  });
  const back = flashOps.decode('dme-tune', text);
  assert.deepStrictEqual(back.cal, cal);
  assert.strictEqual(back.diagProtocol, 'KWP-2000*');
  assert.strictEqual(back.aifArgs, 'WBA;01.01.2026;x');
  const prog = flashOps.decode(
    'dme-program',
    flashOps.encode({
      flash: bytes(0x100000, 2),
      mpc: bytes(0x70000, 3),
      hasCal: true,
      diagProtocol: 'BMW-FAST',
      aifArgs: null,
    })
  );
  assert.strictEqual(prog.flash.length, 0x100000);
  assert.strictEqual(prog.mpc[5], bytes(0x70000, 3)[5]);
  assert.strictEqual(prog.hasCal, true);
  assert.strictEqual(prog.aifArgs, null);
  const tcu = flashOps.decode(
    'tcu-program',
    flashOps.encode({
      program: bytes(0x40000, 4),
      calibration: bytes(0x10000, 5),
      fast: true,
      aifRecord: bytes(40, 6),
    })
  );
  assert.strictEqual(tcu.program.length, 0x40000);
  assert.strictEqual(tcu.calibration.length, 0x10000);
  assert.strictEqual(tcu.aifRecord.length, 40);
  const tcuNoCal = flashOps.decode(
    'tcu-program',
    flashOps.encode({
      program: bytes(0x40000, 4),
      calibration: null,
      fast: false,
      aifRecord: null,
    })
  );
  assert.strictEqual(tcuNoCal.calibration, null);
  assert.strictEqual(tcuNoCal.aifRecord, null);
  ok("every operation's payload round-trips through base64 JSON");

  assert.throws(
    () => flashOps.decode('dme-tune', flashOps.encode({ cal: bytes(100, 1) })),
    /cal: expected 118784 bytes, got 100/
  );
  assert.throws(
    () =>
      flashOps.decode(
        'tcu-cal',
        flashOps.encode({
          calibration: bytes(0x10000, 1),
          aifRecord: bytes(500, 1),
        })
      ),
    /aifRecord: 500 bytes is not a record/
  );
  assert.throws(
    () => flashOps.decode('dme-tune', 'x'.repeat(5 * 1024 * 1024)),
    /too large/
  );
  assert.throws(() => flashOps.decode('dme-tune', 42), /missing/);
  assert.throws(
    () => flashOps.decode('bootloader', '{}'),
    /unknown flashing operation/
  );
  assert.deepStrictEqual(await flashOps.run('bootloader', {}), {
    ok: false,
    status: 'unknown flashing operation: bootloader',
  });
  ok(
    'a wrong length, a record that is not one, an oversize or non-string payload and an unknown operation are refused'
  );

  // ---- 2. the operations drive the cable in order ------------------------------
  console.log('\noperations');
  calls.length = 0;
  const stages = [];
  const progress = [];
  let r = await flashOps.run('dme-tune', back, {
    stage: (s) => stages.push(s),
    progress: (p, w) => progress.push(`${w} ${p}`),
  });
  assert.deepStrictEqual(r, { ok: true, status: 'Flash successful' });
  assert.deepStrictEqual(
    calls.map((c) => c[0]),
    ['unlock', 'erase', 'write', 'aif', 'finish']
  );
  assert.deepStrictEqual(calls[1], ['erase', 0x2040000, 0x20000]);
  assert.deepStrictEqual(calls[2], ['write', 0x2040000, 0x205cfff, 0x1d000]);
  assert.deepStrictEqual(calls[3], ['aif', 'WBA;01.01.2026;x']);
  assert.deepStrictEqual(calls[4], ['finish', 'Daten', true]);
  assert.ok(
    stages.includes('Erasing Flash') &&
      stages.includes('Flashing ECU') &&
      stages.includes('AIF written (entry 3)')
  );
  assert.deepStrictEqual(progress, ['Flashing 50', 'Flashing 100']);
  ok(
    'Flash Tune: unlock, erase 0x2040000, write the partition, the record, verify Daten with a reset'
  );

  calls.length = 0;
  r = await flashOps.run('dme-program', prog);
  assert.deepStrictEqual(r, { ok: true, status: 'Flash successful' });
  assert.deepStrictEqual(
    calls.map((c) => c[0]),
    [
      'unlock',
      'job',
      'job',
      'erase',
      'write',
      'write',
      'erase',
      'write',
      'finish',
      'finish',
    ]
  );
  assert.deepStrictEqual(calls[1], [
    'job',
    'normaler_datenverkehr',
    'nein;nein;ja',
  ]);
  assert.deepStrictEqual(calls[3], ['erase', 0x2060000, 0xa0000]);
  assert.deepStrictEqual(calls[4], ['write', 0x2060000, 0x20fff3f, 0x9ff40]);
  assert.deepStrictEqual(calls[5], ['write', 0, 0x6ffff, 0x70000]);
  assert.deepStrictEqual(calls[6], ['erase', 0x2040000, 0x20000]);
  assert.deepStrictEqual(calls[7], ['write', 0x2040000, 0x205cfff, 0x1d000]);
  assert.deepStrictEqual(calls[8], ['finish', 'Programm', false]);
  assert.deepStrictEqual(calls[9], ['finish', 'Daten', true]);
  assert.ok(
    !calls.some((c) => c[0] === 'aif'),
    'no record when the helper sent none'
  );
  ok(
    'Flash Program (BMW-FAST): session switch, erase, external, MPC, calibration, verify Programm then Daten; no record when none was prepared'
  );

  calls.length = 0;
  global.failWriteAt = 0; // the MPC write fails
  r = await flashOps.run('dme-program', { ...prog, hasCal: false });
  assert.deepStrictEqual(r, { ok: false, status: 'Flash failed' });
  assert.ok(
    !calls.some((c) => c[0] === 'finish' || c[0] === 'aif'),
    'nothing verified or recorded after a failed write'
  );
  global.failWriteAt = 0x2040000;
  r = await flashOps.run('dme-tune', back);
  assert.deepStrictEqual(r, { ok: false, status: 'Flash failed' });
  global.failWriteAt = null;
  global.refuseUnlock = true;
  r = await flashOps.run('dme-tune', back);
  assert.deepStrictEqual(r, { ok: false, status: 'Security Access Denied' });
  global.refuseUnlock = false;
  r = await flashOps.run('dme-tune', { ...back, cal: bytes(10, 1) });
  assert.match(r.status, /not a 0x1D000-byte calibration/);
  ok(
    'a failed write, a refused unlock and a wrong image stop the operation where they happen'
  );

  calls.length = 0;
  r = await flashOps.run('tcu-cal', {
    calibration: bytes(0x10000, 5),
    fast: true,
    aifRecord: bytes(40, 6),
  });
  assert.deepStrictEqual(r, {
    ok: true,
    status: 'Calibration written',
    eraseStarted: true,
    aifLeft: 11,
  });
  assert.deepStrictEqual(calls[0], ['tcu-cal', 0x10000, true, 40]);
  r = await flashOps.run('tcu-program', tcu);
  assert.deepStrictEqual(r, {
    ok: true,
    status: 'Program and calibration written',
    aifLeft: null,
  });
  global.failTcu = true;
  r = await flashOps.run('tcu-cal', {
    calibration: bytes(0x10000, 5),
    fast: false,
    aifRecord: null,
  });
  assert.deepStrictEqual(r, {
    ok: false,
    status: 'the transmission did not confirm',
    eraseStarted: true,
  });
  r = await flashOps.run('tcu-program', tcuNoCal);
  assert.deepStrictEqual(r, {
    ok: false,
    status: 'lost the module after the program',
    erasedSectors: 4,
    programWritten: true,
    calibrationEraseStarted: false,
  });
  global.failTcu = false;
  ok(
    "the transmission's writes: the writer's result and, on failure, the module's state, as a result the channel can carry"
  );

  // ---- 2b. the reads come back as bytes ------------------------------------------
  calls.length = 0;
  r = await flashOps.run('dme-read', { diagProtocol: 'KWP-2000*', full: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.flash.length, 0x100000);
  assert.strictEqual(r.mpc.length, 0x70000);
  assert.deepStrictEqual(
    calls.map((c) => c[0]),
    ['unlock', 'read', 'read', 'leave']
  );
  assert.deepStrictEqual(calls[1], ['read', 'ROMX', 0, 0xfffff]);
  assert.deepStrictEqual(calls[2], ['read', 'LAR', 0, 0x6ffff]);
  calls.length = 0;
  r = await flashOps.run('dme-read', { diagProtocol: 'BMW-FAST', full: false });
  assert.strictEqual(r.flash.length, 0x1d000);
  assert.strictEqual(r.mpc, null);
  assert.deepStrictEqual(
    calls.map((c) => c[0]),
    ['read', 'leave'],
    'BMW-FAST reads without the unlock'
  );
  r = await flashOps.run('dme-maps-read', {
    diagProtocol: 'BMW-FAST',
    layout: 'copy',
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.map1.length, 0x1d000);
  assert.strictEqual(r.maps.length, 1);
  assert.strictEqual(r.maps[0].length, 0x1d000);
  r = await flashOps.run('tcu-cal-read', { fast: true });
  assert.strictEqual(r.image.length, 0x10000);
  r = await flashOps.run('tcu-full-read', { fast: false });
  assert.strictEqual(r.image.length, 0x80000);
  assert.ok(
    !flashOps.writes('dme-read') &&
      !flashOps.writes('tcu-full-read') &&
      flashOps.writes('tcu-cal') &&
      flashOps.writes('dme-program')
  );
  const enc = flashOps.encodeResult({
    ok: true,
    status: 's',
    map1: bytes(10, 1),
    maps: [bytes(5, 2), bytes(5, 3)],
    n: 4,
  });
  assert.deepStrictEqual(enc._bytes, ['map1', 'maps']);
  assert.strictEqual(typeof enc.map1, 'string');
  const dec = flashOps.decodeResult(JSON.parse(JSON.stringify(enc)));
  assert.deepStrictEqual(dec.map1, bytes(10, 1));
  assert.deepStrictEqual(dec.maps, [bytes(5, 2), bytes(5, 3)]);
  assert.strictEqual(dec.n, 4);
  assert.strictEqual(dec._bytes, undefined);
  assert.deepStrictEqual(flashOps.decodeResult({ ok: false, status: 'x' }), {
    ok: false,
    status: 'x',
  });
  ok(
    'the reads: DME tune / full / installed maps, transmission calibration / full, as bytes; results cross the channel as marked base64'
  );

  // ---- 3. the owner's registry ----------------------------------------------------
  console.log('\nowner');
  assert.deepStrictEqual(Object.keys(flashOperations), [
    'dme-tune',
    'dme-program',
    'dme-read',
    'dme-maps-read',
    'tcu-cal',
    'tcu-program',
    'tcu-cal-read',
    'tcu-full-read',
  ]);
  assert.strictEqual(
    flashOperations['dme-tune'].describe(text),
    'DME calibration'
  );
  assert.throws(
    () => flashOperations['dme-tune'].describe('{"cal":"AAAA"}'),
    /cal: expected/
  );
  logLines.length = 0;
  let release;
  const hold = new Promise((res) => (release = res));
  global.ms45FinishFlash = async () => {
    await hold;
    return true;
  };
  const first = flashOperations['dme-tune'].run(text, {});
  await new Promise((res) => setTimeout(res, 5));
  const second = await flashOperations['tcu-cal'].run(
    flashOps.encode({
      calibration: bytes(0x10000, 5),
      fast: false,
      aifRecord: null,
    }),
    {}
  );
  assert.deepStrictEqual(second, {
    ok: false,
    status: 'another flashing operation is running',
  });
  release();
  const done = await first;
  assert.deepStrictEqual(done, {
    ok: true,
    status: 'Flash successful',
    _bytes: [],
  });
  assert.ok(
    logLines[0] === 'start remote-dme-tune 0044570' &&
      logLines.includes('note Result: Flash successful') &&
      logLines[logLines.length - 1] === 'stop'
  );
  const again = await flashOperations['tcu-cal'].run(
    flashOps.encode({
      calibration: bytes(0x10000, 5),
      fast: false,
      aifRecord: null,
    }),
    {}
  );
  assert.strictEqual(again.ok, true);
  assert.ok(logLines.some((l) => l === 'start remote-tcu-cal GS20'));
  const readBack = await flashOperations['tcu-cal-read'].run(
    flashOps.encode({ fast: true }),
    {}
  );
  assert.strictEqual(readBack.ok, true);
  assert.deepStrictEqual(
    readBack._bytes,
    ['image'],
    'the owner hands a read back encoded for the channel'
  );
  assert.deepStrictEqual(
    flashOps.decodeResult(readBack).image,
    bytes(0x10000, 12)
  );
  assert.strictEqual(flashOperations['tcu-cal-read'].write, false);
  assert.strictEqual(flashOperations['dme-program'].write, true);
  ok(
    'one operation at a time, each with its own session log on the owner; free again after'
  );

  // ---- 4. the engine's transport ----------------------------------------------------
  console.log('\nengine');
  const {
    Remote,
    REMOTE_CAR_ROUTE,
  } = require('../../app/renderer/core/remote.js');
  assert.ok(
    REMOTE_CAR_ROUTE.test('/api/flash/dme-program') &&
      REMOTE_CAR_ROUTE.test('/api/flash/tcu-cal')
  );
  assert.ok(!REMOTE_CAR_ROUTE.test('/api/flashing/history'));
  assert.ok(
    Remote._needsApproval('/api/flash/dme-tune'),
    'an operation waits on a person'
  );
  const sent = [];
  Remote.chan = { readyState: 'open', send: (s) => sent.push(s) };
  Remote._send({
    t: 'req',
    id: '1',
    path: '/api/flash/dme-tune',
    init: { body: text },
  });
  assert.ok(sent.length > 1, `the payload went as ${sent.length} parts`);
  assert.ok(sent.every((s) => s.length < 50 * 1024));
  const parts = sent.map((s) => JSON.parse(s));
  assert.ok(parts.every((p) => p.t === 'part' && p.n === parts.length));
  let joined = null;
  for (const p of parts) {
    const m = Remote._joinPart(p);
    if (m) joined = m;
  }
  assert.ok(
    joined && joined.t === 'req' && joined.init.body === text,
    'the parts join back into the message'
  );
  assert.strictEqual(Remote.parts.size, 0);
  assert.strictEqual(Remote._joinPart({ id: 'x', i: 3, n: 2, s: 'a' }), null);
  assert.strictEqual(
    Remote._joinPart({ id: 'y', i: 0, n: 9999, s: 'a' }),
    null
  );
  assert.strictEqual(
    Remote._joinPart({ id: 'z', i: 0, n: 2, s: 'a' }),
    null,
    'half a message is nothing yet'
  );
  assert.strictEqual(Remote.parts.size, 1);
  Remote.parts.clear();
  sent.length = 0;
  Remote._send({ t: 'prog', id: '1', pct: 50 });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(JSON.parse(sent[0]).t, 'prog');
  ok(
    "a message over the channel's size goes as ordered parts and joins again; bad parts are dropped; small ones go whole"
  );

  // the helper's side of an operation: progress keeps it alive, the answer settles it
  const got = [];
  Remote.role = 'helper';
  Remote.waiters = [];
  Remote._ready = async () => {};
  const op = Remote.requestOperation('/api/flash/dme-tune', text, {
    action: { id: 'flashing-flash-tune-1', label: 'Flashing: Flash Tune' },
    onProgress: (m) => got.push(m),
  });
  await new Promise((r) => setTimeout(r, 0)); // the request goes out after the readiness wait
  const req = JSON.parse(
    sent
      .map((s) => JSON.parse(s))
      .filter((p) => p.t === 'part')
      .map((p) => p.s)
      .join('')
  );
  assert.strictEqual(req.t, 'req');
  assert.strictEqual(req.init.method, 'POST');
  assert.strictEqual(req.init.action.label, 'Flashing: Flash Tune');
  Remote._onMessage({
    data: JSON.stringify({ t: 'prog', id: req.id, stage: 'Erasing Flash' }),
  });
  Remote._onMessage({
    data: JSON.stringify({ t: 'prog', id: req.id, pct: 42, what: 'Flashing' }),
  });
  Remote._onMessage({
    data: JSON.stringify({
      t: 'res',
      id: req.id,
      status: 200,
      body: { ok: true, status: 'Flash successful' },
    }),
  });
  const res = await op;
  assert.deepStrictEqual(await res.json(), {
    ok: true,
    status: 'Flash successful',
  });
  assert.deepStrictEqual(got, [
    {
      stage: 'Erasing Flash',
      pct: undefined,
      what: undefined,
      note: undefined,
    },
    { stage: undefined, pct: 42, what: 'Flashing', note: undefined },
  ]);
  assert.strictEqual(Remote.pending.size, 0);
  ok(
    "the helper's operation request: POST with the action tag, progress delivered, the owner's answer settles it"
  );

  // the owner's engine runs an operation for the helper and reports it as it goes
  global.window = { flashOperations };
  Remote.role = 'owner';
  Remote.accepted = true;
  Remote.access = 'rw';
  Remote.onGate = async () => true;
  const shown = [];
  Remote.onOperation = (ev) => shown.push(ev);
  const replies = [];
  Remote.chan = {
    readyState: 'open',
    send: (m) => replies.push(JSON.parse(m)),
  };
  global.ms45FinishFlash = async (area, reset, proto, stage) => {
    stage('Checking signature');
    return true;
  };
  await Remote._ownerHandle({
    t: 'req',
    id: '77',
    path: '/api/flash/dme-tune',
    init: {
      method: 'POST',
      body: text,
      action: { id: 'a1', label: 'Flashing: Flash Tune' },
    },
  });
  const res77 = replies.find((m) => m.t === 'res' && m.id === '77');
  assert.ok(
    res77 && res77.status === 200 && res77.body.ok === true,
    'the operation ran and answered'
  );
  assert.ok(
    replies.some((m) => m.t === 'prog' && m.id === '77' && m.pct === 50),
    'progress went to the helper'
  );
  assert.deepStrictEqual(shown[0], {
    label: 'Flash Tune (DME calibration)',
    what: 'DME calibration',
    write: true,
    phase: 'start',
  });
  assert.ok(
    shown.some((e) => e.phase === 'stage' && e.stage === 'Erasing Flash')
  );
  assert.ok(shown.some((e) => e.phase === 'progress' && e.pct === 100));
  const last = shown[shown.length - 1];
  assert.ok(
    last.phase === 'done' &&
      last.ok === true &&
      last.status === 'Flash successful'
  );
  Remote.access = 'ro';
  replies.length = 0;
  await Remote._ownerHandle({
    t: 'req',
    id: '78',
    path: '/api/flash/dme-tune',
    init: { method: 'POST', body: text },
  });
  assert.strictEqual(
    replies[0].status,
    403,
    'a read-only share refuses a write'
  );
  shown.length = 0;
  await Remote._ownerHandle({
    t: 'req',
    id: '79',
    path: '/api/flash/tcu-cal-read',
    init: { method: 'POST', body: flashOps.encode({ fast: true }) },
  });
  assert.ok(
    replies.some((m) => m.id === '79' && m.status === 200),
    'a read-only share allows a read'
  );
  assert.ok(
    shown[0] && shown[0].phase === 'start' && shown[0].write === false,
    'the owner sees a read run too'
  );
  ok(
    "the owner's engine: approval, run, progress to both the helper and the owner's screen, read-only rules"
  );

  console.log(`\nflash-ops: ${passed} checks passed`);
})().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});
