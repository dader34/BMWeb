// background E46 auto-scan + the fault-detail read helpers and the corner
// attention popup. autoScanE46 runs once per session on first E46 open (opt-in via
// settings), reads engine + transmission fault memory, and raises a badge if
// anything is stored. fillFaultDetail/matchDetail are shared with faults.js and
// sweep.js.

// engine SGBD used for the battery/ignition read. set when a chassis loads so the
// poll targets the right DME (the server default only works for MS45/E46).
let stateSgbd = null;

// background scan of E46 engine + transmission, once per session on first open.
// stored faults get a detail read and an attention popup.
let _autoScanRan = false;
let _autoScanning = false;
async function autoScanE46(force) {
  if (Settings.get('autoScan', 'off') !== 'on') return; // opt-in via settings
  if ((_autoScanRan && !force) || _autoScanning) return; // re-entrancy + once-per-session
  _autoScanning = true;
  loadFaultDb(); // warm the name db for the attention popup
  stateSgbd = 'ms450ds0'; // E46 engine: drive the battery/ignition poll off MS45
  try {
    // engine = MS45; transmission = all E46 variants (only one is installed)
    const targets = [
      { sgbd: 'ms450ds0', label: 'MS45.1 DME (engine)', trans: false },
      { sgbd: 'gsds2',    label: 'GS20/GS8 auto trans', trans: true },
      { sgbd: 'gs30',     label: 'SSG sequential gearbox', trans: true },
      { sgbd: 'smg2',     label: 'SMG2 transmission', trans: true },
    ];
    const findings = [];     // { label, faults:[ detailed codes ] }
    let transFound = false, anyResponse = false;
    for (const t of targets) {
      // trans variants share an address: once one actually answers, skip the rest
      if (t.trans && transFound) continue;
      let data;
      try { data = await api(`/api/ecu/${t.sgbd}/read`, { method: 'POST' }); }
      catch { continue; } // no response = not installed
      anyResponse = true;
      if (t.trans) transFound = true; // a non-throwing read means this variant is on the bus
      const faults = (data.codes || []).filter(c => c.F_HEX_CODE || c.F_ORT_NR);
      if (!faults.length) continue;
      await fillFaultDetail(t.sgbd, faults);
      findings.push({ label: t.label, sgbd: t.sgbd, faults });
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
        const hex = c.F_HEX_CODE || '';
        const pstr = c.F_PCODE_STRING || pCode(c.F_ORT_TEXT, hex) || '';
        const { name, present } = faultFields(c);
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
    showEcu('E46', 'Engine', { sgbd: g.sgbd, code: g.sgbd, label: g.label });
  };
  document.addEventListener('click', onDocClick); // removed in dismiss()
}
