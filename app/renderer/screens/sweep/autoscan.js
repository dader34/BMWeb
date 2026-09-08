/**
 * @file Whole-vehicle sweep: the background chassis auto-scan and the corner
 * attention popup it raises for stored faults.
 *
 * Seventh piece of screens/sweep/. Shares the plan's naming helpers, the
 * group gate and the wire helpers with the two foreground sweeps.
 */

/**
 * One module the background scan found faults on.
 * @typedef {object} AutoScanFinding
 * @property {string} label - The config row's label.
 * @property {string} sgbd - The SGBD the faults were read from.
 * @property {string} code - The row's INPA code, else the SGBD.
 * @property {string} group - The group that identified it.
 * @property {string} section - The config section, for "Open faults".
 * @property {string} chassis - The chassis id, for "Open faults".
 * @property {FaultEntry[]} faults - Its faults, detailed.
 */

/**
 * The engine SGBD used for the battery/ignition read, set on every chassis
 * open so a later chassis can't inherit the previous one's DME. null = let
 * the server pick.
 * @type {string|null}
 */
let stateSgbd = null;

/** The config sections the background scan covers: engine and gearbox. */
const AUTOSCAN_SECTIONS = new Set(['ROOT_MOTOR', 'ROOT_GETRIEBE']);

/**
 * Point the status poll at this chassis's DME. The chassis config names it:
 * first ecu of the ROOT_MOTOR section, the same section find
 * tutorial.js openTourModule uses. Callers (nav.js) already hold the
 * /api/chassis payload, so this stays sync and takes the config instead of
 * fetching a second copy -- nav calls it bare (null) on screen entry so a
 * failed config load can't leave the previous chassis's DME live, then
 * again with the config once it arrives.
 *
 * By section KEY, not its display name: the key is the config's own
 * identifier (ROOT_MOTOR), while `name` is a translated label -- a section
 * whose key is not in SECTION_ORDER gets pretty(key) instead, so "Antrieb"
 * would silently never match here.
 * @param {ChassisConfig|null} [ch] - The chassis config, or null to clear.
 * @returns {void}
 */
function setStateSgbd(ch = null) {
  const sec = ch && (ch.sections || []).find((s) => s.key === 'ROOT_MOTOR');
  stateSgbd = (sec && sec.ecus && sec.ecus[0] && sec.ecus[0].sgbd) || null;
}

/** Whether the once-per-session background scan has completed. */
let _autoScanRan = false;
/** Re-entrancy guard for the background scan. */
let _autoScanning = false;

/**
 * The background scan's targets: one per diagnostic-address group across
 * the engine and gearbox sections. Keep the section name (the popup's
 * "Open faults" navigates there) and the section's FULL ecu list: the ident
 * can name a variant whose config row carries no group (E46 maps MS45 with
 * group null while its D_0012 siblings are grouped), and that row still
 * owns the right label/code.
 * @param {ChassisConfig} ch - The chassis config.
 * @returns {{ group: string, section: string, secEcus: ConfigEcu[], ecus: ConfigEcu[] }[]}
 *   The targets.
 */
function autoScanTargets(ch) {
  const targets = [];
  const byGroup = new Map();
  for (const sec of ch.sections) {
    if (!AUTOSCAN_SECTIONS.has(sec.key)) continue;
    for (const e of sec.ecus || []) {
      if (!e.group) continue;
      const g = String(e.group).toLowerCase();
      let t = byGroup.get(g);
      if (!t) {
        t = { group: g, section: sec.name, secEcus: sec.ecus, ecus: [] };
        byGroup.set(g, t);
        targets.push(t);
      }
      t.ecus.push(e);
    }
  }
  return targets;
}

/**
 * Background scan of the chassis's engine + transmission modules, once per
 * session on first open. Targets come from the chassis config nav already
 * fetched (no hand-tuned per-chassis list): every ecu in the ROOT_MOTOR and
 * ROOT_GETRIEBE sections that carries a diagnostic-address group, collapsed
 * to ONE target per group -- a group's variants share a bus address, so the
 * group, not the ecu row, is the unit of presence. Stored faults get a
 * detail read and an attention popup.
 *
 * Wire traffic is reads only, same as the E46-only scan this replaced:
 * FS_LESEN + FS_LESEN_DETAIL, plus the group IDENTIFIKATION exchange
 * webResolveVariant adds on the strict path (IDENT is a read).
 * @param {string} chassisId - The chassis id.
 * @param {ChassisConfig|null|undefined} ch - The chassis config.
 * @returns {Promise<void>} Resolves when the scan finishes or is skipped.
 */
