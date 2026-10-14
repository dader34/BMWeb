/**
 * @file Tuning > table dialog, live mode: a correction worked out cell by
 * cell from the DME's own lambda control. While the cursor runs over a
 * fuel table, each sample's short-term trim (what the lambda controller is
 * adding or taking away to hold the target) is credited to the cells the
 * DME was interpolating between, by their share. The mean trim over a cell
 * is the change that cell wants: a table cell the controller keeps adding
 * 4 % to is 4 % lean there. Apply writes that change, scaled and capped,
 * through the dialog's ordinary edit path, so in live mode it reaches the
 * car at once and can be undone like any edit.
 *
 * Only samples in closed loop count (the trim is held at exactly zero when
 * the controller is off: cold, full load, overrun) and only once the engine
 * is warm. The two banks are averaged unless one is picked.
 *
 * Pure parts first (node-tested): tnCorrectNew, tnCorrectCredit,
 * tnCorrectPlan. The rest is the dialog's bar and the grid's badges.
 */
/* exported tnCorrectNew, tnCorrectCredit, tnCorrectPlan, tnCorrectWire, tnCorrectSample */

/** The engine is warm enough for the trim to mean the table, °C. */
const TN_CORRECT_MIN_COOLANT = 70;
/** A cell wants this many samples' worth of weight before it is changed. */
const TN_CORRECT_MIN_WEIGHT = 10;
/** The most one Apply moves a cell, as a fraction. */
const TN_CORRECT_MAX_STEP = 0.15;
/** The lambda control values the DME keeps as plain variables, per bank. */
const TN_CORRECT_TRIMS = [
  [0x4116, 'bank 1'],
  [0x4117, 'bank 2'],
];
const TN_CORRECT_COOLANT = 0x411f;

/**
 * A fresh accumulator for a table.
 * @param {number} rows
 * @param {number} cols
 * @returns {{rows: number, cols: number, sum: Float64Array, weight: Float64Array,
 *   samples: number, skipped: number, bank: 'both'|'1'|'2', on: boolean}}
 */
function tnCorrectNew(rows, cols) {
  return {
    rows,
    cols,
    sum: new Float64Array(rows * cols),
    weight: new Float64Array(rows * cols),
    samples: 0,
    skipped: 0,
    bank: 'both',
    on: false,
  };
}

/**
 * Credit one sample's trim to the cells around a position, each by its
 * share of the interpolation (the same shares the DME used).
 * @param {ReturnType<typeof tnCorrectNew>} acc
 * @param {number} row - May be fractional; 0 for a one-row table.
 * @param {number} col - May be fractional; 0 for a one-column table.
 * @param {number} trim - The controller's correction as a fraction (+0.04: 4 % more fuel).
 * @returns {void}
 */
function tnCorrectCredit(acc, row, col, trim) {
  const r0 = Math.min(acc.rows - 1, Math.max(0, Math.floor(row)));
  const c0 = Math.min(acc.cols - 1, Math.max(0, Math.floor(col)));
  const r1 = Math.min(acc.rows - 1, r0 + 1);
  const c1 = Math.min(acc.cols - 1, c0 + 1);
  const fr = Math.min(1, Math.max(0, row - r0));
  const fc = Math.min(1, Math.max(0, col - c0));
  const put = (r, c, w) => {
    if (w <= 0) return;
    const i = r * acc.cols + c;
    acc.sum[i] += trim * w;
    acc.weight[i] += w;
  };
  put(r0, c0, (1 - fr) * (1 - fc));
  put(r0, c1, (1 - fr) * fc);
  put(r1, c0, fr * (1 - fc));
  put(r1, c1, fr * fc);
  acc.samples++;
}

/**
 * The cells ready to change and their new values.
 * @param {ReturnType<typeof tnCorrectNew>} acc
 * @param {Array<Array<number|null>>} cells - The table's values now.
 * @param {number} factor - How much of the mean trim to apply, 0..1.
 * @returns {{values: Array<[number, number, number]>, ready: number, capped: number}}
 *   `values` as the dialog's bulk apply takes them; `ready` cells with
 *   enough samples; `capped` those whose step hit the limit.
 */
