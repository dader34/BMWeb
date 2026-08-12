// live values: runJob, gauges, units, multi-watch, screens
const JOB_ARGS = {
  MESSWERTBLOCK_LESEN:   { prompt: 'Measurement IDs, comma-separated (e.g. 0x4300,0x4301)', placeholder: '0x4300,0x4301' },
  SPEICHER_LESEN_ASCII:  { prompt: 'Memory area (e.g. LAR;0x...)', placeholder: 'LAR;0x0000' },
  C_FG_LESEN:            { fixed: ';0' },
  AIF_LESEN:             { fixed: '0' },
  IDENT_AIF:             { fixed: '0' },
  DIAGNOSE_MODE:         { fixed: 'DEFAULT' },
  FS_SPERREN:            { prompt: 'Lock fault memory? JA (yes) / NEIN (no)', placeholder: 'NEIN' },
  DIAGNOSEPROTOKOLL_SETZEN: { fixed: 'BMW-FAST' },
  // CBS reset service codes: br_h=brake fluid, oel=oil, mik=microfilter, zb=plugs
  CBS_RESET:             { prompt: 'CBS service to reset (br_h=brake fluid, oel=oil, mik=microfilter)', placeholder: 'oel', suffix: ';100;1;0;0;0x8000;1;0;0' },
};

// text-input modal -> Promise<string|null>
function promptDialog({ title, body, placeholder = '', value = '' }) {
  return new Promise((resolve) => {
    const { overlay, close } = openModal(`
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title">${title}</div>
        <div class="modal-body">${body}</div>
        <input class="modal-input" type="text" placeholder="${esc(placeholder)}" value="${esc(value)}" />
        <div class="modal-actions">
          <button class="btn modal-cancel">Cancel<span class="modal-key">Esc</span></button>
          <button class="btn primary modal-confirm">Run<span class="modal-key">⏎</span></button>
        </div>
      </div>`, {
      onClose: resolve,
      backdropValue: null,
      onKey: (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
        else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(input.value.trim() || null); }
      },
    });
    const input = overlay.querySelector('.modal-input');
    overlay.querySelector('.modal-cancel').onclick = () => close(null);
    overlay.querySelector('.modal-confirm').onclick = () => close(input.value.trim() || null);
    setTimeout(() => input.focus(), 50);
  });
}

// fetch a job's declared arguments from the SGBD (_ARGUMENTS). returns the list
// of {ARG, ARGTYPE, ARGCOMMENT0..} rows, or [] if the job takes none / on error.
async function fetchJobArgs(ecu, job) {
  try {
    const d = await api(`/api/ecu/${ecu.sgbd}/arguments/${encodeURIComponent(job)}`);
    const specs = (d.arguments || []).filter(a => a.ARG); // header row has no ARG
    // An argument documented "table BITS NAME TEXT" takes its legal values from
    // that SGBD table (NAME to send, TEXT the label) — the SGBD's own
    // convention, so it resolves for any ECU.
    await Promise.all(specs.map(async (a) => {
      const ref = Object.keys(a).filter(k => /^ARGCOMMENT\d+$/.test(k))
        .map(k => /\btable\s+(\w+)\s+(\w+)\s+(\w+)/i.exec(a[k] || ''))
        .find(Boolean);
      if (!ref) return;
      try {
        const rows = await api(`/api/ecu/${ecu.sgbd}/table/${encodeURIComponent(ref[1])}`);
        a._options = rows
          .map(r => ({ value: r[ref[2]], label: r[ref[3]] || r[ref[2]] }))
          .filter(o => o.value);
      } catch { /* table unreadable: fall back to a free-text field */ }
    }));
    return specs;
  } catch { return []; }
}

// group table-backed options by the first word of their label, the way INPA
// groups its Activate screen. Groups of one collapse into an "Other" bucket so
// the list does not become a run of single-item headings.
function optGroupHtml(options, tr) {
  const groups = new Map();
  options.forEach(o => {
    const label = tr(o.label) || o.value;
    const key = String(label).split(/[\s\-,/]+/)[0] || 'Other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...o, label });
  });
  const big = [...groups.entries()].filter(([, v]) => v.length > 1);
  const small = [...groups.entries()].filter(([, v]) => v.length === 1)
    .flatMap(([, v]) => v);
  const opt = (o) => `<option value="${esc(o.value)}">`
    + `${esc(o.label)} (${esc(o.value)})</option>`;
  const parts = big
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, items]) =>
      `<optgroup label="${esc(name)}">${items.map(opt).join('')}</optgroup>`);
  if (small.length) {
    parts.push(`<optgroup label="Other">`
      + small.sort((a, b) => a.label.localeCompare(b.label)).map(opt).join('')
      + `</optgroup>`);
  }
  return parts.join('');
}

