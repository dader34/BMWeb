// Flashing/Tuning: the programming log (AIF/UIF) editor, a page of the rail.
// BENCH ONLY (localhost), and only for a DME identified with the
// boot loader, whose boot-region flasher it rides on.
//
// The log is the tail of the boot sector, ext 0x1FB34-0x1FFFF, in 64-byte
// slots. The area would hold 19, but the DME serves 14: its AIF read
// (service 23, what AIF_LESEN uses) answers offsets below 0x380 and refuses
// the rest (7F 23 52, measured on the emulated program 2026-10-27), so the
// SGBD counts 14 and so does this page. Every reader walks the slots
// from the first and stops at the first one that starts 0xFF. The page reads
// the log (through the flasher's READ, or imported from a file), shows
// each slot as fields and as bytes, and stages edits locally. Writing
// classifies the edits first: flash only clears bits, so a change that only
// clears bits is programmed over the slot as it stands (direct: no erase, the
// boot sector untouched), and anything else rewrites the whole boot sector
// (erase, restore, verify) -- the same ladder Wipe AIF runs.
//
// The wire steps live in core/flash/aif.js (aifLog), which this page drives:
//   aifLog.writeDirect(client, edits, cb)  edits = [{at, bytes}], each one
//     bit-clear over the chip: ARM -> CHUNK -> VERIFY -> DONE per edit.
//   aifLog.rewrite(client, aif, cb, opts)  aif = the whole log (0x4CC
//     bytes); opts.sector = a trusted [0x8000, 0x20000) to check against
//     the chip and restore from, else read off the DME: ARM -> ERASE ->
//     blank-check -> CHUNK x24 -> VERIFY -> DONE.
//   cb = {stage, progress, note}, as every fast-flasher push gets.
// Until that file is loaded the page reads, edits, imports and exports, and
// says why it cannot write.
/* exported fbAifEdShow, fbAifEdPageHtml, fbAifEdReadLoader, fbAifEdAvailable */

/** Where the log sits on the external chip, and its geometry. */
const FB_AIF_ED_START = 0x1fb34;
const FB_AIF_ED_END = 0x20000;
const FB_AIF_ED_LEN = FB_AIF_ED_END - FB_AIF_ED_START; // 0x4CC
const FB_AIF_ED_SLOT = 64;
/** The slots the DME serves (0x380 bytes); what lies past them it never reads. */
const FB_AIF_ED_SLOTS = 14;
const FB_AIF_ED_BOOT = 0x8000;

/**
 * A slot's fields, as the SGBD's AIF_LESEN reads them (decoded 2026-10-27
 * by running ms450ds0's job on a marked slot): '@' then the VIN's last 7
 * characters, a space, the programming date (BCD YY MM DD), the assembly,
 * calibration-dataset and office numbers (BCD, 6 bytes each, shown as 7
 * digits), the dealer number (BCD, 3 bytes), the tester number (5 ASCII),
 * the mileage (one byte, 600 km a step), the program reference (12 ASCII)
 * and the VIN's first 10 characters. 0x3D-0x3F nothing reads.
 */
const FB_AIF_ED_FIELDS = [
  { key: 'vin', label: 'Vehicle identification no.', kind: 'vin' },
  { key: 'date', label: 'Programming date', kind: 'date', at: 9 },
  {
    key: 'zb',
    label: 'Assembly no.',
    kind: 'bcd',
    at: 0x0c,
    len: 6,
    digits: 7,
  },
  {
    key: 'sw',
    label: 'Calibration dataset no.',
    kind: 'bcd',
    at: 0x12,
    len: 6,
    digits: 7,
  },
  {
    key: 'office',
    label: 'Office no.',
    kind: 'bcd',
    at: 0x18,
    len: 6,
    digits: 7,
  },
  {
    key: 'dealer',
    label: 'Dealer no.',
    kind: 'bcd',
    at: 0x1e,
    len: 3,
    digits: 6,
  },
  {
    key: 'tester',
    label: 'Tester no.',
    kind: 'text',
    at: 0x21,
    len: 5,
    pad: 0x20,
  },
  { key: 'km', label: 'Mileage (km)', kind: 'km', at: 0x26 },
  {
    key: 'prog',
    label: 'Program reference',
    kind: 'text',
    at: 0x27,
    len: 12,
    pad: 0x00,
  },
];
/** The VIN's two halves: the last 7 after the '@', the first 10 at the end. */
const FB_AIF_ED_VIN_SHORT = 1;
const FB_AIF_ED_VIN_HEAD = 0x33;
/** The mileage byte counts in 600 km steps. */
const FB_AIF_ED_KM_STEP = 600;

/** The bytes a field covers, as [offset, length] runs. */
function fbAifEdRuns(f) {
  if (f.kind === 'vin')
    return [
      [FB_AIF_ED_VIN_SHORT, 7],
      [FB_AIF_ED_VIN_HEAD, 10],
    ];
  if (f.kind === 'date') return [[f.at, 3]];
  if (f.kind === 'km') return [[f.at, 1]];
  return [[f.at, f.len]];
}

/**
 * How a field's staged bytes differ from the base: '' unchanged, 'direct'
 * when they only clear bits, 'rewrite' when one sets a bit.
 */
