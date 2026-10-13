/**
 * @file Data logging: the MS45's measurement values, all in one exchange.
 *
 * A job is a round trip to the car, and a logging round is one trip per job:
 * five readings on five jobs come back at a fifth of the rate of one. The
 * MS45 has a way round that, the one its own diagnostic jobs use for their
 * measurement blocks. It keeps a table of some 240 values, each with an
 * identifier (0x4100..0x41FF); a tester names the ones it wants once
 * (2C F0, a list of identifiers) and from then on a single short request
 * (21 F0) is answered with all of them, two bytes each. What each word means
 * and how it scales is the SGBD's own table, carried in comfort.js.
 *
 * So the readings ticked on the MS45's comfort list are one "job" to the
 * scheduler, LOG_PACKET_JOB, which this file runs: define the packet when
 * the selection changes (or the DME has forgotten it), then one read a round.
 *
 * The DME has ONE such packet. The tuning page's live cursor defines it too,
 * as does any measurement-block job; each clears and defines its own before
 * reading, so they take turns rather than collide, and a read that comes
 * back the wrong size here is simply defined again.
 */

/* exported LOG_PACKET_JOB, LOG_PACKET_MAX, logPacketKey, logPacketRead, logPacketRelease */

/** The scheduler's name for "the measurement values, read as one packet". */
const LOG_PACKET_JOB = '@VALUES';
/** How many values one definition can name: the request's length byte. */
const LOG_PACKET_MAX = 42;
/** The DME's one definable local identifier. */
const LOG_PACKET_ID = 0xf0;

/**
 * The result key a measurement value is stored under. Shaped like an SGBD's
 * (X_WERT, with X_EINH beside it) so the store finds the unit the same way.
 * @param {number} id - The value's identifier.
 * @returns {string}
 */
function logPacketKey(id) {
  return `MW${id.toString(16).toUpperCase().padStart(4, '0')}_WERT`;
}

/** What the DME was last told to send, and the raw sender it was told with. */
const logPacket = {
  defined: '',
  send: null,
  /** Logging is reading values through the packet (from its first read to
   *  its release): whoever else wants the packet waits. Not `defined`, which
   *  is blank for a moment each time the list is sent again. */
  active: false,
  /** How often the list had to be sent again after the first time: more
   *  than a handful means something else keeps taking the packet. */
  resent: 0,
  /** The list last asked for, to tell a re-send from a new selection. */
  wanted: '',
  /** What the sender says of its last telegram (ms45LiveTuneSender). */
  timing: { waitMs: 0, wireMs: 0 },
  /** The last round that stalled, in words, and how many have. */
  slow: '',
  slowCount: 0,
};

/**
 * Tell the DME which values the packet holds.
 * @param {(data: number[]) => Promise<number[]|Uint8Array|null>} send
 * @param {Array<{id: number}>} values
 * @returns {Promise<void>}
 */
async function logPacketDefine(send, values) {
  // as the DME's own jobs do: clear whatever was there, then name ours
  await send([0x2c, LOG_PACKET_ID, 0x04]);
  const req = [0x2c, LOG_PACKET_ID];
  values.forEach((v, i) => {
    // 02 = by identifier; position (1-based, in bytes); size 2; id; 01
    req.push(0x02, 1 + 2 * i, 0x02, (v.id >> 8) & 0xff, v.id & 0xff, 0x01);
  });
  const r = await send(req);
  if (!r) throw new Error('the DME did not answer');
  if (r[0] !== 0x6c)
    throw new Error('the DME would not take the list of values');
}

/**
 * One logging round of measurement values: every key, from one exchange.
 * @param {string} sgbd - The control unit (the MS45).
 * @param {string[]} keys - logPacketKey of each value wanted.
 * @returns {Promise<Record<string, number|string>>} A result row, as a job's:
 *   each key's figure, and its unit under the paired _EINH key.
 */
