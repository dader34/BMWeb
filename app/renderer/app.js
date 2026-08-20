// settings, connection status, boot + wiring
let lastScreen = showChassis; // where to return to when leaving settings

function showSettings() {
  if (typeof cancelSweep === 'function') cancelSweep(); // stop a running sweep
  setCrumbs([{ label: 'Vehicles', fn: showChassis }, { label: 'Settings' }]);
  sbLeft.textContent = 'settings';
  view.innerHTML = head('Preferences', 'Settings', `Configure how ${APP_NAME} displays diagnostics.`);

  const wrap = document.createElement('div');
  // same rows in both layouts; only the class (presentation) changes
  wrap.className = inpaMode() ? 'settings-list inpa-settings'
                             : 'settings-list stagger';

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

  // desktop only: inpaMode() forces off below 760px, so the toggle would do nothing there
  if (!window.matchMedia('(max-width: 760px)').matches) {
    wrap.appendChild(settingRow(
      'INPA-style screens',
      'Lay out the ECU menu and fault memory exactly like the original INPA frontend.',
      [
        { val: 'on', label: 'INPA layout' },
        { val: 'off', label: 'Modern' },
      ],
      Settings.get('inpaScreens', 'off'),
      // re-render: this screen is itself laid out differently per mode
      (v) => { Settings.set('inpaScreens', v); showSettings(); },
    ));
  }

  // bus is chosen at page load, so switching adapters reloads
  const adapterRow = settingRow(
    'Adapter',
    'K+DCAN over serial, or THOR WiFi adapter.',
    [
      { val: 'kdcan', label: 'K+DCAN' },
      { val: 'thor', label: 'THOR' },
    ],
    Settings.get('adapter', 'kdcan'),
    async (v) => {
      Settings.set('adapter', v);
      // join the adapter's network before the reload auto-connects; shell opens the Wi-Fi picker if it can't
      if (v === 'thor' && window.bmacw && window.bmacw.wifiJoin) {
        sbLeft.textContent = 'joining Thor_Wifi…';
        try { await window.bmacw.wifiJoin('Thor_Wifi'); }
        catch { /* the picker is open; the chip retries the connect */ }
      }
      // await the durable save: Settings.set fires it un-awaited, and a reload that wins the race boots from OLD settings
      if (window.bmacw && window.bmacw.saveSettings) {
        try { await window.bmacw.saveSettings(JSON.stringify(Settings.data)); }
        catch { /* localStorage still carries it for this session */ }
      }
      location.reload();
    },
  );
  wrap.appendChild(adapterRow);

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

  // demo values are synthesized and badged, never presented as real
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

  // actuator tests drive real components; confirm defaults ON. Off = INPA behavior (key press sends the job, no prompt).
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

  const startRow = settingCombo(
    'Startup vehicle',
    'Skip the chassis picker and open this vehicle when the app starts.',
    [{ val: '', label: 'Ask each time' }], // filled from /api/chassis below
    Settings.get('startChassis', ''),
    (v) => { Settings.set('startChassis', v); loadStartEcus(v); },
  );
  wrap.appendChild(startRow.el);

  const ecuRow = settingCombo(
    'Startup module',
    'Also open this module of the startup vehicle, preloading it. Needs a startup vehicle.',
    [{ val: '', label: 'None' }],
    Settings.get('startEcu', ''),
    (v) => Settings.set('startEcu', v),
  );
  wrap.appendChild(ecuRow.el);

  // value encodes sgbd|code|label so boot can open the ECU without re-fetching
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

  // hidden in an offline copy (exporters need sibling files a single-file copy lacks) and in the native app (already installed)
  const isOfflineCopy = typeof window.BMACW_INLINE === 'object'
    && window.BMACW_INLINE !== null;
  const isNativeApp = typeof window.bmacw === 'object' && window.bmacw !== null;
  if (!isOfflineCopy && !isNativeApp && typeof offlineExport === 'function') {
    let pickVal = 'E46';
    const opts = [{ val: '*', label: 'All chassis (large)' }];
    const combo = settingCombo(
      'Download offline copy',
      'Runs with no internet. \u201cFolder\u201d unzips to a folder \u2014 right for a computer. '
      + '\u201cSingle file\u201d is one .html that taps open \u2014 the one to use on a phone, '
      + 'and the only way to reach a THOR adapter from iOS.',
      opts, pickVal, (v) => { pickVal = v; });
    // wiring adds 2-24 MB/car and not every car has it; checked by default
    const wireLabel = document.createElement('label');
    wireLabel.className = 'setting-check';
    wireLabel.title = 'Include BMW’s wiring diagrams for the selected vehicle';
    wireLabel.innerHTML = `<input type="checkbox" id="offline-wiring" checked>`
      + `<span>Wiring diagrams</span>`;
    const wireBox = wireLabel.querySelector('input');

    const goBtn = document.createElement('button');
    goBtn.className = 'btn';
    goBtn.textContent = 'Folder (.zip)';

    // THE PHONE BUTTON. A zip is useless on iOS -- it cannot be unpacked and
    // its index.html opened -- so the single-file build exists for exactly this
    // (offlineSingleFile, "ONE FILE, EVERY PLATFORM"). It had no button, only a
    // console call, which meant the one export a phone can use was unreachable
    // from the phone. Wiring is never included here: 72 MB for an E46 is not a
    // file you AirDrop.
    const oneBtn = document.createElement('button');
    oneBtn.className = 'btn';
    oneBtn.textContent = 'Single file (.html)';
    oneBtn.title = 'One .html with everything inside — the one to use on a phone';

    // group into ONE cell: the INPA layout's fixed columns spilled a third control onto its own line
    const picker = combo.el.querySelector('.combo');
    const controls = document.createElement('div');
    controls.className = 'setting-controls';
    picker.replaceWith(controls);
    controls.append(picker, wireLabel, goBtn, oneBtn);
    tipify(controls);
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
                                      (t) => { goBtn.textContent = t; },
                                      wireBox.checked);
        goBtn.textContent = `${(n / 1048576).toFixed(0)} MB saved`;
      } catch (e) {
        goBtn.textContent = `failed: ${e.message}`;
      }
      setTimeout(() => { goBtn.textContent = was; goBtn.disabled = false; },
                 5000);
    };
    oneBtn.onclick = async () => {
      if (typeof offlineSingleFile !== 'function') {
        oneBtn.textContent = 'unavailable'; return;
      }
      const was = oneBtn.textContent;
      oneBtn.disabled = true;
      try {
        const n = await offlineSingleFile(pickVal, true,
                                          (t) => { oneBtn.textContent = t; });
        oneBtn.textContent = `${(n / 1048576).toFixed(0)} MB saved`;
      } catch (e) {
        oneBtn.textContent = `failed: ${e.message}`;
      }
      setTimeout(() => { oneBtn.textContent = was; oneBtn.disabled = false; },
                 5000);
    };
    wrap.appendChild(combo.el);

    // Full-dataset bundles: too big to zip in the browser like the per-car copy
    // above, so these are pre-built .tar.zst archives hosted on Hugging Face.
    // Each is the same dist-web/ tree (drop it behind any static server, or
    // open index.html); sizes are shown so the choice is informed. The full
    // catalogue is the whole thing; ETK / WDS are the two heavy datasets alone.
    const BUNDLE_BASE =
      'https://huggingface.co/datasets/CraigFf/bmweb-etk/resolve/main/bundles/';
    const bundles = [
      { file: 'bmweb-full-catalogue.tar.zst', name: 'Full catalogue',
        size: '7.0 GB', desc: 'The whole app offline: every chassis, parts, wiring, faults, diagnostics.' },
      { file: 'bmweb-etk-all.tar.zst', name: 'Parts catalogue (ETK), all chassis',
        size: '5.8 GB', desc: 'Every chassis’ part diagrams and numbers.' },
      { file: 'bmweb-wds-all.tar.zst', name: 'Wiring diagrams (WDS), all chassis',
        size: '1.1 GB', desc: 'BMW’s schematics for every covered chassis.' },
    ];
    const bRow = document.createElement('div');
    bRow.className = 'setting-row offline-bundles-row';
    bRow.innerHTML = `
      <div class="setting-text">
        <div class="setting-title">Full offline datasets</div>
        <div class="setting-desc">Pre-built archives (drop the folder behind any
          static server, or open index.html). Large — pick by size.</div>
      </div>
      <div class="offline-bundles">${bundles.map((b) => `
        <a class="offline-bundle" href="${BUNDLE_BASE}${b.file}" download
           title="${b.desc}">
          <span class="offline-bundle-name">${b.name}</span>
          <span class="offline-bundle-size">${b.size}</span>
        </a>`).join('')}</div>`;
    wrap.appendChild(bRow);
    tipify(bRow);
  }

  view.appendChild(wrap);

  const ver = document.createElement('div');
  ver.className = 'settings-version';
  ver.textContent = `${APP_NAME} ${(window.bmacw && window.bmacw.version) ? 'v' + window.bmacw.version : ''}`.trim();
  view.appendChild(ver);

  stagger(wrap, 40);

  // INPA mode: prefix each row with a < Fn > key (shift-spelled past nine) and make
  // the whole row press like one -- toggles/themes cycle, pickers open, buttons fire; clicks on controls keep their own behavior
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

