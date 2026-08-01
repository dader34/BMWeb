using System.Text.Json;
using BMacW.Host;
using Photino.NET;

namespace BMacW.Desktop;

// window.bmacw for Windows and Linux.
//
// Same contract as the macOS bridge -- the renderer calls the same 23 methods
// and cannot tell which host answered -- over a different channel. WKWebView
// has message handlers and user scripts; Photino has one string channel
// (SendWebMessage / RegisterWebMessageReceivedHandler) and no document-start
// injection, so the shim is delivered as the first thing the page runs
// instead (see DesktopApp's scheme handler).
//
// WHAT IS DELIBERATELY NOT HERE:
//
//   setDockIcon    -- a macOS dock affordance. The renderer already feature-
//                     detects it (core.js: `const dock = window.bmacw &&
//                     window.bmacw.setDockIcon`), so leaving it out is the
//                     supported way to say "this platform has no dock".
//   setTranslucent -- the Aero theme's vibrancy is an NSWindow property with
//                     no Photino equivalent; the theme still works, it is
//                     simply opaque.
//   savePdf        -- macOS gets this from WKWebView's own paginated PDF
//                     renderer. There is no such thing here, so the button
//                     hides itself (faults.js checks for it) and Print in the
//                     browser view does the same job.
//
// Everything that touches the CAR -- the cable, the THOR socket -- is here and
// is the same code the Mac runs, because it lives in BMacW.Host.
public sealed class DesktopBridge : IDisposable
{
    private readonly PhotinoWindow _window;
    private readonly SerialProxy _serial = new();
    private readonly TcpProxy _tcp = new();
    private readonly Dictionary<string, StreamWriter> _logs = new();
    private int _logSeq;

    public DesktopBridge(PhotinoWindow window) => _window = window;

