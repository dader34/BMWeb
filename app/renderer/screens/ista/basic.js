/**
 * @file Operations / New / Basic Features: open a vehicle without a VIN.
 *
 * THE OTHER WAY IN. The VIN page needs a number off the car. This one is for
 * when you have the car in front of you and not its papers: you pick what it
 * IS -- a 3', an E46, a Coupe, an M54 -- and the page narrows to the vehicle
 * those choices describe. ISTA calls the choices "basic features" and lays
 * them out in three panes: the criteria on the left, the values of whichever
 * criterion is selected in the middle, and the choices made so far on the
 * right. That is what this draws.
 *
 * THE VALUES ARE THE CATALOGUE'S, NOT A LIST WE WROTE. Every option in the
 * middle pane is read out of the parts catalogue's own VIN index, whose
 * variant rows carry exactly the fields the criteria ask for (chassis,
 * model, body, engine, steering, model code). So the page can only ever
 * offer combinations that exist, and picking one resolves to a real vehicle
 * rather than to a description nobody built. A criterion the index cannot
 * answer is listed and disabled rather than hidden, because a missing row
 * reads as a tool that has forgotten the question.
 *
 * WHY MODEL CODE IS GONE. The real tool's Model code tab asks for the same
 * four-character type key this page offers as one criterion among ten, and
 * a second way in is a second answer to "which car is this". It is a column
 * here instead of a tab of its own.
 */

/* exported istaBasicCriteria istaBasicOptions istaBasicMatches
   istaBasicChoices istaPageBasic */

/**
 * The criteria, in the tool's own order.
 *
 * `key` names the field on a catalogue variant row. A criterion with no key
 * is one the catalogue does not carry: it is listed, and disabled, so the
 * reader can see the tool asks the question and that this build cannot
 * answer it.
 * @type {Array<{id: string, label: string, key: string|null}>}
 */
const ISTA_BASIC_CRITERIA = [
  { id: 'series', label: 'Model series', key: 'model' },
  { id: 'chassis', label: 'Development code', key: 'chassis' },
  { id: 'body', label: 'Body', key: 'body' },
  { id: 'sales', label: 'Sales designation', key: null },
  { id: 'engine', label: 'Engine', key: 'motor' },
  { id: 'emachine', label: 'Electrical machine', key: null },
  { id: 'basic', label: 'Basic version', key: null },
  { id: 'steering', label: 'Steering', key: 'steer' },
  { id: 'transmission', label: 'Transmission', key: null },
  { id: 'code', label: 'Model code', key: 'mospid' },
  { id: 'year', label: 'Model year', key: '_year' },
  { id: 'month', label: 'Model month', key: '_month' },
];

/**
 * The criteria a build can actually offer.
 * @returns {Array<object>} the criteria, each with `ok`
 */
function istaBasicCriteria() {
  return ISTA_BASIC_CRITERIA.map((c) => Object.assign({ ok: !!c.key }, c));
}

/**
 * One catalogue variant, as the criteria see it.
 *
 * The index stores a variant as a positional array and the build date on the
 * RANGE that points at it, so a row is only complete once the two are put
 * together. Year and month are derived here rather than stored, because the
 * catalogue keeps a full date and the criteria ask for its halves.
 * @param {object} idx - the VIN index
 * @param {number} vi - the variant's position
 * @param {string|number} prod - the range's production date
 * @returns {object} a flat row
 */
function istaBasicRow(idx, vi, prod) {
  const v = (idx.variants || [])[vi] || [];
  const p = String(prod || '');
  return {
    chassis: v[0] || '',
    mospid: v[1] || '',
    model: v[2] || '',
    body: v[3] || '',
    motor: v[4] || '',
    steer: v[5] || '',
    _year: p.length >= 4 ? p.slice(0, 4) : '',
    _month: p.length >= 6 ? p.slice(4, 6) : '',
  };
}

/**
 * Every variant row the index holds, flattened once.
 *
 * The index is a list of production-number RANGES, each naming a variant, so
 * the same variant appears under many ranges. They are folded by the
 * criteria that distinguish them, which is what keeps the middle pane a list
 * of choices rather than a list of production batches.
 * @param {object|null} idx - the VIN index
 * @returns {object[]} the distinct rows
 */
function istaBasicRows(idx) {
  if (!idx || !idx.ranges) return [];
  const seen = new Map();
  for (const r of idx.ranges) {
    const row = istaBasicRow(idx, r[2], r[3]);
    const key = [
      row.chassis,
      row.mospid,
      row.model,
      row.body,
      row.motor,
      row.steer,
      row._year,
      row._month,
    ].join('|');
    if (!seen.has(key)) seen.set(key, row);
  }
  return [...seen.values()];
}

/**
 * The rows still possible once the picked criteria are applied.
 * @param {object[]} rows - every row
 * @param {Object<string, string>} picked - criterion id to value
 * @returns {object[]} the rows that match all of them
 */
function istaBasicMatches(rows, picked) {
  const want = Object.entries(picked || {});
  if (!want.length) return rows;
  const keyOf = (id) =>
    (ISTA_BASIC_CRITERIA.find((c) => c.id === id) || {}).key;
  return rows.filter((row) =>
    want.every(([id, val]) => {
      const k = keyOf(id);
      if (!k) return true;
      const raw = String(row[k] || '');
      // the pick is what the reader saw, so the row's own value is put
      // through the same label before they are compared
      return raw === String(val) || istaBasicLabel(id, raw) === String(val);
    })
  );
}

/**
 * The values one criterion can still take, given the others.
 *
 * Only the OTHER choices narrow the list: a criterion must keep offering its
 * own alternatives after one of them is picked, or changing your mind would
 * mean starting over.
 * @param {object[]} rows - every row
 * @param {Object<string, string>} picked - criterion id to value
 * @param {string} id - the criterion being listed
 * @returns {string[]} its values, sorted
 */
