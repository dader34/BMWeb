// ETK parts catalogue, from BMW's own data. tools/etk_import.py packs one .etk
// archive per car: tree.json (assembly groups -> diagrams -> parts) plus the
// exploded-view images (jpg/png). Same archive shape and loading path as the
// .wiring bundles -- fflate inflates, and the offline export inlines base64.

const ETK_CACHE = new Map(); // chassis -> { tree, files: Map(name -> u8) }
let etkChassisIds = null; // memoised probe of which cars have data

// The .etk bundles are 6.4 GB across 246 cars -- too big to ship in the Pages
// repo. They live in a Hugging Face dataset and stream in at runtime (HF's
// resolve URLs reflect the request Origin, so cross-origin fetch from
// bmweb.danner.ink is CORS-clean -- verified). Local data/etk/ wins when
// present (dev + the offline single-file export), else fall back to HF.
const ETK_HF_BASE =
  'https://huggingface.co/datasets/CraigFf/bmweb-etk/resolve/main/';

function etkBundleUrl(id, local) {
  if (local) {
    const base = typeof WEB_BASE === 'string' ? WEB_BASE : '';
    return `${base}/data/etk/${id}.etk`;
  }
  return `${ETK_HF_BASE}${id}.etk`;
}

// onProgress(loaded, total) is called as the bundle downloads; total is 0 when
// the server sends no Content-Length (then the caller shows an indeterminate bar).
async function loadEtk(chassisId, onProgress) {
  const id = chassisId.toUpperCase();
  if (ETK_CACHE.has(id)) return ETK_CACHE.get(id);
  let bytes;
  const inline =
    typeof BMACW_ETK === 'object' && BMACW_ETK ? BMACW_ETK[id] : null;
  if (inline) {
    const bin = atob(inline);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    const real =
      typeof webRealFetch === 'function'
        ? webRealFetch
        : window.fetch.bind(window);
    // try local first, then HF
    let r = await real(etkBundleUrl(id, true)).catch(() => null);
    if (!r || !r.ok) r = await real(etkBundleUrl(id, false)).catch(() => null);
    if (!r || !r.ok) throw new Error(`no parts data for ${dispChassis(id)}`);
    bytes = await readWithProgress(r, onProgress);
  }
  const unzipped = fflate.unzipSync(bytes);
  const tree = JSON.parse(new TextDecoder().decode(unzipped['tree.json']));
  const files = new Map(Object.entries(unzipped));
  const data = { tree, files };
  ETK_CACHE.set(id, data);
  return data;
}

