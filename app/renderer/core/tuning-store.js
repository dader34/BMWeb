// tuning-store: keep the Tuning screen's working files across a reload.
//
// The ECU Firmware Editor holds two things the user had to go and find: a
// firmware BIN (116 KB - 1 MB) and a TunerPro .xdf (commonly 4-5 MB). Losing
// both to an accidental refresh -- along with any edits staged against them --
// is the kind of small betrayal that makes a tool feel untrustworthy.
//
// WHY INDEXEDDB. localStorage is a ~5 MB string store; one MS45.1 definition
// alone is 4.7 MB and would either blow the quota or crowd out everything else
// the app keeps there. IndexedDB stores the Uint8Array and the definition text
// natively, with a much larger budget, and it is the only web storage that can
// hold a binary of this size without base64 inflating it by a third.
//
// WHAT IS SAVED. The BIN as-edited, the pristine load-time snapshot (so the
// changed-byte view survives), the .xdf SOURCE TEXT, both file names, and a
// little view state. NOT the parsed definition: re-parsing 4.7 MB takes ~290 ms
// and the parse output is a large object graph that structured-clone would
// balloon. NOT the coverage map either -- it is derived, and rebuilding takes
// ~17 ms.
//
// EVERYTHING HERE IS BEST-EFFORT. Private browsing, a disabled-storage policy,
// or a quota refusal must never break the editor: every call resolves rather
// than rejects, and the screen works exactly as before if the store is dead.
// A tuning session that cannot be saved is still a usable tuning session.

(function (root) {
  'use strict';

  const DB_NAME = 'bmweb-tuning';
  const DB_VERSION = 1;
  const STORE = 'session';
  const KEY = 'current';

  // A save is worth doing only if it can complete quickly; a user hammering
  // edits should not queue megabytes of writes. saveSession coalesces via
  // scheduleSave() below.
  const SAVE_DEBOUNCE_MS = 700;

  function open() {
    return new Promise((resolve) => {
      let req;
      try {
        if (typeof indexedDB === 'undefined' || !indexedDB)
          return resolve(null);
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        return resolve(null); // policy-blocked storage
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
  }

  function tx(db, mode, fn) {
    return new Promise((resolve) => {
      let t;
      try {
        t = db.transaction(STORE, mode);
      } catch (e) {
        return resolve(null);
      }
      const store = t.objectStore(STORE);
      let out = null;
      try {
        out = fn(store);
      } catch (e) {
        /* fall through to oncomplete */
      }
      t.oncomplete = () =>
        resolve(out && out.result !== undefined ? out.result : out);
      t.onerror = () => resolve(null);
      t.onabort = () => resolve(null);
    });
  }

  // saveSession(state) -> Promise<boolean>
  //
  // `state` is the subset worth keeping. Uint8Arrays are stored directly --
  // structured clone handles them, and a copy is taken so a later in-place
  // edit cannot mutate what we are mid-way through writing.
  function packHistory(list) {
    if (!Array.isArray(list)) return [];
    return list.map((e) => ({
      label: e.label || '',
      writes: (e.writes || []).map((w) => ({
        address: w.address,
        before: w.before ? Uint8Array.from(w.before) : null,
        after: w.after ? Uint8Array.from(w.after) : null,
      })),
    }));
  }
  function unpackHistory(list) {
    return packHistory(list).filter((e) => e.writes.length);
  }

  async function saveSession(state) {
    const db = await open();
    if (!db) return false;
    const rec = {
      v: 1,
      savedAt: Date.now(),
      fileName: state.fileName || '',
      defName: state.defName || '',
      // slice() so an edit during the write cannot corrupt the stored copy
      bin: state.bin ? state.bin.slice() : null,
      orig: state.orig ? state.orig.slice() : null,
      defText: state.defText || null,
      // small view state: cheap to keep, and jarring to lose. NOT selectedId:
      // restoring it made the tree re-select an item on load, which painted a
      // hex highlight the user never asked for and that survived reloads.
      filter: state.filter || '',
      coverOn: state.coverOn !== false,
      kinds: state.kinds ? [...state.kinds] : null,
      openCats: state.openCats ? [...state.openCats] : null,
      // the table editor dialog that was open, by item key
      openTable: state.openTable || null,
      // the edit trail: byte-level undo/redo entries, copied so a later edit
      // cannot alias the stored bytes
      history: packHistory(state.history),
      redo: packHistory(state.redo),
    };
    const ok = await tx(db, 'readwrite', (s) => s.put(rec, KEY));
    try {
      db.close();
    } catch (e) {
      /* already closing */
    }
    return ok !== null;
  }

  // loadSession() -> Promise<record|null>
  async function loadSession() {
    const db = await open();
    if (!db) return null;
    const rec = await new Promise((resolve) => {
      let t;
      try {
        t = db.transaction(STORE, 'readonly');
      } catch (e) {
        return resolve(null);
      }
      const req = t.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
    try {
      db.close();
    } catch (e) {
      /* already closing */
    }
    if (!rec || rec.v !== 1) return null;
    // Re-wrap: structured clone gives back plain typed arrays, but a stored
    // ArrayBuffer (older shapes, other browsers) needs coercing.
    if (rec.bin && !(rec.bin instanceof Uint8Array))
      rec.bin = new Uint8Array(rec.bin);
    if (rec.orig && !(rec.orig instanceof Uint8Array))
      rec.orig = new Uint8Array(rec.orig);
    rec.history = unpackHistory(rec.history);
    rec.redo = unpackHistory(rec.redo);
    return rec;
  }

  async function clearSession() {
    const db = await open();
    if (!db) return false;
    const ok = await tx(db, 'readwrite', (s) => s.delete(KEY));
    try {
      db.close();
    } catch (e) {
      /* already closing */
    }
    return ok !== null;
  }

  // Debounced save: edits arrive in bursts (typing a value, applying a patch)
  // and each one would otherwise write the whole image again.
  let timer = null;
  let pending = null;
  function scheduleSave(getState) {
    pending = getState;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const fn = pending;
      pending = null;
      if (typeof fn === 'function') {
        try {
          saveSession(fn());
        } catch (e) {
          /* best-effort */
        }
      }
    }, SAVE_DEBOUNCE_MS);
  }

  // Force any pending save out now (used on pagehide, where a timer will not
  // survive). Returns a promise, but callers on pagehide cannot await it --
  // IndexedDB writes started before unload generally still land.
  function flushSave(getState) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const fn = pending || getState;
    pending = null;
    if (typeof fn !== 'function') return Promise.resolve(false);
    try {
      return saveSession(fn());
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  const api = {
    saveSession,
    loadSession,
    clearSession,
    scheduleSave,
    flushSave,
  };
  root.TuningStore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
