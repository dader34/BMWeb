// first-run tutorial: a one-time offer dialog, and a coach-mark tour that
// spotlights the app's real controls (connection LED, KL indicators, main
// view, F-key bar, Flashing, Settings). Re-runnable any time from Settings.
//
// the tour root carries the modal-overlay class so the global action-key
// handler (core.js) stands down while it's up; the tour owns Esc/arrows.

const TOUR_STEPS = [
  {
    sel: '#link-status',
    title: 'Cable & connection',
    body: 'BMacW talks to the car over a K+DCAN USB cable. This LED shows the '
        + 'link state — with no cable connected you can still browse every '
        + 'screen offline.',
  },
  {
    sel: '#kl-state',
    title: 'Battery & ignition',
    body: 'Live battery voltage (KL30) and ignition state (KL15), read from '
        + 'the engine ECU once a cable is connected — the same indicators '
        + 'INPA shows top of screen.',
  },
  {
    sel: '#view',
    title: 'Vehicles, systems, modules',
    body: 'Pick a chassis, then a system, then a control module. Menus and '
        + 'gauge screens are generated from BMW\'s own INPA definitions, so '
        + 'they match what the factory tool shows.',
  },
  {
    sel: '#fkeybar',
    title: 'Function keys',
    body: 'Every action down here has a key: digits select, Esc or Delete '
        + 'goes back — exactly like INPA. The status line shows what the app '
        + 'is doing.',
  },
  {
    sel: '#flash-btn',
    title: 'Flashing',
    body: 'Identify the DME and read or back up its flash regions. The '
        + 'current stages are read-only — nothing is written to the ECU.',
  },
  {
    sel: '#settings-btn',
    title: 'Make it yours',
    body: 'Themes (including the faithful INPA look), English or original '
        + 'EDIABAS labels, auto-scan, a startup vehicle — and this tour, any '
        + 'time, from Settings.',
  },
];

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
function startTutorial() {
  if (document.querySelector('.tour-overlay')) return; // one tour at a time
  const steps = TOUR_STEPS.filter(s => document.querySelector(s.sel));
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