function tnCorrectPlan(acc, cells, factor) {
  const values = [];
  let ready = 0;
  let capped = 0;
  for (let r = 0; r < acc.rows; r++)
    for (let c = 0; c < acc.cols; c++) {
      const i = r * acc.cols + c;
      if (acc.weight[i] < TN_CORRECT_MIN_WEIGHT) continue;
      const cur = cells[r] ? cells[r][c] : null;
      if (cur == null || !Number.isFinite(cur)) continue;
      ready++;
      let step = (acc.sum[i] / acc.weight[i]) * factor;
      if (Math.abs(step) > TN_CORRECT_MAX_STEP) {
        step = Math.sign(step) * TN_CORRECT_MAX_STEP;
        capped++;
      }
      values.push([r, c, cur * (1 + step)]);
    }
  return { values, ready, capped };
}

/**
 * The variables the sampler reads, resolved from the value table once.
 * @returns {{trims: Array<{address:number,size:number,signed:boolean,a:number,b:number}|null>,
 *   coolant: {address:number,size:number,signed:boolean,a:number,b:number}|null}|null}
 */
function tnCorrectInputs() {
  if (typeof MS45_VALUE_MAP === 'undefined') return null;
  const of = (id) => {
    const v = MS45_VALUE_MAP.values[id];
    return v
      ? { address: v[0], size: v[1], signed: !!v[2], a: v[3], b: v[4] }
      : null;
  };
  return {
    trims: TN_CORRECT_TRIMS.map(([id]) => of(id)),
    coolant: of(TN_CORRECT_COOLANT),
  };
}

/**
 * Called by the cursor with every position it drew: credit the sample.
 * @param {TableModal} m
 * @param {{index: number}|null} col
 * @param {{index: number}|null} row
 * @param {Array<{address: number, bytes: Uint8Array}>} blocks - What the cursor read.
 * @returns {void}
 */
function tnCorrectSample(m, col, row, blocks) {
  const acc = m.correct;
  if (!acc || !acc.on || !m.correctInputs) return;
  if ((m.t.cols > 1 && !col) || (m.t.rows > 1 && !row)) return;
  const read = (v) => {
    if (!v) return null;
    const raw = ltCursorValue(v, blocks);
    return raw == null ? null : raw * v.a + v.b;
  };
  const coolant = read(m.correctInputs.coolant);
  if (coolant != null && coolant < TN_CORRECT_MIN_COOLANT) {
    acc.skipped++;
    tnCorrectPaint(m);
    return;
  }
  const banks = acc.bank === 'both' ? [0, 1] : acc.bank === '1' ? [0] : [1];
  const trims = banks
    .map((k) => read(m.correctInputs.trims[k]))
    .filter((t) => t != null && t !== 0); // held at zero: open loop
  if (!trims.length) {
    acc.skipped++;
    tnCorrectPaint(m);
    return;
  }
  const trim = trims.reduce((s, t) => s + t, 0) / trims.length / 100;
  tnCorrectCredit(acc, row ? row.index : 0, col ? col.index : 0, trim);
  tnCorrectPaint(m);
}

/**
 * Show the mean trim on each cell: an underline, red for more fuel wanted,
 * blue for less, stronger with the size, solid once the cell has enough.
 * @param {TableModal} m
 * @returns {void}
 */
