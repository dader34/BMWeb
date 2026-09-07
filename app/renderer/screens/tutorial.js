/**
 * @file First-run tutorial: a one-time offer dialog, and a coach-mark tour
 * that spotlights the app's real controls and walks into a real module along
 * the way. Re-runnable any time from Settings. Also the "How it works" info
 * walkthrough.
 *
 * The tour root carries the modal-overlay class so the global action-key
 * handler (core.js) stands down while it's up; the tour owns Esc/arrows.
 * Steps may live on different screens: each declares `screen`, and the tour
 * navigates (home = vehicle picker, module = a real ECU opened offline)
 * whenever the step's screen differs from the current one.
 *
 * The step selectors below name controls of OTHER screens (the link LED, the
 * chassis grid, the F-key bar, the hub cards...): renaming any of those
 * breaks the tour silently, because a missing target is simply skipped.
 */

/* exported maybeOfferTutorial, startTutorial, showHowItWorks */

/**
 * One coach-mark step.
 * @typedef {object} TourStep
 * @property {'home'|'module'|'apps'} screen - the screen the target lives on (see TOUR_SCREENS)
 * @property {string} sel - CSS selector of the control to spotlight; a missing target skips the step
 * @property {string} title - tip heading
 * @property {string} body - tip text
 */

/**
 * One slide of the "How it works" walkthrough.
 * @typedef {object} HowItWorksSlide
 * @property {string} icon - a single emoji
 * @property {string} title - slide heading
 * @property {string} body - slide text
 */

/** Padding of the spotlight ring around its target, in px. */
const TOUR_RING_PAD = 8;

/** Minimum gap between the tip and the viewport edge, in px. */
const TOUR_VIEWPORT_MARGIN = 12;

/** How long the overlay's fade-out runs before it is removed, in ms. */
const TOUR_FADE_MS = 160;

/** The demo module's chassis: the E46 renders fully offline. */
const TOUR_MODULE_CHASSIS = 'E46';

/** The config's own section key for the engine group (not its translated display name; see autoscan.js). */
const TOUR_MODULE_SECTION = 'ROOT_MOTOR';

/** The demo module's SGBD: the engine ECU (menu, layouts, fault screen all work offline). */
const TOUR_MODULE_SGBD_RE = /ms45/i;

/**
 * Open the tour's demo module. Falls back to the first module of the first
 * section when the expected one is missing.
 * @returns {Promise<void>}
 */
async function openTourModule() {
  const ch = await api(`/api/chassis/${TOUR_MODULE_CHASSIS}`);
  const sec =
    ch.sections.find((s) => s.key === TOUR_MODULE_SECTION) || ch.sections[0];
  const ecu =
    sec.ecus.find((e) => TOUR_MODULE_SGBD_RE.test(e.sgbd)) || sec.ecus[0];
  await showEcu(TOUR_MODULE_CHASSIS, sec.name, ecu);
}

/**
 * How the tour reaches each screen a step can live on.
 * @type {Record<TourStep['screen'], () => Promise<void>|void>}
 */
const TOUR_SCREENS = {
  home: () => showChassis(),
  module: () => openTourModule(),
  // the guided Apps tour lives on the Apps hub; each step spotlights a card
  apps: () => showApps(),
};

/**
 * The optional extended tour: a guided walk of the Apps hub. Only the apps
 * that actually shipped in this build render a card (apps.js greys the
 * rest), so each step guards on its card being present -- a missing target
 * is skipped by the tour driver, exactly like the classic/modern step split.
 * @returns {TourStep[]}
 */
