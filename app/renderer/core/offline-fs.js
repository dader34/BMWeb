/**
 * @file OFFLINE FOLDER ACCESS (file:// only): the picked-folder data source.
 *
 * The release "offline" zips are the whole static site: every file the app
 * loads sits beside index.html. Served over HTTP that just works. But opened
 * by double-clicking index.html, the page runs on the file:// origin, where
 * the browser BLOCKS fetch() -- so every data read ("Failed to fetch") dies
 * and the app can't even list the cars.
 *
 * The fix is not to inline hundreds of MB into the page. It is to ask the
 * browser, once, for a handle to the folder the page lives in (the File
 * System Access API's showDirectoryPicker), then read the data files THROUGH
 * that handle instead of fetch(). Directory-handle reads are not subject to
 * the file:// fetch block. The transport shim (core/webshim/api-router.js)
 * routes its single `real` fetch here when a handle is active, so chassis,
 * ECU, groups, coding-dispatch, sgbd-tables, job-code and ISTA data all
 * resolve from the picked folder with no other change.
 *
 * The handle is remembered in IndexedDB, so after the first pick a reload
 * reconnects silently (or with one "restore access" click if the browser has
 * aged the permission out). None of this runs on http(s) or in the native
 * macOS app -- offlineFsActive() is false there and the shim never calls in.
 */

