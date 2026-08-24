// The IR interpreter: draw an ECU's screens from data/inpa-ir/<ECU>.json
// (emitted by tools/ipo_ir.py). Per-ECU knowledge is translation only, applied
// at render time because each .IPO's strings are frozen in the language BMW
// compiled it with. A screen converts to the {job, rows, grid} shape
// showInpaScreens consumes.

// screens whose elements are all static text have nothing to poll
// ---- togglelist actuator picker -------------------------------------------
// INPA's standard actuator idiom (274 screens, 76 ECUs): the page is a LIST of
// actuators, not a readout. The user picks one and the picked row's key is the
// job argument. See _toggle_job in tools/decompile/ipo_ir.py for why the value
// cannot come from the bytecode -- BMW declares togglelist's output parameter
// `out: string ApiToggleString`, so the widget produces it at runtime.

// The SGBD's BITS table names every ORT key: VRFT -> "Verriegeln Fahrertuer",
// with the byte and mask the ECU actually toggles. Shown beside each row so a
// pick is an informed one rather than a four-letter guess. Missing table or
// missing row is fine -- the caption from the screen still names the actuator.
const _bitsCache = new Map();
async function irBitsTable(sgbd) {
  const key = String(sgbd).toLowerCase();
  if (!_bitsCache.has(key)) {
    _bitsCache.set(key, (async () => {
      try {
        const t = await api(`/data/sgbd-tables/${key}.json`);
        const rows = (t && (t.BITS || t.bits)) || [];
        const m = new Map();
        for (const r of rows) {
          const n = String(r.NAME || r.name || '').toUpperCase();
          if (n) m.set(n, r);
        }
        return m;
      } catch { return new Map(); }
    })());
  }
  return _bitsCache.get(key);
}

async function irPickAndDrive(ecu, ir, scr, it, menuName, container, back,
                              trail, open) {
  const rows = (scr.lines || [])
    .filter((l) => (l.keys || []).length)
    .map((l) => ({ key: String(l.keys[0]), caption: irLabel(l.caption) || l.keys[0] }));
  const bits = await irBitsTable(ecu.sgbd);
  const reopen = () => renderIrMenu(ecu, ir, menuName, container, back, trail);
  // Firing a row RE-ENTERS the ordinary actuator branch rather than sending
  // here: that path owns the confirm dialog, the register-before-send and the
  // release-on-leave promise. Sending from this list would energize an output
  // with none of them. Both the click handler and the F-key bar go through it.
  const fire = (r) => open({ ...it, inPlace: true, screen: null,
                             job: scr.pickJob, jobArg: r.key,
                             label: `${it.label} · ${r.caption}` });

  const detailOf = (r) => {
    const b = bits.get(r.key.toUpperCase());
    if (!b) return '';
    const t = b.TEXT && typeof deGerman === 'function' ? deGerman(b.TEXT) : b.TEXT;
    return t || `byte ${b.BYTE} mask ${b.MASK}`;
  };

  container.className = 'results-panel';
  if (inpaMode()) {
    // INPA draws a togglelist as its ordinary key list: "< Fn >  caption".
    // Same grammar as irMenuMode's menus, so a picker does not read like a
    // different app. The ORT stays visible on the right -- it is the value
    // that goes on the wire, and hiding it would make the pick a guess.
    container.innerHTML = `<div class="ir-pick-head">Pick the actuator to `
      + `drive &middot; sends <span class="mono">${esc(scr.pickJob)}</span></div>`
      + `<div class="act-key-list" id="ir-pick-list"></div>`;
    const list = container.querySelector('#ir-pick-list');
    rows.forEach((r, i) => {
      const row = document.createElement('button');
      row.className = 'inpa-fn act-key-row';
      row.dataset.i = String(i);
      row.innerHTML = `<span class="inpa-fn-key">&lt; F${i + 1} &gt;</span>`
        + `<span class="inpa-fn-label">${esc(r.caption)}</span>`
        + `<span class="act-key-val ir-pick-ort mono">${esc(r.key)}</span>`
        + `<span class="ir-pick-detail">${esc(detailOf(r))}</span>`;
      list.appendChild(row);
    });
  } else {
    container.innerHTML = `<div class="ir-pick">
      <div class="ir-pick-head">Pick the actuator to drive · sends
        <span class="mono">${esc(scr.pickJob)}</span></div>
      <div class="ir-pick-rows">${rows.map((r, i) => `
        <button class="ir-pick-row" data-i="${i}">
          <span class="ir-pick-name">${esc(r.caption)}</span>
          <span class="ir-pick-ort mono">${esc(r.key)}</span>
          <span class="ir-pick-detail">${esc(detailOf(r))}</span>
        </button>`).join('')}</div></div>`;
  }

  container.querySelectorAll('[data-i]').forEach((btn) => {
    btn.onclick = () => {
      fire(rows[Number(btn.dataset.i)]);
    };
  });

  sbLeft.textContent = `${ecu.sgbd}.prg · ${it.label} · ${rows.length} actuators`;
  // The softkey bar drives them too, the way INPA's does: F1..F9 map to the
  // first nine rows in the order the screen lists them, Esc goes back.
  setActions([
    ...rows.slice(0, 9).map((r, i) => ({
      key: String(i + 1), keyLabel: `F${i + 1}`, label: r.caption,
      fn: () => fire(r),
    })),
    { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: reopen },
  ]);
}

function irReadable(scr) {
  return (scr.lines || []).some(ln =>
    (ln.elements || []).some(e => e.key && e.t !== 'text'));
}

// Pair captions to values by WHERE INPA drew them, for lines where reading
// order alone cannot (a row of captions then a row of values beneath). Returns
// Map(element -> caption) only when unambiguous, else null:
//   - one caption per value, each used once (a shared heading is a group title)
//   - a caption labels what is to its RIGHT or BELOW, never its left
//   - at most two rows above
function irCaptionsByPosition(els, valued) {
  const placed = (e) => typeof e.row === 'number' && typeof e.col === 'number';
  const vals = valued.filter(placed);
  if (vals.length < 2) return null;
  const texts = els.filter(e => e.t === 'text' && placed(e)
    && String(e.s || '').trim()
    && !/^\[.+\]$/.test(String(e.s).trim())
    && !/^[:=|/-]+$/.test(String(e.s).trim())
    // a printed softkey row is the screen's own key help, not a caption
    && !/^<\s*(Shift\s*>\s*\+\s*<\s*)?F\s*\d+\s*>/.test(String(e.s).trim()));
  if (texts.length < vals.length) return null;
  const out = new Map();
  for (const v of vals) {
    let best = null, bestD = Infinity;
    for (const t of texts) {
      if (t.row > v.row || (t.row === v.row && t.col > v.col)) continue;
      if (v.row - t.row > 2) continue;
      // nearest by COLUMN first, then row: ranking by leftward distance alone
      // made the rightmost caption win for every lamp in a row
      const d = Math.abs(t.col - v.col) * 100 + (v.row - t.row);
      if (d < bestD) { bestD = d; best = t; }
    }
    if (best) out.set(v, String(best.s).trim().replace(/\s*[:=]\s*$/, ''));
  }
  if (out.size !== vals.length) return null;
  return new Set(out.values()).size === vals.length ? out : null;
}

// A screen's rows, in INPA's own drawing order. A row's caption is the nearest
// preceding text on the same line; when a LINE names several keys the caption
// splits positionally.
function irRows(scr) {
  const rows = [];
  const cells = [];
  // a screen reading the same job once per position repeats its result keys per
  // LINE, distinguished only by the job's argument. Rows carry that argument so
  // the poller reads each pass separately and one wheel cannot overwrite another.
  const multiArg = new Set((scr.lines || []).map(l => l.jobArg)
    .filter(Boolean)).size > 1;
  let lineNo = -1;
  for (const ln of scr.lines || []) {
    lineNo++;
    const els = ln.elements || [];
    const caps = String(ln.caption || '').split(',').map(s => s.trim());
    // a caption element carries a key but is not a row: counting it made a
    // two-gauge line look like four values
    const valued = els.filter(e => e.key && e.t !== 'text' && e.t !== 'caption');
    // one caption for several unrelated keys is a LOOP screen (heading drawn
    // once and reused): applying it to every key mislabels, so take no label
    const capForAll = caps.length === 1 && caps[0] && valued.length === 1;
    const byPos = irCaptionsByPosition(els, valued);
    // did INPA emit ALL captions then all values? Only then is reading order
    // structurally wrong rather than merely incomplete.
    const capsFirst = (() => {
      if (!byPos) return false;
      const texts = els.filter(x => x.t === 'text' && String(x.s || '').trim());
      const vs = els.filter(x => x.key && x.t !== 'text');
      return texts.length > 0 && vs.length > 1
        && els.lastIndexOf(texts[texts.length - 1]) < els.indexOf(vs[0]);
    })();
    let pending = null;
    let unitAhead = null;
    let captionKey = null;
    let nth = 0;
    for (let ei = 0; ei < els.length; ei++) {
      const e = els[ei];
      // a _TEXT result read purely to caption the value below it: the ECU
      // supplies the wording, so it rides on the row it labels, filled by the poller
      if (e.t === 'caption') { captionKey = e.key; continue; }
      if (e.t === 'text') {
        const s = String(e.s || '').trim();
        // "[rpm]" printed above a gauge is its UNIT, not its caption
        let m = /^\[(.+)\]$/.exec(s);
        // INPA sometimes loses the OPENING bracket ("degree KW]"). Only a
        // trailing "]" with no "[" anywhere qualifies, so a genuine caption
        // ending in a bracket ("Kennfeld [neu]") still reads as a caption.
        if (!m && /\]$/.test(s) && !s.includes('[')) {
          m = [s, s.slice(0, -1)];
        }
        // ...and sometimes the unit has no brackets at all (BMS46's load).
        // No text SHAPE settles this, so corroborate: the element it labels
        // already carries a unit mined from the gauge declaration, and the
        // printed text is exactly it.
        if (!m) {
          const nxt = els[ei + 1];
          const u = nxt && nxt.t !== 'text' && nxt.col === e.col
            && nxt.unit ? String(nxt.unit).trim() : null;
          if (u && u === s) m = [s, s];
        }
        // A BRACKETED RESULT NAME IS NOT A UNIT: FASTA developer pages append
        // the ECU's internal variable name in brackets ("...  [V]  [upwg]"),
        // which reads like a unit. The tell is that it repeats the result it
        // labels ([upwg] beside STAT_UPWG_WERT); dropping it lets the row fall
        // through to the REAL unit read live from STAT_x_EINH.
        if (m) {
          const nxt = els[ei + 1];
          const stem = nxt && nxt.key
            ? String(nxt.key).replace(/^STAT(US)?_/, '')
              .replace(/_(WERT|EIN|EINH|TEXT)\d*$/, '')
            : null;
          if (stem && m[1].trim().toUpperCase() === stem.toUpperCase()) continue;
        }
        if (m) { unitAhead = m[1].trim(); continue; }
        // a bare ":" / "/" print is punctuation, not a label
        if (/^[:=|/-]+$/.test(s)) continue;
        // ...and a caption may carry the separator itself ("Monitor pot. :")
        if (s) pending = s.replace(/\s*[:=]\s*$/, '');
        continue;
      }
      if (!e.key) continue;
      // the element may carry its OWN caption (label + result name together),
      // more specific than anything reading order or geometry can infer
      let label = e.s || pending;
      if (!label && caps.length > 1 && valued.length === caps.length)
        label = caps[nth];
      // ...and when the line draws a whole GROUP per caption (a _TEXT paired
      // with a _WERT per reading). An exact-count requirement left MS450's
      // eight mixture-adaptation rows on raw keys.
      if (!label && caps.length > 1 && valued.length > caps.length
          && valued.length % caps.length === 0) {
        // ...and the grouping may be by COLUMN rather than in sequence (MS450's
        // VANOS "Einlass, Auslass" over two columns). Where the values sit in
        // as many distinct columns as caption parts, the column decides.
        const cols = [...new Set(valued.map(v => v.col))].sort((a, b) => a - b);
        label = (cols.length === caps.length && typeof e.col === 'number')
          ? caps[cols.indexOf(e.col)]
          : caps[Math.floor(nth / (valued.length / caps.length))];
      }
      if (!label && capForAll) label = caps[0];
      // geometric pairing fills a bare row and also CORRECTS a wrong one, but
      // only when all captions were printed before the values (capsFirst),
      // where reading order would hand every value the last caption
      if (byPos && (!label || capsFirst)) label = byPos.get(e) || label;
      const row = {
        key: e.key,
        label: label || null,
        unit: e.unit || unitAhead || null,
        kind: e.t,
        line: lineNo,
      };
      // on a per-position screen the LINE caption ("Rad 1") is the position;
      // kept separately so the row's own caption can still resolve before they
      // are joined (prefixing here would freeze in a placeholder like "(1)")
      if (multiArg && ln.jobArg) {
        row.arg = ln.jobArg;
        const pos = (ln.caption || '').trim();
        if (pos) row.pos = pos;
      }
      if (captionKey) { row.captionKey = captionKey; captionKey = null; }
      if (typeof e.min === 'number' && typeof e.max === 'number'
          && e.max > e.min) { row.min = e.min; row.max = e.max; }
      // the band INPA paints green, when analogout declared one
      if (typeof e.okMin === 'number' && typeof e.okMax === 'number'
          && e.okMax > e.okMin) { row.okMin = e.okMin; row.okMax = e.okMax; }
      if (e.on) row.on = e.on;
      if (e.off) row.off = e.off;
      // value -> word table the script read this result through (a string
      // array lookup, LSZ's lamp states): the live value renders as INPA's
      // word instead of the bare number
      if (e.map) row.map = e.map;
      rows.push(row);
      if (typeof e.row === 'number')
        cells.push({ key: e.key, row: e.row, col: e.col || 0 });
      pending = null;
      unitAhead = null;
      nth++;
    }
  }
  return { rows, cells };
}

