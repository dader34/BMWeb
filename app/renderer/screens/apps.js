// The Apps hub: reference tools ported from BMW's own dealer software, each
// its own self-contained screen with its own data bundle. WDS wiring was the
// first; this section is where the rest land (ETK parts catalogue next). A
// port here is always the wiring shape: raw BMW data stripped of its viewer,
// packed into archives the renderer inflates, drawn by a dedicated screen.
//
// APP_REGISTRY is the single list. To add a ported app: give it an id, the
// card copy, the screen function to open, and (optionally) an async check for
// whether its data actually shipped in this build -- an app with no data is
// shown greyed with a "not in this build" note rather than hidden, so the
// section reads the same whether or not the heavy bundles are present.

const APP_REGISTRY = [
  {
    id: 'lookup',
    icon: '⌕',
    title: 'Fault Lookup',
    desc: 'Search fault codes and descriptions across every chassis',
    tag: 'DTC',
    open: () => showLookup(),
    // always available: the fault database ships with the app shell
    hasData: async () => true,
  },
  {
    id: 'wiring',
    icon: '⌁',
    title: 'Wiring Diagrams',
    desc: "BMW's own schematics, component locations and connector views",
    tag: 'WDS',
    open: () => showWiringChassis(),
    // present if any chassis carries wiring data (same probe the card used)
    hasData: async () => {
      try {
        const ids = typeof wiringChassisList === 'function'
          ? await wiringChassisList() : [];
        return ids.length > 0;
      } catch (e) { return false; }
    },
  },
  {
    id: 'etk',
    icon: '⊞',
    title: 'Parts Catalogue',
    desc: "BMW's ETK: part numbers, diagrams and supersessions by chassis",
    tag: 'ETK',
    open: () => (typeof showEtk === 'function' ? showEtk() : null),
    // present only if at least one chassis actually has an .etk bundle in this build
    hasData: async () => {
      if (typeof showEtk !== 'function' || typeof etkChassisList !== 'function') return false;
      try { return (await etkChassisList()).length > 0; }
      catch (e) { return false; }
    },
  },
  {
    id: 'tool32',
    icon: '⌗',
    title: 'Tool32',
    desc: 'Run any SGBD job directly and read its raw result registers',
    tag: 'SGBD',
    open: () => (typeof showTool32 === 'function' ? showTool32() : null),
    // present if the ECU index shipped (its keys are the runnable SGBDs)
    hasData: async () => {
      if (typeof showTool32 !== 'function' || typeof tool32SgbdList !== 'function') return false;
      try { return (await tool32SgbdList()).length > 0; }
      catch (e) { return false; }
    },
  },
];

async function showApps() {
  lastScreen = showApps;
  setCrumbs([{ label: 'Vehicles', fn: showChassis }, { label: 'Apps' }]);
  document.body.classList.add('apps-section');   // hides the F-key bar on mobile (touch nav)
  sbLeft.textContent = 'apps';
  view.innerHTML = head('Apps', 'Ported Apps',
    "Reference tools ported from BMW's dealer software, offline.");
  setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
                fn: showChassis }]);

  const list = document.createElement('div');
  list.className = 'apps-list stagger';
  view.appendChild(list);

  // availability checks may hit the network (ETK probes Hugging Face), so show
  // a spinner instead of a blank pane while they resolve.
  const loading = document.createElement('div');
  loading.className = 'wiring-loading etk-loading';
  loading.innerHTML = `<span class="wiring-spinner"></span><span>Loading apps…</span>`;
  view.appendChild(loading);

  // resolve availability once, in parallel; a card renders as soon as we know
  const states = await Promise.all(APP_REGISTRY.map(async (a) => {
    let ready = true;
    if (typeof a.hasData === 'function') {
      try { ready = await a.hasData(); } catch (e) { ready = false; }
    }
    return { app: a, ready };
  }));
  loading.remove();

  const openable = [];
  states.forEach(({ app, ready }) => {
    const card = document.createElement('button');
    card.className = 'lookup-entry app-entry' + (ready ? '' : ' app-absent');
    card.innerHTML = `
      <span class="lookup-entry-icon">${app.icon}</span>
      <span class="lookup-entry-text">
        <span class="lookup-entry-title">${esc(app.title)}
          <span class="app-tag">${esc(app.tag)}</span></span>
        <span class="lookup-entry-desc">${esc(app.desc)}${
          ready ? '' : ' · not in this build'}</span>
      </span>
      <span class="lookup-entry-arrow">${ready ? '→' : ''}</span>`;
    if (ready) {
      card.onclick = () => app.open();
      openable.push(app);
    } else {
      card.disabled = true;
    }
    list.appendChild(card);
  });
  stagger(list, 20);
  sbRight.textContent = `${openable.length} app${openable.length === 1 ? '' : 's'}`;

  setActions([
    ...openable.slice(0, 8).map((a, i) => ({
      key: String(i + 1), label: a.title.split(' ')[0], fn: () => a.open(),
    })),
    { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: showChassis },
  ]);
}
