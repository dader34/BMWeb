// Reference documents, from BMW's own ISTA diagnostic database. Each .docs
// archive (tools/ista_docs_import.py) packs one car's text documents -- repair
// instructions, pin assignments, installation locations, connector views,
// functional descriptions, technical data, torques and more -- as parsed
// typed-block JSON, grouped into ISTA's component tree.
//
// These documents live inside the merged Wiring & Documents screen (wiring.js),
// reached by its Components / Repair category toggle. This file provides the
// data access and rendering helpers that screen calls; it has no screen of its
// own.

const DOCS_CACHE = new Map();   // chassis -> { tree, docs: Map(id -> u8) }

// document-type badges (ISTA INFOTYPE -> label + a colour class for the dot)
const DOCS_TYPE_LABEL = {
  REP: 'Repair', FKB: 'Fault code', EBO: 'Installation location',
  STA: 'Connector view', FUB: 'Functional description', PIB: 'Pin assignment',
  TED: 'Technical data', AZD: 'Tightening torques', SWZ: 'Special tool',
  FTD: 'Technical information', SIT: 'Service information', SBS: 'Reference',
  SWS: 'Special equipment', NEU: "What's new", MSM: 'Mobile service',
  FEB: 'Troubleshooting', REH: 'Repair note', COM: 'Compilation',
  GPI: 'Programming/coding',
};
const DOCS_TYPE_KIND = {         // reuse the wiring dot colours by kind
  REP: 'test', FEB: 'test', REH: 'test',
  PIB: 'pins', STA: 'connector', EBO: 'location',
  TED: 'specs', AZD: 'specs', SWZ: 'specs', SWS: 'specs',
  FUB: 'description', FTD: 'description', SIT: 'description',
  SBS: 'description', NEU: 'description', MSM: 'description',
  COM: 'description', GPI: 'description', FKB: 'schematic',
};

// which chassis carry a .docs bundle (probed once, remembered)
let DOCS_CHASSIS = null;

async function docsChassisList() {
  if (DOCS_CHASSIS) return DOCS_CHASSIS;
  const ids = await api('/api/chassis').catch(() => []);
  const have = await Promise.all(ids.map((id) => docsHasChassis(id)));
  DOCS_CHASSIS = ids.filter((_, i) => have[i]);
  return DOCS_CHASSIS;
}

async function docsHasChassis(chassis) {
  const id = chassis.toUpperCase();
  if (DOCS_CACHE.has(id)) return true;
  if (typeof BMACW_DOCS === 'object' && BMACW_DOCS && BMACW_DOCS[id]) return true;
  const base = (typeof WEB_BASE === 'string') ? WEB_BASE : '';
  const real = (typeof webRealFetch === 'function')
    ? webRealFetch : window.fetch.bind(window);
  try {
    const r = await real(`${base}/data/docs/${id}.docs`, { method: 'HEAD' });
    return !!(r && r.ok);
  } catch (e) { return false; }
}

async function loadDocs(chassisId) {
  const id = chassisId.toUpperCase();
  if (DOCS_CACHE.has(id)) return DOCS_CACHE.get(id);
  let bytes;
  const inline = (typeof BMACW_DOCS === 'object' && BMACW_DOCS)
    ? BMACW_DOCS[id] : null;
  if (inline) {
    const bin = atob(inline);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    const base = (typeof WEB_BASE === 'string') ? WEB_BASE : '';
    const real = (typeof webRealFetch === 'function')
      ? webRealFetch : window.fetch.bind(window);
    const r = await real(`${base}/data/docs/${id}.docs`);
    if (!r.ok) throw new Error(`no reference documents shipped for ${dispChassis(id)}`);
    bytes = new Uint8Array(await r.arrayBuffer());
  }
  const unzipped = fflate.unzipSync(bytes);
  const tree = JSON.parse(new TextDecoder().decode(unzipped['tree.json']));
  const docs = new Map(Object.entries(unzipped));
  const data = { tree, docs };
  DOCS_CACHE.set(id, data);
  return data;
}

// one document body, inflated + parsed from the archive
function docsDoc(data, docId) {
  const raw = data.docs.get(`docs/${docId}.json`);
  if (!raw) return null;
  try { return JSON.parse(fflate.strFromU8(raw)); } catch (e) { return null; }
}

// one chapter -> HTML: heading, then its typed blocks
function docsChapterHtml(ch) {
  const head = ch.heading ? `<div class="fm-tp-h">${esc(ch.heading)}</div>` : '';
  const body = (ch.blocks || []).map(docsBlockHtml).join('');
  return `<div class="fm-tp-chap">${head}${body}</div>`;
}

// typed block -> HTML. 'h' is a sub-heading; 'p'/'bullet' are prose; 'table' is
// a grid sized to its widest row. Mirrors lookup.js's _tpBlock for consistency.
function docsBlockHtml(b) {
  if (b.t === 'h') return `<div class="fm-tp-subh">${esc(b.s)}</div>`;
  if (b.t === 'p') return `<p class="fm-tp-p">${docsInline(b.s)}</p>`;
  if (b.t === 'bullet') return `<p class="fm-tp-p fm-tp-bullet">${docsInline(b.s)}</p>`;
  if (b.t !== 'table' || !b.rows || !b.rows.length) return '';
  const cols = Math.max(...b.rows.map((r) => r.length));
  const rows = b.rows.map((r, ri) => {
    const cells = [];
    for (let i = 0; i < cols; i++) {
      cells.push(`<span class="fm-tp-td${ri === 0 ? ' fm-tp-th' : ''}">`
        + `${esc(r[i] || '')}</span>`);
    }
    return `<div class="fm-tp-tr">${cells.join('')}</div>`;
  }).join('');
  return `<div class="fm-tp-table" style="--cols:${cols}">${rows}</div>`;
}

// keep newlines inside a bullet (a HINT title + its sub-lines) as line breaks
function docsInline(s) {
  return esc(s).replace(/\n/g, '<br>');
}
