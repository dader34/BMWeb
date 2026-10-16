/**
 * @file ISTA shell: the tool's own wiring documents (index, bodies, picks, designators) as a plan opens them.
 */

/* exported istaAblDocHtml, istaWiringDocHtml, istaWiringForDesignator, istaOrderWords, istaWiringBindDesignators, istaOpenPlanNote */

/** Hosted copy of the tool's own wiring documents. */

/** @type {Map<string, object|null>} chassis -> its wiring index, once. */
const istaWiringIndexes = new Map();

/** @type {Map<string, object|null>} chassis + shard -> its bodies, once. */
const istaWiringBodies = new Map();

/**
 * Fetch one wiring file, local first then the dataset.
 * @param {string} rel - the path under data/ista/wiring/
 * @returns {Promise<Response|null>}
 */
async function istaWiringFetch(rel) {
  // the car's bundle first: one archive holds every schematic and document
  // for this chassis, so a technician pays one download instead of one
  // request per drawing (see istaBundle)
  const cut = String(rel || '').indexOf('/');
  if (cut > 0 && typeof istaBundleFile === 'function') {
    const hit = await istaBundleFile(
      rel.slice(0, cut),
      `wiring/${rel.slice(cut + 1)}`
    );
    if (hit) return hit;
  }
  const base = typeof WEB_BASE === 'string' && WEB_BASE ? WEB_BASE : '.';
  const real =
    typeof webRealFetch === 'function'
      ? webRealFetch
      : window.fetch.bind(window);
  for (const u of [
    `${base}/data/ista/wiring/${rel}`,
    ...hfUrls(`ista/wiring/${rel}`).slice(1),
  ]) {
    try {
      const r = await real(u);
      if (r && r.ok) return r;
    } catch (e) {
      /* try the next source */
    }
  }
  return null;
}

/**
 * The tool's own wiring documents for a chassis, once per session.
 * @param {string} chassis - the development code
 * @returns {Promise<object|null>}
 */
async function istaWiringIndex(chassis) {
  const code = String(chassis || '').toUpperCase();
  if (!code) return null;
  if (istaWiringIndexes.has(code)) return istaWiringIndexes.get(code);
  const out = await istaProbe(async () => {
    const r = await istaWiringFetch(`${code}/index.json`);
    return r ? r.json() : null;
  });
  istaWiringIndexes.set(code, out || null);
  return out || null;
}

/**
 * Every document of the pane's kind the module links, in the order it links
 * them.
 *
 * THE FIRST LINK IS NOT ALWAYS THE ONE THAT RESOLVES. A module links the
 * documents ISTA associates with it, and this build ships the tool's own
 * wiring set -- which does not carry every id those links name. The AUC
 * module links three diagrams: the first two are absent from the wiring
 * index, the third ("AUC sensor") is there with its drawing. Taking only the
 * first meant a pane that said nothing matched while the drawing sat on
 * disk.
 * @param {object[]} documents - the row's linked documents
 * @param {string} label - the pane's label
 * @returns {object[]} the candidates, best-effort order
 */
function istaWiringPicks(documents, label) {
  if (documents && !Array.isArray(documents)) return [];
  const want = /Wiring/i.test(label) ? 'diagram' : 'function';
  return (documents || []).filter((d) => d && d.type === want);
}

/**
 * A document pane's HTML, from the document the module's own link names.
 *
 * The lookup is by identifier end to end: the module's index entry lists
 * the documents its diagnosis object links to, and the wiring extract
 * stores those under the tool's own ids. Nothing is matched by title, so a
 * pane is either the document the step means or it is empty.
 * @param {object} doc - the document request the module made
 * @param {string} label - which pane it is filling
 * @param {string} chassis - the development code
 * @param {object[]} documents - the module's linked documents
 * @returns {Promise<string|null>}
 */
async function istaAblDocHtml(doc, label, chassis, documents) {
  if (!doc) return null;
  // the first link that this build can actually draw, not just the first
  for (const hit of istaWiringPicks(documents, label)) {
    const html = await istaWiringDocHtml(chassis, hit.id);
    if (html) return html;
  }
  return null;
}

