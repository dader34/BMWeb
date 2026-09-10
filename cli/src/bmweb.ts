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
import {
  connectBus,
  disconnectBus,
  jobCommand,
  portsCommand,
  SCAN_CHASSIS,
} from './live.ts';
import { reportDiff, reportShow } from './report.ts';
import { scanCommand } from './scan.ts';
import { loadIndex, runSearch } from './search.ts';
import {
  jobInfoCommand,
  sgbdJobsCommand,
  sgbdTableCommand,
  sgbdTablesCommand,
} from './sgbd.ts';
import { configureSite } from './site.ts';
import { tuiCommand } from './tui.ts';

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

/**
 * The flags of a command that reads the site's module data: the commands
 * on the cable need these too, and the offline `sgbd` ones need only these.
 */
const SITE: FlagSpecs = {
  api: {
    kind: 'string',
    help: 'the site the module data comes from (default https://bmweb.danner.ink/)',
  },
  refresh: {
    kind: 'bool',
    help: 'fetch the module data again even when the cached copy is fresh',
  },
};

/** The flags every command on the cable takes. */
const LIVE: FlagSpecs = {
  port: {
    kind: 'string',
    alias: 'p',
    help: 'the serial device (the single candidate when there is one)',
  },
  ...SITE,
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
  ports: {
    usage: 'bmweb ports [--json]',
    summary:
      'the serial ports a K+DCAN cable shows up as (cu.usbserial*, cu.SLAB*, cu.wchusbserial*, ttyUSB*, ttyACM*)',
    flags: { ...JSON_FLAG },
    async run(pos, flags) {
      if (pos.length)
        throw new CliError('usage: ' + (COMMANDS.ports as Command).usage);
      return portsCommand(!!flags.json);
    },
  },
  job: {
    usage:
      'bmweb job <sgbd> <JOB> [arg] [--results a,b] [--info] [--port p] [--api url] [--yes] [--json]',
    summary:
      "one raw job on one module over the cable, like the app's Tool32; a write needs --yes or a y answer, and --info reads the declaration instead of running it",
    flags: {
      ...LIVE,
      yes: {
        kind: 'bool',
        alias: 'y',
        help: 'consent to a write job on the command line',
      },
      results: {
        kind: 'string',
        alias: 'r',
        help: 'comma-separated result names; only these print (case-insensitive)',
      },
      info: {
        kind: 'bool',
        help: 'what the SGBD declares about the job (arguments, results, comment); opens no port',
      },
      ...JSON_FLAG,
    },
    async run(pos, flags) {
      const [sgbd, job, arg] = pos;
      if (!sgbd || !job || pos.length > 3)
        throw new CliError('usage: ' + (COMMANDS.job as Command).usage);
      // --info is a reading of the shipped declaration, so it must not
      // touch the cable at all: no port is chosen and no bus is connected,
      // only the site (and its cache) is pointed at
      if (flags.info) {
        if (arg !== undefined)
          throw new CliError('--info takes no job argument (nothing is sent)');
        useSite(flags);
        return jobInfoCommand(sgbd, job, { json: !!flags.json });
      }
      const { R } = await connectBus(liveOptions(flags));
      try {
        return await jobCommand(sgbd, job, {
          arg,
          yes: !!flags.yes,
          json: !!flags.json,
          results: splitList(flags.results as string | undefined),
        });
      } finally {
        await disconnectBus(R);
      }
    },
  },
  'sgbd jobs': {
    usage: 'bmweb sgbd jobs <sgbd> [--api url] [--refresh] [--json]',
    summary:
      "every job an SGBD declares, with its arguments, results and comment, and which of them the app's write gate would ask about; no cable",
    flags: { ...SITE, ...JSON_FLAG },
    async run(pos, flags) {
      const sgbd = pos[0];
      if (!sgbd || pos.length > 1)
        throw new CliError(
          'usage: ' + (COMMANDS['sgbd jobs'] as Command).usage
        );
      useSite(flags);
      return sgbdJobsCommand(sgbd, { json: !!flags.json });
    },
  },
  'sgbd tables': {
    usage: 'bmweb sgbd tables <sgbd> [--api url] [--refresh] [--json]',
    summary:
      'every lookup table an SGBD carries for its bytecode, with row and column counts; no cable',
    flags: { ...SITE, ...JSON_FLAG },
    async run(pos, flags) {
      const sgbd = pos[0];
      if (!sgbd || pos.length > 1)
        throw new CliError(
          'usage: ' + (COMMANDS['sgbd tables'] as Command).usage
        );
      useSite(flags);
      return sgbdTablesCommand(sgbd, { json: !!flags.json });
    },
  },
  'sgbd table': {
    usage: 'bmweb sgbd table <sgbd> <NAME> [--api url] [--refresh] [--json]',
    summary: 'one lookup table of an SGBD, its rows as a table; no cable',
    flags: { ...SITE, ...JSON_FLAG },
    async run(pos, flags) {
      const [sgbd, name] = pos;
      if (!sgbd || !name || pos.length > 2)
        throw new CliError(
          'usage: ' + (COMMANDS['sgbd table'] as Command).usage
        );
      useSite(flags);
      return sgbdTableCommand(sgbd, name, { json: !!flags.json });
    },
  },
  scan: {
    usage: 'bmweb scan <chassis> [--port p] [--api url] [--share] [--json]',
    summary: `INPA's whole-vehicle script over the cable (${SCAN_CHASSIS.join(' ')}): every fault memory as a report, --share adds a Garage link`,
    flags: {
      ...LIVE,
      share: {
        kind: 'bool',
        help: 'print a Garage share link carrying the report',
      },
      label: {
        kind: 'string',
        help: 'the car name on the share link',
      },
      ...JSON_FLAG,
    },
    async run(pos, flags) {
      const chassis = pos[0];
      if (!chassis || pos.length > 1)
        throw new CliError('usage: ' + (COMMANDS.scan as Command).usage);
      const { R } = await connectBus(liveOptions(flags));
      try {
        const r = await scanCommand(chassis, {
          share: !!flags.share,
          json: !!flags.json,
          label: flags.label as string | undefined,
        });
        return r.lines;
      } finally {
        await disconnectBus(R);
      }
    },
  },
  tui: {
    usage: 'bmweb tui [<chassis> <sgbd>] [--port p] [--api url] [--menu m_x]',
    summary:
      "INPA screens in the terminal: the app's home (pick a chassis and a module) with no arguments, else that module; F-keys on the number row, every write asked first, released on quit",
    flags: {
      ...LIVE,
      menu: {
        kind: 'string',
        alias: 'm',
        help: 'the menu procedure to open once the script is up',
      },
    },
    async run(pos, flags) {
      const [chassis, sgbd] = pos;
      if (pos.length === 1 || pos.length > 2)
        throw new CliError('usage: ' + (COMMANDS.tui as Command).usage);
      const r = await tuiCommand(chassis, sgbd, {
        ...liveOptions(flags),
        menu: flags.menu as string | undefined,
        version: VERSION,
      });
      return [
        `${r.log.length} job${r.log.length === 1 ? '' : 's'} sent:`,
        ...r.log.map(
          (l) =>
            `  ${l.target} ${l.job}${l.arg ? ` ${l.arg}` : ''}  ${l.status}`
        ),
      ];
    },
  },
};

