/**
 * @file The site as the app's data source: what `window.fetch` is inside
 * the runtime.
 *
 * The app's shim (core/webshim/api-router.js) answers /api/* from chassis
 * archives it fetches with the browser's own fetch, and the job runner and
 * the group resolver fetch data/groups/* the same way. The data behind
 * those paths is BMW-derived and does not ship in this package, so the
 * fetch handed to the runtime maps every site-relative path onto the hosted
 * site (or --api) and keeps what it got on disk, under the CLI's cache
 * directory, for a day. Absolute URLs pass straight through.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { CACHE_MAX_AGE_MS, cacheDir } from './cache.ts';

/** The hosted app; the default data source. */
export const DEFAULT_API = 'https://bmweb.danner.ink/';

/** How the site fetch is configured; set from flags before the runtime loads. */
export interface SiteConfig {
  /** the site's base URL, with a trailing slash */
  base: string;
  /** ignore the cache's age */
  refresh: boolean;
  /** the environment, for the cache location */
  env: NodeJS.ProcessEnv;
  /** the fetch to reach the network with (tests inject one) */
  fetchImpl: typeof fetch;
}

/** The live configuration; a mutable singleton the runtime's fetch reads. */
const config: SiteConfig = {
  base: DEFAULT_API,
  refresh: false,
  env: process.env,
  fetchImpl: (...a) => fetch(...a),
};

/**
 * Point the site fetch somewhere: the base URL and whether to refresh.
 * @param opts - what to change
 */
export function configureSite(opts: Partial<SiteConfig>): void {
  if (opts.base !== undefined) config.base = normalizeBase(opts.base);
  if (opts.refresh !== undefined) config.refresh = opts.refresh;
  if (opts.env !== undefined) config.env = opts.env;
  if (opts.fetchImpl !== undefined) config.fetchImpl = opts.fetchImpl;
}

/**
 * The current site configuration (read-only view).
 * @returns the configuration
 */
export function siteConfig(): Readonly<SiteConfig> {
  return config;
}

/**
 * A base URL with exactly one trailing slash.
 * @param base - as given
 * @returns normalised
 */
export function normalizeBase(base: string): string {
  const s = String(base || '').trim();
  return s.endsWith('/') ? s : `${s}/`;
}

/**
 * The site-relative path of what the runtime asked for: the shim asks for
 * "/api/chassis/E46.chassis", open.js for "api/ecu-index.json", the group
 * resolver for "data/groups/d_motor.json.gz". All become one form.
 * @param input - what fetch was given
 * @returns the path without a leading slash, or null for an absolute URL
 */
export function sitePath(input: string | URL | Request): string | null {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return null;
  return url.replace(/^\/+/, '');
}

/**
 * Where a site path is cached.
 * @param rel - the site-relative path
 * @param env - the environment
 * @returns the file path
 */
export function siteCachePath(rel: string, env = config.env): string {
  // the query is not part of the file; the site serves no query-dependent data
  const clean = rel.split('?')[0] as string;
  return join(cacheDir(env), 'site', ...clean.split('/'));
}

/**
 * Fetch a site path through the cache: a fresh copy is served from disk, a
 * stale or missing one fetched and stored. A failed fetch with a stale copy
 * on disk serves the copy, so a car can be read on yesterday's data when
 * the site is out of reach.
 * @param rel - the site-relative path
 * @returns the bytes and status
 */
export async function siteGet(
  rel: string
): Promise<{ status: number; bytes: Uint8Array | null; fromCache: boolean }> {
  const file = siteCachePath(rel);
  const have = existsSync(file);
  const fresh = have && Date.now() - statSync(file).mtimeMs < CACHE_MAX_AGE_MS;
  if (have && fresh && !config.refresh)
    return { status: 200, bytes: readFileSync(file), fromCache: true };
  let status = 0;
  let bytes: Uint8Array | null = null;
  try {
    const r = await config.fetchImpl(`${config.base}${rel}`);
    status = r.status;
    if (r.ok) bytes = new Uint8Array(await r.arrayBuffer());
  } catch {
    status = 0;
  }
  if (bytes) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    return { status: 200, bytes, fromCache: false };
  }
  if (have && status !== 404)
    return { status: 200, bytes: readFileSync(file), fromCache: true };
  return { status: status || 503, bytes: null, fromCache: false };
}

/**
 * The fetch the runtime is given as `window.fetch` (before the shim wraps
 * it): site paths through the cache, absolute URLs to the network.
 * @param input - what fetch was given
 * @param init - fetch options (passed through for absolute URLs only)
 * @returns a Response
 */
export async function siteFetch(
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  const rel = sitePath(input);
  if (rel === null) return config.fetchImpl(input as string, init);
  const r = await siteGet(rel);
  if (!r.bytes)
    return new Response(JSON.stringify({ error: `${rel}: HTTP ${r.status}` }), {
      status: r.status,
      statusText: r.status === 404 ? 'Not Found' : 'Unavailable',
    });
  return new Response(r.bytes, { status: 200 });
}
