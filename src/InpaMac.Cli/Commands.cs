using System;
using System.Collections.Generic;
using System.Linq;
using EdiabasMac;

namespace InpaMac.Cli;

// dispatcher for the extended subcommands. Program.Main calls TryDispatch FIRST;
// if it returns a non-null exit code the command was one of ours and we're done,
// otherwise Program falls through to its original flat-argv commands (jobs,
// results, run, read, clear, simrun, dumptable, ...) unchanged. New commands own
// their own Diag/InpaConfig so they can pick offline vs live per operation.
internal static class Commands
{
    // the names TryDispatch handles. Kept explicit so a typo like `jbos` still
    // reaches Program's own handling/help rather than being silently eaten.
    private static readonly HashSet<string> Owned = new(StringComparer.OrdinalIgnoreCase)
    {
        "ecus", "ecu", "sgbd",
        "jobs", "results", "run",
        "tables", "arguments", "args",
        "ident", "info", "serial",
        "status", "battery",
        "coding",
        "resolve",
        "ports", "adapter",
        "read", "clear", "report",
        "tools",
        "help", "--help", "-h",
    };

    public static int? TryDispatch(string[] argv, string ecuPath, string inpaRoot)
    {
        string cmd = argv.Length > 0 ? argv[0].ToLowerInvariant() : "help";
        if (!Owned.Contains(cmd)) return null;

        if (cmd is "help" or "--help" or "-h") { PrintHelp(); return 0; }

        var cli = new Cli(argv.Skip(1));
        var cfg = new InpaConfig(inpaRoot, ecuPath);

        try
        {
            switch (cmd)
            {
                // vehicle (offline)
                case "ecus": return VehicleCommands.Ecus(cli, cfg);
                case "ecu": return VehicleCommands.Ecu(cli, cfg);
                case "sgbd": return VehicleCommands.ResolveSgbd(cli, cfg);

                // job metadata (offline) + live run — richer, --json forms that
                // supersede Program's originals (same behavior + JSON + --filter).
                case "jobs": using (var d = new Diag(ecuPath)) return JobCommands.Jobs(cli, d);
                case "results": using (var d = new Diag(ecuPath)) return JobCommands.Results(cli, d);
                case "run": using (var d = new Diag(ecuPath)) return JobCommands.Run(cli, d);
                case "tables": using (var d = new Diag(ecuPath)) return JobCommands.Tables(cli, d);
                case "arguments":
                case "args": using (var d = new Diag(ecuPath)) return JobCommands.Arguments(cli, d);

                // identification (live; info runs offline)
                case "ident": using (var d = new Diag(ecuPath)) return IdentCommands.Ident(cli, d, cfg);
                case "info": using (var d = new Diag(ecuPath)) return IdentCommands.Info(cli, d);
                case "serial": using (var d = new Diag(ecuPath)) return IdentCommands.Serial(cli, d);

                // live status / readout
                case "status": using (var d = new Diag(ecuPath)) return StatusCommands.Status(cli, d);
                case "battery": using (var d = new Diag(ecuPath)) return StatusCommands.Battery(cli, d);

                // coding: `coding [read|write] ...` (read is the default)
                case "coding":
                    using (var d = new Diag(ecuPath))
                    {
                        string sub = cli.Args.Count > 0 ? cli.Args[0].ToLowerInvariant() : "read";
                        return sub switch
                        {
                            "write" => CodingCommands.Write(cli, d),
                            "read" => CodingCommands.Read(cli, d),
                            _ => CodingCommands.Read(cli, d), // `coding <SGBD>` == read
                        };
                    }

                // variant / group probe (live)
                case "resolve": using (var d = new Diag(ecuPath)) return VariantCommands.Resolve(cli, d, cfg);

                // faults: these supersede Program's original read/clear with the
                // same behavior plus confirm-first ordering, group auto-identify,
                // prove-by-re-read, and --json.
                case "read": using (var d = new Diag(ecuPath)) return FaultCommands.Read(cli, d, cfg);
                case "clear": using (var d = new Diag(ecuPath)) return FaultCommands.Clear(cli, d, cfg);
                case "report": using (var d = new Diag(ecuPath)) return FaultCommands.Report(cli, d, cfg);

                // adapter
                case "ports": return AdapterCommands.Ports(cli);
                case "adapter": return AdapterCommands.Adapter(cli);

                // python tooling
                case "tools": return ToolCommands.Run(cli);
            }
        }
        catch (SgbdLoadException ex) { Cli.Err($"Error: {ex.Message}"); return 4; }
        catch (Exception ex) { Cli.Err($"Error: {ex.Message}"); return 3; }

        return null;
    }

