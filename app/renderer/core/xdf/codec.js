/**
 * @file XDF engine, piece 3 of 6: the raw <-> engineering codec.
 *
 * Resolves an item's EMBEDDEDDATA descriptor into concrete read/write
 * parameters, reads and writes scalars, flags and table cells, and runs
 * values through the item's MATH in both directions. Pure, offline, no
 * hardware: everything operates on a Uint8Array firmware image already held
 * client-side, and nothing here mutates that image -- encoders return the
 * bytes and the address so the caller can splice them in (which keeps every
 * edit undoable).
 *
 * Type-flag bit layout (mmedtypeflags):
 *   bit 0 (0x01) = signed   bit 1 (0x02) = lsbfirst (LE)   bit 2 (0x04) = float
 * The flags are authoritative, and 0 means exactly what it says: unsigned,
 * MSB-first, integer. TunerPro omits the attribute when it is zero. The
 * header <DEFAULTS> are the editor's template for NEW items, not a runtime
 * fallback: an MS45 definition ships lsbfirst="1" in DEFAULTS while every one
 * of its 988 sixteen-bit axes only decodes in order MSB-first, so honouring
 * DEFAULTS for flag-less items byte-swapped every axis label in the app.
 *
 * Adds to the shared `window.XDF` namespace; see xml.js for the load order.
 * Uses compileMath / invertLinear / noteMathMiss from math.js at call time.
 */