// Stream a fetch Response into a Uint8Array, calling onProgress(loaded,total).
// Falls back to arrayBuffer() when the body isn't a readable stream.
async function readWithProgress(resp, onProgress) {
  const total = Number(resp.headers.get('content-length')) || 0;
  if (!resp.body || !resp.body.getReader || !onProgress) {
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (onProgress) onProgress(buf.length, buf.length);
    return buf;
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// Does this chassis have an .etk bundle? HEAD probe (local then HF), or the
// inline check. Cheap enough to run per car when building the picker.
async function hasEtk(chassisId) {
  const id = chassisId.toUpperCase();
  if (typeof BMACW_ETK === 'object' && BMACW_ETK) return !!BMACW_ETK[id];
  const real =
    typeof webRealFetch === 'function'
      ? webRealFetch
      : window.fetch.bind(window);
  const probe = async (local) => {
    try {
      const r = await real(etkBundleUrl(id, local), { method: 'HEAD' });
      return r.ok;
    } catch (e) {
      return false;
    }
  };
  return (await probe(true)) || (await probe(false));
}

// The Apps hub asks these two: is ETK in this build at all, and open it.
function etkHasData() {
  if (typeof BMACW_ETK === 'object' && BMACW_ETK)
    return Object.keys(BMACW_ETK).length > 0;
  return true; // web build: assume the data/ tree may carry it; the picker probes per car
}

async function etkChassisList() {
  if (etkChassisIds) return etkChassisIds;
  // one index.json lists every chassis that has a bundle -- read it instead of
  // HEAD-probing all ~135 cars (that would be hundreds of requests to HF).
  if (typeof BMACW_ETK === 'object' && BMACW_ETK) {
    etkChassisIds = Object.keys(BMACW_ETK).sort();
    return etkChassisIds;
  }
  const real =
    typeof webRealFetch === 'function'
      ? webRealFetch
      : window.fetch.bind(window);
  const tryIndex = async (local) => {
    try {
      const url = local
        ? etkBundleUrl('index', true).replace('.etk', '.json')
        : `${ETK_HF_BASE}index.json`;
      const r = await real(url);
      return r.ok ? await r.json() : null;
    } catch (e) {
      return null;
    }
  };
  const idx = (await tryIndex(true)) || (await tryIndex(false));
  etkChassisIds = Array.isArray(idx) ? idx.slice().sort() : [];
  return etkChassisIds;
}

// A styled dropdown that mimics the <select> interface the drill-down uses:
// exposes .value (option index as string, '' for none), .selectedIndex,
// .disabled, .options-like via setOptions(), and fires 'change'. Keeps the
// cascade code unchanged while ditching the unstyleable native list.
function makeSelect(placeholder) {
  const root = document.createElement('div');
  root.className = 'etk-sel';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'etk-sel-btn';
  btn.innerHTML = `<span class="etk-sel-cur"></span><span class="etk-sel-caret">▾</span>`;
  const menu = document.createElement('div');
  menu.className = 'etk-sel-menu';
  menu.hidden = true;
  root.appendChild(btn);
  root.appendChild(menu);
  const cur = btn.querySelector('.etk-sel-cur');

  let items = []; // display strings
  let value = ''; // '' (placeholder) or a 0-based index string of an item
  let ph = placeholder || 'Select…';
  let disabled = false;
  let outside = null;

  function label() {
    return value === '' ? ph : items[+value];
  }
  function paint() {
    cur.textContent = label();
    cur.classList.toggle('etk-sel-ph', value === '');
  }
  function renderMenu() {
    menu.innerHTML = '';
    items.forEach((t, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'etk-sel-opt' + (value === String(i) ? ' active' : '');
      b.textContent = t;
      b.onclick = (e) => {
        e.stopPropagation();
        value = String(i);
        paint();
        close();
        fire();
      };
      menu.appendChild(b);
    });
  }
  function open() {
    if (disabled || !items.length) return;
    renderMenu();
    menu.hidden = false;
    root.classList.add('etk-sel-open');
    setTimeout(() => {
      outside = (e) => {
        if (!root.contains(e.target)) close();
      };
      document.addEventListener('click', outside);
    }, 0);
  }
  function close() {
    menu.hidden = true;
    root.classList.remove('etk-sel-open');
    if (outside) {
      document.removeEventListener('click', outside);
      outside = null;
    }
  }
  // fire both the event (for addEventListener) and the .onchange property the
  // cascade sets, since a div's onchange isn't auto-wired like a <select>'s.
  function fire() {
    root.dispatchEvent(new Event('change'));
    if (typeof root.onchange === 'function') root.onchange(new Event('change'));
  }

  btn.onclick = (e) => {
    e.stopPropagation();
    menu.hidden ? open() : close();
  };

  // the <select>-ish surface the cascade code uses. Values are 0-based item
  // indices ('' = none). selectedIndex mirrors native semantics (0 = the
  // placeholder, 1..N = items) so the cascade's `sel.selectedIndex = 1` lines
  // still auto-pick the first real item.
  Object.defineProperties(root, {
    value: {
      get: () => value,
      set: (v) => {
        value = v === '' ? '' : String(v);
        paint();
      },
    },
    disabled: {
      get: () => disabled,
      set: (d) => {
        disabled = !!d;
        root.classList.toggle('etk-sel-disabled', disabled);
        if (d) close();
      },
    },
    selectedIndex: {
      get: () => (value === '' ? 0 : +value + 1),
      set: (i) => {
        value = i && i >= 1 ? String(i - 1) : '';
        paint();
      },
    },
    options: {
      get: () => [
        { textContent: ph },
        ...items.map((t) => ({ textContent: t })),
      ],
    },
  });
  // setOptions replaces the innerHTML-style population the cascade did via opt()
  root.setOptions = (arr, placeholderText) => {
    if (placeholderText != null) ph = placeholderText;
    items = arr.slice();
    value = '';
    paint();
    close();
  };
  root.setDisabledEmpty = () => {
    items = [];
    value = '';
    paint();
  };
  root.openMenu = () => open();
  paint();
  return root;
}

// ---- vehicle attribute tree (the ETK-style drill-down) --------------------
// vehicles.json: chassis -> body -> model -> [[steer,gear,year,mospid], ...].
// Small (~200 KB), ships in the repo (local), with an HF fallback.
let etkVehicles = null;
async function loadVehicles() {
  if (etkVehicles) return etkVehicles;
  const real =
    typeof webRealFetch === 'function'
      ? webRealFetch
      : window.fetch.bind(window);
  const base = typeof WEB_BASE === 'string' ? WEB_BASE : '';
  const urls = [
    `${base}/data/etk/vehicles.json`,
    `${ETK_HF_BASE}vehicles.json`,
  ];
  let r = null;
  for (const u of urls) {
    r = await real(u).catch(() => null);
    if (r && r.ok) break;
  }
  if (!r || !r.ok) throw new Error('vehicle data not available');
  etkVehicles = await r.json();
  return etkVehicles;
}

// thumbs.json: which <chassis>_<body> car photos shipped (ETK's Vehicle
// Identification images, extracted from w_baureihe_kar_thb). Local first,
// then the Hugging Face dataset (where the rest of the ETK data lives).
// Non-fatal: the drill-down just keeps its silhouette if the set isn't there.
let etkThumbs = null;
let etkThumbsBase = ''; // the base URL thumbs.json resolved from
async function loadEtkThumbs() {
  if (etkThumbs) return etkThumbs;
  const real =
    typeof webRealFetch === 'function'
      ? webRealFetch
      : window.fetch.bind(window);
  const base = typeof WEB_BASE === 'string' ? WEB_BASE : '';
  const bases = [`${base}/data/etk/thumbs/`, `${ETK_HF_BASE}thumbs/`];
  for (const b of bases) {
    const r = await real(`${b}thumbs.json`).catch(() => null);
    if (r && r.ok) {
      etkThumbs = await r.json();
      etkThumbsBase = b;
      return etkThumbs;
    }
  }
  etkThumbs = {};
  return etkThumbs;
}

// ---- VIN decoder ----------------------------------------------------------
// A BMW VIN's last 7 characters are the sequential production number. vin-index
// maps each production-number range to a vehicle, so we can resolve a VIN to
// its exact chassis + variant, then jump into that catalogue pre-filtered.
let etkVinIndex = null; // { variants:[[chassis,mospid,model,body,motor,steer]], ranges:[[von,bis,vidx,prod]] }

async function loadVinIndex(onProgress) {
  if (etkVinIndex) return etkVinIndex;
  const real =
    typeof webRealFetch === 'function'
      ? webRealFetch
      : window.fetch.bind(window);
  const base = typeof WEB_BASE === 'string' ? WEB_BASE : '';
  const urls = [
    `${base}/data/etk/vin-index.json.gz`,
    `${ETK_HF_BASE}vin-index.json.gz`,
  ];
  let r = null;
  for (const u of urls) {
    r = await real(u).catch(() => null);
    if (r && r.ok) break;
  }
  if (!r || !r.ok) throw new Error('VIN data not available');
  const bytes = await readWithProgress(r, onProgress);
  // the file is gzip; fflate ungzips it
  const json = fflate.strFromU8(fflate.gunzipSync(bytes));
  etkVinIndex = JSON.parse(json);
  return etkVinIndex;
}

// Resolve a VIN (or bare 7-char production number) -> { chassis, mospidIdx info }.
// Returns null if not found. The ranges are sorted by `von`, so binary-search.
function decodeVin(idx, vinRaw) {
  const vin = String(vinRaw || '')
    .trim()
    .toUpperCase()
    .replace(/\s/g, '');
  // last 7 chars are the production number; a bare 7-char code is accepted too
  const pn = vin.length >= 7 ? vin.slice(-7) : vin.padStart(7, '0');
  const R = idx.ranges;
  let lo = 0,
    hi = R.length - 1,
    hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [von, bis] = R[mid];
    if (pn < von) hi = mid - 1;
    else if (pn > bis) lo = mid + 1;
    else {
      hit = mid;
      break;
    }
  }
  if (hit < 0) return null;
  const [von, bis, vi, prod] = R[hit];
  const v = idx.variants[vi]; // [chassis,mospid,model,body,motor,steer]
  return {
    pn,
    chassis: v[0],
    mospid: v[1],
    model: v[2],
    body: v[3],
    motor: v[4],
    steer: v[5],
    prod,
  };
}

// An image ref in the tree ("319345.jpg") -> a blob URL the <img> can show.
const ETK_IMG_URLS = new Map();
function etkImageUrl(data, ref) {
  if (!ref) return null;
  const key = data.tree.chassis + '/' + ref;
  if (ETK_IMG_URLS.has(key)) return ETK_IMG_URLS.get(key);
  const bytes = data.files.get(`img/${ref}`);
  if (!bytes) return null;
  const ext = ref.split('.').pop().toLowerCase();
  const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  ETK_IMG_URLS.set(key, url);
  return url;
}

async function showEtk() {
  lastScreen = showEtk;
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: 'Apps', fn: showApps },
    { label: 'Parts Catalogue' },
  ]);
  document.body.classList.add('apps-section');
  sbLeft.textContent = 'parts';
  view.innerHTML = head(
    'ETK',
    'Parts Catalogue',
    "BMW's own parts diagrams. Pick a vehicle to browse its catalogue."
  );
  setActions([
    {
      key: 'Escape',
      keyLabel: 'Esc',
      label: 'Back',
      kind: 'back',
      fn: showApps,
    },
  ]);

  // VIN decoder entry: a card (like the Apps hub cards) that opens the decoder
  // page -- enter a VIN there and jump to that exact vehicle's parts.
  const vinCard = document.createElement('button');
  vinCard.className = 'lookup-entry etk-vin-entry';
  vinCard.innerHTML = `
    <span class="lookup-entry-icon">⌗</span>
    <span class="lookup-entry-text">
      <span class="lookup-entry-title">VIN Decoder</span>
      <span class="lookup-entry-desc">Enter a VIN to jump straight to your exact vehicle</span>
    </span>
    <span class="lookup-entry-arrow">→</span>`;
  vinCard.onclick = () => showVinDecoder();
  view.appendChild(vinCard);

  const grid = document.createElement('div');
  grid.className = 'chassis-grid stagger';
  const wait = document.createElement('div');
  wait.className = 'wiring-loading';
  wait.innerHTML = `<span class="wiring-spinner"></span><span>Looking for vehicles with parts data…</span>`;
  view.appendChild(wait);
  view.appendChild(grid);

  const ids = await etkChassisList();
  wait.remove();
  if (!ids.length) {
    const note = document.createElement('div');
    note.className = 'empty wiring-absent';
    note.innerHTML = `
      <div class="empty-big">No parts data in this build</div>
      <div>The catalogue comes from BMW's ETK, a separate import not part of this repository.</div>
      <div style="font-size:12px;color:var(--ink-faint)">Offline, it is in the
           <em>offline-complete</em> build linked from each release; from source,
           <code>tools/etk_import.py --db etk.sqlite --out data/etk</code>.</div>`;
    view.appendChild(note);
    return;
  }
  ids.forEach((id) => {
    const tag = (typeof CHASSIS_TAG === 'object' && CHASSIS_TAG[id]) || 'BMW';
    const card = document.createElement('button');
    card.className = 'chassis-card';
    card.innerHTML = `
      <div class="chassis-code">${esc(dispChassis(id))}</div>
      <div class="chassis-tag">${esc(tag)}</div>
      <div class="chassis-arrow">→</div>`;
    card.onclick = () => showEtkChassis(id);
    grid.appendChild(card);
  });
  stagger(grid, 22);
  sbRight.textContent = `${ids.length} chassis`;
  setActions([
    ...ids.slice(0, 9).map((id, i) => ({
      key: String(i + 1),
      label: dispChassis(id),
      fn: () => showEtkChassis(id),
    })),
    {
      key: 'Escape',
      keyLabel: 'Esc',
      label: 'Back',
      kind: 'back',
      fn: showApps,
    },
  ]);
}

