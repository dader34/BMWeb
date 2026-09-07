/**
 * @file A styled dropdown that mimics the <select> interface the attribute
 * cascade uses: exposes .value (option index as string, '' for none),
 * .selectedIndex, .disabled, an .options-like list via setOptions(), and fires
 * 'change'. Keeps the cascade code unchanged while ditching the unstyleable
 * native list. The shared ui/dropdown.js deliberately does not cover this
 * contract (index-string .value, .selectedIndex, .onchange dual-fire, the
 * `_vals` sidecar the cascade hangs on it).
 */

/* exported makeSelect */

/**
 * The <select>-ish surface makeSelect() returns. Values are 0-based item
 * indices as strings ('' = none). selectedIndex mirrors native semantics
 * (0 = the placeholder, 1..N = items) so `sel.selectedIndex = 1` auto-picks
 * the first real item. The cascade hangs its own sidecars (`_vals`, `_vs`,
 * `_byYear`) on the element.
 * @typedef {HTMLDivElement & {
 *   value: string,
 *   disabled: boolean,
 *   selectedIndex: number,
 *   options: { textContent: string }[],
 *   setOptions: (items: string[], placeholder?: string|null) => void,
 *   setDisabledEmpty: () => void,
 *   openMenu: () => void,
 *   onchange: ((ev: Event) => void)|null,
 *   _vals?: string[],
 *   _vs?: EtkVehicleRow[],
 *   _byYear?: Record<string, string>|null,
 * }} EtkSelect
 */

/** Placeholder shown when a select has no explicit one. */
const ETK_SELECT_PLACEHOLDER = 'Select…';

/**
 * Build a styled single-choice dropdown with a <select>-like API.
 * @param {string} [placeholder] - text shown while nothing is picked
 * @returns {EtkSelect}
 */
function makeSelect(placeholder) {
  const root = /** @type {EtkSelect} */ (document.createElement('div'));
  root.className = 'etk-sel';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'etk-sel-btn';
  btn.innerHTML = `<span class="etk-sel-cur"></span><span class="etk-sel-caret">▾</span>`;
  const menu = document.createElement('div');
  menu.className = 'etk-sel-menu';
  menu.hidden = true;
  root.appendChild(btn);
  root.appendChild(menu);
  const cur = btn.querySelector('.etk-sel-cur');

  let items = []; // display strings
  let value = ''; // '' (placeholder) or a 0-based index string of an item
  let ph = placeholder || ETK_SELECT_PLACEHOLDER;
  let disabled = false;
  let outside = null;

  /** @returns {string} the caption for the current value */
  function label() {
    return value === '' ? ph : items[+value];
  }
  /** Repaint the button caption. */
  function paint() {
    cur.textContent = label();
    cur.classList.toggle('etk-sel-ph', value === '');
  }
  /** Rebuild the option rows. */
  function renderMenu() {
    menu.innerHTML = '';
    items.forEach((t, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'etk-sel-opt' + (value === String(i) ? ' active' : '');
      b.textContent = t;
      b.onclick = (e) => {
        e.stopPropagation();
        value = String(i);
        paint();
        close();
        fire();
      };
      menu.appendChild(b);
    });
  }
  /** Open the menu (no-op when disabled or empty) and arm outside-click close. */
  function open() {
    if (disabled || !items.length) return;
    renderMenu();
    menu.hidden = false;
    root.classList.add('etk-sel-open');
    setTimeout(() => {
      outside = (e) => {
        if (!root.contains(e.target)) close();
      };
      document.addEventListener('click', outside);
    }, 0);
  }
  /** Close the menu and disarm outside-click close. */
  function close() {
    menu.hidden = true;
    root.classList.remove('etk-sel-open');
    if (outside) {
      document.removeEventListener('click', outside);
      outside = null;
    }
  }
  // fire both the event (for addEventListener) and the .onchange property the
  // cascade sets, since a div's onchange isn't auto-wired like a <select>'s.
  /** Notify listeners of a selection. */
  function fire() {
    root.dispatchEvent(new Event('change'));
    if (typeof root.onchange === 'function') root.onchange(new Event('change'));
  }

  btn.onclick = (e) => {
    e.stopPropagation();
    menu.hidden ? open() : close();
  };

  Object.defineProperties(root, {
    value: {
      get: () => value,
      set: (v) => {
        value = v === '' ? '' : String(v);
        paint();
      },
    },
    disabled: {
      get: () => disabled,
      set: (d) => {
        disabled = !!d;
        root.classList.toggle('etk-sel-disabled', disabled);
        if (d) close();
      },
    },
    selectedIndex: {
      get: () => (value === '' ? 0 : +value + 1),
      set: (i) => {
        value = i && i >= 1 ? String(i - 1) : '';
        paint();
      },
    },
    options: {
      get: () => [
        { textContent: ph },
        ...items.map((t) => ({ textContent: t })),
      ],
    },
  });
  // setOptions replaces the innerHTML-style population a native <select> gets
  root.setOptions = (arr, placeholderText) => {
    if (placeholderText != null) ph = placeholderText;
    items = arr.slice();
    value = '';
    paint();
    close();
  };
  root.setDisabledEmpty = () => {
    items = [];
    value = '';
    paint();
  };
  root.openMenu = () => open();
  paint();
  return root;
}
