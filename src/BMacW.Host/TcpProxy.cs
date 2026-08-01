using System.Net.Sockets;

namespace BMacW.Host;

// The THOR WiFi adapter, exposed to JavaScript.
//
// Same one-job philosophy as SerialProxy: the renderer's ThorWifiBus speaks
// the adapter's telegram protocol; the shell only moves bytes, here over TCP
// instead of a serial port (the adapter is an ESP-Link WiFi bridge, default
// 192.168.4.1:23). A WKWebView cannot open a socket any more than it can
// open /dev/tty -- the web build needs a local WebSocket relay for exactly
// this reason -- so the shell does natively what the relay does externally.
public sealed class TcpProxy : IDisposable
{
    private TcpClient? _client;
    private NetworkStream? _stream;

    public bool IsOpen => _client is { Connected: true };

    public string Open(string? host, int port)
    {
        Close();
        string h = string.IsNullOrEmpty(host) ? "192.168.4.1" : host;
        int p = port <= 0 ? 23 : port;
        var c = new TcpClient { NoDelay = true }; // telegrams are tiny; never batch
        if (!c.ConnectAsync(h, p).Wait(4000))
        {
            c.Dispose();
            throw new InvalidOperationException(
                $"no answer from {h}:{p} -- is this Mac on the adapter's WiFi network?");
        }
        _client = c;
        _stream = c.GetStream();
        return $"{h}:{p}";
    }

    public void Close()
    {
        try { _stream?.Dispose(); } catch { /* already gone */ }
        try { _client?.Close(); } catch { /* already gone */ }
        _client = null;
        _stream = null;
    }

    public void Write(byte[] data)
    {
        if (_stream is null)
            throw new InvalidOperationException("tcp is not open");
        _stream.Write(data, 0, data.Length);
    }

    // Everything buffered right now, or an empty array. Never blocks, for the
    // same reason SerialProxy never blocks: the renderer polls against its
    // own deadline, keeping timeout policy in one place.
    public byte[] ReadAvailable()
    {
        if (_client is null || _stream is null)
            throw new InvalidOperationException("tcp is not open");
        int n = _client.Available;
        if (n <= 0) return Array.Empty<byte>();
        var buf = new byte[n];
        int got = _stream.Read(buf, 0, n);
        return got == n ? buf : buf[..got];
    }

    public void Dispose() => Close();
}
