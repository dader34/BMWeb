/**
 * @file Drawing the results: chassis groups, module groups, and one row per
 * key or screen. Reads a finished SearchResult (screens/search/match.js) and
 * writes DOM; it does no matching of its own.
 */

/* exported searchRenderResults, searchRenderMessage */

/**
 * The F-key a menu item sits on, as INPA prints it. Numbers above 10 are the
 * shifted bank, so 14 is Shift+F4.
 * @param {number|undefined} nr - the item's key number
 * @returns {string} e.g. "F4", "⇧F4", or '' when the entry has no key
 */
function searchKeyLabel(nr) {
  if (typeof nr !== 'number' || !nr) return '';
  return nr > 10 ? `⇧F${nr - 10}` : `F${nr}`;
}

/**
 * One result row.
 * @param {SearchHit} hit - the row
 * @returns {string} HTML
 */
function searchRowHtml(hit) {
  const e = hit.entry;
  const key = searchKeyLabel(e.n);
  const jobs = (hit.jobs || []).slice(0, 4);
  const kind = e.t === 'k' ? 'key' : 'screen';
  // a write key is marked so the row itself says what pressing it would do;
  // opening the row never presses it (screens/search/open.js)
  const write = e.w
    ? '<span class="search-tag search-tag-write">writes</span>'
    : '';
  return `
    <button class="search-row" type="button">
      <span class="search-row-key">${esc(key || (kind === 'screen' ? '▤' : ''))}</span>
      <span class="search-row-text">
        <span class="search-row-label">${esc(hit.label)}${write}</span>
        ${hit.sub ? `<span class="search-row-sub">${esc(hit.sub)}</span>` : ''}
        ${
          jobs.length
            ? `<span class="search-row-jobs">${jobs
                .map((j) => `<code>${esc(j)}</code>`)
                .join(
                  ''
                )}${(hit.jobs || []).length > jobs.length ? '<span class="search-row-more">…</span>' : ''}</span>`
            : ''
        }
      </span>
      <span class="search-row-arrow">→</span>
    </button>`;
}

/**
 * Draw a finished search into a container, wiring each row to open it.
 * @param {HTMLElement} host - where the results go (emptied first)
 * @param {SearchResult} res - the finished search
 * @param {(hit: SearchHit, chassis: string) => void} onOpen - row click handler
 * @returns {void}
 */
function searchRenderResults(host, res, onOpen) {
  host.innerHTML = '';
  if (!res.groups.length) return;
  for (const g of res.groups) {
    const sec = document.createElement('div');
    sec.className = 'search-group';
    const name = g.chassis ? dispChassis(g.chassis) : 'Other scripts';
    sec.innerHTML = `<div class="search-group-head">
      <span class="search-group-name">${esc(name)}</span>
      <span class="search-group-count">${g.total} result${g.total === 1 ? '' : 's'}</span>
    </div>`;
    for (const m of g.modules) {
      const box = document.createElement('div');
      box.className = 'search-module';
      const label = m.module.label || m.module.sgbd;
      box.innerHTML =
        `<div class="search-module-head">${esc(label)}` +
        `<span class="search-module-sgbd">${esc(m.module.sgbd)}.prg</span></div>` +
        m.hits.map(searchRowHtml).join('');
      box.querySelectorAll('.search-row').forEach((btn, i) => {
        btn.onclick = () => onOpen(m.hits[i], g.chassis);
      });
      sec.appendChild(box);
    }
    host.appendChild(sec);
  }
  stagger(host, 14);
}

/**
 * Draw a one-line state (searching, nothing found, index unavailable) in
 * place of results.
 * @param {HTMLElement} host - where it goes
 * @param {string} msg - the message
 * @returns {void}
 */
function searchRenderMessage(host, msg) {
  host.innerHTML = `<div class="search-msg">${esc(msg)}</div>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { searchRenderResults, searchRenderMessage };
}
