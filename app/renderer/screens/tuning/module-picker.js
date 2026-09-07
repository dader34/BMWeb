/**
 * @file Tuning screen, Read from ECU: the module picker. A DROPDOWN, not a
 * bare search box. A native <datalist> renders in OS chrome -- it escaped
 * the modal, ignored the theme, and offered no way to browse. This opens on
 * click showing every module, and typing narrows it. The car's own modules
 * come first under their own heading, the rest of the build under "Other
 * modules".
 */

/* exported tnCreateModulePicker */

/** Rows the list shows at most. */
const TN_PICKER_MAX_ROWS = 400;

/**
 * @typedef {Object} PickerRow
 * @property {string} sgbd
 * @property {string} text - Secondary text (label · section), '' for the rest.
 * @property {string} [head] - A heading drawn above this row.
 */

/**
 * @typedef {Object} ModulePickerOpts
 * @property {HTMLInputElement} input - The combobox text field.
 * @property {HTMLElement} list - The listbox container.
 * @property {HTMLButtonElement} caret - The open/close button.
 * @property {() => { car: TmCarModule[], other: string[], carLabel: string }} rows -
 *   The current candidates: the car's modules, everything else, and the
 *   heading for the car group.
 * @property {(sgbd: string) => void} onChoose - A module was picked.
 * @property {() => void} onInput - The user typed (after the list narrowed).
 */

/**
 * @typedef {Object} ModulePicker
 * @property {() => boolean} isOpen
 * @property {(all: boolean) => void} open - `all` shows everything rather than the typed match.
 * @property {() => void} close
 */

/**
 * Rank rows for a query: prefix matches first, then contains. Typing "kom"
 * should put kombi46 above a module that merely contains those letters
 * somewhere.
 * @param {{ sgbd: string, label?: string }[]} rows
 * @param {string} q - Lower-cased query, '' for everything.
 * @returns {{ sgbd: string, label?: string }[]}
 */
function tnRankPickerRows(rows, q) {
  const match = (row) => {
    if (!q) return 2;
    const s = row.sgbd.toLowerCase();
    if (s.startsWith(q)) return 2;
    if (
      s.includes(q) ||
      String(row.label || '')
        .toLowerCase()
        .includes(q)
    )
      return 1;
    return 0;
  };
  const starts = [],
    has = [];
  for (const row of rows) {
    const m = match(row);
    if (m === 2) starts.push(row);
    else if (m === 1) has.push(row);
  }
  return starts.concat(has);
}

/**
 * Wire the combobox and return its controls.
 * @param {ModulePickerOpts} opts
 * @returns {ModulePicker}
 */
function tnCreateModulePicker(opts) {
  const { input, list, caret } = opts;
  /** @type {PickerRow[]} */
  let items = [];
  let at = -1;
  let isOpen = false;

  function close() {
    isOpen = false;
    list.hidden = true;
    list.innerHTML = '';
    items = [];
    at = -1;
    input.setAttribute('aria-expanded', 'false');
  }

  function choose(name) {
    input.value = name;
    close();
    opts.onChoose(name);
  }

  function paint() {
    if (!items.length) {
      list.hidden = false;
      list.innerHTML = '<div class="tn-ecu-sug-empty">No module matches.</div>';
      input.setAttribute('aria-expanded', 'true');
      return;
    }
    list.innerHTML = items
      .map(
        (it, i) =>
          (it.head
            ? `<div class="tn-ecu-sug-head">${esc(it.head)}</div>`
            : '') +
          `<button type="button" class="etk-lb-row tn-ecu-sug-row${i === at ? ' active' : ''}"` +
          ` role="option" data-i="${i}"><span class="tn-ecu-sug-sgbd">${esc(it.sgbd)}</span>` +
          (it.text
            ? `<span class="tn-ecu-sug-text">${esc(it.text)}</span>`
            : '') +
          `</button>`
      )
      .join('');
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    list.querySelectorAll('.tn-ecu-sug-row').forEach((el) => {
      el.onmousedown = (ev) => {
        // mousedown: fires before the input blurs
        ev.preventDefault();
        choose(items[+el.dataset.i].sgbd);
      };
    });
    const active = list.querySelector('.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  // `all` = the caret / an empty box: show everything rather than nothing.
  function open(all) {
    isOpen = true;
    const q = all ? '' : input.value.trim().toLowerCase();
    const src = opts.rows();
    const car = tnRankPickerRows(src.car, q).map((row) => ({
      sgbd: row.sgbd,
      text: `${row.label}${row.section ? ' · ' + row.section : ''}`,
    }));
    const other = tnRankPickerRows(
      src.other.map((s) => ({ sgbd: s })),
      q
    ).map((row) => ({ sgbd: row.sgbd, text: '' }));
    if (car.length) car[0].head = src.carLabel;
    if (other.length)
      other[0].head = car.length || src.carLabel ? 'Other modules' : '';
    items = car.concat(other).slice(0, TN_PICKER_MAX_ROWS);
    // Keep the current value highlighted so reopening lands where you were.
    const cur = input.value.trim().toLowerCase();
    at = cur ? items.findIndex((n) => n.sgbd.toLowerCase() === cur) : -1;
    paint();
  }

  caret.onmousedown = (e) => {
    e.preventDefault(); // don't steal focus from the input
    if (isOpen) {
      close();
      return;
    }
    input.focus();
    open(true);
  };
  input.onfocus = () => {
    if (!isOpen) open(!input.value.trim());
  };
  input.onblur = () => setTimeout(close, 120);

  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen) {
        open(!input.value.trim());
        return;
      }
      if (!items.length) return;
      at += e.key === 'ArrowDown' ? 1 : -1;
      if (at < 0) at = items.length - 1;
      if (at >= items.length) at = 0;
      paint();
    } else if (e.key === 'Enter') {
      if (isOpen && at >= 0) {
        e.preventDefault();
        choose(items[at].sgbd);
      }
    } else if (e.key === 'Escape') {
      // Escape closes the list first, and only then the dialog.
      if (isOpen) {
        e.stopPropagation();
        close();
      }
    }
  };

  input.oninput = () => {
    open(false); // typing always narrows the open list
    opts.onInput();
  };

  return { isOpen: () => isOpen, open, close };
}
