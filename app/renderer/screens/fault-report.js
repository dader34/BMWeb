// self-contained fault-report PDF generation, saved via the Electron bridge
// (window.bmacw.savePdf). Shared by the whole-car quick sweep (sweep.js) and the
// single-ECU export (faults.js) so both reports look identical, via the shared
// faultFields projection (faults.js) so codes/names/state match the on-screen rows.
const FAULT_REPORT_CSS = `
    * { box-sizing: border-box; }
    body { font: 13px -apple-system, "Helvetica Neue", Arial, sans-serif; color: #14181d; margin: 0; padding: 0 4px; }
    header { border-bottom: 2px solid #14181d; padding-bottom: 10px; margin-bottom: 16px; }
    .brand { font-size: 22px; font-weight: 800; letter-spacing: .04em; }
    .sub { color: #555; font-size: 12px; margin-top: 2px; }
    .meta { margin-top: 8px; font-size: 11.5px; color: #333; display: flex; gap: 22px; flex-wrap: wrap; }
    .meta b { color: #14181d; }
    .mod { margin: 0 0 16px; page-break-inside: avoid; }
    .mod h2 { font-size: 14px; margin: 0 0 5px; border-left: 4px solid #c0392b; padding-left: 8px; }
    .mod .sgbd { font: 600 10.5px "SF Mono", Menlo, monospace; color: #888; }
    .mod .modcount { float: right; font-size: 11px; color: #c0392b; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: #777;
         border-bottom: 1px solid #ccc; padding: 4px 6px; }
    td { padding: 5px 6px; border-bottom: 1px solid #eee; vertical-align: top; }
    /* table-layout:fixed + an explicit <colgroup> so EVERY printed page sizes
       its columns identically. Without it the browser auto-sizes per page, and
       the repeated <thead> on page 2 lands its headers at different x-offsets
       than page 1's rows -- the "values under the wrong header" bug. */
    table { table-layout: fixed; }
    thead { display: table-header-group; }        /* headers repeat on each page */
    .c-code { font: 700 12px "SF Mono", Menlo, monospace; }
    .c-p { font: 700 12px "SF Mono", Menlo, monospace; }
    /* the raw entry: some modules keep 19 bytes per fault (GS20), so it wraps
       inside its own column instead of pushing the description off the page */
    .c-hex { font: 600 10px/1.35 "SF Mono", Menlo, monospace; color: #999; word-break: break-all; overflow-wrap: anywhere; }
    .c-name { overflow-wrap: anywhere; }
    .c-type { font-size: 11px; color: #555; }
    .c-count { font: 600 11px "SF Mono", Menlo, monospace; color: #555; text-align: right; }
    .c-state { font: 600 10.5px "SF Mono", Menlo, monospace; color: #777; text-align: right; }
    tr.present .c-code, tr.present .c-state { color: #c0392b; }
    /* a fault row and its freeze-frame row must never split across a page, and
       neither may break internally */
    tr.faultrow, tr.envrow { page-break-inside: avoid; break-inside: avoid; }
    tr.envrow td { border-bottom: 1px solid #eee; padding: 2px 6px 7px; }
    /* fixed 2-up label:value grid: each pair is one cell, so a value can never
       detach from its label across a wrap or a column edge */
    .env { font-size: 10.5px; color: #555; line-height: 1.45;
           display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px 22px; }
    .e-item { display: grid; grid-template-columns: auto 1fr; align-items: baseline;
              column-gap: 10px; min-width: 0; }
    .e-k { color: #777; white-space: nowrap; }
    .e-v { font: 600 10.5px "SF Mono", Menlo, monospace; color: #14181d;
           text-align: right; overflow-wrap: anywhere; }
    .clean-note { padding: 24px; text-align: center; color: #2e7d32; font-size: 15px; font-weight: 600;
                  border: 1px solid #cde6cd; border-radius: 6px; background: #f3faf3; }
    footer { margin-top: 18px; padding-top: 8px; border-top: 1px solid #ddd; font-size: 10px; color: #999; }`;

