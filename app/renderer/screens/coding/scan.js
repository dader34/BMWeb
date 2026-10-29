/**
 * @file The coding scan: which modules of a chassis can be coded, which
 * variant of each the car actually carries, and what each one is coded to
 * right now. Everything the coding screens draw is seeded from here.
 */

/**
 * A module the coding hub can show, with its kind: 'values' (the SGBD names
 * its coding -- editable read) or 'map' (BMW's DATEN description of the blob
 * -- reference).
 * @typedef {Object} CodeableModule
 * @property {string} sgbd - the module (retargeted when the car named a variant).
 * @property {string} label - display label.
 * @property {string} [group] - the diagnostic-address group.
 * @property {string} [section] - the chassis section it was listed under.
 * @property {'values'|'map'} kind - how its coding can be shown.
 * @property {SlotSelection} [select] - the SGET selection, when equipment codes decided.
 * @property {'identified'|'confirmed'|'unverified'|'sole'|'unbuilt'} [_codingVariant]
 *   - what the bus said about the variant.
 * @property {string} [_variantOf] - the configured name, when it was replaced.
 * @property {string} [_variantVia] - the variant the car named but this build cannot decode.
 * @property {ModuleStatus} [coding] - the scan's status, once filtered by it.
 */

/**
 * How one module answered the coding scan.
 * @typedef {Object} ModuleStatus
 * @property {'ok'|'raw'|'noread'|'silent'} state - answered with decodable
 *   fields / with only a raw blob / has no read job / did not answer.
 * @property {number} [fields] - how many decodable fields it answered with.
 * @property {string} [job] - its JOB_STATUS, when it answered.
 * @property {string} [error] - why it was silent.
 */

/**
 * The scan result: sgbd -> its flattened read results, plus per-module
 * status and the RESOLVED module list every consumer works from.
 * @typedef {Map<string, Map<string, string>> & {status: Map<string, ModuleStatus>, mods: CodeableModule[], images: Map<string, CodingImage>, sources: Map<string, CodingSource>}} ScanCache
 */

// A module that answered with decodable fields is editable. One that answered
// with only a raw blob (zke5's COD_DATEN, szm46's CODE) is present but has no
// decoder here, so it is kept and marked rather than shown as toggles it
// cannot back. One that never answered is dropped: on a real car that is
// almost always hardware this car does not carry.
/**
 * The modules this car actually has, out of the ones the chassis map lists.
 * @param {CodeableModule[]} mods - the modules.
 * @param {ScanCache|null|undefined} scan - the scan.
 * @returns {CodeableModule[]} the present modules, each with `coding` set;
 *   the input unchanged for pre-scan callers.
 */
function codingPresent(mods, scan) {
  const status = (scan && scan.status) || new Map();
  if (!status.size) return mods; // pre-scan callers: unchanged
  return mods
    .map((m) => ({ ...m, coding: status.get(m.sgbd) || { state: 'silent' } }))
    .filter((m) => m.coding.state === 'ok' || m.coding.state === 'raw');
}

/**
 * The result names that carry a coding index, in the order
 * {@link codingIndexFromScan} reads them. Declared once so the scan can ask
 * "did the read already give me one?" with the same vocabulary.
 * @type {string[]}
 */
const CI_RESULTS = [
  'ID_COD_INDEX',
  'CODIER_INDEX',
  'CODIERINDEX',
  'COD_INDEX',
  'ID_CODIERINDEX',
];

/**
 * The ECU's coding index (Cxx), read from the scan. INPA returns it as
 * ID_COD_INDEX / CODIER_INDEX alongside the coding read; it's the number after
 * the "C" in the variant key (C06 -> 6).
 * @param {ScanCache|Map<string, Map<string, string>>|null|undefined} scan - the scan.
 * @param {string} sgbd - the module.
 * @returns {number|null} the index, or null when the scan didn't name it
 *   (offline, or a module that doesn't report it).
 */
