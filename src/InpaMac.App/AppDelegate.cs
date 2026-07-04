using AppKit;
using CoreGraphics;
using EdiabasMac;
using Foundation;
using InpaMac.Server;
using WebKit;

namespace InpaMac.App;

// Single-binary host: starts the JSON API in-process on an ephemeral loopback
// port (Kestrel is an implementation detail, not a second process), then opens
// the existing renderer in a WKWebView. Window chrome matches the Electron
// shell: hidden titlebar, renderer-drawn traffic lights, draggable background.
public sealed class AppDelegate : NSApplicationDelegate
{
    private Microsoft.AspNetCore.Builder.WebApplication? _server;
    private ServerState? _state;
    private NSWindow? _window;
    private WKWebView? _webView;
    private BmacwBridge? _bridge;

    public override void DidFinishLaunching(NSNotification notification)
    {
        string root = Paths.FindRepoRoot();
        string rendererDir = Path.Combine(root, "app", "renderer");

        // engine + API in-process; port 0 = let the kernel pick a free one
        (_server, _state) = ServerHost.Build(Array.Empty<string>(), rendererDir);
        _server.Urls.Add("http://127.0.0.1:0");
        _server.StartAsync().GetAwaiter().GetResult();
        string origin = _server.Urls.First();

        BuildMenu();
        _window = BuildWindow();
        _bridge = new BmacwBridge(_window);
        _webView = BuildWebView(_bridge);
        _window.ContentView = _webView;

        _webView.LoadRequest(new NSUrlRequest(new NSUrl(
            $"{origin}/index.html?api={Uri.EscapeDataString(origin)}")));
        _window.MakeKeyAndOrderFront(this);
        NSApplication.SharedApplication.ActivateIgnoringOtherApps(true);
    }

    public override bool ApplicationShouldTerminateAfterLastWindowClosed(
        NSApplication sender) => true;

    public override void WillTerminate(NSNotification notification)
    {
        // same shutdown discipline as the sidecar: reset any in-progress
        // flash and release the FTDI port before the process dies.
        // NO graceful Kestrel stop here: blocking the AppKit main thread on
        // StopAsync deadlocks (sync-over-async against the run-loop context)
        // and the process exits right after this anyway — Shutdown() already
        // released everything that matters.
        _state?.Shutdown();
        _bridge?.Dispose();
    }

    // frameless-feel window: real titlebar kept for resize/fullscreen
    // behavior but fully transparent and hidden; the renderer draws its own
    // traffic lights (wired through the bridge) exactly as under Electron.
    private static NSWindow BuildWindow()
    {
        var style = NSWindowStyle.Titled | NSWindowStyle.Closable |
                    NSWindowStyle.Miniaturizable | NSWindowStyle.Resizable |
                    NSWindowStyle.FullSizeContentView;
        var win = new NSWindow(new CGRect(0, 0, 1100, 760), style,
                               NSBackingStore.Buffered, deferCreation: false)
        {
            TitlebarAppearsTransparent = true,
            TitleVisibility = NSWindowTitleVisibility.Hidden,
            MovableByWindowBackground = true,
            MinSize = new CGSize(900, 600),
            // solid engine-room base; the translucent themes flip this via
            // the bridge (setTranslucent), mirroring Electron's behavior
            BackgroundColor = NSColor.FromRgb(0x0b, 0x0f, 0x14),
            Title = "BMacW",
        };
        foreach (var b in new[] { NSWindowButton.CloseButton,
                                  NSWindowButton.MiniaturizeButton,
                                  NSWindowButton.ZoomButton })
        {
            var btn = win.StandardWindowButton(b);
            if (btn != null) btn.Hidden = true;
        }
        win.Center();
        return win;
    }

    private static WKWebView BuildWebView(BmacwBridge bridge)
    {
        var controller = new WKUserContentController();
        controller.AddScriptMessageHandler(bridge, "bmacw");
        // durable settings, injected before any page script runs (core.js
        // reads them synchronously; localStorage alone resets every launch
        // because the app's origin port is ephemeral)
        controller.AddUserScript(new WKUserScript(
            new NSString($"window.__bmacwSettings = {BmacwBridge.LoadSettingsJs()};"),
            WKUserScriptInjectionTime.AtDocumentStart, isForMainFrameOnly: true));
        // stamp the bundle version into the shim (settings page shows it)
        string version = NSBundle.MainBundle
            .ObjectForInfoDictionary("CFBundleShortVersionString")?.ToString() ?? "dev";
        controller.AddUserScript(new WKUserScript(
            new NSString(BmacwBridge.ShimSource.Replace("'native'", $"'{version}'")),
            WKUserScriptInjectionTime.AtDocumentStart, isForMainFrameOnly: true));

        var config = new WKWebViewConfiguration { UserContentController = controller };
        config.Preferences.SetValueForKey(NSNumber.FromBoolean(true),
            new NSString("developerExtrasEnabled")); // right-click → Inspect

        var webView = new WKWebView(CGRect.Empty, config)
        {
            AutoresizingMask = NSViewResizingMask.WidthSizable |
                               NSViewResizingMask.HeightSizable,
        };
        // let the window background show through (Aero/translucent themes)
        webView.SetValueForKey(NSNumber.FromBoolean(false),
                               new NSString("drawsBackground"));
        return webView;
    }

    // minimal main menu so Cmd+Q / Cmd+W / copy-paste work like a mac app
    private static void BuildMenu()
    {
        var mainMenu = new NSMenu();
        var appItem = new NSMenuItem();
        mainMenu.AddItem(appItem);
        var appMenu = new NSMenu();
        appMenu.AddItem(new NSMenuItem("Quit BMacW", "q",
            (_, _) => NSApplication.SharedApplication.Terminate(null)));
        appItem.Submenu = appMenu;

        var editItem = new NSMenuItem();
        mainMenu.AddItem(editItem);
        var edit = new NSMenu("Edit");
        edit.AddItem(new NSMenuItem("Cut", "x") { Action = new ObjCRuntime.Selector("cut:") });
        edit.AddItem(new NSMenuItem("Copy", "c") { Action = new ObjCRuntime.Selector("copy:") });
        edit.AddItem(new NSMenuItem("Paste", "v") { Action = new ObjCRuntime.Selector("paste:") });
        edit.AddItem(new NSMenuItem("Select All", "a") { Action = new ObjCRuntime.Selector("selectAll:") });
        editItem.Submenu = edit;

        NSApplication.SharedApplication.MainMenu = mainMenu;
    }
}
