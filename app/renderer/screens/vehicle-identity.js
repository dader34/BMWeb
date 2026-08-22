// Vehicle identity: read the car's build record, and say what it means.
//
// Two records, depending on the generation:
//   ZCS  E36..E53   three keys in a 20-byte region on the cluster/light module
//   FA   E60+       the build order as text, whose $ tokens are SA numbers
//
// WHICH ECU TO ASK IS DATA, NOT A LIST. BMW's SGFAM table flags, per control
// unit, whether it holds the order (FA) or the coding key (ZCS). On E46 that
// is KMB and EWS for the order, AKMB and ALSZ for the key. Hardcoding those
// names would be wrong on the next chassis and wrong again on a car whose
// DATEN ships a different family map, so the buttons below are generated from
// the table.
//
// LAYOUT. The reading is the headline: one summary card saying what the car
// IS, with the equipment underneath as labelled chips. The ECUs that produced
// it are a footnote strip, not the main event -- which control unit answered
// matters when a read fails and almost never otherwise.

// WHICH JOB, AND WHICH RESULT, ARE READ FROM THE ECU'S OWN DECLARATION.
//
// Nothing here is a list of names somebody typed. Every SGBD ships its job
// table -- each job's name, its results, and their comments -- and that table
// is what says how to read this control unit. A hand-written list of likely
// spellings is how the old scan came to look for GM_SCHLUESSEL on a module
// that calls it GM, and to miss C_AZCS_LESEN entirely.
//
// Two spellings the corpus actually contains, either of which a typed list
// would have got wrong:
//   ZCS_LESEN   returns GM, SA, VM   <- third key spelled VM
//   C_ZCS_LESEN returns GM, SA, VN   <- and VN here
// So the keys are matched by POSITION IN THE DECLARATION, not by name.

// A job reads the coding key if it declares three single-key results beside a
// status. The regex names the ROLE (grund/sonder/versions), never a spelling.
const VI_KEY_ROLE = [/^GM$/i, /^SA$/i, /^V[NM]$/i];

// Results that are transport plumbing, not data: every SGBD prefixes them.
const VI_INTERNAL = /^_/;

// Is this job a read? The write classifier is default-deny, so anything it
// cannot prove is a read stays out of an identity screen that must never
// change the car.
function viIsRead(name) {
  return typeof isWriteJob === 'function' ? !isWriteJob(name) : false;
}

// The job names an ECU declares. Names only -- the runtime endpoint does not
// carry each job's results, which is why viJobResults exists below.
async function viJobs(sgbd) {
  try {
    const list = await api(`/api/ecu/${sgbd}/jobs`);
    if (Array.isArray(list)) {
      return list.map((j) => (typeof j === 'string' ? { name: j } : j))
        .filter((j) => j && j.name);
    }
    if (list && typeof list === 'object') {
      return Object.keys(list).map((k) => ({ name: k, ...(list[k] || {}) }));
    }
  } catch (e) { /* no job table shipped for this module */ }
  return [];
}

// One job's declared results, as plain names.
//
// The endpoint answers with "NAME : comment" strings ("GM : Zentralcode C1 -
// Grundmerkmal"), so the name is the part before the first colon. Transport
// plumbing is dropped.
async function viJobResults(sgbd, job) {
  try {
    const rows = await api(`/api/ecu/${sgbd}/results/${encodeURIComponent(job)}`);
    if (!Array.isArray(rows)) return [];
    return rows
      .map((r) => String(typeof r === 'string' ? r : (r && r.name) || '')
        .split(':')[0].trim())
      .filter((n) => n && !VI_INTERNAL.test(n));
  } catch (e) { return []; }
}

// The identity-job index: which job on which SGBD answers with a key or an
// order, derived from every shipped SGBD's own declarations by
// tools/decompile/ncs_tables.py. 20 jobs out of 27340 qualify.
//
// This is a CANDIDATE LIST, not the decision. Scanning it costs nothing, but
// what the module in front of us declares is still what settles it -- a car
// whose SGBD differs from the shipped copy is caught by the confirmation
// below rather than trusted from a table.
function viIndexFor(sgbd) {
  const t = (typeof window !== 'undefined' && window.BMW_TABLES) || null;
  const idx = t && t._identity;
  return (idx && idx[String(sgbd).toLowerCase()]) || null;
}

