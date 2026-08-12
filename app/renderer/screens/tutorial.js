// first-run tutorial: a one-time offer dialog, and a coach-mark tour that
// spotlights the app's real controls and walks into a real module along the
// way. Re-runnable any time from Settings.
//
// the tour root carries the modal-overlay class so the global action-key
// handler (core.js) stands down while it's up; the tour owns Esc/arrows.
// steps may live on different screens: each declares `screen`, and the tour
// navigates (home = vehicle picker, module = a real ECU opened offline)
// whenever the step's screen differs from the current one.

// open the tour's demo module: the E46 engine ECU, which renders fully
// offline (menu, layouts, fault screen). falls back to the first module of
// the first section when the expected one is missing.
async function openTourModule() {
  const ch = await api('/api/chassis/E46');
  const sec = ch.sections.find(s => /engine|motor/i.test(s.name)) || ch.sections[0];
  const ecu = sec.ecus.find(e => /ms45/i.test(e.sgbd)) || sec.ecus[0];
  await showEcu('E46', sec.name, ecu);
}

const TOUR_SCREENS = {
  home: () => showChassis(),
  module: () => openTourModule(),
};

// steps are built at start time so they match the active layout mode (classic
// F-key list vs modern cards) and only reference elements that exist.
function tourSteps() {
  const classic = typeof inpaMode === 'function' && inpaMode();
  const steps = [
    {
      screen: 'home',
      sel: '#link-status',
      title: 'Cable & connection',
      body: APP_NAME + ' talks to the car over a K+DCAN USB cable. This LED shows '
          + 'the link state: green when the cable answers, red when it does '
          + 'not. With no cable connected you can still browse every screen '
          + 'offline, so feel free to explore before you plug in.',
    },
    {
      screen: 'home',
      sel: '#kl-state',
      title: 'Battery & ignition',
      body: 'Live battery voltage and ignition state, read from the engine '
          + 'ECU once a cable is connected. If the voltage shows but '
          + 'ignition stays off, turn the key to position 2 before running '
          + 'diagnostics.',
    },
    classic ? {
      screen: 'home',
      sel: '.inpa-vsel',
      title: 'Select your vehicle',
      body: 'Each row is a chassis. Press the function key shown, the '
          + 'matching number key, or click the row. Common models are '
          + 'listed here; everything else lives under "Other models".',
    } : {
      screen: 'home',
      sel: '.chassis-grid',
      title: 'Select your vehicle',
      body: 'Click a chassis card to load its control modules, grouped by '
          + 'system: engine, transmission, brakes, body. The number keys '
          + 'jump to common chassis directly.',
    },
  ];
  steps.push(
    {
      screen: 'module',
      sel: '.inpa-haupt, .group-grid',
      title: 'Inside a module',
      body: 'This is a real module: the E46 engine ECU. Its functions are '
          + 'grouped the way the factory tool groups them. Fault memory '
          + 'reads codes with plain English descriptions, detail, freeze '
          + 'frames, and clear; Status screens show live values; '
          + 'Activations run actuator tests.',
    },
    {
      screen: 'module',
      sel: '.breadcrumbs',
      title: 'Breadcrumbs',
      body: 'Always shows where you are: vehicle, module, screen. Click any '
          + 'part to jump straight back to it.',
    },
    {
      screen: 'module',
      sel: '#fkeybar',
      title: 'Function keys',
      body: 'Every action on the current screen has a key: digits select, '
          + 'Esc or Delete goes back. The status line in the corner shows '
          + 'what the app is doing at all times. Live values poll '
          + 'continuously as gauges, and several can be watched together '
          + 'or streamed to a CSV file with timestamps.',
    },
    {
      screen: 'module',
      sel: '#settings-btn',
      title: 'Make it yours',
      body: 'Pick a theme, switch between classic and modern screen '
          + 'layouts, choose English or original EDIABAS labels, enable '
          + 'auto-scan on open, set a startup vehicle, and replay this '
          + 'tour, any time, from Settings.',
    },
  );
  return steps;
}

// one-time offer on first boot. whatever the answer, never ask again
// (re-runnable from Settings). easily dismissed: Esc / Not now / backdrop.
async function maybeOfferTutorial() {
  if (Settings.get('tutorialSeen', 'no') === 'yes') return;
  Settings.set('tutorialSeen', 'yes');
  const go = await confirmDialog({
    title: `Welcome to ${APP_NAME}`,
    body: 'Would you like to walk through the tutorial? It takes under a '
        + 'minute and shows where everything lives.',
    confirmLabel: 'Take the tour',
    cancelLabel: 'Not now',
  });
  if (go) startTutorial();
}