function tnCorrectPaint(m) {
  const acc = m.correct;
  if (!acc || !m.gridWrap) return;
  let ready = 0;
  for (const inp of m.gridWrap.querySelectorAll('.tn-cell')) {
    const r = Number(inp.dataset.r);
    const c = Number(inp.dataset.c);
    const i = r * acc.cols + c;
    if (!acc.on || !acc.weight[i]) {
      inp.style.boxShadow = '';
      inp.title = '';
      continue;
    }
    const mean = acc.sum[i] / acc.weight[i];
    const enough = acc.weight[i] >= TN_CORRECT_MIN_WEIGHT;
    if (enough) ready++;
    const f = Math.min(1, Math.abs(mean) / 0.1);
    const colour =
      mean >= 0
        ? `rgba(255, 96, 64, ${enough ? 0.45 + 0.5 * f : 0.25})`
        : `rgba(80, 150, 255, ${enough ? 0.45 + 0.5 * f : 0.25})`;
    inp.style.boxShadow = `inset 0 -4px 0 ${colour}`;
    inp.title = `${mean >= 0 ? '+' : ''}${(mean * 100).toFixed(1)} % over ${acc.weight[i].toFixed(1)} samples${enough ? '' : ' (not enough yet)'}`;
  }
  if (m.correctStatus)
    m.correctStatus.textContent = acc.on
      ? `${acc.samples} samples · ${ready} cells ready` +
        (acc.skipped ? ` · ${acc.skipped} skipped (cold or open loop)` : '')
      : 'off';
}

/**
 * The dialog's correction bar: on/off, the bank, how much to apply, Apply
 * and Clear. Only on a live DME whose value table is known.
 * @param {TableModal} m
 * @returns {void}
 */
function tnCorrectWire(m) {
  const bar = m.box.querySelector('.tn-correct-bar');
  const toggle = m.box.querySelector('.tn-correct-toggle');
  if (!bar || !toggle) return;
  // the samples only come while live mode runs the cursor, but the bar is
  // offered whenever the DME's trims are known: a dialog opened before the
  // link came up should not have to be opened again
  // testing only, like the protections: offered on a local build, never on
  // the public site, until it has been proven on a running engine
  const local = typeof fbProtectTesting === 'function' && fbProtectTesting();
  const fit = local && m.invertible && m.t.rows * m.t.cols > 1;
  m.correctInputs = tnCorrectInputs();
  if (!fit || !m.correctInputs || !m.correctInputs.trims.some(Boolean)) {
    toggle.hidden = true;
    return;
  }
  m.correct = tnCorrectNew(m.t.rows, m.t.cols);
  m.correctStatus = bar.querySelector('.tn-correct-status');
  // the two choices are segmented groups: the pressed button is the value
  const seg = (group, onPick) => {
    group.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      for (const x of group.querySelectorAll('button'))
        x.classList.toggle('on', x === b);
      onPick(b.dataset.v);
    };
  };
  seg(bar.querySelector('.tn-correct-bank'), (v) => {
    m.correct.bank = /** @type {'both'|'1'|'2'} */ (v);
  });
  let factor = 0.5;
  seg(bar.querySelector('.tn-correct-factor'), (v) => {
    factor = Number(v);
  });
  toggle.onclick = () => {
    m.correct.on = !m.correct.on;
    toggle.classList.toggle('active', m.correct.on);
    bar.hidden = !m.correct.on;
    tnCorrectPaint(m);
  };
  bar.querySelector('.tn-correct-clear').onclick = () => {
    const was = m.correct;
    m.correct = tnCorrectNew(m.t.rows, m.t.cols);
    m.correct.on = was.on;
    m.correct.bank = was.bank;
    tnCorrectPaint(m);
  };
  bar.querySelector('.tn-correct-apply').onclick = () => {
    const plan = tnCorrectPlan(m.correct, m.t.cells, factor);
    if (!plan.values.length) {
      m.correctStatus.textContent = 'no cell has enough samples yet';
      return;
    }
    const res = tnTableApplyMany(m, plan.values, 'Lambda correction');
    const was = m.correct;
    m.correct = tnCorrectNew(m.t.rows, m.t.cols);
    m.correct.on = was.on;
    m.correct.bank = was.bank;
    tnCorrectPaint(m);
    m.correctStatus.textContent =
      `${res.n} cell${res.n === 1 ? '' : 's'} corrected` +
      (plan.capped
        ? `, ${plan.capped} held to ±${TN_CORRECT_MAX_STEP * 100} %`
        : '') +
      ' · collecting again';
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TN_CORRECT_MIN_WEIGHT,
    TN_CORRECT_MAX_STEP,
    tnCorrectNew,
    tnCorrectCredit,
    tnCorrectPlan,
  };
}