// multi-field argument dialog built from the _ARGUMENTS schema. resolves to the
// ';'-joined arg string EDIABAS expects, or null if cancelled.
function argsDialog(job, argSpecs) {
  return new Promise((resolve) => {
    const tr = (s) => (typeof deGerman === 'function' ? deGerman(s) : s) || s;
    const fieldHtml = argSpecs.map((a, i) => {
      const hint = tr((a.ARGCOMMENT0 || '').replace(/^'|'$/g, ''));
      // enumerated values: ARGCOMMENT0/1/2 each a quoted token
      const enumVals = Object.keys(a).filter(k => /^ARGCOMMENT\d+$/.test(k))
        .map(k => a[k]).filter(v => /^'.*'$/.test(v)).map(v => v.replace(/^'|'$/g, ''));
      // values the SGBD spelled out in a table beat guessing from comments
      const tableOpts = a._options || [];
      const isEnum = tableOpts.length > 0 || (enumVals.length >= 2 && a.ARGTYPE === 'string');
      const isBinary = a.ARGTYPE === 'binary';
      // arg name comes from the SGBD in German (ZEIT, DAUER); humanize + translate
      const argName = tr(humanizeKey(a.ARG));
      const label = `${esc(argName)} <span class="arg-type">(${esc(a.ARGTYPE || 'string')})</span>`;
      let note = !isEnum && hint ? `<div class="arg-hint">${esc(hint)}</div>` : '';
      if (isBinary) note += `<div class="arg-warn">Binary argument: enter raw hex (e.g. <span class="mono">01 00 0A ...</span>). Must be a valid pre-built buffer for this job, or it may fail or harm the ECU.</div>`;
      const placeholder = isBinary ? 'hex bytes, e.g. 01 00 0A' : (a.ARGTYPE === 'int' ? '0' : '');
      // group by the label's leading noun, matching the grouping the ECU's own
      // wording implies (Schalter, Motor, Tuerkontakt) — same shape as INPA's
      // Activate screen, without inventing a taxonomy.
      const optHtml = tableOpts.length
        ? optGroupHtml(tableOpts, tr)
        : enumVals.map(v => `<option>${esc(v)}</option>`).join('');
      const field = isEnum
        ? `<select class="modal-input arg-field" data-i="${i}">${optHtml}</select>`
        : `<input class="modal-input arg-field" data-i="${i}" data-binary="${isBinary ? 1 : 0}" type="text" placeholder="${placeholder}" />`;
      return `<div class="arg-row"><label class="arg-label">${label}</label>${field}${note}</div>`;
    }).join('');
    const { overlay, close } = openModal(`
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title">${esc(jobLabel(job))}</div>
        <div class="modal-body">This job needs ${argSpecs.length} argument${argSpecs.length === 1 ? '' : 's'}.</div>
        <div class="arg-fields">${fieldHtml}</div>
        <div class="modal-actions">
          <button class="btn modal-cancel">Cancel<span class="modal-key">Esc</span></button>
          <button class="btn primary modal-confirm">Run<span class="modal-key">⏎</span></button>
        </div>
      </div>`, {
      onClose: resolve,
      backdropValue: null,
      onKey: (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
        else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(collect()); }
      },
    });
    const fields = [...overlay.querySelectorAll('.arg-field')];
    const collect = () => fields.map(f => {
      let v = f.value.trim();
      // binary args: normalize hex to a compact "0xAABBCC" form EDIABAS accepts
      if (f.dataset.binary === '1' && v) {
        const hex = v.replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '');
        v = hex ? '0x' + hex.toUpperCase() : '';
      }
      return v;
    }).join(';');
    overlay.querySelector('.modal-cancel').onclick = () => close(null);
    overlay.querySelector('.modal-confirm').onclick = () => close(collect());
    setTimeout(() => fields[0] && fields[0].focus(), 50);
  });
}

// THE ECU'S SECOND FAULT STORE. Shadow memory holds entries that have not
// (yet) met the criteria to become an active fault, and it survives a clear
// of the main memory -- which is exactly what makes it worth reading: it is
// the store that is still there after someone clears codes before a sale.
//
// Three job names for the one thing, which is why looking for a single name
// finds less than half of them: FS_SHADOW_LESEN (17 SGBDs -- BMS43/46,
// MS41x/42x/43x, MSS52, DME 5.2x, DDE22/40, SMG2), FS_LESEN_SHADOW (11 --
// the newer DDEs) and READ_SHADOW (4 -- E65 tailgate modules).
//
// EDIABAS decodes it with decode_shadow_memory_kwp2000, which emits the same
// eleven F_* results as the normal decoder (B2BMW.CHM), so renderFaults
// handles it unchanged.
const SHADOW_JOB_RE = /^(FS_SHADOW_LESEN|FS_LESEN_SHADOW|READ_SHADOW)$/i;
const isShadowJob = (job) => SHADOW_JOB_RE.test(String(job || ''));

// run a job and render its result sets. FS_LESEN gets the fault-card view, others
// a generic key/value table.
async function runJob(ecu, job, container, danger, presetArg) {
  if (job === 'FS_LESEN' || job === 'FS_LESEN_DETAIL' || isShadowJob(job)) {
    loadFaultDb(); // warm the name db
  }
  // resolve a required argument first. hand-tuned JOB_ARGS overrides win (they
  // encode special encodings like CBS_RESET's tail); otherwise ask the SGBD.
  let arg = presetArg;
  const spec = JOB_ARGS[job];
  if (arg == null && spec) {
    if (spec.fixed != null) arg = spec.fixed;
    else if (spec.prompt) {
      arg = await promptDialog({ title: esc(jobLabel(job)), body: spec.prompt, placeholder: spec.placeholder || '' });
      if (arg == null) return; // cancelled
      if (spec.suffix) arg += spec.suffix; // e.g. CBS_RESET service code + tail
    }
  } else if (arg == null) {
    const argSpecs = await fetchJobArgs(ecu, job);
    if (argSpecs.length) {
      arg = await argsDialog(job, argSpecs);
      if (arg == null) return; // cancelled
    }
  }
  if (danger) {
    const isClear = job === 'FS_LOESCHEN';
    // describe what the job actually does — not everything flagged is a write.
    // flash-session reads are cautioned because they can disrupt a programming
    // sequence, not because they change anything.
    const j = job.toUpperCase();
    let effect;
    if (/LESEN/.test(j) && /FLASH|AUTHENTIS|SIGNATUR|CRC|PRUEF/.test(j))
      effect = `is part of the flash-programming sequence on <b>${esc(ecu.label)}</b>. It reads from the ECU but can disrupt an in-progress flash if run out of order.`;
    else if (/LOESCHEN/.test(j))
      effect = `erases data on <b>${esc(ecu.label)}</b>. This cannot be undone.`;
    else if (/SCHREIBEN|_SETZEN|PROGRAMMIER|FLASH/.test(j))
      effect = `writes to the ECU on <b>${esc(ecu.label)}</b> and can change how it runs.`;
    else if (/RESET/.test(j))
      effect = `resets the ECU on <b>${esc(ecu.label)}</b>.`;
    else
      effect = `runs a protected function on <b>${esc(ecu.label)}</b>.`;
    const ok = await confirmDialog({
      title: isClear ? 'Clear fault codes?' : `Run ${esc(jobLabel(job))}?`,
      body: isClear
        ? `This permanently erases the fault memory on <b>${esc(ecu.label)}</b>. Stored and pending faults will be deleted. This cannot be undone.`
        : `<b>${esc(jobLabel(job))}</b> (<span class="mono">${esc(job)}</span>) ${effect} Continue?`,
      confirmLabel: isClear ? 'Clear codes' : 'Run',
      danger: true,
    });
    if (!ok) return;
  }
  container.innerHTML = `<div class="empty"><span class="loader"></span><span>Running ${esc(jobLabel(job))}…</span></div>`;
  container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  sbLeft.textContent = `${job}…`;
  try {
    let q = arg != null && arg !== '' ? `?arg=${encodeURIComponent(arg)}` : '';
    // fault jobs load via the diagnostic-address group so EDIABAS picks the exact
    // variant (see server LoadForJob); other jobs stay on the concrete SGBD.
    // ...and a shadow read is a fault read: READ_SHADOW does not start FS_,
    // so without this the E65 tailgate modules would miss the group routing
    // every other fault job gets.
    if (ecu.group && (/^FS_/.test(job) || isShadowJob(job))) {
      q += `${q ? '&' : '?'}group=${encodeURIComponent(ecu.group)}`;
    }
    const data = await api(`/api/ecu/${ecu.sgbd}/run/${job}${q}`, { method: 'POST' });
    if (job === 'FS_LESEN' || job === 'FS_LESEN_DETAIL' || isShadowJob(job)) {
      const codes = data.sets.slice(1); // set 0 = system summary
      await loadFaultDb(); // names resolve synchronously in the render
      renderFaults(codes, container, ecu);
      // say WHICH store this was: a shadow read showing 0 is a different
      // statement from the main memory showing 0, and the two are easy to
      // confuse once the cards look identical.
      sbLeft.textContent = isShadowJob(job)
        ? `shadow memory · ${codes.length} entr${codes.length === 1 ? 'y' : 'ies'}`
        : `${codes.length} fault(s)`;
    } else if (job === 'FS_LOESCHEN') {
      // INPA reruns the read after a clear; do the same rather than asking
      // the user to. A fault that re-set the moment the ECU saw it again
      // shows immediately instead of hiding behind "cleared".
      container.innerHTML = `<div class="empty"><span class="loader"></span><span>Cleared · re-reading…</span></div>`;
      try {
        const rq = ecu.group ? `?group=${encodeURIComponent(ecu.group)}` : '';
        const rr = await api(`/api/ecu/${ecu.sgbd}/run/FS_LESEN${rq}`, { method: 'POST' });
        const codes = rr.sets.slice(1);
        await loadFaultDb();
        renderFaults(codes, container, ecu);
        sbLeft.textContent = codes.length
          ? `cleared · ${codes.length} fault(s) still present`
          : 'cleared · memory clean';
      } catch {
        container.innerHTML = `<div class="empty"><div class="empty-big">Fault memory cleared</div><div>Re-read failed - read again to confirm.</div></div>`;
        sbLeft.textContent = 'cleared';
      }
    } else {
      renderResultSets(data.sets, container, job);
      sbLeft.textContent = 'done';
    }
  } catch (e) {
    container.innerHTML = errorBlock(e.message);
    sbLeft.textContent = 'failed';
  }
}

