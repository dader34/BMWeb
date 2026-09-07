#!/usr/bin/env node
// Tuning > "Read memory from an ECU": the parts that decide what the dialog
// SAYS, checked against the SGBDs' own files. No car.
//
// THE BUG THIS PINS. On a real E46 the dialog offered dsc_mk60's
// SPEICHER_LESEN as "0x0000-0xFFFFFF · 16777216 bytes · 32/read" and every
// read ended in "ERROR_NUMBER · sent 0x0000;32". Both halves were wrong:
//   - "0x000000 - 0xFFFFFF" is the width of the ADDRESS ARGUMENT (297 SGBDs
//     say it), not the module's memory;
//   - the count comment "1 - n ( 4 )" means max 4 per read, and the parser
//     defaulted to 32 when it saw no "max.". The SGBD's own argument check
//     then set JOB_STATUS = ERROR_NUMBER and sent NOTHING -- replayed below
//     through the real bytecode -- while the dialog showed the token as if
//     the DSC had refused.
// So: count comments in every shape the corpus uses, field-width versus
// declared ranges, profile regions for the DS2 DMEs, the JobResult origin of
// a status token (ECU byte vs SGBD-side "?NN?" check), the sentences built
// from them, module ranking from the chassis config, and the identify step.
//
// Run: node tools/verify/test_tuning_read.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..', '..');
let failures = 0;
function ok(cond, msg) {
  if (cond) {
    console.log('  ok   ' + msg);
    return;
  }
  failures++;
  console.log('  FAIL ' + msg);
}
const gz = (rel) =>
  JSON.parse(
    zlib.gunzipSync(fs.readFileSync(path.join(ROOT, rel))).toString('utf8')
  );
const has = (rel) => fs.existsSync(path.join(ROOT, rel));

// --- the browser globals the module reaches for -----------------------------
global.Settings = { get: () => '', set: () => {} };
const F = require(path.join(ROOT, 'app/renderer/core/flasher.js'));
function loadVm(rel) {
  const ctx = { module: { exports: {} }, console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), ctx);
  return ctx.module.exports;
}
const { Best2Vm, isWriteJob } = loadVm('app/renderer/core/bestvm.js');

const dataSets = (sets) =>
  (sets || []).filter((s) => s && typeof s === 'object');
const flatResults = (sets) => {
  const out = [];
  dataSets(sets).forEach((s) =>
    Object.entries(s).forEach(([k, v]) => {
      if (!k.startsWith('_') && k !== 'JOB_STATUS') out.push([k, v]);
    })
  );
  return out;
};
let apiStub = async () => ({ sets: [] });
let fetchStub = async () => ({ ok: false });
let resolveStub = async () => null;
let resolveLast = () => null;
const src = fs.readFileSync(
  path.join(ROOT, 'app/renderer/screens/tuning-memory.js'),
  'utf8'
);
const sandbox = { window: {} };
new Function(
  'window',
  'api',
  'flatResults',
  'dataSets',
  'fetch',
  'webResolveVariant',
  'webResolveVariantLast',
  'FLASH_PROFILES',
  'isWriteJob',
  'Settings',
  src
)(
  sandbox.window,
  (...a) => apiStub(...a),
  flatResults,
  dataSets,
  (...a) => fetchStub(...a),
  (...a) => resolveStub(...a),
  () => resolveLast(),
  F.FLASH_PROFILES,
  isWriteJob,
  global.Settings
);
const TM = sandbox.window.TuningMemory;
if (!TM) {
  console.error('tuning-memory.js did not export window.TuningMemory');
  process.exit(1);
}

// arguments/<JOB>.json as web_export.py writes it, from the ecu-src meta
function specFor(meta, job) {
  const j = meta.jobs[job];
  return {
    job,
    arguments: (j.arguments || []).map((a) => {
      const row = { ARG: a.name, ARGTYPE: a.type || '' };
      (a.comments || []).forEach((c, i) => (row[`ARGCOMMENT${i}`] = c));
      return row;
    }),
  };
}
const resultsFor = (meta, job) =>
  (meta.jobs[job].results || []).map((r) => `${r.name} : ${r.comment || ''}`);

