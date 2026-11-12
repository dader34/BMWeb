#!/usr/bin/env node
// The MS45.1 recovery's host (app/renderer/screens/flashing/recovery.js):
// the parts with no car and no network in them.
//
// WHAT THIS PROVES
//   1. The verdict on an identification: only an MS45.1 whose loader reports
//      anything but normal operation, or that sits in a flasher, is offered
//      the recovery; a DME that is fine, silent or another type is not.
//   2. The files: the DME's own assembly number is followed through the ZB
//      history to the newest one the table still lists, and that row's
//      program and data files are the ones taken -- and when any link is
//      missing the recovery refuses rather than guess.
//   3. The progress bar is drawn the same width at every percentage.
//
// Run: node tools/verify/test_recovery.js
const assert = require('assert');
global.kfpDaten = require('../../app/renderer/core/kfp/daten.js');
const r = require('../../app/renderer/screens/flashing/recovery.js');

const ok = (name, fn) => {
  fn();
  console.log('  ok   ' + name);
};

const ident = (over) => ({
  ident: {
    answered: true,
    hwRef: '0044570',
    programmingStatus: 'Normalbetrieb',
    ...over,
  },
});

ok('the verdict on an identification', () => {
  assert.strictEqual(r.fbRecoveryVerdict(null), '');
  // the Flashing app's fresh state: nothing asked yet
  assert.strictEqual(r.fbRecoveryVerdict({ ident: { hwRef: '' } }), '');
  assert.strictEqual(r.fbRecoveryVerdict(ident({ answered: null })), '');
  assert.strictEqual(r.fbRecoveryVerdict(ident({ answered: false })), 'silent');
  assert.strictEqual(r.fbRecoveryVerdict(ident()), 'ok');
  for (const status of [
    'Programm nicht vorhanden oder nicht vollständig',
    'Daten nicht vorhanden oder nicht vollständig',
    'Signaturprüfung PAF nicht durchgeführt',
    'Programmprogrammiersitzung aktiv',
    '',
  ])
    assert.strictEqual(
      r.fbRecoveryVerdict(ident({ programmingStatus: status })),
      'recover',
      status
    );
  // in a flasher nothing of KWP answers, the status least of all
  assert.strictEqual(
    r.fbRecoveryVerdict(ident({ inFlasher: true, programmingStatus: '' })),
    'recover'
  );
  // the MS45.0 and anything else: not the MS45.1 recovery's to flash
  assert.strictEqual(r.fbRecoveryVerdict(ident({ hwRef: '0044560' })), 'other');
  assert.strictEqual(
    r.fbRecoveryVerdict(
      ident({ hwRef: '0044560', programmingStatus: 'Speicher gelöscht' })
    ),
    'other'
  );
  // the MS45.0 has a recovery of its own, which the MS45.1 is not for
  const ms450 = r.FB_RECOVERY_TARGETS.ms450;
  assert.strictEqual(ms450.stockLoader, true, 'the MS45.0 goes by its loader');
  assert.strictEqual(r.FB_RECOVERY_TARGETS.ms451.stockLoader, false);
  assert.strictEqual(
    r.fbRecoveryVerdict(ident({ hwRef: '0044560' }), ms450),
    'ok'
  );
  assert.strictEqual(
    r.fbRecoveryVerdict(
      ident({ hwRef: '0044560', programmingStatus: 'Speicher gelöscht' }),
      ms450
    ),
    'recover'
  );
  assert.strictEqual(r.fbRecoveryVerdict(ident(), ms450), 'other');
});

// a ZB table and history in the SP-Daten's own layout
const TABLE = [
  ';ZB-NR  TYP-NR  HW-NR  IX  SW-NR',
  '7545150,1037367,7561382,A,7545151DA',
  '7551615,1037367,7561382,A,7551616DA',
  '7561533,1037367,7561382,A,7561533DA',
  '7559999,1037367,7559998,B,7559997DA',
].join('\r\n');
const HISTORY = [
  '7545150,7551615,x',
  '7551615,7561533,x',
  '7561533,7599999,x',
].join('\r\n');
const NAMES = [
  'MDS451.DAT',
  'MDS451.HIS',
  '7561382A.0PA',
  'P7545151.0DA',
  'P7551616.0DA',
  'P7561533.0DA',
];

