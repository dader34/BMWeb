using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;

namespace EdiabasMac;

// Actuator (STEUERN_) names mined from the INPA .IPO frontends by
// tools/steuern_layout.py -> data/steuern-labels.json.
//
// MenuGen.Translate builds a name from the job's own tokens, which guesses
// badly on the abbreviations these jobs use (STEUERN_TEV, STEUERN_VIMDISA).
// INPA's real caption for the actuator is better, so prefer it where the mine
// found one and fall back to the token table otherwise.
public static class SteuernLabels
{
    // sgbd (lower) -> job -> label. Loaded once; the file ships with the app.
    private static Dictionary<string, Dictionary<string, string>> s_map;
    private static readonly object s_lock = new();

    private static Dictionary<string, Dictionary<string, string>> Map(string root)
    {
        lock (s_lock)
        {
            if (s_map != null) return s_map;
            s_map = new(StringComparer.OrdinalIgnoreCase);
            try
            {
                string file = Path.Combine(root, "data", "steuern-labels.json");
                if (File.Exists(file))
                {
                    using var doc = JsonDocument.Parse(File.ReadAllText(file));
                    foreach (var ecu in doc.RootElement.EnumerateObject())
                    {
                        var jobs = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                        foreach (var job in ecu.Value.EnumerateObject())
                            if (job.Value.TryGetProperty("label", out var lab)
                                && lab.GetString() is string s && s.Length > 0)
                                jobs[job.Name] = s;
                        s_map[ecu.Name] = jobs;
                    }
                }
            }
            catch { /* no mined labels: MenuGen.Translate still names every job */ }
            return s_map;
        }
    }

    // the .IPO is named by INPA code (MS450), the SGBD by file (ms450ds0), so
    // try the SGBD then its common suffix-stripped stems
    public static string For(string root, string sgbd, string job)
    {
        var map = Map(root);
        if (map.Count == 0 || string.IsNullOrEmpty(sgbd)) return null;
        foreach (string key in Stems(sgbd))
            if (map.TryGetValue(key, out var jobs) && jobs.TryGetValue(job, out var label))
                return label;
        return null;
    }

    private static IEnumerable<string> Stems(string sgbd)
    {
        yield return sgbd;
        foreach (string suf in new[] { "ds0", "ds2", "ds1", "_n", "ds" })
            if (sgbd.EndsWith(suf, StringComparison.OrdinalIgnoreCase))
                yield return sgbd[..^suf.Length];
    }
}
