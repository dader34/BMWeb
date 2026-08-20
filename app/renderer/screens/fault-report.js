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
    .c-code { font: 700 12px "SF Mono", Menlo, monospace; white-space: nowrap; width: 92px; }
    .c-p { font: 700 12px "SF Mono", Menlo, monospace; }
    .c-hex { font: 600 10.5px "SF Mono", Menlo, monospace; color: #999; }
    .c-type { font-size: 11px; color: #555; white-space: nowrap; width: 84px; }
    .c-count { font: 600 11px "SF Mono", Menlo, monospace; color: #555; white-space: nowrap; width: 44px; text-align: right; }
    .c-state { font: 600 10.5px "SF Mono", Menlo, monospace; color: #777; white-space: nowrap; width: 64px; text-align: right; }
    tr.present .c-code, tr.present .c-state { color: #c0392b; }
    tr.envrow td { border-bottom: 1px solid #eee; padding: 3px 6px 6px; }
    .env { font-size: 10.5px; color: #555; line-height: 1.5; }
    .e-item { display: inline-block; width: 32%; vertical-align: top; }
    .e-k { color: #777; }
    .e-v { font: 600 10.5px "SF Mono", Menlo, monospace; color: #14181d; }
    .clean-note { padding: 24px; text-align: center; color: #2e7d32; font-size: 15px; font-weight: 600;
                  border: 1px solid #cde6cd; border-radius: 6px; background: #f3faf3; }
    footer { margin-top: 18px; padding-top: 8px; border-top: 1px solid #ddd; font-size: 10px; color: #999; }`;

// one module -> a <section> block of its faults. Type/Count columns (fault
// type + occurrence counter from the fault entry's detail byte) appear only
// when this module's read carries them, so DS2 modules without the fields
// keep the compact three-column table.
function faultModuleBlock(label, sgbd, codes) {
  const fields = codes.map(c => faultFields(c, sgbd));
  const hasDetail = fields.some(f => f.ftype || f.count);
  const cols = (hasDetail ? 5 : 3);
  // freeze-frame values ride in a full-width row under their own fault, so the
  // snapshot stays attached to the code it belongs to
  const envRow = (c) => {
    const pairs = typeof envPairs === 'function' ? envPairs(c) : [];
    if (!pairs.length) return '';
    const items = pairs.map(([k, v]) =>
      `<span class="e-item"><span class="e-k">${esc(k)}</span> `
      + `<span class="e-v">${esc(v)}</span></span>`).join('');
    return `<tr class="envrow"><td colspan="${cols}"><div class="env">${items}</div></td></tr>`;
  };
  const rows = fields.map((f, i) => `<tr class="${f.present ? 'present' : ''}">
      <td class="c-code">${f.pcode
        ? `<div class="c-p">${esc(f.pcode)}</div><div class="c-hex">${esc(f.code)}</div>`
        : `<div class="c-p">${esc(f.code)}</div>`}${
        f.hex ? `<div class="c-hex">${esc(f.hex)}</div>` : ''}</td>
      <td class="c-name">${esc(f.name)}</td>
      ${hasDetail ? `<td class="c-type">${esc(f.ftype || '—')}</td>
      <td class="c-count">${esc(f.count || '—')}</td>` : ''}
      <td class="c-state">${f.present ? 'PRESENT' : 'stored'}</td></tr>`
      + envRow(codes[i])).join('');
  return `<section class="mod">
    <h2>${esc(label)} <span class="sgbd">${esc(sgbd)}</span>
      <span class="modcount">${codes.length} fault${codes.length === 1 ? '' : 's'}</span></h2>
    <table><thead><tr><th>Code</th><th>Description</th>${hasDetail ? '<th>Type</th><th>Count</th>' : ''}<th>State</th></tr></thead>
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
    for (const f of faulty) {
      const fields = f.codes.map((c) => faultFields(c, f.ecu.sgbd));
      const hasDetail = fields.some((x) => x.ftype || x.count);
      const headers = hasDetail
        ? ['Code', 'Description', 'Type', 'Count', 'State']
        : ['Code', 'Description', 'State'];
      const rows = fields.map((x) => {
        const code = (x.pcode ? `${x.pcode}  (${x.code})` : x.code)
          + (x.hex ? `\n${x.hex}` : '');
        const state = x.present ? 'PRESENT' : 'stored';
        return hasDetail
          ? [code, x.name, x.ftype || '—', x.count || '—', state]
          : [code, x.name, state];
      });
      const cols = hasDetail
        ? ['pr-code2', '', '', 'pr-num', 'pr-num']
        : ['pr-code2', '', 'pr-num'];
      sections.push(printHeading(`${f.ecu.label}  ·  ${f.ecu.sgbd}  ·  `
        + `${f.codes.length} fault${f.codes.length === 1 ? '' : 's'}`));
      const t = printTable(headers, rows, cols); t.avoidBreak = false;
      sections.push(t);
      // Freeze-frame values, only after a detailed read (F_UW*). The table above
      // has one row per fault and no room for eight more columns, so each fault
      // that carries a snapshot gets its own labelled block underneath.
      if (typeof envPairs === 'function') {
        f.codes.forEach((c, i) => {
          const pairs = envPairs(c);
          if (!pairs.length) return;
          const items = pairs.map(([k, v]) =>
            `<div class="pr-env-row"><span class="pr-env-k">${esc(k)}</span>`
            + `<span class="pr-env-v">${esc(v)}</span></div>`).join('');
          sections.push({
            html: `<div class="pr-env"><div class="pr-env-head">`
              + `${esc(fields[i].code)} · environment at code entry</div>${items}</div>`,
            avoidBreak: true,
          });
        });
      }
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
