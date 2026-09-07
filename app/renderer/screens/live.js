// raw job runner: argument dialogs, runJob, generic result cards
const JOB_ARGS = {
  MESSWERTBLOCK_LESEN: {
    prompt: 'Measurement IDs, comma-separated (e.g. 0x4300,0x4301)',
    placeholder: '0x4300,0x4301',
  },
  SPEICHER_LESEN_ASCII: {
    prompt: 'Memory area (e.g. LAR;0x...)',
    placeholder: 'LAR;0x0000',
  },
  C_FG_LESEN: { fixed: ';0' },
  AIF_LESEN: { fixed: '0' },
  IDENT_AIF: { fixed: '0' },
  DIAGNOSE_MODE: { fixed: 'DEFAULT' },
  FS_SPERREN: {
    prompt: 'Lock fault memory? JA (yes) / NEIN (no)',
    placeholder: 'NEIN',
  },
  DIAGNOSEPROTOKOLL_SETZEN: { fixed: 'BMW-FAST' },
  CBS_RESET: {
    prompt: 'CBS service to reset (br_h=brake fluid, oel=oil, mik=microfilter)',
    placeholder: 'oel',
    suffix: ';100;1;0;0;0x8000;1;0;0',
  },
};

// text-input modal -> Promise<string|null>
function promptDialog({ title, body, placeholder = '', value = '' }) {
  return new Promise((resolve) => {
    const { overlay, close } = openModal(
      `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title">${title}</div>
        <div class="modal-body">${body}</div>
        <input class="modal-input" type="text" placeholder="${esc(placeholder)}" value="${esc(value)}" />
        <div class="modal-actions">
          <button class="btn modal-cancel">Cancel<span class="modal-key">Esc</span></button>
          <button class="btn primary modal-confirm">Run<span class="modal-key">⏎</span></button>
        </div>
      </div>`,
      {
        onClose: resolve,
        backdropValue: null,
        onKey: (e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            close(null);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            close(input.value.trim() || null);
          }
        },
      }
    );
    const input = overlay.querySelector('.modal-input');
    overlay.querySelector('.modal-cancel').onclick = () => close(null);
    overlay.querySelector('.modal-confirm').onclick = () =>
      close(input.value.trim() || null);
    setTimeout(() => input.focus(), 50);
  });
}

// fetch a job's declared _ARGUMENTS from the SGBD; [] if none / on error.
async function fetchJobArgs(ecu, job) {
  try {
    const d = await api(
      `/api/ecu/${ecu.sgbd}/arguments/${encodeURIComponent(job)}`
    );
    const specs = (d.arguments || []).filter((a) => a.ARG); // header row has no ARG
    // an arg documented "table BITS NAME TEXT" draws its values from that SGBD
    // table (NAME to send, TEXT the label)
    await Promise.all(
      specs.map(async (a) => {
        const ref = Object.keys(a)
          .filter((k) => /^ARGCOMMENT\d+$/.test(k))
          .map((k) => /\btable\s+(\w+)\s+(\w+)\s+(\w+)/i.exec(a[k] || ''))
          .find(Boolean);
        if (!ref) return;
        try {
          const rows = await api(
            `/api/ecu/${ecu.sgbd}/table/${encodeURIComponent(ref[1])}`
          );
          a._options = rows
            .map((r) => ({ value: r[ref[2]], label: r[ref[3]] || r[ref[2]] }))
            .filter((o) => o.value);
        } catch {
          /* table unreadable: fall back to a free-text field */
        }
      })
    );
    return specs;
  } catch {
    return [];
  }
}

// group table-backed options by the first word of their label (INPA's Activate
// layout). Groups of one collapse into an "Other" bucket.
function optGroupHtml(options, tr) {
  const groups = new Map();
  options.forEach((o) => {
    const label = tr(o.label) || o.value;
    const key = String(label).split(/[\s\-,/]+/)[0] || 'Other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...o, label });
  });
  const big = [...groups.entries()].filter(([, v]) => v.length > 1);
  const small = [...groups.entries()]
    .filter(([, v]) => v.length === 1)
    .flatMap(([, v]) => v);
  const opt = (o) =>
    `<option value="${esc(o.value)}">` +
    `${esc(o.label)} (${esc(o.value)})</option>`;
  const parts = big
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(
      ([name, items]) =>
        `<optgroup label="${esc(name)}">${items.map(opt).join('')}</optgroup>`
    );
  if (small.length) {
    parts.push(
      `<optgroup label="Other">` +
        small
          .sort((a, b) => a.label.localeCompare(b.label))
          .map(opt)
          .join('') +
        `</optgroup>`
    );
  }
  return parts.join('');
}

