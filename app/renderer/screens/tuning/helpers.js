/**
 * @file Tuning screen: small formatting and DOM helpers shared by the pieces
 * -- byte and number formatting, the empty-state and note blocks, the
 * attention animations, and the table heat ramp.
 */

/* exported fmtBytes, fmtNum, tnFmtAddr, tnHex2, tnHexOff, tnDefSizeLabel, makeEmpty, makeNote, tnDefsEmptyState, shake, tnFlash, heatColor */

/** Bytes in a megabyte, for size labels. */
const TN_MB = 1048576;

/**
 * "512 B" / "1.5 KB" / "1.00 MB".
 * @param {number} n - Byte count.
 * @returns {string}
 */
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < TN_MB) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / TN_MB).toFixed(2)} MB`;
}

/**
 * A number for display: integers clean, otherwise fixed to `dp` places with
 * trailing zeros trimmed -- only AFTER a decimal point. The old /\.?0+$/
 * also ate the zeros of a whole number, so an axis breakpoint of 49.9998 at
 * 0 dp came out as "5".
 * @param {number|null|undefined} v
 * @param {number|null|undefined} dp - Decimal places (default 2, capped at 8).
 * @returns {string} '' for a missing or non-finite value.
 */
function fmtNum(v, dp) {
  if (v == null || !Number.isFinite(v)) return '';
  if (dp == null || dp < 0) dp = 2;
  if (Number.isInteger(v)) return String(v);
  const s = v.toFixed(Math.min(dp, 8));
  if (s.indexOf('.') === -1) return s;
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * "0x" + upper-case hex, zero-padded to `digits`.
 * @param {number} n
 * @param {number} [digits] - Minimum hex digits (default 2).
 * @returns {string}
 */
function tnFmtAddr(n, digits) {
  return (
    '0x' +
    n
      .toString(16)
      .toUpperCase()
      .padStart(digits || 2, '0')
  );
}

/**
 * One byte as two upper-case hex digits.
 * @param {number} b
 * @returns {string}
 */
function tnHex2(b) {
  return b.toString(16).padStart(2, '0').toUpperCase();
}

/**
 * An image offset as six upper-case hex digits (the hex grid's gutter width).
 * @param {number} o
 * @returns {string}
 */
function tnHexOff(o) {
  return o.toString(16).padStart(6, '0').toUpperCase();
}

/**
 * The size of a library definition, in MB above one megabyte and whole KB
 * below. The OBD1 definitions are tens of KB, not megabytes -- a fixed MB
 * format renders every one of them as "0.0 MB".
 * @param {number|undefined} bytes
 * @returns {string}
 */
function tnDefSizeLabel(bytes) {
  const n = bytes || 0;
  return n >= TN_MB
    ? `${(n / TN_MB).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/**
 * An empty-state block: icon, title, optional subtitle. `title` and `sub`
 * are inserted as HTML.
 * @param {string} icon
 * @param {string} title
 * @param {string} sub
 * @returns {HTMLDivElement}
 */
function makeEmpty(icon, title, sub) {
  const d = document.createElement('div');
  d.className = 'tn-empty';
  d.innerHTML =
    `<div class="tn-empty-icon">${icon}</div><div>${title}</div>` +
    (sub ? `<div class="tn-empty-sub">${sub}</div>` : '');
  return d;
}

/**
 * A one-line note block (text, not HTML).
 * @param {string} text
 * @returns {HTMLDivElement}
 */
function makeNote(text) {
  const d = document.createElement('div');
  d.className = 'tn-note';
  d.textContent = text;
  return d;
}

/**
 * The definition pane's empty state, shown whenever no .xdf is open.
 * @returns {HTMLDivElement}
 */
function tnDefsEmptyState() {
  return makeEmpty(
    '⛃',
    'Load a .xdf definition to edit named parameters.',
    'Without one you can still browse and edit raw hex.'
  );
}

/**
 * Wobble an element to say "that input was refused".
 * @param {Element} el
 * @returns {void}
 */
function shake(el) {
  el.classList.add('tn-shake');
  setTimeout(() => el.classList.remove('tn-shake'), 350);
}

/**
 * Flash an element to say "applied".
 * @param {Element} el
 * @returns {void}
 */
function tnFlash(el) {
  el.classList.add('tn-flash');
  setTimeout(() => el.classList.remove('tn-flash'), 400);
}

/**
 * The table heat scale: the blue -> green -> yellow -> red ramp every map
 * editor uses, at full strength.
 * @type {number[][]}
 */
const HEAT_STOPS = [
  [0x24, 0x47, 0xa8],
  [0x1e, 0x8f, 0x8a],
  [0x4c, 0xaf, 0x50],
  [0xe3, 0xc2, 0x3a],
  [0xef, 0x7d, 0x2a],
  [0xd6, 0x3a, 0x2f],
];

/**
 * The fill for a 0..1 position on the heat ramp, and an ink that keeps
 * contrast on it (dark on the bright yellow/green middle, light on the deep
 * blue and red ends).
 * @param {number} f - Position, clamped to 0..1.
 * @returns {{ bg: string, ink: string }}
 */
function heatColor(f) {
  if (!Number.isFinite(f)) f = 0;
  f = f < 0 ? 0 : f > 1 ? 1 : f;
  const n = HEAT_STOPS.length - 1;
  const pos = f * n;
  const i = Math.min(n - 1, Math.floor(pos));
  const k = pos - i;
  const a = HEAT_STOPS[i];
  const b = HEAT_STOPS[i + 1];
  const r = Math.round(a[0] + (b[0] - a[0]) * k);
  const g = Math.round(a[1] + (b[1] - a[1]) * k);
  const bl = Math.round(a[2] + (b[2] - a[2]) * k);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * bl) / 255;
  return {
    bg: `rgb(${r}, ${g}, ${bl})`,
    ink: lum > 0.5 ? '#0b0f14' : '#f4f7fa',
  };
}