// INPA displays a fixed window of 10 values per screen page (2 columns x 5
// rows). When a screen holds more, INPA shows a single green scroll arrow in the
// bottom-right: it points DOWN while more rows lie below, and flips to UP once
// you reach the last page (then pages back up). This mirrors that exactly.
const INPA_PAGE_ROWS = 10;

// attach an INPA page-arrow to a live gauge grid. `orderedKeys()` returns the
// current full key order (cells arrive incrementally), `cellFor(k)` the cell.
// Returns { relayout } to call whenever the cell set changes.
function attachInpaPager(panel, grid, orderedKeys, cellFor) {
  const arrow = document.createElement('button');
  arrow.className = 'inpa-pager-arrow';
  arrow.type = 'button';
  panel.appendChild(arrow);
  let page = 0;

  // how many cells fit the visible area. INPA's 10 is the ceiling, but a short
  // window (or tall rows) must page sooner rather than scroll.
  function perPage() {
    const cells = orderedKeys().map(cellFor).filter(Boolean);
    if (!cells.length) return INPA_PAGE_ROWS;
    // measure the TALLEST cell, not the first: a row carrying a [unit] line and
    // a bar is taller than a text-only one, and sizing off a short cell
    // overfills the page
    const h = Math.max(...cells.map(c => c.offsetHeight || 0));
    if (!h) return INPA_PAGE_ROWS;
    const cols = grid.classList.contains('two-col') ? 2 : 1;
    // measure the real footer rather than assuming its height: the F-key bar is
    // 52px and the pager arrow needs ~34 more, so a fixed 70 clips the last row
    // on pages that cannot scroll
    const bar = document.querySelector('.fkeybar');
    const footer = (bar ? bar.getBoundingClientRect().height : 52) + 40;
    const avail = grid.getBoundingClientRect
      ? window.innerHeight - grid.getBoundingClientRect().top - footer : 0;
    if (avail <= 0) return INPA_PAGE_ROWS;
    const rows = Math.max(1, Math.floor(avail / h));
    let per = Math.max(cols, Math.min(INPA_PAGE_ROWS, rows * cols));
    // avoid a last page holding one or two stragglers: spread the values evenly
    // across the pages they need instead (17 over 3 pages -> 6+6+5, not 8+8+1)
    const total = cells.length;
    if (total > per) {
      const pageCount = Math.ceil(total / per);
      per = Math.ceil(total / pageCount / cols) * cols;
    }
    return per;
  }
  function pages() {
    return Math.max(1, Math.ceil(orderedKeys().length / perPage()));
  }
  function relayout() {
    const keys = orderedKeys();
    const per = perPage();
    const n = Math.max(1, Math.ceil(keys.length / per));
    if (page > n - 1) page = n - 1;
    const start = page * per, end = start + per;
    keys.forEach((k, i) => {
      const c = cellFor(k);
      if (c) c.classList.toggle('inpa-hidden', i < start || i >= end);
    });
    if (keys.length <= per) { arrow.style.display = 'none'; return; }
    arrow.style.display = '';
    const atBottom = page >= n - 1;
    arrow.classList.toggle('up', atBottom);
    arrow.textContent = atBottom ? '▲' : '▼';
    arrow.setAttribute('aria-label',
      atBottom ? 'Previous page' : 'Next page');
    arrow.title = `Page ${page + 1} / ${n}`;
  }
  // the arrow flips direction at the last page, so a click always advances then
  // walks back up — matching INPA's single-arrow pager
  arrow.onclick = () => {
    const n = pages();
    page = (page >= n - 1) ? Math.max(0, page - 1) : page + 1;
    relayout();
    grid.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  // arrow keys page too. Up/Down move absolutely (not the arrow's flip
  // behaviour), which is what a keyboard user expects.
  const onKey = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (!panel.isConnected) { window.removeEventListener('keydown', onKey); return; }
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (document.querySelector('.modal-overlay')) return;  // a dialog owns the keys
    const n = pages();
    if (n <= 1) return;
    const next = e.key === 'ArrowDown' ? Math.min(n - 1, page + 1) : Math.max(0, page - 1);
    if (next === page) return;
    e.preventDefault();
    page = next;
    relayout();
    arrow.classList.remove('flash'); void arrow.offsetWidth; arrow.classList.add('flash');
  };
  window.addEventListener('keydown', onKey);
  // perPage() measures rendered cell height, which is 0 until the browser has
  // laid the cells out — and cells keep arriving, since each job answers on its
  // own tick. Re-measure on the next frame so the page size (and whether the
  // arrow is needed at all) reflects what is actually on screen.
  const remeasure = () => requestAnimationFrame(() => {
    if (panel.isConnected) relayout();
  });
  // a resize changes how many rows fit, so re-page rather than start scrolling
  const onResize = () => {
    if (!panel.isConnected) { window.removeEventListener('resize', onResize); return; }
    relayout();
  };
  window.addEventListener('resize', onResize);
  return {
    relayout: () => { relayout(); remeasure(); },
    dispose: () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    },
  };
}

