// The gateway end to end, over a real socket on a high port: the frame
// codec, the handshake, the protocol, and then the app's own bus driving a
// fake cable that lives behind the gateway rather than in this process.
// What is pinned is that a remote cable and a local one are the same thing
// to everything above the port: the same DS2 wire facts (the reopen at
// 9600 8E1, DTR raised for the write and dropped after it, RTS never
// raised, the echo stripped, the checksum verified), the same silence as
// IFH-0009, and the same write gate on the client, which the gateway never
// sees.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CliError } from '../src/args.ts';
import { GatewayPort, gatewayUrl } from '../src/gateway-client.ts';
import { parseListen, startGateway } from '../src/gateway.ts';
import { connectBus, disconnectBus, jobCommand } from '../src/live.ts';
import { scanCommand } from '../src/scan.ts';
import type { PortBinding, PortConfig } from '../src/serial.ts';
import { tuiCommand } from '../src/tui.ts';
import { acceptKey, connectWs, decodeFrame, encodeFrame } from '../src/ws.ts';
import {
  compile,
  fakeCar,
  fakeTerminal,
  MODULE_SOURCE,
  probeEcu,
  sysSet,
  VEHICLE_SOURCE,
  waitFor,
} from './helpers.ts';

/** One event the fake cable saw, as the serial tests record them. */
type Event = { kind: 'open' | 'set' | 'write' | 'close'; detail: string };

/**
 * A fake cable: echoes every write (a wired K line always does), then
 * answers what `reply` says; records opens, closes, writes and every
 * modem-line change. The same cable the local tests use, only reached
 * through a socket here.
 * @param reply - what the car answers a request
 * @returns the opener and the event log
 */
function fakeCable(reply: (req: number[]) => number[] | null): {
  opener: (path: string, cfg: PortConfig) => Promise<PortBinding>;
  events: Event[];
} {
  const events: Event[] = [];
  const opener = async (
    path: string,
    cfg: PortConfig
  ): Promise<PortBinding> => {
    events.push({
      kind: 'open',
      detail: `${path} ${cfg.baudRate} ${cfg.parity}`,
    });
    let hear: ((b: Uint8Array) => void) | null = null;
    return {
      onData: (fn) => {
        hear = fn;
      },
      write: async (bytes) => {
        const req = Array.from(bytes);
        events.push({ kind: 'write', detail: hex(req) });
        setTimeout(() => hear && hear(new Uint8Array(req.slice(0, 2))), 1);
        setTimeout(() => hear && hear(new Uint8Array(req.slice(2))), 3);
        const ans = reply(req);
        if (ans) setTimeout(() => hear && hear(new Uint8Array(ans)), 8);
      },
      set: async (s) => {
        events.push({
          kind: 'set',
          detail: `dtr=${s.dtr} rts=${s.rts} brk=${s.brk}`,
        });
      },
      get: async () => ({ dsr: true, dcd: false, cts: false }),
      close: async () => {
        events.push({ kind: 'close', detail: '' });
      },
    };
  };
  return { opener, events };
}

/**
 * Bytes as upper-case hex pairs.
 * @param b - the bytes
 * @returns the text
 */
