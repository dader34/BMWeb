// Shared searchable dropdown. Two screens each carried their own copy (the
// fault-lookup `.lkd` control and the ETK variant filter `.etk-vdd`); this is
// the single implementation they both wrap. It is deliberately option-driven
// rather than one-size-fits-all, because the two skins genuinely differ (drop-up
// flip, height clamp, Esc-to-close, rich rows, a synthetic "all" row, a row cap)
// and share no CSS -- so `classPrefix` picks the class family and the rest are
// behaviour flags. Each caller keeps its exact look and behaviour.
//
// It intentionally does NOT cover etk.js's makeSelect: that is a native-<select>
// emulation (index-string .value, .selectedIndex, .onchange dual-fire, a _vals
// sidecar) that the parts cascade depends on -- a different contract, left alone.
//
// makeDropdown(opts) -> { el, value(), set(v), setOptions(items, cur), open(), close() }
//
// opts:
//   items            array of item objects
//   value            initial selected value (=== compared to itemValue(item))
//   onChange(v,item) selection callback
//   placeholder      shown when nothing (or a blank-value item) is selected
//   classPrefix      'lkd' | 'etk-vdd' | ... -- drives every class name
//   searchable       show the search box (default true)
//   searchPlaceholder / searchType   the search input's placeholder / type attr
//   itemValue(item,i)  -> value          (default item.val)
//   itemLabel(item)    -> display string (default item.label)
//   renderRow(item, active) -> innerHTML  (default: escaped label)
//   filterItem(item, q) -> bool           (default: label / value contains q)
//   emptyText        "no matches" row text; falsy -> no empty row
//   rowCap           max rendered rows (default Infinity)
//   synthetic        { value, label } permanent first row, hidden while querying
//   flip             drop-up when no room below (default true)
//   clampToBar       selector: cap list height to this element's top (or null)
//   escClose         Esc closes (default true)
//   closeOn          'mousedown' | 'click' (default 'mousedown')
//   focusDelay       ms before focusing search (default 10; null = immediate)
//   activeClass      extra class on the button while a non-default value is set

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

  const root = document.createElement('div');
  root.className = P;
  root.innerHTML =
    `<button class="${P}-btn" type="button">` +
    `<span class="${P}-cur"></span>` +
    `<span class="${P}-caret">▾</span></button>` +
    `<div class="${P}-menu" hidden>` +
    (searchable
      ? `<input class="${P}-search" type="${o.searchType || 'text'}" ` +
        `placeholder="${esc(o.searchPlaceholder || 'Search…')}" ` +
        `spellcheck="false" autocomplete="off" />`
      : '') +
    `<div class="${P}-list"></div></div>`;

  const btn = root.querySelector(`.${P}-btn`);
  const curEl = root.querySelector(`.${P}-cur`);
  const menu = root.querySelector(`.${P}-menu`);
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
    curEl.classList.toggle(`${P}-placeholder`, !it && !o.synthetic);
    if (o.activeClass) curEl.classList.toggle(o.activeClass, !isDefault(sel));
  }

  function renderList(q) {
    const f = (q || '').trim().toLowerCase();
    list.innerHTML = '';
    // synthetic "all" row, only when not filtering
    if (o.synthetic && !f) {
      const a = document.createElement('button');
      a.type = 'button';
      a.className = `${P}-opt${sel === o.synthetic.value ? ' active' : ''}`;
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
      el.className = `${P}-opt${v === sel ? ' active' : ''}`;
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
    root.classList.remove('open', 'drop-up');
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
