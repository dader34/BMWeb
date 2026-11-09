/**
 * @file BMWeb Scanner: the Unit info window's Read EEPROM / Write EEPROM and
 * its Internal HEX-Editor, the reference scanner's way (BMW Scanner 1.4.0.7).
 *
 * The body module (ZKE), from its handlers (read 0x5DE2C8, write 0x5DE974,
 * range 0x5DD798), its variant routine (0x49C710: the variant is chosen by
 * the diagnostic index, scannerZkeVariant) and the USB capture of a read and a write on an E46
 * (capture-eeprom-frames.txt):
 *   range by the unit's variant   9: 0x2800 +0x400   8: 0x0D80 +0x280
 *                                 3, 4: 0x0D00 +0x300   6: 0x3000 +0x400
 *                                 other: by ident byte 14, below 0x30
 *                                 0x0D00 +0x300, else 0x3000 +0x400
 *   read  sixteen bytes at a time: variant 9 DS2 06 10 hi lo 00 (adapter
 *         word 514C); variant 8 word 4733, the rest word 8ED3
 *   write the whole range from the editor: variants 8 and 9 one byte at a
 *         time, DS2 07 hi lo b (word A394), an A1 answer asked once more;
 *         the rest sixteen bytes at a time (word 5348)
 * Telegrams the capture did not show (the words 4733, 8ED3, 5348) go only
 * over the reference's own cable, which knows them.
 */

/* exported SCANNER_EEPROM, scannerZkeVariant, scannerEepromPlan, scannerEepromRead, scannerEepromWrite, scannerHexEditor */

/** The ZKE's EEPROM range per variant (0x5DD798). */
const SCANNER_EEPROM = {
  ZKE: {
    9: { base: 0x2800, size: 0x400 },
    8: { base: 0x0d80, size: 0x280 },
    3: { base: 0x0d00, size: 0x300 },
    4: { base: 0x0d00, size: 0x300 },
    6: { base: 0x3000, size: 0x400 },
  },
};

/**
 * The reference's variant of a body module (its variant routine 0x49C710,
 * ZKE branch at 0x4A0954): a switch on the diagnostic index, byte 9 of the
 * DS2 identification answer -- "00 10 A0 86 94 48 40 20 05 46 .." is DI
 * 0x46, variant 9.
 * @param {number[]|null} raw - The ZKE's identification answer.
 * @returns {number} The variant; 0 for a DI the reference has none for.
 */
function scannerZkeVariant(raw) {
  if (!raw || raw.length < 10) return 0;
  const di = raw[9];
  if (di < 0x20) return 7;
  if (di <= 0x22) return 3;
  if (di === 0x25) return 5;
  if (di >= 0x40 && di <= 0x42) return 8;
  if (di === 0x45 || di === 0x46) return 9;
  if (di >= 0x50 && di <= 0x52) return 8;
  if (di === 0x55 || di === 0x56) return 9;
  if (di === 0x80 || di === 0x81) return 4;
  if (di === 0x85) return 6;
  if (di === 0xa0) return 1;
  if (di === 0xa3) return 2;
  return 0;
}

/**
 * What Read / Write EEPROM do for a unit.
 * @param {ScannerModule} m
 * @param {number|null} variant - The reference's variant number; null to
 *   take it from the identification answer as the reference does.
 * @param {number[]|null} raw - The unit's identification answer.
 * @returns {{base: number, size: number, variant: number|null,
 *   readWord: number, writeWord: number, ds2: boolean, byteWrite: boolean}|null}
 */
function scannerEepromPlan(m, variant, raw) {
  const t = SCANNER_EEPROM[m.name];
  if (!t) return null;
  if (variant == null && m.name === 'ZKE') variant = scannerZkeVariant(raw);
  let r = variant != null ? t[variant] : null;
  if (!r)
    r =
      raw && raw.length > 14 && raw[14] < 0x30
        ? { base: 0x0d00, size: 0x300 }
        : { base: 0x3000, size: 0x400 };
  return {
    ...r,
    variant,
    readWord: variant === 9 ? 0x514c : variant === 8 ? 0x4733 : 0x8ed3,
    writeWord: variant === 8 || variant === 9 ? 0xa394 : 0x5348,
    // the DS2 telegrams are known for variant 9 (read and write)
    ds2: variant === 9,
    byteWrite: variant === 8 || variant === 9,
  };
}

/**
 * A link for these: `ds2` as everywhere, `word` (reference cable only) for
 * an adapter word the capture did not show.
 * @typedef {ScannerLink & {word?: (w: number, addr: number,
 *   payload: number[]) => Promise<number[]|null>}} ScannerEepromLink
 */

