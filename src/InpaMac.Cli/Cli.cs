using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using EdiabasMac;

namespace InpaMac.Cli;

// shared plumbing for the extended commands: parsed options, output modes, the
// port/SGBD defaults, and the write-confirmation gate. Program.cs keeps the
// original flat-argv commands (jobs/results/read/clear/simrun/...) exactly as
// they were; the new subcommands route through here so they share one option
// parser and one JSON shape instead of each re-reading argv by hand.
internal sealed class Cli
{
    public const string DefaultSgbd = "ms450ds0";

    // the leftover positionals after flags are stripped, in order
    public List<string> Args { get; } = new();
    // --flag value pairs and bare --switches (value "" for a bare switch)
    private readonly Dictionary<string, string> _opts = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> _switches = new(StringComparer.OrdinalIgnoreCase);

    public bool Json => Has("--json");
    public bool Quiet => Has("--quiet") || Has("-q");
    public bool Verbose => Has("--verbose") || Has("-v");
    public bool Confirm => Has("--confirm") || Has("--yes") || Has("-y");

    // flags that take a value; everything else "--foo" is a bare switch. Listing
    // them lets the parser tell "--port /dev/x" (pair) from "--json" (switch)
    // without a value being swallowed as the next positional.
    private static readonly HashSet<string> ValueFlags = new(StringComparer.OrdinalIgnoreCase)
    {
        "--port", "--sgbd", "--chassis", "--arg", "--out", "--file", "--group",
        "--region", "--interval", "--count", "--format", "--sim", "--trace",
        "--data", "--filter",
    };

    // parse argv AFTER the subcommand word(s) have been removed by the caller.
    public Cli(IEnumerable<string> argv)
    {
        var list = argv.ToList();
        for (int i = 0; i < list.Count; i++)
        {
            string a = list[i];
            if (a.StartsWith("--") || (a.StartsWith("-") && a.Length == 2 && !char.IsDigit(a[1])))
            {
                if (ValueFlags.Contains(a) && i + 1 < list.Count)
                    _opts[a] = list[++i];
                else
                    _switches.Add(a);
            }
            else Args.Add(a);
        }
    }

    private bool Has(string flag) => _switches.Contains(flag) || _opts.ContainsKey(flag);
    // a bare presence check for any flag (switch or valued): `--poll`, `--all`.
    public bool Switch(string flag) => Has(flag);
    public string? Opt(string flag, string? fallback = null) => _opts.TryGetValue(flag, out var v) ? v : fallback;
    public int OptInt(string flag, int fallback) => int.TryParse(Opt(flag), out var v) ? v : fallback;

    // trailing positional or --sgbd, else the E46 default (matches the old CLI:
    // the last positional was always the SGBD).
    public string Sgbd(int consumedLeadingArgs = 0)
    {
        string? fromOpt = Opt("--sgbd");
        if (fromOpt != null) return fromOpt;
        if (Args.Count > consumedLeadingArgs) return Args[^1];
        return DefaultSgbd;
    }

    // explicit --port wins, else auto-detect the K+DCAN FTDI device. null when
    // no cable is present so live commands can print one clear message.
    public string Port() => Opt("--port") ?? Paths.AutoDetectPort();

    // ---- output ----

    private static readonly JsonSerializerOptions JsonOpts = new() { WriteIndented = true };

    public void Emit(object obj)
    {
        if (Json) Console.WriteLine(JsonSerializer.Serialize(obj, JsonOpts));
    }

    // human line, suppressed by --quiet and never printed under --json (which
    // owns stdout). Use for prose/headers; the machine payload goes to Emit.
    public void Line(string s = "")
    {
        if (!Json && !Quiet) Console.WriteLine(s);
    }

    // always-printed human line even under --quiet (final answers, counts) but
    // still silenced by --json so JSON stdout stays a single document.
    public void Say(string s)
    {
        if (!Json) Console.WriteLine(s);
    }

    public static void Err(string s) => Console.Error.WriteLine(s);

    // a result value for a EDIABAS type, reusing Diag's formatter (byte[]-aware).
    public static string Fmt(EdiabasLib.EdiabasNet.ResultData rd) => Diag.Format(rd);

    // flatten a job's result sets to plain dictionaries for --json, dropping the
    // internal _TEL_* telegram echoes unless --verbose asks for them.
    public List<Dictionary<string, string>> Sets(
        List<Dictionary<string, EdiabasLib.EdiabasNet.ResultData>> sets)
    {
        return sets.Select(s => s
            .Where(kv => Verbose || !kv.Key.StartsWith("_"))
            .ToDictionary(kv => kv.Key, kv => Fmt(kv.Value)))
            .ToList();
    }
}
