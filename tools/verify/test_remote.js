#!/usr/bin/env node
// The remote seam, headless. No WebRTC here -- that is browser plumbing --
// but the message protocol and the car-route classifier are pure and are
// exactly what a wrong edit would break.
const assert = require('assert');
global.window = undefined;
global.crypto = require('crypto').webcrypto;
global.Response = class {
  constructor(b, o) {
    this.body = b;
    this.status = (o || {}).status;
  }
  async json() {
    return JSON.parse(this.body);
  }
};
// remote.js holds the engine (Remote + REMOTE_CAR_ROUTE); remote-ui.js holds
// the helper shim + overlays, split out of the old monolith.
const {
  Remote,
  REMOTE_CAR_ROUTE,
} = require('../../app/renderer/core/remote.js');

let passed = 0;
const ok = (m) => {
  passed++;
  console.log(`  ok    ${m}`);
};

(async () => {
  // ---- 1. only car routes cross the wire --------------------------------------
  const remote = [
    '/api/ecu/ms450ds0/run/FS_LESEN',
    '/api/ecu/ms450ds0/run/STEUERN_LL_STELLER?arg=50',
    '/api/ecu/zke5/clear/FS_LOESCHEN',
    '/api/ecu/kombi46/write/COD',
    '/api/port',
    '/api/state',
    '/api/state?sgbd=ms450ds0',
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
  for (const r of remote)
    assert.ok(REMOTE_CAR_ROUTE.test(r), `should forward: ${r}`);
  for (const r of local)
    assert.ok(!REMOTE_CAR_ROUTE.test(r), `should stay local: ${r}`);
  ok(`car-route filter: ${remote.length} forwarded, ${local.length} local`);
  assert.ok(
    !REMOTE_CAR_ROUTE.test('/api/statement'),
    'state must not match a prefix'
  );

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
  const p = Remote.request('/api/ecu/ms450ds0/run/FS_LESEN', {
    method: 'POST',
  });
  await tick();
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].t, 'req');
  assert.strictEqual(sent[0].path, '/api/ecu/ms450ds0/run/FS_LESEN');
  assert.strictEqual(sent[0].init.method, 'POST');
  // owner answers
  Remote._helperResponse({
    t: 'res',
    id: sent[0].id,
    status: 200,
    body: { job: 'FS_LESEN', sets: [{ JOB_STATUS: 'OKAY' }] },
  });
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
  Remote.chan = null; // joined, channel not yet up
  const early = Remote.request('/api/port');
  await tick();
  assert.strictEqual(sent.length, 0, 'nothing sent while the channel is down');
  assert.strictEqual(Remote.waiters.length, 1, 'the request is parked');
  // the channel arrives and opens: _wire hooks it. On open the helper now sends
  // a `hello` and PARKS -- consent first. The parked car request must NOT flush
  // until the owner admits (an untrusted helper cannot command the car merely by
  // completing ICE).
  const chan = {
    readyState: 'connecting',
    send: (s) => sent.push(JSON.parse(s)),
  };
  Remote._wire(chan);
  chan.readyState = 'open';
  chan.onopen();
  await tick();
  assert.strictEqual(
    sent.length,
    1,
    'on open the helper sends exactly one message'
  );
  assert.strictEqual(
    sent[0].t,
    'hello',
    'and it is the hello, not the car request'
  );
  assert.strictEqual(
    Remote.waiters.length,
    1,
    'the car request stays parked pre-admit'
  );
  // owner admits: only now does the parked request go to the car
  Remote._onMessage({
    data: JSON.stringify({ t: 'admit', ok: true, access: 'rw' }),
  });
  await tick();
  assert.strictEqual(
    sent.length,
    2,
    'the parked request flushes once admitted'
  );
  assert.strictEqual(sent[1].path, '/api/port');
  Remote._helperResponse({
    t: 'res',
    id: sent[1].id,
    status: 200,
    body: { port: '/dev/cu.usbserial-OWNER' },
  });
  assert.strictEqual(
    (await (await early).json()).port,
    '/dev/cu.usbserial-OWNER'
  );
  ok(
    'a car fetch waits for the channel AND the owner admitting, then goes over'
  );

  // ---- 4b. the owner gate: read-only refuses writes, confirm gates them ------
  const oreq = [];
  Remote.role = 'owner';
  Remote.chan = { readyState: 'open', send: (s) => oreq.push(JSON.parse(s)) };
  Remote.accepted = true;
  // a realistic classifier so read jobs are seen as reads and *_SCHREIBEN as
  // writes -- mirrors bestvm's isWriteJob (read token wins, else default-deny)
  global.isWriteJob = (n) => !/LESEN|STATUS|READ/i.test(String(n || ''));
  // read-only: a write route is refused without ever fetching
  Remote.access = 'ro';
  Remote.confirmActions = false;
  global.window = {
    fetch: async () => {
      throw new Error('MUST NOT FETCH');
    },
  };
  await Remote._ownerHandle({
    t: 'req',
    id: 'w1',
    path: '/api/ecu/zke5/clear/FS_LOESCHEN',
  });
  assert.strictEqual(
    oreq.at(-1).status,
    403,
    'read-only session refuses a write'
  );
  // a non-car route is refused by the owner-side allowlist too
  await Remote._ownerHandle({ t: 'req', id: 'w2', path: '/api/chassis/E46' });
  assert.strictEqual(oreq.at(-1).status, 403, 'owner refuses a non-car route');
  // rw + confirm on: the owner must approve; deny => refused, no fetch
  Remote.access = 'rw';
  Remote.confirmActions = true;
  Remote.onGate = async () => false;
  await Remote._ownerHandle({
    t: 'req',
    id: 'w3',
    path: '/api/ecu/zke5/clear/FS_LOESCHEN',
  });
  assert.strictEqual(
    oreq.at(-1).status,
    403,
    'a denied write is refused, not run'
  );
  // approve => it runs through the owner shim
  Remote.onGate = async () => true;
  global.window = {
    fetch: async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }),
  };
  await Remote._ownerHandle({
    t: 'req',
    id: 'w4',
    path: '/api/ecu/zke5/clear/FS_LOESCHEN',
  });
  assert.strictEqual(oreq.at(-1).status, 200, 'an approved write runs');
  // reads are never gated even with confirm on -- NONE of these may prompt:
  // /port and /state (no job name -> must not hit the default-deny classifier),
  // and an actual read job on a /run/ route.
  let gateCalls = 0;
  Remote.onGate = async () => {
    gateCalls++;
    return true;
  };
  for (const p of [
    '/api/port',
    '/api/state',
    '/api/state?sgbd=ms450ds0',
    '/api/ecu/ms450ds0/run/FS_LESEN',
    '/api/ecu/ms450ds0/run/STATUS_LESEN',
  ]) {
    await Remote._ownerHandle({ t: 'req', id: 'r_' + p, path: p });
    assert.strictEqual(oreq.at(-1).status, 200, `read runs through: ${p}`);
  }
  assert.strictEqual(gateCalls, 0, 'no read of any kind prompts the owner');
  // a request before the owner admits is refused
  Remote.accepted = false;
  Remote._onMessage({
    data: JSON.stringify({ t: 'req', id: 'r2', path: '/api/port' }),
  });
  await tick();
  assert.strictEqual(
    oreq.at(-1).status,
    403,
    'nothing runs before the owner admits'
  );
  Remote.onGate = null;
  global.window = undefined;
  delete global.isWriteJob;
  // restore helper role + a clean channel for the teardown test that follows
  Remote.role = 'helper';
  Remote.accepted = false;
  Remote.chan = null;
  ok(
    'owner gate: read-only blocks writes, confirm gates writes, reads pass, pre-admit blocked'
  );

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

  // ---- 7. ICE is gathered first and rides inside the offer -- no trickle ----
  // (the regression: candidates went through the KV mailbox one write each,
  // which is eventually consistent across edge locations; same-LAN peers
  // never noticed, a phone on data hung at "negotiating" every first try)
  global.RTCPeerConnection = class {
    constructor() {
      this.connectionState = 'new';
      this.iceGatheringState = 'new';
      this.localDescription = null;
    }
    createDataChannel() {
      return { readyState: 'connecting', send() {} };
    }
    async createOffer() {
      return { type: 'offer', sdp: 'o' };
    }
    async createAnswer() {
      return { type: 'answer', sdp: 'a' };
    }
    async setLocalDescription(d) {
      this.localDescription = {
        type: d.type,
        sdp: d.sdp + ' (no candidates yet)',
      };
      this.iceGatheringState = 'gathering';
      // candidates arrive after a beat, then gathering completes and the
      // local description is the full one
      setTimeout(() => {
        this.onicecandidate &&
          this.onicecandidate({ candidate: { c: 'host1' } });
        this.localDescription = {
          type: d.type,
          sdp: d.sdp + ' a=candidate:host1 a=candidate:srflx1',
        };
        this.iceGatheringState = 'complete';
        this.onicegatheringstatechange && this.onicegatheringstatechange();
      }, 20);
    }
    async setRemoteDescription() {}
    async addIceCandidate() {}
    close() {
      this.connectionState = 'closed';
    }
  };
  const calls = [];
  Remote.base = () => 'http://sig';
  Remote.sig = async (action, body) => {
    calls.push([action, body]);
    return { ok: true };
  };
  Remote.role = 'owner';
  Remote.code = 'TESTCODE';
  await Remote._offer();
  clearInterval(Remote.poll);
  Remote.poll = null;
  assert.deepStrictEqual(
    calls.map((c) => c[0]),
    ['offer'],
    `exactly one offer POST and no ice POSTs, got ${calls.map((c) => c[0]).join(',')}`
  );
  assert.match(
    calls[0][1].offer.sdp,
    /candidate:host1.*candidate:srflx1/,
    'the posted offer must be the gathered local description'
  );
  ok(
    'owner: waits for ICE gathering, posts one offer with every candidate inside'
  );

  // ---- 8. helper whose ICE fails before any channel arrives is ended ---------
  Remote._teardown();
  Remote.role = 'helper';
  Remote.code = 'TESTCODE';
  Remote.pc = new RTCPeerConnection();
  Remote._watch(Remote.pc);
  let ended = null;
  Remote.onState = (st) => {
    if (st === 'closed') ended = true;
  };
  Remote.pc.connectionState = 'failed';
  Remote.pc.onconnectionstatechange();
  assert.strictEqual(
    ended,
    true,
    'end() must run on a failed connection with no channel'
  );
  assert.strictEqual(Remote.role, null);
  ok('helper: failed ICE with no channel ends the session (badge comes down)');
  Remote.onState = null;

  Remote.role = null;
  Remote.chan = null;

  // ---- 9. share persistence: survives a reload, expires, clears on end -------
  // a tiny in-memory localStorage so the persistence helpers are exercisable
  const store = new Map();
  global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  // nothing stored -> nothing to resume
  assert.strictEqual(Remote.savedShare(), null, 'no stored share -> null');
  // simulate a share having been persisted
  Remote.code = 'ABCD2345';
  Remote.access = 'ro';
  Remote.confirmActions = true;
  Remote.startedAt = Date.now();
  Remote._persist();
  let s = Remote.savedShare();
  assert.ok(
    s && s.code === 'ABCD2345' && s.access === 'ro',
    'a share round-trips through storage'
  );
  // an OLD share that was never joined is expired and unresumable
  store.set(
    Remote.SHARE_KEY,
    JSON.stringify({
      code: 'OLD12345',
      access: 'rw',
      startedAt: Date.now() - (Remote.EXPIRE_MS + 1000),
    })
  );
  assert.strictEqual(
    Remote.savedShare(),
    null,
    'a >5-min never-joined share is dropped'
  );
  // an old share that WAS joined stays resumable (established sessions persist)
  store.set(
    Remote.SHARE_KEY,
    JSON.stringify({
      code: 'JOIN2345',
      access: 'rw',
      everJoined: true,
      startedAt: Date.now() - (Remote.EXPIRE_MS + 1000),
    })
  );
  assert.ok(
    Remote.savedShare(),
    'an established (joined) share resumes regardless of age'
  );
  // end() clears the stored share so it never auto-resumes after an explicit end
  Remote.role = 'owner';
  Remote.code = 'JOIN2345';
  Remote.end('you ended it');
  assert.strictEqual(
    Remote.savedShare(),
    null,
    'end() clears the persisted share'
  );
  ok('share persists across reload, expires unjoined at 5 min, clears on end');
  delete global.localStorage;

  Remote.role = null;
  Remote.chan = null;
  console.log(`\nremote: ${passed} checks passed`);
})();
