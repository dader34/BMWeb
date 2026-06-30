using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using EdiabasLib;
using EdiabasMac;

// sidecar: local JSON API bridging the Electron UI to the native EDIABAS engine.
// Electron spawns this and talks to it over HTTP.
//
//   GET  /api/health
//   GET  /api/chassis                       -> ["E36","E46",...]
//   GET  /api/chassis/{id}                  -> { id, description, sections:[...] }
//   GET  /api/ecu/{sgbd}/jobs               -> ["FS_LESEN", ...]            (offline)
//   GET  /api/ecu/{sgbd}/results/{job}      -> ["F_ORT_TEXT : ...", ...]    (offline)
//   GET  /api/port                          -> { port } | { port:null }
//   POST /api/ecu/{sgbd}/read?port=DEV      -> { codes:[ {F_ORT_TEXT,...} ] } (live)
//   POST /api/ecu/{sgbd}/clear?port=DEV     -> { ok:true }                    (live)

var builder = WebApplication.CreateBuilder(args);
builder.Logging.ClearProviders(); // keep stdout clean for parent
var app = builder.Build();

string root = FindRepoRoot();
string ecuPath = Path.Combine(root, "vendor", "EDIABAS", "Ecu");
string inpaRoot = Path.Combine(root, "vendor", "EC-APPS", "INPA");
string layoutDir = Path.Combine(root, "data", "inpa-layouts", "enriched");
var config = new InpaConfig(inpaRoot, ecuPath);

Diag NewDiag() => new Diag(ecuPath);

// K+DCAN is a single serial line: one transaction on the bus at a time.
// without serializing, a state poll and a code read collide and both fail
// (IFH_0009/0041). this semaphore queues every live bus op.
var busLock = new System.Threading.SemaphoreSlim(1, 1);
async Task<T> OnBus<T>(Func<T> work)
{
    await busLock.WaitAsync();
    try { return await Task.Run(work); }
    finally { busLock.Release(); }
}

// attach the K+DCAN serial transport to a Diag for a live job
bool AttachLive(Diag diag, string? portOverride)
{
    string? p = portOverride ?? AutoDetectPort();
    if (p == null) return false;
    diag.AttachSerial(p);
    return true;
}

app.MapGet("/api/health", () => Results.Json(new { ok = true, ecuPath, hasEcu = Directory.Exists(ecuPath) }));

app.MapGet("/api/chassis", () => Results.Json(config.ChassisIds()));

app.MapGet("/api/chassis/{id}", (string id) =>
{
    try
    {
        var ch = config.Load(id.ToUpperInvariant());
        return Results.Json(new
        {
            id = ch.Id,
            description = ch.Description,
            sections = ch.Sections.Select(s => new
            {
                key = s.Key,
                name = s.Name,
                ecus = s.Ecus.Select(e => new { code = e.Code, label = e.Label, sgbd = e.Sgbd })
            })
        });
    }
    catch (FileNotFoundException) { return Results.NotFound(new { error = $"unknown chassis {id}" }); }
});

app.MapGet("/api/ecu/{sgbd}/jobs", (string sgbd) =>
{
    using var diag = NewDiag();
    diag.Load(sgbd);
    return Results.Json(diag.Jobs());
});

app.MapGet("/api/ecu/{sgbd}/results/{job}", (string sgbd, string job) =>
{
    using var diag = NewDiag();
    diag.Load(sgbd);
    return Results.Json(diag.ResultsOf(job));
});

// a job's declared arguments (offline, via the _ARGUMENTS pseudo-job). lets the
// UI know which jobs need input (flash address/parameter, etc.) and their types.
app.MapGet("/api/ecu/{sgbd}/arguments/{job}", (string sgbd, string job) =>
{
    using var diag = NewDiag();
    diag.Load(sgbd);
    var args = new List<Dictionary<string, string>>();
    foreach (var set in diag.Run("_ARGUMENTS", job))
        args.Add(set.Where(kv => !kv.Key.StartsWith("_"))
                    .ToDictionary(kv => kv.Key, kv => Diag.Format(kv.Value)));
    return Results.Json(new { job, arguments = args });
});

