// Navigation voice languages: choose three, see what INPA would send.
//
// INPA's "languages load" key runs on the PC; only the NEXT key
// (SPEICHER_SCHREIBEN) sends anything. Decompiling NAVI.IPO shows that job takes
// three plain integers -- SPEICHER_SCHREIBEN SPRACHE_1, SPRACHE_2, SPRACHE_3 --
// so "load a file" is really "choose three language codes".
//
// Codes come from BMW's CODESPRACHEN table (navmk4.prg); bit 7 is voice gender
// (0x01 English UK male, 0x81 female). Extras like 0x09 are beyond the table.
//
// THE SEND IS BLOCKED, like the coding writes: SPEICHER_SCHREIBEN makes the nav
// reload its voice data, and wrong codes leave it with no working language,
// recovered only by writing again through the nav you just broke. This stages
// the change and shows the exact job and arguments -- and does only this.

// Languages beyond the stock table, from the keys BMW hardcodes in NAVI.IPO.
const NAV_LANG_EXTRA = { 0x09: 'dutch', 0x0a: 'russian' };

// One entry per language, from the ECU's own CODESPRACHEN table. GOTCHA: the
// table lists each language twice (male/female) and several codes repeat one
// language (0x01, 0x05, 0x08 are all English UK) -- both preserved, since the
// code is what goes on the wire and two codes are not interchangeable.
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
    [code, code | 0x80].forEach((c) => {
      if (out.some((o) => o.code === c)) return;
      out.push({
        code: c,
        label: `${name}, ${c & 0x80 ? 'female' : 'male'}`,
        raw: name,
        extra: true,
      });
    });
  });
  out.sort((a, b) => a.code - b.code);
  return out;
}

// "englisch UK weiblich" -> "English UK, female"
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

// Is this ECU one whose languages we can work with?
function hasNavLanguages(ecu, ir) {
  const jobs = ir && ir.jobs;
  if (Array.isArray(jobs)) return jobs.includes('SPEICHER_SCHREIBEN');
  return /^nav/i.test(ecu.sgbd || '');
}

async function showNavLanguages(ecu, container, back) {
  const cont = container || view;
  const setPanel = () => {
    if (cont !== view) cont.className = 'results-panel';
  };

  const langs = await navLanguages(ecu.sgbd);
  let picked = [null, null, null];

  const byCode = (c) => langs.find((l) => l.code === c);

  const draw = () => {
    setPanel();
    const chosen = picked.filter((c) => c != null);
    const opt = (sel, i) =>
      `<option value=""${sel == null ? ' selected' : ''}>` +
      `\u2014 slot ${i + 1} \u2014</option>` +
      langs
        .map(
          (l) =>
            `<option value="${l.code}"` +
            `${l.code === sel ? ' selected' : ''}>` +
            `${esc(l.label)} \u00b7 ${hex(l.code)}</option>`
        )
        .join('');

    cont.innerHTML =
      `
      <div class="act-menu">
        <div class="act-menu-title">Load languages</div>
        <div class="act-menu-sub mono">${esc(ecu.sgbd)}.prg \u00b7 ` +
      `SPEICHER_SCHREIBEN</div>
        <div class="cod-note"><span class="cod-note-dim">INPA loads these ` +
      `three from a file on the PC. They are just language codes, so pick ` +
      `them here.</span></div>
        <div class="nav-pickers">
          ${[0, 1, 2]
            .map(
              (i) => `<label class="dat-pick">Language ${i + 1}
            <select class="nav-pick" data-i="${i}">${opt(picked[i], i)}</select>
          </label>`
            )
            .join('')}
        </div>
        <div class="cod-blocked" id="nav-send"></div>
      </div>`;

    // what WOULD be sent, spelled out, and why it is not
    const send = cont.querySelector('#nav-send');
    if (chosen.length === 3) {
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
          picked = [null, null, null];
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
    sbLeft.textContent = `${ecu.sgbd}.prg \u00b7 load languages`;
    tipify(cont);
  };

  draw();
}
