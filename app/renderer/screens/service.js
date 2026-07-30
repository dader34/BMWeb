// Service: CBS data, inspection stamp, diagnostic protocol, ECU commands.
//
// Unlike the other sections, this screen has no INPA original — INPA's MS45
// root menu has no Service key, and most of these jobs its frontend never
// touches. The layout follows the INPA screens it sits beside, but it is
// assembled from the SGBD's schemas rather than replicated from bytecode.
//
// Reads are safe and shown inline. Commands return only JOB_STATUS and do
// something to the car (reboot the DME, put it to sleep, re-sync the
// immobilizer), so each one confirms and says what it will do.

// a CBS availability of 100% is a fresh item, 0% is due now
const cbsPercent = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
};

function renderService(ecu, service, container, exit) {
  const inpa = inpaMode();
  const reopen = () => renderService(ecu, service, container, exit);

  container.className = 'results-panel';
  container.innerHTML = inpa
    ? `<div class="act-menu">
         <div class="act-menu-title">${esc(service.title)}</div>
         <div class="act-menu-sub">${esc(service.subtitle)}</div>
         <div class="act-key-list" id="svc-list"></div>
       </div>`
    : `<div class="act-menu">
         <div class="group-grid stagger" id="svc-list"></div>
       </div>`;
  const list = container.querySelector('#svc-list');

  const entries = [
    ...service.reads.map(r => ({ ...r, kind: 'read' })),
    ...service.commands.map(c => ({ ...c, kind: 'command' })),
  ];

  // a command is a write, so it always asks first and names what it does
  const runServiceCommand = async (e) => {
    const ok = await confirmDialog({
      title: `${esc(e.title)}?`,
      body: `Runs <span class="mono">${esc(e.job)}</span> on <b>${esc(ecu.label)}</b>.`
          + `<br><br>${esc(e.warn)}`,
      confirmLabel: e.title, danger: true,
    });
    if (!ok) { sbLeft.textContent = 'cancelled'; return; }
    try {
      await api(`/api/ecu/${ecu.sgbd}/run/${e.job}`, { method: 'POST' });
      sbLeft.textContent = `${e.job} · sent`;
    } catch (err) {
      sbLeft.textContent = 'failed';
      confirmDialog({ title: `${e.title} failed`, body: esc(err.message),
                      confirmLabel: 'OK', cancelLabel: 'Close' });
    }
  };

  const open = (e) => (e.kind === 'read' ? showServiceRead(ecu, e, container, reopen)
                                         : runServiceCommand(e));

  entries.forEach((e, i) => {
    if (inpa) {
      const row = document.createElement('button');
      row.className = 'inpa-fn act-key-row' + (e.kind === 'command' ? ' danger' : '');
      row.innerHTML = `<span class="inpa-fn-key">&lt; F${i + 1} &gt;</span>`
        + `<span class="inpa-fn-label">${esc(e.title)}</span>`
        + `<span class="act-key-val">${esc(e.caption)}</span>`;
      row.onclick = () => open(e);
      list.appendChild(row);
      return;
    }
    const tile = document.createElement('div');
    tile.className = 'group-tile' + (e.kind === 'command' ? ' danger' : '');
    tile.innerHTML = `
      <div class="group-name">${esc(e.title)}</div>
      <div class="group-count">${esc(e.caption)}</div>
      <div class="group-arrow">→</div>`;
    tile.onclick = () => open(e);
    list.appendChild(tile);
  });
  if (!inpa) stagger(list, 40);

  const acts = entries.slice(0, 9).map((e, i) => ({
    key: String(i + 1), keyLabel: `F${i + 1}`, label: e.title,
    kind: e.kind === 'command' ? 'danger' : undefined, fn: () => open(e),
  }));
  if (exit) acts.push(exit);
  setActions(acts);
  sbLeft.textContent = `${service.reads.length} reads · ${service.commands.length} commands`;
}

// one read job's results, laid out like the Ident card
async function showServiceRead(ecu, spec, container, onBack) {
  container.className = 'results-panel';
  container.innerHTML = `
    <div class="act-menu">
      <div class="act-menu-title">${esc(spec.title)}</div>
      <div class="act-menu-sub">${esc(spec.caption)}</div>
      <div class="ident-card" id="svc-card">
        <div class="empty"><span class="loader"></span><span>Reading…</span></div>
      </div>
    </div>`;
  const card = container.querySelector('#svc-card');

  const back = { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: onBack };
  setActions([{ key: '1', keyLabel: 'F1', label: 'Re-read',
                fn: () => showServiceRead(ecu, spec, container, onBack) }, back]);

  let vals;
  try {
    const d = await api(`/api/ecu/${ecu.sgbd}/run/${spec.job}`, { method: 'POST' });
    vals = new Map(flatResults(d.sets));
  } catch (e) {
    card.innerHTML = errorBlock(e.message);
    sbLeft.textContent = 'failed';
    return;
  }

  // same INPA/modern split every field card uses, plus the CBS bar
  const inpa = inpaMode();
  const rows = spec.fields
    .filter(([key]) => vals.has(key))
    .map(([key, label, unitKey]) => {
      const raw = vals.get(key);
      const unit = unitKey && vals.get(unitKey) ? ` ${vals.get(unitKey)}` : '';
      const pct = cbsPercent(raw);
      // CBS availability reads as a bar: full is fresh, empty is due
      const bar = pct != null && /AVAI/.test(key)
        ? `<span class="svc-bar"><span class="svc-bar-fill" style="width:${pct}%"></span></span>`
        : '';
      const val = `${esc(deGerman(raw) || raw)}${esc(unit)}${bar}`;
      return inpa
        ? `<div class="ident-line"><span class="ident-lk">${esc(label)}</span>`
          + `<span class="ident-lc">:</span><span class="ident-lv">${val}</span></div>`
        : `<div class="ident-row"><span class="ident-k">${esc(label)}</span>`
          + `<span class="ident-v">${val}</span></div>`;
    })
    .join('');
  card.innerHTML = rows || `<div class="empty"><div>The ECU returned no data for this read.</div></div>`;
  sbLeft.textContent = `${spec.job} · ${spec.fields.filter(([k]) => vals.has(k)).length} fields`;
}
