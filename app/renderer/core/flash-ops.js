// The flashing operations -- the DME's Flash Tune, Flash Program and reads,
// the transmission's calibration and program writes and reads -- as one
// module with no screen in it: an operation takes prepared images and a few
// facts, runs everything that touches the cable (session, unlock, erase,
// write, record, verify; or the read) and reports stages, progress and log
// lines through callbacks, returning what was read as bytes.
//
// Two callers. The flashing screen runs an operation on its own cable. The
// owner of a shared car runs one for a helper: core/remote.js forwards a
// whole operation (the images once, over the data channel) rather than its
// thousands of jobs, because one round trip per 253-byte segment made a
// remote flash minutes slower. The helper prepares everything (EWS,
// protections, the map switch, the questions, the programming record's
// arguments) exactly as it would locally; only the write moves.
/* exported flashOps, flashOperations */

/** The operations, by the route name the helper asks for. */
const FLASH_OPS = [
  'dme-tune',
  'dme-program',
  'dme-read',
  'dme-maps-read',
  'tcu-cal',
  'tcu-program',
  'tcu-cal-read',
  'tcu-full-read',
];
const FLASH_LABELS = {
  'dme-tune': 'Flash Tune (DME calibration)',
  'dme-program': 'Flash Program (DME)',
  'dme-read': 'Read DME',
  'dme-maps-read': 'Read Installed Maps (DME)',
  'tcu-cal': 'Write Calibration (transmission)',
  'tcu-program': 'Write Program (transmission)',
  'tcu-cal-read': 'Read Calibration (transmission)',
  'tcu-full-read': 'Read Full (transmission)',
};
/** The operations that write to the car; the others only read it. */
const FLASH_WRITES = ['dme-tune', 'dme-program', 'tcu-cal', 'tcu-program'];
/** The transmission's regions, as core/gs20.js and core/gs20-program.js read and write them. */
const FLASH_TCU_CAL_LENGTH = 0x10000;
const FLASH_TCU_PROGRAM_LENGTH = 0x40000;
const FLASH_TCU_FULL_LENGTH = 0x80000;
const FLASH_TCU_AIF_MAX = 256;
/** The biggest payload an owner accepts from a helper (1 MB + 448 KB, base64, with room). */
const FLASH_PAYLOAD_MAX = 4 * 1024 * 1024;

/**
 * @typedef {Object} FlashCallbacks
 * @property {(text: string) => void} [stage] - A new step (the status line).
 * @property {(pct: number, what: string) => void} [progress] - Percent of the block being written.
 * @property {(text: string) => void} [note] - A line for the session log.
 * @property {(name: string, bytes: Uint8Array) => void} [attach] - A file for the session log.
 * @property {(text: string) => void} [trace] - A wire trace line (the transmission's writer).
 */

/**
 * @typedef {Object} FlashResult
 * @property {boolean} ok
 * @property {string} status - What to tell the user.
 * @property {number|null} [aifLeft] - Programming-log entries left, when the transmission wrote one.
 * @property {boolean} [eraseStarted] - Transmission calibration: whether the erase had begun when it failed.
 * @property {number} [erasedSectors] - Transmission program: sectors erased when it failed.
 * @property {boolean} [programWritten] - Transmission program: the program was on, the calibration failed.
 * @property {boolean} [calibrationEraseStarted]
 */

function flashCallbacks(cb) {
  const c = cb || {};
  return {
    stage: c.stage || (() => {}),
    progress: c.progress || (() => {}),
    note: c.note || (() => {}),
    attach: c.attach || (() => {}),
    trace: c.trace || (() => {}),
  };
}

// ---- the DME ----------------------------------------------------------------------------------------
/** The BMW-FAST protocol's session switch before a flash; nothing on the others. */
async function flashDmeEnterFast(diagProtocol) {
  if (diagProtocol !== 'BMW-FAST') return true;
  if (!(await ms45Job('normaler_datenverkehr', 'nein;nein;ja')).ok)
    return false;
  return (await ms45Job('normaler_datenverkehr', 'ja;nein;nein')).ok;
}

