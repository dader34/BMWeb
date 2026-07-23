using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace EdiabasMac;

// parses the original INPA config to reproduce its navigation: chassis -> section
// -> ECU. files BMW shipped:
//   CFGDAT/<CHASSIS>.ENG  -> sections ([ROOT_*]) and their ECU entries (ENTRY=)
//   SGDAT/<CODE>.IPO      -> resolves an ENTRY code to its real SGBD .prg
//
// E46.ENG sample:
//   [ROOT_MOTOR]
//   DESCRIPTION=Engine
//   ENTRY=MS450,MS45.1 for M54,
// Sgbd is our best-guess concrete variant (used offline for layouts/menus).
// Group is the diagnostic-address group SGBD (D_00xx.grp) when one exists: loading
// it live lets EDIABAS identify the exact variant itself, instead of trusting the
// filename heuristic (which e.g. mis-picks ihka38 for the E46 IHKA).
public sealed record EcuEntry(string Code, string Label, string Sgbd, string Group = null);
public sealed record Section(string Key, string Name, List<EcuEntry> Ecus);
public sealed record Chassis(string Id, string Description, List<Section> Sections);

public sealed class InpaConfig
{
    private readonly string _cfgDat;   // .../EC-APPS/INPA/CFGDAT
    private readonly string _sgDat;    // .../EC-APPS/INPA/SGDAT
    private readonly string _ecuPath;  // .../EDIABAS/Ecu  (confirms .prg exists)

    // surfaced sections, INPA display order, English names
    private static readonly (string Key, string Name)[] SectionOrder =
    {
        ("ROOT_MOTOR", "Engine"),
        ("ROOT_GETRIEBE", "Transmission"),
        ("ROOT_FAHRWERK", "Chassis"),
        ("ROOT_KAROSSERIE", "Body"),
        ("ROOT_KOMMUNIKATION", "Communication"),
    };

    public InpaConfig(string inpaRoot, string ecuPath)
    {
        _cfgDat = Path.Combine(inpaRoot, "CFGDAT");
        _sgDat = Path.Combine(inpaRoot, "SGDAT");
        _ecuPath = ecuPath;
    }

    // chassis with a .ENG file, production codes only (E/F/G/R/RR + digit)
    public List<string> ChassisIds()
    {
        if (!Directory.Exists(_cfgDat)) return new List<string>();
        return Directory.EnumerateFiles(_cfgDat, "*.ENG")
            .Select(f => Path.GetFileNameWithoutExtension(f).ToUpperInvariant())
            .Where(id => Regex.IsMatch(id, "^(E|F|G|R|RR)\\d")) // E46, E60, F30, R56...
            .OrderBy(id => id)
            .ToList();
    }

    public Chassis Load(string chassisId)
    {
        string file = Path.Combine(_cfgDat, chassisId + ".ENG");
        if (!File.Exists(file))
            throw new FileNotFoundException($"No config for chassis {chassisId}", file);

        string description = chassisId;
        var sections = new List<Section>();
        Section current = null;

        foreach (string raw in File.ReadLines(file, Latin1()))
        {
            string line = raw.Trim();
            if (line.Length == 0 || line.StartsWith(";")) continue;

            var sec = Regex.Match(line, @"^\[(ROOT_[A-Z0-9_]+)\]$");
            if (sec.Success)
            {
                string key = sec.Groups[1].Value;
                var known = SectionOrder.FirstOrDefault(s => s.Key == key);
                current = new Section(key, known.Name ?? Pretty(key), new List<EcuEntry>());
                // recognized only
                if (known.Key != null) sections.Add(current);
                else current = null;
                continue;
            }

            if (line.StartsWith("DESCRIPTION=", StringComparison.OrdinalIgnoreCase))
            {
                string val = line.Substring("DESCRIPTION=".Length).Trim();
                if (current == null && sections.Count == 0) description = val;
                continue;
            }

            if (current != null && line.StartsWith("ENTRY=", StringComparison.OrdinalIgnoreCase))
            {
                // ENTRY=<CODE>,<Label>,
                string body = line.Substring("ENTRY=".Length);
                string[] parts = body.Split(',');
                if (parts.Length < 1) continue;
                string code = parts[0].Trim();
                string label = parts.Length > 1 ? parts[1].Trim() : code;
                if (code.Length == 0) continue;

                string sgbd = ResolveSgbd(code, chassisId);
                if (sgbd != null) // SGBD must exist on disk
                    current.Ecus.Add(new EcuEntry(code, label, sgbd, GroupFileFor(code)));
            }
        }

        // INPA order, drop empties
        sections = sections
            .Where(s => s.Ecus.Count > 0)
            .OrderBy(s => Array.FindIndex(SectionOrder, o => o.Key == s.Key))
            .ToList();

        return new Chassis(chassisId, description, sections);
    }