// multi-field argument dialog built from the _ARGUMENTS schema. resolves to the
// ';'-joined arg string EDIABAS expects, or null if cancelled.
function argsDialog(job, argSpecs) {
  return new Promise((resolve) => {
    const tr = (s) =>
      (typeof phraseText === 'function' ? phraseText(s) : s) || s; // argument comments
    const fieldHtml = argSpecs
      .map((a, i) => {
        const hint = tr((a.ARGCOMMENT0 || '').replace(/^'|'$/g, ''));
        // enumerated values: ARGCOMMENT0/1/2 each a quoted token
        const enumVals = Object.keys(a)
          .filter((k) => /^ARGCOMMENT\d+$/.test(k))
          .map((k) => a[k])
          .filter((v) => /^'.*'$/.test(v))
          .map((v) => v.replace(/^'|'$/g, ''));
        // a value the SGBD spelled out in a table beats guessing from comments
        const tableOpts = a._options || [];
        const isEnum =
          tableOpts.length > 0 ||
          (enumVals.length >= 2 && a.ARGTYPE === 'string');
        const isBinary = a.ARGTYPE === 'binary';
        const argName = tr(humanizeKey(a.ARG));
        const label = `${esc(argName)} <span class="arg-type">(${esc(a.ARGTYPE || 'string')})</span>`;
        let note =
          !isEnum && hint ? `<div class="arg-hint">${esc(hint)}</div>` : '';
        if (isBinary)
          note += `<div class="arg-warn">Binary argument: enter raw hex (e.g. <span class="mono">01 00 0A ...</span>). Must be a valid pre-built buffer for this job, or it may fail or harm the ECU.</div>`;
        const placeholder = isBinary
          ? 'hex bytes, e.g. 01 00 0A'
          : a.ARGTYPE === 'int'
            ? '0'
            : '';
        const optHtml = tableOpts.length
          ? optGroupHtml(tableOpts, tr)
          : enumVals.map((v) => `<option>${esc(v)}</option>`).join('');
        const field = isEnum
          ? `<select class="modal-input arg-field" data-i="${i}">${optHtml}</select>`
          : `<input class="modal-input arg-field" data-i="${i}" data-binary="${isBinary ? 1 : 0}" type="text" placeholder="${placeholder}" />`;
        return `<div class="arg-row"><label class="arg-label">${label}</label>${field}${note}</div>`;
      })
      .join('');
    const { overlay, close } = openModal(
      `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title">${esc(jobLabel(job))}</div>
        <div class="modal-body">This job needs ${argSpecs.length} argument${argSpecs.length === 1 ? '' : 's'}.</div>
        <div class="arg-fields">${fieldHtml}</div>
        <div class="modal-actions">
          <button class="btn modal-cancel">Cancel<span class="modal-key">Esc</span></button>
          <button class="btn primary modal-confirm">Run<span class="modal-key">⏎</span></button>
        </div>
      </div>`,
      {
        onClose: resolve,
        backdropValue: null,
        onKey: (e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            close(null);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            close(collect());
          }
        },
      }
    );
    const fields = [...overlay.querySelectorAll('.arg-field')];
    const collect = () =>
      fields
        .map((f) => {
          let v = f.value.trim();
          // binary args: normalize hex to the "0xAABBCC" form EDIABAS accepts
          if (f.dataset.binary === '1' && v) {
            const hex = v.replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '');
            v = hex ? '0x' + hex.toUpperCase() : '';
          }
          return v;
        })
        .join(';');
    overlay.querySelector('.modal-cancel').onclick = () => close(null);
    overlay.querySelector('.modal-confirm').onclick = () => close(collect());
    setTimeout(() => fields[0] && fields[0].focus(), 50);
  });
}

// The ECU's second fault store: shadow memory survives a clear of the main
// memory, so it's what's still there after someone clears codes before a sale.
// Three job names for the one thing (a single-name search misses most):
// FS_SHADOW_LESEN, FS_LESEN_SHADOW (newer DDEs), READ_SHADOW (E65 tailgate).
// Decodes to the same F_* results as a normal read, so renderFaults handles it.
const SHADOW_JOB_RE = /^(FS_SHADOW_LESEN|FS_LESEN_SHADOW|READ_SHADOW)$/i;
const isShadowJob = (job) => SHADOW_JOB_RE.test(String(job || ''));

