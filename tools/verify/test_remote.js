#!/usr/bin/env node
// The remote seam, headless. No WebRTC here -- that is browser plumbing --
// but the message protocol and the car-route classifier are pure and are
// exactly what a wrong edit would break.
const assert = require('assert');
global.window = undefined;
global.crypto = require('crypto').webcrypto;
global.Response = class { constructor(b, o) { this.body = b; this.status = (o||{}).status; } async json() { return JSON.parse(this.body); } };
const { Remote, REMOTE_CAR_ROUTE } = require('../../app/renderer/core/remote.js');

let passed = 0;
const ok = (m) => { passed++; console.log(`  ok    ${m}`); };

(async () => {
// ---- 1. only car routes cross the wire --------------------------------------
const remote = [
  '/api/ecu/ms450ds0/run/FS_LESEN',
  '/api/ecu/ms450ds0/run/STEUERN_LL_STELLER?arg=50',
  '/api/ecu/zke5/clear/FS_LOESCHEN',
  '/api/ecu/kombi46/write/COD',
  '/api/port',
];
const local = [
  '/api/chassis',
  '/api/chassis/E46',
  '/api/ecu/ms450ds0/ir',
  '/api/ecu/ms450ds0/ir?code=x',
  '/api/ecu/ms450ds0/tables',
  '/api/ecu/ms450ds0/results/FS_LESEN',
  '/data/groups/variants.json',
  '/api/ecu-index.json',
];
for (const r of remote) assert.ok(REMOTE_CAR_ROUTE.test(r), `should forward: ${r}`);
for (const r of local) assert.ok(!REMOTE_CAR_ROUTE.test(r), `should stay local: ${r}`);
ok(`car-route filter: ${remote.length} forwarded, ${local.length} local`);

// ---- 2. codes are one-shot, unambiguous -------------------------------------
const seen = new Set();
for (let i = 0; i < 200; i++) {
  const c = Remote.newCode();
  assert.match(c, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/, `bad code ${c}`);
  seen.add(c);
}
assert.ok(seen.size >= 199, 'codes must not collide in 200 draws');
ok('codes: 8 unambiguous chars, effectively unique');

// ---- 3. helper request/response round-trips through the protocol -----------
const sent = [];
Remote.role = 'helper';
Remote.chan = { readyState: 'open', send: (s) => sent.push(JSON.parse(s)) };
const p = Remote.request('/api/ecu/ms450ds0/run/FS_LESEN', { method: 'POST' });
assert.strictEqual(sent.length, 1);
assert.strictEqual(sent[0].t, 'req');
assert.strictEqual(sent[0].path, '/api/ecu/ms450ds0/run/FS_LESEN');
assert.strictEqual(sent[0].init.method, 'POST');
// owner answers
Remote._helperResponse({ t: 'res', id: sent[0].id,
  status: 200, body: { job: 'FS_LESEN', sets: [{ JOB_STATUS: 'OKAY' }] } });
const res = await p;
assert.strictEqual(res.status, 200);
const body = await res.json();
assert.strictEqual(body.sets[0].JOB_STATUS, 'OKAY');
ok('protocol: helper req -> owner res -> a Response api() can consume');

Remote.role = null; Remote.chan = null;
console.log(`\nremote: ${passed} checks passed`);
})();
