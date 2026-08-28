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
const tick = () => new Promise((r) => setImmediate(r));
const sent = [];
Remote.role = 'helper';
Remote.chan = { readyState: 'open', send: (s) => sent.push(JSON.parse(s)) };
const p = Remote.request('/api/ecu/ms450ds0/run/FS_LESEN', { method: 'POST' });
await tick();
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

// ---- 4. a request before the channel opens WAITS for it ---------------------
// (the second-connect bug: the cable chip asked /api/port while ICE was still
// running, the request fell through to the local shim, and a machine with no
// cable said "no cable" about someone else's car)
sent.length = 0;
Remote.chan = null;                              // joined, channel not yet up
const early = Remote.request('/api/port');
await tick();
assert.strictEqual(sent.length, 0, 'nothing sent while the channel is down');
assert.strictEqual(Remote.waiters.length, 1, 'the request is parked');
// the channel arrives and opens: _wire hooks it, onopen wakes the waiter
const chan = { readyState: 'connecting', send: (s) => sent.push(JSON.parse(s)) };
Remote._wire(chan);
chan.readyState = 'open';
chan.onopen();
await tick();
assert.strictEqual(sent.length, 1, 'parked request sent once the channel opened');
assert.strictEqual(sent[0].path, '/api/port');
Remote._helperResponse({ t: 'res', id: sent[0].id, status: 200,
  body: { port: '/dev/cu.usbserial-OWNER' } });
assert.strictEqual((await (await early).json()).port, '/dev/cu.usbserial-OWNER');
ok('a car fetch before the channel opens waits, then goes to the owner');

// ---- 5. teardown rejects what is parked; the session does not leak ---------
Remote.chan = null;
const parked = Remote.request('/api/port');
await tick();
Remote._teardown();
await assert.rejects(parked, /remote session ended/);
assert.strictEqual(Remote.waiters.length, 0);
assert.strictEqual(Remote.pending.size, 0);
assert.strictEqual(Remote.chan, null);
ok('teardown: parked and in-flight requests reject, state is clean');

// ---- 6. not a helper: a car fetch is refused, never silently local ---------
Remote.role = null;
await assert.rejects(Remote.request('/api/port'), /not in a remote session/);
ok('request() outside a session rejects instead of pretending');

Remote.role = null; Remote.chan = null;
console.log(`\nremote: ${passed} checks passed`);
})();