// vehicles.json keys are BMW's internal ETK series codes. Most are the
// familiar chassis E-numbers (E46, F30, G20), but a tail of them are raw
// internal codes for motorcycles (K/R bikes), the classic '02 range and a few
// oddments (114, 2471, R56, MOSP...). Alphabetical sort buries the cars the
// user is actually after under those codes, so we bucket by kind: modern cars
// first (E/F/G/I/U + digits), then Minis (R5x/F5x/F6x), then everything else.
function seriesRank(code) {
  if (/^[EFGIU]\d/.test(code)) {
    // BMW car chassis: E46, F30, G20...
    const era = { E: 0, F: 1, G: 2, I: 3, U: 4 }[code[0]];
    const num = parseInt(code.slice(1), 10) || 0;
    return [0, era, num, code];
  }
  if (/^(R5|F5|F6)/.test(code)) return [1, 0, 0, code]; // MINI
  return [2, 0, 0, code]; // bikes / classics / internal codes
}
function seriesSort(codes) {
  return codes.slice().sort((a, b) => {
    const ra = seriesRank(a),
      rb = seriesRank(b);
    for (let i = 0; i < ra.length; i++) {
      if (ra[i] < rb[i]) return -1;
      if (ra[i] > rb[i]) return 1;
    }
    return 0;
  });
}

// ETK's Vehicle Identification lists a top-level marketing series ("5'", "X3",
// "MINI"...) which expands to the chassis under it (E60, E61, F10, F18...).
// The internal series codes in vehicles.json don't carry that grouping, so we
// derive it from each chassis's model names: the dominant model prefix names
// the series (5xx -> 5', X3 xx -> X3, "R 1200" -> Moto). This mirrors what a
// user sees on the dealer terminal without needing a hand-kept 296-row table.
function chassisSeries(code, models) {
  // hard overrides where the model prefix is ambiguous or the chassis predates
  // the numbering scheme
  const HARD = {
    E52: 'Z',
    E26: 'M',
    E72: 'X6',
    E169: 'Moto',
    E3: 'Classic',
    E9: 'Classic',
  };
  if (HARD[code]) return HARD[code];
  if (/^I\d/.test(code)) return 'i'; // i3 / i8
  if (/^(R5|R13|R56|R57|R58|R59|F5|F6)/.test(code)) return 'MINI';
  const list = [...models];
  const joined = list.join(' ');
  // motorcycles: R-/K-/F-/G-/C-prefixed engine names, or classic 3-digit bikes
  const bike = list.filter(
    (m) =>
      /^[RKC]\s?\d/.test(m.trim()) ||
      /^F \d{3}/.test(m.trim()) ||
      /^G \d{3}/.test(m.trim())
  ).length;
  if (bike > list.length / 2) return 'Moto';
  const tally = {};
  for (const m of list) {
    const t = m.trim();
    let key = null;
    const x = t.match(/^(X\d)/); // X3, X5
    const z = /^Z\d/.test(t); // Z3, Z4 -> one "Z" series
    const mm = t.match(/^M(\d)\b/); // M3, M5
    if (x) key = x[1];
    else if (z) key = 'Z';
    else if (mm) key = 'M';
    else if (/^\d/.test(t)) key = t[0] + "'"; // 5xx -> 5'
    if (key) tally[key] = (tally[key] || 0) + 1;
  }
  let best = null,
    n = -1;
  for (const k in tally)
    if (tally[k] > n) {
      n = tally[k];
      best = k;
    }
  return best || 'Other';
}

