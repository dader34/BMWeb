// AIF: INPA's "user information field" (Ausbau-Info-Feld) — the DME's
// programming log. Each time the ECU is flashed the tester writes a record:
// dealer, tester serial, mileage, dataset number, date. INPA pages through them
// with "aktuell" (the most recent) and "AIF 1".."AIF 14" behind it.
//
// AIF_LESEN returns one result set per stored record, so the pages are sets of
// a single job's output rather than separate reads. Read-only, and read once:
// the log only changes when the ECU is reprogrammed.

// INPA labels the newest record "aktuell"; the rest are numbered history
const aifRecordLabel = (i) => (i === 0 ? 'Current' : `AIF ${i}`);

async function renderAif(ecu, aif, container, exit) {
  container.className = 'results-panel';
  container.innerHTML = `
    <div class="act-menu">
      <div class="act-menu-title">${esc(aif.title)}</div>
      <div class="act-menu-sub">${esc(aif.subtitle)}</div>
      <div class="ident-card" id="aif-card">
        <div class="empty"><span class="loader"></span><span>Reading programming history…</span></div>
      </div>
    </div>`;
  const card = container.querySelector('#aif-card');

  let sets = [];
  try {
    const d = await api(`/api/ecu/${ecu.sgbd}/run/${aif.job}`, { method: 'POST' });
    sets = dataSets(d.sets || []);
  } catch (e) {
    card.innerHTML = errorBlock(e.message);
    sbLeft.textContent = 'failed';
    if (exit) setActions([exit]);
    return;
  }

  if (!sets.length) {
    card.innerHTML = `<div class="empty"><div>The ECU has no user information field.</div></div>`;
    sbLeft.textContent = 'no records';
    if (exit) setActions([exit]);
    return;
  }

  // INPA caps the list at "aktuell" + AIF 1..14; an ECU can hold no more
  const recs = sets.slice(0, aif.records);
  let cur = 0;

  const draw = () => {
    const vals = new Map(Object.entries(recs[cur]).filter(([k]) => !k.startsWith('_')));
    const rows = aif.fields
      .filter(f => vals.has(f.key))
      .map(f => `<div class="ident-row">
                   <span class="ident-k">${esc(f.label)}</span>
                   <span class="ident-v">${esc(vals.get(f.key))}</span>
                 </div>`)
      .join('');
    card.innerHTML = rows
      || `<div class="empty"><div>This record is empty.</div></div>`;

    // record selector on the softkeys, INPA's own captions
    const acts = recs.slice(0, 9).map((_, i) => ({
      key: String(i + 1), keyLabel: `F${i + 1}`, label: aifRecordLabel(i),
      kind: i === cur ? 'active' : undefined,
      fn: () => { cur = i; draw(); },
    }));
    if (exit) acts.push(exit);
    setActions(acts);
    sbLeft.textContent = `${aifRecordLabel(cur)} · ${recs.length} record${recs.length === 1 ? '' : 's'}`;
  };
  draw();
}
