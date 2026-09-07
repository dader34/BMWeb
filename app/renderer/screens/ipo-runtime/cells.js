/**
 * @file The cells both skins draw: caption text through the exact-dictionary
 * translation, and INPA's two instrument cells -- the lamp (digitalout) and
 * the bar (analogout).
 */

/** Words a lamp reads as "on" when its declared TrueText is unknown. */
const IPO_LAMP_ON_RE = /^(1|ein|on|an|ja|yes|aktiv|true)$/i;

/** The width a bar takes on the text grid, in columns. */
const IPO_GAUGE_COLS = 34;

/** A band edge within this many percent of a scale end collides with its number. */
const IPO_GAUGE_EDGE_MARGIN = 8;

/**
 * A painted cell of the program's grid (see IpoProgram.takeCells).
 * @typedef {object} IpoCell
 * @property {number} row - absolute screen row
 * @property {number} col - screen column
 * @property {string} text - the cell's text
 * @property {string|null} key - the result key it is bound to
 * @property {'text'|'value'|'lamp'|'gauge'} kind - what drew it
 * @property {IpoCellMeta|null} meta - what analogout/digitalout declared
 */

/**
 * What analogout/digitalout declared for a cell: the scale, the good band,
 * the format, the two words -- the painter draws INPA's bar and lamp from it.
 * @typedef {object} IpoCellMeta
 * @property {number} [min] - scale minimum
 * @property {number} [max] - scale maximum
 * @property {number} [lo] - valid-band low edge
 * @property {number} [hi] - valid-band high edge
 * @property {string} [fmt] - display format
 * @property {string} [on] - the lamp's TrueText
 * @property {string} [off] - the lamp's FalseText
 */

/**
 * A key's caption for the bar: its own label, else the legend's, translated.
 * @param {IpoProgram} program - the running program (unused; kept for callers)
 * @param {IpoMenuItem} it - the key
 * @returns {string}
 */
function ipoKeyLabel(program, it) {
  const raw = it.label || it.legendLabel || '';
  return irLabel(raw) || raw;
}

/**
 * A printed string through the exact-dictionary translation; blank text
 * passes through untouched so padding survives.
 * @param {*} s - the text
 * @returns {string}
 */
function ipoText(s) {
  const raw = String(s == null ? '' : s);
  if (!raw.trim()) return raw;
  return irLabel(raw) || raw;
}

/**
 * A scale number for the bar's foot, rounded to two decimals.
 * @param {number|null|undefined} v - the number
 * @returns {string}
 */
function ipoScaleLabel(v) {
  if (v == null || !Number.isFinite(v)) return '';
  const r = Math.round(v * 100) / 100;
  return String(r);
}

/**
 * Is a lamp lit? The word the script printed against its declared TrueText /
 * FalseText, else the usual on-words.
 * @param {{text: string, meta: IpoCellMeta|null}} c - the lamp cell
 * @returns {boolean}
 */
function ipoLampOn(c) {
  const m = c.meta || {};
  const word = String(c.text || '').trim();
  return m.on != null && word && word === String(m.on).trim()
    ? true
    : m.off != null && word === String(m.off).trim()
      ? false
      : IPO_LAMP_ON_RE.test(word);
}

/**
 * digitalout(val, row, col, TrueText, FalseText) is a lamp: a filled circle
 * with the TrueText beside it when the value is set, an empty circle with
 * the FalseText otherwise.
 * @param {IpoCell} c - the cell
 * @returns {string} HTML
 */
function ipoLampHtml(c) {
  const word = String(c.text || '').trim();
  const on = ipoLampOn(c);
  const key = c.key ? ` data-key="${esc(c.key)}"` : '';
  return (
    `<span class="ipo-lamp-cell"${key}>` +
    `<span class="ipo-dot${on ? ' on' : ''}"></span>` +
    `<span class="ipo-lamp-word">${esc(ipoText(word))}</span></span>`
  );
}

/**
 * analogout(val, row, col, min, max, minvalid, maxvalid, fmt) is a bar: the
 * declared scale min..max, the valid band green and the rest red, a black
 * fill from the left up to the reading, the scale ends and band edges
 * printed under it, the number beside it. With no declared scale, or a
 * state word where a number was expected, the value shows as text.
 * @param {IpoCell} c - the cell
 * @returns {string} HTML
 */
function ipoGaugeHtml(c) {
  const m = c.meta || {};
  const text = String(c.text || '').trim();
  const n = parseFloat(text);
  const key = c.key ? ` data-key="${esc(c.key)}"` : '';
  const hasScale =
    m.min != null &&
    m.max != null &&
    Number.isFinite(m.min) &&
    Number.isFinite(m.max);
  if (!hasScale || Number.isNaN(n)) {
    return `<span class="ipo-val ipo-gauge-val"${key}>${esc(text)}</span>`;
  }
  const span = m.max - m.min || 1;
  const at = (v) => Math.max(0, Math.min(100, ((v - m.min) / span) * 100));
  const pct = at(n).toFixed(1);
  let bg = 'var(--gauge-ok)';
  let edges = '';
  if (
    m.lo != null &&
    m.hi != null &&
    Number.isFinite(m.lo) &&
    Number.isFinite(m.hi)
  ) {
    const a = at(m.lo),
      b = at(m.hi);
    bg =
      `linear-gradient(to right, var(--gauge-warn) 0 ${a.toFixed(1)}%, ` +
      `var(--gauge-ok) ${a.toFixed(1)}% ${b.toFixed(1)}%, ` +
      `var(--gauge-warn) ${b.toFixed(1)}% 100%)`;
    for (const [v, pos] of [
      [m.lo, a],
      [m.hi, b],
    ]) {
      if (pos > IPO_GAUGE_EDGE_MARGIN && pos < 100 - IPO_GAUGE_EDGE_MARGIN)
        edges += `<span class="ipo-gauge-edge" style="left:${pos.toFixed(1)}%">${esc(ipoScaleLabel(v))}</span>`;
    }
  }
  return (
    `<span class="ipo-gauge"${key}>` +
    `<span class="ipo-gauge-bar">` +
    `<span class="ipo-gauge-track" style="background:${bg}">` +
    `<span class="ipo-gauge-fill" style="width:${pct}%"></span></span>` +
    `<span class="ipo-gauge-foot"><span>${esc(ipoScaleLabel(m.min))}</span>${edges}` +
    `<span>${esc(ipoScaleLabel(m.max))}</span></span></span>` +
    `<span class="ipo-gauge-val">${esc(text)}</span></span>`
  );
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ipoLampOn,
    IPO_GAUGE_COLS,
    ipoKeyLabel,
    ipoText,
    ipoScaleLabel,
    ipoLampHtml,
    ipoGaugeHtml,
  };
}
