// The runtime loader: every listed app file is in the package and loads,
// and the functions the commands call exist once loaded.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadRuntime, RUNTIME_DIR, RUNTIME_FILE_LIST } from '../src/runtime.ts';

test('every runtime file was synced into the package', () => {
  assert.ok(RUNTIME_FILE_LIST.length >= 15, 'the list is not empty');
  for (const rel of RUNTIME_FILE_LIST)
    assert.ok(
      existsSync(join(RUNTIME_DIR, rel)),
      `${rel} missing from runtime/`
    );
});

test('the app functions the commands call are all there', () => {
  const R = loadRuntime();
  const fns = [
    'ipofDecodeExec',
    'ipofInventory',
    'ipofIsCompiled',
    'ipofIsSource',
    'ipofIsInclude',
    'ipofStem',
    'ipofScanIncludes',
    'ipofCompileSource',
    'ipoMenuItems',
    'ipoScreenForMenu',
    'ipoNeedsConfirm',
    'isWriteJob',
    'searchTerms',
    'searchRun',
    'searchHitRoute',
    'garageShareEncode',
    'garageShareDecode',
    'garageScanSummary',
    'garageDiffScans',
    'garageDiffCounts',
    'garageFaultKeys',
  ] as const;
  for (const f of fns)
    assert.equal(typeof R[f], 'function', `${f} is a function`);
  assert.equal(typeof R.IPO_REF_SCREEN, 'number');
  assert.equal(typeof R.IPO_REF_MENU, 'number');
  assert.equal(typeof R.SEARCH_INDEX_VERSION, 'number');
});

test('the ident captions are lifted from protocol.js, not restated here', () => {
  const R = loadRuntime();
  assert.ok(Array.isArray(R.IPO_IDENT_ROWS), 'IPO_IDENT_ROWS lifted');
  const variant = R.IPO_IDENT_ROWS.find(([keys]) => keys.includes('VARIANTE'));
  assert.ok(variant, 'VARIANTE is captioned');
  assert.equal(variant[1], 'Variant');
});

test("the write verdict is the app's: reads never, plumbing never, writes yes", () => {
  const R = loadRuntime();
  assert.equal(R.ipoNeedsConfirm('FS_LESEN'), false);
  assert.equal(R.ipoNeedsConfirm('DIAGNOSE_ENDE'), false);
  assert.equal(R.ipoNeedsConfirm('FS_LOESCHEN'), true);
  assert.equal(R.ipoNeedsConfirm('STEUERN_LAMBDA'), true);
});

test('loading twice hands back the same runtime', () => {
  assert.equal(loadRuntime(), loadRuntime());
});
