using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;

namespace EdiabasMac;

// raw EDIABAS job list -> English INPA-style functional menu.
// mirrors tools/menugen.py.
public sealed record MenuItem(string Job, string Label, bool Danger);
public sealed record MenuSection(string Section, List<MenuItem> Items);

public static class MenuGen
{
    static readonly HashSet<string> System = new(StringComparer.OrdinalIgnoreCase)
    {
        "_JOBS","_JOBCOMMENTS","_ARGUMENTS","_RESULTS","_VERSIONINFO","_TABLES","_TABLE",
        "INITIALISIERUNG","ENDE","NORMALER_DATENVERKEHR","DIAGNOSE_AUFRECHT",
        "DIAGNOSE_MODE","DIAGNOSE_ENDE","SENDE_TELEGRAMM",
    };

    static readonly Dictionary<string, string> Curated = new(StringComparer.OrdinalIgnoreCase)
    {
        ["FS_LESEN"] = "Read fault codes",
        ["FS_LESEN_DETAIL"] = "Read fault codes (detailed)",
        ["FS_LESEN_HEX"] = "Read fault codes (hex)",
        ["FS_LESEN_FREEZE_FRAME"] = "Read fault codes (freeze frame)",
        ["FS_LOESCHEN"] = "Clear fault codes",
        ["IDENT"] = "Identify ECU",
        ["INFO"] = "ECU info",
        ["SERIENNUMMER_LESEN"] = "Read serial number",
        ["STATUS_LESEN"] = "Read status",
        ["CBS_DATEN_LESEN"] = "Read CBS service data",
        ["CBS_RESET"] = "Reset CBS service",
        ["STEUERGERAETE_RESET"] = "Reset ECU",
        ["STATUS_OBD"] = "OBD status",
        // immobilizer sync: NOT an actuator test — drives the DME<->EWS/CAS
        // rolling-code handshake. INPA labels it "EWS/CAS-Startwertabgleich".
        ["STEUERN_SYNC_MODE"] = "EWS/CAS sync (immobilizer)",
        ["STATUS_SYNC_MODE"] = "EWS/CAS sync status",
        // CO idle-mixture adjustment: live trim, then permanent store
        ["STEUERN_CO_ABGLEICH_VERSTELL"] = "CO idle mixture: adjust",
        ["STEUERN_CO_ABGLEICH_PROGRAMMIEREN"] = "CO idle mixture: save (program)",
        ["STEUERN_LLABG_PROG"] = "Idle adjustment: save (program)",
        // electric radiator fan (Elektrolüfter) vs STEUERN_EBL "E-Box Fan"
        ["STEUERN_E_LUEFTER"] = "Radiator Fan",
    };

    // jobs that do something far more consequential than a normal actuator
    // test (immobilizer re-sync, security seed) — the UI must warn harder than
    // the generic "drives a component" confirm.
    static readonly HashSet<string> Critical =
        new(StringComparer.OrdinalIgnoreCase) { "STEUERN_SYNC_MODE" };

    public static bool IsCritical(string job) => Critical.Contains(job);

