/**
 * @file Open-document tabs. A workspace of open documents shown as a tab strip
 * above the panes: a tree click opens a NEW tab (or focuses one already open),
 * each tab remembers its entry so switching re-renders that document, and the
 * strip persists per chassis so the workspace survives leaving and returning
 * to the wiring screen.
 */

/* exported
   wiringTabsLoad, WiringTabStrip */

/**
 * What a tab remembers about its document: a WDS leaf (doc = SP id), an ISTA
 * document (doc = "d:<id>", isDoc) or a glossary leaf (no doc at all).
 * @typedef {Object} WiringTabEntry
 * @property {string} name - title shown on the tab
 * @property {string} kind - leaf kind or ISTA INFOTYPE ('' when unknown)
 * @property {string} [doc] - SP doc id, or "d:<id>" for an ISTA document
 * @property {string | number} [docId] - bare ISTA document id
 * @property {boolean} [isDoc] - true for an ISTA document
 * @property {string[]} [trail] - folder path (present on index entries)
 */

/**
 * The persisted shape of one chassis's workspace.
 * @typedef {Object} WiringTabsState
 * @property {WiringTabEntry[]} open - the open tabs, left to right
 * @property {string | null} active - key (wiringTabKey) of the active tab
 */

/**
 * localStorage key: { CHASSIS: { open:[{doc,name,kind}], active:doc } }.
 * localStorage is best-effort -- a private window or a wiped store just
 * starts with no tabs.
 */
const WIRING_TABS_KEY = 'wiring.tabs';

/**
 * Read one chassis's saved workspace.
 * @param {string} chassisId - chassis code, any case
 * @returns {WiringTabsState}
 */
function wiringTabsLoad(chassisId) {
  try {
    const all = JSON.parse(localStorage.getItem(WIRING_TABS_KEY) || '{}');
    const st = all[chassisId.toUpperCase()];
    if (st && Array.isArray(st.open)) return st;
  } catch (e) {
    /* ignore */
  }
  return { open: [], active: null };
}

/**
 * Save one chassis's workspace, each tab reduced to what re-opening needs.
 * @param {string} chassisId - chassis code, any case
 * @param {WiringTabsState} state - the open tabs and the active key
 * @returns {void}
 */
function wiringTabsSave(chassisId, state) {
  try {
    const all = JSON.parse(localStorage.getItem(WIRING_TABS_KEY) || '{}');
    all[chassisId.toUpperCase()] = {
      open: state.open.map((t) => ({ doc: t.doc, name: t.name, kind: t.kind })),
      active: state.active,
    };
    localStorage.setItem(WIRING_TABS_KEY, JSON.stringify(all));
  } catch (e) {
    /* quota / private mode: tabs are a convenience, not critical */
  }
}

/**
 * A document tab keys on its doc id; a glossary leaf has none, so key it by a
 * stable synthetic id ("glossary:<name>").
 * @param {WiringTabEntry | null | undefined} entry - a tab entry
 * @returns {string | null | undefined}
 */
function wiringTabKey(entry) {
  return entry && (entry.doc || 'glossary:' + (entry.name || ''));
}

/**
 * The tab strip: owns the open list and the active key, draws the strip, and
 * hands document rendering back to the screen through its hooks.
 */
class WiringTabStrip {
  /**
   * @param {HTMLElement} el - the strip container (#wiring-tabs)
   * @param {string} chassisId - chassis the workspace persists under
   * @param {{render: (entry: WiringTabEntry) => void, empty: () => void}} hooks
   *   - render draws a tab's document into the view pane; empty draws the
   *   placeholder when the last tab closes
   */
  constructor(el, chassisId, hooks) {
    this.el = el;
    this.chassisId = chassisId;
    this.hooks = hooks;
    /** @type {WiringTabEntry[]} */
    this.open = [];
    /** @type {string | null} */
    this.active = null;
  }

  /**
   * Persist the workspace.
   * @returns {void}
   */
  persist() {
    wiringTabsSave(this.chassisId, { open: this.open, active: this.active });
  }

  /**
   * Is a tab for this entry open?
   * @param {WiringTabEntry} entry - a tab entry
   * @returns {boolean}
   */
  has(entry) {
    return this.open.some((t) => wiringTabKey(t) === wiringTabKey(entry));
  }

  /**
   * Is this entry the active tab?
   * @param {WiringTabEntry} entry - a tab entry
   * @returns {boolean}
   */
  isActive(entry) {
    return this.active === wiringTabKey(entry);
  }

  /**
   * The entry of the active tab, if any.
   * @returns {WiringTabEntry | null}
   */
  activeEntry() {
    return this.open.find((t) => wiringTabKey(t) === this.active) || null;
  }