// INPA F-key status category: the screens behind one F-key, merged into a
// single paged grid. The statusTree gives every block its own F-key, so there
// is no second on-screen tab strip — the footer keys are the only selector,
// exactly like INPA.
function showInpaCategory(ecu, screens, container, title) {
  showInpaScreens(ecu, screens, container, title);
}

// Fill a row's missing unit/range from INPA's own gauge declaration. Rows that
// already carry one keep it: a hand-verified layout outranks a decode, and the
// specs deliberately omit gauges whose sign the bytecode does not record.
function applyGaugeSpecs(ecu, screens) {
  const specs = (ecu._layout && ecu._layout.gaugeSpecs) || [];
  if (!specs.length) return screens;
  const byKey = new Map(specs.map(g => [g.key, g]));
  return screens.map(scr => ({
    ...scr,
    rows: (scr.rows || []).map(r => {
      const g = byKey.get(r.key);
      if (!g) return r;
      const out = { ...r };
      if (!out.unit && g.unit) out.unit = g.unit;
      if (out.min == null && out.max == null
          && g.min != null && g.max != null) {
        out.min = g.min;
        out.max = g.max;
      }
      return out;
    }),
  }));
}

// One INPA screen that is genuinely a TABLE: a header row, then one row per
// pass of the same job. RDC's WE-Telegramm is five wheels x seven values, and
// INPA prints it as a grid with the columns lined up -- which is how you read
// four wheels against each other at a glance. Flattening it into 35 stacked
// readouts loses exactly the thing the layout is for.
//
// Each row is its own read (the job takes the index as its argument), so the
// poller walks `polls` and fills that row. A pass that fails leaves its row
// showing the last value rather than blanking the table.
async function showInpaTable(ecu, scr, container, title, meta, grid, liveTok) {
  const t = scr.table;
  const polls = scr.polls || [{ job: scr.job, args: scr.args || '' }];

  grid.classList.remove('inpa-grid', 'two-col');
  grid.classList.add('inpa-table-wrap');
  grid.innerHTML = `
    <table class="inpa-table">
      <thead><tr>
        <th>${esc(deGerman(t.rowHead) || t.rowHead || '')}</th>
        ${t.headings.map(h => `<th>${esc(deGerman(h) || h)}</th>`).join('')}
      </tr></thead>
      <tbody>
        ${t.labels.map((lab, i) => `<tr data-r="${i}">
          <th scope="row">${esc(lab)}</th>
          ${t.cols.map((_, c) => `<td data-c="${c}">–</td>`).join('')}
        </tr>`).join('')}
      </tbody>
    </table>`;

  const cellAt = (r, c) =>
    grid.querySelector(`tr[data-r="${r}"] td[data-c="${c}"]`);

  async function tick() {
    let alive = 0, lastErr = null;
    for (let r = 0; r < polls.length && r < t.labels.length; r++) {
      const p = polls[r];
      let data;
      try {
        const url = `/api/ecu/${ecu.sgbd}/run/${p.job}`
          + (p.args ? `?arg=${encodeURIComponent(p.args)}` : '');
        data = await api(url, { method: 'POST' });
      } catch (e) { lastErr = e; continue; }
      alive++;
      const vals = new Map(flatResults(data.sets));
      (t.keys[r] || []).forEach((key, c) => {
        const cell = cellAt(r, c);
        if (!cell || !key || !vals.has(key)) return;
        const raw = vals.get(key);
        // The unit belongs to the column (the heading), not the cell: a bare
        // `${key}_EINH` lookup returned the neighbouring row's "%" for RDC's
        // pressures.
        const shown = String(raw);
        if (cell.textContent !== shown) { cell.textContent = shown; flash(cell); }
      });
    }
    if (alive) {
      meta.textContent = demoMode() ? 'demo' : 'live';
      sbLeft.textContent = `${scr.job} · ${t.labels.length}x${t.cols.length}`;
    } else if (lastErr) {
      meta.textContent = 'no response';
      sbLeft.textContent = 'no response';
    }
  }

  await tick();
  if (container.querySelector('.inpa-table')) scheduleLive(tick);
}

