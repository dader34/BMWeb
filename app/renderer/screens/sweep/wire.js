/**
 * @file Whole-vehicle sweep: the wire helpers -- reading fault memory, the
 * detail read that enriches each entry, telling a missing job from a silent
 * bus, and the cancel token that stops a sweep when the user leaves.
 *
 * Third piece of screens/sweep/. fillFaultDetail and matchDetail are shared
 * with faults.js and the background scan.
 */

/**
 * One fault entry as FS_LESEN answers it (a data set), optionally enriched
 * by FS_LESEN_DETAIL. Only the fields the sweep and the fault views read
 * are named; the ECU returns whatever its SGBD declares.
 * @typedef {object} FaultEntry
 * @property {unknown} [F_HEX_CODE] - The raw fault word (byte array or
 *   dashed hex).
 * @property {string|number} [F_ORT_NR] - The fault location number.
 * @property {string} [F_ORT_TEXT] - The location text (German).
 * @property {string} [F_VORHANDEN_TEXT] - Present/stored status text.
 * @property {string} [F_SYMPTOM_TEXT] - Symptom text (DME modules).
 * @property {string} [F_PCODE_STRING] - SAE P-code, detail read only.
 * @property {string} [F_PCODE7_STRING] - Seven-character P-code variant.
 * @property {string|number} [F_HFK] - Occurrence counter.
 * @property {string|number} [F_LZ] - Logistic counter, fallback for F_HFK.
 * @property {string|number} [F_ART_ANZ] - Number of F_ARTn_TEXT entries.
 */

/**
 * The argument a module's fault read wants, or '' when it wants none.
 *
 * MOST MODULES DECLARE NO ARGUMENT AND A BARE FS_LESEN IS RIGHT. Some do not.
 * E46's light switch centre (lsz_2) stores faults in EIGHT blocks and declares
 * `FS_LESEN(ALL_BLOCKS)`; called bare it answers F_ZAHL 0 -- documented as
 * "Gesamtfehler der Bloecke 1 bis 3 (schwere Fehler)" -- so a real fault
 * sitting in block 5 reads as a clean module. On a real car a CURRENT
 * "Fernlicht rechts defekt" (3A21) was invisible exactly this way, in the
 * sweep, the fault screen and INPA's own whole-car script alike.
 *
 * A declared argument's NAME is the keyword to pass (ALL_BLOCKS is both). A
 * read wanting more than one argument is left bare: nothing here can invent
 * those values, and a half-filled argument list is worse than none.
 *
 * The arguments live on their own route. /api/ecu/<s>/jobs answers a plain
 * list of NAMES with no arguments on it, and a job declaring none 404s here,
 * so a failure means "no argument", not an error.
 * @param {string} sgbd - The SGBD.
 * @param {string} [job] - The fault read (FS_LESEN unless a caller differs).
 * @returns {Promise<string>} The argument to send, or ''.
 */
async function faultReadArg(sgbd, job) {
  const name = job || 'FS_LESEN';
  if (!_faultArg.has(sgbd)) {
    _faultArg.set(
      sgbd,
      api(`/api/ecu/${sgbd}/arguments/${name}`)
        .then((j) => {
          const args = (j && j.arguments) || [];
          if (args.length !== 1) return '';
          return String(args[0] && (args[0].ARG || args[0].name)) || '';
        })
        .catch(() => '')
    );
  }
  return _faultArg.get(sgbd);
}
/** faultReadArg's per-SGBD cache: one lookup per module per session. */
const _faultArg = new Map();

/**
 * The query for a fault read: the address group, and the argument the module
 * declares. Both are optional and independent; the router reads each on its
 * own.
 * @param {{sgbd: string, group?: string}} ecu - The module.
 * @param {string} [job] - The fault read.
 * @returns {Promise<string>} The query string, leading '?' included, or ''.
 */
