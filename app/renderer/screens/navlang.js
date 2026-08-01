// Navigation voice languages: read what is loaded, choose three, see what
// INPA would send.
//
// WHY THIS EXISTS. NAVI's "languages load" key is one of the handful that
// INPA runs on the PC rather than on the car: it reads a language table off
// a Windows filesystem, holds it in memory, and only the NEXT key
// (SPEICHER_SCHREIBEN) sends anything. That assembly lives in INPA's own
// runtime, not in the .IPO, so the key decompiles to a label and nothing
// else and the app honestly said "not decoded".
//
// But the FILE is not the interesting part. Hand-decompiling NAVI.IPO shows
// the job it feeds takes three plain integers:
//
//     SPEICHER_SCHREIBEN  SPRACHE_1, SPRACHE_2, SPRACHE_3   (int, int, int)
//
// so "load a file" really means "choose three language codes". No
// proprietary format, nothing to reverse: a picker does what the file did.
//
// THE CODES COME FROM BMW'S OWN TABLE (CODESPRACHEN in navmk4.prg), and bit 7
// is the voice gender: 0x01 is English UK male, 0x81 the same language female.
// BMW's own hardcoded "dutch" key sends 0x89;0x81;0x86 and prints "dutch,
// English UK and French" -- 0x81 and 0x86 match the table exactly, which is
// what validates this reading. 0x89 is 0x09|0x80, a language beyond the stock
// table, which is precisely why that key is hardcoded.
//
// THE SEND IS BLOCKED, like the coding writes. SPEICHER_SCHREIBEN makes the
// nav reload its voice data; wrong codes leave it without a working language,
// and recovering means writing again through the nav you just broke. This
// stages the change and shows the exact job and arguments. Reading is safe
// and runs for real.

// Languages beyond the stock table, from the keys BMW hardcodes in NAVI.IPO
// because CODESPRACHEN does not list them.
const NAV_LANG_EXTRA = { 0x09: 'dutch', 0x0a: 'russian' };

// One entry per language, from the ECU's own CODESPRACHEN table.
//
// The table lists each language twice, male and female, and several codes
// repeat a language (0x01, 0x05 and 0x08 are all English UK). Both facts are
// preserved rather than tidied away: the code is what goes on the wire, and
// two codes for one language are not interchangeable to the module.
async function navLanguages(sgbd) {
  let rows = [];
  try {
    rows = await api(`/api/ecu/${sgbd}/table/CODESPRACHEN`);
  } catch { /* no table shipped: the extras below still work */ }
  const out = [];
  (rows || []).forEach(r => {
    const code = parseInt(r.CODE, 16);
    if (!Number.isFinite(code)) return;
    out.push({ code, label: navLangLabel(r.SPRACHEN), raw: r.SPRACHEN });
  });
  // BMW's own extras, where the table does not reach
  Object.entries(NAV_LANG_EXTRA).forEach(([n, name]) => {
    const code = Number(n);
    [code, code | 0x80].forEach(c => {
      if (out.some(o => o.code === c)) return;
      out.push({ code: c, label: `${name}, ${c & 0x80 ? 'female' : 'male'}`,
                 raw: name, extra: true });
    });
  });
  out.sort((a, b) => a.code - b.code);
  return out;
}

