/**
 * @file NOT LOADED BY THE APP -- only tools/verify/test_vmbridge.js uses it.
 * Replays telegrams the C# engine captured (_TEL_AUFTRAG = request,
 * _TEL_ANTWORT = answer, both published as job results) back through the VM
 * and checks it decodes real wire bytes to the same values. The VM's send()
 * only replays a captured answer, so it never reaches a bus.
 */

/** Parsed job code per SGBD (lower-cased name), null when none is shipped. */
const VM_CODE_CACHE = new Map();
/** SGBD tables per SGBD (lower-cased name). */
const VM_TABLE_CACHE = new Map();

/** The frame byte's high bit: set on a BMW-FAST header, low bits = length. */
const FRAME_FLAG = 0x80;
/** Payload lengths at or above this need the long header form; not re-wrapped. */
const SHORT_FRAME_MAX = 0x40;

/**
 * Result names the engine synthesizes into its system set; never diffed.
 * @type {Set<string>}
 */
const VM_SYSTEM_RESULTS = new Set([
  'OBJECT',
  'JOBNAME',
  'VARIANTE',
  'GRUPPE',
  'FAMILIE',
  'SAETZE',
  'JOBSTATUS',
  'UBATTCURRENT',
  'UBATTHISTORY',
  'IGNITIONCURRENT',
  'IGNITIONHISTORY',
  'SPRACHE',
]);

/** How many disagreeing jobs the tally keeps, newest last. */
const VM_WORST_KEEP = 40;
/** How many differing keys each kept job records. */
const VM_DIFFS_PER_JOB = 6;

/**
 * Telegram results come back as "82-12-F1-21-F0" (Diag.Format); parse one
 * into bytes.
 * @param {string|number[]} s - The published telegram text, or bytes already.
 * @returns {?number[]} The bytes, or null when the text is not a telegram.
 */
function telBytes(s) {
  if (Array.isArray(s)) return s.map(Number);
  if (typeof s !== 'string' || !s) return null;
  const parts = s.split('-');
  const out = [];
  for (const p of parts) {
    const v = parseInt(p, 16);
    if (!Number.isFinite(v)) return null;
    out.push(v);
  }
  return out;
}

/**
 * Fetch a JSON file from the app's data tree.
 * @param {string} path - The relative URL.
 * @returns {Promise<?object>} The parsed JSON, or null on any failure.
 */
