#!/usr/bin/env node
// The coding WRITE dispatcher (Track B): does the per-family strategy run the
// right job sequence, prove itself by re-read, and stay behind the write gate?
//
//   node tools/verify/test_coding_write.js
//
// This is a SAFETY test. The interesting assertions are not "it writes" but:
//   - a write refuses without opts.confirmed (the UI's actuation gate),
//   - a write proves itself by re-reading the block and comparing (ERROR_VERIFY
//     when the module did NOT take the bytes),
//   - the write permission reaches the VM ONLY on the confirmed write steps and
//     NEVER on the read/re-read steps -- so it cannot leak into a normal job.
//
// No real hardware, no real SGBD bytecode: we inject a STUB Best2Vm that
// simulates a coding-capable module (a mutable netto store + JOB_STATUS OKAY)
// and RECORDS the allowWrites flag it was constructed with on every job. That
// lets us assert the gate flow directly, which a captured-telegram fixture
// could not.

const path = require('path');
const cw = require(
  path.join(__dirname, '..', '..', 'app/renderer/core/coding-write.js')
);

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else {
    console.error(`  FAIL ${msg}`);
    failures++;
  }
};

const toHex = cw._toHex;

// ---------------------------------------------------------------------------
// A stub module. It models a coding-capable ECU as a hex netto string, and a
// stub Best2Vm whose .run(job, arg) mutates/reads it. Every constructed VM
// pushes its allowWrites flag into `seen` keyed by the job it ran, so the test
// can prove which steps got the write permission.
//
// opts.acceptWrite=false makes CODIERDATEN_SCHREIBEN a no-op (the module
// "rejects" the bytes silently) -- the negative re-read case.
function makeStub(cfg) {
  const state = { netto: cfg.initialNetto }; // hex string
  const seen = []; // [{job, allowWrites}]
  const args = []; // [{job, argText}]

  function StubVm(code, opts) {
    this.opts = opts;
    // Best2Vm exposes .comm; keep the contract so the runner can carry it.
    this.comm = (opts && opts.comm) || null;
  }
  StubVm.prototype.run = function (job, argText) {
    seen.push({ job, allowWrites: !!this.opts.allowWrites });
    args.push({ job, argText });
    const J = String(job).toUpperCase();

    // reads
    if (J === 'CODIERDATEN_LESEN' || J === 'CODIERUNG_LESEN') {
      return [{ JOB_STATUS: 'OKAY', CODIERDATEN: state.netto }];
    }
    // writes -- these MUST have been constructed with allowWrites:true, or the
    // real VM's gate would have thrown at run(). Model that here so a leak of
    // the flag onto a read, or a missing flag on a write, is visible.
    if (!this.opts.allowWrites) {
      const e = new Error(`refusing to run write job ${J}`);
      throw e;
    }
    if (J === 'CODIERDATEN_SCHREIBEN' || J === 'CODIERUNG_SCHREIBEN') {
      if (cfg.acceptWrite !== false) {
        // arg is ASCII-hex netto; take it verbatim
        state.netto = String(argText)
          .replace(/[^0-9a-fA-F]/g, '')
          .toUpperCase();
      }
      return [{ JOB_STATUS: 'OKAY' }];
    }
    if (J === 'C_S_AUFTRAG') {
      if (cfg.acceptWrite !== false) {
        // binary blob arrived as a char-code string; recover the bytes
        const bytes = Array.from(
          String(argText),
          (c) => c.charCodeAt(0) & 0xff
        );
        state.netto = toHex(bytes);
      }
      return [{ JOB_STATUS: 'OKAY' }];
    }
    if (J === 'C_CHECKSUM') return [{ JOB_STATUS: 'OKAY' }];
    // AUTHENTISIERUNG / NORMALER_DATENVERKEHR / SG_RESET
    return [{ JOB_STATUS: 'OKAY' }];
  };

  return { StubVm, state, seen, args };
}

// A no-op exchange: the stub VM never calls send(), so the wire is never
// touched. Present because writeCoding requires an exchange function.
const noExchange = () => {
  throw new Error('stub VM should not hit the wire');
};

