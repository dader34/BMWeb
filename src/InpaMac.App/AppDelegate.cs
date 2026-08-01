using AppKit;
using BMacW.Host;
using CoreGraphics;
using Foundation;
using WebKit;

namespace InpaMac.App;

// Single-binary host: serves the renderer over an ephemeral loopback port
// (Kestrel is an implementation detail, not a second process), then opens it
// in a WKWebView. There is no API and no EDIABAS engine -- the BEST2 VM in
// the renderer decodes jobs, and the cable is reached through SerialProxy on
// the native bridge. Window chrome matches the Electron
// shell: hidden titlebar, renderer-drawn traffic lights, draggable background.
public sealed class AppDelegate : NSApplicationDelegate
{
    private Microsoft.AspNetCore.Builder.WebApplication? _server;
    private NSWindow? _window;
    private WKWebView? _webView;
    private BmacwBridge? _bridge;

    public override void DidFinishLaunching(NSNotification notification)
    {
        string root = AppPaths.FindRoot();
        string rendererDir = Path.Combine(root, "app", "renderer");

        // A FILE SERVER, NOT AN API. The renderer decodes jobs itself now (the
        // BEST2 VM in bestvm.js) and reads everything else from static JSON, so
        // nothing is left to serve but files. It still has to be http:// rather
        // than file://, because a file:// page gets an opaque origin where
        // fetch() is blocked and the app cannot read its own data.
        // port 0 = let the kernel pick a free one.
        string dataDir = Path.Combine(root, "dist-web");
        _server = StaticHost.Build(rendererDir, dataDir);
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
        // Release the FTDI port before the process dies. This used to be the
        // engine's job (ServerState.Shutdown); the engine is gone, and the
        // only thing still holding hardware is the bridge's SerialProxy.
        // NO graceful Kestrel stop here: blocking the AppKit main thread on
        // StopAsync deadlocks (sync-over-async against the run-loop context)
        // and the process exits right after this anyway.
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
        // durable settings + the bmacw surface, injected before any page
        // script runs (core.js reads settings synchronously; localStorage
        // alone resets every launch because the origin port is ephemeral).
        // The bridge owns the scripts so a settings save can re-inject fresh
        // values for the next reload. Version stamped into the shim (the
        // settings page shows it).
        string version = NSBundle.MainBundle
            .ObjectForInfoDictionary("CFBundleShortVersionString")?.ToString() ?? "dev";
        bridge.AttachUserScripts(controller,
            BmacwBridge.ShimSource.Replace("'native'", $"'{version}'"));

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
