// The report commands against links built with the app's own encoder
// (garageShareEncode), so a change to the payload format on the app side
// shows up here as a decode failure rather than in a user's terminal.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CliError } from '../src/args.ts';
import {
  decodeReport,
  identRows,
  payloadOf,
  reportDiff,
  reportShow,
} from '../src/report.ts';
import { loadRuntime, type GarageScan } from '../src/runtime.ts';

const CAR = { label: 'E46 325i', chassis: 'E46' };

/** The first read: two DME faults, a quiet IHKA, and a silent EGS. */
const SCAN_A: GarageScan = {
  kind: 'faults',
  at: '2026-09-01T10:00:00Z',
  chassis: 'E46',
  report: {
    kind: 'faults',
    modules: [
      {
        sgbd: 'ms450',
        via: 'd_motor',
        label: 'DME MS45',
        codes: [
          {
            F_HEX_CODE: '27-C3-22',
            F_ORT_NR: 39,
            F_ORT_TEXT: '27C3 DMTL pump current too high',
            F_HFK: 3,
            F_VORHANDEN_TEXT: 'Fehler momentan vorhanden',
          },
          {
            F_ORT_NR: 120,
            F_ORT_TEXT: 'Lambda sensor heater, bank 1',
            F_HFK: 1,
            F_VORHANDEN_TEXT: 'Fehler momentan nicht vorhanden',
          },
        ],
      },
      { sgbd: 'ihka46', via: 'd_005b', label: 'IHKA', codes: [] },
    ],
    silent: [{ target: 'd_0044', label: 'EGS', error: 'no answer' }],
  },
};

/** A week later: the lambda fault cleared, a camshaft fault new, EGS answers. */
const SCAN_B: GarageScan = {
  kind: 'faults',
  at: '2026-09-08T12:00:00Z',
  chassis: 'E46',
  report: {
    kind: 'faults',
    modules: [
      {
        sgbd: 'ms450',
        via: 'd_motor',
        label: 'DME MS45',
        codes: [
          // the status byte moved (22 -> 62) and the counter climbed: same fault
          {
            F_HEX_CODE: '27-C3-62',
            F_ORT_NR: 39,
            F_ORT_TEXT: '27C3 DMTL pump current too high',
            F_HFK: 5,
          },
          {
            F_HEX_CODE: '2A-0B-22',
            F_ORT_TEXT: '2A0B Camshaft sensor, inlet',
            F_HFK: 1,
          },
        ],
      },
      { sgbd: 'ihka46', via: 'd_005b', label: 'IHKA', codes: [] },
      { sgbd: 'gs20', via: 'd_0044', label: 'EGS', codes: [] },
    ],
    silent: [],
  },
};

/** An identification read. */
const SCAN_ID: GarageScan = {
  kind: 'ident',
  at: '2026-09-08T12:30:00Z',
  chassis: 'E46',
  report: {
    kind: 'ident',
    modules: [
      {
        sgbd: 'ms450',
        label: 'DME MS45',
        codes: [],
        ident: {
          VARIANTE: 'MS450DS0',
          ID_SW_NR: '7 545 116',
          ID_DATUM_KW: '12',
          ID_DATUM_JAHR: '04',
          EXTRA_KEY: 'x',
          _private: 'hidden',
        },
      },
    ],
    silent: [],
  },
};

/**
 * A link for a scan, exactly as the Garage's Share button makes one. The
 * Garage stamps a summary on every scan it stores and the payload copies
 * it, so the scan is completed the same way before encoding.
 */
async function link(scan: GarageScan): Promise<string> {
  const R = loadRuntime();
  const stored = { ...scan, summary: R.garageScanSummary(scan.report) };
  return `https://bmweb.danner.ink/#report/${await R.garageShareEncode(stored, CAR)}`;
}

test('payloadOf: a whole link, a fragment, a bare payload; a link without one refused', () => {
  assert.equal(payloadOf('https://x/#report/abc'), 'abc');
  assert.equal(payloadOf(' #report/abc '), 'abc');
  assert.equal(payloadOf('report/abc'), 'abc');
  assert.equal(payloadOf('abc'), 'abc');
  assert.throws(() => payloadOf('https://bmweb.danner.ink/'), CliError);
});

