/**
 * @file Tuning screen: the virtualized hex grid. Only the rows in (and near)
 * the viewport exist in the DOM; a spacer div carries the full scroll height,
 * so a multi-MB image scrolls without laying out hundreds of thousands of
 * rows. Owns the cursor and selection, the find box, the right-click menu,
 * the keyboard, and raw byte editing. Reads tuningState for the bytes, the
 * spotlight range and the coverage overlay; writes go back through the hooks
 * so the screen recounts changes and schedules the session save.
 */

/* exported createHexView */

/**
 * @typedef {Object} HexViewHooks
 * @property {(off: number, opts?: { modal?: boolean }) => boolean} [onByteClick] -
 *   Open the parameter owning a byte; `modal:false` selects without a dialog.
 * @property {(off: number) => ({ start: number, end: number, title: string }|null)} [regionAt] -
 *   The byte span and name of the parameter owning `off`, so a plain click
 *   on a shaded byte becomes a whole-region selection.
 * @property {(off: number, val: number) => boolean} [onWriteByte]
 * @property {(off: number, buf: Uint8Array) => boolean} [onWriteBytes] - One
 *   call for a range: a fill or a paste is a single edit, so it should be
 *   one write (and one undo step), not N.
 * @property {(off: number) => (number|null)} [nearestMapped] - Nearest byte
 *   the definition describes, for the context menu's way out of an
 *   undescribed region.
 * @property {(off: number) => (string|null)} [ownerAt] - What the context
 *   menu shows on "Open ..." -- the name of the parameter that owns this
 *   byte, or null when the definition describes nothing here.
 */

/**
 * @typedef {Object} HexMenuItem
 * @property {string} [label]
 * @property {string|null} [sub] - Secondary text (an address, or the reason it is disabled).
 * @property {boolean} [disabled]
 * @property {boolean} [sep] - A separator row.
 * @property {() => void} [run]
 */

/** Fallback viewport height when the pane has not been laid out yet. */
const TN_HEX_FALLBACK_VH = 480;
/** Debounce for the find box: a full-image scan per keystroke is wasted. */
const TN_FIND_DEBOUNCE_MS = 140;
/** Bytes per visual group in a row: a subtle gap after every eighth byte. */
const TN_HEX_ASCII_GROUP = 8;

/**
 * Build the hex view over the screen's elements.
 * @param {TuningEls} els
 * @param {HexViewHooks} [hooks]
 * @returns {HexView}
 */
