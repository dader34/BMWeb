/**
 * @file The Job search app: one screen under the Apps hub that searches every
 * INPA key and screen the build ships, and opens the module at the exact menu
 * and screen a result names.
 *
 * WHY AN APP, NOT A HOME-SCREEN BAR. The home screen is INPA's own vehicle
 * select -- a fixed F1..F10 key list -- and an input box wedged into it fought
 * that layout. The Apps hub is where the reference tools that answer a
 * question before a car is picked already live, so this sits beside the fault
 * lookup and borrows its controls: same search box, same count line, same
 * Esc-to-hub key.
 *
 * THE QUERY IS IN THE ROUTE (#apps/job-search/<query>), so a search is a link
 * someone can send. The input writes it back as the user types, replaceState,
 * so typing does not stack a history entry per keystroke.
 */

/* exported showJobSearch, jobSearchState */

/** Search input debounce, in ms. Matches the fault lookup's feel. */
const JOB_SEARCH_DEBOUNCE_MS = 140;

/** Delay before the box takes focus, so the screen has painted. */
const JOB_SEARCH_FOCUS_MS = 30;

/** The screen's query, kept across re-entries within a visit. */
const jobSearchState = { q: '' };

/**
 * The search box, built from the fault lookup's own controls so the two
 * reference apps look and behave alike.
 * @returns {{el: HTMLDivElement, input: HTMLInputElement, clearBtn: HTMLButtonElement}}
 */
function jobSearchControls() {
  const el = document.createElement('div');
  el.className = 'lookup-controls';
  el.innerHTML = `
    <div class="lookup-search">
      <span class="lookup-search-icon">⌕</span>
      <input class="lookup-input" type="text" spellcheck="false"
             autocomplete="off"
             placeholder="Search every INPA screen: fault memory, lambda, FS_LESEN…"
             value="${esc(jobSearchState.q)}" />
      <button class="lookup-clear" title="Clear" hidden>×</button>
    </div>`;
  return {
    el,
    input: el.querySelector('.lookup-input'),
    clearBtn: el.querySelector('.lookup-clear'),
  };
}

/**
 * The count line over the results.
 * @param {SearchResult} res - the finished search
 * @returns {string}
 */
function jobSearchCountText(res) {
  if (!res.total) return 'No matches.';
  const capped =
    res.shown < res.total ? ` · showing the best ${res.shown}` : '';
  return `${res.total} result${res.total === 1 ? '' : 's'}${capped}`;
}

/**
 * The Job search screen.
 * @param {string|null} [query] - a query from the route (#apps/job-search/<q>)
 * @returns {Promise<void>}
 */
async function showJobSearch(query) {
  cancelSweep();
  if (typeof query === 'string') jobSearchState.q = query;
  lastScreen = () => showJobSearch();
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: 'Apps', fn: showApps },
    { label: 'Job search' },
  ]);
  sbLeft.textContent = 'job search';

  view.innerHTML = head(
    'Reference',
    'Job search',
    "Search every screen and key in INPA's scripts by what it does, then " +
      'open the module right there. Works offline, no cable needed.'
  );

  const controls = jobSearchControls();
  view.appendChild(controls.el);
  const { input, clearBtn } = controls;

  const countLine = document.createElement('div');
  countLine.className = 'lookup-count';
  view.appendChild(countLine);

  const results = document.createElement('div');
  results.className = 'job-search-results';
  view.appendChild(results);

  // The index is ~2 MB and the screen is useful the moment it lands, so it is
  // fetched here rather than on the first keystroke: by the time a query is
  // typed it is usually already in hand.
  let index = searchIndexPeek();
  if (!index) {
    countLine.textContent = '';
    results.innerHTML =
      '<div class="empty"><span class="loader"></span>' +
      '<span>Loading the script index…</span></div>';
    index = await searchIndexLoad();
    if (!index) {
      results.innerHTML = errorBlock(
        'No script index in this build. Re-run the export ' +
          '(tools/export/web_export.py) to add one.'
      );
      countLine.textContent = '';
      setActions([
        {
          key: 'Escape',
          keyLabel: 'Esc',
          label: 'Back',
          kind: 'back',
          fn: () => showApps(),
        },
      ]);
      return;
    }
  }

  /**
   * Run the current query and draw it.
   * @returns {void}
   */
  function render() {
    const q = jobSearchState.q;
    if (typeof routeSetJobSearch === 'function') routeSetJobSearch(q);
    clearBtn.hidden = !q;
    if (!searchTerms(q).length) {
      countLine.textContent = '';
      results.innerHTML = jobSearchEmptyHtml();
      sbRight.textContent = '';
      return;
    }
    const res = searchRun(index, q);
    countLine.textContent = jobSearchCountText(res);
    sbRight.textContent = res.total ? `${res.total} results` : '';
    if (!res.total) {
      searchRenderMessage(results, `Nothing matches “${q.trim()}”.`);
      return;
    }
    searchRenderResults(results, res, (hit, chassis) =>
      searchOpenHit(hit, chassis)
    );
  }

  let debounce = null;
  input.oninput = () => {
    jobSearchState.q = input.value;
    clearTimeout(debounce);
    debounce = setTimeout(render, JOB_SEARCH_DEBOUNCE_MS);
  };
  input.onkeydown = (ev) => {
    if (ev.key === 'Enter') {
      // Enter before the debounce fired means "search now"; once the results
      // on screen belong to what is typed, it opens the first of them.
      ev.preventDefault();
      clearTimeout(debounce);
      const before = jobSearchState.q;
      jobSearchState.q = input.value;
      if (before !== input.value) {
        render();
        return;
      }
      const first = results.querySelector('.search-row');
      if (first) first.click();
    }
  };
  clearBtn.onclick = () => {
    input.value = '';
    jobSearchState.q = '';
    render();
    input.focus();
  };

  render();
  setTimeout(() => input.focus(), JOB_SEARCH_FOCUS_MS);

  setActions([
    {
      key: 'Escape',
      keyLabel: 'Esc',
      label: 'Back',
      kind: 'back',
      fn: () => showApps(),
    },
    {
      key: '1',
      label: 'Clear',
      fn: () => {
        input.value = '';
        jobSearchState.q = '';
        render();
        input.focus();
      },
    },
  ]);
}

/**
 * What the screen shows before anything is typed: what it searches, and the
 * shapes of query that work.
 * @returns {string} HTML
 */
function jobSearchEmptyHtml() {
  return `
    <div class="empty">
      <div class="empty-big">Search INPA's scripts</div>
      <div>Every menu key and screen in every module this build ships,
        by its label in English or German, the screen it opens, the jobs it
        sends, or the result keys it reads.</div>
      <div class="job-search-hints">
        <code>fault memory</code><code>Fehlerspeicher</code>
        <code>lambda</code><code>steering angle</code>
        <code>FS_LESEN</code><code>odometer</code>
      </div>
    </div>`;
}

if (typeof window !== 'undefined') {
  window.showJobSearch = showJobSearch;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { showJobSearch, jobSearchState, jobSearchCountText };
}