test('decodeReport round-trips what the app encoded, VIN-free', async () => {
  const p = await decodeReport(await link(SCAN_A));
  assert.equal(p.kind, 'faults');
  assert.equal(p.label, 'E46 325i');
  assert.equal(p.chassis, 'E46');
  assert.equal(p.report.modules.length, 2);
  assert.equal(p.summary && p.summary.faults, 2);
  assert.ok(!('vin' in p), 'no VIN in the payload');
  await assert.rejects(decodeReport('not-a-payload'), CliError);
  await assert.rejects(decodeReport(''), CliError);
});

test('report show: header, one row per fault, a quiet module, the silent list', async () => {
  const lines = await reportShow(await link(SCAN_A), false);
  const text = lines.join('\n');
  assert.match(text, /Report\s+fault memories of E46 325i \/ E46/);
  assert.match(text, /Modules\s+2 read, 1 with faults, 2 faults, 1 silent/);
  assert.match(text, /^MODULE\s+CODE\s+TEXT\s+COUNT\s+STATE$/m);
  assert.match(
    text,
    /^DME MS45\s+27C3\s+DMTL pump current too high\s+3\s+present$/m
  );
  assert.match(
    text,
    /^DME MS45\s+120\s+Lambda sensor heater, bank 1\s+1\s+stored$/m
  );
  assert.match(text, /^IHKA\s+no faults stored$/m);
  assert.match(text, /Silent \(1\):\n\s+D_0044\s+EGS\s+no answer/);
});

test('report show --json is the decoded payload', async () => {
  const doc = JSON.parse(
    (await reportShow(await link(SCAN_A), true)).join('\n')
  );
  assert.equal(doc.report.modules[0].codes[0].F_HEX_CODE, '27-C3-22');
});

test('report show: an ident report prints captioned fields, then the rest', async () => {
  const lines = await reportShow(await link(SCAN_ID), false);
  const text = lines.join('\n');
  assert.match(text, /Report\s+identification of E46 325i/);
  assert.match(text, /^MODULE\s+FIELD\s+VALUE$/m);
  assert.match(text, /^DME MS45\s+Variant\s+MS450DS0$/m);
  assert.match(text, /^DME MS45\s+Software number\s+7 545 116$/m);
  assert.match(text, /Build date \(week\/year\) \(ID_DATUM_KW\)\s+12/);
  assert.match(
    text,
    /^DME MS45\s+EXTRA_KEY\s+x$/m,
    'an uncaptioned field still prints'
  );
  assert.doesNotMatch(text, /_private/, 'underscore keys are internal');
  const rows = identRows({ ID_SW_NR: '1', VARIANTE: 'V' });
  assert.deepEqual(
    rows.map((r) => r[1]),
    ['VARIANTE', 'ID_SW_NR'],
    "in the app's caption order, not the record's"
  );
});

test('report diff: new, cleared, still present, and the module that started answering', async () => {
  const lines = await reportDiff(await link(SCAN_A), await link(SCAN_B), false);
  const text = lines.join('\n');
  assert.match(
    text,
    /Changes\s+1 new, 1 cleared, 1 still present, 1 module changed/
  );
  assert.match(text, /^\s+\+\s+2A0B\s+Camshaft sensor, inlet\s+1$/m);
  assert.match(text, /^\s+-\s+120\s+Lambda sensor heater, bank 1\s+1$/m);
  assert.match(
    text,
    /^\s+=\s+27C3\s+DMTL pump current too high\s+5$/m,
    'a moved status byte is the same fault'
  );
  assert.match(text, /^IHKA\s+unchanged$/m);
  assert.match(text, /Answering changed:\n\s+answering now\s+EGS/);
});

test('report diff: a module missing from the newer read is unread, not cleared', async () => {
  const lines = await reportDiff(await link(SCAN_B), await link(SCAN_A), false);
  const text = lines.join('\n');
  assert.match(text, /^EGS\s+\(not read in the newer report\)$/m);
  assert.match(text, /Changes\s+1 new, 1 cleared/);
  const doc = JSON.parse(
    (await reportDiff(await link(SCAN_B), await link(SCAN_A), true)).join('\n')
  );
  assert.equal(doc.counts.added, 1);
  assert.equal(doc.counts.cleared, 1);
  assert.equal(doc.counts.same, 1);
  assert.ok(
    doc.modules.some(
      (m: { sgbd: string; unread?: boolean }) => m.sgbd === 'gs20' && m.unread
    )
  );
  assert.equal(doc.from.at, SCAN_B.at);
  assert.equal(doc.to.at, SCAN_A.at);
});
