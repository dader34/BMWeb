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

    // live read that prefers the ECU's diagnostic-address group SGBD (D_00xx.grp):
    // loading the group makes EDIABAS run IDENTIFIKATION and select the exact variant,
    // so fault text is correct even when the offline SGBD guess was wrong (e.g. the
    // E46 IHKA guesses ihka38 but the group identifies ihka46_3). Because the group
    // already picks the right variant, no sibling-variant merge is needed. Falls back
    // to the concrete SGBD + merge when there's no group or it can't identify (no
    // cable, ECU didn't answer, group unsupported) so it never regresses.
    public static List<Dictionary<string, string>> ReadFaultsAuto(
        Diag diag, string sgbd, string group, IReadOnlyList<string> variants)
    {
        if (!string.IsNullOrEmpty(group))
        {
            try { return ReadFaults(diag, group); }
            catch { /* fall through to the concrete-variant path */ }
        }
        return ReadFaultsMerged(diag, sgbd, variants);
    }

    // read fault memory, then fill in any "unknown location" faults from sibling
    // SGBD variants. if the primary SGBD left a fault unlabeled (e.g. zke5), a
    // variant (zke5_s12) may name it, so read the siblings only when needed and
    // only replace the unknown entries. `variants` is the ordered variant list
    // for `sgbd` (variants[0] is the primary); pass InpaConfig.SgbdVariants(sgbd).
    // shared by the server and CLI so both front-ends label faults identically.
    public static List<Dictionary<string, string>> ReadFaultsMerged(
        Diag diag, string sgbd, IReadOnlyList<string> variants)
    {
        var codes = ReadFaults(diag, sgbd);
        if (variants == null || variants.Count <= 1 || !codes.Any(IsUnknownLocation))
            return codes;

        foreach (var v in variants.Skip(1))
        {
            if (!codes.Any(IsUnknownLocation)) break;
            List<Dictionary<string, string>> alt;
            try { alt = ReadFaults(diag, v); } catch { continue; }
            foreach (var f in codes.Where(IsUnknownLocation).ToList())
            {
                if (!f.TryGetValue("F_ORT_NR", out var nr)) continue;
                var better = alt.FirstOrDefault(a =>
                    a.TryGetValue("F_ORT_NR", out var anr) && anr == nr && !IsUnknownLocation(a));
                if (better != null)
                {
                    int idx = codes.IndexOf(f);
                    codes[idx] = better; // keep the labeled variant's entry
                }
            }
        }
        return codes;
    }

    // a fault whose location text is the SGBD's "unknown location" placeholder is
    // unlabeled; a sibling SGBD variant may name it.
    public static bool IsUnknownLocation(Dictionary<string, string> f) =>
        f.TryGetValue("F_ORT_TEXT", out var t) && t != null &&
        t.Replace(" ", "").ToLowerInvariant().Contains("unbekannter");
}
