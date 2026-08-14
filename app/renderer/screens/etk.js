// ETK parts catalogue, from BMW's own data. tools/etk_import.py packs one .etk
// archive per car: tree.json (assembly groups -> diagrams -> parts) plus the
// exploded-view images (jpg/png). Same archive shape and loading path as the
// .wiring bundles -- fflate inflates, and the offline export inlines base64.

const ETK_CACHE = new Map();       // chassis -> { tree, files: Map(name -> u8) }
let etkChassisIds = null;          // memoised probe of which cars have data

// The .etk bundles are 6.4 GB across 246 cars -- too big to ship in the Pages
// repo. They live in a Hugging Face dataset and stream in at runtime (HF's
// resolve URLs reflect the request Origin, so cross-origin fetch from
// bmweb.danner.ink is CORS-clean -- verified). Local data/etk/ wins when
// present (dev + the offline single-file export), else fall back to HF.
const ETK_HF_BASE =
  'https://huggingface.co/datasets/CraigFf/bmweb-etk/resolve/main/';

function etkBundleUrl(id, local) {
  if (local) {
    const base = (typeof WEB_BASE === 'string') ? WEB_BASE : '';
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
  const inline = (typeof BMACW_ETK === 'object' && BMACW_ETK) ? BMACW_ETK[id] : null;
  if (inline) {
    const bin = atob(inline);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    const real = (typeof webRealFetch === 'function') ? webRealFetch : window.fetch.bind(window);
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
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// Does this chassis have an .etk bundle? HEAD probe (local then HF), or the
// inline check. Cheap enough to run per car when building the picker.
async function hasEtk(chassisId) {
  const id = chassisId.toUpperCase();
  if (typeof BMACW_ETK === 'object' && BMACW_ETK) return !!BMACW_ETK[id];
  const real = (typeof webRealFetch === 'function') ? webRealFetch : window.fetch.bind(window);
  const probe = async (local) => {
    try {
      const r = await real(etkBundleUrl(id, local), { method: 'HEAD' });
      return r.ok;
    } catch (e) { return false; }
  };
  return (await probe(true)) || (await probe(false));
}

// The Apps hub asks these two: is ETK in this build at all, and open it.
function etkHasData() {
  if (typeof BMACW_ETK === 'object' && BMACW_ETK) return Object.keys(BMACW_ETK).length > 0;
  return true;   // web build: assume the data/ tree may carry it; the picker probes per car
}

async function etkChassisList() {
  if (etkChassisIds) return etkChassisIds;
  // one index.json lists every chassis that has a bundle -- read it instead of
  // HEAD-probing all ~135 cars (that would be hundreds of requests to HF).
  if (typeof BMACW_ETK === 'object' && BMACW_ETK) {
    etkChassisIds = Object.keys(BMACW_ETK).sort();
    return etkChassisIds;
  }
  const real = (typeof webRealFetch === 'function') ? webRealFetch : window.fetch.bind(window);
  const tryIndex = async (local) => {
    try {
      const url = local ? etkBundleUrl('index', true).replace('.etk', '.json')
                        : `${ETK_HF_BASE}index.json`;
      const r = await real(url);
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
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

  let items = [];        // display strings
  let value = '';        // '' (placeholder) or a 0-based index string of an item
  let ph = placeholder || 'Select…';
  let disabled = false;
  let outside = null;

  function label() { return value === '' ? ph : items[+value]; }
  function paint() { cur.textContent = label(); cur.classList.toggle('etk-sel-ph', value === ''); }
  function renderMenu() {
    menu.innerHTML = '';
    items.forEach((t, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'etk-sel-opt' + (value === String(i) ? ' active' : '');
      b.textContent = t;
      b.onclick = (e) => { e.stopPropagation(); value = String(i); paint(); close(); fire(); };
      menu.appendChild(b);
    });
  }
  function open() {
    if (disabled || !items.length) return;
    renderMenu(); menu.hidden = false; root.classList.add('etk-sel-open');
    setTimeout(() => { outside = (e) => { if (!root.contains(e.target)) close(); };
                       document.addEventListener('click', outside); }, 0);
  }
  function close() {
    menu.hidden = true; root.classList.remove('etk-sel-open');
    if (outside) { document.removeEventListener('click', outside); outside = null; }
  }
  // fire both the event (for addEventListener) and the .onchange property the
  // cascade sets, since a div's onchange isn't auto-wired like a <select>'s.
  function fire() {
    root.dispatchEvent(new Event('change'));
    if (typeof root.onchange === 'function') root.onchange(new Event('change'));
  }

  btn.onclick = (e) => { e.stopPropagation(); menu.hidden ? open() : close(); };

  // the <select>-ish surface the cascade code uses. Values are 0-based item
  // indices ('' = none). selectedIndex mirrors native semantics (0 = the
  // placeholder, 1..N = items) so the cascade's `sel.selectedIndex = 1` lines
  // still auto-pick the first real item.
  Object.defineProperties(root, {
    value: { get: () => value, set: (v) => { value = v === '' ? '' : String(v); paint(); } },
    disabled: { get: () => disabled, set: (d) => { disabled = !!d; root.classList.toggle('etk-sel-disabled', disabled); if (d) close(); } },
    selectedIndex: {
      get: () => value === '' ? 0 : +value + 1,
      set: (i) => { value = (i && i >= 1) ? String(i - 1) : ''; paint(); },
    },
    options: { get: () => [{ textContent: ph }, ...items.map(t => ({ textContent: t }))] },
  });
  // setOptions replaces the innerHTML-style population the cascade did via opt()
  root.setOptions = (arr, placeholderText) => {
    if (placeholderText != null) ph = placeholderText;
    items = arr.slice(); value = ''; paint(); close();
  };
  root.setDisabledEmpty = () => { items = []; value = ''; paint(); };
  paint();
  return root;
}

// ---- vehicle attribute tree (the ETK-style drill-down) --------------------
// vehicles.json: chassis -> body -> model -> [[steer,gear,year,mospid], ...].
// Small (~200 KB), ships in the repo (local), with an HF fallback.
let etkVehicles = null;
async function loadVehicles() {
  if (etkVehicles) return etkVehicles;
  const real = (typeof webRealFetch === 'function') ? webRealFetch : window.fetch.bind(window);
  const base = (typeof WEB_BASE === 'string') ? WEB_BASE : '';
  const urls = [`${base}/data/etk/vehicles.json`, `${ETK_HF_BASE}vehicles.json`];
  let r = null;
  for (const u of urls) { r = await real(u).catch(() => null); if (r && r.ok) break; }
  if (!r || !r.ok) throw new Error('vehicle data not available');
  etkVehicles = await r.json();
  return etkVehicles;
}

// ---- VIN decoder ----------------------------------------------------------
// A BMW VIN's last 7 characters are the sequential production number. vin-index
// maps each production-number range to a vehicle, so we can resolve a VIN to
// its exact chassis + variant, then jump into that catalogue pre-filtered.
let etkVinIndex = null;   // { variants:[[chassis,mospid,model,body,motor,steer]], ranges:[[von,bis,vidx,prod]] }

async function loadVinIndex(onProgress) {
  if (etkVinIndex) return etkVinIndex;
  const real = (typeof webRealFetch === 'function') ? webRealFetch : window.fetch.bind(window);
  const base = (typeof WEB_BASE === 'string') ? WEB_BASE : '';
  const urls = [`${base}/data/etk/vin-index.json.gz`, `${ETK_HF_BASE}vin-index.json.gz`];
  let r = null;
  for (const u of urls) { r = await real(u).catch(() => null); if (r && r.ok) break; }
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
  const vin = String(vinRaw || '').trim().toUpperCase().replace(/\s/g, '');
  // last 7 chars are the production number; a bare 7-char code is accepted too
  const pn = vin.length >= 7 ? vin.slice(-7) : vin.padStart(7, '0');
  const R = idx.ranges;
  let lo = 0, hi = R.length - 1, hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [von, bis] = R[mid];
    if (pn < von) hi = mid - 1;
    else if (pn > bis) lo = mid + 1;
    else { hit = mid; break; }
  }
  if (hit < 0) return null;
  const [von, bis, vi, prod] = R[hit];
  const v = idx.variants[vi];   // [chassis,mospid,model,body,motor,steer]
  return {
    pn, chassis: v[0], mospid: v[1],
    model: v[2], body: v[3], motor: v[4], steer: v[5], prod,
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
  setCrumbs([{ label: 'Vehicles', fn: showChassis },
             { label: 'Apps', fn: showApps }, { label: 'Parts Catalogue' }]);
  document.body.classList.add('apps-section');
  sbLeft.textContent = 'parts';
  view.innerHTML = head('ETK', 'Parts Catalogue',
    "BMW's own parts diagrams. Pick a vehicle to browse its catalogue.");
  setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: showApps }]);

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
      <div style="font-size:12px;color:var(--ink-faint)">To add it:
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
    ...ids.slice(0, 9).map((id, i) => ({ key: String(i + 1), label: dispChassis(id), fn: () => showEtkChassis(id) })),
    { key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: showApps },
  ]);
}

