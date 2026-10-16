/**
 * @file Map switch builder: laying the extra maps out in the free flash, as 1 KB blocks (generation 4) or as chunks with the single values switched at their load sites (generation 6).
 */

/* exported msRuns, msUpperSites, msRewriteUpper, msSensorSitesState, msLayout, msEraseMapAreas, msWriteLayout, msHeaderMapCount, msTableFrom, msMapFromTable, msTableRanges, msStoredMaps, msScanSites, msSitePlan, msSiteAreaLength, msWriteSites, msReadSites, msRestoreSites, msChunkLayout, msWriteChunkLayout, msChunkTableFrom, msHeaderIsChunks, msMapFromChunkTable */

// ---- laying the maps out in blocks (generation 4) --------------------------------------------------
/** The 1 KB blocks in which two calibrations differ. */
function msDifferingBlocks(map1, mapN) {
  const out = [];
  for (let b = 0; b < MS_BLOCK_COUNT; b++) {
    const start = b * MS_BLOCK;
    for (let i = start; i < start + MS_BLOCK; i++) {
      if (map1[i] !== mapN[i]) {
        out.push(b);
        break;
      }
    }
  }
  return out;
}

/** Maximal runs of consecutive block numbers, each {first, last}. */
function msRuns(blocks) {
  const sorted = [...blocks].sort((x, y) => x - y);
  const runs = [];
  for (const b of sorted) {
    const last = runs[runs.length - 1];
    if (last && last.last === b - 1) last.last = b;
    else runs.push({ first: b, last: b });
  }
  return runs;
}

/** Free 1 KB slots one by one: block number (flash offset / 1 KB) -> the pool it is in, in block order. */
class MsFreeBlocks {
  constructor() {
    this.free = new Map();
  }
  add(start, end, pool) {
    for (let b = start; b < end; b++) this.free.set(b, pool);
  }
  /** What is still free, as ranges for the runs that need consecutive slots. */
  pieces() {
    const out = new MsSlots();
    let start = -1;
    let last = -1;
    for (const b of [...this.free.keys()].sort((x, y) => x - y)) {
      if (b !== last + 1) {
        if (start >= 0) out.add(start, last + 1);
        start = b;
      }
      last = b;
    }
    if (start >= 0) out.add(start, last + 1);
    return out;
  }
}

/** Free 1 KB slots as a sorted list of {start, end} block numbers (flash offset / 1 KB). */
class MsSlots {
  constructor() {
    this.ranges = [];
  }
  add(start, end) {
    if (end <= start) return;
    this.ranges.push({ start, end });
    this.ranges.sort((x, y) => x.start - y.start);
  }
  get free() {
    return this.ranges.reduce((n, r) => n + r.end - r.start, 0);
  }
  /** The first range with room for `n` consecutive slots, taken from its start; -1 when none. */
  takeFirst(n) {
    for (const r of this.ranges) {
      if (r.end - r.start >= n) {
        const at = r.start;
        r.start += n;
        this.ranges = this.ranges.filter((x) => x.end > x.start);
        return at;
      }
    }
    return -1;
  }
  /** The smallest range with room for `n` consecutive slots, taken from its start; -1 when none. */
  takeBest(n) {
    let best = null;
    for (const r of this.ranges)
      if (
        r.end - r.start >= n &&
        (!best || r.end - r.start < best.end - best.start)
      )
        best = r;
    if (!best) return -1;
    const at = best.start;
    best.start += n;
    this.ranges = this.ranges.filter((x) => x.end > x.start);
    return at;
  }
}

/** The addis rX, r2, 1 still in the code, as [image, offset]. */
function msUpperSites(flash, mpc) {
  const out = [];
  for (const [which, start, end] of MS_UPPER_CODE) {
    const image = which === 'mpc' ? mpc : flash;
    for (let at = start; at < end; at += 4)
      if ((msRead32(image, at) & MS_UPPER_INSN_MASK) >>> 0 === MS_UPPER_ADDIS)
        out.push([which, at]);
  }
  return out;
}

/** Rewrite every addis rX, r2, 1 left to lis rX, 0xFFE5, and the two sensor-table readers; returns how many. */
function msRewriteUpper(result) {
  const sites = msUpperSites(result.flash, result.mpc);
  for (const [which, at] of sites) {
    const image = which === 'mpc' ? result.mpc : result.flash;
    msWrite32(
      image,
      at,
      (MS_UPPER_LIS | (msRead32(image, at) & ~MS_UPPER_INSN_MASK)) >>> 0
    );
  }
  let n = sites.length;
  for (const [at, stock] of MS_SENSOR_TABLE_SITES)
    if (msRead32(result.mpc, at) === stock) {
      msWrite32(
        result.mpc,
        at,
        (MS_SENSOR_TABLE_LIS | (stock & ~MS_UPPER_INSN_MASK)) >>> 0
      );
      n++;
    }
  return n;
}

