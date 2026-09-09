// The search command over an in-memory index (the matcher is the app's;
// what is pinned here is the CLI around it: rows, links, the chassis
// filter, JSON) and the index cache: where it lives, when it refreshes,
// and what happens when the site cannot be reached. No network: the fetch
// is a stand-in that serves a gzipped index from memory.
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { CliError } from '../src/args.ts';
import type { SearchIndex } from '../src/runtime.ts';
import {
  cacheDir,
  indexCachePath,
  loadIndex,
  parseIndex,
  runSearch,
  searchRows,
  SITE,
} from '../src/search.ts';
import { loadRuntime } from '../src/runtime.ts';

/** Two modules, one of which two cars carry and one no car does. */
const INDEX: SearchIndex = {
  v: 1,
  modules: [
    {
      sgbd: 'ms450',
      label: 'MS45.1 for M54',
      code: 'MS450',
      chassis: ['E46', 'E85'],
    },
    { sgbd: 'orphan', label: 'A trailer module', code: '', chassis: [] },
  ],
  entries: [
    {
      t: 'k',
      i: 0,
      m: 'm_fs',
      n: 2,
      l: 'Fehlerspeicher lesen',
      e: 'Read fault memory',
      s: 's_fs',
      ti: 'Fehlerspeicher',
      tie: 'Fault memory',
      j: ['FS_LESEN', 'FS_LESEN_DETAIL'],
    },
    {
      t: 'k',
      i: 0,
      m: 'm_fs',
      n: 5,
      l: 'Clear fault memory',
      j: ['FS_LOESCHEN'],
      w: 1,
    },
    {
      t: 's',
      i: 0,
      s: 's_status',
      ti: 'Status',
      k: ['STAT_MOTORDREHZAHL_WERT'],
    },
    {
      t: 'k',
      i: 1,
      m: 'm_main',
      n: 1,
      l: 'Read fault memory',
      j: ['FS_LESEN'],
    },
  ],
};

const dir = mkdtempSync(join(tmpdir(), 'bmweb-search-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('runSearch: rows carry the deep link, both languages match, writes are marked', () => {
  const lines = runSearch('fault memory', { index: INDEX, limit: 50 });
  const text = lines.join('\n');
  assert.match(text, new RegExp(`${SITE}#car/E46/ms450/m_fs/s_fs`));
  assert.match(text, /F5\s+Clear fault memory\s+FS_LOESCHEN\s+\[WRITE\]/);
  const german = runSearch('fehlerspeicher', { index: INDEX, limit: 50 }).join(
    '\n'
  );
  assert.match(
    german,
    /Read fault memory/,
    'the German query finds the same key'
  );
  // the module no car carries is listed last and is not openable
  assert.match(text, /no car carries/);
  assert.match(text, /\(not openable\)/);
});

test('runSearch: --chassis narrows to one car and the total counts per car', () => {
  const rows = searchRows(
    loadRuntime().searchRun(INDEX, 'fault', { chassis: 'e85' })
  );
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.chassis === 'E85'));
  assert.ok(rows.every((r) => r.link && r.link.includes('#car/E85/')));
});

