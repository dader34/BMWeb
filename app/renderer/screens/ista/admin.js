/**
 * @file The Administration dialog: the wrench icon's window.
 *
 * WHY THIS IS NOT THE APP'S SETTINGS SCREEN. The wrench used to navigate to
 * the app's own Settings page, which tore the workshop chrome down and left
 * the reader somewhere else entirely -- the one thing the real tool never
 * does. In ISTA the wrench opens a WINDOW over the page you are on, you
 * change something, you press OK, and you are still on the same page. So
 * this is a modal, and leaving the ISTA page is not one of its outcomes.
 *
 * IT EDITS THE APP'S REAL SETTINGS. The rows are drawn in the tool's own
 * radio-grid language, but each one reads and writes the same Settings key
 * the app's Settings screen does. There is no second copy of any preference:
 * change the layout here and the Settings screen agrees, and the other way
 * round. Nothing is applied until OK, so Cancel really does cancel.
 *
 * WHAT IS GREY. The real tool's Administration has tabs for a dealership's
 * own data (Dealer data, Initial operation settings, Data protection) and a
 * brand picker for a franchise that sells several. None of that exists in a
 * build one person runs on their own car, so those tabs draw their layout
 * and say so rather than going missing.
 */

/* exported istaAdminOpen */

/** The dialog's tabs, in strip order. */
const ISTA_ADMIN_TABS = [
  { id: 'client', label: 'Client settings' },
  { id: 'dealer', label: 'Dealer data' },
  { id: 'version', label: 'Version' },
  { id: 'initial', label: 'Initial operation settings' },
  { id: 'interface', label: 'Vehicle interface' },
  { id: 'privacy', label: 'Data protection' },
];

/**
 * The settings the Client tab edits, as the tool's radio rows.
 *
 * Each row names a real Settings key. `why` marks a row the tool has that
 * this build cannot honour: it draws with its choices visible and refuses
 * the click, which is the honest shape for a preference that exists in the
 * real tool and not here.
 * @returns {Array<object>} the rows
 */
function istaAdminRows() {
  return [
    {
      key: 'lang',
      title: 'Select language',
      options: [
        { val: 'en', label: 'English' },
        { val: 'orig', label: 'Original (EDIABAS)' },
      ],
      now: typeof Settings === 'object' ? Settings.get('lang', 'en') : 'en',
    },
    {
      key: 'inpaScreens',
      title: 'Screen layout',
      options: [
        { val: 'on', label: 'INPA layout' },
        { val: 'off', label: 'Modern' },
      ],
      now:
        typeof Settings === 'object' ? Settings.get('inpaScreens', 'on') : 'on',
    },
    {
      key: 'confirmActuators',
      title: 'Confirm actuator tests',
      options: [
        { val: 'on', label: 'Ask first' },
        { val: 'off', label: 'Send immediately' },
      ],
      now:
        typeof Settings === 'object'
          ? Settings.get('confirmActuators', 'on')
          : 'on',
    },
    {
      key: '_brand',
      title: 'Select brand',
      options: [
        { val: 'bmw', label: 'BMW / MINI' },
        { val: 'pkw', label: 'BMW / PKW' },
        { val: 'i', label: 'BMW i' },
        { val: 'mini', label: 'MINI' },
        { val: 'rr', label: 'Rolls-Royce' },
        { val: 'moto', label: 'BMW / Motorrad' },
      ],
      now: 'bmw',
      why: 'this build serves one brand',
    },
    {
      key: '_printing',
      title: 'Printing type',
      options: [
        { val: 'file', label: 'Print to file' },
        { val: 'pick', label: 'Printer selection' },
        { val: 'default', label: 'Print from default printer' },
      ],
      now: 'pick',
      why: "the browser's own print dialog chooses the printer",
    },
  ];
}

/**
 * One radio row, in the tool's grid.
 * @param {object} row - from istaAdminRows
 * @param {Object<string, string>} pending - edits not yet applied
 * @returns {string} HTML
 */
function istaAdminRowHtml(row, pending) {
  const now = Object.prototype.hasOwnProperty.call(pending, row.key)
    ? pending[row.key]
    : row.now;
  const opts = row.options
    .map(
      (o) =>
        `<label class="iradmin-opt${row.why ? ' off' : ''}">` +
        `<input type="radio" name="iradmin-${esc(row.key)}" ` +
        `value="${esc(o.val)}"${o.val === now ? ' checked' : ''}` +
        `${row.why ? ' disabled' : ''} />` +
        `<span>${esc(o.label)}</span></label>`
    )
    .join('');
  return (
    `<div class="iradmin-row" data-key="${esc(row.key)}">` +
    `<div class="iradmin-row-t">${esc(row.title)}` +
    (row.why ? ` <span class="iradmin-why">(${esc(row.why)})</span>` : '') +
    `</div>` +
    `<div class="iradmin-opts">${opts}</div></div>`
  );
}

/**
 * The body of one Administration tab.
 * @param {string} tab - the tab id
 * @param {Object<string, string>} pending - edits not yet applied
 * @returns {string} HTML
 */
