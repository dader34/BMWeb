/**
 * @file Navigation voice languages: choose three, see what INPA would send.
 *
 * INPA's "languages load" key runs on the PC; only the NEXT key
 * (SPEICHER_SCHREIBEN) sends anything. Decompiling NAVI.IPO shows that job
 * takes three plain integers -- SPEICHER_SCHREIBEN SPRACHE_1, SPRACHE_2,
 * SPRACHE_3 -- so "load a file" is really "choose three language codes".
 *
 * Codes come from BMW's CODESPRACHEN table (navmk4.prg); bit 7 is voice
 * gender (0x01 English UK male, 0x81 female). Extras like 0x09 are beyond
 * the table.
 *
 * THE SEND IS BLOCKED, like the coding writes: SPEICHER_SCHREIBEN makes the
 * nav reload its voice data, and wrong codes leave it with no working
 * language, recovered only by writing again through the nav you just broke.
 * This stages the change and shows the exact job and arguments -- and does
 * only this.
 */

/**
 * One selectable voice language.
 * @typedef {object} NavLanguage
 * @property {number} code - The code that goes on the wire.
 * @property {string} label - English label ("English UK, female").
 * @property {string} raw - The table's own text, or the extra's name.
 * @property {boolean} [extra] - Not in the ECU's table; from NAVI.IPO.
 */

/** Languages beyond the stock table, from the keys BMW hardcodes in NAVI.IPO. */
const NAV_LANG_EXTRA = { 0x09: 'dutch', 0x0a: 'russian' };
/** Bit 7 of a language code selects the female voice. */
const NAV_LANG_FEMALE = 0x80;
/** How many languages the nav loads at once. */
const NAV_LANG_SLOTS = 3;

/**
 * One entry per language, from the ECU's own CODESPRACHEN table. GOTCHA:
 * the table lists each language twice (male/female) and several codes
 * repeat one language (0x01, 0x05, 0x08 are all English UK) -- both
 * preserved, since the code is what goes on the wire and two codes are not
 * interchangeable.
 * @param {string} sgbd - The nav SGBD.
 * @returns {Promise<NavLanguage[]>} The languages, by code.
 */
async function navLanguages(sgbd) {
  let rows = [];
  try {
    rows = await api(`/api/ecu/${sgbd}/table/CODESPRACHEN`);
  } catch {
    /* no table shipped: the extras below still work */
  }
  const out = [];
  (rows || []).forEach((r) => {
    const code = parseInt(r.CODE, 16);
    if (!Number.isFinite(code)) return;
    out.push({ code, label: navLangLabel(r.SPRACHEN), raw: r.SPRACHEN });
  });
  // BMW's own extras, where the table does not reach
  Object.entries(NAV_LANG_EXTRA).forEach(([n, name]) => {
    const code = Number(n);
    [code, code | NAV_LANG_FEMALE].forEach((c) => {
      if (out.some((o) => o.code === c)) return;
      out.push({
        code: c,
        label: `${name}, ${c & NAV_LANG_FEMALE ? 'female' : 'male'}`,
        raw: name,
        extra: true,
      });
    });
  });
  out.sort((a, b) => a.code - b.code);
  return out;
}

/** The table's German words, in English. */
const NAV_LANG_WORDS = {
  deutsch: 'German',
  englisch: 'English',
  italienisch: 'Italian',
  spanisch: 'Spanish',
  franzoesisch: 'French',
  maennlich: 'male',
  weiblich: 'female',
  keine: 'no',
  sprache: 'language',
};

/**
 * "englisch UK weiblich" -> "English UK, female".
 * @param {unknown} s - The table's text.
 * @returns {string} The English label.
 */
function navLangLabel(s) {
  const parts = String(s || '')
    .split(/\s+/)
    .filter(Boolean);
  const words = parts.map((p) => NAV_LANG_WORDS[p.toLowerCase()] || p);
  // the gender is the last word; set it off with a comma
  const last = words[words.length - 1];
  if (last === 'male' || last === 'female') {
    return `${words.slice(0, -1).join(' ')}, ${last}`;
  }
  return words.join(' ');
}

