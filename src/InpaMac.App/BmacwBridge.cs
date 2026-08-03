using System.Text;
using System.Text.Json;
using BMacW.Host;
using AppKit;
using CoreGraphics;
using Foundation;
using WebKit;

namespace InpaMac.App;

// Native replacement for the Electron preload bridge: the renderer's
// window.bmacw calls arrive here as WKScriptMessageHandler messages
// ({id, fn, args}) and settle back as promises via window.__bmacwSettle.
// Surface and semantics mirror app/preload.js + main.js exactly:
// CSV log streams, paginated PDF export, translucency, dock icon, and the
// frameless-window traffic-light controls.
public sealed class BmacwBridge : NSObject, IWKScriptMessageHandler, IDisposable
{
    private readonly NSWindow _window;
    private readonly SerialProxy _serial = new();
    private readonly TcpProxy _tcp = new();
    private readonly Dictionary<string, StreamWriter> _logs = new();
    private int _logSeq;
    private WKWebView? _pdfWorker; // kept alive while rendering a report

    public BmacwBridge(NSWindow window) => _window = window;

    // injected at document start: promise plumbing + the bmacw surface
    public const string ShimSource = @"(() => {
      let seq = 0; const pending = new Map();
      window.__bmacwSettle = (id, result, err) => {
        const p = pending.get(id); if (!p) return; pending.delete(id);
        err ? p.reject(new Error(err)) : p.resolve(result);
      };
      const call = (fn, ...args) => new Promise((resolve, reject) => {
        const id = ++seq; pending.set(id, { resolve, reject });
        webkit.messageHandlers.bmacw.postMessage(JSON.stringify({ id, fn, args }));
      });
      window.bmacw = {
        version: 'native',
        saveSettings: (j) => call('saveSettings', j),
        startLog: (n, h) => call('startLog', n, h),
        appendLog: (i, c) => call('appendLog', i, c),
        stopLog: (i) => call('stopLog', i),
        savePdf: (n, h) => call('savePdf', n, h),
        // Write bytes to a path the user picks. BASE64, not a number array:
        // the channel is JSON, where a byte costs ~3.5 characters as a number
        // and 1.33 as base64. A 10 MB zip is the difference between 36 MB of
        // text and 13 MB.
        saveFile: (name, bytes) => {
          let s = '';
          const CH = 0x8000; // chunk: String.fromCharCode has an arg limit
          for (let i = 0; i < bytes.length; i += CH) {
            s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
          }
          return call('saveFile', name, btoa(s));
        },
        setTranslucent: (o) => call('setTranslucent', o),
        setDockIcon: (d) => call('setDockIcon', d),
        winClose: () => call('winClose'),
        winMinimize: () => call('winMinimize'),
        winZoom: () => call('winZoom'),
        winDrag: () => call('winDrag'),
        // The cable. WKWebView has no Web Serial (Chrome does, which is how
        // the web build reaches the bus), so the shell moves the bytes and
        // the VM in the renderer does everything else. Byte arrays cross as
        // plain number arrays: the message channel is JSON.
        serialList: () => call('serialList'),
        serialOpen: (path, baud, parity) => call('serialOpen', path || null, baud || 115200, parity || 'none'),
        serialClose: () => call('serialClose'),
        serialWrite: (bytes) => call('serialWrite', Array.from(bytes)),
        serialRead: () => call('serialRead'),
        serialFlush: () => call('serialFlush'),
        // The THOR WiFi adapter: raw TCP the shell owns. A WKWebView cannot
        // open sockets; the web build runs a local relay for the same reason.
        tcpOpen: (host, port) => call('tcpOpen', host || null, port || 0),
        tcpClose: () => call('tcpClose'),
        tcpWrite: (bytes) => call('tcpWrite', Array.from(bytes)),
        tcpRead: () => call('tcpRead'),
        // join a WiFi network (the THOR's AP); opens the system Wi-Fi
        // picker instead when it cannot
        wifiJoin: (ssid) => call('wifiJoin', ssid),
      };
      // WKWebView ignores -webkit-app-region, so the Electron-era drag CSS on
      // .topbar/.splash does nothing here: reimplement it by handing the
      // mousedown to the native window (performWindowDragWithEvent).
      window.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (!e.target.closest('.topbar, .splash')) return;
        if (e.target.closest('button, a, input, select, textarea, [contenteditable]')) return;
        e.preventDefault(); // the window takes the drag: no text selection
        window.bmacw.winDrag();
      });
    })();";

    public void DidReceiveScriptMessage(WKUserContentController controller,
                                        WKScriptMessage message)
    {
        var webView = message.WebView;
        long id = 0;
        try
        {
            using var doc = JsonDocument.Parse(message.Body.ToString() ?? "{}");
            var root = doc.RootElement;
            id = root.GetProperty("id").GetInt64();
            string fn = root.GetProperty("fn").GetString() ?? "";
            var args = root.TryGetProperty("args", out var a) ? a.Clone() : default;

            switch (fn)
            {
                case "saveSettings":
                    var saved = SaveSettings(args);
                    // the injected __bmacwSettings script is otherwise a
                    // launch-time snapshot: a page reload right after a save
                    // (the Adapter setting does exactly that) would boot from
                    // stale values. Re-inject so reloads see what was saved.
                    RefreshUserScripts();
                    Settle(webView, id, saved);
                    return;
                case "startLog": StartLog(webView, id, args); return;
                case "appendLog": Settle(webView, id, AppendLog(args)); return;
                case "stopLog": Settle(webView, id, StopLog(args)); return;
                case "savePdf": SavePdf(webView, id, args); return;
                case "saveFile": SaveFile(webView, id, args); return;
                case "setTranslucent": Settle(webView, id, SetTranslucent(args)); return;
                case "setDockIcon": Settle(webView, id, SetDockIcon(args)); return;
                case "winClose": _window.PerformClose(this); Settle(webView, id, Ok()); return;
                case "winMinimize": _window.Miniaturize(this); Settle(webView, id, Ok()); return;
                case "winZoom": _window.Zoom(this); Settle(webView, id, Ok()); return;
                case "winDrag": WinDrag(); Settle(webView, id, Ok()); return;
                case "serialList": Settle(webView, id, SerialProxy.ListPorts()); return;
                case "serialOpen":
                    Settle(webView, id, new { port = _serial.Open(ArgString(args, 0), ArgInt(args, 1), ArgString(args, 2)) });
                    return;
                case "serialClose": _serial.Close(); Settle(webView, id, Ok()); return;
                case "serialWrite": _serial.Write(ArgBytes(args, 0)); Settle(webView, id, Ok()); return;
                case "serialRead": Settle(webView, id, _serial.ReadAvailable()); return;
                case "serialFlush": _serial.Flush(); Settle(webView, id, Ok()); return;
                case "tcpOpen":
                {
                    // OFF the UI thread: connect blocks up to its 4 s timeout,
                    // and this handler runs on the main thread -- an adapter
                    // that is not there must not beachball the whole app.
                    string? tcpHost = ArgString(args, 0);
                    int tcpPort = ArgInt(args, 1);
                    Task.Run(() =>
                    {
                        try
                        {
                            var opened = new { port = _tcp.Open(tcpHost, tcpPort) };
                            InvokeOnMainThread(() => Settle(webView, id, opened));
                        }
                        catch (Exception ex)
                        {
                            InvokeOnMainThread(() => Settle(webView, id, null, ex.Message));
                        }
                    });
                    return;
                }
                case "tcpClose": _tcp.Close(); Settle(webView, id, Ok()); return;
                case "tcpWrite": _tcp.Write(ArgBytes(args, 0)); Settle(webView, id, Ok()); return;
                case "tcpRead": Settle(webView, id, _tcp.ReadAvailable()); return;
                case "wifiJoin": WifiJoin(webView, id, args); return;
                default: Settle(webView, id, null, $"unknown bridge fn '{fn}'"); return;
            }
        }
        catch (Exception ex)
        {
            Settle(webView, id, null, ex.Message);
        }
    }

    // ---- WiFi ----------------------------------------------------------------
    // Get the machine onto the adapter's network. networksetup joins open and
    // previously-known networks with no password and no location permission
    // (CoreWLAN scans hide SSIDs without one on modern macOS). Joining takes
    // seconds and this handler runs on the UI thread, so do it on a task. If
    // the join fails, open the system Wi-Fi picker so the user can.
    private void WifiJoin(WKWebView? webView, long id, JsonElement args)
    {
        string ssid = ArgString(args, 0) ?? "Thor_Wifi";
        Task.Run(() =>
        {
            string output;
            try
            {
                string device = "en0";
                var list = RunTool("/usr/sbin/networksetup", "-listallhardwareports");
                var m = System.Text.RegularExpressions.Regex.Match(
                    list, @"Hardware Port: Wi-Fi\s*\nDevice: (\w+)");
                if (m.Success) device = m.Groups[1].Value;
                output = RunTool("/usr/sbin/networksetup",
                    $"-setairportnetwork {device} \"{ssid}\"").Trim();
            }
            catch (Exception ex) { output = ex.Message; }
            // success is silent (or "already associated"); anything else is a
            // complaint ("Failed to join network...", "Could not find network...")
            bool joined = output.Length == 0
                || output.Contains("already associated", StringComparison.OrdinalIgnoreCase);
            InvokeOnMainThread(() =>
            {
                if (!joined)
                {
                    NSWorkspace.SharedWorkspace.OpenUrl(new NSUrl(
                        "x-apple.systempreferences:com.apple.wifi-settings-extension"));
                }
                Settle(webView, id, new { joined, detail = output });
            });
        });
    }

    private static string RunTool(string path, string arguments)
    {
        var psi = new System.Diagnostics.ProcessStartInfo(path, arguments)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        using var p = System.Diagnostics.Process.Start(psi)
            ?? throw new InvalidOperationException($"could not run {path}");
        string output = p.StandardOutput.ReadToEnd() + p.StandardError.ReadToEnd();
        p.WaitForExit(20000);
        return output;
    }

    // ---- durable settings ----------------------------------------------------
    // localStorage is origin-scoped and the app's port is ephemeral, so the
    // renderer's settings would silently reset every launch. The shell owns the
    // durable copy: saved here on every change, injected at document start by
    // AppDelegate as window.__bmacwSettings.

    public static string SettingsPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "BMacW", "settings.json");

    // durable settings as a JS expression ("null" when absent/corrupt)
    public static string LoadSettingsJs()
    {
        try
        {
            string json = File.ReadAllText(SettingsPath);
            using var _ = JsonDocument.Parse(json); // must be valid JSON
            return json;
        }
        catch { return "null"; }
    }

    // The document-start user scripts (settings + bmacw surface), owned here
    // so a settings save can rebuild them: WKUserContentController re-injects
    // the same script text on every load, so without a refresh the injected
    // settings stay frozen at whatever they were when the app launched.
    private WKUserContentController? _controller;
    private string _shimSource = "";

    public void AttachUserScripts(WKUserContentController controller, string shimSource)
    {
        _controller = controller;
        _shimSource = shimSource;
        RefreshUserScripts();
    }

    private void RefreshUserScripts()
    {
        if (_controller == null) return;
        _controller.RemoveAllUserScripts();
        _controller.AddUserScript(new WKUserScript(
            new NSString($"window.__bmacwSettings = {LoadSettingsJs()};"),
            WKUserScriptInjectionTime.AtDocumentStart, isForMainFrameOnly: true));
        _controller.AddUserScript(new WKUserScript(
            new NSString(_shimSource),
            WKUserScriptInjectionTime.AtDocumentStart, isForMainFrameOnly: true));
    }

    private static object SaveSettings(JsonElement args)
    {
        string? json = ArgString(args, 0);
        if (json == null) return new { ok = false };
        using var _ = JsonDocument.Parse(json); // reject junk before writing
        Directory.CreateDirectory(Path.GetDirectoryName(SettingsPath)!);
        File.WriteAllText(SettingsPath, json);
        return Ok();
    }

    // ---- CSV log streams (Status multi-watch stream-to-file) ----------------

    private void StartLog(WKWebView? webView, long id, JsonElement args)
    {
        string suggested = ArgString(args, 0) ?? "bmacw-log.csv";
        var header = args.ValueKind == JsonValueKind.Array && args.GetArrayLength() > 1
            ? args[1] : default;

        var panel = NSSavePanel.SavePanel;
        panel.Title = "Stream Status values to CSV";
        panel.NameFieldStringValue = suggested;
        panel.BeginSheet(_window, result =>
        {
            if (result != 1 || panel.Url?.Path is not string path)
            {
                Settle(webView, id, new { ok = false });
                return;
            }
            var writer = new StreamWriter(path, append: false);
            if (header.ValueKind == JsonValueKind.Array)
                writer.WriteLine(string.Join(",",
                    header.EnumerateArray().Select(c => CsvCell(c.ToString()))));
            string logId = (++_logSeq).ToString();
            _logs[logId] = writer;
            Settle(webView, id, new { ok = true, id = logId, path });
        });
    }

    private object AppendLog(JsonElement args)
    {
        string? logId = ArgString(args, 0);
        if (logId == null || !_logs.TryGetValue(logId, out var writer))
            return new { ok = false };
        var cells = args[1];
        writer.WriteLine(string.Join(",",
            cells.EnumerateArray().Select(c => CsvCell(c.ToString()))));
        return Ok();
    }

    private object StopLog(JsonElement args)
    {
        string? logId = ArgString(args, 0);
        if (logId != null && _logs.Remove(logId, out var writer)) writer.Dispose();
        return Ok();
    }

    private static string CsvCell(string? v)
    {
        string s = v ?? "";
        return s.IndexOfAny(new[] { '"', ',', '\n' }) >= 0
            ? "\"" + s.Replace("\"", "\"\"") + "\"" : s;
    }

    // ---- PDF report export ---------------------------------------------------

    // save dialog → offscreen WKWebView renders the report HTML → paginated
    // Letter PDF via NSPrintOperation (0.5in margins, like Electron's
    // Any file the renderer has built, to a location the user chooses.
    // The offline export assembles a zip in the page; without this it would
    // land in the browser's Downloads folder, which inside a WKWebView is
    // neither visible nor chosen.
    private void SaveFile(WKWebView? webView, long id, JsonElement args)
    {
        string suggested = ArgString(args, 0) ?? "bmacw-export.zip";
        byte[] bytes = Convert.FromBase64String(ArgString(args, 1) ?? "");

        var panel = NSSavePanel.SavePanel;
        panel.Title = "Save offline copy";
        panel.NameFieldStringValue = suggested;
        panel.BeginSheet(_window, result =>
        {
            if (result != 1 || panel.Url?.Path is not string dest)
            {
                Settle(webView, id, new { ok = false, cancelled = true });
                return;
            }
            try
            {
                File.WriteAllBytes(dest, bytes);
                Settle(webView, id, new { ok = true, path = dest });
            }
            catch (Exception ex)
            {
                Settle(webView, id, null, ex.Message);
            }
        });
    }

    // printToPDF), written straight to the chosen path.
    private void SavePdf(WKWebView? webView, long id, JsonElement args)
    {
        string suggested = ArgString(args, 0) ?? "bmacw-faults.pdf";
        string html = ArgString(args, 1) ?? "";

        var panel = NSSavePanel.SavePanel;
        panel.Title = "Save fault report as PDF";
        panel.NameFieldStringValue = suggested;
        panel.BeginSheet(_window, result =>
        {
            if (result != 1 || panel.Url is not NSUrl dest)
            {
                Settle(webView, id, new { ok = false });
                return;
            }
            // 7.5in content width at 72dpi so Letter pagination lays out right
            _pdfWorker = new WKWebView(new CGRect(0, 0, 540, 720),
                                       new WKWebViewConfiguration());
            _pdfWorker.NavigationDelegate = new PdfNavDelegate(() =>
            {
                try
                {
                    var info = new NSPrintInfo
                    {
                        PaperName = "na-letter",
                        TopMargin = 36, BottomMargin = 36,
                        LeftMargin = 36, RightMargin = 36,
                        HorizontalPagination = NSPrintingPaginationMode.Fit,
                        // raw value of the NSPrintSaveJob constant
                        JobDisposition = "NSPrintSaveJob",
                    };
                    info.Dictionary.SetValueForKey(dest,
                        new NSString("NSJobSavingURL"));
                    var op = _pdfWorker!.GetPrintOperation(info);
                    op.ShowsPrintPanel = false;
                    op.ShowsProgressPanel = false;
                    op.RunOperation();
                    Settle(webView, id, new { ok = true, path = dest.Path });
                }
                catch (Exception ex)
                {
                    Settle(webView, id, new { ok = false, error = ex.Message });
                }
                finally { _pdfWorker = null; }
            });
            _pdfWorker.LoadHtmlString(html, baseUrl: null!);
        });
    }

    private sealed class PdfNavDelegate : WKNavigationDelegate
    {
        private readonly Action _onLoaded;
        public PdfNavDelegate(Action onLoaded) => _onLoaded = onLoaded;
        public override void DidFinishNavigation(WKWebView webView,
                                                 WKNavigation navigation)
            => _onLoaded();
    }

    // start a native window drag from the renderer's topbar mousedown. the
    // script message arrives while the mouse-down is still the current event,
    // so it can seed performWindowDragWithEvent directly.
    private void WinDrag()
    {
        var ev = NSApplication.SharedApplication.CurrentEvent;
        if (ev != null) _window.PerformWindowDrag(ev);
    }

    // ---- window / app appearance ----------------------------------------------

    private object SetTranslucent(JsonElement args)
    {
        bool on = args.ValueKind == JsonValueKind.Array
                  && args.GetArrayLength() > 0
                  && args[0].ValueKind == JsonValueKind.True;
        _window.IsOpaque = !on;
        _window.BackgroundColor = on ? NSColor.Clear
                                     : NSColor.FromRgb(0x0b, 0x0f, 0x14);
        return Ok();
    }

    private static object SetDockIcon(JsonElement args)
    {
        string? dataUrl = ArgString(args, 0);
        int comma = dataUrl?.IndexOf(',') ?? -1;
        if (dataUrl == null || comma < 0) return new { ok = false };
        var bytes = new NSData(dataUrl[(comma + 1)..],
                               NSDataBase64DecodingOptions.None);
        NSApplication.SharedApplication.ApplicationIconImage = new NSImage(bytes);
        return Ok();
    }

    // ---- plumbing ---------------------------------------------------------------

    private static object Ok() => new { ok = true };

    private static int ArgInt(JsonElement args, int index) =>
        args.ValueKind == JsonValueKind.Array && args.GetArrayLength() > index
        && args[index].ValueKind == JsonValueKind.Number
            ? args[index].GetInt32() : 0;

    // A byte array arrives as a JSON number array -- the message channel is
    // text, so there is no typed-array to unwrap.
    private static byte[] ArgBytes(JsonElement args, int index)
    {
        if (args.ValueKind != JsonValueKind.Array || args.GetArrayLength() <= index)
            return Array.Empty<byte>();
        var a = args[index];
        if (a.ValueKind != JsonValueKind.Array) return Array.Empty<byte>();
        var bytes = new byte[a.GetArrayLength()];
        int i = 0;
        foreach (var el in a.EnumerateArray()) bytes[i++] = (byte)(el.GetInt32() & 0xff);
        return bytes;
    }

    private static string? ArgString(JsonElement args, int index) =>
        args.ValueKind == JsonValueKind.Array && args.GetArrayLength() > index
        && args[index].ValueKind == JsonValueKind.String
            ? args[index].GetString() : null;

    private static void Settle(WKWebView? webView, long id, object? result,
                               string? error = null)
    {
        if (webView == null) return;
        string resultJson = result == null ? "null" : JsonSerializer.Serialize(result);
        string errJson = error == null ? "null" : JsonSerializer.Serialize(error);
        webView.EvaluateJavaScript(
            $"window.__bmacwSettle({id}, {resultJson}, {errJson})", null!);
    }

    public new void Dispose()
    {
        foreach (var w in _logs.Values) w.Dispose();
        _logs.Clear();
        // Release the cable: a port still held by a dead app blocks the next
        // launch, and the FTDI driver does not always reap it promptly.
        _serial.Dispose();
        base.Dispose();
    }
}
