// Flashing/Tuning: the interruptible push, ported from the emulator proof
// (ms45-emu tools/flash_resume_test.py, ALL OK on the BL image,
// 2026-10-27). BENCH ONLY (localhost), like the fast flasher it rides on.
//
// The app's in-push resume assumed the connection died but the DME stayed
// powered. A power cut -- cable pull, laptop battery, ignition cycle --
// kills that knowledge. This driver derives everything from what the DME
// itself reports after BL's line-hold re-entry (the handoff window on a
// bootable DME, the park window on a cut one), so ONE code path handles
// every stop:
//
//   1. TAIL DISCRIMINATOR: SECTOR_QUERY of the last chunk. Equal to the
//      target -> the push is complete (VERIFY + MARKS only, nothing sent).
//      Blank -> the sector was erased; find the resume point. Anything
//      else -> old or different content: erase first. A blank TARGET tail
//      cannot announce completion (a blank chip tail is also the erased
//      state), so blank defers to the prefix search, whose gallop reaching
//      the end IS completion.
//   2. CHUNK PREFIX: the first chunk that differs, by exponential-then-
//      binary search over cumulative QUERY CRCs (~2 lg n probes, not n).
//   3. TORN-CHUNK GUARD: the chunk at the resume point is READ; if its
//      content is not AND-compatible with the target (a torn write is,
//      old content is not) the plan falls back to a full erase --
//      programming over foreign bits would corrupt. A NAK "read-back
//      mismatch" on a later chunk falls back the same way, at most twice
//      before the error stands.
//   4. COMPLETION: VERIFY over the whole span, then MARKS -- the burn is
//      idempotent (bit-clear of the same halfwords), so resuming an
//      already-finished session writes nothing extra.
//
// The BL loader carries both windows; on the old ring layout the park window is absent
// and a mid-push power cut leaves the DME in its factory-KWP park, which
// only a factory-dialect reflash can reach. fbDmeFastPushWithResume's
// power-loss message still says that; on a BL DME this driver resumes
// instead.

// the wire's constants and CRC: a later classic script sees the page's
// fastFlashWire; the verify harness loads this file as a module
const pushWire =
  typeof fastFlashWire !== 'undefined'
    ? fastFlashWire
    : require('./fast-flasher-wire.js').fastFlashWire;

/** The protocol's chunk size; the wire's CHUNK caps and READ step at 4 KB. */
const PR_CHUNK = 0x1000;
/** How many full-erase restarts a "would not take" chunk may cause. */
const PR_RESTARTS = 2;

/**
 * The first chunk whose bytes differ, by gallop then binary search over
 * cumulative QUERY CRCs. Returns the chunk index (data.length / chunk when
 * the whole span already matches) and the probe count, for the log.
 * @param {object} client
 * @param {number} base - The span's ext offset.
 * @param {Uint8Array} data - The span's target bytes.
 * @param {number} chunk
 * @returns {Promise<{k: number, probes: number}>}
 */
async function prFirstUnpushed(client, base, data, chunk) {
  const crc = pushWire.crc32;
  const n = data.length / chunk;
  let done = 0;
  let step = 1;
  let span = n; // [0,done) matches; (done,span) holds a miss
  let probes = 0;
  while (done < n) {
    const k = Math.min(done + step, n);
    probes++;
    const want = crc(data.subarray(0, k * chunk)) >>> 0;
    if ((await client.sectorQuery(base, k * chunk)) >>> 0 === want) {
      done = k;
      step *= 2;
    } else {
      span = k;
      break;
    }
  }
  if (done >= n) return { k: n, probes };
  while (span - done > 1) {
    const mid = (done + span) >> 1;
    probes++;
    const want = crc(data.subarray(0, mid * chunk)) >>> 0;
    if ((await client.sectorQuery(base, mid * chunk)) >>> 0 === want) {
      done = mid;
    } else {
      span = mid;
    }
  }
  return { k: done, probes };
}

