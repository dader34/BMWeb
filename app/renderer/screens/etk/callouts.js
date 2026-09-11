/**
 * @file The link between an exploded view's callout numbers and its parts
 * rows, in both directions: point at a number on the drawing to light up the
 * parts it names, point at a row to light up where that part sits.
 *
 * ETK ships, per drawing, the rectangle each callout number occupies (see the
 * hotspots section of tools/etk_import.py). Those rectangles arrive in the
 * image's OWN pixel space, so the overlay is an absolutely positioned layer
 * sized to the RENDERED image and scaled by rendered/natural -- which is what
 * keeps it aligned through the small-image upscale rule, a window resize and
 * the lightbox, all of which draw the same image at a different size.
 *
 * The join key both ways is `pos`, the callout number: one pos can own
 * several rectangles (a part drawn twice) and several rows (fitment variants
 * of one position), so every operation here is many-to-many.
 */

/* exported etkScaleHotspot, etkPosRowIndex, etkHotspotName, etkAttachHotspots */

/**
 * A rectangle placed in the rendered image's coordinates, ready to be styled.
 * @typedef {object} EtkPlacedHotspot
 * @property {string} pos - the callout number
 * @property {number} left - px from the rendered image's left edge
 * @property {number} top - px from its top edge
 * @property {number} width - px
 * @property {number} height - px
 */

/**
 * Place one hotspot rectangle onto an image drawn at a given size.
 *
 * The stored coordinates are pixels of the diagram's full-size ('Z')
 * rendering, which is the image the bundle ships, so the mapping is a plain
 * ratio: no offset, no letterboxing (the <img> keeps its aspect ratio).
 * @param {EtkHotspot} hs - [pos, x1, y1, x2, y2] in the image's own pixels
 * @param {number} naturalW - the image's intrinsic width, px
 * @param {number} naturalH - the image's intrinsic height, px
 * @param {number} renderW - the width it is actually drawn at, px
 * @param {number} renderH - the height it is actually drawn at, px
 * @returns {EtkPlacedHotspot|null} the placed box, or null when the inputs cannot be scaled
 */
function etkScaleHotspot(hs, naturalW, naturalH, renderW, renderH) {
  if (!hs || hs.length < 5) return null;
  if (!naturalW || !naturalH || !renderW || !renderH) return null;
  const sx = renderW / naturalW;
  const sy = renderH / naturalH;
  const left = hs[1] * sx;
  const top = hs[2] * sy;
  const width = (hs[3] - hs[1]) * sx;
  const height = (hs[4] - hs[2]) * sy;
  if (!(width > 0) || !(height > 0)) return null;
  return { pos: String(hs[0]), left, top, width, height };
}

/**
 * Index the rendered parts rows by their callout number.
 *
 * Built from the rows ACTUALLY ON SCREEN, so a part the variant filter
 * dropped is absent from the index and its callout therefore highlights
 * nothing -- the rule the brief asks for, enforced by construction rather
 * than by a second filter here.
 * @param {ArrayLike<HTMLTableRowElement>} rows - the <tr>s in the parts table
 * @param {(row: HTMLTableRowElement) => string} posOf - reads a row's callout number
 * @returns {Map<string, HTMLTableRowElement[]>} pos -> the rows carrying it
 */
function etkPosRowIndex(rows, posOf) {
  /** @type {Map<string, HTMLTableRowElement[]>} */
  const idx = new Map();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const pos = String(posOf(row) || '').trim();
    // '--' is the importer's marker for "this part has no callout on the
    // drawing", so it can never be pointed at and must not join to anything
    if (!pos || pos === '--') continue;
    if (!idx.has(pos)) idx.set(pos, []);
    idx.get(pos).push(row);
  }
  return idx;
}

/**
 * The accessible name of one callout rectangle, as screen readers announce it
 * and as the tooltip repeats.
 * @param {string} pos - the callout number
 * @param {number} [count] - how many parts rows carry it, when known
 * @returns {string}
 */
