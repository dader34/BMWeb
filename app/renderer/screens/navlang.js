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
// stages the change and shows the exact job and arguments.
//
// AND IT DOES ONLY THIS. An earlier version also ran SPEICHER_LESEN and
// printed the module's current languages, software-load state and codes at
// the top. That is a different key -- "Current languages read" is F1 of the
// same INPA menu -- and putting it here made a one-job screen look like a
// status page. This key loads languages, so this screen picks languages.

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
  let picked = [null, null, null];

  const byCode = (c) => langs.find(l => l.code === c);
  const hex = (c) => `0x${c.toString(16).toUpperCase().padStart(2, '0')}`;

  const draw = () => {
    setPanel();
    const chosen = picked.filter(c => c != null);
    const opt = (sel, i) => `<option value=""${sel == null ? ' selected' : ''}>`
      + `\u2014 slot ${i + 1} \u2014</option>`
      + langs.map(l => `<option value="${l.code}"`
        + `${l.code === sel ? ' selected' : ''}>`
        + `${esc(l.label)} \u00b7 ${hex(l.code)}</option>`).join('');

    cont.innerHTML = `
      <div class="act-menu">
        <div class="act-menu-title">Load languages</div>
        <div class="act-menu-sub mono">${esc(ecu.sgbd)}.prg \u00b7 `
      + `SPEICHER_SCHREIBEN</div>
        <div class="cod-note"><span class="cod-note-dim">INPA loads these `
      + `three from a file on the PC. They are just language codes, so pick `
      + `them here.</span></div>
        <div class="nav-pickers">
          ${[0, 1, 2].map(i => `<label class="dat-pick">Language ${i + 1}
            <select class="nav-pick" data-i="${i}">${opt(picked[i], i)}</select>
          </label>`).join('')}
        </div>
        <div class="cod-blocked" id="nav-send"></div>
      </div>`;

    // what WOULD be sent, spelled out, and why it is not
    const send = cont.querySelector('#nav-send');
    if (chosen.length === 3) {
      const args = picked.map(hex).join(';');
      const names = picked
        .map(c => (byCode(c) || {}).label || hex(c))
        .map((n, i) => `${i + 1}. ${n}`).join('   ');
      send.innerHTML = `<b>Not sent.</b> This would run `
        + `<span class="mono">SPEICHER_SCHREIBEN</span> with `
        + `<span class="mono">${esc(args)}</span><br>${esc(names)}<br><br>`
        + `Sending is disabled: the nav reloads its voice data from this, and `
        + `wrong codes leave it with no working language, which is recovered `
        + `by writing again through the nav you just broke.`;
    } else {
      send.innerHTML = `<span class="cod-note-dim">Choose three to see exactly `
        + `what INPA would send. Nothing is written to the car.</span>`;
    }

    cont.querySelectorAll('.nav-pick').forEach(sel => {
      sel.onchange = () => {
        picked[Number(sel.dataset.i)] = sel.value === '' ? null : Number(sel.value);
        draw();
      };
    });

    const acts = [];
    if (chosen.length) {
      acts.push({ key: '3', keyLabel: 'F3', label: 'Clear',
                  fn: () => { picked = [null, null, null]; draw(); } });
    }
    if (back) acts.push({ key: 'Escape', keyLabel: 'Esc', label: 'Back',
                          kind: 'back', fn: back });
    setActions(acts);
    sbLeft.textContent = `${ecu.sgbd}.prg \u00b7 load languages`;
    tipify(cont);
  };

  draw();
}