/** Whether the sensor-table readers are as stock, as rewritten, or neither (null). */
function msSensorSitesState(mpc) {
  let stock = 0;
  let done = 0;
  for (const [at, want] of MS_SENSOR_TABLE_SITES) {
    const w = msRead32(mpc, at);
    if (w === want) stock++;
    else if (w === (MS_SENSOR_TABLE_LIS | (want & ~MS_UPPER_INSN_MASK)) >>> 0)
      done++;
  }
  return stock === 2 ? 'stock' : done === 2 ? 'rewritten' : null;
}

/**
 * Where every block of every extra map goes. `maps` are the calibrations of
 * maps 2..N. Blocks are flash offsets / 1 KB.
 * @returns {{ok: boolean, reason: string|null, maps: object[], blocksTotal: number, blocksUsed: number, blocksFree: number}}
 */
function msLayout(map1, maps) {
  const slots = new MsFreeBlocks();
  MS_POOLS.forEach(([start, end], pool) =>
    slots.add(Math.max(start, MS_TABLES_END) / MS_BLOCK, end / MS_BLOCK, pool)
  );
  const blocksTotal = slots.free.size;
  const out = {
    ok: true,
    reason: null,
    maps: [],
    blocksTotal,
    blocksUsed: 0,
    blocksFree: blocksTotal,
  };
  const fail = (reason) => {
    out.ok = false;
    out.reason = reason;
    return out;
  };
  const plans = [];
  for (let i = 0; i < maps.length; i++) {
    // the blocks this map must carry: what differs, with its neighbours. A
    // table whose pointer is in the block before may run into a changed
    // block, so that block is carried and redirected too; and a table in a
    // changed block may run into the next, so that one is carried after it
    // (but not redirected: tables starting in it are whole in map 1)
    const differing = new Set(msDifferingBlocks(map1, maps[i]));
    const redirected = new Set(differing);
    for (const b of differing) if (b > 0) redirected.add(b - 1);
    const carried = new Set(redirected);
    for (const b of differing) if (b + 1 < MS_BLOCK_COUNT) carried.add(b + 1);
    const runs = msRuns(carried);
    // the window: the r2 blocks, at their own offsets from a base the
    // program gets r2 from, and with them any run of carried blocks that
    // meets one, so that a table there still reads whole. An r2 block that
    // does not differ is only in the window for the reads through r2; its
    // table entry stays map 1's, and it carries no neighbours
    const meetsWindow = (r) =>
      MS_R2_BLOCKS.some((b) => b >= r.first && b <= r.last);
    const window = new Set(MS_R2_BLOCKS);
    for (const r of runs)
      if (meetsWindow(r)) for (let b = r.first; b <= r.last; b++) window.add(b);
    plans.push({
      index: i + 1,
      differing,
      redirected,
      window: [...window].sort((x, y) => x - y),
      others: runs
        .filter((r) => !meetsWindow(r))
        .sort((x, y) => y.last - y.first - (x.last - x.first)),
    });
  }
  // The windows go first, each at the lowest base whose slots are all free
  // in one pool. The r2 blocks are 0-6, 0x12 and 0x15-0x17, so a window has
  // gaps the next one's blocks fall into: at offsets 0, 7, 31, 38, 62 and
  // 69 six of them take 93 KB, not 150, and need no 25 KB in one piece.
  for (const p of plans) {
    let base = -1;
    for (const [b0, pool] of slots.free) {
      if (p.window.every((b) => slots.free.get(b0 + b) === pool)) {
        base = b0;
        break;
      }
    }
    if (base < 0) {
      return fail(
        `Map ${p.index + 1} does not fit: the ${msKb(p.window.length)} the program reads through r2 (spread over ${msKb(p.window[p.window.length - 1] + 1)}) find no place in the ${msKb(slots.free.size)} still free.`
      );
    }
    p.windowBase = base;
    p.slot = new Map();
    for (const b of p.window) {
      p.slot.set(b, base + b);
      slots.free.delete(base + b);
    }
  }
  // then the other runs, each in the smallest free piece it fits
  const pieces = slots.pieces();
  for (const p of plans) {
    for (const r of p.others) {
      const n = r.last - r.first + 1;
      const at = pieces.takeBest(n);
      if (at < 0) {
        return fail(
          `Map ${p.index + 1} does not fit: ${msKb(n)} more of flash in one piece is needed and ${msKb(pieces.free)} are free, in smaller pieces.`
        );
      }
      for (let b = r.first; b <= r.last; b++) p.slot.set(b, at + b - r.first);
    }
  }
  for (const p of plans) {
    const table = new Uint16Array(MS_TABLE_ENTRIES).fill(MS_NO_BLOCK);
    for (const b of p.redirected) table[b] = p.slot.get(b);
    out.maps.push({
      index: p.index,
      windowBase: p.windowBase,
      windowBlocks: p.window.length,
      r2: (MAPSWITCH_EXT + p.windowBase * MS_BLOCK + MS_R2_LOW) >>> 0,
      slot: p.slot,
      table,
      redirected: p.redirected.size,
      carried: p.slot.size,
      differing: p.differing.size,
    });
  }
  out.blocksFree = pieces.free;
  out.blocksUsed = blocksTotal - pieces.free;
  return out;
}

