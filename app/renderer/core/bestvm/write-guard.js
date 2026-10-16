/**
 * @file The write classifier: is a job a WRITE (it changes the ECU) or a
 * READ (it queries it)? This is the decision the VM's write guard rests on
 * (machine.js `run` and the transmit check in executor.js), and the UI's
 * per-screen confirmation prompts read it too.
 *
 * BEST2 gives us no flag -- the bytecode builds the telegram dynamically, so
 * the service byte isn't statically knowable.
 *
 * The systematic signal is still the SGBD authors' NAMING CONTRACT, applied
 * correctly rather than by leading verb, over a corpus of 27k jobs:
 *   1. A STRONG READ TOKEN anywhere (LESEN/READ/STATUS/IDENT/ABFRAGE/ANZEIGE/
 *      ZUSTAND/ANZAHL) means read -- so ABGLEICH_LESEN_HFM ("read the calibr-
 *      ation") is a read despite the write-ish ABGLEICH_ prefix. Read wins.
 *   2. Otherwise a WRITE TOKEN (STEUERN/SCHREIB/SETZEN/LOESCH/FLASH/START/STOP/
 *      RESET/CODIER/ABGLEICH/ADAPTION/AUTHENTIS/SET/...) means write.
 *   3. Otherwise INFO means read. INFO is a WEAK read token, checked AFTER the
 *      write tokens: unlike the strong ones it can prefix a write verb
 *      (INFO_SCHREIBEN), and it is matched after `_` too, so *_INFO jobs
 *      (CBS_INFO, MODUL_INFO) read as reads.
 *   4. Otherwise DEFAULT-DENY: an unrecognised job is treated as a write, so a
 *      new or oddly-named job is guarded, never silently run.
 * START/STOP match after `_` too ((?:\b|_)), so STEUERN_ROE_STOP-style names
 * are writes, and a SYSTEMCHECK_STOP_INFO hits the write tier before INFO.
 * Relaxing a WRITE token is the safe direction. This is the ONE classifier.
 */

/**
 * Strong read tokens: any one of these anywhere in a job name makes it a
 * read, whatever else the name says.
 * @type {RegExp}
 */
const READ_TOKEN = new RegExp(
  '(LESEN|_LES\\b|\\bLES_|READ|STATUS|IDENT|ANZEIGE|ABFRAG' +
    '|ANZAHL|ZUSTAND|GET_)',
  'i'
);

/**
 * CONFIG names a read ONLY when nothing else in the name says otherwise. MS45
 * exposes ECU_CONFIG (83 12 F1 30 A8 01 -- a three-byte query for the
 * vehicle-equipment list) and ECU_CONFIG_RESET (9B 12 F1 30 A8 04 00 ... --
 * 27 bytes written back); they share service 0x30, so only the name separates
 * them. This is checked BEFORE the write token but requires the write token to
 * be absent, so read-wins ordering is preserved for everything else --
 * CODIERUNG_LESEN stays a read because READ_TOKEN still runs first.
 * @type {RegExp}
 */
const CONFIG_READ_TOKEN = new RegExp('CONFIG', 'i');

/**
 * Write tokens: a named write verb anywhere in the name, once no strong read
 * token has claimed it.
 * @type {RegExp}
 */
const WRITE_TOKEN = new RegExp(
  '(SCHREIB|STEUERN|_SETZEN|SETZEN|LOESCH|FLASH|PROGRAMMIER|(?:\\b|_)START' +
    '|(?:\\b|_)STOP|RESET|CODIER|WRITE|\\bSET\\b|DOWNLOAD|UPLOAD|ABGLEICH' +
    '|ADAPTION|SLEEP|WAKEUP|POWER_?DOWN|AUTHENTIS|INITIALISIER|EINSTELL' +
    '|AKTIVIER|DEAKTIVIER|TILGUNG|ANLERN|TEACH|CLEAR)',
  'i'
);

/**
 * The weak read token, consulted only after the write tokens (rule 3 above).
 * @type {RegExp}
 */
const INFO_READ_TOKEN = new RegExp('(?:\\b|_)INFO', 'i');

/**
 * Classify a job by name: true when it must be treated as a write (rules 2
 * and 4 above), false when the name says it only reads (rules 1 and 3).
 * @param {string} name - The SGBD job name, any case.
 * @returns {boolean} True for a write (or an unrecognised name), false for a read.
 */
function isWriteJob(name) {
  const n = String(name || '');
  if (READ_TOKEN.test(n)) return false; // a read of anything is a read
  // a *_CONFIG read, but only when no write verb rides along (_RESET etc.)
  if (CONFIG_READ_TOKEN.test(n) && !WRITE_TOKEN.test(n)) return false;
  if (WRITE_TOKEN.test(n)) return true; // a named write verb
  if (INFO_READ_TOKEN.test(n)) return false; // *_INFO read, AFTER write check
  return true; // default-deny: unknown => guarded
}

// Under node the pieces are separate modules; the browser gives them one
// shared script scope. index.js assembles the public surface from these.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    isWriteJob,
    READ_TOKEN,
    CONFIG_READ_TOKEN,
    WRITE_TOKEN,
    INFO_READ_TOKEN,
  };
}
