/**
 * @file The `bmweb` binary: command dispatch, help, version, exit codes.
 *
 * Every command prints lines to stdout and throws a CliError for anything
 * the user can fix; main() turns that into one line on stderr and exit
 * code 1. Anything else that throws is a bug and is printed with its
 * stack, so a report of it is useful.
 */
import { CliError, helpLines, parseArgs, type FlagSpecs } from './args.ts';
import { ipoCompile, ipoInfo, ipoKeys } from './ipo.ts';
import { reportDiff, reportShow } from './report.ts';
import { loadIndex, runSearch } from './search.ts';

/** Baked in by scripts/build.mjs from package.json. */
declare const __BMWEB_VERSION__: string;

/** The version string; a source run (tests) has no define and says so. */
export const VERSION: string =
  typeof __BMWEB_VERSION__ === 'string' ? __BMWEB_VERSION__ : '0.0.0-dev';

/** The -I / --include flag, shared by the three ipo commands. */
const INCLUDE: FlagSpecs = {
  include: {
    kind: 'list',
    alias: 'I',
    help: 'a directory holding the INPA headers a source needs (repeatable)',
  },
};

/** The --json flag, shared by everything that prints a table. */
const JSON_FLAG: FlagSpecs = {
  json: {
    kind: 'bool',
    help: 'print machine-readable JSON instead of a table',
  },
};

/** A command: its usage line, flags and body. */
interface Command {
  usage: string;
  summary: string;
  flags: FlagSpecs;
  run(positional: string[], flags: Record<string, unknown>): Promise<string[]>;
}

/** The commands, keyed by their words. */
const COMMANDS: Record<string, Command> = {
  'ipo info': {
    usage: 'bmweb ipo info <file.IPO|file.IPS|file.SRC> [-I dir]... [--json]',
    summary:
      'what a script is: form, includes, entry, procedures, DLL imports, and every menu with its keys and jobs',
    flags: { ...INCLUDE, ...JSON_FLAG },
    async run(pos, flags) {
      const file = pos[0];
      if (!file || pos.length > 1)
        throw new CliError('usage: ' + (COMMANDS['ipo info'] as Command).usage);
      return ipoInfo(file, (flags.include as string[]) || [], !!flags.json);
    },
  },
  'ipo keys': {
    usage:
      'bmweb ipo keys <file.IPO|file.IPS|file.SRC> [--menu m_x] [-I dir]... [--json]',
    summary:
      'the F-keys of every menu (or one): the screen each opens, the jobs it sends, and which of them write',
    flags: {
      ...INCLUDE,
      menu: { kind: 'string', alias: 'm', help: 'only this menu procedure' },
      ...JSON_FLAG,
    },
    async run(pos, flags) {
      const file = pos[0];
      if (!file || pos.length > 1)
        throw new CliError('usage: ' + (COMMANDS['ipo keys'] as Command).usage);
      return ipoKeys(
        file,
        (flags.include as string[]) || [],
        flags.menu as string | undefined,
        !!flags.json
      );
    },
  },
  'ipo compile': {
    usage:
      'bmweb ipo compile <file.IPS|file.SRC> [-I dir]... [-o out.ipoexec.json]',
    summary:
      "compile an INPA source into the app's exec form (JSON); missing includes are named",
    flags: {
      ...INCLUDE,
      out: {
        kind: 'string',
        alias: 'o',
        help: 'where to write (default: <stem>.ipoexec.json beside the source)',
      },
    },
    async run(pos, flags) {
      const file = pos[0];
      if (!file || pos.length > 1)
        throw new CliError(
          'usage: ' + (COMMANDS['ipo compile'] as Command).usage
        );
      return ipoCompile(
        file,
        (flags.include as string[]) || [],
        flags.out as string | undefined
      );
    },
  },
  search: {
    usage:
      'bmweb search <query...> [--chassis E46] [--limit N] [--refresh] [--json]',
    summary:
      'find the INPA key or screen that does a thing, across every module the site ships, with a deep link per hit',
    flags: {
      chassis: {
        kind: 'string',
        alias: 'c',
        help: 'only modules this chassis carries',
      },
      limit: { kind: 'number', alias: 'n', help: 'rows to show (default 50)' },
      refresh: {
        kind: 'bool',
        help: 'fetch the index again even when the cached copy is fresh',
      },
      ...JSON_FLAG,
    },
    async run(pos, flags) {
      const query = pos.join(' ').trim();
      if (!query)
        throw new CliError('usage: ' + (COMMANDS.search as Command).usage);
      const index = await loadIndex({ refresh: !!flags.refresh });
      return runSearch(query, {
        chassis: flags.chassis as string | undefined,
        limit: (flags.limit as number | undefined) || 50,
        json: !!flags.json,
        index,
      });
    },
  },
  'report show': {
    usage: 'bmweb report show <link-or-payload> [--json]',
    summary:
      'decode a shared Garage report link: module, code, text, count per fault, plus the silent addresses',
    flags: { ...JSON_FLAG },
    async run(pos, flags) {
      const arg = pos[0];
      if (!arg || pos.length > 1)
        throw new CliError(
          'usage: ' + (COMMANDS['report show'] as Command).usage
        );
      return reportShow(arg, !!flags.json);
    },
  },
  'report diff': {
    usage: 'bmweb report diff <link-a> <link-b> [--json]',
    summary:
      'what changed between two shared reports: new, cleared and still-present faults per module',
    flags: { ...JSON_FLAG },
    async run(pos, flags) {
      const [a, b] = pos;
      if (!a || !b || pos.length > 2)
        throw new CliError(
          'usage: ' + (COMMANDS['report diff'] as Command).usage
        );
      return reportDiff(a, b, !!flags.json);
    },
  },
};