/** Erase everything a generation 4 build writes into the external flash (the pools cover the earlier full copy too). */
function msEraseMapAreas(flash) {
  for (const [start, end] of MS_POOLS) flash.fill(0xff, start, end);
  flash.fill(
    0xff,
    MAPSWITCH_MAP2_START,
    MAPSWITCH_MAP2_START + MAPSWITCH_MAP2_LENGTH
  );
}

/** Write the header, the block tables and the blocks of a layout into `flash`. */
function msWriteLayout(flash, maps, layout) {
  const h = MS_HEADER;
  flash.fill(0xff, h, h + MS_TABLE_STRIDE);
  for (let i = 0; i < MS_HEADER_MAGIC.length; i++)
    flash[h + i] = MS_HEADER_MAGIC.charCodeAt(i);
  flash[h + MS_HEADER_COUNT] = maps.length + 1;
  msWrite32(flash, h + MS_HEADER_R2, MS_R2_MAP1);
  for (const m of layout.maps) {
    msWrite32(flash, h + MS_HEADER_R2 + 4 * m.index, m.r2);
    const t = h + m.index * MS_TABLE_STRIDE;
    for (let e = 0; e < MS_TABLE_ENTRIES; e++)
      msWrite16(flash, t + 2 * e, m.table[e]);
    const cal = maps[m.index - 1];
    for (const [b, at] of m.slot)
      flash.set(cal.subarray(b * MS_BLOCK, (b + 1) * MS_BLOCK), at * MS_BLOCK);
  }
}

function msHeaderMapCount(area) {
  if (!area || area.length < MS_HEADER_COUNT + 1) return null;
  if (msReadAscii(area, 0, MS_HEADER_MAGIC.length) !== MS_HEADER_MAGIC)
    return null;
  const n = area[MS_HEADER_COUNT];
  return n >= MS_MIN_MAPS && n <= MS_MAX_MAPS ? n : null;
}

/** The block table of map `index` from the header-and-tables area. */
function msTableFrom(area, index) {
  const table = new Uint16Array(MS_TABLE_ENTRIES);
  for (let e = 0; e < MS_TABLE_ENTRIES; e++)
    table[e] = msRead16(area, index * MS_TABLE_STRIDE + 2 * e);
  return table;
}

/** Map `index` rebuilt from map 1 and the blocks its table names, read from `blockAt(flashOffset)`. */
function msMapFromTable(map1, table, blockAt) {
  const cal = Uint8Array.from(map1);
  for (let b = 0; b < MS_BLOCK_COUNT; b++) {
    if (table[b] === MS_NO_BLOCK) continue;
    const data = blockAt(table[b] * MS_BLOCK);
    if (!data || data.length !== MS_BLOCK) return null;
    cal.set(data, b * MS_BLOCK);
  }
  return cal;
}

/** The flash ranges holding the blocks a table names, consecutive ones merged: [{start, end}] (end exclusive). */
function msTableRanges(table) {
  const blocks = [];
  for (let b = 0; b < MS_BLOCK_COUNT; b++)
    if (table[b] !== MS_NO_BLOCK) blocks.push(table[b]);
  return msRuns(blocks).map((r) => ({
    start: r.first * MS_BLOCK,
    end: (r.last + 1) * MS_BLOCK,
  }));
}