function fbAifEdFieldClass(slot, old, f) {
  let c = '';
  for (const [at, len] of fbAifEdRuns(f))
    for (let k = at; k < at + len; k++) {
      if (slot[k] === old[k]) continue;
      if ((slot[k] & old[k]) !== slot[k]) return 'rewrite';
      c = 'direct';
    }
  return c;
}

/** @param {string} key @returns {object} */
function fbAifEdFieldDef(key) {
  return FB_AIF_ED_FIELDS.find((f) => f.key === key);
}

/** What a slot's edit needs, worst first: the plan follows the worst. */
const FB_AIF_ED_CLASS = {
  rewrite: {
    label: 'rewrite',
    title: 'Sets bits: needs the boot sector erased and rewritten',
  },
  direct: {
    label: 'direct',
    title: 'Only clears bits: programmed over the slot, no erase',
  },
  same: { label: '', title: 'Unchanged' },
};

/** The editor's state, kept across visits like the rest of the screen's. */
function fbAifEd() {
  if (!fbState.aifEd)
    fbState.aifEd = {
      /** What the DME holds (or the file held), or null before a read. */
      base: null,
      /** The staged log. */
      edit: null,
      /** 'dme' | 'file' and how it was got, for the header. */
      source: null,
      sourceNote: '',
      /** The selected slot. */
      sel: 0,
    };
  return fbState.aifEd;
}

// ---- the model --------------------------------------------------------------------------------------------
/** @param {Uint8Array} log @param {number} i @returns {Uint8Array} */
function fbAifEdSlot(log, i) {
  return log.subarray(i * FB_AIF_ED_SLOT, (i + 1) * FB_AIF_ED_SLOT);
}

/** @param {Uint8Array} b @returns {boolean} */
function fbAifEdBlank(b) {
  return b.every((x) => x === 0xff);
}

