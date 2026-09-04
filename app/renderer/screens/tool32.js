// Tool32: the raw SGBD job runner. INPA's screens are a curated frontend over
// EDIABAS; Tool32 is the opposite -- pick any SGBD, run any job it declares,
// and read the full result register set with no screen definition in between.
// It is the tool for the ECUs BMW never drew a UI for (ScreenCount=0), and for
// jobs INPA's layouts don't surface.
//
// Everything here rides endpoints that already exist and are already tested:
//   GET  /api/ecu/:sgbd/jobs            the job list
//   GET  /api/ecu/:sgbd/results/:JOB    the declared result registers
//   POST /api/ecu/:sgbd/run/:JOB?arg=   execute (BEST2 VM -> cable, or ?demo=1)
// so this file is a screen, not an engine.

// ecu-index.json keys ARE the runnable SGBDs (each maps to the chassis whose
// archive carries it). It's a STATIC FILE the webshim doesn't route (the shim
// only handles /api/ecu/…), so fetch it raw — via webRealFetch in the web
// build (bypassing the fetch override), or api() on desktop where it's a real
// route. In the web build an inlined index may also be present.
let TOOL32_SGBDS = null;
async function tool32SgbdList() {
  if (TOOL32_SGBDS) return TOOL32_SGBDS;
  const fromIndex = (idx) => {
    TOOL32_SGBDS = Object.keys(idx || {}).sort();
    return TOOL32_SGBDS;
  };
  // 1) inlined offline index, if the single-file export baked one in
  if (typeof BMACW_INLINE === 'object' && BMACW_INLINE && BMACW_INLINE._index) {
    return fromIndex(BMACW_INLINE._index);
  }
  // 2) the static file — raw fetch so the shim's /api catch-all doesn't 404 it
  const base = typeof WEB_BASE === 'string' ? WEB_BASE : '';
  const apiBase = typeof WEB_API_BASE === 'string' ? WEB_API_BASE : 'api';
  const real =
    typeof webRealFetch === 'function'
      ? webRealFetch
      : window.fetch.bind(window);
  for (const u of [
    `${base}/${apiBase}/ecu-index.json`,
    '/api/ecu-index.json',
  ]) {
    try {
      const r = await real(u);
      if (r && r.ok) return fromIndex(await r.json());
    } catch (e) {
      /* try next */
    }
  }
  // 3) desktop: it's a real server route
  try {
    return fromIndex(await api('/api/ecu-index.json'));
  } catch (e) {
    TOOL32_SGBDS = [];
    return TOOL32_SGBDS;
  }
}

// a job entry may arrive as a bare name or as {name, args, results, comment}
function tool32JobName(j) {
  return typeof j === 'string' ? j : (j && j.name) || '';
}

