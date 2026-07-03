using EdiabasMac;

namespace InpaMac.Server;

// all shared server state in one place: repo paths, the parsed INPA config,
// the long-lived engine cache, the single bus lock, and the active flash
// session. created once in Program.cs and handed to each route group.
public sealed class ServerState : IDisposable
{
    // K+DCAN is a single serial line: one transaction on the bus at a time.
    // without serializing, a state poll and a code read collide and both fail
    // (IFH_0009/0041). this semaphore queues every live bus op.
    public SemaphoreSlim BusLock { get; } = new(1, 1);

    public string Root { get; }
    public string EcuPath { get; }
    public string InpaRoot { get; }
    public string LayoutDir { get; }
    public InpaConfig Config { get; }
    public DiagManager Engines { get; }

    // serialized .prg-synthesized layouts, keyed by SGBD. the schema inside a
    // .prg never changes at runtime, so entries live for the process lifetime.
    public System.Collections.Concurrent.ConcurrentDictionary<string, string>
        PrgLayoutCache { get; } = new(StringComparer.OrdinalIgnoreCase);

    // FlashService of an in-progress flash session, so the shutdown handler can
    // run ResetSession (a mid-flash quit would otherwise leave the DME stuck in
    // programming mode at 115200).
    public volatile FlashService? ActiveFlash;

    private int _shutdown;

    public ServerState()
    {
        Root = Paths.FindRepoRoot();
        EcuPath = Paths.EcuPath(Root);
        InpaRoot = Paths.InpaRoot(Root);
        LayoutDir = Path.Combine(Root, "data", "inpa-layouts", "enriched");
        Config = new InpaConfig(InpaRoot, EcuPath);
        Engines = new DiagManager(EcuPath);
    }

    private static readonly TimeSpan BusAcquireTimeout = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan BusWorkTimeout = TimeSpan.FromSeconds(90);

    // serialize a live bus op:
    //   - bounded lock acquisition (client disconnect or 15s -> 503 "bus busy")
    //   - bounded execution (90s): a wedged bus op releases the lock and the
    //     cached engine is disposed (unknown state), so the next call starts clean
    //   - central error handling: IFH-* (interface-level) failures also dispose
    //     the cached engine; every error is explained for the UI
    public async Task<IResult> OnBus(HttpContext ctx, Func<IResult> work)
    {
        using var acquireCts = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);
        acquireCts.CancelAfter(BusAcquireTimeout);
        try
        {
            await BusLock.WaitAsync(acquireCts.Token);
        }
        catch (OperationCanceledException)
        {
            return Results.Json(
                new { error = "bus busy: another diagnostic operation is in progress, try again shortly" },
                statusCode: StatusCodes.Status503ServiceUnavailable);
        }
        try
        {
            var workTask = Task.Run(work);
            using var delayCts = new CancellationTokenSource();
            var finished = await Task.WhenAny(workTask, Task.Delay(BusWorkTimeout, delayCts.Token));
            if (finished != workTask)
            {
                Engines.DisposeLive(); // engine state unknown; wedged op will fault out
                // observe the abandoned task's eventual fault (port closed under it)
                _ = workTask.ContinueWith(t => _ = t.Exception,
                    TaskContinuationOptions.OnlyOnFaulted);
                return Results.Json(
                    new { error = "bus operation timed out; the interface was reset - retry" },
                    statusCode: StatusCodes.Status503ServiceUnavailable);
            }
            delayCts.Cancel();
            return await workTask;
        }
        catch (Exception ex)
        {
            if (DiagManager.IsInterfaceError(ex)) Engines.DisposeLive();
            return Results.BadRequest(new { error = Explain(ex), raw = ex.Message });
        }
        finally
        {
            Engines.ReleaseLive();
            BusLock.Release();
        }
    }

    // idempotent: dispose the active flash session (its Dispose runs
    // ResetSession, returning the DME to normal diagnostics) then the engines
    // (closes the serial port).
    public void Shutdown()
    {
        if (Interlocked.Exchange(ref _shutdown, 1) != 0) return;
        var flash = ActiveFlash;
        ActiveFlash = null;
        try { flash?.Dispose(); } catch { }
        try { Engines.Dispose(); } catch { }
    }

    public void Dispose() => Shutdown();

    // map common EDIABAS failures to plain-English for the UI
    public static string Explain(Exception ex)
    {
        string m = ex.Message ?? "";
        if (m.Contains("IFH-0009") || m.Contains("0009") || m.Contains("no response", StringComparison.OrdinalIgnoreCase)
            || m.Contains("EDIABAS_IFH_0009") || m.Contains("timeout", StringComparison.OrdinalIgnoreCase))
            return "No response from the ECU. Turn the ignition ON (key position 2 / engine running for the DME), and make sure the K+DCAN cable is firmly in the car's OBD-II port.";
        if (m.Contains("IFH-0018") || m.Contains("EDIABAS_IFH_0018") || m.Contains("initialization", StringComparison.OrdinalIgnoreCase) || m.Contains("INIT"))
            return "Couldn't initialize the K-line to this ECU. Check the cable connection and that the ignition is on; some modules need the engine running.";
        if (m.Contains("IFH-0003") || m.Contains("EDIABAS_IFH_0003")
            || (m.Contains("interface", StringComparison.OrdinalIgnoreCase) && m.Contains("not", StringComparison.OrdinalIgnoreCase)))
            return "Can't open the cable's serial port. Unplug and replug the K+DCAN cable (try a different USB port, not a hub).";
        if (m.Contains("SYS-0010") || m.Contains("0010"))
            return "The ECU is in the wrong session/mode. Cycle the ignition off and on, then try again.";
        if (m.Contains(".prg", StringComparison.OrdinalIgnoreCase) || m.Contains("not found", StringComparison.OrdinalIgnoreCase) || m.Contains("load", StringComparison.OrdinalIgnoreCase))
            return "Couldn't load this ECU's description file (SGBD). The ECU may be named differently for this car.";
        return "Diagnostic request failed: " + m;
    }
}
