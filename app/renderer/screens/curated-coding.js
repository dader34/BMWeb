// Curated feature-toggle coding, the BimmerCode-style tier over the raw
// expert tree (showDatenReference / showCoding). A hand-picked shortlist of
// the owner-facing E46 coding options, grouped by what they do, with the
// friendly labels pulled from BMW_DATEN_I18N (NCS Dummy's community
// translations) rather than hand-authored -- those already read exactly like
// BimmerCode's ("Folding outside mirrors", "Comfort opening with remote").
//
// WHAT THIS IS NOT: a write tool. Like the rest of coding here it reads the
// module, shows each option as a toggle set to the car's current value, and
// stages changes -- the send path still does not exist (see coding-edit.js's
// header and the four write gates). This is the friendly FACE of the same
// read/stage surface, so the enthusiast does not have to hunt the raw tree.
//
// The shortlist is E46-first (the analysed useful modules: zke5/GM5 body,
// lsz lighting, kombi46 cluster). Each entry names the SGBD, the DATEN
// function keyword, and the group. Values come from the DATEN map at runtime,
// so an entry only shows when the car's module actually carries it.

// group -> ordered [sgbd, FSW keyword] the curated view offers. Keywords are
// verified present in BMW_DATEN_MAP for E46; a missing one is simply skipped.
const CURATED_E46 = {
  'Mirrors': [
    ['zke5', 'BEIKLAPPEN_GM'],              // folding outside mirrors
    ['zke5', 'BEIKLAPP_B_KOMFORTSCHL_GM'],  // fold on comfort-close
    ['zke5', 'SPIEGELMEMORY_GM'],           // mirror memory
    ['zke5', 'SPIEGELABKLAPPEN_GM'],        // passenger curb tilt in reverse
  ],
  'Locking & Remote': [
    ['zke5', 'ZV_SELEKTIV'],                // 1 press = driver door
    ['zke5', 'VERRIEGELN_AUT_NACH_2_MIN'],  // auto re-lock after 2 min
    ['zke5', 'KOMFORTOEFFNUNG_FB'],         // comfort open from key
    ['zke5', 'KOMFORTSCHLIESSUNG_FB'],      // comfort close from key
  ],
  'Windows': [
    ['zke5', 'FH_FAHRERTUER_TIPP_AUF'],     // one-touch driver up
    ['zke5', 'FH_FAHRERTUER_TIPP_ZU'],
    ['zke5', 'EINKLEMMSCH_VORNE'],          // anti-pinch front
    ['zke5', 'EINKLEMMSCH_HINTEN'],         // anti-pinch rear
  ],
  'Lighting': [
    ['lsz', 'TAGFAHRLICHT'],                // DRL
    ['lsz', 'PO_ALS_DRL'],                  // position lights as DRL
    ['lsz', 'NSL_ALS_STANDLICHT'],          // rear fog as standing light
    ['zke5', 'INNENLICHT_AN_MEHRFACH_ZV'],  // double-lock -> interior lights
  ],
  'Alarm (DWA)': [
    ['zke5', 'DWA'],                        // anti-theft alarm
    ['zke5', 'FUNK_INNENRAUMSCHUTZ'],       // ultrasonic interior
    ['zke5', 'NEIGUNGSGEBER'],              // tilt sensor
  ],
  'Chimes & Warnings': [
    ['kombi46', 'AKUSTIK_GURT_WARN'],       // seatbelt gong
    ['kombi46', 'LICHTWARNUNG'],            // lights-left-on warning
  ],
};

// per-chassis curated maps (only E46 for now; others fall back to none)
const CURATED = { E46: CURATED_E46 };

// Does this chassis have a curated feature list?
function hasCurated(chassisId) {
  return !!CURATED[String(chassisId || '').toUpperCase()];
}