// run a job and render its result sets. FS_LESEN gets the fault-card view, others
// a generic key/value table.
async function runJob(ecu, job, container, danger, presetArg) {
  if (job === 'FS_LESEN' || job === 'FS_LESEN_DETAIL' || isShadowJob(job)) {
    loadFaultDb(); // warm the name db
  }
  // hand-tuned JOB_ARGS overrides win (they encode specials like CBS_RESET's
  // tail); otherwise ask the SGBD.
  let arg = presetArg;
  const spec = JOB_ARGS[job];
  if (arg == null && spec) {
    if (spec.fixed != null) arg = spec.fixed;
    else if (spec.prompt) {
      arg = await promptDialog({
        title: esc(jobLabel(job)),
        body: spec.prompt,
        placeholder: spec.placeholder || '',
      });
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
    // describe what the job actually does — not everything flagged is a write
    // (a flash-session read is cautioned for disrupting a sequence, not writing).
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
    else effect = `runs a protected function on <b>${esc(ecu.label)}</b>.`;
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
    // variant (see server LoadForJob). isShadowJob too: READ_SHADOW is a fault
    // read but does not start FS_, so it needs the same routing.
    if (ecu.group && (/^FS_/.test(job) || isShadowJob(job))) {
      q += `${q ? '&' : '?'}group=${encodeURIComponent(ecu.group)}`;
    }
    const data = await api(`/api/ecu/${ecu.sgbd}/run/${job}${q}`, {
      method: 'POST',
    });
    if (job === 'FS_LESEN' || job === 'FS_LESEN_DETAIL' || isShadowJob(job)) {
      const codes = dataSets(data.sets); // minus EDIABAS's system set, if present
      await loadFaultDb(); // names resolve synchronously in the render
      renderFaults(codes, container, ecu);
      // say WHICH store: a shadow read showing 0 is a different statement from
      // the main memory showing 0, easy to confuse once the cards look identical.
      sbLeft.textContent = isShadowJob(job)
        ? `shadow memory · ${codes.length} entr${codes.length === 1 ? 'y' : 'ies'}`
        : `${codes.length} fault(s)`;
    } else if (job === 'FS_LOESCHEN') {
      // INPA re-reads after a clear; do the same, so a fault that re-set
      // immediately shows instead of hiding behind "cleared".
      container.innerHTML = `<div class="empty"><span class="loader"></span><span>Cleared · re-reading…</span></div>`;
      try {
        const rq = ecu.group ? `?group=${encodeURIComponent(ecu.group)}` : '';
        const rr = await api(`/api/ecu/${ecu.sgbd}/run/FS_LESEN${rq}`, {
          method: 'POST',
        });
        const codes = dataSets(rr.sets);
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

// a screen change stops whatever polling loop was running; the live .IPO
// runtime owns its own cycle now, so this only has a timer left to clear
let liveTimer = null;
let _liveToken = 0;
function stopLive() {
  _liveToken++;
  if (liveTimer) {
    clearTimeout(liveTimer);
    liveTimer = null;
  }
}

// CSV logging handle from the main process
let logId = null;
function stopLogging() {
  if (logId && window.bmacw) window.bmacw.stopLog(logId);
  logId = null;
}

// generic result renderer: one card per result set, key/value rows
function renderResultSets(sets, container, job) {
  if (!sets || sets.length === 0) {
    container.innerHTML = `<div class="empty"><div>No results from ${esc(job)}.</div></div>`;
    return;
  }
  container.className = 'results-panel stagger';
  container.innerHTML = '';
  const real = dataSets(sets); // skip set 0 (system summary)
  real.forEach((set, idx) => {
    const card = document.createElement('div');
    card.className = 'result-card';
    const rows = Object.entries(set)
      .filter(([k]) => !k.startsWith('_'))
      .map(
        ([k, v]) =>
          `<div class="kv"><span class="kv-k">${esc(k)}</span><span class="kv-v">${esc(v)}</span></div>`
      )
      .join('');
    card.innerHTML = `${real.length > 1 ? `<div class="result-head">set ${idx + 1}</div>` : ''}${rows}`;
    container.appendChild(card);
  });
  stagger(container, 30);
}
