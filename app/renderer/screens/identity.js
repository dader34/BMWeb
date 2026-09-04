// Identity: INPA's "ID-data" card — the ECU's part number, versions, build date
// and references. Read-only, and read once rather than polled: none of it
// changes while the car sits there.
//
// The field order is INPA's own (decoded from the .IPO captions), which differs
// from the order the SGBD returns them in.

// The card's two layouts. Kept here rather than in CSS because the modes are
// not a restyling of one layout: INPA draws a colon-aligned monospace list, the
// way its own screen does ('BMWTeilenummer          :  '), while modern mode
// uses a labelled two-column grid.
function identRows(fields, vals) {
  const inpa = inpaMode();
  return fields
    .map((f) => {
      const raw = vals.get(f.key);
      const val = esc(deGerman(raw) || raw);
      // generated screens fall back to the SGBD's own German result description
      // when INPA has no caption for a field, so labels get translated too
      const label = esc(deGerman(f.label) || f.label);
      // a field the SGBD contributed but INPA's own screen does not show
      const extra = f.extra ? ' ident-extra' : '';
      return inpa
        ? `<div class="ident-line${extra}">` +
            `<span class="ident-lk">${label}</span>` +
            `<span class="ident-lc">:</span>` +
            `<span class="ident-lv">${val}</span></div>`
        : `<div class="ident-row${extra}">` +
            `<span class="ident-k">${label}</span>` +
            `<span class="ident-v">${val}</span></div>`;
    })
    .join('');
}

async function renderIdentity(ecu, ident, container, exit) {
  container.className = 'results-panel';
  container.innerHTML = `
    <div class="act-menu">
      <div class="act-menu-title">${esc(ident.title)}</div>
      <div class="act-menu-sub">${esc(ident.subtitle)}</div>
      <div class="ident-card" id="ident-card">
        <div class="empty"><span class="loader"></span><span>Reading ECU identity…</span></div>
      </div>
    </div>`;
  const card = container.querySelector('#ident-card');

  const acts = [
    {
      key: '1',
      keyLabel: 'F1',
      label: 'Re-read',
      fn: () => renderIdentity(ecu, ident, container, exit),
    },
  ];
  if (exit) acts.push(exit);
  setActions(acts);

  // one read per job, then lay the fields out in INPA's order.
  // A field may name a job ARGUMENT: INPA reads the same result once per pass
  // and labels each ("Data Block 0..6" from CODIERUNG_LESEN "0".."6"). Those
  // are read separately and stored under key+arg, or all seven rows would show
  // whatever the last pass returned.
  const vals = new Map();
  let anyOk = false,
    lastErr = null;
  const reads = [
    ...ident.jobs.map((j) => ({ job: j, arg: null })),
    ...ident.fields
      .filter((f) => f.arg != null && f.job)
      .map((f) => ({ job: f.job, arg: f.arg })),
  ];
  for (const { job, arg } of reads) {
    try {
      const q = arg == null ? '' : `?arg=${encodeURIComponent(arg)}`;
      const d = await api(`/api/ecu/${ecu.sgbd}/run/${job}${q}`, {
        method: 'POST',
      });
      flatResults(d.sets).forEach(([k, v]) =>
        vals.set(arg == null ? k : `${k} ${arg}`, v)
      );
      anyOk = true;
    } catch (e) {
      lastErr = e;
    } // a missing job shouldn't blank the card
  }

  if (!anyOk) {
    card.innerHTML = errorBlock(lastErr && lastErr.message);
    sbLeft.textContent = 'failed';
    return;
  }

  // a per-argument field looks its value up under the pass it was read in
  const shown = ident.fields
    .map((f) => (f.arg != null ? { ...f, key: `${f.key} ${f.arg}` } : f))
    .filter((f) => vals.has(f.key));
  card.innerHTML =
    identRows(shown, vals) ||
    `<div class="empty"><div>The ECU returned no identity data.</div></div>`;
  sbLeft.textContent = `${shown.length} fields`;
}
