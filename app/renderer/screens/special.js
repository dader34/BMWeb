// Special: INPA's Speicher (memory dump). A real INPA screen, root F7 ("MS45
// Read memory"), reading through SPEICHER_LESEN_ASCII with a
// "<REGION>;0x<addr>;<n>" argument. Read-only.

// how many bytes one dump row shows, matching INPA's hex layout
const MEM_ROW = 16;

const parseAddr = (s) => {
  const n = parseInt(String(s).replace(/^0x/i, ''), 16);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
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
