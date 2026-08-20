#!/usr/bin/env node
// The ECU memory reader's parsing, against the SGBDs' OWN argument specs.
//
// The thing worth guarding is the UNIT. kombi46's EEPROM_LESEN addresses
// 2-byte WORDS and counts WORDS ("max. 16 Worte = 32 Bytes"), while its
// ROM_LESEN addresses and counts BYTES ("max. 32 !"). A reader that assumed
// one unit for both produces a dump at half or double the intended scale and
// nothing about the output looks wrong. So: parse both from the real files
// and assert they come out different.
//
// Reads the built chassis archives when present, else data/ecu-src. No car.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
let failures = 0;
function ok(cond, msg) {
  if (cond) { console.log('  ok   ' + msg); return; }
  failures++; console.log('  FAIL ' + msg);
}

// --- load the module under test (browser global, no exports) ----------------
const src = fs.readFileSync(
  path.join(ROOT, 'app/renderer/screens/tuning-memory.js'), 'utf8');
// Mirror core.js: dataSets() unwraps, and flatResults() DELIBERATELY drops
// JOB_STATUS (core.js:177). That filtering is exactly what the status check
// has to survive, so the stubs reproduce it rather than simplifying it.
const dataSets = (sets) => (sets || []).filter(s => s && typeof s === 'object');
const flatResults = (sets) => {
  const out = [];
  dataSets(sets).forEach(s => Object.entries(s).forEach(([k, v]) => {
    if (!k.startsWith('_') && k !== 'JOB_STATUS') out.push([k, v]);
  }));
  return out;
};
let apiStub = async () => ({ sets: [] });
const sandbox = { window: {}, console };
new Function('window', 'api', 'flatResults', 'dataSets', src)(
  sandbox.window, (...a) => apiStub(...a), flatResults, dataSets);
const TM = sandbox.window.TuningMemory;
if (!TM) { console.error('tuning-memory.js did not export window.TuningMemory'); process.exit(1); }

