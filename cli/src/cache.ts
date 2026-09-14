/**
 * @file Where the CLI keeps what it fetched: $XDG_CACHE_HOME/bmweb-cli,
 * else ~/.cache/bmweb-cli. Shared by the search index and the site fetch
 * (the chassis archives, group bytecode, tables) so one directory holds
 * everything and one flag refreshes it.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A cached file older than this is refreshed. */
export const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The cache directory.
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
 * The cached search index file.
 * @param env - the environment
 * @returns the file path
 */
export function indexCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(cacheDir(env), 'search-index.json.gz');
}
