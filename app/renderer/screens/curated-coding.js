// Curated feature-toggle coding: a hand-picked shortlist of owner-facing E46
// options, the friendly tier over the expert tree (showDatenReference).
//
// NOT a write tool. It reads the module, shows each option as a toggle at the
// car's current value, and stages changes -- the send path still does not exist
// (see coding-edit.js's header and the four write gates).
//
// E46-first. Values come from the DATEN map at runtime, so an entry only shows
// when the car's module actually carries it.

// group -> ordered [sgbd, FSW keyword]. Keywords verified present in
// BMW_DATEN_MAP for E46; a missing one is skipped.
const CURATED_E46 = {
  Mirrors: [
    ['zke5', 'BEIKLAPPEN_GM'], // folding outside mirrors
    ['zke5', 'BEIKLAPP_B_KOMFORTSCHL_GM'], // fold on comfort-close
    ['zke5', 'SPIEGELMEMORY_GM'], // mirror memory
    ['zke5', 'SPIEGELABKLAPPEN_GM'], // passenger curb tilt in reverse
  ],
  'Locking & Remote': [
    ['zke5', 'ZV_SELEKTIV'], // 1 press = driver door
    ['zke5', 'VERRIEGELN_AUT_NACH_2_MIN'], // auto re-lock after 2 min
    ['zke5', 'KOMFORTOEFFNUNG_FB'], // comfort open from key
    ['zke5', 'KOMFORTSCHLIESSUNG_FB'], // comfort close from key
  ],
  Windows: [
    ['zke5', 'FH_FAHRERTUER_TIPP_AUF'], // one-touch driver up
    ['zke5', 'FH_FAHRERTUER_TIPP_ZU'],
    ['zke5', 'EINKLEMMSCH_VORNE'], // anti-pinch front
    ['zke5', 'EINKLEMMSCH_HINTEN'], // anti-pinch rear
  ],
  Lighting: [
    ['lsz', 'TAGFAHRLICHT'], // DRL
    ['lsz', 'PO_ALS_DRL'], // position lights as DRL
    ['lsz', 'NSL_ALS_STANDLICHT'], // rear fog as standing light
    ['zke5', 'INNENLICHT_AN_MEHRFACH_ZV'], // double-lock -> interior lights
  ],
  'Alarm (DWA)': [
    ['zke5', 'DWA'], // anti-theft alarm
    ['zke5', 'FUNK_INNENRAUMSCHUTZ'], // ultrasonic interior
    ['zke5', 'NEIGUNGSGEBER'], // tilt sensor
  ],
  'Chimes & Warnings': [
    ['kombi46', 'AKUSTIK_GURT_WARN'], // seatbelt gong
    ['kombi46', 'LICHTWARNUNG'], // lights-left-on warning
  ],
};

// per-chassis curated maps (only E46 for now; others fall back to none)
const CURATED = { E46: CURATED_E46 };

// Does this chassis have a curated feature list?
function hasCurated(chassisId) {
  return !!CURATED[String(chassisId || '').toUpperCase()];
}

