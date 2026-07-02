using System;
using System.Threading;
using EdiabasLib;

namespace EdiabasMac;

// thrown when an SGBD can't be resolved/loaded (missing or unreadable .prg)
public sealed class SgbdLoadException : Exception
{
    public SgbdLoadException(string sgbd, Exception inner)
        : base($"could not load SGBD '{sgbd}': {inner.Message}", inner)
    {
        Sgbd = sgbd;
    }

    public string Sgbd { get; }
}

// long-lived EdiabasNet engine cache. EdiabasNet caches parsed SGBDs per
// instance and no-ops an unchanged SgbdFileName, so keeping one instance alive
// across requests avoids re-parsing the SGBD job table AND re-opening the
// FTDI serial port on every request (Dispose closes the port).
//
// concurrency model (EdiabasNet.ExecuteJob is NOT thread-safe):
//   - the LIVE (serial-attached) engine is only ever used under the server's
//     single busLock, which already serializes every bus transaction. the
//     internal _gate only protects create/dispose bookkeeping against the
//     idle-close timer.
//   - OFFLINE (no-cable) endpoints get their own dedicated engine guarded by
//     its own lock here, so cheap metadata reads (_JOBS/_RESULTS/...) never
//     queue behind a slow bus transaction and never race the live engine.
public sealed class DiagManager : IDisposable
{
    private readonly string _ecuPath;

    // live engine, attached to the K+DCAN serial port
    private readonly object _gate = new object();
    private Diag _live;
    private string _livePort;
    private bool _liveInUse;
    private DateTime _lastLiveUse = DateTime.UtcNow;
    private readonly Timer _idleTimer;
    // no bus activity for this long -> close the live engine so an unplugged
    // cable doesn't hold a stale FTDI fd. recreated lazily on next use.
    private static readonly TimeSpan IdleTimeout = TimeSpan.FromSeconds(60);

    // dedicated offline engine (never attached to a port)
    private readonly object _offlineGate = new object();
    private Diag _offline;

    public DiagManager(string ecuPath)
    {
        _ecuPath = ecuPath;
        _idleTimer = new Timer(_ => CloseIfIdle(), null,
            TimeSpan.FromSeconds(15), TimeSpan.FromSeconds(15));
    }

    // engine attached to the requested (or auto-detected) port; null when no
    // cable is present. caller must hold the bus lock for the whole operation
    // and call ReleaseLive() when done.
    public Diag AcquireLive(string portOverride)
    {
        string port = portOverride ?? Paths.AutoDetectPort();
        if (port == null) return null;
        lock (_gate)
        {
            if (_live != null && !string.Equals(_livePort, port, StringComparison.Ordinal))
                DisposeLiveLocked(); // cable moved to a different device node
            if (_live == null)
            {
                var d = new Diag(_ecuPath);
                d.AttachSerial(port);
                _live = d;
                _livePort = port;
            }
            _liveInUse = true;
            _lastLiveUse = DateTime.UtcNow;
            return _live;
        }
    }

    // mark the current bus op finished; restarts the idle-close clock.
    // safe to call even when AcquireLive was never reached.
    public void ReleaseLive()
    {
        lock (_gate)
        {
            _liveInUse = false;
            _lastLiveUse = DateTime.UtcNow;
        }
    }

    // drop the cached live engine (closes the serial port). used after an
    // interface-level (IFH-*) failure or a timed-out op (engine state unknown)
    // and before flash sessions, which need exclusive port access.
    public void DisposeLive()
    {
        lock (_gate) DisposeLiveLocked();
    }

    private void DisposeLiveLocked()
    {
        var d = _live;
        _live = null;
        _livePort = null;
        _liveInUse = false;
        if (d != null)
        {
            try { d.Dispose(); } catch { /* best effort */ }
        }
    }

    private void CloseIfIdle()
    {
        lock (_gate)
        {
            if (_live != null && !_liveInUse && DateTime.UtcNow - _lastLiveUse > IdleTimeout)
                DisposeLiveLocked();
        }
    }

    // run offline (no bus) work against the dedicated offline engine.
    // load failures surface as SgbdLoadException so callers can 404 cleanly.
    public T RunOffline<T>(string sgbd, Func<Diag, T> work)
    {
        lock (_offlineGate)
        {
            if (_offline == null) _offline = new Diag(_ecuPath);
            try
            {
                try { _offline.Load(sgbd); }
                catch (Exception ex) { throw new SgbdLoadException(sgbd, ex); }
                return work(_offline);
            }
            catch
            {
                // engine state unknown after a failure; cheap to rebuild (no port)
                DisposeOfflineLocked();
                throw;
            }
        }
    }

    private void DisposeOfflineLocked()
    {
        var d = _offline;
        _offline = null;
        if (d != null)
        {
            try { d.Dispose(); } catch { /* best effort */ }
        }
    }

    // IFH-* = interface/cable-level failure: the serial link is in an unknown
    // state, so the cached live engine must be rebuilt before the next op.
    public static bool IsInterfaceError(Exception ex)
    {
        for (Exception e = ex; e != null; e = e.InnerException)
        {
            if (e is EdiabasNet.EdiabasNetException ene &&
                ene.ErrorCode.ToString().Contains("_IFH_"))
                return true;
        }
        return false;
    }

    public void Dispose()
    {
        try { _idleTimer.Dispose(); } catch { }
        DisposeLive();
        lock (_offlineGate) DisposeOfflineLocked();
    }
}
