using System;
using System.Collections.Generic;
using System.Linq;
using EdiabasMac;

namespace InpaMac.Cli;

// vehicle/chassis navigation, all offline (no cable): the INPA menu tree, the
// ECUs in a chassis, one ECU's resolved SGBD + address group. Mirrors what the
// GUI's /api/chassis endpoints serve, from the same InpaConfig loader.
internal static class VehicleCommands
{
    // list chassis, or the sections+ECUs of one chassis.
    //   ecus [CHASSIS]           E46 default; sections -> ECUs with SGBD + group
    public static int Chassis(Cli cli, InpaConfig cfg)
    {
        if (cli.Args.Count == 0)
        {
            var ids = cfg.ChassisIds();
            cli.Line("Chassis:");
            foreach (var id in ids) cli.Line($"  {id}");
            cli.Emit(new { chassis = ids });
            return 0;
        }
        return ShowChassis(cli, cfg, cli.Args[0].ToUpperInvariant());
    }

    // the ECUs of a chassis (default E46), grouped by INPA section.
    public static int Ecus(Cli cli, InpaConfig cfg)
    {
        string id = (cli.Args.Count > 0 ? cli.Args[0] : "E46").ToUpperInvariant();
        return ShowChassis(cli, cfg, id);
    }

    private static int ShowChassis(Cli cli, InpaConfig cfg, string id)
    {
        Chassis ch;
        try { ch = cfg.Load(id); }
        catch (Exception ex) { Cli.Err($"chassis {id}: {ex.Message}"); return 4; }

        cli.Line($"{ch.Id} - {ch.Description}");
        foreach (var s in ch.Sections)
        {
            cli.Line($"  [{s.Name}]");
            foreach (var e in s.Ecus)
                cli.Line($"     {e.Label,-34} -> {e.Sgbd}.prg" +
                         (e.Group != null ? $"   (group {e.Group})" : ""));
        }
        cli.Emit(new
        {
            id = ch.Id,
            description = ch.Description,
            sections = ch.Sections.Select(s => new
            {
                key = s.Key,
                name = s.Name,
                ecus = s.Ecus.Select(e => new
                {
                    code = e.Code, label = e.Label, sgbd = e.Sgbd, group = e.Group,
                }),
            }),
        });
        return 0;
    }

    // full metadata for one ECU: find it in a chassis (or by SGBD), print its
    // code/label/section/SGBD/group and the sibling variants that share fault
    // tables. --chassis narrows the search; otherwise every chassis is scanned.
    //   ecu <CODE-or-SGBD> [--chassis E46]
    public static int Ecu(Cli cli, InpaConfig cfg)
    {
        if (cli.Args.Count == 0) { Cli.Err("usage: ecu <CODE-or-SGBD> [--chassis E46]"); return 2; }
        string needle = cli.Args[0];
        string? only = cli.Opt("--chassis")?.ToUpperInvariant();

        foreach (var id in cfg.ChassisIds())
        {
            if (only != null && !string.Equals(id, only, StringComparison.OrdinalIgnoreCase)) continue;
            Chassis ch;
            try { ch = cfg.Load(id); } catch { continue; }
            foreach (var s in ch.Sections)
                foreach (var e in s.Ecus)
                {
                    if (!string.Equals(e.Code, needle, StringComparison.OrdinalIgnoreCase) &&
                        !string.Equals(e.Sgbd, needle, StringComparison.OrdinalIgnoreCase))
                        continue;
                    var variants = cfg.SgbdVariants(e.Sgbd);
                    cli.Line($"ECU     : {e.Code}");
                    cli.Line($"Label   : {e.Label}");
                    cli.Line($"Chassis : {ch.Id}");
                    cli.Line($"Section : {s.Name}");
                    cli.Line($"SGBD    : {e.Sgbd}");
                    cli.Line($"Group   : {e.Group ?? "(none)"}");
                    cli.Line($"Variants: {string.Join(", ", variants)}");
                    cli.Emit(new
                    {
                        code = e.Code, label = e.Label, chassis = ch.Id,
                        section = s.Name, sgbd = e.Sgbd, group = e.Group,
                        variants,
                    });
                    return 0;
                }
        }
        Cli.Err($"no ECU matching '{needle}'" + (only != null ? $" in {only}" : ""));
        return 4;
    }

    // resolve an ECU code / SGBD name to its concrete SGBD + address group
    // (offline). This is the filename heuristic; a LIVE identity comes from the
    // `resolve --port ...` group probe (VariantCommands).
    //   sgbd <CODE> [--chassis E46]
    public static int ResolveSgbd(Cli cli, InpaConfig cfg)
    {
        if (cli.Args.Count == 0) { Cli.Err("usage: sgbd <CODE> [--chassis E46]"); return 2; }
        // reuse Ecu's search but print just the resolution
        string needle = cli.Args[0];
        string? only = cli.Opt("--chassis")?.ToUpperInvariant();
        foreach (var id in cfg.ChassisIds())
        {
            if (only != null && !string.Equals(id, only, StringComparison.OrdinalIgnoreCase)) continue;
            Chassis ch;
            try { ch = cfg.Load(id); } catch { continue; }
            foreach (var s in ch.Sections)
                foreach (var e in s.Ecus)
                    if (string.Equals(e.Code, needle, StringComparison.OrdinalIgnoreCase))
                    {
                        cli.Say($"{e.Code} -> {e.Sgbd}" + (e.Group != null ? $" (group {e.Group})" : ""));
                        cli.Emit(new { code = e.Code, sgbd = e.Sgbd, group = e.Group, chassis = ch.Id });
                        return 0;
                    }
        }
        Cli.Err($"no ECU code '{needle}'" + (only != null ? $" in {only}" : ""));
        return 4;
    }
}
