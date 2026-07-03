using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using EdiabasLib;
using EdiabasMac;

// InpaMac CLI: native macOS EDIABAS driver for the E46.
//
//   inpamac jobs   [sgbd]                 list all diagnostic jobs (offline)
//   inpamac results <JOB> [sgbd]          job result schema (offline)
//   inpamac read   [--port DEV] [sgbd]    read fault codes from the DME  (live)
//   inpamac clear  [--port DEV] [sgbd]    clear fault codes on the DME   (live)
//
// default SGBD ms450ds0 (E46 325 MS45.1 DME). default port auto-detected from
// /dev/tty.usbserial*. same Diag backend powers the Chromium GUI.

internal static class Program
{
    private const string DefaultSgbd = "ms450ds0";

    private static int Main(string[] args)
    {
        string root = Paths.FindRepoRoot();
        string ecuPath = Paths.EcuPath(root);
        string inpaRoot = Paths.InpaRoot(root);
        if (!Directory.Exists(ecuPath))
        {
            Console.Error.WriteLine($"ECU path not found: {ecuPath}");
            return 1;
        }

        var (cmd, rest, port) = ParseArgs(args);

        // every chassis -> its SGBDs (deduped), one per line
        if (cmd == "allsgbds")
        {
            var cfg = new InpaConfig(inpaRoot, ecuPath);
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var id in cfg.ChassisIds())
            {
                Chassis ch;
                try { ch = cfg.Load(id); } catch { continue; }
                foreach (var s in ch.Sections)
                    foreach (var e in s.Ecus)
                        if (seen.Add(e.Sgbd)) Console.WriteLine(e.Sgbd);
            }
            return 0;
        }

        // INPA navigation tree (offline, no engine)
        if (cmd == "chassis")
        {
            var cfg = new InpaConfig(inpaRoot, ecuPath);
            if (rest.Count == 0)
            {
                Console.WriteLine("Chassis:");
                foreach (var id in cfg.ChassisIds()) Console.WriteLine($"  {id}");
                return 0;
            }
            var ch = cfg.Load(rest[0].ToUpperInvariant());
            Console.WriteLine($"{ch.Id} - {ch.Description}");
            foreach (var s in ch.Sections)
            {
                Console.WriteLine($"  [{s.Name}]");
                foreach (var e in s.Ecus)
                    Console.WriteLine($"     {e.Label,-32} -> {e.Sgbd}.prg");
            }
            return 0;
        }
        string sgbd = rest.Count > 0 ? rest[^1] : DefaultSgbd;

        using var diag = new Diag(ecuPath);

        try
        {
            switch (cmd)
            {
                case "jobs":
                    diag.Load(sgbd);
                    Console.WriteLine($"Jobs in {diag.LoadedSgbd}:");
                    foreach (var j in diag.Jobs()) Console.WriteLine($"  {j}");
                    return 0;

                case "dumpjobs":
                {
                    // for each SGBD name (args or stdin), print "SGBD\tJOB" lines
                    var names = rest.Count > 0 ? rest
                        : Console.In.ReadToEnd().Split('\n', StringSplitOptions.RemoveEmptyEntries)
                              .Select(s => s.Trim()).Where(s => s.Length > 0).ToList();
                    foreach (var name in names)
                    {
                        try
                        {
                            using var d = new Diag(ecuPath);
                            d.Load(name);
                            foreach (var j in d.Jobs())
                                Console.WriteLine($"{name}\t{j}");
                        }
                        catch (Exception ex) { Console.Error.WriteLine($"# {name}: {ex.Message}"); }
                    }
                    return 0;
                }

                case "results":
                    if (rest.Count == 0) { Console.Error.WriteLine("usage: results <JOB> [sgbd]"); return 2; }
                    string job = rest[0];
                    sgbd = rest.Count > 1 ? rest[1] : DefaultSgbd;
                    diag.Load(sgbd);
                    Console.WriteLine($"Results of {job} in {diag.LoadedSgbd}:");
                    foreach (var line in diag.ResultsOf(job)) Console.WriteLine($"  {line}");
                    return 0;

                case "arguments":
                case "args":
                    if (rest.Count == 0) { Console.Error.WriteLine("usage: arguments <JOB> [sgbd]"); return 2; }
                    string ajob = rest[0];
                    sgbd = rest.Count > 1 ? rest[1] : DefaultSgbd;
                    diag.Load(sgbd);
                    Console.WriteLine($"Arguments of {ajob} in {diag.LoadedSgbd}:");
                    foreach (var set in diag.Run("_ARGUMENTS", ajob))
                    {
                        var row = set.Where(kv => !kv.Key.StartsWith("_"))
                                     .Select(kv => $"{kv.Key}={Diag.Format(kv.Value)}");
                        Console.WriteLine("  " + string.Join("  ", row));
                    }
                    return 0;

                case "read":
                    return LiveFaultCodes(diag, sgbd, port, clear: false, new InpaConfig(inpaRoot, ecuPath));

                case "clear":
                    return LiveFaultCodes(diag, sgbd, port, clear: true, new InpaConfig(inpaRoot, ecuPath));

                default:
                    Console.WriteLine("commands: jobs | results <JOB> | read | clear   (options: --port DEV)");
                    return 0;
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Error: {ex.Message}");
            return 3;
        }
    }

    // live: connect over K+DCAN, read or clear fault memory. cfg resolves sibling
    // SGBD variants for the multi-variant fault-label merge.
    private static int LiveFaultCodes(Diag diag, string sgbd, string port, bool clear, InpaConfig cfg)
    {
        port ??= Paths.AutoDetectPort();
        if (port == null)
        {
            Console.Error.WriteLine("No /dev/tty.usbserial* device found. Plug in the K+DCAN cable (FTDI VCP driver), or pass --port.");
            return 4;
        }

        Console.WriteLine($"Port : {port}");
        Console.WriteLine($"SGBD : {sgbd}");
        diag.AttachSerial(port);

        if (clear)
        {
            diag.Load(sgbd);
            diag.Run("FS_LOESCHEN");                 // clear fault memory
            Console.WriteLine("Fault memory cleared (FS_LOESCHEN).");
            return 0;
        }

        // read + parse fault memory, filling "unknown location" faults from sibling
        // SGBD variants (same merge the GUI/server does, so labels match)
        var codes = FaultReader.ReadFaultsMerged(diag, sgbd, cfg.SgbdVariants(sgbd));
        int n = 0;
        foreach (var row in codes)
        {
            n++;
            Console.WriteLine($"--- Fault {n} ---");
            foreach (var kv in row)
                Console.WriteLine($"  {kv.Key,-22} = {kv.Value}");
        }
        Console.WriteLine(n == 0 ? "No stored fault codes." : $"{n} fault code(s).");
        return 0;
    }

    private static (string cmd, List<string> rest, string port) ParseArgs(string[] args)
    {
        string cmd = args.Length > 0 ? args[0].ToLowerInvariant() : "help";
        var rest = new List<string>();
        string port = null;
        for (int i = 1; i < args.Length; i++)
        {
            if (args[i] == "--port" && i + 1 < args.Length) { port = args[++i]; continue; }
            rest.Add(args[i]);
        }
        return (cmd, rest, port);
    }
}