async function showInpaScreens(ecu, screens, container, title, { scroll = false } = {}) {
  stopLive();
  screens = applyGaugeSpecs(ecu, screens);
  const liveTok = _liveToken;
  title = title || (screens.length === 1
    ? (deGerman(screens[0].group) || jobLabel(screens[0].job))
    : `${screens.length} readouts`);
  // a merged category always pairs off into two columns; a lone screen honours
  // its own layout (columns:2 = Bank 1 / Bank 2). Also go two-wide when one
  // screen has more rows than fit a page, so values aren't paged away while
  // half the screen sits empty.
  const rowCount = screens.reduce((n, s) => n + ((s.rows || []).length), 0);
  const twoCol = screens.length > 1
    || (screens[0] && screens[0].columns === 2)
    || rowCount > INPA_PAGE_ROWS / 2;

  // no live dot, no Stop button in either mode — leaving the screen stops the
  // polling (setActions -> stopLive), like INPA. INPA mode draws values straight
  // on the window (bare); modern mode keeps the panel.
  container.className = 'live-panel inpa-screen' + (inpaMode() ? ' bare' : '');
  container.innerHTML = `
    <div class="live-head">
      <span class="live-title">${esc(title)}</span>
      <span class="live-meta" id="live-meta">connecting…</span>
    </div>
    <div class="live-grid inpa-grid${twoCol ? ' two-col' : ''}" id="live-grid"></div>`;
  if (scroll) container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const grid = container.querySelector('#live-grid');
  const meta = container.querySelector('#live-meta');

  const cellEls = new Map();  // "job:key" -> cell
  const keyOrder = [];
  // A SCREEN INPA DRAWS AS A TABLE renders as one, not as N stacked pages.
  // RDC's WE-Telegramm reads the same seven values once per wheel; the IR
  // carries the column layout, so draw the grid and fill it per pass.
  //
  // BEFORE THE PAGER, deliberately. That pages `cellEls`, which a table never
  // fills, so attaching it first left an empty green box with no arrow in it
  // and nothing to scroll.
  const tableScr = screens.find(s => s.table);
  if (tableScr && screens.length === 1) {
    return showInpaTable(ecu, tableScr, container, title, meta, grid, liveTok);
  }

  const pager = attachInpaPager(container, grid,
    () => keyOrder, (k) => cellEls.get(k));

  async function tick() {
    let added = false, alive = 0, lastErr = null;
    for (const scr of screens) {
      const arg = scr.args || '';
      let data;
      try {
        const url = `/api/ecu/${ecu.sgbd}/run/${scr.job}` + (arg ? `?arg=${encodeURIComponent(arg)}` : '');
        data = await api(url, { method: 'POST' });
      } catch (e) {
        lastErr = e;
        continue; // one failing job shouldn't blank a merged category
      }
      alive++;
      const vals = new Map(flatResults(data.sets));
      let ri = -1;
      for (const r of gridOrder(scr)) {
        ri++;
        if (!vals.has(r.key)) continue;
        // A cell is one drawn ROW, not one job's answer. INPA draws the same
        // result under several captions on one screen (KOMBI prints
        // STAT_U_BATT_WERT as clamp 30, 58g HIGH and 58g LOW), so the caption
        // is part of the identity -- but the screen's jobs are NOT: every job
        // carries the whole row list and answers its own subset, so keying by
        // job would draw one cell per job that happens to return the key.
        const ck = `${r.key}:${r.arg || ''}:${r.label || ''}:${ri}`;
        // INPA lets the ECU word some captions itself via a _TEXT result;
        // prefer that over our own label. But the same _TEXT can carry a STATE
        // word ("aktiv", "aus"), which is not a caption -- letting it win put
        // "AKTIV" where INPA prints "Muster SchubAbschaltung" -- so keep ours
        // for state words and when the read is empty.
        const live = r.captionKey ? String(vals.get(r.captionKey) ?? '').trim() : '';
        const caption = (live && !IR_STATE_WORD.test(live) ? deGerman(live) : '')
          || deGerman(r.label) || r.key;
        // The ECU ships the unit beside the value: EDIABAS pairs every
        // STAT_x_WERT with a STAT_x_EINH holding its unit ("°CRK", "%"). r.unit
        // only carries the .IPO's literal "[rpm]" text, which most screens omit
        // (MSD80's whole VANOS page declares none), so fall back to the ECU's
        // own answer. A LAMP HAS NO UNIT -- it is on/off, so a "[%]" over it is
        // nonsense whatever _EINH says (MSD80's REAL VALUE read "[%] ● on").
        const unit = r.kind === 'lamp'
          ? null : (r.unit || irUnitFor(r.key, vals));
        let cell = cellEls.get(ck);
        if (!cell) {
          cell = document.createElement('div');
          cell.className = 'live-cell gauge-cell';
          cell.innerHTML = gaugeCellHTML(caption, unit);
          grid.appendChild(cell);
          cellEls.set(ck, cell);
          keyOrder.push(ck);
          added = true;
        }
        updateGaugeSpec(cell, unit === r.unit ? r : { ...r, unit },
                        vals.get(r.key));
      }
    }
    if (added) pager.relayout();
    if (alive) {
      // Only what is actually on screen. The "of N" half was a prediction --
      // rows the ECU never answers, or one page counted once per job -- and
      // reporting a number the screen then contradicts is worse than none.
      meta.textContent = (demoMode() ? 'DEMO · ' : 'live · ')
        + `${cellEls.size} value${cellEls.size === 1 ? '' : 's'}`;
      meta.classList.toggle('demo', demoMode());
      sbLeft.textContent = `${screens.map(s => s.job).join(', ').slice(0, 60)} · live`;
    } else if (cellEls.size === 0) {
      // nothing ever rendered (e.g. no cable): show the error instead of
      // spinning on "connecting…" forever
      stopLive(); container.className = 'results-panel';
      container.innerHTML = errorBlock(lastErr && lastErr.message); sbLeft.textContent = 'failed';
    } else {
      // had values, now every screen fails: keep the last reading on screen but
      // stop claiming it's live
      meta.textContent = 'no response';
      sbLeft.textContent = 'no response';
    }
  }
  await tick();
  // THE DOM IS THE STALENESS TEST, NOT THE TOKEN. Callers start the live view
  // then call setActions (for Back), which begins with stopLive() and bumps the
  // token -- while this first tick is still awaiting its first api() call. So a
  // liveTok===_liveToken guard here would never hold and the screen would paint
  // once and freeze. The DOM check is safe: if the user navigated away this
  // container no longer holds the grid, and scheduleLive re-reads the token for
  // every later tick, so a real stopLive() during steady-state still stops it.
  if (container.querySelector('.inpa-grid')) scheduleLive(tick);
}

// Screen rows in the order INPA actually draws them. When the .IPO decode gave
// us a grid, it carries the true row/column of every value,
// so reading-order becomes row-major — which is what makes bank 1 / bank 2 line
// up as pairs. Without a grid, or outside INPA mode, the layout order stands.
function gridOrder(scr) {
  const rows = scr.rows || [];
  if (!inpaMode() || !scr.grid || !Array.isArray(scr.grid.cells)) return rows;
  const at = new Map(scr.grid.cells.map(c => [c.key, c]));
  const placed = rows.filter(r => at.has(r.key));
  const rest = rows.filter(r => !at.has(r.key));
  placed.sort((a, b) => {
    const x = at.get(a.key), y = at.get(b.key);
    return x.row - y.row || x.col - y.col;
  });
  return [...placed, ...rest];
}