// The ONE column definition both report paths render from -- the native
// savePdf table (faultModuleBlock) and the web print table (printFaultReport).
// Header labels, order, widths and alignment live here once so the two paths
// cannot drift into a header that no longer sits over its column.
//
// Every module renders the SAME five fixed-width columns, even a module with no
// detail read (DS2): its Type/Count cells are simply left blank. That is the
// point -- each faulty module is its own <table>, and if the compact modules
// dropped Type/Count their STATE column would land at a different x-position
// than the detailed tables above them, so scanning the report the STATE column
// would wander. One shared <colgroup> of explicit widths (table-layout:fixed)
// pins Code / Type / Count / State to the same x across every module block and
// every printed page; DESCRIPTION takes the remaining elastic width.
//
// `width` feeds the <colgroup>; `cls` is the native table's cell class, `prCls`
// the web print table's. `key` selects the value; `detailOnly` cells stay blank
// on a module with no detailed read.
function faultColumns() {
  return [
    { key: 'code',  label: 'Code',        width: '112px', cls: 'c-code',  prCls: 'pr-code2' },
    { key: 'name',  label: 'Description', width: '',      cls: 'c-name',  prCls: '' },
    { key: 'type',  label: 'Type',        width: '84px',  cls: 'c-type',  prCls: '', detailOnly: true },
    { key: 'count', label: 'Count',       width: '52px',  cls: 'c-count', prCls: 'pr-num', detailOnly: true },
    { key: 'state', label: 'State',       width: '68px',  cls: 'c-state', prCls: 'pr-num' },
  ];
}

// one module -> a <section> block of its faults. Type/Count columns (fault
// type + occurrence counter from the fault entry's detail byte) appear only
// when this module's read carries them, so DS2 modules without the fields
// keep the compact three-column table.
function faultModuleBlock(label, sgbd, codes) {
  const fields = codes.map(c => faultFields(c, sgbd));
  const hasDetail = fields.some(f => f.ftype || f.count);
  const columns = faultColumns();
  const cols = columns.length;
  const colgroup = `<colgroup>${columns.map(c =>
    `<col${c.width ? ` style="width:${c.width}"` : ''}>`).join('')}</colgroup>`;
  const thead = `<thead><tr>${columns.map(c =>
    `<th class="${c.cls}">${esc(c.label)}</th>`).join('')}</tr></thead>`;
  // freeze-frame values ride in a full-width row under their own fault, so the
  // snapshot stays attached to the code it belongs to. break-inside:avoid on
  // both the fault row and this env row (in CSS) keeps the pair together.
  const envRow = (c) => {
    const pairs = typeof envPairs === 'function' ? envPairs(c) : [];
    if (!pairs.length) return '';
    const items = pairs.map(([k, v]) =>
      `<span class="e-item"><span class="e-k">${esc(k)}</span>`
      + `<span class="e-v">${esc(v)}</span></span>`).join('');
    return `<tr class="envrow"><td colspan="${cols}"><div class="env">${items}</div></td></tr>`;
  };
  // Each fault emits its cells from the shared column list, so a cell is never
  // written for a header this table isn't showing (and vice versa).
  const cellFor = (f, key) => {
    if (key === 'code') return f.pcode
      ? `<div class="c-p">${esc(f.pcode)}</div><div class="c-hex">${esc(f.code)}</div>`
      : `<div class="c-p">${esc(f.code)}</div>`;
    if (key === 'name') return esc(f.name);
    // Type/Count stay blank on a module with no detailed read, so the column is
    // reserved (STATE keeps its x-position) without inventing a value.
    if (key === 'type') return hasDetail ? esc(f.ftype || '—') : '';
    if (key === 'count') return hasDetail ? esc(f.count || '—') : '';
    if (key === 'state') return f.present ? 'PRESENT' : 'stored';
    return '';
  };
  const rows = fields.map((f, i) =>
    `<tr class="faultrow ${f.present ? 'present' : ''}">`
    + columns.map(c => `<td class="${c.cls}">${cellFor(f, c.key)}</td>`).join('')
    + `</tr>` + envRow(codes[i])).join('');
  return `<section class="mod">
    <h2>${esc(label)} <span class="sgbd">${esc(sgbd)}</span>
      <span class="modcount">${codes.length} fault${codes.length === 1 ? '' : 's'}</span></h2>
    <table>${colgroup}${thead}
    <tbody>${rows}</tbody></table>
  </section>`;
}

