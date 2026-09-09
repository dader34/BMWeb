/**
 * @file The `search` command: the corpus job search, over the index the
 * hosted site serves.
 *
 * The matcher and the deep-link builder are the app's own (screens/search/
 * match.js and open.js). The index is ~2 MB gzipped and is built at the
 * site's export time from data this package must not carry, so it is
 * fetched once, kept under the user's cache directory, and refreshed when
 * it is a day old or on --refresh.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { CliError } from './args.ts';
import { formatTable } from './table.ts';
import {
  loadRuntime,
  type SearchHit,
  type SearchIndex,
  type SearchResult,
} from './runtime.ts';

/** The hosted app; deep links and the index fetch both go here. */
export const SITE = 'https://bmweb.danner.ink/';

/** Where the site serves the index. */
export const INDEX_URL = `${SITE}api/search-index.json.gz`;

/** A cached index older than this is refreshed. */
export const INDEX_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The cache directory: $XDG_CACHE_HOME/bmweb-cli, else ~/.cache/bmweb-cli.
 * @param env - the environment (process.env unless a test says otherwise)
 * @returns the directory path
 */
export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const base =
    env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.trim()
      ? env.XDG_CACHE_HOME
      : join(homedir(), '.cache');
  return join(base, 'bmweb-cli');
}

/**
 * The cached index file.
 * @param env - the environment
 * @returns the file path
 */
export function indexCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(cacheDir(env), 'search-index.json.gz');
}

/** How loadIndex may be steered, mostly by tests. */
export interface LoadIndexOptions {
  /** ignore the cache's age */
  refresh?: boolean;
  /** the fetch to use; the global one by default */
  fetchImpl?: typeof fetch;
  /** the environment, for the cache location */
  env?: NodeJS.ProcessEnv;
  /** where warnings go */
  warn?: (line: string) => void;
}

/**
 * Parse the gzipped index and check its format version.
 * @param gz - the file bytes
 * @returns the index
 */
export function parseIndex(gz: Uint8Array): SearchIndex {
  const R = loadRuntime();
  let doc: SearchIndex;
  try {
    doc = JSON.parse(gunzipSync(gz).toString('utf8')) as SearchIndex;
  } catch {
    throw new CliError('the search index is not readable (not gzipped JSON)');
  }
  if (!doc || doc.v !== R.SEARCH_INDEX_VERSION)
    throw new CliError(
      `the search index is format v${doc && doc.v}; this bmweb-cli reads v${R.SEARCH_INDEX_VERSION} (update the package)`
    );
  return doc;
}

/**
 * The index: from the cache when fresh, else fetched and cached.
 *
 * A fetch that fails while a stale copy exists uses the copy and says so,
 * because a search that works offline on yesterday's index beats one that
 * refuses to run.
 * @param opts - see LoadIndexOptions
 * @returns the index
 */
export async function loadIndex(
  opts: LoadIndexOptions = {}
): Promise<SearchIndex> {
  const env = opts.env || process.env;
  const file = indexCachePath(env);
  const warn = opts.warn || ((line: string) => console.error(line));
  const have = existsSync(file);
  const fresh = have && Date.now() - statSync(file).mtimeMs < INDEX_MAX_AGE_MS;
  if (have && fresh && !opts.refresh) return parseIndex(readFileSync(file));
  const doFetch = opts.fetchImpl || fetch;
  let bytes: Uint8Array | null = null;
  let why = '';
  try {
    const r = await doFetch(INDEX_URL);
    if (r.ok) bytes = new Uint8Array(await r.arrayBuffer());
    else why = `HTTP ${r.status}`;
  } catch (e) {
    why = String((e as Error).message || e);
  }
  if (bytes) {
    const index = parseIndex(bytes);
    mkdirSync(cacheDir(env), { recursive: true });
    writeFileSync(file, bytes);
    return index;
  }
  if (have) {
    warn(
      `bmweb: could not refresh the search index (${why}); using the cached copy`
    );
    return parseIndex(readFileSync(file));
  }
  throw new CliError(
    `could not fetch the search index from ${INDEX_URL} (${why})`
  );
}

