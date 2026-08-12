// core: API client, theme, util, dialogs, error formatting
// renderer. chassis -> section -> ECU -> fault flow against the local .NET
// sidecar (EDIABAS engine).

const API = new URLSearchParams(location.search).get('api') || 'http://127.0.0.1:8777';
// IS_WEB / APP_NAME are declared inline in index.html: the name has to land
// before first paint, which is earlier than any external script runs.

// persisted settings
const Settings = {
  // the native shell injects the durable copy (window.__bmacwSettings) at
  // document start: localStorage is origin-scoped and the app's port is
  // ephemeral, so localStorage alone would reset every launch.
  data: (typeof window !== 'undefined' && window.__bmacwSettings) ||
        JSON.parse(localStorage.getItem('bmacw.settings') || '{}'),
  get(key, def) { return key in this.data ? this.data[key] : def; },
  set(key, val) {
    this.data[key] = val;
    const json = JSON.stringify(this.data);
    localStorage.setItem('bmacw.settings', json);
    if (window.bmacw && window.bmacw.saveSettings) window.bmacw.saveSettings(json);
  },
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
  // Repaint the F-key bar: its chrome (the RUNNING block) is theme-dependent,
  // so a live swap has to redraw rather than wait for the next screen.
  // (guarded: applyTheme is DECLARED above the bar's state, so a call made
  // before it initialises would hit the temporal dead zone)
  try { paintActions(currentActions); } catch { /* bar not built yet */ }
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
// swap the tab icon in place; the page ships no <link rel="icon">, so make one
function setFavicon(dataUrl) {
  let link = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = 'image/png';
  link.href = dataUrl;
}
// render logo SVG to a 256x256 canvas with theme colors, send PNG to the
// dock -- or, on the web, to the favicon. Same icon, different sink.
function updateDockIcon() {
  const dock = window.bmacw && window.bmacw.setDockIcon;
  if (!dock && !IS_WEB) return;
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
    if (dock) window.bmacw.setDockIcon(dataUrl).catch(console.error);
    else setFavicon(dataUrl);
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

// Demo mode: with no cable, job runs return synthesized values so the screens
// can be walked. Opt-in via Settings or ?demo=1 in the window URL, and every
// such response is badged (see the live panel) so it can't pass for real data.
const demoMode = () => Settings.get('demo', 'off') === 'on'
  || new URLSearchParams(location.search).get('demo') === '1';

async function api(path, opts) {
  let url = `${API}${path}`;
  if (demoMode() && path.includes('/run/'))
    url += (url.includes('?') ? '&' : '?') + 'demo=1';
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  const data = await res.json();
  return data;
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

// ?group= for a fault read: the diagnostic-address group SGBD, so the server
// lets EDIABAS pick the exact installed variant (see server LoadForJob)
const groupQuery = (o) => (o && o.group) ? `?group=${encodeURIComponent(o.group)}` : '';

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

  // VM / app-side errors (bestvm.js VmError, vmbridge): the job interpreter
  // refused or broke BEFORE anything reached the wire. Checked first, so a
  // VM message mentioning e.g. a checksum cannot fall into a wire branch —
  // "check the cable" for these sends the user chasing a hardware fault that
  // does not exist.
  if (/vm ?error|unimplemented opcode|refusing to (run|transmit)|step limit at op|unknown register|operand mode|unresolved (jump|etag)|no telegram sink|raised error via eerr/i.test(m))
    return { title: 'App error — not the car', detail: m || 'The job interpreter failed.',
      fix: `This is a bug in ${APP_NAME}, not the cable or the car — nothing needs checking on the vehicle. Please report this exact message.` };

  if (lower.includes('no interface') || lower.includes('no serial') || lower.includes('no cable'))
    return { title: 'No adapter connected', detail: `${APP_NAME} could not find the K+DCAN cable.`,
      fix: 'Plug the cable into the Mac (directly, not through a hub) and into the car OBD-II port. The status light turns green when detected.' };

  if (lower.includes('security access') || lower.includes('denied'))
    return { title: 'Security access denied', detail: 'The DME rejected the seed/key authentication needed to read protected memory.',
      fix: 'Make sure the engine is OFF with ignition in position 2, the battery is healthy (or a charger is connected), and the cable is solid. Retry, the seed is random each attempt.' };

  if (lower.includes('read failed') || lower.includes('no data at'))
    return { title: 'Memory read failed', detail: `The DME stopped responding partway through the read (${m}).`,
      fix: 'Usually a connection drop or low battery. Check the cable seating, keep ignition on / engine off, and ensure steady power, then read again.' };

  if (lower.includes('conditions_not_correct') || lower.includes('sequence'))
    return { title: 'ECU rejected the request', detail: 'The DME is not in a state that allows this, often the engine is running or ignition is not fully on.',
      fix: 'Set ignition to position 2 with the engine OFF and try again.' };

  // IFH-0009: the ECU said nothing at all. INPA's most common error, and
  // the one people compare against, so it keeps its identity here.
  if (lower.includes('ifh-0009'))
    return { title: 'No response from the ECU (IFH-0009)', detail: 'The request went out and nothing came back.',
      fix: 'Ignition on (engine off), cable seated at both ends. If other modules answer, this one may not be fitted to the car.' };

  // IFH-0003: something is wrong on the line itself
  if (lower.includes('ifh-0003') || lower.includes('echo'))
    return { title: 'The cable is not hearing itself (IFH-0003)', detail: 'The K line echoes everything sent; that echo did not come back correctly.',
      fix: 'Reseat the cable at both ends. If it persists, another device may be driving the bus, or the FTDI latency needs to be 1 ms.' };

  // IFH-0019: bytes arrived, but not a whole valid telegram
  if (lower.includes('ifh-0019') || lower.includes('checksum') || lower.includes('incomplete'))
    return { title: 'Damaged answer from the ECU (IFH-0019)', detail: 'The telegram arrived truncated or with a bad checksum.',
      fix: 'Usually electrical: check power and the cable, and keep the engine off. Retrying often succeeds.' };

  if (lower.includes('ifh-0018') || lower.includes('ifh_0018') || lower.includes('interfaceconnect') || lower.includes('connect'))
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
      fix: `Press Retry. If it keeps failing, quit and reopen ${APP_NAME}.` };

  // fallback: raw message
  return { title: 'Something went wrong', detail: m || 'Unknown error.',
    fix: 'Check the cable and ignition (engine off, key on), then try again.' };
}

function errorBlock(raw, accent = 'amber') {
  const e = explainError(raw);
  return `<div class="empty">
    <div class="empty-big" style="color:var(--${accent})">${e.title}</div>
    <div>${esc(e.detail)}</div>
    ${e.fix ? `<div style="font-size:12px;color:var(--ink-faint);max-width:48ch">${e.fix}</div>` : ''}
  </div>`;
}

function setCrumbs(items) {
  // the WDS wiring screen hides the F-key bar (it has its own footer); any
  // other screen drawing itself is the signal to put it back
  document.body.classList.remove('wds-nofkeys');
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
// INPA's bar has two rows and Shift swaps between them: F3 is "inclination +"
// and Shift+F3 its opposite. `shiftActions` is the second row when a screen
// has one; the bar shows one row at a time, exactly as INPA does.
let shiftActions = null;
let baseActions = [];
let shiftHeld = false;

// The bar is TEN FIXED SLOTS, F1..F10, drawn whether or not a key is bound --
// INPA's layout, kept in every skin. The empty ones are part of it: they are
// how you see at a glance that F4 does nothing on this screen. The F-number is
// printed on its own row ABOVE the buttons rather than inside them.
//
// So a screen's actions have to be placed into slots rather than listed. A key
// says which slot it wants: '1'..'9' and '0' are INPA's own F1..F10 (0 IS F10,
// which is why Escape/back lands there), and anything else -- the letter keys
// some screens use -- takes the next free slot.
const INPA_SLOTS = 10;

function inpaSlot(a) {
  // Back is F10, always -- that is where INPA puts End/Exit on every screen.
  // Checked before the number, because these carry keyLabel:'Esc' and would
  // otherwise fail to parse and land in whatever slot happened to be free.
  if (a.kind === 'back') return INPA_SLOTS - 1;
  // `key` is the binding; keyLabel is only its caption ('Esc', 'F3'). Read the
  // binding first so a decorative label cannot move a key out of its slot.
  const m = /^F?(\d+)$/.exec(String(a.key || a.keyLabel || '').toUpperCase());
  if (!m) return null;
  const n = Number(m[1]);
  if (n === 0) return INPA_SLOTS - 1;    // INPA's F10 is the '0' key
  return n >= 1 && n <= INPA_SLOTS ? n - 1 : null;
}

function paintActionsInpa(actions) {
  const slots = new Array(INPA_SLOTS).fill(null);
  const spill = [];
  // Back claims F10 FIRST. A screen that also binds '0' would otherwise take
  // the slot on its way past and push End into a random gap.
  const ordered = [...actions].sort((x, y) =>
    (y.kind === 'back') - (x.kind === 'back'));
  ordered.forEach(a => {
    const i = inpaSlot(a);
    if (i !== null && !slots[i]) slots[i] = a; else spill.push(a);
  });
  // a letter-keyed action (or a collision) fills the first empty slot, so it is
  // still reachable by mouse and still lines up under a printed F-number
  spill.forEach(a => {
    const i = slots.indexOf(null);
    if (i >= 0) slots[i] = a;
  });

  fkeysEl.innerHTML = '';
  const keys = document.createElement('div');
  keys.className = 'fkey-nums';
  const btns = document.createElement('div');
  btns.className = 'fkey-btns';
  slots.forEach((a, i) => {
    const num = document.createElement('span');
    num.className = 'fkey-num';
    num.textContent = `F${i + 1}`;
    keys.appendChild(num);

    const el = document.createElement('div');
    el.className = 'fkey' + (a && a.kind ? ' ' + a.kind : '')
                 + (a ? '' : ' empty');
    if (a) {
      el.innerHTML = `<span class="fkey-label">${esc(a.label)}</span>`;
      el.onclick = () => fireAction(a);
      a._el = el;
    }
    btns.appendChild(el);
  });
  fkeysEl.appendChild(keys);
  fkeysEl.appendChild(btns);
}

// The bar is the same SHAPE in every theme -- ten fixed slots, numbers above
// the keys -- because it is INPA's bar, not a decoration. Themes restyle it;
// they do not rearrange it.
function paintActions(actions) {
  fkeysEl.classList.add('inpa-bar');
  paintActionsInpa(actions);
  fkeysEl.classList.toggle('shifted', actions === shiftActions);
  syncNavBack(actions);
}

// The touch back arrow tracks whatever the current screen registered as its
// `back` action, so it does exactly what Esc does -- no second notion of
// "back" to keep in step. A screen with no back action (the vehicle picker)
// hides it rather than showing a dead control.
function syncNavBack(actions) {
  const el = document.getElementById('nav-back');
  if (!el) return;
  const back = (actions || []).find(a => a.kind === 'back');
  el.hidden = !back;
  el.onclick = back ? () => fireAction(back) : null;
}

// a screen may also want its BODY repainted when the row swaps, so the list
// and the bar always show the same half
let shiftRepaint = null;
function onShiftRepaint(fn, enabled) { shiftRepaint = enabled ? fn : null; }
const shiftHeldNow = () => shiftHeld;

// swap the bar to the row Shift selects, keeping the keys bound to it
function applyShift(on) {
  if (!shiftActions || on === shiftHeld) return;
  shiftHeld = on;
  currentActions = on ? shiftActions : baseActions;
  paintActions(currentActions);
  if (shiftRepaint) shiftRepaint();
}

function setActions(actions, shifted) {
  stopLive(); stopLogging(); // leaving a screen halts polling + logging
  if (typeof dismissAttention === 'function') dismissAttention(); // drop the fault badge on screen change
  // kill active actuator tests -- unless this is a same-screen redraw held
  // open by keepActivationsDuring (activations.js), which is not a leave
  if (activationEcu && activeTests.size && !activationsHeld()) { stopAllActivations(activationEcu); }
  baseActions = actions;
  shiftActions = (shifted && shifted.length) ? shifted : null;
  shiftHeld = false;
  shiftRepaint = null;          // the previous screen's list is gone
  currentActions = actions;
  paintActions(actions);
}

// Add one key to the bar a screen has already set.
//
// setActions() is a screen change: it stops polling, drops the shift row, and
// clears the fault badge. A key ADDED to a menu that is already drawn -- the
// app's own Coding entry on an ECU root -- must do none of that, so it slots
// into the current row in front of Back and repaints just the bar.
function addAction(a) {
  if (!a || baseActions.some(x => x.key === a.key)) return;
  const at = baseActions.findIndex(x => x.kind === 'back');
  if (at >= 0) baseActions.splice(at, 0, a); else baseActions.push(a);
  if (!shiftHeld) { currentActions = baseActions; paintActions(baseActions); }
}

function fireAction(a) {
  if (!a || !a.fn) return;
  if (a._el) { a._el.classList.remove('flash'); void a._el.offsetWidth; a._el.classList.add('flash'); }
  a.fn();
}

// Shift swaps the bar to its second row for as long as it is held, the way
// INPA's own keyboard works. Released -- or the window losing focus mid-hold
// -- puts the first row back, so the bar can never be left showing keys the
// next keypress will not fire.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Shift') applyShift(true);
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'Shift') applyShift(false);
});
window.addEventListener('blur', () => applyShift(false));

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  // an open modal owns the keyboard (openModal wires its own handler).
  // without this, Backspace behind the INPA Script-selection popup fired the
  // screen's "back" action again and stacked another popup per press.
  if (document.querySelector('.modal-overlay')) return;
  // typing in an input/select must never trigger screen actions
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
  let key = e.key;
  // Esc and Backspace both act as back (F10)
  if (key === 'Escape' || key === 'Backspace') {
    const back = currentActions.find(a => a.kind === 'back');
    if (back) { e.preventDefault(); fireAction(back); }
    return;
  }
  // With Shift held the browser reports "!" for the 1 key, so match on the
  // physical digit (e.code) as well -- the shifted row is reached by holding
  // Shift and pressing the same number.
  const digit = /^Digit(\d)$/.exec(e.code || '');
  // "+" needs Shift on most layouts, so the bare key on the same cap counts
  // too: = for zoom in, _ for zoom out. Both read as the key they are next to.
  const alias = { '=': '+', '_': '-' }[key];
  const match = currentActions.find(a => a.key === key)
    || (alias && currentActions.find(a => a.key === alias))
    || (digit && currentActions.find(a => a.key === digit[1]));
  if (match) { e.preventDefault(); fireAction(match); }
});