(async () => {
console.log('range + count parsing');
{
  const r = TM._parseRange('Hexwert (0x00-0xFF) der WortAdresse ,ab der das EEPROM gelesen werden soll');
  ok(r && r.lo === 0x00 && r.hi === 0xFF, 'EEPROM address range 0x00-0xFF');
  const r2 = TM._parseRange('Hexwert (0x0000-0xFFFF) der Adresse ,ab der das Rom gelesen werden soll');
  ok(r2 && r2.hi === 0xFFFF, 'ROM address range 0x0000-0xFFFF');
  const r3 = TM._parseRange('Hexwert (0x80-0xDF) der Adresse ,ab der gelesen werden soll');
  ok(r3 && r3.lo === 0x80 && r3.hi === 0xDF, 'DPRAM address range 0x80-0xDF');
  ok(TM._parseRange('no range here') === null, 'a comment with no range yields null');
}
{
  const c = TM._parseCount('Anzahl der 2-Byte-Worte (max. 16 Worte = 32 Bytes), die ausgelesen werden koennen');
  ok(c.unit === 'word' && c.max === 16 && c.wordBytes === 2,
     'EEPROM counts 16 WORDS (2 bytes each), not 32 bytes');
  const c2 = TM._parseCount('Anzahl der Bytes (max. 32 !) die ausgelesen werden sollen ');
  ok(c2.unit === 'byte' && c2.max === 32 && c2.wordBytes === 1,
     'ROM counts 32 BYTES');
  ok(c.unit !== c2.unit, 'the two units differ -- the whole point of parsing them');
}

console.log('region assembly from a real spec');
{
  const spec = {
    job: 'EEPROM_LESEN',
    arguments: [
      { ARG: 'ADRESSE', ARGTYPE: 'string',
        ARGCOMMENT0: 'Hexwert (0x00-0xFF) der WortAdresse ,ab der das EEPROM gelesen werden soll' },
      { ARG: 'BYTE_ANZAHL', ARGTYPE: 'int',
        ARGCOMMENT0: 'Anzahl der 2-Byte-Worte (max. 16 Worte = 32 Bytes), die ausgelesen werden koennen' },
    ],
  };
  const r = TM._regionFromArgs('EEPROM_LESEN', spec);
  ok(r && r.lo === 0 && r.hi === 0xFF && r.max === 16 && r.unit === 'word',
     'EEPROM_LESEN region parsed whole');
  ok(r && r.order.join(';') === 'ADRESSE;BYTE_ANZAHL',
     'argument ORDER preserved from the spec (the ";" string depends on it)');
}
{
  // RAM_LESEN leads with a selector; its allowed values are quoted in the comment
  const spec = {
    job: 'RAM_LESEN',
    arguments: [
      { ARG: 'RAM_TYPE', ARGTYPE: 'string', ARGCOMMENT0: '"INTERN" ,"EXTERN" oder "DP_RAM" ' },
      { ARG: 'ADRESSE', ARGTYPE: 'string', ARGCOMMENT0: 'Hexwert (0x000-0xFFF) der Adresse ,ab der das Ram gelesen werden soll' },
      { ARG: 'BYTE_ANZAHL', ARGTYPE: 'int', ARGCOMMENT0: 'Anzahl der Bytes (max. 32 !) die ausgelesen werden sollen ' },
    ],
  };
  const r = TM._regionFromArgs('RAM_LESEN', spec);
  ok(r && r.selArg === 'RAM_TYPE', 'RAM_LESEN selector argument found');
  ok(r && r.types.join(',') === 'INTERN,EXTERN,DP_RAM',
     'RAM_LESEN selector values parsed: ' + (r ? r.types.join(',') : '-'));
  ok(r && r.order[0] === 'RAM_TYPE', 'selector stays first in the argument order');
}
{
  // a control job must NOT be mistaken for a readable region
  const spec = { job: 'STEUERN_LEUCHTE', arguments: [
    { ARG: 'LEUCHTE', ARGTYPE: 'string', ARGCOMMENT0: 'welche Leuchte' }] };
  ok(TM._regionFromArgs('STEUERN_LEUCHTE', spec) === null,
     'a job with no address+count is not a region');
}

console.log('DATEN parsing');
{
  const a = TM.parseBytes('01 BF 48 28 00 80');
  ok(a.length === 6 && a[0] === 0x01 && a[1] === 0xBF && a[5] === 0x80,
     'spaced hex string');
  const b = TM.parseBytes('01BF4828');
  ok(b.length === 4 && b[1] === 0xBF, 'unspaced hex string');
  const c = TM.parseBytes('1,191,72');
  ok(c.length === 3 && c[1] === 191, 'decimal byte list');
  ok(TM.parseBytes('').length === 0, 'empty DATEN yields no bytes');
  ok(TM.parseBytes(null).length === 0, 'null DATEN yields no bytes');
}

console.log('the real archives agree with the parser');
{
  // If the built archives are present, parse kombi46's specs straight out of
  // them: the test then guards against the EXPORT changing shape, not just
  // against my hand-copied fixtures.
  const arch = path.join(ROOT, 'dist-web/api/chassis/E46.chassis');
  if (!fs.existsSync(arch)) {
    console.log('  skip  dist-web/api/chassis/E46.chassis not built');
  } else {
    let checked = 0;
    try {
      const { execFileSync } = require('child_process');
      const py = `
import zipfile, io, json, sys
z = zipfile.ZipFile(${JSON.stringify(arch)})
inner = zipfile.ZipFile(io.BytesIO(z.read('ecu/kombi46.ecu')))
out = {}
for j in ('EEPROM_LESEN','ROM_LESEN','DPRAM_LESEN','RAM_LESEN'):
    try: out[j] = json.loads(inner.read('arguments/%s.json' % j))
    except KeyError: pass
print(json.dumps(out))
`;
      const specs = JSON.parse(execFileSync('python3', ['-c', py], { encoding: 'utf8' }));
      for (const [job, spec] of Object.entries(specs)) {
        const r = TM._regionFromArgs(job, spec);
        ok(r !== null, `${job}: parsed a region out of the shipped spec`);
        if (r) checked++;
      }
      const ee = TM._regionFromArgs('EEPROM_LESEN', specs.EEPROM_LESEN);
      const rom = TM._regionFromArgs('ROM_LESEN', specs.ROM_LESEN);
      if (ee && rom) {
        ok(ee.unit === 'word' && rom.unit === 'byte',
           'shipped specs still disagree on unit (EEPROM=word, ROM=byte)');
      }
    } catch (e) {
      console.log('  skip  could not read the archive: ' + e.message);
    }
    ok(checked > 0, `parsed ${checked} region specs from the real E46 archive`);
  }
}


console.log('a refused read is reported, not silently empty');
{
  // THE BUG THIS GUARDS: the status check originally read JOB_STATUS out of
  // flatResults(), which strips that very key -- so an ECU refusing the read
  // produced "no data" instead of an error, and the region looked empty.
  const region = { job: 'EEPROM_LESEN', lo: 0, hi: 0xFF, max: 16, unit: 'word',
                   wordBytes: 2, selArg: null, types: [],
                   order: ['ADRESSE', 'BYTE_ANZAHL'] };
  apiStub = async () => ({ sets: [{ JOB_STATUS: 'ERROR_ECU_CONDITIONS_NOT_CORRECT' }] });
  let threw = null;
  try {
    await TM.readChunk('kombi46', region, 0, 16);
  } catch (e) { threw = e; }
  ok(threw !== null, 'a non-OKAY JOB_STATUS throws rather than returning empty');
  ok(threw && /CONDITIONS_NOT_CORRECT/.test(threw.message),
     'the error carries the ECU\'s own status text');
  ok(threw && threw.arg === '0x00;16',
     'the failing argument is attached for display: ' + (threw && threw.arg));

  // ...and an OKAY read still works through the same path
  apiStub = async () => ({ sets: [{ JOB_STATUS: 'OKAY', DATEN: '01 BF 48 28' }] });
  const good = await TM.readChunk('kombi46', region, 0, 2);
  ok(good.bytes.length === 4 && good.bytes[1] === 0xBF, 'an OKAY read returns its bytes');
}

console.log('chunking walks the region in the job\'s own unit');
{
  const region = { job: 'EEPROM_LESEN', lo: 0, hi: 0xFF, max: 16, unit: 'word',
                   wordBytes: 2, selArg: null, types: [],
                   order: ['ADRESSE', 'BYTE_ANZAHL'] };
  const seen = [];
  apiStub = async (url) => {
    const arg = decodeURIComponent((url.match(/arg=([^&]*)/) || [])[1] || '');
    seen.push(arg);
    const [addr, n] = arg.split(';');
    const at = parseInt(addr.replace(/^0x/i, ''), 16);
    const words = parseInt(n, 10);
    const bytes = [];
    for (let w = 0; w < words; w++) { bytes.push((at + w) & 0xFF, 0xA0); }
    return { sets: [{ JOB_STATUS: 'OKAY',
      DATEN: bytes.map(b => b.toString(16).padStart(2, '0')).join(' ') }] };
  };
  const { bytes } = await TM.readRange('kombi46', region, region.lo, region.hi, () => true);
  ok(seen.length === 16, `256 words at 16/read = 16 calls (got ${seen.length})`);
  ok(seen[0] === '0x00;16' && seen[1] === '0x10;16',
     'addresses step by the chunk size in WORDS: ' + seen.slice(0, 2).join(', '));
  ok(bytes.length === 512, `256 words x 2 bytes = 512 bytes (got ${bytes.length})`);
  ok(bytes[32] === 0x10, 'chunk 2 landed at the right offset (word 16 -> byte 32)');
}

console.log('a short answer ends the walk');
{
  const region = { job: 'ROM_LESEN', lo: 0, hi: 0xFFFF, max: 32, unit: 'byte',
                   wordBytes: 1, selArg: null, types: [],
                   order: ['ADRESSE', 'BYTE_ANZAHL'] };
  let n = 0;
  apiStub = async () => {
    n++;
    return { sets: [{ JOB_STATUS: 'OKAY', DATEN: n <= 2 ? '00 11 22 33' : '' }] };
  };
  const { bytes } = await TM.readRange('kombi46', region, 0, 0xFFFF, () => true);
  ok(n === 3, `stopped after the first empty answer (${n} calls, not 2048)`);
  ok(bytes.length === 8, 'kept only what actually came back');
}


console.log('a simulated answer is flagged, not passed off as a read');
{
  // THE BUG THIS GUARDS: with no cable the shim answers demo:true with
  // invented bytes. The reader loaded them into the hex editor as if they had
  // come off the car -- a dump of fiction that looks exactly like a real one.
  const region = { job: 'DPRAM_LESEN', lo: 0x80, hi: 0xDF, max: 32, unit: 'byte',
                   wordBytes: 1, selArg: null, types: [],
                   order: ['ADRESSE', 'BYTE_ANZAHL'] };
  let calls = 0;
  apiStub = async () => {
    calls++;
    return { job: 'DPRAM_LESEN', demo: true,
             sets: [{ JOB_STATUS: 'OKAY', DATEN: '23' }] };
  };
  const chunk = await TM.readChunk('kombi46', region, 0x80, 32);
  ok(chunk.demo === true, 'readChunk reports demo:true from the response');

  calls = 0;
  const res = await TM.readRange('kombi46', region, region.lo, region.hi, () => true);
  ok(res.demo === true, 'readRange propagates the demo flag');
  ok(calls === 1, `stopped after the first simulated chunk (${calls} call, not 3)`);

  // and a real answer is NOT flagged
  apiStub = async () => ({ sets: [{ JOB_STATUS: 'OKAY', DATEN: '01 02 03 04' }] });
  const real = await TM.readRange('kombi46', region, 0x80, 0x83, () => true);
  ok(real.demo === false, 'a response with no demo badge reads as real');
  ok(real.bytes.length > 0, 'and still returns its bytes');
}

console.log(failures ? `\nFAILED (${failures})` : '\nAll memory-reader checks passed');
process.exit(failures ? 1 : 0);
})();