function etkHotspotName(pos, count) {
  const base = `callout ${pos}`;
  if (!count) return base;
  return `${base}, ${count} part${count === 1 ? '' : 's'}`;
}

/**
 * Wire one drawing to one parts table: build the rectangle overlay, keep it
 * aligned, and cross-highlight in both directions.
 *
 * Highlighting has two levels. HOVER is transient and disappears the moment
 * the pointer leaves. A CLICK pins the selection so the reader can leave the
 * drawing, scroll the list and keep seeing what they picked; another click,
 * a click on empty space, or Escape releases it.
 * @param {object} opts - what to wire together
 * @param {HTMLImageElement} opts.img - the drawing
 * @param {HTMLElement} opts.layerHost - the positioned element the overlay is appended to (the figure/plate)
 * @param {EtkHotspot[]} opts.hotspots - the diagram's rectangles
 * @param {HTMLElement|null} [opts.table] - the parts table to cross-highlight, if any
 * @param {boolean} [opts.scrollRows] - scroll the first matching row into view on a pick
 * @returns {() => void} a teardown that removes the overlay and its listeners
 */
function etkAttachHotspots({
  img,
  layerHost,
  hotspots,
  table = null,
  scrollRows = false,
}) {
  const layer = document.createElement('div');
  layer.className = 'etk-hotspots';
  // the layer is decoration until a rectangle is under the pointer; the
  // rectangles themselves opt back in, so the figure's own click (which opens
  // the lightbox) still reaches it everywhere else
  layer.setAttribute('aria-label', 'Diagram callouts');
  layerHost.appendChild(layer);

  const rows = table ? table.querySelectorAll('tbody tr') : [];
  const byPos = etkPosRowIndex(rows, (r) => {
    const cell = r.querySelector('.etk-pos');
    return cell ? cell.textContent : '';
  });

  /** @type {HTMLButtonElement[]} every rectangle button, in file order */
  const areas = [];
  /** @type {string|null} the pinned callout, or null when nothing is pinned */
  let pinned = null;

  /**
   * Paint one highlight state over both the rectangles and the rows.
   * @param {string|null} pos - the callout to light up, or null for none
   * @param {boolean} isPinned - true when this is a pinned (clicked) selection
   * @returns {void}
   */
  function paint(pos, isPinned) {
    for (const a of areas) {
      const on = pos != null && a.dataset.pos === pos;
      a.classList.toggle('on', on);
      a.classList.toggle('pinned', on && isPinned);
    }
    for (let i = 0; i < rows.length; i++) {
      rows[i].classList.remove('etk-row-on', 'etk-row-pinned');
    }
    if (pos == null) return;
    for (const r of byPos.get(pos) || []) {
      r.classList.add('etk-row-on');
      if (isPinned) r.classList.add('etk-row-pinned');
    }
  }

  /**
   * Show a callout, honouring the pin: a transient hover must never wipe a
   * pinned selection, it only previews on top of nothing.
   * @param {string|null} pos - the callout under the pointer, or null on leave
   * @returns {void}
   */
  function hover(pos) {
    if (pinned) return;
    paint(pos, false);
  }

  /**
   * Pin (or unpin) a callout, and bring its first row into view so a pick on
   * the drawing answers the question "which part is this" without scrolling.
   * @param {string} pos - the callout that was clicked
   * @returns {void}
   */
  function pick(pos) {
    pinned = pinned === pos ? null : pos;
    paint(pinned, pinned != null);
    if (!pinned || !scrollRows) return;
    const first = (byPos.get(pinned) || [])[0];
    if (first && first.scrollIntoView)
      first.scrollIntoView({ block: 'nearest' });
  }

  // ---- the rectangles -----------------------------------------------------
  for (const hs of hotspots) {
    const pos = String(hs[0]);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'etk-hotspot';
    btn.dataset.pos = pos;
    const n = (byPos.get(pos) || []).length;
    btn.setAttribute('aria-label', etkHotspotName(pos, n));
    btn.title = etkHotspotName(pos, n);
    btn._hs = hs; // kept so relayout can re-place it without re-reading the file
    btn.onpointerenter = () => hover(pos);
    btn.onpointerleave = () => hover(null);
    btn.onfocus = () => hover(pos);
    btn.onblur = () => hover(null);
    btn.onclick = (ev) => {
      // the figure's own click opens the lightbox; a callout pick is not that
      ev.stopPropagation();
      ev.preventDefault();
      pick(pos);
    };
    layer.appendChild(btn);
    areas.push(btn);
  }

  /**
   * Re-place every rectangle against the image as it is drawn right now.
   * Called on load, on resize, and whenever the image's box may have changed.
   * @returns {void}
   */
  function relayout() {
    const w = img.clientWidth;
    const h = img.clientHeight;
    if (!w || !h || !img.naturalWidth) return;
    // the overlay sits exactly where the image does inside the host, so a
    // centred or padded image does not drag the rectangles off it
    const ir = img.getBoundingClientRect();
    const hr = layerHost.getBoundingClientRect();
    layer.style.left = ir.left - hr.left + 'px';
    layer.style.top = ir.top - hr.top + 'px';
    layer.style.width = w + 'px';
    layer.style.height = h + 'px';
    for (const a of areas) {
      const box = etkScaleHotspot(
        a._hs,
        img.naturalWidth,
        img.naturalHeight,
        w,
        h
      );
      if (!box) {
        a.hidden = true;
        continue;
      }
      a.hidden = false;
      a.style.left = box.left + 'px';
      a.style.top = box.top + 'px';
      a.style.width = box.width + 'px';
      a.style.height = box.height + 'px';
    }
  }

  // ---- rows point back at the drawing -------------------------------------
  /** @type {HTMLTableRowElement[]} the rows this controller took the handlers of */
  const wired = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const cell = row.querySelector('.etk-pos');
    const pos = cell ? String(cell.textContent || '').trim() : '';
    if (!pos || pos === '--' || !byPos.has(pos)) continue;
    // only rows whose callout is actually drawn become pointers: a row with
    // no rectangle would promise a highlight it cannot deliver
    const drawn = areas.some((a) => a.dataset.pos === pos);
    if (!drawn) continue;
    row.classList.add('etk-row-linked');
    row.onpointerenter = () => hover(pos);
    row.onpointerleave = () => hover(null);
    row.onclick = () => pick(pos);
    wired.push(row);
  }

  /**
   * Escape releases a pinned selection, matching every other dismissable
   * state in the app.
   * @param {KeyboardEvent} e - the key event
   * @returns {void}
   */
  const onKey = (e) => {
    if (e.key === 'Escape' && pinned) {
      // stop it here so Escape does not ALSO close the lightbox or leave the
      // screen: one Escape, one dismissal
      e.stopPropagation();
      e.preventDefault();
      pinned = null;
      paint(null, false);
    }
  };
  window.addEventListener('keydown', onKey, true);

  const onResize = () => relayout();
  window.addEventListener('resize', onResize);
  // the image may already be decoded (a blob URL from the archive often is),
  // in which case onload has been and gone
  if (img.complete) relayout();
  img.addEventListener('load', relayout);
  // the small-image upscale rule and the lightbox's max-height both resize the
  // element after load without a further event, so watch the box itself
  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => relayout());
    ro.observe(img);
  }

  return () => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    img.removeEventListener('load', relayout);
    if (ro) ro.disconnect();
    layer.remove();
    // hand the table back exactly as it was found: the lightbox attaches a
    // SECOND controller to the same rows, and a half-released one would leave
    // stale highlights and dead handlers behind it
    for (const row of wired) {
      row.classList.remove('etk-row-linked', 'etk-row-on', 'etk-row-pinned');
      row.onpointerenter = null;
      row.onpointerleave = null;
      row.onclick = null;
    }
  };
}
