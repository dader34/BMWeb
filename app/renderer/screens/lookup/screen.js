/**
 * @file The Diagnostic Plans and Trouble Codes screen: offline search across
 * the whole fault database, filtered by chassis and module, with each hit
 * opening its ISTA service document. Works offline, no cable needed.
 */

/* exported showLookup */

/** Search input debounce, in ms. */
const LOOKUP_DEBOUNCE_MS = 120;

/** Delay before the search box takes focus, so the screen has painted. */
const LOOKUP_FOCUS_MS = 30;

/**
 * The search box and the two filter slots.
 * @returns {{ el: HTMLDivElement, input: HTMLInputElement, clearBtn: HTMLButtonElement, chassisSlot: HTMLElement, moduleSlot: HTMLElement }}
 */
function lookupControls() {
  const el = document.createElement('div');
  el.className = 'lookup-controls';
  el.innerHTML = `
    <div class="lookup-search">
      <span class="lookup-search-icon">⌕</span>
      <input class="lookup-input" type="text" placeholder="Search fault text or code…"
             spellcheck="false" autocomplete="off" value="${esc(lookupState.q)}" />
      <button class="lookup-clear" title="Clear" hidden>×</button>
    </div>
    <div class="lookup-filters">
      <label class="lookup-filter">
        <span class="lookup-filter-lbl">Chassis</span>
        <span class="lookup-filter-slot" id="slot-chassis"></span>
      </label>
      <label class="lookup-filter">
        <span class="lookup-filter-lbl">Module</span>
        <span class="lookup-filter-slot" id="slot-module"></span>
      </label>
    </div>`;
  return {
    el,
    input: el.querySelector('.lookup-input'),
    clearBtn: el.querySelector('.lookup-clear'),
    chassisSlot: el.querySelector('#slot-chassis'),
    moduleSlot: el.querySelector('#slot-module'),
  };
}

/**
 * The code column of a result row: hex/P-code (code===key for code-scheme,
 * ORT for text). Where the BMW hex has a known SAE P-code, stack P-code over
 * hex.
 * @param {string} code - the row's code ('' if unknown)
 * @returns {string} HTML
 */
function lookupCodeCell(code) {
  if (!code) return `<span class="lookup-code lookup-code-none">—</span>`;
  const pc = typeof pcodeForHex === 'function' ? pcodeForHex(code) : null;
  return pc
    ? `<span class="lookup-code lookup-code-stack"><span class="lookup-pcode">${esc(pc)}</span><span class="lookup-hex">${esc(code)}</span></span>`
    : `<span class="lookup-code">${esc(code)}</span>`;
}

/**
 * One result row. When ISTA has richer data for this hex the row expands
 * into the fault detail modal.
 * @param {LookupResultGroup} g - the row's group (for its scheme and sgbd)
 * @param {LookupFaultRow} row - the fault
 * @returns {HTMLDivElement}
 */
function lookupResultRow(g, [k, en, code]) {
  const row = document.createElement('div');
  row.className = 'lookup-row';
  const keyCell =
    g.scheme === 'text'
      ? `<span class="lookup-key lookup-key-text">${esc(k)}</span>`
      : '';
  const hasDetail = !!code && lookupVariantsFor(code).length > 0;
  row.innerHTML =
    `${lookupCodeCell(code)}${keyCell}<span class="lookup-en">${esc(en)}</span>` +
    (hasDetail ? '<span class="lookup-more" aria-hidden="true">›</span>' : '');
  if (hasDetail) {
    row.classList.add('lookup-expandable');
    row.onclick = () => openFaultModal(code, en, g.sgbd);
  }
  return row;
}

/**
 * One result group card: the module head, then up to `limit` of its rows.
 * @param {LookupResultGroup} g - the group
 * @param {number} limit - rows to render
 * @returns {{ el: HTMLDivElement, shown: number }}
 */
function lookupResultGroup(g, limit) {
  const card = document.createElement('div');
  card.className = 'lookup-group';
  card.innerHTML = `
        <div class="lookup-group-head">
          <span class="lookup-chip">${esc(g.chassis)}</span>
          <span class="lookup-group-name">${esc(lookupModuleLabel(g.chassis, g.module))}</span>
          ${g.sgbd ? `<span class="lookup-group-sgbd">${esc(g.sgbd)}</span>` : ''}
          <span class="lookup-group-count">${g.rows.length}</span>
        </div>`;
  const body = document.createElement('div');
  body.className = 'lookup-rows';
  const rowsToShow = g.rows.slice(0, Math.max(0, limit));
  for (const row of rowsToShow) body.appendChild(lookupResultRow(g, row));
  card.appendChild(body);
  return { el: card, shown: rowsToShow.length };
}

