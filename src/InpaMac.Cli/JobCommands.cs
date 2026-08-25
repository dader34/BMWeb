using System;
using System.Collections.Generic;
using System.Linq;
using EdiabasMac;

namespace InpaMac.Cli;

// job metadata (offline) and live job execution. The old Program.cs kept
// jobs/results/arguments/run; these are the --json-aware, help-carrying forms.
// The engine is the same one the GUI and the differential harness use.
internal static class JobCommands
{
    // per-set engine metadata the SGBD attaches to every result set; not data.
    // Same list the renderer's vmbridge filters out of "data" sets.
    private static readonly HashSet<string> SystemKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        "OBJECT", "JOBNAME", "VARIANTE", "GRUPPE", "FAMILIE", "SAETZE", "JOBSTATUS",
        "UBATTCURRENT", "UBATTHISTORY", "IGNITIONCURRENT", "IGNITIONHISTORY", "SPRACHE",
    };

    // list every job in an SGBD (offline). --filter substring narrows it.
    //   jobs [SGBD] [--filter STATUS]
    public static int Jobs(Cli cli, Diag diag)
    {
        string sgbd = cli.Sgbd();
        diag.Load(sgbd);
        var jobs = diag.Jobs();
        string? f = cli.Opt("--filter");
        if (f != null) jobs = jobs.Where(j => j.Contains(f, StringComparison.OrdinalIgnoreCase)).ToList();
        cli.Line($"Jobs in {diag.LoadedSgbd} ({jobs.Count}):");
        foreach (var j in jobs) cli.Line($"  {j}");
        cli.Emit(new { sgbd = diag.LoadedSgbd, jobs });
        return 0;
    }

    // a job's result schema (offline): NAME : comment lines.
    //   results <JOB> [SGBD]
    public static int Results(Cli cli, Diag diag)
    {
        if (cli.Args.Count == 0) { Cli.Err("usage: results <JOB> [SGBD]"); return 2; }
        string job = cli.Args[0];
        string sgbd = cli.Args.Count > 1 ? cli.Args[1] : cli.Sgbd(1);
        diag.Load(sgbd);
        var lines = diag.ResultsOf(job);
        cli.Line($"Results of {job} in {diag.LoadedSgbd}:");
        foreach (var l in lines) cli.Line($"  {l}");
        cli.Emit(new { sgbd = diag.LoadedSgbd, job, results = lines });
        return 0;
    }

    // a job's argument schema (offline): the ARG rows the SGBD declares.
    //   arguments <JOB> [SGBD]
    public static int Arguments(Cli cli, Diag diag)
    {
        if (cli.Args.Count == 0) { Cli.Err("usage: arguments <JOB> [SGBD]"); return 2; }
        string job = cli.Args[0];
        string sgbd = cli.Args.Count > 1 ? cli.Args[1] : cli.Sgbd(1);
        diag.Load(sgbd);
        var rows = new List<Dictionary<string, string>>();
        foreach (var set in diag.Run("_ARGUMENTS", job))
        {
            // keep only the ARG* fields; the engine also emits per-set metadata
            // (VARIANTE/OBJECT/JOBNAME/UBATT*/...) the vmbridge filters out.
            var row = set.Where(kv => !kv.Key.StartsWith("_") && !SystemKeys.Contains(kv.Key))
                         .ToDictionary(kv => kv.Key, kv => Cli.Fmt(kv.Value));
            if (row.Count > 0) rows.Add(row);
        }
        cli.Line($"Arguments of {job} in {diag.LoadedSgbd}:");
        foreach (var r in rows)
            cli.Line("  " + string.Join("  ", r.Select(kv => $"{kv.Key}={kv.Value}")));
        cli.Emit(new { sgbd = diag.LoadedSgbd, job, arguments = rows });
        return 0;
    }

    // list an SGBD's lookup tables, or dump one table's rows (offline).
    //   tables [SGBD]                 list table names
    //   tables <TABLE> [SGBD]         dump rows of one table
    public static int Tables(Cli cli, Diag diag)
    {
        // a positional that is all-caps/underscore is a table name; otherwise the
        // only positional is the SGBD.
        string? table = null; string sgbd;
        if (cli.Args.Count >= 1 &&
            cli.Args[0].All(c => char.IsUpper(c) || char.IsDigit(c) || c == '_'))
        {
            table = cli.Args[0];
            sgbd = cli.Args.Count > 1 ? cli.Args[1] : cli.Sgbd(1);
        }
        else sgbd = cli.Sgbd();

        diag.Load(sgbd);
        if (table == null)
        {
            var names = diag.Tables();
            cli.Line($"Tables in {diag.LoadedSgbd} ({names.Count}):");
            foreach (var n in names) cli.Line($"  {n}");
            cli.Emit(new { sgbd = diag.LoadedSgbd, tables = names });
            return 0;
        }
        var rows = diag.TableRows(table);
        cli.Line($"Table {table} in {diag.LoadedSgbd} ({rows.Count} rows):");
        foreach (var r in rows)
            cli.Line("  " + string.Join("  ", r.Select(kv => $"{kv.Key}={kv.Value}")));
        cli.Emit(new { sgbd = diag.LoadedSgbd, table, rows });
        return 0;
    }

    // run ANY job against the live car, optional argument, pretty-print the sets.
    // NOTE: EDIABAS runs whatever it is asked. Most jobs are reads, but STEUERN_*
    // actuator jobs and *_SCHREIBEN write jobs also live here -- so a job whose
    // name looks like a write is gated behind --confirm, printing what it will do
    // first. Pure reads run unguarded (that is INPA's own posture).
    //   run <JOB> [ARG] [SGBD] [--port DEV] [--confirm]
    public static int Run(Cli cli, Diag diag)
    {
        if (cli.Args.Count == 0) { Cli.Err("usage: run <JOB> [ARG] [SGBD] [--port DEV]"); return 2; }
        string job = cli.Args[0];
        // positionals: <JOB> [ARG] [SGBD]. The SGBD is the trailing positional
        // (as everywhere), so ARG only exists with 3 positionals; --arg overrides.
        string? arg = cli.Opt("--arg");
        string sgbd;
        if (arg == null && cli.Args.Count >= 3) { arg = cli.Args[1]; sgbd = cli.Args[2]; }
        else sgbd = cli.Args.Count > 1 && arg == null ? cli.Args[^1]
                  : (cli.Args.Count > 1 ? cli.Args[^1] : cli.Sgbd(1));

        if (LooksLikeWrite(job) && !cli.Confirm)
        {
            Cli.Err($"'{job}' looks like a WRITE/actuator job that changes ECU state.");
            Cli.Err($"It would run: {job}{(arg == null ? "" : " " + arg)} on {sgbd}.");
            Cli.Err("Re-run with --confirm to proceed. (Reads run without --confirm.)");
            return 5;
        }

        string port = cli.Port();
        if (port == null) { Cli.Err("No cable found. Plug in the K+DCAN cable, or pass --port."); return 4; }

        cli.Line($"Port : {port}");
        cli.Line($"SGBD : {sgbd}");
        cli.Line($"Job  : {job}{(arg == null ? "" : " " + arg)}");
        if (LooksLikeWrite(job)) cli.Line("(confirmed write/actuator job)");

        diag.AttachSerial(port);
        diag.Load(sgbd);
        var sets = arg == null ? diag.Run(job) : diag.Run(job, arg);
        int n = 0;
        foreach (var set in sets)
        {
            cli.Line($"--- set {++n} ---");
            foreach (var kv in set)
                if (cli.Verbose || !kv.Key.StartsWith("_"))
                    cli.Line($"  {kv.Key,-24} = {Cli.Fmt(kv.Value)}");
        }
        if (n == 0) cli.Line("(no result sets)");
        cli.Emit(new { port, sgbd = diag.LoadedSgbd, job, arg, sets = cli.Sets(sets) });
        return 0;
    }

    // heuristic write/actuator detector for `run`'s confirm gate. Deliberately
    // conservative: SCHREIBEN (write), LOESCHEN (clear), STEUERN/STELLGLIED
    // (actuator drive), CODIER_SCHREIBEN, RESET, and flash verbs. It is a safety
    // net, not the authority -- FS_LOESCHEN and coding-write have their own
    // dedicated, better-warned commands.
    private static readonly string[] WriteTokens =
    {
        "SCHREIBEN", "LOESCHEN", "STEUERN", "STELLGLIED", "RESET",
        "FLASH_LOESCHEN", "FLASH_SCHREIBEN", "PROGRAMMIER",
    };

    public static bool LooksLikeWrite(string job) =>
        WriteTokens.Any(t => job.Contains(t, StringComparison.OrdinalIgnoreCase))
        // reads that merely contain a write-ish token are exempt
        && !job.Contains("STATUS", StringComparison.OrdinalIgnoreCase)
        && !job.EndsWith("_LESEN", StringComparison.OrdinalIgnoreCase);
}
