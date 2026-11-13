/**
 * @file The Administration dialog: the wrench icon's window.
 *
 * DRAWN FROM THE TOOL'S OWN LAYOUT (AdministrationDialog), with what this
 * build cannot use taken out rather than drawn grey. The tool's dialog has
 * six tabs for a dealership's installation; a build one person runs on
 * their own car can act on a few of its settings, and an option that does
 * nothing is not an option. What stays, and where the tool has it:
 *
 *   Client settings   Select language: the tool's twenty languages. The
 *                     workshop pages' own words come from the tool's string
 *                     tables, which ship for all twenty; documents are in
 *                     English whatever is picked.
 *   Dealer data       Address: the workshop's country, which is what a
 *                     validity rule's country test compares (the tool reads
 *                     it from its dealer record, where it cannot be edited;
 *                     here it is the one field of that record there is).
 *                     Preselection operation type breakdown: whether a new
 *                     operation starts as a workshop case or a breakdown.
 *   Version           the tool's list of what is installed.
 *
 * WHAT IS LEFT OUT, and why:
 *   brand             this build serves one brand
 *   printing type     the browser's print dialog chooses the printer
 *   news range        there is no news feed
 *   delete order data nothing is uploaded or kept on a server to expire
 *   dealer numbers, licence, dealer data update   a franchise's records
 *   Initial operation settings   its one option starts the tool's trace
 *   Vehicle interface   the interface types and hosts are the tool's own
 *                     network equipment; the cable is chosen when it is
 *                     plugged in
 *   Data protection   it lists vehicles whose data is not sent to BMW, and
 *                     nothing is sent
 *
 * The app's own preferences that the tool has no place for (screen layout,
 * confirming actuator tests, original ECU texts) are on the app's Settings
 * screen, not here.
 *
 * NOTHING IS WRITTEN UNTIL OK, so Cancel really does cancel.
 */

/* exported istaAdminOpen ISTA_ADMIN_KEEP istaAdminPrune istaAdminLanguage
   ISTA_ADMIN_LANG_KEY ISTA_ADMIN_BREAKDOWN_KEY */

/** Settings key: the workshop pages' language, as a culture (en-GB). */
const ISTA_ADMIN_LANG_KEY = 'bmweb.ista.lang';
/** Settings key: Workshop | Breakdown, or unset for neither. */
const ISTA_ADMIN_BREAKDOWN_KEY = 'bmweb.ista.breakdownPre';

/** What of the tool's dialog this build keeps. */
const ISTA_ADMIN_KEEP = {
  tabs: ['admClient', 'admDealer', 'admVersion'],
  // a radio stays when it edits one of these settings
  radios: ['Settings.AppLanguage', 'Settings.BreakdownPreSelection'],
  labels: ['#SelectLanguage', '#BreakdownPreSelection'],
  // the dealer record's one field there is here
  texts: ['#Address:'],
  values: ['OutletCountry'],
};

/** The workshop countries offered, as the dialog had them. */
const ISTA_ADMIN_COUNTRIES = [
  ['', 'Browser region'],
  ['US', 'US'],
  ['CA', 'CA'],
  ['GB', 'GB'],
  ['DE', 'DE'],
  ['AU', 'AU'],
  ['JP', 'JP'],
];

/**
 * The tool's dialog with what this build cannot use taken out.
 *
 * A control stays when ISTA_ADMIN_KEEP names it; a container stays when
 * something in it does. A language radio's caption is a child text block
 * in the layout and becomes the radio's own text.
 * @param {object} node - a node of the compiled layout
 * @returns {object|null} the kept copy, or null when nothing in it stays
 */