// searchable dropdown for long option lists; returns { el, setOptions(options, current) }
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
// Battery (KL30) + Ignition (KL15) refs at module scope: nav.js syncVselState mirrors them into its own KL display
const batLed = document.getElementById('bat-led');
const batVal = document.getElementById('bat-val');
const ignLed = document.getElementById('ign-led');
const ignVal = document.getElementById('ign-val');

// Connection-status poller. Paints #led (host/cable) fast, and KL30/KL15
// (battery+ignition, a real DME transaction) slowly. Driven via refresh()/start().
class StatusPoller {
  constructor() {
    this.engineUp = false;
    this.lastStatePoll = 0;
    this.timer = null;
  }

  async _pollEngine() {
    try { await api('/api/health'); this.engineUp = true; }
    catch { this.engineUp = false; }
  }

  async _pollCable() {
    if (!this.engineUp) {
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

  async _pollState(port) {
    if (!this.engineUp || !port || flashing) {
      // during a flash, leave the last reading and skip the bus
      if (!flashing) { batLed.className = 'kl-led off'; batVal.textContent = '-'; ignLed.className = 'kl-led off'; ignVal.textContent = '-'; }
      return;
    }
    try {
      const s = await api('/api/state' + (stateSgbd ? `?sgbd=${encodeURIComponent(stateSgbd)}` : ''));
      if (s.battery != null) {
        batLed.className = 'kl-led on';
        // on/off, like INPA's own start screen -- it shows a lamp and the word,
        // never a number. A measured voltage would be worth printing; the value
        // we have for a sense-less adapter is UTILITY's nominal, so showing it
        // would read as a measurement it isn't.
        batVal.textContent = 'on';
      } else { batLed.className = 'kl-led off'; batVal.textContent = 'off'; }
      const klEl = document.getElementById('kl-state');
      if (klEl && s.detail) klEl.title = s.detail;
      if (s.ignition === true) { ignLed.className = 'kl-led on'; ignVal.textContent = 'on'; }
      else if (s.ignition === false) { ignLed.className = 'kl-led off'; ignVal.textContent = 'off'; }
      else { ignLed.className = 'kl-led off'; ignVal.textContent = '-'; }
    } catch {
      batLed.className = 'kl-led off'; batVal.textContent = '-';
      ignLed.className = 'kl-led off'; ignVal.textContent = '-';
    }
  }

  // poll battery/ignition slowly (~12s) and only with a cable: hammering the DME collides with other reads and can wake/sleep the bus
  async refresh() {
    await this._pollEngine();
    const port = await this._pollCable();
    const now = Date.now();
    if (port && now - this.lastStatePoll > 12000) {
      this.lastStatePoll = now;
      await this._pollState(port);
      if (typeof syncVselState === 'function') syncVselState();
    } else if (!port) {
      await this._pollState(null); // clear the indicators when unplugged
      if (typeof syncVselState === 'function') syncVselState();
    }
  }

  start() {
    if (this.timer == null) this.timer = setInterval(() => this.refresh(), 3000);
  }
  stop() {
    if (this.timer != null) { clearInterval(this.timer); this.timer = null; }
  }
}

const statusPoller = new StatusPoller();

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

// pause polling while the window is hidden
document.addEventListener('visibilitychange', () => {
  if (document.hidden) statusPoller.stop();
  else { statusPoller.refresh(); statusPoller.start(); }
});

// wait for the sidecar health endpoint (300ms poll, up to 30s) behind the boot splash
async function waitForEngine() {
  for (let i = 0; i < 100; i++) {
    await statusPoller._pollEngine();
    if (statusPoller.engineUp) return true;
    if (i === 8) splashStatus('warming up the engine');
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

// a boot throw must drop the splash and show the error, not hang on "starting engine"
function bootFail(e) {
  dismissSplash();
  view.innerHTML = errorBlock((e && e.message) || String(e), 'red');
  sbLeft.textContent = 'boot failed';
}

// iOS large-title collapse (mobile only): show the title in the nav bar once it scrolls off.
// Re-armed on every render because each screen replaces its own .title node.
function armNavCollapse() {
  if (!window.matchMedia || !window.matchMedia('(max-width: 760px)').matches) {
    document.body.classList.remove('nav-collapsed');
    return;
  }
  const view = document.getElementById('view');
  const nameEl = document.querySelector('.brand-name');
  const titleEl = view && view.querySelector('.screen-head .title');
  if (nameEl) nameEl.dataset.navTitle = titleEl ? titleEl.textContent : 'BMWeb';
  document.body.classList.remove('nav-collapsed');
  if (window._navCollapseObs) window._navCollapseObs.disconnect();
  if (!titleEl || !('IntersectionObserver' in window)) return;
  window._navCollapseObs = new IntersectionObserver(([e]) => {
    document.body.classList.toggle('nav-collapsed', !e.isIntersecting);
  }, { rootMargin: '-6px 0px 0px 0px', threshold: 0 });
  window._navCollapseObs.observe(titleEl);
}

// Mobile bottom bar: the KL/cable nodes are MOVED here (not duplicated) so the by-id updaters keep driving them. No-op on desktop.
function setupMobileTabbar() {
  const isMobile = window.matchMedia
    && window.matchMedia('(max-width: 760px)').matches;
  const host = document.getElementById('mtab-status');
  if (!host) return;
  const cars = document.getElementById('mtab-cars');
  const gear = document.getElementById('mtab-settings');
  if (cars) cars.onclick = () => (typeof showChassis === 'function'
    ? showChassis() : null);
  if (gear) gear.onclick = () => (typeof showSettings === 'function'
    ? showSettings() : null);
  const kl = document.getElementById('kl-state');
  const cable = document.getElementById('link-status');
  if (isMobile) {
    if (kl && kl.parentElement !== host) host.appendChild(kl);
    if (cable && cable.parentElement !== host) host.appendChild(cable);
  } else {
    // restore to the top bar if the viewport grew past the breakpoint
    const right = document.querySelector('.topbar-right');
    if (right && kl && kl.parentElement === host) right.prepend(kl);
    if (right && cable && cable.parentElement === host) {
      const btn = document.getElementById('settings-btn');
      right.insertBefore(cable, btn);
    }
  }
}

(async function boot() {
  document.getElementById('settings-btn').onclick = showSettings;
  tipify(document.querySelector('.topbar'));
  setupMobileTabbar();
  window.addEventListener('resize', setupMobileTabbar);
  // re-arm the large-title collapse whenever a screen swaps its content
  const _view = document.getElementById('view');
  if (_view && 'MutationObserver' in window) {
    new MutationObserver(() => armNavCollapse())
      .observe(_view, { childList: true });
  }
  // custom window controls: absent on web and on Win/Linux (their own titlebar), so
  // guard on the element too -- checking only window.bmacw threw on null and killed boot behind the splash
  const winClose = document.getElementById('win-close');
  if (window.bmacw && winClose) {
    winClose.onclick = () => window.bmacw.winClose();
    document.getElementById('win-min').onclick = () => window.bmacw.winMinimize();
    document.getElementById('win-zoom').onclick = () => window.bmacw.winZoom();
  }

  // the status chip IS the connect control: Web Serial refuses its port picker outside a user gesture, so a click must start it
  if (window.webBus) {
    const chip = document.getElementById('link-status');
    chip.style.cursor = 'pointer';
    chip.title = 'Click to connect or disconnect the adapter';
    chip.onclick = async () => {
      try {
        if (webBus.connected) {
          await webBus.disconnect();
        } else {
          // THOR: join its network first
          if (webBus.readState && window.bmacw && window.bmacw.wifiJoin) {
            linkText.textContent = 'joining Thor_Wifi…';
            try { await window.bmacw.wifiJoin('Thor_Wifi'); }
            catch { /* picker opened; connect below still gets its say */ }
          }
          linkText.textContent = 'connecting…';
          await webBus.connect();
        }
      } catch (e) {
        led.className = 'led off';
        linkText.textContent = e.message;
        return;
      }
      statusPoller.lastStatePoll = 0;   // show battery/ignition now, not in 12 s
      await statusPoller.refresh();
    };

    // THOR needs no user gesture (a socket, not a port picker), so connect on load
    if (webBus.readState && !webBus.connected) {
      linkText.textContent = 'connecting…';
      webBus.connect()
        .then(() => { statusPoller.lastStatePoll = 0; return statusPoller.refresh(); })
        .catch((e) => { led.className = 'led off'; linkText.textContent = e.message; });
    }
  }

  // enable hash routing for the Apps section (linkable pages + Back button)
  if (typeof installRouter === 'function') installRouter();
  // route Cmd/Ctrl+P to the active screen's clean print (see core/print.js)
  if (typeof installPrintHotkey === 'function') installPrintHotkey();

  // jump straight to a preselected startup vehicle (and module), else the picker
  const startChassis = Settings.get('startChassis', '');
  const startEcu = Settings.get('startEcu', '');
  const openStart = async () => {
    // a deep link (#apps, #apps/parts, ...) wins over the startup-vehicle pref
    if (typeof routeApplyHash === 'function' && routeApplyHash()) return;
    if (startChassis) {
      const ids = await api('/api/chassis').catch(() => []);
      if (ids.includes(startChassis)) {
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

  const start = async () => {
    const splashStart = Date.now();
    splashStatus('starting engine');
    if (!(await waitForEngine())) {
      splashStatus('engine did not start');
      dismissSplash();
      statusPoller.start(); // keeps the LED honest and notices a late engine
      view.innerHTML = errorBlock('engine failed to start', 'red') +
        `<div style="text-align:center"><button class="btn primary" id="boot-retry">Retry</button></div>`;
      sbLeft.textContent = 'engine offline';
      const retry = () => {
        view.innerHTML = `<div class="empty"><span class="loader"></span><span>Waiting for the engine…</span></div>`;
        start().catch(bootFail);
      };
      document.getElementById('boot-retry').onclick = retry;
      setActions([{ key: '1', label: 'Retry', kind: 'primary', fn: retry }]);
      return;
    }
    splashStatus('connecting to interface');
    await statusPoller._pollCable();
    statusPoller.start();
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
  start().catch(bootFail);
})().catch(bootFail);