(function () {
  'use strict';

  /**
   * Only file:// needs this. http(s) fetch works; the native app has its own
   * file bridge.
   */
  const IS_FILE =
    typeof location !== 'undefined' && location.protocol === 'file:';
  /**
   * showDirectoryPicker exists only in the browsers that also have Web
   * Serial -- the SAME requirement the cable already imposes, so it adds no
   * new limit.
   */
  const HAS_API =
    typeof window !== 'undefined' &&
    typeof window.showDirectoryPicker === 'function';

  /** @type {FileSystemDirectoryHandle|null} the granted folder handle */
  let dirHandle = null;
  /** @type {Promise<boolean>|null} the one-shot init promise */
  let ready = null;

  /**
   * Does this page need (and can it use) the picked folder at all?
   * @returns {boolean} True on file:// in a browser with the picker API.
   */
  function offlineFsActive() {
    return IS_FILE && HAS_API;
  }

  /**
   * Is a folder handle in hand and usable?
   * @returns {boolean}
   */
  function offlineFsReady() {
    return !!dirHandle;
  }

  // ---- IndexedDB: remember the handle across sessions ----------------------
  // A FileSystemDirectoryHandle is structured-cloneable, so it stores directly.
  const DB = 'bmweb-offline';
  const STORE = 'fs';
  const KEY = 'root';
  const DB_VERSION = 1;

  /**
   * Run one IndexedDB request against the handle store.
   * @param {IDBTransactionMode} mode - 'readonly' or 'readwrite'.
   * @param {(store: IDBObjectStore) => IDBRequest} fn - Issues the request.
   * @returns {Promise<any>} The request's result once the transaction commits.
   */
  function idb(mode, fn) {
    return new Promise((resolve, reject) => {
      let req;
      try {
        req = indexedDB.open(DB, DB_VERSION);
      } catch (e) {
        reject(e);
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(STORE, mode);
        const st = tx.objectStore(STORE);
        const r = fn(st);
        tx.oncomplete = () => {
          db.close();
          resolve(r && r.result);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      };
    });
  }

  /**
   * Remember a folder handle (best effort).
   * @param {FileSystemDirectoryHandle} h - The handle to store.
   * @returns {Promise<void>}
   */
  const saveHandle = (h) =>
    idb('readwrite', (st) => st.put(h, KEY)).catch(() => {});
  /**
   * The remembered folder handle, or null.
   * @returns {Promise<FileSystemDirectoryHandle|null>}
   */
  const loadHandle = () =>
    idb('readonly', (st) => st.get(KEY)).catch(() => null);
  /**
   * Forget the remembered handle (best effort).
   * @returns {Promise<void>}
   */
  const clearHandle = () =>
    idb('readwrite', (st) => st.delete(KEY)).catch(() => {});

  // ---- permission ----------------------------------------------------------

  /**
   * Is the handle readable, asking the user when `prompt` is set?
   * @param {FileSystemDirectoryHandle|null} h - The handle to check.
   * @param {boolean} prompt - Whether requestPermission may be called (it
   *   needs a user gesture).
   * @returns {Promise<boolean>} True when read access is granted.
   */
  async function hasReadPerm(h, prompt) {
    if (!h || !h.queryPermission) return true; // older impls: assume usable
    const opts = { mode: 'read' };
    if ((await h.queryPermission(opts)) === 'granted') return true;
    if (!prompt) return false;
    return (await h.requestPermission(opts)) === 'granted';
  }

  // ---- is this the right folder? -------------------------------------------

  /**
   * Does the folder hold the app's own marker file (api/chassis.json)? If the
   * user points at the wrong directory we want to say so, not fail later with
   * a confusing missing-chassis error.
   * @param {FileSystemDirectoryHandle} h - The folder to check.
   * @returns {Promise<boolean>}
   */
  async function looksLikeAppFolder(h) {
    try {
      const api = await h.getDirectoryHandle('api');
      await api.getFileHandle('chassis.json');
      return true;
    } catch {
      return false;
    }
  }

  // ---- read one file by app-relative path ----------------------------------

  /**
   * A 404 Response, matching a real fetch of a missing file.
   * @returns {Response}
   */
  function notFound() {
    return new Response(null, { status: 404, statusText: 'Not Found' });
  }

  /**
   * Read one file from the picked folder by app-relative path, e.g.
   * "api/chassis/E46.chassis", "data/groups/e46.json.gz",
   * "data/ista/faulttests.json".
   *
   * Returns a REAL Response, not a hand-rolled stand-in: some callers read
   * .headers (ETK's readWithProgress reads content-length) and .body (stream
   * reader), so a partial shape crashes them. A Response built from the
   * file's bytes carries all of .ok/.status/.headers/.body/.arrayBuffer()/
   * .json()/.text(). A missing file is a 404 Response, matching a real fetch
   * -- webFetchGz/webFetchJson turn that into null and degrade the same way
   * they do online.
   * @param {string} path - The app-relative path (query/hash ignored).
   * @returns {Promise<Response>} The file's bytes, or a 404.
   */
  async function offlineReadFile(path) {
    if (!dirHandle) return notFound();
    const clean = String(path)
      .replace(/^\.?\//, '')
      .split('?')[0]
      .split('#')[0];
    if (!clean) return notFound();
    const parts = clean.split('/').filter(Boolean);
    const file = parts.pop();
    let dir = dirHandle;
    try {
      for (const seg of parts) dir = await dir.getDirectoryHandle(seg);
      const fh = await dir.getFileHandle(file);
      const f = await fh.getFile();
      const buf = await f.arrayBuffer();
      // carry the length so a progress reader can show a real percentage
      return new Response(buf, {
        status: 200,
        statusText: 'OK',
        headers: { 'Content-Length': String(buf.byteLength) },
      });
    } catch {
      return notFound();
    }
  }

  // ---- the pick overlay ----------------------------------------------------

  /** The overlay's inline styles: self-contained, it runs before app CSS is guaranteed. */
  const OVERLAY_STYLE = [
    'position:fixed',
    'inset:0',
    'z-index:99999',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'background:#0b0b0d',
    'color:#f2f2f4',
    'font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
  ].join(';');

  /** The app's roundel, inline so the overlay needs no asset. */
  const OVERLAY_LOGO =
    '<svg width="56" height="56" viewBox="0 0 100 100" role="img" aria-label="BMWeb">' +
    '<circle cx="50" cy="50" r="48" fill="#11161c" stroke="#9aa6b2" stroke-width="3"/>' +
    '<clipPath id="ofs-disc"><circle cx="50" cy="50" r="31"/></clipPath>' +
    '<g clip-path="url(#ofs-disc)">' +
    '<rect x="19" y="19" width="31" height="31" fill="#eef2f5"/>' +
    '<rect x="50" y="50" width="31" height="31" fill="#eef2f5"/>' +
    '<rect x="50" y="19" width="31" height="31" fill="#ff9e2c"/>' +
    '<rect x="19" y="50" width="31" height="31" fill="#ff9e2c"/>' +
    '</g>' +
    '<circle cx="50" cy="50" r="31" fill="none" stroke="#0a0d11" stroke-width="2"/>' +
    '</svg>';

  /**
   * The overlay's markup.
   * @param {boolean} restore - Wording for re-granting a remembered folder
   *   rather than a first pick.
   * @returns {string} Inner HTML.
   */
  function overlayHtml(restore) {
    return (
      '<div style="max-width:460px;padding:32px;text-align:center">' +
      '<div style="margin-bottom:14px">' +
      OVERLAY_LOGO +
      '</div>' +
      '<div style="font-size:20px;font-weight:600;margin-bottom:8px">' +
      (restore ? 'Restore folder access' : 'BMWeb offline') +
      '</div>' +
      '<div style="opacity:.75;margin-bottom:24px">' +
      (restore
        ? 'Click below and re-select this BMWeb folder so it can load car data.'
        : 'Select this BMWeb folder so the app can load its car data. ' +
          'Choose the folder that contains this page (it has an "api" folder inside).') +
      '</div>' +
      '<button id="offline-fs-pick" style="' +
      'appearance:none;border:0;border-radius:10px;padding:12px 22px;' +
      'font:600 15px/1 inherit;color:#0b0b0d;background:#4da3ff;cursor:pointer">' +
      'Select folder</button>' +
      '<div id="offline-fs-msg" style="min-height:20px;margin-top:16px;' +
      'font-size:13px;color:#ff8080"></div>' +
      '<div style="margin-top:20px;font-size:12px;opacity:.5">' +
      'Chrome or Edge. Or serve this folder over any local web server and ' +
      'open it there instead.</div>' +
      '</div>'
    );
  }

  /**
   * Show the full-screen pick overlay and resolve once a valid folder has
   * been chosen and saved. The picker itself needs a user gesture, so the
   * flow is always: show overlay -> user clicks -> showDirectoryPicker ->
   * validate -> save. A cancelled or rejected pick keeps the overlay up with
   * a message, so the promise only ever resolves true.
   * @param {{restore?: boolean}} [opts] - `restore` switches the wording.
   * @returns {Promise<boolean>} True once a folder is in hand.
   */
  function showPicker(opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const prev = document.getElementById('offline-fs-overlay');
      if (prev) prev.remove();
      const ov = document.createElement('div');
      ov.id = 'offline-fs-overlay';
      ov.setAttribute('style', OVERLAY_STYLE);
      ov.innerHTML = overlayHtml(!!opts.restore);
      document.body.appendChild(ov);
      const msg = ov.querySelector('#offline-fs-msg');
      const btn = ov.querySelector('#offline-fs-pick');
      btn.onclick = async () => {
        msg.textContent = '';
        let h;
        try {
          h = await window.showDirectoryPicker({
            id: 'bmweb-root',
            mode: 'read',
          });
        } catch (e) {
          if (e && e.name === 'AbortError') {
            msg.textContent = 'Cancelled. Click Select folder to try again.';
            return;
          }
          msg.textContent =
            e && e.message ? e.message : 'Could not open the folder picker.';
          return;
        }
        if (!(await hasReadPerm(h, true))) {
          msg.textContent = 'Read permission was not granted.';
          return;
        }
        if (!(await looksLikeAppFolder(h))) {
          msg.textContent =
            'That folder is not a BMWeb copy (no api/chassis.json). ' +
            'Pick the folder that holds index.html.';
          return;
        }
        dirHandle = h;
        await saveHandle(h);
        ov.remove();
        resolve(true);
      };
    });
  }

  // ---- init: restore or prompt --------------------------------------------

  /**
   * Restore the remembered folder, or ask for one. Idempotent and one-shot.
   * Called at boot on file://; a no-op elsewhere.
   * @returns {Promise<boolean>} True once a folder is usable; false where the
   *   offline folder does not apply.
   */
  async function initOfflineFs() {
    if (!offlineFsActive()) return false;
    if (ready) return ready;
    ready = (async () => {
      // try a remembered handle first
      let saved;
      try {
        saved = await loadHandle();
      } catch {
        saved = null;
      }
      if (saved) {
        // silent reconnect if the grant survives; else a one-click restore
        const granted = await hasReadPerm(saved, false);
        if (granted && (await looksLikeAppFolder(saved))) {
          dirHandle = saved;
          return true;
        }
        if (!granted) {
          // permission aged out but the handle is still valid -- offer restore
          // (requestPermission needs a gesture, so route through the overlay
          // in "restore" wording; its button can either re-grant the SAVED
          // handle or pick fresh)
          const okNow = await showPicker({ restore: true });
          if (okNow) return true;
        }
        // stale/invalid -- forget it and fall through to a fresh pick
        await clearHandle();
      }
      return showPicker({ restore: false });
    })();
    return ready;
  }

  window.offlineFsActive = offlineFsActive;
  window.offlineFsReady = offlineFsReady;
  window.offlineReadFile = offlineReadFile;
  window.initOfflineFs = initOfflineFs;
})();
