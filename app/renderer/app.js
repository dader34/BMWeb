// settings, connection status, boot + wiring

/**
 * Where to return to when leaving the Settings screen; every screen updates it
 * as it renders.
 * @type {() => (void|Promise<void>)}
 */
let lastScreen = showChassis;

/**
 * Render the Settings screen (skin, language, INPA layout, actuator confirm,
 * beta reports, remote session).
 * @returns {void}
 */
function showSettings() {
  if (typeof cancelSweep === 'function') cancelSweep(); // stop a running sweep
  setCrumbs([{ label: 'Vehicles', fn: showChassis }, { label: 'Settings' }]);
  sbLeft.textContent = 'settings';
  view.innerHTML = head(
    'Preferences',
    'Settings',
    `Configure how ${APP_NAME} displays diagnostics.`
  );

  const wrap = document.createElement('div');
  // same rows in both layouts; only the class (presentation) changes
  wrap.className = inpaMode()
    ? 'settings-list inpa-settings'
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
  THEMES.forEach((t) => {
    const card = document.createElement('button');
    card.className = 'theme-card' + (t.id === cur ? ' active' : '');
    card.dataset.theme = t.id;
    card.innerHTML = `
      <span class="theme-swatch sw-${t.id}"></span>
      <span class="theme-meta"><span class="theme-name">${t.name}</span></span>`;
    card.onclick = () => {
      Settings.set('theme', t.id);
      applyTheme(t.id);
      themeGrid
        .querySelectorAll('.theme-card')
        .forEach((c) => c.classList.toggle('active', c === card));
    };
    themeGrid.appendChild(card);
  });
  themeRow.appendChild(themeGrid);
  wrap.appendChild(themeRow);

  wrap.appendChild(
    settingRow(
      'Function labels',
      'Show translated English names, or the original EDIABAS job names.',
      [
        { val: 'en', label: 'English' },
        { val: 'orig', label: 'Original (EDIABAS)' },
      ],
      lang(),
      (v) => Settings.set('lang', v)
    )
  );

  // desktop only: inpaMode() forces off below 760px, so the toggle would do nothing there
  if (!window.matchMedia('(max-width: 760px)').matches) {
    wrap.appendChild(
      settingRow(
        'INPA-style screens',
        'Lay out the ECU menu and fault memory exactly like the original INPA frontend.',
        [
          { val: 'on', label: 'INPA layout' },
          { val: 'off', label: 'Modern' },
        ],
        Settings.get('inpaScreens', 'on'),
        // re-render: this screen is itself laid out differently per mode
        (v) => {
          Settings.set('inpaScreens', v);
          showSettings();
        }
      )
    );
  }

  // actuator tests drive real components; confirm defaults ON. Off = INPA behavior (key press sends the job, no prompt).
  wrap.appendChild(
    settingRow(
      'Confirm actuator tests',
      'Ask before firing activations',
      [
        { val: 'on', label: 'Ask first' },
        { val: 'off', label: 'Send immediately (like INPA)' },
      ],
      Settings.get('confirmActuators', 'on'),
      (v) => Settings.set('confirmActuators', v)
    )
  );

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

  // beta feedback: the Report button + what a report carries
  const betaRow = document.createElement('div');
  betaRow.className = 'setting-row';
  const betaOn = Settings.get('betaReports', true) !== false;
  betaRow.innerHTML = `
    <div class="setting-text">
      <div class="setting-title">Beta reports</div>
      <div class="setting-desc">The Report button collects this session's
        screens, jobs, wire telegrams and errors into one file. VINs are
        masked.</div>
    </div>
    <div class="setting-btns">
      <button class="btn" id="set-beta-file">File a report…</button>
      <button class="btn" id="set-beta-toggle">${betaOn ? 'On' : 'Off'}</button>
    </div>`;
  betaRow.querySelector('#set-beta-file').onclick = () =>
    typeof showBetaReport === 'function' ? showBetaReport() : null;
  betaRow.querySelector('#set-beta-toggle').onclick = () => {
    Settings.set('betaReports', !betaOn);
    const b = document.getElementById('beta-btn');
    if (b && betaOn) b.remove();
    if (!betaOn && typeof _journalButton === 'function') _journalButton();
    showSettings();
  };
  // a cable another machine is serving (`bmweb gateway`). Not gated on the
  // offline flag: an offline export served over http on a workshop LAN is
  // exactly the case where this works, and the hosted https site is the one
  // where a plain ws:// cannot be opened at all.
  const gwRow = document.createElement('div');
  gwRow.className = 'setting-row';
  const gwNow = Settings.get('gatewayUrl', '');
  gwRow.innerHTML = `
    <div class="setting-text">
      <div class="setting-title">Cable on another machine</div>
      <div class="setting-desc">Drive a K+DCAN cable plugged into a different
        computer, which serves it with <code>bmweb gateway</code>. The car is
        driven from here: only bytes cross. That machine is a plain pipe with
        no gate of its own, so anyone who can reach it can drive the car.
        A page served over http (localhost, an offline copy on your network)
        can use a <code>ws://</code> gateway; this site over https cannot
        (browsers block it as mixed content), so from https only
        <code>wss://</code> works.<br>Now: <b>${esc(gwNow || 'this machine’s own cable')}</b></div>
    </div>
    <div class="setting-btns">
      <button class="btn" id="set-gateway">${gwNow ? 'Change…' : 'Set…'}</button>
      ${gwNow ? '<button class="btn" id="set-gateway-clear">Use this machine</button>' : ''}
    </div>`;
  gwRow.querySelector('#set-gateway').onclick = async () => {
    const v = await inputDialog({
      title: 'Cable on another machine',
      body:
        'The address that machine’s `bmweb gateway` prints, for example ' +
        '192.168.1.9:6801 or ws://192.168.1.9:6801. Leave it empty to use ' +
        'this machine’s own cable.',
      example: '192.168.1.9:6801',
      confirmLabel: 'Use it',
    });
    if (v === null) return;
    Settings.set('gatewayUrl', gatewayWsUrl(v));
    // the cable in hand belongs to the old choice; drop it so the next
    // connect goes where the setting now points
    if (window.webBus && webBus.connected) await webBus.disconnect();
    showSettings();
    if (typeof statusPoller !== 'undefined') statusPoller.refresh();
  };
  const gwClear = gwRow.querySelector('#set-gateway-clear');
  if (gwClear)
    gwClear.onclick = async () => {
      Settings.set('gatewayUrl', '');
      if (window.webBus && webBus.connected) await webBus.disconnect();
      showSettings();
      if (typeof statusPoller !== 'undefined') statusPoller.refresh();
    };
  wrap.appendChild(gwRow);

  // remote diagnostics: share the car, or drive a shared one
  const remoteRow = document.createElement('div');
  remoteRow.className = 'setting-row';
  remoteRow.innerHTML = `
    <div class="setting-text">
      <div class="setting-title">Remote session</div>
      <div class="setting-desc">Share your cabled car with someone, or connect
        to theirs. The car stays on its own machine; only jobs cross, direct
        browser-to-browser.</div>
    </div>
    <button class="btn" id="set-remote">Open…</button>`;
  remoteRow.querySelector('#set-remote').onclick = () =>
    typeof showRemoteDialog === 'function' ? showRemoteDialog() : null;
  // not in the offline builds: a session needs the signaling worker and a
  // peer on the internet, which is what an offline copy is for not having
  if (!(typeof window !== 'undefined' && window.BMACW_OFFLINE)) {
    wrap.appendChild(remoteRow);
  }

  // offline builds have no collector: no beta row (journal.js drops the
  // button and the auto-reports on the same flag)
  if (!(typeof window !== 'undefined' && window.BMACW_OFFLINE)) {
    wrap.appendChild(betaRow);
  }

  view.appendChild(wrap);

  const ver = document.createElement('div');
  ver.className = 'settings-version';
  ver.textContent =
    `${APP_NAME} ${window.bmacw && window.bmacw.version ? 'v' + window.bmacw.version : window.BMACW_VERSION ? 'v' + window.BMACW_VERSION : ''}`.trim();
  view.appendChild(ver);

  stagger(wrap, 40);

  // INPA mode: prefix each row with a < Fn > key (shift-spelled past nine) and make
  // the whole row press like one -- toggles/themes cycle, pickers open, buttons fire; clicks on controls keep their own behavior
  if (inpaMode()) {
    const activate = (row) => {
      const seg = [...row.querySelectorAll('.seg-btn')];
      if (seg.length) {
        const i = seg.findIndex((b) => b.classList.contains('active'));
        return seg[(i + 1) % seg.length].click();
      }
      const cards = [...row.querySelectorAll('.theme-card')];
      if (cards.length) {
        const i = cards.findIndex((c) => c.classList.contains('active'));
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
      tag.innerHTML = shift
        ? `&lt; Shift &gt; + &lt; F${n} &gt;`
        : `&lt; F${n} &gt;`;
      row.prepend(tag);
      row.onclick = (e) => {
        if (e.target.closest('button, .combo')) return;
        activate(row);
      };
    });
  }

  setActions([
    {
      key: 'Escape',
      keyLabel: 'Esc',
      label: 'Back',
      kind: 'back',
      fn: () => lastScreen(),
    },
  ]);
}