// A SCREEN INPA DRAWS AS A TABLE, or null: the same values read once per wheel/
// cylinder/bank, which the row builder would otherwise flatten into stacked
// readouts. Test is structural, no wording: the DATA LINES all put their values
// in the same columns.
function irTable(scr) {
  const lines = scr.lines || [];
  if (lines.length < 3) return null;
  const colsOf = (l) => (l.elements || [])
    .filter(e => e.key && e.t !== 'text' && typeof e.col === 'number')
    .map(e => e.col);

  const data = lines.filter(l => colsOf(l).length);
  if (data.length < 3) return null;
  const sig = (l) => colsOf(l).slice().sort((a, b) => a - b).join(',');
  const first = sig(data[0]);
  if (!data.every(l => sig(l) === first)) return null;
  const cols = colsOf(data[0]).slice().sort((a, b) => a - b);
  if (cols.length < 3) return null;
  // columns must be DISTINCT positions: a signature match on values all at one
  // column (ACC's history screen) is four copies of one column, not a table
  if (new Set(cols).size !== cols.length) return null;

  // the header is a text-only line, and INPA prints each heading a column or
  // two LEFT of the values under it, so a heading claims the nearest value
  // column at or after it rather than an exact match
  const head = lines.find(l => !colsOf(l).length
    && (l.elements || []).some(e => e.t === 'text' && String(e.s || '').trim()));
  const headings = new Map();
  let rowHead = '';
  if (head) {
    for (const e of head.elements || []) {
      if (e.t !== 'text' || !String(e.s || '').trim()) continue;
      // a heading LEFT of the first value column belongs to the row label, not
      // a value: claiming a value column for it shifted every heading right
      if (e.col < cols[0] - 2) { rowHead = rowHead || String(e.s).trim(); continue; }
      const c = cols.find(x => x >= e.col - 2);
      if (c !== undefined && !headings.has(c)) headings.set(c, String(e.s).trim());
    }
  }

  return {
    cols,
    rowHead,
    headings: cols.map(c => headings.get(c) || ''),
    // the row label is the leading text on each data line: "(1)", "(2)" ...
    labels: data.map(l => {
      const t = (l.elements || []).find(e => e.t === 'text'
        && String(e.s || '').trim() && e.col <= cols[0]);
      return t ? String(t.s).trim() : (l.caption || '');
    }),
    // which key sits in which column, per data line
    keys: data.map(l => {
      const byCol = new Map();
      for (const e of l.elements || []) {
        if (e.key && e.t !== 'text' && typeof e.col === 'number'
            && !byCol.has(e.col)) byCol.set(e.col, e.key);
      }
      return cols.map(c => byCol.get(c) || null);
    }),
    args: data.map(l => l.jobArg || null),
  };
}

// One IR screen -> the screen objects showInpaScreens polls. A screen with
// several read jobs becomes one entry per job: the poller reads them all each
// tick and keeps whichever keys each answers.
function irScreens(scr) {
  // the readout path draws the EXECUTED twin when the interpreted flag put
  // one here; every other consumer of the screen sees the mined original.
  // A PROMPTED SCREEN STAYS MINED: its job argument comes from an input
  // dialog (argSlot / argFromMenu), and the twin was derived with no-op
  // inputs, so its baked argument would poll the job with an empty value
  // instead of asking. The mined metadata is what drives the prompt.
  const prompted = (scr.jobs || []).some(j => j.argSlot != null
    || j.argFromMenu);
  if (scr._vmTwin && !prompted) scr = Object.assign({ _vm: true }, scr._vmTwin);
  const out = _irScreensRaw(scr);
  // an executed screen carries the script's own dialogs -- the entry hints it
  // pops on open and the error arm's boxes ("Wrong JOB_STATUS : ..."). They
  // ride on every poll object so the poller can show them at the moment the
  // live run matches that arm.
  if (scr._vm) {
    for (const sc of out) {
      sc.vmErrors = scr.errorMessages || null;
      sc.vmEntry = scr.messages || null;
    }
  }
  return out;
}

function _irScreensRaw(scr) {
  const { rows, cells } = irRows(scr);
  if (!rows.length) return [];
  // write-shaped jobs are represented in the IR but never auto-run
  const jobs = (scr.jobs || []).filter(j => !j.write);
  if (!jobs.length) return [];
  // a per-position screen becomes one poll per argument, each carrying only the
  // rows read in that pass -- else all wheels share one read
  if (rows.some(r => r.arg)) {
    // ...but drawn as a TABLE it stays ONE screen; every job still polls
    const table = irTable(scr);
    if (table) {
      return [{
        job: jobs[0].name,
        args: '',
        group: scr.title || null,
        rows,
        polls: jobs.map(j => ({ job: j.name, args: j.arg || '' })),
        table,
      }];
    }
    return jobs.map(j => ({
      job: j.name,
      args: j.arg || '',
      group: scr.title || null,
      rows: rows.filter(r => r.arg === j.arg),
      grid: null,
    })).filter(s => s.rows.length);
  }
  // Several jobs can fill ONE page, each feeding its own block of rows,
  // distinguished by the line each job was read on. Each still polls but carries
  // only the rows it answers. A job owns its own line plus any following line
  // that declared no job.
  const lined = jobs.filter(j => typeof j.line === 'number');
  if (lined.length === jobs.length
      && new Set(lined.map(j => j.line)).size > 1) {
    // every row belongs to exactly one job: the first job on its own line, or
    // for a line that declares none, the last job read before it
    const owner = new Map();
    for (const j of jobs) if (!owner.has(j.line)) owner.set(j.line, j.name);
    const lineJob = new Map();
    let last = jobs[0].name;
    const maxLine = Math.max(...rows.map(r => r.line), ...jobs.map(j => j.line));
    for (let l = 0; l <= maxLine; l++) {
      if (owner.has(l)) last = owner.get(l);
      lineJob.set(l, last);
    }
    // TWO JOBS ON ONE LINE ARE TWO COLUMNS, NOT ALTERNATES (BMS46's analog page
    // puts battery voltage beside Speed): giving the whole line to the first job
    // orphaned the other's rows, and the poller drops keys the polled job did
    // not answer. The result name is the reliable link back
    // (STATUS_GESCHWINDIGKEIT answers STAT_GESCHWINDIGKEIT_WERT); where that
    // match is unambiguous it wins over the line, which covers rows it cannot resolve.
    const stem = (s) => String(s || '').replace(/^(STATUS|STAT)_/, '')
      .replace(/_(WERT|EINH|TEXT)$/, '');
    const byStem = new Map();
    for (const j of jobs) {
      const k = stem(j.name);
      byStem.set(k, byStem.has(k) ? null : j.name);   // null = ambiguous
    }
    const jobFor = (r) => {
      const hit = byStem.get(stem(r.key));
      return hit || lineJob.get(r.line);
    };
    return jobs.map(j => ({
      job: j.name,
      args: j.arg || '',
      group: scr.title || null,
      rows: rows.filter(r => jobFor(r) === j.name),
      grid: null,
    }));
  }
  return jobs.map(j => ({
    job: j.name,
    args: j.arg || '',
    group: scr.title || null,
    rows,
    grid: cells.length ? { cells } : null,
  }));
}

// The IR carries its own per-ECU translations (from tools/ipo_i18n.js). Set per
// render by irUseTranslations because irLabel is called from many places with
// no ECU in scope. deGerman is the fallback for an older IR and for strings
// arriving at runtime from the SGBD.
let _irI18n = null;
function irUseTranslations(ir) {
  _irI18n = (ir && ir.i18n) || null;
}

function irLabel(s) {
  if (!s) return s;
  if (_irI18n && Object.prototype.hasOwnProperty.call(_irI18n, s)) {
    return _irI18n[s];
  }
  return (typeof deGerman === 'function' && deGerman(s)) || s;
}

// A RESULTCOMMENT is DOCUMENTATION, not a display name: BMW pads the
// description with two-plus spaces then appends a value legend, so cut at the
// first run of two spaces. Only reaches the UI for rows INPA drew uncaptioned.
function irDescLabel(s) {
  if (!s) return s;
  let t = String(s).trim().split(/\s{2,}/)[0].trim();
  // a legend can also follow a single space ("... nicht unterstuetzt = 0")
  const eq = t.search(/\s+\S*=\s*-?\d/);
  if (eq > 12) t = t.slice(0, eq).trim();
  return t.replace(/[\s:,;.-]+$/, '') || String(s).trim();
}

// INPA's own state words, so a lamp reads ON/OFF in English mode
function irState(s) {
  if (s == null) return s;
  const t = String(s).trim();
  if (/^EIN$/i.test(t)) return 'ON';
  if (/^AUS$/i.test(t)) return 'OFF';
  if (/^JA$/i.test(t)) return 'YES';
  if (/^NEIN$/i.test(t)) return 'NO';
  return irLabel(t);
}

// A _TEXT result can carry the row's caption OR a state word; only the caption
// should replace the label. "Beschreibungstext" is the SGBD's placeholder for
// these results, not a caption (it put DESCRIPTIONSTEXT on MS450's rows).
const IR_STATE_WORD =
  /^(ein|aus|an|aktiv|inaktiv|nicht aktiv|bereit|ja|nein|on|off|active|not active|inactive|ready|yes|no|n\/?a|-+|beschreibungstext|descriptionstext)$/i;

// captions INPA recomputes each pass of a loop, so whichever one the decode
// captured belongs to no single row: a bare index "(1)", a wheel position
// heading, or its own placeholder "??"
const IR_LOOP_CAPTION = /^(\(\d+\)|\?+|Index \d+|Rad \d+|Position (FL|FR|RL|RR|VL|VR|HL|HR))$/i;

function irRowsTranslated(scr, descs) {
  return irScreens(scr).map(s => {
    // a LINE caption landing on more than one row identifies none of them; where
    // it repeats and the SGBD description does not, the description wins
    const seen = new Map();
    for (const r of s.rows) if (r.label) seen.set(r.label, (seen.get(r.label) || 0) + 1);
    const ambiguous = (r) => r.label && seen.get(r.label) > 1
      && descs && descs.get(r.key)
      && s.rows.filter(o => descs.get(o.key) === descs.get(r.key)).length === 1;
    return ({
    ...s,
    group: irLabel(s.group),
    rows: s.rows.map(r => ({
      ...r,
      // INPA's own caption first, then the SGBD result description, then the
      // bare key. A caption INPA computes per loop iteration ("(1)", "??")
      // describes no particular row, so the SGBD description wins over it.
      label: (r.pos ? `${irLabel(r.pos)} · ` : '') + irLabel(
        (IR_LOOP_CAPTION.test(r.label || '') || ambiguous(r) ? null : r.label)
        || irDescLabel(descs && descs.get(r.key)) || r.label || r.key),
      unit: r.unit ? irLabel(r.unit) : r.unit,
      on: irState(r.on),
      off: irState(r.off),
    })),
  });
  });
}

// result-name -> description, straight from the SGBD (offline, no cable).
// Cached per ECU: the same job serves several screens.
const _irDescCache = new Map();
async function irDescs(ecu, scr) {
  const jobs = (scr.jobs || []).filter(j => !j.write).map(j => j.name);
  const out = new Map();
  for (const job of jobs) {
    const ck = `${ecu.sgbd}:${job}`;
    if (!_irDescCache.has(ck)) {
      let m = new Map();
      try {
        const d = await api(`/api/ecu/${ecu.sgbd}/results/${job}`);
        for (const line of Array.isArray(d) ? d : []) {
          const i = String(line).indexOf(':');
          if (i > 0) {
            m.set(String(line).slice(0, i).trim(),
                  String(line).slice(i + 1).trim());
          }
        }
      } catch { m = new Map(); }
      _irDescCache.set(ck, m);
    }
    for (const [k, v] of _irDescCache.get(ck)) if (!out.has(k)) out.set(k, v);
  }
  return out;
}

// Chrome INPA implements itself (print/select/exit) is dropped: the app has
// those natively, and Back is the Esc key.
const IR_CHROME = /^(Back|Exit|Print|Zur(ü|ue)ck|Ende|End|Select|Deselect|Auswahl|Abwahl|Druck|Drucken|Gesamt)$/i;

// A fault-memory read: INPA runs these through its own library
// (INPAapiFsLesen_neu, writes na_fs.tmp), so the item names no job -- the memory
// is in the caption, handed to the app's fault reader. BMW ships three:
// Fehlerspeicher (EM/FS), Infospeicher (IM/IS), Historienspeicher (HM/HS).
// Word order varies by build ("Read EM", "EM Read", "FS lesen", plain "Read").
const IR_MEM_WORD =
  '(EM|IM|HM|FS|IS|HS|(error|fault|info(rmation)?|history)\\s+memory'
  + '|(Fehler|Info|Historien)speicher)';
const IR_FAULT_READ = new RegExp(
  `^(Read|Lesen)$|^(Read|Lesen)\\s+${IR_MEM_WORD}\\b`
  + `|^${IR_MEM_WORD}\\s+(Read|lesen)\\b|^(Shadow|Schatten)`, 'i');

// which memory a fault-menu caption names -> the SGBD job that reads it.
// "Shadow"/"Schattenspeicher" is the info memory under another name on TOENS
// (F3 answers IS_LESEN, no shadow job at all).
const IR_FAULT_JOB = [
  [/^(Shadow|Schatten)/i, 'IS_LESEN'],
  [/\b(IM|IS|Infospeicher|info(rmation)?\s+memory)\b/i, 'IS_LESEN'],
  [/\b(HM|HS|Historienspeicher|history\s+memory)\b/i, 'HS_LESEN'],
  [/\b(EM|FS|Fehlerspeicher|(error|fault)\s+memory)\b/i, 'FS_LESEN'],
];
// "Shadow" means two things by ECU: TOENS answers IS_LESEN, but 32 SGBDs have a
// real second fault store, 25 with NO IS_LESEN, so sending IS_LESEN there asks
// for a job the ECU lacks. Resolve against what the ECU declares: a real shadow
// job wins, else IS_LESEN stands.
const IR_SHADOW_JOBS = ['FS_SHADOW_LESEN', 'FS_LESEN_SHADOW', 'READ_SHADOW'];

