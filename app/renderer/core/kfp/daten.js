/**
 * @file WebKFP's reading of BMW's SP-Daten for one module: the ZB table that
 * says which program and data file make up each assembly number (the
 * module's .DAT), and the flash files themselves (.0PA program, .0DA data).
 * Published as the `kfpDaten` global.
 *
 * A flash file is Intel HEX with BMW's comment header: data records (type 00,
 * and type 10 for the last bytes of each 64 KB page, which carry data like
 * any other), a linear base (04) and a segment base (02) that add up, and an
 * end record. WinKFP hands the file to the programming script as a stream
 * of blocks at the file's own addresses; `blocks` does the same. The address
 * is the module's, unchanged: the SGBD maps it onto the telegram (the MS45's
 * internal flash at 0 goes out as 06 00 00 00).
 *
 * The ZB table is the .DAT's comma rows under ";ZB-NR TYP-NR HW-NR IX SW-NR
 * ...". The program file is named by the hardware number and index
 * (7561382A.0PA); the data file by the software number with a letter in
 * front that varies by module (P7561533.0DA for the MS45, A7504696.0DA for
 * the GS20), so it is found by its number.
 *
 * app/renderer/core/*.js style: browser global, no imports; dual-exported for
 * require() so a headless test can drive it.
 */

/**
 * One data record, at the module's address.
 * @typedef {Object} KfpRecord
 * @property {number} address - Where its first byte goes.
 * @property {Uint8Array} bytes - Its data.
 */

/**
 * A parsed flash file.
 * @typedef {Object} KfpFile
 * @property {string|null} reference - The $REFERENZ header line's value.
 * @property {KfpRecord[]} records - Data records in file order, empty ones left out.
 */

/**
 * One row of a module's ZB table.
 * @typedef {Object} KfpZbRow
 * @property {string} zb - The assembly (ZB) number.
 * @property {string} hw - The hardware number the program file is named by.
 * @property {string} ix - The hardware index.
 * @property {string} typ - TYP-NR, the record's approval number.
 * @property {string} sw - The software number the data file is named by ('' when none).
 * @property {string} swIndex - What follows it in the table ("DA" of
 *   "7561533DA"): the change index WinKFP writes into the programming record.
 */

