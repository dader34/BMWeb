// settings, connection status, boot + wiring
let lastScreen = showChassis; // where to return to when leaving settings

function showSettings() {
  if (typeof cancelSweep === 'function') cancelSweep(); // stop a running sweep
  setCrumbs([{ label: 'Vehicles', fn: showChassis }, { label: 'Settings' }]);
  sbLeft.textContent = 'settings';
  view.innerHTML = head('Preferences', 'Settings', `Configure how ${APP_NAME} displays diagnostics.`);

  const wrap = document.createElement('div');
  // INPA laid its options out the same way it laid out everything else: a
  // monospace list, one per line, no cards. The rows are identical either
  // way; only the presentation changes, so this is a class rather than a
  // second copy of the screen.
  wrap.className = inpaMode() ? 'settings-list inpa-settings'
                             : 'settings-list stagger';

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
    // re-render in place: this screen is itself laid out differently per mode
    (v) => { Settings.set('inpaScreens', v); showSettings(); },
  ));

  // which hardware moves the bytes. The bus is chosen at page load, so
  // switching reloads.
  wrap.appendChild(settingRow(
    'Adapter',
    IS_WEB
      ? 'K+DCAN USB cable over Web Serial, or the THOR WiFi dongle through its local bridge (node thor_bridge.js, shipped with this build).'
      : 'K+DCAN USB cable, or the THOR WiFi dongle over its own WiFi network (join Thor_Wifi first).',
    [
      { val: 'kdcan', label: 'K+DCAN (USB)' },
      { val: 'thor', label: 'THOR (WiFi)' },
    ],
    Settings.get('adapter', 'kdcan'),
    (v) => { Settings.set('adapter', v); location.reload(); },
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

  // demo mode: walk the screens with no car attached. values are synthesized
  // from each job's declared results and badged, never presented as real.
  wrap.appendChild(settingRow(
    'Demo mode (no cable)',
    'Fill live screens with sample values when no cable is connected, so the layouts can be explored. Readings are simulated, not from a car.',
    [
      { val: 'on', label: 'On' },
      { val: 'off', label: 'Off' },
    ],
    Settings.get('demo', 'off'),
    (v) => Settings.set('demo', v),
  ));

  // actuator tests decoded from the .IPO. Off by default: these drive real
  // components, and unlike a read there is no safe way to try one and see.
  // INPA itself asks for no confirmation -- pressing the key sends the job --
  // so when this is on the app behaves the same way.
  wrap.appendChild(settingRow(
    'Confirm actuator tests',
    'Ask before firing activations',
    [
      { val: 'on', label: 'Ask first' },
      { val: 'off', label: 'Send immediately (like INPA)' },
    ],
    Settings.get('confirmActuators', 'on'),
    (v) => Settings.set('confirmActuators', v),
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

  // "How it works" — explainer of what the app does and which BMW software/data
  // it draws from (EDIABAS, SGBDs, INPA screens, the ISTA fault database).
  const hiwRow = document.createElement('div');
  hiwRow.className = 'setting-row tour-setting';
  hiwRow.innerHTML = `
    <div class="setting-text">
      <div class="setting-title">How it works</div>
      <div class="setting-desc">A quick guided demo of what ${APP_NAME} does and the BMW software it uses.</div>
    </div>`;
  const hiwBtn = document.createElement('button');
  hiwBtn.className = 'btn';
  hiwBtn.textContent = 'How it works';
  hiwBtn.onclick = () => showHowItWorks();
  hiwRow.appendChild(hiwBtn);
  wrap.appendChild(hiwRow);

  // Offline copy: zip the app plus a car's data, in the browser.
  //
  // Fault text is always included: without it a code reads as a bare hex
  // number, which is the one thing an offline copy is least able to look up.
  // "All chassis" is offered but warned about -- it is the whole ~200 MB site
  // held in a tab as one Blob, which not every machine will manage.
  if (typeof offlineExport === 'function') {
    let pickVal = 'E46';
    const opts = [{ val: '*', label: 'All chassis (large)' }];
    const combo = settingCombo(
      'Download offline copy',
      'A folder that runs with no internet. Includes fault descriptions.',
      opts, pickVal, (v) => { pickVal = v; });
    const goBtn = document.createElement('button');
    goBtn.className = 'btn';
    goBtn.textContent = 'Download';
    goBtn.style.marginLeft = '8px';
    combo.el.querySelector('.combo').after(goBtn);
    api('/api/chassis').then((ids) => {
      combo.setOptions(
        [{ val: '*', label: 'All chassis (large)' }]
          .concat(ids.map(id => ({ val: id, label: id }))),
        pickVal);
    }).catch(() => { goBtn.disabled = true; });
    goBtn.onclick = async () => {
      const was = goBtn.textContent;
      goBtn.disabled = true;
      try {
        const n = await offlineExport(pickVal, true,
                                      (t) => { goBtn.textContent = t; });
        goBtn.textContent = `${(n / 1048576).toFixed(0)} MB saved`;
      } catch (e) {
        goBtn.textContent = `failed: ${e.message}`;
      }
      setTimeout(() => { goBtn.textContent = was; goBtn.disabled = false; },
                 5000);
    };
    wrap.appendChild(combo.el);
  }

  view.appendChild(wrap);

  // version footer
  const ver = document.createElement('div');
  ver.className = 'settings-version';
  ver.textContent = `${APP_NAME} ${(window.bmacw && window.bmacw.version) ? 'v' + window.bmacw.version : ''}`.trim();
  view.appendChild(ver);

  stagger(wrap, 40);

  // INPA mode: the rows as the Hauptmenue draws its keys -- a vertical
  // < F n > list down the left edge, shift-spelled past nine, the way every
  // ECU home screen reads. The whole row presses like a key: toggles cycle
  // to their next option, the Skin row cycles themes, pickers open, buttons
  // fire. Clicks on the controls themselves keep their own behavior.
  if (inpaMode()) {
    const activate = (row) => {
      const seg = [...row.querySelectorAll('.seg-btn')];
      if (seg.length) {
        const i = seg.findIndex(b => b.classList.contains('active'));
        return seg[(i + 1) % seg.length].click();
      }
      const cards = [...row.querySelectorAll('.theme-card')];
      if (cards.length) {
        const i = cards.findIndex(c => c.classList.contains('active'));
        return cards[(i + 1) % cards.length].click();
      }
      const btn = row.querySelector('.combo-btn, .btn');
      if (btn) btn.click();
    };
    [...wrap.children].forEach((row, i) => {
      const shift = i >= FKEY_SLOTS;
      const n = shift ? i - FKEY_SLOTS + 1 : i + 1;
      if (n > FKEY_SLOTS) return;
      const tag = document.createElement('span');
      tag.className = 'inpa-fn-key';
      tag.innerHTML = shift ? `&lt; Shift &gt; + &lt; F${n} &gt;`
                            : `&lt; F${n} &gt;`;
      row.prepend(tag);
      row.onclick = (e) => {
        if (e.target.closest('button, .combo')) return;
        activate(row);
      };
    });
  }

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
  // custom window controls (frameless window for Aero; removed by index.html
  // on the web, where they drive nothing)
  if (window.bmacw) {
    document.getElementById('win-close').onclick = () => window.bmacw.winClose();
    document.getElementById('win-min').onclick = () => window.bmacw.winMinimize();
    document.getElementById('win-zoom').onclick = () => window.bmacw.winZoom();
  }

  // The status chip IS the connect control, in both hosts. Web Serial
  // refuses to show its port picker outside a user gesture, so a click has
  // to start it; the same click toggles the THOR WiFi bus (native TCP in
  // the app, the local bridge in a browser) or the app's own serial port.
  if (window.webBus) {
    const chip = document.getElementById('link-status');
    chip.style.cursor = 'pointer';
    chip.title = 'Connect / disconnect the adapter';
    chip.onclick = async () => {
      try {
        if (webBus.connected) {
          await webBus.disconnect();
        } else {
          linkText.textContent = 'connecting…';
          await webBus.connect();
        }
      } catch (e) {
        led.className = 'led off';
        linkText.textContent = e.message;
        return;
      }
      lastStatePoll = 0;         // show battery/ignition now, not in 12 s
      await refreshStatus();
    };
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