// The VIN Decoder page: enter a VIN (or its last 7) and it resolves to the
// exact vehicle, then opens that catalogue pre-filtered.
function showVinDecoder() {
  lastScreen = showVinDecoder;
  setCrumbs([{ label: 'Vehicles', fn: showChassis },
             { label: 'Apps', fn: showApps },
             { label: 'Parts', fn: showEtk }, { label: 'VIN Decoder' }]);
  document.body.classList.add('apps-section');
  sbLeft.textContent = 'vin decoder';
  view.innerHTML = head('ETK', 'Vehicle Identification',
    'Enter your VIN, or identify your vehicle by series, body and model.');
  setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: showEtk }]);

  const card = document.createElement('div');
  card.className = 'etk-vin-card';
  card.innerHTML = `
    <div class="etk-vin-row">
      <input class="etk-vin-input" type="text" maxlength="17" spellcheck="false"
             autocapitalize="characters" placeholder="WBA… or last 7 chars">
      <button class="etk-vin-go" type="button">Decode →</button>
    </div>
    <div class="etk-vin-hint">A BMW VIN's last 7 characters are the production
      number. Paste the full VIN or just those 7.</div>
    <div class="etk-vin-result" hidden></div>`;
  view.appendChild(card);

  const input = card.querySelector('.etk-vin-input');
  const go = card.querySelector('.etk-vin-go');
  const result = card.querySelector('.etk-vin-result');
  input.focus();

  async function decode() {
    const vin = input.value.trim();
    if (vin.length < 7) {
      result.hidden = false;
      result.className = 'etk-vin-result etk-vin-err';
      result.textContent = 'Enter at least the 7-character production number (or a full VIN).';
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
      const bits = [hit.model, bodyLabel(hit.body), hit.motor,
                    hit.steer === 'R' ? 'RHD' : hit.steer === 'L' ? 'LHD' : '']
                   .filter(Boolean).join(' · ');
      const dateStr = hit.prod && String(hit.prod).length >= 6
        ? ` · ${String(hit.prod).slice(0, 4)}-${String(hit.prod).slice(4, 6)}` : '';
      result.className = 'etk-vin-result etk-vin-ok';
      result.innerHTML = `
        <div class="etk-vin-veh"><b>${esc(dispChassis(hit.chassis))}</b> ${esc(bits)}${esc(dateStr)}</div>
        <button class="etk-vin-open" type="button">Open ${esc(dispChassis(hit.chassis))} parts →</button>`;
      result.querySelector('.etk-vin-open').onclick = () => openDecoded(hit);
    } catch (e) {
      go.disabled = false;
      result.className = 'etk-vin-result etk-vin-err';
      result.textContent = String(e.message || e);
    }
  }

  go.onclick = decode;
  input.onkeydown = (e) => { if (e.key === 'Enter') decode(); };

  // ---- attribute drill-down (ETK's Series -> Body -> Model + Steering/etc) --
  const divider = document.createElement('div');
  divider.className = 'etk-idsep';
  divider.innerHTML = `<span>or identify by attributes</span>`;
  view.appendChild(divider);

  const idCard = document.createElement('div');
  idCard.className = 'etk-idcard';
  // build the six custom selects and lay them out
  const selSeries = makeSelect('Select series…');
  const selBody = makeSelect('Select body…');
  const selModel = makeSelect('Select model…');
  const selSteer = makeSelect('Select steering…');
  const selGear = makeSelect('Select transmission…');
  const selYear = makeSelect('Select production date…');
  [selBody, selModel, selSteer, selGear, selYear].forEach(s => { s.disabled = true; });
  const col = (labelText, sel) => {
    const c = document.createElement('label');
    c.className = 'etk-idcol';
    const l = document.createElement('span'); l.className = 'etk-idlabel'; l.textContent = labelText;
    c.appendChild(l); c.appendChild(sel); return c;
  };
  const g1 = document.createElement('div'); g1.className = 'etk-idgrid';
  g1.append(col('Series', selSeries), col('Body', selBody), col('Model', selModel));
  const g2 = document.createElement('div'); g2.className = 'etk-idgrid';
  g2.append(col('Steering', selSteer), col('Transmission', selGear), col('Production', selYear));
  const foot = document.createElement('div'); foot.className = 'etk-idfoot';
  const idHint = document.createElement('span'); idHint.className = 'etk-idhint';
  idHint.textContent = 'Pick a series to begin.';
  const idOpen = document.createElement('button');
  idOpen.type = 'button'; idOpen.className = 'etk-vin-open'; idOpen.hidden = true;
  idOpen.textContent = 'Open parts →';
  foot.append(idHint, idOpen);
  idCard.append(g1, g2, foot);
  view.appendChild(idCard);

  let veh = null;                 // the loaded vehicles.json
  let picked = null;              // { chassis, mospid, ... }

  const opt = (sel, items, ph) => sel.setOptions(items, ph);
  const reset = (...sels) => sels.forEach(s => { s.setDisabledEmpty(); s.disabled = true; });

  const gearLabel = (g) => ({ A: 'Automatic', M: 'Manual', N: 'n/a' }[g] || g || 'n/a');
  const steerLabel = (s) => ({ L: 'Left-hand drive', R: 'Right-hand drive' }[s] || s);
  const yearLabel = (y) => (y && String(y).length >= 6)
    ? `${String(y).slice(0, 4)}-${String(y).slice(4, 6)}` : (y || '');

  // load the tree lazily on first click of the series dropdown
  selSeries.querySelector('.etk-sel-btn').addEventListener('click', async function once() {
    selSeries.querySelector('.etk-sel-btn').removeEventListener('click', once);
    if (veh) return;
    idHint.textContent = 'Loading vehicles…';
    try {
      veh = await loadVehicles();
      const chassis = Object.keys(veh).sort();
      opt(selSeries, chassis.map(dispChassis), 'Select series…');
      selSeries._ids = chassis;
      idHint.textContent = 'Pick a series to begin.';
    } catch (e) { idHint.textContent = String(e.message || e); }
  });

  function clearFrom(level) {
    picked = null; idOpen.hidden = true;
    if (level <= 1) reset(selBody, selModel, selSteer, selGear, selYear);
    else if (level === 2) reset(selModel, selSteer, selGear, selYear);
    else if (level === 3) reset(selSteer, selGear, selYear);
  }

  selSeries.onchange = () => {
    clearFrom(1);
    if (!selSeries.value) return;
    const ch = selSeries._ids[+selSeries.value];
    const bodies = Object.keys(veh[ch]);
    opt(selBody, bodies.map(bodyLabel), 'Select body…');
    selBody._ch = ch; selBody._bodies = bodies; selBody.disabled = false;
    idHint.textContent = 'Pick a body style.';
  };
  selBody.onchange = () => {
    clearFrom(2);
    if (!selBody.value) return;
    const body = selBody._bodies[+selBody.value];
    const models = Object.keys(veh[selBody._ch][body]);
    opt(selModel, models, 'Select model…');
    selModel._body = body; selModel._models = models; selModel.disabled = false;
    idHint.textContent = 'Pick a model.';
  };
  selModel.onchange = () => {
    clearFrom(3);
    if (!selModel.value) return;
    const model = selModel._models[+selModel.value];
    const variants = veh[selBody._ch][selModel._body][model];   // [[steer,gear,year,mospid]]
    selModel._variants = variants;
    // steering options (distinct)
    const steers = [...new Set(variants.map(v => v[0]))].filter(Boolean);
    opt(selSteer, steers.map(steerLabel), steers.length > 1 ? 'Select steering…' : '');
    selSteer._vals = steers; selSteer.disabled = false;
    if (steers.length === 1) { selSteer.selectedIndex = 1; selSteer.onchange(); }
    else idHint.textContent = 'Pick steering.';
  };
  selSteer.onchange = () => {
    reset(selGear, selYear); idOpen.hidden = true; picked = null;
    if (!selSteer.value && selSteer._vals.length > 1) return;
    const steer = selSteer._vals[selSteer.value ? +selSteer.value : 0];
    const vs = selModel._variants.filter(v => v[0] === steer);
    const gears = [...new Set(vs.map(v => v[1]))].filter(Boolean);
    opt(selGear, gears.map(gearLabel), gears.length > 1 ? 'Select transmission…' : '');
    selGear._vs = vs; selGear._steer = steer; selGear._vals = gears; selGear.disabled = false;
    if (gears.length <= 1) { selGear.selectedIndex = gears.length; selGear.onchange(); }
    else idHint.textContent = 'Pick transmission.';
  };
  selGear.onchange = () => {
    reset(selYear); idOpen.hidden = true; picked = null;
    if (!selGear.value && selGear._vals.length > 1) return;
    const gear = selGear._vals.length ? selGear._vals[selGear.value ? +selGear.value : 0] : '';
    const vs = selGear._vs.filter(v => !gear || v[1] === gear);
    const years = [...new Set(vs.map(v => v[2]))].filter(Boolean).sort();
    opt(selYear, years.map(yearLabel), years.length > 1 ? 'Select production date…' : '');
    selYear._vs = vs; selYear._vals = years; selYear.disabled = false;
    if (years.length <= 1) { selYear.selectedIndex = years.length; finalize(); }
    else idHint.textContent = 'Pick a production date.';
  };
  selYear.onchange = finalize;

  function finalize() {
    const vs = selYear._vs || [];
    const year = selYear._vals && selYear._vals.length
      ? selYear._vals[selYear.value ? +selYear.value : 0] : null;
    const v = (year ? vs.filter(x => x[2] === year) : vs)[0];
    if (!v) { idOpen.hidden = true; return; }
    picked = { chassis: selBody._ch, mospid: v[3],
               model: selModel._models[+selModel.value],
               body: selBody._bodies[+selBody.value],
               steer: v[0], gear: v[1], prod: v[2] };
    idHint.textContent = `${dispChassis(picked.chassis)} · ${picked.model} · `
      + `${bodyLabel(picked.body)} · ${steerLabel(picked.steer)}`;
    idOpen.hidden = false;
  }

  idOpen.onclick = () => { if (picked) openDecoded(picked); };
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
    if (hit.motor) {   // VIN path: model+body+motor+steer
      match = vs.findIndex(v => eq(v.model, hit.model) && eq(v.body, hit.body) &&
                                eq(v.motor, hit.motor) && eq(v.steer, hit.steer));
    }
    if (match < 0) match = vs.findIndex(v => eq(v.model, hit.model) &&
                                             eq(v.body, hit.body) && eq(v.steer, hit.steer));
    if (match < 0) match = vs.findIndex(v => eq(v.model, hit.model));
    if (match >= 0) {
      ETK_STATE.variant = match;
      const cur = document.querySelector('.etk-vdd-cur');
      if (cur) { cur.textContent = variantLabel(vs[match]); cur.classList.add('etk-vdd-filtered'); }
    }
  } catch (e) { /* the chassis still opened; just unfiltered */ }
}

