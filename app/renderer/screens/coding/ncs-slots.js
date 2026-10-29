/**
 * @file NCS Expert's own way to a module's coding -- no names matched.
 *
 *   SGFAM (the chassis's module list)   slot GM5 -> coding SGBD C_GM5,
 *                                       coding script A_GM5
 *   the coding script's CODIERINDEX_LESEN, run on that SGBD
 *                                       -> the module's index, "05"
 *   SGET (the selection table)          slot GM5 + CBD C05 -> coding file
 *                                       GM5, coding SGBD ZKE5_S12, script
 *                                       A_GM5
 *   the chassis's coding files          GM5.C05 -> the functions
 *
 * Every step is a table BMW ships or a job BMW wrote. The coding files come
 * from data/daten/<CHASSIS>.json (tools/decompile/daten_files.py), keyed by
 * the name SGET gives them.
 */

/* exported ncsSlots, ncsReadSlot, ncsDatenFile */
/* global loadTables, loadSget, codingScriptIndex, webCodingReadJob,
   webFetchJson, moduleFunctions, codingCabdOf, codingReadImage,
   api, flatResults */

/** @type {Map<string, Promise<object|null>>} chassis -> its coding files */
const _ncsDaten = new Map();

/**
 * A chassis's coding files, keyed by NCS's names; their English labels join
 * the shared dictionary.
 * @param {string} chassis - chassis id.
 * @returns {Promise<object|null>} {modules, i18n}, or null when not shipped.
 */
function ncsDatenFile(chassis) {
  const ch = String(chassis || '').toUpperCase();
  if (!_ncsDaten.has(ch)) {
    _ncsDaten.set(
      ch,
      webFetchJson(`data/daten/${ch}.json`)
        .then((d) => {
          if (d && d.i18n && typeof window !== 'undefined')
            window.BMW_DATEN_I18N = {
              ...d.i18n,
              ...(window.BMW_DATEN_I18N || {}),
            };
          return d || null;
        })
        .catch(() => null)
    );
  }
  return _ncsDaten.get(ch);
}

/**
 * NCS's ECU list for a chassis: one entry per SGFAM slot, in its order.
 * @param {string} chassis - chassis id.
 * @returns {Promise<Array<{umrsg: string, sgbd: string, asw: string,
 *   zcs: boolean, fa: boolean, files: string[]}>>}
 */
async function ncsSlots(chassis) {
  if (typeof loadTables === 'function') await loadTables();
  if (typeof loadSget === 'function') await loadSget();
  const ch = String(chassis || '').toUpperCase();
  const t = (typeof window !== 'undefined' && window.BMW_TABLES) || {};
  const sgfam = (t[ch] && t[ch].sgfam) || {};
  const all = (typeof window !== 'undefined' && window.BMW_SGET) || {};
  const rows = (all[ch] && (all[ch].rows || all[ch])) || [];
  return Object.entries(sgfam).map(([umrsg, r]) => ({
    umrsg,
    sgbd: String(r.cabd || '').toLowerCase(),
    asw: String(r.asw || '').toUpperCase(),
    zcs: !!r.zcs,
    fa: !!r.fa,
    // the coding files SGET routes this slot to (GM5; LSZ; KMB_E46 + ...)
    files: [
      ...new Set(
        rows
          .filter((x) => String(x.UMRSG).toUpperCase() === umrsg)
          .map((x) => String(x.SGNAME).toUpperCase())
      ),
    ],
  }));
}

/**
 * The module's coding index, as its coding script reads it (CILesen: IDENT's
 * ID_COD_INDEX, two characters -- the coding file's extension).
 * @param {object} slot - from ncsSlots.
 * @param {string} dispatchKey - the script's file.
 * @returns {Promise<{text: string, why: string}>} the index text ('' when
 *   none was read) and, then, why.
 */