function istaAdminPrune(node) {
  const K = ISTA_ADMIN_KEEP;
  const t = node.t;
  if (t === 'TabItem' && !K.tabs.includes(node.n)) return null;
  if (t === 'RadioButton') {
    if (!node.checked || !K.radios.includes(node.checked.bind)) return null;
    // the caption sits somewhere inside the radio's own content
    const find = (n) =>
      n.t === 'TextBlock' && n.text
        ? n
        : (n.kids || []).map(find).find(Boolean) || null;
    const caption = (node.kids || []).map(find).find(Boolean);
    return {
      ...node,
      kids: [],
      text: node.text || (caption && caption.text) || { lit: '' },
      // every language whose words ship is on offer
      en: undefined,
      vis: undefined,
    };
  }
  if (t === 'Label')
    return node.text && K.labels.includes(node.text.loc) ? node : null;
  if (t === 'TextBlock') {
    const x = node.text || {};
    if (x.loc && K.texts.includes(x.loc)) return node;
    if (x.bind && K.values.includes(x.bind)) return { ...node, n: x.bind };
    return null;
  }
  if (node.columns && node.columns.length) return node;
  if (
    /^(Button|CheckBox|TextBox|PasswordBox|ComboBox|GroupBox|Image|DialogHeader)$/.test(
      t
    )
  )
    return null;
  const kids = (node.kids || []).map(istaAdminPrune).filter(Boolean);
  if (!kids.length) return null;
  // A RECORD THINNED TO ONE FIELD IS ONE LINE. The dealer record is a grid
  // of a dozen rows, name over street over country; with only the country
  // left, its caption and its value would sit rows apart in an otherwise
  // empty grid. What is left is put on one row: caption, then value.
  if (node.t === 'Grid' && node.rows && kids.every((k) => k.t === 'TextBlock'))
    return {
      ...node,
      rows: ['Auto'],
      // caption, then value, from the left edge the other settings start at
      cols: kids.map((k, i) => (i < kids.length - 1 ? 'Auto' : '*')),
      a: { ...(node.a || {}), margin: '6,10,0,14' },
      kids: kids.map((k, i) => ({
        ...k,
        a: { ...(k.a || {}), row: '0', col: String(i), margin: '0,0,12,0' },
      })),
    };
  return { ...node, kids };
}

/**
 * The workshop pages' language as the tool's dialog names it (en_GB).
 * @returns {string}
 */
function istaAdminLanguage() {
  const culture =
    typeof istaXamlCulture === 'function' ? istaXamlCulture() : 'en-GB';
  return String(culture).replace('-', '_');
}

/**
 * The Version tab's rows, in the tool's columns.
 * @returns {Array<object>}
 */
function istaAdminVersions() {
  // the same answer every other screen gives: the shell's or the web
  // build's version, or 'dev' on a checkout
  const app =
    typeof remoteVersion === 'function'
      ? remoteVersion()
      : (typeof window !== 'undefined' &&
          ((window.bmweb && window.bmweb.version) || window.BMWEB_VERSION)) ||
        '';
  const rows = [
    { Package: 'BMWeb', SubSystem: 'Application', VersionNumber: app || '-' },
    {
      Package: 'ISTA',
      SubSystem: 'Layouts and data',
      VersionNumber: '4.15.16',
    },
  ];
  for (const r of rows) {
    r.Date = '';
    r.Size = '';
  }
  return rows;
}

/**
 * Open the Administration dialog over the page.
 *
 * Nothing is written until OK, so Cancel leaves every setting as it was.
 * @param {() => void} [onApply] - called after OK wrote the changes
 * @returns {Promise<void>}
 */
