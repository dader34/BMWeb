/**
 * @file The job's environment: the constant pool, the argument list,
 * shared-memory keys and SGBD table lookup. Extends Best2Vm (machine.js).
 */

if (typeof require === 'function' && typeof module !== 'undefined') {
  Object.assign(globalThis, require('./machine.js'), require('./operands.js'));
}

/**
 * A cell by column name, the exact name preferred and a case-insensitive
 * match otherwise (TableNameDict is keyed on ToUpper; so are the column
 * lookups of tabseek and tabget).
 * @param {import('./machine.js').TableRow} row - The row.
 * @param {string} col - The column name.
 * @returns {string|undefined} The cell, or undefined when no column matches.
 */
function sgbdTableCell(row, col) {
  if (row[col] !== undefined) return row[col];
  const k = Object.keys(row).find(
    (x) => x.toUpperCase() === String(col).toUpperCase()
  );
  return k === undefined ? undefined : row[k];
}

Object.assign(Best2Vm.prototype, {
  /**
   * A pool entry as TEXT: a byte-array literal is NUL-terminated text.
   * @param {number} i - The constant-pool index.
   * @returns {string} The text ('' for a missing entry).
   */
  lit(i) {
    const v = this.code.strings[i];
    if (Array.isArray(v)) return Best2Codec.cstr(Uint8Array.from(v));
    return v ?? '';
  },

  /**
   * A shared-data key. GetStringData stops at the first NUL, so a key that
   * IS a NUL byte reads as the empty string -- which is a perfectly valid
   * key, and the one MS450's AIF block uses. Uppercased, as the engine does.
   * @param {import('./machine.js').Operand} op - The key operand.
   * @returns {string} The key.
   */
  shmKey(op) {
    const raw =
      op[0] === OpMode.IMM_STR ? this.code.strings[op[1]] : this.bytes(op);
    const bytes = Array.isArray(raw) ? Uint8Array.from(raw) : raw;
    return Best2Codec.cstr(bytes).toUpperCase();
  },

  /**
   * Job arguments split on ';'. An EMPTY argument string is ZERO
   * parameters (GetActiveArgStrings only splits when length > 0), not one
   * empty string -- otherwise `parn` reports 1 and every arg guard inverts.
   * @returns {string[]} The arguments.
   */
  args() {
    if (this._args === undefined) {
      this._args = this.argText.length > 0 ? this.argText.split(';') : [];
    }
    return this._args;
  },

  /**
   * Case-insensitive table lookup in the SGBD's own tables, with the exact
   * name preferred.
   * @param {string} name - The table name.
   * @returns {?import('./machine.js').TableRow[]} The rows, or null.
   */
  findTable(name) {
    if (!name) return null;
    if (this.tables[name]) return this.tables[name];
    const want = String(name).toUpperCase();
    if (!this._tabIndex) {
      this._tabIndex = new Map();
      for (const k of Object.keys(this.tables)) {
        this._tabIndex.set(k.toUpperCase(), this.tables[k]);
      }
    }
    return this._tabIndex.get(want) || null;
  },

  /**
   * A table in ANOTHER best file (`tabsetex "Name", "file"`). Both levels
   * case-insensitive, like TableNameDict and the engine's file lookup.
   * Per OpTabsetex (EdOperations.cs): a NON-empty file name switches the
   * table stream to that file and looks the table up THERE -- there is no
   * fallback to the current SGBD's own tables.
   * @param {string} file - The bare best-file name.
   * @param {string} name - The table name.
   * @returns {?import('./machine.js').TableRow[]} The rows, or null.
   */
  findExtTable(file, name) {
    if (!file || !name) return null;
    const wantFile = String(file).toUpperCase();
    let group = null;
    for (const k of Object.keys(this.extTables)) {
      if (k.toUpperCase() === wantFile) {
        group = this.extTables[k];
        break;
      }
    }
    if (!group) return null;
    if (group[name]) return group[name];
    const want = String(name).toUpperCase();
    for (const k of Object.keys(group)) {
      if (k.toUpperCase() === want) return group[k];
    }
    return null;
  },
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sgbdTableCell };
}