// Confirm a candidate against the ECU's live declaration.
//
// Returns the same shape the candidate has, rebuilt from what the module
// actually says, so a spelling that moved (the third key is VM on one job and
// VN on another) is taken from the car and not from the index.
async function viConfirmZcs(sgbd, job) {
  if (!viIsRead(job)) return null;
  const names = await viJobResults(sgbd, job);
  const keys = VI_KEY_ROLE.map((re) => names.find((n) => re.test(n)));
  return keys.every(Boolean)
    ? { job, keys: { gm: keys[0], sa: keys[1], vn: keys[2] } } : null;
}

async function viConfirmFa(sgbd, job) {
  if (!viIsRead(job)) return null;
  const names = await viJobResults(sgbd, job);
  const hit = names.find((n) => /FAHRZEUGAUFTRAG|STANDARD_FA/i.test(n));
  return hit ? { job, result: hit } : null;
}

// The read job on this ECU that answers with the three coding keys, or null.
async function viPickZcsJob(sgbd, jobs) {
  const declared = new Set(jobs.map((j) => j.name));
  const idx = viIndexFor(sgbd);
  for (const cand of (idx && idx.zcs) || []) {
    if (!declared.has(cand.job)) continue;
    const got = await viConfirmZcs(sgbd, cand.job);
    if (got) return got;
  }
  return null;
}

// The read job that answers with the vehicle order, or null.
async function viPickFaJob(sgbd, jobs) {
  const declared = new Set(jobs.map((j) => j.name));
  const idx = viIndexFor(sgbd);
  for (const cand of (idx && idx.fa) || []) {
    if (!declared.has(cand.job)) continue;
    const got = await viConfirmFa(sgbd, cand.job);
    if (got) return got;
  }
  return null;
}

// WHICH CONTROL UNITS HOLD THE IDENTITY, ASKED OF THE MODULES THEMSELVES.
//
// BMW's SGFAM table also flags this, but its logical names are not the SGBDs
// we address: E46's table says KMB and the shipped module is `kombi46`, says
// ALSZ where nothing by that name ships at all. Rather than invent a name
// transform, the question is put to the modules -- an ECU that declares a job
// returning the coding keys or the vehicle order IS an identity master.
//
// This lands on the same answer SGFAM gives (E46: the cluster and EWS) and
// keeps working where the naming does not line up. SGFAM is still used, for
// the human-readable family name in the source strip.
//
// Returns [{ sgbd, label, fa, zcs, faJob, zcsJob }] in chassis order.
async function viIdentityModules(chassisId) {
  const id = String(chassisId || '').toUpperCase();
  let ch;
  try { ch = await api(`/api/chassis/${id}`); }
  catch (e) { return []; }
  const seen = new Set();
  const ecus = [];
  for (const s of (ch.sections || [])) {
    for (const e of (s.ecus || [])) {
      if (!e.sgbd || seen.has(e.sgbd)) continue;
      seen.add(e.sgbd);
      ecus.push(e);
    }
  }
  if (typeof loadTables === 'function') await loadTables();
  const probed = await Promise.all(ecus.map(async (e) => {
    const jobs = await viJobs(e.sgbd);
    if (!jobs.length) return null;
    const zcsJob = await viPickZcsJob(e.sgbd, jobs);
    const faJob = await viPickFaJob(e.sgbd, jobs);
    if (!zcsJob && !faJob) return null;
    return { sgbd: e.sgbd, label: e.label || e.sgbd,
             fa: !!faJob, zcs: !!zcsJob, faJob, zcsJob };
  }));
  return probed.filter(Boolean);
}

// Cache: probing every module's job table is a handful of fetches, and both
// the nav tile and the screen ask the same question.
const _viIdentCache = new Map();

