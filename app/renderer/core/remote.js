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

// The car-touching routes that cross the wire: job runs and the coding
// write/clear/flash routes, the cable-port probe, and /api/state (the topbar's
// battery/ignition poll -- the owner's car's KL30/KL15, so it crosses too, or
// the helper sees dashes for a live car). Everything else is answered locally.
// Used by BOTH the owner-side gate (_ownerHandle, below) and the helper's fetch
// shim (remote-ui.js), so it lives here in the engine.
/**
 * The car-touching routes that cross the wire: job runs and the coding
 * write/clear/flash routes, the cable-port probe, and /api/state.
 * @type {RegExp}
 */
const REMOTE_CAR_ROUTE =
  /\/api\/(ecu\/[^/]+\/(run|clear|write|flash)\/|port\b|state\b)/;
/**
 * Jobs a script sends on its own to hold a session -- never a car command, so
 * they never prompt the owner.
 * @type {RegExp}
 */
const REMOTE_PLUMBING =
  /^(INITIALISIERUNG|IDENT|IDENT_\w+|INFO|DIAGNOSE_(AUFRECHT|ENDE|MODE)|ENDE)$/i;
/** How long an owner's approval of a user action stays valid, in ms. */
const REMOTE_APPROVAL_MS = 15 * 60 * 1000;

// THE APP VERSION BOTH ENDS MUST SHARE. The helper drives the owner's car
// through the owner's shim, so both sides must speak the same routes, job
// classifier and runtime; a helper on an older build could ask for things
// the owner's build no longer means. The native shell injects
// window.bmacw.version, a web build ships version.js (BMACW_VERSION), a dev
// checkout has neither and reports 'dev'.
/**
 * The app version both ends of a session must share.
 * @returns {string} The native shell / web build version, or 'dev'.
 */
function remoteVersion() {
  if (typeof window === 'undefined') return 'dev';
  if (window.bmacw && window.bmacw.version) return String(window.bmacw.version);
  if (window.BMACW_VERSION) return String(window.BMACW_VERSION);
  return 'dev';
}

/**
 * The user action a helper's runtime tags a job with, so the owner approves
 * the action once rather than each job it sends. Helper-supplied DATA: it can
 * only widen consent the owner already gave, never grant it.
 * @typedef {Object} RemoteAction
 * @property {string} id - Stable id for the action (<=64 chars).
 * @property {string} label - Human label shown to the owner (<=80 chars).
 * @property {string[]} jobs - The jobs this key can send (<=30, each <=40 chars).
 */

/**
 * A message on the data channel between the two peers. The protocol is
 * byte-compatible across builds; these are the exact shapes on the wire.
 * @typedef {Object} RemoteMessage
 * @property {'hello'|'admit'|'req'|'res'} t - Message type.
 * @property {string} [id] - Request/response id (req, res).
 * @property {string} [path] - The forwarded route (req).
 * @property {{method?: string, body?: string, action?: RemoteAction}} [init] - fetch init (req).
 * @property {number} [status] - HTTP status (res).
 * @property {any} [body] - Response JSON (res).
 * @property {number} [took] - ms the job spent on the owner's cable (res).
 * @property {boolean} [ok] - Whether the helper was admitted (admit).
 * @property {'version'} [reason] - Why admission failed (admit).
 * @property {string} [ua] - Helper user agent (hello).
 * @property {string} [v] - Helper app version (hello).
 * @property {'rw'|'ro'} [access] - The access the owner granted (admit).
 */

/**
 * The remote-diagnostics engine: signaling, WebRTC, session state and the
 * owner-side security gate. A single object (not a class) because it is one
 * long-lived session actor; the UI in remote-ui.js drives it through hooks.
 */
