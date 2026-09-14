/**
 * @file Drawing a workshop reference document.
 *
 * Four body shapes come out of the extract and each wants its own treatment:
 * a torque table is columns (part, thread, step, figure, unit) and must stay
 * columns; a technical-data sheet is a CALS table with its own header row; a
 * fluids chapter is prose with lists; a special tool is a couple of numbers
 * and a name. The generic block list covers what is left.
 *
 * UNITS TRAVEL WITH THEIR NUMBER, always. A torque figure without its Nm is
 * not a smaller piece of information, it is a dangerous one, so the unit is
 * rendered in the same cell as the value rather than as a column heading
 * that a narrow screen might scroll away from.
 */

/* exported techDataDocHtml techDataRowsHtml */

/**
 * A CALS table's rows as HTML. The first row is treated as a header when the
 * source marked one; otherwise every row is a body row.
 * @param {string[][]} rows - the cells
 * @param {boolean} [head] - draw the first row as a header
 * @returns {string} HTML
 */
function techDataRowsHtml(rows, head) {
  if (!rows || !rows.length) return '';
  const cols = Math.max(...rows.map((r) => r.length));
  const cell = (r, tag) =>
    `<tr>${Array.from(
      { length: cols },
      (_, i) => `<${tag}>${esc(r[i] || '')}</${tag}>`
    ).join('')}</tr>`;
  const body = rows.slice(head ? 1 : 0).map((r) => cell(r, 'td'));
  return (
    `<div class="td-table-wrap"><table class="td-table">` +
    (head ? `<thead>${cell(rows[0], 'th')}</thead>` : '') +
    `<tbody>${body.join('')}</tbody></table></div>`
  );
}

/**
 * The generic typed blocks the extract emits for prose.
 * @param {Array<object>} blocks - p / bullet / table blocks
 * @returns {string} HTML
 */
function techDataBlocksHtml(blocks) {
  if (!blocks || !blocks.length) return '';
  const out = [];
  let bullets = [];
  const flush = () => {
    if (bullets.length)
      out.push(`<ul class="td-list">${bullets.join('')}</ul>`);
    bullets = [];
  };
  for (const b of blocks) {
    if (!b) continue;
    if (b.t === 'bullet') {
      bullets.push(`<li>${esc(b.s || '')}</li>`);
      continue;
    }
    flush();
    if (b.t === 'p') out.push(`<p class="td-p">${esc(b.s || '')}</p>`);
    else if (b.t === 'table') out.push(techDataRowsHtml(b.rows, true));
  }
  flush();
  return out.join('');
}

/**
 * The torque rows as their own table.
 *
 * Per-row engine validity is shown as a tag rather than a column: one table
 * usually serves several engines and only some rows narrow it, so a column
 * would be mostly empty while a tag sits where it is read -- next to the
 * figure it qualifies.
 * @param {Array<object>} rows - the torque entries
 * @returns {string} HTML
 */
function techDataTorquesHtml(rows) {
  if (!rows || !rows.length) return '';
  const anyThread = rows.some((r) => r.thread);
  const anyStep = rows.some((r) => r.step);
  const head =
    `<tr><th>Part</th>` +
    (anyThread ? `<th>Thread</th>` : '') +
    (anyStep ? `<th>Step</th>` : '') +
    `<th>Torque</th></tr>`;
  const body = rows
    .map((r) => {
      const tags = (r.engines || [])
        .map((e) => `<span class="td-tag">${esc(e)}</span>`)
        .join('');
      const torque = [r.torque, r.unit].filter(Boolean).join(' ');
      return (
        `<tr><td>${esc(r.part || '')}${tags}</td>` +
        (anyThread ? `<td class="mono">${esc(r.thread || '')}</td>` : '') +
        (anyStep ? `<td>${esc(r.step || '')}</td>` : '') +
        `<td class="td-torque mono">${esc(torque)}</td></tr>`
      );
    })
    .join('');
  return (
    `<div class="td-table-wrap"><table class="td-table td-torques">` +
    `<thead>${head}</thead><tbody>${body}</tbody></table></div>`
  );
}

/**
 * The validity strip: which engines and models a technical-data sheet is for.
 * @param {Array<object>} vals - the VALIDITY dicts
 * @returns {string} HTML
 */
function techDataValidityHtml(vals) {
  if (!vals || !vals.length) return '';
  const bits = [];
  for (const v of vals) {
    const line = ['brand', 'series', 'engine', 'addition', 'transmission']
      .map((k) => v[k])
      .filter(Boolean)
      .join(' ');
    if (line) bits.push(`<span class="td-tag">${esc(line)}</span>`);
  }
  if (!bits.length) return '';
  return `<div class="td-validity">Applies to ${bits.join('')}</div>`;
}

/**
 * One document, drawn.
 * @param {object} doc - the index entry
 * @param {object|null} body - its body, or null when it did not load
 * @returns {string} HTML
 */
function techDataDocHtml(doc, body) {
  const group = [doc.mainGroup, doc.mainGroupName].filter(Boolean).join(' ');
  const sub = [doc.subGroup, doc.subGroupName].filter(Boolean).join(' ');
  const head =
    `<div class="td-doc-head">` +
    `<div class="td-doc-crumb">${esc(doc.type || '')}` +
    (group ? ` · ${esc(group)}` : '') +
    (sub ? ` · ${esc(sub)}` : '') +
    `</div>` +
    `<h3 class="td-doc-title">${esc(doc.title || '(untitled)')}</h3>` +
    (doc.unsure
      ? `<div class="td-unsure">This document's applicability could not be ` +
        `read, so it is shown for every car. Check the validity above ` +
        `before using it.</div>`
      : '') +
    `</div>`;

  if (!body)
    return (
      head +
      `<div class="td-none">This document's body is not in this build.</div>`
    );

  const parts = [head];
  if (body.headline)
    parts.push(`<div class="td-headline">${esc(body.headline)}</div>`);
  parts.push(techDataValidityHtml(body.validity));
  // a special tool leads with its numbers: that is what someone came for
  if (body.toolNumber || body.toolNumberOld) {
    const rows = [
      ['Tool number', body.toolNumber],
      ['Previous number', body.toolNumberOld],
      ['Designation', body.designation],
      ['Category', body.category],
      ['Note', body.remark],
    ].filter((r) => r[1]);
    parts.push(
      `<table class="td-table td-tool"><tbody>` +
        rows
          .map(
            (r) =>
              `<tr><th scope="row">${esc(r[0])}</th>` +
              `<td class="mono">${esc(r[1])}</td></tr>`
          )
          .join('') +
        `</tbody></table>`
    );
  }
  if (body.hints && body.hints.length)
    parts.push(
      body.hints.map((h) => `<div class="td-hint">${esc(h)}</div>`).join('')
    );
  if (body.torques) parts.push(techDataTorquesHtml(body.torques));
  parts.push(techDataBlocksHtml(body.blocks));

  const drawn = parts.filter(Boolean).join('');
  return drawn === head
    ? head + `<div class="td-none">This document has no body text.</div>`
    : drawn;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    techDataRowsHtml,
    techDataBlocksHtml,
    techDataTorquesHtml,
    techDataValidityHtml,
    techDataDocHtml,
  };
}