// order the marketing-series buckets the way ETK does: number series, then X,
// then Z, M, i, MINI, motorcycles, classics/other.
function seriesGroupRank(s) {
  if (/^\d'$/.test(s)) return [0, parseInt(s, 10)];
  if (/^X\d$/.test(s)) return [1, parseInt(s.slice(1), 10)];
  if (s === 'Z') return [2, 0];
  if (s === 'M') return [3, 0];
  if (s === 'i') return [4, 0];
  if (s === 'MINI') return [5, 0];
  if (s === 'Moto') return [6, 0];
  return [7, 0];
}

// group a set of chassis codes into { series -> [chassis...] }, each sorted
function groupBySeries(veh) {
  const groups = {};
  for (const code of Object.keys(veh)) {
    const models = new Set();
    for (const body in veh[code])
      for (const m in veh[code][body]) models.add(m);
    const s = chassisSeries(code, models);
    (groups[s] = groups[s] || []).push(code);
  }
  const order = Object.keys(groups).sort((a, b) => {
    const ra = seriesGroupRank(a),
      rb = seriesGroupRank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || (a < b ? -1 : 1);
  });
  for (const s of order) groups[s] = seriesSort(groups[s]);
  return { order, groups };
}

// The VIN Decoder page: enter a VIN (or its last 7) and it resolves to the
// exact vehicle, then opens that catalogue pre-filtered.
//
// `opts` retargets the SAME screen for other sections (the wiring picker reuses
// it 1:1 so the two never drift). Defaults to Parts:
//   { title, subtitle, crumbs:[...], back:fn,       -- chrome
//     onResolve(hit),                               -- what the go/open does
//     resolvable(chassis):bool|Promise, unavailable(disp):string }
//     -- gate + message for a decoded chassis the section can't open
function showVinDecoder(opts) {
  opts = opts || {};
  const onResolve = opts.onResolve || openDecoded; // default: open the parts catalogue
  const backFn = opts.back || showEtk;
  lastScreen = () => showVinDecoder(opts);
  setCrumbs(
    opts.crumbs || [
      { label: 'Vehicles', fn: showChassis },
      { label: 'Apps', fn: showApps },
      { label: 'Parts', fn: showEtk },
      { label: 'VIN Decoder' },
    ]
  );
  document.body.classList.add('apps-section');
  sbLeft.textContent = 'vin decoder';
  view.innerHTML = head(
    opts.eyebrow || 'ETK',
    opts.title || 'Vehicle Identification',
    opts.subtitle ||
      'Enter your VIN, or identify your vehicle by series, body and model.'
  );
  setActions([
    { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: backFn },
  ]);

  // Two columns: the VIN box + attributes selector on the left, a full-height
  // saved-vehicles panel down the right.
  const layout = document.createElement('div');
  layout.className = 'etk-vin-layout';
  const leftCol = document.createElement('div');
  leftCol.className = 'etk-vin-left';
  layout.appendChild(leftCol);

  // ETK's top group box: "Identification by VIN number" — a labelled input
  // with the go-arrow and a Save button at the right, inside an etched fieldset.
  const card = document.createElement('fieldset');
  card.className = 'etk-fs etk-fs-vin';
  card.innerHTML = `
    <legend>Identification by VIN number</legend>
    <div class="etk-vin-row">
      <span class="etk-vin-label">VIN number:</span>
      <input class="etk-vin-input" type="text" maxlength="17" spellcheck="false"
             autocapitalize="characters" placeholder="WBA… or last 7 chars">
      <button class="etk-vin-go" type="button" aria-label="Decode VIN">→</button>
      <button class="etk-vin-save" type="button"
              title="Decode and save this VIN">Save</button>
    </div>
    <div class="etk-vin-hint">A BMW VIN's last 7 characters are the production
      number. Paste the full VIN or just those 7.</div>
    <div class="etk-vin-result" hidden></div>`;
  leftCol.appendChild(card);

  // Saved vehicles panel: a full-height column down the right, alongside both
  // the VIN box and the attributes selector. Each entry shows the car above its
  // VIN and opens that vehicle in this section. Persisted in Settings under
  // opts.savedKey (sections keep their own list).
  const SAVED_KEY = opts.savedKey || 'savedVins';
  const savedPanel = document.createElement('div');
  savedPanel.className = 'etk-saved-panel';
  layout.appendChild(savedPanel);

  view.appendChild(layout);

  const readSaved = () => {
    if (typeof Settings !== 'object' || !Settings.get) return [];
    const v = Settings.get(SAVED_KEY, []);
    return Array.isArray(v) ? v : [];
  };
  const writeSaved = (list) => {
    if (typeof Settings === 'object' && Settings.set)
      Settings.set(SAVED_KEY, list.slice(0, 12));
  };
  const addSaved = (entry) => {
    const vin = String(entry.vin || '').toUpperCase();
    if (!vin) return;
    const rest = readSaved().filter((e) => String(e.vin).toUpperCase() !== vin);
    writeSaved([{ ...entry, vin }, ...rest]);
    renderSaved();
  };
  const delSaved = (vin) => {
    const V = String(vin).toUpperCase();
    writeSaved(readSaved().filter((e) => String(e.vin).toUpperCase() !== V));
    renderSaved();
  };
  function renderSaved() {
    const list = readSaved();
    savedPanel.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'etk-saved-head';
    head.textContent = 'Saved vehicles';
    savedPanel.appendChild(head);
    if (!list.length) {
      const e = document.createElement('div');
      e.className = 'etk-saved-empty';
      e.textContent = 'Decode a VIN and press Save to keep it here.';
      savedPanel.appendChild(e);
      return;
    }
    list.forEach((it) => {
      const row = document.createElement('div');
      row.className = 'etk-saved-row';
      const disp = it.disp || dispChassis(it.chassis);
      const meta = [disp, it.bits, it.date].filter(Boolean).join(' · ');
      row.innerHTML = `
        <button type="button" class="etk-saved-open" title="Open ${esc(disp)}">
          <span class="etk-saved-veh">${esc(meta)}</span>
          <span class="etk-saved-vin">${esc(it.vin)}</span>
        </button>
        <button type="button" class="etk-saved-del" title="Remove" aria-label="Remove">✕</button>`;
      row.querySelector('.etk-saved-open').onclick = () =>
        onResolve({
          chassis: it.chassis,
          model: it.model,
          body: it.body,
          motor: it.motor,
          steer: it.steer,
          prod: it.prod,
          vin: it.vin,
        });
      row.querySelector('.etk-saved-del').onclick = () => delSaved(it.vin);
      savedPanel.appendChild(row);
    });
  }
  renderSaved();

  const input = card.querySelector('.etk-vin-input');
  const go = card.querySelector('.etk-vin-go');
  const saveBtn = card.querySelector('.etk-vin-save');
  const result = card.querySelector('.etk-vin-result');
  input.focus();

  async function decode(alsoSave) {
    const vin = input.value.trim();
    if (vin.length < 7) {
      result.hidden = false;
      result.className = 'etk-vin-result etk-vin-err';
      result.textContent =
        'Enter at least the 7-character production number (or a full VIN).';
      return;
    }
    result.hidden = false;
    result.className = 'etk-vin-result';
    result.innerHTML = `<span class="wiring-spinner"></span> Looking up ${esc(vin.toUpperCase())}…`;
    go.disabled = true;
    try {
      const idx = await loadVinIndex((loaded, total) => {
        if (total > 0) {
          const pct = Math.round((loaded / total) * 100);
          result.innerHTML = `<span class="wiring-spinner"></span> Loading VIN data… ${pct}%`;
        }
      });
      const hit = decodeVin(idx, vin);
      go.disabled = false;
      if (!hit) {
        result.className = 'etk-vin-result etk-vin-err';
        result.textContent = `No vehicle found for “${vin.toUpperCase()}”. Check the VIN, or pick a chassis on the previous screen.`;
        return;
      }
      hit.vin = vin.toUpperCase();
      const bits = [
        hit.model,
        bodyLabel(hit.body),
        hit.motor,
        hit.steer === 'R' ? 'RHD' : hit.steer === 'L' ? 'LHD' : '',
      ]
        .filter(Boolean)
        .join(' · ');
      const dateStr =
        hit.prod && String(hit.prod).length >= 6
          ? ` · ${String(hit.prod).slice(0, 4)}-${String(hit.prod).slice(4, 6)}`
          : '';
      const disp = dispChassis(hit.chassis);
      // Save was pressed: remember this vehicle (car above the VIN in the panel)
      if (alsoSave) {
        addSaved({
          vin: hit.vin,
          chassis: hit.chassis,
          disp,
          bits,
          date: dateStr.replace(/^ · /, ''),
          model: hit.model,
          body: hit.body,
          motor: hit.motor,
          steer: hit.steer,
          prod: hit.prod,
        });
      }
      // the section may not be able to open every decoded chassis (wiring ships
      // fewer than the VIN index covers): gate, and say what it found either way
      const canOpen = opts.resolvable
        ? await opts.resolvable(hit.chassis)
        : true;
      result.className = 'etk-vin-result etk-vin-ok';
      if (canOpen) {
        result.innerHTML = `
          <div class="etk-vin-veh"><b>${esc(disp)}</b> ${esc(bits)}${esc(dateStr)}</div>
          <button class="etk-vin-open" type="button">${esc(opts.openLabel ? opts.openLabel(disp) : `Open ${disp} parts →`)}</button>`;
        result.querySelector('.etk-vin-open').onclick = () => onResolve(hit);
      } else {
        result.innerHTML = `
          <div class="etk-vin-veh"><b>${esc(disp)}</b> ${esc(bits)}${esc(dateStr)}</div>
          <div class="etk-vin-note">${esc(opts.unavailable ? opts.unavailable(disp) : `Not available for ${disp}.`)}</div>`;
      }
    } catch (e) {
      go.disabled = false;
      result.className = 'etk-vin-result etk-vin-err';
      result.textContent = String(e.message || e);
    }
  }

  go.onclick = () => decode(false);
  saveBtn.onclick = () => decode(true); // decode + remember
  input.onkeydown = (e) => {
    if (e.key === 'Enter') decode(false);
  };

  // ---- identify by attributes: ETK's Vehicle Identification, 1:1 -----------
  // The terminal's lower group box: a Brand / Prod. type / Catalogue filter
  // row, then [Series* | chassis] [Body* + car image] [Model* with Steering /
  // Gearbox / Year / Month in a 2x2 beneath it], go-arrow bottom right.
  const idCard = document.createElement('fieldset');
  idCard.className = 'etk-fs etk-fs-attr';
  const idLegend = document.createElement('legend');
  idLegend.textContent = 'Identification by attributes';
  idCard.appendChild(idLegend);

  // filter row: Brand dropdown + Auto/Moto radios + Main/Classic radios.
  // These narrow which series show, same as the terminal's selectors.
  const filters = document.createElement('div');
  filters.className = 'etk-idfilters';
  filters.innerHTML = `
    <div class="etk-idfilter etk-idfilter-brand"><span class="etk-idflabel">Brand</span></div>
    <div class="etk-idfilter"><span class="etk-idflabel">Prod. type</span>
      <label class="etk-idradio"><input type="radio" name="etk-ptype" value="auto" checked> Auto</label>
      <label class="etk-idradio"><input type="radio" name="etk-ptype" value="moto"> Moto</label>
    </div>
    <div class="etk-idfilter"><span class="etk-idflabel">Catalogue</span>
      <label class="etk-idradio"><input type="radio" name="etk-scope" value="main" checked> Main catalogue</label>
      <label class="etk-idradio"><input type="radio" name="etk-scope" value="classic"> BMW Classic</label>
    </div>
    <span class="etk-idreq">* required attributes</span>`;
  const selBrand = makeSelect('BMW');
  selBrand.setOptions(['BMW', 'MINI'], 'BMW');
  selBrand.selectedIndex = 1; // BMW preselected
  filters.querySelector('.etk-idfilter-brand').appendChild(selBrand);
  idCard.appendChild(filters);

  // a scrolling single-select list box (ETK's <select size=N> panes)
  function listBox() {
    const box = document.createElement('div');
    box.className = 'etk-lb';
    box.tabIndex = 0;
    let items = [],
      value = -1; // value = selected index, -1 = none
    box._onpick = null;
    function render() {
      box.innerHTML = '';
      items.forEach((it, i) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'etk-lb-row' + (i === value ? ' active' : '');
        row.textContent = it.label;
        row.onclick = () => {
          value = i;
          render();
          if (i === value) row.scrollIntoView({ block: 'nearest' });
          if (box._onpick) box._onpick(items[i].key, items[i].label);
        };
        box.appendChild(row);
      });
      if (!items.length) {
        const e = document.createElement('div');
        e.className = 'etk-lb-empty';
        e.textContent = '—';
        box.appendChild(e);
      }
    }
    box.setItems = (arr) => {
      items = arr;
      value = -1;
      render();
    };
    box.clear = () => {
      items = [];
      value = -1;
      render();
    };
    box.selected = () => (value >= 0 ? items[value] : null);
    render();
    return box;
  }

  const lbSeries = listBox();
  const lbChassis = listBox();
  const lbBody = listBox();
  const lbModel = listBox();
  const selSteer = makeSelect('All values');
  const selGear = makeSelect('All values');
  const selYear = makeSelect('All values');
  const selMonth = makeSelect('All values');
  [selSteer, selGear, selYear, selMonth].forEach((s) => {
    s.disabled = true;
  });

  // labelled column wrapper (a heading over a list box or dropdown)
  const col = (labelText, el, cls) => {
    const c = document.createElement('div');
    c.className = 'etk-idcol' + (cls ? ' ' + cls : '');
    const l = document.createElement('span');
    l.className = 'etk-idlabel';
    l.textContent = labelText;
    c.append(l, el);
    return c;
  };

  // ETK's positioning: [Series | Chassis] paired on the left, then Body (with a
  // vehicle thumbnail beneath it), then Model on the right with the Steering /
  // Transmission / Year dropdowns tucked underneath the Model column.
  const lists = document.createElement('div');
  lists.className = 'etk-idlists';

  // left block: Series + chassis sitting flush together (ETK labels only the
  // Series pane; the chassis pane is its unlabelled expansion)
  const leftBlock = document.createElement('div');
  leftBlock.className = 'etk-idpair';
  leftBlock.append(
    col('Series*', lbSeries, 'etk-idcol-series'),
    col(' ', lbChassis, 'etk-idcol-chassis')
  );

  // middle block: Body, with the car image beneath it
  const midBlock = document.createElement('div');
  midBlock.className = 'etk-idmid';
  const thumb = document.createElement('div');
  thumb.className = 'etk-idthumb';
  thumb.hidden = true;
  midBlock.append(col('Body*', lbBody), thumb);

  // right block: Model on top, the 2x2 dropdowns beneath it (ETK's Steering |
  // Gearbox on the first row, Year | Month on the second)
  const rightBlock = document.createElement('div');
  rightBlock.className = 'etk-idright';
  const drops = document.createElement('div');
  drops.className = 'etk-iddrops';
  drops.append(
    col('Steering', selSteer),
    col('Gearbox', selGear),
    col('Year', selYear),
    col('Month', selMonth)
  );
  rightBlock.append(col('Model*', lbModel), drops);

  lists.append(leftBlock, midBlock, rightBlock);

  const foot = document.createElement('div');
  foot.className = 'etk-idfoot';
  const idHint = document.createElement('span');
  idHint.className = 'etk-idhint';
  idHint.textContent = 'Loading vehicles…';
  const idOpen = document.createElement('button');
  idOpen.type = 'button';
  idOpen.className = 'etk-vin-go etk-idgo';
  idOpen.hidden = true;
  idOpen.setAttribute('aria-label', 'Open parts catalogue');
  idOpen.textContent = '→';
  foot.append(idHint, idOpen);

  idCard.append(lists, foot);
  leftCol.appendChild(idCard);

  let veh = null; // the loaded vehicles.json
  let grouped = null; // { order, groups } from groupBySeries
  let picked = null; // { chassis, mospid, ... }
  let chassisMaxYear = 0; // newest intro-year anywhere in the chassis --
  // a stand-in for end-of-build, so the Year list
  // can run past the last per-model intro date
  const state = { series: null, chassis: null, body: null, model: null };

  const opt = (sel, items, ph) => sel.setOptions(items, ph);
  // ETK stores gearbox N = "Neutral" on chassis whose catalogue isn't split by
  // transmission (the terminal shows "Neutral" there too, not a blank).
  const gearLabel = (g) =>
    ({ A: 'Automatic', M: 'Manual', N: 'Neutral' })[g] || g || 'Neutral';
  const steerLabel = (s) =>
    ({ L: 'Left-hand drive', R: 'Right-hand drive' })[s] || s;
  const yearOf = (d) => String(d).slice(0, 4);
  const monthOf = (d) => String(d).slice(4, 6);

  function resetDrops() {
    picked = null;
    idOpen.hidden = true;
    [selSteer, selGear, selYear, selMonth].forEach((s) => {
      s.setDisabledEmpty();
      s.disabled = true;
    });
  }

  // ---- the Brand / Prod. type / Catalogue filters narrow the Series pane ----
  // A code is "classic" when it isn't a modern car chassis code (E/F/G/I/U +
  // digits): the raw numeric and letter codes (114, 700, NK, V8...) are the
  // old-timers BMW Classic covers, plus the hard-bucketed Classic group.
  const isClassicCode = (c, s) =>
    s === 'Classic' || s === 'Other' || !/^[EFGIUZ]\d/.test(c); // Z covers the literal Z1/Z3 chassis codes
  function refreshSeries() {
    if (!grouped) return;
    const type = filters.querySelector('input[name="etk-ptype"]:checked').value;
    const scope = filters.querySelector(
      'input[name="etk-scope"]:checked'
    ).value;
    const brand = selBrand.value === '1' ? 'MINI' : 'BMW';
    const out = [];
    for (const s of grouped.order) {
      let codes = grouped.groups[s];
      if (type === 'moto') {
        if (s !== 'Moto') continue;
      } else {
        if (s === 'Moto') continue;
        if (brand === 'MINI') {
          if (s !== 'MINI') continue;
        } else {
          if (s === 'MINI') continue;
          codes = codes.filter(
            (c) => isClassicCode(c, s) === (scope === 'classic')
          );
        }
      }
      if (codes.length) out.push({ series: s, codes });
    }
    state.series = state.chassis = state.body = state.model = null;
    state.codesBySeries = Object.fromEntries(
      out.map((o) => [o.series, o.codes])
    );
    lbChassis.clear();
    lbBody.clear();
    lbModel.clear();
    resetDrops();
    thumb.hidden = true;
    lbSeries.setItems(out.map((o) => ({ key: o.series, label: o.series })));
    idHint.textContent = 'Pick a series to begin.';
  }
  filters.querySelectorAll('input[type="radio"]').forEach((r) => {
    r.onchange = refreshSeries;
  });
  selBrand.onchange = refreshSeries;

  // Series picked -> fill Chassis
  lbSeries._onpick = (series) => {
    state.series = series;
    state.chassis = state.body = state.model = null;
    lbBody.clear();
    lbModel.clear();
    resetDrops();
    thumb.hidden = true;
    lbChassis.setItems(
      state.codesBySeries[series].map((c) => ({
        key: c,
        label: dispChassis(c),
      }))
    );
    idHint.textContent = 'Pick a chassis.';
  };
  // swap the placeholder silhouette for the real ETK car photo when we have
  // one for this chassis+body (thumbs.json indexes what shipped)
  function setThumb(ch, body) {
    const name = etkThumbs && ch && body ? etkThumbs[`${ch}_${body}`] : null;
    if (name) {
      thumb.style.background = `var(--bg) url("${etkThumbsBase}${name}") center/contain no-repeat`;
      thumb.classList.add('etk-idthumb-photo');
    } else {
      thumb.style.background = '';
      thumb.classList.remove('etk-idthumb-photo');
    }
  }

  // Chassis picked -> fill Body
  lbChassis._onpick = (ch) => {
    state.chassis = ch;
    state.body = state.model = null;
    lbModel.clear();
    resetDrops();
    thumb.hidden = false;
    setThumb(null, null);
    // newest intro-year across every body/model of this chassis -- the upper
    // bound for the (expanded) Year dropdown, since no explicit end date exists
    chassisMaxYear = 0;
    for (const mods of Object.values(veh[ch])) {
      for (const variants of Object.values(mods)) {
        for (const v of variants) {
          const y = +yearOf(v[2]);
          if (y && y > chassisMaxYear) chassisMaxYear = y;
        }
      }
    }
    const bodies = Object.keys(veh[ch]);
    lbBody.setItems(bodies.map((b) => ({ key: b, label: bodyLabel(b) })));
    idHint.textContent = 'Pick a body style.';
  };
  // Body picked -> fill Model (and show that body's car photo)
  lbBody._onpick = (body) => {
    state.body = body;
    state.model = null;
    resetDrops();
    setThumb(state.chassis, body);
    const models = Object.keys(veh[state.chassis][body]);
    lbModel.setItems(models.map((m) => ({ key: m, label: m })));
    idHint.textContent = 'Pick a model.';
  };
  // Model picked -> fill the Steering / Gearbox / Year / Month dropdowns
  lbModel._onpick = (model) => {
    state.model = model;
    resetDrops();
    const variants = veh[state.chassis][state.body][model]; // [[steer,gear,date,mospid]]
    state.variants = variants;
    const steers = [...new Set(variants.map((v) => v[0]))].filter(Boolean);
    opt(
      selSteer,
      steers.map(steerLabel),
      steers.length > 1 ? 'All values' : ''
    );
    selSteer._vals = steers;
    selSteer.disabled = false;
    if (steers.length === 1) {
      selSteer.selectedIndex = 1;
    }
    selSteer.onchange();
  };

  selSteer.onchange = () => {
    [selGear, selYear, selMonth].forEach((s) => {
      s.setDisabledEmpty();
      s.disabled = true;
    });
    const steer =
      selSteer.value !== '' ? selSteer._vals[+selSteer.value] : null;
    const vs = state.variants.filter((v) => !steer || v[0] === steer);
    const gears = [...new Set(vs.map((v) => v[1]))].filter(Boolean);
    opt(selGear, gears.map(gearLabel), gears.length > 1 ? 'All values' : '');
    selGear._vs = vs;
    selGear._vals = gears;
    selGear.disabled = false;
    if (gears.length === 1) {
      selGear.selectedIndex = 1;
    }
    selGear.onchange();
  };
  selGear.onchange = () => {
    [selYear, selMonth].forEach((s) => {
      s.setDisabledEmpty();
      s.disabled = true;
    });
    const gear = selGear.value !== '' ? selGear._vals[+selGear.value] : null;
    const vs = selGear._vs.filter((v) => !gear || v[1] === gear);
    // The dates in the data are each variant's INTRODUCTION date, not the model
    // years it was sold. So a car whose build year sits between two intro dates
    // (a 2005 E46 325i, say) had no exact row and its year went missing from the
    // list. List every year from the first intro to the chassis's end of build,
    // and map each to the variant "in force" then (newest intro <= that year).
    const introYears = [...new Set(vs.map((v) => yearOf(v[2])))]
      .filter(Boolean)
      .sort();
    let years = introYears,
      byYear = null;
    if (introYears.length) {
      const lo = +introYears[0];
      const hi = Math.max(
        +introYears[introYears.length - 1],
        chassisMaxYear || 0
      );
      years = [];
      byYear = {};
      for (let y = lo; y <= hi; y++) {
        const ys = String(y);
        // the newest intro-year at or before y -- the variant valid that year
        const inForce = introYears.filter((iy) => +iy <= y).pop();
        if (inForce) {
          years.push(ys);
          byYear[ys] = inForce;
        }
      }
    }
    opt(selYear, years, years.length > 1 ? 'All values' : '');
    selYear._vs = vs;
    selYear._vals = years;
    selYear._byYear = byYear;
    selYear.disabled = false;
    if (years.length === 1) {
      selYear.selectedIndex = 1;
    }
    selYear.onchange();
  };
  selYear.onchange = () => {
    selMonth.setDisabledEmpty();
    selMonth.disabled = true;
    const picked = selYear.value !== '' ? selYear._vals[+selYear.value] : null;
    // resolve the displayed year to the intro-year of the variant in force
    const introYear =
      picked && selYear._byYear ? selYear._byYear[picked] : picked;
    const vs = selYear._vs.filter(
      (v) => !introYear || yearOf(v[2]) === introYear
    );
    const months = [...new Set(vs.map((v) => monthOf(v[2])))]
      .filter(Boolean)
      .sort();
    opt(selMonth, months, months.length > 1 ? 'All values' : '');
    selMonth._vs = vs;
    selMonth._vals = months;
    selMonth.disabled = false;
    if (months.length === 1) {
      selMonth.selectedIndex = 1;
    }
    recompute();
  };
  selMonth.onchange = recompute;

  // pick the most specific variant the current filters allow; show the go
  // arrow once a vehicle resolves (with "All values" left alone it takes the
  // first match, same as the terminal's behaviour).
  function recompute() {
    let vs = state.variants || [];
    const steer =
      selSteer.value !== '' ? selSteer._vals[+selSteer.value] : null;
    if (steer) vs = vs.filter((v) => v[0] === steer);
    const gear =
      selGear._vals && selGear.value !== ''
        ? selGear._vals[+selGear.value]
        : null;
    if (gear) vs = vs.filter((v) => v[1] === gear);
    const yearSel =
      selYear._vals && selYear.value !== ''
        ? selYear._vals[+selYear.value]
        : null;
    // displayed year -> the intro-year of the variant in force (see selGear.onchange)
    const year =
      yearSel && selYear._byYear ? selYear._byYear[yearSel] : yearSel;
    if (year) vs = vs.filter((v) => yearOf(v[2]) === year);
    const month =
      selMonth._vals && selMonth.value !== ''
        ? selMonth._vals[+selMonth.value]
        : null;
    if (month) vs = vs.filter((v) => monthOf(v[2]) === month);
    const v = vs[0];
    if (!v || !state.model) {
      picked = null;
      idOpen.hidden = true;
      return;
    }
    picked = {
      chassis: state.chassis,
      mospid: v[3],
      model: state.model,
      body: state.body,
      steer: v[0],
      gear: v[1],
      prod: v[2],
    };
    idHint.textContent =
      `${dispChassis(picked.chassis)} · ${picked.model} · ` +
      `${bodyLabel(picked.body)} · ${steerLabel(picked.steer)}`;
    idOpen.hidden = false;
  }

  idOpen.onclick = async () => {
    if (!picked) return;
    // the section may not cover this manually-picked chassis (wiring)
    const canOpen = opts.resolvable
      ? await opts.resolvable(picked.chassis)
      : true;
    if (!canOpen) {
      idHint.textContent = opts.unavailable
        ? opts.unavailable(dispChassis(picked.chassis))
        : `Not available for ${dispChassis(picked.chassis)}.`;
      return;
    }
    onResolve(picked);
  };

  // populate the Series pane once vehicles.json is in hand (car photos load
  // alongside; missing thumbs just leave the silhouette)
  (async () => {
    try {
      loadEtkThumbs();
      veh = await loadVehicles();
      grouped = groupBySeries(veh);
      refreshSeries();
    } catch (e) {
      idHint.textContent = String(e.message || e);
    }
  })();
}