// assemble the full report document. metaPairs: [[label, value], ...]
function faultReportHtml(sub, metaPairs, bodyHtml) {
  const meta = metaPairs.map(([k, v]) => `<span>${esc(k)} <b>${esc(v)}</b></span>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${FAULT_REPORT_CSS}</style></head><body>
    <header>
      <div class="brand">${APP_NAME} Fault Report</div>
      <div class="sub">${esc(sub)}</div>
      <div class="meta">${meta}</div>
    </header>
    ${bodyHtml}
    <footer>${APP_NAME} · ${IS_WEB ? 'BMW diagnostics' : 'native macOS BMW diagnostics'}. Codes read over K+DCAN; descriptions are best-effort translations.</footer>
  </body></html>`;
}

// Web build: the same whole-car report, printed via the shared theme-agnostic
// helper (core/print.js) instead of the Electron savePdf bridge. One section per
// faulty module; a clean bill if none. Same faultFields projection as on screen.
async function printFaultReport(chassisId, faulty, stats) {
  if (typeof loadFaultMeta === 'function') await loadFaultMeta();
  if (typeof loadPcodes === 'function') await loadPcodes();
  const totalFaults = faulty.reduce((n, f) => n + f.codes.length, 0);
  const sections = [];
  if (!faulty.length) {
    sections.push(printHtml(`<p class="pr-p">No stored faults. `
      + `${stats.scanned} module${stats.scanned === 1 ? '' : 's'} read, ${stats.skipped} skipped.</p>`));
  } else {
    // Every module renders the same fixed 5-column grid from the ONE shared
    // faultColumns() definition below -- Code / Description / Type / Count /
    // State -- with an explicit <colgroup> and table-layout:fixed (in the
    // pr-table CSS). That pins Code/Type/Count/State to the same x-position in
    // every module block, so scanning the whole report the STATE column no
    // longer wanders block to block. A module with no detailed read leaves its
    // Type/Count cells blank rather than dropping the columns.
    const columns = faultColumns();
    const colgroup = `<colgroup>${columns.map((c) =>
      `<col${c.width ? ` style="width:${c.width}"` : ''}>`).join('')}</colgroup>`;
    const cls = (c) => (c.prCls ? ` class="${c.prCls}"` : '');
    const thead = `<thead><tr>${columns.map((c) =>
      `<th${cls(c)}>${esc(c.label)}</th>`).join('')}</tr></thead>`;
    for (const f of faulty) {
      const fields = f.codes.map((c) => faultFields(c, f.ecu.sgbd));
      const hasDetail = fields.some((x) => x.ftype || x.count);
      // Hand-built table rather than printTable(): a fault that carries a
      // freeze-frame snapshot (detailed read, F_UW*) gets a full-width row
      // with the environment grid directly under its own code, like the
      // native savePdf report -- not a separate block after the table.
      const cellFor = (x, key) => {
        if (key === 'code') return x.pcode ? `${x.pcode}  (${x.code})` : x.code;
        if (key === 'name') return x.name;
        if (key === 'type') return hasDetail ? (x.ftype || '—') : '';
        if (key === 'count') return hasDetail ? (x.count || '—') : '';
        if (key === 'state') return x.present ? 'PRESENT' : 'stored';
        return '';
      };
      const body = fields.map((x, i) => {
        // pr-faultrow + break-inside:avoid keeps a fault row and its env row on
        // the same page (rule added to core/print.js pr-table CSS).
        let row = `<tr class="pr-faultrow">${columns.map((c) =>
          `<td${cls(c)}>${esc(cellFor(x, c.key))}</td>`).join('')}</tr>`;
        const pairs = typeof envPairs === 'function' ? envPairs(f.codes[i]) : [];
        if (pairs.length) {
          const items = pairs.map(([k, v]) =>
            `<div class="pr-env-row"><span class="pr-env-k">${esc(k)}</span>`
            + `<span class="pr-env-v">${esc(v)}</span></div>`).join('');
          row += `<tr class="pr-envtr"><td colspan="${columns.length}">`
            + `<div class="pr-env"><div class="pr-env-head">environment at code entry</div>`
            + `${items}</div></td></tr>`;
        }
        return row;
      }).join('');
      sections.push(printHeading(`${f.ecu.label}  ·  ${f.ecu.sgbd}  ·  `
        + `${f.codes.length} fault${f.codes.length === 1 ? '' : 's'}`));
      sections.push({ html: `<table class="pr-table pr-fault-table">${colgroup}${thead}<tbody>${body}</tbody></table>` });
    }
  }
  printDoc({
    title: `${APP_NAME} Fault Report`,
    subtitle: `${dispChassis(chassisId)} · fault memory across all modules`,
    meta: [
      ['Generated', new Date().toLocaleString()],
      ['Modules with faults', String(faulty.length)],
      ['Total faults', String(totalFaults)],
      ['Read', `${stats.scanned} · skipped ${stats.skipped}`],
    ],
    sections,
    footer: `${APP_NAME} · codes read over K+DCAN; descriptions are best-effort translations.`,
  });
}

// whole-car quick-sweep export: one module block per faulty ECU (or a clean-bill
// note), saved as a PDF. driven from the sweep screen's Export PDF button.
async function exportFaultPdf(chassisId, faulty, stats) {
  // ensure ISTA P-code / name data is loaded so the printed report shows P-codes
  if (typeof loadFaultMeta === 'function') await loadFaultMeta();
  if (typeof loadPcodes === 'function') await loadPcodes();
  const now = new Date();
  const totalFaults = faulty.reduce((n, f) => n + f.codes.length, 0);
  const body = faulty.length
    ? faulty.map(f => faultModuleBlock(f.ecu.label, f.ecu.sgbd, f.codes)).join('')
    : `<div class="clean-note">No stored faults. ${stats.scanned} module${stats.scanned === 1 ? '' : 's'} read, ${stats.skipped} skipped.</div>`;
  const html = faultReportHtml(
    `${dispChassis(chassisId)} · fault memory across all modules`,
    [['Generated', now.toLocaleString()], ['Modules with faults', faulty.length],
     ['Total faults', totalFaults], ['Read', `${stats.scanned} · skipped ${stats.skipped}`]],
    body);

  const name = `${APP_NAME}-faults-${dispChassis(chassisId)}-${now.toISOString().slice(0, 10)}.pdf`;
  const btn = document.getElementById('quick-pdf');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    const res = await window.bmacw.savePdf(name, html);
    if (btn) btn.textContent = res && res.ok ? 'Saved' : 'Export PDF';
    if (btn) btn.disabled = false;
  } catch {
    if (btn) { btn.textContent = 'Export PDF'; btn.disabled = false; }
  }
}