/** The maps 2..N stored in a pair, as calibrations; null when the pair is not read as a build. */
function msStoredMaps(flash, mpc) {
  if (!flash || flash.length !== MAPSWITCH_FULL_FLASH_LENGTH) return null;
  const v = msVersionOf(mpc);
  if (!v) return null;
  if (!msMulti(v)) {
    const map2 = mapSwitch.map2AsCalibration(
      flash.subarray(
        MAPSWITCH_MAP2_START,
        MAPSWITCH_MAP2_START + MAPSWITCH_MAP2_LENGTH
      )
    );
    return map2 ? [map2] : [];
  }
  const area = flash.subarray(MS_HEADER, MS_CHUNK_TABLES_END);
  const n = msHeaderMapCount(area);
  if (n == null) return [];
  const map1 = flash.subarray(
    MAPSWITCH_CAL_START,
    MAPSWITCH_CAL_START + MAPSWITCH_CAL_LENGTH
  );
  const maps = [];
  if (msHeaderIsChunks(area)) {
    const dir = msReadSites(flash.subarray(MS_SITES, MS_POOLS[0][1]));
    for (let index = 1; index < n; index++) {
      const cal = msMapFromChunkTable(
        map1,
        msChunkTableFrom(area, index),
        dir,
        index,
        (at) => flash.subarray(at, at + MS_CHUNK)
      );
      if (cal) maps.push(cal);
    }
    return maps;
  }
  for (let index = 1; index < n; index++) {
    const cal = msMapFromTable(map1, msTableFrom(area, index), (at) =>
      flash.subarray(at, at + MS_BLOCK)
    );
    if (cal) maps.push(cal);
  }
  return maps;
}

// ---- generation 6: the single values switch at their load sites, the tables as chunks ---------
/**
 * Whether a word is a plausible PowerPC instruction: the primary opcode is
 * one the program uses, and for the extended-opcode forms the extension too.
 * Data words seldom are, so a run of them around a site tells code from data.
 */
const MS_VALID_OPS = new Set([
  7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 23, 24, 25, 26, 27, 28,
  29, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48,
  49, 50, 51, 52, 53, 54, 55, 59, 63,
]);
const MS_VALID_XO19 = new Set([
  0, 16, 33, 50, 129, 150, 193, 225, 257, 289, 417, 449, 528,
]);
const MS_VALID_XO31 = new Set([
  0, 4, 8, 10, 11, 19, 20, 23, 24, 26, 28, 32, 40, 54, 55, 60, 75, 83, 86, 87,
  104, 119, 124, 136, 138, 144, 146, 150, 151, 183, 202, 210, 215, 234, 235,
  242, 247, 266, 279, 284, 311, 316, 339, 343, 375, 407, 412, 439, 444, 459,
  467, 476, 491, 498, 502, 512, 533, 534, 536, 566, 567, 598, 599, 631, 663,
  695, 727, 759, 792, 824, 854, 918, 922, 954, 982, 1014,
]);
function msLooksLikeInsn(w) {
  const op = w >>> 26;
  if (!MS_VALID_OPS.has(op)) return false;
  if (op === 19) return MS_VALID_XO19.has((w >>> 1) & 0x3ff);
  if (op === 31)
    return (
      MS_VALID_XO31.has((w >>> 1) & 0x3ff) ||
      MS_VALID_XO31.has((w >>> 1) & 0x1ff)
    );
  return true;
}
function msIsCodeAround(image, at, start, end) {
  for (let k = -4; k <= 4; k++) {
    const a = at + 4 * k;
    if (a < start || a + 4 > end) continue;
    if (!msLooksLikeInsn(msRead32(image, a))) return false;
  }
  return true;
}

/**
 * Every load of a calibration value through r2 or a register derived from
 * it (addis rX, r2, 0/1 and lis rX, 0xFFE4/0xFFE5 set a base, addi rX, rB, d
 * moves one), within a straight run of code: branches end the tracking.
 * Returns {sites: Map<calOffset, [{image, at, word, rt, size}]>, uncovered: Set<calOffset>}
 * where `uncovered` holds offsets read in ways a stub cannot take over
 * (update forms, floats, r0 as the destination).
 */
