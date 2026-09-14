/**
 * @file A small argument parser: long flags, short aliases, repeatable
 * flags, `--` to end options. Written here rather than pulled in because
 * the package promises zero runtime dependencies and six commands need
 * nothing more than this.
 */

/** What a flag accepts. `list` may repeat (`-I a -I b`). */
export type FlagKind = 'bool' | 'string' | 'number' | 'list';

/** One flag the command understands. */
export interface FlagSpec {
  kind: FlagKind;
  /** a one-letter alias, used as `-x value` */
  alias?: string;
  /** what --help prints beside it */
  help?: string;
}

/** The flags a command accepts, by their long name. */
export type FlagSpecs = Record<string, FlagSpec>;

/** Parsed values by long name; lists come back as arrays. */
export type FlagValues = Record<
  string,
  string | number | boolean | string[] | undefined
>;

/** The result: everything that was not a flag, and the flags. */
export interface ParsedArgs {
  positional: string[];
  flags: FlagValues;
}

/** An error the user can act on: printed as one line, exit code 1. */
export class CliError extends Error {}

/**
 * Parse argv against a spec.
 *
 * `--flag value`, `--flag=value` and `-x value` are accepted; a bool flag
 * takes no value (`--json`). An unknown flag is an error rather than a
 * silent positional, because a typo like `--chasis` would otherwise become
 * a search term.
 * @param argv - the arguments after the command name
 * @param spec - the flags this command accepts
 * @returns the positionals and the flag values
 */
export function parseArgs(argv: string[], spec: FlagSpecs): ParsedArgs {
  const positional: string[] = [];
  const flags: FlagValues = {};
  const byAlias = new Map<string, string>();
  for (const [name, s] of Object.entries(spec))
    if (s.alias) byAlias.set(s.alias, name);

  /**
   * Store one value under a flag, converting to the declared kind.
   * @param name - the long name
   * @param raw - the value as typed, or null for a bare bool
   */
  const set = (name: string, raw: string | null): void => {
    const s = spec[name];
    if (!s) throw new CliError(`unknown option --${name}`);
    if (s.kind === 'bool') {
      if (raw !== null) throw new CliError(`--${name} takes no value`);
      flags[name] = true;
      return;
    }
    if (raw === null) throw new CliError(`--${name} needs a value`);
    if (s.kind === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new CliError(`--${name} needs a number`);
      flags[name] = n;
      return;
    }
    if (s.kind === 'list') {
      const list = (flags[name] as string[] | undefined) || [];
      list.push(raw);
      flags[name] = list;
      return;
    }
    flags[name] = raw;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      const s = spec[name];
      if (!s) throw new CliError(`unknown option --${name}`);
      if (eq >= 0) set(name, a.slice(eq + 1));
      else if (s.kind === 'bool') set(name, null);
      else {
        const v = argv[i + 1];
        if (v === undefined) throw new CliError(`--${name} needs a value`);
        set(name, v);
        i++;
      }
      continue;
    }
    if (a.length >= 2 && a[0] === '-' && a !== '-') {
      const name = byAlias.get(a[1] as string);
      if (!name) throw new CliError(`unknown option ${a.slice(0, 2)}`);
      const s = spec[name] as FlagSpec;
      // `-Idir` and `-I dir` both mean the same thing
      if (a.length > 2) set(name, a.slice(2));
      else if (s.kind === 'bool') set(name, null);
      else {
        const v = argv[i + 1];
        if (v === undefined) throw new CliError(`${a} needs a value`);
        set(name, v);
        i++;
      }
      continue;
    }
    positional.push(a);
  }
  return { positional, flags };
}

/**
 * The option lines of a command's help, aligned.
 * @param spec - the flags
 * @returns lines, without a trailing newline
 */
export function helpLines(spec: FlagSpecs): string[] {
  const rows = Object.entries(spec).map(([name, s]) => {
    const value =
      s.kind === 'bool' ? '' : s.kind === 'number' ? ' N' : ' <value>';
    const left = `${s.alias ? `-${s.alias}, ` : '    '}--${name}${value}`;
    return [left, s.help || ''] as const;
  });
  const w = Math.max(0, ...rows.map((r) => r[0].length));
  return rows.map(([l, h]) => `  ${l.padEnd(w)}  ${h}`.trimEnd());
}
