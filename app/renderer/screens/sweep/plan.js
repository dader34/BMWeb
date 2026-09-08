/**
 * @file Whole-vehicle sweep (INPA "Functional Jobs"): the scan plan, and how
 * a target is named before and after the car answers.
 *
 * First piece of screens/sweep/. The folder holds the sweep engine for ANY
 * chassis: the identification sweep asks every module who it is;
 * quickIdentSweep reads identification. Both walk the SAME plan, built by
 * sweepPlan() below, so a module that is skipped as absent by one is
 * skipped by the other for the same reason.
 *
 * THE UNIT OF SCAN IS THE DIAGNOSTIC-ADDRESS GROUP, NOT THE CONFIG ROW.
 * That is BMW's own model and the whole reason this folder has no tables in
 * it. A chassis config lists every variant BMW ever fitted at an address --
 * E46 Engine lists twelve, of which exactly one is in the car. The group SGBD
 * (D_0012, D_MOTOR, ...) is the thing that knows which: running its
 * IDENTIFIKATION probes the address and reports VARIANTE, the concrete SGBD
 * name. So one probe per group answers "is anything here, and what is it",
 * and the read then targets what answered.
 *
 * What this replaces (2026-08-21): a hand-written VARIANT_GROUPS table that
 * covered E46 and E36 only, a chassis-config `variantGroups` array that was
 * derived by a weaker unvalidated rule, and a nav gate that hid Functional
 * Jobs entirely on every other car. All three are gone. The per-ECU `group`
 * field written by tools/export/inpa_config.py (Resolver.group_file_for) is
 * the formula now, and it is validated at generation time against what the
 * group can actually identify -- T_GRTB (BMW's own variant->group table)
 * first, then .IPO tokens accepted only when the group's own string pool
 * names the resolved SGBD. Every group named by every shipped chassis config
 * is present in data/groups (26/26 chassis, 188 distinct groups, 0 missing),
 * so the strict path is available on every car, not two.
 */

/**
 * One ECU row of a chassis config.
 * @typedef {object} ConfigEcu
 * @property {string} sgbd - The SGBD name.
 * @property {string} [label] - Display label.
 * @property {string} [code] - INPA code.
 * @property {string|null} [group] - The diagnostic-address group SGBD.
 * @property {string[]} [variants] - Alias SGBDs this row also answers as.
 */

/**
 * A chassis config as /api/chassis/<id> answers it.
 * @typedef {object} ChassisConfig
 * @property {string} id - Chassis id.
 * @property {{ key?: string, name: string, ecus: ConfigEcu[] }[]} sections
 *   - The menu sections, in INPA order.
 * @property {{ sgbd: string, label: string }[]} [variants] - The car's own
 *   names for variants the menu does not list.
 */

/**
 * One bus address to probe once.
 * @typedef {object} SweepTarget
 * @property {string|null} group - The group SGBD, or null for an ungrouped
 *   row that is read directly.
 * @property {string} section - The config section the target came from.
 * @property {ConfigEcu[]} ecus - Every candidate variant at this address.
 * @property {string|undefined} label - The first configured row's label.
 * @property {Map<string, { sgbd: string, label: string }>} variantNames
 *   - The car's own variant records, by lower-case SGBD.
 */

/**
 * How a target resolved (see resolveTarget in resolve.js).
 * @typedef {object} SweepResolution
 * @property {'ok'|'absent'|'unbuilt'} state - ok: talk to `sgbd`; absent:
 *   nothing answered; unbuilt: the module answered but this build cannot
 *   read it.
 * @property {string} [sgbd] - The SGBD to talk to (ok).
 * @property {ConfigEcu|null} [ecu] - The matching config row (ok), or null.
 * @property {boolean} [strict] - Presence was proven by the group (ok).
 * @property {string} [via] - The variant the group named (unbuilt).
 */

/**
 * Build the scan plan for a chassis: a list of TARGETS, each of which is one
 * bus address to probe once.
 *
 *   grouped target  -- ecus sharing a `group`. Probed by the group's
 *                      IDENTIFIKATION; that answer names the variant to read.
 *   ungrouped target -- one ecu whose config row carries no group (the
 *                      generator's five-step ladder found nothing that could
 *                      identify it). Read directly, and SAID to be read
 *                      directly, because there is no presence test for it.
 *
 * Order is chassis-config order (INPA's own menu order, engine section first)
 * and the first row of a group fixes that group's position, so the display
 * reads like the car rather than like a hash map.
 *
 * Dedup is by sgbd within a group and by sgbd globally for ungrouped rows:
 * the same module listed in two sections is one module.
 * @param {ChassisConfig} ch - The chassis config.
 * @returns {SweepTarget[]} The targets, in config order.
 */
function sweepPlan(ch) {
  const targets = [];
  // the car's own names for variants the menu does not list (see nameFor)
  const variantNames = new Map();
  for (const v of ch.variants || []) {
    if (v && v.sgbd && v.label)
      variantNames.set(String(v.sgbd).toLowerCase(), v);
  }
  const byGroup = new Map();
  const seenSolo = new Set();
  for (const sec of ch.sections || []) {
    for (const ecu of sec.ecus || []) {
      const g = String(ecu.group || '').toLowerCase();
      if (g) {
        let t = byGroup.get(g);
        if (!t) {
          t = {
            group: g,
            section: sec.name,
            ecus: [],
            label: ecu.label,
            variantNames,
          };
          byGroup.set(g, t);
          targets.push(t);
        }
        // every candidate variant at this address, so the identified name has
        // a config row to take its label and INPA code from
        if (!t.ecus.some((e) => sameSgbd(e.sgbd, ecu.sgbd))) t.ecus.push(ecu);
      } else {
        const key = String(ecu.sgbd || '').toLowerCase();
        if (!key || seenSolo.has(key)) continue;
        seenSolo.add(key);
        targets.push({
          group: null,
          section: sec.name,
          ecus: [ecu],
          label: ecu.label,
          variantNames,
        });
      }
    }
  }
  return targets;
}

