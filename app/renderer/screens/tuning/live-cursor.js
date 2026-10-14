/**
 * @file Tuning screen: the live cursor. While live mode is armed and a table
 * is open, the cell the DME is reading right now is lit, the way a tuner's
 * map trace does.
 *
 * The position is worked out here, not on the DME: the variables behind the
 * table's axes are read off the car and searched against the break points
 * (core/livetune-cursor.js). A request costs the K line far more in
 * turnaround than in bytes, so the variables are fetched in one: the DME's
 * own packet (2C F0 names the pieces once, 21 F0 reads them all). Refreshes
 * are one at a time, a few a second, and always give way to an edit.
 */
/* exported tnPacketLent, tnLivePlan, tnLiveLineBusy, tnLiveCursorAttach, tnLiveCursorDetach, tnLiveCursorReplan */

/** Rest between two refreshes, once one has finished. */
const TN_CURSOR_REST_MS = 200;
/** How soon to look again while an edit is on the wire. */
const TN_CURSOR_YIELD_MS = 150;
/** How long to leave the line alone after a read failed, or when nothing can be shown. */
const TN_CURSOR_BACKOFF_MS = 1500;
/** After an edit the cursor keeps out of the way this long: the user is
 *  working, edits are what the line is for, and the cursor is company. */
const TN_CURSOR_EDIT_QUIET_MS = 4000;
/** Its rest between refreshes during that time. */
const TN_CURSOR_EDIT_REST_MS = 800;
/** A position older than this is greyed in the toolbar: the car has stopped answering. */
const TN_CURSOR_STALE_MS = 1500;

/** The one table dialog the cursor is following, and its timer. */
const tnCursor = { m: null, timer: null };

/**
 * What stays the same about an axis between refreshes, by the axis object:
 * where each break point is stored and how to show a value. A dialog that
 * decodes its table again gets new axis objects, so these go with the old.
 * @type {WeakMap<XdfAxis, {specs:object[], top:number, show:(raw:number)=>string}|null>}
 */
const tnCursorAxes = new WeakMap();

/**
 * An axis as the cursor needs it: where its break points are, what they are
 * (as stored, unsigned -- the DME compares them that way), and how to show a
 * value on it. The points are read again each time: one may just have been
 * edited.
 * @param {TableModal} m
 * @param {XdfAxis|undefined} axis
 * @param {number} count - Break points the grid shows for it.
 * @returns {{first:number, points:number[], units:string, show:(raw:number)=>string}|null}
 *   null for an axis with no address (labels only) or outside the calibration.
 */
function tnLiveCursorAxis(m, axis, count) {
  if (!axis || !axis.embed || !axis.embed.address) return null;
  let fixed = tnCursorAxes.get(axis);
  if (fixed === undefined || (fixed && fixed.specs.length !== count)) {
    fixed = null;
    const spec = window.XDF.resolveEmbedded(
      axis.embed,
      m.h.baseOffset,
      m.h.defaults
    );
    if (spec.address >= TN_CAL_START && spec.address < TN_CAL_END) {
      const bytes = Math.max(1, Math.ceil(spec.sizeBits / 8));
      let convert = (v) => v;
      try {
        convert = window.XDF.compileMath(axis.mathEquation);
      } catch (e) {
        /* shown as stored */
      }
      const dp =
        axis.decimalpl != null ? axis.decimalpl : m.h.defaults.sigdigits;
      fixed = {
        specs: Array.from({ length: count }, (_, i) =>
          Object.assign({}, spec, { address: spec.address + i * bytes })
        ),
        top: 2 ** (8 * bytes),
        show: (raw) => fmtNum(convert(raw), dp),
      };
    }
    tnCursorAxes.set(axis, fixed);
  }
  if (!fixed) return null;
  const points = fixed.specs.map((spec) => {
    const raw = window.XDF.readScalar(tuningState.bin, spec);
    return raw == null ? NaN : raw < 0 ? raw + fixed.top : raw;
  });
  return {
    first: fixed.specs[0].address - TN_CAL_START,
    points,
    units: axis.units || '',
    show: fixed.show,
  };
}

