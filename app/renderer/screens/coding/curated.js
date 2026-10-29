/**
 * @file Curated feature-toggle coding: a hand-picked shortlist of owner-facing
 * E46 options, the friendly tier over the expert tree.
 *
 * NOT a write tool. It reads the module, shows each option as a toggle at the
 * car's current value, and stages changes -- the send path for this tier does
 * not exist (the expert tree is the only screen that writes, through the four
 * write gates; see screens/coding/write-review.js).
 *
 * E46-first. Values come from the DATEN map at runtime, so an entry only shows
 * when the car's module actually carries it.
 */

/**
 * One curated feature, resolved against the DATEN map.
 * @typedef {Object} CuratedItem
 * @property {string} sgbd - the module.
 * @property {string} name - the DATEN keyword.
 * @property {string} label - the display label.
 * @property {number} on - the mask-normalised "on" value.
 * @property {number} off - the mask-normalised "off" value.
 */

/**
 * A named group of curated features.
 * @typedef {Object} CuratedGroup
 * @property {string} group - the group heading.
 * @property {CuratedItem[]} items - the features.
 */

/**
 * group -> ordered [coding file, FSW keyword], the file under NCS's own name
 * (SGET's SGNAME: GM5, LSZ, KMB_E46). A feature shows when the car's scan
 * found a module on that file and the keyword is in it; else it is skipped.
 * @type {Record<string, Array<[string, string]>>}
 */
const CURATED_E46 = {
  Mirrors: [
    ['GM5', 'BEIKLAPPEN_GM'], // folding outside mirrors
    ['GM5', 'BEIKLAPP_B_KOMFORTSCHL_GM'], // fold on comfort-close
    ['GM5', 'SPIEGELMEMORY_GM'], // mirror memory
    ['GM5', 'SPIEGELABKLAPPEN_GM'], // passenger curb tilt in reverse
  ],
  'Locking & Remote': [
    ['GM5', 'ZV_SELEKTIV'], // 1 press = driver door
    ['GM5', 'VERRIEGELN_AUT_NACH_2_MIN'], // auto re-lock after 2 min
    ['GM5', 'KOMFORTOEFFNUNG_FB'], // comfort open from key
    ['GM5', 'KOMFORTSCHLIESSUNG_FB'], // comfort close from key
  ],
  Windows: [
    ['GM5', 'FH_FAHRERTUER_TIPP_AUF'], // one-touch driver up
    ['GM5', 'FH_FAHRERTUER_TIPP_ZU'],
    ['GM5', 'EINKLEMMSCH_VORNE'], // anti-pinch front
    ['GM5', 'EINKLEMMSCH_HINTEN'], // anti-pinch rear
  ],
  Lighting: [
    ['LSZ', 'TAGFAHRLICHT'], // DRL
    ['LSZ', 'PO_ALS_DRL'], // position lights as DRL
    ['LSZ', 'NSL_ALS_STANDLICHT'], // rear fog as standing light
    ['GM5', 'INNENLICHT_AN_MEHRFACH_ZV'], // double-lock -> interior lights
  ],
  'Alarm (DWA)': [
    ['GM5', 'DWA'], // anti-theft alarm
    ['GM5', 'FUNK_INNENRAUMSCHUTZ'], // ultrasonic interior
    ['GM5', 'NEIGUNGSGEBER'], // tilt sensor
  ],
  'Chimes & Warnings': [
    ['KMB_E46', 'AKUSTIK_GURT_WARN'], // seatbelt gong
    ['KMB_E46', 'LICHTWARNUNG'], // lights-left-on warning
  ],
};

/**
 * Per-chassis curated maps (only E46 for now; others fall back to none).
 * @type {Record<string, Record<string, Array<[string, string]>>>}
 */
const CURATED = { E46: CURATED_E46 };

/** Value names meaning "off" -- tested FIRST: "nicht_aktiv" also ends in "aktiv". */
const CURATED_OFF_RE = /nicht_aktiv|^inaktiv$|^aus$|^nein$|^nicht_|^ohne_/;
/** Value names meaning "on". */
const CURATED_ON_RE = /^aktiv$|^ein$|^ja$|^mit_/;

/**
 * Does this chassis have a curated feature list?
 * @param {string} chassisId - chassis id (any case).
 * @returns {boolean} true when a curated map exists.
 */
function hasCurated(chassisId) {
  return !!CURATED[String(chassisId || '').toUpperCase()];
}

/**
 * Resolve one curated entry against the DATEN map. on/off are the
 * mask-normalised numbers, read from DATEN so a flipped enum (LICHTWARNUNG is
 * aktiv=00) is handled.
 * @param {string} sgbd - the module.
 * @param {string} kw - the DATEN keyword.
 * @returns {Promise<CuratedItem|null>} the item, or null if not all present.
 */