async function viIdentityModulesCached(chassisId) {
  const id = String(chassisId || '').toUpperCase();
  if (_viIdentCache.has(id)) return _viIdentCache.get(id);
  const p = viIdentityModules(id);
  _viIdentCache.set(id, p);
  return p;
}

// Does this chassis have anything that can answer? Drives the nav tile, and
// is the same test the screen runs -- so the tile never opens a dead end.
async function chassisHasIdentity(chassisId) {
  try { return (await viIdentityModulesCached(chassisId)).length > 0; }
  catch (e) { return false; }
}

// hex text -> bytes, or null. Accepts "0A 0B", "0A-0B" and "0x0A0B".
function viBytes(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return v.map((b) => b & 0xff);
  if (ArrayBuffer.isView(v)) return Array.from(v, (b) => b & 0xff);
  const s = String(v).trim().replace(/^0x/i, '');
  if (/^[0-9A-Fa-f]{2}([\s-][0-9A-Fa-f]{2})+$/.test(s)) {
    return s.split(/[\s-]+/).map((h) => parseInt(h, 16));
  }
  if (/^[0-9A-Fa-f]+$/.test(s) && s.length % 2 === 0) {
    const out = [];
    for (let i = 0; i < s.length; i += 2) out.push(parseInt(s.substr(i, 2), 16));
    return out;
  }
  return null;
}

// Pull the three coding keys out of a reply, using the result names the ECU
// itself declared for this job.
//
// Two shapes in the wild: an ECU that names each key, and one that answers
// with a raw region the keys sit inside. The named form needs no offset. The
// raw form goes through coding-zcs, which knows the 4-1-8-1-5-1 layout.
function viKeysFrom(values, keyNames) {
  const pick = (n) => {
    if (!n || !values.has(n)) return null;
    const s = String(values.get(n)).replace(/[^0-9A-Fa-f]/g, '');
    return s ? s.toUpperCase() : null;
  };
  const gm = pick(keyNames && keyNames.gm);
  const sa = pick(keyNames && keyNames.sa);
  const vn = pick(keyNames && keyNames.vn);
  // A key may carry its Mod-36 check character; the tables mask the body only.
  if (gm && sa && vn) {
    return { gm: gm.slice(0, 8), sa: sa.slice(0, 16), vn: vn.slice(0, 10),
             source: 'named' };
  }
  // No named keys: the reply may still CONTAIN the region. Every non-internal
  // result is a candidate blob, and the region is found by verifying its
  // check characters rather than by assuming where it starts -- see
  // viFindRegion. A blob that never verifies yields nothing.
  for (const [name, v] of values) {
    if (VI_INTERNAL.test(name)) continue;
    const bytes = viBytes(v);
    if (!bytes || bytes.length < 20) continue;
    const found = viFindRegion(bytes);
    if (found) return { ...found, source: 'region', from: name };
  }
  return null;
}

// Find the 20-byte ZCS region inside a larger blob by verifying its check
// characters. Returns {gm,sa,vn,offset} or null.
function viFindRegion(bytes) {
  if (typeof CodingZcs === 'undefined' || !CodingZcs.parseZcsRegion) return null;
  for (let off = 0; off + 20 <= bytes.length; off++) {
    let r;
    try { r = CodingZcs.parseZcsRegion(bytes.slice(off, off + 20)); }
    catch (e) { continue; }
    // All three check characters must verify. One passing by chance is
    // common (1 in 36); three at the same offset is not.
    if (r.gm.valid && r.sa.valid && r.vn.valid) {
      return { gm: r.gm.body, sa: r.sa.body, vn: r.vn.body, offset: off };
    }
  }
  return null;
}

