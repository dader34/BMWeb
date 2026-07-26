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
                        ecus = s.Ecus.Select(e => new { code = e.Code, label = e.Label, sgbd = e.Sgbd, group = e.Group })
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
            // then the auto-generated screens (tools/ipo_enrich.py): INPA's own
            // captions decoded from the .IPO, joined with the SGBD's job
            // schemas. Hand-enriched layouts above always win — this only fills
            // in ECUs nobody has gone through by hand yet.
            if (file == null)
            {
                file = (code != null
                            ? FindLayoutFile(state.GeneratedLayoutDir, code)
                            : null)
                       ?? FindLayoutFile(state.GeneratedLayoutDir, sgbd);
                if (file == null)
                    foreach (var suf in new[] { "ds0", "ds2", "ds1", "_n", "ds" })
                        if (sgbd.EndsWith(suf, StringComparison.OrdinalIgnoreCase))
                        {
                            file = FindLayoutFile(state.GeneratedLayoutDir,
                                                  sgbd[..^suf.Length]);
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
                // already in the renderer's shape. If this is a hand-built
                // layout, fold in any generated section it does not define:
                // most hand files were mined for gauges and carry no identity
                // block, and serving them verbatim would drop a screen we can
                // otherwise show. Hand-built sections are never overwritten.
                var json = File.ReadAllText(file);
                if (!file.StartsWith(state.GeneratedLayoutDir, StringComparison.Ordinal))
                    json = MergeGeneratedSections(state, json, sgbd, code);
                return Results.Content(json, "application/json");
            }
            catch (Exception ex) { return Results.NotFound(new { error = ex.Message }); }
        });
    }

    // sections the generator produces; each is filled in only when the
    // hand-built layout has nothing for it.
    private static readonly string[] GeneratedSections = { "identity", "aif", "activateMenus", "activateState", "rootMenu" };

    // Fold generated sections into a hand-built layout without touching what
    // the hand-built file already defines.
    private static string MergeGeneratedSections(ServerState state, string handJson,
                                                 string sgbd, string? code)
    {
        string? gen = (code != null ? FindLayoutFile(state.GeneratedLayoutDir, code) : null)
                      ?? FindLayoutFile(state.GeneratedLayoutDir, sgbd);
        if (gen == null)
            foreach (var suf in new[] { "ds0", "ds2", "ds1", "_n", "ds" })
                if (sgbd.EndsWith(suf, StringComparison.OrdinalIgnoreCase))
                {
                    gen = FindLayoutFile(state.GeneratedLayoutDir, sgbd[..^suf.Length]);
                    if (gen != null) break;
                }
        if (gen == null) return handJson;

        try
        {
            using var handDoc = System.Text.Json.JsonDocument.Parse(handJson);
            using var genDoc = System.Text.Json.JsonDocument.Parse(File.ReadAllText(gen));
            if (handDoc.RootElement.ValueKind != System.Text.Json.JsonValueKind.Object)
                return handJson;

            var missing = GeneratedSections
                .Where(s => !handDoc.RootElement.TryGetProperty(s, out _)
                            && genDoc.RootElement.TryGetProperty(s, out _))
                .ToList();
            if (missing.Count == 0) return handJson;

            using var buf = new MemoryStream();
            using (var w = new System.Text.Json.Utf8JsonWriter(buf))
            {
                w.WriteStartObject();
                foreach (var p in handDoc.RootElement.EnumerateObject())
                    p.WriteTo(w);
                foreach (var s in missing)
                {
                    w.WritePropertyName(s);
                    genDoc.RootElement.GetProperty(s).WriteTo(w);
                }
                w.WriteEndObject();
            }
            return System.Text.Encoding.UTF8.GetString(buf.ToArray());
        }
        catch { return handJson; }   // malformed either side: serve the hand file
    }

    // find an enriched layout file for an SGBD, base name matched case-insensitively
    // (.IPO files use mixed casing: MSD80, msd80n43, Ms43_sp2). `sgbd` reaches here
    // from the route and the ?code= query, so it must stay a bare file name — a
    // separator or ".." would let Path.Combine escape the layout directory.
    private static string? FindLayoutFile(string dir, string sgbd)
    {
        if (!Directory.Exists(dir)) return null;
        if (string.IsNullOrEmpty(sgbd) || sgbd.Contains("..") ||
            sgbd.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) return null;
        string exact = Path.Combine(dir, sgbd + ".json");
        if (File.Exists(exact)) return exact;
        foreach (var f in Directory.EnumerateFiles(dir, "*.json"))
            if (string.Equals(Path.GetFileNameWithoutExtension(f), sgbd, StringComparison.OrdinalIgnoreCase))
                return f;
        return null;
    }
}
