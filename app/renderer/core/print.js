// Theme- and layout-agnostic printing. The problem: printing the live app DOM
// drags the user's theme (aero/metal/inpa), its CSS custom properties, and the
// current layout mode onto the paper, so every user's printout looks different
// and often broken. The fix here: never print the styled app at all. At print
// time a screen hands printDoc() STRUCTURED content; we render it into a single
// .print-root container that carries its OWN fixed, light stylesheet -- it reads
// zero theme variables and no app layout classes. A lone @media print rule hides
// the whole app and shows only .print-root, so the output is byte-identical no
// matter what the screen looks like.
//
// A screen calls:
//   printDoc({
//     title:   'Short Engine',                       // big heading
//     subtitle:'E46 · 325i · Sedan',                 // optional line under it
//     meta:    [['Main group','11 Engine'], ...],    // key/value chips
//     sections:[ printImage(url,alt),
//                printTable(['No.','Part number','Description'], rows),
//                printBlocks([{t:'p',s:'...'},{t:'table',rows:[...]}]),
//                printHtml('<p>trusted, already-escaped</p>') ],
//     footer:  'BMW WDS · printed 2026-08-16',        // optional
//     landscape: true,                                // page orientation
//     onReady: () => {}                               // fires once images decoded
//   })
//
// Section builders return { html } (and optionally an async decode step); they
// all escape their inputs, so callers pass raw strings. Only printHtml() trusts
// its argument -- reserve it for markup a screen already built and escaped.

// ---- section builders -------------------------------------------------------

// A figure. `url` may be an <img> src or (SVG string) inlined verbatim.
function printImage(url, alt) {
  if (!url) return { html: '' };
  return {
    html: `<figure class="pr-fig"><img class="pr-img" src="${esc(url)}" alt="${esc(alt || '')}"></figure>`,
    // images must be decoded before print or they come out blank; the doc waits
    needsImages: true,
  };
}

// An inline SVG figure (the wiring diagrams): the markup is trusted (it's the
// document we loaded), and inlining keeps it lossless and printable.
function printSvg(svgMarkup) {
  if (!svgMarkup) return { html: '' };
  return { html: `<figure class="pr-fig pr-fig-svg">${svgMarkup}</figure>` };
}

// A simple grid table. headers: [string]; rows: [[cell, cell, ...]]. Cells are
// escaped. Optional per-column class list aligns/sizes columns (e.g. 'pr-mono').
function printTable(headers, rows, colClasses) {
  const cls = (i) => (colClasses && colClasses[i]) ? ` class="${colClasses[i]}"` : '';
  const thead = headers && headers.length
    ? `<thead><tr>${headers.map((h, i) => `<th${cls(i)}>${esc(h)}</th>`).join('')}</tr></thead>` : '';
  const body = (rows || []).map((r) =>
    `<tr>${r.map((c, i) => `<td${cls(i)}>${esc(c == null ? '' : c)}</td>`).join('')}</tr>`).join('');
  return { html: `<table class="pr-table">${thead}<tbody>${body}</tbody></table>` };
}

// Typed blocks, the shape the ISTA test plans use: {t:'p'|'bullet',s} and
// {t:'table',rows:[[...]]}. Rendered to fixed print markup, no app classes.
function printBlocks(blocks) {
  const one = (b) => {
    if (!b) return '';
    if (b.t === 'p') return `<p class="pr-p">${esc(b.s)}</p>`;
    if (b.t === 'bullet') return `<p class="pr-p pr-bullet">${esc(b.s)}</p>`;
    if (b.t === 'table' && b.rows && b.rows.length) {
      const cols = Math.max(...b.rows.map((r) => r.length));
      const rows = b.rows.map((r, ri) => {
        const cells = [];
        for (let i = 0; i < cols; i++) {
          cells.push(`<${ri === 0 ? 'th' : 'td'}>${esc(r[i] || '')}</${ri === 0 ? 'th' : 'td'}>`);
        }
        return `<tr>${cells.join('')}</tr>`;
      }).join('');
      return `<table class="pr-table pr-table-grid">${rows}</table>`;
    }
    return '';
  };
  return { html: (blocks || []).map(one).join('') };
}

// A heading inside the body (chapter title within a section).
function printHeading(text) { return { html: `<h2 class="pr-h2">${esc(text)}</h2>` }; }

// Escape hatch: markup the caller already built and escaped. Trusted input only.
function printHtml(html) { return { html: html || '' }; }

// ---- the document -----------------------------------------------------------