// Async: may have to ask the archive which jobs exist (cached on the ecu, one
// request at most and only for a caption that says "Shadow").
async function irFaultJobFor(label, ecu) {
  const hit = (IR_FAULT_JOB.find(([re]) => re.test(label)) || [null, 'FS_LESEN'])[1];
  if (hit !== 'IS_LESEN' || !/^(Shadow|Schatten)/i.test(label)) return hit;
  if (!ecu || !ecu.sgbd) return hit;
  if (!ecu._jobNames) {
    try {
      const jobs = await api(`/api/ecu/${ecu.sgbd}/jobs`);
      ecu._jobNames = new Set(
        (Array.isArray(jobs) ? jobs : [])
          .map(j => String(typeof j === 'string' ? j : (j && j.name) || '')
            .toUpperCase()));
    } catch { ecu._jobNames = new Set(); }
  }
  return IR_SHADOW_JOBS.find(j => ecu._jobNames.has(j)) || hit;
}

// Items INPA implements against the FILE SYSTEM rather than the car (saving the
// fault list to disk). Like Print, they cannot be reproduced against an ECU.
const IR_FILE_ACTION = new RegExp(
  `^(store|save|speichern)\\b|^${IR_MEM_WORD} (speichern|drucken)$`
  + `|^(Save|Print)\\s+${IR_MEM_WORD}$`, 'i');

// A menu whose name carries chassis numbers only serves those chassis.
// Names with no digits (m_status, m_steuern) serve everything.
function irMenuFitsVariant(name, variant) {
  const nums = String(name).match(/\d+/g);
  const v = String(variant || '').match(/\d+/);
  if (!nums || !v) return true;
  return nums.includes(v[0]);
}

// Would INPA ever open `menuName` on this variant?
//
// A DEEP LINK IS UNTRUSTED INPUT. #car/E46/kombi46/m_steuern_digital_38 names a
// menu that exists in the corpus but belongs to the E38 cluster; opening it by
// name because the URL said so is exactly the bug the variant guards fix,
// re-entered through the address bar (a link shared from another car, or a
// bookmark kept after the variant was corrected).
//
// Answered from INPA's own dispatch, not from the name: a menu is reachable if
// some key that targets it is guarded FOR this variant, or if it is targeted
// with no guard at all (family-wide). Menus nothing links to -- roots -- are
// left to irRootMenu. Unknown variant means we cannot judge, so allow.
function irMenuAllowedForVariant(ir, menuName, variant) {
  if (!menuName || !variant) return true;
  let sawGuardedLink = false;
  for (const m of Object.values(ir.menus || {})) {
    for (const it of (m.items || [])) {
      // A BACK KEY IS NOT AN ENTRY. Every per-variant page links UP to its own
      // parent unconditionally (m_steuern_digital_85's Back -> m_steuern_85),
      // and counting that as a family-wide link made the E85 parent reachable
      // from any variant -- the exact thing this check exists to stop. Back
      // says where you came from, not who may go there.
      if (IR_CHROME.test(String(it.label || '').trim())) continue;
      const guards = it.menuFor || {};
      if (Object.prototype.hasOwnProperty.call(guards, menuName)) {
        sawGuardedLink = true;
        if ((guards[menuName] || []).some(
          n => String(n).toUpperCase() === String(variant).toUpperCase())) return true;
      } else if (it.menu === menuName || (it.menuAlts || []).includes(menuName)) {
        // linked with no condition on it: family-wide, anyone may open it
        if (!Object.keys(guards).length) return true;
      }
    }
  }
  // only ever reached through guards, none of which name this variant
  return !sawGuardedLink;
}

// Is `menu` just the softkey bar `from` already shows, rather than a submenu?
// INPA keeps the bar and swaps the SCREEN, so opening such a "menu" re-lists the
// bar a level deeper. Compared by CONTENT and by what the keys DO not what they
// are called (an item may take the screen's softkey help, so captions differ
// while the keys match).
function irSameBar(ir, menu, from) {
  if (!menu || !from || menu === from) return true;
  // compare the SCREEN each key selects, not the menu it installs; keys parked
  // on the family placeholder are ignored (counting those made two bars with
  // identical real keys look only 50% alike)
  const dead = new Set(Object.entries(ir.screens || {})
    .filter(([n, s]) => irHasVariantSuffix(n) && !irRows(s).rows.length)
    .map(([n]) => n));
  const sig = (m) => new Set((((ir.menus || {})[m] || {}).items || [])
    .filter(i => !(i.screen && dead.has(i.screen) && !i.menu))
    .map(i => `${i.nr}:${i.screen || i.action || ''}`)
    .filter(x => !/^\d+:$/.test(x)));
  const A = sig(menu), B = sig(from);
  if (!A.size || !B.size) return false;
  const shared = [...A].filter(x => B.has(x)).length;
  return shared / Math.max(A.size, B.size) > 0.8;
}

// INPA's menu IS a screen, and most ECUs print live identity values (part
// number, VIN, date) above the softkey list. Read once, not polled -- they are
// identity facts, not gauges.
async function irMenuHeader(ecu, ir, menuName, el) {
  if (!el) return;
  const name = ((ir.menus || {})[menuName] || {}).screen
    || (menuName === (ir.entry || {}).menu ? (ir.entry || {}).screen : null);
  const scr = name && (ir.screens || {})[name];
  if (!scr) return;
  const rows = irRows(scr).rows.filter(r => r.kind === 'value');
  const jobs = (scr.jobs || []).filter(j => !j.write);
  if (!rows.length || !jobs.length) return;
  const vals = new Map();
  for (const j of jobs) {
    try {
      const q = j.arg ? `?arg=${encodeURIComponent(j.arg)}` : '';
      const d = await api(`/api/ecu/${ecu.sgbd}/run/${j.name}${q}`,
                          { method: 'POST' });
      flatResults(d.sets).forEach(([k, v]) => vals.set(k, v));
    } catch { /* the menu still stands without its header */ }
  }
  const descs = await irDescs(ecu, scr);
  const shown = rows.filter(r => vals.has(r.key));
  if (!shown.length || !el.isConnected) return;
  el.innerHTML = shown.map(r => `<span class="ir-head-cell">`
    + `<span class="ir-head-label">`
    + `${esc(irLabel(r.label || descs.get(r.key) || r.key))}</span>`
    + `<span class="ir-head-value">${esc(String(vals.get(r.key)))}</span>`
    + `</span>`).join('');
}

// Does pressing this key open a MENU, or the screen it also names? A key can
// install both; the menu loses when it is merely the bar this level shows or
// holds nothing runnable. Shared by both open paths so they cannot disagree.
function irOpensMenu(ir, it, from) {
  return !!it.menu && !irSameBar(ir, it.menu, from)
    && (_irHasRunnable(ir, it.menu) || !it.screen);
}

// Does this menu hold anything the app can act on? Non-recursive on purpose:
// INPA's menus link back to their parents, so following submenus would loop.
function _irHasRunnable(ir, menuName) {
  const root = (ir.entry || {}).menu;
  return (((ir.menus || {})[menuName] || {}).items || []).some(
    it => (it.label || '').trim() && !it.fileAction && !it.appTool
          && !IR_CHROME.test(it.label.trim())
          // a key back to the ROOT is Back whatever it is called (detected
          // structurally), since deGerman can render Back/Print/End as anything
          && !(it.menu === root && !it.job && menuName !== root)
          && !['printscreen', 'exit', 'select', 'deselect'].includes(it.action)
          && (it.job || it.screen || it.menu || it.action)
          && (it.job || it.screen || it.menu || it.action));
}

function irMenuItems(ir, menuName, variant) {
  const menu = (ir.menus || {})[menuName];
  if (!menu) return [];
  // inside a menu INPA already chose for this variant, that menu's own tags
  // widen what counts as ours: pruning its pages by tag alone emptied the key
  const via = irScreenTags(ir, menuName);
  // the screen this menu is drawn on, so a key that merely redraws it can be
  // told apart from one that opens a different page
  const menuScreen = (menu.screen)
    || (menuName === (ir.entry || {}).menu ? (ir.entry || {}).screen : null);
  const pick = (it) => {
    const v = variant || ir._variant;
    // The guard is INPA's own answer, but only when the page it names has
    // something to draw. INPA parks keys it has no page for on a family
    // PLACEHOLDER (s_status_36_38_39_46_52_85 is listed for every variant and
    // holds no rows), and taking that literally hid KOMBI46's real status page.
    // irPickScreen already prefers a candidate with rows; let it.
    const g = irGuardPick(it.screenFor, v);
    if (g && irRows((ir.screens || {})[g] || {}).rows.length) return g;
    return irPickScreen(ir, it, v, via);
  };
  const pickMenu = (it) => {
    // INPA's OWN answer first: each menu key is an if/else-if chain on the
    // VARIANTE read at startup, and the decompiler now keeps which names guard
    // which target (menuFor). An exact match is what INPA would have run, so
    // nothing below needs to infer it from the name.
    const g = irGuardPick(it.menuFor, variant || ir._variant);
    if (g) return g;
    const m = irPickTagged(ir, [it.menu, ...(it.menuAlts || [])],
                           variant || ir._variant);
    return m === undefined ? (it.menu || null) : m;
  };
  const seen = new Set();
  return (menu.items || [])
    .filter(it => it.label && !IR_CHROME.test(it.label.trim()))
    // the key back to the root IS Back whatever it is called (a handful say
    // "Main menu"). Detected structurally; the app has Esc for this.
    .filter(it => !(menuName !== (ir.entry || {}).menu
                    && it.menu === (ir.entry || {}).menu && !it.job))
    // drives INPA rather than the car (loads a script, opens the KVP editor)
    .filter(it => !it.appTool)
    // a file action (PC-side file I/O, like Print) is an INPA function, not an
    // ECU one. The flag decides it outright now: it is set only by a real
    // write (fileopen "w"/"a", filewrite), a printfile, or a bare viewer, and
    // a key that questions the ECU or draws what it read is exempt. This used
    // to read `!IR_FAULT_READ.test(it.label)` -- un-hiding by CAPTION, because
    // viewopen (which merely displays na_fs.tmp) was mistaken for file I/O and
    // tagged every real fault read. That hid 535 keys naming real jobs whose
    // captions did not match, CAS m_fehler F1 (FS_LESEN) among them under an
    // empty label. On the current IR the caption test rescues 10 items and all
    // ten are prints that belong hidden.
    .filter(it => !it.fileAction)
    .filter(it => !(IR_FILE_ACTION.test(it.label.trim()) && !it.job
                    && !it.screen && !it.menu))
    // a key whose only effect is to redraw the menu's own screen does nothing
    .filter(it => !(it.screen === (ir.entry || {}).screen && !it.menu))
    // ...nor one that re-installs THIS menu and the screen it is already drawn
    // on -- how INPA returns from a PC-side action
    .filter(it => !(it.menu === menuName && !it.job && !it.action
                    && (!it.screen || it.screen === menuScreen
                        // INPA names the menu's screen after the menu
                        // (m_fehlersp -> s_fehlersp)
                        || it.screen === 's' + menuName.slice(1))))
    // an item with no navigation target is an ACTION INPA performs in place.
    // Actuator items only flip state flags and let the screen send the job:
    // listed but never runnable here (firing is gated on car verification, the
    // arming semantics not decoded). But an item that ALSO names a JOB is a real
    // function (CDC's "Trpmode ON"/"OFF" carry action "start" beside a job).
    // ...but a job the STATE MACHINE back-filled is not evidence of anything.
    // _seq_jobs attaches every job reachable in the machine to each key that
    // launches it, so ZKE5's display-scope "Select"/"Deselect" both came out
    // carrying STEUERN_DIGITAL and slipped through this filter into the
    // "not decoded" panel. 246 keys corpus-wide. A GENUINE action job stays
    // (MEV9N46L's "Exit" really does send STOP_SYSTEMCHECK_LSU, 330 of those),
    // and stateJob is exactly what tells the two apart.
    .filter(it => it.screen || it.menu || !it.action
                  || (it.job && !it.stateJob))
    // a write entry reusing a read entry's SCREEN is a duplicate of the read
    // page -- but ONLY when the write cannot RUN. "MV write" needs a typed value
    // we do not collect; MS450's "reset status" sends RESET_CRU_OFF on the
    // keypress, a real function. The difference is the prompt, not the caption.
    .filter(it => {
      const dup = it.screen && seen.has(it.screen)
        && (!it.job || it.prompt)
        && /write|schreiben|reset|clear|loesch/i.test(it.label);
      if (it.screen) seen.add(it.screen);
      return !dup;
    })
    .map(it => ({
      nr: it.nr,
      label: irLabel(it.label.trim()) || it.label.trim(),
      screen: it.screen ? pick(it) : null,
      // the job this item calls itself (Clear -> FS_LOESCHEN); open() tests
      // it.job, so dropping it here made every such key inert
      job: it.job || null,
      // changes the ECU permanently (EEPROM write, service reset) rather than
      // driving an actuator for the duration of a test
      writeJob: !!it.writeJob,
      shift: !!it.shift,   // pressed as Shift+Fn on a real INPA keyboard (ITEM n+10)
      // the argument this key sends, sometimes all that distinguishes it from
      // its neighbour (RADIO's sources, CDC's transport mode)
      jobArg: it.jobArg || null,
      // the index this key selects before opening a screen several keys share
      sel: Array.isArray(it._sel) ? it._sel[1] : null,
      // ...and the slot it stores into. Two keys writing the same slot with
      // different values are a MODE toggle (ZKE5's "with/without Quitting" sets
      // flag 29 to 1/0, which the actuator run reads).
      selSlot: Array.isArray(it._sel) ? it._sel[0] : null,
      // job came from a state machine, whose argument assembly is not decoded
      stateJob: !!it.stateJob,
      // a decoded state procedure (INPA's ident-write form): stateForm is the
      // write key (every field + ;-joined send order), stateEdit a "Change: X"
      // key, stateCopy "Set default values". See ipo_ir.py.
      stateForm: it.stateForm || null,
      stateEdit: it.stateEdit || null,
      stateCopy: it.stateCopy || null,
      // INPA asks the user for a value and builds the argument from it
      prompt: it.prompt || null,
      // an item that only writes a global: INPA runs it in place to set a page
      // value (a mode flag, an rpm/duty setpoint). Derived as {slot, value}
      // so the app applies it to its own page state -- no ECU contact.
      localSet: it.localSet || null,
      // a menu named for other chassis is dropped ONLY when the item also names
      // a screen serving this one; where the menu is all there is, dropping it
      // would leave the key dead
      menu: (() => {
        // INPA ships one Status/Activate menu PER VARIANT and lists the rest as
        // alternatives; taking it.menu blind gave KOMBI46 the _38 pages
        const m = pickMenu(it);
        return (m && it.screen
                && !irMenuFitsVariant(m, variant || ir._variant)
                && irRows(((ir.screens || {})[pick(it)]) || {}).rows.length)
          ? null : (m || null);
      })(),
      // no target and no action: INPA runs this in place (actuator toggles)
      inPlace: !it.screen && !it.menu,
      readable: it.screen
        ? irReadable((ir.screens || {})[pick(it)] || {}) : false,
    }))
    // every screen this key names belongs to another variant and it opens no
    // menu: INPA does not offer this key here, so neither do we
    .filter(it => it.screen || it.menu || it.job || it.inPlace)
    // a key whose menu holds nothing we can run is the same empty thing a level
    // down. Depth-limited not recursive (bars link Back to their parent).
    //
    // EXCEPT a captioned fault read. In INPA, "Read error memory" DISPLAYS the
    // list and the menu it names is the toolbar over that display -- Print,
    // Back, Exit and nothing else. By this rule that toolbar looks empty, so
    // the entry was dropped and a cluster's fault page offered only "Clear
    // error memory" with no way to read. 548 entries across the corpus are in
    // that shape; the caption tells us which memory to read, so keep them.
    .filter(it => !it.menu || it.screen || it.menu === menuName
                  || _irHasRunnable(ir, it.menu)
                  || IR_FAULT_READ.test(it.label));
}

