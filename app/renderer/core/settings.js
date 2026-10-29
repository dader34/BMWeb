/**
 * @file Persistent settings, the API base, and the skin (theme) machinery.
 *
 * First piece of the core: everything here is read by the pieces that follow
 * (ui.js, api.js, ...) and by every screen. `IS_WEB` and `APP_NAME` are
 * declared inline in index.html so the name lands before first paint.
 */

/* exported API, THEMES, DEFAULT_THEME, itemLabel */

/**
 * Base URL of the diagnostic engine. The native shell runs a local sidecar;
 * the web build's fetch shim answers the same routes in-page, so the value is
 * only a prefix. `?api=` on the page URL overrides it for development.
 * @type {string}
 */
const API =
  new URLSearchParams(location.search).get('api') || 'http://127.0.0.1:8777';

/**
 * The keys the app persists. Every key is optional; readers pass a default.
 * @typedef {Object} AppSettings
 * @property {string} [theme] - Skin id from {@link THEMES} (DEFAULT_THEME, 'brackets', by default).
 * @property {'en'|'orig'} [lang] - Translated captions, or raw EDIABAS names.
 * @property {'on'|'off'} [inpaScreens] - INPA-faithful layout on desktop; off (the modern layout) by default.
 * @property {'on'|'off'} [confirmActuators] - Ask before firing an actuator test.
 * @property {boolean} [betaReports] - Show the Report button and auto-file wire errors.
 * @property {string} [betaEndpoint] - Collector / signaling worker URL.
 * @property {string} [gatewayUrl] - A cable another machine is serving
 *   (`bmweb gateway`), as a ws:// or wss:// URL. Empty means this
 *   machine's own cable over Web Serial.
 * @property {{urls: string, username?: string, credential?: string}} [turn] - TURN server for remote sessions.
 * @property {string} [startChassis] - Chassis to open at boot.
 * @property {string} [startEcu] - "sgbd|code|label" of a module to open at boot.
 */

/**
 * Durable key/value settings. localStorage alone resets every launch in the
 * native shell (ephemeral port, origin-scoped), so the shell injects the
 * durable copy at document start and is handed every write.
 */
const Settings = {
  /** @type {AppSettings & Object<string, any>} */
  // bmacw.settings is the key before the rename: read once, so nobody's
  // settings reset; every write goes to the new key
  data:
    (typeof window !== 'undefined' && window.__bmwebSettings) ||
    JSON.parse(
      localStorage.getItem('bmweb.settings') ||
        localStorage.getItem('bmacw.settings') ||
        '{}'
    ),

  /**
   * Read one setting.
   * @template T
   * @param {string} key - Setting name.
   * @param {T} [def] - Value when the key was never set.
   * @returns {T} The stored value, or `def`.
   */
  get(key, def) {
    return key in this.data ? this.data[key] : def;
  },

  /**
   * Write one setting and persist the whole map (localStorage plus the native
   * shell's durable store when present).
   * @param {string} key - Setting name.
   * @param {any} val - New value.
   * @returns {void}
   */
  set(key, val) {
    this.data[key] = val;
    const json = JSON.stringify(this.data);
    localStorage.setItem('bmweb.settings', json);
    if (window.bmweb && window.bmweb.saveSettings)
      window.bmweb.saveSettings(json);
  },
};

/**
 * The skins the Settings screen offers. `instrument` is the default and is
 * drawn with no `data-theme` attribute at all.
 * @type {Array<{id: string, name: string}>}
 */
/** The skin a first-time user gets (no theme saved yet). */
const DEFAULT_THEME = 'brackets';

const THEMES = [
  { id: 'instrument', name: 'Instrument' },
  { id: 'inpa', name: 'INPA' },
  { id: 'aero', name: 'Frutiger' },
  { id: 'metal', name: 'Brushed Metal' },
  { id: 'brackets', name: 'Brackets' },
  { id: 'gt1', name: 'GT1' },
];

/** The rendered logo's edge, in CSS pixels, for the dock icon / favicon. */
const LOGO_PNG_SIZE = 256;
/**
 * The cursor logo's edge, in CSS pixels. Browsers refuse a cursor image
 * wider than 128px, and a pointer has to stay small enough to see past, so
 * this is drawn separately from the 256px dock icon rather than scaled down.
 */
const LOGO_CURSOR_SIZE = 28;
/** Delay before re-rendering the logo after a theme swap, so the new colours have applied. */
const DOCK_ICON_REPAINT_MS = 100;
/** Window translucency under the aero skin (a CSS custom property). */
const AERO_OPACITY = '0.82';

/**
 * Apply a skin: set the root attribute, repaint the F-key bar, toggle the
 * native window's translucency, and re-render the logo in the new colours.
 * @param {string} id - Theme id from {@link THEMES}.
 * @returns {void}
 */