    // the diagnostic-address group SGBD (D_00xx.grp) for a module, or null if none.
    // 1) a D_00xx token referenced by the module's compiled .IPO (the reliable source)
    // 2) an address encoded as the code's "_xx" suffix (e.g. klima_5B -> D_005B); the
    //    underscore guards against chassis digits (kombi46/ihka46 do NOT match).
    private string GroupFileFor(string code)
    {
        foreach (string token in IpoGroupTokens(code))
        {
            if (string.Equals(token, "D_0080", StringComparison.OrdinalIgnoreCase))
                continue; // functional broadcast, not a real ECU group
            string hit = FindGrpCaseInsensitive(token);
            if (hit != null) return hit;
        }
        var m = Regex.Match(code ?? "", @"_([0-9A-Fa-f]{2})$");
        if (m.Success)
        {
            string hit = FindGrpCaseInsensitive("D_00" + m.Groups[1].Value.ToUpperInvariant());
            if (hit != null) return hit;
        }
        return null;
    }

    // a group SGBD file (.grp) by name, case-insensitively; null if absent.
    private string FindGrpCaseInsensitive(string name)
    {
        if (name == null || !Directory.Exists(_ecuPath)) return null;
        if (File.Exists(Path.Combine(_ecuPath, name + ".grp"))) return name;
        foreach (var f in Directory.EnumerateFiles(_ecuPath, "*.grp"))
            if (string.Equals(Path.GetFileNameWithoutExtension(f), name, StringComparison.OrdinalIgnoreCase))
                return Path.GetFileNameWithoutExtension(f);
        return null;
    }

    // resolve an ENTRY code to a real SGBD .prg name (no extension).
    // 1) "SGBD: <NAME>" from SGDAT/<CODE>.IPO  2) fall back to <code>ds0
    // 3) variant list from the .ipo, chassis-matched.
    private string ResolveSgbd(string code, string chassisId = null)
    {
        string fromIpo = SgbdFromIpo(code);
        foreach (string candidate in new[] { fromIpo, code + "ds0", code }.Where(c => c != null))
        {
            string prg = candidate.ToLowerInvariant();
            if (File.Exists(Path.Combine(_ecuPath, prg + ".prg")))
                return prg;
            // case-insensitive: dump mixes cases, e.g. 10MSS54.PRG
            string hit = FindPrgCaseInsensitive(prg);
            if (hit != null) return hit;
        }
        // group/variant entries (e.g. gsds2 = auto trans, kombi = cluster) have no
        // direct .prg; their .ipo lists concrete variants (GS20, KOMBI46, ...).
        foreach (string variant in SgbdVariantsFromIpo(code, chassisId))
        {
            string hit = FindPrgCaseInsensitive(variant.ToLowerInvariant());
            if (hit != null) return hit;
        }
        return null;
    }

    // cross-ECU tokens that show up in many engine .ipo scripts (login/check
    // references) but are never the engine's own SGBD. without this the S54 M3
    // entry MSS54M3 (true SGBD MSS54DS0, which does not prefix-match the code)
    // tied with the stray "EWS" reference and resolved to the immobilizer. these
    // sink below real SGBD candidates of equal prefix-rank; insertion order still
    // decides among real variants (e.g. ABS5 over ASC5 for absasc5).
    private static readonly HashSet<string> GenericIpoTokens =
        new(StringComparer.OrdinalIgnoreCase)
        {
            "EWS", "EWS3", "DME", "KAT", "HLM", "LMM", "ASC", "ASR", "MSR",
            "SIM", "VON", "BIT", "DSP", "CAS", "FLASH", "UTILITY",
        };

