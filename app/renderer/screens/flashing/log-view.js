/**
 * @file Flashing/Backups: a session's log, looked at instead of read.
 *
 * A session log (core/flash/flash-history.js) is a few thousand lines of
 * timestamps, job names and hex. What somebody opening one wants to know is
 * short: what was done, how far it got, where it stopped and why. So Open
 * Log shows the log as a session: a timeline with every job on it (a failed
 * one in red, where it happened), the jobs counted by kind with the time
 * each took, and the lines themselves underneath, filterable, with a job's
 * telegrams a click away. The file is still there to save.
 *
 * fbLogParse and fbLogSummary have no page in them and are tested on their
 * own; fbLogOpen is the dialog.
 */

/* exported fbLogParse, fbLogSummary, fbLogOpen */

/**
 * @typedef {Object} FbLogEvent
 * @property {number} at - Milliseconds from the session's first line.
 * @property {number} took - Until the next line (0 for the last).
 * @property {'job'|'note'} kind
 * @property {string} name - The job's name, or '' for a note.
 * @property {string} arg - The job's argument summary.
 * @property {string} status - The job's status, or the note's text.
 * @property {boolean} failed - A job that did not come back OKAY.
 * @property {string} tx - The request telegram, in hex.
 * @property {string} rx - The answer telegram, in hex.
 */

const FB_LOG_LINE = /^(\d\d):(\d\d):(\d\d)\.(\d\d\d)\s\s(.*)$/;
const FB_LOG_JOB = /^(\S+?)(?: \[(.*)\])? -> (.*)$/;
const FB_LOG_DAY_MS = 86400000;

/**
 * A log's text as events on the session's own clock.
 * @param {string} text - The log, as flashLog wrote it.
 * @returns {{operation: string, started: string, ended: string, events: FbLogEvent[], total: number}}
 */
function fbLogParse(text) {
  const head = { operation: '', started: '', ended: '' };
  /** @type {FbLogEvent[]} */
  const events = [];
  let first = null;
  let lastClock = null;
  let days = 0;
  for (const line of String(text || '').split('\n')) {
    const h = /^# (operation|started|ended):\s*(.*)$/.exec(line);
    if (h) {
      head[h[1]] = h[2].trim();
      continue;
    }
    const m = FB_LOG_LINE.exec(line);
    if (!m) {
      // a job's telegrams follow it, indented
      const t = /^\s+(tx|rx): (.*)$/.exec(line);
      if (t && events.length) events[events.length - 1][t[1]] = t[2];
      continue;
    }
    const clock =
      ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 +
      Number(m[4]);
    // the stamps are times of day: a session that ran past midnight wraps
    if (lastClock != null && clock < lastClock - FB_LOG_DAY_MS / 2) days++;
    lastClock = clock;
    const abs = clock + days * FB_LOG_DAY_MS;
    if (first == null) first = abs;
    const job = FB_LOG_JOB.exec(m[5]);
    events.push(
      job
        ? {
            at: abs - first,
            took: 0,
            kind: 'job',
            name: job[1],
            arg: job[2] || '',
            status: job[3],
            failed: job[3] !== 'OKAY',
            tx: '',
            rx: '',
          }
        : {
            at: abs - first,
            took: 0,
            kind: 'note',
            name: '',
            arg: '',
            status: m[5],
            failed: false,
            tx: '',
            rx: '',
          }
    );
  }
  // a line is stamped when it is written, which for a job is when it ended:
  // the time it took is the time since the line before it
  for (let i = events.length - 1; i > 0; i--)
    events[i].took = events[i].at - events[i - 1].at;
  return {
    ...head,
    events,
    total: events.length ? events[events.length - 1].at : 0,
  };
}

/**
 * What a session came to: its jobs by kind, and where it first went wrong.
 * @param {ReturnType<typeof fbLogParse>} log
 * @returns {{jobs: number, failed: number, notes: number, kinds: Array<{name: string, n: number, failed: number, ms: number}>, firstFailure: FbLogEvent|null, slowest: FbLogEvent|null}}
 */
function fbLogSummary(log) {
  const kinds = new Map();
  let jobs = 0;
  let failed = 0;
  let notes = 0;
  let firstFailure = null;
  let slowest = null;
  for (const e of log.events) {
    if (e.kind !== 'job') {
      notes++;
      continue;
    }
    jobs++;
    const k = kinds.get(e.name) || { name: e.name, n: 0, failed: 0, ms: 0 };
    k.n++;
    k.ms += e.took;
    if (e.failed) {
      k.failed++;
      failed++;
      if (!firstFailure) firstFailure = e;
    }
    kinds.set(e.name, k);
    if (!slowest || e.took > slowest.took) slowest = e;
  }
  return {
    jobs,
    failed,
    notes,
    kinds: [...kinds.values()].sort((a, b) => b.ms - a.ms),
    firstFailure,
    slowest,
  };
}