function msScanSites(flash, mpc) {
  const sites = new Map();
  const uncovered = new Set();
  const LOAD = { 32: 4, 34: 1, 40: 2, 42: 2 };
  const add = (off, site) => {
    if (off < 0 || off + site.size > MAPSWITCH_CAL_LENGTH) return;
    if (!sites.has(off)) sites.set(off, []);
    sites.get(off).push(site);
  };
  for (const [which, start, end] of MS_CODE) {
    const image = which === 'mpc' ? mpc : flash;
    const bases = new Map(); // register -> calibration offset its value points at
    bases.set(2, MS_R2_LOW);
    for (let at = start; at + 4 <= end; at += 4) {
      const w = msRead32(image, at);
      const op = w >>> 26;
      const rt = (w >>> 21) & 31;
      const ra = (w >>> 16) & 31;
      const d = msS16ToNumber(w & 0xffff);
      if (op === 16 || op === 18 || op === 19) {
        // a branch: nothing survives it but r2 (r13 is never a base)
        bases.clear();
        bases.set(2, MS_R2_LOW);
        continue;
      }
      let setBase = null; // [register, offset] this instruction establishes
      if (op === 15 && ra === 2 && (w & 0xffff) === 0)
        setBase = [rt, MS_R2_LOW];
      else if (op === 15 && ra === 2 && (w & 0xffff) === 1)
        setBase = [rt, MS_R2_LOW + 0x10000];
      else if (op === 15 && ra === 0 && (w & 0xffff) === 0xffe4)
        setBase = [rt, 0];
      else if (op === 15 && ra === 0 && (w & 0xffff) === 0xffe5)
        setBase = [rt, 0x10000];
      else if (op === 14 && bases.has(ra) && rt !== 2)
        setBase = [rt, bases.get(ra) + d];
      else if (
        LOAD[op] &&
        bases.has(ra) &&
        msIsCodeAround(image, at, start, end)
      ) {
        const off = bases.get(ra) + d;
        if (
          rt === 0 ||
          rt === 2 ||
          rt === 13 ||
          (which === 'mpc' && MS_PATCHED_ADDRESSES.has(at))
        ) {
          for (let k = 0; k < LOAD[op]; k++) uncovered.add(off + k);
        } else {
          add(off, { image: which, at, word: w, rt, size: LOAD[op], op });
        }
      } else if (
        (op === 33 ||
          op === 35 ||
          op === 41 ||
          op === 43 ||
          op === 48 ||
          op === 50) &&
        bases.has(ra)
      ) {
        const n =
          op === 50
            ? 8
            : op === 48
              ? 4
              : op === 33
                ? 4
                : op === 41 || op === 43
                  ? 2
                  : 1;
        for (let k = 0; k < n; k++) uncovered.add(bases.get(ra) + d + k);
      }
      // the registers this instruction writes stop being bases
      for (const reg of msWrittenGprs(w)) if (reg !== 2) bases.delete(reg);
      if (setBase && setBase[0] !== 2) bases.set(setBase[0], setBase[1]);
    }
  }
  return { sites, uncovered };
}
const MS_PATCHED_ADDRESSES = new Set([
  ...MS_LOOKUP_ENTRIES,
  MS_LOOKUP_ENTRY_17,
  MS_TACH_STORE_ADDR,
  MS_MIL_STORE_ADDR,
  MS_ECON_STORE_ADDR,
  MS_NV_DESCRIPTOR,
  MS_NV_DESCRIPTOR + 4,
  MS_NV_DESCRIPTOR + 8,
]);
function msS16ToNumber(v) {
  return v & 0x8000 ? v - 0x10000 : v;
}
/** The general registers an instruction writes (approximately: enough to stop trusting a base). */
function msWrittenGprs(w) {
  const op = w >>> 26;
  const rt = (w >>> 21) & 31;
  const ra = (w >>> 16) & 31;
  if (op === 7 || op === 8 || (op >= 12 && op <= 15)) return [rt];
  if (op === 20 || op === 21 || op === 23 || (op >= 24 && op <= 29))
    return [ra];
  if (op >= 32 && op <= 35) return op & 1 ? [rt, ra] : [rt]; // lwz lwzu lbz lbzu
  if (op >= 40 && op <= 43) return op & 1 ? [rt, ra] : [rt]; // lhz lhzu lha lhau
  if (
    op === 37 ||
    op === 39 ||
    op === 45 ||
    op === 49 ||
    op === 51 ||
    op === 53 ||
    op === 55
  )
    return [ra]; // stores and float loads with update
  if (op === 31) {
    const xo = (w >>> 1) & 0x3ff;
    if ([0, 32, 4, 144, 150, 214, 467, 598, 854].includes(xo)) return []; // cmp, cmpl, tw, mtcrf, stwcx, mtspr, sync, eieio
    if ([151, 183, 215, 247, 407, 439, 663, 695, 727, 759].includes(xo))
      return xo & 32 ? [ra] : []; // stores, update forms write ra
    if (
      [
        28, 60, 444, 412, 316, 476, 124, 284, 24, 536, 792, 824, 26, 954, 922,
      ].includes(xo)
    )
      return [ra]; // logic and shifts: ra
    if ([55, 119, 311, 375, 55, 87, 279, 343, 23].includes(xo))
      return xo & 32 ? [rt, ra] : [rt]; // indexed loads
    return [rt];
  }
  return [];
}

