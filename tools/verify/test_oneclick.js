#!/usr/bin/env node
// The selector-5 one-click client (core/flash/oneclick.js) against the
// REAL RUN's bytes: the emulator proof with the true slot-5 factors
// (ms45-emu tools/experiments/noinstall_v5r.py, "ONE-CLICK FLASH CONTROL:
// PASS" 2026-11-04, v5r_real_PASS.log) handed out seed 7c510fe3c232ee01,
// computed T fdffa0ee.. and the answer x 9b7b98fb.. in the limbs_le form
// granted on -- this proves the client reproduces exactly that arithmetic,
// then the whole login -> grant -> trigger chain against a mock DME that
// checks the answer the way the loader does. No hardware.
//
//   node tools/verify/test_oneclick.js
if (typeof global.window === 'undefined') global.window = {};
const { oneClick } = require('../../app/renderer/core/flash/oneclick.js');
const { triggerWire } = require('../../app/renderer/core/flash/trigger.js');
const {
  fastFlasherBlob,
} = require('../../app/renderer/core/generated/fast-flasher-blob.js');
const { _md5 } = require('../../app/renderer/core/flash/flasher.js');

let failures = 0;
const check = (what, ok, detail) => {
  if (!ok) {
    failures++;
    console.log(`  FAIL  ${what}${detail ? ' -- ' + detail : ''}`);
  } else console.log(`  ok    ${what}`);
};
const hex = (b) =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// The real run's values (v5r_real_PASS.log), embedded as literals so a
// regression in the constants or the math cannot pass against itself.
const REAL = {
  seed: '7c510fe3c232ee01',
  T: 'fdffa0ee194270b5062cbfd33cb5ac37',
  // the x the 'li' form carried when the slots flipped to (5, 3, 0)
  x: BigInt(
    '0x9b7b98fb5f6af815726b7f76210d348dd2b3df00c26dfbe67798130d9f1df6e4' +
      '53a8d7bfe033e91e228f9b46d3c11da8f01e8ff980da35dc47427a3ad586c847'
  ),
};

// an independent modular exponentiation, so the round-trips below do not
// lean on the module's own
const pow = (b, e, m) => {
  let r = 1n,
    x = b % m;
  while (e > 0n) {
    if (e & 1n) r = (r * x) % m;
    e >>= 1n;
    x = (x * x) % m;
  }
  return r;
};

// ---- the constants -----------------------------------------------------------
check(
  'constants: the primes multiply to the modulus',
  oneClick.P * oneClick.Q === oneClick.N
);

// ---- the answer arithmetic ----------------------------------------------------
const seedBytes = Array.from(REAL.seed.match(/../g), (h) => parseInt(h, 16));
const t = _md5(
  new Uint8Array([
    0,
    0,
    0,
    0, // EB3 (stock @0x3F993D: zeros)
    ...Array.from('174M', (c) => c.charCodeAt(0)), // EB7 (@0x3F9939)
    ...seedBytes,
  ])
);
check("math: T is the real run's MD5", hex(t) === REAL.T, hex(t));
// the two views of T the proof parses (noinstall_v5r.py: little, and the
// dword-rotated big-endian)
let leView = 0n;
for (let i = 15; i >= 0; i--) leView = (leView << 8n) | BigInt(t[i]);
const rot = new Uint8Array(16);
rot.set(t.subarray(12, 16), 0);
rot.set(t.subarray(8, 12), 4);
rot.set(t.subarray(4, 8), 8);
rot.set(t.subarray(0, 4), 12);
let rotView = 0n;
for (let i = 0; i < 16; i++) rotView = (rotView << 8n) | BigInt(rot[i]);

const cands = oneClick.candidates(t);
check('math: two candidates', cands.length === 2);
check(
  'math: the LE view first -- the one the real run granted on',
  cands[0] === REAL.x,
  cands[0].toString(16).slice(0, 12)
);
check(
  'math: the rotated view second, both roots of their views',
  cands[1] !== REAL.x &&
    pow(cands[0], 7n, oneClick.N) === leView &&
    pow(cands[1], 7n, oneClick.N) === rotView
);
const li = oneClick.limbsLe(REAL.x);
check(
  "wire: the li form's lead bytes are the real run's",
  hex(li.subarray(0, 8)) === 'd586c84747427a3a',
  hex(li.subarray(0, 8))
);
check(
  'wire: the DME parse folds the li form back to x',
  oneClick.limbsLeToBigInt(li) === REAL.x
);
check(
  'wire: d5 really inverts 7 (the golden x round-trips through both views)',
  [leView, rotView].every(
    (m) => pow(pow(m, oneClick.D5, oneClick.N), 7n, oneClick.N) === m
  )
);