// Identification report (Functional Jobs F2): every module the car answered
// for, grouped by the chassis section it lives in, in sweep order. Printed
// through the same shared helper as the fault report, so both sheets look
// like one tool. Native gets the same document via the browser print dialog:
// unlike the fault report there is no savePdf-only path worth splitting for,
// because an ident list carries no freeze-frame blocks to lay out specially.
function printIdentReport(chassisId, found, stats) {
  const sections = [];
  if (!found.length) {
    sections.push(printHtml('<p class="pr-p">No modules answered. '
      + 'Check the cable and the ignition, then run the scan again.</p>'));
  } else {
    // section order is the order the sweep walked them, which is chassis-config
    // order -- INPA's own menu order
    const bySection = new Map();
    for (const f of found) {
      const k = f.section || 'Modules';
      if (!bySection.has(k)) bySection.set(k, []);
      bySection.get(k).push(f);
    }
    for (const [name, list] of bySection) {
      sections.push(printHeading(`${name}  ·  ${list.length} module${list.length === 1 ? '' : 's'}`));
      const t = printTable(
        ['Module', 'SGBD', 'Variant', 'Build'],
        list.map(f => [f.label, f.sgbd, f.variant || '—', f.build || '—']),
        ['', 'pr-code2', 'pr-code2', '']);
      t.avoidBreak = false;
      sections.push(t);
    }
  }
  printDoc({
    title: `${APP_NAME} Identification Report`,
    subtitle: `${dispChassis(chassisId)} · every module on the vehicle`,
    meta: [
      ['Generated', new Date().toLocaleString()],
      ['Modules present', String(stats.present)],
      ['Not installed', String(stats.absent)],
    ],
    sections,
    footer: `${APP_NAME} · identification read over K+DCAN.`,
  });
}

// Node-only: expose the pure report builders so tools/verify can assert the two
// render paths agree on the column grid. The browser never hits this branch
// (no module), so it doesn't affect the shipped script.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { faultColumns, faultModuleBlock, printFaultReport, faultReportHtml };
}
