#!/usr/bin/env node
// What the app says when something fails (core/errors.js explainError): each
// message the app's own code throws, held to the explanation it must get.
//
// THE BUG THIS PINS. The explainer used to look for loose words anywhere in
// the text -- 'connect', 'denied', 'sequence', 'echo', 'checksum', 'timeout'
// -- and tried the job-not-found case last. So the message thrown when there
// is NO cable ("No adapter connected") was explained as "the cable is
// present but the DME did not answer"; a module out of the cable's reach
// (IFH-0018) got "turn the ignition on"; "no job code shipped for ms450ds0"
// told the user the car's variant does not implement a job called ms450ds0;
// and a wiring archive that failed to download said to check the ignition.
// Now the interface code and the app's own phrases decide, and a message
// nothing recognises is shown as it is.
//
//   node tools/verify/test_errors.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadClassic } = require('./lib/load_classic.js');

const ROOT = path.join(__dirname, '..', '..');
const R = path.join(ROOT, 'app', 'renderer');
let passed = 0;
const ok = (what) => {
  passed++;
  if (process.env.V) console.log('  ok', what);
};

global.APP_NAME = 'BMWeb';
global.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, '');
const { explainError, errorBlock } = loadClassic('core/errors.js');
const title = (m) => explainError(m).title;

// ---- every message, as the code throws it -----------------------------------
const NO_CABLE = 'No adapter connected';
const APP = 'App error — not the car';
const CASES = [
  // no cable: the router, the tree scan, the bus
  ['no cable connected', NO_CABLE],
  ['No adapter connected', NO_CABLE],
  ['no cable is open', NO_CABLE],
  // the interface codes, with the texts framing.js / exchange.js give them
  [
    'IFH-0009: no answer from ECU (timeout)',
    'No response from the ECU (IFH-0009)',
  ],
  [
    'IFH-0009: ECU stayed busy (no answer)',
    'No response from the ECU (IFH-0009)',
  ],
  [
    'IFH-0009: the ECU did not answer the slow init (no 0x55 sync). Ignition on, engine off?',
    'No response from the ECU (IFH-0009)',
  ],
  [
    'IFH-0003: echo did not match the request (bus collision?): got 82 12',
    'The cable is not hearing itself (IFH-0003)',
  ],
  [
    'IFH-0003: no echo from the cable (is it connected to the car?)',
    'The cable is not hearing itself (IFH-0003)',
  ],
  [
    'IFH-0019: answer checksum mismatch',
    'Damaged answer from the ECU (IFH-0019)',
  ],
  [
    'IFH-0019: incomplete answer from ECU (3 bytes)',
    'Damaged answer from the ECU (IFH-0019)',
  ],
  [
    'IFH-0018: concept 0x3 is not supported on this interface',
    'This module cannot be reached from here (IFH-0018)',
  ],
  [
    'IFH-0018: this browser cannot drive the K line (no setSignals); use the macOS app for this ECU',
    'This module cannot be reached from here (IFH-0018)',
  ],
  [
    'IFH-0006: concept 2 needs the ADS interface (L line, OBD pin 20); a K+DCAN cable cannot reach this module',
    'This module needs a different cable (IFH-0006)',
  ],
  // the interpreter's own failures: never a wire explanation
  ['IFH-0056: no CommParameter set before the telegram', APP],
  ['unimplemented opcode xfoo at 12', APP],
  ['step limit at op 4711', APP],
  [
    'refusing to run write job FS_LOESCHEN: construct the VM with {allowWrites: true} to permit it',
    APP,
  ],
  ['SGBD raised error via eerr (trap 3)', APP],
  // a job, or a module, this build or this variant does not have
  ['no job DPRAM_LESEN', 'Not available on this control unit'],
  ['no job code shipped for ms450ds0', 'No data for this control unit'],
  ['no coding script shipped for kombi46', 'No data for this control unit'],
  // a shared session
  [
    'remote timeout: the owner did not answer',
    'The shared session did not answer',
  ],
  [
    'remote: the shared car did not connect',
    'The shared session did not answer',
  ],
  ['remote session ended', 'The shared session did not answer'],
  // the flasher's and the reader's own
  ['Security Access Denied', 'Security access denied'],
  ['read failed at 0x090000', 'Memory read failed'],
  [
    'ERROR_ECU_CONDITIONS_NOT_CORRECT_OR_REQUEST_SEQUENCE_ERROR',
    'ECU rejected the request',
  ],
  ['engine failed to start', 'Engine failed to start'],
  // the app's own data not arriving
  ['Failed to load chassis E46: Not Found', 'Could not load the data'],
  ['ECU archive not found for ms450ds0', 'Could not load the data'],
  ['Failed to fetch', 'Could not load the data'],
  ['Not Found', 'Could not load the data'],
  ['failed to load fault index', 'Could not load the data'],
  ['GS20 CAN reply timeout', 'The ECU timed out'],
];
for (const [msg, want] of CASES)
  assert.strictEqual(
    title(msg),
    want,
    `"${msg}" is explained as "${title(msg)}"`
  );