function createHexView(els, hooks = {}) {
  const { ROW_H, OVERSCAN } = TUNE_HEX;
  let raf = null;
  let cols = TUNE_HEX.BYTES_PER_ROW;

  // Cursor / selection. `anchor` is where the gesture started and `cursor` is
  // the live end, so a drag or a shift-click extends in either direction
  // without needing a separate "direction" flag. Selection is the inclusive
  // range between them; a bare cursor is a one-byte selection.
  let cursor = 0;
  let anchor = 0;
  let dragging = false;
  // Set when the selection IS a mapped region (a click on a shaded byte, or
  // an item picked in the tree): { label }. In that mode the crosshair and
  // the single cursor byte are not drawn -- the region is the thing selected,
  // not one byte inside it. Any cursor move clears it.
  let region = null;

  // Find state. `hits` holds match START offsets, sorted -- a plain sorted
  // Int32Array so the render loop can binary-search a row's span in O(log n)
  // instead of scanning every match for every byte.
  const find = { pattern: null, hits: null, at: -1, mode: 'hex' };

  const clampOff = (o) => {
    const n = tuningState.bin ? tuningState.bin.length : 0;
    if (!n) return 0;
    return o < 0 ? 0 : o >= n ? n - 1 : o;
  };
  const selStart = () => Math.min(anchor, cursor);
  const selEnd = () => Math.max(anchor, cursor); // inclusive
  const viewportHeight = () => els.hexScroll.clientHeight || TN_HEX_FALLBACK_VH;
  const inSelection = (off) =>
    off >= selStart() && off <= selEnd() && selEnd() > selStart();

  // ---- find -----------------------------------------------------------------
  function runFind() {
    const raw = els.findQ ? els.findQ.value : '';
    const bytes = tuningState.bin;
    find.pattern = null;
    find.hits = null;
    find.at = -1;
    if (bytes && raw.trim()) {
      const pat =
        find.mode === 'hex' ? tnParseHexPattern(raw) : tnParseTextPattern(raw);
      if (pat) {
        find.pattern = pat;
        find.hits = Int32Array.from(tnSearchAll(bytes, pat));
      }
    }
    paintFindCount();
    schedule();
  }

  function paintFindCount() {
    if (!els.findCount) return;
    if (!find.hits) {
      els.findCount.textContent = '';
      return;
    }
    if (!find.hits.length) {
      els.findCount.textContent = 'no match';
      return;
    }
    const nth = find.at >= 0 ? `${find.at + 1}/` : '';
    els.findCount.textContent = `${nth}${find.hits.length} match${find.hits.length === 1 ? '' : 'es'}`;
  }

  function stepFind(dir) {
    if (!find.hits || !find.hits.length) return;
    let idx;
    if (find.at < 0) {
      // First step starts from the cursor rather than from the top, so the
      // search follows where you were already looking.
      idx = tnLowerBound(find.hits, dir > 0 ? cursor + 1 : cursor);
      if (dir < 0) idx -= 1;
    } else {
      idx = find.at + dir;
    }
    if (idx < 0) idx = find.hits.length - 1;
    if (idx >= find.hits.length) idx = 0;
    find.at = idx;
    const off = find.hits[idx];
    setCursor(off, false);
    // select the whole match, so its length is visible in the status strip
    anchor = off;
    cursor = clampOff(off + find.pattern.length - 1);
    scrollIntoView(off);
    paintFindCount();
    schedule();
  }

  // ---- status strip ---------------------------------------------------------
  function paintStatus() {
    const bytes = tuningState.bin;
    if (region && bytes) {
      // a whole parameter is selected: name it, and give its span
      const s = selStart();
      const e = selEnd();
      if (els.hsCur) els.hsCur.textContent = region.label || `0x${tnHexOff(s)}`;
      if (els.hsSel)
        els.hsSel.textContent = `0x${tnHexOff(s)}–0x${tnHexOff(e)} · ${(e - s + 1).toLocaleString()} bytes`;
      return;
    }
    if (els.hsCur) {
      els.hsCur.textContent = bytes
        ? `0x${tnHexOff(cursor)} · ${cursor.toLocaleString()} · row ${Math.floor(cursor / cols)} col ${cursor % cols}`
        : '';
    }
    if (els.hsSel) {
      if (!bytes) {
        els.hsSel.textContent = '';
        return;
      }
      const s = selStart();
      const e = selEnd();
      const n = e - s + 1;
      els.hsSel.textContent =
        n > 1
          ? `sel 0x${tnHexOff(s)}–0x${tnHexOff(e)} · ${n.toLocaleString()} bytes`
          : `1 byte`;
    }
  }

  // ---- rendering ------------------------------------------------------------
  function rowHtml(off, bytes, hitIdx) {
    const len = Math.min(cols, bytes.length - off);
    const hl = tuningState.highlight;
    // the coverage map, when a definition is open and the overlay is on
    const cover = tuningState.coverOn ? tuningState.cover : null;
    const ss = selStart();
    const se = selEnd();
    const curRow =
      !region && Math.floor(cursor / cols) === Math.floor(off / cols);
    const curCol = region ? -1 : cursor % cols;
    const patLen = find.pattern ? find.pattern.length : 0;
    let hexCells = '';
    let ascii = '';
    for (let i = 0; i < cols; i++) {
      // a subtle gap every 8 bytes, the way every real hex editor groups them
      const gap = i > 0 && i % TN_HEX_ASCII_GROUP === 0 ? ' tn-hb-gap' : '';
      if (i >= len) {
        hexCells += `<span class="tn-hb tn-hb-pad${gap}">  </span>`;
        ascii += ' ';
        continue;
      }
      const abs = off + i;
      const b = bytes[abs];
      const changed = tuningState.orig && tuningState.orig[abs] !== b;
      const inHl = hl && abs >= hl.start && abs < hl.end;
      const inSel = abs >= ss && abs <= se;
      // one array read -- this runs for every byte on every scroll frame
      const slot = cover ? cover[abs] : 0;
      // hitIdx was resolved once for the row; walking it forward is O(1) here
      let inHit = false;
      if (patLen) {
        while (
          hitIdx.i < hitIdx.hits.length &&
          hitIdx.hits[hitIdx.i] + patLen <= abs
        )
          hitIdx.i++;
        inHit = hitIdx.i < hitIdx.hits.length && hitIdx.hits[hitIdx.i] <= abs;
      }
      let cls = 'tn-hb' + gap;
      if (slot) cls += ' tn-cv tn-cv' + slot;
      if (changed) cls += ' tn-hb-changed';
      if (inHl) cls += ' tn-hb-hl';
      if (inHit) cls += ' tn-hb-hit';
      if (inSel) cls += ' tn-hb-sel';
      if (!region && abs === cursor) cls += ' tn-hb-cur';
      else if (curRow || i === curCol) cls += ' tn-hb-cross';
      hexCells += `<span class="${cls}" data-off="${abs}" title="0x${abs.toString(16).toUpperCase()}">${tnHex2(b)}</span>`;
      const ch = b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
      const acls =
        'tn-ha' +
        (inHl ? ' tn-ha-hl' : '') +
        (changed ? ' tn-ha-changed' : '') +
        (inSel ? ' tn-ha-sel' : '') +
        (inHit ? ' tn-ha-hit' : '');
      ascii += `<span class="${acls}" data-off="${abs}">${ch === '<' ? '&lt;' : ch === '&' ? '&amp;' : ch}</span>`;
    }
    return (
      `<div class="tn-hex-row${curRow ? ' tn-hex-row-cur' : ''}" style="height:${ROW_H}px">` +
      `<span class="tn-hoff">${tnHexOff(off)}</span>` +
      `<span class="tn-hbytes">${hexCells}</span>` +
      `<span class="tn-hascii">${ascii}</span></div>`
    );
  }

  function render() {
    raf = null;
    const bytes = tuningState.bin;
    if (!bytes) {
      els.hexEmpty.hidden = false;
      els.hexSpacer.hidden = true;
      // drop the rows too: the container is hidden, but leaving a previous
      // file's bytes in the DOM means Clear only *looks* like it worked, and
      // anything walking the document still finds them
      els.hexWindow.innerHTML = '';
      if (els.inspRows) els.inspRows.innerHTML = '';
      paintStatus();
      return;
    }
    els.hexEmpty.hidden = true;
    els.hexSpacer.hidden = false;
    const totalRows = Math.ceil(bytes.length / cols);
    els.hexSpacer.style.height = totalRows * ROW_H + 'px';
    const st = els.hexScroll.scrollTop;
    const vh = viewportHeight();
    const first = Math.max(0, Math.floor(st / ROW_H) - OVERSCAN);
    const count = Math.min(
      totalRows - first,
      Math.ceil(vh / ROW_H) + 2 * OVERSCAN
    );
    els.hexWindow.style.transform = `translateY(${first * ROW_H}px)`;
    // Seed the match cursor once for the whole window rather than per byte:
    // one binary search, then a forward walk that never rewinds.
    const patLen = find.pattern ? find.pattern.length : 0;
    const hitIdx = { hits: find.hits || [], i: 0 };
    if (patLen && find.hits && find.hits.length) {
      hitIdx.i = Math.max(
        0,
        tnLowerBound(find.hits, first * cols - patLen + 1)
      );
    }
    let html = '';
    for (let r = 0; r < count; r++) {
      html += rowHtml((first + r) * cols, bytes, hitIdx);
    }
    els.hexWindow.innerHTML = html;
    if (els.hexMeta) {
      els.hexMeta.textContent = `${totalRows.toLocaleString()} rows · ${fmtBytes(bytes.length)}`;
    }
    paintStatus();
    // The inspector is always on: it is the panel that makes a hex dump
    // readable, and a toggle only ever hid the useful half of the pane.
    if (els.inspRows)
      tnPaintInspector(els.inspRows, bytes, region ? selStart() : cursor);
  }

  const schedule = () => {
    if (raf == null) raf = requestAnimationFrame(render);
  };
  els.hexScroll.addEventListener('scroll', schedule, { passive: true });

  // Keep the cursor row on screen without yanking the view when it is already
  // visible -- scrollTo() always centres, which is jarring for arrow keys.
  function scrollIntoView(off) {
    const row = Math.floor(off / cols);
    const top = row * ROW_H;
    const vh = viewportHeight();
    const st = els.hexScroll.scrollTop;
    if (top < st) els.hexScroll.scrollTop = top;
    else if (top + ROW_H > st + vh) els.hexScroll.scrollTop = top + ROW_H - vh;
  }

  // Scroll so the row holding `off` sits mid-pane.
  function centreOn(off) {
    const row = Math.floor(off / cols);
    els.hexScroll.scrollTop = Math.max(0, row * ROW_H - viewportHeight() / 2);
  }

  function setCursor(off, extend) {
    region = null;
    cursor = clampOff(off);
    if (!extend) anchor = cursor;
    // Repaint: the status strip and the data inspector both read `cursor`,
    // and a click moves it without any scroll to trigger render() on its own.
    // moveCursor() schedules too -- double-scheduling is free, the rAF guard
    // collapses it to one frame.
    schedule();
  }

  function moveCursor(delta, extend) {
    setCursor(cursor + delta, extend);
    scrollIntoView(cursor);
    schedule();
  }

  // ---- pointer selection ----------------------------------------------------
  function offsetFromEvent(e) {
    const cell = e.target.closest && e.target.closest('[data-off]');
    return cell ? Number(cell.dataset.off) : null;
  }

  els.hexWindow.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !tuningState.bin) return;
    const off = offsetFromEvent(e);
    if (off == null) return;
    // A plain click on a byte the coverage map shades selects the WHOLE
    // parameter and opens it in the tree, instead of parking a one-byte
    // cursor with a crosshair through it. Only with the map on: with it off
    // nothing is shaded and this is a plain hex editor. Shift keeps extending
    // a selection, and the second click of a double-click is left to the raw
    // edit handler below.
    if (
      !e.shiftKey &&
      e.detail < 2 &&
      tuningState.coverOn &&
      typeof hooks.regionAt === 'function' &&
      hooks.regionAt(off)
    ) {
      e.preventDefault();
      els.hexScroll.focus();
      dragging = false;
      if (typeof hooks.onByteClick === 'function')
        hooks.onByteClick(off, { modal: false });
      return;
    }
    setCursor(off, e.shiftKey); // shift-click extends from the old anchor
    dragging = true;
    // Text selection would fight the drag, and the row is `white-space: pre`
    // so the browser's own selection is useless here anyway.
    e.preventDefault();
    els.hexScroll.focus();
    schedule();
  });

  els.hexWindow.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const off = offsetFromEvent(e);
    if (off == null || off === cursor) return;
    region = null;
    cursor = clampOff(off);
    schedule();
  });

  // on window, not the pane: a drag that ends off the grid must still end
  window.addEventListener('mouseup', () => {
    dragging = false;
  });

  // Click-to-open lives in the mousedown handler above. An earlier attempt
  // was removed because the tree's spotlight scrolled via setCursor() and
  // collapsed the freshly selected region back to one byte; the spotlight now
  // goes through selectRegion() and leaves the selection alone on tree
  // re-renders, so the two no longer fight. The right-click menu's "Open ..."
  // is the same action, plus the table modal.

  // ---- context menu ---------------------------------------------------------
  //
  // Right-click replaces the browser's own menu, which offers nothing useful
  // over a hex dump. The actions are the ones a tuner reaches for at a byte:
  // move data in and out, write a value across a range, and jump to whatever
  // parameter owns this address.
  //
  // The menu acts on the SELECTION when the clicked byte is inside one, and on
  // the single clicked byte otherwise -- so right-clicking away from a
  // selection does the obvious local thing instead of silently operating on
  // bytes elsewhere in the file.
  let menuEl = null;

  function closeMenu() {
    if (!menuEl) return;
    menuEl.remove();
    menuEl = null;
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onMenuKey, true);
  }
  const onDocDown = (e) => {
    if (menuEl && !menuEl.contains(e.target)) closeMenu();
  };
  const onMenuKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeMenu();
    }
  };

  // bytes -> "DE AD BE EF"
  function hexOfRange(s, e) {
    const bytes = tuningState.bin;
    const out = [];
    for (let i = s; i <= e && i < bytes.length; i++) out.push(tnHex2(bytes[i]));
    return out.join(' ');
  }

  // Write text to the clipboard without the async API, which is
  // permission-gated and silently denied on plain http:// origins. A hidden
  // textarea inside the user-gesture stack is the route that actually works.
  function copyText(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (err) {
      return false;
    }
  }

  // Hand a buffer to the owner: one call for the range when the hook exists,
  // else byte by byte.
  function writeBuffer(off, buf) {
    if (typeof hooks.onWriteBytes === 'function') {
      hooks.onWriteBytes(off, buf);
    } else if (typeof hooks.onWriteByte === 'function') {
      for (let i = 0; i < buf.length; i++) hooks.onWriteByte(off + i, buf[i]);
    }
  }

  async function pasteHexAt(off) {
    let text = '';
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        text = await navigator.clipboard.readText();
      }
    } catch (err) {
      text = '';
    }
    if (!text) {
      text =
        (await inputDialog({
          title: 'Paste bytes',
          body:
            `Paste hex bytes to write at 0x${tnHexOff(off)}. ` +
            'Spaces optional; 0x prefixes ignored.',
          kind: 'text',
          example: 'DE AD BE EF',
          confirmLabel: 'Write',
        })) || '';
    }
    const clean = String(text)
      .replace(/0x/gi, '')
      .replace(/[^0-9a-fA-F]/g, '');
    if (clean.length < 2) return;
    const bytes = [];
    for (let i = 0; i + 1 < clean.length; i += 2)
      bytes.push(parseInt(clean.substr(i, 2), 16));
    const room = tuningState.bin.length - off;
    const n = Math.min(bytes.length, room);
    if (n <= 0) return;
    writeBuffer(off, new Uint8Array(bytes.slice(0, n)));
    schedule();
  }

  // "FF" / "0xff" / "255" -> 0..255, or null when it is not a byte.
  function parseByteText(v) {
    const raw = String(v).trim();
    const parsed =
      /^0x/i.test(raw) || /[a-f]/i.test(raw)
        ? parseInt(raw.replace(/^0x/i, ''), 16)
        : parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 0xff) return null;
    return parsed & 0xff;
  }

  // Fill a range with one byte value -- the "write values" case, and the one
  // that most wants a range rather than a single cell.
  async function fillRange(s, e) {
    const n = e - s + 1;
    const v = await inputDialog({
      title: `Write value across ${n} byte${n === 1 ? '' : 's'}`,
      body:
        `Every byte from 0x${tnHexOff(s)} to 0x${tnHexOff(e)} will be set to ` +
        'this value. Enter hex (00-FF) or decimal.',
      kind: 'text',
      example: 'FF',
      confirmLabel: 'Write',
      danger: true,
    });
    if (v == null) return;
    const byte = parseByteText(v);
    if (byte == null) return;
    writeBuffer(s, new Uint8Array(n).fill(byte));
    schedule();
  }

  /**
   * The menu's items for a right-click at `off`.
   * @param {number} off
   * @returns {HexMenuItem[]}
   */
  function menuItems(off) {
    // act on the selection only when the click landed inside it
    const inSel = inSelection(off);
    const s = inSel ? selStart() : off;
    const e = inSel ? selEnd() : off;
    const n = e - s + 1;
    const owns =
      typeof hooks.ownerAt === 'function' ? hooks.ownerAt(off) : null;

    /** @type {HexMenuItem[]} */
    const items = [
      {
        label: `Copy ${n} byte${n === 1 ? '' : 's'} as hex`,
        run: () => copyText(hexOfRange(s, e)),
      },
      {
        label: 'Copy offset',
        sub: `0x${tnHexOff(off)}`,
        run: () => copyText('0x' + tnHexOff(off)),
      },
      { sep: true },
      { label: 'Paste hex here', run: () => pasteHexAt(off) },
      {
        label: n === 1 ? 'Write value…' : `Fill ${n} bytes…`,
        run: () => fillRange(s, e),
      },
      { label: 'Edit this byte…', run: () => editRawByte(off) },
      { sep: true },
      {
        label: owns ? `Open ${owns}` : 'Open in table view',
        // Say WHY it is unavailable. A greyed item with no reason reads as a
        // bug; "no parameter here" is the actual answer, and it points at the
        // real situation -- the definition describes other addresses, not
        // this one.
        sub: owns ? null : 'no parameter here',
        disabled: !owns,
        run: () => {
          if (typeof hooks.onByteClick === 'function') hooks.onByteClick(off);
        },
      },
    ];

    // ...and offer a way OUT of an undescribed region, rather than leaving a
    // dead item as the only answer. Only when there is somewhere to go.
    const near =
      typeof hooks.nearestMapped === 'function'
        ? hooks.nearestMapped(off)
        : null;
    if (!owns && near != null) {
      items.push({
        label: 'Go to nearest mapped byte',
        sub: '0x' + tnHexOff(near),
        run: () => {
          setCursor(near, false);
          scrollIntoView(near);
          schedule();
        },
      });
    }
    return items;
  }

  function openMenu(x, y, off) {
    closeMenu();
    if (!tuningState.bin) return;
    const items = menuItems(off);

    const m = document.createElement('div');
    m.className = 'tn-ctx';
    m.innerHTML = items
      .map((it, i) =>
        it.sep
          ? '<div class="tn-ctx-sep"></div>'
          : `<button type="button" class="tn-ctx-item${it.disabled ? ' disabled' : ''}"` +
            ` data-i="${i}"${it.disabled ? ' disabled' : ''}>` +
            `<span>${esc(it.label)}</span>` +
            (it.sub
              ? `<span class="tn-ctx-sub mono">${esc(it.sub)}</span>`
              : '') +
            '</button>'
      )
      .join('');
    document.body.appendChild(m);

    // keep it on screen
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
    m.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';

    m.addEventListener('click', (ev) => {
      const b = ev.target.closest('.tn-ctx-item');
      if (!b || b.disabled) return;
      const it = items[Number(b.dataset.i)];
      closeMenu();
      if (it && typeof it.run === 'function') it.run();
    });
    menuEl = m;
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onMenuKey, true);
  }

  // Bound to the whole PANE, not just the byte cells: right-clicking the
  // offset column, a gap between groups, or the empty space past the last
  // byte on a row should still get the menu. When the click did not land on a
  // byte we act at the cursor, which is where the status strip already says
  // we are.
  els.hexPane.addEventListener('contextmenu', (e) => {
    if (!tuningState.bin) return;
    // let the find box, jump box and toolbar keep the native menu, where
    // the browser's own cut/copy/paste is genuinely what you want
    if (e.target.closest('input, select, textarea, .tn-hex-head, .tn-find'))
      return;
    e.preventDefault();
    const cell = e.target.closest && e.target.closest('[data-off]');
    const off = cell ? Number(cell.dataset.off) : cursor;
    // a right-click outside the selection moves the cursor there first, so the
    // menu and the status strip agree about what is being acted on
    if (cell && !inSelection(off)) {
      setCursor(off, false);
    }
    openMenu(e.clientX, e.clientY, off);
  });

  // RAW EDIT ON DOUBLE-CLICK.
  //
  // Not a 'dblclick' listener: render() rebuilds hexWindow.innerHTML, so the
  // first click's repaint replaces the cell node and the second click lands on
  // a different element -- the browser then never pairs them and dblclick
  // never fires. MouseEvent.detail counts clicks in the sequence regardless of
  // which node they hit, so it survives the re-render.
  els.hexWindow.addEventListener('mousedown', (e) => {
    if (e.detail < 2) return;
    const cell = e.target.closest && e.target.closest('.tn-hb[data-off]');
    if (!cell || !tuningState.bin) return;
    e.preventDefault(); // stop the text-selection a 2nd click starts
    editRawByte(Number(cell.dataset.off));
  });

  // ---- keyboard -------------------------------------------------------------
  els.hexScroll.addEventListener('keydown', (e) => {
    if (!tuningState.bin) return;
    const ext = e.shiftKey;
    const page = Math.max(1, Math.floor(viewportHeight() / ROW_H) - 1) * cols;
    switch (e.key) {
      case 'ArrowLeft':
        moveCursor(-1, ext);
        break;
      case 'ArrowRight':
        moveCursor(1, ext);
        break;
      case 'ArrowUp':
        moveCursor(-cols, ext);
        break;
      case 'ArrowDown':
        moveCursor(cols, ext);
        break;
      case 'PageUp':
        moveCursor(-page, ext);
        break;
      case 'PageDown':
        moveCursor(page, ext);
        break;
      // Home/End are row-local; with Ctrl they run to the ends of the image,
      // which is the convention every editor shares.
      case 'Home':
        moveCursor(e.ctrlKey || e.metaKey ? -cursor : -(cursor % cols), ext);
        break;
      case 'End':
        moveCursor(
          e.ctrlKey || e.metaKey
            ? tuningState.bin.length - 1 - cursor
            : cols - 1 - (cursor % cols),
          ext
        );
        break;
      case 'Enter':
        editRawByte(cursor);
        break;
      default:
        return;
    }
    e.preventDefault();
  });

  async function editRawByte(off) {
    const cur = tuningState.bin[off];
    const v = await inputDialog({
      title: `Edit byte 0x${off.toString(16).toUpperCase()}`,
      body: `Current value 0x${tnHex2(cur)} (${cur}). Enter a new byte as hex (00–FF) or decimal.`,
      kind: 'text',
      example: 'FF',
      confirmLabel: 'Write',
    });
    if (v == null) return;
    const byte = parseByteText(v);
    if (byte == null) return;
    // Route through the owner's writer rather than poking `bin` directly: it is
    // what recounts changed bytes and schedules the session save, so a raw hex
    // edit shows up in the toolbar and survives a revisit exactly like an edit
    // made through a definition does.
    if (typeof hooks.onWriteByte === 'function') {
      hooks.onWriteByte(off, byte);
    } else {
      tuningState.bin[off] = byte;
    }
    render();
  }

  // ---- chrome wiring --------------------------------------------------------
  if (els.cols) {
    // the markup defaults to 16; adopt the width from a previous visit instead
    els.cols.value = String(cols);
    els.cols.onchange = () => {
      cols = Number(els.cols.value) || TUNE_HEX.DEFAULT_COLS;
      // written back so re-entering the screen restores the chosen width
      TUNE_HEX.BYTES_PER_ROW = cols;
      scrollIntoView(cursor);
      schedule();
    };
  }

  if (els.findQ) {
    let timer = null;
    els.findQ.oninput = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(runFind, TN_FIND_DEBOUNCE_MS);
    };
    els.findQ.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (timer) {
        clearTimeout(timer);
        timer = null;
        runFind();
      }
      stepFind(e.shiftKey ? -1 : 1);
    };
  }
  if (els.findModes) {
    els.findModes.onclick = (e) => {
      const b = e.target.closest && e.target.closest('.tn-find-mode');
      if (!b) return;
      find.mode = b.dataset.mode;
      els.findModes
        .querySelectorAll('.tn-find-mode')
        .forEach((x) => x.classList.toggle('on', x === b));
      if (els.findQ) {
        els.findQ.placeholder = find.mode === 'hex' ? 'DE AD BE EF' : 'BOSCH';
        els.findQ.focus();
      }
      runFind();
    };
  }
  if (els.findPrev) els.findPrev.onclick = () => stepFind(-1);
  if (els.findNext) els.findNext.onclick = () => stepFind(1);

  return {
    refresh() {
      // refresh() is the "bytes may have changed" signal, so any find results
      // are stale by definition -- re-run rather than leave phantom matches
      // highlighted over bytes that no longer hold the pattern.
      if (tuningState.bin && cursor >= tuningState.bin.length) {
        cursor = 0;
        anchor = 0;
      }
      if (find.pattern) runFind();
      else schedule();
    },
    // Select a mapped parameter's whole byte span. `label` names it in the
    // status strip; `scroll` centres it (a tree pick), or not (a hex click:
    // the user is already looking at it).
    selectRegion(range, opts = {}) {
      if (!tuningState.bin || !range || range.end <= range.start) return;
      const s = clampOff(range.start);
      const e = clampOff(range.end - 1);
      anchor = Math.min(s, e);
      cursor = Math.max(s, e);
      region = { label: opts.label || '' };
      if (opts.scroll) centreOn(anchor);
      schedule();
    },
    scrollTo(off) {
      setCursor(off, false);
      centreOn(off);
      schedule();
    },
    // "0x1000" / "4096" / "+0x100" / "-256" -> true if we could jump
    gotoExpr(raw) {
      const bytes = tuningState.bin;
      if (!bytes) return false;
      const m = /^([+-]?)\s*(0x)?([0-9a-fA-F]+)$/.exec(String(raw).trim());
      if (!m) return false;
      // No 0x prefix and no letters means the user typed decimal; anything
      // with a hex digit a-f can only have been meant as hex.
      const hexish = !!m[2] || /[a-fA-F]/.test(m[3]);
      const mag = parseInt(m[3], hexish ? 16 : 10);
      if (!Number.isFinite(mag)) return false;
      const target = m[1] ? cursor + (m[1] === '-' ? -mag : mag) : mag;
      if (target < 0 || target >= bytes.length) return false;
      this.scrollTo(target);
      return true;
    },
  };
}