(async () => {
  console.log('count comments, every shape the corpus uses');
  {
    const cases = [
      ['1 - n ( 4 )', 4, 'byte'],
      ['1 - n ( 254 )', 254, 'byte'],
      ['Anzahl auszulesende Bytes 1 - n ( 254 )', 254, 'byte'],
      ['1 - 32', 32, 'byte'],
      ['1 bis 16', 16, 'byte'],
      ['gewuenschte Anzahl Bytes (2-28)', 28, 'byte'],
      ['Anzahl der zu lesenden Bytes (1..249)', 249, 'byte'],
      ['Number of bytes of data to read, 1 -> 32', 32, 'byte'],
      ['Anzahl Bytes von 1 (0x01) bis 112 (0x70)', 112, 'byte'],
      ['Anzahl Bytes >=1 und <=32', 32, 'byte'],
      ['Anzahl der Datenbytes: 1 bis 16 (0x10)', 16, 'byte'],
      ['0-255 bzw. 0x00-0xFF', 255, 'byte'],
      ['gewuenschte Anzahl Datenbytes, max. 24!', 24, 'byte'],
      [
        'Anzahl der Bytes (max. 32 !) die ausgelesen werden sollen ',
        32,
        'byte',
      ],
      [
        'Anzahl der 2-Byte-Worte (max. 6 Worte = 12 Bytes), die ausgelesen werden sollen',
        6,
        'word',
      ],
      [
        'Anzahl der Worte (max. 16 !) die ausgelesen werden sollen ',
        16,
        'word',
      ],
      ['normal 16', 16, 'byte'],
    ];
    for (const [c, max, unit] of cases) {
      const r = TM._parseCount(c);
      ok(
        r.known && r.max === max && r.unit === unit,
        `${JSON.stringify(c)} -> ${max} ${unit}s (got ${r.max} ${r.unit}, known=${r.known})`
      );
    }
    for (const c of [
      'Uebergabeparameter, Anzahl der auszulesenden BYTES',
      'Uebergabeparameter, Anzahl der auszulesenden BYTES in Hex 0x3',
      'Anzahl zu lesender Bytes',
      '',
    ]) {
      const r = TM._parseCount(c);
      ok(
        !r.known && r.max === null,
        `${JSON.stringify(c)} -> unknown, NOT a guessed 32 (got ${r.max})`
      );
    }
  }

  console.log('address comments: a field width is not a memory map');
  {
    const f24 = TM._parseRange('0x000000 - 0xFFFFFF');
    ok(
      f24 && f24.kind === 'field' && f24.digits === 6 && f24.hi === 0xffffff,
      '"0x000000 - 0xFFFFFF" is a 24-bit address FIELD'
    );
    const f16 = TM._parseRange('Bereich: 0-65535 bzw. 0x0000-0xFFFF');
    ok(
      f16 && f16.kind === 'field' && f16.digits === 4,
      '"0x0000-0xFFFF" is a 16-bit field'
    );
    const d1 = TM._parseRange(
      'Hexwert (0x80-0xDF) der Adresse ,ab der gelesen werden soll'
    );
    ok(
      d1 && d1.kind === 'declared' && d1.lo === 0x80 && d1.hi === 0xdf,
      '0x80-0xDF is a declared region'
    );
    const d2 = TM._parseRange('0x0000 - 0x0FFF');
    ok(
      d2 && d2.kind === 'declared' && d2.hi === 0x0fff,
      '0x0000 - 0x0FFF is declared (not all-F)'
    );
    const d3 = TM._parseRange('0x0001 - 0x0FFF');
    ok(
      d3 && d3.kind === 'declared' && d3.lo === 1,
      '0x0001 - 0x0FFF is declared'
    );
    ok(
      TM._parseRange('Startadresse High-Middle-Low') === null,
      'no hex pair -> null'
    );
  }

  console.log('memory kind from the job name');
  {
    ok(TM._memoryKind('EEPROM_LESEN') === 'EEPROM', 'EEPROM_LESEN -> EEPROM');
    ok(
      TM._memoryKind('DPRAM_LESEN') === 'DPRAM',
      'DPRAM_LESEN -> DPRAM (not RAM)'
    );
    ok(TM._memoryKind('RAM_LESEN') === 'RAM', 'RAM_LESEN -> RAM');
    ok(TM._memoryKind('ROM_LESEN') === 'ROM', 'ROM_LESEN -> ROM');
    ok(TM._memoryKind('FLASH_LESEN') === 'Flash', 'FLASH_LESEN -> Flash');
    ok(
      TM._memoryKind('SPEICHER_LIN_LESEN') === 'Memory',
      'SPEICHER_LIN_LESEN -> Memory'
    );
  }

  const dscMeta = has('data/ecu-src/dsc_mk60.meta.json.gz')
    ? gz('data/ecu-src/dsc_mk60.meta.json.gz')
    : null;
  const ms43Meta = has('data/ecu-src/ms430ds0.meta.json.gz')
    ? gz('data/ecu-src/ms430ds0.meta.json.gz')
    : null;
  const kombiMeta = has('data/ecu-src/kombi46.meta.json.gz')
    ? gz('data/ecu-src/kombi46.meta.json.gz')
    : null;

  console.log('regions from the real specs (data/ecu-src)');
  if (!dscMeta || !ms43Meta || !kombiMeta) {
    console.log('  skip  data/ecu-src not present');
  } else {
    const dsc = TM._regionFromArgs(
      'SPEICHER_LESEN',
      specFor(dscMeta, 'SPEICHER_LESEN')
    );
    ok(
      dsc && dsc.max === 4 && dsc.maxKnown,
      `dsc_mk60 SPEICHER_LESEN: 4 per read, not 32 (got ${dsc && dsc.max})`
    );
    ok(
      dsc && dsc.rangeKind === 'field' && dsc.addrDigits === 6,
      'dsc_mk60: 24-bit address field, extent unknown'
    );
    ok(
      dsc && dsc.addrArg === 'ADRESSE' && dsc.lenArg === 'ANZAHL',
      'dsc_mk60: argument names carried'
    );
    ok(
      dsc && TM._chunkArg(dsc, 0, 4) === '0x000000;4',
      `dsc_mk60: first chunk sends 0x000000;4 (got ${dsc && TM._chunkArg(dsc, 0, 4)})`
    );
    ok(
      TM._dataField('SPEICHER_LESEN', resultsFor(dscMeta, 'SPEICHER_LESEN')) ===
        'DATEN',
      'dsc_mk60: bytes come back in DATEN'
    );

    const ms43 = TM._regionFromArgs(
      'SPEICHER_LIN_LESEN',
      specFor(ms43Meta, 'SPEICHER_LIN_LESEN')
    );
    ok(
      ms43 !== null,
      'ms430ds0 SPEICHER_LIN_LESEN is offered although it declares no range'
    );
    ok(
      ms43 && ms43.rangeKind === 'unknown' && ms43.hi === null,
      'ms430ds0: range reported as not declared'
    );
    ok(
      ms43 && !ms43.maxKnown && ms43.max === TM.UNKNOWN_CHUNK,
      'ms430ds0: per-read reported as not declared'
    );
    ok(
      ms43 && ms43.addrDigits === 6,
      'ms430ds0: "High-Middle-Low" -> 6 hex digits'
    );
    ok(
      ms43 && TM._chunkArg(ms43, 0x70000, 128) === '0x070000;128',
      `ms430ds0: chunk arg by the job's own names (got ${ms43 && TM._chunkArg(ms43, 0x70000, 128)})`
    );
    ok(
      TM._dataField(
        'SPEICHER_LIN_LESEN',
        resultsFor(ms43Meta, 'SPEICHER_LIN_LESEN')
      ) === 'SPEICHER_LIN_LESEN_WERT',
      'ms430ds0: bytes come back in SPEICHER_LIN_LESEN_WERT, not DATEN'
    );

    const ee = TM._regionFromArgs(
      'EEPROM_LESEN',
      specFor(kombiMeta, 'EEPROM_LESEN')
    );
    ok(
      ee && ee.unit === 'word' && ee.max === 16 && ee.rangeKind === 'field',
      'kombi46 EEPROM_LESEN: 16 words/read over an 8-bit word-address field'
    );
    const dp = TM._regionFromArgs(
      'DPRAM_LESEN',
      specFor(kombiMeta, 'DPRAM_LESEN')
    );
    ok(
      dp && dp.rangeKind === 'declared' && dp.lo === 0x80 && dp.hi === 0xdf,
      'kombi46 DPRAM_LESEN: declared 0x80-0xDF'
    );
  }

  console.log('a split address (H_ADR/L_ADR) is not driven');
  {
    const r = TM._regionFromArgs('SPEICHER_LESEN', {
      arguments: [
        { ARG: 'H_ADR', ARGCOMMENT0: 'Startadresse High-Byte' },
        { ARG: 'L_ADR', ARGCOMMENT0: 'Startadresse Low-Byte' },
        { ARG: 'ANZAHL', ARGCOMMENT0: '1 - 16' },
      ],
    });
    ok(
      r === null,
      'two address arguments -> null rather than a wrong telegram'
    );
  }

  console.log('flash profiles feed the DS2 DMEs');
  {
    const regs = TM._profileRegions('ms430ds0');
    ok(regs.length === 2, `ms430ds0: two profile regions (got ${regs.length})`);
    const data = regs.find((r) => /calib/i.test(r.label));
    ok(
      data && data.lo === 0x70000 && data.hi === 0x7ffff && data.max === 128,
      'MS43 calibration 0x70000-0x7FFFF, 128/read'
    );
    ok(
      data &&
        data.job === 'SPEICHER_LIN_LESEN' &&
        data.resultField === 'SPEICHER_LIN_LESEN_WERT',
      'MS43 profile job and result field'
    );
    ok(
      data && data.argFor(0x70000, 128) === '0x070000;128',
      "MS43 profile arg builder: '0x070000;128'"
    );
    ok(data && !data.locked, 'MS43 needs no unlock: not locked');
    const full = regs.find((r) => /full/i.test(r.label));
    ok(
      full && full.lo === 0 && full.hi === 0x7ffff,
      'MS43 full flash 0x00000-0x7FFFF'
    );
    const ms45 = TM._profileRegions('ms450ds0');
    ok(
      ms45.length > 0 && ms45.every((r) => r.locked),
      'MS45 regions are listed but locked (unlock session lives in ECU Backup)'
    );
    ok(TM._profileRegions('dsc_mk60').length === 0, 'dsc_mk60 has no profile');
  }

  console.log('status origin from the real JobResult tables');
  if (!has('data/ecu-src/dsc_mk60.tables.json.gz')) {
    console.log('  skip  tables not present');
  } else {
    const dscRows = gz('data/ecu-src/dsc_mk60.tables.json.gz').JOBRESULT;
    const en = TM._classifyStatus('ERROR_NUMBER', dscRows);
    ok(
      en.origin === 'sgbd' && en.sb === '?22?',
      `ERROR_NUMBER is an SGBD-side check (${en.sb}), nothing was sent`
    );
    ok(
      /count/.test(en.gloss),
      `ERROR_NUMBER gloss names the count: ${en.gloss}`
    );
    const oor = TM._classifyStatus('ERROR_ECU_REQUEST_OUT_OF_RANGE', dscRows);
    ok(
      oor.origin === 'ecu' && oor.sb === '0x31',
      'ERROR_ECU_REQUEST_OUT_OF_RANGE is the ECU byte 0x31'
    );
    const msRows = gz('data/ecu-src/ms430ds0.tables.json.gz').JOBRESULT;
    const rej = TM._classifyStatus('ERROR_ECU_REJECTED', msRows);
    ok(
      rej.origin === 'ecu' && rej.sb === '0xA2',
      'MS43 ERROR_ECU_REJECTED is the ECU byte 0xA2'
    );
    const unk = TM._classifyStatus('SOMETHING_ELSE', msRows);
    ok(unk.origin === 'unknown', 'a token no table names is origin unknown');
    ok(
      TM._statusGloss('ERROR_ECU_FOO_BAR') === 'foo bar',
      'an unlisted ERROR_ECU_* still reads as words'
    );
  }

  console.log('the sentences');
  {
    const a = TM.explainFailure({
      status: 'ERROR_NUMBER',
      origin: 'sgbd',
      sb: '?22?',
      gloss: 'byte count out of the range the job allows',
      arg: '0x0000;32',
      job: 'SPEICHER_LESEN',
      sgbd: 'dsc_mk60',
    });
    ok(
      /before transmitting/.test(a.headline) && /ERROR_NUMBER/.test(a.headline),
      `sgbd-side: ${a.headline}`
    );
    ok(
      /Nothing was sent/.test(a.detail) && /0x0000;32/.test(a.detail),
      `sgbd-side detail: ${a.detail}`
    );
    const b = TM.explainFailure({
      status: 'ERROR_ECU_REQUEST_OUT_OF_RANGE',
      origin: 'ecu',
      sb: '0x31',
      gloss: 'address or length outside what the module allows',
      arg: '0x000000;4',
      sgbd: 'dsc_mk60',
    });
    ok(
      /dsc_mk60 rejected the read/.test(b.headline),
      `ecu-side: ${b.headline}`
    );
    ok(/0x31/.test(b.detail), `ecu-side detail names the byte: ${b.detail}`);
    const c = TM.explainFailure({
      message: 'IFH-0009: the ECU did not answer any telegram in this job',
      sgbd: 'dsc_mk60',
    });
    ok(
      /dsc_mk60 did not answer on the bus/.test(c.headline),
      `silence: ${c.headline}`
    );
    const d = TM.explainFailure({ message: 'no cable connected' });
    ok(/No cable/.test(d.headline), `no cable: ${d.headline}`);
    ok(
      /did not answer on the bus/.test(
        TM.identText('dsc_mk60', { state: 'silent' })
      ),
      'identText silent'
    );
    ok(
      /identifies as ms450ds0, not ms430ds0/.test(
        TM.identText('ms430ds0', { state: 'variant', variant: 'ms450ds0' })
      ),
      'identText variant'
    );
    ok(
      /BMW no\. 1234/.test(
        TM.identText('ms430ds0', { state: 'ok', ident: { ID_BMW_NR: '1234' } })
      ),
      'identText ok'
    );
  }

  console.log('module ranking from the chassis config');
  if (!has('data/chassis-config/E46.json')) {
    console.log('  skip  data/chassis-config/E46.json not present');
  } else {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'data/chassis-config/E46.json'), 'utf8')
    );
    const all = ['zzz_other', 'ms430ds0', 'dsc_mk60', 'kombi46', 'ms450ds0'];
    const r = TM.rankModules(all, cfg);
    const ms43 = r.car.find((x) => x.sgbd === 'ms430ds0');
    ok(
      ms43 && ms43.group === 'd_0012' && /MS43/.test(ms43.label),
      `ms430ds0 ranked as the car's, group d_0012, label ${ms43 && ms43.label}`
    );
    const dsc = r.car.find((x) => x.sgbd === 'dsc_mk60');
    ok(dsc && dsc.group === 'd_abskwp', 'dsc_mk60 ranked with group d_abskwp');
    ok(r.car[0].sgbd === 'ms430ds0', 'config order kept: the DME comes first');
    ok(
      r.other.length === 1 && r.other[0] === 'zzz_other',
      'everything else under other'
    );
    ok(
      !r.car.some((x) => !all.includes(x.sgbd)),
      'a config row whose SGBD is not in the build is not offered'
    );
    const none = TM.rankModules(all, null);
    ok(
      none.car.length === 0 && none.other.length === all.length,
      'no config: all under other'
    );
  }

  console.log('the root cause, replayed through the real bytecode');
  if (!has('data/ecu-src/dsc_mk60.job-code.json.gz')) {
    console.log('  skip  job-code not present');
  } else {
    const code = gz('data/ecu-src/dsc_mk60.job-code.json.gz');
    const tables = gz('data/ecu-src/dsc_mk60.tables.json.gz');
    const run = (arg) => {
      const sent = [];
      const v = new Best2Vm(code, {
        tables,
        args: arg,
        allowWrites: false,
        inited: true,
        shared: {},
        send: (out) => {
          sent.push(Array.from(out));
          return new Uint8Array(0);
        },
      });
      const sets = v.run('SPEICHER_LESEN', arg);
      return { sent, status: (sets[0] && sets[0].JOB_STATUS) || '' };
    };
    const bad = run('0x0000;32');
    ok(
      bad.status === 'ERROR_NUMBER' && bad.sent.length === 0,
      `';32' -> ERROR_NUMBER with NO telegram sent (sent ${bad.sent.length})`
    );
    const good = run('0x000000;4');
    ok(
      good.sent.length > 0,
      `';4' (the declared max) transmits (${good.sent.length} telegram)`
    );
  }

  console.log('reads through the region shapes');
  {
    // MS43 on a silent bus: the VM decodes zeros under ERROR_ECU_UNKNOWN_STATUSBYTE.
    // Those zeros must never become an image.
    const [prof] = TM._profileRegions('ms430ds0');
    apiStub = async () => ({
      sets: [
        {
          JOB_STATUS: 'ERROR_ECU_UNKNOWN_STATUSBYTE',
          SPEICHER_LIN_LESEN_WERT: new Array(128).fill(0),
        },
      ],
    });
    let threw = null;
    try {
      await TM.readChunk('ms430ds0', prof, 0x70000, 128);
    } catch (e) {
      threw = e;
    }
    ok(
      threw && threw.jobStatus === 'ERROR_ECU_UNKNOWN_STATUSBYTE',
      'zeros under a non-OKAY status are refused'
    );
    ok(
      threw &&
        threw.arg === '0x070000;128' &&
        threw.job === 'SPEICHER_LIN_LESEN',
      'the failing arg and job ride on the error'
    );

    // ...and a real MS43 answer lands in the profile's result field, as numbers
    let seen = [];
    apiStub = async (url) => {
      seen.push(decodeURIComponent((url.match(/arg=([^&]*)/) || [])[1] || ''));
      return {
        sets: [{ JOB_STATUS: 'OKAY', SPEICHER_LIN_LESEN_WERT: [1, 2, 3, 4] }],
      };
    };
    const one = await TM.readChunk('ms430ds0', prof, 0x70000, 4);
    ok(
      one.bytes.length === 4 && one.bytes[3] === 4,
      'a number-array *_WERT is parsed'
    );
    ok(TM.parseBytes('01-BF-48').length === 3, 'dash-separated hex is parsed');

    // opts.chunk overrides the per-read count, and a profile span exceeds the 64 KB cap
    seen = [];
    apiStub = async (url) => {
      const arg = decodeURIComponent((url.match(/arg=([^&]*)/) || [])[1] || '');
      seen.push(arg);
      const n = parseInt(arg.split(';')[1], 10);
      return {
        sets: [
          { JOB_STATUS: 'OKAY', SPEICHER_LIN_LESEN_WERT: new Array(n).fill(7) },
        ],
      };
    };
    const res = await TM.readRange(
      'ms430ds0',
      prof,
      0x70000,
      0x7ffff,
      () => true,
      { chunk: 255 }
    );
    ok(seen[0] === '0x070000;255', `chunk override honoured: ${seen[0]}`);
    ok(
      res.bytes.length === 0x10000,
      `64 KB profile read completes (${res.bytes.length})`
    );
  }

  console.log('identify');
  {
    fetchStub = async () => ({
      ok: true,
      json: async () => ({ groups: ['d_0012'] }),
    });
    // group path: the car answers with the OTHER DME variant
    resolveStub = async (g) => (g === 'd_0012' ? 'ms450ds0' : null);
    let r = await TM.identify('ms430ds0', 'D_0012');
    ok(
      r.state === 'variant' && r.variant === 'ms450ds0',
      'group probe names a different variant'
    );
    // group path: silence
    resolveStub = async () => null;
    resolveLast = () => ({ group: 'd_0012', path: 'bus-silent' });
    r = await TM.identify('ms430ds0', 'd_0012');
    ok(r.state === 'silent', 'group probe silence -> silent');
    resolveLast = () => ({ group: 'd_0012', path: 'answered-but-unmatched' });
    r = await TM.identify('ms430ds0', 'd_0012');
    ok(r.state === 'unmatched', 'answered-but-unmatched -> unmatched');
    // group not runnable -> IDENT path
    apiStub = async (url) => {
      if (/\/jobs$/.test(url)) return ['IDENT', 'SPEICHER_LESEN'];
      throw new Error(
        'IFH-0009: the ECU did not answer any telegram in this job'
      );
    };
    r = await TM.identify('dsc_mk60', 'd_nothing');
    ok(r.state === 'silent', 'IDENT with no answer -> silent');
    apiStub = async (url) => {
      if (/\/jobs$/.test(url)) return ['IDENT'];
      throw new Error('no cable connected');
    };
    r = await TM.identify('dsc_mk60', null);
    ok(r.state === 'no-cable', 'IDENT without a cable -> no-cable');
    apiStub = async (url) => {
      if (/\/jobs$/.test(url)) return ['IDENT'];
      return {
        sets: [
          { JOB_STATUS: 'OKAY', ID_BMW_NR: '34521164895', ID_HW_NR: '12' },
        ],
      };
    };
    r = await TM.identify('dsc_mk60', null);
    ok(
      r.state === 'ok' && r.ident.ID_BMW_NR === '34521164895',
      'IDENT answering -> ok with the part number'
    );
    apiStub = async (url) => {
      if (/\/jobs$/.test(url)) return ['FS_LESEN'];
      return { sets: [] };
    };
    r = await TM.identify('foo', null);
    ok(
      r.state === 'unknown',
      'no IDENT job -> unknown (read proceeds, says so)'
    );
  }

  console.log(
    'selector values from the referenced table; group-confirmed ident'
  );
  {
    // MS45's SPEICHER_LESEN leads with SEGMENT, whose legal values are the
    // SEG_NAME column of SpeicherSegment -- not quoted in the comment.
    apiStub = async (url) => {
      if (/\/jobs$/.test(url)) return ['SPEICHER_LESEN', 'SPEICHER_SCHREIBEN'];
      if (/\/arguments\//.test(url))
        return {
          job: 'SPEICHER_LESEN',
          arguments: [
            {
              ARG: 'SEGMENT',
              ARGTYPE: 'string',
              ARGCOMMENT0: 'table SpeicherSegment SEG_NAME SEG_TEXT',
            },
            {
              ARG: 'ADRESSE',
              ARGTYPE: 'long',
              ARGCOMMENT0: '0x000000 - 0xFFFFFF',
            },
            { ARG: 'ANZAHL', ARGTYPE: 'int', ARGCOMMENT0: '1 - n ( 254 )' },
          ],
        };
      if (/\/results\//.test(url))
        return [
          'DATEN : ausgelesene Daten',
          'JOB_STATUS : OKAY, wenn fehlerfrei',
        ];
      if (/\/table\/SPEICHERSEGMENT$/.test(url))
        return [
          { SEG_BYTE: '0x00', SEG_NAME: 'LAR', SEG_TEXT: 'linearAdressRange' },
          {
            SEG_BYTE: '0x01',
            SEG_NAME: 'ROMI',
            SEG_TEXT: 'ROM / EPROM, internal',
          },
        ];
      throw new Error('unexpected ' + url);
    };
    const regs = await TM.regionsFor('nobody');
    const spec = regs.find((r) => r.source === 'spec');
    ok(
      spec && spec.types.join(',') === 'LAR,ROMI',
      `selector values filled from the table: ${spec && spec.types.join(',')}`
    );
    ok(
      spec && TM._chunkArg(spec, 0, 254) === 'LAR;0x000000;254',
      `first chunk arg: ${spec && TM._chunkArg(spec, 0, 254)}`
    );
    ok(
      !regs.some((r) => /SCHREIBEN/.test(r.job)),
      'a write job never becomes a region'
    );

    fetchStub = async () => ({
      ok: true,
      json: async () => ({ groups: ['d_0012'] }),
    });
    resolveStub = async () => 'ms430ds0';
    apiStub = async (url) => {
      if (/\/jobs$/.test(url)) return ['SPEICHER_LIN_LESEN']; // no IDENT
      throw new Error('unexpected ' + url);
    };
    const r = await TM.identify('ms430ds0', 'd_0012');
    ok(
      r.state === 'ok' && r.group === 'd_0012',
      'group probe naming the module counts as identified even without IDENT'
    );
  }

  console.log(
    failures
      ? `\nFAILED (${failures})`
      : '\nAll tuning read-dialog checks passed'
  );
  process.exit(failures ? 1 : 0);
})();
