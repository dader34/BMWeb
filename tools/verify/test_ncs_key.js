#!/usr/bin/env node
// Read Vin/ZCS from car (screens/coding/ncs-key.js) as NCS Expert does it:
// the SGFAM key holders in order, through their coding scripts' read jobs,
// passing over a holder whose key is erased (all F) as coapiReadFgNr does.
//
// Run: node tools/verify/test_ncs_key.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const R = path.join(__dirname, '..', '..', 'app', 'renderer');

/**
 * Run ncsReadKeyFromCar against stub modules.
 * @param {Record<string, Record<string, object>>} answers - module -> job ->
 *   result pars.
 */
async function read(answers) {
  const calls = [];
  const ctx = {
    window: {
      BMW_TABLES: {
        E46: {
          sgfam: {
            EWS: { zcs: true, cabd: 'C_EWS', asw: 'A_EWS' },
            KMB: { zcs: true, cabd: 'C_KMB46', asw: 'A_KMB' },
          },
        },
      },
    },
    loadTables: async () => {},
    codingScriptIndex: async () => ({ A_EWS: 'ews', A_KMB: 'kmb' }),
    webCodingScript: async () => ({
      procs: { cabimain: [{ op: 'const', v: 'ZCS_LESEN' }] },
    }),
    webCodingReadJob: async (sgbd, { jobname }) => {
      calls.push(`${sgbd} ${jobname}`);
      const pars = (answers[sgbd] || {})[jobname];
      return pars ? { ok: true, pars } : { ok: false, info: 'no answer' };
    },
  };
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(
    fs.readFileSync(path.join(R, 'screens/coding/ncs-key.js'), 'utf8'),
    ctx
  );
  const got = await ctx.ncsReadKeyFromCar('E46');
  return { got, calls };
}

const KEY = {
  GM_SCHLUESSEL: '0B2400A0W',
  SA_SCHLUESSEL: '28A2D1DC08010000K',
  VN_SCHLUESSEL: '0000000000F',
};
const ERASED = {
  GM_SCHLUESSEL: 'FFFFFFFFP',
  SA_SCHLUESSEL: 'FFFFFFFFFFFFFFFFE',
  VN_SCHLUESSEL: 'FFFFFFFFFFF',
};

(async () => {
  let passed = 0;
  const ok = (m) => {
    passed++;
    console.log(`  ok    ${m}`);
  };

  {
    const { got, calls } = await read({
      c_ews: { ZCS_LESEN: KEY },
      c_kmb46: { ZCS_LESEN: ERASED },
    });
    assert.deepStrictEqual(calls, ['c_ews ZCS_LESEN']);
    assert.strictEqual(got.keys.gm, '0B2400A0');
    ok('the first key holder that answers gives the key');
  }

  {
    const { got, calls } = await read({
      c_ews: { ZCS_LESEN: ERASED },
      c_kmb46: { ZCS_LESEN: KEY },
    });
    assert.deepStrictEqual(calls, ['c_ews ZCS_LESEN', 'c_kmb46 ZCS_LESEN']);
    assert.strictEqual(got.keys.sa.slice(0, 16), '28A2D1DC08010000');
    assert.match(got.tried[0].info, /erased/);
    ok('an erased key (all F) is passed over for the next holder');
  }

  {
    const { got } = await read({
      c_ews: { ZCS_LESEN: ERASED },
      c_kmb46: { ZCS_LESEN: ERASED },
    });
    assert.strictEqual(got.keys, null);
    ok('erased everywhere is no key');
  }

  console.log(`\n${passed} passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
