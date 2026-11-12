#!/usr/bin/env node
// The DME-relay client (core/flash/relay.js) and its blob: the web-only
// transmission service. The patch side is proven against what the Python
// builder actually assembled -- tools/relay_blob_js.py wrote the exact
// spliced bytes and hook word into fixtures/relay-patch.json, so this test
// catches a JS patcher that lands the payload anywhere else, in any other
// order, or over a region a tune already used. The read side runs the real
// one-click read-by-address against a mock sender that checks the telegram
// byte for byte. The verdict side feeds the block a booted relay DME will
// write (the emu run's shape, real-chip step count) and every broken
// variant. No hardware.
//
//   node tools/verify/test_relay.js
if (typeof global.window === 'undefined') global.window = {};
const {
  relayBlob,
} = require('../../app/renderer/core/generated/relay-blob.js');
const {
  relayPatchPair,
  relayDecodeState,
  relayReadState,
  relayVerdict,
  relayServiceMs,
  relayAwaitVerdict,
} = require('../../app/renderer/core/flash/relay.js');
const fixture = require('./fixtures/relay-patch.json');

let failures = 0;
const check = (what, ok, detail) => {
  if (!ok) {
    failures++;
    console.log(`  FAIL  ${what}${detail ? ' -- ' + detail : ''}`);
  } else console.log(`  ok    ${what}`);
};
const main = async () => {
  const hex = (b) =>
    Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const throws = async (what, fn) => {
    try {
      await fn();
    } catch (e) {
      check(what, true);
      return;
    }
    check(what, false, 'no error');
  };

  // ---- the blob ----------------------------------------------------------------
  // both stamps share the invariants; the counters differ by mode (probe:
  // stock answers and acks all n; service: n-1 answered, n-2 acked)
  check(
    'blob: the mode names itself and the counts match it',
    relayBlob.mode === 'probe'
      ? relayBlob.steps === 281 &&
          relayBlob.expectReplies === 281 &&
          relayBlob.expectGood === 281
      : relayBlob.mode === 'service' &&
          relayBlob.steps === 310 &&
          relayBlob.expectReplies === 309 &&
          relayBlob.expectGood === 308,
    `mode ${relayBlob.mode}, steps ${relayBlob.steps}, ` +
      `${relayBlob.expectReplies}/${relayBlob.expectGood}`
  );
  check(
    'blob: the run sits inside the free window',
    relayBlob.runs.every(
      ([at, h]) =>
        at >= relayBlob.stubAt && at + h.length / 2 <= relayBlob.stubEnd
    )
  );
  check(
    'blob: the hook lands inside the MPC image',
    relayBlob.hookAt >= 0 && relayBlob.hookAt + 4 <= 0x70000
  );
  check(
    'blob: verdict block at the proven address, magic set',
    relayBlob.state === 0x3f9e74 &&
      relayBlob.stateSize === 24 &&
      relayBlob.magic === 0x5eca
  );
  check(
    'blob: matches the builder fixture',
    relayBlob.stubAt === fixture.stubAt &&
      relayBlob.hookWord === fixture.hookWord &&
      relayBlob.runs[0][1] === fixture.bodyHex,
    'blob and fixture disagree -- rerun tools/relay_blob_js.py'
  );

  // ---- the patch ----------------------------------------------------------------
  // an erased pair that carries the stock word at the hook site -- what a
  // fresh full read of the proven program looks like to the patcher
  const blankPair = () => {
    const mpc = new Uint8Array(0x70000).fill(0xff);
    const w = fixture.stockHookWord;
    mpc.set(
      [(w >>> 24) & 0xff, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff],
      fixture.hookAt
    );
    return { flash: new Uint8Array(0x100000).fill(0xff), mpc };
  };
  const patched = relayPatchPair(blankPair().flash, blankPair().mpc);
  check(
    'patch: the spliced bytes are exactly what Python assembled',
    hex(patched.flash.subarray(fixture.stubAt, fixture.end)) === fixture.bodyHex
  );
  check(
    'patch: the hook word lands big-endian at the frame-task call',
    hex(patched.mpc.subarray(fixture.hookAt, fixture.hookAt + 4)) ===
      fixture.hookWord.toString(16).padStart(8, '0')
  );
  check(
    'patch: nothing outside the payload moves',
    patched.flash[fixture.stubAt - 1] === 0xff &&
      patched.flash[fixture.end] === 0xff &&
      patched.mpc[fixture.hookAt - 1] === 0xff &&
      patched.mpc[fixture.hookAt + 4] === 0xff
  );

  const dirty = blankPair();
  dirty.flash[fixture.stubAt + 5] = 0x00;
  await throws('patch: a used region is refused', () =>
    relayPatchPair(dirty.flash, dirty.mpc)
  );
  const guard = blankPair();
  guard.flash[fixture.stubAt - 1] = 0x00;
  await throws('patch: the guard bytes before it too', () =>
    relayPatchPair(guard.flash, guard.mpc)
  );
  const foreign = blankPair();
  const fw = 0x4bffffff; // some other program's call word
  foreign.mpc.set(
    [(fw >>> 24) & 0xff, (fw >>> 16) & 0xff, (fw >>> 8) & 0xff, fw & 0xff],
    fixture.hookAt
  );
  await throws('patch: a program the blob was not built for is refused', () =>
    relayPatchPair(foreign.flash, foreign.mpc)
  );
  const small = new Uint8Array(0xfffff);
  await throws('patch: a short external image is refused', () =>
    relayPatchPair(small, blankPair().mpc)
  );
  await throws('patch: a short MPC image is refused', () =>
    relayPatchPair(blankPair().flash, new Uint8Array(0x6ffff))
  );
  const source = blankPair();
  relayPatchPair(source.flash, source.mpc);
  check(
    'patch: the inputs are copied, not written',
    source.flash[fixture.stubAt] === 0xff
  );

  // a DME already carrying a relay payload (a previous run, maybe an older
  // build's): the hook word being ours says so, and the new payload is
  // written over the old in place -- the car's second run
  const run1 = relayPatchPair(blankPair().flash, blankPair().mpc);
  const run2 = relayPatchPair(run1.flash, run1.mpc);
  check(
    'patch: a program already carrying the payload re-patches in place',
    hex(run2.flash.subarray(fixture.stubAt, fixture.end)) === fixture.bodyHex &&
      hex(run2.mpc.subarray(fixture.hookAt, fixture.hookAt + 4)) ===
        fixture.hookWord.toString(16).padStart(8, '0')
  );

  // ---- the state block ------------------------------------------------------------
  // the shape the booted stub writes when the run went clean: last step,
  // phase done, the blob's expected answers and acks (service: the
  // SP-redirect step answers nothing and the readback's 0x9F tag is not
  // an ack, hence steps-1/steps-2; probe: stock answers everything with
  // 0x81, hence steps/steps). The last answer is the blob's expectLast --
  // the monitor's own reply in the service build, stock reading the
  // intact pad back in the probe
  const u16 = (v) => [(v >> 8) & 0xff, v & 0xff];
  const probeMode = relayBlob.mode === 'probe';
  // a digest value for the round-trip only -- the verdict does not judge
  // it (the emu run's own value is printed there; the car's will differ)
  const EMU_DIGEST = 0x159f;
  const passBlock = new Uint8Array([
    ...u16(relayBlob.steps), // step: the last one
    ...u16(2), // phase: done
    ...u16(relayBlob.magic), // magic
    ...u16(relayBlob.expectReplies), // replies: every answering step
    ...u16(relayBlob.expectGood), // good: the blob's ack count
    ...u16(EMU_DIGEST),
    0,
    0,
    0,
    0, // +12 retry counter (0 mid-run), +14..15 never written
    ...relayBlob.expectLast, // last answer at +16
  ]);
  const s = relayDecodeState(passBlock);
  check(
    'state: decodes step, phase, magic, counters, last answer',
    s.step === relayBlob.steps &&
      s.phase === 2 &&
      s.magic === relayBlob.magic &&
      s.replies === relayBlob.expectReplies &&
      s.good === relayBlob.expectGood &&
      s.digest === EMU_DIGEST &&
      hex(s.last) === hex(relayBlob.expectLast)
  );
  check('verdict: the clean block passes', relayVerdict(s).ok);

  const broken = (mutate) => {
    const b = new Uint8Array(passBlock);
    mutate(b);
    return relayVerdict(relayDecodeState(b));
  };
  check(
    'verdict: a wrong magic fails',
    !broken((b) => b.set(u16(0xdead), 4)).ok
  );
  check(
    'verdict: a mid-run block fails',
    broken((b) => {
      b.set(u16(120), 0);
      b.set(u16(1), 2);
    }).checks.every((c) => c.ok) === false
  );
  check('verdict: lost replies fail', !broken((b) => b.set(u16(100), 6)).ok);
  check('verdict: unacked answers fail', !broken((b) => b.set(u16(0), 8)).ok);
  check(
    'verdict: a staging ack as the last answer fails',
    !broken((b) => b.set([0x01, 0x81], 16)).ok
  );
  if (probeMode) {
    // the probe's own notes: cc 00 with a differing tail (span held, save
    // it), a changed word (span did NOT hold), zeros (staging stalled),
    // an unexpected stock class
    const tailDiff = broken((b) =>
      b.set([0x20, 0x81, 0xcc, 0x00, 0x00, 0x00, 0x00, 0x00], 16)
    );
    check(
      'verdict: a differing reply tail fails and names the held span',
      !tailDiff.ok && tailDiff.note.includes('span held')
    );
    const notHeld = broken((b) =>
      b.set([0x20, 0x81, 0xf8, 0xf8, 0xff, 0xff, 0xff, 0xff], 16)
    );
    check(
      'verdict: a changed word fails and names the span that did not hold',
      !notHeld.ok && notHeld.note.includes('did NOT hold')
    );
    const stalled = broken((b) => b.set(new Uint8Array(8).fill(0), 16));
    check(
      'verdict: no recorded answer fails and names the stalled staging',
      !stalled.ok && stalled.note.includes('stalled')
    );
    const oddClass = broken((b) => b.set([0x03, 0x81, 0, 0, 0, 0, 0, 0], 16));
    check(
      'verdict: an unexpected stock class fails and is named',
      !oddClass.ok && oddClass.note.includes('unexpected class')
    );
  } else {
    const stockEcho = broken((b) => b.set([0x2a, 0x81, 0, 0, 0, 0, 0, 0], 16));
    check(
      "verdict: the old build's echo answer fails and is named",
      !stockEcho.ok && stockEcho.note.includes('previous build')
    );
    // the post-mortem branch: the stock program answered the readback and
    // carried the staged word back INTACT -- the code was fine, the
    // monitor died before or at its first instruction
    const intact = broken((b) =>
      b.set(
        [
          0x20,
          0x81,
          relayBlob.probeWord[0],
          relayBlob.probeWord[1],
          0xff,
          0xff,
          0xff,
          0xff,
        ],
        16
      )
    );
    check(
      'verdict: intact word fails and names the first-instruction death',
      !intact.ok && intact.note.includes('first instruction')
    );
    // the marker ladder: the monitor RAN and died in a named block (4 =
    // the poll loop)
    const marker = broken((b) =>
      b.set([0x20, 0x81, 0x04, 0x00, 0xff, 0xff, 0xff, 0xff], 16)
    );
    check(
      'verdict: a marker value fails and names the block it died in',
      !marker.ok &&
        marker.note.includes('RAN and died') &&
        marker.note.includes('poll loop')
    );
    // v12's deaf outcome: the LAST marker = ran, went deaf, self-rescued
    // (a deliberate clean reset, not a death -- but it still fails the
    // liveness check, and the note must name it for what it is)
    const deaf = broken((b) =>
      b.set(
        [0x20, 0x81, relayBlob.markers.length, 0, 0xff, 0xff, 0xff, 0xff],
        16
      )
    );
    check(
      'verdict: the self-rescue marker fails and names the deaf monitor',
      !deaf.ok && deaf.note.includes('went DEAF')
    );
    // ...and the branch where the post-reset boot rewrote the span
    const gone = broken((b) =>
      b.set([0x20, 0x81, 0, 0, 0xff, 0xff, 0xff, 0xff], 16)
    );
    check(
      'verdict: stock readback of zeros fails and names the reset boot',
      !gone.ok && gone.note.includes('boot rewrote the span')
    );
    // a post-rescue boot counter in word 0 (v12: the deaf monitor SRSTs,
    // the boot rewrites the span, the readback carries the boot value)
    const bootVal = broken((b) =>
      b.set([0x20, 0x81, 0x01, 0x00, 0xff, 0xff, 0xff, 0xff], 16)
    );
    check(
      'verdict: a boot value fails and names the two reset flavors',
      !bootVal.ok &&
        bootVal.note.includes('a boot value') &&
        bootVal.note.includes('self-rescued')
    );
    const stockRead = broken((b) => b.set([0x03, 0x81, 0, 0, 0, 0, 0, 0], 16));
    check(
      'verdict: a stock class reply fails and is named',
      !stockRead.ok && stockRead.note.includes('stock program is answering')
    );
  }
  check(
    'service window: the blob steps at ten milliseconds each',
    relayServiceMs() === relayBlob.steps * 10
  );

  // ---- the read -----------------------------------------------------------------
  // the real one-click read-by-address under the relay read: one telegram,
  // the stock 23 dialect, answered 63 + the 24 verdict bytes
  const mockSender = (block) => async (data) => {
    check(
      'read: asks the stock read-by-address at the verdict block',
      hex(data) === '233f9e7418',
      hex(data)
    );
    return [0x63, ...block];
  };
  const readState = await relayReadState(mockSender(passBlock));
  check(
    'read: the block comes back decoded',
    readState.step === relayBlob.steps &&
      readState.good === relayBlob.expectGood
  );
  check('read: the verdict over the wire passes', relayVerdict(readState).ok);

  // ---- the poll -------------------------------------------------------------------
  // the page's read window: the DME may still be booting, so failed reads are
  // retried until the block settles -- and the poll must carry NO bus claim of
  // its own (the sender's telegrams queue through the bus lock, which refuses
  // a claim's own holder: the car's first two runs refused all 18 reads
  // client-side without a byte on the wire)
  const seq = [];
  let n = 0;
  const bootingThenDone = async () => {
    n++;
    if (n < 3) {
      seq.push('throw');
      throw new Error('no answer');
    }
    seq.push('read');
    return [0x63, ...passBlock];
  };
  const polled = await relayAwaitVerdict(bootingThenDone, { sleepMs: 1 });
  check(
    'poll: retries past the boot silence and returns the settled block',
    polled.state.step === relayBlob.steps &&
      polled.attempts === 3 &&
      polled.lastWhy === '' &&
      seq.join(',') === 'throw,throw,read'
  );
  const alwaysSilent = async () => {
    throw new Error('the cable is busy: someone is programming a module');
  };
  const timedOut = await relayAwaitVerdict(alwaysSilent, {
    deadlineMs: 60,
    sleepMs: 10,
  });
  check(
    'poll: a hopeless read runs to the deadline and names the last error',
    timedOut.state === null &&
      timedOut.attempts >= 2 &&
      timedOut.lastWhy.includes('busy')
  );
  const blankBlock = new Uint8Array(24).fill(0xff);
  const blank = await relayAwaitVerdict(async () => [0x63, ...blankBlock], {
    sleepMs: 1,
  });
  check(
    'poll: a blank block (no relay program) settles at once',
    blank.state.magic === 0xffff && blank.attempts === 1
  );

  // ---- the page wiring (no DOM: the invariants the rendered page needs) ---------
  // The corpus is exactly what the browser loads: every script index.html
  // names, read and joined. A helper the screen calls that no loaded file
  // declares is a typo the editor cannot catch -- this catches it.
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..', '..');
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  const html = read('app/renderer/index.html');
  const srcAt = (src) => html.indexOf(`src="${src}"`);
  const order = (a, b) =>
    srcAt(a) !== -1 && srcAt(b) !== -1 && srcAt(a) < srcAt(b);
  check(
    'page: the blob, then the client, then the screen, then the page that mounts it',
    order('core/generated/relay-blob.js', 'core/flash/relay.js') &&
      order('core/flash/relay.js', 'screens/flashing/dme-relay.js') &&
      order('screens/flashing/dme-relay.js', 'screens/flashing/fast-page.js')
  );
  const fastPage = read('app/renderer/screens/flashing/fast-page.js');
  check(
    'page: the fast page mounts the section and repaints it',
    fastPage.includes('${fbRelayHtml()}') &&
      fastPage.includes('fbRelayRefresh();')
  );
  const screen = read('app/renderer/screens/flashing/dme-relay.js');
  const idsWanted = [
    'relay-section',
    'relay-run',
    'relay-again',
    'relay-restore',
    'relay-reason',
    'relay-result',
  ];
  check(
    'page: the section carries every id the wiring looks up',
    idsWanted.every((id) => screen.includes(`id="fb-${id}"`)),
    idsWanted.filter((id) => !screen.includes(`id="fb-${id}"`)).join(' ')
  );
  const corpus = (html.match(/src="[^"]+\.js"/g) || [])
    .map((s) => s.slice(5, -1))
    .filter((src) => !src.startsWith('core/generated/bytes'))
    .map((src) => {
      try {
        return read(`app/renderer/${src}`);
      } catch (e) {
        return '';
      }
    })
    .join('\n');
  const helpers = [
    'fbDmeGuard',
    'fbMessage',
    'fbConfirm',
    'flashLog',
    'fbSetStatus',
    'fbDmeFastFlash',
    'fbDmeOneClickInto',
    'fastFlashWire',
    'MS45_MPC_LENGTH',
    'fbDmeSaveRead',
    'fbDmeChipImage',
    'webDropSession',
    'webClaimBus',
    'MS45_SGBD',
    'ms45LiveTuneSender',
    'webBus',
    'fbDmeIsMs451',
    'fbEls',
    'fbState',
    'relayPatchPair',
    'relayReadState',
    'relayVerdict',
    'relayAwaitVerdict',
  ];
  const missing = helpers.filter(
    (h) => !new RegExp(`(function |const |let )${h}\\b`).test(corpus)
  );
  check(
    'page: every helper the screen calls is declared in the loaded corpus',
    !missing.length,
    missing.join(' ')
  );

  console.log(failures ? `\n${failures} FAIL` : '\nrelay client: ALL PASS');
  process.exit(failures ? 1 : 0);
};
main();
