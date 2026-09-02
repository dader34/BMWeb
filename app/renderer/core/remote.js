// Remote diagnostics: an owner with the cable shares a live session; a helper
// with the code drives the WHOLE app against the owner's car.
//
// THE SEAM IS THE JOB, NOT THE SCREEN. Both run the same static app -- same
// screens, same VM, same data -- so nothing about the UI travels. The only
// thing the helper's browser lacks is the physical transport, and the app
// funnels every car-touching request through window.fetch to two routes:
//   /api/ecu/<sgbd>/run/<job>   run a job (and the coding write route)
//   /api/port                    which cable is attached
// The helper forwards exactly those to the owner; everything else it answers
// locally. The owner runs each forwarded job through its own real shim -- so
// every telegram, retry and K-line timing stays on the owner's machine, and
// only the finished result crosses the wire. One round trip per JOB.
//
// The transport is a WebRTC DataChannel, so once the two browsers are
// introduced the car data flows peer-to-peer with no server in the path.
// Signaling (offer/answer/ICE, matched by a one-shot code) rides the beta
// worker; a public STUN server reflects each side's address; Cloudflare's
// free TURN carries the ~10% of strict-NAT pairs that cannot punch through.
// See tools/beta/worker.js for the signaling routes.

const Remote = {
  role: null,          // 'owner' | 'helper' | null
  code: null,
  pc: null,            // RTCPeerConnection
  chan: null,          // RTCDataChannel
  poll: null,          // signaling poll timer
  pending: new Map(),  // helper: reqId -> {resolve, reject, timer}
  seq: 0,
  onLog: null,         // owner console hook
  onState: null,       // UI hook: 'connecting'|'live'|'closed'
  jobs: 0,
  ending: false,       // set while end() runs, so onclose does not re-host
  waiters: [],         // helper: resolvers parked until the channel opens

  // ---- OWNER-SIDE ACCESS POLICY (the security boundary) --------------------
  // The helper's browser is attacker-controllable, so NONE of the safety
  // decisions may live there. These are set by the OWNER at host() time and
  // enforced in _ownerHandle before a single telegram touches the car:
  //   access        'rw' | 'ro'  -- 'ro' refuses every write/actuator route
  //   confirmActions bool         -- writes/actuators wait for owner approval
  //   accepted       bool         -- the owner has admitted THIS helper
  // Defaults are the safe ones: read-only is not the default (a session is
  // usually meant to help), but confirm-actions IS on, and a helper is never
  // accepted until the owner clicks accept. onGate/onAccept are UI hooks.
  access: 'rw',
  confirmActions: true,
  accepted: false,
  onGate: null,        // (job, sgbd, arg) -> Promise<bool>  owner approves a write
  onAccept: null,      // (info) -> Promise<bool>            owner admits a helper
  peerInfo: null,      // {ip, ua, at} best-effort helper details for the prompt

  // signaling endpoint: the beta worker, /rtc/*. Reuses the same base the
  // report endpoint uses so there is one worker to run, not two.
  base() {
    // the SAME endpoint the beta kit posts to; its default is baked in at
    // deploy so a fresh visitor on the hosted site needs no setup. Settings
    // 'betaEndpoint' overrides per install.
    const dflt = (typeof BETA_ENDPOINT_DEFAULT === 'string')
      ? BETA_ENDPOINT_DEFAULT : '';
    const ep = (typeof Settings !== 'undefined')
      ? Settings.get('betaEndpoint', dflt) : dflt;
    // ".../report" -> ".../rtc"
    return ep ? ep.replace(/\/report$/, '') : '';
  },

  ICE() {
    // Google's public STUN (address reflection, free) + Cloudflare's free
    // TURN when configured (Settings 'turn' = {urls, username, credential}).
    const servers = [{ urls: 'stun:stun.l.google.com:19302' }];
    const turn = (typeof Settings !== 'undefined')
      ? Settings.get('turn', null) : null;
    if (turn && turn.urls) servers.push(turn);
    return { iceServers: servers };
  },

  newCode() {
    // 8 unambiguous chars: a one-shot capability to command a car, so no
    // 0/O/1/I/L, and short enough to read aloud.
    const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const a = crypto.getRandomValues(new Uint8Array(8));
    return Array.from(a, (b) => abc[b % abc.length]).join('');
  },

  async sig(action, body) {
    const base = this.base();
    if (!base) throw new Error('no signaling endpoint configured');
    const res = await fetch(`${base}/rtc/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: this.code, ...body }),
    });
    if (!res.ok) {
      throw new Error((await res.json().catch(() => ({}))).error
        || `signaling ${res.status}`);
    }
    return res.json();
  },

  log(text) {
    this.jobs += /job/.test(text) ? 1 : 0;
    if (this.onLog) this.onLog(text);
  },

  // ---- owner: run a forwarded request through the REAL shim ----------------

  async _ownerHandle(msg) {
    if (msg.t !== 'req') return;
    // EVERYTHING below runs on the OWNER, the only party at the car and the
    // only one that cannot be spoofed. The helper's request is DATA, never a
    // command we trust: validate the route, enforce the access level, and get
    // owner approval for writes -- all before window.fetch touches the wire.
    const reply = (status, body) => this._send({ t: 'res', id: msg.id, status, body });

    // (1) ROUTE ALLOWLIST on the owner side. The helper-side filter is on the
    // wrong side of the trust boundary; this is the one that counts. Only the
    // sanctioned car routes may run -- anything else is refused, never fetched.
    const rel = String(msg.path || '');
    if (!REMOTE_CAR_ROUTE.test(rel)) {
      this.log(`refused (not a car route): ${rel.slice(0, 80)}`);
      return reply(403, { error: 'remote: route not permitted' });
    }

    // classify what this request would do to the car
    const runM = /\/api\/ecu\/([^/]+)\/(run|clear|write|flash)\/([^/?]+)/.exec(rel);
    const sgbd = runM ? runM[1] : '';
    const verb = runM ? runM[2] : (/\/(port|state)\b/.test(rel) ? 'read' : '');
    const job = runM ? decodeURIComponent(runM[3]) : '';
    // clear/write/flash routes are writes by definition; a /run/ job is a write
    // when the classifier says so (same isWriteJob the local write-guard uses),
    // and STEUERN_/STELL_ actuator drives count as dangerous too. Routes with
    // NO job (/port, /state) are always reads -- never pass an empty name to
    // isWriteJob, whose default-deny would wrongly flag it as a write.
    const isRunFamily = !!runM;              // /run|clear|write|flash/<job>
    const isW = isRunFamily && typeof isWriteJob === 'function' && isWriteJob(job);
    const isActuator = isRunFamily && /^(STEUERN|STELL|START)/i.test(job);
    const dangerous = verb === 'clear' || verb === 'write' || verb === 'flash'
      || isW || isActuator;

    // (2) ACCESS LEVEL. A read-only share refuses every write/actuator, so the
    // car cannot be written no matter what the helper's browser sends.
    if (this.access === 'ro' && dangerous) {
      this.log(`blocked (read-only session): ${sgbd} ${job || verb}`);
      return reply(403, { error: 'remote: this session is read-only' });
    }

    // (3) PER-ACTION CONFIRM. When on (default), a write/actuator waits for the
    // owner to approve THIS job before it runs -- the confirm lives here, not
    // in the helper's UI which the attacker controls. Reads never prompt, so a
    // normal session stays frictionless.
    if (dangerous && this.confirmActions && typeof this.onGate === 'function') {
      this.log(`awaiting your approval: ${sgbd} ${job || verb}`);
      let ok = false;
      try { ok = await this.onGate({ sgbd, job: job || verb, arg: this._argOf(msg) }); }
      catch { ok = false; }
      if (!ok) {
        this.log(`you declined: ${sgbd} ${job || verb}`);
        return reply(403, { error: 'remote: the car owner declined this action' });
      }
    }

    // approved -- run it through the owner's REAL shim and return the JSON.
    this.log(`job ${sgbd || ''} ${job || verb} · running…`);
    let status = 200, body;
    try {
      const res = await window.fetch(rel, msg.init || undefined);
      status = res.status;
      body = await res.json().catch(() => ({}));
      if (runM || verb === 'read') {
        this.log(`job ${sgbd || ''} ${job || verb} · ${status === 200 ? 'ok' : status}`);
      }
    } catch (e) {
      status = 500; body = { error: e.message };
    }
    reply(status, body);
  },

  _argOf(msg) {
    // best-effort: show the owner the job's argument if the helper sent one
    try {
      const q = String(msg.path || '').split('?')[1] || '';
      const p = new URLSearchParams(q);
      return p.get('arg') || p.get('args') || (msg.init && msg.init.body) || '';
    } catch { return ''; }
  },

  // ---- helper: turn a car fetch into a peer request -----------------------

  // The channel is not open for a moment after join() (ICE is still running)
  // and again after a reconnect. A request in that window must WAIT, not go
  // to the local shim: on the helper's machine the local shim has no cable,
  // and "no cable" is exactly the wrong answer for "the owner is not here
  // yet". Rejects if the session ends or the peer never shows.
  _ready(ms = 20000) {
    if (this.chan && this.chan.readyState === 'open') return Promise.resolve();
    if (this.role !== 'helper') {
      return Promise.reject(new Error('not in a remote session'));
    }
    return new Promise((resolve, reject) => {
      const w = { resolve, reject, timer: null };
      w.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error('remote: the shared car did not connect'));
      }, ms);
      this.waiters.push(w);
    });
  },
  _wake(err) {
    const ws = this.waiters; this.waiters = [];
    for (const w of ws) { clearTimeout(w.timer); err ? w.reject(err) : w.resolve(); }
  },

  async request(path, init) {
    await this._ready();
    return new Promise((resolve, reject) => {
      const id = `${++this.seq}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('remote timeout: the owner did not answer'));
      }, 60000);
      this.pending.set(id, { resolve, reject, timer });
      // strip method/body to a structured-clonable shape
      const safeInit = init ? {
        method: init.method || 'GET',
        body: typeof init.body === 'string' ? init.body : undefined,
      } : undefined;
      this._send({ t: 'req', id, path, init: safeInit });
    });
  },

  _helperResponse(msg) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    // hand back a Response the shim/api() consumes exactly like a real one
    p.resolve(new Response(JSON.stringify(msg.body), {
      status: msg.status || 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  },

  _send(obj) {
    if (this.chan && this.chan.readyState === 'open') {
      this.chan.send(JSON.stringify(obj));
    }
  },

  _onMessage(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (this.role === 'owner') {
      // the helper's greeting: hold it for the owner to accept before ANY job
      // is honoured. Until accepted, every request is refused.
      if (msg.t === 'hello') { this._ownerAccept(msg); return; }
      if (!this.accepted) {
        if (msg.t === 'req') this._send({ t: 'res', id: msg.id, status: 403,
          body: { error: 'remote: the owner has not admitted this helper yet' } });
        return;
      }
      this._ownerHandle(msg);
    } else {
      if (msg.t === 'admit') this._helperAdmitted(msg);
      else if (msg.t === 'res') this._helperResponse(msg);
    }
  },

  // OWNER: a helper's channel opened and it said hello. Do NOT go live or run
  // anything until the owner clicks accept -- connecting the DataChannel is not
  // consent. Show who is asking (best-effort details) and wait.
  async _ownerAccept(hello) {
    this.peerInfo = {
      ua: String((hello && hello.ua) || '').slice(0, 200),
      at: Date.now(),
      ip: (hello && hello.ip) || this._peerIp || null,
    };
    let ok = false;
    if (typeof this.onAccept === 'function') {
      try { ok = await this.onAccept(this.peerInfo); } catch { ok = false; }
    } else { ok = true; }            // no UI hook (headless/tests): admit
    if (this.ending || this.role !== 'owner') return;
    if (!ok) {
      this.log('you declined the helper');
      this._send({ t: 'admit', ok: false });
      // drop this helper but keep the code alive for another try
      this._rehost().catch((e) => this.end(e.message));
      return;
    }
    this.accepted = true;
    // the share is now established: it no longer expires, and a reload should
    // resume it silently rather than starting a fresh 5-minute window.
    if (this._expiry) { clearTimeout(this._expiry); this._expiry = null; }
    try {
      const s = JSON.parse(localStorage.getItem(this.SHARE_KEY) || 'null');
      if (s) { s.everJoined = true; localStorage.setItem(this.SHARE_KEY, JSON.stringify(s)); }
    } catch {}
    this.log('you admitted the helper');
    if (this.onState) this.onState('live');
    this._send({ t: 'admit', ok: true, access: this.access });
  },

  // HELPER: the owner accepted (or refused). Only now is the session usable.
  _helperAdmitted(msg) {
    if (msg.ok) {
      this.access = msg.access || 'rw';
      // let the helper in: drop the full-screen wait, reveal the app + badge
      if (typeof document !== 'undefined') {
        document.getElementById('remote-overlay')?.remove();
        if (typeof showRemoteBar === 'function') showRemoteBar();
      }
      this._wake();
      if (this.onState) this.onState('live');
      this.log('the owner admitted you. Connected to the car');
    } else {
      this.end('the owner declined the connection');
    }
  },

  // ---- connection lifecycle ------------------------------------------------

  _wire(chan) {
    this.chan = chan;
    chan.onopen = () => {
      if (this.role === 'owner') {
        // wait for the helper's hello, then for the owner to accept. Not live
        // yet, and _wake stays parked so no queued helper request runs.
        this.accepted = false;
        this.log('someone is connecting. Waiting to admit them…');
        if (this.onState) this.onState('connecting');
      } else {
        // HELPER: greet the owner; the session is not usable until admitted.
        this.log('connected. Waiting for the owner to admit you…');
        this._send({ t: 'hello', ua: (typeof navigator !== 'undefined'
          && navigator.userAgent) || '' });
        // do NOT _wake here; _helperAdmitted does once the owner accepts.
      }
    };
    chan.onclose = () => {
      if (this.ending) return;
      // The helper closing its tab, or losing the network, must not end the
      // OWNER's share: the code they were given should keep working. Put a
      // fresh offer under the same code and wait again.
      if (this.role === 'owner') this._rehost().catch((e) => this.end(e.message));
      else this.end('the owner disconnected');
    };
    chan.onmessage = (ev) => this._onMessage(ev);
  },

  // A closed data channel is not always reported (a peer that vanishes mid-
  // ICE, a laptop lid): the connection state is. 'disconnected' gets a grace
  // period since it flaps on WiFi; 'failed'/'closed' are final.
  _watch(pc) {
    let grace = null;
    // The channel's onclose is the one place that decides "re-host or end";
    // route every loss through it. A helper whose ICE never completed has no
    // channel at all, and used to sit with the red border forever.
    const lost = (why) => {
      if (this.ending || pc !== this.pc) return;
      if (this.chan && this.chan.onclose) this.chan.onclose();
      else if (this.role === 'owner') this._rehost().catch((e) => this.end(e.message));
      else this.end(why);
    };
    pc.onconnectionstatechange = () => {
      if (pc !== this.pc) return;                     // an old connection
      const st = pc.connectionState;
      if (st === 'connected' && grace) { clearTimeout(grace); grace = null; }
      if (st === 'disconnected' && !grace) {
        grace = setTimeout(() => {
          if (pc === this.pc && pc.connectionState !== 'connected') {
            lost('the connection dropped');
          }
        }, 8000);
      }
      if (st === 'failed' || st === 'closed') lost('could not reach the owner');
    };
  },

  // Drop every piece of a previous session so a new host()/join() starts
  // clean. Silent: no hooks, no log. end() is the loud version.
  _teardown() {
    // a new/reconnecting helper must be admitted afresh -- consent never
    // carries across peers or across a re-host under the same code.
    this.accepted = false;
    this.peerInfo = null;
    if (this.poll) { clearInterval(this.poll); this.poll = null; }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('remote session ended'));
    }
    this.pending.clear();
    this._wake(new Error('remote session ended'));
    const chan = this.chan, pc = this.pc;
    this.chan = this.pc = null;
    if (chan) { chan.onclose = null; try { chan.close(); } catch {} }
    if (pc) { pc.onconnectionstatechange = null; try { pc.close(); } catch {} }
  },

  // OWNER: the helper went away; offer again under the SAME code so the code
  // they already have still connects. The worker treats a new offer as a new
  // round (it clears the old answer), so the helper's next join is accepted.
  async _rehost() {
    const code = this.code;
    this._teardown();
    this.role = 'owner'; this.code = code;
    this.log('helper disconnected. The same code reconnects');
    if (this.onState) this.onState('connecting');
    await this._offer();
  },

  async _offer() {
    this.pc = new RTCPeerConnection(this.ICE());
    this._watch(this.pc);
    this._wire(this.pc.createDataChannel('diag', { ordered: true }));
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this._gathered(this.pc);
    // localDescription now carries every candidate: one write, nothing to race
    await this.sig('offer', { offer: this.pc.localDescription });
    // poll for the helper's answer (candidates ride inside it too)
    let answered = false;
    const pc = this.pc;
    this.poll = setInterval(async () => {
      if (pc !== this.pc) return;
      const r = await this.sig('poll', { want: 'answer' }).catch(() => null);
      if (r && r.answer && !answered) {
        answered = true;
        await this.pc.setRemoteDescription(r.answer);
        this.log('helper joined. Negotiating');
        // older clients still trickle; keep draining for them
        await this._drainIce('helperIce');
      }
    }, 1500);
  },

  // Trickle ICE through KV does not work across edge locations: the mailbox
  // is eventually consistent (a write can take up to a minute to show at
  // another PoP) and the candidate list was a read-modify-write on one key,
  // so concurrent posts overwrote each other and the read-once poll raced
  // the writes. Same-LAN peers hit one PoP and never saw it; a phone on
  // data or a parent across town did, every first attempt. So: gather
  // first, then post ONE description with every candidate inside it.
  _gathered(pc, ms = 3000) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); resolve(); };
      const t = setTimeout(done, ms);       // a slow TURN lookup must not stall
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') done();
      };
    });
  },

  async _drainIce(fromKey) {
    const r = await this.sig('poll', { want: fromKey }).catch(() => null);
    if (r && r.ice) {
      for (const c of r.ice) {
        try { await this.pc.addIceCandidate(c); } catch { /* stale */ }
      }
    }
    return r;
  },

  // OWNER: create the session, wait for the helper's answer + ICE.
  // opts.access ('rw'|'ro') and opts.confirmActions (bool) are the owner's
  // policy for THIS session, enforced in _ownerHandle. Defaults: full access,
  // confirm on -- the safe pair.
  async host(opts = {}) {
    return this._share(this.newCode(),
      { access: opts.access === 'ro' ? 'ro' : 'rw',
        confirmActions: opts.confirmActions !== false,
        startedAt: Date.now() });
  },

  // Re-host an EXISTING share (page reload / auto-reconnect) under the SAME
  // code and the SAME policy, so the code the owner already gave out keeps
  // working. The worker re-offer clears the stale answer/ICE for us.
  async resume(saved) {
    if (!saved || !saved.code) throw new Error('no session to resume');
    return this._share(saved.code, {
      access: saved.access === 'ro' ? 'ro' : 'rw',
      confirmActions: saved.confirmActions !== false,
      startedAt: saved.startedAt || Date.now(),
    });
  },

  // The share worker for host()/resume(): set the owner policy, remember it so
  // a reload can restore it, arm the "no helper in 5 min" expiry, then offer.
  async _share(code, policy) {
    if (!this.base()) throw new Error('no signaling endpoint — set one in Settings');
    this._teardown();                        // whatever came before
    if (this.role === 'helper') uninstallRemoteHelperShim();
    this.role = 'owner';
    this.access = policy.access;
    this.confirmActions = policy.confirmActions;
    this.startedAt = policy.startedAt;
    this.accepted = false;
    this.code = code;
    this._persist();                         // survive a reload
    this._armExpiry();                       // end if nobody joins in 5 min
    if (this.onState) this.onState('connecting');
    await this._offer();
    return this.code;
  },

  // ---- share persistence + auto-reconnect ---------------------------------
  // Only the OWNER's SHARE persists (code + policy + when it started) -- never
  // a live connection (an RTCPeerConnection dies with the page). On the next
  // load we re-host under the same code. Ends 5 min after startedAt if no
  // helper was ever admitted.
  SHARE_KEY: 'bmweb.remote.share',
  EXPIRE_MS: 5 * 60 * 1000,

  _persist() {
    try {
      localStorage.setItem(this.SHARE_KEY, JSON.stringify({
        code: this.code, access: this.access,
        confirmActions: this.confirmActions, startedAt: this.startedAt,
      }));
    } catch {}
  },
  _clearPersist() {
    try { localStorage.removeItem(this.SHARE_KEY); } catch {}
  },
  savedShare() {
    try {
      const s = JSON.parse(localStorage.getItem(this.SHARE_KEY) || 'null');
      if (!s || !s.code) return null;
      // an expired share (>5 min, never joined) is not resumable
      if (!s.everJoined && Date.now() - (s.startedAt || 0) > this.EXPIRE_MS) {
        this._clearPersist(); return null;
      }
      return s;
    } catch { return null; }
  },
  _armExpiry() {
    if (this._expiry) clearTimeout(this._expiry);
    // once a helper is admitted the share is "established" and does not expire;
    // until then, end it EXPIRE_MS after it first started.
    const left = this.EXPIRE_MS - (Date.now() - (this.startedAt || Date.now()));
    this._expiry = setTimeout(() => {
      if (this.role === 'owner' && !this.accepted) {
        this.end('no one connected within 5 minutes');
      }
    }, Math.max(1000, left));
  },

  // HELPER: join by code, answer the owner's offer.
  async join(code) {
    if (!this.base()) throw new Error('no signaling endpoint. Set one in Settings');
    this._teardown();                        // a second connect starts clean
    this.role = 'helper';
    this.code = String(code || '').trim().toUpperCase();
    try {
      this.pc = new RTCPeerConnection(this.ICE());
      this._watch(this.pc);
      this.pc.ondatachannel = (e) => this._wire(e.channel);
      const r = await this.sig('poll', { want: 'offer' });
      if (!r || !r.offer) throw new Error('no such session, or it expired');
      await this.pc.setRemoteDescription(r.offer);
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      await this._gathered(this.pc);
      await this.sig('answer', { answer: this.pc.localDescription }).catch((e) => {
        throw new Error(/taken/.test(e.message)
          ? 'that session already has a helper. Ask the owner to end it and share again'
          : e.message);
      });
    } catch (e) {
      // never leave a half-joined helper behind: role set, no channel, and
      // every car fetch quietly answered by the local (cable-less) shim
      this._teardown();
      this.role = this.code = null;
      throw e;
    }
    if (this.onState) this.onState('connecting');
    installRemoteHelperShim();               // route car fetches to the peer
    // the REMOTE badge waits until the owner admits (showHelperWaiting covers
    // the screen until then); _helperAdmitted brings it up.
    this.poll = setInterval(() => this._drainIce('ownerIce'), 1500);
    return true;
  },

  end(why) {
    if (this.ending) return;
    this.ending = true;
    if (this._expiry) { clearTimeout(this._expiry); this._expiry = null; }
    this._clearPersist();                    // an ended share never auto-resumes
    this._teardown();
    const wasHelper = this.role === 'helper';
    this.role = this.code = null;
    this.startedAt = null;
    this.ending = false;
    if (wasHelper) uninstallRemoteHelperShim();
    if (this.onState) this.onState('closed');
    if (typeof document !== 'undefined') {
      document.body.classList.remove('remote-helper');
      // drop any full-screen wait/admit/approve overlay still up
      document.getElementById('remote-overlay')?.remove();
    }
    if (why && this.onLog) this.onLog(`session ended: ${why}`);
  },
};