function hex(b: number[]): string {
  return b.map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

/**
 * The XOR checksum a DS2 frame ends with.
 * @param b - the frame's body
 * @returns the checksum byte
 */
function xor(b: number[]): number {
  return b.reduce((a, x) => a ^ x, 0);
}

/**
 * Start a gateway on a port the OS picks, above the range a dev server
 * uses, and hand back its ws:// URL.
 * @param opener - the cable behind it
 * @param log - where its lines go
 * @returns the running gateway and its URL
 */
async function serve(
  opener: (path: string, cfg: PortConfig) => Promise<PortBinding>,
  log: string[] = []
): Promise<{
  url: string;
  stop: () => Promise<void>;
  log: string[];
  port: number;
}> {
  const g = await startGateway({
    ports: [{ path: '/dev/fake-kdcan', detail: '' }],
    opener,
    listen: '127.0.0.1:0',
    log: (l) => log.push(l),
  });
  return {
    url: `ws://127.0.0.1:${g.port}`,
    stop: () => g.stop(),
    log,
    port: g.port,
  };
}

test('the frame codec: lengths, masking, and what each end refuses', () => {
  // a short frame, unmasked, as a server writes it
  const short = encodeFrame(0x1, Buffer.from('hi'), false);
  assert.deepEqual(Array.from(short.subarray(0, 2)), [0x81, 2]);
  const got = decodeFrame(short, false);
  assert.ok(got && !(got instanceof Error));
  assert.equal((got as { payload: Buffer }).payload.toString(), 'hi');
  // a masked frame, as a client writes it: the payload is not the plain text
  const masked = encodeFrame(0x2, Buffer.from([1, 2, 3]), true);
  assert.equal(masked[1]! & 0x80, 0x80, 'the mask bit is set');
  const back = decodeFrame(masked, true);
  assert.deepEqual(
    Array.from((back as { payload: Buffer }).payload),
    [1, 2, 3],
    'unmasking recovers the bytes'
  );
  // the two-byte and eight-byte length forms
  const mid = encodeFrame(0x2, Buffer.alloc(200), false);
  assert.equal(mid[1], 126);
  assert.equal(mid.readUInt16BE(2), 200);
  const big = encodeFrame(0x2, Buffer.alloc(70000), false);
  assert.equal(big[1], 127);
  assert.equal(big.readUInt32BE(6), 70000);
  assert.equal(
    (decodeFrame(big, false) as { payload: Buffer }).payload.length,
    70000
  );
  // half a frame is not a frame yet
  assert.equal(decodeFrame(short.subarray(0, 1), false), null);
  assert.equal(decodeFrame(mid.subarray(0, 3), false), null);
  // a server refuses an unmasked client frame, and the other way round
  assert.ok(decodeFrame(short, true) instanceof Error);
  assert.ok(decodeFrame(masked, false) instanceof Error);
  // the accept value is RFC 6455's own worked example (section 1.3)
  assert.equal(
    acceptKey('dGhlIHNhbXBsZSBub25jZQ=='),
    's3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
    'the SHA-1 of the key plus the GUID, base64'
  );
});

test('parseListen and gatewayUrl: what a user may type', () => {
  assert.deepEqual(parseListen('0.0.0.0:6801'), {
    host: '0.0.0.0',
    port: 6801,
  });
  assert.deepEqual(parseListen('7000'), { host: '127.0.0.1', port: 7000 });
  assert.deepEqual(parseListen(''), { host: '127.0.0.1', port: 6801 });
  assert.deepEqual(parseListen('[::1]:6801'), { host: '::1', port: 6801 });
  assert.throws(() => parseListen('host:nope'), CliError);
  assert.equal(gatewayUrl('192.168.1.9:6801'), 'ws://192.168.1.9:6801');
  assert.equal(gatewayUrl('shopbox'), 'ws://shopbox:6801');
  assert.equal(gatewayUrl('ws://x:1/p'), 'ws://x:1/p');
  assert.equal(gatewayUrl('wss://x/p'), 'wss://x/p');
  assert.throws(() => gatewayUrl(''), CliError);
});

test('the protocol: open, signals, a write with its answer, close', async () => {
  const cable = fakeCable(() => null);
  const g = await serve(cable.opener);
  const conn = await connectWs(g.url);
  const texts: string[] = [];
  const bins: Uint8Array[] = [];
  conn.on({
    onText: (t) => texts.push(t),
    onBinary: (b) => bins.push(b),
  });
  /**
   * Wait for a condition, or fail.
   * @param cond - what to wait for
   * @param what - named in the failure
   */
  const until = async (cond: () => boolean, what: string): Promise<void> => {
    const end = Date.now() + 2000;
    while (!cond()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  await until(() => texts.length >= 1, 'the hello');
  assert.deepEqual(JSON.parse(texts[0] as string), {
    event: 'hello',
    port: '/dev/fake-kdcan',
    gateway: 'bmweb',
  });

  conn.sendText(
    JSON.stringify({
      id: 1,
      op: 'open',
      config: { baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'even' },
    })
  );
  await until(() => texts.length >= 2, 'the open reply');
  assert.deepEqual(JSON.parse(texts[1] as string), { id: 1, ok: true });
  assert.equal(cable.events[0]?.detail, '/dev/fake-kdcan 9600 even');

  conn.sendText(
    JSON.stringify({
      id: 2,
      op: 'setSignals',
      signals: { dataTerminalReady: true },
    })
  );
  await until(() => texts.length >= 3, 'the setSignals reply');
  assert.deepEqual(JSON.parse(texts[2] as string), { id: 2, ok: true });
  assert.ok(
    cable.events.some(
      (e) => e.kind === 'set' && e.detail === 'dtr=true rts=false brk=false'
    ),
    'the host kept the lines the call did not name'
  );

  conn.sendText(JSON.stringify({ id: 3, op: 'getSignals' }));
  await until(() => texts.length >= 4, 'the getSignals reply');
  assert.deepEqual(JSON.parse(texts[3] as string), {
    id: 3,
    ok: true,
    signals: {
      dataSetReady: true,
      dataCarrierDetect: false,
      clearToSend: false,
    },
  });

  // a write is a binary frame with no reply; the cable's echo comes back
  // as binary frames, streamed as they arrive rather than gathered
  conn.sendBinary(new Uint8Array([0x12, 0x04, 0x00, 0x16]));
  await until(() => bins.length >= 2, 'the echo, in two frames');
  assert.deepEqual(Array.from(bins[0] as Uint8Array), [0x12, 0x04]);
  assert.deepEqual(Array.from(bins[1] as Uint8Array), [0x00, 0x16]);
  assert.equal(
    cable.events.find((e) => e.kind === 'write')?.detail,
    '12 04 00 16'
  );

  // an unknown op comes back as a refusal, not a dropped frame
  conn.sendText(JSON.stringify({ id: 9, op: 'nonsense' }));
  await until(() => texts.length >= 5, 'the refusal');
  const bad = JSON.parse(texts[4] as string) as Record<string, unknown>;
  assert.equal(bad.ok, false);
  assert.match(String(bad.error), /unknown op nonsense/);

  conn.sendText(JSON.stringify({ id: 4, op: 'close' }));
  await until(
    () => cable.events.some((e) => e.kind === 'close'),
    'the cable closed'
  );
  conn.close();
  await g.stop();
});

test('one client at a time: the second is refused and the cable stays with the first', async () => {
  const cable = fakeCable(() => null);
  const g = await serve(cable.opener);
  const first = new GatewayPort(g.url);
  await first.dial();
  await first.open({
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
  });
  const second = new GatewayPort(g.url);
  await second.dial();
  // the refusal arrives as a close, so the next call fails rather than hangs
  await assert.rejects(
    second.open({
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
    }),
    (e: unknown) =>
      /already has a client|connection/.test(String((e as Error).message))
  );
  assert.ok(
    g.log.some((l) => /refused .*already driving the cable/.test(l)),
    'the refusal is logged'
  );
  assert.equal(first.connected, true, 'the first client kept the cable');
  first.hangUp();
  second.hangUp();
  await g.stop();
});

test('the client goes: the host closes the cable behind it', async () => {
  const cable = fakeCable(() => null);
  const g = await serve(cable.opener);
  const p = new GatewayPort(g.url);
  await p.dial();
  await p.open({ baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'even' });
  assert.ok(cable.events.some((e) => e.kind === 'open'));
  p.hangUp();
  const end = Date.now() + 2000;
  while (!cable.events.some((e) => e.kind === 'close')) {
    if (Date.now() > end) throw new Error('the cable was left open');
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(
    g.log.some((l) => /disconnected, cable closed/.test(l)),
    'the disconnect is logged'
  );
  await g.stop();
});

test("the app's bus over the gateway: the DS2 wire facts survive the socket", async () => {
  const cable = fakeCable((req) => {
    if (req[0] === 0x12 && req[1] === 0x04) {
      const body = [0x12, 0x05, 0xa0, 0x42];
      return [...body, xor(body)];
    }
    return null;
  });
  const g = await serve(cable.opener);
  const { R, label, path } = await connectBus({
    gateway: `127.0.0.1:${g.port}`,
    api: 'http://127.0.0.1:9/',
  });
  assert.equal(path, g.url);
  assert.match(
    label,
    /^gateway ws:\/\/127\.0\.0\.1:\d+ \(\/dev\/fake-kdcan\)$/,
    'the chip says where the car is'
  );
  assert.equal(R.webBus.connected, true);
  assert.equal(cable.events[0]?.detail, '/dev/fake-kdcan 115200 none');

  const before = cable.events.length;
  const ds2 = { concept: 6, baud: 9600, answerLen: [-1, 0], timeout: 500 };
  const ans = await (
    R.webBus as unknown as {
      exchange(o: number[], c: object): Promise<number[]>;
    }
  ).exchange([0x12, 0x04, 0x00], ds2);
  assert.deepEqual(
    Array.from(ans),
    [0x12, 0x05, 0xa0, 0x42, xor([0x12, 0x05, 0xa0, 0x42])],
    'the answer came back whole, echo stripped, checksum verified'
  );
  const ev = cable.events.slice(before);
  assert.ok(
    ev.some((e) => e.kind === 'open' && e.detail.endsWith('9600 even')),
    'the remote port was reopened 9600 8E1'
  );
  const w = ev.findIndex((e) => e.kind === 'write');
  assert.equal(ev[w]?.detail, '12 04 00 16');
  const setsBefore = ev
    .slice(0, w)
    .filter((e) => e.kind === 'set')
    .map((e) => e.detail);
  const setsAfter = ev
    .slice(w + 1)
    .filter((e) => e.kind === 'set')
    .map((e) => e.detail);
  assert.equal(
    setsBefore[setsBefore.length - 1],
    'dtr=true rts=false brk=false',
    'DTR up right before the write, across the socket'
  );
  assert.equal(
    setsAfter[0],
    'dtr=false rts=false brk=false',
    'DTR dropped right after it'
  );
  assert.ok(
    ev.every((e) => e.kind !== 'set' || /rts=false/.test(e.detail)),
    'RTS never raised'
  );

  // silence is still the ECU's answer of zero bytes, not a socket hang
  const silent = { concept: 6, baud: 9600, answerLen: [-1, 0], timeout: 60 };
  await assert.rejects(
    (
      R.webBus as unknown as {
        exchange(o: number[], c: object): Promise<number[]>;
      }
    ).exchange([0x33, 0x04, 0x00], silent),
    (e: unknown) => /IFH-0009/.test(String((e as Error).message))
  );

  await disconnectBus(R);
  assert.equal(R.webBus.connected, false);
  assert.equal(
    cable.events[cable.events.length - 1]?.kind,
    'close',
    'the remote cable was closed'
  );
  await g.stop();
});

test('job through the gateway: the write gate is on the client, not the pipe', async () => {
  const cable = fakeCable(() => null);
  const g = await serve(cable.opener);
  const car = fakeCar((job, arg, target) => ({
    job,
    system: sysSet(target, job),
    sets: [{ JOB_STATUS: 'OKAY', ARG: arg || '' }],
  }));
  const { R } = await connectBus({
    gateway: g.url,
    api: 'http://127.0.0.1:9/',
  });
  try {
    // a read runs with no question
    const lines = await jobCommand('ms450ds0', 'STATUS_LESEN', {
      apiFn: car.api,
    });
    assert.match(lines[0] as string, /^ms450ds0 MS450DS0 STATUS_LESEN: 1 set/);
    // a write is refused HERE, so nothing ever reaches the pipe
    car.sent.length = 0;
    const refused = await jobCommand('ms450ds0', 'FS_LOESCHEN', {
      apiFn: car.api,
      confirm: async () => false,
    });
    assert.match(refused[0] as string, /not sent/);
    assert.equal(
      car.sent.length,
      0,
      'the declined write never left the client'
    );
    // and goes out on a y, exactly as it does on a local cable
    await jobCommand('ms450ds0', 'FS_LOESCHEN', {
      apiFn: car.api,
      confirm: async () => true,
    });
    assert.deepEqual(
      car.sent.map((s) => s.job),
      ['FS_LOESCHEN']
    );
  } finally {
    await disconnectBus(R);
    await g.stop();
  }
});

test('a gateway that is not there is one clear line, not a hang', async () => {
  await assert.rejects(
    connectBus({ gateway: '127.0.0.1:1', api: 'http://127.0.0.1:9/' }),
    (e: unknown) =>
      e instanceof CliError &&
      /cannot reach the gateway at ws:\/\/127\.0\.0\.1:1/.test(e.message)
  );
});

test('scan through the gateway: the same report as over a local cable', async () => {
  const cable = fakeCable(() => null);
  const g = await serve(cable.opener);
  // the car answers at the engine client, as the direct scan test's does;
  // what the gateway proves here is that the bus the scan runs behind is
  // a REMOTE port, dialled and opened over the socket
  const car = fakeCar(
    (job, _arg, target) => {
      if (job === 'FS_LESEN' && target === 'ms450ds0')
        return {
          job,
          system: sysSet('ms450ds0', job),
          sets: [
            {
              F_ORT_NR: 39,
              F_HEX_CODE: '27-C3-22',
              F_ORT_TEXT: '27C3 DMTL pump',
              F_HFK: 3,
              F_VORHANDEN_TEXT: 'Fehler momentan vorhanden',
            },
          ],
        };
      if (target === 'd_0044')
        return new Error('d_0044: no module answered on the wire');
      return {
        job,
        system: sysSet(target, job),
        sets: [{ JOB_STATUS: 'OKAY' }],
      };
    },
    {},
    { d_motor: 'ms450ds0' }
  );
  const { R, label } = await connectBus({
    gateway: g.url,
    api: 'http://127.0.0.1:9/',
  });
  assert.match(label, /^gateway ws:/);
  assert.equal(R.webBus.connected, true, 'the scan runs on a remote cable');
  try {
    const r = await scanCommand('e46', {
      exec: compile(VEHICLE_SOURCE, 'e46'),
      apiFn: car.api,
      progress: () => {},
    });
    assert.deepEqual(
      car.sent.map((s) => `${s.target}:${s.job}`),
      ['ms450ds0:FS_LESEN', 'd_0044:FS_LESEN'],
      'both groups asked, in script order'
    );
    assert.equal(r.report.modules.length, 1);
    assert.equal(r.report.modules[0]?.sgbd, 'ms450ds0');
    assert.deepEqual(
      Array.from(r.report.silent || [], (s) => s.target),
      ['d_0044']
    );
    assert.match(
      r.lines.join('\n'),
      /^ms450ds0\s+27C3\s+DMTL pump\s+3\s+present$/m
    );
  } finally {
    await disconnectBus(R);
    await g.stop();
  }
});

test('tui through the gateway: keys, a declined write, an accepted one, release on quit', async () => {
  const cable = fakeCable(() => null);
  const g = await serve(cable.opener);
  const car = fakeCar((job, arg, target) => {
    if (job === 'IDENT')
      return {
        job,
        system: sysSet(target, job),
        sets: [{ ID_SW_NR: '7 545 116' }],
      };
    return {
      job,
      system: sysSet(target, job),
      sets: [{ JOB_STATUS: 'OKAY', ARG: arg || '' }],
    };
  });
  // F3 declined, then F3 accepted: the gate is on this end, not the pipe
  const term = fakeTerminal(['n', 'y']);
  const run = tuiCommand('E46', 'probe', {
    gateway: g.url,
    api: 'http://127.0.0.1:9/',
    apiFn: car.api,
    exec: compile(MODULE_SOURCE, 'probe'),
    ecu: probeEcu(),
    term,
  });
  try {
    await waitFor(() => /F2 Fault memory/.test(term.out), 'the root menu');
    // the cable the TUI took is the remote one
    assert.ok(
      cable.events.some((e) => e.kind === 'open'),
      'the gateway opened the cable for the TUI'
    );
    // a read key: no question
    term.press('1');
    await waitFor(() => car.sent.some((s) => s.job === 'IDENT'), 'IDENT sent');
    assert.equal(term.prompts.length, 0, 'a read asks nothing');
    // a write: declined here, so it never reaches the pipe
    term.press('3');
    await waitFor(() => term.prompts.length === 1, 'the confirm prompt');
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(
      !car.sent.some((s) => s.job === 'FS_LOESCHEN'),
      'declined: never sent'
    );
    // and accepted the second time
    term.press('3');
    await waitFor(
      () => car.sent.some((s) => s.job === 'FS_LOESCHEN'),
      'accepted: sent'
    );
    term.press('q');
    await run;
    assert.equal(
      car.sent[car.sent.length - 1]?.job,
      'DIAGNOSE_ENDE',
      "the script's own exit job still ran over the socket"
    );
  } finally {
    await g.stop();
  }
  // the remote cable was closed when the TUI left
  assert.ok(
    cable.events.some((e) => e.kind === 'close'),
    'the remote cable was closed on quit'
  );
});

test('a concept change reopens the remote port, balanced, and bytes still flow', async () => {
  const cable = fakeCable(() => null);
  const g = await serve(cable.opener);
  const p = new GatewayPort(g.url);
  await p.dial();
  const fast: PortConfig = {
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
  };
  const ds2: PortConfig = {
    baudRate: 9600,
    dataBits: 8,
    stopBits: 1,
    parity: 'even',
  };
  await p.open(fast);
  // exactly what the bus's _reopenStreams does, twice: close, open, fresh
  // reader and writer. A K-line module after a D-CAN one does this on a
  // real car, and a leaked device handle here would fail the next open.
  for (const cfg of [ds2, fast]) {
    await p.close();
    await p.open(cfg);
    const reader = p.readable.getReader();
    const writer = p.writable.getWriter();
    await writer.write(new Uint8Array([0x12, 0x04, 0x00]));
    const got = await reader.read();
    assert.equal(
      got.done,
      false,
      `bytes flow after the reopen at ${cfg.baudRate}`
    );
  }
  await p.close();
  p.hangUp();
  await g.stop();
  const opens = cable.events.filter((e) => e.kind === 'open');
  const closes = cable.events.filter((e) => e.kind === 'close');
  assert.equal(opens.length, 3, 'one open per concept');
  assert.equal(closes.length, 3, 'and one close each: no leaked handle');
  assert.ok(opens[1]?.detail.endsWith('9600 even'));
  assert.ok(opens[2]?.detail.endsWith('115200 none'));
});

test('the host dies under the client: a parked read says done, a call in flight fails', async () => {
  const cable = fakeCable(() => null);
  const g = await serve(cable.opener);
  const p = new GatewayPort(g.url);
  await p.dial();
  await p.open({ baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'even' });
  const reader = p.readable.getReader();
  // a read parked on an answer that will never come, and a control call
  // in flight, when the gateway goes away
  const parked = reader.read();
  const call = p.getSignals().then(
    () => 'resolved',
    (e: Error) => `rejected: ${e.message}`
  );
  await g.stop();
  // THE ONE THAT MATTERS. The bus awaits reads with no catch of its own,
  // so a parked read must RESOLVE done, never reject: a rejection here
  // would surface as an unhandled crash in the middle of a scan rather
  // than as "the cable went away".
  const r = await Promise.race([
    parked,
    new Promise((res) => setTimeout(() => res('HUNG'), 2000)),
  ]);
  assert.deepEqual(r, { value: undefined, done: true }, 'done, and not a hang');
  assert.match(await call, /^rejected: the gateway connection ended/);
  p.hangUp();
});

test('a client that vanishes without a close frame frees the cable for the next one', async () => {
  const cable = fakeCable(() => null);
  const g = await serve(cable.opener);
  const first = new GatewayPort(g.url);
  await first.dial();
  await first.open({
    baudRate: 9600,
    dataBits: 8,
    stopBits: 1,
    parity: 'even',
  });
  assert.equal(cable.events.filter((e) => e.kind === 'open').length, 1);
  // a pulled network cable: the socket dies with no close frame
  first.hangUp();
  const end = Date.now() + 2000;
  while (!cable.events.some((e) => e.kind === 'close')) {
    if (Date.now() > end) throw new Error('the cable was left open');
    await new Promise((r) => setTimeout(r, 5));
  }
  // and the slot is free: a stale client would refuse this one
  const second = new GatewayPort(g.url);
  await second.dial();
  await second.open({
    baudRate: 9600,
    dataBits: 8,
    stopBits: 1,
    parity: 'even',
  });
  assert.equal(second.connected, true, 'the next client got the cable');
  second.hangUp();
  await g.stop();
});