/**
 * The cable and site options out of a command's flags.
 * @param flags - the parsed flags
 * @returns what connectBus takes
 */
function liveOptions(flags: Record<string, unknown>): {
  port?: string;
  api?: string;
  refresh?: boolean;
} {
  return {
    port: flags.port as string | undefined,
    api: flags.api as string | undefined,
    refresh: !!flags.refresh,
  };
}

/**
 * Point the site fetch at what the flags say, for a command that reads the
 * site's data without a cable. connectBus does this for the live commands;
 * the offline ones have to do it themselves before the runtime fetches.
 * @param flags - the parsed flags
 */
function useSite(flags: Record<string, unknown>): void {
  configureSite({
    ...(flags.api ? { base: flags.api as string } : {}),
    refresh: !!flags.refresh,
  });
}

/**
 * A comma-separated flag value as a list, blanks and stray spaces dropped
 * so `--results A, B,` is the same as `--results A,B`.
 * @param v - the flag value
 * @returns the items
 */
function splitList(v: string | undefined): string[] {
  return String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s);
}

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
    'ports, job, scan and tui talk to the car over a K+DCAN cable (the serialport',
    'package, an optional dependency). Module data and the search index are',
    'fetched from the site and cached under $XDG_CACHE_HOME/bmweb-cli',
    '(default ~/.cache/bmweb-cli) for a day; nothing BMW-derived ships here.'
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
    // leave once stdout has drained: a keep-alive socket from the site
    // fetches (or a paused stdin after the TUI) would otherwise hold the
    // process open for seconds after the command is done
    process.exitCode = code;
    process.stdout.write('', () => process.exit(code));
  });
}
