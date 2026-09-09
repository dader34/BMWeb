// The fault-code formatter: which identity a row prints, in the order the
// Garage diff prefers them, and the text/count/state columns beside it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  faultCode,
  faultCount,
  faultRow,
  faultState,
  faultText,
  hexDigits,
  leadingCode,
} from '../src/faults.ts';

test('hexDigits: the DTC is the first two bytes, from a string or bytes', () => {
  assert.equal(hexDigits('27-C3-22'), '27C3');
  assert.equal(hexDigits('27c3'), '27C3');
  assert.equal(hexDigits([0x27, 0xc3, 0x22]), '27C3');
  assert.equal(hexDigits('0x2A0B'), '2A0B');
  assert.equal(hexDigits(''), '');
  assert.equal(hexDigits(undefined), '');
});

test('faultCode: F_HEX_CODE, else the DTC the text leads with, else F_ORT_NR', () => {
  assert.equal(
    faultCode({ F_HEX_CODE: '27-C3-22', F_ORT_NR: 39, F_ORT_TEXT: 'x' }),
    '27C3'
  );
  assert.equal(
    faultCode({ F_ORT_NR: 39, F_ORT_TEXT: '2A0B Camshaft sensor' }),
    '2A0B'
  );
  assert.equal(
    faultCode({ F_ORT_NR: 120, F_ORT_TEXT: 'Lambda heater' }),
    '120'
  );
  assert.equal(faultCode({ F_ORT_TEXT: 'no identity at all' }), '');
});

test('leadingCode takes 3 to 5 hex digits at a word boundary only', () => {
  assert.equal(leadingCode('27C3 DMTL pump'), '27C3');
  assert.equal(leadingCode('P0171 lean'), '');
  assert.equal(leadingCode('BEEFY sensor'), '');
  assert.equal(leadingCode('123 sensor'), '123');
});

test('faultText drops the code it leads with only when that code is printed', () => {
  const c = { F_HEX_CODE: '27-C3-22', F_ORT_TEXT: '27C3 DMTL pump current' };
  assert.equal(faultText(c, faultCode(c)), 'DMTL pump current');
  const d = { F_HEX_CODE: '2A-0B-00', F_ORT_TEXT: '27C3 DMTL pump current' };
  assert.equal(faultText(d, faultCode(d)), '27C3 DMTL pump current');
});

test('count prefers F_HFK, falls back to F_LZ; state reads INPA wording', () => {
  assert.equal(faultCount({ F_HFK: 3, F_LZ: 9 }), '3');
  assert.equal(faultCount({ F_LZ: 9 }), '9');
  assert.equal(faultCount({}), '');
  assert.equal(
    faultState({ F_VORHANDEN_TEXT: 'Fehler momentan vorhanden' }),
    'present'
  );
  assert.equal(
    faultState({ F_VORHANDEN_TEXT: 'Fehler momentan nicht vorhanden' }),
    'stored'
  );
  assert.equal(faultState({}), '');
});

test('faultRow assembles the four columns', () => {
  assert.deepEqual(
    faultRow({
      F_HEX_CODE: [0x27, 0xc3, 0x22],
      F_ORT_TEXT: '27C3 DMTL pump',
      F_HFK: '2',
      F_VORHANDEN_TEXT: 'Fehler momentan vorhanden',
    }),
    { code: '27C3', text: 'DMTL pump', count: '2', state: 'present' }
  );
});
