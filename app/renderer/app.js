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

  // auto-scan the DME (and trans) for stored faults when a chassis is opened,
  // popping a corner badge if anything needs attention.
  wrap.appendChild(settingRow(
    'Auto-scan on open',
    'Read the engine fault memory automatically when you select a vehicle, and flag stored faults.',
    [
      { val: 'on', label: 'On' },
      { val: 'off', label: 'Off' },
    ],
    Settings.get('autoScan', 'off'),
    (v) => Settings.set('autoScan', v),
  ));

  // startup chassis: load a chosen chassis straight to its modules on launch.
  // searchable combo of all chassis the config knows, plus "Ask each time".
  const startRow = settingCombo(
    'Startup vehicle',
    'Skip the chassis picker and open this vehicle when the app starts.',
    [{ val: '', label: 'Ask each time' }], // filled from /api/chassis below
    Settings.get('startChassis', ''),
    (v) => { Settings.set('startChassis', v); loadStartEcus(v); },
  );
  wrap.appendChild(startRow.el);

  // startup module: optionally open straight into one ECU of the startup vehicle,
  // preloading its menu/layout. options depend on the chosen chassis.
  const ecuRow = settingCombo(
    'Startup module',
    'Also open this module of the startup vehicle, preloading it. Needs a startup vehicle.',
    [{ val: '', label: 'None' }],
    Settings.get('startEcu', ''),
    (v) => Settings.set('startEcu', v),
  );
  wrap.appendChild(ecuRow.el);

  // repopulate the module combo for a chassis. value encodes sgbd|code|label so
  // boot can open the ECU without re-fetching.
  async function loadStartEcus(chassisId) {
    if (!chassisId) { ecuRow.setOptions([{ val: '', label: 'None' }], ''); Settings.set('startEcu', ''); return; }
    try {
      const ch = await api(`/api/chassis/${chassisId}`);
      const opts = [{ val: '', label: 'None' }];
      (ch.sections || []).forEach(s => s.ecus.forEach(e =>
        opts.push({ val: `${e.sgbd}|${e.code}|${e.label}`, label: `${e.label} (${s.name})` })));
      const cur = Settings.get('startEcu', '');
      const valid = opts.some(o => o.val === cur);
      if (!valid && cur) Settings.set('startEcu', ''); // stale module from another chassis
      ecuRow.setOptions(opts, valid ? cur : '');
    } catch { ecuRow.setOptions([{ val: '', label: 'None' }], ''); }
  }

  api('/api/chassis').then(ids => {
    startRow.setOptions([
      { val: '', label: 'Ask each time' },
      ...(ids || []).map(id => ({ val: id, label: dispChassis(id) })),
    ], Settings.get('startChassis', ''));
    loadStartEcus(Settings.get('startChassis', ''));
  }).catch(() => {});

  // re-run the first-launch tour
  const tourRow = document.createElement('div');
  tourRow.className = 'setting-row tour-setting';
  tourRow.innerHTML = `
    <div class="setting-text">
      <div class="setting-title">Tutorial</div>
      <div class="setting-desc">Walk through the app's main controls again.</div>
    </div>`;
  const tourBtn = document.createElement('button');
  tourBtn.className = 'btn';
  tourBtn.textContent = 'Show the tour';
  tourBtn.onclick = () => startTutorial();
  tourRow.appendChild(tourBtn);
  wrap.appendChild(tourRow);

  view.appendChild(wrap);

  // version footer
  const ver = document.createElement('div');
  ver.className = 'settings-version';
  ver.textContent = `BMacW ${(window.bmacw && window.bmacw.version) ? 'v' + window.bmacw.version : ''}`.trim();
  view.appendChild(ver);

  stagger(wrap, 40);

  setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: () => lastScreen() }]);
}

