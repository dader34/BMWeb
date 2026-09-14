/**
 * @file Drawing a fault's freeze frame under its row, with the range flags
 * from screens/garage/warn.js.
 *
 * The whole-vehicle read's detail pass captures the values the module held
 * when it logged the fault (F_UW<n>_TEXT / _WERT / _EINH). The printed sheet
 * has always shown them; the on-screen rows did not. This adds them to both
 * the live protocol view and a stored scan, through the same call, so the two
 * never drift.
 *
 * The labels and values are formatted by screens/faults.js (envLabel,
 * envValueText) -- the same helpers the module fault screen uses -- so a
 * freeze frame reads identically wherever it appears.
 */

/* exported garageAttachEnv, garageEnvRowHtml, garageEnvSummary */

/**
 * The freeze-frame block for one fault, or '' when the read captured none.
 * @param {object} code - the fault, with its detail merged in
 * @param {object} [ctx] - {screens} the module's IR for the script's own bands
 * @returns {string} markup
 */
function garageEnvRowHtml(code, ctx) {
  const checks =
    typeof garageEnvChecks === 'function' ? garageEnvChecks(code, ctx) : [];
  if (!checks.length) return '';
  const items = checks
    .map((f) => {
      const label =
        typeof envLabel === 'function' ? envLabel(f.label) : f.label;
      const value =
        typeof envValueText === 'function'
          ? envValueText(f.value, f.unit)
          : `${f.value} ${f.unit}`.trim();
      const w = f.warn;
      return (
        `<span class="garage-env${w ? ' garage-env-' + w.level : ''}"${
          w ? ` title="${esc(w.text)}"` : ''
        }>` +
        `<span class="garage-env-k">${esc(label)}</span>` +
        `<span class="garage-env-v">${esc(value)}</span>` +
        (w ? `<span class="garage-env-flag">${esc(w.source)}</span>` : '') +
        `</span>`
      );
    })
    .join('');
  // the reasons, once each, under the values that carry them
  const why = [
    ...new Map(
      checks.filter((f) => f.warn).map((f) => [f.warn.text, f.warn])
    ).values(),
  ]
    .map(
      (w) =>
        `<div class="garage-env-why garage-env-why-${esc(w.level)}">${esc(w.text)}</div>`
    )
    .join('');
  return `<div class="garage-envrow">${items}${why}</div>`;
}

/**
 * Add each fault's freeze frame under its detail row.
 *
 * The rows were drawn by the shared renderer (appendFaultDetailRows), which
 * emits one .quick-detail-row per fault in the module's code order -- the
 * same order walked here, which is how a block lands under its own fault.
 * @param {HTMLElement} el - the element the report was drawn into
 * @param {object} report - the report that was drawn
 * @param {object} [ctx] - {screensFor} async lookup of a module's IR
 * @returns {Promise<void>}
 */
async function garageAttachEnv(el, report, ctx) {
  if (!el || !report || typeof garageEnvChecks !== 'function') return;
  const c = ctx || {};
  const mods = (report.modules || []).filter((m) => (m.codes || []).length);
  // the rendered detail blocks, in the order the renderer emitted them
  const blocks = [...el.querySelectorAll('.quick-detail')];
  let bi = 0;
  for (const m of mods) {
    const block = blocks[bi++];
    if (!block) break;
    const screens = c.screensFor ? await c.screensFor(m.sgbd) : null;
    const rows = [...block.querySelectorAll('.quick-detail-row')];
    rows.forEach((row, i) => {
      const code = m.codes[i];
      if (!code) return;
      const html = garageEnvRowHtml(code, { screens });
      if (!html) return;
      row.insertAdjacentHTML('afterend', html);
    });
  }
}

/**
 * Whether a fault's freeze frame differs between two reads, and how. Used by
 * the comparison to mark a fault that is still stored but was logged again
 * with different values.
 * @param {object} a - the older fault
 * @param {object} b - the newer fault
 * @returns {{recurred: boolean, changed: string[]}}
 */
function garageEnvSummary(a, b) {
  const keys = typeof garageEnvKeys === 'function' ? garageEnvKeys : null;
  if (!keys) return { recurred: false, changed: [] };
  const A = new Map(keys(a || {}).map((f) => [f.label, f.value]));
  const B = new Map(keys(b || {}).map((f) => [f.label, f.value]));
  const changed = [];
  for (const [k, v] of B) if (A.has(k) && A.get(k) !== v) changed.push(k);
  // the occurrence counter moving is the module saying it logged this again
  const countA = Number(a && (a.F_HFK != null ? a.F_HFK : a.F_LZ));
  const countB = Number(b && (b.F_HFK != null ? b.F_HFK : b.F_LZ));
  const counted = isFinite(countA) && isFinite(countB) && countB > countA;
  return { recurred: counted || changed.length > 0, changed };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { garageEnvRowHtml, garageAttachEnv, garageEnvSummary };
}
