#!/usr/bin/env node
// Group SGBDs resolve a diagnostic address to a concrete variant.
//
// data/groups/<g>.json.gz is ordinary VM bytecode (tools/export/
// sgbd_export.py); running its IDENTIFIKATION against a stubbed telegram
// sink must reproduce what EDIABAS's ResolveSgbdFile computes. Two
// dialects are pinned here against crafted ident answers derived from the
// bytecode itself (python3 tools/sgbd/sgbd_survey.py --dump d_00a4
// IDENTIFIKATION):
//
//   d_00a4 (old): hardcoded if/else over the DS2 ident answer. Request
//     [a4 04 00]; while answer[2] == 0xA1 (busy) it retries, at most 5
//     retries; 0xA0 is the ident answer, whose byte[9]/byte[8] pick the
//     variant (low nibble of [9]: 9 -> MRS4; else low nibble of [8]:
//     1 -> ZAE). 0xA2 means "fetch ident via a4 06 90 ff ff instead".
//   d_0032 (new): KWP read [b8 32 f1 02 1a 80], answer
//     [b8 f1 32 len 5a 80 ...] with len == total-5 and len >= 0x1f; the
//     bytecode assembles "<addr> <pattern> <code>" -- writing the '.'
//     wildcard characters into the key ITSELF -- and resolves it through
//     ZuordnungsTabelle (variants.json) with a plain exact tabseek.
//
// NEVER touches hardware: every VM here gets a stub send().
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');

let failures = 0;
function check(what, ok) {
  if (!ok) {
    failures++;
    console.log(`  FAIL  ${what}`);
  } else console.log(`  ok    ${what}`);
}

// ---- the floor: generated group data must EXIST. Like test_writeguard
// after its fix, a missing input is a loud FAILURE naming the regeneration
// step, never a quiet green -- a groups test that skipped when data/groups
// was absent would verify nothing on exactly the machine about to ship.
const GROUPS = path.join(ROOT, 'data', 'groups');
const needed = ['d_00a4.json.gz', 'd_0032.json.gz', 'variants.json'];
const absent = needed.filter((f) => !fs.existsSync(path.join(GROUPS, f)));
if (absent.length) {
  check(
    `data/groups present (missing: ${absent.join(', ')}` +
      ' -- regenerate with tools/export/sgbd_export.py --groups)',
    false
  );
  console.log(`\n${failures} FAILURES`);
  process.exit(1);
}

function loadGroup(name) {
  const gz = fs.readFileSync(path.join(GROUPS, `${name}.json.gz`));
  return JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
}
const variants = JSON.parse(
  fs.readFileSync(path.join(GROUPS, 'variants.json'), 'utf8')
);
check(
  'variants.json carries the ZuordnungsTabelle rows',
  variants.table === 'ZuordnungsTabelle' &&
    Array.isArray(variants.rows) &&
    variants.rows.length > 500
);

// ---- load the VM (and later webshim) the way the other verify tests do
const ctx = { module: { exports: {} }, console };
vm.createContext(ctx);
vm.runInContext(
  fs.readFileSync(path.join(ROOT, 'app/renderer/core/bestvm.js'), 'utf8'),
  ctx
);
const { Best2Vm, isWriteJob } = ctx.module.exports;

// IDENTIFIKATION is a pure read; the resolver must never need allowWrites.
// (Asserted, not assumed -- the classifier is pinned by test_write_gate.js
// and NOT modified here.)
check(
  'isWriteJob classifies IDENTIFIKATION as a read',
  isWriteJob('IDENTIFIKATION') === false
);

// Run a group's IDENTIFIKATION with a stub sink. No allowWrites: this is
// exactly how the live resolver runs it, so a classifier regression that
// turned IDENTIFIKATION into a write would fail loudly right here.
function runGroup(name, answerFn, opts = {}) {
  const code = loadGroup(name);
  const sends = [];
  const tables = Object.assign({}, code.tables || {});
  if (
    !Object.keys(tables).some(
      (k) => k.toUpperCase() === variants.table.toUpperCase()
    )
  ) {
    tables[variants.table] = variants.rows;
  }
  const machine = new Best2Vm(
    code,
    Object.assign(
      {
        tables,
        extTables: { t_grtb: { [variants.table]: variants.rows } },
        send: (req) => {
          const ans = answerFn(Array.from(req)) || [];
          sends.push(Array.from(req));
          return ans;
        },
      },
      opts
    )
  );
  return { sets: machine.run('IDENTIFIKATION', ''), sends };
}

