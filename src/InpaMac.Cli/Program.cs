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

        // dump every job argument label + comment across all vendored SGBDs
        // (offline, for translation-coverage mining). one TSV line per arg:
        //   <sgbd>\t<job>\t<ARG>\t<ARGCOMMENT0>
        if (cmd == "dumpargs")
        {
            var prgs = Directory.EnumerateFiles(ecuPath, "*.prg")
                .Concat(Directory.EnumerateFiles(ecuPath, "*.PRG"))
                .Select(f => Path.GetFileNameWithoutExtension(f))
                .Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(x => x);
            var outw = Console.Out;
            foreach (var prgName in prgs)
            {
                using var d = new Diag(ecuPath);
                List<string> jobs;
                try { d.Load(prgName); jobs = d.Jobs(); } catch { continue; }
                foreach (var job in jobs)
                {
                    List<Dictionary<string, EdiabasNet.ResultData>> sets;
                    try { sets = d.Run("_ARGUMENTS", job); } catch { continue; }
                    foreach (var set in sets)
                    {
                        if (!(set.TryGetValue("ARG", out var a) && a.OpData is string arg) || arg.Length == 0)
                            continue;
                        string comment = set.TryGetValue("ARGCOMMENT0", out var c) && c.OpData is string cs
                            ? cs.Replace("\t", " ").Replace("\n", " ").Trim() : "";
                        outw.WriteLine($"{prgName}\t{job}\t{arg}\t{comment}");
                    }
                }
            }
            return 0;
        }

        // dump a fault-text table (offline) for the named SGBDs. FORTTEXTE maps a
        // fault-location code (ORT) to its German text (ORTTEXT); this is the source
        // the E46/E36 data/faults/**.json translations are mined from - no cable
        // needed, the table ships inside the .prg. one TSV line per row:
        //   <sgbd>\t<ORT>\t<ORTTEXT>
        // usage: dumptable [TABLE] <sgbd...>   (TABLE defaults to FORTTEXTE; reads
        // SGBD names from args, else stdin). unknown tables / SGBDs are skipped.
        if (cmd == "dumptable")
        {
            // first arg is the table name only if it looks like one (all-caps, no
            // .prg); otherwise it's an SGBD and the table defaults to FORTTEXTE.
            string table = "FORTTEXTE";
            var names = new List<string>(rest);
            if (names.Count > 0 && names[0].All(c => char.IsUpper(c) || char.IsDigit(c) || c == '_'))
            { table = names[0]; names.RemoveAt(0); }
            if (names.Count == 0)
                names = Console.In.ReadToEnd().Split('\n', StringSplitOptions.RemoveEmptyEntries)
                            .Select(s => s.Trim()).Where(s => s.Length > 0).ToList();
            var outw = Console.Out;
            foreach (var name in names)
            {
                using var d = new Diag(ecuPath);
                List<Dictionary<string, EdiabasNet.ResultData>> sets;
                try { d.Load(name); sets = d.Run("_TABLE", table); }
                catch (Exception ex) { Console.Error.WriteLine($"# {name}: {ex.Message}"); continue; }
                foreach (var set in sets)
                {
                    // rows carry COLUMN0/COLUMN1; the first data row is the header
                    // (ORT/ORTTEXT), skip it. the trailing summary set has no COLUMN0.
                    if (!(set.TryGetValue("COLUMN0", out var c0) && c0.OpData is string ort) || ort.Length == 0)
                        continue;
                    if (ort == "ORT") continue; // header row
                    string text = set.TryGetValue("COLUMN1", out var c1) && c1.OpData is string ot
                        ? ot.Replace("\t", " ").Replace("\n", " ").Trim() : "";
                    outw.WriteLine($"{name}\t{ort}\t{text}");
                }
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

        // BMACW_IFH_TRACE=<dir> captures every telegram EDIABAS puts on the
        // wire into <dir>/ifh.trc. The VM transport in the browser has to
        // reproduce these bytes exactly; this is how we see what they are
        // rather than inferring them from the SGBD.
        var ifhTraceDir = Environment.GetEnvironmentVariable("BMACW_IFH_TRACE");
        if (!string.IsNullOrWhiteSpace(ifhTraceDir))
        {
            Directory.CreateDirectory(ifhTraceDir);
            diag.TraceTo(ifhTraceDir);
            Console.WriteLine($"IFH trace -> {ifhTraceDir}/ifh.trc");
        }

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

                // run a job against recorded telegrams (no cable): emits the
                // result sets as JSON so tools/sgbd_value_diff.py can compare
                // them against the values a lifted spec decodes from the same
                // bytes. --sim <dir> holds <sgbd>.sim.
                case "simrun":
                {
                    if (rest.Count == 0)
                    {
                        Console.Error.WriteLine(
                            "usage: simrun <JOB> [sgbd] --sim <dir> [--arg <s>]");
                        return 2;
                    }
                    string sjob = rest[0];
                    sgbd = rest.Count > 1 ? rest[1] : DefaultSgbd;
                    string simDir = Opt(args, "--sim");
                    if (simDir == null)
                    {
                        Console.Error.WriteLine("simrun needs --sim <dir>");
                        return 2;
                    }
                    diag.AttachSimulation(Path.GetFullPath(simDir));
                    string traceDir = Opt(args, "--trace");
                    if (traceDir != null) diag.TraceTo(Path.GetFullPath(traceDir));
                    diag.Load(sgbd);
                    var sets = diag.Run(sjob, Opt(args, "--arg"));
                    var outSets = sets.Select(s => s.ToDictionary(
                        kv => kv.Key, kv => Diag.Format(kv.Value))).ToList();
                    Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(
                        new { sgbd = diag.LoadedSgbd, job = sjob, sets = outSets }));
                    return 0;
                }

                // Batch form of simrun: read {sgbd, job, sim} requests as JSON
                // lines on stdin, answer one JSON line each. Verifying the
                // whole corpus one process per job costs ~1.6s of .NET startup
                // each -- half an hour of doing nothing -- so the bulk harness
                // (tools/sgbd_bulk_verify.py) drives this instead.
                case "simbatch":
                {
                    string line;
                    while ((line = Console.ReadLine()) != null)
                    {
                        if (line.Length == 0) continue;
                        string rsgbd = null, rjob = null;
                        try
                        {
                            using var doc = System.Text.Json.JsonDocument.Parse(line);
                            var el = doc.RootElement;
                            rsgbd = el.GetProperty("sgbd").GetString();
                            rjob = el.GetProperty("job").GetString();
                            string rsim = el.GetProperty("sim").GetString();
                            string rarg = el.TryGetProperty("arg", out var av)
                                ? av.GetString() : null;
                            // a fresh engine per job: EDIABAS caches the loaded
                            // SGBD and its simulation file, and reusing one
                            // across ECUs answers the next job from the
                            // previous ECU's telegrams.
                            using var d = new Diag(ecuPath);
                            d.AttachSimulation(Path.GetFullPath(rsim));
                            d.Load(rsgbd);
                            var s = d.Run(rjob, rarg);
                            var os = s.Select(x => x.ToDictionary(
                                kv => kv.Key, kv => Diag.Format(kv.Value))).ToList();
                            Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(
                                new { sgbd = rsgbd, job = rjob, sets = os }));
                        }
                        catch (Exception ex)
                        {
                            Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(
                                new { sgbd = rsgbd, job = rjob, error = ex.Message }));
                        }
                        Console.Out.Flush();
                    }
                    return 0;
                }

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

    // value of a "--flag value" pair straight off argv. ParseArgs folds unknown
    // flags into `rest`, so simrun's options are read from the raw array.
    private static string Opt(string[] args, string flag)
    {
        for (int i = 0; i + 1 < args.Length; i++)
            if (string.Equals(args[i], flag, StringComparison.OrdinalIgnoreCase))
                return args[i + 1];
        return null;
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
