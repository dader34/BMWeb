// The .IPO writer: bytes in, the same bytes out.
//
// core/ipofile/encode.js is the inverse of the reader. The proof that it is a
// real writer and not a plausible one is reproduction: decode a shipped .IPO
// into the exec the runtime runs, encode that exec, and get the original file
// back byte for byte. Nothing about the container is then being guessed --
// every header field, every payload byte and every block boundary came out
// where INPA's own compiler put it.
//
// A source compiled from scratch cannot be checked that way (it has no
// original), so it is checked two other ways: the bytes decode again to the
// tokens that went in, and the repository's independent Python tooling parses
// them as a container. Two readers that never shared code agreeing on the file
// is what says INPA would load it too.
//
//   node tools/verify/test_ipo_encode.js
//   V=1 node tools/verify/test_ipo_encode.js      # per-check output
//   FULL=1 node tools/verify/test_ipo_encode.js   # every .IPO, not a sample
//
// Skips cleanly when vendor/ is absent: CI has no BMW tree.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SGDAT = path.join(ROOT, 'vendor', 'EC-APPS', 'INPA', 'SGDAT');

let passed = 0;
const ok = (what) => {
  passed++;
  if (process.env.V) console.log('  ok', what);
};

if (!fs.existsSync(SGDAT)) {
  console.log('test_ipo_encode: no vendor/EC-APPS tree, skipped');
  process.exit(0);
}

global.window = global;
const { loadClassic } = require('./lib/load_classic.js');
const F = loadClassic('core/ipofile/');

// ---- 1. the encoder's pieces ------------------------------------------------
// Each literal type has one on-wire shape, and the two dialects disagree about
// which byte names which type. Pinning them here means a change to the tables
// is caught as itself rather than as a thousand corpus mismatches.
{
  /**
   * One pool entry's bytes, as hex.
   * @param {Array} e The entry, [typeLetter, value].
   * @param {number} verHi The container's major version.
   * @returns {string} The encoded bytes as lowercase hex.
   */
  const pool = (e, verHi) => {
    const w = new F.IpofWriter();
    F.ipofWritePoolEntry(w, e, F.ipofVtTable(verHi || 5), 0);
    return Buffer.from(w.bytes()).toString('hex');
  };
  // v5.x: bool 01, byte 02, int 03 (s16), long 04 (s32), real 05 (f64),
  // string 06 terminated by the 0a separator
  assert.equal(pool(['b', 1]), '0101', 'a v5 bool is 01 then its byte');
  assert.equal(pool(['y', 0xab]), '02ab', 'a v5 byte is 02 then its byte');
  assert.equal(pool(['i', 0x1234]), '033412', 'a v5 int is 03 then a LE u16');
  assert.equal(
    pool(['l', 0x89abcdef]),
    '04efcdab89',
    'a v5 long is 04 then a LE u32'
  );
  assert.equal(
    pool(['d', 1.5]),
    '05000000000000f83f',
    'a v5 real is 05 then a LE float64'
  );
  assert.equal(
    pool(['s', 'AB']),
    '0641420a',
    'a v5 string is 06, its bytes, then the separator'
  );
  // the v1.x dialect renumbers: string 04 where v5 says 06, int 02 where v5
  // says 03. Encoding one with the other table writes a pool INPA cannot read.
  assert.equal(pool(['s', 'AB'], 1), '0441420a', 'a v1 string is 04');
  assert.equal(pool(['i', 0x1234], 1), '023412', 'a v1 int is 02');
  ok('every literal type encodes to its documented bytes, in both dialects');

  // Latin-1 is the container's text encoding: the German captions the corpus
  // is full of ("Zurück") are single bytes, and a character with no Latin-1
  // byte is refused rather than silently replaced with a different string.
  assert.equal(
    pool(['s', 'Zurück']),
    '065a7572fc636b0a',
    'a Latin-1 caption keeps its high bytes'
  );
  assert.throws(
    () => pool(['s', '€']),
    /Latin-1/,
    'a character the container cannot store is an error, not a replacement'
  );
  ok('text is Latin-1, and what will not fit is refused');

  // A whole number too big for a 16-bit int slot goes in the 32-bit one rather
  // than wrapping. Truncating would put a different number in the file than
  // the script pushes, which is the quietest possible way to break a program.
  const wide = F.ipofPoolFromTokens({
    procs: { p: [{ op: 'const', n: 0, t: 'i', v: 65536 }] },
  });
  assert.deepStrictEqual(
    wide[0],
    ['l', 65536],
    'an int literal past 16 bits is widened to a long, not wrapped'
  );
  assert.throws(
    () => pool(['i', 65536]),
    /16-bit int/,
    'and encoding one as an int directly is refused'
  );
  ok('an out-of-range int is widened rather than silently truncated');
}