function varianteOf(sets) {
  for (const s of sets || []) {
    if (typeof s.VARIANTE === 'string' && s.VARIANTE) return s.VARIANTE;
  }
  return null;
}

const A4_IDENT = String([0xa4, 4, 0]);

// ---- d_00a4: MRS4 via diag-index byte[9], low nibble 9.
// Answer frame shape follows data/sim-captures/vmfix.json: the request is
// the VM's raw bytes (no checksum -- the transport appends it), the
// response a full DS2 frame [addr, totalLen, status, payload..., chk].
{
  const ans = [0xa4, 0x0c, 0xa0, 0, 0, 0, 0, 0, 0x00, 0x09, 0, 0x01];
  const r = runGroup('d_00a4', (req) => (String(req) === A4_IDENT ? ans : []));
  check(
    'd_00a4: byte[9] low nibble 9 resolves to MRS4',
    varianteOf(r.sets) === 'MRS4'
  );
  check(
    'd_00a4: one exchange settles the direct-ident path',
    r.sends.length === 1
  );
}

// ---- d_00a4: byte[8] path (nibble 1) -> ZAE, when byte[9] matches nothing
{
  const ans = [0xa4, 0x0c, 0xa0, 0, 0, 0, 0, 0, 0x01, 0x00, 0, 0x01];
  const r = runGroup('d_00a4', (req) => (String(req) === A4_IDENT ? ans : []));
  check(
    'd_00a4: byte[8] low nibble 1 resolves to ZAE',
    varianteOf(r.sets) === 'ZAE'
  );
}

// ---- d_00a4: a busy ECU (0xA2 ack, then 0x90-read) still resolves
{
  const readIdent = String([0xa4, 6, 0x90, 0xff, 0xff]);
  let phase = 0;
  const r = runGroup('d_00a4', (req) => {
    if (String(req) === A4_IDENT) {
      // first: plain ack; after the 0x90 read: the ident answer
      return phase === 0
        ? [0xa4, 0x04, 0xa2, 0x02]
        : [0xa4, 0x0c, 0xa0, 0, 0, 0, 0, 0, 0x00, 0x09, 0, 0x01];
    }
    if (String(req) === readIdent) {
      phase = 1;
      return [0xa4, 0x04, 0xa0, 0x00];
    }
    return [];
  });
  check(
    'd_00a4: the 0xA2-ack + 0x90-read path also lands on MRS4',
    varianteOf(r.sets) === 'MRS4'
  );
}

// ---- d_00a4: 0xA1 means "busy, ask again" -- bounded at 5 retries
{
  const r = runGroup('d_00a4', (req) =>
    String(req) === A4_IDENT ? [0xa4, 0x04, 0xa1, 0x01] : []
  );
  const identSends = r.sends.filter((s) => String(s) === A4_IDENT).length;
  check(
    'd_00a4: a stuck-busy ECU is retried 5 times then given up on',
    identSends === 6 && varianteOf(r.sets) === null
  );
}

// ---- d_00a4: silence yields NO variant -- never a fake one
{
  const r = runGroup('d_00a4', () => []);
  check(
    'd_00a4: no answer -> no VARIANTE result (not a fake variant)',
    varianteOf(r.sets) === null
  );
}

// ---- d_0032: the ZuordnungsTabelle path. Pick a real row from
// variants.json and build the ident answer that assembles its key:
// "32 .2M. 0550" -> GS30. Key layout per the bytecode dump: addr = hex of
// answer[2]; code = answer[14],[15] as 4 hex digits; pattern = '.' +
// answer[16] + answer[17] + '.' when both chars are in [0-9A-Z]. The
// answer must satisfy the frame guards: [0]=b8 [1]=f1 [2]=addr,
// [3]=len=total-5 (>= 0x1f), [4]=0x5a (KWP positive reply to 0x1a).
{
  const row = variants.rows.find((x) => x.ADR_VAR_DIAG === '32 .2M. 0550');
  check(
    'variants.json still carries the "32 .2M. 0550" -> GS30 row',
    !!row && row.SGBD === 'GS30'
  );
  const ans = new Array(36).fill(0);
  ans[0] = 0xb8;
  ans[1] = 0xf1;
  ans[2] = 0x32;
  ans[3] = 0x1f;
  ans[4] = 0x5a;
  ans[5] = 0x80;
  ans[14] = 0x05;
  ans[15] = 0x50; // -> "0550"
  ans[16] = 0x32;
  ans[17] = 0x4d; // '2','M' -> ".2M."
  const r = runGroup('d_0032', (req) =>
    String(req) === String([0xb8, 0x32, 0xf1, 2, 0x1a, 0x80]) ? ans : []
  );
  check(
    'd_0032: crafted gearbox ident resolves through ZuordnungsTabelle ' +
      'to GS30',
    varianteOf(r.sets) === 'GS30'
  );
}