// After a VIN resolves, open its chassis and pre-select the matching variant.
async function openDecoded(hit) {
  await showEtkChassis(hit.chassis);
  // find the variant in the loaded chassis whose attrs match, select it. The
  // VIN hit and the drill-down pick share model/body/steer; motor is present
  // only on the VIN path, so match progressively from most to least specific.
  try {
    const data = await loadEtk(hit.chassis);
    const vs = data.tree.variants || [];
    const eq = (a, b) => (a || '') === (b || '');
    let match = -1;
    if (hit.motor) {
      // VIN path: model+body+motor+steer
      match = vs.findIndex(
        (v) =>
          eq(v.model, hit.model) &&
          eq(v.body, hit.body) &&
          eq(v.motor, hit.motor) &&
          eq(v.steer, hit.steer)
      );
    }
    if (match < 0)
      match = vs.findIndex(
        (v) =>
          eq(v.model, hit.model) &&
          eq(v.body, hit.body) &&
          eq(v.steer, hit.steer)
      );
    if (match < 0) match = vs.findIndex((v) => eq(v.model, hit.model));
    if (match >= 0) {
      ETK_STATE.variant = match;
      const cur = document.querySelector('.etk-vdd-cur');
      if (cur) {
        cur.textContent = variantLabel(vs[match]);
        cur.classList.add('etk-vdd-filtered');
      }
    }
  } catch (e) {
    /* the chassis still opened; just unfiltered */
  }
}