// Actuator keys always run -- INPA sends on the keypress. The setting only
// decides whether we ask first, and defaults to asking: unlike INPA this app
// can be pointed at a car by someone who did not choose the test.
const confirmActuators = () => Settings.get('confirmActuators', 'on') !== 'off';

// Live actuator state per menu, mirroring INPA's own: the menu holds the
// argument word between presses, each key toggles its own pair, the whole word
// is sent every time. Starting from composite.baseline (INPA's startup value)
// makes our first send byte-identical.
const _compState = new Map();

function compWord(ir, menuName) {
  const comp = (ir.menus[menuName] || {}).composite;
  if (!comp) return null;
  const ck = `${ir.ecu}:${menuName}`;
  if (!_compState.has(ck)) {
    const base = comp.baseline
      ? comp.baseline.split(';')
      : new Array(comp.fields).fill('0');
    _compState.set(ck, base);
  }
  return _compState.get(ck);
}

// Mode-flag state per menu: slot -> the value last picked. Two keys writing the
// same slot with different values are a radio group the actuator run reads.
const _modeState = new Map();

// The other items in this menu that write the SAME slot as `it`. A non-empty
// result means `it` is one option of a mode toggle, not a lone dead key.
function irModeGroup(ir, menuName, it) {
  if (it.selSlot == null) return null;
  const peers = irMenuItems(ir, menuName)
    .filter(x => x.selSlot === it.selSlot);
  return peers.length > 1 ? peers : null;
}

// Which value of a mode slot is active: what the user last picked, else the
// group's lowest value (INPA's boot default).
function irModeValue(ir, menuName, group) {
  const ck = `${ir.ecu}:${menuName}:${group[0].selSlot}`;
  if (!_modeState.has(ck)) {
    const def = Math.min(...group.map(x => Number(x.sel)));
    _modeState.set(ck, def);
  }
  return _modeState.get(ck);
}

function irSetMode(ir, menuName, slot, value) {
  _modeState.set(`${ir.ecu}:${menuName}:${slot}`, Number(value));
}

// Send one actuator key: set its REQ/VAL pair in the shared word, post the job,
// show what went out and came back. No sub-screen -- INPA sends on the keypress.
async function runComposite(ecu, ir, menuName, it, container, reopen, keysFor) {
  const comp = (ir.menus[menuName] || {}).composite;
  const pair = comp && comp.items && comp.items[String(it.nr)];
  const word = comp && compWord(ir, menuName);
  if (!comp || !word) return;

  let on = null;
  if (pair) {
    // toggle this key's request flag; the value field follows it, except where
    // INPA only ever sends 0 for that field (RDC's CAL_VAL leaves value unused)
    const [reqI, valI] = pair;
    on = word[reqI] === '1' ? '0' : '1';
    word[reqI] = on;
    const valOnly = (comp.values || [])[valI];
    word[valI] = (valOnly && valOnly.length === 1)
      ? String(valOnly[0]) : on;
  }
  // no pair: this key is the COMMIT -- it sends the word as it stands, owning no field
  const arg = word.join(';');

  // REGISTER BEFORE SEND: the word lives in _compState between presses and would
  // survive leaving the screen with outputs still commanded. Register with the
  // NEUTRAL baseline word as the release (activations.js:9-11 invariant), so
  // leaving re-commands every field back to it; then irResetCompositeState
  // forgets the toggled flags.
  activationEcu = ecu;
  activeTests.add(comp.job);
  activeDrives.set(comp.job, (comp.baseline
    ? comp.baseline.split(';')
    : new Array(comp.fields).fill('0')).join(';'));

  // INPA stays on its menu, so the result goes to the status bar, not a page
  sbLeft.textContent = `${ecu.sgbd}.prg · ${comp.job} ${arg} · sending`;
  let out = null, err = null;
  try {
    out = await api(`/api/ecu/${ecu.sgbd}/run/${comp.job}`
      + `?arg=${encodeURIComponent(arg)}`, { method: 'POST' });
  } catch (e) { err = e; }

  const status = err
    ? `failed: ${err.message}`
    : (flatResults(out.sets).map(([k, v]) => `${k}=${v}`).slice(0, 3)
        .join(' ') || 'sent');
  sbLeft.textContent = `${ecu.sgbd}.prg · ${it.label} `
    + `${on === null ? 'sent' : (on === '1' ? 'ON' : 'OFF')} `
    + `· ${comp.job} ${arg} · ${status}`;
  // redraw so every row shows its current on/off state. Held: the redraw's
  // setActions is not a screen change and must not release the commanded word.
  keepActivationsDuring(reopen);
}

// forget every composite actuator word. Called by stopAllActivations AFTER it
// has sent the neutral word, so a re-entered menu starts from baseline rather
// than showing flags nobody is driving.
function irResetCompositeState() { _compState.clear(); }

// A screen with no gauges and no lamps is a labelled READ (coding, ident,
// references): a colon-aligned list that does not change while the car sits, so
// it gets the ID-data card (identity.js) not the polling gauge grid.
function irIsCard(scr) {
  if (irIsMemory(scr)) return false;
  const rows = irRows(scr).rows;
  // a coding page is labelled answers, some yes/no flags. All-labelled qualifies
  // whether or not some are flags, but a lamp only counts when INPA gave it no
  // on/off caption AND lamps do not dominate (BC_V's 18 clamps are a panel).
  const lamps = rows.filter(r => r.kind === 'lamp');
  const captioned = lamps.some(r => r.on || r.off);
  // lamps outnumbering NON-IDENT values means an indicator panel, not answers
  const identish = (r) => /^ID_|_NR$|^SN_/.test(r.key || '');
  const answers = rows.filter(r => r.kind !== 'lamp' && !identish(r)).length;
  const mostlyLamps = lamps.length > answers;
  const textish = (r) => r.kind === 'value'
    || (r.kind === 'lamp' && !captioned && !mostlyLamps);
  if (!rows.length || !rows.every(textish)) return false;
  // a per-position screen keyed by result name would show the last pass N times;
  // distinct captions make it a card again, but it must actually be LABELLED
  // (CAS's DME ringbuffer has rows and no captions -> a card of bare names)
  if (lamps.length && !rows.every(r => (r.label || '').trim())) return false;
  const args = rows.filter(r => r.arg != null);
  if (!args.length) return true;
  const caps = new Set(args.map(r => (r.label || '').trim()).filter(Boolean));
  return caps.size === args.length;
}

// What value is INPA asking for, and what will it accept?
//
// The prompt is the screen's own text, so the range is written the way BMW
// wrote it. All of these occur in the corpus:
//
//   "10-90 [degrees]"        "valve position (0-100 %)"
//   "DSC-Mode eingeben (0..3)"   "Angabe in Zahl von 0 bis 255"
//
// Parsed when we can, shown verbatim when we cannot -- a free-form prompt
// ("Bitte 'ON' oder 'OFF' eingeben") still gets asked, just as text. Returns
// { ask, lo, hi, unit } with lo === null when no range was found.
function irPromptRange(prompt) {
  const parts = (prompt || []).map((x) => String(x).trim()).filter(Boolean);
  // parts[0] repeats the item label; the question is what follows.
  const ask = (parts.length > 1 ? parts.slice(1) : parts).join(' — ');
  for (const text of parts.slice(1).length ? parts.slice(1) : parts) {
    const m = text.match(/(-?\d+)\s*(?:\.\.\.?|-|bis|to)\s*\+?(-?\d+)/i);
    if (!m) continue;
    let lo = Number(m[1]);
    let hi = Number(m[2]);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
    if (lo > hi) { const t = lo; lo = hi; hi = t; }
    // the unit rides in brackets or right after the range: [degrees], (0-100 %)
    const u = text.match(/\[([^\]]+)\]/) || text.match(/\d\s*([%A-Za-z°]+)\s*\)/);
    return { ask, lo, hi, unit: u ? u[1].trim() : '' };
  }
  return { ask, lo: null, hi: null, unit: '' };
}

// INPA's memory dump: SPEICHER_LESEN with a start address and byte count,
// printed as a hex dump. Decoding as rows gives one useless JOB_STATUS field,
// so it routes to showMemory instead.
function irIsMemory(scr) {
  return (scr.jobs || []).some(j => /^SPEICHER_LESEN/i.test(j.name))
    && irCaptions(scr).some(c => /address|adresse/i.test(c));
}

// Only where INPA itself names regions (tools/ipo_memory.py). An ECU like IHKA
// prints just "Start address" and "Number": no regions, no bounds.
function irMemoryScreen(scr, mined) {
  return (mined && (mined.regions || []).length) ? mined : null;
}

// INPA's plain memory screen: three labelled rows, first two prompting a value
// and the third showing what came back. Captions and order are the screen's
// own; no address range is implied because the ECU declares none.
async function renderIrMemory(ecu, scr, container, back, keys) {
  const job = ((scr.jobs || [])[0] || {}).name || 'SPEICHER_LESEN';
  const caps = irCaptions(scr).filter(c => !/^[:=|-]+$/.test(c));
  const [addrCap = 'Start address', numCap = 'Number', dataCap = 'Data'] = caps;
  const state = { addr: '', num: '', data: null, err: null };

  const draw = () => {
    const row = (k, v, act) =>
      `<div class="ident-line"><span class="ident-lk">${esc(k)}</span>`
      + `<span class="ident-lc">:</span>`
      + `<span class="ident-lv">${v ? esc(v) : '<span class="ink-faint">—</span>'}`
      + `</span></div>`;
    container.className = 'results-panel';
    container.innerHTML = `
      <div class="act-menu">
        <div class="act-menu-title">${esc(irLabel(scr.title) || 'Read memory')}</div>
        <div class="act-menu-sub mono">${esc(job)}</div>
        <div class="ident-card">
          ${row(irLabel(addrCap), state.addr)}
          ${row(irLabel(numCap), state.num)}
          ${row(irLabel(dataCap), state.err || state.data)}
        </div>
      </div>`;
    setActions([
      { key: '1', keyLabel: 'F1', label: irLabel(addrCap),
        fn: async () => {
          const v = await inputDialog({
            title: esc(irLabel(addrCap)),
            body: `Address to read from <b>${esc(ecu.label)}</b>.`,
            kind: 'hex', confirmLabel: 'Set' });
          if (v != null) { state.addr = v; draw(); }
        } },
      { key: '2', keyLabel: 'F2', label: irLabel(numCap),
        fn: async () => {
          const v = await inputDialog({
            title: esc(irLabel(numCap)), body: 'Number of bytes to read.',
            kind: 'number', confirmLabel: 'Set' });
          if (v != null) { state.num = v; draw(); }
        } },
      { key: '3', keyLabel: 'F3', label: 'Read', kind: 'primary',
        fn: async () => {
          if (!state.addr || !state.num) {
            sbLeft.textContent = 'address and count needed'; return;
          }
          state.err = null;
          sbLeft.textContent = `${job} ${state.addr};${state.num} · reading`;
          try {
            const out = await api(`/api/ecu/${ecu.sgbd}/run/${job}`
              + `?arg=${encodeURIComponent(state.addr + ';' + state.num)}`,
              { method: 'POST' });
            state.data = flatResults(out.sets)
              .map(([k, v]) => v).filter(Boolean).join(' ') || '(no data)';
            sbLeft.textContent = `${job} · read`;
          } catch (e) {
            state.err = e.message;
            sbLeft.textContent = 'failed';
          }
          draw();
        } },
      { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: back },
    ]);
  };
  draw();
}