/** The DME's programming record, while it is still in programming mode. */
async function flashDmeRecord(aifArgs, c) {
  if (!aifArgs) return;
  c.stage('Writing the programming record (AIF)');
  const r = await ms45WriteAif(aifArgs);
  const outcome = r.ok
    ? `AIF written${r.number ? ` (entry ${r.number})` : ''}`
    : `AIF not written: ${r.status}`;
  c.note(`${outcome} [${aifArgs}]`);
  c.stage(outcome);
}

/**
 * Flash Tune: erase and write the calibration partition, record, verify.
 * @param {{cal: Uint8Array, diagProtocol: string, aifArgs: string|null}} p -
 *   `cal` is the prepared 0x1D000-byte calibration; checksummed and signed here.
 * @param {FlashCallbacks} c
 * @returns {Promise<FlashResult>}
 */
async function flashDmeTune(p, c) {
  if (!p.cal || p.cal.length !== MS45_CAL_LENGTH)
    return { ok: false, status: 'The tune is not a 0x1D000-byte calibration' };
  if (!(await ms45SecurityAccess(p.diagProtocol, c.stage)))
    return { ok: false, status: 'Security Access Denied' };
  if (!(await flashDmeEnterFast(p.diagProtocol)))
    return { ok: false, status: 'The DME refused the programming session' };
  c.stage('Erasing Flash');
  if (!(await ms45Erase(0x2040000, 0x20000)))
    return { ok: false, status: 'Erase failed' };
  let toFlash = ms45Checksums.correctParameterChecksums(p.cal);
  toFlash = ms45Checksums.signParameters(toFlash);
  c.attach('tune_0x40000.bin', toFlash);
  c.stage('Flashing ECU');
  const written = await ms45FlashBlock(toFlash, 0x2040000, 0x205cfff, {
    onStage: c.stage,
    onProgress: (pct) => c.progress(pct, 'Flashing'),
  });
  if (!written) return { ok: false, status: 'Flash failed' };
  // the record goes in while the DME is still in programming mode; the
  // default session refuses the write
  await flashDmeRecord(p.aifArgs, c);
  const ok = await ms45FinishFlash('Daten', true, p.diagProtocol, c.stage);
  return { ok, status: ok ? 'Flash successful' : 'Flash failed' };
}

/**
 * Flash Program: erase and write the external program, the MPC, then the
 * calibration when there is one; record; verify both.
 * @param {{flash: Uint8Array, mpc: Uint8Array, hasCal: boolean, diagProtocol: string, aifArgs: string|null}} p -
 *   `flash` is the prepared 1 MB external image; checksummed and signed here.
 * @param {FlashCallbacks} c
 * @returns {Promise<FlashResult>}
 */