test('runSearch: JSON rows are flat and typed', () => {
  const doc = JSON.parse(
    runSearch('FS_LESEN', { index: INDEX, json: true }).join('')
  );
  assert.equal(doc.query, 'FS_LESEN');
  const row = doc.rows.find(
    (r: { key: string; chassis: string }) =>
      r.key === 'F2' && r.chassis === 'E46'
  );
  assert.ok(row, 'the E46 F2 row');
  assert.equal(row.kind, 'key');
  assert.equal(row.menu, 'm_fs');
  assert.equal(row.screen, 's_fs');
  assert.deepEqual(row.jobs, ['FS_LESEN', 'FS_LESEN_DETAIL']);
  assert.equal(row.writes, false);
  // a screen entry: found by its result key, with no F-key or menu of its own
  const status = JSON.parse(
    runSearch('motordrehzahl', { index: INDEX, json: true }).join('')
  );
  const screen = status.rows.find((r: { kind: string }) => r.kind === 'screen');
  assert.ok(screen, 'the status screen row');
  assert.equal(screen.key, null);
  assert.equal(screen.menu, null);
  assert.equal(screen.screen, 's_status');
  assert.match(screen.link, /#car\/E46\/ms450\/\/s_status$/);
});

test('runSearch: a one-letter query is refused, an unmatched one says so', () => {
  assert.throws(() => runSearch('x', { index: INDEX }), CliError);
  assert.deepEqual(runSearch('zzzz', { index: INDEX }), [
    'no results for "zzzz"',
  ]);
});

test('cache location honours XDG_CACHE_HOME and falls back to ~/.cache', () => {
  assert.equal(cacheDir({ XDG_CACHE_HOME: '/x/cache' }), '/x/cache/bmweb-cli');
  assert.match(cacheDir({}), /\.cache[\\/]bmweb-cli$/);
  assert.match(
    indexCachePath({ XDG_CACHE_HOME: '/x' }),
    /search-index\.json\.gz$/
  );
});

test('parseIndex refuses a format it does not read', () => {
  assert.throws(
    () =>
      parseIndex(gzipSync(JSON.stringify({ v: 99, modules: [], entries: [] }))),
    (e: unknown) => e instanceof CliError && /v99/.test(e.message)
  );
  assert.throws(() => parseIndex(new Uint8Array([1, 2, 3])), CliError);
});

test('loadIndex: fetches once, then serves the cache; --refresh fetches again', async () => {
  const env = { XDG_CACHE_HOME: dir };
  const gz = gzipSync(JSON.stringify(INDEX));
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response(gz, { status: 200 });
  }) as unknown as typeof fetch;
  const first = await loadIndex({ env, fetchImpl });
  assert.equal(first.modules.length, 2);
  assert.equal(calls, 1);
  assert.ok(existsSync(indexCachePath(env)), 'the index was cached');
  assert.deepEqual(readFileSync(indexCachePath(env)), gz, 'byte for byte');
  await loadIndex({ env, fetchImpl });
  assert.equal(calls, 1, 'a fresh cache is served without a fetch');
  await loadIndex({ env, fetchImpl, refresh: true });
  assert.equal(calls, 2, '--refresh fetches');
});

test('loadIndex: a stale cache is refreshed, and kept when the site is unreachable', async () => {
  const env = { XDG_CACHE_HOME: dir };
  const file = indexCachePath(env);
  const old = new Date(Date.now() - 2 * 24 * 3600 * 1000);
  utimesSync(file, old, old);
  const warnings: string[] = [];
  const failing = (async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch;
  const index = await loadIndex({
    env,
    fetchImpl: failing,
    warn: (l) => warnings.push(l),
  });
  assert.equal(index.modules.length, 2, 'the stale copy is used');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] as string, /offline/);
  // stale + reachable: the fetch wins and the file is fresh again
  let calls = 0;
  const ok = (async () => {
    calls++;
    return new Response(gzipSync(JSON.stringify(INDEX)), { status: 200 });
  }) as unknown as typeof fetch;
  await loadIndex({ env, fetchImpl: ok });
  assert.equal(calls, 1);
  // no cache at all + unreachable: an error naming the URL
  rmSync(file);
  await assert.rejects(
    loadIndex({ env, fetchImpl: failing, warn: () => {} }),
    (e: unknown) =>
      e instanceof CliError && /search-index\.json\.gz/.test(e.message)
  );
  // an HTTP error is reported as such
  const gone = (async () =>
    new Response('', { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(
    loadIndex({ env, fetchImpl: gone }),
    (e: unknown) => e instanceof CliError && /HTTP 404/.test(e.message)
  );
});