function istaBasicOptions(rows, picked, id) {
  const c = ISTA_BASIC_CRITERIA.find((x) => x.id === id);
  if (!c || !c.key) return [];
  const others = Object.assign({}, picked);
  delete others[id];
  const out = new Set();
  for (const row of istaBasicMatches(rows, others)) {
    const v = row[c.key];
    if (v) out.add(String(v));
  }
  return [...out].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

/**
 * The values one criterion offers, as the reader sees them.
 *
 * DEDUPED BY LABEL, not by the raw value behind it. Model series is the
 * series ("3'"), and a dozen model names collapse onto it -- so listing the
 * raw values gives a column of "3'" repeated a dozen times. The first raw
 * value for each label is kept as what a click selects, and picking it
 * matches every row that shares the label.
 * @param {object[]} rows - every row
 * @param {Object<string, string>} picked - criterion id to value
 * @param {string} id - the criterion being listed
 * @returns {Array<{label: string, values: string[]}>} its choices
 */
function istaBasicChoices(rows, picked, id) {
  /** @type {Map<string, string[]>} */
  const by = new Map();
  for (const v of istaBasicOptions(rows, picked, id)) {
    const label = istaBasicLabel(id, v);
    if (!by.has(label)) by.set(label, []);
    by.get(label).push(v);
  }
  return [...by.entries()].map(([label, values]) => ({ label, values }));
}

/**
 * Operations / New / Basic Features.
 * @param {HTMLElement} host - where to draw
 * @param {object} ctx - the shell's hooks
 * @param {object|null} ctx.idx - the VIN index
 * @param {(n: number, row: object|null) => void} ctx.onChange - narrowed
 * @returns {void}
 */
function istaPageBasic(host, ctx) {
  const rows = istaBasicRows(ctx.idx);
  /** @type {Object<string, string>} */
  const picked = {};
  let active = 'series';

  /** Redraw all three panes. */
  function paint() {
    const crits = istaBasicCriteria();
    const left = crits
      .map(
        (c) =>
          `<div class="irbf-row${c.id === active ? ' on' : ''}` +
          `${c.ok ? '' : ' off'}" data-c="${esc(c.id)}">` +
          `${esc(c.label)}</div>`
      )
      .join('');

    const cur = crits.find((c) => c.id === active) || crits[0];
    const opts = cur.ok ? istaBasicChoices(rows, picked, cur.id) : [];
    const mid = cur.ok
      ? opts
          .map(
            (o) =>
              `<div class="irbf-row${
                picked[cur.id] === o.label ? ' on' : ''
              }" data-v="${esc(o.label)}">${esc(o.label)}</div>`
          )
          .join('')
      : `<div class="irbf-none">The parts catalogue does not carry this ` +
        `feature, so it cannot be chosen here.</div>`;

    const chosen = crits
      .map((c) => {
        const v = picked[c.id];
        return (
          `<div class="irbf-row${v ? ' has' : ''}" data-x="${esc(c.id)}">` +
          `<span class="irbf-k">${esc(c.label)}</span>` +
          (v
            ? `<span class="irbf-v">${esc(istaBasicLabel(c.id, v))}</span>`
            : '') +
          `</div>`
        );
      })
      .join('');

    host.innerHTML =
      `<div class="irbf">` +
      `<div class="irbf-pane"><div class="irbf-head">Basic features</div>` +
      `<div class="irbf-list">${left}</div></div>` +
      `<div class="irbf-pane"><div class="irbf-head">${esc(cur.label)}</div>` +
      `<div class="irbf-list">${mid}</div></div>` +
      `<div class="irbf-pane irbf-sel">` +
      `<div class="irbf-head">Selected basic features</div>` +
      `<div class="irbf-list">${chosen}</div></div>` +
      `</div>`;

    host.querySelectorAll('[data-c]').forEach((el) => {
      el.onclick = () => {
        active = el.dataset.c;
        paint();
      };
    });
    host.querySelectorAll('[data-v]').forEach((el) => {
      el.onclick = () => {
        // clicking the chosen value again clears it, which is how a reader
        // backs out of a choice without reloading the page
        if (picked[cur.id] === el.dataset.v) delete picked[cur.id];
        else picked[cur.id] = el.dataset.v;
        paint();
      };
    });
    host.querySelectorAll('[data-x]').forEach((el) => {
      el.onclick = () => {
        delete picked[el.dataset.x];
        paint();
      };
    });

    const left2 = istaBasicMatches(rows, picked);
    if (ctx.onChange)
      ctx.onChange(left2.length, left2.length === 1 ? left2[0] : null);
  }

  host._istaBasic = () => {
    const m = istaBasicMatches(rows, picked);
    return { picked, matches: m };
  };
  paint();
}

/**
 * A value as the tool writes it.
 * @param {string} id - the criterion
 * @param {string} v - the raw value
 * @returns {string} the label
 */
function istaBasicLabel(id, v) {
  if (id === 'body' && typeof bodyLabel === 'function')
    return typeof istaAscii === 'function'
      ? istaAscii(bodyLabel(v))
      : bodyLabel(v);
  if (id === 'steering') return v === 'R' ? 'Right (RL)' : 'Left (LL)';
  if (id === 'series' && typeof istaSeries === 'function') return istaSeries(v);
  return v;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ISTA_BASIC_CRITERIA,
    istaBasicCriteria,
    istaBasicRow,
    istaBasicRows,
    istaBasicMatches,
    istaBasicOptions,
    istaBasicChoices,
    istaBasicLabel,
    istaPageBasic,
  };
}