// ---- 2. instruction words and inline headers --------------------------------
// The walker decoded a (b0, b1, u16) triple per token; the encoder writes that
// triple back. These pin the pairs that are easy to transpose.
{
  /**
   * One token's bytes, as hex.
   * @param {Object} t The token.
   * @param {number} [base] The block base a jump counts from.
   * @returns {string} The encoded bytes as lowercase hex.
   */
  const tok = (t, base) => {
    const w = new F.IpofWriter();
    F.ipofEncodeToken(w, t, base || 0, 'test');
    return Buffer.from(w.bytes()).toString('hex');
  };
  assert.equal(tok({ op: 'const', n: 5 }), '01010500', 'const is 01 01');
  assert.equal(tok({ op: 'var', n: 5, sc: 2 }), '01020500', 'a local read');
  assert.equal(
    tok({ op: 'var', n: 5, sc: 2, ref: true }),
    '03020500',
    'a read THROUGH a reference param is 03, not 01'
  );
  assert.equal(tok({ op: 'store', n: 5, sc: 0 }), '06000500', 'a global store');
  assert.equal(
    tok({ op: 'store', n: 5, sc: 0, ref: true }),
    '07000500',
    'a store through a reference is 07'
  );
  assert.equal(tok({ op: 'ret' }), '0e000000', 'ret');
  assert.equal(tok({ op: 'endproc' }), '0d000000', 'endproc');
  assert.equal(tok({ op: 'call', n: 0x48 }), '0c814800', 'a builtin call');
  assert.equal(tok({ op: 'calluser', n: 3 }), '0c800300', 'a user call');
  assert.equal(tok({ op: 'dllcall', n: 3 }), '0d010300', 'a dll call');
  // a jump's target is an absolute byte offset in the exec and a dword index
  // in the file, counted from the block it lives in
  assert.equal(
    tok({ op: 'jump', to: 12 }, 0),
    '0a000300',
    'a jump to byte 12 of its block is dword 3'
  );
  assert.equal(
    tok({ op: 'jfalse', to: 12 }, 0),
    '0b000300',
    'a conditional jump is 0b'
  );
  assert.throws(
    () => tok({ op: 'jump', to: 13 }, 0),
    /dword offset/,
    'a target that is not a whole dword is an error, not a rounded guess'
  );
  ok('every instruction token encodes to its documented word');

  // A state label is not a 4-byte word: it is `%NAME \n <u32 index> 0a`,
  // sitting where a token would.
  assert.equal(
    tok({ op: 'state', name: '%A', index: 1 }),
    '25410a010000000a',
    'a state label carries its name and index inline'
  );
  ok('a state label keeps its inline shape');
}

// ---- 3. a proc splits into the blocks the container stores -------------------
// The walker reports a menu's ITEM as a token inside the menu; the file keeps
// it as its own block whose header those token fields fill. Splitting is what
// puts those bytes back.
{
  const parts = F.ipofSplitSections([
    { op: 'block', dwords: 1 },
    { op: 'ITEM', nr: 1, label: 'Info', dwords: 2 },
    { op: 'ret' },
    { op: 'ITEM', nr: 2, label: 'Ende', dwords: 1 },
    { op: 'endproc' },
  ]);
  assert.equal(parts.length, 3, 'a proc with two ITEMs is three blocks');
  assert.equal(parts[0].head, null, 'the first piece is the proc itself');
  assert.equal(parts[1].head.label, 'Info', 'each ITEM heads its own block');
  assert.deepStrictEqual(
    parts[2].toks.map((t) => t.op),
    ['endproc'],
    "an ITEM's block holds the tokens that follow it"
  );
  // within a screen the first section is the SCREENFUNC and the rest are
  // LINEFUNCs; a menu's are MENUITEMFUNCs and a machine's are STATEFUNCs
  assert.equal(F.ipofSubBlockType(0x01, 0), 0x21, "a screen's first is 21");
  assert.equal(F.ipofSubBlockType(0x01, 1), 0x22, 'its later ones are 22');
  assert.equal(F.ipofSubBlockType(0x02, 0), 0x24, "a menu's are 24");
  assert.equal(F.ipofSubBlockType(0x03, 0), 0x25, "a machine's are 25");
  ok('a proc splits into the blocks the container stores it as');
}