// body-code -> readable (Lim=Sedan, Tou=Touring, Cou=Coupé, Cab=Convertible…)
function bodyLabel(b) {
  return (
    {
      Lim: 'Sedan',
      Tou: 'Touring',
      Cou: 'Coupé',
      Cab: 'Convertible',
      com: 'Compact',
      Cabrio: 'Convertible',
    }[b] ||
    b ||
    ''
  );
}

// The chassis landing: ETK's "Search by Main Group" -- an icon grid of the HG
// groups, plus a variant selector so parts can be filtered to one exact vehicle.
// The selected variant is remembered across the whole chassis (module-level).
const ETK_STATE = { variant: null }; // chosen variant index, or null = all

async function showEtkChassis(chassisId) {
  const id = chassisId.toUpperCase();
  lastScreen = () => showEtkChassis(id);
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: 'Apps', fn: showApps },
    { label: 'Parts', fn: showEtk },
    { label: dispChassis(id) },
  ]);
  sbLeft.textContent = 'loading parts…';
  view.innerHTML = head(
    'ETK',
    dispChassis(id),
    'Pick a variant to filter, then a main group.'
  );
  document.body.classList.remove('wds-nofkeys');
  document.body.classList.add('apps-section');

  // the bundle streams from Hugging Face (~20 MB) -- a real wait, so show a
  // download progress bar instead of a blank pane while it loads.
  const loading = document.createElement('div');
  loading.className = 'etk-loading';
  loading.innerHTML = `
    <span class="wiring-spinner"></span>
    <div class="etk-progress-wrap">
      <div class="etk-progress-label">Loading ${esc(dispChassis(id))} parts catalogue…</div>
      <div class="etk-progress-track"><div class="etk-progress-bar" id="etk-progress"></div></div>
    </div>`;
  view.appendChild(loading);
  const bar = loading.querySelector('#etk-progress');
  const onProgress = (loaded, total) => {
    if (total > 0) {
      const pct = Math.min(100, Math.round((loaded / total) * 100));
      bar.style.width = pct + '%';
      loading.querySelector('.etk-progress-label').textContent =
        `Loading ${dispChassis(id)} parts catalogue… ${pct}%`;
    } else {
      bar.classList.add('etk-progress-indeterminate'); // no length -> animate
    }
  };

  let data;
  try {
    data = await loadEtk(id, onProgress);
  } catch (e) {
    loading.remove();
    view.appendChild(errorBlock(String(e.message || e)));
    return;
  }
  loading.remove();
  ETK_STATE.variant = null;
  ETK_STATE.variantLabel = null; // reset filter when entering a chassis

  // --- variant selector (custom searchable dropdown) ---
  const vbar = document.createElement('div');
  vbar.className = 'etk-variant-bar';
  const label = document.createElement('span');
  label.className = 'etk-variant-label';
  label.textContent = 'Vehicle:';
  vbar.appendChild(label);
  vbar.appendChild(buildVariantDropdown(data.tree.variants || []));
  view.appendChild(vbar);

  // --- main-group icon grid ---
  const grid = document.createElement('div');
  grid.className = 'etk-grid stagger';
  view.appendChild(grid);

  (data.tree.maingroups || []).forEach((mg) => {
    const card = document.createElement('button');
    card.className = 'etk-gcard';
    const iconUrl = etkImageUrl(data, mg.icon);
    card.innerHTML = `
      <span class="etk-gnum">${esc(mg.hg)}</span>
      <span class="etk-gicon">${iconUrl ? `<img src="${iconUrl}" alt="">` : ''}</span>
      <span class="etk-gname">${esc(mg.name)}</span>`;
    card.onclick = () => showEtkGroup(data, id, mg);
    grid.appendChild(card);
  });
  stagger(grid, 16);

  sbLeft.textContent = `${(data.tree.maingroups || []).length} main groups`;
  sbRight.textContent = `${(data.tree.variants || []).length} variants`;
  // Print here isn't the icon grid (a navigation menu) -- it's a clean catalogue
  // index: the vehicle and its list of main groups.
  setActions([
    {
      key: 'Escape',
      keyLabel: 'Esc',
      label: 'Back',
      kind: 'back',
      fn: showEtk,
    },
    {
      key: 'p',
      keyLabel: 'P',
      label: 'Print',
      fn: () => printEtkIndex(data, id),
    },
  ]);
}