/**
 * The stub a patched load site branches to: the value for the selected map
 * from the site's values, same load width and sign as the stock instruction.
 * @returns {number[]} five words
 */
function msSiteStub(site, valuesAt) {
  const rt = site.rt;
  const words = [Lbz(rt, msOff(MS_RAM_FLAG), 13)];
  // the index (flag bits 4-6) times the value size, nothing else of the flag byte
  if (site.size === 1) words.push(Rlwinm(rt, rt, 28, 29, 31));
  else if (site.size === 2) words.push(Rlwinm(rt, rt, 29, 28, 30));
  else words.push(Rlwinm(rt, rt, 30, 27, 29));
  words.push(Addis(rt, rt, msHa(MAPSWITCH_EXT + valuesAt)));
  words.push(msD(site.op, rt, rt, msLo(MAPSWITCH_EXT + valuesAt) & 0xffff));
  const back = (site.image === 'mpc' ? 0 : MAPSWITCH_EXT) + site.at + 4;
  words.push(Ba(back));
  return words;
}

/**
 * The site directory at MS_SITES, as the builder writes it and the readers
 * (here and on the emulator / car side) parse it:
 *   'SITE' | u32 scalars | u32 sites | u32 end (flash offset after the stubs)
 *   scalar: u32 (size << 24 | offset) | values[8 * size], padded to 4
 *   site:   u32 address (MPC, or 0xFFFxxxxx) | u32 stock word | u32 stub (flash offset) | u32 scalar index
 *   stubs:  5 words each
 */
function msSitePlan(scan, map1, maps) {
  // which bytes differ in any map, and which of those a site covers
  const differing = new Set();
  for (const cal of maps)
    for (let i = 0; i < MAPSWITCH_CAL_LENGTH; i++)
      if (
        cal[i] !== map1[i] &&
        !(i >= MS_CAL_TEST_SUM_OFFSET && i < MS_CAL_TEST_SUM_OFFSET + 8)
      )
        differing.add(i);
  const scalars = []; // {offset, size, values: Uint8Array[8]}
  const sites = []; // {site, scalar}
  const covered = new Set();
  const byKey = new Map();
  for (const [off, list] of scan.sites) {
    for (const site of list) {
      let hit = false;
      for (let k = 0; k < site.size; k++)
        if (differing.has(off + k)) hit = true;
      if (!hit) continue;
      const key = `${off}:${site.size}`;
      if (!byKey.has(key)) {
        const values = [];
        for (let m = 0; m < MS_MAX_MAPS + 1; m++) {
          const cal = m === 0 || m > maps.length ? map1 : maps[m - 1];
          values.push(cal.subarray(off, off + site.size));
        }
        byKey.set(key, scalars.length);
        scalars.push({ offset: off, size: site.size, values });
      }
      sites.push({ site, scalar: byKey.get(key) });
      for (let k = 0; k < site.size; k++) covered.add(off + k);
    }
  }
  // what no site covers is table data (or read some other way): those chunks are stored
  const chunks = new Set();
  const unswitchable = [];
  for (const b of differing) {
    if (covered.has(b)) continue;
    chunks.add(b >> 8);
    if (scan.uncovered.has(b)) unswitchable.push(b);
  }
  return { scalars, sites, chunks, covered, differing, unswitchable };
}

function msSiteAreaLength(plan) {
  let n = 16;
  for (const s of plan.scalars) n += 4 + msPad4(8 * s.size);
  n += 16 * plan.sites.length;
  n += 20 * plan.sites.length;
  return n;
}
const msPad4 = (n) => (n + 3) & ~3;