// ---- the helper's fetch interception ---------------------------------------
//
// Sits IN FRONT of the webshim fetch. Car routes (job runs, the cable status,
// the coding write/clear routes) go to the owner over the data channel; every
// static route (screens, IR, tables, fault data) is answered locally by the
// shim exactly as always. So the helper's app is fully itself, and only the
// car reaches across.
// /api/state is the topbar's battery/ignition poll -- the owner's car's
// KL30/KL15, so it crosses too, or the helper sees dashes for a live car.
const REMOTE_CAR_ROUTE =
  /\/api\/(ecu\/[^/]+\/(run|clear|write|flash)\/|port\b|state\b)/;

let _remoteBaseFetch = null;
function installRemoteHelperShim() {
  if (_remoteBaseFetch) return;
  _remoteBaseFetch = window.fetch;
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const rel = url.replace(/^https?:\/\/[^/]+/, '');
    // role alone decides: while we are a helper, a car route goes to the
    // owner or fails, it never falls through to this machine's own shim
    // (which has no cable and would say so, misleadingly)
    if (Remote.role === 'helper' && REMOTE_CAR_ROUTE.test(rel)) {
      return Remote.request(rel, init);
    }
    return _remoteBaseFetch(input, init);
  };
  if (typeof document !== 'undefined') {
    document.body.classList.add('remote-helper');
  }
}
function uninstallRemoteHelperShim() {
  if (!_remoteBaseFetch) return;
  window.fetch = _remoteBaseFetch;
  _remoteBaseFetch = null;
}

