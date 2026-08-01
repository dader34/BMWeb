using System.Text.Json;

namespace BMacW.Host;

// The durable settings file, shared by every host.
//
// localStorage is origin-scoped and the app serves itself on an EPHEMERAL
// loopback port, so the renderer's own settings would silently reset on every
// launch -- a different port is a different origin. The shell therefore owns
// the durable copy: written whenever the renderer saves, and injected back
// into the page at document start as window.__bmacwSettings.
//
// This lives in the shared library rather than in either window shell because
// both of them need exactly the same answer, and a Windows build that put
// settings somewhere else would silently not carry a user's THOR or theme
// choice across a reinstall.
public static class HostSettings
{
    // ApplicationData resolves per platform without any conditionals:
    //   macOS   ~/.config/BMacW          (SpecialFolder.ApplicationData)
    //   Linux   ~/.config/BMacW          (XDG_CONFIG_HOME)
    //   Windows %APPDATA%\BMacW
    //
    // The folder stays "BMacW" on every platform even though the Windows and
    // Linux builds are branded BMWeb: it is the app's identity on disk, not a
    // label anyone reads, and one name means a settings file written by any
    // build is found by any other.
    public static string Path => System.IO.Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "BMacW", "settings.json");

    // The settings as a JS expression, ready to inline into an injected
    // script. "null" when absent or corrupt, which the renderer treats as
    // "no saved settings" rather than failing to start.
    public static string LoadJs()
    {
        try
        {
            string json = File.ReadAllText(Path);
            using var _ = JsonDocument.Parse(json);   // must be valid JSON
            return json;
        }
        catch { return "null"; }
    }

    // Reject junk before writing: a corrupt settings file is worse than none,
    // because it survives restarts and is invisible from inside the app.
    public static bool Save(string? json)
    {
        if (string.IsNullOrEmpty(json)) return false;
        using var _ = JsonDocument.Parse(json);
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(Path)!);
        File.WriteAllText(Path, json);
        return true;
    }
}
