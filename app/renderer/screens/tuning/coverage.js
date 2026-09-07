/**
 * @file Tuning screen: where each definition item lives in the image, and the
 * coverage map built from that -- a byte -> colour-slot index over the whole
 * BIN, so the hex pane SHOWS what the definition describes instead of making
 * you click 5,705 rows to find out. Neighbouring parameters get different
 * slots, so the boundary between two adjacent tables is visible rather than
 * one undifferentiated wash.
 *
 * Built once per (definition, BIN) because the hex view is virtualised: it
 * re-renders on every scroll frame, so the per-byte question has to be one
 * array read, not a search over the item list.
 */

/* exported tnItemAddress, tnItemByteRange, tnBuildCoverage, tnOwnerRecordAt, tnRegionAt, tnOwnerTitleAt, tnNearestMapped */

/** How far "nearest mapped byte" searches either way: 256 KB. */
const TN_NEAREST_LIMIT = 1 << 18;

/**
 * The first byte an item occupies, for the tree row's address column.
 * @param {XdfItem} item
 * @returns {number|null} null for a table without a Z axis or an empty patch.
 */
function tnItemAddress(item) {
  const h = tuningState.def.header;
  if (item.kind === 'constant' || item.kind === 'flag') {
    return window.XDF.resolveEmbedded(item.embed, h.baseOffset, h.defaults)
      .address;
  }
  if (item.kind === 'table') {
    const z = item.axes.find((a) => a.id === 'z');
    if (z)
      return window.XDF.resolveEmbedded(z.embed, h.baseOffset, h.defaults)
        .address;
  }
  if (item.kind === 'patch' && item.entries.length)
    return item.entries[0].address;
  return null;
}

/**
 * The contiguous byte span an item occupies (best-effort, for highlighting).
 * @param {XdfItem} item
 * @returns {ByteRange|null}
 */
function tnItemByteRange(item) {
  const h = tuningState.def.header;
  if (item.kind === 'constant') {
    const s = window.XDF.resolveEmbedded(item.embed, h.baseOffset, h.defaults);
    return {
      start: s.address,
      end: s.address + Math.max(1, Math.ceil(s.sizeBits / 8)),
    };
  }
  if (item.kind === 'flag') {
    const s = window.XDF.resolveEmbedded(item.embed, h.baseOffset, h.defaults);
    return { start: s.address, end: s.address + 1 };
  }
  if (item.kind === 'table') {
    const t = window.XDF.decodeTable(
      item,
      tuningState.bin || new Uint8Array(0),
      h
    );
    if (!t) return null;
    const first = window.XDF.tableCellAddress(t.embed, 0, 0);
    const last = window.XDF.tableCellAddress(t.embed, t.rows - 1, t.cols - 1);
    if (first == null || last == null) return null;
    const bytesPer = Math.max(1, Math.ceil(t.spec.sizeBits / 8));
    return {
      start: Math.min(first, last),
      end: Math.max(first, last) + bytesPer,
    };
  }
  if (item.kind === 'patch' && item.entries.length) {
    const e = item.entries[0];
    return { start: e.address, end: e.address + e.patchdata.length };
  }
  return null;
}

/**
 * Rebuild tuningState.cover / owner / owners / coverInfo for the current
 * (definition, image) pair; clears them when either is missing.
 * @returns {void}
 */
function tnBuildCoverage() {
  tuningState.cover = null;
  tuningState.owner = null;
  tuningState.owners = null;
  tuningState.coverInfo = null;
  const bin = tuningState.bin;
  const def = tuningState.def;
  if (!bin || !def) return;

  const cover = new Uint8Array(bin.length); // 0 = uncovered
  // WHICH item owns each byte, so clicking a shaded byte can open it. Kept
  // as a parallel typed array rather than objects-per-byte: a 1 MB image
  // would otherwise mean a million references. 0 = none, else index+1 into
  // `owners`.
  const owner = new Int32Array(bin.length);
  /** @type {OwnerRecord[]} */
  const owners = [];
  let slot = 0;
  let described = 0;
  let placed = 0;

  // Address order, so the rotation follows the layout of the file and
  // adjacent regions reliably differ.
  const ranges = [];
  for (const it of def.items) {
    let r;
    try {
      r = tnItemByteRange(it);
    } catch (e) {
      r = null;
    }
    if (!r || r.start == null || r.end == null) continue;
    const start = Math.max(0, r.start | 0);
    const end = Math.min(bin.length, r.end | 0);
    if (end <= start) continue;
    ranges.push([start, end, it]);
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  for (const [start, end, it] of ranges) {
    slot = (slot % TN_COVER_SLOTS) + 1; // 1..TN_COVER_SLOTS, never 0
    placed++;
    owners.push({ item: it, start, end });
    const oid = owners.length; // 1-based; 0 means "none"
    for (let i = start; i < end; i++) {
      if (cover[i] === 0) described++; // count each byte once
      cover[i] = slot;
      owner[i] = oid; // last writer wins, as with cover
    }
  }

  tuningState.cover = cover;
  tuningState.owner = owner;
  tuningState.owners = owners;
  tuningState.coverInfo = { described, total: bin.length, items: placed };
}

/**
 * The record of the item owning byte `off`, or null when the definition
 * describes nothing there (or no map is built).
 * @param {number} off
 * @returns {OwnerRecord|null}
 */
function tnOwnerRecordAt(off) {
  const owner = tuningState.owner;
  const owners = tuningState.owners;
  if (!owner || !owners || off < 0 || off >= owner.length) return null;
  const oid = owner[off];
  return oid ? owners[oid - 1] || null : null;
}

/**
 * The byte span and name of the parameter owning `off`, for the hex view's
 * click-to-select.
 * @param {number} off
 * @returns {{ start: number, end: number, title: string }|null}
 */
function tnRegionAt(off) {
  const rec = tnOwnerRecordAt(off);
  return rec
    ? { start: rec.start, end: rec.end, title: rec.item.title || '' }
    : null;
}

/**
 * The name of the parameter owning `off`, for the context menu.
 * @param {number} off
 * @returns {string|null}
 */
function tnOwnerTitleAt(off) {
  const rec = tnOwnerRecordAt(off);
  return rec && rec.item ? rec.item.title || null : null;
}

/**
 * Nearest byte the definition actually describes, searching outward from
 * `off`. Bounded: a right-click must not walk a 1 MB array, and if there is
 * nothing within a few hundred KB the honest answer is "nowhere near".
 * @param {number} off
 * @returns {number|null}
 */
function tnNearestMapped(off) {
  const owner = tuningState.owner;
  if (!owner || !owner.length) return null;
  for (let d = 1; d <= TN_NEAREST_LIMIT; d++) {
    const a = off - d;
    if (a >= 0 && owner[a]) return a;
    const b = off + d;
    if (b < owner.length && owner[b]) return b;
    if (a < 0 && b >= owner.length) break; // ran off both ends
  }
  return null;
}