/** Write the directory and the stubs; patch the sites. Returns the flash offset after the stubs. */
function msWriteSites(result, plan) {
  const flash = result.flash;
  let at = MS_SITES;
  const put32 = (v) => {
    msWrite32(flash, at, v);
    at += 4;
  };
  for (let i = 0; i < 4; i++) flash[at + i] = MS_SITES_MAGIC.charCodeAt(i);
  at += 4;
  put32(plan.scalars.length);
  put32(plan.sites.length);
  const endAt = at;
  put32(0);
  const valuesAt = [];
  for (const s of plan.scalars) {
    put32(((s.size << 24) | s.offset) >>> 0);
    valuesAt.push(at);
    for (let m = 0; m < MS_MAX_MAPS + 1; m++)
      flash.set(s.values[m], at + m * s.size);
    at += msPad4(8 * s.size);
  }
  const stubsAt = at + 16 * plan.sites.length;
  let stub = stubsAt;
  for (const { site, scalar } of plan.sites) {
    put32(site.image === 'mpc' ? site.at : (MAPSWITCH_EXT + site.at) >>> 0);
    put32(site.word);
    put32(stub);
    put32(scalar);
    const words = msSiteStub(site, valuesAt[scalar]);
    for (let i = 0; i < words.length; i++)
      msWrite32(flash, stub + 4 * i, words[i]);
    const image = site.image === 'mpc' ? result.mpc : flash;
    msWrite32(image, site.at, Ba(MAPSWITCH_EXT + stub));
    stub += 20;
  }
  const end = (stub + MS_CHUNK - 1) & ~(MS_CHUNK - 1);
  msWrite32(flash, endAt, end);
  return end;
}

/** The directory as written: {scalars: [{offset, size, values}], sites: [{address, stock, stub, scalar}], end} or null. */
function msReadSites(area) {
  // `area` starts at MS_SITES
  if (!area || area.length < 16 || msReadAscii(area, 0, 4) !== MS_SITES_MAGIC)
    return null;
  const nScalars = msRead32(area, 4);
  const nSites = msRead32(area, 8);
  const end = msRead32(area, 12);
  let at = 16;
  const scalars = [];
  for (let i = 0; i < nScalars; i++) {
    if (at + 4 > area.length) return null;
    const head = msRead32(area, at);
    const size = head >>> 24;
    const offset = head & 0xffffff;
    at += 4;
    if (at + 8 * size > area.length) return null;
    const values = [];
    for (let m = 0; m < MS_MAX_MAPS + 1; m++)
      values.push(
        Uint8Array.from(area.subarray(at + m * size, at + (m + 1) * size))
      );
    scalars.push({ offset, size, values });
    at += msPad4(8 * size);
  }
  const sites = [];
  for (let i = 0; i < nSites; i++) {
    if (at + 16 > area.length) return null;
    sites.push({
      address: msRead32(area, at),
      stock: msRead32(area, at + 4),
      stub: msRead32(area, at + 8),
      scalar: msRead32(area, at + 12),
    });
    at += 16;
  }
  return { scalars, sites, end, length: at + 20 * nSites };
}

/** Put the stock instructions back at a build's patched sites, from its directory. */
function msRestoreSites(result) {
  const dir = msReadSites(result.flash.subarray(MS_SITES, MS_POOLS[0][1]));
  if (!dir) return 0;
  for (const s of dir.sites) {
    if (s.address < MAPSWITCH_MPC_LENGTH)
      msWrite32(result.mpc, s.address, s.stock);
    else msWrite32(result.flash, s.address - MAPSWITCH_EXT, s.stock);
  }
  return dir.sites.length;
}

