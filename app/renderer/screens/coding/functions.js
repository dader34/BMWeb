/**
 * @file One module's DATEN functions for a car: the coding-index-aware
 * variant pick, the user overlay, BMW's block names, and the guard that
 * refuses to write from an unresolved view.
 */

/**
 * A module's function list with HOW it was resolved carried alongside as
 * non-enumerable properties, so the array still serialises / spreads / maps
 * exactly as before and the write path can ask.
 * @typedef {DatenField[] & {codingIsResolved: boolean, codingIndex: number|null, codingVariants: string[]}} FunctionList
 */

/**
 * A variant key ("C06", or a folded "C06+C07") contains coding index n?
 * @param {string} key - the variant key.
 * @param {number} n - the coding index.
 * @returns {boolean} true when the key carries it.
 */
function variantHasCI(key, n) {
  return String(key)
    .split('+')
    .some((k) => {
      const m = /C0*(\d+)/i.exec(k);
      return m && parseInt(m[1], 10) === n;
    });
}

/**
 * Block names per "sgbd:block", cached for the session.
 * @type {Map<string, {name: string, en: string}|null>}
 */
const _blockNameCache = new Map();

// Synchronous on purpose: it runs inside the tree's redraw loop, and the
// datenmap is already resident by then (moduleFunctions awaited it).
/**
 * BMW's name for a coding block, e.g. block 12288 of alc_ds2 ->
 * "Grundkonfiguration_ALC-SG" / "Basic configuration adaptive headlights
 * (AHL) control unit".
 * @param {string} sgbd - the module.
 * @param {number|null|undefined} block - the block number.
 * @returns {{name: string, en: string}|null} the name and its translation,
 *   or null when the module ships no block table (15 of 83 do not) -- the
 *   caller then simply omits the header rather than showing a bare number.
 */
function blockName(sgbd, block) {
  if (block == null) return null;
  const key = `${sgbd}:${block}`;
  if (_blockNameCache.has(key)) return _blockNameCache.get(key);
  const map = (typeof window !== 'undefined' && window.BMW_DATEN_MAP) || null;
  const entry = map && map[String(sgbd).toLowerCase()];
  const raw = entry && entry.blocks && entry.blocks[String(block)];
  const out = raw
    ? { name: raw, en: typeof datI18n === 'function' ? datI18n(raw) : '' }
    : null;
  _blockNameCache.set(key, out);
  return out;
}

// CI-AWARE: when the scan named the ECU's coding index, use ONLY the variant
// that carries it -- addresses move between indices (E46 KMB's ZCS region is
// word 104 on C02-C06 but 368 on C07-C08), so unioning would show a field
// twice and a write off the wrong stamp lands in the wrong memory. Without a
// known index, fall back to the union across variants (a reference, not a
// write target).
// FA/ZCS-AWARE: when saCodes is provided, filter out fields that don't match
// the car's equipment (field.asw requirement).
/**
 * One module's DATEN functions for a chassis.
 * @param {string} chassisId - chassis id.
 * @param {string} sgbd - the module.
 * @param {number|null} [ci] - the car's coding index, when the scan named it.
 * @param {string[]|null} [saCodes] - the car's SA codes for the field filter.
 * @returns {Promise<FunctionList>} the fields, with the resolution carried
 *   alongside (see {@link FunctionList}).
 */