async function flashDmeProgram(p, c) {
  if (!p.flash || p.flash.length !== MS45_FULL_FLASH_LENGTH)
    return { ok: false, status: 'The external image is not 1 MB' };
  if (!p.mpc || p.mpc.length !== MS45_MPC_LENGTH)
    return { ok: false, status: 'The MPC image is not 448 KB' };
  if (!(await ms45SecurityAccess(p.diagProtocol, c.stage)))
    return { ok: false, status: 'Security Access Denied' };
  if (!(await flashDmeEnterFast(p.diagProtocol)))
    return { ok: false, status: 'The DME refused the programming session' };
  let toFlash = ms45Checksums.correctProgramChecksums(p.flash, p.mpc);
  const signedFlash = ms45Checksums.signProgram(toFlash, p.mpc);
  c.attach('external_flash.bin', signedFlash);
  c.attach('mpc_flash.bin', p.mpc);
  toFlash = signedFlash.subarray(
    MS45_PROGRAM_START,
    MS45_PROGRAM_START + 0x9ff40
  );
  const progress = (what) => (pct) => c.progress(pct, what);
  c.note('PHASE: erase program region 0x2060000 block 0xA0000');
  c.stage('Erasing Flash');
  if (!(await ms45Erase(0x2060000, 0xa0000)))
    return { ok: false, status: 'Flash failed' };
  c.note('PHASE: write external program 0x2060000..0x20FFF3F');
  c.stage('Flashing External Program');
  if (
    !(await ms45FlashBlock(toFlash, 0x2060000, 0x20fff3f, {
      onStage: c.stage,
      onProgress: progress('Flashing external'),
    }))
  )
    return { ok: false, status: 'Flash failed' };
  // the program signature spans external + MPC together: an external-only
  // write leaves the program invalid
  c.note('PHASE: write internal MPC 0x0..0x6FFFF (brick-capable step)');
  c.stage('Flashing Internal Program');
  let ok = await ms45FlashBlock(p.mpc, 0, 0x6ffff, {
    onStage: c.stage,
    onProgress: progress('Flashing MPC'),
  });
  if (ok && p.hasCal) {
    let calFlash = Uint8Array.from(
      p.flash.subarray(MS45_CAL_START, MS45_CAL_START + MS45_CAL_LENGTH)
    );
    calFlash = ms45Checksums.signParameters(
      ms45Checksums.correctParameterChecksums(calFlash)
    );
    c.note('PHASE: erase calibration 0x2040000 block 0x20000');
    c.stage('Erasing Calibration');
    ok = await ms45Erase(0x2040000, 0x20000);
    if (ok) {
      c.note('PHASE: write calibration 0x2040000..0x205CFFF');
      c.stage('Flashing Calibration');
      ok = await ms45FlashBlock(calFlash, 0x2040000, 0x205cfff, {
        onStage: c.stage,
        onProgress: progress('Flashing calibration'),
      });
    }
  }
  if (!ok) return { ok: false, status: 'Flash failed' };
  // the record goes in while the DME is still in programming mode (the
  // default session refuses the write), naming the program just written
  await flashDmeRecord(p.aifArgs, c);
  ok = await ms45FinishFlash('Programm', !p.hasCal, p.diagProtocol, c.stage);
  if (ok && p.hasCal)
    ok = await ms45FinishFlash('Daten', true, p.diagProtocol, c.stage);
  return { ok, status: ok ? 'Flash successful' : 'Flash failed' };
}

// ---- the transmission ---------------------------------------------------------------------------------
// core/gs20.js and core/gs20-program.js already run a whole write inside one
// bus lock and throw with the module's state on the error; here that
// becomes a result the other end of a data channel can carry.

/**
 * @param {{calibration: Uint8Array, fast: boolean, aifRecord: Uint8Array|null}} p
 * @param {FlashCallbacks} c
 * @returns {Promise<FlashResult>}
 */
async function flashTcuCal(p, c) {
  if (!p.calibration || p.calibration.length !== FLASH_TCU_CAL_LENGTH)
    return { ok: false, status: 'The calibration is not 64 KB' };
  try {
    const r = await gs20WriteCalibration(p.calibration, {
      confirmed: true,
      fast: !!p.fast,
      aifRecord: p.aifRecord || null,
      onStage: c.stage,
      onTrace: c.trace,
      onProgress: (pct) => c.progress(pct, ''),
    });
    return {
      ok: true,
      status: 'Calibration written',
      eraseStarted: !!r.eraseStarted,
      aifLeft: r.aif ? r.aif.left : null,
    };
  } catch (e) {
    return {
      ok: false,
      status: (e && e.message) || String(e),
      eraseStarted: !!(e && e.eraseStarted),
    };
  }
}

/**
 * @param {{program: Uint8Array, calibration: Uint8Array|null, fast: boolean, aifRecord: Uint8Array|null}} p
 * @param {FlashCallbacks} c
 * @returns {Promise<FlashResult>}
 */