/**
 * One wiring document's HTML, by the tool's own document id.
 *
 * Split out of the pane so a designator clicked on a diagram can draw its
 * installation location beside that diagram through the same path.
 * @param {string} chassis - the development code
 * @param {number|string} id - the document id
 * @returns {Promise<string|null>}
 */
async function istaWiringDocHtml(chassis, id) {
  const code = String(chassis || '').toUpperCase();
  const index = await istaWiringIndex(code);
  const row = ((index && index.documents) || []).find(
    (d) => String(d.id) === String(id)
  );
  if (!row) return null;
  if (row.type === 'diagram') {
    const svg = await istaProbe(async () => {
      const r = await istaWiringFetch(`${code}/svg/${row.id}.svgz`);
      if (!r || typeof fflate === 'undefined') return null;
      const bytes = new Uint8Array(await r.arrayBuffer());
      return new TextDecoder('utf-8').decode(fflate.gunzipSync(bytes));
    });
    if (!svg) return null;
    return (
      `<div class="irabl-doct">${esc(row.title || row.identifier)}</div>` +
      `<div class="irabl-svg">${svg}</div>`
    );
  }
  const key = `${code}/${row.shard}`;
  if (!istaWiringBodies.has(key)) {
    const body = await istaProbe(async () => {
      const r = await istaWiringFetch(`${code}/body/${row.shard}.json`);
      return r ? r.json() : null;
    });
    istaWiringBodies.set(key, body || null);
  }
  const shard = istaWiringBodies.get(key);
  const blocks = shard && shard[String(row.id)];
  if (!blocks || !blocks.length) return null;
  return (
    `<div class="irabl-doct">${esc(row.title || row.identifier)}</div>` +
    `<div class="irabl-doc">${istaWiringBlocks(blocks)}</div>`
  );
}

/** Roughly how long a joined run may grow before it is split at a sentence. */
const ISTA_DOC_PARA = 400;

/**
 * Consecutive text blocks joined back into paragraphs.
 *
 * A SENTENCE IS NOT ONE BLOCK. ISTA marks emphasis inline and the extract
 * keeps every run as its own node, so "The air quality is sensed by the AUC
 * sensor in the engine compartment." arrives as seven text blocks. Drawn one
 * <p> each, a paragraph became a column of fragments one or two words wide.
 *
 * Runs are joined until something that is genuinely its own block -- a
 * heading, a picture, a table -- interrupts them. Spacing follows the text:
 * a fragment opening with punctuation closes up against the one before it,
 * the way it reads in the tool.
 * @param {object[]} blocks - the stored body
 * @returns {object[]} the same blocks with text runs merged
 */
function istaWiringRuns(blocks) {
  const out = [];
  let run = null;
  for (const b of blocks || []) {
    if (!b) continue;
    if (b.kind && b.kind !== 'text') {
      run = null;
      out.push(b);
      continue;
    }
    const t = String(b.text || '').trim();
    if (!t) continue;
    if (!run) {
      run = { kind: 'text', text: t };
      out.push(run);
      continue;
    }
    // no space before punctuation that closes the previous fragment, and
    // none after an opening bracket -- otherwise the join reads as typed
    const tight = /^[.,;:!?)\]]/.test(t) || /[([]$/.test(run.text);
    run.text += (tight ? '' : ' ') + t;
    // the extract keeps no paragraph marks, so a run that has grown past a
    // readable length is closed at its last sentence end rather than left to
    // run on; the remainder starts the next one
    if (run.text.length > ISTA_DOC_PARA) {
      const cut = run.text.lastIndexOf('. ');
      if (cut > 40) {
        const rest = run.text.slice(cut + 2).trim();
        run.text = run.text.slice(0, cut + 1);
        run = rest ? { kind: 'text', text: rest } : null;
        if (run) out.push(run);
      }
    }
  }
  return out;
}