// searchable custom dropdown for long option lists (chassis picker). returns
// { el, setOptions(options, current) }. options: [{val,label}].
function settingCombo(title, desc, options, current, onChange) {
  const row = document.createElement('div');
  row.className = 'setting-row';
  row.innerHTML = `
    <div class="setting-text">
      <div class="setting-title">${title}</div>
      <div class="setting-desc">${desc}</div>
    </div>
    <div class="combo">
      <button class="combo-btn" type="button"><span class="combo-val"></span><span class="combo-caret">▾</span></button>
      <div class="combo-pop" hidden>
        <input class="combo-search" type="text" placeholder="Search…" />
        <div class="combo-list"></div>
      </div>
    </div>`;
  const combo = row.querySelector('.combo');
  const btn = row.querySelector('.combo-btn');
  const valEl = row.querySelector('.combo-val');
  const pop = row.querySelector('.combo-pop');
  const search = row.querySelector('.combo-search');
  const list = row.querySelector('.combo-list');
  let opts = options.slice();
  let sel = current;

  const labelFor = (v) => (opts.find(o => o.val === v) || {}).label || v || '';
  const renderVal = () => { valEl.textContent = labelFor(sel); };

  const renderList = (filter = '') => {
    const f = filter.trim().toLowerCase();
    list.innerHTML = '';
    opts.filter(o => !f || o.label.toLowerCase().includes(f) || String(o.val).toLowerCase().includes(f))
      .forEach(o => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'combo-item' + (o.val === sel ? ' active' : '');
        item.textContent = o.label;
        item.onclick = () => { sel = o.val; renderVal(); onChange(sel); close(); };
        list.appendChild(item);
      });
    if (!list.children.length) list.innerHTML = '<div class="combo-empty">No matches</div>';
  };

  const open = () => {
    pop.hidden = false; combo.classList.add('open');
    search.value = ''; renderList(); setTimeout(() => search.focus(), 10);
    // flip upward if there isn't room below (bottom rows would be off-screen)
    requestAnimationFrame(() => {
      const btnRect = btn.getBoundingClientRect();
      const need = pop.offsetHeight + 8;
      const below = window.innerHeight - btnRect.bottom;
      combo.classList.toggle('drop-up', below < need && btnRect.top > below);
    });
    document.addEventListener('mousedown', onDoc, true);
    window.addEventListener('keydown', onEsc, true);
  };
  const close = () => {
    pop.hidden = true; combo.classList.remove('open', 'drop-up');
    document.removeEventListener('mousedown', onDoc, true);
    window.removeEventListener('keydown', onEsc, true);
  };
  const onDoc = (e) => { if (!combo.contains(e.target)) close(); };
  const onEsc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };

  btn.onclick = () => (pop.hidden ? open() : close());
  search.oninput = () => renderList(search.value);

  renderVal();
  return {
    el: row,
    setOptions(newOpts, cur) { opts = newOpts.slice(); if (cur !== undefined) sel = cur; renderVal(); },
  };
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

// status polling, paused while the window is hidden (no point hitting the
// sidecar for LED updates nobody sees)
let statusTimer = null;
function startStatusPolling() {
  if (statusTimer == null) statusTimer = setInterval(refreshStatus, 3000);
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (statusTimer != null) { clearInterval(statusTimer); statusTimer = null; } }
  else { refreshStatus(); startStatusPolling(); }
});

// the main process opens the window immediately; the renderer waits here for
// the sidecar health endpoint (300ms poll, up to 30s) behind the boot splash
async function waitForEngine() {
  for (let i = 0; i < 100; i++) {
    await pollEngine();
    if (engineUp) return true;
    if (i === 8) splashStatus('warming up the engine');
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

(async function boot() {
  document.getElementById('settings-btn').onclick = showSettings;
  document.getElementById('flash-btn').onclick = showFlashing;
  // custom window controls (frameless window for Aero)
  if (window.bmacw) {
    document.getElementById('win-close').onclick = () => window.bmacw.winClose();
    document.getElementById('win-min').onclick = () => window.bmacw.winMinimize();
    document.getElementById('win-zoom').onclick = () => window.bmacw.winZoom();
  }

  // jump straight to a preselected startup vehicle (and module), else the picker
  const startChassis = Settings.get('startChassis', '');
  const startEcu = Settings.get('startEcu', '');
  const openStart = async () => {
    if (startChassis) {
      const ids = await api('/api/chassis').catch(() => []);
      if (ids.includes(startChassis)) {
        // preselected module: open straight into that ECU (preloads menu/layout)
        if (startEcu) {
          const [sgbd, code, label] = startEcu.split('|');
          if (sgbd) { await showEcu(startChassis, dispChassis(startChassis), { sgbd, code, label }); return; }
        }
        if (inpaMode()) showScriptSelection(startChassis); else showSections(startChassis);
        return;
      }
    }
    await showChassis();
  };

  // splash stays up until the engine answers (or the wait gives up)
  const start = async () => {
    const splashStart = Date.now();
    splashStatus('starting engine');
    if (!(await waitForEngine())) {
      splashStatus('engine did not start');
      dismissSplash();
      startStatusPolling(); // keeps the LED honest and notices a late engine
      view.innerHTML = errorBlock('engine failed to start', 'red') +
        `<div style="text-align:center"><button class="btn primary" id="boot-retry">Retry</button></div>`;
      sbLeft.textContent = 'engine offline';
      const retry = () => {
        view.innerHTML = `<div class="empty"><span class="loader"></span><span>Waiting for the engine…</span></div>`;
        start();
      };
      document.getElementById('boot-retry').onclick = retry;
      setActions([{ key: '1', label: 'Retry', kind: 'primary', fn: retry }]);
      return;
    }
    splashStatus('connecting to interface');
    await pollCable();
    startStatusPolling();
    // hold the splash briefly so it never just flickers
    const minMs = 1100;
    const wait = Math.max(0, minMs - (Date.now() - splashStart));
    setTimeout(() => {
      dismissSplash();
      maybeOfferTutorial(); // one-time, first boot only
    }, wait);
    openStart().catch(e => {
      view.innerHTML = errorBlock(e.message, 'red');
      sbLeft.textContent = 'failed';
    });
  };
  start();
})();
