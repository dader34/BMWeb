// Special: INPA's Speicher (memory dump) and EWS/CAS start-value alignment.
//
// Both are real INPA screens. Memory is root F7 ("MS45 Read memory") and reads
// through SPEICHER_LESEN_ASCII with a "<REGION>;0x<addr>;<n>" argument. The
// immobilizer sync is Shift+F6 / Shift+F7 and is a SEQUENCE — ordered jobs with
// a wait between the request and the answer, exactly as INPA runs it.

// how many bytes one dump row shows, matching INPA's hex layout
const MEM_ROW = 16;

const hex = (n, w) => '0x' + (n >>> 0).toString(16).toUpperCase().padStart(w, '0');
const parseAddr = (s) => {
  const n = parseInt(String(s).replace(/^0x/i, ''), 16);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

function renderSpecial(ecu, special, container, exit) {
  const inpa = inpaMode();
  const reopen = () => renderSpecial(ecu, special, container, exit);

  container.className = 'results-panel';
  container.innerHTML = inpa
    ? `<div class="act-menu">
         <div class="act-menu-title">${esc(special.title)}</div>
         <div class="act-menu-sub">${esc(special.subtitle)}</div>
         <div class="act-key-list" id="sp-list"></div>
       </div>`
    : `<div class="act-menu">
         <div class="act-warning">⚠ Start-value alignment re-synchronises the DME with the EWS/CAS immobilizer. If it does not complete, the engine may not start.</div>
         <div class="group-grid stagger" id="sp-list"></div>
       </div>`;
  const list = container.querySelector('#sp-list');

  const entries = [
    { kind: 'memory', title: special.memory.title, caption: special.memory.caption },
    ...special.sync.map(s => ({ kind: 'sync', sync: s, title: s.title, caption: s.caption })),
  ];

  const open = (e) => (e.kind === 'memory'
    ? showMemory(ecu, special.memory, container, reopen)
    : showSync(ecu, e.sync, container, reopen));

  entries.forEach((e, i) => {
    if (inpa) {
      const row = document.createElement('button');
      row.className = 'inpa-fn act-key-row' + (e.kind === 'sync' ? ' danger' : '');
      row.innerHTML = `<span class="inpa-fn-key">&lt; F${i + 1} &gt;</span>`
        + `<span class="inpa-fn-label">${esc(e.title)}</span>`
        + `<span class="act-key-val">${esc(e.caption)}</span>`;
      row.onclick = () => open(e);
      list.appendChild(row);
      return;
    }
    const tile = document.createElement('div');
    tile.className = 'group-tile' + (e.kind === 'sync' ? ' danger' : '');
    tile.innerHTML = `
      <div class="group-name">${esc(e.title)}</div>
      <div class="group-count">${esc(e.caption)}</div>
      <div class="group-arrow">→</div>`;
    tile.onclick = () => open(e);
    list.appendChild(tile);
  });
  if (!inpa) stagger(list, 40);

  const acts = entries.map((e, i) => ({
    key: String(i + 1), keyLabel: `F${i + 1}`, label: e.title,
    kind: e.kind === 'sync' ? 'danger' : undefined, fn: () => open(e),
  }));
  if (exit) acts.push(exit);
  setActions(acts);
  sbLeft.textContent = `${entries.length} functions`;
}

// INPA's memory dump: a region, an address, and ±10h/±100h stepping
async function showMemory(ecu, mem, container, onBack) {
  let region = mem.regions[0];
  let addr = parseAddr(region.start) || 0;

  container.className = 'results-panel';
  container.innerHTML = `
    <div class="act-menu">
      <div class="act-menu-title">${esc(mem.title)}</div>
      <div class="act-menu-sub" id="mem-sub"></div>
      <div class="mem-dump" id="mem-dump">
        <div class="empty"><span>Pick a region to read.</span></div>
      </div>
    </div>`;
  const dump = container.querySelector('#mem-dump');
  const sub = container.querySelector('#mem-sub');

  // INPA prints each region's limits on screen and refuses reads outside them
  const clamp = (n) => {
    const lo = parseAddr(region.low), hi = parseAddr(region.high);
    if (lo == null || hi == null) return Math.max(0, n);
    return Math.min(hi, Math.max(lo, n));
  };

  const read = async () => {
    addr = clamp(addr);
    sub.textContent = `${region.label} · ${hex(addr, 6)} `
      + `(${esc(region.low)}–${esc(region.high)})`;
    dump.innerHTML = `<div class="empty"><span class="loader"></span><span>Reading ${hex(addr, 6)}…</span></div>`;
    const arg = `${region.token};${hex(addr, 6)};${MEM_ROW}`;
    try {
      const d = await api(`/api/ecu/${ecu.sgbd}/run/${mem.job}?arg=${encodeURIComponent(arg)}`,
                          { method: 'POST' });
      const vals = new Map(flatResults(d.sets));
      const bytes = String(vals.get('DATEN') ?? '').trim();
      const ascii = String(vals.get('DATEN_ASCII') ?? '').trim();
      dump.innerHTML = `
        <div class="mem-row mem-head">
          <span class="mem-addr">Start address</span>
          <span class="mem-bytes">Data</span>
          <span class="mem-ascii">ASCII</span>
        </div>
        <div class="mem-row">
          <span class="mem-addr">${esc(hex(addr, 6))}</span>
          <span class="mem-bytes">${esc(bytes || '--')}</span>
          <span class="mem-ascii">${esc(ascii || '')}</span>
        </div>`;
      sbLeft.textContent = `${arg} · ok`;
    } catch (e) {
      dump.innerHTML = errorBlock(e.message);
      sbLeft.textContent = 'failed';
    }
  };

  const jump = async () => {
    const v = await inputDialog({
      title: 'Go to address',
      body: `Hex address to read in <b>${esc(region.label)}</b>`
          + ` (${esc(region.low)}–${esc(region.high)}, max ${mem.maxBytes} bytes).`,
      kind: 'text', example: hex(addr, 6), confirmLabel: 'Read',
    });
    const n = parseAddr(v);
    if (n == null) { sbLeft.textContent = 'cancelled'; return; }
    addr = n; read();
  };

  const rebuild = () => {
    // INPA's own key order: the four regions, then the address steps
    const acts = mem.regions.map((r, i) => ({
      // hand-built layouts carry a short softkey caption (`key`) and INPA's
      // own long one (`fkey`); mined ones carry the region token and its
      // caption. Take whichever this layout has.
      key: String(i + 1), keyLabel: `F${i + 1}`,
      label: r.key || r.fkey || r.token || r.label,
      kind: r.token === region.token ? 'active' : undefined,
      fn: () => { region = r; addr = parseAddr(r.start) || 0; read(); rebuild(); },
    }));
    mem.steps.forEach((s, i) => acts.push({
      key: String(mem.regions.length + i + 1),
      keyLabel: `F${mem.regions.length + i + 1}`, label: s.key || s.label,
      fn: () => { addr = clamp(addr + s.delta); read(); rebuild(); },
    }));
    acts.push({ key: 'g', keyLabel: 'G', label: 'Go to…', fn: jump });
    acts.push({ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: onBack });
    setActions(acts);
  };
  rebuild();
  sub.textContent = `${region.label} · ${hex(addr, 6)} (${region.low}–${region.high})`;
}

// the EWS/CAS start-value alignment, run as INPA's ordered sequence
async function showSync(ecu, sync, container, onBack) {
  container.className = 'results-panel';
  container.innerHTML = `
    <div class="act-menu">
      <div class="act-menu-title">${esc(sync.title)}</div>
      <div class="act-menu-sub">${esc(sync.caption)}</div>
      <div class="sync-steps" id="sync-steps"></div>
    </div>`;
  const stepsEl = container.querySelector('#sync-steps');

  const draw = (states) => {
    stepsEl.innerHTML = sync.steps.map((s, i) => `
      <div class="sync-step ${esc(states[i] || 'idle')}">
        <span class="sync-n">${i + 1}</span>
        <span class="sync-label">${esc(s.label)}</span>
        <span class="sync-job mono">${esc(s.job)}</span>
        <span class="sync-state">${esc(states[i] || '')}</span>
      </div>`).join('');
  };
  const states = sync.steps.map(() => 'idle');
  draw(states);

  const run = async () => {
    const ok = await confirmDialog({
      title: `Run ${esc(sync.title).toLowerCase()}?`,
      body: `This re-synchronises <b>${esc(ecu.label)}</b> with the immobilizer, `
          + `running <span class="mono">${sync.steps.map(s => esc(s.job)).join(' → ')}</span>.`
          + `<br><br>If the sequence does not complete, the engine may not start. `
          + `Do not interrupt it or switch the ignition off while it runs.`,
      confirmLabel: 'Run alignment', danger: true,
    });
    if (!ok) { sbLeft.textContent = 'cancelled'; return; }

    for (let i = 0; i < sync.steps.length; i++) {
      const s = sync.steps[i];
      if (s.wait) {                       // INPA's "Wartezeit von 2 s"
        states[i] = 'waiting'; draw(states);
        await new Promise(r => setTimeout(r, s.wait * 1000));
      }
      states[i] = 'running'; draw(states);
      try {
        const d = await api(`/api/ecu/${ecu.sgbd}/run/${s.job}`, { method: 'POST' });
        const vals = new Map(flatResults(d.sets));
        const status = String(vals.get('EWS_EMPFANGSSTATUS') ?? '').trim();
        states[i] = 'ok'; draw(states);
        sbLeft.textContent = status ? `${s.job} · ${status}` : `${s.job} · ok`;
      } catch (e) {
        states[i] = 'failed'; draw(states);
        sbLeft.textContent = `${s.job} · failed`;
        confirmDialog({
          title: 'Alignment failed',
          body: `<b>${esc(s.job)}</b> failed: ${esc(e.message)}`
              + `<br><br>The sequence stopped here. The immobilizer may be left `
              + `out of sync — re-run the alignment before trying to start.`,
          confirmLabel: 'OK', cancelLabel: 'Close',
        });
        return;
      }
    }
    sbLeft.textContent = 'alignment complete';
  };

  setActions([
    { key: '1', keyLabel: 'F1', label: 'Run alignment', kind: 'danger', fn: run },
    { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: onBack },
  ]);
}
