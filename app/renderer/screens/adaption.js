// Adaption: INPA's selective adaptation clearing (root F8, m_ada_loe).
//
// The DME learns as it runs — idle position, knock retard, lambda trims, VANOS
// end-stops, throttle stops. Clearing a group makes it relearn, which is what
// you want after replacing the part it had been trimming around.
//
// Every entry here is a WRITE. ADAP_SELEKTIV_LOESCHEN takes a three-byte
// bitmask ("2;0;0" = idle speed) and erases that learned data for good, so
// each one confirms first and says exactly what it clears.

// what the driver actually notices after a clear, so the confirm is concrete
const ADAPTION_EFFECT = {
  'All adaptations': 'every learned value below, all at once',
  'Idle speed': 'idle may hunt or stall until it relearns',
  'Knock control': 'timing returns to the base map, then re-adapts',
  'Oxygen sensors': 'fuel trims reset; short-term trim relearns first',
  'Throttle valve': 'the throttle stop is relearned at next key-on',
  'Intake manifold': 'the air-mass model relearns while driving',
  'VANOS': 'cam end-stops are relearned; idle may be rough briefly',
  'Segment time / misfire': 'misfire detection re-references the crank wheel',
};

function renderAdaption(ecu, adaption, container, exit) {
  const inpa = inpaMode();
  const reopen = () => renderAdaption(ecu, adaption, container, exit);

  container.className = 'results-panel';
  container.innerHTML = inpa
    ? `<div class="act-menu">
         <div class="act-menu-title">${esc(adaption.title)}</div>
         <div class="act-menu-sub">${esc(adaption.subtitle)}</div>
         <div class="act-key-list" id="ada-list"></div>
       </div>`
    : `<div class="act-menu">
         <div class="act-warning">⚠ Clearing an adaptation erases what the DME has learned. It relearns while you drive, and until it does the engine may idle or run differently. This cannot be undone.</div>
         <div class="group-grid stagger" id="ada-list"></div>
       </div>`;
  const list = container.querySelector('#ada-list');

  const clear = async (e) => {
    const effect = ADAPTION_EFFECT[e.label];
    const ok = await confirmDialog({
      title: `Clear ${esc(e.label).toLowerCase()} adaptation?`,
      body: `This erases the <b>${esc(e.label)}</b> values <b>${esc(ecu.label)}</b> has `
          + `learned, via <span class="mono">${esc(adaption.job)} ${esc(e.mask)}</span>.`
          + (effect ? `<br><br>After clearing: ${esc(effect)}.` : '')
          + `<br><br>This cannot be undone from here.`,
      confirmLabel: 'Clear', danger: true,
    });
    if (!ok) { sbLeft.textContent = 'cancelled'; return; }
    try {
      await api(`/api/ecu/${ecu.sgbd}/run/${adaption.job}?arg=${encodeURIComponent(e.mask)}`,
                { method: 'POST' });
      sbLeft.textContent = `${e.label} · cleared`;
    } catch (err) {
      sbLeft.textContent = 'failed';
      confirmDialog({ title: 'Clear failed', body: esc(err.message),
                      confirmLabel: 'OK', cancelLabel: 'Close' });
    }
  };

  // "All adaptations" wipes everything the others do, so it reads as the
  // heavier action in both modes rather than sitting inline as a peer
  const isAll = (e) => /^all /i.test(e.label);

  adaption.entries.forEach((e, i) => {
    if (inpa) {
      const row = document.createElement('button');
      row.className = 'inpa-fn act-key-row' + (isAll(e) ? ' danger' : '');
      row.innerHTML = `<span class="inpa-fn-key">&lt; F${i + 1} &gt;</span>`
        + `<span class="inpa-fn-label">${esc(lang() === 'orig' ? e.fkey : e.label)}</span>`
        + `<span class="act-key-val">${esc(e.mask)}</span>`;
      row.onclick = () => clear(e);
      list.appendChild(row);
      return;
    }
    const tile = document.createElement('div');
    tile.className = 'group-tile' + (isAll(e) ? ' danger' : '');
    tile.innerHTML = `
      <div class="group-name">${esc(e.label)}</div>
      <div class="group-count">${esc(ADAPTION_EFFECT[e.label] || 'clears learned values')}</div>
      <div class="group-arrow">→</div>`;
    tile.onclick = () => clear(e);
    list.appendChild(tile);
  });
  if (!inpa) stagger(list, 40);

  // INPA puts each adaptation on its own F-key; the bar holds nine
  const acts = adaption.entries.slice(0, 9).map((e, i) => ({
    key: String(i + 1), keyLabel: `F${i + 1}`,
    label: lang() === 'orig' ? e.fkey : e.label,
    kind: isAll(e) ? 'danger' : undefined, fn: () => clear(e),
  }));
  if (exit) acts.push(exit);
  setActions(acts);
  sbLeft.textContent = `${adaption.entries.length} adaptations`;
  return reopen;
}