    // uppercase tokens in an .ipo that look like SGBD names, ranked so the right
    // variant wins: tokens starting with the entry code first (KOMBI46 over the
    // stray "CARB" in "check engine CARB"), and within those, the one whose
    // trailing digits match the chassis (E46 -> KOMBI46) before other variants.
    // generic cross-ECU references (EWS, DME, ...) sink below real candidates.
    private IEnumerable<string> SgbdVariantsFromIpo(string code, string chassisId = null)
    {
        if (!Directory.Exists(_sgDat)) yield break;
        string ipo = Directory.EnumerateFiles(_sgDat)
            .FirstOrDefault(f => string.Equals(Path.GetFileNameWithoutExtension(f), code, StringComparison.OrdinalIgnoreCase)
                                 && Path.GetExtension(f).Equals(".IPO", StringComparison.OrdinalIgnoreCase));
        if (ipo == null) yield break;
        string text;
        try { text = File.ReadAllText(ipo, Latin1()); } catch { yield break; }

        var names = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (Match m in Regex.Matches(text, @"\b([A-Z][A-Z0-9_]{2,12})\b"))
        {
            string name = m.Groups[1].Value;
            if (seen.Add(name)) names.Add(name);
        }
        string codeUp = (code ?? "").ToUpperInvariant();
        // chassis digits, e.g. E46 -> "46", to favour the matching variant
        string chassisNum = chassisId != null ? Regex.Match(chassisId, @"\d+").Value : "";
        int Rank(string n)
        {
            bool prefix = n.StartsWith(codeUp, StringComparison.OrdinalIgnoreCase);
            bool chassis = prefix && chassisNum.Length > 0 && n.Contains(chassisNum);
            if (chassis) return 0;   // KOMBI46 for E46
            if (prefix) return 1;    // any KOMBI* variant
            return 2;                // unrelated tokens (CARB, IKE, ...)
        }
        // stable: real SGBDs before generic cross-refs within the same Rank,
        // original .ipo order preserved otherwise.
        foreach (string n in names.OrderBy(Rank).ThenBy(n => GenericIpoTokens.Contains(n) ? 1 : 0))
            yield return n;
    }

    private string SgbdFromIpo(string code)
    {
        if (!Directory.Exists(_sgDat)) return null;
        string ipo = Directory.EnumerateFiles(_sgDat)
            .FirstOrDefault(f => string.Equals(Path.GetFileNameWithoutExtension(f), code, StringComparison.OrdinalIgnoreCase)
                                 && Path.GetExtension(f).Equals(".IPO", StringComparison.OrdinalIgnoreCase));
        if (ipo == null) return null;
        try
        {
            // .ipo is mostly binary but has an ASCII "SGBD: NAME" marker
            string text = File.ReadAllText(ipo, Latin1());
            var m = Regex.Match(text, @"SGBD[:=]\s*([A-Za-z0-9_]+)");
            if (m.Success) return m.Groups[1].Value;
        }
        catch { /* ignore unreadable ipo */ }
        return null;
    }

    // one enumeration of the Ecu dir, shared by FindPrgCaseInsensitive and
    // SgbdVariants. name -> name with original casing, keyed case-insensitively.
    private readonly object _prgLock = new();
    private readonly Dictionary<string, string> _prgCache = new(StringComparer.OrdinalIgnoreCase);
    private Dictionary<string, string> PrgCache()
    {
        lock (_prgLock)
        {
            if (_prgCache.Count == 0 && Directory.Exists(_ecuPath))
            {
                foreach (string f in Directory.EnumerateFiles(_ecuPath, "*.prg")
                             .Concat(Directory.EnumerateFiles(_ecuPath, "*.PRG")))
                    _prgCache[Path.GetFileNameWithoutExtension(f)] = Path.GetFileNameWithoutExtension(f);
            }
            return _prgCache;
        }
    }