/**
 * The count line over the results.
 * @param {LookupSearchResult} res - the finished search
 * @param {LookupTerm[]} terms - the parsed terms
 * @returns {string}
 */
function lookupCountText(res, terms) {
  const { total, groups, useHiByte } = res;
  if (!total) {
    return terms.length
      ? `No faults match “${lookupState.q}”.`
      : 'No faults in scope.';
  }
  const scope = lookupState.chassis || 'all chassis';
  const capped = total > LOOKUP_MAX;
  // note when results came from the high-byte fallback, so extra rows make sense
  const byLoc = useHiByte && terms.some((t) => t.hi);
  return (
    `${total.toLocaleString()} fault${total === 1 ? '' : 's'} across ${groups.length} module${groups.length === 1 ? '' : 's'} · ${scope}` +
    (byLoc ? ' · matched by location byte' : '') +
    (capped ? ` · showing first ${LOOKUP_MAX}` : '')
  );
}

/**
 * Show the fault lookup screen.
 * @returns {Promise<void>}
 */
async function showLookup() {
  cancelSweep();
  lastScreen = showLookup;
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: 'Apps', fn: showApps },
    { label: 'Diagnostics' },
  ]);
  sbLeft.textContent = 'diagnostics';

  view.innerHTML = head(
    'Reference',
    'Diagnostic Plans and Trouble Codes',
    'Search fault codes across every chassis; open one for its ISTA service ' +
      'data and diagnostic procedure. Works offline, no cable needed.'
  );

  // loading state while the index literal is injected + parsed
  const loading = document.createElement('div');
  loading.className = 'empty';
  loading.innerHTML =
    '<span class="loader"></span><span>Loading fault database…</span>';
  view.appendChild(loading);

  // the renderer, once the controls exist; the metadata warm-up below may
  // land before then
  let rerender = null;
  if (typeof loadPcodes === 'function') loadPcodes(); // warm P-code map
  // warm ISTA metadata (per-variant names, P-codes, 6-digit fleet codes for
  // the fleet fallback); re-render when it lands so a pending query updates
  if (typeof loadFaultMeta === 'function')
    loadFaultMeta().then(() => {
      if (
        rerender &&
        (lookupState.q || lookupState.chassis || lookupState.module)
      )
        rerender();
    });
  try {
    await loadFaultIndex();
  } catch (e) {
    loading.innerHTML = errorBlock(e.message, 'red');
    return;
  }
  loading.remove();

  /** @type {LookupIndexEntry[]} */
  const index = window.BMW_FAULT_INDEX || [];
  const inpa = typeof inpaMode === 'function' && inpaMode();

  const controls = lookupControls();
  view.appendChild(controls.el);
  const { input, clearBtn } = controls;

  // count line + results container
  const countLine = document.createElement('div');
  countLine.className = 'lookup-count';
  view.appendChild(countLine);

  const results = document.createElement('div');
  results.className = 'lookup-results';
  view.appendChild(results);

  const chassisDd = lookupDropdown(
    'All chassis',
    lookupChassisOptions(index),
    lookupState.chassis,
    (v) => {
      lookupState.chassis = v;
      lookupState.module = ''; // module list depends on chassis; reset
      rebuildModuleControl();
      render();
    }
  );
  controls.chassisSlot.appendChild(chassisDd.el);

  // module control: dropdown (modern) or INPA two-pane popup
  /** Rebuild the module control for the current chassis scope. */
  function rebuildModuleControl() {
    controls.moduleSlot.innerHTML = '';
    if (inpa) {
      // INPA: a button opening the two-pane (sections | modules) popup, grouped
      // by INPA section from the live config
      const moduleBtn = document.createElement('button');
      moduleBtn.type = 'button';
      moduleBtn.className = 'lkd-btn lkd-inpa-btn';
      const cur = lookupState.module
        ? lookupModuleLabel(lookupState.chassis, lookupState.module)
        : 'All modules';
      moduleBtn.innerHTML = `<span class="lkd-val${lookupState.module ? '' : ' lkd-placeholder'}">${esc(cur)}</span><span class="lkd-caret">▾</span>`;
      moduleBtn.onclick = () =>
        lookupOpenInpaModulePicker(
          index,
          // no chassis: open the chassis dropdown, that must come first
          () => chassisDd.el.querySelector('.lkd-btn').click(),
          (moduleName) => {
            lookupState.module = moduleName;
            rebuildModuleControl();
            render();
          }
        );
      controls.moduleSlot.appendChild(moduleBtn);
    } else {
      const moduleDd = lookupDropdown(
        'All modules',
        lookupModuleOptions(index),
        lookupState.module,
        (v) => {
          lookupState.module = v;
          render();
        }
      );
      controls.moduleSlot.appendChild(moduleDd.el);
    }
  }
  rebuildModuleControl();

  /** Run the search for the current state and draw the results. */
  function render() {
    const terms = lookupParseTerms(lookupState.q);
    clearBtn.hidden = !lookupState.q;

    // no query and no filter -> prompt rather than dump the whole database
    if (!terms.length && !lookupState.chassis && !lookupState.module) {
      results.innerHTML = '';
      countLine.textContent =
        'Search a fault code or description, or select a chassis / module to get started.';
      sbRight.textContent = '';
      return;
    }

    const res = lookupSearch(index, terms);
    const { groups, total } = res;
    countLine.textContent = lookupCountText(res, terms);
    sbRight.textContent = total
      ? `${total.toLocaleString()} match${total === 1 ? '' : 'es'}`
      : '0 matches';

    results.innerHTML = '';
    if (!total) return;
    let shown = 0;
    const frag = document.createDocumentFragment();
    for (const g of groups) {
      if (shown >= LOOKUP_MAX) break;
      const card = lookupResultGroup(g, LOOKUP_MAX - shown);
      frag.appendChild(card.el);
      shown += card.shown;
    }
    results.appendChild(frag);
  }
  rerender = render;

  // debounce the search input
  let debounce = null;
  input.oninput = () => {
    lookupState.q = input.value;
    clearTimeout(debounce);
    debounce = setTimeout(render, LOOKUP_DEBOUNCE_MS);
  };
  clearBtn.onclick = () => {
    input.value = '';
    lookupState.q = '';
    render();
    input.focus();
  };

  render();
  setTimeout(() => input.focus(), LOOKUP_FOCUS_MS);

  // fetch config labels in the background; re-render (and rebuild the module list)
  // once they arrive so results/dropdowns swap slugs for prettified ECU names.
  lookupEnsureLabels(index, [...new Set(index.map((e) => e.chassis))]).then(
    () => {
      rebuildModuleControl();
      render();
    }
  );

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
      label: 'Clear filters',
      fn: () => {
        lookupState.q = '';
        lookupState.chassis = '';
        lookupState.module = '';
        input.value = '';
        chassisDd.set('');
        rebuildModuleControl();
        render();
        input.focus();
      },
    },
  ]);

  lookupOpenSharedFault();
}

