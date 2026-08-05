// The IR interpreter: draw an ECU's screens from data/inpa-ir/<ECU>.json
// instead of from hand-written or per-section layout code.
//
// tools/ipo_ir.py emits the whole INPA UI per ECU -- menus with INPA's own
// ITEM numbers, screens as ordered LINEs of positioned elements (text / value
// / gauge / lamp) with the row and column INPA itself draws them at, and the
// jobs each screen runs. This walks that structure.
//
// Nothing here knows anything about any particular ECU. The only per-ECU
// knowledge in the app after this is translation, which is applied at render
// time because each .IPO's strings are frozen in whatever language BMW
// compiled it with (`language` in the IR says which).
//
// Values still come from the existing live poller: an IR screen converts to
// the {job, rows, grid} shape showInpaScreens already consumes, so paging,
// gauge cells, lamp glyphs and the demo mode all work unchanged. The IR's
// contribution is WHICH rows, in WHAT order, with WHICH captions and ranges.

// screens whose elements are all static text have nothing to poll
function irReadable(scr) {
  return (scr.lines || []).some(ln =>
    (ln.elements || []).some(e => e.key && e.t !== 'text'));
}

// Pair captions to values by WHERE INPA drew them, for the lines where reading
// order alone cannot: it may print a whole row of captions and then the whole
// row of values beneath ("Clamp R / Clamp 15 / Clamp 61" on row 4, their three
// lamps on row 6), so "nearest preceding text" hands all three the last
// caption and leaves two showing a bare result name.
//
// Returns a Map(element -> caption) only when the pairing is unambiguous, and
// null otherwise. Every condition here was added because dropping it damaged
// rows the reading-order rule already had right -- measured across the corpus,
// not assumed:
//
//   - one caption per value, each used once. A shared heading ("clamps" over
//     three lamps) is a group title, not a label.
//   - a caption labels what is drawn to its RIGHT or BELOW, never its left.
//     DWA4 prints "Driver door" at column 5 and "Passenger door" at 45; by
//     raw distance the column-30 lamp takes the passenger caption.
//   - at most two rows above, or a group title two groups up wins.
function irCaptionsByPosition(els, valued) {
  const placed = (e) => typeof e.row === 'number' && typeof e.col === 'number';
  const vals = valued.filter(placed);
  if (vals.length < 2) return null;
  const texts = els.filter(e => e.t === 'text' && placed(e)
    && String(e.s || '').trim()
    && !/^\[.+\]$/.test(String(e.s).trim())
    && !/^[:=|/-]+$/.test(String(e.s).trim())
    // a printed softkey row is the screen's own key help, not a caption:
    // taking it labelled IHKA's flap position "< F3 >  Fresh air flap"
    && !/^<\s*(Shift\s*>\s*\+\s*<\s*)?F\s*\d+\s*>/.test(String(e.s).trim()));
  if (texts.length < vals.length) return null;
  const out = new Map();
  for (const v of vals) {
    let best = null, bestD = Infinity;
    for (const t of texts) {
      if (t.row > v.row || (t.row === v.row && t.col > v.col)) continue;
      if (v.row - t.row > 2) continue;
      // Nearest by COLUMN first, then by row. A caption printed above its
      // value is centred near it ("Clamp 15" at column 45, its lamp at 50),
      // so ranking by leftward distance alone made the rightmost caption win
      // for every lamp in the row.
      const d = Math.abs(t.col - v.col) * 100 + (v.row - t.row);
      if (d < bestD) { bestD = d; best = t; }
    }
    if (best) out.set(v, String(best.s).trim().replace(/\s*[:=]\s*$/, ''));
  }
  if (out.size !== vals.length) return null;
  return new Set(out.values()).size === vals.length ? out : null;
}