/**
 * Is this ECU one whose languages we can work with?
 * @param {{ sgbd?: string }} ecu - The module.
 * @param {{ jobs?: string[] }|null|undefined} ir - Its decoded script, if
 *   any.
 * @returns {boolean} True when it declares SPEICHER_SCHREIBEN, or (without
 *   a script) is a nav by name.
 */
function hasNavLanguages(ecu, ir) {
  const jobs = ir && ir.jobs;
  if (Array.isArray(jobs)) return jobs.includes('SPEICHER_SCHREIBEN');
  return /^nav/i.test(ecu.sgbd || '');
}

/**
 * The language picker: three slots, and the exact job that is NOT sent.
 * @param {{ sgbd: string }} ecu - The nav module.
 * @param {HTMLElement|null|undefined} container - The view to draw into
 *   (the main view when absent).
 * @param {(() => void)|null|undefined} back - Back action, if any.
 * @returns {Promise<void>} Resolves once the picker is drawn.
 */
async function showNavLanguages(ecu, container, back) {
  const cont = container || view;
  const setPanel = () => {
    if (cont !== view) cont.className = 'results-panel';
  };

  const langs = await navLanguages(ecu.sgbd);
  let picked = new Array(NAV_LANG_SLOTS).fill(null);

  const byCode = (c) => langs.find((l) => l.code === c);

  const draw = () => {
    setPanel();
    const chosen = picked.filter((c) => c != null);
    const opt = (sel, i) =>
      `<option value=""${sel == null ? ' selected' : ''}>` +
      `— slot ${i + 1} —</option>` +
      langs
        .map(
          (l) =>
            `<option value="${l.code}"` +
            `${l.code === sel ? ' selected' : ''}>` +
            `${esc(l.label)} · ${hex(l.code)}</option>`
        )
        .join('');

    cont.innerHTML =
      `
      <div class="act-menu">
        <div class="act-menu-title">Load languages</div>
        <div class="act-menu-sub mono">${esc(ecu.sgbd)}.prg · ` +
      `SPEICHER_SCHREIBEN</div>
        <div class="cod-note"><span class="cod-note-dim">INPA loads these ` +
      `three from a file on the PC. They are just language codes, so pick ` +
      `them here.</span></div>
        <div class="nav-pickers">
          ${picked
            .map(
              (sel, i) => `<label class="dat-pick">Language ${i + 1}
            <select class="nav-pick" data-i="${i}">${opt(sel, i)}</select>
          </label>`
            )
            .join('')}
        </div>
        <div class="cod-blocked" id="nav-send"></div>
      </div>`;

    // what WOULD be sent, spelled out, and why it is not
    const send = cont.querySelector('#nav-send');
    if (chosen.length === NAV_LANG_SLOTS) {
      const args = picked.map(hex).join(';');
      const names = picked
        .map((c) => (byCode(c) || {}).label || hex(c))
        .map((n, i) => `${i + 1}. ${n}`)
        .join('   ');
      send.innerHTML =
        `<b>Not sent.</b> This would run ` +
        `<span class="mono">SPEICHER_SCHREIBEN</span> with ` +
        `<span class="mono">${esc(args)}</span><br>${esc(names)}<br><br>` +
        `Sending is disabled: the nav reloads its voice data from this, and ` +
        `wrong codes leave it with no working language, which is recovered ` +
        `by writing again through the nav you just broke.`;
    } else {
      send.innerHTML =
        `<span class="cod-note-dim">Choose three to see exactly ` +
        `what INPA would send. Nothing is written to the car.</span>`;
    }

    cont.querySelectorAll('.nav-pick').forEach((sel) => {
      sel.onchange = () => {
        picked[Number(sel.dataset.i)] =
          sel.value === '' ? null : Number(sel.value);
        draw();
      };
    });

    const acts = [];
    if (chosen.length) {
      acts.push({
        key: '3',
        keyLabel: 'F3',
        label: 'Clear',
        fn: () => {
          picked = new Array(NAV_LANG_SLOTS).fill(null);
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
    sbLeft.textContent = `${ecu.sgbd}.prg · load languages`;
    tipify(cont);
  };

  draw();
}
