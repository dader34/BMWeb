// Shared single-select list box (the `.etk-lb` control). The ETK screen and
// Tool32 each carried their own copy; this is the one implementation, a
// superset of both. Items are { key, label, write? }.
//
/**
 * One list-box row.
 * @typedef {Object} ListBoxItem
 * @property {string} key - The value handed to onpick.
 * @property {string} label - The row text.
 * @property {boolean} [write] - Flag the row as a write job (with `writeTag`).
 */

/**
 * Options for {@link makeListBox}.
 * @typedef {Object} ListBoxOpts
 * @property {string} [extraClass] - Extra class on the root (e.g. 't32-lb').
 * @property {boolean} [focusable] - Set tabIndex=0 (ETK wants keyboard focus).
 * @property {boolean} [writeTag] - Mark items with `write:true` -- adds
 *   .t32-row-write + a "W" badge (Tool32's write-job marker).
 * @property {string} [emptyText='—'] - Placeholder for an empty list.
 */

/**
 * The element {@link makeListBox} returns: a div carrying its own API.
 * @typedef {HTMLDivElement & {
 *   setItems: (arr: ListBoxItem[]) => void,
 *   setLoading: (msg: string) => void,
 *   clear: () => void,
 *   selected: () => ListBoxItem|null,
 *   onpick: ((key: string, label: string) => void)|null
 * }} ListBoxElement
 */

/**
 * Build a single-select list box. `.setItems(arr)` replaces the items, clears
 * the selection and renders; `.setLoading(msg)` shows one placeholder row;
 * `.clear()` empties it; `.selected()` is the picked item or null; the caller
 * assigns `.onpick(key, label)`.
 * @param {ListBoxOpts} [opts] - Skin and behaviour options.
 * @returns {ListBoxElement}
 */
function makeListBox(opts) {
  const o = opts || {};
  const box = document.createElement('div');
  box.className = 'etk-lb' + (o.extraClass ? ' ' + o.extraClass : '');
  if (o.focusable) box.tabIndex = 0;
  let items = [];
  let value = -1;
  let msg = null;
  box.onpick = null;

  function render() {
    box.innerHTML = '';
    if (!items.length) {
      const e = document.createElement('div');
      e.className = 'etk-lb-empty';
      e.textContent = msg || o.emptyText || '—';
      box.appendChild(e);
      return;
    }
    items.forEach((it, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className =
        'etk-lb-row' +
        (i === value ? ' active' : '') +
        (o.writeTag && it.write ? ' t32-row-write' : '');
      row.textContent = it.label;
      if (o.writeTag && it.write) {
        const tag = document.createElement('span');
        tag.className = 't32-rowtag';
        tag.textContent = 'W';
        row.appendChild(tag);
      }
      row.onclick = () => {
        value = i;
        render();
        row.scrollIntoView({ block: 'nearest' });
        if (box.onpick) box.onpick(items[i].key, items[i].label);
      };
      box.appendChild(row);
    });
  }

  box.setItems = (arr) => {
    items = arr || [];
    value = -1;
    msg = null;
    render();
  };
  box.setLoading = (m) => {
    items = [];
    value = -1;
    msg = m;
    render();
  };
  box.clear = () => {
    items = [];
    value = -1;
    msg = null;
    render();
  };
  box.selected = () => (value >= 0 ? items[value] : null);

  render();
  return box;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { makeListBox };
}