(function (root) {
  'use strict';

  const XDF = root.XDF || (root.XDF = {});

  /**
   * @typedef {Object} XdfEmbed
   * EMBEDDEDDATA as parsed: where an item's bytes live and how they are laid out.
   * @property {number} typeflags - Literal mmedtypeflags (see the bit layout above).
   * @property {number} address - mmedaddress before BASEOFFSET is applied.
   * @property {number} elementsizebits - Bits per element; 0 defers to DEFAULTS.
   * @property {number} rowcount - Table rows (Z axis only).
   * @property {number} colcount - Table columns (Z axis only).
   * @property {number} majorstridebits - Bits between neighbouring cells in a row; 0 = element size.
   * @property {number} minorstridebits - Bits from a row's last cell to the next row; 0 = element size.
   * @property {boolean} addressed - False for a label-only axis with no EMBEDDEDDATA.
   */

  /**
   * @typedef {Object} XdfBaseOffset
   * @property {number} offset - BASEOFFSET value.
   * @property {boolean} subtract - Whether the offset is subtracted rather than added.
   */

  /**
   * @typedef {Object} XdfDefaults
   * The header DEFAULTS: the editor's template for new items. Only
   * `datasizeinbits` is consulted at runtime (for a missing element size).
   * @property {number} datasizeinbits
   * @property {number} sigdigits
   * @property {number} outputtype
   * @property {boolean} signed
   * @property {boolean} lsbfirst
   * @property {boolean} float
   */

  /**
   * @typedef {Object} ScalarSpec
   * Concrete parameters for one scalar read or write.
   * @property {boolean} signed
   * @property {boolean} lsbfirst - Little-endian when true.
   * @property {boolean} float - IEEE float (32 or 64 bit) when true.
   * @property {number} sizeBits
   * @property {number} address - Absolute offset into the image.
   */

  /**
   * @typedef {Object} EncodedWrite
   * @property {number} address - Absolute offset the bytes belong at.
   * @property {Uint8Array} bytes - The encoded bytes.
   * @property {number} raw - The raw integer/float that was encoded.
   */

  /**
   * @typedef {Object} DecodedTable
   * @property {number} rows
   * @property {number} cols
   * @property {(number|null)[][]} cells - Engineering values, null where unreadable.
   * @property {XdfAxis} z
   * @property {XdfAxis|undefined} x
   * @property {XdfAxis|undefined} y
   * @property {ScalarSpec} spec - Resolved Z-axis parameters.
   * @property {XdfEmbed} embed - The Z-axis EMBEDDEDDATA (for cell addressing).
   */

  const FLAG_SIGNED = 0x01;
  const FLAG_LSBFIRST = 0x02;
  const FLAG_FLOAT = 0x04;

  /**
   * Apply BASEOFFSET to a raw mmedaddress.
   * @param {number} raw - Address as written in the file.
   * @param {XdfBaseOffset} base - The header base offset.
   * @returns {number}
   */
  function resolveAddress(raw, base) {
    return base.subtract ? raw - base.offset : raw + base.offset;
  }

  /**
   * Resolve EMBEDDEDDATA + BASEOFFSET + DEFAULTS into concrete parameters.
   * The type flags are read literally (see the bit layout in the file
   * header); DEFAULTS only supply a missing element size.
   * @param {XdfEmbed} embed
   * @param {XdfBaseOffset} base
   * @param {XdfDefaults} defaults
   * @returns {ScalarSpec}
   */
  function resolveEmbedded(embed, base, defaults) {
    const flags = embed.typeflags;
    return {
      signed: (flags & FLAG_SIGNED) !== 0,
      lsbfirst: (flags & FLAG_LSBFIRST) !== 0,
      float: (flags & FLAG_FLOAT) !== 0,
      sizeBits:
        embed.elementsizebits > 0
          ? embed.elementsizebits
          : defaults.datasizeinbits,
      address: resolveAddress(embed.address, base),
    };
  }

  /**
   * Whole bytes a spec occupies (at least one).
   * @param {ScalarSpec} spec
   * @returns {number}
   */
  function byteWidth(spec) {
    return Math.max(1, Math.ceil(spec.sizeBits / 8));
  }

  /**
   * Read a raw scalar from the image per spec.
   * @param {Uint8Array} buffer - The firmware image.
   * @param {ScalarSpec} spec
   * @returns {number|null} null when out of range or an unsupported width, so
   *   the UI shows "-" instead of crashing.
   */
  function readScalar(buffer, spec) {
    const bytes = byteWidth(spec);
    if (spec.address < 0 || spec.address + bytes > buffer.length) return null;
    const view = new DataView(
      buffer.buffer,
      buffer.byteOffset + spec.address,
      bytes
    );
    const le = spec.lsbfirst;
    if (spec.float) {
      if (bytes === 4) return view.getFloat32(0, le);
      if (bytes === 8) return view.getFloat64(0, le);
      return null;
    }
    switch (bytes) {
      case 1:
        return spec.signed ? view.getInt8(0) : view.getUint8(0);
      case 2:
        return spec.signed ? view.getInt16(0, le) : view.getUint16(0, le);
      case 4:
        return spec.signed ? view.getInt32(0, le) : view.getUint32(0, le);
      case 8: {
        const big = spec.signed
          ? view.getBigInt64(0, le)
          : view.getBigUint64(0, le);
        return Number(big);
      }
      default:
        return null;
    }
  }

  /**
   * Encode a raw scalar into a fresh Uint8Array.
   * @param {number} value - Raw value (truncated to an integer unless float).
   * @param {ScalarSpec} spec
   * @returns {Uint8Array|null} null when the value cannot fit the storage type.
   */
  function encodeScalar(value, spec) {
    const bytes = byteWidth(spec);
    const buf = new ArrayBuffer(bytes);
    const view = new DataView(buf);
    const le = spec.lsbfirst;
    if (spec.float) {
      if (!Number.isFinite(value)) return null;
      if (bytes === 4) view.setFloat32(0, value, le);
      else if (bytes === 8) view.setFloat64(0, value, le);
      else return null;
      return new Uint8Array(buf);
    }
    if (!Number.isFinite(value)) return null;
    const intVal = Math.trunc(value);
    const ranges = {
      1: spec.signed ? { lo: -0x80, hi: 0x7f } : { lo: 0, hi: 0xff },
      2: spec.signed ? { lo: -0x8000, hi: 0x7fff } : { lo: 0, hi: 0xffff },
      4: spec.signed
        ? { lo: -0x80000000, hi: 0x7fffffff }
        : { lo: 0, hi: 0xffffffff },
    };
    const r = ranges[bytes];
    if (r && (intVal < r.lo || intVal > r.hi)) return null;
    switch (bytes) {
      case 1:
        if (spec.signed) view.setInt8(0, intVal);
        else view.setUint8(0, intVal);
        break;
      case 2:
        if (spec.signed) view.setInt16(0, intVal, le);
        else view.setUint16(0, intVal, le);
        break;
      case 4:
        if (spec.signed) view.setInt32(0, intVal, le);
        else view.setUint32(0, intVal, le);
        break;
      case 8: {
        const big = BigInt(intVal);
        if (spec.signed) view.setBigInt64(0, big, le);
        else view.setBigUint64(0, big, le);
        break;
      }
      default:
        return null;
    }
    return new Uint8Array(buf);
  }

  /**
   * Whether the masked bit(s) are set in the byte at `address`.
   * @param {Uint8Array} buffer
   * @param {number} address
   * @param {number} mask
   * @returns {boolean|null} null when the address is outside the image.
   */
  function readFlag(buffer, address, mask) {
    if (address < 0 || address >= buffer.length) return null;
    return (buffer[address] & mask) !== 0;
  }

  /**
   * The byte with the masked bit(s) set or cleared, neighbours untouched.
   * @param {number} byte - Current byte value.
   * @param {number} mask
   * @param {boolean} on
   * @returns {number}
   */
  function applyFlag(byte, mask, on) {
    return on ? (byte | mask) & 0xff : byte & ~mask & 0xff;
  }

  /**
   * Byte offset of table cell (row, col) within a Z embed, per the .xdf
   * stride convention.
   * @param {XdfEmbed} embed - The Z-axis EMBEDDEDDATA.
   * @param {number} row
   * @param {number} col
   * @returns {number|null} null when the cell isn't byte-aligned.
   */
  function tableCellAddress(embed, row, col) {
    const ele = embed.elementsizebits;
    if (ele <= 0) return null;
    const cols = Math.max(1, embed.colcount);
    const withinRow = embed.majorstridebits !== 0 ? embed.majorstridebits : ele;
    const tail = embed.minorstridebits !== 0 ? embed.minorstridebits : ele;
    const rowPitchBits = tail + (cols - 1) * withinRow;
    const cellBits = row * rowPitchBits + col * withinRow;
    if (cellBits % 8 !== 0) return null;
    return embed.address + cellBits / 8;
  }

  /**
   * Whether `data` matches the image at `address` byte for byte.
   * @param {Uint8Array} buffer
   * @param {number} address
   * @param {Uint8Array} data
   * @returns {boolean}
   */
  function bytesMatchAt(buffer, address, data) {
    for (let k = 0; k < data.length; k++) {
      if (buffer[address + k] !== data[k]) return false;
    }
    return true;
  }

  /**
   * Which side of a patch entry the image currently holds.
   * @param {Uint8Array} buffer
   * @param {number} address
   * @param {Uint8Array} patchdata - The patched bytes.
   * @param {Uint8Array} basedata - The stock bytes (may be empty).
   * @returns {'applied'|'virgin'|'neither'}
   */
  function patchEntryState(buffer, address, patchdata, basedata) {
    if (address < 0 || address + patchdata.length > buffer.length)
      return 'neither';
    if (bytesMatchAt(buffer, address, patchdata)) return 'applied';
    if (basedata.length === patchdata.length && basedata.length > 0) {
      if (bytesMatchAt(buffer, address, basedata)) return 'virgin';
    }
    return 'neither';
  }

  /**
   * Compile an item's MATH, falling back to identity (and recording the miss)
   * when it does not parse -- better a raw number than nothing, but never a
   * silent one.
   * @param {string} equation
   * @returns {(x: number) => number}
   */
  function convertOrRaw(equation) {
    try {
      return XDF.compileMath(equation);
    } catch (e) {
      XDF.noteMathMiss(equation);
      return (v) => v;
    }
  }

  // ==========================================================================
  // High-level convenience: decode/encode an item's DISPLAY value (raw run
  // through / inverted through its MATH). The Tuning screen leans on these so
  // it never re-implements the raw<->engineering step per widget.
  // ==========================================================================

  /**
   * Constant/axis scalar -> engineering value.
   * @param {XdfConstant|XdfAxis} item - Anything with `embed` and `mathEquation`.
   * @param {Uint8Array} buffer
   * @param {XdfHeader} header
   * @returns {number|null} null when the bytes are outside the image; the raw
   *   value (and a recorded miss) when the MATH does not compile.
   */
  function decodeConstant(item, buffer, header) {
    const spec = resolveEmbedded(
      item.embed,
      header.baseOffset,
      header.defaults
    );
    const raw = readScalar(buffer, spec);
    if (raw === null) return null;
    try {
      return XDF.compileMath(item.mathEquation)(raw);
    } catch (e) {
      XDF.noteMathMiss(item.mathEquation);
      return raw;
    }
  }

  /**
   * Engineering value -> the bytes to write, plus the absolute address.
   * @param {XdfConstant} item
   * @param {number} engValue
   * @param {XdfHeader} header
   * @returns {EncodedWrite|null} null when the MATH isn't invertible or the
   *   value won't fit.
   */
  function encodeConstant(item, engValue, header) {
    const spec = resolveEmbedded(
      item.embed,
      header.baseOffset,
      header.defaults
    );
    const inv = XDF.invertLinear(item.mathEquation);
    if (!inv) return null;
    const raw = Math.round(inv(engValue));
    const bytes = encodeScalar(raw, spec);
    if (!bytes) return null;
    return { address: spec.address, bytes, raw };
  }

  /**
   * Table geometry + decoded cells. rows/cols come from the Z axis embed
   * (falling back to the axis indexcounts). Each cell is the engineering value.
   * @param {XdfTable} table
   * @param {Uint8Array} buffer
   * @param {XdfHeader} header
   * @returns {DecodedTable|null} null when the table has no Z axis.
   */
  function decodeTable(table, buffer, header) {
    const z = table.axes.find((a) => a.id === 'z');
    const x = table.axes.find((a) => a.id === 'x');
    const y = table.axes.find((a) => a.id === 'y');
    if (!z) return null;
    const embed = z.embed;
    let rows = embed.rowcount || (y ? y.indexcount : 0) || 1;
    let cols = embed.colcount || (x ? x.indexcount : 0) || 1;
    if (rows < 1) rows = 1;
    if (cols < 1) cols = 1;
    const spec = resolveEmbedded(embed, header.baseOffset, header.defaults);
    const convert = convertOrRaw(z.mathEquation);
    const cells = [];
    for (let r = 0; r < rows; r++) {
      const rowArr = [];
      for (let c = 0; c < cols; c++) {
        const addr = tableCellAddress(embed, r, c);
        let val = null;
        if (addr !== null) {
          const raw = readScalar(buffer, cellSpecAt(spec, addr));
          if (raw !== null) val = convert(raw);
        }
        rowArr.push(val);
      }
      cells.push(rowArr);
    }
    return { rows, cols, cells, z, x, y, spec, embed };
  }

  /**
   * The Z-axis spec re-addressed to one cell.
   * @param {ScalarSpec} spec
   * @param {number} address
   * @returns {ScalarSpec}
   */
  function cellSpecAt(spec, address) {
    return {
      signed: spec.signed,
      lsbfirst: spec.lsbfirst,
      float: spec.float,
      sizeBits: spec.sizeBits,
      address,
    };
  }

  /**
   * Encode one table cell's engineering value.
   * @param {XdfTable} table
   * @param {XdfHeader} header
   * @param {number} row
   * @param {number} col
   * @param {number} engValue
   * @returns {EncodedWrite|null} null when the cell is unaddressable, the
   *   MATH isn't invertible, or the value won't fit.
   */
  function encodeTableCell(table, header, row, col, engValue) {
    const z = table.axes.find((a) => a.id === 'z');
    if (!z) return null;
    const embed = z.embed;
    const spec = resolveEmbedded(embed, header.baseOffset, header.defaults);
    const addr = tableCellAddress(embed, row, col);
    if (addr === null) return null;
    const inv = XDF.invertLinear(z.mathEquation);
    if (!inv) return null;
    const raw = Math.round(inv(engValue));
    const bytes = encodeScalar(raw, cellSpecAt(spec, addr));
    if (!bytes) return null;
    return { address: addr, bytes, raw };
  }

  /**
   * Encode one AXIS point's engineering value.
   *
   * An axis is a plain vector of scalars at `address + i * elementSize`, which
   * is how the Tuning screen's axis labels already read them back. Axes whose
   * values come from <LABEL> text rather than the image carry no address and
   * are not editable: there are no bytes to write.
   * @param {XdfAxis} axis
   * @param {XdfHeader} header
   * @param {number} index - Breakpoint index.
   * @param {number} engValue
   * @returns {EncodedWrite|null}
   */
  function encodeAxisPoint(axis, header, index, engValue) {
    if (!axis || !axis.embed || !axis.embed.address) return null;
    const spec = resolveEmbedded(
      axis.embed,
      header.baseOffset,
      header.defaults
    );
    const inv = XDF.invertLinear(axis.mathEquation);
    if (!inv) return null;
    const addr = spec.address + index * byteWidth(spec);
    const raw = Math.round(inv(engValue));
    const bytes = encodeScalar(raw, cellSpecAt(spec, addr));
    if (!bytes) return null;
    return { address: addr, bytes, raw };
  }

  /**
   * Read one axis point back out, so the UI can show what the image really
   * holds after quantisation rather than the text that was typed.
   * @param {XdfAxis} axis
   * @param {Uint8Array} buffer
   * @param {XdfHeader} header
   * @param {number} index - Breakpoint index.
   * @returns {number|null}
   */
  function decodeAxisPoint(axis, buffer, header, index) {
    if (!axis || !axis.embed || !axis.embed.address) return null;
    const spec = resolveEmbedded(
      axis.embed,
      header.baseOffset,
      header.defaults
    );
    const raw = readScalar(
      buffer,
      Object.assign({}, spec, {
        address: spec.address + index * byteWidth(spec),
      })
    );
    if (raw === null) return null;
    return convertOrRaw(axis.mathEquation)(raw);
  }

  Object.assign(XDF, {
    resolveAddress,
    resolveEmbedded,
    readScalar,
    encodeScalar,
    readFlag,
    applyFlag,
    tableCellAddress,
    patchEntryState,
    decodeConstant,
    encodeConstant,
    decodeTable,
    encodeTableCell,
    encodeAxisPoint,
    decodeAxisPoint,
  });
})(typeof window !== 'undefined' ? window : this);
