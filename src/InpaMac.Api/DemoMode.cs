using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using EdiabasMac;

namespace InpaMac.Server;

// Synthetic readings for walking the UI with no car attached.
//
// Opt-in only: ?demo=1 on the request, or BMACW_DEMO=1 in the environment.
// Without it a missing cable still fails exactly as before -- a diagnostic tool
// must never invent values that could be mistaken for the car's.
//
// Values come from the SGBD's own _RESULTS schema (the same source the layouts
// use), so every declared result appears with a plausible number for its unit
// and the screens populate as they would on a real read. The response carries
// demo:true so the renderer can badge it.
internal static class DemoMode
{
    public static bool Requested(HttpContext ctx)
    {
        if (ctx.Request.Query.TryGetValue("demo", out var q) &&
            (q == "1" || q == "true")) return true;
        return Environment.GetEnvironmentVariable("BMACW_DEMO") is "1" or "true";
    }

    // unit -> a believable idling-engine value, so gauges sit mid-scale
    private static readonly (Regex Match, Func<int, string> Value)[] Shapes =
    {
        (new(@"\bU/min|1/min|rpm\b", RegexOptions.IgnoreCase), i => (760 + i % 40).ToString()),
        (new(@"°C", RegexOptions.IgnoreCase), i => (82 + i % 8).ToString()),
        (new(@"\bkm/h\b", RegexOptions.IgnoreCase), _ => "0"),
        (new(@"\bV\b"), i => (13.8 + (i % 5) * 0.05).ToString("0.00")),
        (new(@"\bA\b"), i => (2.4 + (i % 7) * 0.1).ToString("0.0")),
        (new(@"%"), i => (12 + i % 70).ToString()),
        (new(@"\bmbar|hPa\b", RegexOptions.IgnoreCase), i => (980 + i % 40).ToString()),
        (new(@"\bbar\b", RegexOptions.IgnoreCase), i => (3.4 + (i % 6) * 0.1).ToString("0.0")),
        (new(@"\bms\b", RegexOptions.IgnoreCase), i => (3.1 + (i % 9) * 0.2).ToString("0.0")),
        (new(@"\bNm\b", RegexOptions.IgnoreCase), i => (40 + i % 60).ToString()),
        (new(@"\bmg/(hub|stk)\b", RegexOptions.IgnoreCase), i => (180 + i % 60).ToString()),
        (new(@"\bohm\b", RegexOptions.IgnoreCase), i => (8 + i % 4).ToString()),
        (new(@"°KW|Kurbelwelle", RegexOptions.IgnoreCase), i => (-20 + i % 40).ToString()),
    };

    // the state words INPA prints for boolean/state results. German, because
    // that is what a real ECU returns -- the renderer translates them, and
    // demo values must exercise that same path rather than bypass it.
    private static readonly string[] States = { "ein", "aus", "aktiv", "bereit", "nicht aktiv" };

    // "0x5B" / "91" -> the plain number an actuator readback would report
    private static string Echo(string arg)
    {
        string s = arg.Split(';')[0].Trim();
        if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
            && int.TryParse(s[2..], System.Globalization.NumberStyles.HexNumber,
                            null, out int hex))
            return hex.ToString();
        return int.TryParse(s, out int n) ? n.ToString() : s;
    }

    public static List<Dictionary<string, string>> Sets(ServerState state, string sgbd, string job,
                                                       string arg = null)
    {
        // A fabricated FAULT is worse than a fabricated gauge reading: it names a
        // component, a mileage and a frequency, and reads exactly like a real DTC
        // the car is reporting. Demo answers fault jobs with a CLEAN memory
        // instead — the honest thing to show when there is no car attached.
        if (job.StartsWith("FS_", StringComparison.OrdinalIgnoreCase))
            return new List<Dictionary<string, string>>
            {
                new() { ["JOB_STATUS"] = "OKAY", ["F_ANZAHL"] = "0" },
            };

        var row = new Dictionary<string, string> { ["JOB_STATUS"] = "OKAY" };
        try
        {
            state.Engines.RunOffline(sgbd, diag =>
            {
                // seed from the job name so two jobs with the same schema don't
                // return identical values (intake vs exhaust). Summed chars, not
                // GetHashCode: that is randomised per process, so the demo would
                // show different numbers on every launch.
                int seed = 0;
                foreach (char ch in job) seed = (seed + ch) % 101;
                int i = seed;
                foreach (var r in diag.Run("_RESULTS", job))
                {
                    if (!r.TryGetValue("RESULT", out var rv) || rv.OpData is not string name
                        || name.Length == 0 || name.StartsWith("_")
                        || name == "JOB_STATUS") continue;   // keep the OKAY above
                    string desc = r.TryGetValue("RESULTCOMMENT0", out var c) && c.OpData is string s ? s : "";
                    // an actuator's readback echoes what was just commanded, so
                    // driving a key visibly moves its gauge instead of sitting at 0
                    row[name] = (arg != null && name.StartsWith("STAT_AUSGANG", StringComparison.Ordinal)
                                 && !name.EndsWith("_EINH", StringComparison.Ordinal)
                                 && !name.EndsWith("_TEXT", StringComparison.Ordinal))
                        ? Echo(arg)
                        : Fake(name, desc, i++);
                }
                return Results.Ok();
            });
        }
        catch { /* no schema: the caller still gets JOB_STATUS */ }
        return new List<Dictionary<string, string>> { row };
    }

    private static string Fake(string name, string desc, int i)
    {
        // _TEXT / _EINH carriers read as words, not numbers
        if (Regex.IsMatch(name, @"_TEXT\d*$", RegexOptions.IgnoreCase))
            return States[i % States.Length];
        if (Regex.IsMatch(name, @"_EINH\d*$", RegexOptions.IgnoreCase))
            return "%";
        foreach (var (match, value) in Shapes)
            if (match.IsMatch(desc) || match.IsMatch(name))
                return value(i);
        // a described on/off bit reads as a state word
        if (Regex.IsMatch(desc, @"\b0=|1=|Statusbit|aktiv|bereit\b", RegexOptions.IgnoreCase))
            return States[i % States.Length];
        // ...and so does one the NAME declares boolean. A coding flag answers
        // yes/no: DWA4's NEIGUNGSGEBER_VERBAUT ("with tilt alarm sensor") came
        // back as 34 and drew a bar, because its description says nothing.
        if (Regex.IsMatch(name, @"(_VERBAUT|_EIN|_AUS|_AKTIV|_INAKTIV|_MOEGLICH"
                              + @"|_VORHANDEN|_OFFEN|_GESCHLOSSEN|_GEDRUECKT"
                              + @"|_BETAETIGT|_GELOEST|_ERKANNT|_OK)\d*$",
                          RegexOptions.IgnoreCase))
            return (i % 2) == 0 ? "ja" : "nein";
        // the description often states the valid span ("Werte -48 bis 48"):
        // sit inside it so the gauge lands mid-scale instead of pinned at 0
        var span = Regex.Match(desc, @"(-?\d+)\s*bis\s*(-?\d+)");
        if (span.Success
            && int.TryParse(span.Groups[1].Value, out int lo)
            && int.TryParse(span.Groups[2].Value, out int hi))
        {
            if (lo > hi) (lo, hi) = (hi, lo);
            return (lo + (hi - lo) * (30 + i % 40) / 100).ToString();
        }
        return (i % 100).ToString();
    }
}