async function flashTcuProgram(p, c) {
  if (!p.program || p.program.length !== FLASH_TCU_PROGRAM_LENGTH)
    return { ok: false, status: 'The program is not 256 KB' };
  if (p.calibration && p.calibration.length !== FLASH_TCU_CAL_LENGTH)
    return { ok: false, status: 'The calibration is not 64 KB' };
  try {
    const r = await gs20WriteProgram(p.program, {
      confirmed: true,
      fast: !!p.fast,
      calibration: p.calibration || null,
      aifRecord: p.aifRecord || null,
      onStage: c.stage,
      onTrace: c.trace,
      onProgress: (pct) => c.progress(pct, ''),
    });
    return {
      ok: true,
      status: p.calibration
        ? 'Program and calibration written'
        : 'Program written',
      aifLeft: r.aif ? r.aif.left : null,
    };
  } catch (e) {
    return {
      ok: false,
      status: (e && e.message) || String(e),
      erasedSectors: (e && e.erasedSectors) || 0,
      programWritten: !!(e && e.programWritten),
      calibrationEraseStarted: !!(e && e.calibrationEraseStarted),
    };
  }
}

// ---- the reads ---------------------------------------------------------------------------------------
/**
 * Read DME: the tune, or the whole external flash and the MPC.
 * @param {{diagProtocol: string, full: boolean}} p
 * @param {FlashCallbacks} c
 * @returns {Promise<FlashResult & {flash?: Uint8Array, mpc?: Uint8Array|null}>}
 */
async function flashDmeRead(p, c) {
  if (
    p.diagProtocol !== 'BMW-FAST' &&
    !(await ms45SecurityAccess(p.diagProtocol, c.stage))
  )
    c.stage('Security Access Denied');
  const progress = (pct) => c.progress(pct, '');
  let flash;
  let mpc = null;
  if (!p.full) {
    c.stage('Reading parameters');
    flash = await ms45ReadMemory(0x40000, 0x5cfff, 'ROMX', {
      onProgress: progress,
    });
  } else {
    c.stage('Reading External Flash');
    flash = await ms45ReadMemory(0x00000, 0xfffff, 'ROMX', {
      onProgress: progress,
    });
    c.stage('Reading Internal Flash');
    mpc = await ms45ReadMemory(0x00000, 0x6ffff, 'LAR', {
      onProgress: progress,
    });
  }
  await ms45LeaveProgrammingMode(p.diagProtocol);
  const wanted = p.full ? MS45_FULL_FLASH_LENGTH : MS45_CAL_LENGTH;
  if (flash.length !== wanted || (mpc && mpc.length !== MS45_MPC_LENGTH))
    return {
      ok: false,
      status: `Read failed: the DME returned ${flash.length} of ${wanted} bytes`,
    };
  return {
    ok: true,
    status: `Read ${p.full ? 'the full flash and MPC' : 'the tune'} (${flash.length} bytes)`,
    flash,
    mpc,
  };
}

/**
 * Read Installed Maps: map 1 and every map the map switch stores beside it,
 * as calibrations -- through the block tables (only the stored blocks are
 * read), or an earlier build's full copy.
 * @param {{diagProtocol: string, layout: 'blocks'|'copy'}} p
 * @param {FlashCallbacks} c
 * @returns {Promise<FlashResult & {map1?: Uint8Array, maps?: Uint8Array[]}>}
 */