// actuator tests (INPA F6 'Steuern'): STEUERN_X paired with STEUERN_X_ENDE
app.MapGet("/api/ecu/{sgbd}/activations", (string sgbd) =>
{
    using var diag = NewDiag();
    diag.Load(sgbd);
    var acts = MenuGen.Activations(diag.Jobs());
    return Results.Json(acts.Select(a => new
    {
        label = a.Label, start = a.Start, stop = a.Stop, momentary = a.Momentary
    }));
});

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
    string? file = (code != null ? FindLayoutFile(layoutDir, code) : null)
                   ?? FindLayoutFile(layoutDir, sgbd);
    if (file == null)
    {
        foreach (var suf in new[] { "ds0", "ds2", "ds1", "_n", "ds" })
            if (sgbd.EndsWith(suf, StringComparison.OrdinalIgnoreCase))
            {
                file = FindLayoutFile(layoutDir, sgbd[..^suf.Length]);
                if (file != null) break;
            }
    }
    if (file == null) return Results.NotFound(new { error = $"no layout for {sgbd}" });
    try
    {
        // serve verbatim, already in the renderer's shape
        var json = File.ReadAllText(file);
        return Results.Content(json, "application/json");
    }
    catch (Exception ex) { return Results.NotFound(new { error = ex.Message }); }
});

// English INPA-style grouped functional menu for an ECU (offline)
app.MapGet("/api/ecu/{sgbd}/menu", (string sgbd) =>
{
    using var diag = NewDiag();
    diag.Load(sgbd);
    var sections = MenuGen.Build(diag.Jobs());
    return Results.Json(new
    {
        sgbd,
        sections = sections.Select(s => new
        {
            section = s.Section,
            items = s.Items.Select(i => new { job = i.Job, label = i.Label, danger = i.Danger })
        })
    });
});

// battery + ignition (KL15) state, INPA's top "Battery / Ignition" lights.
// plain K+DCAN can't report line voltage to EDIABAS, so read from the DME:
// STATUS_UBATT (battery volts) + STATUS_DIGITAL_1 (KL15 input).
// real bus transaction: renderer polls on demand, not a fast timer. never throws.
app.MapGet("/api/state", async (string? port, string? sgbd) =>
{
    string ecu = string.IsNullOrEmpty(sgbd) ? "ms450ds0" : sgbd;
    return await OnBus<IResult>(() =>
    {
    try
    {
        using var diag = NewDiag();
        if (!AttachLive(diag, port)) return Results.Json(new { battery = (double?)null, ignition = (bool?)null, connected = false });
        diag.Load(ecu);

        double? bat = null; bool? ign = null;
        // battery voltage
        try
        {
            foreach (var s in diag.Run("STATUS_UBATT"))
                foreach (var kv in s)
                    if (kv.Key.Contains("UBAT") && kv.Key.EndsWith("WERT") &&
                        double.TryParse(Diag.Format(kv.Value), System.Globalization.NumberStyles.Any,
                            System.Globalization.CultureInfo.InvariantCulture, out var v)) bat = v;
        }
        catch { }
        // ignition = terminal 15 input (STAT_KL15_EIN_WERT in STATUS_DIGITAL_1)
        try
        {
            foreach (var s in diag.Run("STATUS_DIGITAL_1"))
                foreach (var kv in s)
                    if (kv.Key.Contains("KL15"))
                    {
                        var t = Diag.Format(kv.Value).Trim().ToLowerInvariant();
                        ign = t is "1" or "ein" or "on" or "true" || t.StartsWith("ein");
                    }
        }
        catch { }
        // if KL15 couldn't be read, leave ignition unknown. don't infer from
        // voltage: the DME reports >6V with the key off too, so it would lie.

        return Results.Json(new { battery = bat, ignition = ign, connected = true });
    }
    catch { return Results.Json(new { battery = (double?)null, ignition = (bool?)null, connected = false }); }
    });
});

app.MapGet("/api/port", () => Results.Json(new { port = AutoDetectPort() }));

// FS_LESEN result is "set 0 = status" then one set per fault. keep only sets
// carrying a fault id (F_ORT_NR/F_HEX_CODE); the trailing summary set has neither.
static List<Dictionary<string, string>> ReadFaults(Diag diag, string sgbd)
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
static bool IsUnknownLoc(Dictionary<string, string> f) =>
    f.TryGetValue("F_ORT_TEXT", out var t) && t != null &&
    t.Replace(" ", "").ToLowerInvariant().Contains("unbekannter");

