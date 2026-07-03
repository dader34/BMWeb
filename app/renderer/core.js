// core: API client, theme, util, dialogs, error formatting
// renderer. chassis -> section -> ECU -> fault flow against the local .NET
// sidecar (EDIABAS engine).

const API = new URLSearchParams(location.search).get('api') || 'http://127.0.0.1:8777';

// persisted settings
const Settings = {
  data: JSON.parse(localStorage.getItem('bmacw.settings') || '{}'),
  get(key, def) { return key in this.data ? this.data[key] : def; },
  set(key, val) { this.data[key] = val; localStorage.setItem('bmacw.settings', JSON.stringify(this.data)); },
};
// skins / themes
const THEMES = [
  { id: 'instrument', name: 'Instrument' },
  { id: 'inpa',       name: 'INPA' },
  { id: 'aero',       name: 'Frutiger' },
  { id: 'metal',      name: 'Brushed Metal' },
];
function applyTheme(id) {
  if (!id || id === 'instrument') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', id);
  // aero only: frameless + transparent window
  if (window.bmacw && window.bmacw.setTranslucent) {
    window.bmacw.setTranslucent(id === 'aero');
  }
  applyAeroOpacity();
  setTimeout(updateDockIcon, 100);
}
function applyAeroOpacity() {
  document.documentElement.style.setProperty('--aero-opacity', '0.82');
}
// render logo SVG to a 256x256 canvas with theme colors, send PNG to the dock
function updateDockIcon() {
  if (!window.bmacw || !window.bmacw.setDockIcon) return;
  const styles = getComputedStyle(document.documentElement);
  const bg = styles.getPropertyValue('--logo-bg').trim() || '#11161c';
  const border = styles.getPropertyValue('--logo-border').trim() || '#9aa6b2';
  const q1 = styles.getPropertyValue('--logo-quad-1').trim() || '#eef2f5';
  const q2 = styles.getPropertyValue('--logo-quad-2').trim() || '#ff9e2c';
  const ib = styles.getPropertyValue('--logo-inner-border').trim() || '#0a0d11';
  
  const resolvedSvg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 100 100">
      <circle cx="50" cy="50" r="48" fill="${bg}" stroke="${border}" stroke-width="3"/>
      <clipPath id="disc"><circle cx="50" cy="50" r="31"/></clipPath>
      <g clip-path="url(#disc)">
        <rect x="19" y="19" width="31" height="31" fill="${q1}"/>
        <rect x="50" y="50" width="31" height="31" fill="${q1}"/>
        <rect x="50" y="19" width="31" height="31" fill="${q2}"/>
        <rect x="19" y="50" width="31" height="31" fill="${q2}"/>
      </g>
      <circle cx="50" cy="50" r="31" fill="none" stroke="${ib}" stroke-width="2"/>
    </svg>
  `;
  
  const img = new Image();
  const svgBlob = new Blob([resolvedSvg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);
  
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    window.bmacw.setDockIcon(dataUrl).catch(console.error);
    URL.revokeObjectURL(url);
  };
  img.onerror = (e) => {
    console.error('Failed to load dynamic logo SVG to image:', e);
    URL.revokeObjectURL(url);
  };
  img.src = url;
}
applyTheme(Settings.get('theme', 'instrument'));

// 'en' = translated English, 'orig' = raw EDIABAS job names
const lang = () => Settings.get('lang', 'en');
// translated label (deGerman is memoized; mined layout labels arrive in German)
const itemLabel = (it) => lang() === 'orig' ? it.job : deGerman(it.label);

const view = document.getElementById('view');
const crumbsEl = document.getElementById('crumbs');
const led = document.getElementById('led');
const linkText = document.getElementById('link-text');
const sbLeft = document.getElementById('sb-left');
const sbRight = document.getElementById('sb-right');
const fkeysEl = document.getElementById('fkeys');

// display-name overrides; raw id stays for API/file lookup
const CHASSIS_DISPLAY = { F010: 'F10', F025: 'F25' };
const dispChassis = (id) => CHASSIS_DISPLAY[id] || id;

// short tags for chassis cards
const CHASSIS_TAG = {
  E36:'3-series 90s', E46:'3-series 98-06', E60:'5-series', E65:'7-series',
  E70:'X5', E83:'X3', E85:'Z4', E87:'1-series', E89:'Z4', E90:'3-series 05-12',
  E39:'5-series 95-03', E52:'Z8', E53:'X5 99-06',
  F01:'7-series', F07:'5 GT', F30:'3-series 12+', R50:'Mini', R56:'Mini',
  RR1:'Rolls-Royce', F010:'5-series', F025:'X3',
};

let crumbs = []; // [{label, fn}]

// escape server-sourced text (fault texts, labels, job names) for innerHTML
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, m => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

async function api(path, opts) {
  const res = await fetch(`${API}${path}`, opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

// api call with shared failure rendering: on error, errorBlock into container
// and mark the status line. returns null on failure.
async function tryApi(path, opts, container, msg = 'failed') {
  try { return await api(path, opts); }
  catch (e) {
    if (container) container.innerHTML = errorBlock(e.message);
    sbLeft.textContent = msg;
    return null;
  }
}

// result sets minus the set-0 system summary (kept when it's the only set)
function dataSets(sets) {
  const list = sets || [];
  return list.length > 1 ? list.slice(1) : list;
}

// flatten result sets into ordered [key, value] pairs, skipping internal keys
function flatResults(sets) {
  const out = [];
  dataSets(sets).forEach(s => Object.entries(s).forEach(([k, v]) => {
    if (!k.startsWith('_') && k !== 'JOB_STATUS') out.push([k, v]);
  }));
  return out;
}

// set while a flash read/backup holds the bus. the status poll skips its DME read
// during this window so it doesn't queue behind the multi-minute flash on busLock.
let flashing = false;

// map terse engine/flash errors to { title, detail, fix }
function explainError(raw) {
  const m = (raw || '').toString();
  const lower = m.toLowerCase();

  if (lower.includes('no interface') || lower.includes('no serial') || lower.includes('no cable'))
    return { title: 'No adapter connected', detail: 'BMacW could not find the K+DCAN cable.',
      fix: 'Plug the cable into the Mac (directly, not through a flaky USB hub) and into the car OBD-II port. The status light turns green when detected.' };

  if (lower.includes('security access') || lower.includes('denied'))
    return { title: 'Security access denied', detail: 'The DME rejected the seed/key authentication needed to read protected memory.',
      fix: 'Make sure the engine is OFF with ignition in position 2, the battery is healthy (or a charger is connected), and the cable is solid. Retry, the seed is random each attempt.' };

  if (lower.includes('read failed') || lower.includes('no data at'))
    return { title: 'Memory read failed', detail: `The DME stopped responding partway through the read (${m}).`,
      fix: 'Usually a connection drop or low battery. Check the cable seating, keep ignition on / engine off, and ensure steady power, then read again.' };

  if (lower.includes('conditions_not_correct') || lower.includes('sequence'))
    return { title: 'ECU rejected the request', detail: 'The DME is not in a state that allows this, often the engine is running or ignition is not fully on.',
      fix: 'Set ignition to position 2 with the engine OFF and try again.' };

  if (lower.includes('ifh_0018') || lower.includes('interfaceconnect') || lower.includes('connect'))
    return { title: 'Could not reach the ECU', detail: 'The cable is present but the DME did not answer.',
      fix: 'Turn the ignition on, confirm the cable is fully seated at both ends, and check the FTDI latency is set to 1 ms.' };

  if (lower.includes('error_f_code'))
    return { title: 'This function needs a fault code', detail: 'The detailed fault job requires a specific DTC as input.',
      fix: 'Read the fault codes first, then open the detail for a specific one.' };

  if (lower.includes('timeout'))
    return { title: 'The ECU timed out', detail: 'No response within the expected time.',
      fix: 'Check the cable and ignition, then retry. A weak battery or loose connector is the usual cause.' };

  if (lower.includes('engine failed to start'))
    return { title: 'Engine failed to start', detail: 'The diagnostic engine (the bundled sidecar) did not come up.',
      fix: 'Press Retry. If it keeps failing, quit and reopen BMacW.' };

  // fallback: raw message
  return { title: 'Something went wrong', detail: m || 'Unknown error.',
    fix: 'Check the cable and ignition (engine off, key on), then try again.' };
}

function errorBlock(raw, accent = 'amber') {
  const e = explainError(raw);
  return `<div class="empty">
    <div class="empty-big" style="color:var(--${accent})">${e.title}</div>
    <div>${esc(e.detail)}</div>
    <div style="font-size:12px;color:var(--ink-faint);max-width:48ch">${e.fix}</div>
  </div>`;
}

function setCrumbs(items) {
  crumbs = items;
  crumbsEl.innerHTML = '';
  items.forEach((c, i) => {
    if (i) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep'; sep.textContent = '/';
      crumbsEl.appendChild(sep);
    }
    const el = document.createElement('span');
    el.className = 'crumb' + (i === items.length - 1 ? ' active' : '');
    el.textContent = c.label;
    if (c.fn) el.onclick = c.fn;
    crumbsEl.appendChild(el);
  });
}

// INPA function-key bar. screens declare actions; bind number keys 1..9,0.
// Esc fires the `back` action.
let currentActions = []; // [{ key:'1', label, fn, kind }]

function setActions(actions) {
  stopLive(); stopLogging(); // leaving a screen halts polling + logging
  if (typeof dismissAttention === 'function') dismissAttention(); // drop the fault badge on screen change
  if (activationEcu && activeTests.size) { stopAllActivations(activationEcu); } // kill active actuator tests
  currentActions = actions;
  fkeysEl.innerHTML = '';
  actions.forEach(a => {
    const el = document.createElement('div');
    el.className = 'fkey' + (a.kind ? ' ' + a.kind : '');
    el.innerHTML = `<span class="fkey-num">${a.keyLabel || a.key}</span>
                    <span class="fkey-label">${esc(a.label)}</span>`;
    el.onclick = () => fireAction(a);
    a._el = el;
    fkeysEl.appendChild(el);
  });
}

function fireAction(a) {
  if (!a || !a.fn) return;
  if (a._el) { a._el.classList.remove('flash'); void a._el.offsetWidth; a._el.classList.add('flash'); }
  a.fn();
}

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  let key = e.key;
  // Esc and Backspace both act as back (F10)
  if (key === 'Escape' || key === 'Backspace') {
    const back = currentActions.find(a => a.kind === 'back');
    if (back) { e.preventDefault(); fireAction(back); }
    return;
  }
  const match = currentActions.find(a => a.key === key);
  if (match) { e.preventDefault(); fireAction(match); }
});

function head(eyebrow, title, subtitle) {
  return `<div class="screen-head">
    <div class="eyebrow">${esc(eyebrow)}</div>
    <h1 class="title">${esc(title)}</h1>
    ${subtitle ? `<p class="subtitle">${esc(subtitle)}</p>` : ''}
  </div>`;
}

function stagger(container, step = 35) {
  [...container.children].forEach((c, i) => { c.style.animationDelay = `${i * step}ms`; });
}

// shared modal lifecycle: builds the overlay, animates it in, wires a capture
// keydown handler + backdrop click, and tears both down on close (160ms fade).
// onKey(e, close) replaces the default Esc-to-close handling. close(val)
// forwards val to onClose (promise dialogs resolve with it); a backdrop click
// closes with backdropValue.
function openModal(html, { onKey, onClose, backdropValue } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = html;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));
  const close = (val) => {
    overlay.classList.remove('show');
    window.removeEventListener('keydown', handler, true);
    setTimeout(() => overlay.remove(), 160);
    if (onClose) onClose(val);
  };
  const handler = (e) => {
    if (onKey) return onKey(e, close);
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  };
  window.addEventListener('keydown', handler, true);
  overlay.onclick = (e) => { if (e.target === overlay) close(backdropValue); };
  return { overlay, close };
}

// confirm modal -> Promise<boolean>. Enter confirms, Esc cancels.
function confirmDialog({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const { overlay, close } = openModal(`
      <div class="modal ${danger ? 'danger' : ''}" role="dialog" aria-modal="true">
        <div class="modal-title">${title}</div>
        <div class="modal-body">${body}</div>
        <div class="modal-actions">
          <button class="btn modal-cancel">${cancelLabel}<span class="modal-key">Esc</span></button>
          <button class="btn ${danger ? 'danger' : 'primary'} modal-confirm">${confirmLabel}<span class="modal-key">⏎</span></button>
        </div>
      </div>`, {
      onClose: resolve,
      backdropValue: false,
      onKey: (e, close) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); }
        else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(true); }
      },
    });
    overlay.querySelector('.modal-cancel').onclick = () => close(false);
    overlay.querySelector('.modal-confirm').onclick = () => close(true);
    overlay.querySelector('.modal-confirm').focus();
  });
}

// value-input modal for INPA functions (throttle command, measurement-block index,
// service comment, raw telegram). returns string or null. Enter submits, Esc cancels.
function inputDialog({ title, body, kind = 'text', example = '', confirmLabel = 'Run', danger = false }) {
  return new Promise((resolve) => {
    const htmlType = kind === 'number' ? 'number' : 'text';
    const ph = example ? `e.g. ${example}` : '';
    const { overlay, close } = openModal(`
      <div class="modal ${danger ? 'danger' : ''}" role="dialog" aria-modal="true">
        <div class="modal-title">${title}</div>
        <div class="modal-body">${body || ''}</div>
        <div class="modal-input-wrap">
          <input class="modal-input" type="${htmlType}" placeholder="${ph}"
                 ${kind === 'hex' ? 'spellcheck="false" autocapitalize="off"' : ''} />
          ${kind === 'hex' ? '<span class="modal-input-hint">hex / KWP bytes, e.g. 22,40,0A</span>' : ''}
          ${kind === 'number' ? '<span class="modal-input-hint">numeric value</span>' : ''}
        </div>
        <div class="modal-actions">
          <button class="btn modal-cancel">Cancel<span class="modal-key">Esc</span></button>
          <button class="btn ${danger ? 'danger' : 'primary'} modal-confirm">${confirmLabel}<span class="modal-key">⏎</span></button>
        </div>
      </div>`, {
      onClose: resolve,
      backdropValue: null,
      onKey: (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
        else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); submit(); }
      },
    });
    const field = overlay.querySelector('.modal-input');
    const submit = () => {
      const v = field.value.trim();
      if (v === '') { field.focus(); field.classList.add('shake'); setTimeout(() => field.classList.remove('shake'), 350); return; }
      close(v);
    };
    overlay.querySelector('.modal-cancel').onclick = () => close(null);
    overlay.querySelector('.modal-confirm').onclick = submit;
    field.focus();
  });
}

// prompt for a value, then call the job with it
async function runInputFunction(ecu, input, container) {
  const danger = /steuern|command|throttle|setpoint|write|store|reset/i.test(
    (input.field || '') + ' ' + (input.job || ''));
  const val = await inputDialog({
    title: esc(input.field || input.job),
    body: input.args_template
      ? `<span class="muted">${esc(input.args_template)}</span><br><span class="mono" style="font-size:11px;color:var(--ink-faint)">job: ${esc(input.job)}</span>`
      : `<span class="mono" style="font-size:11px;color:var(--ink-faint)">job: ${esc(input.job)}</span>`,
    kind: input.kind || 'text',
    example: input.example || '',
    confirmLabel: danger ? 'Send' : 'Run',
    danger,
  });
  if (val == null) { sbLeft.textContent = 'cancelled'; return; }

  container.className = 'results-panel';
  container.innerHTML = `<div class="empty"><span class="loader"></span><span>Running ${esc(input.field || input.job)}…</span></div>`;
  try {
    const data = await api(`/api/ecu/${ecu.sgbd}/run/${input.job}?arg=${encodeURIComponent(val)}`, { method: 'POST' });
    renderResultSets(data.sets, container, input.job);
    sbLeft.textContent = `${input.job} ${val} · done`;
  } catch (e) {
    container.innerHTML = errorBlock(e.message);
    sbLeft.textContent = 'failed';
  }
}

// screen 1: chassis