async function vmFetchJson(path) {
  const res = await fetch(path);
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

/**
 * The shipped-code manifest: a Set of SGBD names, false when no manifest
 * ships, null until first consulted.
 * @type {?(Set<string>|false)}
 */
let VM_INDEX = null;

/**
 * Which SGBDs have code shipped (E46 only). Consult the manifest first so a
 * browse of another chassis skips silently instead of painting DevTools red
 * with guaranteed 404s that look like faults.
 * @param {string} key - The SGBD name, lower-cased.
 * @returns {Promise<boolean>} Whether job code should be fetched for it.
 */
async function vmHasCode(key) {
  if (VM_INDEX === null) {
    const idx = await vmFetchJson('data/job-code/index.json');
    // No manifest shipped -> assume yes and let the 404 decide, rather than
    // disabling the VM wholesale on a missing index.
    VM_INDEX = idx && Array.isArray(idx.sgbds) ? new Set(idx.sgbds) : false;
  }
  return VM_INDEX === false || VM_INDEX.has(key);
}

/**
 * The parsed job code for an SGBD, cached.
 * @param {string} sgbd - The SGBD name, any case.
 * @returns {Promise<?object>} The job code, or null when none ships.
 */
async function vmCodeFor(sgbd) {
  const key = String(sgbd).toLowerCase();
  if (!VM_CODE_CACHE.has(key)) {
    const shipped = await vmHasCode(key);
    VM_CODE_CACHE.set(
      key,
      shipped ? await vmFetchJson(`data/job-code/${key}.json`) : null
    );
  }
  return VM_CODE_CACHE.get(key);
}

/**
 * The SGBD's tables, cached; an empty object when none ship.
 * @param {string} sgbd - The SGBD name, any case.
 * @returns {Promise<Object<string, object[]>>} Table name -> rows.
 */
async function vmTablesFor(sgbd) {
  const key = String(sgbd).toLowerCase();
  if (!VM_TABLE_CACHE.has(key)) {
    VM_TABLE_CACHE.set(
      key,
      (await vmFetchJson(`data/sgbd-tables/${key}.json`)) || {}
    );
  }
  return VM_TABLE_CACHE.get(key);
}

/**
 * The outcome of a replay: the VM's result sets, or why it was skipped.
 * @typedef {Object} VmReplayResult
 * @property {object[]} [sets] - The VM's result sets on success.
 * @property {string} [skipped] - The reason nothing was replayed.
 */

/**
 * Replay a job through the VM using the telegrams the ENGINE captured.
 * Returns {sets} on success, or {skipped: reason} -- never throws, because a
 * VM problem must not break a screen the engine already answered.
 * @param {string} sgbd - The SGBD the job belongs to.
 * @param {string} job - The job name.
 * @param {object[]} engineSets - The engine's published result sets.
 * @param {?string} arg - The job argument, if any.
 * @returns {Promise<VmReplayResult>} The replay outcome.
 */
async function vmReplay(sgbd, job, engineSets, arg) {
  if (typeof Best2Vm === 'undefined') return { skipped: 'vm not loaded' };
  const code = await vmCodeFor(sgbd);
  if (!code) return { skipped: 'no job code shipped' };
  if (
    code.jobs[job] === undefined &&
    code.jobs[String(job).toUpperCase()] === undefined
  ) {
    return { skipped: 'job not in export' };
  }
  // Collect the request/response pairs the engine recorded, in order. A
  // multi-telegram job publishes one pair per set.
  //
  // _TEL_ANTWORT IS THE PAYLOAD, NOT THE FRAME. EDIABAS strips the transport
  // header before publishing: a BMW-FAST answer arrives as "61-F0-..." (26
  // bytes) where the VM's xsend expects what came off the wire,
  // "9A-F1-12-61-F0-..." (30). The header is recoverable from the request,
  // whose own header names the two addresses:
  //     request  82 12 F1 ...   fmt=0x80|len, dst=12, src=F1
  //     answer   9A F1 12 ...   fmt=0x80|len, dst=F1, src=12   (swapped)
  // so prepend [0x80|payloadLen, requestSrc, requestDst]. Feeding the bare
  // payload instead made every job read its fields three bytes early and
  // decode nothing.
  const pairs = [];
  for (const s of engineSets || []) {
    const req = telBytes(s._TEL_AUFTRAG ?? s._TEL_AUFTRAG_L);
    let ans = telBytes(s._TEL_ANTWORT);
    // SOMETIMES THE HEADER IS ALREADY THERE. Whether _TEL_ANTWORT is the
    // payload or the whole frame depends on the job -- gs30 publishes
    // "9B-F1-12-63-..." (framed) where ms450ds0 publishes "71-30-00-..."
    // (payload). A frame is self-identifying: byte 0 has bit 7 set and its
    // low bits give the payload length, and bytes 1/2 are the request's
    // addresses swapped. Test for that instead of assuming either shape.
    // Detect framing from the LENGTH FIELD alone, not from the addresses.
    // gs30 asks 0x32 and the published answer says 0x12 -- the engine reports
    // the variant's own address, not the group address the request used -- so
    // an address equality test rejects a perfectly good frame and re-wraps
    // it, which is how STATUS_INPUT_SIGNALS ended up
    // ERROR_ECU_INCORRECT_RESPONSE_ID. Byte 0 with bit 7 set and low bits
    // equal to the remaining length is the frame's own self-description.
    const framed =
      ans &&
      ans.length >= 4 &&
      (ans[0] & FRAME_FLAG) !== 0 &&
      ((ans[0] & 0x3f) === ans.length - 3 ||
        (ans[0] & 0x3f) === ans.length - 4);
    if (
      !framed &&
      ans &&
      req &&
      req.length >= 3 &&
      ans.length < SHORT_FRAME_MAX
    ) {
      // header + payload + CHECKSUM. EdInterfaceObd returns the frame with
      // its trailing checksum byte (TelLengthBmwFast + 1) and jobs verify
      // the length including it, so omitting it reads one byte short and
      // every job answers ERROR_ECU_INCORRECT_LEN.
      const frame = [FRAME_FLAG | ans.length, req[2], req[1]].concat(ans);
      let sum = 0;
      for (const b of frame) sum = (sum + b) & 0xff;
      frame.push(sum);
      ans = frame;
    }
    if (ans) pairs.push([req ? String(req) : null, ans]);
  }
  if (!pairs.length) return { skipped: 'engine published no telegrams' };
  const byReq = new Map(pairs.filter((p) => p[0]).map((p) => [p[0], p[1]]));
  const lastAns = pairs[pairs.length - 1][1];
  // THE VM SENDS MORE THAN THE ENGINE PUBLISHES. EDIABAS runs the SGBD's
  // INITIALISIERUNG before the first job of a session and publishes only the
  // job's own telegram, so replaying strictly by call order starves the init
  // exchange and the job exits before decoding anything. Any request we have
  // no capture for is answered with the job's own response: init only checks
  // that the ECU replied, and the job's request still matches by content.
  try {
    const vm = new Best2Vm(code, {
      tables: await vmTablesFor(sgbd),
      args: arg == null ? '' : String(arg),
      // Answer from what the ECU actually said. Match on the request when we
      // have it (a job may send several), else fall back to call order.
      send: (out) => {
        const hit = byReq.get(String(Array.from(out)));
        if (hit) return hit;
        return lastAns;
      },
      // The engine already transmitted; we are replaying its bytes, so the
      // write guard has nothing left to protect against here.
      allowWrites: true,
    });
    return { sets: vm.run(job, arg == null ? '' : String(arg)) };
  } catch (e) {
    return { skipped: `vm error: ${e.message}` };
  }
}

/**
 * One result the VM and the engine disagree on.
 * @typedef {Object} VmDiff
 * @property {string} key - The result name.
 * @property {*} engine - The engine's value.
 * @property {*} vm - The VM's value.
 */

/**
 * Compare the engine's data sets against the VM's, set by set. Engine values
 * are strings; numbers are compared numerically so 1.0 and "1" agree, and a
 * VM byte array is rendered "AB-CD" to match the engine's text.
 * @param {object[]} engineSets - The engine's result sets (system set included).
 * @param {object[]} vmSets - The VM's result sets.
 * @returns {{checked: number, diffs: VmDiff[]}} How many results were compared
 *   and which differed.
 */
function vmDiffSets(engineSets, vmSets) {
  const diffs = [];
  let checked = 0;
  const data = (engineSets || []).filter(
    (s) => !Object.keys(s).some((k) => VM_SYSTEM_RESULTS.has(k))
  );
  for (let i = 0; i < data.length; i++) {
    const want = data[i];
    const got = (vmSets || [])[i] || {};
    for (const [k, wv] of Object.entries(want)) {
      if (k.startsWith('_') || VM_SYSTEM_RESULTS.has(k)) continue;
      checked++;
      let gv = got[k];
      if (Array.isArray(gv)) {
        gv = gv
          .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
          .join('-');
      }
      const wn = parseFloat(wv),
        gn = parseFloat(gv);
      const same =
        Number.isFinite(wn) &&
        Number.isFinite(gn) &&
        /^[-+0-9.eE]+$/.test(String(wv).trim())
          ? Math.abs(wn - gn) <= Math.max(1e-6, Math.abs(wn) * 1e-9)
          : String(wv) === String(gv);
      if (!same) diffs.push({ key: k, engine: wv, vm: gv });
    }
  }
  return { checked, diffs };
}

/**
 * The running tally of a drive, so it produces one honest number rather than
 * a stream of toasts. Read it from the console with vmStats().
 * @typedef {Object} VmStats
 * @property {number} jobs - Jobs replayed and compared.
 * @property {number} checked - Results compared.
 * @property {number} disagreed - Results that differed.
 * @property {number} skipped - Jobs that could not be replayed.
 * @property {Object<string, number>} bySkip - Skip reason -> count.
 * @property {Array<{sgbd: string, job: string, diffs: VmDiff[]}>} worst -
 *   The most recent disagreeing jobs, newest last.
 */

/** @type {VmStats} */
const VM_STATS = {
  jobs: 0,
  checked: 0,
  disagreed: 0,
  skipped: 0,
  bySkip: {},
  worst: [],
};

/**
 * The running tally.
 * @returns {VmStats} The live tally object.
 */
function vmStats() {
  return VM_STATS;
}

/**
 * The entry point core.js calls after every successful job run: replay the
 * job, diff it, and update the tally. Governed by the 'vm' setting: 'off'
 * does nothing, 'on' also hands the VM's sets back to the caller.
 * @param {string} sgbd - The SGBD the job belongs to.
 * @param {string} job - The job name.
 * @param {object[]} engineSets - The engine's published result sets.
 * @param {?string} arg - The job argument, if any.
 * @returns {Promise<?object[]>} The VM's sets when the setting is 'on', else
 *   null.
 */
async function vmObserve(sgbd, job, engineSets, arg) {
  const mode =
    typeof Settings !== 'undefined' ? Settings.get('vm', 'off') : 'off';
  if (mode === 'off') return null;
  const r = await vmReplay(sgbd, job, engineSets, arg);
  if (r.skipped) {
    VM_STATS.skipped++;
    VM_STATS.bySkip[r.skipped] = (VM_STATS.bySkip[r.skipped] || 0) + 1;
    return null;
  }
  const { checked, diffs } = vmDiffSets(engineSets, r.sets);
  VM_STATS.jobs++;
  VM_STATS.checked += checked;
  VM_STATS.disagreed += diffs.length;
  if (diffs.length) {
    VM_STATS.worst.push({ sgbd, job, diffs: diffs.slice(0, VM_DIFFS_PER_JOB) });
    if (VM_STATS.worst.length > VM_WORST_KEEP) VM_STATS.worst.shift();
    console.warn(
      `[vm] ${sgbd}:${job} ${diffs.length}/${checked} differ`,
      diffs.slice(0, VM_DIFFS_PER_JOB)
    );
  }
  return mode === 'on' ? r.sets : null;
}

if (typeof window !== 'undefined') {
  window.vmObserve = vmObserve;
  window.vmStats = vmStats;
  window.vmReplay = vmReplay;
}