/**
 * Read the range.
 * @param {ScannerEepromLink} link
 * @param {ScannerModule} m
 * @param {ReturnType<typeof scannerEepromPlan>} plan
 * @param {(done: number, size: number) => void} [progress]
 * @param {() => boolean} [cancelled]
 * @returns {Promise<Uint8Array>}
 */
async function scannerEepromRead(link, m, plan, progress, cancelled) {
  const out = new Uint8Array(plan.size);
  for (let at = 0; at < plan.size; at += 0x10) {
    if (cancelled && cancelled()) throw new Error('stopped');
    const a = plan.base + at;
    const hi = (a >> 8) & 0xff;
    const lo = a & 0xff;
    let r;
    if (plan.ds2) r = await link.ds2(m.address, [0x06, 0x10, hi, lo, 0x00]);
    else if (link.word)
      r = await link.word(
        plan.readWord,
        m.address,
        plan.variant === 8 ? [hi, lo] : [0, 0, 0, hi, lo, 0x10]
      );
    else
      throw new Error(
        `this ${m.name} variant is read with a command only the PA Soft cable knows`
      );
    if (!r || r[2] !== 0xa0)
      throw new Error(
        `${m.name} refused the read at ${a.toString(16).toUpperCase()}`
      );
    out.set(r.slice(3, 3 + Math.min(0x10, plan.size - at)), at);
    if (progress) progress(at + 0x10, plan.size);
  }
  return out;
}

/**
 * Write the whole range from `data`, then read it back.
 * @param {ScannerEepromLink} link
 * @param {ScannerModule} m
 * @param {ReturnType<typeof scannerEepromPlan>} plan
 * @param {Uint8Array} data - Exactly plan.size bytes.
 * @param {(done: number, size: number) => void} [progress]
 * @param {() => boolean} [cancelled]
 * @returns {Promise<{refused: number[], differ: number[]}>} Offsets the unit
 *   would not take, and offsets that read back different.
 */
async function scannerEepromWrite(link, m, plan, data, progress, cancelled) {
  if (data.length !== plan.size)
    throw new Error(
      `the editor holds ${data.length} bytes; ${m.name} EEPROM is ${plan.size}`
    );
  const refused = [];
  const step = plan.byteWrite ? 1 : 0x10;
  for (let at = 0; at < plan.size; at += step) {
    if (cancelled && cancelled()) throw new Error('stopped');
    const a = plan.base + at;
    const hi = (a >> 8) & 0xff;
    const lo = a & 0xff;
    let r = null;
    for (let tries = 0; tries < 2; tries++) {
      if (plan.ds2) r = await link.ds2(m.address, [0x07, hi, lo, data[at]]);
      else if (link.word)
        r = plan.byteWrite
          ? await link.word(plan.writeWord, m.address, [hi, lo, data[at]])
          : await link.word(plan.writeWord, m.address, [
              hi,
              lo,
              0x10,
              ...data.slice(at, at + 0x10),
            ]);
      else
        throw new Error(
          `this ${m.name} variant is written with a command only the PA Soft cable knows`
        );
      // A1: busy -- the reference asks once more 1.3 s later, then goes on
      if (r && r[2] === 0xa1 && tries === 0) {
        await link.sleep(1300);
        continue;
      }
      break;
    }
    if (!r || r[2] !== 0xa0) refused.push(at);
    if (progress) progress(at + step, plan.size);
  }
  const back = await scannerEepromRead(link, m, plan, null, cancelled);
  const differ = [];
  for (let i = 0; i < plan.size; i++) if (back[i] !== data[i]) differ.push(i);
  return { refused, differ, back };
}

/**
 * The Internal HEX-Editor: the reference's THexEditor in PanelEditor --
 * offset, sixteen bytes, their characters; a byte is changed by clicking
 * it and typing two hex digits. Shift+click / Shift+arrows select a run;
 * Backspace / Delete set the selection (or the byte) to FF. Find takes hex
 * bytes or text.
 * @param {HTMLElement} host - The HexEditor1 control.
 * @param {(text: string) => void} status - Panel7.
 * @returns {{set: (data: Uint8Array, base: number, name: string) => void,
 *   get: () => Uint8Array|null, name: () => string,
 *   find: (q: string, next?: boolean) => boolean}}
 */
