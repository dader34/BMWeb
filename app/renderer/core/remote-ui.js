// Remote diagnostics -- the UI and the helper-side fetch shim. Split out of
// remote.js, which keeps the core Remote engine (signaling, WebRTC, session
// state and the owner-side security gate). This file is everything the user
// sees and the transparent fetch redirection on the helper's side:
//   - installRemoteHelperShim / uninstallRemoteHelperShim: route the helper's
//     car-touching fetches to the owner over the data channel
//   - showRemoteDialog: start/join a session
//   - remoteOverlay / showHelperWaiting / showOwnerConsole / showRemoteBar:
//     the full-screen session overlays and the persistent REMOTE badge
//   - resumeRemoteShare: re-arm a share that survived a reload
// It talks to the engine only through the global `Remote` (defined in
// remote.js, loaded first), and the engine calls back into these by name at
// session time -- both resolve through the shared global scope.

// ---- the helper's fetch interception ---------------------------------------
//
// Sits IN FRONT of the webshim fetch. Car routes (REMOTE_CAR_ROUTE, defined in
// remote.js since the owner-side gate uses it too) go to the owner over the
// data channel; every static route (screens, IR, tables, fault data) is
// answered locally by the shim exactly as always. So the helper's app is fully
// itself, and only the car reaches across.

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
  // Remote itself is exported by remote.js (the engine); this file exports the
  // shim + UI it owns.
  window.installRemoteHelperShim = installRemoteHelperShim;
  window.uninstallRemoteHelperShim = uninstallRemoteHelperShim;
}

// ---- UI ---------------------------------------------------------------------

function showRemoteDialog() {
  if (typeof openModal !== 'function') return;
  const configured = !!Remote.base();
  const { overlay, close } = openModal(`
    <div class="modal" role="dialog" aria-modal="true" style="max-width:540px">
      <div class="modal-title">Remote session</div>
      <div class="modal-body" id="remote-body">
        ${
          configured
            ? `
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
        </div>`
            : `
        <p style="color:var(--ink-dim);font-size:13px">Remote sessions need a
          signaling endpoint. Set <code>betaEndpoint</code> in Settings (the
          same worker the beta reports use), then reopen this.</p>`
        }
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
    const access =
      overlay.querySelector('input[name="rm-access"]:checked')?.value === 'ro'
        ? 'ro'
        : 'rw';
    const confirmActions =
      overlay.querySelector('#rm-confirm')?.checked !== false;
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
    btn.disabled = true;
    btn.textContent = 'Connecting…';
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
      btn.disabled = false;
      btn.textContent = 'Connect';
      overlay.querySelector('#rm-code').style.borderColor = '#d66';
      if (typeof sbLeft !== 'undefined') sbLeft.textContent = e.message;
    }
  };
  overlay.querySelector('#rm-join-go').onclick = go;
  overlay.querySelector('#rm-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go();
  });
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
      <div class="ro-actions">${(actions || [])
        .map(
          (a, i) => `<button class="btn ${a.cls || ''}"
          data-i="${i}">${esc(a.label)}</button>`
        )
        .join('')}</div>
    </div>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  (actions || []).forEach((a, i) => {
    const b = el.querySelector(`[data-i="${i}"]`);
    if (b)
      b.onclick = () => {
        if (a.keepOpen) a.fn();
        else {
          close();
          a.fn && a.fn();
        }
      };
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
    actions: [
      {
        label: 'Cancel',
        cls: 'danger',
        fn: () => Remote.end('you cancelled the request'),
      },
    ],
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
  Remote.onAccept = (info) =>
    new Promise((resolve) => {
      const when = new Date(info.at || Date.now()).toLocaleTimeString();
      const ua =
        (info.ua || '').replace(/\s+/g, ' ').slice(0, 120) || 'unknown device';
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
  Remote.onGate = (j) =>
    new Promise((resolve) => {
      remoteOverlay({
        kind: 'approve',
        title: 'Helper wants to run an action on your car',
        body: `<div class="ro-detail mono">${esc(j.sgbd || '')} &middot; ${esc(j.job || '')}${
          j.arg ? ` (${esc(String(j.arg).slice(0, 60))})` : ''
        }</div>
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
  const setMin = (min) => {
    el.classList.toggle('oc-min', min);
    try {
      localStorage.setItem('bmweb.oc.min', min ? '1' : '0');
    } catch {}
  };
  el.querySelector('#oc-min').onclick = () => setMin(true);
  el.querySelector('#oc-pill').onclick = () => setMin(false);
  try {
    if (localStorage.getItem('bmweb.oc.min') === '1') setMin(true);
  } catch {}
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
    st.textContent =
      s === 'live'
        ? '● live: helper is connected'
        : s === 'connecting'
          ? 'waiting for the helper. The code above connects'
          : 'session ended';
    st.className = 'oc-state' + (s === 'live' ? ' oc-live' : '');
    const ps = el.querySelector('#oc-pill-state');
    if (ps) {
      ps.textContent =
        s === 'live' ? 'live' : s === 'connecting' ? 'waiting' : 'ended';
      ps.className = 'oc-pill-state' + (s === 'live' ? ' oc-live' : '');
    }
    if (s === 'closed') setTimeout(() => el.remove(), 1500);
  };
  el.querySelector('#oc-code').onclick = () => {
    navigator.clipboard?.writeText(code).catch(() => {});
    el.querySelector('#oc-code').classList.add('oc-copied');
  };
  el.querySelector('#oc-end').onclick = () => {
    Remote.end('you ended it');
  };
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
  b.querySelector('#rb-end').onclick = () => {
    Remote.end('you disconnected');
  };
  Remote.onState = (s) => {
    if (s === 'live' && typeof sbLeft !== 'undefined') {
      sbLeft.textContent = 'connected: driving the shared car';
    }
    if (s === 'closed') {
      document.getElementById('remote-badge')?.remove();
      document.body.classList.remove('remote-helper');
      if (typeof sbLeft !== 'undefined')
        sbLeft.textContent = 'remote session ended';
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
      showOwnerConsole(code, {
        access: saved.access,
        confirmActions: saved.confirmActions,
      });
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