// body-code -> readable (Lim=Sedan, Tou=Touring, Cou=Coupé, Cab=Convertible…)
function bodyLabel(b) {
  return ({ Lim: 'Sedan', Tou: 'Touring', Cou: 'Coupé', Cab: 'Convertible',
            com: 'Compact', Cabrio: 'Convertible' }[b]) || b || '';
}

// The chassis landing: ETK's "Search by Main Group" -- an icon grid of the HG
// groups, plus a variant selector so parts can be filtered to one exact vehicle.
// The selected variant is remembered across the whole chassis (module-level).
const ETK_STATE = { variant: null };   // chosen variant index, or null = all

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
  view.innerHTML = head('ETK', dispChassis(id), 'Pick a variant to filter, then a main group.');
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
      bar.classList.add('etk-progress-indeterminate');   // no length -> animate
    }
  };

  let data;
  try { data = await loadEtk(id, onProgress); }
  catch (e) { loading.remove(); view.appendChild(errorBlock(String(e.message || e))); return; }
  loading.remove();
  ETK_STATE.variant = null;   // reset filter when entering a chassis

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
  setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back', fn: showEtk }]);
}

// A custom searchable dropdown for the 297 variants -- the native <select> is
// unstyleable and unsearchable. Options: "All variants" plus one per variant,
// sorted by model+date, filterable by a search box. Sets ETK_STATE.variant.
function buildVariantDropdown(variants) {
  const order = variants.map((v, i) => ({ i, v, text: variantLabel(v) }))
    .sort((a, b) => (a.v.model || '').localeCompare(b.v.model || '') ||
                    String(a.v.date).localeCompare(String(b.v.date)));

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
    if (ev) { ev.preventDefault(); ev.stopPropagation(); }
    ETK_STATE.variant = idx;
    cur.textContent = text;
    cur.classList.toggle('etk-vdd-filtered', idx != null);
    close();
  }

  function renderList(q) {
    list.innerHTML = '';
    const ql = (q || '').toLowerCase();
    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'etk-vdd-opt' + (ETK_STATE.variant == null ? ' active' : '');
    all.textContent = `All variants (${variants.length})`;
    all.onclick = (e) => choose(null, `All variants (${variants.length})`, e);
    if (!ql) list.appendChild(all);
    let shown = 0;
    for (const o of order) {
      if (ql && !o.text.toLowerCase().includes(ql)) continue;
      if (++shown > 200) break;   // cap the DOM; search narrows it
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'etk-vdd-opt' + (ETK_STATE.variant === o.i ? ' active' : '');
      el.textContent = o.text;
      el.onclick = (e) => choose(o.i, o.text, e);
      list.appendChild(el);
    }
  }

  let outside = null;
  function open() {
    menu.hidden = false; search.value = ''; renderList(''); search.focus();
    // arm the outside-click closer on the NEXT tick so this same click that
    // opened the menu doesn't immediately close it.
    setTimeout(() => {
      outside = (e) => { if (!root.contains(e.target)) close(); };
      document.addEventListener('click', outside);
    }, 0);
  }
  function close() {
    menu.hidden = true;
    if (outside) { document.removeEventListener('click', outside); outside = null; }
  }

  btn.type = 'button';
  btn.onclick = (e) => { e.stopPropagation(); menu.hidden ? open() : close(); };
  search.oninput = () => renderList(search.value);
  search.onclick = (e) => e.stopPropagation();

  return root;
}