/**
 * A document's blocks as the tool draws them.
 *
 * THE STRUCTURE IS THE DOCUMENT. An installation location is a PICTURE of
 * the part in the car with a legend naming what the arrows point at, and a
 * pin assignment is a real table of pins; both used to come out as a column
 * of undifferentiated lines. A picture whose file this build does not have
 * is skipped rather than drawn as a broken image.
 * @param {object[]} blocks - the stored body
 * @returns {string} HTML
 */
function istaWiringBlocks(blocks) {
  const cell = (c) => `<td>${esc(c || '')}</td>`;
  return istaWiringRuns(blocks)
    .map((b) => {
      if (!b) return '';
      if (b.kind === 'heading') return `<h4>${esc(b.text)}</h4>`;
      if (b.kind === 'pic') {
        const src =
          typeof repairPicUrl === 'function' ? repairPicUrl(b.id) : null;
        if (!src) return '';
        return (
          `<figure class="irabl-fig">` +
          `<img src="${esc(src)}" alt="${esc(b.caption || '')}" ` +
          `loading="lazy" onerror="this.closest('figure').remove()">` +
          (b.caption ? `<figcaption>${esc(b.caption)}</figcaption>` : '') +
          `</figure>`
        );
      }
      if (b.kind === 'table') {
        const head = (b.head || []).length
          ? `<thead><tr>${(b.head || [])
              .map((c) => `<th>${esc(c || '')}</th>`)
              .join('')}</tr></thead>`
          : '';
        const body = (b.rows || [])
          .map((r) => `<tr>${(r || []).map(cell).join('')}</tr>`)
          .join('');
        return `<table class="irabl-tbl">${head}<tbody>${body}</tbody></table>`;
      }
      return `<p>${esc(b.text || '')}</p>`;
    })
    .join('');
}

/**
 * The documents a component designator on a diagram opens.
 *
 * A designator is a structured field, not a name: the extract indexes each
 * location, connector and pin-assignment document under the designator its
 * own identifier declares (EBO-EBO-E46_EB6217B is designator B6217) and the
 * ones its title lists, which for an installation location IS its designator
 * list. So this is a lookup in the tool's own index, never a word match.
 * Several revisions of the same document can carry one designator; they are
 * offered in the order the extract stored them, newest identifier last, and
 * the first is what a click opens.
 * @param {string} chassis - the development code
 * @param {string} designator - what the clicked anchor carried
 * @returns {Promise<object[]>} the documents, installation location first
 */
async function istaWiringForDesignator(chassis, designator) {
  const key = String(designator || '')
    .trim()
    .toUpperCase();
  if (!key) return [];
  const index = await istaWiringIndex(chassis);
  const hits = (index && index.designators && index.designators[key]) || [];
  const order = ['location', 'connector', 'pinout'];
  const kept = await istaWiringValid(chassis, hits);
  return kept
    .slice()
    .sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
}

/**
 * The car's facts, in the shape the rule evaluator wants.
 *
 * Two are enough for the component documents: the build date, and which
 * cliques the car's modules answered as. A fact that cannot be established
 * is left out rather than guessed -- the evaluator is three-valued, so a
 * missing fact makes a leaf undecidable and the document is KEPT. Narrowing
 * on a guess would hide the right document; keeping one document too many
 * only shows an extra tab.
 * @param {string} chassis - the development code
 * @returns {Promise<object>} facts for techDataRuleApplies
 */
/**
 * Every word of the order a validity rule's SA leaf may name.
 *
 * The tool's hasSA searches the order's SA codes, its E words and its HO
 * words alike, so all three are kept on the car; a coding-key car has only
 * the codes.
 * @param {object|null} got - readIdentityCodes output
 * @returns {string[]} the words, upper-cased, without duplicates
 */
function istaOrderWords(got) {
  const fa = (got && got.fa) || null;
  const words = [
    ...((got && got.codes) || []),
    ...((fa && fa.ewort) || []),
    ...((fa && fa.howort) || []),
  ]
    .map((w) =>
      String(w || '')
        .trim()
        .toUpperCase()
    )
    .filter((w, i, a) => w && a.indexOf(w) === i);
  return words;
}