/** The chunk layout of maps 2..N: like the block layout, at 256 bytes, with no window. */
function msChunkLayout(map1, maps, plan, poolStart) {
  const slots = new MsSlots();
  slots.add(poolStart / MS_CHUNK, MS_POOLS[0][1] / MS_CHUNK);
  slots.add(MS_POOLS[1][0] / MS_CHUNK, MS_POOLS[1][1] / MS_CHUNK);
  const chunksTotal = slots.free;
  const out = { ok: true, reason: null, maps: [], chunksTotal, chunksUsed: 0 };
  for (let i = 0; i < maps.length; i++) {
    const cal = maps[i];
    // the chunks this map must carry: what differs (less the bytes its
    // sites switch), the MS_TABLE_REACH before each (a table whose pointer
    // is there may run into it: redirected too) and the MS_TABLE_REACH after
    // (a table in it may run on: carried, not redirected)
    const differing = new Set();
    for (const c of plan.chunks) {
      for (let k = c * MS_CHUNK; k < (c + 1) * MS_CHUNK; k++)
        if (
          cal[k] !== map1[k] &&
          !plan.covered.has(k) &&
          !(k >= MS_CAL_TEST_SUM_OFFSET && k < MS_CAL_TEST_SUM_OFFSET + 8)
        ) {
          differing.add(c);
          break;
        }
    }
    const redirected = new Set(differing);
    for (const c of differing)
      for (let k = 1; k <= MS_TABLE_REACH; k++)
        if (c - k >= 0) redirected.add(c - k);
    const carried = new Set(redirected);
    for (const c of differing)
      for (let k = 1; k <= MS_TABLE_REACH; k++)
        if (c + k < MS_CHUNK_COUNT) carried.add(c + k);
    const runs = msRuns(carried).sort(
      (x, y) => y.last - y.first - (x.last - x.first)
    );
    const slot = new Map();
    for (const r of runs) {
      const n = r.last - r.first + 1;
      const at = slots.takeBest(n);
      if (at < 0) {
        out.ok = false;
        out.reason = `Map ${i + 2} does not fit: ${n * MS_CHUNK} more bytes of flash in one piece are needed and ${slots.free * MS_CHUNK} are free, in smaller pieces.`;
        return out;
      }
      for (let c = r.first; c <= r.last; c++) slot.set(c, at + c - r.first);
    }
    const table = new Uint16Array(MS_CHUNK_TABLE_ENTRIES).fill(MS_NO_BLOCK);
    for (const c of redirected) table[c] = slot.get(c);
    out.maps.push({
      index: i + 1,
      slot,
      table,
      carried: carried.size,
      differing: differing.size,
    });
  }
  out.chunksUsed = chunksTotal - slots.free;
  return out;
}

/** Write the header, the chunk tables and the chunks (the site area is already there). */
function msWriteChunkLayout(flash, maps, layout, sitesEnd) {
  const h = MS_HEADER;
  flash.fill(0xff, h, h + MS_CHUNK_TABLE_STRIDE);
  for (let i = 0; i < MS_HEADER_MAGIC.length; i++)
    flash[h + i] = MS_HEADER_MAGIC.charCodeAt(i);
  flash[h + MS_HEADER_COUNT] = maps.length + 1;
  flash[h + MS_HEADER_LAYOUT] = MS_SITE_GEN;
  msWrite32(flash, h + MS_HEADER_SITES_END, sitesEnd);
  for (let m = 0; m <= MS_MAX_MAPS; m++)
    msWrite32(flash, h + MS_HEADER_R2 + 4 * m, MS_R2_MAP1);
  for (const m of layout.maps) {
    const t = MS_HEADER + m.index * MS_CHUNK_TABLE_STRIDE;
    flash.fill(0xff, t, t + MS_CHUNK_TABLE_STRIDE);
    for (let e = 0; e < MS_CHUNK_TABLE_ENTRIES; e++)
      msWrite16(flash, t + 2 * e, m.table[e]);
    const cal = maps[m.index - 1];
    for (const [c, at] of m.slot)
      flash.set(cal.subarray(c * MS_CHUNK, (c + 1) * MS_CHUNK), at * MS_CHUNK);
  }
}

/** The chunk table of map `index` from the header-and-tables area (MS_HEADER up). */
function msChunkTableFrom(area, index) {
  const table = new Uint16Array(MS_CHUNK_TABLE_ENTRIES);
  for (let e = 0; e < MS_CHUNK_TABLE_ENTRIES; e++)
    table[e] = msRead16(area, index * MS_CHUNK_TABLE_STRIDE + 2 * e);
  return table;
}
const msHeaderIsChunks = (area) =>
  area &&
  area.length > MS_HEADER_LAYOUT &&
  area[MS_HEADER_LAYOUT] === MS_SITE_GEN;

/** Map `index` from map 1, its chunk table and its scalar values: chunks read through `chunkAt(flashOffset)`. */
function msMapFromChunkTable(map1, table, dir, index, chunkAt) {
  const cal = Uint8Array.from(map1);
  for (let c = 0; c < MS_CHUNK_COUNT; c++) {
    if (table[c] === MS_NO_BLOCK) continue;
    const data = chunkAt(table[c] * MS_CHUNK);
    if (!data || data.length !== MS_CHUNK) return null;
    cal.set(data, c * MS_CHUNK);
  }
  if (dir) for (const s of dir.scalars) cal.set(s.values[index], s.offset);
  return cal;
}
