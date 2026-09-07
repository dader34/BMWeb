// The vehicle order as a ZCS-era module stores it, decoded by BMW's own
// decoder running in our VM.
//
// An E46 coding module answers C_FA_LESEN with the raw FA memory: a bit-packed
// stream, six bits a character, no marker characters. EDIABAS ships FA.PRG to
// turn that into the marker-delimited order. The stream below was read off a
// real 2004 325i (both the cluster and the light module returned it, byte for
// byte) and its decode was cross-checked against a second, independent BEST/2
// interpreter, so this pins two things at once: that the fa SGBD's decoder
// runs in bestvm, and that the string opcodes it leans on (serase at the end
// of a one-byte string, a shifted identifier read) behave.
//
//   node tools/verify/test_fa_stream.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');
global.window = global;
const { Best2Vm } = require(
  path.join(ROOT, 'app/renderer/core/bestvm/index.js')
);

const rd = (f) =>
  JSON.parse(
    zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'data', 'ecu-src', f)))
  );
const code = rd('fa.job-code.json.gz');
let tables = {};
try {
  tables = rd('fa.tables.json.gz');
} catch (e) {
  /* the decoder needs no tables beyond its own */
}

const STREAM_HEX =
  '02 41 94 14 95 45 bf 97 44 d7 41 35 54 ad 4c f7 41 04 10 41 04 10 41 04 ' +
  '10 41 04 10 41 04 10 42 11 8e 14 90 55 24 50 49 44 12 51 94 97 65 35 54 ' +
  '51 04 d4 45 15 13 45 44 d8 51 44 54 55 95 17 4d 46 18 51 95 14 65 55 52 ' +
  '41 54 91 55 35 15 55 05 93 65 65 15 59 54 16 59 15 97 59 66 52 61 16 18 ' +
  '49 36 13 49 85 15 61 54 d8 5d 66 52 55 94 96 65 94 8c 59 34 ec';
const STANDARD_FA =
  'E46_#0904*ET37%0354&K4SW$1CA$205$210$240$249$279$354$403$411$431$438' +
  '$441$459$473$488$494$495$520$521$534$550$639$645$650$661$676$692$818' +
  '$823$832$845$853$876$925$926$992+633L';

const bytes = STREAM_HEX.split(/\s+/).map((h) => parseInt(h, 16));
assert.strictEqual(bytes.length, 117);

function run(job, args) {
  const vm = new Best2Vm(code, {
    tables,
    args,
    allowWrites: true,
    send: () => {
      throw new Error('FA.PRG must not touch the wire');
    },
  });
  const sets = vm.run(job);
  return new Map(sets.flatMap((s) => Object.entries(s)));
}

let passed = 0;
const ok = (what) => {
  passed++;
  if (process.env.V) console.log('  ok', what);
};

{
  // The argument travels the way the app sends it: the stream as the
  // CP1252 text the engine publishes binary results as.
  const r = run('FA_STREAM2STRUCT', '1;' + Best2Vm.bytesStr(bytes));
  assert.strictEqual(r.get('JOB_STATUS'), 'OKAY');
  assert.strictEqual(r.get('BR'), 'E46_');
  assert.strictEqual(r.get('C_DATE'), '0904');
  assert.strictEqual(r.get('C_TYP'), 'ET37');
  assert.strictEqual(r.get('LACK'), '0354');
  assert.strictEqual(r.get('POLSTER'), 'K4SW');
  assert.strictEqual(r.get('STANDARD_FA'), STANDARD_FA);
  assert.strictEqual(Number(r.get('SA_ANZ')), 36);
  assert.strictEqual(r.get('SA_1'), '1CA');
  assert.strictEqual(r.get('SA_36'), '992');
  assert.strictEqual(r.get('HO_WORT_1'), '633L');
  ok('FA_STREAM2STRUCT: the 325i stream decodes to its full order');
}

{
  // And back: the encoder reproduces the module's bytes from the text, so
  // the two directions agree with each other and with the car.
  const r = run('FA_STREAM_FOR_ECU', `1;02;${STANDARD_FA}`);
  assert.strictEqual(r.get('JOB_STATUS'), 'OKAY');
  const bin = r.get('FA_STREAM_FOR_ECU_BIN');
  const got = Array.isArray(bin)
    ? bin.map((b) => Number(b) & 0xff)
    : Array.from(Best2Vm.strBytes(String(bin)));
  // the module pads its region; the encoder stops at the order's end
  assert.deepStrictEqual(got.slice(0, 116), bytes.slice(0, 116));
  ok('FA_STREAM_FOR_ECU: the text re-encodes to the bytes the car holds');
}

{
  // A blank region must decode to "no order", not to a phantom one.
  const r = run(
    'FA_STREAM2STRUCT',
    '1;' + Best2Vm.bytesStr(new Array(117).fill(0xff))
  );
  assert.notStrictEqual(r.get('JOB_STATUS'), 'OKAY');
  ok('FA_STREAM2STRUCT: an erased region is refused');
}

console.log(`fa-stream: ${passed} tests passed`);