async function istaWiringFacts(chassis) {
  // the one description of the car every gate evaluates against: its
  // identification level, build date, order codes, product type and the
  // modules it answered as (the ECU-clique leaves read those through the
  // rule tables, the way the tool's own evaluator does)
  const car = istaState.car || null;
  return typeof techDataVehicleFacts === 'function'
    ? await techDataVehicleFacts(car, chassis)
    : {};
}

/**
 * The documents whose validity rule holds for this car.
 *
 * THE CHASSIS TEST IS NOT THE WHOLE RULE, and this is where that shows. The
 * extract already dropped documents that belong to another series, but a
 * component that changed across the model run keeps one document per
 * variant: A11's pin assignment has three, split by build date and by
 * whether the car carries automatic climate control (ihka46*) or the basic
 * heating control (ihkr46). All three are valid E46 documents, so all three
 * arrived, and the user saw three identically-titled tabs with no way to
 * tell which described the car in front of them.
 * @param {string} chassis - the development code
 * @param {object[]} docs - candidates from the designator index
 * @returns {Promise<object[]>} those that apply, or all of them when the
 *   facts cannot decide
 */
async function istaWiringValid(chassis, docs) {
  const list = docs || [];
  if (list.length < 2 || !list.some((d) => d && d.rule)) return list;
  if (
    typeof techDataRuleApplies !== 'function' ||
    typeof techDataCarKeys !== 'function'
  )
    return list;
  const facts = await istaWiringFacts(chassis);
  // the chassis characteristics the rule's `eq` leaves test. techdata builds
  // these from the VIN's type key, and without them every rule is false --
  // an empty set is not "unknown", it is "the car has no characteristics"
  const keys = await istaProbe(() => techDataCarKeys(istaState.car, chassis));
  const ids = (keys && keys.ids) || null;
  if (!ids || !ids.size) return list;
  const kept = list.filter((d) => techDataRuleApplies(d && d.rule, ids, facts));
  // never narrow to nothing: a car whose facts contradict every revision is
  // better served by the whole set than by an empty pane
  return kept.length ? kept : list;
}

/**
 * Bind the designator anchors a diagram carries.
 *
 * The tool's own schematics name the component in the anchor itself
 * (href="X6254"), so the designator is read off the link rather than parsed
 * out of prose. An anchor whose designator has no document in this chassis
 * is left inert instead of being drawn as a dead link.
 * @param {HTMLElement} box - the pane holding the drawing
 * @param {string} chassis - the development code
 * @param {Function} open - (designator, docs) => void, on a click
 * @returns {Promise<number>} how many anchors were bound
 */
async function istaWiringBindDesignators(box, chassis, open) {
  const svg = box && box.querySelector('.irabl-svg svg');
  if (!svg) return 0;
  const index = await istaWiringIndex(chassis);
  const table = (index && index.designators) || {};
  let bound = 0;
  svg.querySelectorAll('a').forEach((a) => {
    const raw =
      a.getAttribute('href') ||
      a.getAttribute('xlink:href') ||
      a.getAttribute('target') ||
      '';
    const key = String(raw).trim().toUpperCase();
    if (!key || !table[key]) return;
    bound += 1;
    a.classList.add('irabl-desig');
    a.dataset.desig = key;
    a.setAttribute('href', '#');
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      open(key);
    });
  });
  return bound;
}

/**
 * Say, in the tool's own page, that a plan row's module does not ship.
 * @param {object} row - the picked plan row
 * @returns {void}
 */
function istaOpenPlanNote(row) {
  if (typeof openModal !== 'function') return;
  const { overlay, close } = openModal(
    `<div class="modal irdoc" role="dialog" aria-modal="true">` +
      `<div class="irdoc-title">${esc(row.title || row.id)}</div>` +
      `<div class="irdoc-body"><p>This test module is not in this build. ` +
      `Its recovered procedure ships under data/ista/abl/ ` +
      `(${esc(row.id || 'no identifier')}).</p></div>` +
      `<div class="modal-actions">` +
      `<button type="button" class="btn irdoc-close">Close</button>` +
      `</div></div>`
  );
  overlay.querySelector('.irdoc-close').onclick = () => close();
}
