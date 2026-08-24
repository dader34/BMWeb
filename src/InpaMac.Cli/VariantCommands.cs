using System;
using System.Collections.Generic;
using System.Linq;
using EdiabasMac;

namespace InpaMac.Cli;

// variant / group resolution (live): given a diagnostic-address group SGBD
// (D_00xx.grp), find which concrete SGBD actually answers. Loading a .grp makes
// EDIABAS run its IDENTIFIKATION job and select the installed variant; the
// group's VARIANTE result (lowercased) is that SGBD name. This mirrors the
// renderer's webResolveVariant(group) and reference ResolveSgbdFile.
internal static class VariantCommands
{
    // resolve a group to the installed SGBD.
    //   resolve <D_00xx> [--port DEV]
    //   resolve <ECU-code> --chassis E46 [--port DEV]   (look up the group first)
    public static int Resolve(Cli cli, Diag diag, InpaConfig cfg)
    {
        if (cli.Args.Count == 0)
        {
            Cli.Err("usage: resolve <GROUP|ECU-code> [--chassis E46] [--port DEV]");
            return 2;
        }
        string arg = cli.Args[0];
        string group = arg;

        // if the argument is an ECU code (not a D_* group), look its group up in
        // the chassis config so `resolve MS450 --chassis E46` works.
        if (!arg.StartsWith("D_", StringComparison.OrdinalIgnoreCase))
        {
            string? found = LookupGroup(cfg, arg, cli.Opt("--chassis")?.ToUpperInvariant());
            if (found == null)
            {
                Cli.Err($"no address group known for '{arg}'. Pass a D_00xx group directly, or --chassis.");
                return 4;
            }
            group = found;
            cli.Line($"{arg} -> group {group}");
        }

        string port = cli.Port();
        if (port == null) { Cli.Err("No cable found. Plug in the K+DCAN cable, or pass --port."); return 4; }

        cli.Line($"Port  : {port}");
        cli.Line($"Group : {group}");
        diag.AttachSerial(port);

        // loading the group runs IDENTIFIKATION and picks the variant. Running it
        // explicitly lets us read VARIANTE; LoadedSgbd is also updated.
        diag.Load(group);
        string? variant = null;
        try
        {
            var sets = diag.Run("IDENTIFIKATION");
            variant = IdentCommands.Flatten(sets)
                .FirstOrDefault(k => string.Equals(k.Key, "VARIANTE", StringComparison.OrdinalIgnoreCase))
                .Value?.ToLowerInvariant();
        }
        catch (Exception ex) { cli.Line($"(IDENTIFIKATION: {ex.Message})"); }

        // fall back to what EDIABAS resolved the group to, if VARIANTE was empty
        if (string.IsNullOrEmpty(variant)) variant = diag.LoadedSgbd;

        cli.Say($"Installed variant: {variant}");
        cli.Emit(new { port, group, variant, loaded = diag.LoadedSgbd });
        return 0;
    }

    // the group SGBD an ECU code maps to, from the chassis config. Scans all
    // chassis unless one is named.
    private static string? LookupGroup(InpaConfig cfg, string code, string? only)
    {
        foreach (var id in cfg.ChassisIds())
        {
            if (only != null && !string.Equals(id, only, StringComparison.OrdinalIgnoreCase)) continue;
            Chassis ch;
            try { ch = cfg.Load(id); } catch { continue; }
            foreach (var s in ch.Sections)
                foreach (var e in s.Ecus)
                    if ((string.Equals(e.Code, code, StringComparison.OrdinalIgnoreCase) ||
                         string.Equals(e.Sgbd, code, StringComparison.OrdinalIgnoreCase)) &&
                        e.Group != null)
                        return e.Group;
        }
        return null;
    }
}
