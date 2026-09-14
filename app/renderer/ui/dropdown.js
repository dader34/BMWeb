// Shared searchable dropdown. Two screens each carried their own copy (the
// fault-lookup `.lkd` control and the ETK variant filter `.etk-vdd`); this is
// the single implementation they both wrap. It is deliberately option-driven
// rather than one-size-fits-all, because the two skins genuinely differ (drop-up
// flip, height clamp, Esc-to-close, rich rows, a synthetic "all" row, a row cap)
// and share no CSS -- so `classPrefix` picks the class family and the rest are
// behaviour flags. Each caller keeps its exact look and behaviour.
//
// It intentionally does NOT cover etk/select.js's makeSelect: that is a native-<select>
// emulation (index-string .value, .selectedIndex, .onchange dual-fire, a _vals
// sidecar) that the parts cascade depends on -- a different contract, left alone.
//
/**
 * Options for {@link makeDropdown}. `classPrefix` picks the class family; the
 * rest are behaviour flags so each caller keeps its exact look and behaviour.
 * @typedef {Object} DropdownOpts
 * @property {any[]} [items] - The item objects.
 * @property {any} [value] - Initial selected value (=== compared to itemValue(item)).
 * @property {(v: any, item: any|null) => void} [onChange] - Selection callback.
 * @property {string} [placeholder] - Shown when nothing (or a blank-value item) is selected.
 * @property {string} [classPrefix='lkd'] - 'lkd' | 'etk-vdd' | ... -- drives every class name.
 * @property {{cur?: string, menu?: string, opt?: string}} [parts] - Class-suffix remap
 *   for skins whose CSS predates this factory (default cur/menu/opt).
 * @property {boolean} [searchable=true] - Show the search box.
 * @property {string} [searchPlaceholder] - The search input's placeholder.
 * @property {string} [searchType] - The search input's type attribute.
 * @property {(item: any, i: number) => any} [itemValue] - Item -> value (default item.val).
 * @property {(item: any) => string} [itemLabel] - Item -> display string (default item.label).
 * @property {(item: any, active: boolean) => string} [renderRow] - Item -> row innerHTML (default: escaped label).
 * @property {(item: any, q: string) => boolean} [filterItem] - Query filter (default: label / value contains q).
 * @property {string} [emptyText] - "no matches" row text; falsy -> no empty row.
 * @property {number} [rowCap=Infinity] - Max rendered rows.
 * @property {{value: any, label: string}} [synthetic] - Permanent first row, hidden while querying.
 * @property {boolean} [flip=true] - Drop-up when no room below.
 * @property {string|null} [clampToBar] - Selector: cap list height to this element's top.
 * @property {boolean} [escClose=true] - Esc closes.
 * @property {'mousedown'|'click'} [closeOn='mousedown'] - Outside event that closes.
 * @property {number|null} [focusDelay=10] - ms before focusing search (null = immediate).
 * @property {string} [activeClass] - Extra class on the button while a non-default value is set.
 */

/**
 * The handle {@link makeDropdown} returns.
 * @typedef {Object} DropdownHandle
 * @property {HTMLElement} el - The root element to mount.
 * @property {() => any} value - The selected value.
 * @property {(v: any) => void} set - Select a value without firing onChange.
 * @property {(items: any[], cur?: any) => void} setOptions - Replace the items (and optionally the selection).
 * @property {() => void} open - Open the menu.
 * @property {() => void} close - Close the menu.
 */

/**
 * Build a searchable dropdown.
 * @param {DropdownOpts} [opts] - Behaviour and skin options.
 * @returns {DropdownHandle}
 */