// ---- a mini-DME for the login -------------------------------------------------
// Models the loader's side with its own arithmetic: answers 23 reads out of
// a RAM map, hands out seeds and STAGES the unit's EB7 field as it does
// (zeros before the ask -- the bench-build find this test guards), checks
// the 31 08 (the li wire form's x, accepted when x^7 is either view of the
// seed's T), flips the slots on a pass, and echoes 71 08 even on a fail --
// the lie the real loader tells.
function miniDme(seedHexes, opts = {}) {
  const ram = new Map();
  const put = (at, bytes) => bytes.forEach((b, i) => ram.set(at + i, b));
  put(oneClick.EB7, [0, 0, 0, 0]); // staged by the ask, like the loader does
  put(oneClick.EB3, [0, 0, 0, 0]);
  put(oneClick.VARIANT, [0]); // stock: variant 0, a36 1, a37 0
  put(oneClick.A36, [1]);
  put(oneClick.A37, [0]);
  const field = Array.from(opts.field || '174M', (c) => c.charCodeAt(0));
  const read = (at, n) => [...Array(n)].map((_, i) => ram.get(at + i) ?? 0xff);
  const state = { seedNo: 0, answers: 0, telegrams: [] };
  const dme = async (data) => {
    state.telegrams.push(Array.from(data));
    const h = hex(data);
    if (data[0] === 0x23) {
      const at = (data[1] << 16) | (data[2] << 8) | data[3];
      return [0x63, ...read(at, data[4])];
    }
    if (data[0] === 0x31 && data[1] === 0x07) {
      const seed = Array.from(
        seedHexes[state.seedNo++ % seedHexes.length].match(/../g),
        (x) => parseInt(x, 16)
      );
      put(oneClick.EB7, field); // the ask stages the unit's login field
      return [0x71, 0x07, ...seed];
    }
    if (data[0] === 0x31 && data[1] === 0x08) {
      if (data.length !== 71) return [0x7f, 0x31, 0x08, 0x31];
      // the seed the DME is currently holding
      const seed = Array.from(
        seedHexes[(state.seedNo - 1) % seedHexes.length].match(/../g),
        (x) => parseInt(x, 16)
      );
      const T = _md5(
        new Uint8Array([
          ...read(oneClick.EB3, 4),
          ...read(oneClick.EB7, 4),
          ...seed,
        ])
      );
      let le = 0n;
      for (let i = 15; i >= 0; i--) le = (le << 8n) | BigInt(T[i]);
      const r = new Uint8Array(16);
      r.set(T.subarray(12, 16), 0);
      r.set(T.subarray(8, 12), 4);
      r.set(T.subarray(4, 8), 8);
      r.set(T.subarray(0, 4), 12);
      let rv = 0n;
      for (let i = 0; i < 16; i++) rv = (rv << 8n) | BigInt(r[i]);
      const x = oneClick.limbsLeToBigInt(data.slice(7));
      const x7 = pow(x, 7n, oneClick.N);
      state.answers++;
      const pass =
        (x7 === le || x7 === rv) &&
        !(opts.refuseFirst && state.answers <= opts.refuseFirst);
      if (pass) {
        put(oneClick.VARIANT, [oneClick.GRANT_VARIANT]);
        put(oneClick.A36, [3]);
        return [0x71, 0x08, 0x01];
      }
      return [0x71, 0x08, 0x00]; // the loader's lie: echo, no grant
    }
    throw new Error(`mock: unexpected request ${h}`);
  };
  return { dme, state };
}

