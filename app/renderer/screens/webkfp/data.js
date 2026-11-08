// What WebKFP programs with: the scripts, SGBDs and COAPI texts that ship in
// data/kfp, and the SP-Daten fetched loose from bmw-files on Hugging Face
// (tools/export/kfp_spdaten.py) -- the index, a module's ZB table, the program
// and data files -- or read from an imported folder. The screen is
// screens/webkfp/screen.js.

/* exported WKFP_ERR_FLASH, wkfpHasData, wkfpScript, WKFP_JOB_PASSES, wkfpSpdIndex, wkfpRemoteFile, wkfpFamilies, wkfpCoapi, wkfpModuleFiles, wkfpText */

/** WinKFP's own error for a programming that failed. */
const WKFP_ERR_FLASH = { code: 211, text: 'Error on flash programming!' };
/** The script and SGBD loads, once per module. @type {Map<string, Promise<object>>} */
const wkfpScripts = new Map();
/** The COAPI error texts, loaded once. @type {Promise<Record<string, string>>|null} */
let wkfpCoapiTexts = null;
/**
 * Whether this build carries the engine and the programming scripts.
 * @returns {Promise<boolean>}
 */
async function wkfpHasData() {
  if (typeof kfp === 'undefined' || typeof kfpDaten === 'undefined')
    return false;
  try {
    const r = await fetch('data/kfp/families.json', { method: 'HEAD' });
    return !!(r && r.ok);
  } catch (e) {
    return false;
  }
}
/**
 * A module's programming script, with its SGBD handed to the job runner.
 * @param {KfpModule} mod - The module.
 * @returns {Promise<object>} The script.
 * @throws {Error} When the build does not carry it.
 */
function wkfpScript(mod) {
  // expert mode may pair any PABD with any P-SGBD
  const key = `${mod.pabd}|${mod.sgbd}`;
  if (!wkfpScripts.has(key)) {
    const p = (async () => {
      const [exec, code, tables] = await Promise.all([
        webFetchJson(`data/kfp/${mod.pabd}.json`),
        webFetchGz(`data/kfp/${mod.sgbd}.job-code.json.gz`),
        webFetchGz(`data/kfp/${mod.sgbd}.tables.json.gz`),
      ]);
      const missing = [
        !exec && `data/kfp/${mod.pabd}.json (${mod.pabd.toUpperCase()}.IPO)`,
        !code &&
          `data/kfp/${mod.sgbd}.job-code.json.gz (${mod.sgbd.toUpperCase()}.PRG)`,
      ].filter(Boolean);
      if (missing.length)
        throw new Error(`could not load ${missing.join(' or ')}`);
      webProvideJobCode(mod.sgbd, code, tables || {});
      return exec;
    })();
    // a failed load is tried again next time
    p.catch(() => wkfpScripts.delete(key));
    wkfpScripts.set(key, p);
  }
  return wkfpScripts.get(key);
}
/**
 * Where the SP-Daten are online: the module folders, loose, on each
 * bmw-files mirror. Tried in order; a mirror that is behind 404s.
 * @type {string[]}
 */
const WKFP_SPD_MIRRORS = hfFolderMirrors(HF_FILES_MIRRORS, 'sp-daten/');
/**
 * How many exchanges one of a flash's jobs may take. A flash SGBD polls a
 * module that answers BUSY for as long as it says so (MDS43's
 * FLASH_SCHREIBEN_ENDE while the DME checks the new program: no counter in
 * the SGBD); the job runner's own limit (64) is far below that. 2048 is
 * about 3.5 minutes of polling at DS2's pace.
 */
const WKFP_JOB_PASSES = 2048;
/** Where fetched SP-Daten files are kept between visits. */
const WKFP_SPD_CACHE = 'bmweb-webkfp-spdaten-v1';
/** The online index, loaded once. @type {Promise<object|null>|null} */
let wkfpSpdIndexP = null;
/**
 * One SP-Daten file from the first mirror that has it.
 * @param {string} rel - Its path under sp-daten/ (E46/GD20/GD20.DAT).
 * @returns {Promise<ArrayBuffer>}
 * @throws {Error} When no mirror answered.
 */