// INPA's "Information" screen describes the SCRIPT, not the car (rework program,
// version, SGBD file header). It reads no ECU results, so it would render blank;
// the SGBD answers the same facts through its INFO pseudo-job (offline), paired
// with the captions positionally.
const IR_INFO_KEYS = ['TITLE', 'VERSION', 'ORIGIN', 'PACKAGE', 'ECU',
                      'REVISION', 'AUTHOR', 'SPRACHE', 'COMMENT'];

// Deliberately narrow: "no result rows plus captions" also describes a screen
// whose values this decoder failed to extract, and pairing those with INFO
// would INVENT data. So identify by INPA's own name (`s_info`) plus the absence
// of softkey help, which rules out a screen that merely hosts a menu.
function irIsInfo(scr, name) {
  if (name !== 's_info') return false;
  if (irRows(scr).rows.length) return false;
  if (scr.softkeys && Object.keys(scr.softkeys).length) return false;
  return irCaptions(scr).length >= 3;
}

// the printed captions of a screen that has no result rows, in draw order
function irCaptions(scr) {
  const out = [];
  for (const ln of scr.lines || [])
    for (const e of ln.elements || [])
      if (e.t === 'text') {
        const s = String(e.s || '').trim();
        if (s && !/^[:=|-]+$/.test(s)) out.push(s);
      }
  return out;
}

// Info as a card: INPA's captions paired in order with the INFO results. Extra
// captions with no counterpart are kept blank, not dropped -- INPA prints them.
function irInfoCard(scr) {
  const caps = irCaptions(scr);
  return {
    title: irLabel(scr.title) || 'Information',
    subtitle: 'script and SGBD information · read-only',
    jobs: ['INFO'],
    fields: caps.map((c, i) => ({
      key: IR_INFO_KEYS[i] || `_cap${i}`,
      label: irLabel(c) || c,
    })),
  };
}

// One IR screen as the shape renderIdentity consumes.
function irAsCard(scr, descs) {
  const { rows } = irRows(scr);
  return {
    title: irLabel(scr.title) || 'Read',
    subtitle: (scr.jobs || []).map(j => j.name).join(' · ') + ' · read-only',
    // argument-carrying jobs are read per FIELD below, so listing them here
    // too would read each block twice and keep only the last
    jobs: (scr.jobs || []).filter(j => !j.write && j.arg == null)
      .map(j => j.name),
    fields: rows.map(r => ({
      key: r.key,
      label: irLabel(r.label || irDescLabel(descs && descs.get(r.key)) || r.key),
      // INPA reads this row in its own pass, so the card reads it separately
      ...(r.arg != null
        ? { arg: r.arg, job: (scr.jobs || []).find(j => !j.write)?.name }
        : {}),
    })),
  };
}

// Does this name end in one or more variant suffixes (_36, _38_39, _36c)? INPA
// suffixes a screen with the chassis numbers it serves (s_status_36).
const irHasVariantSuffix = (n) => /_\d+[a-zA-Z]?(_\d+[a-zA-Z]?)*$/.test(String(n));

// The target INPA's own dispatch would pick for this variant.
//
// `guards` is {target: [VARIANTE, ...]} lifted straight out of the bytecode --
// each menu/screen key compiles to an if/else-if chain over the VARIANTE read
// at startup, and this is that condition. An exact name match therefore IS
// INPA's decision, not an inference from it. Returns null when the item is not
// variant-guarded (most are not) or when no arm names this variant, in which
// case the caller falls back to the name-tag heuristics.
// Does opening this item require a variant we do not have?
//
// A key whose targets are variant-guarded is an if/else-if chain on VARIANTE;
// INPA runs INITIALISIERUNG before dispatching and never guesses. With a car
// attached and no answer, following the first branch hands the user another
// cluster's page -- that is how an E46 reached the E38 activation rows and
// called jobs kombi46 does not have. Say so instead.
//
// Demo mode is exempt: there is no car to ask, and irResolveVariant already
// picks a variant INPA itself lists.
function irNeedsVariant(it, variant) {
  if (variant) return false;
  if (typeof demoMode === 'function' && demoMode()) return false;
  return Object.keys((it && it.menuFor) || {}).length > 1
      || Object.keys((it && it.screenFor) || {}).length > 1;
}

function irGuardPick(guards, variant) {
  if (!guards || !variant) return null;
  const V = String(variant).toUpperCase();
  for (const [target, names] of Object.entries(guards)) {
    if ((names || []).some(n => String(n).toUpperCase() === V)) return target;
  }
  return null;
}

// Is this variant one the screen suffixes can address at all? KOMBI31..KOMBI85
// carry their number; IKE and IKI do not (INPA reaches them by name), so no
// numeric suffix can select for or against them.
function irVariantIsNumbered(ir, variant) {
  const roots = Object.entries(ir.rootVariants || {});
  const V = String(variant).toUpperCase();
  const root = roots.find(([, vs]) => vs.some(v => v.toUpperCase() === V));
  if (!root) return true;
  return (root[0].match(/\d+/g) || []).some(t => V.includes(t));
}

const _irTagCache = new WeakMap();
function irScreenTags(ir, name) {
  let per = _irTagCache.get(ir);
  if (!per) { per = new Map(); _irTagCache.set(ir, per); }
  if (per.has(name)) return per.get(name);
  const names = Object.values(ir.rootVariants || {}).flat()
    .map(v => String(v).toUpperCase());
  const tags = [];
  for (const t of String(name).match(/\d+[a-zA-Z]?(?=_|$)/g) || []) {
    const T = t.toUpperCase();
    // a lettered tag (39C, 46R) names ONE variant and must match exactly; a bare
    // number matches variants continuing with digits or a body letter ("46"
    // covers KOMBI46 and KOMBI46R) but must NOT swallow a lettered sibling with
    // differing jobs (36 is not 36C). "39" matches KOMBI39C only as a fallback,
    // since irPickTagged prefers the more specific _39C name.
    const re = /[a-zA-Z]$/.test(T) ? new RegExp(`${T}$`)
                                   : new RegExp(`${T}\\d*[a-zA-Z]?$`);
    for (const v of names) if (re.test(v) && !tags.includes(v)) tags.push(v);
  }
  per.set(name, tags);
  return tags;
}

// Choose the name in `pool` that serves `variant`. Returns undefined when tags
// say nothing (caller keeps its default) and null when every candidate is
// tagged for OTHER variants -- INPA has no such key here.
function irPickTagged(ir, pool, variant, via) {
  pool = (pool || []).filter(Boolean);
  if (!pool.length || !variant) return undefined;
  const V = String(variant).toUpperCase();
  // reached through a menu INPA chose for this variant: its pages are ours
  const ok = (n) => {
    const t = irScreenTags(ir, n);
    return t.includes(V) || (via || []).some(v => t.includes(v));
  };
  // a name carrying a variant suffix is variant-specific even when the suffix
  // names no variant in this root (belongs to a sibling), so not family-wide
  const tagged = pool.filter(n => irHasVariantSuffix(n));
  // a variant matching NO suffix in this pool is one INPA identifies by name
  // (IKE, IKI are the E38/E39 clusters, so KOMBI's _38 screens are theirs);
  // numeric tags cannot speak for it, so the tagged names stay eligible
  if (!pool.some(ok) && !irVariantIsNumbered(ir, V)) return undefined;
  // a name tagged for this variant outright beats one merely reachable through
  // the menu; among equals, the fewest variants sharing it wins
  const rank = (n) => (irScreenTags(ir, n).includes(V) ? 0 : 1);
  const hit = tagged.filter(ok)
    .sort((a, b) => rank(a) - rank(b)
                 || irScreenTags(ir, a).length - irScreenTags(ir, b).length)[0];
  if (hit) return hit;
  // an untagged name is family-wide and always allowed
  const generic = pool.find(n => !irHasVariantSuffix(n));
  if (generic) return generic;
  return tagged.length === pool.length ? null : undefined;
}

function irPickScreen(ir, it, variant, via) {
  const all = [it.screen, ...(it.screenAlts || [])].filter(Boolean);
  const withRows = all.filter(n => {
    const s = (ir.screens || {})[n];
    return s && irRows(s).rows.length;
  });
  if (variant && withRows.length) {
    const hit = irPickTagged(ir, withRows, variant, via);
    if (hit !== undefined) return hit;
  }
  // every candidate is empty: INPA parks a key it has no page for on the family
  // placeholder. Drop only that -- a screen INPA draws from its own text
  // (s_info) is empty of ECU results by nature and stays, as does a menu key.
  if (!withRows.length && all.length
      && all.every(n => irHasVariantSuffix(n))
      && !irIsInfo((ir.screens || {})[all[0]] || {}, all[0])) return null;
  return all[0] || it.screen;
}

// Open ONE root item directly, for a section mapping to a single INPA key
// (Special -> Memory). Returns false when there is nothing to show, so the
// caller can fall back.
function irOpenItem(ecu, ir, menuName, it, container, back) {
  irUseTranslations(ir);
  // a key can install a menu AND a screen; the screen wins unless the menu is a
  // narrower list than the one we came from (see irOpensMenu / irSameBar)
  if (irOpensMenu(ir, it, menuName)) {
    return renderIrMenu(ecu, ir, it.menu, container, back);
  }
  const scr = (ir.screens || {})[it.screen];
  if (!scr) return false;
  if (irIsMemory(scr)) {
    const mined = (ecu._layout || {}).special;
    const mem = irMemoryScreen(scr, mined && mined.memory);
    if (mem && typeof showMemory === 'function') showMemory(ecu, mem, container, back);
    else renderIrMemory(ecu, scr, container, back, () => []);
    return true;
  }
  if (!irReadable(scr)) return false;
  irDescs(ecu, scr).then((d) => {
    const screens = irRowsTranslated(scr, d);
    if (irIsCard(scr)) {
      renderIdentity(ecu, irAsCard(scr, d), container,
                     { key: 'Escape', keyLabel: 'Esc', label: 'Back',
                       kind: 'back', fn: back });
    } else if (screens.length) {
      showInpaCategory(ecu, screens, container, irLabel(scr.title) || it.label);
      setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back',
                    kind: 'back', fn: back }]);
    }
  });
  return true;
}

// A decoded ident-write form: INPA's "Only for the developer" ident page as one
// editable card. Reads the module to pre-fill, stages edits, shows the exact
// semicolon-joined argument the write WOULD send -- and STOPS there: an ident
// write is an EEPROM write behind INPA's developer gate (same contract as the
// coding editor).

// normalise a caption for matching: strip trailing colon/padding, lower-case,
// so "BMW part number :" and "BMW part number" pair.
function irCapKey(s) {
  return String(s || '').replace(/[:\s]+$/, '').trim().toLowerCase();
}

function irStateReadJob(ir) {
  // the module's own ident READ: a *_LESEN / IDENT* job on a card screen (prefer
  // IDENT-named). Also return the caption->key pairing so the form can fill each
  // field by MEANING, since the read's key order and the form's differ.
  let best = null;
  for (const scr of Object.values(ir.screens || {})) {
    const keys = [];
    const byCaption = {};
    for (const ln of scr.lines || []) {
      let lastCap = null;
      for (const e of ln.elements || []) {
        if (e.t === 'text' && e.s && !/^[:=|\- ]+$/.test(e.s)) lastCap = e.s;
        if (e.key) {
          keys.push(e.key);
          if (lastCap) byCaption[irCapKey(lastCap)] = e.key;
        }
      }
    }
    if (!keys.length) continue;
    const job = (scr.jobs || [])[0];
    if (!job) continue;
    const score = keys.length + (/IDENT/i.test(job.name) ? 100 : 0)
      + Object.keys(byCaption).length;
    if (!best || score > best.score)
      best = { job: job.name, keys, byCaption, score };
  }
  return best;
}

// The read screen showing the same fields a buffer-only "actual values" screen
// only captions. Returns its name, or null when there is no confident match --
// redirecting the wrong screen would show unrelated data. The bar: this item's
// screen has captions but no job or rows, its menu carries a write form, and
// exactly one other screen is an ident read with >= as many value bindings.
function irIdentReadScreen(ir, menuName, it) {
  const menu = ir.menus[menuName];
  if (!menu || !menu.items.some(x => x.stateForm)) return null;
  const scr = it.screen && (ir.screens || {})[it.screen];
  if (!scr) return null;
  const keysOf = (s) => {
    const out = [];
    for (const ln of s.lines || [])
      for (const e of ln.elements || []) if (e.key) out.push(e.key);
    return out;
  };
  const capsOf = (s) => (typeof irCaptions === 'function' ? irCaptions(s) : [])
    .filter(c => !/^[:=|\- ]+$/.test(c));
  // this item's screen must be captions-only: no job, no value rows
  if ((scr.jobs || []).length || keysOf(scr).length) return null;
  const wantCaps = capsOf(scr).length;
  if (wantCaps < 2) return null;
  // the ident read: a card screen whose job identifies the ECU and whose value
  // bindings cover the captions (prefer IDENT-named jobs)
  let best = null;
  for (const [name, s] of Object.entries(ir.screens || {})) {
    if (name === it.screen) continue;
    const ks = keysOf(s);
    if (ks.length < wantCaps) continue;
    const identJob = (s.jobs || []).some(j => /IDENT/i.test(j.name));
    const idKeys = ks.filter(k => /^ID[_A-Z]/i.test(k)).length;
    if (!identJob && idKeys < wantCaps) continue;
    const score = ks.length + (identJob ? 100 : 0) + idKeys;
    if (!best || score > best.score) best = { name, score };
  }
  return best ? best.name : null;
}

