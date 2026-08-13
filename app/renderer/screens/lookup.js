// Fault Lookup screen: offline search across the whole fault database, filtered
// by chassis and module. Data is the generated index (faultindex.js ->
// window.BMW_FAULT_INDEX), lazy-loaded so the large literal isn't parsed before
// first paint.
//
// Each entry is { chassis, module, sgbd, scheme, faults: [[key, english, code]] }.
// scheme "code": key IS the hex DTC (code === key). scheme "text": key is the
// SGBD German fault text, code the ORT hex from FORTTEXTE ("" if unknown).
// Search matches the key, the English text, AND the code.

// lazy-load window.BMW_FAULT_INDEX by injecting faultindex.js once.
function loadFaultIndex() {
  if (window.BMW_FAULT_INDEX) return Promise.resolve();
  if (window.__faultIndexLoading) return window.__faultIndexLoading;
  window.__faultIndexLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'data/faultindex.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('failed to load fault index'));
    document.head.appendChild(s);
  });
  return window.__faultIndexLoading;
}

// lookup screen state persists within a visit so filters survive re-render
const lookupState = { q: '', chassis: '', module: '' };
const LOOKUP_MAX = 400; // cap rendered rows; the count line reports the true total

// prettified module labels harvested from the live chassis config, per chassis:
// { chassisId: { indexModuleValue: "Nice ECU Label" } }. Fault files carry only
// a slug ("bms46"); the config's label ("BMS46 for M43") is prettier. Filtering
// still uses the raw index module value.
const lookupLabels = {};
function lookupModuleLabel(chassis, moduleValue) {
  const m = lookupLabels[chassis];
  return (m && m[moduleValue]) || moduleValue;
}

// custom dropdown for the Lookup screen. options: [{ val, label, meta, count }].
function lookupDropdown(placeholder, options, current, onChange) {
  const root = document.createElement('div');
  root.className = 'lkd';
  root.innerHTML = `
    <button class="lkd-btn" type="button">
      <span class="lkd-val"></span>
      <span class="lkd-caret">▾</span>
    </button>
    <div class="lkd-pop" hidden>
      <input class="lkd-search" type="text" placeholder="Search…" spellcheck="false" autocomplete="off" />
      <div class="lkd-list"></div>
    </div>`;
  const btn = root.querySelector('.lkd-btn');
  const valEl = root.querySelector('.lkd-val');
  const pop = root.querySelector('.lkd-pop');
  const search = root.querySelector('.lkd-search');
  const list = root.querySelector('.lkd-list');
  let opts = options.slice();
  let sel = current;

  const optFor = (v) => opts.find(o => o.val === v);
  const renderVal = () => {
    const o = optFor(sel);
    valEl.textContent = o ? o.label : (placeholder || '');
    valEl.classList.toggle('lkd-placeholder', !o || o.val === '');
  };

  const renderList = (filter = '') => {
    const f = filter.trim().toLowerCase();
    list.innerHTML = '';
    const shown = opts.filter(o => !f
      || o.label.toLowerCase().includes(f)
      || (o.meta && o.meta.toLowerCase().includes(f))
      || String(o.val).toLowerCase().includes(f));
    for (const o of shown) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'lkd-item' + (o.val === sel ? ' active' : '');
      item.innerHTML = `
        <span class="lkd-item-label">${esc(o.label)}</span>
        ${o.meta ? `<span class="lkd-item-meta">${esc(o.meta)}</span>` : ''}
        ${o.count != null ? `<span class="lkd-item-count">${esc(String(o.count))}</span>` : ''}`;
      item.onclick = () => { sel = o.val; renderVal(); onChange(sel); close(); };
      list.appendChild(item);
    }
    if (!list.children.length) list.innerHTML = '<div class="lkd-empty">No matches</div>';
  };

  const open = () => {
    pop.hidden = false; root.classList.add('open');
    search.value = ''; renderList(); setTimeout(() => search.focus(), 10);
    requestAnimationFrame(() => {
      const r = btn.getBoundingClientRect();
      const need = pop.offsetHeight + 8;
      const below = window.innerHeight - r.bottom;
      const up = below < need && r.top > below;
      root.classList.toggle('drop-up', up);
      // cap the list to the real space on the chosen side (down to the F-key
      // bar's actual top, up to the viewport top) so the popup never scrolls
      // the page
      const bar = document.getElementById('fkeybar');
      const floor = bar ? bar.getBoundingClientRect().top : window.innerHeight;
      const MARGIN = 12;
      const avail = up ? (r.top - MARGIN) : (floor - r.bottom - MARGIN);
      const searchH = search.offsetHeight || 42;
      list.style.maxHeight = Math.max(120, avail - searchH) + 'px';
    });
    document.addEventListener('mousedown', onDoc, true);
    window.addEventListener('keydown', onEsc, true);
  };
  const close = () => {
    pop.hidden = true; root.classList.remove('open', 'drop-up');
    document.removeEventListener('mousedown', onDoc, true);
    window.removeEventListener('keydown', onEsc, true);
  };
  const onDoc = (e) => { if (!root.contains(e.target)) close(); };
  const onEsc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };

  btn.onclick = () => (pop.hidden ? open() : close());
  search.oninput = () => renderList(search.value);

  renderVal();
  return {
    el: root,
    setOptions(newOpts, cur) { opts = newOpts.slice(); if (cur !== undefined) sel = cur; renderVal(); },
    value() { return sel; },
    set(v) { sel = v; renderVal(); },
    close,
  };
}