// ---- d_0032: an ident that matches NO row never invents a REAL variant.
// The bytecode's own miss path falls back to its LI_NR lookup, whose local
// "SGBD" table ends in BMW's deliberate catch-all row (LI_NR "XX" ->
// "XYZ") -- SeekTable clamps a miss to the last row, so the engine itself
// reports the XYZ sentinel there. Exports without local tables emit "".
// Either way: not a resolvable SGBD, and varianteOf/webResolveVariant
// callers get the sentinel or nothing, never a wrong module.
{
  const ans = new Array(36).fill(0);
  ans[0] = 0xb8;
  ans[1] = 0xf1;
  ans[2] = 0x32;
  ans[3] = 0x1f;
  ans[4] = 0x5a;
  ans[5] = 0x80;
  ans[14] = 0xee;
  ans[15] = 0xee; // key "32 0000 EEEE": no row
  const r = runGroup('d_0032', (req) =>
    String(req) === String([0xb8, 0x32, 0xf1, 2, 0x1a, 0x80]) ? ans : []
  );
  const v = varianteOf(r.sets);
  check(
    'd_0032: an unmatched ident yields the XYZ sentinel or nothing, ' +
      'never a real variant',
    v === null || v === 'XYZ'
  );
}

// ---- tabsetex semantics, pinned directly (OpTabsetex): a non-empty file
// name looks the table up in THAT file only -- found via extTables, and
// NEVER by falling back to the local tables.
{
  const syn = {
    format: 1,
    sgbd: 'syn',
    jobs: { IDENT_TABSETEX: 0 },
    ops: [
      [
        'tabsetex',
        [
          [8, 0],
          [8, 1],
        ],
      ],
      [
        'tabseek',
        [
          [8, 2],
          [8, 3],
        ],
      ],
      [
        'tabget',
        [
          [1, 'S1'],
          [8, 4],
        ],
      ],
      [
        'ergs',
        [
          [8, 5],
          [1, 'S1'],
        ],
      ],
      ['eoj', []],
    ],
    strings: [
      'ZuordnungsTabelle',
      't_grtb',
      'ADR_VAR_DIAG',
      '32 .2M. 0550',
      'SGBD',
      'VARIANTE',
    ],
  };
  const mk = (opts) =>
    new Best2Vm(syn, Object.assign({ send: () => [] }, opts));
  const viaExt = mk({
    extTables: { t_grtb: { ZuordnungsTabelle: variants.rows } },
  }).run('IDENT_TABSETEX', '');
  check(
    'tabsetex reaches ZuordnungsTabelle in the injected t_grtb',
    varianteOf(viaExt) === 'GS30'
  );
  const localOnly = mk({
    tables: { ZuordnungsTabelle: variants.rows }, // present, but LOCAL
  }).run('IDENT_TABSETEX', '');
  check(
    'tabsetex does NOT fall back to local tables (OpTabsetex has none)',
    varianteOf(localOnly) !== 'GS30'
  );
}

