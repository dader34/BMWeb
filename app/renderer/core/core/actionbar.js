/**
 * @file The INPA function-key bar. Screens declare actions bound to the number
 * keys 1..9,0; the bar draws TEN FIXED SLOTS F1..F10, bound or not (an empty
 * one shows that F4 does nothing here), and Shift swaps to a screen's second
 * row while held. Screens call the global setActions().
 */

/**
 * One F-key action. `key` is the binding ('1'..'9', '0', 'Escape', a letter);
 * `keyLabel` is only a caption and never moves a key out of its slot.
 * @typedef {Object} BarAction
 * @property {string} label - Caption on the key.
 * @property {() => void} fn - What the key does.
 * @property {string} [key] - Keyboard binding; digits map to F1..F10.
 * @property {string} [keyLabel] - Caption for the binding (e.g. 'Esc').
 * @property {'back'|'primary'|'navAction'|'print'|string} [kind] - Styling and
 *   placement: `back` claims F10 and the mobile back chevron, `navAction` the
 *   mobile top-right button, `print` is what Cmd/Ctrl+P looks for.
 * @property {HTMLElement} [_el] - The drawn key, set by the bar for its flash.
 */

/** Slots in the bar: F1..F10. */
const INPA_SLOTS = 10;

/**
 * The F-key bar: slot layout, shift row, mobile mirrors, keyboard wiring.
 */
class ActionBar {
  constructor() {
    /** The row shown now. @type {BarAction[]} */
    this.current = [];
    /** The primary row. @type {BarAction[]} */
    this.base = [];
    /** The second row, when a screen has one. @type {BarAction[]|null} */
    this.shift = null;
    /** Whether Shift is held. @type {boolean} */
    this.shiftHeld = false;
    /** A screen's body-repaint when the row swaps. @type {(() => void)|null} */
    this.shiftRepaint = null;
    this._wireKeys();
  }

  /**
   * Fixed slot for an action: '1'..'9'/'0' are F1..F10 (0 IS F10, where back
   * lands); anything else spills to the next free slot.
   * @param {BarAction} a - An action.
   * @returns {number|null} Slot index, or null when the action has no fixed slot.
   */
  _slot(a) {
    if (a.kind === 'back') return INPA_SLOTS - 1;
    // read `key` (the binding) first, not keyLabel (caption): a decorative label must not move a key out of its slot
    const m = /^F?(\d+)$/.exec(String(a.key || a.keyLabel || '').toUpperCase());
    if (!m) return null;
    const n = Number(m[1]);
    if (n === 0) return INPA_SLOTS - 1;
    return n >= 1 && n <= INPA_SLOTS ? n - 1 : null;
  }

  /**
   * Draw the ten slots for a row.
   * @param {BarAction[]} actions - The row.
   * @returns {void}
   */
  _paintInpa(actions) {
    const slots = new Array(INPA_SLOTS).fill(null);
    const spill = [];
    // sort back first so it claims F10 before a screen's own '0' can take it
    const ordered = [...actions].sort(
      (x, y) => (y.kind === 'back') - (x.kind === 'back')
    );
    ordered.forEach((a) => {
      const i = this._slot(a);
      if (i !== null && !slots[i]) slots[i] = a;
      else spill.push(a);
    });
    // letter-keyed actions and collisions fill the first empty slot
    spill.forEach((a) => {
      const i = slots.indexOf(null);
      if (i >= 0) slots[i] = a;
    });

    fkeysEl.innerHTML = '';
    const keys = document.createElement('div');
    keys.className = 'fkey-nums';
    const btns = document.createElement('div');
    btns.className = 'fkey-btns';
    slots.forEach((a, i) => {
      const num = document.createElement('span');
      num.className = 'fkey-num';
      num.textContent = `F${i + 1}`;
      keys.appendChild(num);

      const el = document.createElement('div');
      el.className =
        'fkey' + (a && a.kind ? ' ' + a.kind : '') + (a ? '' : ' empty');
      if (a) {
        el.innerHTML = `<span class="fkey-label">${esc(a.label)}</span>`;
        el.onclick = () => this.fire(a);
        a._el = el;
      }
      btns.appendChild(el);
    });
    fkeysEl.appendChild(keys);
    fkeysEl.appendChild(btns);
  }

