#!/usr/bin/env node
// Test ZCS module: validation, formatting, parsing, SA code extraction

const CodingZcs = require('../../app/renderer/core/coding-zcs.js');

let pass = 0;
let fail = 0;

function assert(cond, msg) {
  if (cond) {
    pass++;
    console.log('  ok   ', msg);
  } else {
    fail++;
    console.log('  FAIL ', msg);
  }
}

function assertEq(a, b, msg) {
  if (a === b) {
    pass++;
    console.log('  ok   ', msg);
  } else {
    fail++;
    console.log(
      '  FAIL ',
      msg,
      `(expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`
    );
  }
}

function assertDeepEq(a, b, msg) {
  const aStr = JSON.stringify(a);
  const bStr = JSON.stringify(b);
  if (aStr === bStr) {
    pass++;
    console.log('  ok   ', msg);
  } else {
    fail++;
    console.log('  FAIL ', msg, `(expected ${bStr}, got ${aStr})`);
  }
}

console.log('\n== ZCS validation ==');

assertEq(CodingZcs.validateGm('61630000'), null, 'valid GM 8 hex chars');
assertEq(CodingZcs.validateGm('FFFFFFFF'), null, 'valid GM all F');
assert(CodingZcs.validateGm('123'), 'GM too short rejects');
assert(CodingZcs.validateGm('123456789'), 'GM too long rejects');
assert(CodingZcs.validateGm('GGGGGGGG'), 'GM non-hex rejects');

assertEq(
  CodingZcs.validateSa('0000284803AC1400'),
  null,
  'valid SA 16 hex chars'
);
assert(CodingZcs.validateSa('123'), 'SA too short rejects');

assertEq(CodingZcs.validateVn('0000640620'), null, 'valid VN 10 hex chars');
assert(CodingZcs.validateVn('123'), 'VN too short rejects');

console.log('\n== ZCS format with check digit ==');

assertEq(CodingZcs.formatGm('FFFFFFFF'), 'FFFFFFFFP', 'GM FFFFFFFF → P');
assertEq(CodingZcs.formatGm('61630000'), '616300005', 'GM 61630000 → 5');

assertEq(
  CodingZcs.formatSa('0000284803AC1400'),
  '0000284803AC1400G',
  'SA with check G'
);
assertEq(
  CodingZcs.formatSa('FFFFFFFFFFFFFFFF'),
  'FFFFFFFFFFFFFFFFE',
  'SA all F → E'
);

assertEq(CodingZcs.formatVn('0000640620'), '00006406201', 'VN with check 1');

console.log('\n== ZCS verify check digit ==');

assert(CodingZcs.verifyGm('FFFFFFFFP'), 'GM FFFFFFFFP valid');
assert(CodingZcs.verifyGm('616300005'), 'GM 616300005 valid');
assert(!CodingZcs.verifyGm('FFFFFFFFX'), 'GM wrong check rejects');

assert(CodingZcs.verifySa('0000284803AC1400G'), 'SA with G valid');
assert(!CodingZcs.verifySa('0000284803AC1400X'), 'SA wrong check rejects');

assert(CodingZcs.verifyVn('00006406201'), 'VN with 1 valid');
assert(!CodingZcs.verifyVn('00006406209'), 'VN wrong check rejects');

console.log('\n== ZCS strip check ==');

assertEq(CodingZcs.stripGmCheck('FFFFFFFFP'), 'FFFFFFFF', 'strip GM check');
assertEq(
  CodingZcs.stripSaCheck('0000284803AC1400G'),
  '0000284803AC1400',
  'strip SA check'
);
assertEq(CodingZcs.stripVnCheck('00006406201'), '0000640620', 'strip VN check');
assertEq(
  CodingZcs.stripVnCheck('0000640620'),
  '0000640620',
  'strip VN no check'
);

console.log('\n== ZCS region build/parse ==');

const region = CodingZcs.buildZcsRegion(
  '61630000',
  '0000284803AC1400',
  '0000640620'
);
assertEq(region.length, 20, 'region is 20 bytes');

// Verify byte layout
assertEq(region[0], 0x61, 'GM byte 0');
assertEq(region[1], 0x63, 'GM byte 1');
assertEq(region[2], 0x00, 'GM byte 2');
assertEq(region[3], 0x00, 'GM byte 3');
assertEq(region[4], '5'.charCodeAt(0), 'GM check char ASCII');

assertEq(region[5], 0x00, 'SA byte 0');
assertEq(region[13], 'G'.charCodeAt(0), 'SA check char ASCII');

assertEq(region[14], 0x00, 'VN byte 0');
assertEq(region[19], '1'.charCodeAt(0), 'VN check char ASCII');

const parsed = CodingZcs.parseZcsRegion(region);
assertEq(parsed.gm.body, '61630000', 'parsed GM body');
assertEq(parsed.gm.check, '5', 'parsed GM check');
assert(parsed.gm.valid, 'parsed GM valid');

assertEq(parsed.sa.body, '0000284803AC1400', 'parsed SA body');
assertEq(parsed.sa.check, 'G', 'parsed SA check');
assert(parsed.sa.valid, 'parsed SA valid');

assertEq(parsed.vn.body, '0000640620', 'parsed VN body');
assertEq(parsed.vn.check, '1', 'parsed VN check');
assert(parsed.vn.valid, 'parsed VN valid');

console.log('\n== SA code extraction ==');

// SA 0000284803AC1400 in binary (big-endian):
// Byte 0: 0x00, Byte 1: 0x00, Byte 2: 0x28 = 0b00101000 → bits 3,5 set
// Byte 3: 0x48 = 0b01001000 → bits 3,6 set (offset 24)
// etc.
const saCodes = CodingZcs.extractSaCodes('0000284803AC1400');
assert(saCodes.includes('019'), 'SA code 019 present'); // bit 19 from 0x28
assert(saCodes.includes('021'), 'SA code 021 present'); // bit 21 from 0x28
assert(saCodes.length > 0, 'SA codes extracted');

const saEmpty = CodingZcs.extractSaCodes('0000000000000000');
assertEq(saEmpty.length, 0, 'SA all zeros = no codes');

const saAll = CodingZcs.extractSaCodes('FFFFFFFFFFFFFFFF');
assertEq(saAll.length, 64, 'SA all F = 64 codes');

console.log('\n== FA/ZCS filtering ==');

const field1 = { name: 'TEST', asw: '206 302' };
const field2 = { name: 'OTHER', asw: null };
const field3 = { name: 'HIDDEN', asw: '999' };

assert(
  CodingZcs.matchesAsw(field1, ['206', '302', '400']),
  'field with matching SA shows'
);
assert(
  CodingZcs.matchesAsw(field1, ['206']),
  'field with one matching SA shows'
);
assert(
  !CodingZcs.matchesAsw(field1, ['400']),
  'field with no matching SA hidden'
);
assert(CodingZcs.matchesAsw(field2, ['206']), 'field with no asw always shows');
assert(
  !CodingZcs.matchesAsw(field3, []),
  'field requiring SA hidden when car has none'
);

console.log(
  '\n' + (fail ? `FAIL: ${fail} failed` : 'ZCS OK') + ` (${pass} passed)\n`
);
process.exit(fail ? 1 : 0);