/**
 * Shared link (?dtc=HEX): open that fault's detail. Guards on a modal not
 * already being up, so a re-render (labels loading, etc.) doesn't stack a
 * second copy, and closing the modal (which strips ?dtc) doesn't reopen it.
 * @returns {void}
 */
function lookupOpenSharedFault() {
  const dtc = getDtcParam();
  if (!dtc || document.querySelector('.fault-modal')) return;
  (async () => {
    if (typeof loadFaultMeta === 'function') await loadFaultMeta();
    if (!getDtcParam()) return; // closed/navigated before load
    // Resolve the NAME from the shared link's sgbd, not variants[0]. A hex
    // like 0XCE carries 18 variants across unrelated modules, so [0] is a
    // different fault on a different ECU than the one that was shared
    // (0XCE [0] is a DME knock-control fault; kombi46 is the outside-temp
    // sensor). clickedName wins the modal title, so passing [0]'s name
    // mislabels the fault even when the right sgbd is handed over. Match
    // the sgbd the same way openFaultModal does: exact, then family prefix.
    const v = lookupPickVariant(lookupVariantsFor(dtc.hex), dtc.sgbd, null);
    // ?n wins the title when present: it is the label the sender actually
    // saw on the row. The sgbd is passed through even when nothing matched,
    // so the modal reports the module that was shared rather than silently
    // substituting another one.
    openFaultModal(
      dtc.hex,
      dtc.name || (v ? v.name : ''),
      dtc.sgbd || (v ? v.sgbd : '')
    );
  })();
}