/**
 * What this table's cursor needs from the car: per axis (x, then y) the
 * variable, and the reads that fetch them. Worked out once per dialog.
 * @param {TableModal} m
 * @returns {{inputs:Array<CursorInput|null>, reads:Array<{address:number,length:number}>,
 *   pieces:Array<{address:number,size:number}>, packet:LiveTune|false|undefined}}
 *   `packet` is the connection the DME's packet is defined on, false when the
 *   DME refused one, undefined when it has yet to be defined.
 */
function tnLiveCursorPlan(m) {
  if (m.cursorPlan) return m.cursorPlan;
  let inputs = [null, null];
  const range = tnItemByteRange(m.item);
  if (range && typeof MS45_CURSOR_MAP !== 'undefined') {
    const x = tnLiveCursorAxis(m, m.t.x, m.t.cols);
    const y = tnLiveCursorAxis(m, m.t.y, m.t.rows);
    inputs = ltCursorInputs(MS45_CURSOR_MAP, range.start - TN_CAL_START, [
      x && m.t.cols > 1 ? x.first : null,
      y && m.t.rows > 1 ? y.first : null,
    ]);
  }
  // the gauges' variables ride beside the table's own
  const wanted = inputs
    .filter(Boolean)
    .map((v) => ({ address: v.address, size: v.size }));
  if (typeof tnGaugesPieces === 'function') wanted.push(...tnGaugesPieces());
  m.cursorPlan = Object.assign({ inputs }, tnLivePlan(wanted));
  return m.cursorPlan;
}

/**
 * How to fetch a set of variables: as the DME's packet (each variable once,
 * led by the canary that says the packet is still ours), or as reads by
 * address when the packet cannot be had.
 * @param {Array<{address:number, size:number}>} wanted
 * @returns {{reads:Array<{address:number,length:number}>,
 *   pieces:Array<{address:number,size:number}>, packet:LiveTune|false|undefined}}
 *   `packet` is the connection the DME's packet is defined on, false when the
 *   DME refused one, undefined when it has yet to be defined.
 */
function tnLivePlan(wanted) {
  const pieces = wanted.length
    ? [{ address: LT_CURSOR_CANARY.address, size: LT_CURSOR_CANARY.size }]
    : [];
  for (const v of wanted)
    if (!pieces.some((p) => p.address === v.address && p.size === v.size))
      pieces.push(v);
  return { reads: ltCursorReads(wanted), pieces, packet: undefined };
}

/**
 * Whether an edit is on the wire, or about to be: it goes first, and the
 * cursor, the gauges and a fault scan all wait their turn.
 * @returns {boolean}
 */
function tnLiveLineBusy() {
  return tnLive.busy || tnLive.pumping || tnLive.pending.size > 0;
}

/**
 * Whether the DME runs the program the variable addresses were traced in.
 * Asked of the car once per connection.
 * @param {LiveTune} lt
 * @returns {Promise<boolean>}
 */
async function tnLiveCursorKnows(lt) {
  if (lt.cursorKnown === undefined) {
    const id = await lt.readFlash(
      LT_PROGRAM_AT,
      MS45_CURSOR_MAP.program.length
    );
    lt.cursorKnown = String.fromCharCode(...id) === MS45_CURSOR_MAP.program;
  }
  return lt.cursorKnown;
}

/**
 * Shade the cells the DME is reading between, each by its share of the
 * value; or none.
 * @param {TableModal} m
 * @param {{col:{index:number,edge:number}|null, row:{index:number,edge:number}|null,
 *   readouts:Array<{label:string, value:string}>, guessed:boolean,
 *   title:string}|null} at - null lights nothing; `col`/`row` null means that
 *   axis is not known, and every cell along it is lit.
 * @param {string} [note] - What to say when nothing is lit.
 * @returns {void}
 */