/** What the search command prints per hit, in JSON form. */
export interface SearchRow {
  chassis: string;
  sgbd: string;
  module: string;
  code: string;
  kind: 'key' | 'screen';
  key: string | null;
  menu: string | null;
  screen: string | null;
  label: string;
  title: string;
  jobs: string[];
  writes: boolean;
  link: string | null;
  score: number;
}

/**
 * The deep link a hit opens on the hosted site, or null when no car
 * carries the module (the route needs a chassis).
 * @param hit - the result row
 * @param chassis - the chassis group it is listed under
 * @returns the URL, or null
 */
export function hitLink(hit: SearchHit, chassis: string): string | null {
  const R = loadRuntime();
  const route = R.searchHitRoute(hit, chassis);
  return route ? `${SITE}#${route}` : null;
}

/**
 * Flatten a result into rows, grouped as the app groups them.
 * @param result - what searchRun returned
 * @returns the rows
 */
export function searchRows(result: SearchResult): SearchRow[] {
  const rows: SearchRow[] = [];
  for (const g of result.groups)
    for (const m of g.modules)
      for (const h of m.hits) {
        const e = h.entry;
        rows.push({
          chassis: g.chassis,
          sgbd: m.module.sgbd,
          module: m.module.label,
          code: m.module.code,
          kind: e.t === 'k' ? 'key' : 'screen',
          key: e.t === 'k' && e.n != null ? keyText(e.n) : null,
          menu: e.t === 'k' ? e.m || null : null,
          screen: e.s || null,
          label: h.label,
          title: h.sub,
          jobs: h.jobs,
          writes: !!e.w,
          link: hitLink(h, g.chassis),
          score: h.score,
        });
      }
  return rows;
}

/**
 * The F-key name for an index entry's key number.
 * @param n - the number, 11..20 for the shifted bank
 * @returns 'F3' or 'Shift+F3'
 */
function keyText(n: number): string {
  return n > 10 ? `Shift+F${n - 10}` : `F${n}`;
}

/**
 * `search`: run the query and print the groups.
 * @param query - the words, all of which must match
 * @param opts - chassis filter, row cap, JSON, and the index to use
 * @returns the lines to print
 */
export function runSearch(
  query: string,
  opts: { chassis?: string; limit?: number; json?: boolean; index: SearchIndex }
): string[] {
  const R = loadRuntime();
  if (!R.searchTerms(query).length)
    throw new CliError('the query needs at least two characters');
  const result = R.searchRun(opts.index, query, {
    chassis: opts.chassis,
    max: opts.limit,
  });
  const rows = searchRows(result);
  if (opts.json)
    return [
      JSON.stringify(
        { query, total: result.total, shown: result.shown, rows },
        null,
        2
      ),
    ];
  if (!rows.length) return [`no results for "${query}"`];
  const out: string[] = [];
  for (const g of result.groups) {
    out.push(
      g.chassis || '(modules no car carries; open them by name in the app)'
    );
    for (const m of g.modules) {
      const head = [
        m.module.sgbd,
        m.module.label,
        m.module.code ? `(${m.module.code})` : '',
      ]
        .filter(Boolean)
        .join('  ');
      out.push(`  ${head}`);
      const table = m.hits.map((h) => {
        const e = h.entry;
        const what = e.t === 'k' && e.n != null ? keyText(e.n) : 'screen';
        const label = h.label + (h.sub ? `  (${h.sub})` : '');
        const jobs = h.jobs.join(', ') + (e.w ? '  [WRITE]' : '');
        const link = hitLink(h, g.chassis) || '(not openable)';
        return [what, label, jobs, link];
      });
      out.push(...formatTable(table, undefined, '    '));
    }
    out.push('');
  }
  out.push(
    result.shown < result.total
      ? `${result.shown} of ${result.total} results shown (raise --limit for more)`
      : `${result.total} result${result.total === 1 ? '' : 's'}`
  );
  return out;
}