// spotlight tour over the live UI. Esc/Skip ends it; ←/→ and the buttons
// navigate (crossing screens when the step calls for it); the ring and tip
// track their target on window resize. Ends back on the vehicle screen.
async function startTutorial() {
  if (document.querySelector('.tour-overlay')) return; // one tour at a time
  const steps = tourSteps();
  let currentScreen = null;
  let navigating = false;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay tour-overlay show';
  overlay.innerHTML = `
    <div class="tour-ring" aria-hidden="true"></div>
    <div class="tour-tip" role="dialog" aria-modal="true">
      <div class="tour-title"></div>
      <div class="tour-body"></div>
      <div class="tour-foot">
        <div class="tour-dots">${steps.map((_, n) =>
          `<span class="tour-dot" data-n="${n}"></span>`).join('')}</div>
        <div class="tour-btns">
          <button class="btn tour-skip">Skip</button>
          <button class="btn tour-back">Back</button>
          <button class="btn primary tour-next">Next</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const ring = overlay.querySelector('.tour-ring');
  const tip = overlay.querySelector('.tour-tip');
  const dots = overlay.querySelector('.tour-dots');
  const backBtn = overlay.querySelector('.tour-back');
  const nextBtn = overlay.querySelector('.tour-next');
  let i = 0;

  // enter step n (dir = which way to keep moving when a target is missing),
  // navigating between screens when the step lives elsewhere
  async function show(n, dir = 1) {
    if (navigating) return;
    while (n >= 0 && n < steps.length) {
      const step = steps[n];
      if (step.screen && step.screen !== currentScreen) {
        navigating = true;
        try { await TOUR_SCREENS[step.screen](); currentScreen = step.screen; }
        catch { /* screen unavailable: skip past this step */ }
        navigating = false;
      }
      if (document.querySelector(step.sel)) { i = n; place(); return; }
      n += dir; // target missing in this mode/screen: keep moving
    }
    end();
  }

  function place() {
    const step = steps[i];
    const el = document.querySelector(step.sel);
    if (!el) { show(i + 1, 1); return; }
    const pad = 8;
    const r = el.getBoundingClientRect();
    ring.style.left = `${r.left - pad}px`;
    ring.style.top = `${r.top - pad}px`;
    ring.style.width = `${r.width + pad * 2}px`;
    ring.style.height = `${r.height + pad * 2}px`;

    overlay.querySelector('.tour-title').textContent = step.title;
    overlay.querySelector('.tour-body').textContent = step.body;
    dots.querySelectorAll('.tour-dot').forEach((d, n) =>
      d.classList.toggle('active', n === i));
    backBtn.style.visibility = i === 0 ? 'hidden' : 'visible';
    nextBtn.textContent = i === steps.length - 1 ? 'Done' : 'Next';

    // tip below the target when there's room, else above; clamped to viewport
    tip.style.visibility = 'hidden';
    requestAnimationFrame(() => {
      const t = tip.getBoundingClientRect();
      let top = r.bottom + pad * 2;
      if (top + t.height > innerHeight - 12) top = r.top - t.height - pad * 2;
      top = Math.max(12, Math.min(top, innerHeight - t.height - 12));
      let left = r.left + r.width / 2 - t.width / 2;
      left = Math.max(12, Math.min(left, innerWidth - t.width - 12));
      tip.style.top = `${top}px`;
      tip.style.left = `${left}px`;
      tip.style.visibility = 'visible';
    });
  }

  function end() {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 160);
    // don't leave the user stranded mid-demo: finish on the vehicle screen
    if (currentScreen !== 'home') { try { showChassis(); } catch { } }
  }
  const next = () => { if (i >= steps.length - 1) end(); else show(i + 1, 1); };
  const back = () => { if (i > 0) show(i - 1, -1); };
  const onResize = () => place();

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(); }
    else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); back(); }
  }

  overlay.querySelector('.tour-skip').onclick = end;
  backBtn.onclick = back;
  nextBtn.onclick = next;
  overlay.onclick = (e) => { if (e.target === overlay) end(); };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onResize);
  await show(0, 1);
}

// "How it works": a stepped, centered info walkthrough (not a UI spotlight)
// that explains what BMacW is, how it talks to the car, and which BMW software
// and data it draws from. Esc closes; ←/→ or the buttons page; backdrop closes.
function howItWorksSlides() {
  const ver = (window.bmacw && window.bmacw.version) ? `v${window.bmacw.version}` : '';
  return [
    {
      icon: '🔌',
      title: `What ${APP_NAME} is`,
      body: `A native macOS diagnostics app for BMW ${ver ? '· ' + ver : ''}. It reads `
        + 'fault codes, live values, and control-module data straight from the '
        + 'car, with no Windows, no VM, and no dealer tool. Everything you see here also '
        + 'works fully offline, so you can explore before ever plugging in.',
    },
    {
      icon: '🧰',
      title: 'The cable & the engine',
      body: APP_NAME + ' speaks to the car over a K+DCAN USB cable. Under the hood it '
        + 'runs a native port of BMW’s EDIABAS diagnostic engine, the same '
        + 'protocol layer the factory tools use, so it talks to each ECU in its '
        + 'own language over K-line and D-CAN.',
    },
    {
      icon: '📂',
      title: 'SGBD description files',
      body: 'Each control module is described by an SGBD (.prg) file that defines '
        + 'its jobs, results, and fault tables. ' + APP_NAME + ' ships BMW’s own SGBDs and '
        + 'runs their jobs directly: FS_LESEN to read faults, STATUS_* for live '
        + 'values, etc...',
    },
    {
      icon: '🖥️',
      title: 'INPA screens, decoded',
      body: 'The status pages mirror INPA, BMW’s classic diagnostic frontend. '
        + APP_NAME + ' decodes INPA’s compiled .IPO screen programs to reproduce the '
        + 'exact user interface.',
    },
    {
      icon: '🗂️',
      title: 'Fault database from ISTA',
      body: 'The Fault Lookup screen is built from BMW ISTA’s diagnostic database: '
        + '50,000+ fault codes across the whole fleet, with English descriptions, '
        + 'per-ECU-variant text, and (where BMW defines them) the matching SAE '
        + 'P-codes and full service documents (conditions, service measures, notes).',
    },
  ];
}

function showHowItWorks() {
  if (document.querySelector('.hiw-overlay')) return;
  const slides = howItWorksSlides();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay hiw-overlay show';
  overlay.innerHTML = `
    <div class="hiw-card" role="dialog" aria-modal="true">
      <button class="hiw-close" aria-label="Close">✕</button>
      <div class="hiw-icon"></div>
      <div class="hiw-title"></div>
      <div class="hiw-body"></div>
      <div class="hiw-foot">
        <div class="hiw-dots">${slides.map((_, n) =>
          `<span class="hiw-dot" data-n="${n}"></span>`).join('')}</div>
        <div class="hiw-btns">
          <button class="btn hiw-back">Back</button>
          <button class="btn primary hiw-next">Next</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const iconEl = overlay.querySelector('.hiw-icon');
  const titleEl = overlay.querySelector('.hiw-title');
  const bodyEl = overlay.querySelector('.hiw-body');
  const dots = overlay.querySelectorAll('.hiw-dot');
  const backBtn = overlay.querySelector('.hiw-back');
  const nextBtn = overlay.querySelector('.hiw-next');
  let i = 0;

  const render = () => {
    const s = slides[i];
    iconEl.textContent = s.icon;
    titleEl.textContent = s.title;
    bodyEl.textContent = s.body;
    dots.forEach((d, n) => d.classList.toggle('active', n === i));
    backBtn.disabled = i === 0;
    nextBtn.textContent = i === slides.length - 1 ? 'Done' : 'Next';
  };
  const go = (d) => {
    if (i + d < 0) return;
    if (i + d >= slides.length) return end();
    i += d; render();
  };
  const end = () => {
    overlay.classList.remove('show');
    window.removeEventListener('keydown', onKey, true);
    setTimeout(() => overlay.remove(), 160);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); end(); }
    else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
  };
  backBtn.onclick = () => go(-1);
  nextBtn.onclick = () => go(1);
  overlay.querySelector('.hiw-close').onclick = end;
  overlay.onclick = (e) => { if (e.target === overlay) end(); };
  dots.forEach((d) => d.onclick = () => { i = +d.dataset.n; render(); });
  window.addEventListener('keydown', onKey, true);
  render();
}