app.MapPost("/api/ecu/{sgbd}/read", (string sgbd, string? port) => OnBus<IResult>(() =>
{
    using var diag = NewDiag();
    if (!AttachLive(diag, port)) return Results.BadRequest(new { error = "no interface: plug in the K+DCAN cable" });
    try
    {
        var codes = ReadFaults(diag, sgbd);
        // multi-variant merge: if the primary SGBD left any fault as "unknown
        // location", a sibling variant (e.g. zke5 -> zke5_s12) may label it.
        // read siblings only when needed, and only replace the unknown ones.
        var variants = config.SgbdVariants(sgbd);
        if (variants.Count > 1 && codes.Any(IsUnknownLoc))
        {
            foreach (var v in variants.Skip(1))
            {
                if (!codes.Any(IsUnknownLoc)) break;
                List<Dictionary<string, string>> alt;
                try { alt = ReadFaults(diag, v); } catch { continue; }
                foreach (var f in codes.Where(IsUnknownLoc).ToList())
                {
                    if (!f.TryGetValue("F_ORT_NR", out var nr)) continue;
                    var better = alt.FirstOrDefault(a =>
                        a.TryGetValue("F_ORT_NR", out var anr) && anr == nr && !IsUnknownLoc(a));
                    if (better != null)
                    {
                        int idx = codes.IndexOf(f);
                        codes[idx] = better; // keep the labeled variant's entry
                    }
                }
            }
        }
        return Results.Json(new { port, count = codes.Count, codes });
    }
    catch (Exception ex) { return Results.BadRequest(new { error = Explain(ex), raw = ex.Message }); }
}));

app.MapPost("/api/ecu/{sgbd}/clear", (string sgbd, string? port) => OnBus<IResult>(() =>
{
    using var diag = NewDiag();
    if (!AttachLive(diag, port)) return Results.BadRequest(new { error = "no interface: plug in the K+DCAN cable" });
    try
    {
        diag.Load(sgbd);
        diag.Run("FS_LOESCHEN");
        return Results.Json(new { ok = true });
    }
    catch (Exception ex) { return Results.BadRequest(new { error = Explain(ex), raw = ex.Message }); }
}));

// run any job live, return every result set as key/value strings
app.MapPost("/api/ecu/{sgbd}/run/{job}", (string sgbd, string job, string? port, string? arg) => OnBus<IResult>(() =>
{
    using var diag = NewDiag();
    if (!AttachLive(diag, port)) return Results.BadRequest(new { error = "no interface: plug in the K+DCAN cable" });
    try
    {
        diag.Load(sgbd);
        var sets = diag.Run(job, string.IsNullOrEmpty(arg) ? null : arg);
        var rows = sets.Select(s => s.ToDictionary(kv => kv.Key, kv => Diag.Format(kv.Value))).ToList();
        return Results.Json(new { port, job, sets = rows });
    }
    catch (Exception ex) { return Results.BadRequest(new { error = Explain(ex), raw = ex.Message }); }
}));

// ---- MS45 DME flashing (STAGE 1: read/backup only) ----

// identify the DME (VIN, HW/SW refs, programming status) before any flash op
app.MapPost("/api/flash/{sgbd}/identify", (string sgbd, string? port) => OnBus<IResult>(() =>
{
    string? p = port ?? AutoDetectPort();
    if (p == null) return Results.BadRequest(new { error = "no interface for flashing - use the K+DCAN cable" });
    try
    {
        using var fs = new FlashService(ecuPath, sgbd, p);
        var info = fs.Identify();
        return Results.Json(new {
            dmeType = info.DmeType, vin = info.Vin, hwRef = info.HwRef, swRef = info.SwRef,
            programmingStatus = info.ProgrammingStatus, diagProtocol = info.DiagProtocol, supported = info.Supported,
        });
    }
    catch (Exception ex) { return Results.BadRequest(new { error = ex.Message }); }
}));

// read/backup a DME region. region = data | full | mpc | fullbin. streams SSE
// progress, then binary as base64. 'fullbin' reads external flash AND MPC in one
// session (a second connection would collide with the ECU session) and emits two
// 'done:<name>' events, one per file.
app.MapPost("/api/flash/{sgbd}/read/{region}", async (HttpContext ctx, string sgbd, string region, string? port) =>
{
    string? p = port ?? AutoDetectPort();
    if (p == null) { ctx.Response.StatusCode = 400; await ctx.Response.WriteAsJsonAsync(new { error = "no interface - use the K+DCAN cable" }); return; }

    // region(s) to read in this single session
    var regions = region switch
    {
        "data"    => new[] { ("data", FlashService.DataRegion) },
        "full"    => new[] { ("full", FlashService.FullFlash) },
        "mpc"     => new[] { ("mpc",  FlashService.MpcData) },
        "fullbin" => new[] { ("full", FlashService.FullFlash), ("mpc", FlashService.MpcData) },
        _ => null,
    };
    if (regions == null) { ctx.Response.StatusCode = 400; await ctx.Response.WriteAsJsonAsync(new { error = "region must be data|full|mpc|fullbin" }); return; }

    ctx.Response.Headers["Content-Type"] = "text/event-stream";
    ctx.Response.Headers["Cache-Control"] = "no-cache";
    async Task Send(string ev, string data) { await ctx.Response.WriteAsync($"event: {ev}\ndata: {data}\n\n"); await ctx.Response.Body.FlushAsync(); }

    // hold the bus only for the actual read; release before streaming base64 so a
    // slow client cant stall the bus for other endpoints
    string err = null;
    var results = new List<(string name, byte[] dump)>();
    await busLock.WaitAsync();
    try
    {
        await Task.Run(() =>
        {
            using var fs = new FlashService(ecuPath, sgbd, p);
            // ROMX/LAR reads need security access (seed/key) + ECU-programming mode, once per session
            var info = fs.Identify();
            if (!fs.RequestSecurityAccess(info.DiagProtocol)) { err = "security access denied"; return; }
            foreach (var (name, rgn) in regions)
            {
                int lastPct = -1;
                _ = Send("region", name);   // signal which file is starting
                var dump = fs.ReadMemory(rgn, pct =>
                {
                    if (pct != lastPct) { lastPct = pct; _ = Send("progress", pct.ToString()); }
                });
                results.Add((name, dump));
            }
        });
    }
    catch (Exception ex) { err = ex.Message; }
    finally { busLock.Release(); }

    try
    {
        if (err != null) { await Send("error", err); return; }
        foreach (var (name, dump) in results)
            await Send("done", name + "|" + System.Convert.ToBase64String(dump));
    }
    catch (Exception ex) { await Send("error", ex.Message); }
});