async function faultReadQuery(ecu, job) {
  const parts = [];
  if (ecu && ecu.group) parts.push(`group=${encodeURIComponent(ecu.group)}`);
  const arg = await faultReadArg(ecu.sgbd, job);
  if (arg) parts.push(`arg=${encodeURIComponent(arg)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

/**
 * Read fault memory. FS_LESEN is the job every fault-capable SGBD declares;
 * set 0 is the EDIABAS system summary, the rest are fault entries. This is
 * the same call faults.js and live.js make -- the old `/api/ecu/<s>/read`
 * endpoint here was a C#-server route that the web build never implemented,
 * so it 404'd and every module in the sweep reported "no response".
 * @param {string} sgbd - The SGBD.
 * @returns {Promise<FaultEntry[]>} The fault entries (sets carrying a code).
 * @throws {Error} When the wire fails -- the caller must never read that as
 *   "clean".
 */
async function readFaults(sgbd) {
  const q = await faultReadQuery({ sgbd });
  const d = await api(`/api/ecu/${sgbd}/run/FS_LESEN${q}`, { method: 'POST' });
  return dataSets(d.sets).filter((c) => c.F_HEX_CODE || c.F_ORT_NR);
}

/**
 * Did the request fail because the job does not exist, rather than because
 * the bus was silent? A module answering "no faults" and a module that is
 * not there both produce a short reply, so the difference has to come from
 * the transport: api() throws on a wire failure and returns sets on an
 * answer. `count` (the old field read here) never existed outside the C#
 * server.
 * @param {unknown} e - The thrown error.
 * @returns {boolean} True for a missing route or job.
 */
const isMissingJob = (e) =>
  /404|not found|no job|unknown sgbd|no job code|no static route/i.test(
    String((e && e.message) || e)
  );

/**
 * A stable fault signature for echo dedup. F_HEX_CODE is globally unique
 * (BMW DTC); F_ORT_NR is only an ECU-local index, so fall back to it only
 * when hex is absent. hexText: on web F_HEX_CODE is a byte Array, which would
 * splice its own commas into a comma-joined signature and let two faults
 * collide with one; '|' can't appear in dashed hex.
 * @param {FaultEntry[]|null|undefined} codes - The fault list.
 * @returns {string} The signature.
 */
const _faultSig = (codes) =>
  (codes || [])
    .map((c) => hexText(c.F_HEX_CODE) || `nr:${c.F_ORT_NR}`)
    .join('|');

/**
 * The running sweep's token. Each sweep takes a token; navigating away or
 * starting another bumps it, and the running loop bails on its next
 * iteration -- stops hammering the K-line once the user leaves.
 * @type {number}
 */
let _sweepToken = 0;

/**
 * Invalidate the running sweep, if any.
 * @returns {void}
 */
const cancelSweep = () => {
  _sweepToken++;
};

/**
 * Claim a new sweep run.
 * @returns {() => boolean} `alive`: true while this run still owns the bus.
 */
function claimSweep() {
  const token = ++_sweepToken;
  return () => token === _sweepToken;
}

/**
 * Read FS_LESEN_DETAIL per fault and merge the rich fields (p-code, freq,
 * env) onto each entry in place. Keeps the short hex/loc from the base read.
 * @param {string} sgbd - The SGBD the faults were read from.
 * @param {FaultEntry[]} faults - The base entries, enriched in place.
 * @returns {Promise<void>} Resolves when every entry has been tried.
 */
async function fillFaultDetail(sgbd, faults) {
  for (const f of faults) {
    if (f.F_ORT_NR == null) continue;
    try {
      const det = await api(
        `/api/ecu/${sgbd}/run/FS_LESEN_DETAIL?arg=${encodeURIComponent(f.F_ORT_NR)}`,
        { method: 'POST' }
      );
      const dset = matchDetail(det.sets, f.F_ORT_NR);
      if (dset) {
        const { F_HEX_CODE, F_ORT_TEXT, ...rich } = dset;
        Object.assign(f, rich);
      }
    } catch {
      /* keep base entry */
    }
  }
}

/**
 * Pick the detail set for fault nr. Match F_ORT_NR first; fall back to a
 * p-code/hex set only when no set has an F_ORT_NR, so wrong-fault data isn't
 * attached.
 * @param {object[]|null|undefined} sets - FS_LESEN_DETAIL's result sets.
 * @param {string|number} nr - The fault number asked for.
 * @returns {object|null} The matching set, or null.
 */
function matchDetail(sets, nr) {
  const list = sets || [];
  return (
    list.find((s) => s.F_ORT_NR == nr) ||
    (list.some((s) => s.F_ORT_NR != null)
      ? null
      : list.find((s) => s.F_PCODE_STRING || s.F_HEX_CODE))
  );
}
