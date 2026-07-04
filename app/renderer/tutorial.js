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
      body: 'BMacW talks to the car over a K+DCAN USB cable. This LED shows '
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
      sel: '#flash-btn',
      title: 'Flashing',
      body: 'Identify the DME, then read or back up its flash regions over '
          + 'the cable. The current stages are read-only, so nothing is '
          + 'ever written to the ECU.',
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
    title: 'Welcome to BMacW',
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