    private static void PrintHelp()
    {
        Console.WriteLine(HelpText);
    }

    // one screen documenting every command, old and new. Program.cs's default
    // case prints a one-liner; this is the full reference (also in README.md).
    public const string HelpText = """
InpaMac CLI — native macOS EDIABAS driver for BMW (E46 default).

USAGE
  inpamac <command> [args] [--port DEV] [--json] [--quiet] [--verbose]

GLOBAL OPTIONS
  --port DEV     K+DCAN serial device (default: auto-detect /dev/tty.usbserial*)
  --sgbd NAME    SGBD to load (default: ms450ds0, the E46 MS45.1 DME)
  --json         machine-readable JSON on stdout
  --quiet, -q    suppress prose; --verbose, -v  keep _TEL_* telegram echoes
  --confirm,-y   required for every destructive/write operation

VEHICLE / CHASSIS (offline)
  chassis [ID]              INPA nav tree: list chassis, or one chassis' ECUs
  ecus [ID]                 ECUs of a chassis (default E46), by section
  ecu <CODE|SGBD> [--chassis E46]   full metadata for one ECU + its variants
  sgbd <CODE> [--chassis]   resolve an ECU code to its concrete SGBD + group
  allsgbds                  every SGBD across every chassis

JOBS (offline metadata; run is live)
  jobs [SGBD] [--filter S]  list jobs
  results <JOB> [SGBD]      a job's result schema
  arguments <JOB> [SGBD]    a job's argument schema
  tables [SGBD]             list lookup tables;  tables <TABLE> [SGBD] dumps one
  run <JOB> [ARG] [SGBD]    run any job live (writes/actuators need --confirm)

IDENTIFICATION
  ident [SGBD] [--group D_00xx]   run IDENT: part no, HW/SW, coding+variant index
  info [SGBD]               SGBD info card (offline)
  serial [SGBD]             read the module serial number (live)

FAULTS
  read [SGBD] [--group]     read fault memory (live, sibling-variant merge)
  clear [SGBD] --confirm    ERASE fault memory (live, destructive), then verify
  report [SGBD] [--out F] [--format json|text]   export a fault report

STATUS / LIVE DATA (live)
  status [JOB] [SGBD] [--poll] [--interval MS] [--count N]   run a readout job
  battery [SGBD]            the DME's reported battery voltage (STATUS_UBATT)

CODING
  coding read [SGBD]        read coding bytes + coding index (safe)
  coding write <SGBD> --data <HEX> --confirm
                            GATED write; also needs BMACW_ALLOW_CODING_WRITE=1;
                            prints the plan, backs up, writes, proves by re-read.
                            cfg-chunked (C_S_AUFTRAG) & file-based paths refused.

VARIANT / GROUP PROBE (live)
  resolve <D_00xx|CODE> [--chassis E46]
                            load the address group, run IDENTIFIKATION, report
                            which concrete SGBD is installed

ADAPTER
  ports                     list serial devices, mark the auto-detected one
  adapter [--port DEV]      show the selected transport

DECODE TOOLING (wraps python; needs the dev repo)
  tools                     list subcommands
  tools disasm <ECU> [PROC] | ir <ECU> | screens <ECU> | vm <ECU> [PROC]
  tools status|memory|coding <ECU> | spec <sgbd> <JOB>

SAFETY
  Reads run freely. Every write (clear, coding write, actuator/write jobs via
  run, flashing) requires --confirm and prints exactly what it will do first.
  Coding write additionally requires BMACW_ALLOW_CODING_WRITE=1; flashing
  requires BMACW_ALLOW_FLASH_WRITE=1 (see FlashService).

EXIT CODES
  0 ok  2 usage  3 error  4 no device/not found  5 needs --confirm
  6 write done but verify failed  7 unsupported write path
""";
}