/**
 * Do two SGBD names name the same module? Config casing is inconsistent by
 * design (D50M57D0 vs ms430ds0), so case never decides anything.
 * @param {unknown} a - One SGBD name.
 * @param {unknown} b - Another.
 * @returns {boolean} True when equal ignoring case.
 */
const sameSgbd = (a, b) =>
  String(a || '').toLowerCase() === String(b || '').toLowerCase();

/**
 * A target's display name. A group is a bus address with several possible
 * occupants, so before it answers there is no one right name: use the first
 * configured row's label (config order = INPA menu order, so this is the name
 * INPA shows too) and let resolution replace it with the real one.
 * @param {SweepTarget} t - The target.
 * @returns {string} The label to print before resolution.
 */
const targetLabel = (t) =>
  t.label || (t.ecus[0] && t.ecus[0].label) || t.group || '?';

/**
 * A config label without its "(variant)" suffix. The config disambiguates
 * same-name rows with a suffix naming the row's OWN sgbd ("GS20/GS8.xx for
 * GM or ZF (gs855)", "... (smg)"), written lowercase as the sgbd is. An
 * uppercase abbreviation that happens to equal the sgbd -- "Electronic
 * vehicle immobilization (EWS)" on ews -- is part of the name and stays.
 * @param {unknown} label - The config label.
 * @param {unknown} sgbd - The row's SGBD.
 * @returns {string} The label with only its own variant tag removed.
 */
const baseLabel = (label, sgbd) => {
  const l = String(label || '').trim();
  const m = /^(.*?)\s*\(([^)]+)\)$/.exec(l);
  return m && m[2] === String(sgbd || '') ? m[1].trim() : l;
};

/**
 * The one name every row on an address shares, or null. With no matching
 * config row, the ADDRESS still tells us what the module is when every row
 * on it carries the same name: one name across the rows -> that is the
 * module (Airbag, Sunroof module, Instrument cluster) whichever variant
 * identified. Different names (the engine address mixes "DDE 4.0 for M57"
 * with "ME9.2 for N42/N45") -> null, and the identified SGBD stays the
 * honest label.
 * @param {SweepTarget} t - The target.
 * @returns {string|null} The shared family label, or null.
 */
function familyLabel(t) {
  const names = new Set(
    (t.ecus || []).map((e) => baseLabel(e.label, e.sgbd)).filter(Boolean)
  );
  return names.size === 1 ? [...names][0] : null;
}

/**
 * Cache of variantLabel lookups by lower-case SGBD, for the session.
 * @type {Map<string, Promise<string|null>>}
 */
const variantLabels = new Map();

/**
 * The identified variant's OWN record. The menu lists three transmissions
 * for an E46, but the build ships a record for every variant the address
 * can answer with -- gs20's says "GS20/GS8.xx for GM or ZF (gs20)".
 * @param {unknown} sgbd - The identified SGBD.
 * @returns {Promise<string|null>} Its label, or null.
 */
async function variantLabel(sgbd) {
  const key = String(sgbd || '').toLowerCase();
  if (!key) return null;
  if (!variantLabels.has(key)) {
    variantLabels.set(
      key,
      api(`/api/ecu/${key}/ecu`)
        .then((info) =>
          info && info.label ? baseLabel(info.label, key) : null
        )
        .catch(() => null)
    );
  }
  return variantLabels.get(key);
}

/**
 * The name to print for what answered. A matching config row wins; then
 * this car's own record for the variant; then the variant's shipped record;
 * then the address's one shared name; never a differently-named sibling.
 *
 * NO MATCH NEVER BORROWS ecus[0]. A group's rows are the variants the MENU
 * lists, and an ident can legitimately name one the menu never had -- E46's
 * D_MOTOR probes the broadcast address FF, so on an MS45 car it answers
 * ms450ds0 while its only rows are d50m47b1 and ME9N45. Falling back to the
 * first row labelled that car's engine "DDE 5.0 for M47 new" and showed its
 * faults under a diesel it does not have. When nothing matches, the
 * identified SGBD name IS the honest label.
 * @param {SweepTarget} t - The target.
 * @param {SweepResolution} r - Its resolution (state ok).
 * @returns {Promise<string>} The label.
 */
async function nameFor(t, r) {
  if (r.ecu && r.ecu.label) return r.ecu.label;
  // this car's own record for the variant (chassis config `variants`)
  const own =
    t.variantNames && t.variantNames.get(String(r.sgbd || '').toLowerCase());
  if (own) return baseLabel(own.label, own.sgbd);
  return (await variantLabel(r.sgbd)) || familyLabel(t) || r.sgbd;
}

/**
 * Which config row does an identified variant correspond to? The ident
 * names an SGBD; match it against each candidate's own sgbd and its declared
 * `variants` aliases.
 * @param {{ ecus: ConfigEcu[] }} t - The target (or anything with rows).
 * @param {string} via - The identified SGBD.
 * @returns {ConfigEcu|null} The row, or null when the menu never listed
 *   that variant (see nameFor for why null, not ecus[0]).
 */
function rowForVariant(t, via) {
  return (
    t.ecus.find(
      (e) =>
        sameSgbd(e.sgbd, via) ||
        (e.variants || []).some((v) => sameSgbd(v, via))
    ) || null
  );
}