async function flashDmeMapsRead(p, c) {
  if (
    p.diagProtocol !== 'BMW-FAST' &&
    !(await ms45SecurityAccess(p.diagProtocol, c.stage))
  )
    c.stage('Security Access Denied');
  const read = async (start, end) => {
    const data = await ms45ReadMemory(start, end, 'ROMX', {
      onProgress: (pct) => c.progress(pct, ''),
    });
    return data.length === end - start + 1 ? data : null;
  };
  const leave = () => ms45LeaveProgrammingMode(p.diagProtocol);
  c.stage('Reading map 1');
  const map1 = await read(
    mapSwitch.CALIBRATION_START,
    mapSwitch.CALIBRATION_START + mapSwitch.CALIBRATION_LENGTH - 1
  );
  if (!map1) {
    await leave();
    return { ok: false, status: 'Read failed. The DME did not return map 1.' };
  }
  const maps = [];
  let failed = false;
  if (p.layout === 'blocks') {
    const area = await read(
      mapSwitch.TABLES_OFFSET,
      mapSwitch.TABLES_OFFSET + mapSwitch.TABLES_LENGTH - 1
    );
    const count = area ? mapSwitch.mapCountFrom(area) : null;
    for (let index = 1; count && index < count && !failed; index++) {
      c.stage(`Reading map ${index + 1}`);
      const chunks = [];
      for (const range of mapSwitch.blockRangesFrom(area, index)) {
        const data = await read(range.start, range.end - 1);
        if (!data) {
          failed = true;
          break;
        }
        chunks.push({ start: range.start, data });
      }
      if (!failed) {
        const cal = mapSwitch.mapFromChunks(map1, area, index, chunks);
        if (cal) maps.push(cal);
        else failed = true;
      }
    }
  } else {
    c.stage('Reading map 2');
    const map2Area = await read(
      mapSwitch.MAP2_START,
      mapSwitch.MAP2_START + mapSwitch.MAP2_LENGTH - 1
    );
    if (!map2Area) failed = true;
    else {
      const map2 = mapSwitch.map2AsCalibration(map2Area);
      if (map2) maps.push(map2);
    }
  }
  await leave();
  if (failed)
    return {
      ok: false,
      status: 'Read failed. The DME did not return every map.',
    };
  return { ok: true, status: `Read map 1 and ${maps.length} more`, map1, maps };
}

/**
 * @param {{fast: boolean}} p
 * @param {FlashCallbacks} c
 * @returns {Promise<FlashResult & {image?: Uint8Array}>}
 */
async function flashTcuCalRead(p, c) {
  try {
    const image = await gs20ReadCalibration({
      fast: !!p.fast,
      onStage: (t) => c.note(t),
      onTrace: c.trace,
      onProgress: (pct) => c.progress(pct, ''),
    });
    return {
      ok: true,
      status: `Read TCU calibration (0x${image.length.toString(16).toUpperCase()} bytes)`,
      image,
    };
  } catch (e) {
    return { ok: false, status: (e && e.message) || String(e) };
  }
}

/**
 * @param {{fast: boolean}} p
 * @param {FlashCallbacks} c
 * @returns {Promise<FlashResult & {image?: Uint8Array}>}
 */
async function flashTcuFullRead(p, c) {
  try {
    const image = await gs20ReadFull({
      fast: !!p.fast,
      onStage: c.stage,
      onTrace: c.trace,
      onProgress: (pct) => c.progress(pct, ''),
    });
    return {
      ok: true,
      status: `Read 0x${image.length.toString(16).toUpperCase()} bytes from 0x080000`,
      image,
    };
  } catch (e) {
    return { ok: false, status: (e && e.message) || String(e) };
  }
}

