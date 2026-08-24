using System;
using System.IO;
using System.Linq;
using EdiabasMac;

namespace InpaMac.Cli;

// serial adapter discovery. The native driver talks K+DCAN over an FTDI VCP
// device (/dev/tty.usbserial* or /dev/cu.usbserial*); Paths.AutoDetectPort is
// the same picker every live command uses.
internal static class AdapterCommands
{
    // list candidate serial devices and mark the one auto-detect would pick.
    //   ports
    public static int Ports(Cli cli)
    {
        string auto = Paths.AutoDetectPort();
        var devs = SerialDevices();
        cli.Line("Serial devices:");
        if (devs.Length == 0) cli.Line("  (none found — is the K+DCAN cable plugged in?)");
        foreach (var d in devs)
            cli.Line($"  {d}" + (d == auto ? "   <- auto" : ""));
        cli.Emit(new { devices = devs, auto });
        return 0;
    }

    // adapter summary: the selected/auto port and whether it exists.
    //   adapter [--port DEV]
    public static int Adapter(Cli cli)
    {
        string port = cli.Port();
        bool present = port != null && (File.Exists(port) || SerialDevices().Contains(port));
        cli.Line($"Port      : {port ?? "(none)"}");
        cli.Line($"Present   : {(present ? "yes" : "no")}");
        cli.Line($"Transport : K+DCAN over FTDI VCP (serial)");
        cli.Line("Note      : the THOR WiFi adapter is a GUI-only transport; the CLI is serial.");
        cli.Emit(new { port, present, transport = "kdcan-serial" });
        return present ? 0 : 4;
    }

    // /dev serial candidates: usbserial (FTDI) plus the generic tty/cu.usb* the
    // OS may expose, deduped and sorted.
    private static string[] SerialDevices()
    {
        try
        {
            return Directory.EnumerateFiles("/dev")
                .Where(f =>
                {
                    string n = Path.GetFileName(f);
                    return (n.StartsWith("tty.usb") || n.StartsWith("cu.usb"));
                })
                .OrderBy(f => f)
                .ToArray();
        }
        catch { return Array.Empty<string>(); }
    }
}