function appsTourSteps() {
  return [
    {
      screen: 'apps',
      sel: '.apps-list',
      title: 'The Apps hub',
      body:
        'Beyond live diagnostics, ' +
        APP_NAME +
        " ports BMW's own dealer " +
        "reference tools -- offline, no login. Here they are; let's look " +
        'at each one.',
    },
    {
      screen: 'apps',
      sel: '.app-entry[data-app="lookup"]:not(.app-absent)',
      title: 'Diagnostic Plans & Trouble Codes',
      body:
        'Search any fault code and read its plain-English meaning, then the ' +
        "ISTA service data and step-by-step diagnostic procedure BMW's own " +
        'technicians follow. Works with no car attached.',
    },
    {
      screen: 'apps',
      sel: '.app-entry[data-app="wiring"]:not(.app-absent)',
      title: 'Wiring Diagrams (WDS)',
      body:
        "BMW's own WDS schematics, component locations and connector views. " +
        "Enter a VIN and it opens straight to your car's diagrams and " +
        'filters them to your exact engine and body.',
    },
    {
      screen: 'apps',
      sel: '.app-entry[data-app="etk"]:not(.app-absent)',
      title: 'Parts Catalogue (ETK)',
      body:
        "BMW's ETK parts catalogue: exploded diagrams, part numbers and " +
        'supersessions by chassis. Decode a VIN to jump straight to your ' +
        "exact vehicle's parts.",
    },
    {
      screen: 'apps',
      sel: '.app-entry[data-app="tool32"]:not(.app-absent)',
      title: 'Tool32',
      body:
        'The power tool: run any SGBD job on a module directly and read its ' +
        'raw result registers -- the same low-level access the factory ' +
        'ToolSet32 gives, in your browser.',
    },
    {
      screen: 'apps',
      sel: '.app-entry[data-app="tuning"]:not(.app-absent)',
      title: 'Tuning',
      body:
        'Open an ECU firmware BIN as raw hex, or load a TunerPro .xdf to ' +
        'edit its constants, flags and maps by name. For reading and ' +
        'understanding your tune.',
    },
    {
      screen: 'apps',
      sel: '.apps-list',
      title: "That's the tour",
      body:
        "That's everything. Plug in a K+DCAN cable when you're ready, or " +
        'keep exploring offline -- and you can replay this tour any time ' +
        'from Settings.',
    },
  ];
}

/**
 * The base tour. Built at start time so it matches the active layout mode
 * (classic F-key list vs modern cards).
 * @returns {TourStep[]}
 */
function tourSteps() {
  const classic = typeof inpaMode === 'function' && inpaMode();
  const steps = [
    {
      screen: 'home',
      sel: '#link-status',
      title: 'Cable & connection',
      body:
        APP_NAME +
        ' talks to the car over a K+DCAN USB cable. This LED shows ' +
        'the link state: green when the cable answers, red when it does ' +
        'not. With no cable connected you can still browse every screen ' +
        'offline, so feel free to explore before you plug in.',
    },
    {
      screen: 'home',
      sel: '#kl-state',
      title: 'Battery & ignition',
      body:
        'Live battery voltage and ignition state, read from the engine ' +
        'ECU once a cable is connected. If the voltage shows but ' +
        'ignition stays off, turn the key to position 2 before running ' +
        'diagnostics.',
    },
    classic
      ? {
          screen: 'home',
          sel: '.inpa-vsel',
          title: 'Select your vehicle',
          body:
            'Each row is a chassis. Press the function key shown, the ' +
            'matching number key, or click the row. Common models are ' +
            'listed here; everything else lives under "Other models".',
        }
      : {
          screen: 'home',
          sel: '.chassis-grid',
          title: 'Select your vehicle',
          body:
            'Click a chassis card to load its control modules, grouped by ' +
            'system: engine, transmission, brakes, body. The number keys ' +
            'jump to common chassis directly.',
        },
  ];
  steps.push(
    {
      screen: 'module',
      sel: '.inpa-haupt, .group-grid',
      title: 'Inside a module',
      body:
        'This is a real module: the E46 engine ECU. Its functions are ' +
        'grouped the way the factory tool groups them. Fault memory ' +
        'reads codes with plain English descriptions, detail, freeze ' +
        'frames, and clear; Status screens show live values; ' +
        'Activations run actuator tests.',
    },
    {
      screen: 'module',
      sel: '.breadcrumbs',
      title: 'Breadcrumbs',
      body:
        'Always shows where you are: vehicle, module, screen. Click any ' +
        'part to jump straight back to it.',
    },
    {
      screen: 'module',
      sel: '#fkeybar',
      title: 'Function keys',
      body:
        'Every action on the current screen has a key: digits select, ' +
        'Esc or Delete goes back. The status line in the corner shows ' +
        'what the app is doing at all times. Live values poll ' +
        'continuously as gauges, and several can be watched together ' +
        'or streamed to a CSV file with timestamps.',
    },
    {
      screen: 'module',
      sel: '#settings-btn',
      title: 'Make it yours',
      body:
        'Pick a theme, switch between classic and modern screen ' +
        'layouts, choose English or original EDIABAS labels, enable ' +
        'auto-scan on open, set a startup vehicle, and replay this ' +
        'tour, any time, from Settings.',
    }
  );
  return steps;
}

