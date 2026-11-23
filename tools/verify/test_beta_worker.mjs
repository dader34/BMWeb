#!/usr/bin/env node
// The beta collector (tools/beta/worker.js) as the app's two senders meet
// it: a bug report and a feedback answer through the same door, each on its
// own shelf, read back only with the token.
//
//   node tools/verify/test_beta_worker.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

// The worker is an ES module in a .js file, which wrangler takes as it is
// and Node before 22 does not (the repository's package.json is not
// "type": "module", and the renderer's scripts must not become modules by
// making it so). Imported from its text, it loads on any Node.
const source = readFileSync(new URL('../beta/worker.js', import.meta.url));
const { default: worker } = await import(
  `data:text/javascript;base64,${source.toString('base64')}`
);

let passed = 0;
const ok = (what) => {
  passed++;
  if (process.env.V) console.log('  ok', what);
};

/** A KV namespace, as much of one as the worker uses. */
const kv = () => {
  const data = new Map();
  return {
    data,
    put: async (k, v) => void data.set(k, v),
    get: async (k) => (data.has(k) ? data.get(k) : null),
    delete: async (k) => void data.delete(k),
    list: async ({ prefix }) => ({
      keys: [...data.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true,
    }),
  };
};
const env = { BETA: kv(), TOKEN: 'reader-token' };
const BASE = 'https://collector.example';
const post = (body, raw) =>
  worker.fetch(
    new Request(`${BASE}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-ipcountry': 'DE' },
      body: raw === undefined ? JSON.stringify(body) : raw,
    }),
    env
  );
const read = (path, token) =>
  worker.fetch(
    new Request(`${BASE}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
    env
  );

// ---- each kind on its own shelf ----------------------------------------------
{
  const bug = await (
    await post({ v: 1, tester: 'ab12cd34', desc: 'x' })
  ).json();
  assert.ok(
    bug.ok && /^r\/\d{4}-\d\d-\d\d\/\d+-ab12cd34-/.test(bug.key),
    bug.key
  );
  const fb = await (
    await post({
      v: 1,
      kind: 'feedback',
      tester: 'ab12cd34',
      feedback: { used: 'regular', rating: 5, wants: 'more cars' },
    })
  ).json();
  assert.ok(fb.ok && /^f\/\d{4}-\d\d-\d\d\/\d+-ab12cd34-/.test(fb.key), fb.key);
  ok('a bug report is kept under r/, feedback under f/');

  // the default listing is the bug reports, as it was; f/ is asked for
  const bugs = await (await read('/reports', env.TOKEN)).json();
  assert.deepStrictEqual(
    bugs.keys.map((k) => k.key),
    [bug.key]
  );
  const fbs = await (await read('/reports?prefix=f/', env.TOKEN)).json();
  assert.deepStrictEqual(
    fbs.keys.map((k) => k.key),
    [fb.key]
  );
  const back = await (
    await read(`/report?key=${encodeURIComponent(fb.key)}`, env.TOKEN)
  ).json();
  assert.deepStrictEqual(back.feedback, {
    used: 'regular',
    rating: 5,
    wants: 'more cars',
  });
  assert.strictEqual(back._country, 'DE');
  assert.ok(back._received, 'stamped when it arrived');
  ok('each shelf lists its own, and feedback reads back whole');
}

// ---- reading is the owner's alone ---------------------------------------------
{
  assert.strictEqual((await read('/reports?prefix=f/')).status, 401);
  assert.strictEqual((await read('/reports?prefix=f/', 'guess')).status, 401);
  ok('no token, no reading');
}

// ---- what is not a report is refused, not stored and not a crash --------------
{
  const before = env.BETA.data.size;
  for (const raw of ['null', '42', '[1,2]', '"text"', 'not json'])
    assert.strictEqual((await post(null, raw)).status, 400, raw);
  assert.strictEqual(env.BETA.data.size, before, 'something was stored');
  // a tester id cannot steer the key
  const odd = await (
    await post({ kind: 'feedback', tester: '../../r/x y', feedback: {} })
  ).json();
  assert.ok(
    /^f\/\d{4}-\d\d-\d\d\/\d+-rxy-[0-9a-f]{8}\.json$/.test(odd.key),
    odd.key
  );
  const anon = await (await post({ kind: 'feedback', tester: 7 })).json();
  assert.ok(/-7-[0-9a-f]{8}\.json$/.test(anon.key), anon.key);
  ok(
    'null, a number, a list and text are refused; a tester id cannot shape the key'
  );
}

console.log(`test_beta_worker: ${passed} checks passed`);