// INPA draws a boolean as a lamp: filled circle on, hollow off. Returns the
// glyph + word, or null when the value isn't a boolean.
const BOOL_ON = /^(ein|on|aktiv|active|ja|yes|1|betaetigt|gedrueckt|vorhanden)$/i;
const BOOL_OFF = /^(aus|off|nicht aktiv|not active|inaktiv|nein|no|0|nicht betaetigt|nicht vorhanden|not present)$/i;
function boolGlyph(raw) {
  const s = String(raw == null ? '' : raw).trim();
  // a bare 0/1 IS the state, not a word for it: printing the digit beside the
  // glyph gave "○ 0" where every neighbouring row read "○ off"
  if (/^[01]$/.test(s)) return { on: s === '1', text: s === '1' ? 'on' : 'off' };
  if (BOOL_ON.test(s)) return { on: true, text: deGerman(s) || s };
  if (BOOL_OFF.test(s)) return { on: false, text: deGerman(s) || s };
  return null;
}

// render a boolean as INPA's lamp, in BOTH themes. It was INPA-mode-only, and
// the modern layout then showed the raw value instead -- fine for a word
// ("aktiv") but not for the bare 0/1 an OBD readiness flag returns, which
// reads as a measurement. Returns false if the value isn't a boolean, so the
// caller falls back to plain text.
function setBoolCell(cellEl, valEl, raw, rowSpec) {
  const b = boolGlyph(raw);
  if (!b) { cellEl.classList.remove('bool'); return false; }
  cellEl.classList.add('bool');
  cellEl.classList.remove('text-only');
  // INPA prints its OWN words for a lamp, declared beside it in the .IPO:
  // MS450's cruise-control buttons say EIN/AUS. Showing whatever word the ECU
  // returned instead left one screen reading "ready", "active" and "not
  // active" for four rows that INPA renders identically.
  const own = rowSpec && (b.on ? rowSpec.on : rowSpec.off);
  const text = own ? (deGerman(own) || own) : b.text;
  const shown = `${b.on ? '●' : '○'} ${text}`;
  if (valEl.textContent !== shown) { valEl.textContent = shown; flash(valEl); }
  return true;
}

// update a gauge cell from the layout row's unit/min/max, falling back to the
// heuristic range only where the layout left them null
function updateGaugeSpec(cellEl, rowSpec, raw) {
  const p = parseMeasurement(raw);
  const valEl = cellEl.querySelector('.gauge-val');
  if (p.num === null) {
    // a state word, not a number: the ECU says "ein"/"nicht aktiv", so it needs
    // the same translation the labels get (deGerman is a no-op in EDIABAS mode)
    if (setBoolCell(cellEl, valEl, p.raw, rowSpec)) return;
    const text = deGerman(p.raw) || p.raw;
    cellEl.classList.add('text-only');
    if (valEl.textContent !== text) { valEl.textContent = text; flash(valEl); }
    return;
  }
  // a row INPA prints as text stays text even when the value parses as a
  // number: coding counts, gear positions and part numbers are not
  // measurements, and a bar with an invented 0..50 range implies a scale the
  // ECU never declared. `kind` comes from the decoded screen -- INPA drew it
  // with textout, not analogout.
  if (rowSpec.kind === 'value' || rowSpec.kind === 'text') {
    cellEl.classList.add('text-only');
    const t = String(p.raw).trim();
    if (valEl.textContent !== t) { valEl.textContent = t; flash(valEl); }
    return;
  }
  // A LAMP is an indicator, never a measurement: INPA drew it with digitalout,
  // which has no scale. Falling through invented a 0..100 range and drew DWA4's
  // "with tilt alarm sensor" -- a yes/no coding flag -- as a bar sitting at 34.
  if (rowSpec.kind === 'lamp') {
    if (setBoolCell(cellEl, valEl, p.raw, rowSpec)) return;
    // A number here means an unmapped state; showing it bare ("HOOD / RADIO 94")
    // reads as a measurement, which a lamp never is. Non-zero = on (what
    // digitalout tests). NOT gated on inpaMode(): the theme decides how a lamp
    // LOOKS, never whether it is a lamp -- gating it made the modern theme draw
    // MSD80's OBD readiness page as "48 / 46 / 44" instead of on/off.
    if (p.num !== null) {
      cellEl.classList.add('bool');
      cellEl.classList.remove('text-only');
      const shown = p.num ? '\u25cf on' : '\u25cb off';
      if (valEl.textContent !== shown) { valEl.textContent = shown; flash(valEl); }
      return;
    }
    cellEl.classList.add('text-only');
    const t = String(p.raw).trim();
    if (valEl.textContent !== t) { valEl.textContent = t; flash(valEl); }
    return;
  }
  cellEl.classList.remove('text-only');
  // A range INPA DECLARED is the instrument's scale, not a hint: analogout
  // carries it, and INPA keeps the scale fixed and lets the bar sit full when
  // a reading runs past it. Widening to fit turned MS450's rough-running bars
  // (0..8, warning at 5) into 0..24 and 0..27 -- every bar pinned, and the
  // number that matters, how far past 8 the cylinder is, invisible.
  const declared = rowSpec.min != null && rowSpec.max != null;
  let min = rowSpec.min, max = rowSpec.max;
  if (min == null || max == null) {
    const r = rangeFor(rowSpec.unit || p.unit, p.num, rowSpec.label);
    if (min == null) min = r[0];
    if (max == null) max = r[1];
  }
  // ...but a GUESSED range is only a guess, so it still grows to fit rather
  // than clipping a reading it never anticipated.
  if (!declared) {
    if (p.num < min) min = p.num;
    if (p.num > max) max = p.num;
  }
  // DEMO values are synthesized from the result's UNIT (the server can't see
  // the IR's declared scale), so an unmatched unit gets a generic `i % 100`
  // that lands off its own axis. Fold it into the declared span so the bar
  // demonstrates the real scale. Never touches a live reading -- a real value
  // past its scale is a fact worth seeing pinned.
  if (declared && demoMode() && (p.num < min || p.num > max)) {
    const span0 = (max - min) || 1;
    p.num = +(min + span0 * (((Math.abs(p.num) % 70) + 15) / 100)).toFixed(1);
  }
  const span = (max - min) || 1;
  const pct = Math.max(0, Math.min(100, ((p.num - min) / span) * 100));
  const track = cellEl.querySelector('.gauge-track');
  cellEl.querySelector('.gauge-fill').style.width = pct.toFixed(1) + '%';
  // INPA's bar is two-toned: the band analogout declares good is green, the
  // rest of the scale red. That boundary IS the reading -- MS450's rough
  // running is green to 5 and red on to 8, so a cylinder's misfire count
  // means nothing without knowing where 5 falls. Painted on the track, so
  // the fill drawn over it is unaffected.
  if (rowSpec.okMin != null && rowSpec.okMax != null) {
    const at = (v) => Math.max(0, Math.min(100, ((v - min) / span) * 100));
    const a = at(rowSpec.okMin), b = at(rowSpec.okMax);
    const g = 'var(--gauge-ok)', r = 'var(--gauge-warn)';
    track.style.background = `linear-gradient(to right,`
      + `${r} 0 ${a.toFixed(1)}%, ${g} ${a.toFixed(1)}% ${b.toFixed(1)}%,`
      + `${r} ${b.toFixed(1)}% 100%)`;
    track.classList.add('zoned');
    // INPA prints every colour boundary on the axis, not just one (its VANOS
    // gauge reads "110 111 ... 135 140": scale ends plus both band edges).
    setEdge(cellEl, '.gauge-ok-lo', rowSpec.okMin, min, max, at);
    setEdge(cellEl, '.gauge-ok-hi', rowSpec.okMax, min, max, at);
  } else if (declared) {
    // A declared scale with no band is a plain INPA bar: all green, no
    // threshold. It still must not draw the solid fill, which read as a
    // black bar sitting over half the gauge.
    track.style.background = 'var(--gauge-ok)';
    track.classList.add('zoned');
    clearEdges(cellEl);
  } else if (track.classList.contains('zoned')) {
    track.style.background = '';
    track.classList.remove('zoned');
    clearEdges(cellEl);
  }
  cellEl.querySelector('.gauge-min').textContent = fmtRange(min);
  cellEl.querySelector('.gauge-max').textContent = fmtRange(max);
  // the unit already has its own "[V]" line, so the value stays a bare number
  // (INPA prints "0.73", not "0.73 V"); only an unmapped runtime unit is appended
  const shown = rowSpec.unit ? String(p.num) : `${p.num}${p.unit ? ' ' + p.unit : ''}`;
  if (valEl.textContent !== shown) { valEl.textContent = shown; flash(valEl); }
}