// ---- webshim's public resolver, end to end: loader (gz), variants.json,
// the VM drive loop, caching, and null-on-no-answer -- over a stubbed bus.
{
  const wctx = {
    module: { exports: {} },
    console,
    Date,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Error,
    URLSearchParams,
    TextDecoder,
    Promise,
    JSON,
    Response: class {
      /* never constructed: fetch below is the stub */
    },
  };
  wctx.window = wctx; // webshim exports onto `window`
  wctx.self = wctx;
  // serve data/groups/* from disk; gunzip in JS to mimic fflate
  wctx.fflate = {
    gunzipSync: (b) => zlib.gunzipSync(Buffer.from(b)),
    unzipSync: () => {
      throw new Error('not used here');
    },
  };
  wctx.fetch = async (p) => {
    const file = path.join(ROOT, String(p).replace(/^\//, ''));
    if (!fs.existsSync(file)) return { ok: false };
    const bytes = fs.readFileSync(file);
    return {
      ok: true,
      arrayBuffer: async () =>
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ),
      json: async () => JSON.parse(bytes.toString('utf8')),
    };
  };
  vm.createContext(wctx);
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'app/renderer/core/bestvm.js'), 'utf8'),
    wctx
  );
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'app/renderer/core/webshim.js'), 'utf8'),
    wctx
  );
  check(
    'webshim exports webResolveVariant on window',
    typeof wctx.window.webResolveVariant === 'function'
  );

  // stub the bus AFTER load: same object the resolver closed over
  let answer = null;
  let exchanges = 0;
  wctx.window.webBus.exchange = async (out) => {
    exchanges++;
    if (String(out) === String([0xa4, 4, 0]) && answer) return answer;
    // silence: the transport's honest behavior is an IFH-0009 throw
    const e = new Error('IFH-0009: no answer from ECU (timeout)');
    throw e;
  };

  (async () => {
    answer = [0xa4, 0x0c, 0xa0, 0, 0, 0, 0, 0, 0x00, 0x09, 0, 0x01];
    const v1 = await wctx.window.webResolveVariant('d_00a4');
    check(
      'webResolveVariant resolves d_00a4 -> "mrs4" (lowercased)',
      v1 === 'mrs4'
    );
    const before = exchanges;
    const v2 = await wctx.window.webResolveVariant('d_00a4');
    check(
      'a second resolve is served from the session cache (no exchange)',
      v2 === 'mrs4' && exchanges === before
    );
    answer = null;
    const v3 = await wctx.window.webResolveVariant('d_0032');
    check('webResolveVariant returns null when nothing answers', v3 === null);
    const v4 = await wctx.window.webResolveVariant('no_such_group');
    check('webResolveVariant returns null for an unshipped group', v4 === null);

    // ---- SILENCE ON ONE PROBE IS A STEP, NOT THE END OF THE JOB.
    // Ground truth: EDIABAS's own ifh.trc against a real E46 with an MS45.1.
    // d_0012 opens with a DS2 frame (12 04 00), tries B8 12 F1 01 A2, and only
    // its THIRD telegram (B8 12 F1 02 1A 80) is the one the DME answers --
    // EDIABAS logs SetError EDIABAS_IFH_0009 on the earlier probes and carries
    // on, because the bytecode branches on the answer's length (slen).
    //
    // Letting that rejection escape returned "no variant" for a DME that was
    // answering perfectly, and the sweep drew it as "not installed" while the
    // module held ten real stored faults.
    const tried = [];
    const MS45 = [
      0xb8, 0xf1, 0x12, 0x1f, 0x5a, 0x80, 0x00, 0x00, 0x07, 0x56, 0x13, 0x82,
      0x00, 0x00, 0x00, 0x11, 0x31, 0x43, 0x20, 0x03, 0x09, 0x03, 0x04, 0x00,
      0x0d, 0x91, 0xff, 0xff, 0xff, 0x02, 0x03, 0x01, 0xff, 0xff, 0xff, 0x8c,
    ];
    wctx.window.webBus.exchange = async (out) => {
      const a = Array.from(out);
      tried.push(a.map((b) => b.toString(16).padStart(2, '0')).join(' '));
      // the car answers ONLY the KWP2000* ident, exactly as captured
      if (a[0] === 0xb8 && a[1] === 0x12 && a[3] === 0x02 && a[4] === 0x1a) {
        return MS45;
      }
      const e = new Error('no answer from ECU (timeout)');
      e.ifh = 'IFH-0009';
      throw e;
    };
    const v5 = await wctx.window.webResolveVariant('d_0012');
    check(
      'd_0012 walks past its silent DS2 probe and resolves the MS45' +
        ` (tried ${tried.length} telegrams)`,
      v5 === 'ms450ds0'
    );
    check(
      'and it really did have to skip a silent probe first',
      tried.length >= 2 && /^12 04 00/.test(tried[0])
    );

    // The opposite case must still hold: an address where NOTHING answers is
    // absent. Without this the fix would turn every dead address into a
    // phantom module.
    wctx.window.webBus.exchange = async () => {
      const e = new Error('no answer from ECU (timeout)');
      e.ifh = 'IFH-0009';
      throw e;
    };
    const v6 = await wctx.window.webResolveVariant('d_0070');
    check('an address that answers NOTHING is still absent', v6 === null);

    console.log(
      failures ? `\n${failures} FAILURES` : '\ngroup variant resolution holds'
    );
    process.exit(failures ? 1 : 0);
  })().catch((e) => {
    check(`webshim resolver ran (${e.message})`, false);
    console.log(`\n${failures} FAILURES`);
    process.exit(1);
  });
}
