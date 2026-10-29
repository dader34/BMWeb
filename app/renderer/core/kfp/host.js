/**
 * @file WebKFP's CDH host: what BMW's flash programming scripts (the PABDs
 * WinKFP runs, 10GD20.IPO for the GS20 and 12MDS451.IPO for the MS45) call
 * into while they program a module. Published as the `KfpHostApi` global.
 *
 * It is the coding host (core/coding/dispatch-host.js) -- parameter stores,
 * BinBufs, the EDIABAS calls -- with what flashing adds:
 *
 *   - the data pump. CDHGetApiJobByteData deals the flash file out in blocks
 *     of at most MaxData bytes at consecutive addresses, into WinKFP's
 *     buffer: byte 0 = 1, 1..3 the data organisation, 13..16 the byte count
 *     and 17..20 the address (both 32-bit little-endian; the MS45 script
 *     reads them back four bytes at a time), the data from 21, then 03.
 *     CDHResetApiJobData starts it over: the MS45 script reads the whole
 *     file once to find its segments before it erases anything.
 *   - CDHDelay and the timers, on the caller's clock.
 *   - the key. CDHAuthGetRandom makes the user id, CDHCallAuthenticate asks
 *     the caller's `authenticate` for the key to the module's seed; a type
 *     it cannot answer comes back as a failed retVal, which the script
 *     reports.
 *   - a job that fails on the wire does not stop the run: it answers with
 *     that error as its JOB_STATUS, the way EDIABAS hands WinKFP a failed
 *     job, so the script's own check sees it -- and the MS45 script's
 *     resume after a communication error can run.
 *
 * Every job goes through the caller's runJob, which owns the cable and the
 * write gate; this host never decides on its own to write.
 *
 * app/renderer/core/*.js style: browser global, no imports; dual-exported for
 * require() so a headless test can drive it.
 */

/**
 * The caller's key maker, for the module's seed.
 * @callback KfpAuthenticate
 * @param {{family: string, type: string, level: string, userId: Uint8Array,
 *   seed: Uint8Array, serialAnswer: Uint8Array}} req - The script's
 *   request: the module family, the authentication type and level, the user
 *   id this host made, the module's seed, and the module's last
 *   SERIENNUMMER_LESEN answer telegram.
 * @returns {Promise<Uint8Array|null>|Uint8Array|null} The key, or null.
 */

/**
 * One job the script ran, for the session log.
 * @typedef {Object} KfpJobEntry
 * @property {string} job - The job name.
 * @property {string} arg - What it was given ('<n bytes>' for a buffer).
 * @property {string} status - Its JOB_STATUS.
 * @property {string} [error] - The wire error, when it failed there.
 */

/**
 * One error the script recorded (CDHSetError): WinKFP's COAPI error list.
 * @typedef {Object} KfpError
 * @property {number} code - The COAPI error number (2082 Clear flash failed...).
 * @property {string} file - The script part that recorded it (07FLASH).
 * @property {string} proc - Its procedure.
 * @property {number} line - Its line.
 * @property {string} info - What failed ("FLASH_LOESCHEN (...): ERROR_...").
 */