async function showStateForm(ecu, ir, menuName, it, container, back, trail) {
  // the full field set is on the write key; a Change key edits a subset, so find
  // the sibling write item for every field and the send order
  let form = it.stateForm;
  let sendOrder = form ? form.fields.map(f => f.slot) : null;
  let sep = form ? (form.sep || ';') : ';';
  let job = it.job || null;
  const focus = new Set((it.stateEdit ? it.stateEdit.fields : []).map(f => f.slot));
  if (!form) {
    // a Change / Set-default key: pull the full field set and send order from
    // the sibling write key, so the whole form is here
    const items = irMenuItems(ir, menuName);
    const wr = items.find(x => x.stateForm);
    if (wr) { form = wr.stateForm; sendOrder = form.fields.map(f => f.slot);
              sep = form.sep || ';'; job = wr.job || job; }
  }
  const fields = form ? form.fields
    : (it.stateEdit ? it.stateEdit.fields : []);
  if (!fields.length) { back(); return; }

  // value per slot, staged; starts from the module read
  const val = new Map();
  const read = irStateReadJob(ir);

  const prefill = async () => {
    if (!read) return;
    try {
      const out = await api(`/api/ecu/${ecu.sgbd}/run/${read.job}`,
                            { method: 'POST' });
      const got = flatResults(out.sets);
      const byKey = new Map(got);
      // pair each form field to a read result BY CAPTION first, regardless of
      // order; fall back to position only for a field the read does not label,
      // and never onto a key already claimed
      const used = new Set();
      const claim = (f, k) => {
        if (k != null && byKey.has(k) && !used.has(k)) {
          val.set(f.slot, String(byKey.get(k))); used.add(k); return true;
        }
        return false;
      };
      const unmatched = [];
      fields.forEach((f) => {
        const k = (read.byCaption || {})[irCapKey(f.caption)];
        if (!claim(f, k)) unmatched.push(f);
      });
      // leftover fields take leftover keys in order, without stealing a match
      let ki = 0;
      unmatched.forEach((f) => {
        while (ki < read.keys.length && used.has(read.keys[ki])) ki++;
        if (ki < read.keys.length) claim(f, read.keys[ki]);
      });
    } catch { /* no cable / demo off: fields stay blank */ }
  };

  // the write order, or just the fields shown if this key has no sibling write
  const order = sendOrder || fields.map(f => f.slot);
  const argString = () => order.map(s => val.get(s) ?? '').join(sep);

  // Edit one field. Hex by default; an int/num dialog variant takes a number.
  const editField = async (f) => {
    const v = await inputDialog({
      title: irLabel(f.caption) || `slot ${f.slot}`,
      body: `<span class="mono">${esc(f.dialog || 'inputhex')}</span>`
        + (f.min || f.max ? `<br>Range ${esc(f.min)}`
            + `${f.max ? ' … ' + esc(f.max) : ''}` : '')
        + `<br><br>Editing this stages the value; nothing is sent.`,
      kind: /int|num/i.test(f.dialog || '') ? 'number' : 'hex',
      example: val.get(f.slot) || f.min || '',
      confirmLabel: 'Set' });
    if (v != null && v !== '') { val.set(f.slot, String(v).trim()); draw(); }
  };

  const draw = () => {
    container.className = 'results-panel';
    // each field is a full-width clickable row opening the same dialog as its F-key
    const row = (f, i) => {
      const v = val.get(f.slot);
      const on = focus.size && focus.has(f.slot);
      return `<button class="state-row${on ? ' state-focus' : ''}" `
        + `data-i="${i}" type="button">`
        + `<span class="state-row-k">${esc(irLabel(f.caption) || f.caption
            || ('slot ' + f.slot))}</span>`
        + `<span class="state-row-v mono">${v != null && v !== ''
            ? esc(v) : '<span class="ink-faint">—</span>'}</span>`
        + `<span class="state-range mono">${esc(f.min || '')}`
        + `${f.max ? '…' + esc(f.max) : ''}</span>`
        + `<span class="state-row-edit">edit ✎</span></button>`;
    };
    container.innerHTML = `
      <div class="act-menu">
        <div class="act-menu-title">${esc(irLabel(it.label) || 'Write ident')}</div>
        <div class="act-menu-sub mono">${esc(ecu.sgbd)}.prg`
      + `${job ? ' · ' + esc(job) : ''}</div>
        <div class="cod-note" id="state-note"></div>
        <div class="state-list">${fields.map(row).join('')}</div>
        <div class="state-arg mono" id="state-arg"></div>
      </div>`;
    container.querySelectorAll('.state-row').forEach(b =>
      b.onclick = () => editField(fields[Number(b.dataset.i)]));
    const note = container.querySelector('#state-note');
    note.innerHTML = read
      ? `<span class="cod-note-dim">Read from the module, then edit any field. `
        + `Nothing is sent.</span>`
      : `<span class="cod-note-dim">Edit any field to build the argument. `
        + `Nothing is sent.</span>`;
    const argEl = container.querySelector('#state-arg');
    argEl.innerHTML = `<span class="ink-faint">would send</span> `
      + `${job ? esc(job) + ' ' : ''}${esc(argString())}`;

    // one F-key per field (up to nine), then Read (re-fill) and Write
    const acts = [];
    fields.slice(0, 8).forEach((f, i) => {
      acts.push({ key: String(i + 1), keyLabel: `F${i + 1}`,
        label: irLabel(f.caption) || `slot ${f.slot}`,
        fn: () => editField(f) });
    });
    if (read) {
      acts.push({ key: 'r', keyLabel: 'R', label: 'Read',
        fn: async () => { sbLeft.textContent = `${read.job}…`;
          await prefill(); draw();
          sbLeft.textContent = `${ecu.sgbd}.prg · ${read.job} · read`; } });
    }
    // the write is shown, explained, and REFUSED -- an ident write is a
    // permanent EEPROM change (same contract as the coding editor's F2 Review)
    acts.push({ key: 'w', keyLabel: 'W', label: 'Write…',
      fn: () => confirmDialog({
        title: 'Write ident data',
        body: `This would send <span class="mono">${esc(job || 'the write job')}`
          + `</span> to <b>${esc(ecu.label)}</b> with:<br><br>`
          + `<span class="mono">${esc(argString())}</span><br><br>`
          + `<b>Not sent.</b> An ident write is an EEPROM write behind INPA's `
          + `own "Only for the developer" gate, and this app has not verified `
          + `a round-trip on a recoverable module. Use this to check the `
          + `values, not to apply them.`,
        confirmLabel: 'OK', cancelLabel: 'Close' }) });
    acts.push({ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
                fn: back });
    setActions(acts);
    sbLeft.textContent = `${ecu.sgbd}.prg · ${trail.join(' · ')}`;
  };

  draw();
  await prefill();
  draw();
}

