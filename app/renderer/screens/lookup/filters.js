/**
 * @file The chassis and module filters: the dropdown skin both use (and
 * Tool32 borrows), their option lists built from the index, the prettified
 * ECU labels harvested from each chassis config, and the INPA-mode two-pane
 * module picker.
 */

/* exported lookupDropdown, lookupChassisOptions, lookupModuleOptions, lookupEnsureLabels, lookupOpenInpaModulePicker */

/**
 * One row of a lookup dropdown.
 * @typedef {object} LookupOption
 * @property {string} val - the filter value ('' = all)
 * @property {string} label - display text
 * @property {string} [meta] - secondary text (a chassis tag, or the chassis a module appears on)
 * @property {number} [count] - fault count shown at the right
 */

/**
 * One module in the INPA picker's section panes.
 * @typedef {{ label: string, module: string }} LookupPickerModule
 */

/**
 * One INPA section of the picker: its display name and the indexed modules
 * under it.
 * @typedef {{ name: string, modules: LookupPickerModule[] }} LookupPickerSection
 */

/**
 * The Lookup screen's dropdown, a thin wrapper over the shared ui/dropdown.js.
 * Keeps the `.lkd` class family (val/pop/item, shared with the hand-built INPA
 * module button) via the `parts` remap, and the rich label+meta+count rows,
 * drop-up flip, list-height clamp to the F-key bar, Esc close and mousedown-
 * capture close it always had.
 * @param {string} placeholder - shown when nothing is selected
 * @param {LookupOption[]} options - the rows
 * @param {string} current - the initially selected value
 * @param {(v: string) => void} onChange - selection callback
 * @returns {{ el: HTMLElement, value: () => string, set: (v: string) => void, setOptions: (items: LookupOption[], cur?: string) => void, open: () => void, close: () => void }}
 */
function lookupDropdown(placeholder, options, current, onChange) {
  return makeDropdown({
    items: options,
    value: current,
    onChange,
    placeholder,
    classPrefix: 'lkd',
    parts: { cur: 'val', menu: 'pop', opt: 'item' },
    emptyText: 'No matches',
    clampToBar: '#fkeybar',
    flip: true,
    escClose: true,
    closeOn: 'mousedown',
    focusDelay: 10,
    filterItem: (o, q) =>
      o.label.toLowerCase().includes(q) ||
      (o.meta && o.meta.toLowerCase().includes(q)) ||
      String(o.val).toLowerCase().includes(q),
    renderRow: (o) =>
      `<span class="lkd-item-label">${esc(o.label)}</span>` +
      (o.meta ? `<span class="lkd-item-meta">${esc(o.meta)}</span>` : '') +
      (o.count != null
        ? `<span class="lkd-item-count">${esc(String(o.count))}</span>`
        : ''),
  });
}

/**
 * The chassis dropdown's rows: "All chassis" with the grand total, then every
 * chassis in the index with its tag and fault count.
 * @param {LookupIndexEntry[]} index - the whole fault index
 * @returns {LookupOption[]}
 */
function lookupChassisOptions(index) {
  const chassisIds = [...new Set(index.map((e) => e.chassis))].sort();
  const chassisCounts = {};
  index.forEach((e) => {
    chassisCounts[e.chassis] =
      (chassisCounts[e.chassis] || 0) + e.faults.length;
  });
  const grandTotal = index.reduce((n, e) => n + e.faults.length, 0);
  return [{ val: '', label: 'All chassis', count: grandTotal }].concat(
    chassisIds.map((id) => ({
      val: id,
      label: id,
      meta: (typeof CHASSIS_TAG !== 'undefined' && CHASSIS_TAG[id]) || '',
      count: chassisCounts[id],
    }))
  );
}

/**
 * The module dropdown's rows for the current chassis scope; label uses the
 * config name, value the raw module slug.
 * @param {LookupIndexEntry[]} index - the whole fault index
 * @returns {LookupOption[]}
 */
function lookupModuleOptions(index) {
  const pool = lookupState.chassis
    ? index.filter((e) => e.chassis === lookupState.chassis)
    : index;
  const byName = new Map(); // module value -> fault count
  const chassisOf = new Map(); // module value -> Set of chassis
  for (const e of pool) {
    // a module spans several variant entries sharing most faults, so show the
    // largest variant's count, not the sum
    byName.set(e.module, Math.max(byName.get(e.module) || 0, e.faults.length));
    if (!chassisOf.has(e.module)) chassisOf.set(e.module, new Set());
    chassisOf.get(e.module).add(e.chassis);
  }
  const oneChassis = (m) => [...chassisOf.get(m)][0];
  const label = (m) =>
    lookupModuleLabel(lookupState.chassis || oneChassis(m), m);
  return [{ val: '', label: 'All modules' }].concat(
    [...byName.keys()]
      .sort((a, b) => label(a).localeCompare(label(b)))
      .map((n) => ({
        val: n,
        label: label(n),
        count: byName.get(n),
        // "All chassis": the same module name can appear on several chassis;
        // tag it so duplicates are distinguishable
        meta: lookupState.chassis
          ? ''
          : [...chassisOf.get(n)].sort().join(' · '),
      }))
  );
}

/**
 * Lower-cased sgbd -> module slug, for the entries of one chassis, so a
 * config ECU (which names its sgbd) can be tied to the index's module value.
 * @param {LookupIndexEntry[]} entries - one chassis's index entries
 * @returns {Record<string, string>}
 */
