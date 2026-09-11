/**
 * @file The vehicle's CONTROL UNITS, one row per slot.
 *
 * THE BUG THIS EXISTS TO KILL. The chassis config lists every SGBD a chassis
 * COULD carry, not what one car has: an E46 lists eight engine variants
 * (MS42, MS43, MS45.1, MSS54, BMS46, ME9, two DDEs) because the model ran
 * with any of them. Drawing that list as the control units gave one car
 * eleven engines. Worse, the fault state was matched by diagnostic address,
 * and all eight share one -- so the single MS45.1's faults lit up its
 * siblings too, and the list showed faults on engines the car has not got.
 *
 * A car has one DME. The config's `group` is the SLOT (the diagnostic
 * address the family answers on) and the SGBDs under it are CANDIDATES for
 * that slot; exactly one of them is installed. So this collapses the list to
 * its slots, and lets the read decide which candidate is in each one.
 *
 * WHAT DECIDES. The newest identification scan: a module that answered says
 * which variant it is, and that variant names the slot. A slot nothing has
 * identified keeps the family's own name and reads "-", because "we have not
 * looked" is a different answer from "nothing is there" and the list must
 * not blur them.
 *
 * Everything that speaks about a control unit goes through here -- the
 * Control unit list, the tree's hover panel, the ECU window, the fault
 * table's module column -- so none of them can disagree about what the car
 * is made of.
 */

/* exported istaSlots istaSlotFor istaSlotIdent */

/**
 * One control unit slot.
 * @typedef {object} IstaSlot
 * @property {string} id - the slot key: the group, or the sgbd when it has none
 * @property {string} group - the diagnostic group, or ''
 * @property {string} section - the config section it sits in
 * @property {string} abbr - what the Abbreviation column shows
 * @property {string} name - what the Control unit name column shows
 * @property {object[]} candidates - every config ECU that could fill it
 * @property {object|null} ecu - the candidate the read identified, or null
 * @property {string} state - ok | faults | silent | unread
 * @property {number} faults - how many faults it holds
 * @property {object|null} ident - what its identification read returned
 * @property {string} sgbd - the identified variant's sgbd, or ''
 */

/**
 * Every identification a scan captured, by the sgbd that answered.
 * @param {object|null} report - a stored scan's report
 * @returns {Map<string, object>} sgbd (lower case) to its ident
 */
function istaSlotIdent(report) {
  const out = new Map();
  for (const m of (report && report.modules) || []) {
    if (!m.ident) continue;
    for (const key of [m.sgbd, m.via])
      if (key) out.set(String(key).toLowerCase(), m.ident);
  }
  return out;
}

/**
 * The control units of a chassis, one per slot, with what the newest scans
 * found in each.
 *
 * Both scans are used and they answer different questions: the fault scan
 * says which slots hold faults, the identification scan says WHICH VARIANT
 * is in a slot. A car that has only ever been fault-scanned still gets its
 * slots named after the family, because the read that names a variant is a
 * different read.
 * @param {object|null} config - the chassis config
 * @param {object|null} faults - the newest fault scan's report
 * @param {object|null} ident - the newest identification scan's report
 * @returns {IstaSlot[]} the slots, in config order
 */
