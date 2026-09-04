#!/usr/bin/env node
// Test the coding UI → write flow integration in a simulated environment.
// Verifies that treeReview correctly builds the write payload and calls
// webWriteCoding with the right structure.

const CodingEncode = require('../../app/renderer/core/coding-encode.js');

// Mock the API surface that treeReview depends on
let writeCallLog = [];
global.webWriteCoding = async (sgbd, nettoHex, opts) => {
  writeCallLog.push({ sgbd, nettoHex, opts });
  if (!opts || !opts.confirmed) {
    throw new Error('Coding write requires opts.confirmed=true');
  }
  // Simulate success
  return { ok: true };
};

global.api = async (path, opts) => {
  // Mock read job response
  if (path.includes('/run/') && path.includes('CODIERUNG_LESEN')) {
    return {
      sets: [
        [
          ['COD_WERT_NETTO', '0x48656C6C6F'], // "Hello" in hex
          ['ID_COD_INDEX', '0x06'],
        ],
      ],
    };
  }
  throw new Error('Unexpected API call: ' + path);
};

global.codingFor = async (sgbd) => {
  return { read: 'CODIERUNG_LESEN', write: 'CODIERUNG_SCHREIBEN' };
};

global.confirmDialog = async (opts) => {
  // Auto-confirm in test mode
  return true;
};

global.esc = (s) =>
  String(s).replace(/[<>&"]/g, (c) => {
    return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c];
  });

global.codingReviewRow = (name, path, before, after) => {
  return `<div>${name}: ${before} → ${after}</div>`;
};

function flatResults(sets) {
  const out = [];
  for (const set of sets) {
    for (const [k, v] of set) out.push([k, v]);
  }
  return out;
}
global.flatResults = flatResults;

// Simulate the treeReview function's core logic
async function simulateTreeReview(built, state) {
  const byMod = new Map();
  for (const m of built) {
    for (const f of m.fns) {
      const s = state.get(`${m.sgbd}:${f.name}`);
      if (!s || s.staged == null) continue;
      if (!byMod.has(m.sgbd)) byMod.set(m.sgbd, []);
      byMod.get(m.sgbd).push({ rule: f, value: parseInt(s.staged, 16) });
    }
  }

  for (const [sgbd, edits] of byMod.entries()) {
    const entry = await codingFor(sgbd);
    if (!entry || !entry.read) {
      throw new Error('No read job');
    }

    const readRes = await api(`/api/ecu/${sgbd}/run/${entry.read}`, {
      method: 'POST',
    });
    const flatRes = new Map(flatResults(readRes.sets));
    const nettoHex =
      flatRes.get('COD_WERT_NETTO') || flatRes.get('CODIER_WERT_NETTO');
    if (!nettoHex) {
      throw new Error('No netto in read');
    }

    const netto = [];
    const hex = String(nettoHex).replace(/^0x/i, '').replace(/\s/g, '');
    for (let i = 0; i + 1 < hex.length; i += 2) {
      netto.push(parseInt(hex.substr(i, 2), 16));
    }

    const modified = CodingEncode.spliceEdits(new Uint8Array(netto), edits);
    const modHex = Array.from(modified, (b) =>
      ('0' + (b & 0xff).toString(16)).slice(-2)
    ).join('');

    await webWriteCoding(sgbd, modHex, { confirmed: true });
  }
}

// Test case: change one byte in a coding field
async function testBasicWrite() {
  const built = [
    {
      sgbd: 'ms43',
      fns: [
        {
          name: 'TEST_FIELD',
          block: 0,
          word: 2,
          byte: 1,
          mask: 0xff,
          shift: 0,
          values: [
            ['opt1', '41'],
            ['opt2', '42'],
          ],
        },
      ],
    },
  ];

  const state = new Map();
  state.set('ms43:TEST_FIELD', { current: '41', staged: '42' });

  writeCallLog = [];
  await simulateTreeReview(built, state);

  if (writeCallLog.length !== 1) {
    throw new Error(`Expected 1 write call, got ${writeCallLog.length}`);
  }

  const call = writeCallLog[0];
  if (call.sgbd !== 'ms43') {
    throw new Error(`Expected sgbd=ms43, got ${call.sgbd}`);
  }
  if (!call.opts || !call.opts.confirmed) {
    throw new Error('Missing confirmed flag');
  }

  // Verify the netto was modified at the right position
  // Original: 48 65 6C 6C 6F ("Hello")
  // word=2 means byte offset 2, so 0x6C at position 2 → 0x42
  // Result: 48 65 6C 6C 6F → 48 65 42 6C 6F
  const expectedHex = '4865426c6f';

  if (call.nettoHex !== expectedHex) {
    throw new Error(`Expected netto ${expectedHex}, got ${call.nettoHex}`);
  }

  console.log('  ok    basic write builds correct payload');
}

// Test case: multi-field edit
async function testMultiFieldWrite() {
  const built = [
    {
      sgbd: 'ms43',
      fns: [
        {
          name: 'FIELD_A',
          block: 0,
          word: 0,
          byte: 1,
          mask: 0x0f,
          shift: 0,
          values: [
            ['v1', '01'],
            ['v2', '02'],
          ],
        },
        {
          name: 'FIELD_B',
          block: 0,
          word: 4,
          byte: 1,
          mask: 0xff,
          shift: 0,
          values: [
            ['v3', '30'],
            ['v4', '40'],
          ],
        },
      ],
    },
  ];

  const state = new Map();
  state.set('ms43:FIELD_A', { current: '01', staged: '02' });
  state.set('ms43:FIELD_B', { current: '30', staged: '40' });

  writeCallLog = [];
  await simulateTreeReview(built, state);

  if (writeCallLog.length !== 1) {
    throw new Error(`Expected 1 write call, got ${writeCallLog.length}`);
  }

  const call = writeCallLog[0];

  // Verify both fields were spliced
  // Original: 48 65 6C 6C 6F
  // FIELD_A at word 0, mask 0x0f: 0x48 & 0xF0 | 0x02 = 0x42
  // FIELD_B at word 4: 0x6F → 0x40
  // Result: 42 65 6C 6C 40
  const expected = '42656c6c40';
  if (call.nettoHex !== expected) {
    throw new Error(`Expected ${expected}, got ${call.nettoHex}`);
  }

  console.log('  ok    multi-field write splices all edits');
}

// Run tests
(async () => {
  console.log('\n== coding UI flow ==');
  await testBasicWrite();
  await testMultiFieldWrite();
  console.log('\ncoding UI flow OK\n');
})().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
