/**
 * @file Sharing and printing a document: the Share button copies the current
 * deep link, and Print hands the schematic or description to the shared
 * print helper as a clean sheet.
 */

/* exported
   wiringShareButton, printWiring */

/** How long the Share button shows its "Copied" confirmation, ms. */
const WIRING_COPY_FLASH_MS = 1600;
/** A schematic wider than this many times its height is sliced for print. */
const WIRING_PRINT_SLICE_ASPECT = 1.8;
/** The most slices a schematic is cut into for print. */
const WIRING_PRINT_MAX_SLICES = 3;
/** Overlap between adjacent print slices, as a fraction of a slice's width. */
const WIRING_PRINT_SLICE_OVERLAP = 0.03;

/**
 * A Share button for a document bar or the zoom controls.
 * @param {boolean} classic - INPA mode: WDS's button class
 * @returns {HTMLButtonElement}
 */
function wiringShareButton(classic) {
  const share = document.createElement('button');
  share.className = (classic ? 'wds-btn' : 'btn wiring-fit') + ' wiring-share';
  share.textContent = 'Share';
  share.title = 'Copy a link to this document';
  share.onclick = () => wiringShareCurrent(share);
  return share;
}

/**
 * Copy text to the clipboard: the async clipboard API where it exists, else
 * a hidden-textarea copy (file://, older browsers).
 * @param {string} text - what to copy
 * @returns {Promise<boolean>} whether the copy succeeded
 */
async function wiringCopyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {
    /* fall through to the textarea copy */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) {
    return false;
  }
}

/**
 * Copy a shareable link to the document on screen. The app already reflects
 * the open document in the address bar (#apps/wiring/<CHASSIS>/<DOC>), so the
 * link is just the current URL. Flash the button to confirm the copy.
 * @param {HTMLButtonElement | null} btn - the Share button to flash
 * @returns {Promise<void>}
 */
async function wiringShareCurrent(btn) {
  const ok = await wiringCopyText(location.href);
  if (!btn) return;
  const original = btn.textContent;
  btn.textContent = ok ? '✓ Copied' : 'Copy failed';
  btn.classList.toggle('copied', ok);
  clearTimeout(btn._copyTimer);
  btn._copyTimer = setTimeout(() => {
    btn.textContent = original;
    btn.classList.remove('copied');
  }, WIRING_COPY_FLASH_MS);
}

/**
 * The print section for a schematic. A WDS schematic is a wide strip (4:1
 * and wider). Width-fitted to one sheet -- even landscape -- it prints a few
 * cm tall with the lower page empty. Slice a wide strip into stacked
 * full-width segments, each with a little overlap so a component at a cut
 * shows whole on one of the two sides; every segment then prints 2-3x
 * larger.
 * @param {SVGSVGElement} svg - the live schematic
 * @returns {{html: string}}
 */
function wiringPrintSection(svg) {
  // clone so restoring the home viewBox for print doesn't disturb the live one
  const clone = svg.cloneNode(true);
  if (clone.dataset.homeViewbox)
    clone.setAttribute('viewBox', clone.dataset.homeViewbox);
  clone.removeAttribute('style'); // drop any on-screen zoom transform
  const vb = (clone.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  const aspect = vb.length === 4 && vb[3] > 0 ? vb[2] / vb[3] : 1;
  const slices = Math.min(
    WIRING_PRINT_MAX_SLICES,
    Math.max(1, Math.round(aspect / WIRING_PRINT_SLICE_ASPECT))
  );
  if (slices <= 1) return printSvg(clone.outerHTML);
  const w = vb[2] / slices,
    pad = w * WIRING_PRINT_SLICE_OVERLAP;
  const parts = [];
  for (let i = 0; i < slices; i++) {
    const s = clone.cloneNode(true);
    const x0 = Math.max(vb[0], vb[0] + i * w - pad);
    const x1 = Math.min(vb[0] + vb[2], vb[0] + (i + 1) * w + pad);
    s.setAttribute('viewBox', `${x0} ${vb[1]} ${x1 - x0} ${vb[3]}`);
    s.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    parts.push(`<figure class="pr-fig pr-fig-svg">${s.outerHTML}</figure>`);
  }
  return { html: parts.join('') };
}

/**
 * Print the DOCUMENT via the shared theme-agnostic helper (core/print.js): a
 * clean sheet built from the diagram/description, not the styled app. A
 * wiring diagram prints as its inlined SVG (whole circuit, not the zoomed
 * view); a description prints as its HTML. Either way the printout ignores
 * the current theme and layout entirely.
 * @param {string} chassisId - chassis code, for the sheet's meta and footer
 * @returns {void}
 */
function printWiring(chassisId) {
  const stage = document.querySelector('.wiring-stage');
  const svg = stage && stage.querySelector('svg');
  const doc = document.querySelector('.wiring-doc');
  const title = document.querySelector('.wiring-title');
  const kind = document.querySelector('.wiring-kind');
  const titleText = (title && title.textContent) || 'Wiring diagram';
  const kindText = (kind && kind.textContent) || 'Wiring diagram';

  let section;
  if (svg) section = wiringPrintSection(svg);
  else if (doc)
    section = printHtml(doc.innerHTML); // a description document
  else section = printHtml('');

  printDoc({
    title: titleText,
    meta: [
      ['Vehicle', dispChassis(chassisId)],
      ['Type', kindText],
    ],
    sections: [section],
    landscape: !!svg, // a diagram wants landscape; a description reads portrait
    footer: `BMWeb · ${dispChassis(chassisId)} · printed ${new Date().toLocaleDateString()}`,
  });
}
