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
  const fromIndex = (idx) => { TOOL32_SGBDS = Object.keys(idx || {}).sort(); return TOOL32_SGBDS; };
  // 1) inlined offline index, if the single-file export baked one in
  if (typeof BMACW_INLINE === 'object' && BMACW_INLINE && BMACW_INLINE._index) {
    return fromIndex(BMACW_INLINE._index);
  }
  // 2) the static file — raw fetch so the shim's /api catch-all doesn't 404 it
  const base = (typeof WEB_BASE === 'string') ? WEB_BASE : '';
  const apiBase = (typeof WEB_API_BASE === 'string') ? WEB_API_BASE : 'api';
  const real = (typeof webRealFetch === 'function') ? webRealFetch : window.fetch.bind(window);
  for (const u of [`${base}/${apiBase}/ecu-index.json`, '/api/ecu-index.json']) {
    try {
      const r = await real(u);
      if (r && r.ok) return fromIndex(await r.json());
    } catch (e) { /* try next */ }
  }
  // 3) desktop: it's a real server route
  try { return fromIndex(await api('/api/ecu-index.json')); }
  catch (e) { TOOL32_SGBDS = []; return TOOL32_SGBDS; }
}

// a job entry may arrive as a bare name or as {name, args, results, comment}
function tool32JobName(j) { return typeof j === 'string' ? j : (j && j.name) || ''; }

