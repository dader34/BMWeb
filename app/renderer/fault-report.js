// self-contained fault-report PDF generation, saved via the Electron bridge
// (window.bmacw.savePdf). shared by the whole-car quick sweep (sweep.js) and the
// single-ECU export (faults.js) so both reports look identical. uses the shared
// faultFields projection (translate.js) so codes/names/state match the on-screen
// rows.

// shared fault-report styling. one <style> block used by both the whole-car quick
// sweep and the single-ECU export so they look identical.
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
    .c-code { font: 700 12px "SF Mono", Menlo, monospace; white-space: nowrap; width: 72px; }
    .c-state { font: 600 10.5px "SF Mono", Menlo, monospace; color: #777; white-space: nowrap; width: 64px; text-align: right; }
    tr.present .c-code, tr.present .c-state { color: #c0392b; }
    .clean-note { padding: 24px; text-align: center; color: #2e7d32; font-size: 15px; font-weight: 600;
                  border: 1px solid #cde6cd; border-radius: 6px; background: #f3faf3; }
    footer { margin-top: 18px; padding-top: 8px; border-top: 1px solid #ddd; font-size: 10px; color: #999; }`;

// one module -> a <section> block of its faults
function faultModuleBlock(label, sgbd, codes) {
  const rows = codes.map(c => {
    const { code, name, present } = faultFields(c);
    return `<tr class="${present ? 'present' : ''}">
      <td class="c-code">${esc(code)}</td>
      <td class="c-name">${esc(name)}</td>
      <td class="c-state">${present ? 'PRESENT' : 'stored'}</td></tr>`;
  }).join('');
  return `<section class="mod">
    <h2>${esc(label)} <span class="sgbd">${esc(sgbd)}</span>
      <span class="modcount">${codes.length} fault${codes.length === 1 ? '' : 's'}</span></h2>
    <table><thead><tr><th>Code</th><th>Description</th><th>State</th></tr></thead>
    <tbody>${rows}</tbody></table>
  </section>`;
}

// assemble the full report document. metaPairs: [[label, value], ...]
function faultReportHtml(sub, metaPairs, bodyHtml) {
  const meta = metaPairs.map(([k, v]) => `<span>${esc(k)} <b>${esc(v)}</b></span>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${FAULT_REPORT_CSS}</style></head><body>
    <header>
      <div class="brand">BMacW Fault Report</div>
      <div class="sub">${esc(sub)}</div>
      <div class="meta">${meta}</div>
    </header>
    ${bodyHtml}
    <footer>BMacW · native macOS BMW diagnostics. Codes read over K+DCAN; descriptions are best-effort translations.</footer>
  </body></html>`;
}

// whole-car quick-sweep export: one module block per faulty ECU (or a clean-bill
// note), saved as a PDF. driven from the sweep screen's Export PDF button.
async function exportFaultPdf(chassisId, faulty, stats) {
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

  const name = `BMacW-faults-${dispChassis(chassisId)}-${now.toISOString().slice(0, 10)}.pdf`;
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