/**
 * Did the user arrive on a deep link (a shared #apps/... route or a ?dtc=
 * fault link)? Then they came to view one specific thing -- the tour would
 * be noise. Bare '#' / '#apps' don't count; only an actual sub-destination
 * does.
 * @returns {boolean}
 */
function bootedIntoDeepLink() {
  try {
    const h = (location.hash || '').replace(/^#\/?/, '').replace(/\/$/, '');
    if (h && h !== 'apps' && /^apps\//.test(h)) return true; // #apps/<something>
    if (new URLSearchParams(location.search).get('dtc')) return true;
    return false;
  } catch (e) {
    return false;
  }
}

/**
 * One-time offer on first boot. Whatever the answer, never ask again
 * (re-runnable from Settings). Easily dismissed: Esc / Not now / backdrop.
 * @returns {Promise<void>}
 */
async function maybeOfferTutorial() {
  if (Settings.get('tutorialSeen', 'no') === 'yes') return;
  // A first-timer who followed a deep link is here for that one page, not a
  // tour. Skip the offer WITHOUT marking it seen, so a later normal visit
  // (landing on the home screen) still gets the tour.
  if (bootedIntoDeepLink()) return;
  Settings.set('tutorialSeen', 'yes');
  const go = await confirmDialog({
    title: `Welcome to ${APP_NAME}`,
    body:
      'Would you like to walk through the tutorial? It takes under a ' +
      'minute and shows where everything lives.',
    confirmLabel: 'Take the tour',
    cancelLabel: 'Not now',
  });
  if (go) startTutorial();
}

/**
 * Spotlight tour over the live UI. Esc/Skip ends it; left/right arrows and
 * the buttons navigate (crossing screens when the step calls for it); the
 * ring and tip track their target on window resize. Ends back on the vehicle
 * screen (or stays on the Apps hub when the apps walk ran).
 * @param {{ full?: boolean }} [opts] - full: replay base + apps walk without the offer in between
 * @returns {Promise<void>}
 */
async function startTutorial(opts) {
  opts = opts || {};
  if (document.querySelector('.tour-overlay')) return; // one tour at a time
  // the base tour, or (when replayed with {full:true}) base + the apps walk
  let steps = opts.full ? tourSteps().concat(appsTourSteps()) : tourSteps();
  const baseLen = tourSteps().length; // where the base tour ends / apps begin
  let offeredMore = opts.full; // don't re-offer once the apps tour is on
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

  // dots track the current step count -- the apps tour can grow `steps` mid-run
  /** Redraw the progress dots for the current step. */
  function renderDots() {
    if (dots.children.length !== steps.length) {
      dots.innerHTML = steps
        .map((_, n) => `<span class="tour-dot" data-n="${n}"></span>`)
        .join('');
    }
    dots
      .querySelectorAll('.tour-dot')
      .forEach((d, n) => d.classList.toggle('active', n === i));
  }

  /**
   * Enter step n, navigating between screens when the step lives elsewhere.
   * A step whose target is missing in this mode/screen is skipped in `dir`.
   * @param {number} n - the step to enter
   * @param {number} [dir] - which way to keep moving when a target is missing
   */
  async function show(n, dir = 1) {
    if (navigating) return;
    while (n >= 0 && n < steps.length) {
      const step = steps[n];
      if (step.screen && step.screen !== currentScreen) {
        navigating = true;
        try {
          await TOUR_SCREENS[step.screen]();
          currentScreen = step.screen;
        } catch {
          /* screen unavailable: skip past this step */
        }
        navigating = false;
      }
      if (document.querySelector(step.sel)) {
        i = n;
        place();
        return;
      }
      n += dir; // target missing in this mode/screen: keep moving
    }
    end();
  }

  /** Put the ring around the current step's target and the tip beside it. */
  function place() {
    const step = steps[i];
    const el = document.querySelector(step.sel);
    if (!el) {
      show(i + 1, 1);
      return;
    }
    const pad = TOUR_RING_PAD;
    const r = el.getBoundingClientRect();
    ring.style.left = `${r.left - pad}px`;
    ring.style.top = `${r.top - pad}px`;
    ring.style.width = `${r.width + pad * 2}px`;
    ring.style.height = `${r.height + pad * 2}px`;

    overlay.querySelector('.tour-title').textContent = step.title;
    overlay.querySelector('.tour-body').textContent = step.body;
    renderDots();
    backBtn.style.visibility = i === 0 ? 'hidden' : 'visible';
    // "Next" still points forward at the base-tour boundary (there's the apps
    // offer beyond it); only the true final step reads "Done".
    const atFinish =
      i === steps.length - 1 && (offeredMore || i !== baseLen - 1);
    nextBtn.textContent = atFinish ? 'Done' : 'Next';

    // tip below the target when there's room, else above; clamped to viewport
    const margin = TOUR_VIEWPORT_MARGIN;
    tip.style.visibility = 'hidden';
    requestAnimationFrame(() => {
      const t = tip.getBoundingClientRect();
      let top = r.bottom + pad * 2;
      if (top + t.height > innerHeight - margin)
        top = r.top - t.height - pad * 2;
      top = Math.max(margin, Math.min(top, innerHeight - t.height - margin));
      let left = r.left + r.width / 2 - t.width / 2;
      left = Math.max(margin, Math.min(left, innerWidth - t.width - margin));
      tip.style.top = `${top}px`;
      tip.style.left = `${left}px`;
      tip.style.visibility = 'visible';
    });
  }

  /** Tear the tour down and land the user somewhere sensible. */
  function end() {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), TOUR_FADE_MS);
    // Don't strand the user mid-demo. If the apps tour ran, leave them on the
    // Apps hub (they just explored it); otherwise return to the vehicle screen.
    if (currentScreen === 'apps') {
      /* stay on Apps */
    } else if (currentScreen !== 'home') {
      try {
        showChassis();
      } catch {}
    }
  }

  /**
   * Advance. At the end of the BASE tour, offer the extended Apps walk
   * before finishing: "See more" appends the apps steps and continues, "I'll
   * explore" ends. Once the apps tour is running (offeredMore), Next just
   * advances/ends.
   */
  async function next() {
    if (!offeredMore && i === baseLen - 1) {
      offeredMore = true;
      overlay.classList.remove('show'); // hide the spotlight for the dialog
      // stand our capturing key handler down so the dialog owns Enter/Esc
      window.removeEventListener('keydown', onKey, true);
      const more = await confirmDialog({
        title: 'Want the full tour?',
        body:
          'That covers live diagnostics. ' +
          APP_NAME +
          " also ports BMW's " +
          'own reference tools -- fault plans, wiring diagrams, the parts ' +
          'catalogue and more. Take a quick guided tour of them, or head ' +
          'off on your own.',
        confirmLabel: 'Show me more',
        cancelLabel: "I'll explore on my own",
      });
      if (!more) {
        end();
        return;
      } // end() won't double-remove the listener
      window.addEventListener('keydown', onKey, true); // resume tour key control
      steps = steps.concat(appsTourSteps()); // extend the tour in place
      overlay.classList.add('show');
      show(baseLen, 1);
      return;
    }
    if (i >= steps.length - 1) end();
    else show(i + 1, 1);
  }
  const back = () => {
    if (i > 0) show(i - 1, -1);
  };
  const onResize = () => place();

  /**
   * The tour owns Esc / Enter / arrows while it is up.
   * @param {KeyboardEvent} e - the key event
   */
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      end();
    } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      next();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      back();
    }
  }

  overlay.querySelector('.tour-skip').onclick = end;
  backBtn.onclick = back;
  nextBtn.onclick = next;
  overlay.onclick = (e) => {
    if (e.target === overlay) end();
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onResize);
  await show(0, 1);
}