// The main-group index for a vehicle as a clean printout (not the icon grid).
function printEtkIndex(data, chassisId) {
  const mgs = data.tree.maingroups || [];
  const rows = mgs.map((mg) => [mg.hg, mg.name]);
  printDoc({
    title: `${dispChassis(chassisId)} · parts catalogue`,
    subtitle: ETK_STATE.variantLabel || '',
    meta: [
      ['Main groups', String(mgs.length)],
      ['Variants', String((data.tree.variants || []).length)],
    ],
    sections: [printTable(['Group', 'Name'], rows, ['pr-mono', ''])],
    footer: `${APP_NAME} · BMW ETK · printed ${new Date().toLocaleDateString()}`,
  });
}

// A custom searchable dropdown for the 297 variants -- the native <select> is
// unstyleable and unsearchable. Options: "All variants" plus one per variant,
// sorted by model+date, filterable by a search box. Sets ETK_STATE.variant.
function buildVariantDropdown(variants) {
  const order = variants
    .map((v, i) => ({ i, v, text: variantLabel(v) }))
    .sort(
      (a, b) =>
        (a.v.model || '').localeCompare(b.v.model || '') ||
        String(a.v.date).localeCompare(String(b.v.date))
    );

  const root = document.createElement('div');
  root.className = 'etk-vdd';
  const btn = document.createElement('button');
  btn.className = 'etk-vdd-btn';
  btn.innerHTML = `<span class="etk-vdd-cur">All variants (${variants.length})</span>
                   <span class="etk-vdd-caret">▾</span>`;
  const menu = document.createElement('div');
  menu.className = 'etk-vdd-menu';
  menu.hidden = true;
  const search = document.createElement('input');
  search.className = 'etk-vdd-search';
  search.type = 'search';
  search.placeholder = 'Search 316i, LHD, N42, 2003…';
  const list = document.createElement('div');
  list.className = 'etk-vdd-list';
  menu.appendChild(search);
  menu.appendChild(list);
  root.appendChild(btn);
  root.appendChild(menu);

  const cur = btn.querySelector('.etk-vdd-cur');

  function choose(idx, text, ev) {
    if (ev) {
      ev.preventDefault();
      ev.stopPropagation();
    }
    ETK_STATE.variant = idx;
    // the exact variant string ("325i · Lim · M54 · LHD · 2003-03"), so a
    // printed diagram names the vehicle it was filtered to; null = all variants
    ETK_STATE.variantLabel = idx != null ? text : null;
    cur.textContent = text;
    cur.classList.toggle('etk-vdd-filtered', idx != null);
    close();
  }

  function renderList(q) {
    list.innerHTML = '';
    const ql = (q || '').toLowerCase();
    const all = document.createElement('button');
    all.type = 'button';
    all.className =
      'etk-vdd-opt' + (ETK_STATE.variant == null ? ' active' : '');
    all.textContent = `All variants (${variants.length})`;
    all.onclick = (e) => choose(null, `All variants (${variants.length})`, e);
    if (!ql) list.appendChild(all);
    let shown = 0;
    for (const o of order) {
      if (ql && !o.text.toLowerCase().includes(ql)) continue;
      if (++shown > 200) break; // cap the DOM; search narrows it
      const el = document.createElement('button');
      el.type = 'button';
      el.className =
        'etk-vdd-opt' + (ETK_STATE.variant === o.i ? ' active' : '');
      el.textContent = o.text;
      el.onclick = (e) => choose(o.i, o.text, e);
      list.appendChild(el);
    }
  }

  let outside = null;
  function open() {
    menu.hidden = false;
    search.value = '';
    renderList('');
    search.focus();
    // arm the outside-click closer on the NEXT tick so this same click that
    // opened the menu doesn't immediately close it.
    setTimeout(() => {
      outside = (e) => {
        if (!root.contains(e.target)) close();
      };
      document.addEventListener('click', outside);
    }, 0);
  }
  function close() {
    menu.hidden = true;
    if (outside) {
      document.removeEventListener('click', outside);
      outside = null;
    }
  }

  btn.type = 'button';
  btn.onclick = (e) => {
    e.stopPropagation();
    menu.hidden ? open() : close();
  };
  search.oninput = () => renderList(search.value);
  search.onclick = (e) => e.stopPropagation();

  return root;
}

function variantLabel(v) {
  const parts = [];
  if (v.model) parts.push(v.model);
  if (v.body) parts.push(v.body);
  if (v.motor) parts.push(v.motor);
  if (v.steer)
    parts.push(v.steer === 'R' ? 'RHD' : v.steer === 'L' ? 'LHD' : v.steer);
  if (v.gear) {
    const g = { A: 'auto', M: 'man.', N: '' }[v.gear];
    if (g) parts.push(g);
  }
  if (v.date) {
    const d = String(v.date);
    if (d.length === 8) parts.push(`${d.slice(0, 4)}-${d.slice(4, 6)}`);
  }
  return parts.join(' · ');
}

