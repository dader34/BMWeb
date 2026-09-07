/**
 * @file The fault detail modal: ISTA's service document for the clicked fault
 * (conditions, service measures, notes), the component's guided-diagnostic
 * procedure beneath it, and the printable sheet of both.
 */

/* exported openFaultModal */

/**
 * The service-document fields, in display order: [key in FaultInfo, label].
 * @type {[string, string][]}
 */
const LOOKUP_INFO_FIELDS = [
  ['description', 'Description'],
  ['setCondition', 'Set condition'],
  ['monitoring', 'Monitoring'],
  ['timeCondition', 'Time condition'],
  ['terminal', 'Terminal'],
  ['impact', 'Fault impact'],
  ['warningLamp', 'Warning lamp'],
  ['ccMessage', 'CC message'],
  ['serviceMeasure', 'Service measure'],
  ['serviceNote', 'Service note'],
  ['breakdownNote', 'Breakdown note'],
  ['driverInfo', 'Driver info'],
];

/**
 * The service-document fields a fault actually has, in display order.
 * @param {FaultInfo} info - the service document
 * @returns {[string, string][]} [label, text] pairs
 */
function lookupInfoRows(info) {
  return LOOKUP_INFO_FIELDS.filter(
    ([k]) => info[k] && String(info[k]).trim()
  ).map(([k, label]) => [label, String(info[k])]);
}

/**
 * The service document as a key/value grid.
 * @param {FaultInfo|null} info - the service document
 * @returns {string} HTML, '' when there is nothing to show
 */
function lookupInfoTable(info) {
  if (!info) return '';
  const rows = lookupInfoRows(info)
    .map(
      ([label, text]) =>
        `<div class="fi-k">${esc(label)}</div>` +
        `<div class="fi-v">${esc(text).replace(/\n/g, '<br>')}</div>`
    )
    .join('');
  return rows ? `<div class="fi-grid">${rows}</div>` : '';
}

/**
 * The ISTA guided-diagnostic document for the component this fault names:
 * how the system works and how to test it. Rendered as a collapsible section
 * below the service fields so it never crowds the fault description. The
 * typed-block rendering lives in ui/typed-block.js; the fault viewer wants
 * ISTA "legend" tables (key|label pairs) flattened to a key/label list, so it
 * renders with { legend: true }.
 * @param {IstaTestDoc|null} doc - the procedure
 * @returns {string} HTML, '' when there is no procedure
 */
function lookupTestPlanSection(doc) {
  if (!doc || !doc.chapters || !doc.chapters.length) return '';
  const chapters = doc.chapters
    .map((ch) => renderTpChapter(ch, { legend: true }))
    .join('');
  return `<details class="fm-tp" open>
        <summary class="fm-tp-sum">Diagnostic procedure${
          doc.title ? ` · ${esc(doc.title)}` : ''
        }</summary>
        <div class="fm-tp-body">${chapters}</div>
      </details>`;
}

/**
 * Show ISTA detail for the ONE clicked entry (the search page already lists
 * every variant as its own row). The big info file is loaded on demand on
 * first open; the component procedure streams in after it.
 * @param {string} code - the fault code
 * @param {string} clickedName - the row label the user clicked (wins the title)
 * @param {string} sgbd - the module the row belongs to
 * @returns {Promise<void>}
 */