// Turn title= into an instant tooltip. The browser's own waits about a second
// and a half, which is long enough that nobody sees it; this shows on hover.
// The title stays for accessibility and as a fallback, and the tip is anchored
// to whichever edge keeps it on screen.
function tipify(root) {
  root.querySelectorAll('[title]:not([data-tip])').forEach((el) => {
    const text = el.getAttribute('title');
    if (!text) return;
    // NOT THE TRAFFIC LIGHTS. They are 12px dots at the very top of the
    // window, so the tooltip flips below them (tip-below) and lands as a
    // dark #1a2129 pill sitting right beside the dots -- wider than the
    // whole group, so hovering one paints what looks like a black bar
    // across all three. macOS does not caption its own traffic lights
    // either; the glyph that appears inside the dot on hover is the whole
    // affordance. The title stays for screen readers.
    if (el.classList.contains('win-dot')) return;
    el.dataset.tip = text;
    // measured once on first hover: layout is settled by then
    el.addEventListener('pointerenter', () => {
      const r = el.getBoundingClientRect();
      const half = Math.min(text.length * 6.2, 320) / 2;
      el.classList.toggle('tip-left', r.left + r.width / 2 - half < 8);
      el.classList.toggle('tip-right',
        r.left + r.width / 2 + half > window.innerWidth - 8);
      el.classList.toggle('tip-below', r.top < 92);
    }, { once: false });
  });
}

