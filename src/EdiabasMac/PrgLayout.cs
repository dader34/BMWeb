using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

namespace EdiabasMac;

// Synthesize a screen layout for an ECU straight from its SGBD (.prg): the
// third layout tier after mined .ips source and .IPO scrapes. Every ECU has a
// .prg by definition, so this makes every ECU render out of the box.
//
// The SGBD's description segment (read offline via the _RESULTS pseudo-job)
// carries per-result German descriptions as BMW authored them; each
// measurement job becomes one screen whose rows pair result keys with those
// labels (units parsed from a trailing "[...]" in the comment). No ranges
// exist in a .prg — the renderer's unit heuristic supplies them — and there
// are no menus (that is frontend data, not protocol data).
public static class PrgLayout
{
    public sealed record Row(string Key, string? Label, string? Unit);
    public sealed record Screen(string? Group, string Job, string? Args,
                                string Render, int Columns, string Method,
                                IReadOnlyList<Row> Rows);
    public sealed record Layout(string Source, string Format, string Parser,
                                IReadOnlyList<Screen> Screens,
                                IReadOnlyList<object> Menus,
                                IReadOnlyList<object> Inputs);

    // NEVER pollable from a gauge screen: anything that writes, erases,
    // flashes, codes, actuates, or changes session/protocol state. layout
    // screens are auto-polled live, so exclusion is a safety boundary, not
    // a cosmetic filter.
    private static readonly Regex DangerJob = new(
        @"SCHREIBEN|LOESCHEN|PROGRAMMIER|FLASH|RESET|STEUERN|CODIER|SETZEN|"
        + @"INITIALISIER|ANPASS|ABGLEICH_(PROG|RESET)|_ENDE$|ENABLE|DISABLE|"
        + @"AUTHENTISIERUNG|BAUDRATE|KONFIG|LERN|SPERREN|FREISCHALT|"
        + @"NORMALER_DATENVERKEHR|DIAGNOSE|TEL_|MARK_|_EIN$|_AUS$|^UPROG",
        RegexOptions.IgnoreCase);

    // classic measurement names get a screen even without _WERT-style keys
    private static readonly Regex MeasurementJob = new(
        @"^(STATUS($|_)|MESSWERT|MW_|LESE_STATUS)", RegexOptions.IgnoreCase);

    // a value-carrying result key: STAT_X_WERT, ABGLEICH_..._WERT, ...
    private static readonly Regex ValueKey = new(
        @"_WERT$|^STAT_", RegexOptions.IgnoreCase);

    // trailing bracketed unit in a result comment: "Motortemperatur [°C]"
    private static readonly Regex UnitInComment = new(@"\[([^\]]*)\]\s*$");

    // engine bookkeeping results that are not measurements
    private static readonly HashSet<string> SkipResults =
        new(StringComparer.OrdinalIgnoreCase) { "JOB_STATUS" };

    public static Layout Build(Diag diag, string sgbd)
    {
        diag.Load(sgbd);
        var screens = new List<Screen>();
        foreach (string job in diag.Jobs())
        {
            if (job.StartsWith("_") || DangerJob.IsMatch(job))
                continue;
            bool namedMeasurement = MeasurementJob.IsMatch(job);
            // jobs with declared arguments can't be polled blind (the right
            // args live in .ips/.IPO layouts, not in the .prg schema)
            if (RequiresArguments(diag, job))
                continue;
            var rows = RowsOf(diag, job);
            if (rows.Count == 0)
                continue;
            // non-STATUS-named jobs qualify only when their results actually
            // look like values (else IDENT/serial-number jobs become gauges)
            if (!namedMeasurement && !rows.Any(r => ValueKey.IsMatch(r.Key)))
                continue;
            screens.Add(new Screen(Group: null, Job: job, Args: null,
                                   Render: "analog", Columns: 1,
                                   Method: "prg-results", Rows: rows));
        }
        return new Layout(Source: sgbd + ".prg", Format: "prg",
                          Parser: "prg-layout/1.0", Screens: screens,
                          Menus: Array.Empty<object>(),
                          Inputs: Array.Empty<object>());
    }

    // does the job declare required arguments? (offline _ARGUMENTS pseudo-job)
    private static bool RequiresArguments(Diag diag, string job)
    {
        foreach (var set in diag.Run("_ARGUMENTS", job))
            if (set.TryGetValue("ARG", out var a) && a.OpData is string s
                && s.Length > 0)
                return true;
        return false;
    }

    // rows for one job from its _RESULTS schema. *_EINH results are unit
    // companions (merged at read time), and *_TEXT is skipped only when its
    // *_WERT sibling exists — on DS2 ECUs _TEXT is often the only readout.
    private static List<Row> RowsOf(Diag diag, string job)
    {
        var entries = new List<(string Name, string? Comment)>();
        foreach (var set in diag.Run("_RESULTS", job))
        {
            if (!(set.TryGetValue("RESULT", out var r) && r.OpData is string name)
                || name.Length == 0 || SkipResults.Contains(name)
                || name.StartsWith("_"))   // _TEL_* raw-telegram bookkeeping
                continue;
            string? comment = set.TryGetValue("RESULTCOMMENT0", out var c)
                              && c.OpData is string sc && sc.Trim().Length > 0
                ? sc.Trim() : null;
            entries.Add((name, comment));
        }

        var names = new HashSet<string>(entries.Select(e => e.Name),
                                        StringComparer.OrdinalIgnoreCase);
        var rows = new List<Row>();
        foreach (var (name, comment) in entries)
        {
            if (name.EndsWith("_EINH", StringComparison.OrdinalIgnoreCase))
                continue;
            if (name.EndsWith("_TEXT", StringComparison.OrdinalIgnoreCase)
                && names.Contains(name[..^5] + "_WERT"))
                continue;

            string? label = comment, unit = null;
            if (comment != null)
            {
                var m = UnitInComment.Match(comment);
                if (m.Success)
                {
                    string u = m.Groups[1].Value.Trim();
                    unit = (u.Length == 0 || u == "-") ? null : u;
                    label = UnitInComment.Replace(comment, "").Trim();
                    if (label.Length == 0) label = null;
                }
            }
            rows.Add(new Row(name, label, unit));
        }
        return rows;
    }
}