/** @param {Uint8Array} a @param {Uint8Array} b @returns {boolean} */
function fbAifEdSame(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * The slots every reader sees: the walk from slot 0, stopping at the first
 * that starts 0xFF.
 * @param {Uint8Array} log
 * @returns {number}
 */
function fbAifEdUsed(log) {
  let n = 0;
  while (n < FB_AIF_ED_SLOTS && fbAifEdSlot(log, n)[0] !== 0xff) n++;
  return n;
}

/** ASCII as the SGBD shows it: up to the first NUL or 0xFF. */
function fbAifEdAscii(b) {
  let out = '';
  for (const x of b) {
    if (x === 0x00 || x === 0xff) break;
    out += x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : '\u00b7';
  }
  return out;
}

/** @param {Uint8Array} b @param {string} text @param {number} pad */
function fbAifEdPutAscii(b, text, pad) {
  for (let i = 0; i < b.length; i++)
    b[i] = i < text.length ? text.charCodeAt(i) : pad;
}

/** A BCD byte's two digits, or null when a nibble is not a digit. */
function fbAifEdBcd(x) {
  return x >> 4 < 10 && (x & 15) < 10 ? x.toString(16).padStart(2, '0') : null;
}

/** @param {Uint8Array} slot @param {object} f @returns {string} */
function fbAifEdField(slot, f) {
  if (f.kind === 'vin') {
    const head = fbAifEdAscii(
      slot.subarray(FB_AIF_ED_VIN_HEAD, FB_AIF_ED_VIN_HEAD + 10)
    );
    const tail = fbAifEdAscii(
      slot.subarray(FB_AIF_ED_VIN_SHORT, FB_AIF_ED_VIN_SHORT + 7)
    );
    return head + tail;
  }
  if (f.kind === 'text') return fbAifEdAscii(slot.subarray(f.at, f.at + f.len));
  if (f.kind === 'km')
    return slot[f.at] === 0xff ? '' : String(slot[f.at] * FB_AIF_ED_KM_STEP);
  const b = Array.from(
    slot.subarray(f.at, f.at + (f.kind === 'date' ? 3 : f.len))
  );
  if (b.every((x) => x === 0xff)) return '';
  const digits = b.map(fbAifEdBcd);
  // not BCD: the bytes as they are, so nothing is hidden
  if (digits.includes(null))
    return b
      .map((x) => x.toString(16).padStart(2, '0'))
      .join(' ')
      .toUpperCase();
  if (f.kind === 'date') {
    const [yy, mm, dd] = digits;
    return `${dd}.${mm}.${Number(yy) >= 90 ? '19' : '20'}${yy}`;
  }
  const all = digits.join('');
  // the SGBD shows the last `digits`; more only when they are not zeros
  const cut = all.length - f.digits;
  return /^0*$/.test(all.slice(0, cut)) ? all.slice(cut) : all;
}

/**
 * Put a field's text into a slot, encoded the way the SGBD reads it.
 * @returns {string|null} Why the text cannot go in, or null.
 */
function fbAifEdSetField(slot, f, text) {
  const t = text.trim();
  if (f.kind === 'vin') {
    const v = t.toUpperCase();
    if (!/^[A-Z0-9]{7}$|^[A-Z0-9]{17}$/.test(v))
      return '17 characters (or the last 7), letters and digits';
    fbAifEdPutAscii(
      slot.subarray(FB_AIF_ED_VIN_SHORT, FB_AIF_ED_VIN_SHORT + 7),
      v.slice(-7),
      0x30
    );
    if (v.length === 17)
      fbAifEdPutAscii(
        slot.subarray(FB_AIF_ED_VIN_HEAD, FB_AIF_ED_VIN_HEAD + 10),
        v.slice(0, 10),
        0x30
      );
    return null;
  }
  if (f.kind === 'text') {
    if (!/^[\x20-\x7e]*$/.test(t)) return 'printable characters only';
    if (t.length > f.len) return `at most ${f.len} characters`;
    fbAifEdPutAscii(slot.subarray(f.at, f.at + f.len), t, f.pad);
    return null;
  }
  if (f.kind === 'km') {
    if (!/^\d+$/.test(t)) return 'a whole number of km';
    const step = Math.round(Number(t) / FB_AIF_ED_KM_STEP);
    if (step > 0xfe) return `at most ${0xfe * FB_AIF_ED_KM_STEP} km`;
    slot[f.at] = step;
    return null;
  }
  if (f.kind === 'date') {
    const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(t);
    if (!m) return 'DD.MM.YYYY';
    const [dd, mm, yyyy] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (dd < 1 || dd > 31 || mm < 1 || mm > 12 || yyyy < 1990 || yyyy > 2089)
      return 'not a date (1990-2089)';
    const bcd = (n) => parseInt(String(n % 100).padStart(2, '0'), 16);
    slot.set([bcd(yyyy), bcd(mm), bcd(dd)], f.at);
    return null;
  }
  if (!/^\d+$/.test(t)) return 'digits only';
  if (t.length > f.len * 2) return `at most ${f.len * 2} digits`;
  const all = t.padStart(f.len * 2, '0');
  for (let i = 0; i < f.len; i++)
    slot[f.at + i] = parseInt(all.slice(i * 2, i * 2 + 2), 16);
  return null;
}

/** Whether `next` can be programmed over `old` without an erase. */
function fbAifEdBitClear(next, old) {
  return next.every((n, i) => (n & old[i]) === n);
}

/** @param {number} i @returns {'same'|'direct'|'rewrite'} */
function fbAifEdClassOf(i) {
  const s = fbAifEd();
  const old = fbAifEdSlot(s.base, i);
  const next = fbAifEdSlot(s.edit, i);
  if (fbAifEdSame(old, next)) return 'same';
  return fbAifEdBitClear(next, old) ? 'direct' : 'rewrite';
}

/**
 * The write the staged log needs: nothing, direct over the changed slots,
 * or the boot-sector rewrite.
 * @returns {{path: 'none'|'direct'|'rewrite', slots: number[]}}
 */
function fbAifEdPlan() {
  const s = fbAifEd();
  if (!s.base) return { path: 'none', slots: [] };
  const slots = [];
  let rewrite = false;
  for (let i = 0; i < FB_AIF_ED_SLOTS; i++) {
    const c = fbAifEdClassOf(i);
    if (c === 'same') continue;
    slots.push(i);
    if (c === 'rewrite') rewrite = true;
  }
  // the area past the 14 slots is never staged, but a whole-log import can
  // change it: that is a rewrite too
  const tail = FB_AIF_ED_SLOTS * FB_AIF_ED_SLOT;
  if (!fbAifEdSame(s.base.subarray(tail), s.edit.subarray(tail)))
    rewrite = true;
  return {
    path: !slots.length && !rewrite ? 'none' : rewrite ? 'rewrite' : 'direct',
    slots,
  };
}

/**
 * A new entry: the newest entry carried over (VIN, numbers, dealer,
 * mileage, program reference), dated today with this app's tester number,
 * so only what differs needs typing.
 * @returns {Uint8Array}
 */
function fbAifEdTemplate(log) {
  const used = fbAifEdUsed(log);
  const b = new Uint8Array(FB_AIF_ED_SLOT).fill(0xff);
  if (used) b.set(fbAifEdSlot(log, used - 1));
  else {
    b[0] = 0x40; // '@'
    b[8] = 0x20;
    for (const f of FB_AIF_ED_FIELDS)
      if (f.kind === 'bcd') fbAifEdSetField(b, f, '0');
    fbAifEdSetField(b, fbAifEdFieldDef('vin'), '0'.repeat(17));
    fbAifEdSetField(b, fbAifEdFieldDef('km'), '0');
  }
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  fbAifEdSetField(
    b,
    fbAifEdFieldDef('date'),
    `${p(now.getDate())}.${p(now.getMonth() + 1)}.${now.getFullYear()}`
  );
  fbAifEdSetField(b, fbAifEdFieldDef('tester'), fbTesterSerial);
  return b;
}

// ---- the page ---------------------------------------------------------------------------------------------
function fbAifEdPageHtml() {
  return `
    <div class="fb-page fb-aif" id="fb-page-aif" hidden>
      <div class="fb-row">
        <button class="btn" id="fb-aif-read" title="Reads the log through the fast flash bootloader and restarts the DME. Writes nothing.">Read from DME</button>
        <button class="btn" id="fb-aif-import">Import…</button>
        <button class="btn" id="fb-aif-export" disabled>Export</button>
        <span class="fb-aif-gap"></span>
        <button class="btn" id="fb-aif-revert" disabled>Revert all</button>
        <button class="btn" id="fb-aif-clear" disabled title="Stages every slot blank. Needs the boot sector rewritten.">Clear all</button>
        <button class="btn danger" id="fb-aif-write" disabled>Write</button>
      </div>
      <div class="fb-mono fb-dim" id="fb-aif-head">Read the log from the DME, or import one from a file.</div>
      <div class="fb-aif-body">
        <div class="fb-table-wrap fb-aif-slots">
          <table class="fb-table" id="fb-aif-table">
            <thead><tr><th>#</th><th>VIN</th><th>Date</th><th>Assembly</th><th>Calibration</th><th>Tester</th><th>km</th><th></th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
        <div class="fb-section fb-aif-detail" id="fb-aif-detail" hidden></div>
      </div>
      <div class="fb-faint" id="fb-aif-plan"></div>
    </div>`;
}

/** Wire the page's buttons once and paint it; the rail calls this on every show. */
function fbAifEdShow() {
  const page = fbEls['page-aif'];
  if (!page) return;
  // reopened on this page (its address) before a bootloader DME is identified
  if (!fbAifEdAvailable()) {
    fbShowPage('flashing');
    return;
  }
  if (!page.dataset.wired) {
    page.dataset.wired = '1';
    fbEls['aif-read'].onclick = () => fbDmeGuard('Read AIF', fbAifEdRead);
    fbEls['aif-import'].onclick = () => fbAifEdImport();
    fbEls['aif-export'].onclick = () => fbAifEdExport();
    fbEls['aif-revert'].onclick = () => {
      const s = fbAifEd();
      s.edit = s.base.slice();
      fbAifEdPaint();
    };
    fbEls['aif-clear'].onclick = () => {
      fbAifEd().edit.fill(0xff);
      fbAifEdPaint();
    };
    fbEls['aif-write'].onclick = () => fbDmeGuard('Write AIF', fbAifEdWrite);
  }
  fbAifEdPaint();
}

// ---- the fast flash bootloader ------------------------------------------------------------------------------
/**
 * The editor runs on the boot-region flasher (ms45-emu tools/bl.py,
 * tools/build/bl.py): a ring in the boot sector's blank span, entered at key-on
 * with the line held, whose 16-byte stamp reads "MS45BL", the version, the
 * flags (bit 1 the boot-sector window the log needs) and two CPU addresses.
 * the current ring keeps it at ext 0x17140 (its park window took 0x17080), the old layout at
 * 0x17080; BL's is looked for first. The body is the v13 one, READ
 * included.
 */
const FB_AIF_ED_LOADER_AT = [0x17140, 0x17080];
const FB_AIF_ED_LOADER_MAGIC = 'MS45BL';
const FB_AIF_ED_LOADER_FROM = 14;
const FB_AIF_ED_LOADER_BOOT_WINDOW = 0x02;

/**
 * Identify's read of the bootloader's stamp, on its KWP session (one
 * telegram an address; a stock boot sector answers 0xFF there). Found, it
 * is remembered for a DME that later stops in its loader.
 * @returns {Promise<void>}
 */
async function fbAifEdReadLoader() {
  const d = fbState.dme;
  d.bootLoader = null;
  let answered = false;
  if (fbDmeIsMs451())
    for (const at of FB_AIF_ED_LOADER_AT) {
      try {
        const st = await ms45ReadCarBytes(
          at,
          at + 15,
          'ROMX',
          fbDmeReadProtocol()
        );
        if (!st || st.length < 8) continue;
        answered = true;
        if (
          String.fromCharCode(...st.subarray(0, 6)) !== FB_AIF_ED_LOADER_MAGIC
        )
          continue;
        d.bootLoader = { version: st[6], flags: st[7], stampAt: at };
        fbAifEdRemember(d.bootLoader);
        fbAifEdAdopt(d.bootLoader);
        return;
      } catch (e) {
        /* the next address, then the remembered one */
      }
    }
  const status = d.ident.programmingStatus;
  const stopped = !!status && status !== 'Normalbetrieb';
  // a running DME that answered without the stamp has no bootloader
  if (!stopped) {
    if (answered) fbAifEdForget();
    return;
  }
  // a DME stopped in its loader (a push cut by a power loss) may answer
  // neither its part number nor the stamp read: the bootloader identified
  // on the last DME that had one stands in. Only BL is reachable from
  // there (its park window); a wrong guess costs one entry attempt, which
  // finds no flasher and writes nothing.
  const r = fbAifEdRemembered();
  if (!r || r.version < 15) return;
  // ...but only for the DME it was seen on: a stopped DME that still tells
  // its hardware number or VIN, and tells a different one, is another unit
  // (an MS45.0 on the bench after the car's MS45.1 had BL, say)
  if (
    [
      [d.ident.hwRef, r.hwRef],
      [d.ident.vin, r.vin],
    ].some(([now, then]) => now && then && now !== then)
  )
    return;
  d.bootLoader = {
    version: r.version,
    flags: r.flags,
    stampAt: r.stampAt,
    remembered: true,
  };
  fbLog(
    `The DME is stopped in its loader (${fbDmeProgrammingStatus(status)}): using the fast flasher last identified on ${[r.hwRef, r.vin].filter(Boolean).join(' ') || 'this browser'}`
  );
  if (!d.identified) {
    d.identified = true;
    if (!d.ident.hwRef) d.ident.hwRef = r.hwRef || '';
  }
  fbAifEdAdopt(d.bootLoader);
}

/** Where the last identified bootloader is kept (this browser only). */
const FB_AIF_ED_LOADER_KEY = 'bmweb-fast-bootloader';

/** @param {{version: number, flags: number, stampAt: number}} have */
function fbAifEdRemember(have) {
  const id = fbState.dme.ident;
  try {
    localStorage.setItem(
      FB_AIF_ED_LOADER_KEY,
      JSON.stringify({ ...have, hwRef: id.hwRef || '', vin: id.vin || '' })
    );
  } catch (e) {
    /* private window: only the stopped-DME fallback is lost */
  }
}

function fbAifEdForget() {
  try {
    localStorage.removeItem(FB_AIF_ED_LOADER_KEY);
  } catch (e) {
    /* nothing kept */
  }
}

/** @returns {?{version: number, flags: number, stampAt: number, hwRef: string, vin: string}} */
function fbAifEdRemembered() {
  try {
    return JSON.parse(localStorage.getItem(FB_AIF_ED_LOADER_KEY) || 'null');
  } catch (e) {
    return null;
  }
}

/**
 * The bootloader IS a fast flasher (its body is the v13 one, entered the
 * same way): Fast Flash Tune / Program / Read go through it when the DME
 * carries no ready resident flasher of its own -- and on a DME stopped in
 * its loader only BL (the park window) can be reached at all.
 * @param {{version: number, flags: number}} have
 */
function fbAifEdAdopt(have) {
  const d = fbState.dme;
  const status = d.ident.programmingStatus;
  const stopped = !!status && status !== 'Normalbetrieb';
  if (stopped && have.version < 15) return;
  // the bootloader comes first in the boot path, so a held line lands in it
  // even beside an old resident flasher: it is the fast flasher. The
  // resident one is noted, and the next program flash leaves it out
  const resident =
    d.fastFlasher && !d.fastFlasher.bootLoader && d.fastFlasher.hooked
      ? d.fastFlasher.version
      : 0;
  d.fastFlasher = fbAifEdLoaderAsFlasher(have);
  if (resident) d.fastFlasher.resident = resident;
}

/**
 * The bootloader as the fast-flasher detection the flashing flows read
 * (core/flash/fast-flasher.js parseDetection's shape): its body is v13 with
 * every v13 feature, it is reached by the same reset-and-break entry, and it
 * needs no MPC hook. `bootLoader` carries its own version (14 or 15).
 * @param {{version: number, flags: number}} have
 * @returns {object}
 */
function fbAifEdLoaderAsFlasher(have) {
  return {
    version: have.version,
    flags: have.flags,
    bootLoader: have.version,
    hooked: true,
    ours: true,
    supported: true,
    mpc: true,
    reads: true,
    aifWipe: !!(have.flags & FB_AIF_ED_LOADER_BOOT_WINDOW),
    ready: true,
  };
}

/** Whether the rail offers the editor: a DME identified with the fast flash bootloader (either ring layout). */
function fbAifEdAvailable() {
  if (fbDevUi()) return true; // the dev UI toggle forces the rail page on
  const d = fbState.dme;
  const have = d && d.bootLoader;
  return !!(
    fbState.module === 'dme' &&
    d.identified &&
    have &&
    have.version >= FB_AIF_ED_LOADER_FROM
  );
}

/** Why the DME cannot be read or written from here, or null. */
function fbAifEdWhyNot(write) {
  const d = fbState.dme;
  const have = d && d.bootLoader;
  if (fbState.module !== 'dme' || !d.identified)
    return 'Identify the DME on the Flashing tab first.';
  if (!have || have.version < FB_AIF_ED_LOADER_FROM)
    return 'Needs the fast flash bootloader on the DME.';
  if (typeof webBus === 'undefined' || !webBus.port || !webBus.port.setSignals)
    return 'Needs a cable that can hold the break line (Web Serial or a gateway).';
  if (!write) return null;
  if (!(have.flags & FB_AIF_ED_LOADER_BOOT_WINDOW))
    return 'This fast flasher was built without the boot-sector window: it can read the log but not write it.';
  if (typeof aifLog === 'undefined')
    return 'The AIF protocol client (core/flash/aif.js) is not loaded in this build.';
  return null;
}

function fbAifEdPaint() {
  const s = fbAifEd();
  const loaded = !!s.base;
  const plan = fbAifEdPlan();
  const whyRead = fbAifEdWhyNot(false);
  const whyWrite = fbAifEdWhyNot(true);
  fbEls['aif-read'].disabled = !!whyRead || fbState.running;
  fbEls['aif-read'].title =
    whyRead ||
    'Reads the log through the fast flash bootloader and restarts the DME. Writes nothing.';
  fbEls['aif-export'].disabled = !loaded;
  fbEls['aif-revert'].disabled = !loaded || plan.path === 'none';
  fbEls['aif-clear'].disabled = !loaded || fbAifEdBlank(s.edit);
  // only what came off the DME is written back: a file's log has nothing
  // on the car to be compared with
  fbEls['aif-write'].disabled =
    !loaded ||
    s.source !== 'dme' ||
    plan.path === 'none' ||
    !!whyWrite ||
    fbState.running;
  fbEls['aif-write'].title =
    s.source === 'file'
      ? 'Read the log from the DME to write it back.'
      : whyWrite || '';

  if (!loaded) {
    fbEls['aif-head'].textContent = whyRead
      ? `Read the log from the DME (${whyRead.replace(/\.$/, '')}), or import one from a file.`
      : 'Read the log from the DME, or import one from a file.';
    fbEls['aif-table'].querySelector('tbody').innerHTML = '';
    fbEls['aif-detail'].hidden = true;
    fbEls['aif-plan'].textContent = '';
    return;
  }
  const used = fbAifEdUsed(s.edit);
  fbEls['aif-head'].textContent =
    `${s.sourceNote} · ${used} of ${FB_AIF_ED_SLOTS} slots used` +
    (used === FB_AIF_ED_SLOTS
      ? ' (full)'
      : ` · ${FB_AIF_ED_SLOTS - used} free`);

  const tbody = fbEls['aif-table'].querySelector('tbody');
  tbody.innerHTML = '';
  for (let i = 0; i < FB_AIF_ED_SLOTS; i++) {
    const slot = fbAifEdSlot(s.edit, i);
    const blank = fbAifEdBlank(slot);
    const hidden = !blank && i > used; // past the walk's end: no reader sees it
    const c = fbAifEdClassOf(i);
    const f = (k) => esc(fbAifEdField(slot, fbAifEdFieldDef(k)));
    const tr = document.createElement('tr');
    tr.className = [
      i === s.sel ? 'active' : '',
      blank ? 'fb-aif-blank' : '',
      hidden ? 'fb-aif-unseen' : '',
    ].join(' ');
    tr.innerHTML = blank
      ? `<td class="fb-mono">${i}</td><td colspan="6" class="fb-faint">${c === 'same' ? 'free' : 'blank (staged)'}</td>`
      : `<td class="fb-mono">${i}</td><td class="fb-mono">${f('vin')}</td><td class="fb-mono">${f('date')}</td>` +
        `<td class="fb-mono">${f('zb')}</td><td class="fb-mono">${f('sw')}</td><td class="fb-mono">${f('tester')}</td><td class="fb-mono">${f('km')}</td>`;
    tr.innerHTML += `<td>${c === 'same' ? '' : `<span class="fb-aif-badge fb-aif-${c}" title="${esc(FB_AIF_ED_CLASS[c].title)}">${FB_AIF_ED_CLASS[c].label}</span>`}${hidden ? ' <span class="fb-aif-badge fb-aif-warn" title="A blank slot comes before it: every reader stops there">unseen</span>' : ''}</td>`;
    tr.onclick = () => {
      s.sel = i;
      fbAifEdPaint();
    };
    tbody.appendChild(tr);
  }
  fbAifEdPaintDetail();

  fbEls['aif-plan'].textContent =
    plan.path === 'none'
      ? 'No changes staged.'
      : plan.path === 'direct'
        ? `Write: direct over slot${plan.slots.length > 1 ? 's' : ''} ${plan.slots.join(', ')} -- only clears bits, no erase, the boot sector stays as it is.`
        : `Write: the boot sector is erased and rewritten (${plan.slots.length} slot${plan.slots.length === 1 ? '' : 's'} changed, some bits set). A power or cable loss mid-way leaves a DME only a BDM rig recovers.`;
}

function fbAifEdPaintDetail() {
  const s = fbAifEd();
  const box = fbEls['aif-detail'];
  const i = s.sel;
  const slot = fbAifEdSlot(s.edit, i);
  const old = fbAifEdSlot(s.base, i);
  const blank = fbAifEdBlank(slot);
  const used = fbAifEdUsed(s.edit);
  box.hidden = false;
  const at = (FB_AIF_ED_START + i * FB_AIF_ED_SLOT).toString(16).toUpperCase();
  let html = `<div class="fb-row"><span class="fb-code">Slot ${i}</span><span class="fb-mono fb-faint">ext 0x${at}</span><span class="fb-aif-gap"></span>`;
  if (blank) {
    html +=
      i === used
        ? '<button class="btn" id="fb-aif-new">New entry</button>'
        : '<span class="fb-faint">Entries go in the first free slot.</span>';
  } else {
    html +=
      '<button class="btn" id="fb-aif-zero" title="Every byte to 0x00: a clear, written directly. Readers still count the slot as used.">Zero</button>' +
      '<button class="btn" id="fb-aif-blank" title="Back to 0xFF: needs the rewrite, and every entry after it drops out of the walk.">Blank</button>';
  }
  if (!fbAifEdSame(slot, old))
    html += '<button class="btn" id="fb-aif-undo">Revert slot</button>';
  html += '</div>';

  if (!blank) {
    html += '<div class="fb-grid2 fb-aif-fields">';
    for (const f of FB_AIF_ED_FIELDS) {
      // amber: changed, written directly; red: sets a bit, needs the rewrite
      const c = fbAifEdFieldClass(slot, old, f);
      const cls = c === 'rewrite' ? ' fb-aif-sets' : c ? ' fb-aif-changed' : '';
      const was = c ? ` title="was ${esc(fbAifEdField(old, f))}"` : '';
      html +=
        `<label class="fb-dim" for="fb-aif-f-${f.key}">${f.label}</label>` +
        `<input class="modal-input fb-mono fb-aif-input${cls}" id="fb-aif-f-${f.key}" data-key="${f.key}"${was} ` +
        `spellcheck="false" autocomplete="off" value="${esc(fbAifEdField(slot, f))}">`;
    }
    html += '</div><div class="fb-faint" id="fb-aif-field-why"></div>';
  }

  // the slot as bytes, 16 a row with the ASCII beside; a changed byte is
  // amber, one that needs a bit set (an erase) red
  html += `<details class="fb-aif-raw" id="fb-aif-raw"${s.rawOpen ? ' open' : ''}><summary class="fb-faint">Raw bytes</summary><div class="fb-aif-hex">`;
  for (let r = 0; r < FB_AIF_ED_SLOT; r += 16) {
    html += `<span class="fb-aif-off">${r.toString(16).padStart(2, '0').toUpperCase()}</span>`;
    let ascii = '';
    for (let c = r; c < r + 16; c++) {
      const v = slot[c];
      const cls =
        v === old[c]
          ? ''
          : (v & old[c]) === v
            ? ' fb-aif-changed'
            : ' fb-aif-sets';
      html += `<input class="fb-aif-byte${cls}" data-at="${c}" maxlength="2" spellcheck="false" autocomplete="off" value="${v.toString(16).padStart(2, '0').toUpperCase()}">`;
      ascii += v >= 0x20 && v < 0x7f ? String.fromCharCode(v) : '.';
    }
    html += `<span class="fb-aif-ascii">${esc(ascii)}</span>`;
  }
  html += '</div></details>';
  box.innerHTML = html;

  const q = (id) => box.querySelector(id);
  q('#fb-aif-raw').ontoggle = () => {
    s.rawOpen = q('#fb-aif-raw').open;
  };
  if (q('#fb-aif-new'))
    q('#fb-aif-new').onclick = () => {
      slot.set(fbAifEdTemplate(s.edit));
      fbAifEdPaint();
    };
  if (q('#fb-aif-zero'))
    q('#fb-aif-zero').onclick = () => {
      slot.fill(0x00);
      fbAifEdPaint();
    };
  if (q('#fb-aif-blank'))
    q('#fb-aif-blank').onclick = () => {
      slot.fill(0xff);
      fbAifEdPaint();
    };
  if (q('#fb-aif-undo'))
    q('#fb-aif-undo').onclick = () => {
      slot.set(old);
      fbAifEdPaint();
    };
  // a field or a byte takes effect when it is left (or Enter): repainting
  // on every keystroke would take the caret away
  box.querySelectorAll('.fb-aif-input').forEach((el) => {
    const f = fbAifEdFieldDef(el.dataset.key);
    el.onchange = () => {
      const why = fbAifEdSetField(slot, f, el.value);
      if (why) {
        q('#fb-aif-field-why').textContent = `${f.label}: ${why}.`;
        el.value = fbAifEdField(slot, f);
        return;
      }
      fbAifEdPaint();
    };
  });
  box.querySelectorAll('.fb-aif-byte').forEach((el) => {
    el.onfocus = () => el.select();
    el.onchange = () => {
      const v = el.value.trim();
      if (/^[0-9a-fA-F]{1,2}$/.test(v))
        slot[Number(el.dataset.at)] = parseInt(v, 16);
      fbAifEdPaint();
    };
  });
  box.querySelectorAll('input').forEach((el) => {
    el.onkeydown = (e) => {
      if (e.key === 'Enter') el.blur();
    };
  });
}

// ---- loading and saving -----------------------------------------------------------------------------------
/** Take a log in as the base and the staged copy alike. */
function fbAifEdLoad(log, source, note) {
  const s = fbAifEd();
  s.base = log.slice();
  s.edit = log.slice();
  s.source = source;
  s.sourceNote = note;
  s.sel = Math.min(fbAifEdUsed(log), FB_AIF_ED_SLOTS - 1);
  fbAifEdPaint();
}

/**
 * Import: a log saved by Export (0x4CC bytes) or a whole external flash
 * image (1 MB). Staged over what the DME holds when a read is up, so it can
 * be written; otherwise opened as a file's log.
 */
async function fbAifEdImport() {
  const file = await fbPickFile('.bin,application/octet-stream');
  if (!file) return;
  const bytes = await fbReadBytes(file);
  let log = null;
  if (bytes.length === FB_AIF_ED_LEN) log = bytes;
  else if (bytes.length >= FB_AIF_ED_END)
    log = bytes.slice(FB_AIF_ED_START, FB_AIF_ED_END);
  if (!log) {
    await fbMessage(
      `${file.name} is ${bytes.length} bytes: the editor takes a log (${FB_AIF_ED_LEN} bytes, from Export) or a whole external flash image.`,
      'AIF editor'
    );
    return;
  }
  const s = fbAifEd();
  if (s.base && s.source === 'dme') {
    s.edit = log.slice();
    fbSetStatus(
      `AIF editor: ${file.name} staged over the DME's log; Write to put it on the DME`
    );
    fbAifEdPaint();
  } else fbAifEdLoad(log, 'file', `From ${file.name}`);
}

function fbAifEdExport() {
  const s = fbAifEd();
  if (!s.edit) return;
  const d = fbState.dme;
  const who = [d.ident.vin, d.ident.hwRef].filter(Boolean).join('_') || 'dme';
  fbSaveBytes(`${who}_AIF_0x1FB34.bin`, s.edit);
}

// ---- the DME ------------------------------------------------------------------------------------------------
/** Read the log through the flasher and restart the DME on its program. */
async function fbAifEdRead() {
  const why = fbAifEdWhyNot(false);
  if (why) {
    await fbMessage(why, 'Read AIF');
    return;
  }
  const d = fbState.dme;
  let log = null;
  await fbDmeFastFlash({
    title: 'Read AIF',
    operation: 'aif-read',
    what: 'read',
    noFasterLine: true,
    confirm:
      'Read AIF resets the DME into its fast flash bootloader, reads the programming log and restarts the DME on its program. Nothing is written.\n\nRead the log?',
    note: `DME ${d.ident.hwRef} / BL${d.bootLoader.version} / AIF read`,
    push: async (client, cb) => {
      cb.stage('Reading the programming log');
      log = await fastFlashWire.readArea(
        client,
        FB_AIF_ED_START,
        FB_AIF_ED_LEN,
        (n) => cb.progress(Math.floor((n * 90) / FB_AIF_ED_LEN))
      );
      cb.stage('Restarting the DME');
      await client.reset();
      return { skipped: false, summary: `read ${fbAifEdUsed(log)} entries` };
    },
    // the DME was only read: no identify after
    after: async () => {},
  });
  if (log) {
    const t = new Date();
    const p = (n) => String(n).padStart(2, '0');
    fbAifEdLoad(
      log,
      'dme',
      `Read from ${d.ident.hwRef || 'the DME'} at ${p(t.getHours())}:${p(t.getMinutes())}`
    );
  }
}

/**
 * Write the staged log: direct over the changed slots when every edit only
 * clears bits, else the boot-sector rewrite. Refuses unless the DME's log is
 * still the one the edits were staged against, and reads it back after.
 */
async function fbAifEdWrite() {
  const why = fbAifEdWhyNot(true);
  if (why) {
    await fbMessage(why, 'Write AIF');
    return;
  }
  const s = fbAifEd();
  const d = fbState.dme;
  const plan = fbAifEdPlan();
  if (plan.path === 'none' || s.source !== 'dme') return;
  const base = s.base.slice();
  const next = s.edit.slice();
  const rewrite = plan.path === 'rewrite';
  // a loaded full image whose boot content is the DME's lets the rewrite
  // skip reading the sector off the car (aif.js checks it against the chip)
  const sector =
    d.flash && d.flash.length >= FB_AIF_ED_END
      ? d.flash.slice(FB_AIF_ED_BOOT, FB_AIF_ED_END)
      : null;
  let wrote = false;
  await fbDmeFastFlash({
    title: 'Write AIF',
    operation: 'aif-write',
    what: 'aif',
    noFasterLine: true,
    confirm: rewrite
      ? `This ERASES the 96 KB boot sector (the loader included), writes it back with the edited log and verifies it (${plan.slots.length} slot${plan.slots.length === 1 ? '' : 's'} changed).\n\n` +
        'A power or cable loss between the erase and the restore leaves a DME that neither the loader nor a full flash can reach: only a BDM / boot-mode rig recovers it. Keep power and the cable steady.\n\nWrite the log?'
      : `This programs slot${plan.slots.length > 1 ? 's' : ''} ${plan.slots.join(', ')} over what is there: the edits only clear bits, so nothing is erased and the rest of the boot sector is not touched.\n\nWrite the log?`,
    note: `DME ${d.ident.hwRef} / BL${d.bootLoader.version} / AIF ${plan.path} write, slots ${plan.slots.join(',') || 'tail'}`,
    prepare: async () => ({ attach: ['aif_staged_0x1FB34.bin', next] }),
    push: async (client, cb) => {
      cb.stage('Reading the programming log');
      const now = await fastFlashWire.readArea(
        client,
        FB_AIF_ED_START,
        FB_AIF_ED_LEN
      );
      if (!fbAifEdSame(now, base))
        throw new Error(
          'The log on the DME is not the one the edits were made against (read it again). Nothing was written.'
        );
      if (rewrite) {
        await aifLog.rewrite(client, next, cb, { sector });
      } else {
        const edits = plan.slots.map((i) => ({
          at: FB_AIF_ED_START + i * FB_AIF_ED_SLOT,
          bytes: fbAifEdSlot(next, i).slice(),
        }));
        await aifLog.writeDirect(client, edits, cb);
      }
      cb.stage('Verifying the programming log');
      const back = await fastFlashWire.readArea(
        client,
        FB_AIF_ED_START,
        FB_AIF_ED_LEN
      );
      if (!fbAifEdSame(back, next)) {
        // what the DME now holds is the truth the page shows
        s.base = back.slice();
        throw new Error('The log read back differs from what was written.');
      }
      wrote = true;
      cb.stage('Restarting the DME');
      await client.reset();
      return { skipped: false, summary: `${plan.path} write verified` };
    },
    // the push ended with the flasher's RESET: the DME restarts on its own
    // (through the rewritten loader after a rewrite) and is identified again,
    // which also re-reads the log's fields from the DME
    after: () => fbDmeIdentify(true),
  });
  if (wrote) s.base = next.slice();
  fbAifEdPaint();
}
