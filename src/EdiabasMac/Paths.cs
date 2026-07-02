using System;
using System.IO;

namespace EdiabasMac;

// path / port discovery shared by the server and CLI front-ends
public static class Paths
{
    // first K+DCAN FTDI VCP device; some FTDI drivers expose cu.* instead of tty.*
    public static string AutoDetectPort()
    {
        foreach (var dev in Directory.EnumerateFiles("/dev", "tty.usbserial*")) return dev;
        foreach (var dev in Directory.EnumerateFiles("/dev", "cu.usbserial*")) return dev;
        return null;
    }

    public static string FindRepoRoot()
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

    public static string EcuPath(string root) => Path.Combine(root, "vendor", "EDIABAS", "Ecu");

    public static string InpaRoot(string root) => Path.Combine(root, "vendor", "EC-APPS", "INPA");
}