// The vehicle order, read from the result the ECU declared for it.
function viFaFrom(values, resultName) {
  if (!resultName || !values.has(resultName)) return null;
  const s = String(values.get(resultName)).trim();
  return (s && /[_#*%&|$]/.test(s)) ? s : null;
}

// THE IDENTITY READ, WITHOUT THE SCREEN.
//
// The coding hub needs the car's equipment codes before it can decide which
// module fills each slot, and it needs them as data, not as a rendered card.
// This is that read: same discovery, same job, same decoding, no DOM.
//
// Returns { codes, ci, fa, keys, source } -- `codes` being SA catalogue
// numbers, the namespace SGET predicates use. An empty `codes` means the car
// did not say, and callers must treat that as "nothing known" rather than
// "no equipment": selecting modules off an empty list would re-point them
// against nothing.
const _viCodesCache = new Map();

async function readIdentityCodes(chassisId) {
  const id = String(chassisId || '').toUpperCase();
  if (_viCodesCache.has(id)) return _viCodesCache.get(id);
  const p = (async () => {
    const empty = { codes: [], ci: {}, fa: null, keys: null, source: null };
    if (typeof VehicleIdentity === 'undefined') return empty;
    if (typeof loadTables === 'function') await loadTables();
    let masters = [];
    try { masters = await viIdentityModulesCached(id); }
    catch (e) { return empty; }
    if (!masters.length) return empty;

    // The order first: its tokens are already catalogue numbers.
    for (const m of masters.filter((x) => x.fa)) {
      try {
        const d = await api(`/api/ecu/${m.sgbd}/run/${m.faJob.job}`,
                            { method: 'POST' });
        const text = viFaFrom(new Map(flatResults(d.sets)), m.faJob.result);
        if (!text) continue;
        const fa = VehicleIdentity.parseFa(text);
        return { codes: VehicleIdentity.saCodesFromFa(fa), ci: {}, fa,
                 keys: null, source: `${m.sgbd}:${m.faJob.job}` };
      } catch (e) { /* try the next master */ }
    }

    // Then the coding key, translated through BMW's chassis tables.
    for (const m of masters.filter((x) => x.zcs)) {
      try {
        const d = await api(`/api/ecu/${m.sgbd}/run/${m.zcsJob.job}`,
                            { method: 'POST' });
        const keys = viKeysFrom(new Map(flatResults(d.sets)), m.zcsJob.keys);
        if (!keys) continue;
        const eq = VehicleIdentity.saCodesFromZcs(id, keys);
        return { codes: eq.codes, ci: eq.ci, fa: null, keys,
                 source: `${m.sgbd}:${m.zcsJob.job}` };
      } catch (e) { /* try the next master */ }
    }
    return empty;
  })();
  _viCodesCache.set(id, p);
  return p;
}

// ---- rendering -------------------------------------------------------------

function viChip(text, title) {
  return `<span class="vi-chip"${title ? ` title="${esc(title)}"` : ''}>`
    + `${esc(text)}</span>`;
}

// The summary card: what the car IS.
function viSummary(chassisId, fa, keys) {
  const rows = [];
  const add = (k, v) => { if (v) rows.push([k, v]); };
  if (fa) {
    add('Chassis', fa.br);
    add('Type', fa.typ);
    add('Build date', fa.date ? String(fa.date).replace(/^#/, '') : null);
    add('Paint', fa.lack);
    add('Upholstery', fa.polster);
    if (fa.zusbau && fa.zusbau.length) add('Order', fa.zusbau.join(' · '));
  }
  if (keys) {
    add('GM key', keys.gm);
    add('SA key', keys.sa);
    add('VN key', keys.vn);
  }
  if (!rows.length) return '';
  return `<div class="vi-summary">`
    + rows.map(([k, v]) =>
      `<div class="vi-sum-k">${esc(k)}</div>`
      + `<div class="vi-sum-v mono">${esc(v)}</div>`).join('')
    + `</div>`;
}

// The equipment block: resolved SA numbers as labelled chips, and an honest
// note about what could not be resolved.
function viEquipment(chassisId, result) {
  const codes = result.codes || [];
  const label = (c) => (typeof VehicleIdentity !== 'undefined'
    ? VehicleIdentity.saLabel(chassisId, c) : null);
  const chips = codes.map((c) => {
    const l = label(c);
    return `<span class="vi-sa" title="${esc(l || 'no catalogue name')}">`
      + `<b>${esc(c)}</b>${l ? `<span>${esc(l)}</span>` : ''}</span>`;
  }).join('');

  let out = `<div class="vi-block"><h3>Equipment</h3>`;
  if (codes.length) {
    out += `<div class="vi-sa-grid">${chips}</div>`;
  } else {
    out += `<div class="vi-none">No option codes resolved.</div>`;
  }

  // WHAT WE COULD NOT RESOLVE IS PART OF THE ANSWER. Most keywords in the
  // coding table are body, engine and market names that carry no catalogue
  // number at all -- LIM, COUP, M52B25, US. Hiding them would make the list
  // look complete when it is not, and a caller reading "no code" as "option
  // absent" is exactly how an equipment filter hides real hardware.
  const un = result.unresolved || [];
  if (un.length) {
    out += `<details class="vi-un"><summary>`
      + `${un.length} descriptor${un.length === 1 ? '' : 's'} with no option `
      + `number</summary>`
      + `<div class="vi-chips">${un.map((k) => viChip(k)).join('')}</div>`
      + `<p class="vi-note">Body, engine and market names. They describe the `
      + `car but have no order code, so they cannot be matched against a `
      + `module's fitment rule.</p></details>`;
  }
  return out + `</div>`;
}

// Coding-index stamps: which .Cxx a module should be read against.
function viStamps(ci) {
  const sgs = Object.keys(ci || {}).sort();
  if (!sgs.length) return '';
  return `<div class="vi-block"><h3>Coding index</h3>`
    + `<div class="vi-chips">`
    + sgs.map((sg) => viChip(`${sg} C${String(ci[sg]).padStart(2, '0')}`,
        `${sg} reads against coding index ${ci[sg]}`)).join('')
    + `</div>`
    + `<p class="vi-note">Which coding variant each module should be read `
    + `against. Addresses move between variants, so this decides where a `
    + `setting lives.</p></div>`;
}

// The source strip: which ECU answered, and how.
function viSources(entries) {
  if (!entries.length) return '';
  return `<div class="vi-src">`
    + entries.map((e) =>
      `<span class="vi-src-i ${e.ok ? 'ok' : 'bad'}">`
      + `<b>${esc(e.sg)}</b> ${esc(e.what)}</span>`).join('')
    + `</div>`;
}

// ---- screen ----------------------------------------------------------------

async function showVehicleIdentity(chassisId) {
  const id = String(chassisId || '').toUpperCase();
  lastScreen = () => showVehicleIdentity(chassisId);
  const back = () => (typeof showSections === 'function'
    ? showSections(chassisId) : showChassis());
  setCrumbs([
    { label: 'Vehicles', fn: showChassis },
    { label: dispChassis(chassisId), fn: back },
    { label: 'Identity' },
  ]);
  sbLeft.textContent = `${dispChassis(chassisId)} · identity`;

  view.innerHTML = head('Identity', dispChassis(chassisId),
    'What the car reports about its own build, and the equipment that follows '
    + 'from it.');
  const panel = document.createElement('div');
  panel.className = 'vi-panel';
  view.appendChild(panel);

  const acts = [{ key: '1', keyLabel: 'F1', label: 'Re-read',
                  fn: () => showVehicleIdentity(chassisId) },
                { key: 'Escape', keyLabel: 'Esc', label: 'Back',
                  kind: 'back', fn: back }];
  setActions(acts);

  if (typeof loadTables === 'function') await loadTables();

  // Who can answer, asked of the modules themselves.
  const masters = await viIdentityModulesCached(id);
  if (!masters.length) {
    panel.innerHTML = errorBlock(
      `No control unit on ${esc(dispChassis(chassisId))} declares a job that `
      + `returns the build record. Without one there is nothing to read.`);
    sbLeft.textContent = 'no identity source';
    return;
  }

  // SGFAM's family name, for labelling the source strip. Absent is fine --
  // it is a nicety, not the mechanism.
  const fam = (typeof VehicleIdentity !== 'undefined')
    ? VehicleIdentity.familyMap(id) : null;
  const famName = (sgbd) => {
    if (!fam) return null;
    const s = String(sgbd).toUpperCase();
    // an exact logical name, else the family whose CABD/ASW mentions it
    if (fam[s]) return s;
    return Object.keys(fam).find((k) =>
      s.startsWith(k) || k.startsWith(s)) || null;
  };

  const sources = [];
  let fa = null, keys = null, faRaw = null;

  // FA first: where a car has one, its option tokens ARE catalogue numbers
  // and no translation is needed at all.
  for (const m of masters.filter((x) => x.fa)) {
    if (fa) break;
    const { job, result } = m.faJob;
    try {
      const d = await api(`/api/ecu/${m.sgbd}/run/${job}`, { method: 'POST' });
      const values = new Map(flatResults(d.sets));
      const text = viFaFrom(values, result);
      if (text) {
        faRaw = text;
        fa = VehicleIdentity.parseFa(text);
        sources.push({ sg: famName(m.sgbd) || m.sgbd, ok: true,
                       what: `order via ${job}` });
      } else {
        sources.push({ sg: famName(m.sgbd) || m.sgbd, ok: false,
                       what: `${job}: no order in reply` });
      }
    } catch (e) {
      sources.push({ sg: famName(m.sgbd) || m.sgbd, ok: false,
                     what: 'no answer' });
    }
  }

  // ZCS for the cars that predate the vehicle order.
  for (const m of masters.filter((x) => x.zcs)) {
    if (keys) break;
    const { job, keys: names } = m.zcsJob;
    try {
      const d = await api(`/api/ecu/${m.sgbd}/run/${job}`, { method: 'POST' });
      const values = new Map(flatResults(d.sets));
      const k = viKeysFrom(values, names);
      if (k) {
        keys = k;
        sources.push({ sg: famName(m.sgbd) || m.sgbd, ok: true,
          what: k.source === 'named' ? `keys via ${job}`
                                     : `key region at byte ${k.offset}` });
      } else {
        // A reply whose keys do not check out is NOT shown as the car's.
        sources.push({ sg: famName(m.sgbd) || m.sgbd, ok: false,
                       what: `${job}: no valid key in reply` });
      }
    } catch (e) {
      sources.push({ sg: famName(m.sgbd) || m.sgbd, ok: false,
                     what: 'no answer' });
    }
  }

  if (!fa && !keys) {
    panel.innerHTML = errorBlock(
      'No control unit answered with a build record. Check the cable and the '
      + 'ignition (engine off, key on), then re-read.')
      + viSources(sources);
    sbLeft.textContent = 'no identity';
    return;
  }

  // Equipment: straight from the order where there is one, through the coding
  // table where there is not.
  let equip;
  if (fa) {
    const codes = VehicleIdentity.saCodesFromFa(fa);
    equip = { codes, keywords: [], ci: {}, unresolved: [], resolved: !!codes.length };
  } else {
    equip = VehicleIdentity.saCodesFromZcs(id, keys);
  }

  const via = fa
    ? 'From the vehicle order, whose option tokens are catalogue numbers.'
    : 'Decoded from the coding key through BMW’s chassis table.';

  panel.innerHTML =
    viSummary(id, fa, keys)
    + `<p class="vi-note vi-via">${esc(via)}</p>`
    + viEquipment(id, equip)
    + viStamps(equip.ci)
    + (faRaw ? `<details class="vi-raw"><summary>Raw order</summary>`
        + `<code class="mono">${esc(faRaw)}</code></details>` : '')
    + viSources(sources);

  sbLeft.textContent = equip.codes.length
    ? `${equip.codes.length} option codes`
    : 'identity read';

  // Hand the resolved codes to the coding screens, which use them to decide
  // which modules this car actually carries.
  if (typeof window !== 'undefined') {
    window.VI_LAST = { chassis: id, codes: equip.codes, ci: equip.ci,
                       fa, keys, resolved: equip.resolved };
  }
}

if (typeof window !== 'undefined') {
  window.showVehicleIdentity = showVehicleIdentity;
  window.chassisHasIdentity = chassisHasIdentity;
  window.readIdentityCodes = readIdentityCodes;
}