// The self-contained print stylesheet. Everything the printout needs, defined
// from scratch in fixed light colours and real print units -- it names no theme
// custom property, so aero/metal/inpa and any layout mode all print the same.
const PRINT_CSS = `
  #pr-root { display: none; }
  @media print {
    @page { margin: 8mm; }
    /* Only take over the sheet when WE built a print document (body.pr-active,
       set while #pr-root is mounted). Otherwise a bare Cmd+P prints the normal
       page rather than a blank one -- the hide-everything rule below would blank
       any screen that has no print handler. */
    /* The app runs as a fixed-viewport SPA (html/body are height:100% and
       overflow:hidden). Left as-is that clips the print to a SINGLE page -- a
       long table just gets cut off with no page 2. Release the height/overflow
       so content flows and paginates across sheets. */
    html, body.pr-active {
      height: auto !important; min-height: 0 !important;
      overflow: visible !important; position: static !important;
      background: #fff !important;
    }
    body.pr-active > *:not(#pr-root) { display: none !important; }
    body.pr-active #pr-root {
      display: block !important; position: static !important;
      height: auto !important; max-height: none !important; overflow: visible !important;
      color: #14181d; background: #fff;
      font: 13px/1.45 -apple-system, "Helvetica Neue", Arial, sans-serif;
    }
    #pr-root * { box-sizing: border-box; }
    .pr-head { border-bottom: 2px solid #14181d; padding-bottom: 9px; margin-bottom: 14px; }
    .pr-title { font-size: 20px; font-weight: 800; letter-spacing: .01em; margin: 0; }
    .pr-subtitle { color: #555; font-size: 12.5px; margin-top: 3px; }
    .pr-meta { margin-top: 9px; display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 11px; color: #333; }
    .pr-meta b { color: #14181d; font-weight: 700; }
    .pr-section { margin: 0 0 14px; }
    .pr-section.avoid-break { page-break-inside: avoid; }
    .pr-h2 { font-size: 14px; font-weight: 700; margin: 14px 0 6px;
             border-left: 4px solid #c0392b; padding-left: 8px; page-break-after: avoid; }
    /* figures: never overflow the sheet; a big diagram scales down to fit */
    .pr-fig { margin: 0 0 12px; text-align: center; page-break-inside: avoid; }
    /* fill the sheet width: ETK exploded views are small rasters, so let them
       scale up to the content width -- bigger and a touch soft reads far better
       on paper than tiny and sharp. Cap the height so a tall diagram still fits. */
    .pr-img { width: 100%; max-height: 21cm; height: auto; object-fit: contain; }
    .pr-fig-svg svg { width: 100% !important; height: auto !important; max-height: 17cm; }
    .pr-fig-svg { border: 1px solid #999; padding: 4mm; }
    /* tables: a long table paginates; its header repeats atop each page */
    .pr-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .pr-table thead { display: table-header-group; }
    .pr-table th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .04em;
                   color: #666; border-bottom: 1px solid #bbb; padding: 4px 6px; }
    .pr-table td { padding: 4px 6px; border-bottom: 1px solid #e4e4e4; vertical-align: top; }
    .pr-table tr { page-break-inside: avoid; }
    .pr-mono { font: 600 11.5px "SF Mono", Menlo, Consolas, monospace; white-space: nowrap; }
    /* a code cell carrying its raw fault word on a second line: pre-line keeps
       the newline the caller put in, which plain .pr-mono would collapse */
    .pr-code2 { font: 600 11.5px "SF Mono", Menlo, Consolas, monospace;
                white-space: pre-line; line-height: 1.35;
                width: 128px; max-width: 128px; overflow-wrap: anywhere; }
    .pr-num { text-align: right; white-space: nowrap; }
    .pr-table-grid { margin: 6px 0; border: 1px solid #ccc; }
    .pr-table-grid th, .pr-table-grid td { border: 1px solid #ddd; padding: 3px 6px; }
    .pr-table-grid th { background: #f3f3f3; }
    /* freeze-frame snapshot under a fault table: a two-column key/value list
       that flows into as many columns as the page width allows, so eight values
       take a few lines instead of a full page of near-empty rows */
    .pr-env { margin: 4px 0 10px; padding: 5px 8px; border-left: 3px solid #bbb;
              background: #fafafa; page-break-inside: avoid;
              display: grid; grid-template-columns: repeat(2, 1fr); gap: 0 22px; }
    /* env grid riding inside the fault table, under its own code's row */
    .pr-envtr td { padding: 0 0 8px; border-bottom: 1px solid #e4e4e4; }
    .pr-envtr .pr-env { margin: 2px 0 0; }
    .pr-env-head { grid-column: 1 / -1; font-size: 9.5px; text-transform: uppercase;
                   letter-spacing: .05em; color: #777; margin-bottom: 3px; }
    .pr-env-row { display: flex; justify-content: space-between; align-items: baseline;
                  gap: 10px; padding: 1px 0; font-size: 11px; }
    .pr-env-k { color: #555; }
    .pr-env-v { font: 600 11px "SF Mono", Menlo, Consolas, monospace; color: #14181d;
                text-align: right; white-space: nowrap; }
    /* text blocks */
    .pr-p { margin: 0 0 6px; }
    .pr-bullet { padding-left: 16px; position: relative; }
    .pr-bullet::before { content: "•"; position: absolute; left: 4px; color: #c0392b; }
    .pr-footer { margin-top: 16px; padding-top: 8px; border-top: 1px solid #ddd;
                 font-size: 10px; color: #999; }
  }`;