ok(`${CASES.length} messages get the explanation that fits them`);

// ---- a word inside a name or a sentence decides nothing ----------------------
{
  // a job's NAME may hold any word: it is still the job that is missing
  for (const job of [
    'STATUS_BUS_TIMEOUT',
    'FLASH_CHECKSUMME_LESEN',
    'STEUERN_CONNECTED_DRIVE',
    'STATUS_ECHO',
    'C_SEQUENCE_LESEN',
  ])
    assert.strictEqual(
      title(`no job ${job}`),
      'Not available on this control unit',
      `no job ${job}`
    );
  assert.ok(
    explainError('no job code shipped for ms450ds0').detail.includes(
      'ms450ds0'
    ) &&
      !/does not implement/.test(
        explainError('no job code shipped for ms450ds0').detail
      ),
    'an SGBD with no job code is not "a job the variant does not implement"'
  );
  // these words alone used to pick a wire explanation
  for (const [msg, never] of [
    ['the adapter connection is gone', 'Could not reach the ECU'],
    ['the gateway connection is gone', 'Could not reach the ECU'],
    ['the BMW Scanner cable is not connected', 'Could not reach the ECU'],
    ['NotAllowedError: permission denied', 'Security access denied'],
    [
      'the adapter answered with a bad sum',
      'Damaged answer from the ECU (IFH-0019)',
    ],
    [
      'the list of E46.wiring is not what was packed',
      'Could not reach the ECU',
    ],
  ])
    assert.notStrictEqual(
      title(msg),
      never,
      `"${msg}" must not read as "${never}"`
    );
  // and a message nothing recognises is shown as it is
  const odd = explainError('pack E46 is shorter than its index says');
  assert.strictEqual(odd.title, 'Something went wrong');
  assert.strictEqual(odd.detail, 'pack E46 is shorter than its index says');
  ok('a loose word picks no explanation; the unknown is shown as written');
}

// ---- no interface code the transport raises is left to the fallback ----------
{
  const codes = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!/^(generated|vendor|data)$/.test(e.name)) walk(p);
      } else if (/\.js$/.test(e.name) && e.name !== 'bundle.js') {
        for (const m of fs
          .readFileSync(p, 'utf8')
          .matchAll(/ifhError\(\s*'(IFH-\d{4})'/g))
          codes.add(m[1]);
      }
    }
  };
  walk(R);
  assert.ok(
    codes.size >= 5,
    `only ${codes.size} IFH codes found in the renderer`
  );
  for (const code of codes)
    assert.notStrictEqual(
      title(`${code}: x`),
      'Something went wrong',
      `${code} is raised by the transport and explained by nothing`
    );
  ok(`all ${codes.size} interface codes the transport raises are explained`);
}

// ---- the block ---------------------------------------------------------------
{
  const html = errorBlock(
    'IFH-0018: concept 0x3 is not supported on this interface'
  );
  assert.ok(
    html.includes('concept 0x3 is not supported on this interface'),
    'IFH-0018 says which concept is in the way'
  );
  assert.ok(
    !/ignition/i.test(html),
    'and does not send the user to the ignition'
  );
  assert.ok(
    !/ignition|cable/i.test(
      errorBlock('Failed to load chassis E46: Not Found')
    ),
    'a failed download does not ask about the cable'
  );
  ok('the block carries the detail that fits');
}

console.log(`test_errors: ${passed} checks passed`);