/**
 * A duration in words a glance takes in.
 * @param {number} ms
 * @returns {string}
 */
function fbLogSpan(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
}

/**
 * Minutes:seconds.tenths into the session.
 * @param {number} ms
 * @returns {string}
 */
function fbLogClock(ms) {
  const tenths = Math.max(0, Math.round(ms / 100));
  return `${String(Math.floor(tenths / 600)).padStart(2, '0')}:${String(Math.floor((tenths % 600) / 10)).padStart(2, '0')}.${tenths % 10}`;
}

/**
 * Show a session's log as a session.
 * @param {HTMLElement} host - Emptied and filled.
 * @param {{started: number, operation: string, result?: string, vin?: string, module?: string, details?: string, status?: string, log: string}} entry
 * @param {{title?: string, onClose?: () => void, saveFile?: () => void}} [opts]
 * @returns {{close: () => void}}
 */
function fbLogOpen(host, entry, opts = {}) {
  const log = fbLogParse(entry.log);
  const sum = fbLogSummary(log);
  const total = Math.max(1, log.total);
  const state = { filter: 'all', picked: -1, closed: false };
  const result = entry.result || 'ended';

  host.innerHTML = `
    <div class="fb-logview">
      <div class="fb-logview-bar">
        <span class="fb-logview-title">${esc(opts.title || entry.operation)}</span>
        <span class="fb-logview-result fb-result-${esc(result)}">${esc(result)}</span>
        <span class="fb-logview-when">${esc(new Date(entry.started).toLocaleString())}</span>
        <span class="fb-logview-fill"></span>
        <button type="button" class="btn fb-logview-save">Save log file</button>
        <button type="button" class="btn fb-logview-close" aria-label="Close">×</button>
      </div>
      <div class="fb-logview-facts"></div>
      <div class="fb-logview-timeline"><canvas></canvas><div class="fb-logview-tip" hidden></div></div>
      <div class="fb-logview-body">
        <div class="fb-logview-kinds"></div>
        <div class="fb-logview-lines">
          <div class="fb-logview-filter seg">
            <button type="button" class="seg-btn active" data-f="all">All</button>
            <button type="button" class="seg-btn" data-f="failed">Failures</button>
            <button type="button" class="seg-btn" data-f="notes">Notes</button>
          </div>
          <div class="fb-logview-list"></div>
          <div class="fb-logview-detail"></div>
        </div>
      </div>
    </div>`;
  const q = (sel) => host.querySelector(sel);
  const canvas = /** @type {HTMLCanvasElement} */ (q('canvas'));
  const timeline = q('.fb-logview-timeline');
  const tip = q('.fb-logview-tip');
  const list = q('.fb-logview-list');
  const detail = q('.fb-logview-detail');

  // ---- the facts: what a reader came for, in a row --------------------------
  const fact = (label, value, cls = '') =>
    `<div class="fb-logview-fact ${cls}"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
  q('.fb-logview-facts').innerHTML =
    fact('Took', fbLogSpan(log.total)) +
    fact('Jobs', String(sum.jobs)) +
    fact('Failed', String(sum.failed), sum.failed ? 'bad' : '') +
    fact(
      'Car',
      [entry.vin, entry.module].filter(Boolean).join(' ') || 'not identified'
    ) +
    (sum.firstFailure
      ? fact(
          'First failure',
          `${sum.firstFailure.name} at ${fbLogClock(sum.firstFailure.at)}: ${sum.firstFailure.status}`,
          'bad wide'
        )
      : fact('Ended', entry.status || 'no status recorded', 'wide'));

  // ---- the jobs by kind, the longest first -------------------------------------
  const most = Math.max(1, ...sum.kinds.map((k) => k.ms));
  q('.fb-logview-kinds').innerHTML =
    '<div class="fb-logview-head">Where the time went</div>' +
    (sum.kinds.length
      ? sum.kinds
          .map(
            (k) =>
              `<div class="fb-logview-kind${k.failed ? ' bad' : ''}" title="${esc(k.name)}">` +
              `<span class="fb-logview-kind-name">${esc(k.name)}</span>` +
              `<span class="fb-logview-kind-n">${k.n}×${k.failed ? ` · ${k.failed} failed` : ''}</span>` +
              `<span class="fb-logview-kind-ms">${esc(fbLogSpan(k.ms))}</span>` +
              `<span class="fb-logview-kind-bar"><span style="width:${Math.max(1, Math.round((k.ms / most) * 100))}%"></span></span>` +
              '</div>'
          )
          .join('')
      : '<div class="fb-logview-none">No jobs were logged in this session.</div>');

  // ---- the lines -----------------------------------------------------------------
  const shown = () =>
    log.events
      .map((e, i) => ({ e, i }))
      .filter(({ e }) =>
        state.filter === 'failed'
          ? e.failed
          : state.filter === 'notes'
            ? e.kind === 'note'
            : true
      );
  const paintList = () => {
    const rows = shown();
    list.innerHTML = rows.length
      ? rows
          .map(
            ({ e, i }) =>
              `<div class="fb-logview-row${e.failed ? ' bad' : ''}${e.kind === 'note' ? ' note' : ''}${i === state.picked ? ' picked' : ''}" data-i="${i}">` +
              `<span class="fb-logview-at">${fbLogClock(e.at)}</span>` +
              (e.kind === 'job'
                ? `<span class="fb-logview-name">${esc(e.name)}</span>` +
                  `<span class="fb-logview-arg">${esc(e.arg)}</span>` +
                  `<span class="fb-logview-status">${esc(e.status)}</span>` +
                  `<span class="fb-logview-took">${esc(fbLogSpan(e.took))}</span>`
                : `<span class="fb-logview-note">${esc(e.status)}</span>`) +
              '</div>'
          )
          .join('')
      : `<div class="fb-logview-none">${state.filter === 'failed' ? 'Nothing failed in this session.' : 'Nothing to show.'}</div>`;
  };
  /**
   * Pick one line: mark it in the list and on the timeline, show its telegrams.
   * @param {number} i - Its index in the log, or -1 for none.
   * @param {boolean} [reveal] - Bring its row into view.
   * @returns {void}
   */
  const pick = (i, reveal = false) => {
    state.picked = i;
    for (const r of list.querySelectorAll('.fb-logview-row'))
      r.classList.toggle('picked', Number(r.dataset.i) === i);
    const e = log.events[i];
    detail.innerHTML =
      e && e.kind === 'job'
        ? `<div class="fb-logview-head">${esc(e.name)}${e.arg ? ` [${esc(e.arg)}]` : ''} · ${esc(e.status)}</div>` +
          `<div class="fb-logview-tel"><span>sent</span><code>${esc(e.tx || 'nothing logged')}</code></div>` +
          `<div class="fb-logview-tel"><span>answer</span><code>${esc(e.rx || 'nothing logged')}</code></div>`
        : '';
    if (reveal) {
      const row = list.querySelector(`.fb-logview-row[data-i="${i}"]`);
      if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center' });
    }
    draw();
  };
  list.onclick = (ev) => {
    const row = ev.target.closest('.fb-logview-row');
    if (row) pick(Number(row.dataset.i));
  };
  q('.fb-logview-filter').onclick = (ev) => {
    const b = ev.target.closest('.seg-btn');
    if (!b) return;
    state.filter = b.dataset.f;
    for (const x of host.querySelectorAll('.fb-logview-filter .seg-btn'))
      x.classList.toggle('active', x === b);
    paintList();
  };

  // ---- the timeline: every job where it happened ----------------------------------
  // the palette is the stylesheet's (--lv-*: quiet greys, one colour for a
  // failure; the classic skin overrides them), read once the view is in
  const styleOf = getComputedStyle(host.querySelector('.fb-logview'));
  const tone = (name, fallback) =>
    (styleOf.getPropertyValue(name) || '').trim() || fallback;
  const colours = {
    ok: tone('--lv-ok', '#8a97a3'),
    bad: tone('--lv-bad', '#ff6b6b'),
    note: tone('--lv-note', '#8a97a3'),
    tick: tone('--lv-tick', '#8a97a3'),
    pick: tone('--lv-pick', '#ffffff'),
  };
  const xOf = (w, ms) => 8 + (ms / total) * (w - 16);
  function draw() {
    if (state.closed) return;
    const w = timeline.clientWidth;
    const h = timeline.clientHeight;
    if (w < 60 || h < 30) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * dpr))
      canvas.width = Math.round(w * dpr);
    if (canvas.height !== Math.round(h * dpr))
      canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const top = 8;
    const bottom = h - 20;
    g.fillStyle = 'rgba(138, 151, 163, 0.10)';
    g.fillRect(8, top, w - 16, bottom - top);
    // each job is the stretch it took, ending at its line
    for (const e of log.events) {
      if (e.kind !== 'job') continue;
      const x1 = xOf(w, e.at);
      const x0 = xOf(w, e.at - e.took);
      g.fillStyle = e.failed ? colours.bad : colours.ok;
      g.globalAlpha = e.failed ? 1 : 0.55;
      g.fillRect(
        x0,
        e.failed ? top : top + 6,
        Math.max(1, x1 - x0 - 0.5),
        e.failed ? bottom - top : bottom - top - 12
      );
    }
    g.globalAlpha = 1;
    // a note is a moment: a mark under the band
    g.fillStyle = colours.note;
    for (const e of log.events)
      if (e.kind === 'note')
        g.fillRect(Math.round(xOf(w, e.at)), bottom + 2, 1.5, 5);
    // the clock along the bottom
    g.fillStyle = colours.tick;
    g.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.textBaseline = 'top';
    const steps = Math.max(2, Math.floor(w / 130));
    for (let k = 0; k <= steps; k++) {
      const ms = (total * k) / steps;
      g.textAlign = k === 0 ? 'left' : k === steps ? 'right' : 'center';
      g.fillText(fbLogClock(ms), xOf(w, ms), bottom + 8);
    }
    const p = log.events[state.picked];
    if (p) {
      g.strokeStyle = colours.pick;
      g.lineWidth = 1.5;
      const x = Math.round(xOf(w, p.at)) + 0.5;
      g.beginPath();
      g.moveTo(x, top - 3);
      g.lineTo(x, bottom + 3);
      g.stroke();
    }
  }
  /** The line nearest a point on the timeline. */
  const nearest = (ev) => {
    const r = canvas.getBoundingClientRect();
    const ms = ((ev.clientX - r.left - 8) / Math.max(1, r.width - 16)) * total;
    let best = -1;
    let gap = Infinity;
    log.events.forEach((e, i) => {
      // inside a job's own stretch counts as on it
      const d =
        e.kind === 'job' && ms >= e.at - e.took && ms <= e.at
          ? 0
          : Math.abs(e.at - ms);
      if (d < gap || (d === gap && e.failed)) {
        gap = d;
        best = i;
      }
    });
    return best;
  };
  canvas.onmousemove = (ev) => {
    const i = nearest(ev);
    const e = log.events[i];
    if (!e) return;
    tip.textContent =
      `${fbLogClock(e.at)}  ` +
      (e.kind === 'job'
        ? `${e.name}${e.arg ? ` [${e.arg}]` : ''} → ${e.status} (${fbLogSpan(e.took)})`
        : e.status);
    tip.classList.toggle('bad', e.failed);
    tip.hidden = false;
    const r = timeline.getBoundingClientRect();
    const x = ev.clientX - r.left;
    tip.style.left = `${Math.max(4, Math.min(r.width - tip.offsetWidth - 4, x - tip.offsetWidth / 2))}px`;
  };
  canvas.onmouseleave = () => {
    tip.hidden = true;
  };
  canvas.onclick = (ev) => {
    const i = nearest(ev);
    if (i < 0) return;
    // the row may be filtered out: show everything so it can be seen
    const e = log.events[i];
    if (
      (state.filter === 'failed' && !e.failed) ||
      (state.filter === 'notes' && e.kind !== 'note')
    ) {
      state.filter = 'all';
      for (const x of host.querySelectorAll('.fb-logview-filter .seg-btn'))
        x.classList.toggle('active', x.dataset.f === 'all');
      paintList();
    }
    pick(i, true);
  };

  const sized =
    typeof ResizeObserver === 'function' ? new ResizeObserver(draw) : null;
  if (sized) sized.observe(timeline);

  const close = () => {
    if (state.closed) return;
    state.closed = true;
    if (sized) sized.disconnect();
    host.innerHTML = '';
    if (opts.onClose) opts.onClose();
  };
  q('.fb-logview-close').onclick = close;
  q('.fb-logview-save').onclick = () => {
    if (opts.saveFile) opts.saveFile();
  };

  paintList();
  // open on what went wrong, when something did
  if (sum.firstFailure) pick(log.events.indexOf(sum.firstFailure), true);
  else draw();
  return { close };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { fbLogParse, fbLogSummary, fbLogSpan, fbLogClock };
}