// ---- the login against the mock ----------------------------------------------
(async () => {
  // 1: the real seed, granted on the first answer
  const m1 = miniDme([REAL.seed]);
  const g1 = await oneClick.login(m1.dme, { note: () => {} });
  check(
    'login: grants with the real seed (slots 5/3/0)',
    g1.variant === 5 && g1.a36 === 3 && g1.a37 === 0,
    `${g1.variant}/${g1.a36}/${g1.a37}`
  );
  check(
    "login: the granting x is the real run's x",
    g1.x === REAL.x,
    g1.x.toString(16).slice(0, 12)
  );
  check(
    'login: asks, reads the pair (staged by the ask), answers, reads the slots',
    m1.state.telegrams.length === 4 &&
      hex(m1.state.telegrams[0]).startsWith('310705') &&
      hex(m1.state.telegrams[1]).startsWith('233f9939') &&
      hex(m1.state.telegrams[2]).startsWith('31080000000010') &&
      hex(m1.state.telegrams[3]).startsWith('233f99c4'),
    m1.state.telegrams.map((tg) => hex(tg).slice(0, 4)).join(' ')
  );
  check(
    'login: the answer telegram carries the li form of the real x',
    hex(m1.state.telegrams[2].slice(7, 15)) === 'd586c84747427a3a'
  );

  // 1b: the bench build's field ('104M', staged by the ask -- zeros before
  // it) grants too, on a different x: the client must hash what it reads
  // AFTER the ask, never a value it read (or assumed) before
  const m1b = miniDme([REAL.seed], { field: '104M' });
  const g1b = await oneClick.login(m1b.dme, { note: () => {} });
  check(
    'login: a staged-after-ask field (the bench build shape) grants',
    g1b.variant === 5 && g1b.x !== REAL.x,
    `slots ${g1b.variant}/${g1b.a36}`
  );

  // 2: the first seed's answers refused -> a fresh seed is drawn
  const m2 = miniDme([REAL.seed, '0102030405060708'], { refuseFirst: 2 });
  const g2 = await oneClick.login(m2.dme, { note: () => {} });
  check(
    'login: a refused seed redraws and grants',
    g2.variant === 5 && m2.state.seedNo === 2,
    `seeds ${m2.state.seedNo}, slots ${g2.variant}/${g2.a36}`
  );

  // 3: never granted -> the client gives up with the DME's own words
  const m3 = miniDme([REAL.seed], { refuseFirst: 99 });
  let gave = null;
  try {
    await oneClick.login(m3.dme, { note: () => {} });
  } catch (e) {
    gave = e;
  }
  check(
    'login: a total refusal errors out, nothing written',
    !!gave && /refused every answer/.test(gave.message),
    gave && gave.message
  );
  check(
    'login: the refusal came after every round',
    m3.state.seedNo === oneClick.SEED_ROUNDS
  );

  // 4: a read the DME refuses stops the login right after the ask
  const m4 = {
    dme: async (data) => {
      if (data[0] === 0x31 && data[1] === 0x07)
        return [0x71, 0x07, 1, 2, 3, 4, 5, 6, 7, 8];
      if (data[0] === 0x23) return [0x7f, 0x23, 0x31];
      throw new Error('mock: nothing after a refused read');
    },
  };
  let refused = null;
  try {
    await oneClick.login(m4.dme, {});
  } catch (e) {
    refused = e;
  }
  check(
    'login: a refused read stops everything',
    !!refused && /refused a read/.test(refused.message),
    refused && refused.message
  );

  // ---- the grant + trigger chain ---------------------------------------------
  const body = triggerWire.triggerBodyFromBlob(fastFlasherBlob);
  const image = triggerWire.triggerImage(body);
  const tgs = triggerWire.triggerStageTelegrams(
    [image.img, triggerWire.TRIGGER.DESC],
    [image.stub, triggerWire.TRIGGER.STUB_AT]
  );
  let tgI = 0;
  const chain = miniDme([REAL.seed]);
  const chainDme = async (data) => {
    if (data[0] === 0x10 && data[1] === 0x86) {
      check(
        'chain: 10 86 opens AFTER the grant (two bytes)',
        hex(data) === '1086'
      );
      return [0x50, 0x86, 0x00, 0x32];
    }
    if (data[0] === 0x31 && data[1] === 0x02) return [0x71, 0x02, 0x01];
    if (data[0] === 0x3d) {
      tgI++;
      return [0x7d];
    }
    if (data[0] === 0x31 && data[1] === 0xfa) {
      check('chain: the fire is bare 31 FA', hex(data) === '31fa');
      return [0x71, 0xfa];
    }
    return chain.dme(data);
  };
  const r = await oneClick.grantAndFire(chainDme, body, {
    stage: () => {},
    note: () => {},
    progress: () => {},
  });
  check('chain: the grant came back with the fire', r.grant.variant === 5);
  check(
    "chain: the fire's reply is the arm pass (71 FA)",
    hex(r.replied) === '71fa'
  );
  check(
    'chain: login (4 telegrams) then every staged chunk (28)',
    tgI === tgs.length && chain.state.telegrams.length === 4,
    `${chain.state.telegrams.length} login, ${tgI} staged of ${tgs.length}`
  );

  console.log(failures ? `\nFAILED: ${failures}` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})();
