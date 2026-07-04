using System.Text;
using System.Text.Json;
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
        setTranslucent: (o) => call('setTranslucent', o),
        setDockIcon: (d) => call('setDockIcon', d),
        winClose: () => call('winClose'),
        winMinimize: () => call('winMinimize'),
        winZoom: () => call('winZoom'),
      };
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
                case "saveSettings": Settle(webView, id, SaveSettings(args)); return;
                case "startLog": StartLog(webView, id, args); return;
                case "appendLog": Settle(webView, id, AppendLog(args)); return;
                case "stopLog": Settle(webView, id, StopLog(args)); return;
                case "savePdf": SavePdf(webView, id, args); return;
                case "setTranslucent": Settle(webView, id, SetTranslucent(args)); return;
                case "setDockIcon": Settle(webView, id, SetDockIcon(args)); return;
                case "winClose": _window.PerformClose(this); Settle(webView, id, Ok()); return;
                case "winMinimize": _window.Miniaturize(this); Settle(webView, id, Ok()); return;
                case "winZoom": _window.Zoom(this); Settle(webView, id, Ok()); return;
                default: Settle(webView, id, null, $"unknown bridge fn '{fn}'"); return;
            }
        }
        catch (Exception ex)
        {
            Settle(webView, id, null, ex.Message);
        }
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
        base.Dispose();
    }
}
