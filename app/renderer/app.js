// settings, connection status, boot + wiring
let lastScreen = showChassis; // where to return to when leaving settings

function showSettings() {
  if (typeof cancelSweep === 'function') cancelSweep(); // stop a running sweep
  setCrumbs([{ label: 'Vehicles', fn: showChassis }, { label: 'Settings' }]);
  sbLeft.textContent = 'settings';
  view.innerHTML = head('Preferences', 'Settings', 'Configure how BMacW displays diagnostics.');

  const wrap = document.createElement('div');
  wrap.className = 'settings-list stagger';

  // skin picker: swatch grid
  const themeRow = document.createElement('div');
  themeRow.className = 'setting-row theme-row';
  themeRow.innerHTML = `
    <div class="setting-text" style="margin-bottom:14px">
      <div class="setting-title">Skin</div>
      <div class="setting-desc">Pick a look. Applies instantly and persists.</div>
    </div>`;
  const themeGrid = document.createElement('div');
  themeGrid.className = 'theme-grid';
  const cur = Settings.get('theme', 'instrument');
  THEMES.forEach(t => {
    const card = document.createElement('button');
    card.className = 'theme-card' + (t.id === cur ? ' active' : '');
    card.dataset.theme = t.id;
    card.innerHTML = `
      <span class="theme-swatch sw-${t.id}"></span>
      <span class="theme-meta"><span class="theme-name">${t.name}</span></span>`;
    card.onclick = () => {
      Settings.set('theme', t.id);
      applyTheme(t.id);
      themeGrid.querySelectorAll('.theme-card').forEach(c => c.classList.toggle('active', c === card));
    };
    themeGrid.appendChild(card);
  });
  themeRow.appendChild(themeGrid);
  wrap.appendChild(themeRow);


  // language / labels toggle
  wrap.appendChild(settingRow(
    'Function labels',
    'Show translated English names, or the original EDIABAS job names.',
    [
      { val: 'en', label: 'English' },
      { val: 'orig', label: 'Original (EDIABAS)' },
    ],
    lang(),
    (v) => Settings.set('lang', v),
  ));

  // INPA-style screens toggle: render ECU menu and fault list like the original
  // INPA frontend (Hauptmenue F-key list + labeled error-memory view).
  wrap.appendChild(settingRow(
    'INPA-style screens',
    'Lay out the ECU menu and fault memory exactly like the original INPA frontend.',
    [
      { val: 'on', label: 'INPA layout' },
      { val: 'off', label: 'Modern' },
    ],
    Settings.get('inpaScreens', 'off'),
    (v) => Settings.set('inpaScreens', v),
  ));

  view.appendChild(wrap);
  stagger(wrap, 40);

  setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: () => lastScreen() }]);
}