// Walk the IR from a menu: list entries, open a screen, descend a submenu, Esc
// back up -- INPA's own navigation, and ours.
function renderIrMenu(ecu, ir, menuName, container, back, trail = []) {
  irUseTranslations(ir);
  // what this script owes the ECU on the way out (INPA's own inpaexit proc).
  // Registered on entry so it is sent however the user leaves, not only when
  // they press a key we do not draw.
  if (ir.exitJob && typeof registerSessionEnd === 'function') {
    registerSessionEnd(ecu, ir.exitJob);
  }
  const items = irMenuItems(ir, menuName);
  if (!items.length) return false;
  // mirror the menu into the URL so a submenu is a shareable deep link. Only
  // the root carries no menu segment, keeping #car/<CH>/<SGBD> the ECU's own
  // link rather than a redundant root-menu one.
  if (typeof routeSetCar === 'function' && ecu && ecu.chassis && ecu.sgbd) {
    const root = typeof irRootMenu === 'function' ? irRootMenu(ir, ecu._variant) : null;
    routeSetCar(ecu.chassis, ecu.sgbd, menuName === root ? null : menuName);
  }

  const open = async (it) => {
    // This key dispatches on VARIANTE and we do not know it yet: ask the car
    // before opening anything, because the branches lead to DIFFERENT ECUs'
    // pages. Retried here rather than only at screen load, so a read that
    // failed once (bus busy, cable just plugged in) can succeed on the click.
    if (irNeedsVariant(it, ir._variant || ecu._variant)) {
      const prev = sbLeft.textContent;
      sbLeft.textContent = 'reading variant…';
      try {
        if (typeof irResolveVariant === 'function') {
          ecu._variant = null;                 // force a re-read
          await irResolveVariant(ecu);
        }
      } catch { /* reported below */ }
      sbLeft.textContent = prev;
      if (!(ir._variant || ecu._variant)) {
        // Not resolved: do NOT guess a branch. Stay on this menu -- the user is
        // left exactly where they were, with the reason.
        await confirmDialog({
          title: 'Cannot tell which control unit this is',
          body: `<b>${esc(it.label)}</b> opens a different page for each `
            + `variant of this module, and the variant read `
            + `(<span class="mono">${esc(ir.variantJob || 'INITIALISIERUNG')}`
            + `</span>) did not answer.<br><br>`
            + `Opening it now would show another control unit's functions, `
            + `which call jobs this one does not have. Check the cable and `
            + `ignition, then try again.`,
          confirmLabel: 'OK', cancelLabel: 'Close',
        });
        return;
      }
      // resolved: redraw so every key re-picks with the variant known
      renderIrMenu(ecu, ir, menuName, container, back, trail);
      return;
    }
    // a MODE TOGGLE: one option of a radio group setting a shared flag the
    // actuator run reads. Calls no job and navigates nowhere, so picking it just
    // records the choice and redraws to show which is active. A card that
    // navigates (menu/screen) is never one of these, even if it shares a
    // selSlot -- treat it as navigation so clicking opens the page.
    const modeGroup = !it.menu && !it.screen && irModeGroup(ir, menuName, it);
    if (modeGroup) {
      irSetMode(ir, menuName, it.selSlot, it.sel);
      renderIrMenu(ecu, ir, menuName, container, back, trail);
      return;
    }

    // a DECODED STATE PROCEDURE (INPA's ident-write form). All three key kinds
    // land on one form that reads the module, lets each field be edited, and
    // shows the exact argument that WOULD be sent -- never sending it (writeJob).
    if ((it.stateForm || it.stateEdit || it.stateCopy)
        && typeof showStateForm === 'function') {
      const reopen = () =>
        renderIrMenu(ecu, ir, menuName, container, back, trail);
      showStateForm(ecu, ir, menuName, it, container, reopen,
                    [...trail, it.label]);
      return;
    }

    // "Display actual values" beside a write form: INPA draws it from its edit
    // buffer (captions but NO job, nothing to poll). The module reads the same
    // fields through its ident job, so redirect to that read.
    const idRead = irIdentReadScreen(ir, menuName, it);
    if (idRead) {
      it = { ...it, screen: idRead };
    }

    // Fault memory is read through INPA's own library (writes na_fs.tmp), so the
    // decode has a caption and nothing to run -- the app's fault view takes over.
    // The key may present three ways, all handled below:
    //   - it names a job first (route on what the key IS, unless the job is the
    //     fault read itself);
    //   - it names a SCREEN with no rows (INPA formats the list in code);
    //   - its SCREEN carries the job (FS_LOESCHEN on s_fs_loesch).
    const jobScreen = it.screen && (ir.screens || {})[it.screen];
    if (!it.job && jobScreen && !irReadable(jobScreen)
        && (jobScreen.jobs || []).length === 1
        && !IR_FAULT_READ.test(it.label)) {
      const only = jobScreen.jobs[0];
      // Memory clears are the ONLY write surfaced this way. Anything else
      // (CODIERDATEN_SCHREIBEN, a control-unit reset) takes an argument the
      // SCREEN builds from a menu selection, so sending it bare would write
      // whatever the ECU makes of nothing -- those stay listed, not armed here.
      const clears = /^(FS|IS|HS)_LOESCHEN$/i.test(only.name);
      // PROVE-CLEAR-BY-RE-READ: the generic in-place path printed JOB_STATUS and
      // reopened, so a fault that re-set the moment the ECU saw it looked
      // cleared. runJob owns the flow (confirm -> clear -> re-read -> report).
      if (clears && typeof runJob === 'function') {
        const reopen = () =>
          renderIrMenu(ecu, ir, menuName, container, back, trail);
        const mem = only.name.toUpperCase();
        if (mem === 'FS_LOESCHEN') {
          // runJob's own FS_LOESCHEN branch: confirm, clear, re-read, render remains
          await runJob(ecu, 'FS_LOESCHEN', container, true);
        } else {
          const which = mem === 'IS_LOESCHEN' ? 'info memory' : 'history memory';
          const ok = await confirmDialog({
            title: `Clear ${which}?`,
            body: `This permanently erases the ${which} on `
                + `<b>${esc(ecu.label)}</b>. This cannot be undone.`,
            confirmLabel: 'Clear', danger: true,
          });
          if (!ok) { sbLeft.textContent = 'cancelled'; return; }
          try {
            await api(`/api/ecu/${ecu.sgbd}/run/${mem}`, { method: 'POST' });
          } catch (e) {
            container.innerHTML = errorBlock(e.message);
            sbLeft.textContent = 'failed';
            setActions([...keys(), {
              key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
              fn: reopen,
            }], shiftKeys());
            return;
          }
          // PROVE THE CLEAR: re-read the same memory and show what remains
          await runJob(ecu, mem.replace('_LOESCHEN', '_LESEN'), container, false);
        }
        // runJob's status line stands; only the keys need restoring
        setActions([...keys(), {
          key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
          fn: reopen,
        }], shiftKeys());
        return;
      }
      // A SCREEN THAT DID NOT DECODE IS NOT AN ACTION: !irReadable is true both
      // of a key INPA runs and of a screen this decompiler failed to lift, so the
      // job must ALSO LOOK like an action. STATUS_* only reads and is never
      // offered to run on a car; START/STOP/DIAGNOSE/INIT/RESET and clears belong.
      const acts = /^(START|STOP|DIAGNOSE|DIAGNOSEMODE|INITIALISIERUNG|INIT|ENDE|SLEEP|RESET)[_A-Z0-9]*$/i
        .test(only.name);
      if ((!only.write && acts) || clears) {

        it = { ...it, job: only.name, writeJob: !!only.write, inPlace: true };
      }
    }
    const faultScreen = it.screen && (ir.screens || {})[it.screen];
    // A "Read error memory" entry may carry no job at all: in INPA, choosing it
    // DISPLAYS the fault list and the submenu it points at is the toolbar over
    // that display (Print / Back / Exit). The decompiler captured the toolbar
    // but not the implied read, so 614 entries across the corpus name a memory
    // they never read -- the app then dropped them and the screen showed only
    // "Clear error memory". If the caption says it reads a memory and nothing
    // downstream actually does, run the read the caption names.
    const subMenu = it.menu && (ir.menus || {})[it.menu];
    const subReads = subMenu
      && (subMenu.items || []).some(x => /^(FS|IS|HS)_/i.test(String(x.job || '')));
    const faultKey = IR_FAULT_READ.test(it.label)
      && (it.inPlace
          || (faultScreen && !irReadable(faultScreen)
              && (faultScreen.jobs || []).some(j => /^FS_/i.test(j.name)))
          || (!it.job && !faultScreen && !subReads));
    if (faultKey
        && !/^(FS|IS|HS)_LESEN$/i.test(it.job || '')
        && typeof runJob === 'function') {
      // the caption says WHICH memory ("Read IM" -> IS_LESEN); "Shadow" needs
      // the ECU asked, not just the caption read, so it resolves before the run
      irFaultJobFor(it.label, ecu)
        .then(j => runJob(ecu, j, container, false))
        .catch(() => runJob(ecu, 'FS_LESEN', container, false));
      sbLeft.textContent = `${ecu.sgbd}.prg · ${it.label}`;
      // INPA's fault display carries a Print key (its submenu IS that toolbar).
      // This bar is the one on screen while the codes show, so Print belongs
      // here, not only on the menu behind it.
      setActions([...keys(), {
        key: 'p', keyLabel: 'P', label: 'Print', kind: 'print',
        fn: () => exportFaults(ecu, container),
      }, {
        key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
        fn: () => renderIrMenu(ecu, ir, menuName, container, back, trail),
      }], shiftKeys());
      return;
    }
    // a key that installs a MENU opens it, whatever else it does: INPA's root
    // keys set screen AND menu together, where the screen is only the window.
    // (irOpensMenu excludes a menu no narrower than this one: same bar kept.)
    if (irOpensMenu(ir, it, menuName)) {
      renderIrMenu(ecu, ir, it.menu, container,
                   () => renderIrMenu(ecu, ir, menuName, container, back, trail),
                   [...trail, it.label]);
      return;
    }
    // an item with its own job (Sleep -> SLEEP_MODE) is an ordinary
    // one-key-one-job action, unrelated to any composite word
    if (it.inPlace && it.job
        && !((ir.menus[menuName] || {}).composite || {}).items?.[String(it.nr)]) {
      const reopen = () =>
        renderIrMenu(ecu, ir, menuName, container, back, trail);
      // a persistent write ALWAYS asks, whatever the setting says: the confirm
      // toggle matches INPA on actuator TESTS (which stop on leave), but an
      // EEPROM write or service reset does not undo itself.
      const permanent = it.writeJob;
      // a write whose job came from a STATE machine is NEVER sent: INPA gathers
      // what to write first, and that assembly is not decoded, so firing the job
      // bare would write whatever the ECU makes of an empty argument. EEPROM
      // writes behind the "Only for the developer" gate; listed, never run.
      if (it.stateJob) {
        container.className = 'results-panel';
        container.innerHTML = `<div class="empty"><div>`
          + `<strong>${esc(it.label)}</strong></div>`
          + `<div>INPA runs this as a sequence that first gathers what to `
          + `write, then sends <code>${esc(it.job)}</code>. That assembly is `
          + `not decoded, so this is listed but never sent.</div></div>`;
        sbLeft.textContent = `${ecu.sgbd}.prg · ${it.label} · not sent`;
        setActions([...keys(), {
          key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
          fn: reopen,
        }], shiftKeys());
        return;
      }
      // DRIVING AN OUTPUT ON A VARIANT NOBODY CONFIRMED. Reading an
      // unverified module is harmless; commanding one is not -- the SGBD on
      // screen is the chassis config's pick, and 609 of the 1000 grouped rows
      // sit behind a group that can name a different variant. The same ORT
      // byte means a different output on a sibling, so this refuses rather
      // than energizing whatever answers. Not a decode gap: reconnect and
      // reopen and the group's IDENTIFIKATION settles it.
      if (ecu.group && ecu._variantSource
          && ['unverified', 'unavailable'].includes(ecu._variantSource)) {
        container.className = 'results-panel';
        container.innerHTML = `<div class="empty"><div>`
          + `<strong>${esc(it.label)}</strong></div>`
          + `<div>This would run <code>${esc(it.job)}</code> on `
          + `<b>${esc(ecu.sgbd)}</b>, but nothing has confirmed that is the `
          + `variant fitted: <b>${esc(ecu.label)}</b> shares diagnostic `
          + `address <span class="mono">${esc(ecu.group)}</span> with other `
          + `modules, and the app is showing the configuration&rsquo;s pick. `
          + `Reads are fine; driving an output is not, because the same `
          + `command means a different thing on a sibling.</div>`
          + `<div style="font-size:12px;color:var(--ink-faint)">Connect the `
          + `cable and reopen this module &mdash; the address group identifies `
          + `itself and this unlocks on its own.</div></div>`;
        sbLeft.textContent = `${ecu.sgbd}.prg · ${it.label} · variant unverified`;
        setActions([...keys(), { key: 'Escape', keyLabel: 'Esc', label: 'Back',
                                 kind: 'back', fn: reopen }], shiftKeys());
        return;
      }
      if (confirmActuators() || permanent) {
        const ok = await confirmDialog({
          title: `${permanent ? 'Write to' : 'Activate on'} `
            + `${esc(ecu.label)}?`,
          body: `Runs <span class="mono">${esc(it.job)}</span>`
            + (it.jobArg
              ? ` with <span class="mono">${esc(it.jobArg)}</span>` : '')
            + ` for <b>${esc(it.label)}</b>.<br><br>`
            + (permanent
              ? 'This changes the ECU <b>permanently</b> — it is not an '
                + 'actuator test and does not undo itself when you leave.'
              : 'This drives a real component and stays as set until you '
                + 'change it back or leave this screen.'),
          confirmLabel: permanent ? 'Write' : 'Activate', danger: true,
        });
        if (!ok) { sbLeft.textContent = 'cancelled'; return; }
      }
      // INPA asks for a value and appends it to the job's argument. The IR
      // carries both halves, so ask the same question and assemble the same
      // way rather than refusing:
      //
      //   jobArg "TACHO;"  + user "45"  ->  STEUERN_ANZEIGE "TACHO;45"
      //
      // The trailing ';' IS the marker for "a value goes here" -- 170 entries
      // across the corpus use it. The prompt text carries the accepted range
      // ("10-90 [degrees]", "(0..3)", "0 bis 255"), which irPromptRange parses
      // when it can and simply shows verbatim when it cannot. Nothing here is
      // specific to one screen or one ECU.
      if (it.prompt && String(it.jobArg || '').endsWith(';')) {
        const spec = irPromptRange(it.prompt);
        const asked = await inputDialog({
          title: esc(it.label),
          body: `INPA asks: <b>${esc(spec.ask)}</b><br><br>`
            + `Runs <span class="mono">${esc(it.job)}</span> with `
            + `<span class="mono">${esc(it.jobArg)}&lt;value&gt;</span>.`
            + (spec.lo != null
              ? `<br><br>Accepted range <b>${spec.lo}</b> to <b>${spec.hi}</b>`
                + (spec.unit ? ` ${esc(spec.unit)}` : '') + '.'
              : ''),
          kind: spec.lo != null ? 'number' : 'text',
          example: spec.lo != null ? String(spec.lo) : '',
          confirmLabel: 'Activate', danger: true,
        });
        if (asked == null || String(asked).trim() === '') {
          sbLeft.textContent = 'cancelled';
          return;
        }
        const val = String(asked).trim();
        if (spec.lo != null) {
          const n = Number(val);
          if (!Number.isFinite(n) || n < spec.lo || n > spec.hi) {
            container.className = 'results-panel';
            container.innerHTML = errorBlock(
              `${val} is outside the range INPA accepts here `
              + `(${spec.lo}-${spec.hi}${spec.unit ? ' ' + spec.unit : ''}).`);
            sbLeft.textContent = 'out of range';
            setActions([...keys(), { key: 'Escape', keyLabel: 'Esc',
              label: 'Back', kind: 'back', fn: reopen }], shiftKeys());
            return;
          }
        }
        it = { ...it, jobArg: it.jobArg + val };
      } else if (it.prompt) {
        // No trailing ';' means we do not know WHERE the answer goes in the
        // argument. Guessing would command a position nobody chose.
        container.className = 'results-panel';
        container.innerHTML = `<div class="empty"><div>`
          + `<strong>${esc(it.label)}</strong></div>`
          + `<div>INPA prompts for ${esc(it.prompt.join(' — '))} and builds `
          + `<code>${esc(it.job)}</code>'s argument from the answer. This `
          + `job's argument has no value slot we can identify, so it is `
          + `listed but not sent.</div></div>`;
        sbLeft.textContent = `${ecu.sgbd}.prg · ${it.label} · needs input`;
        setActions([...keys(), {
          key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
          fn: reopen,
        }], shiftKeys());
        return;
      }
      sbLeft.textContent = `${ecu.sgbd}.prg · ${it.job} · sending`;
      try {
        // arg often distinguishes two keys (RADIO sources differ only in "FM"/"CDC")
        const q = it.jobArg ? `?arg=${encodeURIComponent(it.jobArg)}` : '';
        // REGISTER BEFORE SEND: an unreleased drive outlives the screen, and the
        // confirm above promises release on leave. Arg _ENDE fallback: register
        // "arg;0" as the release. Not for a permanent write (nothing to release)
        // or an OFF form (already a stop).
        const drives = !permanent
          && /^(STEUERN|START)/i.test(it.job)
          && !/(_AUS|_ENDE|_OFF|_STOP)$/i.test(it.job)
          && typeof activeTests === 'object';
        if (drives) {
          activationEcu = ecu;
          activeTests.add(it.job);
          activeDrives.set(it.job, it.jobArg ? `${it.jobArg};0` : null);
        }
        const out = await api(`/api/ecu/${ecu.sgbd}/run/${it.job}${q}`,
                              { method: 'POST' });
        // a permanent write is set-and-stay and must NOT be replayed with arg=0
        if (!permanent) {
          activationEcu = ecu;
          activeTests.add(it.job);
          activeDrives.set(it.job, null);
        }
        const r = flatResults(out.sets).map(([k, v]) => `${k}=${v}`)
          .slice(0, 3).join(' ') || 'sent';
        sbLeft.textContent = `${ecu.sgbd}.prg · ${it.label} · ${it.job} · ${r}`;
      } catch (e) {
        sbLeft.textContent = `${ecu.sgbd}.prg · ${it.label} · failed: ${e.message}`;
      }
      // held: redrawing this same menu is not a leave, and must not replay arg=0
      keepActivationsDuring(reopen);
      return;
    }
    if (it.inPlace && (ir.menus[menuName] || {}).composite) {
      const reopen = () =>
        renderIrMenu(ecu, ir, menuName, container, back, trail);
      if (confirmActuators()) {
        const comp = ir.menus[menuName].composite;
        const n = Object.keys(comp.items || {}).length;
        const ok = await confirmDialog({
          title: `Activate ${esc(it.label).toLowerCase()}?`,
          body: `Runs <span class="mono">${esc(comp.job)}</span> on `
            + `<b>${esc(ecu.label)}</b> — one job carrying all `
            + `${comp.fields} fields, so it re-commands all ${n} actuators `
            + `at once.<br><br>This drives real components.`,
          confirmLabel: 'Activate', danger: true,
        });
        if (!ok) { sbLeft.textContent = 'cancelled'; return; }
      }
      await runComposite(ecu, ir, menuName, it, container, reopen);
      return;
    }
    if (it.inPlace && it.localSet) {
      // A LOCAL PAGE SETTING, run in place like INPA: pressing the key sets a
      // value the page reads (ZKE5's quit-mode, MS450's rpm/duty setpoint).
      // The derivation captured {slot, value}; the app keeps its own map and
      // the following send-key reads from it. Nothing reaches the ECU here.
      ir._pageState = ir._pageState || {};
      ir._pageState[it.localSet.slot] = it.localSet.value;
      sbLeft.textContent = `${ecu.sgbd}.prg · ${it.label} · set`;
      // re-render so the value shows as selected; INPA highlights the active
      renderIrMenu(ecu, ir, menuName, container, back, trail);
      return;
    }
    if (it.inPlace) {
      // a KEY INPA RUNS ON THE PC, NOT THE CAR: NAVI's "languages load" reads a
      // language table off the filesystem for the next key, so it has no job in
      // the .IPO. The job it feeds takes three language codes, so a picker
      // (navlang.js) does what the file did.
      if (/sprach|language/i.test(it.label) && /lad|load/i.test(it.label)
          && typeof showNavLanguages === 'function') {
        const reopen = () =>
          renderIrMenu(ecu, ir, menuName, container, back, trail);
        showNavLanguages(ecu, container, reopen);
        return;
      }
      // reached only when this menu has NO decoded composite: with the word
      // undecoded we cannot tell what it sends, so saying so beats guessing
      container.className = 'results-panel';
      container.innerHTML = `<div class="empty"><div>`
        + `<strong>${esc(it.label)}</strong></div>`
        + `<div>INPA runs this from the menu itself. What it sends is not `
        + `decoded for this ECU, so it cannot be reproduced here.</div></div>`;
      sbLeft.textContent = `${ecu.sgbd}.prg · ${it.label} · not decoded`;
      setActions([...keys(), {
        key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
        fn: () => renderIrMenu(ecu, ir, menuName, container, back, trail),
      }], shiftKeys());
      return;
    }
    const scr = (ir.screens || {})[it.screen];
    const backAct = {
      key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
      fn: () => renderIrMenu(ecu, ir, menuName, container, back, trail),
    };
    if (scr && irIsMemory(scr)) {
      const mined = (ecu._layout || {}).special;
      const mem = irMemoryScreen(scr, mined && mined.memory);
      const reopen = () =>
        renderIrMenu(ecu, ir, menuName, container, back, trail);
      if (mem && typeof showMemory === 'function') {
        showMemory(ecu, mem, container, reopen);
      } else {
        await renderIrMemory(ecu, scr, container, reopen, keys);
      }
      sbLeft.textContent = `${ecu.sgbd}.prg · ${[...trail, it.label].join(' · ')}`;
      return;
    }
    // INPA's Information screen: script/SGBD facts, no ECU results
    if (scr && irIsInfo(scr, it.screen)) {
      renderIdentity(ecu, irInfoCard(scr), container, backAct);
      sbLeft.textContent = `${ecu.sgbd}.prg · ${[...trail, it.label].join(' · ')}`;
      return;
    }
    // labelled reads render as the ID-data card, the way the Info tab does
    if (scr && irIsCard(scr)) {
      renderIdentity(ecu, irAsCard(scr, await irDescs(ecu, scr)),
                     container, backAct);
      sbLeft.textContent = `${ecu.sgbd}.prg · ${[...trail, it.label].join(' · ')}`;
      return;
    }
    let screens = scr
      ? irRowsTranslated(scr, await irDescs(ecu, scr)) : [];
    // a screen several keys share, parameterised by the index the key set
    // (MS450's AIF keys all open s_aif, differing only in the record AIF_LESEN reads)
    if (scr && it.sel != null
        && (scr.jobs || []).some(j => j.argFromMenu)) {
      screens = screens.map(x => ({ ...x, args: String(it.sel) }));
    }
    if (screens.length) {
      showInpaCategory(ecu, screens, container, irLabel(scr.title) || it.label);
    } else if (it.job) {
      // THE SCREEN IS THE BACKDROP, THE JOB IS THE ACTION. An actuator key
      // names both: "Activate self test" carries STEUERN_SELBSTTEST and points
      // at s_steuern, which is a bare title screen with no jobs and one line --
      // what INPA draws WHILE the test runs, not a readout. Because the item
      // had a screen it was not `inPlace`, so the drive branch above never saw
      // it and the empty screen fell through to "not offered here", for a job
      // this ECU really has and answers OKAY to.
      //
      // Re-enter through the SAME branch rather than sending here: that one
      // confirms, registers the drive for release-on-leave, and handles write
      // jobs. Sending directly would energize an output with none of that.
      await open({ ...it, inPlace: true, screen: null });
      return;
    } else if (scr && scr.pickJob
               && (scr.lines || []).some(l => (l.keys || []).length)) {
      // A TOGGLELIST PICKER. INPA shows the actuator rows, the user picks one,
      // and the picked row's key IS the job's argument -- BMW declares
      // togglelist's third parameter `out: string ApiToggleString`
      // (Inpa.h:39), so the value is produced by the widget, never stored in
      // the bytecode. The decompiler recovers the CONTRACT (which job the
      // selection feeds, see _toggle_job) and the rows come from the screen,
      // so the same list can be offered here.
      //
      // Picking a row re-enters the ordinary actuator branch with the key as
      // jobArg, which is what gives it the confirm dialog, the register-
      // before-send, and release-on-leave. Nothing is sent from this list.
      irPickAndDrive(ecu, ir, scr, it, menuName, container, back, trail, open);
      return;
    } else {
      container.className = 'results-panel';
      container.innerHTML = `<div class="empty"><div>`
        + (scr && !irReadable(scr)
          ? ((scr.jobs || []).some(j => /^(STATUS|LESEN|MESSWERT)/i.test(j.name))
            // a READ whose layout did not lift: distinguish a decompiler gap
            // from INPA genuinely having no readout (don't claim "action")
            ? `INPA draws readouts here that this build could not decode from `
              + `the .IPO yet, so there is nothing to show.`
            : `In INPA this entry performs an action, not a readout — it is `
              + `not offered here until verified on a car.`)
          : `INPA lists this entry, but it has no readouts.`)
        + `</div></div>`;
    }
    sbLeft.textContent = `${ecu.sgbd}.prg · ${[...trail, it.label].join(' · ')}`;
    setActions([...keys(), {
      key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
      fn: () => renderIrMenu(ecu, ir, menuName, container, back, trail),
    }], shiftKeys());
  };

  // INPA's softkey bar has two rows: F1..F10 and their shifted partners, which
  // the bytecode numbers ITEM n+10. "F13" would name a key INPA does not have.
  const fkey = (it) => (it.shift ? `\u21e7F${it.nr - 10}` : `F${it.nr}`);

  // the shifted row reuses the same F-numbers (F3 and Shift+F3 are both "3");
  // binding by list position would put the shift key on whatever slot it occupied
  const asAction = (it) => {
    const n = it.shift ? it.nr - 10 : it.nr;
    return {
      // F10 is the "0" key; F20 is INPA's Exit (reached with Esc), so no digit
      key: n === 20 ? null : String(n % 10),
      // the ITEM's own SHORT caption ("E 15%"), not the long body one (nine of
      // which all truncate to "Activat...")
      keyLabel: fkey(it), label: irLabel(it.short) || it.label,
      fn: () => open(it),
    };
  };
  const plain = items.filter(it => !it.shift);
  const shifted = items.filter(it => it.shift);
  const keys = () => plain.slice(0, FKEY_SLOTS).map(asAction);
  const shiftKeys = () => shifted.slice(0, FKEY_SLOTS).map(asAction);

  const count = (it) => {
    // a decoded ident-write form: both write and Change keys open a working screen
    if (it.stateForm) return 'build';
    if (it.stateEdit) return 'edit';
    if (it.stateCopy) return 'default';
    // A navigation card (opens a submenu or screen) is NOT a mode option, even
    // if the IR happens to give it a selSlot: the ●on/○ lamp is for the
    // mutually-exclusive VALUE rows inside a mode-select screen, not for the
    // function-group tiles on a root menu. Showing it there reads as a toggle
    // the user can flip, which these are not.
    if (it.menu || it.screen) return '';
    // a mode toggle: the row shows a lamp for the currently-selected option
    const modeGroup = irModeGroup(ir, menuName, it);
    if (modeGroup) {
      return Number(it.sel) === irModeValue(ir, menuName, modeGroup)
        ? '● on' : '○';
    }
    // reflects the SETTING, not the item: with actuator tests enabled these DO
    // run, so a fixed "not runnable" would be a lie. Once running, the row shows
    // its own armed state.
    if (it.inPlace) {
      const comp = (ir.menus[menuName] || {}).composite;
      const pair = comp && comp.items && comp.items[String(it.nr)];
      const word = pair && compWord(ir, menuName);
      if (word) return word[pair[0]] === '1' ? 'ON' : 'off';
      // sends the assembled word without owning a field, or calls its own job
      if (comp && (comp.send || []).includes(String(it.nr))) return 'send';
      if (it.job) return 'run';
      // a local page setting (mode flag / setpoint): shows as active when set
      if (it.localSet) {
        const cur = ir._pageState && ir._pageState[it.localSet.slot];
        return cur === it.localSet.value ? 'set ✓' : 'set';
      }
      // a fault-memory read names no job but open() hands it to the fault view
      if (IR_FAULT_READ.test(it.label)) return 'read';
      // the PC-side language picker, which does work (see open())
      if (/sprach|language/i.test(it.label) && /lad|load/i.test(it.label)) {
        return 'choose';
      }
      return 'not decoded';
    }
    if (!it.menu && !it.screen) return '';
    // no count for a screen or submenu: it would be a prediction before the job
    // runs, wrong often enough to be worth less than the space. Opening shows truth.
    return '';
  };

  if (inpaMode()) {
    container.className = 'results-panel';
    container.innerHTML = `<div class="ir-menu-head" id="ir-head"></div>`
      + `<div class="act-key-list" id="ir-list"></div>`;
    // the menu is drawn from the same screen the keys are (see irMenuHeader)
    irMenuHeader(ecu, ir, menuName, container.querySelector('#ir-head'));
    const list = container.querySelector('#ir-list');
    // only the BAR swaps: INPA prints the shifted keys permanently in a second
    // column on the right and swaps only the F-key row, so the body never repaints
    const rowsOf = (shownItems, into) => shownItems.forEach((it) => {
      const row = document.createElement('button');
      row.className = 'inpa-fn act-key-row';
      row.innerHTML = `<span class="inpa-fn-key">`
        + (it.shift ? `&lt; Shift &gt; + &lt; F${it.nr - 10} &gt;`
          : `&lt; F${it.nr} &gt;`) + `</span>`
        + `<span class="inpa-fn-label">${esc(it.label)}</span>`
        + `<span class="act-key-val">${esc(count(it))}</span>`
        // the arrow marks a key that GOES somewhere; an in-place key keeps none
        + `<span class="ir-enter">`
        + `${irOpensMenu(ir, it, menuName) || it.screen ? '&#8629;' : ''}`
        + `</span>`;
      row.onclick = () => open(it);
      into.appendChild(row);
    });
    rowsOf(plain, list);
    if (shifted.length) {
      const col = document.createElement('div');
      col.className = 'act-key-list ir-shift-col';
      rowsOf(shifted, col);
      list.parentNode.insertBefore(col, list.nextSibling);
      container.classList.add('ir-has-shift');
    }
  } else {
    container.className = 'group-grid stagger';
    container.innerHTML = '';
    // THE JOB SAYS WHAT THE KEY DOES; the caption only describes it. Reading
    // the caption first mis-sorted 1,686 tiles and left 11,861 more on the
    // neutral default although their job named the category outright --
    // ABSASC4's brake actuators run STEUERN_DIGITAL under captions like
    // "Intake valve front left", so nothing marked them as commanding
    // hardware. SGBD job names are a fixed vocabulary and never translated,
    // unlike the captions, which are half German across the corpus.
    function catOfJob(job) {
      if (!job) return null;
      if (/^(FS|IS|HS)_/i.test(job)) return 'gt-fault';
      if (/^(STATUS|MESSWERT)/i.test(job)) return 'gt-live';
      if (/^(STEUERN|START)/i.test(job)) return 'gt-act';
      if (/IDENT|^INFO$/i.test(job)) return 'gt-info';
      if (/COD|ADAPT|ABGLEICH/i.test(job)) return 'gt-code';
      return null;
    }
    function getGroupCat(it) {
      // a write outranks everything: it is the one category the user must see
      if (it.writeJob) return 'gt-code';
      const byJob = catOfJob(it.job);
      if (byJob) return byJob;
      // no job to go on -- fall back to the caption
      const label = it.label || '';
      if (/fault|error|fehlerspeicher|fs_/i.test(label)) return 'gt-fault';
      if (/status|analog|digital|live|messwert/i.test(label)) return 'gt-live';
      if (/actuat|ansteuer|test|component|active/i.test(label)) return 'gt-act';
      if (/ident|sgbd|info|aif|user info/i.test(label)) return 'gt-info';
      if (/cod|adapt|reset|abgleich/i.test(label)) return 'gt-code';
      return 'gt-default';
    }
    items.forEach((it) => {
      const cls = getGroupCat(it);
      const tile = document.createElement('div');
      tile.className = `group-tile ${cls}`;
      tile.innerHTML = `
        <div class="group-header-row">
          <span class="group-fkey">${it.shift ? 'Shift+' : ''}F${it.nr > 10 ? it.nr - 10 : it.nr}</span>
        </div>
        <div class="group-name">${esc(it.label)}</div>
        <div class="group-count">${esc(count(it))}</div>
        <div class="group-arrow">→</div>`;
      tile.onclick = () => open(it);
      container.appendChild(tile);
    });
    stagger(container, 20);
  }

  // Print sits on the MENU bar, not the fault view: a fault read draws into
  // this container without re-setting actions, so this bar is the one on screen
  // when codes are showing. It stays listed with nothing read (the bar is
  // painted once, before any read) -- exportFaults says "read codes first".
  // kind:'print' also puts it in the mobile ƒ sheet, which has no F-keys.
  setActions([...keys(), {
    key: 'p', keyLabel: 'P', label: 'Print', kind: 'print',
    fn: () => exportFaults(ecu, container),
  }, {
    key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: back,
  }], shiftKeys());

  // anything the app adds to the ROOT menu must be re-added on every draw: this
  // function redraws the root from inside itself when a submenu returns, and a
  // row appended afterwards is wiped by that redraw (the Coding entry vanished so)
  if (menuName === irRootMenu(ir, ecu._variant) && typeof irRootExtras === 'function') {
    irRootExtras(ecu, container);
  }
  return true;
}

