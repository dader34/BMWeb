/**
 * @file Plain-text tables: columns padded to their widest cell, two spaces
 * between them, the last column left ragged so a long fault text never
 * pads every row to its width.
 */

/**
 * Lay rows out as aligned columns.
 *
 * A header, when given, is printed as the first row with a rule under it.
 * Cells are stringified as given; an `undefined` prints empty.
 * @param rows - the cells, one array per row
 * @param header - column titles, optional
 * @param indent - leading spaces for every line
 * @returns the lines, without a trailing newline
 */
export function formatTable(
  rows: (string | number | undefined)[][],
  header?: string[],
  indent = ''
): string[] {
  const all = header ? [header, ...rows] : rows;
  const text = all.map((r) => r.map((c) => (c === undefined ? '' : String(c))));
  const cols = Math.max(0, ...text.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < cols; c++)
    widths[c] = Math.max(0, ...text.map((r) => (r[c] || '').length));
  const line = (r: string[]): string =>
    indent +
    r
      .map((cell, c) =>
        c === cols - 1 ? cell : cell.padEnd(widths[c] as number)
      )
      .join('  ')
      .trimEnd();
  const out = text.map(line);
  if (header) {
    const rule = widths.map((w) => '-'.repeat(w));
    out.splice(1, 0, line(rule));
  }
  return out;
}

/**
 * A number with thousands separators, for byte counts and totals.
 * @param n - the number
 * @returns the text
 */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}
