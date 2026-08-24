using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using EdiabasMac;

namespace InpaMac.Cli;

// fault memory: read (with the same sibling-variant label merge and group
// auto-identify the GUI uses), clear (destructive -> --confirm), and a report
// exporter. Shares FaultReader so labels match the app exactly.
internal static class FaultCommands
{
    // read fault memory. Prefers the address group (auto-identifies the exact
    // variant) when --group is given or the config knows one; otherwise reads
    // the concrete SGBD and merges sibling variants for unlabeled faults.
    //   read [SGBD] [--group D_00xx] [--port DEV]
    public static int Read(Cli cli, Diag diag, InpaConfig cfg)
    {
        string sgbd = cli.Sgbd();
        string? group = cli.Opt("--group");
        string port = cli.Port();
        if (port == null)
        {
            Cli.Err("No /dev/tty.usbserial* device found. Plug in the K+DCAN cable (FTDI VCP driver), or pass --port.");
            return 4;
        }
        cli.Line($"Port : {port}");
        cli.Line($"SGBD : {sgbd}");
        diag.AttachSerial(port);

        var codes = FaultReader.ReadFaultsAuto(diag, sgbd, group, cfg.SgbdVariants(sgbd));
        PrintFaults(cli, codes);
        cli.Emit(new { port, sgbd, group, count = codes.Count, faults = codes });
        return 0;
    }

    // clear fault memory (FS_LOESCHEN). DESTRUCTIVE: needs --confirm, and prints
    // exactly what it will do first. After clearing, re-reads to prove the
    // memory is empty (the app's "prove-clear-by-re-read" safety contract).
    //   clear [SGBD] [--port DEV] --confirm
    public static int Clear(Cli cli, Diag diag, InpaConfig cfg)
    {
        string sgbd = cli.Sgbd();

        // the confirm gate comes FIRST, before any hardware is touched, so the
        // refusal (and exactly-what-it-will-do) is shown even with no cable.
        if (!cli.Confirm)
        {
            Cli.Err($"clear would run FS_LOESCHEN on {sgbd}, ERASING its stored fault memory.");
            Cli.Err("This cannot be undone. Re-run with --confirm to proceed.");
            return 5;
        }

        string port = cli.Port();
        if (port == null) { Cli.Err("No cable found. Plug in the K+DCAN cable, or pass --port."); return 4; }

        cli.Line($"Port : {port}");
        cli.Line($"SGBD : {sgbd}");
        diag.AttachSerial(port);
        diag.Load(sgbd);
        diag.Run("FS_LOESCHEN");
        cli.Line("Fault memory cleared (FS_LOESCHEN).");

        // prove it: re-read and report what remains
        var after = FaultReader.ReadFaults(diag, sgbd);
        cli.Say(after.Count == 0
            ? "Verified: no stored faults remain."
            : $"WARNING: {after.Count} fault(s) still present after clear.");
        cli.Emit(new { port, sgbd, cleared = true, remaining = after.Count, faults = after });
        return after.Count == 0 ? 0 : 6;
    }

    // export a fault report to a file (or stdout). --format json|text, --out PATH.
    //   report [SGBD] [--group D_00xx] [--out faults.json] [--format json|text]
    public static int Report(Cli cli, Diag diag, InpaConfig cfg)
    {
        string sgbd = cli.Sgbd();
        string? group = cli.Opt("--group");
        string format = (cli.Opt("--format") ?? "text").ToLowerInvariant();
        string? outPath = cli.Opt("--out");
        string port = cli.Port();
        if (port == null) { Cli.Err("No cable found. Plug in the K+DCAN cable, or pass --port."); return 4; }

        diag.AttachSerial(port);
        var codes = FaultReader.ReadFaultsAuto(diag, sgbd, group, cfg.SgbdVariants(sgbd));

        string body;
        if (format == "json")
        {
            body = System.Text.Json.JsonSerializer.Serialize(
                new { sgbd, group, timestamp = DateTime.UtcNow.ToString("o"), count = codes.Count, faults = codes },
                new System.Text.Json.JsonSerializerOptions { WriteIndented = true });
        }
        else
        {
            var sb = new System.Text.StringBuilder();
            sb.AppendLine($"Fault report  SGBD={sgbd}  {DateTime.Now:yyyy-MM-dd HH:mm}");
            sb.AppendLine(new string('-', 48));
            int n = 0;
            foreach (var f in codes)
            {
                sb.AppendLine($"[{++n}]");
                foreach (var kv in f) sb.AppendLine($"    {kv.Key,-22} = {kv.Value}");
            }
            sb.AppendLine(codes.Count == 0 ? "No stored fault codes." : $"{codes.Count} fault code(s).");
            body = sb.ToString();
        }

        if (outPath != null)
        {
            File.WriteAllText(outPath, body);
            cli.Say($"Wrote {codes.Count} fault(s) to {Path.GetFullPath(outPath)}");
            cli.Emit(new { sgbd, out_path = Path.GetFullPath(outPath), count = codes.Count });
        }
        else
        {
            // to stdout: honor --json by emitting the structured form only
            if (cli.Json) cli.Emit(new { sgbd, group, count = codes.Count, faults = codes });
            else Console.WriteLine(body);
        }
        return 0;
    }

    private static void PrintFaults(Cli cli, List<Dictionary<string, string>> codes)
    {
        int n = 0;
        foreach (var row in codes)
        {
            cli.Line($"--- Fault {++n} ---");
            foreach (var kv in row) cli.Line($"  {kv.Key,-22} = {kv.Value}");
        }
        cli.Say(codes.Count == 0 ? "No stored fault codes." : $"{codes.Count} fault code(s).");
    }
}