// fixed loopback port the Electron app expects
app.Run("http://127.0.0.1:8777");

// find an enriched layout file for an SGBD, base name matched case-insensitively
// (.IPO files use mixed casing: MSD80, msd80n43, Ms43_sp2).
static string? FindLayoutFile(string dir, string sgbd)
{
    if (!Directory.Exists(dir)) return null;
    string exact = Path.Combine(dir, sgbd + ".json");
    if (File.Exists(exact)) return exact;
    foreach (var f in Directory.EnumerateFiles(dir, "*.json"))
        if (string.Equals(Path.GetFileNameWithoutExtension(f), sgbd, StringComparison.OrdinalIgnoreCase))
            return f;
    return null;
}

// map common EDIABAS failures to plain-English for the UI
static string Explain(Exception ex)
{
    string m = ex.Message ?? "";
    if (m.Contains("IFH-0009") || m.Contains("0009") || m.Contains("no response", StringComparison.OrdinalIgnoreCase)
        || m.Contains("EDIABAS_IFH_0009") || m.Contains("timeout", StringComparison.OrdinalIgnoreCase))
        return "No response from the ECU. Turn the ignition ON (key position 2 / engine running for the DME), and make sure the K+DCAN cable is firmly in the car's OBD-II port.";
    if (m.Contains("IFH-0018") || m.Contains("initialization", StringComparison.OrdinalIgnoreCase) || m.Contains("INIT"))
        return "Couldn't initialize the K-line to this ECU. Check the cable connection and that the ignition is on; some modules need the engine running.";
    if (m.Contains("IFH-0003") || m.Contains("interface", StringComparison.OrdinalIgnoreCase) && m.Contains("not", StringComparison.OrdinalIgnoreCase))
        return "Can't open the cable's serial port. Unplug and replug the K+DCAN cable (try a different USB port, not a hub).";
    if (m.Contains("SYS-0010") || m.Contains("0010"))
        return "The ECU is in the wrong session/mode. Cycle the ignition off and on, then try again.";
    if (m.Contains(".prg", StringComparison.OrdinalIgnoreCase) || m.Contains("not found", StringComparison.OrdinalIgnoreCase) || m.Contains("load", StringComparison.OrdinalIgnoreCase))
        return "Couldn't load this ECU's description file (SGBD). The ECU may be named differently for this car.";
    return "Diagnostic request failed: " + m;
}

static string? AutoDetectPort()
{
    foreach (var dev in Directory.EnumerateFiles("/dev", "tty.usbserial*")) return dev;
    foreach (var dev in Directory.EnumerateFiles("/dev", "cu.usbserial*")) return dev;
    return null;
}

static string FindRepoRoot()
{
    // explicit root (set by packaged app) wins
    string env = Environment.GetEnvironmentVariable("BMACW_ROOT");
    if (!string.IsNullOrEmpty(env) && Directory.Exists(Path.Combine(env, "vendor", "EDIABAS")))
        return env;

    var dir = new DirectoryInfo(AppContext.BaseDirectory);
    while (dir != null)
    {
        if (Directory.Exists(Path.Combine(dir.FullName, "vendor", "EDIABAS"))) return dir.FullName;
        dir = dir.Parent;
    }
    return Directory.GetCurrentDirectory();
}