function showTool32() {
  lastScreen = showTool32;
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: 'Apps', fn: showApps },
    { label: 'Tool32' },
  ]);
  document.body.classList.add('apps-section');
  sbLeft.textContent = 'tool32';
  view.innerHTML = head(
    'EDIABAS',
    'Tool32',
    'Run any SGBD job directly against the ECU and read its raw results.'
  );
  setActions([
    {
      key: 'Escape',
      keyLabel: 'Esc',
      label: 'Back',
      kind: 'back',
      fn: () => {
        stopRepeat();
        showApps();
      },
    },
  ]);

  const card = document.createElement('div');
  card.className = 'etk-idcard t32-card';

  // three panes: SGBD list | job list | run panel (args + results)
  const cols = document.createElement('div');
  cols.className = 't32-cols';

  // -- SGBD pane (filterable, since there are ~380) ------------------------
  const sgbdCol = document.createElement('div');
  sgbdCol.className = 'etk-idcol t32-col';
  const sgbdFilter = document.createElement('input');
  sgbdFilter.className = 't32-filter';
  sgbdFilter.type = 'text';
  sgbdFilter.placeholder = 'Filter SGBD…';
  sgbdFilter.spellcheck = false;
  const sgbdBox = tool32ListBox();
  sgbdCol.append(labelSpan('SGBD'), sgbdFilter, sgbdBox);

  // -- job pane (filterable) ----------------------------------------------
  const jobCol = document.createElement('div');
  jobCol.className = 'etk-idcol t32-col';
  const jobFilter = document.createElement('input');
  jobFilter.className = 't32-filter';
  jobFilter.type = 'text';
  jobFilter.placeholder = 'Filter job…';
  jobFilter.spellcheck = false;
  jobFilter.disabled = true;
  const jobBox = tool32ListBox();
  jobCol.append(labelSpan('Job'), jobFilter, jobBox);

  // -- run pane -----------------------------------------------------------
  const runCol = document.createElement('div');
  runCol.className = 'etk-idcol t32-col t32-runcol';
  const runHead = document.createElement('div');
  runHead.className = 't32-runhead';
  runHead.textContent = 'Select an SGBD and a job.';
  // a column label so the run pane's top row lines up with the two filter
  // inputs on the left, instead of floating above them.
  const runLabel = labelSpan('Run');
  // Always shown (disabled until a job is picked) so its box lines up with the
  // two filter inputs on the left as the run column's first control row.
  const argRow = document.createElement('div');
  argRow.className = 't32-argrow';
  const argInput = document.createElement('input');
  argInput.className = 't32-arg';
  argInput.type = 'text';
  argInput.spellcheck = false;
  argInput.placeholder = 'argument (optional)';
  argInput.disabled = true;
  const runBtn = document.createElement('button');
  runBtn.type = 'button';
  runBtn.className = 'etk-vin-go t32-run';
  runBtn.textContent = 'Run';
  runBtn.disabled = true;
  argRow.append(argInput, runBtn);

  // -- TEST mode: repeat the job on an interval, watching the raw values
  //    change (EDIABAS ToolSet's Test menu). Off by default; when on, Run
  //    starts a loop and the button flips to Stop.
  const repRow = document.createElement('div');
  repRow.className = 't32-reprow';
  repRow.hidden = true;
  const repChk = document.createElement('input');
  repChk.type = 'checkbox';
  repChk.id = 't32-repeat';
  repChk.className = 't32-check';
  const repLbl = document.createElement('label');
  repLbl.htmlFor = 't32-repeat';
  repLbl.textContent = 'Repeat every';
  const repMs = document.createElement('input');
  repMs.type = 'number';
  repMs.className = 't32-repms';
  repMs.value = '500';
  repMs.min = '100';
  repMs.step = '100';
  const repUnit = document.createElement('span');
  repUnit.className = 't32-repunit';
  repUnit.textContent = 'ms';
  repRow.append(repChk, repLbl, repMs, repUnit);

  const out = document.createElement('div');
  out.className = 't32-out';

  // Order: label, then the arg row FIRST (so it lines up with the two filter
  // inputs on the left), then the job-name/status line, the repeat controls,
  // and the results. The trace is a full-width section BELOW the three columns
  // (Tool32's Trace window), built separately.
  runCol.append(runLabel, argRow, runHead, repRow, out);

  cols.append(sgbdCol, jobCol, runCol);
  card.append(cols);

  // ---- TRACE section (Tool32's Trace window) ----------------------------
  // EDIABAS writes two cumulative trace files while tracing is on: api.trc
  // (the job layer -- job, args, result sets, status) and ifh.trc (the wire
  // layer -- raw telegrams). This mirrors that: a persistent on/off toggle
  // (not per-run), a level switch between the two layers, a cumulative log
  // that grows across runs, Clear, and Export to a .trc-style text file.
  const trace = buildTraceSection();
  card.append(trace.el);
  view.appendChild(card);

  const state = { sgbds: [], jobs: [], sgbd: null, job: null };

  // ---- populate SGBD list -----------------------------------------------
  function paintSgbds() {
    const q = sgbdFilter.value.trim().toLowerCase();
    const items = state.sgbds
      .filter((s) => !q || s.includes(q))
      .map((s) => ({ key: s, label: s }));
    sgbdBox.setItems(items);
  }
  sgbdFilter.oninput = paintSgbds;

  sgbdBox.onpick = async (sgbd) => {
    stopRepeat();
    state.sgbd = sgbd;
    state.job = null;
    state.jobs = [];
    jobFilter.value = '';
    jobFilter.disabled = false;
    jobBox.setItems([]);
    jobBox.setLoading('Loading jobs…');
    runHead.textContent = `${sgbd}.prg · pick a job.`;
    argInput.disabled = true;
    argInput.value = '';
    runBtn.disabled = true;
    repRow.hidden = true;
    out.innerHTML = '';
    try {
      const jobs = await api(`/api/ecu/${sgbd}/jobs`);
      // jobs.json is either an array or the spec object {jobs:[...]}
      const list = Array.isArray(jobs) ? jobs : (jobs && jobs.jobs) || [];
      state.jobs = list
        .map((j) =>
          typeof j === 'string'
            ? { name: j }
            : {
                name: tool32JobName(j),
                args: j.args,
                results: j.results,
                comment: j.comment,
              }
        )
        .filter((j) => j.name)
        .sort((a, b) => a.name.localeCompare(b.name));
      paintJobs();
      if (!state.jobs.length) jobBox.setLoading('This SGBD declares no jobs.');
    } catch (e) {
      jobBox.setLoading(`Could not load jobs: ${e.message || e}`);
    }
  };

  // ---- job list ---------------------------------------------------------
  function paintJobs() {
    const q = jobFilter.value.trim().toLowerCase();
    const items = state.jobs
      .filter((j) => !q || j.name.toLowerCase().includes(q))
      .map((j) => {
        const write = typeof isWriteJob === 'function' && isWriteJob(j.name);
        return { key: j.name, label: j.name, write };
      });
    jobBox.setItems(items);
  }
  jobFilter.oninput = paintJobs;

  jobBox.onpick = async (name) => {
    stopRepeat();
    state.job = state.jobs.find((j) => j.name === name) || { name };
    const write = typeof isWriteJob === 'function' && isWriteJob(name);
    runHead.innerHTML =
      `<span class="t32-jobname">${esc(name)}</span>` +
      (write ? ` <span class="t32-writetag">writes ECU</span>` : '') +
      (state.job.comment
        ? `<span class="t32-comment">${esc(state.job.comment)}</span>`
        : '');
    argInput.disabled = false;
    runBtn.disabled = false;
    repRow.hidden = false;
    argInput.value = '';
    argInput.placeholder = 'argument (optional)';
    out.innerHTML = '';
    // fetch the declared arguments + results (present in every build via the
    // arguments/:JOB and results/:JOB routes, independent of the jobs array).
    const jobKey = name;
    try {
      const a = await api(
        `/api/ecu/${state.sgbd}/arguments/${encodeURIComponent(name)}`
      ).catch(() => null);
      if (jobKey !== state.job.name) return; // user moved on
      const argRows =
        a &&
        (Array.isArray(a.arguments) ? a.arguments : Array.isArray(a) ? a : []);
      if (argRows && argRows.length) {
        argInput.placeholder = `args: ${argRows.map((x) => x.ARG || x.name || x).join(', ')}`;
      }
    } catch (e) {
      /* no args declared */
    }
    try {
      const r = await api(
        `/api/ecu/${state.sgbd}/results/${encodeURIComponent(name)}`
      ).catch(() => null);
      if (jobKey !== state.job.name) return;
      renderResultSkeleton(r);
    } catch (e) {
      /* no results declared */
    }
  };

  // results/:JOB is either ["NAME : comment", ...] (web build) or
  // [{name, unit}, ...] (spec build); normalise to display rows.
  function renderResultSkeleton(results) {
    const rows = (Array.isArray(results) ? results : [])
      .map((r) => {
        if (typeof r === 'string') return { name: r.split(' : ')[0].trim() };
        return { name: r.name, unit: r.unit };
      })
      .filter((r) => r.name);
    if (!rows.length) {
      out.innerHTML = '';
      return;
    }
    out.innerHTML =
      `<div class="t32-outhead">declares ${rows.length} result` +
      `${rows.length === 1 ? '' : 's'}</div>` +
      `<table class="t32-table"><tbody>${rows
        .map(
          (r) =>
            `<tr class="t32-pending"><td class="t32-k">${esc(r.name)}` +
            `${r.unit ? ` <span class="t32-unit">[${esc(r.unit)}]</span>` : ''}</td>` +
            `<td class="t32-v">—</td></tr>`
        )
        .join('')}</tbody></table>`;
  }

  // ---- run --------------------------------------------------------------
  async function run() {
    if (!state.sgbd || !state.job) return;
    const name = state.job.name;
    const write = typeof isWriteJob === 'function' && isWriteJob(name);
    // THIS WARNING USED TO BE A LIE. It said writes were "blocked in this
    // build for safety" and offered "Run (will be refused)" -- text left over
    // from when webRunJob passed allowWrites:false. It does not: the route was
    // unblocked so actuator tests work, and Best2Vm defaults permissive
    // (allowWrites: opts.allowWrites !== false). STEUERN_DIGITAL really does
    // command the module, so telling the user it would harmlessly error was
    // the most dangerous thing this dialog could say.
    //
    // It also ignored the user's own setting. Tool32 is the raw job runner --
    // someone who turned actuator confirmations off has said what they want,
    // and the same rule the IR screens follow applies here.
    if (
      write &&
      (typeof confirmActuators !== 'function' || confirmActuators())
    ) {
      const okGo =
        typeof confirmDialog === 'function'
          ? await confirmDialog({
              title: `${name} changes the ECU`,
              body:
                'This job commands or changes the ECU rather than reading ' +
                'it, and Tool32 sends exactly what you type &mdash; no ' +
                'release-on-leave, no re-read. Make sure the module and ' +
                'anything it drives are safe to move.',
              confirmLabel: 'Run',
              danger: true,
            })
          : true;
      if (!okGo) return;
    }
    // REPEAT / TEST MODE. A write job never loops -- commanding an ECU on a
    // timer is exactly what you do NOT want -- so repeat is read-only.
    const repeat = repChk.checked && !write;
    if (repeat) {
      startRepeat(name);
      return;
    }
    await runOnce(name);
  }

  // One execution: run the job, render results, then refresh the trace view
  // (cumulative -- the trace grows across runs, like EDIABAS's .trc files).
  async function runOnce(name, quiet) {
    const arg = argInput.value.trim();
    if (!quiet) {
      runBtn.disabled = true;
      out.innerHTML =
        `<div class="t32-running"><span class="wiring-spinner"></span> ` +
        `running ${esc(name)}…</div>`;
    }
    try {
      const q = arg ? `?arg=${encodeURIComponent(arg)}` : '';
      const r = await api(
        `/api/ecu/${state.sgbd}/run/${encodeURIComponent(name)}${q}`,
        { method: 'POST' }
      );
      renderResults(r);
      trace.refresh();
      return true;
    } catch (e) {
      out.innerHTML = `<div class="t32-err">${esc(String(e.message || e))}</div>`;
      trace.refresh();
      return false;
    } finally {
      if (!quiet) runBtn.disabled = false;
    }
  }

  // The Test loop: fire runOnce on the chosen interval until stopped. The
  // button becomes Stop; leaving the screen (or picking another job) clears it.
  let repTimer = null;
  function stopRepeat() {
    if (repTimer) {
      clearInterval(repTimer);
      repTimer = null;
    }
    runBtn.textContent = 'Run';
    runBtn.classList.remove('t32-stop');
  }
  function startRepeat(name) {
    stopRepeat();
    const ms = Math.max(100, parseInt(repMs.value, 10) || 500);
    runBtn.textContent = 'Stop';
    runBtn.classList.add('t32-stop');
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return; // never overlap exchanges
      inFlight = true;
      const ok = await runOnce(name, true);
      inFlight = false;
      if (!ok) stopRepeat(); // a failed exchange ends the loop
    };
    tick();
    repTimer = setInterval(tick, ms);
  }

  runBtn.onclick = run;
  argInput.onkeydown = (e) => {
    if (e.key === 'Enter') run();
  };

  function renderResults(r) {
    const pairs = typeof flatResults === 'function' ? flatResults(r.sets) : [];
    const status = tool32Status(r.sets);
    // r.demo is set by the shim when the values were synthesized (no cable);
    // badge it so a fabricated set can never pass for a real read.
    const demo = r.demo || (typeof demoMode === 'function' && demoMode());
    const badge = demo ? `<span class="t32-demobadge">DEMO</span>` : '';
    if (!pairs.length) {
      out.innerHTML =
        `<div class="t32-outhead">${badge}` +
        `${status ? esc(status) : 'no result values'}</div>`;
      return;
    }
    out.innerHTML =
      `<div class="t32-outhead">${badge}${pairs.length} value` +
      `${pairs.length === 1 ? '' : 's'}${status ? ` · ${esc(status)}` : ''}</div>` +
      `<table class="t32-table${demo ? ' t32-demo' : ''}"><tbody>${pairs
        .map(
          ([k, v]) =>
            `<tr><td class="t32-k">${esc(k)}</td>` +
            `<td class="t32-v">${esc(String(v))}</td></tr>`
        )
        .join('')}</tbody></table>`;
  }

  // load the SGBD list
  (async () => {
    sgbdBox.setLoading('Loading SGBDs…');
    state.sgbds = await tool32SgbdList();
    if (!state.sgbds.length) {
      sgbdBox.setLoading('No ECU data in this build.');
      return;
    }
    paintSgbds();
  })();
}

