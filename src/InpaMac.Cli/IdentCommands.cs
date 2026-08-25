using System;
using System.Collections.Generic;
using System.Linq;
using EdiabasMac;

namespace InpaMac.Cli;

// module identification (live): run IDENT and lay out the identity fields the
// renderer's identity screen shows -- part number, HW/SW indices, coding index,
// variant index, build date, supplier. Plus INFO (SGBD info) and the serial
// number read. All reads; no gate needed.
internal static class IdentCommands
{
    // the IDENT result fields, in a readable order, with English labels. The
    // SGBD names them ID_*; this is the same mapping the identity screen uses.
    private static readonly (string Key, string Label)[] IdentFields =
    {
        ("ID_BMW_NR", "Part number"),
        ("ID_HW_NR", "Hardware index"),
        ("ID_COD_INDEX", "Coding index"),
        ("ID_DIAG_INDEX", "Diagnosis index"),
        ("ID_VAR_INDEX", "Variant index"),
        ("ID_SW_NR_MCV", "Software (MCV)"),
        ("ID_SW_NR_FSV", "Software (FSV)"),
        ("ID_SW_NR_OSV", "Software (OSV)"),
        ("ID_DATUM", "Build date"),
        ("ID_LIEF_TEXT", "Supplier"),
        ("ID_LIEF_NR", "Supplier number"),
        ("ID_SG_ADR", "ECU address"),
        ("ID_EWS_SS", "EWS interface"),
    };

    // run IDENT and print the identity. --sgbd/positional selects the ECU;
    // --group loads the address group first so EDIABAS picks the exact variant.
    //   ident [SGBD] [--group D_00xx] [--port DEV]
    public static int Ident(Cli cli, Diag diag, InpaConfig cfg)
    {
        string sgbd = cli.Sgbd();
        string? group = cli.Opt("--group");
        string port = cli.Port();
        if (port == null) { Cli.Err("No cable found. Plug in the K+DCAN cable, or pass --port."); return 4; }

        cli.Line($"Port : {port}");
        diag.AttachSerial(port);

        // loading the group makes EDIABAS run IDENTIFIKATION and pick the right
        // variant; otherwise load the concrete SGBD directly.
        string loadName = !string.IsNullOrEmpty(group) ? group : sgbd;
        diag.Load(loadName);
        cli.Line($"SGBD : {diag.LoadedSgbd}");

        var sets = diag.Run("IDENT");
        var flat = Flatten(sets);
        var identity = new Dictionary<string, string>();
        cli.Line("Identity:");
        foreach (var (key, label) in IdentFields)
            if (flat.TryGetValue(key, out var v) && !string.IsNullOrEmpty(v))
            {
                cli.Line($"  {label,-18}: {v}");
                identity[key] = v;
            }
        if (identity.Count == 0) cli.Line("  (IDENT returned no identity fields)");

        cli.Emit(new { port, sgbd = diag.LoadedSgbd, group, identity, raw = cli.Sets(sets) });
        return 0;
    }

    // INFO (SGBD info card) for the connected module. INFO is a real job the
    // engine runs, so it needs a cable like the other live reads; for the SGBD's
    // static description with no cable, use `ecu`/`chassis` (from InpaConfig) or
    // the offline meta the GUI ships.
    //   info [SGBD] [--port DEV]
    public static int Info(Cli cli, Diag diag)
    {
        string sgbd = cli.Sgbd();
        string port = cli.Port();
        if (port == null) { Cli.Err("No cable found. Plug in the K+DCAN cable, or pass --port."); return 4; }
        cli.Line($"Port : {port}");
        diag.AttachSerial(port);
        diag.Load(sgbd);
        var sets = diag.Run("INFO");
        var flat = Flatten(sets);
        cli.Line($"INFO for {diag.LoadedSgbd}:");
        foreach (var kv in flat.Where(k => !k.Key.StartsWith("_") && k.Key != "JOB_STATUS"))
            cli.Line($"  {kv.Key,-10}: {kv.Value}");
        cli.Emit(new { sgbd = diag.LoadedSgbd, info = flat });
        return 0;
    }

    // SERIENNUMMER_LESEN (live).
    //   serial [SGBD] [--port DEV]
    public static int Serial(Cli cli, Diag diag)
    {
        string sgbd = cli.Sgbd();
        string port = cli.Port();
        if (port == null) { Cli.Err("No cable found. Plug in the K+DCAN cable, or pass --port."); return 4; }
        cli.Line($"Port : {port}");
        diag.AttachSerial(port);
        diag.Load(sgbd);
        var sets = diag.Run("SERIENNUMMER_LESEN");
        string sn = Flatten(sets).TryGetValue("SERIENNUMMER", out var v) ? v : "(none)";
        cli.Say($"Serial: {sn}");
        cli.Emit(new { sgbd = diag.LoadedSgbd, serial = sn });
        return 0;
    }

    // first occurrence of each result name across all sets, formatted.
    internal static Dictionary<string, string> Flatten(
        List<Dictionary<string, EdiabasLib.EdiabasNet.ResultData>> sets)
    {
        var flat = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var set in sets)
            foreach (var kv in set)
                if (!flat.ContainsKey(kv.Key))
                    flat[kv.Key] = Cli.Fmt(kv.Value);
        return flat;
    }
}
