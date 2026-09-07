/**
 * @file Tuning screen: the shared definition library -- fetching its index
 * from the mirrors, matching a loaded BIN against it, offering (never
 * silently loading) the match, and the browser that lists the whole library
 * grouped by ECU.
 *
 * MATCHING IS TWO-STAGE, and both stages matter:
 *   1. SIZE picks the layout. The MS45.1 pair are otherwise identical
 *      definitions; only the BIN length distinguishes the 116 KB
 *      calibration-only read from the 1 MB full flash.
 *   2. The IDENTITY STRING proves the software version. Every MS45 image
 *      carries an ASCII block at the definition's own baseOffset
 *      ("LO00SJ2R457O0L..."); the definition's `software` field must appear
 *      in it. Size alone would happily match a same-length image built from
 *      different DME software.
 * A size hit WITHOUT the version confirmation is reported as a weak match
 * and says so in the prompt, rather than being hidden or auto-accepted.
 */

/* exported tnOfferDefinitionFor, tnOpenXdfBrowser, tnApplyDefinition */

/**
 * @typedef {Object} XdfIndexEntry
 * One definition as the library's index.json lists it.
 * @property {string} file - File name on the mirror.
 * @property {string} [title]
 * @property {string} [ecu]
 * @property {string} [software] - A fixed version string that must appear in the image.
 * @property {number} [binSize] - The image length this definition fits.
 * @property {number} [bytes] - The .xdf file size.
 * @property {number} [items]
 * @property {string} [author]
 * @property {number} [baseOffset]
 * @property {number} [identityOffset] - Where the identity block sits (else baseOffset).
 * @property {number} [identityLength]
 * @property {boolean} [identityReversed] - The block is reversed ASCII digits.
 * @property {string[]} [knownParts] - Chip numbers seen for this DME.
 * @property {string} [identityPattern] - A regex a well-formed part number matches.
 * @property {number} [regionSize]
 */

/**
 * @typedef {Object} XdfMatch
 * @property {XdfIndexEntry} def
 * @property {string} ident - The trimmed identity string read from the image.
 * @property {boolean} confirmed
 * @property {'software'|'part'|'pattern'|''} via - What confirmed it.
 */

/** Default identity block length, in bytes. */
const TN_IDENTITY_LEN = 24;
/** Default length of a reversed chip-number block. */
const TN_IDENTITY_REVERSED_LEN = 10;

/**
 * The library index from the first mirror that answers.
 * @returns {Promise<{ base: string, index: { definitions: XdfIndexEntry[] } }|null>}
 */
async function tnFetchXdfIndex() {
  for (const base of XDF_MIRRORS) {
    try {
      const r = await fetch(base + 'index.json', { cache: 'no-store' });
      if (!r.ok) continue;
      const j = await r.json();
      if (j && Array.isArray(j.definitions)) return { base, index: j };
    } catch (e) {
      /* try the next mirror */
    }
  }
  return null;
}

/**
 * Read the ASCII identity block a definition expects at an offset;
 * non-printable bytes read as spaces.
 * @param {Uint8Array} bin
 * @param {number} offset
 * @param {number} [len]
 * @returns {string}
 */
function tnIdentityAt(bin, offset, len = TN_IDENTITY_LEN) {
  if (!bin || offset < 0 || offset + 2 > bin.length) return '';
  let out = '';
  const end = Math.min(bin.length, offset + len);
  for (let i = offset; i < end; i++) {
    const b = bin[i];
    out += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ' ';
  }
  return out;
}

/**
 * Some definitions carry no ASCII header block at all. The pre-1996 DME
 * images instead store the BMW chip number as REVERSED ASCII digits (the
 * definitions label it "read hex backwards"): 0xFE4F reads "3267537621",
 * which reversed is the real part number 1267357623. An index entry opts
 * into this with identityReversed:true.
 * @param {Uint8Array} bin
 * @param {number} offset
 * @param {number} [len]
 * @returns {string}
 */
function tnIdentityAtReversed(bin, offset, len = TN_IDENTITY_REVERSED_LEN) {
  const fwd = tnIdentityAt(bin, offset, len);
  return fwd.split('').reverse().join('');
}

/**
 * Every index entry that fits `bin`, confirmed ones first and the stronger
 * evidence first among those: an exact known chip number beats "a part
 * number reads here".
 * @param {Uint8Array} bin
 * @param {XdfIndexEntry[]} defs
 * @returns {XdfMatch[]}
 */
