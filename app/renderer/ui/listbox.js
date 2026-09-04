// Shared single-select list box (the `.etk-lb` control). The ETK screen and
// Tool32 each carried their own copy; this is the one implementation, a
// superset of both. Items are { key, label, write? }.
//
// makeListBox(opts) -> a &lt;div&gt; element with:
//   .setItems(arr)     replace items, clear selection, render
//   .setLoading(msg)   show a single placeholder row (msg), clear items
//   .clear()           empty it
//   .selected()        the selected item object, or null
//   .onpick            callback(key, label) assigned by the caller
//
// opts:
//   extraClass   extra class on the root (e.g. 't32-lb')
//   focusable    set tabIndex=0 (ETK wants keyboard focus)
//   writeTag     mark items with `write:true` -- adds .t32-row-write + a "W"
//                badge (Tool32's write-job marker)
//   emptyText    placeholder for an empty list (default '—')

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
