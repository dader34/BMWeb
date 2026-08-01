namespace BMacW.Host;

// Where the app's files live, for the shell alone.
//
// This used to come from EdiabasMac.Paths, which the shell no longer
// references: the engine is gone. The logic is the same walk, but it looks for
// a marker the shell actually needs -- app/renderer -- rather than
// vendor/EDIABAS, which was the engine's data and is no longer required to
// start (the renderer reads static JSON from dist-web/).
public static class AppPaths
{
    public static string FindRoot()
    {
        // explicit root wins
        string? env = Environment.GetEnvironmentVariable("BMACW_ROOT");
        if (!string.IsNullOrEmpty(env) && IsRoot(env)) return env;

        // packaged BMacW.app: the executable lives in Contents/MacOS and the
        // release data mirrors the repo layout under Contents/Resources/data
        string bundled = Path.GetFullPath(Path.Combine(
            AppContext.BaseDirectory, "..", "Resources", "data"));
        if (IsRoot(bundled)) return bundled;

        // Windows/Linux release: no bundle to hide inside, so the data sits in
        // a `data` folder beside the executable.
        string beside = Path.Combine(AppContext.BaseDirectory, "data");
        if (IsRoot(beside)) return beside;

        // ...or the executable's own directory IS the root (published with the
        // renderer copied in flat, which is what the zip layout does).
        if (IsRoot(AppContext.BaseDirectory)) return AppContext.BaseDirectory;

        // dev tree: walk up from bin/ to the repo root
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            if (IsRoot(dir.FullName)) return dir.FullName;
            dir = dir.Parent;
        }
        return Directory.GetCurrentDirectory();
    }

    private static bool IsRoot(string path) =>
        Directory.Exists(Path.Combine(path, "app", "renderer"));
}