// self-scheduling live loop: each tick runs to completion (a real K-line
// transaction) before the next is queued ~1s later, so slow reads never pile up
// the way setInterval ticks did. stopLive() bumps the token, which also stops
// any in-flight tick from rescheduling.
let liveTimer = null;   // pending setTimeout handle for the next tick
let _liveToken = 0;
function stopLive() { _liveToken++; if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; } }
function scheduleLive(tick) {
  const token = _liveToken;
  const loop = async () => {
    liveTimer = null;
    try { await tick(); } // ticks render their own errors (and may call stopLive)
    catch { /* an unexpected throw shouldn't kill the loop */ }
    if (token !== _liveToken) return;
    liveTimer = setTimeout(loop, 1000);
  };
  liveTimer = setTimeout(loop, 1000);
}

// multi-watch: poll several Status jobs together into one live grid, optionally
// streaming timestamped rows to CSV
let logId = null;          // active CSV log id from the main process
let logColumns = null;     // fixed column order while logging
function stopLogging() {
  if (logId && window.bmacw) window.bmacw.stopLog(logId);
  logId = null; logColumns = null;
}

let logStart = 0;
function highlightWatched(view, jobs) {
  const map = view && view._rowByJob;
  if (!map) return;
  map.forEach((row) => row.classList.remove('watching'));
  if (jobs) jobs.forEach((j) => map.get(j)?.classList.add('watching'));
}

// INPA's measurement row: the label, the unit in brackets on its own line, then
// the bar with the value to its RIGHT and the scale ends tucked beneath it.
function gaugeCellHTML(key, unit) {
  return `
    <div class="live-k" title="${esc(key)}">${esc(key)}</div>
    <div class="gauge-unit">${unit ? `[${esc(unit)}]` : ''}</div>
    <div class="gauge">
      <div class="gauge-bar">
        <div class="gauge-track"><div class="gauge-fill"></div></div>
        <div class="gauge-foot">
          <span class="gauge-min"></span>
          <span class="gauge-ok-lo gauge-edge"></span>
          <span class="gauge-ok-hi gauge-edge"></span>
          <span class="gauge-max"></span>
        </div>
      </div>
      <span class="gauge-val live-v"></span>
    </div>`;
}

// one band edge on the axis, positioned where the colours meet. An edge that
// coincides with a scale end is left blank -- that number is already printed.
function setEdge(cellEl, sel, v, min, max, at) {
  const el = cellEl.querySelector(sel);
  if (!el) return;
  // An edge within ~8% of a scale end collides with the number printed there
  // (MS450's band starts at 111 on a 110..140 scale), so leave it unlabelled --
  // the band is still visible as the colour change. INPA has the same collision.
  const p = v == null ? null : at(v);
  const show = v != null && v > min && v < max && p > 8 && p < 92;
  const t = show ? fmtRange(v) : '';
  if (el.textContent !== t) el.textContent = t;
  if (show) el.style.left = p.toFixed(1) + '%';
}

function clearEdges(cellEl) {
  for (const sel of ['.gauge-ok-lo', '.gauge-ok-hi']) {
    const el = cellEl.querySelector(sel);
    if (el && el.textContent) el.textContent = '';
  }
}