    private string FindPrgCaseInsensitive(string baseName)
    {
        return PrgCache().TryGetValue(baseName, out string hit) ? hit : null;
    }

    // SGBD variants of a module that share its fault tables, e.g. zke5 ->
    // [zke5, zke5_s12]. some modules ship a base SGBD plus suffixed variants
    // (_s12, _hi, ...); the base may label faults as "unbekannter Fehlerort"
    // while a variant names them. primary is returned first, then siblings on
    // disk whose name is the primary plus a _suffix. case-insensitive.
    public IReadOnlyList<string> SgbdVariants(string primarySgbd)
    {
        var list = new List<string> { primarySgbd };
        if (string.IsNullOrEmpty(primarySgbd)) return list;
        string prefix = primarySgbd.ToLowerInvariant() + "_";
        foreach (string name in PrgCache().Values)
        {
            if (name.ToLowerInvariant().StartsWith(prefix) &&
                !list.Contains(name, StringComparer.OrdinalIgnoreCase))
                list.Add(name);
        }
        return list;
    }

    private static string Pretty(string rootKey) =>
        rootKey.Replace("ROOT_", "").ToLowerInvariant() is var s && s.Length > 0
            ? char.ToUpperInvariant(s[0]) + s.Substring(1)
            : rootKey;

    // cached: GetEncoding does a lookup, and this is called inside parse loops.
    // the CodePages provider itself is registered once in EncodingBootstrap.
    private static readonly Encoding s_latin1 = Encoding.GetEncoding(1252);
    private static Encoding Latin1() => s_latin1;

    // ---- variant groups, derived from the entries' .IPO address references ----
    // ECUs sharing one diagnostic address are alternatives: only one is
    // installed, so a whole-vehicle scan can skip a group's remaining members
    // once any of them answers. The compiled .IPO frontends reference their
    // address group file (D_0012 = the DME address, D_0032 = transmission,
    // ...), which gives the grouping statically. Rules validated against the
    // hand-curated E46/E36 tables:
    //   - tokens are matched within one section only (cross-section token
    //     reuse is utility references, not shared addresses)
    //   - D_0080 is the functional broadcast address every frontend may
    //     reference; grouping on it would merge unrelated modules
    // Entries whose .IPO carries no usable token stay ungrouped here; the
    // renderer merges its known hand-curated groups on top.
    private static readonly Regex GroupToken = new(@"D_00[0-9A-Fa-f]{2}",
                                                   RegexOptions.Compiled);
    private readonly Dictionary<string, List<List<string>>> _groupCache = new(StringComparer.OrdinalIgnoreCase);

    public List<List<string>> VariantGroups(Chassis chassis)
    {
        if (_groupCache.TryGetValue(chassis.Id, out var cached)) return cached;
        var groups = new List<List<string>>();
        foreach (var section in chassis.Sections)
        {
            var byToken = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
            foreach (var ecu in section.Ecus)
            {
                foreach (string token in IpoGroupTokens(ecu.Code))
                {
                    if (string.Equals(token, "D_0080", StringComparison.OrdinalIgnoreCase))
                        continue; // functional broadcast, referenced by many
                    if (!byToken.TryGetValue(token, out var list))
                        byToken[token] = list = new List<string>();
                    if (!list.Contains(ecu.Code)) list.Add(ecu.Code);
                }
            }
            foreach (var list in byToken.Values)
                if (list.Count >= 2) groups.Add(list);
        }
        _groupCache[chassis.Id] = groups;
        return groups;
    }

    // distinct D_00xx address-group tokens in an entry's compiled .IPO
    private IEnumerable<string> IpoGroupTokens(string code)
    {
        if (!Directory.Exists(_sgDat)) yield break;
        string ipo = Directory.EnumerateFiles(_sgDat, "*.IPO")
            .FirstOrDefault(f => string.Equals(
                Path.GetFileNameWithoutExtension(f), code, StringComparison.OrdinalIgnoreCase));
        if (ipo == null) yield break;
        string text = System.Text.Encoding.Latin1.GetString(File.ReadAllBytes(ipo));
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (Match m in GroupToken.Matches(text))
            if (seen.Add(m.Value)) yield return m.Value;
    }
}