    // German token -> English. core verbs/nouns here; extended at startup from
    // tools/translations/*_tokens.tsv so labels change without a rebuild.
    static readonly Dictionary<string, string> Tokens = LoadTokens(new()
    {
        ["LESEN"]="Read",["SCHREIBEN"]="Write",["LOESCHEN"]="Clear",["SETZEN"]="Set",
        ["STATUS"]="Status",["STEUERN"]="Activate",["STELLGLIED"]="Actuator",["TEST"]="Test",
        ["FEHLER"]="Fault",["FS"]="Fault",["MOTOR"]="Engine",["DREHZAHL"]="RPM",
        ["TEMPERATUR"]="Temperature",["TEMP"]="Temp",["DRUCK"]="Pressure",["SPANNUNG"]="Voltage",
        ["LAMBDA"]="Lambda",["GEMISCH"]="Mixture",["ZUENDUNG"]="Ignition",["EINSPRITZUNG"]="Injection",
        ["KRAFTSTOFF"]="Fuel",["LUFT"]="Air",["ABGAS"]="Exhaust",["KAT"]="Catalyst",
        ["KUEHLMITTEL"]="Coolant",["OEL"]="Oil",["GANG"]="Gear",["GETRIEBE"]="Transmission",
        ["SERIENNUMMER"]="Serial number",["NUMMER"]="Number",["NR"]="number",
        ["HARDWARE"]="Hardware",["SOFTWARE"]="Software",["VERSION"]="Version",["DATEN"]="Data",
        ["REFERENZ"]="Reference",["PHYSIKALISCHE"]="Physical",
        ["FLASH"]="Flash",["PROGRAMMIER"]="Programming",["SIGNATUR"]="Signature",
        ["AUTHENTISIERUNG"]="Authentication",["ZUFALLSZAHL"]="Random number",["START"]="Start",
        ["ADRESSE"]="Address",["SPEICHER"]="Memory",["ZEITEN"]="Times",["ZEIT"]="Time",
        ["PARAMETER"]="Parameter",["BAUDRATE"]="Baud rate",["RESET"]="Reset",["MODE"]="Mode",
        ["VARIANTE"]="Variant",["PRUEFSTEMPEL"]="Inspection stamp",["PRUEFCODE"]="Test code",
        ["BACKUP"]="Backup",["READINESS"]="Readiness",["SYSTEMCHECK"]="System check",
        ["SEK"]="Secondary",["TEV"]="Purge valve",["FGR"]="Cruise control",["SPERREN"]="Lock",
        // body-module abbreviations: "IB" is Innenbeleuchtung, and "Ib Off" is
        // not a phrase anyone recognises
        ["IB"]="Interior lighting",["AUS"]="off",["EIN"]="on",["ZV"]="Central locking",
        ["FH"]="Window",["WIWA"]="Wipe/wash",["DWA"]="Anti-theft",["SHD"]="Sunroof",
        ["EINGRIFF"]="Intervention",["EINGRIFFE"]="Interventions",["ANZAHL"]="Count",
        ["ZAEHLER"]="Counter",["MAX"]="Max",["BETRIEB"]="Operation",
    });

    // merge every tools/translations/*_tokens.tsv (TOKEN<TAB>English) into baseDict
    static Dictionary<string, string> LoadTokens(Dictionary<string, string> baseDict)
    {
        try
        {
            string dir = FindTranslationsDir();
            if (dir != null)
                foreach (var file in Directory.EnumerateFiles(dir, "*_tokens.tsv"))
                    foreach (var line in File.ReadLines(file))
                    {
                        int tab = line.IndexOf('\t');
                        if (tab <= 0) continue;
                        string tok = line[..tab].Trim();
                        string eng = line[(tab + 1)..].Trim();
                        if (tok.Length > 0 && eng.Length > 0) baseDict[tok] = eng;
                    }
        }
        catch { /* base dict only */ }
        return baseDict;
    }