// The Trace section: Tool32's Trace window. A persistent on/off toggle (starts
// both webshim recorders -- apiTrace for the job layer, busTrace for the wire
// layer), a layer switch, a cumulative merged log, Clear, and Export to a
// .trc-style text file. Returns { el, refresh }.
function buildTraceSection() {
  const el = document.createElement('div');
  el.className = 't32-tracesec';

  const bar = document.createElement('div');
  bar.className = 't32-tracebar';

  const title = document.createElement('span');
  title.className = 't32-tracetitle';
  title.textContent = 'Trace';

  // on/off toggle
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 't32-tracetoggle';

  // layer switch: a fully custom dropdown (the native <select> opens the OS
  // menu even when styled). Reuses the Lookup screen's lookupDropdown so it
  // matches the DTC app's chassis pickers.
  const LAYERS = [
    { val: 'both', label: 'API + Wire' },
    { val: 'api', label: 'API (job)' },
    { val: 'ifh', label: 'Wire (IFH)' },
  ];
  let layerVal = 'both';
  const layerDd =
    typeof lookupDropdown === 'function'
      ? lookupDropdown('API + Wire', LAYERS, 'both', (v) => {
          layerVal = v;
          refresh();
        })
      : null;
  // fallback to a native select only if the shared dropdown isn't loaded
  const layerSel = layerDd ? null : document.createElement('select');
  if (layerSel) {
    layerSel.className = 't32-select';
    LAYERS.forEach(({ val, label }) => {
      const o = document.createElement('option');
      o.value = val;
      o.textContent = label;
      layerSel.append(o);
    });
    layerSel.onchange = () => {
      layerVal = layerSel.value;
      refresh();
    };
  }
  const layerEl = layerDd ? layerDd.el : layerSel;
  layerEl.classList.add('t32-tracelayer');

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 't32-tracebtn';
  clearBtn.textContent = 'Clear';
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 't32-tracebtn';
  exportBtn.textContent = 'Export .trc';

  bar.append(title, toggle, layerEl, clearBtn, exportBtn);

  const log = document.createElement('div');
  log.className = 't32-tracelog';

  el.append(bar, log);

  const AT = () => (typeof window !== 'undefined' ? window.apiTrace : null);
  const BT = () => (typeof window !== 'undefined' ? window.busTrace : null);

  function isOn() {
    const a = AT();
    return !!(a && a.on);
  }
  function setToggle() {
    const on = isOn();
    toggle.textContent = on ? 'Tracing ON' : 'Tracing off';
    toggle.classList.toggle('on', on);
  }
  toggle.onclick = () => {
    const a = AT(),
      b = BT();
    if (isOn()) {
      if (a) a.stop();
      if (b) b.stop();
    } else {
      if (a) a.start();
      if (b) b.start();
    }
    setToggle();
    refresh();
  };
  clearBtn.onclick = () => {
    const a = AT(),
      b = BT();
    if (a) a.clear();
    if (b) {
      b.rows = [];
      b.recent = [];
    }
    refresh();
  };
  exportBtn.onclick = () => exportTrc(mergedRows());

  // Merge the two layers into one time-ordered list. api rows carry {job,...};
  // ifh rows carry {tag, hex}. The layer switch filters which show.
  function mergedRows() {
    const layer = layerVal;
    const a = AT(),
      b = BT();
    let rows = [];
    if (layer !== 'ifh' && a)
      rows = rows.concat(a.rows.map((r) => ({ ...r, _layer: 'api' })));
    if (layer !== 'api' && b) {
      // prefer the verbose buffer (only fills while tracing); fall back to the
      // always-on ring so something shows even before the toggle was flipped.
      const src = b.rows && b.rows.length ? b.rows : b.recent;
      rows = rows.concat((src || []).map((r) => ({ ...r, _layer: 'ifh' })));
    }
    rows.sort((x, y) => (x.t || 0) - (y.t || 0));
    return rows;
  }

  function refresh() {
    setToggle();
    const rows = mergedRows();
    if (!rows.length) {
      log.innerHTML = `<div class="t32-traceempty">${
        isOn()
          ? 'Tracing on. Run a job to record the API and wire layers.'
          : 'Turn tracing on, then run a job. The wire ring buffer also shows here.'
      }</div>`;
      return;
    }
    const t0 = rows[0].t || 0;
    log.innerHTML = rows
      .map((r) => {
        const ms = String((r.t || 0) - t0).padStart(5, ' ');
        if (r._layer === 'api') {
          const st = r.error ? `ERROR ${r.error}` : r.status || 'OKAY';
          const stcls = r.error
            ? 't32-terr'
            : /OKAY/i.test(st)
              ? 't32-rx'
              : 't32-tx';
          const nsets = r.sets
            ? `${r.sets.length} set${r.sets.length === 1 ? '' : 's'}`
            : '';
          return (
            `<div class="t32-trow t32-apirow">` +
            `<span class="t32-tms">${esc(ms)}</span>` +
            `<span class="t32-ttag t32-apitag">JOB</span>` +
            `<span class="t32-tapi">${esc(r.sgbd)}.${esc(r.job)}` +
            `${r.arg ? `(${esc(r.arg)})` : ''}${r.demo ? ' ·DEMO' : ''}</span>` +
            `<span class="t32-tnote ${stcls}">${esc(st)}${nsets ? ` · ${nsets}` : ''}</span></div>`
          );
        }
        // A real telegram: tx/rx, shown with its hex bytes.
        if (r.tag === 'tx' || r.tag === 'rx') {
          const cls = r.tag === 'tx' ? 't32-tx' : 't32-rx';
          const tag = r.tag === 'tx' ? '→' : '←';
          return (
            `<div class="t32-trow ${cls}">` +
            `<span class="t32-tms">${esc(ms)}</span>` +
            `<span class="t32-ttag">${tag}</span>` +
            `<span class="t32-thex">${esc(r.hex || '')}</span>` +
            `<span class="t32-tnote">${esc(r.note || '')}</span></div>`
          );
        }
        // A real error.
        if (r.tag === 'err') {
          return (
            `<div class="t32-trow t32-terr">` +
            `<span class="t32-tms">${esc(ms)}</span>` +
            `<span class="t32-ttag">!</span>` +
            `<span class="t32-thex">${esc(r.note || '')}</span></div>`
          );
        }
        // Everything else (kline wake, config, ws notes) is INFO, not an error:
        // one neutral row, just the note, no hex column and no red marker.
        return (
          `<div class="t32-trow t32-inforow">` +
          `<span class="t32-tms">${esc(ms)}</span>` +
          `<span class="t32-ttag t32-infotag">i</span>` +
          `<span class="t32-tinfo">${esc(r.note || '')}</span></div>`
        );
      })
      .join('');
    log.scrollTop = log.scrollHeight;
  }

  setToggle();
  refresh();
  return { el, refresh };
}