async function run() {
  // -------------------------------------------------------------------------
  console.log('1. codingWriteStrategy picks per family');
  ok(
    cw.codingWriteStrategy('kombi46', [
      'CODIERDATEN_LESEN',
      'CODIERDATEN_SCHREIBEN',
      'SG_RESET',
    ]) === 'codierdaten',
    'CODIERDATEN_SCHREIBEN -> codierdaten'
  );
  ok(
    cw.codingWriteStrategy('ihka46', [
      'CODIERUNG_LESEN',
      'CODIERUNG_SCHREIBEN',
    ]) === 'codierung',
    'CODIERUNG_SCHREIBEN -> codierung'
  );
  ok(
    cw.codingWriteStrategy('zke5gm', [
      'C_FG_LESEN',
      'C_S_AUFTRAG',
      'C_CHECKSUM',
    ]) === 'cfg-chunked',
    'C_S_AUFTRAG -> cfg-chunked'
  );
  ok(
    cw.codingWriteStrategy('nada', ['STATUS_LESEN', 'IDENT']) === null,
    'no coding write job -> null'
  );
  // cfg wins when a module confusingly exposes both
  ok(
    cw.codingWriteStrategy('both', ['CODIERDATEN_SCHREIBEN', 'C_S_AUFTRAG']) ===
      'cfg-chunked',
    'cfg-chunked wins over codierdaten when both present'
  );

  // strategy step tables carry the documented order
  const steps = cw
    .writeSteps(
      'codierdaten',
      [0xa1, 0xb2],
      [
        'AUTHENTISIERUNG',
        'NORMALER_DATENVERKEHR',
        'CODIERDATEN_SCHREIBEN',
        'SG_RESET',
      ]
    )
    .map((s) => s.job);
  ok(
    JSON.stringify(steps) ===
      JSON.stringify([
        'AUTHENTISIERUNG',
        'NORMALER_DATENVERKEHR',
        'CODIERDATEN_SCHREIBEN',
        'NORMALER_DATENVERKEHR',
        'SG_RESET',
      ]),
    `codierdaten step order: ${steps.join(' -> ')}`
  );

  // -------------------------------------------------------------------------
  console.log('2. codierdaten write: re-read matches -> ok');
  {
    const jobs = [
      'CODIERDATEN_LESEN',
      'AUTHENTISIERUNG',
      'NORMALER_DATENVERKEHR',
      'CODIERDATEN_SCHREIBEN',
      'SG_RESET',
    ];
    const stub = makeStub({ initialNetto: '0011223344', acceptWrite: true });
    const r = await cw.writeCoding('kombi46', 'AABBCCDDEE', {
      confirmed: true,
      jobs,
      code: { jobs: {} },
      tables: {},
      exchange: noExchange,
      Best2Vm: stub.StubVm,
    });
    ok(r.ok === true, 'writeCoding returned ok:true');
    ok(toHex(r.before) === '0011223344', `before = ${toHex(r.before)}`);
    ok(toHex(r.after) === 'AABBCCDDEE', `after  = ${toHex(r.after)}`);
    const seq = r.sequence.map((s) => s[0]);
    ok(
      seq.indexOf('CODIERDATEN_SCHREIBEN') > seq.indexOf('AUTHENTISIERUNG'),
      'sequence: AUTHENTISIERUNG before CODIERDATEN_SCHREIBEN'
    );
    ok(
      seq[seq.length - 1] === 'CODIERDATEN_LESEN',
      'sequence ends on the prove-by-re-read'
    );

    // THE GATE FLOW: the write permission reached the writes and ONLY the
    // writes. Every read/re-read was constructed allowWrites:false.
    const writes = stub.seen.filter((s) =>
      /_SCHREIBEN$|^AUTHENTIS|^NORMALER|^SG_RESET/.test(s.job.toUpperCase())
    );
    const reads = stub.seen.filter((s) => /_LESEN$/.test(s.job.toUpperCase()));
    ok(
      writes.length > 0 && writes.every((s) => s.allowWrites === true),
      'every write step got allowWrites:true'
    );
    ok(
      reads.length >= 2 && reads.every((s) => s.allowWrites === false),
      'every read/re-read step got allowWrites:false (no leak)'
    );
  }

  // -------------------------------------------------------------------------
  console.log('3. NEGATIVE: module keeps old bytes -> ERROR_VERIFY');
  {
    const jobs = [
      'CODIERDATEN_LESEN',
      'AUTHENTISIERUNG',
      'NORMALER_DATENVERKEHR',
      'CODIERDATEN_SCHREIBEN',
      'SG_RESET',
    ];
    // acceptWrite:false -> CODIERDATEN_SCHREIBEN is a silent no-op; the
    // re-read returns the OLD netto, which must NOT satisfy the proof.
    const stub = makeStub({ initialNetto: '0011223344', acceptWrite: false });
    let threw = null;
    try {
      await cw.writeCoding('kombi46', 'AABBCCDDEE', {
        confirmed: true,
        jobs,
        code: { jobs: {} },
        tables: {},
        exchange: noExchange,
        Best2Vm: stub.StubVm,
      });
    } catch (e) {
      threw = e;
    }
    ok(
      threw && threw.code === 'ERROR_VERIFY',
      `re-read mismatch throws ERROR_VERIFY (got: ${threw && threw.message})`
    );
  }

  // -------------------------------------------------------------------------
  console.log('4. write refuses without opts.confirmed');
  {
    const jobs = ['CODIERDATEN_LESEN', 'CODIERDATEN_SCHREIBEN'];
    const stub = makeStub({ initialNetto: '00', acceptWrite: true });
    let threw = null;
    try {
      await cw.writeCoding('kombi46', 'AABB', {
        confirmed: false,
        jobs,
        code: { jobs: {} },
        tables: {},
        exchange: noExchange,
        Best2Vm: stub.StubVm,
      });
    } catch (e) {
      threw = e;
    }
    ok(
      threw && /confirm/i.test(threw.message),
      'unconfirmed write is refused before anything runs'
    );
    ok(stub.seen.length === 0, 'NOTHING ran before the confirmation refusal');
  }

  // -------------------------------------------------------------------------
  console.log('5. cfg-chunked binary path round-trips through the arg string');
  {
    const jobs = ['CODIERDATEN_LESEN', 'C_S_AUFTRAG', 'C_CHECKSUM'];
    // bytes that stress the arg-string channel: 0x00, 0x3B (';' -- must NOT
    // split for a binary blob), 0x80/0x9F (CP1252 high range), 0xFF.
    const want = [0x00, 0x3b, 0x80, 0x9f, 0xff, 0x41];
    const stub = makeStub({ initialNetto: 'DEADBEEF', acceptWrite: true });
    const r = await cw.writeCoding('zke5gm', want, {
      confirmed: true,
      jobs,
      code: { jobs: {} },
      tables: {},
      exchange: noExchange,
      Best2Vm: stub.StubVm,
    });
    ok(
      r.ok === true && toHex(r.after) === toHex(want),
      `binary netto round-trips: wrote ${toHex(want)}, read ${toHex(r.after)}`
    );
    const cs = stub.seen.find((s) => s.job === 'C_S_AUFTRAG');
    ok(cs && cs.allowWrites === true, 'C_S_AUFTRAG got allowWrites:true');
  }

  // -------------------------------------------------------------------------
  console.log('6. a non-coding module cannot reach the write path');
  {
    let threw = null;
    try {
      await cw.writeCoding('nada', 'AABB', {
        confirmed: true,
        jobs: ['STATUS_LESEN', 'IDENT'],
        code: { jobs: {} },
        tables: {},
        exchange: noExchange,
        Best2Vm: makeStub({ initialNetto: '00' }).StubVm,
      });
    } catch (e) {
      threw = e;
    }
    ok(
      threw && /no known coding write job/.test(threw.message),
      'a module with no coding write job is refused (no strategy, no write)'
    );
  }

  // -------------------------------------------------------------------------
  console.log('7. no-op when netto already matches (gate stays shut)');
  {
    const jobs = [
      'CODIERDATEN_LESEN',
      'AUTHENTISIERUNG',
      'NORMALER_DATENVERKEHR',
      'CODIERDATEN_SCHREIBEN',
      'SG_RESET',
    ];
    const stub = makeStub({ initialNetto: 'AABBCC', acceptWrite: true });
    const r = await cw.writeCoding('kombi46', 'AABBCC', {
      confirmed: true,
      jobs,
      code: { jobs: {} },
      tables: {},
      exchange: noExchange,
      Best2Vm: stub.StubVm,
    });
    ok(
      r.ok === true && toHex(r.after) === 'AABBCC',
      'already-equal returns ok'
    );
    ok(
      stub.seen.every((s) => s.allowWrites === false),
      'no write step ran -- the gate never opened when nothing changed'
    );
  }

  console.log(
    failures
      ? `\n${failures} FAILURES`
      : '\ncoding-write dispatcher: all assertions passed.'
  );
  process.exit(failures ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
