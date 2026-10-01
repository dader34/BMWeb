/**
 * @file The flashing app's session log and history, kept in this browser.
 *
 * A session is one logical operation (a flash, a write, a read). While it
 * runs every job the engines execute, every note and every status line goes
 * to its log; when it ends the session is recorded -- when it began, what it
 * was, how it ended, the full log text and copies of the images written (when
 * that setting is on) -- in IndexedDB, which the History screen lists and the
 * Settings screen can clear. Nothing leaves the machine.
 *
 * Everything here is best-effort: a browser whose storage is blocked still
 * flashes; it just keeps no history.
 */
/* exported flashLog, flashHistory */

const FLASH_DB_NAME = 'bmweb-flashing';
const FLASH_DB_VERSION = 1;
const FLASH_STORE = 'sessions';

/**
 * Open (and on first use create) the history database.
 * @returns {Promise<IDBDatabase|null>}
 */
function _flashDb() {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(FLASH_DB_NAME, FLASH_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(FLASH_STORE)) {
          db.createObjectStore(FLASH_STORE, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch (e) {
      resolve(null);
    }
  });
}

function _flashStamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}  `;
}

function _flashHex(bytes, max = 64) {
  const n = Math.min(bytes.length, max);
  let s = Array.from(bytes.subarray ? bytes.subarray(0, n) : bytes.slice(0, n), (b) =>
    (b & 0xff).toString(16).toUpperCase().padStart(2, '0')
  ).join(' ');
  if (bytes.length > max) s += ` ... (${bytes.length} bytes)`;
  return s;
}

/** The running session, or null. */
let _flashSession = null;

/**
 * The session log: every flash path reports how it goes through here, so the
 * history needs no call of its own at each of them.
 */
const flashLog = {
  /** Whether a session is logging. @returns {boolean} */
  get isActive() {
    return !!_flashSession;
  },
  /**
   * Begin a session. A session already running is ended first.
   * @param {string} operation - e.g. flash-program, tcu-cal-write.
   * @param {{vin?: string, module?: string}} [car] - The car at the time.
   * @returns {Promise<void>}
   */
  async start(operation, car = {}) {
    if (_flashSession) await flashLog.stop();
    _flashSession = {
      started: new Date(),
      operation,
      vin: car.vin || '',
      module: car.module || '',
      firstNote: null,
      lastStatus: null,
      result: 'ended',
      lines: [
        '# BMWeb Flashing/Backups log',
        `# operation: ${operation}`,
        `# started:   ${new Date().toISOString()}`,
        '',
      ],
      files: [],
    };
  },
  /**
   * Free-text note (a phase marker, an error, a decision).
   * @param {string} text - The note.
   */
  note(text) {
    if (!_flashSession || !text) return;
    if (_flashSession.firstNote == null) _flashSession.firstNote = text;
    _flashSession.lines.push(_flashStamp() + text);
  },
  /**
   * The status line the app shows, kept as the session's outcome.
   * @param {string} text - The status.
   */
  status(text) {
    if (!_flashSession || !text || text.startsWith('Logging to ')) return;
    _flashSession.lastStatus = text;
    const judged = flashHistory.judge(text);
    if (judged === 'failed') _flashSession.result = 'failed';
    else if (judged === 'ok' && _flashSession.result !== 'failed') _flashSession.result = 'ok';
  },
  /**
   * One job entry: name, arg summary, status, and the request/response telegrams.
   * @param {string} name - The job.
   * @param {string} argSummary - Its argument.
   * @param {string} status - Its JOB_STATUS.
   * @param {Uint8Array|null} request - _TEL_AUFTRAG.
   * @param {Uint8Array|null} response - _TEL_ANTWORT.
   */
  job(name, argSummary, status, request, response) {
    if (!_flashSession) return;
    _flashSession.lines.push(`${_flashStamp()}${name}${argSummary ? ` [${argSummary}]` : ''} -> ${status || '(no status)'}`);
    if (request && request.length) _flashSession.lines.push(`    tx: ${_flashHex(request)}`);
    if (response && response.length) _flashSession.lines.push(`    rx: ${_flashHex(response)}`);
  },
  /**
   * A raw-wire trace line (what Ds2Wire reports), kept verbatim.
   * @param {string} text - The line.
   */
  trace(text) {
    if (!_flashSession || !text) return;
    _flashSession.lines.push(_flashStamp() + text);
  },
  /**
   * Keep a copy of an image the session is about to write, when the setting is on.
   * @param {string} name - A file name.
   * @param {Uint8Array} bytes - The image.
   */
  attach(name, bytes) {
    if (!_flashSession || !bytes) return;
    if (!Settings.get('flashKeepFiles', false)) return;
    _flashSession.files.push({ name, bytes: Uint8Array.from(bytes) });
    _flashSession.lines.push(`${_flashStamp()}copy of the image written kept: ${name} (${bytes.length} bytes)`);
  },
  /**
   * End the session and record it.
   * @returns {Promise<Object|null>} The history entry, or null when none ran.
   */
  async stop() {
    const s = _flashSession;
    if (!s) return null;
    _flashSession = null;
    s.lines.push('', `# ended: ${new Date().toISOString()}`);
    const entry = {
      started: s.started.getTime(),
      seconds: Math.round((Date.now() - s.started.getTime()) / 100) / 10,
      operation: s.operation,
      vin: s.vin,
      module: s.module,
      details: s.firstNote || '',
      status: s.lastStatus || '',
      result: s.result,
      log: s.lines.join('\n'),
      files: s.files,
    };
    await flashHistory._append(entry);
    return entry;
  },
};