async function wkfpSpdFetch(rel) {
  // A module's files never change under their name, so each is fetched
  // once and kept (Cache API); the index is always asked for fresh, so a
  // new upload shows. Storage that is refused or full only costs a fetch.
  const keep = rel !== 'index.json';
  const key = WKFP_SPD_MIRRORS[0] + rel;
  let cache = null;
  if (keep && typeof caches !== 'undefined') {
    try {
      cache = await caches.open(WKFP_SPD_CACHE);
      const hit = await cache.match(key);
      if (hit) return await hit.arrayBuffer();
    } catch (e) {
      cache = null;
    }
  }
  // plain CDN files: past the shim that answers /api from the ECU archives
  const real = typeof webRealFetch === 'function' ? webRealFetch : fetch;
  for (const base of WKFP_SPD_MIRRORS) {
    try {
      const r = await real(base + rel);
      if (!r || !r.ok) continue;
      const buf = await r.arrayBuffer();
      if (cache) cache.put(key, new Response(buf.slice(0))).catch(() => {});
      return buf;
    } catch (e) {
      /* the next mirror */
    }
  }
  throw new Error(`${rel} could not be fetched from Hugging Face`);
}
/**
 * The online index: per module folder, per chassis, its files and sizes.
 * @returns {Promise<{modules: Record<string, Record<string, {path: string,
 *   table: string, files: Record<string, number>}>>}|null>} null offline.
 */
function wkfpSpdIndex() {
  if (!wkfpSpdIndexP) {
    wkfpSpdIndexP = wkfpSpdFetch('index.json')
      .then((b) => JSON.parse(new TextDecoder().decode(b)))
      .catch(() => null);
    // offline now is not offline forever: ask again next time
    wkfpSpdIndexP.then((i) => {
      if (!i) wkfpSpdIndexP = null;
    });
  }
  return wkfpSpdIndexP;
}
/**
 * An online file that reads like a picked File, fetched on first read only.
 * @param {string} rel - Its path under sp-daten/.
 * @param {string} name - Its name.
 * @param {number} size - Its size, from the index.
 * @returns {{name: string, size: number, remote: true,
 *   arrayBuffer: () => Promise<ArrayBuffer>}}
 */
function wkfpRemoteFile(rel, name, size) {
  let p = null;
  return {
    name,
    size,
    remote: true,
    arrayBuffer() {
      if (!p) {
        p = wkfpSpdFetch(rel);
        p.catch(() => (p = null));
      }
      return p;
    },
  };
}
/** The family list, loaded once. @type {Promise<KfpModule[]>|null} */
let wkfpFamiliesP = null;
/**
 * Every family this build carries a script for (data/kfp/families.json:
 * KFCONF10.DA2's families whose folder the SP-Daten have), in its order.
 * @returns {Promise<KfpModule[]>}
 */
function wkfpFamilies() {
  if (!wkfpFamiliesP) {
    wkfpFamiliesP = webFetchJson('data/kfp/families.json').then((list) =>
      Array.isArray(list) && list.length
        ? list.map(kfp.moduleOf)
        : Object.values(kfp.MODULES)
    );
  }
  return wkfpFamiliesP;
}
/** @returns {Promise<Record<string, string>>} COAPI error number -> text. */
function wkfpCoapi() {
  if (!wkfpCoapiTexts)
    wkfpCoapiTexts = webFetchJson('data/kfp/coapierr.json').then(
      (t) => t || {}
    );
  return wkfpCoapiTexts;
}
/**
 * A module's files among those imported: the folder may be the SP-Daten tree
 * (data/GD20/...), the chassis folder, or the module's own folder. The
 * module's folder is the one holding its ZB table.
 * @param {KfpModule} mod - The module.
 * @param {File[]} picked - The imported files.
 * @returns {{table: File, files: Map<string, File>}|null} The table and the
 *   folder's files by name, or null when no ZB table is among them.
 */
function wkfpModuleFiles(mod, picked) {
  const rel = (f) => (f.webkitRelativePath || f.name).replace(/\\/g, '/');
  const table = picked.find((f) => {
    const parts = rel(f).split('/');
    if (parts.pop().toUpperCase() !== mod.table.toUpperCase()) return false;
    // inside the module's folder, or the folder itself was picked
    const dir = parts.length ? parts[parts.length - 1].toUpperCase() : '';
    return dir === mod.folder.toUpperCase() || parts.length <= 1;
  });
  if (!table) return null;
  const dir = rel(table).split('/').slice(0, -1).join('/');
  const files = new Map();
  for (const f of picked) {
    const parts = rel(f).split('/');
    const name = parts.pop();
    if (parts.join('/') === dir) files.set(name, f);
  }
  return { table, files };
}
/** @param {File} f @returns {Promise<string>} its text, as WinKFP reads it (latin-1). */
async function wkfpText(f) {
  return new TextDecoder('latin1').decode(await f.arrayBuffer());
}