function tnLiveCursorDraw(m, at, note) {
  const cur = m.cursor;
  for (const el of cur.lit) {
    el.classList.remove('tn-cell-live', 'tn-cell-near', 'tn-cell-deep');
    el.style.removeProperty('--live-w');
  }
  cur.lit = [];
  cur.info.classList.remove('stale');
  cur.shown = !!(at && (at.col || at.row));
  cur.pos = cur.shown ? { col: at.col, row: at.row } : null;
  // the 3D window shows it too -- redrawn only when the point has moved
  const where = cur.pos
    ? [cur.pos.col, cur.pos.row]
        .map((p) => (p ? p.index.toFixed(3) : '-'))
        .join(',')
    : '';
  if (where !== cur.where && typeof tnSurfaceRequest === 'function')
    tnSurfaceRequest(m);
  cur.where = where;
  if (!cur.shown) {
    cur.info.hidden = !note;
    cur.info.innerHTML = note
      ? `<span class="tn-cursor-note">${esc(note)}</span>`
      : '';
    cur.info.title = '';
    return;
  }
  // the nearest cell: the one whose value weighs most in the interpolation
  const light = (el, cls) => {
    if (!el) return;
    el.classList.add(cls);
    cur.lit.push(el);
  };
  const all = (n) => Array.from({ length: n }, (_, i) => i);
  const cols = at.col
    ? [Math.round(at.col.index)]
    : m.t.cols > 1
      ? all(m.t.cols)
      : [0];
  const rows = at.row
    ? [Math.round(at.row.index)]
    : m.t.rows > 1
      ? all(m.t.rows)
      : [0];
  // Shading only, no outline: each cell is darkened by its share of the
  // value, so the nearest is the darkest and an edit's reach is plain.
  const shade = (el, w) => {
    if (!el) return;
    const a = 0.15 + 0.7 * w;
    el.style.setProperty('--live-w', a.toFixed(2));
    light(el, 'tn-cell-near');
    if (a > 0.5) el.classList.add('tn-cell-deep'); // too dark for dark figures
  };
  if (at.col && at.row) {
    const c0 = Math.floor(at.col.index);
    const r0 = Math.floor(at.row.index);
    const fc = at.col.index - c0;
    const fr = at.row.index - r0;
    for (const [r, c, w] of [
      [r0, c0, (1 - fr) * (1 - fc)],
      [r0, c0 + 1, (1 - fr) * fc],
      [r0 + 1, c0, fr * (1 - fc)],
      [r0 + 1, c0 + 1, fr * fc],
    ]) {
      if (w < 0.02) continue;
      const el = cur.cells[r] && cur.cells[r][c] && cur.cells[r][c].firstChild;
      shade(el, w);
      if (el && r === rows[0] && c === cols[0])
        el.classList.add('tn-cell-live');
    }
  } else {
    // one axis unknown: the whole line at the known one's nearest point
    for (const r of rows)
      for (const c of cols) {
        shade(cur.cells[r][c].firstChild, 0.5);
        cur.cells[r][c].firstChild.classList.add('tn-cell-live');
      }
  }
  // one labelled figure per axis, then the table's own value there
  cur.info.hidden = false;
  cur.info.innerHTML =
    `<span class="tn-cursor-tag">${at.guessed ? 'LIVE ≈' : 'LIVE'}</span>` +
    at.readouts
      .map(
        (r) =>
          `<span class="tn-cursor-read"><i>${esc(r.label)}</i><b>${esc(r.value)}</b></span>`
      )
      .join('');
  cur.info.title = at.title;
}

/**
 * Whether data logging has the DME's packet just now. There is one packet,
 * and logging on the Logging page reads its values through it; a cursor or
 * a gauge that kept defining its own would take it back every round, each
 * side then defining again -- seen as logging that stalled for a second
 * every few. Logging is what the reader is looking at, so this side waits.
 * @returns {boolean}
 */