/**
 * Bring the span to `data` from whatever state the DME is in: the
 * interruptible push. Safe to run on a fresh DME, a half-pushed one, or a
 * finished one -- each converges, sending only what is missing.
 * @param {object} client - fastFlashWire.Client on an open link.
 * @param {{base: number, data: Uint8Array, marks?: 0|1|null, chunk?: number}} spec
 *   base  the span's ext offset; data its target bytes, a multiple of
 *   chunk; marks 0 to burn the cal marks on completion, 1 the program's,
 *   null (default) to skip them (the AIF flows manage their own commit).
 * @param {{stage: (s: string) => void, progress: (pct: number) => void, note: (msg: string) => void}} cb
 * @returns {Promise<{sent: number, erased: boolean, verdict: string}>}
 * @throws {Error} If the chip refuses a fresh-erased chunk twice, or any
 *   wire error stands.
 */
async function prPush(client, spec, cb) {
  const chunk = spec.chunk || PR_CHUNK;
  const { base, data } = spec;
  if (data.length === 0 || data.length % chunk)
    throw new Error(
      `the push span must be a multiple of ${chunk} bytes (got ${data.length})`
    );
  const crc = pushWire.crc32;
  const n = data.length / chunk;
  const blank = crc(new Uint8Array(chunk).fill(0xff)) >>> 0;
  let sent = 0;
  let erased = false;
  let verdict = '';
  let restarts = 0;

  const erase = async () => {
    cb.note(`erasing the sector at 0x${base.toString(16)}`);
    await client.erase(base);
    erased = true;
  };

  // 1. the tail discriminator
  const tail = data.subarray((n - 1) * chunk);
  const tailCrc =
    (await client.sectorQuery(base + (n - 1) * chunk, chunk)) >>> 0;
  let k;
  if (tailCrc !== blank && tailCrc === crc(tail) >>> 0) {
    verdict = 'push complete';
    k = n;
  } else if (tailCrc === blank) {
    // 2. the prefix search decides both the resume point and, by galloping
    //    to the end, completion for a blank-target tail
    const r = await prFirstUnpushed(client, base, data, chunk);
    if (r.k >= n) {
      verdict = `push complete (${r.probes} probes)`;
      k = n;
    } else {
      // 3. the torn-chunk guard: a torn write is AND-compatible with the
      //    target, old content is not
      const at = base + r.k * chunk;
      const have = await client.read(at, chunk);
      const want = data.subarray(r.k * chunk, (r.k + 1) * chunk);
      let torn = true;
      for (let i = 0; i < chunk; i++)
        if ((have[i] & want[i]) !== want[i]) {
          torn = false;
          break;
        }
      if (torn) {
        verdict = `erased, resume at chunk ${r.k} (${r.probes} probes)`;
        k = r.k;
      } else {
        cb.note(
          `chunk ${r.k} holds bits the target does not: a full erase, not a resume`
        );
        verdict = 'foreign content -> erase';
        await erase();
        k = 0;
      }
    }
  } else {
    verdict = 'old content -> erase';
    await erase();
    k = 0;
  }
  cb.note(`the DME says: ${verdict}`);

  // the push itself, with the would-not-take fallback
  cb.stage(k >= n ? 'Confirming the push' : 'Pushing');
  while (k < n) {
    const piece = data.subarray(k * chunk, (k + 1) * chunk);
    try {
      await client.chunk(base + k * chunk, piece);
    } catch (e) {
      if (!(e instanceof pushWire.Nak && e.reason === 4)) throw e;
      restarts++;
      if (restarts > PR_RESTARTS)
        throw new Error(
          `the DME refused chunk ${k} (the bytes would not take) again after a full erase: ` +
            'the chip is not programming as erased. Nothing more was written.',
          { cause: e }
        );
      cb.note(
        `chunk ${k} would not take -> full erase, restart (${restarts}/${PR_RESTARTS})`
      );
      await erase();
      k = 0;
      sent = 0;
      continue;
    }
    sent++;
    k++;
    cb.progress(Math.floor((k * 100) / n));
  }

  await client.verify(base, data.length, crc(data) >>> 0);
  if (spec.marks !== null && spec.marks !== undefined)
    await client.marks(spec.marks);
  return { sent, erased, verdict };
}

/** The interruptible push, for dme-fast.js's specs to drive. */
const pushResume = {
  CHUNK: PR_CHUNK,
  RESTARTS: PR_RESTARTS,
  firstUnpushed: prFirstUnpushed,
  push: prPush,
};

if (typeof window !== 'undefined') {
  window.pushResume = pushResume;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { pushResume };
}