async function istaAdminOpen(onApply) {
  if (typeof openModal !== 'function') return;
  const [tpl, strings, fallback] = await Promise.all([
    istaXamlLoad('AdministrationDialog'),
    istaXamlStrings(istaXamlCulture()),
    istaXamlStrings('en-GB'),
  ]);
  const words = strings || fallback || {};
  const root = tpl && tpl.root ? istaAdminPrune(tpl.root) : null;
  const get = (key, def) =>
    typeof Settings === 'object' && Settings ? Settings.get(key, def) : def;
  // the edits, applied on OK
  const state = {
    AppLanguage: istaAdminLanguage(),
    BreakdownPreSelection: get(ISTA_ADMIN_BREAKDOWN_KEY, ''),
    country: get('istaCountry', ''),
  };

  const first = { ...state };

  const title = istaXamlText({ strings: words }, '#Administration');
  const text = (key) => esc(istaXamlText({ strings: words }, key));
  const { overlay, close } = openModal(
    `<div class="modal iradmin ixdialog" role="dialog" aria-modal="true">` +
      `<div class="modal-title iradmin-title">${esc(title)}` +
      `<button type="button" class="iradmin-x" aria-label="Close">` +
      `✕</button></div>` +
      `<div class="ixdialog-host ista-real-body iradmin-host"></div>` +
      `<div class="modal-actions iradmin-actions">` +
      `<button type="button" class="btn iradmin-cancel">` +
      `${text('#Button.Cancel')}</button>` +
      `<button type="button" class="btn iradmin-ok">` +
      `${text('#Button.OK')}</button>` +
      `</div></div>`
  );
  const host = overlay.querySelector('.iradmin-host');
  const ctx = {
    strings: words,
    tabs: {},
    data: {},
    converters: {
      LanguageAvailabilityConverter: () => true,
      BrandAvailabilityConverter: () => false,
    },
    set: (path, checked, n) => {
      if (!checked || !n || !n.checked) return;
      state[path.split('.').pop()] = n.checked.param;
      draw();
    },
    commands: {},
  };

  function draw() {
    ctx.data = {
      Settings: {
        AppLanguage: state.AppLanguage,
        BreakdownPreSelection: state.BreakdownPreSelection,
      },
      OutletCountry: state.country,
      VersionInformation: istaAdminVersions(),
    };
    if (!root) {
      host.innerHTML =
        `<div class="irgrey-w">The Administration layout is not in this ` +
        `build.</div>`;
      return;
    }
    host.replaceChildren(
      ...(root.kids || [root]).map((k) => istaXamlNode(k, ctx.data, ctx))
    );
    // the dealer record's country is the one field that can be set here
    const cell = host.querySelector('[data-xname="OutletCountry"]');
    if (cell) {
      const pick = document.createElement('select');
      pick.className = 'iradmin-country';
      for (const [val, label] of ISTA_ADMIN_COUNTRIES) {
        const o = document.createElement('option');
        o.value = val;
        o.textContent = label;
        o.selected = val === state.country;
        pick.appendChild(o);
      }
      pick.onchange = () => {
        state.country = pick.value;
      };
      cell.replaceChildren(pick);
    }
  }
  ctx.redraw = draw;

  overlay.querySelector('.iradmin-x').onclick = () => close();
  overlay.querySelector('.iradmin-cancel').onclick = () => close();
  overlay.querySelector('.iradmin-ok').onclick = () => {
    // only what was changed is written: an untouched language stays the
    // app's own choice rather than being pinned by a press of OK
    if (typeof Settings === 'object' && Settings && Settings.set) {
      if (state.AppLanguage !== first.AppLanguage)
        Settings.set(ISTA_ADMIN_LANG_KEY, state.AppLanguage.replace('_', '-'));
      if (state.BreakdownPreSelection !== first.BreakdownPreSelection)
        Settings.set(ISTA_ADMIN_BREAKDOWN_KEY, state.BreakdownPreSelection);
      if (state.country !== first.country)
        Settings.set('istaCountry', state.country);
    }
    close();
    if (typeof onApply === 'function') onApply();
  };
  draw();
}

if (typeof window !== 'undefined') window.istaAdminOpen = istaAdminOpen;

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ISTA_ADMIN_KEEP,
    ISTA_ADMIN_LANG_KEY,
    ISTA_ADMIN_BREAKDOWN_KEY,
    istaAdminPrune,
    istaAdminLanguage,
    istaAdminOpen,
  };
}
