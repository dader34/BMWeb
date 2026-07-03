using Microsoft.Extensions.FileProviders;

namespace InpaMac.Server;

// Reusable bootstrap for the JSON API, shared by two hosts:
//   - Program.cs: the standalone sidecar Electron spawns (fixed port 8777)
//   - InpaMac.App: the single-binary macOS app, which runs this in-process on
//     an ephemeral port and also serves the renderer as static files.
public static class ServerHost
{
    // Build the app with all route groups mapped and shutdown wired. When
    // rendererDir is given, the renderer is served as the site root so the
    // whole UI + API live on one origin.
    public static (WebApplication App, ServerState State) Build(
        string[] args, string? rendererDir = null)
    {
        var builder = WebApplication.CreateBuilder(args);
        builder.Logging.ClearProviders(); // keep stdout clean for parent

        var state = new ServerState();
        var app = builder.Build();

        if (rendererDir != null)
        {
            var files = new PhysicalFileProvider(rendererDir);
            app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = files });
            app.UseStaticFiles(new StaticFileOptions { FileProvider = files });
        }

        app.MapConfigEndpoints(state);
        app.MapDiagnosticsEndpoints(state);
        app.MapFlashEndpoints(state);

        // graceful shutdown: reset any in-progress flash (a mid-flash quit
        // would leave the DME stuck in programming mode at 115200) and
        // release the FTDI port.
        app.Lifetime.ApplicationStopping.Register(state.Shutdown);
        AppDomain.CurrentDomain.ProcessExit += (_, _) => state.Shutdown();
        return (app, state);
    }
}