async function curatedResolve(sgbd, kw) {
  const daten = typeof datenFor === 'function' ? await datenFor(sgbd) : null;
  // (sgbd is the scanned module's key; its coding file was registered by
  // the scan -- see curatedFeatures)
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
      if (CURATED_OFF_RE.test(nl)) {
        off = num;
      } else if (CURATED_ON_RE.test(nl)) {
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

/**
 * Build the resolved, grouped feature list for a chassis.
 * @param {string} chassisId - chassis id.
 * @returns {Promise<CuratedGroup[]>} the groups that resolved to at least
 *   one feature.
 */
async function curatedFeatures(chassisId, scan) {
  const map = CURATED[String(chassisId || '').toUpperCase()];
  if (!map) return [];
  // coding file -> the scanned module on it (GM5 -> "gm5", LSZ -> "alsz")
  const onFile = new Map();
  for (const m of (scan && scan.mods) || [])
    if (m.file) onFile.set(String(m.file).split('.')[0].toUpperCase(), m.sgbd);
  const out = [];
  for (const [group, entries] of Object.entries(map)) {
    const items = [];
    for (const [file, kw] of entries) {
      const mod = onFile.get(file);
      if (!mod) continue; // the car has no module on that file
      const r = await curatedResolve(mod, kw);
      if (r) items.push(r);
    }
    if (items.length) out.push({ group, items });
  }
  return out;
}

/**
 * The curated feature screen: reads each module once, shows every option as
 * a toggle at the car's current value, and stages changes -- nothing is sent.
 * @param {string} chassisId - chassis id.
 * @param {HTMLElement} [container] - where to draw (default: the main view).
 * @param {(() => void)|null} [back] - the Back action.
 * @param {ScanCache|null} [scan] - the hub's scan, when opened from it.
 * @param {(() => Promise<void>)|null} [reScan] - the hub's re-read, when any.
 * @returns {Promise<void>} resolves once drawn and read.
 */
async function showCuratedCoding(chassisId, container, back, scan, reScan) {
  const cont = container || view;
  const setPanel = () => {
    if (cont !== view) cont.className = 'results-panel';
  };
  if (typeof loadDatenMap === 'function') await loadDatenMap();

  // the features are found on the modules the car has: read it first when
  // opened on its own (the hub hands its scan over)
  if (!scan) scan = await scanCoding(chassisId, document.createElement('div'));
  let groups = await curatedFeatures(chassisId, scan);
  // Drop features whose module the car did not answer. The curated list is
  // written per chassis, not per car, so it names hardware this one may not
  // carry (on a real E46 eight of fifteen codeable modules never answered --
  // SMG2, RDC, DWA, mirror memory...). A feature for a module that is not
  // there is not a setting the user can have. The hub's scan is what knows;
  // opened standalone there is no scan and the list stays as written.
  const seenStatus = (scan && scan.status) || null;
  if (seenStatus && seenStatus.size) {
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
  // BMW's description of each module's coding: where every setting lives
  const datenCache = new Map();
  if (typeof datenFor === 'function') {
    for (const sg of sgbds) {
      try {
        const d = await datenFor(sg);
        if (d) datenCache.set(sg, d);
      } catch {
        /* no description for this module: its features stay unknown */
      }
    }
  }

  // current value per "sgbd:name", and staged edits
  const current = new Map();
  const staged = new Map();
  const key = (it) => `${it.sgbd}:${it.name}`;
  let readOk = false;

  // Each feature's setting, read from its own address in the module's coding
  // image (the hub's scan read the images). The address is the one the
  // module's own coding index selects; a feature whose module or address was
  // not read stays unknown and draws as unknown.
  const applyScan = (cache) => {
    for (const g of groups)
      for (const it of g.items) {
        const image = cache && cache.images && cache.images.get(it.sgbd);
        const daten = datenCache.get(it.sgbd);
        if (!image || !daten) continue;
        const f = codDatenField(
          daten,
          chassisId,
          codingIndexFromScan(cache, it.sgbd),
          it.name
        );
        if (!f || !f.exact) continue;
        const hex = codingImageValue(f, image);
        if (hex != null) current.set(key(it), parseInt(hex, 16));
      }
  };

  const readAll = async () => {
    // opened on its own: read the car the way the hub does
    applyScan(
      scan || (await scanCoding(chassisId, document.createElement('div')))
    );
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

/**
 * The staged-changes review: what WOULD be sent. It says the write is not
 * sent.
 * @param {string} chassisId - chassis id (unused; kept for the call shape).
 * @param {CuratedGroup[]} groups - the features.
 * @param {Map<string, number>} staged - "sgbd:name" -> staged value.
 * @param {Map<string, number>} current - "sgbd:name" -> current value.
 * @returns {void}
 */
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

if (typeof window !== 'undefined') {
  window.showCuratedCoding = showCuratedCoding;
  window.hasCurated = hasCurated;
}