  /**
   * Draw the strip; hidden when nothing is open.
   * @returns {void}
   */
  render() {
    const tabsEl = this.el;
    if (!this.open.length) {
      tabsEl.hidden = true;
      tabsEl.innerHTML = '';
      return;
    }
    tabsEl.hidden = false;
    tabsEl.innerHTML = '';
    this.open.forEach((entry) => tabsEl.appendChild(this.tabElement(entry)));
    // keep the active tab in view when the strip overflows
    const act = tabsEl.querySelector('.wiring-tab.active');
    if (act && act.scrollIntoView) {
      act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  /**
   * One tab: kind dot, name, close button; middle-click closes like a browser.
   * @param {WiringTabEntry} entry - the tab's entry
   * @returns {HTMLDivElement}
   */
  tabElement(entry) {
    const active = this.isActive(entry);
    const tab = document.createElement('div');
    tab.className = 'wiring-tab' + (active ? ' active' : '');
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
    tab.title = entry.name;
    const kind = WIRING_KIND_LABEL[entry.kind] ? entry.kind : 'document';
    tab.innerHTML =
      `<span class="wiring-tab-dot kind-${esc(kind)}">` +
      `<span class="wiring-dot"></span></span>` +
      `<span class="wiring-tab-name">${esc(entry.name)}</span>` +
      `<button class="wiring-tab-close" aria-label="Close tab"` +
      ` title="Close">×</button>`;
    tab.querySelector('.wiring-tab-name').onclick = () => this.focusTab(entry);
    tab.querySelector('.wiring-tab-dot').onclick = () => this.focusTab(entry);
    tab.querySelector('.wiring-tab-close').onclick = (ev) => {
      ev.stopPropagation();
      this.closeTab(entry);
    };
    tab.onmousedown = (ev) => {
      if (ev.button === 1) {
        ev.preventDefault();
        this.closeTab(entry);
      }
    };
    return tab;
  }

  /**
   * Open-or-focus: focus the tab if the doc is already open, else add it.
   * @param {WiringTabEntry} entry - the document to open
   * @returns {void}
   */
  openTab(entry) {
    const existing = this.open.find(
      (t) => wiringTabKey(t) === wiringTabKey(entry)
    );
    if (existing) {
      this.focusTab(existing);
      return;
    }
    this.open.push(entry);
    this.active = wiringTabKey(entry);
    this.render();
    this.persist();
    this.hooks.render(entry);
  }

  /**
   * Make an open tab the active one and draw its document. Focusing the tab
   * that is already active only redraws the strip.
   * @param {WiringTabEntry} entry - an open tab's entry
   * @returns {void}
   */
  focusTab(entry) {
    if (this.isActive(entry)) {
      this.render();
      return;
    }
    this.active = wiringTabKey(entry);
    this.render();
    this.persist();
    this.hooks.render(entry);
  }

  /**
   * Close a tab. Closing the active one focuses the neighbour to the left,
   * else the next one, else nothing (the placeholder).
   * @param {WiringTabEntry} entry - an open tab's entry
   * @returns {void}
   */
  closeTab(entry) {
    const i = this.open.findIndex(
      (t) => wiringTabKey(t) === wiringTabKey(entry)
    );
    if (i < 0) return;
    const wasActive = this.isActive(entry);
    this.open.splice(i, 1);
    if (wasActive) {
      const next = this.open[i - 1] || this.open[i] || this.open[0] || null;
      this.active = next ? wiringTabKey(next) : null;
      this.render();
      this.persist();
      if (next) this.hooks.render(next);
      else this.hooks.empty();
    } else {
      this.render();
      this.persist();
    }
  }

  /**
   * Swap the active tab's entry for another and draw it: prev/next moves the
   * active tab through tree order rather than opening a new tab per step --
   * stepping is browsing, not collecting.
   * @param {WiringTabEntry} entry - the document to show in the active tab
   * @returns {void}
   */
  replaceActive(entry) {
    const i = this.open.indexOf(this.activeEntry());
    this.open[i] = entry;
    this.active = wiringTabKey(entry);
    this.render();
    this.persist();
    this.hooks.render(entry);
  }

  /**
   * Draw the active tab's document, or the placeholder when there is none.
   * @returns {void}
   */
  renderActive() {
    const entry = this.activeEntry();
    if (entry) this.hooks.render(entry);
    else this.hooks.empty();
  }

  /**
   * Restore a persisted workspace. Each saved tab is re-tied to a live entry
   * by `resolve` (null skips it, e.g. a rebuilt archive that dropped a doc);
   * the saved active key is kept when that tab survived, else the first tab
   * becomes active.
   * @param {WiringTabsState} saved - what wiringTabsLoad returned
   * @param {(t: WiringTabEntry) => WiringTabEntry | null} resolve - saved tab -> live entry
   * @returns {void}
   */
  restore(saved, resolve) {
    saved.open.forEach((t) => {
      const entry = resolve(t);
      if (entry && !this.has(entry)) this.open.push(entry);
    });
    this.active = this.open.some((t) => wiringTabKey(t) === saved.active)
      ? saved.active
      : this.open[0]
        ? wiringTabKey(this.open[0])
        : null;
    this.render();
  }
}