if (typeof window !== 'undefined') {
  window.Remote = Remote;
  window.installRemoteHelperShim = installRemoteHelperShim;
  window.uninstallRemoteHelperShim = uninstallRemoteHelperShim;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Remote, REMOTE_CAR_ROUTE };
}

// ---- UI ---------------------------------------------------------------------

function showRemoteDialog() {
  if (typeof openModal !== 'function') return;
  const configured = !!Remote.base();
  const { overlay, close } = openModal(`
    <div class="modal" role="dialog" aria-modal="true" style="max-width:540px">
      <div class="modal-title">Remote session</div>
      <div class="modal-body" id="remote-body">
        ${configured ? `
        <p style="margin:0 0 14px;color:var(--ink-dim);font-size:13px">
          Share your car with someone, or connect to a shared car. The car
          stays on this machine. Only jobs cross the connection, and it
          is direct browser-to-browser once linked.</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap" id="rm-choose">
          <button class="btn primary" id="rm-host">Share my car</button>
          <button class="btn" id="rm-join">Connect to a car</button>
        </div>

        <div id="rm-share-opts" style="display:none;margin-top:6px">
          <div style="font-weight:600;margin-bottom:4px">Share my car</div>
          <p style="margin:0 0 12px;color:var(--ink-dim);font-size:13px">
            What should the helper be able to do? These are enforced on this
            machine, the one at the car, not the helper's.</p>

          <div style="font-size:12px;color:var(--ink-dim);margin-bottom:5px">
            Access</div>
          <label class="rm-opt">
            <input type="radio" name="rm-access" value="rw" checked>
            <span><strong>Read + write.</strong> Read faults and live
              values, clear codes, run activations, code modules.</span></label>
          <label class="rm-opt">
            <input type="radio" name="rm-access" value="ro">
            <span><strong>Read only.</strong> Read faults and live
              values only. Writes and activations are refused.</span></label>

          <label class="rm-opt" style="margin-top:10px">
            <input type="checkbox" id="rm-confirm" checked>
            <span><strong>Confirm the helper's actions.</strong> You
              approve each write or activation before it reaches the car.
              Reads never prompt. <span style="color:var(--ink-dim)">Recommended.</span></span></label>

          <div style="display:flex;gap:10px;margin-top:14px">
            <button class="btn primary" id="rm-share-go">Get a code</button>
            <button class="btn" id="rm-share-back">Back</button>
          </div>
        </div>

        <div id="rm-join-row" style="display:none;margin-top:14px">
          <input id="rm-code" placeholder="SESSION CODE" maxlength="12"
            style="text-transform:uppercase;letter-spacing:.15em;
                   font-family:var(--mono);width:100%;padding:9px;
                   background:transparent;color:inherit;
                   border:1px solid var(--line)">
          <button class="btn primary" id="rm-join-go"
            style="margin-top:8px">Connect</button>
        </div>` : `
        <p style="color:var(--ink-dim);font-size:13px">Remote sessions need a
          signaling endpoint. Set <code>betaEndpoint</code> in Settings (the
          same worker the beta reports use), then reopen this.</p>`}
      </div>
      <div class="modal-actions">
        <button class="btn modal-cancel">Close<span class="modal-key">Esc</span></button>
      </div>
    </div>`);
  overlay.querySelector('.modal-cancel').onclick = () => close();
  if (!configured) return;

  const choose = overlay.querySelector('#rm-choose');
  const shareOpts = overlay.querySelector('#rm-share-opts');
  const joinRow = overlay.querySelector('#rm-join-row');

  overlay.querySelector('#rm-join').onclick = () => {
    shareOpts.style.display = 'none';
    joinRow.style.display = 'block';
    overlay.querySelector('#rm-code').focus();
  };
  // Share is now a two-step flow: pick the access level + confirm setting,
  // THEN get a code. The owner decides the session's ceiling up front.
  overlay.querySelector('#rm-host').onclick = () => {
    joinRow.style.display = 'none';
    choose.style.display = 'none';
    shareOpts.style.display = 'block';
  };
  overlay.querySelector('#rm-share-back').onclick = () => {
    shareOpts.style.display = 'none';
    choose.style.display = 'flex';
  };
  overlay.querySelector('#rm-share-go').onclick = async () => {
    const access = overlay.querySelector('input[name="rm-access"]:checked')?.value === 'ro'
      ? 'ro' : 'rw';
    const confirmActions = overlay.querySelector('#rm-confirm')?.checked !== false;
    try {
      const code = await Remote.host({ access, confirmActions });
      close();
      showOwnerConsole(code, { access, confirmActions });
    } catch (e) {
      overlay.querySelector('#remote-body').innerHTML =
        `<div class="modal-body">Could not start: ${esc(e.message)}</div>`;
    }
  };
  const go = async () => {
    const code = overlay.querySelector('#rm-code').value.trim();
    if (!code) return;
    const btn = overlay.querySelector('#rm-join-go');
    btn.disabled = true; btn.textContent = 'Connecting…';
    try {
      await Remote.join(code);
      close();
      // The channel is up but we are NOT in yet: show a blocking full-screen
      // wait until the owner admits. showRemoteBar/app come after admit.
      showHelperWaiting();
      if (typeof sbLeft !== 'undefined') {
        sbLeft.textContent = 'waiting for the owner to let you in…';
      }
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Connect';
      overlay.querySelector('#rm-code').style.borderColor = '#d66';
      if (typeof sbLeft !== 'undefined') sbLeft.textContent = e.message;
    }
  };
  overlay.querySelector('#rm-join-go').onclick = go;
  overlay.querySelector('#rm-code').addEventListener('keydown',
    (e) => { if (e.key === 'Enter') go(); });
}

