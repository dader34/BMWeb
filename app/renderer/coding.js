// Coding: the ECU's vehicle-option configuration (ECU_CONFIG).
//
// The DME carries a flag per option — automatic gearbox, A/C, SMG, secondary-air
// pump — saying what it is coded to expect on this car. INPA draws them as
// lamps, filled when fitted, which is what this reproduces. Reading is safe;
// ECU_CONFIG_RESET clears a subsystem's configuration and is confirmed.

// INPA's Coding screen mined from an .IPO is a labelled READ -- one job, a
// caption per row (ZKE5: COD_LESEN -> "Coding", "Block 0") -- not the ECU_CONFIG
// option lamps below. Same shape as the Ident card, so it renders as one.
async function renderCodingRead(ecu, coding, container, exit) {
  container.className = 'results-panel';
  container.innerHTML = `
    <div class="act-menu">
      <div class="act-menu-title">${esc(coding.title)}</div>
      <div class="act-menu-sub mono">${esc(coding.job)}</div>
      <div class="ident-card" id="cod-card">
        <div class="empty"><span class="loader"></span><span>Reading coding data…</span></div>
      </div>
    </div>`;
  const card = container.querySelector('#cod-card');

  const acts = [{ key: '1', keyLabel: 'F1', label: 'Re-read',
                  fn: () => renderCodingRead(ecu, coding, container, exit) }];
  if (exit) acts.push(exit);
  setActions(acts);

  let vals;
  try {
    const d = await api(`/api/ecu/${ecu.sgbd}/run/${coding.job}`, { method: 'POST' });
    vals = new Map(flatResults(d.sets));
  } catch (e) {
    card.innerHTML = errorBlock(e.message);
    sbLeft.textContent = 'failed';
    return;
  }

  const shown = coding.fields.filter(f => vals.has(f.key));
  card.innerHTML = identRows(shown, vals)
    || `<div class="empty"><div>The ECU returned no coding data.</div></div>`;
  sbLeft.textContent = `${coding.job} · ${shown.length} field${shown.length === 1 ? '' : 's'}`;
}

function renderCoding(ecu, coding, container, exit) {
  const inpa = inpaMode();
  container.className = 'results-panel';
  container.innerHTML = `
    <div class="act-menu">
      <div class="act-menu-title">${esc(coding.title)}</div>
      <div class="act-menu-sub">${esc(coding.subtitle)}</div>
      <div class="coding-grid" id="cod-grid"></div>
    </div>`;
  const grid = container.querySelector('#cod-grid');

  // one lamp per option, in the ECU's own order
  const cells = new Map();
  coding.options.forEach(o => {
    const cell = document.createElement('div');
    cell.className = 'coding-opt';
    cell.innerHTML = `<span class="coding-lamp">○</span>`
      + `<span class="coding-name">${esc(o.label)}</span>`;
    grid.appendChild(cell);
    cells.set(o.key, cell);
  });

  const tick = async () => {
    try {
      const d = await api(`/api/ecu/${ecu.sgbd}/run/${coding.job}`, { method: 'POST' });
      const vals = new Map(flatResults(d.sets));
      coding.options.forEach(o => {
        const cell = cells.get(o.key);
        if (!cell) return;
        const raw = String(vals.get(o.key) ?? '').trim().toLowerCase();
        // the flag reads 1/0, or the ECU's own wording for present/absent
        const on = raw === '1' || raw === 'vorhanden' || raw === 'ja' || raw === 'ein';
        cell.classList.toggle('fitted', on);
        const lamp = cell.querySelector('.coding-lamp');
        const glyph = on ? '●' : '○';
        if (lamp.textContent !== glyph) { lamp.textContent = glyph; flash(lamp); }
      });
      sbLeft.textContent = `${coding.job} · ${cells.size} options`;
    } catch (e) {
      grid.innerHTML = errorBlock(e.message);
      sbLeft.textContent = 'failed';
    }
  };
  tick();
  scheduleLive(tick);

  // the reset is a write, so it lives behind a confirm and its own softkey
  const reset = coding.reset;
  const doReset = async (target) => {
    const ok = await confirmDialog({
      title: 'Reset ECU configuration?',
      body: `This clears the <b>${esc(target.label)}</b> configuration on `
          + `<b>${esc(ecu.label)}</b> via <span class="mono">${esc(reset.job)}</span>. `
          + `The ECU will no longer expect that subsystem until it is coded again. `
          + `This cannot be undone from here.`,
      confirmLabel: 'Reset', danger: true,
    });
    if (!ok) { sbLeft.textContent = 'cancelled'; return; }
    try {
      await api(`/api/ecu/${ecu.sgbd}/run/${reset.job}?arg=${encodeURIComponent(target.code)}`,
                { method: 'POST' });
      sbLeft.textContent = `${reset.job} ${target.code} · sent`;
    } catch (e) {
      sbLeft.textContent = 'failed';
      confirmDialog({ title: 'Reset failed', body: esc(e.message),
                      confirmLabel: 'OK', cancelLabel: 'Close' });
    }
  };

  const pickReset = async () => {
    // INPA picks the subsystem from its own submenu; mirror that as a choice
    const list = reset.targets.map((t, i) => `${i + 1}. ${esc(t.label)}`).join('<br>');
    const which = await inputDialog({
      title: 'Reset which configuration?',
      body: `Choose a subsystem to clear:<br><br>${list}`,
      kind: 'number', example: '1', confirmLabel: 'Continue', danger: true,
    });
    const n = parseInt(which, 10);
    if (!Number.isFinite(n) || n < 1 || n > reset.targets.length) {
      sbLeft.textContent = 'cancelled';
      return;
    }
    doReset(reset.targets[n - 1]);
  };

  const acts = [
    { key: '1', keyLabel: 'F1', label: 'Reset config', kind: 'danger', fn: pickReset },
  ];
  if (exit) acts.push(exit);
  setActions(acts);
}
