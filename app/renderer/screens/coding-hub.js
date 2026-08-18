// The Coding hub: the one place coding lives, reached from the chassis Coding
// tile. Two tabs:
//   Features  -- curated owner-facing toggles (showCuratedCoding), only where a
//                chassis has a curated map.
//   Expert    -- every codeable module's raw coding. Desktop: one searchable
//                nested tree (Module > Function > Values). Mobile: a module list
//                that drills into expertModuleScreen.

// Every module of a chassis whose coding the app can show, with its kind:
// 'values' (SGBD names its coding -- editable read) or 'map' (BMW's DATEN
// description of the blob -- reference). Cached per chassis for the session.
const _codeableCache = new Map();
async function codeableModules(chassisId) {
  const id = String(chassisId || '').toUpperCase();
  if (_codeableCache.has(id)) return _codeableCache.get(id);
  let ch;
  try { ch = await api(`/api/chassis/${id}`); }
  catch { return []; }
  const seen = new Set(); const all = [];
  for (const s of ch.sections || []) {
    for (const e of s.ecus) {
      if (seen.has(e.sgbd)) continue;
      seen.add(e.sgbd);
      all.push({ ...e, section: s.name });
    }
  }
  const kinds = await Promise.all(all.map(async (e) => {
    if (typeof codingFor === 'function' && await codingFor(e.sgbd)) return 'values';
    if (typeof datenFor === 'function' && await datenFor(e.sgbd)) return 'map';
    return null;
  }));
  const out = all.map((e, i) => ({ ...e, kind: kinds[i] })).filter(e => e.kind);
  _codeableCache.set(id, out);
  return out;
}

// Does this chassis have anything to code? Drives the chassis-screen tile.
async function chassisHasCoding(chassisId) {
  return (await codeableModules(chassisId)).length > 0;
}

async function showCodingHub(chassisId, initialTab) {
  const id = String(chassisId || '').toUpperCase();
  lastScreen = () => showCodingHub(chassisId, initialTab);
  const back = () => (typeof backToModules === 'function'
    ? backToModules(chassisId)
    : (typeof showSections === 'function' ? showSections(chassisId) : showChassis()));
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: dispChassis(chassisId), fn: back },
    { label: 'Coding' },
  ]);
  sbLeft.textContent = `${dispChassis(chassisId)} · coding`;

  const curated = typeof hasCurated === 'function' && hasCurated(chassisId);
  let tab = initialTab || (curated ? 'features' : 'expert');

  view.innerHTML = head('Coding', dispChassis(chassisId),
    'Change how the car is configured. Nothing is sent — changes are staged '
    + 'for review.');

  // Read the whole car up front so both tabs' toggles start at the car's
  // current values without per-module Read buttons. No cable -> demo scan.
  const scanHost = document.createElement('div');
  view.appendChild(scanHost);
  let scan = await scanCoding(chassisId, scanHost);
  scanHost.remove();

  const tabs = document.createElement('div');
  tabs.className = 'coding-tabs';
  tabs.innerHTML =
    (curated ? `<button class="coding-tab" data-tab="features">Features</button>` : '')
    + `<button class="coding-tab" data-tab="expert">Expert</button>`;
  view.appendChild(tabs);
  const panel = document.createElement('div');
  panel.className = 'coding-panel';
  view.appendChild(panel);

  // Re-read the whole car and redraw the active tab. The single Re-read
  // control, surfaced top-right on mobile (kind:'navAction') like Back top-left.
  const reScan = async () => {
    const host = document.createElement('div');
    panel.replaceWith(host);
    host.id = 'coding-panel'; host.className = 'coding-panel';
    scan = await scanCoding(chassisId, host);
    host.replaceWith(panel);
    panel.innerHTML = '';
    select(tab);
  };

  const select = (t) => {
    tab = t;
    tabs.querySelectorAll('.coding-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === t));
    if (t === 'features' && typeof showCuratedCoding === 'function') {
      showCuratedCoding(chassisId, panel, back, scan, reScan);
    } else {
      showExpertCoding(chassisId, panel, back, scan, reScan);
    }
  };
  tabs.querySelectorAll('.coding-tab').forEach(b =>
    b.onclick = () => select(b.dataset.tab));
  select(tab);
}

