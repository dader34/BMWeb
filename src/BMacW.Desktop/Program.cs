using System.Reflection;
using BMacW.Host;
using Photino.NET;

namespace BMacW.Desktop;

// BMacW on Windows and Linux: the same renderer, the same host core, in a
// Photino window (WebView2 on Windows, WebKitGTK on Linux).
//
// The shape matches the macOS AppDelegate deliberately -- serve the renderer
// on an ephemeral loopback port, then point a webview at it. It has to be
// http:// rather than file:// on every platform for the same reason: a file://
// page gets an opaque origin where fetch() is blocked, and the app would not
// be able to read its own data.
public static class Program
{
    [STAThread]
    public static void Main(string[] args)
    {
        string root = AppPaths.FindRoot();
        string rendererDir = Path.Combine(root, "app", "renderer");
        string dataDir = Path.Combine(root, "dist-web");

        if (!Directory.Exists(rendererDir))
        {
            // Nothing can work without the renderer, and a blank window is a
            // worse way to say so than a line of text.
            Console.Error.WriteLine(
                $"BMWeb: no renderer found (looked for {rendererDir}).\n"
                + "Run from the repo, or set BMACW_ROOT to a folder holding "
                + "app/renderer.");
            Environment.Exit(1);
        }

        string version = Assembly.GetExecutingAssembly()
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()
            ?.InformationalVersion.Split('+')[0] ?? "dev";

        PhotinoWindow? window = null;
        // The settings have to be in the page before its first script runs, and
        // the bridge shim with them. Built per request so a save reaches the
        // next reload.
        var server = StaticHost.Build(rendererDir, dataDir,
            () => $"window.__bmacwSettings = {HostSettings.LoadJs()};\n"
                  + DesktopBridge.ShimSource(version));
        server.Urls.Add("http://127.0.0.1:0");
        server.StartAsync().GetAwaiter().GetResult();
        string origin = server.Urls.First();

        window = new PhotinoWindow()
            // BMacW is the macOS build; this one is BMWeb, matching the
            // renderer's own branding (see DesktopBridge.ShimSource)
            .SetTitle("BMWeb")
            .SetUseOsDefaultSize(false)
            .SetSize(1100, 760)
            .SetUseOsDefaultLocation(false)
            .Center()
            // right-click -> Inspect, same as the macOS build
            .SetDevToolsEnabled(true)
            .SetContextMenuEnabled(true);

        // The icon, where the platform wants a file on disk. Windows reads
        // .ico; GTK is happy with a .png. Missing icons are not worth failing
        // over -- the app runs fine with the toolkit default.
        string icon = Path.Combine(root, "app",
            OperatingSystem.IsWindows() ? "icon.ico" : "icon.png");
        if (File.Exists(icon)) window.SetIconFile(icon);

        var bridge = new DesktopBridge(window);
        window.RegisterWebMessageReceivedHandler((_, msg) => bridge.OnMessage(msg));
        window.RegisterWindowClosingHandler((_, _) =>
        {
            // release the cable before the process goes: the same reason the
            // macOS host disposes its bridge in WillTerminate
            bridge.Dispose();
            return false;                       // false = allow the close
        });

        window.Load(new Uri($"{origin}/index.html?api={Uri.EscapeDataString(origin)}"));
        window.WaitForClose();
    }
}
