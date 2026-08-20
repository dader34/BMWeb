// background chassis auto-scan + the corner attention popup.
// fillFaultDetail/matchDetail are shared with faults.js and sweep.js.

// engine SGBD used for the battery/ignition read, set on every chassis open so a
// later chassis can't inherit the previous one's DME. null = let the server pick.
let stateSgbd = null;
// the chassis config names the DME: first ecu of the /engine|motor/i section,
// the same section find tutorial.js openTourModule uses. Callers (nav.js)
// already hold the /api/chassis payload, so this stays sync and takes the
// config instead of fetching a second copy -- nav calls it bare (null) on
// screen entry so a failed config load can't leave the previous chassis's
// DME live, then again with the config once it arrives.
function setStateSgbd(ch = null) {
  const sec = ch && (ch.sections || []).find(s => /engine|motor/i.test(s.name));
  stateSgbd = (sec && sec.ecus && sec.ecus[0] && sec.ecus[0].sgbd) || null;
}

// background scan of the chassis's engine + transmission modules, once per
// session on first open. Targets come from the chassis config nav already
// fetched (no hand-tuned per-chassis list): every ecu in the /engine|motor/i
// and /trans|getriebe|gearbox/i sections that carries a diagnostic-address
// group, collapsed to ONE target per group -- a group's variants share a bus
// address, so the group, not the ecu row, is the unit of presence.
// stored faults get a detail read and an attention popup.
// Wire traffic is reads only, same as the E46-only scan this replaces:
// FS_LESEN + FS_LESEN_DETAIL, plus the group IDENTIFIKATION exchange
// webResolveVariant adds on the strict path (IDENT is a read).
let _autoScanRan = false;
let _autoScanning = false;
async function autoScan(chassisId, ch) {
  if (Settings.get('autoScan', 'off') !== 'on') return; // opt-in via settings
  if (_autoScanRan || _autoScanning) return; // re-entrancy + once-per-session
  if (!ch || !Array.isArray(ch.sections)) return; // no config = nothing to scan

  // one target per diagnostic-address group. keep the section name (the
  // popup's "Open faults" navigates there) and the section's FULL ecu list:
  // the ident can name a variant whose config row carries no group (E46 maps
  // MS45 with group null while its D_0012 siblings are grouped), and that
  // row still owns the right label/code.
  const targets = [];
  const byGroup = new Map();
  for (const sec of ch.sections) {
    if (!/engine|motor|trans|getriebe|gearbox/i.test(sec.name)) continue;
    for (const e of (sec.ecus || [])) {
      if (!e.group) continue;
      const g = String(e.group).toLowerCase();
      let t = byGroup.get(g);
      if (!t) { t = { group: g, section: sec.name, secEcus: sec.ecus, ecus: [] }; byGroup.set(g, t); targets.push(t); }
      t.ecus.push(e);
    }
  }
  if (!targets.length) return; // chassis has no grouped engine/trans modules

  _autoScanning = true;
  loadFaultDb(); // warm the name db for the attention popup
  try {
    // the shipped-groups index decides which targets get the strict group
    // semantics, same gate as sweep.js/ecu.js: a group this build can run
    // is the presence test (its IDENTIFIKATION names the read target), a
    // group it can't keeps the legacy try-each-configured-variant read.
    const groupIndex = await fetch('data/groups/index.json')
      .then(r => (r.ok ? r.json() : null)).catch(() => null);
    const groupRunnable = (g) => !!(typeof webResolveVariant === 'function'
      && groupIndex && (groupIndex.groups || []).includes(g));

    const findings = [];     // { label, sgbd, code, section, chassis, faults:[ detailed codes ] }
    let anyResponse = false;
    for (const t of targets) {
      let data, sgbd, ecu;
      if (groupRunnable(t.group)) {
        // STRICT group semantics, exactly quickErrorSweep's: the group's
        // IDENTIFIKATION is the module-present test and names the variant
        // the fault read targets. Silence = module absent -- this is a
        // background scan, so absent modules and unreadable variants both
        // pass in silence instead of raising UI noise.
        let via = null;
        try { via = await webResolveVariant(t.group); } catch { via = null; }
        if (!via) continue; // nothing answered at this address
        anyResponse = true; // the ident answered, so the bus is live
        try { data = await api(`/api/ecu/${via}/read`, { method: 'POST' }); }
        catch { continue; } // identified but not readable in this build
        sgbd = via;
        ecu = t.secEcus.find(e => String(e.sgbd).toLowerCase() === via
              || (e.variants || []).some(v => String(v).toLowerCase() === via))
              || t.ecus[0];
      } else {
        // no runnable group: old behavior. the configured variants share one
        // address, so try each in sequence and let the first non-throwing
        // read win (this is what the old E46 trans flag did).
        for (const e of t.ecus) {
          try { data = await api(`/api/ecu/${e.sgbd}/read${groupQuery(e)}`, { method: 'POST' }); }
          catch { continue; } // no response = this variant isn't installed
          anyResponse = true; sgbd = e.sgbd; ecu = e; break;
        }
        if (!data) continue; // whole group silent = module absent
      }
      const faults = (data.codes || []).filter(c => c.F_HEX_CODE || c.F_ORT_NR);
      if (!faults.length) continue;
      await fillFaultDetail(sgbd, faults); // detail reads target the RESOLVED sgbd
      findings.push({ label: ecu.label, sgbd, code: ecu.code || sgbd,
                      section: t.section, chassis: chassisId, faults });
    }
    if (anyResponse) _autoScanRan = true; // mark done only after the bus answered, so a late connect rescans
    if (findings.length) { await loadFaultDb(); showAttentionPopup(findings); }
  } finally {
    _autoScanning = false;
  }
}