function codingIndexFromScan(scan, sgbd) {
  const res = scan && scan.get(String(sgbd).toLowerCase());
  if (!res) return null;
  for (const k of CI_RESULTS) {
    if (res.has(k)) {
      // The result's DIGITS are the coding file's extension: BMW's coding
      // scripts (CILesen in A_IHK46, A_ALSZ, ...) take ID_COD_INDEX as text,
      // pad it to two characters and set it as CODIERINDEX -- "17" is
      // IHK_E46.C17, "34" is LSZ.C34. The SGBD reads the byte as BCD, so
      // the digits are the byte's hex digits; the number is that, in hex.
      const text = String(res.get(k)).trim();
      const n = /^0x[0-9a-f]+$/i.test(text)
        ? parseInt(text.slice(2), 16)
        : /^[0-9a-f]{1,2}$/i.test(text)
          ? parseInt(text, 16)
          : NaN;
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

// WHERE A MODULE'S CODING IS READ FROM, by BMW's own tables:
//
//   the coding description      which FILE (KMB_E46) and, by the module's
//   (DATEN map)                 coding index, which variant of it (C08)
//   the selection table (SGET)  for that file and variant, the CODING SGBD
//                               to run jobs on (KOMBI46R -- not the one the
//                               diagnostic side uses) and the coding SCRIPT
//                               (A_KMB46 for a car coded by its central key,
//                               A_AKMB46 for one coded by its vehicle order)
//   the script index            which shipped file holds that script
//
// A module whose description numbers its blocks is not read through its
// script (the address its jobs expect is not established); for those the raw
// block a diagnostic read hands back is used, and it is block 0 only.
/**
 * How one module's coding image is obtained.
 * @typedef {Object} CodingSource
 * @property {'script'|'blob'} route - through the coding script, or the raw
 *   block of the diagnostic read.
 * @property {string} [sgbd] - script route: the coding SGBD.
 * @property {string} [script] - script route: the script's name (A_KMB46).
 * @property {string} [dispatchKey] - script route: the file it ships in.
 * @property {object} [cabd] - script route: the coding description.
 * @property {boolean} [decided] - script route: the car's equipment (or the
 *   table itself) settled WHICH script is this car's. A read does not depend
 *   on it; a write does.
 * @property {string} [why] - when there is no source: the reason, for display.
 */

/** @type {Promise<Record<string, string>|null>|null} script name -> file key */
let _codingScripts = null;
/**
 * The shipped coding scripts, by name.
 * @returns {Promise<Record<string, string>>} name (uppercase) -> file key.
 */
function codingScriptIndex() {
  if (!_codingScripts) {
    _codingScripts = (
      typeof webFetchJson === 'function'
        ? webFetchJson('data/coding-dispatch/scripts.json')
        : api('/data/coding-dispatch/scripts.json')
    )
      .then((d) => d || {})
      .catch(() => ({}));
  }
  return _codingScripts;
}

/**
 * Read one module's coding image from its source.
 * @param {CodingSource|{route: null}} source - from codingSourceOf.
 * @param {Map<string, string>|null} got - the module's diagnostic read, for
 *   the raw-block route.
 * @returns {Promise<CodingImage|null>} the image, or null when the source
 *   yields none.
 * @throws {Error} when a script read fails.
 */
async function codingReadImage(source, got) {
  if (!source || !source.route) return null;
  if (source.route === 'script') {
    const r = await webReadCoding(source.sgbd, {
      dispatchKey: source.dispatchKey,
      cabd: source.cabd,
    });
    // A numbered-block module whose own jobs cannot tell its blocks apart
    // on the wire (webCodingBlockProven): only block 0 is known to be what
    // the module holds -- another block's read may come back as block 0
    // again. Shown as unknown, never as block 0's bytes.
    const proven =
      !source.blocked ||
      (typeof webCodingBlockProven === 'function' &&
        (await webCodingBlockProven(source.sgbd, codingBlocks(source.cabd))));
    const known = new Set(proven ? r.read : r.read.filter((a) => a < 256));
    return {
      bytes: r.netto,
      known,
      block: null,
      // block N of a numbered-block module sits at N * 256 in it
      flat: !!source.blocked,
      route: 'script',
    };
  }
  // the raw block a diagnostic read returns, under the three names the
  // SGBDs use for it
  const bytes = codBytesOf(
    got && (got.get('COD_DATEN') ?? got.get('CODE') ?? got.get('CODIERDATEN'))
  );
  return bytes ? { bytes, known: null, block: 0, route: 'blob' } : null;
}

// THE STATUS IS THE POINT. Coding writes are a delta against what was read,
// so a module that did not answer must not show library defaults as if
// they were the car's settings. Each module records whether it answered,
// and with how many decodable fields, and the caller shows only what the
// car really has.
//
// NCS EXPERT'S OWN PROCEDURE, NO NAMES MATCHED. The modules are the
// chassis's SGFAM slots; each one's coding index is read through its own
// coding script, the selection table (SGET) names the coding file, SGBD and
// script for that slot and index, and the coding file is registered for the
// module so every screen's datenFor() gets exactly it (ncs-slots.js).
/**
 * Scan the car's coding: every codeable module, read once.
 * @param {string} chassisId - chassis id.
 * @param {HTMLElement} host - where the progress bar paints.
 * @param {string[]} [saCodes] - the car's equipment codes, when known.
 * @returns {Promise<ScanCache>} values per module, status per module, and
 *   the module list.
 */
async function scanCoding(chassisId, host, saCodes) {
  const chId = String(chassisId || '').toUpperCase();
  const slots = await ncsSlots(chId);
  const cache = /** @type {ScanCache} */ (new Map());
  const status = new Map();
  cache.status = status;
  cache.images = new Map();
  cache.sources = new Map();
  let equipment = null;
  // the factory tool's equipment: the order through the AT table, else the
  // coding key through the ZST table (CodingSelect.carEquipment)
  if (saCodes && saCodes.car && typeof CodingSelect !== 'undefined') {
    try {
      if (typeof loadTables === 'function') await loadTables();
      equipment = CodingSelect.carEquipment(chId, saCodes.car).ids;
    } catch {
      equipment = null;
    }
  }
  const total = slots.length;
  const paint = (done, name) => {
    host.innerHTML =
      `<div class="coding-scan">` +
      `<div class="coding-scan-title">Reading the car…</div>` +
      `<div class="coding-scan-bar"><span style="width:` +
      `${Math.round((100 * done) / Math.max(1, total))}%"></span></div>` +
      `<div class="coding-scan-mod mono">${esc(name || '')}` +
      ` · ${done}/${total} modules</div></div>`;
  };
  paint(0, '');

  // 1. every slot's coding index and coding file. Two slots on one coding
  // file and index (KMB / AKMB, LSZ / ALSZ) are one module coded by one of
  // two scripts: the car's equipment says which when it is known.
  const byFile = new Map();
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    paint(i, slot.umrsg);
    let got;
    try {
      got = await ncsReadSlot(chId, slot, { image: false });
    } catch (e) {
      got = { fns: [], why: String((e && e.message) || e) };
    }
    if (!got.fns || !got.fns.length) continue; // not fitted / not answering
    if (
      equipment &&
      typeof CodingSelect !== 'undefined' &&
      got.row &&
      !CodingSelect.rowApplies(got.row, equipment)
    )
      continue; // the slot of another build of this car
    const key = `${got.file}.${got.cbd}`;
    const have = byFile.get(key);
    if (have) {
      have.choices.push({
        script: got.source.script,
        dispatchKey: got.source.dispatchKey,
        rule: got.row ? got.row.expr : '',
        slot: slot.umrsg,
      });
      continue;
    }
    byFile.set(key, {
      slot,
      got,
      choices: [
        {
          script: got.source.script,
          dispatchKey: got.source.dispatchKey,
          rule: got.row ? got.row.expr : '',
          slot: slot.umrsg,
        },
      ],
    });
  }

  // 2. one module per coding file: register the file, read the image once
  const mods = [];
  let done = 0;
  for (const { slot, got, choices } of byFile.values()) {
    paint(Math.min(total, ++done), slot.umrsg);
    const k = slot.umrsg.toLowerCase();
    codingRegisterFile(k, got.entry);
    const scripts = [...new Set(choices.map((c) => c.script))];
    const source = {
      ...got.source,
      // the car's vehicle order, for a script that reads it (EWS3 writes the
      // paint and upholstery codes from it)
      fa:
        saCodes && saCodes.car && saCodes.car.fa
          ? String(saCodes.car.fa.raw || '')
          : '',
      // two scripts for one file: which is the car's is the expert's call
      // unless its equipment settled it above
      decided: scripts.length === 1,
      choices,
    };
    cache.sources.set(k, source);
    // the index, where every screen reads it (codingIndexFromScan)
    const read = new Map([['ID_COD_INDEX', got.cbd.slice(1)]]);
    cache.set(k, read);
    mods.push({
      sgbd: k,
      label: `${choices.map((c) => c.slot).join(' / ')} · ${got.file}.${got.cbd}`,
      file: `${got.file}.${got.cbd}`,
      slot,
      kind: 'map',
    });
    try {
      const image = await codingReadImage(source, read);
      if (image) cache.images.set(k, image);
      status.set(k, image ? { state: 'ok', fields: 0 } : { state: 'noread' });
    } catch (e) {
      source.why = String((e && e.message) || e);
      status.set(k, { state: 'silent', error: source.why });
    }
  }
  cache.mods = mods;
  paint(total, '');
  return cache;
}

// These are BMW's SA catalogue numbers (205 automatic, 210 DSC). Module
// selection does not test them directly: an SGET predicate is written in the
// chassis's keyword ids, and CodingSelect.aswIds translates. Two sources, by
// generation:
//
//   the vehicle order (FA)  E60+   its `$` tokens ARE catalogue numbers
//   the coding key (ZCS)    older  bit indices, translated through BMW's own
//                                  ZST + AT tables (see core/vehicle-identity.js)
/**
 * THE CAR'S OWN EQUIPMENT CODES, read before anything else.
 * @param {string} chassisId - chassis id.
 * @returns {Promise<string[]>} the codes, or [] when the car will not say --
 *   no cable, no identity module, or a key whose bits carry no catalogue
 *   number. That is not a failure: callers treat an empty list as "nothing
 *   known", which leaves the configured module names in place rather than
 *   selecting on a guess.
 */
async function readVehicleSaCodes(chassisId) {
  if (
    typeof showVehicleIdentity !== 'function' ||
    typeof VehicleIdentity === 'undefined'
  )
    return [];
  try {
    const got = await readIdentityCodes(chassisId);
    const codes = ((got && got.codes) || []).slice();
    // the keywords a coding key decodes to ride along (the module-revision
    // stamps among them have no catalogue number, and module selection is
    // decided on exactly those); not enumerable, so the list is still a list
    Object.defineProperty(codes, 'keywords', {
      value: (got && got.keywords) || [],
    });
    // what the car's equipment for module selection is read from: its
    // order or its coding key, as the factory tool reads them
    Object.defineProperty(codes, 'car', {
      value: got && (got.fa || got.keys) ? { fa: got.fa, zcs: got.keys } : null,
    });
    return codes;
  } catch (e) {
    return [];
  }
}

// The pieces the other coding screens call; published explicitly so the
// shared surface is visible.
if (typeof window !== 'undefined') {
  window.codingPresent = codingPresent;
  window.codingIndexFromScan = codingIndexFromScan;
  window.codingScriptIndex = codingScriptIndex;
  window.codingReadImage = codingReadImage;
  window.scanCoding = scanCoding;
  window.readVehicleSaCodes = readVehicleSaCodes;
}
