// What WebKFP programs with: the scripts, SGBDs and COAPI texts that ship in
// data/kfp, and the SP-Daten -- the index, a module's ZB table, the program
// and data files -- read from the build's own data/sp-daten when it carries
// them, else from bmw-files on Hugging Face (loose: tools/export/
// kfp_spdaten.py; packed: kfp_spdaten_pack.py), or from an imported folder. The screen is
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
 * Where the SP-Daten are, as the layouts they come in, in the order they
 * are tried:
 *
 *   the copy an offline build carries beside the app (data/sp-daten/)
 *   the PACKED set on each bmw-files mirror (sp-daten-packed/)
 *   the loose files on each mirror (sp-daten/)
 *
 * THE LOCAL COPY IS FIRST, as for every other dataset (hfUrls): a build that
 * has the files must not reach for the network. Whichever layout answers
 * for the index is the one every other file is then read from, because a
 * file's place is only meaningful beside the index that names it; within a
 * layout a mirror that is behind 404s and the next is tried.
 * @type {string[][]}
 */
const WKFP_SPD_LAYOUTS = [
  [
    `${typeof WEB_BASE === 'string' ? WEB_BASE : ''}/data/sp-daten/`.replace(
      /([^:])\/\//g,
      '$1/'
    ),
  ],
  hfFolderMirrors(HF_FILES_MIRRORS, 'sp-daten-packed/'),
  hfFolderMirrors(HF_FILES_MIRRORS, 'sp-daten/'),
];
/** The layout the index came from. @type {string[]|null} */
let wkfpSpdLayout = null;
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
 * Where each file is when the SP-Daten are PACKED (index version 2,
 * tools/export/kfp_spdaten_pack.py): its path under sp-daten/ -> the pack
 * that holds it and its place there. Empty for the loose layout.
 * @type {Map<string, {pack: string, place: number}>}
 */
const wkfpSpdPlaces = new Map();
/**
 * The pack read last, opened: a flash reads two or three files of one module.
 * @type {{name: string, pack: Promise<{read: (place: number) =>
 *   {name: string, bytes: Uint8Array}}>}|null}
 */
let wkfpSpdPackHeld = null;
/**
 * One file from the first of some layouts' sources that has it.
 * @param {string} rel - Its path under the layout's folder.
 * @param {string[][]} layouts - The layouts to try, in order.
 * @returns {Promise<{buf: ArrayBuffer, layout: string[]}|null>} null when
 *   none answered.
 */
async function wkfpSpdGet(rel, layouts) {
  // plain files: past the shim that answers /api from the ECU archives
  const real = typeof webRealFetch === 'function' ? webRealFetch : fetch;
  for (const layout of layouts) {
    for (const base of layout) {
      try {
        const r = await real(base + rel);
        if (r && r.ok) return { buf: await r.arrayBuffer(), layout };
      } catch (e) {
        /* the next source */
      }
    }
  }
  return null;
}
/**
 * One file as it is stored, from the first source that has it.
 * @param {string} rel - Its path under sp-daten/ (E46/GD20/GD20.DAT, or
 *   packs/GD20.0.spk).
 * @returns {Promise<ArrayBuffer>}
 * @throws {Error} When no source answered.
 */