async function showLookup() {
  cancelSweep();
  lastScreen = showLookup;
  setCrumbs([{ label: 'Vehicles', fn: showChassis },
             { label: 'Apps', fn: showApps }, { label: 'Fault Lookup' }]);
  sbLeft.textContent = 'fault lookup';

  view.innerHTML = head('Reference', 'Fault Lookup',
    'Search the fault database across every chassis and module. Works offline, no cable needed.');

  // loading state while the index literal is injected + parsed
  const loading = document.createElement('div');
  loading.className = 'empty';
  loading.innerHTML = '<span class="loader"></span><span>Loading fault database…</span>';
  view.appendChild(loading);

  if (typeof loadPcodes === 'function') loadPcodes();     // warm P-code map
  // warm ISTA metadata (per-variant names, P-codes, 6-digit fleet codes for
  // matchIsta); re-render when it lands so a pending query updates
  if (typeof loadFaultMeta === 'function') loadFaultMeta().then(() => {
    if (typeof render === 'function' && (lookupState.q || lookupState.chassis || lookupState.module)) render();
  });
  try { await loadFaultIndex(); }
  catch (e) { loading.innerHTML = errorBlock(e.message, 'red'); return; }
  loading.remove();

  const index = window.BMW_FAULT_INDEX || [];
  const inpa = typeof inpaMode === 'function' && inpaMode();

  // prefetch each chassis config once to harvest prettified ECU labels, so
  // results/dropdowns show "BMS46 for M43" not the raw "bms46" slug.
  // best-effort: on failure (engine offline) the raw value is used.
  async function ensureLabels(chassisIds) {
    await Promise.all(chassisIds.map(async (id) => {
      if (lookupLabels[id]) return;
      lookupLabels[id] = {}; // mark attempted so we don't refetch every render
      try {
        const ch = await api(`/api/chassis/${id}`);
        const sgbdToModule = {};
        index.filter(e => e.chassis === id).forEach(e => { if (e.sgbd) sgbdToModule[e.sgbd.toLowerCase()] = e.module; });
        (ch.sections || []).forEach(s => s.ecus.forEach(ecu => {
          const mod = sgbdToModule[(ecu.sgbd || '').toLowerCase()];
          if (mod && ecu.label && !lookupLabels[id][mod]) lookupLabels[id][mod] = ecu.label;
        }));
      } catch { /* engine offline: keep raw module values */ }
    }));
  }

  // controls: search box + chassis filter + module filter
  const controls = document.createElement('div');
  controls.className = 'lookup-controls';
  controls.innerHTML = `
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
  view.appendChild(controls);

  const input = controls.querySelector('.lookup-input');
  const clearBtn = controls.querySelector('.lookup-clear');

  // count line + results container
  const countLine = document.createElement('div');
  countLine.className = 'lookup-count';
  view.appendChild(countLine);

  const results = document.createElement('div');
  results.className = 'lookup-results';
  view.appendChild(results);

  // chassis dropdown
  const chassisIds = [...new Set(index.map(e => e.chassis))].sort();
  const chassisCounts = {};
  index.forEach(e => { chassisCounts[e.chassis] = (chassisCounts[e.chassis] || 0) + e.faults.length; });
  const grandTotal = index.reduce((n, e) => n + e.faults.length, 0);
  const chassisOpts = [{ val: '', label: 'All chassis', count: grandTotal }].concat(
    chassisIds.map(id => ({
      val: id, label: id,
      meta: (typeof CHASSIS_TAG !== 'undefined' && CHASSIS_TAG[id]) || '',
      count: chassisCounts[id],
    })));

  const chassisDd = lookupDropdown('All chassis', chassisOpts, lookupState.chassis, (v) => {
    lookupState.chassis = v;
    lookupState.module = ''; // module list depends on chassis; reset
    rebuildModuleControl();
    render();
  });
  controls.querySelector('#slot-chassis').appendChild(chassisDd.el);

  // module control: dropdown (modern) or INPA two-pane popup. options for the
  // current chassis scope; label uses the config name, value the raw module.
  function moduleOptsForScope() {
    const pool = lookupState.chassis ? index.filter(e => e.chassis === lookupState.chassis) : index;
    const byName = new Map();       // module value -> fault count
    const chassisOf = new Map();    // module value -> Set of chassis
    for (const e of pool) {
      // a module spans several variant entries sharing most faults, so show the
      // largest variant's count, not the sum
      byName.set(e.module, Math.max(byName.get(e.module) || 0, e.faults.length));
      if (!chassisOf.has(e.module)) chassisOf.set(e.module, new Set());
      chassisOf.get(e.module).add(e.chassis);
    }
    const oneChassis = (m) => [...chassisOf.get(m)][0];
    const label = (m) => lookupModuleLabel(lookupState.chassis || oneChassis(m), m);
    return [{ val: '', label: 'All modules' }].concat(
      [...byName.keys()].sort((a, b) => label(a).localeCompare(label(b)))
        .map(n => ({
          val: n, label: label(n), count: byName.get(n),
          // "All chassis": the same module name can appear on several chassis;
          // tag it so duplicates are distinguishable
          meta: lookupState.chassis ? '' : [...chassisOf.get(n)].sort().join(' · '),
        })));
  }

  let moduleDd = null;        // modern: the dropdown
  let moduleBtn = null;       // inpa: the button that opens the two-pane popup
  const moduleSlot = controls.querySelector('#slot-module');

  function rebuildModuleControl() {
    moduleSlot.innerHTML = '';
    if (inpa) {
      // INPA: a button opening the two-pane (sections | modules) popup, grouped
      // by INPA section from the live config
      moduleBtn = document.createElement('button');
      moduleBtn.type = 'button';
      moduleBtn.className = 'lkd-btn lkd-inpa-btn';
      const cur = lookupState.module ? lookupModuleLabel(lookupState.chassis, lookupState.module) : 'All modules';
      moduleBtn.innerHTML = `<span class="lkd-val${lookupState.module ? '' : ' lkd-placeholder'}">${esc(cur)}</span><span class="lkd-caret">▾</span>`;
      moduleBtn.onclick = () => openInpaModulePicker();
      moduleSlot.appendChild(moduleBtn);
    } else {
      moduleDd = lookupDropdown('All modules', moduleOptsForScope(), lookupState.module, (v) => {
        lookupState.module = v; render();
      });
      moduleSlot.appendChild(moduleDd.el);
    }
  }
  rebuildModuleControl();

  // INPA two-pane module picker: left = the chassis's INPA sections, right =
  // that section's modules present in the index. Needs a chassis first.
  async function openInpaModulePicker() {
    if (!lookupState.chassis) {
      // no chassis: open the chassis dropdown, that must come first
      chassisDd.el.querySelector('.lkd-btn').click();
      return;
    }
    const chId = lookupState.chassis;
    let ch;
    try { ch = await api(`/api/chassis/${chId}`); }
    catch { ch = null; }

    // index entries for this chassis keyed by sgbd, to attach the config's
    // prettified label to each module while still filtering by module value
    const chEntries = index.filter(e => e.chassis === chId);
    const sgbdToModule = {};
    chEntries.forEach(e => { if (e.sgbd) sgbdToModule[e.sgbd.toLowerCase()] = e.module; });
    const labelForModule = {};

    // build sections from the live config's grouping + labels; each entry is
    // { label (display), module (index value, for filtering) }
    let sections;
    if (ch && ch.sections) {
      sections = ch.sections.map(s => {
        const seen = new Set();
        const modules = [];
        for (const ecu of s.ecus) {
          const mod = sgbdToModule[(ecu.sgbd || '').toLowerCase()];
          if (!mod || seen.has(mod)) continue;
          seen.add(mod);
          const label = ecu.label || mod;
          labelForModule[mod] = label;
          modules.push({ label, module: mod });
        }
        return { name: s.name, modules };
      }).filter(s => s.modules.length);
    } else {
      sections = [{
        name: 'Modules',
        modules: [...new Set(chEntries.map(e => e.module))].sort()
          .map(m => ({ label: m, module: m })),
      }];
    }
    // indexed modules not matched into a config section go under "Other"
    const placed = new Set(sections.flatMap(s => s.modules.map(m => m.module)));
    const orphan = [...new Set(chEntries.map(e => e.module))]
      .filter(m => !placed.has(m)).sort()
      .map(m => ({ label: m, module: m }));
    if (orphan.length) sections.push({ name: 'Other', modules: orphan });

    // expose the config labels so render() shows pretty names too
    lookupLabels[chId] = labelForModule;

    const modalOpts = {
      onKey: (e, c) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); c(); } },
      backdropValue: null,
    };
    const { overlay, close } = openModal(`
      <div class="inpa-scriptsel lookup-modsel" role="dialog" aria-modal="true">
        <div class="inpa-ss-bar">Module — ${esc(chId)}&nbsp;&nbsp;&nbsp;<span class="inpa-ss-hint">(&lt;ESC&gt; to close)</span></div>
        <div class="inpa-ss-panes">
          <div class="inpa-ss-left" id="lms-left">
            <button class="inpa-ss-item inpa-ss-chassis active" data-i="-1">All modules</button>
            ${sections.map((s, i) => `<button class="inpa-ss-item" data-i="${i}">${esc(s.name)}</button>`).join('')}
          </div>
          <div class="inpa-ss-right">
            <div class="inpa-ss-jobs" id="lms-jobs"></div>
          </div>
        </div>
      </div>`, modalOpts);

    const jobsPane = overlay.querySelector('#lms-jobs');
    const items = overlay.querySelectorAll('.inpa-ss-item');
    const pick = (moduleName) => {
      lookupState.module = moduleName || '';
      close();
      rebuildModuleControl();
      render();
    };
    const showAll = () => {
      items.forEach(it => it.classList.toggle('active', it.dataset.i === '-1'));
      jobsPane.innerHTML = `<button class="inpa-ss-job lms-all">All modules${lookupState.chassis ? ` in ${esc(chId)}` : ''}</button>`;
      jobsPane.querySelector('.lms-all').onclick = () => pick('');
    };
    const showSection = (i) => {
      items.forEach(it => it.classList.toggle('active', it.dataset.i === String(i)));
      const sec = sections[i];
      jobsPane.innerHTML = sec.modules.map(m =>
        `<button class="inpa-ss-job${m.module === lookupState.module ? ' active' : ''}" data-m="${esc(m.module)}">${esc(m.label)}</button>`).join('')
        || '<div class="inpa-ss-empty">No modules</div>';
      jobsPane.querySelectorAll('.inpa-ss-job').forEach(b => b.onclick = () => pick(b.dataset.m));
    };
    items.forEach(it => {
      const i = Number(it.dataset.i);
      it.onclick = () => (i === -1 ? showAll() : showSection(i));
    });
    showAll();
  }

  // the location byte a text-scheme code represents, as 2 hex ("0x0B" -> "0b").
  // null for anything that isn't a single location byte (real 4-hex DTCs), so
  // the high-byte fallback only ever matches text-scheme location entries.
  function codeLocByte(code) {
    const c = (code || '').replace(/^0x/i, '').toLowerCase();
    return /^[0-9a-f]{1,2}$/.test(c) ? c.padStart(2, '0') : null;
  }

  // parse a search string into terms. GOTCHA: text-scheme ECUs report a 16-bit
  // F_ORT_NR (0B3F) but FORTTEXTE only holds the high-byte location (0B ->
  // "LWS-ID wrong"), so a full 4-hex term records its HIGH BYTE ("0b") for the
  // fallback -- used ONLY when the exact code isn't found, else it floods.
  function parseTerms(q) {
    return q.trim().toLowerCase().split(/\s+/).filter(Boolean).map(t => {
      // a P-code term resolves to its BMW hex ("p2563" -> also match "27c3")
      const alt = /^p[0-9a-u][0-9a-f]{3}$/i.test(t) && typeof hexForPcode === 'function'
        ? (hexForPcode(t) || '').toLowerCase() || null : null;
      const m = (alt || t).match(/^(?:0x)?([0-9a-f]{4})$/i); // a full 4-hex code
      return { text: t, alt, hi: m ? m[1].slice(0, 2).toLowerCase() : null };
    });
  }

  // useHiByte: the high-byte fallback, kept off unless the exact code wasn't
  // found anywhere, so a full-DTC search stays precise and only widens when it
  // would otherwise return nothing.
  function matches(entry, terms, useHiByte) {
    if (lookupState.chassis && entry.chassis !== lookupState.chassis) return null;
    if (lookupState.module && entry.module !== lookupState.module) return null;
    if (!terms.length) return entry.faults;
    return entry.faults.filter(([k, en, code]) => {
      const hay = (k + ' ' + en + ' ' + (code || '')).toLowerCase();
      const loc = codeLocByte(code);
      return terms.every(t =>
        hay.includes(t.text) ||
        (t.alt && hay.includes(t.alt)) ||            // P-code term -> BMW hex
        (useHiByte && t.hi && loc && loc === t.hi)); // fallback: DTC -> location
    });
  }

  // search BMW_FAULT_META (the ISTA fleet: hex -> {pcodes, variants}) for codes
  // matching all terms, one group per ISTA sgbd. Skips codes in seenCodes (shown
  // by the curated index).
  const ISTA_META_MAX = 400; // cap synthesized rows so a broad term can't flood
  function matchIsta(meta, terms, seenCodes) {
    const bySgbd = new Map(); // sgbd -> rows[[hex, name, hex]]
    let n = 0;
    for (const hex in meta) {
      if (n >= ISTA_META_MAX) break;
      if (hex.length !== 6) continue;       // 6-digit F/G-series codes only
      if (seenCodes.has(hex)) continue;
      const e = meta[hex];
      const pcodes = (e.pcodes || []).join(' ').toLowerCase();
      const hl = hex.toLowerCase();
      for (const v of (e.variants || [])) {
        const hay = hl + ' ' + (v.name || '').toLowerCase() + ' ' + pcodes;
        const ok = terms.every(t => hay.includes(t.text) || (t.alt && hl.includes(t.alt)));
        if (!ok) continue;
        if (!bySgbd.has(v.sgbd)) bySgbd.set(v.sgbd, []);
        bySgbd.get(v.sgbd).push([hex, v.name, hex]);
        n++;
        if (n >= ISTA_META_MAX) break;
      }
    }
    return [...bySgbd.entries()].map(([sgbd, rows]) => ({
      chassis: 'ISTA', module: sgbd, sgbd, scheme: 'code', rows,
    }));
  }

  // is the exact code present anywhere? if so, skip the high-byte fallback.
  function hasExactCodeHit(terms) {
    const hexTerms = terms.filter(t => t.hi);
    if (!hexTerms.length) return true; // no code terms -> nothing to fall back for
    return index.some(e => e.faults.some(([k, en, code]) => {
      const hay = (k + ' ' + en + ' ' + (code || '')).toLowerCase();
      return terms.every(t => hay.includes(t.text) || (t.alt && hay.includes(t.alt)));
    }));
  }

  function render() {
    const terms = parseTerms(lookupState.q);
    clearBtn.hidden = !lookupState.q;

    // no query and no filter -> prompt rather than dump the whole database
    if (!terms.length && !lookupState.chassis && !lookupState.module) {
      results.innerHTML = '';
      countLine.textContent = 'Search a fault code or description, or select a chassis / module to get started.';
      sbRight.textContent = '';
      return;
    }

    // widen a full-DTC search to its high byte ("0B3F" -> "0B") when the exact
    // code isn't found: the low byte is runtime-only and not in the offline
    // tables, so several modules can match and each row's module chip says which
    const useHiByte = !hasExactCodeHit(terms);

    const groups = [];
    let total = 0;
    const seenCodes = new Set(); // codes the curated index already covered
    for (const entry of index) {
      const rows = matches(entry, terms, useHiByte);
      if (!rows || !rows.length) continue;
      total += rows.length;
      rows.forEach(r => { if (r[2]) seenCodes.add(String(r[2]).toUpperCase()); });
      groups.push({ chassis: entry.chassis, module: entry.module, sgbd: entry.sgbd, scheme: entry.scheme, rows });
    }

    // ISTA fleet fallback, ONLY for 6-digit F/G-series codes the curated
    // E-series index doesn't carry. Skipped under a chassis/module filter (meta
    // has no chassis attribution).
    const meta = (typeof window !== 'undefined' && window.BMW_FAULT_META) || null;
    const wants6 = terms.some(t => /^[0-9a-f]{6}$/i.test(t.text));
    if (meta && wants6 && !lookupState.chassis && !lookupState.module) {
      const istaGroups = matchIsta(meta, terms, seenCodes);
      for (const g of istaGroups) { total += g.rows.length; groups.push(g); }
    }

    if (!total) {
      countLine.textContent = terms.length ? `No faults match “${lookupState.q}”.` : 'No faults in scope.';
    } else {
      const scope = lookupState.chassis || 'all chassis';
      const capped = total > LOOKUP_MAX;
      // note when results came from the high-byte fallback, so extra rows make sense
      const byLoc = useHiByte && terms.some(t => t.hi);
      countLine.textContent = `${total.toLocaleString()} fault${total === 1 ? '' : 's'} across ${groups.length} module${groups.length === 1 ? '' : 's'} · ${scope}`
        + (byLoc ? ' · matched by location byte' : '')
        + (capped ? ` · showing first ${LOOKUP_MAX}` : '');
    }
    sbRight.textContent = total ? `${total.toLocaleString()} match${total === 1 ? '' : 'es'}` : '0 matches';

    results.innerHTML = '';
    if (!total) return;
    let shown = 0;
    const frag = document.createDocumentFragment();
    for (const g of groups) {
      if (shown >= LOOKUP_MAX) break;
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
      const rowsToShow = g.rows.slice(0, Math.max(0, LOOKUP_MAX - shown));
      for (const [k, en, code] of rowsToShow) {
        const row = document.createElement('div');
        row.className = 'lookup-row';
        // code column: hex/P-code (code===key for code-scheme, ORT for text).
        // where the BMW hex has a known SAE P-code, stack P-code over hex.
        const pc = code && typeof pcodeForHex === 'function' ? pcodeForHex(code) : null;
        const codeCell = code
          ? (pc
            ? `<span class="lookup-code lookup-code-stack"><span class="lookup-pcode">${esc(pc)}</span><span class="lookup-hex">${esc(code)}</span></span>`
            : `<span class="lookup-code">${esc(code)}</span>`)
          : `<span class="lookup-code lookup-code-none">—</span>`;
        const keyCell = g.scheme === 'text'
          ? `<span class="lookup-key lookup-key-text">${esc(k)}</span>`
          : '';
        // when ISTA has richer data for this hex, make the row expandable
        const hasDetail = code && typeof variantsForHex === 'function'
          && variantsForHex(code).length > 0;
        row.innerHTML = `${codeCell}${keyCell}<span class="lookup-en">${esc(en)}</span>`
          + (hasDetail ? '<span class="lookup-more" aria-hidden="true">›</span>' : '');
        if (hasDetail) {
          row.classList.add('lookup-expandable');
          row.onclick = () => openFaultModal(code, en, g.sgbd);
        }
        body.appendChild(row);
      }
      card.appendChild(body);
      frag.appendChild(card);
      shown += rowsToShow.length;
    }
    results.appendChild(frag);
  }

  // fault detail modal (ISTA variants + service document). The big info file is
  // loaded on demand on first open.
  const _infoFields = [
    ['description', 'Description'], ['setCondition', 'Set condition'],
    ['monitoring', 'Monitoring'], ['timeCondition', 'Time condition'],
    ['terminal', 'Terminal'], ['impact', 'Fault impact'],
    ['warningLamp', 'Warning lamp'], ['ccMessage', 'CC message'],
    ['serviceMeasure', 'Service measure'], ['serviceNote', 'Service note'],
    ['breakdownNote', 'Breakdown note'], ['driverInfo', 'Driver info'],
  ];
  function infoTable(info) {
    if (!info) return '';
    const rows = _infoFields
      .filter(([k]) => info[k] && String(info[k]).trim())
      .map(([k, label]) => `<div class="fi-k">${esc(label)}</div>`
        + `<div class="fi-v">${esc(info[k]).replace(/\n/g, '<br>')}</div>`)
      .join('');
    return rows ? `<div class="fi-grid">${rows}</div>` : '';
  }

  // Show ISTA detail for the ONE clicked entry (the search page already lists
  // every variant as its own row). clickedName picks the matching variant record.
  async function openFaultModal(code, clickedName, sgbd) {
    const hex = String(code).toUpperCase();
    const meta = (window.BMW_FAULT_META && window.BMW_FAULT_META[hex]) || {};
    const pcodes = meta.pcodes || [];
    const variants = (typeof variantsForHex === 'function' ? variantsForHex(code) : []) || [];
    const wantName = (clickedName || '').trim().toLowerCase();
    const wantSgbd = (sgbd || '').toLowerCase();
    // pick the variant record for the clicked module, in order: exact sgbd,
    // sgbd-family prefix (ms_s65 -> ms_s65_2), exact name, else first. Only ever
    // ONE -- never a fan-out.
    const famKey = wantSgbd.replace(/[^a-z0-9]/g, '');
    const picked =
      variants.find(v => (v.sgbd || '').toLowerCase() === wantSgbd) ||
      variants.find(v => { const s = (v.sgbd || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                           return famKey && (s.startsWith(famKey) || famKey.startsWith(s)); }) ||
      variants.find(v => (v.name || '').trim().toLowerCase() === wantName) ||
      variants[0] || null;
    // the row's own text wins the title (it's what the user clicked)
    const title = clickedName || picked?.name || '';

    const pcodeBar = pcodes.length
      ? `<div class="fm-pcodes">${pcodes.map(p => `<span class="fm-pcode">${esc(p)}</span>`).join('')}</div>`
      : '';
    const { overlay, close } = openModal(`
      <div class="modal fault-modal" role="dialog" aria-modal="true">
        <div class="fm-head">
          <div class="fm-code">${esc(hex)}</div>
          <div class="fm-title">${esc(title)}</div>
          <button class="fm-close" aria-label="Close">✕</button>
        </div>
        ${pcodeBar}
        <div class="fm-body" id="fm-body"><div class="fm-loading">Loading service data…</div></div>
      </div>`, { backdropValue: null });
    overlay.querySelector('.fm-close').onclick = () => close();

    if (typeof loadFaultInfo === 'function') await loadFaultInfo();
    if (!document.body.contains(overlay)) return; // closed while loading

    const info = (picked && picked.info != null && typeof faultInfoFor === 'function')
      ? faultInfoFor(code, picked.info) : null;
    const body = overlay.querySelector('#fm-body');
    body.innerHTML = infoTable(info)
      || '<div class="fm-noinfo">No service document for this fault.</div>';
  }

  // debounce the search input
  let debounce = null;
  input.oninput = () => {
    lookupState.q = input.value;
    clearTimeout(debounce);
    debounce = setTimeout(render, 120);
  };
  clearBtn.onclick = () => { input.value = ''; lookupState.q = ''; render(); input.focus(); };

  render();
  setTimeout(() => input.focus(), 30);

  // fetch config labels in the background; re-render (and rebuild the module list)
  // once they arrive so results/dropdowns swap slugs for prettified ECU names.
  ensureLabels([...new Set(index.map(e => e.chassis))]).then(() => {
    rebuildModuleControl();
    render();
  });

  setActions([
    { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: () => showChassis() },
    { key: '1', label: 'Clear filters', fn: () => {
        lookupState.q = ''; lookupState.chassis = ''; lookupState.module = '';
        input.value = '';
        chassisDd.set('');
        rebuildModuleControl();
        render(); input.focus();
      } },
  ]);
}
