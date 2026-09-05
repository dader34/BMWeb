// ECU firmware READ / BACKUP over the cable, in the browser.
//
// Ported from the read path of terraphantm/MS45-Flasher (GPLv3) and its C# port
// in src/EdiabasMac/FlashService.cs, but driven through the browser's own job
// runner (webRunJob over Web Serial) so it ships in the web app instead of a
// native shell. READ ONLY: there is no erase/write/program path here -- a full
// backup is the whole feature, and writing an ECU is how you brick it.
//
// The read loop is ECU-agnostic; everything ECU-specific lives in a PROFILE
// (FLASH_PROFILES below): how to identify the DME, whether/how to unlock a
// security-access session, and which memory regions to read with which job.
// MS45 and the MSx70 family need an RSA seed/key and a programming-mode
// session; the C167 DS2 DMEs (MS42/MS43) read unauthenticated through the
// SGBD's linear memory job. The MSx70 read path is ported from the GPLv3
// MSx70-Flasher project.
//
// The public surface:
//   flashIdentify(sgbd)               -> { hwRef, swRef, vin, type, profile }
//   flashReadRegion(sgbd, profile, region, { onProgress, abort }) -> Uint8Array
//   flashBackup(sgbd, { region, onProgress, onStage, abort })
//                                     -> { name, bytes, info, region }
//   FLASH_PROFILES / FLASH_UNSUPPORTED  what the screen lists, and why not
// The UI (screens/flasher.js) drives flashBackup and saves the bytes.

// ---- crypto: browser MD5 + BigInt modPow (WebCrypto has no MD5) -------------
// Small, self-contained MD5 (RFC 1321). Used only for the MS45-family security
// access, where the seed/serial/userId are MD5'd before RSA signing.
function _md5(bytes) {
  // all arithmetic kept in unsigned 32-bit space
  const add = (...xs) => xs.reduce((a, b) => (a + b) >>> 0, 0) >>> 0;
  function rl(x, c) {
    x >>>= 0;
    return ((x << c) | (x >>> (32 - c))) >>> 0;
  }
  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
    9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
    16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10,
    15, 21,
  ];
  const K = [];
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  }
  const msg = Array.from(bytes);
  const origLenBits = msg.length * 8;
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  // 64-bit little-endian bit length, as two 32-bit halves. A single `>>>`
  // can't reach bytes 4-7: JS takes the shift count mod 32, so `>>> 32`
  // would repeat the LOW word into the high one.
  const lenLo = origLenBits >>> 0;
  const lenHi = Math.floor(origLenBits / 4294967296) >>> 0;
  for (let i = 0; i < 4; i++) msg.push((lenLo >>> (8 * i)) & 0xff);
  for (let i = 0; i < 4; i++) msg.push((lenHi >>> (8 * i)) & 0xff);

  let a0 = 0x67452301,
    b0 = 0xefcdab89,
    c0 = 0x98badcfe,
    d0 = 0x10325476;
  for (let off = 0; off < msg.length; off += 64) {
    const M = [];
    for (let i = 0; i < 16; i++) {
      M[i] =
        msg[off + i * 4] |
        (msg[off + i * 4 + 1] << 8) |
        (msg[off + i * 4 + 2] << 16) |
        (msg[off + i * 4 + 3] << 24);
    }
    let A = a0,
      B = b0,
      C = c0,
      D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = add(F, A, K[i], M[g] >>> 0);
      A = D;
      D = C;
      C = B;
      B = add(B, rl(F, s[i]));
    }
    a0 = add(a0, A);
    b0 = add(b0, B);
    c0 = add(c0, C);
    d0 = add(d0, D);
  }
  const out = new Uint8Array(16);
  [a0, b0, c0, d0].forEach((h, i) => {
    out[i * 4] = h & 0xff;
    out[i * 4 + 1] = (h >>> 8) & 0xff;
    out[i * 4 + 2] = (h >>> 16) & 0xff;
    out[i * 4 + 3] = (h >>> 24) & 0xff;
  });
  return out;
}

