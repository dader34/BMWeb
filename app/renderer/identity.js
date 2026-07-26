// Identity: INPA's "ID-data" card — the ECU's part number, versions, build date
// and references. Read-only, and read once rather than polled: none of it
// changes while the car sits there.
//
// The field order is INPA's own (decoded from the .IPO captions), which differs
// from the order the SGBD returns them in.

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

  const rows = ident.fields
    .filter(f => vals.has(f.key))
    .map(f => `<div class="ident-row">
                 <span class="ident-k">${esc(f.label)}</span>
                 <span class="ident-v">${esc(deGerman(vals.get(f.key)) || vals.get(f.key))}</span>
               </div>`)
    .join('');
  card.innerHTML = rows || `<div class="empty"><div>The ECU returned no identity data.</div></div>`;
  sbLeft.textContent = `${ident.fields.filter(f => vals.has(f.key)).length} fields`;
}