/**
 * The "How it works" slides: what the app is, how it talks to the car, and
 * which BMW software and data it draws from.
 * @returns {HowItWorksSlide[]}
 */
function howItWorksSlides() {
  const ver =
    window.bmacw && window.bmacw.version ? `v${window.bmacw.version}` : '';
  return [
    {
      icon: '🔌',
      title: `What ${APP_NAME} is`,
      body:
        `A native macOS diagnostics app for BMW ${ver ? '· ' + ver : ''}. It reads ` +
        'fault codes, live values, and control-module data straight from the ' +
        'car, with no Windows, no VM, and no dealer tool. Everything you see here also ' +
        'works fully offline, so you can explore before ever plugging in.',
    },
    {
      icon: '🧰',
      title: 'The cable & the engine',
      body:
        APP_NAME +
        ' speaks to the car over a K+DCAN USB cable. Under the hood it ' +
        'runs a native port of BMW’s EDIABAS diagnostic engine, the same ' +
        'protocol layer the factory tools use, so it talks to each ECU in its ' +
        'own language over K-line and D-CAN.',
    },
    {
      icon: '📂',
      title: 'SGBD description files',
      body:
        'Each control module is described by an SGBD (.prg) file that defines ' +
        'its jobs, results, and fault tables. ' +
        APP_NAME +
        ' ships BMW’s own SGBDs and ' +
        'runs their jobs directly: FS_LESEN to read faults, STATUS_* for live ' +
        'values, etc...',
    },
    {
      icon: '🖥️',
      title: 'INPA screens, decoded',
      body:
        'The status pages mirror INPA, BMW’s classic diagnostic frontend. ' +
        APP_NAME +
        ' decodes INPA’s compiled .IPO screen programs to reproduce the ' +
        'exact user interface.',
    },
    {
      icon: '🗂️',
      title: 'Fault database from ISTA',
      body:
        'The Fault Lookup screen is built from BMW ISTA’s diagnostic database: ' +
        '50,000+ fault codes across the whole fleet, with English descriptions, ' +
        'per-ECU-variant text, and (where BMW defines them) the matching SAE ' +
        'P-codes and full service documents (conditions, service measures, notes).',
    },
  ];
}