function makeDropdown(opts) {
  const o = opts || {};
  const P = o.classPrefix || 'lkd';
  const searchable = o.searchable !== false;
  const flip = o.flip !== false;
  const escClose = o.escClose !== false;
  const closeEvent = o.closeOn === 'click' ? 'click' : 'mousedown';
  const capture = closeEvent === 'mousedown';
  const rowCap = o.rowCap || Infinity;
  const itemValue = o.itemValue || ((it) => it.val);
  const itemLabel = o.itemLabel || ((it) => it.label);
  const filterItem =
    o.filterItem ||
    ((it, q) =>
      itemLabel(it).toLowerCase().includes(q) ||
      String(itemValue(it)).toLowerCase().includes(q));

  let items = (o.items || []).slice();
  let sel = o.value;

  // element class suffixes. Default scheme is cur/menu/opt; a caller whose CSS
  // predates this factory can remap them (the fault-lookup `.lkd` skin uses
  // val/pop/item, shared with a hand-built button, so it keeps those names).
  const sfx = o.parts || {};
  const cCur = `${P}-${sfx.cur || 'cur'}`;
  const cMenu = `${P}-${sfx.menu || 'menu'}`;
  const cOpt = `${P}-${sfx.opt || 'opt'}`;

  const root = document.createElement('div');
  root.className = P;
  root.innerHTML =
    `<button class="${P}-btn" type="button">` +
    `<span class="${cCur}"></span>` +
    `<span class="${P}-caret">▾</span></button>` +
    `<div class="${cMenu}" hidden>` +
    (searchable
      ? `<input class="${P}-search" type="${o.searchType || 'text'}" ` +
        `placeholder="${esc(o.searchPlaceholder || 'Search…')}" ` +
        `spellcheck="false" autocomplete="off" />`
      : '') +
    `<div class="${P}-list"></div></div>`;

  const btn = root.querySelector(`.${P}-btn`);
  const curEl = root.querySelector(`.${cCur}`);
  const menu = root.querySelector(`.${cMenu}`);
  const search = root.querySelector(`.${P}-search`);
  const list = root.querySelector(`.${P}-list`);

  const itemFor = (v) => items.find((it, i) => itemValue(it, i) === v);
  const isDefault = (v) =>
    v === undefined ||
    v === null ||
    v === '' ||
    (o.synthetic && v === o.synthetic.value);

  function renderCur() {
    const it = itemFor(sel);
    const label = it ? itemLabel(it) : o.synthetic ? o.synthetic.label : '';
    curEl.textContent = label || o.placeholder || '';
    // greyed when nothing real is chosen: no matched item (and no synthetic
    // fallback), OR the matched item is the blank-value "all" entry
    const blank = !it ? !o.synthetic : itemValue(it) === '';
    curEl.classList.toggle(`${P}-placeholder`, blank);
    if (o.activeClass) curEl.classList.toggle(o.activeClass, !isDefault(sel));
  }

  function renderList(q) {
    const f = (q || '').trim().toLowerCase();
    list.innerHTML = '';
    // synthetic "all" row, only when not filtering
    if (o.synthetic && !f) {
      const a = document.createElement('button');
      a.type = 'button';
      a.className = `${cOpt}${sel === o.synthetic.value ? ' active' : ''}`;
      a.textContent = o.synthetic.label;
      a.onclick = (e) => pick(o.synthetic.value, null, e);
      list.appendChild(a);
    }
    let shown = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (f && !filterItem(it, f)) continue;
      if (++shown > rowCap) break;
      const v = itemValue(it, i);
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `${cOpt}${v === sel ? ' active' : ''}`;
      if (o.renderRow) el.innerHTML = o.renderRow(it, v === sel);
      else el.textContent = itemLabel(it);
      el.onclick = (e) => pick(v, it, e);
      list.appendChild(el);
    }
    if (!list.children.length && o.emptyText) {
      list.innerHTML = `<div class="${P}-empty">${esc(o.emptyText)}</div>`;
    }
  }

  function pick(v, it, ev) {
    if (ev) {
      ev.preventDefault();
      ev.stopPropagation();
    }
    sel = v;
    renderCur();
    if (o.onChange) o.onChange(v, it);
    close();
  }

  let outside = null;
  function open() {
    menu.hidden = false;
    root.classList.add('open');
    if (search) search.value = '';
    renderList('');
    if (search) {
      if (o.focusDelay === null) search.focus();
      else setTimeout(() => search.focus(), o.focusDelay ?? 10);
    }
    if (flip || o.clampToBar) {
      requestAnimationFrame(() => {
        const r = btn.getBoundingClientRect();
        let up = false;
        if (flip) {
          const need = menu.offsetHeight + 8;
          const below = window.innerHeight - r.bottom;
          up = below < need && r.top > below;
          root.classList.toggle('drop-up', up);
        }
        // WHICH EDGE THE POPUP HANGS FROM is measured, not assumed. The
        // popup is wider than its button, so one anchored under the button's
        // left edge can overflow the right of the viewport, and one anchored
        // to its right edge can overflow the left. Which of those applies
        // depends on where the button ended up -- and that is a layout
        // outcome, not a fact about the markup: .lookup-controls is a flex
        // row whose search box grows, so the same filter sits at the RIGHT
        // on Job search (which has a search box) and at the LEFT on Service
        // functions (which does not). A CSS rule keyed on child position got
        // this wrong in both directions, so it is decided here, from the
        // measured box: prefer the left anchor, and switch to the right one
        // only when the popup would actually run past the viewport and there
        // is room on the other side.
        const popW = menu.offsetWidth;
        const MARGIN = 8;
        const overflowsRight = r.left + popW > window.innerWidth - MARGIN;
        const fitsLeftAnchored = r.right - popW >= MARGIN;
        root.classList.toggle('drop-right', overflowsRight && fitsLeftAnchored);
        if (o.clampToBar) {
          const bar = document.querySelector(o.clampToBar);
          const floor = bar
            ? bar.getBoundingClientRect().top
            : window.innerHeight;
          const MARGIN = 12;
          const avail = up ? r.top - MARGIN : floor - r.bottom - MARGIN;
          const searchH = search ? search.offsetHeight || 42 : 0;
          list.style.maxHeight = Math.max(120, avail - searchH) + 'px';
        }
      });
    }
    // arm the outside-closer (on the next tick for the click variant, so the
    // opening click doesn't immediately close it)
    const arm = () => {
      outside = (e) => {
        if (!root.contains(e.target)) close();
      };
      document.addEventListener(closeEvent, outside, capture);
    };
    if (capture) arm();
    else setTimeout(arm, 0);
    if (escClose) window.addEventListener('keydown', onEsc, true);
  }

  function close() {
    menu.hidden = true;
    root.classList.remove('open', 'drop-up', 'drop-right');
    if (outside) {
      document.removeEventListener(closeEvent, outside, capture);
      outside = null;
    }
    if (escClose) window.removeEventListener('keydown', onEsc, true);
  }

  function onEsc(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  }

  btn.onclick = (e) => {
    e.stopPropagation();
    menu.hidden ? open() : close();
  };
  if (search) {
    search.oninput = () => renderList(search.value);
    search.onclick = (e) => e.stopPropagation();
  }

  renderCur();
  return {
    el: root,
    value: () => sel,
    set(v) {
      sel = v;
      renderCur();
    },
    setOptions(newItems, cur) {
      items = (newItems || []).slice();
      if (cur !== undefined) sel = cur;
      renderCur();
    },
    open,
    close,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { makeDropdown };
}
