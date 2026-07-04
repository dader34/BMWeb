// first-run tutorial: a one-time offer dialog, and a coach-mark tour that
// spotlights the app's real controls (connection LED, KL indicators, main
// view, F-key bar, Flashing, Settings). Re-runnable any time from Settings.
//
// the tour root carries the modal-overlay class so the global action-key
// handler (core.js) stands down while it's up; the tour owns Esc/arrows.

// steps are built at start time so they match the active layout mode (classic
// F-key list vs modern cards) and only reference elements that exist.
function tourSteps() {
  const classic = typeof inpaMode === 'function' && inpaMode();
  const steps = [
    {
      sel: '#link-status',
      title: 'Cable & connection',
      body: 'BMacW talks to the car over a K+DCAN USB cable. This LED shows '
          + 'the link state: green when the cable answers, red when it does '
          + 'not. With no cable connected you can still browse every screen '
          + 'offline, so feel free to explore before you plug in.',
    },
    {
      sel: '#kl-state',
      title: 'Battery & ignition',
      body: 'Live battery voltage and ignition state, read from the engine '
          + 'ECU once a cable is connected. If the voltage shows but '
          + 'ignition stays off, turn the key to position 2 before running '
          + 'diagnostics.',
    },
  ];

  if (classic) {
    steps.push(
      {
        sel: '.inpa-vsel',
        title: 'Select your vehicle',
        body: 'Each row is a chassis. Press the function key shown, the '
            + 'matching number key, or click the row. Common models are '
            + 'listed here; everything else lives under "Other models".',
      },
      {
        sel: '#vsel-special',
        title: 'Special tests',
        body: 'Whole-vehicle jobs that scan every module in one pass: a '
            + 'quick error-memory sweep with per-module results, clear '
            + 'buttons, and a PDF report, plus a quick identification scan.',
      },
    );
  } else {
    steps.push({
      sel: '.chassis-grid',
      title: 'Select your vehicle',
      body: 'Click a chassis card to load its control modules, grouped by '
          + 'system: engine, transmission, brakes, body. The number keys '
          + 'jump to common chassis directly.',
    });
  }

  steps.push(
    {
      sel: '#crumbs',
      title: 'Breadcrumbs',
      body: 'Always shows where you are: vehicle, module, screen. Click any '
          + 'part to jump straight back to it.',
    },
    {
      sel: '#view',
      title: 'Inside a module',
      body: 'Every module offers its functions the same way: read the fault '
          + 'memory (with detail, freeze frames, and clear), watch live '
          + 'values as gauge screens generated from factory data, and run '
          + 'actuator tests under Activations. Faults come with plain '
          + 'English descriptions and can be exported as a PDF report.',
    },
    {
      sel: '#view',
      title: 'Live values',
      body: 'Status screens poll the ECU continuously and draw each value '
          + 'as a gauge with a sensible range. Select several values to '
          + 'watch them together, and stream the readings to a CSV file '
          + 'with timestamps for logging drives.',
    },
    {
      sel: '#fkeybar',
      title: 'Function keys',
      body: 'Every action on the current screen has a key: digits select, '
          + 'Esc or Delete goes back. The status line in the corner shows '
          + 'what the app is doing at all times.',
    },
    {
      sel: '#flash-btn',
      title: 'Flashing',
      body: 'Identify the DME, then read or back up its flash regions over '
          + 'the cable. The current stages are read-only, so nothing is '
          + 'ever written to the ECU.',
    },
    {
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
// navigate; the ring and tip track their target on window resize.
async function startTutorial() {
  if (document.querySelector('.tour-overlay')) return; // one tour at a time
  // the tour narrates the home screen, so go there first (a re-run from
  // Settings would otherwise spotlight the wrong screen)
  try { await showChassis(); } catch { /* tour still works on any screen */ }
  const steps = tourSteps().filter(s => document.querySelector(s.sel));
  if (!steps.length) return;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay tour-overlay show';
  overlay.innerHTML = `
    <div class="tour-ring" aria-hidden="true"></div>
    <div class="tour-tip" role="dialog" aria-modal="true">
      <div class="tour-title"></div>
      <div class="tour-body"></div>
      <div class="tour-foot">
        <div class="tour-dots"></div>
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

  dots.innerHTML = steps.map((_, n) =>
    `<span class="tour-dot" data-n="${n}"></span>`).join('');

  function place() {
    const step = steps[i];
    const el = document.querySelector(step.sel);
    if (!el) { next(); return; }
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
    window.removeEventListener('resize', place);
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 160);
  }
  function next() { if (i >= steps.length - 1) { end(); return; } i++; place(); }
  function back() { if (i > 0) { i--; place(); } }

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
  window.addEventListener('resize', place);
  place();
}