// ---- the module -------------------------------------------------------------------------------------
function flashToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function flashFromBase64(text) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const flashOps = {
  OPS: FLASH_OPS,
  /** @param {string} op @returns {string} */
  label(op) {
    return FLASH_LABELS[op] || op;
  },
  /** Whether an operation writes to the car. @param {string} op @returns {boolean} */
  writes(op) {
    return FLASH_WRITES.includes(op);
  },

  /**
   * Run an operation on this machine's cable.
   * @param {string} op - One of OPS.
   * @param {object} p - The payload the operation takes (see the functions above).
   * @param {FlashCallbacks} [cb]
   * @returns {Promise<FlashResult>}
   */
  async run(op, p, cb) {
    // Hold the Web Lock and the screen Wake Lock for the whole operation
    // (core/flasher.js's _runWithHold, which the DME read already used):
    // a tab that is not in front has its wake-ups throttled, and a flash is
    // a long run of telegrams each with a ~500 ms answer budget, so the
    // first throttled wake-up past that budget read as a silent ECU and
    // ended the flash at a random block. Browsers without the API run
    // directly, as before.
    const hold =
      typeof _runWithHold === 'function' ? _runWithHold : async (fn) => fn();
    return hold(() => flashOps._run(op, p, cb));
  },
  async _run(op, p, cb) {
    const c = flashCallbacks(cb);
    switch (op) {
      case 'dme-tune':
        return flashDmeTune(p, c);
      case 'dme-program':
        return flashDmeProgram(p, c);
      case 'tcu-cal':
        return flashTcuCal(p, c);
      case 'tcu-program':
        return flashTcuProgram(p, c);
      case 'dme-read':
        return flashDmeRead(p, c);
      case 'dme-maps-read':
        return flashDmeMapsRead(p, c);
      case 'tcu-cal-read':
        return flashTcuCalRead(p, c);
      case 'tcu-full-read':
        return flashTcuFullRead(p, c);
      default:
        return { ok: false, status: `unknown flashing operation: ${op}` };
    }
  },

  /**
   * A payload as JSON text for the data channel: bytes as base64, the rest as is.
   * @param {object} p
   * @returns {string}
   */
  encode(p) {
    const out = {};
    for (const [k, v] of Object.entries(p))
      out[k] = v instanceof Uint8Array ? flashToBase64(v) : v;
    return JSON.stringify(out);
  },

  /**
   * A result for the data channel: every Uint8Array (or array of them)
   * becomes base64, named in `_bytes` so decodeResult gives bytes back.
   * @param {object} r
   * @returns {object}
   */
  encodeResult(r) {
    const out = { _bytes: [] };
    for (const [k, v] of Object.entries(r || {})) {
      if (v instanceof Uint8Array) {
        out[k] = flashToBase64(v);
        out._bytes.push(k);
      } else if (Array.isArray(v) && v.every((x) => x instanceof Uint8Array)) {
        out[k] = v.map(flashToBase64);
        out._bytes.push(k);
      } else out[k] = v;
    }
    return out;
  },
  /**
   * The result back from the channel, its bytes as bytes again. Sizes are
   * bounded: the biggest read is the DME's 1 MB + 448 KB.
   * @param {object} b
   * @returns {object}
   */
  decodeResult(b) {
    const out = {};
    const marked = Array.isArray(b && b._bytes) ? b._bytes.map(String) : [];
    for (const [k, v] of Object.entries(b || {})) {
      if (k === '_bytes') continue;
      if (!marked.includes(k)) {
        out[k] = v;
        continue;
      }
      const one = (t) => {
        if (typeof t !== 'string' || t.length > FLASH_PAYLOAD_MAX)
          throw new Error(`${k}: not bytes the channel can carry`);
        return flashFromBase64(t);
      };
      out[k] = Array.isArray(v) ? v.slice(0, 8).map(one) : one(v);
    }
    return out;
  },

  /**
   * The payload back from its JSON text, checked to the shape the operation
   * takes (a helper's text is DATA); anything else is refused.
   * @param {string} op
   * @param {string} text
   * @returns {object}
   */
  decode(op, text) {
    if (typeof text !== 'string' || text.length > FLASH_PAYLOAD_MAX)
      throw new Error('the flashing payload is missing or too large');
    const raw = JSON.parse(text);
    const str = (k, max = 200) =>
      raw[k] == null ? null : String(raw[k]).slice(0, max);
    const bytes = (k, length) => {
      const b = flashFromBase64(String(raw[k] || ''));
      if (b.length !== length)
        throw new Error(`${k}: expected ${length} bytes, got ${b.length}`);
      return b;
    };
    const bytesOpt = (k, max) => {
      if (raw[k] == null || raw[k] === '') return null;
      const b = flashFromBase64(String(raw[k]));
      if (!b.length || b.length > max)
        throw new Error(`${k}: ${b.length} bytes is not a record`);
      return b;
    };
    const common = {
      describe: str('describe', 160) || '',
      vin: str('vin', 17) || '',
      hwRef: str('hwRef', 12) || '',
    };
    switch (op) {
      case 'dme-tune':
        return {
          ...common,
          cal: bytes('cal', MS45_CAL_LENGTH),
          diagProtocol: str('diagProtocol', 20) || '',
          aifArgs: str('aifArgs', 200),
        };
      case 'dme-program':
        return {
          ...common,
          flash: bytes('flash', MS45_FULL_FLASH_LENGTH),
          mpc: bytes('mpc', MS45_MPC_LENGTH),
          hasCal: !!raw.hasCal,
          diagProtocol: str('diagProtocol', 20) || '',
          aifArgs: str('aifArgs', 200),
        };
      case 'tcu-cal':
        return {
          ...common,
          calibration: bytes('calibration', FLASH_TCU_CAL_LENGTH),
          fast: !!raw.fast,
          aifRecord: bytesOpt('aifRecord', FLASH_TCU_AIF_MAX),
        };
      case 'tcu-program':
        return {
          ...common,
          program: bytes('program', FLASH_TCU_PROGRAM_LENGTH),
          calibration:
            raw.calibration == null || raw.calibration === ''
              ? null
              : bytes('calibration', FLASH_TCU_CAL_LENGTH),
          fast: !!raw.fast,
          aifRecord: bytesOpt('aifRecord', FLASH_TCU_AIF_MAX),
        };
      case 'dme-read':
        return {
          ...common,
          diagProtocol: str('diagProtocol', 20) || '',
          full: !!raw.full,
        };
      case 'dme-maps-read':
        return {
          ...common,
          diagProtocol: str('diagProtocol', 20) || '',
          layout: raw.layout === 'copy' ? 'copy' : 'blocks',
        };
      case 'tcu-cal-read':
      case 'tcu-full-read':
        return { ...common, fast: !!raw.fast };
      default:
        throw new Error(`unknown flashing operation: ${op}`);
    }
  },
};