/**
 * A segmented-control settings row.
 * @param {string} title - Row title.
 * @param {string} desc - Row description.
 * @param {Array<{val: string, label: string}>} options - The segments.
 * @param {string} current - The currently selected value.
 * @param {(val: string) => void} onChange - Selection callback.
 * @returns {HTMLElement} The row element.
 */
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
  options.forEach((opt) => {
    const b = document.createElement('button');
    b.className = 'seg-btn' + (opt.val === current ? ' active' : '');
    b.textContent = opt.label;
    b.onclick = () => {
      seg
        .querySelectorAll('.seg-btn')
        .forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      onChange(opt.val);
    };
    seg.appendChild(b);
  });
  return row;
}

// ---------- connection status ----------
// Connection-status poller: paints #led (engine/cable). The cable also
// announces itself (the bus fires 'bmweb-cable' on unplug/replug), so the
// chip changes at once rather than on the next tick. Driven via refresh()/start().
/**
 * The topbar connection poller: an engine/cable check painting the chip.
 */
class StatusPoller {
  constructor() {
    /** Whether the diagnostic engine answered its health check. */
    this.engineUp = false;
    /** The poll interval handle. @type {ReturnType<typeof setInterval>|null} */
    this.timer = null;
  }

  /**
   * Ping the engine health endpoint and set `engineUp`.
   * @returns {Promise<void>}
   */
  async _pollEngine() {
    try {
      await api('/api/health');
      this.engineUp = true;
    } catch {
      this.engineUp = false;
    }
  }