// read FS_LESEN_DETAIL per fault and merge the rich fields (p-code, freq, env)
// onto each entry in place. keeps the short hex/loc from the base read.
async function fillFaultDetail(sgbd, faults) {
  for (const f of faults) {
    if (f.F_ORT_NR == null) continue;
    try {
      const det = await api(`/api/ecu/${sgbd}/run/FS_LESEN_DETAIL?arg=${encodeURIComponent(f.F_ORT_NR)}`, { method: 'POST' });
      const dset = matchDetail(det.sets, f.F_ORT_NR);
      if (dset) { const { F_HEX_CODE, F_ORT_TEXT, ...rich } = dset; Object.assign(f, rich); }
    } catch { /* keep base entry */ }
  }
}

// pick the detail set for fault nr. match F_ORT_NR first; fall back to a p-code/hex
// set only when no set has an F_ORT_NR, so wrong-fault data isnt attached
function matchDetail(sets, nr) {
  const list = sets || [];
  return list.find(s => s.F_ORT_NR == nr)
      || (list.some(s => s.F_ORT_NR != null) ? null
          : list.find(s => s.F_PCODE_STRING || s.F_HEX_CODE));
}

// corner warning badge for stored faults. click expands the detail list; stays
// until dismissed or the screen changes (setActions calls dismissAttention).
let _attDismiss = null;
function dismissAttention() { if (_attDismiss) _attDismiss(); }
function showAttentionPopup(findings) {
  document.getElementById('att-badge')?.remove();   // replace any existing
  document.getElementById('att-panel')?.remove();
  const total = findings.reduce((n, f) => n + f.faults.length, 0);

  const badge = document.createElement('button');
  badge.id = 'att-badge';
  badge.className = 'att-corner';
  badge.title = `${total} stored fault${total === 1 ? '' : 's'} - click for detail`;
  badge.innerHTML = `<span class="att-tri">▲</span><span class="att-count">${total}</span>`;
  document.body.appendChild(badge);
  requestAnimationFrame(() => badge.classList.add('show'));

  // expanded detail panel, built once and toggled
  const blocks = findings.map(g => `
    <div class="att-group">
      <div class="att-ecu">${esc(g.label)} · ${g.faults.length} fault${g.faults.length === 1 ? '' : 's'}</div>
      ${g.faults.map(c => {
        const hex = hexText(c.F_HEX_CODE);
        const pstr = c.F_PCODE_STRING
          || (typeof pcodeForHexSgbd === 'function' ? pcodeForHexSgbd(bmwCode(c.F_ORT_TEXT, hex), g.sgbd) : null) || '';
        const { name, present } = faultFields(c, g.sgbd);
        return `<div class="att-fault${present ? ' present' : ''}">
          <div class="att-name">${esc(name)}${present ? '<span class="att-badge">PRESENT</span>' : ''}</div>
          <div class="att-meta">${esc(`${deGerman(c.F_SYMPTOM_TEXT) || ''}${pstr ? ` · ${pstr}` : ''}${(c.F_HFK || c.F_LZ) ? ` · seen ${c.F_HFK || c.F_LZ}×` : ''}`)}</div>
        </div>`;
      }).join('')}
    </div>`).join('');
  const panel = document.createElement('div');
  panel.id = 'att-panel';
  panel.className = 'att-panel';
  panel.innerHTML = `
    <div class="att-panel-head">
      <span>⚠︎ ${total} stored fault${total === 1 ? '' : 's'}</span>
      <button class="att-x" title="Dismiss">✕</button>
    </div>
    <div class="att-body">${blocks}</div>
    <div class="att-panel-foot"><button class="btn primary att-open">Open faults</button></div>`;
  document.body.appendChild(panel);

  let open = false;
  const setOpen = (v) => { open = v; panel.classList.toggle('show', v); badge.classList.toggle('expanded', v); };
  const onDocClick = (e) => {
    if (open && !panel.contains(e.target) && e.target !== badge && !badge.contains(e.target)) setOpen(false);
  };
  const dismiss = () => {
    document.removeEventListener('click', onDocClick); badge.remove(); panel.remove();
    if (_attDismiss === dismiss) _attDismiss = null;
  };
  _attDismiss = dismiss; // navigation (setActions) tears the popup down
  badge.onclick = () => setOpen(!open);
  panel.querySelector('.att-x').onclick = (e) => { e.stopPropagation(); dismiss(); };
  panel.querySelector('.att-open').onclick = () => {
    const g = findings[0];
    dismiss(); // navigating away, clean up badge + listener
    // the chassis and section the finding came from, carried on the finding
    // itself (autoScan is chassis-agnostic now; nothing here may assume E46)
    showEcu(g.chassis, g.section, { sgbd: g.sgbd, code: g.code, label: g.label });
  };
  document.addEventListener('click', onDocClick); // removed in dismiss()
}