function lookupSgbdToModule(entries) {
  const sgbdToModule = {};
  entries.forEach((e) => {
    if (e.sgbd) sgbdToModule[e.sgbd.toLowerCase()] = e.module;
  });
  return sgbdToModule;
}

/**
 * Prefetch each chassis config once to harvest prettified ECU labels, so
 * results/dropdowns show "BMS46 for M43" not the raw "bms46" slug.
 * Best-effort: on failure (engine offline) the raw value is used.
 * @param {LookupIndexEntry[]} index - the whole fault index
 * @param {string[]} chassisIds - the chassis to harvest
 * @returns {Promise<void>}
 */
async function lookupEnsureLabels(index, chassisIds) {
  await Promise.all(
    chassisIds.map(async (id) => {
      if (lookupLabels[id]) return;
      lookupLabels[id] = {}; // mark attempted so we don't refetch every render
      try {
        const ch = await api(`/api/chassis/${id}`);
        const sgbdToModule = lookupSgbdToModule(
          index.filter((e) => e.chassis === id)
        );
        (ch.sections || []).forEach((s) =>
          s.ecus.forEach((ecu) => {
            const mod = sgbdToModule[(ecu.sgbd || '').toLowerCase()];
            if (mod && ecu.label && !lookupLabels[id][mod])
              lookupLabels[id][mod] = ecu.label;
          })
        );
      } catch {
        /* engine offline: keep raw module values */
      }
    })
  );
}

/**
 * The INPA picker's sections for a chassis: the live config's grouping and
 * labels when it answered, else one flat "Modules" section; indexed modules
 * not matched into a config section go under "Other".
 * @param {LookupIndexEntry[]} chEntries - the chassis's index entries
 * @param {{ sections?: { name: string, ecus: { sgbd?: string, label?: string }[] }[] }|null} ch - the chassis config, or null when the engine is offline
 * @returns {{ sections: LookupPickerSection[], labelForModule: Record<string, string> }}
 */
function lookupInpaSections(chEntries, ch) {
  // index entries for this chassis keyed by sgbd, to attach the config's
  // prettified label to each module while still filtering by module value
  const sgbdToModule = lookupSgbdToModule(chEntries);
  const labelForModule = {};
  let sections;
  if (ch && ch.sections) {
    sections = ch.sections
      .map((s) => {
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
      })
      .filter((s) => s.modules.length);
  } else {
    sections = [
      {
        name: 'Modules',
        modules: [...new Set(chEntries.map((e) => e.module))]
          .sort()
          .map((m) => ({ label: m, module: m })),
      },
    ];
  }
  const placed = new Set(
    sections.flatMap((s) => s.modules.map((m) => m.module))
  );
  const orphan = [...new Set(chEntries.map((e) => e.module))]
    .filter((m) => !placed.has(m))
    .sort()
    .map((m) => ({ label: m, module: m }));
  if (orphan.length) sections.push({ name: 'Other', modules: orphan });
  return { sections, labelForModule };
}

/**
 * INPA two-pane module picker: left = the chassis's INPA sections, right =
 * that section's modules present in the index. Needs a chassis first: with
 * none picked it opens the chassis dropdown instead.
 * @param {LookupIndexEntry[]} index - the whole fault index
 * @param {() => void} openChassisPicker - opens the chassis dropdown
 * @param {(moduleName: string) => void} onPick - a module (or '' = all) was chosen
 * @returns {Promise<void>}
 */
async function lookupOpenInpaModulePicker(index, openChassisPicker, onPick) {
  if (!lookupState.chassis) {
    openChassisPicker();
    return;
  }
  const chId = lookupState.chassis;
  let ch;
  try {
    ch = await api(`/api/chassis/${chId}`);
  } catch {
    ch = null;
  }
  const chEntries = index.filter((e) => e.chassis === chId);
  const { sections, labelForModule } = lookupInpaSections(chEntries, ch);
  // expose the config labels so the results show pretty names too
  lookupLabels[chId] = labelForModule;

  const modalOpts = {
    onKey: (e, c) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        c();
      }
    },
    backdropValue: null,
  };
  const { overlay, close } = openModal(
    `
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
      </div>`,
    modalOpts
  );

  const jobsPane = overlay.querySelector('#lms-jobs');
  const items = overlay.querySelectorAll('.inpa-ss-item');
  const pick = (moduleName) => {
    close();
    onPick(moduleName || '');
  };
  const showAll = () => {
    items.forEach((it) => it.classList.toggle('active', it.dataset.i === '-1'));
    jobsPane.innerHTML = `<button class="inpa-ss-job lms-all">All modules${lookupState.chassis ? ` in ${esc(chId)}` : ''}</button>`;
    jobsPane.querySelector('.lms-all').onclick = () => pick('');
  };
  const showSection = (i) => {
    items.forEach((it) =>
      it.classList.toggle('active', it.dataset.i === String(i))
    );
    const sec = sections[i];
    jobsPane.innerHTML =
      sec.modules
        .map(
          (m) =>
            `<button class="inpa-ss-job${m.module === lookupState.module ? ' active' : ''}" data-m="${esc(m.module)}">${esc(m.label)}</button>`
        )
        .join('') || '<div class="inpa-ss-empty">No modules</div>';
    jobsPane
      .querySelectorAll('.inpa-ss-job')
      .forEach((b) => (b.onclick = () => pick(b.dataset.m)));
  };
  items.forEach((it) => {
    const i = Number(it.dataset.i);
    it.onclick = () => (i === -1 ? showAll() : showSection(i));
  });
  showAll();
}