// Resolve one curated entry against the DATEN map: returns
// {sgbd, name, label, on, off} or null if the module/function/values are not
// all present. `on`/`off` are the mask-normalised numbers for the two states,
// read from DATEN so a flipped enum (LICHTWARNUNG is aktiv=00) is handled.
async function curatedResolve(sgbd, kw) {
  const daten = typeof datenFor === 'function' ? await datenFor(sgbd) : null;
  if (!daten) return null;
  const ch = daten.chassis.E46
    || daten.chassis[Object.keys(daten.chassis)[0]];
  if (!ch) return null;
  for (const variant of Object.values(ch)) {
    const f = variant.find(x => x.name.toUpperCase() === kw.toUpperCase());
    if (!f) continue;
    // find the aktiv / nicht_aktiv pair by name, value is the mask-normalised
    // number (hex string in DATEN). Handles both value polarities.
    let on = null, off = null;
    for (const [n, v] of f.values || []) {
      const num = parseInt(v, 16);
      if (Number.isNaN(num)) continue;
      const nl = String(n).toLowerCase();
      // OFF first: "nicht_aktiv" also ends in "aktiv", so an on-check that
      // matched a trailing "aktiv" would wrongly claim it. Rule out the
      // negatives, THEN the positives.
      if (/nicht_aktiv|^inaktiv$|^aus$|^nein$|^nicht_|^ohne_/.test(nl)) {
        off = num;
      } else if (/^aktiv$|^ein$|^ja$|^mit_/.test(nl)) {
        on = num;
      }
    }
    if (on == null || off == null) continue;
    const i18n = (typeof window !== 'undefined' && window.BMW_DATEN_I18N) || {};
    const label = i18n[kw.toLowerCase()]
      || (typeof codTidy === 'function'
        ? codTidy(codTranslate(kw, true), kw) : kw);
    return { sgbd, name: kw, label, on, off };
  }
  return null;
}

// Build the resolved, grouped feature list for a chassis: [{group, items:[...]}]
async function curatedFeatures(chassisId) {
  const map = CURATED[String(chassisId || '').toUpperCase()];
  if (!map) return [];
  const out = [];
  for (const [group, entries] of Object.entries(map)) {
    const items = [];
    for (const [sgbd, kw] of entries) {
      const r = await curatedResolve(sgbd, kw);
      if (r) items.push(r);
    }
    if (items.length) out.push({ group, items });
  }
  return out;
}

// The curated feature screen. Reads each involved module once, shows every
// option as a toggle set to the car's current value, and stages changes --
// nothing is sent. `back` returns to whatever opened it.
async function showCuratedCoding(chassisId, container, back) {
  const cont = container || view;
  const setPanel = () => { if (cont !== view) cont.className = 'results-panel'; };
  if (typeof loadDatenMap === 'function') await loadDatenMap();

  const groups = await curatedFeatures(chassisId);
  if (!groups.length) {
    setPanel();
    cont.innerHTML = errorBlock(
      `No curated coding options are mapped for ${dispChassis(chassisId)} yet. `
      + `Use the Coding map for the full per-module function tree.`);
    if (back) setActions([{ key: 'Escape', keyLabel: 'Esc', label: 'Back',
                            kind: 'back', fn: back }]);
    return;
  }

  // which SGBDs we need to read, and the per-field current values once read
  const sgbds = [...new Set(groups.flatMap(g => g.items.map(i => i.sgbd)))];
  const readJobFor = (sgbd) =>
    (typeof codingFor === 'function' ? codingFor(sgbd) : null);

  // current value per "sgbd:name", and staged edits
  const current = new Map();
  const staged = new Map();
  const key = (it) => `${it.sgbd}:${it.name}`;
  let readOk = false;

  // read every involved module's coding once; map its answers onto our items
  // by matching the DATEN function to the SGBD's own result name. Best-effort:
  // where the SGBD names nothing readable, the toggle shows "unknown".
  const readAll = async () => {
    for (const sgbd of sgbds) {
      let entry = null;
      try { entry = await readJobFor(sgbd); } catch { entry = null; }
      if (!entry || !entry.read) continue;
      try {
        const d = await api(`/api/ecu/${sgbd}/run/${entry.read}`,
                            { method: 'POST' });
        const got = new Map(flatResults(d.sets));
        // pair by token overlap: the DATEN keyword vs the SGBD result names
        for (const g of groups) for (const it of g.items) {
          if (it.sgbd !== sgbd) continue;
          const hit = curatedMatchResult(it.name, got);
          if (hit != null) current.set(key(it), hit);
        }
      } catch { /* module unreadable now: leave unknown */ }
    }
    readOk = true;
  };

  const isOn = (it) => {
    if (staged.has(key(it))) return staged.get(key(it)) === it.on;
    const cur = current.get(key(it));
    return cur != null ? cur === it.on : null;   // null = unknown
  };

  const draw = () => {
    setPanel();
    const changed = [...staged.keys()];
    cont.innerHTML = `
      <div class="act-menu cur-menu">
        <div class="act-menu-title">Features</div>
        <div class="act-menu-sub">${esc(dispChassis(chassisId))} · `
      + `curated coding options</div>
        <div class="cod-note" id="cur-note"></div>
        <div class="cur-groups" id="cur-groups"></div>
      </div>`;
    const note = cont.querySelector('#cur-note');
    note.innerHTML = !readOk
      ? `<span class="cod-note-dim">Reading the car…</span>`
      : changed.length
        ? `<span class="cod-note-staged">${changed.length} change`
          + `${changed.length === 1 ? '' : 's'} staged</span>`
          + `<span class="cod-note-dim"> · nothing has been sent</span>`
        : `<span class="cod-note-dim">Tap a feature to stage it. `
          + `Nothing is sent to the car.</span>`;

    const host = cont.querySelector('#cur-groups');
    for (const g of groups) {
      const sec = document.createElement('div');
      sec.className = 'cur-group';
      sec.innerHTML = `<div class="cur-group-h">${esc(g.group)}</div>`;
      const list = document.createElement('div');
      list.className = 'cur-list';
      for (const it of g.items) {
        const on = isOn(it);
        const st = staged.has(key(it));
        const row = document.createElement('button');
        row.className = 'cur-row' + (st ? ' staged' : '');
        row.type = 'button';
        row.innerHTML = `
          <span class="cur-label">${esc(it.label)}</span>
          <span class="cur-toggle${on === true ? ' on' : ''}`
          + `${on == null ? ' unknown' : ''}">
            <span class="cur-knob"></span>
          </span>`;
        row.onclick = () => {
          const curOn = current.get(key(it));
          const nowOn = isOn(it);
          const next = nowOn === true ? it.off : it.on; // flip
          if (curOn != null && next === curOn) staged.delete(key(it));
          else staged.set(key(it), next);
          draw();
        };
        list.appendChild(row);
      }
      sec.appendChild(list);
      host.appendChild(sec);
    }
    setKeys();
  };

  const setKeys = () => {
    const acts = [];
    acts.push({ key: '1', keyLabel: 'F1', label: readOk ? 'Re-read' : 'Read',
      fn: async () => { readOk = false; draw(); await readAll(); draw(); } });
    if (staged.size) {
      acts.push({ key: '2', keyLabel: 'F2', label: `Review (${staged.size})`,
        fn: () => curatedReview(chassisId, groups, staged, current) });
      acts.push({ key: '3', keyLabel: 'F3', label: 'Discard',
        fn: () => { staged.clear(); draw(); } });
    }
    if (back) acts.push({ key: 'Escape', keyLabel: 'Esc', label: 'Back',
                          kind: 'back', fn: back });
    setActions(acts);
    sbLeft.textContent = `${dispChassis(chassisId)} · features`
      + `${staged.size ? ` · ${staged.size} staged` : ''}`;
  };

  draw();
  await readAll();
  draw();
}

