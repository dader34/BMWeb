using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using EdiabasMac;

namespace InpaMac.Cli;

// live status / readout jobs. Unlike the GUI's /api/state (which reads the
// adapter's own battery/ignition sense lines via INPA's UTILITY emulation, not
// the bus), the native CLI over a K+DCAN cable reads status straight from the
// ECU with its STATUS_* jobs -- e.g. the DME's STATUS_UBATT for battery, or the
// bulk STATUS_MESSWERTE block. --poll repeats the read.
internal static class StatusCommands
{
    // run a status/readout job and print its values. Defaults to the SGBD's
    // richest single readout if none is named. --poll N repeats every
    // --interval MS (default 1000). --count limits the poll iterations.
    //   status [JOB] [SGBD] [--port DEV] [--poll] [--interval 1000] [--count N]
    public static int Status(Cli cli, Diag diag)
    {
        string? job = cli.Args.Count > 0 ? cli.Args[0] : null;
        string sgbd = cli.Args.Count > 1 ? cli.Args[^1] : cli.Sgbd(1);
        string port = cli.Port();
        if (port == null) { Cli.Err("No cable found. Plug in the K+DCAN cable, or pass --port."); return 4; }

        diag.AttachSerial(port);
        diag.Load(sgbd);

        // no job named: pick a sensible default readout the SGBD actually has
        if (job == null)
        {
            var jobs = diag.Jobs();
            job = new[] { "STATUS_MESSWERTE", "STATUS_LESEN", "STATUS_UBATT" }
                      .FirstOrDefault(j => jobs.Contains(j, StringComparer.OrdinalIgnoreCase))
                  ?? jobs.FirstOrDefault(j => j.StartsWith("STATUS_", StringComparison.OrdinalIgnoreCase));
            if (job == null) { Cli.Err($"{diag.LoadedSgbd} has no STATUS_* job to read."); return 4; }
        }

        cli.Line($"Port : {port}");
        cli.Line($"SGBD : {diag.LoadedSgbd}");
        cli.Line($"Job  : {job}");

        bool poll = cli.Switch("--poll");
        int interval = cli.OptInt("--interval", 1000);
        int count = cli.OptInt("--count", poll ? int.MaxValue : 1);

        var jsonReads = new List<object>();
        for (int i = 0; i < count; i++)
        {
            var sets = diag.Run(job);
            var pairs = ReadoutPairs(sets);
            if (!cli.Json)
            {
                if (poll) cli.Line($"--- read {i + 1} ---");
                foreach (var (name, val) in pairs) cli.Line($"  {name,-28} = {val}");
                if (pairs.Count == 0) cli.Line("  (no values)");
            }
            jsonReads.Add(new { reading = pairs.ToDictionary(p => p.Name, p => p.Value) });
            if (i + 1 < count) Thread.Sleep(Math.Max(0, interval));
        }
        cli.Emit(new { port, sgbd = diag.LoadedSgbd, job, reads = jsonReads });
        return 0;
    }

    // convenience: the DME battery voltage (STATUS_UBATT). Falls back with a
    // clear message when the SGBD has no such job. NOT the same as INPA's
    // adapter-sensed battery -- this is what the ECU reports on Kl.87.
    //   battery [SGBD] [--port DEV]
    public static int Battery(Cli cli, Diag diag)
    {
        string sgbd = cli.Sgbd();
        string port = cli.Port();
        if (port == null) { Cli.Err("No cable found. Plug in the K+DCAN cable, or pass --port."); return 4; }
        diag.AttachSerial(port);
        diag.Load(sgbd);
        if (!diag.Jobs().Contains("STATUS_UBATT", StringComparer.OrdinalIgnoreCase))
        {
            Cli.Err($"{diag.LoadedSgbd} has no STATUS_UBATT job. Try `status <JOB> {sgbd}`.");
            return 4;
        }
        var flat = IdentCommands.Flatten(diag.Run("STATUS_UBATT"));
        string val = flat.TryGetValue("STAT_UBATT_WERT", out var v) ? v : "?";
        string unit = flat.TryGetValue("STAT_UBATT_EINH", out var u) ? u : "V";
        cli.Say($"Battery: {val} {unit}");
        cli.Emit(new { sgbd = diag.LoadedSgbd, battery = val, unit });
        return 0;
    }

    // WERT/EINH pairs collapse to "12.3 V"; every other non-internal result is
    // kept as-is. Keeps the ECU's own units without hardcoding sensor names.
    private static List<(string Name, string Value)> ReadoutPairs(
        List<Dictionary<string, EdiabasLib.EdiabasNet.ResultData>> sets)
    {
        var flat = IdentCommands.Flatten(sets);
        var used = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var outp = new List<(string, string)>();
        foreach (var kv in flat)
        {
            if (kv.Key.StartsWith("_") || kv.Key == "JOB_STATUS") continue;
            if (used.Contains(kv.Key)) continue;
            // pair STAT_X_WERT with STAT_X_EINH
            if (kv.Key.EndsWith("_WERT", StringComparison.OrdinalIgnoreCase))
            {
                string einh = kv.Key[..^"_WERT".Length] + "_EINH";
                string label = kv.Key[..^"_WERT".Length];
                string val = flat.TryGetValue(einh, out var u) && u.Length > 0
                    ? $"{kv.Value} {u}" : kv.Value;
                outp.Add((label, val));
                used.Add(kv.Key); used.Add(einh);
            }
            else if (!kv.Key.EndsWith("_EINH", StringComparison.OrdinalIgnoreCase))
            {
                outp.Add((kv.Key, kv.Value));
                used.Add(kv.Key);
            }
        }
        return outp;
    }
}