// ---- full-screen remote overlays -------------------------------------------
// A single centred, blocking overlay used for the moments that need the user's
// whole attention on BOTH sides: the helper waiting to be admitted, and the
// owner admitting a helper or approving a write. Returns { close }.
function remoteOverlay({ kind, title, body, actions }) {
  document.getElementById('remote-overlay')?.remove();
  const el = document.createElement('div');
  el.id = 'remote-overlay';
  el.className = 'remote-overlay' + (kind ? ' ro-' + kind : '');
  el.innerHTML = `
    <div class="ro-card">
      ${kind === 'wait' ? '<div class="ro-spinner" aria-hidden="true"></div>' : ''}
      <div class="ro-title">${esc(title)}</div>
      <div class="ro-body">${body || ''}</div>
      <div class="ro-actions">${
        (actions || []).map((a, i) => `<button class="btn ${a.cls || ''}"
          data-i="${i}">${esc(a.label)}</button>`).join('')}</div>
    </div>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  (actions || []).forEach((a, i) => {
    const b = el.querySelector(`[data-i="${i}"]`);
    if (b) b.onclick = () => { if (a.keepOpen) a.fn(); else { close(); a.fn && a.fn(); } };
  });
  return { el, close };
}

// HELPER: the full-screen "waiting to be admitted" screen, shown from the
// moment the channel connects until the owner admits (or declines / cancel).
function showHelperWaiting() {
  const { close } = remoteOverlay({
    kind: 'wait',
    title: 'Waiting for the owner to let you in',
    body: `<p>You're connected to the shared car. The owner has to admit you
      before you can run anything.</p>`,
    actions: [{ label: 'Cancel', cls: 'danger',
      fn: () => Remote.end('you cancelled the request') }],
  });
  return close;
}

// OWNER: a persistent console -- the code to share, a live log of what the
// helper runs on the car, and a big end button. This is the owner's window
// onto their own car while someone else drives it.
function showOwnerConsole(code, opts = {}) {
  document.getElementById('owner-console')?.remove();
  const el = document.createElement('div');
  el.id = 'owner-console';
  el.className = 'owner-console';
  el.innerHTML = `
    <div class="oc-head">
      <div>
        <div class="oc-title">Sharing your car</div>
        <div class="oc-sub">Give this code to the person connecting.</div>
      </div>
      <div class="oc-btns">
        <button class="btn" id="oc-min" title="Collapse to a pill">&#8211;</button>
        <button class="btn danger" id="oc-end">End session</button>
      </div>
    </div>
    <div class="oc-code" id="oc-code">${esc(code)}</div>
    <div class="oc-state" id="oc-state">waiting for someone to connect…</div>
    <div class="oc-log mono" id="oc-log"></div>
    <div class="oc-pill" id="oc-pill" title="Expand">
      <span class="rb-dot"></span><span class="mono">${esc(code)}</span>
      <span class="oc-pill-state" id="oc-pill-state">waiting</span>
    </div>`;
  document.body.appendChild(el);

  // ADMIT a connecting helper -- a full-screen prompt so the owner can't miss
  // it. Nothing runs until they decide. Shows the best-effort details of who is
  // asking. The promise the accept flow awaits resolves on the click.
  Remote.onAccept = (info) => new Promise((resolve) => {
    const when = new Date(info.at || Date.now()).toLocaleTimeString();
    const ua = (info.ua || '').replace(/\s+/g, ' ').slice(0, 120) || 'unknown device';
    const ip = info.ip ? ` &middot; ${esc(info.ip)}` : '';
    remoteOverlay({
      kind: 'admit',
      title: 'Someone wants to connect to your car',
      body: `<div class="ro-detail mono">${esc(ua)}<br>connected ${esc(when)}${ip}</div>
        <p>They can read and (if you allow it) command your car. Only admit
        someone you are expecting.</p>`,
      actions: [
        { label: 'Admit', cls: 'primary', fn: () => resolve(true) },
        { label: 'Reject', cls: 'danger', fn: () => resolve(false) },
      ],
    });
  });

  // APPROVE a single write/actuator -- also full-screen. Only fires when the
  // session allows writes and confirm is on; reads never reach here.
  Remote.onGate = (j) => new Promise((resolve) => {
    remoteOverlay({
      kind: 'approve',
      title: 'Helper wants to run an action on your car',
      body: `<div class="ro-detail mono">${esc(j.sgbd || '')} &middot; ${esc(j.job || '')}${
        j.arg ? ` (${esc(String(j.arg).slice(0, 60))})` : ''}</div>
        <p>This writes to or activates hardware on the car. Allow it only if you
        expect it.</p>`,
      actions: [
        { label: 'Allow', cls: 'primary', fn: () => resolve(true) },
        { label: 'Deny', cls: 'danger', fn: () => resolve(false) },
      ],
    });
  });
  // the console sits over the bottom-right of the screen -- exactly where a
  // module's F-keys and readouts live. Collapse it to a pill and back.
  const setMin = (min) => { el.classList.toggle('oc-min', min);
    try { localStorage.setItem('bmweb.oc.min', min ? '1' : '0'); } catch {} };
  el.querySelector('#oc-min').onclick = () => setMin(true);
  el.querySelector('#oc-pill').onclick = () => setMin(false);
  try { if (localStorage.getItem('bmweb.oc.min') === '1') setMin(true); } catch {}
  const logEl = el.querySelector('#oc-log');
  Remote.onLog = (text) => {
    const d = document.createElement('div');
    d.textContent = text;
    logEl.appendChild(d);
    logEl.scrollTop = logEl.scrollHeight;
  };
  Remote.onState = (s) => {
    const st = el.querySelector('#oc-state');
    if (!st) return;
    st.textContent = s === 'live' ? '● live: helper is connected'
      : s === 'connecting' ? 'waiting for the helper. The code above connects'
      : 'session ended';
    st.className = 'oc-state' + (s === 'live' ? ' oc-live' : '');
    const ps = el.querySelector('#oc-pill-state');
    if (ps) {
      ps.textContent = s === 'live' ? 'live' : s === 'connecting' ? 'waiting' : 'ended';
      ps.className = 'oc-pill-state' + (s === 'live' ? ' oc-live' : '');
    }
    if (s === 'closed') setTimeout(() => el.remove(), 1500);
  };
  el.querySelector('#oc-code').onclick = () => {
    navigator.clipboard?.writeText(code).catch(() => {});
    el.querySelector('#oc-code').classList.add('oc-copied');
  };
  el.querySelector('#oc-end').onclick = () => { Remote.end('you ended it'); };
}

// HELPER: the red border + badge, so it is never ambiguous that these jobs
// touch someone else's car.
function showRemoteBar() {
  document.body.classList.add('remote-helper');
  if (document.getElementById('remote-badge')) return;
  const b = document.createElement('div');
  b.id = 'remote-badge';
  b.className = 'remote-badge';
  b.innerHTML = `<span class="rb-dot"></span>REMOTE
    <button class="rb-end" id="rb-end">disconnect</button>`;
  document.body.appendChild(b);
  b.querySelector('#rb-end').onclick = () => { Remote.end('you disconnected'); };
  Remote.onState = (s) => {
    if (s === 'live' && typeof sbLeft !== 'undefined') {
      sbLeft.textContent = 'connected: driving the shared car';
    }
    if (s === 'closed') {
      document.getElementById('remote-badge')?.remove();
      document.body.classList.remove('remote-helper');
      if (typeof sbLeft !== 'undefined') sbLeft.textContent = 'remote session ended';
    }
  };
}

// Auto-resume a share across a page reload. If the last load left an active
// share (owner, not yet expired), re-host it under the SAME code and bring the
// console back, so a refresh does not drop a session the owner set up and does
// not force them to re-share a new code. Called once at boot.
async function resumeRemoteShare() {
  const saved = Remote.savedShare && Remote.savedShare();
  if (!saved || !Remote.base()) return false;
  try {
    const code = await Remote.resume(saved);
    if (typeof showOwnerConsole === 'function') {
      showOwnerConsole(code, { access: saved.access,
        confirmActions: saved.confirmActions });
      if (Remote.onLog) Remote.onLog('reconnected — the same code still works');
    }
    return true;
  } catch (e) {
    // a dead endpoint or a rejected re-offer: drop the stored share quietly
    Remote._clearPersist && Remote._clearPersist();
    return false;
  }
}

if (typeof window !== 'undefined') {
  window.showRemoteDialog = showRemoteDialog;
  window.resumeRemoteShare = resumeRemoteShare;
}
