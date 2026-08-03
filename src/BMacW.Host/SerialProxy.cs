using System.IO.Ports;

namespace BMacW.Host;

// The cable, exposed to JavaScript.
//
// The renderer used to reach the bus by asking the C# server to run a job,
// which ran EDIABAS, which owned the port. Now our own BEST2 VM decodes jobs
// in the renderer, so the only thing left that JS cannot do is touch
// /dev/tty.usbserial -- WKWebView has no Web Serial (the web build gets it
// from Chrome; a WKWebView does not).
//
// So the shell keeps exactly one job it is uniquely able to do: move bytes.
// It knows nothing about BMW-FAST framing, job semantics, or ECUs. It opens a
// port, writes what it is handed, reads what comes back. Everything above that
// -- framing, checksums, the echo, retries -- stays in bestvm.js where it is
// already tested against the engine on 3730 results.
//
// Wire settings come from the caller per ECU: BMW-FAST runs 115200 8N1, the
// DS2/KWP2000* K-line runs 9600 8E1, and the renderer reopens the port when
// a job's concept differs. The K line is half duplex, so a write is ECHOED
// back before the answer; dropping that echo is the caller's business (it
// knows how many bytes it sent), which keeps this class free of protocol
// knowledge.
public sealed class SerialProxy : IDisposable
{
    private SerialPort? _port;

    public bool IsOpen => _port is { IsOpen: true };

    public string? PortPath => _port?.PortName;

    // The cables this app sees, per platform.
    //
    // macOS: tty.usbserial-XXXX (FTDI) or cu.usbserial-XXXX. Prefer "cu." --
    // "tty." blocks on open until DCD is asserted, which an OBD cable never
    // does, so opening the tty node can hang the app.
    //
    // Linux: /dev/ttyUSB* (FTDI, CH340) and /dev/ttyACM* (CDC). Note that
    // reaching these usually needs the user in the `dialout` group, or the
    // udev rule shipped in scripts/setup/ -- otherwise the node exists and
    // opening it is denied, which Open() reports as such.
    //
    // Windows: COM ports, which SerialPort itself enumerates. There is no
    // path pattern to match, so ask the framework rather than guessing.
    public static List<string> ListPorts()
    {
        var found = new List<string>();

        if (OperatingSystem.IsWindows())
        {
            // COM1..COMn in the order Windows reports them. A K+DCAN cable is
            // whichever COM the FTDI driver claimed; we cannot tell which from
            // the name alone, so all of them are offered and the user picks.
            foreach (var name in SerialPort.GetPortNames())
                if (!found.Contains(name)) found.Add(name);
            return found;
        }

        var patterns = OperatingSystem.IsMacOS()
            ? new[] { "cu.usbserial*", "cu.usbmodem*", "cu.SLAB*", "cu.wchusbserial*" }
            : new[] { "ttyUSB*", "ttyACM*" };

        if (Directory.Exists("/dev"))
        {
            foreach (var pattern in patterns)
                foreach (var dev in Directory.EnumerateFiles("/dev", pattern))
                    if (!found.Contains(dev)) found.Add(dev);
        }
        return found;
    }

    public string Open(string? path, int baud, string? parity = null)
    {
        Close();
        string dev = string.IsNullOrEmpty(path) ? (ListPorts().FirstOrDefault() ?? "") : path;
        if (string.IsNullOrEmpty(dev))
        {
            // say where we looked, in the terms of the platform we are on
            string where = OperatingSystem.IsWindows() ? "no COM port is present"
                : OperatingSystem.IsMacOS() ? "no /dev/cu.usbserial*"
                : "no /dev/ttyUSB* or /dev/ttyACM*";
            throw new InvalidOperationException($"no K+DCAN cable found ({where})");
        }

        // Parity follows the ECU's concept: the DS2/KWP2000* K-line runs
        // 8E1, BMW-FAST runs 8N1. The renderer reopens the port when a
        // job's xsetpar declares different settings.
        var par = string.Equals(parity, "even", StringComparison.OrdinalIgnoreCase) ? Parity.Even
            : string.Equals(parity, "odd", StringComparison.OrdinalIgnoreCase) ? Parity.Odd
            : Parity.None;
        var p = new SerialPort(dev, baud <= 0 ? 115200 : baud, par, 8, StopBits.One)
        {
            Handshake = Handshake.None,
            // Reads are drained by the caller's own deadline loop, so never
            // block here: a job that gets no answer must surface as "no
            // answer", not as a frozen UI.
            ReadTimeout = 1,
            WriteTimeout = 2000,
            DtrEnable = true,
            RtsEnable = true,
        };
        try
        {
            p.Open();
        }
        catch (UnauthorizedAccessException)
        {
            // The usual Linux first run: the node is there and the user is not
            // in the group that may open it. Saying "access denied" alone
            // sends people looking for a broken cable, so say what to do.
            if (OperatingSystem.IsLinux())
                throw new InvalidOperationException(
                    $"{dev} exists but this user may not open it. Add yourself to "
                    + "the dialout group (sudo usermod -aG dialout $USER, then log "
                    + "out and back in), or install the udev rule in "
                    + "scripts/setup/99-bmacw-kdcan.rules.");
            throw;
        }
        p.DiscardInBuffer();
        p.DiscardOutBuffer();
        _port = p;
        return dev;
    }

    public void Close()
    {
        try { _port?.Close(); } catch { /* already gone */ }
        _port?.Dispose();
        _port = null;
    }

    public void Write(byte[] data)
    {
        if (_port is not { IsOpen: true })
            throw new InvalidOperationException("port is not open");
        _port.Write(data, 0, data.Length);
    }

    // Everything buffered right now, or an empty array. Never blocks: the
    // renderer polls this against its own deadline, which keeps the timeout
    // policy in one place (the VM's transport) instead of split across the
    // bridge.
    public byte[] ReadAvailable()
    {
        if (_port is not { IsOpen: true })
            throw new InvalidOperationException("port is not open");
        int n = _port.BytesToRead;
        if (n <= 0) return Array.Empty<byte>();
        var buf = new byte[n];
        int got = _port.Read(buf, 0, n);
        return got == n ? buf : buf[..got];
    }

    // Drop anything still in the receive buffer. A previous job that timed out
    // can leave a partial frame behind, and the next job would then read that
    // frame's tail as its own answer.
    public void Flush()
    {
        if (_port is { IsOpen: true })
        {
            _port.DiscardInBuffer();
            _port.DiscardOutBuffer();
        }
    }

    public void Dispose() => Close();
}