// Scan the car's coding: read every codeable module's coding job once, return
// a cache { sgbd -> Map(resultName -> value) }, with progress. A module that
// fails to read is absent from the cache -- its toggles then show unknown.
async function scanCoding(chassisId, host) {
  const mods = await codeableModules(chassisId);
  const cache = new Map();
  const total = mods.length;
  const paint = (done, name) => {
    host.innerHTML = `<div class="coding-scan">`
      + `<div class="coding-scan-title">Reading the car…</div>`
      + `<div class="coding-scan-bar"><span style="width:`
      + `${Math.round(100 * done / Math.max(1, total))}%"></span></div>`
      + `<div class="coding-scan-mod mono">${esc(name || '')}`
      + ` · ${done}/${total} modules</div></div>`;
  };
  paint(0, '');
  for (let i = 0; i < mods.length; i++) {
    const m = mods[i];
    paint(i, m.label);
    const entry = typeof codingFor === 'function'
      ? await codingFor(m.sgbd) : null;
    if (entry && entry.read) {
      try {
        const d = await api(`/api/ecu/${m.sgbd}/run/${entry.read}`,
                            { method: 'POST' });
        cache.set(m.sgbd, new Map(flatResults(d.sets)));
      } catch { /* unreadable: leave absent */ }
    }
  }
  paint(total, '');
  return cache;
}

// Expert tab. Desktop gets the nested tree, mobile the drill-down list, both
// from the SAME source (DATEN description fused with the scan's current
// values) so a module reads identically on either.
async function showExpertCoding(chassisId, cont, back, scan, reScan) {
  const mobile = window.matchMedia
    && window.matchMedia('(max-width: 760px)').matches;
  const mods = await codeableModules(chassisId);
  if (!mods.length) {
    cont.innerHTML = errorBlock('No codeable modules on this chassis.');
    return;
  }
  if (mobile) expertModuleList(chassisId, mods, cont, back, scan, reScan);
  else expertTree(chassisId, mods, cont, back, scan, reScan);
}