function _modPow(base, exp, mod) {
  let r = 1n,
    b = base % mod;
  if (b < 0n) b += mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % mod;
    e >>= 1n;
    b = (b * b) % mod;
  }
  return r;
}
function _bytesLEToBigInt(bytes) {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}
function _bigIntToBytesLE(value, outLen) {
  const o = new Uint8Array(outLen);
  let v = value;
  for (let i = 0; i < outLen; i++) {
    o[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return o;
}

// ---- ECU profiles ----------------------------------------------------------
// A profile describes ONE DME family's read/backup, keyed to the SGBD that
// drives it. Fields:
//   hwRefs     exact HARDWARE_REFERENZ -> type name. Null for the DS2 DMEs,
//              whose identity is the SGBD's own IDENT answering: the app has
//              already resolved which module is on the bus before we get here.
//   identJobs  [job, resultField] for hw / sw / vin.
//   security   { kind:'rsa', keys:{type:{n,d}} | n,d, serialJob, seedJob,
//                startJob, afterAuth, unless, teardown } or { kind:'none' }.
//              `unless` = { job, field, equals }: when the ECU answers that,
//              the whole unlock is skipped (BMW-FAST cars talk at 115200
//              natively and need no programming-mode ramp for a read).
//              `teardown` runs after the read, success or not, to put the
//              DME back into its normal diagnostic mode.
//   readJob    { name, arg(segment, start, len), result, chunk }.
//   regions    backup choices; each is one or more `parts`
//              { segment, start, end } read in order and concatenated.
//   verified   true once this profile has read a real car end-to-end.
//
// Address ranges are quoted from the reference tool for each DME, never
// inferred: a wrong range reads the wrong memory and the .bin looks fine.

// The MSx70 family shares one job set and one message layout with MS45; only
// the key pair (per hardware reference) and the segments differ. Both read
// the whole external flash (LAR, 1.5 MB) then the CPU's internal flash
// (FLASH, 512 KB), and the reference tool concatenates them into one 2 MB
// file, external first.
function _msx70Profile(id, label, sgbd, hwRef, key) {
  return {
    id,
    label,
    sgbd,
    hwRefs: { [hwRef]: id },
    identJobs: {
      hw: ['hardware_referenz_lesen', 'HARDWARE_REFERENZ'],
      sw: ['daten_referenz_lesen', 'DATEN_REFERENZ'],
      vin: ['aif_lesen', 'AIF_FG_NR'],
    },
    security: {
      kind: 'rsa',
      keys: { [id]: key },
      serialJob: ['seriennummer_lesen', '_TEL_ANTWORT'],
      seedJob: ['authentisierung_zufallszahl_lesen', 'ZUFALLSZAHL'],
      startJob: 'authentisierung_start',
      // BMW-FAST cars need none of this for a read
      unless: {
        job: 'DIAGNOSEPROTOKOLL_LESEN',
        field: 'DIAG_PROT_IST',
        equals: 'BMW-FAST',
      },
      afterAuth: [
        ['diagnose_mode', 'ECUPM;PC115200'],
        ['SET_PARAMETER', ';115200'],
        ['ACCESS_TIMING_PARAMETER', '00;120;0;240;00'],
        ['SET_PARAMETER', ';115200;;15'],
      ],
      teardown: [
        ['diagnose_mode', 'DEFAULT;PC9600'],
        ['SET_PARAMETER', ';9600'],
      ],
    },
    readJob: {
      name: 'speicher_lesen_ascii',
      arg: (seg, start, len) => `${seg};${start};${len}`,
      result: 'DATEN',
      chunk: 254,
    },
    regions: [
      {
        name: 'data',
        label: 'Tune / data region',
        parts: [{ segment: 'LAR', start: 0x40000, end: 0x5ffff }],
      },
      {
        name: 'full',
        label: 'Full flash (2 MB: external + internal)',
        parts: [
          { segment: 'LAR', start: 0x000000, end: 0x17ffff },
          { segment: 'FLASH', start: 0x00000, end: 0x7ffff },
        ],
      },
    ],
    verified: false,
  };
}

// The C167 DS2 DMEs (MS42/MS43) have no read crypto and no programming-mode
// ramp: the SGBD's SPEICHER_LIN_LESEN takes a 3-byte linear address and a
// 1-byte count and answers the bytes in SPEICHER_LIN_LESEN_WERT. The flash is
// one AM29F400 (512 KB) mapped from 0; the calibration block sits at the top
// on MS43 and mid-flash on MS42, per the memory layout each community wiki
// page documents for the chip.
function _ds2LinearProfile(id, label, sgbd, dataStart, dataEnd) {
  return {
    id,
    label,
    sgbd,
    hwRefs: null,
    identJobs: {
      hw: ['IDENT', 'ID_HW_NR'],
      sw: ['IDENT', 'ID_SW_NR'],
      vin: ['AIF_LESEN', 'AIF_FG_NR'],
    },
    security: { kind: 'none' },
    readJob: {
      name: 'SPEICHER_LIN_LESEN',
      // the address arg is parsed by the VM's StringToValue, which takes 0x
      arg: (seg, start, len) =>
        `0x${start.toString(16).padStart(6, '0')};${len}`,
      result: 'SPEICHER_LIN_LESEN_WERT',
      // the count travels in one telegram byte and the DS2 frame's length
      // byte bounds the whole answer at 255; 128 keeps every chunk inside
      // both limits with room for the frame header and checksum
      chunk: 128,
    },
    regions: [
      {
        name: 'data',
        label: 'Calibration data',
        parts: [{ segment: 'LIN', start: dataStart, end: dataEnd }],
      },
      {
        name: 'full',
        label: 'Full flash (512 KB)',
        parts: [{ segment: 'LIN', start: 0x00000, end: 0x7ffff }],
      },
    ],
    verified: false,
  };
}

const FLASH_PROFILES = [
  {
    id: 'MS45',
    label: 'MS45.0 / MS45.1 (M54/M56)',
    // the SGBD whose jobs drive this DME (what the reference flasher loads)
    sgbd: 'ms450ds0',
    // hardware_referenz_lesen HARDWARE_REFERENZ -> type
    hwRefs: { '0044560': 'MS45.0', '0044570': 'MS45.1' },
    identJobs: {
      hw: ['hardware_referenz_lesen', 'HARDWARE_REFERENZ'],
      sw: ['daten_referenz_lesen', 'DATEN_REFERENZ'],
      vin: ['aif_lesen', 'AIF_FG_NR'],
    },
    security: {
      kind: 'rsa',
      // level-3 login key pair, reverse-engineered from MS45 firmware; see
      // FlashService.GetSecurityAccessMessage. 512-bit.
      n: 8972339025878534711764289273376673716657892103603163846525142300863027035823902824753024958104010374518577719658056297243325957293507856591918471309133927n,
      d: 3845288153947943447898981117161431592853382330115641648510775271798440158210161294390718397115404567798616968157688687573437683643982238798574542074351303n,
      serialJob: ['seriennummer_lesen', '_TEL_ANTWORT'],
      seedJob: ['authentisierung_zufallszahl_lesen', 'ZUFALLSZAHL'],
      startJob: 'authentisierung_start',
      // after auth, raise to programming mode @ 115200
      afterAuth: [
        ['diagnose_mode', 'ECUPM;PC115200'],
        ['SET_PARAMETER', ';115200'],
        ['ACCESS_TIMING_PARAMETER', '00;120;24;240;00'],
        ['SET_PARAMETER', ';115200;;15'],
      ],
      // back to the normal diagnostic session at 9600 (FlashService.FinishFlash)
      teardown: [
        ['diagnose_mode', 'DEFAULT;PC9600'],
        ['SET_PARAMETER', ';9600'],
      ],
    },
    // read job: speicher_lesen_ascii "SEGMENT;start;len", result field DATEN
    readJob: {
      name: 'speicher_lesen_ascii',
      arg: (seg, start, len) => `${seg};${start};${len}`,
      result: 'DATEN',
      chunk: 254,
    },
    regions: [
      {
        name: 'data',
        label: 'Tune / data region',
        parts: [{ segment: 'ROMX', start: 0x40000, end: 0x5cfff }],
      },
      {
        name: 'full',
        label: 'Full flash (1 MB)',
        parts: [{ segment: 'ROMX', start: 0x00000, end: 0xfffff }],
      },
    ],
    verified: false,
  },
  _msx70Profile('MSV70', 'MSV70 (N52)', 'msv70', '0049PP0', {
    n: 8806306843379798992853111245198774700528705475723069265707220991618051039931302477183469869457986639335679139019018788335207607895197742283782592839289633n,
    d: 3774131504305628139794190533656617728798016632452743971017380424979164731399047585139420836879747609597530237254645640097349845943512098793420096824927003n,
  }),
  _msx70Profile('MSS70', 'MSS70 (S85, E60 M5)', 'mss70', '0049R20', {
    n: 8217010497678429229943401791603749355846925215942375750258843727037258323774333432291824564430360214786797252479495103649991108486846288119543565027508177n,
    d: 7043151855152939339951487249946070876440221613664893500221866051746221420377841774672464468823790466059829844480042727836817363328493068037797229849955103n,
  }),
  _ds2LinearProfile(
    'MS43',
    'MS43 (M54, 2001–2005)',
    'ms430ds0',
    0x70000,
    0x7ffff
  ),
  _ds2LinearProfile(
    'MS42',
    'MS42 (M52TU, 1999–2000)',
    'ms420ds0',
    0x48000,
    0x4ffff
  ),
];

// DMEs people will look for here and why they are not offered. Listed on the
// screen so the absence reads as a decision, not an oversight.
const FLASH_UNSUPPORTED = [
  {
    id: 'MSS54',
    label: 'MSS54 / MSS54HP (S54, E46 M3)',
    reason:
      'the SGBD has a flash read job, but no open source documents the flash map to read; coming once it is',
  },
  {
    id: 'ME72',
    label: 'ME7.2 (M62TU / S62 V8)',
    reason:
      'its diagnostic job set has no memory-read job at all; a backup needs the boot-mode bench path',
  },
  {
    id: 'MSD80',
    label: 'MSD80 / MSD81 / MSV80 (N54 / N52 2007+)',
    reason: 'TriCore DMEs are read on the bench only',
  },
];

function flashProfileById(id) {
  return FLASH_PROFILES.find((p) => p.id === id) || null;
}

// Profiles driven by this SGBD (an SGBD is one DME family, but one family can
// carry several profiles in principle).
function flashProfilesForSgbd(sgbd) {
  return FLASH_PROFILES.filter((p) => p.sgbd === sgbd);
}

// The type name for a hardware reference, by EXACT match against the
// profile's table (the reference tools compare the whole string). Null when
// the profile keys identity on the SGBD instead.
function flashTypeForHwRef(profile, hwRef) {
  if (!profile.hwRefs) return profile.id;
  const h = String(hwRef || '').trim();
  return Object.prototype.hasOwnProperty.call(profile.hwRefs, h)
    ? profile.hwRefs[h]
    : null;
}

// Total bytes a region will produce.
function flashRegionSize(region) {
  return region.parts.reduce((n, p) => n + (p.end - p.start + 1), 0);
}

// ---- job plumbing over webRunJob -------------------------------------------
// The whole backup runs on the app's own per-SGBD session (sessionFor), so
// INITIALISIERUNG runs once the normal way and every later job -- the seed
// request, the key, the programming-mode switch, and hundreds of read chunks
// -- reuses that one inited session. A fresh session per job would re-init
// and drop the security-access unlock.
function _resultField(res, field) {
  const sets = (res && res.sets) || [];
  for (const s of sets) {
    if (s && Object.prototype.hasOwnProperty.call(s, field)) return s[field];
  }
  return undefined;
}

// Result bytes come back the way EDIABAS publishes them: a "AA-BB-CC" hex
// string for telegram fields (_TEL_ANTWORT), sometimes a number array. Same
// rule vmbridge.js uses.
function _resultBytes(res, field) {
  const v = _resultField(res, field);
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return Uint8Array.from(v.map(Number));
  if (typeof v === 'string' && v) {
    const parts = v.split('-');
    const out = [];
    for (const p of parts) {
      const n = parseInt(p, 16);
      if (!Number.isFinite(n)) return new Uint8Array(0);
      out.push(n);
    }
    return Uint8Array.from(out);
  }
  return new Uint8Array(0);
}

// A binary job argument. The VM derives the arg bytes from the arg STRING via
// CP1252 (Best2Vm.strBytes: char code <= 0xFF -> that byte), so a byte blob
// is passed as a Latin-1 string, one char per byte -- NOT as hex text.
function _binArg(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

async function _runJob(sgbd, job, arg) {
  return webRunJob(sgbd, job, arg == null ? '' : arg);
}

// ---- identify --------------------------------------------------------------
// Runs the ident jobs of the profiles that belong to this SGBD and returns
// the one whose hardware reference matches exactly. The last reference the
// car actually answered with is kept even when nothing matches, so the
// refusal can name it instead of saying "unknown".
async function flashIdentify(sgbd) {
  const read = async (pair) => {
    if (!pair) return '';
    const res = await _runJob(sgbd, pair[0], '');
    const v = _resultField(res, pair[1]);
    return v == null ? '' : String(v).trim();
  };
  let seen = '';
  for (const p of flashProfilesForSgbd(sgbd)) {
    let hw = '';
    try {
      hw = await read(p.identJobs.hw);
    } catch (e) {
      continue;
    }
    if (hw) seen = hw;
    const type = flashTypeForHwRef(p, hw);
    // a profile keyed on the SGBD still needs the ident job to have answered
    if (!type || (!p.hwRefs && !hw)) continue;
    const sw = await read(p.identJobs.sw).catch(() => '');
    const vin = await read(p.identJobs.vin).catch(() => '');
    return { hwRef: hw, swRef: sw, vin, type, profile: p };
  }
  return { hwRef: seen, swRef: '', vin: '', type: 'unknown', profile: null };
}

// ---- security access (RSA seed/key, MS45 + MSx70 families) -----------------
// Mirrors the reference GetSecurityAccessMessage byte for byte:
//   MD5(userId ‖ serial ‖ seed) -> as a little-endian BigInt -> ^d mod n ->
//   64 LE bytes, each 4-byte word byte-swapped -> + level byte 3 ->
//   prefixed with the fixed 25-byte EDIABAS header.
function _rsaSecurityMessage(sec, userId, serial, seed, type) {
  const key = sec.keys ? sec.keys[type] : sec;
  if (!key || !key.n || !key.d) {
    throw new Error(`no security key for ${type || 'this ECU'}`);
  }
  const toHash = new Uint8Array(userId.length + serial.length + seed.length);
  toHash.set(userId, 0);
  toHash.set(serial, userId.length);
  toHash.set(seed, userId.length + serial.length);
  const hash = _md5(toHash);
  // C# BigInteger(byte[]) is little-endian, with a trailing 0 to keep it +ve
  const m = _bytesLEToBigInt(hash);
  const c = _modPow(m, key.d, key.n);
  const enc = _bigIntToBytesLE(c, 64);
  const payload = new Uint8Array(65);
  payload[64] = 3; // access level
  for (let i = 0; i < 16; i++) {
    payload[0 + 4 * i] = enc[3 + 4 * i];
    payload[1 + 4 * i] = enc[2 + 4 * i];
    payload[2 + 4 * i] = enc[1 + 4 * i];
    payload[3 + 4 * i] = enc[0 + 4 * i];
  }
  const header = [
    1, 0, 0, 0, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0, 0x44, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0x10,
  ];
  const msg = new Uint8Array(header.length + payload.length);
  msg.set(header, 0);
  msg.set(payload, header.length);
  return msg;
}

// Returns true when a session was opened that `flashTeardown` must close.
async function flashSecurityAccess(sgbd, profile, type, onStage) {
  const sec = profile.security;
  if (!sec || sec.kind === 'none') return false; // no unlock needed
  if (sec.kind !== 'rsa') {
    throw new Error(`security kind '${sec.kind}' not implemented`);
  }
  if (sec.unless) {
    const res = await _runJob(sgbd, sec.unless.job, '');
    const v = _resultField(res, sec.unless.field);
    if (v != null && String(v).trim() === sec.unless.equals) {
      onStage && onStage(`${sec.unless.equals}: no unlock needed for a read`);
      return false;
    }
  }
  onStage && onStage('reading serial number');
  // _TEL_ANTWORT is the raw answer telegram; the serial is its last 4 bytes
  // before the checksum (FlashService: Skip(len-5).Take(4)).
  const serBytes = _resultBytes(
    await _runJob(sgbd, sec.serialJob[0], ''),
    sec.serialJob[1]
  );
  if (serBytes.length < 5) throw new Error('could not read ECU serial');
  const serial = serBytes.slice(serBytes.length - 5, serBytes.length - 1);

  // a random 4-byte user id, sent big-endian as a hex literal (the reference
  // reverses the bytes then formats the uint as hex)
  const userId = new Uint8Array(4);
  (globalThis.crypto || require('crypto').webcrypto).getRandomValues(userId);
  const userIdHex =
    '0x' +
    Array.from(userId)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();

  onStage && onStage('requesting seed');
  const seed = _resultBytes(
    await _runJob(sgbd, sec.seedJob[0], `3;${userIdHex}`),
    sec.seedJob[1]
  );
  if (!seed.length) throw new Error('ECU returned no seed');

  onStage && onStage('sending key');
  const msg = _rsaSecurityMessage(sec, userId, serial, seed, type);
  // authentisierung_start takes the 90-byte message as a BINARY argument
  await _runJob(sgbd, sec.startJob, _binArg(msg));

  onStage && onStage('entering programming mode');
  for (const [job, arg] of sec.afterAuth || []) {
    await _runJob(sgbd, job, arg);
  }
  return true;
}

// Put the DME back into its normal diagnostic session. Best effort: a read
// that already failed must not be masked by a teardown error, so failures
// are reported through onStage and swallowed.
async function flashTeardown(sgbd, profile, onStage) {
  const steps = (profile.security && profile.security.teardown) || [];
  if (!steps.length) return;
  onStage && onStage('leaving programming mode');
  for (const [job, arg] of steps) {
    try {
      await _runJob(sgbd, job, arg);
    } catch (e) {
      onStage && onStage(`teardown ${job} failed: ${(e && e.message) || e}`);
    }
  }
}

// ---- read a region ---------------------------------------------------------
// opts: { onProgress(pct), abort: AbortSignal }
async function flashReadRegion(sgbd, profile, region, opts = {}) {
  const rj = profile.readJob;
  const total = flashRegionSize(region);
  const out = new Uint8Array(total);
  let done = 0;
  for (const part of region.parts) {
    const partTotal = part.end - part.start + 1;
    let addr = part.start;
    let partDone = 0;
    while (partDone < partTotal) {
      if (opts.abort && opts.abort.aborted) {
        throw new Error('backup cancelled');
      }
      const want = Math.min(rj.chunk, partTotal - partDone);
      const arg = rj.arg(part.segment, addr, want);
      const bytes = _resultBytes(await _runJob(sgbd, rj.name, arg), rj.result);
      if (!bytes.length) {
        throw new Error(
          `read failed at 0x${addr.toString(16)} (${part.segment})`
        );
      }
      // a short answer means the ECU stopped mid-chunk: refuse to pad it and
      // silently ship a hole in the backup
      if (bytes.length < want) {
        throw new Error(
          `short read at 0x${addr.toString(16)}: got ${bytes.length}, ` +
            `wanted ${want}`
        );
      }
      out.set(bytes.subarray(0, want), done);
      done += want;
      partDone += want;
      addr += want;
      opts.onProgress && opts.onProgress(Math.round((done * 100) / total));
    }
  }
  return out;
}

// A backup must come from a real cable. The demo shim answers every job with
// plausible simulated bytes, which would produce a convincing-looking .bin
// that is pure fiction.
function _requireRealCable() {
  // the two ways the app enters demo mode: the ?demo=1 URL flag (webshim
  // switches to the simulated answer set on it) and the Settings toggle
  let demo = false;
  try {
    if (typeof location !== 'undefined') {
      demo = new URLSearchParams(location.search).get('demo') === '1';
    }
  } catch (e) {
    /* no URL API: not a browser demo */
  }
  if (
    !demo &&
    typeof Settings !== 'undefined' &&
    Settings.get &&
    Settings.get('demo', 'no') === 'yes'
  ) {
    demo = true;
  }
  if (demo) {
    throw new Error('a backup needs a real cable; demo mode is simulated data');
  }
}

// ---- orchestrate a full backup ---------------------------------------------
// opts: { region: 'data'|'full', onProgress(pct), onStage(text), abort }
async function flashBackup(sgbd, opts = {}) {
  const onStage = opts.onStage || (() => {});
  _requireRealCable();

  onStage('identifying ECU');
  const info = await flashIdentify(sgbd);
  if (!info.profile) {
    throw new Error(
      `no flash profile for this ECU (hardware ref ${info.hwRef || 'unknown'})`
    );
  }
  const profile = info.profile;
  const region =
    profile.regions.find((r) => r.name === (opts.region || 'full')) ||
    profile.regions[profile.regions.length - 1];

  let opened = false;
  let bytes;
  try {
    opened = await flashSecurityAccess(sgbd, profile, info.type, onStage);
    onStage(`reading ${region.label}`);
    bytes = await flashReadRegion(sgbd, profile, region, {
      onProgress: opts.onProgress,
      abort: opts.abort,
    });
  } finally {
    if (opened) await flashTeardown(sgbd, profile, onStage);
  }

  const name =
    `${info.type || profile.id}_${region.name}` +
    (info.vin ? `_${info.vin}` : '') +
    '.bin';
  return { name, bytes, info, region };
}

if (typeof window !== 'undefined') {
  window.flashBackup = flashBackup;
  window.flashIdentify = flashIdentify;
  window.flashProfileById = flashProfileById;
  window.flashRegionSize = flashRegionSize;
  window.FLASH_PROFILES = FLASH_PROFILES;
  window.FLASH_UNSUPPORTED = FLASH_UNSUPPORTED;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    flashBackup,
    flashIdentify,
    flashTypeForHwRef,
    flashRegionSize,
    FLASH_PROFILES,
    FLASH_UNSUPPORTED,
    _md5,
    _rsaSecurityMessage,
    _modPow,
  };
}