(function (root) {
  'use strict';

  /**
   * Parse a .0PA / .0DA file.
   * @param {string} text - The file's text.
   * @returns {KfpFile}
   * @throws {Error} On a malformed record, a bad checksum, an unknown record
   *   type, no data, or no end record.
   */
  function parseFile(text) {
    if (text == null) throw new Error('no file text');
    const out = { reference: null, records: [] };
    let linear = 0;
    let segment = 0;
    let ended = false;
    let lineNumber = 0;
    for (const raw of String(text).split(/\r?\n/)) {
      lineNumber++;
      const line = raw.trim();
      if (!line) continue;
      if (line[0] === '$') {
        const parts = line.split(/\s+/);
        if (parts[0] === '$REFERENZ' && parts.length >= 2)
          out.reference = parts[1];
        continue;
      }
      if (line[0] !== ':') continue;
      if (ended)
        throw new Error(`line ${lineNumber}: data after the end record`);
      const hex = line.slice(1);
      if (hex.length < 10 || hex.length % 2 || !/^[0-9a-fA-F]+$/.test(hex))
        throw new Error(`line ${lineNumber}: not a well-formed record`);
      const record = new Uint8Array(hex.length / 2);
      for (let i = 0; i < record.length; i++)
        record[i] = parseInt(hex.substr(2 * i, 2), 16);
      if (record[0] + 5 !== record.length)
        throw new Error(`line ${lineNumber}: record length does not match`);
      let sum = 0;
      for (const b of record) sum += b;
      if (sum & 0xff)
        throw new Error(`line ${lineNumber}: record checksum is wrong`);
      const count = record[0];
      const offset = (record[1] << 8) | record[2];
      switch (record[3]) {
        case 0x00:
        case 0x10:
          // the linear and segment bases add up and neither clears the other:
          // the MS45's data file sets the segment (4000) before the linear
          // base (0200) for its calibration at 0x2040000
          if (count)
            out.records.push({
              address: linear + segment + offset,
              bytes: record.slice(4, 4 + count),
            });
          break;
        case 0x01:
          ended = true;
          break;
        case 0x02:
          if (count !== 2)
            throw new Error(`line ${lineNumber}: bad segment record`);
          segment = ((record[4] << 8) | record[5]) << 4;
          break;
        case 0x04:
          if (count !== 2)
            throw new Error(`line ${lineNumber}: bad linear address record`);
          linear = ((record[4] << 8) | record[5]) * 0x10000;
          break;
        default:
          throw new Error(
            `line ${lineNumber}: unknown record type 0x${record[3].toString(16).toUpperCase().padStart(2, '0')}`
          );
      }
    }
    if (!out.records.length) throw new Error('the file has no data records');
    if (!ended) throw new Error('the file is cut short: it has no end record');
    return out;
  }

  /**
   * The file's runs of consecutive addresses, in file order: records that
   * follow on from each other join up, and a new run starts wherever the
   * address jumps.
   * @param {KfpFile} file - The parsed file.
   * @returns {KfpRecord[]}
   */
  function runs(file) {
    const out = [];
    let start = null;
    let parts = [];
    let length = 0;
    const close = () => {
      if (start === null) return;
      const bytes = new Uint8Array(length);
      let at = 0;
      for (const p of parts) {
        bytes.set(p, at);
        at += p.length;
      }
      out.push({ address: start, bytes });
      start = null;
      parts = [];
      length = 0;
    };
    for (const r of file.records) {
      if (start !== null && start + length !== r.address) close();
      if (start === null) start = r.address;
      parts.push(r.bytes);
      length += r.bytes.length;
    }
    close();
    return out;
  }

  /**
   * The file as the blocks a programming script is dealt: each run cut into
   * pieces of at most `maxData` bytes.
   * @param {KfpFile} file - The parsed file.
   * @param {number} maxData - The script's block limit in bytes.
   * @returns {KfpRecord[]} In file order.
   */
  function blocks(file, maxData) {
    const cap = Math.max(1, maxData | 0);
    const out = [];
    for (const run of runs(file))
      for (let at = 0; at < run.bytes.length; at += cap)
        out.push({
          address: run.address + at,
          bytes: run.bytes.subarray(at, at + cap),
        });
    return out;
  }

  /**
   * Read a module's ZB table from its .DAT.
   * @param {string} text - The .DAT's text.
   * @returns {KfpZbRow[]} The rows, in file order.
   */
  function parseZbTable(text) {
    const rows = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line[0] === ';' || line[0] === '$') continue;
      const cols = line.split(',').map((c) => c.trim());
      if (cols.length < 5 || !/^\d{7}$/.test(cols[0])) continue;
      rows.push({
        zb: cols[0],
        // TYP-NR: WinKFP records it as the record's approval number
        // (AIF_BEHOERDEN_NR, its SY_TYPNR)
        typ: cols[1],
        hw: cols[2],
        ix: cols[3],
        // "7561533DA": the number, then what kind of file it names
        sw: /^(\d{7})/.test(cols[4]) ? cols[4].slice(0, 7) : '',
        swIndex: /^(\d{7})/.test(cols[4]) ? cols[4].slice(7) : '',
      });
    }
    return rows;
  }

  /**
   * The files a ZB row names, among those the module's folder holds.
   * @param {KfpZbRow} row - The row.
   * @param {string[]} names - The folder's file names.
   * @returns {{program: string|null, data: string|null}}
   */
  function filesFor(row, names) {
    const upper = new Map(names.map((n) => [n.toUpperCase(), n]));
    const program = upper.get(`${row.hw}${row.ix}.0PA`.toUpperCase()) || null;
    let data = null;
    if (row.sw) {
      const want = new RegExp(`^[A-Z]?${row.sw}\\.0DA$`, 'i');
      data = names.find((n) => want.test(n)) || null;
    }
    return { program, data };
  }

  /**
   * Read a module family's ZB history (<family>.HIS): each line names a ZB
   * and the one that replaced it.
   * @param {string} text - The .HIS's text.
   * @returns {Map<string, string>} old ZB -> new ZB.
   */
  function parseHistory(text) {
    const next = new Map();
    for (const raw of String(text || '').split(/\r?\n/)) {
      const m = /^\s*(\d{7})\s*,\s*(\d{7})\s*,/.exec(raw);
      if (m) next.set(m[1], m[2]);
    }
    return next;
  }

  /**
   * The newest ZB a module's current one leads to, the way WinKFP's
   * Prog. ZB-Update finds it: follow the history from ZB to successor
   * while the successor is one the ZB table still lists.
   * @param {Map<string, string>} history - parseHistory's map.
   * @param {string} zb - The module's current ZB (ID_BMW_NR).
   * @param {KfpZbRow[]} rows - The family's ZB table.
   * @returns {KfpZbRow|null} The newest row, or null when the table has
   *   neither the ZB nor any successor of it.
   */
  function latestZb(history, zb, rows) {
    const byZb = new Map(rows.map((r) => [r.zb, r]));
    let best = byZb.get(zb) || null;
    const seen = new Set([zb]);
    for (let at = history.get(zb); at && !seen.has(at); at = history.get(at)) {
      seen.add(at);
      if (byZb.has(at)) best = byZb.get(at);
    }
    return best;
  }

  const api = {
    parseFile,
    runs,
    blocks,
    parseZbTable,
    filesFor,
    parseHistory,
    latestZb,
  };
  if (typeof root !== 'undefined') root.kfpDaten = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