  /**
   * Paint a row (same shape in every theme) and mirror back / navAction / the
   * function sheet into the mobile nav bar.
   * @param {BarAction[]} actions - The row to show.
   * @returns {void}
   */
  paint(actions) {
    fkeysEl.classList.add('inpa-bar');
    this._paintInpa(actions);
    fkeysEl.classList.toggle('shifted', actions === this.shift);
    this._syncNavBack(actions);
    this._syncNavAction(actions);
    this._syncNavFn();
  }

  /**
   * Mobile ƒ button: the F-key strip is hidden on a phone, so every action
   * that isn't the back chevron or the dedicated navAction lists in a modal
   * sheet instead -- base row AND shift row (a phone has no Shift to hold).
   * @returns {void}
   */
  _syncNavFn() {
    const el = document.getElementById('nav-fn');
    if (!el) return;
    const list = [...(this.base || []), ...(this.shift || [])].filter(
      (a) => a && a.fn && a.kind !== 'back' && a.kind !== 'navAction'
    );
    el.hidden = !list.length;
    el.onclick = list.length ? () => this._openFnSheet(list) : null;
  }

  /**
   * Open the mobile function sheet.
   * @param {BarAction[]} list - Actions to list.
   * @returns {void}
   */
  _openFnSheet(list) {
    const rows = list
      .map(
        (a, i) =>
          `<button class="btn fn-sheet-row" data-i="${i}">
         <span class="fn-sheet-label">${esc(a.label || '')}</span>
         ${a.keyLabel ? `<span class="fn-sheet-key">${esc(a.keyLabel)}</span>` : ''}
       </button>`
      )
      .join('');
    const { overlay, close } = openModal(`
      <div class="modal fn-sheet" role="dialog" aria-modal="true">
        <div class="modal-title">Functions</div>
        <div class="fn-sheet-rows">${rows}</div>
        <div class="modal-actions">
          <button class="btn modal-cancel">Close<span class="modal-key">Esc</span></button>
        </div>
      </div>`);
    overlay.querySelectorAll('.fn-sheet-row').forEach((b) => {
      b.onclick = () => {
        const a = list[+b.dataset.i];
        close();
        this.fire(a);
      };
    });
    overlay.querySelector('.modal-cancel').onclick = () => close();
  }

  /**
   * The touch back arrow tracks the screen's `back` action (does what Esc
   * does); hidden if none.
   * @param {BarAction[]} actions - The row.
   * @returns {void}
   */
  _syncNavBack(actions) {
    const el = document.getElementById('nav-back');
    if (!el) return;
    const back = (actions || []).find((a) => a.kind === 'back');
    el.hidden = !back;
    el.onclick = back ? () => this.fire(back) : null;
  }

  /**
   * The top-right nav action on mobile (F-key bar hidden): a screen opts in
   * via kind:'navAction'.
   * @param {BarAction[]} actions - The row.
   * @returns {void}
   */
  _syncNavAction(actions) {
    const el = document.getElementById('nav-action');
    if (!el) return;
    const act = (actions || []).find((a) => a.kind === 'navAction');
    el.hidden = !act;
    if (act) {
      el.textContent = act.label || '';
      el.onclick = () => this.fire(act);
    } else {
      el.onclick = null;
    }
  }

  /**
   * Swap to the shift row (or back) and let the screen repaint its body.
   * @param {boolean} on - Whether Shift is held.
   * @returns {void}
   */
  applyShift(on) {
    if (!this.shift || on === this.shiftHeld) return;
    this.shiftHeld = on;
    this.current = on ? this.shift : this.base;
    this.paint(this.current);
    if (this.shiftRepaint) this.shiftRepaint();
  }