function tnPacketLent() {
  return typeof logPacket !== 'undefined' && !!logPacket.active;
}

/**
 * Fetch the table's variables. One exchange when the DME's packet can be
 * used: it is defined once per dialog (and again when the DME has forgotten
 * it, at a restart, or something else has defined its own in its place),
 * and each refresh is then a single read of it. Reads by
 * address, one per group of variables, when it cannot.
 * @param {ReturnType<typeof tnLiveCursorPlan>} plan
 * @param {LiveTune} lt
 * @returns {Promise<Array<{address:number, bytes:Uint8Array}>>}
 */
async function tnLiveCursorFetch(plan, lt) {
  const total = plan.pieces.reduce((n, p) => n + p.size, 0);
  if (plan.packet !== false && plan.packet !== lt)
    plan.packet = (await lt.definePacket(plan.pieces)) ? lt : false;
  if (plan.packet === lt) {
    const bytes = await lt.readPacket();
    if (
      bytes &&
      bytes.length === total &&
      LT_CURSOR_CANARY.bytes.every((b, i) => bytes[i] === b)
    ) {
      let at = 0;
      return plan.pieces.map((p) => {
        const piece = {
          address: p.address,
          bytes: bytes.slice(at, at + p.size),
        };
        at += p.size;
        return piece;
      });
    }
    plan.packet = undefined; // forgotten, or someone else's packet: define it again next time
  }
  const blocks = [];
  for (const r of plan.reads)
    blocks.push({
      address: r.address,
      bytes: await lt.readMemory(r.address, r.length),
    });
  return blocks;
}

/**
 * Read the table's variables off the car and light the cell.
 * @param {TableModal} m
 * @param {LiveTune} lt
 * @returns {Promise<boolean>} False when this table has nothing to follow.
 */
async function tnLiveCursorRefresh(m, lt) {
  if (!(await tnLiveCursorKnows(lt))) {
    tnLiveCursorDraw(
      m,
      null,
      'no live position: this ECU runs a program it is not mapped for'
    );
    return false;
  }
  const plan = tnLiveCursorPlan(m);
  if (!plan.reads.length) {
    tnLiveCursorDraw(m, null, 'no live position for this table');
    return false;
  }
  const blocks = await tnLiveCursorFetch(plan, lt);
  if (tnCursor.m !== m) return false; // closed while the read was out
  if (typeof tnGaugesUpdate === 'function') tnGaugesUpdate(blocks);
  if (!plan.inputs.some(Boolean)) {
    // nothing to follow on this table, but the gauges still want their turn
    tnLiveCursorDraw(m, null, 'no live position for this table');
    return true;
  }

  // the axes are read again each time: a break point may just have been edited
  const axes = [
    tnLiveCursorAxis(m, m.t.x, m.t.cols),
    tnLiveCursorAxis(m, m.t.y, m.t.rows),
  ];
  const readouts = [];
  const names = [];
  const pos = plan.inputs.map((input, i) => {
    if (!input || !axes[i]) return null;
    const raw = ltCursorValue(input, blocks);
    if (raw == null) return null;
    // the DME compares unsigned: a negative value is past the top of the axis
    const p = ltAxisPosition(raw < 0 ? raw + 2 ** 32 : raw, axes[i].points);
    if (!p) return null;
    readouts.push({
      label: axes[i].units || (i ? 'row' : 'column'),
      value: axes[i].show(raw),
    });
    names.push(
      `${i ? 'row' : 'column'} axis: ${input.name || 'RAM'} at 0x${input.address.toString(16).toUpperCase()}`
    );
    return p;
  });
  const [col, row] = pos;
  if (typeof tnCorrectSample === 'function')
    tnCorrectSample(m, col, row, blocks);
  const whole = (m.t.cols === 1 || col) && (m.t.rows === 1 || row);
  if (whole) {
    const v = ltCursorCell(m.t.cells, row ? row.index : 0, col ? col.index : 0);
    if (v != null)
      readouts.push({ label: m.t.z.units || 'value', value: fmtNum(v, m.dp) });
  }
  const guessed = plan.inputs.some((v) => v && v.guessed);
  tnLiveCursorDraw(m, {
    col,
    row,
    readouts,
    guessed,
    title:
      names.join('\n') +
      (guessed
        ? '\nThis table was not seen running when the variables were traced; the position is taken from its axes.'
        : ''),
  });
  m.cursor.at = Date.now();
  return true;
}

