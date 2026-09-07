/**
 * @file The review dialog pieces shared by the curated and expert coding
 * screens, and the netto hex helpers shared by every screen that reads a
 * module's coding image before writing it.
 */

/**
 * One review row: label, keyword + from->to.
 * @param {string} label - the setting's display label.
 * @param {string} sub - the module and keyword ("zke5.prg · BEIKLAPPEN_GM").
 * @param {string} from - the current value as text.
 * @param {string} to - the staged value as text.
 * @returns {string} the row's HTML.
 */
function codingReviewRow(label, sub, from, to) {
  return (
    `<div class="cod-rev-row">` +
    `<div class="cod-rev-label">${esc(label)}</div>` +
    `<div class="cod-rev-sub mono">${esc(sub)}</div>` +
    `<div class="cod-rev-change mono">${esc(from)} ` +
    `<span class="cod-rev-arrow">→</span> <b>${esc(to)}</b></div></div>`
  );
}

/**
 * The curated tier's review dialog body: the write is refused (unverified).
 * The "not sent" / EEPROM rationale is the point of the footer.
 * @param {string} title - dialog title.
 * @param {string[]} rows - review rows from {@link codingReviewRow}.
 * @returns {{title: string, body: string, confirmLabel: string, cancelLabel: string}}
 *   the confirmDialog options.
 */
function codingReviewDialog(title, rows) {
  const foot =
    `<b>Not sent.</b> These map onto each module's coding write, but sending ` +
    `is disabled: a coding write is an EEPROM write, and this app has not ` +
    `verified a round-trip on a car that can be recovered.`;
  return {
    title,
    body:
      `<div class="cod-rev-list">${rows.join('')}</div>` +
      `<div class="cod-rev-foot">${foot}</div>`,
    confirmLabel: 'OK',
    cancelLabel: 'Close',
  };
}

/**
 * The netto hex a coding read returned, from its flattened results.
 * @param {Map<string, unknown>} flat - `new Map(flatResults(sets))`.
 * @returns {unknown} the COD_WERT_NETTO / CODIER_WERT_NETTO value, or undefined.
 */
function codingNettoOf(flat) {
  return flat.get('COD_WERT_NETTO') || flat.get('CODIER_WERT_NETTO');
}

/**
 * Netto hex text ("0x" prefix and whitespace tolerated) to bytes.
 * @param {unknown} nettoHex - the netto as the read returned it.
 * @returns {number[]} the bytes.
 */
function codingNettoBytes(nettoHex) {
  const netto = [];
  const hex = String(nettoHex).replace(/^0x/i, '').replace(/\s/g, '');
  for (let i = 0; i + 1 < hex.length; i += 2) {
    netto.push(parseInt(hex.substr(i, 2), 16));
  }
  return netto;
}

/**
 * Bytes to lowercase packed hex, the form webWriteCoding takes.
 * @param {ArrayLike<number>} bytes - the netto.
 * @returns {string} lowercase hex.
 */
function codingNettoHex(bytes) {
  return Array.from(bytes, (b) =>
    ('0' + (b & 0xff).toString(16)).slice(-2)
  ).join('');
}

if (typeof window !== 'undefined') {
  window.codingReviewRow = codingReviewRow;
  window.codingReviewDialog = codingReviewDialog;
  window.codingNettoOf = codingNettoOf;
  window.codingNettoBytes = codingNettoBytes;
  window.codingNettoHex = codingNettoHex;
}