    // The shim, injected as the page's first script. Mirrors the macOS
    // ShimSource one-for-one except for the transport and the three
    // capabilities above, which are absent rather than stubbed: a stub that
    // resolves would make the renderer draw a button that does nothing.
    public static string ShimSource(string version) => @"(() => {
      let seq = 0; const pending = new Map();
      window.__bmacwSettle = (id, result, err) => {
        const p = pending.get(id); if (!p) return; pending.delete(id);
        err ? p.reject(new Error(err)) : p.resolve(result);
      };
      const call = (fn, ...args) => new Promise((resolve, reject) => {
        const id = ++seq; pending.set(id, { resolve, reject });
        window.external.sendMessage(JSON.stringify({ id, fn, args }));
      });
      window.bmacw = {
        version: '" + version + @"',
        // BMacW is the macOS app -- the name is the pun. This build is the
        // same renderer on Windows and Linux, where it is BMWeb, as on the
        // web. index.html reads this before its first paint.
        appName: 'BMWeb',
        // ...and this window keeps its own titlebar, so the renderer must not
        // draw the macOS traffic lights over it.
        ownChrome: false,
        saveSettings: (j) => call('saveSettings', j),
        startLog: (n, h) => call('startLog', n, h),
        appendLog: (i, c) => call('appendLog', i, c),
        stopLog: (i) => call('stopLog', i),
        saveFile: (name, bytes) => {
          let s = '';
          const CH = 0x8000;         // String.fromCharCode has an arg limit
          for (let i = 0; i < bytes.length; i += CH) {
            s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
          }
          return call('saveFile', name, btoa(s));
        },
        winClose: () => call('winClose'),
        winMinimize: () => call('winMinimize'),
        winZoom: () => call('winZoom'),
        serialList: () => call('serialList'),
        serialOpen: (path, baud) => call('serialOpen', path || null, baud || 115200),
        serialClose: () => call('serialClose'),
        serialWrite: (bytes) => call('serialWrite', Array.from(bytes)),
        serialRead: () => call('serialRead'),
        serialFlush: () => call('serialFlush'),
        tcpOpen: (host, port) => call('tcpOpen', host || null, port || 0),
        tcpClose: () => call('tcpClose'),
        tcpWrite: (bytes) => call('tcpWrite', Array.from(bytes)),
        tcpRead: () => call('tcpRead'),
        wifiJoin: (ssid) => call('wifiJoin', ssid),
      };
    })();";

    // One message from the page: {id, fn, args}. Every reply goes back through
    // Settle, so the renderer's promise either resolves or rejects -- never
    // hangs, which would freeze whatever screen is waiting on it.
    public void OnMessage(string body)
    {
        long id = 0;
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            id = root.GetProperty("id").GetInt64();
            string fn = root.GetProperty("fn").GetString() ?? "";
            var args = root.TryGetProperty("args", out var a) ? a.Clone() : default;

            switch (fn)
            {
                case "saveSettings":
                    Settle(id, new { ok = HostSettings.Save(ArgString(args, 0)) });
                    return;

                case "startLog": StartLog(id, args); return;
                case "appendLog": Settle(id, AppendLog(args)); return;
                case "stopLog": Settle(id, StopLog(args)); return;
                case "saveFile": SaveFile(id, args); return;

                // Chromeless window controls. Zoom has no Photino equivalent,
                // so it maximizes, which is what the button means anyway.
                case "winClose": _window.Close(); Settle(id, Ok()); return;
                case "winMinimize": _window.SetMinimized(true); Settle(id, Ok()); return;
                case "winZoom": _window.SetMaximized(true); Settle(id, Ok()); return;

                case "serialList": Settle(id, SerialProxy.ListPorts()); return;
                case "serialOpen":
                    Settle(id, new { port = _serial.Open(ArgString(args, 0), ArgInt(args, 1)) });
                    return;
                case "serialClose": _serial.Close(); Settle(id, Ok()); return;
                case "serialWrite": _serial.Write(ArgBytes(args, 0)); Settle(id, Ok()); return;
                case "serialRead": Settle(id, _serial.ReadAvailable()); return;
                case "serialFlush": _serial.Flush(); Settle(id, Ok()); return;

                // The THOR's socket. Connecting can block for seconds, so it
                // runs off the UI thread exactly as the macOS bridge does --
                // that was a real beachball there, and would be a frozen
                // window here.
                case "tcpOpen":
                {
                    string host = ArgString(args, 0) ?? "192.168.4.1";
                    int port = ArgInt(args, 1);
                    Task.Run(() =>
                    {
                        try { _tcp.Open(host, port); Settle(id, new { host, port }); }
                        catch (Exception ex) { Settle(id, null, ex.Message); }
                    });
                    return;
                }
                case "tcpClose": _tcp.Close(); Settle(id, Ok()); return;
                case "tcpWrite": _tcp.Write(ArgBytes(args, 0)); Settle(id, Ok()); return;
                case "tcpRead": Settle(id, _tcp.ReadAvailable()); return;

                case "wifiJoin": WifiJoin(id, args); return;

                default:
                    Settle(id, null, $"unknown bridge call: {fn}");
                    return;
            }
        }
        catch (Exception ex)
        {
            Settle(id, null, ex.Message);
        }
    }

    // ---- WiFi ---------------------------------------------------------------
    // Joining the THOR's access point. Windows can do it outright (netsh);
    // Linux only if NetworkManager is present, which is the common case but
    // not a given. Where it cannot, say so plainly rather than failing
    // silently -- the renderer shows the detail, and switching networks by
    // hand is a perfectly good fallback.
    private void WifiJoin(long id, JsonElement args)
    {
        string ssid = ArgString(args, 0) ?? "Thor_Wifi";
        Task.Run(() =>
        {
            string output;
            bool joined = false;
            try
            {
                if (OperatingSystem.IsWindows())
                {
                    // netsh joins a profile the machine already knows. The
                    // THOR's AP is open, so connecting to it once by hand
                    // creates that profile and this works thereafter.
                    output = RunTool("netsh", $"wlan connect name=\"{ssid}\"");
                    joined = output.Contains("completed successfully",
                                             StringComparison.OrdinalIgnoreCase);
                }
                else
                {
                    output = RunTool("nmcli", $"device wifi connect \"{ssid}\"");
                    joined = output.Contains("successfully activated",
                                             StringComparison.OrdinalIgnoreCase);
                }
            }
            catch (Exception ex)
            {
                // no netsh/nmcli: not an error worth throwing, just not a
                // thing this machine can do for you
                output = OperatingSystem.IsWindows()
                    ? $"could not run netsh ({ex.Message}); join {ssid} from the Wi-Fi menu"
                    : $"could not run nmcli ({ex.Message}); join {ssid} from your network settings";
            }
            Settle(id, new { joined, detail = output.Trim() });
        });
    }

    private static string RunTool(string path, string arguments)
    {
        var psi = new System.Diagnostics.ProcessStartInfo(path, arguments)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        using var p = System.Diagnostics.Process.Start(psi)
            ?? throw new InvalidOperationException($"could not run {path}");
        string output = p.StandardOutput.ReadToEnd() + p.StandardError.ReadToEnd();
        p.WaitForExit(20000);
        return output;
    }

    // ---- files --------------------------------------------------------------

    private void SaveFile(long id, JsonElement args)
    {
        string suggested = ArgString(args, 0) ?? "bmacw.bin";
        string b64 = ArgString(args, 1) ?? "";
        string? path = _window.ShowSaveFile("Save", DefaultDir(suggested),
                                            FiltersFor(suggested));
        if (string.IsNullOrEmpty(path)) { Settle(id, new { ok = false }); return; }
        File.WriteAllBytes(path, Convert.FromBase64String(b64));
        Settle(id, new { ok = true, path });
    }

    // ---- CSV log streams (Status multi-watch stream-to-file) ----------------

    private void StartLog(long id, JsonElement args)
    {
        string suggested = ArgString(args, 0) ?? "bmacw-log.csv";
        string? path = _window.ShowSaveFile("Stream Status values to CSV",
                                            DefaultDir(suggested),
                                            new[] { ("CSV", new[] { "csv" }) });
        if (string.IsNullOrEmpty(path)) { Settle(id, new { ok = false }); return; }

        var writer = new StreamWriter(path, append: false);
        if (args.ValueKind == JsonValueKind.Array && args.GetArrayLength() > 1
            && args[1].ValueKind == JsonValueKind.Array)
        {
            writer.WriteLine(string.Join(',',
                args[1].EnumerateArray().Select(e => e.GetString() ?? "")));
        }
        writer.Flush();
        string handle = $"log{++_logSeq}";
        _logs[handle] = writer;
        Settle(id, new { ok = true, id = handle, path });
    }

    private object AppendLog(JsonElement args)
    {
        string? handle = ArgString(args, 0);
        if (handle == null || !_logs.TryGetValue(handle, out var w))
            return new { ok = false };
        // one CSV row per call; flushed so a crash keeps what was logged
        if (args.ValueKind == JsonValueKind.Array && args.GetArrayLength() > 1)
        {
            var cells = args[1].ValueKind == JsonValueKind.Array
                ? args[1].EnumerateArray().Select(CellText)
                : new[] { CellText(args[1]) }.AsEnumerable();
            w.WriteLine(string.Join(',', cells));
            w.Flush();
        }
        return Ok();
    }

    private object StopLog(JsonElement args)
    {
        string? handle = ArgString(args, 0);
        if (handle != null && _logs.Remove(handle, out var w))
        {
            w.Flush();
            w.Dispose();
            return Ok();
        }
        return new { ok = false };
    }

    // a CSV cell: quote anything holding a comma or a quote
    private static string CellText(JsonElement e)
    {
        string s = e.ValueKind == JsonValueKind.String
            ? e.GetString() ?? "" : e.ToString();
        return s.Contains(',') || s.Contains('"')
            ? $"\"{s.Replace("\"", "\"\"")}\"" : s;
    }

    // ---- plumbing -----------------------------------------------------------

    private static string DefaultDir(string suggested) => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        "Downloads", suggested);

    private static (string, string[])[] FiltersFor(string name)
    {
        string ext = Path.GetExtension(name).TrimStart('.');
        return string.IsNullOrEmpty(ext)
            ? new[] { ("All files", new[] { "*" }) }
            : new[] { (ext.ToUpperInvariant(), new[] { ext }),
                      ("All files", new[] { "*" }) };
    }

    private static object Ok() => new { ok = true };

    private static readonly JsonSerializerOptions JsonOpts = new();

    // Resolve or reject the renderer's promise. Photino marshals
    // SendWebMessage to the UI thread itself, so this is safe from the task
    // threads tcpOpen and wifiJoin run on.
    private void Settle(long id, object? result, string? error = null)
    {
        string js = error == null
            ? $"window.__bmacwSettle({id}, {JsonSerializer.Serialize(result, JsonOpts)});"
            : $"window.__bmacwSettle({id}, null, {JsonSerializer.Serialize(error, JsonOpts)});";
        try { _window.SendWebMessage(js); } catch { /* window is going away */ }
    }

    private static string? ArgString(JsonElement args, int i) =>
        args.ValueKind == JsonValueKind.Array && args.GetArrayLength() > i
        && args[i].ValueKind == JsonValueKind.String ? args[i].GetString() : null;

    private static int ArgInt(JsonElement args, int i) =>
        args.ValueKind == JsonValueKind.Array && args.GetArrayLength() > i
        && args[i].ValueKind == JsonValueKind.Number ? args[i].GetInt32() : 0;

    private static byte[] ArgBytes(JsonElement args, int i)
    {
        if (args.ValueKind != JsonValueKind.Array || args.GetArrayLength() <= i)
            return Array.Empty<byte>();
        var a = args[i];
        if (a.ValueKind != JsonValueKind.Array) return Array.Empty<byte>();
        var buf = new byte[a.GetArrayLength()];
        int n = 0;
        foreach (var e in a.EnumerateArray()) buf[n++] = (byte)e.GetInt32();
        return buf;
    }

    public void Dispose()
    {
        foreach (var w in _logs.Values) { try { w.Flush(); w.Dispose(); } catch { } }
        _logs.Clear();
        _serial.Dispose();
        _tcp.Dispose();
    }
}