  /**
   * Read which cable is attached and paint the status light.
   * @returns {Promise<string|null>} The port, or null when none/offline.
   */
  async _pollCable() {
    if (!this.engineUp) {
      led.className = 'led off';
      linkText.textContent = 'engine offline';
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
      led.className = 'led idle';
      linkText.textContent = 'no cable';
      return null;
    }
  }

  /**
   * One poll cycle: engine, then cable; the INPA start screen's own lamps
   * follow the cable.
   * @returns {Promise<void>}
   */
  async refresh() {
    await this._pollEngine();
    await this._pollCable();
    if (typeof syncVselState === 'function') syncVselState();
  }

  /**
   * Start polling every 3 s (idempotent).
   * @returns {void}
   */
  start() {
    if (this.timer == null)
      this.timer = setInterval(() => this.refresh(), 3000);
  }
  /**
   * Stop polling.
   * @returns {void}
   */
  stop() {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/** The app's one connection poller. */
const statusPoller = new StatusPoller();

/**
 * Fade out and remove the boot splash.
 * @returns {void}
 */
function dismissSplash() {
  const s = document.getElementById('splash');
  if (!s || s.classList.contains('hide')) return;
  s.classList.add('hide');
  setTimeout(() => s.remove(), 600);
}

/**
 * Set the splash status line.
 * @param {string} msg - The message.
 * @returns {void}
 */
function splashStatus(msg) {
  const el = document.getElementById('splash-status');
  if (el) el.textContent = msg;
}

// pause polling while the window is hidden
document.addEventListener('visibilitychange', () => {
  if (document.hidden) statusPoller.stop();
  else {
    statusPoller.refresh();
    statusPoller.start();
  }
});

// wait for the sidecar health endpoint (300ms poll, up to 30s) behind the boot splash
/**
 * Poll the engine health endpoint until it answers or ~30 s elapse.
 * @returns {Promise<boolean>} true once the engine is up, false on timeout.
 */
async function waitForEngine() {
  for (let i = 0; i < 100; i++) {
    await statusPoller._pollEngine();
    if (statusPoller.engineUp) return true;
    if (i === 8) splashStatus('warming up the engine');
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// a boot throw must drop the splash and show the error, not hang on "starting engine"
/**
 * Drop the splash and show a boot error instead of hanging.
 * @param {Error|any} e - The failure.
 * @returns {void}
 */
function bootFail(e) {
  dismissSplash();
  view.innerHTML = errorBlock((e && e.message) || String(e), 'red');
  sbLeft.textContent = 'boot failed';
}

// iOS large-title collapse (mobile only): show the title in the nav bar once it scrolls off.
// Re-armed on every render because each screen replaces its own .title node.
/**
 * Arm the mobile large-title collapse: mirror the screen title into the nav bar
 * once the H1 scrolls off. No-op on desktop.
 * @returns {void}
 */
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
  window._navCollapseObs = new IntersectionObserver(
    ([e]) => {
      document.body.classList.toggle('nav-collapsed', !e.isIntersecting);
    },
    { rootMargin: '-6px 0px 0px 0px', threshold: 0 }
  );
  window._navCollapseObs.observe(titleEl);
}

// Mobile bottom bar: the KL/cable nodes are MOVED here (not duplicated) so the by-id updaters keep driving them. No-op on desktop.
/**
 * Wire the mobile bottom tab bar, moving the KL/cable status nodes into it (and
 * restoring them to the top bar above the breakpoint).
 * @returns {void}
 */
function setupMobileTabbar() {
  const isMobile =
    window.matchMedia && window.matchMedia('(max-width: 760px)').matches;
  const host = document.getElementById('mtab-status');
  if (!host) return;
  const cars = document.getElementById('mtab-cars');
  const gear = document.getElementById('mtab-settings');
  if (cars)
    cars.onclick = () =>
      typeof showChassis === 'function' ? showChassis() : null;
  if (gear)
    gear.onclick = () =>
      typeof showSettings === 'function' ? showSettings() : null;
  const cable = document.getElementById('link-status');
  if (isMobile) {
    if (cable && cable.parentElement !== host) host.appendChild(cable);
  } else {
    // restore to the top bar if the viewport grew past the breakpoint
    const right = document.querySelector('.topbar-right');
    if (right && cable && cable.parentElement === host) {
      const btn = document.getElementById('settings-btn');
      right.insertBefore(cable, btn);
    }
  }
}

/**
 * Boot: wire the topbar, mobile tabbar, router and print hotkey, resolve the
 * offline folder, wait for the engine behind the splash, then open the startup
 * screen (a deep link, a preselected vehicle, or the chassis picker).
 */
(async function boot() {
  document.getElementById('settings-btn').onclick = showSettings;
  tipify(document.querySelector('.topbar'));
  setupMobileTabbar();
  window.addEventListener('resize', setupMobileTabbar);
  // re-arm the large-title collapse whenever a screen swaps its content
  const _view = document.getElementById('view');
  if (_view && 'MutationObserver' in window) {
    new MutationObserver(() => armNavCollapse()).observe(_view, {
      childList: true,
    });
  }
  // custom window controls: absent on web and on Win/Linux (their own titlebar), so
  // guard on the element too -- checking only window.bmacw threw on null and killed boot behind the splash
  const winClose = document.getElementById('win-close');
  if (window.bmacw && winClose) {
    winClose.onclick = () => window.bmacw.winClose();
    document.getElementById('win-min').onclick = () =>
      window.bmacw.winMinimize();
    document.getElementById('win-zoom').onclick = () => window.bmacw.winZoom();
  }

  // the status chip IS the connect control: Web Serial refuses its port picker outside a user gesture, so a click must start it
  if (window.webBus) {
    const chip = document.getElementById('link-status');
    chip.style.cursor = 'pointer';
    chip.title = 'Click to connect or disconnect the cable';
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
      await statusPoller.refresh();
    };

    // KEEP THE CABLE THROUGH A RELOAD, ALWAYS. Web Serial remembers a granted
    // K+DCAN port (getPorts() returns it), so reconnect() reopens it with no
    // picker. It must be reconnect(), never connect(), here: connect() opens
    // the PORT PICKER, a user gesture the browser refuses on page load. The
    // native bridge exposes no reconnect() -- its shell owns the port -- so
    // the chip click is the only entry there.
    // the bus fires this when the port goes away or comes back (Web Serial's
    // own disconnect/connect events), so the chip never claims a cable that
    // was pulled minutes ago
    window.addEventListener('bmweb-cable', () => {
      statusPoller.refresh();
    });
    const canSilentReconnect = typeof webBus.reconnect === 'function';
    if (canSilentReconnect && !webBus.connected) {
      linkText.textContent = 'reconnecting…';
      // A deep link into a module (#car/E46/ms450ds0) renders while this is
      // still in flight; the module view asks /api/port first and, seeing no
      // cable yet, drew the offline screens instead of running the script.
      // Publish the reconnect so a screen can wait for its verdict.
      window.cableReady = webBus
        .reconnect()
        .then((label) => {
          if (!label) {
            linkText.textContent = 'no cable';
            return;
          }
          return statusPoller.refresh();
        })
        .catch(() => {
          linkText.textContent = 'no cable';
        });
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
          if (sgbd) {
            await showEcu(startChassis, dispChassis(startChassis), {
              sgbd,
              code,
              label,
            });
            return;
          }
        }
        if (inpaMode()) showScriptSelection(startChassis);
        else showSections(startChassis);
        return;
      }
    }
    await showChassis();
  };

  const start = async () => {
    const splashStart = Date.now();
    // OFFLINE FOLDER (file:// double-click): resolve the directory handle
    // before the first data read. Restores a remembered folder silently, or
    // shows a one-time picker. A no-op on http(s) and in the native app.
    if (typeof initOfflineFs === 'function') {
      splashStatus('opening offline folder');
      try {
        await initOfflineFs();
      } catch {
        /* fall through; reads will error visibly */
      }
    }
    splashStatus('starting engine');
    if (!(await waitForEngine())) {
      splashStatus('engine did not start');
      dismissSplash();
      statusPoller.start(); // keeps the LED honest and notices a late engine
      view.innerHTML =
        errorBlock('engine failed to start', 'red') +
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
      // resume an owner's share across a reload: re-host the same code and
      // bring the console back (no-op if there was no active share). Offline
      // builds have no remote feature (the Settings row is hidden and a
      // session needs the signaling worker + a peer on the internet), so
      // never re-open a share there.
      if (
        typeof resumeRemoteShare === 'function' &&
        !(typeof window !== 'undefined' && window.BMACW_OFFLINE)
      ) {
        resumeRemoteShare();
      }
    }, wait);
    openStart().catch((e) => {
      view.innerHTML = errorBlock(e.message, 'red');
      sbLeft.textContent = 'failed';
    });
  };
  start().catch(bootFail);
})().catch(bootFail);
