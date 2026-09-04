// Shared renderer for ISTA "typed blocks" -- the {t:'p'|'bullet'|'h'|'table'}
// shape the fault viewer and the reference-documents screen both produce. Both
// used to carry their own near-identical copy of this; this is the single
// version, with the two behaviours that differed between them made options so
// each caller keeps its exact output:
//
//   opts.legend   detect ISTA "legend" tables (repeating key|label pairs, e.g.
//                 1|Pedal|2|Sensor) and render them as a key/label list rather
//                 than a grid. (Fault viewer wants this; the document screen's
//                 pin tables are real grids, so it does not.)
//   opts.breaks   turn newlines inside prose/bullets into <br> (the document
//                 screen keeps a HINT title + its sub-lines as separate lines;
//                 the fault viewer does not).
//
// Block shapes:
//   {t:'p', s}       prose paragraph
//   {t:'bullet', s}  list item
//   {t:'h', s}       sub-heading inside a chapter
//   {t:'table', rows:[[cell,...], ...]}  first row is the header

// key that looks like an ISTA legend marker: a 1-2 digit number, or a short
// letter code optionally followed by digits (A, X12, ABS3...)
function _tbIsLegendKey(s) {
  return /^([0-9]{1,2}|[A-Z]{1,4}\s?[0-9]{0,2})$/.test(String(s).trim());
}

function _tbInline(s, breaks) {
  const e = esc(s);
  return breaks ? e.replace(/\n/g, '<br>') : e;
}

// One typed block -> HTML string. `esc` is the app-global escaper.
function renderTpBlock(b, opts = {}) {
  if (b.t === 'h') return `<div class="fm-tp-subh">${esc(b.s)}</div>`;
  if (b.t === 'p')
    return `<p class="fm-tp-p">${_tbInline(b.s, opts.breaks)}</p>`;
  if (b.t === 'bullet') {
    return `<p class="fm-tp-p fm-tp-bullet">${_tbInline(b.s, opts.breaks)}</p>`;
  }
  if (b.t !== 'table' || !b.rows || !b.rows.length) return '';
  const cols = Math.max(...b.rows.map((r) => r.length));

  if (opts.legend) {
    // even columns are keys, odd are their labels, repeating
    const looksLegend =
      cols >= 2 &&
      cols % 2 === 0 &&
      b.rows.every((r) => {
        for (let i = 0; i < r.length; i += 2) {
          if (r[i] && !_tbIsLegendKey(r[i])) return false;
        }
        return true;
      });
    if (looksLegend) {
      const pairs = [];
      for (const r of b.rows) {
        for (let i = 0; i + 1 < r.length; i += 2) {
          if (r[i] || r[i + 1]) pairs.push([r[i], r[i + 1]]);
        }
      }
      return pairs
        .map(
          ([k, v]) =>
            `<div class="fm-tp-leg">` +
            `<span class="fm-tp-leg-k">${esc(k)}</span>` +
            `<span>${esc(v)}</span></div>`
        )
        .join('');
    }
  }

  // a plain grid, sized to the widest row; first row is the header
  const rows = b.rows
    .map((r, ri) => {
      const cells = [];
      for (let i = 0; i < cols; i++) {
        cells.push(
          `<span class="fm-tp-td${ri === 0 ? ' fm-tp-th' : ''}">` +
            `${esc(r[i] || '')}</span>`
        );
      }
      return `<div class="fm-tp-tr">${cells.join('')}</div>`;
    })
    .join('');
  return `<div class="fm-tp-table" style="--cols:${cols}">${rows}</div>`;
}

// One chapter {heading, blocks:[...]} -> HTML (heading + its blocks). Tolerates
// the older flat `paras` shape the fault viewer still guards for.
function renderTpChapter(ch, opts = {}) {
  const head = ch.heading
    ? `<div class="fm-tp-h">${esc(ch.heading)}</div>`
    : '';
  const items =
    ch.blocks ||
    (ch.paras || []).map((p) =>
      p.startsWith('• ') ? { t: 'bullet', s: p.slice(2) } : { t: 'p', s: p }
    );
  const body = items.map((b) => renderTpBlock(b, opts)).join('');
  return `<div class="fm-tp-chap">${head}${body}</div>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { renderTpBlock, renderTpChapter };
}
