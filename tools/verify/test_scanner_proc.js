#!/usr/bin/env node
// BMWeb Scanner's fault-memory and Clear DTC procedures
// (app/renderer/screens/scanner/scanner-proc.js) against the reference
// scanner's own traffic: every telegram and answer below is from the USB
// capture of BMW Scanner 1.4.0.7 on an E46 (capture-frames.txt), and each
// procedure must send exactly what its adapter put on the K line, in order.
//
// Run: node tools/verify/test_scanner_proc.js
const assert = require('assert');
const d = require('../../app/renderer/screens/scanner/scanner-data.js');
const p = require('../../app/renderer/screens/scanner/scanner-proc.js');

const mod = (n) => d.SCANNER_MODULES.find((m) => m.name === n);
const h = (s) => s.split(' ').map((x) => parseInt(x, 16));

/** A link that answers from a script and records what was sent. */
function scripted(answers) {
  const sent = [];
  const slept = [];
  const next = (kind, addr, payload) => {
    const key = `${kind} ${addr.toString(16)} ${payload.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`;
    sent.push(key);
    const a = answers[key];
    if (Array.isArray(a)) return a.length > 1 ? a.shift() : a[0];
    if (a === undefined) throw new Error('silent: ' + key);
    return a;
  };
  return {
    sent,
    slept,
    link: {
      ds2: async (addr, pl) => h(next('ds2', addr, pl)),
      kwp: async (addr, pl) => h(next('kwp', addr, pl)),
      sleep: async (ms) => slept.push(ms),
    },
  };
}

const ok = async (name, fn) => {
  await fn();
  console.log('  ok   ' + name);
};