// A screen's rows, in INPA's own drawing order.
//
// Captions: INPA prints a label as its own `text` element beside the value,
// so a row's caption is the nearest preceding text on the same line -- and
// when a LINE names several keys ("Wheel speed FL, Wheel speed FR" over
// "STAT_..._VL_WERT;STAT_..._VR_WERT"), the caption splits positionally.
function irRows(scr) {
  const rows = [];
  const cells = [];
  // a screen that reads the same job once per position (wheel, bank,
  // cylinder) repeats its result keys per LINE, distinguished only by the
  // job's argument. Rows carry that argument so the poller reads each pass
  // separately and one wheel's value cannot overwrite another's.
  const multiArg = new Set((scr.lines || []).map(l => l.jobArg)
    .filter(Boolean)).size > 1;
  let lineNo = -1;
  for (const ln of scr.lines || []) {
    lineNo++;
    const els = ln.elements || [];
    const caps = String(ln.caption || '').split(',').map(s => s.trim());
    // a caption element carries a key but is not a row: counting it made a
    // two-gauge line look like four values, so a two-part LINE caption
    // ("AdaptionEinlass, AdaptionAuslass") no longer split one half per
    // gauge and every row took the first half.
    const valued = els.filter(e => e.key && e.t !== 'text' && e.t !== 'caption');
    // one caption for several unrelated keys is a LOOP screen: INPA draws the
    // heading once at a computed position and reuses it (RDC prints
    // "Position FL..RR" round a wheel loop). Applying it to every key labels
    // three different readouts identically, so take no label instead.
    const capForAll = caps.length === 1 && caps[0] && valued.length === 1;
    const byPos = irCaptionsByPosition(els, valued);
    // did INPA emit ALL the captions and then all the values? Only then is
    // reading order structurally wrong rather than merely incomplete.
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
      // a _TEXT result read purely to caption the value below it. The ECU
      // supplies the wording, so it is a live caption rather than a row --
      // carried on the row it labels and filled in by the poller.
      if (e.t === 'caption') { captionKey = e.key; continue; }
      if (e.t === 'text') {
        const s = String(e.s || '').trim();
        // "[rpm]" printed above a gauge is its UNIT, not its caption
        let m = /^\[(.+)\]$/.exec(s);
        // ...and INPA sometimes loses the OPENING bracket. BMS46's analog
        // page prints "degree KW]" for the ignition angle -- one unmatched
        // "]" where every other row has "[...]". Unmatched, it read as a
        // caption, so the row was titled "DEGREE KW]" and the real caption
        // ("ignition angle") was overwritten. Only a trailing "]" with no
        // "[" anywhere qualifies, so a genuine caption that happens to end
        // in a bracket ("Kennfeld [neu]") still reads as a caption.
        if (!m && /\]$/.test(s) && !s.includes('[')) {
          m = [s, s.slice(0, -1)];
        }
        // ...and sometimes INPA prints the unit with no brackets at all.
        // BMS46's load is captioned "load" then "mg/As/Zyl" then the value,
        // where every neighbouring row uses "[kgh]" / "[Volt]". Read as a
        // caption it overwrote "load", so the row drew as "MG/AS/ZYL".
        //
        // No text SHAPE can settle this -- the same slot legitimately holds
        // "Fahrerseite", "backrest", "AM/FM" -- so the test is corroboration
        // instead: the element it labels already carries a unit, mined
        // independently from INPA's gauge declaration, and the printed text
        // is exactly that unit. Corpus-wide this matches 36 times and every
        // one is a real unit (bar, Nm, 1/min, mg/As/Zyl).
        if (!m) {
          const nxt = els[ei + 1];
          const u = nxt && nxt.t !== 'text' && nxt.col === e.col
            && nxt.unit ? String(nxt.unit).trim() : null;
          if (u && u === s) m = [s, s];
        }
        if (m) { unitAhead = m[1].trim(); continue; }
        // INPA lays a labelled row out as three prints: the caption, a bare
        // ":" separator at a fixed column, then the value. The separator is
        // punctuation, not a label -- taking "nearest preceding text"
        // literally turned every coding row's caption into ":".
        // "/" joins two halves of ONE reading (date of manufacture prints as
        // week "/" year), so it is punctuation too and the caption before it
        // still belongs to both.
        if (/^[:=|/-]+$/.test(s)) continue;
        // ...and a caption may carry the separator itself ("Monitor pot. :"),
        // where the renderer adds its own and the row reads ": -12"
        if (s) pending = s.replace(/\s*[:=]\s*$/, '');
        continue;
      }
      if (!e.key) continue;
      // The element may carry its OWN caption: INPA hands some helpers the
      // label and the result name together ("Steuergerät:", "ECU"), which is
      // more specific than anything reading order or geometry can infer.
      let label = e.s || pending;
      if (!label && caps.length > 1 && valued.length === caps.length)
        label = caps[nth];
      // ...and when the line draws a whole GROUP per caption. INPA pairs a
      // _TEXT with a _WERT for one reading (the text is the state, the value
      // the number), so "Lambda Heizung UP1, Lambda Heizung UP2" names two
      // banks across four elements. Requiring an exact count left all eight
      // of MS450's mixture-adaptation rows falling back to their raw keys.
      if (!label && caps.length > 1 && valued.length > caps.length
          && valued.length % caps.length === 0) {
        // ...and the grouping may be by COLUMN rather than in sequence. MS450's
        // VANOS page prints "Einlass, Auslass" over two columns of two gauges
        // each -- actual above setpoint -- so chunking sequentially gave both
        // intake rows "Einlass" and both exhaust rows "Auslass" one row too
        // late. Where the values sit in as many distinct columns as there are
        // caption parts, the column decides.
        const cols = [...new Set(valued.map(v => v.col))].sort((a, b) => a - b);
        label = (cols.length === caps.length && typeof e.col === 'number')
          ? caps[cols.indexOf(e.col)]
          : caps[Math.floor(nth / (valued.length / caps.length))];
      }
      if (!label && capForAll) label = caps[0];
      // The geometric pairing. It fills a row the reading-order rules left
      // bare, and it also CORRECTS one they got wrong -- but only on a line
      // whose captions were all printed before its values, where reading
      // order is guaranteed to hand every value the last caption. DWA4 draws
      // "Clamp R / Clamp 15 / Clamp 61" then three lamps: without this the
      // first lamp reads "Clamp 61" and the other two read nothing.
      if (byPos && (!label || capsFirst)) label = byPos.get(e) || label;
      const row = {
        key: e.key,
        label: label || null,
        unit: e.unit || unitAhead || null,
        kind: e.t,
        line: lineNo,
      };
      // on a per-position screen the LINE caption ("Rad 1") is the position,
      // and the argument is what distinguishes otherwise identical keys. The
      // position is kept separately so the row's own caption can still be
      // resolved (or fall back to the SGBD description) before they are
      // joined -- prefixing here would freeze in a placeholder like "(1)".
      if (multiArg && ln.jobArg) {
        row.arg = ln.jobArg;
        const pos = (ln.caption || '').trim();
        if (pos) row.pos = pos;
      }
      // the ECU supplies this row's caption as a result of its own
      if (captionKey) { row.captionKey = captionKey; captionKey = null; }
      if (typeof e.min === 'number' && typeof e.max === 'number'
          && e.max > e.min) { row.min = e.min; row.max = e.max; }
      // the band INPA paints green, when analogout declared one
      if (typeof e.okMin === 'number' && typeof e.okMax === 'number'
          && e.okMax > e.okMin) { row.okMin = e.okMin; row.okMax = e.okMax; }
      if (e.on) row.on = e.on;
      if (e.off) row.off = e.off;
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

// A SCREEN INPA DRAWS AS A TABLE, or null.
//
// RDC's WE-Telegramm reads the same seven values once per wheel and prints
// them as a grid: a header line, then one row per index. The IR keeps that
// exactly -- every element carries its character row and column -- but the
// row builder flattens it, so five wheels x seven values arrived as 35
// unrelated readouts stacked vertically. 195 screens across 63 ECUs have this
// shape (wheels, cylinders, ignition circuits, banks).
//
// The test is that the DATA LINES all put their values in the same columns.
// That is what makes them a table rather than a list that happens to be long,
// and it is structural: no caption wording is consulted.
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
  // COLUMNS MUST BE DISTINCT POSITIONS. ACC's history screen prints four
  // captioned values one under another, all at column 40, and a signature
  // match alone called that a 16x4 table -- four copies of one column, every
  // cell the same key. A table has values side by side.
  if (new Set(cols).size !== cols.length) return null;

  // The header is a text-only line, and INPA prints each heading a column or
  // two LEFT of the values under it (Idx at 0 over (1) at 0, "press." at 14
  // over the value at 15). So a heading claims the nearest value column at or
  // after it rather than an exact match.
  const head = lines.find(l => !colsOf(l).length
    && (l.elements || []).some(e => e.t === 'text' && String(e.s || '').trim()));
  const headings = new Map();
  let rowHead = '';
  if (head) {
    for (const e of head.elements || []) {
      if (e.t !== 'text' || !String(e.s || '').trim()) continue;
      // A heading sitting LEFT of the first value column belongs to the row
      // label, not to a value: RDC's "Idx" heads the (1)..(5) column. Claiming
      // the nearest value column for it shifted every other heading one place
      // right and dropped the last one off the end.
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
  const { rows, cells } = irRows(scr);
  if (!rows.length) return [];
  // write-shaped jobs are represented in the IR but never auto-run
  const jobs = (scr.jobs || []).filter(j => !j.write);
  if (!jobs.length) return [];
  // a per-position screen becomes one poll per argument, each carrying only
  // the rows read in that pass -- otherwise all five wheels share one read
  // and show identical values
  if (rows.some(r => r.arg)) {
    // ...but when INPA draws those passes as a TABLE -- one row per wheel,
    // the same columns each time -- it stays ONE screen. Splitting it per
    // argument turned RDC's WE-Telegramm into five pages of seven stacked
    // readouts, where INPA shows a five-row grid. Every job still polls; the
    // table just says where each answer belongs.
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
  // Several jobs can fill ONE page, each feeding its own block of rows.
  // MS450's mixture adaptation reads seven -- STATUS_ADAPTION_GEMISCH for the
  // PWM/ADD/FAC pairs, then STATUS_INT, STATUS_L_SONDE and their bank-2
  // partners, one per LINE -- and INPA draws the result as a single screen.
  // Paging per job instead showed that screen seven times, every copy holding
  // every row. Distinguished by the line each job was read on: when the jobs
  // sit on different lines they are filling one page between them, not
  // offering alternative pages of the same rows.
  // Each still polls separately -- every job has to be sent -- but it carries
  // only the rows it answers, so the page is drawn once instead of once per
  // job. A job owns its own line plus any following line that declared no job
  // of its own (INPA leaves those to the read before them).
  const lined = jobs.filter(j => typeof j.line === 'number');
  if (lined.length === jobs.length
      && new Set(lined.map(j => j.line)).size > 1) {
    // Every row belongs to exactly one job: the first job declared on its own
    // line, or -- for a line that declares none -- the last job read before
    // it. Jobs sharing a line still poll; they just add no rows of their own.
    const owner = new Map();
    for (const j of jobs) if (!owner.has(j.line)) owner.set(j.line, j.name);
    const lineJob = new Map();
    let last = jobs[0].name;
    const maxLine = Math.max(...rows.map(r => r.line), ...jobs.map(j => j.line));
    for (let l = 0; l <= maxLine; l++) {
      if (owner.has(l)) last = owner.get(l);
      lineJob.set(l, last);
    }
    // TWO JOBS ON ONE LINE ARE TWO COLUMNS, NOT ALTERNATES. INPA writes a
    // two-column page as one line per ROW of the page, so a line carries a
    // reading from the left job and one from the right -- BMS46's analog page
    // puts battery voltage beside Speed, air mass beside load, coolant beside
    // cooling-water-leave. Giving the whole line to whichever job was
    // declared first handed that job BOTH rows and left the other with none;
    // the poller then dropped the orphaned row (it only keeps keys the job it
    // polled actually answered), so four of ten readouts silently vanished.
    //
    // A result name is the reliable link back: STATUS_GESCHWINDIGKEIT answers
    // STAT_GESCHWINDIGKEIT_WERT. Where that match is unambiguous it wins over
    // the line, and the line rule still covers every row it cannot resolve
    // (an alternates page, where the keys do not echo the job name).
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

// The IR carries its own translations, resolved once by tools/ipo_i18n.js
// from the shared vocabulary plus data/inpa-i18n/<ECU>.json. Looking them up
// here rather than translating at draw time means a caption BMW worded oddly
// for one ECU can be corrected for that ECU alone: "Gesteuerte LuftFuehrung
// GLF" is MS450's phrase, and a word rule general enough to translate it
// mangles others.
//
// The map is set per render by irUseTranslations, because irLabel is called
// from 24 places that have no ECU in scope. deGerman remains the fallback for
// an IR emitted before this step ran, and for strings that arrive at runtime
// from the SGBD rather than the .IPO.
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

// A RESULTCOMMENT is DOCUMENTATION, not a display name. BMW writes the
// description, then pads with two-plus spaces and appends the value legend
// and the storage slot:
//
//   "Ueberwachung Kraftstoffsystem  Test abgeschlossen oder nicht anwendbar
//    = 0  Test nicht abgeschlossen = 1 "        -> STATE_READY_OBD_1[5]
//
// Used whole, that becomes a 90-character column header ("FUEL SYSTEM
// MONITORING: TEST NOT SUPPORTED BY THIS MODULE = 0, SUPPORTED = 1") for a
// cell showing "46". INPA never does this -- its own screen says "misfire /
// MONITOR / READINESS" -- and the label only reaches the UI at all for rows
// INPA drew without a caption.
//
// The padding is the author's own separator between name and legend, so cut
// at the first run of two spaces. Median comment is 21 chars and p99 is 72;
// this only bites the 2.3% that carry a documentation tail.
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

// A _TEXT result can carry either the row's caption or a STATE word, and only
// the caption should replace the label. These are the states, in the German
// the ECU answers with and the English they resolve to.
// "Beschreibungstext" is the SGBD's own placeholder for these results, not a
// caption -- it is what put DESCRIPTIONSTEXT on MS450's rough-running rows.
const IR_STATE_WORD =
  /^(ein|aus|an|aktiv|inaktiv|nicht aktiv|bereit|ja|nein|on|off|active|not active|inactive|ready|yes|no|n\/?a|-+|beschreibungstext|descriptionstext)$/i;

// captions INPA recomputes each pass of a loop, so whichever one the decode
// captured belongs to no single row: a bare index "(1)", a wheel position
// heading, or its own placeholder "??"
const IR_LOOP_CAPTION = /^(\(\d+\)|\?+|Index \d+|Rad \d+|Position (FL|FR|RL|RR|VL|VR|HL|HR))$/i;

function irRowsTranslated(scr, descs) {
  return irScreens(scr).map(s => {
    // A LINE caption that lands on more than one row of a page does not
    // identify any of them. MS450's VANOS prints "Einlass, Auslass" over two
    // columns of two gauges, actual above setpoint, so both intake rows read
    // "Intake" and both exhaust rows "Exhaust"; the SGBD calls them Istwert
    // and Sollwert and says which is which. Where the caption repeats and the
    // description does not, the description identifies the row.
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
      // INPA's own caption first; for rows it draws without one -- loop
      // screens print a heading once at a computed position -- the SGBD's
      // result description, and only then the bare key.
      // A caption INPA itself computes per iteration ("Position RR", "(1)",
      // "??") is left over from the last pass of a loop and describes no
      // particular row, so the SGBD description wins over it.
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

// A menu's entries, in INPA's order, keeping ITEM numbers as the F-keys.
// Chrome INPA implements itself (print/select/exit) is dropped: the app has
// those natively, and Back is the Esc key.
const IR_CHROME = /^(Back|Exit|Print|Zur(ü|ue)ck|Ende|End|Select|Deselect|Auswahl|Abwahl|Druck|Drucken|Gesamt)$/i;

// "Read"/"FS lesen" in a fault menu: INPA runs this through its own library
// (INPAapiFsLesen_neu, which writes na_fs.tmp), so the decoded item names no
// job. Handed to the app's fault reader instead.
// A fault-memory read. INPA runs these through its own library
// (INPAapiFsLesen_neu), so the decoded item names no job -- the memory it
// reads is in the caption. BMW ships three: Fehlerspeicher (EM/FS),
// Infospeicher (IM/IS) and Historienspeicher (HM/HS), each with its own
// read, clear, print and save.
// Word order varies by build: "Read EM", "EM Read", "FS lesen", plain "Read".
// A menu item may also carry the screen's own softkey help, which spells the
// memory out ("Read error memory", "Fehlerspeicher loeschen").
const IR_MEM_WORD =
  '(EM|IM|HM|FS|IS|HS|(error|fault|info(rmation)?|history)\\s+memory'
  + '|(Fehler|Info|Historien)speicher)';
const IR_FAULT_READ = new RegExp(
  `^(Read|Lesen)$|^(Read|Lesen)\\s+${IR_MEM_WORD}\\b`
  + `|^${IR_MEM_WORD}\\s+(Read|lesen)\\b|^(Shadow|Schatten)`, 'i');

// which memory a fault-menu caption names -> the SGBD job that reads it
const IR_FAULT_JOB = [
  // "Shadow"/"Schattenspeicher" is the info memory under another name --
  // TOENS labels its F3 that way and answers IS_LESEN
  [/^(Shadow|Schatten)/i, 'IS_LESEN'],
  [/\b(IM|IS|Infospeicher|info(rmation)?\s+memory)\b/i, 'IS_LESEN'],
  [/\b(HM|HS|Historienspeicher|history\s+memory)\b/i, 'HS_LESEN'],
  [/\b(EM|FS|Fehlerspeicher|(error|fault)\s+memory)\b/i, 'FS_LESEN'],
];
const irFaultJob = (label) =>
  (IR_FAULT_JOB.find(([re]) => re.test(label)) || [null, 'FS_LESEN'])[1];

// Items INPA implements against the FILE SYSTEM rather than the car: saving
// the fault list to disk ("FS speichern", which RDC labels "store"). BMW's
// own BMW_STD.SRC defines these next to Print, and like Print they cannot be
// reproduced against an ECU.
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

// Is `menu` just the softkey bar `from` already shows, rather than a submenu?
// INPA keeps the bar and swaps the SCREEN: KOMBI's Ident, Code and Memory all
// install m_info_ident_code_36_38_39_46_52_85, which lists the same keys as
// the root -- opening it re-lists Info/Ident/Code one level deeper and never
// shows the screen the key actually selects. Compared by CONTENT: Activate's
// menu happens to have the same number of items but entirely different ones
// (km reset, SII oil, test), and is a real submenu.
// Compared by what the keys DO, not what they are called: an item takes the
// screen's softkey help when that says more, so the root may read
// "Information/Identification/Coding" where the bar it installs still reads
// "Info/Ident/Code". Same keys, different words -- comparing captions stopped
// recognising the bar and Coding opened a copy of the root one level down.
function irSameBar(ir, menu, from) {
  if (!menu || !from || menu === from) return true;
  // The SCREEN each key selects, not the menu it also installs: the bar and
  // the root select the same screens key for key (F1 -> s_info, F3 ->
  // s_code_...); they differ only in that the root's first keys re-install
  // the bar, which is how INPA stays on it.
  //
  // Keys parked on the family placeholder are ignored. INPA narrows the bar
  // while a page is up -- m_status_38_39 keeps five such keys where its
  // m_status_sub_38_39 drops them -- and counting those made two bars with
  // identical real keys look only 50% alike, so Analog and Digital each
  // re-listed the menu instead of opening the page.
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

// INPA's menu IS a screen, and most of them print live values above the
// softkey list: 444 of 542 ECUs show part number, VIN or date of manufacture
// there. Reads them once (not polled -- INPA doesn't either; they are identity
// facts, not gauges) and renders a compact strip above the keys.
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
// install both. The menu loses when it is merely the softkey bar this level
// already shows, and when it holds nothing runnable -- LWS5's Coding key
// installs m_code, whose single entry dumps the coding data to a .COD file on
// the PC, while the screen it also names holds the seven data blocks and the
// checksum. Shared by both open paths: renderIrMenu's own click handler and
// irOpenItem, which fixing one and not the other left disagreeing.
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
          // a key back to the ROOT is Back whatever it is called. MS450's
          // ident menu is Back/Print/End and nothing else, but deGerman had
          // rendered two of them "Folder" and "Printing", which no chrome
          // word list matches -- so the menu looked runnable and won over
          // s_ident, the screen holding the 23 identification fields.
          && !(it.menu === root && !it.job && menuName !== root)
          // INPA's own chrome ACTIONS, whatever they end up called: MS450's
          // ident menu is Back/Print/End but deGerman rendered them "Folder"/
          // "Printing"/"END", so no caption list would catch them. The action
          // is what the item does and does not translate.
          && !['printscreen', 'exit', 'select', 'deselect'].includes(it.action)
          && (it.job || it.screen || it.menu || it.action)
          && (it.job || it.screen || it.menu || it.action));
}

function irMenuItems(ir, menuName, variant) {
  const menu = (ir.menus || {})[menuName];
  if (!menu) return [];
  // an item can name several screens, one per chassis variant. Inside a menu
  // INPA already chose for this variant (m_status_38_39C_52 serves KOMBI39C),
  // that menu's own tags widen what counts as ours: its pages are the _38
  // screens, and pruning them by tag alone emptied the key.
  const via = irScreenTags(ir, menuName);
  // the screen this menu is drawn on, so a key that merely redraws it can be
  // told apart from one that opens a different page
  const menuScreen = (menu.screen)
    || (menuName === (ir.entry || {}).menu ? (ir.entry || {}).screen : null);
  const pick = (it) => irPickScreen(ir, it, variant || ir._variant, via);
  // ...and likewise several menus
  const pickMenu = (it) => {
    const m = irPickTagged(ir, [it.menu, ...(it.menuAlts || [])],
                           variant || ir._variant);
    return m === undefined ? (it.menu || null) : m;
  };
  const seen = new Set();
  return (menu.items || [])
    .filter(it => it.label && !IR_CHROME.test(it.label.trim()))
    // The key back to the root IS Back, whatever it is called: 1437 ECUs label
    // it "Back" and IR_CHROME catches those, but a handful say "Main menu" or
    // "to the main menu" and were listed as a function. Detected structurally
    // -- from a submenu, a key whose target is the root menu -- so no wording
    // needs to be enumerated. The app has Esc for this.
    .filter(it => !(menuName !== (ir.entry || {}).menu
                    && it.menu === (ir.entry || {}).menu && !it.job))
    // drives INPA rather than the car: loads another script, opens the KVP
    // editor. Flagged by the emitter from what the item does, not its name.
    .filter(it => !it.appTool)
    // writes the fault list to a file, like Print -- an INPA function, not an
    // ECU one, and it names no job because there is nothing to send.
    // fileAction is the same thing read from the bytecode rather than the
    // caption: the item only shows or truncates a file on the diagnostic PC
    // (LWS5's "Read protocol file" / "Delete Protocol file" on na_fs_pr.tmp),
    // which no wording pattern would have caught.
    // ...but a FAULT read is INPA's own library doing exactly this: it writes
    // na_fs.tmp and displays it, so it looks like pure file I/O while being
    // the realest function on the menu. The app's fault view handles those.
    .filter(it => !(it.fileAction && !IR_FAULT_READ.test(it.label.trim())))
    .filter(it => !(IR_FILE_ACTION.test(it.label.trim()) && !it.job
                    && !it.screen && !it.menu))
    // a key whose only effect is to redraw the menu's own screen does
    // nothing here -- INPA needs it because the screen IS the window
    .filter(it => !(it.screen === (ir.entry || {}).screen && !it.menu))
    // ...and neither does one that re-installs THIS menu and the screen it is
    // already drawn on. That is how INPA returns from an action it performed
    // on the PC: MS450's fault menu ends with "save all faults to a file" and
    // "insert comment", which name no job, go nowhere, and were listed beside
    // the five real fault reads as though they were ECU functions.
    .filter(it => !(it.menu === menuName && !it.job && !it.action
                    && (!it.screen || it.screen === menuScreen
                        // INPA names the menu's screen after the menu itself
                        // (m_fehlersp -> s_fehlersp); a key pointing at both
                        // is redrawing where it already is
                        || it.screen === 's' + menuName.slice(1))))
    // an item with no navigation target is an ACTION INPA performs in place:
    // its actuator items only flip state flags and let the screen send the
    // job. Those are listed (the caption is INPA's own, joined from the
    // screen's softkey help by F-number) but never runnable here -- firing an
    // actuator is gated on car verification, and the arming semantics are
    // not decoded.
    // ...but an item that also names a JOB is a real function: CDC's "Trpmode
    // ON"/"OFF" carry action "start" beside ENERGIESPARMODE, and dropping them
    // hid the only two activations that ECU has.
    .filter(it => it.screen || it.menu || it.job || !it.action)
    // a write entry that opens the same SCREEN as a read entry (RDC's
    // "MV write" reuses s_abgleichwert_lesen): INPA's difference is an input
    // dialog and a write job in the ITEM body, neither of which we run until
    // verified on a car, so what remains is a duplicate of the read page
    // ...but only when the write cannot RUN. RDC's "MV write" needs a typed
    // value we do not collect, so with the input dialog gone it is nothing but
    // the read page again. MS450's "reset status" sends RESET_CRU_OFF on the
    // keypress exactly as INPA does and merely redraws the same screen after
    // -- dropping that hid a function the ECU really offers. The difference is
    // the prompt, not the caption.
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
      // the job this item calls itself, if any (Clear -> FS_LOESCHEN,
      // Sleep -> SLEEP_MODE). Dropping it here made every such key inert:
      // open() tests it.job, so without this Clear could never run.
      job: it.job || null,
      // changes the ECU permanently (EEPROM write, service reset) rather
      // than driving an actuator for the duration of a test
      writeJob: !!it.writeJob,
      // pressed as Shift+Fn on a real INPA keyboard (ITEM n+10)
      shift: !!it.shift,
      // the argument this key sends, which may be all that distinguishes it
      // from its neighbour (RADIO's sources, CDC's transport mode)
      jobArg: it.jobArg || null,
      // the index this key selects before opening its screen, when several
      // keys share one screen and differ only by record (MS450's 15 AIF keys)
      sel: Array.isArray(it._sel) ? it._sel[1] : null,
      // the job came from a state machine, whose argument assembly is not
      // decoded -- listed, never sent
      stateJob: !!it.stateJob,
      // INPA asks the user for a value and builds the job argument from it
      // (KLIMA_5B's flap positions: "Fresh air flap", "Position (0-100 %)")
      prompt: it.prompt || null,
      // A menu named for other chassis is dropped ONLY when the item also
      // names a screen that does serve this one: KOMBI's Status key installs
      // m_status_38_39, whose pages are all _38 screens, and its own screen
      // is the right one. Where the menu is all there is -- Activate's
      // m_steuern_36C_38_39_39C_52, the only actuator menu this root has --
      // dropping it would leave the key dead.
      menu: (() => {
        // INPA ships one Status/Activate menu PER VARIANT and lists the rest
        // as alternatives (m_status_38_39 + m_status_46, m_status_85, ...).
        // Taking it.menu blind gave KOMBI46 the _38 pages and hid its own
        // TÖNS I/O and CAN keys.
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
    // every screen this key names belongs to another variant, and it opens no
    // menu: INPA does not offer this key on this ECU, so neither do we
    .filter(it => it.screen || it.menu || it.job || it.inPlace)
    // ...and a key whose menu turns out to hold nothing we can run is the same
    // thing one level down. LWS5's only Coding key dumps the coding data to a
    // .COD file on the PC -- INPA ships no coding readout for that ECU -- so
    // the key led to an empty list. INPA's menus reference each other freely
    // (every bar links Back to its parent), so the check is depth-limited
    // rather than recursive: look at the target's own items only.
    .filter(it => !it.menu || it.screen || it.menu === menuName
                  || _irHasRunnable(ir, it.menu));
}

// Actuator keys always run -- INPA sends on the keypress. The setting only
// decides whether we ask first; defaulting to asking, since unlike INPA this
// app can be pointed at a car by someone who did not choose the test.
const confirmActuators = () => Settings.get('confirmActuators', 'on') !== 'off';

// Live actuator state per menu, mirroring INPA's own: the menu holds the
// argument word between presses, each key toggles its own pair, and the whole
// word is sent every time. Starting from composite.baseline -- the value
// INPA's startup initialises the fields to -- means our first send is
// byte-identical to INPA's.
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

// Send one actuator key: set its REQ/VAL pair in the shared word, post the
// job, show what went out and what came back. No confirmation and no
// sub-screen -- INPA sends on the keypress, so this does too.
async function runComposite(ecu, ir, menuName, it, container, reopen, keysFor) {
  const comp = (ir.menus[menuName] || {}).composite;
  const pair = comp && comp.items && comp.items[String(it.nr)];
  const word = comp && compWord(ir, menuName);
  if (!comp || !word) return;

  let on = null;
  if (pair) {
    // toggle this key's request flag; the value field follows it, except
    // where INPA only ever sends 0 for that field (RDC's CAL_VAL: F3
    // requests calibration and leaves the value unused)
    const [reqI, valI] = pair;
    on = word[reqI] === '1' ? '0' : '1';
    word[reqI] = on;
    const valOnly = (comp.values || [])[valI];
    word[valI] = (valOnly && valOnly.length === 1)
      ? String(valOnly[0]) : on;
  }
  // no pair: this key is the COMMIT -- it sends the word as it stands
  // (RDC F8 "write data into ECU"), which is why it owns no field
  const arg = word.join(';');

  // INPA stays on its menu -- the keys keep their state and you toggle the
  // next one -- so the result goes to the status bar and the row's own
  // marker, never to a separate page.
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
  // redraw the menu so every row shows its current on/off state
  reopen();
}

// A screen with no gauges and no lamps is a labelled READ -- coding data,
// identification, references. INPA draws those as a colon-aligned list, not
// as bars, and they do not change while the car sits there, so they get the
// ID-data card (identity.js) rather than the polling gauge grid: same
// presentation as the Info tab, in both UI modes, read once with F1 to
// re-read.
function irIsCard(scr) {
  if (irIsMemory(scr)) return false;
  const rows = irRows(scr).rows;
  // A CODING page is a list of labelled answers, some of them yes/no flags:
  // DWA4 reads four values ("alarm variant") beside four digitalout flags
  // ("with tilt alarm sensor"), and INPA prints all eight as "label : value".
  // The card renders exactly that and translates ja/nein, so a screen that is
  // ALL labelled readings qualifies whether or not some are flags.
  //
  // A lamp only counts when INPA gave it no on/off caption AND the screen is
  // not predominantly lamps: BC_V's 18 clamp indicators and BZMF_E65's button
  // panels are digitalout too, and their at-a-glance state is the point of
  // them -- turning those into a text list would lose it.
  const lamps = rows.filter(r => r.kind === 'lamp');
  const captioned = lamps.some(r => r.on || r.off);
  // A screen whose lamps outnumber its NON-IDENT values is an indicator
  // panel, not a list of answers. SBSR reads eight live occupancy flags and
  // then nine identification fields (part number, supplier, date) -- the ident
  // block says nothing about the flags, and their glyphs are the point. DWA4's
  // coding page is the other way round: four flags beside four values that
  // answer the same kind of question ("alarm variant", "lock signals").
  const identish = (r) => /^ID_|_NR$|^SN_/.test(r.key || '');
  const answers = rows.filter(r => r.kind !== 'lamp' && !identish(r)).length;
  const mostlyLamps = lamps.length > answers;
  const textish = (r) => r.kind === 'value'
    || (r.kind === 'lamp' && !captioned && !mostlyLamps);
  if (!rows.length || !rows.every(textish)) return false;
  // A per-position screen reads the same keys once per wheel/bank, so a single
  // card keyed by result name would show the last pass five times. Those go to
  // the poller, which reads each argument separately.
  //
  // Distinct captions make it a card again: LWS5's coding page calls
  // CODIERUNG_LESEN once per block and labels each "Data Block 0..6", which is
  // a list of labelled reads like any ident page -- the argument distinguishes
  // the passes, and the caption already says which is which.
  // ...and it must actually be LABELLED. CAS's DME ringbuffer has three rows
  // and no captions at all, so a card would list bare result names.
  if (lamps.length && !rows.every(r => (r.label || '').trim())) return false;
  const args = rows.filter(r => r.arg != null);
  if (!args.length) return true;
  const caps = new Set(args.map(r => (r.label || '').trim()).filter(Boolean));
  return caps.size === args.length;
}

// INPA's memory dump: SPEICHER_LESEN with a start address and a byte count,
// printed as a hex dump rather than named results. Decoding it as rows gives
// one useless JOB_STATUS field, so it routes to showMemory instead.
function irIsMemory(scr) {
  return (scr.jobs || []).some(j => /^SPEICHER_LESEN/i.test(j.name))
    && irCaptions(scr).some(c => /address|adresse/i.test(c));
}

// Only where INPA itself names regions (tools/ipo_memory.py -- GSDS2: RAM,
// ROM). An ECU like IHKA prints just "Start address" and "Number": no
// regions, no bounds.
function irMemoryScreen(scr, mined) {
  return (mined && (mined.regions || []).length) ? mined : null;
}

// INPA's plain memory screen, reproduced as it draws it: three labelled rows,
// the first two prompting for a value and the third showing what came back.
// The captions and their order are the screen's own; nothing is invented,
// and no address range is implied because the ECU declares none.
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

// INPA's "Information" screen describes the SCRIPT, not the car: rework
// program, version, responsibility, then the SGBD's own file header. It reads
// no ECU results at all -- the captions are printed and the values come from
// script variables -- so it has no keys and would otherwise render blank.
// The SGBD answers the same facts through its INFO pseudo-job (offline, no
// cable), so the captions are paired with it positionally.
const IR_INFO_KEYS = ['TITLE', 'VERSION', 'ORIGIN', 'PACKAGE', 'ECU',
                      'REVISION', 'AUTHOR', 'SPRACHE', 'COMMENT'];

// Deliberately narrow. "No result rows plus some captions" also describes a
// screen whose values this decoder failed to extract -- ACC's s_id_aktuell
// prints BMW part number and serial number that way -- and pairing those with
// the INFO job would invent data. The information screen is identified by the
// name INPA gives it (`s_info`, the script-info page in BMW's own template,
// on 452 ECUs' Info key) plus the absence of softkey help, which is what
// distinguishes it from a screen that merely hosts a menu.
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

// Info as a card: INPA's captions, paired in order with the SGBD's INFO
// results. Extra captions with no counterpart are kept and left blank rather
// than dropped -- INPA prints them.
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
      // INPA reads this row in its own pass ("Data Block 3" is
      // CODIERUNG_LESEN "3"), so the card must read it separately
      ...(r.arg != null
        ? { arg: r.arg, job: (scr.jobs || []).find(j => !j.write)?.name }
        : {}),
    })),
  };
}

// Which of an item's variant screens to use. INPA names them for the chassis
// they serve (s_code_46, s_status_36) and picks by the ECU's own VARIANTE, so
// the digits in the name are matched against the digits in the variant --
// KOMBI46 -> s_code_46, which has 37 rows where the default first target has
// 13. A screen with no rows never wins: s_status_36_38_39_46_52_85 lists the
// chassis but holds nothing, and taking it left Status empty.
// Which variants a name is tagged for. INPA suffixes a screen with the chassis
// numbers it serves (s_status_36, s_status_digital_36c,
// m_main_36_38_39_46_52_85); the variant names themselves are in rootVariants,
// so a tag matches a variant when the variant's name ENDS with it. That handles
// KOMBI361 matching "361" over "36", and leaves IKE/IKI -- which carry no
// number -- untagged rather than falsely matching every numbered screen.
// Does this name end in one or more variant suffixes (_36, _38_39, _36c)?
const irHasVariantSuffix = (n) => /_\d+[a-zA-Z]?(_\d+[a-zA-Z]?)*$/.test(String(n));

// Is this variant one the screen suffixes can address at all? KOMBI31..KOMBI85
// carry their number in the name; IKE and IKI do not, and INPA reaches them by
// name -- so no numeric suffix can ever select for or against them.
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
    // A variant matches a tag when its name ends with the tag, or continues
    // with digits (so "36" covers KOMBI36 and KOMBI361, which share
    // s_status_36 and both answer STATUS_LESEN). It must NOT swallow a
    // lettered sibling: "36" is not KOMBI36C, whose screens are _36c and
    // whose jobs differ. A more specific name still wins -- irPickTagged
    // prefers the shortest tag list.
    // A lettered tag (39C, 46R, 36c) names ONE variant and must match it
    // exactly. A bare number matches the variants whose name continues with
    // digits or a body letter -- "36" covers KOMBI36 and KOMBI361, "46" covers
    // KOMBI46 and KOMBI46R, which share m_steuern_46 because INPA ships no
    // _46r actuator menu. That deliberately makes "39" match KOMBI39C too;
    // where a _39C name also exists it is the more specific tag and
    // irPickTagged prefers it, so the loose match only applies as a fallback.
    const re = /[a-zA-Z]$/.test(T) ? new RegExp(`${T}$`)
                                   : new RegExp(`${T}\\d*[a-zA-Z]?$`);
    for (const v of names) if (re.test(v) && !tags.includes(v)) tags.push(v);
  }
  per.set(name, tags);
  return tags;
}

// Choose the name in `pool` that serves `variant`. Returns undefined when the
// tags say nothing (caller keeps its own default) and null when every
// candidate is tagged for OTHER variants -- INPA has no such key here.
function irPickTagged(ir, pool, variant, via) {
  pool = (pool || []).filter(Boolean);
  if (!pool.length || !variant) return undefined;
  const V = String(variant).toUpperCase();
  // reached through a menu INPA chose for this variant: that menu's pages are
  // ours whatever they are suffixed with
  const ok = (n) => {
    const t = irScreenTags(ir, n);
    return t.includes(V) || (via || []).some(v => t.includes(v));
  };
  // A name carrying a variant suffix is variant-specific even when the suffix
  // names no variant in this root (KOMBI has _36c screens but no KOMBI36C):
  // it belongs to a sibling, so it must not pass as family-wide.
  const tagged = pool.filter(n => irHasVariantSuffix(n));
  // A variant whose name matches NO suffix anywhere in this pool is one INPA
  // identifies by name rather than by number -- IKE and IKI are the E38/E39
  // clusters, so KOMBI's _38 screens are theirs. Numeric tags cannot speak
  // for it, so the tagged names stay eligible instead of pruning the key away.
  if (!pool.some(ok) && !irVariantIsNumbered(ir, V)) return undefined;
  // A name tagged for this variant outright beats one merely reachable
  // through the menu; among equals, the fewest variants sharing it wins.
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
  // Every candidate is empty. INPA parks a key it has no page for on the
  // family placeholder -- s_status_36_38_39_46_52_85 merely lists the variant
  // names -- so a shared menu offers TOENS and CAN to variants without them.
  // Drop only that: a screen INPA draws from its own text (s_info) is empty of
  // ECU results by nature and stays, as does any key that opens a menu.
  if (!withRows.length && all.length
      && all.every(n => irHasVariantSuffix(n))
      && !irIsInfo((ir.screens || {})[all[0]] || {}, all[0])) return null;
  return all[0] || it.screen;
}

// Open ONE root item directly, for a section that maps to a single INPA key
// (Special -> Memory). Renders the menu it opens, or the screen itself when
// the key opens a screen. Returns false when there is nothing to show, so the
// caller can fall back.
function irOpenItem(ecu, ir, menuName, it, container, back) {
  irUseTranslations(ir);
  // A key can install a menu AND a screen. Often the menu is just the bar it
  // keeps: KOMBI's Ident, Code and Memory all install
  // m_info_ident_code_36_38_39_46_52_85, which IS the root menu -- opening it
  // re-lists Info/Ident/Code/... one level deeper while the screen the key
  // actually selects never renders. The screen wins whenever the menu is not
  // a narrower list than the one we came from.
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

// Walk the IR from a menu: list its entries, open a screen, descend into a
// submenu, Esc back up one level -- INPA's own navigation, and ours.
function renderIrMenu(ecu, ir, menuName, container, back, trail = []) {
  irUseTranslations(ir);
  const items = irMenuItems(ir, menuName);
  if (!items.length) return false;

  const open = async (it) => {
    // Fault memory is read through INPA's own library helper, not a job the
    // screen names: F1 calls INPAapiFsLesen_neu and writes na_fs.tmp, so the
    // decode has a caption and nothing to run. The app's fault view already
    // does this properly -- FS_LESEN plus code lookup and freeze frames --
    // so the menu is INPA's but this one entry hands off to it.
    // A fault read may still name a job: LWS5's "Read" calls ABGLEICH_LESEN
    // first (its adjustment VIN) and then reads the memory through INPA's own
    // library. Running only the named job showed adjustment data under a
    // "Read error memory" caption, so route on what the key IS -- unless the
    // job it names is itself the fault read.
    // A fault read may also name a SCREEN rather than running in place --
    // MS450's fault menu is five such keys -- but that screen has no rows:
    // INPA formats the fault list in code, so there is nothing to poll and it
    // rendered as an empty page. The app's own fault view is what this is for.
    // A key whose SCREEN carries the job, with no rows to show for it: INPA
    // runs it and prints its own confirmation. MS450's "Clear error memory"
    // is FS_LOESCHEN on s_fs_loesch, so the key opened a blank page and did
    // nothing. Hand it to the same confirm-and-run path as any other write.
    const jobScreen = it.screen && (ir.screens || {})[it.screen];
    if (!it.job && jobScreen && !irReadable(jobScreen)
        && (jobScreen.jobs || []).length === 1
        && !IR_FAULT_READ.test(it.label)) {
      const only = jobScreen.jobs[0];
      // Memory clears are the one write surfaced this way. Anything else --
      // CODIERDATEN_SCHREIBEN, C_FG_SCHREIBEN, a control-unit reset -- takes
      // an argument the SCREEN builds from a menu selection (argFromMenu),
      // and sending it bare would write whatever the ECU makes of nothing.
      // Those stay as they were: listed, and not armed by this shortcut.
      const clears = /^(FS|IS|HS)_LOESCHEN$/i.test(only.name);
      if (!only.write || clears) {
        it = { ...it, job: only.name, writeJob: !!only.write, inPlace: true };
      }
    }
    const faultScreen = it.screen && (ir.screens || {})[it.screen];
    const faultKey = IR_FAULT_READ.test(it.label)
      && (it.inPlace
          || (faultScreen && !irReadable(faultScreen)
              && (faultScreen.jobs || []).some(j => /^FS_/i.test(j.name))));
    if (faultKey
        && !/^(FS|IS|HS)_LESEN$/i.test(it.job || '')
        && typeof runJob === 'function') {
      // the caption says WHICH memory: "Read IM" -> IS_LESEN. 239 ECUs keep
      // an info memory and 20 a history memory that a hardcoded FS_LESEN
      // would never have read.
      runJob(ecu, irFaultJob(it.label), container, false);
      sbLeft.textContent = `${ecu.sgbd}.prg · ${it.label}`;
      setActions([...keys(), {
        key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
        fn: () => renderIrMenu(ecu, ir, menuName, container, back, trail),
      }], shiftKeys());
      return;
    }
    // A key that installs a MENU opens that menu, whatever else it does.
    // INPA's root keys set the screen AND the softkey menu together (Status
    // -> s_status + m_rdc_status), and s_status is only the window the menu
    // is drawn in -- it has no rows of its own. Checking the screen first
    // sent Status and Activate to the "no readout" message instead of their
    // submenus.
    // a menu no narrower than this one is the same softkey bar being kept,
    // not a submenu: opening it just re-lists these keys a level deeper
    if (irOpensMenu(ir, it, menuName)) {
      renderIrMenu(ecu, ir, it.menu, container,
                   () => renderIrMenu(ecu, ir, menuName, container, back, trail),
                   [...trail, it.label]);
      return;
    }
    // an item with its own job (RDC F18 Sleep -> SLEEP_MODE) is an ordinary
    // one-key-one-job action, unrelated to any composite word
    if (it.inPlace && it.job
        && !((ir.menus[menuName] || {}).composite || {}).items?.[String(it.nr)]) {
      const reopen = () =>
        renderIrMenu(ecu, ir, menuName, container, back, trail);
      // a persistent write always asks, whatever the setting says: the
      // confirm toggle exists to match INPA on actuator TESTS, which stop
      // when you leave the screen. An EEPROM write or a service reset does
      // not undo itself.
      const permanent = it.writeJob;
      // A write whose job came from a STATE machine is never sent. INPA's
      // sequence gathers what to write first -- the .COD file its previous key
      // picked, the ident fields its Change keys edited -- and that assembly
      // is not decoded, so firing the job alone would write whatever the ECU
      // makes of an empty argument. These are EEPROM writes behind INPA's own
      // "Only for the developer" title; listed, never run.
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
      // INPA asks for a value first and builds the argument from it. We know
      // the prompts but not how the script assembles them into the argument
      // -- it concatenates several variables -- so sending the job without
      // that would command a position nobody chose.
      if (it.prompt) {
        container.className = 'results-panel';
        container.innerHTML = `<div class="empty"><div>`
          + `<strong>${esc(it.label)}</strong></div>`
          + `<div>INPA prompts for ${esc(it.prompt.join(' — '))} and builds `
          + `<code>${esc(it.job)}</code>'s argument from the answer. How it `
          + `assembles that argument is not decoded, so this is listed but `
          + `not sent.</div></div>`;
        sbLeft.textContent = `${ecu.sgbd}.prg · ${it.label} · needs input`;
        setActions([...keys(), {
          key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
          fn: reopen,
        }], shiftKeys());
        return;
      }
      sbLeft.textContent = `${ecu.sgbd}.prg · ${it.job} · sending`;
      try {
        // the ARGUMENT is often the only thing separating two keys: RADIO's
        // entertainment sources all call STEUERN_NEXT_ENTSOURCE and differ
        // only in "FM"/"CDC"/"AM", and CDC's transport mode in "0;1;0" vs
        // "0;0;0". Sending the job bare would fire the wrong command.
        const q = it.jobArg ? `?arg=${encodeURIComponent(it.jobArg)}` : '';
        const out = await api(`/api/ecu/${ecu.sgbd}/run/${it.job}${q}`,
                              { method: 'POST' });
        const r = flatResults(out.sets).map(([k, v]) => `${k}=${v}`)
          .slice(0, 3).join(' ') || 'sent';
        sbLeft.textContent = `${ecu.sgbd}.prg · ${it.label} · ${it.job} · ${r}`;
      } catch (e) {
        sbLeft.textContent = `${ecu.sgbd}.prg · ${it.label} · failed: ${e.message}`;
      }
      reopen();
      return;
    }
    if (it.inPlace && (ir.menus[menuName] || {}).composite) {
      // INPA sends on the keypress -- no sub-screen -- so this does the same.
      // The argument is INPA's own neutral word with this key's REQ/VAL pair
      // set; every other field keeps the value it already has, exactly as
      // INPA's menu state works.
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
    if (it.inPlace) {
      // A KEY INPA RUNS ON THE PC, NOT ON THE CAR. NAVI's "languages load"
      // reads a language table off a Windows filesystem and holds it for the
      // next key to send, so it decompiles to a label and nothing else --
      // there is genuinely no job in the .IPO, verified by hand against the
      // bytecode. The file is not the interesting part though: the job it
      // feeds takes three plain language codes, so a picker does what the
      // file did. navlang.js draws that.
      if (/sprach|language/i.test(it.label) && /lad|load/i.test(it.label)
          && typeof showNavLanguages === 'function') {
        const reopen = () =>
          renderIrMenu(ecu, ir, menuName, container, back, trail);
        showNavLanguages(ecu, container, reopen);
        return;
      }
      // INPA runs this from the menu: each key sets its own REQ/VAL pair in
      // ONE argument string, and a single job re-commands every actuator on
      // the ECU at once. The pairing is decoded (comp.items) -- what is not
      // established is the neutral word: whether all-REQ-zero is a true
      // no-op. Until that is confirmed on a car, pressing one key would be
      // asserting a value for six actuators nobody chose.
      // reached only when this menu has NO decoded composite: INPA runs the
      // key in place but we cannot tell what it sends, so there is nothing
      // to fire and saying so beats guessing.
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
    // A screen several keys share, parameterised by the index the key set:
    // MS450's fifteen AIF keys all open s_aif and differ only in which record
    // AIF_LESEN reads, so without passing it every key showed the same page.
    if (scr && it.sel != null
        && (scr.jobs || []).some(j => j.argFromMenu)) {
      screens = screens.map(x => ({ ...x, args: String(it.sel) }));
    }
    if (screens.length) {
      showInpaCategory(ecu, screens, container, irLabel(scr.title) || it.label);
    } else {
      container.className = 'results-panel';
      container.innerHTML = `<div class="empty"><div>`
        + (scr && !irReadable(scr)
          ? `In INPA this entry performs an action, not a readout — it is not `
            + `offered here until verified on a car.`
          : `INPA lists this entry, but it has no readouts.`)
        + `</div></div>`;
    }
    sbLeft.textContent = `${ecu.sgbd}.prg · ${[...trail, it.label].join(' · ')}`;
    setActions([...keys(), {
      key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
      fn: () => renderIrMenu(ecu, ir, menuName, container, back, trail),
    }], shiftKeys());
  };

  // INPA's softkey bar has two rows: F1..F10 and their shifted partners,
  // which the bytecode numbers ITEM n+10. SM46's F3 is "inclination +" and
  // Shift+F3 is "inclination -" -- the same seat motor, the other way. Saying
  // "F13" would name a key the car's INPA does not have.
  const fkey = (it) => (it.shift ? `\u21e7F${it.nr - 10}` : `F${it.nr}`);

  // INPA binds a key to its F-NUMBER, and the shifted row reuses the same
  // numbers: F3 and Shift+F3 are both the "3" key. Binding by list position
  // would put ⇧F3 on whatever slot it happened to occupy.
  const asAction = (it) => {
    const n = it.shift ? it.nr - 10 : it.nr;
    return {
      // F10 is the "0" key; F20 is INPA's Exit, which the app reaches with
      // Esc, so it takes no digit rather than stealing 0 from Back.
      key: n === 20 ? null : String(n % 10),
      // INPA's bar carries the ITEM's own short caption ("E 15%"), not the
      // long one it prints in the body -- nine truncated long captions all
      // read "Activat...". irLabel translates it like any other.
      keyLabel: fkey(it), label: irLabel(it.short) || it.label,
      fn: () => open(it),
    };
  };
  const plain = items.filter(it => !it.shift);
  const shifted = items.filter(it => it.shift);
  const keys = () => plain.slice(0, FKEY_SLOTS).map(asAction);
  const shiftKeys = () => shifted.slice(0, FKEY_SLOTS).map(asAction);

  const count = (it) => {
    // reflects the setting, not a property of the item: with actuator tests
    // enabled these DO run, so a fixed "not runnable" would be a lie. Once
    // running, the row shows its own armed state the way INPA's menu does.
    if (it.inPlace) {
      const comp = (ir.menus[menuName] || {}).composite;
      const pair = comp && comp.items && comp.items[String(it.nr)];
      const word = pair && compWord(ir, menuName);
      // the row shows its own armed state, the way INPA's menu does
      if (word) return word[pair[0]] === '1' ? 'ON' : 'off';
      // sends the assembled word without owning a field (RDC F8 "write data
      // into ECU"), or calls its own job (F18 Sleep -> SLEEP_MODE)
      if (comp && (comp.send || []).includes(String(it.nr))) return 'send';
      if (it.job) return 'run';
      // a fault-memory read names no job -- INPA reads through its own
      // library -- but open() hands it to the app's fault view, so it does
      // work and must not be labelled undecoded
      if (IR_FAULT_READ.test(it.label)) return 'read';
      // the PC-side language picker, which does work (see open())
      if (/sprach|language/i.test(it.label) && /lad|load/i.test(it.label)) {
        return 'choose';
      }
      return 'not decoded';
    }
    if (!it.menu && !it.screen) return '';
    const scr = (ir.screens || {})[it.screen];
    // a real submenu counts its entries; a key that merely keeps this bar
    // counts the rows of the screen it selects, which is what opening it shows
    // No count for a screen or submenu. It would be a prediction made before
    // the job runs -- rows the ECU never answers still counted, one page
    // counted once per job -- and it was wrong often enough to be worth less
    // than the space. Opening it shows the truth.
    return '';
  };

  if (inpaMode()) {
    container.className = 'results-panel';
    container.innerHTML = `<div class="ir-menu-head" id="ir-head"></div>`
      + `<div class="act-key-list" id="ir-list"></div>`;
    // INPA's menu screen is a screen: 444 of 542 ECUs print live values on it
    // -- part number, VIN, date of manufacture -- above the softkey list. The
    // menu is drawn from the same screen the keys are drawn on, so read it.
    irMenuHeader(ecu, ir, menuName, container.querySelector('#ir-head'));
    const list = container.querySelector('#ir-list');
    // Only the BAR swaps. INPA prints the shifted keys permanently in a
    // second column on the right of the screen body -- MS45's root shows
    // "< Shift > + < F6 >  EWS - Startwertabgleich" beside the plain list at
    // all times -- and swaps only the F-key row along the bottom. So the body
    // lists both halves and never repaints.
    const rowsOf = (shownItems, into) => shownItems.forEach((it) => {
      const row = document.createElement('button');
      row.className = 'inpa-fn act-key-row';
      // spelled out as INPA prints it in the body; the narrow footer button
      // keeps the compact glyph form
      row.innerHTML = `<span class="inpa-fn-key">`
        + (it.shift ? `&lt; Shift &gt; + &lt; F${it.nr - 10} &gt;`
          : `&lt; F${it.nr} &gt;`) + `</span>`
        + `<span class="inpa-fn-label">${esc(it.label)}</span>`
        + `<span class="act-key-val">${esc(count(it))}</span>`
        // the arrow marks a key that GOES somewhere -- a submenu or a screen.
        // A key that acts in place (runs a job, fires an actuator) does not
        // navigate, so it keeps none.
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
    items.forEach((it) => {
      const tile = document.createElement('div');
      tile.className = 'group-tile';
      tile.innerHTML = `
        <div class="group-name">${esc(it.label)}</div>
        <div class="group-count">${esc(count(it))}</div>
        <div class="group-arrow">→</div>`;
      tile.onclick = () => open(it);
      container.appendChild(tile);
    });
    stagger(container, 30);
  }

  setActions([...keys(), {
    key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: back,
  }], shiftKeys());

  // Anything the app adds to an ECU's ROOT menu has to be re-added here, not
  // just once when the screen opens: this function redraws the root from
  // inside itself whenever a submenu returns, and a row appended afterwards
  // is wiped by that redraw. The app's Coding entry went missing exactly that
  // way -- open INPA's own Coding key, press Back, and it was gone.
  if (menuName === irRootMenu(ir, ecu._variant) && typeof irRootExtras === 'function') {
    irRootExtras(ecu, container);
  }
  return true;
}

// Set by showEcu: what to append to the root menu after every draw of it.
// A function of (ecu, container), or null when there is nothing to add.
let irRootExtras = null;
function setIrRootExtras(fn) { irRootExtras = fn; }

// The ECU's own root menu, rendered as INPA draws it.
//
// There is deliberately NO table mapping INPA's labels to app sections. That
// approach needs a regex per label per language, silently drops every key
// nobody anticipated, and made "Information" and "Read status" collide when
// two keys happened to map to one section. The IR already holds INPA's root
// menu with its real F-key numbers and targets, so the general answer is to
// render that and let each key open whatever it opens -- exactly what
// renderIrMenu already does for every nested menu.
//
// The only judgement left is presentation, and that is decided by the decoded
// screen (irIsCard: all-value rows are a labelled read, anything with a gauge
// or lamp is a live panel), not by what the key is called.
function irRootMenu(ir, variant) {
  // several roots, one per ECU variant: INPA runs the variant job and matches
  // its result against each root's name list. With no answer yet, prefer the
  // root that serves the most variants rather than the first declared --
  // KOMBI's first is the E31/E32/E34 menu, which has no Status or Memory.
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
