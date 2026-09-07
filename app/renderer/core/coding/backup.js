/**
 * @file The pre-write coding backup store. Published as the `CodingBackup`
 * global, with `saveCodingBackup` / `listCodingBackups` also on the root.
 *
 * The bytes an ECU held before we wrote are the ONLY way back from a bad
 * write, and they exist for exactly one moment: after the read, before the
 * transmit. Persist them there or they are gone. Kept deliberately dumb --
 * append-only, newest first, capped -- because the one job it has is to
 * still be there after a write goes wrong.
 */

/**
 * One stored backup.
 * @typedef {Object} BackupRecord
 * @property {string} sgbd - the module.
 * @property {string} netto - the netto as uppercase hex.
 * @property {string} at - ISO timestamp.
 * @property {string|null} chassis - chassis id, when known.
 * @property {number|null} ci - coding index, when known.
 * @property {string|null} note - free text ("pre-write (coding)").
 */

(function (root) {
  'use strict';

  /** localStorage key of the backup list. */
  const BACKUP_KEY = 'bmweb.coding.backups';
  /** Most backups kept; older ones fall off the end. */
  const BACKUP_MAX = 50;

  /**
   * The storage backend, or null when unavailable (private mode, disabled).
   * @returns {Storage|null} localStorage or null.
   */
  function backupStore() {
    try {
      if (typeof localStorage !== 'undefined') return localStorage;
    } catch (e) {
      /* private mode / disabled: fall through */
    }
    return null;
  }

  /**
   * Persist a module's current netto before a write. NEVER throws: a backup
   * failure must not abort a write the user already confirmed, so it returns
   * null and the caller decides. The caller is what surfaces "unbacked" to
   * the user.
   * @param {string} sgbd - the module.
   * @param {string} nettoHex - the netto as read (separators ignored).
   * @param {{now?: Date, chassis?: string|null, ci?: number|null, note?: string|null}} [meta]
   *   - timestamp override and provenance.
   * @returns {BackupRecord|null} the stored record, or null when there is no
   *   storage, no netto, or the store refused.
   */
  function saveCodingBackup(sgbd, nettoHex, meta = {}) {
    const store = backupStore();
    if (!store) return null;
    /** @type {BackupRecord} */
    const rec = {
      sgbd: String(sgbd),
      netto: String(nettoHex || '')
        .replace(/[^0-9a-fA-F]/g, '')
        .toUpperCase(),
      at: (meta.now instanceof Date ? meta.now : new Date()).toISOString(),
      chassis: meta.chassis || null,
      ci: meta.ci == null ? null : meta.ci,
      note: meta.note || null,
    };
    if (!rec.netto) return null;
    try {
      const prev = JSON.parse(store.getItem(BACKUP_KEY) || '[]');
      const list = Array.isArray(prev) ? prev : [];
      list.unshift(rec);
      store.setItem(BACKUP_KEY, JSON.stringify(list.slice(0, BACKUP_MAX)));
      return rec;
    } catch (e) {
      return null; // quota, serialisation, whatever: never block the write
    }
  }

  /**
   * Every stored backup, newest first.
   * @param {string} [sgbd] - only this module's backups, when given.
   * @returns {BackupRecord[]} the backups (empty when storage is missing).
   */
  function listCodingBackups(sgbd) {
    const store = backupStore();
    if (!store) return [];
    try {
      const list = JSON.parse(store.getItem(BACKUP_KEY) || '[]');
      if (!Array.isArray(list)) return [];
      return sgbd
        ? list.filter((r) => r && String(r.sgbd) === String(sgbd))
        : list;
    } catch (e) {
      return [];
    }
  }

  const api = { saveCodingBackup, listCodingBackups };
  if (typeof root !== 'undefined') {
    root.saveCodingBackup = saveCodingBackup;
    root.listCodingBackups = listCodingBackups;
    root.CodingBackup = api;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