// "englisch UK weiblich" -> "English UK, female"
const NAV_LANG_WORDS = {
  deutsch: 'German', englisch: 'English', italienisch: 'Italian',
  spanisch: 'Spanish', franzoesisch: 'French', maennlich: 'male',
  weiblich: 'female', keine: 'no', sprache: 'language',
};
function navLangLabel(s) {
  const parts = String(s || '').split(/\s+/).filter(Boolean);
  const words = parts.map(p => NAV_LANG_WORDS[p.toLowerCase()] || p);
  // the gender is the last word; set it off with a comma so the language reads
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
  const setPanel = () => { if (cont !== view) cont.className = 'results-panel'; };

  const langs = await navLanguages(ecu.sgbd);
  let current = null;           // what the module reports
  let picked = [null, null, null];
  let readErr = null;

  const byCode = (c) => langs.find(l => l.code === c);

  const draw = () => {
    setPanel();
    const chosen = picked.filter(c => c != null);
    const opt = (sel, i) => `<option value=""${sel == null ? ' selected' : ''}>`
      + `— slot ${i + 1} —</option>`
      + langs.map(l => `<option value="${l.code}"`
        + `${l.code === sel ? ' selected' : ''}>`
        + `${esc(l.label)} · 0x${l.code.toString(16).toUpperCase().padStart(2, '0')}`
        + `</option>`).join('');

    cont.innerHTML = `
      <div class="act-menu">
        <div class="act-menu-title">Voice languages</div>
        <div class="act-menu-sub mono">${esc(ecu.sgbd)}.prg · `
      + `SPEICHER_LESEN / SPEICHER_SCHREIBEN</div>
        <div class="cod-note" id="nav-note"></div>
        <div class="ident-card" id="nav-current"></div>
        <div class="nav-pickers">
          ${[0, 1, 2].map(i => `<label class="dat-pick">Language ${i + 1}
            <select class="nav-pick" data-i="${i}">${opt(picked[i], i)}</select>
          </label>`).join('')}
        </div>
        <div class="cod-blocked" id="nav-send"></div>
      </div>`;

    const note = cont.querySelector('#nav-note');
    const card = cont.querySelector('#nav-current');
    if (readErr) {
      card.innerHTML = errorBlock(readErr);
    } else if (!current) {
      card.innerHTML = `<div class="empty"><span class="loader"></span>`
        + `<span>Reading the module…</span></div>`;
    } else {
      card.innerHTML = current.map(([k, v]) =>
        `<div class="ident-line"><span class="ident-lk">${esc(k)}</span>`
        + `<span class="ident-lc">:</span>`
        + `<span class="ident-lv">${esc(v)}</span></div>`).join('')
        || `<div class="empty"><div>The module named no languages.</div></div>`;
    }
    note.innerHTML = current
      ? '<span class="cod-note-dim">What this nav computer currently has loaded.</span>'
      : '';

    // what WOULD be sent, spelled out, and why it is not
    const send = cont.querySelector('#nav-send');
    if (chosen.length === 3) {
      // hex, the way BMW writes it in its own hardcoded keys
      // (0x89;0x81;0x86), so the string can be compared with theirs directly
      const hex = (c) => `0x${c.toString(16).toUpperCase().padStart(2, '0')}`;
      const args = picked.map(hex).join(';');
      // each language already reads "English UK, female", so joining three of
      // them with commas ran them together; separate the slots clearly
      const names = picked
        .map(c => (byCode(c) || {}).label || `0x${c.toString(16)}`)
        .map((n, i) => `${i + 1}. ${n}`).join('   ');
      send.innerHTML = `<b>Not sent.</b> This would run `
        + `<span class="mono">SPEICHER_SCHREIBEN</span> with `
        + `<span class="mono">${esc(args)}</span> — ${esc(names)}. `
        + `Sending is disabled: the nav reloads its voice data from this, and `
        + `wrong codes leave it with no working language, which is recovered `
        + `by writing again through the nav you just broke. Use this to check `
        + `the codes, not to apply them.`;
    } else {
      send.innerHTML = `<span class="cod-note-dim">Choose three languages to `
        + `see exactly what INPA would send. Nothing is written to the car.`
        + `</span>`;
    }

    cont.querySelectorAll('.nav-pick').forEach(sel => {
      sel.onchange = () => {
        const i = Number(sel.dataset.i);
        picked[i] = sel.value === '' ? null : Number(sel.value);
        draw();
      };
    });

    const acts = [{ key: '1', keyLabel: 'F1', label: 'Read', kind: 'primary',
                    fn: doRead }];
    if (chosen.length) {
      acts.push({ key: '3', keyLabel: 'F3', label: 'Clear',
                  fn: () => { picked = [null, null, null]; draw(); } });
    }
    if (back) acts.push({ key: 'Escape', keyLabel: 'Esc', label: 'Back',
                          kind: 'back', fn: back });
    setActions(acts);
    tipify(cont);
  };

  // SPEICHER_LESEN is a read and runs for real. It names both what is loaded
  // now and what a previous modification asked for, which is the pair worth
  // seeing before changing anything.
  const doRead = async () => {
    readErr = null;
    current = null;
    draw();
    sbLeft.textContent = 'SPEICHER_LESEN…';
    try {
      const d = await api(`/api/ecu/${ecu.sgbd}/run/SPEICHER_LESEN`,
                          { method: 'POST' });
      const vals = new Map(flatResults(d.sets));
      const want = [
        ['SPRACHE_1_AKTUELL_TEXT', 'Language 1'],
        ['SPRACHE_2_AKTUELL_TEXT', 'Language 2'],
        ['SPRACHE_3_AKTUELL_TEXT', 'Language 3'],
        ['SPRACHEN_AKTUELL_CODE', 'Current code'],
        ['SPRACHEN_MODIFIZIERT_CODE', 'Modified code'],
        ['STAT_SW_LADEN_TEXT', 'Software load'],
      ];
      current = want.filter(([k]) => vals.has(k))
                    .map(([k, label]) => [label, String(vals.get(k))]);
      sbLeft.textContent = `SPEICHER_LESEN · ${current.length} values`;
    } catch (e) {
      readErr = e.message;
      sbLeft.textContent = 'read failed';
    }
    draw();
  };

  draw();
  doRead();
}