/**
 * One turn of the cursor: refresh if the line is free, then come back.
 * @returns {Promise<void>}
 */
async function tnLiveCursorTick() {
  const m = tnCursor.m;
  if (!m) return;
  let wait = TN_CURSOR_REST_MS;
  try {
    const lt = tnLive.armed ? tnLive.lt : null;
    if (!lt) {
      tnLiveCursorDraw(m, null);
      wait = TN_CURSOR_BACKOFF_MS;
    } else if (
      (typeof document !== 'undefined' && document.hidden) ||
      tnPacketLent()
    ) {
      wait = TN_CURSOR_BACKOFF_MS; // nobody is looking: leave the line alone
    } else if (tnLiveLineBusy()) {
      wait = TN_CURSOR_YIELD_MS; // an edit is on its way: it goes first
    } else if (!(await tnLiveCursorRefresh(m, lt))) {
      wait = TN_CURSOR_BACKOFF_MS;
    } else if (Date.now() - (tnLive.editedAt || 0) < TN_CURSOR_EDIT_QUIET_MS) {
      wait = TN_CURSOR_EDIT_REST_MS;
    }
  } catch (e) {
    // the car did not answer; the edit path is what decides the link is gone
    wait = TN_CURSOR_BACKOFF_MS;
  }
  if (tnCursor.m !== m) return;
  const stale = m.cursor.shown && Date.now() - m.cursor.at > TN_CURSOR_STALE_MS;
  m.cursor.info.classList.toggle('stale', stale);
  tnCursor.timer = setTimeout(tnLiveCursorTick, wait);
}

/**
 * The variables wanted have changed under an open table (a gauge window was
 * opened or closed): work the packet out again on the next refresh.
 * @returns {void}
 */
function tnLiveCursorReplan() {
  if (tnCursor.m) tnCursor.m.cursorPlan = null;
}

/**
 * Start following a table dialog that has just been built.
 * @param {TableModal} m
 * @returns {void}
 */
function tnLiveCursorAttach(m) {
  tnLiveCursorDetach(tnCursor.m);
  // the figures are kept but not shown: the shading on the grid is the
  // whole display, and the gauges window carries the numbers
  const info = document.createElement('div');
  info.hidden = true;
  const cells = [];
  for (const inp of m.gridWrap.querySelectorAll('.tn-cell')) {
    const r = +inp.dataset.r;
    (cells[r] = cells[r] || [])[+inp.dataset.c] = inp.parentElement;
  }
  m.cursor = {
    info,
    cells,
    lit: [],
    shown: false,
    pos: null,
    where: '',
    at: 0,
  };
  tnCursor.m = m;
  tnCursor.timer = setTimeout(tnLiveCursorTick, 0);
}

/**
 * Stop following a dialog (it is closing).
 * @param {TableModal|null} m
 * @returns {void}
 */
function tnLiveCursorDetach(m) {
  if (!m || tnCursor.m !== m) return;
  // hand the DME's packet back: BMW's own jobs read whatever was last defined
  const lt = m.cursorPlan && m.cursorPlan.packet;
  if (lt && lt === tnLive.lt) lt.clearPacket().catch(() => {});
  clearTimeout(tnCursor.timer);
  tnCursor.m = null;
  tnCursor.timer = null;
}