function head(eyebrow, title, subtitle) {
  return `<div class="screen-head">
    <div class="eyebrow">${esc(eyebrow)}</div>
    ${title ? `<h1 class="title">${esc(title)}</h1>` : ''}
    ${subtitle ? `<p class="subtitle">${esc(subtitle)}</p>` : ''}
  </div>`;
}

function stagger(container, step = 35) {
  [...container.children].forEach((c, i) => { c.style.animationDelay = `${i * step}ms`; });
}

// A shimmering placeholder list, shown in the spot a fetched list will fill.
// `rows` sets how many; `sub` adds a second, shorter bar per row for the
// two-line list cells (module name + code). Returns the HTML string.
function skeletonList(rows = 6, sub = true) {
  const row = `<div class="sk-row" aria-hidden="true">`
    + `<div class="sk-bar sk-title"></div>`
    + (sub ? `<div class="sk-bar sk-sub"></div>` : '')
    + `</div>`;
  return `<div class="skeleton sk-list" role="status" aria-label="Loading">`
    + row.repeat(rows) + `</div>`;
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
    title: esc(typeof jobLabel === 'function' ? jobLabel(input.job) : input.job),
    // the field text is the entry instruction ("Enter as LABEL;VALUE1"); show it
    // as the prompt, with the raw job name underneath for reference
    body: `${input.field ? `<div>${esc(input.field)}</div>` : ''}`
      + `${input.args_template ? `<span class="muted">${esc(input.args_template)}</span><br>` : ''}`
      + `<span class="mono" style="font-size:11px;color:var(--ink-faint)">job: ${esc(input.job)}</span>`,
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