// Set by showEcu: what to append to the root menu after every draw of it.
// A function of (ecu, container), or null when there is nothing to add.
let irRootExtras = null;
function setIrRootExtras(fn) { irRootExtras = fn; }

// The ECU's own root menu, rendered as INPA draws it. Deliberately NO table
// mapping INPA's labels to app sections -- that needs a regex per label per
// language and drops unanticipated keys. Presentation is decided by the decoded
// screen (irIsCard), not the key.
function irRootMenu(ir, variant) {
  // several roots, one per variant, matched by the variant job. With no answer
  // yet, prefer the root serving the most variants, not the first declared
  // (KOMBI's first is the E31/E32/E34 menu, which has no Status or Memory).
  const rv = ir.rootVariants;
  if (rv) {
    const names = Object.keys(rv);
    const hit = variant && names.find(n =>
      (rv[n] || []).some(v => v.toUpperCase() === String(variant).toUpperCase()));
    const pick = hit
      || names.sort((a, b) => (rv[b] || []).length - (rv[a] || []).length)[0];
    if (pick && irMenuItems(ir, pick).length) return pick;
  }
  const name = (ir.entry || {}).menu;
  const root = (ir.menus || {})[name];
  if (!root) return null;
  return irMenuItems(ir, name).length ? name : null;
}
