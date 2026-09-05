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
// MS45 is the reference profile (it needs an RSA seed/key); the older C167/68k
// DMEs need no read crypto and will slot in as their profiles are added.
//
// The public surface:
//   flashProfileFor(ecuInfo)          -> a profile, or null if unsupported
//   flashIdentify(sgbd, opts)         -> { hwRef, swRef, vin, type, profile }
//   flashReadRegion(sgbd, profile, region, session, onProgress) -> Uint8Array
//   flashBackup(sgbd, { region, onProgress, onStage }) -> { name, bytes, info }
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
// A profile describes ONE DME family's read/backup. `security` is the seed/key
// strategy: { kind:'rsa', n, d } (MS45 family), { kind:'none' } (older C167/68k
// DMEs that read unauthenticated), or a future { kind:'seedkey', compute }.
// `regions` are the backup choices (data-only vs full flash); `readJob` names
// the SGBD read job and how its argument is shaped.

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
        segment: 'ROMX',
        start: 0x40000,
        end: 0x5cfff,
      },
      {
        name: 'full',
        label: 'Full flash (1 MB)',
        segment: 'ROMX',
        start: 0x00000,
        end: 0xfffff,
      },
    ],
  },
];

function flashProfileById(id) {
  return FLASH_PROFILES.find((p) => p.id === id) || null;
}

// Pick the profile whose hwRefs contain this ECU's hardware reference.
function flashProfileForHwRef(hwRef) {
  const h = String(hwRef || '').trim();
  for (const p of FLASH_PROFILES) {
    for (const ref in p.hwRefs) {
      if (h.includes(ref)) return { profile: p, type: p.hwRefs[ref] };
    }
  }
  return null;
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
async function flashIdentify(sgbd) {
  const read = async (pair) => {
    if (!pair) return '';
    const res = await _runJob(sgbd, pair[0], '');
    const v = _resultField(res, pair[1]);
    return v == null ? '' : String(v).trim();
  };
  // try each profile's ident jobs until one yields a matching hwRef. The
  // last reference the car actually answered with is kept even when nothing
  // matches, so the refusal can name it instead of saying "unknown".
  let seen = '';
  for (const p of FLASH_PROFILES) {
    let hw = '';
    try {
      hw = await read(p.identJobs.hw);
    } catch (e) {
      continue;
    }
    if (hw) seen = hw;
    const match = flashProfileForHwRef(hw);
    if (match && match.profile.id === p.id) {
      const sw = await read(p.identJobs.sw).catch(() => '');
      const vin = await read(p.identJobs.vin).catch(() => '');
      return { hwRef: hw, swRef: sw, vin, type: match.type, profile: p };
    }
  }
  return { hwRef: seen, swRef: '', vin: '', type: 'unknown', profile: null };
}

// ---- security access (per profile) -----------------------------------------
function _rsaSecurityMessage(sec, userId, serial, seed) {
  const toHash = new Uint8Array([...userId, ...serial, ...seed]);
  const hash = _md5(toHash);
  // hash as little-endian BigInt, RSA-sign, back to 64 LE bytes, then the
  // per-word big-endian swap the ECU expects (mirrors FlashService).
  const m = _bytesLEToBigInt(hash);
  const c = _modPow(m, sec.d, sec.n);
  const le = _bigIntToBytesLE(c, 64);
  const enc = new Uint8Array(64);
  for (let i = 0; i < 16; i++) {
    enc[0 + 4 * i] = le[3 + 4 * i];
    enc[1 + 4 * i] = le[2 + 4 * i];
    enc[2 + 4 * i] = le[1 + 4 * i];
    enc[3 + 4 * i] = le[0 + 4 * i];
  }
  const payload = new Uint8Array(65);
  payload.set(enc, 0);
  payload[64] = 3;
  const header = [
    1, 0, 0, 0, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0, 0x44, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0x10,
  ];
  return new Uint8Array([...header, ...payload]);
}

async function flashSecurityAccess(sgbd, profile, onStage) {
  const sec = profile.security;
  if (!sec || sec.kind === 'none') return true; // no unlock needed
  if (sec.kind !== 'rsa') {
    throw new Error(`security kind '${sec.kind}' not implemented`);
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
  const msg = _rsaSecurityMessage(sec, userId, serial, seed);
  // authentisierung_start takes the 90-byte message as a BINARY argument
  await _runJob(sgbd, sec.startJob, _binArg(msg));

  onStage && onStage('entering programming mode');
  for (const [job, arg] of sec.afterAuth || []) {
    await _runJob(sgbd, job, arg);
  }
  return true;
}

// ---- read a region ---------------------------------------------------------
// opts: { onProgress(pct), abort: AbortSignal }
async function flashReadRegion(sgbd, profile, region, opts = {}) {
  const rj = profile.readJob;
  const total = region.end - region.start + 1;
  const out = new Uint8Array(total);
  let done = 0;
  let addr = region.start;
  while (done < total) {
    if (opts.abort && opts.abort.aborted) throw new Error('backup cancelled');
    const want = Math.min(rj.chunk, total - done);
    const arg = rj.arg(region.segment, addr, want);
    const bytes = _resultBytes(await _runJob(sgbd, rj.name, arg), rj.result);
    if (!bytes.length) {
      throw new Error(
        `read failed at 0x${addr.toString(16)} (${region.segment})`
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
    addr += want;
    opts.onProgress && opts.onProgress(Math.round((done * 100) / total));
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

  await flashSecurityAccess(sgbd, profile, onStage);

  onStage(`reading ${region.label}`);
  const bytes = await flashReadRegion(sgbd, profile, region, {
    onProgress: opts.onProgress,
    abort: opts.abort,
  });

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
  window.FLASH_PROFILES = FLASH_PROFILES;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    flashBackup,
    flashIdentify,
    flashProfileForHwRef,
    FLASH_PROFILES,
    _md5,
    _rsaSecurityMessage,
    _modPow,
  };
}
