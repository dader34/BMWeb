using System.Threading.Channels;
using EdiabasMac;

namespace InpaMac.Server;

// MS45 DME flashing (STAGE 1: read/backup only). FlashService owns its own
// engine and needs exclusive port access, so the cached live engine is closed
// before each session and the session is tracked in ServerState.ActiveFlash so
// a mid-flash shutdown can reset the DME.
internal static class FlashEndpoints
{
    public static void MapFlashEndpoints(this WebApplication app, ServerState state)
    {
        // identify the DME (VIN, HW/SW refs, programming status) before any flash op
        app.MapPost("/api/flash/{sgbd}/identify", (HttpContext ctx, string sgbd, string? port) => state.OnBus(ctx, () =>
        {
            string? p = port ?? Paths.AutoDetectPort();
            if (p == null) return Results.BadRequest(new { error = "no interface for flashing - use the K+DCAN cable" });
            state.Engines.DisposeLive(); // flash needs exclusive port access
            var fs = new FlashService(state.EcuPath, sgbd, p);
            state.ActiveFlash = fs;
            try
            {
                var info = fs.Identify();
                return Results.Json(new {
                    dmeType = info.DmeType, vin = info.Vin, hwRef = info.HwRef, swRef = info.SwRef,
                    programmingStatus = info.ProgrammingStatus, diagProtocol = info.DiagProtocol, supported = info.Supported,
                });
            }
            catch (Exception ex) { return Results.BadRequest(new { error = ServerState.Explain(ex), raw = ex.Message }); }
            finally { state.ActiveFlash = null; fs.Dispose(); }
        }));

        // read/backup a DME region. region = data | full | mpc | fullbin. streams SSE
        // progress, then binary as base64. 'fullbin' reads external flash AND MPC in one
        // session (a second connection would collide with the ECU session) and emits two
        // 'done:<name>' events, one per file.
        app.MapPost("/api/flash/{sgbd}/read/{region}", async (HttpContext ctx, string sgbd, string region, string? port) =>
        {
            string? p = port ?? Paths.AutoDetectPort();
            if (p == null) { ctx.Response.StatusCode = 400; await ctx.Response.WriteAsJsonAsync(new { error = "no interface - use the K+DCAN cable" }); return; }

            // region(s) to read in this single session
            var regions = region switch
            {
                "data"    => new[] { ("data", FlashService.DataRegion) },
                "full"    => new[] { ("full", FlashService.FullFlash) },
                "mpc"     => new[] { ("mpc",  FlashService.MpcData) },
                "fullbin" => new[] { ("full", FlashService.FullFlash), ("mpc", FlashService.MpcData) },
                _ => null,
            };
            if (regions == null) { ctx.Response.StatusCode = 400; await ctx.Response.WriteAsJsonAsync(new { error = "region must be data|full|mpc|fullbin" }); return; }

            ctx.Response.Headers["Content-Type"] = "text/event-stream";
            ctx.Response.Headers["Cache-Control"] = "no-cache";
            async Task Send(string ev, string data) { await ctx.Response.WriteAsync($"event: {ev}\ndata: {data}\n\n"); await ctx.Response.Body.FlushAsync(); }

            // events flow producer(flash loop) -> channel -> this handler, which is
            // the ONLY writer to the response body and awaits each write in order.
            // no fire-and-forget writes anywhere.
            var channel = Channel.CreateUnbounded<(string ev, string data)>(
                new UnboundedChannelOptions { SingleReader = true, SingleWriter = true });

            var results = new List<(string name, byte[] dump)>();

            // hold the bus only for the actual read; the base64 streaming below runs
            // after release so a slow client cant stall the bus for other endpoints
            var busTask = Task.Run(async () =>
            {
                string? err = null;
                await state.BusLock.WaitAsync(ctx.RequestAborted);
                try
                {
                    state.Engines.DisposeLive(); // flash needs exclusive port access
                    var fs = new FlashService(state.EcuPath, sgbd, p);
                    state.ActiveFlash = fs;
                    try
                    {
                        // ROMX/LAR reads need security access (seed/key) + ECU-programming mode, once per session
                        var info = fs.Identify();
                        if (!fs.RequestSecurityAccess(info.DiagProtocol)) { err = "security access denied"; }
                        else
                        {
                            foreach (var (name, rgn) in regions)
                            {
                                int lastPct = -1;
                                channel.Writer.TryWrite(("region", name)); // signal which file is starting
                                var dump = fs.ReadMemory(rgn, pct =>
                                {
                                    if (pct != lastPct) { lastPct = pct; channel.Writer.TryWrite(("progress", pct.ToString())); }
                                });
                                results.Add((name, dump));
                            }
                        }
                    }
                    finally { state.ActiveFlash = null; fs.Dispose(); }
                }
                catch (Exception ex) { err = ServerState.Explain(ex); }
                finally { state.BusLock.Release(); }

                if (err != null) channel.Writer.TryWrite(("error", err));
                else
                    foreach (var (name, dump) in results)
                        channel.Writer.TryWrite(("done", name + "|" + Convert.ToBase64String(dump)));
                channel.Writer.Complete();
            });

            try
            {
                await foreach (var (ev, data) in channel.Reader.ReadAllAsync(ctx.RequestAborted))
                    await Send(ev, data);
            }
            catch (Exception ex) { try { await Send("error", ex.Message); } catch { } }
            await busTask; // surface producer completion / avoid orphaning
        });
    }
}
