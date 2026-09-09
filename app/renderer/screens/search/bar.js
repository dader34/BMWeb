/**
 * @file The search bar on the home screen: the input, the debounce, and the
 * keyboard contract. One exported function that nav.js drops into the vehicle
 * picker; everything below it (load, match, draw, open) is the other files.
 *
 * WHY IT LIVES ON THE HOME SCREEN. The question it answers -- "which screen
 * reads the steering angle sensor?" -- is asked before a car is picked, and
 * the answer names the car. Making the user choose a chassis first would mean
 * knowing the answer already.
 *
 * THE INDEX LOADS LAZILY. It is ~2 MB, and most visits to the home screen are
 * someone picking their car; the fetch starts on the first keystroke, not on
 * render, and the input says so while it is in flight.
 */

/* exported searchBarMount */

/** Milliseconds of quiet before a query runs. Typing must not run 90k scans per key. */
const SEARCH_DEBOUNCE_MS = 160;

/**
 * Build the search bar and append it to a container.
 *
 * The bar owns its own results panel, so the caller only chooses where it
 * sits. Keyboard: Enter opens the first result, Escape clears the box (and,
 * when it is already empty, gives the key back to whatever else wants it).
 * @param {HTMLElement} host - where the bar goes
 * @returns {HTMLElement} the bar element
 */
function searchBarMount(host) {
  const wrap = document.createElement('div');
  wrap.className = 'search-bar';
  wrap.innerHTML = `
    <div class="search-input-row">
      <span class="search-input-icon">⌕</span>
      <input class="search-input" type="search" autocomplete="off"
        spellcheck="false"
        placeholder="Search every INPA screen — fault memory, lambda, FS_LESEN"
        aria-label="Search every INPA screen and key">
      <span class="search-input-count"></span>
    </div>
    <div class="search-results" hidden></div>`;
  host.appendChild(wrap);

  const input = wrap.querySelector('.search-input');
  const results = wrap.querySelector('.search-results');
  const count = wrap.querySelector('.search-input-count');
  /** @type {SearchResult|null} the last drawn search, for Enter */
  let last = null;
  /** @type {number|undefined} the pending debounce */
  let timer;
  /** The query the visible results belong to, so a stale load cannot overwrite them. */
  let shownFor = null;

  const open = (hit, chassis) => searchOpenHit(hit, chassis);

  /**
   * Run the current query and draw it.
   * @returns {Promise<void>}
   */
  async function run() {
    const q = input.value;
    const terms = searchTerms(q);
    if (!terms.length) {
      results.hidden = true;
      results.innerHTML = '';
      count.textContent = '';
      last = null;
      shownFor = null;
      return;
    }
    results.hidden = false;
    const index = searchIndexPeek();
    if (!index) {
      searchRenderMessage(results, 'Loading the script index…');
      count.textContent = '';
      const loaded = await searchIndexLoad();
      // the user kept typing while the index came down; that keystroke's own
      // run() will draw, and this one must not overwrite it with older words
      if (input.value !== q) return;
      if (!loaded) {
        searchRenderMessage(
          results,
          'No script index in this build — re-run the export to add one.'
        );
        return;
      }
    }
    const res = searchRun(searchIndexPeek(), q);
    last = res;
    shownFor = q;
    count.textContent = res.total
      ? `${res.total}${res.shown < res.total ? ` · showing ${res.shown}` : ''}`
      : '';
    if (!res.total) {
      searchRenderMessage(results, `Nothing matches “${q.trim()}”.`);
      return;
    }
    searchRenderResults(results, res, open);
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, SEARCH_DEBOUNCE_MS);
    // start the download on the first keystroke, so the index is usually
    // there by the time the debounce fires
    searchIndexLoad();
  });

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      // Enter before the debounce fired means "search now", not "open
      // whatever the last query found"
      if (shownFor !== input.value) {
        clearTimeout(timer);
        run();
        return;
      }
      const g = last && last.groups[0];
      const m = g && g.modules[0];
      const hit = m && m.hits[0];
      if (hit) open(hit, g.chassis);
      return;
    }
    if (ev.key === 'Escape') {
      if (!input.value) return; // an empty box has nothing to clear
      ev.preventDefault();
      ev.stopPropagation();
      input.value = '';
      clearTimeout(timer);
      run();
    }
  });

  return wrap;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { searchBarMount, SEARCH_DEBOUNCE_MS };
}