// A main group opened: the wiring-style split -- its function-group tree of
// diagrams on the left, the selected diagram on the right, all honouring the
// active variant filter.
function showEtkGroup(data, chassisId, mg, openBtnr = null) {
  const id = chassisId.toUpperCase();
  lastScreen = () => showEtkGroup(data, id, mg);
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: 'Apps', fn: showApps },
    { label: 'Parts', fn: showEtk },
    { label: dispChassis(id), fn: () => showEtkChassis(id) },
    { label: `${mg.hg} ${mg.name}` },
  ]);
  view.innerHTML = '';
  // wds-nofkeys hides the F-key bar; apps-section reveals the topbar Back button
  // (the ETK diagram screen has no toolbar Back of its own, unlike the WDS
  // viewer -- so it needs the topbar one).
  document.body.classList.add('wds-nofkeys');
  document.body.classList.add('apps-section');

  const split = document.createElement('div');
  split.className = 'etk-split';
  split.innerHTML = `
    <div class="etk-body">
      <nav class="etk-nav"><div class="etk-tree" id="etk-tree"></div></nav>
      <div class="etk-view" id="etk-view"></div>
    </div>`;
  view.appendChild(split);
  const treeEl = split.querySelector('#etk-tree');
  const viewEl = split.querySelector('#etk-view');
  // On a phone the panes are exclusive, WDS-style: the tree OR the diagram,
  // never both squeezed side by side. data-pane drives the CSS; desktop
  // ignores it (the rules live in the mobile media block).
  const bodyEl = split.querySelector('.etk-body');
  const phone = () => window.matchMedia('(max-width: 760px)').matches;
  bodyEl.dataset.pane = 'tree';

  let selectedLeaf = null;
  let shownDiagram = null; // the diagram currently on screen
  mg.groups.forEach((g) => {
    const grp = document.createElement('div');
    grp.className = 'etk-tgroup';
    const hdr = document.createElement('button');
    hdr.className = 'etk-tgroup-hdr';
    hdr.innerHTML = `<span class="etk-tw">▾</span>
                     <span class="etk-tname">${esc(g.name)}</span>
                     <span class="etk-tcount">${g.diagrams.length}</span>`;
    const kids = document.createElement('div');
    kids.className = 'etk-tkids';
    hdr.onclick = () => {
      const open = kids.style.display !== 'none';
      kids.style.display = open ? 'none' : 'block';
      hdr.querySelector('.etk-tw').textContent = open ? '▸' : '▾';
    };
    g.diagrams.forEach((d) => {
      const leaf = document.createElement('button');
      leaf.className = 'etk-tleaf';
      leaf.innerHTML = `<span class="etk-lname">${esc(d.name)}</span>
                        <span class="etk-lcount">${countFit(d.parts)}</span>`;
      leaf._btnr = d.btnr;
      leaf.onclick = () => {
        if (selectedLeaf) selectedLeaf.classList.remove('active');
        leaf.classList.add('active');
        selectedLeaf = leaf;
        shownDiagram = d; // remember it for Print
        renderDiagram(data, id, d, viewEl);
        if (phone()) bodyEl.dataset.pane = 'doc';
        // reflect the open diagram in the URL so it's a shareable deep link
        if (typeof routeSetEtkDiagram === 'function') {
          routeSetEtkDiagram(id, mg.hg, d.btnr);
        }
      };
      kids.appendChild(leaf);
    });
    grp.appendChild(hdr);
    grp.appendChild(kids);
    treeEl.appendChild(grp);
  });

  // open the requested diagram (deep link), else the first so the pane isn't
  // empty. A deep-linked leaf may sit in a collapsed group -- open it first.
  let target = null;
  if (openBtnr) {
    target = [...treeEl.querySelectorAll('.etk-tleaf')].find(
      (l) => l._btnr === openBtnr
    );
    if (target) {
      const kids = target.closest('.etk-tkids');
      if (kids && kids.style.display === 'none') {
        const hdr = kids.previousElementSibling;
        if (hdr) hdr.click(); // expand the group
      }
      target.scrollIntoView({ block: 'center' });
    }
  }
  (target || treeEl.querySelector('.etk-tleaf'))?.click();
  // the auto-opened FIRST diagram must not steal the screen on a phone --
  // land on the tree so the group is navigable. A deep-linked diagram was
  // asked for by name, so that one does take the screen.
  if (!openBtnr) bodyEl.dataset.pane = 'tree';

  sbLeft.textContent = mg.name;
  // a back action so the mobile top-left chevron appears (and Esc works),
  // returning to this chassis's main-group grid. On a phone, Back from a
  // DIAGRAM returns to the tree first (panes are exclusive there, so leaving
  // outright would skip a level -- same rule as the WDS viewer). Print emits
  // a clean, theme-agnostic sheet of the diagram currently open.
  const leaveGroup = () => {
    if (phone() && bodyEl.dataset.pane === 'doc') {
      bodyEl.dataset.pane = 'tree';
      return;
    }
    showEtkChassis(id);
  };
  setActions([
    {
      key: 'Escape',
      keyLabel: 'Esc',
      label: 'Back',
      kind: 'back',
      fn: leaveGroup,
    },
    {
      key: 'p',
      keyLabel: 'P',
      label: 'Print',
      fn: () => {
        if (shownDiagram) printEtkDiagram(data, id, mg, shownDiagram);
      },
    },
  ]);
}

// A single ETK diagram as a clean printout: exploded-view image on top, the
// numbered parts list below (filtered to the active variant, same as on screen).
function printEtkDiagram(data, chassisId, mg, d) {
  const parts = d.parts.filter(
    (p) =>
      ETK_STATE.variant == null || !p.fit || p.fit.includes(ETK_STATE.variant)
  );
  const rows = parts.map((p) => [p.pos, fmtSachnr(p.sachnr, p.pre), p.name]);
  const veh = ETK_STATE.variantLabel || dispChassis(chassisId);
  printDoc({
    title: d.name,
    subtitle: veh,
    meta: [
      ['Main group', `${mg.hg} ${mg.name}`],
      ['Parts', String(parts.length)],
    ],
    sections: [
      printImage(etkImageUrl(data, d.img), d.name),
      printTable(['No.', 'Part number', 'Description'], rows, [
        'pr-num',
        'pr-mono',
        '',
      ]),
    ],
    footer: `${APP_NAME} · BMW ETK · ${dispChassis(chassisId)} · printed ${new Date().toLocaleDateString()}`,
  });
}

// Deep-link entry: open a chassis's main group (and optionally a specific
// diagram) directly from a URL like #apps/parts/E46/11 or
// #apps/parts/E46/11/11_0100. Loads the bundle, finds the main group by its
// HG number, and hands off to showEtkGroup. Falls back to the chassis grid.
async function showEtkDeep(chassisId, hg, btnr) {
  const id = String(chassisId || '').toUpperCase();
  if (!hg) {
    return showEtkChassis(id);
  }
  // render the chassis screen first so a slow load still shows something and
  // Back has somewhere to go, then swap to the group once data is in hand.
  await showEtkChassis(id);
  try {
    const data = await loadEtk(id);
    const mg = (data.tree.maingroups || []).find(
      (m) => String(m.hg) === String(hg)
    );
    if (mg) showEtkGroup(data, id, mg, btnr || null);
  } catch (e) {
    /* the chassis grid is already up */
  }
}

// parts count honouring the active variant filter
function countFit(parts) {
  if (ETK_STATE.variant == null) return parts.length;
  return parts.filter((p) => !p.fit || p.fit.includes(ETK_STATE.variant))
    .length;
}

// Render one diagram into the right pane: exploded-view image on top, its
// numbered parts list below, filtered to the chosen variant.
function renderDiagram(data, chassisId, d, viewEl) {
  viewEl.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'etk-diagram';

  const title = document.createElement('div');
  title.className = 'etk-dtitle';
  title.textContent = d.name;
  wrap.appendChild(title);

  const url = etkImageUrl(data, d.img);
  if (url) {
    const fig = document.createElement('div');
    fig.className = 'etk-figure';
    const img = document.createElement('img');
    img.alt = d.name;
    img.loading = 'lazy';
    img.onload = () => {
      const w = img.naturalWidth;
      if (w && w < 500) img.style.width = Math.min(w * 2, 700) + 'px';
    };
    img.src = url;
    fig.appendChild(img);
    wrap.appendChild(fig);
  }

  // filter parts to the active variant (parts with no fit data always show)
  const parts = d.parts.filter(
    (p) =>
      ETK_STATE.variant == null || !p.fit || p.fit.includes(ETK_STATE.variant)
  );

  const table = document.createElement('table');
  table.className = 'etk-parts';
  table.innerHTML = `<thead><tr><th>No.</th><th>Part number</th><th>Description</th></tr></thead>`;
  const tb = document.createElement('tbody');
  parts.forEach((p) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="etk-pos">${esc(p.pos)}</td>
                    <td class="etk-sachnr">${esc(fmtSachnr(p.sachnr, p.pre))}</td>
                    <td class="etk-name">${esc(p.name)}</td>`;
    tb.appendChild(tr);
  });
  table.appendChild(tb);
  wrap.appendChild(table);
  viewEl.appendChild(wrap);
  viewEl.scrollTop = 0;
  const filtered = ETK_STATE.variant != null && parts.length < d.parts.length;
  sbRight.textContent =
    `${parts.length} part${parts.length === 1 ? '' : 's'}` +
    (filtered ? ` (of ${d.parts.length})` : '');
}

// BMW part numbers print as the full 11-digit number when we have the group
// prefix: main-group + subgroup + 7-digit sachnr, grouped "11 13 7 791 531".
// Without a prefix, fall back to grouping the 7-digit number alone.
function fmtSachnr(s, prefix) {
  const d = String(s).replace(/\D/g, '');
  if (prefix && d.length === 7) {
    const p = String(prefix).replace(/\D/g, '');
    if (p.length === 4) {
      // HG(2) UG(2) X(1) XXX(3) XXX(3)
      return `${p.slice(0, 2)} ${p.slice(2, 4)} ${d.slice(0, 1)} ${d.slice(1, 4)} ${d.slice(4)}`;
    }
  }
  if (d.length === 7) return `${d.slice(0, 2)} ${d.slice(2, 4)} ${d.slice(4)}`;
  return s;
}
