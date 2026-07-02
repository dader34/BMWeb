using System.Collections.Generic;
using System.Linq;

namespace EdiabasMac;

// FS_LESEN fault-memory parsing shared by the server and CLI front-ends
public static class FaultReader
{
    // FS_LESEN result is "set 0 = status" then one set per fault. keep only sets
    // carrying a fault id (F_ORT_NR/F_HEX_CODE); the trailing summary set has neither.
    public static List<Dictionary<string, string>> ReadFaults(Diag diag, string sgbd)
    {
        diag.Load(sgbd);
        var sets = diag.Run("FS_LESEN");
        var codes = new List<Dictionary<string, string>>();
        for (int i = 1; i < sets.Count; i++)
        {
            var row = sets[i].ToDictionary(kv => kv.Key, kv => Diag.Format(kv.Value));
            if (row.ContainsKey("F_ORT_NR") || row.ContainsKey("F_HEX_CODE"))
                codes.Add(row);
        }
        return codes;
    }

    // a fault whose location text is the SGBD's "unknown location" placeholder is
    // unlabeled; a sibling SGBD variant may name it.
    public static bool IsUnknownLocation(Dictionary<string, string> f) =>
        f.TryGetValue("F_ORT_TEXT", out var t) && t != null &&
        t.Replace(" ", "").ToLowerInvariant().Contains("unbekannter");
}