async function logPacketRead(sgbd, keys) {
  if (typeof ms45LiveTuneSender !== 'function')
    throw new Error('measurement values need this machine’s own cable');
  if (typeof webOnSharedCar === 'function' && webOnSharedCar())
    throw new Error('measurement values are not read over a shared car');
  if (keys.length > LOG_PACKET_MAX)
    throw new Error(
      `${keys.length} values ticked; the DME sends at most ${LOG_PACKET_MAX} at once`
    );
  const values = keys.map((k) => {
    const v = logComfortValueFor(sgbd, k);
    if (!v) throw new Error(`${k} is not a known measurement value`);
    return v;
  });
  logPacket.active = true;
  if (!logPacket.send) logPacket.send = ms45LiveTuneSender(logPacket.timing);
  const startedAt = Date.now();
  let waited = 0;
  let onWire = 0;
  let telegrams = 0;
  const raw = logPacket.send;
  // every telegram of this round, with where its time went
  const send = async (data) => {
    const r = await raw(data);
    telegrams++;
    waited += logPacket.timing.waitMs || 0;
    onWire += logPacket.timing.wireMs || 0;
    return r;
  };
  const want = `${sgbd}:${keys.join(',')}`;
  const size = 2 + 2 * values.length;
  let r = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (logPacket.defined !== want) {
      // the same list again: the DME lost it, or something else replaced it
      if (logPacket.wanted === want) logPacket.resent++;
      logPacket.wanted = want;
      await logPacketDefine(send, values);
      logPacket.defined = want;
    }
    r = await send([0x21, LOG_PACKET_ID]);
    if (!r) throw new Error('the DME did not answer');
    if (r[0] === 0x61 && r[1] === LOG_PACKET_ID && r.length === size) break;
    // forgotten (the DME restarted) or somebody else's: ours again, once
    logPacket.defined = '';
    r = null;
  }
  if (!r) throw new Error('the DME did not send the values back');
  logPacketNoteSlow(Date.now() - startedAt, waited, onWire, telegrams);
  /** @type {Record<string, number|string>} */
  const row = {};
  values.forEach((v, i) => {
    let word = (r[2 + 2 * i] << 8) | r[3 + 2 * i];
    if (v.signed && word >= 0x8000) word -= 0x10000;
    // six significant figures: the scale factors are long decimals
    row[keys[i]] = Number((word * v.mul + v.add).toPrecision(6));
    if (v.unit) row[keys[i].replace(/_WERT$/, '_EINH')] = v.unit;
  });
  return row;
}

/** A round longer than this is a stall worth explaining. */
const LOG_PACKET_SLOW_MS = 400;

/**
 * Keep an account of a round that stalled: how long, and whether the time
 * went waiting for the bus (something else on the page was talking to the
 * car) or out on the wire (the DME answered late, or had to be asked twice).
 * Shown in the summary, so a stutter explains itself.
 * @param {number} totalMs
 * @param {number} waitedMs
 * @param {number} wireMs
 * @param {number} telegrams
 * @returns {void}
 */
function logPacketNoteSlow(totalMs, waitedMs, wireMs, telegrams) {
  if (totalMs < LOG_PACKET_SLOW_MS) return;
  logPacket.slowCount++;
  const sec = (ms) => (ms / 1000).toFixed(1);
  const who = [];
  if (typeof tnLive !== 'undefined' && tnLive.armed) {
    who.push(`live mode on, link ${tnLive.link}`);
    if (tnLive.probe) who.push('link check out');
    if (tnLive.busy) who.push('live busy');
  }
  if (typeof tnCursor !== 'undefined' && tnCursor.m) who.push('table open');
  logPacket.slow =
    `stall ${logPacket.slowCount}: ${sec(totalMs)} s for ${telegrams} telegram${telegrams === 1 ? '' : 's'} ` +
    `(${sec(waitedMs)} s waiting for the bus, ${sec(wireMs)} s on the wire)` +
    (who.length ? ` · ${who.join(', ')}` : '');
}

/**
 * Logging has stopped: the next run defines the packet afresh (something
 * else may have used it in between), and the DME is told to drop it.
 * @returns {Promise<void>}
 */
async function logPacketRelease() {
  const was = logPacket.defined;
  logPacket.defined = '';
  logPacket.active = false;
  logPacket.wanted = '';
  logPacket.resent = 0;
  logPacket.slow = '';
  logPacket.slowCount = 0;
  if (!was || !logPacket.send) return;
  try {
    await logPacket.send([0x2c, LOG_PACKET_ID, 0x04]);
  } catch (e) {
    // the cable went: there is nothing left to tidy
  }
}

// node loads these pieces as modules; the browser gives them one shared scope
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    LOG_PACKET_JOB,
    LOG_PACKET_MAX,
    logPacketKey,
    logPacketRead,
    logPacketRelease,
    logPacket,
  };
}
