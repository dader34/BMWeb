// Identity: INPA's "ID-data" card — the ECU's part number, versions, build date
// and references. Read-only, and read once rather than polled: none of it
// changes while the car sits there.
//
// The field order is INPA's own (decoded from the .IPO captions), which differs
// from the order the SGBD returns them in.

// The card's two layouts, shared by every read-only field screen (ID-data, AIF,
// the Service reads). Kept here rather than in CSS because the modes are not a
// restyling of one layout: INPA draws a colon-aligned monospace list, the way
// its own screen does ('BMWTeilenummer          :  '), while modern mode uses a
// labelled two-column grid. Auto-generated screens get both for free.
function identRows(fields, vals) {
  const inpa = inpaMode();
  return fields.map(f => {
    const raw = vals.get(f.key);
    const val = esc(deGerman(raw) || raw);
    // a field the SGBD contributed but INPA's own screen does not show
    const extra = f.extra ? ' ident-extra' : '';
    return inpa
      ? `<div class="ident-line${extra}">`
        + `<span class="ident-lk">${esc(f.label)}</span>`
        + `<span class="ident-lc">:</span>`
        + `<span class="ident-lv">${val}</span></div>`
      : `<div class="ident-row${extra}">`
        + `<span class="ident-k">${esc(f.label)}</span>`
        + `<span class="ident-v">${val}</span></div>`;
  }).join('');
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

  const acts = [{ key: '1', keyLabel: 'F1', label: 'Re-read',
                  fn: () => renderIdentity(ecu, ident, container, exit) }];
  if (exit) acts.push(exit);
  setActions(acts);

  // one read per job, then lay the fields out in INPA's order
  const vals = new Map();
  let anyOk = false, lastErr = null;
  for (const job of ident.jobs) {
    try {
      const d = await api(`/api/ecu/${ecu.sgbd}/run/${job}`, { method: 'POST' });
      flatResults(d.sets).forEach(([k, v]) => vals.set(k, v));
      anyOk = true;
    } catch (e) { lastErr = e; }   // a missing job shouldn't blank the card
  }

  if (!anyOk) {
    card.innerHTML = errorBlock(lastErr && lastErr.message);
    sbLeft.textContent = 'failed';
    return;
  }

  const shown = ident.fields.filter(f => vals.has(f.key));
  card.innerHTML = identRows(shown, vals)
    || `<div class="empty"><div>The ECU returned no identity data.</div></div>`;
  sbLeft.textContent = `${shown.length} fields`;
}