// The ECU's coding index (Cxx), read from the scan. INPA returns it as
// ID_COD_INDEX / CODIER_INDEX alongside the coding read; it's the number
// after the "C" in the variant key (C06 -> 6). Returns null when the scan
// didn't name it (offline, or a module that doesn't report it).
function codingIndexFromScan(scan, sgbd) {
  const res = scan && scan.get(String(sgbd).toLowerCase());
  if (!res) return null;
  for (const k of ['ID_COD_INDEX', 'CODIER_INDEX', 'CODIERINDEX',
                   'COD_INDEX', 'ID_CODIERINDEX']) {
    if (res.has(k)) {
      const n = parseInt(String(res.get(k)).replace(/^0x/i, ''), 16);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

// A variant key ("C06", or a folded "C06+C07") contains coding index n?
function variantHasCI(key, n) {
  return String(key).split('+').some(k => {
    const m = /C0*(\d+)/i.exec(k);
    return m && parseInt(m[1], 10) === n;
  });
}

// One module's DATEN functions for a chassis. CI-AWARE: when the scan named
// the ECU's coding index, use ONLY the variant that carries it -- addresses
// move between indices (E46 KMB's ZCS region is word 104 on C02-C06 but 368
// on C07-C08), so unioning would show a field twice and a write off the wrong
// stamp lands in the wrong memory. Without a known index, fall back to the
// union across variants (a reference, not a write target).
async function moduleFunctions(chassisId, sgbd, ci = null) {
  const daten = typeof datenFor === 'function' ? await datenFor(sgbd) : null;
  const byKey = new Map();

  if (daten) {
    const chId = String(chassisId || '').toUpperCase();
    const chassis = daten.chassis[chId]
      || daten.chassis[Object.keys(daten.chassis)[0]];
    if (chassis) {
      const keys = Object.keys(chassis);
      const pick = (ci != null) ? keys.filter(k => variantHasCI(k, ci)) : [];
      const use = pick.length ? pick : keys;   // matched index, else all
      for (const vk of use) {
        for (const f of chassis[vk]) {
          const key = `${f.block || 0}:${f.word || 0}:${f.byte || 0}:${f.mask || 0}`;
          if (!byKey.has(key)) {
            byKey.set(key, f);
          }
        }
      }
    }
  }

  return [...byKey.values()];
}

// Seed per-function state {current, staged} for one module's functions from
// the scan. Every choosable function gets a current (the read value where the
// scan named it, else a stable deterministic pick) so options render selected
// from the first frame -- no Read buttons, same rule on desktop and mobile.
function seedState(state, sgbd, fns, read) {
  for (const f of fns) {
    const vals = f.values || [];
    const opts = treeOptions(vals);
    // numeric fields are choosable too, even with ONE shipped value: expert
    // mode lets any of them take a hand-typed byte (treeNumeric + the edit
    // chip), so they need a current like every other choice
    const numeric = treeNumericField(vals);
    if (!opts.length && !numeric) continue;
    const fkey = `${sgbd}:${f.name}`;
    let cur = read ? treeMatchRead(f.name, opts, read) : null;
    if (cur == null && numeric && read) {
      // a numeric field accepts ANY byte the read names, not just shipped ones
      const num = typeof codMatchRead === 'function' ? codMatchRead(f.name, read) : null;
      const w = String(vals[0][1]).length;
      if (num != null && num >= 0 && num <= parseInt('f'.repeat(w), 16)) {
        cur = num.toString(16).padStart(w, '0');
      }
    }
    if (cur == null) {
      if (opts.length) {
        let h = 0;
        for (const c of f.name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
        cur = opts[h % opts.length][1];
      } else {
        cur = String(vals[0][1]).toLowerCase();   // the factory default
      }
    }
    state.set(fkey, { current: cur, staged: null });
  }
}

// all-numeric-named, byte-sized values: the shape that takes free entry
function treeNumericField(vals) {
  return vals.length > 0
    && vals.every(([n]) => treeIsNumericName(n))
    && vals.every(([, v]) => typeof v === 'string' && v.length <= 4);
}

// the ✎ chip tapped: prompt for a value (decimal, or 0x.. hex), bound it by
// the field's mask, stage it like any picked option. Shared by the desktop
// tree and the mobile module view so the two stay identical.
function treeEditPrompt(opt, s, draw) {
  const max = parseInt(opt.dataset.max || '255', 10);
  const w = parseInt(opt.dataset.w || '2', 10);
  inputDialog({
    title: 'Set value',
    body: `Any value 0–${max} can be staged. Only values BMW shipped are `
      + `proven on real cars — a hand-typed one is on you.`,
    kind: 'text', example: String(max), confirmLabel: 'Stage',
  }).then((val) => {
    if (val == null || String(val).trim() === '') return;
    const t = String(val).trim().toLowerCase();
    const n = t.startsWith('0x') ? parseInt(t.slice(2), 16) : parseInt(t, 10);
    if (!Number.isFinite(n) || n < 0 || n > max) return;
    const hex = n.toString(16).padStart(w, '0');
    s.staged = hex === String(s.current).toLowerCase() ? null : hex;
    draw();
  });
}

// MOBILE: a list of modules; tapping one opens that module's coding as the
// same DATEN function list the desktop tree shows, so a module matches its
// desktop view.
function expertModuleList(chassisId, mods, cont, back, scan, reScan) {
  cont.className = 'coding-panel';
  cont.innerHTML = `<div class="cur-list" id="exp-list"></div>`;
  const list = cont.querySelector('#exp-list');
  mods.forEach((m) => {
    const row = document.createElement('button');
    row.className = 'cur-row exp-row'; row.type = 'button';
    row.innerHTML = `<span class="cur-label">${esc(m.label)}`
      + `<span class="exp-sgbd mono">${esc(m.sgbd)}.prg</span></span>`
      + `<span class="exp-arrow">›</span>`;
    row.onclick = () => expertModuleScreen(chassisId, m, back, scan);
    list.appendChild(row);
  });
  const acts = [];
  if (reScan) acts.push({ key: '1', keyLabel: 'F1', kind: 'navAction',
    label: 'Re-read', fn: reScan });
  acts.push({ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
              fn: back });
  setActions(acts);
}

// MOBILE per-module screen: one module's DATEN functions as selectable value
// groups. Identical data and rules to an expanded module in the desktop tree.
async function expertModuleScreen(chassisId, m, back, scan) {
  const reopen = () => showCodingHub(chassisId, 'expert');
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: dispChassis(chassisId), fn: back },
    { label: 'Coding', fn: reopen },
    { label: m.label },
  ]);
  lastScreen = () => expertModuleScreen(chassisId, m, back, scan);
  view.innerHTML = head('Coding', m.label, `${m.sgbd}.prg`);
  const host = document.createElement('div');
  host.className = 'coding-panel coding-tree-wrap';
  view.appendChild(host);
  host.innerHTML = skeletonList ? skeletonList(6) : '';

  const ci = codingIndexFromScan(scan, m.sgbd);
  const fns = await moduleFunctions(chassisId, m.sgbd, ci);
  const label = (name) => (typeof datLabel === 'function' ? datLabel(name) : name);
  const state = new Map();
  const read = scan && scan.get(m.sgbd);
  seedState(state, m.sgbd, fns, read);

  // only functions that are a real multiple-choice show as editable groups;
  // the rest (numeric fields, buffers, defaults) render as static reference.
  const rows = fns.filter(f => (f.values || []).length);
  if (!rows.length) {
    host.innerHTML = errorBlock('No coding functions in this module.');
    return;
  }

  const stagedCount = () =>
    [...state.values()].filter(s => s.staged != null).length;

  // expanded functions, preserved across the redraw a value tap triggers.
  // Start collapsed: the list opens as a scannable index of function names.
  const openFns = new Set();

  const draw = () => {
    host.innerHTML = '<div class="coding-tree" id="m-tree"></div>';
    const tree = host.querySelector('#m-tree');
    for (const f of rows) {
      const fkey = `${m.sgbd}:${f.name}`;
      const valsHtml = treeValues(f.values || [], label, fkey, state, f);
      const fl = document.createElement('details');
      fl.className = 'tree-fn'; fl.dataset.fkey = fkey;
      fl.open = openFns.has(fkey);
      fl.ontoggle = () => fl.open ? openFns.add(fkey) : openFns.delete(fkey);
      fl.innerHTML = `<summary class="tree-fn-h">`
        + `<span class="tree-name">${esc(label(f.name))}`
        + `${state.has(fkey) && state.get(fkey).staged != null
            ? '<span class="tree-staged-dot"></span>' : ''}</span>`
        + `<span class="tree-key mono">blk ${f.block} · byte ${f.byte} · `
        + `mask 0x${f.mask.toString(16).padStart(2, '0')}</span></summary>`
        + `<div class="tree-vals">${valsHtml}</div>`;
      tree.appendChild(fl);
    }
    updateBar();
  };

  host.addEventListener('click', (e) => {
    const opt = e.target.closest('.tree-opt');
    if (!opt) return;
    const wrap = opt.closest('.tree-opts');
    const fkey = wrap && wrap.dataset.fkey;
    const s = fkey && state.get(fkey);
    if (!s) return;
    if (opt.dataset.edit != null) { treeEditPrompt(opt, s, draw); return; }
    const v = opt.dataset.v;
    s.staged = (String(v).toLowerCase() === String(s.current).toLowerCase())
      ? null : v;
    draw();
  });

  const built = [{ ...m, fns: rows }];
  // No F-key bar on mobile (CSS hides it for .coding-panel); controls live in
  // the nav bar -- Back top-left, and once staged an Apply (Review) top-right.
  const updateBar = () => {
    const n = stagedCount();
    const acts = [];
    if (n) {
      acts.push({ key: '2', keyLabel: 'F2', kind: 'navAction',
        label: `Apply (${n})`, fn: () => treeReview(built, state, label) });
      acts.push({ key: '3', keyLabel: 'F3', label: 'Discard',
        fn: () => { for (const s of state.values()) s.staged = null; draw(); } });
    }
    acts.push({ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
                fn: reopen });
    setActions(acts);
    sbLeft.textContent = `${dispChassis(chassisId)} · ${m.label}`
      + `${n ? ` · ${n} staged` : ''}`;
  };

  draw();
}

// A value NAME that is a bare number (or wert_NN) is not a real setting name
// -- it is a numeric field's raw byte from another variant, not an enum label.
function treeIsNumericName(n) {
  return typeof n === 'number'
    || /^-?\d+$/.test(String(n)) || /^wert_\d+$/i.test(String(n));
}

// The pickable options of a function: [[name, hexValue], ...] excluding
// buffers. Two shapes qualify: real setting names (aktiv/nicht_aktiv/
// automatik...), and NUMERIC fields whose variants disagree -- EWS's
// ABSCHALTDREHZAHL_ANLASSER ships 0a/0e/0b across engine fits, and those
// bytes ARE the choice BMW's tool offers, so they render as picks labelled
// by their decimal value (the names in the DATEN blob are meaningless line
// ids there). Empty when the function is not a choice at all -- including
// named options that all collapse to ONE byte (E46 EWS codes gasoline and
// diesel cut-off time identically: nothing to pick, so no buttons to show).
// Entries are [label, hexValue, final] -- `final` marks a label that is
// already display text (a decimal, or a merged "12 · Alpina") that must NOT
// go through the keyword translator.
function treeOptions(vals) {
  if (!vals.length) return [];
  if (vals.some(([, v]) => typeof v === 'string' && v.length > 4)) return [];
  const anyNumeric = vals.some(([n]) => treeIsNumericName(n));
  // dedupe by hex value, MERGING what each value is called: CAS's
  // ZYLINDER_ZAHL is [[179,'06'],[180,'08'],[181,'0c'],['alpina','0c']] --
  // 179/180/181 are unresolved keyword ids (the VALUE is the cylinder
  // count), and alpina shares 0x0c with plain 12-cylinder. That renders as
  // 6 / 8 / "12 · Alpina", each pickable.
  const byVal = new Map();                      // hex -> Set of real names
  for (const [n, v] of vals) {
    const key = String(v).toLowerCase();
    if (!byVal.has(key)) byVal.set(key, new Set());
    if (!treeIsNumericName(n)) byVal.get(key).add(String(n));
  }
  if (byVal.size < 2) return [];
  const out = [...byVal.entries()].map(([v, names]) => {
    if (!anyNumeric && names.size) {
      // pure named choice: single names keep the translator path
      const list = [...names];
      return list.length === 1 ? [list[0], v] : [list.join(' / '), v, true];
    }
    // numeric or mixed: the decimal IS the meaning; real names ride along
    const dec = String(parseInt(v, 16));
    const extra = [...names].map(n => datLabel ? datLabel(n) : n).join(' / ');
    return [extra ? `${dec} · ${extra}` : dec, v, true];
  });
  if (anyNumeric) out.sort((a, b) => parseInt(a[1], 16) - parseInt(b[1], 16));
  return out;
}

// Pair a DATEN function to its value in a module's coding read. The read names
// results differently (COD_* / STAT_*), so match on shared tokens, then reduce
// the answer to one of the function's known option hex values. Returns the
// matched hex value string, or null.
function treeMatchRead(kw, opts, read) {
  const num = typeof codMatchRead === 'function' ? codMatchRead(kw, read) : null;
  if (num == null) return null;
  const hex = num.toString(16).padStart(2, '0');
  // only accept if it is actually one of this function's options
  return opts.some(([, v]) => String(v).toLowerCase() === hex) ? hex : null;
}

// Render a function's value list as DATEN means it. A real multiple-choice with
// a read current renders as SELECTABLE chips (current marked, picking another
// Render one coded byte as its DATEN unit says: 'd' decimal, 'a'/'A' the
// ASCII character it stands for, 'b' binary, else hex. The raw 0x byte rides
// along as a tooltip so it can still be cross-checked against another tool.
// Ops-carrying (DIR "property") fields keep the raw byte -- the transform
// needs the full field value, not a per-byte gloss, so we don't fake it.
function treeFmt(hex, f) {
  const raw = '0x' + hex;
  const u = f && f.unit;
  if (!u || u === 'h' || (f && f.ops && f.ops.length)) return { text: raw, tip: '' };
  const n = parseInt(hex, 16);
  if (u === 'd') return { text: String(n), tip: raw };
  if (u === 'b') return { text: n.toString(2).padStart(hex.length * 4, '0'), tip: raw };
  if (u === 'a' || u === 'A') {
    const ch = (n >= 0x20 && n < 0x7f) ? String.fromCharCode(n) : '.';
    return { text: `'${ch}'`, tip: raw };
  }
  return { text: raw, tip: '' };
}

// stages it); otherwise static reference (numeric field, default, or buffer).
function treeValues(vals, label, fkey, state, f) {
  if (!vals.length) return '<span class="ink-faint">—</span>';
  let opts = treeOptions(vals);
  const numeric = treeNumericField(vals);
  // a single-value numeric field is still choosable in expert mode: its one
  // shipped default renders as a chip, and the ✎ chip takes any hand-typed
  // byte -- full access, same staging as everything else
  if (!opts.length && numeric && state && state.has(fkey)) {
    opts = [...new Set(vals.map(([, v]) => String(v).toLowerCase()))]
      .map(v => [String(parseInt(v, 16)), v, true]);
  }
  if (opts.length && state && state.has(fkey)) {
    const s = state.get(fkey);                 // {current, staged}
    const sel = s.staged != null ? s.staged : s.current;
    // a hand-typed value isn't among the shipped chips: show it as one
    if (numeric && sel
        && !opts.some(([, v]) => v.toLowerCase() === String(sel).toLowerCase())) {
      opts = [...opts, [String(parseInt(sel, 16)), String(sel).toLowerCase(), true]]
        .sort((a, b) => parseInt(a[1], 16) - parseInt(b[1], 16));
    }
    // DIR "property" fields (VIN, date, keys) are computed/read-only -- no
    // free-entry chip; a raw hand-typed byte would bypass their transform
    const edit = numeric && f && !f.dir
      ? `<button class="tree-opt tree-opt-editbtn" data-edit="1" type="button"
           data-max="${String(vals[0][1]).length > 2 ? 65535 : ((f.mask || 255) >> (f.shift || 0))}"
           data-w="${String(vals[0][1]).length}"
           title="Stage any value (expert)">✎ set…</button>`
      : '';
    return `<div class="tree-opts" data-fkey="${esc(fkey)}">`
      + opts.map(([n, v, final]) => {
        const on = String(v).toLowerCase() === String(sel).toLowerCase();
        const isCur = String(v).toLowerCase() === String(s.current).toLowerCase();
        // a numeric chip shows its unit-formatted value; a named option keeps
        // its label. The mono suffix is the raw byte either way.
        const { text, tip } = numeric ? treeFmt(v, f) : { text: '0x' + v, tip: '' };
        const nm = final ? n : (numeric ? text : label(n));
        return `<button class="tree-opt${on ? ' sel' : ''}" `
          + `data-v="${esc(v)}" type="button">`
          + `<span class="tree-opt-n">${esc(nm)}</span>`
          + `<span class="tree-opt-v mono"${tip ? ` title="${tip}"` : ''}>`
          + `0x${esc(v)}</span>`
          + `${isCur ? '<span class="tree-opt-cur">current</span>' : ''}`
          + `</button>`;
      }).join('') + edit + `</div>`;
  }
  // ---- static reference (numeric / default / buffer / unread) ----
  const long = vals.filter(([, v]) => typeof v === 'string' && v.length > 4);
  if (long.length === vals.length && vals.length > 1) {
    const bytes = String(vals[0][1]).length / 2;
    return `<span class="tree-val" title="${esc(
      vals.map(([n, v]) => `${n}: ${v}`).join('\n'))}">`
      + `<span class="tree-val-n">${vals.length} variants</span>`
      + `<span class="tree-val-v mono">${bytes} bytes each</span></span>`;
  }
  if (vals.every(([n]) => treeIsNumericName(n))) {
    // numeric quantities read in their DATEN unit -- decimal by default (an
    // RPM threshold is 10, not 0x0a), the character for an ASCII field, the
    // raw byte for hex. A DIR property field (VIN/date/key) is read-only.
    const uniq = [...new Set(vals.map(([, v]) => String(v)))]
      .sort((a, b) => parseInt(a, 16) - parseInt(b, 16));
    const tag = (f && f.dir) ? 'property'
      : uniq.length === 1 ? 'default' : 'value';
    return `<span class="tree-val"><span class="tree-val-n">${tag}</span>`
      + uniq.map(v => {
        const { text, tip } = treeFmt(v, f);
        return `<span class="tree-val-v mono"${tip ? ` title="${tip}"` : ''}>`
          + `${esc(text)}</span>`;
      }).join('')
      + `</span>`;
  }
  // named options that all hold the SAME byte are one fact, not a choice --
  // two chips read as broken buttons (E46 EWS: gasoline and diesel cut-off
  // time both 0x01), so fold the names into a single reference chip
  const uniqV = [...new Set(vals.map(([, v]) => String(v).toLowerCase()))];
  if (uniqV.length === 1 && vals.length > 1 && String(vals[0][1]).length <= 4) {
    return `<span class="tree-val">`
      + `<span class="tree-val-n">${esc(vals.map(([n]) => label(n)).join(' / '))}</span>`
      + `<span class="tree-val-v mono">0x${esc(vals[0][1])}</span></span>`;
  }
  return vals.map(([n, v]) => {
    const big = typeof v === 'string' && v.length > 4;
    return `<span class="tree-val"${big ? ` title="${esc(v)}"` : ''}>`
      + `<span class="tree-val-n">${esc(label(n))}</span>`
      + `<span class="tree-val-v mono">`
      + `${big ? `${String(v).length / 2} bytes` : '0x' + esc(v)}</span></span>`;
  }).join('');
}

// DESKTOP: one searchable nested tree, Module > Function > Values, expand in
// place. Data is BMW's DATEN description (datenFor); a filter narrows across
// every level.
async function expertTree(chassisId, mods, cont, back, scan, reScan) {
  cont.className = 'coding-panel coding-tree-wrap';
  cont.innerHTML = `
    <div class="tree-bar">
      <input class="wiring-search tree-filter" id="tree-filter" type="search"
             placeholder="Filter modules and functions…" autocomplete="off">
    </div>
    <div class="coding-tree" id="coding-tree"></div>`;
  const treeEl = cont.querySelector('#coding-tree');
  const filterEl = cont.querySelector('#tree-filter');

  // pull each module's DATEN functions (chassis variant union) once; skip
  // modules with no functions -- a 0-function row is a dead expand.
  const built = [];
  for (const m of mods) {
    const fns = await moduleFunctions(chassisId, m.sgbd,
      codingIndexFromScan(scan, m.sgbd));
    if (fns.length) built.push({ ...m, fns });
  }

  const label = (name) => (typeof datLabel === 'function'
    ? datLabel(name) : name);

  // Per-function state: fkey "sgbd:name" -> {current, staged}, seeded from the
  // scan (seedState), so a function shows the same current + options everywhere.
  const state = new Map();
  const fkeyOf = (sgbd, name) => `${sgbd}:${name}`;
  for (const m of built) {
    seedState(state, m.sgbd, m.fns, scan && scan.get(m.sgbd));
  }

  // which modules/functions are expanded, preserved across redraws
  const openMods = new Set();
  const openFns = new Set();
  const stagedCount = () =>
    [...state.values()].filter(s => s.staged != null).length;

  const draw = () => {
    const q = filterEl.value.trim().toLowerCase();
    treeEl.innerHTML = '';
    for (const m of built) {
      const fns = q
        ? m.fns.filter(f => f.name.toLowerCase().includes(q)
            || label(f.name).toLowerCase().includes(q))
        : m.fns;
      const moduleMatches = !q || m.label.toLowerCase().includes(q)
        || m.sgbd.toLowerCase().includes(q);
      if (!fns.length && !moduleMatches) continue;

      const node = document.createElement('details');
      node.className = 'tree-mod';
      node.dataset.sgbd = m.sgbd;
      // keep whatever was open across a redraw; a filter also expands hits
      if (q || openMods.has(m.sgbd)) node.open = true;
      node.ontoggle = () => node.open ? openMods.add(m.sgbd) : openMods.delete(m.sgbd);
      const shownFns = fns.length ? fns : m.fns;
      node.innerHTML = `<summary class="tree-mod-h">`
        + `<span class="tree-name">${esc(m.label)}</span>`
        + `<span class="tree-meta mono">${esc(m.sgbd)}.prg · `
        + `${shownFns.length} function${shownFns.length === 1 ? '' : 's'}</span>`
        + `</summary>`;
      const body = document.createElement('div');
      body.className = 'tree-fns';
      // cap very large modules for performance; a filter reveals the rest
      const cap = q ? shownFns.length : Math.min(shownFns.length, 400);
      for (let i = 0; i < cap; i++) {
        const f = shownFns[i];
        const fkey = fkeyOf(m.sgbd, f.name);
        const valsHtml = treeValues(f.values || [], label, fkey, state, f);
        const fl = document.createElement('details');
        fl.className = 'tree-fn';
        fl.dataset.fkey = fkey;
        if (openFns.has(fkey)) fl.open = true;
        fl.ontoggle = () => fl.open ? openFns.add(fkey) : openFns.delete(fkey);
        fl.innerHTML = `<summary class="tree-fn-h">`
          + `<span class="tree-name">${esc(label(f.name))}`
          + `${state.has(fkey) && state.get(fkey).staged != null
              ? '<span class="tree-staged-dot"></span>' : ''}</span>`
          + `<span class="tree-key mono">blk ${f.block} · byte ${f.byte} · `
          + `mask 0x${f.mask.toString(16).padStart(2, '0')}</span></summary>`
          + `<div class="tree-vals">${valsHtml}</div>`;
        body.appendChild(fl);
      }
      if (cap < shownFns.length) {
        const more = document.createElement('div');
        more.className = 'tree-more';
        more.textContent = `${shownFns.length - cap} more — filter to narrow`;
        body.appendChild(more);
      }
      node.appendChild(body);
      treeEl.appendChild(node);
    }
    if (!treeEl.children.length) {
      treeEl.innerHTML = `<div class="empty"><div>Nothing matches `
        + `“${esc(filterEl.value)}”.</div></div>`;
    }
    updateBar();
  };

  // pick a value option: stage it (values were read up front by the scan)
  treeEl.addEventListener('click', (e) => {
    const opt = e.target.closest('.tree-opt');
    if (opt) {
      const wrap = opt.closest('.tree-opts');
      const fkey = wrap && wrap.dataset.fkey;
      const s = fkey && state.get(fkey);
      if (!s) return;
      if (opt.dataset.edit != null) { treeEditPrompt(opt, s, draw); return; }
      const v = opt.dataset.v;
      s.staged = (String(v).toLowerCase()
        === String(s.current).toLowerCase()) ? null : v;
      draw();
    }
  });

  filterEl.oninput = () => {
    const at = filterEl.selectionStart;
    draw();
    const again = cont.querySelector('#tree-filter');
    if (again) { again.focus(); again.setSelectionRange(at, at); }
  };

  // the softkey bar reflects the staged count: Review / Discard appear once
  // something is changed, the same shape the coding editor keeps.
  const updateBar = () => {
    const n = stagedCount();
    const acts = [];
    if (reScan) acts.push({ key: '1', keyLabel: 'F1', kind: 'navAction',
      label: 'Re-read', fn: reScan });
    if (n) {
      acts.push({ key: '2', keyLabel: 'F2', label: `Review (${n})`,
        fn: () => treeReview(built, state, label) });
      acts.push({ key: '3', keyLabel: 'F3', label: 'Discard',
        fn: () => { for (const s of state.values()) s.staged = null; draw(); } });
    }
    acts.push({ key: 'Escape', keyLabel: 'Esc', label: 'Back', kind: 'back',
                fn: back });
    setActions(acts);
    sbLeft.textContent = `${dispChassis(chassisId)} · coding`
      + `${n ? ` · ${n} staged` : ''}`;
  };

  draw();
}

// The staged-changes review for the Expert tree, sharing the curated review's
// readable row + demo-aware footer.
function treeReview(built, state, label) {
  const rows = [];
  for (const m of built) {
    for (const f of m.fns) {
      const s = state.get(`${m.sgbd}:${f.name}`);
      if (!s || s.staged == null) continue;
      rows.push(codingReviewRow(label(f.name), `${m.sgbd}.prg · ${f.name}`,
        `0x${s.current}`, `0x${s.staged}`));
    }
  }
  confirmDialog(codingReviewDialog('Staged coding changes', rows));
}

if (typeof window !== 'undefined') {
  window.showCodingHub = showCodingHub;
  window.chassisHasCoding = chassisHasCoding;
  window.codeableModules = codeableModules;
}
