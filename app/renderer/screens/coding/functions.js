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
  // A coding file's extension is its index in HEX: LSZ.C34 serves index 52.
  // (Read as decimal, every index from 10 up missed its file.)
  return String(key)
    .split('+')
    .some((k) => {
      const m = /^C([0-9A-F]{2})$/i.exec(k.trim());
      return !!m && parseInt(m[1], 16) === n;
    });
}

/**
 * The variant of a module's coding description that serves a coding index:
 * the one whose own list of indexes (the file's SGID_CODIERINDEX) holds it,
 * or failing a list, whose file extension is that index.
 * @param {DatenMapEntry} daten - the module's DATEN entry.
 * @param {string} chKey - the chassis key inside it.
 * @param {number} ci - the coding index.
 * @returns {string[]} the variant keys (one, unless the data is ambiguous).
 */
function variantsForCI(daten, chKey, ci) {
  const keys = Object.keys((daten.chassis && daten.chassis[chKey]) || {});
  const lay = (daten.layout && daten.layout[chKey]) || {};
  const listed = keys.filter(
    (k) => lay[k] && Array.isArray(lay[k].index) && lay[k].index.includes(ci)
  );
  return listed.length ? listed : keys.filter((k) => variantHasCI(k, ci));
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
 * @param {object|null} [file] - the coding file itself, as NCS names it
 *   (ncs-slots.js: SGET's SGNAME for the module's slot and index); without
 *   it the description is looked up by the diagnostic SGBD's name.
 * @returns {Promise<FunctionList>} the fields, with the resolution carried
 *   alongside (see {@link FunctionList}).
 */
async function moduleFunctions(
  chassisId,
  sgbd,
  ci = null,
  saCodes = null,
  file = null
) {
  const daten =
    file || (typeof datenFor === 'function' ? await datenFor(sgbd) : null);
  const byKey = new Map();
  let resolved = false; // did ci pick exactly the variants carrying it?
  let variants = []; // which variant keys the fields came from
  let layout = null; // the variant's memory organisation and named blocks

  if (daten) {
    const chId = String(chassisId || '').toUpperCase();
    const chassis =
      daten.chassis[chId] || daten.chassis[Object.keys(daten.chassis)[0]];
    if (chassis) {
      const keys = Object.keys(chassis);
      const chKey = daten.chassis[chId] ? chId : Object.keys(daten.chassis)[0];
      const pick = ci != null ? variantsForCI(daten, chKey, ci) : [];
      const use = pick.length ? pick : keys; // matched index, else all
      // Did the coding index actually resolve to ONE stamp? Only then are the
      // addresses below provably this ECU's. codingIsResolved is what the
      // write path gates on -- see assertResolvedForWrite().
      resolved = pick.length > 0;
      variants = use.slice();
      // one variant, provably this module's: its layout rides along for the
      // write (word width, the blocks BMW's coding script names, the coding
      // indexes it serves)
      if (resolved && use.length === 1) {
        layout =
          (daten.layout &&
            daten.layout[chKey] &&
            daten.layout[chKey][use[0]]) ||
          null;
      }
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
  Object.defineProperty(fns, 'codingLayout', { value: layout });
  // Functions that are not coding data: the description sorts its blocks
  // into coding, manufacturer and reserved data, and only the first is what
  // a coding job writes. The others are shown, never offered for a change.
  const locked = new Set();
  const kinds = ((layout && layout.groups) || []).filter((g) => g[4]);
  if (kinds.length) {
    const coding = kinds.filter((g) => g[4] === 'coding');
    for (const f of fns) {
      if (f.custom) continue;
      const start = f.word || 0;
      const end = start + (f.byte || 1);
      const inside = coding.some(
        ([, at, len, block]) =>
          (block || 0) === (f.block || 0) && start >= at && end <= at + len
      );
      if (!inside) locked.add(f.name);
    }
  }
  Object.defineProperty(fns, 'codingLocked', { value: locked });
  return /** @type {FunctionList} */ (fns);
}

/**
 * The coding description a dispatcher write selects from: the module's
 * functions with their addresses, the named blocks, the coding indexes and
 * how the memory is organised. Null when the list is not one resolved variant
 * with a known layout -- the same condition under which a write is refused.
 * @param {FunctionList} fns - a module's functions from moduleFunctions().
 * @returns {{fields: object[], groups: object[], codingIndex: number[], typ: string}|null}
 */
function codingCabdOf(fns) {
  const lay = fns && fns.codingLayout;
  if (!lay || !fns.codingIsResolved) return null;
  return {
    // BMW's own rows only: a user-defined row is an overlay on the image, not
    // a function the module's coding script knows by name
    fields: fns
      .filter((f) => !f.custom)
      .map((f) => ({
        name: f.name,
        word: f.word || 0,
        byte: f.byte || 1,
        block: f.block || 0,
        mask: f.mask,
        masks: f.masks,
      })),
    groups: (lay.groups || []).map(([name, start, length, block, kind]) => ({
      name,
      start,
      length,
      block: block || 0,
      kind: kind || null,
    })),
    // the unused bits and their fill value (UNBELEGT1/2), when the data
    // build carries them
    ...(Array.isArray(lay.own)
      ? {
          own: lay.own.map(([block, start, length, masks]) => ({
            block: block || 0,
            start,
            length,
            masks,
          })),
        }
      : {}),
    ...(Array.isArray(lay.fill)
      ? {
          fill: lay.fill.map(([block, start, length, masks, values]) => ({
            block: block || 0,
            start,
            length,
            masks,
            values,
          })),
        }
      : {}),
    codingIndex: lay.index || [],
    typ: lay.typ || 'FREI',
  };
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
  //
  // Two outcomes of that question refuse a write:
  //   unverified  the group did not identify itself: nothing is known;
  //   unbuilt     the group named a variant this build has no map under
  //               (the late E46 cluster answers as kombi46r, the map is
  //               filed under kombi46).
  // The second is settled when the coding itself is read through BMW's
  // selection table: that table pairs the coding file with the coding SGBD
  // to run it on, and if the SGBD it names IS the variant the bus named, two
  // independent sources agree on what is fitted. Then the layout is this
  // module's, and the write goes to it under its own name.
  const variant = mod && mod._codingVariant;
  const src = mod && mod.source;
  const named = String((mod && mod._variantVia) || '').toLowerCase();
  const agreed =
    variant === 'unbuilt' &&
    !!named &&
    !!src &&
    src.route === 'script' &&
    String(src.sgbd || '').toLowerCase() === named;
  if ((variant === 'unverified' || variant === 'unbuilt') && !agreed) {
    throw new Error(
      `refusing to write ${sgbd}: nothing confirmed this is the variant ` +
        `fitted. ${mod.label || sgbd} shares diagnostic address ` +
        `${mod.group || '?'} with other modules, and a coding write is a ` +
        `delta against the layout of whichever one answers. ` +
        (variant === 'unbuilt'
          ? `The car named ${named || 'another variant'}` +
            (src && src.sgbd
              ? `, but its coding is selected for ${src.sgbd}.`
              : ', and no coding source for it is known.')
          : `Reconnect and re-read so the address group can identify itself.`)
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
  window.variantsForCI = variantsForCI;
  window.blockName = blockName;
  window.moduleFunctions = moduleFunctions;
  window.codingCabdOf = codingCabdOf;
  window.assertResolvedForWrite = assertResolvedForWrite;
}
