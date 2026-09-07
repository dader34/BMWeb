/**
 * @file Special: INPA's Speicher (memory dump). A real INPA screen, root F7
 * ("MS45 Read memory"), reading through SPEICHER_LESEN_ASCII with a
 * "<REGION>;0x<addr>;<n>" argument. Read-only.
 */

/**
 * One memory region the layout offers.
 * @typedef {object} MemRegion
 * @property {string} token - The region token sent in the job argument.
 * @property {string} label - Display label.
 * @property {string} start - Start address, hex.
 * @property {string} low - Lowest readable address, hex.
 * @property {string} high - Highest readable address, hex.
 * @property {string} [key] - Short softkey caption (hand-built layouts).
 * @property {string} [fkey] - INPA's own long caption.
 */

/**
 * The memory-dump layout, decoded from the .IPO.
 * @typedef {object} MemLayout
 * @property {string} title - Screen title.
 * @property {string} job - The read job (SPEICHER_LESEN_ASCII).
 * @property {number} maxBytes - The most bytes one read may ask for.
 * @property {MemRegion[]} regions - The regions, in INPA key order.
 * @property {{ delta: number, key?: string, label: string }[]} steps
 *   - The address steps (±10h / ±100h).
 */

/** How many bytes one dump row shows, matching INPA's hex layout. */
const MEM_ROW = 16;
/** Digits an address is printed with. */
const MEM_ADDR_WIDTH = 6;

/**
 * Parse a hex address, with or without its 0x prefix.
 * @param {unknown} s - The address text.
 * @returns {number|null} The address, or null when not a non-negative hex
 *   number.
 */
const parseAddr = (s) => {
  const n = parseInt(String(s).replace(/^0x/i, ''), 16);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * INPA's memory dump: a region, an address, and ±10h/±100h stepping.
 * @param {{ sgbd: string }} ecu - The module.
 * @param {MemLayout} mem - The layout.
 * @param {HTMLElement} container - The view to draw into.
 * @param {() => void} onBack - Back action.
 * @returns {Promise<void>} Resolves once the screen is drawn.
 */
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
    const lo = parseAddr(region.low),
      hi = parseAddr(region.high);
    if (lo == null || hi == null) return Math.max(0, n);
    return Math.min(hi, Math.max(lo, n));
  };

  const read = async () => {
    addr = clamp(addr);
    sub.textContent =
      `${region.label} · ${hex(addr, MEM_ADDR_WIDTH)} ` +
      `(${esc(region.low)}–${esc(region.high)})`;
    dump.innerHTML = `<div class="empty"><span class="loader"></span><span>Reading ${hex(addr, MEM_ADDR_WIDTH)}…</span></div>`;
    const arg = `${region.token};${hex(addr, MEM_ADDR_WIDTH)};${MEM_ROW}`;
    try {
      const d = await api(
        `/api/ecu/${ecu.sgbd}/run/${mem.job}?arg=${encodeURIComponent(arg)}`,
        { method: 'POST' }
      );
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
          <span class="mem-addr">${esc(hex(addr, MEM_ADDR_WIDTH))}</span>
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
      body:
        `Hex address to read in <b>${esc(region.label)}</b>` +
        ` (${esc(region.low)}–${esc(region.high)}, max ${mem.maxBytes} bytes).`,
      kind: 'text',
      example: hex(addr, MEM_ADDR_WIDTH),
      confirmLabel: 'Read',
    });
    const n = parseAddr(v);
    if (n == null) {
      sbLeft.textContent = 'cancelled';
      return;
    }
    addr = n;
    read();
  };

  const rebuild = () => {
    // INPA's own key order: the four regions, then the address steps
    const acts = mem.regions.map((r, i) => ({
      // hand-built layouts carry a short softkey caption (`key`) and INPA's
      // own long one (`fkey`); mined ones carry the region token and its
      // caption. Take whichever this layout has.
      key: String(i + 1),
      keyLabel: `F${i + 1}`,
      label: r.key || r.fkey || r.token || r.label,
      kind: r.token === region.token ? 'active' : undefined,
      fn: () => {
        region = r;
        addr = parseAddr(r.start) || 0;
        read();
        rebuild();
      },
    }));
    mem.steps.forEach((s, i) =>
      acts.push({
        key: String(mem.regions.length + i + 1),
        keyLabel: `F${mem.regions.length + i + 1}`,
        label: s.key || s.label,
        fn: () => {
          addr = clamp(addr + s.delta);
          read();
          rebuild();
        },
      })
    );
    acts.push({ key: 'g', keyLabel: 'G', label: 'Go to…', fn: jump });
    acts.push({
      key: 'Escape',
      keyLabel: 'Esc',
      label: 'Back',
      kind: 'back',
      fn: onBack,
    });
    setActions(acts);
  };
  rebuild();
  sub.textContent = `${region.label} · ${hex(addr, MEM_ADDR_WIDTH)} (${region.low}–${region.high})`;
}