async function openFaultModal(code, clickedName, sgbd) {
  const hex = String(code).toUpperCase();
  const meta = (window.BMW_FAULT_META && window.BMW_FAULT_META[hex]) || {};
  const pcodes = meta.pcodes || [];
  const picked = lookupPickVariant(
    lookupVariantsFor(code),
    sgbd,
    clickedName || ''
  );
  // the row's own text wins the title (it's what the user clicked)
  const title = clickedName || picked?.name || '';

  const pcodeBar = pcodes.length
    ? `<div class="fm-pcodes">${pcodes.map((p) => `<span class="fm-pcode">${esc(p)}</span>`).join('')}</div>`
    : '';
  // reflect the open fault in the URL (?dtc=HEX) so it's shareable; strip it
  // when the modal closes.
  setDtcParam(hex, sgbd, title);
  const { overlay, close } = openModal(
    `
      <div class="modal fault-modal" role="dialog" aria-modal="true">
        <div class="fm-head">
          <div class="fm-code">${esc(hex)}</div>
          <div class="fm-title">${esc(title)}</div>
          <button class="fm-print" aria-label="Print" title="Print this fault and its diagnostic plan">Print</button>
          <button class="fm-close" aria-label="Close">✕</button>
        </div>
        ${pcodeBar}
        <div class="fm-body" id="fm-body"><div class="fm-loading">Loading service data…</div></div>
      </div>`,
    { backdropValue: null, onClose: () => setDtcParam(null) }
  );
  overlay.querySelector('.fm-close').onclick = () => close();

  if (typeof loadFaultInfo === 'function') await loadFaultInfo();
  if (!document.body.contains(overlay)) return; // closed while loading

  const info =
    picked && picked.info != null && typeof faultInfoFor === 'function'
      ? faultInfoFor(code, picked.info)
      : null;
  const body = overlay.querySelector('#fm-body');
  body.innerHTML =
    lookupInfoTable(info) ||
    '<div class="fm-noinfo">No service document for this fault.</div>';

  // Print builds a clean sheet from the data (hex, name, P-codes, service
  // fields, ISTA plan) -- not the modal DOM -- so it's theme-agnostic. The
  // test plan arrives async; print with whatever is loaded at the time.
  let istaDoc = null;
  overlay.querySelector('.fm-print').onclick = () =>
    printFaultDetail(hex, title, pcodes, info, istaDoc);

  // then bring in the ISTA diagnostic procedure for this component, if any.
  // Loaded lazily (12 MB from Hugging Face on first open); the modal is
  // already usable from the service fields above while it fetches.
  const tpSlot = document.createElement('div');
  tpSlot.className = 'fm-tp-slot';
  body.appendChild(tpSlot);
  loadIstaTests().then(() => {
    if (!document.body.contains(overlay)) return; // closed while loading
    const doc = istaTestFor(title);
    if (doc) {
      istaDoc = doc;
      tpSlot.innerHTML = lookupTestPlanSection(doc);
    }
  });
}

/**
 * A chapter's typed blocks, tolerating the older flat `paras` shape ("• "
 * prefix = bullet).
 * @param {IstaChapter} ch - the chapter
 * @returns {{ t: string, s?: string }[]}
 */
function lookupChapterBlocks(ch) {
  return (
    ch.blocks ||
    (ch.paras || []).map((p) =>
      p.startsWith('• ') ? { t: 'bullet', s: p.slice(2) } : { t: 'p', s: p }
    )
  );
}

/**
 * A fault and its diagnostic plan as a clean, theme-agnostic printout. Built
 * from the data directly (not the modal DOM): the DTC, P-codes, the service
 * fields, then the ISTA procedure chapters as typed blocks.
 * @param {string} hex - the fault code
 * @param {string} title - the fault name
 * @param {string[]} pcodes - its SAE P-codes
 * @param {FaultInfo|null} info - the service document
 * @param {IstaTestDoc|null} doc - the component procedure, if it had arrived
 * @returns {void}
 */
function printFaultDetail(hex, title, pcodes, info, doc) {
  const sections = [];
  // service fields -> a two-column table
  if (info) {
    const rows = lookupInfoRows(info);
    if (rows.length)
      sections.push(printTable(['Field', 'Detail'], rows, ['pr-mono', '']));
  }
  // ISTA diagnostic procedure -> heading + typed blocks per chapter
  if (doc && doc.chapters && doc.chapters.length) {
    sections.push(
      printHeading(
        'Diagnostic procedure' + (doc.title ? ` · ${doc.title}` : '')
      )
    );
    for (const ch of doc.chapters) {
      if (ch.heading) sections.push(printHeading(ch.heading));
      sections.push(printBlocks(lookupChapterBlocks(ch)));
    }
  }
  if (!sections.length)
    sections.push(
      printHtml('<p class="pr-p">No service document for this fault.</p>')
    );
  printDoc({
    title: `${hex} · ${title}`,
    subtitle: pcodes && pcodes.length ? `P-codes: ${pcodes.join(', ')}` : '',
    sections,
    footer: `${APP_NAME} · Diagnostic Plans and Trouble Codes · printed ${new Date().toLocaleDateString()}`,
  });
}