function showTool32() {
  lastScreen = showTool32;
  setCrumbs([{ label: 'Vehicles', fn: showChassis },
             { label: 'Apps', fn: showApps },
             { label: 'Tool32' }]);
  document.body.classList.add('apps-section');
  sbLeft.textContent = 'tool32';
  view.innerHTML = head('EDIABAS', 'Tool32',
    'Run any SGBD job directly against the ECU and read its raw results.');
  setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: showApps }]);

  const card = document.createElement('div');
  card.className = 'etk-idcard t32-card';

  // three panes: SGBD list | job list | run panel (args + results)
  const cols = document.createElement('div');
  cols.className = 't32-cols';

  // -- SGBD pane (filterable, since there are ~380) ------------------------
  const sgbdCol = document.createElement('div');
  sgbdCol.className = 'etk-idcol t32-col';
  const sgbdFilter = document.createElement('input');
  sgbdFilter.className = 't32-filter'; sgbdFilter.type = 'text';
  sgbdFilter.placeholder = 'Filter SGBD…'; sgbdFilter.spellcheck = false;
  const sgbdBox = tool32ListBox();
  sgbdCol.append(labelSpan('SGBD'), sgbdFilter, sgbdBox);

  // -- job pane (filterable) ----------------------------------------------
  const jobCol = document.createElement('div');
  jobCol.className = 'etk-idcol t32-col';
  const jobFilter = document.createElement('input');
  jobFilter.className = 't32-filter'; jobFilter.type = 'text';
  jobFilter.placeholder = 'Filter job…'; jobFilter.spellcheck = false; jobFilter.disabled = true;
  const jobBox = tool32ListBox();
  jobCol.append(labelSpan('Job'), jobFilter, jobBox);

  // -- run pane -----------------------------------------------------------
  const runCol = document.createElement('div');
  runCol.className = 'etk-idcol t32-col t32-runcol';
  const runHead = document.createElement('div');
  runHead.className = 't32-runhead';
  runHead.textContent = 'Select an SGBD and a job.';
  const argRow = document.createElement('div');
  argRow.className = 't32-argrow'; argRow.hidden = true;
  const argInput = document.createElement('input');
  argInput.className = 't32-arg'; argInput.type = 'text'; argInput.spellcheck = false;
  argInput.placeholder = 'argument (optional)';
  const runBtn = document.createElement('button');
  runBtn.type = 'button'; runBtn.className = 'etk-vin-go t32-run'; runBtn.textContent = 'Run';
  runBtn.disabled = true;
  argRow.append(argInput, runBtn);
  const out = document.createElement('div');
  out.className = 't32-out';
  runCol.append(runHead, argRow, out);

  cols.append(sgbdCol, jobCol, runCol);
  card.append(cols);
  view.appendChild(card);

  const state = { sgbds: [], jobs: [], sgbd: null, job: null };

  // ---- populate SGBD list -----------------------------------------------
  function paintSgbds() {
    const q = sgbdFilter.value.trim().toLowerCase();
    const items = state.sgbds
      .filter(s => !q || s.includes(q))
      .map(s => ({ key: s, label: s }));
    sgbdBox.setItems(items);
  }
  sgbdFilter.oninput = paintSgbds;

  sgbdBox.onpick = async (sgbd) => {
    state.sgbd = sgbd; state.job = null; state.jobs = [];
    jobFilter.value = ''; jobFilter.disabled = false;
    jobBox.setItems([]); jobBox.setLoading('Loading jobs…');
    runHead.textContent = `${sgbd}.prg — pick a job.`;
    argRow.hidden = true; runBtn.disabled = true; out.innerHTML = '';
    try {
      const jobs = await api(`/api/ecu/${sgbd}/jobs`);
      // jobs.json is either an array or the spec object {jobs:[...]}
      const list = Array.isArray(jobs) ? jobs : (jobs && jobs.jobs) || [];
      state.jobs = list.map(j => (typeof j === 'string'
        ? { name: j } : { name: tool32JobName(j), args: j.args, results: j.results,
                          comment: j.comment }))
        .filter(j => j.name)
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
      .filter(j => !q || j.name.toLowerCase().includes(q))
      .map(j => {
        const write = typeof isWriteJob === 'function' && isWriteJob(j.name);
        return { key: j.name, label: j.name, write };
      });
    jobBox.setItems(items);
  }
  jobFilter.oninput = paintJobs;

  jobBox.onpick = async (name) => {
    state.job = state.jobs.find(j => j.name === name) || { name };
    const write = typeof isWriteJob === 'function' && isWriteJob(name);
    runHead.innerHTML = `<span class="t32-jobname">${esc(name)}</span>`
      + (write ? ` <span class="t32-writetag">writes ECU</span>` : '')
      + (state.job.comment ? `<span class="t32-comment">${esc(state.job.comment)}</span>` : '');
    argRow.hidden = false; runBtn.disabled = false;
    argInput.value = ''; argInput.placeholder = 'argument (optional)';
    out.innerHTML = '';
    // fetch the declared arguments + results (present in every build via the
    // arguments/:JOB and results/:JOB routes, independent of the jobs array).
    const jobKey = name;
    try {
      const a = await api(`/api/ecu/${state.sgbd}/arguments/${encodeURIComponent(name)}`)
        .catch(() => null);
      if (jobKey !== state.job.name) return;   // user moved on
      const argRows = a && (Array.isArray(a.arguments) ? a.arguments : (Array.isArray(a) ? a : []));
      if (argRows && argRows.length) {
        argInput.placeholder = `args: ${argRows.map(x => x.ARG || x.name || x).join(', ')}`;
      }
    } catch (e) { /* no args declared */ }
    try {
      const r = await api(`/api/ecu/${state.sgbd}/results/${encodeURIComponent(name)}`)
        .catch(() => null);
      if (jobKey !== state.job.name) return;
      renderResultSkeleton(r);
    } catch (e) { /* no results declared */ }
  };

  // results/:JOB is either ["NAME : comment", ...] (web build) or
  // [{name, unit}, ...] (spec build); normalise to display rows.
  function renderResultSkeleton(results) {
    const rows = (Array.isArray(results) ? results : []).map(r => {
      if (typeof r === 'string') return { name: r.split(' : ')[0].trim() };
      return { name: r.name, unit: r.unit };
    }).filter(r => r.name);
    if (!rows.length) { out.innerHTML = ''; return; }
    out.innerHTML = `<div class="t32-outhead">declares ${rows.length} result`
      + `${rows.length === 1 ? '' : 's'}</div>`
      + `<table class="t32-table"><tbody>${rows.map(r =>
          `<tr class="t32-pending"><td class="t32-k">${esc(r.name)}`
          + `${r.unit ? ` <span class="t32-unit">[${esc(r.unit)}]</span>` : ''}</td>`
          + `<td class="t32-v">—</td></tr>`).join('')}</tbody></table>`;
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
    if (write && (typeof confirmActuators !== 'function' || confirmActuators())) {
      const okGo = typeof confirmDialog === 'function'
        ? await confirmDialog({
            title: `${name} changes the ECU`,
            body: 'This job commands or changes the ECU rather than reading '
                + 'it, and Tool32 sends exactly what you type &mdash; no '
                + 'release-on-leave, no re-read. Make sure the module and '
                + 'anything it drives are safe to move.',
            confirmLabel: 'Run', danger: true })
        : true;
      if (!okGo) return;
    }
    const arg = argInput.value.trim();
    runBtn.disabled = true;
    out.innerHTML = `<div class="t32-running"><span class="wiring-spinner"></span> `
      + `running ${esc(name)}…</div>`;
    try {
      const q = arg ? `?arg=${encodeURIComponent(arg)}` : '';
      const r = await api(`/api/ecu/${state.sgbd}/run/${encodeURIComponent(name)}${q}`,
                          { method: 'POST' });
      renderResults(r);
    } catch (e) {
      out.innerHTML = `<div class="t32-err">${esc(String(e.message || e))}</div>`;
    } finally {
      runBtn.disabled = false;
    }
  }
  runBtn.onclick = run;
  argInput.onkeydown = (e) => { if (e.key === 'Enter') run(); };

  function renderResults(r) {
    const pairs = typeof flatResults === 'function' ? flatResults(r.sets) : [];
    const status = tool32Status(r.sets);
    // r.demo is set by the shim when the values were synthesized (no cable);
    // badge it so a fabricated set can never pass for a real read.
    const demo = r.demo || (typeof demoMode === 'function' && demoMode());
    const badge = demo ? `<span class="t32-demobadge">DEMO</span>` : '';
    if (!pairs.length) {
      out.innerHTML = `<div class="t32-outhead">${badge}`
        + `${status ? esc(status) : 'no result values'}</div>`;
      return;
    }
    out.innerHTML = `<div class="t32-outhead">${badge}${pairs.length} value`
      + `${pairs.length === 1 ? '' : 's'}${status ? ` · ${esc(status)}` : ''}</div>`
      + `<table class="t32-table${demo ? ' t32-demo' : ''}"><tbody>${pairs.map(([k, v]) =>
          `<tr><td class="t32-k">${esc(k)}</td>`
          + `<td class="t32-v">${esc(String(v))}</td></tr>`).join('')}</tbody></table>`;
  }

  // load the SGBD list
  (async () => {
    sgbdBox.setLoading('Loading SGBDs…');
    state.sgbds = await tool32SgbdList();
    if (!state.sgbds.length) { sgbdBox.setLoading('No ECU data in this build.'); return; }
    paintSgbds();
  })();
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
  s.className = 'etk-idlabel'; s.textContent = text; return s;
}

