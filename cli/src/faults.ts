/**
 * @file Formatting one stored fault for a table row.
 *
 * The app's faultFields (screens/faults.js) does this with the fault
 * dictionaries beside it (names, P-codes, the lookup). The CLI has no
 * dictionaries, so it prints what the report itself carries, choosing the
 * code the way the Garage diff identifies a fault: the DTC from F_HEX_CODE,
 * else the DTC the text leads with, else the location number.
 */
import type { FaultCode } from './runtime.ts';

/**
 * The first four hex digits of F_HEX_CODE: the two-byte DTC, without the
 * status and environment bytes that follow it. A live read carries the
 * bytes as an array, a stored one as "27-C3-22"; both reduce to "27C3".
 * @param v - F_HEX_CODE as stored or as read
 * @returns the four digits, or '' when the field is absent
 */
export function hexDigits(v: unknown): string {
  if (v == null || v === '') return '';
  const text = Array.isArray(v)
    ? v.map((b) => (Number(b) & 0xff).toString(16).padStart(2, '0')).join('')
    : String(v);
  return text
    .trim()
    .toUpperCase()
    .replace(/^0X/, '')
    .replace(/[^0-9A-F]/g, '')
    .slice(0, 4);
}

/**
 * The DTC a fault text leads with ("27C3 DMTL ..."), when it does.
 * @param text - F_ORT_TEXT
 * @returns the code, upper-case, or ''
 */
export function leadingCode(text: unknown): string {
  const m = /^([0-9A-F]{3,5})\b/i.exec(String(text || '').trim());
  return m ? (m[1] as string).toUpperCase() : '';
}

/**
 * The code to print for a fault, strongest identity first.
 * @param c - the stored fault
 * @returns the code, or '' when the entry names none
 */
export function faultCode(c: FaultCode): string {
  const hex = hexDigits(c.F_HEX_CODE);
  if (hex) return hex;
  const lead = leadingCode(c.F_ORT_TEXT);
  if (lead) return lead;
  const nr = c.F_ORT_NR;
  if (nr != null && String(nr).trim() !== '') return String(nr).trim();
  return '';
}

/**
 * The fault text, without the code it leads with when that code is the
 * one already printed in the code column.
 * @param c - the stored fault
 * @param code - what faultCode returned
 * @returns the text
 */
export function faultText(c: FaultCode, code: string): string {
  const text = String(c.F_ORT_TEXT || '').trim();
  const lead = leadingCode(text);
  if (lead && lead === code) return text.slice(lead.length).trim();
  return text;
}

/**
 * How often the module saw the fault: F_HFK, else the logistic counter.
 * @param c - the stored fault
 * @returns the count as text, or ''
 */
export function faultCount(c: FaultCode): string {
  const n = c.F_HFK ?? c.F_LZ;
  return n == null || n === '' ? '' : String(n);
}

/**
 * Whether the fault is currently present, from INPA's own wording. The
 * module says it in German ("Fehler momentan vorhanden" / "... nicht
 * vorhanden"); the runtime translates *_TEXT results before a report is
 * folded, so the English the app prints is accepted too.
 * @param c - the stored fault
 * @returns 'present', 'stored', or '' when the read did not say
 */
export function faultState(c: FaultCode): string {
  const vt = String(c.F_VORHANDEN_TEXT || '').toLowerCase();
  if (!vt) return '';
  const says = /momentan vorhanden|currently present/.test(vt);
  const denies = /nicht vorhanden|not (currently )?present/.test(vt);
  return says && !denies ? 'present' : 'stored';
}

/** A fault reduced to what a table row shows. */
export interface FaultRow {
  code: string;
  text: string;
  count: string;
  state: string;
}

/**
 * One fault as a table row.
 * @param c - the stored fault
 * @returns the row
 */
export function faultRow(c: FaultCode): FaultRow {
  const code = faultCode(c);
  return {
    code,
    text: faultText(c, code),
    count: faultCount(c),
    state: faultState(c),
  };
}
