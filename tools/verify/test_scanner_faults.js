#!/usr/bin/env node
// BMWeb Scanner's Errors window (app/renderer/screens/scanner/
// scanner-faults.js) held to BMW Scanner 1.4.0.7 itself: every unit on the
// E46 is read through the answers its USB capture recorded (fixtures/
// scanner-faults.json), and the faults, codes, texts and present markers
// must be exactly what the reference's own fault and text routines produced
// from the same answers (run over its memory dump).
//
// Run: node tools/verify/test_scanner_faults.js
const assert = require('assert');
const path = require('path');
const fx = require(path.join(__dirname, 'fixtures/scanner-faults.json'));
const data = require('../../app/renderer/screens/scanner/scanner-data.js');
const proc = require('../../app/renderer/screens/scanner/scanner-proc.js');
const pack = require('./scanner_pack.js').scannerPackOrSkip('scanner faults');
Object.assign(global, data, proc, {
  SCANNER_FAULT_TEXTS: pack.faultTexts,
  SCANNER_FAULT_ALPHABET: pack.faultAlphabet,
});
const f = require('../../app/renderer/screens/scanner/scanner-faults.js');

const hex = (a) => a.map((b) => b.toString(16).padStart(2, '0')).join(' ');
const parse = (s) => s.split(' ').map((x) => parseInt(x, 16));
const link = {
  ds2: async (addr, payload) => {
    const a = fx.answers[hex([addr, payload.length + 3, ...payload])];
    if (!a) throw new Error('silent');
    return parse(a);
  },
  kwp: async (addr, payload) => {
    const a = fx.answers[hex([0xb8, addr, 0xf1, payload.length, ...payload])];
    if (!a) throw new Error('silent');
    return parse(a);
  },
  sleep: async () => {},
};
const identOf = (m) => {
  const a = fx.answers[hex([m.address, 4, 0])];
  return a ? parse(a) : null;
};

(async () => {
  let n = 0;
  for (const [name, want] of Object.entries(fx.expected)) {
    const m = data.SCANNER_MODULES.find((x) => x.name === name);
    const raw = identOf(m);
    const res = await f.scannerReadFaultList(link, m, { kwp: !raw, raw });
    for (const kind of ['errors', 'shadow']) {
      const got = (res[kind] || []).map((x) => {
        const t = f.scannerFaultText(name, x.code, x.param, kind === 'shadow');
        return {
          code: x.code
            .toString(16)
            .toUpperCase()
            .padStart(x.code >= 0x100 ? 4 : 2, '0'),
          param: x.param.toString(16).toUpperCase().padStart(2, '0'),
          text: t.text,
          state: t.state,
        };
      });
      assert.deepStrictEqual(got, want[kind], `${name} ${kind}`);
      n += got.length;
    }
    console.log(
      `  ok   ${name}: ${want.errors.length} fault(s), ${want.shadow.length} in the shadow memory, as the reference shows them`
    );
  }
  assert.strictEqual(f.scannerFaultCode(0x32), '32 [ 050 ]');
  assert.strictEqual(f.scannerFaultCode(0x27c3), '27C3 [ 10179 ]');
  assert.strictEqual(
    f.scannerFaultText('IKE', 0x07, 0).text,
    'Error number 07'
  );
  console.log(`ALL PASS (${n} faults)`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