const Remote = {
  role: null, // 'owner' | 'helper' | null
  code: null,
  pc: null, // RTCPeerConnection
  chan: null, // RTCDataChannel
  poll: null, // signaling poll timer
  pending: new Map(), // helper: reqId -> {resolve, reject, timer}
  seq: 0,
  onLog: null, // owner console hook
  onState: null, // UI hook: 'connecting'|'live'|'closed'
  jobs: 0,
  ending: false, // set while end() runs, so onclose does not re-host
  waiters: [], // helper: resolvers parked until the channel opens

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
  onGate: null, // (job, sgbd, arg) -> Promise<bool>  owner approves a write
  onAwait: null, // helper: (waiting: bool, path) -- a request awaits the owner
  awaiting: 0, // helper: how many such requests are outstanding
  onAccept: null, // (info) -> Promise<bool>            owner admits a helper
  peerInfo: null, // {ip, ua, at} best-effort helper details for the prompt
  approved: new Map(), // action id -> {label, at}: actions the owner allowed

  // signaling endpoint: the beta worker, /rtc/*. Reuses the same base the
  // report endpoint uses so there is one worker to run, not two.
  /**
   * The signaling base (`.../rtc`), derived from the beta report endpoint.
   * @returns {string} The base URL, or '' when none is configured.
   */
  base() {
    // the SAME endpoint the beta kit posts to; its default is baked in at
    // deploy so a fresh visitor on the hosted site needs no setup. Settings
    // 'betaEndpoint' overrides per install.
    const dflt =
      typeof BETA_ENDPOINT_DEFAULT === 'string' ? BETA_ENDPOINT_DEFAULT : '';
    const ep =
      typeof Settings !== 'undefined'
        ? Settings.get('betaEndpoint', dflt)
        : dflt;
    // ".../report" -> ".../rtc"
    return ep ? ep.replace(/\/report$/, '') : '';
  },

  /**
   * The ICE configuration: Google's public STUN, plus a configured TURN.
   * @returns {{iceServers: object[]}}
   */
  ICE() {
    // Google's public STUN (address reflection, free) + Cloudflare's free
    // TURN when configured (Settings 'turn' = {urls, username, credential}).
    const servers = [{ urls: 'stun:stun.l.google.com:19302' }];
    const turn =
      typeof Settings !== 'undefined' ? Settings.get('turn', null) : null;
    if (turn && turn.urls) servers.push(turn);
    return { iceServers: servers };
  },

  /**
   * A fresh session code: 8 unambiguous characters (no 0/O/1/I/L).
   * @returns {string}
   */
  newCode() {
    // 8 unambiguous chars: a one-shot capability to command a car, so no
    // 0/O/1/I/L, and short enough to read aloud.
    const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const a = crypto.getRandomValues(new Uint8Array(8));
    return Array.from(a, (b) => abc[b % abc.length]).join('');
  },

  /**
   * POST to a signaling route, tagged with the session code.
   * @param {string} action - The route under `/rtc/` (offer, answer, poll).
   * @param {object} body - The JSON payload.
   * @returns {Promise<any>} The parsed response.
   * @throws {Error} When no endpoint is configured or the request fails.
   */
  async sig(action, body) {
    const base = this.base();
    if (!base) throw new Error('no signaling endpoint configured');
    const res = await fetch(`${base}/rtc/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: this.code, ...body }),
    });
    if (!res.ok) {
      throw new Error(
        (await res.json().catch(() => ({}))).error || `signaling ${res.status}`
      );
    }
    return res.json();
  },

  /**
   * Record a session log line: the owner sees the helper's cadence; the helper
   * echoes to the console and the status bar.
   * @param {string} text - The line (a leading gap is prefixed for slow ones).
   * @returns {void}
   */
  log(text) {
    this.jobs += /job/.test(text) ? 1 : 0;
    // the gap since the previous line: on the owner it shows the helper's
    // cadence (how long the cable sat idle between its requests)
    const now = Date.now();
    const gap = this._lastLogAt ? now - this._lastLogAt : 0;
    this._lastLogAt = now;
    if (gap >= 700 && /running/.test(text)) text = `+${gap} ms · ${text}`;
    if (this.onLog) this.onLog(text);
    // the helper has no console panel: its lines go to the browser console
    // (and a timing line to the status bar) so a slow session can be read
    if (this.role === 'helper') {
      if (typeof console !== 'undefined') console.log('[remote] ' + text);
      if (/^(slow|helper idle)/.test(text) && typeof sbLeft !== 'undefined')
        sbLeft.textContent = text;
    }
  },

  // ---- owner: run a forwarded request through the REAL shim ----------------

  /**
   * OWNER: run a helper's forwarded request through the real shim, after the
   * route allowlist, the access level and (for a write/actuator) the owner's
   * per-action approval. The single security boundary; the helper is untrusted.
   * @param {RemoteMessage} msg - The helper's `req` message.
   * @returns {Promise<void>}
   */
  async _ownerHandle(msg) {
    if (msg.t !== 'req') return;
    // EVERYTHING below runs on the OWNER, the only party at the car and the
    // only one that cannot be spoofed. The helper's request is DATA, never a
    // command we trust: validate the route, enforce the access level, and get
    // owner approval for writes -- all before window.fetch touches the wire.
    const reply = (status, body, took) =>
      this._send({ t: 'res', id: msg.id, status, body, took });

    // (1) ROUTE ALLOWLIST on the owner side. The helper-side filter is on the
    // wrong side of the trust boundary; this is the one that counts. Only the
    // sanctioned car routes may run -- anything else is refused, never fetched.
    const rel = String(msg.path || '');
    if (!REMOTE_CAR_ROUTE.test(rel)) {
      this.log(`refused (not a car route): ${rel.slice(0, 80)}`);
      return reply(403, { error: 'remote: route not permitted' });
    }

    // classify what this request would do to the car
    const runM = /\/api\/ecu\/([^/]+)\/(run|clear|write|flash)\/([^/?]+)/.exec(
      rel
    );
    const sgbd = runM ? runM[1] : '';
    const verb = runM ? runM[2] : /\/(port|state)\b/.test(rel) ? 'read' : '';
    const job = runM ? decodeURIComponent(runM[3]) : '';
    // clear/write/flash routes are writes by definition; a /run/ job is a write
    // when the classifier says so (same isWriteJob the local write-guard uses),
    // and STEUERN_/STELL_ actuator drives count as dangerous too. Routes with
    // NO job (/port, /state) are always reads -- never pass an empty name to
    // isWriteJob, whose default-deny would wrongly flag it as a write.
    const isRunFamily = !!runM; // /run|clear|write|flash/<job>
    const isW =
      isRunFamily && typeof isWriteJob === 'function' && isWriteJob(job);
    const isActuator = isRunFamily && /^(STEUERN|STELL|START)/i.test(job);
    const dangerous =
      verb === 'clear' ||
      verb === 'write' ||
      verb === 'flash' ||
      isW ||
      isActuator;

    // (2) ACCESS LEVEL. A read-only share refuses every write/actuator, so the
    // car cannot be written no matter what the helper's browser sends.
    if (this.access === 'ro' && dangerous) {
      this.log(`blocked (read-only session): ${sgbd} ${job || verb}`);
      return reply(403, { error: 'remote: this session is read-only' });
    }

    // (3) PER-ACTION CONFIRM. When on (default), a write/actuator waits for the
    // owner's approval before it runs -- the confirm lives here, not in the
    // helper's UI which the attacker controls. Reads never prompt, so a
    // normal session stays frictionless.
    //
    // The unit of consent is the USER ACTION, not the job: one INPA key
    // press is several jobs (stop, start with the new setpoint, the screen's
    // keep-alive every tick), and asking for each made a session
    // unusable. The helper's runtime tags every job with the action it
    // serves; the owner approves that action once and its later jobs pass
    // until the session ends or the approval ages out. Session plumbing a
    // script sends on its own (INITIALISIERUNG, IDENT, DIAGNOSE_AUFRECHT...)
    // is not a car command and never prompts. The tag is helper-supplied
    // DATA: it can only widen consent the owner already gave to that action,
    // never grant it, and a read-only session still refuses every write.
    const act = this._actionOf(msg);
    const plumbing = isRunFamily && REMOTE_PLUMBING.test(job);
    if (
      dangerous &&
      !plumbing &&
      this.confirmActions &&
      typeof this.onGate === 'function'
    ) {
      const under = act && this._approvedAction(act.id);
      if (under) {
        this.log(`under your approval "${under.label}": ${sgbd} ${job}`);
      } else {
        this.log(`awaiting your approval: ${sgbd} ${job || verb}`);
        let ok = false;
        try {
          ok = await this.onGate({
            sgbd,
            job: job || verb,
            arg: this._argOf(msg),
            action: act,
          });
        } catch {
          ok = false;
        }
        if (!ok) {
          this.log(`you declined: ${sgbd} ${job || verb}`);
          return reply(403, {
            error: 'remote: the car owner declined this action',
          });
        }
        if (act) this._approveAction(act);
      }
    }

    // approved -- run it through the owner's REAL shim and return the JSON.
    // Timed, so a slow session can be read: the owner's line is the time on
    // this machine's cable; the helper's line is the whole round trip.
    this.log(`job ${sgbd || ''} ${job || verb} · running…`);
    const t0 = Date.now();
    let status = 200,
      body;
    try {
      const res = await window.fetch(rel, msg.init || undefined);
      status = res.status;
      body = await res.json().catch(() => ({}));
      if (runM || verb === 'read') {
        this.log(
          `job ${sgbd || ''} ${job || verb} · ${status === 200 ? 'ok' : status} · ${Date.now() - t0} ms on the cable`
        );
      }
    } catch (e) {
      status = 500;
      body = { error: e.message };
    }
    reply(status, body, Date.now() - t0);
  },

  /**
   * The validated action tag the helper's runtime put on a request.
   * @param {RemoteMessage} msg - The request.
   * @returns {RemoteAction|null}
   */
  _actionOf(msg) {
    const a = msg && msg.init && msg.init.action;
    if (!a || typeof a !== 'object') return null;
    const id = String(a.id || '').slice(0, 64);
    if (!id) return null;
    return {
      id,
      label: String(a.label || '').slice(0, 80),
      jobs: Array.isArray(a.jobs)
        ? a.jobs.slice(0, 30).map((j) => String(j).slice(0, 40))
        : [],
    };
  },

  /**
   * A still-fresh approval the owner gave for an action, or null (expired ones
   * are dropped).
   * @param {string} id - The action id.
   * @returns {{label: string, at: number}|null}
   */
  _approvedAction(id) {
    const a = this.approved.get(id);
    if (!a) return null;
    if (Date.now() - a.at > REMOTE_APPROVAL_MS) {
      this.approved.delete(id);
      return null;
    }
    return a;
  },
  /**
   * Record the owner's approval of an action.
   * @param {RemoteAction} act - The approved action.
   * @returns {void}
   */
  _approveAction(act) {
    this.approved.set(act.id, { label: act.label, at: Date.now() });
  },

  /**
   * Best-effort argument of a request, to show the owner what a write would do.
   * @param {RemoteMessage} msg - The request.
   * @returns {string}
   */
  _argOf(msg) {
    // best-effort: show the owner the job's argument if the helper sent one
    try {
      const q = String(msg.path || '').split('?')[1] || '';
      const p = new URLSearchParams(q);
      return p.get('arg') || p.get('args') || (msg.init && msg.init.body) || '';
    } catch {
      return '';
    }
  },

  // ---- helper: turn a car fetch into a peer request -----------------------

  // The channel is not open for a moment after join() (ICE is still running)
  // and again after a reconnect. A request in that window must WAIT, not go
  // to the local shim: on the helper's machine the local shim has no cable,
  // and "no cable" is exactly the wrong answer for "the owner is not here
  // yet". Rejects if the session ends or the peer never shows.
  /**
   * HELPER: resolve once the channel is open, parking the caller while ICE or a
   * reconnect is still in flight (a car request must wait for the owner, not
   * fall through to the cable-less local shim).
   * @param {number} [ms=20000] - How long to wait before rejecting.
   * @returns {Promise<void>}
   */
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
  /**
   * Resolve or reject every parked `_ready` waiter.
   * @param {Error} [err] - Reject with this; resolve when absent.
   * @returns {void}
   */
  _wake(err) {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) {
      clearTimeout(w.timer);
      err ? w.reject(err) : w.resolve();
    }
  },

  // A request the owner may have to approve: the same shape the owner's gate
  // classifies (a clear/write/flash route, or a run job the write classifier
  // or the actuator prefix flags). Used only to tell the helper it is waiting
  // on a person, not on the car.
  /**
   * Whether a route would need the owner's approval (a clear/write/flash, or a
   * run job the write classifier or actuator prefix flags). Used only to tell
   * the helper it is waiting on a person.
   * @param {string} path - The route.
   * @returns {boolean}
   */
  _needsApproval(path) {
    const m = /\/api\/ecu\/([^/]+)\/(run|clear|write|flash)\/([^/?]+)/.exec(
      String(path || '')
    );
    if (!m) return false;
    if (m[2] !== 'run') return true;
    const job = decodeURIComponent(m[3]);
    if (/^(STEUERN|STELL|START)/i.test(job)) return true;
    return typeof isWriteJob === 'function' && isWriteJob(job);
  },

  /**
   * HELPER: turn a car fetch into a peer request and resolve with a Response
   * the shim consumes exactly like a real one.
   * @param {string} path - The car route.
   * @param {RequestInit & {action?: RemoteAction}} [init] - fetch init, plus the tagged action.
   * @returns {Promise<Response>}
   * @throws {Error} On timeout or a dropped session.
   */
  async request(path, init) {
    await this._ready();
    // where a slow session spends its time when the owner's cable is quick:
    // the gap between the last answer and this request is the helper's own
    // think time -- a background tab's throttled timers show up here
    if (this._lastRes) {
      const idle = Date.now() - this._lastRes;
      if (idle > 800) {
        const m = /\/run\/([^/?]+)/.exec(String(path || ''));
        const hidden =
          typeof document !== 'undefined' && document.hidden ? 'yes' : 'no';
        this.log(
          `helper idle ${idle} ms before ${m ? decodeURIComponent(m[1]) : path} (tab hidden: ${hidden})`
        );
      }
    }
    // tell the helper why this one may take a moment: a person is asked
    const gated = this._needsApproval(path) && this.access !== 'ro';
    if (gated) {
      this.awaiting = (this.awaiting || 0) + 1;
      if (this.onAwait) this.onAwait(true, path);
    }
    const settle = () => {
      if (!gated) return;
      this.awaiting = Math.max(0, (this.awaiting || 0) - 1);
      if (this.onAwait) this.onAwait(this.awaiting > 0, path);
    };
    return new Promise((resolve, reject) => {
      const id = `${++this.seq}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('remote timeout: the owner did not answer'));
      }, 60000);
      this.pending.set(id, {
        resolve: (v) => {
          settle();
          resolve(v);
        },
        reject: (e) => {
          settle();
          reject(e);
        },
        timer,
        at: Date.now(),
        path,
      });
      // strip method/body to a structured-clonable shape
      // ...plus the user action the runtime tagged the job with (id, label,
      // the jobs the key can send), so the owner approves the action once
      const act =
        init && init.action && typeof init.action === 'object'
          ? {
              id: String(init.action.id || '').slice(0, 64),
              label: String(init.action.label || '').slice(0, 80),
              jobs: Array.isArray(init.action.jobs)
                ? init.action.jobs
                    .slice(0, 30)
                    .map((j) => String(j).slice(0, 40))
                : [],
            }
          : undefined;
      const safeInit = init
        ? {
            method: init.method || 'GET',
            body: typeof init.body === 'string' ? init.body : undefined,
            action: act && act.id ? act : undefined,
          }
        : undefined;
      this._send({ t: 'req', id, path, init: safeInit });
    });
  },

  /**
   * HELPER: settle the pending request a `res` message answers, logging a slow
   * round trip and handing back a Response.
   * @param {RemoteMessage} msg - The owner's `res` message.
   * @returns {void}
   */
  _helperResponse(msg) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    // where a slow answer spent its time: on the owner's cable, or between
    const total = Date.now() - (p.at || Date.now());
    this._lastRes = Date.now();
    if (total > 1500) {
      const m = /\/run\/([^/?]+)/.exec(String(p.path || ''));
      this.log(
        `slow: ${m ? decodeURIComponent(m[1]) : p.path} took ${total} ms` +
          (msg.took != null
            ? ` (${msg.took} ms of it on the owner's cable)`
            : '')
      );
    }
    // hand back a Response the shim/api() consumes exactly like a real one
    p.resolve(
      new Response(JSON.stringify(msg.body), {
        status: msg.status || 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  },

  /**
   * Send a message over the data channel when it is open.
   * @param {RemoteMessage} obj - The message.
   * @returns {void}
   */
  _send(obj) {
    if (this.chan && this.chan.readyState === 'open') {
      this.chan.send(JSON.stringify(obj));
    }
  },

  /**
   * Route an inbound channel message by role: owner admits then handles;
   * helper takes admit/res.
   * @param {MessageEvent} ev - The channel message event.
   * @returns {void}
   */
  _onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (this.role === 'owner') {
      // the helper's greeting: hold it for the owner to accept before ANY job
      // is honoured. Until accepted, every request is refused.
      if (msg.t === 'hello') {
        this._ownerAccept(msg);
        return;
      }
      if (!this.accepted) {
        if (msg.t === 'req')
          this._send({
            t: 'res',
            id: msg.id,
            status: 403,
            body: {
              error: 'remote: the owner has not admitted this helper yet',
            },
          });
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
  /**
   * OWNER: a helper's channel opened and greeted; refuse a version mismatch,
   * else ask the owner to admit. Nothing runs until they accept.
   * @param {RemoteMessage} hello - The helper's `hello` message.
   * @returns {Promise<void>}
   */
  async _ownerAccept(hello) {
    // VERSIONS MUST MATCH before the owner is even asked: a mismatched
    // helper is refused outright, told both versions, and the code stays
    // live for a helper on the right build.
    const mine = remoteVersion();
    const theirs = String((hello && hello.v) || '').slice(0, 40) || 'unknown';
    if (theirs !== mine) {
      this.log(`refused: helper runs ${theirs}, you run ${mine}`);
      this._send({
        t: 'admit',
        ok: false,
        reason: 'version',
        owner: mine,
        helper: theirs,
      });
      this._rehost().catch((e) => this.end(e.message));
      return;
    }
    this.peerInfo = {
      ua: String((hello && hello.ua) || '').slice(0, 200),
      at: Date.now(),
      ip: (hello && hello.ip) || this._peerIp || null,
    };
    let ok = false;
    if (typeof this.onAccept === 'function') {
      try {
        ok = await this.onAccept(this.peerInfo);
      } catch {
        ok = false;
      }
    } else {
      ok = true;
    } // no UI hook (headless/tests): admit
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
    if (this._expiry) {
      clearTimeout(this._expiry);
      this._expiry = null;
    }
    try {
      const s = JSON.parse(localStorage.getItem(this.SHARE_KEY) || 'null');
      if (s) {
        s.everJoined = true;
        localStorage.setItem(this.SHARE_KEY, JSON.stringify(s));
      }
    } catch {}
    this.log('you admitted the helper');
    // one driver on the cable: close the owner's own live module so the
    // helper's jobs are not queued behind its screen cycles
    if (typeof ipoPauseForRemote === 'function') {
      ipoPauseForRemote();
      this.log('your own module screens are paused while the helper drives');
    }
    if (this.onState) this.onState('live');
    this._send({ t: 'admit', ok: true, access: this.access });
  },

  // HELPER: the owner accepted (or refused). Only now is the session usable.
  /**
   * HELPER: the owner accepted or refused; reveal the app or end the session.
   * @param {RemoteMessage} msg - The owner's `admit` message.
   * @returns {void}
   */
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
    } else if (msg.reason === 'version') {
      this.end(
        `versions differ: you run ${msg.helper || remoteVersion()}, the owner runs ${msg.owner || '?'}. ` +
          'Both must be on the same BMWeb version to share a car'
      );
    } else {
      this.end('the owner declined the connection');
    }
  },

  // ---- connection lifecycle ------------------------------------------------

  /**
   * Wire a data channel's open/close/message handlers for the current role.
   * @param {RTCDataChannel} chan - The channel.
   * @returns {void}
   */
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
        this._send({
          t: 'hello',
          ua: (typeof navigator !== 'undefined' && navigator.userAgent) || '',
          v: remoteVersion(),
        });
        // do NOT _wake here; _helperAdmitted does once the owner accepts.
      }
    };
    chan.onclose = () => {
      if (this.ending) return;
      // The helper closing its tab, or losing the network, must not end the
      // OWNER's share: the code they were given should keep working. Put a
      // fresh offer under the same code and wait again.
      if (this.role === 'owner')
        this._rehost().catch((e) => this.end(e.message));
      else this.end('the owner disconnected');
    };
    chan.onmessage = (ev) => this._onMessage(ev);
  },

  // A closed data channel is not always reported (a peer that vanishes mid-
  // ICE, a laptop lid): the connection state is. 'disconnected' gets a grace
  // period since it flaps on WiFi; 'failed'/'closed' are final.
  /**
   * Watch a peer connection's state for a loss the channel's onclose never
   * reported, routing every loss through that one decision point.
   * @param {RTCPeerConnection} pc - The connection.
   * @returns {void}
   */
  _watch(pc) {
    let grace = null;
    // The channel's onclose is the one place that decides "re-host or end";
    // route every loss through it. A helper whose ICE never completed has no
    // channel at all, and used to sit with the red border forever.
    const lost = (why) => {
      if (this.ending || pc !== this.pc) return;
      if (this.chan && this.chan.onclose) this.chan.onclose();
      else if (this.role === 'owner')
        this._rehost().catch((e) => this.end(e.message));
      else this.end(why);
    };
    pc.onconnectionstatechange = () => {
      if (pc !== this.pc) return; // an old connection
      const st = pc.connectionState;
      if (st === 'connected' && grace) {
        clearTimeout(grace);
        grace = null;
      }
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
  /**
   * Drop every piece of the current session so a new host()/join() starts
   * clean. Silent; end() is the loud version.
   * @returns {void}
   */
  _teardown() {
    // a new/reconnecting helper must be admitted afresh -- consent never
    // carries across peers or across a re-host under the same code.
    this.accepted = false;
    this.peerInfo = null;
    this.approved.clear(); // consent to an action ends with the session
    if (this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('remote session ended'));
    }
    this.pending.clear();
    this._wake(new Error('remote session ended'));
    const chan = this.chan,
      pc = this.pc;
    this.chan = this.pc = null;
    if (chan) {
      chan.onclose = null;
      try {
        chan.close();
      } catch {}
    }
    if (pc) {
      pc.onconnectionstatechange = null;
      try {
        pc.close();
      } catch {}
    }
  },

  // OWNER: the helper went away; offer again under the SAME code so the code
  // they already have still connects. The worker treats a new offer as a new
  // round (it clears the old answer), so the helper's next join is accepted.
  /**
   * OWNER: the helper went away; offer again under the SAME code so the code
   * already given out still connects.
   * @returns {Promise<void>}
   */
  async _rehost() {
    const code = this.code;
    this._teardown();
    this.role = 'owner';
    this.code = code;
    this.log('helper disconnected. The same code reconnects');
    if (this.onState) this.onState('connecting');
    await this._offer();
  },

  /**
   * OWNER: create the peer connection, gather ICE, post the offer, and poll for
   * the helper's answer.
   * @returns {Promise<void>}
   */
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
  /**
   * Resolve once ICE gathering completes, so the description carries every
   * candidate (a slow TURN lookup must not stall past `ms`).
   * @param {RTCPeerConnection} pc - The connection.
   * @param {number} [ms=3000] - Cap on the wait.
   * @returns {Promise<void>}
   */
  _gathered(pc, ms = 3000) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(done, ms); // a slow TURN lookup must not stall
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') done();
      };
    });
  },

  /**
   * Apply any trickled ICE candidates an older client posted under `fromKey`.
   * @param {string} fromKey - The signaling key to poll (helperIce, ownerIce).
   * @returns {Promise<any>} The poll response, or null.
   */
  async _drainIce(fromKey) {
    const r = await this.sig('poll', { want: fromKey }).catch(() => null);
    if (r && r.ice) {
      for (const c of r.ice) {
        try {
          await this.pc.addIceCandidate(c);
        } catch {
          /* stale */
        }
      }
    }
    return r;
  },

  // OWNER: create the session, wait for the helper's answer + ICE.
  // opts.access ('rw'|'ro') and opts.confirmActions (bool) are the owner's
  // policy for THIS session, enforced in _ownerHandle. Defaults: full access,
  // confirm on -- the safe pair.
  /**
   * OWNER: start a new session under a fresh code with a chosen policy.
   * @param {Object} [opts]
   * @param {'rw'|'ro'} [opts.access='rw'] - Access ceiling for the helper.
   * @param {boolean} [opts.confirmActions=true] - Ask before each write/actuator.
   * @returns {Promise<string>} The session code.
   */
  async host(opts = {}) {
    return this._share(this.newCode(), {
      access: opts.access === 'ro' ? 'ro' : 'rw',
      confirmActions: opts.confirmActions !== false,
      startedAt: Date.now(),
    });
  },

  // Re-host an EXISTING share (page reload / auto-reconnect) under the SAME
  // code and the SAME policy, so the code the owner already gave out keeps
  // working. The worker re-offer clears the stale answer/ICE for us.
  /**
   * OWNER: re-host a saved share (a reload) under the same code and policy.
   * @param {{code: string, access?: string, confirmActions?: boolean, startedAt?: number}} saved - A saved share.
   * @returns {Promise<string>} The session code.
   * @throws {Error} When there is no session to resume.
   */
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
  /**
   * The shared worker for host()/resume(): set the owner policy, remember it so
   * a reload can restore it, arm the "no helper in 5 min" expiry, then offer.
   * @param {string} code - The session code.
   * @param {{access: 'rw'|'ro', confirmActions: boolean, startedAt: number}} policy - The owner policy.
   * @returns {Promise<string>} The session code.
   * @throws {Error} When no signaling endpoint is configured.
   */
  async _share(code, policy) {
    if (!this.base())
      throw new Error('no signaling endpoint — set one in Settings');
    this._teardown(); // whatever came before
    if (
      this.role === 'helper' &&
      typeof uninstallRemoteHelperShim === 'function'
    )
      uninstallRemoteHelperShim();
    this.role = 'owner';
    this.access = policy.access;
    this.confirmActions = policy.confirmActions;
    this.startedAt = policy.startedAt;
    this.accepted = false;
    this.code = code;
    this._persist(); // survive a reload
    this._armExpiry(); // end if nobody joins in 5 min
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

  /**
   * Persist the owner's share (code + policy + start time) so a reload can
   * re-host it.
   * @returns {void}
   */
  _persist() {
    try {
      localStorage.setItem(
        this.SHARE_KEY,
        JSON.stringify({
          code: this.code,
          access: this.access,
          confirmActions: this.confirmActions,
          startedAt: this.startedAt,
        })
      );
    } catch {}
  },
  /**
   * Forget the persisted share.
   * @returns {void}
   */
  _clearPersist() {
    try {
      localStorage.removeItem(this.SHARE_KEY);
    } catch {}
  },
  /**
   * The resumable saved share, or null (an unjoined share older than the expiry
   * is not resumable and is cleared).
   * @returns {{code: string, access?: string, confirmActions?: boolean, startedAt?: number, everJoined?: boolean}|null}
   */
  savedShare() {
    try {
      const s = JSON.parse(localStorage.getItem(this.SHARE_KEY) || 'null');
      if (!s || !s.code) return null;
      // an expired share (>5 min, never joined) is not resumable
      if (!s.everJoined && Date.now() - (s.startedAt || 0) > this.EXPIRE_MS) {
        this._clearPersist();
        return null;
      }
      return s;
    } catch {
      return null;
    }
  },
  /**
   * Arm the "no helper in 5 min" timer (an admitted helper cancels it).
   * @returns {void}
   */
  _armExpiry() {
    if (this._expiry) clearTimeout(this._expiry);
    // once a helper is admitted the share is "established" and does not expire;
    // until then, end it EXPIRE_MS after it first started.
    const left = this.EXPIRE_MS - (Date.now() - (this.startedAt || Date.now()));
    this._expiry = setTimeout(
      () => {
        if (this.role === 'owner' && !this.accepted) {
          this.end('no one connected within 5 minutes');
        }
      },
      Math.max(1000, left)
    );
  },

  // HELPER: join by code, answer the owner's offer.
  /**
   * HELPER: join by code, answer the owner's offer, and install the car-fetch
   * shim; a full-screen wait covers the app until the owner admits.
   * @param {string} code - The session code.
   * @returns {Promise<boolean>} true once the answer is posted.
   * @throws {Error} On a missing/expired session or a taken slot.
   */
  async join(code) {
    if (!this.base())
      throw new Error('no signaling endpoint. Set one in Settings');
    this._teardown(); // a second connect starts clean
    this.role = 'helper';
    this.code = String(code || '')
      .trim()
      .toUpperCase();
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
      await this.sig('answer', { answer: this.pc.localDescription }).catch(
        (e) => {
          throw new Error(
            /taken/.test(e.message)
              ? 'that session already has a helper. Ask the owner to end it and share again'
              : e.message
          );
        }
      );
    } catch (e) {
      // never leave a half-joined helper behind: role set, no channel, and
      // every car fetch quietly answered by the local (cable-less) shim
      this._teardown();
      this.role = this.code = null;
      throw e;
    }
    if (this.onState) this.onState('connecting');
    if (typeof installRemoteHelperShim === 'function')
      installRemoteHelperShim(); // route car fetches to the peer
    // the REMOTE badge waits until the owner admits (showHelperWaiting covers
    // the screen until then); _helperAdmitted brings it up.
    this.poll = setInterval(() => this._drainIce('ownerIce'), 1500);
    return true;
  },

  /**
   * End the session loudly: clear the persisted share, tear down, drop the
   * helper shim/overlays, and notify via the state hook.
   * @param {string} [why] - Reason, logged for the user.
   * @returns {void}
   */
  end(why) {
    if (this.ending) return;
    this.ending = true;
    if (this._expiry) {
      clearTimeout(this._expiry);
      this._expiry = null;
    }
    this._clearPersist(); // an ended share never auto-resumes
    this._teardown();
    const wasHelper = this.role === 'helper';
    this.role = this.code = null;
    this.startedAt = null;
    this.ending = false;
    if (wasHelper && typeof uninstallRemoteHelperShim === 'function')
      uninstallRemoteHelperShim();
    if (this.onState) this.onState('closed');
    if (typeof document !== 'undefined') {
      document.body.classList.remove('remote-helper');
      // drop any full-screen wait/admit/approve overlay still up
      document.getElementById('remote-overlay')?.remove();
    }
    if (why && this.onLog) this.onLog(`session ended: ${why}`);
  },
};

if (typeof window !== 'undefined') {
  window.Remote = Remote;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Remote, REMOTE_CAR_ROUTE };
}