/**
 * "How it works": a stepped, centered info walkthrough (not a UI spotlight).
 * Esc closes; left/right arrows or the buttons page; backdrop closes.
 * @returns {void}
 */
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
        <div class="hiw-dots">${slides
          .map((_, n) => `<span class="hiw-dot" data-n="${n}"></span>`)
          .join('')}</div>
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

  /** Draw the current slide. */
  const render = () => {
    const s = slides[i];
    iconEl.textContent = s.icon;
    titleEl.textContent = s.title;
    bodyEl.textContent = s.body;
    dots.forEach((d, n) => d.classList.toggle('active', n === i));
    backBtn.disabled = i === 0;
    nextBtn.textContent = i === slides.length - 1 ? 'Done' : 'Next';
  };
  /**
   * Page by `d` slides; paging past the last one closes.
   * @param {number} d - +1 or -1
   */
  const go = (d) => {
    if (i + d < 0) return;
    if (i + d >= slides.length) return end();
    i += d;
    render();
  };
  /** Fade the walkthrough out and remove it. */
  const end = () => {
    overlay.classList.remove('show');
    window.removeEventListener('keydown', onKey, true);
    setTimeout(() => overlay.remove(), TOUR_FADE_MS);
  };
  /**
   * The walkthrough owns Esc / Enter / arrows while it is up.
   * @param {KeyboardEvent} e - the key event
   */
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      end();
    } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
      e.preventDefault();
      go(1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      go(-1);
    }
  };
  backBtn.onclick = () => go(-1);
  nextBtn.onclick = () => go(1);
  overlay.querySelector('.hiw-close').onclick = end;
  overlay.onclick = (e) => {
    if (e.target === overlay) end();
  };
  dots.forEach(
    (d) =>
      (d.onclick = () => {
        i = +d.dataset.n;
        render();
      })
  );
  window.addEventListener('keydown', onKey, true);
  render();
}