    static string FindTranslationsDir()
    {
        // resolve against the same root as the rest of the data (repo tree in
        // dev, Contents/Resources/data in the packaged app) — the data lives
        // beside MacOS/, not above it, so a plain parent-walk misses it.
        string cand = Path.Combine(Paths.FindRepoRoot(), "tools", "translations");
        if (Directory.Exists(cand)) return cand;
        // fallback: parent-walk (covers odd layouts)
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            string c = Path.Combine(dir.FullName, "tools", "translations");
            if (Directory.Exists(c)) return c;
            dir = dir.Parent;
        }
        return null;
    }

    static readonly string[] Order = { "Faults","Status","Activations","System Check","Coding","Identity","AIF","Adaption","Service","Special","Other" };
    static readonly Regex Danger = new(@"FLASH|LOESCHEN|SCHREIBEN|RESET|AUTHENTISIERUNG|PROGRAMMIER|BAUDRATE|_SETZEN|STEUERN(?!\w*LESEN)|STELLGLIED", RegexOptions.IgnoreCase);
    // suffix verbs moved to front of label
    static readonly Dictionary<string,string> FrontVerb = new(StringComparer.OrdinalIgnoreCase)
        { ["LESEN"]="Read", ["SCHREIBEN"]="Write", ["LOESCHEN"]="Clear", ["SETZEN"]="Set" };

    static string SectionFor(string job)
    {
        string j = job.ToUpperInvariant();
        if (j.StartsWith("FS_") || j.Contains("FEHLER")) return "Faults";
        if (j is "IDENT" or "INFO" or "SERIENNUMMER_LESEN" || j.StartsWith("IDENT")) return "Identity";
        if (j.Contains("VERSION") || j.Contains("HARDWARE") || j.Contains("REFERENZ") || j.Contains("_HW_")) return "Identity";
        if (j.StartsWith("STATUS") || j.StartsWith("MW_") || j.Contains("MESSWERT")) return "Status";
        // STEUERN_WERT_LESEN and friends read the current activation value:
        // read jobs, not actuator tests
        if (j.StartsWith("STEUERN") && j.Contains("LESEN")) return "Status";
        if (j.StartsWith("STEUERN") || j.Contains("STELLGLIED") || j.Contains("AUSGAENGE_SCHALTEN")) return "Activations";
        // Flash/authentication jobs are deliberately NOT a menu section: INPA
        // has no flash screen (MS450.IPO's only "FLASH" string is the EXT-FLASH
        // memory REGION on the Speicher screen), and these are raw primitives
        // that are only safe inside the seed/key sequence the Flashing tool
        // drives. Listing them as buttons would offer erase/write out of order.
        if (j.Contains("FLASH") || j.Contains("PROGRAMMIER") || j.Contains("AUTHENTISIERUNG") || j.Contains("SIGNATUR")) return null;
        // INPA has no generic "Other": every job lives in a named menu. split the
        // former catch-all into INPA's submenus (System-Check, Codierung, Ident,
        // Service-Funktionen, Sonderfunktionen).
        if (j.Contains("SYSTEMCHECK")) return "System Check";
        if (j.Contains("CODIER") || j.Contains("ECU_CONFIG") || j.Contains("SET_PARAMETER")
            || j.Contains("BAUDRATE") || j.Contains("INTERFACETYPE") || j.Contains("ACCESS_TIMING")) return "Coding";
        // INPA gives the user-information field its own root key (F3 "AIF"),
        // separate from Ident (F2): it is a programming LOG, not ECU identity.
        if (j.Contains("AIF")) return "AIF";
        if (j.Contains("ZIF") || j.Contains("PRUEFCODE")
            || j.Contains("C_CI") || j.Contains("C_FG") || j.Contains("C_C_")) return "Identity";
        if (j.Contains("EWS") || j.Contains("DISTANCE_MIL") || j.StartsWith("SPEICHER")) return "Special";
        // INPA gives adaptation clearing its own root key (F8 "Adaption"):
        // it erases what the DME has learned, which is not a service read.
        if (j.Contains("ADAP")) return "Adaption";
        if (j.Contains("CBS") || j.Contains("PRUEFSTEMPEL") || j.Contains("PRUEFFLAG")
            || j.Contains("DIAGNOSEPROTOKOLL")
            || j.Contains("RESET") || j.Contains("STARTWERT") || j.Contains("SLEEP")
            || j.Contains("INNENTEMP")) return "Service";

        // E36/early-E46 engine and body ECUs expose many DS1/DS2-era jobs the rules
        // above miss. route them into INPA's named submenus (verified against the
        // a_smot/a_dmot frontends and the .prg job sets) so nothing lands in "Other".

        // self-tests, actuator/sensor diagnostics, ABS/DSC bleeding + pressure
        // build/hold cycles, hydraulic/pump tests, simulations -> System-Check.
        if (j.Contains("SELBSTTEST") || j.Contains("PRUEFLAUF") || j.Contains("IO_STATUS")
            || j.Contains("I_O_DIAGNOSE") || j.StartsWith("TEST_") || j.Contains("TESTPRG")
            || j.Contains("TEST_PRG") || j.Contains("SIMULATION") || j.Contains("_SIM_")
            || j.Contains("SIM_HA") || j.Contains("EINSPURMODELL") || j.Contains("MCS_AKTIVIEREN")
            || j.Contains("DISPLAYTEST") || j.Contains("DISPLAY_TEST") || j.StartsWith("DOWNLOAD_")
            || j.Contains("DRUCKABBAU") || j.Contains("DRUCKAUFBAU") || j.Contains("DRUCKHALTEN")
            || j.Contains("PUMPEN") || j.Contains("ENTLUEFTUNG") || j.Contains("BLEEDMASTER")
            || j.Contains("VAKUUM") || j.Contains("FUEHLER") || j.Contains("ANFAHREN_POSITION")
            || j.Contains("MOTOR_FAHREN") || j.Contains("TIPP_FUNKTION") || j.Contains("TANK_LECK")
            || j.Contains("CRASH_AUSLOESEN") || j.Contains("EICHLAUF")) return "System Check";

        // variant/equipment/vehicle-data coding -> Coding.
        if (j.StartsWith("COD_") || j.StartsWith("COD") && j.Contains("LESEN") || j.Contains("KODIER")
            || j.Contains("VAR_COD") || j.Contains("EMK_COD") || j.Contains("AGR_COD")
            || j.Contains("AUSSTATTUNG") || j.Contains("KFZ_DATEN") || j.Contains("PARAMETERSATZ")
            || j.Contains("ZCS") || j.Contains("DATENSATZNUMMER") || j.Contains("FAKTOR_SCHREIBEN")
            || j.Contains("TRIG_SCHREIBEN")) return "Coding";

        // production/identification data, counters, system-address + KD reads -> Identity.
        if (j.Contains("PROD_NR") || j.Contains("BMW_NR") || j.Contains("FG_NR") || j.Contains("FGNR")
            || j.Contains("HERSTELLDAT") || j.Contains("HERSTELLDATEN") || j.Contains("HERSTELLERDATEN")
            || j.Contains("HERSTELLER_DATEN") || j.Contains("TYP_LESEN") || j.Contains("ZAEHLERSTAENDE")
            || j.Contains("SYS_ADR") || j.Contains("SYSTEM_ADRESSEN") || j.Contains("MAX_BLOCK")
            || j.Contains("KD_DATEN") || j.Contains("KD_INIT") || j.Contains("ZUSTAND_LESEN")
            || j.Contains("ZCS_LESEN")) return "Identity";

        // memory dumps, immobilizer ISN, security access (login/seed/password),
        // rolling code + key data, function/lock state -> Special.
        if (j.StartsWith("RAM_") || j.StartsWith("ROM_") || j.Contains("EEPROM") || j.Contains("ISN")
            || j.Contains("SEED") || j.Contains("LOGIN") || j.Contains("PASSWORT")
            || j.Contains("WECHSELCODE") || j.Contains("SCHLUESSEL") || j.StartsWith("SCHL_")
            || j.Contains("INFOSPEICHER") || j == "IS_LESEN" || j.Contains("FUNKTIONSSPERRE")
            || j.Contains("VERRIEGELUNG") || j.Contains("INIT_SPERRE")) return "Special";

        // adaptation clears, CO/idle/consumption adjustment, programming-voltage,
        // battery messages, diagnostic-session control, end-of-line -> Service.
        if (j.Contains("ADAPT") || j.Contains("ABGLEICH") || j.Contains("ABGAS_VARIANTE")
            || j.Contains("UPROG") || j.Contains("MESSE_VERSTELLZEIT") || j.Contains("BATTERIE_MELDUNG")
            || j.Contains("DIAGNOSE_") || j.Contains("DIAGNOSTICEND") || j.Contains("START_BUS")
            || j.StartsWith("BET_") || j.Contains("RPA_EOL") || j.EndsWith("_LOESCHEN")) return "Service";

        // raw OBD-II mode readouts + transparent/raw access, ADC + parameter reads -> Status.
        if (j.Contains("_MODE") || j.Contains("_REQ") || j.Contains("RAWMODE")
            || j.Contains("TRANSPARENT") || j.Contains("ADC_LESEN") || j == "PARAMETER_LESEN")
            return "Status";

        return "Other";
    }

    static string Translate(string job)
    {
        if (Curated.TryGetValue(job, out var c)) return c;
        var parts = job.Split('_', StringSplitOptions.RemoveEmptyEntries).ToList();
        // trailing Read/Write/Clear/Set verb moves to front
        string front = null;
        if (parts.Count > 1 && FrontVerb.TryGetValue(parts[^1], out var fv)) { front = fv; parts.RemoveAt(parts.Count - 1); }
        var words = parts.Select(p => Tokens.TryGetValue(p, out var t) ? t
                                     : (p.All(char.IsLetter) ? char.ToUpperInvariant(p[0]) + p[1..].ToLowerInvariant() : p));
        string body = string.Join(" ", words);
        return front != null ? $"{front} {body.ToLowerInvariant()}" : body;
    }

    // actuator test: start job plus optional paired stop (_ENDE) job
    // `Args` are the argument names the SGBD declares for the start job, and
    // `Runnable` is false when we cannot supply them. A job like
    // STEUERN_DIGITAL takes ORT ("gewuenschte Komponente", from a BITS table)
    // and EIN (1/0): firing it with no ORT tells the ECU nothing about what to
    // drive. The UI must not offer a button that looks like it works.
    public sealed record ArgOption(string Value, string Label);
    public sealed record ArgSpec(string Name, string Type, List<ArgOption> Options);
    public sealed record Activation(string Label, string Start, string Stop, bool Momentary,
                                    bool Critical, List<ArgSpec> Args, bool Runnable);

    // actuator start/stop conventions differ per DME generation: MS45 pairs
    // STEUERN_X with STEUERN_X_ENDE, MS42/MS43/ME9 use STEUERN_X_AUS, and some
    // outputs have no stop job at all but take a settable value argument
    // (ON, PWM, duty cycle) where sending 0 de-energizes. all three shapes are
    // derived here instead of hard-coding per ECU.
    private static readonly string[] StopSuffixes = { "_ENDE", "_AUS", "_STOP" };

    public static List<Activation> Activations(Diag diag)
    {
        var all = diag.Jobs()
            .Where(j => (j.StartsWith("STEUERN", StringComparison.OrdinalIgnoreCase)
                         || j.Contains("STELLGLIED", StringComparison.OrdinalIgnoreCase))
                        && !j.Contains("LESEN", StringComparison.OrdinalIgnoreCase)) // reads are status
            .ToList();
        var set = new HashSet<string>(all, StringComparer.OrdinalIgnoreCase);
        // a stop job names its start by suffix (X_ENDE / X_AUS / X_STOP) or by
        // the DDE prefix convention (STEUERN_ENDE_X stops STEUERN_X)
        static string? PrefixStart(string j) =>
            j.StartsWith("STEUERN_ENDE_", StringComparison.OrdinalIgnoreCase)
                ? "STEUERN_" + j["STEUERN_ENDE_".Length..] : null;
        var stops = new HashSet<string>(
            all.Where(j => StopSuffixes.Any(suf =>
                               j.EndsWith(suf, StringComparison.OrdinalIgnoreCase)
                               && set.Contains(j[..^suf.Length]))
                           || (PrefixStart(j) is string ps && set.Contains(ps))),
            StringComparer.OrdinalIgnoreCase);
        var result = new List<Activation>();
        foreach (var job in all)
        {
            if (stops.Contains(job)) continue;            // stop jobs folded into their start
            string stop = StopSuffixes.Select(suf => job + suf).FirstOrDefault(set.Contains);
            if (stop == null && job.StartsWith("STEUERN_", StringComparison.OrdinalIgnoreCase))
            {
                string candidate = "STEUERN_ENDE_" + job["STEUERN_".Length..];
                if (set.Contains(candidate)) stop = candidate;
            }
            // no stop job: a numeric value argument makes it a toggle anyway
            // (start = send the value, stop = send 0); truly argless one-shots
            // stay momentary
            bool toggleByArg = stop == null && HasNumericArg(diag, job);
            var specs = ArgSpecs(diag, job);
            result.Add(new Activation(Translate(job), job, stop,
                                      Momentary: stop == null && !toggleByArg,
                                      Critical: IsCritical(job),
                                      Args: specs,
                                      Runnable: CanSupply(specs)));
        }
        return result;
    }

    // does the job declare a numeric (int/real) argument? read offline from the
    // SGBD's _ARGUMENTS schema.
    // An argument documented "table BITS NAME TEXT": the legal values are the
    // NAME column of the BITS table and TEXT is the human label. This is the
    // SGBD's own convention, so it resolves for any ECU without per-ECU code.
    private static readonly Regex TableRef =
        new(@"\btable\s+(\w+)\s+(\w+)\s+(\w+)", RegexOptions.IgnoreCase);

    // Every argument the SGBD declares for a job, in declaration order, paired
    // with its type so the caller can tell a drive value from a selector, and
    // with the option list when the argument names a lookup table.
    private static List<ArgSpec> ArgSpecs(Diag diag, string job)
    {
        var specs = new List<ArgSpec>();
        try
        {
            foreach (var set in diag.Run("_ARGUMENTS", job))
            {
                if (!(set.TryGetValue("ARG", out var a) && a.OpData is string arg)
                    || arg.Length == 0
                    || specs.Any(s => string.Equals(s.Name, arg, StringComparison.OrdinalIgnoreCase)))
                    continue;
                string type = set.TryGetValue("ARGTYPE", out var t) && t.OpData is string ts ? ts : "";

                // the option list, when a comment names a table
                var options = new List<ArgOption>();
                for (int i = 0; i < 4; i++)
                {
                    if (!(set.TryGetValue("ARGCOMMENT" + i, out var c) && c.OpData is string comment))
                        continue;
                    var m = TableRef.Match(comment);
                    if (!m.Success) continue;
                    foreach (var row in diag.TableRows(m.Groups[1].Value))
                        if (row.TryGetValue(m.Groups[2].Value, out var val) && val.Length > 0)
                            options.Add(new ArgOption(val,
                                row.TryGetValue(m.Groups[3].Value, out var lbl) ? lbl : val));
                    break;
                }
                specs.Add(new ArgSpec(arg, type, options));
            }
        }
        catch { /* no schema: treat as argless */ }
        return specs;
    }

    // What the UI can actually fill in on its own: nothing (a one-shot), or a
    // single NUMERIC drive value (send the value to start, 0 to stop). A string
    // argument names a component the caller has to choose — STEUERN_DIGITAL's
    // ORT is "gewuenschte Komponente" from a BITS table — and a second argument
    // is a mode we do not know either. Those are listed but not runnable until
    // their arguments are mapped, rather than shown as a button that silently
    // sends an incomplete request to a real car.
    // What we can honestly put in front of the user:
    //   nothing            a one-shot
    //   one numeric value  the drive value (send it to start, 0 to stop)
    //   a table-backed     the SGBD spells out the legal values, so the picker
    //   selector           offers the real list — this is what makes
    //                      STEUERN_DIGITAL (ORT from BITS + EIN) runnable
    //
    // A set of bare numeric parameters is NOT enough, even though each one is
    // technically fillable: STEUERN_IO's IO_LOCAL_IDENTIFIER /
    // IO_CONTROL_PARAMETER / IO_CONTROL_STATE are raw protocol values with no
    // documented meaning, and prompting for three numbers invites a blind write
    // to a real car. At least one argument must come from a table for a
    // multi-argument job to qualify.
    private static bool CanSupply(List<ArgSpec> args) =>
        args.Count == 0
        || (args.Count == 1 && Fillable(args[0]))
        || (args.All(Fillable) && args.Any(a => a.Options.Count > 0));

    // an argument we can put a real value in front of the user for: a numeric
    // drive value, or one whose legal values the SGBD spells out in a table
    private static bool Fillable(ArgSpec a) =>
        a.Options.Count > 0
        || a.Type.Contains("int", StringComparison.OrdinalIgnoreCase)
        || a.Type.Contains("real", StringComparison.OrdinalIgnoreCase);

    private static bool HasNumericArg(Diag diag, string job)
    {
        try
        {
            foreach (var set in diag.Run("_ARGUMENTS", job))
            {
                if (!(set.TryGetValue("ARG", out var a) && a.OpData is string arg) || arg.Length == 0)
                    continue;
                string type = set.TryGetValue("ARGTYPE", out var t) && t.OpData is string ts ? ts : "";
                if (type.Contains("int", StringComparison.OrdinalIgnoreCase)
                    || type.Contains("real", StringComparison.OrdinalIgnoreCase))
                    return true;
            }
        }
        catch { /* no schema: treat as argless */ }
        return false;
    }

    public static List<MenuSection> Build(IEnumerable<string> jobs)
    {
        var buckets = Order.ToDictionary(s => s, _ => new List<MenuItem>());
        foreach (var job in jobs)
        {
            if (System.Contains(job)) continue;
            string section = SectionFor(job);
            if (section == null) continue;   // no INPA menu holds this job
            buckets[section].Add(new MenuItem(job, Translate(job), Danger.IsMatch(job)));
        }
        return Order.Where(s => buckets[s].Count > 0)
                    .Select(s => new MenuSection(s, buckets[s])).ToList();
    }
}