(async () => {
  await ok('IKE: count 04 00 -> 5, clear 05, then 2 s', async () => {
    const s = scripted({
      'ds2 80 04 00': '80 05 a0 05 20',
      'ds2 80 05': '80 04 a0 24',
    });
    const c = await p.scannerReadCounts(s.link, mod('IKE'), {
      kwp: false,
      raw: null,
    });
    assert.deepStrictEqual(c, { errors: 5, shadow: null });
    const r = await p.scannerClearProc(s.link, mod('IKE'), {
      kwp: false,
      raw: null,
    });
    assert.ok(r.ok);
    assert.deepStrictEqual(s.sent, ['ds2 80 04 00', 'ds2 80 05']);
    assert.deepStrictEqual(s.slept, [2000]);
  });

  await ok(
    'SHD: the bare 04 count read (04 00 is refused with B0)',
    async () => {
      const s = scripted({
        'ds2 8 04': '08 0f a0 00 00 00 00 00 00 00 00 00 00 00 a7',
      });
      const c = await p.scannerReadCounts(s.link, mod('SHD'), {
        kwp: false,
        raw: null,
      });
      assert.deepStrictEqual(c, { errors: 0, shadow: null });
      assert.deepStrictEqual(s.sent, ['ds2 8 04']);
    }
  );

  await ok('EGS: 05 then 9E, 3 s + 2 s', async () => {
    const s = scripted({
      'ds2 32 05': '32 04 a0 96',
      'ds2 32 9e': '32 04 a0 96',
    });
    await p.scannerClearProc(s.link, mod('EGS'), { kwp: false, raw: null });
    assert.deepStrictEqual(s.sent, ['ds2 32 05', 'ds2 32 9e']);
    assert.deepStrictEqual(s.slept, [3000, 2000]);
  });

  await ok('A/C: 05 then 9F', async () => {
    const s = scripted({
      'ds2 5b 05': '5b 04 a0 ff',
      'ds2 5b 9f': '5b 04 a0 ff',
    });
    await p.scannerClearProc(s.link, mod('A/C'), { kwp: false, raw: null });
    assert.deepStrictEqual(s.sent, ['ds2 5b 05', 'ds2 5b 9f']);
  });

  await ok('LCM: 05 01 .. 05 08, 0.3 s each', async () => {
    const ans = {};
    for (let b = 1; b <= 8; b++) ans[`ds2 d0 05 0${b}`] = 'd0 04 a0 74';
    const s = scripted(ans);
    const r = await p.scannerClearProc(s.link, mod('LCM'), {
      kwp: false,
      raw: null,
    });
    assert.ok(r.ok);
    assert.strictEqual(s.sent.length, 8);
    assert.strictEqual(s.sent[7], 'ds2 d0 05 08');
    assert.deepStrictEqual(
      s.slept,
      [300, 300, 300, 300, 300, 300, 300, 300, 2000]
    );
  });

  await ok('ZKE: count, shadow 14 00, clear 05 00 00', async () => {
    const s = scripted({
      'ds2 0 04 00': '00 09 a0 01 00 00 50 1c e4',
      'ds2 0 14 00': '00 0b a0 03 90 28 9e 01 9a 01 14',
      'ds2 0 05 00 00': '00 04 a0 a4',
    });
    const c = await p.scannerReadCounts(s.link, mod('ZKE'), {
      kwp: false,
      raw: null,
    });
    assert.deepStrictEqual(c, { errors: 1, shadow: 3 });
    await p.scannerClearProc(s.link, mod('ZKE'), { kwp: false, raw: null });
    assert.strictEqual(s.sent[2], 'ds2 0 05 00 00');
  });

  await ok(
    'SRS: access 90 FF FF / 95 + ident bytes, shadow, clear with the A1 retry',
    async () => {
      const ident = h('a4 10 a0 86 93 32 38 10 32 09 14 33 04 08 33 38');
      const s = scripted({
        'ds2 a4 04 00': 'a4 05 a0 03 02',
        'ds2 a4 90 ff ff': 'a4 04 a0 00',
        'ds2 a4 95 33 04 08 33': 'a4 04 a0 00',
        'ds2 a4 14 00': 'a4 05 a0 07 06',
        'ds2 a4 05': ['a4 04 a1 01', 'a4 04 a0 00'],
      });
      const c = await p.scannerReadCounts(s.link, mod('SRS'), {
        kwp: false,
        raw: ident,
      });
      assert.deepStrictEqual(c, { errors: 3, shadow: 7 });
      const r = await p.scannerClearProc(s.link, mod('SRS'), {
        kwp: false,
        raw: ident,
      });
      assert.ok(r.ok);
      assert.deepStrictEqual(s.sent.slice(4), [
        'ds2 a4 90 ff ff',
        'ds2 a4 95 33 04 08 33',
        'ds2 a4 05',
        'ds2 a4 05',
      ]);
      assert.deepStrictEqual(s.slept, [1200, 3000, 2000]);
    }
  );

  await ok(
    'DME (KWP): count 18 02 FF FF, clear 14 FF FF, 1 s + 2 s',
    async () => {
      const s = scripted({
        'kwp 12 18 02 ff ff': 'b8 f1 12 08 58 02 29 9a e8 27 c3 41 f7',
        'kwp 12 14 ff ff': 'b8 f1 12 03 54 ff ff 0c',
      });
      const c = await p.scannerReadCounts(s.link, mod('DME'), {
        kwp: true,
        raw: null,
      });
      assert.deepStrictEqual(c, { errors: 2, shadow: null });
      const r = await p.scannerClearProc(s.link, mod('DME'), {
        kwp: true,
        raw: null,
      });
      assert.ok(r.ok);
      assert.deepStrictEqual(s.slept, [1000, 2000]);
    }
  );

  await ok('ABS (KWP at 0x29): 14 FF FF refused -> 14 00 00', async () => {
    assert.strictEqual(p.scannerKwpAddress(mod('ABS')), 0x29);
    assert.strictEqual(p.scannerKwpAddress(mod('EGS')), 0x18);
    const s = scripted({
      'kwp 29 14 ff ff': 'b8 f1 29 03 7f 14 22 2a',
      'kwp 29 14 00 00': 'b8 f1 29 03 7f 14 22 2a',
    });
    const r = await p.scannerClearProc(s.link, mod('ABS'), {
      kwp: true,
      raw: null,
    });
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(s.sent, ['kwp 29 14 ff ff', 'kwp 29 14 00 00']);
  });

  await ok(
    'the K+DCAN link frames DS2 and KWP2000* like the adapter did',
    async () => {
      const out = [];
      const link = p.scannerProcLink(
        async (o, comm) => {
          out.push([
            o.map((b) => b.toString(16).padStart(2, '0')).join(' '),
            comm.concept,
          ]);
          return [];
        },
        (fn) => fn()
      );
      await link.ds2(0x80, [0x04, 0x00]);
      await link.kwp(0x12, [0x14, 0xff, 0xff]);
      // the checksum is the bus's to add, as for every telegram
      assert.deepStrictEqual(out, [
        ['80 05 04 00', 6],
        ['b8 12 f1 03 14 ff ff', 0x10d],
      ]);
    }
  );

  console.log('ALL PASS');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