function tnMatchDefinitions(bin, defs) {
  const out = [];
  for (const d of defs) {
    if (!d || typeof d.binSize !== 'number') continue;
    if (d.binSize !== bin.length) continue; // stage 1: layout
    // The marker is NOT always at baseOffset: MS45 happens to put them in
    // the same place, MS43 keeps its identity block at 0x8 (64 KB layout)
    // or 0x70008 (512 KB), while its maps start at 0. So the index names
    // the offset explicitly and we fall back to baseOffset only for older
    // entries that predate the field.
    const at = d.identityOffset != null ? d.identityOffset : d.baseOffset || 0;
    const identLen =
      typeof d.identityLength === 'number' ? d.identityLength : TN_IDENTITY_LEN;
    const ident = d.identityReversed
      ? tnIdentityAtReversed(bin, at, identLen)
      : tnIdentityAt(bin, at, identLen);
    // Three ways an entry can prove itself, strongest first:
    //   software       a fixed version string that must appear (MS43/MS45)
    //   knownParts     this exact chip is one we have seen for this DME
    //   identityPattern a well-formed BMW part number reads here at all --
    //                  weaker, but it still rules out the wrong DME family,
    //                  because the wrong offset yields obvious garbage.
    const trimmed = ident.trim();
    let confirmed = false;
    let via = '';
    if (d.software && ident.includes(d.software)) {
      confirmed = true;
      via = 'software';
    } else if (Array.isArray(d.knownParts) && d.knownParts.includes(trimmed)) {
      confirmed = true;
      via = 'part';
    } else if (
      d.identityPattern &&
      new RegExp(d.identityPattern).test(trimmed)
    ) {
      confirmed = true;
      via = 'pattern';
    }
    out.push({ def: d, ident: trimmed, confirmed, via });
  }
  const rank = (h) => (h.confirmed ? (h.via === 'pattern' ? 1 : 2) : 0);
  out.sort((a, b) => rank(b) - rank(a));
  return out;
}

/**
 * The body of the "Definition found" prompt for the best match.
 * @param {XdfMatch} best
 * @returns {string} HTML.
 */
function tnMatchPromptHtml(best) {
  const d = best.def;
  const sizeKb = tnDefSizeLabel(d.bytes);
  const chip = esc(best.ident.slice(0, 20));
  let evidence;
  if (d.software) evidence = `software <code>${esc(d.software)}</code>`;
  // Only name a chip when one actually validated. On a size-only hit
  // `ident` is whatever bytes happened to sit at the offset -- printing
  // that as "chip" dresses up noise as identification.
  else if (best.confirmed && best.ident) evidence = `chip <code>${chip}</code>`;
  else evidence = `${esc(d.items || '?')} items`;
  let verdict;
  if (!best.confirmed) {
    verdict =
      `<div class="tn-match-warn">⚠ size matches but the software ` +
      `version could not be confirmed in this image — the addresses ` +
      `may not line up. Check before editing.</div>`;
  } else if (best.via === 'pattern') {
    verdict =
      `<div class="tn-match-warn">⚠ this looks like the right DME ` +
      `family — part number <code>${chip}</code> ` +
      `reads where this definition expects one, but it is not a chip ` +
      `we have seen. The addresses may not line up; check the maps ` +
      `look sane before editing.</div>`;
  } else {
    verdict =
      `<div class="tn-match-ok">✓ version confirmed in the image ` +
      `(<code>${chip}</code>)</div>`;
  }
  return (
    `<p>This image matches a definition in the shared library.</p>` +
    `<div class="tn-match">` +
    `<div><b>${esc(d.title || d.file)}</b></div>` +
    `<div class="tn-match-row">${esc(d.ecu || '')} · ${evidence} · ${sizeKb}</div>` +
    verdict +
    `</div>` +
    `<p class="tn-match-foot">Downloading ${sizeKb}. Nothing is uploaded.</p>`
  );
}

/**
 * On loading a BIN with no definition open, look for one that fits and
 * OFFER it. Never load silently: a definition decides how every byte is
 * interpreted, and a wrong one produces plausible-looking numbers at
 * plausible-looking addresses -- the worst kind of wrong. The user confirms.
 * @param {TuningEditor} ed
 * @param {Uint8Array} bin
 * @returns {Promise<void>}
 */
async function tnOfferDefinitionFor(ed, bin) {
  if (tuningState.def) return; // user already chose one
  if (!bin || typeof fetch !== 'function') return;
  let found;
  try {
    found = await tnFetchXdfIndex();
  } catch (e) {
    return;
  }
  if (!found) return; // offline / mirrors down: silent
  const hits = tnMatchDefinitions(bin, found.index.definitions);
  if (!hits.length) return; // nothing fits: say nothing
  if (tuningState.def) return; // they loaded one while we fetched

  const best = hits[0];
  const ok = await confirmDialog({
    title: 'Definition found',
    body: tnMatchPromptHtml(best),
    confirmLabel: 'Load definition',
    cancelLabel: 'Not now',
    // A pattern-only hit is not a proven match -- keep the destructive
    // styling so it reads as "probably right", not "confirmed".
    danger: !best.confirmed || best.via === 'pattern',
  });
  if (!ok) return;

  await tnDownloadDefinition(ed, found.base, best.def.file);
}

/**
 * One browser row.
 * @param {XdfIndexEntry} d
 * @returns {string} HTML.
 */
