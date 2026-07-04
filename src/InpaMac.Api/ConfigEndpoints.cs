using EdiabasMac;

namespace InpaMac.Server;

// static, no-bus configuration endpoints: health, chassis navigation, port
// discovery, and the mined INPA screen layouts.
internal static class ConfigEndpoints
{
    public static void MapConfigEndpoints(this WebApplication app, ServerState state)
    {
        app.MapGet("/api/health", () =>
            Results.Json(new { ok = true, ecuPath = state.EcuPath, hasEcu = Directory.Exists(state.EcuPath) }));

        app.MapGet("/api/chassis", () => Results.Json(state.Config.ChassisIds()));

        app.MapGet("/api/chassis/{id}", (string id) =>
        {
            try
            {
                var ch = state.Config.Load(id.ToUpperInvariant());
                return Results.Json(new
                {
                    id = ch.Id,
                    description = ch.Description,
                    sections = ch.Sections.Select(s => new
                    {
                        key = s.Key,
                        name = s.Name,
                        ecus = s.Ecus.Select(e => new { code = e.Code, label = e.Label, sgbd = e.Sgbd })
                    }),
                    // entry codes sharing one diagnostic address (only one is
                    // installed): lets the whole-vehicle scan skip a group's
                    // siblings once any member answers
                    variantGroups = state.Config.VariantGroups(ch),
                });
            }
            catch (FileNotFoundException) { return Results.NotFound(new { error = $"unknown chassis {id}" }); }
        });

        app.MapGet("/api/port", () => Results.Json(new { port = Paths.AutoDetectPort() }));

        // INPA-faithful screen layout for an ECU, mined from the original .IPO frontend
        // (data/inpa-layouts/enriched/<sgbd>.json). grouped screens: each has driving
        // job/args, render type (analog gauge / digital / value), per-row
        // label/unit/min/max, plus any input-requiring functions. 404 when the ECU isnt
        // mapped (renderer falls back to /menu).
        app.MapGet("/api/ecu/{sgbd}/layout", (string sgbd, string? code) =>
        {
            // enriched layout files are named by INPA code (MS450.json), not SGBD
            // (ms450ds0). try: the code hint, then the SGBD, then SGBD with common
            // suffixes stripped (ds0, ds2, _n). case-insensitive throughout.
            string? file = (code != null ? FindLayoutFile(state.LayoutDir, code) : null)
                           ?? FindLayoutFile(state.LayoutDir, sgbd);
            if (file == null)
            {
                foreach (var suf in new[] { "ds0", "ds2", "ds1", "_n", "ds" })
                    if (sgbd.EndsWith(suf, StringComparison.OrdinalIgnoreCase))
                    {
                        file = FindLayoutFile(state.LayoutDir, sgbd[..^suf.Length]);
                        if (file != null) break;
                    }
            }
            if (file == null)
            {
                // no mined layout: synthesize one from the SGBD itself (.prg
                // _RESULTS descriptions) so every ECU renders out of the box.
                // cached per SGBD — the schema never changes at runtime.
                if (state.PrgLayoutCache.TryGetValue(sgbd, out var cached))
                    return Results.Content(cached, "application/json");
                try
                {
                    return state.Engines.RunOffline(sgbd, diag =>
                    {
                        var layout = PrgLayout.Build(diag, sgbd);
                        var json = System.Text.Json.JsonSerializer.Serialize(layout,
                            new System.Text.Json.JsonSerializerOptions
                            { PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase });
                        state.PrgLayoutCache[sgbd] = json;
                        return Results.Content(json, "application/json");
                    });
                }
                catch (Exception ex)
                {
                    return Results.NotFound(new { error = $"no layout for {sgbd}", raw = ex.Message });
                }
            }
            try
            {
                // serve verbatim, already in the renderer's shape
                var json = File.ReadAllText(file);
                return Results.Content(json, "application/json");
            }
            catch (Exception ex) { return Results.NotFound(new { error = ex.Message }); }
        });
    }

    // find an enriched layout file for an SGBD, base name matched case-insensitively
    // (.IPO files use mixed casing: MSD80, msd80n43, Ms43_sp2).
    private static string? FindLayoutFile(string dir, string sgbd)
    {
        if (!Directory.Exists(dir)) return null;
        string exact = Path.Combine(dir, sgbd + ".json");
        if (File.Exists(exact)) return exact;
        foreach (var f in Directory.EnumerateFiles(dir, "*.json"))
            if (string.Equals(Path.GetFileNameWithoutExtension(f), sgbd, StringComparison.OrdinalIgnoreCase))
                return f;
        return null;
    }
}