// a scrolling single-select list box with a loading/empty message and an
// optional per-row "write" marker. Mirrors etk.js's listBox but standalone so
// Tool32 doesn't depend on the ETK screen being loaded.
function tool32ListBox() {
  const box = document.createElement('div');
  box.className = 'etk-lb t32-lb';
  let items = [], value = -1;
  box.onpick = null;
  function render() {
    box.innerHTML = '';
    if (!items.length) {
      const e = document.createElement('div');
      e.className = 'etk-lb-empty'; e.textContent = box._msg || '—';
      box.appendChild(e); return;
    }
    items.forEach((it, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'etk-lb-row' + (i === value ? ' active' : '')
        + (it.write ? ' t32-row-write' : '');
      row.textContent = it.label;
      if (it.write) {
        const tag = document.createElement('span');
        tag.className = 't32-rowtag'; tag.textContent = 'W';
        row.appendChild(tag);
      }
      row.onclick = () => {
        value = i; render();
        row.scrollIntoView({ block: 'nearest' });
        if (box.onpick) box.onpick(items[i].key, items[i].label);
      };
      box.appendChild(row);
    });
  }
  box.setItems = (arr) => { items = arr; value = -1; box._msg = null; render(); };
  box.setLoading = (msg) => { items = []; value = -1; box._msg = msg; render(); };
  render();
  return box;
}
