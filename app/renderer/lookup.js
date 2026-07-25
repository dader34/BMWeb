// Fault Lookup screen: offline search across the whole fault database, filtered
// by chassis and by ECU/module. Data comes from the generated structured index
// (faultindex.js -> window.BMW_FAULT_INDEX), loaded lazily the same way the flat
// faultdb is, so the large literal isn't parsed before first paint.
//
// Each index entry is { chassis, module, sgbd, scheme, faults: [[key, english, code]] }.
// scheme "code": key IS the hex DTC (code === key). scheme "text": key is the SGBD
// German fault text; code is the ORT hex from the FORTTEXTE table ("" if unknown).
// Searching matches the key, the English text, AND the code.

// lazy-load window.BMW_FAULT_INDEX by injecting faultindex.js once.
function loadFaultIndex() {
  if (window.BMW_FAULT_INDEX) return Promise.resolve();
  if (window.__faultIndexLoading) return window.__faultIndexLoading;
  window.__faultIndexLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'faultindex.js';
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
// { chassisId: { indexModuleValue: "Nice ECU Label" } }. Some fault files carry
// only a slug module name (e.g. E46 "bms46"); the config's ECU label ("BMS46 for
// M43") is the same name the chassis->sections screen shows, so prefer it for
// display. Filtering still uses the raw index module value.
const lookupLabels = {};
// display name for an index module value on a given chassis: config label if known.
function lookupModuleLabel(chassis, moduleValue) {
  const m = lookupLabels[chassis];
  return (m && m[moduleValue]) || moduleValue;
}

// custom dropdown for the Lookup screen. options: [{ val, label, meta, count }].
// renders a rich row (label + optional meta tag + optional count). returns
// { el, setOptions(opts, cur), value(), set(v) }. onChange(val) fires on pick.
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
      // cap the scrolling list to the real space available on the chosen side. The
      // downward limit is the footer F-key bar's actual top (not a guess); the
      // upward limit is the top of the viewport. Reserve the pinned search box + a
      // small margin so the popup always fits and the page never scrolls to hold it.
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
  setCrumbs([{ label: 'Vehicles', fn: showChassis }, { label: 'Fault Lookup' }]);
  sbLeft.textContent = 'fault lookup';

  view.innerHTML = head('Reference', 'Fault Lookup',
    'Search the fault database across every chassis and module. Works offline, no cable needed.');

  // loading state while the index literal is injected + parsed
  const loading = document.createElement('div');
  loading.className = 'empty';
  loading.innerHTML = '<span class="loader"></span><span>Loading fault database…</span>';
  view.appendChild(loading);

  if (typeof loadPcodes === 'function') loadPcodes();     // warm P-code map for search + stacked display
  // warm ISTA metadata (per-variant names, P-codes, and the full fleet incl. 6-digit
  // codes searched via matchIsta). Re-render when it lands so a pending query updates.
  if (typeof loadFaultMeta === 'function') loadFaultMeta().then(() => {
    if (typeof render === 'function' && (lookupState.q || lookupState.chassis || lookupState.module)) render();
  });
  try { await loadFaultIndex(); }
  catch (e) { loading.innerHTML = errorBlock(e.message, 'red'); return; }
  loading.remove();

  const index = window.BMW_FAULT_INDEX || [];
  const inpa = typeof inpaMode === 'function' && inpaMode();

  // prefetch the live config for every chassis in the index (once) to harvest the
  // prettified ECU labels the chassis->sections screen uses, so results/dropdowns
  // show "BMS46 for M43" instead of the raw "bms46" slug. best-effort: on failure
  // (engine offline) the raw module value is used. cached per chassis in lookupLabels.
  async function ensureLabels(chassisIds) {
    await Promise.all(chassisIds.map(async (id) => {
      if (lookupLabels[id]) return;
      lookupLabels[id] = {}; // mark attempted so we don't refetch on every render
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

  // ---- controls: search box + chassis filter + module filter ----
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

  // ---- chassis dropdown (custom, rich rows) ----
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

  // ---- module control: custom dropdown (modern) OR INPA two-pane popup ----
  // module options for the current chassis scope, with per-module fault counts.
  // label uses the prettified config name; value stays the raw index module.
  function moduleOptsForScope() {
    const pool = lookupState.chassis ? index.filter(e => e.chassis === lookupState.chassis) : index;
    const byName = new Map();       // module value -> fault count (max across variant entries)
    const chassisOf = new Map();    // module value -> Set of chassis it appears on
    for (const e of pool) {
      // a module can span several variant entries (same name, different sgbd); they
      // share most faults, so show the largest variant's count, not the sum.
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
          // in "All chassis" mode the same module name can appear on several chassis;
          // tag it so duplicates are distinguishable (e.g. "E60 · E90").
          meta: lookupState.chassis ? '' : [...chassisOf.get(n)].sort().join(' · '),
        })));
  }

  let moduleDd = null;        // modern: the custom dropdown
  let moduleBtn = null;       // inpa: the button that opens the two-pane popup
  const moduleSlot = controls.querySelector('#slot-module');

  function rebuildModuleControl() {
    moduleSlot.innerHTML = '';
    if (inpa) {
      // INPA mode: a button that opens the two-pane (sections | modules) popup,
      // built from the live chassis config so it groups modules by INPA section.
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

  // INPA two-pane module picker: left pane = the chassis's INPA sections, right
  // pane = that section's modules (only those present in the fault index). needs a
  // chassis selected; if "All chassis", nudge the user to pick one first.
  async function openInpaModulePicker() {
    if (!lookupState.chassis) {
      // no chassis chosen: open the chassis dropdown instead, that must come first
      chassisDd.el.querySelector('.lkd-btn').click();
      return;
    }
    const chId = lookupState.chassis;
    let ch;
    try { ch = await api(`/api/chassis/${chId}`); }
    catch { ch = null; }

    // index entries for this chassis, keyed by sgbd, so we can attach the config's
    // prettified ECU label (same names shown on the chassis->sections screen) to each
    // indexed module while still filtering by the index's own module value.
    const chEntries = index.filter(e => e.chassis === chId);
    const sgbdToModule = {};
    chEntries.forEach(e => { if (e.sgbd) sgbdToModule[e.sgbd.toLowerCase()] = e.module; });
    // display label for a module value: the config ECU label if we have one, else
    // the module value itself. built below from the live config.
    const labelForModule = {};

    // build sections: prefer the live config's grouping + labels. each module entry
    // is { label (prettified, for display), module (index value, for filtering) }.
    let sections;
    if (ch && ch.sections) {
      sections = ch.sections.map(s => {
        const seen = new Set();
        const modules = [];
        for (const ecu of s.ecus) {
          const mod = sgbdToModule[(ecu.sgbd || '').toLowerCase()];
          if (!mod || seen.has(mod)) continue; // not indexed, or already listed
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
    // anything indexed but not matched into a config section goes under "Other",
    // labelled by its index module value (no config label available).
    const placed = new Set(sections.flatMap(s => s.modules.map(m => m.module)));
    const orphan = [...new Set(chEntries.map(e => e.module))]
      .filter(m => !placed.has(m)).sort()
      .map(m => ({ label: m, module: m }));
    if (orphan.length) sections.push({ name: 'Other', modules: orphan });

    // expose the config labels so render()/rebuildModuleControl show pretty names too
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

  // the location byte a stored text-scheme code represents, as a 2-hex string:
  // "0x0B" -> "0b", "0x1F" -> "1f". Returns null for codes that aren't a single
  // location byte (real 4-hex DTCs from code-scheme ECUs), so the high-byte fallback
  // only ever matches text-scheme location entries.
  function codeLocByte(code) {
    const c = (code || '').replace(/^0x/i, '').toLowerCase();
    return /^[0-9a-f]{1,2}$/.test(c) ? c.padStart(2, '0') : null;
  }

  // parse a raw search string into terms. a full 4-hex-digit DTC (e.g. "0B3F",
  // "0x0B3F") records its HIGH BYTE ("0b"): text-scheme ECUs report a 16-bit
  // F_ORT_NR at read time (0B3F) but the offline FORTTEXTE table only holds the
  // high-byte location (0B -> "LWS-ID wrong"). The high byte is used ONLY as a
  // fallback (see render) so it doesn't flood results with every ECU's location 0B.
  function parseTerms(q) {
    return q.trim().toLowerCase().split(/\s+/).filter(Boolean).map(t => {
      // a P-code term resolves to its BMW hex ("p2563" -> also match "27c3")
      const alt = /^p[0-9a-u][0-9a-f]{3}$/i.test(t) && typeof hexForPcode === 'function'
        ? (hexForPcode(t) || '').toLowerCase() || null : null;
      const m = (alt || t).match(/^(?:0x)?([0-9a-f]{4})$/i); // a full 4-hex code
      return { text: t, alt, hi: m ? m[1].slice(0, 2).toLowerCase() : null };
    });
  }

  // ---- filtering ----
  // useHiByte: enable the high-byte fallback for full-hex terms. Kept off unless the
  // exact code wasn't found anywhere (decided once per render), so a normal full-DTC
  // search stays precise and only widens when it would otherwise return nothing.
  function matches(entry, terms, useHiByte) {
    if (lookupState.chassis && entry.chassis !== lookupState.chassis) return null;
    if (lookupState.module && entry.module !== lookupState.module) return null;
    if (!terms.length) return entry.faults;
    return entry.faults.filter(([k, en, code]) => {
      const hay = (k + ' ' + en + ' ' + (code || '')).toLowerCase();
      const loc = codeLocByte(code); // this row's location byte, or null
      return terms.every(t =>
        hay.includes(t.text) ||
        (t.alt && hay.includes(t.alt)) ||            // P-code term -> its BMW hex
        (useHiByte && t.hi && loc && loc === t.hi)); // fallback: full DTC -> location-byte entry
    });
  }

  // search BMW_FAULT_META (the full ISTA fleet: hex -> {pcodes, variants}) for
  // codes matching all terms, returning lookup groups (one per ISTA sgbd). Codes
  // already in `seenCodes` (shown by the curated index) are skipped. Terms match
  // the hex code, the variant English name, or a P-code (via t.alt / term text).
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

  // does any entry contain a literal match for every full-hex term? (i.e. the exact
  // code is present) - if so we don't need the high-byte fallback.
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

    // nothing to search yet: no query and no chassis/module filter -> prompt the
    // user rather than dumping the entire fault database.
    if (!terms.length && !lookupState.chassis && !lookupState.module) {
      results.innerHTML = '';
      countLine.textContent = 'Search a fault code or description, or select a chassis / module to get started.';
      sbRight.textContent = '';
      return;
    }

    // widen a full-DTC search to its high byte ("0B3F"/"7411" -> location "0B"/"74")
    // whenever the exact code isn't found anywhere. A read-out code's low byte is
    // runtime-only and not in the offline tables, so its high byte is all we can match
    // - across every module (each may have a "74"), so several rows can come back; the
    // module chip on each identifies which one is yours.
    const useHiByte = !hasExactCodeHit(terms);

    const groups = [];
    let total = 0;
    const seenCodes = new Set(); // hex codes the curated index already covered
    for (const entry of index) {
      const rows = matches(entry, terms, useHiByte);
      if (!rows || !rows.length) continue;
      total += rows.length;
      rows.forEach(r => { if (r[2]) seenCodes.add(String(r[2]).toUpperCase()); });
      groups.push({ chassis: entry.chassis, module: entry.module, sgbd: entry.sgbd, scheme: entry.scheme, rows });
    }

    // ISTA fleet fallback, ONLY for 6-digit F/G-series codes (the ones the curated
    // E-series index doesn't carry). A 6-hex-digit search term triggers it; 4-digit
    // searches stay on the curated data. Skipped when a chassis/module filter is
    // active (meta has no chassis attribution) or no query is typed.
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
      // note when results came from the high-byte fallback (a full read-out code
      // matched by its location byte across modules), so the extra rows make sense.
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
        // code column: the hex/P-code (code === key for code-scheme, ORT for
        // text-scheme). "text" scheme also shows its German source phrase.
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
        // when ISTA has richer data for this hex (per-variant descriptions or a
        // service document), mark the row expandable and open a detail panel on click.
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

  // ---- fault detail modal (ISTA variants + service document) ----
  // opens a large modal for a hex code showing every ECU variant that reports it
  // (each with its own English text + info doc) and, per variant, the ISTA
  // service document (conditions, monitoring, service measure, notes). The big
  // info file is loaded on demand the first time a modal is opened.
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

  // Show ISTA detail for the ONE clicked entry. The search page already lists every
  // ECU variant as its own row, so the modal is just that row's code, name, P-codes,
  // and (if present) its service document. `clickedName` is the exact English text
  // the row displayed - we use it to pick the matching ISTA variant record.
  async function openFaultModal(code, clickedName, sgbd) {
    const hex = String(code).toUpperCase();
    const meta = (window.BMW_FAULT_META && window.BMW_FAULT_META[hex]) || {};
    const pcodes = meta.pcodes || [];
    const variants = (typeof variantsForHex === 'function' ? variantsForHex(code) : []) || [];
    const wantName = (clickedName || '').trim().toLowerCase();
    const wantSgbd = (sgbd || '').toLowerCase();
    // pick the ISTA variant record for the clicked module. BMacW's row text/sgbd
    // don't always equal ISTA's, so try in order: exact sgbd, sgbd-family prefix
    // (ms_s65 -> ms_s65_2), exact name, else the first variant. We only ever show
    // ONE - the module the user clicked - never a fan-out (the search list already
    // shows every variant as its own row).
    const famKey = wantSgbd.replace(/[^a-z0-9]/g, '');
    const picked =
      variants.find(v => (v.sgbd || '').toLowerCase() === wantSgbd) ||
      variants.find(v => { const s = (v.sgbd || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                           return famKey && (s.startsWith(famKey) || famKey.startsWith(s)); }) ||
      variants.find(v => (v.name || '').trim().toLowerCase() === wantName) ||
      variants[0] || null;
    // the row's own text is authoritative for the title (it's what the user clicked)
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

  // ---- wiring ----
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