async function autoScan(chassisId, ch) {
  if (Settings.get('autoScan', 'off') !== 'on') return; // opt-in via settings
  if (_autoScanRan || _autoScanning) return; // re-entrancy + once-per-session
  if (!ch || !Array.isArray(ch.sections)) return; // no config = nothing to scan

  const targets = autoScanTargets(ch);
  if (!targets.length) return; // chassis has no grouped engine/trans modules

  _autoScanning = true;
  loadFaultDb(); // warm the name db for the attention popup
  try {
    const findings = [];
    let anyResponse = false;
    for (const t of targets) {
      let faults = null,
        sgbd,
        ecu;
      // the shipped-groups index decides which targets get the strict group
      // semantics, same gate as the foreground sweeps and ecu.js: a group
      // this build can run is the presence test (its IDENTIFIKATION names
      // the read target), a group it can't keeps the legacy
      // try-each-configured-variant read.
      if (await groupRunnable(t.group)) {
        // STRICT group semantics, the sweep's own: the group's
        // IDENTIFIKATION is the module-present test and names the variant
        // the fault read targets. Silence = module absent -- this is a
        // background scan, so absent modules and unreadable variants both
        // pass in silence instead of raising UI noise.
        let via = null;
        try {
          via = await webResolveVariant(t.group);
        } catch {
          via = null;
        }
        if (!via) continue; // nothing answered at this address
        anyResponse = true; // the ident answered, so the bus is live
        try {
          faults = await readFaults(via);
        } catch {
          continue; // identified but not readable in this build
        }
        sgbd = via;
        ecu = rowForVariant({ ecus: t.secEcus }, via) || t.ecus[0];
      } else {
        // no runnable group: old behavior. the configured variants share one
        // address, so try each in sequence and let the first non-throwing
        // read win (this is what the old E46 trans flag did).
        for (const e of t.ecus) {
          try {
            faults = await readFaults(e.sgbd);
          } catch {
            continue; // no response = this variant isn't installed
          }
          anyResponse = true;
          sgbd = e.sgbd;
          ecu = e;
          break;
        }
        if (!faults) continue; // whole group silent = module absent
      }
      if (!faults.length) continue;
      await fillFaultDetail(sgbd, faults); // detail reads target the RESOLVED sgbd
      findings.push({
        label: ecu.label,
        sgbd,
        code: ecu.code || sgbd,
        group: t.group,
        section: t.section,
        chassis: chassisId,
        faults,
      });
    }
    if (anyResponse) _autoScanRan = true; // mark done only after the bus answered, so a late connect rescans
    if (findings.length) {
      await loadFaultDb();
      showAttentionPopup(findings);
    }
  } finally {
    _autoScanning = false;
  }
}

/**
 * The current popup's teardown, if one is showing. Navigation (setActions)
 * calls dismissAttention so the badge never outlives its screen.
 * @type {(() => void)|null}
 */
let _attDismiss = null;

/**
 * Tear down the attention popup, if any.
 * @returns {void}
 */
function dismissAttention() {
  if (_attDismiss) _attDismiss();
}

/**
 * One finding's block in the popup's detail panel.
 * @param {AutoScanFinding} g - The finding.
 * @returns {string} The block HTML.
 */
function attentionBlock(g) {
  const faults = g.faults
    .map((c) => {
      // P-code from the ECU's own read only -- no local hex->P mapping on a
      // fault read (the module is the authority).
      const pstr = c.F_PCODE_STRING || c.F_PCODE7_STRING || '';
      const { name, present } = faultFields(c, g.sgbd);
      return `<div class="att-fault${present ? ' present' : ''}">
          <div class="att-name">${esc(name)}${present ? '<span class="att-badge">PRESENT</span>' : ''}</div>
          <div class="att-meta">${esc(`${phraseText(c.F_SYMPTOM_TEXT) || ''}${pstr ? ` · ${pstr}` : ''}${c.F_HFK || c.F_LZ ? ` · seen ${c.F_HFK || c.F_LZ}×` : ''}`)}</div>
        </div>`;
    })
    .join('');
  return `
    <div class="att-group">
      <div class="att-ecu">${esc(g.label)} · ${g.faults.length} fault${g.faults.length === 1 ? '' : 's'}</div>
      ${faults}
    </div>`;
}

/**
 * Corner warning badge for stored faults. Click expands the detail list;
 * stays until dismissed or the screen changes (setActions calls
 * dismissAttention).
 * @param {AutoScanFinding[]} findings - The modules with faults.
 * @returns {void}
 */
function showAttentionPopup(findings) {
  document.getElementById('att-badge')?.remove(); // replace any existing
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
  const panel = document.createElement('div');
  panel.id = 'att-panel';
  panel.className = 'att-panel';
  panel.innerHTML = `
    <div class="att-panel-head">
      <span>⚠︎ ${total} stored fault${total === 1 ? '' : 's'}</span>
      <button class="att-x" title="Dismiss">✕</button>
    </div>
    <div class="att-body">${findings.map(attentionBlock).join('')}</div>
    <div class="att-panel-foot"><button class="btn primary att-open">Open faults</button></div>`;
  document.body.appendChild(panel);

  let open = false;
  const setOpen = (v) => {
    open = v;
    panel.classList.toggle('show', v);
    badge.classList.toggle('expanded', v);
  };
  const onDocClick = (e) => {
    if (
      open &&
      !panel.contains(e.target) &&
      e.target !== badge &&
      !badge.contains(e.target)
    )
      setOpen(false);
  };
  const dismiss = () => {
    document.removeEventListener('click', onDocClick);
    badge.remove();
    panel.remove();
    if (_attDismiss === dismiss) _attDismiss = null;
  };
  _attDismiss = dismiss; // navigation (setActions) tears the popup down
  badge.onclick = () => setOpen(!open);
  panel.querySelector('.att-x').onclick = (e) => {
    e.stopPropagation();
    dismiss();
  };
  panel.querySelector('.att-open').onclick = () => {
    const g = findings[0];
    dismiss(); // navigating away, clean up badge + listener
    // the chassis and section the finding came from, carried on the finding
    // itself (autoScan is chassis-agnostic; nothing here may assume E46).
    // Carry the group so the module re-resolves its variant
    // (irResolveGroupVariant needs it; without it the open stays on the
    // configured SGBD).
    showEcu(g.chassis, g.section, {
      sgbd: g.sgbd,
      code: g.code,
      label: g.label,
      group: g.group,
    });
  };
  document.addEventListener('click', onDocClick); // removed in dismiss()
}