// ---- 4. the corpus, byte for byte -------------------------------------------
// The real proof. Every .IPO the vendor tree ships is decoded and re-encoded,
// and the result must equal the file. A sample runs by default because the
// sweep reads 1790 files; FULL=1 runs all of them, and the sample is taken by
// a fixed stride so the same files are checked on every run.
{
  const all = fs
    .readdirSync(SGDAT)
    .filter((f) => /\.ipo$/i.test(f))
    .sort();
  assert.ok(all.length > 100, `the vendor tree ships scripts (${all.length})`);
  const full = process.env.FULL === '1';
  // a stride, not a slice: a slice would only ever check one corner of the
  // corpus, and the dialects are not evenly spread through the names
  const stride = full ? 1 : Math.ceil(all.length / 200);
  const picked = all.filter((_, i) => i % stride === 0);
  let exact = 0;
  const undecodable = [];
  const mismatched = [];
  for (const name of picked) {
    const file = path.join(SGDAT, name);
    const data = new Uint8Array(fs.readFileSync(file));
    let exec;
    try {
      exec = F.ipofDecodeExec(data, name);
    } catch (err) {
      // the reader's own limits, not the writer's; section 5 accounts for them
      undecodable.push(`${name}: ${err.message}`);
      continue;
    }
    const back = F.ipofEncode(exec);
    if (Buffer.compare(Buffer.from(back), Buffer.from(data)) === 0) exact++;
    else mismatched.push(`${name} (${data.length} in, ${back.length} out)`);
  }
  assert.deepStrictEqual(
    mismatched,
    [],
    'every script the reader accepts must re-encode to its own bytes'
  );
  assert.ok(
    exact > picked.length * 0.99,
    `nearly every sampled script round-trips (${exact}/${picked.length})`
  );
  ok(
    `${exact} of ${picked.length} sampled scripts re-encode byte for byte` +
      (undecodable.length ? `, ${undecodable.length} the reader declines` : '')
  );
  if (process.env.V && undecodable.length)
    for (const u of undecodable) console.log('     declined:', u);
}

// ---- 5. the files the reader declines are not the writer's failure ----------
// Four shipped files the token scan refuses are still well-formed containers,
// and two are not .IPO files at all. Pinning them keeps an honest account of
// the corpus: a regression that made the reader accept fewer files would show
// up here rather than quietly shrinking section 4's sample.
{
  /**
   * Whether the container reader accepts a file, and re-writes it exactly.
   * @param {string} name The file name in SGDAT.
   * @returns {{container: boolean, exact: boolean}} What it managed.
   */
  const container = (name) => {
    const file = path.join(SGDAT, name);
    if (!fs.existsSync(file)) return null;
    const data = new Uint8Array(fs.readFileSync(file));
    const c = F.ipofReadContainer(data);
    if (!c) return { container: false, exact: false };
    const back = F.ipofEncode({ container: c });
    return {
      container: true,
      exact: Buffer.compare(Buffer.from(back), Buffer.from(data)) === 0,
    };
  };
  // ELV is a library of 13 functions with no constant pool at all, so the
  // token scan declines it -- but it IS a container, and it re-writes exactly.
  const elv = container('ELV.IPO');
  if (elv) {
    assert.ok(elv.container, 'ELV.IPO is a well-formed container');
    assert.ok(elv.exact, 'and it re-writes byte for byte');
    ok('a pool-less library still round-trips through the container path');
  }
  // These three encode their whole file with every byte shifted by 0x20; they
  // are a different container encoding, not this one, and are out of scope.
  for (const name of ['QU_TEST.IPO', 'IDQUICK.IPO', 'FSQUICK.IPO']) {
    const r = container(name);
    if (r)
      assert.ok(
        !r.container,
        `${name} is the byte-shifted dialect, correctly declined`
      );
  }
  ok('the byte-shifted dialect is declined rather than mis-written');
}