/**
 * The top-level help text.
 * @returns the lines
 */
export function helpText(): string[] {
  const out = [
    `bmweb ${VERSION}: BMWeb's tools as a command line (https://bmweb.danner.ink/)`,
    '',
    'usage: bmweb <command> [options]',
    '',
    'commands:',
  ];
  const names = Object.keys(COMMANDS);
  const w = Math.max(...names.map((n) => n.length));
  for (const n of names)
    out.push(`  ${n.padEnd(w)}  ${(COMMANDS[n] as Command).summary}`);
  out.push(
    '',
    '  bmweb <command> --help    options of one command',
    '  bmweb --version',
    '',
    'v0.1 has no live-car access: the app talks to the car through Web Serial',
    'in the browser. The search index is fetched from the site and cached under',
    '$XDG_CACHE_HOME/bmweb-cli (default ~/.cache/bmweb-cli) for a day.'
  );
  return out;
}

/**
 * One command's help text.
 * @param name - the command words
 * @returns the lines
 */
export function commandHelp(name: string): string[] {
  const c = COMMANDS[name] as Command;
  return [
    `usage: ${c.usage}`,
    '',
    c.summary,
    '',
    'options:',
    ...helpLines(c.flags),
  ];
}

/**
 * Pick the command argv names: the longest leading word sequence that is
 * one, so `ipo info` and `search` both resolve.
 * @param argv - the arguments
 * @returns the command name and the rest, or null
 */
export function resolveCommand(
  argv: string[]
): { name: string; rest: string[] } | null {
  for (const n of [2, 1]) {
    const name = argv.slice(0, n).join(' ');
    if (COMMANDS[name]) return { name, rest: argv.slice(n) };
  }
  return null;
}

/**
 * Run the CLI over argv and return the exit code; output goes to the
 * given writers so a test can capture it.
 * @param argv - the arguments after the binary name
 * @param out - stdout lines
 * @param err - stderr lines
 * @returns the exit code
 */
export async function main(
  argv: string[],
  out: (line: string) => void = (l) => process.stdout.write(l + '\n'),
  err: (line: string) => void = (l) => process.stderr.write(l + '\n')
): Promise<number> {
  try {
    if (
      !argv.length ||
      argv[0] === '--help' ||
      argv[0] === '-h' ||
      argv[0] === 'help'
    ) {
      helpText().forEach(out);
      return 0;
    }
    if (argv[0] === '--version' || argv[0] === '-v') {
      out(VERSION);
      return 0;
    }
    const picked = resolveCommand(argv);
    if (!picked) {
      // `bmweb ipo` alone: list that group's commands rather than fail cold
      const group = argv[0] as string;
      const members = Object.keys(COMMANDS).filter((n) =>
        n.startsWith(group + ' ')
      );
      if (members.length) {
        members.forEach((n) => out(`usage: ${(COMMANDS[n] as Command).usage}`));
        return 1;
      }
      throw new CliError(
        `unknown command "${argv.join(' ')}" (try bmweb --help)`
      );
    }
    if (picked.rest.includes('--help') || picked.rest.includes('-h')) {
      commandHelp(picked.name).forEach(out);
      return 0;
    }
    const c = COMMANDS[picked.name] as Command;
    const parsed = parseArgs(picked.rest, c.flags);
    const lines = await c.run(parsed.positional, parsed.flags);
    lines.forEach(out);
    return 0;
  } catch (e) {
    if (e instanceof CliError) {
      err(`bmweb: ${e.message}`);
      return 1;
    }
    err(`bmweb: unexpected error: ${(e as Error).stack || e}`);
    return 1;
  }
}

// the binary: not when bundled into a test, which imports main() instead
if (
  typeof process !== 'undefined' &&
  process.argv[1] &&
  /bmweb(\.js)?$/.test(process.argv[1])
) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