function istaAdminBody(tab, pending) {
  if (tab === 'client')
    return (
      `<div class="iradmin-body">` +
      istaAdminRows()
        .map((r) => istaAdminRowHtml(r, pending))
        .join('') +
      `</div>`
    );

  if (tab === 'version') {
    const app =
      (typeof window !== 'undefined' &&
        ((window.bmacw && window.bmacw.version) || window.BMACW_VERSION)) ||
      '';
    const cache =
      typeof ISTA_ADMIN_DATA_VERSION === 'string'
        ? ISTA_ADMIN_DATA_VERSION
        : '';
    return (
      `<div class="iradmin-body">` +
      `<table class="irtable"><tbody>` +
      `<tr><td>Application</td><td>${esc(app || '-')}</td></tr>` +
      `<tr><td>Data</td><td>${esc(cache || '-')}</td></tr>` +
      `</tbody></table></div>`
    );
  }

  if (tab === 'interface') {
    const port =
      typeof webBus === 'object' && webBus && webBus.connected
        ? webBus.portLabel()
        : '';
    const gw =
      typeof Settings === 'object' ? Settings.get('gatewayUrl', '') : '';
    return (
      `<div class="iradmin-body">` +
      `<table class="irtable"><thead><tr>` +
      `<th>Interface</th><th>Type</th><th>State</th>` +
      `</tr></thead><tbody>` +
      `<tr><td>${esc(port || 'No interface')}</td><td>K+DCAN</td>` +
      `<td>${port ? 'Connected' : 'Free'}</td></tr>` +
      `</tbody></table>` +
      `<div class="iradmin-row"><div class="iradmin-row-t">Gateway</div>` +
      `<div class="iradmin-gw">${esc(gw || "this machine's own cable")}` +
      `</div></div>` +
      `<div class="iradmin-note">The cable is chosen when you connect it. ` +
      `A gateway address is set on the app's Settings screen.</div>` +
      `</div>`
    );
  }

  const why = {
    dealer: 'dealership records are a franchise system: this build has none',
    initial:
      'initial operation settings configure a workshop network: there is none here',
    privacy:
      'nothing leaves this machine, so there is no data-protection choice to make',
  }[tab];
  return `<div class="iradmin-body"><div class="irgrey-w">${esc(why)}</div></div>`;
}

/**
 * Open the Administration dialog over the page.
 *
 * Nothing is written until OK, so Cancel leaves every setting as it was.
 * @param {() => void} [onApply] - called after OK wrote the changes
 * @returns {void}
 */
function istaAdminOpen(onApply) {
  if (typeof openModal !== 'function') return;
  let tab = 'client';
  /** @type {Object<string, string>} edits not yet applied */
  const pending = {};

  const html =
    `<div class="modal iradmin" role="dialog" aria-modal="true">` +
    `<div class="modal-title iradmin-title">Administration</div>` +
    `<div class="iradmin-tabs"></div>` +
    `<div class="iradmin-host"></div>` +
    `<div class="modal-actions iradmin-actions">` +
    `<button type="button" class="btn iradmin-cancel">Cancel</button>` +
    `<button type="button" class="btn iradmin-ok">OK</button>` +
    `</div></div>`;
  const { overlay, close } = openModal(html);

  /** Redraw the tab strip and the body. */
  function paint() {
    const strip = overlay.querySelector('.iradmin-tabs');
    strip.innerHTML = ISTA_ADMIN_TABS.map(
      (t) =>
        `<button type="button" class="iradmin-tab${
          t.id === tab ? ' on' : ''
        }" data-tab="${esc(t.id)}">${esc(t.label)}</button>`
    ).join('');
    strip.querySelectorAll('[data-tab]').forEach((b) => {
      b.onclick = () => {
        tab = b.dataset.tab;
        paint();
      };
    });
    const host = overlay.querySelector('.iradmin-host');
    host.innerHTML = istaAdminBody(tab, pending);
    // an edit is remembered, not applied: OK writes, Cancel forgets
    host.querySelectorAll('.iradmin-row[data-key]').forEach((row) => {
      row.querySelectorAll('input[type="radio"]').forEach((r) => {
        r.onchange = () => {
          if (r.checked) pending[row.dataset.key] = r.value;
        };
      });
    });
  }

  overlay.querySelector('.iradmin-cancel').onclick = () => close();
  overlay.querySelector('.iradmin-ok').onclick = () => {
    for (const [key, val] of Object.entries(pending)) {
      // the underscore keys are the tool's own preferences that this build
      // has nothing to store them in; they never reach Settings
      if (key.startsWith('_')) continue;
      if (typeof Settings === 'object' && Settings.set) Settings.set(key, val);
    }
    close();
    if (typeof onApply === 'function') onApply();
  };
  paint();
}

if (typeof window !== 'undefined') window.istaAdminOpen = istaAdminOpen;

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ISTA_ADMIN_TABS,
    istaAdminRows,
    istaAdminRowHtml,
    istaAdminBody,
    istaAdminOpen,
  };
}