async function wkfpSpdRaw(rel) {
  const isIndex = rel === 'index.json';
  if (!isIndex && !wkfpSpdLayout) await wkfpSpdIndex();
  // A module's files never change under their name, so each is fetched
  // once and kept (Cache API); the index is always asked for fresh, so a
  // new upload shows. Storage that is refused or full only costs a fetch.
  // A pack is NOT kept there: a build that carries the packs reads them
  // from beside itself, and the hosted site would be storing every version
  // of a module to flash one.
  const keep = !isIndex && !rel.startsWith('packs/');
  const key = WKFP_SPD_LAYOUTS[2][0] + rel;
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
  // Where to look. The index: every layout, and the one that answers is
  // remembered. A pack: only beside the index that names it. A loose file:
  // beside the index when that layout holds loose files, and always the
  // loose set online -- a build that carries packs lists the families it
  // left out from there (wkfpSpdIndex), and their files are loose.
  const loose = WKFP_SPD_LAYOUTS[2];
  let layouts;
  if (isIndex) layouts = WKFP_SPD_LAYOUTS;
  else if (rel.startsWith('packs/'))
    layouts = wkfpSpdLayout ? [wkfpSpdLayout] : [];
  else
    layouts =
      wkfpSpdLayout &&
      wkfpSpdLayout !== loose &&
      wkfpSpdLayout !== WKFP_SPD_LAYOUTS[1]
        ? [wkfpSpdLayout, loose]
        : [loose];
  const got = await wkfpSpdGet(rel, layouts);
  if (got) {
    if (isIndex) wkfpSpdLayout = got.layout;
    if (cache) cache.put(key, new Response(got.buf.slice(0))).catch(() => {});
    return got.buf;
  }
  throw new Error(
    `${rel} is not in this build and could not be fetched from Hugging Face`
  );
}
/**
 * One SP-Daten file, exactly as BMW shipped it: taken out of its pack when
 * the SP-Daten are packed, fetched loose otherwise.
 * @param {string} rel - Its path under sp-daten/ (E46/GD20/GD20.DAT).
 * @returns {Promise<ArrayBuffer>}
 * @throws {Error} When no source answered, or the file does not check
 *   against what was packed.
 */
async function wkfpSpdFetch(rel) {
  if (rel !== 'index.json' && !wkfpSpdPlaces.size) await wkfpSpdIndex();
  const where = wkfpSpdPlaces.get(rel);
  if (!where) return wkfpSpdRaw(rel);
  if (!wkfpSpdPackHeld || wkfpSpdPackHeld.name !== where.pack) {
    const name = where.pack;
    const pack = wkfpSpdRaw(`packs/${name}`).then((b) => {
      if (typeof fzstd === 'undefined')
        throw new Error(
          'The zstd library (vendor/fzstd) is not loaded in this build.'
        );
      return kfpDaten.openPack(new Uint8Array(b), fzstd.decompress);
    });
    wkfpSpdPackHeld = { name, pack };
    pack.catch(() => {
      if (wkfpSpdPackHeld && wkfpSpdPackHeld.name === name)
        wkfpSpdPackHeld = null;
    });
  }
  // read checks the file's length and CRC-32 and throws rather than return
  // one that differs from what was packed
  const file = (await wkfpSpdPackHeld.pack).read(where.place);
  return file.bytes.buffer;
}
/**
 * The index: per module folder, per chassis, its files and sizes (and, when
 * packed, where each file is).
 * @returns {Promise<{modules: Record<string, Record<string, {path: string,
 *   table: string, files: Record<string, number>}>>}|null>} null offline.
 */
function wkfpSpdIndex() {
  if (!wkfpSpdIndexP) {
    wkfpSpdIndexP = wkfpSpdRaw('index.json')
      .then(async (b) => {
        const index = JSON.parse(new TextDecoder().decode(b));
        wkfpSpdPlaces.clear();
        if (Array.isArray(index.packs))
          for (const byChassis of Object.values(index.modules || {}))
            for (const entry of Object.values(byChassis))
              for (const [name, at] of Object.entries(entry.at || {}))
                wkfpSpdPlaces.set(entry.path + name, {
                  pack: index.packs[at[0]],
                  place: at[1],
                });
        // A PACKED set leaves families out (the head-unit images do not
        // pack, and an offline build may trim further). They are still
        // there loose, online: add what the loose index has and this one
        // lacks. Offline this finds nothing and the build offers what it
        // holds. This holds for the hosted site reading the packed set too,
        // not only for a build that carries packs.
        if (Array.isArray(index.packs) && (index.leftOut || []).length) {
          const more = await wkfpSpdGet('index.json', [WKFP_SPD_LAYOUTS[2]]);
          if (more) {
            try {
              const online = JSON.parse(new TextDecoder().decode(more.buf));
              for (const [family, byChassis] of Object.entries(
                online.modules || {}
              )) {
                if (!index.leftOut.includes(family)) continue;
                index.modules[family] = index.modules[family] || {};
                for (const [chassis, entry] of Object.entries(byChassis))
                  if (!index.modules[family][chassis])
                    index.modules[family][chassis] = entry;
              }
            } catch (e) {
              /* the build's own index stands */
            }
          }
        }
        return index;
      })
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