async function moduleFunctions(chassisId, sgbd, ci = null, saCodes = null) {
  const daten = typeof datenFor === 'function' ? await datenFor(sgbd) : null;
  const byKey = new Map();
  let resolved = false; // did ci pick exactly the variants carrying it?
  let variants = []; // which variant keys the fields came from

  if (daten) {
    const chId = String(chassisId || '').toUpperCase();
    const chassis =
      daten.chassis[chId] || daten.chassis[Object.keys(daten.chassis)[0]];
    if (chassis) {
      const keys = Object.keys(chassis);
      const pick = ci != null ? keys.filter((k) => variantHasCI(k, ci)) : [];
      const use = pick.length ? pick : keys; // matched index, else all
      // Did the coding index actually resolve to ONE stamp? Only then are the
      // addresses below provably this ECU's. codingIsResolved is what the
      // write path gates on -- see assertResolvedForWrite().
      resolved = pick.length > 0;
      variants = use.slice();
      for (const vk of use) {
        for (const f of chassis[vk]) {
          const key = `${f.block || 0}:${f.word || 0}:${f.byte || 0}:${f.mask || 0}`;
          if (!byKey.has(key)) {
            byKey.set(key, f);
          }
        }
      }
    }
  }

  let fns = [...byKey.values()];

  // The user's own parameters, overlaid on BMW's description. Scoped to the
  // variant actually in use, so a row defined against C04's layout never
  // shows up on C07's. mergeCustom returns the input untouched when there is
  // no overlay, so this costs nothing for the common case.
  if (typeof CodingCustom !== 'undefined' && variants.length) {
    fns = CodingCustom.mergeCustom(fns, sgbd, chassisId, variants.join('+'));
  }

  // Apply FA/ZCS filtering if we have SA codes
  if (saCodes && typeof CodingZcs !== 'undefined' && CodingZcs.matchesAsw) {
    fns = fns.filter((f) => CodingZcs.matchesAsw(f, saCodes));
  }

  // Carry HOW this list was resolved alongside it. Non-enumerable so the
  // array still serialises / spreads / maps exactly as before -- every
  // existing caller keeps working, and the write path can ask.
  Object.defineProperty(fns, 'codingIsResolved', { value: resolved });
  Object.defineProperty(fns, 'codingIndex', { value: ci });
  Object.defineProperty(fns, 'codingVariants', { value: variants });
  return /** @type {FunctionList} */ (fns);
}

// THE UNION IS NOT A WRITE TARGET. When the coding index did not resolve to a
// single stamp, moduleFunctions unions every variant and de-dupes first-wins
// by address -- so a field whose address MOVED between indices resolves to
// whichever variant enumerated first. E46 KMB's ZCS region is word 104 on
// C02-C06 but 368 on C07-C08: writing off the wrong stamp puts bytes into the
// wrong ECU memory. Reading that view is fine; transmitting from it is not.
/**
 * Refuse to write from a view that is not provably this ECU's layout.
 * @param {string} sgbd - the module.
 * @param {FunctionList|null} fns - the module's functions.
 * @param {CodeableModule|null|undefined} mod - the module, for the variant check.
 * @returns {void}
 * @throws {Error} with a message naming the ECU when the variant on the wire
 *   was not confirmed, or the coding index did not resolve to one stamp.
 */
function assertResolvedForWrite(sgbd, fns, mod) {
  // WHICH MODULE, before which layout. The check below verifies the coding
  // INDEX picked one variant stamp inside this SGBD's own DATEN -- it says
  // nothing about whether this SGBD is the module on the wire. Those are two
  // different axes and only one of them was ever guarded: a diagnostic
  // address is shared, and writing ews's map into an EWS3 changes bits nobody
  // chose. codingResolveVariants asks the group; if it could not, refuse.
  if (mod && ['unverified', 'unbuilt'].includes(mod._codingVariant)) {
    throw new Error(
      `refusing to write ${sgbd}: nothing confirmed this is the variant ` +
        `fitted. ${mod.label || sgbd} shares diagnostic address ` +
        `${mod.group || '?'} with other modules, and a coding write is a ` +
        `delta against the layout of whichever one answers. Reconnect and ` +
        `re-read so the address group can identify itself.`
    );
  }
  if (fns && fns.codingIsResolved) return;
  const ci = fns ? fns.codingIndex : null;
  const vs = (fns && fns.codingVariants) || [];
  throw new Error(
    `refusing to write ${sgbd}: coding index unresolved` +
      (ci == null
        ? ' (the scan did not report one)'
        : ` (C${String(ci).padStart(2, '0')} matches no shipped variant)`) +
      (vs.length > 1 ? `; showing a union of ${vs.join(', ')}` : '') +
      '. Addresses move between coding indices, so this view is a reference ' +
      'only -- re-scan with the ECU connected to resolve its index.'
  );
}

// The pieces the other coding screens call; published explicitly so the shared surface is visible.
if (typeof window !== 'undefined') {
  window.variantHasCI = variantHasCI;
  window.blockName = blockName;
  window.moduleFunctions = moduleFunctions;
  window.assertResolvedForWrite = assertResolvedForWrite;
}