(function (root) {
  'use strict';

  const Host =
    typeof module !== 'undefined' && module.exports
      ? require('../coding/dispatch-host.js')
      : root.CodingDispatchHost;
  const {
    CdhHost,
    asInt,
    asStr,
    makeBinBuf,
    binWriteByte,
    binToBytes,
    bytesToArgString,
  } = Host;

  /** Where the data starts in a block buffer, and the byte after it. */
  const BLOCK_DATA = 21;
  const BLOCK_END = 0x03;
  /** The buffer's byte count and address fields. */
  const BLOCK_COUNT = 13;
  const BLOCK_ADDR = 17;
  /** The jobs that carry flash data: what progress counts. */
  const DATA_JOB = /^FLASH_SCHREIBEN$/i;

  /**
   * Write a 32-bit little-endian value into a buffer.
   * @param {object} buf - The BinBuf.
   * @param {number} at - Its first byte.
   * @param {number} v - The value.
   * @returns {void}
   */
  function put32(buf, at, v) {
    for (let k = 0; k < 4; k++)
      binWriteByte(buf, at + k, (v >>> (8 * k)) & 0xff);
  }

  /** The PC text files the scripts keep, by upper-case name. */
  const PC_FILES = new Map();
  /** The browser storage key prefix for them. */
  const PC_FILE_KEY = 'bmweb.kfp.file.';
  /**
   * @param {string} key - The file.
   * @returns {string[]} its lines.
   */
  function pcFileGet(key) {
    if (PC_FILES.has(key)) return PC_FILES.get(key);
    try {
      const v =
        typeof localStorage !== 'undefined'
          ? localStorage.getItem(PC_FILE_KEY + key)
          : null;
      if (v != null) return JSON.parse(v);
    } catch {
      /* no storage: the page's copy is all there is */
    }
    return [];
  }
  /**
   * @param {string} key - The file.
   * @param {string[]} lines - Its lines.
   * @returns {void}
   */
  function pcFileSet(key, lines) {
    PC_FILES.set(key, lines);
    try {
      if (typeof localStorage !== 'undefined')
        localStorage.setItem(PC_FILE_KEY + key, JSON.stringify(lines));
    } catch {
      /* no storage */
    }
  }

  /**
   * EDIABAS's number for a wire error: IFH-00nn is 10 + nn; anything else on
   * the wire (the cable gone) is IFH-0000, 10.
   * @param {unknown} e - The error.
   * @returns {number}
   */
  function ediabasErrorCode(e) {
    const ifh = /IFH-(\d{4})/.exec(
      String(
        (e && /** @type {any} */ (e).ifh) ||
          (e && /** @type {any} */ (e).message) ||
          ''
      )
    );
    return ifh ? 10 + parseInt(ifh[1], 10) : 10;
  }

  class KfpHost extends CdhHost {
    /**
     * @param {Object} opts
     * @param {string} opts.sgbd - The programming SGBD (10gd20, 10mds45).
     * @param {Function} opts.runJob - (sgbd, job, argText, {binary}) -> sets.
     * @param {string} [opts.address] - The module's diagnostic address, hex
     *   ('23'): run.js hands it to the script's SET_ECU_ADDRESS.
     * @param {{address: number, bytes: Uint8Array}[]} [opts.runs] - The
     *   flash file's runs (kfpDaten.runs), for a programming job.
     * @param {Record<string, string|number>} [opts.params] - What WinKFP
     *   sets before the job: PROG_MODE, SCHNELLE_BAUDRATE, the AIF fields...
     * @param {KfpAuthenticate} [opts.authenticate] - The key maker.
     * @param {(ms: number) => Promise<void>} [opts.sleep] - CDHDelay's clock.
     * @param {() => number} [opts.now] - The timers' clock, in ms.
     * @param {(e: KfpJobEntry) => void} [opts.onJob] - Each job, as it ends.
     * @param {(sent: number, total: number) => void} [opts.onProgress] -
     *   Flash data bytes sent so far.
     * @param {(bytes: Uint8Array) => Uint8Array} [opts.random] - Fills a
     *   user id (crypto.getRandomValues by default).
     */
    constructor(opts) {
      super({ sgbd: opts.sgbd, runJob: opts.runJob, mode: 'write' });
      this.allowWrites = true;
      for (const [k, v] of Object.entries(opts.params || {}))
        this.cabdPar.set(k, typeof v === 'number' ? v : String(v));
      /** @type {{address: number, bytes: Uint8Array}[]} */
      this.runs = opts.runs || [];
      this.dataTotal = this.runs.reduce((n, r) => n + r.bytes.length, 0);
      this.dataSent = 0;
      this._run = 0;
      this._offset = 0;
      this._authenticate = opts.authenticate || null;
      this._sleep =
        opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
      this._now = opts.now || (() => Date.now());
      this._onJob = opts.onJob || (() => {});
      this._onProgress = opts.onProgress || (() => {});
      this._random =
        opts.random ||
        ((b) =>
          (globalThis.crypto || require('crypto').webcrypto).getRandomValues(
            b
          ));
      /** @type {Map<number, number>} timer number -> deadline */
      this._timers = new Map();
      this._userId = new Uint8Array(0);
      this._serialAnswer = new Uint8Array(0);
      this._apiError = '';
      this._apiErrorCode = 0;
      /** @type {{key: string, mode: string, pos: number}|null} the open file */
      this._file = null;
      /** @type {KfpError[]} every CDHSetError, in order */
      this.errors = [];
    }

    /**
     * Record an error, and keep it: WinKFP lists every one the script set.
     * @param {unknown} errNr - The COAPI error number.
     * @param {unknown} [file] - The script part.
     * @param {unknown} [proc] - The procedure.
     * @param {unknown} [line] - The line.
     * @param {unknown} [info] - What failed.
     * @returns {void}
     */
    CDHSetError(errNr, file, proc, line, info) {
      super.CDHSetError(errNr, file, proc, line, info);
      this.errors.push({
        code: asInt(errNr),
        file: asStr(file),
        proc: asStr(proc),
        line: asInt(line),
        info: asStr(info),
      });
    }

    /** @returns {Record<string, string|number>} the parameter store, as the script left it. */
    params() {
      return Object.fromEntries(this.cabdPar);
    }

    // --- the data pump ------------------------------------------------------
    /** Start the file over. @returns {void} */
    CDHResetApiJobData() {
      this._run = 0;
      this._offset = 0;
    }
    /**
     * Deal the next block into a buffer.
     * @param {unknown} maxData - The script's limit, in bytes.
     * @param {unknown} bufHandle - The BinBuf to build it in.
     * @returns {{bufSize: number, nrOfData: number, retVal: number}} The
     *   buffer's length and the data bytes in it; 0 and 0 at the end of the
     *   file.
     */
    CDHGetApiJobByteData(maxData, bufHandle) {
      const buf = this.bufs.get(asInt(bufHandle));
      if (!buf) return { bufSize: 0, nrOfData: 0, retVal: 1 };
      while (
        this._run < this.runs.length &&
        this._offset >= this.runs[this._run].bytes.length
      ) {
        this._run++;
        this._offset = 0;
      }
      if (this._run >= this.runs.length)
        return { bufSize: 0, nrOfData: 0, retVal: 0 };
      const run = this.runs[this._run];
      const n = Math.min(
        Math.max(1, asInt(maxData)),
        run.bytes.length - this._offset
      );
      const fresh = makeBinBuf();
      buf.bytes = fresh.bytes;
      buf.size = fresh.size;
      for (let k = 0; k < BLOCK_DATA; k++) binWriteByte(buf, k, 0);
      binWriteByte(buf, 0, 1);
      binWriteByte(buf, 1, this.wortBreite);
      binWriteByte(buf, 2, this.byteFolge);
      binWriteByte(buf, 3, this.adrMode);
      put32(buf, BLOCK_COUNT, n);
      put32(buf, BLOCK_ADDR, run.address + this._offset);
      for (let k = 0; k < n; k++)
        binWriteByte(buf, BLOCK_DATA + k, run.bytes[this._offset + k]);
      binWriteByte(buf, BLOCK_DATA + n, BLOCK_END);
      this._pumped = { handle: asInt(bufHandle), n };
      this._offset += n;
      return { bufSize: BLOCK_DATA + n + 1, nrOfData: n, retVal: 0 };
    }

    // --- time -----------------------------------------------------------------
    /**
     * @param {unknown} ms - How long.
     * @returns {Promise<void>}
     */
    async CDHDelay(ms) {
      await this._sleep(Math.max(0, asInt(ms)));
    }
    /**
     * @param {unknown} n - The timer.
     * @param {unknown} ms - When it expires, from now.
     * @returns {void}
     */
    settimer(n, ms) {
      this._timers.set(asInt(n), this._now() + Math.max(0, asInt(ms)));
    }
    /**
     * @param {unknown} n - The timer.
     * @returns {number} 1 once it has expired (a timer never set has).
     */
    testtimer(n) {
      const at = this._timers.get(asInt(n));
      return at == null || this._now() >= at ? 1 : 0;
    }

    // --- EDIABAS --------------------------------------------------------------
    /**
     * Run a job; a failure on the wire becomes its JOB_STATUS.
     * @param {string} sg - The SGBD.
     * @param {string} name - The job.
     * @param {string} argText - Its argument.
     * @param {boolean} binary - Whether the argument is a buffer.
     * @returns {Promise<void>}
     */
    async _job(sg, name, argText, binary) {
      let error = '';
      try {
        this.lastSets =
          (await this.runJob(sg, name, argText, {
            allowWrites: true,
            binary,
          })) || [];
        this._apiError = '';
        this._apiErrorCode = 0;
      } catch (e) {
        error = (e && e.message) || String(e);
        this._apiError = error;
        this._apiErrorCode = ediabasErrorCode(e);
        this.lastSets = [{ JOB_STATUS: `ERROR: ${error}` }];
      }
      if (/^SERIENNUMMER_LESEN$/i.test(name)) {
        const tel = this._result('_TEL_ANTWORT', 1);
        this._serialAnswer = tel == null ? new Uint8Array(0) : toBytes(tel);
      }
      const status = asStr(this._result('JOB_STATUS', 1));
      this.log.push({ job: name, sgbd: sg, kind: binary ? 'data' : 'text' });
      this._onJob({
        job: name,
        arg: binary ? `<${argText.length} bytes>` : argText,
        status,
        ...(error ? { error } : {}),
      });
    }
    /**
     * @param {unknown} ecu - Module ('' = the programming SGBD).
     * @param {unknown} job - Job name.
     * @param {unknown} para - Argument text.
     * @returns {Promise<number>} 0.
     */
    async CDHapiJob(ecu, job, para) {
      await this._job(asStr(ecu) || this.sgbd, asStr(job), asStr(para), false);
      return 0;
    }
    /**
     * @param {unknown} ecu - Module ('' = the programming SGBD).
     * @param {unknown} job - Job name.
     * @param {unknown} bufHandle - The BinBuf to send.
     * @param {unknown} _bufSize - The script's size, which WinKFP ignores:
     *   its CDHapiJobData sends the whole buffer as far as it was written
     *   (winkfpt.exe FUN_004637a0 -> CDHBinBufRead). The scripts pass 21+len
     *   for NG_AUTHENTISIERUNG_START, short of the 03 they write at 21+len,
     *   and the SGBD wants that 03 (length 22+len, else ERROR_BIN_BUFFER).
     * @returns {Promise<number>} 0.
     */
    async CDHapiJobData(ecu, job, bufHandle, _bufSize) {
      const buf = this.bufs.get(asInt(bufHandle));
      const bytes = buf ? binToBytes(buf) : [];
      const name = asStr(job);
      // 12MDS451 pumps the first block, writes the erase length over its
      // byte count (bytes 13..16) to send FLASH_LOESCHEN, and then sends the
      // same buffer as the first FLASH_SCHREIBEN. The SGBD takes the count
      // from bytes 13..14 and refuses a buffer that is not count + 22 long
      // (ERROR_BIN_BUFFER), so the block's own count goes back in; its data
      // and address are as pumped.
      const pumped = this._pumped;
      if (
        DATA_JOB.test(name) &&
        pumped &&
        pumped.handle === asInt(bufHandle) &&
        bytes.length === BLOCK_DATA + pumped.n + 1 &&
        bytes[BLOCK_DATA + pumped.n] === BLOCK_END &&
        (bytes[BLOCK_COUNT] | (bytes[BLOCK_COUNT + 1] << 8)) !== pumped.n
      ) {
        for (let k = 0; k < 4; k++)
          bytes[BLOCK_COUNT + k] = (pumped.n >>> (8 * k)) & 0xff;
        this._onJob({
          job: name,
          arg: `<${bytes.length} bytes>`,
          status: `byte count restored to ${pumped.n} (the erase had reused the block's buffer)`,
        });
      }
      await this._job(
        asStr(ecu) || this.sgbd,
        name,
        bytesToArgString(bytes),
        true
      );
      if (
        DATA_JOB.test(name) &&
        /^OKAY$/i.test(asStr(this._result('JOB_STATUS', 1)))
      ) {
        const n =
          bytes.length > BLOCK_COUNT + 3
            ? (bytes[BLOCK_COUNT] |
                (bytes[BLOCK_COUNT + 1] << 8) |
                (bytes[BLOCK_COUNT + 2] << 16)) >>>
              0
            : 0;
        this.dataSent = Math.min(this.dataTotal, this.dataSent + n);
        this._onProgress(this.dataSent, this.dataTotal);
      }
      return 0;
    }
    /**
     * The 1:1 EDIABAS result call: no CDH error handling.
     * @param {unknown} res - Result name.
     * @param {unknown} set - 1-based set.
     * @returns {{rc: number, text: string}}
     */
    apiResultText(res, set) {
      const v = this._result(res, set);
      return { rc: v == null ? 0 : 1, text: v == null ? '' : asStr(v) };
    }
    /** @returns {string} the last job's wire error, '' when it had none. */
    apiErrorText() {
      return this._apiError;
    }
    /**
     * EDIABAS's own number for the last job's wire error, 0 when it had
     * none: IFH-00nn is 10 + nn (IFH-0009, no answer, is 19, the one the
     * scripts' TestApiFehler tells apart). A job that answered with a
     * non-OKAY JOB_STATUS is not an API error, as in EDIABAS.
     * @returns {number}
     */
    apiErrorCode() {
      return this._apiErrorCode | 0;
    }
    /**
     * The 1:1 EDIABAS job call (newer PABDs run some jobs through it rather
     * than CDHapiJob): the same job, the same failure handling.
     * @param {unknown} ecu - Module ('' = the programming SGBD).
     * @param {unknown} job - Job name.
     * @param {unknown} para - Argument text.
     * @returns {Promise<void>}
     */
    async apiJob(ecu, job, para) {
      await this._job(asStr(ecu) || this.sgbd, asStr(job), asStr(para), false);
    }
    /**
     * The 1:1 EDIABAS result call, as an integer.
     * @param {unknown} res - Result name.
     * @param {unknown} set - 1-based set.
     * @returns {{rc: number, value: number}}
     */
    apiResultInt(res, set) {
      const v = this._result(res, set);
      if (v == null) return { rc: 0, value: 0 };
      return { rc: 1, value: typeof v === 'number' ? v | 0 : asInt(asStr(v)) };
    }

    // --- the PC's text files ----------------------------------------------------
    // WinKFP lets a script keep a text file next to it; the diesel PABDs park a
    // value in WerteDDE.txt during programming and read it back later in the
    // run. Here a file lives for the page (and, best effort, in the browser's
    // storage, so a run resumed after a reload finds it as WinKFP would).
    /**
     * @param {unknown} name - The file.
     * @param {unknown} mode - 'w' (start empty), 'a' (append) or 'r'.
     * @returns {void}
     */
    fileopen(name, mode) {
      const key = asStr(name).toUpperCase();
      const m = asStr(mode).toLowerCase();
      if (m.startsWith('w')) pcFileSet(key, []);
      this._file = { key, mode: m, pos: 0 };
    }
    /** @returns {void} */
    fileclose() {
      this._file = null;
    }
    /**
     * @param {unknown} line - One line.
     * @returns {void}
     */
    filewrite(line) {
      const f = this._file;
      if (!f || f.mode.startsWith('r')) return;
      pcFileSet(f.key, [...pcFileGet(f.key), asStr(line)]);
    }
    /**
     * @returns {{line: string, eof: number}} the next line; eof 1 when there
     *   was none left to read.
     */
    fileread() {
      const f = this._file;
      const lines = f ? pcFileGet(f.key) : [];
      if (!f || f.pos >= lines.length) return { line: '', eof: 1 };
      return { line: lines[f.pos++], eof: 0 };
    }

    // --- authentication -------------------------------------------------------
    /** @returns {{rndBin: string, rndAsc: string}} a new user id. */
    CDHAuthGetRandom() {
      this._userId = this._random(new Uint8Array(4));
      return {
        rndBin: bytesToArgString(Array.from(this._userId)),
        rndAsc:
          '0x' +
          Array.from(this._userId, (b) => b.toString(16).padStart(2, '0'))
            .join('')
            .toUpperCase(),
      };
    }
    /**
     * The key to the module's seed, into the response buffer.
     * @param {unknown} family - SgFamilie.
     * @param {unknown} userId - The user id (this host's own is used).
     * @param {unknown} stgId - The module id text (the serial answer is used).
     * @param {unknown} type - Asymetrisch, Symetrisch, Simple.
     * @param {unknown} seedHandle - The BinBuf holding the seed.
     * @param {unknown} level - The authentication level.
     * @param {unknown} responseHandle - The BinBuf for the key.
     * @returns {Promise<{responseLen: number, retVal: number}>}
     */
    async CDHCallAuthenticate(
      family,
      userId,
      stgId,
      type,
      seedHandle,
      level,
      responseHandle
    ) {
      const seedBuf = this.bufs.get(asInt(seedHandle));
      const out = this.bufs.get(asInt(responseHandle));
      if (!this._authenticate || !seedBuf || !out)
        return { responseLen: 0, retVal: 1 };
      let key;
      try {
        key = await this._authenticate({
          family: asStr(family),
          type: asStr(type),
          level: asStr(level),
          userId: this._userId,
          seed: Uint8Array.from(binToBytes(seedBuf)),
          serialAnswer: this._serialAnswer,
        });
      } catch (e) {
        this.errInfo = `no key: ${(e && e.message) || e}`;
        key = null;
      }
      if (!key || !key.length) return { responseLen: 0, retVal: 1 };
      const fresh = makeBinBuf();
      out.bytes = fresh.bytes;
      out.size = fresh.size;
      key.forEach((b, k) => binWriteByte(out, k, b));
      return { responseLen: key.length, retVal: 0 };
    }
  }

  /**
   * A result value as bytes: a byte array, or the dashed or plain hex text a
   * job result is shown in.
   * @param {unknown} v - The value.
   * @returns {Uint8Array}
   */
  function toBytes(v) {
    if (v && typeof v === 'object' && typeof v.length === 'number')
      return Uint8Array.from(
        /** @type {ArrayLike<number>} */ (v),
        (b) => b & 0xff
      );
    const hex = asStr(v).replace(/[^0-9a-fA-F]/g, '');
    const out = new Uint8Array(hex.length >> 1);
    for (let i = 0; i < out.length; i++)
      out[i] = parseInt(hex.substr(2 * i, 2), 16);
    return out;
  }

  const api = { KfpHost, BLOCK_DATA, BLOCK_COUNT, BLOCK_ADDR };
  if (typeof root !== 'undefined') root.KfpHostApi = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