async function ncsCodingIndex(slot, dispatchKey) {
  try {
    const r = await webCodingReadJob(slot.sgbd, {
      dispatchKey,
      jobname: 'CODIERINDEX_LESEN',
    });
    const v = String((r.pars && r.pars.CODIERINDEX) || '').trim();
    if (r.ok && v) return { text: v.padStart(2, '0').toUpperCase(), why: '' };
    // a script without that job: the SGBD's own IDENT, as CILesen runs it
    const d = await api(`/api/ecu/${slot.sgbd}/run/IDENT`, { method: 'POST' });
    const got = new Map(flatResults(d.sets));
    const t = String(got.get('ID_COD_INDEX') || '').trim();
    if (t) return { text: t.padStart(2, '0').toUpperCase(), why: '' };
    return { text: '', why: r.info || 'the module returned no coding index' };
  } catch (e) {
    return { text: '', why: String((e && e.message) || e) };
  }
}

/**
 * Read one slot NCS's way: index, selection-table row, coding file, then the
 * coding image through the row's coding SGBD and script.
 * @param {string} chassis - chassis id.
 * @param {object} slot - from ncsSlots.
 * @param {{image?: boolean}} [opts] - `image: false` stops after the coding
 *   file is known (the hub reads each file's image once, see scanCoding).
 * @returns {Promise<{fns: object[], image: object|null, source: object,
 *   ci: number|null, cbd: string, file: string, entry: object|null,
 *   row: object|null, why: string}>}
 */
async function ncsReadSlot(chassis, slot, opts = {}) {
  const ch = String(chassis || '').toUpperCase();
  const scripts =
    typeof codingScriptIndex === 'function' ? await codingScriptIndex() : {};
  const fail = (why, extra = {}) => ({
    fns: [],
    image: null,
    source: { route: null, why },
    ci: null,
    cbd: '',
    file: '',
    why,
    ...extra,
  });
  const ownKey = scripts[slot.asw];
  if (!ownKey) return fail(`its coding script ${slot.asw} is not shipped`);

  const idx = await ncsCodingIndex(slot, ownKey);
  if (!idx.text) return fail(`no coding index: ${idx.why}`);
  const cbd = `C${idx.text}`;
  const ci = parseInt(idx.text, 16);

  // SGET: this slot with this CBD -> the coding file, SGBD and script
  const all = (typeof window !== 'undefined' && window.BMW_SGET) || {};
  const rows = ((all[ch] && (all[ch].rows || all[ch])) || []).filter(
    (r) =>
      String(r.UMRSG).toUpperCase() === slot.umrsg &&
      String(r.CBD).toUpperCase() === cbd &&
      r.SGBD &&
      r.CABD
  );
  // NCS: "Fehler CBD nicht in SGET vorhanden!"
  if (!rows.length)
    return fail(`${cbd} is not in the selection table for ${slot.umrsg}`, {
      ci,
      cbd,
    });
  const row = rows[0];
  const file = String(row.SGNAME).toUpperCase();
  const daten = await ncsDatenFile(ch);
  const entry = daten && daten.modules && daten.modules[file];
  if (!entry)
    return fail(`the coding file ${file} is not shipped for ${ch}`, {
      ci,
      cbd,
      file,
    });
  const sgbd = String(row.SGBD).toLowerCase();
  const fns = await moduleFunctions(ch, sgbd, ci, null, entry);
  const cabd = codingCabdOf(fns);
  if (!cabd)
    return fail(`${file}.${cbd} has no layout for index ${idx.text}`, {
      fns,
      ci,
      cbd,
      file,
    });
  const script = String(row.CABD).toUpperCase();
  const numbered =
    cabd.typ === 'BLOCK' ||
    cabd.fields.some((f) => f.block > 0) ||
    cabd.groups.some((g) => g.block > 0);
  const source = {
    route: 'script',
    sgbd,
    script,
    dispatchKey: scripts[script] || ownKey,
    cabd,
    decided: true,
    blocked: numbered,
    file,
    cbd,
  };
  let image = null;
  let why = '';
  if (opts.image !== false) {
    try {
      image = await codingReadImage(source, null);
    } catch (e) {
      why = String((e && e.message) || e);
    }
  }
  return { fns, image, source, ci, cbd, file, entry, row, why };
}

if (typeof window !== 'undefined') {
  window.ncsSlots = ncsSlots;
  window.ncsReadSlot = ncsReadSlot;
  window.ncsDatenFile = ncsDatenFile;
}