// Pair a DATEN function keyword to a value in the SGBD's coding read. The two
// name the same setting differently, so match on shared tokens; returns the
// numeric value or null. Booleans in the read may be words (aktiv/1) -- reduce
// to the on/off number space the curated entry uses.
function curatedMatchResult(kw, got) {
  const toks = (s) => new Set(String(s)
    .replace(/^(COD|STAT|STATUS|CODIER)_/i, '').toUpperCase()
    .split('_').filter(t => t.length > 2));
  const kt = toks(kw);
  let best = null, bestOverlap = 0;
  for (const [name, val] of got) {
    const nt = toks(name);
    const overlap = [...kt].filter(t => nt.has(t)).length;
    if (overlap > bestOverlap && overlap >= Math.min(2, kt.size)) {
      bestOverlap = overlap; best = val;
    }
  }
  if (best == null) return null;
  const s = String(best).trim().toLowerCase();
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (typeof codIsOn === 'function' && typeof codKnown === 'function'
      && codKnown(s)) return codIsOn(s) ? 1 : 0;
  return null;
}

// The staged-changes review: exactly what WOULD be sent, and the refusal --
// the same contract the expert editor keeps.
function curatedReview(chassisId, groups, staged, current) {
  const rows = [];
  for (const g of groups) for (const it of g.items) {
    const k = `${it.sgbd}:${it.name}`;
    if (!staged.has(k)) continue;
    const to = staged.get(k) === it.on ? 'on' : 'off';
    const from = current.has(k)
      ? (current.get(k) === it.on ? 'on' : 'off') : 'unknown';
    rows.push(`<div class="ident-line"><span class="ident-lk">`
      + `${esc(it.label)}</span><span class="ident-lv mono">`
      + `${esc(it.sgbd)}.prg · ${esc(it.name)} : ${from} → ${to}</span></div>`);
  }
  confirmDialog({
    title: 'Staged features',
    body: `<div class="ident-card">${rows.join('')}</div><br>`
      + `<b>Not sent.</b> These map onto each module's coding write, but `
      + `sending is disabled: a coding write is an EEPROM write, and this app `
      + `has not verified a round-trip on a car that can be recovered. Use `
      + `this to check the change, not to apply it.`,
    confirmLabel: 'OK', cancelLabel: 'Close',
  });
}

if (typeof window !== 'undefined') {
  window.showCuratedCoding = showCuratedCoding;
  window.hasCurated = hasCurated;
}