// inject the print stylesheet once
function ensurePrintCss() {
  if (document.getElementById('pr-css')) return;
  const s = document.createElement('style');
  s.id = 'pr-css';
  s.textContent = PRINT_CSS;
  document.head.appendChild(s);
}

// window.print() is a no-op inside a WKWebView (no dialog behind it), so the Mac
// app runs an NSPrintOperation over the live view; the browser build's dialog is
// real. The promise resolves when the panel closes (native) or immediately (web).
function triggerPrint() {
  if (window.bmacw && typeof window.bmacw.printPage === 'function') {
    return window.bmacw.printPage().catch(() => {});
  }
  window.print();
  return Promise.resolve();
}

// Build the print document, print it, and tear it down afterwards. Returns a
// promise that settles when printing is done (or abandoned).
function printDoc(opts) {
  ensurePrintCss();
  const o = opts || {};
  const sections = (o.sections || []).filter(Boolean);
  const bodyHtml = sections.map((sec) => {
    const inner = typeof sec === 'string' ? sec : (sec.html || '');
    if (!inner) return '';
    return `<section class="pr-section${sec.avoidBreak ? ' avoid-break' : ''}">${inner}</section>`;
  }).join('');

  const meta = (o.meta || []).filter(Boolean)
    .map(([k, v]) => `<span>${esc(k)} <b>${esc(v)}</b></span>`).join('');
  const app = (typeof APP_NAME === 'string') ? APP_NAME : 'BMWeb';
  const footer = o.footer != null ? o.footer
    : `${app} · printed ${new Date().toLocaleDateString()}`;

  const root = document.createElement('div');
  root.id = 'pr-root';
  root.innerHTML = `
    <div class="pr-head">
      <h1 class="pr-title">${esc(o.title || app)}</h1>
      ${o.subtitle ? `<div class="pr-subtitle">${esc(o.subtitle)}</div>` : ''}
      ${meta ? `<div class="pr-meta">${meta}</div>` : ''}
    </div>
    ${bodyHtml}
    ${footer ? `<div class="pr-footer">${esc(footer)}</div>` : ''}`;

  // orientation is a per-print @page choice; a tiny scoped style toggles it
  const pageStyle = document.createElement('style');
  pageStyle.textContent = `@media print { @page { size: ${o.landscape ? 'landscape' : 'portrait'}; } }`;

  document.body.appendChild(root);
  document.head.appendChild(pageStyle);
  document.body.classList.add('pr-active');   // gates the @media print takeover

  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    root.remove();
    pageStyle.remove();
    document.body.classList.remove('pr-active');
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);

  // wait for any <img> to decode, else it prints blank; cap the wait so a slow
  // or broken image never hangs the print.
  const imgs = [...root.querySelectorAll('img')];
  const ready = imgs.length
    ? Promise.race([
        Promise.all(imgs.map((im) => im.complete ? Promise.resolve()
          : im.decode().catch(() => {}))),
        new Promise((r) => setTimeout(r, 4000)),
      ])
    : Promise.resolve();

  return ready.then(() => {
    if (typeof o.onReady === 'function') { try { o.onReady(); } catch {} }
    const p = triggerPrint();
    setTimeout(cleanup, 20000);   // last resort if afterprint never fires
    return p.then(cleanup, cleanup);
  });
}

// The current screen's Print action, if it declared one via setActions. Matched
// by kind/label/hotkey so screens don't need to know about this interceptor.
function currentPrintAction() {
  const bar = (typeof actionBar !== 'undefined') ? actionBar : null;
  const list = (bar && bar.current) || [];
  return list.find(a => a && a.fn &&
    (a.kind === 'print' || a.label === 'Print' || a.key === 'p')) || null;
}

// Route the browser's native Cmd/Ctrl+P to the active screen's clean print, so
// the everyday print shortcut produces the theme-agnostic sheet -- not a blank
// page (the app's own action bar ignores Cmd-modified keys). Screens with no
// Print action fall through to the browser's normal print (body isn't pr-active,
// so the live page prints as-is).
function installPrintHotkey() {
  window.addEventListener('keydown', (e) => {
    const p = (e.key === 'p' || e.key === 'P');
    if (!p || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
    if (document.getElementById('pr-root')) return;   // a print is already staged
    const act = currentPrintAction();
    if (!act) return;                                 // let the native dialog run
    e.preventDefault();
    act.fn();
  }, true);   // capture, to beat the app's own key handler and the dialog
}

if (typeof window !== 'undefined') {
  window.printDoc = printDoc;
  window.installPrintHotkey = installPrintHotkey;
  window.printImage = printImage;
  window.printSvg = printSvg;
  window.printTable = printTable;
  window.printBlocks = printBlocks;
  window.printHeading = printHeading;
  window.printHtml = printHtml;
  window.triggerPrint = triggerPrint;
}