ok('no assembly number: the newest the folder holds, newest first', () => {
  // only rows nothing has replaced, with both files there: 7545150 and
  // 7551615 were replaced, 7559999 has no files
  assert.deepStrictEqual(r.fbRecoveryNewest(TABLE, HISTORY, NAMES), [
    { zb: '7561533', program: '7561382A.0PA', data: 'P7561533.0DA' },
  ]);
  // with no history every listed row is a newest one, highest number first
  assert.deepStrictEqual(
    r.fbRecoveryNewest(TABLE, '', NAMES).map((x) => x.zb),
    ['7561533', '7551615', '7545150']
  );
  assert.deepStrictEqual(r.fbRecoveryNewest('', '', NAMES), []);
});

ok('the newest program and data for an assembly number', () => {
  // followed through the history to the newest the table lists (7599999 is
  // named by the history and is not in the table: not taken)
  assert.deepStrictEqual(r.fbRecoveryPick('7545150', TABLE, HISTORY, NAMES), {
    zb: '7561533',
    program: '7561382A.0PA',
    data: 'P7561533.0DA',
  });
  // already the newest: itself
  assert.strictEqual(
    r.fbRecoveryPick('7561533', TABLE, HISTORY, NAMES).zb,
    '7561533'
  );
  // no history file: the DME's own assembly number, as it is
  assert.deepStrictEqual(r.fbRecoveryPick('7545150', TABLE, '', NAMES), {
    zb: '7545150',
    program: '7561382A.0PA',
    data: 'P7545151.0DA',
  });
});

ok('it refuses rather than guess', () => {
  // the DME gave no assembly number: nothing says which data is this car's
  for (const zb of ['', null, undefined, '75451', 'ABCDEFG'])
    assert.throws(
      () => r.fbRecoveryPick(zb, TABLE, HISTORY, NAMES),
      /does not report its assembly number/
    );
  assert.throws(
    () => r.fbRecoveryPick('7000000', TABLE, HISTORY, NAMES),
    /do not list assembly number 7000000/
  );
  // the row is there, a file it names is not
  assert.throws(
    () => r.fbRecoveryPick('7559999', TABLE, HISTORY, NAMES),
    /do not hold its program file/
  );
  assert.throws(
    () =>
      r.fbRecoveryPick(
        '7561533',
        TABLE,
        HISTORY,
        NAMES.filter((n) => n !== 'P7561533.0DA')
      ),
    /do not hold its data file/
  );
});

ok('the progress bar', () => {
  assert.strictEqual(r.fbRecoveryBar(0), `[${'.'.repeat(40)}]  0 %`);
  assert.strictEqual(r.fbRecoveryBar(100), `[${'#'.repeat(40)}]  100 %`);
  assert.strictEqual(
    r.fbRecoveryBar(25),
    `[${'#'.repeat(10)}${'.'.repeat(30)}]  25 %`
  );
  for (const p of [-5, 0, 12.4, 50, 99.6, 250, NaN])
    assert.strictEqual(r.fbRecoveryBar(p).indexOf(']'), 41, String(p));
});

ok(
  'the host with no Flashing state: every field empty, nothing started',
  () => {
    const h = r.IPO_RECOVERY_HOST;
    global.fbState = { dme: null, running: false };
    assert.strictEqual(h.read('state'), '');
    // no cable: said so, and the screen's own looking never asks for one
    assert.strictEqual(
      h.read('headline'),
      'No cable connected. Connect it in the top bar.'
    );
    h.start('watch');
    assert.strictEqual(h.read('state'), '');
    global.webBus = { connected: true };
    assert.strictEqual(h.read('headline'), 'Looking for the DME...');
    delete global.webBus;
    for (const f of [
      'dme',
      'vin',
      'program',
      'data',
      'assembly',
      'status',
      'newest',
      'step',
      'bar',
      'nonsense',
    ])
      assert.strictEqual(h.read(f), '', f);
    // Recover with no DME identified as needing it: not a step, not started
    h.start('recover');
    h.start('anything');
    assert.strictEqual(h.read('state'), '');
  }
);

console.log('ALL PASS');