// ---- 6. a compiled source is a file both readers agree on -------------------
// A script compiled from source has no original to compare against, so it is
// held to what can be checked: its bytes decode back to the tokens that went
// in, and the repository's Python container reader -- which shares no code
// with this one -- parses them.
{
  /**
   * The decompiled source of one .IPO, or null when python3 cannot run.
   * @param {string} stem The script's name.
   * @returns {string|null} The source text.
   */
  const decompile = (stem) => {
    try {
      return execFileSync(
        'python3',
        [path.join(ROOT, 'tools', 'decompile', 'ipo_source.py'), stem],
        {
          cwd: ROOT,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore'],
        }
      );
    } catch (err) {
      void err;
      return null;
    }
  };
  const src = decompile('MUST_EXX');
  if (src === null) {
    console.log('  (python3 / ipo_source.py unavailable, sections 6 skipped)');
  } else {
    const files = {};
    for (const f of fs.readdirSync(SGDAT)) {
      if (/\.(h|src)$/i.test(f))
        files[f] = fs.readFileSync(path.join(SGDAT, f), 'latin1');
    }
    const r = F.ipofCompileSource(src, { name: 'MUST_EXX', files });
    assert.ok(
      r.ok,
      `the decompiled source compiles: ${JSON.stringify(r.errors)}`
    );
    const bytes = F.ipofEncode(r.exec);
    assert.ok(bytes.length > 1000, 'the encoded script has real content');

    // this reader, on its own output
    const again = F.ipofDecodeExec(bytes, 'MUST_EXX');
    const names = Object.keys(r.exec.procs);
    assert.equal(
      Object.keys(again.procs).length,
      names.length,
      'every proc compiled in comes back out'
    );
    for (const n of names)
      assert.ok(again.procs[n], `the proc "${n}" survives the round trip`);
    // The constants a proc pushes are the ones it pushed before encoding.
    // Values, not type letters: a whole number too big for a 16-bit int slot
    // is stored in the 32-bit one, so it reads back `l` where the compiler
    // said `i`. The value is the invariant that matters -- a changed value
    // would be a different program, a widened slot is the same one.
    const consts = (procs) =>
      Object.keys(procs)
        .sort()
        .flatMap((n) =>
          procs[n].filter((t) => t.op === 'const').map((t) => String(t.v))
        );
    assert.deepStrictEqual(
      consts(again.procs),
      consts(r.exec.procs),
      'every literal survives the pool round trip, in order and by value'
    );
    ok(`a compiled source encodes to ${bytes.length} bytes and decodes back`);

    // the other reader, which shares no code with this one
    const tmp = path.join(
      fs.mkdtempSync(path.join(require('os').tmpdir(), 'ipoenc-')),
      'OUT.IPO'
    );
    fs.writeFileSync(tmp, Buffer.from(bytes));
    let listing = null;
    try {
      listing = execFileSync(
        'python3',
        [
          path.join(ROOT, 'tools', 'decompile', 'ipo_compile.py'),
          '--disasm',
          tmp,
        ],
        { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
      );
    } catch (err) {
      assert.fail(`the Python reader cannot parse the encoded file: ${err}`);
    }
    assert.match(listing, /^\.version 5 0$/m, 'it reports the v5.0 header');
    assert.match(listing, /\.magic "TEST-Infotext"/, 'and the magic');
    assert.match(
      listing,
      /\.block function id=\d+ flags=0 marker=0 name="chr"/,
      'and finds the functions by name'
    );
    // the Python codec's own read-then-write must be the identity on our file,
    // which says the container tiles exactly with no slack anywhere
    const codec = execFileSync(
      'python3',
      [path.join(ROOT, 'tools', 'decompile', 'ipo_codec.py'), tmp],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    assert.match(
      codec,
      /round-trip=OK/,
      'the Python codec re-writes our file unchanged'
    );
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    ok(
      'an independent reader parses the encoded file and agrees on its blocks'
    );
  }
}

console.log(`test_ipo_encode: ${passed} checks passed`);