// update a gauge cell in place from a parsed measurement
function updateGauge(cellEl, key, raw) {
  const p = parseMeasurement(raw);
  const valEl = cellEl.querySelector('.gauge-val');
  // non-numeric: a state word ("ein", "nicht aktiv") — translate it like a
  // label, hide the bar
  if (p.num === null) {
    if (setBoolCell(cellEl, valEl, p.raw)) return;
    const text = deGerman(p.raw) || p.raw;
    cellEl.classList.add('text-only');
    if (valEl.textContent !== text) {
      valEl.textContent = text;
      flash(valEl);
    }
    return;
  }
  cellEl.classList.remove('text-only');
  let [min, max] = rangeFor(p.unit, p.num, key);
  // expand the range if the live value blows past it (keeps the bar honest)
  if (p.num < min) min = p.num;
  if (p.num > max) max = p.num;
  const span = max - min || 1;
  const pct = Math.max(0, Math.min(100, ((p.num - min) / span) * 100));
  const fill = cellEl.querySelector('.gauge-fill');
  fill.style.width = pct.toFixed(1) + '%';
  cellEl.querySelector('.gauge-min').textContent = fmtRange(min);
  cellEl.querySelector('.gauge-max').textContent = fmtRange(max);
  // round long decimals for display (e.g. 8.969696969 -> 8.97), keep the unit
  const numStr = Number.isInteger(p.num) ? String(p.num)
    : (Math.abs(p.num) >= 100 ? p.num.toFixed(1) : p.num.toFixed(2));
  const shown = p.unit ? `${numStr} ${p.unit}` : numStr;
  if (valEl.textContent !== shown) {
    valEl.textContent = shown;
    flash(valEl);
  }
}

function flash(el) {
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

async function watchMulti(ecu, jobs, container, view) {
  stopLive();
  stopLogging();
  const liveTok = _liveToken;
  highlightWatched(view, jobs);

  // INPA mode pages the watch grid 10-at-a-time like a real INPA screen
  const paged = typeof inpaMode === 'function' && inpaMode();

  // build the panel once; ticks only update value cells (no flicker)
  container.className = 'live-panel' + (paged ? ' inpa-screen' : '');
  container.innerHTML = `
    <div class="live-head">
      <span class="live-dot"></span>
      <span class="live-title">Watching ${jobs.length} job${jobs.length === 1 ? '' : 's'}</span>
      <span class="live-meta" id="live-meta">connecting…</span>
      <button class="btn live-log" id="live-log">Stream to file…</button>
      <button class="btn danger live-stop" id="live-stop">Stop</button>
    </div>
    <div class="live-grid${paged ? ' inpa-grid two-col' : ''}" id="live-grid"></div>`;
  container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const grid = container.querySelector('#live-grid');
  const meta = container.querySelector('#live-meta');
  const dot = container.querySelector('.live-dot');
  const logBtn = container.querySelector('#live-log');
  const cellEls = new Map(); // key -> value <div> (updated in place)
  const keyOrder = [];
  const pager = paged
    ? attachInpaPager(container, grid, () => keyOrder, (k) => cellEls.get(k))
    : null;

  const stop = () => {
    stopLive(); stopLogging();
    highlightWatched(view, null);
    dot.classList.add('stopped');
    meta.textContent = 'stopped';
    container.querySelector('.live-title').textContent = `Stopped · ${jobs.length} job${jobs.length === 1 ? '' : 's'}`;
    logBtn.textContent = 'Stream to file…';
    sbLeft.textContent = 'stopped';
  };
  container.querySelector('#live-stop').onclick = stop;
  logBtn.onclick = () => toggleLogging();

  function toggleLogging() {
    if (!window.bmacw) { sbLeft.textContent = 'logging unavailable'; return; }
    if (logId) { stopLogging(); logBtn.textContent = 'Stream to file…'; meta.classList.remove('rec'); sbLeft.textContent = 'log saved'; return; }
    logColumns = [...cellEls.keys()];
    if (logColumns.length === 0) { sbLeft.textContent = 'no values yet'; return; }
    const header = ['timestamp_iso', 'elapsed_ms', ...logColumns];
    const name = `bmacw-${ecu.sgbd}-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.csv`;
    window.bmacw.startLog(name, header).then((res) => {
      if (res && res.ok) { logId = res.id; logStart = Date.now(); logBtn.textContent = 'Stop logging'; meta.classList.add('rec'); sbLeft.textContent = `logging → ${res.path.split('/').pop()}`; }
    });
  }

  async function readAll() {
    const merged = new Map();
    await Promise.all(jobs.map(async (job) => {
      try {
        const data = await api(`/api/ecu/${ecu.sgbd}/run/${job}`, { method: 'POST' });
        flatResults(data.sets).forEach(([k, v]) => merged.set(k, v));
      } catch { /* one job failing shouldn't kill the whole watch */ }
    }));
    return merged;
  }

  async function tick() {
    let merged;
    try { merged = await readAll(); }
    catch (e) {
      stop();
      meta.textContent = 'read failed';
      return;
    }
    // pair value+unit (STAT_x_WERT + STAT_x_EINH -> one reading), humanize key
    const entries = pairWertEinh(merged);
    let added = false;
    for (const e of entries) {
      let cell = cellEls.get(e.key);
      if (!cell) {
        cell = document.createElement('div');
        cell.className = 'live-cell gauge-cell';
        cell.innerHTML = gaugeCellHTML(e.label);
        grid.appendChild(cell);
        cellEls.set(e.key, cell);
        keyOrder.push(e.key);
        added = true;
      }
      updateGauge(cell, e.label, e.unit ? `${e.value} ${e.unit}` : e.value);
    }
    if (added && pager) pager.relayout();
    meta.textContent = `live · ${cellEls.size} values`;
    if (logId && logColumns) {
      window.bmacw.appendLog(logId, [new Date().toISOString(), String(Date.now() - logStart),
        ...logColumns.map(k => merged.has(k) ? merged.get(k) : '')]);
    }
  }

  await tick();
  if (liveTok === _liveToken) scheduleLive(tick);
}

// generic result renderer: one card per result set, key/value rows
function renderResultSets(sets, container, job) {
  if (!sets || sets.length === 0) {
    container.innerHTML = `<div class="empty"><div>No results from ${esc(job)}.</div></div>`;
    return;
  }
  container.className = 'results-panel stagger';
  container.innerHTML = '';
  // skip set 0 (system summary) when real sets follow
  const real = dataSets(sets);
  real.forEach((set, idx) => {
    const card = document.createElement('div');
    card.className = 'result-card';
    const rows = Object.entries(set)
      .filter(([k]) => !k.startsWith('_'))
      .map(([k, v]) => `<div class="kv"><span class="kv-k">${esc(k)}</span><span class="kv-v">${esc(v)}</span></div>`)
      .join('');
    card.innerHTML = `${real.length > 1 ? `<div class="result-head">set ${idx + 1}</div>` : ''}${rows}`;
    container.appendChild(card);
  });
  stagger(container, 30);
}