function istaSlots(config, faults, ident) {
  /** @type {Map<string, IstaSlot>} */
  const slots = new Map();

  for (const sec of (config && config.sections) || [])
    for (const ecu of sec.ecus || []) {
      // an ECU with no group is its own slot: nothing else can be in it
      const id = String(ecu.group || ecu.sgbd || ecu.code || '').toUpperCase();
      if (!id) continue;
      if (!slots.has(id))
        slots.set(id, {
          id,
          group: String(ecu.group || '').toUpperCase(),
          section: sec.name || '',
          abbr: '',
          name: '',
          candidates: [],
          ecu: null,
          state: 'unread',
          faults: 0,
          ident: null,
          sgbd: '',
        });
      slots.get(id).candidates.push(ecu);
    }

  // what answered, and what it said it was
  const identBy = istaSlotIdent(ident);
  const faultBy = new Map();
  for (const m of (faults && faults.modules) || [])
    for (const key of [m.sgbd, m.via])
      if (key)
        faultBy.set(String(key).toLowerCase(), {
          state: (m.codes || []).length ? 'faults' : 'ok',
          n: (m.codes || []).length,
        });
  const silentBy = new Set();
  for (const s of (faults && faults.silent) || [])
    if (s.target) silentBy.add(String(s.target).toLowerCase());

  for (const slot of slots.values()) {
    // THE SLOT IS FILLED BY WHAT ANSWERED, not by the first candidate in the
    // config. A candidate counts as installed when a read reached it by name
    // -- an identification, a fault read, or a recorded silence -- because
    // only a read can tell eight engine variants apart.
    const hit = slot.candidates.find((c) => {
      const key = String(c.sgbd || '').toLowerCase();
      return identBy.has(key) || faultBy.has(key) || silentBy.has(key);
    });
    if (hit) {
      slot.ecu = hit;
      slot.sgbd = hit.sgbd || '';
      const key = String(hit.sgbd || '').toLowerCase();
      slot.ident = identBy.get(key) || null;
      const f = faultBy.get(key);
      if (f) {
        slot.state = f.state;
        slot.faults = f.n;
      } else if (silentBy.has(key)) {
        slot.state = 'silent';
      } else if (slot.ident) {
        // it answered the identification read, so it is there and awake; its
        // fault memory simply has not been asked for
        slot.state = 'unread';
      }
      slot.abbr = hit.code || hit.sgbd || slot.id;
      slot.name = hit.label || hit.sgbd || slot.id;
    } else {
      // NOTHING HAS IDENTIFIED THIS SLOT. It keeps the family's name rather
      // than borrowing one candidate's, because naming it "MS45.1" on a car
      // nobody has read would be a guess wearing a fact's clothes.
      slot.abbr = istaSlotFamilyAbbr(slot);
      slot.name = istaSlotFamilyName(slot);
    }
  }
  return [...slots.values()];
}

/**
 * The abbreviation for a slot nobody has identified.
 *
 * One candidate means one answer. Several means the slot is a family, and
 * the group is the only name the car has not chosen between yet.
 * @param {IstaSlot} slot - the slot
 * @returns {string}
 */
function istaSlotFamilyAbbr(slot) {
  if (slot.candidates.length === 1)
    return slot.candidates[0].code || slot.candidates[0].sgbd || slot.id;
  return slot.group || slot.id;
}

/**
 * The name for a slot nobody has identified.
 * @param {IstaSlot} slot - the slot
 * @returns {string}
 */
function istaSlotFamilyName(slot) {
  if (slot.candidates.length === 1)
    return slot.candidates[0].label || slot.candidates[0].sgbd || slot.id;
  // The shared head of the candidates' labels names the family only when it
  // ENDS AT A WORD BOUNDARY. "MS42" and "MS45.1" share "MS4", which is not a
  // control unit and reads as a truncated model number wearing a fact's
  // clothes; "DDE 4.0" and "DDE 5.0" share "DDE", which is one. So the head
  // must be whole words, and anything shorter falls back to the section,
  // which is always true of every candidate in the slot.
  const labels = slot.candidates.map((c) => c.label || c.sgbd || '');
  const first = labels[0] || '';
  let n = first.length;
  for (const l of labels.slice(1)) {
    let i = 0;
    while (i < n && i < l.length && first[i] === l[i]) i++;
    n = i;
  }
  const cut = first.slice(0, n);
  const whole =
    n === first.length || /[\s/,-]/.test(first.charAt(n) || '')
      ? cut.replace(/[\s/,-]+$/, '')
      : '';
  if (whole.length >= 3) return whole;
  return slot.section || slot.group || slot.id;
}

/**
 * The slot one sgbd belongs to.
 * @param {IstaSlot[]} slots - from istaSlots
 * @param {string} sgbd - the module's sgbd
 * @returns {IstaSlot|null}
 */
function istaSlotFor(slots, sgbd) {
  const want = String(sgbd || '').toLowerCase();
  if (!want) return null;
  return (
    (slots || []).find((s) =>
      (s.candidates || []).some(
        (c) => String(c.sgbd || '').toLowerCase() === want
      )
    ) || null
  );
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    istaSlots,
    istaSlotFor,
    istaSlotIdent,
    istaSlotFamilyAbbr,
    istaSlotFamilyName,
  };
}