function applyTheme(id) {
  if (!id || id === 'instrument')
    document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', id);
  // repaint the F-key bar (its chrome is theme-dependent). Guarded: this runs
  // once at load before actionbar.js has declared the bar, and that early
  // call must simply do nothing.
  try {
    actionBar.paint(actionBar.current);
  } catch {
    /* bar not built yet */
  }
  // aero only: frameless + transparent window
  if (window.bmweb && window.bmweb.setTranslucent) {
    window.bmweb.setTranslucent(id === 'aero');
  }
  applyAeroOpacity();
  setTimeout(updateDockIcon, DOCK_ICON_REPAINT_MS);
  // the pointer wears the same logo, so it is redrawn in the new colours too
  setTimeout(applyCursor, DOCK_ICON_REPAINT_MS);
}

/**
 * Is the BMWeb cursor turned on? Off unless the setting says otherwise, so
 * the app keeps the system pointer by default.
 * @returns {boolean}
 */
function bmwebCursor() {
  return Settings.get('bmwebCursor', false) === true;
}

/**
 * Draw the app's logo as the mouse pointer, in the current theme's colours,
 * or hand the system pointer back when the setting is off.
 *
 * The logo is published as a CSS custom property rather than written onto
 * every element: one rule on the root carries it, and `cursor: inherit`
 * lets a control that wants its own pointer (a text field, a resize grip)
 * keep saying so. The hotspot sits at the disc's centre because the mark is
 * a roundel with no point to aim.
 * @returns {void}
 */
function applyCursor() {
  const root = document.documentElement;
  if (!bmwebCursor()) {
    root.classList.remove('bmweb-cursor');
    root.style.removeProperty('--app-cursor');
    return;
  }
  const svg = logoSvg(LOGO_CURSOR_SIZE);
  const mid = Math.round(LOGO_CURSOR_SIZE / 2);
  root.style.setProperty(
    '--app-cursor',
    `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${mid} ${mid}, auto`
  );
  root.classList.add('bmweb-cursor');
}

/**
 * Publish the aero skin's translucency as a CSS custom property.
 * @returns {void}
 */
function applyAeroOpacity() {
  document.documentElement.style.setProperty('--aero-opacity', AERO_OPACITY);
}

/**
 * Point the page's favicon at a data URL, creating the link tag if the page
 * shipped without one.
 * @param {string} dataUrl - PNG data URL.
 * @returns {void}
 */
function setFavicon(dataUrl) {
  let link = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = 'image/png';
  link.href = dataUrl;
}

/**
 * Render the logo SVG to a PNG in the current theme's colours and hand it to
 * the dock (native shell) or the favicon (web).
 * @returns {void}
 */
function logoSvg(size) {
  const styles = getComputedStyle(document.documentElement);
  // the bolt B in the theme's four logo colours: ground, border, accent, white
  const bg = styles.getPropertyValue('--logo-bg').trim() || '#11161c';
  const border = styles.getPropertyValue('--logo-border').trim() || '#9aa6b2';
  const q1 = styles.getPropertyValue('--logo-quad-1').trim() || '#eef2f5';
  const q2 = styles.getPropertyValue('--logo-quad-2').trim() || '#ff9e2c';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">` +
    `<rect x="1.5" y="1.5" width="97" height="97" rx="21" fill="${bg}" stroke="${border}" stroke-width="3"/>` +
    `<g transform="translate(17 18.5) scale(0.126)"><path fill="${q2}" d="M88 0 H400 C470 0 520 40 516 100 C512 160 480 196 432 214 C488 236 512 290 500 352 C486 440 420 490 320 490 H0 Z"/><path fill="${q1}" d="M318 26 L128 262 L230 262 L176 452 L384 210 L282 210 Z"/></g>` +
    `</svg>`
  );
}

/**
 * Render the logo SVG to a PNG in the current theme's colours and hand it to
 * the dock (native shell) or the favicon (web).
 * @returns {void}
 */
function updateDockIcon() {
  const dock = window.bmweb && window.bmweb.setDockIcon;
  if (!dock && !IS_WEB) return;
  const resolvedSvg = logoSvg(LOGO_PNG_SIZE);

  // the spinners are this logo turning (styles.css --app-logo)
  document.documentElement.style.setProperty(
    '--app-logo',
    `url("data:image/svg+xml,${encodeURIComponent(resolvedSvg)}")`
  );

  const img = new Image();
  const svgBlob = new Blob([resolvedSvg], {
    type: 'image/svg+xml;charset=utf-8',
  });
  const url = URL.createObjectURL(svgBlob);

  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = LOGO_PNG_SIZE;
    canvas.height = LOGO_PNG_SIZE;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    if (dock) window.bmweb.setDockIcon(dataUrl).catch(console.error);
    else setFavicon(dataUrl);
    URL.revokeObjectURL(url);
  };
  img.onerror = (e) => {
    console.error('Failed to load dynamic logo SVG to image:', e);
    URL.revokeObjectURL(url);
  };
  img.src = url;
}
applyTheme(Settings.get('theme', DEFAULT_THEME));
applyCursor();

/**
 * The caption language: 'en' = translated English, 'orig' = raw EDIABAS names.
 * @returns {'en'|'orig'}
 */
const lang = () => Settings.get('lang', 'en');

/**
 * Caption for a mined layout item: the raw job name in Original mode, else the
 * .IPO caption through the open ECU's own i18n map.
 * @param {{job: string, label: string}} it - A layout item.
 * @returns {string}
 */
const itemLabel = (it) => (lang() === 'orig' ? it.job : irLabel(it.label));