function variantLabel(v) {
  const parts = [];
  if (v.model) parts.push(v.model);
  if (v.body) parts.push(v.body);
  if (v.motor) parts.push(v.motor);
  if (v.steer) parts.push(v.steer === 'R' ? 'RHD' : v.steer === 'L' ? 'LHD' : v.steer);
  if (v.gear) { const g = { A: 'auto', M: 'man.', N: '' }[v.gear]; if (g) parts.push(g); }
  if (v.date) {
    const d = String(v.date);
    if (d.length === 8) parts.push(`${d.slice(0, 4)}-${d.slice(4, 6)}`);
  }
  return parts.join(' · ');
}

// A main group opened: the wiring-style split -- its function-group tree of
// diagrams on the left, the selected diagram on the right, all honouring the
// active variant filter.
function showEtkGroup(data, chassisId, mg) {
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
  document.body.classList.add('wds-nofkeys');

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

  let selectedLeaf = null;
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
      leaf.onclick = () => {
        if (selectedLeaf) selectedLeaf.classList.remove('active');
        leaf.classList.add('active');
        selectedLeaf = leaf;
        renderDiagram(data, id, d, viewEl);
      };
      kids.appendChild(leaf);
    });
    grp.appendChild(hdr);
    grp.appendChild(kids);
    treeEl.appendChild(grp);
  });

  // open the first diagram so the pane isn't empty
  const firstLeaf = treeEl.querySelector('.etk-tleaf');
  if (firstLeaf) firstLeaf.click();

  sbLeft.textContent = mg.name;
  // a back action so the mobile top-left chevron appears (and Esc works),
  // returning to this chassis's main-group grid. The F-key bar itself is
  // hidden here (wds-nofkeys), but the chevron/Esc still fire this.
  setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
                fn: () => showEtkChassis(id) }]);
}

// parts count honouring the active variant filter
function countFit(parts) {
  if (ETK_STATE.variant == null) return parts.length;
  return parts.filter((p) => !p.fit || p.fit.includes(ETK_STATE.variant)).length;
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
  const parts = d.parts.filter((p) =>
    ETK_STATE.variant == null || !p.fit || p.fit.includes(ETK_STATE.variant));

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
  sbRight.textContent = `${parts.length} part${parts.length === 1 ? '' : 's'}`
    + (filtered ? ` (of ${d.parts.length})` : '');
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