  /**
   * Screen change: dismiss any attention prompt, drop the shift row/badge, and
   * run the leaving menu's OWN release (its Back-item job or a composite
   * neutral word), unless activationsHeld() -- a same-menu repaint after a
   * drive is held.
   * @param {BarAction[]} actions - The new primary row.
   * @param {BarAction[]} [shifted] - The new shift row, if any.
   * @returns {void}
   */
  set(actions, shifted) {
    stopLive();
    stopLogging();
    // a data-logging run polls until told otherwise; leaving the screen is
    // the telling, so the bus is free for whatever the next screen does
    if (typeof stopDataLogging === 'function') stopDataLogging();
    if (typeof dismissAttention === 'function') dismissAttention();
    if (!activationsHeld() && typeof runMenuLeave === 'function') {
      runMenuLeave();
    }
    // ...and the menu's session-end job (inpaexit's DIAGNOSE_ENDE), if one was
    // registered. Not conditional on anything energized: a menu can owe a
    // session end having driven nothing. Held by the same repaint guard.
    if (!activationsHeld() && typeof endActivationSession === 'function')
      endActivationSession();
    // a new set of keys is a new screen: the caption over the bar goes back
    // to "Select menu" unless the running script names its menu again
    if (typeof document !== 'undefined')
      document.documentElement.style.removeProperty('--fkeys-caption');
    this.base = actions;
    this.shift = shifted && shifted.length ? shifted : null;
    this.shiftHeld = false;
    this.shiftRepaint = null;
    this.current = actions;
    this.paint(actions);
  }

  /**
   * Run an action, flashing its key.
   * @param {BarAction|undefined} a - The action.
   * @returns {void}
   */
  fire(a) {
    if (!a || !a.fn) return;
    if (a._el) {
      a._el.classList.remove('flash');
      void a._el.offsetWidth;
      a._el.classList.add('flash');
    }
    a.fn();
  }

  /**
   * Keyboard: Shift holds the second row; release/blur restores the first, so
   * the bar never shows keys the next press won't fire. Digits, Esc and
   * Backspace fire actions.
   * @returns {void}
   */
  _wireKeys() {
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Shift') this.applyShift(true);
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Shift') this.applyShift(false);
    });
    window.addEventListener('blur', () => this.applyShift(false));

    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // an open modal owns the keyboard; else Backspace behind a popup re-fires back and stacks it
      if (document.querySelector('.modal-overlay')) return;
      const t = e.target;
      if (
        t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT')
      )
        return;
      const key = e.key;
      // Esc and Backspace both act as back (F10)
      if (key === 'Escape' || key === 'Backspace') {
        const back = this.current.find((a) => a.kind === 'back');
        if (back) {
          e.preventDefault();
          this.fire(back);
        }
        return;
      }
      // Shift makes the browser report "!" for 1, so match the physical digit (e.code); "="/"_" alias +/- for zoom
      const digit = /^Digit(\d)$/.exec(e.code || '');
      const alias = { '=': '+', _: '-' }[key];
      const match =
        this.current.find((a) => a.key === key) ||
        (alias && this.current.find((a) => a.key === alias)) ||
        (digit && this.current.find((a) => a.key === digit[1]));
      if (match) {
        e.preventDefault();
        this.fire(match);
      }
    });
  }
}

/** The one bar. */
const actionBar = new ActionBar();

/**
 * Global delegator for the screens: replace the F-key rows.
 * @param {BarAction[]} actions - Primary row.
 * @param {BarAction[]} [shifted] - Shift row.
 * @returns {void}
 */
function setActions(actions, shifted) {
  actionBar.set(actions, shifted);
}

/**
 * Global delegator: fire an action the way a key press would.
 * @param {BarAction} a - The action.
 * @returns {void}
 */
function fireAction(a) {
  actionBar.fire(a);
}

// activations.js reads the live row through this global.
Object.defineProperty(this, 'currentActions', { get: () => actionBar.current });