function settingRow(title, desc, options, current, onChange) {
  const row = document.createElement('div');
  row.className = 'setting-row';
  row.innerHTML = `
    <div class="setting-text">
      <div class="setting-title">${title}</div>
      <div class="setting-desc">${desc}</div>
    </div>
    <div class="seg" role="group"></div>`;
  const seg = row.querySelector('.seg');
  options.forEach(opt => {
    const b = document.createElement('button');
    b.className = 'seg-btn' + (opt.val === current ? ' active' : '');
    b.textContent = opt.label;
    b.onclick = () => {
      seg.querySelectorAll('.seg-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      onChange(opt.val);
    };
    seg.appendChild(b);
  });
  return row;
}

// ---------- connection status ----------
// LED reflects cable connectivity (K+DCAN serial port present), not the .NET
// engine. green = cable detected; amber = engine up but no cable; red = engine
// unreachable.
let engineUp = false;
async function pollEngine() {
  try { await api('/api/health'); engineUp = true; }
  catch { engineUp = false; }
}
async function pollCable() {
  if (!engineUp) {
    led.className = 'led off'; linkText.textContent = 'engine offline';
    return null;
  }
  try {
    const { port } = await api('/api/port');
    if (port) {
      led.className = 'led ok';
      linkText.textContent = 'cable: ' + port.replace('/dev/', '');
    } else {
      led.className = 'led idle';
      linkText.textContent = 'no cable';
    }
    return port;
  } catch {
    led.className = 'led idle'; linkText.textContent = 'no cable';
    return null;
  }
}
// Battery (KL30) + Ignition (KL15) indicators, INPA-style. only meaningful with a
// car on the cable; shows "off/-" otherwise. cheap, best-effort.
const batLed = document.getElementById('bat-led');
const batVal = document.getElementById('bat-val');
const ignLed = document.getElementById('ign-led');
const ignVal = document.getElementById('ign-val');
async function pollState(port) {
  if (!engineUp || !port || flashing) {
    if (!flashing) { batLed.className = 'kl-led off'; batVal.textContent = '-'; ignLed.className = 'kl-led off'; ignVal.textContent = '-'; }
    return; // during a flash, leave the last reading and skip the bus
  }
  try {
    const s = await api('/api/state' + (stateSgbd ? `?sgbd=${encodeURIComponent(stateSgbd)}` : ''));
    if (s.battery != null) { batLed.className = 'kl-led on'; batVal.textContent = s.battery.toFixed(1) + ' V'; }
    else { batLed.className = 'kl-led off'; batVal.textContent = 'off'; }
    if (s.ignition === true) { ignLed.className = 'kl-led on'; ignVal.textContent = 'on'; }
    else if (s.ignition === false) { ignLed.className = 'kl-led off'; ignVal.textContent = 'off'; }
    else { ignLed.className = 'kl-led off'; ignVal.textContent = '-'; }
  } catch {
    batLed.className = 'kl-led off'; batVal.textContent = '-';
    ignLed.className = 'kl-led off'; ignVal.textContent = '-';
  }
}
// battery/ignition is a real DME transaction: poll slowly (~12s) and only with a
// cable present. hammering it collides with other reads and can wake/sleep the
// bus. cable/engine status stays on the fast timer (free local checks).
let lastStatePoll = 0;
async function refreshStatus() {
  await pollEngine();
  const port = await pollCable();
  const now = Date.now();
  if (port && now - lastStatePoll > 12000) {
    lastStatePoll = now;
    await pollState(port);
    if (typeof syncVselState === 'function') syncVselState();
  } else if (!port) {
    await pollState(null); // clear the indicators when unplugged
    if (typeof syncVselState === 'function') syncVselState();
  }
}

function dismissSplash() {
  const s = document.getElementById('splash');
  if (!s || s.classList.contains('hide')) return;
  s.classList.add('hide');
  setTimeout(() => s.remove(), 600);
}
function splashStatus(msg) {
  const el = document.getElementById('splash-status');
  if (el) el.textContent = msg;
}

(async function boot() {
  const splashStart = Date.now();
  // wait for the sidecar, then show the start screen
  for (let i = 0; i < 40; i++) {
    await pollEngine();
    if (engineUp) break;
    if (i === 6) splashStatus('warming up the engine');
    await new Promise(r => setTimeout(r, 400));
  }
  splashStatus(engineUp ? 'connecting to interface' : 'engine did not start');
  await pollCable();
  setInterval(refreshStatus, 3000);
  // hold the splash briefly so it never just flickers
  const minMs = 1100;
  const wait = Math.max(0, minMs - (Date.now() - splashStart));
  setTimeout(dismissSplash, wait);
  document.getElementById('settings-btn').onclick = showSettings;
  document.getElementById('flash-btn').onclick = showFlashing;
  // custom window controls (frameless window for Aero)
  if (window.bmacw) {
    document.getElementById('win-close').onclick = () => window.bmacw.winClose();
    document.getElementById('win-min').onclick = () => window.bmacw.winMinimize();
    document.getElementById('win-zoom').onclick = () => window.bmacw.winZoom();
  }
  showChassis().catch(e => {
    view.innerHTML = `<div class="empty"><div class="empty-big" style="color:var(--red)">Engine unreachable</div><div>${e.message}</div></div>`;
  });
})();
