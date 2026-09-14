/**
 * @file The `report` commands: a shared Garage link decoded and printed,
 * and two of them compared.
 *
 * The link is `<page>#report/<payload>`, the payload a deflate-raw JSON
 * in base64url; garageShareDecode (the app's own) reads it, and
 * garageDiffScans (also the app's) does the comparison, so what the CLI
 * prints is what the Garage's Compare screen shows.
 */
import { CliError } from './args.ts';
import { faultRow } from './faults.ts';
import { formatTable } from './table.ts';
import {
  loadRuntime,
  type FaultCode,
  type GarageDiff,
  type GarageScan,
  type Report,
  type ReportModule,
  type SharePayload,
} from './runtime.ts';

/**
 * The payload out of whatever the user pasted: a whole link, a fragment,
 * or the bare payload.
 * @param arg - the argument as typed
 * @returns the base64url payload
 */
export function payloadOf(arg: string): string {
  const s = String(arg || '').trim();
  const at = s.indexOf('#report/');
  if (at >= 0) return s.slice(at + '#report/'.length);
  if (s.startsWith('report/')) return s.slice('report/'.length);
  if (/^https?:\/\//i.test(s))
    throw new CliError('that link carries no #report/ fragment');
  return s;
}

/**
 * Decode a shared report link.
 * @param arg - the link or payload
 * @returns what the link carries
 */
export async function decodeReport(arg: string): Promise<SharePayload> {
  const R = loadRuntime();
  const payload = payloadOf(arg);
  if (!payload) throw new CliError('no report payload given');
  const p = await R.garageShareDecode(payload);
  if (!p)
    throw new CliError(
      'this link does not carry a readable report (it may have been cut short when pasted)'
    );
  return p;
}

/**
 * A payload as the diff's unit: the scan the Garage would have stored.
 * @param p - the decoded payload
 * @returns the scan
 */
export function scanOf(p: SharePayload): GarageScan {
  const R = loadRuntime();
  return {
    kind: p.kind,
    at: p.at,
    chassis: p.chassis,
    report: p.report,
    summary: p.summary || R.garageScanSummary(p.report),
  };
}

/**
 * A module's caption: its label, else its SGBD upper-cased.
 * @param m - the module
 * @returns the text
 */
function moduleName(m: { sgbd: string; label?: string }): string {
  return m.label || String(m.sgbd || '').toUpperCase();
}

/**
 * The ident rows of a module, captioned as the app captions them, then
 * whatever else the module answered.
 * @param ident - the module's ident record
 * @returns [caption, key, value] rows
 */
export function identRows(
  ident: Record<string, unknown>
): [string, string, string][] {
  const R = loadRuntime();
  const rows: [string, string, string][] = [];
  const seen = new Set<string>();
  const val = (k: string): string =>
    ident[k] == null ? '' : String(ident[k]).trim();
  for (const [keys, cap] of R.IPO_IDENT_ROWS || []) {
    for (const k of keys) {
      seen.add(k);
      const v = val(k);
      if (v) rows.push([keys.length > 1 ? `${cap} (${k})` : cap, k, v]);
    }
  }
  for (const k of Object.keys(ident)) {
    if (seen.has(k) || k.startsWith('_')) continue;
    const v = val(k);
    if (v) rows.push([k, k, v]);
  }
  return rows;
}

/**
 * The header lines every report print starts with.
 * @param p - the decoded payload
 * @returns the lines
 */
function headerLines(p: SharePayload): string[] {
  const R = loadRuntime();
  const sum = p.summary || R.garageScanSummary(p.report);
  const who = [p.label, p.chassis].filter(Boolean).join(' / ');
  const kind = p.kind === 'ident' ? 'identification' : 'fault memories';
  return formatTable([
    ['Report', `${kind}${who ? ` of ${who}` : ''}`],
    ['Read', p.at || ''],
    [
      'Modules',
      `${sum.modules} read, ${sum.withFaults} with faults, ${sum.faults} fault${sum.faults === 1 ? '' : 's'}, ${sum.silent} silent`,
    ],
  ]);
}

/**
 * A faults report as a table.
 * @param report - the report
 * @returns the lines
 */
function faultLines(report: Report): string[] {
  const rows: (string | undefined)[][] = [];
  for (const m of report.modules || []) {
    const codes = m.codes || [];
    if (!codes.length) {
      rows.push([moduleName(m), '', 'no faults stored']);
      continue;
    }
    for (const c of codes) {
      const r = faultRow(c);
      rows.push([moduleName(m), r.code, r.text, r.count, r.state]);
    }
  }
  if (!rows.length) return ['no modules in this report'];
  return formatTable(rows, ['MODULE', 'CODE', 'TEXT', 'COUNT', 'STATE']);
}

/**
 * An ident report as a table.
 * @param report - the report
 * @returns the lines
 */
function identLines(report: Report): string[] {
  const rows: string[][] = [];
  for (const m of report.modules || []) {
    const ident = m.ident;
    if (!ident || !Object.keys(ident).length) {
      rows.push([moduleName(m), '', '(no identification)']);
      continue;
    }
    for (const [cap, , v] of identRows(ident))
      rows.push([moduleName(m), cap, v]);
  }
  if (!rows.length) return ['no modules in this report'];
  return formatTable(rows, ['MODULE', 'FIELD', 'VALUE']);
}

/**
 * The silent addresses, one line each.
 * @param report - the report
 * @returns the lines, empty when every module answered
 */
function silentLines(report: Report): string[] {
  const silent = report.silent || [];
  if (!silent.length) return [];
  return [
    '',
    `Silent (${silent.length}):`,
    ...formatTable(
      silent.map((s) => [
        String(s.target || '').toUpperCase(),
        s.label || '',
        s.error || '',
      ]),
      undefined,
      '  '
    ),
  ];
}

/**
 * `report show`: the report as tables, or the decoded payload as JSON.
 * @param arg - the link or payload
 * @param json - machine-readable output
 * @returns the lines to print
 */
export async function reportShow(
  arg: string,
  json: boolean
): Promise<string[]> {
  const p = await decodeReport(arg);
  if (json) return [JSON.stringify(p, null, 2)];
  return [...headerLines(p), '', ...reportBodyLines(p.report, p.kind)];
}

/**
 * A report's body: the fault (or ident) table and the silent addresses.
 * Shared with `scan`, which prints what it just read the same way.
 * @param report - the report
 * @param kind - 'faults' or 'ident'
 * @returns the lines
 */
export function reportBodyLines(report: Report, kind?: string): string[] {
  const body = kind === 'ident' ? identLines(report) : faultLines(report);
  return [...body, ...silentLines(report)];
}

/**
 * One fault as a diff line: a sign, the code and the text.
 * @param sign - '+', '-' or '='
 * @param c - the fault
 * @returns the cells
 */
function diffFaultRow(sign: string, c: FaultCode): string[] {
  const r = faultRow(c);
  return [sign, r.code, r.text, r.count];
}

/**
 * What a diff prints, in JSON form: the app's diff with the two headers.
 * @param a - the older payload
 * @param b - the newer payload
 * @param diff - the comparison
 * @returns the object
 */
function diffJson(a: SharePayload, b: SharePayload, diff: GarageDiff): object {
  const R = loadRuntime();
  const strip = (p: SharePayload): object => ({
    kind: p.kind,
    at: p.at,
    chassis: p.chassis,
    label: p.label,
  });
  return {
    from: strip(a),
    to: strip(b),
    kind: diff.kind,
    counts: R.garageDiffCounts(diff),
    modules: diff.modules,
    silence: diff.silence,
  };
}

/**
 * `report diff`: what changed from the first link to the second.
 * @param argA - the older link or payload
 * @param argB - the newer link or payload
 * @param json - machine-readable output
 * @returns the lines to print
 */
export async function reportDiff(
  argA: string,
  argB: string,
  json: boolean
): Promise<string[]> {
  const R = loadRuntime();
  const a = await decodeReport(argA);
  const b = await decodeReport(argB);
  const diff = R.garageDiffScans(scanOf(a), scanOf(b));
  if (json) return [JSON.stringify(diffJson(a, b, diff), null, 2)];
  const counts = R.garageDiffCounts(diff);
  const out = formatTable([
    ['From', `${a.at || ''}${a.label ? `  ${a.label}` : ''}`],
    ['To', `${b.at || ''}${b.label ? `  ${b.label}` : ''}`],
    [
      'Changes',
      `${counts.added} new, ${counts.cleared} cleared, ${counts.same} still present` +
        (diff.kind !== 'faults'
          ? `, ${counts.fields} ident fields changed`
          : '') +
        `, ${counts.modules} module${counts.modules === 1 ? '' : 's'} changed`,
    ],
  ]);
  for (const m of diff.modules) {
    out.push('');
    if (m.unread) {
      out.push(`${m.label}  (not read in the newer report)`);
      continue;
    }
    if (!m.changed) {
      out.push(
        `${m.label}  unchanged` +
          (m.same.length ? ` (${m.same.length} still present)` : '')
      );
      continue;
    }
    out.push(m.label);
    const rows: string[][] = [];
    for (const c of m.added) rows.push(diffFaultRow('+', c));
    for (const c of m.cleared) rows.push(diffFaultRow('-', c));
    for (const c of m.same) rows.push(diffFaultRow('=', c));
    for (const f of m.fields)
      rows.push(['~', f.label, `${f.from || '(none)'} -> ${f.to || '(none)'}`]);
    out.push(...formatTable(rows, undefined, '  '));
  }
  if (diff.silence.length) {
    out.push('', 'Answering changed:');
    out.push(
      ...formatTable(
        diff.silence.map((s) => [
          s.state === 'silent' ? 'silent now' : 'answering now',
          s.label,
          s.error || '',
        ]),
        undefined,
        '  '
      )
    );
  }
  out.push('', '+ new   - cleared   = still present   ~ ident field changed');
  return out;
}

/** Re-exported for the tests, which build payloads through the app's encoder. */
export type { ReportModule };
