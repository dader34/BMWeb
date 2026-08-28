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
    // the helper asked us to fetch a car route; run it locally (real shim)
    // and return the JSON. window.fetch here is the shim's own fetch.
    if (msg.t !== 'req') return;
    let status = 200, body;
    try {
      const res = await window.fetch(msg.path, msg.init || undefined);
      status = res.status;
      body = await res.json().catch(() => ({}));
      const run = /\/api\/ecu\/([^/]+)\/run\/([^/?]+)/.exec(msg.path);
      if (run) {
        this.log(`job ${run[1]} ${decodeURIComponent(run[2])} `
          + `· ${(body.system && '') || ''}${status === 200 ? 'ok' : status}`);
      }
    } catch (e) {
      status = 500; body = { error: e.message };
    }
    this._send({ t: 'res', id: msg.id, status, body });
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
        reject(new Error('remote timeout — the owner did not answer'));
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
    if (this.role === 'owner') this._ownerHandle(msg);
    else if (msg.t === 'res') this._helperResponse(msg);
  },

  // ---- connection lifecycle ------------------------------------------------

  _wire(chan) {
    this.chan = chan;
    chan.onopen = () => {
      this._wake();
      if (this.onState) this.onState('live');
      this.log(this.role === 'owner'
        ? 'helper connected' : 'connected to the car');
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
    pc.onconnectionstatechange = () => {
      if (pc !== this.pc) return;                     // an old connection
      const st = pc.connectionState;
      if (st === 'connected' && grace) { clearTimeout(grace); grace = null; }
      if (st === 'disconnected' && !grace) {
        grace = setTimeout(() => {
          if (pc === this.pc && pc.connectionState !== 'connected') {
            if (this.chan && this.chan.onclose) this.chan.onclose();
          }
        }, 8000);
      }
      if (st === 'failed' || st === 'closed') {
        if (this.chan && this.chan.onclose) this.chan.onclose();
      }
    };
  },

  // Drop every piece of a previous session so a new host()/join() starts
  // clean. Silent: no hooks, no log. end() is the loud version.
  _teardown() {
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
    this.log('helper disconnected — the same code reconnects');
    if (this.onState) this.onState('connecting');
    await this._offer();
  },

  async _offer() {
    this.pc = new RTCPeerConnection(this.ICE());
    this._watch(this.pc);
    this._wire(this.pc.createDataChannel('diag', { ordered: true }));
    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.sig('ice', { from: 'owner', candidate: e.candidate })
        .catch(() => {});
    };
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this.sig('offer', { offer });
    // poll for the helper's answer, then its ICE
    let answered = false;
    const pc = this.pc;
    this.poll = setInterval(async () => {
      if (pc !== this.pc) return;
      const r = await this.sig('poll', { want: 'answer' }).catch(() => null);
      if (r && r.answer && !answered) {
        answered = true;
        await this.pc.setRemoteDescription(r.answer);
        this.log('helper joined — negotiating');
      }
      if (answered) await this._drainIce('helperIce');
    }, 1500);
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
  async host() {
    if (!this.base()) throw new Error('no signaling endpoint — set one in Settings');
    this._teardown();                        // whatever came before
    if (this.role === 'helper') uninstallRemoteHelperShim();
    this.role = 'owner';
    this.code = this.newCode();
    if (this.onState) this.onState('connecting');
    await this._offer();
    return this.code;
  },

  // HELPER: join by code, answer the owner's offer.
  async join(code) {
    if (!this.base()) throw new Error('no signaling endpoint — set one in Settings');
    this._teardown();                        // a second connect starts clean
    this.role = 'helper';
    this.code = String(code || '').trim().toUpperCase();
    try {
      this.pc = new RTCPeerConnection(this.ICE());
      this._watch(this.pc);
      this.pc.ondatachannel = (e) => this._wire(e.channel);
      this.pc.onicecandidate = (e) => {
        if (e.candidate) this.sig('ice', { from: 'helper', candidate: e.candidate })
          .catch(() => {});
      };
      const r = await this.sig('poll', { want: 'offer' });
      if (!r || !r.offer) throw new Error('no such session, or it expired');
      await this.pc.setRemoteDescription(r.offer);
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      await this.sig('answer', { answer }).catch((e) => {
        throw new Error(/taken/.test(e.message)
          ? 'that session already has a helper — ask the owner to end it and share again'
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
    if (typeof showRemoteBar === 'function') showRemoteBar();
    this.poll = setInterval(() => this._drainIce('ownerIce'), 1500);
    return true;
  },

  end(why) {
    if (this.ending) return;
    this.ending = true;
    this._teardown();
    const wasHelper = this.role === 'helper';
    this.role = this.code = null;
    this.ending = false;
    if (wasHelper) uninstallRemoteHelperShim();
    if (this.onState) this.onState('closed');
    if (typeof document !== 'undefined') {
      document.body.classList.remove('remote-helper');
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
const REMOTE_CAR_ROUTE =
  /\/api\/(ecu\/[^/]+\/(run|clear|write|flash)\/|port\b)/;

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
          stays on this machine &mdash; only jobs cross the connection, and it
          is direct browser&#8209;to&#8209;browser once linked.</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn primary" id="rm-host">Share my car</button>
          <button class="btn" id="rm-join">Connect to a car</button>
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

  overlay.querySelector('#rm-join').onclick = () => {
    overlay.querySelector('#rm-join-row').style.display = 'block';
    overlay.querySelector('#rm-code').focus();
  };
  overlay.querySelector('#rm-host').onclick = async () => {
    try {
      const code = await Remote.host();
      close();
      showOwnerConsole(code);
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
      showRemoteBar();
      if (typeof sbLeft !== 'undefined') {
        sbLeft.textContent = 'connecting to the shared car…';
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

// OWNER: a persistent console -- the code to share, a live log of what the
// helper runs on the car, and a big end button. This is the owner's window
// onto their own car while someone else drives it.
function showOwnerConsole(code) {
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
      <button class="btn danger" id="oc-end">End session</button>
    </div>
    <div class="oc-code" id="oc-code">${esc(code)}</div>
    <div class="oc-state" id="oc-state">waiting for someone to connect…</div>
    <div class="oc-log mono" id="oc-log"></div>`;
  document.body.appendChild(el);
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
    st.textContent = s === 'live' ? '● live — helper is connected'
      : s === 'connecting' ? 'waiting for the helper — the code above connects'
      : 'session ended';
    st.className = 'oc-state' + (s === 'live' ? ' oc-live' : '');
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
      sbLeft.textContent = 'connected — driving the shared car';
    }
    if (s === 'closed') {
      document.getElementById('remote-badge')?.remove();
      document.body.classList.remove('remote-helper');
      if (typeof sbLeft !== 'undefined') sbLeft.textContent = 'remote session ended';
    }
  };
}

if (typeof window !== 'undefined') {
  window.showRemoteDialog = showRemoteDialog;
}
