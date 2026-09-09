// The Node port under the app's own bus: a fake cable on the other end of
// a Web-Serial-shaped port, driven through WebSerialBus and runExchange
// exactly as the browser drives them. What is pinned is what a K+DCAN
// cable on a Mac taught the app: the port reopened at the concept's own
// settings, DTR raised for the write and dropped after it on the K line,
// DTR idling high for BMW-FAST, RTS never raised, the echo dropped by
// count, the answer verified. Plus the port's reader itself: bytes that
// arrive after a read gave up are still delivered, and a cancel says done.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CliError } from '../src/args.ts';
import { connectBus, disconnectBus } from '../src/live.ts';
import {
  choosePort,
  NodeSerialPort,
  type PortBinding,
  type PortConfig,
} from '../src/serial.ts';

/** One event the fake cable saw. */
type Event = { kind: 'open' | 'set' | 'write' | 'close'; detail: string };

/**
 * A fake cable: echoes every write (a wired K line always does), then
 * answers what `reply` says for the request; records opens, closes,
 * writes and every modem-line change.
 */
function fakeCable(reply: (req: number[]) => number[] | null) {
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
        // the echo, split in two like a real cable delivers it, then the answer
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

/** Bytes as upper-case hex pairs. */
function hex(b: number[]): string {
  return b.map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

/** The XOR checksum a DS2 frame ends with. */
function xor(b: number[]): number {
  return b.reduce((a, x) => a ^ x, 0);
}

/** The sum8 checksum a BMW-FAST frame ends with. */
function sum8(b: number[]): number {
  return b.reduce((a, x) => (a + x) & 0xff, 0);
}

test('choosePort: the named one, the single candidate, else a clear error', () => {
  assert.equal(choosePort('/dev/x', []), '/dev/x');
  assert.equal(
    choosePort(undefined, [{ path: '/dev/cu.usbserial-1', detail: '' }]),
    '/dev/cu.usbserial-1'
  );
  assert.throws(
    () => choosePort(undefined, []),
    (e: unknown) => e instanceof CliError && /--port/.test(e.message)
  );
  assert.throws(
    () =>
      choosePort(undefined, [
        { path: '/dev/a', detail: '' },
        { path: '/dev/b', detail: '' },
      ]),
    (e: unknown) =>
      e instanceof CliError && /\/dev\/a, \/dev\/b/.test(e.message)
  );
});

test('the port reader delivers bytes that arrive after a read gave up, and cancel says done', async () => {
  let hear: ((b: Uint8Array) => void) | null = null;
  const port = new NodeSerialPort('/dev/fake', async () => ({
    onData: (fn) => {
      hear = fn;
    },
    write: async () => {},
    set: async () => {},
    get: async () => null,
    close: async () => {},
  }));
  await port.open({ baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'even' });
  const reader = port.readable.getReader();
  // a read parked with nothing to give: the bytes that come later land in it
  const parked = reader.read();
  (hear as unknown as (b: Uint8Array) => void)(new Uint8Array([1, 2, 3]));
  const got = await parked;
  assert.deepEqual(Array.from(got.value as Uint8Array), [1, 2, 3]);
  assert.equal(got.done, false);
  // bytes heard while no read is parked queue up for the next read
  (hear as unknown as (b: Uint8Array) => void)(new Uint8Array([4]));
  assert.deepEqual(Array.from((await reader.read()).value as Uint8Array), [4]);
  // cancel: a parked read is told done, as Web Serial does on cancel
  const parked2 = reader.read();
  await reader.cancel();
  assert.equal((await parked2).done, true);
  await port.close();
  assert.equal((await reader.read()).done, true, 'a closed port reads done');
});

test('setSignals keeps the lines it does not name, and the binding gets all three', async () => {
  const sets: string[] = [];
  const port = new NodeSerialPort('/dev/fake', async () => ({
    onData: () => {},
    write: async () => {},
    set: async (s) => {
      sets.push(`${s.dtr}/${s.rts}/${s.brk}`);
    },
    get: async () => ({ dsr: true }),
    close: async () => {},
  }));
  await port.open({
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
  });
  await port.setSignals({ dataTerminalReady: true, requestToSend: false });
  await port.setSignals({ break: true });
  await port.setSignals({ dataTerminalReady: false });
  assert.deepEqual(sets, [
    'true/false/false',
    'true/false/true',
    'false/false/true',
  ]);
  const sig = await port.getSignals();
  assert.equal(sig && sig.dataSetReady, true);
  assert.equal(sig && sig.dataCarrierDetect, false);
});

test("the app's bus over the Node port: DS2 then BMW-FAST, wire facts intact", async () => {
  const cable = fakeCable((req) => {
    // a DS2 request 12 04 00 XX: answer 12 05 A0 42 <xor>
    if (req[0] === 0x12 && req[1] === 0x04) {
      const body = [0x12, 0x05, 0xa0, 0x42];
      return [...body, xor(body)];
    }
    // a BMW-FAST 82 12 F1 1A 80 <sum>: answer 83 F1 12 5A 80 01 <sum>
    if (req[0] === 0x82) {
      const body = [0x83, 0xf1, 0x12, 0x5a, 0x80, 0x01];
      return [...body, sum8(body)];
    }
    return null;
  });
  const { R, path } = await connectBus({
    ports: [{ path: '/dev/fake-kdcan', detail: '' }],
    opener: cable.opener,
    api: 'http://127.0.0.1:9/',
  });
  assert.equal(path, '/dev/fake-kdcan');
  assert.equal(R.webBus.connected, true);
  // connect opens at the K+DCAN default and idles DTR high, RTS low
  assert.equal(cable.events[0]?.detail, '/dev/fake-kdcan 115200 none');
  assert.ok(
    cable.events.some(
      (e) => e.kind === 'set' && e.detail === 'dtr=true rts=false brk=false'
    ),
    'idle DTR high after open'
  );

  // a DS2 telegram: the port is reopened 9600 8E1, DTR idles low, then is
  // raised for the write and dropped after it; the echo is stripped and the
  // answer verified against its XOR checksum
  const before = cable.events.length;
  const ds2 = { concept: 6, baud: 9600, answerLen: [-1, 0], timeout: 500 };
  const ans = await (
    R.webBus as unknown as {
      exchange(o: number[], c: object): Promise<number[]>;
    }
  ).exchange([0x12, 0x04, 0x00], ds2);
  assert.deepEqual(Array.from(ans), [
    0x12,
    0x05,
    0xa0,
    0x42,
    xor([0x12, 0x05, 0xa0, 0x42]),
  ]);
  const ev = cable.events.slice(before);
  assert.ok(
    ev.some((e) => e.kind === 'open' && e.detail.endsWith('9600 even')),
    'reopened 9600 8E1'
  );
  const w = ev.findIndex((e) => e.kind === 'write');
  assert.equal(
    ev[w]?.detail,
    '12 04 00 16',
    'the request left with its XOR checksum'
  );
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
    'DTR up right before the write'
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

  // a BMW-FAST telegram: back to 115200 8N1 with DTR idling high, sum8 framing
  const b2 = cable.events.length;
  const fast = { concept: 0x10f, baud: 115200, timeout: 500 };
  const ans2 = await (
    R.webBus as unknown as {
      exchange(o: number[], c: object): Promise<number[]>;
    }
  ).exchange([0x82, 0x12, 0xf1, 0x1a, 0x80], fast);
  assert.equal(ans2[3], 0x5a);
  const ev2 = cable.events.slice(b2);
  assert.ok(
    ev2.some((e) => e.kind === 'open' && e.detail.endsWith('115200 none')),
    'reopened 115200 8N1'
  );
  assert.ok(
    ev2.some(
      (e) => e.kind === 'set' && e.detail === 'dtr=true rts=false brk=false'
    ),
    'DTR idles high for BMW-FAST'
  );
  assert.equal(
    ev2.find((e) => e.kind === 'write')?.detail,
    '82 12 F1 1A 80 1F',
    'sum8 checksum, the byte the car trace shows'
  );

  // silence is the ECU's answer of zero bytes, as IFH-0009, not a hang
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
  assert.equal(cable.events[cable.events.length - 1]?.kind, 'close');
});