// ---- the owner's side of a shared car ----------------------------------------------------------
// core/remote.js hands a `/api/flash/<op>` request here after the owner has
// approved it. The operation runs on this machine's cable with its own
// session log, so the owner keeps a record of what was written to their car,
// and reports stages, progress and log lines back as they happen.
let flashRemoteBusy = false;

/**
 * @type {Object<string, {label: string, write: boolean, describe: (text: string) => string, run: (text: string, cb: FlashCallbacks) => Promise<object>}>}
 *   `run` resolves with the result as encodeResult gives it, ready for the channel.
 */
const flashOperations = {};
for (const op of FLASH_OPS) {
  flashOperations[op] = {
    label: FLASH_LABELS[op],
    write: FLASH_WRITES.includes(op),
    /** What the helper asks to write, for the owner's prompt; throws on a payload that is not one. */
    describe(text) {
      const p = flashOps.decode(op, text);
      return p.describe || FLASH_LABELS[op];
    },
    async run(text, cb) {
      if (flashRemoteBusy)
        return { ok: false, status: 'another flashing operation is running' };
      flashRemoteBusy = true;
      const p = flashOps.decode(op, text);
      const c = flashCallbacks(cb);
      const log = typeof flashLog !== 'undefined' ? flashLog : null;
      try {
        if (log) {
          await log.start(`remote-${op}`, {
            vin: p.vin,
            module: p.hwRef || (op.startsWith('tcu') ? 'GS20' : ''),
          });
          log.note(
            `Run for a remote helper: ${p.describe || FLASH_LABELS[op]}`
          );
          ms45SetJobTrace((job, arg, status, tx, rx) =>
            log.job(job, arg, status, tx, rx)
          );
        }
        const r = await flashOps.run(op, p, {
          stage: c.stage,
          progress: c.progress,
          note: (t) => {
            if (log) log.note(t);
            c.note(t);
          },
          attach: (name, bytes) => {
            if (log) log.attach(name, bytes);
          },
          trace: (t) => {
            if (log) log.trace(t);
          },
        });
        if (log) log.note(`Result: ${r.status}`);
        return flashOps.encodeResult(r);
      } finally {
        flashRemoteBusy = false;
        if (log) {
          ms45SetJobTrace(null);
          await log.stop();
        }
      }
    },
  };
}

if (typeof window !== 'undefined') {
  window.flashOps = flashOps;
  window.flashOperations = flashOperations;
}
if (typeof module !== 'undefined' && module.exports)
  module.exports = { flashOps, flashOperations };