// Resolve one curated entry against the DATEN map: {sgbd, name, label, on, off}
// or null if not all present. on/off are the mask-normalised numbers, read from
// DATEN so a flipped enum (LICHTWARNUNG is aktiv=00) is handled.
async function curatedResolve(sgbd, kw) {
  const daten = typeof datenFor === 'function' ? await datenFor(sgbd) : null;
  if (!daten) return null;
  const ch = daten.chassis.E46 || daten.chassis[Object.keys(daten.chassis)[0]];
  if (!ch) return null;
  for (const variant of Object.values(ch)) {
    const f = variant.find((x) => x.name.toUpperCase() === kw.toUpperCase());
    if (!f) continue;
    // find the aktiv / nicht_aktiv pair by name (value is the mask-normalised
    // hex in DATEN), handling both polarities
    let on = null,
      off = null;
    for (const [n, v] of f.values || []) {
      const num = parseInt(v, 16);
      if (Number.isNaN(num)) continue;
      const nl = String(n).toLowerCase();
      // OFF first: "nicht_aktiv" also ends in "aktiv", so match negatives first
      if (/nicht_aktiv|^inaktiv$|^aus$|^nein$|^nicht_|^ohne_/.test(nl)) {
        off = num;
      } else if (/^aktiv$|^ein$|^ja$|^mit_/.test(nl)) {
        on = num;
      }
    }
    if (on == null || off == null) continue;
    const i18n = (typeof window !== 'undefined' && window.BMW_DATEN_I18N) || {};
    const label =
      i18n[kw.toLowerCase()] ||
      (typeof codTidy === 'function'
        ? codTidy(codTranslate(kw, true), kw)
        : kw);
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

// The curated feature screen: reads each module once, shows every option as a
// toggle at the car's current value, and stages changes -- nothing is sent.
async function showCuratedCoding(chassisId, container, back, scan, reScan) {
  const cont = container || view;
  const setPanel = () => {
    if (cont !== view) cont.className = 'results-panel';
  };
  if (typeof loadDatenMap === 'function') await loadDatenMap();

  let groups = await curatedFeatures(chassisId);
  // Drop features whose module the car did not answer. The curated list is
  // written per chassis, not per car, so it names hardware this one may not
  // carry (on a real E46 eight of fifteen codeable modules never answered --
  // SMG2, RDC, DWA, mirror memory...). A feature for a module that is not
  // there is not a setting the user can have. The hub's scan is what knows;
  // opened standalone there is no scan and the list stays as written.
  const seenStatus = (scan && scan.status) || null;
  if (
    seenStatus &&
    seenStatus.size &&
    !(typeof demoMode === 'function' && demoMode())
  ) {
    const live = (sg) => {
      const s = seenStatus.get(sg);
      return s && (s.state === 'ok' || s.state === 'raw');
    };
    groups = groups
      .map((g) => ({ ...g, items: g.items.filter((i) => live(i.sgbd)) }))
      .filter((g) => g.items.length);
  }
  if (!groups.length) {
    setPanel();
    cont.innerHTML = errorBlock(
      `No curated coding options are mapped for ${dispChassis(chassisId)} yet. ` +
        `Use the Coding map for the full per-module function tree.`
    );
    if (back)
      setActions([
        {
          key: 'Escape',
          keyLabel: 'Esc',
          label: 'Back',
          kind: 'back',
          fn: back,
        },
      ]);
    return;
  }

  const sgbds = [...new Set(groups.flatMap((g) => g.items.map((i) => i.sgbd)))];
  const readJobFor = (sgbd) =>
    typeof codingFor === 'function' ? codingFor(sgbd) : null;

  // BMW's bit-level description per module, for reading settings out of a raw
  // coding blob (see the DATEN fallback in applyScan)
  const datenCache = new Map();
  if (typeof datenFor === 'function') {
    for (const sg of sgbds) {
      try {
        const d = await datenFor(sg);
        if (d) datenCache.set(sg, d);
      } catch {
        /* no DATEN for this module: name-matching only */
      }
    }
  }

  // current value per "sgbd:name", and staged edits
  const current = new Map();
  const staged = new Map();
  const key = (it) => `${it.sgbd}:${it.name}`;
  let readOk = false;

  const demo = typeof demoMode === 'function' && demoMode();

  // Map the car's coding onto our features from the hub's scan (or read here if
  // opened standalone). Most curated functions live only in the DATEN blob and
  // are NOT named in the SGBD's coding read (BEIKLAPPEN_GM vs COD_MIT_*), so the
  // round-trip resolves only a few. Demo mode fills the rest deterministically.
  const applyScan = (cache) => {
    for (const g of groups)
      for (const it of g.items) {
        const got = cache && cache.get(it.sgbd);
        let hit = got ? curatedMatchResult(it.name, got) : null;
        // Nothing NAMED matched. Modules that answer with the raw coding blob
        // (zke5's COD_DATEN, szm46's CODE) name nothing at all, so every feature
        // on them read as unknown and drew as off -- the library default shown
        // as if it were the car. BMW's DATEN map says which bit this keyword is;
        // read it out of the bytes the ECU actually returned.
        if (hit == null && got && typeof codReadDaten === 'function') {
          const bytes = codBytesOf(
            got.get('COD_DATEN') ?? got.get('CODE') ?? got.get('CODIERDATEN')
          );
          const daten = datenCache.get(it.sgbd);
          if (bytes && daten) {
            const idx =
              typeof codingIndexFromScan === 'function'
                ? codingIndexFromScan(cache, it.sgbd)
                : null;
            const f = codDatenField(daten, chassisId, idx, it.name);
            // only trust a field from the variant the car's index actually
            // selects: the same keyword sits at a different word per index
            if (f && f.exact) hit = codReadDaten(bytes, f);
          }
        }
        if (hit != null) {
          current.set(key(it), hit);
          continue;
        }
        if (demo) {
          let h = 0;
          for (const c of it.name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
          current.set(key(it), h % 2 === 0 ? it.on : it.off);
        }
      }
  };
  const readAll = async () => {
    if (scan) {
      applyScan(scan);
      readOk = true;
      return;
    }
    const cache = new Map();
    for (const sgbd of sgbds) {
      let entry = null;
      try {
        entry = await readJobFor(sgbd);
      } catch {
        entry = null;
      }
      if (!entry || !entry.read) continue;
      try {
        const d = await api(`/api/ecu/${sgbd}/run/${entry.read}`, {
          method: 'POST',
        });
        cache.set(sgbd, new Map(flatResults(d.sets)));
      } catch {
        /* module unreadable now: leave unknown */
      }
    }
    applyScan(cache);
    readOk = true;
  };

  const isOn = (it) => {
    if (staged.has(key(it))) return staged.get(key(it)) === it.on;
    const cur = current.get(key(it));
    return cur != null ? cur === it.on : null; // null = unknown
  };

  const draw = () => {
    setPanel();
    const changed = [...staged.keys()];
    cont.innerHTML =
      `
      <div class="act-menu cur-menu">
        <div class="act-menu-title">Features</div>
        <div class="act-menu-sub">${esc(dispChassis(chassisId))} · ` +
      `curated coding options</div>
        <div class="cod-note" id="cur-note"></div>
        <div class="cur-groups" id="cur-groups"></div>
      </div>`;
    const note = cont.querySelector('#cur-note');
    note.innerHTML = !readOk
      ? `<span class="cod-note-dim">Reading the car…</span>`
      : changed.length
        ? `<span class="cod-note-staged">${changed.length} change` +
          `${changed.length === 1 ? '' : 's'} staged</span>` +
          `<span class="cod-note-dim"> · nothing has been sent</span>`
        : `<span class="cod-note-dim">Tap a feature to stage it. ` +
          `Nothing is sent to the car.</span>`;

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
        row.innerHTML =
          `
          <span class="cur-label">${esc(it.label)}</span>
          <span class="cur-toggle${on === true ? ' on' : ''}` +
          `${on == null ? ' unknown' : ''}">
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
    // Re-read: re-scan the whole car if the hub provided it, else just these
    // modules. kind:'navAction' surfaces it top-right on mobile.
    acts.push({
      key: '1',
      keyLabel: 'F1',
      kind: 'navAction',
      label: readOk ? 'Re-read' : 'Read',
      fn: reScan
        ? reScan
        : async () => {
            readOk = false;
            draw();
            await readAll();
            draw();
          },
    });
    if (staged.size) {
      acts.push({
        key: '2',
        keyLabel: 'F2',
        label: `Review (${staged.size})`,
        fn: () => curatedReview(chassisId, groups, staged, current),
      });
      acts.push({
        key: '3',
        keyLabel: 'F3',
        label: 'Discard',
        fn: () => {
          staged.clear();
          draw();
        },
      });
    }
    if (back)
      acts.push({
        key: 'Escape',
        keyLabel: 'Esc',
        label: 'Back',
        kind: 'back',
        fn: back,
      });
    setActions(acts);
    sbLeft.textContent =
      `${dispChassis(chassisId)} · features` +
      `${staged.size ? ` · ${staged.size} staged` : ''}`;
  };

  draw();
  await readAll();
  draw();
}

// Pair a DATEN keyword to a value in the SGBD's coding read, which names the
// setting differently -- match on shared tokens, reduce to the on/off numbers.
// thin wrapper over the shared coding-edit.js matcher (returns the raw number)
function curatedMatchResult(kw, got) {
  return typeof codMatchRead === 'function' ? codMatchRead(kw, got) : null;
}

// The staged-changes review: what WOULD be sent. Demo mode says the write is
// simulated; on a real car it says it is not sent.
function curatedReview(chassisId, groups, staged, current) {
  const rows = [];
  for (const g of groups)
    for (const it of g.items) {
      const k = `${it.sgbd}:${it.name}`;
      if (!staged.has(k)) continue;
      const to = staged.get(k) === it.on ? 'on' : 'off';
      const from = current.has(k)
        ? current.get(k) === it.on
          ? 'on'
          : 'off'
        : 'unknown';
      rows.push(
        codingReviewRow(it.label, `${it.sgbd}.prg · ${it.name}`, from, to)
      );
    }
  confirmDialog(codingReviewDialog('Staged features', rows));
}

// One review row: label, keyword + from->to. Shared by curated + expert reviews.
function codingReviewRow(label, sub, from, to) {
  return (
    `<div class="cod-rev-row">` +
    `<div class="cod-rev-label">${esc(label)}</div>` +
    `<div class="cod-rev-sub mono">${esc(sub)}</div>` +
    `<div class="cod-rev-change mono">${esc(from)} ` +
    `<span class="cod-rev-arrow">→</span> <b>${esc(to)}</b></div></div>`
  );
}

// The dialog body, demo-aware: demo mode simulates a "send", a real car refuses
// the write (unverified). Keep the "not sent" / EEPROM rationale below.
function codingReviewDialog(title, rows) {
  const demo = typeof demoMode === 'function' && demoMode();
  const foot = demo
    ? `<b>Demo mode.</b> No car is connected, so “Send” only simulates the ` +
      `coding write — nothing leaves the app and no ECU is touched.`
    : `<b>Not sent.</b> These map onto each module's coding write, but sending ` +
      `is disabled: a coding write is an EEPROM write, and this app has not ` +
      `verified a round-trip on a car that can be recovered.`;
  return {
    title,
    body:
      `<div class="cod-rev-list">${rows.join('')}</div>` +
      `<div class="cod-rev-foot">${foot}</div>`,
    confirmLabel: demo ? 'Send (demo)' : 'OK',
    cancelLabel: 'Close',
  };
}

if (typeof window !== 'undefined') {
  window.showCuratedCoding = showCuratedCoding;
  window.hasCurated = hasCurated;
  window.codingReviewRow = codingReviewRow;
  window.codingReviewDialog = codingReviewDialog;
}
