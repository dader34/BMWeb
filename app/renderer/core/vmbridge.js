// NOT LOADED BY THE APP. Kept as the fixture tools/verify/test_vmbridge.js
// runs: it replays telegrams the C# engine captured and checks the VM decodes
// them to the same results, which is still the best evidence the VM is right
// about real bytes. There is no engine in the app any more, so there is
// nothing to shadow at runtime and index.html no longer includes this.
//
// Run jobs through OUR BEST2 VM instead of the C# EDIABAS engine.
//
// This is the switch-over seam. The VM matches the engine on 100% of 3730
// results across 460 jobs (tools/test_bestvm.js) -- but every one of those
// was a SYNTHETIC response built to exercise the lifter. Real ECU bytes are
// the one thing it has never seen, so this ships in a mode that proves
// itself on the car before anything depends on it.
//
// THE TRICK THAT MAKES THAT CHEAP: EDIABAS publishes the telegrams it
// exchanged as results of the job itself -- _TEL_AUFTRAG is the request it
// sent, _TEL_ANTWORT the answer it got. So a normal engine run already
// carries the exact bytes off the wire, and the VM can replay THOSE. No new
// transport, no second conversation with the ECU, no risk of two clients on
// one bus. The comparison is against real data because the engine did the
// talking.
//
// Modes (Settings 'vm'):
//   off     the engine's results are used; the VM never runs   (default)
//   shadow  both run, the ENGINE's results are displayed, and any
//           disagreement is reported. This is the mode to drive the car in.
//   on      the VM's results are displayed. Only worth doing once shadow
//           has been quiet on your own vehicle.
//
// The VM cannot reach the bus from here in any mode: its send() callback
// replays a captured answer and has nowhere else to go.

const VM_CODE_CACHE = new Map();
const VM_TABLE_CACHE = new Map();

// Telegram results come back as "82-12-F1-21-F0" (Diag.Format).
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

async function vmFetchJson(path) {
  const res = await fetch(path);
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

// Which SGBDs have code shipped at all. Job code is exported for E46 only --
// the app can browse ten other chassis, and asking for code that was never
// generated is a guaranteed 404. Fetching anyway "works" (vmFetchJson returns
// null and the job skips), but DevTools logs every failed request in red, so
// opening an E65 screen paints the console with errors that look like a fault
// and are not one. Consult the manifest first and skip without the request.
let VM_INDEX = null;
async function vmHasCode(key) {
  if (VM_INDEX === null) {
    const idx = await vmFetchJson('data/job-code/index.json');
    // No manifest shipped -> assume yes and let the 404 decide, rather than
    // disabling the VM wholesale on a missing index.
    VM_INDEX = idx && Array.isArray(idx.sgbds) ? new Set(idx.sgbds) : false;
  }
  return VM_INDEX === false || VM_INDEX.has(key);
}

async function vmCodeFor(sgbd) {
  const key = String(sgbd).toLowerCase();
  if (!VM_CODE_CACHE.has(key)) {
    const shipped = await vmHasCode(key);
    VM_CODE_CACHE.set(key, shipped
      ? await vmFetchJson(`data/job-code/${key}.json`)
      : null);
  }
  return VM_CODE_CACHE.get(key);
}

async function vmTablesFor(sgbd) {
  const key = String(sgbd).toLowerCase();
  if (!VM_TABLE_CACHE.has(key)) {
    VM_TABLE_CACHE.set(key, await vmFetchJson(`data/sgbd-tables/${key}.json`)
      || {});
  }
  return VM_TABLE_CACHE.get(key);
}

// Replay a job through the VM using the telegrams the ENGINE captured.
// Returns {sets} on success, or {skipped: reason} -- never throws, because a
// VM problem must not break a screen the engine already answered.
async function vmReplay(sgbd, job, engineSets, arg) {
  if (typeof Best2Vm === 'undefined') return { skipped: 'vm not loaded' };
  const code = await vmCodeFor(sgbd);
  if (!code) return { skipped: 'no job code shipped' };
  if (code.jobs[job] === undefined
      && code.jobs[String(job).toUpperCase()] === undefined) {
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
  for (const s of (engineSets || [])) {
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
    const framed = ans && ans.length >= 4 && (ans[0] & 0x80) !== 0
      && ((ans[0] & 0x3f) === ans.length - 3
          || (ans[0] & 0x3f) === ans.length - 4);
    if (!framed && ans && req && req.length >= 3 && ans.length < 0x40) {
      // header + payload + CHECKSUM. EdInterfaceObd returns the frame with
      // its trailing checksum byte (TelLengthBmwFast + 1) and jobs verify
      // the length including it, so omitting it reads one byte short and
      // every job answers ERROR_ECU_INCORRECT_LEN.
      const frame = [0x80 | ans.length, req[2], req[1]].concat(ans);
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
  let seq = 0;
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

// Compare one engine set against one VM set. Engine values are strings;
// numbers are compared numerically so 1.0 and "1" agree.
function vmDiffSets(engineSets, vmSets) {
  const SYS = new Set(['OBJECT', 'JOBNAME', 'VARIANTE', 'GRUPPE', 'FAMILIE',
    'SAETZE', 'JOBSTATUS', 'UBATTCURRENT', 'UBATTHISTORY', 'IGNITIONCURRENT',
    'IGNITIONHISTORY', 'SPRACHE']);
  const diffs = [];
  let checked = 0;
  const data = (engineSets || []).filter(
    (s) => !Object.keys(s).some((k) => SYS.has(k)));
  for (let i = 0; i < data.length; i++) {
    const want = data[i];
    const got = (vmSets || [])[i] || {};
    for (const [k, wv] of Object.entries(want)) {
      if (k.startsWith('_') || SYS.has(k)) continue;
      checked++;
      let gv = got[k];
      if (Array.isArray(gv)) {
        gv = gv.map((b) => b.toString(16).toUpperCase()
          .padStart(2, '0')).join('-');
      }
      const wn = parseFloat(wv), gn = parseFloat(gv);
      const same = (Number.isFinite(wn) && Number.isFinite(gn)
        && /^[-+0-9.eE]+$/.test(String(wv).trim()))
        ? Math.abs(wn - gn) <= Math.max(1e-6, Math.abs(wn) * 1e-9)
        : String(wv) === String(gv);
      if (!same) diffs.push({ key: k, engine: wv, vm: gv });
    }
  }
  return { checked, diffs };
}

// Running tally, so a drive produces one honest number rather than a stream
// of toasts. Read it from the console with vmStats().
const VM_STATS = { jobs: 0, checked: 0, disagreed: 0, skipped: 0,
                   bySkip: {}, worst: [] };

function vmStats() { return VM_STATS; }

// The entry point core.js calls after every successful job run.
async function vmObserve(sgbd, job, engineSets, arg) {
  const mode = (typeof Settings !== 'undefined')
    ? Settings.get('vm', 'off') : 'off';
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
    VM_STATS.worst.push({ sgbd, job, diffs: diffs.slice(0, 6) });
    if (VM_STATS.worst.length > 40) VM_STATS.worst.shift();
    console.warn(`[vm] ${sgbd}:${job} ${diffs.length}/${checked} differ`,
                 diffs.slice(0, 6));
  }
  return mode === 'on' ? r.sets : null;
}

if (typeof window !== 'undefined') {
  window.vmObserve = vmObserve;
  window.vmStats = vmStats;
  window.vmReplay = vmReplay;
}
