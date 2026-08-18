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
//   CFGDAT|SGDAT/<CHASSIS>.GER -> German menu, used when no .ENG exists (K25/K40)
//   SGDAT/<CODE>.IPO      -> resolves an ENTRY code to its real SGBD .prg
//
// KEEP IN STEP with tools/export/inpa_config.py: that Python twin regenerates
// the committed data/chassis-config cache when this project cannot build (the
// csproj needs vendor/ediabaslib-src, which is not always vendored). Any
// change to parsing or resolution here must be mirrored there. The twin also
// handles BMW_ALT.ENG (E31/E34/E38 + legacy E36) and SONDER.ENG, which this
// loader only covers for the per-chassis files it is asked for.
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

    // surfaced sections, INPA display order, English names. This is a NAMING
    // table, not an allowlist: sections not listed here are kept with a
    // prettified key (the old 5-name allowlist silently dropped the seat,
    // door and airbag-satellite menus of E60/E65/E70/E9x/F/RR1).
    private static readonly (string Key, string Name)[] SectionOrder =
    {
        ("ROOT_MOTOR", "Engine"),
        ("ROOT_GETRIEBE", "Transmission"),
        ("ROOT_FAHRWERK", "Chassis"),
        ("ROOT_KAROSSERIE", "Body"),
        ("ROOT_KAROSSERIE_TUER", "Doors"),
        ("ROOT_KAROSSERIE_SITZ", "Seats"),
        ("ROOT_SICHERHEITSMODULE", "Safety modules"),
        ("ROOT_SICHERHEITSFAHRZEUG", "Vehicle safety"),
        ("ROOT_ELEKTRIK", "Electrics"),
        ("ROOT_SONSTIGES", "Other"),
        ("ROOT_NAVIGATION", "Navigation"),
        ("ROOT_KOMMUNIKATION", "Communication"),
    };

    public InpaConfig(string inpaRoot, string ecuPath)
    {
        _cfgDat = Path.Combine(inpaRoot, "CFGDAT");
        _sgDat = Path.Combine(inpaRoot, "SGDAT");
        _ecuPath = ecuPath;
    }

    // chassis with a menu file, production codes only (E/F/G/R/RR/K + digit).
    // K25/K40 (motorcycles) only ship a .GER menu, so those count too.
    public List<string> ChassisIds()
    {
        if (!Directory.Exists(_cfgDat)) return new List<string>();
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (string f in Directory.EnumerateFiles(_cfgDat, "*.ENG"))
            ids.Add(Path.GetFileNameWithoutExtension(f).ToUpperInvariant());
        foreach (string dir in new[] { _cfgDat, _sgDat })
            if (Directory.Exists(dir))
                foreach (string f in Directory.EnumerateFiles(dir, "*.GER"))
                    ids.Add(Path.GetFileNameWithoutExtension(f).ToUpperInvariant());
        var list = ids
            .Where(id => Regex.IsMatch(id, "^(E|F|G|R|RR|K)\\d")) // E46, F30, R56, K25...
            .ToList();
        // BMW_ALT.ENG is the only menu for the old models; SONDER.ENG holds
        // the special tests. Neither is a <CHASSIS>.ENG file of its own.
        if (File.Exists(Path.Combine(_cfgDat, "BMW_ALT.ENG")))
            foreach (string id in BmwAltChassis)
                if (!list.Contains(id)) list.Add(id);
        if (File.Exists(Path.Combine(_cfgDat, "SONDER.ENG")) && !list.Contains("SONDER"))
            list.Add("SONDER");
        return list.OrderBy(id => id).ToList();
    }

    // chassis whose menus live inside BMW_ALT.ENG ([ROOT_E31_MOTOR]...).
    // BMW_ALT also carries legacy E36 sections, but every one of its E36
    // entry codes already exists in E36.ENG, so no merge is needed there.
    private static readonly string[] BmwAltChassis = { "E31", "E34", "E38" };

    // the menu file for a chassis: .ENG, else the German menu (CFGDAT first,
    // then SGDAT, where some dumps keep the .GER files). Labels from a .GER
    // menu stay German -- BMW never shipped English ones for those chassis.
    private string MenuFileFor(string chassisId)
    {
        string eng = Path.Combine(_cfgDat, chassisId + ".ENG");
        if (File.Exists(eng)) return eng;
        foreach (string ger in new[] { Path.Combine(_cfgDat, chassisId + ".GER"),
                                       Path.Combine(_sgDat, chassisId + ".GER") })
            if (File.Exists(ger)) return ger;
        return null;
    }

    public Chassis Load(string chassisId)
    {
        if (BmwAltChassis.Contains(chassisId, StringComparer.OrdinalIgnoreCase))
            return LoadBmwAlt(chassisId.ToUpperInvariant());
        if (string.Equals(chassisId, "SONDER", StringComparison.OrdinalIgnoreCase))
            return LoadSonder();

        string file = MenuFileFor(chassisId);
        if (file == null)
            throw new FileNotFoundException($"No config for chassis {chassisId}",
                Path.Combine(_cfgDat, chassisId + ".ENG"));

        string description = chassisId;
        var sections = new List<Section>();
        Section current = null;

        foreach (string raw in File.ReadLines(file, Latin1()))
        {
            string line = raw.Trim();
            if (line.Length == 0 || line.StartsWith(";")) continue;

            // case-insensitive: F30.ENG writes [ROOT_Navigation], and missing
            // that boundary leaked its cic entry into the preceding section
            var sec = Regex.Match(line, @"^\[(ROOT_[A-Z0-9_]+)\]$", RegexOptions.IgnoreCase);
            if (sec.Success)
            {
                string key = sec.Groups[1].Value.ToUpperInvariant();
                var known = SectionOrder.FirstOrDefault(s => s.Key == key);
                // unknown sections are kept, not dropped (SectionOrder names)
                current = new Section(key, known.Name ?? Pretty(key), new List<EcuEntry>());
                sections.Add(current);
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
                    current.Ecus.Add(new EcuEntry(code, label, sgbd, GroupFileFor(code, sgbd)));
                else // never drop silently
                    Console.Error.WriteLine(
                        $"InpaConfig: {chassisId} {current.Key} drops {code} ({label}): no SGBD resolves");
            }
        }

        // INPA order, drop empties; sections not in SectionOrder sink to the
        // end but survive (FindIndex yields -1, so map it past the known ones)
        sections = sections
            .Where(s => s.Ecus.Count > 0)
            .OrderBy(s =>
            {
                int i = Array.FindIndex(SectionOrder, o => o.Key == s.Key);
                return i < 0 ? SectionOrder.Length : i;
            })
            .ToList();

        return new Chassis(chassisId, description, sections);
    }

    // one of E31/E34/E38 out of BMW_ALT.ENG, whose sections are named
    // [ROOT_<CHASSIS>_<SECTION>] with [ROOT_<CHASSIS>] carrying the label
    private Chassis LoadBmwAlt(string chassisId)
    {
        string file = Path.Combine(_cfgDat, "BMW_ALT.ENG");
        if (!File.Exists(file))
            throw new FileNotFoundException($"No config for chassis {chassisId}", file);

        string description = chassisId;
        var sections = new List<Section>();
        Section current = null;
        bool inChassisHead = false;

        foreach (string raw in File.ReadLines(file, Latin1()))
        {
            string line = raw.Trim();
            if (line.Length == 0 || line.StartsWith(";")) continue;

            var head = Regex.Match(line, @"^\[ROOT_(E\d+)\]$", RegexOptions.IgnoreCase);
            if (head.Success)
            {
                inChassisHead = string.Equals(head.Groups[1].Value, chassisId,
                                              StringComparison.OrdinalIgnoreCase);
                current = null;
                continue;
            }
            var sec = Regex.Match(line, @"^\[ROOT_(E\d+)_([A-Z0-9_]+)\]$", RegexOptions.IgnoreCase);
            if (sec.Success)
            {
                inChassisHead = false;
                if (!string.Equals(sec.Groups[1].Value, chassisId, StringComparison.OrdinalIgnoreCase))
                { current = null; continue; }
                string key = "ROOT_" + sec.Groups[2].Value.ToUpperInvariant();
                var known = SectionOrder.FirstOrDefault(s => s.Key == key);
                current = new Section(key, known.Name ?? Pretty(key), new List<EcuEntry>());
                sections.Add(current);
                continue;
            }
            if (line.StartsWith("DESCRIPTION=", StringComparison.OrdinalIgnoreCase))
            {
                if (inChassisHead) description = line.Substring("DESCRIPTION=".Length).Trim();
                continue;
            }
            if (current != null && line.StartsWith("ENTRY=", StringComparison.OrdinalIgnoreCase))
            {
                string[] parts = line.Substring("ENTRY=".Length).Split(',');
                string code = parts[0].Trim();
                string label = parts.Length > 1 ? parts[1].Trim() : code;
                if (code.Length == 0) continue;
                string sgbd = ResolveSgbd(code, chassisId);
                if (sgbd != null)
                    current.Ecus.Add(new EcuEntry(code, label, sgbd, GroupFileFor(code, sgbd)));
                else
                    Console.Error.WriteLine(
                        $"InpaConfig: {chassisId} (BMW_ALT) {current.Key} drops {code} ({label}): no SGBD resolves");
            }
        }

        sections = sections
            .Where(s => s.Ecus.Count > 0)
            .OrderBy(s =>
            {
                int i = Array.FindIndex(SectionOrder, o => o.Key == s.Key);
                return i < 0 ? SectionOrder.Length : i;
            })
            .ToList();
        return new Chassis(chassisId, description, sections);
    }

    // SONDER.ENG: the special tests, all under [ROOT]
    private Chassis LoadSonder()
    {
        string file = Path.Combine(_cfgDat, "SONDER.ENG");
        if (!File.Exists(file))
            throw new FileNotFoundException("No config for SONDER", file);

        string description = "Special tests";
        var ecus = new List<EcuEntry>();
        bool inRoot = false;
        foreach (string raw in File.ReadLines(file, Latin1()))
        {
            string line = raw.Trim();
            if (line.Length == 0 || line.StartsWith(";")) continue;
            if (line.Equals("[ROOT]", StringComparison.OrdinalIgnoreCase)) { inRoot = true; continue; }
            if (line.StartsWith("[")) { inRoot = false; continue; }
            if (!inRoot) continue;
            if (line.StartsWith("DESCRIPTION=", StringComparison.OrdinalIgnoreCase))
            { description = line.Substring("DESCRIPTION=".Length).Trim(); continue; }
            if (!line.StartsWith("ENTRY=", StringComparison.OrdinalIgnoreCase)) continue;
            string[] parts = line.Substring("ENTRY=".Length).Split(',');
            string code = parts[0].Trim();
            string label = parts.Length > 1 ? parts[1].Trim() : code;
            if (code.Length == 0) continue;
            string sgbd = ResolveSgbd(code, "SONDER");
            if (sgbd != null)
                ecus.Add(new EcuEntry(code, label, sgbd, GroupFileFor(code, sgbd)));
            else
                Console.Error.WriteLine(
                    $"InpaConfig: SONDER ROOT drops {code} ({label}): no SGBD resolves");
        }
        var sections = new List<Section>();
        if (ecus.Count > 0)
            sections.Add(new Section("ROOT_SONDER", "Special tests", ecus));
        return new Chassis("SONDER", description, sections);
    }

    // the diagnostic-address group SGBD (D_*.grp) for a module, or null if none.
    // KEEP IN STEP with group_file_for in tools/export/inpa_config.py.
    //
    // The old rule -- first existing D_00xx token except D_0080, then the code's
    // "_xx" hex suffix -- misfired: KOMBI.IPO names D_000D (E30-era clusters)
    // before D_0080 (where kombi46 really lives), and ALC_60's "_60" is the
    // chassis, not an address (D_0060 is the E46 PDC group). A wrong group makes
    // strict variant resolution mark a present module absent. Candidates are now
    // only accepted when the group can actually identify this SGBD:
    //   1. T_GRTB.PRG, BMW's own variant->group table (KWP2000-era modules)
    //   2. .IPO tokens, numeric then named (D_ZKE_GM, D_XEN_L...), accepted when
    //      the group's decrypted string pool names the resolved SGBD (this also
    //      retires the blanket D_0080 ban: a spurious broadcast reference never
    //      validates, the cluster's own reference does)
    //   3. the _xx address suffix, same pool test
    //   4. any group whose ecucomment member list has the SGBD
    //   5. nothing validated: the legacy order (numeric minus D_0080, then named
    //      tokens ranked by name affinity, then suffix) -- pools go stale
    //      (D_0012 never heard of D50M57D0), so an unvalidated address-token
    //      beats no group
    private string GroupFileFor(string code, string sgbd)
    {
        string grtb = GrtbGroup(sgbd);
        if (grtb != null)
        {
            string hit = FindGrpCaseInsensitive(grtb);
            if (hit != null) return hit;
        }
        foreach (string token in IpoGroupTokens(code).Concat(IpoNamedGroupTokens(code)))
        {
            string hit = FindGrpCaseInsensitive(token);
            if (hit != null && PoolMember(hit, sgbd)) return hit;
        }
        var m = Regex.Match(code ?? "", @"_([0-9A-Fa-f]{2})$");
        string suffixHit = m.Success
            ? FindGrpCaseInsensitive("D_00" + m.Groups[1].Value.ToUpperInvariant())
            : null;
        if (suffixHit != null && PoolMember(suffixHit, sgbd)) return suffixHit;
        string scan = EcucommentScan(sgbd);
        if (scan != null) return scan;
        foreach (string token in IpoGroupTokens(code))
        {
            if (string.Equals(token, "D_0080", StringComparison.OrdinalIgnoreCase))
                continue; // broadcast: unvalidated, the old rationale stands
            string hit = FindGrpCaseInsensitive(token);
            if (hit != null) return hit;
        }
        // a media-box .IPO references every group on the MOST ring (NAV_60
        // names 16); prefer the one whose stem matches the entry's own name
        // (NAV_60 -> D_NAV), keeping .IPO order within a rank
        var alphaM = Regex.Match(code ?? "", "^[A-Za-z]+");
        string alpha = alphaM.Success ? alphaM.Value.ToUpperInvariant() : "";
        var named = IpoNamedGroupTokens(code)
            .Where(t => FindGrpCaseInsensitive(t) != null)
            .ToList();
        if (named.Count > 0)
        {
            int NamedRank(string token)
            {
                string stem = token.Substring(2).ToUpperInvariant();
                return alpha.Length > 0 &&
                       (stem.StartsWith(alpha, StringComparison.Ordinal) ||
                        alpha.StartsWith(stem, StringComparison.Ordinal)) ? 0 : 1;
            }
            return FindGrpCaseInsensitive(named.OrderBy(NamedRank).First()); // stable
        }
        return suffixHit;
    }

    // ---- group-candidate validation: what can this .grp actually identify? ----

    // named group references (D_ZKE_GM, D_MOTOR, ...): a full D_* identifier,
    // so a D_0072B-style stem is not clipped to its numeric prefix. Most D_*
    // matches are job RESULT names (D_BMW_NR...), filtered by FindGrp callers.
    private static readonly Regex GroupNameToken = new(@"D_[0-9A-Za-z_]+", RegexOptions.Compiled);
    // printable runs in a decrypted (XOR 0xF7) SGBD body -- the string pool
    private static readonly Regex PoolRun = new(@"[ -~]{3,}", RegexOptions.Compiled);
    // a T_GRTB ZuordnungsTabelle row starts with its ident column: "01 ---- 0110"
    private static readonly Regex GrtbRow = new(@"^[0-9A-Fa-f]{2} [0-9A-Fa-f-]{4} [0-9A-Fa-f]{4}$", RegexOptions.Compiled);
    // a chassis code inside an ecucomment (D_EXX: "for E60 E65 E70 E89X R56
    // RR1") describes applicability, not a member SGBD
    private static readonly Regex ChassisWord = new(@"^(e|f|g|r|rr|k)\d+x?$", RegexOptions.Compiled);

    // distinct non-numeric D_* tokens in the .IPO; numeric D_00xx stays
    // IpoGroupTokens' business
    private IEnumerable<string> IpoNamedGroupTokens(string code)
    {
        if (!Directory.Exists(_sgDat)) yield break;
        string ipo = Directory.EnumerateFiles(_sgDat, "*.IPO")
            .FirstOrDefault(f => string.Equals(
                Path.GetFileNameWithoutExtension(f), code, StringComparison.OrdinalIgnoreCase));
        if (ipo == null) yield break;
        string text = Encoding.Latin1.GetString(File.ReadAllBytes(ipo));
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (Match m in GroupNameToken.Matches(text))
        {
            if (Regex.IsMatch(m.Value, "^D_00[0-9A-Fa-f]{2}$")) continue;
            if (seen.Add(m.Value)) yield return m.Value;
        }
    }

    // group SGBD strings are XOR 0xF7 in this dump
    private static string DecryptedText(string path)
    {
        byte[] data = File.ReadAllBytes(path);
        for (int i = 0; i < data.Length; i++) data[i] ^= 0xF7;
        return Encoding.Latin1.GetString(data);
    }

    // grp stem (lower) -> (on-disk stem, full path), one dir enumeration
    private readonly object _grpLock = new();
    private Dictionary<string, (string Stem, string Path)> _grpCache;
    private Dictionary<string, (string Stem, string Path)> GrpCache()
    {
        lock (_grpLock)
        {
            if (_grpCache == null)
            {
                _grpCache = new Dictionary<string, (string, string)>(StringComparer.Ordinal);
                if (Directory.Exists(_ecuPath))
                    foreach (string f in Directory.EnumerateFiles(_ecuPath, "*.grp")
                                 .Concat(Directory.EnumerateFiles(_ecuPath, "*.GRP")))
                    {
                        string stem = Path.GetFileNameWithoutExtension(f);
                        _grpCache[stem.ToLowerInvariant()] = (stem, f);
                    }
            }
            return _grpCache;
        }
    }

    // (all printable names, ecucomment member names) of a .grp, lowercased.
    // The 'ecucomment:' string is the group's own member list and is the
    // trustworthy signal; the full set additionally holds the members as
    // standalone pool entries. The literal 't_grtb' is the external
    // ZuordnungsTabelle reference every newer group carries, never a member.
    private readonly Dictionary<string, (HashSet<string> All, HashSet<string> Members)> _poolCache = new(StringComparer.Ordinal);
    private (HashSet<string> All, HashSet<string> Members) GrpPool(string name)
    {
        string key = name.ToLowerInvariant();
        lock (_grpLock)
        {
            if (_poolCache.TryGetValue(key, out var cached)) return cached;
            var all = new HashSet<string>(StringComparer.Ordinal);
            var members = new HashSet<string>(StringComparer.Ordinal);
            if (GrpCache().TryGetValue(key, out var file))
            {
                string dec;
                try { dec = DecryptedText(file.Path); } catch { dec = ""; }
                foreach (Match m in PoolRun.Matches(dec))
                {
                    string run = m.Value.ToLowerInvariant();
                    all.Add(run);
                    if (run.StartsWith("ecucomment:", StringComparison.Ordinal))
                        foreach (string w in Regex.Split(run.Substring("ecucomment:".Length), @"[,\s]+"))
                            if (w.Length > 0 && !ChassisWord.IsMatch(w))
                                members.Add(w);
                }
                all.UnionWith(members);
                all.Remove("t_grtb");
                members.Remove("t_grtb");
            }
            _poolCache[key] = (all, members);
            return (all, members);
        }
    }

    // does the group's string pool name this SGBD at all?
    private bool PoolMember(string grpName, string sgbd) =>
        GrpPool(grpName).All.Contains((sgbd ?? "").ToLowerInvariant());

    // the .grp whose ecucomment lists this SGBD: numeric groups first (address
    // order), then named groups, both sorted -- deterministic
    private string EcucommentScan(string sgbd)
    {
        string want = (sgbd ?? "").ToLowerInvariant();
        if (want.Length == 0) return null;
        var stems = GrpCache().Keys.OrderBy(s => s, StringComparer.Ordinal).ToList();
        foreach (bool numeric in new[] { true, false })
            foreach (string stem in stems)
                if (Regex.IsMatch(stem, "^d_00[0-9a-f]{2}$") == numeric &&
                    GrpPool(stem).Members.Contains(want))
                    return GrpCache()[stem].Stem;
        return null;
    }

    // BMW's own variant->group table: T_GRTB.PRG, the ZuordnungsTabelle every
    // newer D_* group delegates to. Rows are (ident, SGBD, GRUPPE, BAUREIHE,
    // description); across the whole table no SGBD maps to two groups, so the
    // lookup needs no chassis disambiguation.
    private Dictionary<string, string> _grtbCache;
    private string GrtbGroup(string sgbd)
    {
        lock (_grpLock)
        {
            if (_grtbCache == null)
            {
                _grtbCache = new Dictionary<string, string>(StringComparer.Ordinal);
                string path = Directory.Exists(_ecuPath)
                    ? Directory.EnumerateFiles(_ecuPath).FirstOrDefault(
                        f => string.Equals(Path.GetFileName(f), "t_grtb.prg",
                                           StringComparison.OrdinalIgnoreCase))
                    : null;
                if (path != null)
                {
                    string dec;
                    try { dec = DecryptedText(path); } catch { dec = ""; }
                    var runs = Regex.Matches(dec, @"[ -~]{2,}").Select(m => m.Value).ToList();
                    int i = 0;
                    while (i < runs.Count)
                    {
                        if (GrtbRow.IsMatch(runs[i]) && i + 2 < runs.Count &&
                            runs[i + 2].StartsWith("D_", StringComparison.OrdinalIgnoreCase))
                        {
                            string key = runs[i + 1].ToLowerInvariant();
                            if (!_grtbCache.ContainsKey(key)) _grtbCache[key] = runs[i + 2];
                            i += 3;
                        }
                        else i++;
                    }
                }
            }
            return _grtbCache.TryGetValue((sgbd ?? "").ToLowerInvariant(), out string g) ? g : null;
        }
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
        // motorcycle menus name entries <SGBD>W3 (MRDWAW3 -> MRDWA.PRG);
        // without this the variant scan below picks a stray token (RDC).
        var w3 = Regex.Match(code, "^(.*)w3$", RegexOptions.IgnoreCase);
        if (w3.Success && FindPrgCaseInsensitive(w3.Groups[1].Value.ToLowerInvariant()) != null)
            return w3.Groups[1].Value.ToLowerInvariant();
        // group/variant entries (e.g. gsds2 = auto trans, kombi = cluster) have no
        // direct .prg; their .ipo lists concrete variants (GS20, KOMBI46, ...).
        foreach (string variant in SgbdVariantsFromIpo(code, chassisId))
        {
            string hit = FindPrgCaseInsensitive(variant.ToLowerInvariant());
            if (hit != null) return hit;
        }
        // per-side seat modules: a-sitz ships only A-SITZ_F/A-SITZ_B
        foreach (string suf in new[] { "_f", "_b" })
        {
            string hit = FindPrgCaseInsensitive(code.ToLowerInvariant() + suf);
            if (hit != null) return hit;
        }
        // chassis-suffixed codes drop the E on disk: KGM_E60 -> KGM_60.prg
        var em = Regex.Match(code, @"^(.*_)[eE](\d+)$");
        if (em.Success)
        {
            string hit = FindPrgCaseInsensitive((em.Groups[1].Value + em.Groups[2].Value).ToLowerInvariant());
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
    // concurrent: /api/chassis/{id} takes no bus lock, so two requests can race here
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, List<List<string>>> _groupCache =
        new(StringComparer.OrdinalIgnoreCase);

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