/**
 * What was done to which car, newest first.
 */
const flashHistory = {
  /** Fires after an entry is appended or the history is cleared. @type {(() => void)[]} */
  _listeners: [],
  /**
   * @param {() => void} fn - Called on every change.
   */
  onChange(fn) {
    flashHistory._listeners.push(fn);
  },
  _notify() {
    for (const fn of flashHistory._listeners) {
      try {
        fn();
      } catch (e) {
        /* a listener's problem */
      }
    }
  },
  async _append(entry) {
    const db = await _flashDb();
    if (db) {
      await new Promise((resolve) => {
        try {
          const tx = db.transaction(FLASH_STORE, 'readwrite');
          tx.objectStore(FLASH_STORE).add(entry);
          tx.oncomplete = resolve;
          tx.onerror = resolve;
          tx.onabort = resolve;
        } catch (e) {
          resolve();
        }
      });
      db.close();
    }
    flashHistory._notify();
  },
  /**
   * Every entry, newest first, without the log text and files (those are
   * fetched per entry).
   * @returns {Promise<Object[]>}
   */
  async load() {
    const db = await _flashDb();
    if (!db) return [];
    const rows = await new Promise((resolve) => {
      try {
        const out = [];
        const req = db.transaction(FLASH_STORE, 'readonly').objectStore(FLASH_STORE).openCursor();
        req.onsuccess = () => {
          const c = req.result;
          if (!c) return resolve(out);
          const v = c.value;
          out.push({
            id: v.id,
            started: v.started,
            seconds: v.seconds,
            operation: v.operation,
            vin: v.vin,
            module: v.module,
            details: v.details,
            status: v.status,
            result: v.result,
            hasLog: !!v.log,
            fileCount: (v.files || []).length,
          });
          c.continue();
        };
        req.onerror = () => resolve(out);
      } catch (e) {
        resolve([]);
      }
    });
    db.close();
    rows.sort((a, b) => b.started - a.started);
    return rows;
  },
  /**
   * One entry in full: log text and kept files.
   * @param {number} id - The entry's id.
   * @returns {Promise<Object|null>}
   */
  async get(id) {
    const db = await _flashDb();
    if (!db) return null;
    const row = await new Promise((resolve) => {
      try {
        const req = db.transaction(FLASH_STORE, 'readonly').objectStore(FLASH_STORE).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
    db.close();
    return row;
  },
  /** Forget every session. @returns {Promise<void>} */
  async clear() {
    const db = await _flashDb();
    if (db) {
      await new Promise((resolve) => {
        try {
          const tx = db.transaction(FLASH_STORE, 'readwrite');
          tx.objectStore(FLASH_STORE).clear();
          tx.oncomplete = resolve;
          tx.onerror = resolve;
          tx.onabort = resolve;
        } catch (e) {
          resolve();
        }
      });
      db.close();
    }
    flashHistory._notify();
  },
  /**
   * A human name for a session's operation.
   * @param {string} operation - The operation.
   * @returns {string}
   */
  describe(operation) {
    switch (operation) {
      case 'flash-tune':
        return 'Flash tune';
      case 'flash-program':
        return 'Flash program';
      case 'verify-program':
        return 'Finish programming';
      case 'read-dme':
        return 'Read DME';
      case 'read-maps':
        return 'Read installed maps';
      case 'tcu-cal-write':
        return 'Write TCU calibration';
      case 'tcu-program-write':
        return 'Write TCU program';
      case 'tcu-cal-read':
        return 'Read TCU calibration';
      case 'tcu-full-read':
        return 'Read TCU';
      default:
        return operation || '';
    }
  },
  /**
   * ok / failed / ended, from the outcome a status line reports.
   * @param {string} status - A status line.
   * @returns {string}
   */
  judge(status) {
    if (!status) return 'ended';
    const s = status.toLowerCase();
    if (s.includes('fail') || s.includes('denied') || s.includes('cancel') || s.includes('no data') || s.includes('error') || s.includes('not match')) {
      return 'failed';
    }
    if (s.includes('success') || s.includes('written') || s.startsWith('read 0x') || s.startsWith('read tcu') || s.startsWith('saved')) return 'ok';
    return 'ended';
  },
};

if (typeof window !== 'undefined') {
  window.flashLog = flashLog;
  window.flashHistory = flashHistory;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { flashLog, flashHistory };
}