function tnXdfBrowserRow(d) {
  const bin =
    d.regionSize >= 1048576 || d.binSize >= 1048576 ? '1 MB image' : '';
  return (
    `<button class="tn-xdfb-row" data-file="${esc(d.file)}">` +
    `<span class="tn-xdfb-title">${esc(d.title || d.file)}</span>` +
    `<span class="tn-xdfb-meta">` +
    (d.software ? `sw <code>${esc(d.software)}</code> · ` : '') +
    (d.items ? `${esc(d.items)} params · ` : '') +
    `${tnDefSizeLabel(d.bytes)}${bin ? ' · ' + bin : ''}` +
    (d.author ? ` · ${esc(d.author)}` : '') +
    `</span></button>`
  );
}

/**
 * XDF browser: the whole shared library, grouped by ECU. Lists every
 * definition the mirrors carry so a user can pick one by hand (e.g. before
 * loading a BIN, or when auto-match could not confirm one). Clicking a row
 * downloads and opens it via the same path as auto-suggest.
 * @param {TuningEditor} ed
 * @returns {Promise<void>}
 */
async function tnOpenXdfBrowser(ed) {
  const { overlay, close } = openModal(
    `<div class="modal tn-xdfb" role="dialog" aria-modal="true">
         <div class="modal-title">Definition library</div>
         <input class="tn-xdfb-search" type="search"
                placeholder="Filter by ECU, software or file name…" aria-label="Filter definitions" />
         <div class="tn-xdfb-list" id="tn-xdfb-list">
           <div class="tn-xdfb-loading"><span class="wiring-spinner"></span> loading the shared library…</div>
         </div>
         <div class="modal-actions">
           <button class="btn modal-cancel">Close<span class="modal-key">Esc</span></button>
         </div>
       </div>`
  );
  const listEl = overlay.querySelector('#tn-xdfb-list');
  const searchEl = overlay.querySelector('.tn-xdfb-search');
  overlay.querySelector('.modal-cancel').onclick = () => close();

  const found = await tnFetchXdfIndex().catch(() => null);
  if (!found) {
    listEl.innerHTML =
      `<div class="tn-xdfb-empty">Could not reach the definition library. ` +
      `Check your connection, or load a .xdf file directly.</div>`;
    return;
  }
  const defs = (found.index.definitions || [])
    .slice()
    .sort(
      (a, b) =>
        String(a.ecu || '').localeCompare(String(b.ecu || '')) ||
        String(a.title || a.file).localeCompare(String(b.title || b.file))
    );

  function render(filter) {
    const q = (filter || '').trim().toLowerCase();
    const shown = defs.filter(
      (d) =>
        !q ||
        `${d.ecu} ${d.title} ${d.file} ${d.software || ''} ${d.author || ''}`
          .toLowerCase()
          .includes(q)
    );
    if (!shown.length) {
      listEl.innerHTML = `<div class="tn-xdfb-empty">No definitions match “${esc(filter)}”.</div>`;
      return;
    }
    let html = '';
    let group = null;
    for (const d of shown) {
      const ecu = d.ecu || 'Other';
      if (ecu !== group) {
        group = ecu;
        html += `<div class="tn-xdfb-group">${esc(ecu)}</div>`;
      }
      html += tnXdfBrowserRow(d);
    }
    listEl.innerHTML = html;
    listEl.querySelectorAll('.tn-xdfb-row').forEach((row) => {
      row.onclick = async () => {
        row.classList.add('loading');
        const ok = await tnDownloadDefinition(ed, found.base, row.dataset.file);
        if (ok) close();
        else row.classList.remove('loading');
      };
    });
  }

  render('');
  searchEl.oninput = () => render(searchEl.value);
  searchEl.focus();
}

/**
 * After a definition was adopted (from a file or a mirror): rebuild the
 * coverage map, persist, redraw the tree, repaint the hex view (the map
 * only exists once a definition is open) and the status line.
 * @param {TuningEditor} ed
 * @returns {void}
 */
function tnApplyDefinition(ed) {
  tnBuildCoverage();
  tnSaveSoon();
  tnRenderDefs(ed);
  ed.hex.refresh();
  tnUpdateStatus(ed);
}

/**
 * Fetch a .xdf from a mirror and make it the open definition. Shared by the
 * auto-suggest flow and the XDF browser so both apply it identically.
 * @param {TuningEditor} ed
 * @param {string} base - Mirror base URL.
 * @param {string} file - File name on the mirror.
 * @returns {Promise<boolean>} Whether it loaded.
 */
async function tnDownloadDefinition(ed, base, file) {
  ed.els.status.textContent = `downloading ${file}…`;
  try {
    const r = await fetch(base + file, { cache: 'no-store' });
    if (!r.ok) throw new Error(`mirror returned ${r.status}`);
    const text = await r.text();
    tnAdoptDefinition(window.XDF.parseXdf(text), text, file);
    tnApplyDefinition(ed);
    return true;
  } catch (e) {
    ed.els.status.textContent = `could not load ${file}: ${e.message}`;
    return false;
  }
}
