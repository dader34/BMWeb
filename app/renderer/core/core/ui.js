/**
 * @file Shared DOM handles and the small render helpers every screen uses:
 * escaping, the breadcrumb strip, headings, skeleton placeholders, tooltips.
 */

/** The screen body every show*() renders into. @type {HTMLElement} */
const view = document.getElementById('view');
/** The breadcrumb strip. @type {HTMLElement} */
const crumbsEl = document.getElementById('crumbs');
/** The cable/engine status light. @type {HTMLElement} */
const led = document.getElementById('led');
/** The cable/engine status text beside the light. @type {HTMLElement} */
const linkText = document.getElementById('link-text');
/** Status bar, left half (what the screen is doing). @type {HTMLElement} */
const sbLeft = document.getElementById('sb-left');
/** Status bar, right half (counts). @type {HTMLElement} */
const sbRight = document.getElementById('sb-right');
/** The F-key bar container. @type {HTMLElement} */
const fkeysEl = document.getElementById('fkeys');

/**
 * Display-name overrides for chassis ids; the raw id stays for API and file
 * lookup.
 * @type {Object<string, string>}
 */
const CHASSIS_DISPLAY = { F010: 'F10', F025: 'F25' };

/**
 * A chassis id as shown to the user.
 * @param {string} id - Chassis id (E46, F010, ...).
 * @returns {string}
 */
const dispChassis = (id) => CHASSIS_DISPLAY[id] || id;

/**
 * Short model tags for the chassis cards.
 * @type {Object<string, string>}
 */
const CHASSIS_TAG = {
  E36: '3-series 90s',
  E46: '3-series 98-06',
  E60: '5-series',
  E65: '7-series',
  E70: 'X5',
  E83: 'X3',
  E85: 'Z4',
  E87: '1-series',
  E89: 'Z4',
  E90: '3-series 05-12',
  E39: '5-series 95-03',
  E52: 'Z8',
  E53: 'X5 99-06',
  F01: '7-series',
  F07: '5 GT',
  F30: '3-series 12+',
  R50: 'Mini',
  R56: 'Mini',
  RR1: 'Rolls-Royce',
  F010: '5-series',
  F025: 'X3',
};

/**
 * One breadcrumb.
 * @typedef {Object} Crumb
 * @property {string} label - Text shown.
 * @property {() => void} [fn] - Click handler; the last crumb usually has none.
 */

/** The breadcrumbs currently shown. @type {Crumb[]} */
let crumbs = [];

/**
 * Escape server-sourced text (fault texts, labels, job names) for innerHTML.
 * @param {any} s - Anything; null/undefined become ''.
 * @returns {string}
 */
const esc = (s) =>
  String(s == null ? '' : s).replace(
    /[&<>"]/g,
    (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]
  );

/**
 * "0x"-prefixed uppercase hex, zero-padded to `width` nibbles.
 * @param {number} n - Value (treated as unsigned 32-bit).
 * @param {number} [width=2] - Minimum nibble count.
 * @returns {string}
 */
const hex = (n, width = 2) =>
  '0x' + (n >>> 0).toString(16).toUpperCase().padStart(width, '0');

/**
 * The phone breakpoint. Below it the mobile stylesheet strips the F-key bar
 * and the INPA layout, so several behaviours key off the same query.
 * @type {string}
 */
const MOBILE_MEDIA = '(max-width: 760px)';

/**
 * True when the viewport is at or below the phone breakpoint.
 * @returns {boolean}
 */
const isMobileViewport = () =>
  !!(window.matchMedia && window.matchMedia(MOBILE_MEDIA).matches);

/**
 * INPA-style layout on. Forced off on a phone (the mobile stylesheet strips
 * what makes it itself), so every screen follows one reader.
 * @returns {boolean}
 */
const inpaMode = () =>
  Settings.get('inpaScreens', 'off') === 'on' && !isMobileViewport();

/**
 * Draw the breadcrumb strip and mirror the screen into the URL.
 * @param {Crumb[]} items - Crumbs, root first.
 * @returns {void}
 */
function setCrumbs(items) {
  // the WDS wiring screen hides the F-key bar; any other screen drawing itself restores it
  document.body.classList.remove('wds-nofkeys');
  // ETK screens tag the body so CSS can drop the F-key bar on mobile; cleared
  // here so it only applies while an ETK screen is up
  document.body.classList.remove('apps-section');
  crumbs = items;
  crumbsEl.innerHTML = '';
  items.forEach((c, i) => {
    if (i) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '/';
      crumbsEl.appendChild(sep);
    }
    const el = document.createElement('span');
    el.className = 'crumb' + (i === items.length - 1 ? ' active' : '');
    el.textContent = c.label;
    if (c.fn) el.onclick = c.fn;
    crumbsEl.appendChild(el);
  });
  // reflect the current screen in the URL so Apps pages are linkable and Back
  // works. lastScreen is set at the top of every screen fn before it renders.
  if (typeof routeSyncFromScreen === 'function')
    routeSyncFromScreen(lastScreen);
}