// Export the merged trace as a .trc-style text file, the way ToolSet saves
// api.trc / ifh.trc -- one line per entry, API and wire interleaved by time.
function exportTrc(rows) {
  if (!rows || !rows.length) return;
  const t0 = rows[0].t || 0;
  const lines = rows.map((r) => {
    const ms = String((r.t || 0) - t0).padStart(7, ' ');
    if (r._layer === 'api') {
      const st = r.error ? `ERROR ${r.error}` : r.status || 'OKAY';
      const nsets = r.sets ? ` sets=${r.sets.length}` : '';
      return (
        `${ms}  JOB  ${r.sgbd}.${r.job}${r.arg ? `(${r.arg})` : ''}` +
        `${r.demo ? ' [DEMO]' : ''}  -> ${st}${nsets}`
      );
    }
    if (r.tag === 'tx' || r.tag === 'rx') {
      const tag = r.tag === 'tx' ? 'SEND' : 'RECV';
      return `${ms}  ${tag} ${r.hex || ''}${r.note ? `   ; ${r.note}` : ''}`;
    }
    if (r.tag === 'err') return `${ms}  ERR  ${r.note || ''}`;
    return `${ms}  INFO ${r.note || ''}`; // kline wake, config, etc.
  });
  const header =
    `EDIABAS-style trace (BMWeb Tool32)\n` +
    `exported ${new Date().toISOString()}\n` +
    `${rows.length} entries\n${'-'.repeat(60)}\n`;
  const blob = new Blob([header + lines.join('\n') + '\n'], {
    type: 'text/plain',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `bmweb-trace-${new Date().toISOString().replace(/[:.]/g, '-')}.trc`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 0);
}

// JOB_STATUS lives in the first set; surface it as a one-line status
function tool32Status(sets) {
  const list = sets || [];
  const first = list[0] || {};
  return first.JOB_STATUS || first._STATUS || '';
}

// caption helper matching the ETK columns
function labelSpan(text) {
  const s = document.createElement('span');
  s.className = 'etk-idlabel';
  s.textContent = text;
  return s;
}

// a scrolling single-select list box with a loading/empty message and an
// optional per-row "write" marker. Mirrors etk.js's listBox but standalone so
// Tool32 doesn't depend on the ETK screen being loaded.
// Tool32's list box: the shared control (ui/listbox.js) with the write-job
// marker (a "W" badge on items flagged write:true) and the t32-lb skin class.
function tool32ListBox() {
  return makeListBox({ extraClass: 't32-lb', writeTag: true });
}