function scannerHexEditor(host, status) {
  let data = null;
  let base = 0;
  let name = '';
  let cursor = -1;
  let anchor = -1;
  let found = -1;
  let typed = '';
  host.innerHTML = '';
  const view = document.createElement('div');
  view.className = 'scn-hex';
  view.tabIndex = 0;
  host.appendChild(view);
  const h2 = (b) => b.toString(16).toUpperCase().padStart(2, '0');
  const ch = (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.');
  const paint = () => {
    if (!data) {
      view.innerHTML = '';
      return;
    }
    const rows = [];
    for (let at = 0; at < data.length; at += 16) {
      let hex = '';
      let txt = '';
      for (let i = at; i < Math.min(at + 16, data.length); i++) {
        const lo = Math.min(anchor < 0 ? cursor : anchor, cursor);
        const hi = Math.max(anchor < 0 ? cursor : anchor, cursor);
        const cls =
          i === cursor
            ? ' class="scn-hex-cur"'
            : i >= lo && i <= hi && cursor >= 0
              ? ' class="scn-hex-sel"'
              : '';
        hex += `<span data-i="${i}"${cls}>${h2(data[i])}</span>`;
        txt += `<span data-i="${i}"${cls}>${esc(ch(data[i]))}</span>`;
      }
      const off = (base + at).toString(16).toUpperCase().padStart(6, '0');
      rows.push(
        `<div class="scn-hex-row"><span class="scn-hex-off">${off}</span><span class="scn-hex-b">${hex}</span><span class="scn-hex-t">${txt}</span></div>`
      );
    }
    view.innerHTML = rows.join('');
  };
  const off = (i) => (base + i).toString(16).toUpperCase().padStart(6, '0');
  const range = () => {
    const a = anchor < 0 ? cursor : anchor;
    return [Math.min(a, cursor), Math.max(a, cursor)];
  };
  const show = () => {
    if (cursor < 0) return;
    const [lo, hi] = range();
    status(lo === hi ? off(cursor) : `${off(lo)}-${off(hi)}`);
  };
  view.onclick = (e) => {
    const t = e.target.closest('[data-i]');
    if (!t) return;
    const i = Number(t.dataset.i);
    if (e.shiftKey && cursor >= 0) {
      if (anchor < 0) anchor = cursor;
    } else anchor = -1;
    cursor = i;
    typed = '';
    paint();
    show();
    view.focus();
  };
  view.onkeydown = (e) => {
    // the editor keeps its keys: Backspace here is never the app's "back"
    if (e.key !== 'Escape' && e.key !== 'Tab') e.stopPropagation();
    if (!data || cursor < 0) return;
    const move = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -16, ArrowDown: 16 };
    if (move[e.key] != null) {
      if (e.shiftKey) {
        if (anchor < 0) anchor = cursor;
      } else anchor = -1;
      cursor = Math.max(0, Math.min(data.length - 1, cursor + move[e.key]));
      typed = '';
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      const [lo, hi] = range();
      data.fill(0xff, lo, hi + 1);
      typed = '';
    } else if (/^[0-9a-fA-F]$/.test(e.key)) {
      anchor = -1;
      typed += e.key;
      if (typed.length === 2) {
        data[cursor] = parseInt(typed, 16);
        typed = '';
        if (cursor < data.length - 1) cursor++;
      }
    } else return;
    e.preventDefault();
    paint();
    show();
    const cur = view.querySelector('.scn-hex-cur');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  };
  const parseQuery = (q) => {
    const hex = q.replace(/\s+/g, '');
    if (/^([0-9a-fA-F]{2})+$/.test(hex))
      return hex.match(/../g).map((x) => parseInt(x, 16));
    return Array.from(q, (c) => c.charCodeAt(0) & 0xff);
  };
  return {
    set(d, b, n) {
      data = d;
      base = b;
      name = n;
      cursor = -1;
      anchor = -1;
      found = -1;
      paint();
      status(n);
    },
    get: () => data,
    name: () => name,
    find(q, next = false) {
      if (!data || !q) return false;
      const pat = parseQuery(q);
      for (let i = next ? found + 1 : 0; i + pat.length <= data.length; i++) {
        if (pat.every((b, k) => data[i + k] === b)) {
          found = i;
          cursor = i;
          anchor = pat.length > 1 ? i + pat.length - 1 : -1;
          paint();
          show();
          const cur = view.querySelector('.scn-hex-cur');
          if (cur) cur.scrollIntoView({ block: 'center' });
          return true;
        }
      }
      return false;
    },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SCANNER_EEPROM,
    scannerZkeVariant,
    scannerEepromPlan,
    scannerEepromRead,
    scannerEepromWrite,
  };
}