/** Widest a tooltip may grow, in CSS pixels. */
const TIP_MAX_WIDTH = 320;
/** Rough width of one tooltip character, for the edge-flip estimate. */
const TIP_CHAR_WIDTH = 6.2;
/** Below this many pixels from the top a tooltip is drawn under its element. */
const TIP_FLIP_BELOW_Y = 92;
/** Margin a tooltip keeps from the viewport edges. */
const TIP_EDGE_MARGIN = 8;

/**
 * Turn `title=` into an instant tooltip (the browser's own is ~1.5 s, too slow
 * to be seen); the title stays for accessibility.
 * @param {ParentNode} root - Subtree to scan for titled elements.
 * @returns {void}
 */
function tipify(root) {
  root.querySelectorAll('[title]:not([data-tip])').forEach((el) => {
    const text = el.getAttribute('title');
    if (!text) return;
    // skip the traffic-light dots: a tip flips below them and paints a bar across all three; macOS doesn't caption them either
    if (el.classList.contains('win-dot')) return;
    el.dataset.tip = text;
    // measured on hover: layout is settled by then
    el.addEventListener(
      'pointerenter',
      () => {
        const r = el.getBoundingClientRect();
        const half = Math.min(text.length * TIP_CHAR_WIDTH, TIP_MAX_WIDTH) / 2;
        el.classList.toggle(
          'tip-left',
          r.left + r.width / 2 - half < TIP_EDGE_MARGIN
        );
        el.classList.toggle(
          'tip-right',
          r.left + r.width / 2 + half > window.innerWidth - TIP_EDGE_MARGIN
        );
        el.classList.toggle('tip-below', r.top < TIP_FLIP_BELOW_Y);
      },
      { once: false }
    );
  });
}

/**
 * The standard screen heading block.
 * @param {string} eyebrow - Small caps line above the title.
 * @param {string} [title] - The H1; omitted when empty.
 * @param {string} [subtitle] - A line under the title; omitted when empty.
 * @returns {string} HTML.
 */
function head(eyebrow, title, subtitle) {
  return `<div class="screen-head">
    <div class="eyebrow">${esc(eyebrow)}</div>
    ${title ? `<h1 class="title">${esc(title)}</h1>` : ''}
    ${subtitle ? `<p class="subtitle">${esc(subtitle)}</p>` : ''}
  </div>`;
}

/**
 * Stagger the entrance animation of a container's children.
 * @param {Element} container - Parent whose children animate in.
 * @param {number} [step=35] - Delay between siblings, in ms.
 * @returns {void}
 */
function stagger(container, step = 35) {
  [...container.children].forEach((c, i) => {
    c.style.animationDelay = `${i * step}ms`;
  });
}

/**
 * Shimmering placeholder list.
 * @param {number} [rows=6] - Row count.
 * @param {boolean} [sub=true] - Add a second bar per row for two-line cells.
 * @returns {string} HTML.
 */
function skeletonList(rows = 6, sub = true) {
  const row =
    `<div class="sk-row" aria-hidden="true">` +
    `<div class="sk-bar sk-title"></div>` +
    (sub ? `<div class="sk-bar sk-sub"></div>` : '') +
    `</div>`;
  return (
    `<div class="skeleton sk-list" role="status" aria-label="Loading">` +
    row.repeat(rows) +
    `</div>`
  );
}
