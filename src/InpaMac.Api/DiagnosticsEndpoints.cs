using EdiabasMac;

namespace InpaMac.Server;

// per-ECU endpoints: offline metadata (jobs/results/arguments/activations/menu)
// on the dedicated offline engine, and live bus ops (state/read/clear/run) on
// the cached live engine, serialized through ServerState.OnBus.
internal static class DiagnosticsEndpoints
{
    public static void MapDiagnosticsEndpoints(this WebApplication app, ServerState state)
    {
        // ---- offline (no cable) ----

        app.MapGet("/api/ecu/{sgbd}/jobs", (string sgbd) =>
            Offline(state, sgbd, diag => Results.Json(diag.Jobs())));

        app.MapGet("/api/ecu/{sgbd}/results/{job}", (string sgbd, string job) =>
            Offline(state, sgbd, diag => Results.Json(diag.ResultsOf(job))));

        // a job's declared arguments (offline, via the _ARGUMENTS pseudo-job). lets the
        // UI know which jobs need input (flash address/parameter, etc.) and their types.
        app.MapGet("/api/ecu/{sgbd}/arguments/{job}", (string sgbd, string job) =>
            Offline(state, sgbd, diag =>
            {
                var args = new List<Dictionary<string, string>>();
                foreach (var set in diag.Run("_ARGUMENTS", job))
                    args.Add(set.Where(kv => !kv.Key.StartsWith("_"))
                                .ToDictionary(kv => kv.Key, kv => Diag.Format(kv.Value)));
                return Results.Json(new { job, arguments = args });
            }));

        // actuator tests (INPA F6 'Steuern'): STEUERN_X paired with STEUERN_X_ENDE
        app.MapGet("/api/ecu/{sgbd}/activations", (string sgbd) =>
            Offline(state, sgbd, diag =>
            {
                var acts = MenuGen.Activations(diag.Jobs());
                return Results.Json(acts.Select(a => new
                {
                    label = a.Label, start = a.Start, stop = a.Stop, momentary = a.Momentary
                }).ToList());
            }));

        // English INPA-style grouped functional menu for an ECU (offline)
        app.MapGet("/api/ecu/{sgbd}/menu", (string sgbd) =>
            Offline(state, sgbd, diag =>
            {
                var sections = MenuGen.Build(diag.Jobs());
                return Results.Json(new
                {
                    sgbd,
                    sections = sections.Select(s => new
                    {
                        section = s.Section,
                        items = s.Items.Select(i => new { job = i.Job, label = i.Label, danger = i.Danger }).ToList()
                    }).ToList()
                });
            }));

        // ---- live (bus) ----

        // battery + ignition (KL15) state, INPA's top "Battery / Ignition" lights.
        // plain K+DCAN can't report line voltage to EDIABAS, so read from the DME:
        // STATUS_UBATT (battery volts) + STATUS_DIGITAL_1 (KL15 input).
        // real bus transaction: renderer polls on demand, not a fast timer. never
        // throws; connected:false carries a `detail` saying whether the cable/port
        // is missing or the ECU didn't answer.
        app.MapGet("/api/state", (HttpContext ctx, string? port, string? sgbd) =>
        {
            string ecu = string.IsNullOrEmpty(sgbd) ? "ms450ds0" : sgbd;
            return state.OnBus(ctx, () =>
            {
                var diag = state.Engines.AcquireLive(port);
                if (diag == null)
                    return Results.Json(new
                    {
                        battery = (double?)null, ignition = (bool?)null, connected = false,
                        detail = "no K+DCAN cable detected (no usbserial port)"
                    });
                try
                {
                    diag.Load(ecu);

                    double? bat = null; bool? ign = null;
                    Exception? firstErr = null;
                    // battery voltage
                    try
                    {
                        foreach (var s in diag.Run("STATUS_UBATT"))
                            foreach (var kv in s)
                                if (kv.Key.Contains("UBAT") && kv.Key.EndsWith("WERT") &&
                                    double.TryParse(Diag.Format(kv.Value), System.Globalization.NumberStyles.Any,
                                        System.Globalization.CultureInfo.InvariantCulture, out var v)) bat = v;
                    }
                    catch (Exception ex) { firstErr = ex; }
                    // ignition = terminal 15 input (STAT_KL15_EIN_WERT in STATUS_DIGITAL_1)
                    try
                    {
                        foreach (var s in diag.Run("STATUS_DIGITAL_1"))
                            foreach (var kv in s)
                                if (kv.Key.Contains("KL15"))
                                {
                                    var t = Diag.Format(kv.Value).Trim().ToLowerInvariant();
                                    ign = t is "1" or "ein" or "on" or "true" || t.StartsWith("ein");
                                }
                    }
                    catch (Exception ex) { firstErr ??= ex; }
                    // if KL15 couldn't be read, leave ignition unknown. don't infer from
                    // voltage: the DME reports >6V with the key off too, so it would lie.

                    // both reads failed -> the port is there but the ECU never answered
                    if (bat == null && ign == null && firstErr != null)
                    {
                        if (DiagManager.IsInterfaceError(firstErr)) state.Engines.DisposeLive();
                        return Results.Json(new
                        {
                            battery = (double?)null, ignition = (bool?)null, connected = false,
                            detail = "ECU didn't answer: " + ServerState.Explain(firstErr)
                        });
                    }

                    return Results.Json(new { battery = bat, ignition = ign, connected = true });
                }
                catch (Exception ex)
                {
                    if (DiagManager.IsInterfaceError(ex)) state.Engines.DisposeLive();
                    return Results.Json(new
                    {
                        battery = (double?)null, ignition = (bool?)null, connected = false,
                        detail = ServerState.Explain(ex)
                    });
                }
            });
        });

        app.MapPost("/api/ecu/{sgbd}/read", (HttpContext ctx, string sgbd, string? port) => state.OnBus(ctx, () =>
        {
            var diag = state.Engines.AcquireLive(port);
            if (diag == null) return Results.BadRequest(new { error = "no interface: plug in the K+DCAN cable" });
            // multi-variant merge (in the library so the CLI labels faults the same):
            // faults the primary SGBD leaves as "unknown location" get filled in from
            // sibling variants (e.g. zke5 -> zke5_s12) when available.
            var codes = FaultReader.ReadFaultsMerged(diag, sgbd, state.Config.SgbdVariants(sgbd));
            return Results.Json(new { port, count = codes.Count, codes });
        }));

        app.MapPost("/api/ecu/{sgbd}/clear", (HttpContext ctx, string sgbd, string? port) => state.OnBus(ctx, () =>
        {
            var diag = state.Engines.AcquireLive(port);
            if (diag == null) return Results.BadRequest(new { error = "no interface: plug in the K+DCAN cable" });
            diag.Load(sgbd);
            diag.Run("FS_LOESCHEN");
            return Results.Json(new { ok = true });
        }));

        // run any job live, return every result set as key/value strings
        app.MapPost("/api/ecu/{sgbd}/run/{job}", (HttpContext ctx, string sgbd, string job, string? port, string? arg) => state.OnBus(ctx, () =>
        {
            var diag = state.Engines.AcquireLive(port);
            if (diag == null) return Results.BadRequest(new { error = "no interface: plug in the K+DCAN cable" });
            diag.Load(sgbd);
            var sets = diag.Run(job, string.IsNullOrEmpty(arg) ? null : arg);
            var rows = sets.Select(s => s.ToDictionary(kv => kv.Key, kv => Diag.Format(kv.Value))).ToList();
            return Results.Json(new { port, job, sets = rows });
        }));
    }

    // run offline work with friendly errors: missing/unloadable SGBD -> 404,
    // anything else -> 500, both via Explain.
    private static IResult Offline(ServerState state, string sgbd, Func<Diag, IResult> work)
    {
        try
        {
            return state.Engines.RunOffline(sgbd, work);
        }
        catch (SgbdLoadException ex)
        {
            return Results.NotFound(new { error = ServerState.Explain(ex), raw = ex.Message });
        }
        catch (Exception ex)
        {
            return Results.Json(new { error = ServerState.Explain(ex), raw = ex.Message },
                statusCode: StatusCodes.Status500InternalServerError);
        }
    }
}
